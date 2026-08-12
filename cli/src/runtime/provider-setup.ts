import { randomUUID } from 'node:crypto'
import type {
  ModelSelection,
  ProviderSetupCatalog,
  ProviderSetupInput,
  ProviderSetupOption,
  ProviderSetupProtocol
} from '../types.js'
import {
  OPENCOWORK_DEVICE_LOGIN_URL,
  classifyRoutinCredential
} from '../vendor/routin-credential.js'
import {
  isRecord,
  loadOpenCoworkConfiguration,
  persistProviderStoreState,
  stringValue,
  type JsonRecord
} from './provider-catalog.js'

export { OPENCOWORK_DEVICE_LOGIN_URL }

interface QuickProviderPreset {
  apiKeyUrl?: string
  baseUrl: string
  builtinId: string
  defaultModel: JsonRecord
  description: string
  name: string
  providerType: ProviderSetupProtocol
  /** Proposed first when nothing is configured yet. Exactly one preset carries this flag. */
  recommended?: boolean
  requiresApiKey?: boolean
}

const quickProviderPresets: QuickProviderPreset[] = [
  {
    apiKeyUrl: OPENCOWORK_DEVICE_LOGIN_URL,
    baseUrl: 'https://api.routin.ai/v1',
    builtinId: 'routin-ai',
    defaultModel: {
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 384_000,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { enable_thinking: true },
        disabledBodyParams: { enable_thinking: false }
      }
    },
    description: 'One API key for GPT, Claude, Gemini, DeepSeek and more',
    name: 'Routin AI',
    providerType: 'openai-chat',
    recommended: true
  },
  {
    apiKeyUrl: OPENCOWORK_DEVICE_LOGIN_URL,
    baseUrl: 'https://api.routin.ai/plan/v1',
    builtinId: 'routin-ai-plan',
    defaultModel: {
      id: 'gpt-5.5',
      name: 'GPT 5.5',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: true,
      supportsThinking: true
    },
    description: 'Routin subscription plan · GPT and Claude models',
    name: 'Routin AI（套餐）',
    providerType: 'openai-chat'
  },
  {
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    baseUrl: 'https://api.openai.com/v1',
    builtinId: 'openai',
    defaultModel: {
      id: 'gpt-5.2',
      name: 'GPT-5.2',
      enabled: true,
      type: 'openai-responses',
      contextLength: 400_000,
      maxOutputTokens: 64_384,
      supportsVision: true,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      }
    },
    description: 'OpenAI API · Responses protocol',
    name: 'OpenAI',
    providerType: 'openai-chat'
  },
  {
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    baseUrl: 'https://api.anthropic.com',
    builtinId: 'anthropic',
    defaultModel: {
      id: 'claude-sonnet-5',
      name: 'Claude Sonnet 5',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'adaptive' } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high', 'max'],
        defaultReasoningEffort: 'high'
      }
    },
    description: 'Anthropic API · Messages protocol',
    name: 'Anthropic',
    providerType: 'anthropic'
  },
  {
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    baseUrl: 'https://api.deepseek.com/v1',
    builtinId: 'deepseek',
    defaultModel: {
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 384_000,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { enable_thinking: true },
        disabledBodyParams: { enable_thinking: false }
      }
    },
    description: 'DeepSeek API · OpenAI Chat compatible',
    name: 'DeepSeek',
    providerType: 'openai-chat'
  },
  {
    apiKeyUrl: 'https://aistudio.google.com/apikey',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    builtinId: 'google',
    defaultModel: {
      id: 'gemini-3.5-flash',
      name: 'Gemini 3.5 Flash',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking_level: 'medium' },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    description: 'Google AI API · Interactions protocol',
    name: 'Google Gemini',
    providerType: 'gemini-interactions'
  },
  {
    apiKeyUrl: 'https://openrouter.ai/keys',
    baseUrl: 'https://openrouter.ai/api/v1',
    builtinId: 'openrouter',
    defaultModel: {
      id: 'anthropic/claude-sonnet-5',
      name: 'Claude Sonnet 5',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: true
    },
    description: 'OpenRouter · Multi-provider OpenAI-compatible API',
    name: 'OpenRouter',
    providerType: 'openai-chat'
  },
  {
    apiKeyUrl: 'https://cloud.siliconflow.cn/account/ak',
    baseUrl: 'https://api.siliconflow.cn/v1',
    builtinId: 'siliconflow',
    defaultModel: {
      id: 'deepseek-ai/DeepSeek-V4-Flash',
      name: 'DeepSeek V4 Flash',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 8_192,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: { bodyParams: { enable_thinking: true } }
    },
    description: 'SiliconFlow · OpenAI-compatible API',
    name: 'SiliconFlow',
    providerType: 'openai-chat'
  },
  {
    baseUrl: 'http://localhost:11434/v1',
    builtinId: 'ollama',
    defaultModel: { id: '', name: '', enabled: true, supportsFunctionCall: true },
    description: 'Local Ollama server · no API key required',
    name: 'Ollama',
    providerType: 'openai-chat',
    requiresApiKey: false
  }
]

