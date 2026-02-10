import { ipcMain, dialog, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { globSync } from 'glob'

export function registerFsHandlers(): void {
  ipcMain.handle('fs:read-file', async (_event, args: { path: string; offset?: number; limit?: number }) => {
    try {
      const content = fs.readFileSync(args.path, 'utf-8')
      if (args.offset !== undefined || args.limit !== undefined) {
        const lines = content.split('\n')
        const start = (args.offset ?? 1) - 1
        const end = args.limit ? start + args.limit : lines.length
        return lines.slice(start, end).map((line, i) => `${start + i + 1}\t${line}`).join('\n')
      }
      return content
    } catch (err) {
      return JSON.stringify({ error: String(err) })
    }
  })

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
        path: path.join(args.path, e.name),
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
      properties: ['openDirectory'],
    })
    if (result.canceled) return { canceled: true }
    return { path: result.filePaths[0] }
  })

  ipcMain.handle('fs:glob', async (_event, args: { pattern: string; path?: string }) => {
    try {
      const matches = globSync(args.pattern, { cwd: args.path || process.cwd() })
      return matches
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle('fs:grep', async (_event, args: { pattern: string; path?: string; include?: string }) => {
    try {
      const searchDir = args.path || process.cwd()
      const results: { file: string; line: number; text: string }[] = []
      const regex = new RegExp(args.pattern)

      const searchFile = (filePath: string): void => {
        try {
          const content = fs.readFileSync(filePath, 'utf-8')
          const lines = content.split('\n')
          lines.forEach((line, i) => {
            if (regex.test(line)) {
              results.push({ file: filePath, line: i + 1, text: line.trim() })
            }
          })
        } catch {
          // Skip unreadable files
        }
      }

      const walkDir = (dir: string): void => {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true })
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name)
            if (entry.isDirectory()) {
              if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
                walkDir(fullPath)
              }
            } else if (entry.isFile()) {
              if (args.include) {
                const ext = path.extname(entry.name)
                if (!args.include.includes(ext) && !args.include.includes(`*${ext}`)) continue
              }
              searchFile(fullPath)
            }
          }
        } catch {
          // Skip unreadable dirs
        }
      }

      walkDir(searchDir)
      return results.slice(0, 100) // Limit results
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
}
