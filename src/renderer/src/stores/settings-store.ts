import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { ProviderType, ReasoningEffortLevel, ThinkingConfig } from '../lib/api/types'
import { ipcStorage } from '../lib/ipc/ipc-storage'
import {
  DEFAULT_APP_THEME_PRESET,
  DEFAULT_SSH_TERMINAL_THEME_PRESET,
  isAppThemePreset,
  type AppThemePreset,
  type SshTerminalThemePreset
} from '../lib/theme-presets'
import {
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  clampLeftSidebarWidth
} from '@renderer/components/layout/right-panel-defs'
import {
  DEFAULT_BROWSER_USER_DATA_SOURCE,
  normalizeBrowserUserDataSource,
  type BrowserUserDataSource
} from '../../../shared/browser-plugin'
import {
  detectSystemLanguage,
  normalizeLanguageCode,
  type AppLanguage
} from '@renderer/lib/i18n-language'
import {
  DEFAULT_PERMISSION_POLICY,
  sanitizePermissionPolicy,
  type PermissionPolicy
} from '../../../shared/permission-policy'

export interface ModelBinding {
  providerId: string
  modelId: string
}

export type ClaudeCodePermissionOption = 'dangerouslySkipPermissions'

export interface SessionDefaultModelBinding extends ModelBinding {
  useGlobalActiveModel: boolean
}

export interface ClaudeCodeConfig {
  id: string
  name: string
  providerId: string
  defaultModelId: string
  smallFastModelId: string
  sonnetModelId: string
  opusModelId: string
  haikuModelId: string
  permissionOptions: ClaudeCodePermissionOption[]
}

export interface CodexConfig {
  id: string
  name: string
  providerId: string
  modelId: string
}

export type PromptRecommendationModelBinding = ModelBinding | 'disabled' | null

export type PromptRecommendationModelBindings = Record<
  'chat' | 'clarify' | 'cowork' | 'code' | 'acp',
  PromptRecommendationModelBinding
>

export type MainModelSelectionMode = 'auto' | 'manual'
export type MemoryAutomationWritePolicy = 'auto'
export type MemoryScopeMode = 'hybrid'
export type ClarifyPlanModeAutoSwitchTarget = 'off' | 'code' | 'acp'
export type ProjectDefaultDirectoryMode = 'last-used' | 'custom'
export type FileDiffViewMode = 'split' | 'inline'
export type LiveOutputAnimationStyle = 'agile' | 'elegant'
export type OnboardingLanguage = AppLanguage
export type ShellExecutionEndpoint =
  | 'auto'
  | 'zsh'
  | 'bash'
  | 'sh'
  | 'powershell'
  | 'pwsh'
  | 'cmd'
  | 'custom'
export const DEFAULT_THEME_MODE = 'dark' as const
export const DEFAULT_SHELL_EXECUTION_ENDPOINT: ShellExecutionEndpoint = 'auto'
const LEGACY_DEFAULT_THEME_MODE = 'system' as const
const LEGACY_DEFAULT_APP_THEME_PRESET: AppThemePreset = 'studio'
const LEGACY_DEFAULT_SSH_TERMINAL_THEME_PRESET: SshTerminalThemePreset = 'graphite'
const V17_DEFAULT_THEME_MODE = 'dark' as const
const V17_DEFAULT_APP_THEME_PRESET: AppThemePreset = 'mulberry'
const V17_DEFAULT_SSH_TERMINAL_THEME_PRESET: SshTerminalThemePreset = 'mulberry'
const V18_DEFAULT_THEME_MODE = 'dark' as const
const V18_DEFAULT_APP_THEME_PRESET: AppThemePreset = 'graphite'
const V18_DEFAULT_SSH_TERMINAL_THEME_PRESET: SshTerminalThemePreset = 'graphite'

export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 8
export const MIN_MAX_PARALLEL_TOOL_CALLS = 1
export const MAX_MAX_PARALLEL_TOOL_CALLS = 16

export const DEFAULT_MAX_CONCURRENT_SUB_AGENTS = 2
export const MIN_MAX_CONCURRENT_SUB_AGENTS = 1
export const MAX_MAX_CONCURRENT_SUB_AGENTS = 8

// Deadline for a provider API request to return response headers, in seconds. Matches
// HttpClient's historical 100s default so existing behaviour is unchanged; 0 disables the
// deadline, leaving cancellation to the user (for local models such as Ollama with long TTFT).
export const DEFAULT_API_REQUEST_TIMEOUT_SECONDS = 100
export const MIN_API_REQUEST_TIMEOUT_SECONDS = 0
/** 24h ceiling: generous enough for any local warm-up while still bounding typos. */
export const MAX_API_REQUEST_TIMEOUT_SECONDS = 86_400

export interface RecentWorkingTarget {
  workingFolder: string
  sshConnectionId: string | null
  updatedAt: number
}

const MAX_RECENT_WORKING_TARGETS = 8
const DEFAULT_AI_CODING_CONFIG_ID = 'default'

function readStringField(item: Record<string, unknown>, key: string): string {
  const value = item[key]
  return typeof value === 'string' ? value : ''
}

function sanitizeClaudeCodePermissionOptions(value: unknown): ClaudeCodePermissionOption[] {
  if (!Array.isArray(value)) return []
  return value.includes('dangerouslySkipPermissions') ? ['dangerouslySkipPermissions'] : []
}

