import { getNativeWorker } from '../lib/native-worker'

// ── SSH Groups ──

export interface SshGroupRow {
  id: string
  name: string
  sort_order: number
  created_at: number
  updated_at: number
}

interface SshMutationResult {
  success: boolean
  changed: number
  error?: string | null
}

interface SshConnectionFindResult {
  success: boolean
  connection?: SshConnectionRow | null
  error?: string | null
}

function assertMutation(result: SshMutationResult, operation: string): void {
  if (!result.success) {
    throw new Error(result.error || `Native SSH ${operation} failed`)
  }
}

export function listSshGroups(): Promise<SshGroupRow[]> {
  return getNativeWorker().request<SshGroupRow[]>('db/ssh-groups-list', {}, 120_000)
}

export async function createSshGroup(group: {
  id: string
  name: string
  sortOrder?: number
  createdAt: number
  updatedAt: number
}): Promise<void> {
  const result = await getNativeWorker().request<SshMutationResult>(
    'db/ssh-groups-create',
    group,
    120_000
  )
  assertMutation(result, 'group create')
}

export async function updateSshGroup(
  id: string,
  patch: Partial<{ name: string; sortOrder: number; updatedAt: number }>
): Promise<void> {
  const result = await getNativeWorker().request<SshMutationResult>(
    'db/ssh-groups-update',
    { id, patch },
    120_000
  )
  assertMutation(result, 'group update')
}

export async function deleteSshGroup(id: string): Promise<void> {
  const result = await getNativeWorker().request<SshMutationResult>(
    'db/ssh-groups-delete',
    { id },
    120_000
  )
  assertMutation(result, 'group delete')
}

// ── SSH Connections ──

export interface SshConnectionRow {
  id: string
  group_id: string | null
  name: string
  host: string
  port: number
  username: string
  auth_type: string
  encrypted_password: string | null
  private_key_path: string | null
  encrypted_passphrase: string | null
  startup_command: string | null
  default_directory: string | null
  proxy_jump: string | null
  keep_alive_interval: number
  sort_order: number
  last_connected_at: number | null
  created_at: number
  updated_at: number
}

export function listSshConnections(): Promise<SshConnectionRow[]> {
  return getNativeWorker().request<SshConnectionRow[]>('db/ssh-connections-list', {}, 120_000)
}

export async function getSshConnection(id: string): Promise<SshConnectionRow | undefined> {
  const result = await getNativeWorker().request<SshConnectionFindResult>(
    'db/ssh-connections-get',
    { id },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native SSH connection get failed')
  }
  return result.connection ?? undefined
}

export async function createSshConnection(conn: {
  id: string
  groupId?: string
  name: string
  host: string
  port?: number
  username: string
  authType?: string
  encryptedPassword?: string
  privateKeyPath?: string
  encryptedPassphrase?: string
  startupCommand?: string
  defaultDirectory?: string
  proxyJump?: string
  keepAliveInterval?: number
  sortOrder?: number
  createdAt: number
  updatedAt: number
}): Promise<void> {
  const result = await getNativeWorker().request<SshMutationResult>(
    'db/ssh-connections-create',
    conn,
    120_000
  )
  assertMutation(result, 'connection create')
}

export async function updateSshConnection(
  id: string,
  patch: Partial<{
    groupId: string | null
    name: string
    host: string
    port: number
    username: string
    authType: string
    encryptedPassword: string | null
    privateKeyPath: string | null
    encryptedPassphrase: string | null
    startupCommand: string | null
    defaultDirectory: string | null
    proxyJump: string | null
    keepAliveInterval: number
    sortOrder: number
    lastConnectedAt: number | null
    updatedAt: number
  }>
): Promise<void> {
  const result = await getNativeWorker().request<SshMutationResult>(
    'db/ssh-connections-update',
    { id, patch },
    120_000
  )
  assertMutation(result, 'connection update')
}

export async function deleteSshConnection(id: string): Promise<void> {
  const result = await getNativeWorker().request<SshMutationResult>(
    'db/ssh-connections-delete',
    { id },
    120_000
  )
  assertMutation(result, 'connection delete')
}
