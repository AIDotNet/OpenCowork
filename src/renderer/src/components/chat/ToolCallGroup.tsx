import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, ChevronDown, Loader2 } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import type { ToolCallStatus } from '@renderer/lib/agent/types'
import type { ToolResultContent } from '@renderer/lib/api/types'
import { ToolStatusDot } from './ToolCallCard'
import { inputSummary, summarizeSearchToolOutput } from './tool-call-summary'

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
}

/** Compute a group-level status from individual items */
function groupStatus(items: ToolCallGroupItem[]): ToolCallStatus | 'completed' {
  if (items.some((i) => i.status === 'error')) return 'error'
  if (items.some((i) => i.status === 'running')) return 'running'
  if (items.some((i) => i.status === 'streaming')) return 'streaming'
  if (items.some((i) => i.status === 'pending_approval')) return 'pending_approval'
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
        ? t('toolGroup.grepResults', { matches: matchCount, files: fileCount, suffix: hasWarnings ? '+' : '' })
        : t('toolGroup.globResults', { count: matchCount, suffix: hasWarnings ? '+' : '' })
    }

    return toolName === 'Grep'
      ? t('toolGroup.searchedPatterns', { count })
      : t('toolGroup.globbedPatterns', { count })
  }
  if (toolName === 'LS') {
    return t('toolGroup.listedDirs', { count })
  }
  if (toolName === 'Bash') {
    return t('toolGroup.ranCommands', { count })
  }
  return `${toolName} × ${count}`
}

export function ToolCallGroup({
  toolName,
  items,
  children
}: ToolCallGroupProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const status = groupStatus(items)
  const isActive = status === 'running' || status === 'streaming' || status === 'pending_approval'

  const [expanded, setExpanded] = useState(true)

  const summaryLabel = groupSummaryLabel(toolName, items, t)

  return (
    <div className="my-1">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ToolStatusDot status={status} />
        <span className="font-medium">{summaryLabel}</span>
        {isActive && <Loader2 className="size-3 animate-spin text-blue-400/70" />}
        {expanded ? (
          <ChevronDown className="size-3 text-muted-foreground/40" />
        ) : (
          <ChevronRight className="size-3 text-muted-foreground/40" />
        )}
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="mt-0.5 pl-5 border-l border-border/30 overflow-hidden"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
