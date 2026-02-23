import { CheckCircle2, Circle, Loader2, Users, Bot, Link2, ClipboardList } from 'lucide-react'
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

export function StepsPanel(): React.JSX.Element {
  const { t } = useTranslation('cowork')
  const todos = useTaskStore((s) => s.tasks)
  const activeTeam = useTeamStore((s) => s.activeTeam)
  const teamTasks = activeTeam?.tasks ?? []
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const isRunning = useAgentStore((s) => activeSessionId ? s.runningSessions[activeSessionId] === 'running' : false)

  const plan = usePlanStore((s) => {
    if (!activeSessionId) return undefined
    return Object.values(s.plans).find((p) => p.sessionId === activeSessionId)
  })

  const planTasks = plan ? todos.filter((t) => t.planId === plan.id) : []
  const standaloneTasks = plan ? todos.filter((t) => !t.planId) : todos
  const displayTasks = plan ? planTasks : todos

  const total = displayTasks.length
  const completed = displayTasks.filter((t) => t.status === 'completed').length
  const progress = {
    total,
    completed,
    percentage: total === 0 ? 0 : Math.round((completed / total) * 100),
  }

  const hasContent = todos.length > 0 || teamTasks.length > 0

  if (!hasContent && !isRunning) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Circle className="mb-3 size-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">{t('steps.noTasks')}</p>
        <p className="mt-1 text-xs text-muted-foreground/60">
          {t('steps.noTasksDesc')}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2 max-h-[calc(100vh-200px)] overflow-y-auto">
      {/* Plan-linked tasks */}
      {plan && planTasks.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center rounded-md bg-violet-500/10 p-1">
              <ClipboardList className="size-3.5 text-violet-500" />
            </div>
            <span className="text-xs font-medium text-violet-600 dark:text-violet-400 truncate">
              {plan.title}
            </span>
            <Badge variant="secondary" className="text-[9px] h-4 px-1">
              {completed}/{total}
            </Badge>
          </div>
          <TodoList todos={planTasks} progress={progress} isRunning={isRunning && teamTasks.length === 0} />
        </div>
      )}

      {/* Standalone tasks (not linked to plan) */}
      {standaloneTasks.length > 0 && (
        <>
          {plan && planTasks.length > 0 && <Separator />}
          <TodoList todos={standaloneTasks} progress={{
            total: standaloneTasks.length,
            completed: standaloneTasks.filter((t) => t.status === 'completed').length,
            percentage: standaloneTasks.length === 0 ? 0 : Math.round((standaloneTasks.filter((t) => t.status === 'completed').length / standaloneTasks.length) * 100),
          }} isRunning={isRunning && teamTasks.length === 0} />
        </>
      )}

      {/* No plan: show all tasks as before */}
      {!plan && todos.length > 0 && standaloneTasks.length === 0 && (
        <TodoList todos={todos} progress={progress} isRunning={isRunning && teamTasks.length === 0} />
      )}

      {(planTasks.length > 0 || standaloneTasks.length > 0 || todos.length > 0) && teamTasks.length > 0 && <Separator />}
      {teamTasks.length > 0 && (
        <TeamTaskList
          tasks={teamTasks}
          teamName={activeTeam?.name ?? 'Team'}
          isRunning={isRunning}
        />
      )}
      {isRunning && !hasContent && (
        <div className="flex items-center gap-2 py-4 justify-center text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('steps.agentWorking')}
        </div>
      )}
    </div>
  )
}

function TodoList({ todos, progress, isRunning }: { todos: TaskItem[]; progress: { total: number; completed: number; percentage: number }; isRunning: boolean }): React.JSX.Element {
  const { t } = useTranslation('cowork')
  return (
    <div className="space-y-2">
      {/* Progress Bar */}
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

          {/* Task List */}
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

      {/* Running Indicator */}
      {isRunning && todos.length === 0 && (
        <div className="flex items-center gap-2 py-4 justify-center text-sm text-muted-foreground">
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
  const completedCount = tasks.filter((t) => t.status === 'completed').length
  const percentage = tasks.length === 0 ? 0 : Math.round((completedCount / tasks.length) * 100)

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center gap-2">
        <div className="flex items-center justify-center rounded-md bg-cyan-500/10 p-1">
          <Users className="size-3.5 text-cyan-500" />
        </div>
        <span className="text-xs font-medium text-cyan-600 dark:text-cyan-400 truncate">
          {teamName}
        </span>
        <Badge variant="secondary" className="text-[9px] h-4 px-1">
          {completedCount}/{tasks.length}
        </Badge>
      </div>

      {/* Progress Bar */}
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

      {/* Task List */}
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
              <span
                className={cn(
                  task.status === 'completed' && 'text-muted-foreground line-through'
                )}
              >
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

      {/* Running Indicator */}
      {isRunning && tasks.length === 0 && (
        <div className="flex items-center gap-2 py-4 justify-center text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('steps.teamWorking')}
        </div>
      )}
    </div>
  )
}
