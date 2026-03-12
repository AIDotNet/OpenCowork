import * as React from 'react'
import {
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Loader2,
  Pencil,
  Play,
  Plus,
  Power,
  PowerOff,
  Trash2,
  XCircle
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Textarea } from '@renderer/components/ui/textarea'
import { Separator } from '@renderer/components/ui/separator'
import { cn } from '@renderer/lib/utils'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { cronEvents } from '@renderer/lib/tools/cron-events'
import { useChatStore, type Session } from '@renderer/stores/chat-store'
import {
  useCronStore,
  type CronJobEntry,
  type CronRunEntry,
  type CronSchedule
} from '@renderer/stores/cron-store'
import type { UnifiedMessage } from '@renderer/lib/api/types'
import {
  dateKeyFromDate,
  endOfLocalDay,
  formatDateTimeLabel,
  formatDayLabel,
  formatTimeLabel,
  listPlannedTimesForDay,
  scheduleKindLabel,
  scheduleSummary,
  startOfLocalDay
} from './task-schedule'
import { RunTranscriptThread } from './RunTranscriptThread'

type StatusFilter = 'all' | 'enabled' | 'disabled' | 'running' | 'success' | 'error' | 'aborted'

interface TimelineItem {
  jobId: string
  job: CronJobEntry | null
  runs: CronRunEntry[]
  plannedTimes: number[]
  name: string
  sourceSessionId: string | null
  sourceSessionTitle: string | null
  workingFolder: string | null
  model: string | null
  sortTime: number
}

interface RunDetailResponse {
  run: CronRunEntry
  job: CronJobEntry | null
  messages: UnifiedMessage[]
  logs: Array<{
    id: string
    timestamp: number
    type: 'start' | 'text' | 'tool_call' | 'tool_result' | 'error' | 'end'
    content: string
  }>
}

interface JobEditorFormState {
  id?: string
  name: string
  sessionId: string
  prompt: string
  scheduleKind: CronSchedule['kind']
  at: string
  everyMinutes: string
  expr: string
  tz: string
  model: string
  workingFolder: string
  deliveryMode: 'desktop' | 'session' | 'none'
  deliveryTarget: string
  deleteAfterRun: boolean
  maxIterations: string
}

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']
const INPUT_CLASS =
  'h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring'

function toDateTimeLocalValue(timestamp: number | null | undefined): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  const pad = (value: number): string => `${value}`.padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function fromDateTimeLocalValue(value: string): number | null {
  if (!value) return null
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? null : parsed
}

function buildEditorState(job?: CronJobEntry | null): JobEditorFormState {
  if (!job) {
    return {
      name: '',
      sessionId: '',
      prompt: '',
      scheduleKind: 'at',
      at: '',
      everyMinutes: '60',
      expr: '0 9 * * *',
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      model: '',
      workingFolder: '',
      deliveryMode: 'desktop',
      deliveryTarget: '',
      deleteAfterRun: false,
      maxIterations: '15'
    }
  }

  return {
    id: job.id,
    name: job.name,
    sessionId: job.sessionId ?? '',
    prompt: job.prompt,
    scheduleKind: job.schedule.kind,
    at: toDateTimeLocalValue(job.schedule.at),
    everyMinutes: job.schedule.every
      ? String(Math.max(1, Math.round(job.schedule.every / 60_000)))
      : '60',
    expr: job.schedule.expr ?? '0 9 * * *',
    tz: job.schedule.tz ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
    model: job.model ?? '',
    workingFolder: job.workingFolder ?? '',
    deliveryMode: (job.deliveryMode as JobEditorFormState['deliveryMode']) ?? 'desktop',
    deliveryTarget: job.deliveryTarget ?? '',
    deleteAfterRun: job.deleteAfterRun,
    maxIterations: String(job.maxIterations ?? 15)
  }
}

function buildSchedulePayload(form: JobEditorFormState): CronSchedule {
  if (form.scheduleKind === 'at') {
    return { kind: 'at', at: fromDateTimeLocalValue(form.at) }
  }
  if (form.scheduleKind === 'every') {
    return {
      kind: 'every',
      every: Math.max(1, Number.parseInt(form.everyMinutes || '60', 10)) * 60_000
    }
  }
  return { kind: 'cron', expr: form.expr.trim(), tz: form.tz.trim() || 'UTC' }
}

function getCalendarDays(year: number, month: number): Date[] {
  const first = new Date(year, month, 1)
  const start = new Date(year, month, 1 - first.getDay())
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    return date
  })
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function itemMatchesStatus(item: TimelineItem, statusFilter: StatusFilter): boolean {
  if (statusFilter === 'all') return true
  if (statusFilter === 'enabled') return !!item.job && item.job.enabled && !item.job.deletedAt
  if (statusFilter === 'disabled') return !!item.job && !item.job.enabled && !item.job.deletedAt
  if (statusFilter === 'running')
    return !!item.job?.executing || item.runs.some((run) => run.status === 'running')
  return item.runs.some((run) => run.status === statusFilter)
}

