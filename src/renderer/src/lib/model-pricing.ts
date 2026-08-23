import type { AIModelConfig, ModelPricingSchedule, ModelPricingTier } from './api/types'

/** DeepSeek official peak windows: 01:00–04:00 and 06:00–10:00 UTC. */
export const DEEPSEEK_PEAK_HOURS_UTC: ModelPricingSchedule['peakHoursUtc'] = [
  { startHour: 1, endHour: 4 },
  { startHour: 6, endHour: 10 }
]

/**
 * DeepSeek charges peak on weekdays only, and it counts the weekday on its own clock
 * (Beijing, UTC+8) rather than on UTC. The two calendars disagree for 16:00–24:00 UTC,
 * which is outside both windows above, so with today's windows the distinction never
 * changes a bill -- it only starts mattering the day a window moves past 16:00 UTC.
 */
export const DEEPSEEK_PEAK_DAYS_ISO = [1, 2, 3, 4, 5]
export const DEEPSEEK_PEAK_DAYS_UTC_OFFSET = 8

export const DEEPSEEK_PRICING_SCHEDULE: ModelPricingSchedule = {
  peakHoursUtc: DEEPSEEK_PEAK_HOURS_UTC,
  peakDaysIso: DEEPSEEK_PEAK_DAYS_ISO,
  peakDaysUtcOffset: DEEPSEEK_PEAK_DAYS_UTC_OFFSET
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

/**
 * Whether `at` is billed at the peak rate: the UTC hour is inside a window, and -- if
 * the schedule restricts them -- the day is one of the peak days. A schedule with no
 * `peakDaysIso` keeps today's behaviour and bills peak on every day of the week.
 */
export function isPeakPricingHour(
  at: Date = new Date(),
  schedule?: ModelPricingSchedule | null
): boolean {
  const windows = schedule?.peakHoursUtc?.length ? schedule.peakHoursUtc : DEEPSEEK_PEAK_HOURS_UTC
  const hour = at.getUTCHours()
  if (!windows.some((window) => hour >= window.startHour && hour < window.endHour)) return false
  const days = usablePeakDays(schedule)
  if (days.length === 0) return true
  return days.includes(isoWeekdayAt(at, peakDayOffsetHours(schedule)))
}

/**
 * One unusable entry drops the whole restriction rather than just that entry. Dropping
 * entries would narrow the peak days and hand out a discount the vendor never gave;
 * dropping the restriction only ever charges the rate we already charge today.
 */
function usablePeakDays(schedule?: ModelPricingSchedule | null): number[] {
  const days = schedule?.peakDaysIso
  if (!Array.isArray(days) || days.length === 0) return []
  const usable = days.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)
  return usable ? days : []
}

function peakDayOffsetHours(schedule?: ModelPricingSchedule | null): number {
  const offset = schedule?.peakDaysUtcOffset
  if (!Number.isInteger(offset as number) || Math.abs(offset as number) > 14) return 0
  return offset as number
}

/** ISO weekday (1 = Monday … 7 = Sunday) of `at` on a clock `offsetHours` from UTC. */
function isoWeekdayAt(at: Date, offsetHours: number): number {
  const day = new Date(at.getTime() + offsetHours * 3_600_000).getUTCDay()
  return day === 0 ? 7 : day
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
