import { IPC } from '@renderer/lib/ipc/channels'
import type { IPCClient } from '@renderer/lib/tools/tool-types'

interface ReadTextFileResult {
  content?: string
  error?: string
}

export const PROJECT_MEMORY_DIRNAME = '.agents'

export type SessionMemoryScope = 'main' | 'shared' | 'channel'
export type ProjectMemoryPathSource = 'agents-dir' | 'workspace-root'

export interface GlobalMemorySnapshot {
  path?: string
  content?: string
  version: number
  updatedAt?: number
}

export interface MemoryLayerEntry {
  path: string
  content?: string
}

export interface DailyMemoryEntry extends MemoryLayerEntry {
  date: string
  content: string
}

export interface LayeredMemorySnapshot {
  globalHomePath?: string
  projectRootPath?: string
  agents?: MemoryLayerEntry
  globalSoul?: MemoryLayerEntry
  projectSoul?: MemoryLayerEntry
  globalUser?: MemoryLayerEntry
  projectUser?: MemoryLayerEntry
  globalMemory?: MemoryLayerEntry
  projectMemory?: MemoryLayerEntry
  globalMemorySummary?: MemoryLayerEntry
  projectMemorySummary?: MemoryLayerEntry
  globalDailyMemory: DailyMemoryEntry[]
  projectDailyMemory: DailyMemoryEntry[]
  version: number
  updatedAt?: number
}

export interface ProjectMemoryCandidatePaths {
  preferredPath: string
  fallbackPath: string
}

export interface ResolvedProjectMemoryFile {
  path: string
  content?: string
  error?: string
  missingFile: boolean
  source: ProjectMemoryPathSource
}

let cachedGlobalHomePath: string | undefined
let cachedLayeredSnapshot: LayeredMemorySnapshot = {
  globalDailyMemory: [],
  projectDailyMemory: [],
  version: 0
}
let cachedLayerSshConnectionId: string | undefined
let watchedLayerPath: string | undefined
let watchedLayerPathKey: string | undefined
let cachedLayerScope: SessionMemoryScope = 'main'
let layeredMemoryWatchCleanup: (() => void) | null = null
let layeredMemoryVersion = 0
let layeredMemoryUpdatedAt: number | undefined
const layeredMemoryListeners = new Set<(snapshot: LayeredMemorySnapshot) => void>()

function parseReadError(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const entries = Object.entries(parsed)
    if (entries.length !== 1) return null
    const [key, value] = entries[0]
    if (key !== 'error' || typeof value !== 'string' || !value.trim()) return null
    return value
  } catch {
    return null
  }
}

function detectPathSeparator(pathValue: string): '\\' | '/' {
  return pathValue.includes('\\') ? '\\' : '/'
}

function normalizeWatchPath(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, '/')
  if (/^[a-zA-Z]:/.test(normalized)) return normalized.toLowerCase()
  return normalized
}

function toOptionalEntry(path: string, content?: string): MemoryLayerEntry | undefined {
  return content?.trim() ? { path, content } : undefined
}

function buildDailyMemoryDates(now = new Date()): string[] {
  const dates: string[] = []

  for (let offset = 0; offset < 2; offset += 1) {
    const date = new Date(now)
    date.setDate(now.getDate() - offset)
    dates.push(date.toISOString().slice(0, 10))
  }

  return dates
}

export function isMissingFileErrorMessage(error: string): boolean {
  return (
    /ENOENT/i.test(error) ||
    /No such file/i.test(error) ||
    /Could not find (?:file|a part of the path)/i.test(error) ||
    /(?:system )?cannot find (?:the )?(?:file|path)(?: specified)?/i.test(error) ||
    /file not found/i.test(error) ||
    /does not exist/i.test(error) ||
    // .NET AOT builds with trimmed resource strings surface raw resource keys
    // (e.g. "IO_FileNotFound_FileName, /path") instead of readable messages.
    /\bIO_(?:FileNotFound|PathNotFound)/.test(error)
  )
}

