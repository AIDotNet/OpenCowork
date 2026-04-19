import { ipcMain, BrowserWindow, app } from 'electron'
import { Client, type ConnectConfig, type ClientChannel, type SFTPWrapper } from 'ssh2'
import * as fs from 'fs'
import * as path from 'path'
import archiver from 'archiver'
import {
  startSshConfigWatcher,
  onSshConfigChange,
  listSshGroups,
  createSshGroup,
  updateSshGroup,
  deleteSshGroup,
  listSshConnections,
  getSshConnection,
  createSshConnection,
  updateSshConnection,
  deleteSshConnection,
  getOpenSshHostConfig,
  type SshConfigGroup,
  type SshConfigConnection,
  type OpenSshHostConfig
} from '../ssh/ssh-config'
import {
  applySshImport,
  exportSshConfig,
  previewSshImport,
  type SshImportAction,
  type SshImportSource
} from '../ssh/ssh-transfer'
import {
  buildFileSnapshot,
  buildOpaqueExistingSnapshot,
  recordSshTextWriteChange,
  registerSshChangeAdapter,
  type FileSnapshot
} from './agent-change-handlers'
import { createGitIgnoreMatcher } from './gitignore-utils'
import { safeSendToAllWindows, safeSendToWindow } from '../window-ipc'

// ── SSH Session Manager ──

interface SshSession {
  id: string
  connectionId: string
  client: Client
  shell: ClientChannel | null
  sftp: SFTPWrapper | null
  status: 'connecting' | 'connected' | 'disconnected' | 'error'
  error?: string
  homeDir?: string
  outputSeq: number
  outputBuffer: { seq: number; data: Buffer }[]
  outputBufferSize: number
  jumpClient?: Client
}

interface ResolvedJumpTarget {
  source: 'alias' | 'connectionId' | 'string'
  label: string
  connection: SshConfigConnection
}

interface LayeredSshError {
  stage: 'jump_connect' | 'jump_auth' | 'target_connect' | 'target_auth' | 'config'
  message: string
  cause?: unknown
}

const sshSessions = new Map<string, SshSession>()
;(
  globalThis as typeof globalThis & { __openCoworkSshSessions?: typeof sshSessions }
).__openCoworkSshSessions = sshSessions
let nextSessionId = 1
const MAX_OUTPUT_BUFFER_BYTES = 1024 * 1024
const SFTP_LIST_DIR_TIMEOUT_MS = 15000
const SFTP_OPEN_TIMEOUT_MS = 15000
const FILE_SESSION_CONNECT_TIMEOUT_MS = 30000
const SFTP_LIST_DIR_CACHE_TTL_MS = 30000
const SFTP_LIST_DIR_CURSOR_TTL_MS = 30000
const SFTP_CLOSE_TIMEOUT_MS = 5000
const MAX_EMPTY_READDIR_ROUNDS = 5
let sshConfigWatcherAttached = false

interface FileSession {
  connectionId: string
  client: Client
  sftp: SFTPWrapper | null
  status: 'connecting' | 'connected' | 'error'
  error?: string
  homeDir?: string
  lastUsedAt: number
  connectPromise?: Promise<FileSession>
  jumpClient?: Client
}

type SshLikeSession = {
  connectionId: string
  client: Client
  sftp: SFTPWrapper | null
  homeDir?: string
}

type SshClientSession = {
  client: Client
}

const fileSessions = new Map<string, FileSession>()

type SftpListEntry = {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink'
  size: number
  modifyTime: number
}

type SftpDirCacheEntry = {
  entries: SftpListEntry[]
  complete: boolean
  createdAt: number
  lastAccess: number
}

type SftpDirCursor =
  | {
      id: string
      type: 'cache'
      connectionId: string
      path: string
      entries: SftpListEntry[]
      offset: number
      lastAccess: number
    }
  | {
      id: string
      type: 'sftp'
      connectionId: string
      path: string
      handle: Buffer
      pending: SftpListEntry[]
      lastAccess: number
    }

const sftpListDirCache = new Map<string, SftpDirCacheEntry>()
const sftpDirCursors = new Map<string, SftpDirCursor>()

type UploadStage =
  | 'compress'
  | 'upload'
  | 'remote_unzip'
  | 'cleanup'
  | 'done'
  | 'error'
  | 'canceled'

type UploadProgress = {
  current?: number
  total?: number
  percent?: number
}

type UploadEvent = {
  taskId: string
  connectionId: string
  stage: UploadStage
  progress?: UploadProgress
  message?: string
}

type UploadTaskState = {
  taskId: string
  connectionId: string
  canceled: boolean
  cancel: (reason?: string) => Promise<void>
  localTempZipPath?: string
  remoteTempZipPath?: string
}

type SearchLimitReason = 'max_results' | 'max_output_bytes' | 'timeout' | 'max_depth' | null

const SSH_SEARCH_IGNORE_DIRS = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.bzr',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  'coverage',
  '.nyc_output',
  '.cache',
  '.parcel-cache',
  'vendor',
  'target',
  'bin',
  'obj',
  '.gradle',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.venv',
  'venv',
  'env'
] as const

type SearchMeta = {
  backend: 'ssh'
  searchRoot: string
  pathStyle: 'absolute'
  truncated: boolean
  timedOut: boolean
  limitReason: SearchLimitReason
  pattern: string
  include?: string | null
  hiddenIncluded: boolean
  ignoredDefaultsApplied: boolean
  warnings?: string[]
  maxDepth?: number | null
}

type SshGlobResult = {
  kind: 'glob'
  matches: Array<{ path: string; type?: 'file' | 'directory' }>
  meta: SearchMeta
  error?: string
}

type SshGrepResult = {
  kind: 'grep'
  matches: Array<{ path: string; line: number; text: string }>
  meta: SearchMeta
  error?: string
}

function createSshSearchMeta(args: {
  searchRoot: string
  pattern: string
  include?: string | null
  truncated?: boolean
  timedOut?: boolean
  limitReason?: SearchLimitReason
  warnings?: string[]
  maxDepth?: number | null
}): SearchMeta {
  return {
    backend: 'ssh',
    searchRoot: args.searchRoot,
    pathStyle: 'absolute',
    truncated: args.truncated === true,
    timedOut: args.timedOut === true,
    limitReason: args.limitReason ?? null,
    pattern: args.pattern,
    include: args.include ?? null,
    hiddenIncluded: true,
    ignoredDefaultsApplied: true,
    warnings: args.warnings ?? [],
    maxDepth: args.maxDepth ?? null
  }
}

function createSshGlobResult(args: {
  searchRoot: string
  pattern: string
  matches: Array<{ path: string; type?: 'file' | 'directory' }>
  truncated?: boolean
  limitReason?: SearchLimitReason
  warnings?: string[]
  maxDepth?: number | null
  error?: string
}): SshGlobResult {
  return {
    kind: 'glob',
    matches: args.matches,
    meta: createSshSearchMeta({
      searchRoot: args.searchRoot,
      pattern: args.pattern,
      truncated: args.truncated,
      limitReason: args.limitReason,
      warnings: args.warnings,
      maxDepth: args.maxDepth
    }),
    error: args.error
  }
}

function escapeSshSearchRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function includesSshIgnoredDir(pattern: string, dirName: string): boolean {
  return new RegExp(`(^|/)${escapeSshSearchRegex(dirName)}(/|$)`).test(pattern.replace(/\\/g, '/'))
}

function buildSshFindPruneExpression(pattern: string): string {
  const ignoredDirs = SSH_SEARCH_IGNORE_DIRS.filter(
    (dir) => !includesSshIgnoredDir(pattern, dir)
  )
  if (ignoredDirs.length === 0) return ''

  const nameClauses = ignoredDirs.map((dir) => `-name ${shellEscape(dir)}`).join(' -o ')
  return `-type d \\( ${nameClauses} \\) -prune -o `
}

