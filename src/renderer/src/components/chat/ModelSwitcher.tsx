import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  Check,
  Search,
  Eye,
  Wrench,
  Brain,
  Settings2,
  MonitorSmartphone,
  Loader2,
  Globe2
} from 'lucide-react'
import {
  isProviderAvailableForModelSelection,
  useProviderStore,
  modelSupportsVision
} from '@renderer/stores/provider-store'
import {
  useSettingsStore,
  getReasoningEffortKey,
  resolveReasoningEffortForModel
} from '@renderer/stores/settings-store'
import { useChatStore, type SessionModelSelectionMode } from '@renderer/stores/chat-store'
import { useChannelStore } from '@renderer/stores/channel-store'
import { useQuotaStore } from '@renderer/stores/quota-store'
import { useUIStore } from '@renderer/stores/ui-store'

import { useTranslation } from 'react-i18next'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'

import {
  ProviderIcon,
  ModelIcon,
  AutoModelIcon
} from '@renderer/components/settings/provider-icons'
import { cn } from '@renderer/lib/utils'
import type {
  AIModelConfig,
  AIProvider,
  ReasoningEffortLevel,
  ThinkingConfig
} from '@renderer/lib/api/types'
import { isResponsesImageGenerationEnabled } from '@renderer/lib/api/responses-image-generation'
import {
  clampCompressionThreshold,
  DEFAULT_CONTEXT_COMPRESSION_THRESHOLD,
  MAX_CONTEXT_COMPRESSION_THRESHOLD,
  MIN_CONTEXT_COMPRESSION_THRESHOLD
} from '@renderer/lib/agent/context-compression'
import { resolveSessionModelSelection } from '@renderer/lib/session-model-resolution'

function formatContextLength(length?: number): string | null {
  if (!length) return null
  if (length >= 1_000_000)
    return `${(length / 1_000_000).toFixed(length % 1_000_000 === 0 ? 0 : 1)}M`
  if (length >= 1_000) return `${Math.round(length / 1_000)}K`
  return String(length)
}

const MIN_ANTHROPIC_THINKING_BUDGET = 1024
const DEFAULT_ANTHROPIC_THINKING_BUDGET = 10000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatTokenCount(value?: number): string {
  const formatted = formatContextLength(value)
  return formatted ? `${formatted} tokens` : '-'
}

function formatPrice(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  return `$${value.toFixed(2)}/M tokens`
}

function readAnthropicThinkingBudget(model?: AIModelConfig): number | null {
  const thinking = model?.thinkingConfig?.bodyParams.thinking
  if (!isRecord(thinking)) return null
  const value = thinking.budget_tokens
  const numeric =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : null
}

function clampThinkingBudget(value: number, maxOutputTokens?: number): number {
  const upperBound = Math.max(
    MIN_ANTHROPIC_THINKING_BUDGET,
    Math.floor((maxOutputTokens ?? 64_000) - 1)
  )
  return Math.min(upperBound, Math.max(MIN_ANTHROPIC_THINKING_BUDGET, Math.floor(value)))
}

function buildAnthropicThinkingConfigWithBudget(
  config: ThinkingConfig | undefined,
  budget: number
): ThinkingConfig {
  const nextConfig: ThinkingConfig = {
    ...(config ?? { bodyParams: {} }),
    bodyParams: { ...(config?.bodyParams ?? {}) }
  }
  const rawThinking = nextConfig.bodyParams.thinking
  nextConfig.bodyParams.thinking = {
    ...(isRecord(rawThinking) ? rawThinking : {}),
    type: 'enabled',
    budget_tokens: budget
  }
  delete nextConfig.bodyParams.enable_thinking
  return nextConfig
}

function SettingSection({
  accent,
  title,
  children,
  className
}: {
  accent: string
  title: string
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <section className={cn('space-y-2.5', className)}>
      <div className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
        <span className={cn('h-4 w-0.5 rounded-full', accent)} />
        <span>{title}</span>
      </div>
      {children}
    </section>
  )
}

function PillToggle({
  enabled,
  onClick,
  label,
  description,
  activeClassName = 'bg-violet-500 border-violet-500'
}: {
  enabled: boolean
  onClick: () => void
  label: string
  description?: string
  activeClassName?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'flex w-full items-center justify-between rounded-md px-2.5 py-2 text-xs transition-colors',
        enabled ? 'bg-muted/50 text-foreground' : 'text-foreground/75 hover:bg-muted/45'
      )}
      onClick={onClick}
    >
      <span className="flex min-w-0 flex-col text-left">
        <span className="font-medium">{label}</span>
        {description && <span className="text-[10px] text-muted-foreground">{description}</span>}
      </span>
      <span
        className={cn(
          'ml-3 size-4 shrink-0 rounded-full border-2 transition-colors',
          enabled ? activeClassName : 'border-muted-foreground/30'
        )}
      />
    </button>
  )
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

interface ModelSwitcherSessionSnapshot {
  id: string
  pluginId?: string
  providerId?: string
  modelId?: string
  modelSelectionMode?: SessionModelSelectionMode
}

function supportsPriorityServiceTier(model: AIModelConfig | undefined): boolean {
  return !!model?.serviceTier
}

