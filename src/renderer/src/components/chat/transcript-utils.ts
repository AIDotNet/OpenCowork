import type { ContentBlock, ToolResultContent, UnifiedMessage } from '@renderer/lib/api/types'
import { isEditableUserMessage } from '@renderer/lib/image-attachments'

export interface RenderableMessageMeta {
  messageId: string
  isLastUserMessage: boolean
  isLastAssistantMessage: boolean
}

export function isToolResultOnlyUserMessage(message: UnifiedMessage): boolean {
  return (
    message.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.every((block) => block.type === 'tool_result')
  )
}

function isRealUserMessage(message: UnifiedMessage): boolean {
  return isEditableUserMessage(message)
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

export function getToolResultsLookup(
  messages: UnifiedMessage[]
): Map<string, Map<string, { content: ToolResultContent; isError?: boolean }>> {
  const next = new Map<string, Map<string, { content: ToolResultContent; isError?: boolean }>>()
  let trailingToolResults: Map<string, { content: ToolResultContent; isError?: boolean }> | undefined

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (isToolResultOnlyUserMessage(message)) {
      if (!trailingToolResults) trailingToolResults = new Map()
      collectToolResults(message.content as ContentBlock[], trailingToolResults)
      continue
    }

    if (
      message.role === 'assistant' &&
      Array.isArray(message.content) &&
      trailingToolResults &&
      trailingToolResults.size > 0
    ) {
      next.set(message.id, trailingToolResults)
    }
    trailingToolResults = undefined
  }

  return next
}

export function buildRenderableMessageMeta(
  messages: UnifiedMessage[],
  streamingMessageId: string | null
): RenderableMessageMeta[] {
  let lastRealUserIndex = -1
  let lastAssistantIndex = -1
  if (!streamingMessageId) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (isRealUserMessage(messages[index])) {
        lastRealUserIndex = index
        break
      }
    }
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (isToolResultOnlyUserMessage(message)) continue
    if (message.role === 'assistant') {
      lastAssistantIndex = index
    }
    break
  }

  const result: RenderableMessageMeta[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (isToolResultOnlyUserMessage(message)) continue

    result.push({
      messageId: message.id,
      isLastUserMessage: index === lastRealUserIndex,
      isLastAssistantMessage: index === lastAssistantIndex
    })
  }

  return result
}
