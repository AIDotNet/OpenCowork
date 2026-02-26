import { encode } from 'gpt-tokenizer'
import type { TokenUsage, AIModelConfig } from './api/types'

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
 * Calculate the USD cost of a request based on token usage and model pricing.
 * Prices in AIModelConfig are per **million** tokens.
 * Returns null if pricing info is unavailable.
 */
export function calculateCost(usage: TokenUsage, model: AIModelConfig | null | undefined): number | null {
  if (!model || model.inputPrice == null || model.outputPrice == null) return null

  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheCreation = usage.cacheCreationTokens ?? 0
  const inputTokens = usage.inputTokens ?? 0
  const rawInputTokens = usage.contextTokens ?? (cacheRead > inputTokens ? inputTokens + cacheRead : inputTokens)
  const normalInput = Math.max(0, rawInputTokens - cacheRead)
  const cacheReadPrice = model.cacheHitPrice ?? model.inputPrice * 0.1
  const cacheCreationPriceVal = model.cacheCreationPrice ?? model.inputPrice * 1.25
  const inputCost = (normalInput * model.inputPrice + cacheRead * cacheReadPrice + cacheCreation * cacheCreationPriceVal) / 1_000_000

  const outputCost = (usage.outputTokens * model.outputPrice) / 1_000_000
  return inputCost + outputCost
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
