import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  getSshConfigSnapshot,
  setSshConfigSnapshot,
  type SshConfigConnection,
  type SshConfigData,
  type SshConfigGroup
} from './ssh-config'

export type SshImportSource = 'open-cowork' | 'openssh'
export type SshImportAction = 'create' | 'skip' | 'replace' | 'duplicate'

export interface SshExportPayload {
  schemaVersion: 1
  source: 'open-cowork-ssh'
  exportedAt: number
  groups: SshConfigGroup[]
  connections: SshConfigConnection[]
}

export interface SshImportPreviewConnection {
  importId: string
  source: SshImportSource
  name: string
  host: string
  port: number
  username: string
  authType: SshConfigConnection['authType']
  groupName: string | null
  privateKeyPath: string | null
  proxyJump: string | null
  startupCommand: string | null
  defaultDirectory: string | null
  keepAliveInterval: number | null
  password: string | null
  passphrase: string | null
  hasKnownHost: boolean
  needsPrivateKeyReview: boolean
  warnings: string[]
  conflictConnectionId: string | null
  conflictConnectionName: string | null
  defaultAction: SshImportAction
}

export interface SshImportPreviewResult {
  source: SshImportSource
  filePath: string
  connectionCount: number
  groups: string[]
  warnings: string[]
  connections: SshImportPreviewConnection[]
}

export interface SshImportApplyResult {
  imported: number
  replaced: number
  duplicated: number
  skipped: number
  warnings: string[]
}

type ParsedImportConnection = Omit<
  SshImportPreviewConnection,
  'conflictConnectionId' | 'conflictConnectionName' | 'defaultAction'
>

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function toAuthType(value: unknown): SshConfigConnection['authType'] {
  if (value === 'privateKey' || value === 'agent' || value === 'password') return value
  return 'password'
}

function normalizeGroup(raw: unknown): SshConfigGroup | null {
  if (!isRecord(raw)) return null
  const id = toStringOrNull(raw.id)
  const name = toStringOrNull(raw.name)
  if (!id || !name) return null
  const createdAt = toNumber(raw.createdAt, Date.now())
  const updatedAt = toNumber(raw.updatedAt, createdAt)
  return {
    id,
    name,
    sortOrder: toNumber(raw.sortOrder, 0),
    createdAt,
    updatedAt
  }
}

function normalizeConnection(raw: unknown): SshConfigConnection | null {
  if (!isRecord(raw)) return null
  const id = toStringOrNull(raw.id)
  const name = toStringOrNull(raw.name)
  const host = toStringOrNull(raw.host)
  const username = toStringOrNull(raw.username)
  if (!id || !name || !host || !username) return null
  const createdAt = toNumber(raw.createdAt, Date.now())
  const updatedAt = toNumber(raw.updatedAt, createdAt)
  return {
    id,
    groupId: toStringOrNull(raw.groupId),
    name,
    host,
    port: toNumber(raw.port, 22),
    username,
    authType: toAuthType(raw.authType),
    password: toStringOrNull(raw.password),
    privateKeyPath: toStringOrNull(raw.privateKeyPath),
    passphrase: toStringOrNull(raw.passphrase),
    startupCommand: toStringOrNull(raw.startupCommand),
    defaultDirectory: toStringOrNull(raw.defaultDirectory),
    proxyJump: toStringOrNull(raw.proxyJump),
    keepAliveInterval: toNumber(raw.keepAliveInterval, 60),
    sortOrder: toNumber(raw.sortOrder, 0),
    lastConnectedAt: typeof raw.lastConnectedAt === 'number' ? raw.lastConnectedAt : null,
    createdAt,
    updatedAt
  }
}

function buildImportId(
  index: number,
  connection: Pick<SshConfigConnection, 'name' | 'host' | 'port' | 'username'>
): string {
  return `${index}:${connection.name}:${connection.host}:${connection.port}:${connection.username}`
}

function cloneConfig(config: SshConfigData): SshConfigData {
  return {
    groups: config.groups.map((group) => ({ ...group })),
    connections: config.connections.map((connection) => ({ ...connection }))
  }
}

function nextId(prefix: 'sshg' | 'sshc'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function loadJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
}

function buildKnownHostsSet(configPath: string): Set<string> {
  const knownHosts = new Set<string>()
  const paths = [
    path.join(path.dirname(configPath), 'known_hosts'),
    path.join(os.homedir(), '.ssh', 'known_hosts')
  ]

  for (const knownHostsPath of paths) {
    if (!fs.existsSync(knownHostsPath)) continue
    const text = fs.readFileSync(knownHostsPath, 'utf-8')
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const hostField = line.split(/\s+/)[0]
      if (!hostField || hostField.startsWith('|1|')) continue
      for (const entry of hostField.split(',')) {
        const normalized = entry.trim()
        if (normalized) knownHosts.add(normalized)
      }
    }
  }

  return knownHosts
}

