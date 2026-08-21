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
  Globe2,
  Expand,
  Zap,
  Cable,
  Timer,
  ChevronDown,
  X,
  Image as ImageIcon
} from 'lucide-react'
import {
  isProviderAvailableForModelSelection,
  useProviderStore,
  modelSupportsVision,
  modelSupportsBuiltinSearch,
  modelSupportsGptLongContext,
  modelSupportsResponsesWebsocket,
  modelSupportsResponsesImageGeneration,
  isGptLongContextEnabled,
  resolveEffectiveModelContextLength,
  resolveModelThinkingConfig
} from '@renderer/stores/provider-store'
import {
  useSettingsStore,
  getReasoningEffortKey,
  resolveReasoningEffortForModel
} from '@renderer/stores/settings-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useChannelStore } from '@renderer/stores/channel-store'
import { useQuotaStore } from '@renderer/stores/quota-store'

import { useTranslation } from 'react-i18next'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'

import { ProviderIcon, ModelIcon } from '@renderer/components/settings/provider-icons'
import { cn } from '@renderer/lib/utils'
import type {
  AIModelConfig,
  AIProvider,
  ReasoningEffortLevel,
  ThinkingConfig
} from '@renderer/lib/api/types'
import {
  hasOffPeakPricing,
  resolveModelPricingBrackets,
  type ModelPricingBracket
} from '@renderer/lib/model-pricing'
import { isResponsesImageGenerationEnabled } from '@renderer/lib/api/responses-image-generation'
import { resolveSessionModelSelection } from '@renderer/lib/session-model-resolution'
import { ReasoningEffortSlider } from './ReasoningEffortSlider'

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
  const digits = value < 0.01 ? 4 : value < 0.1 ? 3 : 2
  const text =
    value < 0.1
      ? value
          .toFixed(digits)
          .replace(/(\.\d*?)0+$/, '$1')
          .replace(/\.$/, '')
      : value.toFixed(2)
  return `$${text}/M tokens`
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
    <section className={cn('space-y-2', className)}>
      <div className="flex items-center gap-2 text-[11px] font-semibold text-muted-foreground/80">
        <span className={cn('h-3.5 w-1 rounded-full', accent)} />
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
  description
}: {
  enabled: boolean
  onClick: () => void
  label: string
  description?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      className={cn(
        'flex w-full items-center justify-between gap-3 rounded-xl border p-2.5 text-xs transition-all cursor-pointer',
        enabled
          ? 'border-violet-500/30 bg-violet-500/10 text-foreground shadow-2xs'
          : 'border-border/50 bg-muted/20 text-foreground/80 hover:bg-muted/40 hover:text-foreground'
      )}
      onClick={onClick}
    >
      <span className="flex min-w-0 flex-col text-left">
        <span className="font-medium text-xs">{label}</span>
        {description && <span className="text-[10px] text-muted-foreground">{description}</span>}
      </span>
      <span
        className={cn(
          'flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors duration-200',
          enabled ? 'bg-violet-500' : 'bg-muted-foreground/25'
        )}
      >
        <span
          className={cn(
            'size-3.5 rounded-full bg-white shadow-xs transition-transform duration-200',
            enabled ? 'translate-x-[16px]' : 'translate-x-0.5'
          )}
        />
      </span>
    </button>
  )
}

type CapabilityTone = 'teal' | 'orange' | 'sky' | 'amber' | 'emerald'

const CAPABILITY_TONE: Record<CapabilityTone, { icon: string; track: string; chip: string }> = {
  teal: {
    icon: 'bg-teal-500/15 text-teal-600 dark:text-teal-300',
    track: 'bg-teal-500',
    chip: 'border-teal-500/40 bg-teal-500/10 text-teal-700 dark:text-teal-300'
  },
  orange: {
    icon: 'bg-orange-500/15 text-orange-600 dark:text-orange-300',
    track: 'bg-orange-500',
    chip: 'border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-300'
  },
  sky: {
    icon: 'bg-sky-500/15 text-sky-600 dark:text-sky-300',
    track: 'bg-sky-500',
    chip: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300'
  },
  amber: {
    icon: 'bg-amber-500/15 text-amber-600 dark:text-amber-300',
    track: 'bg-amber-500',
    chip: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
  },
  emerald: {
    icon: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
    track: 'bg-emerald-500',
    chip: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  }
}

