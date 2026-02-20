import { ipcMain, BrowserWindow } from 'electron'
import { nanoid } from 'nanoid'
import { getDb } from '../db/database'
import {
  scheduleJob,
  cancelJob,
  getScheduledJobIds,
  getActiveRunJobIds,
  markFinished,
  type CronJobRecord,
  type CronRunRecord,
} from '../cron/cron-scheduler'

// ── Arg types ────────────────────────────────────────────────────

interface CronAddArgs {
  name: string
  sessionId?: string
  schedule: {
    kind: 'at' | 'every' | 'cron'
    at?: number | string   // timestamp ms or ISO string
    every?: number         // interval ms
    expr?: string          // cron expression
    tz?: string            // IANA timezone
  }
  prompt: string
  agentId?: string
  model?: string
  workingFolder?: string
  deliveryMode?: 'desktop' | 'session' | 'none'
  deliveryTarget?: string
  deleteAfterRun?: boolean
  maxIterations?: number
  pluginId?: string
  pluginChatId?: string
}

interface CronUpdateArgs {
  jobId: string
  patch: Partial<{
    name: string
    schedule: {
      kind: 'at' | 'every' | 'cron'
      at?: number | string
      every?: number
      expr?: string
      tz?: string
    }
    prompt: string
    agentId: string | null
    model: string | null
    workingFolder: string | null
    deliveryMode: 'desktop' | 'session' | 'none'
    deliveryTarget: string | null
    enabled: boolean
    deleteAfterRun: boolean
    maxIterations: number
  }>
}

// ── Helpers ──────────────────────────────────────────────────────

function resolveTimestamp(value: number | string | undefined): number | null {
  if (value == null) return null
  if (typeof value === 'number') return value
  const parsed = new Date(value).getTime()
  return isNaN(parsed) ? null : parsed
}

function validateSchedule(schedule: CronAddArgs['schedule']): string | null {
  if (!schedule || !schedule.kind) return 'schedule.kind is required (at | every | cron)'
  if (schedule.kind === 'at') {
    const ts = resolveTimestamp(schedule.at)
    if (!ts) return 'schedule.at must be a valid timestamp (ms) or ISO 8601 string'
    // Reject timestamps that are already in the past (with 30s tolerance)
    if (ts < Date.now() - 30_000) return `schedule.at is in the past (${new Date(ts).toISOString()}). Use a future timestamp.`
  } else if (schedule.kind === 'every') {
    if (!schedule.every || schedule.every < 1000) return 'schedule.every must be >= 1000 ms'
  } else if (schedule.kind === 'cron') {
    if (!schedule.expr) return 'schedule.expr is required for kind=cron'
    const parts = schedule.expr.trim().split(/\s+/)
    if (parts.length < 5 || parts.length > 6) return 'schedule.expr must have 5 or 6 fields'
  } else {
    return `Unknown schedule.kind: "${schedule.kind}"`
  }
  return null
}

interface CronJobApi {
  id: string
  sessionId: string | null
  name: string
  schedule: {
    kind: 'at' | 'every' | 'cron'
    at: number | null
    every: number | null
    expr: string | null
    tz: string
  }
  prompt: string
  agentId: string | null
  model: string | null
  workingFolder: string | null
  deliveryMode: 'desktop' | 'session' | 'none'
  deliveryTarget: string | null
  pluginId: string | null
  pluginChatId: string | null
  enabled: boolean
  deleteAfterRun: boolean
  maxIterations: number
  lastFiredAt: number | null
  fireCount: number
  createdAt: number
  updatedAt: number
  scheduled: boolean
  executing: boolean
}

interface CronRunApi {
  id: string
  jobId: string
  startedAt: number
  finishedAt: number | null
  status: 'running' | 'success' | 'error' | 'aborted'
  toolCallCount: number
  outputSummary: string | null
  error: string | null
}

