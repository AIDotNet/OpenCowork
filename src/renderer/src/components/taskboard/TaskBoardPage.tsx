import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  KanbanSquare,
  LayoutDashboard,
  List,
  GanttChartSquare,
  RefreshCw,
  Search
} from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import {
  AnimatePresence,
  PageTransition,
  PanelTransition,
  ScaleIn
} from '@renderer/components/animate-ui'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { useTaskStore, type TaskPriority } from '@renderer/stores/task-store'
import {
  applyBoardFilters,
  buildSessionOptions,
  scheduleTaskBoardRefresh,
  useTaskBoardStore,
  type TaskBoardView
} from '@renderer/stores/task-board-store'
import { DashboardView } from './DashboardView'
import { GanttView } from './GanttView'
import { KanbanView } from './KanbanView'
import { ListView } from './ListView'
import { TaskDetailPanel } from './TaskDetailPanel'

const ALL = '__all__'
const PRIORITIES: TaskPriority[] = ['urgent', 'high', 'medium', 'low']

const VIEW_TABS: { value: TaskBoardView; icon: React.ReactNode }[] = [
  { value: 'dashboard', icon: <LayoutDashboard className="size-3.5" /> },
  { value: 'kanban', icon: <KanbanSquare className="size-3.5" /> },
  { value: 'list', icon: <List className="size-3.5" /> },
  { value: 'gantt', icon: <GanttChartSquare className="size-3.5" /> }
]

export function TaskBoardPage(): React.JSX.Element {
  const { t } = useTranslation('taskboard')
  const items = useTaskBoardStore((s) => s.items)
  const loaded = useTaskBoardStore((s) => s.loaded)
  const loading = useTaskBoardStore((s) => s.loading)
  const view = useTaskBoardStore((s) => s.view)
  const filters = useTaskBoardStore((s) => s.filters)
  const selectedTaskId = useTaskBoardStore((s) => s.selectedTaskId)

  // Initial load. useTaskStore mutations only fire for the currently
  // foreground chat session, which is never true while this page is open, so
  // background agents updating tasks elsewhere wouldn't otherwise be seen —
  // poll as the reliable path and keep the store subscription as a fast-path
  // for edits made from this page itself.
  useEffect(() => {
    void useTaskBoardStore.getState().refresh()
    const unsubscribe = useTaskStore.subscribe(() => {
      scheduleTaskBoardRefresh()
    })
    const pollId = setInterval(() => {
      void useTaskBoardStore.getState().refresh()
    }, 4000)
    return () => {
      unsubscribe()
      clearInterval(pollId)
    }
  }, [])

  const filtered = useMemo(() => applyBoardFilters(items, filters), [items, filters])
  const boardItems = useMemo(
    () => filtered.filter((item) => item.status !== 'completed'),
    [filtered]
  )
  const sessionOptions = useMemo(() => buildSessionOptions(items), [items])
  const selectedTask = useMemo(
    () => (selectedTaskId ? (items.find((item) => item.id === selectedTaskId) ?? null) : null),
    [items, selectedTaskId]
  )

  const isEmpty = loaded && items.length === 0

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
          <div className="flex items-center rounded-lg bg-muted p-0.5">
            {VIEW_TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                onClick={() => useTaskBoardStore.getState().setView(tab.value)}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  view === tab.value
                    ? 'bg-background text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {tab.icon}
                {t(`views.${tab.value}`, { defaultValue: tab.value })}
              </button>
            ))}
          </div>

          <div className="relative ml-auto w-48">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filters.keyword}
              onChange={(e) => useTaskBoardStore.getState().setKeyword(e.target.value)}
              placeholder={t('filters.searchPlaceholder', { defaultValue: 'Search tasks…' })}
              className="h-7 pl-7 text-xs"
            />
          </div>

          <Select
            value={filters.sessionId ?? ALL}
            onValueChange={(v) =>
              useTaskBoardStore.getState().setSessionFilter(v === ALL ? null : v)
            }
          >
            <SelectTrigger className="h-7 w-40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL} className="text-xs">
                {t('filters.allSessions', { defaultValue: 'All sessions' })}
              </SelectItem>
              {sessionOptions.map((option) => (
                <SelectItem key={option.id} value={option.id} className="text-xs">
                  {option.title} ({option.taskCount})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={filters.priority ?? ALL}
            onValueChange={(v) =>
              useTaskBoardStore.getState().setPriorityFilter(v === ALL ? null : (v as TaskPriority))
            }
          >
            <SelectTrigger className="h-7 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL} className="text-xs">
                {t('filters.allPriorities', { defaultValue: 'All priorities' })}
              </SelectItem>
              {PRIORITIES.map((p) => (
                <SelectItem key={p} value={p} className="text-xs">
                  {t(`priority.${p}`, { defaultValue: p })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => void useTaskBoardStore.getState().refresh()}
            title={t('filters.refresh', { defaultValue: 'Refresh' })}
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          </Button>
        </div>

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-hidden">
          <AnimatePresence mode="wait">
            {isEmpty ? (
              <ScaleIn
                key="empty"
                className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center"
              >
                <KanbanSquare className="size-10 text-muted-foreground/40" />
                <p className="text-sm font-medium">
                  {t('empty.title', { defaultValue: 'No tasks yet' })}
                </p>
                <p className="max-w-sm text-xs text-muted-foreground">
                  {t('empty.description', {
                    defaultValue:
                      'Tasks created by agents across sessions will appear here. Ask an agent to plan complex work, or create tasks in a cowork session.'
                  })}
                </p>
              </ScaleIn>
            ) : (
              <PageTransition key={view} className="h-full">
                {view === 'dashboard' ? (
                  <DashboardView items={filtered} />
                ) : view === 'kanban' ? (
                  <KanbanView items={boardItems} />
                ) : view === 'list' ? (
                  <ListView items={filtered} />
                ) : (
                  <GanttView items={filtered} />
                )}
              </PageTransition>
            )}
          </AnimatePresence>
        </div>
      </div>

      <AnimatePresence>
        {selectedTask && (
          <PanelTransition side="right" className="h-full shrink-0">
            <TaskDetailPanel item={selectedTask} />
          </PanelTransition>
        )}
      </AnimatePresence>
    </div>
  )
}