/** Grouped list container — one visual card so capabilities read as a single set. */
function CapabilityCard({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border/50 bg-muted/20 dark:bg-white/[0.02]">
      {children}
    </div>
  )
}

function CapabilityIcon({
  tone,
  enabled,
  children
}: {
  tone: CapabilityTone
  enabled: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-md transition-colors',
        enabled ? CAPABILITY_TONE[tone].icon : 'bg-muted/70 text-muted-foreground/70'
      )}
    >
      {children}
    </span>
  )
}

/** Toggle row: icon · label + state description · switch. */
function CapabilityRow({
  tone,
  icon,
  label,
  description,
  enabled,
  onClick
}: {
  tone: CapabilityTone
  icon: React.ReactNode
  label: string
  description?: string
  enabled: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      title={description ? `${label} · ${description}` : label}
      className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left transition-colors hover:bg-muted/40 dark:hover:bg-white/[0.04]"
      onClick={onClick}
    >
      <CapabilityIcon tone={tone} enabled={enabled}>
        {icon}
      </CapabilityIcon>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground">{label}</span>
        {description && (
          <span className="mt-px block truncate text-[10px] leading-4 text-muted-foreground">
            {description}
          </span>
        )}
      </span>
      <span
        aria-hidden
        className={cn(
          'flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors duration-200 motion-reduce:transition-none',
          enabled ? CAPABILITY_TONE[tone].track : 'bg-muted-foreground/25'
        )}
      >
        <span
          className={cn(
            'size-3.5 rounded-full bg-white shadow-sm transition-transform duration-200 motion-reduce:transition-none',
            enabled ? 'translate-x-[16px]' : 'translate-x-0.5'
          )}
        />
      </span>
    </button>
  )
}

/** Row with a discrete choice instead of on/off. */
function CapabilityChoiceRow<T extends string>({
  tone,
  icon,
  label,
  description,
  options,
  value,
  onChange
}: {
  tone: CapabilityTone
  icon: React.ReactNode
  label: string
  description?: string
  options: readonly T[]
  value: T
  onChange: (value: T) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5 px-2.5 py-2">
      <CapabilityIcon tone={tone} enabled>
        {icon}
      </CapabilityIcon>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground">{label}</span>
        {description && (
          <span className="mt-px block truncate text-[10px] leading-4 text-muted-foreground">
            {description}
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted/60 p-0.5 dark:bg-white/[0.05]">
        {options.map((option) => {
          const active = option === value
          return (
            <button
              key={option}
              type="button"
              aria-pressed={active}
              className={cn(
                'rounded-[5px] px-2 py-1 text-[11px] font-medium transition-colors',
                active
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => onChange(option)}
            >
              {option}
            </button>
          )
        })}
      </span>
    </div>
  )
}

/** Compact flag toggle — wraps naturally, so a lone flag never looks orphaned. */
function CapabilityChip({
  tone,
  icon,
  label,
  hint,
  enabled,
  onClick
}: {
  tone: CapabilityTone
  icon: React.ReactNode
  label: string
  hint?: string
  enabled: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      title={hint ? `${label} · ${hint}` : label}
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[11px] font-medium transition-colors',
        enabled
          ? CAPABILITY_TONE[tone].chip
          : 'border-border/60 text-muted-foreground hover:border-border hover:text-foreground'
      )}
      onClick={onClick}
    >
      <span className={cn('shrink-0', !enabled && 'opacity-70')}>{icon}</span>
      <span className="truncate">{label}</span>
      <span
        aria-hidden
        className={cn(
          'size-1.5 shrink-0 rounded-full transition-colors',
          enabled ? 'bg-current' : 'bg-muted-foreground/30'
        )}
      />
    </button>
  )
}

function ModelCapabilityTags({
  model,
  providerType,
  t,
  showContext = true
}: {
  model: AIModelConfig
  providerType?: AIProvider['type']
  t: (key: string) => string
  showContext?: boolean
}): React.JSX.Element {
  const ctx = formatContextLength(resolveEffectiveModelContextLength(model))
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
      {showContext && ctx && (
        <span className="inline-flex items-center rounded-sm bg-muted/60 px-1 py-px text-[9px] font-medium text-muted-foreground">
          {ctx}
        </span>
      )}
    </div>
  )
}

interface PriceRow {
  label: string
  value: string
}

