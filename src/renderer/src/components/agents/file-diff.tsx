'use client'
// beui.dev/components/agents/file-diff

import { Check, ChevronDown, Copy, FileCode2, LoaderCircle } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import {
  type AgentCodeLanguage,
  AgentCodeLine,
  useAgentCodeTokens
} from '@renderer/components/agents/agent-code'
import { AgentDisclosure } from '@renderer/components/agents/agent-disclosure'
import { SPRING_PRESS, SPRING_SWAP } from '@renderer/lib/ease'
import { cn } from '@renderer/lib/utils'

export type FileDiffStatus = 'streaming' | 'complete'
export type FileDiffLineType = 'added' | 'removed' | 'context'

export interface FileDiffLine {
  id: string
  type?: FileDiffLineType
  oldLine?: number
  newLine?: number
  content: string
}

export interface FileDiffProps {
  file: ReactNode
  lines: FileDiffLine[]
  status?: FileDiffStatus
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  maxHeight?: number
  language?: AgentCodeLanguage
  copyText?: string
  onCopy?: () => void | Promise<void>
  className?: string
}

function ChangeCount({ value, type }: { value: number; type: 'added' | 'removed' }) {
  if (!value) return null
  return (
    <span
      className={cn(
        'rounded border px-1 py-0.2 font-mono text-[10px] font-medium tabular-nums',
        type === 'added'
          ? 'border-emerald-500/25 bg-emerald-500/[0.08] text-emerald-600 dark:text-emerald-400'
          : 'border-rose-500/25 bg-rose-500/[0.08] text-rose-600 dark:text-rose-400'
      )}
    >
      {type === 'added' ? '+' : '−'}
      {value}
    </span>
  )
}

export function FileDiff({
  file,
  lines,
  status = 'streaming',
  open,
  defaultOpen = true,
  onOpenChange,
  maxHeight = 220,
  language = 'typescript',
  copyText,
  onCopy,
  className
}: FileDiffProps) {
  const reduce = useReducedMotion() ?? false
  const baseId = useId()
  const triggerId = `${baseId}-trigger`
  const contentId = `${baseId}-content`
  const viewportRef = useRef<HTMLDivElement>(null)
  const copyTimer = useRef<number | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const [internalOpen, setInternalOpen] = useState(defaultOpen)
  const currentOpen = open ?? internalOpen
  const streaming = status === 'streaming'
  const additions = lines.filter((line) => line.type === 'added').length
  const deletions = lines.filter((line) => line.type === 'removed').length
  const canCopy = Boolean(copyText || onCopy)
  const code = lines.map((line) => line.content).join('\n')
  const tokens = useAgentCodeTokens(code, language)

  const setOpen = useCallback(
    (next: boolean) => {
      if (open === undefined) setInternalOpen(next)
      onOpenChange?.(next)
    },
    [onOpenChange, open]
  )

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current)
    },
    []
  )

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || !currentOpen || !streaming) return

    const frame = requestAnimationFrame(() => {
      if (viewport.scrollHeight <= viewport.clientHeight) return
      if (typeof viewport.scrollTo === 'function') {
        viewport.scrollTo({
          top: viewport.scrollHeight,
          behavior: reduce ? 'auto' : 'smooth'
        })
      } else {
        viewport.scrollTop = viewport.scrollHeight
      }
    })
    return () => cancelAnimationFrame(frame)
  })

  const handleCopy = useCallback(async () => {
    if (onCopy) await onCopy()
    else if (copyText) await navigator.clipboard?.writeText(copyText)

    setCopied(true)
    if (copyTimer.current) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600)
  }, [copyText, onCopy])

  return (
    <div data-state={status} aria-busy={streaming} className={cn('w-full text-sm', className)}>
      <button
        id={triggerId}
        type="button"
        aria-expanded={currentOpen}
        aria-controls={contentId}
        onClick={() => setOpen(!currentOpen)}
        className="group flex min-h-8 w-full items-center gap-2 rounded-lg px-2 py-1 text-left outline-none transition-all duration-150 hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/[0.04]"
      >
        <FileCode2 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground/70" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/85">{file}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          <ChangeCount value={additions} type="added" />
          <ChangeCount value={deletions} type="removed" />
        </span>
        <span className="grid size-4 shrink-0 place-items-center text-muted-foreground/60">
          {streaming ? (
            <LoaderCircle
              aria-label="Applying changes"
              className={cn('size-3.5', !reduce && 'animate-spin')}
            />
          ) : (
            <Check aria-label="Changes applied" className="size-3.5 text-emerald-500" />
          )}
        </span>
        <motion.span
          aria-hidden="true"
          animate={{ rotate: currentOpen ? 0 : -90 }}
          transition={reduce ? { duration: 0 } : SPRING_SWAP}
          className="shrink-0 text-muted-foreground/45 transition-colors group-hover:text-muted-foreground"
        >
          <ChevronDown className="size-3.5" />
        </motion.span>
      </button>

      <AgentDisclosure id={contentId} role="region" aria-labelledby={triggerId} open={currentOpen}>
        <div className="ml-3.5 border-l border-border/50 pl-4.5 pt-1.5 dark:border-white/[0.08]">
          <div className="overflow-hidden rounded-xl border border-border/60 bg-muted/20 dark:border-white/[0.08] dark:bg-white/[0.02]">
            <div
              ref={viewportRef}
              data-slot="file-diff-viewport"
              aria-live="polite"
              className="scrollbar-hide overflow-auto"
              style={{ maxHeight }}
            >
              <div className="font-mono text-xs leading-5">
                <span className="sr-only">File changes</span>
                {lines.map((line, index) => {
                  const type = line.type ?? 'context'
                  return (
                    <div
                      key={line.id}
                      className={cn(
                        'grid grid-cols-[2.25rem_2.25rem_1rem_minmax(0,1fr)] transition-colors',
                        type === 'added' && 'border-l-2 border-l-emerald-500 bg-emerald-500/[0.08]',
                        type === 'removed' && 'border-l-2 border-l-rose-500 bg-rose-500/[0.08]',
                        type === 'context' && 'border-l-2 border-l-transparent'
                      )}
                    >
                      <span className="select-none pr-2 text-right tabular-nums text-muted-foreground/40">
                        {line.oldLine}
                      </span>
                      <span className="select-none pr-2 text-right tabular-nums text-muted-foreground/40">
                        {line.newLine}
                      </span>
                      <span
                        className={cn(
                          'select-none text-center text-muted-foreground/45',
                          type === 'added' && 'text-emerald-600 dark:text-emerald-400',
                          type === 'removed' && 'text-rose-600 dark:text-rose-400'
                        )}
                      >
                        {type === 'added' ? '+' : type === 'removed' ? '−' : ''}
                      </span>
                      <AgentCodeLine
                        code={line.content}
                        tokens={tokens?.[index]}
                        className="min-w-0 whitespace-pre px-1.5"
                      />
                    </div>
                  )
                })}
              </div>
            </div>

            {canCopy ? (
              <div className="flex justify-end border-t border-border/40 bg-muted/20 px-2 py-1 dark:border-white/[0.04]">
                <motion.button
                  type="button"
                  aria-label={copied ? 'Copied' : 'Copy diff'}
                  title={copied ? 'Copied' : 'Copy diff'}
                  onClick={handleCopy}
                  whileTap={reduce ? undefined : { scale: 0.9 }}
                  transition={SPRING_PRESS}
                  className="grid size-6 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-background/80 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {copied ? (
                    <Check className="size-3.5 text-emerald-500" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </motion.button>
              </div>
            ) : null}
          </div>
        </div>
      </AgentDisclosure>
    </div>
  )
}
