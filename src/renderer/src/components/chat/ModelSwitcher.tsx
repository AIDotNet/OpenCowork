import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import {
  ChevronDown,
  Check,
  Search,
  Eye,
  Wrench,
  Brain,
  Settings2,
  Zap,
  MonitorSmartphone,
  Loader2
} from 'lucide-react'
import { useProviderStore, modelSupportsVision } from '@renderer/stores/provider-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useChannelStore } from '@renderer/stores/channel-store'
import { useQuotaStore } from '@renderer/stores/quota-store'
import { useUIStore } from '@renderer/stores/ui-store'

import { useTranslation } from 'react-i18next'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'

import {
  ProviderIcon,
  ModelIcon,
  AutoModelIcon
} from '@renderer/components/settings/provider-icons'
import { cn } from '@renderer/lib/utils'
import type { AIModelConfig, AIProvider, ReasoningEffortLevel } from '@renderer/lib/api/types'

function formatContextLength(length?: number): string | null {
  if (!length) return null
  if (length >= 1_000_000)
    return `${(length / 1_000_000).toFixed(length % 1_000_000 === 0 ? 0 : 1)}M`
  if (length >= 1_000) return `${Math.round(length / 1_000)}K`
  return String(length)
}

function ModelCapabilityTags({
  model,
  providerType,
  t
}: {
  model: AIModelConfig
  providerType?: AIProvider['type']
  t: (key: string) => string
}): React.JSX.Element {
  const ctx = formatContextLength(model.contextLength)
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {modelSupportsVision(model, providerType) && (
        <span className="inline-flex items-center gap-0.5 rounded-sm bg-emerald-500/10 px-1 py-px text-[9px] font-medium text-emerald-600 dark:text-emerald-400">
          <Eye className="size-2.5" />
          {t('topbar.vision')}
        </span>
      )}
      {model.supportsFunctionCall && (
        <span className="inline-flex items-center gap-0.5 rounded-sm bg-blue-500/10 px-1 py-px text-[9px] font-medium text-blue-600 dark:text-blue-400">
          <Wrench className="size-2.5" />
          {t('topbar.tools')}
        </span>
      )}
      {model.supportsThinking && (
        <span className="inline-flex items-center gap-0.5 rounded-sm bg-violet-500/10 px-1 py-px text-[9px] font-medium text-violet-600 dark:text-violet-400">
          <Brain className="size-2.5" />
          {t('topbar.thinking')}
        </span>
      )}
      {ctx && (
        <span className="inline-flex items-center rounded-sm bg-muted/60 px-1 py-px text-[9px] font-medium text-muted-foreground">
          {ctx}
        </span>
      )}
    </div>
  )
}

interface ProviderGroup {
  provider: AIProvider
  models: AIModelConfig[]
}

function supportsPriorityServiceTier(model: AIModelConfig | undefined): boolean {
  return !!model?.serviceTier
}

function selectModel(
  provider: AIProvider,
  modelId: string,
  activeProviderId: string | null,
  setActiveProvider: (id: string) => void,
  setActiveModel: (id: string) => void,
  setOpen: (v: boolean) => void
): void {
  const pid = provider.id
  if (pid !== activeProviderId) setActiveProvider(pid)
  setActiveModel(modelId)
  useSettingsStore.getState().updateSettings({ mainModelSelectionMode: 'manual' })
  const sessionId = useChatStore.getState().activeSessionId
  if (sessionId) {
    useChatStore.getState().updateSessionModel(sessionId, pid, modelId)
    const session = useChatStore.getState().sessions.find((s) => s.id === sessionId)
    if (session?.pluginId) {
      void useChannelStore.getState().updateChannel(session.pluginId, {
        providerId: pid,
        model: modelId
      })
    }
  }
  setOpen(false)
}

