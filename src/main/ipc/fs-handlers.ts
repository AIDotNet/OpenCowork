import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { recordLocalTextWriteChange } from './agent-change-handlers'
import { safeSendMessagePackToWindow } from '../window-ipc'
import { getNativeWorker } from '../lib/native-worker'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'
import { registerMessagePackHandler } from './messagepack-handler'

function readByteLimitFromEnv(
  envName: string,
  fallbackMb: number,
  minMb: number,
  maxMb: number
): number {
  const raw = process.env[envName]
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  const mb = Number.isFinite(parsed) ? Math.min(Math.max(parsed, minMb), maxMb) : fallbackMb
  return mb * 1024 * 1024
}

const MAX_FILE_READ_BYTES = readByteLimitFromEnv('OPEN_COWORK_MAX_FILE_READ_MB', 10, 1, 50)
const MAX_IMAGE_READ_BYTES = readByteLimitFromEnv('OPEN_COWORK_MAX_IMAGE_READ_MB', 10, 1, 20)
const MAX_PROFILE_AVATAR_BYTES = 2 * 1024 * 1024 // 2 MB
const DEFAULT_TEXT_LINE_READ_LIMIT = 1_000
const MAX_LIST_DIR_ITEMS = 1_000
const MAX_GLOB_MATCHES = 1_000
const MAX_RECURSIVE_DIR_WATCHERS = 2_000
const DIRECTORY_WATCHER_CLOSE_BATCH_SIZE = 25
const PROFILE_AVATAR_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

async function assertFileSize(filePath: string, limit: number): Promise<number> {
  const stat = await fs.promises.stat(filePath)
  if (stat.size > limit) {
    throw new Error(
      `File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB, limit ${(limit / 1024 / 1024).toFixed(0)} MB): ${filePath}`
    )
  }
  return stat.size
}

const FILE_SEARCH_MAX_RESULTS = 20

type GrepOutputMode = 'matches' | 'files_with_matches' | 'files_without_matches' | 'count'
type GrepLimitReason = 'max_results' | 'max_output_bytes' | 'timeout' | null
type SearchBackend = 'local' | 'ssh' | 'cron'
type SearchPathStyle = 'absolute' | 'relative_to_search_root'
type SearchEngine = 'git_grep' | 'ripgrep' | 'native_aot'

type SearchMeta = {
  backend: SearchBackend
  engine?: SearchEngine
  searchRoot: string
  pathStyle: SearchPathStyle
  truncated: boolean
  timedOut: boolean
  limitReason: GrepLimitReason
  pattern: string
  include?: string | null
  exclude?: string | null
  outputMode?: GrepOutputMode
  hiddenIncluded: boolean
  ignoredDefaultsApplied: boolean
  respectGitignore?: boolean
  followSymlinks?: boolean
  searchTime?: number
  warnings?: string[]
  maxDepth?: number | null
  beforeContext?: number
  afterContext?: number
  maxResults?: number
  maxOutputBytes?: number
  maxLineLength?: number
}

type GlobToolResult = {
  kind: 'glob'
  matches: Array<{ path: string; type?: 'file' | 'directory' }>
  meta: SearchMeta
  error?: string
}

interface ReadTextFileLinesResult {
  content: string
  name: string
  path: string
  lineCount: number
  maxLines: number
  truncated: boolean
}

function clampTextLineReadLimit(maxLines?: number): number {
  if (typeof maxLines !== 'number' || !Number.isFinite(maxLines)) {
    return DEFAULT_TEXT_LINE_READ_LIMIT
  }
  return Math.max(1, Math.min(DEFAULT_TEXT_LINE_READ_LIMIT, Math.floor(maxLines)))
}

type GrepToolResult = {
  kind: 'grep'
  matches: Array<{
    path: string
    line?: number
    column?: number
    text?: string
    kind?: 'match' | 'context'
    count?: number
  }>
  meta: SearchMeta
  output?: string
  error?: string
}

type FileMutationResult = {
  success: boolean
  error?: string | null
}

type FileWriteResult = FileMutationResult & {
  op?: 'create' | 'modify' | string
}

type FileStatResult = {
  exists: boolean
  type: 'file' | 'directory' | 'other' | null
  size: number | null
  mtimeMs: number | null
  error?: string | null
}

