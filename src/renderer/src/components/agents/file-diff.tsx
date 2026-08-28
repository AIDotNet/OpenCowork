'use client'
// beui.dev/components/agents/file-diff

import { Check, ChevronDown, Copy } from 'lucide-react'
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
        'text-[11px] font-medium tabular-nums',
        type === 'added'
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-rose-600 dark:text-rose-400'
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
        className="group flex min-h-7 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none transition-colors duration-150 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/[0.035]"
      >
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground/50">{language}</span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[12.5px] text-foreground/75',
            streaming && 'tool-name-live-pulse tool-name-live-pulse--running'
          )}
        >
          {file}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <ChangeCount value={additions} type="added" />
          <ChangeCount value={deletions} type="removed" />
        </span>
        <motion.span
          aria-hidden="true"
          animate={{ rotate: currentOpen ? 0 : -90 }}
          transition={reduce ? { duration: 0 } : SPRING_SWAP}
          className="shrink-0 text-muted-foreground/35 transition-colors group-hover:text-muted-foreground/70"
        >
          <ChevronDown className="size-3.5" />
        </motion.span>
      </button>

      <AgentDisclosure id={contentId} role="region" aria-labelledby={triggerId} open={currentOpen}>
        <div className="ml-2 border-l border-border/45 pl-3 pt-1.5 dark:border-white/[0.07]">
          <div className="overflow-hidden rounded-lg border border-border/50 bg-muted/15 dark:border-white/[0.07] dark:bg-white/[0.02]">
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
