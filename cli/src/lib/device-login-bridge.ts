import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { OPENCOWORK_DEVICE_LOGIN_URL } from '../vendor/routin-credential.js'

const CALLBACK_PATH = '/opencowork-device-login'
const DEFAULT_TIMEOUT_MS = 5 * 60_000

export interface DeviceLoginBridge {
  /** Full Routin device-login URL including localhost callback + state. */
  loginUrl: string
  close(): void
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      if (chunks.reduce((sum, part) => sum + part.length, 0) > 64_000) {
        reject(new Error('Request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  })
  res.end(payload)
}

function parseCredential(raw: unknown): { apiKey: string; kind?: string } | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey.trim() : ''
  if (!apiKey) return null
  const kind = typeof record.kind === 'string' ? record.kind : undefined
  return kind ? { apiKey, kind } : { apiKey }
}

/**
 * Start a one-shot 127.0.0.1 HTTP callback so the Routin device-login page can POST the
 * chosen API key back to a CLI-only install (which cannot receive `opencowork://` deep links).
 */
export async function startDeviceLoginBridge(options: {
  onCredential(apiKey: string, kind?: string): void
  timeoutMs?: number
}): Promise<DeviceLoginBridge> {
  const state = randomUUID()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let settled = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let listeningServer: Server | undefined

  const close = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (listeningServer) {
      listeningServer.close()
      listeningServer = undefined
    }
  }

  const finish = (apiKey: string, kind?: string): void => {
    if (settled) return
    settled = true
    try {
      options.onCredential(apiKey, kind)
    } finally {
      // Close on next tick so the HTTP response can flush first.
      setTimeout(close, 25)
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'OPTIONS' && url.pathname === CALLBACK_PATH) {
      sendJson(res, 204, {})
      return
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method !== 'POST' || url.pathname !== CALLBACK_PATH) {
      sendJson(res, 404, { ok: false, error: 'not_found' })
      return
    }

    void readBody(req)
      .then((body) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(body) as unknown
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid_json' })
          return
        }
        const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
        if (!record || record.state !== state) {
          sendJson(res, 403, { ok: false, error: 'invalid_state' })
          return
        }
        const credential = parseCredential(parsed)
        if (!credential) {
          sendJson(res, 400, { ok: false, error: 'missing_api_key' })
          return
        }
        sendJson(res, 200, { ok: true })
        finish(credential.apiKey, credential.kind)
      })
      .catch(() => {
        sendJson(res, 400, { ok: false, error: 'bad_request' })
      })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  listeningServer = server
  const address = server.address()
  if (!address || typeof address === 'string') {
    close()
    throw new Error('Failed to bind device-login callback on 127.0.0.1')
  }

  timer = setTimeout(() => {
    close()
  }, timeoutMs)

  const loginUrl = new URL(OPENCOWORK_DEVICE_LOGIN_URL)
  loginUrl.searchParams.set('callback', `http://127.0.0.1:${address.port}${CALLBACK_PATH}`)
  loginUrl.searchParams.set('state', state)
  loginUrl.searchParams.set('client', 'cli')

  return { loginUrl: loginUrl.toString(), close }
}