const customProviderOptions: ProviderSetupOption[] = [
  {
    baseUrl: '',
    defaultModelId: '',
    description: 'Add an OpenAI Chat Completions compatible endpoint',
    hasApiKey: false,
    key: 'new:openai-chat',
    name: 'Custom OpenAI Chat',
    providerType: 'openai-chat',
    requiresApiKey: true,
    source: 'custom'
  },
  {
    baseUrl: '',
    defaultModelId: '',
    description: 'Add a local OpenAI-compatible endpoint without authentication',
    hasApiKey: false,
    key: 'new:openai-chat-no-key',
    name: 'Custom Local OpenAI',
    providerType: 'openai-chat',
    requiresApiKey: false,
    source: 'custom'
  },
  {
    baseUrl: '',
    defaultModelId: '',
    description: 'Add an OpenAI Responses compatible endpoint',
    hasApiKey: false,
    key: 'new:openai-responses',
    name: 'Custom OpenAI Responses',
    providerType: 'openai-responses',
    requiresApiKey: true,
    source: 'custom'
  },
  {
    baseUrl: '',
    defaultModelId: '',
    description: 'Add an Anthropic Messages compatible endpoint',
    hasApiKey: false,
    key: 'new:anthropic',
    name: 'Custom Anthropic',
    providerType: 'anthropic',
    requiresApiKey: true,
    source: 'custom'
  },
  {
    baseUrl: '',
    defaultModelId: '',
    description: 'Add a Google Interactions compatible endpoint',
    hasApiKey: false,
    key: 'new:gemini-interactions',
    name: 'Custom Gemini',
    providerType: 'gemini-interactions',
    requiresApiKey: true,
    source: 'custom'
  }
]

function isProviderProtocol(value: string): value is ProviderSetupProtocol {
  return (
    value === 'anthropic' ||
    value === 'gemini-interactions' ||
    value === 'openai-chat' ||
    value === 'openai-responses'
  )
}

function providerModels(provider: JsonRecord): JsonRecord[] {
  return (Array.isArray(provider.models) ? provider.models.filter(isRecord) : []).filter(
    (model) => (stringValue(model.category) || 'chat') === 'chat'
  )
}

function resolveDefaultModel(provider: JsonRecord, activeModelId: string): JsonRecord | null {
  const models = providerModels(provider)
  const candidates = [
    activeModelId,
    stringValue(provider.defaultModel),
    stringValue(models.find((model) => model.enabled === true)?.id),
    stringValue(models[0]?.id)
  ]
  for (const modelId of candidates) {
    if (!modelId) continue
    const model = models.find((candidate) => stringValue(candidate.id) === modelId)
    if (model) return model
  }
  return null
}

function toExistingOption(
  provider: JsonRecord,
  activeProviderId: string,
  activeModelId: string,
  quickPreset?: QuickProviderPreset
): ProviderSetupOption | null {
  const providerId = stringValue(provider.id)
  const providerType = stringValue(provider.type)
  const authMode = stringValue(provider.authMode) || 'apiKey'
  if (!providerId || !isProviderProtocol(providerType) || authMode !== 'apiKey') return null

  const model = resolveDefaultModel(provider, providerId === activeProviderId ? activeModelId : '')
  const rawModelType = stringValue(model?.type) || stringValue(quickPreset?.defaultModel.type)
  const modelType = isProviderProtocol(rawModelType) ? rawModelType : undefined
  const requiresApiKey = provider.requiresApiKey !== false
  const hasApiKey = Boolean(stringValue(provider.apiKey).trim())
  const ready = provider.enabled === true && (!requiresApiKey || hasApiKey) && Boolean(model)
  const builtinId = stringValue(provider.builtinId) || undefined

  return {
    ...(quickPreset?.apiKeyUrl ? { apiKeyUrl: quickPreset.apiKeyUrl } : {}),
    baseUrl: stringValue(provider.baseUrl) || quickPreset?.baseUrl || '',
    ...(builtinId ? { builtinId } : {}),
    defaultModelId: stringValue(model?.id) || stringValue(quickPreset?.defaultModel.id),
    description: `${ready ? 'Ready' : hasApiKey || !requiresApiKey ? 'Disabled' : 'Needs API key'} · ${providerType}`,
    hasApiKey,
    key: quickPreset ? `builtin:${quickPreset.builtinId}` : `existing:${providerId}`,
    ...(modelType ? { modelType } : {}),
    name: stringValue(provider.name) || quickPreset?.name || providerId,
    providerId,
    providerType,
    ...(quickPreset?.recommended ? { recommended: true } : {}),
    requiresApiKey,
    source: 'existing'
  }
}

