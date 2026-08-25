import {
  classifyRoutinCredential,
  OPENCOWORK_DEVICE_LOGIN_URL,
  OPENCOWORK_PROTOCOL,
  type RoutinCredentialClassification
} from './routin-credential'

export const OPENCOWORK_IMPORT_SCHEMA_VERSION = 2
export const OPENCOWORK_IMPORT_MAX_PAYLOAD_BYTES = 256 * 1024
export const OPENCOWORK_IMPORT_DEEP_LINK_MAX_ENCODED_BYTES = 6 * 1024

export type OpenCoworkImportProviderType =
  | 'anthropic'
  | 'openai-chat'
  | 'openai-responses'
  | 'openai-images'
  | 'openai-video'
  | 'seedance-video'
  | 'xai-video'
  | 'gemini-interactions'
  | 'vertex-ai'

export type OpenCoworkImportModelCategory = 'chat' | 'speech' | 'embedding' | 'image' | 'video'
export type OpenCoworkImportModelPolicy = 'merge' | 'replace'
export type OpenCoworkImportChannelKind = 'builtin' | 'custom'

export const OPENCOWORK_IMPORT_PROVIDER_TYPES = [
  'anthropic',
  'openai-chat',
  'openai-responses',
  'openai-images',
  'openai-video',
  'seedance-video',
  'xai-video',
  'gemini-interactions',
  'vertex-ai'
] as const satisfies readonly OpenCoworkImportProviderType[]

export const OPENCOWORK_IMPORT_OAUTH_BUILTIN_IDS = ['codex-oauth', 'copilot-oauth'] as const

export interface OpenCoworkImportBuiltinCatalogEntry {
  builtinId: string
  name: string
  type: OpenCoworkImportProviderType
  defaultBaseUrl: string
  defaultModel?: string
  requiresApiKey?: boolean
}

