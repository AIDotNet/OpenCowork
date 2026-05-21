import { app, session, type Session } from 'electron'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir, platform } from 'os'
import { readSettings } from '../ipc/settings-handlers'
import {
  BROWSER_SETTINGS_STORAGE_KEY,
  BROWSER_USER_DATA_SOURCE_SETTING_KEY,
  BROWSER_USER_DATA_REUSE_SETTING_KEY,
  BUILTIN_BROWSER_PARTITION,
  isBrowserUserDataReuseEnabled,
  normalizeBrowserUserDataSource,
  type BrowserUserDataSource,
  type ConcreteBrowserUserDataSource
} from '../../shared/browser-plugin'

interface BrowserProfileCandidate {
  browserId: ConcreteBrowserUserDataSource
  browserName: string
  dataRoot: string
  profilePath: string
  profileDisplayName: string
}

export interface BrowserSessionStorageMode {
  reuseEnabled: boolean
  browserUserDataSource: BrowserUserDataSource
  browserId: ConcreteBrowserUserDataSource | null
  browserName: string | null
  browserDataRoot: string | null
  browserProfilePath: string | null
  browserProfileDisplayName: string | null
  sessionDataPath: string
  usingDetectedBrowserProfile: boolean
}

export interface BrowserEmulationStatus extends BrowserSessionStorageMode {
  userAgent: string
  acceptLanguages: string
  browserSessionStoragePath: string | null
}

let cachedStorageMode: BrowserSessionStorageMode | null = null
let requestHeaderEmulationConfigured = false

function readPersistedSettingsState(): Record<string, unknown> {
  const persisted = readSettings()[BROWSER_SETTINGS_STORAGE_KEY]
  if (!persisted || typeof persisted !== 'object') return {}
  const state = (persisted as { state?: unknown }).state
  return state && typeof state === 'object' ? (state as Record<string, unknown>) : {}
}

export function readBrowserUserDataReuseEnabled(): boolean {
  return isBrowserUserDataReuseEnabled(
    readPersistedSettingsState()[BROWSER_USER_DATA_REUSE_SETTING_KEY]
  )
}

export function readBrowserUserDataSource(): BrowserUserDataSource {
  return normalizeBrowserUserDataSource(
    readPersistedSettingsState()[BROWSER_USER_DATA_SOURCE_SETTING_KEY]
  )
}

interface BrowserInstallLocation {
  browserId: ConcreteBrowserUserDataSource
  browserName: string
  dataRoot: string
}

function getProfileDisplayName(profileDirName: string): string {
  return profileDirName === 'Default' ? 'Default' : profileDirName
}

function readLastUsedProfileDir(dataRoot: string): string | null {
  try {
    const localState = JSON.parse(readFileSync(join(dataRoot, 'Local State'), 'utf8')) as {
      profile?: { last_used?: unknown }
    }
    const lastUsed = localState.profile?.last_used
    return typeof lastUsed === 'string' && lastUsed.trim() ? lastUsed : null
  } catch {
    return null
  }
}

function listProfileDirs(dataRoot: string): string[] {
  try {
    return readdirSync(dataRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        if (name === 'Default') return true
        if (/^Profile \d+$/u.test(name)) return true
        return existsSync(join(dataRoot, name, 'Preferences'))
      })
      .sort((left, right) => {
        if (left === 'Default') return -1
        if (right === 'Default') return 1
        return left.localeCompare(right, undefined, { numeric: true })
      })
  } catch {
    return []
  }
}

function resolveProfileDirName(dataRoot: string): string | null {
  const lastUsed = readLastUsedProfileDir(dataRoot)
  if (lastUsed && existsSync(join(dataRoot, lastUsed))) return lastUsed

  if (existsSync(join(dataRoot, 'Default'))) return 'Default'

  return listProfileDirs(dataRoot)[0] ?? null
}

function toProfileCandidate(location: BrowserInstallLocation): BrowserProfileCandidate | null {
  if (!existsSync(location.dataRoot)) return null

  const profileDirName = resolveProfileDirName(location.dataRoot)
  if (!profileDirName) return null

  const profilePath = join(location.dataRoot, profileDirName)
  if (!existsSync(profilePath)) return null

  return {
    ...location,
    profilePath,
    profileDisplayName: getProfileDisplayName(profileDirName)
  }
}

