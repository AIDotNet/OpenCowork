import type { ContentBlock, TextBlock, ThinkingBlock, UnifiedMessage } from '../api/types'
import type { ToolCallState, ToolCallStatus } from '../agent/types'
import type {
  AgentRuntimeProjection,
  RuntimeMessageOverlay,
  RuntimeRunOverlay,
  RuntimeToolCallOverlay,
  RunStatus
} from '../../../../shared/runtime-contracts/generated/contracts'

const ACTIVE_RUN_STATUSES = new Set(['queued', 'running'])

// Same normalization the chat store applies to thinking deltas before they land in
// blocks. The overlay accumulates the raw provider stream, so without this the length
// comparison in appendOverlaySuffix sees a phantom "extra" on models that emit
// <think> markers and appends a duplicated tail block after the run settled.
function stripThinkTagMarkers(text: string): string {
  return text.replace(/<\s*\/?\s*think\s*>/gi, '')
}

export type RuntimeOverlayView = {
  messages: UnifiedMessage[]
  streamingMessageId: string | null
  targetMessageId: string | null
  liveToolCallMap: Map<string, ToolCallState> | null
  runStatus: RunStatus | null
  isActive: boolean
}

export function applyRuntimeOverlayToMessages(
  messages: UnifiedMessage[],
  overlay: AgentRuntimeProjection,
  streamingMessageId: string | null,
  sessionId: string | null
): RuntimeOverlayView {
  if (!sessionId) {
    return passthrough(messages, streamingMessageId)
  }

  const run = selectOverlayRun(overlay, sessionId)
  if (!run) {
    return passthrough(messages, streamingMessageId)
  }

  const overlayMessage =
    overlay.messages.find(
      (message) => message.runId === run.runId && message.sessionId === sessionId
    ) ?? null
  const overlayTools = overlay.toolCalls.filter(
    (toolCall) => toolCall.runId === run.runId && toolCall.sessionId === sessionId
  )
  const isActive = ACTIVE_RUN_STATUSES.has(run.status)
  const liveToolCallMap = overlayTools.length > 0 ? toLiveToolCallMap(overlayTools) : null

  if (!overlayMessage && overlayTools.length === 0) {
    return {
      messages,
      streamingMessageId,
      targetMessageId: streamingMessageId,
      liveToolCallMap,
      runStatus: run.status,
      isActive
    }
  }

  const targetId = streamingMessageId ?? overlayMessage?.messageId ?? null
  const existingIndex = targetId ? messages.findIndex((message) => message.id === targetId) : -1

  // While a local stream consumer is feeding this message (live run or reattach
  // replay), the store already holds the ordered timeline — every delta and tool
  // block lands in stream order. The overlay only knows cumulative text/thinking
  // strings, so merging it here can only reorder interleaved blocks, never improve
  // them. Keep the overlay's tool statuses (liveToolCallMap) and activity flag, and
  // reserve content merging for stale transcripts nobody is streaming into.
  if (existingIndex >= 0 && streamingMessageId && targetId === streamingMessageId) {
    return {
      messages,
      streamingMessageId,
      targetMessageId: targetId,
      liveToolCallMap,
      runStatus: run.status,
      isActive
    }
  }

  if (existingIndex >= 0) {
    const merged = mergeOverlayIntoMessage(
      messages[existingIndex],
      overlayMessage,
      overlayTools,
      overlay
    )
    const next = messages.slice()
    next[existingIndex] = merged
    return {
      messages: next,
      streamingMessageId: isActive ? merged.id : streamingMessageId,
      targetMessageId: merged.id,
      liveToolCallMap,
      runStatus: run.status,
      isActive
    }
  }

  if (streamingMessageId) {
    return {
      messages,
      streamingMessageId,
      targetMessageId: streamingMessageId,
      liveToolCallMap,
      runStatus: run.status,
      isActive
    }
  }

  if (!isActive || !overlayMessage) {
    return {
      messages,
      streamingMessageId,
      targetMessageId: overlayMessage?.messageId ?? null,
      liveToolCallMap,
      runStatus: run.status,
      isActive
    }
  }

  const virtual = overlayMessageToUnified(overlayMessage, overlayTools, overlay)
  return {
    messages: [...messages, virtual],
    streamingMessageId: virtual.id,
    targetMessageId: virtual.id,
    liveToolCallMap,
    runStatus: run.status,
    isActive
  }
}

function passthrough(
  messages: UnifiedMessage[],
  streamingMessageId: string | null
): RuntimeOverlayView {
  return {
    messages,
    streamingMessageId,
    targetMessageId: streamingMessageId,
    liveToolCallMap: null,
    runStatus: null,
    isActive: false
  }
}

