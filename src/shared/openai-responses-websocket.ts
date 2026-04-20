export type ResponsesWebsocketMode = 'auto' | 'disabled'
export type ResponsesWebsocketRequestKind = 'warmup' | 'full' | 'incremental'
export type ResponsesWebsocketIncrementalReason =
  | 'warmup'
  | 'matched'
  | 'no_prior_request'
  | 'missing_previous_response_id'
  | 'request_shape_changed'
  | 'input_prefix_mismatch'

export const OPENAI_RESPONSES_WEBSOCKET_BETA_HEADER = 'OpenAI-Beta'
export const OPENAI_RESPONSES_WEBSOCKET_BETA_VALUE = 'responses_websockets=2026-02-06'
export const RESPONSES_WEBSOCKET_CONNECTION_MAX_AGE_MS = 55 * 60 * 1000
export const RESPONSES_WEBSOCKET_CONNECTION_MAX_IDLE_MS = 10 * 60 * 1000
export const RESPONSES_WEBSOCKET_CONNECTION_MAX_REQUESTS = 12
export const DEFAULT_RESPONSES_WEBSOCKET_SESSION_SCOPE = 'main'
export const RESPONSES_WEBSOCKET_AGENT_MAIN_SCOPE = 'agent-main'
export const RESPONSES_WEBSOCKET_SUB_AGENT_SCOPE_PREFIX = 'sub-agent'

export interface ResponsesWebsocketPreparedRequest {
  kind: ResponsesWebsocketRequestKind
  incrementalReason: ResponsesWebsocketIncrementalReason
  fullRequest: Record<string, unknown>
  payloadObject: Record<string, unknown>
  payload: string
  previousResponseId?: string
}

export interface ResponsesWebsocketSessionStateSnapshot {
  lastFullRequest?: Record<string, unknown> | null
  lastCompletedResponseId?: string | null
  lastResponseOutputItems?: unknown[] | null
}

export interface ResponsesWebsocketCompletionState {
  responseId?: string
  outputItems: unknown[]
}

export interface ResolvedResponsesWebsocketConfig {
  mode: ResponsesWebsocketMode
  websocketUrl: string | null
  source: 'explicit' | 'derived' | 'disabled' | 'invalid' | 'unsupported'
  reason?: 'disabled' | 'invalid_explicit_url' | 'derived_url_invalid' | 'unsupported_provider'
}

export function normalizeResponsesWebsocketSessionScope(value: string | null | undefined): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || DEFAULT_RESPONSES_WEBSOCKET_SESSION_SCOPE
}

export function shouldEnableResponsesWebsocketForScope(value: string | null | undefined): boolean {
  const scope = normalizeResponsesWebsocketSessionScope(value)
  return (
    scope === RESPONSES_WEBSOCKET_AGENT_MAIN_SCOPE ||
    scope === RESPONSES_WEBSOCKET_SUB_AGENT_SCOPE_PREFIX ||
    scope.startsWith(`${RESPONSES_WEBSOCKET_SUB_AGENT_SCOPE_PREFIX}:`)
  )
}

export function buildResponsesWebsocketSessionKey(args: {
  providerKey: string
  model?: string | null
  sessionId?: string | null
  websocketUrl: string
  sessionScope?: string | null
}): string | null {
  const model = args.model?.trim()
  const sessionId = args.sessionId?.trim()
  if (!model || !sessionId) {
    return null
  }

  return `${args.providerKey}::${model}::${sessionId}::${normalizeResponsesWebsocketSessionScope(
    args.sessionScope
  )}::${args.websocketUrl}`
}

export function normalizeResponsesWebsocketMode(
  value: string | null | undefined
): ResponsesWebsocketMode {
  return value === 'disabled' ? 'disabled' : 'auto'
}

export function isValidResponsesWebsocketUrl(value: string | null | undefined): boolean {
  if (!value) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'ws:' || parsed.protocol === 'wss:'
  } catch {
    return false
  }
}

export function deriveResponsesWebsocketUrl(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null

  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    return null
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null
  }

  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'

  const normalizedPath = parsed.pathname.replace(/\/+$/, '')
  parsed.pathname = /\/responses$/i.test(normalizedPath)
    ? normalizedPath || '/responses'
    : `${normalizedPath || ''}/responses`

  const derived = parsed.toString()
  return isValidResponsesWebsocketUrl(derived) ? derived : null
}