function getBrowserInstallLocations(): BrowserInstallLocation[] {
  const home = homedir()

  if (platform() === 'darwin') {
    return [
      {
        browserId: 'chrome',
        browserName: 'Google Chrome',
        dataRoot: join(home, 'Library/Application Support/Google/Chrome')
      },
      {
        browserId: 'edge',
        browserName: 'Microsoft Edge',
        dataRoot: join(home, 'Library/Application Support/Microsoft Edge')
      },
      {
        browserId: 'brave',
        browserName: 'Brave',
        dataRoot: join(home, 'Library/Application Support/BraveSoftware/Brave-Browser')
      },
      {
        browserId: 'chromium',
        browserName: 'Chromium',
        dataRoot: join(home, 'Library/Application Support/Chromium')
      }
    ]
  }

  if (platform() === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData/Local')
    return [
      {
        browserId: 'chrome',
        browserName: 'Google Chrome',
        dataRoot: join(localAppData, 'Google/Chrome/User Data')
      },
      {
        browserId: 'edge',
        browserName: 'Microsoft Edge',
        dataRoot: join(localAppData, 'Microsoft/Edge/User Data')
      },
      {
        browserId: 'brave',
        browserName: 'Brave',
        dataRoot: join(localAppData, 'BraveSoftware/Brave-Browser/User Data')
      },
      {
        browserId: 'chromium',
        browserName: 'Chromium',
        dataRoot: join(localAppData, 'Chromium/User Data')
      }
    ]
  }

  return [
    {
      browserId: 'chrome',
      browserName: 'Google Chrome',
      dataRoot: join(home, '.config/google-chrome')
    },
    {
      browserId: 'edge',
      browserName: 'Microsoft Edge',
      dataRoot: join(home, '.config/microsoft-edge')
    },
    {
      browserId: 'brave',
      browserName: 'Brave',
      dataRoot: join(home, '.config/BraveSoftware/Brave-Browser')
    },
    {
      browserId: 'chromium',
      browserName: 'Chromium',
      dataRoot: join(home, '.config/chromium')
    }
  ]
}

function getBrowserProfileCandidates(): BrowserProfileCandidate[] {
  return getBrowserInstallLocations()
    .map((location) => toProfileCandidate(location))
    .filter((candidate): candidate is BrowserProfileCandidate => Boolean(candidate))
}

function resolveDetectedBrowserProfile(
  browserUserDataSource: BrowserUserDataSource
): BrowserProfileCandidate | null {
  const candidates = getBrowserProfileCandidates()
  if (browserUserDataSource === 'auto') return candidates[0] ?? null
  return candidates.find((candidate) => candidate.browserId === browserUserDataSource) ?? null
}

export function resolveBrowserSessionStorageMode(
  appUserDataPath: string
): BrowserSessionStorageMode {
  if (cachedStorageMode) return cachedStorageMode

  const reuseEnabled = readBrowserUserDataReuseEnabled()
  const browserUserDataSource = readBrowserUserDataSource()
  const detectedProfile = reuseEnabled ? resolveDetectedBrowserProfile(browserUserDataSource) : null
  const sessionDataPath = detectedProfile?.profilePath ?? join(appUserDataPath, 'session-data')

  cachedStorageMode = {
    reuseEnabled,
    browserUserDataSource,
    browserId: detectedProfile?.browserId ?? null,
    browserName: detectedProfile?.browserName ?? null,
    browserDataRoot: detectedProfile?.dataRoot ?? null,
    browserProfilePath: detectedProfile?.profilePath ?? null,
    browserProfileDisplayName: detectedProfile?.profileDisplayName ?? null,
    sessionDataPath,
    usingDetectedBrowserProfile: Boolean(detectedProfile)
  }

  return cachedStorageMode
}

export function shouldUseDefaultBrowserSession(): boolean {
  const mode = cachedStorageMode ?? resolveBrowserSessionStorageMode(app.getPath('userData'))
  return mode.reuseEnabled
}

export function getBuiltInBrowserSession(): Session {
  return shouldUseDefaultBrowserSession()
    ? session.defaultSession
    : session.fromPartition(BUILTIN_BROWSER_PARTITION)
}

