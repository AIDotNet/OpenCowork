import * as React from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useTranslation } from 'react-i18next'
import { Archive } from 'lucide-react'
import type { UnifiedMessage } from '@renderer/lib/api/types'
import {
  extractUnifiedMessageText,
  getCompactSummaryDisplayText,
  isCompactBoundaryMessage,
  isCompactSummaryLikeMessage
} from '@renderer/lib/agent/context-compression'

function DetailChip({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
      {children}
    </span>
  )
}

export function ContextCompressionMessage({
  message
}: {
  message: UnifiedMessage
}): React.JSX.Element | null {
  const { t } = useTranslation('agent')
  const tokenFormatter = new Intl.NumberFormat()

  if (!isCompactBoundaryMessage(message) && !isCompactSummaryLikeMessage(message)) {
    return null
  }

  const content = (
    isCompactSummaryLikeMessage(message)
      ? getCompactSummaryDisplayText(message)
      : extractUnifiedMessageText(message)
  ).trim()
  if (!content) return null

  if (isCompactBoundaryMessage(message)) {
    const meta = message.meta?.compactBoundary

    return (
      <div className="my-2 rounded-md border border-amber-500/25 bg-amber-500/8 px-3 py-2.5 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-amber-800 dark:text-amber-200">
            <Archive className="size-3.5" />
            {t('contextCompression.boundaryTitle', {
              defaultValue: '\u4e0a\u4e0b\u6587\u538b\u7f29'
            })}
          </span>
          {meta?.trigger ? (
            <DetailChip>
              {meta.trigger === 'manual'
                ? t('contextCompression.boundaryManual', {
                    defaultValue: '\u624b\u52a8'
                  })
                : t('contextCompression.boundaryAuto', {
                    defaultValue: '\u81ea\u52a8'
                  })}
            </DetailChip>
          ) : null}
          {typeof meta?.messagesSummarized === 'number' && meta.messagesSummarized > 0 ? (
            <DetailChip>
              {t('contextCompression.boundarySummarized', {
                defaultValue: '\u5df2\u538b\u7f29 {{count}} \u6761\u6d88\u606f',
                count: meta.messagesSummarized
              })}
            </DetailChip>
          ) : null}
          {typeof meta?.preTokens === 'number' && meta.preTokens > 0 ? (
            <DetailChip>
              {t('contextCompression.boundaryPreTokens', {
                defaultValue: '\u89e6\u53d1\u65f6 {{tokens}} tokens',
                tokens: tokenFormatter.format(meta.preTokens)
              })}
            </DetailChip>
          ) : null}
        </div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{content}</p>
      </div>
    )
  }

  const meta = message.meta?.compactSummary

  return (
    <div className="my-2 rounded-md border border-amber-500/25 bg-amber-500/6 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-amber-800 dark:text-amber-200">
          <Archive className="size-3.5" />
          {t('contextCompression.summaryTitle', {
            defaultValue: '\u4e0a\u4e0b\u6587\u538b\u7f29\u6458\u8981'
          })}
        </span>
        {typeof meta?.messagesSummarized === 'number' && meta.messagesSummarized > 0 ? (
          <DetailChip>
            {t('contextCompression.summaryMessages', {
              defaultValue: '\u8f83\u65e9\u7684 {{count}} \u6761\u6d88\u606f',
              count: meta.messagesSummarized
            })}
          </DetailChip>
        ) : null}
        {meta?.recentMessagesPreserved ? (
          <DetailChip>
            {t('contextCompression.summaryRecentPreserved', {
              defaultValue: '\u8fd1\u671f\u6d88\u606f\u5df2\u4fdd\u7559'
            })}
          </DetailChip>
        ) : null}
      </div>
      <div className="mt-3 prose prose-sm max-w-none text-foreground dark:prose-invert [&_p]:my-2 [&_pre]:overflow-x-auto">
        <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
      </div>
    </div>
  )
}