async function nativeToolRequest<T>(
  method: string,
  params: Record<string, unknown>,
  timeoutMs?: number
): Promise<T> {
  return await getNativeWorker().request<T>(method, params, timeoutMs)
}

const GREP_IGNORE_DIR_NAMES = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.bzr',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  'coverage',
  '.nyc_output',
  '.cache',
  '.parcel-cache',
  'vendor',
  'target',
  'bin',
  'obj',
  '.gradle',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.venv',
  'venv',
  'env'
]
const GREP_IGNORE_DIRS = new Set(GREP_IGNORE_DIR_NAMES)

function isDefaultIgnoredDirName(name: string): boolean {
  return GREP_IGNORE_DIRS.has(name.toLowerCase())
}

function formatLocalDateFolderName(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentPath, candidatePath)
  return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
}

async function deletePreviousProfileAvatar(
  previousUrl: string | null | undefined,
  avatarDir: string
): Promise<void> {
  if (!previousUrl?.startsWith('file://')) return

  try {
    const previousPath = fileURLToPath(previousUrl)
    if (!isPathInside(avatarDir, previousPath)) return
    await fs.promises.unlink(previousPath)
  } catch {
    // Ignore cleanup failures; replacing the avatar should still succeed.
  }
}

const GREP_TIMEOUT_MS = 30000
const MAX_SEARCH_DEPTH = 50

function createSearchMeta(args: {
  searchRoot: string
  pattern: string
  include?: string | null
  exclude?: string | null
  outputMode?: GrepOutputMode
  truncated?: boolean
  timedOut?: boolean
  limitReason?: GrepLimitReason
  engine?: SearchEngine
  searchTime?: number
  warnings?: string[]
  maxDepth?: number | null
  pathStyle?: SearchPathStyle
  hiddenIncluded?: boolean
  respectGitignore?: boolean
  followSymlinks?: boolean
  beforeContext?: number
  afterContext?: number
  maxResults?: number
  maxOutputBytes?: number
  maxLineLength?: number
}): SearchMeta {
  return {
    backend: 'local',
    engine: args.engine,
    searchRoot: args.searchRoot,
    pathStyle: args.pathStyle ?? 'absolute',
    truncated: args.truncated === true,
    timedOut: args.timedOut === true,
    limitReason: args.limitReason ?? null,
    pattern: args.pattern,
    include: args.include ?? null,
    exclude: args.exclude ?? null,
    outputMode: args.outputMode ?? 'matches',
    hiddenIncluded: args.hiddenIncluded ?? true,
    ignoredDefaultsApplied: true,
    respectGitignore: args.respectGitignore ?? true,
    followSymlinks: args.followSymlinks ?? false,
    searchTime: args.searchTime,
    warnings: args.warnings ?? [],
    maxDepth: args.maxDepth ?? null,
    beforeContext: args.beforeContext ?? 0,
    afterContext: args.afterContext ?? 0,
    maxResults: args.maxResults,
    maxOutputBytes: args.maxOutputBytes,
    maxLineLength: args.maxLineLength
  }
}

function createGlobToolResult(args: {
  searchRoot: string
  pattern: string
  matches: Array<{ path: string; type?: 'file' | 'directory' }>
  truncated?: boolean
  limitReason?: GrepLimitReason
  warnings?: string[]
  hiddenIncluded?: boolean
  respectGitignore?: boolean
  followSymlinks?: boolean
  maxDepth?: number | null
  error?: string
}): GlobToolResult {
  return {
    kind: 'glob',
    matches: args.matches,
    meta: createSearchMeta({
      searchRoot: args.searchRoot,
      pattern: args.pattern,
      truncated: args.truncated,
      limitReason: args.limitReason,
      warnings: args.warnings,
      hiddenIncluded: args.hiddenIncluded,
      respectGitignore: args.respectGitignore,
      followSymlinks: args.followSymlinks,
      maxDepth: args.maxDepth,
      pathStyle: 'absolute'
    }),
    error: args.error
  }
}

function clampToolResultLimit(value: unknown, max: number): number | null {
  if (!Number.isFinite(value)) return null
  const normalized = Math.floor(Number(value))
  if (normalized <= 0) return null
  return Math.min(normalized, max)
}

interface WatchedFileEntry {
  watcher: fs.FSWatcher
  refCount: number
  windowRefs: Map<number, number>
  timer: NodeJS.Timeout | null
  filePath: string
  baseName: string
}

