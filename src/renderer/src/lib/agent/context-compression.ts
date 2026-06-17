import { nanoid } from 'nanoid'
import type {
  AIModelConfig,
  CompactBoundaryMeta,
  CompactSummaryMeta,
  ContentBlock,
  ProviderConfig,
  UnifiedMessage
} from '../api/types'
import { runSidecarTextRequest } from '@renderer/lib/ipc/agent-bridge'
import { RESPONSES_SESSION_SCOPE_CONTEXT_COMPRESSION } from '@renderer/lib/api/responses-session-policy'
import i18n from '@renderer/locales'

export interface CompressionConfig {
  enabled: boolean
  /** Model's max context token count. */
  contextLength: number
  /** Full compression trigger threshold, clamped to 0.3 ~ 0.9. */
  threshold: number
  /** Optional pre-compression trigger threshold before buffer adjustments. */
  preCompressThreshold?: number
  /** Tokens reserved for summary/output headroom before trigger calculations. */
  reservedOutputBudget?: number
}

export interface CompressionResult {
  compressed: boolean
  originalCount: number
  newCount: number
  messagesSummarized?: number
}

export const DEFAULT_CONTEXT_COMPRESSION_LIMIT = 200_000
export const DEFAULT_CONTEXT_COMPRESSION_THRESHOLD = 0.8
export const MIN_CONTEXT_COMPRESSION_THRESHOLD = 0.3
export const MAX_CONTEXT_COMPRESSION_THRESHOLD = 0.9
export const DEFAULT_CONTEXT_COMPRESSION_RESERVED_OUTPUT_TOKENS = 20_000
export const CONTEXT_COMPRESSION_AUTO_BUFFER_TOKENS = 13_000
export const CONTEXT_COMPRESSION_PRE_BUFFER_TOKENS = 20_000
export const CONTEXT_COMPRESSION_PRE_GAP_TOKENS = 8_000

const DEFAULT_PRECOMPRESS_THRESHOLD = 0.65
const PRESERVE_RECENT_COUNT = 0
const TOOL_RESULT_KEEP_RECENT = 6
const MAX_COMPRESS_RETRIES = 2
const MAX_CONSECUTIVE_FAILURES = 3
const SAFE_BOUNDARY_SCAN_LIMIT = 10
const TOOL_RESULT_CLEAR_CHAR_THRESHOLD = 200
const SERIALIZED_TOOL_USE_INPUT_LIMIT = 500
const SERIALIZED_TOOL_RESULT_LIMIT = 800
const BASE_RETRY_DELAY_MS = 1_500
const LEGACY_SUMMARY_PREFIXES = [
  '[Context Memory Compressed Summary]',
  '[Context Memory Compressed Summary]',
  '[Context Memory Compressed Summary'
]

const CLEARED_TOOL_RESULT_PLACEHOLDER = i18n.t('contextCompression.clearedToolResult', {
  ns: 'agent'
})
const CLEARED_THINKING_PLACEHOLDER = i18n.t('contextCompression.clearedThinking', { ns: 'agent' })
const COMPRESSION_SYSTEM_PROMPT = i18n.t('contextCompression.systemPrompt', { ns: 'agent' })

let consecutiveFailures = 0

function serializeImageAttachmentForContext(
  block: Extract<ContentBlock, { type: 'image' }>
): string {
  const label = i18n.t('contextCompression.imageAttachment', { ns: 'agent' })
  const filePath = block.source.filePath?.trim()
  if (filePath) return `${label} file path: ${filePath}`

  const url = block.source.type === 'url' ? block.source.url?.trim() : ''
  if (url) return `${label} URL: ${url}`

  return label
}

export function resetCompressionFailures(): void {
  consecutiveFailures = 0
}

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

  if (modelConfig?.enableExtendedContextCompression === false) {
    return DEFAULT_CONTEXT_COMPRESSION_LIMIT
  }

  return configuredContextLength
}

export function resolveCompressionReservedOutputBudget(
  modelConfig?: Pick<AIModelConfig, 'maxOutputTokens'> | null
): number {
  const maxOutputTokens =
    typeof modelConfig?.maxOutputTokens === 'number' && modelConfig.maxOutputTokens > 0
      ? Math.floor(modelConfig.maxOutputTokens)
      : DEFAULT_CONTEXT_COMPRESSION_RESERVED_OUTPUT_TOKENS
  return Math.min(DEFAULT_CONTEXT_COMPRESSION_RESERVED_OUTPUT_TOKENS, maxOutputTokens)
}

