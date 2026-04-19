import { ipcMain, BrowserWindow, net, session } from 'electron'
import * as https from 'https'
import * as http from 'http'
import { URL } from 'url'
import { readSettings } from './settings-handlers'
import {
  buildResponsesWebsocketSessionKey,
  resolveResponsesWebsocketConfig,
  type ResponsesWebsocketMode,
  type ResponsesWebsocketRequestKind
} from '../../shared/openai-responses-websocket'
import { ResponsesWebSocketSessionManager } from '../lib/responses-websocket-session-manager'

const MAX_RESPONSE_BODY_CHARS = 10_000_000

// Retry policy for transient AI provider failures: HTTP 429 (rate limited) and HTTP 500 (server error).
// Total requests sent = 1 initial + up to MAX_RETRY_ATTEMPTS retries.
const MAX_RETRY_ATTEMPTS = 10
const RETRY_BASE_DELAY_MS = 1000
const RETRY_MAX_DELAY_MS = 30_000
const RETRY_MAX_RETRY_AFTER_MS = 60_000

function isRetryableStatus(status: number): boolean {
  return status === 500 || status === 429
}

function parseRetryAfterMs(value: string | string[] | undefined): number | undefined {
  if (value == null) return undefined
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw) return undefined
  const secs = Number(raw)
  if (Number.isFinite(secs) && secs >= 0) {
    return Math.min(RETRY_MAX_RETRY_AFTER_MS, Math.max(0, secs * 1000))
  }
  const date = Date.parse(raw)
  if (Number.isFinite(date)) {
    const delta = date - Date.now()
    if (delta > 0) return Math.min(RETRY_MAX_RETRY_AFTER_MS, delta)
  }
  return undefined
}

function computeBackoffMs(attempt: number, retryAfterMs: number | undefined): number {
  if (retryAfterMs != null) return retryAfterMs
  const exp = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * Math.pow(2, attempt))
  // +/-25% jitter
  const jitter = (Math.random() * 0.5 - 0.25) * exp
  return Math.max(100, Math.floor(exp + jitter))
}

type AttemptResult =
  | { kind: 'streamed' }
  | { kind: 'retryable'; status: number; body: string; retryAfterMs?: number }
  | { kind: 'fatal'; status: number; body: string }
  | { kind: 'fallback'; reason: string }

interface APIStreamRequest {
  requestId: string
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  useSystemProxy?: boolean
  allowInsecureTls?: boolean
  providerId?: string
  providerBuiltinId?: string
  /** Active OAuth account id when the request is account-scoped. Used to surface rate-limit markers. */
  accountId?: string
  providerType?: string
  model?: string
  sessionId?: string
  responsesSessionScope?: string
  websocketUrl?: string
  websocketMode?: ResponsesWebsocketMode
}

interface AccountRateLimitPayload {
  providerId?: string
  providerBuiltinId?: string
  accountId?: string
  resetAt: number
  reason: 'http-429' | 'codex-quota'
  windowType?: 'primary' | 'secondary'
  message?: string
}

function readTimeoutFromEnv(name: string, fallbackMs: number): number {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallbackMs
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return fallbackMs
  return Math.floor(parsed)
}