interface WatchedDirectoryEntry {
  rootPath: string
  recursive: boolean
  refCount: number
  windowRefs: Map<number, number>
  watchers: Map<string, fs.FSWatcher>
  timer: NodeJS.Timeout | null
  syncTimer: NodeJS.Timeout | null
  syncing: boolean
  closed: boolean
}

function getInvokeWindowId(event: Electron.IpcMainInvokeEvent): number | null {
  return BrowserWindow.fromWebContents(event.sender)?.id ?? null
}

function addInvokeWindowSubscription(
  windowRefs: Map<number, number>,
  event: Electron.IpcMainInvokeEvent
): void {
  const windowId = getInvokeWindowId(event)
  if (windowId !== null) windowRefs.set(windowId, (windowRefs.get(windowId) ?? 0) + 1)
}

function removeInvokeWindowSubscription(
  windowRefs: Map<number, number>,
  event: Electron.IpcMainInvokeEvent
): void {
  const windowId = getInvokeWindowId(event)
  if (windowId === null) return

  const nextCount = (windowRefs.get(windowId) ?? 0) - 1
  if (nextCount > 0) {
    windowRefs.set(windowId, nextCount)
  } else {
    windowRefs.delete(windowId)
  }
}

function sendToSubscribedWindows(
  windowRefs: Map<number, number>,
  channel: string,
  payload: unknown
): void {
  if (windowRefs.size === 0) {
    for (const win of BrowserWindow.getAllWindows()) {
      safeSendMessagePackToWindow(win, channel, payload)
    }
    return
  }

  for (const windowId of windowRefs.keys()) {
    const win = BrowserWindow.fromId(windowId)
    if (!win) {
      windowRefs.delete(windowId)
      continue
    }
    safeSendMessagePackToWindow(win, channel, payload)
  }
}

function watchedFilenameMatches(
  entry: WatchedFileEntry,
  filename: string | Buffer | null
): boolean {
  if (!filename) return true

  const changedName = Buffer.isBuffer(filename) ? filename.toString() : filename
  if (!changedName) return true

  const changedBaseName = path.basename(changedName)
  if (process.platform === 'win32') {
    return changedBaseName.toLowerCase() === entry.baseName.toLowerCase()
  }

  return changedBaseName === entry.baseName
}

function scheduleFileChanged(entry: WatchedFileEntry): void {
  if (entry.timer) clearTimeout(entry.timer)

  entry.timer = setTimeout(() => {
    entry.timer = null
    sendToSubscribedWindows(entry.windowRefs, 'fs:file-changed', { path: entry.filePath })
  }, 300)
}

function directoryWatchKey(dirPath: string, recursive: boolean): string {
  return `${dirPath}\0${recursive ? 'recursive' : 'direct'}`
}

function shouldIgnoreWatchedDirectory(dirPath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, dirPath)
  if (!relativePath) return false
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return true
  return relativePath.split(/[\\/]+/).some((part) => isDefaultIgnoredDirName(part))
}

function shouldIgnoreWatchedChange(changedPath: string | null, rootPath: string): boolean {
  if (!changedPath) return false
  return shouldIgnoreWatchedDirectory(changedPath, rootPath)
}

async function collectWatchableDirectories(
  rootPath: string,
  recursive: boolean
): Promise<Set<string>> {
  const directories = new Set<string>([rootPath])
  if (!recursive) return directories

  const queue = [rootPath]
  while (queue.length > 0 && directories.size < MAX_RECURSIVE_DIR_WATCHERS) {
    const current = queue.shift()!
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      if (isDefaultIgnoredDirName(entry.name)) continue

      const childPath = path.join(current, entry.name)
      if (shouldIgnoreWatchedDirectory(childPath, rootPath)) continue

      directories.add(childPath)
      queue.push(childPath)
      if (directories.size >= MAX_RECURSIVE_DIR_WATCHERS) break
    }
  }

  return directories
}

function scheduleDirectoryWatcherSync(entry: WatchedDirectoryEntry): void {
  if (entry.closed) return
  if (!entry.recursive) return
  if (entry.syncTimer) clearTimeout(entry.syncTimer)

  entry.syncTimer = setTimeout(() => {
    entry.syncTimer = null
    void syncDirectoryWatchers(entry)
  }, 500)
}

