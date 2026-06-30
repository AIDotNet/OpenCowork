import { getNativeWorker } from '../lib/native-worker'
import type {
  MemoryAutomationEntry,
  MemoryAutomationListQuery,
  MemoryAutomationRecordInput,
  MemoryAutomationTarget
} from '../../shared/memory-automation-types'

interface MemoryAutomationEntryResult {
  success: boolean
  entry?: MemoryAutomationEntry | null
  error?: string | null
}

interface MemoryAutomationRollupResult {
  success: boolean
  alreadyProcessed: boolean
  error?: string | null
}

function unwrapEntryResult(
  result: MemoryAutomationEntryResult,
  operation: string
): MemoryAutomationEntry | null {
  if (!result.success) {
    throw new Error(result.error || `Native memory automation ${operation} failed`)
  }
  return result.entry ?? null
}

export async function addMemoryAutomationEntry(
  input: MemoryAutomationRecordInput
): Promise<MemoryAutomationEntry> {
  const result = await getNativeWorker().request<MemoryAutomationEntryResult>(
    'db/memory-automation-add',
    input,
    120_000
  )
  const entry = unwrapEntryResult(result, 'add')
  if (!entry) {
    throw new Error('Native memory automation add returned no entry')
  }
  return entry
}

export async function getMemoryAutomationEntry(id: string): Promise<MemoryAutomationEntry | null> {
  const result = await getNativeWorker().request<MemoryAutomationEntryResult>(
    'db/memory-automation-get',
    { id },
    120_000
  )
  return unwrapEntryResult(result, 'get')
}

export function listMemoryAutomationEntries(
  query: MemoryAutomationListQuery = {}
): Promise<MemoryAutomationEntry[]> {
  return getNativeWorker().request<MemoryAutomationEntry[]>(
    'db/memory-automation-list',
    query,
    120_000
  )
}

export async function markMemoryAutomationUndo(
  id: string,
  status: 'undone' | 'error' = 'undone',
  error?: string | null
): Promise<MemoryAutomationEntry | null> {
  const result = await getNativeWorker().request<MemoryAutomationEntryResult>(
    'db/memory-automation-mark-undo',
    { id, status, error },
    120_000
  )
  return unwrapEntryResult(result, 'mark-undo')
}

export async function hasProcessedRollup(args: {
  scope: string
  targetPath: string
  sourceDate: string
  contentHash: string
}): Promise<boolean> {
  const result = await getNativeWorker().request<MemoryAutomationRollupResult>(
    'db/memory-automation-rollup-has',
    args,
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native memory automation rollup lookup failed')
  }
  return result.alreadyProcessed
}

export async function markProcessedRollup(args: {
  scope: string
  target: MemoryAutomationTarget
  targetPath: string
  sourceDate: string
  contentHash: string
}): Promise<void> {
  const result = await getNativeWorker().request<MemoryAutomationRollupResult>(
    'db/memory-automation-rollup-mark',
    args,
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native memory automation rollup mark failed')
  }
}
