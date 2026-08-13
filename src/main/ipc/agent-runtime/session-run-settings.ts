import { readPersistedSettingsState } from '../settings-handlers'

export type SessionRunSettings = {
  autoApprove: boolean
  maxParallelTools: number
  maxConcurrentSubAgents: number
  maxIterations: number
  webSearchEnabled: boolean
  webSearch: Record<string, unknown> | null
  teamToolsEnabled: boolean
  codegraphEnabled: boolean
  codegraphFullToolSurface: boolean
  memoryUseMemories: boolean
  memorySummaryBudgetTokens: number
  settingsRevision: string
}

const DEFAULT_MAX_PARALLEL_TOOLS = 8
const DEFAULT_MAX_CONCURRENT_SUB_AGENTS = 2

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

export function readSessionRunSettings(
  settings: Record<string, unknown> = readPersistedSettingsState()
): SessionRunSettings {
  const webSearchEnabled = settings.webSearchEnabled === true
  const maxResults = Number(settings.webSearchMaxResults)
  const timeout = Number(settings.webSearchTimeout)
  const summaryBudget = Number(settings.memorySummaryBudgetTokens)
  return {
    autoApprove: settings.autoApprove === true,
    maxParallelTools: clampInt(settings.maxParallelToolCalls, DEFAULT_MAX_PARALLEL_TOOLS, 1, 16),
    maxConcurrentSubAgents: clampInt(
      settings.maxConcurrentSubAgents,
      DEFAULT_MAX_CONCURRENT_SUB_AGENTS,
      1,
      8
    ),
    maxIterations: 0,
    webSearchEnabled,
    webSearch: webSearchEnabled
      ? {
          enabled: true,
          provider:
            typeof settings.webSearchProvider === 'string' ? settings.webSearchProvider : 'tavily',
          ...(typeof settings.webSearchApiKey === 'string' && settings.webSearchApiKey
            ? { apiKey: settings.webSearchApiKey }
            : {}),
          ...(typeof settings.webSearchEngine === 'string' && settings.webSearchEngine
            ? { searchEngine: settings.webSearchEngine }
            : {}),
          maxResults: Number.isFinite(maxResults) && maxResults > 0 ? Math.floor(maxResults) : 5,
          timeout: Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : 30_000
        }
      : null,
    teamToolsEnabled: settings.teamToolsEnabled === true,
    codegraphEnabled: settings.codegraphEnabled === true,
    codegraphFullToolSurface: settings.codegraphFullToolSurface === true,
    memoryUseMemories: settings.memoryUseMemories !== false,
    memorySummaryBudgetTokens:
      Number.isFinite(summaryBudget) && summaryBudget > 0 ? Math.floor(summaryBudget) : 12_000,
    settingsRevision: 'main-persisted'
  }
}
