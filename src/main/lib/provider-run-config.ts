import { platform, arch, release } from 'node:os'
import { resolveEffectiveModelContextLength } from '../../shared/gpt-context'
import {
  applyOauthClientIdentityHeaders,
  resolveOauthForwardUserAgent
} from '../../shared/oauth-client-identity'
import { resolveApiUserAgent } from './api-user-agent'

function currentOauthClientPlatform(): { platform: string; arch: string; release: string } {
  return { platform: platform(), arch: arch(), release: release() }
}

export type ProviderType =
  | 'anthropic'
  | 'openai-chat'
  | 'openai-responses'
  | 'openai-images'
  | 'openai-video'
  | 'gemini-interactions'
  | 'vertex-ai'

export type ReasoningEffortLevel =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra'

export type ResponsesWebsocketMode = 'auto' | 'disabled'

export type RequestOverrides = {
  headers?: Record<string, string>
  body?: Record<string, unknown>
  omitBodyKeys?: string[]
}

export type ThinkingConfig = {
  bodyParams: Record<string, unknown>
  disabledBodyParams?: Record<string, unknown>
  forceTemperature?: number
  reasoningEffortLevels?: ReasoningEffortLevel[]
  defaultReasoningEffort?: ReasoningEffortLevel
}

export type ProviderRunConfig = {
  type: ProviderType
  apiKey: string
  baseUrl?: string
  model: string
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
  thinkingEnabled?: boolean
  thinkingConfig?: ThinkingConfig
  reasoningEffort?: ReasoningEffortLevel
  category?: string
  providerId?: string
  providerBuiltinId?: string
  requiresApiKey?: boolean
  useSystemProxy?: boolean
  allowInsecureTls?: boolean
  requestTimeoutSeconds?: number
  streamIdleTimeoutSeconds?: number
  responseSummary?: 'auto' | 'concise' | 'detailed'
  enablePromptCache?: boolean
  enableSystemPromptCache?: boolean
  cacheTtl?: '5m' | '1h'
  userAgent?: string
  requestOverrides?: RequestOverrides
  instructionsPrompt?: string
  serviceTier?: string
  sessionId?: string
  responsesSessionScope?: string
  computerUseEnabled?: boolean
  builtinSearchEnabled?: boolean
  responsesImageGeneration?: {
    enabled?: boolean
    action?: string
    background?: string
    inputFidelity?: string
    inputImageMask?: { fileId?: string; imageUrl?: string }
    moderation?: string
    outputFormat?: string
    outputCompression?: number
    quality?: string
    size?: string
    partialImages?: number
  }
  accountId?: string
  websocketUrl?: string
  websocketMode?: ResponsesWebsocketMode
}

export type AIModelConfig = {
  id: string
  enabled?: boolean
  type?: ProviderType
  category?: string
  contextLength?: number
  enableExtendedContextCompression?: boolean
  enableLongContext?: boolean
  longContextLength?: number
  supportsLongContext?: boolean
  maxOutputTokens?: number
  thinkingConfig?: ThinkingConfig
  requestOverrides?: RequestOverrides
  responseSummary?: 'auto' | 'concise' | 'detailed'
  enablePromptCache?: boolean
  enableSystemPromptCache?: boolean
  cacheTtl?: '5m' | '1h'
  serviceTier?: string
  websocketUrl?: string
  websocketMode?: ResponsesWebsocketMode
  supportsBuiltinSearch?: boolean
  enableBuiltinSearch?: boolean
  supportsWebsocket?: boolean
  supportsImageGeneration?: boolean
  responsesImageGeneration?: ProviderRunConfig['responsesImageGeneration']
}

export type AIProviderConfigRecord = {
  id: string
  name: string
  type: ProviderType
  apiKey: string
  baseUrl: string
  enabled: boolean
  builtinId?: string
  models: AIModelConfig[]
  requiresApiKey?: boolean
  useSystemProxy?: boolean
  allowInsecureTls?: boolean
  sendTemperature?: boolean
  sendMaxOutputTokens?: boolean
  userAgent?: string
  requestOverrides?: RequestOverrides
  instructionsPrompt?: string
  defaultModel?: string
  authMode?: string
  websocketUrl?: string
  websocketMode?: ResponsesWebsocketMode
  cacheTtl?: '5m' | '1h'
  oauth?: {
    accountId?: string
  }
}