function getPlatformUserAgentToken(): string {
  if (platform() === 'darwin') return 'Macintosh; Intel Mac OS X 10_15_7'
  if (platform() === 'win32') return 'Windows NT 10.0; Win64; x64'
  return 'X11; Linux x86_64'
}

function getEffectiveBrowserId(
  mode: BrowserSessionStorageMode
): ConcreteBrowserUserDataSource | 'chrome' {
  if (mode.browserId) return mode.browserId
  if (mode.browserUserDataSource !== 'auto') return mode.browserUserDataSource
  return 'chrome'
}

function getBrowserLikeUserAgent(
  browserId: ConcreteBrowserUserDataSource | 'chrome' = 'chrome'
): string {
  const base = `Mozilla/5.0 (${getPlatformUserAgentToken()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`
  return browserId === 'edge' ? `${base} Edg/${process.versions.chrome}` : base
}

function getAcceptLanguages(): string {
  const locale = app.getLocale() || 'en-US'
  const normalized = locale.replace('_', '-')
  const base = normalized.split('-')[0] || 'en'

  if (base === 'zh') {
    return normalized.toLowerCase().includes('tw') || normalized.toLowerCase().includes('hk')
      ? `${normalized},zh-TW;q=0.9,zh;q=0.8,en;q=0.7`
      : `${normalized},zh-CN;q=0.9,zh;q=0.8,en;q=0.7`
  }

  if (base === 'en') {
    return `${normalized},en;q=0.9`
  }

  return `${normalized},${base};q=0.9,en;q=0.8`
}

function getChromeMajorVersion(): string {
  return process.versions.chrome.split('.')[0] || '120'
}

function getClientHintsPlatform(): string {
  if (platform() === 'darwin') return '"macOS"'
  if (platform() === 'win32') return '"Windows"'
  return '"Linux"'
}

function getClientHintBrand(browserId: ConcreteBrowserUserDataSource | 'chrome'): string {
  if (browserId === 'edge') return 'Microsoft Edge'
  if (browserId === 'chromium') return 'Chromium'
  return 'Google Chrome'
}

function applyBrowserLikeHeaders(
  details: Electron.OnBeforeSendHeadersListenerDetails,
  browserId: ConcreteBrowserUserDataSource | 'chrome'
): void {
  if (details.webContents?.getType() !== 'webview') return

  const chromeMajor = getChromeMajorVersion()
  details.requestHeaders['User-Agent'] = getBrowserLikeUserAgent(browserId)
  details.requestHeaders['Accept-Language'] = getAcceptLanguages()
  details.requestHeaders['sec-ch-ua'] =
    `"Chromium";v="${chromeMajor}", "${getClientHintBrand(browserId)}";v="${chromeMajor}", "Not.A/Brand";v="99"`
  details.requestHeaders['sec-ch-ua-mobile'] = '?0'
  details.requestHeaders['sec-ch-ua-platform'] = getClientHintsPlatform()
}

export function configureBuiltInBrowserSession(): BrowserEmulationStatus {
  const browserSession = getBuiltInBrowserSession()
  const mode = cachedStorageMode ?? resolveBrowserSessionStorageMode(app.getPath('userData'))
  const browserId = getEffectiveBrowserId(mode)
  const userAgent = getBrowserLikeUserAgent(browserId)
  const acceptLanguages = getAcceptLanguages()

  if (readBrowserUserDataReuseEnabled()) {
    browserSession.setUserAgent(userAgent, acceptLanguages)

    if (!requestHeaderEmulationConfigured) {
      requestHeaderEmulationConfigured = true
      browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
        applyBrowserLikeHeaders(details, browserId)
        callback({ requestHeaders: details.requestHeaders })
      })
    }
  }

  return {
    ...mode,
    userAgent,
    acceptLanguages,
    browserSessionStoragePath: browserSession.getStoragePath()
  }
}

export function getBrowserEmulationStatus(): BrowserEmulationStatus {
  const browserSession = getBuiltInBrowserSession()
  const mode = cachedStorageMode ?? resolveBrowserSessionStorageMode(app.getPath('userData'))
  const browserId = getEffectiveBrowserId(mode)

  return {
    ...mode,
    userAgent: getBrowserLikeUserAgent(browserId),
    acceptLanguages: getAcceptLanguages(),
    browserSessionStoragePath: browserSession.getStoragePath()
  }
}
