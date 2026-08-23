import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEEPSEEK_PRICING_SCHEDULE,
  hasTieredPricing,
  isPeakPricingHour,
  normalizePricingTiers,
  resolveActivePricingTierFloor,
  resolveModelPricingBrackets,
  resolveModelPrices
} from '../../src/renderer/src/lib/model-pricing.ts'
import type { AIModelConfig, ModelPricingSchedule } from '../../src/renderer/src/lib/api/types.ts'
import { deepseekPreset } from '../../src/renderer/src/stores/providers/deepseek.ts'
import { routinAiPreset } from '../../src/renderer/src/stores/providers/routin-ai.ts'

const tieredModel: AIModelConfig = {
  id: 'MiniMax-M3',
  name: 'MiniMax M3',
  enabled: true,
  inputPrice: 0.29,
  outputPrice: 1.17,
  cacheHitPrice: 0.06,
  pricingTiers: [
    { minPromptTokens: 512_001, inputPrice: 0.58, outputPrice: 2.34, cacheHitPrice: 0.12 }
  ]
}

test('normalizePricingTiers sorts, floors and drops unusable entries', () => {
  const tiers = normalizePricingTiers([
    { minPromptTokens: 1_000_000, inputPrice: 3 },
    { minPromptTokens: 0, inputPrice: 1 },
    { minPromptTokens: 200_000.7, outputPrice: 2 },
    { minPromptTokens: 400_000 },
    { minPromptTokens: Number.NaN, inputPrice: 9 }
  ])
  assert.deepEqual(
    tiers.map((tier) => tier.minPromptTokens),
    [200_000, 1_000_000]
  )
})

test('prompts below the first floor keep the base rate', () => {
  assert.equal(hasTieredPricing(tieredModel), true)
  const prices = resolveModelPrices(tieredModel, new Date(), 512_000)
  assert.equal(prices.inputPrice, 0.29)
  assert.equal(prices.outputPrice, 1.17)
  assert.equal(prices.tierMinPromptTokens, null)
})

test('prompts at or above a floor use that tier', () => {
  const prices = resolveModelPrices(tieredModel, new Date(), 512_001)
  assert.equal(prices.inputPrice, 0.58)
  assert.equal(prices.outputPrice, 2.34)
  assert.equal(prices.cacheHitPrice, 0.12)
  assert.equal(prices.tierMinPromptTokens, 512_001)
  assert.equal(resolveActivePricingTierFloor(tieredModel, 900_000), 512_001)
  assert.equal(resolveActivePricingTierFloor(tieredModel, 10), null)
})

test('an omitted prompt size resolves the base bracket', () => {
  assert.equal(resolveModelPrices(tieredModel).inputPrice, 0.29)
  assert.equal(resolveModelPrices(tieredModel, new Date(), null).tierMinPromptTokens, null)
})

test('tiers only override the prices they set', () => {
  const model: AIModelConfig = {
    ...tieredModel,
    cacheCreationPrice: 0.4,
    pricingTiers: [{ minPromptTokens: 100_000, outputPrice: 5 }]
  }
  const prices = resolveModelPrices(model, new Date(), 150_000)
  assert.equal(prices.outputPrice, 5)
  assert.equal(prices.inputPrice, 0.29)
  assert.equal(prices.cacheCreationPrice, 0.4)
})

test('tiers apply on top of the off-peak rate', () => {
  const model: AIModelConfig = {
    id: 'timed-tiered',
    name: 'Timed + tiered',
    enabled: true,
    inputPrice: 1,
    offPeakInputPrice: 0.5,
    outputPrice: 4,
    pricingSchedule: DEEPSEEK_PRICING_SCHEDULE,
    pricingTiers: [{ minPromptTokens: 200_000, outputPrice: 8 }]
  }
  // 02:00 UTC is inside the DeepSeek peak window, 20:00 UTC is outside it.
  const peak = resolveModelPrices(model, new Date('2026-01-01T02:00:00Z'), 300_000)
  const offPeak = resolveModelPrices(model, new Date('2026-01-01T20:00:00Z'), 300_000)
  assert.equal(peak.inputPrice, 1)
  assert.equal(peak.outputPrice, 8)
  assert.equal(peak.isPeak, true)
  assert.equal(offPeak.inputPrice, 0.5)
  assert.equal(offPeak.outputPrice, 8)
  assert.equal(offPeak.isPeak, false)
})

