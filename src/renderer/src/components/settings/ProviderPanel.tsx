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
  DialogTitle,
} from '@renderer/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import {
  useProviderStore,
  builtinProviderPresets,
} from '@renderer/stores/provider-store'
import { useQuotaStore, type CodexQuota, type CodexQuotaWindow } from '@renderer/stores/quota-store'
import {
  startProviderOAuth,
  disconnectProviderOAuth,
  refreshProviderOAuth,
  ensureProviderAuthReady,
  sendProviderChannelCode,
  verifyProviderChannelCode,
  refreshProviderChannelUserInfo,
  clearProviderChannelAuth,
} from '@renderer/lib/auth/provider-auth'
import type {
  ProviderType,
  AIModelConfig,
  AIProvider,
  ThinkingConfig,
  ModelCategory,
} from '@renderer/lib/api/types'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { ProviderIcon, ModelIcon } from './provider-icons'

const MODEL_ICON_OPTIONS = [
  'openai', 'claude', 'anthropic', 'gemini', 'deepseek', 'qwen',
  'chatglm', 'minimax', 'kimi', 'moonshot', 'grok', 'meta', 'llama',
  'mistral', 'baidu', 'hunyuan', 'nvidia', 'stepfun', 'doubao',
  'ollama', 'siliconcloud', 'mimo', 'bigmodel',
] as const

// --- Fetch models from provider API ---

async function fetchModelsFromProvider(
  type: ProviderType,
  baseUrl: string,
  apiKey: string,
  builtinId?: string,
  useSystemProxy?: boolean
): Promise<AIModelConfig[]> {
  if (builtinId === 'openrouter') {
    const result = await window.electron.ipcRenderer.invoke('api:request', {
      url: 'https://openrouter.ai/api/frontend/models/find',
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      useSystemProxy,
    })
    if (result?.error) throw new Error(result.error)
    const data = JSON.parse(result.body)
    const models = data?.data?.models ?? data?.data ?? []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return models.slice(0, 200).map((m: any) => ({
      id: m.slug ?? m.id,
      name: m.name ?? m.slug ?? m.id,
      enabled: true,
      contextLength: m.context_length,
    }))
  }

  // For OpenAI-compatible providers: GET /v1/models
  if (type === 'openai-chat' || type === 'openai-responses') {
    const url = `${(baseUrl || 'https://api.openai.com').replace(/\/+$/, '')}/models`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    const result = await window.electron.ipcRenderer.invoke('api:request', {
      url,
      method: 'GET',
      headers,
      useSystemProxy,
    })
    if (result?.error) throw new Error(result.error)
    if (result?.statusCode && result.statusCode >= 400) {
      throw new Error(`HTTP ${result.statusCode}: ${result.body?.slice(0, 200)}`)
    }
    const data = JSON.parse(result.body)
    const models = data?.data ?? []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return models.map((m: any) => ({
      id: m.id,
      name: m.id,
      enabled: true,
    }))
  }

  // For Anthropic: no list API, return empty
  return []
}

// --- Add Custom Provider Dialog ---