async function loadDailyMemoryEntries(
  ipc: IPCClient,
  basePath: string | undefined
): Promise<DailyMemoryEntry[]> {
  if (!basePath) return []

  const entries = await Promise.all(
    buildDailyMemoryDates().map(async (date) => {
      const path = joinFsPath(basePath, 'memory', `${date}.md`)
      const content = await loadOptionalMemoryFile(ipc, path)
      return {
        date,
        path,
        content
      }
    })
  )

  return entries
    .filter((entry) => entry.content?.trim())
    .map((entry) => ({
      date: entry.date,
      path: entry.path,
      content: entry.content ?? ''
    }))
}

async function loadProjectDailyMemoryEntries(
  ipc: IPCClient,
  projectRootPath: string | undefined,
  sshConnectionId?: string | null
): Promise<DailyMemoryEntry[]> {
  if (!projectRootPath) return []

  const entries = await Promise.all(
    buildDailyMemoryDates().map(async (date) => {
      const resolved = await resolveProjectMemoryTextFileForTarget(
        ipc,
        projectRootPath,
        sshConnectionId,
        'memory',
        `${date}.md`
      )
      return {
        date,
        path: resolved.path,
        content: resolved.error ? undefined : resolved.content
      }
    })
  )

  return entries
    .filter((entry) => entry.content?.trim())
    .map((entry) => ({
      date: entry.date,
      path: entry.path,
      content: entry.content ?? ''
    }))
}

function snapshotsEqual(a: LayeredMemorySnapshot, b: LayeredMemorySnapshot): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

export function joinFsPath(basePath: string, ...segments: string[]): string {
  const trimmedBase = basePath.replace(/[\\/]+$/, '')
  const separator = detectPathSeparator(trimmedBase)
  const normalizedSegments = segments
    .map((segment) => segment.replace(/^[\\/]+|[\\/]+$/g, ''))
    .filter(Boolean)

  if (trimmedBase.length === 0) {
    return normalizedSegments.join(separator)
  }

  if (normalizedSegments.length === 0) {
    return trimmedBase
  }

  return [trimmedBase, ...normalizedSegments].join(separator)
}

export function getProjectMemoryCandidatePaths(
  projectRootPath: string,
  ...segments: string[]
): ProjectMemoryCandidatePaths {
  return {
    preferredPath: joinFsPath(projectRootPath, PROJECT_MEMORY_DIRNAME, ...segments),
    fallbackPath: joinFsPath(projectRootPath, ...segments)
  }
}