export function createDefaultClaudeCodeConfig(): ClaudeCodeConfig {
  return {
    id: DEFAULT_AI_CODING_CONFIG_ID,
    name: '默认 1',
    providerId: '',
    defaultModelId: '',
    smallFastModelId: '',
    sonnetModelId: '',
    opusModelId: '',
    haikuModelId: '',
    permissionOptions: []
  }
}

export function createDefaultCodexConfig(): CodexConfig {
  return {
    id: DEFAULT_AI_CODING_CONFIG_ID,
    name: '默认 1',
    providerId: '',
    modelId: ''
  }
}

function sanitizeClaudeCodeConfigs(configs: unknown): ClaudeCodeConfig[] {
  if (!Array.isArray(configs)) return [createDefaultClaudeCodeConfig()]

  const usedIds = new Set<string>()
  const sanitized = configs
    .map((item, index): ClaudeCodeConfig | null => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null
      const record = item as Record<string, unknown>
      const rawId = readStringField(record, 'id').trim() || `claude-${index + 1}`
      const id = usedIds.has(rawId) ? `${rawId}-${index + 1}` : rawId
      usedIds.add(id)
      return {
        id,
        name: readStringField(record, 'name').trim() || `默认 ${index + 1}`,
        providerId: readStringField(record, 'providerId'),
        defaultModelId: readStringField(record, 'defaultModelId'),
        smallFastModelId: readStringField(record, 'smallFastModelId'),
        sonnetModelId: readStringField(record, 'sonnetModelId'),
        opusModelId: readStringField(record, 'opusModelId'),
        haikuModelId: readStringField(record, 'haikuModelId'),
        permissionOptions: sanitizeClaudeCodePermissionOptions(record.permissionOptions)
      }
    })
    .filter((item): item is ClaudeCodeConfig => Boolean(item))

  return sanitized.length > 0 ? sanitized : [createDefaultClaudeCodeConfig()]
}

function sanitizeCodexConfigs(configs: unknown): CodexConfig[] {
  if (!Array.isArray(configs)) return [createDefaultCodexConfig()]

  const usedIds = new Set<string>()
  const sanitized = configs
    .map((item, index): CodexConfig | null => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null
      const record = item as Record<string, unknown>
      const rawId = readStringField(record, 'id').trim() || `codex-${index + 1}`
      const id = usedIds.has(rawId) ? `${rawId}-${index + 1}` : rawId
      usedIds.add(id)
      return {
        id,
        name: readStringField(record, 'name').trim() || `默认 ${index + 1}`,
        providerId: readStringField(record, 'providerId'),
        modelId: readStringField(record, 'modelId')
      }
    })
    .filter((item): item is CodexConfig => Boolean(item))

  return sanitized.length > 0 ? sanitized : [createDefaultCodexConfig()]
}

function normalizeWorkingFolderPath(folderPath: string): string {
  const trimmed = folderPath.trim()
  if (!trimmed) return ''
  if (trimmed === '/') return '/'
  if (/^[A-Za-z]:[\\/]?$/.test(trimmed)) {
    return `${trimmed.slice(0, 2)}\\`
  }
  return trimmed.replace(/[\\/]+$/, '')
}

export function getRecentWorkingTargetKey(target: {
  workingFolder?: string | null
  sshConnectionId?: string | null
}): string {
  return `${target.sshConnectionId ?? 'local'}::${normalizeWorkingFolderPath(target.workingFolder ?? '').toLowerCase()}`
}

function sanitizeRecentWorkingTargets(targets: unknown): RecentWorkingTarget[] {
  if (!Array.isArray(targets)) return []

  const deduped = new Map<string, RecentWorkingTarget>()

  for (const item of targets) {
    if (!item || typeof item !== 'object') continue

    const workingFolder = normalizeWorkingFolderPath(
      'workingFolder' in item && typeof item.workingFolder === 'string' ? item.workingFolder : ''
    )
    if (!workingFolder) continue

    const sshConnectionId =
      'sshConnectionId' in item && typeof item.sshConnectionId === 'string'
        ? item.sshConnectionId
        : null
    const updatedAt =
      'updatedAt' in item && typeof item.updatedAt === 'number' ? item.updatedAt : Date.now()

    deduped.set(getRecentWorkingTargetKey({ workingFolder, sshConnectionId }), {
      workingFolder,
      sshConnectionId,
      updatedAt
    })
  }

  return Array.from(deduped.values())
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_RECENT_WORKING_TARGETS)
}

function isThemeSetting(value: unknown): value is 'light' | 'dark' | 'system' {
  return value === 'light' || value === 'dark' || value === 'system'
}

export function clampMaxParallelToolCalls(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_PARALLEL_TOOL_CALLS
  return Math.min(
    MAX_MAX_PARALLEL_TOOL_CALLS,
    Math.max(MIN_MAX_PARALLEL_TOOL_CALLS, Math.floor(value))
  )
}

export function clampMaxConcurrentSubAgents(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_CONCURRENT_SUB_AGENTS
  return Math.min(
    MAX_MAX_CONCURRENT_SUB_AGENTS,
    Math.max(MIN_MAX_CONCURRENT_SUB_AGENTS, Math.floor(value))
  )
}