function cancelNetRequest(req: Electron.ClientRequest): void {
  const anyReq = req as unknown as { abort?: () => void; destroy?: (err?: Error) => void }
  if (typeof anyReq.abort === 'function') {
    anyReq.abort()
    return
  }
  if (typeof anyReq.destroy === 'function') {
    anyReq.destroy()
  }
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

const INSECURE_PROXY_SESSION_PARTITION = 'persist:open-cowork-provider-insecure-tls-proxy'
let insecureProxySessionState: {
  promise: Promise<Electron.Session>
  proxyRules: string | null
} | null = null
const responsesWsManager = new ResponsesWebSocketSessionManager('api-proxy')

function getConfiguredSystemProxyUrl(): string | null {
  const saved = readSettings().systemProxyUrl
  if (typeof saved === 'string' && saved.trim()) return saved.trim()
  for (const key of [
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'ALL_PROXY',
    'all_proxy'
  ]) {
    const value = process.env[key]?.trim()
    if (value) return value
  }
  return null
}

function maskDebugHeaders(headers: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {}
  const sensitiveKeys = ['authorization', 'x-api-key', 'api-key', 'x-goog-api-key']
  for (const [key, value] of Object.entries(headers)) {
    if (sensitiveKeys.includes(key.toLowerCase())) {
      if (value.length > 8) {
        masked[key] = `${value.slice(0, 4)}****${value.slice(-4)}`
      } else if (value.length > 0) {
        masked[key] = '****'
      } else {
        masked[key] = value
      }
      continue
    }
    masked[key] = value
  }
  return masked
}

function createSseChunk(eventName: string, payload: string): string {
  return `event: ${eventName}\ndata: ${payload}\n\n`
}

function sendStreamChunk(
  sender: Electron.WebContents | null,
  requestId: string,
  data: string
): void {
  if (!sender) return
  sender.send('api:stream-chunk', { requestId, data })
}

function sendSseEvent(
  sender: Electron.WebContents | null,
  requestId: string,
  eventName: string,
  payload: unknown
): void {
  sendStreamChunk(sender, requestId, createSseChunk(eventName, JSON.stringify(payload)))
}

function sendResponsesRequestDebug(
  sender: Electron.WebContents | null,
  req: Pick<
    APIStreamRequest,
    'requestId' | 'providerId' | 'providerBuiltinId' | 'model' | 'headers'
  >,
  args: {
    url: string
    method: string
    body?: string
    headers?: Record<string, string>
    transport: 'http' | 'websocket'
    fallbackReason?: string
    reusedConnection?: boolean
    websocketRequestKind?: ResponsesWebsocketRequestKind
    websocketIncrementalReason?: string
    previousResponseId?: string
  }
): void {
  sendSseEvent(sender, req.requestId, '__request_debug', {
    url: args.url,
    method: args.method,
    headers: maskDebugHeaders(args.headers ?? req.headers),
    ...(typeof args.body === 'string' ? { body: args.body } : {}),
    timestamp: Date.now(),
    ...(req.providerId ? { providerId: req.providerId } : {}),
    ...(req.providerBuiltinId ? { providerBuiltinId: req.providerBuiltinId } : {}),
    ...(req.model ? { model: req.model } : {}),
    transport: args.transport,
    ...(args.fallbackReason ? { fallbackReason: args.fallbackReason } : {}),
    ...(typeof args.reusedConnection === 'boolean'
      ? { reusedConnection: args.reusedConnection }
      : {}),
    ...(args.websocketRequestKind ? { websocketRequestKind: args.websocketRequestKind } : {}),
    ...(args.websocketIncrementalReason
      ? { websocketIncrementalReason: args.websocketIncrementalReason }
      : {}),
    ...(args.previousResponseId ? { previousResponseId: args.previousResponseId } : {}),
    executionPath: 'node'
  })
}

async function getInsecureProxySession(): Promise<Electron.Session> {
  const proxyRules = getConfiguredSystemProxyUrl()
  if (insecureProxySessionState && insecureProxySessionState.proxyRules === proxyRules) {
    return await insecureProxySessionState.promise
  }

  const promise = (async () => {
    const proxySession = session.fromPartition(INSECURE_PROXY_SESSION_PARTITION, { cache: false })
    proxySession.setCertificateVerifyProc((_, callback) => callback(0))
    if (proxyRules) {
      await proxySession.setProxy({ mode: 'fixed_servers', proxyRules })
    } else {
      await proxySession.setProxy({ mode: 'system' })
    }
    return proxySession
  })()

  insecureProxySessionState = { promise, proxyRules }
  return await promise
}

interface CodexQuotaWindow {
  usedPercent?: number
  windowMinutes?: number
  resetAt?: string
  resetAfterSeconds?: number
}

interface CodexQuota {
  type: 'codex'
  planType?: string
  primary?: CodexQuotaWindow
  secondary?: CodexQuotaWindow
  primaryOverSecondaryLimitPercent?: number
  credits?: {
    hasCredits?: boolean
    balance?: number
    unlimited?: boolean
  }
  fetchedAt: number
}

function normalizeHeaderMap(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  const normalized: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      if (value[0]) normalized[key.toLowerCase()] = value[0]
      continue
    }
    if (typeof value === 'string' && value) {
      normalized[key.toLowerCase()] = value
    }
  }
  return normalized
}

function parseNumber(value?: string): number | undefined {
  if (!value) return undefined
  const num = Number(value)
  return Number.isFinite(num) ? num : undefined
}

function parseBoolean(value?: string): boolean | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes'].includes(normalized)) return true
  if (['false', '0', 'no'].includes(normalized)) return false
  return undefined
}