export const OPENCOWORK_IMPORT_BUILTIN_CATALOG: readonly OpenCoworkImportBuiltinCatalogEntry[] = [
  {
    builtinId: 'routin-ai',
    name: 'Routin AI',
    type: 'openai-chat',
    defaultBaseUrl: 'https://api.routin.ai/v1',
    defaultModel: 'grok-4.6'
  },
  {
    builtinId: 'routin-ai-plan',
    name: 'Routin AI（套餐）',
    type: 'openai-chat',
    defaultBaseUrl: 'https://api.routin.ai/plan/v1',
    defaultModel: 'gpt-5.5'
  },
  {
    builtinId: 'openai',
    name: 'OpenAI',
    type: 'openai-chat',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.6-sol'
  },
  {
    builtinId: 'anthropic',
    name: 'Anthropic',
    type: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-opus-5'
  },
  {
    builtinId: 'google',
    name: 'Google Gemini',
    type: 'gemini-interactions',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-3.7-flash'
  },
  {
    builtinId: 'deepseek',
    name: 'DeepSeek',
    type: 'openai-chat',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-v4-flash'
  },
  {
    builtinId: 'openrouter',
    name: 'OpenRouter',
    type: 'openai-chat',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-5.6-sol'
  },
  {
    builtinId: 'opencode',
    name: 'OpenCode Zen',
    type: 'openai-chat',
    defaultBaseUrl: 'https://opencode.ai/zen/v1',
    defaultModel: 'deepseek-v4-flash'
  },
  {
    builtinId: 'opencode-go',
    name: 'OpenCode Go',
    type: 'openai-chat',
    defaultBaseUrl: 'https://opencode.ai/zen/go/v1',
    defaultModel: 'deepseek-v4-flash'
  },
  {
    builtinId: 'ollama',
    name: 'Ollama',
    type: 'openai-chat',
    defaultBaseUrl: 'http://localhost:11434/v1',
    requiresApiKey: false
  },
  {
    builtinId: 'azure-openai',
    name: 'Azure OpenAI',
    type: 'openai-chat',
    defaultBaseUrl: '',
    defaultModel: 'gpt-5.2'
  },
  {
    builtinId: 'moonshot-coding',
    name: 'Moonshot（套餐）',
    type: 'openai-chat',
    defaultBaseUrl: 'https://api.kimi.com/coding/v1',
    defaultModel: 'k3',
    requiresApiKey: false
  },
  {
    builtinId: 'moonshot',
    name: 'Moonshot（官方）',
    type: 'openai-chat',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2.7-code'
  },
  {
    builtinId: 'qwen-coding',
    name: '通义千问（套餐）',
    type: 'anthropic',
    defaultBaseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    defaultModel: 'qwen3.5-plus'
  },
  {
    builtinId: 'qwen',
    name: '通义千问（官方）',
    type: 'openai-chat',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen3.7-max'
  },
  {
    builtinId: 'baidu-coding',
    name: '百度智能云（套餐）',
    type: 'anthropic',
    defaultBaseUrl: 'https://qianfan.baidubce.com/anthropic/tokenplan/personal',
    defaultModel: 'deepseek-v4-flash'
  },
  {
    builtinId: 'baidu',
    name: '百度智能云（官方）',
    type: 'openai-chat',
    defaultBaseUrl: 'https://qianfan.baidubce.com/v2',
    defaultModel: 'ernie-5.1'
  },
  {
    builtinId: 'minimax-coding',
    name: 'MiniMax（套餐）',
    type: 'anthropic',
    defaultBaseUrl: 'https://api.minimaxi.com/anthropic',
    defaultModel: 'MiniMax-M3'
  },
  {
    builtinId: 'minimax',
    name: 'MiniMax（官方）',
    type: 'anthropic',
    defaultBaseUrl: 'https://api.minimaxi.com/anthropic',
    defaultModel: 'MiniMax-M3'
  },
  {
    builtinId: 'siliconflow',
    name: '硅基流动',
    type: 'openai-chat',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'moonshotai/Kimi-K3'
  },
  {
    builtinId: 'gitee-ai',
    name: 'Gitee AI',
    type: 'openai-chat',
    defaultBaseUrl: 'https://ai.gitee.com/v1',
    defaultModel: 'qwen3.8-max'
  },
  {
    builtinId: 'xiaomi-coding',
    name: '小米（套餐）',
    type: 'anthropic',
    defaultBaseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
    defaultModel: 'mimo-v2.5-pro'
  },
  {
    builtinId: 'xiaomi',
    name: '小米',
    type: 'openai-chat',
    defaultBaseUrl: 'https://api.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.5-pro'
  },
  {
    builtinId: 'bigmodel-coding',
    name: '智谱AI（套餐）',
    type: 'anthropic',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
    defaultModel: 'glm-5.3'
  },
  {
    builtinId: 'bigmodel',
    name: '智谱AI',
    type: 'openai-chat',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-5.3'
  },
  {
    builtinId: 'volcengine',
    name: '火山引擎',
    type: 'openai-chat',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-seed-2-1-pro-260628'
  },
  {
    builtinId: 'xai',
    name: 'xAI',
    type: 'openai-chat',
    defaultBaseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4.6'
  },
  {
    builtinId: 'longcat',
    name: 'LongCat',
    type: 'openai-chat',
    defaultBaseUrl: 'https://api.longcat.chat/openai/v1',
    defaultModel: 'LongCat-2.0'
  },
  {
    builtinId: 'hunyuan',
    name: '腾讯混元',
    type: 'openai-chat',
    defaultBaseUrl: 'https://tokenhub.tencentmaas.com/v1',
    defaultModel: 'hy3'
  },
  {
    builtinId: 'stepfun',
    name: '阶跃星辰',
    type: 'openai-chat',
    defaultBaseUrl: 'https://api.stepfun.com/v1',
    defaultModel: 'step-3.7-flash'
  },
  {
    builtinId: 'stepfun-plan',
    name: '阶跃星辰（套餐）',
    type: 'openai-chat',
    defaultBaseUrl: 'https://api.stepfun.com/step_plan/v1',
    defaultModel: 'step-3.7-flash'
  },
  {
    builtinId: 'mistral',
    name: 'Mistral',
    type: 'openai-chat',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-medium-3.5'
  },
  {
    builtinId: 'meta',
    name: 'Meta',
    type: 'openai-chat',
    defaultBaseUrl: 'https://api.meta.ai/v1',
    defaultModel: 'muse-spark-1.2'
  },
  {
    builtinId: 'groq',
    name: 'Groq',
    type: 'openai-chat',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'openai/gpt-oss-120b'
  },
  {
    builtinId: 'vertex-ai',
    name: 'Google Vertex AI',
    type: 'vertex-ai',
    defaultBaseUrl:
      'https://aiplatform.googleapis.com/v1/projects/YOUR_PROJECT/locations/us-central1',
    defaultModel: 'gemini-3.7-flash'
  },
  {
    builtinId: 'lmstudio',
    name: 'LM Studio',
    type: 'openai-chat',
    defaultBaseUrl: 'http://localhost:1234/v1',
    requiresApiKey: false
  },
  {
    builtinId: 'nvidia',
    name: 'NVIDIA NIM',
    type: 'openai-chat',
    defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'moonshotai/kimi-k2-instruct'
  },
  {
    builtinId: 'cerebras',
    name: 'Cerebras',
    type: 'openai-chat',
    defaultBaseUrl: 'https://api.cerebras.ai/v1',
    defaultModel: 'gpt-oss-120b'
  },
  {
    builtinId: 'together',
    name: 'Together AI',
    type: 'openai-chat',
    defaultBaseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V4-Pro'
  },
  {
    builtinId: 'fireworks',
    name: 'Fireworks',
    type: 'openai-chat',
    defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',
    defaultModel: 'accounts/fireworks/models/deepseek-v4-pro'
  },
  {
    builtinId: 'modelscope',
    name: '魔搭 ModelScope',
    type: 'openai-chat',
    defaultBaseUrl: 'https://api-inference.modelscope.cn/v1',
    defaultModel: 'Qwen/Qwen3-235B-A22B'
  },
  {
    builtinId: 'ppio',
    name: '派欧云 PPIO',
    type: 'openai-chat',
    defaultBaseUrl: 'https://api.ppio.com/openai/v1',
    defaultModel: 'deepseek/deepseek-v4-pro'
  },
  {
    builtinId: 'novita',
    name: 'Novita',
    type: 'openai-chat',
    defaultBaseUrl: 'https://api.novita.ai/v3/openai',
    defaultModel: 'deepseek/deepseek-v4-pro'
  },
  {
    builtinId: 'infini',
    name: '无问芯穹',
    type: 'openai-chat',
    defaultBaseUrl: 'https://cloud.infini-ai.com/maas/v1',
    defaultModel: 'deepseek-v4-flash'
  },
  {
    builtinId: 'huggingface',
    name: 'Hugging Face',
    type: 'openai-chat',
    defaultBaseUrl: 'https://router.huggingface.co/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3.2'
  }
]

const builtinCatalogById = new Map(
  OPENCOWORK_IMPORT_BUILTIN_CATALOG.map((entry) => [entry.builtinId, entry])
)
const oauthBuiltinIds = new Set<string>(OPENCOWORK_IMPORT_OAUTH_BUILTIN_IDS)
const providerTypeSet = new Set<string>(OPENCOWORK_IMPORT_PROVIDER_TYPES)

export type JsonRecord = Record<string, unknown>

export interface OpenCoworkImportRequestOverrides {
  headers?: Record<string, string>
  body?: Record<string, unknown>
  omitBodyKeys?: string[]
}

export interface OpenCoworkImportThinkingConfig {
  bodyParams: Record<string, unknown>
  disabledBodyParams?: Record<string, unknown>
  forceTemperature?: number
  reasoningEffortLevels?: string[]
  defaultReasoningEffort?: string
}