export function getEffectiveContextWindow(config: CompressionConfig): number {
  if (config.contextLength <= 0) return 0
  const reserved = Math.max(
    0,
    config.reservedOutputBudget ?? DEFAULT_CONTEXT_COMPRESSION_RESERVED_OUTPUT_TOKENS
  )
  return Math.max(1, config.contextLength - reserved)
}

export function getCompressionTriggerTokens(config: CompressionConfig): number {
  const effectiveWindow = getEffectiveContextWindow(config)
  if (effectiveWindow <= 0) return 0
  const ratioThreshold = Math.floor(effectiveWindow * config.threshold)
  const bufferedThreshold = effectiveWindow - CONTEXT_COMPRESSION_AUTO_BUFFER_TOKENS
  return Math.max(
    1,
    Math.min(ratioThreshold, bufferedThreshold > 0 ? bufferedThreshold : ratioThreshold)
  )
}

export function getPreCompressionTriggerTokens(config: CompressionConfig): number {
  const effectiveWindow = getEffectiveContextWindow(config)
  if (effectiveWindow <= 0) return 0

  const preThreshold = config.preCompressThreshold ?? DEFAULT_PRECOMPRESS_THRESHOLD
  const ratioThreshold = Math.floor(effectiveWindow * preThreshold)
  const fullThreshold = getCompressionTriggerTokens(config)
  const candidates = [ratioThreshold]
  const bufferedThreshold = effectiveWindow - CONTEXT_COMPRESSION_PRE_BUFFER_TOKENS
  if (bufferedThreshold > 0) candidates.push(bufferedThreshold)
  const gapThreshold = fullThreshold - CONTEXT_COMPRESSION_PRE_GAP_TOKENS
  if (gapThreshold > 0) candidates.push(gapThreshold)
  const threshold = Math.min(...candidates)
  return Math.max(1, Math.min(threshold, Math.max(1, fullThreshold - 1)))
}

export function shouldCompress(inputTokens: number, config: CompressionConfig): boolean {
  if (!config.enabled || config.contextLength <= 0) return false
  // The summarizer circuit-breaker (consecutiveFailures) is intentionally NOT checked
  // here. Once the LLM summarizer keeps failing, compressMessages() falls back to a
  // local, non-LLM truncation instead of doing nothing — so we must keep triggering
  // above the token threshold to guarantee the context stays bounded.
  return inputTokens >= getCompressionTriggerTokens(config)
}

export function shouldPreCompress(inputTokens: number, config: CompressionConfig): boolean {
  if (!config.enabled || config.contextLength <= 0) return false
  const preThreshold = getPreCompressionTriggerTokens(config)
  const fullThreshold = getCompressionTriggerTokens(config)
  return inputTokens >= preThreshold && inputTokens < fullThreshold
}

export function isCompactBoundaryMessage(message: UnifiedMessage): boolean {
  return message.role === 'system' && !!message.meta?.compactBoundary
}

export function isCompactSummaryMessage(message: UnifiedMessage): boolean {
  return message.role === 'user' && !!message.meta?.compactSummary
}

export function isLegacyCompactSummaryMessage(message: UnifiedMessage): boolean {
  if (message.role !== 'user' || typeof message.content !== 'string') return false
  const content = message.content.trim()
  return LEGACY_SUMMARY_PREFIXES.some((prefix) => content.startsWith(prefix))
}

export function isCompactSummaryLikeMessage(message: UnifiedMessage): boolean {
  return isCompactSummaryMessage(message) || isLegacyCompactSummaryMessage(message)
}

export interface ActiveCompactArtifacts {
  boundaryId: string | null
  boundaryIndex: number
  summaryId: string | null
  summaryIndex: number
}

export function isCompactArtifactMessage(message: UnifiedMessage): boolean {
  return isCompactBoundaryMessage(message) || isCompactSummaryLikeMessage(message)
}

function findCompactSummaryIndexAfterBoundary(
  messages: UnifiedMessage[],
  boundaryIndex: number
): number {
  for (let index = boundaryIndex + 1; index < messages.length; index += 1) {
    if (isCompactBoundaryMessage(messages[index])) return -1
    if (isCompactSummaryLikeMessage(messages[index])) return index
  }
  return -1
}