function selectAutoModel(setOpen: (v: boolean) => void): void {
  useSettingsStore.getState().updateSettings({ mainModelSelectionMode: 'auto' })
  const sessionId = useChatStore.getState().activeSessionId
  if (sessionId) {
    const session = useChatStore.getState().sessions.find((item) => item.id === sessionId)
    if (!session?.pluginId) {
      useChatStore.getState().clearSessionModelBinding(sessionId)
    }
  }
  setOpen(false)
}

/** Settings popover shown next to model icon */
function ModelSettingsPopover({
  model,
  t,
  tChat
}: {
  model: AIModelConfig | undefined
  t: (key: string) => string
  tChat: (key: string, opts?: Record<string, unknown>) => string
}): React.JSX.Element | null {
  const supportsThinking = model?.supportsThinking ?? false
  const supportsFastMode = supportsPriorityServiceTier(model)
  const levels = model?.thinkingConfig?.reasoningEffortLevels
  const defaultLevel = model?.thinkingConfig?.defaultReasoningEffort ?? 'medium'
  const thinkingEnabled = useSettingsStore((s) => s.thinkingEnabled)
  const fastModeEnabled = useSettingsStore((s) => s.fastModeEnabled)
  const reasoningEffort = useSettingsStore((s) => s.reasoningEffort)

  const toggleThinking = useCallback(() => {
    const store = useSettingsStore.getState()
    if (!store.thinkingEnabled && levels) {
      store.updateSettings({ thinkingEnabled: true, reasoningEffort: defaultLevel })
    } else {
      store.updateSettings({ thinkingEnabled: !store.thinkingEnabled })
    }
  }, [levels, defaultLevel])

  const setEffort = useCallback((level: ReasoningEffortLevel) => {
    useSettingsStore.getState().updateSettings({ reasoningEffort: level, thinkingEnabled: true })
  }, [])

  const hasAnySetting = supportsThinking || supportsFastMode

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <PopoverTrigger asChild>
              <button className="inline-flex items-center justify-center h-8 w-7 rounded-r-lg text-muted-foreground/50 hover:text-foreground hover:bg-muted/50 transition-colors border-l border-border/30">
                <Settings2 className="size-3" />
              </button>
            </PopoverTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent>{t('topbar.modelSettings')}</TooltipContent>
      </Tooltip>
      <PopoverContent className="w-56 p-2" align="start" side="top" sideOffset={8}>
        <div className="flex flex-col gap-1">
          {!hasAnySetting && (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              {tChat('input.noModelSettings')}
            </div>
          )}
          {supportsThinking && (
            <>
              <div className="flex items-center gap-1.5 px-1 pb-1 text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider">
                <Brain className="size-3" />
                {t('topbar.deepThinking')}
              </div>

              {levels && levels.length > 0 ? (
                <>
                  <button
                    type="button"
                    className={cn(
                      'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors text-left',
                      !thinkingEnabled
                        ? 'bg-accent text-accent-foreground'
                        : 'hover:bg-muted/60 text-foreground/80'
                    )}
                    onClick={() =>
                      useSettingsStore.getState().updateSettings({ thinkingEnabled: false })
                    }
                  >
                    <span className="font-medium">{tChat('input.thinkingOff')}</span>
                  </button>
                  {levels.map((level) => (
                    <button
                      key={level}
                      type="button"
                      className={cn(
                        'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors text-left',
                        thinkingEnabled && reasoningEffort === level
                          ? 'bg-violet-500/15 text-violet-600 dark:text-violet-400'
                          : 'hover:bg-muted/60 text-foreground/80'
                      )}
                      onClick={() => setEffort(level)}
                    >
                      <span className="font-medium uppercase">{level}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {tChat(`input.effortDesc.${level}`)}
                      </span>
                    </button>
                  ))}
                </>
              ) : (
                <button
                  type="button"
                  className={cn(
                    'flex items-center justify-between rounded-md px-2.5 py-2 text-xs transition-colors',
                    thinkingEnabled
                      ? 'bg-violet-500/10 text-violet-600 dark:text-violet-400'
                      : 'hover:bg-muted/60 text-foreground/80'
                  )}
                  onClick={toggleThinking}
                >
                  <span className="font-medium">
                    {thinkingEnabled
                      ? tChat('input.disableThinking')
                      : tChat('input.enableThinking')}
                  </span>
                  <span
                    className={cn(
                      'size-4 rounded-full border-2 transition-colors',
                      thinkingEnabled
                        ? 'bg-violet-500 border-violet-500'
                        : 'border-muted-foreground/30'
                    )}
                  />
                </button>
              )}
            </>
          )}

          {supportsThinking && supportsFastMode && (
            <div className="my-1 border-t border-border/50" />
          )}

          {supportsFastMode && (
            <>
              <div className="flex items-center gap-1.5 px-1 pb-1 pt-1 text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider">
                <Zap className="size-3" />
                {t('topbar.fastMode')}
              </div>
              <button
                type="button"
                className={cn(
                  'flex items-center justify-between rounded-md px-2.5 py-2 text-xs transition-colors',
                  fastModeEnabled
                    ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                    : 'hover:bg-muted/60 text-foreground/80'
                )}
                onClick={() =>
                  useSettingsStore.getState().updateSettings({ fastModeEnabled: !fastModeEnabled })
                }
              >
                <span className="flex min-w-0 flex-col text-left">
                  <span className="font-medium">{t('topbar.fastMode')}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {t('topbar.fastModeDesc')}
                  </span>
                </span>
                <span
                  className={cn(
                    'size-4 rounded-full border-2 transition-colors shrink-0',
                    fastModeEnabled ? 'bg-amber-500 border-amber-500' : 'border-muted-foreground/30'
                  )}
                />
              </button>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function ModelSwitcher(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const { t: tChat } = useTranslation('chat')
  const { t: tSettings } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const activeProviderId = useProviderStore((s) => s.activeProviderId)
  const activeModelId = useProviderStore((s) => s.activeModelId)
  const providers = useProviderStore((s) => s.providers)
  const setActiveProvider = useProviderStore((s) => s.setActiveProvider)
  const setActiveModel = useProviderStore((s) => s.setActiveModel)
  const quotaByKey = useQuotaStore((s) => s.quotaByKey)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const sessions = useChatStore((s) => s.sessions)
  const mainModelSelectionMode = useSettingsStore((s) => s.mainModelSelectionMode)
  const autoSelection = useUIStore((s) => s.getAutoModelSelection(activeSessionId))
  const autoRoutingState = useUIStore((s) => s.getAutoModelRoutingState(activeSessionId))

  const enabledProviders = providers.filter((p) => p.enabled)
  const activeSession = sessions.find((item) => item.id === activeSessionId)
  const sessionProviderId = activeSession?.providerId ?? null
  const sessionModelId = activeSession?.modelId ?? null
  const isSessionBound = Boolean(sessionProviderId && sessionModelId)
  const displayProviderId = sessionProviderId ?? activeProviderId
  const displayModelId = sessionModelId ?? activeModelId
  const displayProvider = providers.find((p) => p.id === displayProviderId)
  const displayModel = displayProvider?.models.find((m) => m.id === displayModelId)
  const isAutoModeActive = !isSessionBound && mainModelSelectionMode === 'auto'
  const autoResolvedProvider = autoSelection?.providerId
    ? providers.find((provider) => provider.id === autoSelection.providerId)
    : null
  const autoResolvedModel = autoResolvedProvider?.models.find(
    (model) => model.id === autoSelection?.modelId
  )
  const settingsModel = isAutoModeActive ? (autoResolvedModel ?? undefined) : displayModel

  const codexQuota = useMemo(() => {
    if (!displayProvider || displayProvider.builtinId !== 'codex-oauth') return null
    return (
      quotaByKey[displayProvider.id] ||
      (displayProvider.builtinId ? quotaByKey[displayProvider.builtinId] : undefined) ||
      quotaByKey['codex'] ||
      null
    )
  }, [displayProvider, quotaByKey])

  const formatPercent = (value?: number): string => {
    if (value === undefined || Number.isNaN(value)) return '0%'
    return `${Math.round(value)}%`
  }

  useEffect(() => {
    if (!open) return

    const timer = setTimeout(() => {
      setSearch('')
      searchRef.current?.focus()
    }, 50)

    return () => clearTimeout(timer)
  }, [open])

  const groups = useMemo<ProviderGroup[]>(() => {
    const q = search.toLowerCase().trim()
    return enabledProviders
      .map((provider) => {
        const models = provider.models.filter((m) => {
          if (!m.enabled) return false
          if (!q) return true
          const name = (m.name || m.id).toLowerCase()
          return name.includes(q) || provider.name.toLowerCase().includes(q)
        })
        return { provider, models }
      })
      .filter((g) => g.models.length > 0)
  }, [enabledProviders, search])

  return (
    <div className="inline-flex items-center h-8 rounded-lg border border-transparent hover:border-border/50 hover:bg-muted/30 transition-colors">
      {/* Model icon trigger — opens model list */}
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <PopoverTrigger asChild>
                <button className="inline-flex items-center gap-1.5 h-8 rounded-l-lg px-2 text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors">
                  {isAutoModeActive ? (
                    autoRoutingState === 'routing' ? (
                      <Loader2 size={16} className="animate-spin text-amber-500" />
                    ) : (
                      <AutoModelIcon size={16} />
                    )
                  ) : (
                    <ModelIcon
                      icon={displayModel?.icon}
                      modelId={displayModelId}
                      providerBuiltinId={displayProvider?.builtinId}
                      size={20}
                    />
                  )}
                  <span className="max-w-24 truncate text-xs font-medium">
                    {isAutoModeActive
                      ? autoRoutingState === 'routing'
                        ? t('topbar.autoModelRoutingShort')
                        : t('topbar.autoModel')
                      : (displayModel?.name ?? displayModelId ?? t('topbar.noModel'))}
                  </span>
                  <ChevronDown className="size-2.5 opacity-40" />
                </button>
              </PopoverTrigger>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            {isAutoModeActive
              ? autoRoutingState === 'routing'
                ? t('topbar.autoModelRouting')
                : autoSelection?.modelName
                  ? t('topbar.autoModelTooltip', {
                      route: t(
                        autoSelection.target === 'main'
                          ? 'topbar.autoModelMain'
                          : 'topbar.autoModelFast'
                      ),
                      model: autoSelection.modelName
                    })
                  : t('topbar.autoModelTooltipIdle')
              : displayModel?.name || displayModelId || t('topbar.noModel')}
          </TooltipContent>
        </Tooltip>
        <PopoverContent className="w-80 p-0 overflow-hidden" align="start" sideOffset={8}>
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Search className="size-3.5 text-muted-foreground/60 shrink-0" />
            <input
              ref={searchRef}
              type="text"
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/40"
              placeholder={t('topbar.searchModel')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="max-h-[360px] overflow-y-auto p-1">
            <button
              className={cn(
                'mb-2 flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left hover:bg-muted/60 transition-colors group',
                isAutoModeActive && 'bg-primary/5'
              )}
              onClick={() => selectAutoModel(setOpen)}
            >
              <span className="mt-0.5 flex size-5 items-center justify-center shrink-0">
                {isAutoModeActive ? (
                  <span className="flex size-5 items-center justify-center rounded-full bg-primary/10">
                    <Check className="size-3 text-primary" />
                  </span>
                ) : (
                  <AutoModelIcon size={18} />
                )}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span
                  className={cn(
                    'truncate text-xs',
                    isAutoModeActive
                      ? 'font-semibold text-primary'
                      : 'text-foreground/80 group-hover:text-foreground'
                  )}
                >
                  {t('topbar.autoModel')}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {autoRoutingState === 'routing'
                    ? t('topbar.autoModelRouting')
                    : autoSelection?.modelName
                      ? t('topbar.autoModelTooltip', {
                          route: t(
                            autoSelection.target === 'main'
                              ? 'topbar.autoModelMain'
                              : 'topbar.autoModelFast'
                          ),
                          model: autoSelection.modelName
                        })
                      : t('topbar.autoModelDesc')}
                </span>
              </div>
            </button>
            {groups.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground/50">
                {enabledProviders.length === 0 ? t('topbar.noProviders') : t('topbar.noModels')}
              </div>
            ) : (
              groups.map(({ provider, models }) => (
                <div key={provider.id} className="mb-1 last:mb-0">
                  <div className="flex items-center gap-1.5 px-2 py-1.5 text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">
                    <ProviderIcon builtinId={provider.builtinId} size={14} />
                    {provider.name}
                  </div>
                  {models.map((m) => {
                    const isActive =
                      !isAutoModeActive &&
                      provider.id === displayProviderId &&
                      m.id === displayModelId
                    return (
                      <button
                        key={`${provider.id}-${m.id}`}
                        className={cn(
                          'flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left hover:bg-muted/60 transition-colors group',
                          isActive && 'bg-primary/5'
                        )}
                        onClick={() =>
                          selectModel(
                            provider,
                            m.id,
                            activeProviderId,
                            setActiveProvider,
                            setActiveModel,
                            setOpen
                          )
                        }
                      >
                        <span className="mt-0.5 shrink-0">
                          {isActive ? (
                            <span className="flex size-5 items-center justify-center rounded-full bg-primary/10">
                              <Check className="size-3 text-primary" />
                            </span>
                          ) : (
                            <ModelIcon
                              icon={m.icon}
                              modelId={m.id}
                              providerBuiltinId={provider.builtinId}
                              size={20}
                            />
                          )}
                        </span>
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span
                            className={cn(
                              'truncate text-xs',
                              isActive
                                ? 'font-semibold text-primary'
                                : 'text-foreground/80 group-hover:text-foreground'
                            )}
                          >
                            {m.name || m.id.replace(/-\d{8}$/, '')}
                          </span>
                          <ModelCapabilityTags model={m} providerType={provider.type} t={t} />
                        </div>
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>

      {/* Quota Indicator */}
      {codexQuota && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/30 border border-border/10 cursor-help hover:bg-muted/50 transition-colors mx-1">
              <MonitorSmartphone className="size-3 text-emerald-500" />
              <div className="flex flex-col leading-none gap-0.5">
                <div className="h-1 w-10 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 transition-all"
                    style={{ width: `${Math.min(100, codexQuota.primary?.usedPercent ?? 0)}%` }}
                  />
                </div>
                <span className="text-[9px] text-muted-foreground/60 font-medium">
                  {formatPercent(codexQuota.primary?.usedPercent)}
                </span>
              </div>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="p-3 w-48 space-y-2">
            <div className="space-y-1">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                {tSettings('provider.codexQuotaPrimary')}
              </p>
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold">
                  {formatPercent(codexQuota.primary?.usedPercent)}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {codexQuota.primary?.resetAt
                    ? new Date(codexQuota.primary.resetAt).toLocaleString([], {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit'
                      })
                    : ''}
                </span>
              </div>
              <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500"
                  style={{ width: `${Math.min(100, codexQuota.primary?.usedPercent ?? 0)}%` }}
                />
              </div>
            </div>
            {codexQuota.secondary && (
              <div className="space-y-1 pt-1 border-t">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  {tSettings('provider.codexQuotaSecondary')}
                </p>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold">
                    {formatPercent(codexQuota.secondary.usedPercent)}
                  </span>
                </div>
                <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-amber-500"
                    style={{ width: `${Math.min(100, codexQuota.secondary.usedPercent ?? 0)}%` }}
                  />
                </div>
              </div>
            )}
          </TooltipContent>
        </Tooltip>
      )}

      {/* Settings icon — model config popover */}
      <ModelSettingsPopover model={settingsModel} t={t} tChat={tChat} />
    </div>
  )
}
