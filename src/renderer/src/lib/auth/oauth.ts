import { nanoid } from 'nanoid'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import type { OAuthConfig, OAuthToken } from '@renderer/lib/api/types'

interface OAuthCallbackPayload {
  requestId: string
  code?: string | null
  state?: string | null
  error?: string | null
  errorDescription?: string | null
}

function base64UrlEncode(bytes: Uint8Array): string {
  let str = ''
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i])
  }
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function randomString(length = 64): string {
  const bytes = new Uint8Array(length)
  window.crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const hash = await window.crypto.subtle.digest('SHA-256', data)
  return base64UrlEncode(new Uint8Array(hash))
}

function buildAuthorizeUrl(config: OAuthConfig, params: Record<string, string>): string {
  const url = new URL(config.authorizeUrl)
  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value)
  })
  if (config.extraParams) {
    Object.entries(config.extraParams).forEach(([key, value]) => {
      if (value) url.searchParams.set(key, value)
    })
  }
  return url.toString()
}

function parseJwtAccountId(token: string | undefined): string | undefined {
  if (!token) return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  const payload = parts[1]
  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/')
    const decoded = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
    const json = JSON.parse(decoded) as Record<string, unknown>
    const accountId =
      (typeof json.account_id === 'string' && json.account_id) ||
      (typeof json.accountId === 'string' && json.accountId) ||
      (typeof json.sub === 'string' && json.sub)
    return accountId || undefined
  } catch {
    return undefined
  }
}

function normalizeTokenResponse(raw: Record<string, unknown>): OAuthToken {
  const accessToken = String(raw.access_token ?? '')
  const refreshToken = raw.refresh_token ? String(raw.refresh_token) : undefined
  const scope = raw.scope ? String(raw.scope) : undefined
  const tokenType = raw.token_type ? String(raw.token_type) : undefined

  const expiresIn = raw.expires_in ? Number(raw.expires_in) : undefined
  const expiresAt = Number.isFinite(expiresIn) ? Date.now() + (expiresIn as number) * 1000 : undefined
  const accountId =
    (typeof raw.account_id === 'string' && raw.account_id) ||
    (typeof raw.accountId === 'string' && raw.accountId) ||
    parseJwtAccountId(accessToken)

  return {
    accessToken,
    refreshToken,
    expiresAt,
    scope,
    tokenType,
    accountId,
  }
}

function buildTokenHeaders(
  mode: 'form' | 'json',
  overrides?: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = { ...(overrides ?? {}) }
  if (!headers['Content-Type']) {
    headers['Content-Type'] =
      mode === 'json' ? 'application/json' : 'application/x-www-form-urlencoded'
  }
  return headers
}

async function sendTokenRequest(
  config: OAuthConfig,
  body: string,
  headers: Record<string, string>
): Promise<OAuthToken> {
  const result = (await ipcClient.invoke('api:request', {
    url: config.tokenUrl,
    method: 'POST',
    headers,
    body,
    useSystemProxy: config.useSystemProxy,
  })) as { statusCode?: number; error?: string; body?: string }

  if (result?.error) {
    throw new Error(result.error)
  }
  if (!result || !result.body) {
    throw new Error('Empty token response')
  }
  if (result.statusCode && result.statusCode >= 400) {
    throw new Error(`HTTP ${result.statusCode}: ${result.body.slice(0, 200)}`)
  }

  const data = JSON.parse(result.body) as Record<string, unknown>
  const token = normalizeTokenResponse(data)
  if (!token.accessToken) {
    throw new Error('Missing access_token in response')
  }
  return token
}

async function exchangeToken(config: OAuthConfig, body: URLSearchParams): Promise<OAuthToken> {
  const mode = config.tokenRequestMode ?? 'form'
  const headers = buildTokenHeaders(mode, config.tokenRequestHeaders)
  const bodyStr =
    mode === 'json' ? JSON.stringify(Object.fromEntries(body)) : body.toString()
  return sendTokenRequest(config, bodyStr, headers)
}

