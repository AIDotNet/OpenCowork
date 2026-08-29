import { memo, useState, useEffect, useMemo, useRef } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import Markdown from 'react-markdown'
import { cn } from '@renderer/lib/utils'
import { MONO_FONT } from '@renderer/lib/constants'
import { thoughtLabel } from '@renderer/lib/chat/execution-labels'
import { getLiveThinkingPreview } from '@renderer/lib/chat/thinking-preview'
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

const TICKER_EASE = [0.4, 0, 0.2, 1] as const

function ThinkingLiveTicker({
  text,
  generation,
  animate
}: {
  text: string
  generation: number
  animate: boolean
}): React.JSX.Element {
  return (
    <span className="thinking-live-ticker" aria-live="polite">
      <AnimatePresence initial={false}>
        <motion.span
          key={generation}
          className="thinking-live-ticker-line"
          initial={animate ? { y: '70%', opacity: 0 } : false}
          animate={{ y: 0, opacity: 1 }}
          exit={animate ? { y: '-70%', opacity: 0 } : undefined}
          transition={animate ? { duration: 0.28, ease: TICKER_EASE } : { duration: 0 }}
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

export const ThinkingBlock = memo(function ThinkingBlock({
  thinking,
  isStreaming = false,
  startedAt,
  completedAt
}: ThinkingBlockProps): React.JSX.Element | null {
  const liveOutputAnimationStyle = useSettingsStore((s) => s.liveOutputAnimationStyle)
  const animationsEnabled = useSettingsStore((s) => s.animationsEnabled)
  const reduceMotion = useReducedMotion() ?? false
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
    // Fold the live stream back to a compact Thought line when it finishes.
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
    () => (isThinking ? getLiveThinkingPreview(thinking) : { text: '', generation: 0 }),
    [isThinking, thinking]
  )

  if (!isThinking && !hasThinkingContent) {
    return null
  }

  const expanded = hasThinkingContent && !collapsed
  const elapsedSeconds = Math.max(0, Math.round(elapsedMs / 1000))
  const hasDuration = isThinking || elapsedMs > 0
  // The execution transcript reads in English in every locale — see `execution-labels`.
  const durationLabel = isThinking
    ? elapsedSeconds > 0
      ? thoughtLabel(elapsedSeconds)
      : '…'
    : hasDuration
      ? thoughtLabel(Math.max(1, elapsedSeconds))
      : ''
  const headerLabel = isThinking ? 'Thinking' : 'Thought'
  const showTicker = isThinking && !expanded && liveThinkingPreview.text.length > 0
  const headerTitle = liveThinkingPreview.text
    ? `${liveThinkingPreview.text} · ${durationLabel}`
    : durationLabel

  return (
    <div
      className={cn(
        'flex min-w-0 flex-col',
        !expanded && 'execution-process-line',
        liveComponentClassName
      )}
    >
      <button
        type="button"
        onClick={() => {
          if (!hasThinkingContent) return
          setCollapsed((value) => !value)
        }}
        title={headerTitle}
        aria-expanded={expanded}
        className={cn(
          'group flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md bg-transparent px-1.5 py-0 text-left text-[12.5px] leading-snug text-muted-foreground/70 transition-colors hover:bg-transparent hover:text-foreground',
          (isThinking || showTicker) && 'w-full'
        )}
      >
        <span
          className={`shrink-0 font-medium ${
            isThinking ? getLiveOutputShimmerClass(liveOutputAnimationStyle) : 'text-foreground/75'
          }`}
        >
          {headerLabel}
        </span>
        {showTicker ? (
          <ThinkingLiveTicker
            text={liveThinkingPreview.text}
            generation={liveThinkingPreview.generation}
            animate={animationsEnabled && !reduceMotion}
          />
        ) : null}
        {durationLabel ? (
          <span
            className={cn(
              'thinking-live-meta shrink-0 tabular-nums',
              showTicker || isThinking ? 'ml-auto' : null
            )}
          >
            {durationLabel}
          </span>
        ) : null}
        {hasThinkingContent ? (
          expanded ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground/35 transition-colors group-hover:text-muted-foreground/70" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground/35 transition-colors group-hover:text-muted-foreground/70" />
          )
        ) : null}
      </button>

      <CollapsibleHeightPanel
        open={expanded}
        collapseMotion="scroll-up"
        className="overflow-hidden"
      >
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
