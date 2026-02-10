import { CheckCircle2, Circle, Loader2, XCircle, Clock, Wrench, Trash2, Brain } from 'lucide-react'
import { Badge } from '@renderer/components/ui/badge'
import { Separator } from '@renderer/components/ui/separator'
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

function toolCallSummary(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash' && input.command) return String(input.command).slice(0, 60)
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'LS'].includes(name)) {
    const p = String(input.file_path ?? input.path ?? '')
    return p.split(/[\\/]/).slice(-2).join('/')
  }
  if (name === 'Glob' && input.pattern) return String(input.pattern)
  if (name === 'Grep' && input.pattern) return String(input.pattern)
  if (name === 'CodeSearch') return String(input.query ?? '').slice(0, 50)
  if (name === 'CodeReview') return `${input.target ?? ''}`
  if (name === 'Planner') return String(input.task ?? '').slice(0, 50)
  return ''
}

export function StepsPanel(): React.JSX.Element {
  const todos = useTaskStore((s) => s.todos)
  const executedToolCalls = useAgentStore((s) => s.executedToolCalls)
  const isRunning = useAgentStore((s) => s.isRunning)

  const total = todos.length
  const completed = todos.filter((t) => t.status === 'completed').length
  const progress = {
    total,
    completed,
    percentage: total === 0 ? 0 : Math.round((completed / total) * 100),
  }

  if (todos.length === 0 && executedToolCalls.length === 0 && !isRunning) {
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

  return <TodoList todos={todos} progress={progress} />
}

function TodoList({ todos, progress }: { todos: TodoItem[]; progress: { total: number; completed: number; percentage: number } }): React.JSX.Element {
  const executedToolCalls = useAgentStore((s) => s.executedToolCalls)
  const pendingToolCalls = useAgentStore((s) => s.pendingToolCalls)
  const isRunning = useAgentStore((s) => s.isRunning)
  const activeSubAgent = useAgentStore((s) => s.activeSubAgent)
  const completedSubAgents = useAgentStore((s) => s.completedSubAgents)
  const allCalls = [...executedToolCalls, ...pendingToolCalls]

  // Merge completed + active SubAgents for display (avoid duplicates)
  const allSubAgents = Object.values(completedSubAgents).filter(
    (sa) => sa.name !== activeSubAgent?.name
  )
  if (activeSubAgent) allSubAgents.push(activeSubAgent)

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

      {/* Agent Activity */}
      {allCalls.length > 0 && (
        <>
          {todos.length > 0 && <Separator />}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Tool Calls
              </h4>
              <div className="flex items-center gap-1.5">
                {(() => {
                  const totalMs = allCalls.reduce((acc, tc) => acc + (tc.completedAt && tc.startedAt ? tc.completedAt - tc.startedAt : 0), 0)
                  if (totalMs > 0) return <span className="text-[9px] text-muted-foreground/40">{(totalMs / 1000).toFixed(1)}s</span>
                  return null
                })()}
                <Badge variant="secondary" className="text-[10px]">
                  {allCalls.length}
                </Badge>
                {!isRunning && allCalls.length > 0 && (
                  <button
                    onClick={() => useAgentStore.getState().clearToolCalls()}
                    className="rounded p-0.5 text-muted-foreground/30 hover:text-muted-foreground transition-colors"
                    title="Clear tool calls"
                  >
                    <Trash2 className="size-3" />
                  </button>
                )}
              </div>
            </div>
            {/* Tool breakdown summary */}
            {allCalls.length > 2 && (
              <div className="flex flex-wrap gap-1 mb-1">
                {(() => {
                  const counts = new Map<string, { total: number; errors: number }>()
                  for (const tc of allCalls) {
                    const c = counts.get(tc.name) ?? { total: 0, errors: 0 }
                    c.total++
                    if (tc.status === 'error') c.errors++
                    counts.set(tc.name, c)
                  }
                  return Array.from(counts.entries()).map(([name, c]) => (
                    <span
                      key={name}
                      className={cn(
                        'rounded px-1 py-0.5 text-[9px] font-mono',
                        c.errors > 0 ? 'bg-red-500/10 text-red-400/70' : 'bg-muted/60 text-muted-foreground/50',
                      )}
                    >
                      {name}×{c.total}
                    </span>
                  ))
                })()}
              </div>
            )}
            <ul className="space-y-0.5">
              {allCalls.map((tc) => {
                const summary = toolCallSummary(tc.name, tc.input)
                const isSubAgent = ['CodeSearch', 'CodeReview', 'Planner'].includes(tc.name)
                return (
                  <li key={tc.id} className={cn("flex items-center gap-2 rounded-md px-2 py-1 text-xs", isSubAgent && "bg-violet-500/5")} title={summary}>
                    {tc.status === 'completed' && <CheckCircle2 className="size-3 shrink-0 text-green-500" />}
                    {tc.status === 'running' && <Loader2 className="size-3 shrink-0 animate-spin text-blue-500" />}
                    {tc.status === 'error' && <XCircle className="size-3 shrink-0 text-destructive" />}
                    {tc.status === 'pending_approval' && <Clock className="size-3 shrink-0 text-amber-500" />}
                    {isSubAgent
                      ? <Brain className="size-3 shrink-0 text-violet-500" />
                      : <Wrench className="size-3 shrink-0 text-muted-foreground" />
                    }
                    <span className={cn("font-mono shrink-0", isSubAgent && "text-violet-500")}>{tc.name}</span>
                    {summary && (
                      <span className="truncate text-muted-foreground/50">{summary}</span>
                    )}
                    {tc.completedAt && tc.startedAt && (
                      <span className="ml-auto shrink-0 text-[9px] text-muted-foreground/30">
                        {((tc.completedAt - tc.startedAt) / 1000).toFixed(1)}s
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        </>
      )}

      {/* SubAgent Activity */}
      {allSubAgents.length > 0 && (
        <>
          <Separator />
          {allSubAgents.map((sa) => (
            <div key={sa.name} className="space-y-1">
              <div className="flex items-center gap-1.5">
                <Brain className="size-3 text-violet-500" />
                <h4 className="text-xs font-medium text-violet-500 uppercase tracking-wider">
                  {sa.name}
                </h4>
                {sa.isRunning && <Loader2 className="size-3 animate-spin text-violet-400" />}
                {!sa.isRunning && <CheckCircle2 className="size-3 text-green-500" />}
                <span className="ml-auto text-[9px] text-muted-foreground/40">
                  iter {sa.iteration} · {sa.toolCalls.length} calls
                </span>
              </div>
              {sa.toolCalls.length > 0 && (
                <ul className="space-y-0.5 pl-3 border-l border-violet-500/20">
                  {sa.toolCalls.map((tc) => {
                    const summary = toolCallSummary(tc.name, tc.input)
                    return (
                      <li key={tc.id} className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60" title={summary}>
                        {tc.status === 'completed' && <CheckCircle2 className="size-2.5 shrink-0 text-green-500/60" />}
                        {tc.status === 'running' && <Loader2 className="size-2.5 shrink-0 animate-spin text-blue-400" />}
                        {tc.status === 'error' && <XCircle className="size-2.5 shrink-0 text-destructive/60" />}
                        <span className="font-mono shrink-0">{tc.name}</span>
                        {summary && <span className="truncate text-muted-foreground/30">{summary}</span>}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          ))}
        </>
      )}

      {/* Running Indicator */}
      {isRunning && allCalls.length === 0 && todos.length === 0 && !activeSubAgent && (
        <div className="flex items-center gap-2 py-4 justify-center text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Agent is working...
        </div>
      )}
    </div>
  )
}