export interface OpenCoworkImportModel {
  id: string
  name?: string
  enabled?: boolean
  type?: OpenCoworkImportProviderType
  category?: OpenCoworkImportModelCategory
  icon?: string
  contextLength?: number
  enableExtendedContextCompression?: boolean
  longContextLength?: number
  supportsLongContext?: boolean
  enableLongContext?: boolean
  maxOutputTokens?: number
  inputPrice?: number
  outputPrice?: number
  cacheCreationPrice?: number
  cacheHitPrice?: number
  offPeakInputPrice?: number
  offPeakOutputPrice?: number
  offPeakCacheCreationPrice?: number
  offPeakCacheHitPrice?: number
  pricingSchedule?: Record<string, unknown>
  pricingTiers?: unknown[]
  premiumRequestMultiplier?: number
  availablePlans?: string[]
  supportsVision?: boolean
  supportsFunctionCall?: boolean
  supportsThinking?: boolean
  audio?: boolean
  supportsComputerUse?: boolean
  enableComputerUse?: boolean
  supportsBuiltinSearch?: boolean
  enableBuiltinSearch?: boolean
  supportsWebsocket?: boolean
  supportsImageGeneration?: boolean
  thinkingConfig?: OpenCoworkImportThinkingConfig
  responseSummary?: 'auto' | 'concise' | 'detailed'
  responsesImageGeneration?: Record<string, unknown>
  enablePromptCache?: boolean
  enableSystemPromptCache?: boolean
  cacheTtl?: '5m' | '1h'
  requestOverrides?: OpenCoworkImportRequestOverrides
  serviceTier?: 'priority'
  websocketUrl?: string
  websocketMode?: 'auto' | 'disabled'
}

export interface OpenCoworkImportProvider {
  kind: OpenCoworkImportChannelKind
  key: string
  builtinId?: string
  name?: string
  type?: OpenCoworkImportProviderType
  apiKey?: string
  baseUrl?: string
  enabled?: boolean
  defaultModel?: string
  requiresApiKey?: boolean
  useSystemProxy?: boolean
  allowInsecureTls?: boolean
  sendTemperature?: boolean
  sendMaxOutputTokens?: boolean
  userAgent?: string
  requestOverrides?: OpenCoworkImportRequestOverrides
  websocketUrl?: string
  websocketMode?: 'auto' | 'disabled'
  cacheTtl?: '5m' | '1h'
  models?: OpenCoworkImportModel[]
  modelPolicy?: OpenCoworkImportModelPolicy
}

export interface OpenCoworkImportActive {
  key: string
  modelId?: string
}

export interface OpenCoworkImportConfigRef {
  url: string
  token: string
  expiresAt?: number
}

export interface OpenCoworkImportDocument {
  schemaVersion: 1 | 2
  source?: string
  active?: OpenCoworkImportActive
  providers: OpenCoworkImportProvider[]
  configRef?: OpenCoworkImportConfigRef
}

export interface OpenCoworkImportProviderStoreState extends JsonRecord {
  providers?: unknown
  activeProviderId?: unknown
  activeModelId?: unknown
}

export interface OpenCoworkImportAppliedProvider {
  key: string
  providerId: string
  providerName: string
  modelId: string
  builtinId?: string
  importKey?: string
  created: boolean
}

export interface OpenCoworkImportSkippedProvider {
  key: string
  reason: string
}

export interface ApplyOpenCoworkImportResult {
  state: OpenCoworkImportProviderStoreState
  applied: OpenCoworkImportAppliedProvider[]
  skipped: OpenCoworkImportSkippedProvider[]
}

export interface ApplyOpenCoworkImportOptions {
  createId: () => string
  now?: number
}

export type OpenCoworkImportCallbackParse =
  | { kind: 'v1-credential'; apiKey: string; credentialKind?: string }
  | { kind: 'document'; document: OpenCoworkImportDocument }

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function optionalString(value: unknown): string | undefined {
  const next = stringValue(value)
  return next || undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isProviderType(value: string): value is OpenCoworkImportProviderType {
  return providerTypeSet.has(value)
}

function lookupBuiltin(builtinId: string): OpenCoworkImportBuiltinCatalogEntry | undefined {
  return builtinCatalogById.get(builtinId)
}

export function getOpenCoworkImportBuiltin(
  builtinId: string
): OpenCoworkImportBuiltinCatalogEntry | undefined {
  return lookupBuiltin(builtinId)
}

export function isOpenCoworkImportOAuthBuiltin(builtinId: string): boolean {
  return oauthBuiltinIds.has(builtinId)
}

export function providerImportKey(provider: {
  builtinId?: string
  importKey?: string
  id?: string
}): string {
  const builtinId = stringValue(provider.builtinId)
  if (builtinId) return `builtin:${builtinId}`
  const importKey = stringValue(provider.importKey)
  if (importKey) return importKey
  return stringValue(provider.id)
}

function decodeBase64UrlJson(encoded: string): unknown {
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const withPad = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = Buffer.from(withPad, 'base64').toString('binary')
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

function encodeBase64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '')
}

function sanitizeHttpsUrl(value: unknown): string | undefined {
  const raw = stringValue(value)
  if (!raw) return undefined
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'https:') return undefined
    return raw
  } catch {
    return undefined
  }
}

function sanitizeBaseUrl(value: unknown): string | undefined {
  const raw = stringValue(value)
  if (!raw) return undefined
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    if (parsed.username || parsed.password) return undefined
    return raw.replace(/\/+$/u, '')
  } catch {
    return undefined
  }
}

function sanitizeRequestOverrides(value: unknown): OpenCoworkImportRequestOverrides | undefined {
  if (!isRecord(value)) return undefined
  const headers = isRecord(value.headers)
    ? Object.fromEntries(
        Object.entries(value.headers).flatMap(([key, headerValue]) => {
          const text = stringValue(headerValue)
          return key && text ? [[key, text] as const] : []
        })
      )
    : undefined
  const body = isRecord(value.body) ? { ...value.body } : undefined
  const omitBodyKeys = Array.isArray(value.omitBodyKeys)
    ? value.omitBodyKeys.filter(
        (item): item is string => typeof item === 'string' && item.trim().length > 0
      )
    : undefined
  if (!headers && !body && !omitBodyKeys?.length) return undefined
  return {
    ...(headers ? { headers } : {}),
    ...(body ? { body } : {}),
    ...(omitBodyKeys?.length ? { omitBodyKeys } : {})
  }
}

