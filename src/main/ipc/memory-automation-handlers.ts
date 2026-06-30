import { ipcMain } from 'electron'
import * as memoryAutomationDao from '../db/memory-automation-dao'
import * as memoryPipelineDao from '../db/memory-pipeline-dao'
import type {
  MemoryCitationEntry,
  MemoryAutomationListQuery,
  MemoryAutomationRecordInput,
  MemoryAutomationRunRollupArgs,
  MemoryAutomationUndoArgs,
  MemoryPipelineClearRootArgs,
  MemoryPipelineListJobsQuery,
  MemoryPipelineListRootsQuery,
  MemoryPipelineRunArgs,
  MemoryRootInput,
  MemoryStage1OutputInput
} from '../../shared/memory-automation-types'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'

function registerMemoryMessagePackHandler<TArgs>(
  channel: string,
  handler: (args: TArgs) => Promise<unknown> | unknown
): void {
  ipcMain.handle(toMessagePackChannel(channel), async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<TArgs>(bytes)
    return encodeMessagePackPayload(await handler(args))
  })
}

function normalizeListQuery(value: unknown): MemoryAutomationListQuery {
  if (!value || typeof value !== 'object') return {}
  return value as MemoryAutomationListQuery
}

function asObject<T>(value: unknown): T {
  return (value && typeof value === 'object' ? value : {}) as T
}

function normalizeRoots(value: unknown): MemoryRootInput[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is MemoryRootInput => {
    if (!item || typeof item !== 'object') return false
    const record = item as Partial<MemoryRootInput>
    return (
      (record.scope === 'global' || record.scope === 'project') &&
      typeof record.rootPath === 'string' &&
      record.rootPath.trim().length > 0
    )
  })
}

function normalizeStage1Outputs(value: unknown): MemoryStage1OutputInput[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is MemoryStage1OutputInput => {
    if (!item || typeof item !== 'object') return false
    const record = item as Partial<MemoryStage1OutputInput>
    return (
      typeof record.memoryRootId === 'string' &&
      (record.scope === 'global' || record.scope === 'project') &&
      typeof record.sourceSessionId === 'string' &&
      typeof record.rawMemory === 'string' &&
      typeof record.rolloutSummary === 'string' &&
      typeof record.rolloutSlug === 'string' &&
      typeof record.fingerprint === 'string'
    )
  })
}