function hasKnownHostRecord(knownHosts: Set<string>, host: string, port: number): boolean {
  return knownHosts.has(host) || knownHosts.has(`[${host}]:${port}`)
}

function parseOpenCoworkFile(filePath: string): {
  groups: SshConfigGroup[]
  connections: SshConfigConnection[]
  warnings: string[]
} {
  const raw = loadJson(filePath)
  const warnings: string[] = []

  if (isRecord(raw) && raw.source === 'open-cowork-ssh') {
    const groups = Array.isArray(raw.groups) ? raw.groups.map(normalizeGroup).filter(Boolean) : []
    const connections = Array.isArray(raw.connections)
      ? raw.connections.map(normalizeConnection).filter(Boolean)
      : []
    return {
      groups: groups as SshConfigGroup[],
      connections: connections as SshConfigConnection[],
      warnings
    }
  }

  if (isRecord(raw) && isRecord(raw.ssh)) {
    warnings.push('Detected original OpenCoWork config structure, imported as SSH segments.')
    const groups = Array.isArray(raw.ssh.groups)
      ? raw.ssh.groups.map(normalizeGroup).filter(Boolean)
      : []
    const connections = Array.isArray(raw.ssh.connections)
      ? raw.ssh.connections.map(normalizeConnection).filter(Boolean)
      : []
    return {
      groups: groups as SshConfigGroup[],
      connections: connections as SshConfigConnection[],
      warnings
    }
  }

  throw new Error('Unsupported OpenCoWork SSH import file')
}

function isExactHostPattern(pattern: string): boolean {
  return !pattern.startsWith('!') && !/[?*]/.test(pattern)
}

function expandHomePath(input: string): string {
  if (input === '~') return os.homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2))
  }
  return input
}

function parseOpenSshConfig(filePath: string): {
  connections: ParsedImportConnection[]
  warnings: string[]
} {
  const text = fs.readFileSync(filePath, 'utf-8')
  const warnings: string[] = []
  const defaults = new Map<string, string>()
  const entries: Array<{ alias: string; options: Map<string, string>; line: number }> = []

  let currentPatterns: string[] | null = null
  let currentOptions = new Map<string, string>()
  let currentLine = 1

  const flush = (): void => {
    if (!currentPatterns || currentPatterns.length === 0) return

    if (currentPatterns.length === 1 && currentPatterns[0] === '*') {
      for (const [key, value] of currentOptions.entries()) {
        defaults.set(key, value)
      }
      currentPatterns = null
      currentOptions = new Map()
      return
    }

    const exactPatterns = currentPatterns.filter(isExactHostPattern)
    const ignoredPatterns = currentPatterns.filter((pattern) => !isExactHostPattern(pattern))
    if (ignoredPatterns.length > 0) {
      warnings.push(`Ignored wildcard Host pattern: ${ignoredPatterns.join(', ')}`)
    }

    for (const alias of exactPatterns) {
      const options = new Map(defaults)
      for (const [key, value] of currentOptions.entries()) {
        options.set(key, value)
      }
      entries.push({ alias, options, line: currentLine })
    }

    currentPatterns = null
    currentOptions = new Map()
  }

  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const includeMatch = trimmed.match(/^Include\s+(.+)$/i)
    if (includeMatch) {
      warnings.push(`OpenSSH Include not yet supported: ${includeMatch[1]}`)
      continue
    }

    const hostMatch = trimmed.match(/^Host\s+(.+)$/i)
    if (hostMatch) {
      flush()
      currentPatterns = hostMatch[1].split(/\s+/).filter(Boolean)
      currentLine = index + 1
      continue
    }

    const optionMatch = rawLine.match(/^\s*([A-Za-z][A-Za-z0-9]*)\s+(.*?)\s*$/)
    if (!optionMatch) continue

    const key = optionMatch[1].toLowerCase()
    const value = optionMatch[2]

    if (!currentPatterns) {
      defaults.set(key, value)
      continue
    }

    currentOptions.set(key, value)
  }

  flush()

  const knownHosts = buildKnownHostsSet(filePath)
  const connections: ParsedImportConnection[] = []

  entries.forEach((entry, index) => {
    const host = entry.options.get('hostname') ?? entry.alias
    const username = entry.options.get('user') ?? null
    if (!username) {
      warnings.push(`Host ${entry.alias} missing User, skipped.`)
      return
    }

    const port = Number.parseInt(entry.options.get('port') ?? '22', 10)
    const identityFile = entry.options.get('identityfile')
    const privateKeyPath = identityFile ? expandHomePath(identityFile) : null
    const authType: SshConfigConnection['authType'] = privateKeyPath ? 'privateKey' : 'agent'
    const rowWarnings: string[] = []

    if (!privateKeyPath) {
      rowWarnings.push('IdentityFile not found, will default to SSH Agent authentication.')
    }

    connections.push({
      importId: buildImportId(index, {
        name: entry.alias,
        host,
        port: Number.isFinite(port) ? port : 22,
        username
      }),
      source: 'openssh',
      name: entry.alias,
      host,
      port: Number.isFinite(port) ? port : 22,
      username,
      authType,
      groupName: null,
      privateKeyPath,
      proxyJump: entry.options.get('proxyjump') ?? null,
      startupCommand: null,
      defaultDirectory: null,
      keepAliveInterval: null,
      password: null,
      passphrase: null,
      hasKnownHost: hasKnownHostRecord(knownHosts, host, Number.isFinite(port) ? port : 22),
      needsPrivateKeyReview: !!privateKeyPath,
      warnings: rowWarnings
    })
  })

  return { connections, warnings }
}

