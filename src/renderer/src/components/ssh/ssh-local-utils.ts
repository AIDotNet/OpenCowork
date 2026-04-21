import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'

export type KeychainFilter = 'key' | 'certificate' | 'touchId' | 'fido2'

export interface LocalSshFileEntry {
  name: string
  path: string
  type: 'directory' | 'file'
}

export interface LocalKeychainRecord {
  id: string
  label: string
  privateKeyPath: string | null
  publicKeyPath: string | null
  certificatePath: string | null
  privateKey: string
  publicKey: string
  certificate: string
  isFido2: boolean
  isTouchId: boolean
}

export interface KnownHostRecord {
  id: string
  hostField: string
  hosts: string[]
  keyType: string
  key: string
  marker: string | null
  rawLine: string
  lineNumber: number
  hashed: boolean
}

function getIpcError(result: unknown): string | null {
  if (result && typeof result === 'object' && 'error' in result) {
    const message = (result as { error?: string }).error
    return typeof message === 'string' && message.trim() ? message : 'Unknown error'
  }
  return null
}

export function joinFsPath(...parts: string[]): string {
  if (parts.length === 0) return ''
  const separator = parts[0]?.includes('\\') ? '\\' : '/'
  const trimTrailing = (value: string): string => {
    let next = value
    while (next.length > 1 && next.endsWith(separator)) next = next.slice(0, -1)
    return next
  }
  const trimBoth = (value: string): string => {
    let next = value
    while (next.startsWith(separator)) next = next.slice(1)
    while (next.endsWith(separator)) next = next.slice(0, -1)
    return next
  }

  return parts
    .filter(Boolean)
    .map((part, index) => {
      const normalized = separator === '\\' ? part.replace(/\//g, '\\') : part.replace(/\\/g, '/')
      return index === 0 ? trimTrailing(normalized) : trimBoth(normalized)
    })
    .join(separator)
}

export async function getLocalHomeDir(): Promise<string> {
  const result = await ipcClient.invoke(IPC.APP_HOMEDIR)
  const homeDir =
    result && typeof result === 'object' && 'path' in result
      ? String((result as { path?: string }).path ?? '')
      : String(result ?? '')

  if (!homeDir) throw new Error('Failed to resolve home directory')
  return homeDir
}

export async function ensureLocalSshDir(): Promise<string> {
  const sshDir = joinFsPath(await getLocalHomeDir(), '.ssh')
  const mkdirResult = await ipcClient.invoke(IPC.FS_MKDIR, { path: sshDir })
  const error = getIpcError(mkdirResult)
  if (error) throw new Error(error)
  return sshDir
}

export async function listLocalSshFiles(): Promise<LocalSshFileEntry[]> {
  const sshDir = await ensureLocalSshDir()
  const result = await ipcClient.invoke(IPC.FS_LIST_DIR, {
    path: sshDir,
    limit: 500
  })
  const error = getIpcError(result)
  if (error) throw new Error(error)
  return Array.isArray(result) ? (result as LocalSshFileEntry[]) : []
}

export async function readLocalTextFileSafe(path: string): Promise<string> {
  const result = await ipcClient.invoke(IPC.FS_READ_DOCUMENT, { path })
  const error = getIpcError(result)
  if (error) return ''
  return String((result as { content?: string }).content ?? '')
}

export async function writeLocalTextFile(path: string, content: string): Promise<void> {
  const result = await ipcClient.invoke(IPC.FS_WRITE_FILE, { path, content })
  const error = getIpcError(result)
  if (error) throw new Error(error)
}

export async function deleteLocalPath(path: string): Promise<void> {
  const result = await ipcClient.invoke(IPC.FS_DELETE, { path })
  const error = getIpcError(result)
  if (error) throw new Error(error)
}

function isIgnoredSshArtifact(name: string): boolean {
  const lowered = name.toLowerCase()
  return [
    'config',
    'known_hosts',
    'known_hosts.old',
    'authorized_keys',
    'authorized_keys2',
    '.ds_store'
  ].includes(lowered)
}

function isPrivateKeyName(name: string): boolean {
  const lowered = name.toLowerCase()
  return (
    lowered.startsWith('id_') ||
    lowered.endsWith('.pem') ||
    lowered.endsWith('.key') ||
    lowered.endsWith('.ppk')
  )
}

function isPrivateKeyContent(content: string): boolean {
  return /BEGIN [A-Z0-9 ]*PRIVATE KEY/.test(content)
}

function isTouchIdRecord(label: string, privateKey: string, publicKey: string): boolean {
  return /touch.?id|apple/i.test(`${label}\n${privateKey}\n${publicKey}`)
}

function isFido2Record(label: string, privateKey: string, publicKey: string): boolean {
  return /_sk($|[^a-z0-9])|sk-ssh-(ed25519|ecdsa)/i.test(`${label}\n${privateKey}\n${publicKey}`)
}

export function matchesKeychainFilter(
  record: LocalKeychainRecord,
  filter: KeychainFilter
): boolean {
  if (filter === 'certificate') return Boolean(record.certificatePath || record.certificate.trim())
  if (filter === 'touchId') return record.isTouchId
  if (filter === 'fido2') return record.isFido2
  return Boolean(
    record.privateKeyPath ||
    record.publicKeyPath ||
    record.privateKey.trim() ||
    record.publicKey.trim()
  )
}

export async function loadLocalKeychainRecords(): Promise<LocalKeychainRecord[]> {
  const files = (await listLocalSshFiles())
    .filter((item) => item.type === 'file')
    .filter((item) => !isIgnoredSshArtifact(item.name))

  const documents = await Promise.all(
    files.map(async (item) => ({
      item,
      content: await readLocalTextFileSafe(item.path)
    }))
  )

  const records = new Map<string, LocalKeychainRecord>()

  const getRecord = (label: string): LocalKeychainRecord => {
    const existing = records.get(label)
    if (existing) return existing
    const created: LocalKeychainRecord = {
      id: label,
      label,
      privateKeyPath: null,
      publicKeyPath: null,
      certificatePath: null,
      privateKey: '',
      publicKey: '',
      certificate: '',
      isFido2: false,
      isTouchId: false
    }
    records.set(label, created)
    return created
  }

  for (const { item, content } of documents) {
    if (item.name.endsWith('-cert.pub')) {
      const label = item.name.replace(/-cert\.pub$/, '')
      const record = getRecord(label)
      record.certificatePath = item.path
      record.certificate = content
      continue
    }

    if (item.name.endsWith('.pub')) {
      const label = item.name.replace(/\.pub$/, '')
      const record = getRecord(label)
      record.publicKeyPath = item.path
      record.publicKey = content
      continue
    }

    if (!isPrivateKeyName(item.name) && !isPrivateKeyContent(content)) continue

    const record = getRecord(item.name)
    record.privateKeyPath = item.path
    record.privateKey = content
  }

  return Array.from(records.values())
    .map((record) => ({
      ...record,
      isFido2: isFido2Record(record.label, record.privateKey, record.publicKey),
      isTouchId: isTouchIdRecord(record.label, record.privateKey, record.publicKey)
    }))
    .sort((left, right) => left.label.localeCompare(right.label))
}

export function parseKnownHosts(raw: string): KnownHostRecord[] {
  return raw
    .split(/\r?\n/)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => {
      const trimmed = line.trim()
      return trimmed.length > 0 && !trimmed.startsWith('#')
    })
    .map(({ line, lineNumber }) => {
      const trimmed = line.trim()
      const parts = trimmed.split(/\s+/)
      const marker = parts[0]?.startsWith('@') ? (parts.shift() ?? null) : null
      const hostField = parts.shift() ?? ''
      const keyType = parts.shift() ?? ''
      const key = parts.join(' ')
      return {
        id: `${lineNumber}:${hostField}:${keyType}`,
        hostField,
        hosts: hostField.split(',').filter(Boolean),
        keyType,
        key,
        marker,
        rawLine: line,
        lineNumber,
        hashed: hostField.startsWith('|')
      }
    })
}

export async function readKnownHostsFile(): Promise<{
  path: string
  content: string
  records: KnownHostRecord[]
}> {
  const sshDir = await ensureLocalSshDir()
  const filePath = joinFsPath(sshDir, 'known_hosts')
  const content = await readLocalTextFileSafe(filePath)
  return {
    path: filePath,
    content,
    records: parseKnownHosts(content)
  }
}
