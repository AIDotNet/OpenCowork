import { getDb } from './database'

const EFFECTIVE_INPUT_TOKENS_EXPR = `COALESCE(
  billable_input_tokens,
  CASE
    WHEN request_type = 'openai-responses' THEN MAX(input_tokens - COALESCE(cache_read_tokens, 0), 0)
    ELSE input_tokens
  END
)`

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

export function addUsageEvent(
  event: Omit<UsageEventRow, 'created_at'> & { created_at?: number }
): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO usage_events (
      id, created_at, request_started_at, request_finished_at, session_id, message_id, project_id,
      source_kind, provider_id, provider_name, provider_type, provider_builtin_id, provider_base_url,
      model_id, model_name, model_category, request_type,
      input_tokens, billable_input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
      reasoning_tokens, context_tokens,
      input_price, output_price, cache_creation_price, cache_hit_price,
      input_cost_usd, output_cost_usd, cache_creation_cost_usd, cache_hit_cost_usd, total_cost_usd,
      ttft_ms, total_ms, tps, provider_response_id, request_debug_json, usage_raw_json, meta_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.id,
    event.created_at ?? Date.now(),
    event.request_started_at,
    event.request_finished_at,
    event.session_id,
    event.message_id,
    event.project_id,
    event.source_kind,
    event.provider_id,
    event.provider_name,
    event.provider_type,
    event.provider_builtin_id,
    event.provider_base_url,
    event.model_id,
    event.model_name,
    event.model_category,
    event.request_type,
    event.input_tokens,
    event.billable_input_tokens,
    event.output_tokens,
    event.cache_creation_tokens,
    event.cache_read_tokens,
    event.reasoning_tokens,
    event.context_tokens,
    event.input_price,
    event.output_price,
    event.cache_creation_price,
    event.cache_hit_price,
    event.input_cost_usd,
    event.output_cost_usd,
    event.cache_creation_cost_usd,
    event.cache_hit_cost_usd,
    event.total_cost_usd,
    event.ttft_ms,
    event.total_ms,
    event.tps,
    event.provider_response_id,
    event.request_debug_json,
    event.usage_raw_json,
    event.meta_json
  )
}

function buildWhere(query: UsageEventsQuery): { clause: string; params: unknown[] } {
  const where: string[] = ['created_at >= ?', 'created_at <= ?']
  const params: unknown[] = [query.from, query.to]
  if (query.providerId) {
    where.push('provider_id = ?')
    params.push(query.providerId)
  }
  if (query.modelId) {
    where.push('model_id = ?')
    params.push(query.modelId)
  }
  if (query.sourceKind) {
    where.push('source_kind = ?')
    params.push(query.sourceKind)
  }
  return { clause: `WHERE ${where.join(' AND ')}`, params }
}

export function getUsageOverview(query: UsageEventsQuery): Record<string, unknown> {
  const db = getDb()
  const { clause, params } = buildWhere(query)
  return (
    (db
      .prepare(
        `SELECT
          COUNT(*) AS request_count,
          COALESCE(SUM(${EFFECTIVE_INPUT_TOKENS_EXPR}), 0) AS input_tokens,
          COALESCE(SUM(${EFFECTIVE_INPUT_TOKENS_EXPR}), 0) AS billable_input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
          COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
          COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
          COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
          AVG(ttft_ms) AS avg_ttft_ms,
          AVG(total_ms) AS avg_total_ms
        FROM usage_events
        ${clause}`
      )
      .get(...params) as Record<string, unknown>) ?? {}
  )
}

export function getUsageDaily(query: UsageEventsQuery): Record<string, unknown>[] {
  const db = getDb()
  const { clause, params } = buildWhere(query)
  return db
    .prepare(
      `SELECT
        strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day,
        COUNT(*) AS request_count,
        COALESCE(SUM(${EFFECTIVE_INPUT_TOKENS_EXPR}), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
        AVG(ttft_ms) AS avg_ttft_ms,
        AVG(total_ms) AS avg_total_ms
      FROM usage_events
      ${clause}
      GROUP BY day
      ORDER BY day DESC`
    )
    .all(...params) as Record<string, unknown>[]
}

export function getUsageByModel(query: UsageEventsQuery): Record<string, unknown>[] {
  const db = getDb()
  const { clause, params } = buildWhere(query)
  return db
    .prepare(
      `SELECT
        model_id,
        model_name,
        provider_id,
        provider_name,
        COUNT(*) AS request_count,
        COALESCE(SUM(${EFFECTIVE_INPUT_TOKENS_EXPR}), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
        AVG(ttft_ms) AS avg_ttft_ms,
        AVG(total_ms) AS avg_total_ms
      FROM usage_events
      ${clause}
      GROUP BY model_id, model_name, provider_id, provider_name
      ORDER BY total_cost_usd DESC, request_count DESC`
    )
    .all(...params) as Record<string, unknown>[]
}

export function getUsageByProvider(query: UsageEventsQuery): Record<string, unknown>[] {
  const db = getDb()
  const { clause, params } = buildWhere(query)
  return db
    .prepare(
      `SELECT
        provider_id,
        provider_name,
        provider_type,
        provider_builtin_id,
        provider_base_url,
        COUNT(*) AS request_count,
        COALESCE(SUM(${EFFECTIVE_INPUT_TOKENS_EXPR}), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
        AVG(ttft_ms) AS avg_ttft_ms,
        AVG(total_ms) AS avg_total_ms
      FROM usage_events
      ${clause}
      GROUP BY provider_id, provider_name, provider_type, provider_builtin_id, provider_base_url
      ORDER BY total_cost_usd DESC, request_count DESC`
    )
    .all(...params) as Record<string, unknown>[]
}

export function listUsageEvents(query: UsageEventsQuery): UsageEventRow[] {
  const db = getDb()
  const { clause, params } = buildWhere(query)
  const limit = Math.max(1, Math.min(200, query.limit ?? 50))
  const offset = Math.max(0, query.offset ?? 0)
  return db
    .prepare(
      `SELECT * FROM usage_events
      ${clause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as UsageEventRow[]
}
