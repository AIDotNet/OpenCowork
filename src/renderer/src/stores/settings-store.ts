import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { ProviderType, ReasoningEffortLevel } from '../lib/api/types'
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
  'chat' | 'clarify' | 'cowork' | 'code',
  PromptRecommendationModelBinding
>

export type MainModelSelectionMode = 'auto' | 'manual'

function getSystemLanguage(): 'en' | 'zh' {
  const lang = navigator.language || navigator.languages?.[0] || 'en'
  return lang.startsWith('zh') ? 'zh' : 'en'
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
  clarifyAutoAcceptRecommended: boolean
  devMode: boolean
  thinkingEnabled: boolean
  fastModeEnabled: boolean
  reasoningEffort: ReasoningEffortLevel
  teamToolsEnabled: boolean
  contextCompressionEnabled: boolean
  editorWorkspaceEnabled: boolean
  editorRemoteLanguageServiceEnabled: boolean
  toolResultFormat: 'toon' | 'json'
  userName: string
  userAvatar: string

  // Appearance Settings
  backgroundColor: string
  fontFamily: string
  fontSize: number
  animationsEnabled: boolean
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

  // Skills Market Settings
  skillsMarketProvider: 'skillsmp'
  skillsMarketApiKey: string

  // Prompt Recommendation Settings
  promptRecommendationModels: PromptRecommendationModelBindings
  newSessionDefaultModel: SessionDefaultModelBinding | null
  mainModelSelectionMode: MainModelSelectionMode

  updateSettings: (patch: Partial<Omit<SettingsStore, 'updateSettings'>>) => void
}

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
      clarifyAutoAcceptRecommended: false,
      devMode: false,
      thinkingEnabled: false,
      fastModeEnabled: false,
      reasoningEffort: 'medium',
      teamToolsEnabled: false,
      contextCompressionEnabled: true,
      editorWorkspaceEnabled: false,
      editorRemoteLanguageServiceEnabled: false,
      toolResultFormat: 'toon',
      userName: '',
      userAvatar: '',

      // Appearance Settings
      backgroundColor: '',
      fontFamily: '',
      fontSize: 16,
      animationsEnabled: true,
      toolbarCollapsedByDefault: false,
      leftSidebarWidth: LEFT_SIDEBAR_DEFAULT_WIDTH,

      // Web Search Settings
      webSearchEnabled: false,
      webSearchProvider: 'tavily',
      webSearchApiKey: '',
      webSearchEngine: 'google',
      webSearchMaxResults: 5,
      webSearchTimeout: 30000,

      // Skills Market Settings
      skillsMarketProvider: 'skillsmp',
      skillsMarketApiKey: '',

      // Prompt Recommendation Settings
      promptRecommendationModels: {
        chat: null,
        clarify: null,
        cowork: null,
        code: null
      },
      newSessionDefaultModel: null,
      mainModelSelectionMode: 'auto',

      updateSettings: (patch) => set(patch)
    }),
    {
      name: 'opencowork-settings',
      version: 7,
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
            code: null
          }
        }
        if (state.newSessionDefaultModel === undefined) {
          state.newSessionDefaultModel = null
        }
        if (state.mainModelSelectionMode === undefined) {
          state.mainModelSelectionMode = 'auto'
        }
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
        if (state.toolbarCollapsedByDefault === undefined) {
          state.toolbarCollapsedByDefault = false
        }
        if (state.leftSidebarWidth === undefined || typeof state.leftSidebarWidth !== 'number') {
          state.leftSidebarWidth = LEFT_SIDEBAR_DEFAULT_WIDTH
        } else {
          state.leftSidebarWidth = clampLeftSidebarWidth(state.leftSidebarWidth)
        }
        if (state.clarifyAutoAcceptRecommended === undefined) {
          state.clarifyAutoAcceptRecommended = false
        }
        if (state.editorWorkspaceEnabled === undefined) {
          state.editorWorkspaceEnabled = false
        }
        if (state.editorRemoteLanguageServiceEnabled === undefined) {
          state.editorRemoteLanguageServiceEnabled = false
        }
        if (state.toolResultFormat === undefined) {
          state.toolResultFormat = 'toon'
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
        clarifyAutoAcceptRecommended: state.clarifyAutoAcceptRecommended,
        devMode: state.devMode,
        thinkingEnabled: state.thinkingEnabled,
        fastModeEnabled: state.fastModeEnabled,
        reasoningEffort: state.reasoningEffort,
        teamToolsEnabled: state.teamToolsEnabled,
        contextCompressionEnabled: state.contextCompressionEnabled,
        editorWorkspaceEnabled: state.editorWorkspaceEnabled,
        editorRemoteLanguageServiceEnabled: state.editorRemoteLanguageServiceEnabled,
        toolResultFormat: state.toolResultFormat,
        userName: state.userName,
        userAvatar: state.userAvatar,
        // Appearance Settings
        backgroundColor: state.backgroundColor,
        fontFamily: state.fontFamily,
        fontSize: state.fontSize,
        animationsEnabled: state.animationsEnabled,
        toolbarCollapsedByDefault: state.toolbarCollapsedByDefault,
        leftSidebarWidth: clampLeftSidebarWidth(state.leftSidebarWidth),
        // Web Search Settings
        webSearchEnabled: state.webSearchEnabled,
        webSearchProvider: state.webSearchProvider,
        webSearchApiKey: state.webSearchApiKey,
        webSearchEngine: state.webSearchEngine,
        webSearchMaxResults: state.webSearchMaxResults,
        webSearchTimeout: state.webSearchTimeout,
        // Skills Market Settings
        skillsMarketProvider: state.skillsMarketProvider,
        skillsMarketApiKey: state.skillsMarketApiKey,
        // Prompt Recommendation Settings
        promptRecommendationModels: state.promptRecommendationModels,
        newSessionDefaultModel: state.newSessionDefaultModel,
        mainModelSelectionMode: state.mainModelSelectionMode
        // NOTE: apiKey is intentionally excluded from localStorage persistence.
        // In production, it should be stored securely in the main process.
      })
    }
  )
)
