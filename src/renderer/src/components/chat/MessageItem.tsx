import type { UnifiedMessage } from '@renderer/lib/api/types'
import { UserMessage } from './UserMessage'
import { AssistantMessage } from './AssistantMessage'

interface MessageItemProps {
  message: UnifiedMessage
  isStreaming?: boolean
  isLastUserMessage?: boolean
  onEditUserMessage?: (newContent: string) => void
  toolResults?: Map<string, { content: string; isError?: boolean }>
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function MessageItem({ message, isStreaming, isLastUserMessage, onEditUserMessage, toolResults }: MessageItemProps): React.JSX.Element | null {
  const inner = (() => {
    switch (message.role) {
      case 'user':
        return (
          <UserMessage
            content={typeof message.content === 'string' ? message.content : '[complex content]'}
            isLast={isLastUserMessage}
            onEdit={onEditUserMessage}
          />
        )
      case 'assistant':
        return <AssistantMessage content={message.content} isStreaming={isStreaming} usage={message.usage} toolResults={toolResults} />
      default:
        return null
    }
  })()

  if (!inner) return null

  return (
    <div className="group/ts relative">
      <span className="absolute -left-12 top-1 hidden group-hover/ts:block text-[10px] text-muted-foreground/40 whitespace-nowrap">
        {formatTime(message.createdAt)}
      </span>
      {inner}
    </div>
  )
}
