import type { CronJobEntry, CronSchedule } from '@renderer/stores/cron-store'

export interface DayWindowEntry {
  key: string
  date: Date
  start: number
  end: number
  isToday: boolean
}

export function startOfLocalDay(value: Date | number): Date {
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0)
}

export function endOfLocalDay(value: Date | number): Date {
  const start = startOfLocalDay(value)
  return new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1)
}

export function dateKeyFromDate(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function dateKeyFromTimestamp(timestamp: number): string {
  return dateKeyFromDate(new Date(timestamp))
}

export function buildDayWindow(pastDays = 7, futureDays = 30): DayWindowEntry[] {
  const today = startOfLocalDay(Date.now())
  const entries: DayWindowEntry[] = []
  for (let offset = -pastDays; offset <= futureDays; offset++) {
    const date = new Date(today)
    date.setDate(today.getDate() + offset)
    const start = startOfLocalDay(date).getTime()
    const end = endOfLocalDay(date).getTime()
    entries.push({
      key: dateKeyFromDate(date),
      date,
      start,
      end,
      isToday: offset === 0,
    })
  }
  return entries
}

export function formatDayLabel(date: Date): string {
  const todayKey = dateKeyFromTimestamp(Date.now())
  const key = dateKeyFromDate(date)
  if (key === todayKey) return '今天'
  const tomorrow = new Date(startOfLocalDay(Date.now()))
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (key === dateKeyFromDate(tomorrow)) return '明天'
  const yesterday = new Date(startOfLocalDay(Date.now()))
  yesterday.setDate(yesterday.getDate() - 1)
  if (key === dateKeyFromDate(yesterday)) return '昨天'
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short' })
}

export function formatTimeLabel(timestamp: number | null | undefined): string {
  if (!timestamp) return '—'
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatDateTimeLabel(timestamp: number | null | undefined): string {
  if (!timestamp) return '—'
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatIntervalLabel(ms: number | null | undefined): string {
  if (!ms) return '—'
  if (ms < 60_000) return `每 ${Math.round(ms / 1000)} 秒`
  if (ms < 3_600_000) return `每 ${Math.round(ms / 60_000)} 分钟`
  if (ms < 86_400_000) return `每 ${(ms / 3_600_000).toFixed(ms % 3_600_000 === 0 ? 0 : 1)} 小时`
  return `每 ${(ms / 86_400_000).toFixed(ms % 86_400_000 === 0 ? 0 : 1)} 天`
}

export function scheduleKindLabel(kind: CronSchedule['kind']): string {
  switch (kind) {
    case 'at':
      return '一次性'
    case 'every':
      return '间隔'
    case 'cron':
      return 'Cron'
  }
}

export function scheduleSummary(job: CronJobEntry): string {
  if (job.schedule.kind === 'at') return formatDateTimeLabel(job.schedule.at)
  if (job.schedule.kind === 'every') return formatIntervalLabel(job.schedule.every)
  return job.schedule.expr ?? '—'
}

function normalizeCronToken(token: string): string {
  return token.trim() === '?' ? '*' : token.trim()
}

function matchesCronField(field: string, value: number): boolean {
  const normalized = normalizeCronToken(field)
  if (normalized === '*') return true

  for (const part of normalized.split(',')) {
    const segment = part.trim()
    if (!segment) continue

    const stepMatch = segment.match(/^(.+)\/(\d+)$/)
    const step = stepMatch ? Number.parseInt(stepMatch[2], 10) : 0
    const base = stepMatch ? stepMatch[1] : segment

    if (base === '*') {
      if (!step) return true
      if (value % step === 0) return true
      continue
    }

    const rangeMatch = base.match(/^(\d+)-(\d+)$/)
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1], 10)
      const end = Number.parseInt(rangeMatch[2], 10)
      if (value < start || value > end) continue
      if (!step) return true
      if ((value - start) % step === 0) return true
      continue
    }

    const exact = Number.parseInt(base, 10)
    if (!Number.isNaN(exact) && exact === value) return true
  }

  return false
}

function getWeekdayIndex(label: string): number {
  const lower = label.toLowerCase()
  const map: Record<string, number> = {
    sun: 0,
    sunday: 0,
    mon: 1,
    monday: 1,
    tue: 2,
    tuesday: 2,
    wed: 3,
    wednesday: 3,
    thu: 4,
    thursday: 4,
    fri: 5,
    friday: 5,
    sat: 6,
    saturday: 6,
  }
  return map[lower] ?? 0
}

function getZonedParts(timestamp: number, timeZone?: string): {
  minute: number
  hour: number
  day: number
  month: number
  weekday: number
} {
  const date = new Date(timestamp)
  if (!timeZone || timeZone === 'UTC') {
    return {
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      day: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      weekday: date.getUTCDay(),
    }
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    weekday: 'short',
  }).formatToParts(date)

  const byType = new Map(parts.map((part) => [part.type, part.value]))
  return {
    minute: Number.parseInt(byType.get('minute') ?? '0', 10),
    hour: Number.parseInt(byType.get('hour') ?? '0', 10),
    day: Number.parseInt(byType.get('day') ?? '1', 10),
    month: Number.parseInt(byType.get('month') ?? '1', 10),
    weekday: getWeekdayIndex(byType.get('weekday') ?? 'Sun'),
  }
}

function matchesCronExpressionAt(expr: string, timestamp: number, timeZone?: string): boolean {
  const parts = expr.trim().split(/\s+/)
  if (parts.length < 5) return false
  const minute = parts[0]
  const hour = parts[1]
  const dayOfMonth = parts[2]
  const month = parts[3]
  const dayOfWeek = parts[4]
  const zoned = getZonedParts(timestamp, timeZone)
  return (
    matchesCronField(minute, zoned.minute) &&
    matchesCronField(hour, zoned.hour) &&
    matchesCronField(dayOfMonth, zoned.day) &&
    matchesCronField(month, zoned.month) &&
    matchesCronField(dayOfWeek, zoned.weekday)
  )
}

export function listPlannedTimesForDay(job: CronJobEntry, dayStart: number, dayEnd: number): number[] {
  if (job.deletedAt) return []
  const { schedule } = job

  if (schedule.kind === 'at') {
    const at = schedule.at ?? null
    if (!at || at < dayStart || at > dayEnd) return []
    return [at]
  }

  if (schedule.kind === 'every') {
    const every = schedule.every ?? null
    if (!every || every < 1000) return []
    const anchor = job.lastFiredAt ?? job.updatedAt ?? job.createdAt
    let next = anchor <= dayStart ? dayStart : anchor
    const offset = (next - anchor) % every
    if (offset !== 0) next += every - offset
    const result: number[] = []
    for (let current = next; current <= dayEnd; current += every) {
      if (current >= dayStart) result.push(current)
      if (result.length > 500) break
    }
    return result
  }

  if (schedule.kind === 'cron' && schedule.expr) {
    const result: number[] = []
    const minute = 60_000
    for (let current = dayStart; current <= dayEnd; current += minute) {
      if (matchesCronExpressionAt(schedule.expr, current, schedule.tz)) {
        result.push(current)
      }
      if (result.length > 500) break
    }
    return result
  }

  return []
}

export function listDateKeysForJob(job: CronJobEntry, window: DayWindowEntry[]): string[] {
  const keys: string[] = []
  for (const day of window) {
    if (listPlannedTimesForDay(job, day.start, day.end).length > 0) {
      keys.push(day.key)
    }
  }
  return keys
}
