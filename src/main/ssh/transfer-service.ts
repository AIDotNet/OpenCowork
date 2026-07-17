import * as fs from 'fs'
import * as path from 'path'
import type { SFTPWrapper } from 'ssh2'
import { safeSendMessagePackToAllWindows } from '../window-ipc'
import { withSshSftp } from './connection-manager'
import {
  resolveRemotePath,
  resolveRemotePathForWrite,
  sftpLstat,
  sftpMkdirRecursive,
  sftpReaddir,
  statType
} from './sftp-service'

// Bulk transfer tasks (upload / download / remote-copy) streamed over the
// shared ssh2 connections. Event channels and payload shapes match the
// former native-worker implementation so the renderer stays unchanged.

export type SshConflictPolicy = 'skip' | 'overwrite' | 'duplicate'
type TransferTaskType = 'upload' | 'download' | 'remote-copy'
type TransferStage = 'preparing' | 'transferring' | 'cleanup' | 'done' | 'error' | 'canceled'
type UploadStage = 'upload' | 'cleanup' | 'done' | 'error' | 'canceled'

const PROGRESS_INTERVAL_MS = 150
const STREAM_HIGH_WATER_MARK = 256 * 1024

interface TaskState {
  taskId: string
  canceled: boolean
  activeStreams: Set<{ destroy: () => void }>
}

const uploadTasks = new Map<string, TaskState>()
const transferTasks = new Map<string, TaskState>()

class TransferCanceledError extends Error {
  constructor() {
    super('Transfer canceled')
  }
}

function broadcastUploadEvent(evt: {
  taskId: string
  connectionId: string
  stage: UploadStage
  progress?: { current?: number; total?: number; percent?: number }
  message?: string
}): void {
  safeSendMessagePackToAllWindows('ssh:fs:upload:events', evt)
}

