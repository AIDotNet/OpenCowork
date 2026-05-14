import { nanoid } from 'nanoid'
import { getDb } from './database'

export type SessionGoalStatus = 'active' | 'paused' | 'budget_limited' | 'complete'
export type SessionGoalEventType =
  | 'created'
  | 'replaced'
  | 'objective_updated'
  | 'budget_updated'
  | 'status_changed'
  | 'usage_accounted'
  | 'budget_limited'
  | 'completion_deferred'
  | 'completed'
  | 'stall_paused'
  | 'auto_continue_blocked'
  | 'cleared'

export interface SessionGoalRow {
  session_id: string
  goal_id: string
  objective: string
  status: SessionGoalStatus
  token_budget: number | null
  tokens_used: number
  time_used_seconds: number
  created_at: number
  updated_at: number
}

export interface SessionGoalEventRow {
  id: string
  session_id: string
  goal_id: string | null
  event_type: SessionGoalEventType
  message: string | null
  metadata_json: string | null
  created_at: number
}

export interface SessionGoalUpdate {
  objective?: string
  status?: SessionGoalStatus
  tokenBudget?: number | null
}

export interface AccountGoalUsageArgs {
  sessionId: string
  timeDeltaSeconds: number
  tokenDelta: number
  expectedGoalId?: string | null
}

export interface AddGoalEventArgs {
  sessionId: string
  goalId?: string | null
  eventType: SessionGoalEventType
  message?: string | null
  metadata?: Record<string, unknown> | null
  createdAt?: number
}

function serializeGoalEventMetadata(
  metadata: Record<string, unknown> | null | undefined
): string | null {
  if (!metadata || Object.keys(metadata).length === 0) return null
  return JSON.stringify(metadata)
}

function normalizeStatusAfterBudget(
  status: SessionGoalStatus,
  tokensUsed: number,
  tokenBudget: number | null
): SessionGoalStatus {
  if (
    (status === 'active' || status === 'paused') &&
    tokenBudget !== null &&
    tokensUsed >= tokenBudget
  ) {
    return 'budget_limited'
  }
  return status
}

function validateGoalBudget(tokenBudget: number | null | undefined): void {
  if (tokenBudget !== undefined && tokenBudget !== null && tokenBudget <= 0) {
    throw new Error('goal budgets must be positive when provided')
  }
}

export function addGoalEvent(args: AddGoalEventArgs): SessionGoalEventRow {
  const db = getDb()
  const createdAt = args.createdAt ?? Date.now()
  return db
    .prepare(
      `INSERT INTO session_goal_events (
        id, session_id, goal_id, event_type, message, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING *`
    )
    .get(
      nanoid(),
      args.sessionId,
      args.goalId ?? null,
      args.eventType,
      args.message?.trim() || null,
      serializeGoalEventMetadata(args.metadata),
      createdAt
    ) as SessionGoalEventRow
}