export function resolveResponsesWebsocketConfig(args: {
  providerType?: string | null
  websocketMode?: string | null
  websocketUrl?: string | null
  baseUrl?: string | null
  sessionScope?: string | null
}): ResolvedResponsesWebsocketConfig {
  if (args.providerType !== 'openai-responses') {
    return {
      mode: normalizeResponsesWebsocketMode(args.websocketMode),
      websocketUrl: null,
      source: 'unsupported',
      reason: 'unsupported_provider'
    }
  }

  const mode = normalizeResponsesWebsocketMode(args.websocketMode)
  if (mode === 'disabled') {
    return { mode, websocketUrl: null, source: 'disabled', reason: 'disabled' }
  }
  if (!shouldEnableResponsesWebsocketForScope(args.sessionScope)) {
    return { mode: 'disabled', websocketUrl: null, source: 'disabled', reason: 'disabled' }
  }

  const explicitUrl = args.websocketUrl?.trim()
  if (explicitUrl) {
    if (!isValidResponsesWebsocketUrl(explicitUrl)) {
      return {
        mode,
        websocketUrl: null,
        source: 'invalid',
        reason: 'invalid_explicit_url'
      }
    }
    return { mode, websocketUrl: explicitUrl, source: 'explicit' }
  }

  const derivedUrl = deriveResponsesWebsocketUrl(args.baseUrl)
  if (!derivedUrl) {
    return {
      mode,
      websocketUrl: null,
      source: 'invalid',
      reason: 'derived_url_invalid'
    }
  }

  return { mode, websocketUrl: derivedUrl, source: 'derived' }
}

export function buildResponsesWebsocketHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const websocketHeaders = { ...headers }
  const hasBetaHeader = Object.keys(websocketHeaders).some(
    (key) => key.toLowerCase() === OPENAI_RESPONSES_WEBSOCKET_BETA_HEADER.toLowerCase()
  )

  if (!hasBetaHeader) {
    websocketHeaders[OPENAI_RESPONSES_WEBSOCKET_BETA_HEADER] = OPENAI_RESPONSES_WEBSOCKET_BETA_VALUE
  }

  return websocketHeaders
}

export function buildResponsesWebsocketCreatePayload(
  requestBody: string | Record<string, unknown> | null | undefined
): string {
  return JSON.stringify(buildResponsesWebsocketCreateObject(requestBody))
}

export function buildResponsesWebsocketCreateObject(
  requestBody: string | Record<string, unknown> | null | undefined,
  overrides?: Record<string, unknown>
): Record<string, unknown> {
  return {
    type: 'response.create',
    ...normalizeResponsesWebsocketRequestBody(requestBody),
    ...(overrides ?? {})
  }
}

export function normalizeResponsesWebsocketRequestBody(
  requestBody: string | Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const parsed = parseResponsesRequestBody(requestBody)
  delete parsed.stream
  delete parsed.background
  return parsed
}

export function prepareResponsesWebsocketRequest(args: {
  requestBody: string | Record<string, unknown> | null | undefined
  session?: ResponsesWebsocketSessionStateSnapshot | null
  warmup?: boolean
}): ResponsesWebsocketPreparedRequest {
  const fullRequest = normalizeResponsesWebsocketRequestBody(args.requestBody)
  if (args.warmup) {
    const payloadObject = {
      ...cloneJsonValue(fullRequest),
      generate: false
    } as Record<string, unknown>
    return {
      kind: 'warmup',
      incrementalReason: 'warmup',
      fullRequest,
      payloadObject,
      payload: JSON.stringify({
        type: 'response.create',
        ...payloadObject
      })
    }
  }

  const lastFullRequest = args.session?.lastFullRequest
    ? normalizeResponsesWebsocketRequestBody(args.session.lastFullRequest)
    : null
  const lastCompletedResponseId = args.session?.lastCompletedResponseId?.trim() ?? ''
  const lastResponseOutputItems = Array.isArray(args.session?.lastResponseOutputItems)
    ? normalizeResponsesOutputItemsForReplayInput(args.session?.lastResponseOutputItems ?? [])
    : []

  if (!lastFullRequest) {
    const payloadObject = cloneJsonValue(fullRequest) as Record<string, unknown>
    return {
      kind: 'full',
      incrementalReason: 'no_prior_request',
      fullRequest,
      payloadObject,
      payload: JSON.stringify({
        type: 'response.create',
        ...payloadObject
      })
    }
  }

  if (!lastCompletedResponseId) {
    const payloadObject = cloneJsonValue(fullRequest) as Record<string, unknown>
    return {
      kind: 'full',
      incrementalReason: 'missing_previous_response_id',
      fullRequest,
      payloadObject,
      payload: JSON.stringify({
        type: 'response.create',
        ...payloadObject
      })
    }
  }

  const previousWithoutInput = stripInputForComparison(lastFullRequest)
  const currentWithoutInput = stripInputForComparison(fullRequest)
  if (!deepEqualJson(previousWithoutInput, currentWithoutInput)) {
    const payloadObject = cloneJsonValue(fullRequest) as Record<string, unknown>
    return {
      kind: 'full',
      incrementalReason: 'request_shape_changed',
      fullRequest,
      payloadObject,
      payload: JSON.stringify({
        type: 'response.create',
        ...payloadObject
      })
    }
  }

  const baselineInput = [
    ...cloneJsonArray(Array.isArray(lastFullRequest.input) ? lastFullRequest.input : []),
    ...cloneJsonArray(lastResponseOutputItems)
  ]
  const currentInput = cloneJsonArray(Array.isArray(fullRequest.input) ? fullRequest.input : [])

  if (
    currentInput.length >= baselineInput.length &&
    baselineInput.every((item, index) => deepEqualJson(item, currentInput[index]))
  ) {
    const payloadObject = {
      ...cloneJsonValue(fullRequest),
      previous_response_id: lastCompletedResponseId,
      input: currentInput.slice(baselineInput.length)
    } as Record<string, unknown>

    return {
      kind: 'incremental',
      incrementalReason: 'matched',
      fullRequest,
      payloadObject,
      payload: JSON.stringify({
        type: 'response.create',
        ...payloadObject
      }),
      previousResponseId: lastCompletedResponseId
    }
  }

  const payloadObject = cloneJsonValue(fullRequest) as Record<string, unknown>
  return {
    kind: 'full',
    incrementalReason: 'input_prefix_mismatch',
    fullRequest,
    payloadObject,
    payload: JSON.stringify({
      type: 'response.create',
      ...payloadObject
    })
  }
}

