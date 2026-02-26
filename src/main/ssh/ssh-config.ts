import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export interface SshConfigGroup {
  id: string
  name: string
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export interface SshConfigConnection {
  id: string
  groupId: string | null
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey' | 'agent'
  password: string | null
  privateKeyPath: string | null
  passphrase: string | null
  startupCommand: string | null
  defaultDirectory: string | null
  proxyJump: string | null
  keepAliveInterval: number
  sortOrder: number
  lastConnectedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface SshConfigData {
  groups: SshConfigGroup[]
  connections: SshConfigConnection[]
}

type SshConfigListener = (data: SshConfigData) => void

const CONFIG_PATH = path.join(os.homedir(), '.open-cowork.json')
const EMPTY_CONFIG: SshConfigData = { groups: [], connections: [] }

let cachedConfig: SshConfigData = EMPTY_CONFIG
let lastSerialized = JSON.stringify(EMPTY_CONFIG)
let lastGoodConfig: SshConfigData = EMPTY_CONFIG
let watcherStarted = false
let reloadTimer: NodeJS.Timeout | null = null
const listeners = new Set<SshConfigListener>()

function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function toString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function toAuthType(value: unknown): SshConfigConnection['authType'] {
  if (value === 'privateKey' || value === 'agent' || value === 'password') return value
  return 'password'
}

function normalizeGroup(raw: unknown): SshConfigGroup | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const id = toString(value.id)
  const name = toString(value.name)
  if (!id || !name) return null
  const createdAt = toNumber(value.createdAt, Date.now())
  const updatedAt = toNumber(value.updatedAt, createdAt)

  return {
    id,
    name,
    sortOrder: toNumber(value.sortOrder, 0),
    createdAt,
    updatedAt,
  }
}

function normalizeConnection(raw: unknown): SshConfigConnection | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const id = toString(value.id)
  const name = toString(value.name)
  const host = toString(value.host)
  const username = toString(value.username)
  if (!id || !name || !host || !username) return null
  const createdAt = toNumber(value.createdAt, Date.now())
  const updatedAt = toNumber(value.updatedAt, createdAt)

  return {
    id,
    groupId: toString(value.groupId),
    name,
    host,
    port: toNumber(value.port, 22),
    username,
    authType: toAuthType(value.authType),
    password: toString(value.password),
    privateKeyPath: toString(value.privateKeyPath),
    passphrase: toString(value.passphrase),
    startupCommand: toString(value.startupCommand),
    defaultDirectory: toString(value.defaultDirectory),
    proxyJump: toString(value.proxyJump),
    keepAliveInterval: toNumber(value.keepAliveInterval, 60),
    sortOrder: toNumber(value.sortOrder, 0),
    lastConnectedAt: typeof value.lastConnectedAt === 'number' ? value.lastConnectedAt : null,
    createdAt,
    updatedAt,
  }
}

function normalizeConfig(raw: unknown): SshConfigData {
  const ssh =
    raw && typeof raw === 'object' && 'ssh' in raw
      ? (raw as { ssh?: { groups?: unknown[]; connections?: unknown[] } }).ssh
      : undefined

  const groupsRaw = Array.isArray(ssh?.groups) ? ssh?.groups ?? [] : []
  const connectionsRaw = Array.isArray(ssh?.connections) ? ssh?.connections ?? [] : []

  const groups: SshConfigGroup[] = []
  const groupIds = new Set<string>()
  for (const item of groupsRaw) {
    const group = normalizeGroup(item)
    if (!group || groupIds.has(group.id)) continue
    groupIds.add(group.id)
    groups.push(group)
  }

  const connections: SshConfigConnection[] = []
  const connectionIds = new Set<string>()
  for (const item of connectionsRaw) {
    const connection = normalizeConnection(item)
    if (!connection || connectionIds.has(connection.id)) continue
    connectionIds.add(connection.id)
    connections.push(connection)
  }

  return { groups, connections }
}

function readRawConfig(): Record<string, unknown> {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {}
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    if (!raw.trim()) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Record<string, unknown>
  } catch (err) {
    console.error('[SSH Config] Failed to read:', err)
    return {}
  }
}