function withConflicts(
  connections: ParsedImportConnection[],
  currentConfig: SshConfigData
): SshImportPreviewConnection[] {
  return connections.map((connection) => {
    const conflict = currentConfig.connections.find(
      (existing) =>
        existing.host === connection.host &&
        existing.port === connection.port &&
        existing.username === connection.username
    )

    return {
      ...connection,
      conflictConnectionId: conflict?.id ?? null,
      conflictConnectionName: conflict?.name ?? null,
      defaultAction: conflict ? 'skip' : 'create'
    }
  })
}

export function exportSshConfig(filePath: string, connectionIds?: string[]): void {
  const config = getSshConfigSnapshot()
  const selectedIds = connectionIds && connectionIds.length > 0 ? new Set(connectionIds) : null
  const connections = selectedIds
    ? config.connections.filter((connection) => selectedIds.has(connection.id))
    : config.connections.slice()
  const groupIds = new Set(connections.map((connection) => connection.groupId).filter(Boolean))
  const groups = config.groups.filter((group) => groupIds.has(group.id))
  const payload: SshExportPayload = {
    schemaVersion: 1,
    source: 'open-cowork-ssh',
    exportedAt: Date.now(),
    groups,
    connections
  }
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8')
}

export function previewSshImport(
  filePath: string,
  source: SshImportSource
): SshImportPreviewResult {
  const currentConfig = getSshConfigSnapshot()

  if (source === 'open-cowork') {
    const parsed = parseOpenCoworkFile(filePath)
    const groupMap = new Map(parsed.groups.map((group) => [group.id, group.name]))
    const connections = parsed.connections.map((connection, index) => {
      const warnings = [...parsed.warnings]
      if (connection.privateKeyPath) {
        warnings.push(
          'Private key path is from old machine, please verify it is still valid after import.'
        )
      }
      if (connection.groupId && !groupMap.has(connection.groupId)) {
        warnings.push(
          'Group ID cannot be matched, will rebuild by name or fallback to ungrouped during import.'
        )
      }
      return {
        importId: buildImportId(index, connection),
        source: 'open-cowork' as const,
        name: connection.name,
        host: connection.host,
        port: connection.port,
        username: connection.username,
        authType: connection.authType,
        groupName: connection.groupId ? (groupMap.get(connection.groupId) ?? null) : null,
        privateKeyPath: connection.privateKeyPath,
        proxyJump: connection.proxyJump,
        startupCommand: connection.startupCommand,
        defaultDirectory: connection.defaultDirectory,
        keepAliveInterval: connection.keepAliveInterval,
        password: connection.password,
        passphrase: connection.passphrase,
        hasKnownHost: false,
        needsPrivateKeyReview: !!connection.privateKeyPath,
        warnings
      }
    })

    return {
      source,
      filePath,
      connectionCount: connections.length,
      groups: parsed.groups.map((group) => group.name),
      warnings: parsed.warnings,
      connections: withConflicts(connections, currentConfig)
    }
  }

  const parsed = parseOpenSshConfig(filePath)
  const groupNames = Array.from(
    new Set(
      parsed.connections
        .map((connection) => connection.groupName)
        .filter((groupName): groupName is string => Boolean(groupName))
    )
  )
  return {
    source,
    filePath,
    connectionCount: parsed.connections.length,
    groups: groupNames,
    warnings: parsed.warnings,
    connections: withConflicts(parsed.connections, currentConfig)
  }
}

