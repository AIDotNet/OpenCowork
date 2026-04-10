import {
  Bot,
  CheckCircle2,
  ChevronRight,
  Circle,
  ClipboardList,
  Link2,
  Loader2,
  Trash2,
  Users
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/shallow'
import { AnimatePresence, motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@renderer/components/ui/badge'
import { Separator } from '@renderer/components/ui/separator'
import { useTaskStore, type TaskItem } from '@renderer/stores/task-store'
import { useTeamStore } from '@renderer/stores/team-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { usePlanStore } from '@renderer/stores/plan-store'
import { cn } from '@renderer/lib/utils'
import type { TeamTask } from '@renderer/lib/agent/teams/types'

const EMPTY_TEAM_TASKS: TeamTask[] = []
const EMPTY_TASKS: TaskItem[] = []
const EASE = [0.4, 0, 0.2, 1] as const

interface ProgressSummary {
  total: number
  completed: number
  percentage: number
}

interface StepsPanelData {
  todos: TaskItem[]
  plan?: {
    id: string
    title: string
  }
  planTasks: TaskItem[]
  standaloneTasks: TaskItem[]
  progress: ProgressSummary
  standaloneProgress: ProgressSummary
  teamName: string
  teamTasks: TeamTask[]
  isRunning: boolean
  hasContent: boolean
}

interface InlinePreviewItem {
  id: string
  text: string
  label?: string
  tone: 'default' | 'plan' | 'team'
  type: 'task' | 'team'
  status: TaskItem['status']
}

function buildProgress(items: Array<{ status: 'pending' | 'in_progress' | 'completed' }>): ProgressSummary {
  const total = items.length
  const completed = items.filter((item) => item.status === 'completed').length
  return {
    total,
    completed,
    percentage: total === 0 ? 0 : Math.round((completed / total) * 100)
  }
}

function useStepsPanelData(sessionId?: string | null): StepsPanelData {
  const resolvedSessionId = useChatStore((s) => sessionId ?? s.activeSessionId)
  const todos = useTaskStore((s) => {
    if (!resolvedSessionId) return s.tasks
    return s.currentSessionId === resolvedSessionId ? s.tasks : (s.tasksBySession[resolvedSessionId] ?? EMPTY_TASKS)
  })
  const activeTeam = useTeamStore((s) => s.activeTeam)
  const hasStreamingMessage = useChatStore((s) =>
    resolvedSessionId ? Boolean(s.streamingMessages[resolvedSessionId]) : false
  )
  const isRunning = useAgentStore((s) => s.isSessionActive(resolvedSessionId)) || hasStreamingMessage
  const plan = usePlanStore(
    useShallow((s) => {
      if (!resolvedSessionId) return undefined
      const item = Object.values(s.plans).find((p) => p.sessionId === resolvedSessionId)
      return item ? { id: item.id, title: item.title } : undefined
    })
  )

  const showTeamTasks = Boolean(activeTeam && (!activeTeam.sessionId || activeTeam.sessionId === resolvedSessionId))
  const teamName = showTeamTasks ? activeTeam?.name ?? 'Team' : 'Team'
  const teamTasks = showTeamTasks ? activeTeam?.tasks ?? EMPTY_TEAM_TASKS : EMPTY_TEAM_TASKS

  const planTasks = useMemo(() => (plan ? todos.filter((t) => t.planId === plan.id) : []), [plan, todos])
  const standaloneTasks = useMemo(() => (plan ? todos.filter((t) => !t.planId) : todos), [plan, todos])
  const progress = useMemo(() => buildProgress(plan ? planTasks : todos), [plan, planTasks, todos])
  const standaloneProgress = useMemo(() => buildProgress(standaloneTasks), [standaloneTasks])
  const hasContent = todos.length > 0 || teamTasks.length > 0

  return {
    todos,
    plan,
    planTasks,
    standaloneTasks,
    progress,
    standaloneProgress,
    teamName,
    teamTasks,
    isRunning,
    hasContent
  }
}

function TaskStatusIcon({ status }: { status: TaskItem['status'] }): React.JSX.Element {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="size-4 text-green-500" />
    case 'in_progress':
      return <Loader2 className="size-4 animate-spin text-blue-500" />
    case 'pending':
    default:
      return <Circle className="size-4 text-muted-foreground" />
  }
}

function StepsPanelContent({
  data,
  className
}: {
  data: StepsPanelData
  className?: string
}): React.JSX.Element {
  const { t } = useTranslation('cowork')
  const { plan, todos, planTasks, standaloneTasks, progress, standaloneProgress, teamTasks, teamName, isRunning, hasContent } =
    data

  return (
    <div className={cn('space-y-2', className)}>
      {/* Plan-linked tasks */}
      {plan && planTasks.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center rounded-md bg-violet-500/10 p-1">
              <ClipboardList className="size-3.5 text-violet-500" />
            </div>
            <span className="truncate text-xs font-medium text-violet-600 dark:text-violet-400">
              {plan.title}
            </span>
            <Badge variant="secondary" className="h-4 px-1 text-[9px]">
              {progress.completed}/{progress.total}
            </Badge>
          </div>
          <TodoList
            todos={planTasks}
            progress={progress}
            isRunning={isRunning && teamTasks.length === 0}
          />
        </div>
      )}

      {/* Standalone tasks (not linked to plan) */}
      {standaloneTasks.length > 0 && (
        <>
          {plan && planTasks.length > 0 && <Separator />}
          <TodoList
            todos={standaloneTasks}
            progress={standaloneProgress}
            isRunning={isRunning && teamTasks.length === 0}
          />
        </>
      )}

      {(planTasks.length > 0 || standaloneTasks.length > 0 || todos.length > 0) &&
        teamTasks.length > 0 && <Separator />}
      {teamTasks.length > 0 && (
        <TeamTaskList tasks={teamTasks} teamName={teamName} isRunning={isRunning} />
      )}
      {isRunning && !hasContent && (
        <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('steps.agentWorking')}
        </div>
      )}
    </div>
  )
}