function getLatestRunStatus(item: TimelineItem): string | null {
  if (item.job?.executing || item.runs.some((run) => run.status === 'running')) return 'running'
  const latestRun = [...item.runs].sort((a, b) => b.startedAt - a.startedAt)[0]
  return latestRun?.status ?? null
}

function getStatusLabel(status: string | null, job?: CronJobEntry | null): string {
  if (status === 'running') return '运行中'
  if (status === 'success') return '成功'
  if (status === 'error') return '失败'
  if (status === 'aborted') return '中止'
  if (job) return job.enabled ? '已启用' : '已停用'
  return '历史记录'
}

function getStatusClass(status: string | null, job?: CronJobEntry | null): string {
  if (status === 'running') return 'bg-blue-500/10 text-blue-500'
  if (status === 'success') return 'bg-green-500/10 text-green-500'
  if (status === 'error') return 'bg-destructive/10 text-destructive'
  if (status === 'aborted') return 'bg-amber-500/10 text-amber-500'
  if (job?.enabled) return 'bg-emerald-500/10 text-emerald-500'
  return 'bg-muted text-muted-foreground'
}

function getSourceSessionMeta(
  item: TimelineItem,
  sessions: Session[]
): { title: string; model: string | null; workingFolder: string | null } {
  const session = item.sourceSessionId
    ? sessions.find((entry) => entry.id === item.sourceSessionId)
    : null
  return {
    title: item.sourceSessionTitle ?? session?.title ?? '未知会话',
    model: item.model ?? session?.modelId ?? null,
    workingFolder: item.workingFolder ?? session?.workingFolder ?? null
  }
}

