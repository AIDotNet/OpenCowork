import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { nanoid } from 'nanoid'
import type { AIProvider, AIModelConfig, ProviderConfig } from '../lib/api/types'
import { builtinProviderPresets } from './providers'
import type { BuiltinProviderPreset } from './providers'
import { configStorage } from '../lib/ipc/config-storage'

export { builtinProviderPresets }
export type { BuiltinProviderPreset }

// --- Helper: create AIProvider from preset ---

function createProviderFromPreset(preset: BuiltinProviderPreset): AIProvider {
  return {
    id: nanoid(),
    name: preset.name.trim(),
    type: preset.type,
    apiKey: '',
    baseUrl: preset.defaultBaseUrl.trim(),
    enabled: preset.defaultEnabled ?? false,
    models: [...preset.defaultModels],
    builtinId: preset.builtinId,
    createdAt: Date.now(),
    requiresApiKey: preset.requiresApiKey ?? true,
    ...(preset.userAgent ? { userAgent: preset.userAgent } : {}),
    ...(preset.defaultModel ? { defaultModel: preset.defaultModel } : {}),
  }
}

function normalizeProviderBaseUrl(
  baseUrl: string,
  requestType: ProviderConfig['type']
): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (requestType === 'anthropic') {
    // Anthropic provider will append `/v1/messages` itself.
    return trimmed.replace(/\/v1(?:\/messages)?$/i, '')
  }
  return trimmed
}

function mergeBuiltinModels(
  existingModels: AIModelConfig[],
  presetModels: AIModelConfig[]
): AIModelConfig[] {
  const existingById = new Map(existingModels.map((model) => [model.id, model]))
  const presetIds = new Set(presetModels.map((model) => model.id))

  // Keep preset order for builtin models; preserve user's enabled state.
  const merged = presetModels.map((presetModel) => {
    const existingModel = existingById.get(presetModel.id)
    if (!existingModel) return { ...presetModel }
    return {
      ...existingModel,
      ...presetModel,
      enabled: existingModel.enabled,
    }
  })

  // Keep user-added custom models that are not part of builtin preset.
  for (const existingModel of existingModels) {
    if (!presetIds.has(existingModel.id)) {
      merged.push(existingModel)
    }
  }

  return merged
}

function resolveProviderDefaultModelId(provider: AIProvider): string {
  // Try to use the configured default model first
  if (provider.defaultModel) {
    const defaultModel = provider.models.find((m) => m.id === provider.defaultModel)
    if (defaultModel) return defaultModel.id
  }

  // Fall back to first enabled model, then first model
  const enabledModels = provider.models.filter((m) => m.enabled)
  return enabledModels[0]?.id ?? provider.models[0]?.id ?? ''
}

// --- Store ---

interface ProviderStore {
  providers: AIProvider[]
  activeProviderId: string | null
  activeModelId: string
  activeFastModelId: string
  activeTranslationProviderId: string | null
  activeTranslationModelId: string

  // CRUD
  addProvider: (provider: AIProvider) => void
  addProviderFromPreset: (builtinId: string) => string | null
  updateProvider: (id: string, patch: Partial<Omit<AIProvider, 'id'>>) => void
  removeProvider: (id: string) => void
  toggleProviderEnabled: (id: string) => void

  // Model management
  addModel: (providerId: string, model: AIModelConfig) => void
  updateModel: (providerId: string, modelId: string, patch: Partial<AIModelConfig>) => void
  removeModel: (providerId: string, modelId: string) => void
  toggleModelEnabled: (providerId: string, modelId: string) => void
  setProviderModels: (providerId: string, models: AIModelConfig[]) => void

  // Active selection
  setActiveProvider: (providerId: string) => void
  setActiveModel: (modelId: string) => void
  setActiveFastModel: (modelId: string) => void
  setActiveTranslationProvider: (providerId: string) => void
  setActiveTranslationModel: (modelId: string) => void