export async function readTextFile(
  ipc: IPCClient,
  filePath: string,
  sshConnectionId?: string | null
): Promise<ReadTextFileResult> {
  try {
    const connectionId = sshConnectionId?.trim()
    const result = await ipc.invoke(
      connectionId ? IPC.SSH_FS_READ_FILE : IPC.FS_READ_FILE,
      connectionId ? { connectionId, path: filePath } : { path: filePath }
    )
    if (result && typeof result === 'object' && 'error' in result) {
      return { error: String((result as { error?: unknown }).error ?? 'Failed to read file') }
    }
    if (typeof result !== 'string') {
      return { error: 'Unexpected fs:read-file response type' }
    }

    const readError = parseReadError(result)
    if (readError) {
      return { error: readError }
    }

    return { content: result }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function resolveTextFileWithFallbackPaths(options: {
  readFile: (path: string) => Promise<ReadTextFileResult>
  preferredPath: string
  fallbackPath: string
}): Promise<ResolvedProjectMemoryFile> {
  const preferred = await options.readFile(options.preferredPath)
  if (!preferred.error) {
    return {
      path: options.preferredPath,
      content: preferred.content ?? '',
      missingFile: false,
      source: 'agents-dir'
    }
  }

  if (!isMissingFileErrorMessage(preferred.error)) {
    return {
      path: options.preferredPath,
      error: preferred.error,
      missingFile: false,
      source: 'agents-dir'
    }
  }

  const fallback = await options.readFile(options.fallbackPath)
  if (!fallback.error) {
    return {
      path: options.fallbackPath,
      content: fallback.content ?? '',
      missingFile: false,
      source: 'workspace-root'
    }
  }

  if (!isMissingFileErrorMessage(fallback.error)) {
    return {
      path: options.fallbackPath,
      error: fallback.error,
      missingFile: false,
      source: 'workspace-root'
    }
  }

  return {
    path: options.preferredPath,
    missingFile: true,
    source: 'agents-dir'
  }
}

export async function loadOptionalMemoryFile(
  ipc: IPCClient,
  filePath: string
): Promise<string | undefined> {
  const { content, error } = await readTextFile(ipc, filePath)
  if (error || !content?.trim()) {
    return undefined
  }
  return content
}

export async function resolveProjectMemoryTextFile(
  ipc: IPCClient,
  projectRootPath: string,
  ...segments: string[]
): Promise<ResolvedProjectMemoryFile> {
  return resolveProjectMemoryTextFileForTarget(ipc, projectRootPath, null, ...segments)
}

export async function resolveProjectMemoryTextFileForTarget(
  ipc: IPCClient,
  projectRootPath: string,
  sshConnectionId: string | null | undefined,
  ...segments: string[]
): Promise<ResolvedProjectMemoryFile> {
  const { preferredPath, fallbackPath } = getProjectMemoryCandidatePaths(
    projectRootPath,
    ...segments
  )
  return resolveTextFileWithFallbackPaths({
    readFile: (path) => readTextFile(ipc, path, sshConnectionId),
    preferredPath,
    fallbackPath
  })
}

export function getLayeredMemorySnapshot(): LayeredMemorySnapshot {
  return cachedLayeredSnapshot
}

export function getGlobalMemorySnapshot(): GlobalMemorySnapshot {
  return {
    path: cachedLayeredSnapshot.globalMemory?.path,
    content: cachedLayeredSnapshot.globalMemory?.content,
    version: cachedLayeredSnapshot.version,
    updatedAt: cachedLayeredSnapshot.updatedAt
  }
}

export function subscribeLayeredMemoryUpdates(
  listener: (snapshot: LayeredMemorySnapshot) => void
): () => void {
  layeredMemoryListeners.add(listener)
  return () => {
    layeredMemoryListeners.delete(listener)
  }
}

export function subscribeGlobalMemoryUpdates(
  listener: (snapshot: GlobalMemorySnapshot) => void
): () => void {
  return subscribeLayeredMemoryUpdates((snapshot) => {
    listener({
      path: snapshot.globalMemory?.path,
      content: snapshot.globalMemory?.content,
      version: snapshot.version,
      updatedAt: snapshot.updatedAt
    })
  })
}

async function invokeStringIpc(ipc: IPCClient, channel: string): Promise<string | undefined> {
  try {
    const result = await ipc.invoke(channel)
    return typeof result === 'string' && result.trim() ? result.trim() : undefined
  } catch {
    return undefined
  }
}

function getRendererEnvHomeDir(): string | undefined {
  if (typeof window === 'undefined') return undefined

  const env = window.electron?.process?.env
  const homeDir = env?.HOME || env?.USERPROFILE
  if (homeDir?.trim()) return homeDir.trim()

  const homeDrive = env?.HOMEDRIVE?.trim()
  const homePath = env?.HOMEPATH?.trim()
  return homeDrive && homePath ? `${homeDrive}${homePath}` : undefined
}

export async function resolveGlobalMemoryHomePath(ipc: IPCClient): Promise<string | undefined> {
  if (cachedGlobalHomePath) {
    return cachedGlobalHomePath
  }

  const globalMemoryHomePath = await invokeStringIpc(ipc, IPC.APP_GLOBAL_MEMORY_HOME)
  if (globalMemoryHomePath) {
    cachedGlobalHomePath = globalMemoryHomePath
    return cachedGlobalHomePath
  }

  const homeDirResult = await invokeStringIpc(ipc, IPC.APP_HOMEDIR)
  const homeDir = homeDirResult ?? getRendererEnvHomeDir()
  if (homeDir) {
    cachedGlobalHomePath = joinFsPath(homeDir, '.open-cowork')
    return cachedGlobalHomePath
  }

  return undefined
}

export async function resolveGlobalMemoryPath(ipc: IPCClient): Promise<string | undefined> {
  const homePath = await resolveGlobalMemoryHomePath(ipc)
  return homePath ? joinFsPath(homePath, 'MEMORY.md') : undefined
}

async function buildLayeredMemorySnapshot(
  ipc: IPCClient,
  options: {
    workingFolder?: string
    sshConnectionId?: string | null
    scope?: SessionMemoryScope
  } = {}
): Promise<LayeredMemorySnapshot> {
  const globalHomePath = await resolveGlobalMemoryHomePath(ipc)
  const projectRootPath = options.workingFolder?.trim() || undefined
  const projectSshConnectionId = options.sshConnectionId?.trim() || undefined
  const scope = options.scope ?? 'main'

  const globalSoulPath = globalHomePath ? joinFsPath(globalHomePath, 'SOUL.md') : undefined
  const globalUserPath = globalHomePath ? joinFsPath(globalHomePath, 'USER.md') : undefined
  const globalMemoryPath = globalHomePath ? joinFsPath(globalHomePath, 'MEMORY.md') : undefined
  const globalMemorySummaryPath = globalHomePath
    ? joinFsPath(globalHomePath, 'memory_summary.md')
    : undefined

  const [
    projectAgentsFile,
    globalSoulContent,
    projectSoulFile,
    globalUserContent,
    projectUserFile,
    globalMemoryContent,
    projectMemoryFile,
    globalMemorySummaryContent,
    projectMemorySummaryFile,
    globalDailyMemory,
    projectDailyMemory
  ] = await Promise.all([
    projectRootPath
      ? resolveProjectMemoryTextFileForTarget(
          ipc,
          projectRootPath,
          projectSshConnectionId,
          'AGENTS.md'
        )
      : Promise.resolve(undefined),
    scope !== 'shared' && globalSoulPath
      ? loadOptionalMemoryFile(ipc, globalSoulPath)
      : Promise.resolve(undefined),
    scope !== 'shared' && projectRootPath
      ? resolveProjectMemoryTextFileForTarget(
          ipc,
          projectRootPath,
          projectSshConnectionId,
          'SOUL.md'
        )
      : Promise.resolve(undefined),
    scope === 'main' && globalUserPath
      ? loadOptionalMemoryFile(ipc, globalUserPath)
      : Promise.resolve(undefined),
    scope === 'main' && projectRootPath
      ? resolveProjectMemoryTextFileForTarget(
          ipc,
          projectRootPath,
          projectSshConnectionId,
          'USER.md'
        )
      : Promise.resolve(undefined),
    scope === 'main' && globalMemoryPath
      ? loadOptionalMemoryFile(ipc, globalMemoryPath)
      : Promise.resolve(undefined),
    scope === 'main' && projectRootPath
      ? resolveProjectMemoryTextFileForTarget(
          ipc,
          projectRootPath,
          projectSshConnectionId,
          'MEMORY.md'
        )
      : Promise.resolve(undefined),
    scope === 'main' && globalMemorySummaryPath
      ? loadOptionalMemoryFile(ipc, globalMemorySummaryPath)
      : Promise.resolve(undefined),
    scope === 'main' && projectRootPath
      ? resolveProjectMemoryTextFileForTarget(
          ipc,
          projectRootPath,
          projectSshConnectionId,
          'memory_summary.md'
        )
      : Promise.resolve(undefined),
    scope === 'main' ? loadDailyMemoryEntries(ipc, globalHomePath) : Promise.resolve([]),
    scope === 'main'
      ? loadProjectDailyMemoryEntries(ipc, projectRootPath, projectSshConnectionId)
      : Promise.resolve([])
  ])

  return {
    globalHomePath,
    projectRootPath,
    agents:
      projectAgentsFile && !projectAgentsFile.error
        ? toOptionalEntry(projectAgentsFile.path, projectAgentsFile.content)
        : undefined,
    globalSoul: globalSoulPath ? toOptionalEntry(globalSoulPath, globalSoulContent) : undefined,
    projectSoul:
      projectSoulFile && !projectSoulFile.error
        ? toOptionalEntry(projectSoulFile.path, projectSoulFile.content)
        : undefined,
    globalUser: globalUserPath ? toOptionalEntry(globalUserPath, globalUserContent) : undefined,
    projectUser:
      projectUserFile && !projectUserFile.error
        ? toOptionalEntry(projectUserFile.path, projectUserFile.content)
        : undefined,
    globalMemory: globalMemoryPath
      ? toOptionalEntry(globalMemoryPath, globalMemoryContent)
      : undefined,
    projectMemory:
      projectMemoryFile && !projectMemoryFile.error
        ? toOptionalEntry(projectMemoryFile.path, projectMemoryFile.content)
        : undefined,
    globalMemorySummary: globalMemorySummaryPath
      ? toOptionalEntry(globalMemorySummaryPath, globalMemorySummaryContent)
      : undefined,
    projectMemorySummary:
      projectMemorySummaryFile && !projectMemorySummaryFile.error
        ? toOptionalEntry(projectMemorySummaryFile.path, projectMemorySummaryFile.content)
        : undefined,
    globalDailyMemory,
    projectDailyMemory,
    version: cachedLayeredSnapshot.version,
    updatedAt: cachedLayeredSnapshot.updatedAt
  }
}

async function ensurePrimaryMemoryWatcher(
  ipc: IPCClient,
  filePath: string | undefined
): Promise<void> {
  const normalizedPath = filePath ? normalizeWatchPath(filePath) : undefined
  if (normalizedPath && watchedLayerPathKey && watchedLayerPathKey === normalizedPath) return

  if (layeredMemoryWatchCleanup && watchedLayerPath) {
    layeredMemoryWatchCleanup()
    layeredMemoryWatchCleanup = null
    await ipc.invoke(IPC.FS_UNWATCH_FILE, { path: watchedLayerPath }).catch(() => {})
  }

  if (!filePath || !normalizedPath) {
    watchedLayerPath = undefined
    watchedLayerPathKey = undefined
    return
  }

  watchedLayerPath = filePath
  watchedLayerPathKey = normalizedPath
  await ipc.invoke(IPC.FS_WATCH_FILE, { path: filePath }).catch(() => {})
  layeredMemoryWatchCleanup = ipc.on(IPC.FS_FILE_CHANGED, (...args: unknown[]) => {
    const data = args[0] as { path?: string } | undefined
    if (!data?.path) return
    if (normalizeWatchPath(data.path) !== normalizedPath) return
    void loadLayeredMemorySnapshot(ipc, {
      workingFolder: cachedLayeredSnapshot.projectRootPath,
      sshConnectionId: cachedLayerSshConnectionId,
      scope: cachedLayerScope
    })
  })
}

export async function loadLayeredMemorySnapshot(
  ipc: IPCClient,
  options: {
    workingFolder?: string
    sshConnectionId?: string | null
    scope?: SessionMemoryScope
  } = {}
): Promise<LayeredMemorySnapshot> {
  const nextSnapshot = await buildLayeredMemorySnapshot(ipc, options)
  const previousSnapshot = cachedLayeredSnapshot
  cachedLayerSshConnectionId = options.sshConnectionId?.trim() || undefined
  cachedLayerScope = options.scope ?? 'main'

  const materializedSnapshot: LayeredMemorySnapshot = {
    ...nextSnapshot,
    version: previousSnapshot.version,
    updatedAt: previousSnapshot.updatedAt
  }

  if (!snapshotsEqual(previousSnapshot, materializedSnapshot)) {
    layeredMemoryVersion += 1
    layeredMemoryUpdatedAt = Date.now()
    cachedLayeredSnapshot = {
      ...materializedSnapshot,
      version: layeredMemoryVersion,
      updatedAt: layeredMemoryUpdatedAt
    }

    for (const listener of layeredMemoryListeners) {
      listener(cachedLayeredSnapshot)
    }
  } else {
    cachedLayeredSnapshot = {
      ...materializedSnapshot,
      version: layeredMemoryVersion,
      updatedAt: layeredMemoryUpdatedAt
    }
  }

  const primaryWatchPath = cachedLayerSshConnectionId
    ? cachedLayeredSnapshot.globalMemory?.path ||
      cachedLayeredSnapshot.globalSoul?.path ||
      cachedLayeredSnapshot.globalUser?.path
    : cachedLayeredSnapshot.globalMemory?.path ||
      cachedLayeredSnapshot.globalSoul?.path ||
      cachedLayeredSnapshot.globalUser?.path ||
      cachedLayeredSnapshot.agents?.path

  await ensurePrimaryMemoryWatcher(ipc, primaryWatchPath)

  return cachedLayeredSnapshot
}

export async function loadGlobalMemorySnapshot(
  ipc: IPCClient
): Promise<{ path?: string; content?: string }> {
  const snapshot = await loadLayeredMemorySnapshot(ipc, { scope: 'main' })
  return {
    path: snapshot.globalMemory?.path,
    content: snapshot.globalMemory?.content
  }
}