export function resolveActiveCompactArtifacts(
  messages: readonly UnifiedMessage[]
): ActiveCompactArtifacts | null {
  const items = [...messages]
  let active: ActiveCompactArtifacts | null = null
  let activeScore = Number.NEGATIVE_INFINITY

  for (let boundaryIndex = 0; boundaryIndex < items.length; boundaryIndex += 1) {
    const boundary = items[boundaryIndex]
    if (!isCompactBoundaryMessage(boundary)) continue

    const summaryIndex = findCompactSummaryIndexAfterBoundary(items, boundaryIndex)
    if (summaryIndex < 0) continue

    const summary = items[summaryIndex]
    const score = Math.max(boundary.createdAt, summary.createdAt)
    if (score < activeScore) continue

    activeScore = score
    active = {
      boundaryId: boundary.id,
      boundaryIndex,
      summaryId: summary.id,
      summaryIndex
    }
  }

  if (active) return active

  for (let summaryIndex = 0; summaryIndex < items.length; summaryIndex += 1) {
    const summary = items[summaryIndex]
    if (!isCompactSummaryLikeMessage(summary)) continue
    if (summary.createdAt < activeScore) continue
    activeScore = summary.createdAt
    active = {
      boundaryId: null,
      boundaryIndex: -1,
      summaryId: summary.id,
      summaryIndex
    }
  }

  return active
}

export function extractUnifiedMessageText(message?: UnifiedMessage | null): string {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content.trim()
  if (!Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim()
}

function splitCompactSummaryBlocks(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
}

function isCompactSummaryTitleBlock(block: string): boolean {
  const trimmed = block.trim()
  if (!trimmed) return false
  if (LEGACY_SUMMARY_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return true
  }
  if (!/^\[[^\]\n]+]$/.test(trimmed)) {
    return false
  }
  return (
    /summary|compressed|compacted|memory/i.test(trimmed) ||
    /[\u4e0a\u4e0b\u6587\u6458\u8981\u538b\u7f29]/u.test(trimmed)
  )
}

function isCompactSummaryIntroBlock(block: string): boolean {
  const normalized = block.replace(/\s+/g, ' ').trim()
  if (!normalized || normalized.length > 320) {
    return false
  }
  return [
    /this session is being continued/i,
    /continued from a previous conversation/i,
    /the following summary covers/i,
    /recent messages are preserved/i,
    /\u672c\u6b21\u4f1a\u8bdd.*\u7ee7\u7eed/u,
    /\u4ee5\u4e0b\u6458\u8981.*\u6d88\u606f/u,
    /\u8fd1\u671f\u6d88\u606f.*\u4fdd\u7559/u
  ].some((pattern) => pattern.test(normalized))
}

export function getCompactSummaryDisplayText(message: UnifiedMessage): string {
  const text = extractUnifiedMessageText(message)
  if (!text || !isCompactSummaryLikeMessage(message)) {
    return text
  }

  const blocks = splitCompactSummaryBlocks(text)
  if (blocks.length === 0) {
    return text
  }

  let startIndex = 0
  if (isCompactSummaryTitleBlock(blocks[startIndex]!)) {
    startIndex += 1
  }
  if (startIndex < blocks.length - 1 && isCompactSummaryIntroBlock(blocks[startIndex]!)) {
    startIndex += 1
  }

  return blocks.slice(startIndex).join('\n\n').trim() || text
}

export function mergeCompressedMessagesIntoConversation(
  currentMessages: UnifiedMessage[],
  compressedMessages?: UnifiedMessage[] | null
): UnifiedMessage[] | null {
  if (!compressedMessages || compressedMessages.length === 0) {
    return null
  }

  const summaryIndex = compressedMessages.findIndex((message) =>
    isCompactSummaryLikeMessage(message)
  )
  if (summaryIndex < 0) {
    return null
  }

  const boundaryMessage = compressedMessages.find((message) => isCompactBoundaryMessage(message))
  const preservedHeadId =
    boundaryMessage?.meta?.compactBoundary?.preservedSegment?.headId ??
    compressedMessages[summaryIndex + 1]?.id ??
    null

  const compressedIndexById = new Map(
    compressedMessages.map((message, index) => [message.id, index])
  )
  const currentIndexById = new Map(currentMessages.map((message, index) => [message.id, index]))

  const anchorId =
    (preservedHeadId &&
    compressedIndexById.has(preservedHeadId) &&
    currentIndexById.has(preservedHeadId)
      ? preservedHeadId
      : null) ??
    [...currentMessages].reverse().find((message) => compressedIndexById.has(message.id))?.id ??
    null

  if (!anchorId) {
    return null
  }

  const compressedTailIndex = compressedIndexById.get(anchorId) ?? -1
  const currentTailIndex = currentIndexById.get(anchorId) ?? -1

  if (compressedTailIndex < 0 || currentTailIndex < 0) {
    return null
  }

  const currentTail = currentMessages
    .slice(currentTailIndex)
    .filter((message) => !isCompactArtifactMessage(message))

  return [...compressedMessages.slice(0, compressedTailIndex), ...currentTail]
}

