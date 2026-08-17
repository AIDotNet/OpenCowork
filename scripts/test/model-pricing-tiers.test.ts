import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEEPSEEK_PRICING_SCHEDULE,
  hasTieredPricing,
  normalizePricingTiers,
  resolveActivePricingTierFloor,
  resolveModelPricingBrackets,
  resolveModelPrices
} from '../../src/renderer/src/lib/model-pricing.ts'
import type { AIModelConfig } from '../../src/renderer/src/lib/api/types.ts'

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
