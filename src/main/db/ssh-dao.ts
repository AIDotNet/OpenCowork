import { getDb } from './database'

// ── SSH Groups ──

export interface SshGroupRow {
  id: string
  name: string
  sort_order: number
  created_at: number
  updated_at: number
}

export function listSshGroups(): SshGroupRow[] {
  const db = getDb()
  return db.prepare('SELECT * FROM ssh_groups ORDER BY sort_order ASC').all() as SshGroupRow[]
}

export function createSshGroup(group: {
  id: string
  name: string
  sortOrder?: number
  createdAt: number
  updatedAt: number
}): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO ssh_groups (id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(group.id, group.name, group.sortOrder ?? 0, group.createdAt, group.updatedAt)
}

export function updateSshGroup(
  id: string,
  patch: Partial<{ name: string; sortOrder: number; updatedAt: number }>
): void {
  const db = getDb()
  const sets: string[] = []
  const values: unknown[] = []

  if (patch.name !== undefined) { sets.push('name = ?'); values.push(patch.name) }
  if (patch.sortOrder !== undefined) { sets.push('sort_order = ?'); values.push(patch.sortOrder) }
  if (patch.updatedAt !== undefined) { sets.push('updated_at = ?'); values.push(patch.updatedAt) }

  if (sets.length === 0) return
  values.push(id)
  db.prepare(`UPDATE ssh_groups SET ${sets.join(', ')} WHERE id = ?`).run(...values)
}

export function deleteSshGroup(id: string): void {
  const db = getDb()
  // Unlink connections first (set group_id to null)
  db.prepare('UPDATE ssh_connections SET group_id = NULL WHERE group_id = ?').run(id)
  db.prepare('DELETE FROM ssh_groups WHERE id = ?').run(id)
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

export function listSshConnections(): SshConnectionRow[] {
  const db = getDb()
  return db
    .prepare('SELECT * FROM ssh_connections ORDER BY sort_order ASC')
    .all() as SshConnectionRow[]
}

export function getSshConnection(id: string): SshConnectionRow | undefined {
  const db = getDb()
  return db
    .prepare('SELECT * FROM ssh_connections WHERE id = ?')
    .get(id) as SshConnectionRow | undefined
}

export function createSshConnection(conn: {
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
}): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO ssh_connections
       (id, group_id, name, host, port, username, auth_type,
        encrypted_password, private_key_path, encrypted_passphrase,
        startup_command, default_directory, proxy_jump,
        keep_alive_interval, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    conn.id,
    conn.groupId ?? null,
    conn.name,
    conn.host,
    conn.port ?? 22,
    conn.username,
    conn.authType ?? 'password',
    conn.encryptedPassword ?? null,
    conn.privateKeyPath ?? null,
    conn.encryptedPassphrase ?? null,
    conn.startupCommand ?? null,
    conn.defaultDirectory ?? null,
    conn.proxyJump ?? null,
    conn.keepAliveInterval ?? 60,
    conn.sortOrder ?? 0,
    conn.createdAt,
    conn.updatedAt
  )
}

export function updateSshConnection(
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
): void {
  const db = getDb()
  const sets: string[] = []
  const values: unknown[] = []

  if (patch.groupId !== undefined) { sets.push('group_id = ?'); values.push(patch.groupId) }
  if (patch.name !== undefined) { sets.push('name = ?'); values.push(patch.name) }
  if (patch.host !== undefined) { sets.push('host = ?'); values.push(patch.host) }
  if (patch.port !== undefined) { sets.push('port = ?'); values.push(patch.port) }
  if (patch.username !== undefined) { sets.push('username = ?'); values.push(patch.username) }
  if (patch.authType !== undefined) { sets.push('auth_type = ?'); values.push(patch.authType) }
  if (patch.encryptedPassword !== undefined) { sets.push('encrypted_password = ?'); values.push(patch.encryptedPassword) }
  if (patch.privateKeyPath !== undefined) { sets.push('private_key_path = ?'); values.push(patch.privateKeyPath) }
  if (patch.encryptedPassphrase !== undefined) { sets.push('encrypted_passphrase = ?'); values.push(patch.encryptedPassphrase) }
  if (patch.startupCommand !== undefined) { sets.push('startup_command = ?'); values.push(patch.startupCommand) }
  if (patch.defaultDirectory !== undefined) { sets.push('default_directory = ?'); values.push(patch.defaultDirectory) }
  if (patch.proxyJump !== undefined) { sets.push('proxy_jump = ?'); values.push(patch.proxyJump) }
  if (patch.keepAliveInterval !== undefined) { sets.push('keep_alive_interval = ?'); values.push(patch.keepAliveInterval) }
  if (patch.sortOrder !== undefined) { sets.push('sort_order = ?'); values.push(patch.sortOrder) }
  if (patch.lastConnectedAt !== undefined) { sets.push('last_connected_at = ?'); values.push(patch.lastConnectedAt) }
  if (patch.updatedAt !== undefined) { sets.push('updated_at = ?'); values.push(patch.updatedAt) }

  if (sets.length === 0) return
  values.push(id)
  db.prepare(`UPDATE ssh_connections SET ${sets.join(', ')} WHERE id = ?`).run(...values)
}

export function deleteSshConnection(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM ssh_connections WHERE id = ?').run(id)
}
