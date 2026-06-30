import { createHash } from 'crypto'
import { ipcMain } from 'electron'
import {
  appendStoredFileChange,
  deleteStoredFinalizedRunChangeSetsOlderThan,
  getStoredRunChangeSet,
  markFileChangeReverted,
  recomputeRunStatus
} from '../db/agent-changes-dao'
import { getNativeWorker } from '../lib/native-worker'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'

export type RunChangeStatus = 'open' | 'reverted'
export type FileChangeStatus = 'open' | 'reverted'
type ChangeOp = 'create' | 'modify'
type ChangeTransport = 'local' | 'ssh'

interface ChangeMeta {
  runId?: string
  sessionId?: string
  toolUseId?: string
  toolName?: string
}

interface ListSessionRunChangesArgs {
  sessionId: string
}

export interface FileSnapshot {
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

interface TrackedFileChange {
  id: string
  runId: string
  sessionId?: string
  toolUseId?: string
  toolName?: string
  filePath: string
  transport: ChangeTransport
  connectionId?: string
  op: ChangeOp
  status: FileChangeStatus
  before: FileSnapshot
  after: FileSnapshot
  createdAt: number
  revertedAt?: number
}

interface RunChangeSet {
  runId: string
  sessionId?: string
  assistantMessageId: string
  status: RunChangeStatus
  changes: TrackedFileChange[]
  createdAt: number
  updatedAt: number
}

interface SshChangeAdapter {
  readSnapshot: (connectionId: string, filePath: string) => Promise<FileSnapshot>
  writeText: (connectionId: string, filePath: string, content: string) => Promise<void>
  deleteFile: (connectionId: string, filePath: string) => Promise<void>
}

interface NativeAgentChangeHydratedListResult {
  success: boolean
  changeSets?: RunChangeSet[] | null
  error?: string | null
}

interface NativeAgentChangeHydratedGetResult {
  success: boolean
  changeSet?: RunChangeSet | null
  error?: string | null
}

interface NativeAgentChangeDiffResult {
  success: boolean
  handled: boolean
  notFound: boolean
  beforeText?: string | null
  afterText?: string | null
  error?: string | null
}

interface NativeAgentChangeRollbackResult {
  success: boolean
  handled: boolean
  reverted: boolean
  revertedAt?: number | null
  reason?: string | null
  error?: string | null
}

function registerAgentChangeMessagePackHandler<TArgs>(
  channel: string,
  handler: (args: TArgs) => Promise<unknown> | unknown
): void {
  ipcMain.handle(toMessagePackChannel(channel), async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<TArgs>(bytes)
    return encodeMessagePackPayload(await handler(args))
  })
}

let sshChangeAdapter: SshChangeAdapter | null = null

const INLINE_TEXT_SNAPSHOT_LIMIT_BYTES = 64 * 1024
const SNAPSHOT_PREVIEW_HEAD_CHARS = 1200
const SNAPSHOT_PREVIEW_TAIL_CHARS = 400
const FINALIZED_RUN_CHANGES_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

let lastPruneAt = 0
const PRUNE_INTERVAL_MS = 5 * 60 * 1000

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function buildFileSnapshot(exists: boolean, text?: string): FileSnapshot {
  if (!exists) {
    return {
      exists: false,
      hash: null,
      size: 0
    }
  }

  if (text === undefined) {
    return buildOpaqueExistingSnapshot()
  }

  const normalizedText = text
  const size = Buffer.byteLength(normalizedText, 'utf-8')
  const lineCount =
    normalizedText.length === 0 ? 0 : normalizedText.replace(/\r\n/g, '\n').split('\n').length
  if (size <= INLINE_TEXT_SNAPSHOT_LIMIT_BYTES) {
    return {
      exists: true,
      text: normalizedText,
      fullText: normalizedText,
      hash: hashText(normalizedText),
      size,
      lineCount
    }
  }

  return {
    exists: true,
    fullText: normalizedText,
    previewText: normalizedText.slice(0, SNAPSHOT_PREVIEW_HEAD_CHARS),
    ...(normalizedText.length > SNAPSHOT_PREVIEW_TAIL_CHARS
      ? { tailPreviewText: normalizedText.slice(-SNAPSHOT_PREVIEW_TAIL_CHARS) }
      : {}),
    textOmitted: true,
    hash: hashText(normalizedText),
    size,
    lineCount
  }
}