export function clampApiRequestTimeoutSeconds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_API_REQUEST_TIMEOUT_SECONDS
  return Math.min(
    MAX_API_REQUEST_TIMEOUT_SECONDS,
    Math.max(MIN_API_REQUEST_TIMEOUT_SECONDS, Math.floor(value))
  )
}

export function normalizeShellExecutionEndpoint(value: unknown): ShellExecutionEndpoint {
  if (
    value === 'auto' ||
    value === 'zsh' ||
    value === 'bash' ||
    value === 'sh' ||
    value === 'powershell' ||
    value === 'pwsh' ||
    value === 'cmd' ||
    value === 'custom'
  ) {
    return value
  }
  return DEFAULT_SHELL_EXECUTION_ENDPOINT
}

export function resolveShellExecutable({
  endpoint,
  customShellExecutable,
  platform
}: {
  endpoint: ShellExecutionEndpoint
  customShellExecutable?: string | null
  platform?: string | null
}): string | undefined {
  const normalizedEndpoint = normalizeShellExecutionEndpoint(endpoint)
  if (normalizedEndpoint === 'auto') return undefined
  if (normalizedEndpoint === 'custom') {
    const custom = customShellExecutable?.trim()
    return custom || undefined
  }

  const normalizedPlatform = platform?.trim().toLowerCase()
  if (normalizedPlatform === 'win32') {
    if (normalizedEndpoint === 'powershell') return 'powershell.exe'
    if (normalizedEndpoint === 'pwsh') return 'pwsh.exe'
    if (normalizedEndpoint === 'cmd') return 'cmd.exe'
    return undefined
  }

  if (normalizedEndpoint === 'zsh') return '/bin/zsh'
  if (normalizedEndpoint === 'bash') return '/bin/bash'
  if (normalizedEndpoint === 'sh') return '/bin/sh'
  return undefined
}

export function getReasoningEffortKey(
  providerId?: string | null,
  modelId?: string | null
): string | null {
  if (!providerId || !modelId) return null
  return `${providerId}:${modelId}`
}

export function resolveReasoningEffortForModel({
  reasoningEffort,
  reasoningEffortByModel,
  providerId,
  modelId,
  thinkingConfig
}: {
  reasoningEffort: ReasoningEffortLevel
  reasoningEffortByModel?: Record<string, ReasoningEffortLevel>
  providerId?: string | null
  modelId?: string | null
  thinkingConfig?: ThinkingConfig
}): ReasoningEffortLevel {
  const key = getReasoningEffortKey(providerId, modelId)
  const levels = thinkingConfig?.reasoningEffortLevels
  const savedEffort = key ? reasoningEffortByModel?.[key] : undefined

  if (savedEffort && (!levels || levels.includes(savedEffort))) {
    return savedEffort
  }

  return thinkingConfig?.defaultReasoningEffort ?? reasoningEffort
}

interface SettingsStore {
  provider: ProviderType
  apiKey: string
  baseUrl: string
  model: string
  fastModel: string
  maxTokens: number
  temperature: number
  systemPrompt: string
  theme: 'light' | 'dark' | 'system'
  themePreset: AppThemePreset
  sshTerminalThemePreset: SshTerminalThemePreset
  language: AppLanguage
  autoApprove: boolean
  permissionPolicy: PermissionPolicy
  autoUpdateEnabled: boolean
  clarifyAutoAcceptRecommended: boolean
  clarifyPlanModeAutoSwitchTarget: ClarifyPlanModeAutoSwitchTarget
  devMode: boolean
  thinkingEnabled: boolean
  fastModeEnabled: boolean
  reasoningEffort: ReasoningEffortLevel
  reasoningEffortByModel: Record<string, ReasoningEffortLevel>
  teamToolsEnabled: boolean
  builtinBrowserEnabled: boolean
  hooksEnabled: boolean
  browserUserDataReuseEnabled: boolean
  browserUserDataSource: BrowserUserDataSource
  contextCompressionEnabled: boolean
  /** Global trigger ratio shared by every chat model. */
  contextCompressionThreshold: number
  /** Dedicated summarizer model. Null keeps using the current session model. */
  contextCompressionModel: ModelBinding | null
  editorWorkspaceEnabled: boolean
  editorRemoteLanguageServiceEnabled: boolean
  maxParallelToolCalls: number
  maxConcurrentSubAgents: number
  /**
   * Deadline for an AI provider request to return its response headers, in seconds.
   * 0 waits indefinitely — useful for local models with a long time to first token.
   */
  apiRequestTimeoutSeconds: number
  toolResultFormat: 'toon' | 'json'
  fileDiffViewMode: FileDiffViewMode
  shellExecutionEndpoint: ShellExecutionEndpoint
  customShellExecutable: string
  shellEnvironmentVariablesText: string
  userName: string
  userAvatar: string
  onboardingCompleted: boolean
  onboardingCompletedAt: number | null
  onboardingInterests: string[]
  defaultSoulTemplateId: string
  conversationGuideSeen: boolean
  memoryAutomationEnabled: boolean
  memoryAutomationWritePolicy: MemoryAutomationWritePolicy
  memoryAutomationMainSessionsOnly: boolean
  memoryAutomationSummaryBudgetTokens: number
  memoryAutomationDailyRollupEnabled: boolean
  memoryUseMemories: boolean
  memoryGenerateMemories: boolean
  memoryScopeMode: MemoryScopeMode
  memoryMaxRolloutsPerStartup: number
  memoryMinRolloutIdleHours: number
  memoryMaxRawMemoriesForConsolidation: number
  memoryMaxUnusedDays: number
  memorySummaryBudgetTokens: number
  memoryDailyRollupEnabled: boolean