function selectModel(
  provider: AIProvider,
  modelId: string,
  scopedSessionId: string | null,
  setOpen: (v: boolean) => void
): void {
  const pid = provider.id
  const session = scopedSessionId
    ? useChatStore.getState().sessions.find((item) => item.id === scopedSessionId)
    : null

  if (session) {
    useChatStore.getState().setSessionModelManual(session.id, pid, modelId)
    if (session.pluginId) {
      void useChannelStore
        .getState()
        .updateChannel(session.pluginId, { providerId: pid, model: modelId })
    }
  } else {
    const providerStore = useProviderStore.getState()
    if (pid !== providerStore.activeProviderId) providerStore.setActiveProvider(pid)
    providerStore.setActiveModel(modelId)
    useSettingsStore.getState().updateSettings({ mainModelSelectionMode: 'manual' })
  }
  setOpen(false)
}

function selectFastModel(
  provider: AIProvider,
  modelId: string,
  activeFastProviderId: string | null,
  setActiveFastProvider: (id: string) => void,
  setActiveFastModel: (id: string) => void,
  setOpen: (v: boolean) => void
): void {
  const pid = provider.id
  if (pid !== activeFastProviderId) setActiveFastProvider(pid)
  setActiveFastModel(modelId)
  setOpen(false)
}

function selectAutoModel(scopedSessionId: string | null, setOpen: (v: boolean) => void): void {
  const session = scopedSessionId
    ? useChatStore.getState().sessions.find((item) => item.id === scopedSessionId)
    : null
  if (session && !session.pluginId) {
    useChatStore.getState().setSessionModelAuto(session.id)
  } else {
    useSettingsStore.getState().updateSettings({ mainModelSelectionMode: 'auto' })
  }
  setOpen(false)
}

function selectFollowGlobalModel(
  scopedSessionId: string | null,
  setOpen: (v: boolean) => void
): void {
  const session = scopedSessionId
    ? useChatStore.getState().sessions.find((item) => item.id === scopedSessionId)
    : null
  if (session) {
    useChatStore.getState().setSessionModelInherit(session.id)
    if (session.pluginId) {
      void useChannelStore.getState().updateChannel(session.pluginId, {
        providerId: null,
        model: null
      })
    }
  }
  setOpen(false)
}

