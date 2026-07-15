import { useState, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import {
  Plus,
  Search,
  Eye,
  EyeOff,
  Loader2,
  Trash2,
  RefreshCw,
  Brain,
  ExternalLink,
  Pencil,
  Code2,
  Image as ImageIcon,
  Mic,
  Shapes,
  Sparkles,
  Copy,
  MonitorSmartphone,
  Layers
} from 'lucide-react'
import { nanoid } from 'nanoid'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { Separator } from '@renderer/components/ui/separator'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@renderer/components/ui/context-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import {
  useProviderStore,
  builtinProviderPresets,
  buildProviderModelSnapshot,
  modelSupportsComputerUse,
  modelSupportsVision,
  normalizeModelKey,
  normalizeProviderBaseUrl,
  type ManagedModelConfig
} from '@renderer/stores/provider-store'
import {
  useQuotaStore,
  type CodexQuota,
  type CodexQuotaWindow,
  type CopilotQuota
} from '@renderer/stores/quota-store'
import {
  startProviderOAuth,
  disconnectProviderOAuth,
  refreshProviderOAuth,
  applyManualProviderOAuth,
  ensureProviderAuthReady,
  sendProviderChannelCode,
  verifyProviderChannelCode,
  refreshProviderChannelUserInfo,
  clearProviderChannelAuth
} from '@renderer/lib/auth/provider-auth'
import {
  buildMoonshotCommonHeaders,
  isMoonshotProviderConfig,
  type OAuthDeviceCodeInfo
} from '@renderer/lib/auth/oauth'
import { clearCopilotQuota, exchangeCopilotToken } from '@renderer/lib/auth/copilot'
import { AccountListEditor } from './AccountListEditor'
import type {
  ProviderType,
  AIModelConfig,
  AIProvider,
  ThinkingConfig,
  ModelCategory,
  ReasoningEffortLevel,
  ResponsesImageGenerationAction,
  ResponsesImageGenerationBackground,
  ResponsesImageGenerationInputFidelity,
  ResponsesImageGenerationModeration,
  ResponsesImageGenerationOutputFormat,
  ResponsesImageGenerationQuality,
  ResponsesImageGenerationSize
} from '@renderer/lib/api/types'
import {
  RESPONSES_IMAGE_GENERATION_ACTIONS,
  RESPONSES_IMAGE_GENERATION_BACKGROUNDS,
  RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION,
  RESPONSES_IMAGE_GENERATION_DEFAULT_PARTIAL_IMAGES,
  RESPONSES_IMAGE_GENERATION_INPUT_FIDELITIES,
  RESPONSES_IMAGE_GENERATION_MODERATIONS,
  RESPONSES_IMAGE_GENERATION_OUTPUT_FORMATS,
  RESPONSES_IMAGE_GENERATION_QUALITIES,
  RESPONSES_IMAGE_GENERATION_SIZES,
  normalizeResponsesImageGenerationOutputCompression,
  normalizeResponsesImageGenerationPartialImages
} from '@renderer/lib/api/responses-image-generation'
import { resolveProviderUserAgent } from '@renderer/lib/api/api-user-agent'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { ProviderIcon, ModelIcon } from './provider-icons'
import {
  clampCompressionThreshold,
  DEFAULT_CONTEXT_COMPRESSION_THRESHOLD,
  MAX_CONTEXT_COMPRESSION_THRESHOLD,
  MIN_CONTEXT_COMPRESSION_THRESHOLD
} from '@renderer/lib/agent/context-compression'

const MODEL_ICON_OPTIONS = [
  'openai',
  'claude',
  'anthropic',
  'gemini',
  'deepseek',
  'qwen',
  'chatglm',
  'minimax',
  'kimi',
  'moonshot',
  'grok',
  'meta',
  'llama',
  'mistral',
  'baidu',
  'hunyuan',
  'nvidia',
  'stepfun',
  'doubao',
  'ollama',
  'siliconcloud',
  'mimo',
  'bigmodel'
] as const

const REASONING_EFFORT_OPTIONS: ReasoningEffortLevel[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
]

const ALL_PROVIDER_FILTER = '__all__'
const CUSTOM_PROVIDER_KEY_PREFIX = 'provider:'
const BUILTIN_PROVIDER_KEY_PREFIX = 'builtin:'

type ManagedModelProviderSource = {
  key: string
  name: string
  type: ProviderType
  builtinId?: string
  configured: boolean
  enabled?: boolean
}

function toOptionalSelectValue<T extends string>(
  value?: T
): T | typeof RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION {
  return value ?? RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION
}

function toModelConfig(model: ManagedModelConfig): AIModelConfig {
  const { normalizedKey, ...nextModel } = model
  void normalizedKey
  return nextModel
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value)
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed)
    }
  }
  return undefined
}

function toRoundedTokenThousands(value: number): number {
  return Math.round(value / 1_000)
}

function readDiscoveredModelInteger(
  model: Record<string, unknown>,
  keys: string[]
): number | undefined {
  for (const key of keys) {
    const normalized = normalizePositiveInteger(model[key])
    if (normalized) return normalized
  }
  return undefined
}

function resolveBuiltinDiscoveredModelFallback(
  builtinId: string | undefined,
  modelId: string
): AIModelConfig | undefined {
  if (!builtinId) return undefined
  const builtinPreset = builtinProviderPresets.find((preset) => preset.builtinId === builtinId)
  if (!builtinPreset) return undefined
  const modelKey = normalizeModelKey(modelId)
  return builtinPreset.defaultModels.find((model) => normalizeModelKey(model.id) === modelKey)
}

function toDiscoveredModelConfig(
  rawModel: Record<string, unknown>,
  options: {
    builtinId?: string
    id?: string
    name?: string
  } = {}
): AIModelConfig | null {
  const idCandidate =
    options.id ??
    (typeof rawModel.id === 'string' && rawModel.id.trim()
      ? rawModel.id.trim()
      : typeof rawModel.slug === 'string' && rawModel.slug.trim()
        ? rawModel.slug.trim()
        : '')
  if (!idCandidate) return null

  const fallback = resolveBuiltinDiscoveredModelFallback(options.builtinId, idCandidate)
  const resolvedName =
    options.name?.trim() ||
    (typeof rawModel.name === 'string' && rawModel.name.trim()) ||
    (typeof rawModel.display_name === 'string' && rawModel.display_name.trim()) ||
    (typeof rawModel.displayName === 'string' && rawModel.displayName.trim()) ||
    fallback?.name ||
    idCandidate
  const contextLength =
    readDiscoveredModelInteger(rawModel, [
      'context_length',
      'contextLength',
      'max_context_length',
      'maxContextLength',
      'input_token_limit',
      'inputTokenLimit',
      'max_input_tokens',
      'maxInputTokens'
    ]) ?? fallback?.contextLength
  const maxOutputTokens =
    readDiscoveredModelInteger(rawModel, [
      'max_output_tokens',
      'maxOutputTokens',
      'output_token_limit',
      'outputTokenLimit',
      'max_completion_tokens',
      'maxCompletionTokens'
    ]) ?? fallback?.maxOutputTokens

  return {
    ...(fallback ?? {}),
    id: idCandidate,
    name: resolvedName,
    enabled: true,
    ...(contextLength ? { contextLength } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {})
  }
}

function getProviderSourceKey(provider: Pick<AIProvider, 'id' | 'builtinId'>): string {
  return provider.builtinId
    ? `${BUILTIN_PROVIDER_KEY_PREFIX}${provider.builtinId}`
    : `${CUSTOM_PROVIDER_KEY_PREFIX}${provider.id}`
}

function addManagedModelProviderSource(
  index: Map<string, ManagedModelProviderSource[]>,
  modelId: string,
  source: ManagedModelProviderSource
): void {
  const modelKey = normalizeModelKey(modelId)
  const sources = index.get(modelKey) ?? []
  const existingIndex = sources.findIndex((item) => item.key === source.key)

  if (existingIndex >= 0) {
    const existing = sources[existingIndex]
    sources[existingIndex] = {
      ...existing,
      ...source,
      configured: existing.configured || source.configured,
      enabled: existing.enabled || source.enabled
    }
    index.set(modelKey, sources)
    return
  }

  index.set(modelKey, [...sources, source])
}

