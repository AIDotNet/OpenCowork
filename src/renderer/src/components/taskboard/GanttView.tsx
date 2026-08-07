import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { useTaskBoardStore, type TaskBoardItem } from '@renderer/stores/task-board-store'
import { STATUS_DOT_CLASS, shortTaskId } from './board-utils'

const DAY_MS = 86_400_000
const PAST_DAYS = 14
const FUTURE_DAYS = 14
const DAY_WIDTH = 34

interface GanttViewProps {
  items: TaskBoardItem[]
}

interface GanttRow {
  item: TaskBoardItem
  startDay: number
  endDay: number
}

interface GanttGroup {
  sessionId: string
  title: string
  rows: GanttRow[]
}

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function GanttView({ items }: GanttViewProps): React.JSX.Element {
  const { t, i18n } = useTranslation('taskboard')
  const selectTask = useTaskBoardStore((s) => s.selectTask)

  const today = startOfDay(Date.now())
  const rangeStart = today - PAST_DAYS * DAY_MS
  const totalDays = PAST_DAYS + FUTURE_DAYS + 1

  const days = useMemo(
    () => Array.from({ length: totalDays }, (_, i) => rangeStart + i * DAY_MS),
    [rangeStart, totalDays]
  )

  const groups = useMemo(() => {
    const bySession = new Map<string, GanttGroup>()
    for (const item of items) {
      // Bar spans creation -> due date (or last update for undated tasks).
      const rawStart = startOfDay(item.createdAt)
      const rawEnd = startOfDay(item.dueAt ?? Math.max(item.updatedAt, item.createdAt))
      const clampedStart = Math.max(rawStart, rangeStart)
      const clampedEnd = Math.min(
        Math.max(rawEnd, clampedStart),
        rangeStart + (totalDays - 1) * DAY_MS
      )
      if (clampedStart > rangeStart + (totalDays - 1) * DAY_MS || clampedEnd < rangeStart) continue

      const startDay = Math.round((clampedStart - rangeStart) / DAY_MS)
      const endDay = Math.round((clampedEnd - rangeStart) / DAY_MS)
      let group = bySession.get(item.sessionId)
      if (!group) {
        group = {
          sessionId: item.sessionId,
          title: item.sessionTitle || item.sessionId.slice(0, 8),
          rows: []
        }
        bySession.set(item.sessionId, group)
      }
      group.rows.push({ item, startDay, endDay })
    }
    for (const group of bySession.values()) {
      group.rows.sort((a, b) => a.startDay - b.startDay || a.item.createdAt - b.item.createdAt)
    }
    return [...bySession.values()].sort((a, b) => b.rows.length - a.rows.length)
  }, [items, rangeStart, totalDays])

  if (groups.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t('gantt.noDated', { defaultValue: 'No tasks in this range' })}
      </div>
    )
  }

  const gridWidth = totalDays * DAY_WIDTH

  return (
    <div className="h-full overflow-auto p-4">
      <div className="min-w-fit">
        {/* Header: day scale */}
        <div className="sticky top-0 z-10 flex bg-background pb-1">
          <div className="w-56 shrink-0" />
          <div className="relative flex" style={{ width: gridWidth }}>
            {days.map((day, i) => {
              const date = new Date(day)
              const isToday = day === today
              const isMonthStart = date.getDate() === 1 || i === 0
              return (
                <div
                  key={day}
                  className={cn(
                    'shrink-0 border-l text-center text-[10px] leading-5 text-muted-foreground',
                    isToday && 'bg-primary/10 font-semibold text-primary'
                  )}
                  style={{ width: DAY_WIDTH }}
                >
                  {isMonthStart
                    ? date.toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' })
                    : date.getDate()}
                </div>
              )
            })}
          </div>
        </div>

        {groups.map((group) => (
          <div key={group.sessionId} className="mb-4">
            <p className="mb-1 truncate text-xs font-medium text-muted-foreground">{group.title}</p>
            {group.rows.map(({ item, startDay, endDay }) => (
              <div key={item.id} className="flex h-7 items-center">
                <button
                  type="button"
                  onClick={() => selectTask(item.id)}
                  className="w-56 shrink-0 truncate pr-3 text-left text-xs hover:text-primary"
                  title={item.subject}
                >
                  <span className="mr-1.5 font-mono text-[10px] text-muted-foreground">
                    {shortTaskId(item.id)}
                  </span>
                  {item.subject}
                </button>
                <div className="relative h-full" style={{ width: gridWidth }}>
                  {/* Today marker */}
                  <div
                    className="absolute inset-y-0 w-px bg-primary/40"
                    style={{ left: PAST_DAYS * DAY_WIDTH + DAY_WIDTH / 2 }}
                  />
                  <button
                    type="button"
                    onClick={() => selectTask(item.id)}
                    className={cn(
                      'absolute top-1.5 h-4 rounded-full opacity-80 transition-opacity hover:opacity-100',
                      STATUS_DOT_CLASS[item.status]
                    )}
                    style={{
                      left: startDay * DAY_WIDTH + 2,
                      width: Math.max((endDay - startDay + 1) * DAY_WIDTH - 4, DAY_WIDTH / 2)
                    }}
                    title={`${item.subject} · ${t(`columns.${item.status}`, { defaultValue: item.status })}`}
                  />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