function sanitizeThinkingConfig(value: unknown): OpenCoworkImportThinkingConfig | undefined {
  if (!isRecord(value)) return undefined
  const bodyParams = isRecord(value.bodyParams) ? { ...value.bodyParams } : {}
  const disabledBodyParams = isRecord(value.disabledBodyParams)
    ? { ...value.disabledBodyParams }
    : undefined
  const forceTemperature = optionalFiniteNumber(value.forceTemperature)
  const reasoningEffortLevels = Array.isArray(value.reasoningEffortLevels)
    ? value.reasoningEffortLevels.filter((item): item is string => typeof item === 'string')
    : undefined
  const defaultReasoningEffort = optionalString(value.defaultReasoningEffort)
  return {
    bodyParams,
    ...(disabledBodyParams ? { disabledBodyParams } : {}),
    ...(forceTemperature !== undefined ? { forceTemperature } : {}),
    ...(reasoningEffortLevels?.length ? { reasoningEffortLevels } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {})
  }
}

function sanitizeModel(value: unknown): OpenCoworkImportModel | null {
  if (!isRecord(value)) return null
  const id = stringValue(value.id)
  if (!id || /\s/u.test(id)) return null
  const typeValue = optionalString(value.type)
  const category = optionalString(value.category)
  const cacheTtl = value.cacheTtl === '5m' || value.cacheTtl === '1h' ? value.cacheTtl : undefined
  const responseSummary =
    value.responseSummary === 'auto' ||
    value.responseSummary === 'concise' ||
    value.responseSummary === 'detailed'
      ? value.responseSummary
      : undefined
  const websocketMode =
    value.websocketMode === 'auto' || value.websocketMode === 'disabled'
      ? value.websocketMode
      : undefined
  const model: OpenCoworkImportModel = { id }
  const name = optionalString(value.name)
  if (name) model.name = name
  const enabled = optionalBoolean(value.enabled)
  if (enabled !== undefined) model.enabled = enabled
  if (typeValue && isProviderType(typeValue)) model.type = typeValue
  if (
    category === 'chat' ||
    category === 'speech' ||
    category === 'embedding' ||
    category === 'image' ||
    category === 'video'
  ) {
    model.category = category
  }
  const icon = sanitizeHttpsUrl(value.icon)
  if (icon) model.icon = icon
  const assignNumber = (key: keyof OpenCoworkImportModel, raw: unknown): void => {
    const next = optionalFiniteNumber(raw)
    if (next !== undefined) (model as unknown as JsonRecord)[key] = next
  }
  const assignBoolean = (key: keyof OpenCoworkImportModel, raw: unknown): void => {
    const next = optionalBoolean(raw)
    if (next !== undefined) (model as unknown as JsonRecord)[key] = next
  }
  assignNumber('contextLength', value.contextLength)
  assignBoolean('enableExtendedContextCompression', value.enableExtendedContextCompression)
  assignNumber('longContextLength', value.longContextLength)
  assignBoolean('supportsLongContext', value.supportsLongContext)
  assignBoolean('enableLongContext', value.enableLongContext)
  assignNumber('maxOutputTokens', value.maxOutputTokens)
  assignNumber('inputPrice', value.inputPrice)
  assignNumber('outputPrice', value.outputPrice)
  assignNumber('cacheCreationPrice', value.cacheCreationPrice)
  assignNumber('cacheHitPrice', value.cacheHitPrice)
  assignNumber('offPeakInputPrice', value.offPeakInputPrice)
  assignNumber('offPeakOutputPrice', value.offPeakOutputPrice)
  assignNumber('offPeakCacheCreationPrice', value.offPeakCacheCreationPrice)
  assignNumber('offPeakCacheHitPrice', value.offPeakCacheHitPrice)
  if (isRecord(value.pricingSchedule)) model.pricingSchedule = { ...value.pricingSchedule }
  if (Array.isArray(value.pricingTiers)) model.pricingTiers = value.pricingTiers
  assignNumber('premiumRequestMultiplier', value.premiumRequestMultiplier)
  if (Array.isArray(value.availablePlans)) {
    model.availablePlans = value.availablePlans.filter(
      (item): item is string => typeof item === 'string'
    )
  }
  assignBoolean('supportsVision', value.supportsVision)
  assignBoolean('supportsFunctionCall', value.supportsFunctionCall)
  assignBoolean('supportsThinking', value.supportsThinking)
  assignBoolean('audio', value.audio)
  assignBoolean('supportsComputerUse', value.supportsComputerUse)
  assignBoolean('enableComputerUse', value.enableComputerUse)
  assignBoolean('supportsBuiltinSearch', value.supportsBuiltinSearch)
  assignBoolean('enableBuiltinSearch', value.enableBuiltinSearch)
  assignBoolean('supportsWebsocket', value.supportsWebsocket)
  assignBoolean('supportsImageGeneration', value.supportsImageGeneration)
  const thinkingConfig = sanitizeThinkingConfig(value.thinkingConfig)
  if (thinkingConfig) model.thinkingConfig = thinkingConfig
  if (responseSummary) model.responseSummary = responseSummary
  if (isRecord(value.responsesImageGeneration)) {
    model.responsesImageGeneration = { ...value.responsesImageGeneration }
  }
  assignBoolean('enablePromptCache', value.enablePromptCache)
  assignBoolean('enableSystemPromptCache', value.enableSystemPromptCache)
  if (cacheTtl) model.cacheTtl = cacheTtl
  const requestOverrides = sanitizeRequestOverrides(value.requestOverrides)
  if (requestOverrides) model.requestOverrides = requestOverrides
  if (value.serviceTier === 'priority') model.serviceTier = 'priority'
  const websocketUrl = sanitizeHttpsUrl(value.websocketUrl)
  if (websocketUrl) model.websocketUrl = websocketUrl
  if (websocketMode) model.websocketMode = websocketMode
  return model
}