function sortManagedModelProviderSources(
  sources: ManagedModelProviderSource[]
): ManagedModelProviderSource[] {
  return [...sources].sort((a, b) => {
    const rank = (source: ManagedModelProviderSource): number => {
      if (source.configured && source.enabled) return 0
      if (source.configured) return 1
      return 2
    }
    const rankCompare = rank(a) - rank(b)
    if (rankCompare !== 0) return rankCompare
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

function buildManagedModelProviderSourceIndex(
  providers: AIProvider[]
): Map<string, ManagedModelProviderSource[]> {
  const index = new Map<string, ManagedModelProviderSource[]>()

  for (const provider of providers) {
    const source: ManagedModelProviderSource = {
      key: getProviderSourceKey(provider),
      name: provider.name,
      type: provider.type,
      builtinId: provider.builtinId,
      configured: true,
      enabled: provider.enabled
    }

    for (const model of provider.models) {
      addManagedModelProviderSource(index, model.id, source)
    }
  }

  for (const preset of builtinProviderPresets) {
    const source: ManagedModelProviderSource = {
      key: `${BUILTIN_PROVIDER_KEY_PREFIX}${preset.builtinId}`,
      name: preset.name,
      type: preset.type,
      builtinId: preset.builtinId,
      configured: false
    }

    for (const model of preset.defaultModels) {
      addManagedModelProviderSource(index, model.id, source)
    }
  }

  for (const [modelKey, sources] of index) {
    index.set(modelKey, sortManagedModelProviderSources(sources))
  }

  return index
}

// --- Fetch models from provider API ---

// The ChatGPT Codex backend requires a client_version query param (the version Codex CLI reports).
const CODEX_CLIENT_VERSION_FALLBACK = '0.144.1'

function withCodexClientVersion(url: string, userAgent?: string): string {
  const version =
    userAgent?.match(/codex_cli_rs\/(\d+(?:\.\d+)*)/i)?.[1] ?? CODEX_CLIENT_VERSION_FALLBACK
  return `${url}${url.includes('?') ? '&' : '?'}client_version=${encodeURIComponent(version)}`
}

async function fetchModelsFromProvider(
  type: ProviderType,
  baseUrl: string,
  apiKey: string,
  builtinId?: string,
  useSystemProxy?: boolean,
  userAgent?: string,
  oauth?: AIProvider['oauth']
): Promise<AIModelConfig[]> {
  const useAnthropicCompatAuth = builtinId === 'longcat'
  const resolvedUserAgent = resolveProviderUserAgent(userAgent)

  if (builtinId === 'openrouter') {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    headers['User-Agent'] = resolvedUserAgent
    const result = (await ipcClient.invoke('api:request', {
      url: 'https://openrouter.ai/api/frontend/models/find',
      method: 'GET',
      headers,
      useSystemProxy
    })) as { statusCode?: number; body?: string; error?: string }
    if (result?.error) throw new Error(result.error)
    const data = JSON.parse(result.body ?? '{}')
    const models = data?.data?.models ?? data?.data ?? []
    return models
      .slice(0, 200)
      .map((model: Record<string, unknown>) => toDiscoveredModelConfig(model, { builtinId }))
      .filter((model): model is AIModelConfig => Boolean(model))
  }

  // For OpenAI-compatible providers: GET /v1/models
  if (type === 'openai-chat' || type === 'openai-responses') {
    let url = `${(baseUrl || 'https://api.openai.com').replace(/\/+$/, '')}/models`
    if (builtinId === 'codex-oauth') {
      url = withCodexClientVersion(url, resolvedUserAgent)
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    headers['User-Agent'] = resolvedUserAgent
    if (isMoonshotProviderConfig({ providerBuiltinId: builtinId, baseUrl })) {
      Object.assign(headers, await buildMoonshotCommonHeaders(oauth?.deviceId))
    }
    if (builtinId === 'copilot-oauth') {
      headers['Copilot-Integration-Id'] = 'vscode-chat'
      headers['editor-version'] = 'vscode/1.105.0'
      headers['editor-plugin-version'] = 'copilot-chat/0.26.7'
    }
    const result = (await ipcClient.invoke('api:request', {
      url,
      method: 'GET',
      headers,
      useSystemProxy
    })) as { statusCode?: number; body?: string; error?: string }
    if (result?.error) throw new Error(result.error)
    if (result?.statusCode && result.statusCode >= 400) {
      throw new Error(`HTTP ${result.statusCode}: ${result.body?.slice(0, 200)}`)
    }
    const data = JSON.parse(result.body ?? '{}')
    const models = data?.data ?? []
    return models
      .map((model: Record<string, unknown>) => toDiscoveredModelConfig(model, { builtinId }))
      .filter((model): model is AIModelConfig => Boolean(model))
  }

  if (type === 'anthropic') {
    const url = `${normalizeProviderBaseUrl(baseUrl || 'https://api.anthropic.com', type)}/v1/models`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01'
    }
    if (apiKey) {
      if (useAnthropicCompatAuth) {
        headers['Authorization'] = `Bearer ${apiKey}`
        headers['x-api-key'] = apiKey
      } else {
        headers['x-api-key'] = apiKey
      }
    }
    headers['User-Agent'] = resolvedUserAgent
    const result = (await ipcClient.invoke('api:request', {
      url,
      method: 'GET',
      headers,
      useSystemProxy
    })) as { statusCode?: number; body?: string; error?: string }
    if (result?.error) throw new Error(result.error)
    if (result?.statusCode && result.statusCode >= 400) {
      throw new Error(`HTTP ${result.statusCode}: ${result.body?.slice(0, 200)}`)
    }
    const data = JSON.parse(result.body ?? '{}')
    const models = data?.data ?? []
    const discoveredModels = models
      .map((model: Record<string, unknown>) => toDiscoveredModelConfig(model, { builtinId }))
      .filter((model): model is AIModelConfig => Boolean(model))

    if (discoveredModels.length > 0) {
      return discoveredModels
    }
  }

  if (type === 'anthropic' && builtinId) {
    const builtinPreset = builtinProviderPresets.find((preset) => preset.builtinId === builtinId)
    if (builtinPreset?.defaultModels.length) {
      return builtinPreset.defaultModels.map((model) => ({ ...model }))
    }
  }
  return []
}

// --- Add Custom Provider Dialog ---

function AddProviderDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const addProvider = useProviderStore((s) => s.addProvider)
  const [name, setName] = useState('')
  const [type, setType] = useState<ProviderType>('openai-chat')
  const [baseUrl, setBaseUrl] = useState('')

  const handleAdd = (): void => {
    if (!name.trim()) return
    addProvider({
      id: nanoid(),
      name: name.trim(),
      type,
      apiKey: '',
      baseUrl: baseUrl.trim(),
      enabled: false,
      models: [],
      createdAt: Date.now()
    })
    toast.success(t('provider.addedProvider', { name: name.trim() }))
    setName('')
    setBaseUrl('')
    setType('openai-chat')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('provider.addCustomProvider')}</DialogTitle>
          <DialogDescription>{t('provider.addCustomProviderDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('provider.providerName')}</label>
            <Input
              placeholder={t('provider.providerNamePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('provider.protocolType')}</label>
            <Select value={type} onValueChange={(v) => setType(v as ProviderType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai-chat">{t('provider.openaiChatCompat')}</SelectItem>
                <SelectItem value="openai-responses">{t('provider.openaiResponses')}</SelectItem>
                <SelectItem value="anthropic">{t('provider.anthropicMessages')}</SelectItem>
                <SelectItem value="gemini">Gemini</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('provider.baseUrl')}</label>
            <Input
              placeholder="https://api.example.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('provider.baseUrlHint')}</p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('action.cancel', { ns: 'common' })}
            </Button>
            <Button disabled={!name.trim()} onClick={handleAdd}>
              {t('provider.add')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// --- Add / Edit Model Dialog ---

function ModelFormDialog({
  open,
  onOpenChange,
  providerType,
  initial,
  onSave,
  resolveManagedModel,
  allowIdEditing = false
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  providerType?: ProviderType | null
  initial?: AIModelConfig
  onSave: (model: AIModelConfig) => void | boolean
  resolveManagedModel?: (modelId: string) => ManagedModelConfig | null
  allowIdEditing?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const isEdit = !!initial

  const [id, setId] = useState(initial?.id ?? '')
  const [name, setName] = useState(initial?.name ?? '')
  const [typeOverride, setTypeOverride] = useState<ProviderType | 'none'>(initial?.type ?? 'none')
  const [category, setCategory] = useState<ModelCategory>(initial?.category ?? 'chat')
  const [contextLength, setContextLength] = useState(initial?.contextLength?.toString() ?? '')
  const [maxOutputTokens, setMaxOutputTokens] = useState(initial?.maxOutputTokens?.toString() ?? '')
  const [contextCompressionThreshold, setContextCompressionThreshold] = useState(
    Math.round(
      clampCompressionThreshold(
        initial?.contextCompressionThreshold ?? DEFAULT_CONTEXT_COMPRESSION_THRESHOLD
      ) * 100
    ).toString()
  )
  const [inputPrice, setInputPrice] = useState(initial?.inputPrice?.toString() ?? '')
  const [outputPrice, setOutputPrice] = useState(initial?.outputPrice?.toString() ?? '')
  const [cacheCreationPrice, setCacheCreationPrice] = useState(
    initial?.cacheCreationPrice?.toString() ?? ''
  )
  const [cacheHitPrice, setCacheHitPrice] = useState(initial?.cacheHitPrice?.toString() ?? '')
  const [premiumRequestMultiplier, setPremiumRequestMultiplier] = useState(
    initial?.premiumRequestMultiplier?.toString() ?? ''
  )
  const [availablePlans, setAvailablePlans] = useState(initial?.availablePlans?.join(', ') ?? '')
  const [supportsVision, setSupportsVision] = useState(initial?.supportsVision ?? false)
  const [supportsFunctionCall, setSupportsFunctionCall] = useState(
    initial?.supportsFunctionCall ?? true
  )
  const [supportsComputerUse, setSupportsComputerUse] = useState(
    initial?.supportsComputerUse ?? false
  )
  const [enableComputerUse, setEnableComputerUse] = useState(initial?.enableComputerUse ?? false)
  const [supportsBuiltinSearch, setSupportsBuiltinSearch] = useState(
    initial?.supportsBuiltinSearch ?? false
  )
  // Defaults to on so checking "supports" immediately activates the search tool.
  const [enableBuiltinSearch, setEnableBuiltinSearch] = useState(
    initial?.enableBuiltinSearch ?? true
  )
  const [supportsFastMode, setSupportsFastMode] = useState(initial?.serviceTier === 'priority')
  const [supportsWebsocket, setSupportsWebsocket] = useState(initial?.supportsWebsocket ?? false)
  const [supportsImageGeneration, setSupportsImageGeneration] = useState(
    initial?.supportsImageGeneration ?? false
  )
  const [icon, setIcon] = useState(initial?.icon ?? '')
  const [responseSummary, setResponseSummary] = useState<'auto' | 'concise' | 'detailed' | 'none'>(
    initial?.responseSummary ?? 'none'
  )
  const [websocketMode, setWebsocketMode] = useState<'auto' | 'disabled'>(
    initial?.websocketMode ?? 'disabled'
  )
  const [enableSystemPromptCache, setEnableSystemPromptCache] = useState(
    initial?.enableSystemPromptCache ?? true
  )
  const [cacheTtl, setCacheTtl] = useState<'5m' | '1h'>(initial?.cacheTtl ?? '5m')
  const [responsesImageGenerationEnabled, setResponsesImageGenerationEnabled] = useState(
    initial?.responsesImageGeneration?.enabled ?? true
  )
  const [responsesImageGenerationAction, setResponsesImageGenerationAction] = useState<
    ResponsesImageGenerationAction | typeof RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION
  >(toOptionalSelectValue(initial?.responsesImageGeneration?.action))
  const [responsesImageGenerationBackground, setResponsesImageGenerationBackground] = useState<
    ResponsesImageGenerationBackground | typeof RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION
  >(toOptionalSelectValue(initial?.responsesImageGeneration?.background))
  const [responsesImageGenerationInputFidelity, setResponsesImageGenerationInputFidelity] =
    useState<
      ResponsesImageGenerationInputFidelity | typeof RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION
    >(toOptionalSelectValue(initial?.responsesImageGeneration?.inputFidelity))
  const [responsesImageGenerationModeration, setResponsesImageGenerationModeration] = useState<
    ResponsesImageGenerationModeration | typeof RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION
  >(toOptionalSelectValue(initial?.responsesImageGeneration?.moderation))
  const [responsesImageGenerationOutputFormat, setResponsesImageGenerationOutputFormat] = useState<
    ResponsesImageGenerationOutputFormat | typeof RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION
  >(toOptionalSelectValue(initial?.responsesImageGeneration?.outputFormat))
  const [responsesImageGenerationQuality, setResponsesImageGenerationQuality] = useState<
    ResponsesImageGenerationQuality | typeof RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION
  >(toOptionalSelectValue(initial?.responsesImageGeneration?.quality))
  const [responsesImageGenerationSize, setResponsesImageGenerationSize] = useState<
    ResponsesImageGenerationSize | typeof RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION
  >(toOptionalSelectValue(initial?.responsesImageGeneration?.size))
  const [responsesImageGenerationOutputCompression, setResponsesImageGenerationOutputCompression] =
    useState(initial?.responsesImageGeneration?.outputCompression?.toString() ?? '')
  const [responsesImageGenerationPartialImages, setResponsesImageGenerationPartialImages] =
    useState(initial?.responsesImageGeneration?.partialImages?.toString() ?? '')
  const reusableManagedModel =
    !isEdit && id.trim() ? (resolveManagedModel?.(id.trim()) ?? null) : null

  const applyReusableModelDefaults = (model: AIModelConfig): void => {
    setName(model.name)
    setTypeOverride(model.type ?? 'none')
    setCategory(model.category ?? 'chat')
    setContextLength(model.contextLength?.toString() ?? '')
    setMaxOutputTokens(model.maxOutputTokens?.toString() ?? '')
    setContextCompressionThreshold(
      Math.round(
        clampCompressionThreshold(
          model.contextCompressionThreshold ?? DEFAULT_CONTEXT_COMPRESSION_THRESHOLD
        ) * 100
      ).toString()
    )
    setInputPrice(model.inputPrice?.toString() ?? '')
    setOutputPrice(model.outputPrice?.toString() ?? '')
    setCacheCreationPrice(model.cacheCreationPrice?.toString() ?? '')
    setCacheHitPrice(model.cacheHitPrice?.toString() ?? '')
    setPremiumRequestMultiplier(model.premiumRequestMultiplier?.toString() ?? '')
    setAvailablePlans(model.availablePlans?.join(', ') ?? '')
    setSupportsVision(model.supportsVision ?? false)
    setSupportsFunctionCall(model.supportsFunctionCall ?? true)
    setSupportsComputerUse(model.supportsComputerUse ?? false)
    setEnableComputerUse(model.enableComputerUse ?? false)
    setSupportsBuiltinSearch(model.supportsBuiltinSearch ?? false)
    setEnableBuiltinSearch(model.enableBuiltinSearch ?? true)
    setSupportsFastMode(model.serviceTier === 'priority')
    setSupportsWebsocket(model.supportsWebsocket ?? false)
    setSupportsImageGeneration(model.supportsImageGeneration ?? false)
    setIcon(model.icon ?? '')
    setResponseSummary(model.responseSummary ?? 'none')
    setWebsocketMode(model.websocketMode ?? 'disabled')
    setEnableSystemPromptCache(model.enableSystemPromptCache ?? true)
    setCacheTtl(model.cacheTtl ?? '5m')
    setResponsesImageGenerationEnabled(model.responsesImageGeneration?.enabled ?? true)
    setResponsesImageGenerationAction(toOptionalSelectValue(model.responsesImageGeneration?.action))
    setResponsesImageGenerationBackground(
      toOptionalSelectValue(model.responsesImageGeneration?.background)
    )
    setResponsesImageGenerationInputFidelity(
      toOptionalSelectValue(model.responsesImageGeneration?.inputFidelity)
    )
    setResponsesImageGenerationModeration(
      toOptionalSelectValue(model.responsesImageGeneration?.moderation)
    )
    setResponsesImageGenerationOutputFormat(
      toOptionalSelectValue(model.responsesImageGeneration?.outputFormat)
    )
    setResponsesImageGenerationQuality(
      toOptionalSelectValue(model.responsesImageGeneration?.quality)
    )
    setResponsesImageGenerationSize(toOptionalSelectValue(model.responsesImageGeneration?.size))
    setResponsesImageGenerationOutputCompression(
      model.responsesImageGeneration?.outputCompression?.toString() ?? ''
    )
    setResponsesImageGenerationPartialImages(
      model.responsesImageGeneration?.partialImages?.toString() ?? ''
    )
  }

  const handleModelIdChange = (value: string): void => {
    setId(value)
    if (isEdit) return
    const reusableModel = value.trim() ? resolveManagedModel?.(value.trim()) : null
    if (reusableModel) {
      applyReusableModelDefaults(toModelConfig(reusableModel))
    }
  }

  const requestType = typeOverride === 'none' ? providerType : typeOverride
  const isResponsesModel = requestType === 'openai-responses'
  const isAnthropicModel = requestType === 'anthropic'
  const isOpenAiChatModel = requestType === 'openai-chat'
  const handleSave = (): void => {
    const modelId = id.trim()
    if (!modelId) return
    const managedDefaults = !isEdit ? resolveManagedModel?.(modelId) : null
    const model: AIModelConfig = managedDefaults
      ? toModelConfig(managedDefaults)
      : {
          id: modelId,
          name: name.trim() || modelId,
          enabled: initial?.enabled ?? true
        }
    model.id = modelId
    model.name = name.trim() || modelId
    model.enabled = initial?.enabled ?? true
    model.category = category
    if (typeOverride && typeOverride !== 'none') model.type = typeOverride
    else delete model.type
    if (contextLength.trim()) {
      const v = parseInt(contextLength)
      if (!isNaN(v)) model.contextLength = v
    } else {
      delete model.contextLength
    }
    if (maxOutputTokens.trim()) {
      const v = parseInt(maxOutputTokens)
      if (!isNaN(v)) model.maxOutputTokens = v
    } else {
      delete model.maxOutputTokens
    }
    if (contextCompressionThreshold.trim()) {
      const v = parseFloat(contextCompressionThreshold)
      if (!isNaN(v)) {
        model.contextCompressionThreshold = clampCompressionThreshold(v / 100)
      }
    } else {
      delete model.contextCompressionThreshold
    }
    if (inputPrice.trim()) {
      const v = parseFloat(inputPrice)
      if (!isNaN(v)) model.inputPrice = v
    } else {
      delete model.inputPrice
    }
    if (outputPrice.trim()) {
      const v = parseFloat(outputPrice)
      if (!isNaN(v)) model.outputPrice = v
    } else {
      delete model.outputPrice
    }
    if (cacheCreationPrice.trim()) {
      const v = parseFloat(cacheCreationPrice)
      if (!isNaN(v)) model.cacheCreationPrice = v
    } else {
      delete model.cacheCreationPrice
    }
    if (cacheHitPrice.trim()) {
      const v = parseFloat(cacheHitPrice)
      if (!isNaN(v)) model.cacheHitPrice = v
    } else {
      delete model.cacheHitPrice
    }
    if (premiumRequestMultiplier.trim()) {
      const v = parseFloat(premiumRequestMultiplier)
      if (!isNaN(v)) model.premiumRequestMultiplier = v
    } else {
      delete model.premiumRequestMultiplier
    }
    const parsedPlans = availablePlans
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    if (parsedPlans.length > 0) model.availablePlans = parsedPlans
    else delete model.availablePlans
    model.supportsVision = supportsVision
    model.supportsFunctionCall = supportsFunctionCall
    model.supportsComputerUse = supportsComputerUse
    model.enableComputerUse = supportsComputerUse && enableComputerUse
    if (isAnthropicModel || isResponsesModel) {
      model.supportsBuiltinSearch = supportsBuiltinSearch
      model.enableBuiltinSearch = supportsBuiltinSearch && enableBuiltinSearch
    } else {
      delete model.supportsBuiltinSearch
      delete model.enableBuiltinSearch
    }
    if (isResponsesModel || isOpenAiChatModel) {
      if (supportsFastMode) model.serviceTier = 'priority'
      else delete model.serviceTier
    } else {
      delete model.serviceTier
    }
    if (icon.trim()) model.icon = icon.trim()
    else delete model.icon
    if (responseSummary && responseSummary !== 'none') model.responseSummary = responseSummary
    else delete model.responseSummary
    model.enableSystemPromptCache = enableSystemPromptCache
    model.cacheTtl = cacheTtl
    if (isResponsesModel) {
      model.supportsWebsocket = supportsWebsocket
      model.websocketMode = supportsWebsocket ? websocketMode : 'disabled'
      model.supportsImageGeneration = supportsImageGeneration
      const outputCompression = responsesImageGenerationOutputCompression.trim()
        ? normalizeResponsesImageGenerationOutputCompression(
            Number(responsesImageGenerationOutputCompression)
          )
        : undefined
      const partialImages = responsesImageGenerationPartialImages.trim()
        ? normalizeResponsesImageGenerationPartialImages(
            Number(responsesImageGenerationPartialImages)
          )
        : undefined
      model.responsesImageGeneration = {
        enabled: supportsImageGeneration && responsesImageGenerationEnabled,
        ...(responsesImageGenerationAction !== RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION
          ? { action: responsesImageGenerationAction }
          : {}),
        ...(responsesImageGenerationBackground !== RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION
          ? { background: responsesImageGenerationBackground }
          : {}),
        ...(responsesImageGenerationInputFidelity !== RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION
          ? { inputFidelity: responsesImageGenerationInputFidelity }
          : {}),
        ...(responsesImageGenerationModeration !== RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION
          ? { moderation: responsesImageGenerationModeration }
          : {}),
        ...(responsesImageGenerationOutputFormat !== RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION
          ? { outputFormat: responsesImageGenerationOutputFormat }
          : {}),
        ...(responsesImageGenerationQuality !== RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION
          ? { quality: responsesImageGenerationQuality }
          : {}),
        ...(responsesImageGenerationSize !== RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION
          ? { size: responsesImageGenerationSize }
          : {}),
        ...(outputCompression !== undefined ? { outputCompression } : {}),
        ...(partialImages !== undefined ? { partialImages } : {})
      }
    } else {
      delete model.responsesImageGeneration
      delete model.websocketMode
      delete model.supportsWebsocket
      delete model.supportsImageGeneration
    }
    // preserve thinking config if editing
    if (initial?.supportsThinking) model.supportsThinking = initial.supportsThinking
    if (initial?.thinkingConfig) model.thinkingConfig = initial.thinkingConfig
    const result = onSave(model)
    if (result !== false) {
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('provider.editModel') : t('provider.addModelTitle')}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? t('provider.editModelDesc', { name: initial?.name })
              : t('provider.addModelDesc')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          {/* ID + Name */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">{t('provider.modelId')} *</label>
              <Input
                placeholder={t('provider.modelIdPlaceholder')}
                value={id}
                onChange={(e) => handleModelIdChange(e.target.value)}
                disabled={isEdit && !allowIdEditing}
                autoFocus={!isEdit}
                className="text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium">{t('provider.modelName')}</label>
              <Input
                placeholder={t('provider.modelNamePlaceholder')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus={isEdit}
                className="text-xs"
              />
            </div>
          </div>
          {reusableManagedModel && (
            <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
              {t('provider.modelManagementDefaultsApplied', {
                name: reusableManagedModel.name
              })}
            </p>
          )}

          {/* Protocol type override */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium">{t('provider.modelTypeOverride')}</label>
            <p className="text-[11px] text-muted-foreground">
              {providerType
                ? t('provider.modelTypeOverrideHint', { type: providerType })
                : t('provider.modelTypeOverrideGlobalHint')}
            </p>
            <Select
              value={typeOverride}
              onValueChange={(v) => setTypeOverride(v as ProviderType | 'none')}
            >
              <SelectTrigger className="text-xs">
                <SelectValue placeholder={t('provider.modelTypeOverridePlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none" className="text-xs">
                  {t('provider.modelTypeOverridePlaceholder')}
                </SelectItem>
                <SelectItem value="openai-chat" className="text-xs">
                  {t('provider.openaiChatCompat')}
                </SelectItem>
                <SelectItem value="openai-responses" className="text-xs">
                  {t('provider.openaiResponses')}
                </SelectItem>
                <SelectItem value="anthropic" className="text-xs">
                  Anthropic
                </SelectItem>
                <SelectItem value="gemini" className="text-xs">
                  Gemini
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Model category */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium">{t('provider.modelCategory')}</label>
            <p className="text-[11px] text-muted-foreground">{t('provider.modelCategoryHint')}</p>
            <Select value={category} onValueChange={(v) => setCategory(v as ModelCategory)}>
              <SelectTrigger className="text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="chat" className="text-xs">
                  {t('provider.modelCategoryChat')}
                </SelectItem>
                <SelectItem value="speech" className="text-xs">
                  {t('provider.modelCategorySpeech')}
                </SelectItem>
                <SelectItem value="embedding" className="text-xs">
                  {t('provider.modelCategoryEmbedding')}
                </SelectItem>
                <SelectItem value="image" className="text-xs">
                  {t('provider.modelCategoryImage')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Context + Max output */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">{t('provider.contextLength')}</label>
              <Input
                type="number"
                placeholder="128000"
                value={contextLength}
                onChange={(e) => setContextLength(e.target.value)}
                className="text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium">{t('provider.maxOutputTokens')}</label>
              <Input
                type="number"
                placeholder="4096"
                value={maxOutputTokens}
                onChange={(e) => setMaxOutputTokens(e.target.value)}
                className="text-xs"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium">
              {t('provider.contextCompressionThreshold')}
            </label>
            <p className="text-[11px] text-muted-foreground">
              {t('provider.contextCompressionThresholdDesc', {
                min: Math.round(MIN_CONTEXT_COMPRESSION_THRESHOLD * 100),
                max: Math.round(MAX_CONTEXT_COMPRESSION_THRESHOLD * 100)
              })}
            </p>
            <Input
              type="number"
              min={Math.round(MIN_CONTEXT_COMPRESSION_THRESHOLD * 100)}
              max={Math.round(MAX_CONTEXT_COMPRESSION_THRESHOLD * 100)}
              placeholder="80"
              value={contextCompressionThreshold}
              onChange={(e) => setContextCompressionThreshold(e.target.value)}
              className="text-xs"
            />
          </div>

          {/* Pricing */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium">
              {t('provider.pricing')}{' '}
              <span className="text-muted-foreground font-normal">
                ({t('provider.pricingUnit')})
              </span>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <p className="text-[11px] text-muted-foreground">{t('provider.inputPrice')}</p>
                <Input
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  value={inputPrice}
                  onChange={(e) => setInputPrice(e.target.value)}
                  className="text-xs"
                />
              </div>
              <div className="space-y-1">
                <p className="text-[11px] text-muted-foreground">{t('provider.outputPrice')}</p>
                <Input
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  value={outputPrice}
                  onChange={(e) => setOutputPrice(e.target.value)}
                  className="text-xs"
                />
              </div>
              <div className="space-y-1">
                <p className="text-[11px] text-muted-foreground">
                  {t('provider.cacheCreationPrice')}
                </p>
                <Input
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  value={cacheCreationPrice}
                  onChange={(e) => setCacheCreationPrice(e.target.value)}
                  className="text-xs"
                />
              </div>
              <div className="space-y-1">
                <p className="text-[11px] text-muted-foreground">{t('provider.cacheHitPrice')}</p>
                <Input
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  value={cacheHitPrice}
                  onChange={(e) => setCacheHitPrice(e.target.value)}
                  className="text-xs"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 pt-2">
              <div className="space-y-1">
                <p className="text-[11px] text-muted-foreground">
                  {t('provider.premiumRequestMultiplier')}
                </p>
                <Input
                  type="number"
                  step="0.01"
                  placeholder="1"
                  value={premiumRequestMultiplier}
                  onChange={(e) => setPremiumRequestMultiplier(e.target.value)}
                  className="text-xs"
                />
              </div>
              <div className="space-y-1">
                <p className="text-[11px] text-muted-foreground">{t('provider.availablePlans')}</p>
                <Input
                  placeholder="pro, pro+, business"
                  value={availablePlans}
                  onChange={(e) => setAvailablePlans(e.target.value)}
                  className="text-xs"
                />
              </div>
            </div>
          </div>

          {/* Icon */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium">{t('provider.modelIcon')}</label>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setIcon('')}
                className={`size-7 flex items-center justify-center rounded border transition-colors ${
                  icon === ''
                    ? 'border-primary bg-primary/10'
                    : 'border-border hover:border-muted-foreground/50 hover:bg-muted/40'
                }`}
                title={t('provider.modelIconAuto')}
              >
                <span className="text-[10px] text-muted-foreground">auto</span>
              </button>
              {MODEL_ICON_OPTIONS.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setIcon(key)}
                  className={`size-7 flex items-center justify-center rounded border transition-colors ${
                    icon === key
                      ? 'border-primary bg-primary/10'
                      : 'border-border hover:border-muted-foreground/50 hover:bg-muted/40'
                  }`}
                  title={key}
                >
                  <ModelIcon icon={key} size={16} />
                </button>
              ))}
            </div>
            {icon && (
              <p className="text-[11px] text-muted-foreground">
                {t('provider.modelIconSelected', { icon })}
              </p>
            )}
          </div>

          {/* Responses config */}
          <div className="space-y-2">
            <label className="text-xs font-medium">{t('provider.responsesConfig')}</label>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {t('provider.responsesSummary')}
                </span>
                <Select
                  value={responseSummary}
                  onValueChange={(v) =>
                    setResponseSummary(v as 'auto' | 'concise' | 'detailed' | 'none')
                  }
                >
                  <SelectTrigger className="h-7 w-36 text-[11px]">
                    <SelectValue placeholder={t('provider.responsesSummaryAuto')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none" className="text-[11px]">
                      {t('provider.responsesSummaryNone')}
                    </SelectItem>
                    <SelectItem value="auto" className="text-[11px]">
                      {t('provider.responsesSummaryAuto')}
                    </SelectItem>
                    <SelectItem value="concise" className="text-[11px]">
                      {t('provider.responsesSummaryConcise')}
                    </SelectItem>
                    <SelectItem value="detailed" className="text-[11px]">
                      {t('provider.responsesSummaryDetailed')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {isResponsesModel && (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      {t('provider.responsesWebsocket')}
                    </span>
                    <Switch
                      checked={supportsWebsocket && websocketMode === 'auto'}
                      disabled={!supportsWebsocket}
                      onCheckedChange={(v) => setWebsocketMode(v ? 'auto' : 'disabled')}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      {t('provider.responsesImageGeneration')}
                    </span>
                    <Switch
                      checked={supportsImageGeneration && responsesImageGenerationEnabled}
                      disabled={!supportsImageGeneration}
                      onCheckedChange={setResponsesImageGenerationEnabled}
                    />
                  </div>
                  {supportsImageGeneration && responsesImageGenerationEnabled && (
                    <div className="space-y-2 rounded-md border border-border/60 p-2">
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <span className="text-[11px] text-muted-foreground">
                            {t('provider.responsesImageGenerationAction')}
                          </span>
                          <Select
                            value={responsesImageGenerationAction}
                            onValueChange={(value) =>
                              setResponsesImageGenerationAction(
                                value as
                                  | ResponsesImageGenerationAction
                                  | typeof RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION
                              )
                            }
                          >
                            <SelectTrigger className="h-7 text-[11px]">
                              <SelectValue
                                placeholder={t('provider.responsesImageGenerationDefault')}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem
                                value={RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION}
                                className="text-[11px]"
                              >
                                {t('provider.responsesImageGenerationDefault')}
                              </SelectItem>
                              {RESPONSES_IMAGE_GENERATION_ACTIONS.map((value) => (
                                <SelectItem key={value} value={value} className="text-[11px]">
                                  {t(`provider.responsesImageGenerationOption.${value}`)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1">
                          <span className="text-[11px] text-muted-foreground">
                            {t('provider.responsesImageGenerationBackground')}
                          </span>
                          <Select
                            value={responsesImageGenerationBackground}
                            onValueChange={(value) =>
                              setResponsesImageGenerationBackground(
                                value as
                                  | ResponsesImageGenerationBackground
                                  | typeof RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION
                              )
                            }
                          >
                            <SelectTrigger className="h-7 text-[11px]">
                              <SelectValue
                                placeholder={t('provider.responsesImageGenerationDefault')}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem
                                value={RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION}
                                className="text-[11px]"
                              >
                                {t('provider.responsesImageGenerationDefault')}
                              </SelectItem>
                              {RESPONSES_IMAGE_GENERATION_BACKGROUNDS.map((value) => (
                                <SelectItem key={value} value={value} className="text-[11px]">
                                  {t(`provider.responsesImageGenerationOption.${value}`)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <span className="text-[11px] text-muted-foreground">
                            {t('provider.responsesImageGenerationQuality')}
                          </span>
                          <Select
                            value={responsesImageGenerationQuality}
                            onValueChange={(value) =>
                              setResponsesImageGenerationQuality(
                                value as
                                  | ResponsesImageGenerationQuality
                                  | typeof RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION
                              )
                            }
                          >
                            <SelectTrigger className="h-7 text-[11px]">
                              <SelectValue
                                placeholder={t('provider.responsesImageGenerationDefault')}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem
                                value={RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION}
                                className="text-[11px]"
                              >
                                {t('provider.responsesImageGenerationDefault')}
                              </SelectItem>
                              {RESPONSES_IMAGE_GENERATION_QUALITIES.map((value) => (
                                <SelectItem key={value} value={value} className="text-[11px]">
                                  {t(`provider.responsesImageGenerationOption.${value}`)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1">
                          <span className="text-[11px] text-muted-foreground">
                            {t('provider.responsesImageGenerationSize')}
                          </span>
                          <Select
                            value={responsesImageGenerationSize}
                            onValueChange={(value) =>
                              setResponsesImageGenerationSize(
                                value as
                                  | ResponsesImageGenerationSize
                                  | typeof RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION
                              )
                            }
                          >
                            <SelectTrigger className="h-7 text-[11px]">
                              <SelectValue
                                placeholder={t('provider.responsesImageGenerationDefault')}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem
                                value={RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION}
                                className="text-[11px]"
                              >
                                {t('provider.responsesImageGenerationDefault')}
                              </SelectItem>
                              {RESPONSES_IMAGE_GENERATION_SIZES.map((value) => (
                                <SelectItem key={value} value={value} className="text-[11px]">
                                  {t(`provider.responsesImageGenerationOption.${value}`)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <span className="text-[11px] text-muted-foreground">
                            {t('provider.responsesImageGenerationOutputFormat')}
                          </span>
                          <Select
                            value={responsesImageGenerationOutputFormat}
                            onValueChange={(value) =>
                              setResponsesImageGenerationOutputFormat(
                                value as
                                  | ResponsesImageGenerationOutputFormat
                                  | typeof RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION
                              )
                            }
                          >
                            <SelectTrigger className="h-7 text-[11px]">
                              <SelectValue
                                placeholder={t('provider.responsesImageGenerationDefault')}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem
                                value={RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION}
                                className="text-[11px]"
                              >
                                {t('provider.responsesImageGenerationDefault')}
                              </SelectItem>
                              {RESPONSES_IMAGE_GENERATION_OUTPUT_FORMATS.map((value) => (
                                <SelectItem key={value} value={value} className="text-[11px]">
                                  {t(`provider.responsesImageGenerationOption.${value}`)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1">
                          <span className="text-[11px] text-muted-foreground">
                            {t('provider.responsesImageGenerationModeration')}
                          </span>
                          <Select
                            value={responsesImageGenerationModeration}
                            onValueChange={(value) =>
                              setResponsesImageGenerationModeration(
                                value as
                                  | ResponsesImageGenerationModeration
                                  | typeof RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION
                              )
                            }
                          >
                            <SelectTrigger className="h-7 text-[11px]">
                              <SelectValue
                                placeholder={t('provider.responsesImageGenerationDefault')}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem
                                value={RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION}
                                className="text-[11px]"
                              >
                                {t('provider.responsesImageGenerationDefault')}
                              </SelectItem>
                              {RESPONSES_IMAGE_GENERATION_MODERATIONS.map((value) => (
                                <SelectItem key={value} value={value} className="text-[11px]">
                                  {t(`provider.responsesImageGenerationOption.${value}`)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <span className="text-[11px] text-muted-foreground">
                            {t('provider.responsesImageGenerationInputFidelity')}
                          </span>
                          <Select
                            value={responsesImageGenerationInputFidelity}
                            onValueChange={(value) =>
                              setResponsesImageGenerationInputFidelity(
                                value as
                                  | ResponsesImageGenerationInputFidelity
                                  | typeof RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION
                              )
                            }
                          >
                            <SelectTrigger className="h-7 text-[11px]">
                              <SelectValue
                                placeholder={t('provider.responsesImageGenerationDefault')}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem
                                value={RESPONSES_IMAGE_GENERATION_DEFAULT_OPTION}
                                className="text-[11px]"
                              >
                                {t('provider.responsesImageGenerationDefault')}
                              </SelectItem>
                              {RESPONSES_IMAGE_GENERATION_INPUT_FIDELITIES.map((value) => (
                                <SelectItem key={value} value={value} className="text-[11px]">
                                  {t(`provider.responsesImageGenerationOption.${value}`)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1">
                          <span className="text-[11px] text-muted-foreground">
                            {t('provider.responsesImageGenerationOutputCompression')}
                          </span>
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            placeholder="0-100"
                            value={responsesImageGenerationOutputCompression}
                            onChange={(e) =>
                              setResponsesImageGenerationOutputCompression(e.target.value)
                            }
                            className="h-7 text-[11px]"
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <span className="text-[11px] text-muted-foreground">
                            {t('provider.responsesImageGenerationPartialImages')}
                          </span>
                          <Input
                            type="number"
                            min={0}
                            placeholder={RESPONSES_IMAGE_GENERATION_DEFAULT_PARTIAL_IMAGES.toString()}
                            value={responsesImageGenerationPartialImages}
                            onChange={(e) =>
                              setResponsesImageGenerationPartialImages(e.target.value)
                            }
                            className="h-7 text-[11px]"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {t('provider.systemPromptCache')}
                </span>
                <Switch
                  checked={enableSystemPromptCache}
                  onCheckedChange={setEnableSystemPromptCache}
                />
              </div>
              {isAnthropicModel && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{t('provider.cacheTtl')}</span>
                  <Select value={cacheTtl} onValueChange={(v) => setCacheTtl(v as '5m' | '1h')}>
                    <SelectTrigger className="w-20 h-7 text-[11px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="5m">5m</SelectItem>
                      <SelectItem value="1h">1h</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </div>

          {/* Capabilities */}
          <div className="space-y-2">
            <label className="text-xs font-medium">{t('provider.capabilities')}</label>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {t('provider.supportsVision')}
                </span>
                <Switch checked={supportsVision} onCheckedChange={setSupportsVision} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {t('provider.supportsFunctionCall')}
                </span>
                <Switch checked={supportsFunctionCall} onCheckedChange={setSupportsFunctionCall} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {t('provider.supportsComputerUse')}
                </span>
                <Switch checked={supportsComputerUse} onCheckedChange={setSupportsComputerUse} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {t('provider.enableComputerUse')}
                </span>
                <Switch
                  checked={supportsComputerUse && enableComputerUse}
                  disabled={!supportsComputerUse}
                  onCheckedChange={setEnableComputerUse}
                />
              </div>
              {(isResponsesModel || isOpenAiChatModel) && (
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-col">
                    <span className="text-xs text-muted-foreground">
                      {t('provider.supportsFastMode')}
                    </span>
                    <span className="text-[11px] text-muted-foreground/70">
                      {t('provider.supportsFastModeDesc')}
                    </span>
                  </div>
                  <Switch checked={supportsFastMode} onCheckedChange={setSupportsFastMode} />
                </div>
              )}
              {isResponsesModel && (
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-col">
                    <span className="text-xs text-muted-foreground">
                      {t('provider.supportsWebsocket')}
                    </span>
                    <span className="text-[11px] text-muted-foreground/70">
                      {t('provider.supportsWebsocketDesc')}
                    </span>
                  </div>
                  <Switch checked={supportsWebsocket} onCheckedChange={setSupportsWebsocket} />
                </div>
              )}
              {isResponsesModel && (
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-col">
                    <span className="text-xs text-muted-foreground">
                      {t('provider.supportsImageGeneration')}
                    </span>
                    <span className="text-[11px] text-muted-foreground/70">
                      {t('provider.supportsImageGenerationDesc')}
                    </span>
                  </div>
                  <Switch
                    checked={supportsImageGeneration}
                    onCheckedChange={setSupportsImageGeneration}
                  />
                </div>
              )}
              {(isAnthropicModel || isResponsesModel) && (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex flex-col">
                      <span className="text-xs text-muted-foreground">
                        {t('provider.supportsBuiltinSearch')}
                      </span>
                      <span className="text-[11px] text-muted-foreground/70">
                        {t('provider.supportsBuiltinSearchDesc')}
                      </span>
                    </div>
                    <Switch
                      checked={supportsBuiltinSearch}
                      onCheckedChange={setSupportsBuiltinSearch}
                    />
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex flex-col">
                      <span className="text-xs text-muted-foreground">
                        {t('provider.enableBuiltinSearch')}
                      </span>
                      <span className="text-[11px] text-muted-foreground/70">
                        {t('provider.enableBuiltinSearchDesc')}
                      </span>
                    </div>
                    <Switch
                      checked={supportsBuiltinSearch && enableBuiltinSearch}
                      disabled={!supportsBuiltinSearch}
                      onCheckedChange={setEnableBuiltinSearch}
                    />
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t('action.cancel', { ns: 'common' })}
            </Button>
            <Button size="sm" disabled={!id.trim()} onClick={handleSave}>
              {t('action.save', { ns: 'common' })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// --- Right panel: provider config ---

function ProviderConfigPanel({ provider }: { provider: AIProvider }): React.JSX.Element {
  const { t } = useTranslation('settings')
  const updateProvider = useProviderStore((s) => s.updateProvider)
  const removeProvider = useProviderStore((s) => s.removeProvider)
  const toggleProviderEnabled = useProviderStore((s) => s.toggleProviderEnabled)
  const addModel = useProviderStore((s) => s.addModel)
  const removeModel = useProviderStore((s) => s.removeModel)
  const updateModel = useProviderStore((s) => s.updateModel)
  const toggleModelEnabled = useProviderStore((s) => s.toggleModelEnabled)
  const setProviderModels = useProviderStore((s) => s.setProviderModels)
  const getManagedModelById = useProviderStore((s) => s.getManagedModelById)
  const quotaByKey = useQuotaStore((s) => s.quotaByKey)
  const clearQuota = useQuotaStore((s) => s.clearQuota)

  const authMode = provider.authMode ?? 'apiKey'
  const isApiKeyAuth = authMode === 'apiKey'
  const isOAuthAuth = authMode === 'oauth'
  const isChannelAuth = authMode === 'channel'
  const isCodexProvider = provider.builtinId === 'codex-oauth'
  const isCopilotProvider = provider.builtinId === 'copilot-oauth'
  const supportsManualOAuth = isCodexProvider || isCopilotProvider

  const [showKey, setShowKey] = useState(false)
  const [showChannelToken, setShowChannelToken] = useState(false)
  const [oauthConnecting, setOauthConnecting] = useState(false)
  const [oauthRefreshing, setOauthRefreshing] = useState(false)
  const [manualOAuthJson, setManualOAuthJson] = useState('')
  const [manualOAuthError, setManualOAuthError] = useState('')
  const [channelSending, setChannelSending] = useState(false)
  const [channelVerifying, setChannelVerifying] = useState(false)
  const [channelRefreshing, setChannelRefreshing] = useState(false)
  const [channelType, setChannelType] = useState<'sms' | 'email'>(
    provider.channel?.channelType ?? provider.channelConfig?.defaultChannelType ?? 'sms'
  )
  const [channelMobile, setChannelMobile] = useState('')
  const [channelEmail, setChannelEmail] = useState('')
  const [channelCode, setChannelCode] = useState('')
  const [addModelOpen, setAddModelOpen] = useState(false)
  const [editingModel, setEditingModel] = useState<AIModelConfig | null>(null)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [testing, setTesting] = useState(false)
  const [modelSearch, setModelSearch] = useState('')
  const [editingThinkingModel, setEditingThinkingModel] = useState<AIModelConfig | null>(null)
  const [testModelId, setTestModelId] = useState(
    provider.models.find((m) => m.enabled)?.id ?? provider.models[0]?.id ?? ''
  )
  const [oauthLoginTab, setOauthLoginTab] = useState<'connect' | 'manual'>('connect')
  const [oauthDeviceInfo, setOauthDeviceInfo] = useState<OAuthDeviceCodeInfo | null>(null)
  const [fetchingQuota, setFetchingQuota] = useState(false)
  const builtinPreset = useMemo(
    () =>
      provider.builtinId
        ? builtinProviderPresets.find((p) => p.builtinId === provider.builtinId)
        : undefined,
    [provider.builtinId]
  )
  const oauthAbortRef = useRef<AbortController | null>(null)
  const codexQuota = useMemo(() => {
    if (!isCodexProvider) return null
    const quota =
      quotaByKey[provider.id] ||
      (provider.builtinId ? quotaByKey[provider.builtinId] : undefined) ||
      quotaByKey['codex'] ||
      null
    return quota?.type === 'codex' ? quota : null
  }, [isCodexProvider, provider.id, provider.builtinId, quotaByKey])
  const copilotQuota = useMemo(() => {
    if (!isCopilotProvider) return null
    const quota =
      quotaByKey[provider.id] ||
      (provider.builtinId ? quotaByKey[provider.builtinId] : undefined) ||
      quotaByKey['copilot'] ||
      null
    return quota?.type === 'copilot' ? (quota as CopilotQuota) : null
  }, [isCopilotProvider, provider.id, provider.builtinId, quotaByKey])
  const formatPercent = (value?: number): string | null => {
    if (value === undefined || Number.isNaN(value)) return null
    const rounded = Math.round(value * 10) / 10
    return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}%`
  }
  const formatDurationMinutes = (value?: number): string | null => {
    if (value === undefined || Number.isNaN(value)) return null
    const minutes = Math.max(0, Math.round(value))
    if (minutes < 60) return `${minutes}m`

    const days = Math.floor(minutes / 1440)
    const remMinutes = minutes % 1440
    const hours = Math.floor(remMinutes / 60)
    const mins = remMinutes % 60

    if (days > 0) {
      return hours > 0 ? `${days}d ${hours}h` : `${days}d`
    }

    if (hours > 0 && mins > 0) return `${hours}h ${mins}m`
    return `${hours}h`
  }

  const handleDeleteProvider = async (): Promise<void> => {
    if (provider.builtinId) return
    const ok = await confirm({
      title: t('provider.deleteProvider'),
      description: t('provider.deleteProviderConfirm', { name: provider.name }),
      confirmLabel: t('provider.deleteProvider'),
      variant: 'destructive'
    })
    if (!ok) return
    removeProvider(provider.id)
    toast.success(t('provider.providerDeleted'))
  }
  const formatResetAt = (value?: string): string | null => {
    if (!value) return null
    const trimmed = value.trim()
    if (!trimmed) return null
    if (['invalid date', 'null', 'undefined', 'nan'].includes(trimmed.toLowerCase())) return null

    const tryParse = (input: string | number): Date | null => {
      const candidate = new Date(input)
      return Number.isNaN(candidate.getTime()) ? null : candidate
    }

    let parsed: Date | null = null

    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const numericValue = Number(trimmed)
      if (Number.isFinite(numericValue)) {
        const timestamp = numericValue < 1e12 ? numericValue * 1000 : numericValue
        parsed = tryParse(timestamp)
      }
    }

    if (!parsed) {
      const normalized = trimmed
        .replace(/\[(?:[^\]]+)\]$/, '')
        .replace(
          /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)$/,
          '$1T$2'
        )
        .replace(/(\.\d{3})\d+(?=(?:Z|[+-]\d{2}:?\d{2})$)/i, '$1')
        .replace(/ UTC$/i, 'Z')

      parsed = tryParse(trimmed) ?? (normalized !== trimmed ? tryParse(normalized) : null)
    }

    if (!parsed) return null

    const year = parsed.getFullYear()
    const month = String(parsed.getMonth() + 1).padStart(2, '0')
    const day = String(parsed.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  const QuotaProgressBar = ({
    label,
    window
  }: {
    label: string
    window?: CodexQuotaWindow
  }): React.JSX.Element | null => {
    if (!window) return null
    const percent = window.usedPercent ?? 0
    const resetAt = formatResetAt(window.resetAt)
    const windowMinutes = formatDurationMinutes(window.windowMinutes)

    let remainingText = ''
    if (window.resetAfterSeconds !== undefined && Number.isFinite(window.resetAfterSeconds)) {
      const minutes = Math.max(1, Math.ceil(window.resetAfterSeconds / 60))
      if (minutes < 60) {
        remainingText = t('provider.codexQuotaResetIn', { time: `${minutes}m` })
      } else if (minutes < 1440) {
        remainingText = t('provider.codexQuotaResetIn', { time: `${Math.floor(minutes / 60)}h` })
      } else {
        remainingText = t('provider.codexQuotaResetIn', { time: `${Math.floor(minutes / 1440)}d` })
      }
    }

    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[11px]">
          <span className="font-medium text-foreground/90">{label}</span>
          <div className="flex items-center gap-2">
            <span className="font-bold">{Math.round(percent)}%</span>
            {(resetAt || remainingText) && (
              <span className="text-muted-foreground/60">{resetAt || remainingText}</span>
            )}
          </div>
        </div>
        <div className="h-2 w-full bg-muted/50 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-500 rounded-full ${
              percent >= 100 ? 'bg-destructive' : percent >= 80 ? 'bg-amber-500' : 'bg-emerald-500'
            }`}
            style={{ width: `${Math.min(100, percent)}%` }}
          />
        </div>
        {windowMinutes && (
          <div className="text-[10px] text-muted-foreground/50 text-right">
            {t('provider.codexQuotaWindow', { time: windowMinutes })}
          </div>
        )}
      </div>
    )
  }
  const formatBalance = (value?: number): string | null => {
    if (value === undefined || Number.isNaN(value)) return null
    const rounded = Math.round(value * 100) / 100
    return String(rounded)
  }
  const formatCredits = (quota: CodexQuota | null): string => {
    if (!quota?.credits) return '-'
    if (quota.credits.unlimited) return t('provider.codexQuotaUnlimited')
    const balance = formatBalance(quota.credits.balance)
    if (balance) return t('provider.codexQuotaBalance', { balance })
    if (quota.credits.hasCredits === false) return t('provider.codexQuotaNone')
    return '-'
  }
  const apiKeyUrl = builtinPreset?.apiKeyUrl
  const canOpenApiKeyUrl = isApiKeyAuth && provider.requiresApiKey !== false && !!apiKeyUrl

  useEffect(() => {
    return () => {
      oauthAbortRef.current?.abort()
    }
  }, [provider.id])

  useEffect(() => {
    const nextType =
      provider.channel?.channelType ?? provider.channelConfig?.defaultChannelType ?? 'sms'
    setChannelType(nextType)
    setChannelMobile('')
    setChannelEmail('')
    setChannelCode('')
    setManualOAuthJson('')
    setManualOAuthError('')
    setOauthDeviceInfo(null)
    setOauthLoginTab('connect')
  }, [provider.id, provider.channel?.channelType, provider.channelConfig?.defaultChannelType])

  const oauthConfig = provider.oauthConfig ?? { authorizeUrl: '', tokenUrl: '', clientId: '' }
  const oauthClientIdLocked = oauthConfig.clientIdLocked === true
  const hideOAuthSettings = provider.ui?.hideOAuthSettings === true
  const oauthConfigReady =
    oauthConfig.flowType === 'device_code'
      ? !!(oauthConfig.deviceCodeUrl && oauthConfig.tokenUrl && oauthConfig.clientId)
      : !!(oauthConfig.authorizeUrl && oauthConfig.tokenUrl && oauthConfig.clientId)
  const channelRequiresAppToken = provider.channelConfig?.requiresAppToken !== false
  const channelAppIdLocked = provider.channelConfig?.appIdLocked === true
  const channelAppIdValue = channelAppIdLocked
    ? provider.channelConfig?.defaultAppId || provider.channel?.appId || ''
    : (provider.channel?.appId ?? '')
  const authReadyForUi = isApiKeyAuth
    ? provider.requiresApiKey === false || !!provider.apiKey
    : isOAuthAuth
      ? !!provider.oauth?.accessToken
      : isChannelAuth
        ? !!provider.channel?.accessToken
        : true

  const updateOAuthConfig = (patch: Partial<NonNullable<AIProvider['oauthConfig']>>): void => {
    const current = provider.oauthConfig ?? { authorizeUrl: '', tokenUrl: '', clientId: '' }
    const nextPatch = oauthClientIdLocked ? { ...patch, clientId: current.clientId } : patch
    updateProvider(provider.id, { oauthConfig: { ...current, ...nextPatch } })
  }

  const handleChannelCredentialChange = (field: 'appId' | 'appToken', value: string): void => {
    if (field === 'appId' && channelAppIdLocked) return
    const current = provider.channel ?? { appId: '', appToken: '' }
    const next = { ...current, [field]: value }
    if (current[field] !== value) {
      next.accessToken = undefined
      next.userInfo = undefined
    }
    updateProvider(provider.id, { channel: next })
  }

  const handleChannelTypeChange = (value: 'sms' | 'email'): void => {
    setChannelType(value)
    const current = provider.channel ?? { appId: '', appToken: '' }
    updateProvider(provider.id, { channel: { ...current, channelType: value } })
  }

  const enabledModelCount = provider.models.filter((model) => model.enabled).length
  const hasEnabledModels = enabledModelCount > 0
  const hasDisabledModels = enabledModelCount < provider.models.length

  const filteredModels = useMemo(() => {
    if (!modelSearch) return provider.models
    const q = modelSearch.toLowerCase()
    return provider.models.filter(
      (m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
    )
  }, [provider.models, modelSearch])

  const handleSetAllModelsEnabled = (enabled: boolean): void => {
    setProviderModels(
      provider.id,
      provider.models.map((model) => (model.enabled === enabled ? model : { ...model, enabled }))
    )
  }

  const getLatestProvider = (): AIProvider =>
    useProviderStore.getState().providers.find((p) => p.id === provider.id) ?? provider

  const ensureAuthForRequest = async (): Promise<AIProvider | null> => {
    const latest = getLatestProvider()
    const mode = latest.authMode ?? 'apiKey'
    if (mode === 'apiKey') {
      if (!latest.apiKey && latest.requiresApiKey !== false) {
        toast.error(t('provider.noApiKey'))
        return null
      }
      return latest
    }

    const ready = await ensureProviderAuthReady(latest.id)
    if (!ready) {
      toast.error(mode === 'oauth' ? t('provider.oauthRequired') : t('provider.channelRequired'))
      return null
    }
    return getLatestProvider()
  }

  const isAbortError = (err: unknown): boolean => err instanceof Error && err.name === 'AbortError'

  const handleOAuthConnect = async (): Promise<void> => {
    if (!oauthConfigReady && !hideOAuthSettings) {
      toast.error(t('provider.oauthConfigMissing'))
      return
    }
    if (oauthConnecting) return
    const controller = new AbortController()
    oauthAbortRef.current?.abort()
    oauthAbortRef.current = controller
    setOauthDeviceInfo(null)
    setOauthConnecting(true)
    try {
      await startProviderOAuth(provider.id, {
        signal: controller.signal,
        onDeviceCode: (info) => setOauthDeviceInfo(info)
      })
      setOauthDeviceInfo(null)
      toast.success(t('provider.oauthConnected'))
    } catch (err) {
      if (!isAbortError(err)) {
        toast.error(t('provider.oauthConnectFailed'), {
          description: err instanceof Error ? err.message : String(err)
        })
      }
    } finally {
      if (oauthAbortRef.current === controller) {
        oauthAbortRef.current = null
      }
      setOauthConnecting(false)
    }
  }

  const handleOAuthCancel = (): void => {
    oauthAbortRef.current?.abort()
    setOauthDeviceInfo(null)
  }

  const handleOAuthRefresh = async (): Promise<void> => {
    setOauthRefreshing(true)
    try {
      const refreshed = await refreshProviderOAuth(provider.id, true)
      if (refreshed) {
        toast.success(t('provider.oauthRefreshed'))
      } else {
        toast.error(t('provider.oauthRefreshFailed'))
      }
    } catch (err) {
      toast.error(t('provider.oauthRefreshFailed'), {
        description: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setOauthRefreshing(false)
    }
  }

  const handleOAuthDisconnect = (): void => {
    disconnectProviderOAuth(provider.id)
    setOauthDeviceInfo(null)
    if (isCodexProvider) {
      clearQuota(provider.id)
      if (provider.builtinId) clearQuota(provider.builtinId)
      clearQuota('codex')
    }
    if (isCopilotProvider) {
      clearCopilotQuota(provider)
    }
    toast.success(t('provider.oauthDisconnected'))
  }

  const resolveManualOAuthError = (err: unknown): string => {
    const code = err instanceof Error ? err.message : ''
    if (code === 'invalid_json') return t('provider.oauthManualInvalidJson')
    if (code === 'invalid_json_object') return t('provider.oauthManualInvalidJsonObj')
    if (code === 'missing_access_token') return t('provider.oauthManualMissingAccessToken')
    return t('provider.oauthManualApplyFailed')
  }

  const handleManualOAuthApply = async (): Promise<void> => {
    setManualOAuthError('')
    try {
      await applyManualProviderOAuth(provider.id, manualOAuthJson)
      setManualOAuthJson('')
      setOauthDeviceInfo(null)
      toast.success(t('provider.oauthManualApplied'))
    } catch (err) {
      const message = resolveManualOAuthError(err)
      setManualOAuthError(message)
      toast.error(message)
    }
  }

  const handleChannelSendCode = async (): Promise<void> => {
    setChannelSending(true)
    try {
      await sendProviderChannelCode({
        providerId: provider.id,
        channelType,
        mobile: channelMobile.trim() || undefined,
        email: channelEmail.trim() || undefined
      })
      toast.success(t('provider.channelCodeSent'))
    } catch (err) {
      toast.error(t('provider.channelSendFailed'), {
        description: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setChannelSending(false)
    }
  }

  const handleChannelVerify = async (): Promise<void> => {
    setChannelVerifying(true)
    try {
      await verifyProviderChannelCode({
        providerId: provider.id,
        channelType,
        code: channelCode.trim(),
        mobile: channelMobile.trim() || undefined,
        email: channelEmail.trim() || undefined
      })
      setChannelCode('')
      toast.success(t('provider.channelVerified'))
    } catch (err) {
      toast.error(t('provider.channelVerifyFailed'), {
        description: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setChannelVerifying(false)
    }
  }

  const handleChannelRefreshUser = async (): Promise<void> => {
    setChannelRefreshing(true)
    try {
      await refreshProviderChannelUserInfo(provider.id)
      toast.success(t('provider.channelUserRefreshed'))
    } catch (err) {
      toast.error(t('provider.channelUserRefreshFailed'), {
        description: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setChannelRefreshing(false)
    }
  }

  const handleChannelDisconnect = (): void => {
    clearProviderChannelAuth(provider.id)
    toast.success(t('provider.channelDisconnected'))
  }

  const openExternal = async (url: string): Promise<void> => {
    await ipcClient.invoke('shell:openExternal', url)
  }

  const invokeApiRequest = async (args: {
    url: string
    method: string
    headers: Record<string, string>
    body?: string
    useSystemProxy?: boolean
  }): Promise<{ statusCode?: number; body?: string; error?: string }> => {
    return (await ipcClient.invoke('api:request', args)) as {
      statusCode?: number
      body?: string
      error?: string
    }
  }

  const handleFetchQuota = async (): Promise<void> => {
    if (!isCodexProvider && !isCopilotProvider) return
    setFetchingQuota(true)
    try {
      const activeProvider = await ensureAuthForRequest()
      if (!activeProvider) return

      if (isCopilotProvider) {
        if (!activeProvider.oauth?.accessToken) {
          throw new Error('Missing GitHub OAuth token')
        }
        await exchangeCopilotToken(activeProvider, activeProvider.oauth)
        toast.success(t('provider.quotaFetched'))
        return
      }

      const baseUrl = normalizeProviderBaseUrl(
        activeProvider.baseUrl?.trim() || 'https://chatgpt.com/backend-api/codex',
        'openai-responses'
      )
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      headers['User-Agent'] = resolveProviderUserAgent(activeProvider.userAgent)
      if (activeProvider.oauth?.accessToken) {
        headers['Authorization'] = `Bearer ${activeProvider.oauth.accessToken}`
      }
      if (activeProvider.oauth?.accountId) {
        headers['Chatgpt-Account-Id'] = activeProvider.oauth.accountId
      }
      const overrides = activeProvider.requestOverrides?.headers
      if (overrides) {
        const sid = `quota-${Date.now()}`
        for (const [key, raw] of Object.entries(overrides)) {
          const val = String(raw)
            .replace(/\{\{\s*sessionId\s*\}\}/g, sid)
            .replace(/\{\{\s*model\s*\}\}/g, activeProvider.models[0]?.id ?? '')
            .trim()
          if (val) headers[key] = val
        }
      }
      const result = await invokeApiRequest({
        url: withCodexClientVersion(`${baseUrl}/models`, headers['User-Agent']),
        method: 'GET',
        headers,
        useSystemProxy: activeProvider.useSystemProxy
      })
      if (result?.error) {
        throw new Error(result.error)
      }
      const status = result?.statusCode ?? 0
      if (status >= 200 && status < 300) {
        toast.success(t('provider.quotaFetched'))
      } else {
        throw new Error(`HTTP ${status}: ${result?.body?.slice(0, 200) ?? ''}`)
      }
    } catch (err) {
      toast.error(t('provider.quotaFetchFailed'), {
        description: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setFetchingQuota(false)
    }
  }

  const handleCopyAccountJson = async (): Promise<void> => {
    let payload: Record<string, unknown>
    if (isOAuthAuth && provider.oauth?.accessToken) {
      payload = { access_token: provider.oauth.accessToken }
      if (provider.oauth.refreshToken) payload.refresh_token = provider.oauth.refreshToken
      if (provider.oauth.expiresAt)
        payload.expires_at = new Date(provider.oauth.expiresAt).toISOString()
      if (provider.oauth.idToken) payload.id_token = provider.oauth.idToken
      if (provider.oauth.accountId) payload.account_id = provider.oauth.accountId
      if (provider.oauth.copilotAccessToken)
        payload.copilot_access_token = provider.oauth.copilotAccessToken
      if (provider.oauth.copilotExpiresAt)
        payload.copilot_expires_at = new Date(provider.oauth.copilotExpiresAt).toISOString()
      if (provider.oauth.copilotApiUrl) payload.copilot_api_url = provider.oauth.copilotApiUrl
      if (provider.oauth.copilotSku) payload.sku = provider.oauth.copilotSku
      if (provider.oauth.copilotTelemetry) payload.telemetry = provider.oauth.copilotTelemetry
      if (provider.oauth.copilotChatEnabled !== undefined)
        payload.chat_enabled = provider.oauth.copilotChatEnabled
    } else if (isChannelAuth && provider.channel?.accessToken) {
      payload = { access_token: provider.channel.accessToken }
    } else {
      toast.error(t('provider.copyAccountJsonNoToken'))
      return
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
      toast.success(t('provider.copyAccountJsonSuccess'))
    } catch {
      toast.error(t('provider.copyAccountJsonFailed'))
    }
  }

  const handleTestConnection = async (): Promise<void> => {
    setTesting(true)
    try {
      const activeProvider = await ensureAuthForRequest()
      if (!activeProvider) return
      const model = testModelId || activeProvider.models[0]?.id || 'mimo-v2-flash'
      const modelConfig = activeProvider.models.find((m) => m.id === model)
      const requestType = modelConfig?.type ?? activeProvider.type
      const isAnthropic = requestType === 'anthropic'
      const isResponses = requestType === 'openai-responses'
      const defaultBaseUrl = isAnthropic ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'
      const baseUrl = normalizeProviderBaseUrl(
        activeProvider.baseUrl?.trim() || defaultBaseUrl,
        requestType
      )
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      headers['User-Agent'] = resolveProviderUserAgent(activeProvider.userAgent)
      if (isMoonshotProviderConfig(activeProvider)) {
        Object.assign(headers, await buildMoonshotCommonHeaders(activeProvider.oauth?.deviceId))
      }
      const authToken = activeProvider.apiKey || activeProvider.oauth?.accessToken || ''
      const useAnthropicCompatAuth = activeProvider.builtinId === 'longcat'
      const applyHeaderOverrides = (modelId: string): void => {
        const overrides = activeProvider.requestOverrides?.headers
        if (!overrides) return
        const sid = `test-${Date.now()}`
        for (const [key, raw] of Object.entries(overrides)) {
          const val = String(raw)
            .replace(/\{\{\s*sessionId\s*\}\}/g, sid)
            .replace(/\{\{\s*model\s*\}\}/g, modelId)
            .trim()
          if (val) headers[key] = val
        }
      }
      let url: string
      let method = 'POST'
      let body: string | undefined
      if (isAnthropic) {
        url = `${baseUrl}/v1/messages`
        if (useAnthropicCompatAuth) {
          headers['Authorization'] = `Bearer ${activeProvider.apiKey}`
          headers['x-api-key'] = activeProvider.apiKey
        } else {
          headers['x-api-key'] = activeProvider.apiKey
        }
        headers['anthropic-version'] = '2023-06-01'
        applyHeaderOverrides(model)
        body = JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'Hi' }],
          ...(activeProvider.requestOverrides?.body ?? {})
        })
      } else if (isResponses) {
        url = `${baseUrl}/responses`
        if (activeProvider.builtinId === 'codex-oauth') {
          url = withCodexClientVersion(url, headers['User-Agent'])
        }
        if (authToken) headers['Authorization'] = `Bearer ${authToken}`
        if (activeProvider.oauth?.accountId) {
          headers['Chatgpt-Account-Id'] = activeProvider.oauth.accountId
        }
        applyHeaderOverrides(model)
        body = JSON.stringify({
          model,
          input: "Hi",
          ...(activeProvider.requestOverrides?.body ?? {})
        })
      } else {
        url = `${baseUrl}/chat/completions`
        if (authToken) headers['Authorization'] = `Bearer ${authToken}`
        applyHeaderOverrides(model)
        body = JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'Hi' }],
          ...(activeProvider.requestOverrides?.body ?? {})
        })
      }
      const result = await invokeApiRequest({
        url,
        method,
        headers,
        ...(body ? { body } : {}),
        useSystemProxy: activeProvider.useSystemProxy
      })
      if (result?.error) {
        toast.error(t('provider.connectionFailed'), { description: result.error })
      } else {
        const status = result?.statusCode ?? 0
        if (status >= 200 && status < 300) toast.success(t('provider.connectionSuccess'))
        else if (status === 401 || status === 403)
          toast.error(t('provider.invalidApiKey'), { description: `HTTP ${status}` })
        else
          toast.warning(t('provider.abnormalStatus', { status }), {
            description: result?.body?.slice(0, 200)
          })
      }
    } catch (err) {
      toast.error(t('provider.connectionFailed'), {
        description: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setTesting(false)
    }
  }

  const handleFetchModels = async (): Promise<void> => {
    setFetchingModels(true)
    try {
      const activeProvider = await ensureAuthForRequest()
      if (!activeProvider) return
      const models = await fetchModelsFromProvider(
        activeProvider.type,
        activeProvider.baseUrl,
        activeProvider.apiKey,
        activeProvider.builtinId,
        activeProvider.useSystemProxy,
        activeProvider.userAgent,
        activeProvider.oauth
      )
      if (models.length === 0) {
        toast.info(t('provider.noModelsFound'))
        return
      }
      const existingMap = new Map(
        provider.models.map((model) => [normalizeModelKey(model.id), model] as const)
      )
      const merged = models.map((model) =>
        buildProviderModelSnapshot(model, {
          managedModel: getManagedModelById(model.id),
          existingModel: existingMap.get(normalizeModelKey(model.id)) ?? null
        })
      )
      setProviderModels(provider.id, merged)
      toast.success(t('provider.fetchedModels', { count: models.length }))
    } catch (err) {
      toast.error(t('provider.fetchModelsFailed'), {
        description: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setFetchingModels(false)
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b shrink-0">
        <div className="flex items-center gap-3">
          <ProviderIcon builtinId={provider.builtinId} size={24} />
          <div>
            <h3 className="text-sm font-semibold">{provider.name}</h3>
            <p className="text-[11px] text-muted-foreground">
              {provider.type === 'anthropic'
                ? 'Anthropic Messages API'
                : provider.type === 'openai-responses'
                  ? 'OpenAI Responses API'
                  : t('provider.openaiChatCompat')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!provider.builtinId && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
              title={t('provider.deleteProvider')}
              onClick={() => void handleDeleteProvider()}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
          <Switch
            checked={provider.enabled}
            onCheckedChange={() => toggleProviderEnabled(provider.id)}
          />
        </div>
      </div>

      {/* Config body */}
      <div className="flex flex-1 min-h-0 flex-col overflow-y-auto overflow-x-hidden px-5 pt-4 pb-20">
        {isApiKeyAuth && (
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">{t('provider.apiKey')}</label>
              {canOpenApiKeyUrl && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-[11px] text-muted-foreground"
                  onClick={() => void openExternal(apiKeyUrl)}
                >
                  <ExternalLink className="size-3" />
                  {t('provider.getApiKey')}
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Input
                  type={showKey ? 'text' : 'password'}
                  placeholder={t('provider.apiKeyPlaceholder')}
                  value={provider.apiKey}
                  onChange={(e) => updateProvider(provider.id, { apiKey: e.target.value })}
                  className="pr-9 text-xs"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  tabIndex={-1}
                >
                  {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </button>
              </div>
            </div>
          </section>
        )}

        {isOAuthAuth && (
          <section className="space-y-2">
            {supportsManualOAuth && (
              <div className="flex gap-1 p-0.5 rounded-md bg-muted/50 w-fit">
                <button
                  type="button"
                  onClick={() => setOauthLoginTab('connect')}
                  className={`px-2.5 py-1 text-xs rounded transition-colors ${oauthLoginTab === 'connect' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {t('provider.oauthTabConnect')}
                </button>
                <button
                  type="button"
                  onClick={() => setOauthLoginTab('manual')}
                  className={`px-2.5 py-1 text-xs rounded transition-colors ${oauthLoginTab === 'manual' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {t('provider.oauthTabManual')}
                </button>
              </div>
            )}
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">{t('provider.oauthLogin')}</label>
              <div className="flex items-center gap-2">
                <span
                  className={`text-xs ${provider.oauth?.accessToken ? 'text-emerald-600' : 'text-muted-foreground'}`}
                >
                  {provider.oauth?.accessToken
                    ? t('provider.oauthConnected')
                    : t('provider.oauthNotConnected')}
                </span>
                {provider.oauth?.accessToken && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-1.5 text-[11px]"
                    onClick={() => void handleCopyAccountJson()}
                  >
                    <Copy className="size-3" />
                    {t('provider.copyAccountJson')}
                  </Button>
                )}
              </div>
            </div>
            {provider.oauth?.accountId && (
              <p className="text-[11px] text-muted-foreground">
                {t('provider.oauthAccount', { account: provider.oauth.accountId })}
              </p>
            )}
            {oauthConnecting && oauthDeviceInfo && (
              <div className="rounded-md border bg-muted/30 px-3 py-2 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] text-muted-foreground">
                    {t('provider.oauthVerificationUrl')}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-1.5 text-[11px]"
                    onClick={() =>
                      void openExternal(
                        oauthDeviceInfo.verificationUriComplete || oauthDeviceInfo.verificationUri
                      )
                    }
                  >
                    <ExternalLink className="size-3" />
                    {t('provider.openLink')}
                  </Button>
                </div>
                <div className="text-xs font-mono break-all">{oauthDeviceInfo.verificationUri}</div>
                <div className="flex items-center justify-between gap-3 pt-1 border-t">
                  <span className="text-[11px] text-muted-foreground">
                    {t('provider.oauthDeviceCode')}
                  </span>
                  <span className="text-sm font-mono font-semibold tracking-widest">
                    {oauthDeviceInfo.userCode}
                  </span>
                </div>
              </div>
            )}
            {(!supportsManualOAuth || oauthLoginTab === 'connect') && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {!provider.oauth?.accessToken && (
                    <>
                      <Button
                        size="sm"
                        className="h-8 gap-1 text-xs"
                        disabled={oauthConnecting || (!oauthConfigReady && !hideOAuthSettings)}
                        onClick={handleOAuthConnect}
                      >
                        {oauthConnecting && <Loader2 className="size-3 animate-spin" />}
                        {oauthConnecting
                          ? t('provider.oauthConnecting')
                          : t('provider.oauthConnect')}
                      </Button>
                      {oauthConnecting && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 text-xs"
                          onClick={handleOAuthCancel}
                        >
                          {t('action.cancel', { ns: 'common' })}
                        </Button>
                      )}
                    </>
                  )}
                  {provider.oauth?.accessToken && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1 text-xs"
                        disabled={oauthRefreshing}
                        onClick={handleOAuthRefresh}
                      >
                        {oauthRefreshing ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <RefreshCw className="size-3" />
                        )}
                        {oauthRefreshing
                          ? t('provider.oauthRefreshing')
                          : t('provider.oauthRefresh')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 text-xs"
                        onClick={handleOAuthDisconnect}
                      >
                        {t('provider.oauthDisconnect')}
                      </Button>
                    </>
                  )}
                </div>
                {!hideOAuthSettings && !oauthConfigReady && (
                  <p className="text-[11px] text-muted-foreground">
                    {t('provider.oauthConfigMissing')}
                  </p>
                )}
              </>
            )}
            <AccountListEditor provider={provider} />
          </section>
        )}

        {isOAuthAuth && supportsManualOAuth && oauthLoginTab === 'manual' && (
          <section className="space-y-2">
            <label className="text-sm font-medium">{t('provider.oauthManualTitle')}</label>
            <p className="text-[11px] text-muted-foreground">{t('provider.oauthManualDesc')}</p>
            <textarea
              value={manualOAuthJson}
              onChange={(e) => {
                setManualOAuthJson(e.target.value)
                if (manualOAuthError) setManualOAuthError('')
              }}
              placeholder={t('provider.oauthManualPlaceholder')}
              className="w-full h-28 rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs resize-none focus:outline-none focus:ring-1 focus:ring-ring"
              spellCheck={false}
            />
            {manualOAuthError && <p className="text-[11px] text-destructive">{manualOAuthError}</p>}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                className="h-8 text-xs"
                disabled={!manualOAuthJson.trim()}
                onClick={handleManualOAuthApply}
              >
                {t('provider.oauthManualApply')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs"
                onClick={() => {
                  setManualOAuthJson('')
                  setManualOAuthError('')
                }}
              >
                {t('action.clear', { ns: 'common' })}
              </Button>
            </div>
          </section>
        )}

        {isOAuthAuth && isCodexProvider && (
          <section className="space-y-4 pt-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium">{t('provider.codexQuotaTitle')}</label>
                {codexQuota && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button className="text-muted-foreground hover:text-foreground transition-colors">
                        <MonitorSmartphone className="size-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="p-3 max-w-xs space-y-2">
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-xs text-muted-foreground">
                          {t('provider.codexQuotaPlan')}
                        </span>
                        <span className="text-xs font-semibold">{codexQuota.planType || '-'}</span>
                      </div>
                      <div className="flex items-center justify-between gap-4 border-t pt-2">
                        <span className="text-xs text-muted-foreground">
                          {t('provider.codexQuotaCredits')}
                        </span>
                        <span className="text-xs font-mono">{formatCredits(codexQuota)}</span>
                      </div>
                      {codexQuota.primaryOverSecondaryLimitPercent !== undefined && (
                        <div className="text-[10px] text-muted-foreground border-t pt-2">
                          {t('provider.codexQuotaLimitOver', {
                            percent:
                              formatPercent(codexQuota.primaryOverSecondaryLimitPercent) ?? '-'
                          })}
                        </div>
                      )}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-xs"
                disabled={!authReadyForUi || fetchingQuota}
                onClick={() => void handleFetchQuota()}
              >
                {fetchingQuota ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <RefreshCw className="size-3" />
                )}
                {fetchingQuota ? t('provider.fetchingQuota') : t('provider.fetchQuota')}
              </Button>
            </div>
            {codexQuota ? (
              <div className="space-y-4">
                <QuotaProgressBar
                  label={t('provider.codexQuotaPrimary')}
                  window={codexQuota.primary}
                />
                <QuotaProgressBar
                  label={t('provider.codexQuotaSecondary')}
                  window={codexQuota.secondary}
                />
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                {t('provider.codexQuotaUnavailable')}
              </p>
            )}
          </section>
        )}

        {isOAuthAuth && isCopilotProvider && (
          <section className="space-y-4 pt-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium">{t('provider.copilotStatusTitle')}</label>
                {copilotQuota && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button className="text-muted-foreground hover:text-foreground transition-colors">
                        <MonitorSmartphone className="size-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="p-3 max-w-xs space-y-2">
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-xs text-muted-foreground">
                          {t('provider.copilotQuotaSku')}
                        </span>
                        <span className="text-xs font-semibold">{copilotQuota.sku || '-'}</span>
                      </div>
                      <div className="flex items-center justify-between gap-4 border-t pt-2">
                        <span className="text-xs text-muted-foreground">
                          {t('provider.copilotQuotaChat')}
                        </span>
                        <span className="text-xs font-semibold">
                          {copilotQuota.chatEnabled
                            ? t('provider.copilotChatEnabled')
                            : t('provider.copilotChatDisabled')}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-4 border-t pt-2">
                        <span className="text-xs text-muted-foreground">
                          {t('provider.copilotQuotaTelemetry')}
                        </span>
                        <span className="text-xs font-semibold">
                          {copilotQuota.telemetry || '-'}
                        </span>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-xs"
                disabled={!authReadyForUi || fetchingQuota}
                onClick={() => void handleFetchQuota()}
              >
                {fetchingQuota ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <RefreshCw className="size-3" />
                )}
                {fetchingQuota ? t('provider.fetchingQuota') : t('provider.fetchQuota')}
              </Button>
            </div>
            {copilotQuota ? (
              <div className="rounded-md border bg-muted/20 px-3 py-3 space-y-2 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{t('provider.copilotQuotaSku')}</span>
                  <span className="font-semibold">{copilotQuota.sku || '-'}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{t('provider.copilotQuotaChat')}</span>
                  <span className="font-semibold">
                    {copilotQuota.chatEnabled
                      ? t('provider.copilotChatEnabled')
                      : t('provider.copilotChatDisabled')}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">
                    {t('provider.copilotQuotaTelemetry')}
                  </span>
                  <span className="font-semibold">{copilotQuota.telemetry || '-'}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">
                    {t('provider.copilotQuotaTokenExpires')}
                  </span>
                  <span className="font-semibold">
                    {copilotQuota.tokenExpiresAt
                      ? new Date(copilotQuota.tokenExpiresAt).toLocaleString()
                      : '-'}
                  </span>
                </div>
                <div className="space-y-1 pt-1 border-t">
                  <div className="text-muted-foreground">{t('provider.copilotQuotaApiBase')}</div>
                  <div className="font-mono break-all text-[11px]">
                    {copilotQuota.apiBaseUrl || '-'}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                {t('provider.codexQuotaUnavailable')}
              </p>
            )}
          </section>
        )}

        {isOAuthAuth && !hideOAuthSettings && (
          <section className="space-y-2 mt-4">
            <label className="text-sm font-medium">{t('provider.oauthSettings')}</label>
            <div className="grid gap-3">
              {!oauthClientIdLocked ? (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">{t('provider.oauthClientId')}</label>
                  <Input
                    placeholder={t('provider.oauthClientIdPlaceholder')}
                    value={oauthConfig.clientId}
                    onChange={(e) => updateOAuthConfig({ clientId: e.target.value })}
                    className="text-xs"
                  />
                </div>
              ) : (
                <div className="text-[11px] text-muted-foreground">
                  {t('provider.oauthClientIdLocked')}
                </div>
              )}
              <div className="space-y-1.5">
                <label className="text-xs font-medium">{t('provider.oauthAuthorizeUrl')}</label>
                <Input
                  placeholder="https://example.com/oauth/authorize"
                  value={oauthConfig.authorizeUrl}
                  onChange={(e) => updateOAuthConfig({ authorizeUrl: e.target.value })}
                  className="text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">{t('provider.oauthTokenUrl')}</label>
                <Input
                  placeholder="https://example.com/oauth/token"
                  value={oauthConfig.tokenUrl}
                  onChange={(e) => updateOAuthConfig({ tokenUrl: e.target.value })}
                  className="text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">{t('provider.oauthScope')}</label>
                <Input
                  placeholder={t('provider.oauthScopePlaceholder')}
                  value={oauthConfig.scope ?? ''}
                  onChange={(e) => updateOAuthConfig({ scope: e.target.value })}
                  className="text-xs"
                />
              </div>
              {isCopilotProvider && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium">{t('provider.oauthHost')}</label>
                      <Input
                        placeholder="https://github.com"
                        value={oauthConfig.host ?? ''}
                        onChange={(e) => updateOAuthConfig({ host: e.target.value || undefined })}
                        className="text-xs"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium">{t('provider.oauthApiHost')}</label>
                      <Input
                        placeholder="https://api.github.com"
                        value={oauthConfig.apiHost ?? ''}
                        onChange={(e) =>
                          updateOAuthConfig({ apiHost: e.target.value || undefined })
                        }
                        className="text-xs"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">
                      {t('provider.oauthDeviceCodeUrl')}
                    </label>
                    <Input
                      placeholder="https://github.com/login/device/code"
                      value={oauthConfig.deviceCodeUrl ?? ''}
                      onChange={(e) =>
                        updateOAuthConfig({ deviceCodeUrl: e.target.value || undefined })
                      }
                      className="text-xs"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">
                      {t('provider.oauthTokenExchangeUrl')}
                    </label>
                    <Input
                      placeholder="https://api.github.com/copilot_internal/v2/token"
                      value={oauthConfig.tokenExchangeUrl ?? ''}
                      onChange={(e) =>
                        updateOAuthConfig({ tokenExchangeUrl: e.target.value || undefined })
                      }
                      className="text-xs"
                    />
                  </div>
                </>
              )}
              {oauthConfig.flowType !== 'device_code' && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">{t('provider.oauthRedirectPath')}</label>
                    <Input
                      placeholder="/auth/callback"
                      value={oauthConfig.redirectPath ?? ''}
                      onChange={(e) =>
                        updateOAuthConfig({ redirectPath: e.target.value || undefined })
                      }
                      className="text-xs"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">{t('provider.oauthRedirectPort')}</label>
                    <Input
                      type="number"
                      placeholder="0"
                      value={oauthConfig.redirectPort?.toString() ?? ''}
                      onChange={(e) => {
                        const value = e.target.value.trim()
                        const nextPort = value ? Number(value) : undefined
                        updateOAuthConfig({
                          redirectPort: Number.isFinite(nextPort) ? nextPort : undefined
                        })
                      }}
                      className="text-xs"
                    />
                  </div>
                </div>
              )}
              {oauthConfig.flowType !== 'device_code' && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {t('provider.oauthUsePkce')}
                  </span>
                  <Switch
                    checked={oauthConfig.usePkce !== false}
                    onCheckedChange={(checked) => updateOAuthConfig({ usePkce: checked })}
                  />
                </div>
              )}
            </div>
          </section>
        )}

        {isChannelAuth && (
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">{t('provider.channelLogin')}</label>
              <div className="flex items-center gap-2">
                <span
                  className={`text-xs ${provider.channel?.accessToken ? 'text-emerald-600' : 'text-muted-foreground'}`}
                >
                  {provider.channel?.accessToken
                    ? t('provider.channelConnected')
                    : t('provider.channelNotConnected')}
                </span>
                {provider.channel?.accessToken && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-1.5 text-[11px]"
                    onClick={() => void handleCopyAccountJson()}
                  >
                    <Copy className="size-3" />
                    {t('provider.copyAccountJson')}
                  </Button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">{t('provider.channelAppId')}</label>
                <Input
                  placeholder={t('provider.channelAppIdPlaceholder')}
                  value={channelAppIdValue}
                  onChange={(e) => handleChannelCredentialChange('appId', e.target.value)}
                  className="text-xs"
                  disabled={channelAppIdLocked}
                />
                {channelAppIdLocked && (
                  <p className="text-[11px] text-muted-foreground">
                    {t('provider.channelAppIdLocked')}
                  </p>
                )}
              </div>
              {channelRequiresAppToken ? (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">{t('provider.channelAppToken')}</label>
                  <div className="relative w-full sm:w-auto">
                    <Input
                      type={showChannelToken ? 'text' : 'password'}
                      placeholder={t('provider.channelAppTokenPlaceholder')}
                      value={provider.channel?.appToken ?? ''}
                      onChange={(e) => handleChannelCredentialChange('appToken', e.target.value)}
                      className="pr-9 text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => setShowChannelToken((v) => !v)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                      tabIndex={-1}
                    >
                      {showChannelToken ? (
                        <EyeOff className="size-3.5" />
                      ) : (
                        <Eye className="size-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-end text-[11px] text-muted-foreground">
                  {t('provider.channelAppTokenOptional')}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">{t('provider.channelType')}</label>
                <Select
                  value={channelType}
                  onValueChange={(v) => handleChannelTypeChange(v as 'sms' | 'email')}
                >
                  <SelectTrigger className="text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sms" className="text-xs">
                      {t('provider.channelSms')}
                    </SelectItem>
                    <SelectItem value="email" className="text-xs">
                      {t('provider.channelEmail')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">
                  {channelType === 'sms'
                    ? t('provider.channelMobile')
                    : t('provider.channelEmailAddress')}
                </label>
                <Input
                  placeholder={
                    channelType === 'sms'
                      ? t('provider.channelMobilePlaceholder')
                      : t('provider.channelEmailPlaceholder')
                  }
                  value={channelType === 'sms' ? channelMobile : channelEmail}
                  onChange={(e) => {
                    if (channelType === 'sms') setChannelMobile(e.target.value)
                    else setChannelEmail(e.target.value)
                  }}
                  className="text-xs"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">{t('provider.channelCode')}</label>
                <Input
                  placeholder={t('provider.channelCodePlaceholder')}
                  value={channelCode}
                  onChange={(e) => setChannelCode(e.target.value)}
                  className="text-xs"
                />
              </div>
              <div className="flex items-end">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-full gap-1 text-xs"
                  disabled={channelSending}
                  onClick={handleChannelSendCode}
                >
                  {channelSending && <Loader2 className="size-3 animate-spin" />}
                  {channelSending ? t('provider.channelSending') : t('provider.channelSendCode')}
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                className="h-8 gap-1 text-xs"
                disabled={channelVerifying}
                onClick={handleChannelVerify}
              >
                {channelVerifying && <Loader2 className="size-3 animate-spin" />}
                {channelVerifying ? t('provider.channelVerifying') : t('provider.channelVerify')}
              </Button>
              {provider.channel?.accessToken && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1 text-xs"
                    disabled={channelRefreshing}
                    onClick={handleChannelRefreshUser}
                  >
                    {channelRefreshing ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3" />
                    )}
                    {channelRefreshing
                      ? t('provider.channelRefreshing')
                      : t('provider.channelRefreshUser')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={handleChannelDisconnect}
                  >
                    {t('provider.channelDisconnect')}
                  </Button>
                </>
              )}
            </div>

            {provider.channel?.accessToken && provider.channel?.userInfo && (
              <div className="rounded-md border bg-muted/30 p-2 text-[11px] font-mono whitespace-pre-wrap">
                {JSON.stringify(provider.channel.userInfo, null, 2)}
              </div>
            )}
          </section>
        )}

        {/* Base URL */}
        <section className="space-y-2 mt-5">
          <label className="text-sm font-medium">{t('provider.proxyUrl')}</label>
          <Input
            placeholder={builtinPreset?.defaultBaseUrl || 'https://api.example.com'}
            value={provider.baseUrl}
            onChange={(e) => updateProvider(provider.id, { baseUrl: e.target.value })}
            className="text-xs"
          />
          <p className="text-[11px] text-muted-foreground">{t('provider.proxyUrlHint')}</p>
        </section>

        {/* Connection check */}
        <section className="space-y-2 mt-5">
          <label className="text-sm font-medium">{t('provider.connectionCheck')}</label>
          <div className="flex items-center gap-2">
            <Select value={testModelId} onValueChange={(v) => setTestModelId(v)}>
              <SelectTrigger className="flex-1 text-xs">
                <SelectValue
                  placeholder={provider.models[0]?.id || t('provider.noAvailableModels')}
                />
              </SelectTrigger>
              <SelectContent>
                {(provider.models.some((m) => m.enabled)
                  ? provider.models.filter((m) => m.enabled)
                  : provider.models
                ).map((m) => (
                  <SelectItem key={m.id} value={m.id} className="text-xs">
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="h-9 shrink-0 gap-1.5 text-xs"
              disabled={!authReadyForUi || testing}
              onClick={handleTestConnection}
            >
              {testing && <Loader2 className="size-3 animate-spin" />}
              {testing ? t('provider.checking') : t('provider.check')}
            </Button>
          </div>
        </section>

        {/* Protocol type (for custom providers) */}
        {!provider.builtinId && (
          <section className="space-y-2 mt-5">
            <label className="text-sm font-medium">{t('provider.protocolType')}</label>
            <Select
              value={provider.type}
              onValueChange={(v) => updateProvider(provider.id, { type: v as ProviderType })}
            >
              <SelectTrigger className="text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai-chat" className="text-xs">
                  {t('provider.openaiChatCompat')}
                </SelectItem>
                <SelectItem value="openai-responses" className="text-xs">
                  {t('provider.openaiResponses')}
                </SelectItem>
                <SelectItem value="anthropic" className="text-xs">
                  Anthropic
                </SelectItem>
                <SelectItem value="gemini" className="text-xs">
                  Gemini
                </SelectItem>
              </SelectContent>
            </Select>
          </section>
        )}

        {/* Anthropic cache TTL (provider-level default; model-level overrides) */}
        {provider.type === 'anthropic' && (
          <section className="space-y-2 mt-5">
            <label className="text-sm font-medium">{t('provider.cacheTtl')}</label>
            <Select
              value={provider.cacheTtl ?? '5m'}
              onValueChange={(v) => updateProvider(provider.id, { cacheTtl: v as '5m' | '1h' })}
            >
              <SelectTrigger className="w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="5m">5m</SelectItem>
                <SelectItem value="1h">1h</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{t('provider.cacheTtlHint')}</p>
          </section>
        )}

        <Separator className="my-5" />

        {/* Models */}
        <section className="flex flex-col space-y-3">
          <div className="rounded-xl border bg-muted/20 p-3">
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1">
                  <label className="text-sm font-medium">{t('provider.modelList')}</label>
                  <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                    {t('provider.modelCount', {
                      total: provider.models.length,
                      enabled: enabledModelCount
                    })}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 self-start rounded-full border bg-background px-2 py-1 text-[11px] text-muted-foreground">
                  <span className="font-medium text-foreground">{filteredModels.length}</span>
                  <span>/</span>
                  <span>{provider.models.length}</span>
                </div>
              </div>

              <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                <div className="relative flex-1 lg:max-w-xs">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder={t('provider.searchModels')}
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                    className="h-9 border-0 bg-background pl-8 text-xs shadow-none"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-1.5 lg:justify-end">
                  {provider.models.length > 0 && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 rounded-full px-3 text-[11px]"
                        disabled={!hasDisabledModels}
                        onClick={() => handleSetAllModelsEnabled(true)}
                      >
                        {t('provider.enableAllModels')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 rounded-full px-3 text-[11px]"
                        disabled={!hasEnabledModels}
                        onClick={() => handleSetAllModelsEnabled(false)}
                      >
                        {t('provider.disableAllModels')}
                      </Button>
                    </>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1 rounded-full px-3 text-[11px]"
                    disabled={fetchingModels}
                    onClick={handleFetchModels}
                  >
                    {fetchingModels ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3" />
                    )}
                    {t('provider.fetchModels')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 w-8 rounded-full p-0"
                    onClick={() => setAddModelOpen(true)}
                  >
                    <Plus className="size-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <div className="flex min-h-[320px] max-h-[420px] flex-col overflow-hidden rounded-xl border bg-background">
            {filteredModels.length === 0 ? (
              <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
                {provider.models.length === 0
                  ? t('provider.noModels')
                  : t('provider.noMatchResults')}
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto">
                {filteredModels.map((model) => {
                  const capabilityIndicators: Array<{
                    key: string
                    icon: React.ComponentType<{ className?: string }>
                    label: string
                  }> = []
                  if (model.category === 'image') {
                    capabilityIndicators.push({
                      key: 'category-image',
                      icon: ImageIcon,
                      label: t('provider.modelCategoryImage')
                    })
                  } else if (model.category === 'speech') {
                    capabilityIndicators.push({
                      key: 'category-speech',
                      icon: Mic,
                      label: t('provider.modelCategorySpeech')
                    })
                  } else if (model.category === 'embedding') {
                    capabilityIndicators.push({
                      key: 'category-embedding',
                      icon: Shapes,
                      label: t('provider.modelCategoryEmbedding')
                    })
                  }
                  if (modelSupportsVision(model, provider.type)) {
                    capabilityIndicators.push({
                      key: 'vision',
                      icon: Eye,
                      label: t('provider.supportsVision')
                    })
                  }
                  if (model.supportsFunctionCall !== false) {
                    capabilityIndicators.push({
                      key: 'function',
                      icon: Code2,
                      label: t('provider.supportsFunctionCall')
                    })
                  }
                  if (modelSupportsComputerUse(model, provider.type)) {
                    capabilityIndicators.push({
                      key: 'computer-use',
                      icon: MonitorSmartphone,
                      label: model.enableComputerUse
                        ? t('provider.computerUseEnabled')
                        : t('provider.supportsComputerUse')
                    })
                  }
                  if (model.supportsThinking) {
                    capabilityIndicators.push({
                      key: 'thinking',
                      icon: Sparkles,
                      label: t('provider.supportsThinking')
                    })
                  }

                  return (
                    <div
                      key={model.id}
                      className="group flex items-center gap-3 border-b border-border/60 px-4 py-3 transition-colors last:border-b-0 hover:bg-muted/30"
                    >
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted/50 ring-1 ring-border/50">
                        <ModelIcon
                          icon={model.icon}
                          modelId={model.id}
                          providerBuiltinId={provider.builtinId}
                          size={18}
                          className="shrink-0 opacity-70"
                        />
                      </div>
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium truncate">{model.name}</p>
                          <span className="truncate rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                            {model.id}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground/70">
                          {model.contextLength && (
                            <span className="rounded-full bg-muted/45 px-2 py-0.5">
                              {t('provider.modelMetaContext', {
                                count: toRoundedTokenThousands(model.contextLength)
                              })}
                            </span>
                          )}
                          {model.maxOutputTokens && (
                            <span className="rounded-full bg-muted/45 px-2 py-0.5">
                              {t('provider.modelMetaOutput', {
                                count: toRoundedTokenThousands(model.maxOutputTokens)
                              })}
                            </span>
                          )}
                          {(model.inputPrice != null || model.outputPrice != null) && (
                            <span className="rounded-full bg-muted/45 px-2 py-0.5">
                              {t('provider.modelMetaPricing', {
                                input: model.inputPrice ?? '?',
                                output: model.outputPrice ?? '?'
                              })}
                            </span>
                          )}
                          {(model.cacheCreationPrice != null || model.cacheHitPrice != null) && (
                            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-emerald-600 dark:text-emerald-400">
                              {model.cacheCreationPrice != null && model.cacheHitPrice != null
                                ? t('provider.modelMetaCachePair', {
                                    write: model.cacheCreationPrice,
                                    read: model.cacheHitPrice
                                  })
                                : model.cacheCreationPrice != null
                                  ? t('provider.modelMetaCacheWrite', {
                                      write: model.cacheCreationPrice
                                    })
                                  : t('provider.modelMetaCacheRead', {
                                      read: model.cacheHitPrice
                                    })}
                            </span>
                          )}
                          {(model.premiumRequestMultiplier != null ||
                            model.availablePlans?.length) && (
                            <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-sky-600 dark:text-sky-400">
                              {model.premiumRequestMultiplier != null
                                ? t('provider.modelMetaPremium', {
                                    multiplier: model.premiumRequestMultiplier
                                  })
                                : t('provider.availablePlans')}
                              {model.availablePlans?.length
                                ? ` · ${model.availablePlans.join('/')}`
                                : ''}
                            </span>
                          )}
                          {capabilityIndicators.length > 0 && (
                            <span className="flex items-center gap-1 text-muted-foreground/60">
                              {capabilityIndicators.map(({ key, icon: Icon, label }) => (
                                <Tooltip key={`${model.id}-${key}`}>
                                  <TooltipTrigger asChild>
                                    <span className="inline-flex size-5 items-center justify-center rounded-full bg-muted/60 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                                      <Icon className="size-3" />
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="text-[11px]">
                                    {label}
                                  </TooltipContent>
                                </Tooltip>
                              ))}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="ml-auto flex items-center gap-1.5 self-start pl-2">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="flex size-7 items-center justify-center rounded-full border border-transparent text-muted-foreground/40 transition-all hover:border-border hover:bg-background hover:text-foreground group-hover:opacity-100 sm:opacity-0"
                              onClick={() => setEditingModel(model)}
                            >
                              <Pencil className="size-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-[11px]">
                            {t('provider.editModel')}
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className={`flex size-7 items-center justify-center rounded-full border border-transparent transition-all hover:border-border hover:bg-background group-hover:opacity-100 sm:opacity-0 ${
                                model.supportsThinking
                                  ? 'text-violet-500 hover:text-violet-500'
                                  : 'text-muted-foreground/40 hover:text-foreground'
                              }`}
                              onClick={() => setEditingThinkingModel(model)}
                            >
                              <Brain className="size-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-[11px]">
                            {model.supportsThinking
                              ? t('provider.editThinkConfig')
                              : t('provider.configThinkSupport')}
                          </TooltipContent>
                        </Tooltip>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 rounded-full p-0 text-muted-foreground/40 transition-all hover:bg-background hover:text-destructive group-hover:opacity-100 sm:opacity-0"
                          onClick={() => removeModel(provider.id, model.id)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                        <div className="rounded-full border bg-background px-1.5 py-1">
                          <Switch
                            checked={model.enabled}
                            onCheckedChange={() => toggleModelEnabled(provider.id, model.id)}
                          />
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Add model dialog */}
      <ModelFormDialog
        open={addModelOpen}
        onOpenChange={setAddModelOpen}
        providerType={provider.type}
        resolveManagedModel={getManagedModelById}
        onSave={(model) => addModel(provider.id, model)}
      />

      {/* Edit model dialog */}
      {editingModel && (
        <ModelFormDialog
          open={!!editingModel}
          onOpenChange={(v) => {
            if (!v) setEditingModel(null)
          }}
          providerType={provider.type}
          initial={editingModel}
          onSave={(model) => {
            updateModel(provider.id, editingModel.id, model)
            setEditingModel(null)
          }}
        />
      )}

      {/* Thinking config dialog */}
      {editingThinkingModel && (
        <ThinkingConfigDialog
          model={editingThinkingModel}
          open={!!editingThinkingModel}
          onOpenChange={(v) => {
            if (!v) setEditingThinkingModel(null)
          }}
          onSave={(supportsThinking, thinkingConfig) => {
            updateModel(provider.id, editingThinkingModel.id, {
              supportsThinking,
              thinkingConfig: supportsThinking ? thinkingConfig : undefined
            })
            setEditingThinkingModel(null)
          }}
        />
      )}
    </div>
  )
}

export function ModelManagementPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const managedModels = useProviderStore((s) => s.managedModels)
  const providers = useProviderStore((s) => s.providers)
  const addManagedModel = useProviderStore((s) => s.addManagedModel)
  const updateManagedModel = useProviderStore((s) => s.updateManagedModel)
  const removeManagedModel = useProviderStore((s) => s.removeManagedModel)
  const resetModelConfigurationToDefaults = useProviderStore(
    (s) => s.resetModelConfigurationToDefaults
  )

  const [modelSearch, setModelSearch] = useState('')
  const [providerFilter, setProviderFilter] = useState(ALL_PROVIDER_FILTER)
  const [addModelOpen, setAddModelOpen] = useState(false)
  const [editingModel, setEditingModel] = useState<ManagedModelConfig | null>(null)
  const [editingThinkingModel, setEditingThinkingModel] = useState<ManagedModelConfig | null>(null)

  const providerSourceIndex = useMemo(
    () => buildManagedModelProviderSourceIndex(providers),
    [providers]
  )
  const providerFilterOptions = useMemo(() => {
    const optionsByKey = new Map<string, ManagedModelProviderSource>()
    for (const model of managedModels) {
      const sources = providerSourceIndex.get(model.normalizedKey) ?? []
      for (const source of sources) {
        optionsByKey.set(source.key, source)
      }
    }
    return sortManagedModelProviderSources(Array.from(optionsByKey.values()))
  }, [managedModels, providerSourceIndex])

  const resolvedProviderFilter =
    providerFilter === ALL_PROVIDER_FILTER ||
    providerFilterOptions.some((option) => option.key === providerFilter)
      ? providerFilter
      : ALL_PROVIDER_FILTER

  const enabledModelCount = managedModels.filter((model) => model.enabled).length
  const configuredProviderSourceCount = providerFilterOptions.filter(
    (source) => source.configured
  ).length
  const presetProviderSourceCount = providerFilterOptions.length - configuredProviderSourceCount
  const filteredModels = useMemo(() => {
    const query = modelSearch.toLowerCase()
    return managedModels.filter((model) => {
      const sources = providerSourceIndex.get(model.normalizedKey) ?? []
      const matchesProvider =
        resolvedProviderFilter === ALL_PROVIDER_FILTER ||
        sources.some((source) => source.key === resolvedProviderFilter)
      if (!matchesProvider) return false
      if (!query) return true
      return (
        model.name.toLowerCase().includes(query) ||
        model.id.toLowerCase().includes(query) ||
        sources.some(
          (source) =>
            source.name.toLowerCase().includes(query) ||
            source.type.toLowerCase().includes(query) ||
            source.builtinId?.toLowerCase().includes(query)
        )
      )
    })
  }, [managedModels, modelSearch, resolvedProviderFilter, providerSourceIndex])

  const handleSaveManagedModel = (model: AIModelConfig, currentKey?: string): boolean => {
    const nextKey = normalizeModelKey(model.id)
    const duplicate = managedModels.find(
      (item) => item.normalizedKey === nextKey && item.normalizedKey !== currentKey
    )
    if (duplicate) {
      toast.error(t('provider.modelManagementDuplicate', { id: duplicate.id }))
      return false
    }

    if (currentKey) {
      updateManagedModel(currentKey, model)
    } else {
      addManagedModel(model)
    }
    return true
  }

  const handleRestoreManagedModelDefaults = async (): Promise<void> => {
    const ok = await confirm({
      title: t('provider.modelManagementRestoreDefaultsConfirm'),
      description: t('provider.modelManagementRestoreDefaultsDesc'),
      confirmLabel: t('provider.modelManagementRestoreDefaults'),
      variant: 'destructive'
    })
    if (!ok) return

    resetModelConfigurationToDefaults()
    setModelSearch('')
    setProviderFilter(ALL_PROVIDER_FILTER)
    setEditingModel(null)
    setEditingThinkingModel(null)
    toast.success(t('provider.modelManagementRestoreDefaultsDone'))
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl bg-background shadow-sm">
      <div className="shrink-0 border-b bg-muted/10 px-5 py-4">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-background text-primary shadow-xs">
                <Layers className="size-4" />
              </div>
              <div className="min-w-0">
                <h3 className="truncate text-base font-semibold">
                  {t('provider.modelManagement')}
                </h3>
                <p className="mt-0.5 max-w-2xl text-xs leading-5 text-muted-foreground">
                  {t('provider.modelManagementDesc')}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 rounded-lg px-3 text-xs text-muted-foreground"
                onClick={() => void handleRestoreManagedModelDefaults()}
              >
                <RefreshCw className="size-3.5" />
                {t('provider.modelManagementRestoreDefaults')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 rounded-lg px-3 text-xs"
                onClick={() => setAddModelOpen(true)}
              >
                <Plus className="size-3.5" />
                {t('provider.addModel')}
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {[
              {
                label: t('provider.modelManagementStatTotal'),
                value: managedModels.length.toLocaleString()
              },
              {
                label: t('provider.modelManagementStatEnabled'),
                value: enabledModelCount.toLocaleString()
              },
              {
                label: t('provider.modelManagementStatProviders'),
                value: providerFilterOptions.length.toLocaleString()
              },
              {
                label: t('provider.modelManagementStatMatches'),
                value: filteredModels.length.toLocaleString()
              }
            ].map((item) => (
              <div key={item.label} className="rounded-xl border bg-background px-3 py-2">
                <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                  {item.label}
                </div>
                <div className="mt-1 text-lg font-semibold leading-none">{item.value}</div>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0 text-xs text-muted-foreground">
              {t('provider.modelManagementCount', {
                total: managedModels.length,
                enabled: enabledModelCount
              })}
              <span className="mx-2 text-muted-foreground/40">/</span>
              {t('provider.modelManagementSourceSummary', {
                configured: configuredProviderSourceCount,
                preset: presetProviderSourceCount
              })}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row lg:justify-end">
              <Select value={resolvedProviderFilter} onValueChange={setProviderFilter}>
                <SelectTrigger className="h-8 w-full bg-background text-xs sm:w-52">
                  <SelectValue placeholder={t('provider.allModelProviders')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_PROVIDER_FILTER} className="text-xs">
                    <span className="flex items-center gap-2">
                      <Layers className="size-3.5" />
                      {t('provider.allModelProviders')}
                    </span>
                  </SelectItem>
                  {providerFilterOptions.map((source) => (
                    <SelectItem key={source.key} value={source.key} className="text-xs">
                      <span className="flex min-w-0 items-center gap-2">
                        <ProviderIcon builtinId={source.builtinId} size={14} />
                        <span className="truncate">{source.name}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
                <Input
                  placeholder={t('provider.searchManagedModels')}
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                  className="h-8 w-full bg-background pl-8 text-xs sm:w-64"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b bg-background/95 px-5 py-2">
          <div className="truncate text-xs font-medium">{t('provider.modelManagementList')}</div>
          <div className="shrink-0 text-[11px] text-muted-foreground">
            {t('provider.modelManagementShowing', {
              shown: filteredModels.length,
              total: managedModels.length
            })}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {filteredModels.length === 0 ? (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
              {managedModels.length === 0
                ? t('provider.noManagedModels')
                : t('provider.noMatchResults')}
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              {filteredModels.map((model) => {
                const capabilityIndicators: Array<{
                  key: string
                  icon: React.ComponentType<{ className?: string }>
                  label: string
                }> = []
                if (model.category === 'image') {
                  capabilityIndicators.push({
                    key: 'category-image',
                    icon: ImageIcon,
                    label: t('provider.modelCategoryImage')
                  })
                } else if (model.category === 'speech') {
                  capabilityIndicators.push({
                    key: 'category-speech',
                    icon: Mic,
                    label: t('provider.modelCategorySpeech')
                  })
                } else if (model.category === 'embedding') {
                  capabilityIndicators.push({
                    key: 'category-embedding',
                    icon: Shapes,
                    label: t('provider.modelCategoryEmbedding')
                  })
                }
                if (modelSupportsVision(model, model.type)) {
                  capabilityIndicators.push({
                    key: 'vision',
                    icon: Eye,
                    label: t('provider.supportsVision')
                  })
                }
                if (model.supportsFunctionCall !== false) {
                  capabilityIndicators.push({
                    key: 'function',
                    icon: Code2,
                    label: t('provider.supportsFunctionCall')
                  })
                }
                if (modelSupportsComputerUse(model, model.type)) {
                  capabilityIndicators.push({
                    key: 'computer-use',
                    icon: MonitorSmartphone,
                    label: model.enableComputerUse
                      ? t('provider.computerUseEnabled')
                      : t('provider.supportsComputerUse')
                  })
                }
                if (model.supportsThinking) {
                  capabilityIndicators.push({
                    key: 'thinking',
                    icon: Sparkles,
                    label: t('provider.supportsThinking')
                  })
                }
                const providerSources = providerSourceIndex.get(model.normalizedKey) ?? []
                const primaryProviderSource = providerSources[0]
                const visibleProviderSources = providerSources.slice(0, 4)
                const hiddenProviderCount = Math.max(0, providerSources.length - 4)

                return (
                  <div
                    key={model.normalizedKey}
                    className={`group flex items-center gap-3 border-b border-border/60 px-5 py-3 transition-colors last:border-b-0 hover:bg-muted/25 ${
                      model.enabled ? '' : 'bg-muted/10 opacity-75'
                    }`}
                  >
                    <div className="relative flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/45 ring-1 ring-border/60">
                      <ModelIcon
                        icon={model.icon}
                        modelId={model.id}
                        providerBuiltinId={primaryProviderSource?.builtinId}
                        size={20}
                        className="shrink-0 opacity-80"
                      />
                      {primaryProviderSource && (
                        <span className="absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full border border-background bg-background shadow-sm">
                          <ProviderIcon builtinId={primaryProviderSource.builtinId} size={13} />
                        </span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <p className="truncate text-sm font-medium">{model.name}</p>
                        {!model.enabled && (
                          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {t('provider.disabled')}
                          </span>
                        )}
                        <span className="truncate font-mono text-[10px] text-muted-foreground/50">
                          {model.id}
                        </span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground/60">
                        {providerSources.length > 0 ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-flex max-w-full items-center gap-1.5 rounded-lg border bg-muted/20 px-2 py-1 text-muted-foreground/80">
                                <span className="flex -space-x-1.5">
                                  {visibleProviderSources.map((source) => (
                                    <span
                                      key={source.key}
                                      className={`flex size-5 items-center justify-center rounded-full border border-background bg-background shadow-xs ${
                                        source.configured && source.enabled === false
                                          ? 'opacity-45'
                                          : ''
                                      }`}
                                    >
                                      <ProviderIcon builtinId={source.builtinId} size={13} />
                                    </span>
                                  ))}
                                </span>
                                <span className="truncate">
                                  {t('provider.modelManagementSourceCount', {
                                    count: providerSources.length
                                  })}
                                </span>
                                {hiddenProviderCount > 0 && (
                                  <span className="shrink-0">+{hiddenProviderCount}</span>
                                )}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="text-[11px]">
                              <div className="flex max-w-64 flex-col gap-1">
                                {providerSources.map((source) => (
                                  <div key={source.key} className="flex items-center gap-1.5">
                                    <ProviderIcon builtinId={source.builtinId} size={12} />
                                    <span className="min-w-0 flex-1 truncate">{source.name}</span>
                                    <span className="text-muted-foreground/70">
                                      {source.configured
                                        ? source.enabled
                                          ? t('provider.enabled')
                                          : t('provider.disabled')
                                        : t('provider.modelManagementPresetProvider')}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 rounded-lg border bg-muted/20 px-2 py-1 text-muted-foreground/80">
                            <ProviderIcon size={13} />
                            {t('provider.modelManagementNoSource')}
                          </span>
                        )}
                        {model.contextLength && (
                          <span className="rounded-full bg-muted/45 px-2 py-0.5">
                            {t('provider.modelMetaContext', {
                              count: toRoundedTokenThousands(model.contextLength)
                            })}
                          </span>
                        )}
                        {model.maxOutputTokens && (
                          <span className="rounded-full bg-muted/45 px-2 py-0.5">
                            {t('provider.modelMetaOutput', {
                              count: toRoundedTokenThousands(model.maxOutputTokens)
                            })}
                          </span>
                        )}
                        {(model.inputPrice != null || model.outputPrice != null) && (
                          <span className="rounded-full bg-muted/45 px-2 py-0.5">
                            {t('provider.modelMetaPricing', {
                              input: model.inputPrice ?? '?',
                              output: model.outputPrice ?? '?'
                            })}
                          </span>
                        )}
                        {(model.cacheCreationPrice != null || model.cacheHitPrice != null) && (
                          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-emerald-600 dark:text-emerald-400">
                            {model.cacheCreationPrice != null && model.cacheHitPrice != null
                              ? t('provider.modelMetaCachePair', {
                                  write: model.cacheCreationPrice,
                                  read: model.cacheHitPrice
                                })
                              : model.cacheCreationPrice != null
                                ? t('provider.modelMetaCacheWrite', {
                                    write: model.cacheCreationPrice
                                  })
                                : t('provider.modelMetaCacheRead', {
                                    read: model.cacheHitPrice
                                  })}
                          </span>
                        )}
                        {(model.premiumRequestMultiplier != null ||
                          model.availablePlans?.length) && (
                          <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-sky-600 dark:text-sky-400">
                            {model.premiumRequestMultiplier != null
                              ? t('provider.modelMetaPremium', {
                                  multiplier: model.premiumRequestMultiplier
                                })
                              : t('provider.availablePlans')}
                            {model.availablePlans?.length
                              ? ` · ${model.availablePlans.join('/')}`
                              : ''}
                          </span>
                        )}
                        {capabilityIndicators.length > 0 && (
                          <span className="flex items-center gap-1 text-muted-foreground/60">
                            {capabilityIndicators.map(({ key, icon: Icon, label }) => (
                              <Tooltip key={`${model.normalizedKey}-${key}`}>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex size-5 items-center justify-center rounded-full bg-muted/60 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                                    <Icon className="size-3" />
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="text-[11px]">
                                  {label}
                                </TooltipContent>
                              </Tooltip>
                            ))}
                          </span>
                        )}
                      </div>
                    </div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="flex size-7 items-center justify-center rounded-lg text-muted-foreground/45 opacity-100 transition-colors hover:bg-muted hover:text-foreground lg:opacity-0 lg:group-hover:opacity-100"
                          onClick={() => setEditingModel(model)}
                        >
                          <Pencil className="size-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-[11px]">
                        {t('provider.editModel')}
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className={`flex size-7 items-center justify-center rounded-lg opacity-100 transition-colors hover:bg-muted lg:opacity-0 lg:group-hover:opacity-100 ${
                            model.supportsThinking
                              ? 'text-violet-500'
                              : 'text-muted-foreground/45 hover:text-foreground'
                          }`}
                          onClick={() => setEditingThinkingModel(model)}
                        >
                          <Brain className="size-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-[11px]">
                        {model.supportsThinking
                          ? t('provider.editThinkConfig')
                          : t('provider.configThinkSupport')}
                      </TooltipContent>
                    </Tooltip>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-muted-foreground/45 opacity-100 transition-all hover:text-destructive lg:opacity-0 lg:group-hover:opacity-100"
                      onClick={async () => {
                        const ok = await confirm({
                          title: t('provider.modelManagementDeleteConfirm', { name: model.name }),
                          variant: 'destructive'
                        })
                        if (!ok) return
                        removeManagedModel(model.id)
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                    <div className="rounded-full border bg-background px-1 py-0.5">
                      <Switch
                        checked={model.enabled}
                        onCheckedChange={() => {
                          updateManagedModel(model.id, {
                            ...toModelConfig(model),
                            enabled: !model.enabled
                          })
                        }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <ModelFormDialog
        open={addModelOpen}
        onOpenChange={setAddModelOpen}
        providerType={null}
        onSave={(model) => handleSaveManagedModel(model)}
      />

      {editingModel && (
        <ModelFormDialog
          open={!!editingModel}
          onOpenChange={(value) => {
            if (!value) setEditingModel(null)
          }}
          providerType={null}
          initial={editingModel}
          allowIdEditing
          onSave={(model) => {
            const saved = handleSaveManagedModel(model, editingModel.normalizedKey)
            if (saved) {
              setEditingModel(null)
            }
            return saved
          }}
        />
      )}

      {editingThinkingModel && (
        <ThinkingConfigDialog
          model={editingThinkingModel}
          open={!!editingThinkingModel}
          onOpenChange={(value) => {
            if (!value) setEditingThinkingModel(null)
          }}
          onSave={(supportsThinking, thinkingConfig) => {
            updateManagedModel(editingThinkingModel.id, {
              ...toModelConfig(editingThinkingModel),
              supportsThinking,
              thinkingConfig: supportsThinking ? thinkingConfig : undefined
            })
            setEditingThinkingModel(null)
          }}
        />
      )}
    </div>
  )
}

// --- Thinking Config Dialog ---

function ThinkingConfigDialog({
  model,
  open,
  onOpenChange,
  onSave
}: {
  model: AIModelConfig
  open: boolean
  onOpenChange: (v: boolean) => void
  onSave: (supportsThinking: boolean, thinkingConfig?: ThinkingConfig) => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [enabled, setEnabled] = useState(model.supportsThinking ?? false)
  const [bodyParamsJson, setBodyParamsJson] = useState(
    model.thinkingConfig?.bodyParams
      ? JSON.stringify(model.thinkingConfig.bodyParams, null, 2)
      : '{\n  \n}'
  )
  const [forceTemp, setForceTemp] = useState(
    model.thinkingConfig?.forceTemperature?.toString() ?? ''
  )
  const [disabledBodyParamsJson, setDisabledBodyParamsJson] = useState(
    model.thinkingConfig?.disabledBodyParams
      ? JSON.stringify(model.thinkingConfig.disabledBodyParams, null, 2)
      : ''
  )
  const [reasoningEffortLevels, setReasoningEffortLevels] = useState<ReasoningEffortLevel[]>(
    model.thinkingConfig?.reasoningEffortLevels ?? []
  )
  const [defaultReasoningEffort, setDefaultReasoningEffort] = useState<ReasoningEffortLevel>(
    model.thinkingConfig?.defaultReasoningEffort ??
      model.thinkingConfig?.reasoningEffortLevels?.[0] ??
      'medium'
  )
  const [jsonError, setJsonError] = useState('')

  const toggleReasoningEffortLevel = (level: ReasoningEffortLevel): void => {
    const nextLevels = reasoningEffortLevels.includes(level)
      ? REASONING_EFFORT_OPTIONS.filter(
          (option) => option !== level && reasoningEffortLevels.includes(option)
        )
      : REASONING_EFFORT_OPTIONS.filter(
          (option) => option === level || reasoningEffortLevels.includes(option)
        )

    setReasoningEffortLevels(nextLevels)

    if (nextLevels.length === 0) {
      setDefaultReasoningEffort('medium')
      return
    }

    if (!nextLevels.includes(defaultReasoningEffort)) {
      setDefaultReasoningEffort(nextLevels[0])
    }
  }

  const handleSave = (): void => {
    if (!enabled) {
      onSave(false)
      return
    }
    try {
      const parsed = JSON.parse(bodyParamsJson)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setJsonError(t('provider.thinkJsonObjError'))
        return
      }
      const config: ThinkingConfig = { bodyParams: parsed }
      if (disabledBodyParamsJson.trim()) {
        try {
          const disabledParsed = JSON.parse(disabledBodyParamsJson)
          if (
            typeof disabledParsed === 'object' &&
            disabledParsed !== null &&
            !Array.isArray(disabledParsed)
          ) {
            config.disabledBodyParams = disabledParsed
          } else {
            setJsonError(t('provider.thinkJsonObjError'))
            return
          }
        } catch {
          setJsonError(t('provider.thinkJsonInvalid'))
          return
        }
      }
      if (reasoningEffortLevels.length > 0) {
        config.reasoningEffortLevels = reasoningEffortLevels
        config.defaultReasoningEffort = reasoningEffortLevels.includes(defaultReasoningEffort)
          ? defaultReasoningEffort
          : reasoningEffortLevels[0]
      }
      if (forceTemp.trim()) {
        const temp = parseFloat(forceTemp)
        if (!isNaN(temp)) config.forceTemperature = temp
      }
      onSave(true, config)
    } catch {
      setJsonError(t('provider.thinkJsonInvalid'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('provider.configThinkSupport')}</DialogTitle>
          <DialogDescription>
            {t('provider.thinkConfigDesc', { model: model.name })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">{t('provider.enableThink')}</label>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>

          {enabled && (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('provider.thinkBodyParams')}</label>
                <p className="text-[11px] text-muted-foreground">
                  {t('provider.thinkBodyParamsHint')}
                </p>
                <textarea
                  value={bodyParamsJson}
                  onChange={(e) => {
                    setBodyParamsJson(e.target.value)
                    setJsonError('')
                  }}
                  className="w-full h-24 rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  {t('provider.thinkDisabledBodyParams')}
                </label>
                <p className="text-[11px] text-muted-foreground">
                  {t('provider.thinkDisabledBodyParamsHint')}
                </p>
                <textarea
                  value={disabledBodyParamsJson}
                  onChange={(e) => {
                    setDisabledBodyParamsJson(e.target.value)
                    setJsonError('')
                  }}
                  className="w-full h-24 rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                  spellCheck={false}
                  placeholder={t('provider.leaveEmpty')}
                />
                {jsonError && <p className="text-[11px] text-destructive">{jsonError}</p>}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('provider.reasoningEffortLevels')}</label>
                <p className="text-[11px] text-muted-foreground">
                  {t('provider.reasoningEffortLevelsHint')}
                </p>
                <div className="flex flex-wrap gap-2">
                  {REASONING_EFFORT_OPTIONS.map((level) => {
                    const selected = reasoningEffortLevels.includes(level)
                    return (
                      <button
                        key={level}
                        type="button"
                        onClick={() => toggleReasoningEffortLevel(level)}
                        className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                          selected
                            ? 'border-violet-500 bg-violet-500/10 text-violet-600 dark:text-violet-400'
                            : 'border-border bg-background hover:bg-muted/50'
                        }`}
                      >
                        {level}
                      </button>
                    )
                  })}
                </div>
              </div>
              {reasoningEffortLevels.length > 0 && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    {t('provider.defaultReasoningEffort')}
                  </label>
                  <p className="text-[11px] text-muted-foreground">
                    {t('provider.defaultReasoningEffortHint')}
                  </p>
                  <Select
                    value={defaultReasoningEffort}
                    onValueChange={(value) =>
                      setDefaultReasoningEffort(value as ReasoningEffortLevel)
                    }
                  >
                    <SelectTrigger className="w-40 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {reasoningEffortLevels.map((level) => (
                        <SelectItem key={level} value={level} className="text-xs">
                          {level}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('provider.forceTemperature')}</label>
                <p className="text-[11px] text-muted-foreground">
                  {t('provider.forceTemperatureHint')}
                </p>
                <Input
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  placeholder={t('provider.leaveEmpty')}
                  value={forceTemp}
                  onChange={(e) => setForceTemp(e.target.value)}
                  className="w-32 text-xs"
                />
              </div>
            </>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t('action.cancel', { ns: 'common' })}
            </Button>
            <Button size="sm" onClick={handleSave}>
              {t('action.save', { ns: 'common' })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// --- Main ProviderPanel ---

export function ProviderPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const providers = useProviderStore((s) => s.providers)
  const removeProvider = useProviderStore((s) => s.removeProvider)

  const [selectedId, setSelectedId] = useState<string | null>(
    () => providers.find((p) => p.enabled)?.id ?? providers[0]?.id ?? null
  )
  const [searchQuery, setSearchQuery] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)

  const resolvedSelectedId =
    selectedId && providers.some((provider) => provider.id === selectedId)
      ? selectedId
      : (providers.find((provider) => provider.enabled)?.id ?? providers[0]?.id ?? null)

  const selectedProvider = resolvedSelectedId
    ? (providers.find((p) => p.id === resolvedSelectedId) ?? null)
    : null
  const enabledProviders = useMemo(
    () =>
      providers.filter(
        (p) =>
          p.enabled && (!searchQuery || p.name.toLowerCase().includes(searchQuery.toLowerCase()))
      ),
    [providers, searchQuery]
  )
  const disabledProviders = useMemo(
    () =>
      providers.filter(
        (p) =>
          !p.enabled && (!searchQuery || p.name.toLowerCase().includes(searchQuery.toLowerCase()))
      ),
    [providers, searchQuery]
  )

  const handleDeleteProvider = async (provider: AIProvider): Promise<void> => {
    if (provider.builtinId) return
    const ok = await confirm({
      title: t('provider.deleteProvider'),
      description: t('provider.deleteProviderConfirm', { name: provider.name }),
      confirmLabel: t('provider.deleteProvider'),
      variant: 'destructive'
    })
    if (!ok) return
    removeProvider(provider.id)
    if (selectedId === provider.id) {
      setSelectedId(null)
    }
    toast.success(t('provider.providerDeleted'))
  }

  const renderProviderListItem = (provider: AIProvider, muted: boolean): React.JSX.Element => {
    const enabledModelCount = provider.models.filter((model) => model.enabled).length
    const authReady =
      provider.requiresApiKey === false ||
      Boolean(provider.apiKey || provider.oauth?.accessToken || provider.channel?.accessToken)
    const item = (
      <button
        type="button"
        onClick={() => setSelectedId(provider.id)}
        className={`group/provider relative mt-1 flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors ${
          resolvedSelectedId === provider.id
            ? 'bg-primary/10 text-foreground ring-1 ring-primary/15'
            : muted
              ? 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              : 'text-foreground/85 hover:bg-muted/60'
        }`}
      >
        <span
          className={`absolute bottom-2 left-0 top-2 w-0.5 rounded-full ${
            resolvedSelectedId === provider.id ? 'bg-primary' : 'bg-transparent'
          }`}
        />
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background ring-1 ring-border/60">
          <ProviderIcon
            builtinId={provider.builtinId}
            size={18}
            className={muted ? 'opacity-50' : undefined}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">{provider.name}</span>
          <span className="mt-0.5 block truncate text-[10px] text-muted-foreground/70">
            {t('provider.providerModelSummary', {
              enabled: enabledModelCount,
              total: provider.models.length
            })}
          </span>
        </span>
        <span
          className={`size-2 shrink-0 rounded-full ${
            provider.enabled && authReady
              ? 'bg-emerald-500'
              : provider.enabled
                ? 'bg-amber-500'
                : 'bg-muted-foreground/30'
          }`}
        />
      </button>
    )

    return (
      <ContextMenu key={provider.id}>
        <ContextMenuTrigger asChild>{item}</ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          <ContextMenuItem
            className="gap-2 text-xs text-destructive focus:text-destructive"
            disabled={Boolean(provider.builtinId)}
            onSelect={() => void handleDeleteProvider(provider)}
          >
            <Trash2 className="size-3.5" />
            {t('provider.deleteProvider')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left: Provider list */}
        <div className="flex w-60 shrink-0 flex-col border-r bg-muted/10">
          {/* Search + Add */}
          <div className="flex items-center gap-1.5 border-b p-2.5">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/50" />
              <Input
                placeholder={t('provider.searchProviders')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-8 bg-background pl-7 text-xs shadow-none"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-8 shrink-0 rounded-lg p-0 text-muted-foreground hover:text-foreground"
              onClick={() => setDialogOpen(true)}
              title={t('provider.addCustomProvider')}
            >
              <Plus className="size-4" />
            </Button>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto py-2">
            <div className="pb-20">
              {enabledProviders.length > 0 && (
                <div className="px-2 pb-1 pt-1">
                  <p className="px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/55">
                    {t('provider.enabled')}
                  </p>
                  {enabledProviders.map((p) => renderProviderListItem(p, false))}
                </div>
              )}

              {disabledProviders.length > 0 && (
                <div className="px-2 pb-1 pt-3">
                  <p className="px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/55">
                    {t('provider.disabled')}
                  </p>
                  {disabledProviders.map((p) => renderProviderListItem(p, true))}
                </div>
              )}
              {enabledProviders.length === 0 && disabledProviders.length === 0 && (
                <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                  {t('provider.providerNoSearchResults')}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right: Config panel */}
        <div className="flex-1 min-w-0">
          {selectedProvider ? (
            <ProviderConfigPanel provider={selectedProvider} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t('provider.selectToConfig')}
            </div>
          )}
        </div>
      </div>

      {/* Add provider dialog */}
      <AddProviderDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  )
}
