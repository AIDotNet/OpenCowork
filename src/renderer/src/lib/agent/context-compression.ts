import { nanoid } from 'nanoid'
import type { UnifiedMessage, ProviderConfig, ContentBlock, AIModelConfig } from '../api/types'
import { runSidecarTextRequest } from '@renderer/lib/ipc/agent-bridge'
import { RESPONSES_SESSION_SCOPE_CONTEXT_COMPRESSION } from '@renderer/lib/api/responses-session-policy'
import i18n from '@renderer/locales'

// --- Types ---

export interface CompressionConfig {
  enabled: boolean
  /** Model's max context token count */
  contextLength: number
  /** Full compression trigger threshold (default 0.8) */
  threshold: number
  /** Pre-compression (lightweight clearing) threshold (default 0.65) */
  preCompressThreshold?: number
}

export interface CompressionResult {
  compressed: boolean
  originalCount: number
  newCount: number
}

// --- Constants ---

export const DEFAULT_CONTEXT_COMPRESSION_LIMIT = 200_000
export const DEFAULT_CONTEXT_COMPRESSION_THRESHOLD = 0.8
export const MIN_CONTEXT_COMPRESSION_THRESHOLD = 0.3
export const MAX_CONTEXT_COMPRESSION_THRESHOLD = 0.9

/** Number of recent messages to preserve after full compression */
const PRESERVE_RECENT_COUNT = 4
/** Pre-compression: keep tool results from last N messages */
const TOOL_RESULT_KEEP_RECENT = 6
/** Max retry attempts for compression failures */
const MAX_COMPRESS_RETRIES = 2
/** Max consecutive auto-compact failures before circuit-breaking */
const MAX_CONSECUTIVE_FAILURES = 3

/** Placeholder for cleared tool results */
const CLEARED_TOOL_RESULT_PLACEHOLDER = i18n.t('contextCompression.clearedToolResult', {
  ns: 'agent'
})
/** Placeholder for cleared thinking blocks */
const CLEARED_THINKING_PLACEHOLDER = i18n.t('contextCompression.clearedThinking', { ns: 'agent' })
const COMPRESSION_SYSTEM_PROMPT = i18n.t('contextCompression.systemPrompt', { ns: 'agent' })

/** Circuit breaker: track consecutive failures (module-level, resets on success) */
let consecutiveFailures = 0

export function resetCompressionFailures(): void {
  consecutiveFailures = 0
}

// --- Public API ---

export function clampCompressionThreshold(value?: number | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_CONTEXT_COMPRESSION_THRESHOLD
  }
  return Math.min(
    MAX_CONTEXT_COMPRESSION_THRESHOLD,
    Math.max(MIN_CONTEXT_COMPRESSION_THRESHOLD, value)
  )
}

export function resolveCompressionThreshold(
  modelConfig?: Pick<AIModelConfig, 'contextCompressionThreshold'> | null
): number {
  return clampCompressionThreshold(modelConfig?.contextCompressionThreshold)
}

export function resolveCompressionContextLength(
  modelConfig?: Pick<AIModelConfig, 'contextLength' | 'enableExtendedContextCompression'> | null
): number {
  const configuredContextLength =
    typeof modelConfig?.contextLength === 'number' && modelConfig.contextLength > 0
      ? modelConfig.contextLength
      : DEFAULT_CONTEXT_COMPRESSION_LIMIT

  if (configuredContextLength <= DEFAULT_CONTEXT_COMPRESSION_LIMIT) {
    return configuredContextLength
  }

  return modelConfig?.enableExtendedContextCompression
    ? configuredContextLength
    : DEFAULT_CONTEXT_COMPRESSION_LIMIT
}

/**
 * Check whether full compression should be triggered.
 * Includes circuit breaker: after MAX_CONSECUTIVE_FAILURES, stops triggering.
 */
export function shouldCompress(inputTokens: number, config: CompressionConfig): boolean {
  if (!config.enabled || config.contextLength <= 0) return false
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return false
  return inputTokens / config.contextLength >= config.threshold
}

/**
 * Check whether lightweight pre-compression (tool result + thinking clearing) should be triggered.
 * This fires at a lower threshold than full compression.
 */
