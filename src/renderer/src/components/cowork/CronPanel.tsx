import * as React from 'react'
import {
  Clock,
  Play,
  Square,
  Trash2,
  RefreshCw,
  Plus,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Bot,
  CheckCircle2,
  XCircle,
  AlertCircle,
  History,
  StopCircle,
  Terminal,
  Wrench,
  Loader2,
  Timer,
  Repeat,
  CalendarClock,
  CalendarDays,
  ListFilter,
  FileText,
  Calendar
} from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { Button } from '@renderer/components/ui/button'
import { Separator } from '@renderer/components/ui/separator'
import {
  useCronStore,
  type CronJobEntry,
  type CronRunEntry,
  type CronAgentLogEntry,
  type CronSchedule
} from '@renderer/stores/cron-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { toast } from 'sonner'

const MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'

// ── Helpers ──────────────────────────────────────────────────────

function formatRelative(ts: number | null): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} minutes ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hours ago`
  return new Date(ts).toLocaleString()
}

function formatInterval(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`
  return `${(ms / 86_400_000).toFixed(1)}d`
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  if (m < 60) return `${m}m${rem > 0 ? `${rem}s` : ''}`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60}m`
}

// ── Elapsed Timer (updates every second) ─────────────────────────

function ElapsedTimer({ startedAt }: { startedAt: number }): React.JSX.Element {
  const [elapsed, setElapsed] = React.useState(0)

  React.useEffect(() => {
    setElapsed(Date.now() - startedAt)
    const interval = setInterval(() => setElapsed(Date.now() - startedAt), 1000)
    return () => clearInterval(interval)
  }, [startedAt])

  return (
    <span className="tabular-nums text-blue-400/80" style={{ fontFamily: MONO_FONT }}>
      {formatDuration(elapsed)}
    </span>
  )
}

function scheduleLabel(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case 'at':
      return schedule.at ? new Date(schedule.at).toLocaleString() : '—'
    case 'every':
      return schedule.every ? `Every ${formatInterval(schedule.every)}` : '—'
    case 'cron':
      return schedule.expr ?? '—'
  }
}

function ScheduleIcon({ kind }: { kind: CronSchedule['kind'] }): React.JSX.Element {
  switch (kind) {
    case 'at':
      return <CalendarClock className="size-3 text-amber-400/80" />
    case 'every':
      return <Repeat className="size-3 text-cyan-400/80" />
    case 'cron':
      return <Timer className="size-3 text-violet-400/80" />
  }
}

function scheduleKindBadge(kind: CronSchedule['kind']): React.JSX.Element {
  const labels = { at: 'Once', every: 'Interval', cron: 'Cron' }
  const colors = {
    at: 'bg-amber-500/10 text-amber-400',
    every: 'bg-cyan-500/10 text-cyan-400',
    cron: 'bg-violet-500/10 text-violet-400'
  }
  return <span className={cn('rounded px-1 py-px text-[8px]', colors[kind])}>{labels[kind]}</span>
}

// ── Agent Log Panel ──────────────────────────────────────────────

const EMPTY_LOGS: CronAgentLogEntry[] = []

function AgentLogPanel({ jobId }: { jobId: string }): React.JSX.Element | null {
  const logs = useCronStore((s) => s.agentLogs[jobId] ?? EMPTY_LOGS)
  const scrollRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs.length])

  if (logs.length === 0) return null

  const logIcon = (type: CronAgentLogEntry['type']): React.JSX.Element => {
    switch (type) {
      case 'start':
        return <Loader2 className="size-2.5 text-blue-400 animate-spin" />
      case 'tool_call':
        return <Wrench className="size-2.5 text-violet-400" />
      case 'tool_result':
        return <Terminal className="size-2.5 text-green-400" />
      case 'error':
        return <XCircle className="size-2.5 text-destructive" />
      case 'end':
        return <CheckCircle2 className="size-2.5 text-green-500" />
      default:
        return <Bot className="size-2.5 text-muted-foreground" />
    }
  }

  return (
    <div className="border-t bg-muted/20">
      <div ref={scrollRef} className="max-h-[160px] overflow-y-auto px-3 py-2 space-y-1">
        {logs.map((entry, i) => (
          <div key={i} className="flex items-start gap-1.5 text-[10px]">
            <span className="mt-px shrink-0">{logIcon(entry.type)}</span>
            <span
              className="text-muted-foreground/40 shrink-0 tabular-nums"
              style={{ fontFamily: MONO_FONT }}
            >
              {new Date(entry.timestamp).toLocaleTimeString()}
            </span>
            <span
              className={cn(
                'truncate',
                entry.type === 'error' ? 'text-destructive/70' : 'text-muted-foreground/60'
              )}
            >
              {entry.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── CronJobCard ───────────────────────────────────────────────────

function CronJobCard({
  job,
  runs,
  onToggle,
  onRemove,
  onRunNow
}: {
  job: CronJobEntry
  runs: CronRunEntry[]
  onToggle: (id: string, enabled: boolean) => void
  onRemove: (id: string) => void
  onRunNow: (id: string) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false)
  const [runNowLoading, setRunNowLoading] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const hasAgentLogs = useCronStore((s) => (s.agentLogs[job.id]?.length ?? 0) > 0)
  const jobRuns = runs.filter((r) => r.jobId === job.id).slice(0, 5)

  const handleRunNow = async (): Promise<void> => {
    setRunNowLoading(true)
    try {
      await onRunNow(job.id)
    } finally {
      setRunNowLoading(false)
    }
  }

  const handleAbortAgent = (): void => {
    void ipcClient
      .invoke(IPC.CRON_ABORT_RUN, { jobId: job.id })
      .then((result) => {
        const payload = result as { success?: boolean; error?: string }
        if (payload?.success) {
          toast.info('Agent execution aborted')
        } else {
          toast.error(payload?.error ?? 'Failed to abort Agent execution')
        }
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : 'Failed to abort Agent execution')
      })
  }

  return (
    <div
      className={cn(
        'rounded-lg border bg-card transition-colors overflow-hidden',
        !job.enabled && 'opacity-50',
        job.executing && 'border-blue-500/30 ring-1 ring-blue-500/10'
      )}
    >
      {/* Execution progress bar (indeterminate) */}
      {job.executing && (
        <div className="h-[2px] w-full bg-blue-500/10 overflow-hidden">
          <div
            className="h-full w-1/3 bg-blue-500/60 rounded-full animate-[slideRight_1.5s_ease-in-out_infinite]"
            style={{
              animation: 'slideRight 1.5s ease-in-out infinite'
            }}
          />
          <style>{`
            @keyframes slideRight {
              0% { transform: translateX(-100%); }
              100% { transform: translateX(400%); }
            }
          `}</style>
        </div>
      )}

      {/* Header row */}
      <div className="flex items-start gap-2 px-3 py-2.5">
        {/* Status dot */}
        <span className="mt-0.5 shrink-0">
          {job.executing ? (
            <span className="relative flex size-2.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex size-2.5 rounded-full bg-blue-500" />
            </span>
          ) : job.enabled && job.scheduled ? (
            <span className="size-2.5 rounded-full bg-green-500/70 inline-flex" />
          ) : (
            <span className="size-2.5 rounded-full border border-muted-foreground/30 inline-flex" />
          )}
        </span>

        {/* Main info */}
        <div className="min-w-0 flex-1">
          {/* Row 1: Name + schedule badge */}
          <div className="flex items-center gap-1.5">
            <p className="text-[12px] font-medium text-foreground/90 truncate leading-snug flex-1 min-w-0">
              {job.name || job.prompt.slice(0, 60)}
            </p>
            {scheduleKindBadge(job.schedule.kind)}
          </div>

          {/* Row 2: Schedule detail */}
          <div className="flex items-center gap-1.5 mt-0.5">
            <ScheduleIcon kind={job.schedule.kind} />
            <span
              className="text-[10px] font-mono text-blue-400/70 shrink-0"
              style={{ fontFamily: MONO_FONT }}
            >
              {scheduleLabel(job.schedule)}
            </span>
            {job.deleteAfterRun && (
              <span className="rounded bg-amber-500/10 px-1 py-px text-[8px] text-amber-400">
                auto-delete
              </span>
            )}
            {job.schedule.tz && job.schedule.tz !== 'UTC' && (
              <span className="text-[9px] text-muted-foreground/40">{job.schedule.tz}</span>
            )}
          </div>

          {/* Row 3: Prompt preview */}
          {job.prompt && (
            <p className="text-[10px] text-muted-foreground/50 italic mt-0.5 line-clamp-2 leading-snug">
              {job.prompt.slice(0, 120)}
            </p>
          )}

          {/* Row 4: Metadata */}
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            {job.agentId && job.agentId !== 'CronAgent' && (
              <span className="rounded bg-violet-500/10 px-1 py-px text-[8px] text-violet-400 flex items-center gap-0.5">
                <Bot className="size-2" />
                {job.agentId}
              </span>
            )}
            {job.deliveryMode !== 'desktop' && (
              <span className="text-[9px] text-muted-foreground/40">
                Delivery: {job.deliveryMode}
              </span>
            )}
            <span className="text-[9px] text-muted-foreground/40">Fired {job.fireCount} times</span>
            {job.lastFiredAt && (
              <span className="text-[9px] text-muted-foreground/40">
                Last: {formatRelative(job.lastFiredAt)}
              </span>
            )}
          </div>

          {/* Execution progress indicator */}
          {job.executing && (
            <div className="flex items-center gap-2 mt-1.5 text-[10px]">
              <Loader2 className="size-3 text-blue-400 animate-spin shrink-0" />
              <span className="text-blue-400/80 font-medium">Running</span>
              {job.executionStartedAt && <ElapsedTimer startedAt={job.executionStartedAt} />}
              {job.executionProgress && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span
                    className="text-muted-foreground/60 tabular-nums"
                    style={{ fontFamily: MONO_FONT }}
                  >
                    {job.executionProgress.toolCalls} tool calls
                  </span>
                  {job.executionProgress.currentStep && (
                    <>
                      <span className="text-muted-foreground/40">·</span>
                      <span className="text-violet-400/60 truncate max-w-[120px]">
                        {job.executionProgress.currentStep}
                      </span>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-0.5 shrink-0">
          {job.executing && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-amber-400 hover:text-destructive"
              title="Abort Agent"
              onClick={handleAbortAgent}
            >
              <StopCircle className="size-3" />
            </Button>
          )}

          {!job.executing && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-green-400"
              title="Run now"
              disabled={runNowLoading}
              onClick={handleRunNow}
            >
              {runNowLoading ? (
                <RefreshCw className="size-3 animate-spin" />
              ) : (
                <Play className="size-3" />
              )}
            </Button>
          )}

          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'size-6',
              job.enabled
                ? 'text-muted-foreground hover:text-amber-400'
                : 'text-muted-foreground hover:text-green-400'
            )}
            title={job.enabled ? 'Pause' : 'Enable'}
            onClick={() => onToggle(job.id, !job.enabled)}
          >
            {job.enabled ? <Square className="size-3" /> : <Play className="size-3 fill-current" />}
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'size-6',
              confirmDelete
                ? 'text-destructive animate-pulse'
                : 'text-muted-foreground hover:text-destructive'
            )}
            title={confirmDelete ? 'Click again to confirm delete' : 'Delete task'}
            onClick={() => {
              if (confirmDelete) {
                onRemove(job.id)
                setConfirmDelete(false)
              } else {
                setConfirmDelete(true)
                setTimeout(() => setConfirmDelete(false), 3000)
              }
            }}
          >
            <Trash2 className="size-3" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground/50 hover:text-foreground"
            title="Execution history / Agent logs"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          </Button>
        </div>
      </div>

      {/* Agent execution logs (real-time) — always visible when executing */}
      {job.executing && hasAgentLogs && <AgentLogPanel jobId={job.id} />}

      {/* Expanded: agent logs (post-execution) + run history */}
      {expanded && (
        <>
          {!job.executing && hasAgentLogs && <AgentLogPanel jobId={job.id} />}
          {jobRuns.length > 0 && (
            <div className="border-t px-3 py-2 space-y-1.5">
              <p className="text-[9px] text-muted-foreground/50 uppercase tracking-wider flex items-center gap-1">
                <History className="size-2.5" />
                Recent executions
              </p>
              {jobRuns.map((run) => (
                <RunHistoryItem key={run.id} run={run} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Run History Item (with expandable output) ─────────────────────

function RunHistoryItem({ run }: { run: CronRunEntry }): React.JSX.Element {
  const [showOutput, setShowOutput] = React.useState(false)
  const duration = run.finishedAt ? run.finishedAt - run.startedAt : null

  return (
    <div className="space-y-0.5">
      <button
        className="flex items-start gap-1.5 text-[10px] w-full text-left hover:bg-muted/30 -mx-1 px-1 rounded transition-colors"
        onClick={() => (run.outputSummary || run.error) && setShowOutput((v) => !v)}
      >
        {run.status === 'error' ? (
          <XCircle className="size-3 shrink-0 text-destructive mt-px" />
        ) : run.status === 'aborted' ? (
          <StopCircle className="size-3 shrink-0 text-amber-400 mt-px" />
        ) : run.status === 'running' ? (
          <Loader2 className="size-3 shrink-0 text-blue-400 animate-spin mt-px" />
        ) : (
          <CheckCircle2 className="size-3 shrink-0 text-green-500 mt-px" />
        )}
        <span
          className="text-muted-foreground/50 shrink-0 tabular-nums"
          style={{ fontFamily: MONO_FONT }}
        >
          {new Date(run.startedAt).toLocaleTimeString()}
        </span>
        {duration != null && (
          <span className="text-muted-foreground/40 shrink-0" style={{ fontFamily: MONO_FONT }}>
            {formatDuration(duration)}
          </span>
        )}
        <span
          className="text-muted-foreground/60 shrink-0 tabular-nums"
          style={{ fontFamily: MONO_FONT }}
        >
          {run.toolCallCount} tools
        </span>
        {run.error ? (
          <span className="text-destructive/70 truncate flex-1">{run.error.slice(0, 80)}</span>
        ) : run.outputSummary ? (
          <span className="text-muted-foreground/50 truncate flex-1">
            {run.outputSummary.slice(0, 60)}
          </span>
        ) : (
          <span className="text-muted-foreground/40 flex-1">
            {run.status === 'running' ? 'Running...' : run.status}
          </span>
        )}
        {(run.outputSummary || run.error) && (
          <span className="text-muted-foreground/30 shrink-0">
            {showOutput ? <ChevronUp className="size-2.5" /> : <ChevronDown className="size-2.5" />}
          </span>
        )}
      </button>
      {showOutput && (run.outputSummary || run.error) && (
        <div
          className="ml-[18px] rounded bg-muted/30 px-2 py-1.5 text-[10px] text-muted-foreground/60 whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto"
          style={{ fontFamily: MONO_FONT }}
        >
          {run.error || run.outputSummary?.slice(0, 500)}
        </div>
      )}
    </div>
  )
}

// ── Empty state ───────────────────────────────────────────────────

function EmptyState(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Clock className="mb-3 size-8 text-muted-foreground/30" />
      <p className="text-sm text-muted-foreground">No scheduled tasks</p>
      <p className="mt-1 text-xs text-muted-foreground/50 max-w-[200px]">
        Have AI use the <span className="font-mono text-blue-400/70">CronAdd</span> tool to create
        scheduled tasks
      </p>
    </div>
  )
}

// ── Cron History View ──────────────────────────────────────────────

// ── Calendar helpers ──────────────────────────────────────────────

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Check if a single cron field matches a value */
function matchesCronField(field: string, value: number): boolean {
  if (field === '*') return true
  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/)
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 0
    const range = stepMatch ? stepMatch[1] : part

    if (range === '*') {
      if (step > 0 && value % step === 0) return true
      if (!step) return true
      continue
    }

    const dashMatch = range.match(/^(\d+)-(\d+)$/)
    if (dashMatch) {
      const lo = parseInt(dashMatch[1], 10)
      const hi = parseInt(dashMatch[2], 10)
      if (step > 0) {
        for (let v = lo; v <= hi; v += step) {
          if (v === value) return true
        }
      } else {
        if (value >= lo && value <= hi) return true
      }
      continue
    }

    const num = parseInt(range, 10)
    if (!isNaN(num) && num === value) return true
  }
  return false
}

/** Check if a cron job runs on a given date */
function jobRunsOnDate(job: CronJobEntry, date: Date): boolean {
  if (!job.enabled) return false
  const { schedule } = job

  if (schedule.kind === 'at') {
    if (!schedule.at) return false
    const at = new Date(schedule.at)
    return (
      at.getFullYear() === date.getFullYear() &&
      at.getMonth() === date.getMonth() &&
      at.getDate() === date.getDate()
    )
  }

  if (schedule.kind === 'every') {
    // Interval jobs run every day (from creation onwards)
    const created = new Date(job.createdAt)
    created.setHours(0, 0, 0, 0)
    const target = new Date(date)
    target.setHours(0, 0, 0, 0)
    return target >= created
  }

  if (schedule.kind === 'cron' && schedule.expr) {
    const parts = schedule.expr.trim().split(/\s+/)
    if (parts.length < 5) return false
    // fields: minute hour day-of-month month day-of-week
    const dom = parts[2] // 1-31
    const month = parts[3] // 1-12
    const dow = parts[4] // 0-6 (0=Sun)
    return (
      matchesCronField(dom, date.getDate()) &&
      matchesCronField(month, date.getMonth() + 1) &&
      matchesCronField(dow, date.getDay())
    )
  }

  return false
}

/** Generate calendar grid dates for a month (42 cells = 6 rows × 7 cols) */
function getCalendarDays(year: number, month: number): Date[] {
  const first = new Date(year, month, 1)
  const startDay = first.getDay() // 0=Sun
  const start = new Date(year, month, 1 - startDay)
  const days: Date[] = []
  for (let i = 0; i < 42; i++) {
    days.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
  }
  return days
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

// ── CronCalendarView ──────────────────────────────────────────────

function CronCalendarView({
  jobs,
  runs,
  onToggle,
  onRemove,
  onRunNow
}: {
  jobs: CronJobEntry[]
  runs: CronRunEntry[]
  onToggle: (id: string, enabled: boolean) => void
  onRemove: (id: string) => void
  onRunNow: (id: string) => void
}): React.JSX.Element {
  const today = new Date()
  const [year, setYear] = React.useState(today.getFullYear())
  const [month, setMonth] = React.useState(today.getMonth())
  const [selectedDate, setSelectedDate] = React.useState<Date | null>(today)

  const calendarDays = React.useMemo(() => getCalendarDays(year, month), [year, month])

  // Pre-compute job counts per day for the visible grid
  const jobCountMap = React.useMemo(() => {
    const map = new Map<string, number>()
    for (const day of calendarDays) {
      const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`
      let count = 0
      for (const job of jobs) {
        if (jobRunsOnDate(job, day)) count++
      }
      if (count > 0) map.set(key, count)
    }
    return map
  }, [calendarDays, jobs])

  const selectedJobs = React.useMemo(() => {
    if (!selectedDate) return []
    return jobs.filter((j) => jobRunsOnDate(j, selectedDate))
  }, [selectedDate, jobs])

  const goPrev = (): void => {
    if (month === 0) {
      setYear(year - 1)
      setMonth(11)
    } else setMonth(month - 1)
  }
  const goNext = (): void => {
    if (month === 11) {
      setYear(year + 1)
      setMonth(0)
    } else setMonth(month + 1)
  }
  const goToday = (): void => {
    const now = new Date()
    setYear(now.getFullYear())
    setMonth(now.getMonth())
    setSelectedDate(now)
  }

  return (
    <div className="space-y-3">
      {/* Month navigation */}
      <div className="flex items-center justify-between">
        <button
          className="size-6 flex items-center justify-center rounded hover:bg-muted transition-colors text-muted-foreground"
          onClick={goPrev}
        >
          <ChevronLeft className="size-3.5" />
        </button>
        <button
          className="text-[11px] font-medium text-foreground/80 hover:text-foreground transition-colors px-2 py-0.5 rounded hover:bg-muted/50"
          onClick={goToday}
        >
          {year} / {month + 1}
        </button>
        <button
          className="size-6 flex items-center justify-center rounded hover:bg-muted transition-colors text-muted-foreground"
          onClick={goNext}
        >
          <ChevronRight className="size-3.5" />
        </button>
      </div>

      {/* Weekday headers */}
      <div className="grid grid-cols-7 gap-0">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="text-center text-[9px] text-muted-foreground/50 py-1">
            {label}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7 gap-0">
        {calendarDays.map((day, i) => {
          const isCurrentMonth = day.getMonth() === month
          const isToday = isSameDay(day, today)
          const isSelected = selectedDate ? isSameDay(day, selectedDate) : false
          const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`
          const jobCount = jobCountMap.get(key) ?? 0

          return (
            <button
              key={i}
              className={cn(
                'relative flex flex-col items-center py-1 rounded transition-colors text-[10px] tabular-nums',
                isCurrentMonth ? 'text-foreground/80' : 'text-muted-foreground/30',
                isToday && !isSelected && 'bg-blue-500/10 text-blue-400 font-medium',
                isSelected && 'bg-blue-500/20 text-blue-400 font-medium ring-1 ring-blue-500/30',
                !isSelected && !isToday && 'hover:bg-muted/50'
              )}
              onClick={() => setSelectedDate(day)}
            >
              <span>{day.getDate()}</span>
              {/* Job indicator dots */}
              <div className="flex items-center gap-px mt-0.5 h-[4px]">
                {jobCount > 0 &&
                  jobCount <= 3 &&
                  Array.from({ length: jobCount }).map((_, di) => (
                    <span key={di} className="size-[3px] rounded-full bg-green-500/70" />
                  ))}
                {jobCount > 3 && (
                  <>
                    <span className="size-[3px] rounded-full bg-green-500/70" />
                    <span className="size-[3px] rounded-full bg-green-500/70" />
                    <span className="text-[7px] text-green-500/70 leading-none">+</span>
                  </>
                )}
              </div>
            </button>
          )
        })}
      </div>

      {/* Selected date job list */}
      {selectedDate && (
        <>
          <Separator />
          <div className="space-y-1.5">
            <p className="text-[10px] text-muted-foreground/60 flex items-center gap-1">
              <CalendarDays className="size-3" />
              {selectedDate.toLocaleDateString(undefined, {
                month: 'long',
                day: 'numeric',
                weekday: 'short'
              })}
              <span className="text-muted-foreground/40">· {selectedJobs.length} tasks</span>
            </p>
            {selectedJobs.length === 0 && (
              <p className="text-[10px] text-muted-foreground/40 py-4 text-center">
                No scheduled tasks for this day
              </p>
            )}
            {selectedJobs.map((job) => (
              <CronJobCard
                key={job.id}
                job={job}
                runs={runs}
                onToggle={onToggle}
                onRemove={onRemove}
                onRunNow={onRunNow}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ── Cron History View ──────────────────────────────────────────────

function formatDate(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday = d.toDateString() === yesterday.toDateString()
  if (isToday) return 'Today'
  if (isYesterday) return 'Yesterday'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', weekday: 'short' })
}

function HistoryRunCard({
  run,
  jobName
}: {
  run: CronRunEntry
  jobName: string
}): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false)
  const duration = run.finishedAt ? run.finishedAt - run.startedAt : null
  const hasContent = !!(run.outputSummary || run.error)

  const statusConfig = {
    success: {
      icon: <CheckCircle2 className="size-3.5 text-green-500" />,
      label: 'Success',
      color: 'text-green-500'
    },
    error: {
      icon: <XCircle className="size-3.5 text-destructive" />,
      label: 'Failed',
      color: 'text-destructive'
    },
    aborted: {
      icon: <StopCircle className="size-3.5 text-amber-400" />,
      label: 'Aborted',
      color: 'text-amber-400'
    },
    running: {
      icon: <Loader2 className="size-3.5 text-blue-400 animate-spin" />,
      label: 'Running',
      color: 'text-blue-400'
    }
  }
  const cfg = statusConfig[run.status] ?? statusConfig.running

  return (
    <div
      className={cn(
        'rounded-lg border bg-card transition-colors overflow-hidden',
        run.status === 'error' && 'border-destructive/20',
        run.status === 'running' && 'border-blue-500/20'
      )}
    >
      <button
        className="flex items-start gap-2.5 px-3 py-2.5 w-full text-left hover:bg-muted/20 transition-colors"
        onClick={() => hasContent && setExpanded((v) => !v)}
      >
        <span className="mt-0.5 shrink-0">{cfg.icon}</span>
        <div className="min-w-0 flex-1 space-y-0.5">
          {/* Row 1: Job name + status */}
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-medium text-foreground/80 truncate flex-1">
              {jobName}
            </span>
            <span className={cn('text-[9px] font-medium shrink-0', cfg.color)}>{cfg.label}</span>
          </div>
          {/* Row 2: Time + duration + tool calls */}
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground/50">
            <span className="tabular-nums" style={{ fontFamily: MONO_FONT }}>
              {new Date(run.startedAt).toLocaleTimeString()}
            </span>
            {duration != null && (
              <span className="tabular-nums" style={{ fontFamily: MONO_FONT }}>
                ⏱ {formatDuration(duration)}
              </span>
            )}
            <span className="tabular-nums" style={{ fontFamily: MONO_FONT }}>
              {run.toolCallCount} tools
            </span>
          </div>
          {/* Row 3: Preview of output/error */}
          {!expanded && hasContent && (
            <p className="text-[10px] text-muted-foreground/40 truncate leading-snug">
              {run.error ? `❌ ${run.error.slice(0, 100)}` : run.outputSummary?.slice(0, 100)}
            </p>
          )}
        </div>
        {hasContent && (
          <span className="mt-1 shrink-0 text-muted-foreground/30">
            {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          </span>
        )}
      </button>

      {/* Expanded: full output */}
      {expanded && hasContent && (
        <div className="border-t px-3 py-2">
          {run.error && (
            <div className="space-y-1">
              <p className="text-[9px] text-destructive/60 uppercase tracking-wider font-medium">
                Error message
              </p>
              <pre
                className="text-[10px] text-destructive/70 whitespace-pre-wrap break-words leading-relaxed max-h-[300px] overflow-y-auto"
                style={{ fontFamily: MONO_FONT }}
              >
                {run.error}
              </pre>
            </div>
          )}
          {run.outputSummary && (
            <div className={cn('space-y-1', run.error && 'mt-2')}>
              <p className="text-[9px] text-muted-foreground/50 uppercase tracking-wider font-medium">
                Execution output
              </p>
              <pre
                className="text-[10px] text-muted-foreground/60 whitespace-pre-wrap break-words leading-relaxed max-h-[400px] overflow-y-auto"
                style={{ fontFamily: MONO_FONT }}
              >
                {run.outputSummary}
              </pre>
            </div>
          )}
          <div className="mt-2 flex items-center gap-3 text-[9px] text-muted-foreground/40">
            <span>
              Run ID: <span style={{ fontFamily: MONO_FONT }}>{run.id}</span>
            </span>
            <span>
              Job ID: <span style={{ fontFamily: MONO_FONT }}>{run.jobId}</span>
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function CronHistoryView({
  jobs,
  runs
}: {
  jobs: CronJobEntry[]
  runs: CronRunEntry[]
}): React.JSX.Element {
  const loadRuns = useCronStore((s) => s.loadRuns)
  const [filterJobId, setFilterJobId] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [showFilter, setShowFilter] = React.useState(false)

  React.useEffect(() => {
    setLoading(true)
    loadRuns(filterJobId ?? undefined).finally(() => setLoading(false))
  }, [filterJobId, loadRuns])

  const jobName = (id: string): string => {
    const found = jobs.find((j) => j.id === id)
    return found?.name ?? id.slice(0, 12)
  }

  const filteredRuns = filterJobId ? runs.filter((r) => r.jobId === filterJobId) : runs

  // Group runs by date
  const grouped = React.useMemo(() => {
    const groups: { date: string; runs: CronRunEntry[] }[] = []
    let currentDate = ''
    for (const run of filteredRuns) {
      const date = formatDate(run.startedAt)
      if (date !== currentDate) {
        currentDate = date
        groups.push({ date, runs: [] })
      }
      groups[groups.length - 1].runs.push(run)
    }
    return groups
  }, [filteredRuns])

  // Stats
  const stats = React.useMemo(() => {
    const total = filteredRuns.length
    const success = filteredRuns.filter((r) => r.status === 'success').length
    const errors = filteredRuns.filter((r) => r.status === 'error').length
    const totalDuration = filteredRuns.reduce(
      (acc, r) => acc + (r.finishedAt ? r.finishedAt - r.startedAt : 0),
      0
    )
    return { total, success, errors, avgDuration: total > 0 ? totalDuration / total : 0 }
  }, [filteredRuns])

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          className={cn(
            'flex items-center gap-1 text-[10px] px-2 py-1 rounded-md transition-colors',
            showFilter ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50'
          )}
          onClick={() => setShowFilter((v) => !v)}
        >
          <ListFilter className="size-3" />
          Filter
        </button>
        {loading && <Loader2 className="size-3 text-muted-foreground animate-spin" />}
        <div className="flex-1" />
        <div className="flex items-center gap-2 text-[9px] text-muted-foreground/50">
          <span className="text-green-500/70">{stats.success} success</span>
          {stats.errors > 0 && <span className="text-destructive/70">{stats.errors} failed</span>}
          <span>Total {stats.total}</span>
          {stats.avgDuration > 0 && <span>Avg {formatDuration(stats.avgDuration)}</span>}
        </div>
      </div>

      {/* Job filter dropdown */}
      {showFilter && (
        <div className="flex items-center gap-1 flex-wrap">
          <button
            className={cn(
              'text-[10px] px-2 py-0.5 rounded transition-colors',
              !filterJobId
                ? 'bg-blue-500/20 text-blue-400'
                : 'bg-muted/50 text-muted-foreground hover:bg-muted'
            )}
            onClick={() => setFilterJobId(null)}
          >
            All
          </button>
          {jobs.map((j) => (
            <button
              key={j.id}
              className={cn(
                'text-[10px] px-2 py-0.5 rounded transition-colors truncate max-w-[120px]',
                filterJobId === j.id
                  ? 'bg-blue-500/20 text-blue-400'
                  : 'bg-muted/50 text-muted-foreground hover:bg-muted'
              )}
              onClick={() => setFilterJobId(j.id)}
            >
              {j.name || j.id.slice(0, 10)}
            </button>
          ))}
        </div>
      )}

      {/* Empty */}
      {filteredRuns.length === 0 && !loading && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <FileText className="mb-3 size-8 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">No execution records</p>
          <p className="mt-1 text-xs text-muted-foreground/50">
            {filterJobId
              ? 'This task has no execution records yet'
              : 'Scheduled task executions will appear here'}
          </p>
        </div>
      )}

      {/* Date-grouped runs */}
      {grouped.map((group) => (
        <div key={group.date} className="space-y-1.5">
          <div className="flex items-center gap-1.5 sticky top-0 bg-background/80 backdrop-blur-sm py-1 z-10">
            <Calendar className="size-3 text-muted-foreground/40" />
            <span className="text-[10px] font-medium text-muted-foreground/60">{group.date}</span>
            <span className="text-[9px] text-muted-foreground/30">{group.runs.length} runs</span>
          </div>
          <div className="space-y-1.5">
            {group.runs.map((run) => (
              <HistoryRunCard key={run.id} run={run} jobName={jobName(run.jobId)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── CronPanel ─────────────────────────────────────────────────────

type CronView = 'tasks' | 'history' | 'calendar'

export function CronPanel(): React.JSX.Element {
  const jobs = useCronStore((s) => s.jobs)
  const runs = useCronStore((s) => s.runs)
  const loadJobs = useCronStore((s) => s.loadJobs)
  const loadRuns = useCronStore((s) => s.loadRuns)
  const deleteJob = useCronStore((s) => s.deleteJob)
  const updateJob = useCronStore((s) => s.updateJob)
  const [refreshing, setRefreshing] = React.useState(false)
  const [view, setView] = React.useState<CronView>('tasks')

  const enabledJobs = jobs.filter((j) => j.enabled)
  const disabledJobs = jobs.filter((j) => !j.enabled)

  const handleRefresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await Promise.all([loadJobs(), loadRuns()])
    } finally {
      setRefreshing(false)
    }
  }

  // Load runs when switching to history view
  React.useEffect(() => {
    if (view === 'history') {
      loadRuns()
    }
  }, [view, loadRuns])

  const handleToggle = async (id: string, enabled: boolean): Promise<void> => {
    const result = (await ipcClient.invoke(IPC.CRON_TOGGLE, { jobId: id, enabled })) as {
      error?: string
    }
    if (result.error) {
      toast.error('Operation failed', { description: result.error })
      return
    }
    updateJob(id, { enabled, scheduled: enabled })
    toast.success(enabled ? 'Scheduled task enabled' : 'Scheduled task paused')
  }

  const handleRemove = async (id: string): Promise<void> => {
    const result = await deleteJob(id)
    if (result.error) {
      toast.error('Delete failed', { description: result.error })
      return
    }
    toast.success('Scheduled task deleted')
  }

  const handleRunNow = async (id: string): Promise<void> => {
    const result = (await ipcClient.invoke(IPC.CRON_RUN_NOW, { jobId: id })) as { error?: string }
    if (result.error) {
      toast.error('Execution failed', { description: result.error })
      return
    }
  }

  return (
    <div className="space-y-3 max-h-[calc(100vh-200px)] overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          {/* View toggle */}
          <button
            className={cn(
              'flex items-center gap-1 text-[10px] px-2 py-1 rounded-md transition-colors',
              view === 'tasks'
                ? 'bg-muted text-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-muted/50'
            )}
            onClick={() => setView('tasks')}
          >
            <Clock className="size-3" />
            Tasks
            {jobs.length > 0 && (
              <span className="text-[9px] text-muted-foreground/60 ml-0.5">{jobs.length}</span>
            )}
          </button>
          <button
            className={cn(
              'flex items-center gap-1 text-[10px] px-2 py-1 rounded-md transition-colors',
              view === 'history'
                ? 'bg-muted text-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-muted/50'
            )}
            onClick={() => setView('history')}
          >
            <History className="size-3" />
            History
            {runs.length > 0 && (
              <span className="text-[9px] text-muted-foreground/60 ml-0.5">{runs.length}</span>
            )}
          </button>
          <button
            className={cn(
              'flex items-center gap-1 text-[10px] px-2 py-1 rounded-md transition-colors',
              view === 'calendar'
                ? 'bg-muted text-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-muted/50'
            )}
            onClick={() => setView('calendar')}
          >
            <CalendarDays className="size-3" />
            Calendar
          </button>
        </div>
        <div className="flex items-center gap-1">
          {view === 'tasks' && enabledJobs.length > 0 && (
            <span className="text-[9px] text-green-500/70 flex items-center gap-0.5">
              <span className="size-1.5 rounded-full bg-green-500/70 inline-flex" />
              {enabledJobs.length} running
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            title="Refresh"
            onClick={handleRefresh}
          >
            <RefreshCw className={cn('size-3', refreshing && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {/* === Tasks View === */}
      {view === 'tasks' && (
        <>
          {/* Empty */}
          {jobs.length === 0 && <EmptyState />}

          {/* Active jobs */}
          {enabledJobs.length > 0 && (
            <div className="space-y-2">
              {enabledJobs.map((job) => (
                <CronJobCard
                  key={job.id}
                  job={job}
                  runs={runs}
                  onToggle={handleToggle}
                  onRemove={handleRemove}
                  onRunNow={handleRunNow}
                />
              ))}
            </div>
          )}

          {/* Disabled jobs */}
          {disabledJobs.length > 0 && (
            <>
              {enabledJobs.length > 0 && <Separator />}
              <div className="space-y-1">
                <p className="text-[9px] text-muted-foreground/40 uppercase tracking-wider px-1">
                  Paused
                </p>
                <div className="space-y-2">
                  {disabledJobs.map((job) => (
                    <CronJobCard
                      key={job.id}
                      job={job}
                      runs={runs}
                      onToggle={handleToggle}
                      onRemove={handleRemove}
                      onRunNow={handleRunNow}
                    />
                  ))}
                </div>
              </div>
            </>
          )}

          {/* Hint */}
          <div className="rounded-md bg-muted/30 px-3 py-2 text-[10px] text-muted-foreground/50 space-y-0.5">
            <p className="flex items-center gap-1">
              <Plus className="size-2.5" />
              Have AI call <span className="font-mono text-blue-400/60 mx-0.5">CronAdd</span> to
              create new tasks
            </p>
            <p className="flex items-center gap-1">
              <AlertCircle className="size-2.5" />
              Supports three scheduling modes: one-time (at), fixed interval (every), and Cron
              expression
            </p>
          </div>
        </>
      )}

      {/* === History View === */}
      {view === 'history' && <CronHistoryView jobs={jobs} runs={runs} />}

      {/* === Calendar View === */}
      {view === 'calendar' && (
        <CronCalendarView
          jobs={jobs}
          runs={runs}
          onToggle={handleToggle}
          onRemove={handleRemove}
          onRunNow={handleRunNow}
        />
      )}
    </div>
  )
}