export function extractResponsesWebsocketCompletionState(
  payload: unknown
): ResponsesWebsocketCompletionState | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as {
    type?: unknown
    response?: {
      id?: unknown
      output?: unknown
    }
  }
  if (
    record.type !== 'response.completed' ||
    !record.response ||
    typeof record.response !== 'object'
  ) {
    return null
  }

  return {
    responseId: typeof record.response.id === 'string' ? record.response.id : undefined,
    outputItems: cloneJsonArray(Array.isArray(record.response.output) ? record.response.output : [])
  }
}

export function isResponsesWsConnectionLimitReached(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const record = payload as {
    code?: unknown
    error?: { code?: unknown }
  }
  return (
    record.code === 'websocket_connection_limit_reached' ||
    record.error?.code === 'websocket_connection_limit_reached'
  )
}

export function getResponsesWsFailureReason(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback
  const record = payload as {
    type?: unknown
    code?: unknown
    message?: unknown
    error?: { code?: unknown; type?: unknown; message?: unknown }
  }
  const candidates = [
    record.error?.code,
    record.code,
    record.error?.message,
    record.message,
    record.error?.type,
    record.type
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim()
    }
  }
  return fallback
}

export function isResponsesWsFirstModelEvent(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const record = payload as {
    type?: unknown
    item?: { type?: unknown }
  }
  switch (record.type) {
    case 'response.output_text.delta':
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_summary_text.done':
    case 'response.function_call_arguments.delta':
    case 'response.function_call_arguments.done':
      return true
    case 'response.output_item.added':
    case 'response.output_item.done':
      return (
        record.item?.type === 'function_call' ||
        record.item?.type === 'computer_call' ||
        record.item?.type === 'reasoning'
      )
    default:
      return false
  }
}

export function normalizeResponsesOutputItemsForReplayInput(outputItems: unknown[]): unknown[] {
  const normalized: unknown[] = []
  for (const item of outputItems) {
    const normalizedItem = normalizeResponsesOutputItemForReplayInput(item)
    if (normalizedItem) {
      normalized.push(normalizedItem)
    }
  }
  return normalized
}

function parseResponsesRequestBody(
  requestBody: string | Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const parsed =
    typeof requestBody === 'string'
      ? ((requestBody ? JSON.parse(requestBody) : {}) as unknown)
      : cloneJsonValue(requestBody ?? {})

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {}
  }

  return parsed as Record<string, unknown>
}

function stripInputForComparison(value: Record<string, unknown>): Record<string, unknown> {
  const cloned = normalizeResponsesWebsocketRequestBody(value)
  delete cloned.input
  return cloned
}

