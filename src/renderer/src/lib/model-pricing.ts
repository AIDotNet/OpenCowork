import type { AIModelConfig, ModelPricingSchedule, ModelPricingTier } from './api/types'

/** DeepSeek official peak windows: 01:00–04:00 and 06:00–10:00 UTC. */
export const DEEPSEEK_PEAK_HOURS_UTC: ModelPricingSchedule['peakHoursUtc'] = [
  { startHour: 1, endHour: 4 },
  { startHour: 6, endHour: 10 }
]

export const DEEPSEEK_PRICING_SCHEDULE: ModelPricingSchedule = {
  peakHoursUtc: DEEPSEEK_PEAK_HOURS_UTC
}

export interface ResolvedModelPrices {
  inputPrice: number | null
  outputPrice: number | null
  cacheCreationPrice: number | null
  cacheHitPrice: number | null
  isPeak: boolean
  /** Prompt-token floor of the tier that produced these rates; null on the base bracket. */
  tierMinPromptTokens: number | null
}

/** A resolved pricing bracket, ready for display. */
export interface ModelPricingBracket {
  /** Inclusive prompt-token lower bound. 0 on the base bracket. */
  minPromptTokens: number
  /** Exclusive prompt-token upper bound. null on the open-ended top bracket. */
  maxPromptTokens: number | null
  inputPrice: number | null
  outputPrice: number | null
  cacheCreationPrice: number | null
  cacheHitPrice: number | null
}

type OffPeakPriceFields = Pick<
  AIModelConfig,
  'offPeakInputPrice' | 'offPeakOutputPrice' | 'offPeakCacheCreationPrice' | 'offPeakCacheHitPrice'
>

export function hasOffPeakPricing(model: OffPeakPriceFields | null | undefined): boolean {
  if (!model) return false
  return (
    model.offPeakInputPrice != null ||
    model.offPeakOutputPrice != null ||
    model.offPeakCacheCreationPrice != null ||
    model.offPeakCacheHitPrice != null
  )
}

export function formatPeakHoursUtc(schedule?: ModelPricingSchedule | null): string {
  const windows = schedule?.peakHoursUtc?.length ? schedule.peakHoursUtc : DEEPSEEK_PEAK_HOURS_UTC
  return windows
    .map((window) => `${padHour(window.startHour)}:00–${padHour(window.endHour)}:00`)
    .join(', ')
}

export function isPeakPricingHour(
  at: Date = new Date(),
  schedule?: ModelPricingSchedule | null
): boolean {
  const windows = schedule?.peakHoursUtc?.length ? schedule.peakHoursUtc : DEEPSEEK_PEAK_HOURS_UTC
  const hour = at.getUTCHours()
  return windows.some((window) => hour >= window.startHour && hour < window.endHour)
}

export function hasTieredPricing(model: AIModelConfig | null | undefined): boolean {
  return normalizePricingTiers(model?.pricingTiers).length > 0
}

/**
 * Drop unusable entries (no floor, no prices) and sort ascending so bracket selection and
 * display can assume a clean ladder. Later entries win when two tiers share a floor.
 */
export function normalizePricingTiers(
  tiers: ModelPricingTier[] | null | undefined
): ModelPricingTier[] {
  if (!Array.isArray(tiers) || tiers.length === 0) return []
  const byFloor = new Map<number, ModelPricingTier>()
  for (const tier of tiers) {
    const floor = Math.floor(tier?.minPromptTokens ?? NaN)
    if (!Number.isFinite(floor) || floor <= 0) continue
    if (
      tier.inputPrice == null &&
      tier.outputPrice == null &&
      tier.cacheCreationPrice == null &&
      tier.cacheHitPrice == null
    ) {
      continue
    }
    byFloor.set(floor, { ...tier, minPromptTokens: floor })
  }
  return [...byFloor.values()].sort((a, b) => a.minPromptTokens - b.minPromptTokens)
}

/** Highest tier whose floor the prompt reaches, or null when the base rate applies. */
function selectPricingTier(
  tiers: ModelPricingTier[],
  promptTokens: number | null | undefined
): ModelPricingTier | null {
  if (promptTokens == null || !Number.isFinite(promptTokens)) return null
  let selected: ModelPricingTier | null = null
  for (const tier of tiers) {
    if (promptTokens >= tier.minPromptTokens) selected = tier
    else break
  }
  return selected
}

