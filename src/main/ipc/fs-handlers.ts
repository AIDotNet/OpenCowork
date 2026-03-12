import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { glob } from 'glob'
import { createInterface } from 'readline'
import { recordLocalTextWriteChange } from './agent-change-handlers'
import { createGitIgnoreMatcher } from './gitignore-utils'

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
  '.svg',
  '.ico',
  '.tiff',
  '.heic',
  '.heif'
])

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif'
}

type GrepResultItem = { file: string; line: number; text: string }
type GrepLimitReason = 'max_results' | 'max_output_bytes' | 'timeout' | null

interface GrepCollector {
  results: GrepResultItem[]
  append: (filePath: string, line: number, text: string) => boolean
  readonly limitReason: GrepLimitReason
  readonly truncated: boolean
}

const GREP_IGNORE_DIRS = new Set([
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
])

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildGlobIgnorePatterns(pattern: string): string[] {
  const normalizedPattern = pattern.replace(/\\/g, '/')
  const ignorePatterns: string[] = []

  for (const dirName of GREP_IGNORE_DIRS) {
    const targetsDir = new RegExp(`(^|/)${escapeRegex(dirName)}(/|$)`).test(normalizedPattern)
    if (targetsDir) continue

    ignorePatterns.push(`${dirName}`)
    ignorePatterns.push(`${dirName}/**`)
    ignorePatterns.push(`**/${dirName}`)
    ignorePatterns.push(`**/${dirName}/**`)
  }

  return ignorePatterns
}

const GREP_BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
  '.svg',
  '.ico',
  '.mp4',
  '.avi',
  '.mov',
  '.mkv',
  '.mp3',
  '.wav',
  '.flac',
  '.zip',
  '.tar',
  '.gz',
  '.rar',
  '.7z',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.db',
  '.sqlite',
  '.sqlite3'
])

const GREP_MAX_RESULTS = 50
const GREP_MAX_FILE_SIZE = 10 * 1024 * 1024
const GREP_TIMEOUT_MS = 30000
const GREP_MAX_LINE_LENGTH = 160
const GREP_MAX_OUTPUT_BYTES = 8 * 1024

function parseIncludePatterns(include?: string): string[] {
  return (include ?? '')
    .split(',')
    .map((pattern) => pattern.trim())
    .filter(Boolean)
}

function normalizeGrepLine(text: string): string {
  const normalized = text.trim()
  if (normalized.length <= GREP_MAX_LINE_LENGTH) return normalized
  return `${normalized.slice(0, GREP_MAX_LINE_LENGTH - 1)}…`
}

function createIncludeMatcher(
  searchRoot: string,
  includePatterns: string[]
): (filePath: string) => boolean {
  if (includePatterns.length === 0) return () => true

  const includeRegexCache = new Map<string, RegExp>()
  const escapeRegExp = (value: string): string => value.replace(/[.+^${}()|[\]\\]/g, '\\$&')

  const toIncludeRegex = (globPattern: string): RegExp => {
    const cached = includeRegexCache.get(globPattern)
    if (cached) return cached

    const pattern = globPattern.replace(/\\/g, '/')
    const escaped = escapeRegExp(pattern)
    const regexBody = escaped
      .replace(/\*\*/g, '__DOUBLE_STAR__')
      .replace(/\*/g, '[^/]*')
      .replace(/__DOUBLE_STAR__/g, '.*')
      .replace(/\?/g, '.')

    const compiled = new RegExp(`^${regexBody}$`, 'i')
    includeRegexCache.set(globPattern, compiled)
    return compiled
  }

  return (filePath: string): boolean => {
    const relPath = path.relative(searchRoot, filePath).replace(/\\/g, '/')
    const fileName = path.basename(filePath)
    const ext = path.extname(filePath).toLowerCase()

    return includePatterns.some((rawPattern) => {
      let pattern = rawPattern.replace(/\\/g, '/')
      if (pattern.startsWith('./')) pattern = pattern.slice(2)
      if (pattern.startsWith('**/')) pattern = pattern.slice(3)

      if (pattern.startsWith('*.') && !pattern.includes('/')) {
        return ext === pattern.slice(1).toLowerCase()
      }

      if (!pattern.includes('*') && !pattern.includes('?')) {
        const lowered = pattern.toLowerCase()
        return (
          fileName.toLowerCase() === lowered || relPath.toLowerCase() === lowered || ext === lowered
        )
      }

      const regexPattern = toIncludeRegex(pattern)
      return regexPattern.test(relPath) || regexPattern.test(fileName)
    })
  }
}

