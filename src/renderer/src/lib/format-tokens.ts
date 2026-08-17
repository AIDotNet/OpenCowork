// Import the encoding directly. The package root also includes the much larger
// o200k model catalog, even though this estimator is intentionally cl100k-based.
import { encode } from 'gpt-tokenizer/encoding/cl100k_base'
import type { TokenUsage, AIModelConfig, ProviderType } from './api/types'
import { resolveModelPrices } from './model-pricing'

/**
 * Format a token count into a compact, human-readable string.
 * Examples: 0 → "0", 850 → "850", 1200 → "1.2k", 12500 → "12.5k", 1234567 → "1.23M"
 */
export function formatTokens(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 1_000_000) {
    const k = n / 1_000
    return k < 10 ? `${k.toFixed(1)}k` : `${k.toFixed(0)}k`
  }
  const m = n / 1_000_000
  return m < 10 ? `${m.toFixed(2)}M` : `${m.toFixed(1)}M`
}

/**
 * Format token count with K/M units and always 2 decimal places (for animations)
 * Examples: 850 → "850", 1234 → "1.23K", 12500 → "12.50K", 1234567 → "1.23M"
 */
export function formatTokensDecimal(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) {
    const k = n / 1000
    return `${k.toFixed(2)}K`
  }
  const m = n / 1_000_000
  return `${m.toFixed(2)}M`
}

export function getBillableInputTokens(
  usage: TokenUsage,
  _requestType?: ProviderType | AIModelConfig['type']
): number {
  if (usage.billableInputTokens != null) return usage.billableInputTokens
  return Math.max(
    0,
    (usage.inputTokens ?? 0) -
      Math.max(0, usage.cacheReadTokens ?? 0) -
      getCacheCreationTokens(usage)
  )
}

export function getCacheCreationTokens(usage: Partial<TokenUsage> | null | undefined): number {
  if (!usage) return 0
  const direct = Math.max(0, usage.cacheCreationTokens ?? 0)
  const detailed =
    Math.max(0, usage.cacheCreation5mTokens ?? 0) + Math.max(0, usage.cacheCreation1hTokens ?? 0)
  return Math.max(direct, detailed)
}

/**
 * Split cache-creation (cache write) tokens into 5-minute and 1-hour TTL buckets.
 * When a provider reports a detailed breakdown (Anthropic's
 * `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`), those
 * values are used; OpenAI's `cache_write_tokens` arrives as the combined total with
 * no TTL split. Any remainder between the combined total and the detailed sum is
 * attributed to the 5-minute bucket (the default ephemeral TTL). When no breakdown is
 * available, the whole combined total is treated as 5-minute. The two buckets always
 * sum back to {@link getCacheCreationTokens}.
 */
export function getCacheCreationSplit(usage: Partial<TokenUsage> | null | undefined): {
  fiveMinuteTokens: number
  oneHourTokens: number
} {
  const total = getCacheCreationTokens(usage)
  if (!usage || total <= 0) return { fiveMinuteTokens: 0, oneHourTokens: 0 }
  const oneHourTokens = Math.max(0, usage.cacheCreation1hTokens ?? 0)
  const hasDetailedBreakdown =
    usage.cacheCreation5mTokens != null || usage.cacheCreation1hTokens != null
  const detailedTotal = Math.max(0, usage.cacheCreation5mTokens ?? 0) + oneHourTokens
  const fiveMinuteTokens = hasDetailedBreakdown
    ? Math.max(0, usage.cacheCreation5mTokens ?? 0) + Math.max(total - detailedTotal, 0)
    : total
  return { fiveMinuteTokens, oneHourTokens }
}

export function getCacheHitRate(
  billableInputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens = 0
): number {
  const safeBillableInputTokens = Number.isFinite(billableInputTokens)
    ? Math.max(0, billableInputTokens)
    : 0
  const safeCacheReadTokens = Number.isFinite(cacheReadTokens) ? Math.max(0, cacheReadTokens) : 0
  const safeCacheCreationTokens = Number.isFinite(cacheCreationTokens)
    ? Math.max(0, cacheCreationTokens)
    : 0
  // Cache-creation tokens are cache misses billed at write price, so they belong in the
  // denominator: the hit rate reflects the share of all input tokens served from cache.
  const totalInputTokens = safeBillableInputTokens + safeCacheReadTokens + safeCacheCreationTokens

  if (totalInputTokens <= 0) return 0
  return safeCacheReadTokens / totalInputTokens
}

export function getCacheReadRatio(inputTokens: number, cacheReadTokens: number): number {
  const safeInputTokens = Number.isFinite(inputTokens) ? Math.max(0, inputTokens) : 0
  const safeCacheReadTokens = Number.isFinite(cacheReadTokens) ? Math.max(0, cacheReadTokens) : 0

  if (safeInputTokens <= 0) return 0
  return Math.min(1, safeCacheReadTokens / safeInputTokens)
}