function extractCodexQuota(
  headers: Record<string, string | string[] | undefined>
): CodexQuota | null {
  const normalized = normalizeHeaderMap(headers)
  const hasCodexHeaders = Object.keys(normalized).some((key) => key.startsWith('x-codex-'))
  if (!hasCodexHeaders) return null

  const primary: CodexQuotaWindow = {
    usedPercent: parseNumber(normalized['x-codex-primary-used-percent']),
    windowMinutes: parseNumber(normalized['x-codex-primary-window-minutes']),
    resetAt: normalized['x-codex-primary-reset-at'],
    resetAfterSeconds: parseNumber(normalized['x-codex-primary-reset-after-seconds'])
  }
  const secondary: CodexQuotaWindow = {
    usedPercent: parseNumber(normalized['x-codex-secondary-used-percent']),
    windowMinutes: parseNumber(normalized['x-codex-secondary-window-minutes']),
    resetAt: normalized['x-codex-secondary-reset-at'],
    resetAfterSeconds: parseNumber(normalized['x-codex-secondary-reset-after-seconds'])
  }

  const credits = {
    hasCredits: parseBoolean(normalized['x-codex-credits-has-credits']),
    balance: parseNumber(normalized['x-codex-credits-balance']),
    unlimited: parseBoolean(normalized['x-codex-credits-unlimited'])
  }

  return {
    type: 'codex',
    planType: normalized['x-codex-plan-type'],
    primary: Object.values(primary).some((v) => v !== undefined) ? primary : undefined,
    secondary: Object.values(secondary).some((v) => v !== undefined) ? secondary : undefined,
    primaryOverSecondaryLimitPercent: parseNumber(
      normalized['x-codex-primary-over-secondary-limit-percent']
    ),
    credits: Object.values(credits).some((v) => v !== undefined) ? credits : undefined,
    fetchedAt: Date.now()
  }
}

function sendQuotaUpdate(
  event: Electron.IpcMainEvent,
  req: Pick<APIStreamRequest, 'requestId' | 'url' | 'providerId' | 'providerBuiltinId'>,
  headers: Record<string, string | string[] | undefined>
): void {
  const quota = extractCodexQuota(headers)
  if (!quota) return
  const sender = getSender(event)
  if (!sender) return
  sender.send('api:quota-update', {
    requestId: req.requestId,
    url: req.url,
    providerId: req.providerId,
    providerBuiltinId: req.providerBuiltinId,
    quota
  })
}

/**
 * Detect if the response should trigger an account-level rate-limit marker.
 * Returns the payload to emit, or null.
 *
 * Two triggers:
 *   1. HTTP 429 — derive resetAt from the Retry-After header when present.
 *   2. Codex quota headers showing primary.usedPercent >= 100 — resetAt from x-codex-primary-reset-*.
 *      This is a pre-emptive signal: we mark the account before the next 429 actually arrives.
 */
function detectAccountRateLimit(
  status: number,
  headers: Record<string, string | string[] | undefined>,
  req: Pick<APIStreamRequest, 'providerId' | 'providerBuiltinId' | 'accountId'>
): AccountRateLimitPayload | null {
  if (status === 429) {
    const retryAfterMs = parseRetryAfterMs(headers['retry-after']) ?? 60_000
    return {
      providerId: req.providerId,
      providerBuiltinId: req.providerBuiltinId,
      accountId: req.accountId,
      resetAt: Date.now() + retryAfterMs,
      reason: 'http-429',
      message: `HTTP 429 with retry-after ${Math.round(retryAfterMs / 1000)}s`
    }
  }

  const quota = extractCodexQuota(headers)
  if (!quota) return null
  const saturated =
    (quota.primary && (quota.primary.usedPercent ?? 0) >= 100 && 'primary') ||
    (quota.secondary && (quota.secondary.usedPercent ?? 0) >= 100 && 'secondary') ||
    null
  if (!saturated) return null
  const window = saturated === 'primary' ? quota.primary : quota.secondary
  if (!window) return null

  let resetAt: number | undefined
  if (typeof window.resetAt === 'string') {
    const parsed = Date.parse(window.resetAt)
    if (Number.isFinite(parsed)) resetAt = parsed
  }
  if (resetAt === undefined && typeof window.resetAfterSeconds === 'number') {
    resetAt = Date.now() + window.resetAfterSeconds * 1000
  }
  if (resetAt === undefined) return null

  return {
    providerId: req.providerId,
    providerBuiltinId: req.providerBuiltinId,
    accountId: req.accountId,
    resetAt,
    reason: 'codex-quota',
    windowType: saturated,
    message: `Codex ${saturated} window saturated`
  }
}

function sendAccountRateLimited(
  event: Electron.IpcMainEvent,
  payload: AccountRateLimitPayload
): void {
  const sender = getSender(event)
  if (!sender) return
  sender.send('api:account-rate-limited', payload)
}