function selectOverlayRun(
  overlay: AgentRuntimeProjection,
  sessionId: string
): RuntimeRunOverlay | null {
  const sessionRuns = overlay.runs.filter((run) => run.sessionId === sessionId)
  return (
    sessionRuns.find((run) => ACTIVE_RUN_STATUSES.has(run.status)) ??
    sessionRuns[sessionRuns.length - 1] ??
    null
  )
}

function mergeOverlayIntoMessage(
  message: UnifiedMessage,
  overlayMessage: RuntimeMessageOverlay | null,
  overlayTools: RuntimeToolCallOverlay[],
  overlay: AgentRuntimeProjection
): UnifiedMessage {
  const blocks = existingContentBlocks(message)
  const overlayText = overlayMessage?.text ?? ''
  const overlayThinking = overlayMessage?.thinking ?? null

  // Any resident content is an ordered timeline the merge must respect — rebuilding
  // wholesale as [thinking, text, tools] would flatten interleaved blocks back into
  // the wrong order. Only a message with no blocks at all can be built from scratch.
  const overlayMedia = overlayMediaBlocks(overlayMessage)

  if (blocks.length > 0) {
    return {
      ...message,
      content: mergeOverlayIntoStructuredTimeline(
        blocks,
        overlayText,
        overlayThinking,
        overlayTools,
        overlayMedia
      ),
      _revision: overlay.projectionRevision
    }
  }

  return {
    ...message,
    content: buildBlocks(
      overlayThinking,
      overlayText,
      overlayTools.map(toolCallToBlock),
      overlayMedia
    ),
    _revision: overlay.projectionRevision
  }
}

function overlayMessageToUnified(
  overlayMessage: RuntimeMessageOverlay,
  overlayTools: RuntimeToolCallOverlay[],
  overlay: AgentRuntimeProjection
): UnifiedMessage {
  return {
    id: overlayMessage.messageId,
    role: 'assistant',
    content: buildBlocks(
      overlayMessage.thinking,
      overlayMessage.text,
      overlayTools.map(toolCallToBlock),
      []
    ),
    createdAt: 0,
    _revision: overlay.projectionRevision
  }
}

function buildBlocks(
  thinking: string | null,
  text: string,
  toolBlocks: ContentBlock[],
  preserved: ContentBlock[]
): ContentBlock[] {
  const blocks: ContentBlock[] = []
  if (thinking) {
    blocks.push({ type: 'thinking', thinking })
  }
  if (text) {
    blocks.push({ type: 'text', text })
  }
  // Media before tools, on the same reasoning the suffix merge uses: within an
  // iteration the model produces its content first and calls tools after.
  blocks.push(...preserved, ...toolBlocks)
  return blocks
}

/**
 * Content blocks the overlay carries that the flat text and thinking strings
 * cannot express — generated images, image failures, web-search activity.
 */
function overlayMediaBlocks(overlayMessage: RuntimeMessageOverlay | null): ContentBlock[] {
  if (!overlayMessage?.blocks?.length) return []
  return overlayMessage.blocks.filter(isRenderableBlock) as unknown as ContentBlock[]
}

function isRenderableBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false
  const type = (block as { type?: unknown }).type
  return type === 'image' || type === 'image_error' || type === 'web_search'
}

/** Media blocks the resident timeline does not already contain. */
function missingMediaBlocks(blocks: ContentBlock[], overlayMedia: ContentBlock[]): ContentBlock[] {
  if (overlayMedia.length === 0) return []
  const present = new Set(blocks.map(mediaIdentity).filter((key): key is string => key !== null))
  return overlayMedia.filter((block) => {
    const key = mediaIdentity(block)
    return key === null || !present.has(key)
  })
}

/**
 * Identity used to tell an overlay media block from one already in the
 * transcript. Images are identified by their source, search chips by their id.
 */
function mediaIdentity(block: ContentBlock): string | null {
  if (block.type === 'image') {
    const source = block.source
    return `image:${source.url ?? source.filePath ?? source.data?.slice(0, 64) ?? ''}`
  }
  if (block.type === 'web_search') {
    return `web_search:${block.id ?? block.query}`
  }
  if (block.type === 'image_error') {
    return `image_error:${block.code}:${block.message}`
  }
  return null
}

function toolCallToBlock(toolCall: RuntimeToolCallOverlay): ContentBlock {
  return {
    type: 'tool_use',
    id: toolCall.toolCallId,
    name: toolCall.toolName,
    input: toolCall.input ? { ...toolCall.input } : {}
  }
}