function normalizeRipgrepGlob(pattern: string): string {
  let normalized = pattern.replace(/\\/g, '/')
  if (normalized.startsWith('./')) normalized = normalized.slice(2)
  if (normalized.startsWith('**/')) normalized = normalized.slice(3)
  if (!normalized.includes('*') && !normalized.includes('?') && normalized.startsWith('.')) {
    return `*${normalized}`
  }
  return normalized
}

function isBinaryFile(filePath: string): boolean {
  try {
    const ext = path.extname(filePath).toLowerCase()
    if (GREP_BINARY_EXTENSIONS.has(ext)) return true

    const buffer = Buffer.alloc(512)
    const fd = fs.openSync(filePath, 'r')
    const bytesRead = fs.readSync(fd, buffer, 0, 512, 0)
    fs.closeSync(fd)

    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return true
    }
    return false
  } catch {
    return true
  }
}

function createGrepCollector(searchRoot: string): GrepCollector {
  const results: GrepResultItem[] = []
  let totalBytes = 2
  let limitReason: GrepLimitReason = null

  return {
    results,
    append(filePath: string, line: number, text: string): boolean {
      if (results.length >= GREP_MAX_RESULTS) {
        limitReason ??= 'max_results'
        return false
      }

      const candidate: GrepResultItem = {
        file: path.relative(searchRoot, filePath),
        line,
        text: normalizeGrepLine(text)
      }
      const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8') + 1
      if (totalBytes + candidateBytes > GREP_MAX_OUTPUT_BYTES) {
        limitReason ??= 'max_output_bytes'
        return false
      }

      results.push(candidate)
      totalBytes += candidateBytes
      return true
    },
    get limitReason(): GrepLimitReason {
      return limitReason
    },
    get truncated(): boolean {
      return limitReason !== null
    }
  }
}

async function scanFileForMatches(
  filePath: string,
  regex: RegExp,
  collector: GrepCollector,
  startTime: number
): Promise<'continue' | 'limit' | 'timeout'> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  try {
    let lineNumber = 0
    for await (const line of rl) {
      lineNumber += 1
      if (Date.now() - startTime > GREP_TIMEOUT_MS) return 'timeout'
      if (regex.test(line) && !collector.append(filePath, lineNumber, line)) return 'limit'
    }
    return 'continue'
  } finally {
    rl.close()
    stream.destroy()
  }
}

async function findLocalGitIgnoreRoot(startDir: string): Promise<string> {
  let currentDir = path.resolve(startDir)

  while (true) {
    if (fs.existsSync(path.join(currentDir, '.git'))) {
      return currentDir
    }

    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) {
      return path.resolve(startDir)
    }
    currentDir = parentDir
  }
}

async function createLocalGitIgnoreContext(
  searchTarget: string,
  extraPatterns?: string[]
): Promise<ReturnType<typeof createGitIgnoreMatcher>> {
  const baseDir = path.resolve(searchTarget)
  const gitIgnoreRoot = await findLocalGitIgnoreRoot(baseDir)
  return createGitIgnoreMatcher({
    rootDir: gitIgnoreRoot,
    extraPatterns,
    readIgnoreFile: async (filePath) => {
      try {
        return await fs.promises.readFile(filePath, 'utf8')
      } catch {
        return null
      }
    }
  })
}

