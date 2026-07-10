import * as React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, ChevronDown, Loader2, Check, X } from 'lucide-react'
import type { ToolCallStatus } from '@renderer/lib/agent/types'
import type { ToolResultContent } from '@renderer/lib/api/types'
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

/** Generate a summary label for the collapsed group header */
function groupSummaryLabel(
  toolName: string,
  items: ToolCallGroupItem[],
  t: (key: string, opts?: Record<string, unknown>) => string
): string {
  const count = items.length
  // Collect unique short summaries for display
  const summaries = items.map((item) => inputSummary(item.name, item.input)).filter(Boolean)
  const uniqueSummaries = [...new Set(summaries)]

  if (toolName === 'Read') {
    const fileCount = uniqueSummaries.length
    return t('toolGroup.readFiles', { count: fileCount })
  }
  if (toolName === 'Grep' || toolName === 'Glob') {
    const summaries = items
      .map((item) => summarizeSearchToolOutput(item.name, item.output))
      .filter((item): item is NonNullable<typeof item> => !!item)

    if (summaries.length > 0) {
      const matchCount = summaries.reduce((sum, item) => sum + item.matchCount, 0)
      const fileCount = summaries.reduce((sum, item) => sum + item.fileCount, 0)
      const hasWarnings = summaries.some((item) => item.truncated || item.timedOut || !!item.error)
      return toolName === 'Grep'
        ? t('toolGroup.grepResults', {
            matches: matchCount,
            files: fileCount,
            suffix: hasWarnings ? '+' : ''
          })
        : t('toolGroup.globResults', { count: matchCount, suffix: hasWarnings ? '+' : '' })
    }

    return toolName === 'Grep'
      ? t('toolGroup.searchedPatterns', { count })
      : t('toolGroup.globbedPatterns', { count })
  }
  if (toolName === 'LS') {
    return t('toolGroup.listedDirs', { count })
  }
  if (COMMAND_TOOL_NAMES.has(toolName)) {
    return t('toolGroup.ranCommandsTitle', {
      count,
      defaultValue: t('toolGroup.ranCommands', { count })
    })
  }
  return `${toolName} × ${count}`
}

export function ToolCallGroup({
  toolName,
  items,
  children,
  collapsible = true
}: ToolCallGroupProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const status = groupStatus(items)
  const isActive = status === 'running' || status === 'streaming' || status === 'pending_approval'
  const shouldForceOpen = isActive || status === 'error' || status === 'canceled'

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

  const summaryLabel = groupSummaryLabel(toolName, items, t)
  const contentVisible = !collapsible || expanded
  const statusTone =
    status === 'error'
      ? 'text-destructive/85'
      : isActive
        ? 'text-sky-600 dark:text-sky-300'
        : 'text-muted-foreground'

  return (
    <div className="my-1.5">
      {collapsible ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className={`group flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] transition-colors hover:bg-muted/35 hover:text-foreground dark:hover:bg-white/[0.035] ${statusTone}`}
        >
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-lime-500/25 text-lime-600 dark:text-lime-400">
            {isActive ? (
              <Loader2 className="size-3 animate-spin text-sky-500" />
            ) : status === 'error' || status === 'canceled' ? (
              <X
                className={
                  status === 'error' ? 'size-3 text-destructive' : 'size-3 text-muted-foreground/60'
                }
              />
            ) : (
              <Check className="size-3 text-emerald-500" />
            )}
          </span>
          <span className="shrink-0 text-muted-foreground/55">{toolName}</span>
          <span className="shrink-0 text-muted-foreground/40">&gt;</span>
          <span className="shrink-0 font-mono font-medium text-foreground/82">x{items.length}</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground/60">({summaryLabel})</span>
          {expanded ? (
            <ChevronDown className="size-3 text-muted-foreground/60 transition-colors group-hover:text-foreground" />
          ) : (
            <ChevronRight className="size-3 text-muted-foreground/60 transition-colors group-hover:text-foreground" />
          )}
        </button>
      ) : null}

      <CollapsibleHeightPanel
        open={contentVisible}
        enabled={collapsible}
        className={
          collapsible
            ? 'ml-3 mt-1.5 overflow-hidden border-l border-border/50 pl-5 dark:border-white/[0.08]'
            : 'overflow-visible'
        }
      >
        {children}
      </CollapsibleHeightPanel>
    </div>
  )
}