  // Derived
  getActiveProvider: () => AIProvider | null
  getActiveModelConfig: () => AIModelConfig | null
  getActiveProviderConfig: () => ProviderConfig | null
  /** Build a ProviderConfig for a specific provider+model (used by plugin/session overrides) */
  getProviderConfigById: (providerId: string, modelId: string) => ProviderConfig | null
  getFastProviderConfig: () => ProviderConfig | null
  /** Build provider config for translation default model; falls back to active model config */
  getTranslationProviderConfig: () => ProviderConfig | null
  /** Clamp user maxTokens to model's maxOutputTokens if exceeded */
  getEffectiveMaxTokens: (userMaxTokens: number, modelId?: string) => number
  /** Whether the active model supports thinking and its config */
  getActiveModelSupportsThinking: () => boolean
  getActiveModelThinkingConfig: () => import('../lib/api/types').ThinkingConfig | undefined

  // Migration
  _migrated: boolean
  _markMigrated: () => void
}

export const useProviderStore = create<ProviderStore>()(
  persist(
    (set, get) => ({
      providers: [],
      activeProviderId: null,
      activeModelId: '',
      activeFastModelId: '',
      activeTranslationProviderId: null,
      activeTranslationModelId: '',
      _migrated: false,

      addProvider: (provider) =>
        set((s) => ({ providers: [...s.providers, provider] })),

      addProviderFromPreset: (builtinId) => {
        const preset = builtinProviderPresets.find((p) => p.builtinId === builtinId)
        if (!preset) return null
        const existing = get().providers.find((p) => p.builtinId === builtinId)
        if (existing) return existing.id
        const provider = createProviderFromPreset(preset)
        set((s) => ({ providers: [...s.providers, provider] }))
        return provider.id
      },

      updateProvider: (id, patch) =>
        set((s) => ({
          providers: s.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
        })),

      removeProvider: (id) =>
        set((s) => ({
          providers: s.providers.filter((p) => p.id !== id),
          activeProviderId: s.activeProviderId === id ? null : s.activeProviderId,
          activeTranslationProviderId:
            s.activeTranslationProviderId === id ? null : s.activeTranslationProviderId,
          activeTranslationModelId:
            s.activeTranslationProviderId === id ? '' : s.activeTranslationModelId,
        })),

      toggleProviderEnabled: (id) =>
        set((s) => ({
          providers: s.providers.map((p) =>
            p.id === id ? { ...p, enabled: !p.enabled } : p
          ),
        })),

      addModel: (providerId, model) =>
        set((s) => ({
          providers: s.providers.map((p) =>
            p.id === providerId ? { ...p, models: [...p.models, model] } : p
          ),
        })),

      updateModel: (providerId, modelId, patch) =>
        set((s) => ({
          providers: s.providers.map((p) =>
            p.id === providerId
              ? {
                ...p,
                models: p.models.map((m) => (m.id === modelId ? { ...m, ...patch } : m)),
              }
              : p
          ),
        })),

      removeModel: (providerId, modelId) =>
        set((s) => ({
          providers: s.providers.map((p) =>
            p.id === providerId
              ? { ...p, models: p.models.filter((m) => m.id !== modelId) }
              : p
          ),
        })),

      toggleModelEnabled: (providerId, modelId) =>
        set((s) => ({
          providers: s.providers.map((p) =>
            p.id === providerId
              ? {
                ...p,
                models: p.models.map((m) =>
                  m.id === modelId ? { ...m, enabled: !m.enabled } : m
                ),
              }
              : p
          ),
        })),

      setProviderModels: (providerId, models) =>
        set((s) => ({
          providers: s.providers.map((p) =>
            p.id === providerId ? { ...p, models } : p
          ),
        })),

      setActiveProvider: (providerId) => {
        const provider = get().providers.find((p) => p.id === providerId)
        if (!provider) return

        const defaultModelId = resolveProviderDefaultModelId(provider)

        set({ activeProviderId: providerId, activeModelId: defaultModelId })
      },

      setActiveModel: (modelId) => set({ activeModelId: modelId }),

      setActiveFastModel: (modelId) => set({ activeFastModelId: modelId }),

      setActiveTranslationProvider: (providerId) => {
        const provider = get().providers.find((p) => p.id === providerId)
        if (!provider) return
        const defaultModelId = resolveProviderDefaultModelId(provider)
        set({
          activeTranslationProviderId: providerId,
          activeTranslationModelId: defaultModelId,
        })
      },

      setActiveTranslationModel: (modelId) => set({ activeTranslationModelId: modelId }),

      getActiveProvider: () => {
        const { providers, activeProviderId } = get()
        if (!activeProviderId) return null
        return providers.find((p) => p.id === activeProviderId) ?? null
      },

      getActiveModelConfig: () => {
        const { providers, activeProviderId, activeModelId } = get()
        if (!activeProviderId) return null
        const provider = providers.find((p) => p.id === activeProviderId)
        if (!provider) return null
        return provider.models.find((m) => m.id === activeModelId) ?? null
      },

      getActiveProviderConfig: () => {
        const { providers, activeProviderId, activeModelId } = get()
        if (!activeProviderId) return null
        const provider = providers.find((p) => p.id === activeProviderId)
        if (!provider) return null
        const activeModel = provider.models.find((m) => m.id === activeModelId)
        const requestType = activeModel?.type ?? provider.type
        const normalizedBaseUrl = provider.baseUrl
          ? normalizeProviderBaseUrl(provider.baseUrl, requestType)
          : undefined
        return {
          type: requestType,
          apiKey: provider.apiKey,
          baseUrl: normalizedBaseUrl,
          model: activeModelId,
          requiresApiKey: provider.requiresApiKey,
          responseSummary: activeModel?.responseSummary,
          enablePromptCache: activeModel?.enablePromptCache,
          enableSystemPromptCache: activeModel?.enableSystemPromptCache,
          ...(provider.userAgent ? { userAgent: provider.userAgent } : {}),
        }
      },

      getTranslationProviderConfig: () => {
        const {
          providers,
          activeTranslationProviderId,
          activeTranslationModelId,
          getActiveProviderConfig,
          getProviderConfigById,
        } = get()

        if (!activeTranslationProviderId) {
          return getActiveProviderConfig()
        }

        const provider = providers.find((p) => p.id === activeTranslationProviderId)
        if (!provider) {
          return getActiveProviderConfig()
        }

        const resolvedModelId = activeTranslationModelId || resolveProviderDefaultModelId(provider)
        if (!resolvedModelId) {
          return getActiveProviderConfig()
        }

        return getProviderConfigById(activeTranslationProviderId, resolvedModelId)
          ?? getActiveProviderConfig()
      },

      getProviderConfigById: (providerId, modelId) => {
        const provider = get().providers.find((p) => p.id === providerId)
        if (!provider) return null
        const model = provider.models.find((m) => m.id === modelId)
        const requestType = model?.type ?? provider.type
        const normalizedBaseUrl = provider.baseUrl
          ? normalizeProviderBaseUrl(provider.baseUrl, requestType)
          : undefined
        return {
          type: requestType,
          apiKey: provider.apiKey,
          baseUrl: normalizedBaseUrl,
          model: modelId,
          requiresApiKey: provider.requiresApiKey,
          responseSummary: model?.responseSummary,
          enablePromptCache: model?.enablePromptCache,
          enableSystemPromptCache: model?.enableSystemPromptCache,
          ...(provider.userAgent ? { userAgent: provider.userAgent } : {}),
        }
      },

      getFastProviderConfig: () => {
        const { providers, activeProviderId, activeFastModelId } = get()
        if (!activeProviderId) return null
        const provider = providers.find((p) => p.id === activeProviderId)
        if (!provider) return null
        const model = activeFastModelId || provider.models[0]?.id || ''
        const fastModel = provider.models.find((m) => m.id === model)
        const requestType = fastModel?.type ?? provider.type
        const normalizedBaseUrl = provider.baseUrl
          ? normalizeProviderBaseUrl(provider.baseUrl, requestType)
          : undefined
        return {
          type: requestType,
          apiKey: provider.apiKey,
          baseUrl: normalizedBaseUrl,
          model,
          requiresApiKey: provider.requiresApiKey,
          responseSummary: fastModel?.responseSummary,
          enablePromptCache: fastModel?.enablePromptCache,
          enableSystemPromptCache: fastModel?.enableSystemPromptCache,
          ...(provider.userAgent ? { userAgent: provider.userAgent } : {}),
        }
      },

      getEffectiveMaxTokens: (userMaxTokens: number, modelId?: string) => {
        const { providers, activeProviderId, activeModelId } = get()
        const targetModelId = modelId ?? activeModelId
        if (!activeProviderId || !targetModelId) return userMaxTokens
        const provider = providers.find((p) => p.id === activeProviderId)
        if (!provider) return userMaxTokens
        const model = provider.models.find((m) => m.id === targetModelId)
        if (!model?.maxOutputTokens) return userMaxTokens
        return Math.min(userMaxTokens, model.maxOutputTokens)
      },

      getActiveModelSupportsThinking: () => {
        const model = get().getActiveModelConfig()
        return model?.supportsThinking ?? false
      },

      getActiveModelThinkingConfig: () => {
        const model = get().getActiveModelConfig()
        return model?.thinkingConfig
      },

      _markMigrated: () => set({ _migrated: true }),
    }),
    {
      name: 'opencowork-providers',
      storage: createJSONStorage(() => configStorage),
      partialize: (state) => ({
        providers: state.providers,
        activeProviderId: state.activeProviderId,
        activeModelId: state.activeModelId,
        activeFastModelId: state.activeFastModelId,
        activeTranslationProviderId: state.activeTranslationProviderId,
        activeTranslationModelId: state.activeTranslationModelId,
        _migrated: state._migrated,
      }),
    }
  )
)

