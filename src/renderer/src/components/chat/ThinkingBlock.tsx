import { memo, useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, ChevronDown } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MONO_FONT } from '@renderer/lib/constants'
import { useSettingsStore } from '@renderer/stores/settings-store'
import {
  getLiveOutputCursorClass,
  getLiveOutputDotClass,
  getLiveOutputSurfaceClass,
  getLiveOutputThinkingClass
} from '@renderer/lib/live-output-animation'
import {
  openMarkdownHref,
  resolveLocalFilePath,
  openLocalFilePath
} from '@renderer/lib/preview/viewers/markdown-components'
import { motion, AnimatePresence } from 'motion/react'

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
}: ThinkingBlockProps): React.JSX.Element {
  const { t, i18n } = useTranslation('chat')
  const liveOutputAnimationStyle = useSettingsStore((s) => s.liveOutputAnimationStyle)
  const isThinking = isStreaming && !completedAt
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
  }, [hasThinkingContent, isThinking, thinking])

  const expanded = isThinking || (hasThinkingContent && !collapsed)

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

  const compactElapsedLabel =
    liveElapsed > 0
      ? i18n.language.startsWith('zh')
        ? `${liveElapsed} 秒`
        : `${liveElapsed}s`
      : ''

  return (
    <div className="my-5">
      <button
        onClick={() => {
          if (isThinking) return
          setCollapsed((v) => !v)
        }}
        className="flex items-center gap-1 text-sm text-muted-foreground/60 hover:text-muted-foreground transition-colors group"
      >
        <span className="group-hover:text-primary/80 transition-colors">{durationLabel}</span>
        {expanded ? (
          <ChevronDown className="size-3.5 transition-transform duration-200" />
        ) : (
          <ChevronRight className="size-3.5 transition-transform duration-200" />
        )}
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className="overflow-hidden"
          >
            <div className="mt-1.5 text-sm text-muted-foreground/80 leading-relaxed">
              {hasThinkingContent ? (
                <div
                  ref={contentRef}
                  className="max-h-80 overflow-y-auto border-l border-border/45 pl-2.5"
                >
                  {isThinking ? (
                    <div
                      className={`${getLiveOutputSurfaceClass(liveOutputAnimationStyle)} whitespace-pre-wrap break-words leading-relaxed`}
                    >
                      {thinking}
                      <span className={getLiveOutputCursorClass(liveOutputAnimationStyle)} />
                    </div>
                  ) : (
                    <Markdown
                      remarkPlugins={[remarkGfm]}
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
                  )}
                </div>
              ) : (
                <div
                  role="status"
                  aria-live="polite"
                  className={`thinking-live-status ${getLiveOutputThinkingClass(liveOutputAnimationStyle)}`}
                >
                  <span className="thinking-live-dots" aria-hidden="true">
                    <span
                      className={getLiveOutputDotClass(liveOutputAnimationStyle)}
                      style={{ animationDelay: '0ms' }}
                    />
                    <span
                      className={getLiveOutputDotClass(liveOutputAnimationStyle)}
                      style={{ animationDelay: '150ms' }}
                    />
                    <span
                      className={getLiveOutputDotClass(liveOutputAnimationStyle)}
                      style={{ animationDelay: '300ms' }}
                    />
                  </span>
                  <span className="thinking-live-label">
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
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
})

ThinkingBlock.displayName = 'ThinkingBlock'
