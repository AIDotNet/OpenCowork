import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { writeCrashLog } from './crash-logger'
import { safeSendMessagePackToWindow } from './window-ipc'
import { readSettings } from './ipc/settings-handlers'
import { getUpdateDistributionInfo, isAutoInstallUpdateSupported } from './distribution'

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
let macUpdaterUnsupportedReason: string | null | undefined
let lastReportedUpdaterError: { message: string; at: number } | null = null
let downloadedUpdateVersion: string | null = null

const GREEN_UPDATE_MESSAGE =
  'The no-install build does not support automatic updates. Download the latest version manually and replace the current folder after quitting the app.'

interface UpdaterLogger {
  info?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
  error?: (...args: unknown[]) => void
  debug?: (...args: unknown[]) => void
}

function isAutoUpdateEnabled(): boolean {
  const settings = readSettings()
  const persistedSettings = settings['opencowork-settings']

  if (!persistedSettings || typeof persistedSettings !== 'object') {
    return true
  }

  const state = (
    'state' in persistedSettings &&
    persistedSettings.state &&
    typeof persistedSettings.state === 'object'
      ? persistedSettings.state
      : persistedSettings
  ) as Record<string, unknown>

  return state.autoUpdateEnabled !== false
}

function getValidWindow(getMainWindow: WindowGetter): BrowserWindow | undefined {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    return undefined
  }
  return win
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
}