async function requestViaSystemProxy(args: {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  allowInsecureTls?: boolean
}): Promise<{
  statusCode?: number
  error?: string
  body?: string
  headers?: Record<string, string | string[] | undefined>
}> {
  const { url, method, headers, body, allowInsecureTls } = args
  const requestUrl = url.trim()
  const requestSession = allowInsecureTls ? await getInsecureProxySession() : undefined
  const bodyBuffer = body ? Buffer.from(body, 'utf-8') : null
  const reqHeaders = sanitizeHeaders({ ...headers })

  return new Promise((resolve) => {
    let done = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const finish = (payload: {
      statusCode?: number
      error?: string
      body?: string
      headers?: Record<string, string | string[] | undefined>
    }): void => {
      if (done) return
      done = true
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      resolve(payload)
    }

    const httpReq = net.request({
      method,
      url: requestUrl,
      ...(requestSession ? { session: requestSession } : {})
    })
    for (const [key, value] of Object.entries(reqHeaders)) {
      httpReq.setHeader(key, value)
    }

    httpReq.on('response', (res) => {
      let responseBody = ''
      res.on('data', (chunk: Buffer) => {
        if (responseBody.length < MAX_RESPONSE_BODY_CHARS) {
          responseBody += chunk.toString()
        }
      })
      res.on('end', () => {
        finish({
          statusCode: res.statusCode,
          body: responseBody,
          headers: res.headers as Record<string, string | string[] | undefined>
        })
      })
    })

    httpReq.on('error', (err) => {
      finish({ statusCode: 0, error: err.message })
    })

    timeout = setTimeout(() => {
      cancelNetRequest(httpReq)
      finish({ statusCode: 0, error: 'Request timed out (15s)' })
    }, 15000)

    if (bodyBuffer) httpReq.write(bodyBuffer)
    httpReq.end()
  })
}

