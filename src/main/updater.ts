import { app, BrowserWindow, dialog, type MessageBoxOptions } from 'electron'
import { autoUpdater } from 'electron-updater'
import { writeCrashLog } from './crash-logger'

const UPDATE_CHECK_DELAY_MS = 6_000

type WindowGetter = () => BrowserWindow | null
type QuitMarker = () => void

interface AutoUpdateOptions {
  getMainWindow: WindowGetter
  markAppWillQuit: QuitMarker
}

let initialized = false
let ignoredVersion: string | null = null
let prompting = false

function getValidWindow(getMainWindow: WindowGetter): BrowserWindow | undefined {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    return undefined
  }
  return win
}

function showMessage(getMainWindow: WindowGetter, options: MessageBoxOptions) {
  const win = getValidWindow(getMainWindow)
  if (win) {
    return dialog.showMessageBox(win, options)
  }
  return dialog.showMessageBox(options)
}

function getReleaseNotesText(releaseNotes: unknown): string {
  if (!releaseNotes) return ''
  if (typeof releaseNotes === 'string') return releaseNotes.trim()

  if (Array.isArray(releaseNotes)) {
    return releaseNotes
      .map((item) => {
        if (!item || typeof item !== 'object') return ''
        const note = (item as { note?: unknown }).note
        return typeof note === 'string' ? note.trim() : ''
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
  if (prompting || ignoredVersion === info.version) return
  prompting = true

  const releaseNotes = getReleaseNotesText(info.releaseNotes)
  const detailLines = [
    `当前版本：${app.getVersion()}`,
    `检测到新版本：${info.version}`,
    '将根据当前系统自动下载对应安装包，下载完成后自动安装并重启。',
  ]
  if (releaseNotes) {
    detailLines.push('', '更新说明：', releaseNotes)
  }

  try {
    const result = await showMessage(options.getMainWindow, {
      type: 'info',
      title: '发现新版本',
      message: `检测到新版本 ${info.version}`,
      detail: detailLines.join('\n'),
      buttons: ['立即更新', '稍后提醒'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })

    if (result.response === 0) {
      await autoUpdater.downloadUpdate()
      return
    }

    ignoredVersion = info.version
    console.log(`[Updater] User postponed update ${info.version}`)
  } catch (error) {
    const message = formatErrorMessage(error)
    console.error('[Updater] Failed to start update download:', error)
    writeCrashLog('updater_download_start_failed', { message, error })
    await showMessage(options.getMainWindow, {
      type: 'error',
      title: '更新失败',
      message: '启动更新下载失败',
      detail: message,
      buttons: ['确定'],
      defaultId: 0,
      noLink: true,
    })
  } finally {
    prompting = false
  }
}

function handleDownloadProgress(
  progress: { percent: number },
  getMainWindow: WindowGetter
): void {
  const win = getValidWindow(getMainWindow)
  if (!win) return

  const progressValue = Math.max(0, Math.min(1, progress.percent / 100))
  win.setProgressBar(progressValue, { mode: 'normal' })
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
    console.log('[Updater] Skip update check in development mode')
    return
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
    void showMessage(options.getMainWindow, {
      type: 'error',
      title: '更新失败',
      message: '自动更新过程中出现错误',
      detail: message,
      buttons: ['确定'],
      defaultId: 0,
      noLink: true,
    })
  })

  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((error) => {
      const message = formatErrorMessage(error)
      console.error('[Updater] checkForUpdates failed:', error)
      writeCrashLog('updater_check_failed', { message, error })
    })
  }, UPDATE_CHECK_DELAY_MS)
}
