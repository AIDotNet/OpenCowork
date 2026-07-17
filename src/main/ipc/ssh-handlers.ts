import { app, ipcMain } from 'electron'
import * as path from 'path'
import {
  initializeSshRepository,
  onSshRepositoryChange,
  listGroups as listSshGroups,
  createGroup,
  updateGroup,
  deleteGroup as deleteSshGroup,
  listConnections as listSshConnections,
  getConnectionWithSecrets as getSshConnection,
  createConnection,
  updateConnection as updateSshConnection,
  deleteConnection as deleteSshConnection,
  type SshGroup as SshConfigGroup,
  type SshConnectionMeta,
  type SshConnectionPatch,
  type SshConnectionWithSecrets as SshConfigConnection
} from '../ssh/repository'
import { execSshCommand, localSshFsRequest, LOCAL_SSH_FS_METHODS } from '../ssh/sftp-service'
import {
  startUploadTask,
  cancelUploadTask,
  startTransferTask,
  cancelTransferTask,
  type TransferStartArgs
} from '../ssh/transfer-service'
import {
  openSshTerminal,
  closeSshTerminal,
  writeSshTerminal,
  resizeSshTerminal,
  getSshTerminalBuffer,
  listSshTerminals,
  closeSshConnectionHandles,
  closeAllSshConnections
} from '../ssh/connection-manager'
import {
  applySshImport,
  exportSshConfig,
  previewSshImport,
  type SshImportAction,
  type SshImportSource
} from '../ssh/import-export'
import {
  buildFileSnapshot,
  buildOpaqueExistingSnapshot,
  recordSshTextWriteChange,
  registerSshChangeAdapter,
  type FileSnapshot
} from './agent-change-handlers'
import { safeSendMessagePackToAllWindows } from '../window-ipc'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'

// Terminal sessions live in the connection manager (src/main/ssh/
// connection-manager.ts); this file only registers the IPC surface.

const DEFAULT_TEXT_LINE_READ_LIMIT = 1_000
const TEXT_READ_BLOCKED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
  '.ico',
  '.tiff',
  '.heic',
  '.heif',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.zip',
  '.gz',
  '.tgz',
  '.rar',
  '.7z',
  '.tar'
])
let sshConfigWatcherAttached = false

type SshClientSession = {
  connectionId: string
}

export interface NativeSshExecResult {
  success: boolean
  exitCode: number
  stdout: string
  stderr: string
  error?: string | null
  timing?: {
    totalMs: number
    spawnMs: number
    timedOut: boolean
    engine: string
  }
}

interface NativeSshConnectionTestResult {
  success: boolean
  error?: string | null
}

interface NativeSshFileTransferResult {
  success: boolean
  error?: string | null
  path?: string | null
  bytes?: number | null
}

interface NativeSshFileMutationResult {
  success: boolean
  error?: string | null
  op?: 'create' | 'modify' | null
}

interface NativeSshFileHomeResult {
  success: boolean
  path?: string | null
  error?: string | null
}

interface NativeSshFilePathResult {
  success: boolean
  path?: string | null
  error?: string | null
}

interface NativeSshFileTextResult {
  success: boolean
  content?: string | null
  name?: string | null
  path?: string | null
  lineCount?: number | null
  maxLines?: number | null
  truncated?: boolean | null
  error?: string | null
}

interface NativeSshFileBinaryResult {
  success: boolean
  data?: string | null
  error?: string | null
}

interface NativeSshFileStatResult {
  success: boolean
  exists: boolean
  type?: 'file' | 'directory' | 'symlink' | 'other' | null
  size?: number | null
  mtimeMs?: number | null
  error?: string | null
}

interface NativeSshFileListResult {
  success: boolean
  entries?: SshFileListEntry[] | null
  hasMore?: boolean | null
  nextCursor?: string | null
  error?: string | null
}

type SshFileListEntry = {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink'
  size: number
  modifyTime: number
}

interface ReadTextFileLinesResult {
  content: string
  name: string
  path: string
  lineCount: number
  maxLines: number
  truncated: boolean
}

