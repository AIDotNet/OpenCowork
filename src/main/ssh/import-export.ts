import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type {
  SshImportAction,
  SshImportApplyResult,
  SshImportPreviewConnection,
  SshImportPreviewResult,
  SshImportSource
} from '../../shared/ssh/contract'
import {
  createConnection,
  createGroup,
  getConnectionWithSecrets,
  listConnections,
  listGroups,
  updateConnection,
  type SshConnectionInput
} from './repository'
import { listOpenSshHosts } from './openssh-config'

export type { SshImportAction, SshImportSource }

// TS reimplementation of the connection import/export that used to live in
// the native sidecar (SshConfigTransfer.cs). Operates on the repository so
// imported secrets are encrypted on write.

interface SshExportConnection {
  id: string
  groupId: string | null
  name: string
  host: string
  port: number
  username: string
  authType: string
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

interface SshExportPayload {
  schemaVersion: 1
  source: 'open-cowork-ssh'
  exportedAt: number
  groups: Array<{
    id: string
    name: string
    sortOrder: number
    createdAt: number
    updatedAt: number
  }>
  connections: SshExportConnection[]
}

export async function exportSshConfig(filePath: string, connectionIds?: string[]): Promise<void> {
  const metas = listConnections()
  const selected = connectionIds?.length
    ? metas.filter((meta) => connectionIds.includes(meta.id))
    : metas

  const connections: SshExportConnection[] = selected.map((meta) => {
    const full = getConnectionWithSecrets(meta.id)
    return {
      id: meta.id,
      groupId: meta.groupId,
      name: meta.name,
      host: meta.host,
      port: meta.port,
      username: meta.username,
      authType: meta.authType,
      password: full?.password ?? null,
      privateKeyPath: meta.privateKeyPath,
      passphrase: full?.passphrase ?? null,
      startupCommand: meta.startupCommand,
      defaultDirectory: meta.defaultDirectory,
      proxyJump: meta.proxyJump,
      keepAliveInterval: meta.keepAliveInterval,
      sortOrder: meta.sortOrder,
      lastConnectedAt: meta.lastConnectedAt,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt
    }
  })

  const usedGroupIds = new Set(connections.map((connection) => connection.groupId))
  const payload: SshExportPayload = {
    schemaVersion: 1,
    source: 'open-cowork-ssh',
    exportedAt: Date.now(),
    groups: listGroups().filter((group) => usedGroupIds.has(group.id)),
    connections
  }
  await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8')
}

// ── Preview ──

type RawRecord = Record<string, unknown>

function rawString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function rawNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function toAuthType(value: unknown): 'password' | 'privateKey' | 'agent' {
  return value === 'privateKey' || value === 'agent' || value === 'password' ? value : 'password'
}

async function hostInKnownHosts(host: string): Promise<boolean> {
  try {
    const content = await fs.promises.readFile(
      path.join(os.homedir(), '.ssh', 'known_hosts'),
      'utf-8'
    )
    const needle = host.toLowerCase()
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('|')) continue
      const hostsField = trimmed.split(/\s+/)[0]
      for (const entry of hostsField.split(',')) {
        const bare = entry
          .replace(/^\[/, '')
          .replace(/\]:\d+$/, '')
          .toLowerCase()
        if (bare === needle) return true
      }
    }
  } catch {
    // No known_hosts file — treat as unknown.
  }
  return false
}

