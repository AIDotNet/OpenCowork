import { safeStorage } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { SshAuthType } from '../../shared/ssh/contract'
import {
  listSshGroups as daoListGroups,
  createSshGroup as daoCreateGroup,
  updateSshGroup as daoUpdateGroup,
  deleteSshGroup as daoDeleteGroup,
  listSshConnections as daoListConnections,
  createSshConnection as daoCreateConnection,
  updateSshConnection as daoUpdateConnection,
  deleteSshConnection as daoDeleteConnection,
  type SshConnectionRow,
  type SshGroupRow
} from '../db/ssh-dao'

// SSH config repository: the only owner of saved connections and their
// secrets. Persistence goes through the native worker's SQLite (db/ssh-*);
// secrets are encrypted here with Electron safeStorage before they leave the
// main process, so the sidecar and the database only ever see ciphertext.
// Decryption happens on demand (connect / native payload injection) and
// plaintext secrets are never sent to the renderer.

export interface SshGroup {
  id: string
  name: string
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export interface SshConnectionMeta {
  id: string
  groupId: string | null
  name: string
  host: string
  port: number
  username: string
  authType: SshAuthType
  privateKeyPath: string | null
  startupCommand: string | null
  defaultDirectory: string | null
  proxyJump: string | null
  keepAliveInterval: number
  sortOrder: number
  lastConnectedAt: number | null
  createdAt: number
  updatedAt: number
  hasPassword: boolean
  hasPassphrase: boolean
}

export interface SshConnectionWithSecrets extends SshConnectionMeta {
  password: string | null
  passphrase: string | null
}

export interface SshConnectionInput {
  id: string
  groupId?: string | null
  name: string
  host: string
  port?: number
  username: string
  authType?: SshAuthType
  password?: string | null
  privateKeyPath?: string | null
  passphrase?: string | null
  startupCommand?: string | null
  defaultDirectory?: string | null
  proxyJump?: string | null
  keepAliveInterval?: number
  sortOrder?: number
}

// Secrets: undefined = keep as stored, null = clear, string = replace.
export type SshConnectionPatch = Partial<Omit<SshConnectionInput, 'id'>> & {
  lastConnectedAt?: number | null
}

// ── Secret codec ──

const SECRET_SAFE_PREFIX = 'v1:safe:'
const SECRET_PLAIN_PREFIX = 'v1:plain:'

export function isSecretEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function encodeSecret(plain: string): string {
  if (isSecretEncryptionAvailable()) {
    return SECRET_SAFE_PREFIX + safeStorage.encryptString(plain).toString('base64')
  }
  console.warn('[SSH Repository] OS secret encryption unavailable, falling back to plain storage')
  return SECRET_PLAIN_PREFIX + Buffer.from(plain, 'utf-8').toString('base64')
}

function decodeSecret(stored: string | null): string | null {
  if (!stored) return null
  if (stored.startsWith(SECRET_SAFE_PREFIX)) {
    try {
      const payload = Buffer.from(stored.slice(SECRET_SAFE_PREFIX.length), 'base64')
      return safeStorage.decryptString(payload)
    } catch (err) {
      console.warn('[SSH Repository] Failed to decrypt stored secret:', err)
      return null
    }
  }
  if (stored.startsWith(SECRET_PLAIN_PREFIX)) {
    return Buffer.from(stored.slice(SECRET_PLAIN_PREFIX.length), 'base64').toString('utf-8')
  }
  // Values written before the encrypted store existed are raw plaintext.
  return stored
}

// ── Cache ──

interface CachedConnection {
  meta: SshConnectionMeta
  encryptedPassword: string | null
  encryptedPassphrase: string | null
}

let groupsCache: SshGroup[] = []
let connectionsCache = new Map<string, CachedConnection>()
let initializePromise: Promise<void> | null = null
const listeners = new Set<() => void>()

function toAuthType(value: string | null | undefined): SshAuthType {
  return value === 'privateKey' || value === 'agent' || value === 'password' ? value : 'password'
}

function fromGroupRow(row: SshGroupRow): SshGroup {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order ?? 0,
    createdAt: row.created_at ?? 0,
    updatedAt: row.updated_at ?? 0
  }
}

function fromConnectionRow(row: SshConnectionRow): CachedConnection {
  return {
    meta: {
      id: row.id,
      groupId: row.group_id ?? null,
      name: row.name,
      host: row.host,
      port: row.port ?? 22,
      username: row.username,
      authType: toAuthType(row.auth_type),
      privateKeyPath: row.private_key_path ?? null,
      startupCommand: row.startup_command ?? null,
      defaultDirectory: row.default_directory ?? null,
      proxyJump: row.proxy_jump ?? null,
      keepAliveInterval: row.keep_alive_interval ?? 60,
      sortOrder: row.sort_order ?? 0,
      lastConnectedAt: row.last_connected_at ?? null,
      createdAt: row.created_at ?? 0,
      updatedAt: row.updated_at ?? 0,
      hasPassword: Boolean(row.encrypted_password),
      hasPassphrase: Boolean(row.encrypted_passphrase)
    },
    encryptedPassword: row.encrypted_password ?? null,
    encryptedPassphrase: row.encrypted_passphrase ?? null
  }
}