function existingContentBlocks(message: UnifiedMessage): ContentBlock[] {
  if (Array.isArray(message.content)) return message.content
  if (typeof message.content === 'string' && message.content) {
    return [{ type: 'text', text: message.content }]
  }
  return []
}

function mergeOverlayIntoStructuredTimeline(
  blocks: ContentBlock[],
  overlayText: string,
  overlayThinking: string | null,
  overlayTools: RuntimeToolCallOverlay[],
  overlayMedia: ContentBlock[] = []
): ContentBlock[] {
  let next = blocks.map((block) => ({ ...block }))
  const missingTools = updateOverlayToolsInPlace(next, overlayTools)
  // Suffixes land before overlay-only tools: within an iteration the model emits its
  // narration/thinking first and calls tools after, so when both are missing from the
  // resident timeline the prose belongs ahead of the new tool cards.
  next = appendOverlaySuffix(next, 'thinking', stripThinkTagMarkers(overlayThinking ?? ''))
  next = appendOverlaySuffix(next, 'text', overlayText)
  // Media the transcript already holds is left alone; only blocks this window
  // never saw are added, on the same content-before-tools reasoning.
  next = [...next, ...missingMediaBlocks(next, overlayMedia)]
  next = appendMissingOverlayTools(next, missingTools)
  return next
}

function appendOverlaySuffix(
  blocks: ContentBlock[],
  kind: 'text' | 'thinking',
  overlayValue: string
): ContentBlock[] {
  if (!overlayValue) return blocks

  const existing = blocks
    .filter((block) => block.type === kind)
    .map((block) =>
      kind === 'thinking' ? (block as ThinkingBlock).thinking : (block as TextBlock).text
    )
    .join('')
  if (overlayValue.length <= existing.length) return blocks

  const extra = overlayValue.slice(existing.length)
  if (!extra) return blocks

  const last = blocks[blocks.length - 1]
  if (kind === 'thinking') {
    if (last?.type === 'thinking' && last.completedAt == null) {
      return [...blocks.slice(0, -1), { ...last, thinking: `${last.thinking}${extra}` }]
    }
    const sealed = blocks.map((block) =>
      block.type === 'thinking' && block.completedAt == null
        ? { ...block, completedAt: block.startedAt ?? 1 }
        : block
    )
    return [...sealed, { type: 'thinking', thinking: extra }]
  }

  if (last?.type === 'text') {
    return [...blocks.slice(0, -1), { ...last, text: `${last.text}${extra}` }]
  }
  return [...blocks, { type: 'text', text: extra }]
}

// Refresh name/input of tool blocks the timeline already holds; return overlay tools
// with no matching block, in overlay (stream) order, for the caller to append.
function updateOverlayToolsInPlace(
  blocks: ContentBlock[],
  overlayTools: RuntimeToolCallOverlay[]
): RuntimeToolCallOverlay[] {
  if (overlayTools.length === 0) return []

  const remaining = new Map(overlayTools.map((tool) => [tool.toolCallId, tool]))
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block.type !== 'tool_use') continue
    const overlay = remaining.get(block.id)
    if (!overlay) continue
    remaining.delete(block.id)
    blocks[index] = {
      ...block,
      name: overlay.toolName || block.name,
      input: overlay.input ? { ...overlay.input } : block.input
    }
  }
  return overlayTools.filter((tool) => remaining.has(tool.toolCallId))
}

function appendMissingOverlayTools(
  blocks: ContentBlock[],
  missingTools: RuntimeToolCallOverlay[]
): ContentBlock[] {
  if (missingTools.length === 0) return blocks

  const sealed = blocks.map((block) =>
    block.type === 'thinking' && block.completedAt == null
      ? { ...block, completedAt: block.startedAt ?? 1 }
      : block
  )
  return [...sealed, ...missingTools.map(toolCallToBlock)]
}

function toLiveToolCallMap(toolCalls: RuntimeToolCallOverlay[]): Map<string, ToolCallState> {
  const map = new Map<string, ToolCallState>()
  for (const toolCall of toolCalls) {
    map.set(toolCall.toolCallId, {
      id: toolCall.toolCallId,
      name: toolCall.toolName,
      input: toolCall.input ? { ...toolCall.input } : {},
      status: toToolCallStatus(toolCall.status),
      output: toolCall.output ?? undefined,
      requiresApproval: toolCall.status === 'pending_approval',
      sessionId: toolCall.sessionId
    })
  }
  return map
}

function toToolCallStatus(status: string): ToolCallStatus {
  switch (status) {
    case 'streaming':
    case 'pending_approval':
    case 'running':
    case 'completed':
    case 'error':
    case 'canceled':
      return status
    case 'cancelled':
      return 'canceled'
    default:
      return 'running'
  }
}