export type PersistedProvidersState = {
  providers: AIProviderConfigRecord[]
  activeProviderId?: string | null
  activeModelId?: string
  activeFastProviderId?: string | null
  activeFastModelId?: string
}

const MAX_OUTPUT_TOKENS_BODY_KEYS = [
  'max_tokens',
  'max_completion_tokens',
  'max_output_tokens',
  'maxOutputTokens'
]

export function normalizeProviderType(type: ProviderType): ProviderType {
  if (type === 'vertex-ai') return 'openai-chat'
  return type
}

export function resolveProviderDefaultModelId(provider: AIProviderConfigRecord): string {
  if (
    provider.defaultModel &&
    provider.models.some((model) => model.id === provider.defaultModel)
  ) {
    return provider.defaultModel
  }
  return provider.models.find((model) => model.enabled)?.id ?? provider.models[0]?.id ?? ''
}

export function getApiRequestTimeoutSeconds(settings: Record<string, unknown>): number {
  const value = Number(settings.apiRequestTimeoutSeconds)
  if (!Number.isFinite(value)) return 100
  return Math.min(86_400, Math.max(0, Math.floor(value)))
}

function normalizeProviderBaseUrl(baseUrl: string, requestType: ProviderType): string {
  const normalizedType = normalizeProviderType(requestType)
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (normalizedType === 'anthropic') {
    return trimmed.replace(/\/v1(?:\/messages)?$/i, '')
  }
  if (requestType === 'gemini-interactions' || requestType === 'vertex-ai') {
    return trimmed.replace(/\/openai$/i, '')
  }
  return trimmed
}

function buildRequestOverrides(
  providerOverrides: RequestOverrides | undefined,
  modelOverrides: RequestOverrides | undefined,
  modelId?: string,
  paramCarry?: Pick<AIProviderConfigRecord, 'sendTemperature' | 'sendMaxOutputTokens'>,
  builtinId?: string
): RequestOverrides | undefined {
  const headers = applyOauthClientIdentityHeaders(
    builtinId,
    {
      ...(providerOverrides?.headers ?? {}),
      ...(modelOverrides?.headers ?? {})
    },
    currentOauthClientPlatform()
  )
  const body = {
    ...(providerOverrides?.body ?? {}),
    ...(modelOverrides?.body ?? {})
  }
  const omitBodyKeys = Array.from(
    new Set([...(providerOverrides?.omitBodyKeys ?? []), ...(modelOverrides?.omitBodyKeys ?? [])])
  )
  if (/^gpt-5/i.test(modelId ?? '')) {
    omitBodyKeys.push('temperature')
  }
  if (paramCarry?.sendTemperature === false) {
    omitBodyKeys.push('temperature')
  }
  if (paramCarry?.sendMaxOutputTokens === false) {
    omitBodyKeys.push(...MAX_OUTPUT_TOKENS_BODY_KEYS)
  }
  return (headers && Object.keys(headers).length > 0) ||
    Object.keys(body).length > 0 ||
    omitBodyKeys.length > 0
    ? {
        ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
        ...(Object.keys(body).length > 0 ? { body } : {}),
        ...(omitBodyKeys.length > 0 ? { omitBodyKeys: Array.from(new Set(omitBodyKeys)) } : {})
      }
    : undefined
}

function getEffectiveMaxTokens(
  settings: Record<string, unknown>,
  model?: AIModelConfig | null
): number {
  const userMaxTokens = Number(settings.maxTokens ?? 32000)
  if (!model?.maxOutputTokens) return userMaxTokens
  return Math.min(userMaxTokens, model.maxOutputTokens)
}

function isReasoningEffortLevel(value: unknown): value is ReasoningEffortLevel {
  return (
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'ultra'
  )
}

function getReasoningEffortKey(providerId?: string | null, modelId?: string | null): string | null {
  if (!providerId || !modelId) return null
  return `${providerId}:${modelId}`
}

