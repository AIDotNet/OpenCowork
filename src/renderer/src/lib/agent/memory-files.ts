import { IPC } from '@renderer/lib/ipc/channels'
import type { IPCClient } from '@renderer/lib/tools/tool-types'

interface ReadTextFileResult {
  content?: string
  error?: string
}

export type SessionMemoryScope = 'main' | 'shared'

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
  globalDailyMemory: DailyMemoryEntry[]
  projectDailyMemory: DailyMemoryEntry[]
  version: number
  updatedAt?: number
}

export interface GlobalMemorySnapshot {
  path?: string
  content?: string
  version: number
  updatedAt?: number
}

let cachedGlobalHomePath: string | undefined
let cachedLayeredSnapshot: LayeredMemorySnapshot = {
  globalDailyMemory: [],
  projectDailyMemory: [],
  version: 0
}
let watchedLayerPath: string | undefined
let watchedLayerPathKey: string | undefined
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

export async function readTextFile(ipc: IPCClient, filePath: string): Promise<ReadTextFileResult> {
  try {
    const result = await ipc.invoke(IPC.FS_READ_FILE, { path: filePath })
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

export async function resolveGlobalMemoryHomePath(ipc: IPCClient): Promise<string | undefined> {
  if (cachedGlobalHomePath) {
    return cachedGlobalHomePath
  }

  try {
    const homeDirResult = await ipc.invoke(IPC.APP_HOMEDIR)
    if (typeof homeDirResult !== 'string' || !homeDirResult.trim()) {
      return undefined
    }

    cachedGlobalHomePath = joinFsPath(homeDirResult, '.open-cowork')
    return cachedGlobalHomePath
  } catch {
    return undefined
  }
}

export async function resolveGlobalMemoryPath(ipc: IPCClient): Promise<string | undefined> {
  const homePath = await resolveGlobalMemoryHomePath(ipc)
  return homePath ? joinFsPath(homePath, 'MEMORY.md') : undefined
}

async function buildLayeredMemorySnapshot(
  ipc: IPCClient,
  options: {
    workingFolder?: string
    scope?: SessionMemoryScope
  } = {}
): Promise<LayeredMemorySnapshot> {
  const globalHomePath = await resolveGlobalMemoryHomePath(ipc)
  const projectRootPath = options.workingFolder?.trim() || undefined
  const scope = options.scope ?? 'main'

  const globalSoulPath = globalHomePath ? joinFsPath(globalHomePath, 'SOUL.md') : undefined
  const globalUserPath = globalHomePath ? joinFsPath(globalHomePath, 'USER.md') : undefined
  const globalMemoryPath = globalHomePath ? joinFsPath(globalHomePath, 'MEMORY.md') : undefined
  const projectAgentsPath = projectRootPath ? joinFsPath(projectRootPath, 'AGENTS.md') : undefined
  const projectSoulPath = projectRootPath ? joinFsPath(projectRootPath, 'SOUL.md') : undefined
  const projectUserPath = projectRootPath ? joinFsPath(projectRootPath, 'USER.md') : undefined
  const projectMemoryPath = projectRootPath ? joinFsPath(projectRootPath, 'MEMORY.md') : undefined

  const [
    agentsContent,
    globalSoulContent,
    projectSoulContent,
    globalUserContent,
    projectUserContent,
    globalMemoryContent,
    projectMemoryContent,
    globalDailyMemory,
    projectDailyMemory
  ] = await Promise.all([
    projectAgentsPath ? loadOptionalMemoryFile(ipc, projectAgentsPath) : Promise.resolve(undefined),
    scope === 'main' && globalSoulPath
      ? loadOptionalMemoryFile(ipc, globalSoulPath)
      : Promise.resolve(undefined),
    scope === 'main' && projectSoulPath
      ? loadOptionalMemoryFile(ipc, projectSoulPath)
      : Promise.resolve(undefined),
    scope === 'main' && globalUserPath
      ? loadOptionalMemoryFile(ipc, globalUserPath)
      : Promise.resolve(undefined),
    scope === 'main' && projectUserPath
      ? loadOptionalMemoryFile(ipc, projectUserPath)
      : Promise.resolve(undefined),
    scope === 'main' && globalMemoryPath
      ? loadOptionalMemoryFile(ipc, globalMemoryPath)
      : Promise.resolve(undefined),
    scope === 'main' && projectMemoryPath
      ? loadOptionalMemoryFile(ipc, projectMemoryPath)
      : Promise.resolve(undefined),
    scope === 'main' ? loadDailyMemoryEntries(ipc, globalHomePath) : Promise.resolve([]),
    scope === 'main' ? loadDailyMemoryEntries(ipc, projectRootPath) : Promise.resolve([])
  ])

  return {
    globalHomePath,
    projectRootPath,
    agents: projectAgentsPath ? toOptionalEntry(projectAgentsPath, agentsContent) : undefined,
    globalSoul: globalSoulPath ? toOptionalEntry(globalSoulPath, globalSoulContent) : undefined,
    projectSoul: projectSoulPath ? toOptionalEntry(projectSoulPath, projectSoulContent) : undefined,
    globalUser: globalUserPath ? toOptionalEntry(globalUserPath, globalUserContent) : undefined,
    projectUser: projectUserPath ? toOptionalEntry(projectUserPath, projectUserContent) : undefined,
    globalMemory: globalMemoryPath
      ? toOptionalEntry(globalMemoryPath, globalMemoryContent)
      : undefined,
    projectMemory: projectMemoryPath
      ? toOptionalEntry(projectMemoryPath, projectMemoryContent)
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
    const data = args[1] as { path?: string } | undefined
    if (!data?.path) return
    if (normalizeWatchPath(data.path) !== normalizedPath) return
    void loadLayeredMemorySnapshot(ipc, {
      workingFolder: cachedLayeredSnapshot.projectRootPath,
      scope:
        cachedLayeredSnapshot.globalSoul ||
        cachedLayeredSnapshot.globalUser ||
        cachedLayeredSnapshot.globalMemory ||
        cachedLayeredSnapshot.projectSoul ||
        cachedLayeredSnapshot.projectUser ||
        cachedLayeredSnapshot.projectMemory ||
        cachedLayeredSnapshot.globalDailyMemory.length > 0 ||
        cachedLayeredSnapshot.projectDailyMemory.length > 0
          ? 'main'
          : 'shared'
    })
  })
}

export async function loadLayeredMemorySnapshot(
  ipc: IPCClient,
  options: {
    workingFolder?: string
    scope?: SessionMemoryScope
  } = {}
): Promise<LayeredMemorySnapshot> {
  const nextSnapshot = await buildLayeredMemorySnapshot(ipc, options)
  const previousSnapshot = cachedLayeredSnapshot

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

  await ensurePrimaryMemoryWatcher(
    ipc,
    cachedLayeredSnapshot.globalMemory?.path ||
      cachedLayeredSnapshot.globalSoul?.path ||
      cachedLayeredSnapshot.globalUser?.path ||
      cachedLayeredSnapshot.agents?.path
  )

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
