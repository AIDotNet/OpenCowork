import * as React from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import type { ToolResultContent } from '@renderer/lib/api/types'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import { useTaskStore, type TaskItem } from '@renderer/stores/task-store'
import { useTeamStore } from '@renderer/stores/team-store'
import type { TeamTask } from '@renderer/lib/agent/teams/types'

function teamTaskToItem(task: TeamTask): TaskItem {
  return {
    id: task.id,
    sessionId: '',
    subject: task.subject,
    description: task.description,
    activeForm: task.activeForm,
    status: task.status,
    owner: task.owner,
    blocks: [],
    blockedBy: task.dependsOn ?? [],
    metadata: undefined,
    createdAt: 0,
    updatedAt: 0
  }
}

function StatusDot({ status }: { status: TaskItem['status'] }): React.JSX.Element {
  switch (status) {
    case 'completed':
      return (
        <span className="relative flex size-3.5 shrink-0 items-center justify-center">
          <span className="size-2.5 rounded-full bg-green-500" />
        </span>
      )
    case 'in_progress':
      return (
        <span className="relative flex size-3.5 shrink-0 items-center justify-center">
          <span className="absolute size-2.5 rounded-full bg-blue-500/30 animate-ping" />
          <span className="size-2.5 rounded-full bg-blue-500" />
        </span>
      )
    case 'pending':
    default:
      return (
        <span className="relative flex size-3.5 shrink-0 items-center justify-center">
          <span className="size-2.5 rounded-full border border-muted-foreground/30" />
        </span>
      )
  }
}

interface TaskCardProps {
  name: string
  input: Record<string, unknown>
  output?: ToolResultContent
}

const COLLAPSED_VISIBLE_RECENT_TASK_COUNT = 3

function outputAsString(output: ToolResultContent | undefined): string | undefined {
  if (output === undefined) return undefined
  if (typeof output === 'string') return output
  const texts = output
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
  return texts.join('\n') || undefined
}

function getTaskTitle(value: { title?: unknown; subject?: unknown }): string | null {
  if (typeof value.title === 'string' && value.title.trim()) return value.title
  if (typeof value.subject === 'string' && value.subject.trim()) return value.subject
  return null
}

function getInputTaskTitle(input: Record<string, unknown>): string | null {
  return getTaskTitle(input)
}

function parseTaskSnapshot(output: ToolResultContent | undefined): {
  taskId?: string
  tasks: TaskItem[]
} | null {
  const text = outputAsString(output)
  if (!text) return null

  const parsed = decodeStructuredToolResult(text) as {
    task_id?: unknown
    tasks?: Array<(Partial<TaskItem> & { title?: unknown }) | null | undefined>
  } | null
  if (!parsed || Array.isArray(parsed) || !Array.isArray(parsed.tasks)) return null

  const tasks = parsed.tasks.flatMap((task) => {
    if (!task || typeof task.id !== 'string' || typeof task.status !== 'string') return []

    const subject = getTaskTitle(task)
    if (!subject) return []

    return [
      {
        id: task.id,
        subject,
        description: typeof task.description === 'string' ? task.description : '',
        activeForm: typeof task.activeForm === 'string' ? task.activeForm : undefined,
        status: task.status as TaskItem['status'],
        owner: typeof task.owner === 'string' || task.owner === null ? task.owner : undefined,
        blocks: Array.isArray(task.blocks) ? task.blocks.map(String) : [],
        blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.map(String) : [],
        metadata: task.metadata,
        createdAt: typeof task.createdAt === 'number' ? task.createdAt : 0,
        updatedAt: typeof task.updatedAt === 'number' ? task.updatedAt : 0
      }
    ]
  })

  return {
    taskId: typeof parsed.task_id === 'string' ? parsed.task_id : undefined,
    tasks
  }
}