/**
 * Insert the compression artifacts into the existing transcript without dropping
 * the older messages. The agent loop continues to send the compressed history to
 * the LLM, but the UI keeps the full transcript visible — the boundary + summary
 * pair just acts as an inline divider that says "from this point on the model only
 * sees the summary".
 *
 * By default this inserts at the compact boundary used by the request view.
 * Callers may pass an explicit display insertion point so the UI can show the
 * summary at the chronological moment compression happened while the request
 * builder still reconstructs the reduced model view from compact metadata.
 */
export function mergeCompressedMessagesKeepHistory(
  currentMessages: UnifiedMessage[],
  compressedMessages?: UnifiedMessage[] | null,
  options: {
    insertAtEnd?: boolean
    insertBeforeIds?: readonly string[]
    fallbackInsertBeforeIds?: readonly string[]
  } = {}
): UnifiedMessage[] | null {
  if (!compressedMessages || compressedMessages.length === 0) {
    return null
  }

  const boundaryMessage = compressedMessages.find((message) => isCompactBoundaryMessage(message))
  // Prefer the meta-tagged summary so a legacy `[Context Memory Compressed Summary]`
  // user message that happened to live inside the preserved tail can't shadow the
  // freshly-emitted summary at the head.
  const summaryMessage =
    compressedMessages.find((message) => isCompactSummaryMessage(message)) ??
    compressedMessages.find((message) => isCompactSummaryLikeMessage(message))
  if (!boundaryMessage || !summaryMessage) {
    return null
  }

  const currentMessagesWithoutCompactArtifacts = currentMessages.filter(
    (message) => !isCompactArtifactMessage(message)
  )
  const currentIds = new Set(currentMessagesWithoutCompactArtifacts.map((message) => message.id))

  // Skip the merge entirely if the boundary is already wired into the transcript
  // (e.g. resume of a previously-compressed conversation). Return a shallow copy
  // so the caller can safely mutate the result without poking at frozen state.
  if (
    currentMessages.some((message) => message.id === boundaryMessage.id) &&
    currentMessages.some((message) => message.id === summaryMessage.id)
  ) {
    return currentMessages.filter(
      (message) =>
        !isCompactArtifactMessage(message) ||
        message.id === boundaryMessage.id ||
        message.id === summaryMessage.id
    )
  }

  const preservedHeadId = boundaryMessage.meta?.compactBoundary?.preservedSegment?.headId ?? null

  // Prefer an explicit UI insertion point when supplied. Otherwise fall back to
  // the preserved tail's head so any current user message kept outside the
  // summary stays after the compact boundary in both UI and request order.
  let insertIndex = -1
  if (options.insertAtEnd) {
    insertIndex = currentMessagesWithoutCompactArtifacts.length
  }
  if (insertIndex < 0) {
    for (const insertBeforeId of options.insertBeforeIds ?? []) {
      if (!insertBeforeId) continue
      insertIndex = currentMessagesWithoutCompactArtifacts.findIndex(
        (message) => message.id === insertBeforeId
      )
      if (insertIndex >= 0) break
    }
  }
  // Locate the preserved tail's head inside the current transcript. When the
  // boundary's preservedSegment is missing or stale, fall back to the first
  // message after the boundary/summary pair in the compressed payload that the
  // current transcript still knows about. As a last resort (no preserved tail at
  // all — e.g. manual /compress that summarized everything), append at the very
  // end so the boundary still renders, rather than dropping the merge.
  if (insertIndex < 0) {
    if (preservedHeadId && currentIds.has(preservedHeadId)) {
      insertIndex = currentMessagesWithoutCompactArtifacts.findIndex(
        (message) => message.id === preservedHeadId
      )
    }
    if (insertIndex < 0) {
      const summaryIndex = compressedMessages.indexOf(summaryMessage)
      for (let index = summaryIndex + 1; index < compressedMessages.length; index += 1) {
        const candidateId = compressedMessages[index]?.id
        if (candidateId && currentIds.has(candidateId)) {
          insertIndex = currentMessagesWithoutCompactArtifacts.findIndex(
            (message) => message.id === candidateId
          )
          if (insertIndex >= 0) break
        }
      }
    }
  }
  if (insertIndex < 0) {
    for (const fallbackId of options.fallbackInsertBeforeIds ?? []) {
      if (!fallbackId) continue
      insertIndex = currentMessagesWithoutCompactArtifacts.findIndex(
        (message) => message.id === fallbackId
      )
      if (insertIndex >= 0) break
    }
  }
  if (insertIndex < 0) {
    insertIndex = currentMessagesWithoutCompactArtifacts.length
  }

  return [
    ...currentMessagesWithoutCompactArtifacts.slice(0, insertIndex),
    boundaryMessage,
    summaryMessage,
    ...currentMessagesWithoutCompactArtifacts.slice(insertIndex)
  ]
}