function clampTextLineReadLimit(maxLines?: number): number {
  if (typeof maxLines !== 'number' || !Number.isFinite(maxLines)) {
    return DEFAULT_TEXT_LINE_READ_LIMIT
  }
  return Math.max(1, Math.min(DEFAULT_TEXT_LINE_READ_LIMIT, Math.floor(maxLines)))
}

type SearchLimitReason = 'max_results' | 'max_output_bytes' | 'timeout' | 'max_depth' | null
type GrepMatchKind = 'match' | 'context'
type GrepOutputMode = 'matches' | 'files_with_matches' | 'files_without_matches' | 'count'
type SearchEngine = string

type SearchMeta = {
  backend: 'ssh'
  engine?: SearchEngine
  searchRoot: string
  pathStyle: 'absolute' | 'relative_to_search_root'
  truncated: boolean
  timedOut: boolean
  limitReason: SearchLimitReason
  pattern: string
  include?: string | null
  exclude?: string | null
  outputMode?: GrepOutputMode
  hiddenIncluded: boolean
  ignoredDefaultsApplied: boolean
  respectGitignore?: boolean
  followSymlinks?: boolean
  warnings?: string[]
  maxDepth?: number | null
  beforeContext?: number
  afterContext?: number
  maxResults?: number
}

type SshGlobResult = {
  kind: 'glob'
  matches: Array<{ path: string; type?: 'file' | 'directory' }>
  meta: SearchMeta
  error?: string
}

type SshGrepResult = {
  kind: 'grep'
  matches: Array<{
    path: string
    line?: number
    text?: string
    kind?: GrepMatchKind
    count?: number
  }>
  meta: SearchMeta
  error?: string
}

function logSshDebug(message: string, details: Record<string, unknown>): void {
  if (!isSshDebugEnabled()) return
  console.log(`[SSH] ${message}`, details)
}

function isSshDebugEnabled(): boolean {
  const raw = process.env.OPEN_COWORK_SSH_DEBUG ?? process.env.OPEN_COWORK_NATIVE_DEBUG
  if (raw !== undefined) {
    return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
  }
  return !app.isPackaged
}

function nowStamp(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    String(d.getFullYear()) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  )
}

async function checkRemoteCommandExists(session: SshClientSession, cmd: string): Promise<boolean> {
  const result = await sshExec(session, `command -v ${cmd} >/dev/null 2>&1`)
  return result.exitCode === 0
}

interface SshGroupRow {
  id: string
  name: string
  sort_order: number
  created_at: number
  updated_at: number
}

interface SshConnectionRow {
  id: string
  group_id: string | null
  name: string
  host: string
  port: number
  username: string
  auth_type: string
  private_key_path: string | null
  startup_command: string | null
  default_directory: string | null
  proxy_jump: string | null
  keep_alive_interval: number
  sort_order: number
  last_connected_at: number | null
  created_at: number
  updated_at: number
}

function ensureSshConfigWatcher(): void {
  if (sshConfigWatcherAttached) return
  sshConfigWatcherAttached = true
  onSshRepositoryChange(() => {
    safeSendMessagePackToAllWindows('ssh:config:changed', {})
  })
}

function toGroupRow(group: SshConfigGroup): SshGroupRow {
  return {
    id: group.id,
    name: group.name,
    sort_order: group.sortOrder,
    created_at: group.createdAt,
    updated_at: group.updatedAt
  }
}

function toConnectionRow(connection: SshConnectionMeta): SshConnectionRow {
  return {
    id: connection.id,
    group_id: connection.groupId,
    name: connection.name,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    auth_type: connection.authType,
    private_key_path: connection.privateKeyPath,
    startup_command: connection.startupCommand,
    default_directory: connection.defaultDirectory,
    proxy_jump: connection.proxyJump,
    keep_alive_interval: connection.keepAliveInterval,
    sort_order: connection.sortOrder,
    last_connected_at: connection.lastConnectedAt,
    created_at: connection.createdAt,
    updated_at: connection.updatedAt
  }
}

export async function execNativeSshCommand(
  connectionId: string,
  command: string,
  timeout = 60_000
): Promise<NativeSshExecResult> {
  return await execSshCommand(connectionId, command, timeout)
}