export function TasksPage(): React.JSX.Element {
  const jobs = useCronStore((state) => state.jobs)
  const runs = useCronStore((state) => state.runs)
  const loadJobs = useCronStore((state) => state.loadJobs)
  const loadRuns = useCronStore((state) => state.loadRuns)
  const sessions = useChatStore((state) => state.sessions)
  const projects = useChatStore((state) => state.projects)

  const [selectedDateKey, setSelectedDateKey] = React.useState(() => dateKeyFromDate(new Date()))
  const [calendarCursor, setCalendarCursor] = React.useState(() => {
    const today = new Date()
    return { year: today.getFullYear(), month: today.getMonth() }
  })
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>('all')
  const [sessionFilter, setSessionFilter] = React.useState('all')
  const [workingFolderFilter, setWorkingFolderFilter] = React.useState('')
  const [selectedJobId, setSelectedJobId] = React.useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null)
  const [detailLoading, setDetailLoading] = React.useState(false)
  const [runDetail, setRunDetail] = React.useState<RunDetailResponse | null>(null)
  const [editorOpen, setEditorOpen] = React.useState(false)
  const [editorMode, setEditorMode] = React.useState<'create' | 'edit'>('create')
  const [editorForm, setEditorForm] = React.useState<JobEditorFormState>(() => buildEditorState())
  const [submitting, setSubmitting] = React.useState(false)

  const selectedDate = React.useMemo(() => {
    const [year, month, day] = selectedDateKey.split('-').map((value) => Number.parseInt(value, 10))
    return new Date(year, month - 1, day)
  }, [selectedDateKey])

  const selectedDay = React.useMemo(
    () => ({
      key: selectedDateKey,
      date: selectedDate,
      start: startOfLocalDay(selectedDate).getTime(),
      end: endOfLocalDay(selectedDate).getTime(),
      isToday: isSameDay(selectedDate, new Date())
    }),
    [selectedDate, selectedDateKey]
  )

  const calendarDays = React.useMemo(
    () => getCalendarDays(calendarCursor.year, calendarCursor.month),
    [calendarCursor.month, calendarCursor.year]
  )

  const refreshAll = React.useCallback(async (): Promise<void> => {
    await Promise.all([loadJobs(), loadRuns()])
  }, [loadJobs, loadRuns])

  React.useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  React.useEffect(() => {
    return cronEvents.on((event) => {
      if (event.type === 'run_finished' || event.type === 'job_removed' || event.type === 'fired') {
        void refreshAll()
      }
    })
  }, [refreshAll])

  const timelineItems = React.useMemo(() => {
    const runsByJobId = new Map<string, CronRunEntry[]>()
    for (const run of runs) {
      if (run.startedAt < selectedDay.start || run.startedAt > selectedDay.end) continue
      const existing = runsByJobId.get(run.jobId) ?? []
      existing.push(run)
      runsByJobId.set(run.jobId, existing)
    }

    const items: TimelineItem[] = []
    const seenJobIds = new Set<string>()

    for (const job of jobs) {
      const plannedTimes = listPlannedTimesForDay(job, selectedDay.start, selectedDay.end)
      const dayRuns = [...(runsByJobId.get(job.id) ?? [])].sort((a, b) => b.startedAt - a.startedAt)
      if (plannedTimes.length === 0 && dayRuns.length === 0) continue
      seenJobIds.add(job.id)
      items.push({
        jobId: job.id,
        job,
        runs: dayRuns,
        plannedTimes,
        name: job.name,
        sourceSessionId: job.sessionId,
        sourceSessionTitle: job.sourceSessionTitle,
        workingFolder: job.workingFolder,
        model: job.model,
        sortTime: Math.min(...[...plannedTimes, ...dayRuns.map((run) => run.startedAt)])
      })
    }

    for (const [jobId, dayRuns] of runsByJobId.entries()) {
      if (seenJobIds.has(jobId)) continue
      const latestRun = [...dayRuns].sort((a, b) => b.startedAt - a.startedAt)[0]
      items.push({
        jobId,
        job: null,
        runs: [...dayRuns].sort((a, b) => b.startedAt - a.startedAt),
        plannedTimes: [],
        name: latestRun?.jobNameSnapshot ?? jobId,
        sourceSessionId: latestRun?.sourceSessionIdSnapshot ?? null,
        sourceSessionTitle: latestRun?.sourceSessionTitleSnapshot ?? null,
        workingFolder: latestRun?.workingFolderSnapshot ?? null,
        model: latestRun?.modelSnapshot ?? null,
        sortTime: Math.min(...dayRuns.map((run) => run.startedAt))
      })
    }

    return items.sort((a, b) => a.sortTime - b.sortTime)
  }, [jobs, runs, selectedDay.end, selectedDay.start])

  const filteredTimelineItems = React.useMemo(() => {
    const workingFolderQuery = workingFolderFilter.trim().toLowerCase()
    return timelineItems.filter((item) => {
      if (sessionFilter !== 'all' && item.sourceSessionId !== sessionFilter) return false
      if (!itemMatchesStatus(item, statusFilter)) return false
      if (workingFolderQuery) {
        const target = item.workingFolder?.toLowerCase() ?? ''
        if (!target.includes(workingFolderQuery)) return false
      }
      return true
    })
  }, [sessionFilter, statusFilter, timelineItems, workingFolderFilter])

  const calendarCounts = React.useMemo(() => {
    const map = new Map<string, number>()
    for (const date of calendarDays) {
      const dayStart = startOfLocalDay(date).getTime()
      const dayEnd = endOfLocalDay(date).getTime()
      const dayKey = dateKeyFromDate(date)
      const ids = new Set<string>()

      for (const job of jobs) {
        const pseudoItem: TimelineItem = {
          jobId: job.id,
          job,
          runs: runs.filter(
            (run) => run.jobId === job.id && run.startedAt >= dayStart && run.startedAt <= dayEnd
          ),
          plannedTimes: listPlannedTimesForDay(job, dayStart, dayEnd),
          name: job.name,
          sourceSessionId: job.sessionId,
          sourceSessionTitle: job.sourceSessionTitle,
          workingFolder: job.workingFolder,
          model: job.model,
          sortTime: dayStart
        }
        if (pseudoItem.plannedTimes.length === 0 && pseudoItem.runs.length === 0) continue
        if (sessionFilter !== 'all' && pseudoItem.sourceSessionId !== sessionFilter) continue
        if (!itemMatchesStatus(pseudoItem, statusFilter)) continue
        if (workingFolderFilter.trim()) {
          const target = pseudoItem.workingFolder?.toLowerCase() ?? ''
          if (!target.includes(workingFolderFilter.trim().toLowerCase())) continue
        }
        ids.add(job.id)
      }

      for (const run of runs) {
        if (run.startedAt < dayStart || run.startedAt > dayEnd) continue
        const existingJob = jobs.find((job) => job.id === run.jobId)
        if (existingJob) continue
        if (sessionFilter !== 'all' && run.sourceSessionIdSnapshot !== sessionFilter) continue
        if (statusFilter !== 'all' && run.status !== statusFilter) continue
        if (workingFolderFilter.trim()) {
          const target = run.workingFolderSnapshot?.toLowerCase() ?? ''
          if (!target.includes(workingFolderFilter.trim().toLowerCase())) continue
        }
        ids.add(run.jobId)
      }

      map.set(dayKey, ids.size)
    }
    return map
  }, [calendarDays, jobs, runs, sessionFilter, statusFilter, workingFolderFilter])

  const handleSelectCalendarDate = React.useCallback((date: Date) => {
    setSelectedDateKey(dateKeyFromDate(date))
  }, [])

  const goPrevMonth = React.useCallback(() => {
    setCalendarCursor((state) => {
      const month = state.month === 0 ? 11 : state.month - 1
      const year = state.month === 0 ? state.year - 1 : state.year
      return { year, month }
    })
  }, [])

  const goNextMonth = React.useCallback(() => {
    setCalendarCursor((state) => {
      const month = state.month === 11 ? 0 : state.month + 1
      const year = state.month === 11 ? state.year + 1 : state.year
      return { year, month }
    })
  }, [])

  const goToday = React.useCallback(() => {
    const today = new Date()
    setCalendarCursor({ year: today.getFullYear(), month: today.getMonth() })
    setSelectedDateKey(dateKeyFromDate(today))
  }, [])

  React.useEffect(() => {
    if (filteredTimelineItems.length === 0) {
      setSelectedJobId(null)
      setSelectedRunId(null)
      return
    }
    if (!selectedJobId || !filteredTimelineItems.some((item) => item.jobId === selectedJobId)) {
      setSelectedJobId(filteredTimelineItems[0].jobId)
    }
  }, [filteredTimelineItems, selectedJobId])

  const selectedItem = React.useMemo(
    () => filteredTimelineItems.find((item) => item.jobId === selectedJobId) ?? null,
    [filteredTimelineItems, selectedJobId]
  )

  React.useEffect(() => {
    if (!selectedItem) {
      setSelectedRunId(null)
      return
    }
    const latestRun = [...selectedItem.runs].sort((a, b) => b.startedAt - a.startedAt)[0]
    if (!latestRun) {
      setSelectedRunId(null)
      return
    }
    if (!selectedRunId || !selectedItem.runs.some((run) => run.id === selectedRunId)) {
      setSelectedRunId(latestRun.id)
    }
  }, [selectedItem, selectedRunId])

  React.useEffect(() => {
    if (!selectedRunId) {
      setRunDetail(null)
      return
    }

    let disposed = false
    setDetailLoading(true)
    ipcClient
      .invoke(IPC.CRON_RUN_DETAIL, { runId: selectedRunId })
      .then((result) => {
        if (disposed) return
        if (!result || 'error' in (result as Record<string, unknown>)) {
          setRunDetail(null)
          return
        }
        setRunDetail(result as RunDetailResponse)
      })
      .catch((error) => {
        console.error('[TasksPage] Failed to load run detail:', error)
        if (!disposed) setRunDetail(null)
      })
      .finally(() => {
        if (!disposed) setDetailLoading(false)
      })

    return () => {
      disposed = true
    }
  }, [selectedRunId])

  const openCreateDialog = React.useCallback(() => {
    setEditorMode('create')
    setEditorForm(buildEditorState())
    setEditorOpen(true)
  }, [])

  const openEditDialog = React.useCallback((job: CronJobEntry) => {
    setEditorMode('edit')
    setEditorForm(buildEditorState(job))
    setEditorOpen(true)
  }, [])

  const handleSessionPreset = React.useCallback(
    (sessionId: string) => {
      const session = sessions.find((entry) => entry.id === sessionId)
      setEditorForm((state) => ({
        ...state,
        sessionId,
        model: session?.modelId ?? state.model,
        workingFolder: session?.workingFolder ?? state.workingFolder
      }))
    },
    [sessions]
  )

  const handleSubmit = React.useCallback(async () => {
    if (!editorForm.name.trim() || !editorForm.prompt.trim()) {
      toast.error('任务名称和 Prompt 不能为空')
      return
    }

    const session = sessions.find((entry) => entry.id === editorForm.sessionId)
    const project = session?.projectId
      ? projects.find((entry) => entry.id === session.projectId)
      : null

    const payload = {
      name: editorForm.name.trim(),
      sessionId: editorForm.sessionId || undefined,
      schedule: buildSchedulePayload(editorForm),
      prompt: editorForm.prompt.trim(),
      model: editorForm.model.trim() || null,
      workingFolder: editorForm.workingFolder.trim() || null,
      deliveryMode: editorForm.deliveryMode,
      deliveryTarget: editorForm.deliveryTarget.trim() || null,
      deleteAfterRun: editorForm.deleteAfterRun,
      maxIterations: Math.max(1, Number.parseInt(editorForm.maxIterations || '15', 10)),
      sourceSessionTitle: session?.title ?? null,
      sourceProjectId: project?.id ?? null,
      sourceProjectName: project?.name ?? null,
      sourceProviderId: session?.providerId ?? null
    }

    setSubmitting(true)
    try {
      const result =
        editorMode === 'create'
          ? await ipcClient.invoke(IPC.CRON_ADD, payload)
          : await ipcClient.invoke(IPC.CRON_UPDATE, {
              jobId: editorForm.id,
              patch: payload
            })

      if (result && typeof result === 'object' && 'error' in (result as Record<string, unknown>)) {
        toast.error(String((result as { error: string }).error))
        return
      }

      setEditorOpen(false)
      await refreshAll()
      toast.success(editorMode === 'create' ? '任务已创建' : '任务已更新')
    } catch (error) {
      console.error('[TasksPage] Failed to save cron job:', error)
      toast.error('保存任务失败')
    } finally {
      setSubmitting(false)
    }
  }, [editorForm, editorMode, projects, refreshAll, sessions])

  const handleRunNow = React.useCallback(
    async (jobId: string) => {
      const result = await ipcClient.invoke(IPC.CRON_RUN_NOW, { jobId })
      if (result && typeof result === 'object' && 'error' in (result as Record<string, unknown>)) {
        toast.error(String((result as { error: string }).error))
        return
      }
      toast.success('已触发立即执行')
      await refreshAll()
    },
    [refreshAll]
  )

  const handleToggle = React.useCallback(
    async (job: CronJobEntry) => {
      const result = await ipcClient.invoke(IPC.CRON_TOGGLE, {
        jobId: job.id,
        enabled: !job.enabled
      })
      if (result && typeof result === 'object' && 'error' in (result as Record<string, unknown>)) {
        toast.error(String((result as { error: string }).error))
        return
      }
      await refreshAll()
    },
    [refreshAll]
  )

  const handleDelete = React.useCallback(
    async (job: CronJobEntry) => {
      const result = await ipcClient.invoke(IPC.CRON_REMOVE, { jobId: job.id })
      if (result && typeof result === 'object' && 'error' in (result as Record<string, unknown>)) {
        toast.error(String((result as { error: string }).error))
        return
      }
      toast.success('计划已删除，历史记录已保留')
      await refreshAll()
    },
    [refreshAll]
  )

  const selectedJob = selectedItem?.job ?? null
  const selectedMeta = selectedItem ? getSourceSessionMeta(selectedItem, sessions) : null
  const selectedStatus = selectedItem ? getLatestRunStatus(selectedItem) : null
  const monthTitle = `${calendarCursor.year}年 ${calendarCursor.month + 1}月`
  const todayKey = dateKeyFromDate(new Date())

  return (
    <div className="grid h-full min-w-0 grid-cols-[minmax(340px,380px)_minmax(0,1fr)] gap-4 bg-muted/10 p-4">
      <div className="grid min-w-0 min-h-0 grid-rows-[360px_minmax(0,1fr)] gap-4">
        <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border/60 bg-background shadow-sm">
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <div className="text-sm font-semibold text-foreground">任务日历</div>
              <div className="text-[11px] text-muted-foreground">按天查看计划与执行</div>
            </div>
            <Button size="sm" className="h-7 px-2 text-xs" onClick={openCreateDialog}>
              <Plus className="mr-1 size-3.5" />
              新建
            </Button>
          </div>
          <div className="flex items-center justify-between px-4 pb-2">
            <div className="flex items-center gap-1">
              <Button size="icon" variant="ghost" className="size-7" onClick={goPrevMonth}>
                <ChevronLeft className="size-4" />
              </Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={goToday}>
                {monthTitle}
              </Button>
              <Button size="icon" variant="ghost" className="size-7" onClick={goNextMonth}>
                <ChevronRight className="size-4" />
              </Button>
            </div>
            <span className="text-[11px] text-muted-foreground">默认显示本地时间</span>
          </div>
          <div className="grid grid-cols-7 gap-1 px-4 pb-2 text-center text-[10px] text-muted-foreground">
            {WEEKDAY_LABELS.map((label) => (
              <div key={label}>{label}</div>
            ))}
          </div>
          <div className="grid flex-1 grid-cols-7 gap-1 px-4 pb-4">
            {calendarDays.map((date) => {
              const key = dateKeyFromDate(date)
              const active = key === selectedDateKey
              const inCurrentMonth = date.getMonth() === calendarCursor.month
              const isToday = key === todayKey
              const count = calendarCounts.get(key) ?? 0
              return (
                <button
                  key={key}
                  type="button"
                  className={cn(
                    'relative flex min-h-[38px] flex-col items-start rounded-lg border px-2 py-1 text-left transition-colors',
                    active
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-transparent hover:bg-muted/60',
                    !inCurrentMonth && 'text-muted-foreground/40',
                    isToday && !active && 'ring-1 ring-blue-500/30'
                  )}
                  onClick={() => handleSelectCalendarDate(date)}
                >
                  <span className="text-xs font-medium">{date.getDate()}</span>
                  <div className="mt-auto flex items-center gap-1">
                    {count > 0 && <span className="size-1.5 rounded-full bg-primary" />}
                    <span className="text-[10px] text-muted-foreground">{count}</span>
                  </div>
                </button>
              )
            })}
          </div>
        </section>

        <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border/60 bg-background shadow-sm">
          <div className="border-b border-border/60 px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <CalendarDays className="size-4 text-primary" />
              {formatDayLabel(selectedDay.date)}
              <span className="text-xs text-muted-foreground">
                {selectedDay.date.toLocaleDateString('zh-CN')}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <select
                className={INPUT_CLASS}
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
              >
                <option value="all">全部状态</option>
                <option value="enabled">已启用</option>
                <option value="disabled">已停用</option>
                <option value="running">运行中</option>
                <option value="success">成功</option>
                <option value="error">失败</option>
                <option value="aborted">中止</option>
              </select>
              <select
                className={INPUT_CLASS}
                value={sessionFilter}
                onChange={(event) => setSessionFilter(event.target.value)}
              >
                <option value="all">全部会话</option>
                {sessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.title}
                  </option>
                ))}
              </select>
              <Input
                className="h-8 text-xs"
                value={workingFolderFilter}
                onChange={(event) => setWorkingFolderFilter(event.target.value)}
                placeholder="筛选工作目录"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {filteredTimelineItems.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
                <CalendarDays className="size-10 opacity-30" />
                <div className="text-sm">这一天没有符合筛选条件的任务</div>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredTimelineItems.map((item) => {
                  const meta = getSourceSessionMeta(item, sessions)
                  const status = getLatestRunStatus(item)
                  return (
                    <button
                      key={item.jobId}
                      type="button"
                      className={cn(
                        'w-full rounded-xl border px-3 py-3 text-left transition-colors',
                        selectedItem?.jobId === item.jobId
                          ? 'border-primary/40 bg-primary/5'
                          : 'border-border/60 hover:bg-muted/40'
                      )}
                      onClick={() => setSelectedJobId(item.jobId)}
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                          <Clock3 className="size-4 text-muted-foreground" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-foreground">
                              {item.name}
                            </span>
                            <span
                              className={cn(
                                'rounded px-1.5 py-0.5 text-[10px] font-medium',
                                getStatusClass(status, item.job)
                              )}
                            >
                              {getStatusLabel(status, item.job)}
                            </span>
                            {item.job && (
                              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                {scheduleKindLabel(item.job.schedule.kind)}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                            <span>来源：{meta.title}</span>
                            {meta.model && <span>模型：{meta.model}</span>}
                            {item.plannedTimes.length > 0 && (
                              <span>
                                计划：
                                {item.plannedTimes
                                  .slice(0, 3)
                                  .map((time) => formatTimeLabel(time))
                                  .join('、')}
                                {item.plannedTimes.length > 3
                                  ? ` +${item.plannedTimes.length - 3}`
                                  : ''}
                              </span>
                            )}
                            {item.runs.length > 0 && <span>执行：{item.runs.length} 次</span>}
                          </div>
                          {meta.workingFolder && (
                            <div className="mt-1 truncate text-[11px] text-muted-foreground">
                              {meta.workingFolder}
                            </div>
                          )}
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </section>
      </div>

      <section className="flex min-w-0 min-h-0 flex-col overflow-hidden rounded-2xl border border-border/60 bg-background shadow-sm">
        {selectedItem ? (
          <>
            <div className="border-b border-border/60 px-4 py-3">
              <div className="flex items-start gap-3">
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-base font-semibold text-foreground">
                      {selectedItem.name}
                    </h2>
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[10px] font-medium',
                        getStatusClass(selectedStatus, selectedItem.job)
                      )}
                    >
                      {getStatusLabel(selectedStatus, selectedItem.job)}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
                    <div>来源会话：{selectedMeta?.title ?? '—'}</div>
                    <div>模型：{selectedMeta?.model ?? '—'}</div>
                    <div className="truncate">工作目录：{selectedMeta?.workingFolder ?? '—'}</div>
                    <div>
                      计划时间：
                      {selectedItem.plannedTimes.length > 0
                        ? selectedItem.plannedTimes.map((time) => formatTimeLabel(time)).join('、')
                        : selectedJob
                          ? scheduleSummary(selectedJob)
                          : '—'}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {selectedJob && !selectedJob.deletedAt && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs"
                        onClick={() => void handleRunNow(selectedJob.id)}
                      >
                        <Play className="mr-1 size-3.5" />
                        立即执行
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs"
                        onClick={() => void handleToggle(selectedJob)}
                      >
                        {selectedJob.enabled ? (
                          <>
                            <PowerOff className="mr-1 size-3.5" />
                            停用
                          </>
                        ) : (
                          <>
                            <Power className="mr-1 size-3.5" />
                            启用
                          </>
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs"
                        onClick={() => openEditDialog(selectedJob)}
                      >
                        <Pencil className="mr-1 size-3.5" />
                        编辑
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs text-destructive"
                        onClick={() => void handleDelete(selectedJob)}
                      >
                        <Trash2 className="mr-1 size-3.5" />
                        删除计划
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="flex min-h-0 flex-1">
              <div className="flex w-72 shrink-0 flex-col border-r border-border/60">
                <div className="px-4 py-3 text-sm font-medium text-foreground">当日运行记录</div>
                <Separator />
                <div className="flex-1 overflow-y-auto p-3">
                  {selectedItem.runs.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
                      <CheckCircle2 className="size-9 opacity-30" />
                      <div className="text-sm">当天还没有执行记录</div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {selectedItem.runs.map((run) => (
                        <button
                          key={run.id}
                          type="button"
                          className={cn(
                            'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                            selectedRunId === run.id
                              ? 'border-primary/40 bg-primary/5'
                              : 'border-border/60 hover:bg-muted/40'
                          )}
                          onClick={() => setSelectedRunId(run.id)}
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className={cn(
                                'rounded px-1.5 py-0.5 text-[10px] font-medium',
                                getStatusClass(run.status)
                              )}
                            >
                              {getStatusLabel(run.status)}
                            </span>
                            <span className="text-xs text-foreground">
                              {formatTimeLabel(run.startedAt)}
                            </span>
                          </div>
                          <div className="mt-1 text-[11px] text-muted-foreground">
                            工具调用：{run.toolCallCount}
                          </div>
                          {(run.error || run.outputSummary) && (
                            <div className="mt-1 truncate text-[11px] text-muted-foreground">
                              {run.error ?? run.outputSummary}
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="min-w-0 flex-1 overflow-y-auto p-4">
                {selectedRunId ? (
                  detailLoading ? (
                    <div className="flex h-full items-center justify-center text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" />
                    </div>
                  ) : runDetail ? (
                    <div className="space-y-4">
                      <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
                        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
                          <div>
                            <span className="text-muted-foreground">来源会话：</span>
                            <span className="text-foreground">
                              {runDetail.run.sourceSessionTitleSnapshot ??
                                selectedMeta?.title ??
                                '—'}
                            </span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">状态：</span>
                            <span className="text-foreground">
                              {getStatusLabel(runDetail.run.status)}
                            </span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">工作目录：</span>
                            <span className="text-foreground">
                              {runDetail.run.workingFolderSnapshot ?? '—'}
                            </span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">模型：</span>
                            <span className="text-foreground">
                              {runDetail.run.modelSnapshot ?? '—'}
                            </span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">计划时间：</span>
                            <span className="text-foreground">
                              {formatDateTimeLabel(runDetail.run.scheduledFor)}
                            </span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">开始时间：</span>
                            <span className="text-foreground">
                              {formatDateTimeLabel(runDetail.run.startedAt)}
                            </span>
                          </div>
                        </div>
                      </div>

                      {runDetail.messages.length > 0 ? (
                        <RunTranscriptThread messages={runDetail.messages} />
                      ) : (
                        <div className="space-y-3">
                          <div className="rounded-xl border border-dashed border-border/60 bg-muted/10 p-4 text-sm text-muted-foreground">
                            这是旧记录，暂无完整回放。已降级显示基础信息、摘要和轻量日志。
                          </div>
                          {runDetail.run.outputSummary && (
                            <div className="rounded-xl border border-border/60 p-3">
                              <div className="mb-2 text-sm font-medium text-foreground">
                                输出摘要
                              </div>
                              <div className="whitespace-pre-wrap text-sm text-muted-foreground">
                                {runDetail.run.outputSummary}
                              </div>
                            </div>
                          )}
                          {runDetail.run.error && (
                            <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3">
                              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-destructive">
                                <XCircle className="size-4" />
                                错误信息
                              </div>
                              <div className="whitespace-pre-wrap text-sm text-destructive/80">
                                {runDetail.run.error}
                              </div>
                            </div>
                          )}
                          {runDetail.logs.length > 0 && (
                            <div className="rounded-xl border border-border/60 p-3">
                              <div className="mb-2 text-sm font-medium text-foreground">
                                Agent 执行日志
                              </div>
                              <div className="space-y-1">
                                {runDetail.logs.map((log) => (
                                  <div
                                    key={log.id}
                                    className="flex items-start gap-2 text-[12px] text-muted-foreground"
                                  >
                                    <span className="w-16 shrink-0 tabular-nums">
                                      {formatTimeLabel(log.timestamp)}
                                    </span>
                                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                                      {log.type}
                                    </span>
                                    <span className="min-w-0 flex-1 break-words">
                                      {log.content}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex h-full items-center justify-center text-muted-foreground">
                      暂无详情
                    </div>
                  )
                ) : (
                  <div className="flex h-full items-center justify-center text-muted-foreground">
                    选择一次运行以查看详情
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center p-6">
            <div className="flex w-full max-w-md flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border/70 bg-muted/10 px-6 py-10 text-center text-muted-foreground">
              <CalendarDays className="size-10 opacity-30" />
              <div className="text-sm font-medium text-foreground/80">请选择左侧某一天的任务</div>
              <div className="text-xs">选中任务后，这里会显示来源会话、运行记录和完整回放</div>
            </div>
          </div>
        )}
      </section>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editorMode === 'create' ? '新建任务' : '编辑任务'}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-1">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">任务名称</div>
                <Input
                  className="h-8 text-xs"
                  value={editorForm.name}
                  onChange={(event) =>
                    setEditorForm((state) => ({ ...state, name: event.target.value }))
                  }
                />
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">来源会话</div>
                <select
                  className={INPUT_CLASS}
                  value={editorForm.sessionId}
                  onChange={(event) => handleSessionPreset(event.target.value)}
                >
                  <option value="">不绑定会话</option>
                  {sessions.map((session) => (
                    <option key={session.id} value={session.id}>
                      {session.title}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Prompt</div>
              <Textarea
                className="min-h-28 text-xs"
                value={editorForm.prompt}
                onChange={(event) =>
                  setEditorForm((state) => ({ ...state, prompt: event.target.value }))
                }
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">调度类型</div>
                <select
                  className={INPUT_CLASS}
                  value={editorForm.scheduleKind}
                  onChange={(event) =>
                    setEditorForm((state) => ({
                      ...state,
                      scheduleKind: event.target.value as CronSchedule['kind']
                    }))
                  }
                >
                  <option value="at">一次性</option>
                  <option value="every">间隔</option>
                  <option value="cron">Cron</option>
                </select>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">模型</div>
                <Input
                  className="h-8 text-xs"
                  value={editorForm.model}
                  onChange={(event) =>
                    setEditorForm((state) => ({ ...state, model: event.target.value }))
                  }
                  placeholder="默认沿用会话/全局"
                />
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">最大迭代</div>
                <Input
                  className="h-8 text-xs"
                  value={editorForm.maxIterations}
                  onChange={(event) =>
                    setEditorForm((state) => ({ ...state, maxIterations: event.target.value }))
                  }
                />
              </div>
            </div>

            {editorForm.scheduleKind === 'at' && (
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">执行时间</div>
                <Input
                  className="h-8 text-xs"
                  type="datetime-local"
                  value={editorForm.at}
                  onChange={(event) =>
                    setEditorForm((state) => ({ ...state, at: event.target.value }))
                  }
                />
              </div>
            )}

            {editorForm.scheduleKind === 'every' && (
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">间隔（分钟）</div>
                <Input
                  className="h-8 text-xs"
                  value={editorForm.everyMinutes}
                  onChange={(event) =>
                    setEditorForm((state) => ({ ...state, everyMinutes: event.target.value }))
                  }
                />
              </div>
            )}

            {editorForm.scheduleKind === 'cron' && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">Cron 表达式</div>
                  <Input
                    className="h-8 text-xs"
                    value={editorForm.expr}
                    onChange={(event) =>
                      setEditorForm((state) => ({ ...state, expr: event.target.value }))
                    }
                  />
                </div>
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">时区</div>
                  <Input
                    className="h-8 text-xs"
                    value={editorForm.tz}
                    onChange={(event) =>
                      setEditorForm((state) => ({ ...state, tz: event.target.value }))
                    }
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">工作目录</div>
                <Input
                  className="h-8 text-xs"
                  value={editorForm.workingFolder}
                  onChange={(event) =>
                    setEditorForm((state) => ({ ...state, workingFolder: event.target.value }))
                  }
                />
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">投递方式</div>
                <select
                  className={INPUT_CLASS}
                  value={editorForm.deliveryMode}
                  onChange={(event) =>
                    setEditorForm((state) => ({
                      ...state,
                      deliveryMode: event.target.value as JobEditorFormState['deliveryMode']
                    }))
                  }
                >
                  <option value="desktop">桌面通知</option>
                  <option value="session">写入会话</option>
                  <option value="none">不投递</option>
                </select>
              </div>
            </div>

            {editorForm.deliveryMode === 'session' && (
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">
                  目标会话 ID（留空则沿用来源会话）
                </div>
                <Input
                  className="h-8 text-xs"
                  value={editorForm.deliveryTarget}
                  onChange={(event) =>
                    setEditorForm((state) => ({ ...state, deliveryTarget: event.target.value }))
                  }
                />
              </div>
            )}

            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={editorForm.deleteAfterRun}
                onChange={(event) =>
                  setEditorForm((state) => ({ ...state, deleteAfterRun: event.target.checked }))
                }
              />
              执行后删除计划（历史记录仍保留）
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void handleSubmit()} disabled={submitting}>
              {submitting ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