export function formatCacheHitRate(rate: number): string {
  const safeRate = Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 0
  const percent = Math.round(safeRate * 1000) / 10
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)}%`
}

export function getUsageCacheHitRate(
  usage: TokenUsage,
  requestType?: ProviderType | AIModelConfig['type']
): number {
  return getCacheHitRate(
    getBillableInputTokens(usage, requestType),
    usage.cacheReadTokens ?? 0,
    getCacheCreationTokens(usage)
  )
}

export function getBillableTotalTokens(
  usage: TokenUsage,
  requestType?: ProviderType | AIModelConfig['type']
): number {
  return getBillableInputTokens(usage, requestType) + (usage.outputTokens ?? 0)
}

/**
 * Whole billed input side of a request (billable input + cache read + cache write).
 * This is the size tier-priced models bracket on.
 */
export function getPromptTokens(
  usage: TokenUsage,
  requestType?: ProviderType | AIModelConfig['type']
): number {
  return (
    getBillableInputTokens(usage, requestType) +
    Math.max(0, usage.cacheReadTokens ?? 0) +
    getCacheCreationTokens(usage)
  )
}

export function resolveCacheCreationCost(
  usage: TokenUsage,
  model: AIModelConfig | null | undefined,
  at?: Date
): { price: number | null; cost: number | null } {
  const prices = resolveModelPrices(model, at, getPromptTokens(usage, model?.type))
  const totalCacheCreationTokens = getCacheCreationTokens(usage)

  if (totalCacheCreationTokens <= 0) {
    return {
      price:
        prices.cacheCreationPrice ?? (prices.inputPrice != null ? prices.inputPrice * 1.25 : null),
      cost: 0
    }
  }

  const { fiveMinuteTokens: cacheCreation5mTokens, oneHourTokens: cacheCreation1hTokens } =
    getCacheCreationSplit(usage)
  const cacheCreation5mPrice =
    prices.cacheCreationPrice ?? (prices.inputPrice != null ? prices.inputPrice * 1.25 : null)
  const cacheCreation1hPrice = prices.inputPrice != null ? prices.inputPrice * 2 : null

  if (cacheCreation5mPrice == null || (cacheCreation1hTokens > 0 && cacheCreation1hPrice == null)) {
    return { price: null, cost: null }
  }

  const cost =
    (cacheCreation5mTokens * cacheCreation5mPrice +
      cacheCreation1hTokens * (cacheCreation1hPrice ?? 0)) /
    1_000_000

  return {
    price: cost > 0 ? (cost * 1_000_000) / totalCacheCreationTokens : cacheCreation5mPrice,
    cost
  }
}

export interface TokenCostBreakdown {
  inputCost: number | null
  outputCost: number | null
  cacheCreationCost: number | null
  cacheReadCost: number | null
  totalCost: number | null
}

export function calculateCostBreakdown(
  usage: TokenUsage,
  model: AIModelConfig | null | undefined,
  at?: Date
): TokenCostBreakdown {
  const prices = resolveModelPrices(model, at, getPromptTokens(usage, model?.type))
  const inputPrice = prices.inputPrice
  const outputPrice = prices.outputPrice
  const cacheCreationTokens = getCacheCreationTokens(usage)
  const billableInput = getBillableInputTokens(usage, model?.type)
  const cacheReadPrice = prices.cacheHitPrice ?? (inputPrice != null ? inputPrice * 0.1 : null)
  const { cost: cacheCreationCost } = resolveCacheCreationCost(usage, model, at)

  const inputCost = inputPrice == null ? null : (billableInput * inputPrice) / 1_000_000
  const outputCost =
    outputPrice == null ? null : ((usage.outputTokens ?? 0) * outputPrice) / 1_000_000
  const resolvedCacheCreationCost =
    cacheCreationTokens > 0 ? cacheCreationCost : inputPrice == null ? null : 0
  const cacheReadCost =
    cacheReadPrice == null ? null : ((usage.cacheReadTokens ?? 0) * cacheReadPrice) / 1_000_000
  const pieces = [inputCost, outputCost, resolvedCacheCreationCost, cacheReadCost]
  const totalCost = pieces.every((item) => item == null)
    ? null
    : pieces.reduce<number>((sum, item) => sum + (item ?? 0), 0)

  return {
    inputCost,
    outputCost,
    cacheCreationCost: resolvedCacheCreationCost,
    cacheReadCost,
    totalCost
  }
}

/**
 * Calculate the USD cost of a request based on token usage and model pricing.
 * Prices in AIModelConfig are per **million** tokens.
 * Returns null if pricing info is unavailable.
 */
export function calculateCost(
  usage: TokenUsage,
  model: AIModelConfig | null | undefined,
  at?: Date
): number | null {
  const prices = resolveModelPrices(model, at, getPromptTokens(usage, model?.type))
  if (!model || prices.inputPrice == null || prices.outputPrice == null) return null

  const cacheCreationTokens = getCacheCreationTokens(usage)
  const { totalCost, cacheCreationCost } = calculateCostBreakdown(usage, model, at)
  if (cacheCreationTokens > 0 && cacheCreationCost == null) return null
  return totalCost
}

/**
 * Format a USD cost value into a display string.
 * Examples: 0.001 → "<$0.01", 0.05 → "$0.05", 1.234 → "$1.23"
 */
export function formatCost(cost: number): string {
  if (cost < 0.001) return '<$0.001'
  if (cost < 0.01) return `$${cost.toFixed(3)}`
  return `$${cost.toFixed(2)}`
}

/**
 * Estimate the number of tokens in a string using OpenAI's tokenizer (cl100k_base).
 * Use this only when the LLM does not provide token usage — prefer API-reported counts.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return encode(text, { allowedSpecial: 'all' }).length
}
