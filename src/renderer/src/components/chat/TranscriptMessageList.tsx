import * as React from 'react'
import type { ToolResultContent, UnifiedMessage } from '@renderer/lib/api/types'
import type { ToolCallState } from '@renderer/lib/agent/types'
import { cn } from '@renderer/lib/utils'
import { MessageItem } from './MessageItem'
import {
  buildRenderableMessageMetaFromAnalysis,
  buildTranscriptStaticAnalysis
} from './transcript-utils'

interface TranscriptMessageListProps {
  messages: UnifiedMessage[]
  streamingMessageId?: string | null
  className?: string
  revisionKey?: string
  sessionId?: string | null
  liveToolCallMap?: Map<string, ToolCallState> | null
  autoScrollToBottom?: boolean
}

type ToolResultsLookup = Map<string, { content: ToolResultContent; isError?: boolean }>

interface TranscriptMessageRowProps {
  message: UnifiedMessage
  isStreaming: boolean
  isLastUserMessage: boolean
  isLastAssistantMessage: boolean
  toolResults?: ToolResultsLookup
  sessionId?: string | null
  liveToolCallMap?: Map<string, ToolCallState> | null
}

function isToolOnlyAssistantMessage(message: UnifiedMessage): boolean {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return false

  let hasToolUse = false
  for (const block of message.content) {
    if (block.type === 'tool_use') {
      hasToolUse = true
      continue
    }
    if (block.type === 'text' && !block.text.trim()) continue
    if (block.type === 'thinking' && !block.thinking.trim()) continue
    return false
  }

  return hasToolUse
}

const TranscriptMessageRow = React.memo(function TranscriptMessageRow({
  message,
  isStreaming,
  isLastUserMessage,
  isLastAssistantMessage,
  toolResults,
  sessionId,
  liveToolCallMap
}: TranscriptMessageRowProps): React.JSX.Element {
  const isToolOnly = isToolOnlyAssistantMessage(message)

  return (
    <div className={cn('mx-auto max-w-3xl px-4', isToolOnly ? 'pb-2' : 'pb-7')}>
      <MessageItem
        message={message}
        messageId={message.id}
        sessionId={sessionId}
        isStreaming={isStreaming}
        isLastUserMessage={isLastUserMessage}
        isLastAssistantMessage={isLastAssistantMessage}
        disableAnimation
        toolResults={toolResults}
        liveToolCallMap={liveToolCallMap}
        renderMode="transcript"
      />
    </div>
  )
})

function TranscriptMessageListInner({
  messages,
  streamingMessageId = null,
  className,
  revisionKey,
  sessionId = null,
  liveToolCallMap = null,
  autoScrollToBottom = false
}: TranscriptMessageListProps): React.JSX.Element {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const transcriptAnalysis = React.useMemo(() => {
    // SubAgent transcript blocks are updated in place while streaming; the revision signal
    // intentionally invalidates analysis even when the messages array identity is stable.
    void revisionKey
    return buildTranscriptStaticAnalysis(messages)
  }, [messages, revisionKey])
  const { messageLookup, toolResultsLookup } = transcriptAnalysis
  const renderableMeta = React.useMemo(
    () => buildRenderableMessageMetaFromAnalysis(transcriptAnalysis, streamingMessageId),
    [streamingMessageId, transcriptAnalysis]
  )

  React.useEffect(() => {
    if (!autoScrollToBottom) return
    const node = scrollRef.current
    if (!node) return

    const frame = window.requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight
    })
    return () => window.cancelAnimationFrame(frame)
  }, [autoScrollToBottom, renderableMeta.length, revisionKey, streamingMessageId])

  if (renderableMeta.length === 0) {
    return <div className="text-sm text-muted-foreground/70">No playback available</div>
  }

  return (
    <div
      ref={scrollRef}
      className={cn('not-prose h-[min(60vh,40rem)] min-h-[20rem] overflow-y-auto', className)}
    >
      {renderableMeta.map((meta) => {
        const message = messageLookup.get(meta.messageId)

        if (!message) {
          return null
        }

        return (
          <TranscriptMessageRow
            key={meta.messageId}
            message={message}
            isStreaming={streamingMessageId === message.id}
            isLastUserMessage={meta.isLastUserMessage}
            isLastAssistantMessage={meta.isLastAssistantMessage}
            toolResults={toolResultsLookup.get(message.id)}
            sessionId={sessionId}
            liveToolCallMap={liveToolCallMap}
          />
        )
      })}
    </div>
  )
}

function areTranscriptMessageListPropsEqual(
  prev: TranscriptMessageListProps,
  next: TranscriptMessageListProps
): boolean {
  return (
    prev.messages === next.messages &&
    prev.streamingMessageId === next.streamingMessageId &&
    prev.className === next.className &&
    prev.revisionKey === next.revisionKey &&
    prev.sessionId === next.sessionId &&
    prev.liveToolCallMap === next.liveToolCallMap &&
    prev.autoScrollToBottom === next.autoScrollToBottom
  )
}

export const TranscriptMessageList = React.memo(
  TranscriptMessageListInner,
  areTranscriptMessageListPropsEqual
)