function stripHtmlTags(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function htmlToMarkdown(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<pre[^>]*>\s*<code[^>]*>/gi, '\n```\n')
      .replace(/<\/code>\s*<\/pre>/gi, '\n```\n')
      .replace(
        /<a [^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi,
        (_match, href: string, text: string) => {
          const label = stripHtmlTags(text).trim() || href
          return `[${label}](${href})`
        }
      )
      .replace(/<h1[^>]*>(.*?)<\/h1>/gi, (_match, text: string) => `# ${stripHtmlTags(text)}\n\n`)
      .replace(/<h2[^>]*>(.*?)<\/h2>/gi, (_match, text: string) => `## ${stripHtmlTags(text)}\n\n`)
      .replace(/<h3[^>]*>(.*?)<\/h3>/gi, (_match, text: string) => `### ${stripHtmlTags(text)}\n\n`)
      .replace(
        /<h4[^>]*>(.*?)<\/h4>/gi,
        (_match, text: string) => `#### ${stripHtmlTags(text)}\n\n`
      )
      .replace(
        /<h5[^>]*>(.*?)<\/h5>/gi,
        (_match, text: string) => `##### ${stripHtmlTags(text)}\n\n`
      )
      .replace(
        /<h6[^>]*>(.*?)<\/h6>/gi,
        (_match, text: string) => `###### ${stripHtmlTags(text)}\n\n`
      )
      .replace(/<li[^>]*>(.*?)<\/li>/gi, (_match, text: string) => `- ${stripHtmlTags(text)}\n`)
      .replace(/<strong[^>]*>/gi, '**')
      .replace(/<\/strong>/gi, '**')
      .replace(/<b[^>]*>/gi, '**')
      .replace(/<\/b>/gi, '**')
      .replace(/<em[^>]*>/gi, '*')
      .replace(/<\/em>/gi, '*')
      .replace(/<i[^>]*>/gi, '*')
      .replace(/<\/i>/gi, '*')
      .replace(/<code[^>]*>/gi, '`')
      .replace(/<\/code>/gi, '`')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<p[^>]*>/gi, '')
      .replace(/<\/?(ul|ol)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function formatReleaseNotesText(releaseNotes: string): string {
  const trimmed = releaseNotes.trim()
  if (!trimmed) return ''
  return /<[^>]+>/.test(trimmed) ? htmlToMarkdown(trimmed) : trimmed
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isTransientUpdateError(error: unknown): boolean {
  return /\b(ERR_TIMED_OUT|ETIMEDOUT|ERR_CONNECTION_RESET|ERR_CONNECTION_REFUSED|ERR_CONNECTION_CLOSED|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN)\b/i.test(
    getErrorMessage(error)
  )
}

function shouldReportUpdaterError(message: string): boolean {
  const now = Date.now()

  if (
    lastReportedUpdaterError &&
    lastReportedUpdaterError.message === message &&
    now - lastReportedUpdaterError.at < 5000
  ) {
    return false
  }

  lastReportedUpdaterError = { message, at: now }
  return true
}

function configureAutoUpdaterLogger(): void {
  ;(autoUpdater as typeof autoUpdater & { logger?: UpdaterLogger }).logger = {
    info: (...args: unknown[]) => console.log(...args),
    warn: (...args: unknown[]) => console.warn(...args),
    error: (...args: unknown[]) => {
      if (args.some((arg) => isTransientUpdateError(arg))) {
        return
      }

      console.error(...args)
    },
    debug: (...args: unknown[]) => console.debug(...args)
  }
}

function getMacAppBundlePath(): string | null {
  if (process.platform !== 'darwin') {
    return null
  }

  const executablePath = app.getPath('exe')
  const macOsPath = dirname(executablePath)
  const contentsPath = dirname(macOsPath)
  const appBundlePath = dirname(contentsPath)

  return appBundlePath.endsWith('.app') ? appBundlePath : null
}

function getUpdaterUnsupportedReason(): string | null {
  if (process.platform !== 'darwin' || !app.isPackaged) {
    return null
  }

  if (macUpdaterUnsupportedReason !== undefined) {
    return macUpdaterUnsupportedReason
  }

  const appBundlePath = getMacAppBundlePath()
  if (!appBundlePath) {
    macUpdaterUnsupportedReason =
      'Automatic updates are unavailable on this macOS build because the app bundle path could not be determined. Download the latest DMG manually.'
    return macUpdaterUnsupportedReason
  }

  const result = spawnSync('codesign', ['-dv', '--verbose=4', appBundlePath], {
    encoding: 'utf8'
  })
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n')

  if (result.status !== 0) {
    macUpdaterUnsupportedReason =
      'Automatic updates are unavailable on this macOS build because its code signature could not be inspected. Download the latest DMG manually.'
    return macUpdaterUnsupportedReason
  }

  const isAdHocSigned = /Signature=adhoc/i.test(output)
  const hasTrustedAuthority = /Authority=Developer ID Application:/i.test(output)

  macUpdaterUnsupportedReason =
    isAdHocSigned || !hasTrustedAuthority
      ? 'Automatic updates are disabled for this macOS build because it is ad-hoc signed or unsigned. ShipIt can only install updates for apps signed with a Developer ID Application certificate. Download the latest DMG manually.'
      : null

  return macUpdaterUnsupportedReason
}

function getReleaseNotesText(releaseNotes: unknown): string {
  if (!releaseNotes) return ''
  if (typeof releaseNotes === 'string') {
    return formatReleaseNotesText(releaseNotes)
  }

  if (Array.isArray(releaseNotes)) {
    return releaseNotes
      .map((item) => {
        if (!item || typeof item !== 'object') return ''
        const note = (item as { note?: unknown }).note
        return typeof note === 'string' ? formatReleaseNotesText(note) : ''
      })
      .filter((item) => item.length > 0)
      .join('\n\n')
  }

  return ''
}

function formatErrorMessage(error: unknown): string {
  const message = getErrorMessage(error)

  if (/\b(ERR_TIMED_OUT|ETIMEDOUT)\b/i.test(message)) {
    return 'Update request timed out. Check your network and try again later.'
  }

  if (isTransientUpdateError(error)) {
    return 'Unable to reach the update server. Check your network and try again later.'
  }

  if (
    /code signature/i.test(message) &&
    /(did not pass validation|代码未能满足指定的代码要求)/i.test(message)
  ) {
    return 'Automatic update installation failed because this macOS build is not signed with a compatible Developer ID certificate. Download the latest DMG manually.'
  }

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

  const payload = {
    currentVersion,
    newVersion,
    releaseNotes,
    ...getUpdateDistributionInfo()
  }
  safeSendMessagePackToWindow(win, 'update:available', payload)

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
  const payload = {
    percent: progress.percent
  }
  safeSendMessagePackToWindow(win, 'update:download-progress', payload)
}

function clearWindowProgress(getMainWindow: WindowGetter): void {
  const win = getValidWindow(getMainWindow)
  if (!win) return
  win.setProgressBar(-1)
}

function handleUpdateDownloaded(info: { version: string }, options: AutoUpdateOptions): void {
  console.log(`[Updater] Update ${info.version} downloaded. Waiting for user confirmation.`)
  downloadedUpdateVersion = normalizeVersion(info.version) || info.version
  writeCrashLog('updater_update_downloaded', { version: info.version })
  clearWindowProgress(options.getMainWindow)

  const win = getValidWindow(options.getMainWindow)
  if (win) {
    const payload = { version: info.version }
    safeSendMessagePackToWindow(win, 'update:downloaded', payload)
  }
}

function installDownloadedUpdate(
  options: AutoUpdateOptions
): { success: true } | { success: false; error: string } {
  if (!isAutoInstallUpdateSupported()) {
    return { success: false, error: GREEN_UPDATE_MESSAGE }
  }

  if (!downloadedUpdateVersion) {
    return { success: false, error: 'No downloaded update is ready to install.' }
  }

  console.log(`[Updater] Installing downloaded update ${downloadedUpdateVersion}`)
  writeCrashLog('updater_install_requested', { version: downloadedUpdateVersion })

  setTimeout(() => {
    try {
      options.markAppWillQuit()
      autoUpdater.quitAndInstall(false, true)
    } catch (error) {
      const message = formatErrorMessage(error)
      console.error('[Updater] quitAndInstall failed:', error)
      writeCrashLog('updater_quit_and_install_failed', { message, error })

      const win = getValidWindow(options.getMainWindow)
      if (win) {
        safeSendMessagePackToWindow(win, 'update:error', { error: message })
      }
    }
  }, 100)

  return { success: true }
}

export async function requestUpdateCheck(): Promise<
  | {
      success: true
      available: boolean
      currentVersion: string
      latestVersion: string | null
      skipped: boolean
      distribution: ReturnType<typeof getUpdateDistributionInfo>['distribution']
      supportsAutoInstall: boolean
      releaseUrl: string
    }
  | { success: false; error: string }
> {
  try {
    console.log('[Updater] User requested update check')
    const unsupportedReason = getUpdaterUnsupportedReason()
    if (unsupportedReason) {
      return { success: false, error: unsupportedReason }
    }

    const result = (await checkForUpdatesSafely()) as { updateInfo?: { version?: string } } | null
    const currentVersion = normalizeVersion(app.getVersion())

    if (!result) {
      return {
        success: true,
        available: false,
        currentVersion,
        latestVersion: null,
        skipped: true,
        ...getUpdateDistributionInfo()
      }
    }

    const latestVersion = normalizeVersion(result.updateInfo?.version ?? null) || null
    const available = isNewerVersion(latestVersion, currentVersion)
    return {
      success: true,
      available,
      currentVersion,
      latestVersion,
      skipped: false,
      ...getUpdateDistributionInfo()
    }
  } catch (error) {
    const message = formatErrorMessage(error)
    if (shouldReportUpdaterError(message)) {
      console.error('[Updater] Check failed:', error)
    }
    return { success: false, error: message }
  }
}

export async function requestUpdateDownload(): Promise<
  | { success: true }
  | {
      success: false
      error: string
      manualDownload?: boolean
      distribution?: ReturnType<typeof getUpdateDistributionInfo>['distribution']
      supportsAutoInstall?: boolean
      releaseUrl?: string
    }
> {
  try {
    console.log('[Updater] User requested download')
    if (!isAutoInstallUpdateSupported()) {
      return {
        success: false,
        manualDownload: true,
        error: GREEN_UPDATE_MESSAGE,
        ...getUpdateDistributionInfo()
      }
    }

    const unsupportedReason = getUpdaterUnsupportedReason()
    if (unsupportedReason) {
      return { success: false, error: unsupportedReason }
    }

    await downloadUpdateSafely()
    return { success: true }
  } catch (error) {
    const message = formatErrorMessage(error)
    if (shouldReportUpdaterError(message)) {
      console.error('[Updater] Download failed:', error)
    }
    return { success: false, error: message }
  }
}

export function getUpdateStatus(): {
  success: true
  downloadedVersion: string | null
  distribution: ReturnType<typeof getUpdateDistributionInfo>['distribution']
  supportsAutoInstall: boolean
  releaseUrl: string
} {
  return {
    success: true,
    downloadedVersion: isAutoInstallUpdateSupported() ? downloadedUpdateVersion : null,
    ...getUpdateDistributionInfo()
  }
}

export function requestUpdateInstall(
  options: AutoUpdateOptions
): { success: true } | { success: false; error: string } {
  return installDownloadedUpdate(options)
}

export function setupAutoUpdater(options: AutoUpdateOptions): void {
  if (initialized) return
  initialized = true

  if (!app.isPackaged) {
    // Allow update check/download in development for manual testing.
    // This uses dev-app-update.yml in the project root.
    autoUpdater.forceDevUpdateConfig = true
  }

  if (!app.isPackaged) {
    console.log('[Updater] Running in development mode - using dev-app-update.yml')
  }

  if (
    process.platform !== 'win32' &&
    process.platform !== 'linux' &&
    process.platform !== 'darwin'
  ) {
    console.log(`[Updater] Skip update check on unsupported platform: ${process.platform}`)
    return
  }

  const unsupportedReason = getUpdaterUnsupportedReason()
  if (unsupportedReason) {
    console.warn(`[Updater] ${unsupportedReason}`)
    writeCrashLog('updater_unsupported', { message: unsupportedReason })
    return
  }

  configureAutoUpdaterLogger()

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false

  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] Checking for updates...')
  })

  autoUpdater.on('update-available', (info) => {
    void handleUpdateAvailable(info, options)

    if (!isAutoInstallUpdateSupported()) {
      console.log('[Updater] No-install build detected. Waiting for manual download.')
      return
    }

    if (!isAutoUpdateEnabled()) {
      console.log('[Updater] Auto update is disabled. Waiting for manual download.')
      return
    }

    void downloadUpdateSafely().catch((error) => {
      if (isTransientUpdateError(error)) {
        clearWindowProgress(options.getMainWindow)
        return
      }

      const message = formatErrorMessage(error)
      if (!shouldReportUpdaterError(message)) {
        return
      }

      console.error('[Updater] Auto download failed:', error)
      writeCrashLog('updater_auto_download_failed', { message, error })
    })
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
    clearWindowProgress(options.getMainWindow)

    if (isTransientUpdateError(error) || !shouldReportUpdaterError(message)) {
      return
    }

    console.error('[Updater] Auto update failed:', error)
    writeCrashLog('updater_error', { message, error })

    const win = getValidWindow(options.getMainWindow)
    if (win) {
      const payload = { error: message }
      safeSendMessagePackToWindow(win, 'update:error', payload)
    }
  })

  if (!isAutoUpdateEnabled()) {
    console.log('[Updater] Auto update is disabled. Skip startup update check.')
    return
  }

  // Check for updates immediately on startup
  void checkForUpdatesSafely().catch((error) => {
    if (isTransientUpdateError(error)) {
      return
    }

    const message = formatErrorMessage(error)
    if (!shouldReportUpdaterError(message)) {
      return
    }

    console.error('[Updater] checkForUpdates failed:', error)
    writeCrashLog('updater_check_failed', { message, error })
  })
}