async function runRipgrepSearch(args: {
  pattern: string
  searchRoot: string
  searchTarget: string
  targetIsDirectory: boolean
  includePatterns: string[]
  startTime: number
}): Promise<{
  results: GrepResultItem[]
  truncated: boolean
  timedOut: boolean
  limitReason: GrepLimitReason
} | null> {
  const collector = createGrepCollector(args.searchRoot)
  const rgArgs = [
    '--json',
    '--line-number',
    '--color',
    'never',
    '--no-messages',
    '--ignore-case',
    '--hidden',
    '--max-filesize',
    `${Math.floor(GREP_MAX_FILE_SIZE / (1024 * 1024))}M`
  ]

  rgArgs.push('--glob', '!.*/**')
  rgArgs.push('--glob', '!**/.*/**')

  for (const dir of GREP_IGNORE_DIRS) {
    rgArgs.push('--glob', `!${dir}/**`)
    rgArgs.push('--glob', `!**/${dir}/**`)
  }

  for (const includePattern of args.includePatterns) {
    rgArgs.push('--glob', normalizeRipgrepGlob(includePattern))
  }

  rgArgs.push('--', args.pattern, args.targetIsDirectory ? '.' : path.basename(args.searchTarget))

  return await new Promise((resolve) => {
    const child = spawn('rg', rgArgs, {
      cwd: args.searchRoot,
      windowsHide: true
    })

    let timedOut = false
    let stdoutBuffer = ''
    let settled = false

    const finish = (
      value: {
        results: GrepResultItem[]
        truncated: boolean
        timedOut: boolean
        limitReason: GrepLimitReason
      } | null
    ): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    const processLine = (rawLine: string): void => {
      if (!rawLine.trim()) return

      try {
        const parsed = JSON.parse(rawLine) as {
          type?: string
          data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number }
        }
        if (parsed.type !== 'match') return

        const rawPath = parsed.data?.path?.text
        const lineNumber = parsed.data?.line_number
        const text = parsed.data?.lines?.text ?? ''
        if (typeof rawPath !== 'string' || typeof lineNumber !== 'number') return

        const absolutePath = path.isAbsolute(rawPath)
          ? rawPath
          : path.join(args.searchRoot, rawPath)
        if (!collector.append(absolutePath, lineNumber, text)) {
          child.kill()
        }
      } catch {
        finish(null)
      }
    }

    const flushStdout = (flush = false): void => {
      let newlineIndex = stdoutBuffer.indexOf('\n')
      while (newlineIndex !== -1 || (flush && stdoutBuffer.length > 0)) {
        const endIndex = newlineIndex === -1 ? stdoutBuffer.length : newlineIndex
        const line = stdoutBuffer.slice(0, endIndex)
        stdoutBuffer = stdoutBuffer.slice(Math.min(endIndex + 1, stdoutBuffer.length))
        processLine(line)
        if (settled) return
        newlineIndex = stdoutBuffer.indexOf('\n')
      }
    }

    const remainingTime = Math.max(1000, GREP_TIMEOUT_MS - (Date.now() - args.startTime))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, remainingTime)

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      flushStdout()
    })

    child.on('error', () => {
      finish(null)
    })

    child.on('close', (code) => {
      flushStdout(true)
      if (settled) return

      if (timedOut || collector.truncated) {
        finish({
          results: collector.results,
          truncated: true,
          timedOut,
          limitReason: timedOut ? 'timeout' : collector.limitReason
        })
        return
      }

      if (code === 0 || code === 1) {
        finish({
          results: collector.results,
          truncated: false,
          timedOut: false,
          limitReason: null
        })
        return
      }

      finish(null)
    })
  })
}