/** Human range for a bracket, e.g. "< 512K" / "512K – 1M" / "≥ 512K". */
function formatBracketRange(bracket: ModelPricingBracket): string {
  const floor = formatContextLength(bracket.minPromptTokens)
  const ceiling = formatContextLength(bracket.maxPromptTokens ?? undefined)
  if (bracket.minPromptTokens <= 0) return ceiling ? `< ${ceiling}` : '—'
  if (!ceiling) return `≥ ${floor}`
  return `${floor} – ${ceiling}`
}

function buildBracketPriceRows(
  bracket: ModelPricingBracket,
  tSettings: (key: string, opts?: Record<string, unknown>) => string
): PriceRow[] {
  return [
    {
      label: tSettings('provider.inputPrice'),
      value: formatPrice(bracket.inputPrice ?? undefined)
    },
    {
      label: tSettings('provider.outputPrice'),
      value: formatPrice(bracket.outputPrice ?? undefined)
    },
    {
      label: tSettings('provider.cacheCreationPrice'),
      value: formatPrice(bracket.cacheCreationPrice ?? undefined)
    },
    {
      label: tSettings('provider.cacheHitPrice'),
      value: formatPrice(bracket.cacheHitPrice ?? undefined)
    }
  ].filter((row) => row.value !== '-')
}

function PriceRowGrid({ rows }: { rows: PriceRow[] }): React.JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-1">
      {rows.map((row) => (
        <div key={row.label} className="flex min-w-0 items-center justify-between gap-2">
          <span className="truncate text-[10px] text-muted-foreground">{row.label}</span>
          <span className="shrink-0 text-[10px] font-semibold text-foreground/85">
            {row.value.replace('/M tokens', '')}
          </span>
        </div>
      ))}
    </div>
  )
}

