import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { ProviderType } from '../lib/api/types'

interface SettingsStore {
  provider: ProviderType
  apiKey: string
  baseUrl: string
  model: string
  maxTokens: number
  temperature: number
  systemPrompt: string
  theme: 'light' | 'dark' | 'system'
  language: 'en' | 'zh'
  autoApprove: boolean

  updateSettings: (patch: Partial<Omit<SettingsStore, 'updateSettings'>>) => void
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      provider: 'anthropic',
      apiKey: '',
      baseUrl: '',
      model: 'claude-sonnet-4-20250514',
      maxTokens: 32000,
      temperature: 0.7,
      systemPrompt: '',
      theme: 'system',
      language: 'en',
      autoApprove: false,

      updateSettings: (patch) => set(patch),
    }),
    {
      name: 'opencowork-settings',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        provider: state.provider,
        baseUrl: state.baseUrl,
        model: state.model,
        maxTokens: state.maxTokens,
        temperature: state.temperature,
        systemPrompt: state.systemPrompt,
        theme: state.theme,
        language: state.language,
        autoApprove: state.autoApprove,
        // NOTE: apiKey is intentionally excluded from localStorage persistence.
        // In production, it should be stored securely in the main process.
      }),
    }
  )
)
