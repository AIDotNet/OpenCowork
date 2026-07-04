import { nanoid } from 'nanoid'
import type {
  AIModelConfig,
  AIProvider,
  RequestDebugInfo,
  RequestTiming,
  TokenUsage
} from '@renderer/lib/api/types'
import { invokeMessagePackBinary } from '@renderer/lib/ipc/messagepack-ipc-client'
import { useChatStore } from '@renderer/stores/chat-store'
import { useProviderStore } from '@renderer/stores/provider-store'
import {
  getBillableInputTokens,
  getCacheCreationTokens,
  resolveCacheCreationCost
} from '@renderer/lib/format-tokens'
import { truncateRequestDebugForPersistence } from '@renderer/lib/debug-store'
import { accruePetExpFromUsage } from '@renderer/lib/pet/pet-exp'
import {
  USAGE_ACTIVITY_BY_MODEL_MSGPACK_CHANNEL,
  USAGE_ACTIVITY_BY_PROVIDER_MSGPACK_CHANNEL,
  USAGE_ACTIVITY_DAILY_MSGPACK_CHANNEL,
  USAGE_ACTIVITY_OVERVIEW_MSGPACK_CHANNEL,
  USAGE_EVENTS_ADD_MSGPACK_CHANNEL,
  USAGE_EVENTS_BY_MODEL_MSGPACK_CHANNEL,
  USAGE_EVENTS_BY_PROVIDER_MSGPACK_CHANNEL,
  USAGE_EVENTS_CLEAR_MSGPACK_CHANNEL,
  USAGE_EVENTS_DAILY_MSGPACK_CHANNEL,
  USAGE_EVENTS_LIST_MSGPACK_CHANNEL,
  USAGE_EVENTS_OVERVIEW_MSGPACK_CHANNEL,
  USAGE_EVENTS_TIMELINE_MSGPACK_CHANNEL
} from '../../../shared/messagepack/binary-ipc'

export interface UsageAnalyticsQuery {
  from: number
  to: number
  providerId?: string | null
  modelId?: string | null
  sourceKind?: string | null
  limit?: number
  offset?: number
}

export interface UsageActivityQuery {
  from: number
  to: number
  limit?: number
  offset?: number
}

export interface UsageAnalyticsOverview {
  request_count: number
  input_tokens: number
  billable_input_tokens: number
  total_input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
  reasoning_tokens: number
  total_cost_usd: number
  avg_ttft_ms: number | null
  avg_total_ms: number | null
}

export interface UsageAnalyticsGroupRow {
  [key: string]: unknown
}

export type UsageTimelineBucket = 'hour' | 'day'

