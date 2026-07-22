import { memo, useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { BrainCircuit, ChevronRight, ChevronDown } from 'lucide-react'
import Markdown from 'react-markdown'
import { MONO_FONT } from '@renderer/lib/constants'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { normalizeLanguageCode } from '@renderer/lib/i18n-language'
import {
  getLiveOutputComponentClass,
  getLiveOutputCursorClass,
  getLiveOutputShimmerClass,
  getLiveOutputSurfaceClass
} from '@renderer/lib/live-output-animation'
import {
  openMarkdownHref,
  resolveLocalFilePath,
  openLocalFilePath,
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS
} from '@renderer/lib/preview/viewers/markdown-components'
import { useStreamingRenderPool } from '@renderer/hooks/use-typewriter'
import { CollapsibleHeightPanel } from './CollapsibleHeightPanel'

interface ThinkingBlockProps {
  thinking: string
  isStreaming?: boolean
  startedAt?: number
  completedAt?: number
}

export const ThinkingBlock = memo(function ThinkingBlock({
  thinking,
  isStreaming = false,
  startedAt,
  completedAt
}: ThinkingBlockProps): React.JSX.Element | null {
  const { t, i18n } = useTranslation('chat')
  const liveOutputAnimationStyle = useSettingsStore((s) => s.liveOutputAnimationStyle)
  const isThinking = isStreaming && !completedAt
  const renderPool = useStreamingRenderPool(thinking, isThinking, liveOutputAnimationStyle)
  const liveComponentClassName = isThinking
    ? getLiveOutputComponentClass(liveOutputAnimationStyle)
    : ''
  const hasThinkingContent = thinking.trim().length > 0
  const defaultCollapsed = !isThinking && hasThinkingContent

  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const [liveElapsed, setLiveElapsed] = useState(0)
  const contentRef = useRef<HTMLDivElement>(null)

  // Live timer while thinking
  useEffect(() => {
    if (!isThinking || !startedAt) return
    const tick = (): void => setLiveElapsed(Math.round((Date.now() - startedAt) / 1000))
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [isThinking, startedAt])

  useEffect(() => {
    if (!isThinking || !hasThinkingContent || !contentRef.current) return
    contentRef.current.scrollTop = contentRef.current.scrollHeight
  }, [hasThinkingContent, isThinking, renderPool.text])

  if (!isThinking && !hasThinkingContent) {
    return null
  }

  const expanded = isThinking || (hasThinkingContent && !collapsed)
  const compactLanguage = normalizeLanguageCode(i18n.language)

  // Compute duration label from persisted timestamps
  const persistedDuration =
    startedAt && completedAt ? Math.round((completedAt - startedAt) / 1000) : null

  const durationLabel =
    persistedDuration !== null
      ? t('thinking.thoughtFor', { seconds: persistedDuration })
      : isThinking && liveElapsed > 0
        ? t('thinking.thinkingFor', { seconds: liveElapsed })
        : isThinking
          ? t('thinking.thinkingEllipsis')
          : t('thinking.thoughts')
  const headerLabel = isThinking
    ? t('thinking.deepThinking', { defaultValue: 'Thinking deeply' })
    : t('thinking.deepThought', { defaultValue: 'Thought deeply' })

  const compactElapsedLabel =
    liveElapsed > 0
      ? compactLanguage === 'ko'
        ? `${liveElapsed}초`
        : compactLanguage === 'zh' || compactLanguage === 'ja'
          ? `${liveElapsed} 秒`
          : `${liveElapsed}s`
      : ''

  return (
    <div className={`my-4 min-w-0${liveComponentClassName ? ` ${liveComponentClassName}` : ''}`}>
      <button
        onClick={() => {
          if (isThinking) return
          setCollapsed((v) => !v)
        }}
        title={durationLabel}
        className="group inline-flex max-w-full items-center gap-1.5 rounded-md px-0.5 py-1 text-left text-[13px] text-muted-foreground/70 transition-colors hover:text-foreground"
      >
        <span
          className={`flex size-5 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/20 text-violet-600 transition-colors group-hover:border-violet-500/30 group-hover:text-violet-500 dark:border-white/[0.08] dark:bg-white/[0.025] dark:text-violet-400 ${
            isThinking
              ? 'shadow-[0_0_0_1px_rgba(139,92,246,0.08)] animate-pulse'
              : 'shadow-[0_0_0_1px_rgba(139,92,246,0.04)]'
          }`}
        >
          <BrainCircuit className="size-3" />
        </span>
        <span
          className={`min-w-0 truncate font-medium ${
            isThinking ? getLiveOutputShimmerClass(liveOutputAnimationStyle) : ''
          }`}
        >
          {headerLabel}
        </span>
        {expanded ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground/55 transition-colors group-hover:text-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground/55 transition-colors group-hover:text-foreground" />
        )}
      </button>

      <CollapsibleHeightPanel open={expanded} className="overflow-hidden">
        <div className="max-w-full px-0.5 pb-1 text-sm leading-7 text-muted-foreground/75">
          {hasThinkingContent ? (
            <div ref={contentRef} className="max-h-80 overflow-y-auto">
              {isThinking ? (
                <div
                  className={`${getLiveOutputSurfaceClass(liveOutputAnimationStyle)} whitespace-pre-wrap break-words leading-relaxed`}
                  data-render-pool-size={renderPool.poolSize}
                  data-rendered-length={renderPool.renderedLength}
                  data-target-length={renderPool.targetLength}
                >
                  {renderPool.text}
                  <span className={getLiveOutputCursorClass(liveOutputAnimationStyle)} />
                </div>
              ) : (
                <div className="[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-1">
                  <Markdown
                    remarkPlugins={MARKDOWN_REMARK_PLUGINS}
                    rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
                    components={{
                      a: ({ href, children, ...props }) => (
                        <a
                          {...props}
                          href={href}
                          className="text-primary underline underline-offset-2 hover:text-primary/80 break-all"
                          onClick={(event) => {
                            if (!href) return
                            const handled = openMarkdownHref(href)
                            if (handled) event.preventDefault()
                          }}
                        >
                          {children}
                        </a>
                      ),
                      code: ({ children, className, ...props }) => {
                        const isInline = !className
                        if (isInline) {
                          const code = String(children ?? '').replace(/\n$/, '')
                          const resolvedPath = resolveLocalFilePath(code)
                          if (resolvedPath) {
                            return (
                              <button
                                type="button"
                                className="cursor-pointer rounded bg-muted px-1 py-0.5 text-xs font-mono text-primary underline-offset-2 hover:underline"
                                style={{ fontFamily: MONO_FONT }}
                                title={resolvedPath}
                                onClick={() => {
                                  void openLocalFilePath(code)
                                }}
                              >
                                {children}
                              </button>
                            )
                          }
                          return (
                            <code
                              className="rounded bg-muted px-1 py-0.5 text-xs font-mono"
                              style={{ fontFamily: MONO_FONT }}
                              {...props}
                            >
                              {children}
                            </code>
                          )
                        }
                        return (
                          <code className={className} style={{ fontFamily: MONO_FONT }} {...props}>
                            {children}
                          </code>
                        )
                      }
                    }}
                  >
                    {thinking}
                  </Markdown>
                </div>
              )}
            </div>
          ) : (
            <div role="status" aria-live="polite" className="thinking-live-status">
              <span
                className={`thinking-live-label ${getLiveOutputShimmerClass(liveOutputAnimationStyle)}`}
              >
                {t('thinking.pending', { defaultValue: 'Thinking' })}
              </span>
              {liveElapsed > 0 && (
                <span className="thinking-live-meta" aria-label={durationLabel}>
                  {compactElapsedLabel}
                </span>
              )}
            </div>
          )}
        </div>
      </CollapsibleHeightPanel>
    </div>
  )
})

ThinkingBlock.displayName = 'ThinkingBlock'
