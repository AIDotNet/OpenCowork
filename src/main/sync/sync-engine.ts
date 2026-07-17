import { app } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { applySyncDbMerge, captureSyncDbSnapshot, saveSyncDbMetadata } from '../db/sync-dao'
import { flushSettingsSync, reloadSettingsCache } from '../ipc/settings-handlers'
import { getNativeWorker } from '../lib/native-worker'
import { safeSendMessagePackToAllWindows } from '../window-ipc'
import {
  getActiveSyncProvider,
  patchSyncConfig,
  readSyncConfig,
  writeSyncConfig
} from './sync-config'
import { RemoteStateChangedError, WebDavProvider, type RemoteBundleState } from './webdav-provider'
import type {
  SyncBundle,
  SyncBundleManifest,
  SyncConflict,
  SyncConflictResolution,
  SyncProviderConfig,
  SyncProviderDescriptor,
  SyncRecord,
  SyncRunMode,
  SyncRunStatus,
  SyncRunSummary,
  SyncStatus,
  SyncTombstone
} from '../../shared/sync-types'

const SYNC_SCHEMA_VERSION = 1
const KEY_SEPARATOR = '\u0000'
const FILE_DOMAIN = 'file'
const SYNC_NATIVE_TIMEOUT_MS = 120_000

interface BaselineRecordState {
  domain: string
  recordId: string
  contentHash: string
}

interface LocalSnapshot {
  records: Map<string, SyncRecord>
  tombstones: Map<string, SyncTombstone>
  baseline: Map<string, BaselineRecordState>
}

interface MergeResult {
  finalRecords: Map<string, SyncRecord>
  finalTombstones: Map<string, SyncTombstone>
  recordsToApply: Map<string, SyncRecord>
  recordsToDelete: Map<string, SyncTombstone>
  conflicts: SyncConflict[]
  uploadedRecords: number
  downloadedRecords: number
  deletedRecords: number
}

interface PendingConflictState {
  runId: string
  provider: SyncProviderConfig
  mode: SyncRunMode
  remote: RemoteBundleState
  merge: MergeResult
  startedAt: number
}

interface NativeSyncFileSnapshotResult {
  success: boolean
  records: SyncRecord[]
  nextCursor?: string | null
  done?: boolean
  error?: string | null
}

interface NativeSyncFileMutationResult {
  success: boolean
  changed: number
  settingsChanged?: boolean
  error?: string | null
}

function emitSyncEvent(channel: string, payload: unknown): void {
  safeSendMessagePackToAllWindows(channel, payload)
}

function recordKey(domain: string, recordId: string): string {
  return `${domain}${KEY_SEPARATOR}${recordId}`
}

