import { getNativeWorker } from '../lib/native-worker'

export type StoredRunChangeStatus = 'open' | 'reverted'
export type StoredFileChangeStatus = 'open' | 'reverted'
export type StoredChangeTransport = 'local' | 'ssh'
export type StoredChangeOp = 'create' | 'modify'

export interface StoredFileSnapshot {
  exists: boolean
  text?: string
  fullText?: string
  previewText?: string
  tailPreviewText?: string
  textOmitted?: boolean
  hash: string | null
  size: number
  lineCount?: number
}

export interface StoredTrackedFileChange {
  id: string
  runId: string
  sessionId?: string
  toolUseId?: string
  toolName?: string
  filePath: string
  transport: StoredChangeTransport
  connectionId?: string
  op: StoredChangeOp
  status: StoredFileChangeStatus
  before: StoredFileSnapshot
  after: StoredFileSnapshot
  createdAt: number
  revertedAt?: number
}

export interface StoredRunChangeSet {
  runId: string
  sessionId?: string
  assistantMessageId: string
  status: StoredRunChangeStatus
  changes: StoredTrackedFileChange[]
  createdAt: number
  updatedAt: number
}

interface AppendFileChangeArgs {
  runId: string
  sessionId?: string
  assistantMessageId: string
  change: StoredTrackedFileChange
  now: number
}

interface AgentChangeSetFindResult {
  success: boolean
  changeSet?: StoredRunChangeSet | null
  error?: string | null
}

interface AgentChangeMutationResult {
  success: boolean
  changed: number
  error?: string | null
}

interface AgentChangeDeleteResult {
  success: boolean
  deletedRunCount: number
  error?: string | null
}

function unwrapChangeSetResult(
  result: AgentChangeSetFindResult,
  operation: string
): StoredRunChangeSet | null {
  if (!result.success) {
    throw new Error(result.error || `Native agent change ${operation} failed`)
  }
  return result.changeSet ?? null
}

function assertMutation(result: AgentChangeMutationResult, operation: string): void {
  if (!result.success) {
    throw new Error(result.error || `Native agent change ${operation} failed`)
  }
}

export async function getStoredRunChangeSet(runId: string): Promise<StoredRunChangeSet | null> {
  const result = await getNativeWorker().request<AgentChangeSetFindResult>(
    'db/agent-changes-get',
    { runId },
    120_000
  )
  return unwrapChangeSetResult(result, 'get')
}

export function listStoredRunChangeSetsBySession(sessionId: string): Promise<StoredRunChangeSet[]> {
  return getNativeWorker().request<StoredRunChangeSet[]>(
    'db/agent-changes-list-session',
    { sessionId },
    120_000
  )
}

export async function appendStoredFileChange(args: AppendFileChangeArgs): Promise<void> {
  const result = await getNativeWorker().request<AgentChangeMutationResult>(
    'db/agent-changes-append-file',
    args,
    120_000
  )
  assertMutation(result, 'append-file')
}

export async function markFileChangeReverted(args: {
  runId: string
  changeId: string
  revertedAt: number
}): Promise<void> {
  const result = await getNativeWorker().request<AgentChangeMutationResult>(
    'db/agent-changes-mark-reverted',
    args,
    120_000
  )
  assertMutation(result, 'mark-reverted')
}

export async function recomputeRunStatus(runId: string): Promise<void> {
  const result = await getNativeWorker().request<AgentChangeMutationResult>(
    'db/agent-changes-recompute',
    { runId, now: Date.now() },
    120_000
  )
  assertMutation(result, 'recompute')
}

export async function deleteStoredFinalizedRunChangeSetsOlderThan(cutoff: number): Promise<void> {
  const result = await getNativeWorker().request<AgentChangeDeleteResult>(
    'db/agent-changes-delete-finalized-before',
    { cutoff },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native agent change delete finalized failed')
  }
}
