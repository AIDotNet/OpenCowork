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
import { resolveCopilotApiBaseUrl, resolveCopilotModelId } from '../lib/auth/copilot'
import { configStorage } from '../lib/ipc/config-storage'
import { useSettingsStore } from './settings-store'

export { builtinProviderPresets }
export type { BuiltinProviderPreset }

const DEFAULT_FAST_PROVIDER_BUILTIN_ID = 'routin-ai'
const DEFAULT_FAST_MODEL_ID = 'doubao-seed-2-0-mini-260215'
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

export function modelSupportsComputerUse(
  model: AIModelConfig | null | undefined,
  providerType?: ProviderType
): boolean {
  if (!model) return false
  const requestType = model.type ?? providerType
  return requestType === 'openai-responses' && model.supportsComputerUse === true
}

export function isProviderAuthReady(provider: AIProvider | null | undefined): boolean {
  if (!provider) return false

  const authMode = provider.authMode ?? 'apiKey'
  if (authMode === 'apiKey') {
    return provider.requiresApiKey === false || provider.apiKey.trim().length > 0
  }
  if (authMode === 'oauth') {
    return Boolean(provider.oauth?.accessToken)
  }
  if (authMode === 'channel') {
    return Boolean(provider.channel?.accessToken)
  }
  return false
}

export function isProviderAvailableForModelSelection(
  provider: AIProvider | null | undefined
): boolean {
  if (!provider?.enabled) return false
  return isProviderAuthReady(provider)
}

export function getEnabledModelsByCategory(
  provider: AIProvider | null | undefined,
  category: ModelCategory
): AIModelConfig[] {
  if (!provider) return []
  return provider.models.filter((model) => model.enabled && (model.category ?? 'chat') === category)
}