export function shouldPreCompress(inputTokens: number, config: CompressionConfig): boolean {
  if (!config.enabled || config.contextLength <= 0) return false
  const preThreshold = config.preCompressThreshold ?? 0.65
  const ratio = inputTokens / config.contextLength
  return ratio >= preThreshold && ratio < config.threshold
}

/**
 * Lightweight pre-compression: clear stale tool results, old thinking blocks, and
 * replace image/document blocks with markers in older messages.
 * No API call needed — just truncates content in-place.
 * Returns a new message array with stale content cleared.
 */
export function preCompressMessages(messages: UnifiedMessage[]): UnifiedMessage[] {
  if (messages.length <= TOOL_RESULT_KEEP_RECENT) return messages

  const cutoff = messages.length - TOOL_RESULT_KEEP_RECENT
  return messages.map((msg, idx) => {
    if (idx >= cutoff) return msg // recent messages: keep as-is
    if (typeof msg.content === 'string') return msg

    const blocks = msg.content as ContentBlock[]
    let changed = false
    const newBlocks = blocks.map((block) => {
      // Clear old tool results
      if (block.type === 'tool_result') {
        const content =
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
        if (content.length > 200) {
          changed = true
          return { ...block, content: CLEARED_TOOL_RESULT_PLACEHOLDER }
        }
      }
      // Clear old thinking blocks
      if (block.type === 'thinking') {
        changed = true
        return { ...block, thinking: CLEARED_THINKING_PLACEHOLDER }
      }
      // Replace image blocks with marker to save tokens
      if (block.type === 'image') {
        changed = true
        return { type: 'text', text: '[image]' } as ContentBlock
      }
      return block
    })

    return changed ? { ...msg, content: newBlocks } : msg
  })
}

/**
 * Compress messages while preserving recent conversation context.
 *
 * Unlike the previous approach that collapsed everything into 1 message,
 * this keeps the last PRESERVE_RECENT_COUNT messages intact and only
 * summarizes the older portion. The boundary is adjusted to avoid splitting
 * tool_use/tool_result pairs.
 *
 * Result: [boundaryMarker, summaryMessage, ...preservedRecentMessages]
 */
export async function compressMessages(
  messages: UnifiedMessage[],
  providerConfig: ProviderConfig,
  signal?: AbortSignal,
  _preserveCount?: number,
  focusPrompt?: string,
  pinnedContext?: string
): Promise<{ messages: UnifiedMessage[]; result: CompressionResult }> {
  const originalCount = messages.length

  if (originalCount < PRESERVE_RECENT_COUNT + 2) {
    return {
      messages,
      result: { compressed: false, originalCount, newCount: originalCount }
    }
  }

  // Find safe boundary that doesn't split tool_use/tool_result pairs
  const preserveCount = _preserveCount ?? PRESERVE_RECENT_COUNT
  const boundaryIdx = findSafeCompactBoundary(messages, messages.length - preserveCount)

  const messagesToCompress = messages.slice(0, boundaryIdx)
  const messagesToPreserve = messages.slice(boundaryIdx)

  if (messagesToCompress.length < 2) {
    return {
      messages,
      result: { compressed: false, originalCount, newCount: originalCount }
    }
  }

  // Retry logic with exponential backoff
  let lastError: Error | null = null
  for (let attempt = 0; attempt <= MAX_COMPRESS_RETRIES; attempt++) {
    try {
      const inputMessages = attempt === 0
        ? messagesToCompress
        : truncateOldestMessages(messagesToCompress, attempt)

      const originalTaskMsg = findOriginalTaskMessage(inputMessages)
      const serialized = serializeCompressionInput(inputMessages, originalTaskMsg?.content, pinnedContext)
      const rawSummary = await callSummarizer(serialized, providerConfig, signal, focusPrompt)
      const summary = formatCompactSummary(rawSummary)

      // Create summary message (boundary info encoded in the summary itself)
      const summaryMsg: UnifiedMessage = {
        id: nanoid(),
        role: 'user',
        content: i18n.t('contextCompression.summaryMessage', {
          ns: 'agent',
          count: messagesToCompress.length,
          summary
        }),
        createdAt: Date.now()
      }

      // Reset circuit breaker on success
      consecutiveFailures = 0

      const newMessages = [summaryMsg, ...messagesToPreserve]
      return {
        messages: newMessages,
        result: {
          compressed: true,
          originalCount,
          newCount: newMessages.length
        }
      }
    } catch (err) {
      lastError = err as Error
      console.error(`[Context Compression] Attempt ${attempt + 1} failed:`, err)
      if (attempt < MAX_COMPRESS_RETRIES) {
        // Exponential backoff: 1.5s, 3s
        await new Promise((r) => setTimeout(r, BASE_RETRY_DELAY_MS * Math.pow(2, attempt)))
      }
    }
  }

  // All retries exhausted — increment circuit breaker
  consecutiveFailures++
  console.error(
    `[Context Compression] All retries failed (consecutive: ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`,
    lastError
  )

  return {
    messages,
    result: { compressed: false, originalCount, newCount: originalCount }
  }
}

