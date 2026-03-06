import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { nanoid } from 'nanoid'
import type {
  AIProvider,
  AIModelConfig,
  ProviderConfig,
  ProviderType,
  ModelCategory,
  RequestOverrides
} from '../lib/api/types'
import { builtinProviderPresets } from './providers'
import type { BuiltinProviderPreset } from './providers'
import { configStorage } from '../lib/ipc/config-storage'
import { useSettingsStore } from './settings-store'

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
    ...(preset.useSystemProxy !== undefined ? { useSystemProxy: preset.useSystemProxy } : {}),
    ...(preset.userAgent ? { userAgent: preset.userAgent } : {}),
    ...(preset.defaultModel ? { defaultModel: preset.defaultModel } : {}),
    authMode: preset.authMode ?? 'apiKey',
    ...(preset.oauthConfig ? { oauthConfig: { ...preset.oauthConfig } } : {}),
    ...(preset.channelConfig ? { channelConfig: { ...preset.channelConfig } } : {}),
    ...(preset.requestOverrides ? { requestOverrides: { ...preset.requestOverrides } } : {}),
    ...(preset.instructionsPrompt ? { instructionsPrompt: preset.instructionsPrompt } : {}),
    ...(preset.ui ? { ui: { ...preset.ui } } : {})
  }
}

export function modelSupportsVision(
  model: AIModelConfig | null | undefined,
  providerType?: ProviderType
): boolean {
  if (!model) return providerType === 'openai-images'
  const requestType = model.type ?? providerType
  return Boolean(
    model.supportsVision || model.category === 'image' || requestType === 'openai-images'
  )
}