async function nativeSshFsRequest<T>(
  method: string,
  connectionId: string,
  params: Record<string, unknown> = {},
  _timeout = 60_000
): Promise<T> {
  if (!getSshConnection(connectionId)) {
    throw new Error('Connection not found')
  }
  if (!LOCAL_SSH_FS_METHODS.has(method)) {
    throw new Error(`Unsupported SSH fs method: ${method}`)
  }
  return (await localSshFsRequest(method, connectionId, params)) as T
}

async function resolveNativeSshPath(connectionId: string, inputPath: string): Promise<string> {
  const result = await nativeSshFsRequest<NativeSshFilePathResult>(
    'ssh/fs-resolve-path',
    connectionId,
    { path: inputPath },
    30_000
  )
  if (!result.success || !result.path) {
    throw new Error(result.error ?? 'Failed to resolve remote path')
  }
  logSshDebug('remote path resolved', {
    connectionId,
    inputPath,
    resolvedPath: result.path
  })
  return result.path
}

type SshOutputBufferArgs = { sessionId: string; sinceSeq?: number }
type SshReadFileArgs = {
  connectionId: string
  path: string
  offset?: number
  limit?: number
  raw?: boolean
}
type SshReadTextFileLinesArgs = { connectionId: string; path: string; maxLines?: number }
type SshWriteFileArgs = {
  connectionId: string
  path: string
  content: string
  beforeContent?: string
  changeMeta?: { runId?: string; sessionId?: string; toolUseId?: string; toolName?: string }
}
type SshReadFileBinaryArgs = { connectionId: string; path: string }
type SshWriteFileBinaryArgs = { connectionId: string; path: string; data: string }
type SshListDirArgs = {
  connectionId: string
  path: string
  cursor?: string
  limit?: number
  refresh?: boolean
}
type SshExecArgs = { connectionId: string; command: string; timeout?: number }
type SshGlobArgs = { connectionId: string; pattern: string; path?: string; limit?: number }
type SshGrepArgs = Record<string, unknown> & {
  connectionId: string
  pattern: string
  path?: string
}

function registerSshMessagePackHandler<TArgs>(
  channel: string,
  handler: (args: TArgs) => Promise<unknown>
): void {
  ipcMain.handle(toMessagePackChannel(channel), async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<TArgs>(bytes)
    return encodeMessagePackPayload(await handler(args))
  })
}

async function handleSshOutputBuffer(args: SshOutputBufferArgs): Promise<unknown> {
  return getSshTerminalBuffer(args.sessionId, args.sinceSeq ?? 0)
}