export function StepsPanel({ sessionId }: { sessionId?: string | null } = {}): React.JSX.Element {
  const { t } = useTranslation('cowork')
  const data = useStepsPanelData(sessionId)

  if (!data.hasContent && !data.isRunning) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Circle className="mb-3 size-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">{t('steps.noTasks')}</p>
        <p className="mt-1 text-xs text-muted-foreground/60">{t('steps.noTasksDesc')}</p>
      </div>
    )
  }

  return <StepsPanelContent data={data} className="max-h-[calc(100vh-200px)] overflow-y-auto" />
}

function InlinePreviewStatusIcon({ item }: { item: InlinePreviewItem }): React.JSX.Element {
  if (item.type === 'team') {
    return <TeamTaskStatusIcon status={item.status} />
  }
  return <TaskStatusIcon status={item.status} />
}

function InlinePreviewTag({
  label,
  tone
}: {
  label: string
  tone: InlinePreviewItem['tone']
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'max-w-[180px] truncate rounded-full border px-1.5 py-0.5 text-[10px]',
        tone === 'plan' && 'border-violet-500/20 bg-violet-500/8 text-violet-600 dark:text-violet-400',
        tone === 'team' && 'border-cyan-500/20 bg-cyan-500/8 text-cyan-600 dark:text-cyan-400',
        tone === 'default' && 'border-border/60 bg-background/70 text-muted-foreground'
      )}
    >
      {label}
    </span>
  )
}