async function buildPreviewConnection(
  source: SshImportSource,
  importId: string,
  fields: {
    name: string
    host: string
    port: number | null
    username: string | null
    authType: 'password' | 'privateKey' | 'agent'
    groupName: string | null
    privateKeyPath: string | null
    proxyJump: string | null
    startupCommand: string | null
    defaultDirectory: string | null
    keepAliveInterval: number | null
    password: string | null
    passphrase: string | null
  }
): Promise<SshImportPreviewConnection> {
  const warnings: string[] = []
  let needsPrivateKeyReview = false

  if (!fields.username) {
    warnings.push('No username specified; defaults to the current user at connect time.')
  }
  if (fields.authType === 'privateKey') {
    if (!fields.privateKeyPath) {
      needsPrivateKeyReview = true
      warnings.push('Private key auth selected but no key path provided.')
    } else {
      try {
        await fs.promises.access(fields.privateKeyPath)
      } catch {
        needsPrivateKeyReview = true
        warnings.push(`Private key file not found: ${fields.privateKeyPath}`)
      }
    }
  }

  const existing = listConnections().find((connection) => connection.name === fields.name)

  return {
    importId,
    source,
    name: fields.name,
    host: fields.host,
    port: fields.port ?? 22,
    username: fields.username ?? os.userInfo().username,
    authType: fields.authType,
    groupName: fields.groupName,
    privateKeyPath: fields.privateKeyPath,
    proxyJump: fields.proxyJump,
    startupCommand: fields.startupCommand,
    defaultDirectory: fields.defaultDirectory,
    keepAliveInterval: fields.keepAliveInterval,
    password: fields.password,
    passphrase: fields.passphrase,
    hasKnownHost: await hostInKnownHosts(fields.host),
    needsPrivateKeyReview,
    warnings,
    conflictConnectionId: existing?.id ?? null,
    conflictConnectionName: existing?.name ?? null,
    defaultAction: existing ? 'skip' : 'create'
  }
}

async function previewFromPayload(filePath: string): Promise<SshImportPreviewConnection[]> {
  const raw = await fs.promises.readFile(filePath, 'utf-8')
  const parsed = JSON.parse(raw) as RawRecord
  const connections = Array.isArray(parsed.connections) ? (parsed.connections as RawRecord[]) : []
  if (!connections.length) {
    throw new Error('No connections found in file')
  }
  const groups = Array.isArray(parsed.groups) ? (parsed.groups as RawRecord[]) : []
  const groupNameById = new Map<string, string>()
  for (const group of groups) {
    const id = rawString(group.id)
    const name = rawString(group.name)
    if (id && name) groupNameById.set(id, name)
  }

  const items: SshImportPreviewConnection[] = []
  for (const [index, connection] of connections.entries()) {
    const name = rawString(connection.name)
    const host = rawString(connection.host)
    if (!name || !host) continue
    const groupId = rawString(connection.groupId)
    items.push(
      await buildPreviewConnection('open-cowork', `open-cowork-${index}`, {
        name,
        host,
        port: rawNumber(connection.port),
        username: rawString(connection.username),
        authType: toAuthType(connection.authType),
        groupName: groupId ? (groupNameById.get(groupId) ?? null) : null,
        privateKeyPath: rawString(connection.privateKeyPath),
        proxyJump: rawString(connection.proxyJump),
        startupCommand: rawString(connection.startupCommand),
        defaultDirectory: rawString(connection.defaultDirectory),
        keepAliveInterval: rawNumber(connection.keepAliveInterval),
        password: rawString(connection.password),
        passphrase: rawString(connection.passphrase)
      })
    )
  }
  return items
}

async function previewFromOpenSsh(filePath: string): Promise<SshImportPreviewConnection[]> {
  const hosts = await listOpenSshHosts(filePath)
  if (!hosts.length) {
    throw new Error('No Host entries found in OpenSSH config')
  }
  const items: SshImportPreviewConnection[] = []
  for (const [index, host] of hosts.entries()) {
    items.push(
      await buildPreviewConnection('openssh', `openssh-${index}`, {
        name: host.host,
        host: host.hostName ?? host.host,
        port: host.port ?? null,
        username: host.user ?? null,
        authType: host.identityFile ? 'privateKey' : 'agent',
        groupName: null,
        privateKeyPath: host.identityFile ?? null,
        proxyJump: host.proxyJump ?? null,
        startupCommand: null,
        defaultDirectory: null,
        keepAliveInterval: null,
        password: null,
        passphrase: null
      })
    )
  }
  return items
}

