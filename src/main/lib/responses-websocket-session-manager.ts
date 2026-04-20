import WebSocket from 'ws'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { readSettings } from '../ipc/settings-handlers'
import {
  RESPONSES_WEBSOCKET_CONNECTION_MAX_AGE_MS,
  RESPONSES_WEBSOCKET_CONNECTION_MAX_IDLE_MS,
  RESPONSES_WEBSOCKET_CONNECTION_MAX_REQUESTS,
  buildResponsesWebsocketCreatePayload,
  buildResponsesWebsocketHeaders,
  extractResponsesWebsocketCompletionState,
  getResponsesWsFailureReason,
  isResponsesWsConnectionLimitReached,
  isResponsesWsFirstModelEvent,
  prepareResponsesWebsocketRequest,
  type ResponsesWebsocketPreparedRequest,
  type ResponsesWebsocketRequestKind
} from '../../shared/openai-responses-websocket'

const RESPONSES_WS_CIRCUIT_BREAK_MS = 60_000
const RESPONSES_WS_FIRST_EVENT_TIMEOUT_MS = 120_000
const RESPONSES_WS_IDLE_TIMEOUT_MS = 300_000
const RESPONSES_WS_FORCE_FRESH_REASON = 'websocket_force_fresh_reconnect'
const SYSTEM_PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy'
]

interface ResponsesWsConnection {
  websocketUrl: string
  ws: WebSocket
  ready: Promise<void>
  closed: boolean
  createdAt: number
  completedRequests: number
}

interface ResponsesWsSessionState {
  key: string
  connection: ResponsesWsConnection | null
  lastFullRequest: Record<string, unknown> | null
  lastCompletedResponseId: string | null
  lastResponseOutputItems: unknown[] | null
  createdAt: number | null
  lastUsedAt: number | null
  tail: Promise<void>
  depth: number
}

interface ResponsesWsAttemptOptions {
  forceFresh?: boolean
  fallbackReason?: string
}

export interface ResponsesWsLifecycleLog {
  phase: 'connect' | 'reuse' | 'queue_wait' | 'warmup_start' | 'warmup_end' | 'fallback' | 'close'
  label?: string
  key?: string | null
  websocketUrl: string
  reason?: string
  requestKind?: ResponsesWebsocketRequestKind
  incrementalReason?: string
  previousResponseId?: string
  reusedConnection?: boolean
}

export interface ResponsesWsRequestDebug {
  url: string
  headers: Record<string, string>
  body: string
  contextWindowBody?: string
  transport: 'websocket'
  fallbackReason?: string
  reusedConnection: boolean
  websocketRequestKind: ResponsesWebsocketRequestKind
  websocketIncrementalReason: string
  previousResponseId?: string
}

export interface ExecuteResponsesWsRequestArgs {
  providerKey: string
  sessionKey?: string | null
  websocketUrl: string
  headers: Record<string, string>
  httpBody: string
  useSystemProxy?: boolean
  allowInsecureTls?: boolean
  signal?: AbortSignal
  label?: string
  fallbackReason?: string
  onDebug?: (debugInfo: ResponsesWsRequestDebug) => void
  onLifecycle?: (entry: ResponsesWsLifecycleLog) => void
  onEvent?: (eventType: string, payload: Record<string, unknown>) => void
}

export type ExecuteResponsesWsRequestResult =
  | { kind: 'streamed' }
  | { kind: 'fallback'; reason: string }
  | { kind: 'fatal'; error: string }

export class ResponsesWebSocketSessionManager {
  private readonly namespace: string
  private readonly sessions = new Map<string, ResponsesWsSessionState>()
  private readonly circuitBreakers = new Map<string, { expiresAt: number; reason: string }>()
  private readonly secureProxyAgents = new Map<string, HttpsProxyAgent<string>>()
  private readonly insecureProxyAgents = new Map<string, HttpsProxyAgent<string>>()

  constructor(namespace: string) {
    this.namespace = namespace
  }

  getCircuitReason(providerKey: string, websocketUrl: string): string | null {
    const circuitKey = this.buildCircuitKey(providerKey, websocketUrl)
    const state = this.circuitBreakers.get(circuitKey)
    if (!state) return null
    if (state.expiresAt <= Date.now()) {
      this.circuitBreakers.delete(circuitKey)
      return null
    }
    return state.reason
  }