/**
 * Ensure built-in presets exist and pick a default active provider.
 * Safe to call multiple times — idempotent.
 */
function ensureBuiltinPresets(): void {
  for (const preset of builtinProviderPresets) {
    const existing = useProviderStore
      .getState()
      .providers.find((p) => p.builtinId === preset.builtinId)

    if (!existing) {
      const provider = createProviderFromPreset(preset)
      useProviderStore.getState().addProvider(provider)
    } else {
      // Sync provider-level fields from preset (e.g. requiresApiKey, userAgent, defaultModel)
      const patch: Partial<Omit<AIProvider, 'id'>> = {}
      if (existing.requiresApiKey !== (preset.requiresApiKey ?? true)) {
        patch.requiresApiKey = preset.requiresApiKey ?? true
      }
      if (existing.userAgent !== preset.userAgent) {
        patch.userAgent = preset.userAgent
      }
      if (existing.defaultModel !== preset.defaultModel) {
        patch.defaultModel = preset.defaultModel
      }
      if (Object.keys(patch).length > 0) {
        useProviderStore.getState().updateProvider(existing.id, patch)
      }

      const updatedModels = mergeBuiltinModels(existing.models, preset.defaultModels)
      if (JSON.stringify(updatedModels) !== JSON.stringify(existing.models)) {
        useProviderStore.getState().setProviderModels(existing.id, updatedModels)
      }
    }
  }

  if (!useProviderStore.getState().activeProviderId) {
    const providers = useProviderStore.getState().providers
    const firstEnabled = providers.find((p) => p.enabled)
    if (firstEnabled) {
      useProviderStore.getState().setActiveProvider(firstEnabled.id)
    }
  }

  const state = useProviderStore.getState()
  if (!state.activeTranslationProviderId) {
    const fallbackProviderId = state.activeProviderId
    if (fallbackProviderId) {
      state.setActiveTranslationProvider(fallbackProviderId)
    }
  } else if (!state.activeTranslationModelId) {
    state.setActiveTranslationProvider(state.activeTranslationProviderId)
  }
}

/**
 * Initialize provider store: ensure built-in presets exist.
 * Waits for IPC storage rehydration before running.
 */
export function initProviderStore(): void {
  // If already rehydrated (e.g. sync storage), run immediately
  if (useProviderStore.persist.hasHydrated()) {
    ensureBuiltinPresets()
  }
  // Also register for when rehydration finishes (async IPC storage)
  useProviderStore.persist.onFinishHydration(() => {
    ensureBuiltinPresets()
  })
}