function scheduleDirectoryChanged(entry: WatchedDirectoryEntry, changedPath: string | null): void {
  if (entry.closed) return
  if (shouldIgnoreWatchedChange(changedPath, entry.rootPath)) return

  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = setTimeout(() => {
    entry.timer = null
    sendToSubscribedWindows(entry.windowRefs, 'fs:dir-changed', {
      path: entry.rootPath,
      changedPath: changedPath ?? entry.rootPath
    })
  }, 300)

  scheduleDirectoryWatcherSync(entry)
}

function watchDirectoryPath(entry: WatchedDirectoryEntry, dirPath: string): void {
  if (entry.closed) return
  if (entry.watchers.has(dirPath)) return

  try {
    const watcher = fs.watch(dirPath, { recursive: false }, (_eventType, filename) => {
      const changedPath =
        typeof filename === 'string' && filename.length > 0 ? path.join(dirPath, filename) : dirPath
      scheduleDirectoryChanged(entry, changedPath)
    })
    watcher.on('error', () => {
      watcher.close()
      entry.watchers.delete(dirPath)
    })
    entry.watchers.set(dirPath, watcher)
  } catch {
    // Directory may disappear between traversal and watch registration.
  }
}

async function syncDirectoryWatchers(entry: WatchedDirectoryEntry): Promise<void> {
  if (entry.closed) return
  if (entry.syncing) return
  entry.syncing = true
  try {
    const directories = await collectWatchableDirectories(entry.rootPath, entry.recursive)
    if (entry.closed) return

    for (const dirPath of directories) {
      watchDirectoryPath(entry, dirPath)
    }

    for (const [dirPath, watcher] of entry.watchers) {
      if (directories.has(dirPath)) continue
      watcher.close()
      entry.watchers.delete(dirPath)
    }
  } finally {
    entry.syncing = false
  }
}

function closeDirectoryWatchEntry(entry: WatchedDirectoryEntry): void {
  entry.closed = true
  const watchers = Array.from(entry.watchers.values())
  entry.watchers.clear()
  if (entry.timer) clearTimeout(entry.timer)
  if (entry.syncTimer) clearTimeout(entry.syncTimer)
  entry.timer = null
  entry.syncTimer = null
  closeDirectoryWatchersInBatches(watchers)
}

function closeDirectoryWatchersInBatches(watchers: fs.FSWatcher[]): void {
  let index = 0

  const closeNextBatch = (): void => {
    const end = Math.min(index + DIRECTORY_WATCHER_CLOSE_BATCH_SIZE, watchers.length)
    while (index < end) {
      try {
        watchers[index].close()
      } catch {
        // The watcher may already be closed by Node after an underlying fs error.
      }
      index += 1
    }

    if (index < watchers.length) setImmediate(closeNextBatch)
  }

  if (watchers.length > 0) setImmediate(closeNextBatch)
}

type FsReadFileArgs = { path: string; offset?: number; limit?: number; raw?: boolean }
type FsReadTextFileLinesArgs = { path: string; maxLines?: number }
type FsWriteFileArgs = {
  path: string
  content: string
  beforeContent?: string
  changeMeta?: { runId?: string; sessionId?: string; toolUseId?: string; toolName?: string }
}
type FsListDirArgs = { path: string; ignore?: string[]; limit?: number }
type FsGlobArgs = {
  pattern: string
  path?: string
  limit?: number
  hidden?: boolean
  respectGitignore?: boolean
  followSymlinks?: boolean
  maxDepth?: number
}
type FsSearchFilesArgs = { path: string; query: string; limit?: number }
type FsGrepArgs = Record<string, unknown> & {
  pattern: string
  path?: string
  include?: string
  exclude?: string
}
type FsReadFileBinaryArgs = { path: string }
type FsWriteFileBinaryArgs = { path: string; data: string }
export type FsReadDocumentArgs = { path: string }

function registerFsMessagePackHandler<TArgs>(
  channel: string,
  handler: (args: TArgs) => Promise<unknown>
): void {
  ipcMain.handle(toMessagePackChannel(channel), async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<TArgs>(bytes)
    return encodeMessagePackPayload(await handler(args))
  })
}