/** Settings popover shown next to model icon */
function ModelSettingsPopover({
  model,
  providerId,
  providerType,
  providerWebsocketMode,
  t,
  tChat,
  tSettings
}: {
  model: AIModelConfig | undefined
  providerId?: string | null
  providerType?: AIProvider['type']
  providerWebsocketMode?: AIProvider['websocketMode']
  t: (key: string) => string
  tChat: (key: string, opts?: Record<string, unknown>) => string
  tSettings: (key: string, opts?: Record<string, unknown>) => string
}): React.JSX.Element | null {
  const requestType = model?.type ?? providerType
  const supportsThinking = model?.supportsThinking ?? false
  const supportsFastMode = supportsPriorityServiceTier(model)
  const supportsResponsesWebsocket = !!model && requestType === 'openai-responses'
  const supportsResponsesImageGeneration = !!model && requestType === 'openai-responses'
  const supportsContextCompression = !!model
  const levels = model?.thinkingConfig?.reasoningEffortLevels
  const thinkingEnabled = useSettingsStore((s) => s.thinkingEnabled)
  const fastModeEnabled = useSettingsStore((s) => s.fastModeEnabled)
  const reasoningEffort = useSettingsStore((s) => s.reasoningEffort)
  const reasoningEffortByModel = useSettingsStore((s) => s.reasoningEffortByModel)
  const effortKey = getReasoningEffortKey(providerId, model?.id)
  const effectiveReasoningEffort = resolveReasoningEffortForModel({
    reasoningEffort,
    reasoningEffortByModel,
    providerId,
    modelId: model?.id,
    thinkingConfig: model?.thinkingConfig
  })

  const toggleThinking = useCallback(() => {
    const store = useSettingsStore.getState()
    if (!store.thinkingEnabled && levels) {
      store.updateSettings({ thinkingEnabled: true, reasoningEffort: effectiveReasoningEffort })
    } else {
      store.updateSettings({ thinkingEnabled: !store.thinkingEnabled })
    }
  }, [levels, effectiveReasoningEffort])

  const setEffort = useCallback(
    (level: ReasoningEffortLevel) => {
      const store = useSettingsStore.getState()
      store.updateSettings({
        reasoningEffort: level,
        reasoningEffortByModel: effortKey
          ? { ...store.reasoningEffortByModel, [effortKey]: level }
          : store.reasoningEffortByModel,
        thinkingEnabled: true
      })
    },
    [effortKey]
  )

  const supportsAnthropicCacheTtl = requestType === 'anthropic'
  const anthropicCacheTtl = model?.cacheTtl ?? '5m'

  const hasConfigControls =
    supportsThinking ||
    supportsFastMode ||
    supportsResponsesWebsocket ||
    supportsResponsesImageGeneration ||
    supportsContextCompression ||
    supportsAnthropicCacheTtl

  const supportsAnthropicThinkingBudget =
    supportsThinking && requestType === 'anthropic' && !!model?.thinkingConfig
  const thinkingBudgetMax = Math.max(
    MIN_ANTHROPIC_THINKING_BUDGET,
    Math.floor((model?.maxOutputTokens ?? 64_000) - 1)
  )
  const thinkingBudget = clampThinkingBudget(
    readAnthropicThinkingBudget(model) ?? DEFAULT_ANTHROPIC_THINKING_BUDGET,
    model?.maxOutputTokens
  )

  const contextCompressionPercent = Math.round(
    clampCompressionThreshold(
      model?.contextCompressionThreshold ?? DEFAULT_CONTEXT_COMPRESSION_THRESHOLD
    ) * 100
  )

  const updateContextCompressionThreshold = useCallback(
    (value: number) => {
      if (!model?.id) return
      const normalized = clampCompressionThreshold(value / 100)
      const providerStore = useProviderStore.getState()
      const targetProviderId = providerId ?? providerStore.activeProviderId
      if (!targetProviderId) return
      providerStore.updateModel(targetProviderId, model.id, {
        contextCompressionThreshold: normalized
      })
    },
    [model, providerId]
  )

  const updateAnthropicThinkingBudget = useCallback(
    (value: number) => {
      if (!model?.id) return
      const budget = clampThinkingBudget(value, model.maxOutputTokens)
      const providerStore = useProviderStore.getState()
      const targetProviderId = providerId ?? providerStore.activeProviderId
      if (!targetProviderId) return

      providerStore.updateModel(targetProviderId, model.id, {
        supportsThinking: true,
        thinkingConfig: buildAnthropicThinkingConfigWithBudget(model.thinkingConfig, budget)
      })
      useSettingsStore.getState().updateSettings({ thinkingEnabled: true })
    },
    [model, providerId]
  )

  const updateAnthropicCacheTtl = useCallback(
    (ttl: '5m' | '1h') => {
      if (!model?.id) return
      const providerStore = useProviderStore.getState()
      const targetProviderId = providerId ?? providerStore.activeProviderId
      if (!targetProviderId) return
      providerStore.updateModel(targetProviderId, model.id, { cacheTtl: ttl })
    },
    [model, providerId]
  )

  const websocketEnabled = (model?.websocketMode ?? providerWebsocketMode ?? 'auto') !== 'disabled'
  const responsesImageGenerationEnabled = isResponsesImageGenerationEnabled(
    model?.responsesImageGeneration
  )

  const toggleResponsesWebsocket = useCallback(() => {
    if (!model?.id) return
    const providerStore = useProviderStore.getState()
    const targetProviderId = providerId ?? providerStore.activeProviderId
    if (!targetProviderId) return
    providerStore.updateModel(targetProviderId, model.id, {
      websocketMode: websocketEnabled ? 'disabled' : 'auto'
    })
  }, [model, providerId, websocketEnabled])

  const toggleResponsesImageGeneration = useCallback(() => {
    if (!model?.id) return
    const providerStore = useProviderStore.getState()
    const targetProviderId = providerId ?? providerStore.activeProviderId
    if (!targetProviderId) return
    providerStore.updateModel(targetProviderId, model.id, {
      responsesImageGeneration: {
        ...(model.responsesImageGeneration ?? {}),
        enabled: !responsesImageGenerationEnabled
      }
    })
  }, [model, providerId, responsesImageGenerationEnabled])

  const priceRows = [
    { label: tSettings('provider.inputPrice'), value: formatPrice(model?.inputPrice) },
    { label: tSettings('provider.outputPrice'), value: formatPrice(model?.outputPrice) },
    { label: tSettings('provider.cacheHitPrice'), value: formatPrice(model?.cacheHitPrice) }
  ]

  const capabilityItems = [
    {
      enabled: !!model && modelSupportsVision(model, providerType),
      label: t('topbar.vision'),
      icon: <Eye className="size-3" />,
      className: 'bg-lime-500/15 text-lime-500'
    },
    {
      enabled: !!model?.supportsFunctionCall,
      label: t('topbar.tools'),
      icon: <Wrench className="size-3" />,
      className: 'bg-cyan-500/15 text-cyan-500'
    },
    {
      enabled: supportsThinking,
      label: t('topbar.thinking'),
      icon: <Brain className="size-3" />,
      className: 'bg-fuchsia-500/15 text-fuchsia-500'
    },
    {
      enabled: requestType === 'openai-responses',
      label: tSettings('provider.responsesConfig'),
      icon: <Settings2 className="size-3" />,
      className: 'bg-emerald-500/15 text-emerald-500'
    }
  ].filter((item) => item.enabled)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="inline-flex h-8 w-7 items-center justify-center rounded-r-lg border-l border-border/30 text-muted-foreground/50 transition-colors hover:bg-muted/50 hover:text-foreground"
          aria-label={t('topbar.modelSettings')}
          title={t('topbar.modelSettings')}
        >
          <Settings2 className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[388px] overflow-hidden rounded-xl border-border/70 bg-popover/95 p-0 shadow-2xl backdrop-blur"
        align="start"
        side="top"
        sideOffset={8}
      >
        <div className="space-y-4 p-4">
          {!model && (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              {tChat('input.noModelSettings')}
            </div>
          )}

          {model && (
            <>
              <SettingSection accent="bg-blue-500" title={tSettings('provider.contextLength')}>
                <div className="flex items-baseline justify-between px-2">
                  <span className="text-xs text-muted-foreground">{model.name}</span>
                  <span className="text-sm font-semibold text-foreground">
                    {formatTokenCount(model.contextLength)}
                  </span>
                </div>
              </SettingSection>

              <SettingSection accent="bg-violet-500" title={t('topbar.capabilities')}>
                <div className="flex items-center justify-between px-2">
                  <span className="text-xs text-muted-foreground">
                    {capabilityItems.length > 0 ? requestType : '-'}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {capabilityItems.map((item) => (
                      <Tooltip key={item.label}>
                        <TooltipTrigger asChild>
                          <span
                            className={cn(
                              'inline-flex size-6 items-center justify-center rounded-md',
                              item.className
                            )}
                          >
                            {item.icon}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-[11px]">
                          {item.label}
                        </TooltipContent>
                      </Tooltip>
                    ))}
                  </div>
                </div>
              </SettingSection>

              <SettingSection accent="bg-amber-500" title={tSettings('provider.pricing')}>
                <div className="space-y-2 px-2 text-xs">
                  {priceRows.map((row) => (
                    <div key={row.label} className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">{row.label}</span>
                      <span className="text-right font-medium text-foreground/85">{row.value}</span>
                    </div>
                  ))}
                </div>
              </SettingSection>

              <SettingSection accent="bg-emerald-500" title={tSettings('provider.modelConfig')}>
                {!hasConfigControls && (
                  <div className="px-2 py-2 text-xs text-muted-foreground">
                    {tChat('input.noModelSettings')}
                  </div>
                )}

                {supportsThinking && (
                  <PillToggle
                    enabled={thinkingEnabled}
                    onClick={toggleThinking}
                    label={t('topbar.deepThinking')}
                    description={
                      thinkingEnabled
                        ? tChat('input.thinkingLevel', {
                            level: String(effectiveReasoningEffort).toUpperCase()
                          })
                        : tChat('input.thinkingOff')
                    }
                  />
                )}

                {supportsThinking && levels && levels.length > 0 && (
                  <div className={cn('px-2 py-1.5', !thinkingEnabled && 'opacity-60')}>
                    <div className="mb-2 flex items-end justify-between gap-3">
                      <div>
                        <div className="text-xs font-semibold text-foreground">
                          {t('topbar.reasoningEffort')}
                        </div>
                        <div className="text-[10px] text-muted-foreground">reasoning_effort</div>
                      </div>
                    </div>
                    <div
                      className="relative grid gap-1"
                      style={{ gridTemplateColumns: `repeat(${levels.length}, minmax(0, 1fr))` }}
                    >
                      <span className="absolute left-4 right-4 top-2.5 h-px bg-border" />
                      {levels.map((level) => {
                        const active = effectiveReasoningEffort === level && thinkingEnabled
                        return (
                          <button
                            key={level}
                            type="button"
                            className="relative z-10 flex min-w-0 flex-col items-center gap-1 text-[10px]"
                            title={tChat(`input.effortDesc.${level}`)}
                            onClick={() => setEffort(level)}
                          >
                            <span
                              className={cn(
                                'flex size-5 items-center justify-center rounded-full border-2 bg-popover transition-colors',
                                active
                                  ? 'border-violet-400 text-violet-400'
                                  : 'border-border text-muted-foreground'
                              )}
                            >
                              {active && <span className="size-2 rounded-full bg-violet-400" />}
                            </span>
                            <span
                              className={cn(
                                'max-w-full truncate uppercase',
                                active ? 'font-semibold text-foreground' : 'text-muted-foreground'
                              )}
                            >
                              {level}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                {supportsAnthropicThinkingBudget && (
                  <div className="px-2 py-1.5">
                    <div className="mb-2 flex items-end justify-between gap-3">
                      <div>
                        <div className="text-xs font-semibold text-foreground">
                          {tSettings('provider.thinkingBudget')}
                        </div>
                        <div className="text-[10px] text-muted-foreground">budget_tokens</div>
                      </div>
                      <span className="text-xs font-semibold text-foreground">
                        {thinkingBudget.toLocaleString()}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={MIN_ANTHROPIC_THINKING_BUDGET}
                      max={thinkingBudgetMax}
                      step={1}
                      value={thinkingBudget}
                      onChange={(e) => updateAnthropicThinkingBudget(Number(e.target.value))}
                      className="w-full accent-violet-500"
                    />
                    <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                      <span>{MIN_ANTHROPIC_THINKING_BUDGET.toLocaleString()}</span>
                      <span>{thinkingBudgetMax.toLocaleString()}</span>
                    </div>
                  </div>
                )}

                {supportsAnthropicCacheTtl && (
                  <div className="px-2 py-1.5">
                    <div className="mb-2 flex items-end justify-between gap-3">
                      <div>
                        <div className="text-xs font-semibold text-foreground">
                          {tSettings('provider.cacheTtl')}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {tSettings('provider.cacheTtlHint')}
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-1">
                      {(['5m', '1h'] as const).map((ttl) => {
                        const active = anthropicCacheTtl === ttl
                        return (
                          <button
                            key={ttl}
                            type="button"
                            className={cn(
                              'rounded-md border px-2 py-1.5 text-xs font-medium transition-colors',
                              active
                                ? 'border-sky-400 bg-sky-500/10 text-sky-600 dark:text-sky-300'
                                : 'border-border text-muted-foreground hover:bg-muted/50'
                            )}
                            onClick={() => updateAnthropicCacheTtl(ttl)}
                          >
                            {ttl}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                {supportsFastMode && (
                  <PillToggle
                    enabled={fastModeEnabled}
                    onClick={() =>
                      useSettingsStore
                        .getState()
                        .updateSettings({ fastModeEnabled: !fastModeEnabled })
                    }
                    label={t('topbar.fastMode')}
                    description={t('topbar.fastModeDesc')}
                    activeClassName="bg-amber-500 border-amber-500"
                  />
                )}

                {supportsResponsesWebsocket && (
                  <PillToggle
                    enabled={websocketEnabled}
                    onClick={toggleResponsesWebsocket}
                    label={tSettings('provider.responsesWebsocket')}
                    activeClassName="bg-sky-500 border-sky-500"
                  />
                )}

                {supportsResponsesImageGeneration && (
                  <PillToggle
                    enabled={responsesImageGenerationEnabled}
                    onClick={toggleResponsesImageGeneration}
                    label={tSettings('provider.responsesImageGeneration')}
                    activeClassName="bg-emerald-500 border-emerald-500"
                  />
                )}

                {supportsContextCompression && (
                  <div className="px-2 py-1.5">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <span className="text-xs font-semibold text-foreground">
                        {tChat('input.contextCompressionThreshold')}
                      </span>
                      <span className="text-xs font-semibold text-foreground">
                        {contextCompressionPercent}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={Math.round(MIN_CONTEXT_COMPRESSION_THRESHOLD * 100)}
                      max={Math.round(MAX_CONTEXT_COMPRESSION_THRESHOLD * 100)}
                      step={1}
                      value={contextCompressionPercent}
                      onChange={(e) => updateContextCompressionThreshold(Number(e.target.value))}
                      className="w-full accent-sky-500"
                    />
                  </div>
                )}
              </SettingSection>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function ModelSwitcher({
  modelRoute = 'main',
  sessionId
}: {
  modelRoute?: 'main' | 'fast'
  /**
   * Session this composer writes to. `null` means a new/draft session (home or
   * project home) — selections should target the global model so the freshly
   * created session inherits them. When omitted, falls back to the active session.
   */
  sessionId?: string | null
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const { t: tChat } = useTranslation('chat')
  const { t: tSettings } = useTranslation('settings')
  const isFastRoute = modelRoute === 'fast'
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const autoModelRef = useRef<HTMLButtonElement>(null)
  const activeModelRef = useRef<HTMLButtonElement>(null)
  const hasAutoScrolledToSelectionRef = useRef(false)
  const activeProviderId = useProviderStore((s) => s.activeProviderId)
  const activeModelId = useProviderStore((s) => s.activeModelId)
  const activeFastProviderId = useProviderStore((s) => s.activeFastProviderId)
  const activeFastModelId = useProviderStore((s) => s.activeFastModelId)
  const providers = useProviderStore((s) => s.providers)
  const setActiveFastProvider = useProviderStore((s) => s.setActiveFastProvider)
  const setActiveFastModel = useProviderStore((s) => s.setActiveFastModel)
  const fastSelection = useProviderStore(
    useShallow((s) => {
      if (!isFastRoute) return { providerId: null as string | null, modelId: '' }
      const config = s.getFastProviderConfig()
      return {
        providerId: config?.providerId ?? null,
        modelId: config?.model ?? ''
      }
    })
  )
  const quotaByKey = useQuotaStore((s) => s.quotaByKey)
  const fallbackActiveSessionId = useChatStore((s) => s.activeSessionId)
  const activeSessionId = sessionId !== undefined ? sessionId : fallbackActiveSessionId
  const activeSession = useChatStore(
    useShallow((s): ModelSwitcherSessionSnapshot | null => {
      if (!activeSessionId) return null
      const indexed = s.sessionsById[activeSessionId]
      const session =
        indexed !== undefined && s.sessions[indexed]?.id === activeSessionId
          ? s.sessions[indexed]
          : s.sessions.find((item) => item.id === activeSessionId)
      if (!session) return null
      return {
        id: session.id,
        pluginId: session.pluginId,
        providerId: session.providerId,
        modelId: session.modelId,
        modelSelectionMode: session.modelSelectionMode
      }
    })
  )
  const activeChannelModelBinding = useChannelStore(
    useShallow((s) => {
      if (!activeSession?.pluginId) return { providerId: null, modelId: null }
      const channel = s.channels.find((item) => item.id === activeSession.pluginId)
      return {
        providerId: channel?.providerId ?? null,
        modelId: channel?.model ?? null
      }
    })
  )
  const mainModelSelectionMode = useSettingsStore((s) => s.mainModelSelectionMode)
  const { autoSelection, autoRoutingState } = useUIStore(
    useShallow((s) => ({
      autoSelection: activeSessionId
        ? (s.autoModelSelectionsBySession[activeSessionId] ?? null)
        : null,
      autoRoutingState: activeSessionId
        ? (s.autoModelRoutingStatesBySession[activeSessionId] ?? 'idle')
        : 'idle'
    }))
  )

  const enabledProviders = useMemo(
    () => (open ? providers.filter((p) => isProviderAvailableForModelSelection(p)) : []),
    [open, providers]
  )
  const sessionModelSelection = resolveSessionModelSelection({
    session: activeSession,
    providers,
    activeProviderId,
    activeModelId,
    globalMode: mainModelSelectionMode,
    channelProviderId: activeChannelModelBinding.providerId,
    channelModelId: activeChannelModelBinding.modelId
  })
  const displayProviderId = isFastRoute
    ? (fastSelection.providerId ?? activeFastProviderId ?? activeProviderId)
    : sessionModelSelection.providerId
  const displayModelId = isFastRoute
    ? fastSelection.modelId || activeFastModelId || activeModelId
    : sessionModelSelection.modelId
  const displayProvider = providers.find((p) => p.id === displayProviderId)
  const displayModel = displayProvider?.models.find((m) => m.id === displayModelId)
  const isAutoModeActive = !isFastRoute && sessionModelSelection.isAutoModeActive
  const isExplicitAutoActive =
    !isFastRoute &&
    (activeSession
      ? !activeSession.pluginId && sessionModelSelection.mode === 'auto'
      : mainModelSelectionMode === 'auto')
  const isFollowGlobalActive =
    !isFastRoute && Boolean(activeSession) && sessionModelSelection.mode === 'inherit'
  const autoResolvedProvider = autoSelection?.providerId
    ? providers.find((provider) => provider.id === autoSelection.providerId)
    : null
  const autoResolvedModel = autoResolvedProvider?.models.find(
    (model) => model.id === autoSelection?.modelId
  )
  const settingsProviderId = isAutoModeActive ? autoResolvedProvider?.id : displayProvider?.id
  const settingsModel = isAutoModeActive ? (autoResolvedModel ?? undefined) : displayModel
  const triggerLabel = isAutoModeActive
    ? autoRoutingState === 'routing'
      ? t('topbar.autoModel')
      : (autoSelection?.modelName ?? t('topbar.autoModel'))
    : (displayModel?.name ?? displayModelId ?? t('topbar.noModel'))
  const triggerAriaLabel = isAutoModeActive
    ? autoRoutingState === 'routing'
      ? t('topbar.autoModelRoutingShort')
      : t('topbar.autoModel')
    : (displayModel?.name ?? displayModelId ?? t('topbar.noModel'))
  const triggerProviderName = isAutoModeActive
    ? (autoResolvedProvider?.name ?? t('topbar.autoModel'))
    : (displayProvider?.name ?? null)
  const triggerModel = isAutoModeActive ? (autoResolvedModel ?? null) : (displayModel ?? null)
  const triggerProviderType = isAutoModeActive ? autoResolvedProvider?.type : displayProvider?.type
  const triggerDetail = isAutoModeActive
    ? autoRoutingState === 'routing'
      ? t('topbar.autoModelRouting')
      : autoSelection?.modelName
        ? t('topbar.autoModelTooltip', {
            route: t(
              autoSelection.target === 'main' ? 'topbar.autoModelMain' : 'topbar.autoModelFast'
            ),
            model: autoSelection.modelName,
            taskType: autoSelection.taskType ?? t('topbar.autoModelTaskTypeUnknown'),
            confidence: autoSelection.confidence ?? t('topbar.autoModelConfidenceUnknown'),
            complexity: autoSelection.complexity
              ? t(`topbar.autoModelComplexity.${autoSelection.complexity}`)
              : '',
            risk: autoSelection.risk ? t(`topbar.autoModelRisk.${autoSelection.risk}`) : '',
            reason: autoSelection.fallbackReason
              ? t(`topbar.autoModelFallback.${autoSelection.fallbackReason}`, {
                  defaultValue: autoSelection.fallbackReason
                })
              : ''
          })
        : t('topbar.autoModelTooltipIdle')
    : displayModelId && displayModel?.name && displayModel.name !== displayModelId
      ? displayModelId
      : null

  const codexQuota = useMemo(() => {
    if (!displayProvider || displayProvider.builtinId !== 'codex-oauth') return null
    const quota =
      quotaByKey[displayProvider.id] ||
      (displayProvider.builtinId ? quotaByKey[displayProvider.builtinId] : undefined) ||
      quotaByKey['codex'] ||
      null
    return quota?.type === 'codex' ? quota : null
  }, [displayProvider, quotaByKey])

  const copilotQuota = useMemo(() => {
    if (!displayProvider || displayProvider.builtinId !== 'copilot-oauth') return null
    const quota =
      quotaByKey[displayProvider.id] ||
      (displayProvider.builtinId ? quotaByKey[displayProvider.builtinId] : undefined) ||
      quotaByKey['copilot'] ||
      null
    return quota?.type === 'copilot' ? quota : null
  }, [displayProvider, quotaByKey])

  const formatPercent = (value?: number): string => {
    if (value === undefined || Number.isNaN(value)) return '0%'
    return `${Math.round(value)}%`
  }

  const formatResetAt = (value?: string): string => {
    if (!value) return ''
    const trimmed = value.trim()
    if (!trimmed) return ''
    if (['invalid date', 'null', 'undefined', 'nan'].includes(trimmed.toLowerCase())) return ''

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

    if (!parsed) return ''

    return parsed.toLocaleString([], {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  const groups = useMemo<ProviderGroup[]>(() => {
    if (!open) return []
    const q = search.toLowerCase().trim()
    return enabledProviders
      .map((provider) => {
        const models = provider.models.filter((m) => {
          if (!m.enabled) return false
          if (isFastRoute && (m.category ?? 'chat') !== 'chat') return false
          if (!q) return true
          const name = (m.name || m.id).toLowerCase()
          return name.includes(q) || provider.name.toLowerCase().includes(q)
        })
        return { provider, models }
      })
      .filter((g) => g.models.length > 0)
  }, [enabledProviders, isFastRoute, open, search])
  const selectedGroup = useMemo(
    () =>
      selectedProviderId
        ? (groups.find((group) => group.provider.id === selectedProviderId) ?? null)
        : null,
    [groups, selectedProviderId]
  )

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen)
    setSelectedProviderId(null)
  }, [])

  useEffect(() => {
    if (!open) {
      hasAutoScrolledToSelectionRef.current = false
      return
    }

    const timer = setTimeout(() => {
      setSearch('')
      searchRef.current?.focus()
    }, 50)

    return () => clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (
      !open ||
      !selectedGroup ||
      isAutoModeActive ||
      search.trim() ||
      hasAutoScrolledToSelectionRef.current
    ) {
      return
    }

    const timer = setTimeout(() => {
      const target = activeModelRef.current
      const container = listRef.current
      if (!target || !container) return

      const containerRect = container.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      const offsetTop = targetRect.top - containerRect.top + container.scrollTop
      const scrollTop = offsetTop - container.clientHeight / 2 + targetRect.height / 2

      container.scrollTo({
        top: Math.max(0, scrollTop),
        behavior: 'auto'
      })
      hasAutoScrolledToSelectionRef.current = true
    }, 0)

    return () => clearTimeout(timer)
  }, [open, search, selectedGroup, isAutoModeActive])

  return (
    <div className="inline-flex h-8 items-center rounded-lg border border-transparent hover:border-border/50 hover:bg-muted/30 transition-colors">
      {/* Model icon trigger — opens model list */}
      <Popover open={open} onOpenChange={handleOpenChange}>
        <HoverCard openDelay={180} closeDelay={100}>
          <HoverCardTrigger asChild>
            <PopoverTrigger asChild>
              <button
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-l-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                aria-label={triggerAriaLabel}
              >
                {isAutoModeActive ? (
                  autoRoutingState === 'routing' ? (
                    <Loader2 size={16} className="animate-spin text-amber-500" />
                  ) : (
                    <AutoModelIcon size={18} />
                  )
                ) : (
                  <ModelIcon
                    icon={displayModel?.icon}
                    modelId={displayModelId ?? undefined}
                    providerBuiltinId={displayProvider?.builtinId}
                    size={20}
                  />
                )}
              </button>
            </PopoverTrigger>
          </HoverCardTrigger>
          <HoverCardContent side="top" align="start" className="w-72 p-3">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted/45">
                {isAutoModeActive ? (
                  autoRoutingState === 'routing' ? (
                    <Loader2 size={16} className="animate-spin text-amber-500" />
                  ) : (
                    <AutoModelIcon size={18} />
                  )
                ) : (
                  <ModelIcon
                    icon={displayModel?.icon}
                    modelId={displayModelId ?? undefined}
                    providerBuiltinId={displayProvider?.builtinId}
                    size={20}
                  />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-foreground">{triggerLabel}</div>
                {triggerProviderName && (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {triggerProviderName}
                  </div>
                )}
              </div>
            </div>
            {triggerDetail && (
              <div className="mt-2 break-words text-[11px] leading-4 text-muted-foreground/85">
                {triggerDetail}
              </div>
            )}
            {triggerModel && (
              <div className="mt-2 border-t border-border/60 pt-2">
                <ModelCapabilityTags
                  model={triggerModel}
                  providerType={triggerProviderType}
                  t={t}
                />
              </div>
            )}
          </HoverCardContent>
        </HoverCard>
        <PopoverContent
          className="w-64 max-w-[calc(100vw-2rem)] overflow-visible p-0"
          align="start"
          sideOffset={8}
        >
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
          {!isFastRoute && activeSession && (
            <div className="border-b p-1">
              <button
                className={cn(
                  'flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left hover:bg-muted/60 transition-colors group',
                  isFollowGlobalActive && 'bg-primary/5'
                )}
                onClick={() => selectFollowGlobalModel(activeSessionId, setOpen)}
              >
                <span className="mt-0.5 flex size-5 items-center justify-center shrink-0">
                  {isFollowGlobalActive ? (
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary/10">
                      <Check className="size-3 text-primary" />
                    </span>
                  ) : (
                    <Globe2 size={18} />
                  )}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span
                    className={cn(
                      'truncate text-xs',
                      isFollowGlobalActive
                        ? 'font-semibold text-primary'
                        : 'text-foreground/80 group-hover:text-foreground'
                    )}
                  >
                    {t('topbar.followGlobalModel', {
                      defaultValue: 'Follow global model'
                    })}
                  </span>
                  <span className="line-clamp-2 text-[10px] text-muted-foreground">
                    {t('topbar.followGlobalModelDesc', {
                      defaultValue: 'Use the global main model setting for this session.'
                    })}
                  </span>
                </div>
              </button>
            </div>
          )}
          {!isFastRoute && !activeSession?.pluginId && (
            <div className="border-b p-1">
              <button
                ref={autoModelRef}
                className={cn(
                  'flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left hover:bg-muted/60 transition-colors group',
                  isExplicitAutoActive && 'bg-primary/5'
                )}
                onClick={() => selectAutoModel(activeSessionId, setOpen)}
              >
                <span className="mt-0.5 flex size-5 items-center justify-center shrink-0">
                  {isExplicitAutoActive ? (
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
                      isExplicitAutoActive
                        ? 'font-semibold text-primary'
                        : 'text-foreground/80 group-hover:text-foreground'
                    )}
                  >
                    {t('topbar.autoModel')}
                  </span>
                  <span className="line-clamp-2 text-[10px] text-muted-foreground">
                    {autoRoutingState === 'routing'
                      ? t('topbar.autoModelRouting')
                      : autoSelection?.modelName
                        ? t('topbar.autoModelTooltip', {
                            route: t(
                              autoSelection.target === 'main'
                                ? 'topbar.autoModelMain'
                                : 'topbar.autoModelFast'
                            ),
                            model: autoSelection.modelName,
                            taskType:
                              autoSelection.taskType ?? t('topbar.autoModelTaskTypeUnknown'),
                            confidence:
                              autoSelection.confidence ?? t('topbar.autoModelConfidenceUnknown'),
                            complexity: autoSelection.complexity
                              ? t(`topbar.autoModelComplexity.${autoSelection.complexity}`)
                              : '',
                            risk: autoSelection.risk
                              ? t(`topbar.autoModelRisk.${autoSelection.risk}`)
                              : '',
                            reason: autoSelection.fallbackReason
                              ? t(`topbar.autoModelFallback.${autoSelection.fallbackReason}`, {
                                  defaultValue: autoSelection.fallbackReason
                                })
                              : ''
                          })
                        : t('topbar.autoModelDesc')}
                  </span>
                </div>
              </button>
            </div>
          )}
          <div className="p-1">
            <div className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
              {t('topbar.providers')}
            </div>
            <div className="max-h-[328px] overflow-y-auto">
              {groups.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground/50">
                  {enabledProviders.length === 0 ? t('topbar.noProviders') : t('topbar.noModels')}
                </div>
              ) : (
                groups.map(({ provider, models }) => {
                  const isSelected = provider.id === selectedGroup?.provider.id
                  const isDisplayProvider = provider.id === displayProviderId && !isAutoModeActive
                  return (
                    <Popover
                      key={provider.id}
                      open={selectedProviderId === provider.id}
                      onOpenChange={(nextOpen) => {
                        if (nextOpen) setSelectedProviderId(provider.id)
                      }}
                    >
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className={cn(
                            'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted/70',
                            isSelected && 'bg-background shadow-sm',
                            isDisplayProvider && !isSelected && 'text-primary'
                          )}
                          onFocus={() => setSelectedProviderId(provider.id)}
                          onMouseEnter={() => setSelectedProviderId(provider.id)}
                          onClick={() => setSelectedProviderId(provider.id)}
                        >
                          <ProviderIcon builtinId={provider.builtinId} size={16} />
                          <span className="min-w-0 flex-1 truncate text-xs font-medium">
                            {provider.name}
                          </span>
                          <span
                            className={cn(
                              'rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground',
                              isDisplayProvider && 'bg-primary/10 text-primary'
                            )}
                          >
                            {models.length}
                          </span>
                        </button>
                      </PopoverTrigger>
                      <PopoverContent
                        className="w-80 max-w-[calc(100vw-2rem)] overflow-hidden p-1"
                        align="start"
                        side="right"
                        sideOffset={6}
                      >
                        <div className="sticky top-0 z-10 mb-1 flex items-center gap-2 border-b bg-popover/95 px-2 py-1.5 backdrop-blur">
                          <ProviderIcon builtinId={provider.builtinId} size={14} />
                          <span className="min-w-0 flex-1 truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                            {provider.name}
                          </span>
                          <span className="shrink-0 text-[10px] text-muted-foreground/50">
                            {t('topbar.modelsCount', { count: models.length })}
                          </span>
                        </div>
                        <div
                          ref={selectedProviderId === provider.id ? listRef : undefined}
                          className="max-h-[344px] overflow-y-auto"
                        >
                          {models.map((m) => {
                            const isActive =
                              !isAutoModeActive &&
                              provider.id === displayProviderId &&
                              m.id === displayModelId
                            return (
                              <button
                                key={`${provider.id}-${m.id}`}
                                ref={isActive ? activeModelRef : undefined}
                                className={cn(
                                  'flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted/60 group',
                                  isActive && 'bg-primary/5'
                                )}
                                onClick={() =>
                                  isFastRoute
                                    ? selectFastModel(
                                        provider,
                                        m.id,
                                        activeFastProviderId,
                                        setActiveFastProvider,
                                        setActiveFastModel,
                                        setOpen
                                      )
                                    : selectModel(provider, m.id, activeSessionId, setOpen)
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
                                  <ModelCapabilityTags
                                    model={m}
                                    providerType={provider.type}
                                    t={t}
                                  />
                                </div>
                              </button>
                            )
                          })}
                        </div>
                      </PopoverContent>
                    </Popover>
                  )
                })
              )}
            </div>
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
                  {formatResetAt(codexQuota.primary?.resetAt)}
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
      {copilotQuota && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/30 border border-border/10 cursor-help hover:bg-muted/50 transition-colors mx-1">
              <MonitorSmartphone className="size-3 text-sky-500" />
              <div className="flex flex-col leading-none gap-0.5">
                <span className="text-[9px] text-muted-foreground/70 font-medium">
                  {copilotQuota.sku || 'copilot'}
                </span>
                <span className="text-[9px] text-muted-foreground/50">
                  {copilotQuota.chatEnabled
                    ? tSettings('provider.copilotChatEnabled')
                    : tSettings('provider.copilotChatDisabled')}
                </span>
              </div>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="p-3 w-56 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                {tSettings('provider.copilotQuotaSku')}
              </span>
              <span className="text-xs font-bold">{copilotQuota.sku || '-'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                {tSettings('provider.copilotQuotaChat')}
              </span>
              <span className="text-xs font-bold">
                {copilotQuota.chatEnabled
                  ? tSettings('provider.copilotChatEnabled')
                  : tSettings('provider.copilotChatDisabled')}
              </span>
            </div>
            {copilotQuota.tokenExpiresAt && (
              <div className="flex items-center justify-between gap-2 border-t pt-2">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                  {tSettings('provider.copilotQuotaTokenExpires')}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {new Date(copilotQuota.tokenExpiresAt).toLocaleString([], {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                  })}
                </span>
              </div>
            )}
          </TooltipContent>
        </Tooltip>
      )}

      {/* Settings icon — model config popover */}
      <ModelSettingsPopover
        model={settingsModel}
        providerId={settingsProviderId}
        providerType={isAutoModeActive ? autoResolvedProvider?.type : displayProvider?.type}
        providerWebsocketMode={
          isAutoModeActive ? autoResolvedProvider?.websocketMode : displayProvider?.websocketMode
        }
        t={t}
        tChat={tChat}
        tSettings={tSettings}
      />
    </div>
  )
}