function splitRecordKey(key: string): { domain: string; recordId: string } {
  const index = key.indexOf(KEY_SEPARATOR)
  return {
    domain: key.slice(0, index),
    recordId: key.slice(index + KEY_SEPARATOR.length)
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

async function captureSyncFileSnapshot(): Promise<NativeSyncFileSnapshotResult> {
  console.log('[SyncFiles][Native] capture snapshot start')
  const records: SyncRecord[] = []
  let cursor: string | null = null
  let pages = 0
  do {
    const result = await getNativeWorker().request<NativeSyncFileSnapshotResult>(
      'sync/files-capture',
      { cursor, limit: 100 },
      SYNC_NATIVE_TIMEOUT_MS
    )
    if (!result.success) {
      throw new Error(result.error || 'Native sync file snapshot failed')
    }
    records.push(...result.records)
    pages += 1
    if (result.done === true) break
    if (!result.nextCursor) {
      throw new Error('Native sync file snapshot returned an incomplete page without a cursor')
    }
    cursor = result.nextCursor
  } while (pages < 10_000)

  if (pages >= 10_000) {
    throw new Error('Native sync file snapshot exceeded the page safety limit')
  }
  console.log('[SyncFiles][Native] capture snapshot done', {
    records: records.length,
    pages
  })
  return { success: true, records, done: true }
}

async function applySyncFileRecords(records: SyncRecord[]): Promise<void> {
  if (records.length === 0) return
  console.log('[SyncFiles][Native] apply files start', { records: records.length })
  let changed = 0
  let settingsChanged = false
  for (let offset = 0; offset < records.length; offset += 50) {
    const result = await getNativeWorker().request<NativeSyncFileMutationResult>(
      'sync/files-apply',
      { records: records.slice(offset, offset + 50) },
      SYNC_NATIVE_TIMEOUT_MS
    )
    if (!result.success) {
      throw new Error(result.error || 'Native sync file apply failed')
    }
    changed += result.changed
    settingsChanged ||= result.settingsChanged === true
  }
  if (settingsChanged) {
    await reloadSettingsCache()
  }
  console.log('[SyncFiles][Native] apply files done', { changed })
}

async function deleteSyncFileRecords(recordIds: string[]): Promise<void> {
  if (recordIds.length === 0) return
  console.log('[SyncFiles][Native] delete files start', { records: recordIds.length })
  let changed = 0
  let settingsChanged = false
  for (let offset = 0; offset < recordIds.length; offset += 200) {
    const result = await getNativeWorker().request<NativeSyncFileMutationResult>(
      'sync/files-delete',
      { recordIds: recordIds.slice(offset, offset + 200) },
      SYNC_NATIVE_TIMEOUT_MS
    )
    if (!result.success) {
      throw new Error(result.error || 'Native sync file delete failed')
    }
    changed += result.changed
    settingsChanged ||= result.settingsChanged === true
  }
  if (settingsChanged) {
    await reloadSettingsCache()
  }
  console.log('[SyncFiles][Native] delete files done', { changed })
}

async function captureLocalSnapshot(providerId: string, deviceId: string): Promise<LocalSnapshot> {
  await flushSettingsSync()
  const dbSnapshot = await captureSyncDbSnapshot(providerId)
  const fileSnapshot = await captureSyncFileSnapshot()
  const records = new Map<string, SyncRecord>()
  for (const record of dbSnapshot.records) {
    const syncRecord: SyncRecord = {
      ...record,
      hash: hashValue(record.value)
    }
    records.set(recordKey(syncRecord.domain, syncRecord.recordId), syncRecord)
  }
  for (const record of fileSnapshot.records) {
    records.set(recordKey(record.domain, record.recordId), record)
  }

  const baseline = new Map(
    dbSnapshot.baseline.map((row) => [
      recordKey(row.domain, row.recordId),
      {
        domain: row.domain,
        recordId: row.recordId,
        contentHash: row.contentHash
      }
    ])
  )
  const tombstones = new Map(
    dbSnapshot.tombstones.map((row) => [recordKey(row.domain, row.recordId), row])
  )
  const now = Date.now()
  for (const [key, state] of baseline) {
    if (records.has(key) || tombstones.has(key)) continue
    tombstones.set(key, {
      domain: state.domain,
      recordId: state.recordId,
      deletedAt: now,
      originDeviceId: deviceId
    })
  }

  return {
    records,
    tombstones,
    baseline
  }
}

function bundleToRecordMap(bundle: SyncBundle | null): Map<string, SyncRecord> {
  const map = new Map<string, SyncRecord>()
  for (const record of bundle?.records ?? []) {
    map.set(recordKey(record.domain, record.recordId), record)
  }
  return map
}

function bundleToTombstoneMap(bundle: SyncBundle | null): Map<string, SyncTombstone> {
  const map = new Map<string, SyncTombstone>()
  for (const tombstone of bundle?.tombstones ?? []) {
    map.set(recordKey(tombstone.domain, tombstone.recordId), tombstone)
  }
  return map
}

function chooseNewestTombstone(
  left: SyncTombstone | undefined,
  right: SyncTombstone | undefined
): SyncTombstone | undefined {
  if (!left) return right
  if (!right) return left
  return right.deletedAt > left.deletedAt ? right : left
}

function buildConflict(
  kind: SyncConflict['kind'],
  key: string,
  local: SyncRecord | undefined,
  remote: SyncRecord | undefined,
  baselineHash: string | undefined,
  localDeleted: boolean,
  remoteDeleted: boolean
): SyncConflict {
  const { domain, recordId } = splitRecordKey(key)
  return {
    id: createHash('sha256').update(`${kind}:${key}`).digest('hex'),
    kind,
    domain,
    recordId,
    localHash: local?.hash ?? null,
    remoteHash: remote?.hash ?? null,
    baselineHash: baselineHash ?? null,
    localValue: local?.value,
    remoteValue: remote?.value,
    localDeleted,
    remoteDeleted
  }
}

function mergeThreeWay(local: LocalSnapshot, remoteBundle: SyncBundle | null): MergeResult {
  const remoteRecords = bundleToRecordMap(remoteBundle)
  const remoteTombstones = bundleToTombstoneMap(remoteBundle)
  const finalRecords = new Map(local.records)
  const finalTombstones = new Map(local.tombstones)
  const recordsToApply = new Map<string, SyncRecord>()
  const recordsToDelete = new Map<string, SyncTombstone>()
  const conflicts: SyncConflict[] = []
  let downloadedRecords = 0
  let deletedRecords = 0

  for (const [key, remoteTombstone] of remoteTombstones) {
    finalTombstones.set(key, chooseNewestTombstone(finalTombstones.get(key), remoteTombstone)!)
  }

  const keys = new Set([
    ...local.baseline.keys(),
    ...local.records.keys(),
    ...remoteRecords.keys(),
    ...local.tombstones.keys(),
    ...remoteTombstones.keys()
  ])

  for (const key of keys) {
    const localRecord = local.records.get(key)
    const remoteRecord = remoteRecords.get(key)
    const baselineHash = local.baseline.get(key)?.contentHash
    const localTombstone = local.tombstones.get(key)
    const remoteTombstone = remoteTombstones.get(key)
    const localDeleted = Boolean(localTombstone || (baselineHash && !localRecord))
    const remoteDeleted = Boolean(remoteTombstone && !remoteRecord)

    if (localRecord && remoteRecord) {
      if (localRecord.hash === remoteRecord.hash) {
        finalRecords.set(key, localRecord)
        finalTombstones.delete(key)
      } else if (baselineHash === localRecord.hash) {
        finalRecords.set(key, remoteRecord)
        finalTombstones.delete(key)
        recordsToApply.set(key, remoteRecord)
        downloadedRecords += 1
      } else if (baselineHash === remoteRecord.hash) {
        finalRecords.set(key, localRecord)
        finalTombstones.delete(key)
      } else {
        conflicts.push(
          buildConflict('modify-modify', key, localRecord, remoteRecord, baselineHash, false, false)
        )
      }
      continue
    }

    if (localRecord && !remoteRecord) {
      if (remoteDeleted) {
        if (baselineHash && localRecord.hash !== baselineHash) {
          conflicts.push(
            buildConflict('delete-modify', key, localRecord, undefined, baselineHash, false, true)
          )
        } else {
          finalRecords.delete(key)
          finalTombstones.set(key, remoteTombstone!)
          recordsToDelete.set(key, remoteTombstone!)
          deletedRecords += 1
        }
      } else {
        finalRecords.set(key, localRecord)
        finalTombstones.delete(key)
      }
      continue
    }

    if (!localRecord && remoteRecord) {
      if (localDeleted) {
        if (baselineHash && remoteRecord.hash !== baselineHash) {
          conflicts.push(
            buildConflict('delete-modify', key, undefined, remoteRecord, baselineHash, true, false)
          )
        } else {
          finalRecords.delete(key)
          finalTombstones.set(key, localTombstone!)
        }
      } else {
        finalRecords.set(key, remoteRecord)
        finalTombstones.delete(key)
        recordsToApply.set(key, remoteRecord)
        downloadedRecords += 1
      }
      continue
    }

    if (!localRecord && !remoteRecord) {
      const tombstone = chooseNewestTombstone(localTombstone, remoteTombstone)
      if (tombstone) {
        finalRecords.delete(key)
        finalTombstones.set(key, tombstone)
      }
    }
  }

  for (const key of finalRecords.keys()) {
    finalTombstones.delete(key)
  }

  return {
    finalRecords,
    finalTombstones,
    recordsToApply,
    recordsToDelete,
    conflicts,
    uploadedRecords: 0,
    downloadedRecords,
    deletedRecords
  }
}

function mergePush(local: LocalSnapshot): MergeResult {
  const finalRecords = new Map(local.records)
  const finalTombstones = new Map(local.tombstones)
  for (const key of finalRecords.keys()) {
    finalTombstones.delete(key)
  }
  return {
    finalRecords,
    finalTombstones,
    recordsToApply: new Map(),
    recordsToDelete: new Map(),
    conflicts: [],
    uploadedRecords: finalRecords.size,
    downloadedRecords: 0,
    deletedRecords: 0
  }
}

function mergePull(local: LocalSnapshot, remoteBundle: SyncBundle | null): MergeResult {
  const remoteRecords = bundleToRecordMap(remoteBundle)
  const remoteTombstones = bundleToTombstoneMap(remoteBundle)
  const recordsToApply = new Map<string, SyncRecord>()
  const recordsToDelete = new Map<string, SyncTombstone>()
  const now = Date.now()

  for (const [key, record] of remoteRecords) {
    if (local.records.get(key)?.hash !== record.hash) {
      recordsToApply.set(key, record)
    }
  }

  for (const key of local.records.keys()) {
    if (remoteRecords.has(key)) continue
    const tombstone =
      remoteTombstones.get(key) ??
      ({
        ...splitRecordKey(key),
        deletedAt: now,
        originDeviceId: remoteBundle?.manifest.deviceId ?? 'remote'
      } satisfies SyncTombstone)
    recordsToDelete.set(key, tombstone)
    remoteTombstones.set(key, tombstone)
  }

  return {
    finalRecords: remoteRecords,
    finalTombstones: remoteTombstones,
    recordsToApply,
    recordsToDelete,
    conflicts: [],
    uploadedRecords: 0,
    downloadedRecords: recordsToApply.size,
    deletedRecords: recordsToDelete.size
  }
}

async function applyMergeToLocal(merge: MergeResult): Promise<void> {
  const recordsToApply = [...merge.recordsToApply.values()].filter((record) =>
    record.domain.startsWith('db:')
  )
  const recordsToDelete = [...merge.recordsToDelete.values()]
    .filter((tombstone) => tombstone.domain.startsWith('db:'))
    .map((tombstone) => ({
      domain: tombstone.domain,
      recordId: tombstone.recordId
    }))

  await applySyncDbMerge({
    recordsToApply,
    recordsToDelete
  })

  await deleteSyncFileRecords(
    [...merge.recordsToDelete.values()]
      .filter((tombstone) => tombstone.domain === FILE_DOMAIN)
      .map((tombstone) => tombstone.recordId)
  )
  await applySyncFileRecords(
    [...merge.recordsToApply.values()].filter((record) => record.domain === FILE_DOMAIN)
  )
}

function buildBundle(
  deviceId: string,
  records: Map<string, SyncRecord>,
  tombstones: Map<string, SyncTombstone>
): SyncBundle {
  const sortedRecords = [...records.values()].sort((left, right) =>
    recordKey(left.domain, left.recordId).localeCompare(recordKey(right.domain, right.recordId))
  )
  const sortedTombstones = [...tombstones.values()].sort((left, right) =>
    recordKey(left.domain, left.recordId).localeCompare(recordKey(right.domain, right.recordId))
  )
  const domains: Record<string, number> = {}
  for (const record of sortedRecords) {
    domains[record.domain] = (domains[record.domain] ?? 0) + 1
  }
  const manifestBase: Omit<SyncBundleManifest, 'contentHash'> = {
    schemaVersion: SYNC_SCHEMA_VERSION,
    appVersion: app.getVersion(),
    deviceId,
    createdAt: Date.now(),
    domains,
    tombstones: sortedTombstones.length
  }
  const contentHash = hashValue({
    manifest: manifestBase,
    records: sortedRecords,
    tombstones: sortedTombstones
  })
  return {
    manifest: {
      ...manifestBase,
      contentHash
    },
    records: sortedRecords,
    tombstones: sortedTombstones
  }
}

function resolveConflicts(
  merge: MergeResult,
  resolutions: SyncConflictResolution[],
  originDeviceId: string
): void {
  const resolutionsById = new Map(
    resolutions.map((resolution) => [resolution.conflictId, resolution.choice])
  )
  for (const conflict of merge.conflicts) {
    const choice = resolutionsById.get(conflict.id)
    if (!choice) throw new Error(`Missing resolution for conflict ${conflict.id}`)
    const key = recordKey(conflict.domain, conflict.recordId)

    if (choice === 'local') {
      if (conflict.localDeleted) {
        merge.finalRecords.delete(key)
        merge.finalTombstones.set(key, {
          domain: conflict.domain,
          recordId: conflict.recordId,
          deletedAt: Date.now(),
          originDeviceId
        })
      }
      continue
    }

    if (conflict.remoteDeleted) {
      merge.finalRecords.delete(key)
      merge.finalTombstones.set(key, {
        domain: conflict.domain,
        recordId: conflict.recordId,
        deletedAt: Date.now(),
        originDeviceId: 'remote'
      })
      merge.recordsToDelete.set(key, merge.finalTombstones.get(key)!)
      merge.deletedRecords += 1
      continue
    }

    const remoteRecord = isPlainRecord(conflict.remoteValue)
      ? ({
          domain: conflict.domain,
          recordId: conflict.recordId,
          hash: conflict.remoteHash ?? hashValue(conflict.remoteValue),
          value: conflict.remoteValue
        } satisfies SyncRecord)
      : undefined
    if (!remoteRecord) throw new Error(`Remote conflict value is missing for ${conflict.id}`)
    merge.finalRecords.set(key, remoteRecord)
    merge.finalTombstones.delete(key)
    merge.recordsToApply.set(key, remoteRecord)
    merge.downloadedRecords += 1
  }
  merge.conflicts = []
}

export class SyncEngine {
  private readonly webdavProvider = new WebDavProvider()
  private pendingConflict: PendingConflictState | null = null
  private running = false
  private status: SyncRunStatus = 'idle'

  getProviderDescriptors(): SyncProviderDescriptor[] {
    return [
      {
        type: 'webdav',
        displayName: 'WebDAV',
        description: 'Sync OpenCowork data through any WebDAV-compatible storage.'
      }
    ]
  }

  async getStatus(): Promise<SyncStatus> {
    const config = await readSyncConfig()
    return {
      status: this.status,
      running: this.running,
      deviceId: config.deviceId,
      activeProviderId: config.activeProviderId,
      lastRun: config.lastRun ?? null,
      pendingConflicts: this.pendingConflict?.merge.conflicts ?? []
    }
  }

  async testConnection(
    provider?: SyncProviderConfig
  ): Promise<{ success: boolean; error?: string }> {
    const target = provider ?? (await getActiveSyncProvider())
    if (target.type !== 'webdav') return { success: false, error: 'Unsupported sync provider' }
    return this.webdavProvider.testConnection(target.webdav)
  }

  async run(mode: SyncRunMode): Promise<SyncRunSummary> {
    if (this.running) throw new Error('A sync run is already in progress')
    this.running = true
    this.status = 'running'
    this.pendingConflict = null
    const startedAt = Date.now()
    const runId = randomUUID()
    const provider = await getActiveSyncProvider()
    console.log('[SyncEngine] run start', { runId, mode, providerId: provider.id })
    emitSyncEvent('sync:status-changed', await this.getStatus())
    emitSyncEvent('sync:run-progress', { runId, phase: 'started', mode })

    try {
      if (!provider.enabled) throw new Error('Sync provider is disabled')
      if (provider.type !== 'webdav') throw new Error('Unsupported sync provider')

      const config = await readSyncConfig()
      const local = await captureLocalSnapshot(provider.id, config.deviceId)
      console.log('[SyncEngine] local snapshot ready', {
        runId,
        records: local.records.size,
        tombstones: local.tombstones.size,
        baseline: local.baseline.size
      })
      emitSyncEvent('sync:run-progress', { runId, phase: 'download' })
      const remote = await this.webdavProvider.download(provider.webdav)
      const merge =
        mode === 'push'
          ? mergePush(local)
          : mode === 'pull'
            ? mergePull(local, remote.bundle)
            : mergeThreeWay(local, remote.bundle)
      console.log('[SyncEngine] merge planned', {
        runId,
        apply: merge.recordsToApply.size,
        delete: merge.recordsToDelete.size,
        conflicts: merge.conflicts.length
      })

      if (merge.conflicts.length > 0) {
        return await this.recordConflictRun({
          runId,
          provider,
          mode,
          remote,
          merge,
          startedAt
        })
      }

      try {
        return await this.finishMergedRun({
          runId,
          provider,
          mode,
          remote,
          merge,
          startedAt
        })
      } catch (error) {
        if (error instanceof RemoteStateChangedError && mode !== 'pull') {
          return await this.retryAfterRemoteChange({
            runId,
            provider,
            mode,
            startedAt
          })
        }
        throw error
      }
    } catch (error) {
      const summary: SyncRunSummary = {
        id: runId,
        providerId: provider.id,
        mode,
        status: 'error',
        startedAt,
        finishedAt: Date.now(),
        uploadedRecords: 0,
        downloadedRecords: 0,
        deletedRecords: 0,
        conflicts: 0,
        error: error instanceof Error ? error.message : String(error)
      }
      this.status = 'error'
      console.warn('[SyncEngine] run failed', { runId, error: summary.error })
      await patchSyncConfig({ lastRun: summary })
      emitSyncEvent('sync:run-finished', summary)
      return summary
    } finally {
      this.running = false
      emitSyncEvent('sync:status-changed', await this.getStatus())
    }
  }

  async resolveConflicts(resolutions: SyncConflictResolution[]): Promise<SyncRunSummary> {
    if (!this.pendingConflict) throw new Error('No pending sync conflicts')
    if (this.running) throw new Error('A sync run is already in progress')

    this.running = true
    this.status = 'running'
    emitSyncEvent('sync:status-changed', await this.getStatus())

    try {
      resolveConflicts(this.pendingConflict.merge, resolutions, (await readSyncConfig()).deviceId)
      const summary = await this.finishMergedRun(this.pendingConflict)
      this.pendingConflict = null
      return summary
    } catch (error) {
      const pending = this.pendingConflict
      if (!pending) {
        throw error
      }
      const summary: SyncRunSummary = {
        id: pending.runId,
        providerId: pending.provider.id,
        mode: pending.mode,
        status: 'error',
        startedAt: pending.startedAt,
        finishedAt: Date.now(),
        uploadedRecords: 0,
        downloadedRecords: 0,
        deletedRecords: 0,
        conflicts: pending.merge.conflicts.length,
        error: error instanceof Error ? error.message : String(error)
      }
      this.status = 'error'
      await patchSyncConfig({ lastRun: summary })
      emitSyncEvent('sync:run-finished', summary)
      return summary
    } finally {
      this.running = false
      emitSyncEvent('sync:status-changed', await this.getStatus())
    }
  }

  private async recordConflictRun(args: {
    runId: string
    provider: SyncProviderConfig
    mode: SyncRunMode
    remote: RemoteBundleState
    merge: MergeResult
    startedAt: number
  }): Promise<SyncRunSummary> {
    const summary = this.buildSummary({
      runId: args.runId,
      providerId: args.provider.id,
      mode: args.mode,
      status: 'conflict',
      startedAt: args.startedAt,
      merge: args.merge,
      remote: args.remote
    })
    this.pendingConflict = {
      runId: args.runId,
      provider: args.provider,
      mode: args.mode,
      remote: args.remote,
      merge: args.merge,
      startedAt: args.startedAt
    }
    this.status = 'conflict'
    await patchSyncConfig({ lastRun: summary })
    emitSyncEvent('sync:conflict-found', args.merge.conflicts)
    emitSyncEvent('sync:run-finished', summary)
    return summary
  }

  private async retryAfterRemoteChange(args: {
    runId: string
    provider: SyncProviderConfig
    mode: SyncRunMode
    startedAt: number
  }): Promise<SyncRunSummary> {
    const config = await readSyncConfig()
    emitSyncEvent('sync:run-progress', {
      runId: args.runId,
      phase: 'remote-changed'
    })
    const local = await captureLocalSnapshot(args.provider.id, config.deviceId)
    console.log('[SyncEngine] retry local snapshot ready', {
      runId: args.runId,
      records: local.records.size,
      tombstones: local.tombstones.size,
      baseline: local.baseline.size
    })
    const remote = await this.webdavProvider.download(args.provider.webdav)
    const merge = args.mode === 'push' ? mergePush(local) : mergeThreeWay(local, remote.bundle)

    if (merge.conflicts.length > 0) {
      return await this.recordConflictRun({
        runId: args.runId,
        provider: args.provider,
        mode: args.mode,
        remote,
        merge,
        startedAt: args.startedAt
      })
    }

    return await this.finishMergedRun({
      runId: args.runId,
      provider: args.provider,
      mode: args.mode,
      remote,
      merge,
      startedAt: args.startedAt
    })
  }

  private async finishMergedRun(args: {
    runId: string
    provider: SyncProviderConfig
    mode: SyncRunMode
    remote: RemoteBundleState
    merge: MergeResult
    startedAt: number
  }): Promise<SyncRunSummary> {
    emitSyncEvent('sync:run-progress', { runId: args.runId, phase: 'apply-local' })
    await applyMergeToLocal(args.merge)

    const config = await readSyncConfig()
    const bundle = buildBundle(config.deviceId, args.merge.finalRecords, args.merge.finalTombstones)
    let uploadedRemote = args.remote
    if (args.mode !== 'pull') {
      emitSyncEvent('sync:run-progress', { runId: args.runId, phase: 'upload' })
      uploadedRemote = await this.webdavProvider.upload(args.provider.webdav, bundle, {
        previousExists: Boolean(args.remote.bundle),
        previousEtag: args.remote.etag,
        previousLastModified: args.remote.lastModified
      })
      args.merge.uploadedRecords =
        bundle.records.length + bundle.tombstones.length - (args.remote.bundle?.records.length ?? 0)
    }

    const metadataBundle = args.mode === 'pull' && args.remote.bundle ? args.remote.bundle : bundle
    await saveSyncDbMetadata(args.provider.id, metadataBundle.records, metadataBundle.tombstones)

    const summary = this.buildSummary({
      runId: args.runId,
      providerId: args.provider.id,
      mode: args.mode,
      status: 'success',
      startedAt: args.startedAt,
      merge: args.merge,
      remote: uploadedRemote
    })
    this.status = 'success'
    console.log('[SyncEngine] run success', {
      runId: args.runId,
      uploaded: summary.uploadedRecords,
      downloaded: summary.downloadedRecords,
      deleted: summary.deletedRecords
    })
    await patchSyncConfig({ lastRun: summary })
    emitSyncEvent('sync:run-finished', summary)
    return summary
  }

  private buildSummary(args: {
    runId: string
    providerId: string
    mode: SyncRunMode
    status: SyncRunStatus
    startedAt: number
    merge: MergeResult
    remote: RemoteBundleState
  }): SyncRunSummary {
    return {
      id: args.runId,
      providerId: args.providerId,
      mode: args.mode,
      status: args.status,
      startedAt: args.startedAt,
      finishedAt: Date.now(),
      uploadedRecords: Math.max(0, args.merge.uploadedRecords),
      downloadedRecords: args.merge.downloadedRecords,
      deletedRecords: args.merge.deletedRecords,
      conflicts: args.merge.conflicts.length,
      remoteUpdatedAt: args.remote.updatedAt,
      error: null
    }
  }
}

export const syncEngine = new SyncEngine()

export function updateSyncConfig(
  config: Parameters<typeof writeSyncConfig>[0]
): ReturnType<typeof writeSyncConfig> {
  return writeSyncConfig(config)
}