function readConfigFromDisk(): SshConfigData {
  if (!fs.existsSync(CONFIG_PATH)) {
    lastGoodConfig = EMPTY_CONFIG
    return EMPTY_CONFIG
  }
  try {
    const raw = readRawConfig()
    const normalized = normalizeConfig(raw)
    lastGoodConfig = normalized
    return normalized
  } catch (err) {
    console.error('[SSH Config] Failed to parse:', err)
    return lastGoodConfig
  }
}

function writeConfigToDisk(data: SshConfigData): void {
  const raw = readRawConfig()
  const next = { ...raw, ssh: { groups: data.groups, connections: data.connections } }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf-8')
}

function setCache(next: SshConfigData, notify: boolean): void {
  const serialized = JSON.stringify(next)
  cachedConfig = next
  if (serialized === lastSerialized) return
  lastSerialized = serialized
  if (!notify) return
  listeners.forEach((listener) => listener(next))
}

function scheduleReload(): void {
  if (reloadTimer) clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => {
    const next = readConfigFromDisk()
    setCache(next, true)
  }, 200)
}

export function startSshConfigWatcher(): void {
  if (watcherStarted) return
  watcherStarted = true
  fs.watchFile(CONFIG_PATH, { interval: 1000 }, () => {
    scheduleReload()
  })
}

export function onSshConfigChange(listener: SshConfigListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getSshConfigPath(): string {
  return CONFIG_PATH
}

export function getSshConfigSnapshot(): SshConfigData {
  if (lastSerialized === JSON.stringify(EMPTY_CONFIG) && cachedConfig === EMPTY_CONFIG) {
    const next = readConfigFromDisk()
    setCache(next, false)
  }
  return cachedConfig
}

export function listSshGroups(): SshConfigGroup[] {
  return getSshConfigSnapshot().groups.slice().sort((a, b) => a.sortOrder - b.sortOrder)
}

export function listSshConnections(): SshConfigConnection[] {
  return getSshConfigSnapshot().connections
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
}

export function getSshConnection(id: string): SshConfigConnection | undefined {
  return getSshConfigSnapshot().connections.find((c) => c.id === id)
}

export function createSshGroup(group: SshConfigGroup): void {
  updateSshConfig((current) => {
    const groups = current.groups.filter((g) => g.id !== group.id)
    groups.push(group)
    return { ...current, groups }
  })
}

export function updateSshGroup(
  id: string,
  patch: Partial<Pick<SshConfigGroup, 'name' | 'sortOrder' | 'updatedAt'>>
): void {
  updateSshConfig((current) => ({
    ...current,
    groups: current.groups.map((group) => {
      if (group.id !== id) return group
      return {
        ...group,
        name: patch.name ?? group.name,
        sortOrder: patch.sortOrder ?? group.sortOrder,
        updatedAt: patch.updatedAt ?? group.updatedAt,
      }
    }),
  }))
}

export function deleteSshGroup(id: string): void {
  updateSshConfig((current) => ({
    groups: current.groups.filter((group) => group.id !== id),
    connections: current.connections.map((conn) =>
      conn.groupId === id ? { ...conn, groupId: null } : conn
    ),
  }))
}

export function createSshConnection(connection: SshConfigConnection): void {
  updateSshConfig((current) => {
    const connections = current.connections.filter((c) => c.id !== connection.id)
    connections.push(connection)
    return { ...current, connections }
  })
}

export function updateSshConnection(
  id: string,
  patch: Partial<Omit<SshConfigConnection, 'id'>>
): void {
  updateSshConfig((current) => ({
    ...current,
    connections: current.connections.map((conn) => {
      if (conn.id !== id) return conn
      return {
        ...conn,
        ...patch,
        updatedAt: patch.updatedAt ?? conn.updatedAt,
      }
    }),
  }))
}

export function deleteSshConnection(id: string): void {
  updateSshConfig((current) => ({
    ...current,
    connections: current.connections.filter((conn) => conn.id !== id),
  }))
}

function updateSshConfig(updater: (current: SshConfigData) => SshConfigData): void {
  const current = readConfigFromDisk()
  const next = updater(current)
  writeConfigToDisk(next)
  setCache(next, true)
}