async function handleFsReadFile(args: FsReadFileArgs): Promise<unknown> {
  try {
    return await nativeToolRequest('fs/read-file', {
      ...args,
      maxFileReadBytes: MAX_FILE_READ_BYTES,
      maxImageReadBytes: MAX_IMAGE_READ_BYTES
    })
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleFsReadTextFileLines(args: FsReadTextFileLinesArgs): Promise<unknown> {
  try {
    return await nativeToolRequest<ReadTextFileLinesResult | { error: string }>(
      'fs/read-text-file-lines',
      {
        path: args.path,
        maxLines: clampTextLineReadLimit(args.maxLines),
        maxFileReadBytes: MAX_FILE_READ_BYTES
      }
    )
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleFsWriteFile(args: FsWriteFileArgs): Promise<unknown> {
  try {
    const stat = await nativeToolRequest<FileStatResult>('fs/stat-path', { path: args.path })
    if (stat.error) return { error: stat.error }
    const beforeExists = stat.exists
    let beforeText: string | undefined
    if (beforeExists) {
      try {
        const readResult = await nativeToolRequest<string | { error: string }>('fs/read-file', {
          path: args.path,
          raw: true,
          maxFileReadBytes: MAX_FILE_READ_BYTES,
          maxImageReadBytes: MAX_IMAGE_READ_BYTES
        })
        if (typeof readResult === 'string') {
          beforeText = readResult
        }
      } catch {
        // best-effort: skip diff if read fails
      }
    }
    if (typeof args.beforeContent === 'string' && beforeText !== args.beforeContent) {
      return {
        error: 'File changed since it was read. Read the file again before editing or writing.'
      }
    }
    const writeResult = await nativeToolRequest<FileWriteResult>('fs/write-file', {
      path: args.path,
      content: args.content
    })
    if (!writeResult.success) {
      return { error: writeResult.error ?? 'Native file write failed' }
    }
    await recordLocalTextWriteChange({
      meta: args.changeMeta,
      filePath: args.path,
      beforeExists,
      beforeText,
      afterText: args.content
    })
    return { success: true, op: writeResult.op ?? (beforeExists ? 'modify' : 'create') }
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleFsStatPath(args: { path: string }): Promise<unknown> {
  try {
    const result = await nativeToolRequest<FileStatResult>('fs/stat-path', { path: args.path })
    if (result.error) return { error: result.error }
    return result
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleFsListDir(args: FsListDirArgs): Promise<unknown> {
  try {
    return await nativeToolRequest('fs/list-dir', {
      path: path.resolve(args.path),
      ignore: args.ignore ?? [],
      limit: clampToolResultLimit(args.limit, MAX_LIST_DIR_ITEMS) ?? MAX_LIST_DIR_ITEMS
    })
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleFsMkdir(args: { path: string }): Promise<unknown> {
  try {
    const result = await nativeToolRequest<FileMutationResult>('fs/mkdir', { path: args.path })
    return result.success ? { success: true } : { error: result.error ?? 'Native mkdir failed' }
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleFsDelete(args: { path: string }): Promise<unknown> {
  try {
    const result = await nativeToolRequest<FileMutationResult>('fs/delete', { path: args.path })
    return result.success ? { success: true } : { error: result.error ?? 'Native delete failed' }
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleFsMove(args: { from: string; to: string }): Promise<unknown> {
  try {
    const result = await nativeToolRequest<FileMutationResult>('fs/move', {
      from: args.from,
      to: args.to
    })
    return result.success ? { success: true } : { error: result.error ?? 'Native move failed' }
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleFsGlob(args: FsGlobArgs): Promise<unknown> {
  const cwd = path.resolve(args.path || process.cwd())
  try {
    return await nativeToolRequest<GlobToolResult>('fs/glob', {
      pattern: args.pattern,
      path: cwd,
      limit: clampToolResultLimit(args.limit, MAX_GLOB_MATCHES) ?? 100,
      hidden: args.hidden !== false,
      respectGitignore: args.respectGitignore === true,
      followSymlinks: args.followSymlinks === true,
      maxDepth: clampToolResultLimit(args.maxDepth, MAX_SEARCH_DEPTH)
    })
  } catch (err) {
    return createGlobToolResult({
      searchRoot: cwd,
      pattern: args.pattern,
      matches: [],
      respectGitignore: args.respectGitignore === true,
      followSymlinks: args.followSymlinks === true,
      error: String(err)
    })
  }
}

async function handleFsSearchFiles(args: FsSearchFilesArgs): Promise<unknown> {
  try {
    return await nativeToolRequest('fs/search-files', {
      path: path.resolve(args.path || process.cwd()),
      query: args.query ?? '',
      limit: Math.max(1, Math.min(args.limit ?? FILE_SEARCH_MAX_RESULTS, 100))
    })
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleFsGrep(args: FsGrepArgs): Promise<unknown> {
  const searchTarget = path.resolve(args.path || process.cwd())
  try {
    return await nativeToolRequest<GrepToolResult>(
      'fs/grep',
      { ...args, path: searchTarget },
      GREP_TIMEOUT_MS + 5_000
    )
  } catch (err) {
    return {
      kind: 'grep',
      matches: [],
      meta: createSearchMeta({
        searchRoot: searchTarget,
        pattern: typeof args.pattern === 'string' ? args.pattern : '',
        include: typeof args.include === 'string' ? args.include : null,
        exclude: typeof args.exclude === 'string' ? args.exclude : null,
        outputMode: 'matches',
        engine: 'native_aot',
        pathStyle: 'relative_to_search_root'
      }),
      output: '',
      error: String(err)
    } satisfies GrepToolResult
  }
}

async function handleFsReadFileBinary(args: FsReadFileBinaryArgs): Promise<unknown> {
  try {
    return await nativeToolRequest('fs/read-file-binary', {
      path: args.path,
      maxFileReadBytes: MAX_FILE_READ_BYTES
    })
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleFsWriteFileBinary(args: FsWriteFileBinaryArgs): Promise<unknown> {
  try {
    const result = await nativeToolRequest<FileMutationResult>('fs/write-file-binary', args)
    return result.success
      ? { success: true }
      : { error: result.error ?? 'Native binary file write failed' }
  } catch (err) {
    return { error: String(err) }
  }
}

export async function handleFsReadDocument(args: FsReadDocumentArgs): Promise<unknown> {
  try {
    return await nativeToolRequest('fs/read-document', {
      path: args.path,
      maxFileReadBytes: MAX_FILE_READ_BYTES
    })
  } catch (err) {
    return { error: String(err) }
  }
}

export function registerFsHandlers(): void {
  registerFsMessagePackHandler<FsReadFileArgs>('fs:read-file', handleFsReadFile)
  registerFsMessagePackHandler<FsReadTextFileLinesArgs>(
    'fs:read-text-file-lines',
    handleFsReadTextFileLines
  )
  registerFsMessagePackHandler<FsWriteFileArgs>('fs:write-file', handleFsWriteFile)
  registerFsMessagePackHandler<{ path: string }>('fs:stat-path', handleFsStatPath)
  registerFsMessagePackHandler<FsListDirArgs>('fs:list-dir', handleFsListDir)
  registerFsMessagePackHandler<{ path: string }>('fs:mkdir', handleFsMkdir)

  registerMessagePackHandler<void>('fs:default-chat-working-folder', async () => {
    try {
      const folderPath = path.join(app.getPath('documents'), formatLocalDateFolderName(), 'Chat')
      await fs.promises.mkdir(folderPath, { recursive: true })
      return { path: folderPath }
    } catch (err) {
      return { error: String(err) }
    }
  })

  registerFsMessagePackHandler<{ path: string }>('fs:delete', handleFsDelete)
  registerFsMessagePackHandler<{ from: string; to: string }>('fs:move', handleFsMove)

  registerMessagePackHandler<{ defaultPath?: string } | undefined>(
    'fs:select-folder',
    async (args) => {
      const win = BrowserWindow.getFocusedWindow()
      if (!win) return { canceled: true }
      const defaultPath = args?.defaultPath?.trim()
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        defaultPath: defaultPath || undefined
      })
      if (result.canceled) return { canceled: true }
      return { path: result.filePaths[0] }
    }
  )

  registerMessagePackHandler<void>('fs:list-desktop-directories', async () => {
    try {
      const desktopPath = app.getPath('desktop')
      const desktopName = path.basename(desktopPath) || 'Desktop'
      const entries = await fs.promises.readdir(desktopPath, { withFileTypes: true })
      const directories = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          name: entry.name,
          path: path.join(desktopPath, entry.name),
          isDesktop: false
        }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

      return {
        desktopPath,
        directories: [
          {
            name: desktopName,
            path: desktopPath,
            isDesktop: true
          },
          ...directories
        ]
      }
    } catch (err) {
      return { error: String(err) }
    }
  })

  registerFsMessagePackHandler<FsGlobArgs>('fs:glob', handleFsGlob)
  registerFsMessagePackHandler<FsSearchFilesArgs>('fs:search-files', handleFsSearchFiles)
  registerFsMessagePackHandler<FsGrepArgs>('fs:grep', handleFsGrep)

  registerMessagePackHandler<{ defaultName: string; dataUrl: string }>(
    'fs:save-image',
    async (args) => {
      const win = BrowserWindow.getFocusedWindow()
      if (!win) return { canceled: true }
      const result = await dialog.showSaveDialog(win, {
        defaultPath: args.defaultName,
        filters: [{ name: 'PNG Image', extensions: ['png'] }]
      })
      if (result.canceled || !result.filePath) return { canceled: true }
      try {
        const base64 = args.dataUrl.replace(/^data:image\/\w+;base64,/, '')
        const writeResult = await nativeToolRequest<FileMutationResult>('fs/write-file-binary', {
          path: result.filePath,
          data: base64
        })
        if (!writeResult.success) {
          return { error: writeResult.error ?? 'Native image save failed' }
        }
        return { success: true, filePath: result.filePath }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  registerMessagePackHandler<
    { defaultPath?: string; filters?: Electron.FileFilter[] } | undefined
  >('fs:select-save-file', async (args) => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return { canceled: true }
    const result = await dialog.showSaveDialog(win, {
      defaultPath: args?.defaultPath,
      filters: args?.filters
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    return { path: result.filePath }
  })

  // Binary file read/write returns or accepts base64; use MessagePack from renderer for large data.
  registerFsMessagePackHandler<FsReadFileBinaryArgs>('fs:read-file-binary', handleFsReadFileBinary)
  registerFsMessagePackHandler<FsWriteFileBinaryArgs>('fs:write-file-binary', handleFsWriteFileBinary)

  // File watching
  const fileWatchers = new Map<string, WatchedFileEntry>()

  registerMessagePackHandler<{ path: string }>('fs:watch-file', async (args, event) => {
    const filePath = path.resolve(args.path)
    const existing = fileWatchers.get(filePath)
    if (existing) {
      existing.refCount += 1
      addInvokeWindowSubscription(existing.windowRefs, event)
      return { success: true, path: filePath }
    }

    try {
      let watchEntry: WatchedFileEntry | null = null
      const watcher = fs.watch(path.dirname(filePath), (_eventType, filename) => {
        if (!watchEntry) return
        if (!watchedFilenameMatches(watchEntry, filename)) return
        scheduleFileChanged(watchEntry)
      })

      const entry: WatchedFileEntry = {
        watcher,
        refCount: 1,
        windowRefs: new Map<number, number>(),
        timer: null,
        filePath,
        baseName: path.basename(filePath)
      }
      watchEntry = entry
      addInvokeWindowSubscription(entry.windowRefs, event)
      entry.watcher.on('error', () => {
        watchEntry?.watcher.close()
        if (watchEntry?.timer) clearTimeout(watchEntry.timer)
        fileWatchers.delete(filePath)
      })
      fileWatchers.set(filePath, entry)
      return { success: true, path: filePath }
    } catch (err) {
      return { error: String(err) }
    }
  })

  registerMessagePackHandler<{ path: string }>('fs:unwatch-file', async (args, event) => {
    const filePath = path.resolve(args.path)
    const entry = fileWatchers.get(filePath)
    if (!entry) return { success: true }

    entry.refCount -= 1
    removeInvokeWindowSubscription(entry.windowRefs, event)
    if (entry.refCount > 0) return { success: true }

    entry.watcher.close()
    if (entry.timer) clearTimeout(entry.timer)
    fileWatchers.delete(filePath)
    return { success: true }
  })

  // Directory watching
  const dirWatchers = new Map<string, WatchedDirectoryEntry>()

  registerMessagePackHandler<{ path: string; recursive?: boolean }>(
    'fs:watch-dir',
    async (args, event) => {
      const dirPath = path.resolve(args.path)
      const recursive = args.recursive === true
      const key = directoryWatchKey(dirPath, recursive)
      const existing = dirWatchers.get(key)
      if (existing) {
        existing.refCount += 1
        addInvokeWindowSubscription(existing.windowRefs, event)
        return { success: true }
      }

      let createdEntry: WatchedDirectoryEntry | null = null
      try {
        const stats = await fs.promises.stat(dirPath)
        if (!stats.isDirectory()) {
          return { error: `Path is not a directory: ${dirPath}` }
        }

        const existingAfterStat = dirWatchers.get(key)
        if (existingAfterStat) {
          existingAfterStat.refCount += 1
          addInvokeWindowSubscription(existingAfterStat.windowRefs, event)
          return { success: true }
        }

        const entry: WatchedDirectoryEntry = {
          rootPath: dirPath,
          recursive,
          refCount: 1,
          windowRefs: new Map<number, number>(),
          watchers: new Map<string, fs.FSWatcher>(),
          timer: null,
          syncTimer: null,
          syncing: false,
          closed: false
        }
        addInvokeWindowSubscription(entry.windowRefs, event)
        createdEntry = entry
        dirWatchers.set(key, entry)
        await syncDirectoryWatchers(entry)
        return { success: true, recursive, watched: entry.watchers.size }
      } catch (err) {
        if (createdEntry && dirWatchers.get(key) === createdEntry) {
          closeDirectoryWatchEntry(createdEntry)
          dirWatchers.delete(key)
        }
        return { error: String(err) }
      }
    }
  )

  registerMessagePackHandler<{ path: string; recursive?: boolean }>(
    'fs:unwatch-dir',
    async (args, event) => {
      const dirPath = path.resolve(args.path)
      const candidateKeys =
        typeof args.recursive === 'boolean'
          ? [directoryWatchKey(dirPath, args.recursive)]
          : [directoryWatchKey(dirPath, true), directoryWatchKey(dirPath, false)]

      for (const key of candidateKeys) {
        const entry = dirWatchers.get(key)
        if (!entry) continue

        entry.refCount -= 1
        removeInvokeWindowSubscription(entry.windowRefs, event)
        if (entry.refCount > 0) continue

        closeDirectoryWatchEntry(entry)
        dirWatchers.delete(key)
      }

      return { success: true }
    }
  )

  registerMessagePackHandler<
    { filters?: Electron.FileFilter[]; multiSelections?: boolean } | undefined
  >('fs:select-file', async (args) => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return { canceled: true }
    const result = await dialog.showOpenDialog(win, {
      properties: args?.multiSelections ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: args?.filters ?? [
        {
          name: 'Documents',
          extensions: [
            'md',
            'txt',
            'docx',
            'pdf',
            'html',
            'csv',
            'json',
            'xml',
            'yaml',
            'yml',
            'ts',
            'js',
            'tsx',
            'jsx'
          ]
        },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    return {
      path: result.filePaths[0],
      paths: result.filePaths
    }
  })

  registerMessagePackHandler<{ previousUrl?: string | null } | undefined>(
    'fs:import-profile-avatar',
    async (args) => {
      const win = BrowserWindow.getFocusedWindow()
      if (!win) return { canceled: true }

      const result = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [
          {
            name: 'Images',
            extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif']
          }
        ]
      })
      if (result.canceled || result.filePaths.length === 0) return { canceled: true }

      const sourcePath = result.filePaths[0]
      const extension = path.extname(sourcePath).toLowerCase()
      if (!PROFILE_AVATAR_EXTENSIONS.has(extension)) {
        return { error: `Unsupported image type: ${extension || 'unknown'}` }
      }

      try {
        await assertFileSize(sourcePath, MAX_PROFILE_AVATAR_BYTES)

        const avatarDir = path.join(app.getPath('userData'), 'profile-avatars')
        await fs.promises.mkdir(avatarDir, { recursive: true })
        const targetPath = path.join(avatarDir, `avatar-${Date.now()}-${randomUUID()}${extension}`)

        await fs.promises.copyFile(sourcePath, targetPath)
        await deletePreviousProfileAvatar(args?.previousUrl, avatarDir)

        return {
          path: targetPath,
          url: pathToFileURL(targetPath).toString()
        }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  registerFsMessagePackHandler<FsReadDocumentArgs>('fs:read-document', handleFsReadDocument)
}