export function listGoalEvents(args: {
  sessionId: string
  goalId?: string | null
  limit?: number
}): SessionGoalEventRow[] {
  const db = getDb()
  const limit = Math.min(Math.max(Math.floor(args.limit ?? 40), 1), 100)
  const goalId = args.goalId?.trim() || null
  if (goalId) {
    return db
      .prepare(
        `SELECT * FROM session_goal_events
         WHERE session_id = ? AND goal_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(args.sessionId, goalId, limit) as SessionGoalEventRow[]
  }
  return db
    .prepare(
      `SELECT * FROM session_goal_events
       WHERE session_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(args.sessionId, limit) as SessionGoalEventRow[]
}

export function listGoals(): SessionGoalRow[] {
  const db = getDb()
  return db
    .prepare('SELECT * FROM session_goals ORDER BY updated_at DESC')
    .all() as SessionGoalRow[]
}

export function getGoal(sessionId: string): SessionGoalRow | undefined {
  const db = getDb()
  return db.prepare('SELECT * FROM session_goals WHERE session_id = ?').get(sessionId) as
    | SessionGoalRow
    | undefined
}

export function createGoal(args: {
  sessionId: string
  objective: string
  tokenBudget?: number | null
}): SessionGoalRow | null {
  validateGoalBudget(args.tokenBudget)
  const db = getDb()
  const now = Date.now()
  const status = normalizeStatusAfterBudget('active', 0, args.tokenBudget ?? null)
  const row = db
    .prepare(
      `INSERT INTO session_goals (
        session_id, goal_id, objective, status, token_budget,
        tokens_used, time_used_seconds, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
      ON CONFLICT(session_id) DO NOTHING
      RETURNING *`
    )
    .get(args.sessionId, nanoid(), args.objective, status, args.tokenBudget ?? null, now, now) as
    | SessionGoalRow
    | undefined

  if (row) {
    addGoalEvent({
      sessionId: row.session_id,
      goalId: row.goal_id,
      eventType: 'created',
      metadata: { tokenBudget: row.token_budget }
    })
  }

  return row ?? null
}

export function replaceGoal(args: {
  sessionId: string
  objective: string
  status?: SessionGoalStatus
  tokenBudget?: number | null
}): SessionGoalRow {
  validateGoalBudget(args.tokenBudget)
  const db = getDb()
  const existing = getGoal(args.sessionId)
  const now = Date.now()
  const status = normalizeStatusAfterBudget(args.status ?? 'active', 0, args.tokenBudget ?? null)
  const row = db
    .prepare(
      `INSERT INTO session_goals (
        session_id, goal_id, objective, status, token_budget,
        tokens_used, time_used_seconds, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        goal_id = excluded.goal_id,
        objective = excluded.objective,
        status = excluded.status,
        token_budget = excluded.token_budget,
        tokens_used = 0,
        time_used_seconds = 0,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
      RETURNING *`
    )
    .get(
      args.sessionId,
      nanoid(),
      args.objective,
      status,
      args.tokenBudget ?? null,
      now,
      now
    ) as SessionGoalRow

  addGoalEvent({
    sessionId: row.session_id,
    goalId: row.goal_id,
    eventType: existing ? 'replaced' : 'created',
    metadata: { status: row.status, tokenBudget: row.token_budget }
  })
  return row
}

export function updateGoal(sessionId: string, patch: SessionGoalUpdate): SessionGoalRow | null {
  validateGoalBudget(patch.tokenBudget)
  const existing = getGoal(sessionId)
  if (!existing) return null

  const objective = patch.objective ?? existing.objective
  const tokenBudget = patch.tokenBudget !== undefined ? patch.tokenBudget : existing.token_budget
  const status = normalizeStatusAfterBudget(
    patch.status ?? existing.status,
    existing.tokens_used,
    tokenBudget
  )
  const now = Date.now()
  const db = getDb()
  const row = db
    .prepare(
      `UPDATE session_goals
       SET objective = ?,
           status = ?,
           token_budget = ?,
           updated_at = ?
       WHERE session_id = ?
       RETURNING *`
    )
    .get(objective, status, tokenBudget, now, sessionId) as SessionGoalRow | null

  if (row) {
    if (patch.objective !== undefined && row.objective !== existing.objective) {
      addGoalEvent({
        sessionId,
        goalId: row.goal_id,
        eventType: 'objective_updated'
      })
    }
    if (patch.tokenBudget !== undefined && row.token_budget !== existing.token_budget) {
      addGoalEvent({
        sessionId,
        goalId: row.goal_id,
        eventType: 'budget_updated',
        metadata: { tokenBudget: row.token_budget, tokensUsed: row.tokens_used }
      })
    }
    if (row.status !== existing.status) {
      addGoalEvent({
        sessionId,
        goalId: row.goal_id,
        eventType: row.status === 'budget_limited' ? 'budget_limited' : 'status_changed',
        metadata: { from: existing.status, to: row.status }
      })
    }
  }

  return row
}

export function clearGoal(sessionId: string): boolean {
  const existing = getGoal(sessionId)
  const db = getDb()
  const result = db.prepare('DELETE FROM session_goals WHERE session_id = ?').run(sessionId)
  if (result.changes > 0) {
    addGoalEvent({
      sessionId,
      goalId: existing?.goal_id ?? null,
      eventType: 'cleared'
    })
  }
  return result.changes > 0
}

export function accountGoalUsage(args: AccountGoalUsageArgs): SessionGoalRow | null {
  const timeDeltaSeconds = Math.max(0, Math.floor(args.timeDeltaSeconds))
  const tokenDelta = Math.max(0, Math.floor(args.tokenDelta))
  if (timeDeltaSeconds === 0 && tokenDelta === 0) {
    return getGoal(args.sessionId) ?? null
  }

  const expectedGoalId = args.expectedGoalId?.trim() || null
  const db = getDb()
  const existing = getGoal(args.sessionId)
  const now = Date.now()
  const row = db
    .prepare(
      `UPDATE session_goals
       SET time_used_seconds = time_used_seconds + ?,
           tokens_used = tokens_used + ?,
           status = CASE
             WHEN status IN ('active', 'paused')
               AND token_budget IS NOT NULL
               AND tokens_used + ? >= token_budget
             THEN 'budget_limited'
             ELSE status
           END,
           updated_at = ?
       WHERE session_id = ?
         AND (? IS NULL OR goal_id = ?)
         AND status IN ('active', 'paused', 'budget_limited', 'complete')
       RETURNING *`
    )
    .get(
      timeDeltaSeconds,
      tokenDelta,
      tokenDelta,
      now,
      args.sessionId,
      expectedGoalId,
      expectedGoalId
    ) as SessionGoalRow | null

  if (row) {
    addGoalEvent({
      sessionId: args.sessionId,
      goalId: row.goal_id,
      eventType: 'usage_accounted',
      metadata: {
        timeDeltaSeconds,
        tokenDelta,
        tokensUsed: row.tokens_used,
        timeUsedSeconds: row.time_used_seconds
      }
    })
    if (existing?.status !== 'budget_limited' && row.status === 'budget_limited') {
      addGoalEvent({
        sessionId: args.sessionId,
        goalId: row.goal_id,
        eventType: 'budget_limited',
        metadata: { tokenBudget: row.token_budget, tokensUsed: row.tokens_used }
      })
    }
  }

  return row
}