test('brackets describe the whole ladder for display', () => {
  const model: AIModelConfig = {
    ...tieredModel,
    pricingTiers: [
      { minPromptTokens: 200_000, inputPrice: 2 },
      { minPromptTokens: 800_000, inputPrice: 4 }
    ]
  }
  const brackets = resolveModelPricingBrackets(model)
  assert.deepEqual(
    brackets.map((bracket) => [
      bracket.minPromptTokens,
      bracket.maxPromptTokens,
      bracket.inputPrice
    ]),
    [
      [0, 200_000, 0.29],
      [200_000, 800_000, 2],
      [800_000, null, 4]
    ]
  )
  // Untiered models have no ladder to show.
  assert.deepEqual(resolveModelPricingBrackets({ ...tieredModel, pricingTiers: undefined }), [])
})

// 2026-01-01 is a Thursday, so 01-02 is Friday, 01-03 Saturday, 01-04 Sunday and
// 01-05 Monday -- on UTC. Beijing is eight hours ahead, so from 16:00 UTC onwards
// the two calendars are on different days, and that is where the tests below bite.
const at = (iso: string): Date => new Date(iso)

/**
 * A synthetic 15:00-20:00 UTC window. DeepSeek's real windows (01-04, 06-10) both sit
 * before 16:00 UTC, where the UTC and Beijing dates still agree -- so no test written
 * against the real windows can tell "read the day in UTC" apart from "read it in
 * Beijing". This card straddles 16:00 UTC, which is the only place the two differ.
 */
const lateWindow: ModelPricingSchedule = {
  peakHoursUtc: [{ startHour: 15, endHour: 20 }],
  peakDaysIso: [1, 2, 3, 4, 5],
  peakDaysUtcOffset: 8
}

test('the weekend is off-peak even inside a peak window', () => {
  // 02:00 UTC is inside DeepSeek's first window on every one of these days.
  assert.equal(isPeakPricingHour(at('2026-01-01T02:00:00Z'), DEEPSEEK_PRICING_SCHEDULE), true)
  assert.equal(isPeakPricingHour(at('2026-01-03T02:00:00Z'), DEEPSEEK_PRICING_SCHEDULE), false)
  assert.equal(isPeakPricingHour(at('2026-01-04T02:00:00Z'), DEEPSEEK_PRICING_SCHEDULE), false)
  assert.equal(isPeakPricingHour(at('2026-01-05T02:00:00Z'), DEEPSEEK_PRICING_SCHEDULE), true)
  // Outside every window the day never gets a say.
  assert.equal(isPeakPricingHour(at('2026-01-01T20:00:00Z'), DEEPSEEK_PRICING_SCHEDULE), false)
})

test('a schedule with no peak days is billed on every day of the week', () => {
  const everyDay: ModelPricingSchedule = { peakHoursUtc: [{ startHour: 1, endHour: 4 }] }
  assert.equal(isPeakPricingHour(at('2026-01-03T02:00:00Z'), everyDay), true)
  assert.equal(isPeakPricingHour(at('2026-01-03T02:00:00Z'), null), true)
})

test('the peak day is read on the vendor clock, not on UTC', () => {
  // Still Friday in Beijing, and already Saturday one minute later.
  assert.equal(isPeakPricingHour(at('2026-01-02T15:59:00Z'), lateWindow), true)
  assert.equal(isPeakPricingHour(at('2026-01-02T16:00:00Z'), lateWindow), false)
  // Sunday in UTC both times, but the second one is Monday in Beijing.
  assert.equal(isPeakPricingHour(at('2026-01-04T15:59:00Z'), lateWindow), false)
  assert.equal(isPeakPricingHour(at('2026-01-04T16:00:00Z'), lateWindow), true)
})

