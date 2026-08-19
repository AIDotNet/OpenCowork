import {
  DEFAULT_SETTINGS_TAB,
  resolveSettingsTab,
  type SettingsTabId
} from '@renderer/lib/settings-tabs'

export { DEFAULT_SETTINGS_TAB } from '@renderer/lib/settings-tabs'

export interface SettingsRouteState {
  tab: SettingsTabId
  explicitTab: boolean
  canonicalHash: string
}

function normalizeHash(hash: string): string {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const path = raw.trim()
  if (!path || path === '/') return '/'
  return path.startsWith('/') ? path : `/${path}`
}

export function buildSettingsRoute(tab?: string | null): string {
  return `#/settings/${encodeURIComponent(resolveSettingsTab(tab) ?? DEFAULT_SETTINGS_TAB)}`
}

export function replaceSettingsRoute(tab?: string | null): void {
  const nextHash = buildSettingsRoute(tab)
  if (window.location.hash === nextHash) return
  window.history.replaceState(null, '', nextHash)
}

export function parseSettingsRoute(hash: string): SettingsRouteState | null {
  const normalized = normalizeHash(hash)
  const segments = normalized.split('/').filter(Boolean)

  if (segments[0] !== 'settings') return null

  const rawTab = decodeURIComponent(segments[1] ?? '')
  const resolved = resolveSettingsTab(rawTab)

  if (resolved) {
    return {
      tab: resolved,
      explicitTab: true,
      canonicalHash: buildSettingsRoute(resolved)
    }
  }

  return {
    tab: DEFAULT_SETTINGS_TAB,
    explicitTab: false,
    canonicalHash: buildSettingsRoute(DEFAULT_SETTINGS_TAB)
  }
}