function normalizeResponsesOutputItemForReplayInput(item: unknown): Record<string, unknown> | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const record = item as Record<string, unknown>
  switch (record.type) {
    case 'message':
      return normalizeResponsesMessageOutputItem(record)
    case 'reasoning':
      return normalizeResponsesReasoningOutputItem(record)
    case 'function_call':
      return normalizeResponsesFunctionCallOutputItem(record)
    default:
      return null
  }
}

function normalizeResponsesMessageOutputItem(
  item: Record<string, unknown>
): Record<string, unknown> | null {
  const role = typeof item.role === 'string' ? item.role : null
  if (!role) return null

  const content = normalizeResponsesMessageContentForReplay(item.content, role)
  if (content == null) return null

  return {
    type: 'message',
    role,
    content
  }
}

function normalizeResponsesMessageContentForReplay(
  content: unknown,
  role: string
): string | Array<Record<string, unknown>> | null {
  if (typeof content === 'string') {
    return content ? content : null
  }

  if (!Array.isArray(content)) return null

  const textParts: string[] = []
  const userParts: Array<Record<string, unknown>> = []

  for (const part of content) {
    if (typeof part === 'string') {
      textParts.push(part)
      userParts.push({ type: 'input_text', text: part })
      continue
    }

    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      continue
    }

    const record = part as Record<string, unknown>
    if (
      (record.type === 'output_text' || record.type === 'input_text') &&
      typeof record.text === 'string'
    ) {
      textParts.push(record.text)
      userParts.push({ type: 'input_text', text: record.text })
      continue
    }

    if (record.type === 'input_image' && typeof record.image_url === 'string') {
      userParts.push({ type: 'input_image', image_url: record.image_url })
    }
  }

  if (role === 'user' && userParts.length > 0) {
    return userParts
  }

  const text = textParts.join('')
  return text ? text : null
}

function normalizeResponsesReasoningOutputItem(
  item: Record<string, unknown>
): Record<string, unknown> | null {
  const encryptedContent =
    typeof item.encrypted_content === 'string'
      ? item.encrypted_content
      : getObjectString(item.reasoning, 'encrypted_content')
  if (!encryptedContent) return null

  return {
    type: 'reasoning',
    summary: normalizeResponsesReasoningSummaryForReplay(
      item.summary ?? getObjectValue(item.reasoning, 'summary')
    ),
    encrypted_content: encryptedContent
  }
}

function normalizeResponsesReasoningSummaryForReplay(
  summary: unknown
): Array<Record<string, unknown>> {
  if (typeof summary === 'string') {
    return summary ? [{ type: 'summary_text', text: summary }] : []
  }

  if (!Array.isArray(summary)) return []

  const normalized: Array<Record<string, unknown>> = []
  for (const part of summary) {
    if (typeof part === 'string') {
      if (part) normalized.push({ type: 'summary_text', text: part })
      continue
    }

    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      continue
    }

    const text = (part as { text?: unknown }).text
    if (typeof text === 'string' && text) {
      normalized.push({ type: 'summary_text', text })
    }
  }
  return normalized
}

function normalizeResponsesFunctionCallOutputItem(
  item: Record<string, unknown>
): Record<string, unknown> | null {
  const callId = typeof item.call_id === 'string' ? item.call_id : null
  const name = typeof item.name === 'string' ? item.name : null
  if (!callId || !name) return null

  return {
    type: 'function_call',
    call_id: callId,
    name,
    arguments: stringifyResponsesReplayValue(item.arguments),
    status: 'completed'
  }
}

function stringifyResponsesReplayValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function getObjectValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return (value as Record<string, unknown>)[key]
}

function getObjectString(value: unknown, key: string): string | undefined {
  const candidate = getObjectValue(value, key)
  return typeof candidate === 'string' ? candidate : undefined
}

function cloneJsonArray(value: unknown[]): unknown[] {
  return cloneJsonValue(value) as unknown[]
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function deepEqualJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left == null || right == null) return left === right
  if (typeof left !== typeof right) return false

  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => deepEqualJson(value, right[index]))
  }

  if (typeof left === 'object') {
    if (Array.isArray(right)) return false
    const leftRecord = left as Record<string, unknown>
    const rightRecord = right as Record<string, unknown>
    const leftKeys = Object.keys(leftRecord).sort()
    const rightKeys = Object.keys(rightRecord).sort()
    if (leftKeys.length !== rightKeys.length) return false
    for (let index = 0; index < leftKeys.length; index += 1) {
      if (leftKeys[index] !== rightKeys[index]) return false
      if (!deepEqualJson(leftRecord[leftKeys[index]], rightRecord[rightKeys[index]])) {
        return false
      }
    }
    return true
  }

  return false
}