test('peak days with no offset are counted in UTC', () => {
  const utcDays: ModelPricingSchedule = { ...lateWindow, peakDaysUtcOffset: undefined }
  assert.equal(isPeakPricingHour(at('2026-01-02T16:00:00Z'), utcDays), true)
  assert.equal(isPeakPricingHour(at('2026-01-04T16:00:00Z'), utcDays), false)
})

test('an unreadable day list bills peak rather than inventing a discount', () => {
  // Saturday 02:00 UTC: with a usable weekday list this is off-peak, so anything that
  // still reads peak here proves the restriction was dropped whole, not trimmed.
  // The mixed lists matter most: dropping just the bad entry would leave [1..5]
  // standing, which reads as a clean weekday rule and quietly discounts the Saturday
  // the card was trying to charge for. One bad entry has to take the list with it.
  for (const days of [[], [0], [8], [1.5], [true], ['1'], 5, null, { 1: true },
                      [1, 2, 3, 4, 5, '6'], [1, 2, 3, 4, 5, 6.5], [6, 0]]) {
    const schedule = { ...DEEPSEEK_PRICING_SCHEDULE, peakDaysIso: days } as ModelPricingSchedule
    const label = `days=${JSON.stringify(days)}`
    assert.equal(isPeakPricingHour(at('2026-01-03T02:00:00Z'), schedule), true, label)
  }
  // A list that is merely unsorted or partial is perfectly usable.
  const weekendOnly = { ...DEEPSEEK_PRICING_SCHEDULE, peakDaysIso: [7, 6] }
  assert.equal(isPeakPricingHour(at('2026-01-03T02:00:00Z'), weekendOnly), true)
  assert.equal(isPeakPricingHour(at('2026-01-05T02:00:00Z'), weekendOnly), false)
})

test('an unreadable offset falls back to counting the day in UTC', () => {
  for (const offset of ['8', 8.5, 99, Number.NaN, null]) {
    const schedule = { ...lateWindow, peakDaysUtcOffset: offset } as ModelPricingSchedule
    // Friday in UTC, Saturday in Beijing: reading UTC is the answer that charges peak.
    assert.equal(isPeakPricingHour(at('2026-01-02T16:00:00Z'), schedule), true, `offset=${offset}`)
  }
})

test('a weekend request resolves to the off-peak rates end to end', () => {
  const model: AIModelConfig = {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    enabled: true,
    inputPrice: 0.66,
    outputPrice: 1.98,
    offPeakInputPrice: 0.22,
    offPeakOutputPrice: 0.66,
    pricingSchedule: DEEPSEEK_PRICING_SCHEDULE
  }
  const weekday = resolveModelPrices(model, at('2026-01-01T02:00:00Z'))
  const weekend = resolveModelPrices(model, at('2026-01-03T02:00:00Z'))
  assert.equal(weekday.isPeak, true)
  assert.equal(weekday.inputPrice, 0.66)
  assert.equal(weekend.isPeak, false)
  assert.equal(weekend.inputPrice, 0.22)
  assert.equal(weekend.outputPrice, 0.66)
})

