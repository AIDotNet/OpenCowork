import cron from 'node-cron'
import { BrowserWindow } from 'electron'
import { getDb } from '../db/database'

// ── Types ────────────────────────────────────────────────────────

export interface CronJobRecord {
  id: string
  name: string

  schedule_kind: 'at' | 'every' | 'cron'
  schedule_at: number | null
  schedule_every: number | null
  schedule_expr: string | null
  schedule_tz: string

  prompt: string
  agent_id: string | null
  model: string | null
  working_folder: string | null
  session_id: string | null

  delivery_mode: 'desktop' | 'session' | 'none'
  delivery_target: string | null

  plugin_id: string | null
  plugin_chat_id: string | null

  enabled: number
  delete_after_run: number
  max_iterations: number

  last_fired_at: number | null
  fire_count: number
  created_at: number
  updated_at: number
}

export interface CronRunRecord {
  id: string
  job_id: string
  started_at: number
  finished_at: number | null
  status: 'running' | 'success' | 'error' | 'aborted'
  tool_call_count: number
  output_summary: string | null
  error: string | null
}

// ── Scheduled Handle (unified abstraction) ───────────────────────

interface ScheduledHandle {
  stop(): void
}

const scheduledHandles = new Map<string, ScheduledHandle>()

// ── Concurrency ──────────────────────────────────────────────────

let maxConcurrentRuns = 2
const activeRunJobIds = new Set<string>()
/** Jobs with delete_after_run that are waiting for the agent run to finish before DB deletion */
const pendingDeleteAfterRun = new Set<string>()

export function setMaxConcurrentRuns(n: number): void {
  maxConcurrentRuns = Math.max(1, n)
}

export function isRunning(jobId: string): boolean {
  return activeRunJobIds.has(jobId)
}

export function markRunning(jobId: string): boolean {
  if (activeRunJobIds.has(jobId)) return false
  if (activeRunJobIds.size >= maxConcurrentRuns) {
    console.warn(`[CronScheduler] Concurrency limit reached (${maxConcurrentRuns}), skipping job ${jobId}`)
    return false
  }
  activeRunJobIds.add(jobId)
  return true
}

export function markFinished(jobId: string): void {
  activeRunJobIds.delete(jobId)

  // Deferred delete_after_run: now that the agent run is done, delete the job
  if (pendingDeleteAfterRun.has(jobId)) {
    pendingDeleteAfterRun.delete(jobId)
    try {
      const db = getDb()
      db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(jobId)
      sendToRenderer('cron:job-removed', { jobId, reason: 'delete_after_run' })
      console.log(`[CronScheduler] Deferred delete_after_run: removed job ${jobId}`)
    } catch (err) {
      console.error(`[CronScheduler] Failed to delete job ${jobId} after run:`, err)
    }
  }
}

// ── Renderer communication ───────────────────────────────────────

function sendToRenderer(channel: string, data: unknown): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data)
  }
}

// ── Job fired handler ────────────────────────────────────────────

