import { nanoid } from 'nanoid'
import { getNativeWorker } from '../lib/native-worker'

export type CronScheduleKind = 'at' | 'every' | 'cron'
export type CronRunStatus = 'running' | 'success' | 'error' | 'aborted'
export type CronRunLogType = 'start' | 'text' | 'tool_call' | 'tool_result' | 'error' | 'end'

export interface CronJobRecord {
  id: string
  name: string
  schedule_kind: CronScheduleKind
  schedule_at: number | null
  schedule_every: number | null
  schedule_expr: string | null
  schedule_tz: string
  prompt: string
  agent_id: string | null
  model: string | null
  working_folder: string | null
  ssh_connection_id: string | null
  session_id: string | null
  source_session_title: string | null
  source_project_id: string | null
  source_project_name: string | null
  source_provider_id: string | null
  delivery_mode: 'desktop' | 'session' | 'none'
  delivery_target: string | null
  plugin_id: string | null
  plugin_chat_id: string | null
  enabled: number
  delete_after_run: number
  max_iterations: number
  deleted_at: number | null
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
  status: CronRunStatus
  tool_call_count: number
  output_summary: string | null
  error: string | null
  scheduled_for: number | null
  job_name_snapshot: string | null
  prompt_snapshot: string | null
  source_session_id_snapshot: string | null
  source_session_title_snapshot: string | null
  source_project_id_snapshot: string | null
  source_project_name_snapshot: string | null
  source_provider_id_snapshot: string | null
  model_snapshot: string | null
  working_folder_snapshot: string | null
  delivery_mode_snapshot: string | null
  delivery_target_snapshot: string | null
}

export interface CronRunMessageRow {
  id: string
  role: string
  content: string
  usage: string | null
  message_source: string | null
  created_at: number
}

export interface CronRunLogRow {
  id: string
  timestamp: number
  type: CronRunLogType
  content: string
}

export interface CronRunMessageInput {
  id: string
  role: string
  content: unknown
  usage?: unknown
  source?: string | null
  createdAt: number
}

