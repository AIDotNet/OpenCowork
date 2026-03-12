import * as React from 'react'
import type { ContentBlock, ToolResultContent, UnifiedMessage } from '@renderer/lib/api/types'
import { MessageItem } from '@renderer/components/chat/MessageItem'

interface RenderableMessage {
  messageId: string
  messageIndex: number
  isLastUserMessage: boolean
  toolResults?: Map<string, { content: ToolResultContent; isError?: boolean }>
}

function isToolResultOnlyUserMessage(message: UnifiedMessage): boolean {
  return (
    message.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.every((block) => block.type === 'tool_result')
  )
}

function isRealUserMessage(message: UnifiedMessage): boolean {
  return message.role === 'user' && !isToolResultOnlyUserMessage(message)
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

function buildRenderableMessages(messages: UnifiedMessage[]): RenderableMessage[] {
  let lastRealUserIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isRealUserMessage(messages[i])) {
      lastRealUserIndex = i
      break
    }
  }

  const assistantToolResults = new Map<
    number,
    Map<string, { content: ToolResultContent; isError?: boolean }>
  >()
  let trailingToolResults:
    | Map<string, { content: ToolResultContent; isError?: boolean }>
    | undefined

  for (let index = messages.length - 1; index >= 0; index--) {
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
      assistantToolResults.set(index, trailingToolResults)
    }
    trailingToolResults = undefined
  }

  const result: RenderableMessage[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (isToolResultOnlyUserMessage(message)) continue
    result.push({
      messageId: message.id,
      messageIndex: index,
      isLastUserMessage: index === lastRealUserIndex,
      toolResults: assistantToolResults.get(index)
    })
  }
  return result
}

export function RunTranscriptThread({
  messages
}: {
  messages: UnifiedMessage[]
}): React.JSX.Element {
  const renderableMessages = React.useMemo(() => buildRenderableMessages(messages), [messages])

  return (
    <div className="space-y-2">
      {renderableMessages.map((item) => {
        const message = messages[item.messageIndex]
        if (!message) return null
        return (
          <MessageItem
            key={message.id}
            message={message}
            messageId={message.id}
            isLastUserMessage={item.isLastUserMessage}
            toolResults={item.toolResults}
          />
        )
      })}
    </div>
  )
}
