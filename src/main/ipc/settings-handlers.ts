import { ipcMain, session } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const DATA_DIR = path.join(os.homedir(), '.open-cowork')
const SETTINGS_FILE = 'settings.json'
const FLUSH_DEBOUNCE_MS = 2000

function getSettingsPath(): string {
  return path.join(DATA_DIR, SETTINGS_FILE)
}

// --- In-memory cache + debounced disk writes ---

let settingsCache: Record<string, unknown> | null = null
let dirty = false
let flushTimer: ReturnType<typeof setTimeout> | null = null

export function readSettings(): Record<string, unknown> {
  if (settingsCache) return settingsCache
  try {
    const filePath = getSettingsPath()
    if (fs.existsSync(filePath)) {
      settingsCache = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      return settingsCache!
    }
  } catch {
    // Return empty on any error
  }
  settingsCache = {}
  return settingsCache
}

function flushSettingsToDisk(): void {
  if (!dirty || !settingsCache) return
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true })
    }
    const filePath = getSettingsPath()
    const tmpPath = filePath + '.tmp'
    fs.writeFileSync(tmpPath, JSON.stringify(settingsCache, null, 2), 'utf-8')
    fs.renameSync(tmpPath, filePath)
    dirty = false
  } catch (err) {
    console.error('[Settings] Flush error:', err)
  }
}

function scheduleDiskFlush(): void {
  dirty = true
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushSettingsToDisk()
  }, FLUSH_DEBOUNCE_MS)
}

function writeSettings(settings: Record<string, unknown>): void {
  settingsCache = settings
  scheduleDiskFlush()
}

export function flushSettingsSync(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  flushSettingsToDisk()
}

function normalizeProxyUrl(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

async function applySystemProxy(proxyUrl: string): Promise<void> {
  try {
    await session.defaultSession.setProxy({ proxyRules: proxyUrl })
    console.log(
      proxyUrl
        ? `[Settings] System proxy configured: ${proxyUrl}`
        : '[Settings] System proxy cleared'
    )
  } catch (err) {
    console.error('[Settings] Failed to configure system proxy:', err)
  }
}

export function registerSettingsHandlers(): void {
  ipcMain.handle('settings:get', async (_event, key?: string) => {
    const settings = readSettings()
    if (key) return settings[key]
    return settings
  })

  ipcMain.handle('settings:set', async (_event, args: { key: string; value: unknown }) => {
    const settings = readSettings()
    settings[args.key] = args.value
    writeSettings(settings)

    if (args.key === 'systemProxyUrl') {
      await applySystemProxy(normalizeProxyUrl(args.value))
      return { success: true }
    }

    return { success: true }
  })
}