  async executeRequest(
    args: ExecuteResponsesWsRequestArgs
  ): Promise<ExecuteResponsesWsRequestResult> {
    const circuitReason = this.getCircuitReason(args.providerKey, args.websocketUrl)
    if (circuitReason) {
      return { kind: 'fallback', reason: circuitReason }
    }

    let forceFresh = false
    let fallbackReason = args.fallbackReason
    while (true) {
      const result = args.sessionKey
        ? await this.runQueuedSessionRequest(this.getOrCreateSession(args.sessionKey), args, {
            forceFresh,
            fallbackReason
          })
        : await this.runOneShotRequest(args, { forceFresh, fallbackReason })

      if (
        result.kind === 'fallback' &&
        result.reason === 'websocket_connection_limit_reached' &&
        !forceFresh &&
        !args.signal?.aborted
      ) {
        forceFresh = true
        fallbackReason = result.reason
        continue
      }

      if (
        result.kind === 'fallback' &&
        result.reason === RESPONSES_WS_FORCE_FRESH_REASON &&
        !forceFresh &&
        !args.signal?.aborted
      ) {
        forceFresh = true
        fallbackReason = result.reason
        continue
      }

      const finalResult =
        result.kind === 'fallback' && result.reason === RESPONSES_WS_FORCE_FRESH_REASON
          ? ({ kind: 'fallback', reason: 'websocket_connection_failed' } as const)
          : result

      if (finalResult.kind === 'fallback' && !args.signal?.aborted) {
        this.setCircuitReason(args.providerKey, args.websocketUrl, finalResult.reason)
      }
      return finalResult
    }
  }

  private getOrCreateSession(sessionKey: string): ResponsesWsSessionState {
    let existing = this.sessions.get(sessionKey)
    if (existing) return existing

    existing = {
      key: sessionKey,
      connection: null,
      lastFullRequest: null,
      lastCompletedResponseId: null,
      lastResponseOutputItems: null,
      createdAt: null,
      lastUsedAt: null,
      tail: Promise.resolve(),
      depth: 0
    }
    this.sessions.set(sessionKey, existing)
    return existing
  }