async function reload(): Promise<void> {
  const [groupRows, connectionRows] = await Promise.all([daoListGroups(), daoListConnections()])
  groupsCache = groupRows.map(fromGroupRow).sort((a, b) => a.sortOrder - b.sortOrder)
  const next = new Map<string, CachedConnection>()
  for (const row of connectionRows) {
    const cached = fromConnectionRow(row)
    next.set(cached.meta.id, cached)
  }
  connectionsCache = next
}

function emitChange(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (err) {
      console.warn('[SSH Repository] Change listener failed:', err)
    }
  }
}

export function onSshRepositoryChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// ── Legacy migration (~/.open-cowork.json plaintext store) ──

function getLegacyConfigPath(): string {
  return path.join(os.homedir(), '.open-cowork.json')
}

type LegacyRecord = Record<string, unknown>

function legacyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function legacyNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

async function migrateLegacyJsonStore(): Promise<boolean> {
  const filePath = getLegacyConfigPath()
  let raw: string
  try {
    raw = await fs.promises.readFile(filePath, 'utf-8')
  } catch {
    return false
  }

  let parsed: LegacyRecord
  try {
    parsed = JSON.parse(raw) as LegacyRecord
  } catch (err) {
    console.warn('[SSH Repository] Legacy config unreadable, skipping migration:', err)
    return false
  }

  const groups = Array.isArray(parsed.groups) ? (parsed.groups as LegacyRecord[]) : []
  const connections = Array.isArray(parsed.connections)
    ? (parsed.connections as LegacyRecord[])
    : []
  let mutated = false

  for (const group of groups) {
    const id = legacyString(group.id)
    const name = legacyString(group.name)
    if (!id || !name || groupsCache.some((existing) => existing.id === id)) continue
    const createdAt = legacyNumber(group.createdAt, Date.now())
    await daoCreateGroup({
      id,
      name,
      sortOrder: legacyNumber(group.sortOrder, 0),
      createdAt,
      updatedAt: legacyNumber(group.updatedAt, createdAt)
    })
    mutated = true
  }

  let hadSecrets = false
  for (const connection of connections) {
    const id = legacyString(connection.id)
    const name = legacyString(connection.name)
    const host = legacyString(connection.host)
    const username = legacyString(connection.username)
    const password = legacyString(connection.password)
    const passphrase = legacyString(connection.passphrase)
    if (password || passphrase) hadSecrets = true
    if (!id || !name || !host || !username || connectionsCache.has(id)) continue
    const createdAt = legacyNumber(connection.createdAt, Date.now())
    await daoCreateConnection({
      id,
      groupId: legacyString(connection.groupId) ?? undefined,
      name,
      host,
      port: legacyNumber(connection.port, 22),
      username,
      authType: toAuthType(legacyString(connection.authType)),
      encryptedPassword: password ? encodeSecret(password) : undefined,
      privateKeyPath: legacyString(connection.privateKeyPath) ?? undefined,
      encryptedPassphrase: passphrase ? encodeSecret(passphrase) : undefined,
      startupCommand: legacyString(connection.startupCommand) ?? undefined,
      defaultDirectory: legacyString(connection.defaultDirectory) ?? undefined,
      proxyJump: legacyString(connection.proxyJump) ?? undefined,
      keepAliveInterval: legacyNumber(connection.keepAliveInterval, 60),
      sortOrder: legacyNumber(connection.sortOrder, 0),
      createdAt,
      updatedAt: legacyNumber(connection.updatedAt, createdAt)
    })
    mutated = true
  }

  if (hadSecrets) {
    // Strip plaintext secrets from the legacy file; the rest of the shape is
    // kept so anything still reading it degrades gracefully.
    const stripped = {
      ...parsed,
      connections: connections.map((connection) => ({
        ...connection,
        password: null,
        passphrase: null
      }))
    }
    try {
      await fs.promises.writeFile(filePath, JSON.stringify(stripped, null, 2), 'utf-8')
      console.log('[SSH Repository] Removed plaintext secrets from legacy config file')
    } catch (err) {
      console.warn('[SSH Repository] Failed to strip legacy config secrets:', err)
    }
  }

  return mutated
}

// ── Lifecycle ──

export async function initializeSshRepository(): Promise<void> {
  initializePromise ??= (async () => {
    await reload()
    try {
      const migrated = await migrateLegacyJsonStore()
      if (migrated) {
        await reload()
        console.log('[SSH Repository] Migrated legacy JSON config into encrypted store')
      }
    } catch (err) {
      console.warn('[SSH Repository] Legacy config migration failed:', err)
    }
  })().catch((err) => {
    initializePromise = null
    throw err
  })
  await initializePromise
}