function resolveReasoningEffortForModel(args: {
  reasoningEffort: ReasoningEffortLevel
  reasoningEffortByModel?: Record<string, ReasoningEffortLevel>
  providerId?: string | null
  modelId?: string | null
  thinkingConfig?: ThinkingConfig
}): ReasoningEffortLevel {
  const key = getReasoningEffortKey(args.providerId, args.modelId)
  const levels = args.thinkingConfig?.reasoningEffortLevels
  const savedEffort = key ? args.reasoningEffortByModel?.[key] : undefined

  if (savedEffort && (!levels || levels.includes(savedEffort))) {
    return savedEffort
  }

  return args.thinkingConfig?.defaultReasoningEffort ?? args.reasoningEffort
}

/**
 * Mirrors the renderer's rule: the model catalog marks which models *can* run on the
 * priority tier, but only the Fast toggle opts a request into it. Codex OAuth plans are
 * always billed on the priority tier, so they ignore the toggle.
 */
function resolveServiceTier(
  settings: Record<string, unknown>,
  model: AIModelConfig | undefined,
  providerBuiltinId?: string
): string | undefined {
  if (!model?.serviceTier) return undefined
  if (providerBuiltinId === 'codex-oauth') return model.serviceTier
  return settings.fastModeEnabled === true ? model.serviceTier : undefined
}

function readReasoningEffortByModel(
  value: unknown
): Record<string, ReasoningEffortLevel> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined

  const entries = Object.entries(value)
    .filter(([, raw]) => isReasoningEffortLevel(raw))
    .map(([key, raw]) => [key, raw] as const)

  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

export function buildProviderConfigById(
  state: PersistedProvidersState,
  settings: Record<string, unknown>,
  providerId: string,
  modelId: string
): ProviderRunConfig | null {
  const provider = state.providers.find((item) => item.id === providerId)
  if (!provider) return null
  const model = provider.models.find((item) => item.id === modelId)
  const requestType = normalizeProviderType(model?.type ?? provider.type)
  const requestOverrides = buildRequestOverrides(
    provider.requestOverrides,
    model?.requestOverrides,
    modelId,
    provider,
    provider.builtinId
  )
  const supportsWebsocket = requestType === 'openai-responses' && model?.supportsWebsocket === true
  const websocketUrl = supportsWebsocket
    ? (model?.websocketUrl ?? provider.websocketUrl)
    : undefined
  const websocketMode = supportsWebsocket
    ? (model?.websocketMode ?? provider.websocketMode)
    : requestType === 'openai-responses'
      ? 'disabled'
      : undefined
  const thinkingConfig = model?.thinkingConfig
  const baseReasoningEffort = isReasoningEffortLevel(settings.reasoningEffort)
    ? settings.reasoningEffort
    : 'medium'
  const reasoningEffort = resolveReasoningEffortForModel({
    reasoningEffort: baseReasoningEffort,
    reasoningEffortByModel: readReasoningEffortByModel(settings.reasoningEffortByModel),
    providerId: provider.id,
    modelId,
    thinkingConfig
  })
  const serviceTier = resolveServiceTier(settings, model, provider.builtinId)
  return {
    type: requestType,
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl ? normalizeProviderBaseUrl(provider.baseUrl, requestType) : undefined,
    model: modelId,
    thinkingEnabled: settings.thinkingEnabled === true && !!thinkingConfig,
    ...(thinkingConfig ? { thinkingConfig } : {}),
    reasoningEffort,
    category: model?.category,
    providerId: provider.id,
    providerBuiltinId: provider.builtinId,
    requiresApiKey: provider.requiresApiKey,
    ...(provider.useSystemProxy !== undefined ? { useSystemProxy: provider.useSystemProxy } : {}),
    ...(provider.allowInsecureTls !== undefined
      ? { allowInsecureTls: provider.allowInsecureTls }
      : {}),
    requestTimeoutSeconds: getApiRequestTimeoutSeconds(settings),
    userAgent: resolveApiUserAgent(
      resolveOauthForwardUserAgent(
        provider.builtinId,
        provider.userAgent,
        currentOauthClientPlatform()
      )
    ),
    ...(requestOverrides ? { requestOverrides } : {}),
    ...(provider.instructionsPrompt ? { instructionsPrompt: provider.instructionsPrompt } : {}),
    ...(provider.oauth?.accountId ? { accountId: provider.oauth.accountId } : {}),
    ...(model?.responseSummary ? { responseSummary: model.responseSummary } : {}),
    ...(model?.enablePromptCache !== undefined
      ? { enablePromptCache: model.enablePromptCache }
      : {}),
    ...(model?.enableSystemPromptCache !== undefined
      ? { enableSystemPromptCache: model.enableSystemPromptCache }
      : {}),
    cacheTtl: model?.cacheTtl ?? provider.cacheTtl,
    ...(serviceTier ? { serviceTier } : {}),
    ...((requestType === 'anthropic' || requestType === 'openai-responses') &&
    model?.supportsBuiltinSearch === true &&
    model?.enableBuiltinSearch === true
      ? { builtinSearchEnabled: true }
      : {}),
    ...(requestType === 'openai-responses'
      ? {
          responsesImageGeneration: {
            ...(model?.responsesImageGeneration ?? {}),
            enabled:
              model?.supportsImageGeneration === true &&
              model?.responsesImageGeneration?.enabled === true
          }
        }
      : {}),
    ...(websocketUrl ? { websocketUrl } : {}),
    ...(websocketMode ? { websocketMode } : {}),
    maxTokens: getEffectiveMaxTokens(settings, model),
    temperature: Number(settings.temperature ?? 0.7)
  }
}