const BASE_RETRY_DELAY_MS = 1_500

// --- Internal helpers ---

/**
 * Find a safe boundary index that doesn't split tool_use/tool_result pairs.
 * Walks backward from initialBoundary until we find a point where no
 * tool_result in the preserved portion references a tool_use in the compressed portion.
 */
function findSafeCompactBoundary(messages: UnifiedMessage[], initialBoundary: number): number {
  let boundary = Math.max(1, Math.min(initialBoundary, messages.length - 1))

  // Collect tool_use IDs in the compressed portion (before boundary)
  // and tool_result references in the preserved portion (at/after boundary)
  for (let attempts = 0; attempts < 10; attempts++) {
    const compressedToolUseIds = new Set<string>()
    for (let i = 0; i < boundary; i++) {
      const msg = messages[i]
      if (typeof msg.content === 'string') continue
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === 'tool_use' && block.id) {
          compressedToolUseIds.add(block.id)
        }
      }
    }

    // Check if any preserved message references a compressed tool_use
    let hasSplit = false
    for (let i = boundary; i < messages.length; i++) {
      const msg = messages[i]
      if (typeof msg.content === 'string') continue
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === 'tool_result' && block.toolUseId && compressedToolUseIds.has(block.toolUseId)) {
          hasSplit = true
          break
        }
      }
      if (hasSplit) break
    }

    if (!hasSplit) return boundary

    // Move boundary back to include the orphaned tool_use
    boundary = Math.max(1, boundary - 1)
  }

  return boundary
}

/**
 * Truncate oldest non-system messages for retry attempts.
 * Each attempt drops ~25% of messages from the front.
 */
function truncateOldestMessages(messages: UnifiedMessage[], attempt: number): UnifiedMessage[] {
  const dropCount = Math.ceil(messages.length * 0.25 * attempt)
  const result: UnifiedMessage[] = []
  let dropped = 0
  for (const msg of messages) {
    if (msg.role === 'system' || msg.role === 'user' && msg === messages[0]) {
      result.push(msg) // Always keep system/first message
      continue
    }
    if (dropped < dropCount) {
      dropped++
      continue
    }
    result.push(msg)
  }
  return result.length >= 2 ? result : messages
}

/**
 * Strip <analysis> drafting scratchpad and extract <summary> content.
 * The analysis phase improves summary quality but has no value in the final context.
 */
function formatCompactSummary(rawSummary: string): string {
  let result = rawSummary

  // Strip analysis section
  result = result.replace(/<analysis>[\s\S]*?<\/analysis>/i, '')

  // Extract summary content if wrapped in tags
  const summaryMatch = result.match(/<summary>([\s\S]*?)<\/summary>/i)
  if (summaryMatch) {
    result = summaryMatch[1] || ''
  }

  // Clean up whitespace
  result = result.replace(/\n\n+/g, '\n\n').trim()

  return result
}

/**
 * Serialize messages into a structured text representation for the summarizer.
 * Includes original task, pinned context (plan), and full conversation history.
 */
function serializeCompressionInput(
  messages: UnifiedMessage[],
  originalTaskContent?: UnifiedMessage['content'],
  pinnedContext?: string
): string {
  const parts: string[] = []

  if (originalTaskContent) {
    parts.push('## Original Task')
    parts.push(
      typeof originalTaskContent === 'string'
        ? originalTaskContent
        : serializeMessageContent(originalTaskContent)
    )
  }

  if (pinnedContext?.trim()) {
    parts.push('## Pinned Plan Context')
    parts.push(pinnedContext.trim())
  }

  parts.push('## Full Conversation History')
  parts.push(serializeMessages(messages))

  return parts.join('\n\n')
}

