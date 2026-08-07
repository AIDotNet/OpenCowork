import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { AlertOctagon, CheckCircle2, ListTodo, MessagesSquare } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { FadeIn, StaggerContainer, StaggerItem } from '@renderer/components/animate-ui'
import type { TaskStatus } from '@renderer/stores/task-store'
import { useTaskBoardStore, type TaskBoardItem } from '@renderer/stores/task-board-store'
import { shortTaskId, STATUS_DOT_CLASS } from './board-utils'

const DAY_MS = 86_400_000
const TREND_DAYS = 14
const STATUS_ORDER: TaskStatus[] = ['pending', 'in_progress', 'blocked', 'in_review', 'completed']

interface DashboardViewProps {
  items: TaskBoardItem[]
}

export function DashboardView({ items }: DashboardViewProps): React.JSX.Element {
  const { t, i18n } = useTranslation('taskboard')
  const selectTask = useTaskBoardStore((s) => s.selectTask)

  const stats = useMemo(() => {
    const byStatus = new Map<TaskStatus, number>()
    for (const status of STATUS_ORDER) byStatus.set(status, 0)
    const sessions = new Set<string>()
    for (const item of items) {
      byStatus.set(item.status, (byStatus.get(item.status) ?? 0) + 1)
      sessions.add(item.sessionId)
    }
    const total = items.length
    const completed = byStatus.get('completed') ?? 0
    return {
      total,
      sessions: sessions.size,
      blocked: byStatus.get('blocked') ?? 0,
      completionRate: total === 0 ? 0 : Math.round((completed / total) * 100),
      byStatus
    }
  }, [items])

  const trend = useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const start = today.getTime() - (TREND_DAYS - 1) * DAY_MS
    const buckets = Array.from({ length: TREND_DAYS }, (_, i) => ({
      day: start + i * DAY_MS,
      created: 0,
      completed: 0
    }))
    for (const item of items) {
      const createdIdx = Math.floor((item.createdAt - start) / DAY_MS)
      if (createdIdx >= 0 && createdIdx < TREND_DAYS) buckets[createdIdx].created += 1
      if (item.status === 'completed') {
        const doneIdx = Math.floor((item.updatedAt - start) / DAY_MS)
        if (doneIdx >= 0 && doneIdx < TREND_DAYS) buckets[doneIdx].completed += 1
      }
    }
    return buckets.map((b) => ({
      ...b,
      label: new Date(b.day).toLocaleDateString(i18n.language, {
        month: 'numeric',
        day: 'numeric'
      })
    }))
  }, [items, i18n.language])

  const blockedItems = useMemo(() => items.filter((item) => item.status === 'blocked'), [items])

  const summaryCards = [
    {
      icon: <ListTodo className="size-4 text-blue-500" />,
      label: t('dashboard.total', { defaultValue: 'Total tasks' }),
      value: stats.total
    },
    {
      icon: <MessagesSquare className="size-4 text-violet-500" />,
      label: t('dashboard.activeSessions', { defaultValue: 'Sessions with tasks' }),
      value: stats.sessions
    },
    {
      icon: <AlertOctagon className="size-4 text-red-500" />,
      label: t('dashboard.blockedTasks', { defaultValue: 'Blocked tasks' }),
      value: stats.blocked
    },
    {
      icon: <CheckCircle2 className="size-4 text-emerald-500" />,
      label: t('dashboard.completionRate', { defaultValue: 'Completion rate' }),
      value: `${stats.completionRate}%`
    }
  ]

  return (
    <div className="h-full space-y-4 overflow-y-auto p-4">
      <StaggerContainer className="grid grid-cols-2 gap-3 lg:grid-cols-4" delay={0.05}>
        {summaryCards.map((card) => (
          <StaggerItem key={card.label} className="rounded-xl border bg-card p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {card.icon}
              {card.label}
            </div>
            <p className="mt-2 text-2xl font-semibold">{card.value}</p>
          </StaggerItem>
        ))}
      </StaggerContainer>

      <FadeIn delay={0.15} className="grid gap-4 lg:grid-cols-2">
        <div className="min-w-0 rounded-xl border bg-card p-4">
          <p className="mb-3 text-sm font-medium">
            {t('dashboard.byStatus', { defaultValue: 'Status distribution' })}
          </p>
          <div className="space-y-2">
            {STATUS_ORDER.map((status) => {
              const count = stats.byStatus.get(status) ?? 0
              const pct = stats.total === 0 ? 0 : Math.round((count / stats.total) * 100)
              return (
                <div key={status} className="flex items-center gap-2 text-xs">
                  <span className={cn('size-2 shrink-0 rounded-full', STATUS_DOT_CLASS[status])} />
                  <span className="w-20 shrink-0">
                    {t(`columns.${status}`, { defaultValue: status })}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn('h-full rounded-full', STATUS_DOT_CLASS[status])}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="w-8 text-right text-muted-foreground">{count}</span>
                </div>
              )
            })}
          </div>
        </div>

        <div className="min-w-0 rounded-xl border bg-card p-4">
          <p className="mb-3 text-sm font-medium">
            {t('dashboard.trend', { defaultValue: 'Last 14 days' })}
          </p>
          <div className="h-44 min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={trend} margin={{ top: 4, right: 4, bottom: 0, left: -24 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                <YAxis
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  cursor={{ fill: 'hsl(var(--muted) / 0.4)' }}
                  contentStyle={{ fontSize: 12, borderRadius: 8 }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar
                  dataKey="created"
                  name={t('dashboard.trendCreated', { defaultValue: 'Created' })}
                  fill="#3b82f6"
                  radius={[3, 3, 0, 0]}
                />
                <Bar
                  dataKey="completed"
                  name={t('dashboard.trendCompleted', { defaultValue: 'Completed' })}
                  fill="#10b981"
                  radius={[3, 3, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </FadeIn>

      <FadeIn delay={0.25} className="rounded-xl border bg-card p-4">
        <p className="mb-3 text-sm font-medium">
          {t('dashboard.blockedList', { defaultValue: 'Currently blocked' })}
        </p>
        {blockedItems.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t('dashboard.noBlocked', { defaultValue: 'Nothing is blocked' })}
          </p>
        ) : (
          <div className="space-y-1">
            {blockedItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => selectTask(item.id)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/50"
              >
                <span className="size-2 shrink-0 rounded-full bg-red-500" />
                <span className="font-mono text-[11px] text-muted-foreground">
                  {shortTaskId(item.id)}
                </span>
                <span className="min-w-0 flex-1 truncate">{item.subject}</span>
                <span className="hidden truncate text-xs text-muted-foreground md:block md:max-w-40">
                  {item.sessionTitle || item.sessionId.slice(0, 8)}
                </span>
              </button>
            ))}
          </div>
        )}
      </FadeIn>
    </div>
  )
}