export function resolveModelCompressionProfile(
  state: PersistedProvidersState,
  providerId: string,
  modelId: string
): {
  id?: string
  category?: string
  contextLength?: number
  enableExtendedContextCompression?: boolean
  enableLongContext?: boolean
  longContextLength?: number
  supportsLongContext?: boolean
  maxOutputTokens?: number
} | null {
  if (!providerId || !modelId) return null
  const provider = state.providers.find((item) => item.id === providerId)
  const model = provider?.models.find((item) => item.id === modelId)
  if (!model) return null
  const contextLength = resolveEffectiveModelContextLength(model)
  return {
    id: model.id,
    ...(model.category ? { category: model.category } : {}),
    ...(typeof contextLength === 'number' && contextLength > 0 ? { contextLength } : {}),
    ...(typeof model.enableExtendedContextCompression === 'boolean'
      ? { enableExtendedContextCompression: model.enableExtendedContextCompression }
      : {}),
    ...(typeof model.enableLongContext === 'boolean'
      ? { enableLongContext: model.enableLongContext }
      : {}),
    ...(typeof model.longContextLength === 'number' && model.longContextLength > 0
      ? { longContextLength: model.longContextLength }
      : {}),
    ...(typeof model.supportsLongContext === 'boolean'
      ? { supportsLongContext: model.supportsLongContext }
      : {}),
    ...(typeof model.maxOutputTokens === 'number' && model.maxOutputTokens > 0
      ? { maxOutputTokens: model.maxOutputTokens }
      : {})
  }
}

export function getCompressionProviderConfig(
  state: PersistedProvidersState,
  settings: Record<string, unknown>
): ProviderRunConfig | null {
  const binding = settings.contextCompressionModel
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null
  const record = binding as Record<string, unknown>
  const providerId = typeof record.providerId === 'string' ? record.providerId.trim() : ''
  const modelId = typeof record.modelId === 'string' ? record.modelId.trim() : ''
  if (!providerId || !modelId) return null
  const provider = state.providers.find((item) => item.id === providerId)
  const model = provider?.models.find((item) => item.id === modelId)
  if (!provider || model?.enabled !== true || (model.category ?? 'chat') !== 'chat') {
    return null
  }
  return buildProviderConfigById(state, settings, providerId, modelId)
}

export function getFastProviderConfig(
  state: PersistedProvidersState,
  settings: Record<string, unknown>
): ProviderRunConfig | null {
  const providerId = state.activeFastProviderId ?? state.activeProviderId
  if (!providerId) return null
  const provider = state.providers.find((item) => item.id === providerId)
  if (!provider) return null
  const modelId =
    state.activeFastModelId && provider.models.some((model) => model.id === state.activeFastModelId)
      ? state.activeFastModelId
      : resolveProviderDefaultModelId(provider)
  if (!modelId) return null
  return buildProviderConfigById(state, settings, providerId, modelId)
}
