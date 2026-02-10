import { Users, ClipboardList, MessageSquare, Trash2, UserPlus, RefreshCw, List } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

interface TeamEventCardProps {
  name: string
  input: Record<string, unknown>
  output?: string
}

const toolConfig: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  TeamCreate: {
    icon: <Users className="size-3.5" />,
    color: 'border-cyan-500/30 bg-cyan-500/5',
    label: 'Team Created',
  },
  TaskCreate: {
    icon: <ClipboardList className="size-3.5" />,
    color: 'border-cyan-500/20 bg-cyan-500/[0.02]',
    label: 'Task Created',
  },
  TaskUpdate: {
    icon: <RefreshCw className="size-3.5" />,
    color: 'border-cyan-500/20 bg-cyan-500/[0.02]',
    label: 'Task Updated',
  },
  TaskList: {
    icon: <List className="size-3.5" />,
    color: 'border-muted bg-muted/30',
    label: 'Task List',
  },
  SpawnTeammate: {
    icon: <UserPlus className="size-3.5" />,
    color: 'border-cyan-500/30 bg-cyan-500/5',
    label: 'Teammate Spawned',
  },
  TeamSendMessage: {
    icon: <MessageSquare className="size-3.5" />,
    color: 'border-cyan-500/20 bg-cyan-500/[0.02]',
    label: 'Message Sent',
  },
  TeamDelete: {
    icon: <Trash2 className="size-3.5" />,
    color: 'border-muted bg-muted/30',
    label: 'Team Deleted',
  },
}

function parseOutput(output?: string): Record<string, unknown> | null {
  if (!output) return null
  try {
    return JSON.parse(output)
  } catch {
    return null
  }
}

export function TeamEventCard({ name, input, output }: TeamEventCardProps): React.JSX.Element {
  const config = toolConfig[name] ?? {
    icon: <Users className="size-3.5" />,
    color: 'border-muted bg-muted/30',
    label: name,
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
      summary = `${input.subject ?? ''}`
      if (parsed?.task_id) summary = `#${parsed.task_id}: ${summary}`
      break
    case 'TaskUpdate':
      summary = `#${input.task_id ?? ''}`
      if (input.status) summary += ` → ${input.status}`
      if (input.owner) summary += ` (${input.owner})`
      break
    case 'TaskList':
      if (parsed && !isError) summary = `${parsed.filtered ?? 0} tasks`
      break
    case 'SpawnTeammate':
      summary = `${input.name ?? ''}`
      if (input.task_id) summary += ` → task #${input.task_id}`
      break
    case 'TeamSendMessage':
      summary = `→ ${input.recipient ?? 'all'}: ${String(input.content ?? '').slice(0, 80)}`
      break
    case 'TeamDelete':
      if (parsed && !isError) summary = `${parsed.team_name ?? ''} (${parsed.tasks_completed ?? 0}/${parsed.tasks_total ?? 0} tasks done)`
      break
  }

  return (
    <div className={cn('rounded-lg border px-3 py-2 transition-all', config.color, isError && 'border-destructive/30 bg-destructive/5')}>
      <div className="flex items-center gap-2">
        <span className="text-cyan-500 shrink-0">{config.icon}</span>
        <span className="text-[11px] font-medium text-cyan-600 dark:text-cyan-400">
          {config.label}
        </span>
        {isError && (
          <span className="text-[9px] text-destructive font-medium">failed</span>
        )}
        <span className="flex-1" />
      </div>
      {summary && (
        <p className="text-[10px] text-muted-foreground/70 mt-0.5 truncate pl-6">{summary}</p>
      )}
    </div>
  )
}
