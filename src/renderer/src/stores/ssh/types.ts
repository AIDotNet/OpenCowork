// Extracted from the former monolithic ssh-store.ts; behavior unchanged.
// ── Types ──

export interface SshGroup {
  id: string
  name: string
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export interface SshConnection {
  id: string
  groupId: string | null
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey' | 'agent'
  privateKeyPath: string | null
  startupCommand: string | null
  defaultDirectory: string | null
  proxyJump: string | null
  keepAliveInterval: number
  sortOrder: number
  lastConnectedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface SshSession {
  id: string
  connectionId: string
  status: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error'
  error?: string
}

export interface SshTab {
  id: string
  type: 'terminal' | 'file'
  sessionId: string | null
  connectionId: string
  connectionName: string
  title: string
  surface?: 'bottom' | 'right'
  projectId?: string | null
  filePath?: string
  status?: 'connecting' | 'connected' | 'error'
  error?: string
}

export interface SshFileEntry {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink'
  size: number
  modifyTime: number
}

export interface SshSessionFile {
  path: string
  name: string
}

export type SshWorkspaceSection =
  | 'hosts'
  | 'keychain'
  | 'forwarding'
  | 'snippets'
  | 'knownHosts'
  | 'logs'
  | 'sftp'
  | 'terminal'

export type SshUploadStage = 'upload' | 'cleanup' | 'done' | 'error' | 'canceled'

export type SshUploadProgress = {
  current?: number
  total?: number
  percent?: number
}

export type SshUploadTask = {
  taskId: string
  connectionId: string
  stage: SshUploadStage
  progress?: SshUploadProgress
  message?: string
  updatedAt: number
}

export type SftpPaneId = 'left' | 'right'

export type SftpConflictPolicy = 'skip' | 'overwrite' | 'duplicate'

export type SftpTransferTaskType = 'upload' | 'download' | 'remote-copy'

export type SftpTransferStage =
  | 'preparing'
  | 'transferring'
  | 'cleanup'
  | 'done'
  | 'error'
  | 'canceled'

export type SftpTransferProgress = {
  currentBytes?: number
  totalBytes?: number
  percent?: number
  processedItems?: number
  totalItems?: number
}

export type SftpTransferTask = {
  taskId: string
  type: SftpTransferTaskType
  stage: SftpTransferStage
  sourceConnectionId?: string | null
  targetConnectionId?: string | null
  progress?: SftpTransferProgress
  message?: string
  currentItem?: string
  updatedAt: number
  conflictPolicy?: SftpConflictPolicy
}

export type SftpConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error'

export type SftpConnectionState = {
  status: SftpConnectionStatus
  error?: string
  homeDir?: string | null
  lastConnectedAt?: number
}

export type SftpPaneState = {
  connectionId: string | null
  currentPath: string | null
}

export type SftpInspectorTab = 'details' | 'tasks'

export interface SshGroupRow {
  id: string
  name: string
  sort_order: number
  created_at: number
  updated_at: number
}

export interface SshConnectionRow {
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

export function rowToGroup(row: SshGroupRow): SshGroup {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function rowToConnection(row: SshConnectionRow): SshConnection {
  return {
    id: row.id,
    groupId: row.group_id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    authType: row.auth_type as SshConnection['authType'],
    privateKeyPath: row.private_key_path,
    startupCommand: row.startup_command,
    defaultDirectory: row.default_directory,
    proxyJump: row.proxy_jump,
    keepAliveInterval: row.keep_alive_interval,
    sortOrder: row.sort_order,
    lastConnectedAt: row.last_connected_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function renameTabTitle(title: string, previousName: string, nextName: string): string {
  if (!previousName || previousName === nextName) return title
  if (title === previousName) return nextName
  if (title.startsWith(`${previousName} (`)) return `${nextName}${title.slice(previousName.length)}`
  return title
}