function toPresetOption(preset: QuickProviderPreset): ProviderSetupOption {
  const rawModelType = stringValue(preset.defaultModel.type)
  return {
    ...(preset.apiKeyUrl ? { apiKeyUrl: preset.apiKeyUrl } : {}),
    baseUrl: preset.baseUrl,
    builtinId: preset.builtinId,
    defaultModelId: stringValue(preset.defaultModel.id),
    description: preset.description,
    hasApiKey: false,
    key: `builtin:${preset.builtinId}`,
    ...(isProviderProtocol(rawModelType) ? { modelType: rawModelType } : {}),
    name: preset.name,
    providerType: preset.providerType,
    ...(preset.recommended ? { recommended: true } : {}),
    requiresApiKey: preset.requiresApiKey !== false,
    source: 'preset'
  }
}

export function loadProviderSetupCatalog(): ProviderSetupCatalog {
  const configuration = loadOpenCoworkConfiguration()
  const providers = Array.isArray(configuration.providerStore.providers)
    ? configuration.providerStore.providers.filter(isRecord)
    : []
  const activeProviderId = stringValue(configuration.providerStore.activeProviderId)
  const activeModelId = stringValue(configuration.providerStore.activeModelId)
  const presetByBuiltinId = new Map(
    quickProviderPresets.map((preset) => [preset.builtinId, preset])
  )
  const existingOptions = providers
    .map((provider) => {
      const preset = presetByBuiltinId.get(stringValue(provider.builtinId))
      return toExistingOption(provider, activeProviderId, activeModelId, preset)
    })
    .filter((option): option is ProviderSetupOption => Boolean(option))
  const existingKeys = new Set(existingOptions.map((option) => option.key))
  const occupiedBuiltinIds = new Set(
    providers.map((provider) => stringValue(provider.builtinId)).filter(Boolean)
  )
  const presetOrder = new Map(
    quickProviderPresets.map((preset, index) => [`builtin:${preset.builtinId}`, index])
  )

  existingOptions.sort((left, right) => {
    const leftOrder = presetOrder.get(left.key) ?? Number.MAX_SAFE_INTEGER
    const rightOrder = presetOrder.get(right.key) ?? Number.MAX_SAFE_INTEGER
    return leftOrder - rightOrder || left.name.localeCompare(right.name)
  })

  const presetOptions = quickProviderPresets
    .map(toPresetOption)
    .filter(
      (option) =>
        !existingKeys.has(option.key) &&
        (!option.builtinId || !occupiedBuiltinIds.has(option.builtinId))
    )
  const configuredCount = existingOptions.filter(
    (option) => option.hasApiKey || !option.requiresApiKey
  ).length
  const options = [
    ...existingOptions,
    ...presetOptions,
    ...customProviderOptions.map((item) => ({ ...item }))
  ]
  const recommended = options.find((option) => option.recommended && !option.hasApiKey)

  return {
    configuredCount,
    dataDirectory: configuration.dataDirectory,
    options,
    ...(recommended ? { recommendedKey: recommended.key } : {})
  }
}