  private async runQueuedSessionRequest(
    session: ResponsesWsSessionState,
    args: ExecuteResponsesWsRequestArgs,
    options: ResponsesWsAttemptOptions
  ): Promise<ExecuteResponsesWsRequestResult> {
    const waitForTurn = session.tail
    let releaseTurn!: () => void
    session.tail = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })
    const queued = session.depth > 0
    session.depth += 1

    try {
      if (queued) {
        this.emitLifecycle(args, {
          phase: 'queue_wait',
          key: session.key,
          websocketUrl: args.websocketUrl,
          reusedConnection: true
        })
      }
      await waitForAbortable(waitForTurn, args.signal)
      if (args.signal?.aborted) {
        return { kind: 'fatal', error: 'Request aborted' }
      }

      return await this.executeOnSession(session, args, { ...options, reusable: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message === 'Request aborted') {
        return { kind: 'fatal', error: 'Request aborted' }
      }
      return { kind: 'fatal', error: message }
    } finally {
      session.depth = Math.max(0, session.depth - 1)
      releaseTurn()
    }
  }

  private async runOneShotRequest(
    args: ExecuteResponsesWsRequestArgs,
    options: ResponsesWsAttemptOptions
  ): Promise<ExecuteResponsesWsRequestResult> {
    const session: ResponsesWsSessionState = {
      key: `${args.providerKey}::oneshot::${Date.now()}`,
      connection: null,
      lastFullRequest: null,
      lastCompletedResponseId: null,
      lastResponseOutputItems: null,
      createdAt: null,
      lastUsedAt: null,
      tail: Promise.resolve(),
      depth: 0
    }

    return this.executeOnSession(session, args, { ...options, reusable: false })
  }

  private async executeOnSession(
    session: ResponsesWsSessionState,
    args: ExecuteResponsesWsRequestArgs,
    options: ResponsesWsAttemptOptions & { reusable: boolean }
  ): Promise<ExecuteResponsesWsRequestResult> {
    if (args.signal?.aborted) {
      return { kind: 'fatal', error: 'Request aborted' }
    }

    const websocketHeaders = buildResponsesWebsocketHeaders(args.headers)
    const connectionResult = await this.acquireConnection(session, args, websocketHeaders, options)
    if (connectionResult.kind !== 'ok') {
      return connectionResult
    }

    const { connection, reusedConnection, warmupNeeded } = connectionResult
    if (warmupNeeded) {
      const warmupRequest = prepareResponsesWebsocketRequest({
        requestBody: args.httpBody,
        warmup: true
      })

      this.emitLifecycle(args, {
        phase: 'warmup_start',
        key: options.reusable ? session.key : null,
        requestKind: warmupRequest.kind,
        incrementalReason: warmupRequest.incrementalReason,
        websocketUrl: args.websocketUrl,
        reusedConnection
      })

      const warmupResult = await this.sendPreparedRequest({
        session,
        connection,
        args,
        preparedRequest: warmupRequest,
        reusable: options.reusable,
        reusedConnection
      })

      if (warmupResult.kind !== 'streamed') {
        if (options.reusable) {
          this.resetSessionState(session)
        }
        return warmupResult
      }

      this.emitLifecycle(args, {
        phase: 'warmup_end',
        key: options.reusable ? session.key : null,
        requestKind: warmupRequest.kind,
        incrementalReason: warmupRequest.incrementalReason,
        websocketUrl: args.websocketUrl,
        reusedConnection
      })
    }

    const preparedRequest = prepareResponsesWebsocketRequest({
      requestBody: args.httpBody,
      session: options.reusable
        ? {
            lastFullRequest: session.lastFullRequest,
            lastCompletedResponseId: session.lastCompletedResponseId,
            lastResponseOutputItems: session.lastResponseOutputItems
          }
        : null
    })

    const result = await this.sendPreparedRequest({
      session,
      connection,
      args,
      preparedRequest,
      reusable: options.reusable,
      reusedConnection,
      fallbackReason: options.fallbackReason
    })

    if (result.kind === 'fallback' && options.reusable) {
      this.resetSessionState(session)
    }
    if (result.kind === 'fatal' && result.error === 'Request aborted' && options.reusable) {
      this.resetSessionState(session)
    }

    return result
  }

  private async acquireConnection(
    session: ResponsesWsSessionState,
    args: ExecuteResponsesWsRequestArgs,
    headers: Record<string, string>,
    options: ResponsesWsAttemptOptions & { reusable: boolean }
  ): Promise<
    | {
        kind: 'ok'
        connection: ResponsesWsConnection
        reusedConnection: boolean
        warmupNeeded: boolean
      }
    | { kind: 'fallback'; reason: string }
    | { kind: 'fatal'; error: string }
  > {
    if (!options.reusable) {
      try {
        const connection = await this.createConnection(args.websocketUrl, headers, args)
        this.emitLifecycle(args, {
          phase: 'connect',
          key: null,
          reusedConnection: false,
          websocketUrl: args.websocketUrl
        })
        return {
          kind: 'ok',
          connection,
          reusedConnection: false,
          warmupNeeded: false
        }
      } catch (error) {
        return {
          kind: 'fallback',
          reason:
            error instanceof Error ? error.message : 'WebSocket handshake failed before streaming'
        }
      }
    }

    const existing = session.connection
    const connectionMaxAgeMs = readTimeoutFromEnv(
      'OPENCOWORK_RESPONSES_WS_CONNECTION_MAX_AGE_MS',
      RESPONSES_WEBSOCKET_CONNECTION_MAX_AGE_MS
    )
    const connectionMaxIdleMs = readTimeoutFromEnv(
      'OPENCOWORK_RESPONSES_WS_CONNECTION_MAX_IDLE_MS',
      RESPONSES_WEBSOCKET_CONNECTION_MAX_IDLE_MS
    )
    const connectionMaxRequests = readPositiveIntFromEnv(
      'OPENCOWORK_RESPONSES_WS_CONNECTION_MAX_REQUESTS',
      RESPONSES_WEBSOCKET_CONNECTION_MAX_REQUESTS
    )
    const connectionExpired =
      existing != null &&
      connectionMaxAgeMs > 0 &&
      Date.now() - existing.createdAt >= connectionMaxAgeMs
    const connectionIdleExpired =
      existing != null &&
      connectionMaxIdleMs > 0 &&
      session.lastUsedAt != null &&
      Date.now() - session.lastUsedAt >= connectionMaxIdleMs
    const connectionRequestLimitReached =
      existing != null &&
      connectionMaxRequests > 0 &&
      existing.completedRequests >= connectionMaxRequests

    if (
      options.forceFresh ||
      !existing ||
      existing.closed ||
      existing.ws.readyState !== WebSocket.OPEN ||
      connectionExpired ||
      connectionIdleExpired ||
      connectionRequestLimitReached
    ) {
      if (existing) {
        const closeReason = connectionExpired
          ? 'connection_expired'
          : connectionIdleExpired
            ? 'connection_idle_expired'
            : connectionRequestLimitReached
              ? 'connection_request_limit_reached'
              : options.forceFresh
                ? 'force_fresh'
                : 'connection_reset'
        this.emitLifecycle(args, {
          phase: 'close',
          key: session.key,
          websocketUrl: args.websocketUrl,
          reason: closeReason
        })
        this.closeConnection(existing)
      }

      this.resetSessionState(session)

      try {
        const connection = await this.createConnection(args.websocketUrl, headers, args)
        session.connection = connection
        session.createdAt = connection.createdAt
        session.lastUsedAt = Date.now()
        this.emitLifecycle(args, {
          phase: 'connect',
          key: session.key,
          reusedConnection: false,
          websocketUrl: args.websocketUrl
        })
        return {
          kind: 'ok',
          connection,
          reusedConnection: false,
          warmupNeeded: true
        }
      } catch (error) {
        return {
          kind: 'fallback',
          reason:
            error instanceof Error ? error.message : 'WebSocket handshake failed before streaming'
        }
      }
    }

    session.lastUsedAt = Date.now()
    this.emitLifecycle(args, {
      phase: 'reuse',
      key: session.key,
      reusedConnection: true,
      websocketUrl: args.websocketUrl
    })
    return {
      kind: 'ok',
      connection: existing,
      reusedConnection: true,
      warmupNeeded: false
    }
  }

  private async sendPreparedRequest(args: {
    session: ResponsesWsSessionState
    connection: ResponsesWsConnection
    args: ExecuteResponsesWsRequestArgs
    preparedRequest: ResponsesWebsocketPreparedRequest
    reusable: boolean
    reusedConnection: boolean
    fallbackReason?: string
  }): Promise<ExecuteResponsesWsRequestResult> {
    const { session, connection, preparedRequest, reusable, reusedConnection } = args
    const isWarmup = preparedRequest.kind === 'warmup'
    const firstEventTimeoutMs = readTimeoutFromEnv(
      'OPENCOWORK_RESPONSES_WS_FIRST_EVENT_TIMEOUT_MS',
      RESPONSES_WS_FIRST_EVENT_TIMEOUT_MS
    )
    const idleTimeoutMs = readTimeoutFromEnv(
      'OPENCOWORK_RESPONSES_WS_IDLE_TIMEOUT_MS',
      RESPONSES_WS_IDLE_TIMEOUT_MS
    )

    args.args.onDebug?.({
      url: args.args.websocketUrl,
      headers: buildResponsesWebsocketHeaders(args.args.headers),
      body: preparedRequest.payload,
      ...(preparedRequest.kind === 'incremental'
        ? {
            contextWindowBody: buildResponsesWebsocketCreatePayload(
              cloneJson(preparedRequest.fullRequest)
            )
          }
        : {}),
      transport: 'websocket',
      ...(args.fallbackReason ? { fallbackReason: args.fallbackReason } : {}),
      reusedConnection,
      websocketRequestKind: preparedRequest.kind,
      websocketIncrementalReason: preparedRequest.incrementalReason,
      ...(preparedRequest.previousResponseId
        ? { previousResponseId: preparedRequest.previousResponseId }
        : {})
    })

    return await new Promise<ExecuteResponsesWsRequestResult>((resolve) => {
      let settled = false
      let sawFirstModelEvent = false
      let closeConnection = !reusable
      let inactivityTimer: ReturnType<typeof setTimeout> | null = null

      const finish = (result: ExecuteResponsesWsRequestResult): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }

      const cleanup = (): void => {
        clearInactivityTimer()
        connection.ws.off('message', onMessage)
        connection.ws.off('error', onError)
        connection.ws.off('close', onClose)
        args.args.signal?.removeEventListener('abort', onAbort)

        if (closeConnection) {
          this.emitLifecycle(args.args, {
            phase: 'close',
            key: reusable ? session.key : null,
            websocketUrl: args.args.websocketUrl
          })
          this.closeConnection(connection)
          if (reusable && session.connection === connection) {
            session.connection = null
          }
        } else if (reusable) {
          session.lastUsedAt = Date.now()
        }
      }

      const onAbort = (): void => {
        closeConnection = true
        finish({ kind: 'fatal', error: 'Request aborted' })
      }

      const shouldRetryFreshConnection = (): boolean =>
        reusable && reusedConnection && !sawFirstModelEvent

      const clearInactivityTimer = (): void => {
        if (inactivityTimer) {
          clearTimeout(inactivityTimer)
          inactivityTimer = null
        }
      }

      const startInactivityTimer = (): void => {
        const timeoutMs = sawFirstModelEvent ? idleTimeoutMs : firstEventTimeoutMs
        if (timeoutMs <= 0) return

        clearInactivityTimer()
        inactivityTimer = setTimeout(() => {
          closeConnection = true

          if (!sawFirstModelEvent) {
            const reason = 'websocket_first_event_timeout'
            if (shouldRetryFreshConnection()) {
              this.emitLifecycle(args.args, {
                phase: 'fallback',
                key: session.key,
                websocketUrl: args.args.websocketUrl,
                reason,
                requestKind: preparedRequest.kind,
                incrementalReason: preparedRequest.incrementalReason,
                previousResponseId: preparedRequest.previousResponseId,
                reusedConnection
              })
              finish({ kind: 'fallback', reason: RESPONSES_WS_FORCE_FRESH_REASON })
              return
            }

            this.emitLifecycle(args.args, {
              phase: 'fallback',
              key: reusable ? session.key : null,
              websocketUrl: args.args.websocketUrl,
              reason,
              requestKind: preparedRequest.kind,
              incrementalReason: preparedRequest.incrementalReason,
              previousResponseId: preparedRequest.previousResponseId,
              reusedConnection
            })
            finish({ kind: 'fallback', reason })
            return
          }

          console.warn(
            `[ResponsesWS/${this.namespace}] label=${args.args.label ?? 'n/a'} action=fatal reason=websocket_stream_idle_timeout timeoutMs=${timeoutMs}`
          )
          finish({
            kind: 'fatal',
            error: `WebSocket stream idle timeout (${Math.ceil(timeoutMs / 1000)}s with no events)`
          })
        }, timeoutMs)
      }

      const onMessage = (raw: WebSocket.RawData): void => {
        const text = rawDataToString(raw)
        let payload: Record<string, unknown>
        try {
          payload = JSON.parse(text) as Record<string, unknown>
        } catch {
          if (!sawFirstModelEvent) {
            console.warn(
              `[ResponsesWS/${this.namespace}] label=${args.args.label ?? 'n/a'} action=fallback reason=websocket_protocol_parse_failed raw=${text}`
            )
          }
          closeConnection = true
          if (!sawFirstModelEvent) {
            this.emitLifecycle(args.args, {
              phase: 'fallback',
              key: reusable ? session.key : null,
              websocketUrl: args.args.websocketUrl,
              reason: 'websocket_protocol_parse_failed',
              requestKind: preparedRequest.kind,
              incrementalReason: preparedRequest.incrementalReason,
              previousResponseId: preparedRequest.previousResponseId,
              reusedConnection
            })
            finish({ kind: 'fallback', reason: 'websocket_protocol_parse_failed' })
            return
          }
          finish({ kind: 'fatal', error: 'WebSocket protocol parse failed' })
          return
        }

        const eventType = typeof payload.type === 'string' ? payload.type : ''
        if (!eventType) {
          closeConnection = true
          if (!sawFirstModelEvent) {
            this.emitLifecycle(args.args, {
              phase: 'fallback',
              key: reusable ? session.key : null,
              websocketUrl: args.args.websocketUrl,
              reason: 'websocket_protocol_parse_failed',
              requestKind: preparedRequest.kind,
              incrementalReason: preparedRequest.incrementalReason,
              previousResponseId: preparedRequest.previousResponseId,
              reusedConnection
            })
            finish({ kind: 'fallback', reason: 'websocket_protocol_parse_failed' })
            return
          }
          finish({ kind: 'fatal', error: 'Missing WebSocket event type' })
          return
        }

        if (!sawFirstModelEvent && isResponsesWsConnectionLimitReached(payload)) {
          closeConnection = true
          this.emitLifecycle(args.args, {
            phase: 'fallback',
            key: reusable ? session.key : null,
            websocketUrl: args.args.websocketUrl,
            reason: 'websocket_connection_limit_reached',
            requestKind: preparedRequest.kind,
            incrementalReason: preparedRequest.incrementalReason,
            previousResponseId: preparedRequest.previousResponseId,
            reusedConnection
          })
          finish({ kind: 'fallback', reason: 'websocket_connection_limit_reached' })
          return
        }

        if (isWarmup && isResponsesWsFirstModelEvent(payload)) {
          console.warn(
            `[ResponsesWS/${this.namespace}] label=${args.args.label ?? 'n/a'} action=fallback reason=websocket_warmup_unexpected_model_event raw=${text}`
          )
          closeConnection = true
          this.emitLifecycle(args.args, {
            phase: 'fallback',
            key: reusable ? session.key : null,
            websocketUrl: args.args.websocketUrl,
            reason: 'websocket_warmup_unexpected_model_event',
            requestKind: preparedRequest.kind,
            incrementalReason: preparedRequest.incrementalReason,
            previousResponseId: preparedRequest.previousResponseId,
            reusedConnection
          })
          finish({ kind: 'fallback', reason: 'websocket_warmup_unexpected_model_event' })
          return
        }

        if (isWarmup && (eventType === 'error' || eventType === 'response.failed')) {
          console.warn(
            `[ResponsesWS/${this.namespace}] label=${args.args.label ?? 'n/a'} action=fallback reason=${getResponsesWsFailureReason(
              payload,
              'websocket_warmup_failed'
            )} raw=${text}`
          )
          closeConnection = true
          const reason = getResponsesWsFailureReason(payload, 'websocket_warmup_failed')
          this.emitLifecycle(args.args, {
            phase: 'fallback',
            key: reusable ? session.key : null,
            websocketUrl: args.args.websocketUrl,
            reason,
            requestKind: preparedRequest.kind,
            incrementalReason: preparedRequest.incrementalReason,
            previousResponseId: preparedRequest.previousResponseId,
            reusedConnection
          })
          finish({ kind: 'fallback', reason })
          return
        }

        if ((eventType === 'error' || eventType === 'response.failed') && !sawFirstModelEvent) {
          console.warn(
            `[ResponsesWS/${this.namespace}] label=${args.args.label ?? 'n/a'} action=fallback reason=${getResponsesWsFailureReason(
              payload,
              'websocket_server_error_before_first_event'
            )} raw=${text}`
          )
          closeConnection = true
          const reason = getResponsesWsFailureReason(
            payload,
            'websocket_server_error_before_first_event'
          )
          this.emitLifecycle(args.args, {
            phase: 'fallback',
            key: reusable ? session.key : null,
            websocketUrl: args.args.websocketUrl,
            reason,
            requestKind: preparedRequest.kind,
            incrementalReason: preparedRequest.incrementalReason,
            previousResponseId: preparedRequest.previousResponseId,
            reusedConnection
          })
          finish({ kind: 'fallback', reason })
          return
        }

        const isFirstModelEvent = isResponsesWsFirstModelEvent(payload)
        if (isFirstModelEvent) {
          sawFirstModelEvent = true
        }
        if (sawFirstModelEvent) {
          startInactivityTimer()
        }

        const completionState = extractResponsesWebsocketCompletionState(payload)
        if (completionState && reusable && !isWarmup) {
          session.lastFullRequest = cloneJson(preparedRequest.fullRequest)
          session.lastCompletedResponseId = completionState.responseId ?? null
          session.lastResponseOutputItems = completionState.outputItems
          session.lastUsedAt = Date.now()
          connection.completedRequests += 1
        }

        if (!isWarmup) {
          args.args.onEvent?.(eventType, payload)
        }

        if (eventType === 'response.failed' || eventType === 'error') {
          closeConnection = true
        }

        if (eventType === 'response.completed') {
          finish({ kind: 'streamed' })
          return
        }

        if (!isWarmup && (eventType === 'response.failed' || eventType === 'error')) {
          finish({ kind: 'streamed' })
        }
      }

      const onError = (error: Error): void => {
        closeConnection = true
        if (args.args.signal?.aborted) {
          finish({ kind: 'fatal', error: 'Request aborted' })
          return
        }
        if (!sawFirstModelEvent) {
          const reason = error.message || 'websocket_connection_failed'
          if (shouldRetryFreshConnection()) {
            this.emitLifecycle(args.args, {
              phase: 'fallback',
              key: session.key,
              websocketUrl: args.args.websocketUrl,
              reason,
              requestKind: preparedRequest.kind,
              incrementalReason: preparedRequest.incrementalReason,
              previousResponseId: preparedRequest.previousResponseId,
              reusedConnection
            })
            finish({ kind: 'fallback', reason: RESPONSES_WS_FORCE_FRESH_REASON })
            return
          }
          this.emitLifecycle(args.args, {
            phase: 'fallback',
            key: reusable ? session.key : null,
            websocketUrl: args.args.websocketUrl,
            reason,
            requestKind: preparedRequest.kind,
            incrementalReason: preparedRequest.incrementalReason,
            previousResponseId: preparedRequest.previousResponseId,
            reusedConnection
          })
          finish({ kind: 'fallback', reason })
          return
        }
        finish({ kind: 'fatal', error: error.message || 'WebSocket connection failed' })
      }

      const onClose = (code: number, reason: Buffer): void => {
        if (settled) return
        closeConnection = true
        const closeReason = reason.toString().trim()
        if (args.args.signal?.aborted) {
          finish({ kind: 'fatal', error: 'Request aborted' })
          return
        }
        if (!sawFirstModelEvent) {
          const fallbackReason = closeReason || `websocket_connection_closed_${code || 0}`
          if (shouldRetryFreshConnection()) {
            this.emitLifecycle(args.args, {
              phase: 'fallback',
              key: session.key,
              websocketUrl: args.args.websocketUrl,
              reason: fallbackReason,
              requestKind: preparedRequest.kind,
              incrementalReason: preparedRequest.incrementalReason,
              previousResponseId: preparedRequest.previousResponseId,
              reusedConnection
            })
            finish({ kind: 'fallback', reason: RESPONSES_WS_FORCE_FRESH_REASON })
            return
          }
          this.emitLifecycle(args.args, {
            phase: 'fallback',
            key: reusable ? session.key : null,
            websocketUrl: args.args.websocketUrl,
            reason: fallbackReason,
            requestKind: preparedRequest.kind,
            incrementalReason: preparedRequest.incrementalReason,
            previousResponseId: preparedRequest.previousResponseId,
            reusedConnection
          })
          finish({ kind: 'fallback', reason: fallbackReason })
          return
        }
        finish({
          kind: 'fatal',
          error: closeReason || `WebSocket connection closed (${code || 0})`
        })
      }

      args.args.signal?.addEventListener('abort', onAbort, { once: true })
      connection.ws.on('message', onMessage)
      connection.ws.on('error', onError)
      connection.ws.on('close', onClose)

      startInactivityTimer()

      try {
        connection.ws.send(preparedRequest.payload, (error) => {
          if (!error) return
          closeConnection = true
          if (!sawFirstModelEvent) {
            const reason = error.message || 'websocket_send_failed'
            if (shouldRetryFreshConnection()) {
              this.emitLifecycle(args.args, {
                phase: 'fallback',
                key: session.key,
                websocketUrl: args.args.websocketUrl,
                reason,
                requestKind: preparedRequest.kind,
                incrementalReason: preparedRequest.incrementalReason,
                previousResponseId: preparedRequest.previousResponseId,
                reusedConnection
              })
              finish({ kind: 'fallback', reason: RESPONSES_WS_FORCE_FRESH_REASON })
              return
            }
            this.emitLifecycle(args.args, {
              phase: 'fallback',
              key: reusable ? session.key : null,
              websocketUrl: args.args.websocketUrl,
              reason,
              requestKind: preparedRequest.kind,
              incrementalReason: preparedRequest.incrementalReason,
              previousResponseId: preparedRequest.previousResponseId,
              reusedConnection
            })
            finish({ kind: 'fallback', reason })
            return
          }
          finish({ kind: 'fatal', error: error.message || 'WebSocket send failed' })
        })
      } catch (error) {
        closeConnection = true
        const message = error instanceof Error ? error.message : 'WebSocket send failed'
        if (!sawFirstModelEvent) {
          if (shouldRetryFreshConnection()) {
            this.emitLifecycle(args.args, {
              phase: 'fallback',
              key: session.key,
              websocketUrl: args.args.websocketUrl,
              reason: message,
              requestKind: preparedRequest.kind,
              incrementalReason: preparedRequest.incrementalReason,
              previousResponseId: preparedRequest.previousResponseId,
              reusedConnection
            })
            finish({ kind: 'fallback', reason: RESPONSES_WS_FORCE_FRESH_REASON })
            return
          }
          this.emitLifecycle(args.args, {
            phase: 'fallback',
            key: reusable ? session.key : null,
            websocketUrl: args.args.websocketUrl,
            reason: message,
            requestKind: preparedRequest.kind,
            incrementalReason: preparedRequest.incrementalReason,
            previousResponseId: preparedRequest.previousResponseId,
            reusedConnection
          })
          finish({ kind: 'fallback', reason: message })
          return
        }
        finish({ kind: 'fatal', error: message })
      }
    })
  }

  private async createConnection(
    websocketUrl: string,
    headers: Record<string, string>,
    args: ExecuteResponsesWsRequestArgs
  ): Promise<ResponsesWsConnection> {
    let opened = false
    let resolveReady!: () => void
    let rejectReady!: (error: Error) => void
    const proxyUrl = args.useSystemProxy ? getConfiguredSystemProxyUrl() : null
    const ws = new WebSocket(websocketUrl, {
      headers: sanitizeHeaders({ ...headers }),
      perMessageDeflate: false,
      handshakeTimeout: 15_000,
      ...(args.allowInsecureTls === true ? { rejectUnauthorized: false } : {}),
      ...(proxyUrl ? { agent: this.getProxyAgent(proxyUrl, args.allowInsecureTls ?? true) } : {})
    })

    const connection: ResponsesWsConnection = {
      websocketUrl,
      ws,
      ready: new Promise<void>((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      }),
      closed: false,
      createdAt: Date.now(),
      completedRequests: 0
    }

    ws.once('open', () => {
      opened = true
      resolveReady()
    })

    ws.once('error', (error) => {
      if (!opened) {
        rejectReady(error instanceof Error ? error : new Error(String(error)))
      }
    })

    ws.on('close', () => {
      connection.closed = true
      if (!opened) {
        rejectReady(new Error('WebSocket connection closed before handshake completed'))
      }
    })

    await connection.ready
    return connection
  }

  private closeConnection(connection: ResponsesWsConnection): void {
    connection.closed = true
    try {
      if (
        connection.ws.readyState === WebSocket.OPEN ||
        connection.ws.readyState === WebSocket.CONNECTING
      ) {
        connection.ws.close()
      }
    } catch {
      // ignore
    }
  }

  private resetSessionState(session: ResponsesWsSessionState): void {
    if (session.connection) {
      this.closeConnection(session.connection)
      session.connection = null
    }
    session.lastFullRequest = null
    session.lastCompletedResponseId = null
    session.lastResponseOutputItems = null
    session.createdAt = null
    session.lastUsedAt = null
  }

  private buildCircuitKey(providerKey: string, websocketUrl: string): string {
    return `${providerKey}::${websocketUrl}`
  }

  private setCircuitReason(providerKey: string, websocketUrl: string, reason: string): void {
    this.circuitBreakers.set(this.buildCircuitKey(providerKey, websocketUrl), {
      expiresAt: Date.now() + RESPONSES_WS_CIRCUIT_BREAK_MS,
      reason
    })
  }

  private emitLifecycle(
    args: ExecuteResponsesWsRequestArgs,
    entry: Omit<ResponsesWsLifecycleLog, 'label'>
  ): void {
    const logEntry: ResponsesWsLifecycleLog = {
      ...entry,
      label: args.label
    }
    args.onLifecycle?.(logEntry)

    const segments = [
      `[ResponsesWS/${this.namespace}]`,
      `action=${logEntry.phase}`,
      `label=${logEntry.label ?? 'n/a'}`,
      `url=${logEntry.websocketUrl}`
    ]
    if (logEntry.key) segments.push(`key=${logEntry.key}`)
    if (logEntry.reason) segments.push(`reason=${logEntry.reason}`)
    if (logEntry.requestKind) segments.push(`requestKind=${logEntry.requestKind}`)
    if (logEntry.incrementalReason) {
      segments.push(`incrementalReason=${logEntry.incrementalReason}`)
    }
    if (logEntry.previousResponseId) {
      segments.push(`previousResponseId=${logEntry.previousResponseId}`)
    }
    if (typeof logEntry.reusedConnection === 'boolean') {
      segments.push(`reusedConnection=${String(logEntry.reusedConnection)}`)
    }
    console.info(segments.join(' '))
  }

  private getProxyAgent(proxyUrl: string, allowInsecureTls: boolean): HttpsProxyAgent<string> {
    const cache = allowInsecureTls ? this.insecureProxyAgents : this.secureProxyAgents
    const existing = cache.get(proxyUrl)
    if (existing) return existing

    const agent = new HttpsProxyAgent(proxyUrl, {
      rejectUnauthorized: !allowInsecureTls
    })
    cache.set(proxyUrl, agent)
    return agent
  }
}

function getConfiguredSystemProxyUrl(): string | null {
  const saved = readSettings().systemProxyUrl
  if (typeof saved === 'string' && saved.trim()) return saved.trim()
  for (const key of SYSTEM_PROXY_ENV_KEYS) {
    const value = process.env[key]?.trim()
    if (value) return value
  }
  return null
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue
    const stringValue = String(value)
    if (!stringValue || /\r|\n/.test(stringValue)) continue
    sanitized[key] = stringValue
  }
  return sanitized
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function rawDataToString(raw: WebSocket.RawData): string {
  if (typeof raw === 'string') return raw
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString()
  if (Array.isArray(raw)) return Buffer.concat(raw).toString()
  return raw.toString()
}

async function waitForAbortable(waitFor: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await waitFor
    return
  }
  if (signal.aborted) {
    throw new Error('Request aborted')
  }

  await Promise.race([
    waitFor,
    new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Request aborted')), { once: true })
    })
  ])
}

function readTimeoutFromEnv(name: string, fallbackMs: number): number {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallbackMs
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return fallbackMs
  return Math.floor(parsed)
}

function readPositiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.floor(parsed)
}