export async function previewSshImport(
  filePath: string,
  source: SshImportSource
): Promise<SshImportPreviewResult> {
  try {
    const connections =
      source === 'openssh' ? await previewFromOpenSsh(filePath) : await previewFromPayload(filePath)
    const groups = [
      ...new Set(connections.map((connection) => connection.groupName).filter(Boolean))
    ] as string[]
    return {
      source,
      filePath,
      connectionCount: connections.length,
      groups,
      warnings: [],
      connections
    }
  } catch (err) {
    return {
      source,
      filePath,
      connectionCount: 0,
      groups: [],
      warnings: [],
      connections: [],
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

// ── Apply ──

function generateId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function uniqueConnectionName(base: string): string {
  const names = new Set(listConnections().map((connection) => connection.name))
  if (!names.has(base)) return base
  for (let index = 2; ; index += 1) {
    const candidate = `${base} (${index})`
    if (!names.has(candidate)) return candidate
  }
}

async function ensureGroupByName(name: string | null): Promise<string | null> {
  if (!name) return null
  const existing = listGroups().find((group) => group.name === name)
  if (existing) return existing.id
  const id = generateId('ssh-group')
  await createGroup({ id, name })
  return id
}

function toConnectionInput(
  item: SshImportPreviewConnection,
  id: string,
  name: string,
  groupId: string | null
): SshConnectionInput {
  return {
    id,
    groupId,
    name,
    host: item.host,
    port: item.port,
    username: item.username,
    authType: item.authType,
    password: item.password,
    privateKeyPath: item.privateKeyPath,
    passphrase: item.passphrase,
    proxyJump: item.proxyJump,
    startupCommand: item.startupCommand,
    defaultDirectory: item.defaultDirectory,
    keepAliveInterval: item.keepAliveInterval ?? 60
  }
}

export async function applySshImport(
  filePath: string,
  source: SshImportSource,
  decisions: Array<{ importId: string; action: SshImportAction }>
): Promise<SshImportApplyResult> {
  const preview = await previewSshImport(filePath, source)
  if (preview.error) {
    return {
      imported: 0,
      replaced: 0,
      duplicated: 0,
      skipped: 0,
      warnings: [],
      error: preview.error
    }
  }

  const itemsById = new Map(preview.connections.map((item) => [item.importId, item]))
  const result: SshImportApplyResult = {
    imported: 0,
    replaced: 0,
    duplicated: 0,
    skipped: 0,
    warnings: []
  }

  for (const decision of decisions) {
    const item = itemsById.get(decision.importId)
    if (!item) continue
    try {
      if (decision.action === 'skip') {
        result.skipped += 1
        continue
      }
      const groupId = await ensureGroupByName(item.groupName)
      if (decision.action === 'replace' && item.conflictConnectionId) {
        await updateConnection(item.conflictConnectionId, {
          groupId,
          host: item.host,
          port: item.port,
          username: item.username,
          authType: item.authType,
          // Only overwrite stored secrets when the import actually carries them.
          ...(item.password !== null ? { password: item.password } : {}),
          ...(item.passphrase !== null ? { passphrase: item.passphrase } : {}),
          privateKeyPath: item.privateKeyPath,
          proxyJump: item.proxyJump,
          startupCommand: item.startupCommand,
          defaultDirectory: item.defaultDirectory,
          keepAliveInterval: item.keepAliveInterval ?? 60
        })
        result.replaced += 1
        continue
      }
      if (decision.action === 'duplicate') {
        const name = uniqueConnectionName(item.name)
        await createConnection(toConnectionInput(item, generateId('ssh-conn'), name, groupId))
        result.duplicated += 1
        continue
      }
      await createConnection(toConnectionInput(item, generateId('ssh-conn'), item.name, groupId))
      result.imported += 1
    } catch (err) {
      result.warnings.push(`${item.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return result
}