function ensureGroupByName(
  nextConfig: SshConfigData,
  groupName: string | null,
  now: number
): string | null {
  if (!groupName) return null
  const existing = nextConfig.groups.find((group) => group.name === groupName)
  if (existing) return existing.id
  const nextSortOrder =
    nextConfig.groups.length > 0
      ? Math.max(...nextConfig.groups.map((group) => group.sortOrder)) + 1
      : 1
  const group: SshConfigGroup = {
    id: nextId('sshg'),
    name: groupName,
    sortOrder: nextSortOrder,
    createdAt: now,
    updatedAt: now
  }
  nextConfig.groups.push(group)
  return group.id
}

function createImportedConnection(
  nextConfig: SshConfigData,
  connection: SshImportPreviewConnection,
  now: number,
  groupId: string | null
): SshConfigConnection {
  const nextSortOrder =
    nextConfig.connections.length > 0
      ? Math.max(...nextConfig.connections.map((item) => item.sortOrder)) + 1
      : 1

  return {
    id: nextId('sshc'),
    groupId,
    name: connection.name,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    authType: connection.authType,
    password: connection.password,
    privateKeyPath: connection.privateKeyPath,
    passphrase: connection.passphrase,
    startupCommand: connection.startupCommand,
    defaultDirectory: connection.defaultDirectory,
    proxyJump: connection.proxyJump,
    keepAliveInterval: connection.keepAliveInterval ?? 60,
    sortOrder: nextSortOrder,
    lastConnectedAt: null,
    createdAt: now,
    updatedAt: now
  }
}

function createDuplicateName(nextConfig: SshConfigData, baseName: string): string {
  let candidate = `${baseName} (Imported)`
  let index = 2
  const names = new Set(nextConfig.connections.map((connection) => connection.name))
  while (names.has(candidate)) {
    candidate = `${baseName} (Imported ${index})`
    index += 1
  }
  return candidate
}

export function applySshImport(
  filePath: string,
  source: SshImportSource,
  decisions: Array<{ importId: string; action: SshImportAction }>
): SshImportApplyResult {
  const preview = previewSshImport(filePath, source)
  const decisionMap = new Map(decisions.map((item) => [item.importId, item.action]))
  const currentConfig = getSshConfigSnapshot()
  const nextConfig = cloneConfig(currentConfig)
  const result: SshImportApplyResult = {
    imported: 0,
    replaced: 0,
    duplicated: 0,
    skipped: 0,
    warnings: []
  }
  const now = Date.now()

  for (const connection of preview.connections) {
    const action = decisionMap.get(connection.importId) ?? connection.defaultAction
    const groupId = ensureGroupByName(nextConfig, connection.groupName, now)

    if (action === 'skip') {
      result.skipped += 1
      continue
    }

    if (action === 'replace' && connection.conflictConnectionId) {
      const targetIndex = nextConfig.connections.findIndex(
        (item) => item.id === connection.conflictConnectionId
      )
      if (targetIndex >= 0) {
        const existing = nextConfig.connections[targetIndex]
        if (source === 'open-cowork') {
          nextConfig.connections[targetIndex] = {
            ...existing,
            groupId,
            name: connection.name,
            host: connection.host,
            port: connection.port,
            username: connection.username,
            authType: connection.authType,
            password: connection.password,
            privateKeyPath: connection.privateKeyPath,
            passphrase: connection.passphrase,
            startupCommand: connection.startupCommand,
            defaultDirectory: connection.defaultDirectory,
            proxyJump: connection.proxyJump,
            keepAliveInterval: connection.keepAliveInterval ?? existing.keepAliveInterval,
            updatedAt: now
          }
        } else {
          nextConfig.connections[targetIndex] = {
            ...existing,
            name: connection.name,
            host: connection.host,
            port: connection.port,
            username: connection.username,
            authType: connection.authType,
            privateKeyPath: connection.privateKeyPath,
            proxyJump: connection.proxyJump,
            updatedAt: now
          }
          result.warnings.push(
            `Preserved ${existing.name} startup command, default directory, heartbeat and password fields.`
          )
        }
        result.replaced += 1
        continue
      }
    }

    const nextConnection = createImportedConnection(nextConfig, connection, now, groupId)
    if (action === 'duplicate') {
      nextConnection.name = createDuplicateName(nextConfig, connection.name)
      nextConfig.connections.push(nextConnection)
      result.duplicated += 1
      continue
    }

    nextConfig.connections.push(nextConnection)
    result.imported += 1
  }

  setSshConfigSnapshot(nextConfig)
  return result
}
