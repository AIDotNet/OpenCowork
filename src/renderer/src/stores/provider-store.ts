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
import {
  isResponsesImageGenerationEnabled,
  normalizeResponsesImageGenerationConfig
} from '../lib/api/responses-image-generation'
import { resolveProviderUserAgent } from '../lib/api/api-user-agent'
import { aiProviderStorage } from '../lib/ipc/ai-provider-storage'
import { useSettingsStore, clampApiRequestTimeoutSeconds } from './settings-store'

export { builtinProviderPresets }
export type { BuiltinProviderPreset }

const DEFAULT_FAST_PROVIDER_BUILTIN_ID = 'routin-ai'
const DEFAULT_FAST_MODEL_ID = 'doubao-seed-2-0-mini-260215'
// Kimi K2.7 Code rejects thinking.type values other than "enabled"; off means omitting it.
const KIMI_ENABLED_ONLY_THINKING_MODEL_KEYS = new Set([
  'kimi-for-coding',
  'kimi-k2.7-code',
  'kimi-k2.7-code-highspeed'
])

export interface ManagedModelConfig extends AIModelConfig {
  normalizedKey: string
}

export function normalizeModelKey(modelId: string): string {
  return modelId.trim().toLowerCase()
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingModelValue(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  if (isPlainObject(value)) return Object.keys(value).length === 0
  return false
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as T
  }
  if (isPlainObject(value)) {
    const cloned: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      cloned[key] = cloneValue(item)
    }
    return cloned as T
  }
  return value
}

function cloneModelConfig(model: AIModelConfig): AIModelConfig {
  return cloneValue(model)
}

function omitUnsupportedDisabledThinkingParams(model: AIModelConfig): AIModelConfig {
  if (!KIMI_ENABLED_ONLY_THINKING_MODEL_KEYS.has(normalizeModelKey(model.id))) return model
  if (!model.thinkingConfig?.disabledBodyParams) return model

  const thinkingConfig = { ...model.thinkingConfig }
  delete thinkingConfig.disabledBodyParams
  return { ...model, thinkingConfig }
}

function cloneManagedModelConfig(model: ManagedModelConfig): ManagedModelConfig {
  return cloneValue(model)
}

function normalizePresetVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

function toManagedModelConfig(model: AIModelConfig): ManagedModelConfig {
  const cloned = cloneModelConfig(model)
  const id = cloned.id.trim()
  return {
    ...cloned,
    id,
    name: cloned.name.trim() || id,
    normalizedKey: normalizeModelKey(id)
  }
}

function toManagedModelBase(model: ManagedModelConfig): AIModelConfig {
  const { normalizedKey, ...cloned } = cloneManagedModelConfig(model)
  void normalizedKey
  return cloned
}

function resolveModelIdByKey(models: AIModelConfig[], modelId: string): string | undefined {
  const modelKey = normalizeModelKey(modelId)
  return models.find((model) => normalizeModelKey(model.id) === modelKey)?.id
}

function getManagedModelFromCollection(
  managedModels: ManagedModelConfig[],
  modelId: string
): ManagedModelConfig | undefined {
  const modelKey = normalizeModelKey(modelId)
  return managedModels.find((model) => model.normalizedKey === modelKey)
}

function mergeMissingValue(target: unknown, source: unknown): { value: unknown; changed: boolean } {
  if (source === undefined) {
    return { value: cloneValue(target), changed: false }
  }

  if (isMissingModelValue(target)) {
    if (isMissingModelValue(source)) {
      return { value: cloneValue(target), changed: false }
    }
    return { value: cloneValue(source), changed: true }
  }

  if (Array.isArray(target) || Array.isArray(source)) {
    return { value: cloneValue(target), changed: false }
  }

  if (isPlainObject(target) && isPlainObject(source)) {
    const merged = cloneValue(target)
    let changed = false

    for (const [key, sourceValue] of Object.entries(source)) {
      const result = mergeMissingValue(merged[key], sourceValue)
      if (result.changed) {
        merged[key] = result.value
        changed = true
      }
    }

    return { value: merged, changed }
  }

  return { value: cloneValue(target), changed: false }
}

function mergeManagedModelMissingFields(
  target: ManagedModelConfig,
  source: ManagedModelConfig
): { model: ManagedModelConfig; changed: boolean } {
  const merged = cloneManagedModelConfig(target)
  const mergedRecord = merged as unknown as Record<string, unknown>
  let changed = false

  for (const [key, value] of Object.entries(source)) {
    if (key === 'normalizedKey') continue
    const result = mergeMissingValue(mergedRecord[key], value)
    if (result.changed) {
      mergedRecord[key] = result.value
      changed = true
    }
  }

  return { model: merged, changed }
}

function collectBuiltinManagedModels(): ManagedModelConfig[] {
  const managedByKey = new Map<string, ManagedModelConfig>()

  for (const preset of builtinProviderPresets) {
    for (const model of preset.defaultModels) {
      const candidate = toManagedModelConfig(model)
      const existing = managedByKey.get(candidate.normalizedKey)
      if (!existing) {
        managedByKey.set(candidate.normalizedKey, candidate)
        continue
      }

      // Provider order defines the canonical values. Later presets only enrich fields the
      // canonical model does not define, so one extra capability cannot replace its context.
      managedByKey.set(
        candidate.normalizedKey,
        mergeManagedModelMissingFields(existing, candidate).model
      )
    }
  }

  return Array.from(managedByKey.values())
}

