import { app, session } from 'electron'
import { migrateLegacySubAgentHistorySettings } from '../db/sub-agent-history-dao'
import { initializeDatabase } from '../db/database'
import { getNativeWorker, stopCodeGraphWorker } from '../lib/native-worker'
import { clearCodeGraphSyncQueues } from '../lib/codegraph-sync'
import { refreshWorkerProxy } from '../lib/worker-proxy'
import { registerMessagePackHandler } from './messagepack-handler'
import {
  sanitizePermissionPolicy,
  toPermissionPolicySnapshot,
  type PermissionPolicySnapshot
} from '../../shared/permission-policy'

const SETTINGS_NATIVE_TIMEOUT_MS = 60_000

type MutationResult = {
  success: boolean
  error?: string | null
}

const PERSISTED_SETTINGS_STORE_KEY = 'opencowork-settings'

let settingsCache: Record<string, unknown> | null = null
let settingsHydrated = false
let hydratePromise: Promise<Record<string, unknown>> | null = null
let pendingWrite: Promise<unknown> | null = null
let agentHistoryMigrationPromise: Promise<void> | null = null

// Tracks the last-observed CodeGraph flag so we act only on the true→false edge.
let lastKnownCodeGraphEnabled = false

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

  hydratePromise = ensureAgentHistoryMigrated()
    .then(() => nativeSettingsRequest<Record<string, unknown>>('settings/read'))
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

async function ensureAgentHistoryMigrated(): Promise<void> {
  agentHistoryMigrationPromise ??= initializeDatabase()
    .then(() => migrateLegacySubAgentHistorySettings())
    .then((result) => {
      if (!result.success) {
        throw new Error(result.error || 'Sub-agent history migration failed')
      }
      if (result.migrated) {
        console.log('[Settings] Migrated sub-agent history to SQLite', {
          imported: result.imported
        })
      }
    })
    .catch((error) => {
      agentHistoryMigrationPromise = null
      console.warn('[Settings] Failed to migrate sub-agent history:', error)
    })

  await agentHistoryMigrationPromise
}

// Synchronous callers read the in-memory snapshot. Before Electron is ready, keep this accessor
// side-effect free: pre-ready browser-path setup and rejected second instances must not spawn the
// Native Worker. Normal startup explicitly hydrates the cache after app readiness.
export function readSettings(): Record<string, unknown> {
  settingsCache ??= {}
  if (app.isReady() && !settingsHydrated) void initializeSettingsCache()
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
  return (
    decodePersistedStoreState<Record<string, unknown>>(root[PERSISTED_SETTINGS_STORE_KEY]) ?? {}
  )
}

export function readShellEnvironmentVariablesText(): string {
  const persistedSettings = readPersistedSettingsState()
  return typeof persistedSettings.shellEnvironmentVariablesText === 'string'
    ? persistedSettings.shellEnvironmentVariablesText
    : ''
}

/**
 * Opt-in CodeGraph feature flag (default false). The renderer persists it as
 * `codegraphEnabled` inside the `opencowork-settings` store blob; the sidecar
 * router reads it here to gate `codegraph/*` requests to the CodeGraph worker.
 */
export function readCodeGraphEnabled(): boolean {
  return readPersistedSettingsState().codegraphEnabled === true
}

/**
 * React to the CodeGraph toggle persisted by the renderer store. CodeGraph is
 * lazy — enabling never eager-starts the worker here (the sidecar router spawns
 * it on the first `codegraph/*` request). Disabling stops the worker so its
 * process and native grammars are released. Acts only on the true→false edge.
 */
function syncCodeGraphWorkerFromSettings(): void {
  const enabled = readCodeGraphEnabled()
  if (lastKnownCodeGraphEnabled && !enabled) {
    clearCodeGraphSyncQueues()
    void stopCodeGraphWorker().catch((error) => {
      console.warn(
        `[Settings] Failed to stop CodeGraph worker on disable: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    })
  }
  lastKnownCodeGraphEnabled = enabled
}

/** Permission whitelist snapshot for run requests built in the main process (cron, fallback). */
export function readPermissionPolicySnapshot(): PermissionPolicySnapshot | undefined {
  const persistedSettings = readPersistedSettingsState()
  return toPermissionPolicySnapshot(sanitizePermissionPolicy(persistedSettings.permissionPolicy))
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
  // The native worker sends every provider request and cannot read the OS proxy settings, so it
  // needs the new value pushed to it explicitly. Clearing the setting re-resolves rather than
  // going direct: the OS may still have a proxy configured.
  await refreshWorkerProxy(proxyUrl || null)
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

    // The renderer persists its whole settings store under one blob key; observe
    // it to release the CodeGraph worker when the user disables the feature.
    if (args.key === PERSISTED_SETTINGS_STORE_KEY) {
      syncCodeGraphWorkerFromSettings()
    }

    return { success: true }
  })
}
