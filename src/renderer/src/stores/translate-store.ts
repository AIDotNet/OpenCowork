import { create } from 'zustand'
import { toast } from 'sonner'
import type { ProviderConfig } from '@renderer/lib/api/types'
import { streamAiTranslation } from '@renderer/lib/translate-service'
import { runTranslationAgent } from '@renderer/lib/translate-agent-service'
import { useProviderStore } from '@renderer/stores/provider-store'
import { ensureProviderAuthReady } from '@renderer/lib/auth/provider-auth'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { IPC } from '@renderer/lib/ipc/channels'

export interface AgentStep {
  id: string
  type: 'tool_use' | 'tool_result' | 'agent_text' | 'iteration'
  label: string
  detail?: string
  isError?: boolean
}

interface TranslateStore {
  sourceLanguage: string
  targetLanguage: string
  sourceText: string
  translatedText: string
  isTranslating: boolean
  overrideProviderId: string | null
  overrideModelId: string | null
  agentMode: boolean
  agentSteps: AgentStep[]
  selectedFilePath: string | null
  selectedFileName: string | null

  setSourceLanguage: (lang: string) => void
  setTargetLanguage: (lang: string) => void
  swapLanguages: () => void
  setSourceText: (text: string) => void
  setOverrideModel: (providerId: string | null, modelId: string | null) => void
  setAgentMode: (enabled: boolean) => void
  selectFile: () => Promise<void>
  clearSelectedFile: () => void
  translate: () => Promise<void>
  stopTranslation: () => void
  clearAll: () => void
}

let activeAbortController: AbortController | null = null

function buildFallbackProviderConfig(): ProviderConfig | null {
  const settings = useSettingsStore.getState()
  if (!settings.apiKey) return null

  return {
    type: settings.provider,
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl || undefined,
    model: settings.model
  }
}

function buildEffectiveProviderConfig(
  overrideProviderId: string | null,
  overrideModelId: string | null
): ProviderConfig | null {
  const providerStore = useProviderStore.getState()

  if (overrideProviderId && overrideModelId) {
    return providerStore.getProviderConfigById(overrideProviderId, overrideModelId)
  }

  return providerStore.getTranslationProviderConfig() ?? buildFallbackProviderConfig()
}