function sanitizeProvider(value: unknown): OpenCoworkImportProvider | { error: string } | null {
  if (!isRecord(value)) return null
  const builtinId = optionalString(value.builtinId)
  const explicitKind = value.kind
  const typeValue = optionalString(value.type)
  const type = typeValue && isProviderType(typeValue) ? typeValue : undefined
  const baseUrl =
    value.baseUrl === ''
      ? ''
      : value.baseUrl === undefined
        ? undefined
        : sanitizeBaseUrl(value.baseUrl)
  const apiKey = optionalString(value.apiKey)
  const providedKey = optionalString(value.key)
  const knownBuiltin = builtinId ? lookupBuiltin(builtinId) : undefined
  const isOauth = builtinId ? isOpenCoworkImportOAuthBuiltin(builtinId) : false

  let kind: OpenCoworkImportChannelKind
  if (explicitKind === 'custom') {
    kind = 'custom'
  } else if (explicitKind === 'builtin' || knownBuiltin) {
    kind = 'builtin'
  } else if (builtinId && !knownBuiltin && type && baseUrl !== undefined) {
    kind = 'custom'
  } else if (!builtinId && type && baseUrl !== undefined) {
    kind = 'custom'
  } else if (builtinId) {
    kind = 'builtin'
  } else {
    return { error: 'channel is missing builtinId or custom type/baseUrl' }
  }

  if (kind === 'builtin' && isOauth) {
    return { error: 'oauth providers are not imported via this protocol' }
  }

  const key =
    providedKey ||
    (kind === 'builtin' && builtinId
      ? `builtin:${builtinId}`
      : builtinId
        ? `custom:${builtinId}`
        : undefined)
  if (!key) return { error: 'custom channel missing key' }

  const modelPolicy =
    value.modelPolicy === 'replace'
      ? 'replace'
      : value.modelPolicy === 'merge'
        ? 'merge'
        : undefined
  const models = Array.isArray(value.models)
    ? value.models
        .map(sanitizeModel)
        .filter((model): model is OpenCoworkImportModel => model !== null)
    : undefined
  const websocketMode =
    value.websocketMode === 'auto' || value.websocketMode === 'disabled'
      ? value.websocketMode
      : undefined
  const cacheTtl = value.cacheTtl === '5m' || value.cacheTtl === '1h' ? value.cacheTtl : undefined

  return {
    kind,
    key,
    ...(kind === 'builtin' && builtinId ? { builtinId } : {}),
    ...(optionalString(value.name) ? { name: optionalString(value.name) } : {}),
    ...(type ? { type } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(optionalBoolean(value.enabled) !== undefined ? { enabled: Boolean(value.enabled) } : {}),
    ...(optionalString(value.defaultModel)
      ? { defaultModel: optionalString(value.defaultModel) }
      : {}),
    ...(optionalBoolean(value.requiresApiKey) !== undefined
      ? { requiresApiKey: Boolean(value.requiresApiKey) }
      : {}),
    ...(optionalBoolean(value.useSystemProxy) !== undefined
      ? { useSystemProxy: Boolean(value.useSystemProxy) }
      : {}),
    ...(optionalBoolean(value.allowInsecureTls) !== undefined
      ? { allowInsecureTls: Boolean(value.allowInsecureTls) }
      : {}),
    ...(optionalBoolean(value.sendTemperature) !== undefined
      ? { sendTemperature: Boolean(value.sendTemperature) }
      : {}),
    ...(optionalBoolean(value.sendMaxOutputTokens) !== undefined
      ? { sendMaxOutputTokens: Boolean(value.sendMaxOutputTokens) }
      : {}),
    ...(optionalString(value.userAgent) ? { userAgent: optionalString(value.userAgent) } : {}),
    ...(sanitizeRequestOverrides(value.requestOverrides)
      ? { requestOverrides: sanitizeRequestOverrides(value.requestOverrides) }
      : {}),
    ...(sanitizeHttpsUrl(value.websocketUrl)
      ? { websocketUrl: sanitizeHttpsUrl(value.websocketUrl) }
      : {}),
    ...(websocketMode ? { websocketMode } : {}),
    ...(cacheTtl ? { cacheTtl } : {}),
    ...(models ? { models } : {}),
    ...(modelPolicy ? { modelPolicy } : {})
  }
}

function parseConfigRef(value: unknown): OpenCoworkImportConfigRef | undefined {
  if (!isRecord(value)) return undefined
  const url = stringValue(value.url)
  const token = stringValue(value.token)
  if (!url || !token) return undefined
  const expiresAt = optionalFiniteNumber(value.expiresAt)
  return { url, token, ...(expiresAt !== undefined ? { expiresAt } : {}) }
}

export function parseOpenCoworkImportPayload(value: unknown): OpenCoworkImportDocument | null {
  if (!isRecord(value)) return null
  const schemaVersion = value.schemaVersion
  const source = optionalString(value.source)
  const configRef = parseConfigRef(value.configRef)
  const rawProviders = Array.isArray(value.providers) ? value.providers : []
  const isV2 = schemaVersion === OPENCOWORK_IMPORT_SCHEMA_VERSION

  if (!isV2) {
    const first = rawProviders.find((item) => isRecord(item) && stringValue(item.apiKey))
    if (!isRecord(first)) return configRef ? { schemaVersion: 2, providers: [], configRef } : null
    const apiKey = stringValue(first.apiKey)
    if (!apiKey) return null
    const classified = classifyRoutinCredential(apiKey)
    const kindHint =
      first.kind === 'subscription' || first.kind === 'apiKey' ? first.kind : undefined
    const builtinHint =
      first.builtinId === 'routin-ai' || first.builtinId === 'routin-ai-plan'
        ? first.builtinId
        : undefined
    const classification =
      kindHint === 'subscription' ||
      builtinHint === 'routin-ai-plan' ||
      classified.kind === 'subscription'
        ? {
            ...classified,
            builtinId: 'routin-ai-plan' as const,
            kind: 'subscription' as const,
            name: 'Routin AI（套餐）',
            baseUrl: 'https://api.routin.ai/plan/v1'
          }
        : classified
    return {
      schemaVersion: 1,
      ...(source ? { source } : {}),
      providers: [
        {
          kind: 'builtin',
          key: `builtin:${classification.builtinId}`,
          builtinId: classification.builtinId,
          name: classification.name,
          apiKey,
          baseUrl: classification.baseUrl,
          enabled: true
        }
      ]
    }
  }

  const active = isRecord(value.active)
    ? {
        key: stringValue(value.active.key),
        ...(optionalString(value.active.modelId)
          ? { modelId: optionalString(value.active.modelId) }
          : {})
      }
    : undefined
  const providers: OpenCoworkImportProvider[] = []
  for (const item of rawProviders) {
    const parsed = sanitizeProvider(item)
    if (!parsed || 'error' in parsed) continue
    providers.push(parsed)
  }

  if (!providers.length && !configRef) return null
  return {
    schemaVersion: 2,
    ...(source ? { source } : {}),
    ...(active?.key ? { active } : {}),
    providers,
    ...(configRef ? { configRef } : {})
  }
}

export function documentNeedsConfigRef(document: OpenCoworkImportDocument): boolean {
  return (
    document.schemaVersion === 2 && Boolean(document.configRef) && document.providers.length === 0
  )
}

export function extractOpenCoworkImportHashPayload(rawUrl: string): unknown | null {
  const trimmed = rawUrl.trim()
  if (!trimmed) return null

  let hash = ''
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== `${OPENCOWORK_PROTOCOL}:`) return null
    hash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash
  } catch {
    const hashIndex = trimmed.indexOf('#')
    if (hashIndex < 0) return null
    if (!trimmed.startsWith(`${OPENCOWORK_PROTOCOL}:`)) return null
    hash = trimmed.slice(hashIndex + 1)
  }

  const prefix = 'settings=base64url:'
  if (!hash.startsWith(prefix)) return null
  const encoded = hash.slice(prefix.length).trim()
  if (!encoded) return null
  try {
    return decodeBase64UrlJson(encoded)
  } catch {
    return null
  }
}

