import { ipcMain, BrowserWindow } from 'electron'
import { nanoid } from 'nanoid'
import { getDb } from '../db/database'
import {
  scheduleJob,
  cancelJob,
  getScheduledJobIds,
  getActiveRunJobIds,
  markRunning,
  markFinished,
  type CronJobRecord,
  type CronRunRecord
} from '../cron/cron-scheduler'

interface CronAddArgs {
  name: string
  sessionId?: string
  schedule: {
    kind: 'at' | 'every' | 'cron'
    at?: number | string
    every?: number
    expr?: string
    tz?: string
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
  sourceSessionTitle?: string | null
  sourceProjectId?: string | null
  sourceProjectName?: string | null
  sourceProviderId?: string | null
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
    sessionId: string | null
    sourceSessionTitle: string | null
    sourceProjectId: string | null
    sourceProjectName: string | null
    sourceProviderId: string | null
  }>
}

interface CronRunCreateArgs {
  runId: string
  jobId: string
  startedAt: number
  scheduledFor?: number | null
  jobNameSnapshot?: string | null
  promptSnapshot?: string | null
  sourceSessionIdSnapshot?: string | null
  sourceSessionTitleSnapshot?: string | null
  sourceProjectIdSnapshot?: string | null
  sourceProjectNameSnapshot?: string | null
  sourceProviderIdSnapshot?: string | null
  modelSnapshot?: string | null
  workingFolderSnapshot?: string | null
  deliveryModeSnapshot?: string | null
  deliveryTargetSnapshot?: string | null
}

interface CronRunUpdateArgs {
  runId: string
  patch: Partial<{
    finishedAt: number | null
    status: 'running' | 'success' | 'error' | 'aborted'
    toolCallCount: number
    outputSummary: string | null
    error: string | null
  }>
}

interface CronRunMessageInput {
  id: string
  role: string
  content: unknown
  usage?: unknown
  source?: string | null
  createdAt: number
}

interface CronRunMessagesReplaceArgs {
  runId: string
  messages: CronRunMessageInput[]
}

interface CronRunLogAppendArgs {
  runId: string
  timestamp: number
  type: 'start' | 'text' | 'tool_call' | 'tool_result' | 'error' | 'end'
  content: string
}

function resolveTimestamp(value: number | string | undefined): number | null {
  if (value == null) return null
  if (typeof value === 'number') return value
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? null : parsed
}

