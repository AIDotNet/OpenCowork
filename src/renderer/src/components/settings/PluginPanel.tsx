import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Search,
  Eye,
  EyeOff,
  Play,
  Square,
  Puzzle,
  ChevronDown,
  Check,
  Shield,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { Separator } from '@renderer/components/ui/separator'
import { Badge } from '@renderer/components/ui/badge'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@renderer/components/ui/accordion'
import { useChannelStore } from '@renderer/stores/channel-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useProviderStore } from '@renderer/stores/provider-store'
import { ProviderIcon, ModelIcon } from '@renderer/components/settings/provider-icons'
import { cn } from '@renderer/lib/utils'
import type { PluginInstance, PluginFeatures, PluginPermissions } from '@renderer/lib/channel/types'
import { DEFAULT_PLUGIN_PERMISSIONS } from '@renderer/lib/channel/types'
import { PLUGIN_TOOL_DEFINITIONS } from '@renderer/lib/channel/plugin-tools'
import {
  FeishuIcon,
  DingTalkIcon,
  TelegramIcon,
  DiscordIcon,
  WhatsAppIcon,
  WeComIcon,
  QQIcon,
  WechatIcon
} from '@renderer/components/icons/plugin-icons'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'

// ─── Channel Icon Helper ───

const CHANNEL_ICON_COMPONENTS: Record<string, React.FC<React.SVGProps<SVGSVGElement>>> = {
  feishu: FeishuIcon,
  dingtalk: DingTalkIcon,
  telegram: TelegramIcon,
  discord: DiscordIcon,
  whatsapp: WhatsAppIcon,
  wecom: WeComIcon,
  qq: QQIcon,
  wechat: WechatIcon
}

export const ChannelSettingsPanel = ChannelPanel

function ChannelIcon({
  icon,
  className = ''
}: {
  icon: string
  className?: string
}): React.JSX.Element {
  const IconComponent = CHANNEL_ICON_COMPONENTS[icon]
  if (IconComponent) {
    return <IconComponent className={`shrink-0 ${className}`} />
  }
  return <Puzzle className={`shrink-0 ${className}`} />
}

// ─── Channel Config Panel (right side) ───

function ChannelConfigPanel({
  plugin,
  projectId
}: {
  plugin: PluginInstance
  projectId?: string
}): React.JSX.Element {
  return <ChannelConfigPanelContent key={plugin.id} plugin={plugin} projectId={projectId} />
}