function replaceManagedModelsForUpgradedPresets(
  existingModels: ManagedModelConfig[],
  tombstones: string[],
  upgradedPresets: BuiltinProviderPreset[]
): Pick<ProviderStore, 'managedModels' | 'managedModelTombstones'> {
  const builtinModels = collectBuiltinManagedModels()
  const builtinByKey = new Map(builtinModels.map((model) => [model.normalizedKey, model] as const))
  const upgradedKeys = new Set(
    upgradedPresets.flatMap((preset) =>
      preset.defaultModels.map((model) => normalizeModelKey(model.id))
    )
  )
  const deprecatedKeys = new Set(
    upgradedPresets.flatMap((preset) =>
      (preset.deprecatedModelIds ?? []).map((modelId) => normalizeModelKey(modelId))
    )
  )
  const replacementKeys = new Set([...upgradedKeys, ...deprecatedKeys])
  const replacementModels = Array.from(upgradedKeys)
    .map((modelKey) => builtinByKey.get(modelKey))
    .filter((model): model is ManagedModelConfig => Boolean(model))
  const preservedModels = existingModels.filter(
    (model) => !replacementKeys.has(model.normalizedKey)
  )

  return {
    managedModels: sortManagedModels([...preservedModels, ...replacementModels]),
    // A newer preset intentionally restores models previously removed from that preset's defaults.
    managedModelTombstones: tombstones.filter((modelKey) => !replacementKeys.has(modelKey))
  }
}

function sortManagedModels(models: ManagedModelConfig[]): ManagedModelConfig[] {
  return [...models].sort((a, b) => {
    const nameCompare = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    if (nameCompare !== 0) return nameCompare
    return a.id.localeCompare(b.id, undefined, { sensitivity: 'base' })
  })
}

/**
 * Effort levels are capability enums that evolve with the builtin presets. Persisted
 * snapshots saved before new levels existed would otherwise pin the old list forever
 * (mergeMissingValue never touches existing arrays), so adopt the canonical list whenever
 * the saved one is a strict subset of it. Lists carrying levels the preset doesn't know
 * (user customizations) are left untouched.
 */
function reconcileReasoningEffortLevels<T extends AIModelConfig>(
  model: T,
  canonical: AIModelConfig
): T {
  const canonicalLevels = canonical.thinkingConfig?.reasoningEffortLevels
  const savedLevels = model.thinkingConfig?.reasoningEffortLevels
  if (!canonicalLevels?.length || !savedLevels?.length) return model
  if (savedLevels.length >= canonicalLevels.length) return model
  const canonicalSet = new Set(canonicalLevels)
  if (!savedLevels.every((level) => canonicalSet.has(level))) return model
  return {
    ...model,
    thinkingConfig: {
      ...model.thinkingConfig,
      bodyParams: model.thinkingConfig?.bodyParams ?? {},
      reasoningEffortLevels: [...canonicalLevels]
    }
  }
}

export function buildProviderModelSnapshot(
  model: AIModelConfig,
  options: {
    managedModel?: ManagedModelConfig | null
    existingModel?: AIModelConfig | null
  } = {}
): AIModelConfig {
  const baseModel = cloneModelConfig(model)
  const managedModel = options.managedModel ? toManagedModelBase(options.managedModel) : null
  const existingModel = options.existingModel ? cloneModelConfig(options.existingModel) : null

  if (existingModel) {
    return omitUnsupportedDisabledThinkingParams(
      reconcileReasoningEffortLevels(
        {
          ...baseModel,
          ...(managedModel ?? {}),
          ...existingModel,
          enabled: existingModel.enabled
        },
        baseModel
      )
    )
  }

  if (managedModel) {
    return omitUnsupportedDisabledThinkingParams(
      reconcileReasoningEffortLevels(
        {
          ...baseModel,
          ...managedModel
        },
        baseModel
      )
    )
  }

  return omitUnsupportedDisabledThinkingParams(baseModel)
}

