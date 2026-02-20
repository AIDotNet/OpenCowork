import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Search,
  Eye,
  EyeOff,
  Play,
  Square,
  Puzzle,
  MessageCircle,
  Clock,
  Trash2,
  RotateCcw,
  ChevronDown,
  Check,
  Shield,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Textarea } from '@renderer/components/ui/textarea'
import { Switch } from '@renderer/components/ui/switch'
import { Separator } from '@renderer/components/ui/separator'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { usePluginStore } from '@renderer/stores/plugin-store'
import { useProviderStore } from '@renderer/stores/provider-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { ProviderIcon, ModelIcon } from '@renderer/components/settings/provider-icons'
import { cn } from '@renderer/lib/utils'
import type { PluginInstance, PluginFeatures, PluginPermissions } from '@renderer/lib/plugins/types'
import { DEFAULT_PLUGIN_PERMISSIONS } from '@renderer/lib/plugins/types'
import {
  FeishuIcon,
  DingTalkIcon,
  TelegramIcon,
  DiscordIcon,
  WhatsAppIcon,
  WeComIcon,
} from '@renderer/components/icons/plugin-icons'

// ─── Plugin Icon Helper ───

const PLUGIN_ICON_COMPONENTS: Record<string, React.FC<React.SVGProps<SVGSVGElement>>> = {
  feishu: FeishuIcon,
  dingtalk: DingTalkIcon,
  telegram: TelegramIcon,
  discord: DiscordIcon,
  whatsapp: WhatsAppIcon,
  wecom: WeComIcon,
}

function PluginIcon({ icon, className = '' }: { icon: string; className?: string }): React.JSX.Element {
  const IconComponent = PLUGIN_ICON_COMPONENTS[icon]
  if (IconComponent) {
    return <IconComponent className={`shrink-0 ${className}`} />
  }
  return <Puzzle className={`shrink-0 ${className}`} />
}

// ─── Plugin Conversations (sub-component) ───

interface SessionRow {
  id: string
  title: string
  plugin_id: string
  external_chat_id: string
  created_at: number
  updated_at: number
  message_count: number
}