export function registerApiProxyHandlers(): void {
  // Handle non-streaming API requests (e.g., test connection)
  ipcMain.handle('api:request', async (event, req: Omit<APIStreamRequest, 'requestId'>) => {
    const { url, method, headers, body, useSystemProxy, providerId, providerBuiltinId } = req

    type AttemptOutcome = {
      statusCode?: number
      body?: string
      error?: string
      headers?: Record<string, string | string[] | undefined>
    }

    const runDirectAttempt = (): Promise<AttemptOutcome> => {
      const parsedUrl = new URL(url)
      const isHttps = parsedUrl.protocol === 'https:'
      const httpModule = isHttps ? https : http

      const bodyBuffer = body ? Buffer.from(body, 'utf-8') : null
      const reqHeaders = { ...headers }
      if (bodyBuffer) {
        reqHeaders['Content-Length'] = String(bodyBuffer.byteLength)
      }

      return new Promise<AttemptOutcome>((resolve) => {
        const options = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (isHttps ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method,
          headers: reqHeaders
        }

        const httpReq = httpModule.request(options, (res) => {
          let responseBody = ''
          res.on('data', (chunk: Buffer) => {
            if (responseBody.length < MAX_RESPONSE_BODY_CHARS) {
              responseBody += chunk.toString()
            }
          })
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode,
              body: responseBody,
              headers: res.headers as Record<string, string | string[] | undefined>
            })
          })
        })

        httpReq.on('error', (err) => {
          console.error(`[API Proxy] request error: ${err.message}`)
          resolve({ statusCode: 0, error: err.message })
        })

        httpReq.setTimeout(15000, () => {
          httpReq.destroy()
          resolve({ statusCode: 0, error: 'Request timed out (15s)' })
        })

        if (bodyBuffer) httpReq.write(bodyBuffer)
        httpReq.end()
      })
    }

    try {
      console.log(`[API Proxy] request ${method} ${url}`)
      let result: AttemptOutcome = {}
      for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
        result = useSystemProxy
          ? await requestViaSystemProxy({ url, method, headers, body })
          : await runDirectAttempt()
        const status = result.statusCode ?? 0
        if (status > 0 && isRetryableStatus(status) && attempt < MAX_RETRY_ATTEMPTS) {
          const retryAfterMs = parseRetryAfterMs(result.headers?.['retry-after'])
          const delay = computeBackoffMs(attempt, retryAfterMs)
          console.warn(
            `[API Proxy] request HTTP ${status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS})`
          )
          await new Promise<void>((r) => setTimeout(r, delay))
          continue
        }
        break
      }

      if ((providerId || providerBuiltinId) && result.headers) {
        const quota = extractCodexQuota(result.headers)
        if (quota && event.sender) {
          event.sender.send('api:quota-update', {
            url,
            providerId,
            providerBuiltinId,
            quota
          })
        }
      }

      return { statusCode: result.statusCode, body: result.body, error: result.error }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[API Proxy] request fatal error: ${errMsg}`)
      return { statusCode: 0, error: errMsg }
    }
  })

  // Handle streaming API requests from renderer
  ipcMain.on('api:stream-request', (event, req: APIStreamRequest) => {
    const {
      requestId,
      url,
      method,
      headers,
      body,
      useSystemProxy,
      allowInsecureTls,
      providerId,
      providerBuiltinId,
      accountId
    } = req

    console.log(`[API Proxy] stream-request[${requestId}] ${method} ${url}`)

    // Abort plumbing: registered once for the lifetime of the retry loop.
    let aborted = false
    let cancelCurrentAttempt: (() => void) | null = null
    let cancelRetryWait: (() => void) | null = null

    const abortHandler = (_event: Electron.IpcMainEvent, data: { requestId: string }): void => {
      if (data.requestId !== requestId) return
      aborted = true
      cancelCurrentAttempt?.()
      cancelRetryWait?.()
      ipcMain.removeListener('api:abort', abortHandler)
    }
    ipcMain.on('api:abort', abortHandler)

    const sendError = (error: string): void => {
      const sender = getSender(event)
      if (sender) sender.send('api:stream-error', { requestId, error })
    }

    const waitForRetry = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        if (aborted) {
          resolve()
          return
        }
        const timer = setTimeout(() => {
          cancelRetryWait = null
          resolve()
        }, ms)
        cancelRetryWait = () => {
          clearTimeout(timer)
          cancelRetryWait = null
          resolve()
        }
      })

    const runOneHttpAttempt = async (args?: {
      debugInfo?: {
        transport: 'http' | 'websocket'
        url: string
        method: string
        body?: string
        fallbackReason?: string
        reusedConnection?: boolean
      }
    }): Promise<AttemptResult> => {
      const requestSession =
        useSystemProxy && allowInsecureTls ? await getInsecureProxySession() : undefined

      return await new Promise<AttemptResult>((resolve) => {
        const STREAM_CHUNK_FLUSH_MS = 32
        const STREAM_CHUNK_MAX_BUFFER_CHARS = 8_192
        let bufferedChunk = ''
        let chunkFlushTimer: ReturnType<typeof setTimeout> | null = null
        let settled = false
        let completed = false

        const finish = (result: AttemptResult): void => {
          if (settled) return
          settled = true
          cancelCurrentAttempt = null
          resolve(result)
        }

        const clearChunkFlushTimer = (): void => {
          if (chunkFlushTimer) {
            clearTimeout(chunkFlushTimer)
            chunkFlushTimer = null
          }
        }

        const flushBufferedChunk = (): void => {
          clearChunkFlushTimer()
          if (!bufferedChunk) return
          const sender = getSender(event)
          if (sender) {
            sender.send('api:stream-chunk', { requestId, data: bufferedChunk })
          }
          bufferedChunk = ''
        }

        const queueChunkFlush = (): void => {
          if (chunkFlushTimer) return
          chunkFlushTimer = setTimeout(() => {
            chunkFlushTimer = null
            flushBufferedChunk()
          }, STREAM_CHUNK_FLUSH_MS)
        }

        const pushStreamChunk = (chunk: Buffer): void => {
          bufferedChunk += chunk.toString()
          if (bufferedChunk.length >= STREAM_CHUNK_MAX_BUFFER_CHARS) {
            flushBufferedChunk()
            return
          }
          queueChunkFlush()
        }

        // Timeouts (ms):
        // - Connection: max wait for the server to start responding (first byte)
        // - Idle: max gap between consecutive data chunks during streaming
        const CONNECTION_TIMEOUT = readTimeoutFromEnv(
          'OPENCOWORK_API_CONNECTION_TIMEOUT_MS',
          180_000
        )
        const IDLE_TIMEOUT = readTimeoutFromEnv('OPENCOWORK_API_IDLE_TIMEOUT_MS', 300_000)

        try {
          if (args?.debugInfo) {
            sendResponsesRequestDebug(getSender(event), req, args.debugInfo)
          }

          if (useSystemProxy) {
            const requestUrl = url.trim()
            const bodyBuffer = body ? Buffer.from(body, 'utf-8') : null
            const reqHeaders = sanitizeHeaders({ ...headers })

            let idleTimer: ReturnType<typeof setTimeout> | null = null
            const clearIdleTimer = (): void => {
              if (idleTimer) {
                clearTimeout(idleTimer)
                idleTimer = null
              }
            }

            const httpReq = net.request({
              method,
              url: requestUrl,
              ...(requestSession ? { session: requestSession } : {})
            })
            for (const [key, value] of Object.entries(reqHeaders)) {
              httpReq.setHeader(key, value)
            }

            let connectionTimer: ReturnType<typeof setTimeout> | null = null
            const clearConnectionTimer = (): void => {
              if (connectionTimer) {
                clearTimeout(connectionTimer)
                connectionTimer = null
              }
            }

            const resetIdleTimer = (): void => {
              if (IDLE_TIMEOUT <= 0) return
              clearIdleTimer()
              idleTimer = setTimeout(() => {
                console.warn(`[API Proxy] Idle timeout (${IDLE_TIMEOUT}ms) for ${requestId}`)
                cancelNetRequest(httpReq)
              }, IDLE_TIMEOUT)
            }

            cancelCurrentAttempt = (): void => {
              clearConnectionTimer()
              clearIdleTimer()
              clearChunkFlushTimer()
              bufferedChunk = ''
              cancelNetRequest(httpReq)
            }

            httpReq.on('response', (res) => {
              clearConnectionTimer()
              const statusCode = res.statusCode || 0
              sendQuotaUpdate(
                event,
                { requestId, url, providerId, providerBuiltinId },
                res.headers ?? {}
              )
              const rateLimit = detectAccountRateLimit(statusCode, res.headers ?? {}, {
                providerId,
                providerBuiltinId,
                accountId
              })
              if (rateLimit) {
                sendAccountRateLimited(event, rateLimit)
              }

              if (statusCode < 200 || statusCode >= 300) {
                clearIdleTimer()
                let errorBody = ''
                res.on('data', (chunk: Buffer) => {
                  if (errorBody.length < 4000) errorBody += chunk.toString()
                })
                res.on('end', () => {
                  const retryAfterMs = parseRetryAfterMs(
                    (res.headers as Record<string, string | string[] | undefined>)['retry-after']
                  )
                  console.error(
                    `[API Proxy] stream-request[${requestId}] HTTP ${statusCode}: ${errorBody.slice(0, 500)}`
                  )
                  // If this account is rate-limited, don't retry on it at the proxy level:
                  // the agent loop will fail over to another account.
                  const kind: AttemptResult['kind'] = rateLimit
                    ? 'fatal'
                    : isRetryableStatus(statusCode)
                      ? 'retryable'
                      : 'fatal'
                  finish({
                    kind,
                    status: statusCode,
                    body: errorBody,
                    retryAfterMs
                  } as AttemptResult)
                })
                return
              }

              res.on('data', (chunk: Buffer) => {
                resetIdleTimer()
                pushStreamChunk(chunk)
              })

              res.on('end', () => {
                completed = true
                clearIdleTimer()
                flushBufferedChunk()
                const sender = getSender(event)
                if (sender) sender.send('api:stream-end', { requestId })
                finish({ kind: 'streamed' })
              })

              res.on('error', (err) => {
                clearIdleTimer()
                clearChunkFlushTimer()
                bufferedChunk = ''
                console.error(
                  `[API Proxy] stream-request[${requestId}] response error: ${err.message}`
                )
                finish({ kind: 'fatal', status: 0, body: err.message })
              })
            })

            if (CONNECTION_TIMEOUT > 0) {
              connectionTimer = setTimeout(() => {
                console.warn(
                  `[API Proxy] Connection timeout (${CONNECTION_TIMEOUT}ms) for ${requestId}`
                )
                cancelNetRequest(httpReq)
                finish({
                  kind: 'fatal',
                  status: 0,
                  body: `Connection timeout (${CONNECTION_TIMEOUT / 1000}s)`
                })
              }, CONNECTION_TIMEOUT)
            }

            httpReq.on('error', (err) => {
              clearConnectionTimer()
              clearIdleTimer()
              clearChunkFlushTimer()
              bufferedChunk = ''
              console.error(
                `[API Proxy] stream-request[${requestId}] request error: ${err.message}`
              )
              finish({ kind: 'fatal', status: 0, body: err.message })
            })

            httpReq.on('close', () => {
              clearConnectionTimer()
              clearIdleTimer()
              clearChunkFlushTimer()
              bufferedChunk = ''
              // 正常流结束后，底层连接 close 是预期行为，不应再报错。
              if (!settled && !completed)
                finish({ kind: 'fatal', status: 0, body: 'Connection closed' })
            })

            if (bodyBuffer) httpReq.write(bodyBuffer)
            httpReq.end()
            return
          }

          // Direct http/https path
          const parsedUrl = new URL(url)
          const isHttps = parsedUrl.protocol === 'https:'
          const httpModule = isHttps ? https : http

          const bodyBuffer = body ? Buffer.from(body, 'utf-8') : null
          const reqHeaders = { ...headers }
          if (bodyBuffer) {
            reqHeaders['Content-Length'] = String(bodyBuffer.byteLength)
          }

          const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method,
            headers: reqHeaders,
            ...(isHttps && (allowInsecureTls ?? true) ? { rejectUnauthorized: false } : {})
          }

          let idleTimer: ReturnType<typeof setTimeout> | null = null
          const clearIdleTimer = (): void => {
            if (idleTimer) {
              clearTimeout(idleTimer)
              idleTimer = null
            }
          }

          const httpReq = httpModule.request(options, (res) => {
            const statusCode = res.statusCode || 0
            sendQuotaUpdate(
              event,
              { requestId, url, providerId, providerBuiltinId },
              res.headers ?? {}
            )
            const rateLimit = detectAccountRateLimit(statusCode, res.headers ?? {}, {
              providerId,
              providerBuiltinId,
              accountId
            })
            if (rateLimit) {
              sendAccountRateLimited(event, rateLimit)
            }

            if (statusCode < 200 || statusCode >= 300) {
              clearIdleTimer()
              let errorBody = ''
              res.on('data', (chunk: Buffer) => {
                if (errorBody.length < 4000) errorBody += chunk.toString()
              })
              res.on('end', () => {
                const retryAfterMs = parseRetryAfterMs(res.headers['retry-after'])
                console.error(
                  `[API Proxy] stream-request[${requestId}] HTTP ${statusCode}: ${errorBody.slice(0, 500)}`
                )
                finish({
                  kind: rateLimit ? 'fatal' : isRetryableStatus(statusCode) ? 'retryable' : 'fatal',
                  status: statusCode,
                  body: errorBody,
                  retryAfterMs
                } as AttemptResult)
              })
              return
            }

            const resetIdleTimer = (): void => {
              if (IDLE_TIMEOUT <= 0) return
              clearIdleTimer()
              idleTimer = setTimeout(() => {
                console.warn(`[API Proxy] Idle timeout (${IDLE_TIMEOUT}ms) for ${requestId}`)
                httpReq.destroy(
                  new Error(`Stream idle timeout (${IDLE_TIMEOUT / 1000}s with no data)`)
                )
              }, IDLE_TIMEOUT)
            }

            res.on('data', (chunk: Buffer) => {
              resetIdleTimer()
              pushStreamChunk(chunk)
            })

            res.on('end', () => {
              clearIdleTimer()
              flushBufferedChunk()
              const sender = getSender(event)
              if (sender) sender.send('api:stream-end', { requestId })
              finish({ kind: 'streamed' })
            })

            res.on('error', (err) => {
              clearIdleTimer()
              clearChunkFlushTimer()
              bufferedChunk = ''
              console.error(
                `[API Proxy] stream-request[${requestId}] response error: ${err.message}`
              )
              finish({ kind: 'fatal', status: 0, body: err.message })
            })
          })

          cancelCurrentAttempt = (): void => {
            clearIdleTimer()
            clearChunkFlushTimer()
            bufferedChunk = ''
            httpReq.destroy()
          }

          if (CONNECTION_TIMEOUT > 0) {
            httpReq.setTimeout(CONNECTION_TIMEOUT, () => {
              console.warn(
                `[API Proxy] Connection timeout (${CONNECTION_TIMEOUT}ms) for ${requestId}`
              )
              httpReq.destroy(new Error(`Connection timeout (${CONNECTION_TIMEOUT / 1000}s)`))
            })
          }

          httpReq.on('error', (err) => {
            clearIdleTimer()
            clearChunkFlushTimer()
            bufferedChunk = ''
            console.error(`[API Proxy] stream-request[${requestId}] request error: ${err.message}`)
            finish({ kind: 'fatal', status: 0, body: err.message })
          })

          httpReq.on('close', () => {
            clearIdleTimer()
            clearChunkFlushTimer()
            bufferedChunk = ''
            if (!settled && !completed)
              finish({ kind: 'fatal', status: 0, body: 'Connection closed' })
          })

          if (bodyBuffer) httpReq.write(bodyBuffer)
          httpReq.end()
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          console.error(`[API Proxy] stream-request[${requestId}] fatal error: ${errMsg}`)
          finish({ kind: 'fatal', status: 0, body: errMsg })
        }
      })
    }

    const runHttpWithRetries = async (debugInfo?: {
      transport: 'http' | 'websocket'
      url: string
      method: string
      body?: string
      fallbackReason?: string
      reusedConnection?: boolean
    }): Promise<boolean> => {
      for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
        if (aborted) return true
        const result = await runOneHttpAttempt(
          attempt === 0 && debugInfo ? { debugInfo } : undefined
        )
        if (aborted) return true
        if (result.kind === 'streamed') return true
        if (result.kind === 'retryable' && attempt < MAX_RETRY_ATTEMPTS) {
          const delay = computeBackoffMs(attempt, result.retryAfterMs)
          console.warn(
            `[API Proxy] stream-request[${requestId}] HTTP ${result.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS})`
          )
          await waitForRetry(delay)
          continue
        }
        if (result.kind === 'fallback') {
          continue
        }
        const trimmed = result.body.slice(0, 2000)
        const errorMessage =
          result.status > 0 ? `HTTP ${result.status}: ${trimmed}` : trimmed || 'Unknown error'
        sendError(errorMessage)
        return false
      }
      return true
    }

    const runResponsesWsAttempt = async (args: {
      websocketUrl: string
      fallbackReason?: string
    }): Promise<AttemptResult> => {
      const sender = getSender(event)
      const wsAbortController = new AbortController()
      cancelCurrentAttempt = (): void => {
        wsAbortController.abort()
      }

      const result = await responsesWsManager.executeRequest({
        providerKey: providerId ?? providerBuiltinId ?? 'unknown',
        sessionKey: buildResponsesWebsocketSessionKey({
          providerKey: providerId ?? providerBuiltinId ?? 'unknown',
          model: req.model,
          sessionId: req.sessionId,
          websocketUrl: args.websocketUrl,
          sessionScope: req.responsesSessionScope
        }),
        websocketUrl: args.websocketUrl,
        headers,
        httpBody: body ?? '',
        useSystemProxy,
        allowInsecureTls,
        signal: wsAbortController.signal,
        label: requestId,
        fallbackReason: args.fallbackReason,
        onDebug: (debugInfo) => {
          sendResponsesRequestDebug(sender, req, {
            url: debugInfo.url,
            method: 'WEBSOCKET',
            headers: debugInfo.headers,
            body: debugInfo.body,
            transport: debugInfo.transport,
            fallbackReason: debugInfo.fallbackReason,
            reusedConnection: debugInfo.reusedConnection,
            websocketRequestKind: debugInfo.websocketRequestKind,
            websocketIncrementalReason: debugInfo.websocketIncrementalReason,
            previousResponseId: debugInfo.previousResponseId
          })
        },
        onEvent: (eventType, payload) => {
          sendStreamChunk(sender, requestId, createSseChunk(eventType, JSON.stringify(payload)))
          if (
            eventType === 'response.completed' ||
            eventType === 'response.failed' ||
            eventType === 'error'
          ) {
            sender?.send('api:stream-end', { requestId })
          }
        }
      })

      cancelCurrentAttempt = null
      if (result.kind === 'streamed') {
        return { kind: 'streamed' }
      }
      if (result.kind === 'fallback') {
        return { kind: 'fallback', reason: result.reason }
      }
      return { kind: 'fatal', status: 0, body: result.error }
    }

    ;(async () => {
      const responsesWsConfig = resolveResponsesWebsocketConfig({
        providerType: req.providerType,
        websocketMode: req.websocketMode,
        websocketUrl: req.websocketUrl,
        baseUrl: url,
        sessionScope: req.responsesSessionScope
      })

      const shouldTryResponsesWs =
        req.providerType === 'openai-responses' &&
        responsesWsConfig.mode !== 'disabled' &&
        Boolean(responsesWsConfig.websocketUrl)

      if (!shouldTryResponsesWs) {
        const fallbackReason =
          req.providerType === 'openai-responses' &&
          responsesWsConfig.source !== 'disabled' &&
          responsesWsConfig.reason &&
          responsesWsConfig.reason !== 'unsupported_provider'
            ? responsesWsConfig.reason
            : undefined
        await runHttpWithRetries({
          transport: 'http',
          url,
          method,
          body,
          ...(fallbackReason ? { fallbackReason } : {})
        })
        return
      }

      const websocketUrl = responsesWsConfig.websocketUrl!
      const circuitReason = responsesWsManager.getCircuitReason(
        providerId ?? providerBuiltinId ?? 'unknown',
        websocketUrl
      )
      if (circuitReason) {
        await runHttpWithRetries({
          transport: 'http',
          url,
          method,
          body,
          fallbackReason: circuitReason
        })
        return
      }

      const wsResult = await runResponsesWsAttempt({ websocketUrl })
      if (aborted) return

      if (wsResult.kind === 'streamed') return

      if (wsResult.kind === 'fallback') {
        await runHttpWithRetries({
          transport: 'http',
          url,
          method,
          body,
          fallbackReason: wsResult.reason
        })
        return
      }

      const trimmed = wsResult.body.slice(0, 2000)
      sendError(trimmed || 'Unknown WebSocket error')
    })().finally(() => {
      ipcMain.removeListener('api:abort', abortHandler)
    })
  })
}

function getSender(event: Electron.IpcMainEvent): Electron.WebContents | null {
  try {
    const sender = event.sender
    if (sender.isDestroyed() || sender.isCrashed()) {
      return null
    }
    const win = BrowserWindow.fromWebContents(sender)
    if (win && !win.isDestroyed()) {
      return sender
    }
  } catch {
    // Window may have been closed
  }
  return null
}
