import { CheckCircle2, Circle, Loader2 } from 'lucide-react'
import { Badge } from '@renderer/components/ui/badge'
import { useTaskStore, type TodoItem } from '@renderer/stores/task-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { cn } from '@renderer/lib/utils'

function TodoStatusIcon({ status }: { status: TodoItem['status'] }): React.JSX.Element {
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

function PriorityBadge({ priority }: { priority: TodoItem['priority'] }): React.JSX.Element {
  const variant = priority === 'high' ? 'destructive' : 'secondary'
  if (priority === 'low') return <></>
  return (
    <Badge variant={variant} className="h-4 px-1 text-[10px]">
      {priority}
    </Badge>
  )
}

export function StepsPanel(): React.JSX.Element {
  const todos = useTaskStore((s) => s.todos)
  const isRunning = useAgentStore((s) => s.isRunning)

  const total = todos.length
  const completed = todos.filter((t) => t.status === 'completed').length
  const progress = {
    total,
    completed,
    percentage: total === 0 ? 0 : Math.round((completed / total) * 100),
  }

  if (todos.length === 0 && !isRunning) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Circle className="mb-3 size-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">No tasks yet</p>
        <p className="mt-1 text-xs text-muted-foreground/60">
          Tasks will appear here when the assistant creates a plan
        </p>
      </div>
    )
  }

  return <TodoList todos={todos} progress={progress} isRunning={isRunning} />
}

function TodoList({ todos, progress, isRunning }: { todos: TodoItem[]; progress: { total: number; completed: number; percentage: number }; isRunning: boolean }): React.JSX.Element {
  return (
    <div className="space-y-3">
      {/* Progress Bar */}
      {todos.length > 0 && (
        <>
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Progress</span>
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
                  <TodoStatusIcon status={todo.status} />
                </span>
                <div className="min-w-0 flex-1">
                  <span
                    className={cn(
                      todo.status === 'completed' && 'text-muted-foreground line-through'
                    )}
                  >
                    {todo.status === 'in_progress' && todo.activeForm
                      ? todo.activeForm
                      : todo.content}
                  </span>
                </div>
                <PriorityBadge priority={todo.priority} />
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Running Indicator */}
      {isRunning && todos.length === 0 && (
        <div className="flex items-center gap-2 py-4 justify-center text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Agent is working...
        </div>
      )}
    </div>
  )
}
