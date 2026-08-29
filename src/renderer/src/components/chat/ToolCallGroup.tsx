import * as React from 'react'
import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import type { ToolCallStatus } from '@renderer/lib/agent/types'
import type { ToolResultContent } from '@renderer/lib/api/types'
import { countLabel, filesLabel, matchesLabel } from '@renderer/lib/chat/execution-labels'
import { inputSummary, summarizeSearchToolOutput } from './tool-call-summary'
import { CollapsibleHeightPanel } from './CollapsibleHeightPanel'

const COMMAND_TOOL_NAMES = new Set(['Bash', 'Shell', 'PowerShell'])

interface ToolCallGroupItem {
  id: string
  name: string
  input: Record<string, unknown>
  output?: ToolResultContent
  status: ToolCallStatus | 'completed'
  error?: string
  startedAt?: number
  completedAt?: number
}

interface ToolCallGroupProps {
  toolName: string
  items: ToolCallGroupItem[]
  children: React.ReactNode
  collapsible?: boolean
}

/** Compute a group-level status from individual items */
function groupStatus(items: ToolCallGroupItem[]): ToolCallStatus | 'completed' {
  if (items.some((i) => i.status === 'error')) return 'error'
  if (items.some((i) => i.status === 'running')) return 'running'
  if (items.some((i) => i.status === 'streaming')) return 'streaming'
  if (items.some((i) => i.status === 'pending_approval')) return 'pending_approval'
  if (items.some((i) => i.status === 'canceled')) return 'canceled'
  if (items.every((i) => i.status === 'completed')) return 'completed'
  return 'running'
}

/**
 * Summary for the collapsed group header. Like the rest of the execution transcript this
 * reads in English in every locale — see `execution-labels`.
 */
function groupSummaryLabel(toolName: string, items: ToolCallGroupItem[]): string {
  const count = items.length

  if (toolName === 'Read') {
    const uniqueTargets = new Set(
      items.map((item) => inputSummary(item.name, item.input)).filter(Boolean)
    )
    return `Read ${countLabel(uniqueTargets.size, 'file')}`
  }
  if (toolName === 'Grep' || toolName === 'Glob') {
    const summaries = items
      .map((item) => summarizeSearchToolOutput(item.name, item.output))
      .filter((item): item is NonNullable<typeof item> => !!item)

    if (summaries.length > 0) {
      const matchCount = summaries.reduce((sum, item) => sum + item.matchCount, 0)
      const fileCount = summaries.reduce((sum, item) => sum + item.fileCount, 0)
      const hasWarnings = summaries.some((item) => item.truncated || item.timedOut || !!item.error)
      const suffix = hasWarnings ? '+' : ''
      return toolName === 'Grep'
        ? `${matchesLabel(matchCount, fileCount)}${suffix}`
        : `${filesLabel(matchCount)}${suffix}`
    }

    return countLabel(count, 'search', 'searches')
  }
  if (toolName === 'LS') return countLabel(count, 'dir listing')
  if (COMMAND_TOOL_NAMES.has(toolName)) return `Ran ${countLabel(count, 'command')}`
  return `${toolName} × ${count}`
}

export function ToolCallGroup({
  toolName,
  items,
  children,
  collapsible = true
}: ToolCallGroupProps): React.JSX.Element {
  const status = groupStatus(items)
  const isActive = status === 'running' || status === 'streaming' || status === 'pending_approval'
  // Active tools no longer force the group open; only failures do.
  const shouldForceOpen = status === 'error' || status === 'canceled'

  const [expanded, setExpanded] = useState(shouldForceOpen || !collapsible)
  const previousCollapsibleRef = React.useRef(collapsible)

  React.useEffect(() => {
    if (!collapsible) {
      setExpanded(true)
    } else if (!previousCollapsibleRef.current) {
      setExpanded(shouldForceOpen)
    } else if (shouldForceOpen) {
      setExpanded(true)
    }

    previousCollapsibleRef.current = collapsible
  }, [collapsible, shouldForceOpen])

  const summaryLabel = groupSummaryLabel(toolName, items)
  const contentVisible = !collapsible || expanded
  const statusTone = status === 'error' ? 'text-destructive/85' : 'text-muted-foreground'

  return (
    <div>
      {collapsible ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            'group flex w-full items-center gap-1.5 rounded-md px-1.5 py-0 text-left text-[12.5px] leading-snug transition-colors duration-150 hover:bg-muted/40 dark:hover:bg-white/[0.035]',
            statusTone
          )}
        >
          <span
            className={cn(
              'shrink-0 font-medium tracking-tight',
              isActive
                ? 'tool-name-live-pulse tool-name-live-pulse--running'
                : status === 'error'
                  ? 'text-destructive/85'
                  : 'text-foreground/75'
            )}
          >
            {toolName}
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/50">
            ×{items.length}
          </span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground/60">{summaryLabel}</span>
          <ChevronDown
            className={cn(
              'size-3 shrink-0 text-muted-foreground/35 transition-transform duration-200 group-hover:text-muted-foreground/70',
              !expanded && '-rotate-90'
            )}
          />
        </button>
      ) : null}

      <CollapsibleHeightPanel
        open={contentVisible}
        enabled={collapsible}
        collapseMotion="scroll-up"
        className={
          collapsible
            ? 'ml-2 mt-0.5 overflow-hidden border-l border-border/45 pl-3 dark:border-white/[0.07]'
            : 'overflow-visible'
        }
      >
        {children}
      </CollapsibleHeightPanel>
    </div>
  )
}
