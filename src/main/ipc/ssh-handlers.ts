import { app, ipcMain, BrowserWindow } from 'electron'
import { Client, type ConnectConfig, type ClientChannel } from 'ssh2'
import * as fs from 'fs'
import * as path from 'path'
import {
  startSshConfigWatcher,
  initializeSshConfigCache,
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
import { safeSendMessagePackToAllWindows, safeSendMessagePackToWindow } from '../window-ipc'
import { getNativeWorker } from '../lib/native-worker'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'

// ── SSH Session Manager ──

interface SshSession {
  id: string
  connectionId: string
  client: Client
  shell: ClientChannel | null
  status: 'connecting' | 'connected' | 'disconnected' | 'error'
  error?: string
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
let nativeSshEventsRegistered = false

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

interface NativeSshUploadProgressEvent {
  taskId: string
  connectionId: string
  stage: UploadStage
  progress?: UploadProgress | null
  message?: string | null
}

interface NativeSshTransferProgressEvent {
  taskId: string
  type: TransferTaskType
  stage: TransferStage
  sourceConnectionId?: string | null
  targetConnectionId?: string | null
  progress?: TransferProgress | null
  message?: string | null
  currentItem?: string | null
  conflictPolicy?: SshConflictPolicy | null
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

type UploadStage = 'upload' | 'cleanup' | 'done' | 'error' | 'canceled'

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
}

type SshConflictPolicy = 'skip' | 'overwrite' | 'duplicate'

type TransferTaskType = 'upload' | 'download' | 'remote-copy'

type TransferStage = 'preparing' | 'transferring' | 'cleanup' | 'done' | 'error' | 'canceled'

type TransferProgress = {
  currentBytes?: number
  totalBytes?: number
  percent?: number
  processedItems?: number
  totalItems?: number
}

type TransferEvent = {
  taskId: string
  type: TransferTaskType
  stage: TransferStage
  sourceConnectionId?: string | null
  targetConnectionId?: string | null
  progress?: TransferProgress
  message?: string
  currentItem?: string
  conflictPolicy?: SshConflictPolicy
}

type TransferTaskState = {
  taskId: string
  type: TransferTaskType
  sourceConnectionId?: string | null
  targetConnectionId?: string | null
  canceled: boolean
  cancel: (reason?: string) => Promise<void>
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

const uploadTasks = new Map<string, UploadTaskState>()
const transferTasks = new Map<string, TransferTaskState>()

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

function broadcastUploadEvent(evt: UploadEvent): void {
  safeSendMessagePackToAllWindows('ssh:fs:upload:events', evt)
}

function broadcastTransferEvent(evt: TransferEvent): void {
  safeSendMessagePackToAllWindows('ssh:fs:transfer:events', evt)
}

function isNativeSshUploadProgressEvent(value: unknown): value is NativeSshUploadProgressEvent {
  if (typeof value !== 'object' || value === null) return false
  const event = value as NativeSshUploadProgressEvent
  return (
    typeof event.taskId === 'string' &&
    typeof event.connectionId === 'string' &&
    typeof event.stage === 'string'
  )
}

function isNativeSshTransferProgressEvent(value: unknown): value is NativeSshTransferProgressEvent {
  if (typeof value !== 'object' || value === null) return false
  const event = value as NativeSshTransferProgressEvent
  return (
    typeof event.taskId === 'string' &&
    typeof event.type === 'string' &&
    typeof event.stage === 'string'
  )
}

function ensureNativeSshEventBridge(): void {
  if (nativeSshEventsRegistered) return
  nativeSshEventsRegistered = true
  getNativeWorker().onEvent('ssh/upload-progress', (params) => {
    if (!isNativeSshUploadProgressEvent(params)) return
    broadcastUploadEvent({
      taskId: params.taskId,
      connectionId: params.connectionId,
      stage: params.stage,
      progress: params.progress ?? undefined,
      message: params.message ?? undefined
    })
  })
  getNativeWorker().onEvent('ssh/transfer-progress', (params) => {
    if (!isNativeSshTransferProgressEvent(params)) return
    broadcastTransferEvent({
      taskId: params.taskId,
      type: params.type,
      stage: params.stage,
      sourceConnectionId: params.sourceConnectionId ?? null,
      targetConnectionId: params.targetConnectionId ?? null,
      progress: params.progress ?? undefined,
      message: params.message ?? undefined,
      currentItem: params.currentItem ?? undefined,
      conflictPolicy: params.conflictPolicy ?? undefined
    })
  })
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

function broadcastToRenderer(channel: string, data: unknown): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    safeSendMessagePackToWindow(win, channel, data)
  }
}

function ensureSshConfigWatcher(): void {
  if (sshConfigWatcherAttached) return
  sshConfigWatcherAttached = true
  startSshConfigWatcher()
  onSshConfigChange(() => {
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
      return `Jump host authentication failed: ${raw}`
    }
    if (layered.stage === 'jump_connect') {
      return `Jump host connection failed: ${raw}`
    }
    if (layered.stage === 'target_auth') {
      if (fallbackAuthType === 'password')
        return 'Target host password authentication failed, please check your password.'
      if (fallbackAuthType === 'privateKey')
        return 'Target host private key authentication failed, please check key or passphrase.'
      if (fallbackAuthType === 'agent')
        return 'Target host SSH Agent authentication failed, please check Agent status.'
      return `Target host authentication failed: ${raw}`
    }
    if (layered.stage === 'target_connect') {
      return `Target host connection failed: ${raw}`
    }
    return raw
  }

  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('ECONNREFUSED')) return 'Connection refused, please check host and port.'
  if (message.includes('ETIMEDOUT') || message.includes('timeout'))
    return 'Connection timed out, please check network reachability.'
  if (message.includes('ENOTFOUND') || message.includes('getaddrinfo'))
    return 'Host not resolvable, please check hostname or IP.'
  if (isAuthFailureMessage(message)) {
    if (fallbackAuthType === 'password')
      return 'Password authentication failed, please check password.'
    if (fallbackAuthType === 'privateKey')
      return 'Private key authentication failed, please check key file and passphrase.'
    if (fallbackAuthType === 'agent')
      return 'SSH Agent authentication failed, please check Agent availability.'
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

async function resolveProxyJumpTarget(
  target: SshConfigConnection
): Promise<ResolvedJumpTarget | null> {
  const raw = target.proxyJump?.trim()
  if (!raw) return null

  const aliasConfig = await getOpenSshHostConfig(raw)
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

function formatNativeProxyJumpConnection(connection: SshConfigConnection): string {
  const host = connection.host.includes(':') ? `[${connection.host}]` : connection.host
  const prefix = connection.username ? `${connection.username}@` : ''
  return connection.port && connection.port !== 22
    ? `${prefix}${host}:${connection.port}`
    : `${prefix}${host}`
}

function resolveNativeProxyJump(target: SshConfigConnection): string | null {
  const raw = target.proxyJump?.trim()
  if (!raw) return null

  const saved = getSshConnection(raw)
  if (saved) {
    return formatNativeProxyJumpConnection(createDerivedConnection(saved, { proxyJump: null }))
  }

  const parsed = parseOpenSshJumpString(raw)
  if (!parsed || (!raw.includes('@') && !raw.includes(':'))) return raw
  return formatNativeProxyJumpConnection(
    createDerivedConnection(target, {
      id: `jump:${raw}`,
      name: raw,
      host: parsed.host,
      port: parsed.port ?? 22,
      username: parsed.username ?? target.username,
      proxyJump: null
    })
  )
}

function toNativeSshConnection(connection: SshConfigConnection): Record<string, unknown> {
  const authFields: Record<string, unknown> = {}
  if (connection.authType === 'password') {
    authFields.password = connection.password
  } else if (connection.authType === 'privateKey') {
    authFields.privateKeyPath = connection.privateKeyPath
    authFields.passphrase = connection.passphrase
  }

  return {
    id: connection.id,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    authType: connection.authType,
    proxyJump: resolveNativeProxyJump(connection),
    ...authFields
  }
}

export function getNativeSshConnectionPayload(
  connectionId: string
): Record<string, unknown> | null {
  const connection = getSshConnection(connectionId)
  return connection ? toNativeSshConnection(connection) : null
}

export async function execNativeSshCommand(
  connectionId: string,
  command: string,
  timeout = 60_000
): Promise<NativeSshExecResult> {
  const connection = getSshConnection(connectionId)
  if (!connection) {
    return {
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: 'Connection not found',
      error: 'Connection not found'
    }
  }

  return await getNativeWorker().request<NativeSshExecResult>(
    'ssh/exec',
    {
      connection: toNativeSshConnection(connection),
      command,
      timeoutMs: timeout
    },
    timeout + 30_000
  )
}

async function nativeSshFsRequest<T>(
  method: string,
  connectionId: string,
  params: Record<string, unknown> = {},
  timeout = 60_000
): Promise<T> {
  const connection = getSshConnection(connectionId)
  if (!connection) {
    throw new Error('Connection not found')
  }

  return await getNativeWorker().request<T>(
    method,
    {
      connection: toNativeSshConnection(connection),
      ...params
    },
    timeout + 30_000
  )
}

async function nativeSshRemoteCopyRequest<T>(
  method: string,
  sourceConnectionId: string,
  targetConnectionId: string,
  params: Record<string, unknown> = {},
  timeout = 60_000
): Promise<T> {
  const sourceConnection = getSshConnection(sourceConnectionId)
  if (!sourceConnection) {
    throw new Error('Source connection not found')
  }
  const targetConnection = getSshConnection(targetConnectionId)
  if (!targetConnection) {
    throw new Error('Target connection not found')
  }

  return await getNativeWorker().request<T>(
    method,
    {
      sourceConnection: toNativeSshConnection(sourceConnection),
      targetConnection: toNativeSshConnection(targetConnection),
      sourceConnectionId,
      targetConnectionId,
      ...params
    },
    timeout + 30_000
  )
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
  const jumpTarget = await resolveProxyJumpTarget(connection)
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
  await initializeSshConfigCache()
  ensureSshConfigWatcher()
  ensureNativeSshEventBridge()

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
        const now = Date.now()
        await createSshGroup({
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
    const taskId = `ssh-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    try {
      const localStat = await fs.promises.stat(args.localPath)
      const kind: 'file' | 'folder' = args.kind
        ? args.kind
        : localStat.isDirectory()
          ? 'folder'
          : 'file'

      const task: UploadTaskState = {
        taskId,
        connectionId: args.connectionId,
        canceled: false,
        cancel: async (): Promise<void> => {
          if (task.canceled) return
          task.canceled = true
          await getNativeWorker()
            .request<NativeSshFileMutationResult>('ssh/fs-upload-abort', { taskId }, 10_000)
            .catch((error) => console.warn('[SSH] Native upload abort failed:', error))
          broadcastUploadEvent({
            taskId,
            connectionId: args.connectionId,
            stage: 'canceled',
            message: 'Canceled'
          })
        }
      }
      uploadTasks.set(taskId, task)

      if (kind === 'file') {
        void (async () => {
          try {
            broadcastUploadEvent({
              taskId,
              connectionId: args.connectionId,
              stage: 'upload',
              progress: { current: 0, total: localStat.size, percent: 0 },
              message: 'Uploading...'
            })

            const result = await nativeSshFsRequest<NativeSshFileTransferResult>(
              'ssh/fs-upload-file',
              args.connectionId,
              {
                taskId,
                connectionId: args.connectionId,
                localPath: args.localPath,
                remoteDir: args.remoteDir
              },
              30 * 60_000
            )
            if (task.canceled) return
            if (!result.success) {
              throw new Error(result.error ?? 'SSH upload failed')
            }
            broadcastUploadEvent({
              taskId,
              connectionId: args.connectionId,
              stage: 'done',
              progress: {
                current: result.bytes ?? localStat.size,
                total: localStat.size,
                percent: 100
              },
              message: 'Upload complete'
            })
          } catch (err) {
            broadcastUploadEvent({
              taskId,
              connectionId: args.connectionId,
              stage: task.canceled ? 'canceled' : 'error',
              message: String(err)
            })
          } finally {
            uploadTasks.delete(taskId)
          }
        })()

        return { taskId }
      }

      void (async () => {
        try {
          broadcastUploadEvent({
            taskId,
            connectionId: args.connectionId,
            stage: 'upload',
            message: 'Preparing upload...'
          })

          const result = await nativeSshFsRequest<NativeSshFileTransferResult>(
            'ssh/fs-upload-directory',
            args.connectionId,
            {
              taskId,
              connectionId: args.connectionId,
              localPath: args.localPath,
              remoteDir: args.remoteDir
            },
            2 * 60 * 60_000
          )
          if (task.canceled) return
          if (!result.success) {
            throw new Error(result.error ?? 'SSH directory upload failed')
          }

          const bytes = result.bytes ?? 0
          broadcastUploadEvent({
            taskId,
            connectionId: args.connectionId,
            stage: 'done',
            progress: { current: bytes, total: bytes, percent: 100 },
            message: 'Upload complete'
          })
        } catch (err) {
          broadcastUploadEvent({
            taskId,
            connectionId: args.connectionId,
            stage: task.canceled ? 'canceled' : 'error',
            message: String(err)
          })
        } finally {
          uploadTasks.delete(taskId)
        }
      })()

      return { taskId }
    } catch (err) {
      uploadTasks.delete(taskId)
      return { error: String(err) }
    }
  })

  registerSshMessagePackHandler<{ taskId: string }>('ssh:fs:upload:cancel', async (args) => {
    const task = uploadTasks.get(args.taskId)
    if (!task) return { error: 'Task not found' }
    try {
      await task.cancel('Canceled by user')
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  registerSshMessagePackHandler<
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
  >('ssh:fs:transfer:start', async (args) => {
    const taskId = `ssh-transfer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const conflictPolicy = args.conflictPolicy ?? 'skip'

    try {
      logSshDebug('transfer start', {
        taskId,
        type: args.type,
        conflictPolicy,
        sourceConnectionId:
          args.type === 'remote-copy' ? args.sourceConnectionId : args.connectionId,
        targetConnectionId:
          args.type === 'upload'
            ? args.connectionId
            : args.type === 'remote-copy'
              ? args.targetConnectionId
              : null,
        itemCount:
          args.type === 'upload'
            ? args.localPaths.length
            : args.type === 'download'
              ? args.remotePaths.length
              : args.sourcePaths.length
      })

      const task: TransferTaskState = {
        taskId,
        type: args.type,
        sourceConnectionId:
          args.type === 'remote-copy' ? args.sourceConnectionId : args.connectionId,
        targetConnectionId:
          args.type === 'upload'
            ? args.connectionId
            : args.type === 'remote-copy'
              ? args.targetConnectionId
              : null,
        canceled: false,
        cancel: async () => {
          task.canceled = true
          broadcastTransferEvent({
            taskId,
            type: args.type,
            stage: 'canceled',
            sourceConnectionId: task.sourceConnectionId ?? null,
            targetConnectionId: task.targetConnectionId ?? null,
            message: 'Canceled by user',
            conflictPolicy
          })
        }
      }

      transferTasks.set(taskId, task)

      void (async () => {
        try {
          if (args.type === 'upload') {
            if (!Array.isArray(args.localPaths) || args.localPaths.length === 0) {
              throw new Error('No local paths selected for upload')
            }

            task.cancel = async (): Promise<void> => {
              if (task.canceled) return
              task.canceled = true
              await getNativeWorker()
                .request<NativeSshFileMutationResult>(
                  'ssh/fs-upload-abort',
                  { taskId: task.taskId },
                  10_000
                )
                .catch((error) => console.warn('[SSH] Native transfer upload abort failed:', error))
              broadcastTransferEvent({
                taskId,
                type: task.type,
                stage: 'canceled',
                sourceConnectionId: task.sourceConnectionId ?? null,
                targetConnectionId: task.targetConnectionId ?? null,
                message: 'Canceled by user',
                conflictPolicy
              })
            }

            const result = await nativeSshFsRequest<NativeSshFileTransferResult>(
              'ssh/fs-transfer-upload',
              args.connectionId,
              {
                taskId,
                connectionId: args.connectionId,
                localPaths: args.localPaths,
                remoteDir: args.remoteDir,
                conflictPolicy
              },
              2 * 60 * 60_000
            )
            if (task.canceled) {
              return
            }
            if (!result.success) {
              throw new Error(result.error ?? 'SSH transfer upload failed')
            }
            return
          } else if (args.type === 'download') {
            if (!Array.isArray(args.remotePaths) || args.remotePaths.length === 0) {
              throw new Error('No remote paths selected for download')
            }

            task.cancel = async (): Promise<void> => {
              if (task.canceled) return
              task.canceled = true
              await getNativeWorker()
                .request<NativeSshFileMutationResult>(
                  'ssh/fs-download-abort',
                  { taskId: task.taskId },
                  10_000
                )
                .catch((error) =>
                  console.warn('[SSH] Native transfer download abort failed:', error)
                )
              broadcastTransferEvent({
                taskId,
                type: task.type,
                stage: 'canceled',
                sourceConnectionId: task.sourceConnectionId ?? null,
                targetConnectionId: task.targetConnectionId ?? null,
                message: 'Canceled by user',
                conflictPolicy
              })
            }

            const result = await nativeSshFsRequest<NativeSshFileTransferResult>(
              'ssh/fs-transfer-download',
              args.connectionId,
              {
                taskId,
                connectionId: args.connectionId,
                remotePaths: args.remotePaths,
                localDir: args.localDir,
                conflictPolicy
              },
              2 * 60 * 60_000
            )
            if (task.canceled) {
              return
            }
            if (!result.success) {
              throw new Error(result.error ?? 'SSH transfer download failed')
            }
            return
          } else {
            if (!Array.isArray(args.sourcePaths) || args.sourcePaths.length === 0) {
              throw new Error('No remote paths selected for copy')
            }

            task.cancel = async (): Promise<void> => {
              if (task.canceled) return
              task.canceled = true
              await getNativeWorker()
                .request<NativeSshFileMutationResult>(
                  'ssh/fs-remote-copy-abort',
                  { taskId: task.taskId },
                  10_000
                )
                .catch((error) => console.warn('[SSH] Native remote-copy abort failed:', error))
              broadcastTransferEvent({
                taskId,
                type: task.type,
                stage: 'canceled',
                sourceConnectionId: task.sourceConnectionId ?? null,
                targetConnectionId: task.targetConnectionId ?? null,
                message: 'Canceled by user',
                conflictPolicy
              })
            }

            const result = await nativeSshRemoteCopyRequest<NativeSshFileTransferResult>(
              'ssh/fs-transfer-remote-copy',
              args.sourceConnectionId,
              args.targetConnectionId,
              {
                taskId,
                sourcePaths: args.sourcePaths,
                targetDir: args.targetDir,
                conflictPolicy
              },
              2 * 60 * 60_000
            )
            if (task.canceled) {
              return
            }
            if (!result.success) {
              throw new Error(result.error ?? 'SSH remote copy failed')
            }
            return
          }
        } catch (err) {
          broadcastTransferEvent({
            taskId,
            type: task.type,
            stage: task.canceled ? 'canceled' : 'error',
            sourceConnectionId: task.sourceConnectionId ?? null,
            targetConnectionId: task.targetConnectionId ?? null,
            message: task.canceled ? 'Transfer canceled' : String(err),
            conflictPolicy
          })
        } finally {
          transferTasks.delete(taskId)
        }
      })()

      return { taskId }
    } catch (err) {
      transferTasks.delete(taskId)
      return { error: String(err) }
    }
  })

  registerSshMessagePackHandler<{ taskId: string }>('ssh:fs:transfer:cancel', async (args) => {
    const task = transferTasks.get(args.taskId)
    if (!task) return { error: 'Task not found' }
    try {
      logSshDebug('transfer cancel requested', {
        taskId: args.taskId,
        type: task.type,
        sourceConnectionId: task.sourceConnectionId ?? null,
        targetConnectionId: task.targetConnectionId ?? null
      })
      await task.cancel('Canceled by user')
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  registerSshMessagePackHandler<{ id: string; name?: string; sortOrder?: number }>(
    'ssh:group:update',
    async (args) => {
      try {
        await updateSshGroup(args.id, {
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
      await createSshConnection(connection)
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

      await updateSshConnection(args.id, patch)
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  registerSshMessagePackHandler<{ id: string }>('ssh:connection:delete', async (args) => {
    try {
      // Disconnect any active sessions for this connection
      for (const [sessionId, session] of sshSessions) {
        if (session.connectionId === args.id) {
          session.client.end()
          sshSessions.delete(sessionId)
        }
      }
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

  // ── Terminal Session: Connect ──

  registerSshMessagePackHandler<{ connectionId: string }>('ssh:connect', async (args) => {
    try {
      const connection = getSshConnection(args.connectionId)
      if (!connection) return { error: 'Connection not found' }

      const sessionId = `ssh-${nextSessionId++}`

      const session: SshSession = {
        id: sessionId,
        connectionId: args.connectionId,
        client: new Client(),
        shell: null,
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

            await updateSshConnection(args.connectionId, {
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

  const handleSshData = (args: { sessionId: string; data: string }): void => {
    const session = sshSessions.get(args.sessionId)
    if (session?.shell && session.status === 'connected') {
      session.shell.write(args.data)
    }
  }

  ipcMain.on(toMessagePackChannel('ssh:data'), (_event, bytes: Uint8Array) => {
    handleSshData(decodeMessagePackPayload<{ sessionId: string; data: string }>(bytes))
  })

  // ── Terminal Session: Resize PTY ──

  const handleSshResize = (args: { sessionId: string; cols: number; rows: number }): void => {
    const session = sshSessions.get(args.sessionId)
    if (session?.shell && session.status === 'connected') {
      session.shell.setWindow(args.rows, args.cols, 0, 0)
    }
  }

  ipcMain.on(toMessagePackChannel('ssh:resize'), (_event, bytes: Uint8Array) => {
    handleSshResize(
      decodeMessagePackPayload<{ sessionId: string; cols: number; rows: number }>(bytes)
    )
  })

  // ── Terminal Session: Disconnect ──

  registerSshMessagePackHandler<{ sessionId: string }>('ssh:disconnect', async (args) => {
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

  registerSshMessagePackHandler<void>('ssh:session:list', async () => {
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
  for (const session of sshSessions.values()) {
    try {
      if (session.shell) session.shell.end()
      session.client.end()
    } catch {
      // ignore
    }
  }
  sshSessions.clear()
}
