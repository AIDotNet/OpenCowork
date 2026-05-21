export type EditorWorkspace =
  | {
      kind: 'local'
      rootPath: string
    }
  | {
      kind: 'ssh'
      connectionId: string
      rootPath: string
    }

export interface CreateModelUriOptions {
  filePath: string
  workspace?: EditorWorkspace | null
  workspaceEnabled: boolean
  remoteLanguageServiceEnabled: boolean
}

export function createLocalWorkspace(rootPath?: string | null): EditorWorkspace | null {
  const normalized = normalizeWorkspaceRoot(rootPath)
  if (!normalized) return null
  return {
    kind: 'local',
    rootPath: normalized
  }
}

export function createSshWorkspace(
  connectionId?: string | null,
  rootPath?: string | null
): EditorWorkspace | null {
  const normalizedConnectionId = connectionId?.trim()
  const normalizedRootPath = normalizeWorkspaceRoot(rootPath)
  if (!normalizedConnectionId || !normalizedRootPath) return null
  return {
    kind: 'ssh',
    connectionId: normalizedConnectionId,
    rootPath: normalizedRootPath
  }
}

export function normalizeWorkspaceRoot(rootPath?: string | null): string | null {
  const trimmed = rootPath?.trim()
  return trimmed ? trimmed : null
}

export function getParentPath(filePath: string): string | null {
  const normalized = filePath.trim()
  if (!normalized) return null

  const lastSeparatorIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (lastSeparatorIndex < 0) return null
  if (lastSeparatorIndex === 0) return normalized[0] === '/' ? '/' : null
  if (lastSeparatorIndex === 2 && /^[A-Za-z]:/.test(normalized)) {
    return normalized.slice(0, 3)
  }

  return normalized.slice(0, lastSeparatorIndex)
}

export function createModelUri(options: CreateModelUriOptions): string {
  const { filePath, workspace, workspaceEnabled, remoteLanguageServiceEnabled } = options

  if (!workspaceEnabled || !workspace) {
    return createInMemoryUri(
      filePath,
      workspace?.kind === 'ssh' ? workspace.connectionId : undefined
    )
  }

  if (workspace.kind === 'local') {
    return createFileUri(filePath)
  }

  if (!remoteLanguageServiceEnabled) {
    return createInMemoryUri(filePath, workspace.connectionId)
  }

  return createUri('ssh', workspace.connectionId, normalizeRemotePath(filePath))
}

function createInMemoryUri(filePath: string, authority?: string): string {
  const modelKey = createModelKey(filePath)
  const fileName = getFileName(filePath)
  const fileNameSegment = fileName ? `/${encodeURIComponent(fileName)}` : ''
  return `inmemory://${authority || 'opencowork'}/model/${modelKey}${fileNameSegment}`
}

function createFileUri(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const absolutePath = /^[A-Za-z]:\//.test(normalized)
    ? `/${normalized}`
    : normalized.startsWith('/')
      ? normalized
      : `/${normalized}`
  return `file://${encodeURI(absolutePath)}`
}

function createUri(scheme: string, authority: string, path: string): string {
  return `${scheme}://${authority}${encodeURI(path)}`
}

function normalizeRemotePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.startsWith('/') ? normalized : `/${normalized}`
}

function getFileName(filePath: string): string {
  const normalized = filePath.trim()
  if (!normalized) return ''

  const lastSeparatorIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return lastSeparatorIndex >= 0 ? normalized.slice(lastSeparatorIndex + 1) : normalized
}

function createModelKey(filePath: string): string {
  return Array.from(new TextEncoder().encode(filePath), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}
