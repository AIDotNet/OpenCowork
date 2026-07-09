import type { SettingsTab } from '@renderer/stores/ui-store'

export interface SettingsRouteState {
  tab: SettingsTab
  explicitTab: boolean
  canonicalHash: string
}

export const DEFAULT_SETTINGS_TAB: SettingsTab = 'profile'

const VALID_SETTINGS_TABS: ReadonlySet<SettingsTab> = new Set([
  'profile',
  'general',
  'system',
  'memory',
  'analytics',
  'migration',
  'provider',
  'modelManagement',
  'model',
  'plugin',
  'extension',
  'hooks',
  'channel',
  'mcp',
  'websearch',
  'skillsmarket',
  'about'
])

function normalizeHash(hash: string): string {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const path = raw.trim()
  if (!path || path === '/') return '/'
  return path.startsWith('/') ? path : `/${path}`
}

export function isSettingsTab(value: string): value is SettingsTab {
  return VALID_SETTINGS_TABS.has(value as SettingsTab)
}

export function buildSettingsRoute(tab?: SettingsTab | null): string {
  return `#/settings/${encodeURIComponent(tab ?? DEFAULT_SETTINGS_TAB)}`
}

export function replaceSettingsRoute(tab?: SettingsTab | null): void {
  const nextHash = buildSettingsRoute(tab)
  if (window.location.hash === nextHash) return
  window.history.replaceState(null, '', nextHash)
}

export function parseSettingsRoute(hash: string): SettingsRouteState | null {
  const normalized = normalizeHash(hash)
  const segments = normalized.split('/').filter(Boolean)

  if (segments[0] !== 'settings') return null

  const rawTab = decodeURIComponent(segments[1] ?? '')
  if (!rawTab) {
    return {
      tab: DEFAULT_SETTINGS_TAB,
      explicitTab: false,
      canonicalHash: buildSettingsRoute(DEFAULT_SETTINGS_TAB)
    }
  }

  if (isSettingsTab(rawTab)) {
    return {
      tab: rawTab,
      explicitTab: true,
      canonicalHash: buildSettingsRoute(rawTab)
    }
  }

  return {
    tab: DEFAULT_SETTINGS_TAB,
    explicitTab: false,
    canonicalHash: buildSettingsRoute(DEFAULT_SETTINGS_TAB)
  }
}