function validateSchedule(schedule: CronAddArgs['schedule']): string | null {
  if (!schedule || !schedule.kind) return 'schedule.kind is required (at | every | cron)'
  if (schedule.kind === 'at') {
    const ts = resolveTimestamp(schedule.at)
    if (!ts) return 'schedule.at must be a valid timestamp (ms) or ISO 8601 string'
    if (ts < Date.now() - 30_000) {
      return `schedule.at is in the past (${new Date(ts).toISOString()}). Use a future timestamp.`
    }
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
  deletedAt: number | null
  lastFiredAt: number | null
  fireCount: number
  createdAt: number
  updatedAt: number
  sourceSessionTitle: string | null
  sourceProjectId: string | null
  sourceProjectName: string | null
  sourceProviderId: string | null
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
  scheduledFor: number | null
  jobNameSnapshot: string | null
  promptSnapshot: string | null
  sourceSessionIdSnapshot: string | null
  sourceSessionTitleSnapshot: string | null
  sourceProjectIdSnapshot: string | null
  sourceProjectNameSnapshot: string | null
  sourceProviderIdSnapshot: string | null
  modelSnapshot: string | null
  workingFolderSnapshot: string | null
  deliveryModeSnapshot: string | null
  deliveryTargetSnapshot: string | null
}

interface CronRunMessageApi {
  id: string
  role: string
  content: unknown
  usage: unknown
  source: string | null
  createdAt: number
}

interface CronRunLogApi {
  id: string
  timestamp: number
  type: 'start' | 'text' | 'tool_call' | 'tool_result' | 'error' | 'end'
  content: string
}

function parseJsonValue(value: string | null): unknown {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function jobToApi(
  r: CronJobRecord,
  scheduledIds: Set<string>,
  runningIds: Set<string>
): CronJobApi {
  return {
    id: r.id,
    sessionId: r.session_id,
    name: r.name,
    schedule: {
      kind: r.schedule_kind,
      at: r.schedule_at,
      every: r.schedule_every,
      expr: r.schedule_expr,
      tz: r.schedule_tz
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
    deletedAt: r.deleted_at,
    lastFiredAt: r.last_fired_at,
    fireCount: r.fire_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sourceSessionTitle: r.source_session_title,
    sourceProjectId: r.source_project_id,
    sourceProjectName: r.source_project_name,
    sourceProviderId: r.source_provider_id,
    scheduled: scheduledIds.has(r.id),
    executing: runningIds.has(r.id)
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
    scheduledFor: r.scheduled_for,
    jobNameSnapshot: r.job_name_snapshot,
    promptSnapshot: r.prompt_snapshot,
    sourceSessionIdSnapshot: r.source_session_id_snapshot,
    sourceSessionTitleSnapshot: r.source_session_title_snapshot,
    sourceProjectIdSnapshot: r.source_project_id_snapshot,
    sourceProjectNameSnapshot: r.source_project_name_snapshot,
    sourceProviderIdSnapshot: r.source_provider_id_snapshot,
    modelSnapshot: r.model_snapshot,
    workingFolderSnapshot: r.working_folder_snapshot,
    deliveryModeSnapshot: r.delivery_mode_snapshot,
    deliveryTargetSnapshot: r.delivery_target_snapshot
  }
}

export function registerCronHandlers(): void {
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
      source_session_title: args.sourceSessionTitle ?? null,
      source_project_id: args.sourceProjectId ?? null,
      source_project_name: args.sourceProjectName ?? null,
      source_provider_id: args.sourceProviderId ?? null,
      delivery_mode: args.deliveryMode ?? 'desktop',
      delivery_target: args.deliveryTarget ?? null,
      plugin_id: args.pluginId ?? null,
      plugin_chat_id: args.pluginChatId ?? null,
      enabled: 1,
      delete_after_run: (args.deleteAfterRun ?? (kind === 'at' ? 1 : 0)) ? 1 : 0,
      max_iterations: args.maxIterations ?? 15,
      deleted_at: null,
      last_fired_at: null,
      fire_count: 0,
      created_at: now,
      updated_at: now
    }

    try {
      const db = getDb()
      db.prepare(
        `
        INSERT INTO cron_jobs
          (id, name, session_id, schedule_kind, schedule_at, schedule_every, schedule_expr, schedule_tz,
           prompt, agent_id, model, working_folder,
           source_session_title, source_project_id, source_project_name, source_provider_id,
           delivery_mode, delivery_target, plugin_id, plugin_chat_id,
           enabled, delete_after_run, max_iterations, deleted_at,
           last_fired_at, fire_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        record.id,
        record.name,
        record.session_id,
        record.schedule_kind,
        record.schedule_at,
        record.schedule_every,
        record.schedule_expr,
        record.schedule_tz,
        record.prompt,
        record.agent_id,
        record.model,
        record.working_folder,
        record.source_session_title,
        record.source_project_id,
        record.source_project_name,
        record.source_provider_id,
        record.delivery_mode,
        record.delivery_target,
        record.plugin_id,
        record.plugin_chat_id,
        record.enabled,
        record.delete_after_run,
        record.max_iterations,
        record.deleted_at,
        record.last_fired_at,
        record.fire_count,
        record.created_at,
        record.updated_at
      )
    } catch (err) {
      return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
    }

    const scheduled = scheduleJob(record)
    if (!scheduled) {
      try {
        getDb().prepare('DELETE FROM cron_jobs WHERE id = ?').run(id)
      } catch {
        // ignore
      }
      return { error: `Failed to schedule job (kind=${kind})` }
    }

    return { success: true, jobId: id, name: args.name, schedule: args.schedule }
  })

  ipcMain.handle('cron:update', async (_event, args: CronUpdateArgs) => {
    if (!args.jobId) return { error: 'jobId is required' }
    if (!args.patch || Object.keys(args.patch).length === 0) return { error: 'patch is required' }

    try {
      const db = getDb()
      const row = db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(args.jobId) as
        | CronJobRecord
        | undefined
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
      if (p.sessionId !== undefined) updated.session_id = p.sessionId
      if (p.sourceSessionTitle !== undefined) updated.source_session_title = p.sourceSessionTitle
      if (p.sourceProjectId !== undefined) updated.source_project_id = p.sourceProjectId
      if (p.sourceProjectName !== undefined) updated.source_project_name = p.sourceProjectName
      if (p.sourceProviderId !== undefined) updated.source_provider_id = p.sourceProviderId

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

      db.prepare(
        `
        UPDATE cron_jobs SET
          name=?, session_id=?, schedule_kind=?, schedule_at=?, schedule_every=?, schedule_expr=?, schedule_tz=?,
          prompt=?, agent_id=?, model=?, working_folder=?,
          source_session_title=?, source_project_id=?, source_project_name=?, source_provider_id=?,
          delivery_mode=?, delivery_target=?,
          enabled=?, delete_after_run=?, max_iterations=?, updated_at=?
        WHERE id=?
      `
      ).run(
        updated.name,
        updated.session_id,
        updated.schedule_kind,
        updated.schedule_at,
        updated.schedule_every,
        updated.schedule_expr,
        updated.schedule_tz,
        updated.prompt,
        updated.agent_id,
        updated.model,
        updated.working_folder,
        updated.source_session_title,
        updated.source_project_id,
        updated.source_project_name,
        updated.source_provider_id,
        updated.delivery_mode,
        updated.delivery_target,
        updated.enabled,
        updated.delete_after_run,
        updated.max_iterations,
        updated.updated_at,
        updated.id
      )

      cancelJob(updated.id)
      if (updated.enabled && !updated.deleted_at) {
        scheduleJob(updated)
      }

      return { success: true, jobId: args.jobId }
    } catch (err) {
      return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  ipcMain.handle('cron:remove', async (_event, args: { jobId: string }) => {
    if (!args.jobId) return { error: 'jobId is required' }

    try {
      const db = getDb()
      const row = db.prepare('SELECT id FROM cron_jobs WHERE id = ?').get(args.jobId)
      if (!row) return { error: `Job "${args.jobId}" not found` }

      cancelJob(args.jobId)
      const now = Date.now()
      db.prepare(
        'UPDATE cron_jobs SET enabled = 0, deleted_at = ?, updated_at = ? WHERE id = ?'
      ).run(now, now, args.jobId)
      return { success: true, jobId: args.jobId }
    } catch (err) {
      return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  ipcMain.handle(
    'cron:list',
    async (_event, args?: { sessionId?: string | null; includeDeleted?: boolean }) => {
      try {
        const db = getDb()
        const includeDeleted = Boolean(args?.includeDeleted)
        const scheduledIds = new Set(getScheduledJobIds())
        const runningIds = new Set(getActiveRunJobIds())

        let rows: CronJobRecord[]
        if (args?.sessionId) {
          rows = db
            .prepare(
              includeDeleted
                ? 'SELECT * FROM cron_jobs WHERE session_id = ? ORDER BY created_at DESC'
                : 'SELECT * FROM cron_jobs WHERE session_id = ? AND deleted_at IS NULL ORDER BY created_at DESC'
            )
            .all(args.sessionId) as CronJobRecord[]
        } else {
          rows = db
            .prepare(
              includeDeleted
                ? 'SELECT * FROM cron_jobs ORDER BY created_at DESC'
                : 'SELECT * FROM cron_jobs WHERE deleted_at IS NULL ORDER BY created_at DESC'
            )
            .all() as CronJobRecord[]
        }

        return rows.map((r) => jobToApi(r, scheduledIds, runningIds))
      } catch (err) {
        return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
  )

  ipcMain.handle('cron:toggle', async (_event, args: { jobId: string; enabled: boolean }) => {
    if (!args.jobId) return { error: 'jobId is required' }

    try {
      const db = getDb()
      const row = db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(args.jobId) as
        | CronJobRecord
        | undefined
      if (!row) return { error: `Job "${args.jobId}" not found` }
      if (row.deleted_at) return { error: `Job "${args.jobId}" has been deleted` }

      const now = Date.now()
      db.prepare('UPDATE cron_jobs SET enabled = ?, updated_at = ? WHERE id = ?').run(
        args.enabled ? 1 : 0,
        now,
        args.jobId
      )

      if (args.enabled) {
        scheduleJob({ ...row, enabled: 1, updated_at: now })
      } else {
        cancelJob(args.jobId)
      }

      return { success: true, jobId: args.jobId, enabled: args.enabled }
    } catch (err) {
      return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  ipcMain.handle('cron:run-now', async (_event, args: { jobId: string }) => {
    if (!args.jobId) return { error: 'jobId is required' }

    try {
      const db = getDb()
      const row = db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(args.jobId) as
        | CronJobRecord
        | undefined
      if (!row) return { error: `Job "${args.jobId}" not found` }
      if (row.deleted_at) return { error: `Job "${args.jobId}" has been deleted` }

      if (!markRunning(row.id)) {
        return { error: `Job "${row.id}" is already running or concurrency limit reached` }
      }

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
          firedAt: Date.now(),
          deliveryMode: row.delivery_mode,
          deliveryTarget: row.delivery_target,
          maxIterations: row.max_iterations,
          pluginId: row.plugin_id,
          pluginChatId: row.plugin_chat_id
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

  ipcMain.handle(
    'cron:runs',
    async (_event, args: { jobId?: string; sessionId?: string | null; limit?: number }) => {
      try {
        const db = getDb()
        const limit = Math.min(args?.limit ?? 200, 1000)

        if (args?.jobId) {
          const rows = args?.sessionId
            ? db
                .prepare(
                  `SELECT r.* FROM cron_runs r
                 LEFT JOIN cron_jobs j ON j.id = r.job_id
                 WHERE r.job_id = ? AND COALESCE(r.source_session_id_snapshot, j.session_id) = ?
                 ORDER BY r.started_at DESC LIMIT ?`
                )
                .all(args.jobId, args.sessionId, limit)
            : db
                .prepare(
                  'SELECT * FROM cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?'
                )
                .all(args.jobId, limit)
          return (rows as CronRunRecord[]).map(runToApi)
        }

        const rows = args?.sessionId
          ? db
              .prepare(
                `SELECT r.* FROM cron_runs r
               LEFT JOIN cron_jobs j ON j.id = r.job_id
               WHERE COALESCE(r.source_session_id_snapshot, j.session_id) = ?
               ORDER BY r.started_at DESC LIMIT ?`
              )
              .all(args.sessionId, limit)
          : db.prepare('SELECT * FROM cron_runs ORDER BY started_at DESC LIMIT ?').all(limit)
        return (rows as CronRunRecord[]).map(runToApi)
      } catch (err) {
        return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
  )

  ipcMain.handle('cron:run:create', async (_event, args: CronRunCreateArgs) => {
    if (!args.runId || !args.jobId) return { error: 'runId and jobId are required' }
    try {
      const db = getDb()
      db.prepare(
        `
        INSERT INTO cron_runs (
          id, job_id, started_at, finished_at, status, tool_call_count, output_summary, error,
          scheduled_for, job_name_snapshot, prompt_snapshot,
          source_session_id_snapshot, source_session_title_snapshot,
          source_project_id_snapshot, source_project_name_snapshot, source_provider_id_snapshot,
          model_snapshot, working_folder_snapshot,
          delivery_mode_snapshot, delivery_target_snapshot
        ) VALUES (?, ?, ?, NULL, 'running', 0, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        args.runId,
        args.jobId,
        args.startedAt,
        args.scheduledFor ?? null,
        args.jobNameSnapshot ?? null,
        args.promptSnapshot ?? null,
        args.sourceSessionIdSnapshot ?? null,
        args.sourceSessionTitleSnapshot ?? null,
        args.sourceProjectIdSnapshot ?? null,
        args.sourceProjectNameSnapshot ?? null,
        args.sourceProviderIdSnapshot ?? null,
        args.modelSnapshot ?? null,
        args.workingFolderSnapshot ?? null,
        args.deliveryModeSnapshot ?? null,
        args.deliveryTargetSnapshot ?? null
      )
      return { success: true }
    } catch (err) {
      return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  ipcMain.handle('cron:run:update', async (_event, args: CronRunUpdateArgs) => {
    if (!args.runId) return { error: 'runId is required' }
    try {
      const sets: string[] = []
      const values: unknown[] = []
      if (args.patch.finishedAt !== undefined) {
        sets.push('finished_at = ?')
        values.push(args.patch.finishedAt)
      }
      if (args.patch.status !== undefined) {
        sets.push('status = ?')
        values.push(args.patch.status)
      }
      if (args.patch.toolCallCount !== undefined) {
        sets.push('tool_call_count = ?')
        values.push(args.patch.toolCallCount)
      }
      if (args.patch.outputSummary !== undefined) {
        sets.push('output_summary = ?')
        values.push(args.patch.outputSummary)
      }
      if (args.patch.error !== undefined) {
        sets.push('error = ?')
        values.push(args.patch.error)
      }
      if (sets.length === 0) return { success: true }

      values.push(args.runId)
      getDb()
        .prepare(`UPDATE cron_runs SET ${sets.join(', ')} WHERE id = ?`)
        .run(...values)
      return { success: true }
    } catch (err) {
      return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  ipcMain.handle('cron:run-messages:replace', async (_event, args: CronRunMessagesReplaceArgs) => {
    if (!args.runId) return { error: 'runId is required' }
    try {
      const db = getDb()
      const delStmt = db.prepare('DELETE FROM cron_run_messages WHERE run_id = ?')
      const insertStmt = db.prepare(`
        INSERT INTO cron_run_messages (id, run_id, role, content, usage, message_source, sort_order, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const tx = db.transaction(() => {
        delStmt.run(args.runId)
        args.messages.forEach((message, index) => {
          insertStmt.run(
            message.id,
            args.runId,
            message.role,
            JSON.stringify(message.content),
            message.usage === undefined ? null : JSON.stringify(message.usage),
            message.source ?? null,
            index,
            message.createdAt
          )
        })
      })
      tx()
      return { success: true }
    } catch (err) {
      return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  ipcMain.handle('cron:run-log:append', async (_event, args: CronRunLogAppendArgs) => {
    if (!args.runId) return { error: 'runId is required' }
    try {
      const db = getDb()
      const nextSortOrder =
        ((
          db
            .prepare('SELECT MAX(sort_order) AS value FROM cron_run_logs WHERE run_id = ?')
            .get(args.runId) as { value?: number | null }
        )?.value ?? -1) + 1
      db.prepare(
        'INSERT INTO cron_run_logs (id, run_id, timestamp, type, content, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(`log-${nanoid(8)}`, args.runId, args.timestamp, args.type, args.content, nextSortOrder)
      return { success: true }
    } catch (err) {
      return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  ipcMain.handle('cron:run-detail', async (_event, args: { runId: string }) => {
    if (!args.runId) return { error: 'runId is required' }
    try {
      const db = getDb()
      const run = db.prepare('SELECT * FROM cron_runs WHERE id = ?').get(args.runId) as
        | CronRunRecord
        | undefined
      if (!run) return { error: `Run "${args.runId}" not found` }

      const jobRow = db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(run.job_id) as
        | CronJobRecord
        | undefined
      const messageRows = db
        .prepare(
          `SELECT id, role, content, usage, message_source, created_at
           FROM cron_run_messages WHERE run_id = ? ORDER BY sort_order ASC`
        )
        .all(args.runId) as Array<{
        id: string
        role: string
        content: string
        usage: string | null
        message_source: string | null
        created_at: number
      }>
      const logRows = db
        .prepare(
          `SELECT id, timestamp, type, content
           FROM cron_run_logs WHERE run_id = ? ORDER BY sort_order ASC`
        )
        .all(args.runId) as Array<{
        id: string
        timestamp: number
        type: 'start' | 'text' | 'tool_call' | 'tool_result' | 'error' | 'end'
        content: string
      }>

      const scheduledIds = new Set(getScheduledJobIds())
      const runningIds = new Set(getActiveRunJobIds())

      return {
        run: runToApi(run),
        job: jobRow ? jobToApi(jobRow, scheduledIds, runningIds) : null,
        messages: messageRows.map(
          (row): CronRunMessageApi => ({
            id: row.id,
            role: row.role,
            content: parseJsonValue(row.content),
            usage: parseJsonValue(row.usage),
            source: row.message_source,
            createdAt: row.created_at
          })
        ),
        logs: logRows.map(
          (row): CronRunLogApi => ({
            id: row.id,
            timestamp: row.timestamp,
            type: row.type,
            content: row.content
          })
        )
      }
    } catch (err) {
      return { error: `DB error: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  ipcMain.handle('cron:run-finished', async (_event, args: { jobId: string }) => {
    if (args?.jobId) {
      markFinished(args.jobId)
      console.log(`[CronHandlers] Marked job ${args.jobId} as finished`)
    }
    return { success: true }
  })
}