function toNullableNumber(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function resolveProviderAndModel(
  providers: AIProvider[],
  input: {
    providerId?: string | null
    modelId?: string | null
    debugInfo?: RequestDebugInfo
    sessionProviderId?: string | null
    sessionModelId?: string | null
  }
): {
  providerId: string | null
  modelId: string | null
  provider: AIProvider | null
  model: AIModelConfig | null
} {
  const debugProviderId = input.debugInfo?.providerId ?? null
  const debugProviderBuiltinId = input.debugInfo?.providerBuiltinId ?? null
  const resolvedModelId = input.modelId ?? input.debugInfo?.model ?? input.sessionModelId ?? null

  let provider =
    (input.providerId ? (providers.find((item) => item.id === input.providerId) ?? null) : null) ??
    (debugProviderId ? (providers.find((item) => item.id === debugProviderId) ?? null) : null) ??
    (debugProviderBuiltinId
      ? (providers.find((item) => item.builtinId === debugProviderBuiltinId) ?? null)
      : null) ??
    (input.sessionProviderId
      ? (providers.find((item) => item.id === input.sessionProviderId) ?? null)
      : null)

  let model =
    resolvedModelId && provider
      ? (provider.models.find((item) => item.id === resolvedModelId) ?? null)
      : null

  if (!model && resolvedModelId) {
    for (const candidateProvider of providers) {
      const candidateModel = candidateProvider.models.find((item) => item.id === resolvedModelId)
      if (candidateModel) {
        provider = provider ?? candidateProvider
        model = candidateModel
        break
      }
    }
  }

  return {
    providerId:
      provider?.id ??
      input.providerId ??
      input.debugInfo?.providerId ??
      input.sessionProviderId ??
      null,
    modelId: model?.id ?? resolvedModelId,
    provider,
    model
  }
}

function computeCosts(
  usage: TokenUsage,
  modelConfig: AIModelConfig | null
): {
  inputPrice: number | null
  outputPrice: number | null
  cacheCreationPrice: number | null
  cacheHitPrice: number | null
  inputCostUsd: number | null
  outputCostUsd: number | null
  cacheCreationCostUsd: number | null
  cacheHitCostUsd: number | null
  totalCostUsd: number | null
} {
  const billableInput = getBillableInputTokens(usage, modelConfig?.type)
  const inputPrice = toNullableNumber(modelConfig?.inputPrice)
  const outputPrice = toNullableNumber(modelConfig?.outputPrice)
  const cacheHitPrice = toNullableNumber(modelConfig?.cacheHitPrice)
  const cacheCreationTokens = getCacheCreationTokens(usage)
  const { price: resolvedCacheCreationPrice, cost: resolvedCacheCreationCostUsd } =
    resolveCacheCreationCost(usage, modelConfig)
  const cacheCreationPrice = toNullableNumber(resolvedCacheCreationPrice ?? undefined)

  const inputCostUsd = inputPrice == null ? null : (billableInput * inputPrice) / 1_000_000
  const outputCostUsd =
    outputPrice == null ? null : ((usage.outputTokens ?? 0) * outputPrice) / 1_000_000
  const cacheCreationCostUsd =
    cacheCreationTokens > 0 ? resolvedCacheCreationCostUsd : cacheCreationPrice == null ? null : 0
  const cacheHitCostUsd =
    cacheHitPrice == null ? null : ((usage.cacheReadTokens ?? 0) * cacheHitPrice) / 1_000_000

  const costs = [inputCostUsd, outputCostUsd, cacheCreationCostUsd, cacheHitCostUsd]
  const totalCostUsd = costs.every((item) => item == null)
    ? null
    : costs.reduce<number>((sum, item) => sum + (item ?? 0), 0)

  return {
    inputPrice,
    outputPrice,
    cacheCreationPrice,
    cacheHitPrice,
    inputCostUsd,
    outputCostUsd,
    cacheCreationCostUsd,
    cacheHitCostUsd,
    totalCostUsd
  }
}

export async function recordUsageEvent(input: {
  sessionId?: string | null
  messageId?: string | null
  sourceKind: string
  providerId?: string | null
  modelId?: string | null
  usage?: TokenUsage
  timing?: RequestTiming
  debugInfo?: RequestDebugInfo
  providerResponseId?: string
  meta?: Record<string, unknown>
  createdAt?: number
}): Promise<void> {
  if (!input.usage && !input.timing) return

  const chatStore = useChatStore.getState()
  const providerStore = useProviderStore.getState()
  const session = input.sessionId
    ? chatStore.sessions.find((item) => item.id === input.sessionId)
    : undefined
  const {
    providerId: resolvedProviderId,
    modelId: resolvedModelId,
    provider,
    model
  } = resolveProviderAndModel(providerStore.providers, {
    providerId: input.providerId,
    modelId: input.modelId,
    debugInfo: input.debugInfo,
    sessionProviderId: session?.providerId,
    sessionModelId: session?.modelId
  })
  const usage = input.usage ?? {
    inputTokens: 0,
    outputTokens: 0
  }
  const normalizedUsage: TokenUsage = {
    ...usage,
    billableInputTokens:
      usage.billableInputTokens ?? getBillableInputTokens(usage, model?.type ?? provider?.type)
  }
  const costs = computeCosts(normalizedUsage, model)
  const createdAt = input.createdAt ?? Date.now()

  // Feed the desktop pet: token usage converts to pet experience.
  void accruePetExpFromUsage({
    modelId: resolvedModelId,
    modelName: model?.name ?? resolvedModelId,
    inputPrice: model?.inputPrice,
    tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
  })

  await invokeMessagePackBinary(USAGE_EVENTS_ADD_MSGPACK_CHANNEL, {
    id: nanoid(),
    created_at: createdAt,
    request_started_at:
      input.timing && typeof input.timing.totalMs === 'number'
        ? createdAt - input.timing.totalMs
        : null,
    request_finished_at: createdAt,
    session_id: input.sessionId ?? null,
    message_id: input.messageId ?? null,
    project_id: session?.projectId ?? null,
    source_kind: input.sourceKind,
    provider_id: resolvedProviderId,
    provider_name: provider?.name ?? null,
    provider_type: provider?.type ?? null,
    provider_builtin_id: provider?.builtinId ?? null,
    provider_base_url: provider?.baseUrl ?? null,
    model_id: resolvedModelId,
    model_name: model?.name ?? resolvedModelId ?? null,
    model_category: model?.category ?? null,
    request_type: model?.type ?? provider?.type ?? null,
    input_tokens: usage.inputTokens ?? 0,
    billable_input_tokens: normalizedUsage.billableInputTokens ?? null,
    output_tokens: usage.outputTokens ?? 0,
    cache_creation_tokens: usage.cacheCreationTokens ?? null,
    cache_read_tokens: usage.cacheReadTokens ?? null,
    reasoning_tokens: usage.reasoningTokens ?? null,
    context_tokens: usage.contextTokens ?? null,
    input_price: costs.inputPrice,
    output_price: costs.outputPrice,
    cache_creation_price: costs.cacheCreationPrice,
    cache_hit_price: costs.cacheHitPrice,
    input_cost_usd: costs.inputCostUsd,
    output_cost_usd: costs.outputCostUsd,
    cache_creation_cost_usd: costs.cacheCreationCostUsd,
    cache_hit_cost_usd: costs.cacheHitCostUsd,
    total_cost_usd: costs.totalCostUsd,
    ttft_ms: input.timing?.ttftMs ?? null,
    total_ms: input.timing?.totalMs ?? null,
    tps: input.timing?.tps ?? null,
    provider_response_id: input.providerResponseId ?? null,
    request_debug_json: input.debugInfo
      ? JSON.stringify(truncateRequestDebugForPersistence(input.debugInfo))
      : null,
    usage_raw_json: input.usage ? JSON.stringify(input.usage) : null,
    meta_json: input.meta ? JSON.stringify(input.meta) : null
  })
}

export function getUsageOverview(query: UsageAnalyticsQuery): Promise<UsageAnalyticsOverview> {
  return invokeMessagePackBinary<UsageAnalyticsOverview>(
    USAGE_EVENTS_OVERVIEW_MSGPACK_CHANNEL,
    query
  )
}

export function getUsageDaily(query: UsageAnalyticsQuery): Promise<UsageAnalyticsGroupRow[]> {
  return invokeMessagePackBinary<UsageAnalyticsGroupRow[]>(
    USAGE_EVENTS_DAILY_MSGPACK_CHANNEL,
    query
  )
}

export function getUsageTimeline(
  query: UsageAnalyticsQuery,
  bucket: UsageTimelineBucket
): Promise<UsageAnalyticsGroupRow[]> {
  return invokeMessagePackBinary<UsageAnalyticsGroupRow[]>(USAGE_EVENTS_TIMELINE_MSGPACK_CHANNEL, {
    query,
    bucket
  })
}

export function getUsageByModel(query: UsageAnalyticsQuery): Promise<UsageAnalyticsGroupRow[]> {
  return invokeMessagePackBinary<UsageAnalyticsGroupRow[]>(
    USAGE_EVENTS_BY_MODEL_MSGPACK_CHANNEL,
    query
  )
}

export function getUsageByProvider(query: UsageAnalyticsQuery): Promise<UsageAnalyticsGroupRow[]> {
  return invokeMessagePackBinary<UsageAnalyticsGroupRow[]>(
    USAGE_EVENTS_BY_PROVIDER_MSGPACK_CHANNEL,
    query
  )
}

export function listUsageEvents(query: UsageAnalyticsQuery): Promise<UsageAnalyticsGroupRow[]> {
  return invokeMessagePackBinary<UsageAnalyticsGroupRow[]>(USAGE_EVENTS_LIST_MSGPACK_CHANNEL, query)
}

export function clearUsageEvents(query: UsageAnalyticsQuery): Promise<{ deleted: number }> {
  return invokeMessagePackBinary<{ deleted: number }>(USAGE_EVENTS_CLEAR_MSGPACK_CHANNEL, query)
}

export function getUsageActivityOverview(
  query: UsageActivityQuery
): Promise<UsageAnalyticsOverview> {
  return invokeMessagePackBinary<UsageAnalyticsOverview>(
    USAGE_ACTIVITY_OVERVIEW_MSGPACK_CHANNEL,
    query
  )
}

export function getUsageActivityDaily(
  query: UsageActivityQuery
): Promise<UsageAnalyticsGroupRow[]> {
  return invokeMessagePackBinary<UsageAnalyticsGroupRow[]>(
    USAGE_ACTIVITY_DAILY_MSGPACK_CHANNEL,
    query
  )
}

export function getUsageActivityByModel(
  query: UsageActivityQuery
): Promise<UsageAnalyticsGroupRow[]> {
  return invokeMessagePackBinary<UsageAnalyticsGroupRow[]>(
    USAGE_ACTIVITY_BY_MODEL_MSGPACK_CHANNEL,
    query
  )
}

export function getUsageActivityByProvider(
  query: UsageActivityQuery
): Promise<UsageAnalyticsGroupRow[]> {
  return invokeMessagePackBinary<UsageAnalyticsGroupRow[]>(
    USAGE_ACTIVITY_BY_PROVIDER_MSGPACK_CHANNEL,
    query
  )
}
