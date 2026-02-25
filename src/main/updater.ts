import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import { writeCrashLog } from './crash-logger'

type WindowGetter = () => BrowserWindow | null
type QuitMarker = () => void

interface AutoUpdateOptions {
  getMainWindow: WindowGetter
  markAppWillQuit: QuitMarker
}

let initialized = false
let prompting = false

function getValidWindow(getMainWindow: WindowGetter): BrowserWindow | undefined {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    return undefined
  }
  return win
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<h[1-6]>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li>/gi, '• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p>/gi, '')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<strong>/gi, '')
    .replace(/<\/strong>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function getReleaseNotesText(releaseNotes: unknown): string {
  if (!releaseNotes) return ''
  if (typeof releaseNotes === 'string') {
    const stripped = stripHtmlTags(releaseNotes.trim())
    return stripped
  }

  if (Array.isArray(releaseNotes)) {
    return releaseNotes
      .map((item) => {
        if (!item || typeof item !== 'object') return ''
        const note = (item as { note?: unknown }).note
        return typeof note === 'string' ? stripHtmlTags(note.trim()) : ''
      })
      .filter((item) => item.length > 0)
      .join('\n\n')
  }

  return ''
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

async function handleUpdateAvailable(
  info: { version: string; releaseNotes?: unknown },
  options: AutoUpdateOptions
): Promise<void> {
  if (prompting) return
  prompting = true

  const win = getValidWindow(options.getMainWindow)
  if (!win) {
    prompting = false
    return
  }

  const releaseNotes = getReleaseNotesText(info.releaseNotes)
  const currentVersion = app.getVersion()

  // Send update notification to renderer process
  win.webContents.send('update:available', {
    currentVersion,
    newVersion: info.version,
    releaseNotes,
  })

  console.log(`[Updater] Sent update notification to renderer: ${info.version}`)
  prompting = false
}

function handleDownloadProgress(
  progress: { percent: number },
  getMainWindow: WindowGetter
): void {
  const win = getValidWindow(getMainWindow)
  if (!win) return

  const progressValue = Math.max(0, Math.min(1, progress.percent / 100))
  win.setProgressBar(progressValue, { mode: 'normal' })

  // Send progress to renderer
  win.webContents.send('update:download-progress', {
    percent: progress.percent,
  })
}

function clearWindowProgress(getMainWindow: WindowGetter): void {
  const win = getValidWindow(getMainWindow)
  if (!win) return
  win.setProgressBar(-1)
}

function handleUpdateDownloaded(
  info: { version: string },
  options: AutoUpdateOptions
): void {
  console.log(`[Updater] Update ${info.version} downloaded. Installing...`)
  writeCrashLog('updater_update_downloaded', { version: info.version })
  clearWindowProgress(options.getMainWindow)

  const win = getValidWindow(options.getMainWindow)
  if (win) {
    win.webContents.send('update:downloaded', { version: info.version })
  }

  options.markAppWillQuit()

  setTimeout(() => {
    try {
      autoUpdater.quitAndInstall(false, true)
    } catch (error) {
      const message = formatErrorMessage(error)
      console.error('[Updater] quitAndInstall failed:', error)
      writeCrashLog('updater_quit_and_install_failed', { message, error })
      options.markAppWillQuit()
      app.quit()
    }
  }, 600)
}

export function setupAutoUpdater(options: AutoUpdateOptions): void {
  if (initialized) return
  initialized = true

  // Register IPC handler for download trigger
  ipcMain.handle('update:download', async () => {
    try {
      console.log('[Updater] User requested download')
      await autoUpdater.downloadUpdate()
      return { success: true }
    } catch (error) {
      const message = formatErrorMessage(error)
      console.error('[Updater] Download failed:', error)
      return { success: false, error: message }
    }
  })

  // TEMPORARY: Allow update check in development mode for testing
  if (!app.isPackaged) {
    console.log('[Updater] Running in development mode - using dev-app-update.yml')
    // In dev mode, manually trigger a test update notification after 2 seconds
    setTimeout(() => {
      console.log('[Updater] DEV MODE: Simulating update check...')
      void autoUpdater.checkForUpdates().catch((error) => {
        console.error('[Updater] DEV MODE: Check failed:', error)
      })
    }, 2000)
  }

  if (process.platform !== 'win32' && process.platform !== 'linux') {
    console.log(`[Updater] Skip update check on unsupported platform: ${process.platform}`)
    return
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false

  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] Checking for updates...')
  })

  autoUpdater.on('update-available', (info) => {
    console.log(`[Updater] Update available: ${info.version}`)
    writeCrashLog('updater_update_available', { version: info.version })
    void handleUpdateAvailable(info, options)
  })

  autoUpdater.on('update-not-available', (info) => {
    console.log(`[Updater] No update available (latest: ${info.version})`)
  })

  autoUpdater.on('download-progress', (progress) => {
    handleDownloadProgress(progress, options.getMainWindow)
  })

  autoUpdater.on('update-downloaded', (info) => {
    handleUpdateDownloaded(info, options)
  })

  autoUpdater.on('error', (error) => {
    const message = formatErrorMessage(error)
    console.error('[Updater] Auto update failed:', error)
    writeCrashLog('updater_error', { message, error })
    clearWindowProgress(options.getMainWindow)

    const win = getValidWindow(options.getMainWindow)
    if (win) {
      win.webContents.send('update:error', { error: message })
    }
  })

  // Check for updates immediately on startup
  void autoUpdater.checkForUpdates().catch((error) => {
    const message = formatErrorMessage(error)
    console.error('[Updater] checkForUpdates failed:', error)
    writeCrashLog('updater_check_failed', { message, error })
  })
}