function ChannelConfigPanelContent({
  plugin,
  projectId
}: {
  plugin: PluginInstance
  projectId?: string
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const updateChannel = useChannelStore((s) => s.updateChannel)
  const removeChannel = useChannelStore((s) => s.removeChannel)
  const startChannel = useChannelStore((s) => s.startChannel)
  const stopChannel = useChannelStore((s) => s.stopChannel)
  const channelStatuses = useChannelStore((s) => s.channelStatuses)
  const toggleChannelEnabled = useChannelStore((s) => s.toggleChannelEnabled)
  const getDescriptor = useChannelStore((s) => s.getDescriptor)
  const refreshStatus = useChannelStore((s) => s.refreshChannelStatus)

  const descriptor = getDescriptor(plugin.type)
  const status = channelStatuses[plugin.id] ?? 'stopped'

  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({})

  // Local state for debounced fields
  const providers = useProviderStore((s) => s.providers)
  const projects = useChatStore((s) => s.projects)
  const activeProviderId = useProviderStore((s) => s.activeProviderId)
  const activeModelId = useProviderStore((s) => s.activeModelId)
  const enabledProviders = useMemo(() => providers.filter((p) => p.enabled), [providers])
  const [modelPopoverOpen, setModelPopoverOpen] = useState(false)

  // Get global default model info
  const globalDefaultModel = useMemo(() => {
    const provider = providers.find((p) => p.id === activeProviderId)
    const model = provider?.models.find((m) => m.id === activeModelId)
    return model ? { provider, model } : null
  }, [providers, activeProviderId, activeModelId])

  const [localName, setLocalName] = useState(plugin.name)
  const [localConfig, setLocalConfig] = useState(plugin.config)
  const [localProviderId, setLocalProviderId] = useState(plugin.providerId ?? null)
  const [localModel, setLocalModel] = useState(plugin.model ?? '')
  const [localFeatures, setLocalFeatures] = useState<PluginFeatures>(
    plugin.features ?? { autoReply: true, streamingReply: true, autoStart: true }
  )
  const [localTools, setLocalTools] = useState<Record<string, boolean>>(plugin.tools ?? {})
  const [localPerms, setLocalPerms] = useState<PluginPermissions>(
    plugin.permissions ?? DEFAULT_PLUGIN_PERMISSIONS
  )
  const [newReadPath, setNewReadPath] = useState('')
  const [weixinQrUrl, setWeixinQrUrl] = useState('')
  const [weixinSessionKey, setWeixinSessionKey] = useState('')
  const [weixinLoginPending, setWeixinLoginPending] = useState(false)
  const [weixinLoginMessage, setWeixinLoginMessage] = useState('')

  // Refresh status on mount
  useEffect(() => {
    refreshStatus(plugin.id)
  }, [plugin.id, refreshStatus])

  // Debounced save
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const debouncedSave = useCallback(
    (patch: Partial<PluginInstance>) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        updateChannel(plugin.id, patch)
      }, 500)
    },
    [plugin.id, updateChannel]
  )

  const toggleSecret = (key: string): void => {
    setShowSecrets((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const handleNameChange = (value: string): void => {
    setLocalName(value)
    debouncedSave({ name: value })
  }

  const handleConfigChange = (key: string, value: string): void => {
    const newConfig = { ...localConfig, [key]: value }
    setLocalConfig(newConfig)
    debouncedSave({ config: newConfig })
  }

  const handleModelChange = (value: string, providerId?: string): void => {
    const model = value === '__default__' ? null : value
    const pid = value === '__default__' ? null : (providerId ?? null)
    setLocalProviderId(pid)
    setLocalModel(value === '__default__' ? '' : value)
    debouncedSave({ model, providerId: pid })
  }

  const handleFeatureToggle = (key: keyof PluginFeatures, value: boolean): void => {
    const next = { ...localFeatures, [key]: value }
    setLocalFeatures(next)
    debouncedSave({ features: next })
  }

  const handlePermToggle = (key: keyof PluginPermissions, value: boolean): void => {
    const next = { ...localPerms, [key]: value }
    setLocalPerms(next)
    debouncedSave({ permissions: next })
  }

  const handleToolToggle = (toolName: string, value: boolean): void => {
    const next = { ...localTools, [toolName]: value }
    setLocalTools(next)
    debouncedSave({ tools: next })
  }

  const handleAddReadPath = (): void => {
    const trimmed = newReadPath.trim()
    if (!trimmed) return
    if (localPerms.readablePathPrefixes.includes(trimmed)) {
      setNewReadPath('')
      return
    }
    const next = {
      ...localPerms,
      readablePathPrefixes: [...localPerms.readablePathPrefixes, trimmed]
    }
    setLocalPerms(next)
    setNewReadPath('')
    debouncedSave({ permissions: next })
  }

  const handleRemoveReadPath = (path: string): void => {
    const next = {
      ...localPerms,
      readablePathPrefixes: localPerms.readablePathPrefixes.filter((p) => p !== path)
    }
    setLocalPerms(next)
    debouncedSave({ permissions: next })
  }

  const configFields = descriptor?.configSchema ?? []
  const toolDefinitions = useMemo(() => {
    return PLUGIN_TOOL_DEFINITIONS.reduce<Record<string, string>>((acc, tool) => {
      acc[tool.name] = tool.description
      return acc
    }, {})
  }, [])
  const toolsList = descriptor?.tools ?? []
  const isWeixinOfficial = plugin.type === 'weixin-official'
  const boundProject = plugin.projectId
    ? projects.find((project) => project.id === plugin.projectId)
    : undefined
  const isBoundToCurrentProject = !!projectId && plugin.projectId === projectId
  const ensureCurrentProjectBinding = useCallback(async (): Promise<void> => {
    if (!projectId || plugin.projectId === projectId) return
    await updateChannel(plugin.id, { projectId })
  }, [plugin.id, plugin.projectId, projectId, updateChannel])

  const handleWeixinBind = useCallback(async () => {
    const baseUrl = (localConfig.baseUrl || 'https://ilinkai.weixin.qq.com').trim()

    setWeixinLoginPending(true)
    setWeixinLoginMessage(t('channel.weixin.loginStarting', '正在生成二维码...'))
    setWeixinQrUrl('')
    setWeixinSessionKey('')

    try {
      const startResult = (await ipcClient.invoke(IPC.PLUGIN_WEIXIN_LOGIN_START, {
        pluginId: plugin.id,
        baseUrl,
        routeTag: (localConfig.routeTag || '').trim() || undefined,
        accountId: (localConfig.accountId || '').trim() || undefined,
        force: true
      })) as {
        qrDataUrl?: string
        qrUrl?: string
        message: string
        sessionKey: string
      }

      if ((!startResult?.qrDataUrl && !startResult?.qrUrl) || !startResult.sessionKey) {
        throw new Error(startResult?.message || '无法获取二维码')
      }

      setWeixinQrUrl(startResult.qrDataUrl || startResult.qrUrl || '')
      setWeixinSessionKey(startResult.sessionKey)
      setWeixinLoginMessage(
        startResult.message || t('channel.weixin.scanHint', '请使用微信扫码确认')
      )

      const waitResult = (await ipcClient.invoke(IPC.PLUGIN_WEIXIN_LOGIN_WAIT, {
        pluginId: plugin.id,
        baseUrl,
        routeTag: (localConfig.routeTag || '').trim() || undefined,
        sessionKey: startResult.sessionKey,
        accountId: (localConfig.accountId || '').trim() || undefined,
        timeoutMs: 480000
      })) as {
        connected: boolean
        message: string
        token?: string
        accountId?: string
        userId?: string
        baseUrl?: string
      }

      setWeixinLoginMessage(waitResult.message)

      if (!waitResult.connected || !waitResult.token) {
        throw new Error(waitResult.message || '微信绑定失败')
      }

      const nextConfig = {
        ...localConfig,
        baseUrl: waitResult.baseUrl || baseUrl,
        token: waitResult.token,
        accountId: waitResult.accountId || localConfig.accountId || '',
        userId: waitResult.userId || localConfig.userId || ''
      }
      setLocalConfig(nextConfig)
      await updateChannel(plugin.id, {
        config: nextConfig,
        enabled: true,
        ...(projectId && plugin.projectId !== projectId ? { projectId } : {})
      })
      toast.success(t('channel.weixin.loginSuccess', '微信绑定成功'))
      const err = await startChannel(plugin.id)
      if (err) {
        toast.error(t('channel.error', 'Error'), { description: err })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setWeixinLoginMessage(message)
      toast.error(t('channel.weixin.loginFailed', '微信绑定失败'), { description: message })
    } finally {
      setWeixinLoginPending(false)
    }
  }, [localConfig, plugin.id, plugin.projectId, projectId, startChannel, t, updateChannel])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b border-border/60 px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-border/60 bg-muted/30">
              <ChannelIcon icon={descriptor?.icon ?? ''} className="size-6" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="truncate text-xl font-semibold text-foreground">{localName}</h3>
                <Badge
                  variant={
                    status === 'running'
                      ? 'secondary'
                      : status === 'error'
                        ? 'destructive'
                        : 'outline'
                  }
                >
                  {status === 'running'
                    ? t('channel.running', 'Running')
                    : status === 'error'
                      ? t('channel.error', 'Error')
                      : t('channel.stopped', 'Stopped')}
                </Badge>
                <Badge variant={plugin.enabled ? 'outline' : 'secondary'}>
                  {plugin.enabled
                    ? t('channel.enabled', '已启用')
                    : t('channel.disabled', '已停用')}
                </Badge>
              </div>
              <p className="mt-1 truncate text-sm text-muted-foreground">
                {descriptor?.description ?? plugin.type}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {t('channel.autoSaveHint', '修改后自动保存')}
            </span>
            <Switch
              checked={plugin.enabled}
              onCheckedChange={async () => {
                if (!plugin.enabled) {
                  await ensureCurrentProjectBinding()
                }
                await toggleChannelEnabled(plugin.id)
              }}
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            {t('channel.platform', '平台')} · {descriptor?.displayName ?? plugin.type}
          </Badge>
          {projectId && (
            <Badge variant={isBoundToCurrentProject ? 'secondary' : 'outline'}>
              {isBoundToCurrentProject
                ? t('channel.boundCurrentProject', '已绑定当前项目')
                : (boundProject?.name ?? t('channel.unboundProject', '未绑定项目'))}
            </Badge>
          )}
          {(localModel || globalDefaultModel?.model?.name) && (
            <Badge variant="outline">
              {t('channel.replyModelShort', '模型')} ·{' '}
              {localModel || globalDefaultModel?.model?.name}
            </Badge>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {/* Bot Name */}
        <section className="grid gap-3 border-b border-border/60 pb-5 md:grid-cols-[220px_minmax(0,1fr)] md:items-start">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium">{t('channel.botName', 'Channel Name')}</label>
              <Badge variant="outline" className="px-1.5 text-[10px] font-mono">
                name
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('channel.botNameDesc', '用于在项目内识别当前聊天频道。')}
            </p>
          </div>
          <Input
            className="h-10 text-sm"
            value={localName}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder={descriptor?.displayName ?? 'Plugin'}
          />
        </section>

        {/* Config fields from schema */}
        <div className="space-y-4 border-b border-border/60 py-5">
          {configFields.map((field) => (
            <section
              key={field.key}
              className="grid gap-3 md:grid-cols-[220px_minmax(0,1fr)] md:items-start"
            >
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <label className="text-sm font-medium">
                    {t(field.label, field.key)}
                    {field.required && <span className="text-destructive ml-0.5">*</span>}
                  </label>
                  <Badge variant="outline" className="px-1.5 text-[10px] font-mono">
                    {field.key}
                  </Badge>
                </div>
                {field.placeholder && (
                  <p className="text-xs text-muted-foreground">{field.placeholder}</p>
                )}
              </div>
              <div className="relative">
                <Input
                  className="h-10 pr-10 text-sm"
                  type={field.type === 'secret' && !showSecrets[field.key] ? 'password' : 'text'}
                  placeholder={field.placeholder}
                  value={localConfig[field.key] ?? ''}
                  onChange={(e) => handleConfigChange(field.key, e.target.value)}
                />
                {field.type === 'secret' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute right-1 top-1 h-8 w-8 p-0"
                    onClick={() => toggleSecret(field.key)}
                  >
                    {showSecrets[field.key] ? (
                      <EyeOff className="size-3.5" />
                    ) : (
                      <Eye className="size-3.5" />
                    )}
                  </Button>
                )}
              </div>
            </section>
          ))}
        </div>

        <Separator className="mb-4" />

        {/* Model override */}
        <section className="space-y-2 mb-4">
          <label className="text-xs font-medium">{t('channel.model', 'Reply Model')}</label>
          <Popover open={modelPopoverOpen} onOpenChange={setModelPopoverOpen}>
            <PopoverTrigger asChild>
              <button className="w-full flex items-center gap-2 h-8 rounded-md border border-input bg-background px-3 text-xs hover:bg-muted/40 transition-colors text-left">
                {localModel ? (
                  <>
                    <ModelIcon modelId={localModel} size={12} className="shrink-0 opacity-70" />
                    <span className="flex-1 truncate">
                      {localModel
                        .split('/')
                        .pop()
                        ?.replace(/-\d{8}$/, '') ?? localModel}
                    </span>
                  </>
                ) : (
                  <span className="flex-1 text-muted-foreground">
                    {t('channel.modelDefault', 'Use global default')}
                  </span>
                )}
                <ChevronDown className="size-3 shrink-0 opacity-50" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-1 max-h-72 overflow-y-auto" align="start">
              {/* Default option */}
              <button
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted/60 transition-colors',
                  !localModel && 'bg-muted/40 font-medium'
                )}
                onClick={() => {
                  handleModelChange('__default__')
                  setModelPopoverOpen(false)
                }}
              >
                {!localModel ? (
                  <Check className="size-3 text-primary" />
                ) : (
                  <span className="size-3" />
                )}
                <div className="flex flex-col items-start flex-1 min-w-0">
                  <span className="text-muted-foreground">
                    {t('channel.modelDefault', 'Use global default')}
                  </span>
                  {globalDefaultModel && (
                    <span className="text-[10px] text-muted-foreground/50 truncate w-full">
                      {globalDefaultModel.model.name}
                    </span>
                  )}
                </div>
              </button>
              <Separator className="my-1" />
              {enabledProviders.map((provider) => {
                const models = provider.models.filter(
                  (m) => m.enabled && (!m.category || m.category === 'chat')
                )
                if (models.length === 0) return null
                return (
                  <div key={provider.id}>
                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/50 px-2 py-1 uppercase tracking-wider">
                      <ProviderIcon builtinId={provider.builtinId} size={12} />
                      {provider.name}
                    </div>
                    {models.map((m) => {
                      const isActive = localModel === m.id && localProviderId === provider.id
                      return (
                        <button
                          key={m.id}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted/60 transition-colors',
                            isActive && 'bg-muted/40 font-medium'
                          )}
                          onClick={() => {
                            handleModelChange(m.id, provider.id)
                            setModelPopoverOpen(false)
                          }}
                        >
                          {isActive ? (
                            <Check className="size-3 text-primary shrink-0" />
                          ) : (
                            <ModelIcon
                              icon={m.icon}
                              modelId={m.id}
                              providerBuiltinId={provider.builtinId}
                              size={12}
                              className="opacity-60 shrink-0"
                            />
                          )}
                          <span className="truncate">{m.name || m.id.replace(/-\d{8}$/, '')}</span>
                        </button>
                      )
                    })}
                  </div>
                )
              })}
            </PopoverContent>
          </Popover>
          <p className="text-[10px] text-muted-foreground">
            {t(
              'channel.modelHint',
              'Model used for auto-reply. Leave default to use the globally active model.'
            )}
          </p>
        </section>

        <section className="border-b border-border/60 py-5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">{t('channel.advanced', '高级设置')}</p>
              <p className="text-xs text-muted-foreground">
                {t('channel.advancedDesc', '按需展开回复策略、工具能力和权限边界。')}
              </p>
            </div>
            <Badge variant="outline">{t('channel.advancedHint', '可折叠')}</Badge>
          </div>
          <Accordion type="multiple" defaultValue={['features']} className="w-full">
            <AccordionItem value="features" className="border-border/60">
              <AccordionTrigger className="py-3 hover:no-underline">
                <div>
                  <div className="text-sm font-medium">{t('channel.features', 'Features')}</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('channel.featuresDesc', '自动回复、流式回复和自动启动策略。')}
                  </p>
                </div>
              </AccordionTrigger>
              <AccordionContent className="space-y-3">
                <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium">{t('channel.autoReply', 'Auto Reply')}</p>
                    <p className="text-xs text-muted-foreground">
                      {t(
                        'channel.autoReplyDesc',
                        'Automatically reply to incoming messages using the Agent'
                      )}
                    </p>
                  </div>
                  <Switch
                    checked={localFeatures.autoReply}
                    onCheckedChange={(v) => handleFeatureToggle('autoReply', v)}
                    className="scale-75"
                  />
                </div>
                <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium">
                      {t('channel.streamingReply', 'Streaming Reply')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t(
                        'channel.streamingReplyDesc',
                        'Stream responses in real-time via CardKit (Feishu only)'
                      )}
                    </p>
                  </div>
                  <Switch
                    checked={localFeatures.streamingReply}
                    onCheckedChange={(v) => handleFeatureToggle('streamingReply', v)}
                    className="scale-75"
                  />
                </div>
                <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium">{t('channel.autoStart', 'Auto Start')}</p>
                    <p className="text-xs text-muted-foreground">
                      {t(
                        'channel.autoStartDesc',
                        'Automatically start this plugin when the app launches'
                      )}
                    </p>
                  </div>
                  <Switch
                    checked={localFeatures.autoStart}
                    onCheckedChange={(v) => handleFeatureToggle('autoStart', v)}
                    className="scale-75"
                  />
                </div>
              </AccordionContent>
            </AccordionItem>

            {toolsList.length > 0 && (
              <AccordionItem value="tools" className="border-border/60">
                <AccordionTrigger className="py-3 hover:no-underline">
                  <div>
                    <div className="text-sm font-medium">{t('channel.tools', 'Tools')}</div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('channel.toolsPanelDesc', '控制频道可调用的专属工具集合。')}
                    </p>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="space-y-3">
                  {toolsList.map((toolName) => {
                    const enabled = localTools?.[toolName] !== false
                    const description = t(
                      `channel.toolsDesc.${toolName}`,
                      toolDefinitions[toolName] ?? ''
                    )
                    return (
                      <div
                        key={toolName}
                        className="flex items-center justify-between gap-3 rounded-xl border border-border/60 px-4 py-3"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{toolName}</p>
                          {description && (
                            <p className="text-xs text-muted-foreground">{description}</p>
                          )}
                        </div>
                        <Switch
                          checked={enabled}
                          onCheckedChange={(v) => handleToolToggle(toolName, v)}
                          className="scale-75"
                        />
                      </div>
                    )
                  })}
                </AccordionContent>
              </AccordionItem>
            )}

            <AccordionItem value="security" className="border-border/60">
              <AccordionTrigger className="py-3 hover:no-underline">
                <div className="flex items-start gap-2">
                  <Shield className="mt-0.5 size-4 text-muted-foreground" />
                  <div>
                    <div className="text-sm font-medium">
                      {t('channel.security', 'Security & Permissions')}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('channel.securityDesc', '限制频道读写范围、命令执行和子代理能力。')}
                    </p>
                  </div>
                </div>
              </AccordionTrigger>
              <AccordionContent className="space-y-3">
                <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium">
                      {t('channel.allowReadHome', 'Read Home Directory')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t(
                        'channel.allowReadHomeDesc',
                        'Allow reading files under your home directory (~)'
                      )}
                    </p>
                  </div>
                  <Switch
                    checked={localPerms.allowReadHome}
                    onCheckedChange={(v) => handlePermToggle('allowReadHome', v)}
                    className="scale-75"
                  />
                </div>

                {!localPerms.allowReadHome && (
                  <div className="space-y-2 rounded-xl border border-border/60 px-4 py-3">
                    <div>
                      <p className="text-sm font-medium">
                        {t('channel.readablePaths', 'Allowed Read Paths')}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t(
                          'channel.readablePathsDesc',
                          'Whitelist specific directories the plugin can read'
                        )}
                      </p>
                    </div>
                    {localPerms.readablePathPrefixes.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {localPerms.readablePathPrefixes.map((p) => (
                          <span
                            key={p}
                            className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[10px] font-mono"
                          >
                            {p}
                            <button
                              onClick={() => handleRemoveReadPath(p)}
                              className="text-muted-foreground hover:text-foreground"
                            >
                              <X className="size-2.5" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <Input
                        className="h-9 flex-1 font-mono text-xs"
                        placeholder="/home/user/docs"
                        value={newReadPath}
                        onChange={(e) => setNewReadPath(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleAddReadPath()
                        }}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-9 px-3"
                        onClick={handleAddReadPath}
                      >
                        {t('channel.addPath', 'Add')}
                      </Button>
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium">
                      {t('channel.allowShell', 'Shell Execution')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('channel.allowShellDesc', 'Allow executing terminal commands (high risk)')}
                    </p>
                  </div>
                  <Switch
                    checked={localPerms.allowShell}
                    onCheckedChange={(v) => handlePermToggle('allowShell', v)}
                    className="scale-75"
                  />
                </div>

                <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium">
                      {t('channel.allowWriteOutside', 'Write Outside Working Dir')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t(
                        'channel.allowWriteOutsideDesc',
                        'Allow writing files outside the plugin directory'
                      )}
                    </p>
                  </div>
                  <Switch
                    checked={localPerms.allowWriteOutside}
                    onCheckedChange={(v) => handlePermToggle('allowWriteOutside', v)}
                    className="scale-75"
                  />
                </div>

                <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium">
                      {t('channel.allowSubAgents', 'Sub-Agent Tools')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t(
                        'channel.allowSubAgentsDesc',
                        'Allow using Task and other sub-agent tools'
                      )}
                    </p>
                  </div>
                  <Switch
                    checked={localPerms.allowSubAgents}
                    onCheckedChange={(v) => handlePermToggle('allowSubAgents', v)}
                    className="scale-75"
                  />
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </section>

        {isWeixinOfficial && (
          <>
            <section className="space-y-2 mb-4">
              <label className="text-xs font-medium">
                {t('channel.weixin.binding', '微信绑定')}
              </label>
              <div className="rounded-md border p-3 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs">
                      {localConfig.token
                        ? t('channel.weixin.bound', '已绑定官方微信账号')
                        : t('channel.weixin.unbound', '未绑定官方微信账号')}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {t(
                        'channel.weixin.bindingDesc',
                        '通过扫码获取 token，并启用长轮询收发消息。'
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {weixinQrUrl && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => void handleWeixinBind()}
                        disabled={weixinLoginPending}
                      >
                        {t('channel.weixin.refreshQr', '刷新二维码')}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => void handleWeixinBind()}
                      disabled={weixinLoginPending}
                    >
                      {weixinLoginPending
                        ? t('channel.weixin.bindingInProgress', '绑定中...')
                        : localConfig.token
                          ? t('channel.weixin.rebind', '重新绑定')
                          : t('channel.weixin.bind', '绑定微信')}
                    </Button>
                  </div>
                </div>
                {weixinLoginMessage && (
                  <p className="text-[10px] text-muted-foreground">{weixinLoginMessage}</p>
                )}
                {weixinQrUrl && (
                  <div className="space-y-2">
                    <div className="rounded-md border bg-white p-3 flex justify-center">
                      <img
                        src={weixinQrUrl}
                        alt="Weixin QR"
                        className="max-h-[420px] w-auto object-contain"
                      />
                    </div>
                    {weixinSessionKey && (
                      <p className="text-[10px] text-muted-foreground font-mono break-all">
                        session: {weixinSessionKey}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </section>
            <Separator className="mb-4" />
          </>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border/60 px-6 py-4">
        <div className="text-xs text-muted-foreground">
          {t('channel.autoSaveFooter', '当前频道配置会自动保存，并在项目内立即生效。')}
        </div>
        <div className="flex items-center gap-2">
          {!plugin.builtin && (
            <Button
              variant="ghost"
              size="sm"
              className="h-9 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => {
                removeChannel(plugin.id)
                toast.success(t('channel.removed', 'Plugin removed'))
              }}
            >
              {t('channel.remove', 'Remove')}
            </Button>
          )}
          {status === 'running' ? (
            <Button
              variant="outline"
              size="sm"
              className="h-9 px-4 text-xs"
              onClick={async () => {
                await stopChannel(plugin.id)
                toast.success(t('channel.stopped', 'Stopped'))
              }}
            >
              <Square className="mr-1 size-3" />
              {t('channel.stop', 'Stop')}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-9 px-4 text-xs"
              onClick={async () => {
                await ensureCurrentProjectBinding()
                const err = await startChannel(plugin.id)
                if (err) {
                  toast.error(t('channel.error', 'Error'), { description: err })
                } else {
                  toast.success(t('channel.running', 'Running'))
                }
              }}
              disabled={!plugin.enabled}
            >
              <Play className="mr-1 size-3" />
              {t('channel.start', 'Start')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Category grouping for built-in plugins ───

const PLUGIN_CATEGORIES: { label: string; types: string[] }[] = [
  {
    label: 'China',
    types: ['feishu-bot', 'dingtalk-bot', 'wecom-bot', 'qq-bot', 'weixin-official']
  },
  { label: 'International', types: ['telegram-bot', 'discord-bot', 'whatsapp-bot'] }
]

// ─── Main Plugin Panel ───

interface ChannelPanelProps {
  projectId?: string
}

export function ChannelPanel({ projectId }: ChannelPanelProps = {}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const channels = useChannelStore((s) => s.channels)
  const selectedChannelId = useChannelStore((s) => s.selectedChannelId)
  const setSelectedChannel = useChannelStore((s) => s.setSelectedChannel)
  const loadProviders = useChannelStore((s) => s.loadProviders)
  const loadChannels = useChannelStore((s) => s.loadChannels)
  const channelStatuses = useChannelStore((s) => s.channelStatuses)
  const getDescriptor = useChannelStore((s) => s.getDescriptor)
  const toggleChannelEnabled = useChannelStore((s) => s.toggleChannelEnabled)
  const updateChannel = useChannelStore((s) => s.updateChannel)

  const [searchQuery, setSearchQuery] = useState('')

  const handleSelectChannel = useCallback(
    async (channel: PluginInstance): Promise<void> => {
      if (projectId && channel.projectId !== projectId) {
        await updateChannel(channel.id, { projectId })
      }
      setSelectedChannel(channel.id)
    },
    [projectId, setSelectedChannel, updateChannel]
  )

  const handleToggleChannelEnabled = useCallback(
    async (channel: PluginInstance): Promise<void> => {
      if (projectId && !channel.enabled && channel.projectId !== projectId) {
        await updateChannel(channel.id, { projectId })
      }
      await toggleChannelEnabled(channel.id)
    },
    [projectId, toggleChannelEnabled, updateChannel]
  )

  // Load providers and plugins on mount
  useEffect(() => {
    loadProviders()
    loadChannels()
  }, [loadProviders, loadChannels])

  const projectScopedChannels = useMemo(() => {
    if (!projectId) return channels
    return channels.filter((channel) => !channel.projectId || channel.projectId === projectId)
  }, [channels, projectId])

  const filteredChannels = useMemo(() => {
    if (!searchQuery.trim()) return projectScopedChannels
    const q = searchQuery.toLowerCase()
    return projectScopedChannels.filter(
      (p) => p.name.toLowerCase().includes(q) || p.type.toLowerCase().includes(q)
    )
  }, [projectScopedChannels, searchQuery])

  useEffect(() => {
    const hasSelectedVisibleChannel = filteredChannels.some(
      (channel) => channel.id === selectedChannelId
    )
    if (hasSelectedVisibleChannel) return
    if (!projectId) {
      setSelectedChannel(filteredChannels[0]?.id ?? null)
      return
    }
    const firstBoundChannel = filteredChannels.find((channel) => channel.projectId === projectId)
    setSelectedChannel(firstBoundChannel?.id ?? null)
  }, [filteredChannels, projectId, selectedChannelId, setSelectedChannel])

  const selectedChannel = filteredChannels.find((p) => p.id === selectedChannelId) ?? null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="grid min-h-0 flex-1 overflow-hidden lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col border-r border-border/60 bg-muted/10">
          <div className="border-b border-border/60 px-4 py-4">
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground/60">
              {t('channel.platforms', '平台')}
            </p>
            <div className="relative mt-3">
              <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/50" />
              <Input
                placeholder={t('channel.search', 'Search channels...')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-9 rounded-xl border-border/60 bg-background/60 pl-9 text-xs"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3">
            {PLUGIN_CATEGORIES.map((category) => {
              const categoryPlugins = filteredChannels.filter((p) =>
                category.types.includes(p.type)
              )
              if (categoryPlugins.length === 0) return null
              return (
                <section key={category.label} className="mb-4 last:mb-0">
                  <p className="mb-2 px-2 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground/50">
                    {category.label}
                  </p>
                  <div className="space-y-1.5">
                    {categoryPlugins.map((p) => {
                      const status = channelStatuses[p.id] ?? 'stopped'
                      const descriptor = getDescriptor(p.type)
                      const displayName = p.builtin ? (descriptor?.displayName ?? p.name) : p.name
                      const isSelected = selectedChannelId === p.id
                      const isBoundToProject = !!projectId && p.projectId === projectId
                      return (
                        <div
                          key={p.id}
                          className={cn(
                            'flex w-full cursor-pointer items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors',
                            isSelected
                              ? 'bg-accent text-accent-foreground'
                              : 'hover:bg-muted/60 text-foreground/85',
                            !p.enabled && !isSelected && 'text-muted-foreground'
                          )}
                          onClick={() => void handleSelectChannel(p)}
                        >
                          <div className={cn('shrink-0', !p.enabled && 'opacity-40')}>
                            <ChannelIcon icon={descriptor?.icon ?? ''} className="size-5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium">{displayName}</span>
                              <span
                                className={cn(
                                  'size-1.5 shrink-0 rounded-full',
                                  status === 'running'
                                    ? 'bg-emerald-500'
                                    : status === 'error'
                                      ? 'bg-destructive'
                                      : 'bg-muted-foreground/30'
                                )}
                              />
                            </div>
                            <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                              <span className="truncate">{descriptor?.description ?? p.type}</span>
                              {isBoundToProject && (
                                <Badge variant="outline">{t('channel.bound', '已绑定')}</Badge>
                              )}
                            </div>
                          </div>
                          <Switch
                            checked={p.enabled}
                            onCheckedChange={() => {
                              void handleToggleChannelEnabled(p)
                            }}
                            className="scale-75"
                            onClick={(e) => e.stopPropagation()}
                          />
                        </div>
                      )
                    })}
                  </div>
                </section>
              )
            })}

            {filteredChannels.filter(
              (p) => !PLUGIN_CATEGORIES.some((c) => c.types.includes(p.type))
            ).length > 0 && (
              <section>
                <p className="mb-2 px-2 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground/50">
                  {t('channel.custom', 'Custom')}
                </p>
                <div className="space-y-1.5">
                  {filteredChannels
                    .filter((p) => !PLUGIN_CATEGORIES.some((c) => c.types.includes(p.type)))
                    .map((p) => {
                      const status = channelStatuses[p.id] ?? 'stopped'
                      const isSelected = selectedChannelId === p.id
                      return (
                        <div
                          key={p.id}
                          className={cn(
                            'flex w-full cursor-pointer items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors',
                            isSelected
                              ? 'bg-accent text-accent-foreground'
                              : 'hover:bg-muted/60 text-foreground/85',
                            !p.enabled && !isSelected && 'text-muted-foreground'
                          )}
                          onClick={() => void handleSelectChannel(p)}
                        >
                          <div className={cn('shrink-0', !p.enabled && 'opacity-40')}>
                            <ChannelIcon
                              icon={getDescriptor(p.type)?.icon ?? ''}
                              className="size-5"
                            />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium">{p.name}</span>
                              <span
                                className={cn(
                                  'size-1.5 shrink-0 rounded-full',
                                  status === 'running'
                                    ? 'bg-emerald-500'
                                    : status === 'error'
                                      ? 'bg-destructive'
                                      : 'bg-muted-foreground/30'
                                )}
                              />
                            </div>
                            <p className="mt-1 truncate text-[11px] text-muted-foreground">
                              {p.type}
                            </p>
                          </div>
                          <Switch
                            checked={p.enabled}
                            onCheckedChange={() => {
                              void handleToggleChannelEnabled(p)
                            }}
                            className="scale-75"
                            onClick={(e) => e.stopPropagation()}
                          />
                        </div>
                      )
                    })}
                </div>
              </section>
            )}

            {filteredChannels.length === 0 && (
              <div className="flex h-full min-h-[220px] flex-col items-center justify-center text-muted-foreground">
                <Puzzle className="mb-3 size-8 opacity-30" />
                <p className="text-sm">
                  {projectId
                    ? t('channel.noProjectChannels', '当前项目暂无可配置频道')
                    : t('channel.noChannels', 'No channels found')}
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="min-h-0 min-w-0 bg-background/60">
          {selectedChannel ? (
            <ChannelConfigPanel plugin={selectedChannel} projectId={projectId} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t('channel.selectToConfig', 'Select a channel to configure')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
