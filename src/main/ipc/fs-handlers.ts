import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { globSync } from 'glob'

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

  ipcMain.handle('fs:write-file', async (_event, args: { path: string; content: string }) => {
    try {
      const dir = path.dirname(args.path)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(args.path, args.content, 'utf-8')
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle('fs:list-dir', async (_event, args: { path: string; ignore?: string[] }) => {
    try {
      const entries = fs.readdirSync(args.path, { withFileTypes: true })
      return entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
        path: path.join(args.path, e.name)
      }))
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
      const matches = globSync(args.pattern, { cwd: args.path || process.cwd() })
      return matches
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle(
    'fs:grep',
    async (_event, args: { pattern: string; path?: string; include?: string }) => {
      try {
        const searchTarget = path.resolve(args.path || process.cwd())
        const results: { file: string; line: number; text: string }[] = []
        const MAX_RESULTS = 100
        const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB
        const TIMEOUT_MS = 30000 // 30 seconds
        const startTime = Date.now()

        let targetStats: fs.Stats
        try {
          targetStats = await fs.promises.stat(searchTarget)
        } catch {
          return { error: `Search path does not exist: ${searchTarget}` }
        }

        const searchRoot = targetStats.isDirectory() ? searchTarget : path.dirname(searchTarget)

        // Comprehensive ignore list (similar to ripgrep defaults)
        const IGNORE_DIRS = new Set([
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

        // Binary file extensions to skip
        const BINARY_EXTENSIONS = new Set([
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

        let regex: RegExp
        try {
          regex = new RegExp(args.pattern, 'i')
        } catch (err) {
          return { error: `Invalid regex pattern: ${err}` }
        }

        const includePatterns = (args.include ?? '')
          .split(',')
          .map((pattern) => pattern.trim())
          .filter(Boolean)

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

        const matchesInclude = (filePath: string): boolean => {
          if (includePatterns.length === 0) return true

          const relPath = path.relative(searchRoot, filePath).replace(/\\/g, '/')
          const fileName = path.basename(filePath)
          const ext = path.extname(filePath).toLowerCase()

          return includePatterns.some((rawPattern) => {
            let pattern = rawPattern.replace(/\\/g, '/')
            if (pattern.startsWith('./')) pattern = pattern.slice(2)

            // Common shorthand: "**/*.ts" should match any nested file extension.
            if (pattern.startsWith('**/')) {
              pattern = pattern.slice(3)
            }

            if (pattern.startsWith('*.') && !pattern.includes('/')) {
              return ext === pattern.slice(1).toLowerCase()
            }

            if (!pattern.includes('*') && !pattern.includes('?')) {
              const lowered = pattern.toLowerCase()
              return (
                fileName.toLowerCase() === lowered ||
                relPath.toLowerCase() === lowered ||
                ext === lowered
              )
            }

            const regexPattern = toIncludeRegex(pattern)
            return regexPattern.test(relPath) || regexPattern.test(fileName)
          })
        }

        // Check if file is likely binary by reading first few bytes
        const isBinaryFile = (filePath: string): boolean => {
          try {
            const ext = path.extname(filePath).toLowerCase()
            if (BINARY_EXTENSIONS.has(ext)) return true

            const buffer = Buffer.alloc(512)
            const fd = fs.openSync(filePath, 'r')
            const bytesRead = fs.readSync(fd, buffer, 0, 512, 0)
            fs.closeSync(fd)

            // Check for null bytes (common in binary files)
            for (let i = 0; i < bytesRead; i++) {
              if (buffer[i] === 0) return true
            }
            return false
          } catch {
            return true // Assume binary if can't read
          }
        }

        const searchFile = async (filePath: string): Promise<boolean> => {
          try {
            // Check timeout
            if (Date.now() - startTime > TIMEOUT_MS) {
              return true // Signal to stop
            }

            // Check file size
            const stats = await fs.promises.stat(filePath)
            if (stats.size > MAX_FILE_SIZE) return false
            if (stats.size === 0) return false

            // Skip binary files
            if (isBinaryFile(filePath)) return false

            // Read file asynchronously
            const content = await fs.promises.readFile(filePath, 'utf-8')
            const lines = content.split('\n')

            for (let i = 0; i < lines.length; i++) {
              if (results.length >= MAX_RESULTS) return true // Stop early

              const line = lines[i]
              if (regex.test(line)) {
                results.push({
                  file: path.relative(searchRoot, filePath),
                  line: i + 1,
                  text: line.trim().slice(0, 200) // Limit line length
                })
              }
            }
            return false
          } catch {
            return false // Skip unreadable files
          }
        }

        const walkDir = async (dir: string): Promise<boolean> => {
          try {
            // Check timeout
            if (Date.now() - startTime > TIMEOUT_MS) {
              return true
            }

            const entries = await fs.promises.readdir(dir, { withFileTypes: true })

            for (const entry of entries) {
              if (results.length >= MAX_RESULTS) return true

              const fullPath = path.join(dir, entry.name)

              if (entry.isDirectory()) {
                // Skip ignored directories
                if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) {
                  continue
                }
                const shouldStop = await walkDir(fullPath)
                if (shouldStop) return true
              } else if (entry.isFile()) {
                if (!matchesInclude(fullPath)) continue

                const shouldStop = await searchFile(fullPath)
                if (shouldStop) return true
              }
            }
            return false
          } catch {
            return false // Skip unreadable dirs
          }
        }

        const timedOut = targetStats.isDirectory()
          ? await walkDir(searchTarget)
          : matchesInclude(searchTarget)
            ? await searchFile(searchTarget)
            : false

        return {
          results,
          truncated: results.length >= MAX_RESULTS,
          timedOut,
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