export function TaskCard({ name, input, output }: TaskCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const liveStandaloneTasks = useTaskStore((s) => s.tasks)
  const activeTeam = useTeamStore((s) => s.activeTeam)
  const liveTeamTasks = React.useMemo(
    () => (activeTeam?.tasks ?? []).map(teamTaskToItem),
    [activeTeam]
  )
  // Prefer the tool-result snapshot; fall back to whichever live store has data.
  const liveTasks: TaskItem[] = liveStandaloneTasks.length > 0 ? liveStandaloneTasks : liveTeamTasks
  const [expanded, setExpanded] = React.useState(false)
  const snapshot = React.useMemo(() => parseTaskSnapshot(output), [output])
  const tasks: TaskItem[] = snapshot?.tasks ?? liveTasks
  const focusedTaskId =
    snapshot?.taskId ?? (typeof input.taskId === 'string' ? input.taskId : undefined)

  // For TaskUpdate with no snapshot and no hit in live stores, synthesize a single
  // focus item from the tool input so the card still conveys what happened.
  const focusedTask = React.useMemo<TaskItem | null>(() => {
    if (name !== 'TaskUpdate') return null
    if (!focusedTaskId) return null
    if (tasks.some((task) => task.id === focusedTaskId)) return null
    const inputSubject = getInputTaskTitle(input) ?? undefined
    const inputStatus = typeof input.status === 'string' ? input.status : 'in_progress'
    const inputActiveForm = typeof input.activeForm === 'string' ? input.activeForm : undefined
    const status: TaskItem['status'] =
      inputStatus === 'completed' || inputStatus === 'in_progress' || inputStatus === 'pending'
        ? inputStatus
        : 'in_progress'
    return {
      id: focusedTaskId,
      sessionId: '',
      subject: inputSubject ?? `#${focusedTaskId}`,
      description: '',
      activeForm: inputActiveForm,
      status,
      owner: null,
      blocks: [],
      blockedBy: [],
      createdAt: 0,
      updatedAt: 0
    }
  }, [name, focusedTaskId, tasks, input])

  const displayedTasks: TaskItem[] = focusedTask ? [focusedTask] : tasks
  const pendingTaskTitle = name === 'TaskCreate' ? getInputTaskTitle(input) : null
  const total = displayedTasks.length || (pendingTaskTitle ? 1 : 0)
  const completed = displayedTasks.filter((t) => t.status === 'completed').length

  const { hiddenCount, visibleTasks } = (() => {
    if (displayedTasks.length <= COLLAPSED_VISIBLE_RECENT_TASK_COUNT) {
      return { hiddenCount: 0, visibleTasks: displayedTasks }
    }

    const recentTaskIds = new Set(
      displayedTasks.slice(-COLLAPSED_VISIBLE_RECENT_TASK_COUNT).map((task) => task.id)
    )
    const nextVisibleTasks = displayedTasks.filter(
      (task) => task.status !== 'completed' || recentTaskIds.has(task.id)
    )

    return {
      hiddenCount: Math.max(0, displayedTasks.length - nextVisibleTasks.length),
      visibleTasks: nextVisibleTasks
    }
  })()

  React.useEffect(() => {
    if (hiddenCount === 0) {
      setExpanded(false)
    }
  }, [hiddenCount])

  const displayTasks = hiddenCount > 0 && !expanded ? visibleTasks : displayedTasks
  const pendingSubject = pendingTaskTitle
  // Show the pending placeholder whenever we have no rows to render for this TaskCreate —
  // not only when total === 0 (team mode can leave `total` at 1 with an empty task list).
  const showPendingPlaceholder = !!pendingSubject && displayTasks.length === 0

  if (total === 0 && !pendingSubject) {
    return <></>
  }

  return (
    <div className="my-5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span>{t('todo.tasksDone', { completed, total })}</span>
      </div>

      <div className="mt-1.5 space-y-0.5 pl-1">
        {hiddenCount > 0 && (
          <button
            type="button"
            className="flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-left text-[11px] text-muted-foreground/80 transition-colors hover:bg-muted/40 hover:text-foreground/80"
            onClick={() => setExpanded((prev) => !prev)}
          >
            {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
            <span>
              {expanded ? t('todo.showLess') : t('todo.showEarlierTasks', { count: hiddenCount })}
            </span>
          </button>
        )}
        {displayTasks.map((task) => (
          <div
            key={task.id}
            className={cn(
              'flex items-start gap-2 rounded-md px-1.5 py-1',
              task.id === focusedTaskId && 'bg-muted/40'
            )}
          >
            <span className="mt-0.5">
              <StatusDot status={task.status} />
            </span>
            <div className="min-w-0 flex-1">
              <div
                className={cn(
                  'text-xs leading-relaxed',
                  task.status === 'completed' && 'text-muted-foreground line-through',
                  task.status === 'pending' && 'text-muted-foreground/70'
                )}
              >
                {task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject}
              </div>
              {task.owner && (
                <div className="text-[10px] text-muted-foreground/50">{task.owner}</div>
              )}
            </div>
          </div>
        ))}
        {showPendingPlaceholder && (
          <div className="flex items-start gap-2 rounded-md px-1.5 py-1">
            <span className="mt-0.5">
              <StatusDot status="pending" />
            </span>
            <span className="text-xs leading-relaxed text-muted-foreground/70">
              {pendingSubject}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