function serializeMessageContent(content: ContentBlock[]): string {
  return content
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text
        case 'thinking':
          return ''
        case 'tool_use':
          return i18n.t('contextCompression.toolCallLog', {
            ns: 'agent',
            name: block.name,
            input: JSON.stringify(block.input).slice(0, 500)
          })
        case 'tool_result': {
          const result = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
          return i18n.t('contextCompression.toolResultLog', {
            ns: 'agent',
            error: block.isError,
            content: result.length > 800 ? `${result.slice(0, 800)}\n... [truncated, ${result.length} chars total]` : result
          })
        }
        case 'image':
          return i18n.t('contextCompression.imageAttachment', { ns: 'agent' })
        case 'image_error':
          return `[Image error: ${block.message}]`
        case 'agent_error':
          return `[Agent error: ${block.message}]`
        default:
          return ''
      }
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * Find the user's first real message (not a team notification, not pure tool_result blocks).
 */
function findOriginalTaskMessage(messages: UnifiedMessage[]): UnifiedMessage | null {
  for (const msg of messages) {
    if (msg.role !== 'user') continue
    if (msg.source === 'team') continue
    // Skip messages that are purely tool_result blocks (no human text)
    if (Array.isArray(msg.content)) {
      const hasText = (msg.content as ContentBlock[]).some(
        (b) => b.type === 'text' || b.type === 'image'
      )
      if (!hasText) continue
    }
    return msg
  }
  return null
}

/**
 * Serialize messages into a readable text representation for the summarizer.
 */
function serializeMessages(messages: UnifiedMessage[]): string {
  const parts: string[] = []

  for (const msg of messages) {
    const role = msg.role.toUpperCase()

    if (typeof msg.content === 'string') {
      if (msg.content.trim()) {
        parts.push(`[${role}]: ${msg.content}`)
      }
      continue
    }

    const blockText = serializeMessageContent(msg.content as ContentBlock[])
    if (blockText.trim()) {
      parts.push(`[${role}]: ${blockText}`)
    }
  }

  return parts.join('\n\n')
}

/**
 * Call the main model to produce a structured summary of the conversation.
 */
async function callSummarizer(
  serializedMessages: string,
  providerConfig: ProviderConfig,
  signal?: AbortSignal,
  focusPrompt?: string
): Promise<string> {
  const config: ProviderConfig = {
    ...providerConfig,
    systemPrompt: COMPRESSION_SYSTEM_PROMPT,
    // Disable thinking for compression — we want direct output
    thinkingEnabled: false
  }

  const focusInstruction = focusPrompt
    ? i18n.t('contextCompression.specialFocus', { ns: 'agent', focusPrompt })
    : ''

  const messages: UnifiedMessage[] = [
    {
      id: 'compress-req',
      role: 'user',
      content: i18n.t('contextCompression.compressRequest', {
        ns: 'agent',
        focusInstruction,
        content: serializedMessages
      }),
      createdAt: Date.now()
    }
  ]

  // Use a separate abort controller with timeout fallback
  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), 120_000) // 2 min max

  // Link parent signal
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeout)
      abortController.abort()
    } else {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timeout)
          abortController.abort()
        },
        { once: true }
      )
    }
  }

  let result = ''
  try {
    result = await runSidecarTextRequest({
      provider: config,
      messages,
      signal: abortController.signal,
      maxIterations: 1,
      responsesSessionScope: RESPONSES_SESSION_SCOPE_CONTEXT_COMPRESSION
    })
  } finally {
    clearTimeout(timeout)
  }

  // Strip thinking tags if present (some models wrap output)
  result = result.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()

  if (!result) {
    throw new Error(i18n.t('contextCompression.emptyResultError', { ns: 'agent' }))
  }

  // Validate that we got a meaningful summary (not just tags)
  const stripped = result.replace(/<\/?(?:analysis|summary)>/gi, '').trim()
  if (!stripped) {
    throw new Error(i18n.t('contextCompression.emptyResultError', { ns: 'agent' }))
  }

  return result
}