/**
 * After loop_end, splice the agent loop's post-compression message array into
 * the renderer's kept-history transcript without dropping the older messages.
 *
 * The agent loop only carries the post-compression view ([boundary, summary,
 * ...newTurns]). The renderer transcript carries the full history
 * with the boundary inserted in the middle ([...oldHistory, boundary, summary,
 * ...newTurns, ...trailingMarkers]). To keep the older messages
 * we splice agentMessages[boundaryIdx..] over currentMessages[boundaryIdx..]
 * while preserving any trailing items the agent never had (e.g. the persistent
 * compression status marker).
 *
 * During a live renderer run, the loop-local assistant/tool-result messages use
 * internal IDs while the UI streams into the stable `runId` assistant message.
 * Once the compression event has already inserted the boundary + summary, the
 * renderer tail is authoritative and replacing it here would duplicate or hide
 * the content that streamed after compression.
 */
export function mergeLoopEndMessagesKeepHistory(
  currentMessages: UnifiedMessage[],
  agentMessages: UnifiedMessage[]
): UnifiedMessage[] | null {
  const boundaryInAgent = agentMessages.find(isCompactBoundaryMessage)
  if (!boundaryInAgent) return null

  const summaryInAgent = agentMessages.find((message) => isCompactSummaryMessage(message))
  const currentIds = new Set(currentMessages.map((message) => message.id))
  if (summaryInAgent && currentIds.has(boundaryInAgent.id) && currentIds.has(summaryInAgent.id)) {
    return null
  }

  const boundaryIdxAgent = agentMessages.indexOf(boundaryInAgent)
  const boundaryIdxCurrent = currentMessages.findIndex(
    (message) => message.id === boundaryInAgent.id
  )
  if (boundaryIdxCurrent < 0 || boundaryIdxAgent < 0) return null

  const agentMessageIds = new Set(agentMessages.map((message) => message.id))
  // Trailing renderer-only markers (e.g. the compression status placeholder) sit
  // after the last message the agent still knows about. Walk back from the end
  // of currentMessages looking for the most recent overlap with agentMessages.
  // Bound is `> boundaryIdxCurrent` (not `>=`) — a boundary-only overlap means
  // the renderer view past the boundary diverged completely, so treat it as no
  // tail overlap rather than slicing in the renderer's existing summary
  // tail and duplicating it.
  let agentLastIdxInCurrent = -1
  for (let i = currentMessages.length - 1; i > boundaryIdxCurrent; i -= 1) {
    if (agentMessageIds.has(currentMessages[i].id)) {
      agentLastIdxInCurrent = i
      break
    }
  }
  const trailingItems =
    agentLastIdxInCurrent >= 0 ? currentMessages.slice(agentLastIdxInCurrent + 1) : []

  return [
    ...currentMessages.slice(0, boundaryIdxCurrent),
    ...agentMessages.slice(boundaryIdxAgent),
    ...trailingItems
  ]
}

