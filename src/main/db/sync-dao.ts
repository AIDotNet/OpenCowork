import type { SyncRecord, SyncTombstone } from '../../shared/sync-types'
import { getNativeWorker } from '../lib/native-worker'

export interface DbSyncRecordDraft {
  domain: string
  recordId: string
  value: unknown
  updatedAt?: number | null
}

export interface DbSyncBaselineRecordState {
  domain: string
  recordId: string
  contentHash: string
}

interface DbSyncSnapshotResult {
  success: boolean
  records: DbSyncRecordDraft[]
  baseline: DbSyncBaselineRecordState[]
  tombstones: SyncTombstone[]
  nextCursor?: string | null
  done?: boolean
  error?: string | null
}

interface DbSyncTableOrderResult {
  success: boolean
  tables: string[]
  error?: string | null
}

interface DbSyncMutationResult {
  success: boolean
  changed: number
  error?: string | null
}

export interface DbSyncSnapshot {
  records: DbSyncRecordDraft[]
  baseline: DbSyncBaselineRecordState[]
  tombstones: SyncTombstone[]
}

function assertMutation(result: DbSyncMutationResult, operation: string): DbSyncMutationResult {
  if (!result.success) {
    throw new Error(result.error || `Native sync DB ${operation} failed`)
  }
  return result
}

export async function captureSyncDbSnapshot(providerId: string): Promise<DbSyncSnapshot> {
  console.log('[SyncDb][Native] capture snapshot start')
  const records: DbSyncRecordDraft[] = []
  const baseline: DbSyncBaselineRecordState[] = []
  const tombstones: SyncTombstone[] = []
  let cursor: string | null = null
  let pages = 0

  do {
    const result = await getNativeWorker().request<DbSyncSnapshotResult>(
      'db/sync-capture-local',
      { providerId, cursor, limit: 500 },
      120_000
    )
    if (!result.success) {
      throw new Error(result.error || 'Native sync DB snapshot failed')
    }

    records.push(...result.records)
    baseline.push(...result.baseline)
    tombstones.push(...result.tombstones)
    pages += 1
    if (result.done === true) break
    if (!result.nextCursor) {
      throw new Error('Native sync DB snapshot returned an incomplete page without a cursor')
    }
    cursor = result.nextCursor
  } while (pages < 100_000)

  if (pages >= 100_000) {
    throw new Error('Native sync DB snapshot exceeded the page safety limit')
  }

  console.log('[SyncDb][Native] capture snapshot done', {
    records: records.length,
    baseline: baseline.length,
    tombstones: tombstones.length,
    pages
  })
  return {
    records,
    baseline,
    tombstones
  }
}

export async function applySyncDbMerge(args: {
  recordsToApply: SyncRecord[]
  recordsToDelete: Array<Pick<SyncTombstone, 'domain' | 'recordId'>>
}): Promise<void> {
  if (args.recordsToApply.length === 0 && args.recordsToDelete.length === 0) return
  console.log('[SyncDb][Native] apply DB merge start', {
    apply: args.recordsToApply.length,
    delete: args.recordsToDelete.length
  })
  const orderResult = await getNativeWorker().request<DbSyncTableOrderResult>(
    'db/sync-table-order',
    {},
    120_000
  )
  if (!orderResult.success) {
    throw new Error(orderResult.error || 'Native sync DB table order failed')
  }

  const tableFromDomain = (domain: string): string | null =>
    domain.startsWith('db:') ? domain.slice('db:'.length) : null
  const applyByTable = new Map<string, SyncRecord[]>()
  const deleteByTable = new Map<string, Array<Pick<SyncTombstone, 'domain' | 'recordId'>>>()
  for (const record of args.recordsToApply) {
    const table = tableFromDomain(record.domain)
    if (!table) continue
    const items = applyByTable.get(table) ?? []
    items.push(record)
    applyByTable.set(table, items)
  }
  for (const tombstone of args.recordsToDelete) {
    const table = tableFromDomain(tombstone.domain)
    if (!table) continue
    const items = deleteByTable.get(table) ?? []
    items.push(tombstone)
    deleteByTable.set(table, items)
  }

  let changed = 0
  const requestBatch = async (
    recordsToApply: SyncRecord[],
    recordsToDelete: Array<Pick<SyncTombstone, 'domain' | 'recordId'>>
  ): Promise<void> => {
    const result = await getNativeWorker().request<DbSyncMutationResult>(
      'db/sync-apply-db-merge',
      { recordsToApply, recordsToDelete },
      120_000
    )
    changed += assertMutation(result, 'apply merge').changed
  }

  for (const table of [...orderResult.tables].reverse()) {
    const records = deleteByTable.get(table) ?? []
    for (let offset = 0; offset < records.length; offset += 250) {
      await requestBatch([], records.slice(offset, offset + 250))
    }
  }
  for (const table of orderResult.tables) {
    const records = applyByTable.get(table) ?? []
    for (let offset = 0; offset < records.length; offset += 250) {
      await requestBatch(records.slice(offset, offset + 250), [])
    }
  }

  console.log('[SyncDb][Native] apply DB merge done', { changed })
}

export async function saveSyncDbMetadata(
  providerId: string,
  records: Array<Pick<SyncRecord, 'domain' | 'recordId' | 'hash'>>,
  tombstones: SyncTombstone[]
): Promise<void> {
  console.log('[SyncDb][Native] save metadata start', {
    records: records.length,
    tombstones: tombstones.length
  })
  const batches: Array<{
    records: Array<Pick<SyncRecord, 'domain' | 'recordId' | 'hash'>>
    tombstones: SyncTombstone[]
  }> = []
  for (let offset = 0; offset < records.length; offset += 500) {
    batches.push({ records: records.slice(offset, offset + 500), tombstones: [] })
  }
  for (let offset = 0; offset < tombstones.length; offset += 500) {
    batches.push({ records: [], tombstones: tombstones.slice(offset, offset + 500) })
  }
  if (batches.length === 0) batches.push({ records: [], tombstones: [] })

  let changed = 0
  for (let index = 0; index < batches.length; index += 1) {
    const result = await getNativeWorker().request<DbSyncMutationResult>(
      'db/sync-save-metadata',
      { providerId, ...batches[index], reset: index === 0 },
      120_000
    )
    changed += assertMutation(result, 'save metadata').changed
  }
  console.log('[SyncDb][Native] save metadata done', { changed, batches: batches.length })
}