export function isOpenCoworkImportUrl(rawUrl: string): boolean {
  return extractOpenCoworkImportHashPayload(rawUrl) !== null
}

export function parseOpenCoworkImportUrlDocument(rawUrl: string): OpenCoworkImportDocument | null {
  const payload = extractOpenCoworkImportHashPayload(rawUrl)
  return payload ? parseOpenCoworkImportPayload(payload) : null
}

export function encodeOpenCoworkImportUrl(payload: unknown): string {
  return `${OPENCOWORK_PROTOCOL}://import/provider#settings=base64url:${encodeBase64UrlJson(payload)}`
}

export function buildOpenCoworkDeviceLoginUrl(options?: {
  client?: 'desktop' | 'cli'
  callback?: string
  state?: string
}): string {
  const loginUrl = new URL(OPENCOWORK_DEVICE_LOGIN_URL)
  loginUrl.searchParams.set('protocol', String(OPENCOWORK_IMPORT_SCHEMA_VERSION))
  if (options?.client) loginUrl.searchParams.set('client', options.client)
  if (options?.callback) loginUrl.searchParams.set('callback', options.callback)
  if (options?.state) loginUrl.searchParams.set('state', options.state)
  return loginUrl.toString()
}

export function isAllowedOpenCoworkConfigRefUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase()
    return host === 'routin.ai' || host.endsWith('.routin.ai')
  } catch {
    return false
  }
}

