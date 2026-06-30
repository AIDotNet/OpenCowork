import type { TokenUsage } from '../api/types'
import { calculateCacheReadRatio } from './cache-shape'

function positive(value: number | null | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function hasRequestTiming(usage: Partial<TokenUsage>): boolean {
  return Array.isArray(usage.requestTimings) && usage.requestTimings.length > 0
}

function isContextOnlyUsagePatch(usage: Partial<TokenUsage>): boolean {
  const hasAccountingTokens =
    positive(usage.inputTokens) ||
    positive(usage.outputTokens) ||
    positive(usage.billableInputTokens) ||
    positive(usage.cacheCreationTokens) ||
    positive(usage.cacheCreation5mTokens) ||
    positive(usage.cacheCreation1hTokens) ||
    positive(usage.cacheReadTokens) ||
    positive(usage.reasoningTokens) ||
    positive(usage.totalDurationMs) ||
    hasRequestTiming(usage)

  return (
    !hasAccountingTokens &&
    (positive(usage.contextTokens) || positive(usage.contextLength)) &&
    (usage.inputTokens ?? 0) === 0 &&
    (usage.outputTokens ?? 0) === 0
  )
}

export function mergeUsageSnapshot(
  current: TokenUsage | undefined,
  incoming: Partial<TokenUsage> | undefined
): TokenUsage | undefined {
  if (!incoming) return current

  const merged: TokenUsage = current
    ? { ...current }
    : {
        inputTokens: 0,
        outputTokens: 0
      }
  const contextOnlyPatch = current ? isContextOnlyUsagePatch(incoming) : false

  for (const [key, value] of Object.entries(incoming) as Array<
    [keyof TokenUsage, TokenUsage[keyof TokenUsage]]
  >) {
    if (value === undefined) continue
    if (contextOnlyPatch && (key === 'inputTokens' || key === 'outputTokens')) {
      continue
    }
    ;(merged as Record<keyof TokenUsage, TokenUsage[keyof TokenUsage]>)[key] = value
  }

  const cacheReadRatio = calculateCacheReadRatio(merged)
  if (cacheReadRatio === undefined) {
    delete merged.cacheReadRatio
  } else {
    merged.cacheReadRatio = cacheReadRatio
  }

  return merged
}