function AddProviderDialog({
  open,
  onOpenChange,
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
      createdAt: Date.now(),
    })
    toast.success(t('provider.addedProvider', { name: name.trim() }))
    setName(''); setBaseUrl(''); setType('openai-chat')
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
            <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('action.cancel', { ns: 'common' })}</Button>
            <Button disabled={!name.trim()} onClick={handleAdd}>{t('provider.add')}</Button>
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
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  providerType: ProviderType
  initial?: AIModelConfig
  onSave: (model: AIModelConfig) => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const isEdit = !!initial

  const [id, setId] = useState(initial?.id ?? '')
  const [name, setName] = useState(initial?.name ?? '')
  const [typeOverride, setTypeOverride] = useState<ProviderType | 'none'>(initial?.type ?? 'none')
  const [category, setCategory] = useState<ModelCategory>(initial?.category ?? 'chat')
  const [contextLength, setContextLength] = useState(initial?.contextLength?.toString() ?? '')
  const [maxOutputTokens, setMaxOutputTokens] = useState(initial?.maxOutputTokens?.toString() ?? '')
  const [inputPrice, setInputPrice] = useState(initial?.inputPrice?.toString() ?? '')
  const [outputPrice, setOutputPrice] = useState(initial?.outputPrice?.toString() ?? '')
  const [cacheCreationPrice, setCacheCreationPrice] = useState(initial?.cacheCreationPrice?.toString() ?? '')
  const [cacheHitPrice, setCacheHitPrice] = useState(initial?.cacheHitPrice?.toString() ?? '')
  const [supportsVision, setSupportsVision] = useState(initial?.supportsVision ?? false)
  const [supportsFunctionCall, setSupportsFunctionCall] = useState(initial?.supportsFunctionCall ?? true)
  const [icon, setIcon] = useState(initial?.icon ?? '')
  const [responseSummary, setResponseSummary] = useState<
    'auto' | 'concise' | 'detailed' | 'none'
  >(initial?.responseSummary ?? 'none')
  const [enablePromptCache, setEnablePromptCache] = useState(initial?.enablePromptCache ?? true)
  const [enableSystemPromptCache, setEnableSystemPromptCache] = useState(initial?.enableSystemPromptCache ?? true)

  const handleSave = (): void => {
    if (!id.trim()) return
    const model: AIModelConfig = {
      id: id.trim(),
      name: name.trim() || id.trim(),
      enabled: initial?.enabled ?? true,
    }
    model.category = category
    if (typeOverride && typeOverride !== 'none') model.type = typeOverride
    if (contextLength.trim()) { const v = parseInt(contextLength); if (!isNaN(v)) model.contextLength = v }
    if (maxOutputTokens.trim()) { const v = parseInt(maxOutputTokens); if (!isNaN(v)) model.maxOutputTokens = v }
    if (inputPrice.trim()) { const v = parseFloat(inputPrice); if (!isNaN(v)) model.inputPrice = v }
    if (outputPrice.trim()) { const v = parseFloat(outputPrice); if (!isNaN(v)) model.outputPrice = v }
    if (cacheCreationPrice.trim()) { const v = parseFloat(cacheCreationPrice); if (!isNaN(v)) model.cacheCreationPrice = v }
    if (cacheHitPrice.trim()) { const v = parseFloat(cacheHitPrice); if (!isNaN(v)) model.cacheHitPrice = v }
    if (supportsVision) model.supportsVision = true
    if (!supportsFunctionCall) model.supportsFunctionCall = false
    if (icon.trim()) model.icon = icon.trim()
    if (responseSummary && responseSummary !== 'none') model.responseSummary = responseSummary
    model.enablePromptCache = enablePromptCache
    model.enableSystemPromptCache = enableSystemPromptCache
    // preserve thinking config if editing
    if (initial?.supportsThinking) model.supportsThinking = initial.supportsThinking
    if (initial?.thinkingConfig) model.thinkingConfig = initial.thinkingConfig
    onSave(model)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? t('provider.editModel') : t('provider.addModelTitle')}</DialogTitle>
          <DialogDescription>
            {isEdit ? t('provider.editModelDesc', { name: initial?.name }) : t('provider.addModelDesc')}
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
                onChange={(e) => setId(e.target.value)}
                disabled={isEdit}
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

          {/* Protocol type override */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium">{t('provider.modelTypeOverride')}</label>
            <p className="text-[11px] text-muted-foreground">{t('provider.modelTypeOverrideHint', { type: providerType })}</p>
            <Select value={typeOverride} onValueChange={(v) => setTypeOverride(v as ProviderType | 'none')}>
              <SelectTrigger className="text-xs">
                <SelectValue placeholder={t('provider.modelTypeOverridePlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none" className="text-xs">{t('provider.modelTypeOverridePlaceholder')}</SelectItem>
                <SelectItem value="openai-chat" className="text-xs">{t('provider.openaiChatCompat')}</SelectItem>
                <SelectItem value="openai-responses" className="text-xs">{t('provider.openaiResponses')}</SelectItem>
                <SelectItem value="anthropic" className="text-xs">Anthropic</SelectItem>
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
                <SelectItem value="chat" className="text-xs">{t('provider.modelCategoryChat')}</SelectItem>
                <SelectItem value="speech" className="text-xs">{t('provider.modelCategorySpeech')}</SelectItem>
                <SelectItem value="embedding" className="text-xs">{t('provider.modelCategoryEmbedding')}</SelectItem>
                <SelectItem value="image" className="text-xs">{t('provider.modelCategoryImage')}</SelectItem>
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

          {/* Pricing */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium">{t('provider.pricing')} <span className="text-muted-foreground font-normal">({t('provider.pricingUnit')})</span></label>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <p className="text-[11px] text-muted-foreground">{t('provider.inputPrice')}</p>
                <Input type="number" step="0.01" placeholder="0.00" value={inputPrice} onChange={(e) => setInputPrice(e.target.value)} className="text-xs" />
              </div>
              <div className="space-y-1">
                <p className="text-[11px] text-muted-foreground">{t('provider.outputPrice')}</p>
                <Input type="number" step="0.01" placeholder="0.00" value={outputPrice} onChange={(e) => setOutputPrice(e.target.value)} className="text-xs" />
              </div>
              <div className="space-y-1">
                <p className="text-[11px] text-muted-foreground">{t('provider.cacheCreationPrice')}</p>
                <Input type="number" step="0.01" placeholder="0.00" value={cacheCreationPrice} onChange={(e) => setCacheCreationPrice(e.target.value)} className="text-xs" />
              </div>
              <div className="space-y-1">
                <p className="text-[11px] text-muted-foreground">{t('provider.cacheHitPrice')}</p>
                <Input type="number" step="0.01" placeholder="0.00" value={cacheHitPrice} onChange={(e) => setCacheHitPrice(e.target.value)} className="text-xs" />
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
                  icon === '' ? 'border-primary bg-primary/10' : 'border-border hover:border-muted-foreground/50 hover:bg-muted/40'
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
                    icon === key ? 'border-primary bg-primary/10' : 'border-border hover:border-muted-foreground/50 hover:bg-muted/40'
                  }`}
                  title={key}
                >
                  <ModelIcon icon={key} size={16} />
                </button>
              ))}
            </div>
            {icon && <p className="text-[11px] text-muted-foreground">{t('provider.modelIconSelected', { icon })}</p>}
          </div>

          {/* Responses config */}
          <div className="space-y-2">
            <label className="text-xs font-medium">{t('provider.responsesConfig')}</label>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{t('provider.responsesSummary')}</span>
                <Select value={responseSummary} onValueChange={(v) => setResponseSummary(v as 'auto' | 'concise' | 'detailed' | 'none')}>
                  <SelectTrigger className="h-7 w-36 text-[11px]">
                    <SelectValue placeholder={t('provider.responsesSummaryAuto')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none" className="text-[11px]">{t('provider.responsesSummaryNone')}</SelectItem>
                    <SelectItem value="auto" className="text-[11px]">{t('provider.responsesSummaryAuto')}</SelectItem>
                    <SelectItem value="concise" className="text-[11px]">{t('provider.responsesSummaryConcise')}</SelectItem>
                    <SelectItem value="detailed" className="text-[11px]">{t('provider.responsesSummaryDetailed')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{t('provider.promptCache')}</span>
                <Switch checked={enablePromptCache} onCheckedChange={setEnablePromptCache} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{t('provider.systemPromptCache')}</span>
                <Switch checked={enableSystemPromptCache} onCheckedChange={setEnableSystemPromptCache} />
              </div>
            </div>
          </div>

          {/* Capabilities */}
          <div className="space-y-2">
            <label className="text-xs font-medium">{t('provider.capabilities')}</label>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{t('provider.supportsVision')}</span>
                <Switch checked={supportsVision} onCheckedChange={setSupportsVision} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{t('provider.supportsFunctionCall')}</span>
                <Switch checked={supportsFunctionCall} onCheckedChange={setSupportsFunctionCall} />
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>{t('action.cancel', { ns: 'common' })}</Button>
            <Button size="sm" disabled={!id.trim()} onClick={handleSave}>{t('action.save', { ns: 'common' })}</Button>
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
  const quotaByKey = useQuotaStore((s) => s.quotaByKey)
  const clearQuota = useQuotaStore((s) => s.clearQuota)

  const authMode = provider.authMode ?? 'apiKey'
  const isApiKeyAuth = authMode === 'apiKey'
  const isOAuthAuth = authMode === 'oauth'
  const isChannelAuth = authMode === 'channel'
  const isCodexProvider = provider.builtinId === 'codex-oauth'

  const [showKey, setShowKey] = useState(false)
  const [showChannelToken, setShowChannelToken] = useState(false)
  const [oauthConnecting, setOauthConnecting] = useState(false)
  const [oauthRefreshing, setOauthRefreshing] = useState(false)
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
  const [testModelId, setTestModelId] = useState(provider.models.find((m) => m.enabled)?.id ?? provider.models[0]?.id ?? '')
  const builtinPreset = useMemo(
    () => (provider.builtinId ? builtinProviderPresets.find((p) => p.builtinId === provider.builtinId) : undefined),
    [provider.builtinId]
  )
  const oauthAbortRef = useRef<AbortController | null>(null)
  const codexQuota = useMemo(() => {
    if (!isCodexProvider) return null
    return (
      quotaByKey[provider.id] ||
      (provider.builtinId ? quotaByKey[provider.builtinId] : undefined) ||
      quotaByKey['codex'] ||
      null
    )
  }, [isCodexProvider, provider.id, provider.builtinId, quotaByKey])
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
  const formatResetAt = (value?: string): string | null => {
    if (!value) return null
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return value
    return parsed.toLocaleString()
  }
  const formatQuotaWindow = (window?: CodexQuotaWindow): string => {
    if (!window) return '-'
    const parts: string[] = []
    const percent = formatPercent(window.usedPercent)
    if (percent) parts.push(percent)
    const windowMinutes = formatDurationMinutes(window.windowMinutes)
    if (windowMinutes) {
      parts.push(t('provider.codexQuotaWindow', { time: windowMinutes }))
    }
    if (window.resetAfterSeconds !== undefined && Number.isFinite(window.resetAfterSeconds)) {
      const minutes = Math.max(1, Math.ceil(window.resetAfterSeconds / 60))
      const remaining = formatDurationMinutes(minutes)
      if (remaining) {
        parts.push(t('provider.codexQuotaResetIn', { time: remaining }))
      }
    } else {
      const resetAt = formatResetAt(window.resetAt)
      if (resetAt) {
        parts.push(t('provider.codexQuotaResetAt', { time: resetAt }))
      }
    }
    return parts.length > 0 ? parts.join(' · ') : '-'
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
    const nextType = provider.channel?.channelType ?? provider.channelConfig?.defaultChannelType ?? 'sms'
    setChannelType(nextType)
    setChannelMobile('')
    setChannelEmail('')
    setChannelCode('')
  }, [provider.id])

  const oauthConfig = provider.oauthConfig ?? { authorizeUrl: '', tokenUrl: '', clientId: '' }
  const oauthClientIdLocked = oauthConfig.clientIdLocked === true
  const hideOAuthSettings = provider.ui?.hideOAuthSettings === true
  const oauthConfigReady = !!(oauthConfig.authorizeUrl && oauthConfig.tokenUrl && oauthConfig.clientId)
  const channelRequiresAppToken = provider.channelConfig?.requiresAppToken !== false
  const channelAppIdLocked = provider.channelConfig?.appIdLocked === true
  const channelAppIdValue = channelAppIdLocked
    ? provider.channelConfig?.defaultAppId || provider.channel?.appId || ''
    : provider.channel?.appId ?? ''
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

  const filteredModels = useMemo(() => {
    if (!modelSearch) return provider.models
    const q = modelSearch.toLowerCase()
    return provider.models.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
  }, [provider.models, modelSearch])

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

  const isAbortError = (err: unknown): boolean =>
    err instanceof Error && err.name === 'AbortError'

  const handleOAuthConnect = async (): Promise<void> => {
    if (!oauthConfigReady && !hideOAuthSettings) {
      toast.error(t('provider.oauthConfigMissing'))
      return
    }
    if (oauthConnecting) return
    const controller = new AbortController()
    oauthAbortRef.current?.abort()
    oauthAbortRef.current = controller
    setOauthConnecting(true)
    try {
      await startProviderOAuth(provider.id, controller.signal)
      toast.success(t('provider.oauthConnected'))
    } catch (err) {
      if (!isAbortError(err)) {
        toast.error(t('provider.oauthConnectFailed'), {
          description: err instanceof Error ? err.message : String(err),
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
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setOauthRefreshing(false)
    }
  }

  const handleOAuthDisconnect = (): void => {
    disconnectProviderOAuth(provider.id)
    if (isCodexProvider) {
      clearQuota(provider.id)
      if (provider.builtinId) clearQuota(provider.builtinId)
      clearQuota('codex')
    }
    toast.success(t('provider.oauthDisconnected'))
  }

  const handleChannelSendCode = async (): Promise<void> => {
    setChannelSending(true)
    try {
      await sendProviderChannelCode({
        providerId: provider.id,
        channelType,
        mobile: channelMobile.trim() || undefined,
        email: channelEmail.trim() || undefined,
      })
      toast.success(t('provider.channelCodeSent'))
    } catch (err) {
      toast.error(t('provider.channelSendFailed'), {
        description: err instanceof Error ? err.message : String(err),
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
        email: channelEmail.trim() || undefined,
      })
      setChannelCode('')
      toast.success(t('provider.channelVerified'))
    } catch (err) {
      toast.error(t('provider.channelVerifyFailed'), {
        description: err instanceof Error ? err.message : String(err),
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
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setChannelRefreshing(false)
    }
  }

  const handleChannelDisconnect = (): void => {
    clearProviderChannelAuth(provider.id)
    toast.success(t('provider.channelDisconnected'))
  }

  const handleTestConnection = async (): Promise<void> => {
    setTesting(true)
    try {
      const activeProvider = await ensureAuthForRequest()
      if (!activeProvider) return
      const isAnthropic = activeProvider.type === 'anthropic'
      const baseUrl = (activeProvider.baseUrl || (isAnthropic ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')).trim().replace(/\/+$/, '')
      const url = isAnthropic ? `${baseUrl}/v1/messages` : `${baseUrl}/chat/completions`
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (isAnthropic) {
        headers['x-api-key'] = activeProvider.apiKey
        headers['anthropic-version'] = '2023-06-01'
      } else {
        if (activeProvider.apiKey) headers['Authorization'] = `Bearer ${activeProvider.apiKey}`
      }
      const model = testModelId || activeProvider.models[0]?.id || 'gpt-4o'
      const body = JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] })
      const result = await window.electron.ipcRenderer.invoke('api:request', { url, method: 'POST', headers, body, useSystemProxy: activeProvider.useSystemProxy })
      if (result?.error) {
        toast.error(t('provider.connectionFailed'), { description: result.error })
      } else {
        const status = result?.statusCode ?? 0
        if (status >= 200 && status < 300) toast.success(t('provider.connectionSuccess'))
        else if (status === 401 || status === 403) toast.error(t('provider.invalidApiKey'), { description: `HTTP ${status}` })
        else toast.warning(t('provider.abnormalStatus', { status }), { description: result?.body?.slice(0, 200) })
      }
    } catch (err) {
      toast.error(t('provider.connectionFailed'), { description: err instanceof Error ? err.message : String(err) })
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
        activeProvider.useSystemProxy
      )
      if (models.length === 0) { toast.info(t('provider.noModelsFound')); return }
      const existingMap = new Map(provider.models.map((m) => [m.id, m]))
      // Build a map of built-in preset models for this provider (highest priority)
      const presetMap = new Map(builtinPreset?.defaultModels.map((m) => [m.id, m]) ?? [])
      const merged = models.map((m) => {
        const presetModel = presetMap.get(m.id)
        const existing = existingMap.get(m.id)
        if (presetModel) {
          // Built-in model: preset config takes priority, preserve user's enabled state
          return { ...m, ...presetModel, enabled: existing?.enabled ?? presetModel.enabled }
        }
        if (existing) {
          // User-customized model: preserve existing config, only fill missing fields from fetched
          return { ...m, ...existing }
        }
        return m
      })
      setProviderModels(provider.id, merged)
      toast.success(t('provider.fetchedModels', { count: models.length }))
    } catch (err) {
      toast.error(t('provider.fetchModelsFailed'), { description: err instanceof Error ? err.message : String(err) })
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
              {provider.type === 'anthropic' ? 'Anthropic Messages API'
                : provider.type === 'openai-responses' ? 'OpenAI Responses API'
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
              onClick={async () => {
                const ok = await confirm({
                  title: t('provider.deleteConfirm', { name: provider.name }),
                  variant: 'destructive',
                })
                if (!ok) return
                removeProvider(provider.id)
              }}
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
      <div className="flex flex-1 min-h-0 flex-col overflow-y-auto overflow-x-hidden px-5 py-4">
        {isApiKeyAuth && (
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">{t('provider.apiKey')}</label>
              {canOpenApiKeyUrl && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-[11px] text-muted-foreground"
                  onClick={() => void window.electron.ipcRenderer.invoke('shell:openExternal', apiKeyUrl)}
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
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">{t('provider.oauthLogin')}</label>
              <span className={`text-xs ${provider.oauth?.accessToken ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                {provider.oauth?.accessToken ? t('provider.oauthConnected') : t('provider.oauthNotConnected')}
              </span>
            </div>
            {provider.oauth?.accountId && (
              <p className="text-[11px] text-muted-foreground">
                {t('provider.oauthAccount', { account: provider.oauth.accountId })}
              </p>
            )}
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
                    {oauthConnecting ? t('provider.oauthConnecting') : t('provider.oauthConnect')}
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
                    {oauthRefreshing ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                    {oauthRefreshing ? t('provider.oauthRefreshing') : t('provider.oauthRefresh')}
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
              <p className="text-[11px] text-muted-foreground">{t('provider.oauthConfigMissing')}</p>
            )}
          </section>
        )}

        {isOAuthAuth && isCodexProvider && (
          <section className="space-y-2">
            <label className="text-sm font-medium">{t('provider.codexQuotaTitle')}</label>
            {codexQuota ? (
              <div className="rounded-md border bg-muted/30 p-2 text-[11px] space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('provider.codexQuotaPlan')}</span>
                  <span className="font-medium">{codexQuota.planType || '-'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('provider.codexQuotaPrimary')}</span>
                  <span className="font-mono">{formatQuotaWindow(codexQuota.primary)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('provider.codexQuotaSecondary')}</span>
                  <span className="font-mono">{formatQuotaWindow(codexQuota.secondary)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('provider.codexQuotaCredits')}</span>
                  <span className="font-medium">{formatCredits(codexQuota)}</span>
                </div>
                {codexQuota.primaryOverSecondaryLimitPercent !== undefined && (
                  <div className="text-muted-foreground">
                    {t('provider.codexQuotaLimitOver', {
                      percent: formatPercent(codexQuota.primaryOverSecondaryLimitPercent) ?? '-',
                    })}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">{t('provider.codexQuotaUnavailable')}</p>
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
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">{t('provider.oauthRedirectPath')}</label>
                  <Input
                    placeholder="/auth/callback"
                    value={oauthConfig.redirectPath ?? ''}
                    onChange={(e) => updateOAuthConfig({ redirectPath: e.target.value || undefined })}
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
                      updateOAuthConfig({ redirectPort: Number.isFinite(nextPort) ? nextPort : undefined })
                    }}
                    className="text-xs"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{t('provider.oauthUsePkce')}</span>
                <Switch
                  checked={oauthConfig.usePkce !== false}
                  onCheckedChange={(checked) => updateOAuthConfig({ usePkce: checked })}
                />
              </div>
            </div>
          </section>
        )}

        {isChannelAuth && (
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">{t('provider.channelLogin')}</label>
              <span className={`text-xs ${provider.channel?.accessToken ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                {provider.channel?.accessToken ? t('provider.channelConnected') : t('provider.channelNotConnected')}
              </span>
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
                  <p className="text-[11px] text-muted-foreground">{t('provider.channelAppIdLocked')}</p>
                )}
              </div>
              {channelRequiresAppToken ? (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">{t('provider.channelAppToken')}</label>
                  <div className="relative">
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
                      {showChannelToken ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
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
                <Select value={channelType} onValueChange={(v) => handleChannelTypeChange(v as 'sms' | 'email')}>
                  <SelectTrigger className="text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sms" className="text-xs">{t('provider.channelSms')}</SelectItem>
                    <SelectItem value="email" className="text-xs">{t('provider.channelEmail')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">
                  {channelType === 'sms' ? t('provider.channelMobile') : t('provider.channelEmailAddress')}
                </label>
                <Input
                  placeholder={channelType === 'sms' ? t('provider.channelMobilePlaceholder') : t('provider.channelEmailPlaceholder')}
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
                    {channelRefreshing ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                    {channelRefreshing ? t('provider.channelRefreshing') : t('provider.channelRefreshUser')}
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
            placeholder={
              builtinPreset?.defaultBaseUrl || 'https://api.example.com'
            }
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
            <Select
              value={testModelId}
              onValueChange={(v) => setTestModelId(v)}
            >
              <SelectTrigger className="flex-1 text-xs">
                <SelectValue placeholder={provider.models[0]?.id || t('provider.noAvailableModels')} />
              </SelectTrigger>
              <SelectContent>
                {(provider.models.some((m) => m.enabled) ? provider.models.filter((m) => m.enabled) : provider.models).map((m) => (
                  <SelectItem key={m.id} value={m.id} className="text-xs">{m.name}</SelectItem>
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
                <SelectItem value="openai-chat" className="text-xs">{t('provider.openaiChatCompat')}</SelectItem>
                <SelectItem value="openai-responses" className="text-xs">{t('provider.openaiResponses')}</SelectItem>
                <SelectItem value="anthropic" className="text-xs">Anthropic</SelectItem>
              </SelectContent>
            </Select>
          </section>
        )}

        <Separator className="my-5" />

        {/* Models */}
        <section className="flex min-h-0 flex-1 flex-col space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium">{t('provider.modelList')}</label>
              <p className="text-[11px] text-muted-foreground">
                {t('provider.modelCount', { total: provider.models.length, enabled: provider.models.filter((m) => m.enabled).length })}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              {provider.models.length > 0 && (
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground" />
                  <Input
                    placeholder={t('provider.searchModels')}
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                    className="h-7 w-32 pl-7 text-[11px]"
                  />
                </div>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-[11px]"
                disabled={fetchingModels}
                onClick={handleFetchModels}
              >
                {fetchingModels ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                {t('provider.fetchModels')}
              </Button>
              <Button variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => setAddModelOpen(true)}>
                <Plus className="size-3.5" />
              </Button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col rounded-lg border overflow-hidden">
            {filteredModels.length === 0 ? (
              <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
                {provider.models.length === 0 ? t('provider.noModels') : t('provider.noMatchResults')}
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto divide-y">
                {filteredModels.map((model) => (
                  <div
                    key={model.id}
                    className="flex items-center gap-3 px-3 py-2 hover:bg-muted/30 transition-colors group"
                  >
                    <ModelIcon icon={model.icon} modelId={model.id} providerBuiltinId={provider.builtinId} size={16} className="shrink-0 opacity-40" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-xs font-medium truncate">{model.name}</p>
                        <span className="text-[10px] text-muted-foreground/50 truncate">{model.id}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground/40">
                        {model.contextLength && (
                          <span>{Math.round(model.contextLength / 1024)}K context</span>
                        )}
                        {(model.inputPrice != null || model.outputPrice != null) && (
                          <span>
                            ${model.inputPrice ?? '?'} → ${model.outputPrice ?? '?'}
                          </span>
                        )}
                        {(model.cacheCreationPrice != null || model.cacheHitPrice != null) && (
                          <span className="text-emerald-500/60">
                            cache: {model.cacheCreationPrice != null ? `写 $${model.cacheCreationPrice}` : ''}{model.cacheCreationPrice != null && model.cacheHitPrice != null ? ' / ' : ''}{model.cacheHitPrice != null ? `读 $${model.cacheHitPrice}` : ''}
                          </span>
                        )}
                      </div>
                    </div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="size-5 flex items-center justify-center rounded transition-colors text-muted-foreground/20 hover:text-muted-foreground/70 hover:bg-muted/40 opacity-0 group-hover:opacity-100"
                          onClick={() => setEditingModel(model)}
                        >
                          <Pencil className="size-3" />
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
                          className={`size-5 flex items-center justify-center rounded transition-colors ${
                            model.supportsThinking
                              ? 'text-violet-500 hover:bg-violet-500/10'
                              : 'text-muted-foreground/20 hover:text-muted-foreground/50 hover:bg-muted/40'
                          } opacity-0 group-hover:opacity-100`}
                          onClick={() => setEditingThinkingModel(model)}
                        >
                          <Brain className="size-3" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-[11px]">
                        {model.supportsThinking ? t('provider.editThinkConfig') : t('provider.configThinkSupport')}
                      </TooltipContent>
                    </Tooltip>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
                      onClick={() => removeModel(provider.id, model.id)}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                    <Switch
                      checked={model.enabled}
                      onCheckedChange={() => toggleModelEnabled(provider.id, model.id)}
                    />
                  </div>
                ))}
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
        onSave={(model) => addModel(provider.id, model)}
      />

      {/* Edit model dialog */}
      {editingModel && (
        <ModelFormDialog
          open={!!editingModel}
          onOpenChange={(v) => { if (!v) setEditingModel(null) }}
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
          onOpenChange={(v) => { if (!v) setEditingThinkingModel(null) }}
          onSave={(supportsThinking, thinkingConfig) => {
            updateModel(provider.id, editingThinkingModel.id, {
              supportsThinking,
              thinkingConfig: supportsThinking ? thinkingConfig : undefined,
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
  onSave,
}: {
  model: AIModelConfig
  open: boolean
  onOpenChange: (v: boolean) => void
  onSave: (supportsThinking: boolean, thinkingConfig?: ThinkingConfig) => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [enabled, setEnabled] = useState(model.supportsThinking ?? false)
  const [bodyParamsJson, setBodyParamsJson] = useState(
    model.thinkingConfig?.bodyParams ? JSON.stringify(model.thinkingConfig.bodyParams, null, 2) : '{\n  \n}'
  )
  const [forceTemp, setForceTemp] = useState(
    model.thinkingConfig?.forceTemperature?.toString() ?? ''
  )
  const [disabledBodyParamsJson, setDisabledBodyParamsJson] = useState(
    model.thinkingConfig?.disabledBodyParams ? JSON.stringify(model.thinkingConfig.disabledBodyParams, null, 2) : ''
  )
  const [jsonError, setJsonError] = useState('')

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
          if (typeof disabledParsed === 'object' && disabledParsed !== null && !Array.isArray(disabledParsed)) {
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
                <p className="text-[11px] text-muted-foreground">{t('provider.thinkBodyParamsHint')}</p>
                <textarea
                  value={bodyParamsJson}
                  onChange={(e) => { setBodyParamsJson(e.target.value); setJsonError('') }}
                  className="w-full h-24 rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('provider.thinkDisabledBodyParams')}</label>
                <p className="text-[11px] text-muted-foreground">{t('provider.thinkDisabledBodyParamsHint')}</p>
                <textarea
                  value={disabledBodyParamsJson}
                  onChange={(e) => { setDisabledBodyParamsJson(e.target.value); setJsonError('') }}
                  className="w-full h-24 rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                  spellCheck={false}
                  placeholder={t('provider.leaveEmpty')}
                />
                {jsonError && <p className="text-[11px] text-destructive">{jsonError}</p>}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('provider.forceTemperature')}</label>
                <p className="text-[11px] text-muted-foreground">{t('provider.forceTemperatureHint')}</p>
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
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>{t('action.cancel', { ns: 'common' })}</Button>
            <Button size="sm" onClick={handleSave}>{t('action.save', { ns: 'common' })}</Button>
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

  const [selectedId, setSelectedId] = useState<string | null>(
    () => providers.find((p) => p.enabled)?.id ?? providers[0]?.id ?? null
  )
  const [searchQuery, setSearchQuery] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)

  const selectedProvider = providers.find((p) => p.id === selectedId) ?? null

  const enabledProviders = useMemo(
    () => providers.filter((p) => p.enabled && (!searchQuery || p.name.toLowerCase().includes(searchQuery.toLowerCase()))),
    [providers, searchQuery]
  )
  const disabledProviders = useMemo(
    () => providers.filter((p) => !p.enabled && (!searchQuery || p.name.toLowerCase().includes(searchQuery.toLowerCase()))),
    [providers, searchQuery]
  )

  return (
    <div className="flex flex-col h-full">
      <div className="mb-3 shrink-0">
        <h2 className="text-lg font-semibold">{t('provider.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('provider.subtitle')}</p>
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left: Provider list */}
        <div className="w-52 shrink-0 border-r flex flex-col">
          {/* Search + Add */}
          <div className="flex items-center gap-1 p-2 border-b">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/50" />
              <Input
                placeholder={t('provider.searchProviders')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-7 pl-7 text-[11px] bg-transparent border-0 shadow-none focus-visible:ring-0"
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => setDialogOpen(true)}
              title={t('provider.addCustomProvider')}
            >
              <Plus className="size-4" />
            </Button>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto py-1">
            {enabledProviders.length > 0 && (
              <div className="px-2 pt-1.5 pb-1">
                <p className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider px-1">{t('provider.enabled')}</p>
                {enabledProviders.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setSelectedId(p.id)}
                    className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 mt-0.5 text-left transition-colors ${
                      selectedId === p.id
                        ? 'bg-accent text-accent-foreground'
                        : 'text-foreground/80 hover:bg-muted/60'
                    }`}
                  >
                    <ProviderIcon builtinId={p.builtinId} size={16} />
                    <span className="flex-1 truncate text-xs">{p.name}</span>
                    <span className="size-1.5 rounded-full bg-emerald-500 shrink-0" />
                  </button>
                ))}
              </div>
            )}

            {disabledProviders.length > 0 && (
              <div className="px-2 pt-2 pb-1">
                <p className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider px-1">{t('provider.disabled')}</p>
                {disabledProviders.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setSelectedId(p.id)}
                    className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 mt-0.5 text-left transition-colors ${
                      selectedId === p.id
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                    }`}
                  >
                    <ProviderIcon builtinId={p.builtinId} size={16} className="opacity-50" />
                    <span className="flex-1 truncate text-xs">{p.name}</span>
                  </button>
                ))}
              </div>
            )}
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
