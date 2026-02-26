import { IPC } from '@renderer/lib/ipc/channels'
import type { IPCClient } from '@renderer/lib/tools/tool-types'

interface ReadTextFileResult {
  content?: string
  error?: string
}

export interface GlobalMemorySnapshot {
  path?: string
  content?: string
  version: number
  updatedAt?: number
}

let cachedGlobalMemoryPath: string | undefined
let cachedGlobalMemoryContent: string | undefined
let watchedGlobalMemoryPath: string | undefined
let watchedGlobalMemoryPathKey: string | undefined
let globalMemoryWatchCleanup: (() => void) | null = null
let globalMemoryVersion = 0
let globalMemoryUpdatedAt: number | undefined
const globalMemoryListeners = new Set<(snapshot: GlobalMemorySnapshot) => void>()

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

export function getGlobalMemorySnapshot(): GlobalMemorySnapshot {
  return {
    path: cachedGlobalMemoryPath,
    content: cachedGlobalMemoryContent,
    version: globalMemoryVersion,
    updatedAt: globalMemoryUpdatedAt,
  }
}

export function subscribeGlobalMemoryUpdates(
  listener: (snapshot: GlobalMemorySnapshot) => void
): () => void {
  globalMemoryListeners.add(listener)
  return () => {
    globalMemoryListeners.delete(listener)
  }
}

export async function resolveGlobalMemoryPath(ipc: IPCClient): Promise<string | undefined> {
  if (cachedGlobalMemoryPath) {
    return cachedGlobalMemoryPath
  }

  try {
    const homeDirResult = await ipc.invoke(IPC.APP_HOMEDIR)
    if (typeof homeDirResult !== 'string' || !homeDirResult.trim()) {
      return undefined
    }

    cachedGlobalMemoryPath = joinFsPath(homeDirResult, '.open-cowork', 'MEMORY.md')
    return cachedGlobalMemoryPath
  } catch {
    return undefined
  }
}

async function refreshGlobalMemoryContent(
  ipc: IPCClient,
  filePath: string
): Promise<string | undefined> {
  const previousContent = cachedGlobalMemoryContent
  const previousPath = cachedGlobalMemoryPath
  const content = await loadOptionalMemoryFile(ipc, filePath)
  cachedGlobalMemoryContent = content
  cachedGlobalMemoryPath = filePath

  const changed = content !== previousContent || filePath !== previousPath
  if (changed) {
    globalMemoryVersion += 1
    globalMemoryUpdatedAt = Date.now()
    const snapshot = getGlobalMemorySnapshot()
    for (const listener of globalMemoryListeners) {
      listener(snapshot)
    }
  }

  return content
}

async function ensureGlobalMemoryWatcher(ipc: IPCClient, filePath: string): Promise<void> {
  const normalizedPath = normalizeWatchPath(filePath)
  if (watchedGlobalMemoryPathKey && watchedGlobalMemoryPathKey === normalizedPath) return

  if (globalMemoryWatchCleanup && watchedGlobalMemoryPath) {
    globalMemoryWatchCleanup()
    globalMemoryWatchCleanup = null
    await ipc.invoke(IPC.FS_UNWATCH_FILE, { path: watchedGlobalMemoryPath }).catch(() => {})
  }

  watchedGlobalMemoryPath = filePath
  watchedGlobalMemoryPathKey = normalizedPath
  await ipc.invoke(IPC.FS_WATCH_FILE, { path: filePath }).catch(() => {})
  globalMemoryWatchCleanup = ipc.on(IPC.FS_FILE_CHANGED, (...args: unknown[]) => {
    const data = args[1] as { path?: string } | undefined
    if (!data?.path) return
    if (normalizeWatchPath(data.path) !== normalizedPath) return
    void refreshGlobalMemoryContent(ipc, filePath)
  })
}

export async function loadGlobalMemorySnapshot(
  ipc: IPCClient
): Promise<{ path?: string; content?: string }> {
  const globalPath = await resolveGlobalMemoryPath(ipc)
  if (!globalPath) {
    const hadMemory = Boolean(cachedGlobalMemoryPath || cachedGlobalMemoryContent)
    if (globalMemoryWatchCleanup && watchedGlobalMemoryPath) {
      globalMemoryWatchCleanup()
      globalMemoryWatchCleanup = null
      await ipc.invoke(IPC.FS_UNWATCH_FILE, { path: watchedGlobalMemoryPath }).catch(() => {})
    }
    watchedGlobalMemoryPath = undefined
    watchedGlobalMemoryPathKey = undefined
    cachedGlobalMemoryContent = undefined
    cachedGlobalMemoryPath = undefined
    if (hadMemory) {
      globalMemoryVersion += 1
      globalMemoryUpdatedAt = Date.now()
      const snapshot = getGlobalMemorySnapshot()
      for (const listener of globalMemoryListeners) {
        listener(snapshot)
      }
    }
    return {}
  }

  const content = await refreshGlobalMemoryContent(ipc, globalPath)
  await ensureGlobalMemoryWatcher(ipc, globalPath)
  return { path: globalPath, content }
}
