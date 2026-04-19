import { Users, ClipboardList, MessageSquare, Trash2, RefreshCw, UserPlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import type { ToolResultContent } from '@renderer/lib/api/types'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'

interface TeamEventCardProps {
  name: string
  input: Record<string, unknown>
  output?: ToolResultContent
}

const toolConfig: Record<string, { icon: React.ReactNode; color: string; labelKey: string }> = {
  TeamCreate: {
    icon: <Users className="size-3.5" />,
    color: 'border-cyan-500/30 bg-cyan-500/5',
    labelKey: 'teamEvent.teamCreated'
  },
  TaskCreate: {
    icon: <ClipboardList className="size-3.5" />,
    color: 'border-cyan-500/20 bg-cyan-500/[0.02]',
    labelKey: 'teamEvent.taskCreated'
  },
  TaskUpdate: {
    icon: <RefreshCw className="size-3.5" />,
    color: 'border-cyan-500/20 bg-cyan-500/[0.02]',
    labelKey: 'teamEvent.taskUpdated'
  },
  SendMessage: {
    icon: <MessageSquare className="size-3.5" />,
    color: 'border-cyan-500/20 bg-cyan-500/[0.02]',
    labelKey: 'teamEvent.messageSent'
  },
  TeamDelete: {
    icon: <Trash2 className="size-3.5" />,
    color: 'border-muted bg-muted/30',
    labelKey: 'teamEvent.teamDeleted'
  },
  Task: {
    icon: <UserPlus className="size-3.5" />,
    color: 'border-cyan-500/30 bg-cyan-500/5',
    labelKey: 'teamEvent.teammateSpawned'
  }
}

function parseOutput(output?: ToolResultContent): Record<string, unknown> | null {
  if (!output || typeof output !== 'string') return null
  const parsed = decodeStructuredToolResult(output)
  return parsed && !Array.isArray(parsed) ? parsed : null
}

export function TeamEventCard({ name, input, output }: TeamEventCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const config = toolConfig[name] ?? {
    icon: <Users className="size-3.5" />,
    color: 'border-muted bg-muted/30',
    labelKey: ''
  }

  const parsed = parseOutput(output)
  const isError = parsed && 'error' in parsed

  // Build summary text based on tool type
  let summary = ''
  switch (name) {
    case 'TeamCreate':
      summary = `${input.team_name ?? ''}`
      if (input.description) summary += ` — ${input.description}`
      break
    case 'TaskCreate':
      summary = `${input.title ?? input.subject ?? ''}`
      if (parsed?.task_id) summary = `#${parsed.task_id}: ${summary}`
      break
    case 'TaskUpdate':
      summary = `#${input.task_id ?? ''}`
      if (input.status) summary += ` → ${input.status}`
      if (input.owner) summary += ` (${input.owner})`
      break
    case 'Task':
      summary = `${input.name ?? ''}`
      if (input.description) summary += ` — ${input.description}`
      break
    case 'SendMessage':
      summary = `→ ${input.recipient ?? 'all'}: ${String(input.content ?? '').slice(0, 80)}`
      break
    case 'TeamDelete':
      if (parsed && !isError)
        summary = `${parsed.team_name ?? ''} (${parsed.tasks_completed ?? 0}/${parsed.tasks_total ?? 0} tasks done)`
      break
  }

  return (
    <div
      className={cn(
        'my-5 rounded-lg border px-3 py-2 transition-all',
        config.color,
        isError && 'border-destructive/30 bg-destructive/5'
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-cyan-500 shrink-0">{config.icon}</span>
        <span className="text-[11px] font-medium text-cyan-600 dark:text-cyan-400">
          {config.labelKey ? t(config.labelKey) : name}
        </span>
        {isError && (
          <span className="text-[9px] text-destructive font-medium">{t('teamEvent.failed')}</span>
        )}
        <span className="flex-1" />
      </div>
      {summary && (
        <p className="text-[10px] text-muted-foreground/70 mt-0.5 truncate pl-6">{summary}</p>
      )}
    </div>
  )
}