function appendSshRipgrepDefaultGlobs(cmd: string): string {
  let next = cmd
  for (const dir of SSH_SEARCH_IGNORE_DIRS) {
    next += ` --glob ${shellEscape(`!${dir}/**`)}`
    next += ` --glob ${shellEscape(`!**/${dir}/**`)}`
  }
  return next
}

function appendSshGrepExcludeDirs(cmd: string): string {
  let next = cmd
  for (const dir of SSH_SEARCH_IGNORE_DIRS) {
    next += ` --exclude-dir=${shellEscape(dir)}`
  }
  return next
}

function createSshGrepResult(args: {
  searchRoot: string
  pattern: string
  include?: string | null
  matches: Array<{ path: string; line: number; text: string }>
  truncated?: boolean
  timedOut?: boolean
  limitReason?: SearchLimitReason
  warnings?: string[]
  maxDepth?: number | null
  error?: string
}): SshGrepResult {
  return {
    kind: 'grep',
    matches: args.matches,
    meta: createSshSearchMeta({
      searchRoot: args.searchRoot,
      pattern: args.pattern,
      include: args.include,
      truncated: args.truncated,
      timedOut: args.timedOut,
      limitReason: args.limitReason,
      warnings: args.warnings,
      maxDepth: args.maxDepth
    }),
    error: args.error
  }
}

const uploadTasks = new Map<string, UploadTaskState>()

function broadcastUploadEvent(evt: UploadEvent): void {
  safeSendToAllWindows('ssh:fs:upload:events', evt)
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

async function ensureRemoteDir(session: SshLikeSession, remoteDir: string): Promise<void> {
  const sftp = await getSftp(session)
  await sftpMkdirRecursive(sftp, remoteDir)
}

async function sftpUnlinkSafe(session: SshLikeSession, remotePath: string): Promise<void> {
  const sftp = await getSftp(session)
  await new Promise<void>((resolve) => {
    sftp.unlink(remotePath, () => resolve())
  })
}

async function checkRemoteCommandExists(session: SshClientSession, cmd: string): Promise<boolean> {
  const result = await sshExec(session, `command -v ${cmd} >/dev/null 2>&1`)
  return result.exitCode === 0
}

function formatUnzipInstallHint(): string {
  return 'Remote unzip not found. Please install unzip (e.g. sudo apt-get install unzip / yum install unzip).'
}

async function zipLocalFolder(
  taskId: string,
  connectionId: string,
  folderPath: string
): Promise<string> {
  const stat = await fs.promises.stat(folderPath)
  if (!stat.isDirectory()) throw new Error('Selected path is not a folder')

  const baseName = path.basename(folderPath)
  const zipName = `${baseName}-${nowStamp()}-${Math.random().toString(36).slice(2, 6)}.zip`
  const tempDir = path.join(app.getPath('temp'), 'open-cowork-uploads')
  await fs.promises.mkdir(tempDir, { recursive: true })
  const zipPath = path.join(tempDir, zipName)

  broadcastUploadEvent({
    taskId,
    connectionId,
    stage: 'compress',
    message: 'Compressing folder...'
  })

  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(zipPath)
    const zip = archiver('zip', { zlib: { level: 9 } })

    output.on('close', () => resolve())
    output.on('error', (err) => reject(err))

    zip.on('warning', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      reject(err)
    })
    zip.on('error', (err) => reject(err))

    zip.on('progress', (data) => {
      const processed = data.entries.processed
      const total = data.entries.total
      const percent = total > 0 ? Math.round((processed / total) * 100) : undefined
      broadcastUploadEvent({
        taskId,
        connectionId,
        stage: 'compress',
        progress: { current: processed, total, percent },
        message: 'Compressing folder...'
      })
    })

    zip.pipe(output)
    zip.directory(folderPath, false)
    void zip.finalize()
  })

  return zipPath
}

async function uploadFileWithProgress(
  taskId: string,
  connectionId: string,
  session: SshLikeSession,
  localPath: string,
  remotePath: string,
  task: UploadTaskState
): Promise<void> {
  const stat = await fs.promises.stat(localPath)
  const total = stat.size
  let sent = 0

  broadcastUploadEvent({
    taskId,
    connectionId,
    stage: 'upload',
    progress: { current: 0, total, percent: 0 },
    message: 'Uploading...'
  })

  const sftp = await getSftp(session)
  await ensureRemoteDir(session, path.posix.dirname(remotePath))

  await new Promise<void>((resolve, reject) => {
    const readStream = fs.createReadStream(localPath)
    const writeStream = sftp.createWriteStream(remotePath)
    let lastEmit = 0

    const cleanup = (): void => {
      readStream.removeAllListeners()
      writeStream.removeAllListeners()
    }

    task.cancel = async (reason?: string): Promise<void> => {
      void reason
      if (task.canceled) return
      task.canceled = true
      broadcastUploadEvent({ taskId, connectionId, stage: 'canceled', message: 'Canceled' })
      readStream.destroy(new Error('Upload canceled'))
      writeStream.destroy()
      try {
        await sftpUnlinkSafe(session, remotePath)
      } catch {
        // ignore
      }
    }

    readStream.on('data', (chunk) => {
      const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk))
      sent += size
      const now = Date.now()
      if (now - lastEmit > 200) {
        lastEmit = now
        const percent = total > 0 ? Math.round((sent / total) * 100) : undefined
        broadcastUploadEvent({
          taskId,
          connectionId,
          stage: 'upload',
          progress: { current: sent, total, percent },
          message: 'Uploading...'
        })
      }
    })

    writeStream.on('close', () => {
      cleanup()
      resolve()
    })

    writeStream.on('error', (err) => {
      cleanup()
      reject(err)
    })

    readStream.on('error', (err) => {
      cleanup()
      reject(err)
    })

    readStream.pipe(writeStream)
  })
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof TimeoutError ||
    (!!err && typeof err === 'object' && (err as { name?: string }).name === 'TimeoutError')
  )
}

function normalizeSftpErrorMessage(message: string): string {
  if (message.includes('Packet length') && message.includes('exceeds maxlength')) {
    return 'Remote SFTP is unavailable or returned non-SFTP data'
  }
  return message
}

function toSftpError(err: unknown): Error {
  if (err instanceof Error) {
    return new Error(normalizeSftpErrorMessage(err.message))
  }
  return new Error(normalizeSftpErrorMessage(String(err)))
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

function broadcastToRenderer(channel: string, data: unknown): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    safeSendToWindow(win, channel, data)
  }
}

function ensureSshConfigWatcher(): void {
  if (sshConfigWatcherAttached) return
  sshConfigWatcherAttached = true
  startSshConfigWatcher()
  onSshConfigChange(() => {
    broadcastToRenderer('ssh:config:changed', {})
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

function toConnectionRow(connection: SshConfigConnection): SshConnectionRow {
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

function buildConnectConfig(connection: SshConfigConnection): ConnectConfig {
  if (!connection) throw new Error('Connection not found')

  const config: ConnectConfig = {
    host: connection.host,
    port: connection.port,
    username: connection.username,
    keepaliveInterval: (connection.keepAliveInterval ?? 60) * 1000,
    keepaliveCountMax: 3,
    readyTimeout: 30000
  }

  if (connection.authType === 'password') {
    if (!connection.password) {
      throw new Error('Password is required for password authentication')
    }
    config.password = connection.password
  } else if (connection.authType === 'privateKey') {
    if (!connection.privateKeyPath) {
      throw new Error('Private key path is required for private key authentication')
    }
    try {
      config.privateKey = fs.readFileSync(connection.privateKeyPath, 'utf-8')
    } catch (err) {
      throw new Error(`Failed to read private key: ${err}`)
    }
    if (connection.passphrase) {
      config.passphrase = connection.passphrase
    }
  } else if (connection.authType === 'agent') {
    config.agent =
      process.platform === 'win32'
        ? '\\\\.\\pipe\\openssh-ssh-agent'
        : process.env.SSH_AUTH_SOCK || undefined
  } else {
    throw new Error(`Unsupported authentication type: ${connection.authType}`)
  }

  return config
}

function toLayeredError(
  stage: LayeredSshError['stage'],
  message: string,
  cause?: unknown
): LayeredSshError {
  return { stage, message, cause }
}

function isAuthFailureMessage(message: string): boolean {
  return message.includes('All configured authentication methods failed')
}

function formatLayeredError(
  err: unknown,
  fallbackAuthType?: SshConfigConnection['authType']
): string {
  if (err && typeof err === 'object' && 'stage' in err && 'message' in err) {
    const layered = err as LayeredSshError
    const raw = layered.message || ''
    if (layered.stage === 'jump_auth') {
      return `跳板机认证失败：${raw}`
    }
    if (layered.stage === 'jump_connect') {
      return `跳板机连接失败：${raw}`
    }
    if (layered.stage === 'target_auth') {
      if (fallbackAuthType === 'password') return '目标主机密码认证失败，请检查密码。'
      if (fallbackAuthType === 'privateKey') return '目标主机私钥认证失败，请检查密钥或口令。'
      if (fallbackAuthType === 'agent') return '目标主机 SSH Agent 认证失败，请检查 Agent 状态。'
      return `目标主机认证失败：${raw}`
    }
    if (layered.stage === 'target_connect') {
      return `目标主机连接失败：${raw}`
    }
    return raw
  }

  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('ECONNREFUSED')) return '连接被拒绝，请检查主机和端口。'
  if (message.includes('ETIMEDOUT') || message.includes('timeout'))
    return '连接超时，请检查网络可达性。'
  if (message.includes('ENOTFOUND') || message.includes('getaddrinfo'))
    return '主机不可解析，请检查主机名或 IP。'
  if (isAuthFailureMessage(message)) {
    if (fallbackAuthType === 'password') return '密码认证失败，请检查密码。'
    if (fallbackAuthType === 'privateKey') return '私钥认证失败，请检查密钥文件和口令。'
    if (fallbackAuthType === 'agent') return 'SSH Agent 认证失败，请检查 Agent 是否可用。'
  }
  return message
}

function createDerivedConnection(
  base: SshConfigConnection,
  patch: Partial<SshConfigConnection>
): SshConfigConnection {
  return {
    ...base,
    ...patch,
    id: patch.id ?? base.id,
    name: patch.name ?? base.name,
    host: patch.host ?? base.host,
    port: patch.port ?? base.port,
    username: patch.username ?? base.username,
    authType: patch.authType ?? base.authType,
    password: patch.password ?? base.password,
    privateKeyPath: patch.privateKeyPath ?? base.privateKeyPath,
    passphrase: patch.passphrase ?? base.passphrase,
    keepAliveInterval: patch.keepAliveInterval ?? base.keepAliveInterval,
    proxyJump: patch.proxyJump ?? base.proxyJump
  }
}

function parseOpenSshJumpString(
  raw: string
): { username?: string; host: string; port?: number } | null {
  const value = raw.trim()
  if (!value) return null
  const match = value.match(/^(?:(?<username>[^@]+)@)?(?<host>[^:]+?)(?::(?<port>\d+))?$/)
  if (!match?.groups?.host) return null
  const port = match.groups.port ? Number.parseInt(match.groups.port, 10) : undefined
  return {
    username: match.groups.username,
    host: match.groups.host,
    port: Number.isFinite(port) ? port : undefined
  }
}

function openSshHostToConnection(
  alias: string,
  hostConfig: OpenSshHostConfig,
  target: SshConfigConnection
): SshConfigConnection {
  return createDerivedConnection(target, {
    id: `alias:${alias}`,
    name: alias,
    host: hostConfig.hostName ?? alias,
    port: hostConfig.port ?? 22,
    username: hostConfig.user ?? target.username,
    authType: hostConfig.identityFile ? 'privateKey' : target.authType,
    privateKeyPath: hostConfig.identityFile ?? target.privateKeyPath,
    password: hostConfig.identityFile ? null : target.password,
    passphrase: hostConfig.identityFile ? target.passphrase : target.passphrase,
    proxyJump: null
  })
}

function resolveProxyJumpTarget(target: SshConfigConnection): ResolvedJumpTarget | null {
  const raw = target.proxyJump?.trim()
  if (!raw) return null

  const aliasConfig = getOpenSshHostConfig(raw)
  if (aliasConfig) {
    return {
      source: 'alias',
      label: raw,
      connection: openSshHostToConnection(raw, aliasConfig, target)
    }
  }

  const saved = getSshConnection(raw)
  if (saved) {
    return {
      source: 'connectionId',
      label: saved.name || saved.id,
      connection: createDerivedConnection(saved, { proxyJump: null })
    }
  }

  const parsed = parseOpenSshJumpString(raw)
  if (!parsed) return null
  return {
    source: 'string',
    label: raw,
    connection: createDerivedConnection(target, {
      id: `jump:${raw}`,
      name: raw,
      host: parsed.host,
      port: parsed.port ?? 22,
      username: parsed.username ?? target.username,
      proxyJump: null
    })
  }
}

async function connectClient(client: Client, config: ConnectConfig): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    client
      .once('ready', () => resolve())
      .once('error', (err) => reject(err))
      .connect(config)
  })
}

async function connectWithProxyJump(
  connection: SshConfigConnection
): Promise<{ client: Client; jumpClient?: Client }> {
  const targetConfig = buildConnectConfig(connection)
  const jumpTarget = resolveProxyJumpTarget(connection)
  if (!jumpTarget) {
    const client = new Client()
    await connectClient(client, targetConfig)
    return { client }
  }

  const jumpClient = new Client()
  try {
    await connectClient(jumpClient, buildConnectConfig(jumpTarget.connection))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw isAuthFailureMessage(message)
      ? toLayeredError('jump_auth', message, err)
      : toLayeredError('jump_connect', message, err)
  }

  const targetClient = new Client()
  try {
    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      jumpClient.forwardOut('127.0.0.1', 0, connection.host, connection.port, (err, channel) => {
        if (err) return reject(err)
        resolve(channel)
      })
    })

    await connectClient(targetClient, { ...targetConfig, sock: stream })
    return { client: targetClient, jumpClient }
  } catch (err) {
    try {
      jumpClient.end()
    } catch {
      // ignore
    }
    const message = err instanceof Error ? err.message : String(err)
    throw isAuthFailureMessage(message)
      ? toLayeredError('target_auth', message, err)
      : toLayeredError('target_connect', message, err)
  }
}

function touchFileSession(session: FileSession): void {
  session.lastUsedAt = Date.now()
}

function closeFileSession(session: FileSession): void {
  try {
    session.client.end()
  } catch {
    // ignore
  }
  const jumpClient = session.jumpClient
  if (jumpClient) {
    try {
      jumpClient.end()
    } catch {
      // ignore
    }
  }
  session.sftp = null
}

function resetFileSession(connectionId: string, reason?: string): void {
  const session = fileSessions.get(connectionId)
  if (!session) return
  session.status = 'error'
  session.error = reason
  closeFileSession(session)
  fileSessions.delete(connectionId)
  clearSftpStateForConnection(connectionId)
}

async function ensureFileSession(connectionId: string): Promise<FileSession> {
  const existing = fileSessions.get(connectionId)
  if (existing?.status === 'connected') {
    if ((existing.client as unknown as { writable?: boolean }).writable === false) {
      resetFileSession(connectionId, 'SSH client no longer writable')
    } else {
      touchFileSession(existing)
      return existing
    }
  }
  if (existing?.connectPromise) return existing.connectPromise

  const connection = getSshConnection(connectionId)
  if (!connection) throw new Error('Connection not found')

  const placeholderClient = new Client()
  const session: FileSession = {
    connectionId,
    client: placeholderClient,
    sftp: null,
    status: 'connecting',
    lastUsedAt: Date.now()
  }

  const connectPromise = new Promise<FileSession>((resolve, reject) => {
    const timeout = setTimeout(() => {
      session.status = 'error'
      session.error = 'File session connection timeout (30s)'
      try {
        session.client.end()
      } catch {
        // ignore
      }
      fileSessions.delete(connectionId)
      reject(new TimeoutError(session.error))
    }, FILE_SESSION_CONNECT_TIMEOUT_MS)

    void (async () => {
      try {
        const connected = await connectWithProxyJump(connection)
        clearTimeout(timeout)
        session.client = connected.client
        session.jumpClient = connected.jumpClient
        session.status = 'connected'
        session.client.on('close', () => {
          fileSessions.delete(connectionId)
        })
        resolve(session)
      } catch (err) {
        clearTimeout(timeout)
        session.status = 'error'
        session.error = formatLayeredError(err, connection.authType)
        try {
          session.client.end()
        } catch {
          // ignore
        }
        fileSessions.delete(connectionId)
        reject(new Error(session.error))
      }
    })()
  })

  session.connectPromise = connectPromise
  fileSessions.set(connectionId, session)

  return connectPromise.finally(() => {
    const current = fileSessions.get(connectionId)
    if (current) current.connectPromise = undefined
  })
}

async function getSftp(session: SshLikeSession): Promise<SFTPWrapper> {
  if (session.sftp) return session.sftp
  const sftp = await withTimeout(
    new Promise<SFTPWrapper>((resolve, reject) => {
      session.client.sftp((err, sftp) => {
        if (err) return reject(toSftpError(err))
        session.sftp = sftp
        resolve(sftp)
      })
    }),
    SFTP_OPEN_TIMEOUT_MS,
    'SFTP open timeout'
  )
  return sftp
}

function isSftpConnectionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const msg = ((err as Error).message ?? '').toLowerCase()
  return (
    isTimeoutError(err) ||
    msg.includes('not connected') ||
    msg.includes('channel not open') ||
    msg.includes('no response') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('write after end') ||
    msg.includes('sftp close timeout') ||
    msg.includes('ssh client no longer writable')
  )
}

async function withFileSession<T>(
  connectionId: string,
  fn: (session: FileSession) => Promise<T>
): Promise<T> {
  const session = await ensureFileSession(connectionId)
  touchFileSession(session)
  try {
    return await fn(session)
  } catch (err) {
    if (isSftpConnectionError(err)) {
      resetFileSession(connectionId, (err as Error).message)
    }
    throw err
  }
}

async function getHomeDir(session: SshLikeSession): Promise<string | null> {
  if (session.homeDir) return session.homeDir
  let homeDir: string | null = null
  try {
    const sftp = await getSftp(session)
    homeDir = await withTimeout(
      new Promise<string>((resolve, reject) => {
        sftp.realpath('.', (err, resolvedPath) => {
          if (err || !resolvedPath) return reject(err ?? new Error('Failed to resolve home dir'))
          resolve(resolvedPath)
        })
      }),
      SFTP_OPEN_TIMEOUT_MS,
      'SFTP realpath timeout'
    )
  } catch {
    const shellSession = findSessionByConnection(session.connectionId)
    if (shellSession) {
      const result = await sshExec(shellSession, 'printf %s "$HOME"', 10000)
      if (result.exitCode === 0) {
        homeDir = result.stdout.trim() || null
      }
    }
  }
  if (homeDir) session.homeDir = homeDir
  return homeDir
}

async function resolveSftpPath(session: SshLikeSession, inputPath: string): Promise<string> {
  if (!inputPath.startsWith('~')) return inputPath
  const homeDir = await getHomeDir(session)
  if (!homeDir) return inputPath
  if (inputPath === '~') return homeDir
  if (inputPath.startsWith('~/')) return path.posix.join(homeDir, inputPath.slice(2))
  return inputPath
}

async function readRemoteTextFileIfExists(
  session: SshLikeSession,
  filePath: string
): Promise<string | null> {
  try {
    const sftp = await getSftp(session)
    return await withTimeout(
      new Promise<string | null>((resolve) => {
        sftp.readFile(filePath, 'utf-8', (err, data) => {
          if (err) return resolve(null)
          resolve(typeof data === 'string' ? data : data.toString('utf-8'))
        })
      }),
      SFTP_OPEN_TIMEOUT_MS,
      'SFTP read-file timeout'
    )
  } catch {
    return null
  }
}

async function resolveRemoteGitIgnoreRoot(
  session: SshLikeSession,
  searchPath: string
): Promise<string> {
  const candidateDirs = [searchPath, path.posix.dirname(searchPath)].filter(
    (value, index, list) => value && list.indexOf(value) === index
  )

  for (const candidateDir of candidateDirs) {
    const result = await sshExec(
      session,
      `git -C ${shellEscape(candidateDir)} rev-parse --show-toplevel 2>/dev/null`
    )
    if (result.exitCode === 0) {
      const gitRoot = result.stdout.trim().split(/\r?\n/).find(Boolean)
      if (gitRoot) return gitRoot
    }
  }

  return searchPath
}

async function createRemoteGitIgnoreContext(
  session: SshLikeSession,
  searchPath: string
): Promise<ReturnType<typeof createGitIgnoreMatcher>> {
  const rootDir = await resolveRemoteGitIgnoreRoot(session, searchPath)
  return createGitIgnoreMatcher({
    rootDir,
    readIgnoreFile: async (filePath) => await readRemoteTextFileIfExists(session, filePath)
  })
}

function getSftpListCacheKey(connectionId: string, resolvedPath: string): string {
  return `${connectionId}:${resolvedPath}`
}

function clearSftpStateForConnection(connectionId: string): void {
  for (const key of sftpListDirCache.keys()) {
    if (key.startsWith(`${connectionId}:`)) {
      sftpListDirCache.delete(key)
    }
  }
  for (const [key, cursor] of sftpDirCursors.entries()) {
    if (cursor.connectionId === connectionId) {
      sftpDirCursors.delete(key)
    }
  }
}

function pruneSftpListDirCache(now: number): void {
  for (const [key, entry] of sftpListDirCache.entries()) {
    if (now - entry.lastAccess > SFTP_LIST_DIR_CACHE_TTL_MS) {
      sftpListDirCache.delete(key)
    }
  }
}

async function pruneSftpDirCursors(now: number): Promise<void> {
  for (const [key, cursor] of sftpDirCursors.entries()) {
    if (now - cursor.lastAccess <= SFTP_LIST_DIR_CURSOR_TTL_MS) continue
    sftpDirCursors.delete(key)
    if (cursor.type !== 'sftp') continue
    const session = fileSessions.get(cursor.connectionId)
    if (!session) continue
    try {
      const sftp = await getSftp(session)
      await withTimeout(
        new Promise<void>((resolve) => sftp.close(cursor.handle, () => resolve())),
        SFTP_CLOSE_TIMEOUT_MS,
        'SFTP close timeout (cursor prune)'
      )
    } catch {
      // ignore – handle may already be invalid
    }
  }
}

async function clearSftpDirState(session: SshLikeSession, resolvedPath: string): Promise<void> {
  const cacheKey = getSftpListCacheKey(session.connectionId, resolvedPath)
  sftpListDirCache.delete(cacheKey)
  for (const [key, cursor] of sftpDirCursors.entries()) {
    if (cursor.connectionId === session.connectionId && cursor.path === resolvedPath) {
      sftpDirCursors.delete(key)
      if (cursor.type === 'sftp') {
        try {
          await closeSftpHandle(session, cursor.handle)
        } catch {
          // ignore
        }
      }
    }
  }
}

function isSftpEof(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: number | string }).code
  return code === 1 || code === 'EOF'
}

function mapSftpEntries(
  resolvedPath: string,
  list: { filename: string; attrs: import('ssh2').Stats }[]
): SftpListEntry[] {
  return list.map((item) => {
    const isDirectory = item.attrs.isDirectory()
    const isSymlink = item.attrs.isSymbolicLink?.() ?? false
    const type = isDirectory ? 'directory' : isSymlink ? 'symlink' : 'file'
    return {
      name: item.filename,
      type,
      path: path.posix.join(resolvedPath, item.filename),
      size: item.attrs.size ?? 0,
      modifyTime: item.attrs.mtime ? item.attrs.mtime * 1000 : 0
    }
  })
}

async function filterSftpEntries(
  entries: SftpListEntry[],
  shouldInclude?: (entry: SftpListEntry) => Promise<boolean>
): Promise<SftpListEntry[]> {
  if (!shouldInclude) return entries

  const filtered: SftpListEntry[] = []
  for (const entry of entries) {
    if (await shouldInclude(entry)) {
      filtered.push(entry)
    }
  }
  return filtered
}

function ensureDirCache(cacheKey: string, now: number): SftpDirCacheEntry {
  const existing = sftpListDirCache.get(cacheKey)
  if (existing) {
    existing.lastAccess = now
    return existing
  }
  const created: SftpDirCacheEntry = {
    entries: [],
    complete: false,
    createdAt: now,
    lastAccess: now
  }
  sftpListDirCache.set(cacheKey, created)
  return created
}

function appendToDirCache(cacheKey: string, entries: SftpListEntry[], now: number): void {
  if (entries.length === 0) return
  const cache = ensureDirCache(cacheKey, now)
  cache.entries.push(...entries)
  cache.lastAccess = now
}

function markDirCacheComplete(cacheKey: string, now: number): void {
  const cache = ensureDirCache(cacheKey, now)
  cache.complete = true
  cache.createdAt = now
  cache.lastAccess = now
}

async function readSftpChunk(
  session: SshLikeSession,
  handle: Buffer,
  resolvedPath: string,
  shouldInclude?: (entry: SftpListEntry) => Promise<boolean>
): Promise<{ entries: SftpListEntry[]; eof: boolean }> {
  const sftp = await getSftp(session)
  const result = await new Promise<{ entries: SftpListEntry[]; eof: boolean }>(
    (resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new TimeoutError(`SFTP list-dir timeout after ${SFTP_LIST_DIR_TIMEOUT_MS}ms`))
      }, SFTP_LIST_DIR_TIMEOUT_MS)

      sftp.readdir(handle, (err, list) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) {
          if (isSftpEof(err)) return resolve({ entries: [], eof: true })
          return reject(err)
        }
        resolve({ entries: mapSftpEntries(resolvedPath, list), eof: false })
      })
    }
  )

  if (result.eof) return result
  return {
    entries: await filterSftpEntries(result.entries, shouldInclude),
    eof: false
  }
}

async function closeSftpHandle(session: SshLikeSession, handle: Buffer): Promise<void> {
  const sftp = await getSftp(session)
  await withTimeout(
    new Promise<void>((resolve) => sftp.close(handle, () => resolve())),
    SFTP_CLOSE_TIMEOUT_MS,
    'SFTP close timeout'
  )
}

async function openSftpDir(session: SshLikeSession, resolvedPath: string): Promise<Buffer> {
  const sftp = await getSftp(session)
  return withTimeout(
    new Promise<Buffer>((resolve, reject) => {
      sftp.opendir(resolvedPath, (err, handle) => {
        if (err) return reject(err)
        resolve(handle)
      })
    }),
    SFTP_OPEN_TIMEOUT_MS,
    'SFTP opendir timeout'
  )
}

async function readAllSftpDirEntries(
  session: SshLikeSession,
  resolvedPath: string,
  shouldInclude?: (entry: SftpListEntry) => Promise<boolean>
): Promise<SftpListEntry[]> {
  const sftp = await getSftp(session)
  const entries = await new Promise<SftpListEntry[]>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new TimeoutError(`SFTP list-dir timeout after ${SFTP_LIST_DIR_TIMEOUT_MS}ms`))
    }, SFTP_LIST_DIR_TIMEOUT_MS)

    sftp.readdir(resolvedPath, (err, list) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) return reject(err)
      resolve(mapSftpEntries(resolvedPath, list))
    })
  })

  return await filterSftpEntries(entries, shouldInclude)
}

async function readFromCacheCursor(
  cursor: Extract<SftpDirCursor, { type: 'cache' }>,
  limit: number
): Promise<{ entries: SftpListEntry[]; hasMore: boolean; nextCursor?: string }> {
  const max = limit > 0 ? limit : cursor.entries.length
  const page = cursor.entries.slice(cursor.offset, cursor.offset + max)
  cursor.offset += page.length
  cursor.lastAccess = Date.now()
  const hasMore = cursor.offset < cursor.entries.length
  if (!hasMore) {
    sftpDirCursors.delete(cursor.id)
    return { entries: page, hasMore }
  }
  return { entries: page, hasMore, nextCursor: cursor.id }
}

async function readFromSftpCursor(
  cursor: Extract<SftpDirCursor, { type: 'sftp' }>,
  session: SshLikeSession,
  cacheKey: string,
  limit: number,
  shouldInclude?: (entry: SftpListEntry) => Promise<boolean>
): Promise<{ entries: SftpListEntry[]; hasMore: boolean; nextCursor?: string }> {
  const max = limit > 0 ? limit : Number.MAX_SAFE_INTEGER
  const page: SftpListEntry[] = []
  let emptyReadCount = 0

  try {
    while (page.length < max) {
      if (cursor.pending.length > 0) {
        const take = cursor.pending.splice(0, max - page.length)
        page.push(...take)
        emptyReadCount = 0
        continue
      }

      const chunk = await readSftpChunk(session, cursor.handle, cursor.path, shouldInclude)
      if (chunk.eof) {
        await closeSftpHandle(session, cursor.handle)
        markDirCacheComplete(cacheKey, Date.now())
        sftpDirCursors.delete(cursor.id)
        return { entries: page, hasMore: false }
      }

      if (chunk.entries.length === 0) {
        emptyReadCount += 1
        if (emptyReadCount >= MAX_EMPTY_READDIR_ROUNDS) {
          await closeSftpHandle(session, cursor.handle)
          markDirCacheComplete(cacheKey, Date.now())
          sftpDirCursors.delete(cursor.id)
          return { entries: page, hasMore: false }
        }
        continue
      }

      emptyReadCount = 0
      appendToDirCache(cacheKey, chunk.entries, Date.now())
      cursor.pending.push(...chunk.entries)
    }

    cursor.lastAccess = Date.now()
    return { entries: page, hasMore: true, nextCursor: cursor.id }
  } catch (err) {
    try {
      await closeSftpHandle(session, cursor.handle)
    } catch {
      // ignore
    }
    sftpDirCursors.delete(cursor.id)
    throw err
  }
}

function recordOutput(session: SshSession, data: Buffer): void {
  session.outputSeq += 1
  const seq = session.outputSeq
  const chunk = Buffer.from(data)

  session.outputBuffer.push({ seq, data: chunk })
  session.outputBufferSize += chunk.length

  while (session.outputBufferSize > MAX_OUTPUT_BUFFER_BYTES && session.outputBuffer.length > 1) {
    const removed = session.outputBuffer.shift()
    if (!removed) break
    session.outputBufferSize -= removed.data.length
  }

  broadcastToRenderer('ssh:output', {
    sessionId: session.id,
    data: chunk.toString('base64'),
    seq
  })
}

export function registerSshHandlers(): void {
  registerSshChangeAdapter({
    readSnapshot: readSshTextSnapshot,
    writeText: writeSshTextFile,
    deleteFile: deleteSshFile
  })
  ensureSshConfigWatcher()

  // ── Group CRUD ──

  ipcMain.handle('ssh:group:list', async () => {
    try {
      return listSshGroups().map(toGroupRow)
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle(
    'ssh:group:create',
    async (_event, args: { id: string; name: string; sortOrder?: number }) => {
      try {
        const now = Date.now()
        createSshGroup({
          id: args.id,
          name: args.name,
          sortOrder: args.sortOrder ?? 0,
          createdAt: now,
          updatedAt: now
        })
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle(
    'ssh:auth:install-public-key',
    async (_event, args: { connectionId: string; publicKey: string }) => {
      try {
        const publicKey = (args.publicKey ?? '').trim()
        if (!publicKey) return { error: 'Public key is empty' }

        await withFileSession(args.connectionId, async (session) => {
          const cmd =
            `mkdir -p ~/.ssh && ` +
            `chmod 700 ~/.ssh && ` +
            `touch ~/.ssh/authorized_keys && ` +
            `chmod 600 ~/.ssh/authorized_keys && ` +
            `printf %s\\n ${shellEscape(publicKey)} >> ~/.ssh/authorized_keys`
          const result = await sshExec(session, cmd, 15000)
          if (result.exitCode !== 0) {
            throw new Error(result.stderr || 'Failed to install public key')
          }
        })

        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // ── SFTP/SSH: Zip directory (remote) ──

  ipcMain.handle(
    'ssh:fs:zip-dir',
    async (_event, args: { connectionId: string; dirPath: string }) => {
      try {
        const sshSession = findSessionByConnection(args.connectionId)
        if (!sshSession) return { error: 'No active SSH session for this connection' }

        return await withFileSession(args.connectionId, async (fileSession) => {
          const resolvedDir = await resolveSftpPath(fileSession, args.dirPath)
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
        })
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // ── SFTP/SSH: Upload (file/folder) with progress events ──

  ipcMain.handle(
    'ssh:fs:upload:start',
    async (
      _event,
      args: {
        connectionId: string
        remoteDir: string
        localPath: string
        kind?: 'file' | 'folder'
      }
    ) => {
      const taskId = `ssh-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      try {
        const sshSession = findSessionByConnection(args.connectionId)
        if (!sshSession) return { error: 'No active SSH session for this connection' }

        const task: UploadTaskState = {
          taskId,
          connectionId: args.connectionId,
          canceled: false,
          cancel: async () => {
            task.canceled = true
            broadcastUploadEvent({ taskId, connectionId: args.connectionId, stage: 'canceled' })
          }
        }
        uploadTasks.set(taskId, task)

        void (async () => {
          try {
            const localStat = await fs.promises.stat(args.localPath)
            const kind: 'file' | 'folder' = args.kind
              ? args.kind
              : localStat.isDirectory()
                ? 'folder'
                : 'file'

            await withFileSession(args.connectionId, async (fileSession) => {
              const resolvedRemoteDir = await resolveSftpPath(fileSession, args.remoteDir)

              if (kind === 'folder') {
                const folderName = path.basename(args.localPath)
                const localZipPath = await zipLocalFolder(taskId, args.connectionId, args.localPath)
                task.localTempZipPath = localZipPath

                const tmpDir = `${resolvedRemoteDir}/.open-cowork-tmp`
                const remoteTmpZip = `${tmpDir}/${folderName}-${nowStamp()}-${Math.random().toString(36).slice(2, 6)}.zip`
                task.remoteTempZipPath = remoteTmpZip

                await ensureRemoteDir(fileSession, tmpDir)
                await uploadFileWithProgress(
                  taskId,
                  args.connectionId,
                  fileSession,
                  localZipPath,
                  remoteTmpZip,
                  task
                )

                if (task.canceled) return
                broadcastUploadEvent({
                  taskId,
                  connectionId: args.connectionId,
                  stage: 'remote_unzip',
                  message: 'Unzipping on remote...'
                })

                const hasUnzip = await checkRemoteCommandExists(sshSession, 'unzip')
                if (!hasUnzip) {
                  throw new Error(formatUnzipInstallHint())
                }

                const destDir = `${resolvedRemoteDir}/${folderName}`
                const unzipCmd = `mkdir -p ${shellEscape(destDir)} && unzip -o ${shellEscape(remoteTmpZip)} -d ${shellEscape(destDir)} >/dev/null`
                const unzipResult = await sshExec(sshSession, unzipCmd, 20 * 60_000)
                if (unzipResult.exitCode !== 0) {
                  throw new Error(unzipResult.stderr || 'Remote unzip failed')
                }

                if (task.canceled) return
                broadcastUploadEvent({
                  taskId,
                  connectionId: args.connectionId,
                  stage: 'cleanup',
                  message: 'Cleaning up...'
                })

                try {
                  await sftpUnlinkSafe(fileSession, remoteTmpZip)
                } catch {
                  // ignore
                }
                try {
                  await fs.promises.unlink(localZipPath)
                } catch {
                  // ignore
                }

                broadcastUploadEvent({
                  taskId,
                  connectionId: args.connectionId,
                  stage: 'done',
                  message: 'Upload complete'
                })
              } else {
                const fileName = path.basename(args.localPath)
                const remoteFilePath = `${resolvedRemoteDir}/${fileName}`
                await uploadFileWithProgress(
                  taskId,
                  args.connectionId,
                  fileSession,
                  args.localPath,
                  remoteFilePath,
                  task
                )

                if (task.canceled) return
                broadcastUploadEvent({
                  taskId,
                  connectionId: args.connectionId,
                  stage: 'done',
                  message: 'Upload complete'
                })
              }
            })
          } catch (err) {
            broadcastUploadEvent({
              taskId,
              connectionId: args.connectionId,
              stage: task.canceled ? 'canceled' : 'error',
              message: String(err)
            })

            if (task.localTempZipPath) {
              try {
                await fs.promises.unlink(task.localTempZipPath)
              } catch {
                // ignore
              }
            }
            if (task.remoteTempZipPath) {
              try {
                await withFileSession(args.connectionId, async (fileSession) => {
                  await sftpUnlinkSafe(fileSession, task.remoteTempZipPath as string)
                })
              } catch {
                // ignore
              }
            }
          } finally {
            uploadTasks.delete(taskId)
          }
        })()

        return { taskId }
      } catch (err) {
        uploadTasks.delete(taskId)
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle('ssh:fs:upload:cancel', async (_event, args: { taskId: string }) => {
    const task = uploadTasks.get(args.taskId)
    if (!task) return { error: 'Task not found' }
    try {
      await task.cancel('Canceled by user')
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle(
    'ssh:group:update',
    async (_event, args: { id: string; name?: string; sortOrder?: number }) => {
      try {
        updateSshGroup(args.id, {
          name: args.name,
          sortOrder: args.sortOrder,
          updatedAt: Date.now()
        })
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle('ssh:group:delete', async (_event, args: { id: string }) => {
    try {
      deleteSshGroup(args.id)
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  // ── Connection CRUD ──

  ipcMain.handle('ssh:connection:list', async () => {
    try {
      return listSshConnections().map(toConnectionRow)
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle(
    'ssh:connection:create',
    async (
      _event,
      args: {
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
      }
    ) => {
      try {
        const now = Date.now()
        const connection: SshConfigConnection = {
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
          sortOrder: args.sortOrder ?? 0,
          lastConnectedAt: null,
          createdAt: now,
          updatedAt: now
        }
        createSshConnection(connection)
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle(
    'ssh:connection:update',
    async (
      _event,
      args: {
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
      }
    ) => {
      try {
        const patch: Partial<Omit<SshConfigConnection, 'id'>> = { updatedAt: Date.now() }
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

        updateSshConnection(args.id, patch)
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle('ssh:connection:delete', async (_event, args: { id: string }) => {
    try {
      // Disconnect any active sessions for this connection
      for (const [sessionId, session] of sshSessions) {
        if (session.connectionId === args.id) {
          session.client.end()
          sshSessions.delete(sessionId)
        }
      }
      resetFileSession(args.id, 'Connection deleted')
      clearSftpStateForConnection(args.id)
      deleteSshConnection(args.id)
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  // ── Test Connection ──

  ipcMain.handle('ssh:connection:test', async (_event, args: { id: string }) => {
    try {
      const connection = getSshConnection(args.id)
      if (!connection) return { error: 'Connection not found' }

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ success: false, error: 'Connection timeout (30s)' })
        }, 30000)

        void (async () => {
          try {
            const connected = await connectWithProxyJump(connection)
            clearTimeout(timeout)
            connected.client.end()
            connected.jumpClient?.end()
            resolve({ success: true })
          } catch (err) {
            clearTimeout(timeout)
            resolve({ success: false, error: formatLayeredError(err, connection.authType) })
          }
        })()
      })
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(
    'ssh:export',
    async (_event, args: { filePath: string; connectionIds?: string[] | null }) => {
      try {
        exportSshConfig(args.filePath, args.connectionIds ?? undefined)
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle(
    'ssh:import:preview',
    async (_event, args: { filePath: string; source: SshImportSource }) => {
      try {
        return previewSshImport(args.filePath, args.source)
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle(
    'ssh:import:apply',
    async (
      _event,
      args: {
        filePath: string
        source: SshImportSource
        decisions: Array<{ importId: string; action: SshImportAction }>
      }
    ) => {
      try {
        return applySshImport(args.filePath, args.source, args.decisions)
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // ── Terminal Session: Connect ──

  ipcMain.handle('ssh:connect', async (_event, args: { connectionId: string }) => {
    try {
      const connection = getSshConnection(args.connectionId)
      if (!connection) return { error: 'Connection not found' }

      const sessionId = `ssh-${nextSessionId++}`

      const session: SshSession = {
        id: sessionId,
        connectionId: args.connectionId,
        client: new Client(),
        shell: null,
        sftp: null,
        status: 'connecting',
        outputSeq: 0,
        outputBuffer: [],
        outputBufferSize: 0
      }
      sshSessions.set(sessionId, session)

      broadcastToRenderer('ssh:status', {
        sessionId,
        connectionId: args.connectionId,
        status: 'connecting'
      })

      return new Promise((resolve) => {
        const connectTimeout = setTimeout(() => {
          session.status = 'error'
          session.error = 'Connection timeout (30s)'
          session.client.end()
          sshSessions.delete(sessionId)
          broadcastToRenderer('ssh:status', {
            sessionId,
            connectionId: args.connectionId,
            status: 'error',
            error: 'Connection timeout (30s)'
          })
          resolve({ error: 'Connection timeout (30s)' })
        }, 30000)

        void (async () => {
          try {
            const connected = await connectWithProxyJump(connection)
            clearTimeout(connectTimeout)
            session.client = connected.client
            session.jumpClient = connected.jumpClient
            session.status = 'connected'

            session.client.on('error', (err) => {
              session.status = 'error'
              session.error = formatLayeredError(err, connection.authType)
              broadcastToRenderer('ssh:status', {
                sessionId,
                connectionId: args.connectionId,
                status: 'error',
                error: session.error
              })
            })

            session.client.on('close', () => {
              if (session.status === 'connected' || session.status === 'connecting') {
                session.status = 'disconnected'
                broadcastToRenderer('ssh:status', {
                  sessionId,
                  connectionId: args.connectionId,
                  status: 'disconnected'
                })
              }
              session.jumpClient?.end()
              sshSessions.delete(sessionId)
            })

            updateSshConnection(args.connectionId, {
              lastConnectedAt: Date.now(),
              updatedAt: Date.now()
            })

            session.client.shell(
              {
                term: 'xterm-256color',
                cols: 120,
                rows: 30,
                modes: {}
              },
              (err, stream) => {
                if (err) {
                  session.status = 'error'
                  session.error = `Shell error: ${err.message}`
                  broadcastToRenderer('ssh:status', {
                    sessionId,
                    connectionId: args.connectionId,
                    status: 'error',
                    error: session.error
                  })
                  resolve({ error: session.error })
                  return
                }

                session.shell = stream

                stream.on('data', (data: Buffer) => {
                  recordOutput(session, data)
                })

                stream.stderr?.on('data', (data: Buffer) => {
                  recordOutput(session, data)
                })

                stream.on('close', () => {
                  session.status = 'disconnected'
                  broadcastToRenderer('ssh:status', {
                    sessionId,
                    connectionId: args.connectionId,
                    status: 'disconnected'
                  })
                  session.client.end()
                  session.jumpClient?.end()
                  sshSessions.delete(sessionId)
                })

                broadcastToRenderer('ssh:status', {
                  sessionId,
                  connectionId: args.connectionId,
                  status: 'connected'
                })

                if (connection.startupCommand) {
                  stream.write(connection.startupCommand + '\n')
                }
                if (connection.defaultDirectory) {
                  stream.write(`cd ${connection.defaultDirectory}\n`)
                }

                resolve({ sessionId })
              }
            )
          } catch (err) {
            clearTimeout(connectTimeout)
            session.status = 'error'
            session.error = formatLayeredError(err, connection.authType)
            sshSessions.delete(sessionId)
            broadcastToRenderer('ssh:status', {
              sessionId,
              connectionId: args.connectionId,
              status: 'error',
              error: session.error
            })
            resolve({ error: session.error })
          }
        })()
      })
    } catch (err) {
      return { error: String(err) }
    }
  })

  // ── Terminal Session: Send data ──

  ipcMain.on('ssh:data', (_event, args: { sessionId: string; data: string }) => {
    const session = sshSessions.get(args.sessionId)
    if (session?.shell && session.status === 'connected') {
      session.shell.write(args.data)
    }
  })

  // ── Terminal Session: Resize PTY ──

  ipcMain.on('ssh:resize', (_event, args: { sessionId: string; cols: number; rows: number }) => {
    const session = sshSessions.get(args.sessionId)
    if (session?.shell && session.status === 'connected') {
      session.shell.setWindow(args.rows, args.cols, 0, 0)
    }
  })

  // ── Terminal Session: Disconnect ──

  ipcMain.handle('ssh:disconnect', async (_event, args: { sessionId: string }) => {
    const session = sshSessions.get(args.sessionId)
    if (!session) return { error: 'Session not found' }

    session.status = 'disconnected'
    if (session.shell) session.shell.end()
    session.client.end()
    sshSessions.delete(args.sessionId)

    broadcastToRenderer('ssh:status', {
      sessionId: args.sessionId,
      connectionId: session.connectionId,
      status: 'disconnected'
    })

    return { success: true }
  })

  // ── Terminal Session: List active sessions ──

  ipcMain.handle('ssh:session:list', async () => {
    const list: { id: string; connectionId: string; status: string; error?: string }[] = []
    for (const session of sshSessions.values()) {
      list.push({
        id: session.id,
        connectionId: session.connectionId,
        status: session.status,
        error: session.error
      })
    }
    return list
  })

  // ── Terminal Session: Output buffer ──

  ipcMain.handle(
    'ssh:output:buffer',
    async (_event, args: { sessionId: string; sinceSeq?: number }) => {
      const session = sshSessions.get(args.sessionId)
      if (!session) return { error: 'Session not found' }

      const sinceSeq = args.sinceSeq ?? 0
      const chunks = session.outputBuffer
        .filter((entry) => entry.seq > sinceSeq)
        .map((entry) => entry.data.toString('base64'))

      return {
        lastSeq: session.outputSeq,
        chunks
      }
    }
  )

  // ── SFTP: Read file ──

  ipcMain.handle(
    'ssh:fs:read-file',
    async (
      _event,
      args: { connectionId: string; path: string; offset?: number; limit?: number; raw?: boolean }
    ) => {
      try {
        const content = await withFileSession(args.connectionId, async (session) => {
          const sftp = await getSftp(session)
          const resolvedPath = await resolveSftpPath(session, args.path)
          return withTimeout(
            new Promise<string>((resolve, reject) => {
              sftp.readFile(resolvedPath, 'utf-8', (err, data) => {
                if (err) return reject(err)
                resolve(typeof data === 'string' ? data : data.toString('utf-8'))
              })
            }),
            SFTP_LIST_DIR_TIMEOUT_MS,
            'SFTP read-file timeout'
          )
        })

        // Default to raw; only format with line numbers when raw is explicitly false
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
  )

  // ── SFTP: Write file ──

  ipcMain.handle(
    'ssh:fs:write-file',
    async (
      _event,
      args: {
        connectionId: string
        path: string
        content: string
        beforeContent?: string
        changeMeta?: { runId?: string; sessionId?: string; toolUseId?: string; toolName?: string }
      }
    ) => {
      try {
        let op: 'create' | 'modify' = 'create'
        await withFileSession(args.connectionId, async (session) => {
          const sftp = await getSftp(session)
          const resolvedPath = await resolveSftpPath(session, args.path)
          const before =
            typeof args.beforeContent === 'string'
              ? buildFileSnapshot(true, args.beforeContent)
              : await readSshTextSnapshot(args.connectionId, resolvedPath)
          op = before.exists ? 'modify' : 'create'

          // Ensure parent directory exists
          const dir = path.posix.dirname(resolvedPath)
          await sftpMkdirRecursive(sftp, dir)

          await withTimeout(
            new Promise<void>((resolve, reject) => {
              sftp.writeFile(resolvedPath, args.content, 'utf-8', (err) => {
                if (err) return reject(err)
                resolve()
              })
            }),
            SFTP_LIST_DIR_TIMEOUT_MS,
            'SFTP write-file timeout'
          )

          recordSshTextWriteChange({
            meta: args.changeMeta,
            connectionId: args.connectionId,
            filePath: resolvedPath,
            before,
            afterText: args.content
          })
        })
        return { success: true, op }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // ── SFTP: Read binary file ──

  ipcMain.handle(
    'ssh:fs:read-file-binary',
    async (_event, args: { connectionId: string; path: string }) => {
      try {
        const buffer = await withFileSession(args.connectionId, async (session) => {
          const sftp = await getSftp(session)
          const resolvedPath = await resolveSftpPath(session, args.path)
          return withTimeout(
            new Promise<Buffer>((resolve, reject) => {
              sftp.readFile(resolvedPath, (err, data) => {
                if (err) return reject(err)
                const output = Buffer.isBuffer(data) ? data : Buffer.from(data)
                resolve(output)
              })
            }),
            SFTP_LIST_DIR_TIMEOUT_MS,
            'SFTP read-file-binary timeout'
          )
        })
        return { data: buffer.toString('base64') }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // ── SFTP: Write binary file ──

  ipcMain.handle(
    'ssh:fs:write-file-binary',
    async (_event, args: { connectionId: string; path: string; data: string }) => {
      try {
        await withFileSession(args.connectionId, async (session) => {
          const sftp = await getSftp(session)
          const resolvedPath = await resolveSftpPath(session, args.path)
          const dir = path.posix.dirname(resolvedPath)
          await sftpMkdirRecursive(sftp, dir)

          const buffer = Buffer.from(args.data, 'base64')
          await withTimeout(
            new Promise<void>((resolve, reject) => {
              sftp.writeFile(resolvedPath, buffer, (err) => {
                if (err) return reject(err)
                resolve()
              })
            }),
            SFTP_LIST_DIR_TIMEOUT_MS,
            'SFTP write-file-binary timeout'
          )
        })
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // ── SFTP: List directory ──

  ipcMain.handle(
    'ssh:fs:list-dir',
    async (
      _event,
      args: {
        connectionId: string
        path: string
        cursor?: string
        limit?: number
        refresh?: boolean
      }
    ) => {
      try {
        console.log('[SSH:list-dir] START', {
          connectionId: args.connectionId,
          path: args.path,
          limit: args.limit,
          cursor: !!args.cursor,
          refresh: args.refresh
        })
        return await withFileSession(args.connectionId, async (session) => {
          const resolvedPath = await resolveSftpPath(session, args.path)
          const gitIgnoreMatcher = await createRemoteGitIgnoreContext(session, resolvedPath)
          const shouldIncludeEntry = async (entry: SftpListEntry): Promise<boolean> =>
            !(await gitIgnoreMatcher.ignores(entry.path, entry.type === 'directory'))
          const now = Date.now()
          console.log('[SSH:list-dir] pruning caches', { resolvedPath })
          pruneSftpListDirCache(now)
          await pruneSftpDirCursors(now)
          console.log('[SSH:list-dir] prune done')

          const rawLimit = Number.isFinite(args.limit) ? Number(args.limit) : 0
          const limit = rawLimit > 0 ? Math.min(rawLimit, 1000) : 0
          const refresh = args.refresh === true
          const cacheKey = getSftpListCacheKey(session.connectionId, resolvedPath)

          if (refresh) {
            await clearSftpDirState(session, resolvedPath)
          }

          if (args.cursor) {
            const cursor = sftpDirCursors.get(args.cursor)
            if (!cursor) return { error: 'Cursor expired' }
            if (cursor.connectionId !== session.connectionId || cursor.path !== resolvedPath) {
              return { error: 'Cursor mismatch' }
            }
            cursor.lastAccess = now
            return cursor.type === 'cache'
              ? readFromCacheCursor(cursor, limit)
              : readFromSftpCursor(cursor, session, cacheKey, limit, shouldIncludeEntry)
          }

          const cached = sftpListDirCache.get(cacheKey)
          const cacheFresh = cached ? now - cached.createdAt <= SFTP_LIST_DIR_CACHE_TTL_MS : false

          if (!limit) {
            if (!refresh && cached && cached.complete && cacheFresh) {
              cached.lastAccess = now
              console.log('[SSH:list-dir] returning cached (no limit)', {
                count: cached.entries.length
              })
              return cached.entries
            }
            console.log('[SSH:list-dir] readAll (no limit)', { resolvedPath })
            const entries = await readAllSftpDirEntries(session, resolvedPath, shouldIncludeEntry)
            sftpListDirCache.set(cacheKey, {
              entries,
              complete: true,
              createdAt: now,
              lastAccess: now
            })
            console.log('[SSH:list-dir] readAll done', { count: entries.length })
            return entries
          }

          if (!refresh && cached && cached.complete && cacheFresh) {
            cached.lastAccess = now
            console.log('[SSH:list-dir] returning cached (paged)', { count: cached.entries.length })
            const cursorId = `sftp-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            const cursor: SftpDirCursor = {
              id: cursorId,
              type: 'cache',
              connectionId: session.connectionId,
              path: resolvedPath,
              entries: cached.entries,
              offset: 0,
              lastAccess: now
            }
            sftpDirCursors.set(cursorId, cursor)
            return readFromCacheCursor(cursor, limit)
          }

          console.log('[SSH:list-dir] opendir', { resolvedPath, limit })
          const handle = await openSftpDir(session, resolvedPath)
          console.log('[SSH:list-dir] opendir OK, reading cursor')
          const cursorId = `sftp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          const cursor: SftpDirCursor = {
            id: cursorId,
            type: 'sftp',
            connectionId: session.connectionId,
            path: resolvedPath,
            handle,
            pending: [],
            lastAccess: now
          }
          const result = await readFromSftpCursor(
            cursor,
            session,
            cacheKey,
            limit,
            shouldIncludeEntry
          )
          console.log('[SSH:list-dir] cursor read done', {
            entries: result.entries.length,
            hasMore: result.hasMore
          })
          if (result.hasMore && result.nextCursor) {
            sftpDirCursors.set(cursorId, cursor)
          }
          return result
        })
      } catch (err) {
        console.error('[SSH:list-dir] ERROR', { path: args.path, error: String(err) })
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle('ssh:fs:home-dir', async (_event, args: { connectionId: string }) => {
    try {
      return await withFileSession(args.connectionId, async (session) => {
        const homeDir = await getHomeDir(session)
        if (!homeDir) return { error: 'Failed to resolve home dir' }
        return { path: homeDir }
      })
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle(
    'ssh:fs:download',
    async (_event, args: { connectionId: string; remotePath: string; localPath: string }) => {
      try {
        return await withFileSession(args.connectionId, async (session) => {
          const sftp = await getSftp(session)
          const remotePath = await resolveSftpPath(session, args.remotePath)

          await fs.promises.mkdir(path.dirname(args.localPath), { recursive: true })

          await new Promise<void>((resolve, reject) => {
            const readStream = sftp.createReadStream(remotePath)
            const writeStream = fs.createWriteStream(args.localPath)

            const onError = (e: unknown): void => {
              try {
                readStream.destroy()
              } catch {
                // ignore
              }
              try {
                writeStream.destroy()
              } catch {
                // ignore
              }
              reject(e instanceof Error ? e : new Error(String(e)))
            }

            readStream.on('error', onError)
            writeStream.on('error', onError)
            writeStream.on('close', () => resolve())
            readStream.pipe(writeStream)
          })

          return { success: true }
        })
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // ── SFTP: Mkdir ──

  ipcMain.handle('ssh:fs:mkdir', async (_event, args: { connectionId: string; path: string }) => {
    try {
      await withFileSession(args.connectionId, async (session) => {
        const inputPath = args.path.trim()
        let resolvedPath = inputPath
        try {
          resolvedPath = await resolveSftpPath(session, inputPath)
          const sftp = await getSftp(session)
          await sftpMkdirRecursive(sftp, resolvedPath)
          return
        } catch (err) {
          const shellSession = findSessionByConnection(args.connectionId)
          if (!shellSession) throw err
          const result = await sshExec(shellSession, `mkdir -p ${shellPathExpr(inputPath)}`, 15000)
          if (result.exitCode !== 0) {
            throw new Error(result.stderr.trim() || result.stdout.trim() || String(err))
          }
        }
      })
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  // ── SFTP: Delete ──

  ipcMain.handle('ssh:fs:delete', async (_event, args: { connectionId: string; path: string }) => {
    try {
      await withFileSession(args.connectionId, async (session) => {
        const sftp = await getSftp(session)
        const resolvedPath = await resolveSftpPath(session, args.path)
        const stat = await sftpStat(sftp, resolvedPath)
        if (stat?.isDirectory()) {
          // Use exec for recursive delete
          await sshExec(session, `rm -rf ${shellEscape(resolvedPath)}`)
        } else {
          await withTimeout(
            new Promise<void>((resolve, reject) => {
              sftp.unlink(resolvedPath, (err) => {
                if (err) return reject(err)
                resolve()
              })
            }),
            SFTP_LIST_DIR_TIMEOUT_MS,
            'SFTP delete timeout'
          )
        }
      })
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  // ── SFTP: Move/Rename ──

  ipcMain.handle(
    'ssh:fs:move',
    async (_event, args: { connectionId: string; from: string; to: string }) => {
      try {
        await withFileSession(args.connectionId, async (session) => {
          const sftp = await getSftp(session)
          const from = await resolveSftpPath(session, args.from)
          const to = await resolveSftpPath(session, args.to)
          await withTimeout(
            new Promise<void>((resolve, reject) => {
              sftp.rename(from, to, (err) => {
                if (err) return reject(err)
                resolve()
              })
            }),
            SFTP_LIST_DIR_TIMEOUT_MS,
            'SFTP rename timeout'
          )
        })
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // ── SSH Exec (non-interactive command) ──

  ipcMain.handle(
    'ssh:exec',
    async (_event, args: { connectionId: string; command: string; timeout?: number }) => {
      try {
        return await withFileSession(args.connectionId, async (session) => {
          return await sshExec(session, args.command, args.timeout)
        })
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // ── SSH Glob (via remote find) ──

  ipcMain.handle(
    'ssh:fs:glob',
    async (_event, args: { connectionId: string; pattern: string; path?: string }) => {
      try {
        return await withFileSession(args.connectionId, async (session) => {
          const cwdInput = args.path || '.'
          const cwd = await resolveSftpPath(session, cwdInput)
          const gitIgnoreMatcher = await createRemoteGitIgnoreContext(session, cwd)
          const maxDepth = 5
          const result = await sshExec(
            session,
            `cd ${shellEscape(cwd)} && find . -maxdepth ${maxDepth} ` +
              `${buildSshFindPruneExpression(args.pattern)}-name ${shellEscape(args.pattern)} ` +
              `-print 2>/dev/null | head -100`
          )
          if (result.exitCode !== 0) {
            return createSshGlobResult({
              searchRoot: cwd,
              pattern: args.pattern,
              matches: [],
              error: result.stderr || 'glob failed',
              maxDepth,
              truncated: false
            })
          }

          const sftp = await getSftp(session)
          const matches: Array<{ path: string; type?: 'file' | 'directory' }> = []
          for (const rawPath of result.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)) {
            const relativePath = rawPath.replace(/^\.\//, '').replace(/\/+$/, '')
            const fullPath = relativePath ? path.posix.join(cwd, relativePath) : cwd
            const stats = await sftpStat(sftp, fullPath)
            const isDir = stats?.isDirectory?.() ?? false
            if (await gitIgnoreMatcher.ignores(fullPath, isDir)) continue
            matches.push({ path: fullPath, type: isDir ? 'directory' : 'file' })
          }
          const rawLines = result.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
          return createSshGlobResult({
            searchRoot: cwd,
            pattern: args.pattern,
            matches,
            truncated: rawLines.length >= 100,
            limitReason: rawLines.length >= 100 ? 'max_results' : null,
            warnings: ['SSH glob uses remote find and may be truncated'],
            maxDepth
          })
        })
      } catch (err) {
        const cwd = args.path || '.'
        return createSshGlobResult({
          searchRoot: cwd,
          pattern: args.pattern,
          matches: [],
          error: String(err),
          warnings: ['SSH glob uses remote find and may be truncated'],
          maxDepth: 5
        })
      }
    }
  )

  // ── SSH Grep (via remote grep) ──

  ipcMain.handle(
    'ssh:fs:grep',
    async (
      _event,
      args: { connectionId: string; pattern: string; path?: string; include?: string }
    ) => {
      try {
        return await withFileSession(args.connectionId, async (session) => {
          const cwdInput = args.path || '.'
          const cwd = await resolveSftpPath(session, cwdInput)
          const gitIgnoreMatcher = await createRemoteGitIgnoreContext(session, cwd)
          const hasRipgrep = await checkRemoteCommandExists(session, 'rg')

          if (hasRipgrep) {
            let cmd = `cd ${shellEscape(cwd)} && rg --json --line-number --color never --no-messages --ignore-case --hidden --max-filesize 10M`
            cmd = appendSshRipgrepDefaultGlobs(cmd)
            if (args.include) cmd += ` --glob ${shellEscape(args.include)}`
            cmd += ` ${shellEscape(args.pattern)} . 2>/dev/null | head -200`

            const result = await sshExec(session, cmd)
            if (result.exitCode !== 0 && result.exitCode !== 1) {
              return createSshGrepResult({
                searchRoot: cwd,
                pattern: args.pattern,
                include: args.include,
                matches: [],
                error: result.stderr || 'grep failed',
                warnings: ['SSH grep uses remote rg and may be truncated by result limits']
              })
            }

            const matches: Array<{ path: string; line: number; text: string }> = []
            let rawMatchCount = 0
            let parseFailed = false
            const rawLines = result.stdout.split('\n')
            for (const rawLine of rawLines) {
              if (!rawLine.trim()) continue
              try {
                const parsed = JSON.parse(rawLine) as {
                  type?: string
                  data?: {
                    path?: { text?: string }
                    lines?: { text?: string }
                    line_number?: number
                  }
                }
                if (parsed.type !== 'match') continue
                rawMatchCount += 1
                const rawPath = parsed.data?.path?.text
                const lineNumber = parsed.data?.line_number
                const text = parsed.data?.lines?.text ?? ''
                if (typeof rawPath !== 'string' || typeof lineNumber !== 'number') continue
                const fullPath = path.posix.isAbsolute(rawPath)
                  ? rawPath
                  : path.posix.join(cwd, rawPath)
                if (await gitIgnoreMatcher.ignores(fullPath, false)) continue
                matches.push({ path: fullPath, line: lineNumber, text: text.trim() })
              } catch {
                parseFailed = true
              }
            }
            const truncated = rawMatchCount >= 200
            return createSshGrepResult({
              searchRoot: cwd,
              pattern: args.pattern,
              include: args.include,
              matches,
              truncated,
              limitReason: truncated ? 'max_results' : null,
              warnings: [
                ...(truncated ? ['SSH grep result truncated by remote limit'] : []),
                ...(parseFailed ? ['Some SSH grep result lines could not be parsed'] : [])
              ]
            })
          }

          let cmd = `grep -rn`
          cmd = appendSshGrepExcludeDirs(cmd)
          if (args.include) cmd += ` --include=${shellEscape(args.include)}`
          cmd += ` ${shellEscape(args.pattern)} ${shellEscape(cwd)}`
          cmd += ' 2>/dev/null | head -100'

          const result = await sshExec(session, cmd)
          if (result.exitCode !== 0 && result.exitCode !== 1) {
            return createSshGrepResult({
              searchRoot: cwd,
              pattern: args.pattern,
              include: args.include,
              matches: [],
              error: result.stderr || 'grep failed',
              warnings: ['SSH grep uses remote grep and may be truncated by result limits']
            })
          }

          const rawLines = result.stdout.split('\n').filter(Boolean)
          const matches: Array<{ path: string; line: number; text: string }> = []
          for (const rawLine of rawLines) {
            const match = rawLine.match(/^(.+?):(\d+):(.*)$/)
            if (!match) continue
            if (await gitIgnoreMatcher.ignores(match[1], false)) continue
            matches.push({ path: match[1], line: parseInt(match[2], 10), text: match[3] })
          }
          return createSshGrepResult({
            searchRoot: cwd,
            pattern: args.pattern,
            include: args.include,
            matches,
            truncated: rawLines.length >= 100,
            limitReason: rawLines.length >= 100 ? 'max_results' : null,
            warnings: ['SSH grep uses remote grep and may be truncated by result limits']
          })
        })
      } catch (err) {
        const cwd = args.path || '.'
        return createSshGrepResult({
          searchRoot: cwd,
          pattern: args.pattern,
          include: args.include,
          matches: [],
          error: String(err),
          warnings: ['SSH grep uses remote grep and may be truncated by result limits']
        })
      }
    }
  )
}

// ── Helpers ──

function findSessionByConnection(connectionId: string): SshSession | undefined {
  for (const session of sshSessions.values()) {
    if (session.connectionId === connectionId && session.status === 'connected') {
      return session
    }
  }
  return undefined
}

function sshExec(
  session: SshClientSession,
  command: string,
  timeout = 60000
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('SSH exec timeout'))
    }, timeout)

    session.client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer)
        return reject(err)
      }

      let stdout = ''
      let stderr = ''

      stream.on('data', (data: Buffer) => {
        stdout += data.toString('utf-8')
      })

      stream.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString('utf-8')
      })

      stream.on('close', (code: number) => {
        clearTimeout(timer)
        resolve({ exitCode: code ?? 0, stdout, stderr })
      })
    })
  })
}

async function sftpStat(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<import('ssh2').Stats | null> {
  try {
    return await withTimeout(
      new Promise<import('ssh2').Stats>((resolve, reject) => {
        sftp.stat(remotePath, (err, stats) => {
          if (err) return reject(err)
          resolve(stats)
        })
      }),
      SFTP_OPEN_TIMEOUT_MS,
      'SFTP stat timeout'
    )
  } catch (err) {
    if (isTimeoutError(err)) throw err
    return null
  }
}

async function sftpMkdirRecursive(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  const parts = remotePath.split('/').filter(Boolean)
  let current = remotePath.startsWith('/') ? '/' : ''

  for (const part of parts) {
    current = current ? path.posix.join(current, part) : part
    const stat = await sftpStat(sftp, current)
    if (!stat) {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          sftp.mkdir(current, (err) => {
            if (err && (err as NodeJS.ErrnoException).code !== 'FAILURE') return reject(err)
            resolve()
          })
        }),
        SFTP_OPEN_TIMEOUT_MS,
        'SFTP mkdir timeout'
      )
    }
  }
}

function shellEscape(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'"
}

function shellPathExpr(str: string): string {
  if (str === '~') return '"$HOME"'
  if (str.startsWith('~/')) return `"$HOME"${shellEscape(str.slice(1))}`
  return shellEscape(str)
}

async function readSshTextSnapshot(connectionId: string, filePath: string): Promise<FileSnapshot> {
  return await withFileSession(connectionId, async (session) => {
    const sftp = await getSftp(session)
    const resolvedPath = await resolveSftpPath(session, filePath)
    const stat = await sftpStat(sftp, resolvedPath)
    if (!stat) return buildFileSnapshot(false)
    if (!stat.isFile()) return buildOpaqueExistingSnapshot()
    const text = await withTimeout(
      new Promise<string>((resolve, reject) => {
        sftp.readFile(resolvedPath, 'utf-8', (err, data) => {
          if (err) return reject(err)
          resolve(typeof data === 'string' ? data : data.toString('utf-8'))
        })
      }),
      SFTP_LIST_DIR_TIMEOUT_MS,
      'SFTP read-file timeout'
    )
    return buildFileSnapshot(true, text)
  })
}

async function writeSshTextFile(
  connectionId: string,
  filePath: string,
  content: string
): Promise<void> {
  await withFileSession(connectionId, async (session) => {
    const sftp = await getSftp(session)
    const resolvedPath = await resolveSftpPath(session, filePath)
    const dir = path.posix.dirname(resolvedPath)
    await sftpMkdirRecursive(sftp, dir)
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        sftp.writeFile(resolvedPath, content, 'utf-8', (err) => {
          if (err) return reject(err)
          resolve()
        })
      }),
      SFTP_LIST_DIR_TIMEOUT_MS,
      'SFTP write-file timeout'
    )
  })
}

async function deleteSshFile(connectionId: string, filePath: string): Promise<void> {
  await withFileSession(connectionId, async (session) => {
    const sftp = await getSftp(session)
    const resolvedPath = await resolveSftpPath(session, filePath)
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        sftp.unlink(resolvedPath, (err) => {
          if (err) return reject(err)
          resolve()
        })
      }),
      SFTP_LIST_DIR_TIMEOUT_MS,
      'SFTP delete timeout'
    )
  })
}

// ── Cleanup ──

/**
 * 供 git-handlers 等在远程执行命令：优先使用已连接的终端会话，否则建立与 SFTP 相同的文件会话。
 * 仅绑定 SSH 工作目录、未打开终端时也能执行 `git`。
 */
export async function getSshClientForGitExec(connectionId: string): Promise<Client | null> {
  for (const session of sshSessions.values()) {
    if (session.connectionId === connectionId && session.status === 'connected') {
      return session.client
    }
  }
  try {
    const fileSession = await ensureFileSession(connectionId)
    if (fileSession.status === 'connected') {
      return fileSession.client
    }
  } catch {
    // 连接不可用或未配置
  }
  return null
}

export function closeAllSshSessions(): void {
  for (const session of sshSessions.values()) {
    try {
      if (session.shell) session.shell.end()
      session.client.end()
    } catch {
      // ignore
    }
  }
  for (const session of fileSessions.values()) {
    try {
      closeFileSession(session)
    } catch {
      // ignore
    }
  }
  sshSessions.clear()
  fileSessions.clear()
  sftpListDirCache.clear()
  sftpDirCursors.clear()
}
