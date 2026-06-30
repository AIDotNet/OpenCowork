import { getNativeWorker } from '../lib/native-worker'
import type {
  MemoryCitationEntry,
  MemoryJobKind,
  MemoryJobStatus,
  MemoryPipelineJob,
  MemoryPipelineListJobsQuery,
  MemoryPipelineListRootsQuery,
  MemoryRootDescriptor,
  MemoryRootInput,
  MemoryStage1Output,
  MemoryStage1OutputInput
} from '../../shared/memory-automation-types'

interface NativeFindRootResult {
  success: boolean
  root?: MemoryRootDescriptor | null
  error?: string | null
}

interface NativeFindJobResult {
  success: boolean
  job?: MemoryPipelineJob | null
  error?: string | null
}

interface NativeClearRootResult {
  success: boolean
  deletedStage1Outputs: number
  deletedJobs: number
  error?: string | null
}

interface NativeMutationResult {
  success: boolean
  changed: number
  error?: string | null
}

function assertNativeObject<T extends { id?: string }>(value: T, label: string): T {
  if (value && typeof value.id === 'string' && value.id.length > 0) {
    return value
  }
  const error =
    value && typeof (value as { error?: unknown }).error === 'string'
      ? String((value as { error?: unknown }).error)
      : `${label} returned an invalid result`
  throw new Error(error)
}

function assertMutation(result: NativeMutationResult, label: string): void {
  if (!result.success) {
    throw new Error(result.error || label)
  }
}

export async function ensureMemoryRoot(input: MemoryRootInput): Promise<MemoryRootDescriptor> {
  const result = await getNativeWorker().request<MemoryRootDescriptor>(
    'db/memory-roots-ensure',
    input,
    120_000
  )
  return assertNativeObject(result, 'Native memory root ensure failed')
}

export async function getMemoryRoot(id: string): Promise<MemoryRootDescriptor | null> {
  const result = await getNativeWorker().request<NativeFindRootResult>(
    'db/memory-roots-get',
    { id },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native memory root get failed')
  }
  return result.root ?? null
}

export function listMemoryRoots(
  query: MemoryPipelineListRootsQuery = {}
): Promise<MemoryRootDescriptor[]> {
  return getNativeWorker().request<MemoryRootDescriptor[]>('db/memory-roots-list', query, 120_000)
}

export async function createMemoryJob(input: {
  kind: MemoryJobKind
  status?: MemoryJobStatus
  memoryRootId?: string | null
  sourceSessionId?: string | null
  leaseOwner?: string | null
}): Promise<MemoryPipelineJob> {
  const result = await getNativeWorker().request<MemoryPipelineJob>(
    'db/memory-jobs-create',
    input,
    120_000
  )
  return assertNativeObject(result, 'Native memory job create failed')
}

export async function getMemoryJob(id: string): Promise<MemoryPipelineJob | null> {
  const result = await getNativeWorker().request<NativeFindJobResult>(
    'db/memory-jobs-get',
    { id },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native memory job get failed')
  }
  return result.job ?? null
}

export async function finishMemoryJob(args: {
  id: string
  status: MemoryJobStatus
  error?: string | null
}): Promise<MemoryPipelineJob | null> {
  const result = await getNativeWorker().request<NativeFindJobResult>(
    'db/memory-jobs-finish',
    args,
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native memory job finish failed')
  }
  return result.job ?? null
}

export function listMemoryJobs(
  query: MemoryPipelineListJobsQuery = {}
): Promise<MemoryPipelineJob[]> {
  return getNativeWorker().request<MemoryPipelineJob[]>('db/memory-jobs-list', query, 120_000)
}

export async function addStage1Output(input: MemoryStage1OutputInput): Promise<MemoryStage1Output> {
  const result = await getNativeWorker().request<MemoryStage1Output>(
    'db/memory-stage1-add',
    input,
    120_000
  )
  return assertNativeObject(result, 'Native memory stage1 add failed')
}

export function listStage1Outputs(args: {
  memoryRootId: string
  limit?: number
}): Promise<MemoryStage1Output[]> {
  return getNativeWorker().request<MemoryStage1Output[]>('db/memory-stage1-list', args, 120_000)
}

export async function recordCitationUsage(entry: MemoryCitationEntry): Promise<void> {
  const result = await getNativeWorker().request<NativeMutationResult>(
    'db/memory-citation-record',
    entry,
    120_000
  )
  assertMutation(result, 'Native memory citation usage failed')
}

export async function clearMemoryRoot(args: {
  memoryRootId: string
  includeJobs?: boolean
}): Promise<{ deletedStage1Outputs: number; deletedJobs: number }> {
  const result = await getNativeWorker().request<NativeClearRootResult>(
    'db/memory-root-clear',
    args,
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native memory root clear failed')
  }
  return {
    deletedStage1Outputs: result.deletedStage1Outputs,
    deletedJobs: result.deletedJobs
  }
}
