import { session } from 'electron'
import { getNativeWorker } from '../lib/native-worker'
import { registerMessagePackHandler } from './messagepack-handler'

const SETTINGS_NATIVE_TIMEOUT_MS = 60_000

type MutationResult = {
  success: boolean
  error?: string | null
}

let settingsCache: Record<string, unknown> | null = null
let settingsHydrated = false
let hydratePromise: Promise<Record<string, unknown>> | null = null
let pendingWrite: Promise<unknown> | null = null

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function nativeSettingsRequest<T>(method: string, params?: unknown): Promise<T> {
  return await getNativeWorker().request<T>(method, params ?? {}, SETTINGS_NATIVE_TIMEOUT_MS)
}

export async function initializeSettingsCache(): Promise<Record<string, unknown>> {
  if (settingsHydrated && settingsCache) return settingsCache
  if (hydratePromise) return hydratePromise

  return await reloadSettingsCache()
}

export async function reloadSettingsCache(): Promise<Record<string, unknown>> {
  if (hydratePromise) return hydratePromise

  hydratePromise = nativeSettingsRequest<Record<string, unknown>>('settings/read')
    .then((settings) => {
      settingsCache = isPlainRecord(settings) ? settings : {}
      settingsHydrated = true
      return settingsCache
    })
    .catch((err) => {
      if (!settingsCache) settingsCache = {}
      console.error('[Settings] Native read error:', err)
      return settingsCache
    })
    .finally(() => {
      hydratePromise = null
    })

  return await hydratePromise
}

// Synchronous callers read the hydrated in-memory snapshot. Startup now hydrates this before use.
export function readSettings(): Record<string, unknown> {
  if (settingsCache) return settingsCache
  settingsCache = {}
  void initializeSettingsCache()
  return settingsCache
}

export function decodePersistedStoreState<T>(raw: unknown): T | null {
  if (raw == null) return null

  let parsed = raw
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }

  if (!parsed || typeof parsed !== 'object') return null
  if ('state' in (parsed as Record<string, unknown>)) {
    return ((parsed as Record<string, unknown>).state as T) ?? null
  }

  return parsed as T
}

export function readPersistedSettingsState(): Record<string, unknown> {
  const root = readSettings()
  return decodePersistedStoreState<Record<string, unknown>>(root['opencowork-settings']) ?? {}
}

export function readShellEnvironmentVariablesText(): string {
  const persistedSettings = readPersistedSettingsState()
  return typeof persistedSettings.shellEnvironmentVariablesText === 'string'
    ? persistedSettings.shellEnvironmentVariablesText
    : ''
}

export async function flushSettingsSync(): Promise<void> {
  if (!pendingWrite) return
  await pendingWrite.catch((err) => {
    console.error('[Settings] Pending native write failed:', err)
  })
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

export async function setSettingsValue(key: string, value: unknown): Promise<void> {
  const settings = await initializeSettingsCache()
  if (value === undefined || value === null) {
    delete settings[key]
  } else {
    settings[key] = value
  }
  settingsCache = settings

  pendingWrite = nativeSettingsRequest<MutationResult>('settings/set', { key, value })
    .then((result) => {
      if (!result.success) {
        throw new Error(result.error || 'Native settings set failed')
      }
    })
    .finally(() => {
      pendingWrite = null
    })
  await pendingWrite
}

export function registerSettingsHandlers(): void {
  void initializeSettingsCache()

  registerMessagePackHandler<string | undefined>('settings:get', async (key) => {
    const settings = await initializeSettingsCache()
    if (key) return settings[key]
    return settings
  })

  registerMessagePackHandler<{ key: string; value: unknown }>('settings:set', async (args) => {
    await setSettingsValue(args.key, args.value)

    if (args.key === 'systemProxyUrl') {
      await applySystemProxy(normalizeProxyUrl(args.value))
      return { success: true }
    }

    return { success: true }
  })
}