function createProviderFromPreset(preset: BuiltinProviderPreset): AIProvider {
  const managedModels = useProviderStore.getState().managedModels
  const models = preset.defaultModels.map((model) =>
    buildProviderModelSnapshot(model, {
      managedModel: getManagedModelFromCollection(managedModels, model.id) ?? null
    })
  )
  const defaultModel = preset.defaultModel
    ? (resolveModelIdByKey(models, preset.defaultModel) ?? preset.defaultModel)
    : undefined

  return {
    id: nanoid(),
    name: preset.name.trim(),
    type: preset.type,
    apiKey: '',
    baseUrl: preset.defaultBaseUrl.trim(),
    enabled: preset.defaultEnabled ?? false,
    models,
    builtinId: preset.builtinId,
    presetVersion: preset.version,
    createdAt: Date.now(),
    requiresApiKey: preset.requiresApiKey ?? true,
    ...(preset.useSystemProxy !== undefined ? { useSystemProxy: preset.useSystemProxy } : {}),
    ...(preset.userAgent ? { userAgent: preset.userAgent } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    authMode: preset.authMode ?? 'apiKey',
    ...(preset.oauthConfig ? { oauthConfig: { ...preset.oauthConfig } } : {}),
    ...(preset.channelConfig ? { channelConfig: { ...preset.channelConfig } } : {}),
    ...(preset.requestOverrides ? { requestOverrides: { ...preset.requestOverrides } } : {}),
    ...(preset.instructionsPrompt ? { instructionsPrompt: preset.instructionsPrompt } : {}),
    ...(preset.ui ? { ui: { ...preset.ui } } : {}),
    ...(preset.websocketUrl ? { websocketUrl: preset.websocketUrl } : {}),
    ...(preset.websocketMode ? { websocketMode: preset.websocketMode } : {})
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

// Providers whose native/server-side web search we can inject. Anthropic exposes
// the `web_search_20250305` server tool; the OpenAI Responses API exposes the
// `web_search` tool. Other protocols (openai-chat, gemini, images) have no
// drop-in equivalent. Speaking the protocol is not enough — many relay endpoints
// don't ship the server tool — so support is an explicit per-model opt-in.
export function modelSupportsBuiltinSearch(
  model: AIModelConfig | null | undefined,
  providerType?: ProviderType
): boolean {
  if (!model) return false
  const requestType = model.type ?? providerType
  return (
    (requestType === 'anthropic' || requestType === 'openai-responses') &&
    model.supportsBuiltinSearch === true
  )
}

export function isModelBuiltinSearchEnabled(
  model: AIModelConfig | null | undefined,
  providerType?: ProviderType
): boolean {
  return modelSupportsBuiltinSearch(model, providerType) && model?.enableBuiltinSearch === true
}

export function modelSupportsResponsesWebsocket(
  model: AIModelConfig | null | undefined,
  providerType?: ProviderType
): boolean {
  if (!model) return false
  const requestType = model.type ?? providerType
  return requestType === 'openai-responses' && model.supportsWebsocket === true
}

export function modelSupportsResponsesImageGeneration(
  model: AIModelConfig | null | undefined,
  providerType?: ProviderType
): boolean {
  if (!model) return false
  const requestType = model.type ?? providerType
  return requestType === 'openai-responses' && model.supportsImageGeneration === true
}

/**
 * Resolve the effective `image_generation` tool config for a request. Always returns an
 * explicit `enabled` flag for Responses models — the runtime treats a missing config as
 * enabled, so unsupported models must send `enabled: false` rather than nothing.
 */
export function resolveModelResponsesImageGeneration(
  model: AIModelConfig | null | undefined,
  providerType?: ProviderType
): ProviderConfig['responsesImageGeneration'] {
  const requestType = model?.type ?? providerType
  if (requestType !== 'openai-responses') return undefined
  return {
    ...normalizeResponsesImageGenerationConfig(model?.responsesImageGeneration),
    enabled:
      modelSupportsResponsesImageGeneration(model, providerType) &&
      isResponsesImageGenerationEnabled(model?.responsesImageGeneration)
  }
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
  if (requestType === 'gemini-interactions' || requestType === 'vertex-ai') {
    // Strip the OpenAI-compat suffix: both Gemini transports target the native surface.
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

/**
 * Body keys covering the max output tokens parameter across protocols:
 * openai-chat (max_tokens / max_completion_tokens), openai-responses (max_output_tokens),
 * anthropic (max_tokens), gemini (maxOutputTokens inside generationConfig).
 */
const MAX_OUTPUT_TOKENS_BODY_KEYS = [
  'max_tokens',
  'max_completion_tokens',
  'max_output_tokens',
  'maxOutputTokens'
]

function paramCarryOmitOverrides(
  provider: Pick<AIProvider, 'sendTemperature' | 'sendMaxOutputTokens'> | undefined
): RequestOverrides | undefined {
  if (!provider) return undefined
  const omitBodyKeys: string[] = []
  if (provider.sendTemperature === false) omitBodyKeys.push('temperature')
  if (provider.sendMaxOutputTokens === false) omitBodyKeys.push(...MAX_OUTPUT_TOKENS_BODY_KEYS)
  return omitBodyKeys.length > 0 ? { omitBodyKeys } : undefined
}

function buildRequestOverrides(
  providerOverrides: RequestOverrides | undefined,
  modelOverrides: RequestOverrides | undefined,
  modelId?: string,
  paramCarry?: Pick<AIProvider, 'sendTemperature' | 'sendMaxOutputTokens'>
): RequestOverrides | undefined {
  const merged = mergeRequestOverrides(
    providerOverrides,
    modelOverrides,
    paramCarryOmitOverrides(paramCarry)
  )
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

function resolveProviderAccountId(provider: AIProvider): string | undefined {
  const accountId = provider.oauth?.accountId?.trim()
  return accountId ? accountId : undefined
}

/**
 * Reads the global request timeout so every provider config carries it to the runtime.
 * Read at build time rather than captured, so changing the setting affects the next request.
 */
function resolveRequestTimeoutSeconds(): number {
  return clampApiRequestTimeoutSeconds(useSettingsStore.getState().apiRequestTimeoutSeconds)
}

function resolveResponsesWebsocket(
  model: AIModelConfig | null | undefined,
  provider: AIProvider,
  requestType: ProviderType
): Pick<ProviderConfig, 'websocketUrl' | 'websocketMode'> {
  if (requestType !== 'openai-responses') return {}
  if (!modelSupportsResponsesWebsocket(model, requestType)) {
    // Explicit 'disabled' so a provider-level default can't re-enable the transport downstream.
    return { websocketMode: 'disabled' }
  }
  return {
    websocketUrl: model?.websocketUrl ?? provider.websocketUrl,
    websocketMode: model?.websocketMode ?? provider.websocketMode
  }
}

function mergeBuiltinModels(
  existingModels: AIModelConfig[],
  presetModels: AIModelConfig[],
  managedModels: ManagedModelConfig[],
  deprecatedModelIds: string[] = []
): AIModelConfig[] {
  const existingByKey = new Map(
    existingModels.map((model) => [normalizeModelKey(model.id), model] as const)
  )
  const presetKeys = new Set(presetModels.map((model) => normalizeModelKey(model.id)))
  const deprecatedKeys = new Set(deprecatedModelIds.map((modelId) => normalizeModelKey(modelId)))

  const merged = presetModels.map((presetModel) => {
    const modelKey = normalizeModelKey(presetModel.id)
    return buildProviderModelSnapshot(presetModel, {
      managedModel: getManagedModelFromCollection(managedModels, presetModel.id) ?? null,
      existingModel: existingByKey.get(modelKey) ?? null
    })
  })

  for (const existingModel of existingModels) {
    const modelKey = normalizeModelKey(existingModel.id)
    if (!presetKeys.has(modelKey) && !deprecatedKeys.has(modelKey)) {
      merged.push(existingModel)
    }
  }

  return merged
}

function restoreBuiltinProviderModels(
  provider: AIProvider,
  preset: BuiltinProviderPreset
): AIProvider {
  const existingByKey = new Map(
    provider.models.map((model) => [normalizeModelKey(model.id), model] as const)
  )
  const presetKeys = new Set(preset.defaultModels.map((model) => normalizeModelKey(model.id)))
  const deprecatedKeys = new Set(
    (preset.deprecatedModelIds ?? []).map((modelId) => normalizeModelKey(modelId))
  )
  const models = preset.defaultModels.map((presetModel) => {
    const existingModel = existingByKey.get(normalizeModelKey(presetModel.id))
    const restoredModel = omitUnsupportedDisabledThinkingParams(cloneModelConfig(presetModel))
    return existingModel ? { ...restoredModel, enabled: existingModel.enabled } : restoredModel
  })

  for (const existingModel of provider.models) {
    const modelKey = normalizeModelKey(existingModel.id)
    if (!presetKeys.has(modelKey) && !deprecatedKeys.has(modelKey)) {
      models.push(existingModel)
    }
  }

  return { ...provider, models, presetVersion: preset.version }
}

function upgradeBuiltinProviderFromPreset(
  provider: AIProvider,
  preset: BuiltinProviderPreset
): AIProvider {
  const restored = restoreBuiltinProviderModels(provider, preset)
  const defaultModel = preset.defaultModel
    ? (resolveModelIdByKey(restored.models, preset.defaultModel) ?? preset.defaultModel)
    : undefined

  // Keep credentials and authentication state from the persisted provider, but let the newer
  // built-in preset own its endpoint, protocol, defaults, and built-in model specifications.
  return {
    ...restored,
    name: preset.name.trim(),
    type: preset.type,
    baseUrl: preset.defaultBaseUrl.trim(),
    requiresApiKey: preset.requiresApiKey ?? true,
    useSystemProxy: preset.useSystemProxy,
    userAgent: preset.userAgent,
    defaultModel,
    authMode: preset.authMode ?? 'apiKey',
    oauthConfig: preset.oauthConfig ? cloneValue(preset.oauthConfig) : undefined,
    channelConfig: preset.channelConfig ? cloneValue(preset.channelConfig) : undefined,
    requestOverrides: preset.requestOverrides ? cloneValue(preset.requestOverrides) : undefined,
    instructionsPrompt: preset.instructionsPrompt,
    ui: preset.ui ? cloneValue(preset.ui) : undefined,
    websocketUrl: preset.websocketUrl,
    websocketMode: preset.websocketMode
  }
}

function resolveProviderDefaultModelId(provider: AIProvider): string {
  const defaultModelId = provider.defaultModel
    ? resolveModelIdByKey(provider.models, provider.defaultModel)
    : undefined
  const defaultModel = defaultModelId
    ? provider.models.find((model) => model.id === defaultModelId)
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
  const defaultModelId = provider.defaultModel
    ? resolveModelIdByKey(provider.models, provider.defaultModel)
    : undefined
  const defaultModel = defaultModelId
    ? provider.models.find((model) => model.id === defaultModelId)
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
  const currentModelId = resolveModelIdByKey(provider.models, modelId)
  const current = currentModelId
    ? provider.models.find((model) => model.id === currentModelId)
    : null
  if (current && current.enabled && (current.category ?? 'chat') === category) {
    return current.id
  }
  return resolveProviderDefaultModelIdByCategory(provider, category)
}

// --- Store ---

interface ProviderStore {
  providers: AIProvider[]
  managedModels: ManagedModelConfig[]
  managedModelTombstones: string[]
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
  addManagedModel: (model: AIModelConfig) => void
  updateManagedModel: (modelId: string, model: AIModelConfig) => void
  removeManagedModel: (modelId: string) => void
  /** Restore global defaults and matching built-in provider copies without touching credentials. */
  resetModelConfigurationToDefaults: () => void
  getManagedModelById: (modelId: string) => ManagedModelConfig | null
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
  /** Build the globally configured context-compression provider, if available. */
  getCompressionProviderConfig: () => ProviderConfig | null
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

  const hasExplicitFastSelection = Boolean(state.activeFastProviderId || state.activeFastModelId)
  const explicitFastSelection = hasExplicitFastSelection
    ? resolveProviderSelectionByCategory(
        providers,
        state.activeFastProviderId ?? mainSelection.providerId,
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
          mainSelection.modelId,
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
      managedModels: [],
      managedModelTombstones: [],
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

      addManagedModel: (model) =>
        set((state) => {
          const nextModel = toManagedModelConfig(model)
          const managedModels = sortManagedModels([
            ...state.managedModels.filter((item) => item.normalizedKey !== nextModel.normalizedKey),
            nextModel
          ])
          return {
            managedModels,
            managedModelTombstones: state.managedModelTombstones.filter(
              (item) => item !== nextModel.normalizedKey
            )
          }
        }),

      updateManagedModel: (modelId, model) =>
        set((state) => {
          const previousKey = normalizeModelKey(modelId)
          const nextModel = toManagedModelConfig(model)
          const managedModels = sortManagedModels([
            ...state.managedModels.filter(
              (item) =>
                item.normalizedKey !== previousKey && item.normalizedKey !== nextModel.normalizedKey
            ),
            nextModel
          ])
          const tombstones = new Set(state.managedModelTombstones)
          tombstones.delete(nextModel.normalizedKey)
          if (previousKey !== nextModel.normalizedKey) {
            tombstones.add(previousKey)
          }
          return {
            managedModels,
            managedModelTombstones: Array.from(tombstones)
          }
        }),

      removeManagedModel: (modelId) =>
        set((state) => {
          const modelKey = normalizeModelKey(modelId)
          const managedModels = state.managedModels.filter(
            (model) => model.normalizedKey !== modelKey
          )
          if (managedModels.length === state.managedModels.length) {
            return state
          }
          const tombstones = new Set(state.managedModelTombstones)
          tombstones.add(modelKey)
          return {
            managedModels,
            managedModelTombstones: Array.from(tombstones)
          }
        }),

      resetModelConfigurationToDefaults: () =>
        set((state) => {
          const managedModels = sortManagedModels(collectBuiltinManagedModels())
          const presetById = new Map(
            builtinProviderPresets.map((preset) => [preset.builtinId, preset] as const)
          )
          const providers = state.providers.map((provider) => {
            const preset = provider.builtinId ? presetById.get(provider.builtinId) : undefined
            return preset ? restoreBuiltinProviderModels(provider, preset) : provider
          })

          return {
            managedModels,
            managedModelTombstones: [],
            providers,
            ...buildNormalizedProviderState(state, providers)
          }
        }),

      getManagedModelById: (modelId) => {
        const modelKey = normalizeModelKey(modelId)
        return get().managedModels.find((model) => model.normalizedKey === modelKey) ?? null
      },

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
          activeModel?.id ?? activeModelId,
          provider
        )
        const { websocketUrl, websocketMode } = resolveResponsesWebsocket(
          activeModel,
          provider,
          requestType
        )
        const serviceTier = resolveServiceTier(activeModel, provider.builtinId)
        const accountId = resolveProviderAccountId(provider)
        const responsesImageGeneration = resolveModelResponsesImageGeneration(
          activeModel,
          requestType
        )
        return {
          type: requestType,
          apiKey: provider.apiKey,
          baseUrl: normalizedBaseUrl,
          model: activeModelId,
          category: activeModel?.category,
          providerId: provider.id,
          providerBuiltinId: provider.builtinId,
          computerUseEnabled: isModelComputerUseEnabled(activeModel, requestType),
          builtinSearchEnabled: isModelBuiltinSearchEnabled(activeModel, requestType),
          ...(serviceTier ? { serviceTier } : {}),
          requiresApiKey: provider.requiresApiKey,
          ...(provider.useSystemProxy !== undefined
            ? { useSystemProxy: provider.useSystemProxy }
            : {}),
          ...(provider.allowInsecureTls !== undefined
            ? { allowInsecureTls: provider.allowInsecureTls }
            : {}),
          requestTimeoutSeconds: resolveRequestTimeoutSeconds(),
          responseSummary: activeModel?.responseSummary,
          ...(responsesImageGeneration ? { responsesImageGeneration } : {}),
          enablePromptCache: activeModel?.enablePromptCache,
          enableSystemPromptCache: activeModel?.enableSystemPromptCache,
          cacheTtl: activeModel?.cacheTtl ?? provider.cacheTtl,
          userAgent: resolveProviderUserAgent(provider.userAgent),
          ...(requestOverrides ? { requestOverrides } : {}),
          ...(provider.instructionsPrompt
            ? { instructionsPrompt: provider.instructionsPrompt }
            : {}),
          ...(accountId ? { accountId } : {}),
          ...(activeModel?.thinkingConfig ? { thinkingConfig: activeModel.thinkingConfig } : {}),
          ...(websocketUrl ? { websocketUrl } : {}),
          ...(websocketMode ? { websocketMode } : {})
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
          model?.id ?? resolvedModelId,
          provider
        )
        const { websocketUrl, websocketMode } = resolveResponsesWebsocket(
          model,
          provider,
          requestType
        )
        const serviceTier = resolveServiceTier(model, provider.builtinId)
        const accountId = resolveProviderAccountId(provider)
        const responsesImageGeneration = resolveModelResponsesImageGeneration(model, requestType)
        return {
          type: requestType,
          apiKey: provider.apiKey,
          baseUrl: normalizedBaseUrl,
          model: resolvedModelId,
          category: model?.category,
          providerId: provider.id,
          providerBuiltinId: provider.builtinId,
          computerUseEnabled: isModelComputerUseEnabled(model, requestType),
          builtinSearchEnabled: isModelBuiltinSearchEnabled(model, requestType),
          ...(serviceTier ? { serviceTier } : {}),
          requiresApiKey: provider.requiresApiKey,
          ...(provider.useSystemProxy !== undefined
            ? { useSystemProxy: provider.useSystemProxy }
            : {}),
          ...(provider.allowInsecureTls !== undefined
            ? { allowInsecureTls: provider.allowInsecureTls }
            : {}),
          requestTimeoutSeconds: resolveRequestTimeoutSeconds(),
          responseSummary: model?.responseSummary,
          ...(responsesImageGeneration ? { responsesImageGeneration } : {}),
          enablePromptCache: model?.enablePromptCache,
          enableSystemPromptCache: model?.enableSystemPromptCache,
          cacheTtl: model?.cacheTtl ?? provider.cacheTtl,
          userAgent: resolveProviderUserAgent(provider.userAgent),
          ...(requestOverrides ? { requestOverrides } : {}),
          ...(provider.instructionsPrompt
            ? { instructionsPrompt: provider.instructionsPrompt }
            : {}),
          ...(accountId ? { accountId } : {}),
          ...(model?.thinkingConfig ? { thinkingConfig: model.thinkingConfig } : {}),
          ...(websocketUrl ? { websocketUrl } : {}),
          ...(websocketMode ? { websocketMode } : {})
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
        const hasExplicitFastSelection = Boolean(activeFastProviderId || activeFastModelId)
        const explicitFastSelection = hasExplicitFastSelection
          ? resolveProviderSelectionByCategory(
              providers,
              activeFastProviderId ?? activeProviderId,
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
                activeModelId,
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
        const { websocketUrl, websocketMode } = resolveResponsesWebsocket(
          fastModel,
          provider,
          requestType
        )
        const serviceTier = resolveServiceTier(fastModel, provider.builtinId)
        const accountId = resolveProviderAccountId(provider)
        const responsesImageGeneration = resolveModelResponsesImageGeneration(
          fastModel,
          requestType
        )
        return {
          type: requestType,
          apiKey: provider.apiKey,
          baseUrl: normalizedBaseUrl,
          model,
          providerId: provider.id,
          providerBuiltinId: provider.builtinId,
          computerUseEnabled: isModelComputerUseEnabled(fastModel, requestType),
          builtinSearchEnabled: isModelBuiltinSearchEnabled(fastModel, requestType),
          ...(serviceTier ? { serviceTier } : {}),
          requiresApiKey: provider.requiresApiKey,
          ...(provider.useSystemProxy !== undefined
            ? { useSystemProxy: provider.useSystemProxy }
            : {}),
          ...(provider.allowInsecureTls !== undefined
            ? { allowInsecureTls: provider.allowInsecureTls }
            : {}),
          requestTimeoutSeconds: resolveRequestTimeoutSeconds(),
          responseSummary: fastModel?.responseSummary,
          ...(responsesImageGeneration ? { responsesImageGeneration } : {}),
          enablePromptCache: fastModel?.enablePromptCache,
          enableSystemPromptCache: fastModel?.enableSystemPromptCache,
          cacheTtl: fastModel?.cacheTtl ?? provider.cacheTtl,
          userAgent: resolveProviderUserAgent(provider.userAgent),
          ...(requestOverrides ? { requestOverrides } : {}),
          ...(provider.instructionsPrompt
            ? { instructionsPrompt: provider.instructionsPrompt }
            : {}),
          ...(accountId ? { accountId } : {}),
          ...(websocketUrl ? { websocketUrl } : {}),
          ...(websocketMode ? { websocketMode } : {})
        }
      },

      getCompressionProviderConfig: () => {
        const binding = useSettingsStore.getState().contextCompressionModel
        if (!binding) return null

        const provider = get().providers.find((item) => item.id === binding.providerId)
        const model = provider?.models.find((item) => item.id === binding.modelId)
        if (
          !isProviderAvailableForModelSelection(provider) ||
          !model?.enabled ||
          (model.category ?? 'chat') !== 'chat'
        ) {
          return null
        }

        return get().getProviderConfigById(binding.providerId, binding.modelId)
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
      storage: createJSONStorage(() => aiProviderStorage),
      partialize: (state) => ({
        providers: state.providers,
        managedModels: state.managedModels,
        managedModelTombstones: state.managedModelTombstones,
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

function syncManagedModelsWithBuiltins(): void {
  const state = useProviderStore.getState()
  const builtinModels = collectBuiltinManagedModels()
  if (builtinModels.length === 0) return

  const tombstones = new Set(state.managedModelTombstones)
  const managedModels = state.managedModels.map((model) => cloneManagedModelConfig(model))
  const managedIndexes = new Map(
    managedModels.map((model, index) => [model.normalizedKey, index] as const)
  )
  let changed = false

  for (const builtinModel of builtinModels) {
    if (tombstones.has(builtinModel.normalizedKey)) {
      continue
    }

    const existingIndex = managedIndexes.get(builtinModel.normalizedKey)
    if (existingIndex === undefined) {
      managedIndexes.set(builtinModel.normalizedKey, managedModels.length)
      managedModels.push(cloneManagedModelConfig(builtinModel))
      changed = true
      continue
    }

    const result = mergeManagedModelMissingFields(managedModels[existingIndex], builtinModel)
    const reconciled = reconcileReasoningEffortLevels(result.model, builtinModel)
    if (result.changed || reconciled !== result.model) {
      managedModels[existingIndex] = reconciled
      changed = true
    }
  }

  if (changed) {
    useProviderStore.setState({ managedModels: sortManagedModels(managedModels) })
  }
}

/**
 * Migrate legacy single-account OAuth providers to the new multi-account shape.
 * Runs once per rehydration before we touch presets, so the rest of the store
 * can assume `oauthAccounts`/`activeAccountId` exist whenever `authMode === 'oauth'`
 * and a token is present.
 */
function migrateLegacyOAuthProviders(): void {
  const state = useProviderStore.getState()
  let changed = false
  const nextProviders = state.providers.map((provider) => {
    if (provider.authMode !== 'oauth') return provider
    if (provider.oauthAccounts && provider.oauthAccounts.length > 0) return provider
    const token = provider.oauth
    if (!token?.accessToken) return provider

    // Synthesize a single account from the legacy top-level token.
    // Email fallback order: accountId → id_token email claim → placeholder.
    let email = token.accountId?.trim() || ''
    if (!email && token.idToken && token.idToken.split('.').length === 3) {
      try {
        const payload = token.idToken.split('.')[1]
        const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
        const data = JSON.parse(json) as Record<string, unknown>
        const claim = data.email
        if (typeof claim === 'string' && claim.trim()) email = claim.trim()
      } catch {
        // ignore
      }
    }
    if (!email) email = 'unknown@local'

    const account = {
      id: nanoid(),
      email,
      oauth: { ...token },
      createdAt: Date.now()
    }
    changed = true
    return {
      ...provider,
      oauthAccounts: [account],
      activeAccountId: account.id
    }
  })
  if (changed) {
    useProviderStore.setState({ providers: nextProviders })
  }
}

/**
 * Move providers off the removed `gemini` (generateContent) protocol onto the Interactions
 * API. Built-in Google is already handled by the preset version bump, so this only rescues
 * user-created providers, which would otherwise point at a protocol that no longer exists.
 * Vertex AI is untouched: it has no Interactions endpoint.
 */
function migrateLegacyGeminiProviders(): void {
  const state = useProviderStore.getState()
  let changed = false
  const nextProviders = state.providers.map((provider) => {
    const legacyType = provider.type as ProviderType | 'gemini'
    if (legacyType !== 'gemini') return provider
    changed = true
    return {
      ...provider,
      type: 'gemini-interactions' as ProviderType,
      baseUrl: normalizeProviderBaseUrl(provider.baseUrl, 'gemini-interactions'),
      models: provider.models.map((model) =>
        (model.type as ProviderType | 'gemini' | undefined) === 'gemini'
          ? { ...model, type: 'gemini-interactions' as ProviderType }
          : model
      )
    }
  })
  if (changed) {
    useProviderStore.setState({ providers: nextProviders })
  }
}

/**
 * Ensure built-in presets exist and pick a default active provider.
 * Safe to call multiple times — idempotent.
 */
function ensureBuiltinPresets(): void {
  removeLegacyModelCompressionThresholds()
  migrateLegacyOAuthProviders()
  migrateLegacyGeminiProviders()
  const currentProviders = useProviderStore.getState().providers
  const upgradedPresets = builtinProviderPresets.filter((preset) => {
    const existing = currentProviders.find((provider) => provider.builtinId === preset.builtinId)
    return Boolean(existing && preset.version > normalizePresetVersion(existing.presetVersion))
  })

  if (upgradedPresets.length > 0) {
    const state = useProviderStore.getState()
    useProviderStore.setState(
      replaceManagedModelsForUpgradedPresets(
        state.managedModels,
        state.managedModelTombstones,
        upgradedPresets
      )
    )
  }
  // Add models from other presets without overwriting their locally managed values.
  syncManagedModelsWithBuiltins()

  for (const preset of builtinProviderPresets) {
    const existing = useProviderStore
      .getState()
      .providers.find((p) => p.builtinId === preset.builtinId)

    if (!existing) {
      const provider = createProviderFromPreset(preset)
      useProviderStore.getState().addProvider(provider)
    } else {
      const localPresetVersion = normalizePresetVersion(existing.presetVersion)
      if (preset.version > localPresetVersion) {
        const upgraded = upgradeBuiltinProviderFromPreset(existing, preset)
        const { id: _id, ...patch } = upgraded
        void _id
        useProviderStore.getState().updateProvider(existing.id, patch)
        continue
      }

      // Never downgrade persisted built-in configuration when an older app is opened.
      if (localPresetVersion > preset.version) {
        continue
      }

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
      if (existing.websocketUrl !== preset.websocketUrl) {
        patch.websocketUrl = preset.websocketUrl
      }
      if (existing.websocketMode !== preset.websocketMode) {
        patch.websocketMode = preset.websocketMode
      }
      if (preset.instructionsPrompt && existing.instructionsPrompt !== preset.instructionsPrompt) {
        patch.instructionsPrompt = preset.instructionsPrompt
      } else if (preset.builtinId === 'codex-oauth' && existing.instructionsPrompt !== undefined) {
        patch.instructionsPrompt = undefined
      }
      if (existing.authMode !== (preset.authMode ?? 'apiKey')) {
        patch.authMode = preset.authMode ?? 'apiKey'
      }
      if (
        preset.builtinId === 'codex-oauth' ||
        preset.builtinId === 'copilot-oauth' ||
        preset.builtinId === 'moonshot-coding'
      ) {
        const trimmedBaseUrl = existing.baseUrl.trim().replace(/\/+$/, '')
        if (
          !trimmedBaseUrl ||
          trimmedBaseUrl === 'https://api.openai.com/v1' ||
          trimmedBaseUrl === 'https://api.openai.com' ||
          trimmedBaseUrl === 'https://api.kimi.com/coding'
        ) {
          patch.baseUrl = preset.defaultBaseUrl
        }
      }
      if (preset.builtinId === 'longcat') {
        const trimmedBaseUrl = existing.baseUrl.trim().replace(/\/+$/, '')
        if (
          !trimmedBaseUrl ||
          trimmedBaseUrl === 'https://api.longcat.chat/openai' ||
          trimmedBaseUrl === 'https://api.longcat.chat/openai/v1/chat/completions' ||
          trimmedBaseUrl === 'https://api.longcat.chat/anthropic' ||
          trimmedBaseUrl === 'https://api.longcat.chat/anthropic/v1' ||
          trimmedBaseUrl === 'https://api.longcat.chat/anthropic/v1/messages'
        ) {
          patch.baseUrl = preset.defaultBaseUrl
        }
      }
      if (preset.oauthConfig) {
        if (preset.builtinId === 'codex-oauth' || preset.builtinId === 'moonshot-coding') {
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
        if (preset.builtinId === 'codex-oauth' || preset.builtinId === 'moonshot-coding') {
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
      const updatedModels = mergeBuiltinModels(
        existing.models,
        preset.defaultModels,
        useProviderStore.getState().managedModels,
        preset.deprecatedModelIds
      )
      const resolvedDefaultModel = preset.defaultModel
        ? (resolveModelIdByKey(updatedModels, preset.defaultModel) ?? preset.defaultModel)
        : undefined
      if (existing.defaultModel !== resolvedDefaultModel) {
        patch.defaultModel = resolvedDefaultModel
      }
      if (existing.type !== preset.type) {
        patch.type = preset.type
      }
      if (Object.keys(patch).length > 0) {
        useProviderStore.getState().updateProvider(existing.id, patch)
      }

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
    Boolean(defaultFastSelection) && !state.activeFastProviderId && !state.activeFastModelId
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
        if (!state.activeFastProviderId && state.activeFastModelId) {
          useProviderStore.setState({ activeFastProviderId: fastProvider.id })
        }
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

function removeLegacyModelCompressionThresholds(): void {
  const state = useProviderStore.getState()
  const activeModel = state.providers
    .find((provider) => provider.id === state.activeProviderId)
    ?.models.find((model) => model.id === state.activeModelId) as
    | (AIModelConfig & { contextCompressionThreshold?: unknown })
    | undefined
  if (
    typeof activeModel?.contextCompressionThreshold === 'number' &&
    Number.isFinite(activeModel.contextCompressionThreshold)
  ) {
    useSettingsStore.getState().updateSettings({
      contextCompressionThreshold: Math.min(
        0.9,
        Math.max(0.3, activeModel.contextCompressionThreshold)
      )
    })
  }

  let changed = false
  const stripLegacyThreshold = <T extends AIModelConfig>(model: T): T => {
    const copy = { ...model } as T & { contextCompressionThreshold?: unknown }
    if (!Object.prototype.hasOwnProperty.call(copy, 'contextCompressionThreshold')) return model
    delete copy.contextCompressionThreshold
    changed = true
    return copy
  }
  const providers = state.providers.map((provider) => ({
    ...provider,
    models: provider.models.map(stripLegacyThreshold)
  }))
  const managedModels = state.managedModels.map(stripLegacyThreshold)
  if (changed) {
    useProviderStore.setState({ providers, managedModels })
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
