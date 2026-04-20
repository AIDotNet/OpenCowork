import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { ProviderType, ReasoningEffortLevel, ThinkingConfig } from '../lib/api/types'
import { ipcStorage } from '../lib/ipc/ipc-storage'
import {
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  clampLeftSidebarWidth
} from '@renderer/components/layout/right-panel-defs'

export interface ModelBinding {
  providerId: string
  modelId: string
}

export interface SessionDefaultModelBinding extends ModelBinding {
  useGlobalActiveModel: boolean
}

export type PromptRecommendationModelBinding = ModelBinding | 'disabled' | null

export type PromptRecommendationModelBindings = Record<
  'chat' | 'clarify' | 'cowork' | 'code' | 'acp',
  PromptRecommendationModelBinding
>

export type MainModelSelectionMode = 'auto' | 'manual'
export type ClarifyPlanModeAutoSwitchTarget = 'off' | 'code' | 'acp'
export type ProjectDefaultDirectoryMode = 'last-used' | 'custom'
export type FileDiffViewMode = 'split' | 'inline'
export type LiveOutputAnimationStyle = 'agile' | 'elegant'

export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 8
export const MIN_MAX_PARALLEL_TOOL_CALLS = 1
export const MAX_MAX_PARALLEL_TOOL_CALLS = 16

export interface RecentWorkingTarget {
  workingFolder: string
  sshConnectionId: string | null
  updatedAt: number
}

const MAX_RECENT_WORKING_TARGETS = 8

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

function getSystemLanguage(): 'en' | 'zh' {
  const lang = navigator.language || navigator.languages?.[0] || 'en'
  return lang.startsWith('zh') ? 'zh' : 'en'
}

export function clampMaxParallelToolCalls(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_PARALLEL_TOOL_CALLS
  return Math.min(
    MAX_MAX_PARALLEL_TOOL_CALLS,
    Math.max(MIN_MAX_PARALLEL_TOOL_CALLS, Math.floor(value))
  )
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
  language: 'en' | 'zh'
  autoApprove: boolean
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
  contextCompressionEnabled: boolean
  editorWorkspaceEnabled: boolean
  editorRemoteLanguageServiceEnabled: boolean
  maxParallelToolCalls: number
  toolResultFormat: 'toon' | 'json'
  fileDiffViewMode: FileDiffViewMode
  userName: string
  userAvatar: string
  conversationGuideSeen: boolean

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

  // Network Settings
  systemProxyUrl: string

  // Skills Market Settings
  skillsMarketProvider: 'skillsmp'
  skillsMarketApiKey: string

  // Prompt Recommendation Settings
  promptRecommendationModels: PromptRecommendationModelBindings
  newSessionDefaultModel: SessionDefaultModelBinding | null
  mainModelSelectionMode: MainModelSelectionMode
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
      theme: 'system',
      language: getSystemLanguage(),
      autoApprove: false,
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
      contextCompressionEnabled: true,
      editorWorkspaceEnabled: false,
      editorRemoteLanguageServiceEnabled: false,
      maxParallelToolCalls: DEFAULT_MAX_PARALLEL_TOOL_CALLS,
      toolResultFormat: 'toon',
      fileDiffViewMode: 'split',
      userName: '',
      userAvatar: '',
      conversationGuideSeen: false,

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
      projectDefaultDirectoryMode: 'last-used',
      projectDefaultDirectory: '',
      lastProjectDirectory: '',
      recentWorkingTargets: [],

      updateSettings: (patch) =>
        set({
          ...patch,
          ...(patch.maxParallelToolCalls === undefined
            ? {}
            : { maxParallelToolCalls: clampMaxParallelToolCalls(patch.maxParallelToolCalls) })
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
      version: 14,
      storage: createJSONStorage(() => ipcStorage),
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as Record<string, unknown>
        if (version === 0) {
          state.language = getSystemLanguage()
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
        if (state.mainModelSelectionMode === undefined) {
          state.mainModelSelectionMode = 'auto'
        }
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
        if (state.backgroundColor === undefined) {
          state.backgroundColor = ''
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
        if (
          state.maxParallelToolCalls === undefined ||
          typeof state.maxParallelToolCalls !== 'number'
        ) {
          state.maxParallelToolCalls = DEFAULT_MAX_PARALLEL_TOOL_CALLS
        } else {
          state.maxParallelToolCalls = clampMaxParallelToolCalls(state.maxParallelToolCalls)
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
        if (state.conversationGuideSeen === undefined) {
          state.conversationGuideSeen = false
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
        language: state.language,
        autoApprove: state.autoApprove,
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
        editorWorkspaceEnabled: state.editorWorkspaceEnabled,
        editorRemoteLanguageServiceEnabled: state.editorRemoteLanguageServiceEnabled,
        maxParallelToolCalls: clampMaxParallelToolCalls(state.maxParallelToolCalls),
        toolResultFormat: state.toolResultFormat,
        fileDiffViewMode: state.fileDiffViewMode,
        userName: state.userName,
        userAvatar: state.userAvatar,
        conversationGuideSeen: state.conversationGuideSeen,
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
        // Network Settings
        systemProxyUrl: state.systemProxyUrl,
        // Skills Market Settings
        skillsMarketProvider: state.skillsMarketProvider,
        skillsMarketApiKey: state.skillsMarketApiKey,
        // Prompt Recommendation Settings
        promptRecommendationModels: state.promptRecommendationModels,
        newSessionDefaultModel: state.newSessionDefaultModel,
        mainModelSelectionMode: state.mainModelSelectionMode,
        projectDefaultDirectoryMode: state.projectDefaultDirectoryMode,
        projectDefaultDirectory: state.projectDefaultDirectory,
        lastProjectDirectory: state.lastProjectDirectory,
        recentWorkingTargets: state.recentWorkingTargets,
        builtinBrowserEnabled: state.builtinBrowserEnabled
        // NOTE: apiKey is intentionally excluded from localStorage persistence.
        // In production, it should be stored securely in the main process.
      })
    }
  )
)
