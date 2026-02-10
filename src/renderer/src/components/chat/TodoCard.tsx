import * as React from 'react'
import { motion, type Transition } from 'motion/react'
import { Loader2, ChevronDown, ChevronRight, ListChecks } from 'lucide-react'
import { Checkbox } from '@renderer/components/animate-ui/primitives/radix/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/components/ui/collapsible'
import { cn } from '@renderer/lib/utils'
import { useTaskStore } from '@renderer/stores/task-store'

interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority: 'high' | 'medium' | 'low'
}

// --- Playful strikethrough animation helpers ---

const getStrikeAnimate = (isChecked: boolean) => ({
  pathLength: isChecked ? 1 : 0,
  opacity: isChecked ? 1 : 0,
})

const getStrikeTransition = (isChecked: boolean): Transition => ({
  pathLength: { duration: 0.6, ease: 'easeInOut' },
  opacity: { duration: 0.01, delay: isChecked ? 0 : 0.6 },
})

function TodoItemRow({ todo }: { todo: TodoItem }): React.JSX.Element {
  const isCompleted = todo.status === 'completed'
  const isInProgress = todo.status === 'in_progress'

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5',
        isInProgress && 'bg-blue-500/5'
      )}
    >
      {isInProgress ? (
        <Loader2 className="size-4 shrink-0 animate-spin text-blue-500" />
      ) : (
        <Checkbox
          checked={isCompleted}
          id={`todo-${todo.id}`}
          className="pointer-events-none size-4 shrink-0 rounded border border-muted-foreground/30 data-[state=checked]:border-green-500 data-[state=checked]:bg-green-500 data-[state=checked]:text-white"
        />
      )}
      <div className="relative inline-block min-w-0 flex-1">
        <label
          htmlFor={`todo-${todo.id}`}
          className={cn(
            'text-xs leading-relaxed cursor-default',
            isCompleted && 'text-muted-foreground'
          )}
        >
          {todo.content}
        </label>
        {/* Playful animated strikethrough SVG */}
        <motion.svg
          width="340"
          height="32"
          viewBox="0 0 340 32"
          className="absolute left-0 top-1/2 -translate-y-1/2 pointer-events-none z-20 w-full h-6"
        >
          <motion.path
            d="M 10 16.91 s 79.8 -11.36 98.1 -11.34 c 22.2 0.02 -47.82 14.25 -33.39 22.02 c 12.61 6.77 124.18 -27.98 133.31 -17.28 c 7.52 8.38 -26.8 20.02 4.61 22.05 c 24.55 1.93 113.37 -20.36 113.37 -20.36"
            vectorEffect="non-scaling-stroke"
            strokeWidth={2}
            strokeLinecap="round"
            strokeMiterlimit={10}
            fill="none"
            initial={false}
            animate={getStrikeAnimate(isCompleted)}
            transition={getStrikeTransition(isCompleted)}
            className="stroke-neutral-900 dark:stroke-neutral-100"
          />
        </motion.svg>
      </div>
    </div>
  )
}

interface TodoCardProps {
  input: Record<string, unknown>
  isLive?: boolean
}

export function TodoCard({ input, isLive }: TodoCardProps): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(true)

  // Use live store state during streaming, fall back to input for historical
  const liveTodos = useTaskStore((s) => s.todos)
  const inputTodos = (input.todos ?? []) as TodoItem[]
  const todos: TodoItem[] = isLive ? liveTodos : inputTodos

  const total = todos.length
  const completed = todos.filter((t) => t.status === 'completed').length
  const inProgress = todos.filter((t) => t.status === 'in_progress').length

  // Determine how many to show collapsed
  const MAX_VISIBLE = 3
  const hasMore = todos.length > MAX_VISIBLE
  const [showAll, setShowAll] = React.useState(false)
  const visibleTodos = showAll ? todos : todos.slice(0, MAX_VISIBLE)

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <CollapsibleTrigger asChild>
        <button className="flex w-full items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-left transition-colors hover:bg-muted/50">
          <ListChecks className={cn('size-4 shrink-0', inProgress > 0 ? 'text-blue-500' : completed === total && total > 0 ? 'text-green-500' : 'text-muted-foreground')} />
          <div className="flex-1 min-w-0">
            <span className="text-xs text-muted-foreground">
              {completed} / {total} tasks done
            </span>
          </div>
          {expanded ? <ChevronDown className="size-3.5 text-muted-foreground/50" /> : <ChevronRight className="size-3.5 text-muted-foreground/50" />}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 space-y-0.5 pl-1">
          {visibleTodos.map((todo, idx) => (
            <React.Fragment key={todo.id}>
              <TodoItemRow todo={todo} />
              {idx !== visibleTodos.length - 1 && (
                <div className="border-t border-border/30 mx-2" />
              )}
            </React.Fragment>
          ))}
        </div>
        {hasMore && !showAll && (
          <button
            onClick={(e) => { e.stopPropagation(); setShowAll(true) }}
            className="mt-1 pl-3 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
          >
            {todos.length - MAX_VISIBLE} more
          </button>
        )}
        {showAll && hasMore && (
          <button
            onClick={(e) => { e.stopPropagation(); setShowAll(false) }}
            className="mt-1 pl-3 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
          >
            Show less
          </button>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}