export function registerMemoryAutomationHandlers(): void {
  registerMemoryMessagePackHandler<unknown>('memory-automation:list', async (query) => {
    return {
      entries: await memoryAutomationDao.listMemoryAutomationEntries(normalizeListQuery(query))
    }
  })

  registerMemoryMessagePackHandler<MemoryAutomationRecordInput>(
    'memory-automation:record',
    async (input) => {
      try {
        const entry = await memoryAutomationDao.addMemoryAutomationEntry(input)
        return { success: true, entry }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )

  registerMemoryMessagePackHandler<MemoryAutomationUndoArgs>('memory-automation:undo', async (args) => {
    try {
      const entry = await memoryAutomationDao.markMemoryAutomationUndo(
        args.id,
        args.status ?? 'undone',
        args.error
      )
      if (!entry) {
        return { success: false, error: 'Memory automation entry not found' }
      }
      return { success: true, entry }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  registerMemoryMessagePackHandler<{ sessionId?: string } | undefined>(
    'memory-automation:run-session',
    () => {
      return {
        success: true,
        queued: false
      }
    }
  )

  registerMemoryMessagePackHandler<MemoryAutomationRunRollupArgs>(
    'memory-automation:run-rollup',
    async (args) => {
      try {
        if (args.action === 'get-watermark') {
          if (!args.scope || !args.targetPath || !args.sourceDate || !args.contentHash) {
            return { success: false, error: 'Missing rollup watermark fields' }
          }
          return {
            success: true,
            alreadyProcessed: await memoryAutomationDao.hasProcessedRollup({
              scope: args.scope,
              targetPath: args.targetPath,
              sourceDate: args.sourceDate,
              contentHash: args.contentHash
            })
          }
        }

        if (args.action === 'mark-watermark') {
          if (!args.scope || !args.targetPath || !args.sourceDate || !args.contentHash) {
            return { success: false, error: 'Missing rollup watermark fields' }
          }
          await memoryAutomationDao.markProcessedRollup({
            scope: args.scope,
            target: 'project_memory',
            targetPath: args.targetPath,
            sourceDate: args.sourceDate,
            contentHash: args.contentHash
          })
          return { success: true, alreadyProcessed: true }
        }

        return { success: true, queued: false }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )

  registerMemoryMessagePackHandler<unknown>('memory-pipeline:run', async (rawArgs) => {
    const args = asObject<MemoryPipelineRunArgs>(rawArgs)
    try {
      if (args.action === 'prepare-session') {
        const roots = await Promise.all(
          normalizeRoots(args.roots).map((root) => memoryPipelineDao.ensureMemoryRoot(root))
        )
        const job = await memoryPipelineDao.createMemoryJob({
          kind: 'stage1',
          status: 'running',
          sourceSessionId: args.sessionId ?? null,
          leaseOwner: args.leaseOwner ?? 'renderer'
        })
        return { success: true, roots, job }
      }

      if (args.action === 'ensure-roots') {
        const roots = await Promise.all(
          normalizeRoots(args.roots).map((root) => memoryPipelineDao.ensureMemoryRoot(root))
        )
        return { success: true, roots }
      }

      if (args.action === 'complete-stage1') {
        const stage1Outputs = await Promise.all(
          normalizeStage1Outputs(args.stage1Outputs).map((output) =>
            memoryPipelineDao.addStage1Output(output)
          )
        )
        let job = args.jobId
          ? await memoryPipelineDao.finishMemoryJob({
              id: args.jobId,
              status:
                args.status ?? (stage1Outputs.length > 0 ? 'succeeded' : 'succeeded_no_output'),
              error: args.error
            })
          : undefined
        if (!job && args.sessionId) {
          job = await memoryPipelineDao.createMemoryJob({
            kind: 'stage1',
            status: stage1Outputs.length > 0 ? 'succeeded' : 'succeeded_no_output',
            sourceSessionId: args.sessionId
          })
        }
        return { success: true, stage1Outputs, job }
      }

      if (args.action === 'list-stage1-outputs') {
        if (!args.memoryRootId) {
          return { success: false, error: 'memoryRootId is required' }
        }
        return {
          success: true,
          stage1Outputs: await memoryPipelineDao.listStage1Outputs({
            memoryRootId: args.memoryRootId,
            limit: args.limit
          })
        }
      }

      if (args.action === 'complete-phase2') {
        const rootId = args.memoryRootId ?? null
        const job =
          args.jobId && (await memoryPipelineDao.getMemoryJob(args.jobId))
            ? await memoryPipelineDao.finishMemoryJob({
                id: args.jobId,
                status: args.status ?? (args.error ? 'failed' : 'succeeded'),
                error: args.error
              })
            : await memoryPipelineDao.createMemoryJob({
                kind: 'phase2',
                status: args.status ?? (args.error ? 'failed' : 'succeeded'),
                memoryRootId: rootId,
                sourceSessionId: args.sessionId ?? null
              })
        if (args.error && job) {
          await memoryPipelineDao.finishMemoryJob({
            id: job.id,
            status: 'failed',
            error: args.error
          })
        }
        return { success: true, job: job ?? undefined }
      }

      if (args.action === 'record-job') {
        const job = await memoryPipelineDao.createMemoryJob({
          kind: args.jobKind ?? 'phase2',
          status: args.status ?? 'running',
          memoryRootId: args.memoryRootId ?? null,
          sourceSessionId: args.sessionId ?? null,
          leaseOwner: args.leaseOwner ?? 'renderer'
        })
        return { success: true, job }
      }

      return { success: false, error: 'Unsupported memory pipeline action' }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  registerMemoryMessagePackHandler<unknown>('memory-pipeline:list-roots', async (rawQuery) => {
    try {
      return {
        roots: await memoryPipelineDao.listMemoryRoots(
          asObject<MemoryPipelineListRootsQuery>(rawQuery)
        )
      }
    } catch (error) {
      return {
        roots: [],
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  registerMemoryMessagePackHandler<unknown>('memory-pipeline:list-jobs', async (rawQuery) => {
    try {
      return {
        jobs: await memoryPipelineDao.listMemoryJobs(
          asObject<MemoryPipelineListJobsQuery>(rawQuery)
        )
      }
    } catch (error) {
      return {
        jobs: [],
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  registerMemoryMessagePackHandler<unknown>('memory-pipeline:clear-root', async (rawArgs) => {
    const args = asObject<MemoryPipelineClearRootArgs>(rawArgs)
    try {
      if (!args.memoryRootId) {
        return { success: false, error: 'memoryRootId is required' }
      }
      return {
        success: true,
        ...(await memoryPipelineDao.clearMemoryRoot(args))
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  registerMemoryMessagePackHandler<unknown>('memory:record-citation-usage', async (rawEntry) => {
    const entry = asObject<MemoryCitationEntry>(rawEntry)
    try {
      if (
        !entry.memoryRootId ||
        (entry.scope !== 'global' && entry.scope !== 'project') ||
        !entry.path
      ) {
        return { success: false, error: 'Invalid memory citation usage payload' }
      }
      await memoryPipelineDao.recordCitationUsage(entry)
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })
}