function PluginConversations({ pluginId }: { pluginId: string }): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [loading, setLoading] = useState(false)

  const loadSessions = useCallback(async () => {
    setLoading(true)
    try {
      const rows = (await ipcClient.invoke('plugin:sessions:list-all')) as SessionRow[]
      setSessions(rows.filter((r) => r.plugin_id === pluginId))
    } catch {
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [pluginId])

  useEffect(() => { void loadSessions() }, [loadSessions])

  const formatTime = (ts: number): string => {
    const d = new Date(ts)
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  const handleClear = async (sessionId: string): Promise<void> => {
    await ipcClient.invoke('plugin:sessions:clear', { sessionId })
    await loadSessions()
    toast.success(t('plugin.messagesCleared', 'Messages cleared'))
  }

  const handleDelete = async (sessionId: string): Promise<void> => {
    await ipcClient.invoke('plugin:sessions:delete', { sessionId })
    setSessions((prev) => prev.filter((s) => s.id !== sessionId))
    toast.success(t('plugin.sessionDeleted', 'Conversation deleted'))
  }

  return (
    <section className="space-y-2 mb-4">
      <div className="flex items-center gap-2 text-xs font-medium">
        <MessageCircle className="size-3.5" />
        {t('plugin.conversations', 'Conversations')}
        {sessions.length > 0 && (
          <span className="text-muted-foreground">({sessions.length})</span>
        )}
        <button
          onClick={() => void loadSessions()}
          className="ml-auto text-muted-foreground hover:text-foreground transition-colors"
          title="Refresh"
        >
          <RotateCcw className={`size-3 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      {sessions.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">
          {t('plugin.conversationsDesc', 'Plugin conversation history will appear here.')}
        </p>
      ) : (
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {sessions.map((s) => (
            <div
              key={s.id}
              className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/50 transition-colors"
            >
              <MessageCircle className="size-3 text-muted-foreground shrink-0" />
              <span className="flex-1 truncate">{s.title || 'Untitled'}</span>
              <span className="text-[10px] text-muted-foreground shrink-0">
                {s.message_count} msgs
              </span>
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0">
                <Clock className="size-2.5" />
                {formatTime(s.updated_at)}
              </span>
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                <button
                  onClick={() => void handleClear(s.id)}
                  className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                  title={t('plugin.clearMessages', 'Clear messages')}
                >
                  <RotateCcw className="size-3" />
                </button>
                <button
                  onClick={() => void handleDelete(s.id)}
                  className="p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                  title={t('plugin.deleteSession', 'Delete conversation')}
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// ─── Plugin Config Panel (right side) ───

function PluginConfigPanel({ plugin }: { plugin: PluginInstance }): React.JSX.Element {
  const { t } = useTranslation('settings')
  const updatePlugin = usePluginStore((s) => s.updatePlugin)
  const removePlugin = usePluginStore((s) => s.removePlugin)
  const startPlugin = usePluginStore((s) => s.startPlugin)
  const stopPlugin = usePluginStore((s) => s.stopPlugin)
  const togglePluginEnabled = usePluginStore((s) => s.togglePluginEnabled)
  const pluginStatuses = usePluginStore((s) => s.pluginStatuses)
  const getDescriptor = usePluginStore((s) => s.getDescriptor)
  const refreshStatus = usePluginStore((s) => s.refreshStatus)

  const descriptor = getDescriptor(plugin.type)
  const status = pluginStatuses[plugin.id] ?? 'stopped'

  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({})

  // Local state for debounced fields
  const providers = useProviderStore((s) => s.providers)
  const enabledProviders = useMemo(() => providers.filter((p) => p.enabled), [providers])
  const [modelPopoverOpen, setModelPopoverOpen] = useState(false)

  const [localName, setLocalName] = useState(plugin.name)
  const [localConfig, setLocalConfig] = useState(plugin.config)
  const [localSystemPrompt, setLocalSystemPrompt] = useState(plugin.userSystemPrompt)
  const [localModel, setLocalModel] = useState(plugin.model ?? '')
  const [localFeatures, setLocalFeatures] = useState<PluginFeatures>(
    plugin.features ?? { autoReply: true, streamingReply: true, autoStart: true }
  )
  const [localPerms, setLocalPerms] = useState<PluginPermissions>(
    plugin.permissions ?? DEFAULT_PLUGIN_PERMISSIONS
  )
  const [newReadPath, setNewReadPath] = useState('')

  // Reset local state when selected plugin changes
  useEffect(() => {
    setLocalName(plugin.name)
    setLocalConfig(plugin.config)
    setLocalSystemPrompt(plugin.userSystemPrompt)
    setLocalModel(plugin.model ?? '')
    setLocalFeatures(plugin.features ?? { autoReply: true, streamingReply: true, autoStart: true })
    setLocalPerms(plugin.permissions ?? DEFAULT_PLUGIN_PERMISSIONS)
    setNewReadPath('')
  }, [plugin.id]) // eslint-disable-line react-hooks/exhaustive-deps

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
        updatePlugin(plugin.id, patch)
      }, 500)
    },
    [plugin.id, updatePlugin]
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

  const handleSystemPromptChange = (value: string): void => {
    setLocalSystemPrompt(value)
    debouncedSave({ userSystemPrompt: value })
  }

  const handleModelChange = (value: string, providerId?: string): void => {
    const model = value === '__default__' ? null : value
    const pid = value === '__default__' ? null : (providerId ?? null)
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

  const handleAddReadPath = (): void => {
    const trimmed = newReadPath.trim()
    if (!trimmed) return
    if (localPerms.readablePathPrefixes.includes(trimmed)) {
      setNewReadPath('')
      return
    }
    const next = { ...localPerms, readablePathPrefixes: [...localPerms.readablePathPrefixes, trimmed] }
    setLocalPerms(next)
    setNewReadPath('')
    debouncedSave({ permissions: next })
  }

  const handleRemoveReadPath = (path: string): void => {
    const next = { ...localPerms, readablePathPrefixes: localPerms.readablePathPrefixes.filter((p) => p !== path) }
    setLocalPerms(next)
    debouncedSave({ permissions: next })
  }

  const configFields = descriptor?.configSchema ?? []

  return (
    <div className="flex flex-col h-full overflow-y-auto px-4 py-3">
      {/* Header with icon + name + enabled toggle */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <PluginIcon icon={descriptor?.icon ?? ''} className="size-8" />
          <div>
            <h3 className="text-sm font-semibold">{localName}</h3>
            <p className="text-xs text-muted-foreground">{descriptor?.description ?? plugin.type}</p>
          </div>
        </div>
        <Switch
          checked={plugin.enabled}
          onCheckedChange={() => togglePluginEnabled(plugin.id)}
        />
      </div>

      <Separator className="mb-4" />

      {/* Bot Name */}
      <section className="space-y-2 mb-4">
        <label className="text-xs font-medium">{t('plugin.botName', 'Bot Name')}</label>
        <Input
          className="h-8 text-xs"
          value={localName}
          onChange={(e) => handleNameChange(e.target.value)}
          placeholder={descriptor?.displayName ?? 'Plugin'}
        />
      </section>

      {/* Config fields from schema */}
      {configFields.map((field) => (
        <section key={field.key} className="space-y-2 mb-4">
          <label className="text-xs font-medium">
            {t(field.label, field.key)}
            {field.required && <span className="text-destructive ml-0.5">*</span>}
          </label>
          <div className="relative">
            <Input
              className="h-8 text-xs pr-8"
              type={field.type === 'secret' && !showSecrets[field.key] ? 'password' : 'text'}
              placeholder={field.placeholder}
              value={localConfig[field.key] ?? ''}
              onChange={(e) => handleConfigChange(field.key, e.target.value)}
            />
            {field.type === 'secret' && (
              <Button
                variant="ghost"
                size="sm"
                className="absolute right-0 top-0 h-8 w-8 p-0"
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

      <Separator className="mb-4" />

      {/* System Prompt — empty, user-fillable */}
      <section className="space-y-2 mb-4">
        <label className="text-xs font-medium">{t('plugin.systemPrompt', 'System Prompt')}</label>
        <Textarea
          className="min-h-[80px] text-xs resize-none"
          value={localSystemPrompt}
          onChange={(e) => handleSystemPromptChange(e.target.value)}
          placeholder={t('plugin.systemPromptPlaceholder', 'Optional: set a custom system prompt for this plugin\'s auto-replies...')}
        />
      </section>

      <Separator className="mb-4" />

      {/* Model override */}
      <section className="space-y-2 mb-4">
        <label className="text-xs font-medium">{t('plugin.model', 'Reply Model')}</label>
        <Popover open={modelPopoverOpen} onOpenChange={setModelPopoverOpen}>
          <PopoverTrigger asChild>
            <button className="w-full flex items-center gap-2 h-8 rounded-md border border-input bg-background px-3 text-xs hover:bg-muted/40 transition-colors text-left">
              {localModel ? (
                <>
                  <ModelIcon modelId={localModel} size={12} className="shrink-0 opacity-70" />
                  <span className="flex-1 truncate">{localModel.split('/').pop()?.replace(/-\d{8}$/, '') ?? localModel}</span>
                </>
              ) : (
                <span className="flex-1 text-muted-foreground">{t('plugin.modelDefault', 'Use global default')}</span>
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
              onClick={() => { handleModelChange('__default__'); setModelPopoverOpen(false) }}
            >
              {!localModel ? <Check className="size-3 text-primary" /> : <span className="size-3" />}
              <span className="text-muted-foreground">{t('plugin.modelDefault', 'Use global default')}</span>
            </button>
            <Separator className="my-1" />
            {enabledProviders.map((provider) => {
              const models = provider.models.filter((m) => m.enabled)
              if (models.length === 0) return null
              return (
                <div key={provider.id}>
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/50 px-2 py-1 uppercase tracking-wider">
                    <ProviderIcon builtinId={provider.builtinId} size={12} />
                    {provider.name}
                  </div>
                  {models.map((m) => {
                    const isActive = localModel === m.id
                    return (
                      <button
                        key={m.id}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted/60 transition-colors',
                          isActive && 'bg-muted/40 font-medium'
                        )}
                        onClick={() => { handleModelChange(m.id, provider.id); setModelPopoverOpen(false) }}
                      >
                        {isActive
                          ? <Check className="size-3 text-primary shrink-0" />
                          : <ModelIcon icon={m.icon} modelId={m.id} providerBuiltinId={provider.builtinId} size={12} className="opacity-60 shrink-0" />}
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
          {t('plugin.modelHint', 'Model used for auto-reply. Leave default to use the globally active model.')}
        </p>
      </section>

      {/* Feature toggles */}
      <section className="space-y-2 mb-4">
        <label className="text-xs font-medium">{t('plugin.features', 'Features')}</label>
        <div className="space-y-2 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs">{t('plugin.autoReply', 'Auto Reply')}</p>
              <p className="text-[10px] text-muted-foreground">{t('plugin.autoReplyDesc', 'Automatically reply to incoming messages using the Agent')}</p>
            </div>
            <Switch
              checked={localFeatures.autoReply}
              onCheckedChange={(v) => handleFeatureToggle('autoReply', v)}
              className="scale-75"
            />
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs">{t('plugin.streamingReply', 'Streaming Reply')}</p>
              <p className="text-[10px] text-muted-foreground">{t('plugin.streamingReplyDesc', 'Stream responses in real-time via CardKit (Feishu only)')}</p>
            </div>
            <Switch
              checked={localFeatures.streamingReply}
              onCheckedChange={(v) => handleFeatureToggle('streamingReply', v)}
              className="scale-75"
            />
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs">{t('plugin.autoStart', 'Auto Start')}</p>
              <p className="text-[10px] text-muted-foreground">{t('plugin.autoStartDesc', 'Automatically start this plugin when the app launches')}</p>
            </div>
            <Switch
              checked={localFeatures.autoStart}
              onCheckedChange={(v) => handleFeatureToggle('autoStart', v)}
              className="scale-75"
            />
          </div>
        </div>
      </section>

      <Separator className="mb-4" />

      {/* Security & Permissions */}
      <section className="space-y-2 mb-4">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <Shield className="size-3.5" />
          {t('plugin.security', 'Security & Permissions')}
        </div>
        <div className="space-y-2 rounded-md border p-3">
          {/* Read Home Directory */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs">{t('plugin.allowReadHome', 'Read Home Directory')}</p>
              <p className="text-[10px] text-muted-foreground">
                {t('plugin.allowReadHomeDesc', 'Allow reading files under your home directory (~)')}
              </p>
            </div>
            <Switch
              checked={localPerms.allowReadHome}
              onCheckedChange={(v) => handlePermToggle('allowReadHome', v)}
              className="scale-75"
            />
          </div>

          {/* Readable Path Prefixes (shown when allowReadHome is false) */}
          {!localPerms.allowReadHome && (
            <>
              <Separator />
              <div className="space-y-1.5">
                <p className="text-xs">{t('plugin.readablePaths', 'Allowed Read Paths')}</p>
                <p className="text-[10px] text-muted-foreground">
                  {t('plugin.readablePathsDesc', 'Whitelist specific directories the plugin can read')}
                </p>
                {localPerms.readablePathPrefixes.length > 0 && (
                  <div className="flex flex-wrap gap-1">
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
                <div className="flex gap-1">
                  <Input
                    className="h-6 text-[10px] font-mono flex-1"
                    placeholder="/home/user/docs"
                    value={newReadPath}
                    onChange={(e) => setNewReadPath(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleAddReadPath() }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 text-[10px] px-2"
                    onClick={handleAddReadPath}
                  >
                    {t('plugin.addPath', 'Add')}
                  </Button>
                </div>
              </div>
            </>
          )}

          <Separator />

          {/* Shell Execution */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs">{t('plugin.allowShell', 'Shell Execution')}</p>
              <p className="text-[10px] text-muted-foreground">
                {t('plugin.allowShellDesc', 'Allow executing terminal commands (high risk)')}
              </p>
            </div>
            <Switch
              checked={localPerms.allowShell}
              onCheckedChange={(v) => handlePermToggle('allowShell', v)}
              className="scale-75"
            />
          </div>

          <Separator />

          {/* Write Outside */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs">{t('plugin.allowWriteOutside', 'Write Outside Working Dir')}</p>
              <p className="text-[10px] text-muted-foreground">
                {t('plugin.allowWriteOutsideDesc', 'Allow writing files outside the plugin directory')}
              </p>
            </div>
            <Switch
              checked={localPerms.allowWriteOutside}
              onCheckedChange={(v) => handlePermToggle('allowWriteOutside', v)}
              className="scale-75"
            />
          </div>

          <Separator />

          {/* Sub-agents */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs">{t('plugin.allowSubAgents', 'Sub-Agent Tools')}</p>
              <p className="text-[10px] text-muted-foreground">
                {t('plugin.allowSubAgentsDesc', 'Allow using Task and other sub-agent tools')}
              </p>
            </div>
            <Switch
              checked={localPerms.allowSubAgents}
              onCheckedChange={(v) => handlePermToggle('allowSubAgents', v)}
              className="scale-75"
            />
          </div>
        </div>
      </section>

      <Separator className="mb-4" />
      <section className="space-y-3 mb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium">{t('plugin.status', 'Status')}</span>
            <span
              className={`inline-flex items-center gap-1 text-xs ${
                status === 'running'
                  ? 'text-emerald-500'
                  : status === 'error'
                    ? 'text-destructive'
                    : 'text-muted-foreground'
              }`}
            >
              <span
                className={`size-1.5 rounded-full ${
                  status === 'running'
                    ? 'bg-emerald-500'
                    : status === 'error'
                      ? 'bg-destructive'
                      : 'bg-muted-foreground/50'
                }`}
              />
              {status === 'running'
                ? t('plugin.running', 'Running')
                : status === 'error'
                  ? t('plugin.error', 'Error')
                  : t('plugin.stopped', 'Stopped')}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {status === 'running' ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={async () => {
                  await stopPlugin(plugin.id)
                  toast.success(t('plugin.stopped', 'Stopped'))
                }}
              >
                <Square className="size-3 mr-1" />
                {t('plugin.stop', 'Stop')}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={async () => {
                  const err = await startPlugin(plugin.id)
                  if (err) {
                    toast.error(t('plugin.error', 'Error'), { description: err })
                  } else {
                    toast.success(t('plugin.running', 'Running'))
                  }
                }}
                disabled={!plugin.enabled}
              >
                <Play className="size-3 mr-1" />
                {t('plugin.start', 'Start')}
              </Button>
            )}
          </div>
        </div>
      </section>

      <Separator className="mb-4" />

      {/* Conversations section */}
      <PluginConversations pluginId={plugin.id} />

      {/* Danger zone — only for non-builtin plugins */}
      {!plugin.builtin && (
        <div className="mt-auto pt-4">
          <Separator className="mb-4" />
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={() => {
              removePlugin(plugin.id)
              toast.success(t('plugin.removed', 'Plugin removed'))
            }}
          >
            {t('plugin.remove', 'Remove')}
          </Button>
        </div>
      )}
    </div>
  )
}

// ─── Category grouping for built-in plugins ───

const PLUGIN_CATEGORIES: { label: string; types: string[] }[] = [
  { label: 'China', types: ['feishu-bot', 'dingtalk-bot', 'wecom-bot'] },
  { label: 'International', types: ['telegram-bot', 'discord-bot', 'whatsapp-bot'] },
]

// ─── Main Plugin Panel ───

export function PluginPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const plugins = usePluginStore((s) => s.plugins)
  const selectedPluginId = usePluginStore((s) => s.selectedPluginId)
  const setSelectedPlugin = usePluginStore((s) => s.setSelectedPlugin)
  const loadProviders = usePluginStore((s) => s.loadProviders)
  const loadPlugins = usePluginStore((s) => s.loadPlugins)
  const pluginStatuses = usePluginStore((s) => s.pluginStatuses)
  const getDescriptor = usePluginStore((s) => s.getDescriptor)
  const togglePluginEnabled = usePluginStore((s) => s.togglePluginEnabled)

  const [searchQuery, setSearchQuery] = useState('')

  // Load providers and plugins on mount
  useEffect(() => {
    loadProviders()
    loadPlugins()
  }, [loadProviders, loadPlugins])

  // Auto-select first plugin if none selected
  useEffect(() => {
    if (!selectedPluginId && plugins.length > 0) {
      setSelectedPlugin(plugins[0].id)
    }
  }, [selectedPluginId, plugins, setSelectedPlugin])

  const filteredPlugins = useMemo(() => {
    if (!searchQuery.trim()) return plugins
    const q = searchQuery.toLowerCase()
    return plugins.filter(
      (p) =>
        p.name.toLowerCase().includes(q) || p.type.toLowerCase().includes(q)
    )
  }, [plugins, searchQuery])

  const selectedPlugin = plugins.find((p) => p.id === selectedPluginId)

  return (
    <div className="flex flex-col h-full">
      <div className="mb-3 shrink-0">
        <h2 className="text-lg font-semibold">{t('plugin.title', 'Plugins')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('plugin.subtitle', 'Configure and manage your messaging plugins')}
        </p>
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left: Plugin list */}
        <div className="w-52 shrink-0 border-r flex flex-col">
          {/* Search */}
          <div className="flex items-center gap-1 p-2 border-b">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/50" />
              <Input
                placeholder={t('plugin.search', 'Search plugins...')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-7 pl-7 text-[11px] bg-transparent border-0 shadow-none focus-visible:ring-0"
              />
            </div>
          </div>

          {/* List — grouped by category */}
          <div className="flex-1 overflow-y-auto py-1">
            {PLUGIN_CATEGORIES.map((category) => {
              const categoryPlugins = filteredPlugins.filter((p) =>
                category.types.includes(p.type)
              )
              if (categoryPlugins.length === 0) return null
              return (
                <div key={category.label} className="px-2 pt-2 pb-1">
                  <p className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider px-1 mb-1">
                    {category.label}
                  </p>
                  {categoryPlugins.map((p) => {
                    const status = pluginStatuses[p.id] ?? 'stopped'
                    return (
                      <div
                        key={p.id}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 mt-0.5 transition-colors cursor-pointer ${
                          selectedPluginId === p.id
                            ? 'bg-accent text-accent-foreground'
                            : p.enabled
                              ? 'text-foreground/80 hover:bg-muted/60'
                              : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                        }`}
                        onClick={() => setSelectedPlugin(p.id)}
                      >
                        <span className={p.enabled ? '' : 'opacity-40'}>
                          <PluginIcon icon={getDescriptor(p.type)?.icon ?? ''} className="size-4" />
                        </span>
                        <span className="flex-1 truncate text-xs">{p.name}</span>
                        {p.enabled && (
                          <span
                            className={`size-1.5 rounded-full shrink-0 ${
                              status === 'running'
                                ? 'bg-emerald-500'
                                : status === 'error'
                                  ? 'bg-destructive'
                                  : 'bg-muted-foreground/30'
                            }`}
                          />
                        )}
                        <Switch
                          checked={p.enabled}
                          onCheckedChange={() => togglePluginEnabled(p.id)}
                          className="scale-75"
                          onClick={(e) => e.stopPropagation()}
                        />
                      </div>
                    )
                  })}
                </div>
              )
            })}

            {/* Non-categorized plugins (user-added, if any) */}
            {filteredPlugins.filter(
              (p) => !PLUGIN_CATEGORIES.some((c) => c.types.includes(p.type))
            ).length > 0 && (
              <div className="px-2 pt-2 pb-1">
                <p className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider px-1 mb-1">
                  {t('plugin.custom', 'Custom')}
                </p>
                {filteredPlugins
                  .filter((p) => !PLUGIN_CATEGORIES.some((c) => c.types.includes(p.type)))
                  .map((p) => {
                    const status = pluginStatuses[p.id] ?? 'stopped'
                    return (
                      <div
                        key={p.id}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 mt-0.5 transition-colors cursor-pointer ${
                          selectedPluginId === p.id
                            ? 'bg-accent text-accent-foreground'
                            : 'text-foreground/80 hover:bg-muted/60'
                        }`}
                        onClick={() => setSelectedPlugin(p.id)}
                      >
                        <PluginIcon icon={getDescriptor(p.type)?.icon ?? ''} className="size-4" />
                        <span className="flex-1 truncate text-xs">{p.name}</span>
                        <span
                          className={`size-1.5 rounded-full shrink-0 ${
                            status === 'running' ? 'bg-emerald-500' : 'bg-muted-foreground/30'
                          }`}
                        />
                      </div>
                    )
                  })}
              </div>
            )}

            {filteredPlugins.length === 0 && (
              <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                <Puzzle className="size-8 mb-2 opacity-30" />
                <p className="text-xs">{t('plugin.noPlugins', 'No plugins found')}</p>
              </div>
            )}
          </div>
        </div>

        {/* Right: Config panel */}
        <div className="flex-1 min-w-0">
          {selectedPlugin ? (
            <PluginConfigPanel plugin={selectedPlugin} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t('plugin.selectToConfig', 'Select a plugin to configure')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