export function createCompactBoundaryMessage(args: {
  trigger: CompactBoundaryMeta['trigger']
  preTokens: number
  messagesSummarized: number
  preservedMessages?: UnifiedMessage[]
}): UnifiedMessage {
  const preservedMessages = args.preservedMessages ?? []
  const meta: CompactBoundaryMeta = {
    trigger: args.trigger,
    preTokens: args.preTokens,
    messagesSummarized: args.messagesSummarized,
    ...(preservedMessages.length > 0
      ? {
          preservedSegment: {
            headId: preservedMessages[0]!.id,
            anchorId: '',
            tailId: preservedMessages[preservedMessages.length - 1]!.id
          }
        }
      : {})
  }

  return {
    id: nanoid(),
    role: 'system',
    content: 'Conversation compacted',
    createdAt: Date.now(),
    meta: { compactBoundary: meta }
  }
}

export function createCompactSummaryMessage(args: {
  summary: string
  messagesSummarized: number
  recentMessagesPreserved: boolean
}): UnifiedMessage {
  const summaryMeta: CompactSummaryMeta = {
    messagesSummarized: args.messagesSummarized,
    recentMessagesPreserved: args.recentMessagesPreserved
  }

  return {
    id: nanoid(),
    role: 'user',
    content: i18n.t('contextCompression.summaryMessage', {
      ns: 'agent',
      count: args.messagesSummarized,
      summary: args.summary
    }),
    createdAt: Date.now(),
    meta: { compactSummary: summaryMeta }
  }
}

export function preCompressMessages(messages: UnifiedMessage[]): UnifiedMessage[] {
  if (messages.length <= TOOL_RESULT_KEEP_RECENT) return messages

  const cutoff = messages.length - TOOL_RESULT_KEEP_RECENT
  return messages.map((message, index) => {
    if (index >= cutoff) return message
    if (typeof message.content === 'string') return message

    let changed = false
    const newBlocks = message.content.map((block) => {
      if (block.type === 'tool_result') {
        const content =
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
        if (content.length > TOOL_RESULT_CLEAR_CHAR_THRESHOLD) {
          changed = true
          return { ...block, content: CLEARED_TOOL_RESULT_PLACEHOLDER }
        }
      }

      if (block.type === 'thinking') {
        changed = true
        return { ...block, thinking: CLEARED_THINKING_PLACEHOLDER }
      }

      if (block.type === 'image') {
        changed = true
        return { type: 'text', text: serializeImageAttachmentForContext(block) } as ContentBlock
      }

      return block
    })

    return changed ? { ...message, content: newBlocks } : message
  })
}