async function handleSshReadFile(args: SshReadFileArgs): Promise<unknown> {
  try {
    const result = await nativeSshFsRequest<NativeSshFileTextResult>(
      'ssh/fs-read-file',
      args.connectionId,
      { path: args.path }
    )
    if (!result.success) return { error: result.error ?? 'SSH read-file failed' }
    const content = result.content ?? ''

    // Default to raw; only format with line numbers when raw is explicitly false.
    if (args.raw !== false) {
      return content
    }

    const normalized = content.replace(/\r\n/g, '\n')
    const lines = normalized.split('\n')
    const start = Math.max(0, (args.offset ?? 1) - 1)
    const count = Math.max(0, Math.min(args.limit ?? 2000, 2000))
    const end = Math.min(start + count, lines.length)
    const lineNoWidth = Math.max(6, String(end).length)
    return lines
      .slice(start, end)
      .map((line, i) => `${String(start + i + 1).padStart(lineNoWidth)}\t${line}`)
      .join('\n')
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshReadTextFileLines(args: SshReadTextFileLinesArgs): Promise<unknown> {
  try {
    const maxLines = clampTextLineReadLimit(args.maxLines)
    if (TEXT_READ_BLOCKED_EXTENSIONS.has(path.extname(args.path).toLowerCase())) {
      return { error: 'This file type cannot be read as plain text' }
    }
    const result = await nativeSshFsRequest<NativeSshFileTextResult>(
      'ssh/fs-read-text-file-lines',
      args.connectionId,
      { path: args.path, maxLines }
    )
    if (!result.success) return { error: result.error ?? 'SSH read-text-file-lines failed' }
    return {
      content: result.content ?? '',
      name: result.name ?? path.basename(args.path),
      path: result.path ?? args.path,
      lineCount: result.lineCount ?? 0,
      maxLines: result.maxLines ?? maxLines,
      truncated: result.truncated === true
    } satisfies ReadTextFileLinesResult
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshStatPath(args: { connectionId: string; path: string }): Promise<unknown> {
  try {
    const result = await nativeSshFsRequest<NativeSshFileStatResult>(
      'ssh/fs-stat-path',
      args.connectionId,
      { path: args.path }
    )
    if (!result.success) return { error: result.error ?? 'SSH stat failed' }
    return {
      exists: result.exists,
      type: result.type ?? null,
      size: result.size ?? null,
      mtimeMs: result.mtimeMs ?? null
    }
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshWriteFile(args: SshWriteFileArgs): Promise<unknown> {
  try {
    const before = await readSshTextSnapshot(args.connectionId, args.path)
    if (
      typeof args.beforeContent === 'string' &&
      before.hash !== buildFileSnapshot(true, args.beforeContent).hash
    ) {
      throw new Error(
        'File changed since it was read. Read the file again before editing or writing.'
      )
    }
    const result = await nativeSshFsRequest<NativeSshFileMutationResult>(
      'ssh/fs-write-file',
      args.connectionId,
      { path: args.path, content: args.content }
    )
    if (!result.success) return { error: result.error ?? 'SSH write-file failed' }
    await recordSshTextWriteChange({
      meta: args.changeMeta,
      connectionId: args.connectionId,
      filePath: args.path,
      before,
      afterText: args.content
    })
    return { success: true, op: result.op ?? (before.exists ? 'modify' : 'create') }
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshReadFileBinary(args: SshReadFileBinaryArgs): Promise<unknown> {
  try {
    const result = await nativeSshFsRequest<NativeSshFileBinaryResult>(
      'ssh/fs-read-file-binary',
      args.connectionId,
      { path: args.path },
      120_000
    )
    return result.success
      ? { data: result.data ?? '' }
      : { error: result.error ?? 'SSH read binary failed' }
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshWriteFileBinary(args: SshWriteFileBinaryArgs): Promise<unknown> {
  try {
    const result = await nativeSshFsRequest<NativeSshFileMutationResult>(
      'ssh/fs-write-file-binary',
      args.connectionId,
      { path: args.path, data: args.data },
      120_000
    )
    return result.success ? { success: true } : { error: result.error ?? 'SSH write binary failed' }
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshListDir(args: SshListDirArgs): Promise<unknown> {
  try {
    if (args.cursor) return { error: 'Cursor pagination is not available for native SSH list-dir' }
    const result = await nativeSshFsRequest<NativeSshFileListResult>(
      'ssh/fs-list-dir',
      args.connectionId,
      { path: args.path, limit: args.limit ?? 1000 }
    )
    if (!result.success) return { error: result.error ?? 'SSH list-dir failed' }
    return args.limit
      ? {
          entries: result.entries ?? [],
          hasMore: result.hasMore === true,
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {})
        }
      : (result.entries ?? [])
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshHomeDir(args: { connectionId: string }): Promise<unknown> {
  try {
    const result = await nativeSshFsRequest<NativeSshFileHomeResult>(
      'ssh/fs-home-dir',
      args.connectionId
    )
    return result.success && result.path
      ? { path: result.path }
      : { error: result.error ?? 'Failed to resolve home dir' }
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshFsConnect(args: { connectionId: string }): Promise<unknown> {
  try {
    const result = await nativeSshFsRequest<NativeSshFileHomeResult>(
      'ssh/fs-home-dir',
      args.connectionId
    )
    return result.success
      ? { success: true, homeDir: result.path ?? null }
      : { error: result.error }
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshFsDisconnect(args: { connectionId: string }): Promise<unknown> {
  try {
    logSshDebug('native fs disconnect requested', { connectionId: args.connectionId })
    return { success: true }
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshMkdir(args: { connectionId: string; path: string }): Promise<unknown> {
  try {
    const result = await nativeSshFsRequest<NativeSshFileMutationResult>(
      'ssh/fs-mkdir',
      args.connectionId,
      { path: args.path }
    )
    return result.success ? { success: true } : { error: result.error ?? 'SSH mkdir failed' }
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshDelete(args: { connectionId: string; path: string }): Promise<unknown> {
  try {
    const result = await nativeSshFsRequest<NativeSshFileMutationResult>(
      'ssh/fs-delete',
      args.connectionId,
      { path: args.path }
    )
    return result.success ? { success: true } : { error: result.error ?? 'SSH delete failed' }
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshMove(args: {
  connectionId: string
  from: string
  to: string
}): Promise<unknown> {
  try {
    const result = await nativeSshFsRequest<NativeSshFileMutationResult>(
      'ssh/fs-move',
      args.connectionId,
      { from: args.from, to: args.to }
    )
    return result.success ? { success: true } : { error: result.error ?? 'SSH move failed' }
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshExec(args: SshExecArgs): Promise<unknown> {
  try {
    const result = await execNativeSshCommand(args.connectionId, args.command, args.timeout)
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr || result.error || ''
    }
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshGlob(args: SshGlobArgs): Promise<unknown> {
  try {
    return await nativeSshFsRequest<SshGlobResult>('ssh/fs-glob', args.connectionId, {
      path: args.path || '.',
      pattern: args.pattern,
      limit: args.limit
    })
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshGrep(args: SshGrepArgs): Promise<unknown> {
  try {
    const { connectionId, ...params } = args
    return await nativeSshFsRequest<SshGrepResult>('ssh/fs-grep', connectionId, {
      ...params,
      path: args.path || '.'
    })
  } catch (err) {
    return { error: String(err) }
  }
}

export async function registerSshHandlers(): Promise<void> {
  registerSshChangeAdapter({
    readSnapshot: readSshTextSnapshot,
    writeText: writeSshTextFile,
    deleteFile: deleteSshFile
  })
  await initializeSshRepository()
  ensureSshConfigWatcher()

  // ── Group CRUD ──

  registerSshMessagePackHandler<void>('ssh:group:list', async () => {
    try {
      return listSshGroups().map(toGroupRow)
    } catch (err) {
      return { error: String(err) }
    }
  })

  registerSshMessagePackHandler<{ id: string; name: string; sortOrder?: number }>(
    'ssh:group:create',
    async (args) => {
      try {
        await createGroup({
          id: args.id,
          name: args.name,
          sortOrder: args.sortOrder ?? 0
        })
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  registerSshMessagePackHandler<{ connectionId: string; publicKey: string }>(
    'ssh:auth:install-public-key',
    async (args) => {
      try {
        const publicKey = (args.publicKey ?? '').trim()
        if (!publicKey) return { error: 'Public key is empty' }

        const cmd =
          `mkdir -p ~/.ssh && ` +
          `chmod 700 ~/.ssh && ` +
          `touch ~/.ssh/authorized_keys && ` +
          `chmod 600 ~/.ssh/authorized_keys && ` +
          `printf %s\\n ${shellEscape(publicKey)} >> ~/.ssh/authorized_keys`
        const result = await sshExec({ connectionId: args.connectionId }, cmd, 15000)
        if (result.exitCode !== 0) {
          throw new Error(result.stderr || 'Failed to install public key')
        }

        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // ── SSH: Zip directory (remote) ──

  registerSshMessagePackHandler<{ connectionId: string; dirPath: string }>(
    'ssh:fs:zip-dir',
    async (args) => {
      try {
        const sshSession: SshClientSession = { connectionId: args.connectionId }
        const resolvedDir = await resolveNativeSshPath(args.connectionId, args.dirPath)
        const parent = path.posix.dirname(resolvedDir)
        const base = path.posix.basename(resolvedDir)
        const outName = `${base}-${nowStamp()}-${Math.random().toString(36).slice(2, 6)}.zip`
        const outPath = parent === '/' ? `/${outName}` : `${parent}/${outName}`

        const hasZip = await checkRemoteCommandExists(sshSession, 'zip')
        if (!hasZip) {
          return {
            error:
              'Remote zip not found. Please install zip (e.g. sudo apt-get install zip / yum install zip).'
          }
        }

        const cmd = `cd ${shellEscape(parent)} && zip -r ${shellEscape(outName)} ${shellEscape(base)} >/dev/null`
        const execResult = await sshExec(sshSession, cmd, 10 * 60_000)
        if (execResult.exitCode !== 0) {
          return { error: execResult.stderr || 'Zip failed' }
        }
        return { outputPath: outPath }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // ── SSH: Upload (file/folder) with progress events ──

  registerSshMessagePackHandler<{
    connectionId: string
    remoteDir: string
    localPath: string
    kind?: 'file' | 'folder'
  }>('ssh:fs:upload:start', async (args) => {
    try {
      return await startUploadTask(args)
    } catch (err) {
      return { error: String(err) }
    }
  })

  registerSshMessagePackHandler<{ taskId: string }>('ssh:fs:upload:cancel', async (args) => {
    return cancelUploadTask(args.taskId)
  })

  registerSshMessagePackHandler<TransferStartArgs>('ssh:fs:transfer:start', async (args) => {
    try {
      return startTransferTask(args)
    } catch (err) {
      return { error: String(err) }
    }
  })

  registerSshMessagePackHandler<{ taskId: string }>('ssh:fs:transfer:cancel', async (args) => {
    return cancelTransferTask(args.taskId)
  })

  registerSshMessagePackHandler<{ id: string; name?: string; sortOrder?: number }>(
    'ssh:group:update',
    async (args) => {
      try {
        await updateGroup(args.id, {
          name: args.name,
          sortOrder: args.sortOrder
        })
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  registerSshMessagePackHandler<{ id: string }>('ssh:group:delete', async (args) => {
    try {
      await deleteSshGroup(args.id)
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  // ── Connection CRUD ──

  registerSshMessagePackHandler<void>('ssh:connection:list', async () => {
    try {
      return listSshConnections().map(toConnectionRow)
    } catch (err) {
      return { error: String(err) }
    }
  })

  registerSshMessagePackHandler<{
    id: string
    groupId?: string
    name: string
    host: string
    port?: number
    username: string
    authType?: string
    password?: string
    privateKeyPath?: string
    passphrase?: string
    startupCommand?: string
    defaultDirectory?: string
    proxyJump?: string
    keepAliveInterval?: number
    sortOrder?: number
  }>('ssh:connection:create', async (args) => {
    try {
      await createConnection({
        id: args.id,
        groupId: args.groupId ?? null,
        name: args.name,
        host: args.host,
        port: args.port ?? 22,
        username: args.username,
        authType: (args.authType as SshConfigConnection['authType']) ?? 'password',
        password: args.password ?? null,
        privateKeyPath: args.privateKeyPath ?? null,
        passphrase: args.passphrase ?? null,
        startupCommand: args.startupCommand ?? null,
        defaultDirectory: args.defaultDirectory ?? null,
        proxyJump: args.proxyJump ?? null,
        keepAliveInterval: args.keepAliveInterval ?? 60,
        sortOrder: args.sortOrder ?? 0
      })
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  registerSshMessagePackHandler<{
    id: string
    groupId?: string | null
    name?: string
    host?: string
    port?: number
    username?: string
    authType?: string
    password?: string | null
    privateKeyPath?: string | null
    passphrase?: string | null
    startupCommand?: string | null
    defaultDirectory?: string | null
    proxyJump?: string | null
    keepAliveInterval?: number
    sortOrder?: number
  }>('ssh:connection:update', async (args) => {
    try {
      const patch: SshConnectionPatch = {}
      if (args.groupId !== undefined) patch.groupId = args.groupId
      if (args.name !== undefined) patch.name = args.name
      if (args.host !== undefined) patch.host = args.host
      if (args.port !== undefined) patch.port = args.port
      if (args.username !== undefined) patch.username = args.username
      if (args.authType !== undefined) {
        patch.authType = args.authType as SshConfigConnection['authType']
      }
      if (args.password !== undefined) patch.password = args.password
      if (args.privateKeyPath !== undefined) patch.privateKeyPath = args.privateKeyPath
      if (args.passphrase !== undefined) patch.passphrase = args.passphrase
      if (args.startupCommand !== undefined) patch.startupCommand = args.startupCommand
      if (args.defaultDirectory !== undefined) patch.defaultDirectory = args.defaultDirectory
      if (args.proxyJump !== undefined) patch.proxyJump = args.proxyJump
      if (args.keepAliveInterval !== undefined) patch.keepAliveInterval = args.keepAliveInterval
      if (args.sortOrder !== undefined) patch.sortOrder = args.sortOrder

      await updateSshConnection(args.id, patch)
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  registerSshMessagePackHandler<{ id: string }>('ssh:connection:delete', async (args) => {
    try {
      // Disconnect any active sessions for this connection
      closeSshConnectionHandles(args.id)
      await deleteSshConnection(args.id)
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  // ── Test Connection ──

  registerSshMessagePackHandler<{ id: string }>('ssh:connection:test', async (args) => {
    try {
      const result = await nativeSshFsRequest<NativeSshConnectionTestResult>(
        'ssh/test-connection',
        args.id,
        {},
        30_000
      )
      return result.success
        ? { success: true }
        : { success: false, error: result.error ?? 'Connection test failed' }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  registerSshMessagePackHandler<{ filePath: string; connectionIds?: string[] | null }>(
    'ssh:export',
    async (args) => {
      try {
        await exportSshConfig(args.filePath, args.connectionIds ?? undefined)
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  registerSshMessagePackHandler<{ filePath: string; source: SshImportSource }>(
    'ssh:import:preview',
    async (args) => {
      try {
        return await previewSshImport(args.filePath, args.source)
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  registerSshMessagePackHandler<{
    filePath: string
    source: SshImportSource
    decisions: Array<{ importId: string; action: SshImportAction }>
  }>('ssh:import:apply', async (args) => {
    try {
      return await applySshImport(args.filePath, args.source, args.decisions)
    } catch (err) {
      return { error: String(err) }
    }
  })

  // ── Terminal sessions (backed by the shared connection manager) ──

  registerSshMessagePackHandler<{ connectionId: string }>('ssh:connect', async (args) => {
    try {
      return await openSshTerminal(args.connectionId)
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.on(toMessagePackChannel('ssh:data'), (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<{ sessionId: string; data: string }>(bytes)
    writeSshTerminal(args.sessionId, args.data)
  })

  ipcMain.on(toMessagePackChannel('ssh:resize'), (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<{ sessionId: string; cols: number; rows: number }>(bytes)
    resizeSshTerminal(args.sessionId, args.cols, args.rows)
  })

  registerSshMessagePackHandler<{ sessionId: string }>('ssh:disconnect', async (args) => {
    return closeSshTerminal(args.sessionId)
  })

  registerSshMessagePackHandler<void>('ssh:session:list', async () => {
    return listSshTerminals()
  })

  registerSshMessagePackHandler<SshOutputBufferArgs>('ssh:output:buffer', handleSshOutputBuffer)

  // ── SSH FS: Read file ──

  registerSshMessagePackHandler<SshReadFileArgs>('ssh:fs:read-file', handleSshReadFile)
  registerSshMessagePackHandler<SshReadTextFileLinesArgs>(
    'ssh:fs:read-text-file-lines',
    handleSshReadTextFileLines
  )

  // ── SSH FS: Write file ──

  registerSshMessagePackHandler<{ connectionId: string; path: string }>(
    'ssh:fs:stat-path',
    handleSshStatPath
  )
  registerSshMessagePackHandler<SshWriteFileArgs>('ssh:fs:write-file', handleSshWriteFile)

  // ── SSH FS: Read binary file ──

  registerSshMessagePackHandler<SshReadFileBinaryArgs>(
    'ssh:fs:read-file-binary',
    handleSshReadFileBinary
  )

  // ── SSH FS: Write binary file ──

  registerSshMessagePackHandler<SshWriteFileBinaryArgs>(
    'ssh:fs:write-file-binary',
    handleSshWriteFileBinary
  )

  // ── SSH FS: List directory ──

  registerSshMessagePackHandler<SshListDirArgs>('ssh:fs:list-dir', handleSshListDir)
  registerSshMessagePackHandler<{ connectionId: string }>('ssh:fs:home-dir', handleSshHomeDir)
  registerSshMessagePackHandler<{ connectionId: string }>('ssh:fs:connect', handleSshFsConnect)
  registerSshMessagePackHandler<{ connectionId: string }>(
    'ssh:fs:disconnect',
    handleSshFsDisconnect
  )

  registerSshMessagePackHandler<{ connectionId: string; remotePath: string; localPath: string }>(
    'ssh:fs:download',
    async (args) => {
      try {
        const result = await nativeSshFsRequest<NativeSshFileTransferResult>(
          'ssh/fs-download',
          args.connectionId,
          {
            remotePath: args.remotePath,
            localPath: args.localPath
          },
          30 * 60_000
        )
        return result.success
          ? { success: true, path: result.path ?? args.localPath, bytes: result.bytes ?? 0 }
          : { error: result.error ?? 'SSH download failed' }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // ── SSH FS: Mkdir ──

  registerSshMessagePackHandler<{ connectionId: string; path: string }>(
    'ssh:fs:mkdir',
    handleSshMkdir
  )

  // ── SSH FS: Delete ──

  registerSshMessagePackHandler<{ connectionId: string; path: string }>(
    'ssh:fs:delete',
    handleSshDelete
  )

  // ── SSH FS: Move/Rename ──

  registerSshMessagePackHandler<{ connectionId: string; from: string; to: string }>(
    'ssh:fs:move',
    handleSshMove
  )

  // ── SSH Exec (non-interactive command) ──

  registerSshMessagePackHandler<SshExecArgs>('ssh:exec', handleSshExec)

  // ── SSH Glob (via remote find) ──

  registerSshMessagePackHandler<SshGlobArgs>('ssh:fs:glob', handleSshGlob)

  // ── SSH Grep (via remote grep) ──

  registerSshMessagePackHandler<SshGrepArgs>('ssh:fs:grep', handleSshGrep)
}

// ── Helpers ──

function sshExec(
  session: SshClientSession,
  command: string,
  timeout = 60000
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return execNativeSshCommand(session.connectionId, command, timeout).then((result) => ({
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr || result.error || ''
  }))
}

function shellEscape(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'"
}

async function readSshTextSnapshot(connectionId: string, filePath: string): Promise<FileSnapshot> {
  const stat = await nativeSshFsRequest<NativeSshFileStatResult>('ssh/fs-stat-path', connectionId, {
    path: filePath
  })
  if (!stat.success || !stat.exists) return buildFileSnapshot(false)
  if (stat.type !== 'file') return buildOpaqueExistingSnapshot()
  const text = await nativeSshFsRequest<NativeSshFileTextResult>('ssh/fs-read-file', connectionId, {
    path: filePath
  })
  if (!text.success) return buildOpaqueExistingSnapshot()
  return buildFileSnapshot(true, text.content ?? '')
}

async function writeSshTextFile(
  connectionId: string,
  filePath: string,
  content: string
): Promise<void> {
  const result = await nativeSshFsRequest<NativeSshFileMutationResult>(
    'ssh/fs-write-file',
    connectionId,
    { path: filePath, content }
  )
  if (!result.success) throw new Error(result.error ?? 'SSH write-file failed')
}

async function deleteSshFile(connectionId: string, filePath: string): Promise<void> {
  const result = await nativeSshFsRequest<NativeSshFileMutationResult>(
    'ssh/fs-delete',
    connectionId,
    { path: filePath }
  )
  if (!result.success) throw new Error(result.error ?? 'SSH delete failed')
}

// ── Cleanup ──

export function closeAllSshSessions(): void {
  closeAllSshConnections()
}