function onJobFired(job: CronJobRecord): void {
  // Concurrency guard — prevent firing if this job is already running
  if (activeRunJobIds.has(job.id)) {
    console.warn(`[CronScheduler] Job ${job.id} is already running, skipping fire`)
    return
  }
  activeRunJobIds.add(job.id)

  try {
    const db = getDb()

    // Update fire stats
    db.prepare(
      'UPDATE cron_jobs SET last_fired_at = ?, fire_count = fire_count + 1 WHERE id = ?'
    ).run(Date.now(), job.id)

    // Forward to renderer — cron-agent-runner.ts handles execution
    sendToRenderer('cron:fired', {
      jobId: job.id,
      name: job.name,
      prompt: job.prompt,
      agentId: job.agent_id,
      model: job.model,
      workingFolder: job.working_folder,
      sessionId: job.session_id,
      deliveryMode: job.delivery_mode,
      deliveryTarget: job.delivery_target,
      maxIterations: job.max_iterations,
      pluginId: job.plugin_id,
      pluginChatId: job.plugin_chat_id,
    })

    // Handle delete_after_run: stop the schedule handle now (prevent re-fire),
    // but defer DB deletion + UI removal until the agent run finishes (cron:run-finished).
    // This keeps the job visible in the UI during execution.
    if (job.delete_after_run) {
      const handle = scheduledHandles.get(job.id)
      if (handle) {
        handle.stop()
        scheduledHandles.delete(job.id)
      }
      pendingDeleteAfterRun.add(job.id)
    }
  } catch (err) {
    console.error('[CronScheduler] Job fire error:', err)
    sendToRenderer('cron:fired', {
      jobId: job.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ── Schedule a job ───────────────────────────────────────────────

export function scheduleJob(record: CronJobRecord): boolean {
  // Stop any existing handle
  const existing = scheduledHandles.get(record.id)
  if (existing) {
    existing.stop()
    scheduledHandles.delete(record.id)
  }

  const kind = record.schedule_kind

  if (kind === 'at') {
    const targetMs = record.schedule_at
    if (!targetMs) return false
    const delay = targetMs - Date.now()
    if (delay <= -30_000) {
      // More than 30s in the past — skip instead of firing immediately
      console.warn(`[CronScheduler] Job ${record.id} schedule_at is in the past, skipping`)
      return false
    }
    if (delay <= 0) {
      // Within 30s tolerance — fire immediately (e.g. app just started)
      onJobFired(record)
      return true
    }
    const timer = setTimeout(() => {
      scheduledHandles.delete(record.id)
      onJobFired(record)
    }, delay)
    scheduledHandles.set(record.id, { stop: () => clearTimeout(timer) })
    return true
  }

  if (kind === 'every') {
    const intervalMs = record.schedule_every
    if (!intervalMs || intervalMs < 1000) return false
    const timer = setInterval(() => {
      onJobFired(record)
    }, intervalMs)
    scheduledHandles.set(record.id, { stop: () => clearInterval(timer) })
    return true
  }

  if (kind === 'cron') {
    const expr = record.schedule_expr
    if (!expr || !cron.validate(expr)) return false
    const task = cron.schedule(
      expr,
      () => { onJobFired(record) },
      { scheduled: true, timezone: record.schedule_tz || 'UTC' }
    )
    scheduledHandles.set(record.id, { stop: () => task.stop() })
    return true
  }

  return false
}

// ── Cancel / unschedule ──────────────────────────────────────────

export function cancelJob(id: string): boolean {
  const handle = scheduledHandles.get(id)
  if (!handle) return false
  handle.stop()
  scheduledHandles.delete(id)
  return true
}

// ── Load persisted jobs on startup ───────────────────────────────

export function loadPersistedJobs(): void {
  try {
    const db = getDb()

    // Clean up expired 'at' jobs that are in the past
    const now = Date.now()
    db.prepare(
      "DELETE FROM cron_jobs WHERE schedule_kind = 'at' AND schedule_at < ? AND delete_after_run = 1"
    ).run(now)

    const rows = db.prepare('SELECT * FROM cron_jobs WHERE enabled = 1').all() as CronJobRecord[]
    let loaded = 0
    for (const row of rows) {
      if (scheduleJob(row)) {
        loaded++
      } else {
        console.warn('[CronScheduler] Failed to schedule job', row.id, row.schedule_kind)
      }
    }
    console.log(`[CronScheduler] Loaded ${loaded}/${rows.length} persisted cron jobs`)
  } catch (err) {
    console.error('[CronScheduler] Failed to load persisted jobs:', err)
  }
}

// ── Cancel all (shutdown) ────────────────────────────────────────

export function cancelAllJobs(): void {
  for (const [, handle] of scheduledHandles) {
    handle.stop()
  }
  scheduledHandles.clear()
  activeRunJobIds.clear()
  pendingDeleteAfterRun.clear()
}

// ── Query helpers ────────────────────────────────────────────────

export function getScheduledJobIds(): string[] {
  return Array.from(scheduledHandles.keys())
}

export function getActiveRunJobIds(): string[] {
  return Array.from(activeRunJobIds)
}