function resolveTimeOfDayPrices(
  model: AIModelConfig | null | undefined,
  at: Date
): ResolvedModelPrices {
  const peakPrices: ResolvedModelPrices = {
    inputPrice: model?.inputPrice ?? null,
    outputPrice: model?.outputPrice ?? null,
    cacheCreationPrice: model?.cacheCreationPrice ?? null,
    cacheHitPrice: model?.cacheHitPrice ?? null,
    isPeak: true,
    tierMinPromptTokens: null
  }
  if (!model || !hasOffPeakPricing(model)) return peakPrices

  if (isPeakPricingHour(at, model.pricingSchedule)) return peakPrices

  return {
    inputPrice: model.offPeakInputPrice ?? peakPrices.inputPrice,
    outputPrice: model.offPeakOutputPrice ?? peakPrices.outputPrice,
    cacheCreationPrice: model.offPeakCacheCreationPrice ?? peakPrices.cacheCreationPrice,
    cacheHitPrice: model.offPeakCacheHitPrice ?? peakPrices.cacheHitPrice,
    isPeak: false,
    tierMinPromptTokens: null
  }
}

/**
 * Effective rates for a request: time-of-day rate first, then the tiered bracket the
 * prompt falls into. `promptTokens` is the billed input side (billable input + cache
 * read + cache write); omit it to get the base bracket.
 */
export function resolveModelPrices(
  model: AIModelConfig | null | undefined,
  at: Date = new Date(),
  promptTokens?: number | null
): ResolvedModelPrices {
  const base = resolveTimeOfDayPrices(model, at)
  const tier = selectPricingTier(normalizePricingTiers(model?.pricingTiers), promptTokens)
  if (!tier) return base

  return {
    inputPrice: tier.inputPrice ?? base.inputPrice,
    outputPrice: tier.outputPrice ?? base.outputPrice,
    cacheCreationPrice: tier.cacheCreationPrice ?? base.cacheCreationPrice,
    cacheHitPrice: tier.cacheHitPrice ?? base.cacheHitPrice,
    isPeak: base.isPeak,
    tierMinPromptTokens: tier.minPromptTokens
  }
}

/**
 * Prompt-token floor of the tier a request of this size lands in; null on the base
 * bracket. Useful as a stable memo key when a caller only needs to know which bracket
 * applies, not the rates themselves.
 */
export function resolveActivePricingTierFloor(
  model: AIModelConfig | null | undefined,
  promptTokens: number | null | undefined
): number | null {
  const tier = selectPricingTier(normalizePricingTiers(model?.pricingTiers), promptTokens)
  return tier?.minPromptTokens ?? null
}

/**
 * The full price ladder for display: base bracket first, then one bracket per tier.
 * Returns an empty array when the model is not tier-priced.
 */
export function resolveModelPricingBrackets(
  model: AIModelConfig | null | undefined,
  at: Date = new Date()
): ModelPricingBracket[] {
  const tiers = normalizePricingTiers(model?.pricingTiers)
  if (tiers.length === 0) return []

  const base = resolveTimeOfDayPrices(model, at)
  const brackets: ModelPricingBracket[] = [
    {
      minPromptTokens: 0,
      maxPromptTokens: tiers[0].minPromptTokens,
      inputPrice: base.inputPrice,
      outputPrice: base.outputPrice,
      cacheCreationPrice: base.cacheCreationPrice,
      cacheHitPrice: base.cacheHitPrice
    }
  ]

  tiers.forEach((tier, index) => {
    brackets.push({
      minPromptTokens: tier.minPromptTokens,
      maxPromptTokens: tiers[index + 1]?.minPromptTokens ?? null,
      inputPrice: tier.inputPrice ?? base.inputPrice,
      outputPrice: tier.outputPrice ?? base.outputPrice,
      cacheCreationPrice: tier.cacheCreationPrice ?? base.cacheCreationPrice,
      cacheHitPrice: tier.cacheHitPrice ?? base.cacheHitPrice
    })
  })

  return brackets
}

function padHour(hour: number): string {
  return String(hour).padStart(2, '0')
}
