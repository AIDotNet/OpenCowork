import { getNativeWorker } from '../lib/native-worker'
import type { SshConfigConnection, SshConfigGroup } from './ssh-config'

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
  error?: string
}

export interface SshImportApplyResult {
  imported: number
  replaced: number
  duplicated: number
  skipped: number
  warnings: string[]
  error?: string
}

type NativeMutationResult = {
  success?: boolean
  error?: string
}

async function nativeRequest<T>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
  return await getNativeWorker().request<T>(method, params, timeoutMs)
}

export async function exportSshConfig(filePath: string, connectionIds?: string[]): Promise<void> {
  const result = await nativeRequest<NativeMutationResult>(
    'ssh/config-export',
    { filePath, connectionIds: connectionIds ?? [] },
    120_000
  )
  if (result?.error || result?.success === false) {
    throw new Error(result.error || 'SSH export failed')
  }
}

export async function previewSshImport(
  filePath: string,
  source: SshImportSource
): Promise<SshImportPreviewResult> {
  return await nativeRequest<SshImportPreviewResult>(
    'ssh/import-preview',
    { filePath, source },
    120_000
  )
}

export async function applySshImport(
  filePath: string,
  source: SshImportSource,
  decisions: Array<{ importId: string; action: SshImportAction }>
): Promise<SshImportApplyResult> {
  return await nativeRequest<SshImportApplyResult>(
    'ssh/import-apply',
    { filePath, source, decisions },
    120_000
  )
}