function validateSingleLine(value: string, label: string, maxLength: number): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required.`)
  if (normalized.length > maxLength) throw new Error(`${label} is too long.`)
  if (/\p{Cc}/u.test(normalized)) throw new Error(`${label} contains control characters.`)
  return normalized
}

function validateBaseUrl(value: string): string {
  const normalized = validateSingleLine(value, 'Base URL', 2_048).replace(/\/+$/u, '')
  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw new Error('Base URL must be a valid http:// or https:// URL.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Base URL must use http:// or https://.')
  }
  if (parsed.username || parsed.password) {
    throw new Error('Base URL must not contain embedded credentials.')
  }
  return normalized
}

function quickPresetFor(option: ProviderSetupOption): QuickProviderPreset | undefined {
  return option.builtinId
    ? quickProviderPresets.find((preset) => preset.builtinId === option.builtinId)
    : undefined
}

function createModel(
  option: ProviderSetupOption,
  modelId: string,
  existingProvider: JsonRecord | undefined
): { models: JsonRecord[]; modelName: string } {
  const models = Array.isArray(existingProvider?.models)
    ? existingProvider.models.filter(isRecord)
    : []
  const existingModel = models.find((model) => stringValue(model.id) === modelId)
  if (existingModel && (stringValue(existingModel.category) || 'chat') !== 'chat') {
    throw new Error(`Model “${modelId}” is configured for a non-chat category.`)
  }

  const presetModel = quickPresetFor(option)?.defaultModel
  const matchesPreset = presetModel && stringValue(presetModel.id) === modelId
  const modelName =
    stringValue(existingModel?.name) ||
    (matchesPreset ? stringValue(presetModel.name) : '') ||
    modelId
  const modelType = option.modelType ?? option.providerType
  const nextModel: JsonRecord = existingModel
    ? { ...existingModel, enabled: true }
    : matchesPreset
      ? { ...presetModel, id: modelId, name: modelName, enabled: true }
      : {
          id: modelId,
          name: modelName,
          enabled: true,
          category: 'chat',
          contextLength: 128_000,
          maxOutputTokens: 32_000,
          supportsFunctionCall: true,
          ...(modelType !== option.providerType ? { type: modelType } : {})
        }

  const nextModels = existingModel
    ? models.map((model) => (stringValue(model.id) === modelId ? nextModel : model))
    : [...models, nextModel]
  return { models: nextModels, modelName }
}

/** Fingerprint of currently saved Routin wallet/plan keys (builtinId → apiKey). */
export function snapshotRoutinCredentials(): Record<string, string> {
  const configuration = loadOpenCoworkConfiguration()
  const providers = Array.isArray(configuration.providerStore.providers)
    ? configuration.providerStore.providers.filter(isRecord)
    : []
  const snapshot: Record<string, string> = {}
  for (const provider of providers) {
    const builtinId = stringValue(provider.builtinId)
    if (builtinId !== 'routin-ai' && builtinId !== 'routin-ai-plan') continue
    const apiKey = stringValue(provider.apiKey).trim()
    if (apiKey) snapshot[builtinId] = apiKey
  }
  return snapshot
}

function routinCredentialsChanged(
  previous: Record<string, string> | undefined,
  current: Record<string, string>
): boolean {
  if (!previous) return Object.keys(current).length > 0
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)])
  for (const key of keys) {
    if ((previous[key] ?? '') !== (current[key] ?? '')) return true
  }
  return false
}

/** Persist a Routin key received from the browser device-login localhost callback. */
export function applyRoutinDeviceLoginCredential(apiKey: string): ModelSelection {
  const classified = classifyRoutinCredential(apiKey)
  const catalog = loadProviderSetupCatalog()
  const option =
    catalog.options.find((candidate) => candidate.builtinId === classified.builtinId) ??
    catalog.options.find((candidate) => candidate.key === `builtin:${classified.builtinId}`)
  if (!option) {
    throw new Error(`Routin preset “${classified.builtinId}” is unavailable in provider setup.`)
  }
  return persistProviderSetup({
    optionKey: option.key,
    name: option.name,
    baseUrl: option.baseUrl || classified.baseUrl,
    modelId:
      option.defaultModelId ||
      (classified.builtinId === 'routin-ai-plan' ? 'gpt-5.5' : 'deepseek-v4-flash'),
    apiKey: apiKey.trim()
  })
}

/**
 * When the desktop deep-link (or a prior paste) already wrote a Routin provider into the
 * shared store, return its active selection so the CLI wizard can finish without re-entry.
 * Pass `previous` from `snapshotRoutinCredentials()` when re-login must wait for a change.
 */
export function findReadyRoutinSelection(options?: {
  previous?: Record<string, string>
  requireChange?: boolean
}): ModelSelection | null {
  const configuration = loadOpenCoworkConfiguration()
  const providers = Array.isArray(configuration.providerStore.providers)
    ? configuration.providerStore.providers.filter(isRecord)
    : []
  const activeProviderId = stringValue(configuration.providerStore.activeProviderId)
  const activeModelId = stringValue(configuration.providerStore.activeModelId)
  const ready = providers.filter((provider) => {
    const builtinId = stringValue(provider.builtinId)
    if (builtinId !== 'routin-ai' && builtinId !== 'routin-ai-plan') return false
    if (provider.enabled === false) return false
    return Boolean(stringValue(provider.apiKey).trim())
  })
  if (ready.length === 0) return null

  const current = snapshotRoutinCredentials()
  if (options?.requireChange && !routinCredentialsChanged(options.previous, current)) {
    return null
  }

  const preferred =
    ready.find((provider) => stringValue(provider.id) === activeProviderId) ?? ready[0]
  const model = resolveDefaultModel(
    preferred,
    stringValue(preferred.id) === activeProviderId ? activeModelId : ''
  )
  const modelId = stringValue(model?.id) || stringValue(preferred.defaultModel)
  if (!modelId) return null
  return {
    providerId: stringValue(preferred.id),
    providerName: stringValue(preferred.name) || stringValue(preferred.builtinId),
    modelId,
    modelName: stringValue(model?.name) || modelId
  }
}

export function persistProviderSetup(input: ProviderSetupInput): ModelSelection {
  const catalog = loadProviderSetupCatalog()
  let option = catalog.options.find((candidate) => candidate.key === input.optionKey)
  if (!option) throw new Error('The selected provider changed. Reopen provider setup and retry.')

  const enteredApiKey = input.apiKey?.trim() ?? ''
  // Pasted Routin credentials self-select wallet vs plan, even if the welcome flow started
  // on the recommended wallet preset.
  if (
    enteredApiKey &&
    (option.builtinId === 'routin-ai' ||
      option.builtinId === 'routin-ai-plan' ||
      option.key === catalog.recommendedKey)
  ) {
    const classified = classifyRoutinCredential(enteredApiKey)
    const matched =
      catalog.options.find((candidate) => candidate.builtinId === classified.builtinId) ??
      catalog.options.find((candidate) => candidate.key === `builtin:${classified.builtinId}`)
    if (matched) {
      const switchedBuiltin = option.builtinId !== matched.builtinId
      option = matched
      input = {
        ...input,
        optionKey: matched.key,
        name: matched.name,
        baseUrl: matched.baseUrl || classified.baseUrl,
        // When the key prefix moves us to another Routin preset, take that preset's
        // default model instead of keeping the previous wizard draft.
        modelId: switchedBuiltin
          ? matched.defaultModelId || input.modelId
          : input.modelId || matched.defaultModelId
      }
    }
  }

  const configuration = loadOpenCoworkConfiguration()
  const providers = Array.isArray(configuration.providerStore.providers)
    ? configuration.providerStore.providers.filter(isRecord)
    : []
  const existingProvider = option.providerId
    ? providers.find((provider) => stringValue(provider.id) === option.providerId)
    : option.builtinId
      ? providers.find((provider) => stringValue(provider.builtinId) === option.builtinId)
      : undefined
  const name = validateSingleLine(input.name, 'Provider name', 100)
  const baseUrl = validateBaseUrl(input.baseUrl)
  const modelId = validateSingleLine(input.modelId, 'Model ID', 300)
  if (/\s/u.test(modelId)) throw new Error('Model ID must not contain whitespace.')

  if (enteredApiKey.length > 8_192) throw new Error('API key is too long.')
  if (/\p{Cc}/u.test(enteredApiKey)) throw new Error('API key contains control characters.')
  const apiKey = enteredApiKey || stringValue(existingProvider?.apiKey).trim()
  if (option.requiresApiKey && !apiKey) {
    throw new Error('API key is required for this provider.')
  }

  const providerId = stringValue(existingProvider?.id) || randomUUID()
  const { models, modelName } = createModel(option, modelId, existingProvider)
  const provider: JsonRecord = {
    ...(existingProvider ?? {}),
    id: providerId,
    name,
    type: option.providerType,
    apiKey,
    baseUrl,
    enabled: true,
    models,
    ...(option.builtinId ? { builtinId: option.builtinId } : {}),
    ...(!existingProvider && option.builtinId ? { presetVersion: 0 } : {}),
    createdAt:
      typeof existingProvider?.createdAt === 'number' ? existingProvider.createdAt : Date.now(),
    requiresApiKey: option.requiresApiKey,
    authMode: 'apiKey',
    defaultModel: modelId
  }
  const nextProviders = existingProvider
    ? providers.map((candidate) =>
        stringValue(candidate.id) === stringValue(existingProvider.id) ? provider : candidate
      )
    : [...providers, provider]

  persistProviderStoreState({
    ...configuration.providerStore,
    providers: nextProviders,
    activeProviderId: providerId,
    activeModelId: modelId
  })

  return { providerId, providerName: name, modelId, modelName }
}
