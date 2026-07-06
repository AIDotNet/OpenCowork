import type {
  ContentBlock,
  ToolResultContent,
  ToolUseBlock,
  UnifiedMessage
} from '@renderer/lib/api/types'
import { isEditableUserMessage } from '@renderer/lib/image-attachments'
import {
  isCompactBoundaryMessage,
  isCompactSummaryLikeMessage,
  resolveActiveCompactArtifacts
} from '@renderer/lib/agent/context-compression'

export interface RenderableMessageMeta {
  messageId: string
  isLastUserMessage: boolean
  isLastAssistantMessage: boolean
}

export interface ChatRenderableMessageMeta extends RenderableMessageMeta {
  showContinue: boolean
}

export interface TailToolExecutionState {
  assistantIndex: number
  assistantMessageId: string
  toolUseBlocks: ToolUseBlock[]
  toolResultMap: Map<string, { content: ToolResultContent; isError?: boolean }>
  trailingToolResultMessageCount: number
}

const messageLookupCache = new WeakMap<UnifiedMessage[], Map<string, UnifiedMessage>>()
const transcriptStaticAnalysisCache = new WeakMap<UnifiedMessage[], TranscriptStaticAnalysis>()
const HIDDEN_MESSAGE_LIST_TOOL_NAMES = new Set(['TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList'])
const THINK_OPEN_TAG_RE = /<\s*think\s*>/i

// --- Signature-based fast cache for transcriptStaticAnalysis ---
// The WeakMap above is keyed by array reference, which misses on every Immer state update.
// This signature keeps the fast path, but also invalidates when message contents are revised.
let _lastStructuralSignature = ''
let _lastAnalysisResult: TranscriptStaticAnalysis | null = null

function buildStructuralSignature(messages: UnifiedMessage[]): string {
  const len = messages.length
  if (len === 0) return '0'
  return messages.map((message) => `${message.id}:${message._revision ?? 0}`).join('|')
}

type ToolResultsInnerMap = Map<string, { content: ToolResultContent; isError?: boolean }>

interface AssistantToolResultsCacheEntry {
  contributors: UnifiedMessage[]
  innerMap: ToolResultsInnerMap
}

const assistantToolResultsCache = new WeakMap<UnifiedMessage, AssistantToolResultsCacheEntry>()
const orchestrationBindingEntryCache = new WeakMap<UnifiedMessage, string>()