function buildLightSnapshot(text: string): FileSnapshot {
  const size = Buffer.byteLength(text, 'utf-8')
  const lineCount = text.length === 0 ? 0 : text.replace(/\r\n/g, '\n').split('\n').length
  if (size <= INLINE_TEXT_SNAPSHOT_LIMIT_BYTES) {
    return {
      exists: true,
      text,
      fullText: text,
      hash: hashText(text),
      size,
      lineCount
    }
  }

  return {
    exists: true,
    previewText: text.slice(0, SNAPSHOT_PREVIEW_HEAD_CHARS),
    ...(text.length > SNAPSHOT_PREVIEW_TAIL_CHARS
      ? { tailPreviewText: text.slice(-SNAPSHOT_PREVIEW_TAIL_CHARS) }
      : {}),
    textOmitted: true,
    hash: hashText(text),
    size,
    lineCount
  }
}

export function buildOpaqueExistingSnapshot(): FileSnapshot {
  return {
    exists: true,
    hash: null,
    size: 0
  }
}

async function pruneStaleRunChangesIfNeeded(): Promise<void> {
  const now = Date.now()
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return
  lastPruneAt = now
  await deleteStoredFinalizedRunChangeSetsOlderThan(now - FINALIZED_RUN_CHANGES_RETENTION_MS)
}

function resolveRunId(meta?: ChangeMeta): string | null {
  const runId = meta?.runId?.trim()
  if (runId) return runId
  const toolUseId = meta?.toolUseId?.trim()
  if (toolUseId) return toolUseId
  return null
}

async function recordTextWriteChange(args: {
  meta?: ChangeMeta
  filePath: string
  before: FileSnapshot
  afterText: string
  transport: ChangeTransport
  connectionId?: string
}): Promise<void> {
  const runId = resolveRunId(args.meta)
  if (!runId) {
    console.warn(
      '[agent-changes] dropping change record: no runId or toolUseId in meta',
      args.filePath
    )
    return
  }

  const after = buildLightSnapshot(args.afterText)
  if (args.before.exists === after.exists && args.before.hash === after.hash) {
    return
  }

  const now = Date.now()
  const sessionId = args.meta?.sessionId?.trim() || undefined
  const assistantMessageId = args.meta?.runId?.trim() || runId
  const existingForId = await getStoredRunChangeSet(runId)
  const sequence = (existingForId?.changes.length ?? 0) + 1

  const change: TrackedFileChange = {
    id: `${runId}:${sequence}`,
    runId,
    sessionId,
    toolUseId: args.meta?.toolUseId,
    toolName: args.meta?.toolName,
    filePath: args.filePath,
    transport: args.transport,
    connectionId: args.connectionId,
    op: args.before.exists ? 'modify' : 'create',
    status: 'open',
    before: args.before,
    after,
    createdAt: now
  }

  await appendStoredFileChange({
    runId,
    sessionId,
    assistantMessageId,
    change,
    now
  })
}

export async function recordLocalTextWriteChange(args: {
  meta?: ChangeMeta
  filePath: string
  beforeExists: boolean
  beforeText?: string
  afterText: string
}): Promise<void> {
  await recordTextWriteChange({
    meta: args.meta,
    filePath: args.filePath,
    before: buildFileSnapshot(args.beforeExists, args.beforeText),
    afterText: args.afterText,
    transport: 'local'
  })
}

export async function recordSshTextWriteChange(args: {
  meta?: ChangeMeta
  connectionId: string
  filePath: string
  before: FileSnapshot
  afterText: string
}): Promise<void> {
  await recordTextWriteChange({
    meta: args.meta,
    filePath: args.filePath,
    before: args.before,
    afterText: args.afterText,
    transport: 'ssh',
    connectionId: args.connectionId
  })
}

