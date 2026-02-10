import { useState, useEffect, useRef } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MONO_FONT } from '@renderer/lib/constants'

interface ThinkingBlockProps {
  thinking: string
  isStreaming?: boolean
  startedAt?: number
  completedAt?: number
}

export function ThinkingBlock({ thinking, isStreaming = false, startedAt, completedAt }: ThinkingBlockProps): React.JSX.Element {
  // isThinking: thinking is actively streaming (has content, no completedAt yet, message still streaming)
  const isThinking = isStreaming && thinking.length > 0 && !completedAt

  const [expanded, setExpanded] = useState(false)
  const wasThinkingRef = useRef(isThinking)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [liveElapsed, setLiveElapsed] = useState(0)

  // Live timer while thinking
  useEffect(() => {
    if (!isThinking || !startedAt) return
    const tick = (): void => setLiveElapsed(Math.round((Date.now() - startedAt) / 1000))
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [isThinking, startedAt])

  // Auto-expand while thinking, auto-collapse when thinking completes
  useEffect(() => {
    if (isThinking) {
      setExpanded(true)
    }
    if (wasThinkingRef.current && !isThinking) {
      setExpanded(false)
    }
    wasThinkingRef.current = isThinking
  }, [isThinking])

  // Auto-scroll to bottom while thinking is streaming
  useEffect(() => {
    if (isThinking && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [isThinking, thinking])

  // Compute duration label from persisted timestamps
  const persistedDuration = startedAt && completedAt
    ? Math.round((completedAt - startedAt) / 1000)
    : null

  const durationLabel = persistedDuration !== null
    ? `Thought for ${persistedDuration}s`
    : isThinking && liveElapsed > 0
      ? `Thinking for ${liveElapsed}s`
      : isThinking
        ? 'Thinking…'
        : 'Thoughts'

  return (
    <div className="my-5">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-sm text-muted-foreground/60 hover:text-muted-foreground transition-colors"
      >
        <span>{durationLabel}</span>
        {expanded
          ? <ChevronDown className="size-3.5" />
          : <ChevronRight className="size-3.5" />
        }
      </button>

      {expanded && (
        <div
          ref={scrollRef}
          className="mt-1.5 pl-0.5 text-sm text-muted-foreground/80 leading-relaxed max-h-80 overflow-y-auto"
        >
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              code: ({ children, className, ...props }) => {
                const isInline = !className
                if (isInline) {
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
              },
            }}
          >
            {thinking}
          </Markdown>
          {isThinking && <span className="inline-block w-1 h-3.5 bg-muted-foreground/40 animate-pulse ml-0.5" />}
        </div>
      )}
    </div>
  )
}
