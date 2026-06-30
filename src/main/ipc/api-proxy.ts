import { ipcMain, net, session, type WebContents } from 'electron'
import * as https from 'https'
import * as http from 'http'
import { URL } from 'url'
import { readSettings } from './settings-handlers'
import { applyDefaultApiUserAgent } from '../lib/api-user-agent'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'

const MAX_RESPONSE_BODY_CHARS = 10_000_000

// Retry policy for transient AI provider failures.
// Total requests sent = 1 initial + up to MAX_RETRY_ATTEMPTS retries for HTTP status failures.
const MAX_RETRY_ATTEMPTS = 10
const RETRY_BASE_DELAY_MS = 1000
const RETRY_MAX_DELAY_MS = 30_000
const RETRY_MAX_RETRY_AFTER_MS = 60_000

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
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

function sendMessagePackToWebContents(
  contents: WebContents,
  channel: string,
  payload: unknown
): void {
  const bytes = encodeMessagePackPayload(payload)
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  try {
    contents.postMessage(toMessagePackChannel(channel), arrayBuffer)
  } catch {
    contents.send(toMessagePackChannel(channel), Buffer.from(bytes))
  }
}

interface APIProxyRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  useSystemProxy?: boolean
  allowInsecureTls?: boolean
  providerId?: string
  providerBuiltinId?: string
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

const REQUEST_BODY_MANAGED_HEADERS = new Set([
  'connection',
  'content-length',
  'expect',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

function buildForwardHeaders(
  headers: Record<string, string>,
  bodyBuffer: Buffer | null,
  options: { includeContentLength?: boolean } = {}
): Record<string, string> {
  const sanitized = applyDefaultApiUserAgent(sanitizeHeaders(headers))
  const forwarded: Record<string, string> = {}
  for (const [key, value] of Object.entries(sanitized)) {
    if (REQUEST_BODY_MANAGED_HEADERS.has(key.toLowerCase())) continue
    forwarded[key] = value
  }
  if (bodyBuffer && options.includeContentLength !== false) {
    forwarded['Content-Length'] = String(bodyBuffer.byteLength)
  }
  return forwarded
}

const INSECURE_PROXY_SESSION_PARTITION = 'persist:open-cowork-provider-insecure-tls-proxy'
let insecureProxySessionState: {
  promise: Promise<Electron.Session>
  proxyRules: string | null
} | null = null

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
  const reqHeaders = buildForwardHeaders(headers, bodyBuffer, { includeContentLength: false })

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

async function handleApiRequest(
  event: { sender: WebContents },
  req: APIProxyRequest
): Promise<{ statusCode?: number; body?: string; error?: string }> {
  const {
    url,
    method,
    headers,
    body,
    useSystemProxy,
    allowInsecureTls,
    providerId,
    providerBuiltinId
  } = req
  const requestHeaders = applyDefaultApiUserAgent(sanitizeHeaders(headers))

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
    const reqHeaders = buildForwardHeaders(requestHeaders, bodyBuffer)

    return new Promise<AttemptOutcome>((resolve) => {
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers: reqHeaders,
        ...(isHttps && (allowInsecureTls ?? true) ? { rejectUnauthorized: false } : {})
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
        ? await requestViaSystemProxy({
            url,
            method,
            headers: requestHeaders,
            body,
            allowInsecureTls
          })
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
        const payload = {
          url,
          providerId,
          providerBuiltinId,
          quota
        }
        sendMessagePackToWebContents(event.sender, 'api:quota-update', payload)
      }
    }

    return { statusCode: result.statusCode, body: result.body, error: result.error }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error(`[API Proxy] request fatal error: ${errMsg}`)
    return { statusCode: 0, error: errMsg }
  }
}

export function registerApiProxyHandlers(): void {
  ipcMain.handle(toMessagePackChannel('api:request'), async (event, bytes: Uint8Array) => {
    const req = decodeMessagePackPayload<APIProxyRequest>(bytes)
    return encodeMessagePackPayload(await handleApiRequest(event, req))
  })
}
