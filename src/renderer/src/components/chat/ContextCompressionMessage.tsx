import * as React from 'react'
import Markdown from 'react-markdown'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Archive, ChevronDown } from 'lucide-react'
import type { UnifiedMessage } from '@renderer/lib/api/types'
import {
  getCompactSummaryDisplayText,
  isCompactSummaryLikeMessage
} from '@renderer/lib/agent/context-compression'
import {
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS
} from '@renderer/lib/preview/viewers/markdown-components'

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

export function ContextCompressionMessage({
  message
}: {
  message: UnifiedMessage
}): React.JSX.Element | null {
  const { t } = useTranslation('agent')
  const [expanded, setExpanded] = React.useState(false)

  if (!isCompactSummaryLikeMessage(message)) {
    return null
  }

  const content = getCompactSummaryDisplayText(message).trim()
  if (!content) return null

  const meta = message.meta?.compactSummary
  const preview = buildSummaryPreview(content)
  const toggleLabel = expanded
    ? t('contextCompression.summaryCollapse', { defaultValue: 'Collapse summary' })
    : t('contextCompression.summaryExpand', { defaultValue: 'Expand summary' })

  return (
    <div className="my-2 rounded-md border border-border bg-muted/25 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <Archive className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[12px] font-medium text-foreground">
              {t('contextCompression.summaryTitle', {
                defaultValue: 'Compressed Context Summary'
              })}
            </span>
            {typeof meta?.messagesSummarized === 'number' && meta.messagesSummarized > 0 ? (
              <span className="rounded border border-border/70 bg-background/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {t('contextCompression.summaryMessages', {
                  defaultValue: 'Earlier {{count}} messages',
                  count: meta.messagesSummarized
                })}
              </span>
            ) : null}
            {meta?.recentMessagesPreserved ? (
              <span className="rounded border border-border/70 bg-background/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {t('contextCompression.summaryRecentPreserved', {
                  defaultValue: 'Recent messages preserved'
                })}
              </span>
            ) : null}
            {meta?.summarizerFailed ? (
              <span className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
                <AlertTriangle className="size-3" />
                {t('contextCompression.summaryFallbackWarning', {
                  defaultValue: 'Summary failed; original context restored'
                })}
              </span>
            ) : null}
          </div>
          {!expanded && preview ? (
            <div className="mt-1 line-clamp-2 text-[12px] leading-5 text-muted-foreground">
              {preview}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={toggleLabel}
          title={toggleLabel}
        >
          <ChevronDown
            className={`size-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
        </button>
      </div>
      {expanded ? (
        <div className="mt-2 border-t border-border/70 pt-2 prose prose-sm max-w-none text-[13px] leading-relaxed text-foreground dark:prose-invert [&_h1]:mb-2 [&_h1]:mt-1 [&_h1]:text-base [&_h2]:mb-1.5 [&_h2]:mt-3 [&_h2]:text-sm [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-sm [&_li]:my-0.5 [&_p]:my-1.5 [&_pre]:overflow-x-auto">
          <Markdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} rehypePlugins={MARKDOWN_REHYPE_PLUGINS}>
            {content}
          </Markdown>
        </div>
      ) : null}
    </div>
  )
}
