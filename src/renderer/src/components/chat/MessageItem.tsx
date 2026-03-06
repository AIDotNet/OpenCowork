import * as React from 'react'
import type { UnifiedMessage, ToolResultContent } from '@renderer/lib/api/types'
import type { ToolCallState } from '@renderer/lib/agent/types'
import { UserMessage } from './UserMessage'
import { AssistantMessage } from './AssistantMessage'
import { Users, ChevronDown } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { SlideIn } from '@renderer/components/animate-ui'
import type { EditableUserMessageDraft } from '@renderer/lib/image-attachments'

interface MessageItemProps {
  message: UnifiedMessage
  isStreaming?: boolean
  isLastUserMessage?: boolean
  onEditUserMessage?: (draft: EditableUserMessageDraft) => void
  toolResults?: Map<string, { content: ToolResultContent; isError?: boolean }>
  liveToolCallMap?: Map<string, ToolCallState> | null
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Render a teammate notification as a collapsible bar with smooth transition */
function TeamNotification({ content }: { content: string }): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false)

  // Extract the teammate name from the prefix "[Team message from X]:"
  const match = content.match(/^\[Team message from (.+?)\]:\n?/)
  const from = match?.[1] ?? 'teammate'
  const body = match ? content.slice(match[0].length) : content

  return (
    <div className="my-4 rounded-lg border border-cyan-500/30 bg-cyan-500/5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left cursor-pointer"
      >
        <Users className="size-3.5 text-cyan-500 shrink-0" />
        <span className="text-[11px] font-medium text-cyan-600 dark:text-cyan-400">{from}</span>
        <span className="flex-1" />
        <ChevronDown
          className={`size-3.5 text-muted-foreground/50 shrink-0 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
        />
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-in-out"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <div className="border-t border-cyan-500/20 px-3 py-2 text-xs text-muted-foreground prose prose-sm dark:prose-invert max-w-none [&_h2]:text-sm [&_h2]:mt-3 [&_h2]:mb-1 [&_p]:my-1 [&_ul]:my-1 [&_li]:my-0">
            <Markdown remarkPlugins={[remarkGfm]}>{body}</Markdown>
          </div>
        </div>
      </div>
    </div>
  )
}

function MessageItemInner({
  message,
  isStreaming,
  isLastUserMessage,
  onEditUserMessage,
  toolResults,
  liveToolCallMap
}: MessageItemProps): React.JSX.Element | null {
  const inner = (() => {
    switch (message.role) {
      case 'user': {
        // Team notification messages (source: 'team') are rendered differently
        if (message.source === 'team') {
          return (
            <TeamNotification
              content={
                typeof message.content === 'string'
                  ? message.content
                  : JSON.stringify(message.content)
              }
            />
          )
        }
        // Regular user message - pass content directly to UserMessage component
        // UserMessage will handle ContentBlock[] extraction and system-remind filtering
        return (
          <UserMessage
            content={message.content}
            isLast={isLastUserMessage}
            onEdit={onEditUserMessage}
          />
        )
      }
      case 'assistant':
        return (
          <AssistantMessage
            content={message.content}
            isStreaming={isStreaming}
            usage={message.usage}
            toolResults={toolResults}
            liveToolCallMap={liveToolCallMap}
            msgId={message.id}
          />
        )
      default:
        return null
    }
  })()

  if (!inner) return null

  return (
    <SlideIn className="group/ts relative" direction="up" offset={10} duration={0.3}>
      <span className="absolute -left-12 top-1 hidden group-hover/ts:block text-[10px] text-muted-foreground/40 whitespace-nowrap">
        {formatTime(message.createdAt)}
      </span>
      {inner}
    </SlideIn>
  )
}

function areToolResultsEqual(
  a?: Map<string, { content: ToolResultContent; isError?: boolean }>,
  b?: Map<string, { content: ToolResultContent; isError?: boolean }>
): boolean {
  if (a === b) return true
  if (!a || !b) return !a && !b
  if (a.size !== b.size) return false

  for (const [id, value] of a) {
    const other = b.get(id)
    if (!other) return false
    if (other.isError !== value.isError) return false
    if (other.content !== value.content) return false
  }

  return true
}

function areEqual(prev: MessageItemProps, next: MessageItemProps): boolean {
  return (
    prev.message === next.message &&
    prev.isStreaming === next.isStreaming &&
    prev.isLastUserMessage === next.isLastUserMessage &&
    prev.onEditUserMessage === next.onEditUserMessage &&
    prev.liveToolCallMap === next.liveToolCallMap &&
    areToolResultsEqual(prev.toolResults, next.toolResults)
  )
}

export const MessageItem = React.memo(MessageItemInner, areEqual)