function jobToApi(r: CronJobRecord, scheduledIds: Set<string>, runningIds: Set<string>): CronJobApi {
  return {
    id: r.id,
    sessionId: r.session_id,
    name: r.name,
    schedule: {
      kind: r.schedule_kind,
      at: r.schedule_at,
      every: r.schedule_every,
      expr: r.schedule_expr,
      tz: r.schedule_tz,
    },
    prompt: r.prompt,
    agentId: r.agent_id,
    model: r.model,
    workingFolder: r.working_folder,
    deliveryMode: r.delivery_mode,
    deliveryTarget: r.delivery_target,
    pluginId: r.plugin_id,
    pluginChatId: r.plugin_chat_id,
    enabled: Boolean(r.enabled),
    deleteAfterRun: Boolean(r.delete_after_run),
    maxIterations: r.max_iterations,
    lastFiredAt: r.last_fired_at,
    fireCount: r.fire_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    scheduled: scheduledIds.has(r.id),
    executing: runningIds.has(r.id),
  }
}

function runToApi(r: CronRunRecord): CronRunApi {
  return {
    id: r.id,
    jobId: r.job_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status,
    toolCallCount: r.tool_call_count,
    outputSummary: r.output_summary,
    error: r.error,
  }
}

// ── Register handlers ────────────────────────────────────────────