export function registerSshChangeAdapter(adapter: SshChangeAdapter): void {
  sshChangeAdapter = adapter
}

async function loadRunChangeSet(runId: string): Promise<RunChangeSet | null> {
  const result = await getNativeWorker().request<NativeAgentChangeHydratedGetResult>(
    'agent-changes/get-hydrated',
    { runId },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native agent change get failed')
  }
  return result.changeSet ?? null
}

async function getRunChangeSetsBySession(sessionId: string): Promise<RunChangeSet[]> {
  await pruneStaleRunChangesIfNeeded()
  const result = await getNativeWorker().request<NativeAgentChangeHydratedListResult>(
    'agent-changes/list-session-hydrated',
    { sessionId },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native agent change list failed')
  }
  return result.changeSets ?? []
}

async function findChange(
  runId: string,
  changeId: string
): Promise<{ changeSet: RunChangeSet; change: TrackedFileChange } | null> {
  const changeSet = await loadRunChangeSet(runId)
  if (!changeSet) return null
  const change = changeSet.changes.find((entry) => entry.id === changeId)
  if (!change) return null
  return { changeSet, change }
}

function resolveSnapshotFullText(snapshot: FileSnapshot): string | null {
  if (!snapshot.exists) return ''
  return snapshot.fullText ?? snapshot.text ?? null
}

async function getChangeDiffContent(
  runId: string,
  changeId: string
): Promise<{ beforeText: string; afterText: string } | { error: string } | null> {
  const nativeLocal = await getNativeWorker().request<NativeAgentChangeDiffResult>(
    'agent-changes/diff-local',
    { runId, changeId },
    120_000
  )
  if (nativeLocal.handled) {
    if (nativeLocal.notFound) return null
    if (!nativeLocal.success) return { error: nativeLocal.error || 'Native local diff failed' }
    if (nativeLocal.beforeText == null || nativeLocal.afterText == null) {
      return { error: 'Full diff is unavailable for this change' }
    }
    return {
      beforeText: nativeLocal.beforeText,
      afterText: nativeLocal.afterText
    }
  }

  const found = await findChange(runId, changeId)
  if (!found) return null

  const beforeText = resolveSnapshotFullText(found.change.before)
  let afterText = resolveSnapshotFullText(found.change.after)

  if (afterText === null && found.change.status === 'open') {
    if (found.change.connectionId && sshChangeAdapter) {
      try {
        const snap = await sshChangeAdapter.readSnapshot(
          found.change.connectionId,
          found.change.filePath
        )
        const snapText = resolveSnapshotFullText(snap)
        if (snapText !== null && hashText(snapText) === found.change.after.hash) {
          afterText = snapText
        }
      } catch {
        // SSH connection may be unavailable
      }
    }
  }

  if (beforeText === null || afterText === null) {
    return { error: 'Full diff is unavailable for this change' }
  }

  return { beforeText, afterText }
}

async function forceRollback(
  change: TrackedFileChange
): Promise<{ reverted: boolean; reason?: string }> {
  if (change.transport === 'local') {
    const result = await getNativeWorker().request<NativeAgentChangeRollbackResult>(
      'agent-changes/rollback-local-change',
      { change },
      120_000
    )
    if (!result.handled) {
      return { reverted: false, reason: 'Native local rollback did not handle this change' }
    }
    if (!result.success || !result.reverted) {
      return { reverted: false, reason: result.reason || result.error || 'Native rollback failed' }
    }
    change.status = 'reverted'
    change.revertedAt = result.revertedAt ?? Date.now()
    return { reverted: true }
  }

  if (change.op === 'create') {
    if (!change.connectionId || !sshChangeAdapter) {
      return { reverted: false, reason: 'SSH change adapter is unavailable' }
    }
    try {
      await sshChangeAdapter.deleteFile(change.connectionId, change.filePath)
    } catch (err) {
      return { reverted: false, reason: String(err) }
    }

    change.status = 'reverted'
    change.revertedAt = Date.now()
    return { reverted: true }
  }

  const beforeText = resolveSnapshotFullText(change.before)
  if (change.before.exists && beforeText === null) {
    return {
      reverted: false,
      reason: 'Original content was not captured in full (file too large at capture time)'
    }
  }

  const targetText = beforeText ?? ''
  if (!change.connectionId || !sshChangeAdapter) {
    return { reverted: false, reason: 'SSH change adapter is unavailable' }
  }
  try {
    await sshChangeAdapter.writeText(change.connectionId, change.filePath, targetText)
  } catch (err) {
    return { reverted: false, reason: String(err) }
  }

  change.status = 'reverted'
  change.revertedAt = Date.now()
  return { reverted: true }
}

