import { getNativeWorker } from '../lib/native-worker'

export interface SubAgentHistoryMutationResult {
  success: boolean
  affected: number
  error?: string | null
}

export interface SubAgentHistoryMigrationResult {
  success: boolean
  migrated: boolean
  imported: number
  error?: string | null
}

export interface SubAgentHistoryIndex {
  total: number
  sessions: Array<{
    sessionId: string
    count: number
    latestStartedAt: number
  }>
}

export interface SubAgentHistoryApplyRequest {
  upserts?: unknown[]
  removeIds?: string[]
  removeSessionIds?: string[]
}

export async function getSubAgentHistoryIndex(): Promise<SubAgentHistoryIndex> {
  return await getNativeWorker().request<SubAgentHistoryIndex>(
    'db/sub-agent-history-index',
    {},
    120_000
  )
}

export async function listSubAgentHistory<T>(sessionId?: string): Promise<T[]> {
  return await getNativeWorker().request<T[]>(
    'db/sub-agent-history-list',
    sessionId ? { sessionId } : {},
    120_000
  )
}

export async function applySubAgentHistory(request: SubAgentHistoryApplyRequest): Promise<void> {
  const result = await getNativeWorker().request<SubAgentHistoryMutationResult>(
    'db/sub-agent-history-apply',
    request,
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Failed to persist sub-agent history')
  }
}

export async function replaceSubAgentHistory(snapshot: unknown): Promise<void> {
  const result = await getNativeWorker().request<SubAgentHistoryMutationResult>(
    'db/sub-agent-history-replace',
    { snapshot },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Failed to replace sub-agent history')
  }
}

export async function migrateLegacySubAgentHistorySettings(): Promise<SubAgentHistoryMigrationResult> {
  return await getNativeWorker().request<SubAgentHistoryMigrationResult>(
    'db/sub-agent-history-migrate-settings',
    {},
    120_000
  )
}
