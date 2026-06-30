import { getNativeWorker } from '../lib/native-worker'

export type SessionGoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usage_limited'
  | 'budget_limited'
  | 'complete'
export type SessionGoalEventType =
  | 'created'
  | 'replaced'
  | 'objective_updated'
  | 'budget_updated'
  | 'status_changed'
  | 'usage_accounted'
  | 'usage_limited'
  | 'budget_limited'
  | 'completion_deferred'
  | 'blocked'
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

interface NativeGoalFindResult {
  success: boolean
  goal?: SessionGoalRow | null
  error?: string | null
}

interface NativeGoalClearResult {
  success: boolean
  cleared: boolean
  error?: string | null
}

function unwrapGoalResult(result: NativeGoalFindResult, operation: string): SessionGoalRow | null {
  if (!result.success) {
    throw new Error(result.error || `Native goal ${operation} failed`)
  }
  return result.goal ?? null
}

export function addGoalEvent(args: AddGoalEventArgs): Promise<SessionGoalEventRow> {
  return getNativeWorker().request<SessionGoalEventRow>('db/goal-events-add', args, 120_000)
}

export function listGoalEvents(args: {
  sessionId: string
  goalId?: string | null
  limit?: number
}): Promise<SessionGoalEventRow[]> {
  return getNativeWorker().request<SessionGoalEventRow[]>('db/goal-events-list', args, 120_000)
}

export function listGoals(): Promise<SessionGoalRow[]> {
  return getNativeWorker().request<SessionGoalRow[]>('db/goals-list', {}, 120_000)
}

export async function getGoal(sessionId: string): Promise<SessionGoalRow | undefined> {
  const result = await getNativeWorker().request<NativeGoalFindResult>(
    'db/goals-get',
    { sessionId },
    120_000
  )
  return unwrapGoalResult(result, 'get') ?? undefined
}

export async function createGoal(args: {
  sessionId: string
  objective: string
  tokenBudget?: number | null
}): Promise<SessionGoalRow | null> {
  const result = await getNativeWorker().request<NativeGoalFindResult>(
    'db/goals-create',
    args,
    120_000
  )
  return unwrapGoalResult(result, 'create')
}

export function replaceGoal(args: {
  sessionId: string
  objective: string
  status?: SessionGoalStatus
  tokenBudget?: number | null
}): Promise<SessionGoalRow> {
  return getNativeWorker().request<SessionGoalRow>('db/goals-replace', args, 120_000)
}

export async function updateGoal(
  sessionId: string,
  patch: SessionGoalUpdate
): Promise<SessionGoalRow | null> {
  const result = await getNativeWorker().request<NativeGoalFindResult>(
    'db/goals-update',
    { sessionId, patch },
    120_000
  )
  return unwrapGoalResult(result, 'update')
}

export async function clearGoal(sessionId: string): Promise<boolean> {
  const result = await getNativeWorker().request<NativeGoalClearResult>(
    'db/goals-clear',
    { sessionId },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native goal clear failed')
  }
  return result.cleared
}

export async function accountGoalUsage(args: AccountGoalUsageArgs): Promise<SessionGoalRow | null> {
  const result = await getNativeWorker().request<NativeGoalFindResult>(
    'db/goals-account',
    args,
    120_000
  )
  return unwrapGoalResult(result, 'account')
}