async function undoRunChangeSet(runId: string): Promise<{
  success: boolean
  revertedCount: number
  failureCount: number
  failures: Array<{ changeId: string; filePath: string; reason: string }>
  changeset: RunChangeSet | null
}> {
  const changeSet = await loadRunChangeSet(runId)
  if (!changeSet) {
    return {
      success: false,
      revertedCount: 0,
      failureCount: 0,
      failures: [],
      changeset: null
    }
  }

  let revertedCount = 0
  let failureCount = 0
  const failures: Array<{ changeId: string; filePath: string; reason: string }> = []

  for (const change of [...changeSet.changes].reverse()) {
    if (change.status !== 'open') continue
    const result = await forceRollback(change)
    if (result.reverted) {
      revertedCount += 1
      await markFileChangeReverted({
        runId,
        changeId: change.id,
        revertedAt: change.revertedAt ?? Date.now()
      })
    } else {
      failureCount += 1
      failures.push({
        changeId: change.id,
        filePath: change.filePath,
        reason: result.reason ?? 'Unknown error'
      })
    }
  }

  await recomputeRunStatus(runId)
  const refreshed = await loadRunChangeSet(runId)

  return {
    success: failureCount === 0,
    revertedCount,
    failureCount,
    failures,
    changeset: refreshed
  }
}

async function undoFileChange(
  runId: string,
  changeId: string
): Promise<{
  success: boolean
  reason?: string
  changeset: RunChangeSet | null
}> {
  const found = await findChange(runId, changeId)
  if (!found) {
    return { success: false, reason: 'Change not found', changeset: null }
  }

  if (found.change.status === 'reverted') {
    return { success: true, changeset: found.changeSet }
  }

  const result = await forceRollback(found.change)
  if (result.reverted) {
    await markFileChangeReverted({
      runId,
      changeId,
      revertedAt: found.change.revertedAt ?? Date.now()
    })
  }
  await recomputeRunStatus(runId)
  const refreshed = await loadRunChangeSet(runId)

  return {
    success: result.reverted,
    reason: result.reason,
    changeset: refreshed
  }
}

export function registerAgentChangeHandlers(): void {
  registerAgentChangeMessagePackHandler<ListSessionRunChangesArgs>(
    'agent:changes:list-session',
    async (args) => {
      try {
        if (!args?.sessionId) return []
        return await getRunChangeSetsBySession(args.sessionId)
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  registerAgentChangeMessagePackHandler<{ runId: string; changeId: string }>(
    'agent:changes:diff-content',
    async (args) => {
      try {
        if (!args?.runId || !args?.changeId) return { error: 'runId and changeId are required' }
        return await getChangeDiffContent(args.runId, args.changeId)
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  registerAgentChangeMessagePackHandler<{ runId: string }>(
    'agent:changes:undo-run',
    async (args) => {
      try {
        if (!args?.runId) return { error: 'runId is required' }
        return await undoRunChangeSet(args.runId)
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  registerAgentChangeMessagePackHandler<{ runId: string; changeId: string }>(
    'agent:changes:undo-file',
    async (args) => {
      try {
        if (!args?.runId || !args?.changeId) return { error: 'runId and changeId are required' }
        return await undoFileChange(args.runId, args.changeId)
      } catch (err) {
        return { error: String(err) }
      }
    }
  )
}
