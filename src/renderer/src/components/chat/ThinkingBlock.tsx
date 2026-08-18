import { memo, useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { BrainCircuit, ChevronRight, ChevronDown } from 'lucide-react'
import Markdown from 'react-markdown'
import { MONO_FONT } from '@renderer/lib/constants'
import { useSettingsStore } from '@renderer/stores/settings-store'
import {
  getLiveOutputComponentClass,
  getLiveOutputShimmerClass
} from '@renderer/lib/live-output-animation'
import {
  openMarkdownHref,
  resolveLocalFilePath,
  openLocalFilePath,
  markdownUrlTransform,
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS
} from '@renderer/lib/preview/viewers/markdown-components'
import { CollapsibleHeightPanel } from './CollapsibleHeightPanel'

interface ThinkingBlockProps {
  thinking: string
  isStreaming?: boolean
  startedAt?: number
  completedAt?: number
}

function stripThinkingPreviewDecorators(line: string): string {
  return line
    .replace(/\r/g, '')
    .trim()
    .replace(/^(?:#{1,6}|[-*+]|\d+\.)\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/^\*{1,2}(.+?)\*{1,2}$/, '$1')
    .replace(/^_{1,2}(.+?)_{1,2}$/, '$1')
    .replace(/^`(.+?)`$/, '$1')
    .trim()
}

/** Latest non-empty thinking line for the collapsed live header. */
function getLiveThinkingPreview(thinking: string): string {
  let cursor = thinking.length
  while (cursor > 0) {
    const newline = thinking.lastIndexOf('\n', cursor - 1)
    const start = newline === -1 ? 0 : newline + 1
    const cleaned = stripThinkingPreviewDecorators(thinking.slice(start, cursor))
    if (cleaned) return cleaned
    if (newline === -1) break
    cursor = newline
  }
  return ''
}

export const ThinkingBlock = memo(function ThinkingBlock({
  thinking,
  isStreaming = false,
  startedAt,
  completedAt
}: ThinkingBlockProps): React.JSX.Element | null {
  const { t } = useTranslation('chat')
  const liveOutputAnimationStyle = useSettingsStore((s) => s.liveOutputAnimationStyle)
  const isThinking = isStreaming && !completedAt
  const liveComponentClassName = isThinking
    ? getLiveOutputComponentClass(liveOutputAnimationStyle)
    : ''
  const hasThinkingContent = thinking.trim().length > 0

  const [collapsed, setCollapsed] = useState(true)
  const [elapsedMs, setElapsedMs] = useState(() =>
    startedAt != null && completedAt != null ? Math.max(0, completedAt - startedAt) : 0
  )
  const fallbackStartedAtRef = useRef<number | undefined>(startedAt)

  useEffect(() => {
    if (!isThinking) setCollapsed(true)
  }, [isThinking])

  useEffect(() => {
    if (startedAt != null) fallbackStartedAtRef.current = startedAt
    else if (isThinking && fallbackStartedAtRef.current == null) {
      fallbackStartedAtRef.current = Date.now()
    }

    if (startedAt != null && completedAt != null) {
      setElapsedMs(Math.max(0, completedAt - startedAt))
      return
    }

    const start = startedAt ?? fallbackStartedAtRef.current
    if (!isThinking || start == null) return

    const tick = (): void => setElapsedMs(Math.max(0, Date.now() - start))
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [completedAt, isThinking, startedAt])

  const liveThinkingPreview = useMemo(
    () => (isThinking ? getLiveThinkingPreview(thinking) : ''),
    [isThinking, thinking]
  )

  if (!isThinking && !hasThinkingContent) {
    return null
  }

  const expanded = !isThinking && hasThinkingContent && !collapsed
  const elapsedSeconds = Math.max(0, Math.round(elapsedMs / 1000))
  const hasDuration = isThinking || elapsedMs > 0
  const durationLabel = isThinking
    ? elapsedSeconds > 0
      ? t('thinking.thinkingFor', { seconds: elapsedSeconds })
      : t('thinking.thinkingEllipsis')
    : hasDuration
      ? t('thinking.thoughtFor', { seconds: Math.max(1, elapsedSeconds) })
      : t('thinking.thoughts')
  const headerLabel = isThinking
    ? t('thinking.deepThinking', { defaultValue: 'Thinking deeply' })
    : t('thinking.deepThought', { defaultValue: 'Thought deeply' })
  const metaDisplay = isThinking
    ? liveThinkingPreview || durationLabel
    : hasDuration
      ? t('thinking.thoughtFor', { seconds: Math.max(1, elapsedSeconds) })
      : ''
  const headerTitle = liveThinkingPreview
    ? `${liveThinkingPreview} · ${durationLabel}`
    : durationLabel

  return (
    <div className={`my-4 min-w-0${liveComponentClassName ? ` ${liveComponentClassName}` : ''}`}>
      <button
        type="button"
        onClick={() => {
          if (isThinking) return
          setCollapsed((value) => !value)
        }}
        title={headerTitle}
        aria-expanded={expanded}
        className={`group inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md px-0.5 py-1 text-left text-[13px] text-muted-foreground/70 transition-colors hover:text-foreground${
          isThinking && liveThinkingPreview ? ' w-full' : ''
        }`}
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
          className={`shrink-0 font-medium ${
            isThinking ? getLiveOutputShimmerClass(liveOutputAnimationStyle) : ''
          }`}
        >
          {headerLabel}
        </span>
        {metaDisplay ? (
          <span
            className={`thinking-live-meta ${
              liveThinkingPreview ? 'min-w-0 flex-1 truncate' : 'shrink-0 tabular-nums'
            }`}
          >
            {metaDisplay}
          </span>
        ) : null}
        {expanded ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground/55 transition-colors group-hover:text-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground/55 transition-colors group-hover:text-foreground" />
        )}
      </button>

      <CollapsibleHeightPanel open={expanded} className="overflow-hidden">
        <div className="max-w-full px-0.5 pb-1 text-sm leading-7 text-muted-foreground/75">
          <div className="[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-1">
            <Markdown
              remarkPlugins={MARKDOWN_REMARK_PLUGINS}
              rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
              urlTransform={markdownUrlTransform}
              components={{
                a: ({ href, children, ...props }) => (
                  <a
                    {...props}
                    href={href || undefined}
                    className="text-primary underline underline-offset-2 hover:text-primary/80 break-all"
                    onClick={(event) => {
                      if (!href) {
                        event.preventDefault()
                        return
                      }
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
        </div>
      </CollapsibleHeightPanel>
    </div>
  )
})

ThinkingBlock.displayName = 'ThinkingBlock'