export interface CronRunCreateArgs {
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

export interface CronRunUpdateArgs {
  runId: string
  patch: Partial<{
    finishedAt: number | null
    status: CronRunStatus
    toolCallCount: number
    outputSummary: string | null
    error: string | null
  }>
}

interface CronMutationResult {
  success: boolean
  changed: number
  error?: string | null
}

interface CronJobFindResult {
  success: boolean
  job?: CronJobRecord | null
  error?: string | null
}

interface CronJobListResult {
  success: boolean
  jobs: CronJobRecord[]
  error?: string | null
}

interface CronRunFindResult {
  success: boolean
  run?: CronRunRecord | null
  error?: string | null
}

interface CronRunListResult {
  success: boolean
  runs: CronRunRecord[]
  error?: string | null
}

interface CronRunDetailResult {
  success: boolean
  run?: CronRunRecord | null
  job?: CronJobRecord | null
  messages: CronRunMessageRow[]
  logs: CronRunLogRow[]
  error?: string | null
}

interface CronStartupLoadResult {
  success: boolean
  jobs: CronJobRecord[]
  abortedRuns: number
  expiredJobs: number
  error?: string | null
}

function assertMutation(result: CronMutationResult, operation: string): CronMutationResult {
  if (!result.success) {
    throw new Error(result.error || `Native cron ${operation} failed`)
  }
  return result
}

function unwrapJob(result: CronJobFindResult, operation: string): CronJobRecord | null {
  if (!result.success) {
    throw new Error(result.error || `Native cron job ${operation} failed`)
  }
  return result.job ?? null
}

function unwrapJobList(result: CronJobListResult, operation: string): CronJobRecord[] {
  if (!result.success) {
    throw new Error(result.error || `Native cron job ${operation} failed`)
  }
  return result.jobs
}

function unwrapRun(result: CronRunFindResult, operation: string): CronRunRecord | null {
  if (!result.success) {
    throw new Error(result.error || `Native cron run ${operation} failed`)
  }
  return result.run ?? null
}

function unwrapRunList(result: CronRunListResult, operation: string): CronRunRecord[] {
  if (!result.success) {
    throw new Error(result.error || `Native cron run ${operation} failed`)
  }
  return result.runs
}

export async function createCronJob(job: CronJobRecord): Promise<void> {
  const result = await getNativeWorker().request<CronMutationResult>(
    'db/cron-jobs-create',
    { job },
    120_000
  )
  assertMutation(result, 'create')
}

export async function updateCronJob(job: CronJobRecord): Promise<void> {
  const result = await getNativeWorker().request<CronMutationResult>(
    'db/cron-jobs-update',
    { job },
    120_000
  )
  assertMutation(result, 'update')
}

export async function getCronJob(jobId: string): Promise<CronJobRecord | null> {
  const result = await getNativeWorker().request<CronJobFindResult>(
    'db/cron-jobs-get',
    { jobId },
    120_000
  )
  return unwrapJob(result, 'get')
}

export async function listCronJobs(args: {
  sessionId?: string | null
  includeDeleted?: boolean
}): Promise<CronJobRecord[]> {
  const result = await getNativeWorker().request<CronJobListResult>(
    'db/cron-jobs-list',
    args,
    120_000
  )
  return unwrapJobList(result, 'list')
}

export async function softDeleteCronJob(jobId: string, now = Date.now()): Promise<void> {
  const result = await getNativeWorker().request<CronMutationResult>(
    'db/cron-jobs-soft-delete',
    { jobId, deletedAt: now, updatedAt: now },
    120_000
  )
  assertMutation(result, 'soft delete')
}

export async function deleteCronJob(jobId: string): Promise<void> {
  const result = await getNativeWorker().request<CronMutationResult>(
    'db/cron-jobs-delete',
    { jobId },
    120_000
  )
  assertMutation(result, 'delete')
}

export async function setCronJobEnabled(
  jobId: string,
  enabled: boolean,
  updatedAt = Date.now()
): Promise<void> {
  const result = await getNativeWorker().request<CronMutationResult>(
    'db/cron-jobs-set-enabled',
    { jobId, enabled, updatedAt },
    120_000
  )
  assertMutation(result, 'set enabled')
}

export async function markCronJobFired(jobId: string, firedAt: number): Promise<void> {
  const result = await getNativeWorker().request<CronMutationResult>(
    'db/cron-jobs-mark-fired',
    { jobId, firedAt },
    120_000
  )
  assertMutation(result, 'mark fired')
}

export async function loadPersistedCronJobs(now = Date.now()): Promise<CronJobRecord[]> {
  const result = await getNativeWorker().request<CronStartupLoadResult>(
    'db/cron-load-persisted-jobs',
    { now },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native cron load persisted jobs failed')
  }
  return result.jobs
}

export async function listCronRuns(args: {
  jobId?: string
  sessionId?: string | null
  start?: number
  end?: number
  limit?: number
}): Promise<CronRunRecord[]> {
  const result = await getNativeWorker().request<CronRunListResult>(
    'db/cron-runs-list',
    args,
    120_000
  )
  return unwrapRunList(result, 'list')
}

export async function createCronRun(args: CronRunCreateArgs): Promise<void> {
  const result = await getNativeWorker().request<CronMutationResult>(
    'db/cron-runs-create',
    args,
    120_000
  )
  assertMutation(result, 'create run')
}

export async function updateCronRun(args: CronRunUpdateArgs): Promise<void> {
  const result = await getNativeWorker().request<CronMutationResult>(
    'db/cron-runs-update',
    args,
    120_000
  )
  assertMutation(result, 'update run')
}

export async function getCronRun(runId: string): Promise<CronRunRecord | null> {
  const result = await getNativeWorker().request<CronRunFindResult>(
    'db/cron-runs-get',
    { runId },
    120_000
  )
  return unwrapRun(result, 'get')
}

export async function replaceCronRunMessages(
  runId: string,
  messages: CronRunMessageInput[]
): Promise<void> {
  const result = await getNativeWorker().request<CronMutationResult>(
    'db/cron-run-messages-replace',
    { runId, messages },
    120_000
  )
  assertMutation(result, 'replace run messages')
}

export async function appendCronRunLog(
  runId: string,
  timestamp: number,
  type: CronRunLogType,
  content: string
): Promise<void> {
  const result = await getNativeWorker().request<CronMutationResult>(
    'db/cron-run-log-append',
    { id: `log-${nanoid(8)}`, runId, timestamp, type, content },
    120_000
  )
  assertMutation(result, 'append run log')
}

export async function getCronRunDetail(runId: string): Promise<{
  run: CronRunRecord
  job: CronJobRecord | null
  messages: CronRunMessageRow[]
  logs: CronRunLogRow[]
}> {
  const result = await getNativeWorker().request<CronRunDetailResult>(
    'db/cron-run-detail',
    { runId },
    120_000
  )
  if (!result.success || !result.run) {
    throw new Error(result.error || `Run "${runId}" not found`)
  }
  return {
    run: result.run,
    job: result.job ?? null,
    messages: result.messages,
    logs: result.logs
  }
}
