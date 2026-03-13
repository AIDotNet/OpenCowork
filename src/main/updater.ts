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
const notifiedAvailableVersions = new Set<string>()
let checkForUpdatesPromise: Promise<unknown> | null = null
let downloadUpdatePromise: Promise<unknown> | null = null

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
  const message = error instanceof Error ? error.message : String(error)

  if (/latest-mac\.yml/.test(message) && /\b404\b/.test(message)) {
    return 'Current release is missing macOS update metadata (latest-mac.yml). Rebuild the release and upload the macOS zip/update metadata assets.'
  }

  if (/latest\.yml/.test(message) && /\b404\b/.test(message)) {
    return 'Current release is missing update metadata (latest.yml). Rebuild the release and upload the updater metadata assets.'
  }

  if (/\b404\b/.test(message) && /releases\/download/.test(message)) {
    return `Update package not found in this release (${message}). The release asset filename in latest.yml does not match the uploaded file.`
  }

  return message
}

function normalizeVersion(version: string | null | undefined): string {
  return (version ?? '').trim().replace(/^v/i, '')
}

function compareVersions(left: string, right: string): number {
  const leftParts = normalizeVersion(left).split('-')[0].split('.')
  const rightParts = normalizeVersion(right).split('-')[0].split('.')
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const leftValue = Number.parseInt(leftParts[index] ?? '0', 10)
    const rightValue = Number.parseInt(rightParts[index] ?? '0', 10)
    const safeLeftValue = Number.isFinite(leftValue) ? leftValue : 0
    const safeRightValue = Number.isFinite(rightValue) ? rightValue : 0

    if (safeLeftValue !== safeRightValue) {
      return safeLeftValue > safeRightValue ? 1 : -1
    }
  }

  return 0
}

function isNewerVersion(
  candidate: string | null | undefined,
  current: string | null | undefined
): boolean {
  const normalizedCandidate = normalizeVersion(candidate)
  const normalizedCurrent = normalizeVersion(current)

  if (!normalizedCandidate || !normalizedCurrent) {
    return false
  }

  return compareVersions(normalizedCandidate, normalizedCurrent) > 0
}

async function checkForUpdatesSafely(): Promise<unknown> {
  if (!checkForUpdatesPromise) {
    checkForUpdatesPromise = autoUpdater.checkForUpdates().finally(() => {
      checkForUpdatesPromise = null
    })
  }

  return checkForUpdatesPromise
}

async function downloadUpdateSafely(): Promise<unknown> {
  if (!downloadUpdatePromise) {
    downloadUpdatePromise = autoUpdater.downloadUpdate().finally(() => {
      downloadUpdatePromise = null
    })
  }

  return downloadUpdatePromise
}

async function handleUpdateAvailable(
  info: { version: string; releaseNotes?: unknown },
  options: AutoUpdateOptions
): Promise<void> {
  const win = getValidWindow(options.getMainWindow)
  if (!win) {
    return
  }

  const currentVersion = normalizeVersion(app.getVersion())
  const newVersion = normalizeVersion(info.version)

  if (!isNewerVersion(newVersion, currentVersion)) {
    console.log(
      `[Updater] Ignoring non-newer update event: current=${currentVersion}, latest=${newVersion}`
    )
    return
  }

  if (notifiedAvailableVersions.has(newVersion)) {
    console.log(`[Updater] Ignoring duplicate update notification for version ${newVersion}`)
    return
  }

  const releaseNotes = getReleaseNotesText(info.releaseNotes)

  win.webContents.send('update:available', {
    currentVersion,
    newVersion,
    releaseNotes
  })

  notifiedAvailableVersions.add(newVersion)
  writeCrashLog('updater_update_available', { version: newVersion, currentVersion })
  console.log(`[Updater] Sent update notification to renderer: ${newVersion}`)
}

function handleDownloadProgress(progress: { percent: number }, getMainWindow: WindowGetter): void {
  const win = getValidWindow(getMainWindow)
  if (!win) return

  const progressValue = Math.max(0, Math.min(1, progress.percent / 100))
  win.setProgressBar(progressValue, { mode: 'normal' })

  // Send progress to renderer
  win.webContents.send('update:download-progress', {
    percent: progress.percent
  })
}

function clearWindowProgress(getMainWindow: WindowGetter): void {
  const win = getValidWindow(getMainWindow)
  if (!win) return
  win.setProgressBar(-1)
}

function handleUpdateDownloaded(info: { version: string }, options: AutoUpdateOptions): void {
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

  if (!app.isPackaged) {
    // Allow update check/download in development for manual testing.
    // This uses dev-app-update.yml in the project root.
    autoUpdater.forceDevUpdateConfig = true
  }

  // Register IPC handler for manual update check (Settings > General)
  ipcMain.handle('update:check', async () => {
    try {
      console.log('[Updater] User requested update check')
      const result = (await checkForUpdatesSafely()) as { updateInfo?: { version?: string } } | null
      const currentVersion = normalizeVersion(app.getVersion())

      if (!result) {
        return {
          success: true,
          available: false,
          currentVersion,
          latestVersion: null,
          skipped: true
        }
      }

      const latestVersion = normalizeVersion(result.updateInfo?.version ?? null) || null
      const available = isNewerVersion(latestVersion, currentVersion)
      return { success: true, available, currentVersion, latestVersion, skipped: false }
    } catch (error) {
      const message = formatErrorMessage(error)
      console.error('[Updater] Check failed:', error)
      return { success: false, error: message }
    }
  })

  // Register IPC handler for download trigger
  ipcMain.handle('update:download', async () => {
    try {
      console.log('[Updater] User requested download')
      await downloadUpdateSafely()
      return { success: true }
    } catch (error) {
      const message = formatErrorMessage(error)
      console.error('[Updater] Download failed:', error)
      return { success: false, error: message }
    }
  })

  if (!app.isPackaged) {
    console.log('[Updater] Running in development mode - using dev-app-update.yml')
  }

  if (process.platform !== 'win32' && process.platform !== 'linux' && process.platform !== 'darwin') {
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
  void checkForUpdatesSafely().catch((error) => {
    const message = formatErrorMessage(error)
    console.error('[Updater] checkForUpdates failed:', error)
    writeCrashLog('updater_check_failed', { message, error })
  })
}