function waitForCallback(
  requestId: string,
  timeoutMs = 300000,
  signal?: AbortSignal
): Promise<OAuthCallbackPayload> {
  return new Promise((resolve, reject) => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const stop = ipcClient.on(IPC.OAUTH_CALLBACK, (payload: OAuthCallbackPayload) => {
      if (payload.requestId !== requestId) return
      cleanup()
      resolve(payload)
    })

    const cleanup = (): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      stop()
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    const onAbort = (): void => {
      cleanup()
      const err = new Error('OAuth cancelled')
      err.name = 'AbortError'
      reject(err)
    }

    if (signal?.aborted) {
      onAbort()
      return
    }
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    timer = setTimeout(() => {
      cleanup()
      reject(new Error('OAuth timed out'))
    }, timeoutMs)
  })
}

function createAbortError(): Error {
  const err = new Error('OAuth cancelled')
  err.name = 'AbortError'
  return err
}

export async function startOAuthFlow(
  config: OAuthConfig,
  signal?: AbortSignal
): Promise<OAuthToken> {
  if (!config.authorizeUrl || !config.tokenUrl || !config.clientId) {
    throw new Error('OAuth config missing authorizeUrl/tokenUrl/clientId')
  }
  if (signal?.aborted) {
    throw createAbortError()
  }

  const requestId = nanoid()
  const usePkce = config.usePkce !== false
  const state = randomString(32)
  const codeVerifier = usePkce ? randomString(64) : ''
  const codeChallenge = usePkce ? await sha256(codeVerifier) : ''

  const startResult = (await ipcClient.invoke(IPC.OAUTH_START, {
    requestId,
    port: config.redirectPort,
    path: config.redirectPath,
    expectedState: state,
  })) as { port?: number; redirectUri?: string; error?: string }

  if (startResult?.error) {
    throw new Error(startResult.error)
  }
  const redirectUri = startResult.redirectUri
  if (!redirectUri) {
    throw new Error('Failed to start OAuth callback server')
  }
  if (signal?.aborted) {
    await ipcClient.invoke(IPC.OAUTH_STOP, { requestId })
    throw createAbortError()
  }

  const authorizeUrl = buildAuthorizeUrl(config, {
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: config.scope ?? '',
    state,
    ...(usePkce
      ? {
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
        }
      : {}),
  })

  await ipcClient.invoke('shell:openExternal', authorizeUrl)

  let callback: OAuthCallbackPayload
  try {
    callback = await waitForCallback(requestId, 300000, signal)
  } finally {
    await ipcClient.invoke(IPC.OAUTH_STOP, { requestId })
  }

  if (callback.error) {
    throw new Error(callback.errorDescription || callback.error)
  }
  if (!callback.code) {
    throw new Error('OAuth callback missing code')
  }

  const body = new URLSearchParams()
  body.set('grant_type', 'authorization_code')
  body.set('client_id', config.clientId)
  body.set('code', callback.code)
  body.set('redirect_uri', redirectUri)
  if (usePkce) body.set('code_verifier', codeVerifier)
  if (config.scope && config.includeScopeInTokenRequest !== false) {
    body.set('scope', config.scope)
  }

  return exchangeToken(config, body)
}

export async function refreshOAuthFlow(config: OAuthConfig, refreshToken: string): Promise<OAuthToken> {
  if (!config.tokenUrl || !config.clientId) {
    throw new Error('OAuth config missing tokenUrl/clientId')
  }

  const mode = config.refreshRequestMode ?? 'form'
  const scope = config.refreshScope ?? config.scope
  const headers = buildTokenHeaders(mode, config.refreshRequestHeaders)

  if (mode === 'json') {
    const payload: Record<string, string> = {
      grant_type: 'refresh_token',
      client_id: config.clientId,
      refresh_token: refreshToken,
    }
    if (scope) payload.scope = scope
    return sendTokenRequest(config, JSON.stringify(payload), headers)
  }

  const body = new URLSearchParams()
  body.set('grant_type', 'refresh_token')
  body.set('client_id', config.clientId)
  body.set('refresh_token', refreshToken)
  if (scope) body.set('scope', scope)

  return sendTokenRequest(config, body.toString(), headers)
}