export function isModelComputerUseEnabled(
  model: AIModelConfig | null | undefined,
  providerType?: ProviderType
): boolean {
  return modelSupportsComputerUse(model, providerType) && model?.enableComputerUse === true
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
  if (requestType === 'gemini' || requestType === 'vertex-ai') {
    return trimmed.replace(/\/openai$/i, '')
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

function resolveServiceTier(
  model: AIModelConfig | null | undefined,
  providerBuiltinId?: string
): ProviderConfig['serviceTier'] | undefined {
  if (providerBuiltinId === 'codex-oauth') return model?.serviceTier
  if (!useSettingsStore.getState().fastModeEnabled) return undefined
  return model?.serviceTier
}

function mergeBuiltinModels(
  existingModels: AIModelConfig[],
  presetModels: AIModelConfig[],
  deprecatedModelIds: string[] = []
): AIModelConfig[] {
  const existingById = new Map(existingModels.map((model) => [model.id, model]))
  const presetIds = new Set(presetModels.map((model) => model.id))
  const deprecatedIds = new Set([...deprecatedModelIds])

  // Keep preset order for builtin models; preserve user's enabled state and capability overrides.
  const capabilityKeys: (keyof AIModelConfig)[] = [
    'supportsVision',
    'supportsFunctionCall',
    'supportsComputerUse',
    'enableComputerUse'
  ]
  const merged = presetModels.map((presetModel) => {
    const existingModel = existingById.get(presetModel.id)
    if (!existingModel) return { ...presetModel }
    const capabilityOverrides: Partial<AIModelConfig> = {}
    for (const key of capabilityKeys) {
      if (existingModel[key] !== undefined) {
        ;(capabilityOverrides as Record<string, unknown>)[key] = existingModel[key]
      }
    }
    return {
      ...existingModel,
      ...presetModel,
      ...capabilityOverrides,
      enabled: existingModel.enabled
    }
  })

  // Keep user-added custom models that are not part of builtin preset.
  for (const existingModel of existingModels) {
    if (!presetIds.has(existingModel.id) && !deprecatedIds.has(existingModel.id)) {
      merged.push(existingModel)
    }
  }

  return merged
}

function resolveProviderDefaultModelId(provider: AIProvider): string {
  const defaultModel = provider.defaultModel
    ? provider.models.find((model) => model.id === provider.defaultModel)
    : null
  if (defaultModel?.enabled) return defaultModel.id

  const enabledModels = provider.models.filter((model) => model.enabled)
  if (enabledModels[0]) return enabledModels[0].id

  return defaultModel?.id ?? provider.models[0]?.id ?? ''
}

function resolveProviderDefaultModelIdByCategory(
  provider: AIProvider,
  category: ModelCategory
): string {
  const defaultModel = provider.defaultModel
    ? provider.models.find((model) => model.id === provider.defaultModel)
    : null
  if (defaultModel?.enabled && (defaultModel.category ?? 'chat') === category) {
    return defaultModel.id
  }

  const categoryModels = provider.models.filter((model) => (model.category ?? 'chat') === category)
  const enabledModels = categoryModels.filter((model) => model.enabled)
  if (enabledModels[0]) return enabledModels[0].id

  if (defaultModel && (defaultModel.category ?? 'chat') === category) {
    return defaultModel.id
  }

  return categoryModels[0]?.id ?? ''
}

function resolveDefaultFastSelection(
  providers: AIProvider[]
): { providerId: string; modelId: string } | null {
  const preferredProvider = providers.find(
    (provider) =>
      isProviderAvailableForModelSelection(provider) &&
      provider.builtinId === DEFAULT_FAST_PROVIDER_BUILTIN_ID &&
      provider.models.some((model) => model.enabled && (model.category ?? 'chat') === 'chat')
  )

  if (preferredProvider) {
    const preferredModel = preferredProvider.models.find(
      (model) => model.enabled && model.id === DEFAULT_FAST_MODEL_ID
    )
    const fallbackModelId =
      resolveProviderDefaultModelIdByCategory(preferredProvider, 'chat') ||
      resolveProviderDefaultModelId(preferredProvider)
    const modelId = preferredModel?.id ?? fallbackModelId
    if (modelId) {
      return { providerId: preferredProvider.id, modelId }
    }
  }

  const fallbackProviderId = resolveFirstProviderIdByCategory(providers, 'chat')
  if (!fallbackProviderId) return null
  const fallbackProvider = providers.find((provider) => provider.id === fallbackProviderId)
  if (!fallbackProvider) return null
  const modelId =
    resolveProviderDefaultModelIdByCategory(fallbackProvider, 'chat') ||
    resolveProviderDefaultModelId(fallbackProvider)
  if (!modelId) return null
  return { providerId: fallbackProvider.id, modelId }
}

function resolveFirstProviderIdByCategory(
  providers: AIProvider[],
  category: ModelCategory
): string | null {
  return (
    providers.find(
      (provider) =>
        isProviderAvailableForModelSelection(provider) &&
        provider.models.some((model) => model.enabled && (model.category ?? 'chat') === category)
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

type ProviderSelectionState = Pick<
  ProviderStore,
  | 'activeProviderId'
  | 'activeModelId'
  | 'activeFastProviderId'
  | 'activeFastModelId'
  | 'activeTranslationProviderId'
  | 'activeTranslationModelId'
  | 'activeSpeechProviderId'
  | 'activeSpeechModelId'
  | 'activeImageProviderId'
  | 'activeImageModelId'
>

function resolveProviderSelectionByCategory(
  providers: AIProvider[],
  providerId: string | null,
  modelId: string,
  category: ModelCategory
): { providerId: string | null; modelId: string } {
  const currentProvider = providerId
    ? providers.find((provider) => provider.id === providerId)
    : null
  const hasEnabledCategoryModel = currentProvider?.models.some(
    (model) => model.enabled && (model.category ?? 'chat') === category
  )

  if (
    currentProvider &&
    hasEnabledCategoryModel &&
    isProviderAvailableForModelSelection(currentProvider)
  ) {
    const nextModelId = resolveValidModelIdByCategory(currentProvider, modelId, category)
    if (nextModelId) {
      return { providerId: currentProvider.id, modelId: nextModelId }
    }
  }

  const fallbackProviderId = resolveFirstProviderIdByCategory(providers, category)
  if (!fallbackProviderId) {
    return { providerId: null, modelId: '' }
  }

  const fallbackProvider = providers.find((provider) => provider.id === fallbackProviderId)
  if (!fallbackProvider) {
    return { providerId: null, modelId: '' }
  }

  const fallbackModelId = resolveValidModelIdByCategory(fallbackProvider, '', category)
  if (!fallbackModelId) {
    return { providerId: null, modelId: '' }
  }

  return { providerId: fallbackProvider.id, modelId: fallbackModelId }
}

function buildNormalizedProviderState(
  state: ProviderSelectionState,
  providers: AIProvider[]
): Partial<ProviderStore> {
  const mainSelection = resolveProviderSelectionByCategory(
    providers,
    state.activeProviderId,
    state.activeModelId,
    'chat'
  )

  const explicitFastSelection = state.activeFastProviderId
    ? resolveProviderSelectionByCategory(
        providers,
        state.activeFastProviderId,
        state.activeFastModelId,
        'chat'
      )
    : { providerId: null, modelId: '' }
  const fastSelection =
    explicitFastSelection.providerId && explicitFastSelection.modelId
      ? explicitFastSelection
      : (resolveDefaultFastSelection(providers) ??
        resolveProviderSelectionByCategory(
          providers,
          mainSelection.providerId,
          state.activeFastModelId || mainSelection.modelId,
          'chat'
        ))

  const translationSelection = resolveProviderSelectionByCategory(
    providers,
    state.activeTranslationProviderId ?? mainSelection.providerId,
    state.activeTranslationModelId,
    'chat'
  )

  const imageSelection = resolveProviderSelectionByCategory(
    providers,
    state.activeImageProviderId,
    state.activeImageModelId,
    'image'
  )

  const speechSelection = state.activeSpeechProviderId
    ? resolveProviderSelectionByCategory(
        providers,
        state.activeSpeechProviderId,
        state.activeSpeechModelId,
        'speech'
      )
    : { providerId: null, modelId: '' }

  return {
    activeProviderId: mainSelection.providerId,
    activeModelId: mainSelection.modelId,
    activeFastProviderId: fastSelection.providerId,
    activeFastModelId: fastSelection.modelId,
    activeTranslationProviderId: translationSelection.providerId,
    activeTranslationModelId: translationSelection.modelId,
    activeSpeechProviderId: speechSelection.providerId,
    activeSpeechModelId: speechSelection.modelId,
    activeImageProviderId: imageSelection.providerId,
    activeImageModelId: imageSelection.modelId
  }
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

      addProvider: (provider) =>
        set((state) => {
          const providers = [...state.providers, provider]
          return {
            providers,
            ...buildNormalizedProviderState(state, providers)
          }
        }),

      addProviderFromPreset: (builtinId) => {
        const preset = builtinProviderPresets.find((p) => p.builtinId === builtinId)
        if (!preset) return null
        const existing = get().providers.find((p) => p.builtinId === builtinId)
        if (existing) return existing.id
        const provider = createProviderFromPreset(preset)
        set((state) => {
          const providers = [...state.providers, provider]
          return {
            providers,
            ...buildNormalizedProviderState(state, providers)
          }
        })
        return provider.id
      },

      updateProvider: (id, patch) =>
        set((state) => {
          const providers = state.providers.map((provider) =>
            provider.id === id ? { ...provider, ...patch } : provider
          )
          return {
            providers,
            ...buildNormalizedProviderState(state, providers)
          }
        }),

      removeProvider: (id) =>
        set((state) => {
          const providers = state.providers.filter((provider) => provider.id !== id)
          return {
            providers,
            ...buildNormalizedProviderState(
              {
                ...state,
                activeProviderId: state.activeProviderId === id ? null : state.activeProviderId,
                activeModelId: state.activeProviderId === id ? '' : state.activeModelId,
                activeTranslationProviderId:
                  state.activeTranslationProviderId === id
                    ? null
                    : state.activeTranslationProviderId,
                activeTranslationModelId:
                  state.activeTranslationProviderId === id ? '' : state.activeTranslationModelId,
                activeSpeechProviderId:
                  state.activeSpeechProviderId === id ? null : state.activeSpeechProviderId,
                activeSpeechModelId:
                  state.activeSpeechProviderId === id ? '' : state.activeSpeechModelId,
                activeImageProviderId:
                  state.activeImageProviderId === id ? null : state.activeImageProviderId,
                activeImageModelId:
                  state.activeImageProviderId === id ? '' : state.activeImageModelId,
                activeFastProviderId:
                  state.activeFastProviderId === id ? null : state.activeFastProviderId,
                activeFastModelId: state.activeFastProviderId === id ? '' : state.activeFastModelId
              },
              providers
            )
          }
        }),

      toggleProviderEnabled: (id) =>
        set((state) => {
          const providers = state.providers.map((provider) =>
            provider.id === id ? { ...provider, enabled: !provider.enabled } : provider
          )
          return {
            providers,
            ...buildNormalizedProviderState(state, providers)
          }
        }),

      addModel: (providerId, model) =>
        set((state) => {
          const providers = state.providers.map((provider) =>
            provider.id === providerId
              ? { ...provider, models: [...provider.models, model] }
              : provider
          )
          return {
            providers,
            ...buildNormalizedProviderState(state, providers)
          }
        }),

      updateModel: (providerId, modelId, patch) =>
        set((state) => {
          const providers = state.providers.map((provider) =>
            provider.id === providerId
              ? {
                  ...provider,
                  models: provider.models.map((model) =>
                    model.id === modelId ? { ...model, ...patch } : model
                  )
                }
              : provider
          )
          return {
            providers,
            ...buildNormalizedProviderState(state, providers)
          }
        }),

      removeModel: (providerId, modelId) =>
        set((state) => {
          const providers = state.providers.map((provider) =>
            provider.id === providerId
              ? { ...provider, models: provider.models.filter((model) => model.id !== modelId) }
              : provider
          )
          return {
            providers,
            ...buildNormalizedProviderState(state, providers)
          }
        }),

      toggleModelEnabled: (providerId, modelId) =>
        set((state) => {
          const providers = state.providers.map((provider) =>
            provider.id === providerId
              ? {
                  ...provider,
                  models: provider.models.map((model) =>
                    model.id === modelId ? { ...model, enabled: !model.enabled } : model
                  )
                }
              : provider
          )
          return {
            providers,
            ...buildNormalizedProviderState(state, providers)
          }
        }),

      setProviderModels: (providerId, models) =>
        set((state) => {
          const providers = state.providers.map((provider) =>
            provider.id === providerId ? { ...provider, models } : provider
          )
          return {
            providers,
            ...buildNormalizedProviderState(state, providers)
          }
        }),

      setActiveProvider: (providerId) =>
        set((state) =>
          buildNormalizedProviderState(
            {
              ...state,
              activeProviderId: providerId,
              activeModelId: ''
            },
            state.providers
          )
        ),

      setActiveModel: (modelId) =>
        set((state) =>
          buildNormalizedProviderState(
            {
              ...state,
              activeModelId: modelId
            },
            state.providers
          )
        ),

      setActiveFastProvider: (providerId) =>
        set((state) =>
          buildNormalizedProviderState(
            {
              ...state,
              activeFastProviderId: providerId,
              activeFastModelId: ''
            },
            state.providers
          )
        ),

      setActiveFastModel: (modelId) =>
        set((state) =>
          buildNormalizedProviderState(
            {
              ...state,
              activeFastModelId: modelId
            },
            state.providers
          )
        ),

      setActiveTranslationProvider: (providerId) =>
        set((state) =>
          buildNormalizedProviderState(
            {
              ...state,
              activeTranslationProviderId: providerId,
              activeTranslationModelId: ''
            },
            state.providers
          )
        ),

      setActiveTranslationModel: (modelId) =>
        set((state) =>
          buildNormalizedProviderState(
            {
              ...state,
              activeTranslationModelId: modelId
            },
            state.providers
          )
        ),

      setActiveSpeechProvider: (providerId) =>
        set((state) =>
          buildNormalizedProviderState(
            {
              ...state,
              activeSpeechProviderId: providerId,
              activeSpeechModelId: ''
            },
            state.providers
          )
        ),

      setActiveSpeechModel: (modelId) =>
        set((state) =>
          buildNormalizedProviderState(
            {
              ...state,
              activeSpeechModelId: modelId
            },
            state.providers
          )
        ),

      setActiveImageProvider: (providerId) =>
        set((state) =>
          buildNormalizedProviderState(
            {
              ...state,
              activeImageProviderId: providerId,
              activeImageModelId: ''
            },
            state.providers
          )
        ),

      setActiveImageModel: (modelId) =>
        set((state) =>
          buildNormalizedProviderState(
            {
              ...state,
              activeImageModelId: modelId
            },
            state.providers
          )
        ),

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

        // Image models should respect explicit protocol overrides (e.g. Gemini).
        // Fall back to OpenAI Images only when an image model has no explicit type.
        let requestType = activeModel?.type ?? provider.type
        if (activeModel?.category === 'image' && !activeModel?.type) {
          requestType = 'openai-images'
          console.log(
            '[Provider Store] Image model without explicit type, routing to openai-images provider',
            {
              modelId: activeModelId,
              providerType: provider.type,
              finalType: requestType
            }
          )
        }

        const resolvedBaseUrl =
          provider.builtinId === 'copilot-oauth'
            ? resolveCopilotApiBaseUrl(provider, provider.oauth)
            : provider.baseUrl
        const normalizedBaseUrl = resolvedBaseUrl
          ? normalizeProviderBaseUrl(resolvedBaseUrl, requestType)
          : undefined
        const requestOverrides = buildRequestOverrides(
          provider.requestOverrides,
          activeModel?.requestOverrides,
          activeModel?.id ?? activeModelId
        )
        const serviceTier = resolveServiceTier(activeModel, provider.builtinId)
        return {
          type: requestType,
          apiKey: provider.apiKey,
          baseUrl: normalizedBaseUrl,
          model: activeModelId,
          category: activeModel?.category,
          providerId: provider.id,
          providerBuiltinId: provider.builtinId,
          computerUseEnabled: isModelComputerUseEnabled(activeModel, requestType),
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
        const resolvedModelId =
          provider.builtinId === 'copilot-oauth' ? resolveCopilotModelId(modelId) : modelId
        const model = provider.models.find((m) => m.id === resolvedModelId)

        // Image models should respect explicit protocol overrides (e.g. Gemini).
        // Fall back to OpenAI Images only when an image model has no explicit type.
        let requestType = model?.type ?? provider.type
        if (model?.category === 'image' && !model?.type) {
          requestType = 'openai-images'
          console.log(
            '[Provider Store] Image model without explicit type in getProviderConfigById, routing to openai-images provider',
            {
              modelId: resolvedModelId,
              providerType: provider.type,
              finalType: requestType
            }
          )
        }

        const resolvedBaseUrl =
          provider.builtinId === 'copilot-oauth'
            ? resolveCopilotApiBaseUrl(provider, provider.oauth)
            : provider.baseUrl
        const normalizedBaseUrl = resolvedBaseUrl
          ? normalizeProviderBaseUrl(resolvedBaseUrl, requestType)
          : undefined
        const requestOverrides = buildRequestOverrides(
          provider.requestOverrides,
          model?.requestOverrides,
          model?.id ?? resolvedModelId
        )
        const serviceTier = resolveServiceTier(model, provider.builtinId)
        return {
          type: requestType,
          apiKey: provider.apiKey,
          baseUrl: normalizedBaseUrl,
          model: resolvedModelId,
          providerId: provider.id,
          providerBuiltinId: provider.builtinId,
          computerUseEnabled: isModelComputerUseEnabled(model, requestType),
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
        const {
          providers,
          activeProviderId,
          activeModelId,
          activeFastProviderId,
          activeFastModelId
        } = get()
        const explicitFastSelection = activeFastProviderId
          ? resolveProviderSelectionByCategory(
              providers,
              activeFastProviderId,
              activeFastModelId,
              'chat'
            )
          : { providerId: null, modelId: '' }
        const resolvedFastSelection =
          explicitFastSelection.providerId && explicitFastSelection.modelId
            ? explicitFastSelection
            : (resolveDefaultFastSelection(providers) ??
              resolveProviderSelectionByCategory(
                providers,
                activeProviderId,
                activeFastModelId || activeModelId,
                'chat'
              ))
        if (!resolvedFastSelection.providerId || !resolvedFastSelection.modelId) return null
        const provider = providers.find((p) => p.id === resolvedFastSelection.providerId)
        if (!provider) return null
        const model = resolvedFastSelection.modelId
        const fastModel = provider.models.find((m) => m.id === model)

        // Image models should respect explicit protocol overrides (e.g. Gemini).
        // Fall back to OpenAI Images only when an image model has no explicit type.
        let requestType = fastModel?.type ?? provider.type
        if (fastModel?.category === 'image' && !fastModel?.type) {
          requestType = 'openai-images'
          console.log(
            '[Provider Store] Image model without explicit type in getFastProviderConfig, routing to openai-images provider',
            {
              modelId: model,
              providerType: provider.type,
              finalType: requestType
            }
          )
        }

        const resolvedBaseUrl =
          provider.builtinId === 'copilot-oauth'
            ? resolveCopilotApiBaseUrl(provider, provider.oauth)
            : provider.baseUrl
        const normalizedBaseUrl = resolvedBaseUrl
          ? normalizeProviderBaseUrl(resolvedBaseUrl, requestType)
          : undefined
        const requestOverrides = buildRequestOverrides(
          provider.requestOverrides,
          fastModel?.requestOverrides,
          fastModel?.id ?? model
        )
        const serviceTier = resolveServiceTier(fastModel, provider.builtinId)
        return {
          type: requestType,
          apiKey: provider.apiKey,
          baseUrl: normalizedBaseUrl,
          model,
          providerId: provider.id,
          providerBuiltinId: provider.builtinId,
          computerUseEnabled: isModelComputerUseEnabled(fastModel, requestType),
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
      } else if (preset.builtinId === 'codex-oauth' && existing.instructionsPrompt !== undefined) {
        patch.instructionsPrompt = undefined
      }
      if (!existing.authMode) {
        patch.authMode = preset.authMode ?? 'apiKey'
      }
      if (preset.builtinId === 'codex-oauth' || preset.builtinId === 'copilot-oauth') {
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
          if (merged.flowType === undefined && preset.oauthConfig.flowType !== undefined) {
            merged.flowType = preset.oauthConfig.flowType
            changed = true
          }
          if (!merged.host && preset.oauthConfig.host) {
            merged.host = preset.oauthConfig.host
            changed = true
          }
          if (!merged.apiHost && preset.oauthConfig.apiHost) {
            merged.apiHost = preset.oauthConfig.apiHost
            changed = true
          }
          if (!merged.deviceCodeUrl && preset.oauthConfig.deviceCodeUrl) {
            merged.deviceCodeUrl = preset.oauthConfig.deviceCodeUrl
            changed = true
          }
          if (!merged.tokenExchangeUrl && preset.oauthConfig.tokenExchangeUrl) {
            merged.tokenExchangeUrl = preset.oauthConfig.tokenExchangeUrl
            changed = true
          }
          if (
            merged.deviceCodeRequestMode === undefined &&
            preset.oauthConfig.deviceCodeRequestMode !== undefined
          ) {
            merged.deviceCodeRequestMode = preset.oauthConfig.deviceCodeRequestMode
            changed = true
          }
          if (
            merged.useSystemProxy === undefined &&
            preset.oauthConfig.useSystemProxy !== undefined
          ) {
            merged.useSystemProxy = preset.oauthConfig.useSystemProxy
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
          if (merged.flowType === undefined && preset.oauthConfig.flowType !== undefined) {
            merged.flowType = preset.oauthConfig.flowType
            changed = true
          }
          if (!merged.host && preset.oauthConfig.host) {
            merged.host = preset.oauthConfig.host
            changed = true
          }
          if (!merged.apiHost && preset.oauthConfig.apiHost) {
            merged.apiHost = preset.oauthConfig.apiHost
            changed = true
          }
          if (!merged.deviceCodeUrl && preset.oauthConfig.deviceCodeUrl) {
            merged.deviceCodeUrl = preset.oauthConfig.deviceCodeUrl
            changed = true
          }
          if (!merged.tokenExchangeUrl && preset.oauthConfig.tokenExchangeUrl) {
            merged.tokenExchangeUrl = preset.oauthConfig.tokenExchangeUrl
            changed = true
          }
          if (
            merged.deviceCodeRequestMode === undefined &&
            preset.oauthConfig.deviceCodeRequestMode !== undefined
          ) {
            merged.deviceCodeRequestMode = preset.oauthConfig.deviceCodeRequestMode
            changed = true
          }
          if (!merged.tokenRequestHeaders && preset.oauthConfig.tokenRequestHeaders) {
            merged.tokenRequestHeaders = { ...preset.oauthConfig.tokenRequestHeaders }
            changed = true
          }
          if (!merged.refreshRequestHeaders && preset.oauthConfig.refreshRequestHeaders) {
            merged.refreshRequestHeaders = { ...preset.oauthConfig.refreshRequestHeaders }
            changed = true
          }
          if (!merged.deviceCodeRequestHeaders && preset.oauthConfig.deviceCodeRequestHeaders) {
            merged.deviceCodeRequestHeaders = { ...preset.oauthConfig.deviceCodeRequestHeaders }
            changed = true
          }

          if (preset.oauthConfig.tokenRequestHeaders) {
            if (!merged.tokenRequestHeaders) {
              merged.tokenRequestHeaders = { ...preset.oauthConfig.tokenRequestHeaders }
              changed = true
            } else {
              for (const [key, value] of Object.entries(preset.oauthConfig.tokenRequestHeaders)) {
                if (!merged.tokenRequestHeaders[key]) {
                  merged.tokenRequestHeaders[key] = value
                  changed = true
                }
              }
            }
          }

          if (preset.oauthConfig.refreshRequestHeaders) {
            if (!merged.refreshRequestHeaders) {
              merged.refreshRequestHeaders = { ...preset.oauthConfig.refreshRequestHeaders }
              changed = true
            } else {
              for (const [key, value] of Object.entries(preset.oauthConfig.refreshRequestHeaders)) {
                if (!merged.refreshRequestHeaders[key]) {
                  merged.refreshRequestHeaders[key] = value
                  changed = true
                }
              }
            }
          }

          if (preset.oauthConfig.deviceCodeRequestHeaders) {
            if (!merged.deviceCodeRequestHeaders) {
              merged.deviceCodeRequestHeaders = { ...preset.oauthConfig.deviceCodeRequestHeaders }
              changed = true
            } else {
              for (const [key, value] of Object.entries(
                preset.oauthConfig.deviceCodeRequestHeaders
              )) {
                if (!merged.deviceCodeRequestHeaders[key]) {
                  merged.deviceCodeRequestHeaders[key] = value
                  changed = true
                }
              }
            }
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
        } else if (preset.builtinId === 'copilot-oauth') {
          const merged = { ...(existing.requestOverrides ?? {}) }
          let changed = false
          if (preset.requestOverrides.headers) {
            merged.headers = { ...(merged.headers ?? {}) }
            for (const [key, value] of Object.entries(preset.requestOverrides.headers)) {
              if (!merged.headers[key]) {
                merged.headers[key] = value
                changed = true
              }
            }
          }
          if (changed) {
            patch.requestOverrides = merged
          }
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

      const updatedModels = mergeBuiltinModels(
        existing.models,
        preset.defaultModels,
        preset.deprecatedModelIds
      )
      if (JSON.stringify(updatedModels) !== JSON.stringify(existing.models)) {
        useProviderStore.getState().setProviderModels(existing.id, updatedModels)
      }
    }
  }

  if (!useProviderStore.getState().activeProviderId) {
    const providers = useProviderStore.getState().providers
    const firstAvailableProviderId = resolveFirstProviderIdByCategory(providers, 'chat')
    if (firstAvailableProviderId) {
      useProviderStore.getState().setActiveProvider(firstAvailableProviderId)
    }
  }

  const state = useProviderStore.getState()
  const defaultFastSelection = resolveDefaultFastSelection(state.providers)
  const shouldAdoptDefaultFastSelection =
    Boolean(defaultFastSelection) &&
    (!state.activeFastProviderId ||
      (state.activeFastProviderId === state.activeProviderId &&
        state.activeFastModelId === state.activeModelId))
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

  const fastProviderId = shouldAdoptDefaultFastSelection
    ? (defaultFastSelection?.providerId ?? state.activeFastProviderId ?? state.activeProviderId)
    : (state.activeFastProviderId ?? state.activeProviderId)
  if (fastProviderId) {
    const fastProvider = state.providers.find((provider) => provider.id === fastProviderId)
    if (fastProvider) {
      if (shouldAdoptDefaultFastSelection) {
        if (state.activeFastProviderId !== fastProvider.id) {
          state.setActiveFastProvider(fastProvider.id)
        }
        const preferredFastModelId =
          defaultFastSelection?.providerId === fastProvider.id
            ? defaultFastSelection.modelId
            : resolveValidModelIdByCategory(fastProvider, '', 'chat')
        if (preferredFastModelId && preferredFastModelId !== state.activeFastModelId) {
          state.setActiveFastModel(preferredFastModelId)
        }
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