function contributorsEqual(a: UnifiedMessage[], b: UnifiedMessage[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function getStableAssistantToolResults(
  assistantMessage: UnifiedMessage,
  contributors: UnifiedMessage[]
): ToolResultsInnerMap {
  const cached = assistantToolResultsCache.get(assistantMessage)
  if (cached && contributorsEqual(cached.contributors, contributors)) {
    return cached.innerMap
  }
  const innerMap: ToolResultsInnerMap = new Map()
  for (const contributor of contributors) {
    collectToolResults(contributor.content as ContentBlock[], innerMap)
  }
  assistantToolResultsCache.set(assistantMessage, {
    contributors: contributors.slice(),
    innerMap
  })
  return innerMap
}

export interface TranscriptStaticAnalysis {
  messageLookup: Map<string, UnifiedMessage>
  toolResultsLookup: Map<string, Map<string, { content: ToolResultContent; isError?: boolean }>>
  renderableMessageIds: string[]
  lastRealUserMessageId: string | null
  lastAssistantMessageId: string | null
  tailToolExecutionState: TailToolExecutionState | null
  orchestrationBindingSignature: string
}

export function isToolResultOnlyUserMessage(message: UnifiedMessage): boolean {
  return (
    message.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.every((block) => block.type === 'tool_result')
  )
}

function isRealUserMessage(message: UnifiedMessage): boolean {
  return isEditableUserMessage(message) && !isCompactSummaryLikeMessage(message)
}

function hasVisibleAssistantBlock(block: ContentBlock): boolean {
  if (block.type === 'tool_use') {
    return !HIDDEN_MESSAGE_LIST_TOOL_NAMES.has(block.name)
  }

  if (block.type === 'text') {
    return block.text.trim().length > 0
  }

  if (block.type === 'thinking') {
    return block.thinking.trim().length > 0
  }

  return true
}

function hasVisibleAssistantStringContent(content: string): boolean {
  if (!THINK_OPEN_TAG_RE.test(content)) {
    return content.trim().length > 0
  }

  const textWithoutThinking = content
    .replace(/<\s*think\s*>[\s\S]*?(<\s*\/\s*think\s*>|$)/gi, '')
    .replace(/<\s*\/?\s*think\s*>/gi, '')
    .trim()
  if (textWithoutThinking.length > 0) return true

  const thinkBlocks = content.matchAll(/<\s*think\s*>([\s\S]*?)(<\s*\/\s*think\s*>|$)/gi)
  for (const match of thinkBlocks) {
    if ((match[1] ?? '').replace(/<\s*\/?\s*think\s*>/gi, '').trim().length > 0) {
      return true
    }
  }

  return false
}

function shouldRenderInMessageList(
  message: UnifiedMessage,
  activeCompactSummaryId: string | null
): boolean {
  if (message.role === 'system') return false
  if (isCompactSummaryLikeMessage(message)) return message.id === activeCompactSummaryId
  if (isToolResultOnlyUserMessage(message)) return false
  if (message.role !== 'assistant') return true
  if (typeof message.content === 'string') {
    return hasVisibleAssistantStringContent(message.content)
  }
  if (!Array.isArray(message.content)) return true
  return message.content.some(hasVisibleAssistantBlock)
}

function isTransparentSystemMessage(message: UnifiedMessage): boolean {
  return message.role === 'system' && !isCompactBoundaryMessage(message)
}

function collectToolResults(
  blocks: ContentBlock[],
  target: Map<string, { content: ToolResultContent; isError?: boolean }>
): void {
  for (const block of blocks) {
    if (block.type === 'tool_result') {
      target.set(block.toolUseId, { content: block.content, isError: block.isError })
    }
  }
}

function buildOrchestrationMessageBindingEntry(message: UnifiedMessage): string {
  if (message.role !== 'assistant') {
    return `${message.id}:${message.role}`
  }

  if (!Array.isArray(message.content)) {
    return `${message.id}:${message.role}:string`
  }

  const toolUseSignature = message.content
    .filter(
      (block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use'
    )
    .map((block) => {
      const teamName = typeof block.input.team_name === 'string' ? block.input.team_name.trim() : ''
      const runsInBackground = block.input.run_in_background === true ? 'bg' : 'fg'
      return `${block.id}:${block.name}:${teamName}:${runsInBackground}`
    })
    .join(',')

  return `${message.id}:${message.role}:blocks:${message.content.length}:${toolUseSignature}`
}

function buildTailToolExecutionState(messages: UnifiedMessage[]): TailToolExecutionState | null {
  if (messages.length === 0) return null

  const toolResultMap = new Map<string, { content: ToolResultContent; isError?: boolean }>()
  let trailingToolResultMessageCount = 0
  let assistantIndex = messages.length - 1

  while (assistantIndex >= 0) {
    const message = messages[assistantIndex]
    if (isToolResultOnlyUserMessage(message)) {
      collectToolResults(message.content as ContentBlock[], toolResultMap)
      trailingToolResultMessageCount += 1
      assistantIndex -= 1
      continue
    }
    if (isTransparentSystemMessage(message)) {
      assistantIndex -= 1
      continue
    }
    break
  }

  if (assistantIndex < 0) return null

  const assistantMessage = messages[assistantIndex]
  if (assistantMessage.role !== 'assistant' || !Array.isArray(assistantMessage.content)) {
    return null
  }

  const toolUseBlocks = assistantMessage.content.filter(
    (block): block is ToolUseBlock => block.type === 'tool_use'
  )
  if (toolUseBlocks.length === 0) return null

  // If the model produced a final text response after its last tool call, the
  // turn is already complete and there is nothing to continue.
  const lastToolUseIndex = assistantMessage.content.reduce(
    (last, block, index) => (block.type === 'tool_use' ? index : last),
    -1
  )
  const hasTrailingText = assistantMessage.content.some(
    (block, index) =>
      index > lastToolUseIndex && block.type === 'text' && block.text.trim().length > 0
  )
  if (hasTrailingText) return null

  return {
    assistantIndex,
    assistantMessageId: assistantMessage.id,
    toolUseBlocks,
    toolResultMap,
    trailingToolResultMessageCount
  }
}

export function buildTranscriptStaticAnalysis(
  messages: UnifiedMessage[]
): TranscriptStaticAnalysis {
  const cached = transcriptStaticAnalysisCache.get(messages)
  if (cached) {
    _lastStructuralSignature = buildStructuralSignature(messages)
    _lastAnalysisResult = cached
    return cached
  }

  // Fast path: when the message list structure hasn't changed (no add/remove),
  // reuse the expensive structural parts and only rebuild messageLookup + binding hash.
  const structSig = buildStructuralSignature(messages)
  if (structSig === _lastStructuralSignature && _lastAnalysisResult) {
    const prev = _lastAnalysisResult

    const messageLookup = new Map<string, UnifiedMessage>()
    let bindingHash = 0x811c9dc5
    for (const message of messages) {
      messageLookup.set(message.id, message)

      let entry = orchestrationBindingEntryCache.get(message)
      if (entry === undefined) {
        entry = buildOrchestrationMessageBindingEntry(message)
        orchestrationBindingEntryCache.set(message, entry)
      }
      for (let i = 0; i < entry.length; i += 1) {
        bindingHash ^= entry.charCodeAt(i)
        bindingHash =
          (bindingHash +
            ((bindingHash << 1) +
              (bindingHash << 4) +
              (bindingHash << 7) +
              (bindingHash << 8) +
              (bindingHash << 24))) >>>
          0
      }
      bindingHash ^= 0x7c
      bindingHash =
        (bindingHash +
          ((bindingHash << 1) +
            (bindingHash << 4) +
            (bindingHash << 7) +
            (bindingHash << 8) +
            (bindingHash << 24))) >>>
        0
    }

    const bindingSig = bindingHash.toString(36)

    const fastResult: TranscriptStaticAnalysis = {
      messageLookup,
      toolResultsLookup: prev.toolResultsLookup,
      renderableMessageIds: prev.renderableMessageIds,
      lastRealUserMessageId: prev.lastRealUserMessageId,
      lastAssistantMessageId: prev.lastAssistantMessageId,
      tailToolExecutionState: prev.tailToolExecutionState,
      orchestrationBindingSignature: bindingSig
    }
    transcriptStaticAnalysisCache.set(messages, fastResult)
    _lastAnalysisResult = fastResult
    return fastResult
  }

  // Full rebuild — message list structure changed.
  const messageLookup = new Map<string, UnifiedMessage>()
  const toolResultsLookup = new Map<string, ToolResultsInnerMap>()
  const renderableMessageIds: string[] = []
  const assistantContributors = new Map<
    string,
    { assistant: UnifiedMessage; contributors: UnifiedMessage[] }
  >()
  const activeCompact = resolveActiveCompactArtifacts(messages)
  const activeCompactSummaryId = activeCompact?.summaryId ?? null
  let currentAssistantMessageId: string | null = null
  let lastRealUserMessageId: string | null = null
  let lastAssistantMessageId: string | null = null
  let bindingHash = 0x811c9dc5

  for (const message of messages) {
    messageLookup.set(message.id, message)

    let entry = orchestrationBindingEntryCache.get(message)
    if (entry === undefined) {
      entry = buildOrchestrationMessageBindingEntry(message)
      orchestrationBindingEntryCache.set(message, entry)
    }
    for (let i = 0; i < entry.length; i += 1) {
      bindingHash ^= entry.charCodeAt(i)
      bindingHash =
        (bindingHash +
          ((bindingHash << 1) +
            (bindingHash << 4) +
            (bindingHash << 7) +
            (bindingHash << 8) +
            (bindingHash << 24))) >>>
        0
    }
    bindingHash ^= 0x7c
    bindingHash =
      (bindingHash +
        ((bindingHash << 1) +
          (bindingHash << 4) +
          (bindingHash << 7) +
          (bindingHash << 8) +
          (bindingHash << 24))) >>>
      0

    if (message.role === 'assistant') {
      currentAssistantMessageId = message.id
      assistantContributors.set(message.id, { assistant: message, contributors: [] })
    } else if (isToolResultOnlyUserMessage(message) && currentAssistantMessageId) {
      const bucket = assistantContributors.get(currentAssistantMessageId)
      if (bucket) bucket.contributors.push(message)
    } else if (isTransparentSystemMessage(message)) {
      // Hidden system reminders are metadata injected into the transcript. They should
      // not sever the assistant tool_use -> user tool_result association used by cards.
    } else {
      currentAssistantMessageId = null
    }

    if (!shouldRenderInMessageList(message, activeCompactSummaryId)) continue

    renderableMessageIds.push(message.id)
    if (isRealUserMessage(message)) {
      lastRealUserMessageId = message.id
    }
    if (message.role === 'assistant') {
      lastAssistantMessageId = message.id
    }
  }

  for (const [assistantId, { assistant, contributors }] of assistantContributors) {
    if (contributors.length === 0) continue
    toolResultsLookup.set(assistantId, getStableAssistantToolResults(assistant, contributors))
  }

  const nextAnalysis: TranscriptStaticAnalysis = {
    messageLookup,
    toolResultsLookup,
    renderableMessageIds,
    lastRealUserMessageId,
    lastAssistantMessageId,
    tailToolExecutionState: buildTailToolExecutionState(messages),
    orchestrationBindingSignature: bindingHash.toString(36)
  }

  transcriptStaticAnalysisCache.set(messages, nextAnalysis)
  _lastStructuralSignature = structSig
  _lastAnalysisResult = nextAnalysis
  return nextAnalysis
}

export function buildRenderableMessageMetaFromAnalysis(
  analysis: TranscriptStaticAnalysis,
  streamingMessageId: string | null
): RenderableMessageMeta[] {
  const lastRealUserMessageId = streamingMessageId ? null : analysis.lastRealUserMessageId
  const renderableMessageIds = [...analysis.renderableMessageIds]
  if (
    streamingMessageId &&
    !renderableMessageIds.includes(streamingMessageId) &&
    analysis.messageLookup.get(streamingMessageId)?.role === 'assistant'
  ) {
    renderableMessageIds.push(streamingMessageId)
  }

  return renderableMessageIds.map((messageId) => ({
    messageId,
    isLastUserMessage: messageId === lastRealUserMessageId,
    isLastAssistantMessage:
      messageId === analysis.lastAssistantMessageId || messageId === streamingMessageId
  }))
}

export function buildChatRenderableMessageMetaFromAnalysis(
  analysis: TranscriptStaticAnalysis,
  streamingMessageId: string | null,
  continueAssistantMessageId: string | null
): ChatRenderableMessageMeta[] {
  return buildRenderableMessageMetaFromAnalysis(analysis, streamingMessageId).map((message) => ({
    ...message,
    showContinue: message.messageId === continueAssistantMessageId
  }))
}

export function getToolResultsLookup(
  messages: UnifiedMessage[]
): Map<string, Map<string, { content: ToolResultContent; isError?: boolean }>> {
  const next = new Map<string, Map<string, { content: ToolResultContent; isError?: boolean }>>()
  let currentAssistantMessageId: string | null = null

  for (const message of messages) {
    if (message.role === 'assistant') {
      currentAssistantMessageId = message.id
      continue
    }

    if (isToolResultOnlyUserMessage(message) && currentAssistantMessageId) {
      let results = next.get(currentAssistantMessageId)
      if (!results) {
        results = new Map()
        next.set(currentAssistantMessageId, results)
      }
      collectToolResults(message.content as ContentBlock[], results)
      continue
    }

    if (isTransparentSystemMessage(message)) {
      continue
    }

    currentAssistantMessageId = null
  }

  return next
}

export function getMessageLookup(messages: UnifiedMessage[]): Map<string, UnifiedMessage> {
  const cached = messageLookupCache.get(messages)
  if (cached) return cached

  const next = new Map<string, UnifiedMessage>()
  for (const message of messages) {
    next.set(message.id, message)
  }

  messageLookupCache.set(messages, next)
  return next
}

export function getTailToolExecutionState(
  messages: UnifiedMessage[]
): TailToolExecutionState | null {
  return buildTailToolExecutionState(messages)
}

export function buildRenderableMessageMeta(
  messages: UnifiedMessage[],
  streamingMessageId: string | null
): RenderableMessageMeta[] {
  return buildRenderableMessageMetaFromAnalysis(
    buildTranscriptStaticAnalysis(messages),
    streamingMessageId
  )
}

export function buildChatRenderableMessageMeta(
  messages: UnifiedMessage[],
  streamingMessageId: string | null,
  continueAssistantMessageId: string | null
): ChatRenderableMessageMeta[] {
  return buildChatRenderableMessageMetaFromAnalysis(
    buildTranscriptStaticAnalysis(messages),
    streamingMessageId,
    continueAssistantMessageId
  )
}
