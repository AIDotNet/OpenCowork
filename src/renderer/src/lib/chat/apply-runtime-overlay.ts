import type { ContentBlock, TextBlock, ThinkingBlock, UnifiedMessage } from '../api/types'
import type { ToolCallState, ToolCallStatus } from '../agent/types'
import type {
  AgentRuntimeProjection,
  RuntimeMessageOverlay,
  RuntimeRunOverlay,
  RuntimeToolCallOverlay
} from '../../../../shared/runtime-contracts/generated/contracts'

const ACTIVE_RUN_STATUSES = new Set(['queued', 'running'])

export type RuntimeOverlayView = {
  messages: UnifiedMessage[]
  streamingMessageId: string | null
  targetMessageId: string | null
  liveToolCallMap: Map<string, ToolCallState> | null
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
      isActive
    }
  }

  const targetId = streamingMessageId ?? overlayMessage?.messageId ?? null
  const existingIndex = targetId ? messages.findIndex((message) => message.id === targetId) : -1

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
      isActive
    }
  }

  if (streamingMessageId) {
    return {
      messages,
      streamingMessageId,
      targetMessageId: streamingMessageId,
      liveToolCallMap,
      isActive
    }
  }

  if (!isActive || !overlayMessage) {
    return {
      messages,
      streamingMessageId,
      targetMessageId: overlayMessage?.messageId ?? null,
      liveToolCallMap,
      isActive
    }
  }

  const virtual = overlayMessageToUnified(overlayMessage, overlayTools, overlay)
  return {
    messages: [...messages, virtual],
    streamingMessageId: virtual.id,
    targetMessageId: virtual.id,
    liveToolCallMap,
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
  const preserved = blocks.filter(
    (block) => block.type !== 'text' && block.type !== 'thinking' && block.type !== 'tool_use'
  )
  const existingHasTools = blocks.some((block) => block.type === 'tool_use')
  const existingText = messageText(message)
  const existingThinking = messageThinking(message)
  const overlayText = overlayMessage?.text ?? ''
  const overlayThinking = overlayMessage?.thinking ?? null

  if (existingHasTools) {
    return {
      ...message,
      content: mergeOverlayIntoStructuredTimeline(
        blocks,
        overlayText,
        overlayThinking,
        overlayTools
      ),
      _revision: overlay.projectionRevision
    }
  }

  const text = overlayText.length >= existingText.length ? overlayText : existingText
  const thinking = longerOptionalText(overlayThinking, existingThinking)
  const toolBlocks =
    overlayTools.length > 0 ? overlayTools.map(toolCallToBlock) : existingToolUseBlocks(message)

  return {
    ...message,
    content: buildBlocks(thinking, text, toolBlocks, preserved),
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
  blocks.push(...toolBlocks, ...preserved)
  return blocks
}

function toolCallToBlock(toolCall: RuntimeToolCallOverlay): ContentBlock {
  return {
    type: 'tool_use',
    id: toolCall.toolCallId,
    name: toolCall.toolName,
    input: toolCall.input ? { ...toolCall.input } : {}
  }
}

function messageText(message: UnifiedMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function messageThinking(message: UnifiedMessage): string | null {
  if (!Array.isArray(message.content)) return null
  const thinking = message.content
    .filter(
      (block): block is Extract<ContentBlock, { type: 'thinking' }> => block.type === 'thinking'
    )
    .map((block) => block.thinking)
    .join('')
  return thinking.length > 0 ? thinking : null
}

function existingContentBlocks(message: UnifiedMessage): ContentBlock[] {
  if (Array.isArray(message.content)) return message.content
  if (typeof message.content === 'string' && message.content) {
    return [{ type: 'text', text: message.content }]
  }
  return []
}

function existingToolUseBlocks(message: UnifiedMessage): ContentBlock[] {
  return existingContentBlocks(message).filter((block) => block.type === 'tool_use')
}

function mergeOverlayIntoStructuredTimeline(
  blocks: ContentBlock[],
  overlayText: string,
  overlayThinking: string | null,
  overlayTools: RuntimeToolCallOverlay[]
): ContentBlock[] {
  let next = blocks.map((block) => ({ ...block }))
  next = mergeOverlayToolsInPlace(next, overlayTools)
  next = appendOverlaySuffix(next, 'thinking', overlayThinking ?? '')
  next = appendOverlaySuffix(next, 'text', overlayText)
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

function mergeOverlayToolsInPlace(
  blocks: ContentBlock[],
  overlayTools: RuntimeToolCallOverlay[]
): ContentBlock[] {
  if (overlayTools.length === 0) return blocks

  const remaining = new Map(overlayTools.map((tool) => [tool.toolCallId, tool]))
  let next = blocks.map((block) => {
    if (block.type !== 'tool_use') return block
    const overlay = remaining.get(block.id)
    if (!overlay) return block
    remaining.delete(block.id)
    return {
      ...block,
      name: overlay.toolName || block.name,
      input: overlay.input ? { ...overlay.input } : block.input
    }
  })

  let sealedIncompleteThinking = false
  for (const overlay of overlayTools) {
    if (!remaining.has(overlay.toolCallId)) continue
    if (!sealedIncompleteThinking) {
      next = next.map((block) =>
        block.type === 'thinking' && block.completedAt == null
          ? { ...block, completedAt: block.startedAt ?? 1 }
          : block
      )
      sealedIncompleteThinking = true
    }
    next.push(toolCallToBlock(overlay))
    remaining.delete(overlay.toolCallId)
  }
  return next
}

function longerOptionalText(left: string | null, right: string | null): string | null {
  const leftText = left ?? ''
  const rightText = right ?? ''
  if (leftText.length === 0 && rightText.length === 0) return null
  return leftText.length >= rightText.length ? leftText : rightText
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