export function InlineStepsPanel({ sessionId }: { sessionId?: string | null }): React.JSX.Element | null {
  const { t } = useTranslation('cowork')
  const { t: tLayout } = useTranslation('layout')
  const data = useStepsPanelData(sessionId)
  const [expanded, setExpanded] = useState(false)
  const resolvedSessionId = useChatStore((s) => sessionId ?? s.activeSessionId)

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (resolvedSessionId) {
      useTaskStore.getState().deleteSessionTasks(resolvedSessionId)
    }
  }

  const summaryTotal = data.todos.length + data.teamTasks.length
  const summaryCompleted =
    data.todos.filter((task) => task.status === 'completed').length +
    data.teamTasks.filter((task) => task.status === 'completed').length

  const activePreviewItems = useMemo<InlinePreviewItem[]>(() => {
    const items: InlinePreviewItem[] = []

    if (data.plan) {
      for (const task of data.planTasks) {
        if (task.status !== 'in_progress') continue
        items.push({
          id: `plan-${task.id}`,
          text: task.activeForm ?? task.subject,
          label: data.plan.title,
          tone: 'plan',
          type: 'task',
          status: task.status
        })
      }
    }

    for (const task of data.standaloneTasks) {
      if (task.status !== 'in_progress') continue
      items.push({
        id: `task-${task.id}`,
        text: task.activeForm ?? task.subject,
        tone: 'default',
        type: 'task',
        status: task.status
      })
    }

    for (const task of data.teamTasks) {
      if (task.status !== 'in_progress') continue
      items.push({
        id: `team-${task.id}`,
        text: task.activeForm ?? task.subject,
        label: data.teamName,
        tone: 'team',
        type: 'team',
        status: task.status
      })
    }

    return items
  }, [data.plan, data.planTasks, data.standaloneTasks, data.teamName, data.teamTasks])

  if (!data.hasContent) {
    return null
  }

  const visiblePreviewItems = activePreviewItems.slice(0, 3)
  const hiddenPreviewCount = Math.max(0, activePreviewItems.length - visiblePreviewItems.length)
  const showCollapsedPreview = !expanded && (visiblePreviewItems.length > 0 || data.isRunning)

  return (
    <div>
      <div className="overflow-hidden rounded-xl border border-border/60 bg-background/80 shadow-sm">
        {/* Header row */}
        <div className="flex items-center">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/30"
          >
            <div className="flex min-w-0 items-center gap-2">
              <ChevronRight
                className={cn(
                  'size-3.5 shrink-0 text-muted-foreground transition-transform duration-200',
                  expanded && 'rotate-90'
                )}
              />
              <ClipboardList className="size-3.5 shrink-0 text-primary/80" />
              <span className="truncate text-xs font-medium text-foreground">
                {tLayout('rightPanel.steps', { defaultValue: '步骤' })}
              </span>
              {summaryTotal > 0 && (
                <span className="rounded-full border border-border/60 bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {summaryCompleted}/{summaryTotal}
                </span>
              )}
            </div>
            {activePreviewItems.length > 0 && !expanded && (
              <span className="inline-flex items-center gap-1 rounded-full border border-blue-500/20 bg-blue-500/8 px-1.5 py-0.5 text-[10px] text-blue-600 dark:text-blue-400">
                <Loader2 className="size-2.5 animate-spin" />
                {activePreviewItems.length}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            className="mr-2 shrink-0 rounded-md p-1 text-muted-foreground/50 transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>

        {/* Collapsed preview */}
        <AnimatePresence initial={false}>
          {showCollapsedPreview && (
            <motion.div
              key="preview"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: EASE }}
              style={{ overflow: 'hidden' }}
              className="border-t border-border/50"
            >
              <div className="px-3 py-2">
                {visiblePreviewItems.length > 0 ? (
                  <ul className="space-y-1">
                    {visiblePreviewItems.map((item) => (
                      <li
                        key={item.id}
                        className={cn(
                          'flex items-start gap-2 rounded-lg px-2 py-1.5 text-xs',
                          item.tone === 'plan' && 'bg-violet-500/5',
                          item.tone === 'team' && 'bg-cyan-500/5',
                          item.tone === 'default' && 'bg-primary/5'
                        )}
                      >
                        <span className="mt-0.5 shrink-0">
                          <InlinePreviewStatusIcon item={item} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {item.label && <InlinePreviewTag label={item.label} tone={item.tone} />}
                            <span className="min-w-0 flex-1 truncate text-foreground">{item.text}</span>
                          </div>
                        </div>
                      </li>
                    ))}
                    {hiddenPreviewCount > 0 && (
                      <li className="px-2 text-[11px] text-muted-foreground">
                        +{hiddenPreviewCount}
                      </li>
                    )}
                  </ul>
                ) : (
                  <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" />
                    {t('steps.agentWorking')}
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Expanded content */}
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              key="expanded"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: EASE }}
              style={{ overflow: 'hidden' }}
              className="border-t border-border/50"
            >
              <div className="max-h-64 overflow-y-auto px-3 py-3">
                <StepsPanelContent data={data} className="pr-1" />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

function TodoList({
  todos,
  progress,
  isRunning
}: {
  todos: TaskItem[]
  progress: { total: number; completed: number; percentage: number }
  isRunning: boolean
}): React.JSX.Element {
  const { t } = useTranslation('cowork')
  return (
    <div className="space-y-2">
      {todos.length > 0 && (
        <>
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t('steps.progress')}</span>
              <span>
                {progress.completed}/{progress.total} ({progress.percentage}%)
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-300"
                style={{ width: `${progress.percentage}%` }}
              />
            </div>
          </div>

          <ul className="space-y-1">
            {todos.map((todo) => (
              <li
                key={todo.id}
                className={cn(
                  'flex items-start gap-2 rounded-md px-2 py-1.5 text-sm',
                  todo.status === 'in_progress' && 'bg-blue-500/5'
                )}
              >
                <span className="mt-0.5 shrink-0">
                  <TaskStatusIcon status={todo.status} />
                </span>
                <div className="min-w-0 flex-1">
                  <span
                    className={cn(
                      todo.status === 'completed' && 'text-muted-foreground line-through'
                    )}
                  >
                    {todo.status === 'in_progress' && todo.activeForm
                      ? todo.activeForm
                      : todo.subject}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {isRunning && todos.length === 0 && (
        <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('steps.agentWorking')}
        </div>
      )}
    </div>
  )
}

// ── Team Task List (Todo-like display for team tasks) ────────────

function TeamTaskStatusIcon({ status }: { status: TeamTask['status'] }): React.JSX.Element {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="size-4 text-green-500" />
    case 'in_progress':
      return <Loader2 className="size-4 animate-spin text-cyan-500" />
    case 'pending':
    default:
      return <Circle className="size-4 text-muted-foreground" />
  }
}

function TeamTaskList({
  tasks,
  teamName,
  isRunning
}: {
  tasks: TeamTask[]
  teamName: string
  isRunning: boolean
}): React.JSX.Element {
  const { t } = useTranslation('cowork')
  const completedCount = tasks.filter((task) => task.status === 'completed').length
  const percentage = tasks.length === 0 ? 0 : Math.round((completedCount / tasks.length) * 100)

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex items-center justify-center rounded-md bg-cyan-500/10 p-1">
          <Users className="size-3.5 text-cyan-500" />
        </div>
        <span className="truncate text-xs font-medium text-cyan-600 dark:text-cyan-400">
          {teamName}
        </span>
        <Badge variant="secondary" className="h-4 px-1 text-[9px]">
          {completedCount}/{tasks.length}
        </Badge>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{t('steps.teamProgress')}</span>
          <span>{percentage}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-cyan-500 transition-all duration-300"
            style={{ width: `${percentage}%` }}
          />
        </div>
      </div>

      <ul className="space-y-1">
        {tasks.map((task) => (
          <li
            key={task.id}
            className={cn(
              'flex items-start gap-2 rounded-md px-2 py-1.5 text-sm',
              task.status === 'in_progress' && 'bg-cyan-500/5'
            )}
          >
            <span className="mt-0.5 shrink-0">
              <TeamTaskStatusIcon status={task.status} />
            </span>
            <div className="min-w-0 flex-1">
              <span className={cn(task.status === 'completed' && 'text-muted-foreground line-through')}>
                {task.activeForm ?? task.subject}
              </span>
              {task.owner && (
                <span className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] text-cyan-500/60">
                  <Bot className="size-2.5" />
                  {task.owner}
                </span>
              )}
              {task.dependsOn.length > 0 && (
                <span className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] text-muted-foreground/40">
                  <Link2 className="size-2.5" />
                  {task.dependsOn.length} deps
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>

      {isRunning && tasks.length === 0 && (
        <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('steps.teamWorking')}
        </div>
      )}
    </div>
  )
}