export async function compressMessages(
  messages: UnifiedMessage[],
  providerConfig: ProviderConfig,
  signal?: AbortSignal,
  preserveCount = PRESERVE_RECENT_COUNT,
  focusPrompt?: string,
  pinnedContext?: string,
  trigger: CompactBoundaryMeta['trigger'] = 'manual',
  preTokens = 0
): Promise<{ messages: UnifiedMessage[]; result: CompressionResult }> {
  const originalCount = messages.length
  const minMessagesToCompress = trigger === 'manual' ? 1 : 2
  const effectivePreserveCount =
    trigger === 'manual'
      ? Math.min(Math.max(0, preserveCount), Math.max(0, originalCount - minMessagesToCompress))
      : preserveCount

  if (originalCount < effectivePreserveCount + minMessagesToCompress) {
    return {
      messages,
      result: { compressed: false, originalCount, newCount: originalCount }
    }
  }

  const boundaryIndex = findSafeCompactBoundary(messages, messages.length - effectivePreserveCount)
  const messagesToCompress = messages.slice(0, boundaryIndex)
  const messagesToPreserve = messages.slice(boundaryIndex)

  if (messagesToCompress.length < minMessagesToCompress) {
    return {
      messages,
      result: { compressed: false, originalCount, newCount: originalCount }
    }
  }

  // Summarizer circuit-breaker is open (the LLM summarizer has failed repeatedly).
  // Skip the network call and reduce the context locally so it stays bounded.
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    console.warn('[Context Compression] Summarizer circuit open — using local truncation fallback.')
    return buildLocalTruncationResult(
      messagesToCompress,
      messagesToPreserve,
      originalCount,
      preTokens
    )
  }

  let lastError: Error | null = null
  for (let attempt = 0; attempt <= MAX_COMPRESS_RETRIES; attempt += 1) {
    try {
      const inputMessages =
        attempt === 0 ? messagesToCompress : truncateOldestMessages(messagesToCompress, attempt)
      const originalTaskMessage = findOriginalTaskMessage(inputMessages)
      const serialized = serializeCompressionInput(
        inputMessages,
        originalTaskMessage?.content,
        pinnedContext
      )
      const rawSummary = await callSummarizer(serialized, providerConfig, signal, focusPrompt)
      const formattedSummary = formatCompactSummary(rawSummary)
      if (!formattedSummary.trim()) {
        throw new Error(i18n.t('contextCompression.emptyResultError', { ns: 'agent' }))
      }

      const boundaryMessage = createCompactBoundaryMessage({
        trigger,
        preTokens,
        messagesSummarized: messagesToCompress.length,
        preservedMessages: messagesToPreserve
      })
      const summaryMessage = createCompactSummaryMessage({
        summary: formattedSummary,
        messagesSummarized: messagesToCompress.length,
        recentMessagesPreserved: messagesToPreserve.length > 0
      })

      if (boundaryMessage.meta?.compactBoundary?.preservedSegment) {
        boundaryMessage.meta.compactBoundary.preservedSegment.anchorId = summaryMessage.id
      }

      consecutiveFailures = 0

      const compressedMessages = [boundaryMessage, summaryMessage, ...messagesToPreserve]
      return {
        messages: compressedMessages,
        result: {
          compressed: true,
          originalCount,
          newCount: compressedMessages.length,
          messagesSummarized: messagesToCompress.length
        }
      }
    } catch (error) {
      lastError = error as Error
      console.error(`[Context Compression] Attempt ${attempt + 1} failed:`, error)
      if (attempt < MAX_COMPRESS_RETRIES) {
        await new Promise((resolve) =>
          setTimeout(resolve, BASE_RETRY_DELAY_MS * Math.pow(2, attempt))
        )
      }
    }
  }

  consecutiveFailures += 1
  console.error(
    `[Context Compression] All retries failed (consecutive: ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}), falling back to local truncation:`,
    lastError
  )

  // The summarizer failed for this attempt. Rather than leaving the context
  // unbounded, drop the oldest messages locally at a tool-pair-safe boundary.
  return buildLocalTruncationResult(
    messagesToCompress,
    messagesToPreserve,
    originalCount,
    preTokens
  )
}

/**
 * Non-LLM fallback used when the summarizer is unavailable or its circuit-breaker
 * is open. Produces the SAME boundary + summary artifact shape as a successful
 * compression (so the UI merge/render logic treats it identically), but the
 * "summary" is a localized placeholder noting that the older messages were dropped
 * without an LLM-generated summary. The original task message is appended verbatim
 * when available so the model retains the overall goal.
 */
function buildLocalTruncationResult(
  messagesToCompress: UnifiedMessage[],
  messagesToPreserve: UnifiedMessage[],
  originalCount: number,
  preTokens: number
): { messages: UnifiedMessage[]; result: CompressionResult } {
  const originalTask = findOriginalTaskMessage(messagesToCompress)
  const taskText = originalTask ? extractUnifiedMessageText(originalTask) : ''
  let summaryBody = i18n.t('contextCompression.localTruncationSummary', {
    ns: 'agent',
    count: messagesToCompress.length
  })
  if (taskText) {
    summaryBody = `${summaryBody}\n\n${taskText}`
  }

  const boundaryMessage = createCompactBoundaryMessage({
    trigger: 'auto',
    preTokens,
    messagesSummarized: messagesToCompress.length,
    preservedMessages: messagesToPreserve
  })
  const summaryMessage = createCompactSummaryMessage({
    summary: summaryBody,
    messagesSummarized: messagesToCompress.length,
    recentMessagesPreserved: messagesToPreserve.length > 0
  })
  if (boundaryMessage.meta?.compactBoundary?.preservedSegment) {
    boundaryMessage.meta.compactBoundary.preservedSegment.anchorId = summaryMessage.id
  }

  const compressedMessages = [boundaryMessage, summaryMessage, ...messagesToPreserve]
  return {
    messages: compressedMessages,
    result: {
      compressed: true,
      originalCount,
      newCount: compressedMessages.length,
      messagesSummarized: messagesToCompress.length
    }
  }
}