test('official DeepSeek V4 Flash Vision Exp uses weekday peak pricing like Flash', () => {
  const flash = deepseekPreset.defaultModels.find((model) => model.id === 'deepseek-v4-flash')
  const vision = deepseekPreset.defaultModels.find(
    (model) => model.id === 'deepseek-v4-flash-vision-exp'
  )
  const pro = deepseekPreset.defaultModels.find((model) => model.id === 'deepseek-v4-pro')
  assert.ok(flash)
  assert.ok(vision)
  assert.ok(pro)

  for (const model of [flash, vision, pro]) {
    assert.equal(model.pricingSchedule, DEEPSEEK_PRICING_SCHEDULE)
    assert.equal(model.offPeakInputPrice != null, true, model.id)
    assert.equal(model.offPeakOutputPrice != null, true, model.id)
  }

  // Official docs bill Vision Exp at the Flash rate, not Pro.
  assert.equal(vision.inputPrice, flash.inputPrice)
  assert.equal(vision.outputPrice, flash.outputPrice)
  assert.equal(vision.cacheCreationPrice, flash.cacheCreationPrice)
  assert.equal(vision.cacheHitPrice, flash.cacheHitPrice)
  assert.equal(vision.offPeakInputPrice, flash.offPeakInputPrice)
  assert.equal(vision.offPeakOutputPrice, flash.offPeakOutputPrice)
  assert.equal(vision.offPeakCacheCreationPrice, flash.offPeakCacheCreationPrice)
  assert.equal(vision.offPeakCacheHitPrice, flash.offPeakCacheHitPrice)

  const weekdayPeak = resolveModelPrices(vision, at('2026-01-01T02:00:00Z'))
  const weekendWindow = resolveModelPrices(vision, at('2026-01-03T02:00:00Z'))
  const weekdayOffPeak = resolveModelPrices(vision, at('2026-01-01T20:00:00Z'))

  assert.equal(weekdayPeak.isPeak, true)
  assert.equal(weekdayPeak.inputPrice, 0.44)
  assert.equal(weekdayPeak.outputPrice, 1.32)
  assert.equal(weekdayPeak.cacheHitPrice, 0.014)

  assert.equal(weekendWindow.isPeak, false)
  assert.equal(weekendWindow.inputPrice, 0.22)
  assert.equal(weekendWindow.outputPrice, 0.66)
  assert.equal(weekendWindow.cacheHitPrice, 0.007)

  assert.equal(weekdayOffPeak.isPeak, false)
  assert.equal(weekdayOffPeak.inputPrice, 0.22)
})

test('Routin DeepSeek models use the same weekday peak windows as official', () => {
  const ids = ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro'] as const
  const models = ids.map((id) => {
    const model = routinAiPreset.defaultModels.find((entry) => entry.id === id)
    assert.ok(model, id)
    return model
  })

  for (const model of models) {
    assert.equal(model.pricingSchedule, DEEPSEEK_PRICING_SCHEDULE, model.id)
    assert.equal(model.offPeakInputPrice, (model.inputPrice ?? 0) / 2, model.id)
    assert.equal(model.offPeakOutputPrice, (model.outputPrice ?? 0) / 2, model.id)
    assert.equal(model.offPeakCacheCreationPrice, (model.cacheCreationPrice ?? 0) / 2, model.id)
    assert.equal(model.offPeakCacheHitPrice, (model.cacheHitPrice ?? 0) / 2, model.id)
  }

  const vision = models[1]
  const weekdayPeak = resolveModelPrices(vision, at('2026-01-01T02:00:00Z'))
  const weekendWindow = resolveModelPrices(vision, at('2026-01-03T02:00:00Z'))
  const weekdayOffPeak = resolveModelPrices(vision, at('2026-01-01T20:00:00Z'))

  assert.equal(weekdayPeak.isPeak, true)
  assert.equal(weekdayPeak.inputPrice, 1)
  assert.equal(weekdayPeak.outputPrice, 2)
  assert.equal(weekdayPeak.cacheHitPrice, 0.2)

  assert.equal(weekendWindow.isPeak, false)
  assert.equal(weekendWindow.inputPrice, 0.5)
  assert.equal(weekendWindow.outputPrice, 1)
  assert.equal(weekendWindow.cacheHitPrice, 0.1)

  assert.equal(weekdayOffPeak.isPeak, false)
  assert.equal(weekdayOffPeak.inputPrice, 0.5)
})