  // Appearance Settings
  backgroundColor: string
  fontFamily: string
  fontSize: number
  animationsEnabled: boolean
  liveOutputAnimationStyle: LiveOutputAnimationStyle
  toolbarCollapsedByDefault: boolean
  leftSidebarWidth: number

  // Web Search Settings
  webSearchEnabled: boolean
  webSearchProvider:
    | 'tavily'
    | 'searxng'
    | 'exa'
    | 'exa-mcp'
    | 'bocha'
    | 'zhipu'
    | 'google'
    | 'bing'
    | 'baidu'
  webSearchApiKey: string
  webSearchEngine: string
  webSearchMaxResults: number
  webSearchTimeout: number

  // CodeGraph Settings (opt-in standalone sidecar; default off)
  codegraphEnabled: boolean
  // Register the full 8-tool CodeGraph surface for agents (default: explore only,
  // matching upstream's DEFAULT_MCP_TOOLS)
  codegraphFullToolSurface: boolean

  // Network Settings
  systemProxyUrl: string

  // Skills Market Settings
  skillsMarketProvider: 'skillsmp'
  skillsMarketApiKey: string

  // Prompt Recommendation Settings
  promptRecommendationModels: PromptRecommendationModelBindings
  newSessionDefaultModel: SessionDefaultModelBinding | null
  mainModelSelectionMode: MainModelSelectionMode
  claudeCodeConfigs: ClaudeCodeConfig[]
  codexConfigs: CodexConfig[]
  projectDefaultDirectoryMode: ProjectDefaultDirectoryMode
  projectDefaultDirectory: string
  lastProjectDirectory: string
  recentWorkingTargets: RecentWorkingTarget[]

  updateSettings: (patch: Partial<SettingsStoreData>) => void
  pushRecentWorkingTarget: (target: {
    workingFolder: string
    sshConnectionId?: string | null
  }) => void
  clearRecentWorkingTargets: () => void
}

type SettingsStoreData = Omit<
  SettingsStore,
  'updateSettings' | 'pushRecentWorkingTarget' | 'clearRecentWorkingTargets'
