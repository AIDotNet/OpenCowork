import * as React from 'react'
import { IPC } from '@renderer/lib/ipc/channels'
import { invokeMessagePackBinary } from '@renderer/lib/ipc/messagepack-ipc-client'
import { toMessagePackChannel } from '../../../../shared/messagepack/binary-ipc'
import {
  canRenderInlineSnapshot,
  computeDiff,
  snapshotText,
  summarizeDiff,
  summarizeTrackedChange,
  type AggregatedFileChange
} from './file-change-utils'

export interface LoadedChangeContent {
  beforeText: string
  afterText: string
}

export interface DiffSummaryStats {
  added: number
  deleted: number
}

interface ErrorResult {
  error: string
}

interface LoadedSummaryEntry {
  token: string
  summary: DiffSummaryStats
}

const aggregatedChangeContentCache = new Map<
  string,
  Promise<LoadedChangeContent | ErrorResult | null>
>()

export function isLoadedChangeContent(value: unknown): value is LoadedChangeContent {
  return (
    !!value &&
    typeof value === 'object' &&
    'beforeText' in value &&
    'afterText' in value &&
    typeof value.beforeText === 'string' &&
    typeof value.afterText === 'string'
  )
}

function isErrorResult(value: unknown): value is ErrorResult {
  return !!value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
}

async function loadSnapshotSidesViaIpc(
  change: AggregatedFileChange
): Promise<LoadedChangeContent | ErrorResult | null> {
  const firstSourceChange = change.sourceChanges[0]
  const lastSourceChange = change.sourceChanges[change.sourceChanges.length - 1]
  const sourceChange = lastSourceChange ?? firstSourceChange
  if (!sourceChange) return null

  const result = await invokeMessagePackBinary(
    toMessagePackChannel(IPC.AGENT_CHANGES_DIFF_CONTENT),
    {
      runId: sourceChange.runId,
      changeId: sourceChange.id
    }
  )

  if (isErrorResult(result)) return result
  if (
    result &&
    typeof result === 'object' &&
    'beforeText' in result &&
    'afterText' in result &&
    typeof result.beforeText === 'string' &&
    typeof result.afterText === 'string'
  ) {
    return {
      beforeText: result.beforeText,
      afterText: result.afterText
    }
  }
  return null
}

function aggregatedChangeCacheKey(change: AggregatedFileChange): string {
  return [
    change.id,
    change.op,
    change.before.hash ?? 'before:null',
    String(change.before.lineCount ?? ''),
    String(change.before.size),
    change.after.hash ?? 'after:null',
    String(change.after.lineCount ?? ''),
    String(change.after.size),
    change.firstChangeId,
    change.lastChangeId
  ].join('\u0000')
}

function shouldLoadAccurateSummary(change: AggregatedFileChange): boolean {
  if (change.op !== 'modify') return false
  return !canRenderInlineSnapshot(change.before) || !canRenderInlineSnapshot(change.after)
}

function summaryToken(change: AggregatedFileChange): string {
  return `${aggregatedChangeCacheKey(change)}\u0000${shouldLoadAccurateSummary(change) ? 'load' : 'sync'}`
}

export async function loadAggregatedChangeContent(
  change: AggregatedFileChange
): Promise<LoadedChangeContent | ErrorResult | null> {
  const cacheKey = aggregatedChangeCacheKey(change)
  const cached = aggregatedChangeContentCache.get(cacheKey)
  if (cached) {
    return await cached
  }

  const request = (async (): Promise<LoadedChangeContent | ErrorResult | null> => {
    const firstSourceChange = change.sourceChanges[0]
    const lastSourceChange = change.sourceChanges[change.sourceChanges.length - 1]
    if (!firstSourceChange || !lastSourceChange) return null

    const beforeInline = !firstSourceChange.before.exists
      ? ''
      : canRenderInlineSnapshot(firstSourceChange.before)
        ? snapshotText(firstSourceChange.before)
        : null
    const afterInline = canRenderInlineSnapshot(lastSourceChange.after)
      ? snapshotText(lastSourceChange.after)
      : null

    if (beforeInline !== null && afterInline !== null) {
      return { beforeText: beforeInline, afterText: afterInline }
    }

    const fetched = await loadSnapshotSidesViaIpc(change)
    if (!fetched) return null
    if (isErrorResult(fetched)) return fetched
    return {
      beforeText: beforeInline ?? fetched.beforeText,
      afterText: afterInline ?? fetched.afterText
    }
  })()

  aggregatedChangeContentCache.set(cacheKey, request)
  return await request
}

export function useAggregatedChangeSummaries(
  changes: AggregatedFileChange[]
): Record<string, DiffSummaryStats> {
  const fallbackSummaries = React.useMemo(
    () =>
      Object.fromEntries(
        changes.map((change) => [change.id, summarizeTrackedChange(change)])
      ) as Record<string, DiffSummaryStats>,
    [changes]
  )
  const descriptors = React.useMemo(
    () =>
      changes.map((change) => ({
        change,
        id: change.id,
        token: summaryToken(change),
        shouldLoad: shouldLoadAccurateSummary(change)
      })),
    [changes]
  )
  const [loadedSummaries, setLoadedSummaries] = React.useState<Record<string, LoadedSummaryEntry>>(
    {}
  )

  React.useEffect(() => {
    let cancelled = false
    const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]))

    setLoadedSummaries((current) => {
      let changed = false
      const next: Record<string, LoadedSummaryEntry> = {}

      for (const [id, entry] of Object.entries(current)) {
        const descriptor = descriptorById.get(id)
        if (descriptor && descriptor.token === entry.token) {
          next[id] = entry
          continue
        }
        changed = true
      }

      return changed ? next : current
    })

    const pending = descriptors.filter((descriptor) => {
      if (!descriptor.shouldLoad) return false
      const loaded = loadedSummaries[descriptor.id]
      return !loaded || loaded.token !== descriptor.token
    })

    if (pending.length === 0) {
      return () => {
        cancelled = true
      }
    }

    void (async () => {
      const results = await Promise.all(
        pending.map(async (descriptor) => {
          const content = await loadAggregatedChangeContent(descriptor.change)
          if (!isLoadedChangeContent(content)) return null

          return {
            id: descriptor.id,
            token: descriptor.token,
            summary: summarizeDiff(computeDiff(content.beforeText, content.afterText))
          }
        })
      )

      if (cancelled) return

      setLoadedSummaries((current) => {
        let changed = false
        const next = { ...current }

        for (const result of results) {
          if (!result) continue
          const existing = next[result.id]
          if (
            existing &&
            existing.token === result.token &&
            existing.summary.added === result.summary.added &&
            existing.summary.deleted === result.summary.deleted
          ) {
            continue
          }

          next[result.id] = {
            token: result.token,
            summary: result.summary
          }
          changed = true
        }

        return changed ? next : current
      })
    })()

    return () => {
      cancelled = true
    }
  }, [descriptors, loadedSummaries])

  return React.useMemo(() => {
    const summaries: Record<string, DiffSummaryStats> = {}

    for (const descriptor of descriptors) {
      const loaded = loadedSummaries[descriptor.id]
      summaries[descriptor.id] =
        loaded && loaded.token === descriptor.token
          ? loaded.summary
          : fallbackSummaries[descriptor.id]
    }

    return summaries
  }, [descriptors, fallbackSummaries, loadedSummaries])
}