export function registerCronHandlers(): void {

  // ── cron:add ─────────────────────────────────────────────────
  ipcMain.handle('cron:add', async (_event, args: CronAddArgs) => {
    if (!args.name) return { error: 'name is required' }
    if (!args.prompt) return { error: 'prompt is required' }

    const schedErr = validateSchedule(args.schedule)
    if (schedErr) return { error: schedErr }

    const id = `cron-${nanoid(8)}`
    const now = Date.now()
    const kind = args.schedule.kind

    const record: CronJobRecord = {
      id,
      name: args.name,
      session_id: args.sessionId ?? null,
      schedule_kind: kind,
      schedule_at: kind === 'at' ? resolveTimestamp(args.schedule.at) : null,
      schedule_every: kind === 'every' ? (args.schedule.every ?? null) : null,
      schedule_expr: kind === 'cron' ? (args.schedule.expr ?? null) : null,
      schedule_tz: args.schedule.tz ?? 'UTC',
      prompt: args.prompt,
      agent_id: args.agentId ?? null,
      model: args.model ?? null,
      working_folder: args.workingFolder ?? null,
      delivery_mode: args.deliveryMode ?? 'desktop',
      delivery_target: args.deliveryTarget ?? null,
      plugin_id: args.pluginId ?? null,
      plugin_chat_id: args.pluginChatId ?? null,
      enabled: 1,
      delete_after_run: args.deleteAfterRun ?? (kind === 'at' ? 1 : 0) ? 1 : 0,
      max_iterations: args.maxIterations ?? 15,
      last_fired_at: null,
      fire_count: 0,
      created_at: now,
      updated_at: now,
    }

    try {
      const db = getDb()
      db.prepare(`
        INSERT INTO cron_jobs
          (id, name, session_id, schedule_kind, schedule_at, schedule_every, schedule_expr, schedule_tz,
           prompt, agent_id, model, working_folder,
           delivery_mode, delivery_target, plugin_id, plugin_chat_id,
           enabled, delete_after_run, max_iterations,
           last_fired_at, fire_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id, record.name, record.session_id,
        record.schedule_kind, record.schedule_at, record.schedule_every, record.schedule_expr, record.schedule_tz,
        record.prompt, record.agent_id, record.model, record.working_folder,
        record.delivery_mode, record.delivery_target, record.plugin_id, record.plugin_chat_id,
        record.enabled, record.delete_after_run, record.max_iterations,
        record.last_fired_at, record.fire_count, record.created_at, record.updated_at,
      )
    } catch (err) {
      return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
    }

    const scheduled = scheduleJob(record)
    if (!scheduled) {
      try { getDb().prepare('DELETE FROM cron_jobs WHERE id = ?').run(id) } catch { /* ignore */ }
      return { error: `Failed to schedule job (kind=${kind})` }
    }

    return { success: true, jobId: id, name: args.name, schedule: args.schedule }
  })

  // ── cron:update ──────────────────────────────────────────────
  ipcMain.handle('cron:update', async (_event, args: CronUpdateArgs) => {
    if (!args.jobId) return { error: 'jobId is required' }
    if (!args.patch || Object.keys(args.patch).length === 0) return { error: 'patch is required' }

    try {
      const db = getDb()
      const row = db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(args.jobId) as CronJobRecord | undefined
      if (!row) return { error: `Job "${args.jobId}" not found` }

      const p = args.patch
      const updated: CronJobRecord = { ...row }

      if (p.name !== undefined) updated.name = p.name
      if (p.prompt !== undefined) updated.prompt = p.prompt
      if (p.agentId !== undefined) updated.agent_id = p.agentId
      if (p.model !== undefined) updated.model = p.model
      if (p.workingFolder !== undefined) updated.working_folder = p.workingFolder
      if (p.deliveryMode !== undefined) updated.delivery_mode = p.deliveryMode
      if (p.deliveryTarget !== undefined) updated.delivery_target = p.deliveryTarget
      if (p.enabled !== undefined) updated.enabled = p.enabled ? 1 : 0
      if (p.deleteAfterRun !== undefined) updated.delete_after_run = p.deleteAfterRun ? 1 : 0
      if (p.maxIterations !== undefined) updated.max_iterations = p.maxIterations

      if (p.schedule) {
        const schedErr = validateSchedule(p.schedule as CronAddArgs['schedule'])
        if (schedErr) return { error: schedErr }
        updated.schedule_kind = p.schedule.kind
        updated.schedule_at = p.schedule.kind === 'at' ? resolveTimestamp(p.schedule.at) : null
        updated.schedule_every = p.schedule.kind === 'every' ? (p.schedule.every ?? null) : null
        updated.schedule_expr = p.schedule.kind === 'cron' ? (p.schedule.expr ?? null) : null
        if (p.schedule.tz) updated.schedule_tz = p.schedule.tz
      }

      updated.updated_at = Date.now()

      db.prepare(`
        UPDATE cron_jobs SET
          name=?, schedule_kind=?, schedule_at=?, schedule_every=?, schedule_expr=?, schedule_tz=?,
          prompt=?, agent_id=?, model=?, working_folder=?,
          delivery_mode=?, delivery_target=?,
          enabled=?, delete_after_run=?, max_iterations=?, updated_at=?
        WHERE id=?
      `).run(
        updated.name, updated.schedule_kind, updated.schedule_at, updated.schedule_every,
        updated.schedule_expr, updated.schedule_tz,
        updated.prompt, updated.agent_id, updated.model, updated.working_folder,
        updated.delivery_mode, updated.delivery_target,
        updated.enabled, updated.delete_after_run, updated.max_iterations, updated.updated_at,
        updated.id,
      )

      // Reschedule if enabled, cancel if disabled
      cancelJob(updated.id)
      if (updated.enabled) {
        scheduleJob(updated)
      }

      return { success: true, jobId: args.jobId }
    } catch (err) {
      return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  // ── cron:remove ──────────────────────────────────────────────
  ipcMain.handle('cron:remove', async (_event, args: { jobId: string }) => {
    if (!args.jobId) return { error: 'jobId is required' }

    try {
      const db = getDb()
      const row = db.prepare('SELECT id FROM cron_jobs WHERE id = ?').get(args.jobId)
      if (!row) return { error: `Job "${args.jobId}" not found` }

      cancelJob(args.jobId)
      db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(args.jobId)
      return { success: true, jobId: args.jobId }
    } catch (err) {
      return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  // ── cron:list ────────────────────────────────────────────────
  ipcMain.handle('cron:list', async (_event, args?: { sessionId?: string | null }) => {
    try {
      const db = getDb()
      const rows = args?.sessionId
        ? db.prepare('SELECT * FROM cron_jobs WHERE session_id = ? ORDER BY created_at DESC').all(args.sessionId) as CronJobRecord[]
        : db.prepare('SELECT * FROM cron_jobs ORDER BY created_at DESC').all() as CronJobRecord[]
      const scheduledIds = new Set(getScheduledJobIds())
      const runningIds = new Set(getActiveRunJobIds())
      return rows.map((r) => jobToApi(r, scheduledIds, runningIds))
    } catch (err) {
      return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  // ── cron:toggle ──────────────────────────────────────────────
  ipcMain.handle('cron:toggle', async (_event, args: { jobId: string; enabled: boolean }) => {
    if (!args.jobId) return { error: 'jobId is required' }

    try {
      const db = getDb()
      const row = db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(args.jobId) as CronJobRecord | undefined
      if (!row) return { error: `Job "${args.jobId}" not found` }

      const now = Date.now()
      db.prepare('UPDATE cron_jobs SET enabled = ?, updated_at = ? WHERE id = ?').run(
        args.enabled ? 1 : 0, now, args.jobId
      )

      if (args.enabled) {
        scheduleJob({ ...row, enabled: 1 })
      } else {
        cancelJob(args.jobId)
      }

      return { success: true, jobId: args.jobId, enabled: args.enabled }
    } catch (err) {
      return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  // ── cron:run-now ─────────────────────────────────────────────
  ipcMain.handle('cron:run-now', async (_event, args: { jobId: string }) => {
    if (!args.jobId) return { error: 'jobId is required' }

    try {
      const db = getDb()
      const row = db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(args.jobId) as CronJobRecord | undefined
      if (!row) return { error: `Job "${args.jobId}" not found` }

      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isDestroyed()) {
        win.webContents.send('cron:fired', {
          jobId: row.id,
          name: row.name,
          prompt: row.prompt,
          agentId: row.agent_id,
          model: row.model,
          workingFolder: row.working_folder,
          sessionId: row.session_id,
          deliveryMode: row.delivery_mode,
          deliveryTarget: row.delivery_target,
          maxIterations: row.max_iterations,
          pluginId: row.plugin_id,
          pluginChatId: row.plugin_chat_id,
        })
      }

      db.prepare(
        'UPDATE cron_jobs SET last_fired_at = ?, fire_count = fire_count + 1 WHERE id = ?'
      ).run(Date.now(), row.id)

      return { success: true, jobId: args.jobId }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ── cron:runs (execution history) ────────────────────────────
  ipcMain.handle('cron:runs', async (_event, args: { jobId?: string; sessionId?: string | null; limit?: number }) => {
    try {
      const db = getDb()
      const limit = Math.min(args?.limit ?? 50, 200)

      if (args?.jobId) {
        const rows = args?.sessionId
          ? db.prepare(
            `SELECT r.* FROM cron_runs r
             INNER JOIN cron_jobs j ON j.id = r.job_id
             WHERE r.job_id = ? AND j.session_id = ?
             ORDER BY r.started_at DESC LIMIT ?`
          ).all(args.jobId, args.sessionId, limit) as CronRunRecord[]
          : db.prepare(
            'SELECT * FROM cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?'
          ).all(args.jobId, limit) as CronRunRecord[]
        return rows.map(runToApi)
      }

      const rows = args?.sessionId
        ? db.prepare(
          `SELECT r.* FROM cron_runs r
           INNER JOIN cron_jobs j ON j.id = r.job_id
           WHERE j.session_id = ?
           ORDER BY r.started_at DESC LIMIT ?`
        ).all(args.sessionId, limit) as CronRunRecord[]
        : db.prepare(
          'SELECT * FROM cron_runs ORDER BY started_at DESC LIMIT ?'
        ).all(limit) as CronRunRecord[]
      return rows.map(runToApi)
    } catch (err) {
      return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  // ── cron:run-finished — renderer notifies main that a cron agent run completed ──
  ipcMain.handle('cron:run-finished', async (_event, args: { jobId: string }) => {
    if (args?.jobId) {
      markFinished(args.jobId)
      console.log(`[CronHandlers] Marked job ${args.jobId} as finished`)
    }
    return { success: true }
  })
}