>

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      provider: 'anthropic',
      apiKey: '',
      baseUrl: '',
      model: 'claude-sonnet-4-20250514',
      fastModel: 'claude-3-5-haiku-20241022',
      maxTokens: 32000,
      temperature: 0.7,
      systemPrompt: '',
      theme: DEFAULT_THEME_MODE,
      themePreset: DEFAULT_APP_THEME_PRESET,
      sshTerminalThemePreset: DEFAULT_SSH_TERMINAL_THEME_PRESET,
      language: detectSystemLanguage(),
      autoApprove: false,
      permissionPolicy: { ...DEFAULT_PERMISSION_POLICY },
      autoUpdateEnabled: true,
      clarifyAutoAcceptRecommended: false,
      clarifyPlanModeAutoSwitchTarget: 'off',
      devMode: false,
      thinkingEnabled: false,
      fastModeEnabled: false,
      reasoningEffort: 'medium',
      reasoningEffortByModel: {},
      teamToolsEnabled: false,
      builtinBrowserEnabled: true,
      hooksEnabled: false,
      browserUserDataReuseEnabled: true,
      browserUserDataSource: DEFAULT_BROWSER_USER_DATA_SOURCE,
      contextCompressionEnabled: true,
      contextCompressionThreshold: 0.8,
      contextCompressionModel: null,
      editorWorkspaceEnabled: false,
      editorRemoteLanguageServiceEnabled: false,
      maxParallelToolCalls: DEFAULT_MAX_PARALLEL_TOOL_CALLS,
      maxConcurrentSubAgents: DEFAULT_MAX_CONCURRENT_SUB_AGENTS,
      apiRequestTimeoutSeconds: DEFAULT_API_REQUEST_TIMEOUT_SECONDS,
      toolResultFormat: 'toon',
      fileDiffViewMode: 'split',
      shellExecutionEndpoint: DEFAULT_SHELL_EXECUTION_ENDPOINT,
      customShellExecutable: '',
      shellEnvironmentVariablesText: '',
      userName: '',
      userAvatar: '',
      onboardingCompleted: false,
      onboardingCompletedAt: null,
      onboardingInterests: [],
      defaultSoulTemplateId: '',
      conversationGuideSeen: false,
      memoryAutomationEnabled: true,
      memoryAutomationWritePolicy: 'auto',
      memoryAutomationMainSessionsOnly: true,
      memoryAutomationSummaryBudgetTokens: 12_000,
      memoryAutomationDailyRollupEnabled: true,
      memoryUseMemories: true,
      memoryGenerateMemories: true,
      memoryScopeMode: 'hybrid',
      memoryMaxRolloutsPerStartup: 8,
      memoryMinRolloutIdleHours: 0,
      memoryMaxRawMemoriesForConsolidation: 500,
      memoryMaxUnusedDays: 180,
      memorySummaryBudgetTokens: 12_000,
      memoryDailyRollupEnabled: true,

      // Appearance Settings
      backgroundColor: '',
      fontFamily: '',
      fontSize: 16,
      animationsEnabled: true,
      liveOutputAnimationStyle: 'agile',
      toolbarCollapsedByDefault: false,
      leftSidebarWidth: LEFT_SIDEBAR_DEFAULT_WIDTH,

      // Web Search Settings
      webSearchEnabled: false,
      webSearchProvider: 'tavily',
      webSearchApiKey: '',
      webSearchEngine: 'google',
      webSearchMaxResults: 5,
      webSearchTimeout: 30000,

      // CodeGraph Settings (opt-in standalone sidecar; default off)
      codegraphEnabled: false,
      codegraphFullToolSurface: false,

      // Network Settings
      systemProxyUrl: '',

      // Skills Market Settings
      skillsMarketProvider: 'skillsmp',
      skillsMarketApiKey: '',

      // Prompt Recommendation Settings
      promptRecommendationModels: {
        chat: null,
        clarify: null,
        cowork: null,
        code: null,
        acp: null
      },
      newSessionDefaultModel: null,
      mainModelSelectionMode: 'auto',
      claudeCodeConfigs: [createDefaultClaudeCodeConfig()],
      codexConfigs: [createDefaultCodexConfig()],
      projectDefaultDirectoryMode: 'last-used',
      projectDefaultDirectory: '',
      lastProjectDirectory: '',
      recentWorkingTargets: [],

      updateSettings: (patch) =>
        set((state) => {
          const nextPatch = {
            ...patch,
            ...(patch.maxParallelToolCalls === undefined
              ? {}
              : { maxParallelToolCalls: clampMaxParallelToolCalls(patch.maxParallelToolCalls) }),
            ...(patch.maxConcurrentSubAgents === undefined
              ? {}
              : {
                  maxConcurrentSubAgents: clampMaxConcurrentSubAgents(patch.maxConcurrentSubAgents)
                }),
            ...(patch.apiRequestTimeoutSeconds === undefined
              ? {}
              : {
                  apiRequestTimeoutSeconds: clampApiRequestTimeoutSeconds(
                    patch.apiRequestTimeoutSeconds
                  )
                })
          }

          const hasChanges = (Object.keys(nextPatch) as Array<keyof SettingsStoreData>).some(
            (key) => !Object.is(state[key], nextPatch[key])
          )
          return hasChanges ? nextPatch : state
        }),
      pushRecentWorkingTarget: (target) =>
        set((state) => ({
          recentWorkingTargets: sanitizeRecentWorkingTargets([
            {
              workingFolder: normalizeWorkingFolderPath(target.workingFolder),
              sshConnectionId: target.sshConnectionId ?? null,
              updatedAt: Date.now()
            },
            ...state.recentWorkingTargets
          ])
        })),
      clearRecentWorkingTargets: () => set({ recentWorkingTargets: [] })
    }),
    {
      name: 'opencowork-settings',
      version: 30,
      storage: createJSONStorage(() => ipcStorage),
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as Record<string, unknown>
        const matchesLegacyThemeDefaults =
          (state.theme === undefined || state.theme === LEGACY_DEFAULT_THEME_MODE) &&
          (state.themePreset === undefined ||
            state.themePreset === LEGACY_DEFAULT_APP_THEME_PRESET) &&
          (state.sshTerminalThemePreset === undefined ||
            state.sshTerminalThemePreset === LEGACY_DEFAULT_SSH_TERMINAL_THEME_PRESET)
        const matchesV17ThemeDefaults =
          (state.theme === undefined || state.theme === V17_DEFAULT_THEME_MODE) &&
          (state.themePreset === undefined || state.themePreset === V17_DEFAULT_APP_THEME_PRESET) &&
          (state.sshTerminalThemePreset === undefined ||
            state.sshTerminalThemePreset === V17_DEFAULT_SSH_TERMINAL_THEME_PRESET)
        const matchesV18ThemeDefaults =
          (state.theme === undefined || state.theme === V18_DEFAULT_THEME_MODE) &&
          (state.themePreset === undefined || state.themePreset === V18_DEFAULT_APP_THEME_PRESET) &&
          (state.sshTerminalThemePreset === undefined ||
            state.sshTerminalThemePreset === V18_DEFAULT_SSH_TERMINAL_THEME_PRESET)
        if (typeof state.language === 'string') {
          state.language = normalizeLanguageCode(state.language)
        } else {
          state.language = detectSystemLanguage()
        }
        // Add web search settings if missing
        if (state.webSearchEnabled === undefined) {
          state.webSearchEnabled = false
          state.webSearchProvider = 'tavily'
          state.webSearchApiKey = ''
          state.webSearchEngine = 'google'
          state.webSearchMaxResults = 5
          state.webSearchTimeout = 30000
        }
        if (state.systemProxyUrl === undefined) {
          state.systemProxyUrl = ''
        }
        // Add CodeGraph opt-in flag if missing (default off)
        if (state.codegraphEnabled === undefined) {
          state.codegraphEnabled = false
        }
        if (state.codegraphFullToolSurface === undefined) {
          state.codegraphFullToolSurface = false
        }
        // Add skills market settings if missing
        if (state.skillsMarketProvider === undefined || state.skillsMarketProvider !== 'skillsmp') {
          state.skillsMarketProvider = 'skillsmp'
          state.skillsMarketApiKey = state.skillsMarketApiKey ?? ''
        }
        if (state.promptRecommendationModels === undefined) {
          state.promptRecommendationModels = {
            chat: null,
            clarify: null,
            cowork: null,
            code: null,
            acp: null
          }
        } else if (
          (state.promptRecommendationModels as Record<string, unknown>).acp === undefined
        ) {
          ;(
            state.promptRecommendationModels as Record<string, PromptRecommendationModelBinding>
          ).acp = null
        }
        if (state.newSessionDefaultModel === undefined) {
          state.newSessionDefaultModel = null
        }
        if (
          typeof state.contextCompressionThreshold !== 'number' ||
          !Number.isFinite(state.contextCompressionThreshold)
        ) {
          state.contextCompressionThreshold = 0.8
        } else {
          state.contextCompressionThreshold = Math.min(
            0.9,
            Math.max(0.3, state.contextCompressionThreshold)
          )
        }
        if (
          !state.contextCompressionModel ||
          typeof state.contextCompressionModel !== 'object' ||
          Array.isArray(state.contextCompressionModel) ||
          typeof (state.contextCompressionModel as Record<string, unknown>).providerId !==
            'string' ||
          typeof (state.contextCompressionModel as Record<string, unknown>).modelId !== 'string'
        ) {
          state.contextCompressionModel = null
        }
        if (state.mainModelSelectionMode === undefined) {
          state.mainModelSelectionMode = 'auto'
        }
        state.claudeCodeConfigs = sanitizeClaudeCodeConfigs(state.claudeCodeConfigs)
        state.codexConfigs = sanitizeCodexConfigs(state.codexConfigs)
        state.permissionPolicy = sanitizePermissionPolicy(state.permissionPolicy)
        if (state.projectDefaultDirectoryMode === undefined) {
          state.projectDefaultDirectoryMode = 'last-used'
        }
        if (state.projectDefaultDirectory === undefined) {
          state.projectDefaultDirectory = ''
        }
        if (state.lastProjectDirectory === undefined) {
          state.lastProjectDirectory = ''
        }
        state.recentWorkingTargets = sanitizeRecentWorkingTargets(state.recentWorkingTargets)
        // Add appearance settings if missing
        if (!isThemeSetting(state.theme)) {
          state.theme = DEFAULT_THEME_MODE
        } else if (
          (version < 17 && matchesLegacyThemeDefaults) ||
          (version < 18 && matchesV17ThemeDefaults) ||
          (version < 19 && matchesV18ThemeDefaults)
        ) {
          state.theme = DEFAULT_THEME_MODE
        }
        if (state.backgroundColor === undefined) {
          state.backgroundColor = ''
        }
        if (!isAppThemePreset(state.themePreset)) {
          state.themePreset = DEFAULT_APP_THEME_PRESET
        } else if (
          (version < 17 && matchesLegacyThemeDefaults) ||
          (version < 18 && matchesV17ThemeDefaults) ||
          (version < 19 && matchesV18ThemeDefaults)
        ) {
          state.themePreset = DEFAULT_APP_THEME_PRESET
        }
        if (!isAppThemePreset(state.sshTerminalThemePreset)) {
          state.sshTerminalThemePreset = DEFAULT_SSH_TERMINAL_THEME_PRESET
        } else if (
          (version < 17 && matchesLegacyThemeDefaults) ||
          (version < 18 && matchesV17ThemeDefaults) ||
          (version < 19 && matchesV18ThemeDefaults)
        ) {
          state.sshTerminalThemePreset = DEFAULT_SSH_TERMINAL_THEME_PRESET
        }
        if (state.fontFamily === undefined) {
          state.fontFamily = ''
        }
        if (state.fontSize === undefined || typeof state.fontSize !== 'number') {
          state.fontSize = 16
        }
        if (state.animationsEnabled === undefined) {
          state.animationsEnabled = true
        }
        if (
          state.liveOutputAnimationStyle === undefined ||
          (state.liveOutputAnimationStyle !== 'agile' &&
            state.liveOutputAnimationStyle !== 'elegant')
        ) {
          state.liveOutputAnimationStyle = 'agile'
        }
        if (state.toolbarCollapsedByDefault === undefined) {
          state.toolbarCollapsedByDefault = false
        }
        if (state.leftSidebarWidth === undefined || typeof state.leftSidebarWidth !== 'number') {
          state.leftSidebarWidth = LEFT_SIDEBAR_DEFAULT_WIDTH
        } else {
          state.leftSidebarWidth = clampLeftSidebarWidth(state.leftSidebarWidth)
        }
        if (state.autoUpdateEnabled === undefined) {
          state.autoUpdateEnabled = true
        }
        if (state.clarifyAutoAcceptRecommended === undefined) {
          state.clarifyAutoAcceptRecommended = false
        }
        if (state.clarifyPlanModeAutoSwitchTarget === undefined) {
          state.clarifyPlanModeAutoSwitchTarget = 'off'
        }
        if (state.editorWorkspaceEnabled === undefined) {
          state.editorWorkspaceEnabled = false
        }
        if (state.editorRemoteLanguageServiceEnabled === undefined) {
          state.editorRemoteLanguageServiceEnabled = false
        }
        if (typeof state.hooksEnabled !== 'boolean') {
          state.hooksEnabled = false
        }
        if (
          state.maxParallelToolCalls === undefined ||
          typeof state.maxParallelToolCalls !== 'number'
        ) {
          state.maxParallelToolCalls = DEFAULT_MAX_PARALLEL_TOOL_CALLS
        } else {
          state.maxParallelToolCalls = clampMaxParallelToolCalls(state.maxParallelToolCalls)
        }
        if (
          state.maxConcurrentSubAgents === undefined ||
          typeof state.maxConcurrentSubAgents !== 'number'
        ) {
          state.maxConcurrentSubAgents = DEFAULT_MAX_CONCURRENT_SUB_AGENTS
        } else {
          state.maxConcurrentSubAgents = clampMaxConcurrentSubAgents(state.maxConcurrentSubAgents)
        }
        if (
          state.apiRequestTimeoutSeconds === undefined ||
          typeof state.apiRequestTimeoutSeconds !== 'number'
        ) {
          state.apiRequestTimeoutSeconds = DEFAULT_API_REQUEST_TIMEOUT_SECONDS
        } else {
          state.apiRequestTimeoutSeconds = clampApiRequestTimeoutSeconds(
            state.apiRequestTimeoutSeconds
          )
        }
        if (state.reasoningEffortByModel === undefined) {
          state.reasoningEffortByModel = {}
        }
        if (state.toolResultFormat === undefined) {
          state.toolResultFormat = 'toon'
        }
        if (state.fileDiffViewMode === undefined) {
          state.fileDiffViewMode = 'split'
        }
        if (state.browserUserDataReuseEnabled === undefined) {
          state.browserUserDataReuseEnabled = true
        }
        state.browserUserDataSource = normalizeBrowserUserDataSource(state.browserUserDataSource)
        state.shellExecutionEndpoint = normalizeShellExecutionEndpoint(state.shellExecutionEndpoint)
        if (typeof state.customShellExecutable !== 'string') {
          state.customShellExecutable = ''
        }
        if (typeof state.shellEnvironmentVariablesText !== 'string') {
          state.shellEnvironmentVariablesText = ''
        }
        if (state.onboardingCompleted === undefined) {
          state.onboardingCompleted = false
        }
        if (
          state.onboardingCompletedAt !== null &&
          typeof state.onboardingCompletedAt !== 'number'
        ) {
          state.onboardingCompletedAt = null
        }
        if (!Array.isArray(state.onboardingInterests)) {
          state.onboardingInterests = []
        } else {
          state.onboardingInterests = state.onboardingInterests.filter(
            (item): item is string => typeof item === 'string' && item.trim().length > 0
          )
        }
        if (typeof state.defaultSoulTemplateId !== 'string') {
          state.defaultSoulTemplateId = ''
        }
        if (state.conversationGuideSeen === undefined) {
          state.conversationGuideSeen = false
        }
        if (state.memoryAutomationEnabled === undefined) {
          state.memoryAutomationEnabled = true
        }
        state.memoryAutomationWritePolicy = 'auto'
        if (state.memoryAutomationMainSessionsOnly === undefined) {
          state.memoryAutomationMainSessionsOnly = true
        }
        if (
          state.memoryAutomationSummaryBudgetTokens === undefined ||
          typeof state.memoryAutomationSummaryBudgetTokens !== 'number'
        ) {
          state.memoryAutomationSummaryBudgetTokens = 12_000
        }
        if (state.memoryAutomationDailyRollupEnabled === undefined) {
          state.memoryAutomationDailyRollupEnabled = true
        }
        if (state.memoryUseMemories === undefined) {
          state.memoryUseMemories = true
        }
        if (state.memoryGenerateMemories === undefined) {
          state.memoryGenerateMemories = state.memoryAutomationEnabled
        }
        state.memoryScopeMode = 'hybrid'
        if (
          state.memoryMaxRolloutsPerStartup === undefined ||
          typeof state.memoryMaxRolloutsPerStartup !== 'number'
        ) {
          state.memoryMaxRolloutsPerStartup = 8
        }
        if (
          state.memoryMinRolloutIdleHours === undefined ||
          typeof state.memoryMinRolloutIdleHours !== 'number'
        ) {
          state.memoryMinRolloutIdleHours = 0
        }
        if (
          state.memoryMaxRawMemoriesForConsolidation === undefined ||
          typeof state.memoryMaxRawMemoriesForConsolidation !== 'number'
        ) {
          state.memoryMaxRawMemoriesForConsolidation = 500
        }
        if (
          state.memoryMaxUnusedDays === undefined ||
          typeof state.memoryMaxUnusedDays !== 'number'
        ) {
          state.memoryMaxUnusedDays = 180
        }
        if (
          state.memorySummaryBudgetTokens === undefined ||
          typeof state.memorySummaryBudgetTokens !== 'number'
        ) {
          state.memorySummaryBudgetTokens = state.memoryAutomationSummaryBudgetTokens
        }
        if (state.memoryDailyRollupEnabled === undefined) {
          state.memoryDailyRollupEnabled = state.memoryAutomationDailyRollupEnabled
        }
        return state as unknown as SettingsStore
      },
      partialize: (state) => ({
        provider: state.provider,
        baseUrl: state.baseUrl,
        model: state.model,
        fastModel: state.fastModel,
        maxTokens: state.maxTokens,
        temperature: state.temperature,
        systemPrompt: state.systemPrompt,
        theme: state.theme,
        themePreset: state.themePreset,
        sshTerminalThemePreset: state.sshTerminalThemePreset,
        language: state.language,
        autoApprove: state.autoApprove,
        permissionPolicy: state.permissionPolicy,
        autoUpdateEnabled: state.autoUpdateEnabled,
        clarifyAutoAcceptRecommended: state.clarifyAutoAcceptRecommended,
        clarifyPlanModeAutoSwitchTarget: state.clarifyPlanModeAutoSwitchTarget,
        devMode: state.devMode,
        thinkingEnabled: state.thinkingEnabled,
        fastModeEnabled: state.fastModeEnabled,
        reasoningEffort: state.reasoningEffort,
        reasoningEffortByModel: state.reasoningEffortByModel,
        teamToolsEnabled: state.teamToolsEnabled,
        contextCompressionEnabled: state.contextCompressionEnabled,
        contextCompressionThreshold: state.contextCompressionThreshold,
        contextCompressionModel: state.contextCompressionModel,
        editorWorkspaceEnabled: state.editorWorkspaceEnabled,
        editorRemoteLanguageServiceEnabled: state.editorRemoteLanguageServiceEnabled,
        maxParallelToolCalls: clampMaxParallelToolCalls(state.maxParallelToolCalls),
        maxConcurrentSubAgents: clampMaxConcurrentSubAgents(state.maxConcurrentSubAgents),
        apiRequestTimeoutSeconds: clampApiRequestTimeoutSeconds(state.apiRequestTimeoutSeconds),
        toolResultFormat: state.toolResultFormat,
        fileDiffViewMode: state.fileDiffViewMode,
        shellExecutionEndpoint: normalizeShellExecutionEndpoint(state.shellExecutionEndpoint),
        customShellExecutable: state.customShellExecutable,
        shellEnvironmentVariablesText: state.shellEnvironmentVariablesText,
        userName: state.userName,
        userAvatar: state.userAvatar,
        onboardingCompleted: state.onboardingCompleted,
        onboardingCompletedAt: state.onboardingCompletedAt,
        onboardingInterests: state.onboardingInterests,
        defaultSoulTemplateId: state.defaultSoulTemplateId,
        conversationGuideSeen: state.conversationGuideSeen,
        memoryAutomationEnabled: state.memoryAutomationEnabled,
        memoryAutomationWritePolicy: 'auto' as const,
        memoryAutomationMainSessionsOnly: state.memoryAutomationMainSessionsOnly,
        memoryAutomationSummaryBudgetTokens: state.memoryAutomationSummaryBudgetTokens,
        memoryAutomationDailyRollupEnabled: state.memoryAutomationDailyRollupEnabled,
        memoryUseMemories: state.memoryUseMemories,
        memoryGenerateMemories: state.memoryGenerateMemories,
        memoryScopeMode: 'hybrid' as const,
        memoryMaxRolloutsPerStartup: state.memoryMaxRolloutsPerStartup,
        memoryMinRolloutIdleHours: state.memoryMinRolloutIdleHours,
        memoryMaxRawMemoriesForConsolidation: state.memoryMaxRawMemoriesForConsolidation,
        memoryMaxUnusedDays: state.memoryMaxUnusedDays,
        memorySummaryBudgetTokens: state.memorySummaryBudgetTokens,
        memoryDailyRollupEnabled: state.memoryDailyRollupEnabled,
        // Appearance Settings
        backgroundColor: state.backgroundColor,
        fontFamily: state.fontFamily,
        fontSize: state.fontSize,
        animationsEnabled: state.animationsEnabled,
        liveOutputAnimationStyle: state.liveOutputAnimationStyle,
        toolbarCollapsedByDefault: state.toolbarCollapsedByDefault,
        leftSidebarWidth: clampLeftSidebarWidth(state.leftSidebarWidth),
        // Web Search Settings
        webSearchEnabled: state.webSearchEnabled,
        webSearchProvider: state.webSearchProvider,
        webSearchApiKey: state.webSearchApiKey,
        webSearchEngine: state.webSearchEngine,
        webSearchMaxResults: state.webSearchMaxResults,
        webSearchTimeout: state.webSearchTimeout,
        // CodeGraph Settings
        codegraphEnabled: state.codegraphEnabled,
        codegraphFullToolSurface: state.codegraphFullToolSurface,
        // Network Settings
        systemProxyUrl: state.systemProxyUrl,
        // Skills Market Settings
        skillsMarketProvider: state.skillsMarketProvider,
        skillsMarketApiKey: state.skillsMarketApiKey,
        // Prompt Recommendation Settings
        promptRecommendationModels: state.promptRecommendationModels,
        newSessionDefaultModel: state.newSessionDefaultModel,
        mainModelSelectionMode: state.mainModelSelectionMode,
        claudeCodeConfigs: state.claudeCodeConfigs,
        codexConfigs: state.codexConfigs,
        projectDefaultDirectoryMode: state.projectDefaultDirectoryMode,
        projectDefaultDirectory: state.projectDefaultDirectory,
        lastProjectDirectory: state.lastProjectDirectory,
        recentWorkingTargets: state.recentWorkingTargets,
        builtinBrowserEnabled: state.builtinBrowserEnabled,
        hooksEnabled: state.hooksEnabled,
        browserUserDataReuseEnabled: state.browserUserDataReuseEnabled,
        browserUserDataSource: normalizeBrowserUserDataSource(state.browserUserDataSource)
        // NOTE: apiKey is intentionally excluded from localStorage persistence.
        // In production, it should be stored securely in the main process.
      })
    }
  )
)