export function normalizeProviderBaseUrl(
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

function mergeRequestOverrides(
  ...overrides: (RequestOverrides | undefined)[]
): RequestOverrides | undefined {
  const merged: RequestOverrides = {}
  let hasHeaders = false
  let hasBody = false
  let hasOmitKeys = false

  for (const override of overrides) {
    if (!override) continue

    if (override.headers) {
      merged.headers = { ...(merged.headers ?? {}), ...override.headers }
      hasHeaders = true
    }

    if (override.body) {
      merged.body = { ...(merged.body ?? {}), ...override.body }
      hasBody = true
    }

    if (override.omitBodyKeys?.length) {
      const existing = new Set(merged.omitBodyKeys ?? [])
      for (const key of override.omitBodyKeys) {
        if (key) existing.add(key)
      }
      merged.omitBodyKeys = Array.from(existing)
      hasOmitKeys = merged.omitBodyKeys.length > 0
    }
  }

  return hasHeaders || hasBody || hasOmitKeys ? merged : undefined
}

function usesGpt5Model(modelId?: string): boolean {
  if (!modelId) return false
  const normalized = modelId.split('/').pop() ?? modelId
  return /^gpt-5/i.test(normalized)
}

function ensureTemperatureOmit(
  overrides: RequestOverrides | undefined,
  modelId?: string
): RequestOverrides | undefined {
  if (!usesGpt5Model(modelId)) {
    return overrides
  }

  const omitBodyKeys = new Set(overrides?.omitBodyKeys ?? [])
  omitBodyKeys.add('temperature')

  const result: RequestOverrides = {}
  if (overrides?.headers) {
    result.headers = overrides.headers
  }
  if (overrides?.body) {
    result.body = overrides.body
  }
  result.omitBodyKeys = Array.from(omitBodyKeys)
  return result
}

function buildRequestOverrides(
  providerOverrides: RequestOverrides | undefined,
  modelOverrides: RequestOverrides | undefined,
  modelId?: string
): RequestOverrides | undefined {
  const merged = mergeRequestOverrides(providerOverrides, modelOverrides)
  return ensureTemperatureOmit(merged, modelId)
}

function supportsPriorityServiceTier(providerBuiltinId?: string, modelId?: string): boolean {
  if (!providerBuiltinId || !modelId) return false
  if (providerBuiltinId === 'openai') return true
  return providerBuiltinId === 'routin-ai' && modelId === 'gpt-5.4'
}

function resolveServiceTier(
  providerBuiltinId?: string,
  modelId?: string
): ProviderConfig['serviceTier'] | undefined {
  if (!useSettingsStore.getState().fastModeEnabled) return undefined
  return supportsPriorityServiceTier(providerBuiltinId, modelId) ? 'priority' : undefined
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
      enabled: existingModel.enabled
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

function resolveProviderDefaultModelIdByCategory(
  provider: AIProvider,
  category: ModelCategory
): string {
  const categoryModels = provider.models.filter((m) => (m.category ?? 'chat') === category)
  const enabledModels = categoryModels.filter((m) => m.enabled)
  return enabledModels[0]?.id ?? categoryModels[0]?.id ?? ''
}

function resolveFirstProviderIdByCategory(
  providers: AIProvider[],
  category: ModelCategory
): string | null {
  const enabledProvider = providers.find(
    (provider) =>
      provider.enabled &&
      provider.models.some((model) => model.enabled && (model.category ?? 'chat') === category)
  )
  if (enabledProvider) return enabledProvider.id

  return (
    providers.find((provider) =>
      provider.models.some((model) => (model.category ?? 'chat') === category)
    )?.id ?? null
  )
}

function resolveValidModelIdByCategory(
  provider: AIProvider,
  modelId: string,
  category: ModelCategory
): string {
  const current = provider.models.find((model) => model.id === modelId)
  if (current && current.enabled && (current.category ?? 'chat') === category) {
    return current.id
  }
  return resolveProviderDefaultModelIdByCategory(provider, category)
}

// --- Store ---

interface ProviderStore {
  providers: AIProvider[]
  activeProviderId: string | null
  activeModelId: string
  activeFastProviderId: string | null
  activeFastModelId: string
  activeTranslationProviderId: string | null
  activeTranslationModelId: string
  activeSpeechProviderId: string | null
  activeSpeechModelId: string
  activeImageProviderId: string | null
  activeImageModelId: string

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
  setActiveFastProvider: (providerId: string) => void
  setActiveFastModel: (modelId: string) => void
  setActiveTranslationProvider: (providerId: string) => void
  setActiveTranslationModel: (modelId: string) => void
  setActiveSpeechProvider: (providerId: string) => void
  setActiveSpeechModel: (modelId: string) => void
  setActiveImageProvider: (providerId: string) => void
  setActiveImageModel: (modelId: string) => void

  // Derived
  getActiveProvider: () => AIProvider | null
  getActiveModelConfig: () => AIModelConfig | null
  getActiveProviderConfig: () => ProviderConfig | null
  /** Build a ProviderConfig for a specific provider+model (used by plugin/session overrides) */
  getProviderConfigById: (providerId: string, modelId: string) => ProviderConfig | null
  getFastProviderConfig: () => ProviderConfig | null
  /** Build provider config for translation default model; falls back to active model config */
  getTranslationProviderConfig: () => ProviderConfig | null
  /** Build provider config for speech recognition; returns null if not configured */
  getSpeechProviderConfig: () => ProviderConfig | null
  /** Build provider config for image generation; returns null if not configured */
  getImageProviderConfig: () => ProviderConfig | null
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
      activeFastProviderId: null,
      activeFastModelId: '',
      activeTranslationProviderId: null,
      activeTranslationModelId: '',
      activeSpeechProviderId: null,
      activeSpeechModelId: '',
      activeImageProviderId: null,
      activeImageModelId: '',
      _migrated: false,

      addProvider: (provider) => set((s) => ({ providers: [...s.providers, provider] })),

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
          providers: s.providers.map((p) => (p.id === id ? { ...p, ...patch } : p))
        })),

      removeProvider: (id) =>
        set((s) => ({
          providers: s.providers.filter((p) => p.id !== id),
          activeProviderId: s.activeProviderId === id ? null : s.activeProviderId,
          activeTranslationProviderId:
            s.activeTranslationProviderId === id ? null : s.activeTranslationProviderId,
          activeTranslationModelId:
            s.activeTranslationProviderId === id ? '' : s.activeTranslationModelId,
          activeSpeechProviderId: s.activeSpeechProviderId === id ? null : s.activeSpeechProviderId,
          activeSpeechModelId: s.activeSpeechProviderId === id ? '' : s.activeSpeechModelId,
          activeImageProviderId: s.activeImageProviderId === id ? null : s.activeImageProviderId,
          activeImageModelId: s.activeImageProviderId === id ? '' : s.activeImageModelId,
          activeFastProviderId: s.activeFastProviderId === id ? null : s.activeFastProviderId,
          activeFastModelId: s.activeFastProviderId === id ? '' : s.activeFastModelId
        })),

      toggleProviderEnabled: (id) =>
        set((s) => ({
          providers: s.providers.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p))
        })),

      addModel: (providerId, model) =>
        set((s) => ({
          providers: s.providers.map((p) =>
            p.id === providerId ? { ...p, models: [...p.models, model] } : p
          )
        })),

      updateModel: (providerId, modelId, patch) =>
        set((s) => ({
          providers: s.providers.map((p) =>
            p.id === providerId
              ? {
                  ...p,
                  models: p.models.map((m) => (m.id === modelId ? { ...m, ...patch } : m))
                }
              : p
          )
        })),

      removeModel: (providerId, modelId) =>
        set((s) => ({
          providers: s.providers.map((p) =>
            p.id === providerId ? { ...p, models: p.models.filter((m) => m.id !== modelId) } : p
          )
        })),

      toggleModelEnabled: (providerId, modelId) =>
        set((s) => ({
          providers: s.providers.map((p) =>
            p.id === providerId
              ? {
                  ...p,
                  models: p.models.map((m) =>
                    m.id === modelId ? { ...m, enabled: !m.enabled } : m
                  )
                }
              : p
          )
        })),

      setProviderModels: (providerId, models) =>
        set((s) => ({
          providers: s.providers.map((p) => (p.id === providerId ? { ...p, models } : p))
        })),

      setActiveProvider: (providerId) => {
        const provider = get().providers.find((p) => p.id === providerId)
        if (!provider) return

        const defaultModelId =
          resolveProviderDefaultModelIdByCategory(provider, 'chat') ||
          resolveProviderDefaultModelId(provider)

        set((state) => {
          const nextState: Partial<ProviderStore> = {
            activeProviderId: providerId,
            activeModelId: defaultModelId
          }

          if (!state.activeFastProviderId) {
            nextState.activeFastProviderId = providerId
            nextState.activeFastModelId = defaultModelId
          }

          return nextState as ProviderStore
        })
      },

      setActiveModel: (modelId) => set({ activeModelId: modelId }),

      setActiveFastProvider: (providerId) => {
        const provider = get().providers.find((p) => p.id === providerId)
        if (!provider) return
        const defaultModelId =
          resolveProviderDefaultModelIdByCategory(provider, 'chat') ||
          resolveProviderDefaultModelId(provider)
        set({ activeFastProviderId: providerId, activeFastModelId: defaultModelId })
      },

      setActiveFastModel: (modelId) =>
        set((state) => {
          const providerId = state.activeFastProviderId ?? state.activeProviderId
          if (!providerId) return {}
          const provider = state.providers.find((p) => p.id === providerId)
          if (!provider) return {}
          const modelExists = provider.models.some((m) => m.id === modelId)
          return modelExists ? { activeFastModelId: modelId } : {}
        }),

      setActiveTranslationProvider: (providerId) => {
        const provider = get().providers.find((p) => p.id === providerId)
        if (!provider) return
        const defaultModelId =
          resolveProviderDefaultModelIdByCategory(provider, 'chat') ||
          resolveProviderDefaultModelId(provider)
        set({
          activeTranslationProviderId: providerId,
          activeTranslationModelId: defaultModelId
        })
      },

      setActiveTranslationModel: (modelId) => set({ activeTranslationModelId: modelId }),

      setActiveSpeechProvider: (providerId) => {
        const provider = get().providers.find((p) => p.id === providerId)
        if (!provider) return
        const defaultModelId = resolveProviderDefaultModelIdByCategory(provider, 'speech')
        set({
          activeSpeechProviderId: providerId,
          activeSpeechModelId: defaultModelId
        })
      },

      setActiveSpeechModel: (modelId) => set({ activeSpeechModelId: modelId }),

      setActiveImageProvider: (providerId) => {
        const provider = get().providers.find((p) => p.id === providerId)
        if (!provider) return
        const defaultModelId = resolveProviderDefaultModelIdByCategory(provider, 'image')
        set({
          activeImageProviderId: providerId,
          activeImageModelId: defaultModelId
        })
      },

      setActiveImageModel: (modelId) => set({ activeImageModelId: modelId }),

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

        // Override provider type for image category models
        let requestType = activeModel?.type ?? provider.type
        if (activeModel?.category === 'image') {
          requestType = 'openai-images'
          console.log('[Provider Store] Image model detected, routing to openai-images provider', {
            modelId: activeModelId,
            originalType: activeModel?.type,
            providerType: provider.type,
            finalType: requestType
          })
        }

        const normalizedBaseUrl = provider.baseUrl
          ? normalizeProviderBaseUrl(provider.baseUrl, requestType)
          : undefined
        const requestOverrides = buildRequestOverrides(
          provider.requestOverrides,
          activeModel?.requestOverrides,
          activeModel?.id ?? activeModelId
        )
        const serviceTier = resolveServiceTier(provider.builtinId, activeModel?.id ?? activeModelId)
        return {
          type: requestType,
          apiKey: provider.apiKey,
          baseUrl: normalizedBaseUrl,
          model: activeModelId,
          providerId: provider.id,
          providerBuiltinId: provider.builtinId,
          ...(serviceTier ? { serviceTier } : {}),
          requiresApiKey: provider.requiresApiKey,
          ...(provider.useSystemProxy !== undefined
            ? { useSystemProxy: provider.useSystemProxy }
            : {}),
          responseSummary: activeModel?.responseSummary,
          enablePromptCache: activeModel?.enablePromptCache,
          enableSystemPromptCache: activeModel?.enableSystemPromptCache,
          ...(provider.userAgent ? { userAgent: provider.userAgent } : {}),
          ...(requestOverrides ? { requestOverrides } : {}),
          ...(provider.instructionsPrompt
            ? { instructionsPrompt: provider.instructionsPrompt }
            : {})
        }
      },

      getTranslationProviderConfig: () => {
        const {
          providers,
          activeTranslationProviderId,
          activeTranslationModelId,
          getActiveProviderConfig,
          getProviderConfigById
        } = get()

        if (!activeTranslationProviderId) {
          return getActiveProviderConfig()
        }

        const provider = providers.find((p) => p.id === activeTranslationProviderId)
        if (!provider) {
          return getActiveProviderConfig()
        }

        const resolvedModelId =
          activeTranslationModelId ||
          resolveProviderDefaultModelIdByCategory(provider, 'chat') ||
          resolveProviderDefaultModelId(provider)
        if (!resolvedModelId) {
          return getActiveProviderConfig()
        }

        return (
          getProviderConfigById(activeTranslationProviderId, resolvedModelId) ??
          getActiveProviderConfig()
        )
      },

      getSpeechProviderConfig: () => {
        const { activeSpeechProviderId, activeSpeechModelId, getProviderConfigById } = get()
        if (!activeSpeechProviderId || !activeSpeechModelId) return null
        return getProviderConfigById(activeSpeechProviderId, activeSpeechModelId)
      },

      getImageProviderConfig: () => {
        const { activeImageProviderId, activeImageModelId, getProviderConfigById } = get()
        if (!activeImageProviderId || !activeImageModelId) return null
        return getProviderConfigById(activeImageProviderId, activeImageModelId)
      },

      getProviderConfigById: (providerId, modelId) => {
        const provider = get().providers.find((p) => p.id === providerId)
        if (!provider) return null
        const model = provider.models.find((m) => m.id === modelId)

        // Override provider type for image category models
        let requestType = model?.type ?? provider.type
        if (model?.category === 'image') {
          requestType = 'openai-images'
          console.log(
            '[Provider Store] Image model detected in getProviderConfigById, routing to openai-images provider',
            {
              modelId,
              originalType: model?.type,
              providerType: provider.type,
              finalType: requestType
            }
          )
        }

        const normalizedBaseUrl = provider.baseUrl
          ? normalizeProviderBaseUrl(provider.baseUrl, requestType)
          : undefined
        const requestOverrides = buildRequestOverrides(
          provider.requestOverrides,
          model?.requestOverrides,
          model?.id ?? modelId
        )
        const serviceTier = resolveServiceTier(provider.builtinId, model?.id ?? modelId)
        return {
          type: requestType,
          apiKey: provider.apiKey,
          baseUrl: normalizedBaseUrl,
          model: modelId,
          providerId: provider.id,
          providerBuiltinId: provider.builtinId,
          ...(serviceTier ? { serviceTier } : {}),
          requiresApiKey: provider.requiresApiKey,
          ...(provider.useSystemProxy !== undefined
            ? { useSystemProxy: provider.useSystemProxy }
            : {}),
          responseSummary: model?.responseSummary,
          enablePromptCache: model?.enablePromptCache,
          enableSystemPromptCache: model?.enableSystemPromptCache,
          ...(provider.userAgent ? { userAgent: provider.userAgent } : {}),
          ...(requestOverrides ? { requestOverrides } : {}),
          ...(provider.instructionsPrompt
            ? { instructionsPrompt: provider.instructionsPrompt }
            : {})
        }
      },

      getFastProviderConfig: () => {
        const { providers, activeProviderId, activeFastProviderId, activeFastModelId } = get()
        const providerId = activeFastProviderId ?? activeProviderId
        if (!providerId) return null
        const provider = providers.find((p) => p.id === providerId)
        if (!provider) return null
        const model =
          (activeFastModelId && provider.models.some((m) => m.id === activeFastModelId)
            ? activeFastModelId
            : resolveProviderDefaultModelIdByCategory(provider, 'chat') ||
              resolveProviderDefaultModelId(provider)) || ''
        const fastModel = provider.models.find((m) => m.id === model)

        // Override provider type for image category models
        let requestType = fastModel?.type ?? provider.type
        if (fastModel?.category === 'image') {
          requestType = 'openai-images'
          console.log(
            '[Provider Store] Image model detected in getFastProviderConfig, routing to openai-images provider',
            {
              modelId: model,
              originalType: fastModel?.type,
              providerType: provider.type,
              finalType: requestType
            }
          )
        }

        const normalizedBaseUrl = provider.baseUrl
          ? normalizeProviderBaseUrl(provider.baseUrl, requestType)
          : undefined
        const requestOverrides = buildRequestOverrides(
          provider.requestOverrides,
          fastModel?.requestOverrides,
          fastModel?.id ?? model
        )
        const serviceTier = resolveServiceTier(provider.builtinId, fastModel?.id ?? model)
        return {
          type: requestType,
          apiKey: provider.apiKey,
          baseUrl: normalizedBaseUrl,
          model,
          providerId: provider.id,
          providerBuiltinId: provider.builtinId,
          ...(serviceTier ? { serviceTier } : {}),
          requiresApiKey: provider.requiresApiKey,
          ...(provider.useSystemProxy !== undefined
            ? { useSystemProxy: provider.useSystemProxy }
            : {}),
          responseSummary: fastModel?.responseSummary,
          enablePromptCache: fastModel?.enablePromptCache,
          enableSystemPromptCache: fastModel?.enableSystemPromptCache,
          ...(provider.userAgent ? { userAgent: provider.userAgent } : {}),
          ...(requestOverrides ? { requestOverrides } : {}),
          ...(provider.instructionsPrompt
            ? { instructionsPrompt: provider.instructionsPrompt }
            : {})
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

      _markMigrated: () => set({ _migrated: true })
    }),
    {
      name: 'opencowork-providers',
      storage: createJSONStorage(() => configStorage),
      partialize: (state) => ({
        providers: state.providers,
        activeProviderId: state.activeProviderId,
        activeModelId: state.activeModelId,
        activeFastProviderId: state.activeFastProviderId,
        activeFastModelId: state.activeFastModelId,
        activeTranslationProviderId: state.activeTranslationProviderId,
        activeTranslationModelId: state.activeTranslationModelId,
        activeSpeechProviderId: state.activeSpeechProviderId,
        activeSpeechModelId: state.activeSpeechModelId,
        activeImageProviderId: state.activeImageProviderId,
        activeImageModelId: state.activeImageModelId,
        _migrated: state._migrated
      })
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
      if (existing.useSystemProxy !== preset.useSystemProxy) {
        patch.useSystemProxy = preset.useSystemProxy
      }
      if (existing.userAgent !== preset.userAgent) {
        patch.userAgent = preset.userAgent
      }
      if (existing.defaultModel !== preset.defaultModel) {
        patch.defaultModel = preset.defaultModel
      }
      if (preset.instructionsPrompt && existing.instructionsPrompt !== preset.instructionsPrompt) {
        patch.instructionsPrompt = preset.instructionsPrompt
      }
      if (!existing.authMode) {
        patch.authMode = preset.authMode ?? 'apiKey'
      }
      if (preset.builtinId === 'codex-oauth') {
        const trimmedBaseUrl = existing.baseUrl.trim().replace(/\/+$/, '')
        if (
          !trimmedBaseUrl ||
          trimmedBaseUrl === 'https://api.openai.com/v1' ||
          trimmedBaseUrl === 'https://api.openai.com'
        ) {
          patch.baseUrl = preset.defaultBaseUrl
        }
      }
      if (preset.oauthConfig) {
        if (preset.builtinId === 'codex-oauth') {
          patch.oauthConfig = { ...preset.oauthConfig }
        } else if (!existing.oauthConfig) {
          patch.oauthConfig = { ...preset.oauthConfig }
        } else {
          const merged = { ...existing.oauthConfig }
          let changed = false

          if (!merged.authorizeUrl && preset.oauthConfig.authorizeUrl) {
            merged.authorizeUrl = preset.oauthConfig.authorizeUrl
            changed = true
          }
          if (!merged.tokenUrl && preset.oauthConfig.tokenUrl) {
            merged.tokenUrl = preset.oauthConfig.tokenUrl
            changed = true
          }
          if (!merged.clientId && preset.oauthConfig.clientId) {
            merged.clientId = preset.oauthConfig.clientId
            changed = true
          }
          if (
            merged.clientIdLocked === undefined &&
            preset.oauthConfig.clientIdLocked !== undefined
          ) {
            merged.clientIdLocked = preset.oauthConfig.clientIdLocked
            changed = true
          }
          if (!merged.scope && preset.oauthConfig.scope) {
            merged.scope = preset.oauthConfig.scope
            changed = true
          }
          if (!merged.redirectPath && preset.oauthConfig.redirectPath) {
            merged.redirectPath = preset.oauthConfig.redirectPath
            changed = true
          }
          if (merged.redirectPort === undefined && preset.oauthConfig.redirectPort !== undefined) {
            merged.redirectPort = preset.oauthConfig.redirectPort
            changed = true
          }
          if (merged.usePkce === undefined && preset.oauthConfig.usePkce !== undefined) {
            merged.usePkce = preset.oauthConfig.usePkce
            changed = true
          }

          if (preset.oauthConfig.extraParams) {
            if (!merged.extraParams) {
              merged.extraParams = { ...preset.oauthConfig.extraParams }
              changed = true
            } else {
              for (const [key, value] of Object.entries(preset.oauthConfig.extraParams)) {
                const existingValue = merged.extraParams[key]
                if (
                  !existingValue ||
                  (typeof existingValue === 'string' && !existingValue.trim())
                ) {
                  merged.extraParams[key] = value
                  changed = true
                }
              }
            }
          }

          if (changed) {
            patch.oauthConfig = merged
          }
        }
      }
      if (!existing.channelConfig && preset.channelConfig) {
        patch.channelConfig = { ...preset.channelConfig }
      }
      if (preset.requestOverrides) {
        if (preset.builtinId === 'codex-oauth') {
          patch.requestOverrides = { ...preset.requestOverrides }
        } else if (!existing.requestOverrides) {
          patch.requestOverrides = { ...preset.requestOverrides }
        }
      }
      if (preset.ui) {
        if (!existing.ui) {
          patch.ui = { ...preset.ui }
        } else {
          const merged = { ...existing.ui }
          let changed = false

          if (merged.hideOAuthSettings === undefined && preset.ui.hideOAuthSettings !== undefined) {
            merged.hideOAuthSettings = preset.ui.hideOAuthSettings
            changed = true
          }

          if (changed) {
            patch.ui = merged
          }
        }
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
  const activeProvider = state.activeProviderId
    ? state.providers.find((provider) => provider.id === state.activeProviderId)
    : null
  if (activeProvider) {
    const nextChatModelId = resolveValidModelIdByCategory(
      activeProvider,
      state.activeModelId,
      'chat'
    )
    if (nextChatModelId && nextChatModelId !== state.activeModelId) {
      state.setActiveModel(nextChatModelId)
    }
  }

  if (!state.activeTranslationProviderId) {
    const fallbackProviderId = state.activeProviderId
    if (fallbackProviderId) {
      state.setActiveTranslationProvider(fallbackProviderId)
    }
  } else {
    const translationProvider = state.providers.find(
      (provider) => provider.id === state.activeTranslationProviderId
    )
    if (translationProvider) {
      const nextTranslationModelId = resolveValidModelIdByCategory(
        translationProvider,
        state.activeTranslationModelId,
        'chat'
      )
      if (nextTranslationModelId && nextTranslationModelId !== state.activeTranslationModelId) {
        state.setActiveTranslationModel(nextTranslationModelId)
      }
    }
  }

  const fastProviderId = state.activeFastProviderId ?? state.activeProviderId
  if (fastProviderId) {
    const fastProvider = state.providers.find((provider) => provider.id === fastProviderId)
    if (fastProvider) {
      if (!state.activeFastProviderId) {
        state.setActiveFastProvider(fastProvider.id)
      } else {
        const nextFastModelId = resolveValidModelIdByCategory(
          fastProvider,
          state.activeFastModelId,
          'chat'
        )
        if (nextFastModelId && nextFastModelId !== state.activeFastModelId) {
          state.setActiveFastModel(nextFastModelId)
        }
      }
    }
  }

  const imageProviderId =
    state.activeImageProviderId ?? resolveFirstProviderIdByCategory(state.providers, 'image')
  if (imageProviderId) {
    const imageProvider = state.providers.find((provider) => provider.id === imageProviderId)
    if (imageProvider) {
      if (state.activeImageProviderId !== imageProviderId) {
        state.setActiveImageProvider(imageProviderId)
      } else {
        const nextImageModelId = resolveValidModelIdByCategory(
          imageProvider,
          state.activeImageModelId,
          'image'
        )
        if (nextImageModelId && nextImageModelId !== state.activeImageModelId) {
          state.setActiveImageModel(nextImageModelId)
        }
      }
    }
  }

  if (state.activeSpeechProviderId) {
    const speechProvider = state.providers.find(
      (provider) => provider.id === state.activeSpeechProviderId
    )
    if (speechProvider) {
      const nextSpeechModelId = resolveValidModelIdByCategory(
        speechProvider,
        state.activeSpeechModelId,
        'speech'
      )
      if (nextSpeechModelId && nextSpeechModelId !== state.activeSpeechModelId) {
        state.setActiveSpeechModel(nextSpeechModelId)
      }
    }
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