function broadcastTransferEvent(evt: {
  taskId: string
  type: TransferTaskType
  stage: TransferStage
  sourceConnectionId?: string | null
  targetConnectionId?: string | null
  progress?: {
    currentBytes?: number
    totalBytes?: number
    percent?: number
    processedItems?: number
    totalItems?: number
  }
  message?: string
  currentItem?: string
  conflictPolicy?: SshConflictPolicy
}): void {
  safeSendMessagePackToAllWindows('ssh:fs:transfer:events', evt)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function newTask(registry: Map<string, TaskState>, taskId: string): TaskState {
  const task: TaskState = { taskId, canceled: false, activeStreams: new Set() }
  registry.set(taskId, task)
  return task
}

function cancelTask(task: TaskState): void {
  task.canceled = true
  for (const stream of task.activeStreams) {
    try {
      stream.destroy()
    } catch {
      // ignore
    }
  }
}

function throwIfCanceled(task: TaskState): void {
  if (task.canceled) throw new TransferCanceledError()
}

// ── Tree scanning ──

interface FileItem {
  // Absolute source path (local fs path or resolved remote path).
  sourcePath: string
  // Path relative to the transfer root, POSIX-style, including the top-level
  // item name (used to build the destination path and progress labels).
  relPath: string
  size: number
}

async function scanLocalTree(rootPath: string): Promise<{ files: FileItem[]; dirs: string[] }> {
  const files: FileItem[] = []
  const dirs: string[] = []
  const rootName = path.basename(rootPath)
  const stat = await fs.promises.stat(rootPath)
  if (!stat.isDirectory()) {
    files.push({ sourcePath: rootPath, relPath: rootName, size: stat.size })
    return { files, dirs }
  }
  dirs.push(rootName)
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      const relChild = `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        dirs.push(relChild)
        await walk(abs, relChild)
      } else if (entry.isFile()) {
        const fileStat = await fs.promises.stat(abs)
        files.push({ sourcePath: abs, relPath: relChild, size: fileStat.size })
      }
    }
  }
  await walk(rootPath, rootName)
  return { files, dirs }
}

async function scanRemoteTree(
  sftp: SFTPWrapper,
  rootPath: string
): Promise<{ files: FileItem[]; dirs: string[] }> {
  const files: FileItem[] = []
  const dirs: string[] = []
  const resolved = await resolveRemotePath(sftp, rootPath)
  const rootName = path.posix.basename(resolved)
  const rootStat = await sftpLstat(sftp, resolved)
  if (!rootStat) throw new Error(`Remote path not found: ${rootPath}`)
  if (statType(rootStat) !== 'directory') {
    files.push({ sourcePath: resolved, relPath: rootName, size: rootStat.size ?? 0 })
    return { files, dirs }
  }
  dirs.push(rootName)
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await sftpReaddir(sftp, dir)
    for (const entry of entries) {
      const abs = path.posix.join(dir, entry.filename)
      const relChild = `${rel}/${entry.filename}`
      const type = statType(entry.attrs)
      if (type === 'directory') {
        dirs.push(relChild)
        await walk(abs, relChild)
      } else if (type === 'file') {
        files.push({ sourcePath: abs, relPath: relChild, size: entry.attrs.size ?? 0 })
      }
    }
  }
  await walk(resolved, rootName)
  return { files, dirs }
}

// ── Conflict handling (top-level item granularity) ──

async function resolveTopLevelName(
  baseName: string,
  policy: SshConflictPolicy,
  exists: (name: string) => Promise<boolean>
): Promise<string | null> {
  if (!(await exists(baseName))) return baseName
  if (policy === 'overwrite') return baseName
  if (policy === 'skip') return null
  const ext = path.posix.extname(baseName)
  const stem = ext ? baseName.slice(0, -ext.length) : baseName
  for (let index = 2; ; index += 1) {
    const candidate = `${stem} (${index})${ext}`
    if (!(await exists(candidate))) return candidate
  }
}

function renameTopLevel(relPath: string, newTopLevel: string): string {
  const slash = relPath.indexOf('/')
  return slash === -1 ? newTopLevel : `${newTopLevel}${relPath.slice(slash)}`
}

// ── Streaming copies ──

type ProgressSink = (deltaBytes: number) => void

function pipeStreams(
  task: TaskState,
  source: NodeJS.ReadableStream & { destroy?: (err?: Error) => void },
  target: NodeJS.WritableStream & { destroy?: (err?: Error) => void },
  onBytes: ProgressSink
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const handles = {
      destroy: (): void => {
        source.destroy?.()
        target.destroy?.()
      }
    }
    task.activeStreams.add(handles)
    let settled = false
    const finish = (err?: unknown): void => {
      if (settled) return
      settled = true
      task.activeStreams.delete(handles)
      if (err) reject(err)
      else resolve()
    }
    source.on('data', (chunk: Buffer) => onBytes(chunk.length))
    source.on('error', (err) => finish(err))
    target.on('error', (err) => finish(err))
    target.on('close', () => finish(task.canceled ? new TransferCanceledError() : undefined))
    source.pipe(target)
  })
}

function uploadFile(
  task: TaskState,
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string,
  onBytes: ProgressSink
): Promise<void> {
  const source = fs.createReadStream(localPath, { highWaterMark: STREAM_HIGH_WATER_MARK })
  const target = sftp.createWriteStream(remotePath)
  return pipeStreams(task, source, target, onBytes)
}

function downloadFile(
  task: TaskState,
  sftp: SFTPWrapper,
  remotePath: string,
  localPath: string,
  onBytes: ProgressSink
): Promise<void> {
  const source = sftp.createReadStream(remotePath, { highWaterMark: STREAM_HIGH_WATER_MARK })
  const target = fs.createWriteStream(localPath)
  return pipeStreams(task, source, target, onBytes)
}

function copyRemoteFile(
  task: TaskState,
  sourceSftp: SFTPWrapper,
  targetSftp: SFTPWrapper,
  sourcePath: string,
  targetPath: string,
  onBytes: ProgressSink
): Promise<void> {
  const source = sourceSftp.createReadStream(sourcePath, {
    highWaterMark: STREAM_HIGH_WATER_MARK
  })
  const target = targetSftp.createWriteStream(targetPath)
  return pipeStreams(task, source, target, onBytes)
}

// ── Progress reporting ──

interface TransferTotals {
  totalBytes: number
  totalItems: number
  currentBytes: number
  processedItems: number
}

function makeTransferProgressReporter(
  task: TaskState,
  base: {
    type: TransferTaskType
    sourceConnectionId?: string | null
    targetConnectionId?: string | null
    conflictPolicy: SshConflictPolicy
  },
  totals: TransferTotals
): { onBytes: ProgressSink; itemDone: (item: string) => void; flush: (item?: string) => void } {
  let lastEmit = 0
  const emit = (item?: string, force = false): void => {
    const now = Date.now()
    if (!force && now - lastEmit < PROGRESS_INTERVAL_MS) return
    lastEmit = now
    broadcastTransferEvent({
      taskId: task.taskId,
      type: base.type,
      stage: 'transferring',
      sourceConnectionId: base.sourceConnectionId ?? null,
      targetConnectionId: base.targetConnectionId ?? null,
      conflictPolicy: base.conflictPolicy,
      currentItem: item,
      progress: {
        currentBytes: totals.currentBytes,
        totalBytes: totals.totalBytes,
        percent: totals.totalBytes
          ? Math.min(100, Math.round((totals.currentBytes / totals.totalBytes) * 100))
          : undefined,
        processedItems: totals.processedItems,
        totalItems: totals.totalItems
      }
    })
  }
  let currentItem: string | undefined
  return {
    onBytes: (delta) => {
      totals.currentBytes += delta
      emit(currentItem)
    },
    itemDone: (item) => {
      totals.processedItems += 1
      currentItem = item
      emit(item, true)
    },
    flush: (item) => emit(item ?? currentItem, true)
  }
}

// ── Task bodies ──

async function runTransferUpload(
  task: TaskState,
  args: { connectionId: string; remoteDir: string; localPaths: string[] },
  conflictPolicy: SshConflictPolicy
): Promise<void> {
  await withSshSftp(args.connectionId, async (sftp) => {
    const remoteDir = await resolveRemotePathForWrite(sftp, args.remoteDir)
    const scans: Array<{ files: FileItem[]; dirs: string[] }> = []
    for (const localPath of args.localPaths) {
      throwIfCanceled(task)
      scans.push(await scanLocalTree(localPath))
    }

    const totals: TransferTotals = {
      totalBytes: scans.flatMap((scan) => scan.files).reduce((sum, file) => sum + file.size, 0),
      totalItems: scans.reduce((sum, scan) => sum + scan.files.length, 0),
      currentBytes: 0,
      processedItems: 0
    }
    const reporter = makeTransferProgressReporter(
      task,
      { type: 'upload', targetConnectionId: args.connectionId, conflictPolicy },
      totals
    )

    for (const scan of scans) {
      throwIfCanceled(task)
      const topLevel = (scan.dirs[0] ?? scan.files[0]?.relPath)?.split('/')[0]
      if (!topLevel) continue
      const finalTop = await resolveTopLevelName(topLevel, conflictPolicy, async (name) => {
        return (await sftpLstat(sftp, path.posix.join(remoteDir, name))) !== null
      })
      if (finalTop === null) {
        totals.totalBytes -= scan.files.reduce((sum, file) => sum + file.size, 0)
        totals.totalItems -= scan.files.length
        continue
      }
      for (const dir of scan.dirs) {
        throwIfCanceled(task)
        await sftpMkdirRecursive(sftp, path.posix.join(remoteDir, renameTopLevel(dir, finalTop)))
      }
      for (const file of scan.files) {
        throwIfCanceled(task)
        const destination = path.posix.join(remoteDir, renameTopLevel(file.relPath, finalTop))
        await sftpMkdirRecursive(sftp, path.posix.dirname(destination))
        await uploadFile(task, sftp, file.sourcePath, destination, reporter.onBytes)
        reporter.itemDone(file.relPath)
      }
    }
    reporter.flush()
  })
}

async function runTransferDownload(
  task: TaskState,
  args: { connectionId: string; remotePaths: string[]; localDir: string },
  conflictPolicy: SshConflictPolicy
): Promise<void> {
  await withSshSftp(args.connectionId, async (sftp) => {
    const scans: Array<{ files: FileItem[]; dirs: string[] }> = []
    for (const remotePath of args.remotePaths) {
      throwIfCanceled(task)
      scans.push(await scanRemoteTree(sftp, remotePath))
    }

    const totals: TransferTotals = {
      totalBytes: scans.flatMap((scan) => scan.files).reduce((sum, file) => sum + file.size, 0),
      totalItems: scans.reduce((sum, scan) => sum + scan.files.length, 0),
      currentBytes: 0,
      processedItems: 0
    }
    const reporter = makeTransferProgressReporter(
      task,
      { type: 'download', sourceConnectionId: args.connectionId, conflictPolicy },
      totals
    )

    for (const scan of scans) {
      throwIfCanceled(task)
      const topLevel = (scan.dirs[0] ?? scan.files[0]?.relPath)?.split('/')[0]
      if (!topLevel) continue
      const finalTop = await resolveTopLevelName(topLevel, conflictPolicy, async (name) => {
        try {
          await fs.promises.access(path.join(args.localDir, name))
          return true
        } catch {
          return false
        }
      })
      if (finalTop === null) {
        totals.totalBytes -= scan.files.reduce((sum, file) => sum + file.size, 0)
        totals.totalItems -= scan.files.length
        continue
      }
      for (const dir of scan.dirs) {
        throwIfCanceled(task)
        await fs.promises.mkdir(path.join(args.localDir, renameTopLevel(dir, finalTop)), {
          recursive: true
        })
      }
      for (const file of scan.files) {
        throwIfCanceled(task)
        const destination = path.join(args.localDir, renameTopLevel(file.relPath, finalTop))
        await fs.promises.mkdir(path.dirname(destination), { recursive: true })
        await downloadFile(task, sftp, file.sourcePath, destination, reporter.onBytes)
        reporter.itemDone(file.relPath)
      }
    }
    reporter.flush()
  })
}

async function runTransferRemoteCopy(
  task: TaskState,
  args: {
    sourceConnectionId: string
    targetConnectionId: string
    sourcePaths: string[]
    targetDir: string
  },
  conflictPolicy: SshConflictPolicy
): Promise<void> {
  await withSshSftp(args.sourceConnectionId, async (sourceSftp) => {
    await withSshSftp(args.targetConnectionId, async (targetSftp) => {
      const targetDir = await resolveRemotePathForWrite(targetSftp, args.targetDir)
      const scans: Array<{ files: FileItem[]; dirs: string[] }> = []
      for (const sourcePath of args.sourcePaths) {
        throwIfCanceled(task)
        scans.push(await scanRemoteTree(sourceSftp, sourcePath))
      }

      const totals: TransferTotals = {
        totalBytes: scans.flatMap((scan) => scan.files).reduce((sum, file) => sum + file.size, 0),
        totalItems: scans.reduce((sum, scan) => sum + scan.files.length, 0),
        currentBytes: 0,
        processedItems: 0
      }
      const reporter = makeTransferProgressReporter(
        task,
        {
          type: 'remote-copy',
          sourceConnectionId: args.sourceConnectionId,
          targetConnectionId: args.targetConnectionId,
          conflictPolicy
        },
        totals
      )

      for (const scan of scans) {
        throwIfCanceled(task)
        const topLevel = (scan.dirs[0] ?? scan.files[0]?.relPath)?.split('/')[0]
        if (!topLevel) continue
        const finalTop = await resolveTopLevelName(topLevel, conflictPolicy, async (name) => {
          return (await sftpLstat(targetSftp, path.posix.join(targetDir, name))) !== null
        })
        if (finalTop === null) {
          totals.totalBytes -= scan.files.reduce((sum, file) => sum + file.size, 0)
          totals.totalItems -= scan.files.length
          continue
        }
        for (const dir of scan.dirs) {
          throwIfCanceled(task)
          await sftpMkdirRecursive(
            targetSftp,
            path.posix.join(targetDir, renameTopLevel(dir, finalTop))
          )
        }
        for (const file of scan.files) {
          throwIfCanceled(task)
          const destination = path.posix.join(targetDir, renameTopLevel(file.relPath, finalTop))
          await sftpMkdirRecursive(targetSftp, path.posix.dirname(destination))
          await copyRemoteFile(
            task,
            sourceSftp,
            targetSftp,
            file.sourcePath,
            destination,
            reporter.onBytes
          )
          reporter.itemDone(file.relPath)
        }
      }
      reporter.flush()
    })
  })
}

// ── Public API: transfer tasks (ssh:fs:transfer:*) ──

export type TransferStartArgs =
  | {
      type: 'upload'
      connectionId: string
      remoteDir: string
      localPaths: string[]
      conflictPolicy?: SshConflictPolicy
    }
  | {
      type: 'download'
      connectionId: string
      remotePaths: string[]
      localDir: string
      conflictPolicy?: SshConflictPolicy
    }
  | {
      type: 'remote-copy'
      sourceConnectionId: string
      targetConnectionId: string
      sourcePaths: string[]
      targetDir: string
      conflictPolicy?: SshConflictPolicy
    }

export function startTransferTask(args: TransferStartArgs): { taskId: string } | { error: string } {
  const taskId = `ssh-transfer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const conflictPolicy = args.conflictPolicy ?? 'skip'
  const sourceConnectionId =
    args.type === 'remote-copy' ? args.sourceConnectionId : args.connectionId
  const targetConnectionId =
    args.type === 'upload'
      ? args.connectionId
      : args.type === 'remote-copy'
        ? args.targetConnectionId
        : null

  if (args.type === 'upload' && (!Array.isArray(args.localPaths) || !args.localPaths.length)) {
    return { error: 'No local paths selected for upload' }
  }
  if (args.type === 'download' && (!Array.isArray(args.remotePaths) || !args.remotePaths.length)) {
    return { error: 'No remote paths selected for download' }
  }
  if (
    args.type === 'remote-copy' &&
    (!Array.isArray(args.sourcePaths) || !args.sourcePaths.length)
  ) {
    return { error: 'No remote paths selected for copy' }
  }

  const task = newTask(transferTasks, taskId)
  broadcastTransferEvent({
    taskId,
    type: args.type,
    stage: 'preparing',
    sourceConnectionId,
    targetConnectionId,
    conflictPolicy
  })

  void (async () => {
    try {
      if (args.type === 'upload') {
        await runTransferUpload(task, args, conflictPolicy)
      } else if (args.type === 'download') {
        await runTransferDownload(task, args, conflictPolicy)
      } else {
        await runTransferRemoteCopy(task, args, conflictPolicy)
      }
      throwIfCanceled(task)
      broadcastTransferEvent({
        taskId,
        type: args.type,
        stage: 'done',
        sourceConnectionId,
        targetConnectionId,
        conflictPolicy,
        message: 'Transfer complete'
      })
    } catch (err) {
      const canceled = task.canceled || err instanceof TransferCanceledError
      broadcastTransferEvent({
        taskId,
        type: args.type,
        stage: canceled ? 'canceled' : 'error',
        sourceConnectionId,
        targetConnectionId,
        conflictPolicy,
        message: canceled ? 'Transfer canceled' : errorMessage(err)
      })
    } finally {
      transferTasks.delete(taskId)
    }
  })()

  return { taskId }
}

export function cancelTransferTask(taskId: string): { success: true } | { error: string } {
  const task = transferTasks.get(taskId)
  if (!task) return { error: 'Task not found' }
  cancelTask(task)
  return { success: true }
}

// ── Public API: legacy single-item upload (ssh:fs:upload:*) ──

export async function startUploadTask(args: {
  connectionId: string
  remoteDir: string
  localPath: string
  kind?: 'file' | 'folder'
}): Promise<{ taskId: string } | { error: string }> {
  const taskId = `ssh-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  try {
    await fs.promises.stat(args.localPath)
  } catch (err) {
    return { error: errorMessage(err) }
  }

  const task = newTask(uploadTasks, taskId)
  void (async () => {
    try {
      broadcastUploadEvent({
        taskId,
        connectionId: args.connectionId,
        stage: 'upload',
        message: 'Preparing upload...'
      })
      await withSshSftp(args.connectionId, async (sftp) => {
        const remoteDir = await resolveRemotePathForWrite(sftp, args.remoteDir)
        const scan = await scanLocalTree(args.localPath)
        const totalBytes = scan.files.reduce((sum, file) => sum + file.size, 0)
        let currentBytes = 0
        let lastEmit = 0
        const onBytes: ProgressSink = (delta) => {
          currentBytes += delta
          const now = Date.now()
          if (now - lastEmit < PROGRESS_INTERVAL_MS) return
          lastEmit = now
          broadcastUploadEvent({
            taskId,
            connectionId: args.connectionId,
            stage: 'upload',
            progress: {
              current: currentBytes,
              total: totalBytes,
              percent: totalBytes ? Math.round((currentBytes / totalBytes) * 100) : undefined
            },
            message: 'Uploading...'
          })
        }
        for (const dir of scan.dirs) {
          throwIfCanceled(task)
          await sftpMkdirRecursive(sftp, path.posix.join(remoteDir, dir))
        }
        for (const file of scan.files) {
          throwIfCanceled(task)
          const destination = path.posix.join(remoteDir, file.relPath)
          await sftpMkdirRecursive(sftp, path.posix.dirname(destination))
          await uploadFile(task, sftp, file.sourcePath, destination, onBytes)
        }
        broadcastUploadEvent({
          taskId,
          connectionId: args.connectionId,
          stage: 'done',
          progress: { current: totalBytes, total: totalBytes, percent: 100 },
          message: 'Upload complete'
        })
      })
    } catch (err) {
      const canceled = task.canceled || err instanceof TransferCanceledError
      broadcastUploadEvent({
        taskId,
        connectionId: args.connectionId,
        stage: canceled ? 'canceled' : 'error',
        message: canceled ? 'Canceled' : errorMessage(err)
      })
    } finally {
      uploadTasks.delete(taskId)
    }
  })()

  return { taskId }
}

export function cancelUploadTask(taskId: string): { success: true } | { error: string } {
  const task = uploadTasks.get(taskId)
  if (!task) return { error: 'Task not found' }
  cancelTask(task)
  return { success: true }
}