function ModelHoverDetails({
  model,
  tSettings
}: {
  model: AIModelConfig
  tSettings: (key: string, opts?: Record<string, unknown>) => string
}): React.JSX.Element | null {
  const contextRows = [
    {
      label: tSettings('provider.contextLength'),
      value: formatTokenCount(resolveEffectiveModelContextLength(model))
    },
    {
      label: tSettings('provider.maxOutputTokens'),
      value: formatTokenCount(model.maxOutputTokens)
    }
  ].filter((row) => row.value !== '-')

  // Tier-priced models show the whole ladder instead of a single rate set.
  const pricingBrackets = resolveModelPricingBrackets(model)
    .map((bracket) => ({ bracket, rows: buildBracketPriceRows(bracket, tSettings) }))
    .filter((entry) => entry.rows.length > 0)

  const priceRows = (
    pricingBrackets.length > 0
      ? []
      : hasOffPeakPricing(model)
        ? [
            {
              label: `${tSettings('provider.inputPrice')} · ${tSettings('provider.peakPricing')}`,
              value: formatPrice(model.inputPrice)
            },
            {
              label: `${tSettings('provider.inputPrice')} · ${tSettings('provider.offPeakPricing')}`,
              value: formatPrice(model.offPeakInputPrice)
            },
            {
              label: `${tSettings('provider.outputPrice')} · ${tSettings('provider.peakPricing')}`,
              value: formatPrice(model.outputPrice)
            },
            {
              label: `${tSettings('provider.outputPrice')} · ${tSettings('provider.offPeakPricing')}`,
              value: formatPrice(model.offPeakOutputPrice)
            },
            {
              label: `${tSettings('provider.cacheCreationPrice')} · ${tSettings('provider.peakPricing')}`,
              value: formatPrice(model.cacheCreationPrice)
            },
            {
              label: `${tSettings('provider.cacheCreationPrice')} · ${tSettings('provider.offPeakPricing')}`,
              value: formatPrice(model.offPeakCacheCreationPrice)
            },
            {
              label: `${tSettings('provider.cacheHitPrice')} · ${tSettings('provider.peakPricing')}`,
              value: formatPrice(model.cacheHitPrice)
            },
            {
              label: `${tSettings('provider.cacheHitPrice')} · ${tSettings('provider.offPeakPricing')}`,
              value: formatPrice(model.offPeakCacheHitPrice)
            }
          ]
        : [
            { label: tSettings('provider.inputPrice'), value: formatPrice(model.inputPrice) },
            { label: tSettings('provider.outputPrice'), value: formatPrice(model.outputPrice) },
            {
              label: tSettings('provider.cacheCreationPrice'),
              value: formatPrice(model.cacheCreationPrice)
            },
            { label: tSettings('provider.cacheHitPrice'), value: formatPrice(model.cacheHitPrice) }
          ]
  ).filter((row) => row.value !== '-')

  if (contextRows.length === 0 && priceRows.length === 0 && pricingBrackets.length === 0)
    return null

  return (
    <div className="mt-3 space-y-2 border-t border-border/60 pt-2">
      {contextRows.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {contextRows.map((row) => (
            <div key={row.label} className="min-w-0 rounded-md bg-muted/35 px-2 py-1.5">
              <div className="truncate text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">
                {row.label}
              </div>
              <div className="mt-0.5 truncate text-[11px] font-semibold text-foreground/90">
                {row.value}
              </div>
            </div>
          ))}
        </div>
      )}

      {priceRows.length > 0 && (
        <div className="space-y-1.5 rounded-md bg-muted/25 px-2 py-1.5">
          <div className="flex items-center justify-between gap-2 text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">
            <span>{tSettings('provider.pricing')}</span>
            <span className="normal-case tracking-normal">{tSettings('provider.pricingUnit')}</span>
          </div>
          <PriceRowGrid rows={priceRows} />
        </div>
      )}

      {pricingBrackets.length > 0 && (
        <div className="space-y-1.5 rounded-md bg-muted/25 px-2 py-1.5">
          <div className="flex items-center justify-between gap-2 text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">
            <span>
              {tSettings('provider.pricing')} ·{' '}
              {tSettings('provider.pricingTiers', { defaultValue: 'Tiered' })}
            </span>
            <span className="normal-case tracking-normal">{tSettings('provider.pricingUnit')}</span>
          </div>
          <div className="space-y-1">
            {pricingBrackets.map(({ bracket, rows }) => (
              <div
                key={bracket.minPromptTokens}
                className="rounded-[5px] bg-background/45 px-1.5 py-1 dark:bg-white/[0.04]"
              >
                <div className="text-[10px] font-semibold tabular-nums text-foreground/75">
                  {formatBracketRange(bracket)}
                </div>
                <div className="mt-0.5">
                  <PriceRowGrid rows={rows} />
                </div>
              </div>
            ))}
          </div>
          <div className="text-[9px] leading-3 text-muted-foreground/70">
            {tSettings('provider.pricingTierHint', {
              defaultValue: 'Bracket picked by prompt size (input + cache tokens) per request.'
            })}
          </div>
        </div>
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

/** Settings popover shown next to model icon */
function ModelSettingsPopover({
  model,
  providerId,
  providerType,
  providerWebsocketMode,
  side = 'top',
  t,
  tChat,
  tSettings
}: {
  model: AIModelConfig | undefined
  providerId?: string | null
  providerType?: AIProvider['type']
  providerWebsocketMode?: AIProvider['websocketMode']
  side?: 'top' | 'bottom'
  t: (key: string, opts?: Record<string, unknown>) => string
  tChat: (key: string, opts?: Record<string, unknown>) => string
  tSettings: (key: string, opts?: Record<string, unknown>) => string
}): React.JSX.Element | null {
  const requestType = model?.type ?? providerType
  const supportsThinking = model?.supportsThinking ?? false
  const supportsFastMode = supportsPriorityServiceTier(model)
  const supportsResponsesWebsocket = modelSupportsResponsesWebsocket(model, providerType)
  const supportsResponsesImageGeneration = modelSupportsResponsesImageGeneration(
    model,
    providerType
  )
  const provider = useProviderStore((s) =>
    providerId ? s.providers.find((p) => p.id === providerId) : undefined
  )
  const providerBuiltinId = provider?.builtinId
  const thinkingConfig = resolveModelThinkingConfig(model, providerBuiltinId)
  const levels = thinkingConfig?.reasoningEffortLevels
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
    thinkingConfig
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

  const supportsBuiltinSearch = modelSupportsBuiltinSearch(model, providerType)
  const builtinSearchEnabled = supportsBuiltinSearch && model?.enableBuiltinSearch === true
  const supportsGptLongContext = modelSupportsGptLongContext(model)
  const gptLongContextEnabled = supportsGptLongContext && isGptLongContextEnabled(model)

  const hasConfigControls =
    supportsThinking ||
    supportsFastMode ||
    supportsResponsesWebsocket ||
    supportsResponsesImageGeneration ||
    supportsAnthropicCacheTtl ||
    supportsBuiltinSearch ||
    supportsGptLongContext

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

  const toggleBuiltinSearch = useCallback(() => {
    if (!model?.id) return
    const providerStore = useProviderStore.getState()
    const targetProviderId = providerId ?? providerStore.activeProviderId
    if (!targetProviderId) return
    providerStore.updateModel(targetProviderId, model.id, {
      enableBuiltinSearch: !builtinSearchEnabled
    })
  }, [model, providerId, builtinSearchEnabled])

  const toggleGptLongContext = useCallback(() => {
    if (!model?.id) return
    const providerStore = useProviderStore.getState()
    const targetProviderId = providerId ?? providerStore.activeProviderId
    if (!targetProviderId) return
    providerStore.updateModel(targetProviderId, model.id, {
      enableLongContext: !gptLongContextEnabled
    })
  }, [model, providerId, gptLongContextEnabled])

  const websocketEnabled =
    (model?.websocketMode ?? providerWebsocketMode ?? 'disabled') !== 'disabled'
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
        className="w-[410px] max-w-[calc(100vw-1rem)] overflow-hidden rounded-2xl border-border/70 bg-popover/95 p-0 shadow-2xl backdrop-blur-md"
        align="start"
        side={side}
        sideOffset={8}
        collisionPadding={12}
      >
        {model && (
          <div className="border-b border-border/60 bg-muted/30 px-4 py-3">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background/80 shadow-2xs">
                <ModelIcon
                  icon={model.icon}
                  modelId={model.id}
                  providerBuiltinId={provider?.builtinId}
                  size={18}
                />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold text-foreground">
                    {model.name || model.id}
                  </span>
                  {requestType && (
                    <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {requestType}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                  {provider && <span className="truncate">{provider.name}</span>}
                  {model.id !== model.name && (
                    <span className="truncate font-mono text-[10px] text-muted-foreground/60">
                      {model.id}
                    </span>
                  )}
                </div>
                <div className="mt-2">
                  <ModelCapabilityTags
                    model={model}
                    providerType={providerType}
                    t={t}
                    showContext={true}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        <div
          className="space-y-4 overflow-y-auto p-4"
          style={{ maxHeight: 'min(28rem, var(--radix-popover-content-available-height))' }}
        >
          {!model && (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              {tChat('input.noModelSettings')}
            </div>
          )}

          {model && (
            <>
              {!hasConfigControls && (
                <div className="rounded-xl border border-border/50 bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
                  {tChat('input.noModelSettings')}
                </div>
              )}

              {supportsThinking && (
                <SettingSection accent="bg-violet-500" title={t('topbar.deepThinking')}>
                  {levels && levels.length > 0 ? (
                    <div className="space-y-2 rounded-xl border border-border/50 bg-muted/20 p-2.5 dark:bg-white/[0.02]">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              'flex size-5 items-center justify-center rounded-full',
                              thinkingEnabled
                                ? 'bg-violet-500/15 text-violet-600 dark:text-violet-300'
                                : 'bg-muted text-muted-foreground'
                            )}
                          >
                            <Brain className="size-3" />
                          </span>
                          <span className="text-xs font-medium text-foreground">
                            {t('topbar.deepThinking')}
                          </span>
                          <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase text-muted-foreground">
                            {thinkingEnabled
                              ? String(effectiveReasoningEffort).toUpperCase()
                              : tChat('input.thinkingOff')}
                          </span>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={thinkingEnabled}
                          onClick={toggleThinking}
                          className={cn(
                            'flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors duration-200 cursor-pointer',
                            thinkingEnabled ? 'bg-violet-500' : 'bg-muted-foreground/25'
                          )}
                        >
                          <span
                            className={cn(
                              'size-3.5 rounded-full bg-white shadow-xs transition-transform duration-200',
                              thinkingEnabled ? 'translate-x-[16px]' : 'translate-x-0.5'
                            )}
                          />
                        </button>
                      </div>

                      <div
                        className={cn(
                          'rounded-lg px-2 pb-1 pt-1.5 transition-opacity',
                          !thinkingEnabled && 'opacity-40 pointer-events-none'
                        )}
                      >
                        <ReasoningEffortSlider
                          levels={levels}
                          value={effectiveReasoningEffort}
                          onChange={setEffort}
                          dimmed={!thinkingEnabled}
                          fasterLabel={t('topbar.faster')}
                          smarterLabel={t('topbar.smarter')}
                          ariaLabel={t('topbar.reasoningEffort')}
                        />
                      </div>
                    </div>
                  ) : (
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

                  {supportsAnthropicThinkingBudget && (
                    <div className="rounded-xl border border-border/50 bg-muted/20 p-3 dark:bg-white/[0.02]">
                      <div className="mb-2 flex items-end justify-between gap-3">
                        <div>
                          <div className="text-xs font-semibold text-foreground">
                            {tSettings('provider.thinkingBudget')}
                          </div>
                          <div className="text-[10px] text-muted-foreground">budget_tokens</div>
                        </div>
                        <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs font-semibold text-foreground">
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
                        className="w-full accent-violet-500 cursor-pointer"
                      />
                      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                        <span>{MIN_ANTHROPIC_THINKING_BUDGET.toLocaleString()}</span>
                        <span>{thinkingBudgetMax.toLocaleString()}</span>
                      </div>
                    </div>
                  )}
                </SettingSection>
              )}

              {(supportsBuiltinSearch || supportsGptLongContext || supportsAnthropicCacheTtl) && (
                <SettingSection accent="bg-teal-500" title={tSettings('provider.modelConfig')}>
                  <CapabilityCard>
                    {supportsBuiltinSearch && (
                      <CapabilityRow
                        tone="teal"
                        icon={<Globe2 className="size-3.5" />}
                        label={t('topbar.builtinSearch')}
                        description={
                          builtinSearchEnabled
                            ? t('topbar.builtinSearchOn')
                            : t('topbar.builtinSearchOff')
                        }
                        enabled={builtinSearchEnabled}
                        onClick={toggleBuiltinSearch}
                      />
                    )}

                    {supportsGptLongContext && (
                      <CapabilityRow
                        tone="orange"
                        icon={<Expand className="size-3.5" />}
                        label={t('topbar.longContext')}
                        description={
                          gptLongContextEnabled
                            ? t('topbar.longContextOn')
                            : t('topbar.longContextOff')
                        }
                        enabled={gptLongContextEnabled}
                        onClick={toggleGptLongContext}
                      />
                    )}

                    {supportsAnthropicCacheTtl && (
                      <CapabilityChoiceRow
                        tone="sky"
                        icon={<Timer className="size-3.5" />}
                        label={tSettings('provider.cacheTtl')}
                        description={tSettings('provider.cacheTtlHint')}
                        options={['5m', '1h'] as const}
                        value={anthropicCacheTtl}
                        onChange={updateAnthropicCacheTtl}
                      />
                    )}
                  </CapabilityCard>
                </SettingSection>
              )}

              {(supportsFastMode ||
                supportsResponsesWebsocket ||
                supportsResponsesImageGeneration) && (
                <SettingSection
                  accent="bg-amber-500"
                  title={t('topbar.capabilities', { defaultValue: 'Capabilities' })}
                >
                  <div className="flex flex-wrap gap-1.5">
                    {supportsFastMode && (
                      <CapabilityChip
                        tone="amber"
                        icon={<Zap className="size-3" />}
                        label={t('topbar.fastMode')}
                        hint={tSettings('provider.supportsFastModeDesc')}
                        enabled={fastModeEnabled}
                        onClick={() =>
                          useSettingsStore
                            .getState()
                            .updateSettings({ fastModeEnabled: !fastModeEnabled })
                        }
                      />
                    )}

                    {supportsResponsesWebsocket && (
                      <CapabilityChip
                        tone="sky"
                        icon={<Cable className="size-3" />}
                        label={t('topbar.websocketProtocol', { defaultValue: 'WebSocket' })}
                        hint={tSettings('provider.supportsWebsocketDesc')}
                        enabled={websocketEnabled}
                        onClick={toggleResponsesWebsocket}
                      />
                    )}

                    {supportsResponsesImageGeneration && (
                      <CapabilityChip
                        tone="emerald"
                        icon={<ImageIcon className="size-3" />}
                        label={t('topbar.imageGeneration', { defaultValue: 'Image generation' })}
                        hint={tSettings('provider.supportsImageGenerationDesc')}
                        enabled={responsesImageGenerationEnabled}
                        onClick={toggleResponsesImageGeneration}
                      />
                    )}
                  </div>
                </SettingSection>
              )}

              <ModelHoverDetails model={model} tSettings={tSettings} />
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
   * created session can copy them. When omitted, falls back to the active session.
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
        modelId: session.modelId
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

  const enabledProviders = useMemo(
    () => (open ? providers.filter((p) => isProviderAvailableForModelSelection(p)) : []),
    [open, providers]
  )
  const sessionModelSelection = resolveSessionModelSelection({
    session: activeSession,
    providers,
    activeProviderId,
    activeModelId,
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
  const settingsProviderId = displayProvider?.id
  const settingsModel = displayModel
  const settingsPopoverSide = activeSession ? 'top' : 'bottom'
  const triggerLabel = displayModel?.name ?? displayModelId ?? t('topbar.noModel')
  const triggerAriaLabel = displayModel?.name ?? displayModelId ?? t('topbar.noModel')
  const triggerProviderName = displayProvider?.name ?? null
  const triggerModel = displayModel ?? null
  const triggerProviderType = displayProvider?.type
  const triggerDetail =
    displayModelId && displayModel?.name && displayModel.name !== displayModelId
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

  const flatSearchResults = useMemo(() => {
    const q = search.toLowerCase().trim()
    if (!q) return []
    const results: Array<{ provider: AIProvider; model: AIModelConfig }> = []
    for (const { provider, models } of groups) {
      for (const model of models) {
        results.push({ provider, model })
      }
    }
    return results
  }, [groups, search])
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
    if (!open || !selectedGroup || search.trim() || hasAutoScrolledToSelectionRef.current) {
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
  }, [open, search, selectedGroup])

  return (
    <div className="inline-flex h-8 items-center rounded-lg border border-border/60 bg-background/70 shadow-2xs hover:border-border hover:bg-muted/30 transition-colors">
      {/* Model icon trigger — opens model list */}
      <Popover open={open} onOpenChange={handleOpenChange}>
        <HoverCard openDelay={180} closeDelay={100}>
          <HoverCardTrigger asChild>
            <PopoverTrigger asChild>
              <button
                className="inline-flex h-full shrink-0 items-center gap-1.5 rounded-l-lg px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                aria-label={triggerAriaLabel}
              >
                <ModelIcon
                  icon={displayModel?.icon}
                  modelId={displayModelId ?? undefined}
                  providerBuiltinId={displayProvider?.builtinId}
                  size={16}
                />
                <span className="max-w-[120px] truncate text-[11px] font-medium text-foreground/90">
                  {triggerLabel}
                </span>
                <ChevronDown className="size-3 shrink-0 text-muted-foreground/60" />
              </button>
            </PopoverTrigger>
          </HoverCardTrigger>
          <HoverCardContent side="top" align="start" className="w-72 p-3">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted/45">
                <ModelIcon
                  icon={displayModel?.icon}
                  modelId={displayModelId ?? undefined}
                  providerBuiltinId={displayProvider?.builtinId}
                  size={20}
                />
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
                  showContext={false}
                />
                <ModelHoverDetails model={triggerModel} tSettings={tSettings} />
              </div>
            )}
          </HoverCardContent>
        </HoverCard>
        <PopoverContent
          className="w-72 sm:w-80 max-w-[calc(100vw-2rem)] overflow-visible p-0 rounded-2xl border-border/70 bg-popover/95 shadow-2xl backdrop-blur-md"
          align="start"
          sideOffset={8}
        >
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
            <Search className="size-3.5 shrink-0 text-muted-foreground/70" />
            <input
              ref={searchRef}
              type="text"
              className="flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/50"
              placeholder={t('topbar.searchModel')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          {search.trim() ? (
            <div className="max-h-[350px] overflow-y-auto p-1.5 space-y-0.5">
              <div className="flex items-center justify-between px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                <span>{t('topbar.searchResults', { defaultValue: 'Search Results' })}</span>
                <span className="font-mono">{flatSearchResults.length}</span>
              </div>
              {flatSearchResults.length === 0 ? (
                <div className="px-3 py-8 text-center text-xs text-muted-foreground/60">
                  <Search className="mx-auto mb-2 size-5 opacity-30" />
                  {t('topbar.noModelsFound', { defaultValue: 'No models found' })}
                </div>
              ) : (
                flatSearchResults.map(({ provider, model }) => {
                  const isActive = provider.id === displayProviderId && model.id === displayModelId
                  return (
                    <button
                      key={`${provider.id}-${model.id}`}
                      type="button"
                      className={cn(
                        'flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-muted/70 group cursor-pointer',
                        isActive && 'bg-primary/10 text-primary'
                      )}
                      onClick={() =>
                        isFastRoute
                          ? selectFastModel(
                              provider,
                              model.id,
                              activeFastProviderId,
                              setActiveFastProvider,
                              setActiveFastModel,
                              setOpen
                            )
                          : selectModel(provider, model.id, activeSessionId, setOpen)
                      }
                    >
                      <span className="mt-0.5 shrink-0">
                        {isActive ? (
                          <span className="flex size-5 items-center justify-center rounded-full bg-primary/15">
                            <Check className="size-3 text-primary" />
                          </span>
                        ) : (
                          <ModelIcon
                            icon={model.icon}
                            modelId={model.id}
                            providerBuiltinId={provider.builtinId}
                            size={20}
                          />
                        )}
                      </span>
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div className="flex items-center justify-between gap-1.5">
                          <span
                            className={cn(
                              'truncate text-xs font-medium',
                              isActive
                                ? 'font-semibold text-primary'
                                : 'text-foreground/90 group-hover:text-foreground'
                            )}
                          >
                            {model.name || model.id.replace(/-\d{8}$/, '')}
                          </span>
                          <span className="shrink-0 text-[10px] text-muted-foreground/70">
                            {provider.name}
                          </span>
                        </div>
                        <ModelCapabilityTags model={model} providerType={provider.type} t={t} />
                      </div>
                    </button>
                  )
                })
              )}
            </div>
          ) : (
            <>
              <div className="p-1.5">
                <div className="flex items-center justify-between px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                  <span>{t('topbar.providers')}</span>
                  <span className="text-[10px] normal-case font-normal text-muted-foreground/50">
                    {groups.length} {t('topbar.providerUnits', { defaultValue: 'providers' })}
                  </span>
                </div>
                <div className="max-h-[328px] overflow-y-auto space-y-0.5">
                  {groups.length === 0 ? (
                    <div className="px-3 py-6 text-center text-xs text-muted-foreground/50">
                      {enabledProviders.length === 0
                        ? t('topbar.noProviders')
                        : t('topbar.noModels')}
                    </div>
                  ) : (
                    groups.map(({ provider, models }) => {
                      const isSelected = provider.id === selectedGroup?.provider.id
                      const isDisplayProvider = provider.id === displayProviderId
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
                                'flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-muted/70 cursor-pointer',
                                isSelected && 'bg-background shadow-xs',
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
                                  'rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground',
                                  isDisplayProvider && 'bg-primary/10 text-primary'
                                )}
                              >
                                {models.length}
                              </span>
                            </button>
                          </PopoverTrigger>
                          <PopoverContent
                            className="w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border-border/70 bg-popover/95 p-1 shadow-2xl backdrop-blur-md"
                            align="start"
                            side="right"
                            sideOffset={6}
                          >
                            <div className="sticky top-0 z-10 mb-1 flex items-center gap-2 border-b border-border/60 bg-popover/95 px-3 py-2 backdrop-blur-sm">
                              <ProviderIcon builtinId={provider.builtinId} size={14} />
                              <span className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                                {provider.name}
                              </span>
                              <span className="shrink-0 text-[10px] text-muted-foreground/50 font-mono">
                                {t('topbar.modelsCount', { count: models.length })}
                              </span>
                            </div>
                            <div
                              ref={selectedProviderId === provider.id ? listRef : undefined}
                              className="max-h-[344px] overflow-y-auto space-y-0.5"
                            >
                              {models.map((m) => {
                                const isActive =
                                  provider.id === displayProviderId && m.id === displayModelId
                                return (
                                  <button
                                    key={`${provider.id}-${m.id}`}
                                    ref={isActive ? activeModelRef : undefined}
                                    className={cn(
                                      'flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-muted/60 group cursor-pointer',
                                      isActive && 'bg-primary/10'
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
                                        <span className="flex size-5 items-center justify-center rounded-full bg-primary/15">
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
            </>
          )}
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
        providerType={displayProvider?.type}
        providerWebsocketMode={displayProvider?.websocketMode}
        side={settingsPopoverSide}
        t={t}
        tChat={tChat}
        tSettings={tSettings}
      />
    </div>
  )
}