export const useTranslateStore = create<TranslateStore>((set, get) => ({
  sourceLanguage: 'auto',
  targetLanguage: 'en',
  sourceText: '',
  translatedText: '',
  isTranslating: false,
  overrideProviderId: null,
  overrideModelId: null,
  agentMode: false,
  agentSteps: [],
  selectedFilePath: null,
  selectedFileName: null,

  setSourceLanguage: (lang) => set({ sourceLanguage: lang }),
  setTargetLanguage: (lang) => set({ targetLanguage: lang }),
  swapLanguages: () =>
    set((state) => {
      if (state.sourceLanguage === 'auto') {
        const fallbackTarget = state.targetLanguage === 'en' ? 'zh' : 'en'
        return {
          sourceLanguage: state.targetLanguage,
          targetLanguage: fallbackTarget
        }
      }
      return {
        sourceLanguage: state.targetLanguage,
        targetLanguage: state.sourceLanguage
      }
    }),
  setSourceText: (text) => set({ sourceText: text }),
  setOverrideModel: (providerId, modelId) =>
    set({
      overrideProviderId: providerId,
      overrideModelId: modelId
    }),
  setAgentMode: (enabled) => set({ agentMode: enabled, agentSteps: [] }),
  clearSelectedFile: () => set({ selectedFilePath: null, selectedFileName: null }),
  selectFile: async () => {
    const result = (await window.electron.ipcRenderer.invoke(IPC.FS_SELECT_FILE)) as
      | { canceled: true }
      | { path: string }
    if ('canceled' in result) return

    const docResult = (await window.electron.ipcRenderer.invoke(IPC.FS_READ_DOCUMENT, {
      path: result.path
    })) as { content: string; name: string } | { error: string }
    if ('error' in docResult) {
      toast.error('Failed to read file', { description: docResult.error })
      return
    }
    set({
      selectedFilePath: result.path,
      selectedFileName: docResult.name,
      sourceText: docResult.content
    })
  },
  stopTranslation: () => {
    if (activeAbortController) {
      activeAbortController.abort()
      activeAbortController = null
    }
    set({ isTranslating: false })
  },
  clearAll: () =>
    set({
      sourceText: '',
      translatedText: '',
      agentSteps: [],
      selectedFilePath: null,
      selectedFileName: null
    }),
  translate: async () => {
    const {
      sourceText,
      sourceLanguage,
      targetLanguage,
      overrideProviderId,
      overrideModelId,
      agentMode
    } = get()

    const text = sourceText.trim()
    if (!text) {
      set({ translatedText: '' })
      return
    }

    if (sourceLanguage !== 'auto' && sourceLanguage === targetLanguage) {
      set({ translatedText: text })
      return
    }

    const providerStore = useProviderStore.getState()
    const targetProviderId =
      overrideProviderId ?? providerStore.activeTranslationProviderId ?? providerStore.activeProviderId
    if (targetProviderId) {
      const ready = await ensureProviderAuthReady(targetProviderId)
      if (!ready) {
        toast.error('Authentication required', {
          description: 'Please complete provider login in Settings'
        })
        return
      }
    }

    const providerConfig = buildEffectiveProviderConfig(overrideProviderId, overrideModelId)
    if (!providerConfig || (!providerConfig.apiKey && providerConfig.requiresApiKey !== false)) {
      toast.error('API key required', {
        description: 'Please configure an AI provider in Settings'
      })
      return
    }

    const settings = useSettingsStore.getState()
    const requestConfig: ProviderConfig = {
      ...providerConfig,
      maxTokens: settings.maxTokens,
      temperature: 0.2,
      thinkingEnabled: false
    }

    if (activeAbortController) {
      activeAbortController.abort()
    }
    const abortController = new AbortController()
    activeAbortController = abortController

    set({ isTranslating: true, translatedText: '', agentSteps: [] })

    try {
      if (agentMode) {
        await runTranslationAgent({
          text,
          sourceLanguage,
          targetLanguage,
          providerConfig: requestConfig,
          signal: abortController.signal,
          readDocument: async (filePath) => {
            const res = (await window.electron.ipcRenderer.invoke(IPC.FS_READ_DOCUMENT, {
              path: filePath
            })) as { content: string; name: string } | { error: string }
            return 'error' in res ? { error: res.error } : { content: res.content }
          },
          onEvent: (event) => {
            if (abortController.signal.aborted) return
            switch (event.type) {
              case 'buffer_update':
                set({ translatedText: event.content })
                break
              case 'iteration':
                set((s) => ({
                  agentSteps: [
                    ...s.agentSteps,
                    {
                      id: `iter-${event.iteration}-${Date.now()}`,
                      type: 'iteration',
                      label: `Step ${event.iteration}`
                    }
                  ]
                }))
                break
              case 'tool_use':
                set((s) => ({
                  agentSteps: [
                    ...s.agentSteps,
                    {
                      id: `tool-${event.name}-${Date.now()}`,
                      type: 'tool_use',
                      label: event.name,
                      detail:
                        event.name === 'Write'
                          ? `Writing ${typeof event.input.content === 'string' ? event.input.content.length : 0} chars`
                          : event.name === 'Edit'
                            ? `Edit: "${String(event.input.old_string ?? '').slice(0, 40)}"`
                            : event.name === 'FileRead'
                              ? `Reading ${String(event.input.file_path ?? '')
                                  .split('/')
                                  .pop()
                                  ?.split('\\')
                                  .pop()}`
                              : undefined
                    }
                  ]
                }))
                break
              case 'tool_result':
                if (event.isError) {
                  set((s) => ({
                    agentSteps: [
                      ...s.agentSteps,
                      {
                        id: `result-err-${Date.now()}`,
                        type: 'tool_result',
                        label: `${event.name} failed`,
                        detail: event.output,
                        isError: true
                      }
                    ]
                  }))
                }
                break
              case 'error':
                toast.error('Agent translation failed', { description: event.message })
                break
            }
          }
        })
      } else {
        let streamedText = ''
        await streamAiTranslation({
          text,
          sourceLanguage,
          targetLanguage,
          providerConfig: requestConfig,
          signal: abortController.signal,
          onTextDelta: (chunk) => {
            streamedText += chunk
            set({ translatedText: streamedText })
          }
        })
      }
    } catch (err) {
      if (!abortController.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err)
        toast.error('Translation failed', { description: message })
      }
    } finally {
      if (activeAbortController === abortController) {
        activeAbortController = null
      }
      set({ isTranslating: false })
    }
  }
}))