// ── Reads (sync, from cache) ──

export function listGroups(): SshGroup[] {
  return groupsCache.map((group) => ({ ...group }))
}

export function listConnections(): SshConnectionMeta[] {
  return [...connectionsCache.values()]
    .map((cached) => ({ ...cached.meta }))
    .sort((a, b) => a.sortOrder - b.sortOrder)
}

export function getConnectionMeta(id: string): SshConnectionMeta | undefined {
  const cached = connectionsCache.get(id)
  return cached ? { ...cached.meta } : undefined
}

export function getConnectionWithSecrets(id: string): SshConnectionWithSecrets | undefined {
  const cached = connectionsCache.get(id)
  if (!cached) return undefined
  return {
    ...cached.meta,
    password: decodeSecret(cached.encryptedPassword),
    passphrase: decodeSecret(cached.encryptedPassphrase)
  }
}

// ── Mutations ──

export async function createGroup(group: {
  id: string
  name: string
  sortOrder?: number
}): Promise<void> {
  const now = Date.now()
  await daoCreateGroup({
    id: group.id,
    name: group.name,
    sortOrder: group.sortOrder ?? 0,
    createdAt: now,
    updatedAt: now
  })
  await reload()
  emitChange()
}

export async function updateGroup(
  id: string,
  patch: { name?: string; sortOrder?: number }
): Promise<void> {
  await daoUpdateGroup(id, { ...patch, updatedAt: Date.now() })
  await reload()
  emitChange()
}

export async function deleteGroup(id: string): Promise<void> {
  // Detach members first so no connection points at a missing group.
  for (const cached of connectionsCache.values()) {
    if (cached.meta.groupId === id) {
      await daoUpdateConnection(cached.meta.id, { groupId: null, updatedAt: Date.now() })
    }
  }
  await daoDeleteGroup(id)
  await reload()
  emitChange()
}

export async function createConnection(input: SshConnectionInput): Promise<void> {
  const now = Date.now()
  await daoCreateConnection({
    id: input.id,
    groupId: input.groupId ?? undefined,
    name: input.name,
    host: input.host,
    port: input.port ?? 22,
    username: input.username,
    authType: input.authType ?? 'password',
    encryptedPassword: input.password ? encodeSecret(input.password) : undefined,
    privateKeyPath: input.privateKeyPath ?? undefined,
    encryptedPassphrase: input.passphrase ? encodeSecret(input.passphrase) : undefined,
    startupCommand: input.startupCommand ?? undefined,
    defaultDirectory: input.defaultDirectory ?? undefined,
    proxyJump: input.proxyJump ?? undefined,
    keepAliveInterval: input.keepAliveInterval ?? 60,
    sortOrder: input.sortOrder ?? 0,
    createdAt: now,
    updatedAt: now
  })
  await reload()
  emitChange()
}

export async function updateConnection(id: string, patch: SshConnectionPatch): Promise<void> {
  const daoPatch: Parameters<typeof daoUpdateConnection>[1] = { updatedAt: Date.now() }
  if (patch.groupId !== undefined) daoPatch.groupId = patch.groupId
  if (patch.name !== undefined) daoPatch.name = patch.name
  if (patch.host !== undefined) daoPatch.host = patch.host
  if (patch.port !== undefined) daoPatch.port = patch.port
  if (patch.username !== undefined) daoPatch.username = patch.username
  if (patch.authType !== undefined) daoPatch.authType = patch.authType
  if (patch.password !== undefined) {
    daoPatch.encryptedPassword = patch.password ? encodeSecret(patch.password) : null
  }
  if (patch.privateKeyPath !== undefined) daoPatch.privateKeyPath = patch.privateKeyPath
  if (patch.passphrase !== undefined) {
    daoPatch.encryptedPassphrase = patch.passphrase ? encodeSecret(patch.passphrase) : null
  }
  if (patch.startupCommand !== undefined) daoPatch.startupCommand = patch.startupCommand
  if (patch.defaultDirectory !== undefined) daoPatch.defaultDirectory = patch.defaultDirectory
  if (patch.proxyJump !== undefined) daoPatch.proxyJump = patch.proxyJump
  if (patch.keepAliveInterval !== undefined) daoPatch.keepAliveInterval = patch.keepAliveInterval
  if (patch.sortOrder !== undefined) daoPatch.sortOrder = patch.sortOrder
  if (patch.lastConnectedAt !== undefined) daoPatch.lastConnectedAt = patch.lastConnectedAt
  await daoUpdateConnection(id, daoPatch)
  await reload()
  emitChange()
}

export async function deleteConnection(id: string): Promise<void> {
  await daoDeleteConnection(id)
  await reload()
  emitChange()
}