function findSafeCompactBoundary(messages: UnifiedMessage[], initialBoundary: number): number {
  let boundary = Math.max(1, Math.min(initialBoundary, messages.length))

  for (let attempts = 0; attempts < SAFE_BOUNDARY_SCAN_LIMIT; attempts += 1) {
    const compressedToolUseIds = new Set<string>()
    for (let index = 0; index < boundary; index += 1) {
      const message = messages[index]
      if (typeof message.content === 'string') continue
      for (const block of message.content) {
        if (block.type === 'tool_use' && block.id) {
          compressedToolUseIds.add(block.id)
        }
      }
    }

    let hasSplit = false
    for (let index = boundary; index < messages.length && !hasSplit; index += 1) {
      const message = messages[index]
      if (typeof message.content === 'string') continue
      for (const block of message.content) {
        if (
          block.type === 'tool_result' &&
          block.toolUseId &&
          compressedToolUseIds.has(block.toolUseId)
        ) {
          hasSplit = true
          break
        }
      }
    }

    if (!hasSplit) return boundary
    boundary = Math.max(1, boundary - 1)
  }

  return boundary
}

function truncateOldestMessages(messages: UnifiedMessage[], attempt: number): UnifiedMessage[] {
  const dropCount = Math.ceil(messages.length * 0.25 * attempt)
  const result: UnifiedMessage[] = []
  let dropped = 0
  let keptFirstUser = false

  for (const message of messages) {
    if (message.role === 'system') {
      result.push(message)
      continue
    }

    if (!keptFirstUser && message.role === 'user') {
      result.push(message)
      keptFirstUser = true
      continue
    }

    if (dropped < dropCount) {
      dropped += 1
      continue
    }

    result.push(message)
  }

  return result.length >= 2 ? result : messages
}

function formatCompactSummary(rawSummary: string): string {
  let result = rawSummary
  result = result.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '')
  const summaryMatch = result.match(/<summary>([\s\S]*?)<\/summary>/i)
  if (summaryMatch) {
    result = summaryMatch[1] ?? ''
  }
  return result.replace(/\n\n+/g, '\n\n').trim()
}

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
            input: JSON.stringify(block.input).slice(0, SERIALIZED_TOOL_USE_INPUT_LIMIT)
          })
        case 'tool_result': {
          const result =
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
          const preview =
            result.length > SERIALIZED_TOOL_RESULT_LIMIT
              ? `${result.slice(0, SERIALIZED_TOOL_RESULT_LIMIT)}\n... [truncated, ${result.length} chars total]`
              : result
          return i18n.t('contextCompression.toolResultLog', {
            ns: 'agent',
            error: block.isError,
            content: preview
          })
        }
        case 'image':
          return serializeImageAttachmentForContext(block)
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

function findOriginalTaskMessage(messages: UnifiedMessage[]): UnifiedMessage | null {
  for (const message of messages) {
    if (message.role !== 'user') continue
    if (message.source === 'team') continue
    if (isCompactSummaryLikeMessage(message)) continue

    if (Array.isArray(message.content)) {
      const hasHumanContent = message.content.some(
        (block) => block.type === 'text' || block.type === 'image'
      )
      if (!hasHumanContent) continue
    }

    return message
  }

  return null
}

function serializeMessages(messages: UnifiedMessage[]): string {
  const parts: string[] = []

  for (const message of messages) {
    const role = message.role.toUpperCase()

    if (typeof message.content === 'string') {
      if (message.content.trim()) {
        parts.push(`[${role}]: ${message.content}`)
      }
      continue
    }

    const blockText = serializeMessageContent(message.content)
    if (blockText.trim()) {
      parts.push(`[${role}]: ${blockText}`)
    }
  }

  return parts.join('\n\n')
}

async function callSummarizer(
  serializedMessages: string,
  providerConfig: ProviderConfig,
  signal?: AbortSignal,
  focusPrompt?: string
): Promise<string> {
  const config: ProviderConfig = {
    ...providerConfig,
    systemPrompt: COMPRESSION_SYSTEM_PROMPT,
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

  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), 120_000)

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

  result = result.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  if (!result) {
    throw new Error(i18n.t('contextCompression.emptyResultError', { ns: 'agent' }))
  }

  const stripped = result.replace(/<\/?(?:analysis|summary)>/gi, '').trim()
  if (!stripped) {
    throw new Error(i18n.t('contextCompression.emptyResultError', { ns: 'agent' }))
  }

  return result
}
