import { ipcMain, BrowserWindow, net, session } from 'electron'
import * as https from 'https'
import * as http from 'http'
import { URL } from 'url'
import { WebSocket } from 'ws'
import { HttpsProxyAgent } from 'https-proxy-agent'

interface APIStreamRequest {
  requestId: string
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  useSystemProxy?: boolean
  providerId?: string
  providerBuiltinId?: string
  transport?: 'http' | 'websocket'
  transportSessionKey?: string
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
    const str = String(value)
    if (!str) continue
    if (/\r|\n/.test(str)) continue
    sanitized[key] = str
  }
  return sanitized
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

function requestViaSystemProxy(args: {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}): Promise<{
  statusCode?: number
  error?: string
  body?: string
  headers?: Record<string, string | string[] | undefined>
}> {
  const { url, method, headers, body } = args
  const requestUrl = url.trim()
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

    const httpReq = net.request({ method, url: requestUrl })
    for (const [key, value] of Object.entries(reqHeaders)) {
      httpReq.setHeader(key, value)
    }

    httpReq.on('response', (res) => {
      let responseBody = ''
      res.on('data', (chunk: Buffer) => {
        responseBody += chunk.toString()
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

function toWebSocketUrl(url: string): string {
  const parsed = new URL(url)
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
  return parsed.toString()
}

function encodeSseEvent(eventType: string, payload: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`
}

function parseProxyResult(result: string): string | null {
  const s = result.trim().toUpperCase()
  if (!s || s === 'DIRECT') return null
  const m = s.match(/^(?:PROXY|HTTPS)\s+([^\s]+)$/i)
  if (!m) return null
  const hostPort = m[1].trim()
  if (!hostPort) return null
  return hostPort.startsWith('http') ? hostPort : `http://${hostPort}`
}

interface ResponsesWebSocketRun {
  requestId: string
  sender: Electron.WebContents
  body: Record<string, unknown>
  aborted: boolean
  cleanupAbortListener?: () => void
}

interface ResponsesWebSocketConnection {
  key: string
  wsUrl: string
  headers: Record<string, string>
  useSystemProxy?: boolean
  socket: WebSocket | null
  state: 'connecting' | 'open' | 'closed'
  connectedAt: number
  lastUsedAt: number
  openPromise: Promise<WebSocket> | null
  queue: ResponsesWebSocketRun[]
  current: ResponsesWebSocketRun | null
  pumping: boolean
  idleCloseTimer: ReturnType<typeof setTimeout> | null
  requestIdleTimer: ReturnType<typeof setTimeout> | null
}

const RESPONSES_WEBSOCKET_CONNECTIONS = new Map<string, ResponsesWebSocketConnection>()
const RESPONSES_WEBSOCKET_MAX_AGE_MS = 55 * 60 * 1000
const RESPONSES_WEBSOCKET_IDLE_CLOSE_MS = 5 * 60 * 1000
const RESPONSES_WEBSOCKET_TERMINAL_EVENTS = new Set([
  'response.completed',
  'response.failed',
  'response.incomplete',
  'response.cancelled',
  'error'
])

function buildResponsesWebSocketConnectionKey(
  req: APIStreamRequest,
  wsUrl: string,
  headers: Record<string, string>,
  body: Record<string, unknown>
): string {
  const model = typeof body.model === 'string' ? body.model : ''
  return [
    req.transportSessionKey ?? '',
    wsUrl,
    model,
    headers.Authorization ?? headers.authorization ?? '',
    headers['OpenAI-Organization'] ?? headers['openai-organization'] ?? '',
    headers['OpenAI-Project'] ?? headers['openai-project'] ?? '',
    req.useSystemProxy ? 'proxy' : 'direct'
  ].join('\u0001')
}

function describeResponsesWebSocketConnection(
  connection: Pick<ResponsesWebSocketConnection, 'key' | 'wsUrl' | 'state' | 'queue' | 'current'>
): string {
  const key = connection.key.slice(0, 12)
  return `key=${key} state=${connection.state} queue=${connection.queue.length} active=${connection.current ? 'yes' : 'no'} url=${connection.wsUrl}`
}

function isSenderAlive(sender: Electron.WebContents): boolean {
  return !sender.isDestroyed()
}

function sendResponsesWebSocketEnd(run: ResponsesWebSocketRun): void {
  run.cleanupAbortListener?.()
  run.cleanupAbortListener = undefined
  if (!isSenderAlive(run.sender)) return
  run.sender.send('api:stream-end', { requestId: run.requestId })
}

function sendResponsesWebSocketError(run: ResponsesWebSocketRun, message: string): void {
  run.cleanupAbortListener?.()
  run.cleanupAbortListener = undefined
  if (!isSenderAlive(run.sender)) return
  run.sender.send('api:stream-error', {
    requestId: run.requestId,
    error: message
  })
}

function sendResponsesWebSocketChunk(
  run: ResponsesWebSocketRun,
  eventType: string,
  payload: unknown
): void {
  if (!isSenderAlive(run.sender)) return
  run.sender.send('api:stream-chunk', {
    requestId: run.requestId,
    data: encodeSseEvent(eventType, payload)
  })
}

function clearResponsesWebSocketRequestIdle(connection: ResponsesWebSocketConnection): void {
  if (connection.requestIdleTimer) {
    clearTimeout(connection.requestIdleTimer)
    connection.requestIdleTimer = null
  }
}

function closeResponsesWebSocketSocket(
  connection: ResponsesWebSocketConnection,
  code = 1000,
  reason = 'normal closure'
): void {
  console.log(
    `[Responses WS] Close socket ${describeResponsesWebSocketConnection(connection)} code=${code} reason=${reason}`
  )
  const socket = connection.socket
  connection.socket = null
  connection.state = 'closed'
  connection.openPromise = null
  clearResponsesWebSocketRequestIdle(connection)
  if (!socket) return
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(code, reason)
  }
}

function clearResponsesWebSocketIdleClose(connection: ResponsesWebSocketConnection): void {
  if (connection.idleCloseTimer) {
    clearTimeout(connection.idleCloseTimer)
    connection.idleCloseTimer = null
  }
}

function scheduleResponsesWebSocketIdleClose(connection: ResponsesWebSocketConnection): void {
  clearResponsesWebSocketIdleClose(connection)
  if (connection.current || connection.queue.length > 0) return
  console.log(
    `[Responses WS] Schedule idle close ${describeResponsesWebSocketConnection(connection)} timeoutMs=${RESPONSES_WEBSOCKET_IDLE_CLOSE_MS}`
  )
  connection.idleCloseTimer = setTimeout(() => {
    closeResponsesWebSocketSocket(connection, 1000, 'idle close')
    RESPONSES_WEBSOCKET_CONNECTIONS.delete(connection.key)
  }, RESPONSES_WEBSOCKET_IDLE_CLOSE_MS)
}

function resetResponsesWebSocketRequestIdle(connection: ResponsesWebSocketConnection): void {
  clearResponsesWebSocketRequestIdle(connection)
  const idleTimeout = readTimeoutFromEnv('OPENCOWORK_API_IDLE_TIMEOUT_MS', 300_000)
  if (idleTimeout <= 0 || !connection.current) return
  connection.requestIdleTimer = setTimeout(() => {
    closeResponsesWebSocketSocket(connection, 4000, 'request idle timeout')
  }, idleTimeout)
}

async function createResponsesWebSocketAgent(
  wsUrl: string,
  useSystemProxy?: boolean
): Promise<InstanceType<typeof HttpsProxyAgent> | undefined> {
  if (!useSystemProxy) return undefined
  try {
    const result = await session.defaultSession.resolveProxy(wsUrl)
    const proxyUrl = parseProxyResult(result)
    return proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined
  } catch (err) {
    console.warn('[API Proxy] WebSocket resolveProxy failed, connecting direct:', err)
    return undefined
  }
}

function failResponsesWebSocketRun(
  connection: ResponsesWebSocketConnection,
  message: string
): void {
  const run = connection.current
  if (!run) return
  connection.current = null
  clearResponsesWebSocketRequestIdle(connection)
  connection.lastUsedAt = Date.now()
  sendResponsesWebSocketError(run, message)
  scheduleResponsesWebSocketIdleClose(connection)
  void pumpResponsesWebSocketConnection(connection)
}

function handleResponsesWebSocketMessage(
  connection: ResponsesWebSocketConnection,
  raw: WebSocket.RawData
): void {
  const run = connection.current
  if (!run || run.aborted) return

  connection.lastUsedAt = Date.now()
  resetResponsesWebSocketRequestIdle(connection)

  let payload: unknown
  try {
    payload = JSON.parse(raw.toString())
  } catch {
    return
  }

  const eventType =
    typeof payload === 'object' &&
    payload !== null &&
    'type' in payload &&
    typeof (payload as { type?: unknown }).type === 'string'
      ? (payload as { type: string }).type
      : 'message'

  sendResponsesWebSocketChunk(run, eventType, payload)

  if (!RESPONSES_WEBSOCKET_TERMINAL_EVENTS.has(eventType)) return

  const errorCode =
    eventType === 'error' &&
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { error?: { code?: unknown } }).error?.code === 'string'
      ? (payload as { error: { code: string } }).error.code
      : null

  console.log(
    `[Responses WS] Terminal event requestId=${run.requestId} event=${eventType}${errorCode ? ` code=${errorCode}` : ''} ${describeResponsesWebSocketConnection(connection)}`
  )

  connection.current = null
  clearResponsesWebSocketRequestIdle(connection)
  connection.lastUsedAt = Date.now()
  sendResponsesWebSocketEnd(run)

  if (errorCode === 'websocket_connection_limit_reached') {
    closeResponsesWebSocketSocket(connection, 4001, 'connection limit reached')
  }

  scheduleResponsesWebSocketIdleClose(connection)
  void pumpResponsesWebSocketConnection(connection)
}

function handleResponsesWebSocketClose(
  connection: ResponsesWebSocketConnection,
  code: number,
  reason: Buffer
): void {
  const reasonText = reason.toString().trim()
  const currentRun = connection.current
  const wasAborted = currentRun?.aborted === true
  connection.socket = null
  connection.state = 'closed'
  connection.openPromise = null
  clearResponsesWebSocketRequestIdle(connection)

  if (currentRun) {
    if (wasAborted) {
      currentRun.cleanupAbortListener?.()
      currentRun.cleanupAbortListener = undefined
      connection.current = null
    } else {
      failResponsesWebSocketRun(
        connection,
        `WebSocket closed (${code})${reasonText ? `: ${reasonText}` : ''}`
      )
    }
    return
  }

  scheduleResponsesWebSocketIdleClose(connection)
  void pumpResponsesWebSocketConnection(connection)
}

async function ensureResponsesWebSocketOpen(
  connection: ResponsesWebSocketConnection
): Promise<WebSocket> {
  clearResponsesWebSocketIdleClose(connection)

  if (
    connection.socket &&
    connection.state === 'open' &&
    connection.socket.readyState === WebSocket.OPEN &&
    Date.now() - connection.connectedAt < RESPONSES_WEBSOCKET_MAX_AGE_MS
  ) {
    console.log(
      `[Responses WS] Reuse open socket ${describeResponsesWebSocketConnection(connection)}`
    )
    return connection.socket
  }

  if (connection.socket && Date.now() - connection.connectedAt >= RESPONSES_WEBSOCKET_MAX_AGE_MS) {
    closeResponsesWebSocketSocket(connection, 4002, 'connection refresh')
  }

  if (connection.openPromise) return connection.openPromise

  connection.openPromise = (async () => {
    console.log(
      `[Responses WS] Open new socket ${describeResponsesWebSocketConnection(connection)}`
    )
    const agent = await createResponsesWebSocketAgent(connection.wsUrl, connection.useSystemProxy)
    const handshakeTimeout = readTimeoutFromEnv('OPENCOWORK_API_CONNECTION_TIMEOUT_MS', 30_000)

    return await new Promise<WebSocket>((resolve, reject) => {
      let settled = false
      const socket = new WebSocket(connection.wsUrl, {
        headers: connection.headers,
        handshakeTimeout,
        perMessageDeflate: false,
        ...(agent ? { agent } : {})
      })

      connection.socket = socket
      connection.state = 'connecting'

      const rejectOnce = (message: string): void => {
        if (settled) return
        settled = true
        connection.socket = null
        connection.state = 'closed'
        connection.openPromise = null
        reject(new Error(message))
      }

      socket.on('open', () => {
        if (settled) return
        settled = true
        connection.state = 'open'
        connection.connectedAt = Date.now()
        connection.lastUsedAt = connection.connectedAt
        connection.openPromise = null
        console.log(
          `[Responses WS] Socket opened ${describeResponsesWebSocketConnection(connection)}`
        )
        resolve(socket)
      })

      socket.on('message', (raw) => {
        handleResponsesWebSocketMessage(connection, raw)
      })

      socket.on('unexpected-response', (_request, response) => {
        rejectOnce(`WebSocket handshake failed: HTTP ${response.statusCode ?? 0}`)
      })

      socket.on('error', (err) => {
        if (!settled) {
          rejectOnce(err.message)
          return
        }
        console.error('[API Proxy] Responses WebSocket error:', err)
      })

      socket.on('close', (code, reason) => {
        console.log(
          `[Responses WS] Socket closed ${describeResponsesWebSocketConnection(connection)} code=${code} reason=${reason.toString().trim()}`
        )
        if (!settled) {
          rejectOnce(`WebSocket closed (${code})${reason.toString().trim()}`)
          return
        }
        handleResponsesWebSocketClose(connection, code, reason)
      })
    })
  })()

  return connection.openPromise
}

async function pumpResponsesWebSocketConnection(
  connection: ResponsesWebSocketConnection
): Promise<void> {
  if (connection.pumping) return
  connection.pumping = true

  try {
    while (!connection.current) {
      const run = connection.queue.shift()
      if (!run) {
        scheduleResponsesWebSocketIdleClose(connection)
        return
      }
      if (run.aborted || !isSenderAlive(run.sender)) {
        run.cleanupAbortListener?.()
        run.cleanupAbortListener = undefined
        continue
      }

      connection.current = run
      resetResponsesWebSocketRequestIdle(connection)

      let socket: WebSocket
      try {
        socket = await ensureResponsesWebSocketOpen(connection)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        failResponsesWebSocketRun(connection, message)
        continue
      }

      if (run.aborted || connection.current !== run) {
        if (connection.current === run) {
          connection.current = null
          run.cleanupAbortListener?.()
          run.cleanupAbortListener = undefined
        }
        continue
      }

      try {
        console.log(
          `[Responses WS] Send response.create requestId=${run.requestId} previous_response_id=${typeof run.body.previous_response_id === 'string' ? run.body.previous_response_id : 'none'} ${describeResponsesWebSocketConnection(connection)}`
        )
        socket.send(
          JSON.stringify({
            type: 'response.create',
            ...run.body
          }),
          (err) => {
            if (err && connection.current === run) {
              failResponsesWebSocketRun(connection, err.message)
              closeResponsesWebSocketSocket(connection, 1011, 'send failed')
            }
          }
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        failResponsesWebSocketRun(connection, message)
        closeResponsesWebSocketSocket(connection, 1011, 'send failed')
        continue
      }

      connection.lastUsedAt = Date.now()
      return
    }
  } finally {
    connection.pumping = false
  }
}

async function streamViaResponsesWebSocket(
  event: Electron.IpcMainEvent,
  req: APIStreamRequest
): Promise<void> {
  const { requestId, url, headers, body, useSystemProxy } = req
  const sender = getSender(event)
  if (!sender) return

  let requestBody: Record<string, unknown>
  try {
    requestBody = body ? (JSON.parse(body) as Record<string, unknown>) : {}
  } catch {
    sender.send('api:stream-error', {
      requestId,
      error: 'Invalid WebSocket request body'
    })
    return
  }

  delete requestBody.stream
  delete requestBody.background

  const wsUrl = toWebSocketUrl(url)
  const wsHeaders = sanitizeHeaders({ ...headers })
  delete wsHeaders['Content-Type']
  delete wsHeaders['content-type']

  const connectionKey = buildResponsesWebSocketConnectionKey(req, wsUrl, wsHeaders, requestBody)
  let connection = RESPONSES_WEBSOCKET_CONNECTIONS.get(connectionKey)
  if (!connection) {
    console.log(
      `[Responses WS] Create connection bucket key=${connectionKey.slice(0, 12)} url=${wsUrl}`
    )
    connection = {
      key: connectionKey,
      wsUrl,
      headers: wsHeaders,
      useSystemProxy,
      socket: null,
      state: 'closed',
      connectedAt: 0,
      lastUsedAt: Date.now(),
      openPromise: null,
      queue: [],
      current: null,
      pumping: false,
      idleCloseTimer: null,
      requestIdleTimer: null
    }
    RESPONSES_WEBSOCKET_CONNECTIONS.set(connectionKey, connection)
  }

  const run: ResponsesWebSocketRun = {
    requestId,
    sender,
    body: requestBody,
    aborted: false
  }

  console.log(
    `[Responses WS] Queue request requestId=${requestId} key=${connectionKey.slice(0, 12)} previous_response_id=${typeof requestBody.previous_response_id === 'string' ? requestBody.previous_response_id : 'none'} model=${typeof requestBody.model === 'string' ? requestBody.model : ''}`
  )

  const abortHandler = (_event: Electron.IpcMainEvent, data: { requestId: string }): void => {
    if (data.requestId !== requestId) return
    run.aborted = true

    if (connection.current === run) {
      closeResponsesWebSocketSocket(connection, 4000, 'aborted')
      return
    }

    const index = connection.queue.indexOf(run)
    if (index >= 0) {
      connection.queue.splice(index, 1)
    }
    run.cleanupAbortListener?.()
    run.cleanupAbortListener = undefined
  }

  run.cleanupAbortListener = () => {
    ipcMain.removeListener('api:abort', abortHandler)
  }
  ipcMain.on('api:abort', abortHandler)

  connection.queue.push(run)
  void pumpResponsesWebSocketConnection(connection)
}

export function registerApiProxyHandlers(): void {
  // Handle non-streaming API requests (e.g., test connection)
  ipcMain.handle('api:request', async (event, req: Omit<APIStreamRequest, 'requestId'>) => {
    const { url, method, headers, body, useSystemProxy, providerId, providerBuiltinId } = req
    try {
      console.log(`[API Proxy] request ${method} ${url}`)
      if (useSystemProxy) {
        const result = await requestViaSystemProxy({ url, method, headers, body })
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
      }
      const parsedUrl = new URL(url)
      const isHttps = parsedUrl.protocol === 'https:'
      const httpModule = isHttps ? https : http

      const bodyBuffer = body ? Buffer.from(body, 'utf-8') : null
      const reqHeaders = { ...headers }
      if (bodyBuffer) {
        reqHeaders['Content-Length'] = String(bodyBuffer.byteLength)
      }

      return new Promise((resolve) => {
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
            responseBody += chunk.toString()
          })
          res.on('end', () => {
            if (providerId || providerBuiltinId) {
              const quota = extractCodexQuota(
                res.headers as Record<string, string | string[] | undefined>
              )
              if (quota && event.sender) {
                event.sender.send('api:quota-update', {
                  url,
                  providerId,
                  providerBuiltinId,
                  quota
                })
              }
            }
            resolve({ statusCode: res.statusCode, body: responseBody })
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
      providerId,
      providerBuiltinId,
      transport
    } = req

    try {
      console.log(
        `[API Proxy] stream-request[${requestId}] ${method} ${url} transport=${String(transport ?? 'http')}`
      )
      if (transport === 'websocket') {
        void streamViaResponsesWebSocket(event, req).catch((err) => {
          console.error('[API Proxy] WebSocket stream error:', err)
        })
        return
      }

      const STREAM_CHUNK_FLUSH_MS = 16
      const STREAM_CHUNK_MAX_BUFFER_CHARS = 8_192
      let bufferedChunk = ''
      let chunkFlushTimer: ReturnType<typeof setTimeout> | null = null

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
          sender.send('api:stream-chunk', {
            requestId,
            data: bufferedChunk
          })
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

      if (useSystemProxy) {
        const requestUrl = url.trim()
        const bodyBuffer = body ? Buffer.from(body, 'utf-8') : null
        const reqHeaders = sanitizeHeaders({ ...headers })

        // Timeouts (ms):
        // - Connection: max wait for the server to start responding (first byte)
        // - Idle: max gap between consecutive data chunks during streaming
        const CONNECTION_TIMEOUT = readTimeoutFromEnv(
          'OPENCOWORK_API_CONNECTION_TIMEOUT_MS',
          180_000
        )
        const IDLE_TIMEOUT = readTimeoutFromEnv('OPENCOWORK_API_IDLE_TIMEOUT_MS', 300_000)
        let idleTimer: ReturnType<typeof setTimeout> | null = null

        const clearIdleTimer = (): void => {
          if (idleTimer) {
            clearTimeout(idleTimer)
            idleTimer = null
          }
        }

        const resetIdleTimer = (req: Electron.ClientRequest): void => {
          if (IDLE_TIMEOUT <= 0) return
          clearIdleTimer()
          idleTimer = setTimeout(() => {
            console.warn(`[API Proxy] Idle timeout (${IDLE_TIMEOUT}ms) for ${requestId}`)
            cancelNetRequest(req)
          }, IDLE_TIMEOUT)
        }

        const httpReq = net.request({ method, url: requestUrl })
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

        httpReq.on('response', (res) => {
          clearConnectionTimer()
          const statusCode = res.statusCode || 0
          sendQuotaUpdate(
            event,
            { requestId, url, providerId, providerBuiltinId },
            res.headers ?? {}
          )

          // For non-2xx, collect full body and send as error
          if (statusCode < 200 || statusCode >= 300) {
            clearIdleTimer()
            let errorBody = ''
            res.on('data', (chunk: Buffer) => {
              if (errorBody.length < 4000) errorBody += chunk.toString()
            })
            res.on('end', () => {
              console.error(
                `[API Proxy] stream-request[${requestId}] HTTP ${statusCode}: ${errorBody.slice(0, 500)}`
              )
              const sender = getSender(event)
              if (sender) {
                sender.send('api:stream-error', {
                  requestId,
                  error: `HTTP ${statusCode}: ${errorBody.slice(0, 2000)}`
                })
              }
            })
            return
          }

          // Stream SSE chunks to renderer
          res.on('data', (chunk: Buffer) => {
            resetIdleTimer(httpReq)
            pushStreamChunk(chunk)
          })

          res.on('end', () => {
            clearIdleTimer()
            flushBufferedChunk()
            const sender = getSender(event)
            if (sender) {
              sender.send('api:stream-end', { requestId })
            }
          })

          res.on('error', (err) => {
            clearIdleTimer()
            clearChunkFlushTimer()
            bufferedChunk = ''
            console.error(`[API Proxy] stream-request[${requestId}] response error: ${err.message}`)
            const sender = getSender(event)
            if (sender) {
              sender.send('api:stream-error', {
                requestId,
                error: err.message
              })
            }
          })
        })

        // Connection timeout: abort if the server doesn't respond at all
        if (CONNECTION_TIMEOUT > 0) {
          connectionTimer = setTimeout(() => {
            console.warn(
              `[API Proxy] Connection timeout (${CONNECTION_TIMEOUT}ms) for ${requestId}`
            )
            cancelNetRequest(httpReq)
            const sender = getSender(event)
            if (sender) {
              sender.send('api:stream-error', {
                requestId,
                error: `Connection timeout (${CONNECTION_TIMEOUT / 1000}s)`
              })
            }
          }, CONNECTION_TIMEOUT)
        }

        httpReq.on('error', (err) => {
          clearConnectionTimer()
          clearIdleTimer()
          clearChunkFlushTimer()
          bufferedChunk = ''
          console.error(`[API Proxy] stream-request[${requestId}] request error: ${err.message}`)
          const sender = getSender(event)
          if (sender) {
            sender.send('api:stream-error', {
              requestId,
              error: err.message
            })
          }
        })

        // Handle abort from renderer
        const abortHandler = (_event: Electron.IpcMainEvent, data: { requestId: string }): void => {
          if (data.requestId === requestId) {
            clearConnectionTimer()
            clearIdleTimer()
            clearChunkFlushTimer()
            bufferedChunk = ''
            cancelNetRequest(httpReq)
            ipcMain.removeListener('api:abort', abortHandler)
          }
        }
        ipcMain.on('api:abort', abortHandler)

        // Clean up abort listener and timers when request completes
        httpReq.on('close', () => {
          clearConnectionTimer()
          clearIdleTimer()
          clearChunkFlushTimer()
          bufferedChunk = ''
          ipcMain.removeListener('api:abort', abortHandler)
        })

        if (bodyBuffer) {
          httpReq.write(bodyBuffer)
        }
        httpReq.end()
        return
      }
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
        headers: reqHeaders
      }

      // Timeouts (ms):
      // - Connection: max wait for the server to start responding (first byte)
      // - Idle: max gap between consecutive data chunks during streaming
      const CONNECTION_TIMEOUT = readTimeoutFromEnv('OPENCOWORK_API_CONNECTION_TIMEOUT_MS', 180_000)
      const IDLE_TIMEOUT = readTimeoutFromEnv('OPENCOWORK_API_IDLE_TIMEOUT_MS', 300_000)
      let idleTimer: ReturnType<typeof setTimeout> | null = null

      const clearIdleTimer = (): void => {
        if (idleTimer) {
          clearTimeout(idleTimer)
          idleTimer = null
        }
      }

      const resetIdleTimer = (req: http.ClientRequest): void => {
        if (IDLE_TIMEOUT <= 0) return
        clearIdleTimer()
        idleTimer = setTimeout(() => {
          console.warn(`[API Proxy] Idle timeout (${IDLE_TIMEOUT}ms) for ${requestId}`)
          req.destroy(new Error(`Stream idle timeout (${IDLE_TIMEOUT / 1000}s with no data)`))
        }, IDLE_TIMEOUT)
      }

      const httpReq = httpModule.request(options, (res) => {
        const statusCode = res.statusCode || 0
        sendQuotaUpdate(event, { requestId, url, providerId, providerBuiltinId }, res.headers ?? {})

        // For non-2xx, collect full body and send as error
        if (statusCode < 200 || statusCode >= 300) {
          clearIdleTimer()
          let errorBody = ''
          res.on('data', (chunk: Buffer) => {
            if (errorBody.length < 4000) errorBody += chunk.toString()
          })
          res.on('end', () => {
            console.error(
              `[API Proxy] stream-request[${requestId}] HTTP ${statusCode}: ${errorBody.slice(0, 500)}`
            )
            const sender = getSender(event)
            if (sender) {
              sender.send('api:stream-error', {
                requestId,
                error: `HTTP ${statusCode}: ${errorBody.slice(0, 2000)}`
              })
            }
          })
          return
        }

        // Stream SSE chunks to renderer
        res.on('data', (chunk: Buffer) => {
          resetIdleTimer(httpReq)
          pushStreamChunk(chunk)
        })

        res.on('end', () => {
          clearIdleTimer()
          flushBufferedChunk()
          const sender = getSender(event)
          if (sender) {
            sender.send('api:stream-end', { requestId })
          }
        })

        res.on('error', (err) => {
          clearIdleTimer()
          clearChunkFlushTimer()
          bufferedChunk = ''
          console.error(`[API Proxy] stream-request[${requestId}] response error: ${err.message}`)
          const sender = getSender(event)
          if (sender) {
            sender.send('api:stream-error', {
              requestId,
              error: err.message
            })
          }
        })
      })

      // Connection timeout: abort if the server doesn't respond at all
      if (CONNECTION_TIMEOUT > 0) {
        httpReq.setTimeout(CONNECTION_TIMEOUT, () => {
          console.warn(`[API Proxy] Connection timeout (${CONNECTION_TIMEOUT}ms) for ${requestId}`)
          httpReq.destroy(new Error(`Connection timeout (${CONNECTION_TIMEOUT / 1000}s)`))
        })
      }

      httpReq.on('error', (err) => {
        clearIdleTimer()
        clearChunkFlushTimer()
        bufferedChunk = ''
        console.error(`[API Proxy] stream-request[${requestId}] request error: ${err.message}`)
        const sender = getSender(event)
        if (sender) {
          sender.send('api:stream-error', {
            requestId,
            error: err.message
          })
        }
      })

      // Handle abort from renderer
      const abortHandler = (_event: Electron.IpcMainEvent, data: { requestId: string }): void => {
        if (data.requestId === requestId) {
          clearIdleTimer()
          clearChunkFlushTimer()
          bufferedChunk = ''
          httpReq.destroy()
          ipcMain.removeListener('api:abort', abortHandler)
        }
      }
      ipcMain.on('api:abort', abortHandler)

      // Clean up abort listener and timers when request completes
      httpReq.on('close', () => {
        clearIdleTimer()
        clearChunkFlushTimer()
        bufferedChunk = ''
        ipcMain.removeListener('api:abort', abortHandler)
      })

      if (bodyBuffer) {
        httpReq.write(bodyBuffer)
      }
      httpReq.end()
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[API Proxy] stream-request[${requestId}] fatal error: ${errMsg}`)
      const sender = getSender(event)
      if (sender) {
        sender.send('api:stream-error', {
          requestId,
          error: errMsg
        })
      }
    }
  })
}

function getSender(event: Electron.IpcMainEvent): Electron.WebContents | null {
  try {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) {
      return event.sender
    }
  } catch {
    // Window may have been closed
  }
  return null
}
