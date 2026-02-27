import { ipcMain } from 'electron'
import * as http from 'http'
import { URL } from 'url'

interface OAuthStartArgs {
  requestId: string
  port?: number
  path?: string
  expectedState?: string
}

interface OAuthCallbackPayload {
  requestId: string
  code?: string | null
  state?: string | null
  error?: string | null
  errorDescription?: string | null
}

const servers = new Map<
  string,
  { server: http.Server; port: number; path: string; sender: Electron.WebContents; expectedState?: string }
>()

function buildCallbackHtml(message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OAuth Completed</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 32px; color: #111; }
    .card { max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #ddd; border-radius: 12px; }
    h1 { font-size: 18px; margin: 0 0 8px; }
    p { margin: 0; color: #555; }
  </style>
</head>
<body>
  <div class="card">
    <h1>OAuth Completed</h1>
    <p>${message}</p>
  </div>
</body>
</html>`
}

export function registerOauthHandlers(): void {
  ipcMain.handle('oauth:start', async (event, args: OAuthStartArgs) => {
    const requestId = args.requestId
    if (!requestId) {
      return { error: 'requestId is required' }
    }

    const existing = servers.get(requestId)
    if (existing) {
      const redirectUri = `http://localhost:${existing.port}${existing.path}`
      return { port: existing.port, redirectUri }
    }

    const path = args.path?.startsWith('/') ? args.path : `/${args.path || 'auth/callback'}`
    const requestedPort = typeof args.port === 'number' ? args.port : 0
    const sender = event.sender

    return new Promise<{ port: number; redirectUri: string }>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        try {
          const reqUrl = new URL(req.url || '', `http://localhost:${requestedPort || 0}`)
          if (reqUrl.pathname !== path) {
            res.statusCode = 404
            res.end('Not Found')
            return
          }

          const code = reqUrl.searchParams.get('code')
          const state = reqUrl.searchParams.get('state')
          const error = reqUrl.searchParams.get('error')
          const errorDescription = reqUrl.searchParams.get('error_description')

          const expectedState = servers.get(requestId)?.expectedState
          if (expectedState && state && expectedState !== state) {
            const payload: OAuthCallbackPayload = {
              requestId,
              error: 'state_mismatch',
              errorDescription: 'OAuth state mismatch',
              state,
            }
            sender.send('oauth:callback', payload)
            res.statusCode = 400
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(buildCallbackHtml('State mismatch. You can close this window.'))
            cleanup(requestId)
            return
          }

          const payload: OAuthCallbackPayload = {
            requestId,
            code,
            state,
            error,
            errorDescription,
          }
          sender.send('oauth:callback', payload)

          res.statusCode = 200
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(buildCallbackHtml('Login succeeded. You can close this window.'))
          cleanup(requestId)
        } catch (err) {
          const payload: OAuthCallbackPayload = {
            requestId,
            error: 'callback_error',
            errorDescription: err instanceof Error ? err.message : String(err),
          }
          sender.send('oauth:callback', payload)
          res.statusCode = 500
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(buildCallbackHtml('OAuth callback failed. You can close this window.'))
          cleanup(requestId)
        }
      })

      server.on('error', (err) => {
        reject(err)
      })

      server.listen(requestedPort, 'localhost', () => {
        const address = server.address()
        const actualPort = typeof address === 'object' && address ? address.port : requestedPort
        servers.set(requestId, {
          server,
          port: actualPort,
          path,
          sender,
          expectedState: args.expectedState,
        })
        resolve({ port: actualPort, redirectUri: `http://localhost:${actualPort}${path}` })
      })
    })
  })

  ipcMain.handle('oauth:stop', async (_event, args: { requestId: string }) => {
    if (!args?.requestId) return { success: true }
    cleanup(args.requestId)
    return { success: true }
  })
}

function cleanup(requestId: string): void {
  const existing = servers.get(requestId)
  if (!existing) return
  try {
    existing.server.close()
  } catch {
    // ignore
  }
  servers.delete(requestId)
}
