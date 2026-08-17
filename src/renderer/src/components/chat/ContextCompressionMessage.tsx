import * as React from 'react'
import Markdown from 'react-markdown'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ChevronDown, MessageSquarePlus, Scissors } from 'lucide-react'
import type { UnifiedMessage } from '@renderer/lib/api/types'
import {
  getCompactSummaryDisplayText,
  isCompactSummaryLikeMessage
} from '@renderer/lib/agent/context-compression'
import {
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS
} from '@renderer/lib/preview/viewers/markdown-components'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useChatStore } from '@renderer/stores/chat-store'

function buildSummaryPreview(content: string): string {
  const firstMeaningfulLine = content
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)

  return (firstMeaningfulLine ?? content)
    .replace(/^#{1,6}\s+/, '')
    .replace(/[*_`[\]]/g, '')
    .trim()
}

/**
 * The compaction point in the transcript.
 *
 * Everything above this line is still on screen but no longer reaches the model
 * — the summary below stands in for it. The summary message itself carries only
 * the summary text, so the divider and its counts come from the recorded
 * compaction cut (`compactedMessageCount`) or, for sessions compacted by an
 * older build, from the legacy marker meta.
 */
export function ContextCompressionMessage({
  message,
  compactedMessageCount
}: {
  message: UnifiedMessage
  compactedMessageCount?: number
}): React.JSX.Element | null {
  const { t } = useTranslation('agent')
  const [expanded, setExpanded] = React.useState(false)
  const isRecordedSummary = typeof compactedMessageCount === 'number'

  if (!isRecordedSummary && !isCompactSummaryLikeMessage(message)) {
    return null
  }

  const content = getCompactSummaryDisplayText(message).trim()
  if (!content) return null

  const meta = message.meta?.compactSummary
  const summarizedCount = isRecordedSummary
    ? compactedMessageCount
    : (meta?.messagesSummarized ?? 0)
  const preview = buildSummaryPreview(content)
  const toggleLabel = expanded
    ? t('contextCompression.summaryCollapse', { defaultValue: 'Collapse summary' })
    : t('contextCompression.summaryExpand', { defaultValue: 'Expand summary' })
  const continueLabel = t('contextCompression.continueInNewSession', {
    defaultValue: 'Continue in a new session'
  })
  const dividerLabel =
    summarizedCount > 0
      ? t('contextCompression.dividerWithCount', {
          defaultValue: 'Context compressed · {{count}} earlier messages summarized',
          count: summarizedCount
        })
      : t('contextCompression.divider', { defaultValue: 'Context compressed' })

  const handleContinueInNewSession = (): void => {
    const chatStore = useChatStore.getState()
    const sessionId = chatStore.activeSessionId
    if (!sessionId) return
    const sourceSession = chatStore.sessions.find((session) => session.id === sessionId)
    void chatStore.continueSessionFromCompactSummary(
      sessionId,
      message.id,
      sourceSession
        ? t('contextCompression.continuationSessionTitle', {
            defaultValue: '{{title}} · Compressed',
            title: sourceSession.title
          })
        : undefined
    )
  }

  return (
    <div className="my-4">
      <div className="flex items-center gap-2">
        <div className="h-px flex-1 bg-gradient-to-r from-transparent to-amber-500/40" />
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          title={toggleLabel}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-700 transition-colors hover:bg-amber-500/20 dark:text-amber-300"
        >
          <Scissors className="size-3" />
          {dividerLabel}
          <ChevronDown className={`size-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleContinueInNewSession}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label={continueLabel}
            >
              <MessageSquarePlus className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{continueLabel}</TooltipContent>
        </Tooltip>
        <div className="h-px flex-1 bg-gradient-to-l from-transparent to-amber-500/40" />
      </div>
      {meta?.summarizerFailed ? (
        <div className="mt-2 flex items-center justify-center gap-1 text-[10px] text-amber-700 dark:text-amber-300">
          <AlertTriangle className="size-3" />
          {t('contextCompression.summaryFallbackWarning', {
            defaultValue: 'Summary failed; original context restored'
          })}
        </div>
      ) : null}
      {!expanded && preview ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-2 block w-full text-left"
          aria-label={toggleLabel}
        >
          <span className="line-clamp-2 text-[12px] leading-5 text-muted-foreground">
            {preview}
          </span>
        </button>
      ) : null}
      {expanded ? (
        <div className="mt-2 rounded-md border border-border bg-muted/25 px-3 py-2.5 prose prose-sm max-w-none text-[13px] leading-relaxed text-foreground dark:prose-invert [&_h1]:mb-2 [&_h1]:mt-1 [&_h1]:text-base [&_h2]:mb-1.5 [&_h2]:mt-3 [&_h2]:text-sm [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-sm [&_li]:my-0.5 [&_p]:my-1.5 [&_pre]:overflow-x-auto">
          <Markdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} rehypePlugins={MARKDOWN_REHYPE_PLUGINS}>
            {content}
          </Markdown>
        </div>
      ) : null}
    </div>
  )
}
