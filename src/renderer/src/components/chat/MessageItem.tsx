import * as React from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Users, ChevronDown } from 'lucide-react'
import { SlideIn } from '@renderer/components/animate-ui'
import { UserMessage } from './UserMessage'
import { AssistantMessage } from './AssistantMessage'
import { ContextCompressionMessage } from './ContextCompressionMessage'
import type { UnifiedMessage, ToolResultContent } from '@renderer/lib/api/types'
import type { RequestRetryState, ToolCallState } from '@renderer/lib/agent/types'
import type { EditableUserMessageDraft } from '@renderer/lib/image-attachments'
import type { OrchestrationRun } from '@renderer/lib/orchestration/types'
import { isCompactSummaryLikeMessage } from '@renderer/lib/agent/context-compression'

type MessageRenderMode = 'default' | 'transcript' | 'static'

interface MessageItemProps {
  message: UnifiedMessage
  messageId: string
  sessionId?: string | null
  isStreaming?: boolean
  isLastUserMessage?: boolean
  isLastAssistantMessage?: boolean
  showContinue?: boolean
  disableAnimation?: boolean
  onRetryAssistantMessage?: (messageId: string) => void
  onContinueAssistantMessage?: () => void
  onEditUserMessage?: (messageId: string, draft: EditableUserMessageDraft) => void
  onDeleteMessage?: (messageId: string) => void
  toolResults?: Map<string, { content: ToolResultContent; isError?: boolean }>
  liveToolCallMap?: Map<string, ToolCallState> | null
  renderMode?: MessageRenderMode
  orchestrationRun?: OrchestrationRun | null
  hiddenToolUseIds?: Set<string>
  requestRetryState?: RequestRetryState | null
}