export async function fetchOpenCoworkImportConfigRef(
  ref: OpenCoworkImportConfigRef,
  fetchImpl: typeof fetch = fetch
): Promise<OpenCoworkImportDocument> {
  if (!isAllowedOpenCoworkConfigRefUrl(ref.url)) {
    throw new Error('configRef url must be https on routin.ai')
  }
  if (ref.expiresAt && Date.now() > ref.expiresAt) {
    throw new Error('configRef token has expired')
  }

  const response = await fetchImpl(ref.url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${ref.token}`,
      Accept: 'application/json'
    }
  })
  if (!response.ok) {
    throw new Error(`configRef fetch failed: HTTP ${response.status}`)
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > OPENCOWORK_IMPORT_MAX_PAYLOAD_BYTES) {
    throw new Error('configRef payload is too large')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new Error('configRef response is not JSON')
  }
  const document = parseOpenCoworkImportPayload(parsed)
  if (!document || documentNeedsConfigRef(document)) {
    throw new Error('configRef response is not a usable import document')
  }
  return document
}

export function parseOpenCoworkImportCallbackBody(
  raw: unknown
): OpenCoworkImportCallbackParse | null {
  if (!isRecord(raw)) return null
  if (
    raw.schemaVersion === OPENCOWORK_IMPORT_SCHEMA_VERSION ||
    Array.isArray(raw.providers) ||
    raw.configRef
  ) {
    const document = parseOpenCoworkImportPayload(raw)
    return document ? { kind: 'document', document } : null
  }
  const apiKey = stringValue(raw.apiKey)
  if (!apiKey) return null
  return {
    kind: 'v1-credential',
    apiKey,
    ...(optionalString(raw.kind) ? { credentialKind: optionalString(raw.kind) } : {})
  }
}

export function documentFromV1Credential(apiKey: string): OpenCoworkImportDocument {
  const classified = classifyRoutinCredential(apiKey)
  return {
    schemaVersion: 1,
    source: 'routin-device-login',
    providers: [
      {
        kind: 'builtin',
        key: `builtin:${classified.builtinId}`,
        builtinId: classified.builtinId,
        name: classified.name,
        apiKey: apiKey.trim(),
        baseUrl: classified.baseUrl,
        enabled: true
      }
    ]
  }
}

function v1DefaultModel(classification: RoutinCredentialClassification): JsonRecord {
  if (classification.builtinId === 'routin-ai-plan') {
    return {
      id: 'gpt-5.5',
      name: 'GPT 5.5',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 128_000,
      supportsFunctionCall: true,
      supportsVision: true,
      supportsThinking: true
    }
  }
  return {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    enabled: true,
    contextLength: 1_000_000,
    maxOutputTokens: 384_000,
    supportsFunctionCall: true,
    supportsThinking: true,
    thinkingConfig: {
      bodyParams: { thinking: { type: 'enabled' } },
      disabledBodyParams: { thinking: { type: 'disabled' } },
      reasoningEffortLevels: ['low', 'high', 'max'],
      defaultReasoningEffort: 'high'
    }
  }
}

function cloneProviders(state: OpenCoworkImportProviderStoreState): JsonRecord[] {
  return Array.isArray(state.providers)
    ? state.providers.filter(isRecord).map((provider) => ({ ...provider }))
    : []
}

function findProviderIndex(providers: JsonRecord[], incoming: OpenCoworkImportProvider): number {
  if (incoming.kind === 'builtin' && incoming.builtinId) {
    return providers.findIndex((provider) => stringValue(provider.builtinId) === incoming.builtinId)
  }
  return providers.findIndex((provider) => stringValue(provider.importKey) === incoming.key)
}

function modelToRecord(model: OpenCoworkImportModel): JsonRecord {
  return { ...model }
}

function stubModel(id: string, name?: string): JsonRecord {
  return { id, name: name || id, enabled: true }
}

function mergeModels(
  existing: JsonRecord[],
  incoming: OpenCoworkImportModel[] | undefined,
  policy: OpenCoworkImportModelPolicy
): JsonRecord[] {
  if (!incoming) return existing
  const incomingRecords = incoming.map(modelToRecord)
  if (policy === 'replace') return incomingRecords

  const byId = new Map<string, JsonRecord>()
  for (const model of existing) {
    const id = stringValue(model.id)
    if (id) byId.set(id, { ...model })
  }
  for (const model of incomingRecords) {
    const id = stringValue(model.id)
    if (!id) continue
    const previous = byId.get(id)
    byId.set(id, previous ? { ...previous, ...model } : model)
  }

  const result: JsonRecord[] = []
  const seen = new Set<string>()
  for (const model of existing) {
    const id = stringValue(model.id)
    const next = id ? byId.get(id) : undefined
    if (!id || !next || seen.has(id)) continue
    result.push(next)
    seen.add(id)
  }
  for (const model of incomingRecords) {
    const id = stringValue(model.id)
    if (!id || seen.has(id)) continue
    const next = byId.get(id)
    if (!next) continue
    result.push(next)
    seen.add(id)
  }
  return result
}

function overlayProvider(
  existing: JsonRecord | undefined,
  incoming: OpenCoworkImportProvider,
  options: { createId: () => string; now: number; catalog?: OpenCoworkImportBuiltinCatalogEntry }
): JsonRecord {
  const catalog = options.catalog
  const created = !existing
  const providerId = stringValue(existing?.id) || options.createId()
  const next: JsonRecord = existing ? { ...existing } : {}
  next.id = providerId
  next.authMode = 'apiKey'
  if (incoming.kind === 'builtin' && incoming.builtinId) {
    next.builtinId = incoming.builtinId
    if (created) next.presetVersion = 0
  } else {
    next.importKey = incoming.key
    delete next.builtinId
  }
  if (created) next.createdAt = options.now

  const name = incoming.name || stringValue(next.name) || catalog?.name || incoming.key
  next.name = name
  next.type = incoming.type || stringValue(next.type) || catalog?.type || 'openai-chat'
  if (incoming.apiKey !== undefined) next.apiKey = incoming.apiKey
  else if (created) next.apiKey = ''
  if (incoming.baseUrl !== undefined) next.baseUrl = incoming.baseUrl
  else if (created) next.baseUrl = catalog?.defaultBaseUrl ?? ''
  if (incoming.enabled !== undefined) next.enabled = incoming.enabled
  else if (created) next.enabled = true
  if (incoming.requiresApiKey !== undefined) next.requiresApiKey = incoming.requiresApiKey
  else if (created) next.requiresApiKey = catalog?.requiresApiKey ?? true
  if (incoming.useSystemProxy !== undefined) next.useSystemProxy = incoming.useSystemProxy
  if (incoming.allowInsecureTls !== undefined) next.allowInsecureTls = incoming.allowInsecureTls
  if (incoming.sendTemperature !== undefined) next.sendTemperature = incoming.sendTemperature
  if (incoming.sendMaxOutputTokens !== undefined)
    next.sendMaxOutputTokens = incoming.sendMaxOutputTokens
  if (incoming.userAgent !== undefined) next.userAgent = incoming.userAgent
  if (incoming.requestOverrides !== undefined) next.requestOverrides = incoming.requestOverrides
  if (incoming.websocketUrl !== undefined) next.websocketUrl = incoming.websocketUrl
  if (incoming.websocketMode !== undefined) next.websocketMode = incoming.websocketMode
  if (incoming.cacheTtl !== undefined) next.cacheTtl = incoming.cacheTtl

  const existingModels = Array.isArray(next.models) ? next.models.filter(isRecord) : []
  const policy = incoming.modelPolicy ?? 'merge'
  let models = mergeModels(existingModels, incoming.models, policy)
  if (created && models.length === 0) {
    if (incoming.defaultModel) models = [stubModel(incoming.defaultModel)]
    else if (catalog?.defaultModel) models = [stubModel(catalog.defaultModel)]
  }
  next.models = models
  if (incoming.defaultModel) next.defaultModel = incoming.defaultModel
  else if (!stringValue(next.defaultModel) && models[0]) {
    next.defaultModel = stringValue(models[0].id)
  }
  return next
}

function resolveAppliedModelId(provider: JsonRecord, preferred?: string): string {
  const models = Array.isArray(provider.models) ? provider.models.filter(isRecord) : []
  if (preferred && models.some((model) => stringValue(model.id) === preferred)) return preferred
  const defaultModel = stringValue(provider.defaultModel)
  if (defaultModel && models.some((model) => stringValue(model.id) === defaultModel)) {
    return defaultModel
  }
  return stringValue(models[0]?.id) || defaultModel
}

function applyV1Routin(
  state: OpenCoworkImportProviderStoreState,
  incoming: OpenCoworkImportProvider,
  options: ApplyOpenCoworkImportOptions
): ApplyOpenCoworkImportResult {
  const apiKey = stringValue(incoming.apiKey)
  const classified = classifyRoutinCredential(apiKey)
  const now = options.now ?? Date.now()
  const providers = cloneProviders(state)
  const model = v1DefaultModel(classified)
  const modelId = stringValue(model.id)
  const existingIndex = providers.findIndex(
    (provider) => stringValue(provider.builtinId) === classified.builtinId
  )
  let providerId = ''
  let created = false
  if (existingIndex >= 0) {
    const existing = providers[existingIndex]
    providerId = stringValue(existing.id) || options.createId()
    const models = Array.isArray(existing.models) ? existing.models.filter(isRecord) : []
    const hasModel = models.some((candidate) => stringValue(candidate.id) === modelId)
    providers[existingIndex] = {
      ...existing,
      id: providerId,
      name: stringValue(existing.name) || classified.name,
      type: stringValue(existing.type) || 'openai-chat',
      apiKey,
      baseUrl: classified.baseUrl,
      enabled: true,
      builtinId: classified.builtinId,
      requiresApiKey: true,
      authMode: 'apiKey',
      defaultModel: modelId,
      models: hasModel ? models : [...models, model]
    }
  } else {
    created = true
    providerId = options.createId()
    providers.push({
      id: providerId,
      name: classified.name,
      type: 'openai-chat',
      apiKey,
      baseUrl: classified.baseUrl,
      enabled: true,
      models: [model],
      builtinId: classified.builtinId,
      presetVersion: 0,
      createdAt: now,
      requiresApiKey: true,
      authMode: 'apiKey',
      defaultModel: modelId
    })
  }

  return {
    state: {
      ...state,
      providers,
      activeProviderId: providerId,
      activeModelId: modelId
    },
    applied: [
      {
        key: `builtin:${classified.builtinId}`,
        providerId,
        providerName: classified.name,
        modelId,
        builtinId: classified.builtinId,
        created
      }
    ],
    skipped: []
  }
}

export function applyOpenCoworkImportDocument(
  state: OpenCoworkImportProviderStoreState,
  document: OpenCoworkImportDocument,
  options: ApplyOpenCoworkImportOptions
): ApplyOpenCoworkImportResult {
  if (document.schemaVersion === 1) {
    const first = document.providers[0]
    if (!first?.apiKey) {
      return {
        state,
        applied: [],
        skipped: [{ key: first?.key ?? 'unknown', reason: 'missing apiKey' }]
      }
    }
    return applyV1Routin(state, first, options)
  }

  const now = options.now ?? Date.now()
  const providers = cloneProviders(state)
  const applied: OpenCoworkImportAppliedProvider[] = []
  const skipped: OpenCoworkImportSkippedProvider[] = []

  for (const incoming of document.providers) {
    if (
      incoming.kind === 'builtin' &&
      incoming.builtinId &&
      isOpenCoworkImportOAuthBuiltin(incoming.builtinId)
    ) {
      skipped.push({
        key: incoming.key,
        reason: 'oauth providers are not imported via this protocol'
      })
      continue
    }

    let resolved = incoming
    const catalog = incoming.builtinId ? lookupBuiltin(incoming.builtinId) : undefined
    if (incoming.kind === 'builtin' && incoming.builtinId && !catalog) {
      if (incoming.type && incoming.baseUrl !== undefined) {
        resolved = {
          ...incoming,
          kind: 'custom',
          key: incoming.key.startsWith('builtin:') ? `custom:${incoming.builtinId}` : incoming.key,
          builtinId: undefined
        }
      } else {
        skipped.push({ key: incoming.key, reason: `unknown builtinId ${incoming.builtinId}` })
        continue
      }
    }

    const existingIndex = findProviderIndex(providers, resolved)
    const existing = existingIndex >= 0 ? providers[existingIndex] : undefined
    const requiresApiKey =
      resolved.requiresApiKey ??
      catalog?.requiresApiKey ??
      (typeof existing?.requiresApiKey === 'boolean' ? existing.requiresApiKey : true)
    const hasApiKey = Boolean(resolved.apiKey || stringValue(existing?.apiKey))
    if (requiresApiKey !== false && !hasApiKey) {
      skipped.push({ key: incoming.key, reason: 'missing apiKey' })
      continue
    }
    if (resolved.kind === 'custom' && !resolved.name && !stringValue(existing?.name)) {
      skipped.push({ key: incoming.key, reason: 'custom channel missing name' })
      continue
    }
    if (resolved.kind === 'custom' && !resolved.type && !stringValue(existing?.type)) {
      skipped.push({ key: incoming.key, reason: 'custom channel missing type' })
      continue
    }
    if (
      resolved.kind === 'custom' &&
      resolved.baseUrl === undefined &&
      stringValue(existing?.baseUrl) === '' &&
      !existing
    ) {
      skipped.push({ key: incoming.key, reason: 'custom channel missing baseUrl' })
      continue
    }

    const next = overlayProvider(existing, resolved, { createId: options.createId, now, catalog })
    if (existingIndex >= 0) providers[existingIndex] = next
    else providers.push(next)

    const modelId = resolveAppliedModelId(next, resolved.defaultModel)
    applied.push({
      key: resolved.key,
      providerId: stringValue(next.id),
      providerName: stringValue(next.name) || resolved.key,
      modelId,
      ...(resolved.builtinId ? { builtinId: resolved.builtinId } : {}),
      ...(resolved.kind === 'custom' ? { importKey: resolved.key } : {}),
      created: existingIndex < 0
    })
  }

  let activeProviderId = stringValue(state.activeProviderId)
  let activeModelId = stringValue(state.activeModelId)
  if (document.active?.key) {
    const selected =
      applied.find((item) => item.key === document.active?.key) ??
      applied.find((item) => item.builtinId && `builtin:${item.builtinId}` === document.active?.key)
    if (selected) {
      activeProviderId = selected.providerId
      activeModelId = document.active.modelId || selected.modelId
    }
  } else if (applied[0]) {
    activeProviderId = applied[0].providerId
    activeModelId = applied[0].modelId
  }

  return {
    state: {
      ...state,
      providers,
      ...(applied.length ? { activeProviderId, activeModelId } : {})
    },
    applied,
    skipped
  }
}