export function registerFsHandlers(): void {
  ipcMain.handle(
    'fs:read-file',
    async (_event, args: { path: string; offset?: number; limit?: number }) => {
      try {
        const ext = path.extname(args.path).toLowerCase()
        if (IMAGE_EXTENSIONS.has(ext)) {
          const buffer = fs.readFileSync(args.path)
          return {
            type: 'image',
            mediaType: IMAGE_MIME_TYPES[ext] || 'application/octet-stream',
            data: buffer.toString('base64')
          }
        }
        const content = fs.readFileSync(args.path, 'utf-8')
        if (args.offset !== undefined || args.limit !== undefined) {
          const lines = content.split('\n')
          const start = (args.offset ?? 1) - 1
          const end = args.limit ? start + args.limit : lines.length
          return lines
            .slice(start, end)
            .map((line, i) => `${start + i + 1}\t${line}`)
            .join('\n')
        }
        return content
      } catch (err) {
        return JSON.stringify({ error: String(err) })
      }
    }
  )

  ipcMain.handle(
    'fs:write-file',
    async (
      _event,
      args: {
        path: string
        content: string
        changeMeta?: { runId?: string; sessionId?: string; toolUseId?: string; toolName?: string }
      }
    ) => {
      try {
        const beforeExists = fs.existsSync(args.path)
        const beforeText = beforeExists ? fs.readFileSync(args.path, 'utf-8') : undefined
        const dir = path.dirname(args.path)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
        fs.writeFileSync(args.path, args.content, 'utf-8')
        recordLocalTextWriteChange({
          meta: args.changeMeta,
          filePath: args.path,
          beforeExists,
          beforeText,
          afterText: args.content
        })
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle('fs:list-dir', async (_event, args: { path: string; ignore?: string[] }) => {
    try {
      const resolvedPath = path.resolve(args.path)
      const matcher = await createLocalGitIgnoreContext(resolvedPath, args.ignore)
      const entries = await fs.promises.readdir(resolvedPath, { withFileTypes: true })
      const items: Array<{ name: string; type: 'directory' | 'file'; path: string }> = []

      for (const entry of entries) {
        const entryPath = path.join(resolvedPath, entry.name)
        if (await matcher.ignores(entryPath, entry.isDirectory())) continue
        if (!entry.isDirectory() && !entry.isFile()) continue

        items.push({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          path: entryPath
        })
      }

      return items
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle('fs:mkdir', async (_event, args: { path: string }) => {
    try {
      fs.mkdirSync(args.path, { recursive: true })
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle('fs:delete', async (_event, args: { path: string }) => {
    try {
      fs.rmSync(args.path, { recursive: true, force: true })
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle('fs:move', async (_event, args: { from: string; to: string }) => {
    try {
      fs.renameSync(args.from, args.to)
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle('fs:select-folder', async () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return { canceled: true }
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    })
    if (result.canceled) return { canceled: true }
    return { path: result.filePaths[0] }
  })

  ipcMain.handle('fs:list-desktop-directories', async () => {
    try {
      const desktopPath = app.getPath('desktop')
      const desktopName = path.basename(desktopPath) || 'Desktop'
      const directories = fs
        .readdirSync(desktopPath, { withFileTypes: true })
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

  ipcMain.handle('fs:glob', async (_event, args: { pattern: string; path?: string }) => {
    try {
      const cwd = path.resolve(args.path || process.cwd())
      const matcher = await createLocalGitIgnoreContext(cwd)
      const matches = await glob(args.pattern, {
        cwd,
        mark: true,
        ignore: buildGlobIgnorePatterns(args.pattern)
      })
      const filteredMatches: string[] = []

      for (const match of matches) {
        const isDir = /[\\/]$/.test(match)
        const normalizedMatch = match.replace(/[\\/]+$/, '')
        if (!normalizedMatch) continue
        const absolutePath = path.resolve(cwd, normalizedMatch)
        if (await matcher.ignores(absolutePath, isDir)) continue
        filteredMatches.push(normalizedMatch)
      }

      return filteredMatches
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle(
    'fs:grep',
    async (_event, args: { pattern: string; path?: string; include?: string }) => {
      try {
        const searchTarget = path.resolve(args.path || process.cwd())
        const startTime = Date.now()

        let targetStats: fs.Stats
        try {
          targetStats = await fs.promises.stat(searchTarget)
        } catch {
          return { error: `Search path does not exist: ${searchTarget}` }
        }

        let regex: RegExp
        try {
          regex = new RegExp(args.pattern, 'i')
        } catch (err) {
          return { error: `Invalid regex pattern: ${err}` }
        }

        const searchRoot = targetStats.isDirectory() ? searchTarget : path.dirname(searchTarget)
        const includePatterns = parseIncludePatterns(args.include)
        const matchesInclude = createIncludeMatcher(searchRoot, includePatterns)
        const gitIgnoreMatcher = targetStats.isDirectory()
          ? await createLocalGitIgnoreContext(searchRoot)
          : null

        const ripgrepResult = await runRipgrepSearch({
          pattern: args.pattern,
          searchRoot,
          searchTarget,
          targetIsDirectory: targetStats.isDirectory(),
          includePatterns,
          startTime
        })

        if (ripgrepResult) {
          return {
            results: ripgrepResult.results,
            truncated: ripgrepResult.truncated,
            timedOut: ripgrepResult.timedOut,
            limitReason: ripgrepResult.limitReason,
            searchTime: Date.now() - startTime
          }
        }

        const collector = createGrepCollector(searchRoot)
        let timedOut = false

        const searchFile = async (filePath: string): Promise<boolean> => {
          try {
            if (Date.now() - startTime > GREP_TIMEOUT_MS) {
              timedOut = true
              return true
            }

            const stats = await fs.promises.stat(filePath)
            if (stats.size > GREP_MAX_FILE_SIZE || stats.size === 0) return false
            if (gitIgnoreMatcher && (await gitIgnoreMatcher.ignores(filePath, false))) return false
            if (isBinaryFile(filePath)) return false

            const status = await scanFileForMatches(filePath, regex, collector, startTime)
            if (status === 'timeout') {
              timedOut = true
              return true
            }
            return status === 'limit'
          } catch {
            return false
          }
        }

        const walkDir = async (dir: string): Promise<boolean> => {
          try {
            if (Date.now() - startTime > GREP_TIMEOUT_MS) {
              timedOut = true
              return true
            }

            const entries = await fs.promises.readdir(dir, { withFileTypes: true })
            for (const entry of entries) {
              if (collector.truncated) return true

              const fullPath = path.join(dir, entry.name)
              if (entry.isDirectory()) {
                if (GREP_IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
                if (gitIgnoreMatcher && (await gitIgnoreMatcher.ignores(fullPath, true))) continue
                if (await walkDir(fullPath)) return true
                continue
              }

              if (!entry.isFile() || !matchesInclude(fullPath)) continue
              if (await searchFile(fullPath)) return true
            }
            return false
          } catch {
            return false
          }
        }

        if (targetStats.isDirectory()) {
          await walkDir(searchTarget)
        } else if (matchesInclude(searchTarget)) {
          await searchFile(searchTarget)
        }

        return {
          results: collector.results,
          truncated: collector.truncated || timedOut,
          timedOut,
          limitReason: timedOut ? 'timeout' : collector.limitReason,
          searchTime: Date.now() - startTime
        }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle(
    'fs:save-image',
    async (_event, args: { defaultName: string; dataUrl: string }) => {
      const win = BrowserWindow.getFocusedWindow()
      if (!win) return { canceled: true }
      const result = await dialog.showSaveDialog(win, {
        defaultPath: args.defaultName,
        filters: [{ name: 'PNG Image', extensions: ['png'] }]
      })
      if (result.canceled || !result.filePath) return { canceled: true }
      try {
        const base64 = args.dataUrl.replace(/^data:image\/\w+;base64,/, '')
        fs.writeFileSync(result.filePath, Buffer.from(base64, 'base64'))
        return { success: true, filePath: result.filePath }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle(
    'fs:select-save-file',
    async (_event, args?: { defaultPath?: string; filters?: Electron.FileFilter[] }) => {
      const win = BrowserWindow.getFocusedWindow()
      if (!win) return { canceled: true }
      const result = await dialog.showSaveDialog(win, {
        defaultPath: args?.defaultPath,
        filters: args?.filters
      })
      if (result.canceled || !result.filePath) return { canceled: true }
      return { path: result.filePath }
    }
  )

  // Binary file read (returns base64)
  ipcMain.handle('fs:read-file-binary', async (_event, args: { path: string }) => {
    try {
      const buffer = fs.readFileSync(args.path)
      return { data: buffer.toString('base64') }
    } catch (err) {
      return { error: String(err) }
    }
  })

  // Binary file write (accepts base64)
  ipcMain.handle('fs:write-file-binary', async (_event, args: { path: string; data: string }) => {
    try {
      const dir = path.dirname(args.path)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(args.path, Buffer.from(args.data, 'base64'))
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  // File watching
  const watchers = new Map<string, fs.FSWatcher>()
  const debounceTimers = new Map<string, NodeJS.Timeout>()

  ipcMain.handle('fs:watch-file', async (_event, args: { path: string }) => {
    const filePath = args.path
    if (watchers.has(filePath)) return { success: true }
    try {
      const watcher = fs.watch(filePath, () => {
        const existing = debounceTimers.get(filePath)
        if (existing) clearTimeout(existing)
        debounceTimers.set(
          filePath,
          setTimeout(() => {
            debounceTimers.delete(filePath)
            const win = BrowserWindow.getAllWindows()[0]
            if (win && !win.isDestroyed()) {
              win.webContents.send('fs:file-changed', { path: filePath })
            }
          }, 300)
        )
      })
      watchers.set(filePath, watcher)
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle('fs:unwatch-file', async (_event, args: { path: string }) => {
    const filePath = args.path
    const watcher = watchers.get(filePath)
    if (watcher) {
      watcher.close()
      watchers.delete(filePath)
    }
    const timer = debounceTimers.get(filePath)
    if (timer) {
      clearTimeout(timer)
      debounceTimers.delete(filePath)
    }
    return { success: true }
  })

  ipcMain.handle('fs:select-file', async (_event, args?: { filters?: Electron.FileFilter[] }) => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return { canceled: true }
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
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
    return { path: result.filePaths[0] }
  })

  ipcMain.handle('fs:read-document', async (_event, args: { path: string }) => {
    try {
      const ext = path.extname(args.path).toLowerCase()
      if (ext === '.docx') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mammoth = require('mammoth') as typeof import('mammoth')
        const result = await mammoth.extractRawText({ path: args.path })
        return { content: result.value, name: path.basename(args.path) }
      }
      const content = fs.readFileSync(args.path, 'utf-8')
      return { content, name: path.basename(args.path) }
    } catch (err) {
      return { error: String(err) }
    }
  })
}
