import { getNativeWorker } from '../lib/native-worker'
import { initializeDatabase } from '../db/database'
import type { HookEventName, HookRunStatus, HookTrustStatus } from '../../shared/hooks/types'

const HOOKS_DB_TIMEOUT_MS = 60_000

export interface HookTrustRow {
  id: string
  identityKey: string
  trustKey: string
  sourceKind: string
  sourcePath: string
  sourceRealPath: string
  sourceConfigHash: string
  projectId?: string | null
  projectRoot?: string | null
  projectRootRealPath?: string | null
  eventName: HookEventName
  matcher: string
  handlerType: 'command'
  command: string
  resolvedCwd: string
  envFingerprint: string
  definitionHash: string
  artifactHashesJson?: string | null
  status: HookTrustStatus | 'missing'
  localDisabled: boolean
  snapshotJson: string
  lastReviewedAt?: number | null
  createdAt: number
  updatedAt: number
}

export interface HookRunRow {
  id: string
  trustKey: string
  runId?: string | null
  sessionId?: string | null
  eventName: HookEventName
  startedAt: number
  completedAt?: number | null
  durationMs?: number | null
  status: HookRunStatus
  exitCode?: number | null
  skippedReason?: string | null
  stdoutPreview?: string | null
  stderrPreview?: string | null
  decisionJson?: string | null
  error?: string | null
  retainedUntil?: number | null
}

interface ListTrustsResult {
  success: boolean
  rows?: HookTrustRow[]
  error?: string | null
}

interface TrustMutationResult {
  success: boolean
  changed?: number
  row?: HookTrustRow | null
  error?: string | null
}

interface RunListResult {
  success: boolean
  rows?: HookRunRow[]
  error?: string | null
}

interface RunMutationResult {
  success: boolean
  changed?: number
  error?: string | null
}

async function nativeRequest<T>(method: string, params?: unknown): Promise<T> {
  await initializeDatabase()
  return await getNativeWorker().request<T>(method, params ?? {}, HOOKS_DB_TIMEOUT_MS)
}

export async function listHookTrusts(): Promise<HookTrustRow[]> {
  const result = await nativeRequest<ListTrustsResult>('db/hooks-trusts-list')
  if (!result.success) throw new Error(result.error || 'Failed to list hook trusts')
  return result.rows ?? []
}

export async function upsertHookTrust(row: HookTrustRow): Promise<HookTrustRow> {
  const result = await nativeRequest<TrustMutationResult>('db/hooks-trusts-upsert', row)
  if (!result.success || !result.row) throw new Error(result.error || 'Failed to update hook trust')
  return result.row
}

export async function insertHookRun(row: HookRunRow): Promise<void> {
  const result = await nativeRequest<RunMutationResult>('db/hooks-runs-insert', row)
  if (!result.success) throw new Error(result.error || 'Failed to insert hook run')
}

export async function listHookRuns(trustKey: string, limit = 50): Promise<HookRunRow[]> {
  const result = await nativeRequest<RunListResult>('db/hooks-runs-list', { trustKey, limit })
  if (!result.success) throw new Error(result.error || 'Failed to list hook runs')
  return result.rows ?? []
}

export async function cleanupHookRuns(): Promise<void> {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
  const result = await nativeRequest<RunMutationResult>('db/hooks-runs-cleanup', { cutoff })
  if (!result.success) throw new Error(result.error || 'Failed to cleanup hook runs')
}
