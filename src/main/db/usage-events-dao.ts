import { getNativeWorker } from '../lib/native-worker'

let cleanupInFlight: Promise<UsageEventsCleanupResult> | null = null

export interface UsageEventRow {
  id: string
  created_at: number
  request_started_at: number | null
  request_finished_at: number | null
  session_id: string | null
  message_id: string | null
  project_id: string | null
  source_kind: string
  provider_id: string | null
  provider_name: string | null
  provider_type: string | null
  provider_builtin_id: string | null
  provider_base_url: string | null
  model_id: string | null
  model_name: string | null
  model_category: string | null
  request_type: string | null
  input_tokens: number
  billable_input_tokens: number | null
  output_tokens: number
  cache_creation_tokens: number | null
  cache_read_tokens: number | null
  reasoning_tokens: number | null
  context_tokens: number | null
  input_price: number | null
  output_price: number | null
  cache_creation_price: number | null
  cache_hit_price: number | null
  input_cost_usd: number | null
  output_cost_usd: number | null
  cache_creation_cost_usd: number | null
  cache_hit_cost_usd: number | null
  total_cost_usd: number | null
  ttft_ms: number | null
  total_ms: number | null
  tps: number | null
  provider_response_id: string | null
  request_debug_json: string | null
  usage_raw_json: string | null
  meta_json: string | null
}

export interface UsageEventsQuery {
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

export type UsageTimelineBucket = 'hour' | 'day'

export interface UsageEventsCleanupResult {
  cutoff: number
  deleted: number
}

interface NativeUsageMaintenanceResult extends UsageEventsCleanupResult {
  success: boolean
  dbPath: string
  error?: string | null
}

export type UsageEventListRow = Omit<
  UsageEventRow,
  'request_debug_json' | 'usage_raw_json' | 'meta_json'
> & {
  request_debug_chars: number
  usage_raw_chars: number
  meta_chars: number
}

interface NativeUsageAnalyticsResult {
  success: boolean
  row?: Record<string, unknown> | null
  rows?: Record<string, unknown>[] | null
  deleted?: number
  error?: string | null
}

interface NativeUsageAddEventResult {
  success: boolean
  dbPath: string
  id?: string | null
  createdAt?: number | null
  error?: string | null
}

async function usageQuery(
  operation: string,
  params: object,
  timeoutMs = 120_000
): Promise<NativeUsageAnalyticsResult> {
  const result = await getNativeWorker().request<NativeUsageAnalyticsResult>(
    'db/usage-query',
    { operation, ...params },
    timeoutMs
  )
  if (!result.success) {
    throw new Error(result.error || 'Native usage query failed: ' + operation)
  }
  return result
}

async function usageQueryRow(operation: string, params: object): Promise<Record<string, unknown>> {
  const result = await usageQuery(operation, params)
  return result.row ?? {}
}

async function usageQueryRows(
  operation: string,
  params: object
): Promise<Record<string, unknown>[]> {
  const result = await usageQuery(operation, params)
  return result.rows ?? []
}

export async function addUsageEvent(
  event: Omit<UsageEventRow, 'created_at'> & { created_at?: number }
): Promise<void> {
  const result = await getNativeWorker().request<NativeUsageAddEventResult>(
    'db/usage-add-event',
    event,
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native usage event insert failed')
  }
}

export function getUsageOverview(query: UsageEventsQuery): Promise<Record<string, unknown>> {
  return usageQueryRow('overview', query)
}

export function getUsageDaily(query: UsageEventsQuery): Promise<Record<string, unknown>[]> {
  return usageQueryRows('daily', query)
}

export function getUsageTimeline(
  query: UsageEventsQuery,
  bucket: UsageTimelineBucket
): Promise<Record<string, unknown>[]> {
  return usageQueryRows('timeline', { ...query, bucket })
}

export function getUsageByModel(query: UsageEventsQuery): Promise<Record<string, unknown>[]> {
  return usageQueryRows('by-model', query)
}

export function getUsageByProvider(query: UsageEventsQuery): Promise<Record<string, unknown>[]> {
  return usageQueryRows('by-provider', query)
}

export function getUsageActivityOverview(
  query: UsageActivityQuery
): Promise<Record<string, unknown>> {
  return usageQueryRow('activity-overview', query)
}

export function getUsageActivityDaily(
  query: UsageActivityQuery
): Promise<Record<string, unknown>[]> {
  return usageQueryRows('activity-daily', query)
}

export function getUsageActivityByModel(
  query: UsageActivityQuery
): Promise<Record<string, unknown>[]> {
  return usageQueryRows('activity-by-model', query)
}

export function getUsageActivityByProvider(
  query: UsageActivityQuery
): Promise<Record<string, unknown>[]> {
  return usageQueryRows('activity-by-provider', query)
}

export async function deleteUsageEvents(query: UsageEventsQuery): Promise<{ deleted: number }> {
  const result = await usageQuery('delete', query)
  return { deleted: result.deleted ?? 0 }
}

async function cleanupExpiredUsageEventsInternal(): Promise<UsageEventsCleanupResult> {
  const result = await getNativeWorker().request<NativeUsageMaintenanceResult>(
    'db/usage-maintenance',
    {},
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native usage maintenance failed')
  }

  return {
    cutoff: result.cutoff,
    deleted: result.deleted
  }
}

export function cleanupExpiredUsageEvents(): Promise<UsageEventsCleanupResult> {
  if (!cleanupInFlight) {
    cleanupInFlight = cleanupExpiredUsageEventsInternal().finally(() => {
      cleanupInFlight = null
    })
  }

  return cleanupInFlight
}

export function listUsageEvents(query: UsageEventsQuery): Promise<UsageEventListRow[]> {
  return usageQueryRows('list', query) as Promise<UsageEventListRow[]>
}