// NOTE: getContentSignal / getToolUseInputSignal used to be called by areEqual for
// every render, scanning the tail of each message's content on every memo check. With
// multiple agents streaming in parallel that turned into a hot path (N messages × deep
// scans × RAF tick). The store now stamps a monotonic `_revision` counter on any message
// it mutates (bumpMessageRevision in chat-store.ts), so areEqual can do a single integer
// compare instead. These helpers are kept only for messages that somehow arrive without
// a _revision (e.g. legacy DB rows loaded before the field existed).
function getContentFallbackSignal(content: UnifiedMessage['content']): string {
  if (typeof content === 'string') return `s:${content.length}`
  return `a:${content.length}`
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function TeamNotification({ content }: { content: string }): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false)
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
  messageId,
  sessionId,
  isStreaming,
  isLastUserMessage,
  isLastAssistantMessage,
  showContinue,
  disableAnimation,
  onRetryAssistantMessage,
  onContinueAssistantMessage,
  onEditUserMessage,
  onDeleteMessage,
  toolResults,
  liveToolCallMap,
  renderMode = 'default',
  orchestrationRun,
  hiddenToolUseIds,
  requestRetryState
}: MessageItemProps): React.JSX.Element | null {
  if (message.id !== messageId) return null

  const inner = (() => {
    switch (message.role) {
      case 'user': {
        if (isCompactSummaryLikeMessage(message)) {
          return <ContextCompressionMessage message={message} />
        }
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
        return (
          <UserMessage
            messageId={message.id}
            content={message.content}
            isLast={isLastUserMessage}
            onEdit={onEditUserMessage}
            onDelete={onDeleteMessage}
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
            msgId={message.id}
            sessionId={sessionId}
            showRetry
            showContinue={showContinue && isLastAssistantMessage}
            isLastAssistantMessage={isLastAssistantMessage}
            onRetry={onRetryAssistantMessage}
            onContinue={onContinueAssistantMessage}
            onDelete={onDeleteMessage}
            liveToolCallMap={liveToolCallMap}
            renderMode={renderMode}
            orchestrationRun={orchestrationRun}
            hiddenToolUseIds={hiddenToolUseIds}
            requestRetryState={isLastAssistantMessage ? requestRetryState : null}
            requestDebugInfo={message.debugInfo}
          />
        )
      case 'system':
        return <ContextCompressionMessage message={message} />
      default:
        return null
    }
  })()

  if (!inner) return null

  if (disableAnimation) {
    return (
      <div className="group/ts relative">
        <span className="absolute -left-12 top-1 hidden group-hover/ts:block text-[10px] text-muted-foreground/40 whitespace-nowrap">
          {formatTime(message.createdAt)}
        </span>
        {inner}
      </div>
    )
  }

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

function areStringSetsEqual(a?: Set<string>, b?: Set<string>): boolean {
  if (a === b) return true
  if (!a || !b) return !a && !b
  if (a.size !== b.size) return false

  for (const value of a) {
    if (!b.has(value)) return false
  }

  return true
}

function areRequestRetryStatesEqual(
  a?: RequestRetryState | null,
  b?: RequestRetryState | null
): boolean {
  if (a === b) return true
  if (!a || !b) return !a && !b
  return (
    a.attempt === b.attempt &&
    a.maxAttempts === b.maxAttempts &&
    a.delayMs === b.delayMs &&
    a.statusCode === b.statusCode &&
    a.reason === b.reason
  )
}

function areEqual(prev: MessageItemProps, next: MessageItemProps): boolean {
  // Fast path: same object reference => nothing to compare.
  if (prev.message === next.message) {
    return (
      prev.messageId === next.messageId &&
      prev.sessionId === next.sessionId &&
      prev.isStreaming === next.isStreaming &&
      prev.isLastUserMessage === next.isLastUserMessage &&
      prev.isLastAssistantMessage === next.isLastAssistantMessage &&
      prev.showContinue === next.showContinue &&
      prev.disableAnimation === next.disableAnimation &&
      prev.onRetryAssistantMessage === next.onRetryAssistantMessage &&
      prev.onContinueAssistantMessage === next.onContinueAssistantMessage &&
      prev.onEditUserMessage === next.onEditUserMessage &&
      prev.onDeleteMessage === next.onDeleteMessage &&
      areToolResultsEqual(prev.toolResults, next.toolResults) &&
      prev.liveToolCallMap === next.liveToolCallMap &&
      prev.renderMode === next.renderMode &&
      prev.orchestrationRun === next.orchestrationRun &&
      areStringSetsEqual(prev.hiddenToolUseIds, next.hiddenToolUseIds) &&
      areRequestRetryStatesEqual(prev.requestRetryState, next.requestRetryState)
    )
  }

  // Revision-based equality: any mutation to the message in chat-store bumps _revision,
  // so comparing (_revision, usage-revision, id) is sufficient without scanning content.
  const prevRev = prev.message._revision
  const nextRev = next.message._revision
  const bothHaveRevision = prevRev !== undefined && nextRev !== undefined

  const contentEqual = bothHaveRevision
    ? prevRev === nextRev
    : getContentFallbackSignal(prev.message.content) ===
      getContentFallbackSignal(next.message.content)

  // Usage signature still needs a structural compare (small object, cheap).
  const prevUsageSignal = prev.message.usage
    ? `${prev.message.usage.inputTokens}:${prev.message.usage.billableInputTokens ?? ''}:${prev.message.usage.outputTokens}:${prev.message.usage.cacheCreationTokens ?? 0}:${prev.message.usage.cacheCreation5mTokens ?? 0}:${prev.message.usage.cacheCreation1hTokens ?? 0}:${prev.message.usage.cacheReadTokens ?? 0}:${prev.message.usage.reasoningTokens ?? 0}:${prev.message.usage.totalDurationMs ?? 0}`
    : ''
  const nextUsageSignal = next.message.usage
    ? `${next.message.usage.inputTokens}:${next.message.usage.billableInputTokens ?? ''}:${next.message.usage.outputTokens}:${next.message.usage.cacheCreationTokens ?? 0}:${next.message.usage.cacheCreation5mTokens ?? 0}:${next.message.usage.cacheCreation1hTokens ?? 0}:${next.message.usage.cacheReadTokens ?? 0}:${next.message.usage.reasoningTokens ?? 0}:${next.message.usage.totalDurationMs ?? 0}`
    : ''

  return (
    prev.messageId === next.messageId &&
    prev.sessionId === next.sessionId &&
    prev.isStreaming === next.isStreaming &&
    prev.isLastUserMessage === next.isLastUserMessage &&
    prev.isLastAssistantMessage === next.isLastAssistantMessage &&
    prev.showContinue === next.showContinue &&
    prev.disableAnimation === next.disableAnimation &&
    prev.onRetryAssistantMessage === next.onRetryAssistantMessage &&
    prev.onContinueAssistantMessage === next.onContinueAssistantMessage &&
    prev.onEditUserMessage === next.onEditUserMessage &&
    prev.onDeleteMessage === next.onDeleteMessage &&
    prev.message.role === next.message.role &&
    prev.message.createdAt === next.message.createdAt &&
    prev.message.source === next.message.source &&
    prev.message.debugInfo === next.message.debugInfo &&
    contentEqual &&
    prevUsageSignal === nextUsageSignal &&
    areToolResultsEqual(prev.toolResults, next.toolResults) &&
    prev.liveToolCallMap === next.liveToolCallMap &&
    prev.renderMode === next.renderMode &&
    prev.orchestrationRun === next.orchestrationRun &&
    areStringSetsEqual(prev.hiddenToolUseIds, next.hiddenToolUseIds) &&
    areRequestRetryStatesEqual(prev.requestRetryState, next.requestRetryState)
  )
}

export const MessageItem = React.memo(MessageItemInner, areEqual)
