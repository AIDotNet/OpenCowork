import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  buildOpenCoworkDeviceLoginUrl,
  OPENCOWORK_IMPORT_MAX_PAYLOAD_BYTES,
  parseOpenCoworkImportCallbackBody,
  type OpenCoworkImportCallbackParse
} from '../vendor/opencowork-import-protocol.js'

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
      if (
        chunks.reduce((sum, part) => sum + part.length, 0) > OPENCOWORK_IMPORT_MAX_PAYLOAD_BYTES
      ) {
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

/**
 * Start a one-shot 127.0.0.1 HTTP callback so the Routin device-login page can POST the
 * chosen credential (v1) or Import Protocol v2 document back to a CLI-only install.
 */
export async function startDeviceLoginBridge(options: {
  onImport(parsed: OpenCoworkImportCallbackParse): void | Promise<void>
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

  const finish = (parsed: OpenCoworkImportCallbackParse): void => {
    if (settled) return
    settled = true
    void Promise.resolve(options.onImport(parsed)).finally(() => {
      setTimeout(close, 25)
    })
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
        const record =
          parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
        if (!record || record.state !== state) {
          sendJson(res, 403, { ok: false, error: 'invalid_state' })
          return
        }
        const imported = parseOpenCoworkImportCallbackBody(parsed)
        if (!imported) {
          sendJson(res, 400, { ok: false, error: 'missing_api_key' })
          return
        }
        sendJson(res, 200, { ok: true })
        finish(imported)
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

  return {
    loginUrl: buildOpenCoworkDeviceLoginUrl({
      client: 'cli',
      callback: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
      state
    }),
    close
  }
}
