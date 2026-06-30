import * as os from 'os'
import * as path from 'path'
import { getNativeWorker } from '../lib/native-worker'

export interface OpenSshHostConfig {
  host: string
  hostName?: string
  user?: string
  port?: number
  identityFile?: string
  proxyJump?: string
}

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

type NativeMutationResult = {
  success?: boolean
  error?: string
  config?: SshConfigData
}

const EMPTY_CONFIG: SshConfigData = { groups: [], connections: [] }
const SSH_CONFIG_POLL_MS = 30_000

let cachedConfig: SshConfigData = EMPTY_CONFIG
let lastSerialized = JSON.stringify(EMPTY_CONFIG)
let watcherStarted = false
let reloadTimer: NodeJS.Timeout | null = null
let initializePromise: Promise<void> | null = null
const listeners = new Set<SshConfigListener>()

function cloneConfig(config: SshConfigData): SshConfigData {
  return {
    groups: config.groups.map((group) => ({ ...group })),
    connections: config.connections.map((connection) => ({ ...connection }))
  }
}

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
  return {
    id,
    name,
    sortOrder: toNumber(value.sortOrder, 0),
    createdAt,
    updatedAt: toNumber(value.updatedAt, createdAt)
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
    updatedAt: toNumber(value.updatedAt, createdAt)
  }
}

function normalizeConfig(raw: unknown): SshConfigData {
  if (!raw || typeof raw !== 'object') return EMPTY_CONFIG
  const value = raw as Record<string, unknown>
  const groupsRaw = Array.isArray(value.groups) ? value.groups : []
  const connectionsRaw = Array.isArray(value.connections) ? value.connections : []
  const groupIds = new Set<string>()
  const connectionIds = new Set<string>()
  const groups = groupsRaw.map(normalizeGroup).filter((group): group is SshConfigGroup => {
    if (!group || groupIds.has(group.id)) return false
    groupIds.add(group.id)
    return true
  })
  const connections = connectionsRaw
    .map(normalizeConnection)
    .filter((connection): connection is SshConfigConnection => {
      if (!connection || connectionIds.has(connection.id)) return false
      connectionIds.add(connection.id)
      return true
    })
  return { groups, connections }
}

function setCache(next: SshConfigData, notify: boolean): void {
  const normalized = normalizeConfig(next)
  const serialized = JSON.stringify(normalized)
  cachedConfig = normalized
  if (serialized === lastSerialized) return
  lastSerialized = serialized
  if (notify) {
    listeners.forEach((listener) => listener(cloneConfig(normalized)))
  }
}

async function nativeRequest<T>(
  method: string,
  params: unknown = {},
  timeoutMs = 60_000
): Promise<T> {
  return await getNativeWorker().request<T>(method, params, timeoutMs)
}

async function refreshFromNative(notify: boolean): Promise<void> {
  const snapshot = await nativeRequest<SshConfigData>('ssh/config-snapshot')
  setCache(snapshot, notify)
}

async function applyMutation(method: string, params: unknown, timeoutMs = 60_000): Promise<void> {
  const result = await nativeRequest<NativeMutationResult>(method, params, timeoutMs)
  if (result?.error || result?.success === false) {
    throw new Error(result.error || `${method} failed`)
  }
  if (result?.config) {
    setCache(result.config, true)
  } else {
    await refreshFromNative(true)
  }
}

export async function initializeSshConfigCache(): Promise<void> {
  if (!initializePromise) {
    initializePromise = refreshFromNative(false).finally(() => {
      initializePromise = null
    })
  }
  await initializePromise
}

export function startSshConfigWatcher(): void {
  if (watcherStarted) return
  watcherStarted = true
  void initializeSshConfigCache().catch((error) => {
    console.warn('[SSH Config] Initial native load failed:', error)
  })
  reloadTimer = setInterval(() => {
    void refreshFromNative(true).catch((error) => {
      console.warn('[SSH Config] Native refresh failed:', error)
    })
  }, SSH_CONFIG_POLL_MS)
  reloadTimer.unref?.()
}

export function stopSshConfigWatcher(): void {
  if (reloadTimer) {
    clearInterval(reloadTimer)
    reloadTimer = null
  }
  watcherStarted = false
}

export function onSshConfigChange(listener: SshConfigListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getSshConfigPath(): string {
  return path.join(os.homedir(), '.open-cowork.json')
}

export async function getOpenSshHostConfig(
  alias: string,
  configPath = path.join(os.homedir(), '.ssh', 'config')
): Promise<OpenSshHostConfig | null> {
  const normalizedAlias = alias.trim()
  if (!normalizedAlias) return null
  return await nativeRequest<OpenSshHostConfig | null>('ssh/config-openssh-host', {
    alias: normalizedAlias,
    configPath
  })
}

export function getSshConfigSnapshot(): SshConfigData {
  return cloneConfig(cachedConfig)
}

export async function setSshConfigSnapshot(data: SshConfigData): Promise<void> {
  await applyMutation('ssh/config-write-snapshot', normalizeConfig(data))
}

export function listSshGroups(): SshConfigGroup[] {
  return getSshConfigSnapshot().groups.sort((a, b) => a.sortOrder - b.sortOrder)
}

export function listSshConnections(): SshConfigConnection[] {
  return getSshConfigSnapshot().connections.sort((a, b) => a.sortOrder - b.sortOrder)
}

export function getSshConnection(id: string): SshConfigConnection | undefined {
  return getSshConfigSnapshot().connections.find((connection) => connection.id === id)
}

export async function createSshGroup(group: SshConfigGroup): Promise<void> {
  await applyMutation('ssh/config-group-create', group)
}

export async function updateSshGroup(
  id: string,
  patch: Partial<Pick<SshConfigGroup, 'name' | 'sortOrder' | 'updatedAt'>>
): Promise<void> {
  await applyMutation('ssh/config-group-update', { id, patch })
}

export async function deleteSshGroup(id: string): Promise<void> {
  await applyMutation('ssh/config-group-delete', { id })
}

export async function createSshConnection(connection: SshConfigConnection): Promise<void> {
  await applyMutation('ssh/config-connection-create', connection)
}

export async function updateSshConnection(
  id: string,
  patch: Partial<Omit<SshConfigConnection, 'id'>>
): Promise<void> {
  await applyMutation('ssh/config-connection-update', { id, patch })
}

export async function deleteSshConnection(id: string): Promise<void> {
  await applyMutation('ssh/config-connection-delete', { id })
}
