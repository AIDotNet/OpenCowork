/**
 * Settings tab identity, kept free of React/icon imports so stores and routing
 * can depend on it without pulling in the settings UI bundle.
 */

export const SETTINGS_TAB_IDS = [
  'profile',
  'general',
  'model',
  'provider',
  'runtime',
  'memory',
  'permission',
  'plugin',
  'aiCoding',
  'mcp',
  'extension',
  'hooks',
  'channel',
  'websearch',
  'system',
  'data',
  'pet',
  'analytics',
  'about'
] as const

export type SettingsTabId = (typeof SETTINGS_TAB_IDS)[number]

/**
 * Tabs that existed before the settings IA was consolidated. They are no longer
 * rendered on their own, but old deep links and persisted state must still land
 * somewhere sensible.
 */
export const LEGACY_SETTINGS_TAB_ALIASES = {
  modelManagement: 'provider',
  migration: 'data',
  skillsmarket: 'extension',
  codegraph: 'plugin',
  aiCodingClaudeCode: 'aiCoding',
  aiCodingCodex: 'aiCoding'
} as const satisfies Record<string, SettingsTabId>

export type LegacySettingsTab = keyof typeof LEGACY_SETTINGS_TAB_ALIASES

export const DEFAULT_SETTINGS_TAB: SettingsTabId = 'profile'

const TAB_ID_SET: ReadonlySet<string> = new Set(SETTINGS_TAB_IDS)

export function isSettingsTabId(value: string): value is SettingsTabId {
  return TAB_ID_SET.has(value)
}

/** Maps any historical or current tab id onto a tab that actually renders. */
export function resolveSettingsTab(value: string | null | undefined): SettingsTabId | null {
  if (!value) return null
  if (isSettingsTabId(value)) return value
  return LEGACY_SETTINGS_TAB_ALIASES[value as LegacySettingsTab] ?? null
}
