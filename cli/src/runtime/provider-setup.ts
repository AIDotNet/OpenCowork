import { randomUUID } from 'node:crypto'
import type {
  ModelSelection,
  ProviderSetupCatalog,
  ProviderSetupInput,
  ProviderSetupOption,
  ProviderSetupProtocol
} from '../types.js'
import {
  isRecord,
  loadOpenCoworkConfiguration,
  persistProviderStoreState,
  stringValue,
  type JsonRecord
} from './provider-catalog.js'

interface QuickProviderPreset {
  baseUrl: string
  builtinId: string
  defaultModel: JsonRecord
  description: string
  name: string
  providerType: ProviderSetupProtocol
  requiresApiKey?: boolean
}

const quickProviderPresets: QuickProviderPreset[] = [
  {
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
    description: 'Routin AI · OpenAI-compatible endpoint',
    name: 'Routin AI',
    providerType: 'openai-chat'
  },
  {
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

  const model = resolveDefaultModel(
    provider,
    providerId === activeProviderId ? activeModelId : ''
  )
  const rawModelType = stringValue(model?.type)
  const modelType = isProviderProtocol(rawModelType) ? rawModelType : undefined
  const requiresApiKey = provider.requiresApiKey !== false
  const hasApiKey = Boolean(stringValue(provider.apiKey).trim())
  const ready = provider.enabled === true && (!requiresApiKey || hasApiKey) && Boolean(model)
  const builtinId = stringValue(provider.builtinId) || undefined

  return {
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
    requiresApiKey,
    source: 'existing'
  }
}

function toPresetOption(preset: QuickProviderPreset): ProviderSetupOption {
  const rawModelType = stringValue(preset.defaultModel.type)
  return {
    baseUrl: preset.baseUrl,
    builtinId: preset.builtinId,
    defaultModelId: stringValue(preset.defaultModel.id),
    description: preset.description,
    hasApiKey: false,
    key: `builtin:${preset.builtinId}`,
    ...(isProviderProtocol(rawModelType) ? { modelType: rawModelType } : {}),
    name: preset.name,
    providerType: preset.providerType,
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
  const presetByBuiltinId = new Map(quickProviderPresets.map((preset) => [preset.builtinId, preset]))
  const existingOptions = providers
    .map((provider) => {
      const preset = presetByBuiltinId.get(stringValue(provider.builtinId))
      return toExistingOption(provider, activeProviderId, activeModelId, preset)
    })
    .filter((option): option is ProviderSetupOption => Boolean(option))
  const existingKeys = new Set(existingOptions.map((option) => option.key))
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
    .filter((option) => !existingKeys.has(option.key))
  const configuredCount = existingOptions.filter(
    (option) => option.hasApiKey || !option.requiresApiKey
  ).length

  return {
    configuredCount,
    dataDirectory: configuration.dataDirectory,
    options: [...existingOptions, ...presetOptions, ...customProviderOptions.map((item) => ({ ...item }))]
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
    stringValue(existingModel?.name) || (matchesPreset ? stringValue(presetModel.name) : '') || modelId
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

export function persistProviderSetup(input: ProviderSetupInput): ModelSelection {
  const catalog = loadProviderSetupCatalog()
  const option = catalog.options.find((candidate) => candidate.key === input.optionKey)
  if (!option) throw new Error('The selected provider changed. Reopen provider setup and retry.')

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

  const enteredApiKey = input.apiKey?.trim() ?? ''
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

