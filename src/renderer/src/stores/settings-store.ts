import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { ProviderType, ReasoningEffortLevel } from '../lib/api/types'
import { ipcStorage } from '../lib/ipc/ipc-storage'

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
  devMode: boolean
  thinkingEnabled: boolean
  reasoningEffort: ReasoningEffortLevel
  teamToolsEnabled: boolean
  contextCompressionEnabled: boolean
  userName: string
  userAvatar: string

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
      devMode: false,
      thinkingEnabled: false,
      reasoningEffort: 'medium',
      teamToolsEnabled: false,
      contextCompressionEnabled: true,
      userName: '',
      userAvatar: '',

      updateSettings: (patch) => set(patch),
    }),
    {
      name: 'opencowork-settings',
      version: 1,
      storage: createJSONStorage(() => ipcStorage),
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as Record<string, unknown>
        if (version === 0) {
          state.language = getSystemLanguage()
        }
        return state as SettingsStore
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
        devMode: state.devMode,
        thinkingEnabled: state.thinkingEnabled,
        reasoningEffort: state.reasoningEffort,
        teamToolsEnabled: state.teamToolsEnabled,
        contextCompressionEnabled: state.contextCompressionEnabled,
        userName: state.userName,
        userAvatar: state.userAvatar,
        // NOTE: apiKey is intentionally excluded from localStorage persistence.
        // In production, it should be stored securely in the main process.
      }),
    }
  )
)
