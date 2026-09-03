import { BrowserWindow, shell } from 'electron'
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import {
  ACCOUNT_OAUTH_CLIENT_ID,
  ACCOUNT_OAUTH_DEFAULT_BASE_URL,
  ACCOUNT_OAUTH_REDIRECT_URI,
  ACCOUNT_OAUTH_SCOPE,
  ACCOUNT_OAUTH_TIMEOUT_MS,
  type AccountOAuthChangedEvent,
  type AccountOAuthErrorCode,
  type AccountOAuthSession,
  type AccountOAuthUser
} from '../../shared/account-oauth'
import {
  parseOAuthError,
  parseOAuthTokenResponse,
  parseOAuthUserInfoResponse,
  type ParsedOAuthTokenResponse
} from '../../shared/account-oauth-protocol'
import { getDefaultApiUserAgent } from '../lib/api-user-agent'
import {
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'
import type { OpenCoworkOAuthCallback } from '../lib/opencowork-oauth-link'
import {
  clearAccountCredentials,
  loadAccountCredentials,
  saveAccountCredentials,
  type AccountOAuthCredentials
} from './oauth-credential-store'

// Owner of the desktop OAuth flow. Main drives PKCE, the system browser, and the
// token endpoint; the renderer only observes the resulting profile.

const REFRESH_SKEW_MS = 2 * 60_000
const REQUEST_TIMEOUT_MS = 20_000

interface PendingAuthorization {
  state: string
  codeVerifier: string
  createdAt: number
  timeout: NodeJS.Timeout
}

let pending: PendingAuthorization | null = null
let cached: AccountOAuthCredentials | null | undefined

export function getAccountApiBaseUrl(): string {
  return getBaseUrl()
}

function getBaseUrl(): string {
  const configured = process.env.OPENCOWORK_OAUTH_BASE_URL?.trim()
  if (!configured) return ACCOUNT_OAUTH_DEFAULT_BASE_URL
  return configured.replace(/\/+$/, '')
}

function endpoint(pathname: string): string {
  return `${getBaseUrl()}${pathname}`
}

function base64Url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function createCodeVerifier(): string {
  return base64Url(randomBytes(64))
}

function createCodeChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest())
}

function safeStateEquals(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf-8')
  const b = Buffer.from(received, 'utf-8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function toSession(credentials: AccountOAuthCredentials | null): AccountOAuthSession | null {
  if (!credentials) return null
  return {
    user: credentials.user,
    scope: credentials.scope,
    expiresAt: credentials.expiresAt
  }
}

function readCredentials(): AccountOAuthCredentials | null {
  if (cached === undefined) cached = loadAccountCredentials()
  return cached
}

function writeCredentials(credentials: AccountOAuthCredentials | null): void {
  cached = credentials
  if (credentials) saveAccountCredentials(credentials)
  else clearAccountCredentials()
}

function broadcast(event: AccountOAuthChangedEvent): void {
  const payload = encodeMessagePackPayload(event)
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('account-oauth:changed', event)
    win.webContents.send(toMessagePackChannel('account-oauth:changed'), payload)
  }
}

function clearPending(): void {
  if (!pending) return
  clearTimeout(pending.timeout)
  pending = null
}

function failPending(error: AccountOAuthErrorCode): void {
  clearPending()
  broadcast({ session: toSession(readCredentials()), error })
}

const OAUTH_SENSITIVE_KEYS = new Set([
  'access_token',
  'accessToken',
  'AccessToken',
  'refresh_token',
  'refreshToken',
  'RefreshToken',
  'code',
  'Code',
  'state',
  'State',
  'code_verifier',
  'codeVerifier',
  'CodeVerifier',
  'client_secret',
  'clientSecret',
  'ClientSecret'
])

function redactOAuthValue(value: unknown, key?: string): unknown {
  if (key && OAUTH_SENSITIVE_KEYS.has(key)) return '[redacted]'
  if (Array.isArray(value)) return value.map((item) => redactOAuthValue(item))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactOAuthValue(entryValue, entryKey)
    ])
  )
}

function formatOAuthBody(body: string): string {
  try {
    return JSON.stringify(redactOAuthValue(JSON.parse(body)))
  } catch {
    return body.length > 16_000 ? `${body.slice(0, 16_000)}…[truncated]` : body
  }
}

function oauthErrorSummary(json: Record<string, unknown> | null): string {
  const parsed = parseOAuthError(json)
  return parsed.description
    ? `${parsed.code}: ${parsed.description.slice(0, 300)}`
    : parsed.code
}

async function postForm(
  stage: string,
  url: string,
  body: Record<string, string>
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': getDefaultApiUserAgent()
        },
        body: new URLSearchParams(body).toString(),
        signal: controller.signal
      })
    } catch (error) {
      console.warn(
        `[AccountOAuth] ${stage} request threw: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      throw error
    }
    const responseText = await response.text()
    let json: Record<string, unknown> | null = null
    try {
      json = JSON.parse(responseText) as Record<string, unknown>
    } catch {
      json = null
    }
    console.log(`[AccountOAuth] ${stage} response: ${JSON.stringify({
      url: new URL(url).pathname,
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: formatOAuthBody(responseText)
    })}`)
    if (!response.ok) {
      console.warn(
        `[AccountOAuth] ${stage} failed: HTTP ${response.status} (${oauthErrorSummary(json)})`
      )
    } else {
      console.log(`[AccountOAuth] ${stage} succeeded: HTTP ${response.status}`)
    }
    return { ok: response.ok, status: response.status, json }
  } finally {
    clearTimeout(timer)
  }
}

async function fetchUserInfo(accessToken: string): Promise<AccountOAuthUser | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(endpoint('/api/oauth2/userinfo'), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': getDefaultApiUserAgent()
      },
      signal: controller.signal
    })
    const responseText = await response.text()
    let payload: Record<string, unknown> | null = null
    try {
      payload = JSON.parse(responseText) as Record<string, unknown>
    } catch {
      payload = null
    }
    console.log(`[AccountOAuth] userinfo response: ${JSON.stringify({
      url: '/api/oauth2/userinfo',
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: formatOAuthBody(responseText)
    })}`)
    if (!response.ok) {
      console.warn(
        `[AccountOAuth] userinfo failed: HTTP ${response.status} (${oauthErrorSummary(payload)})`
      )
      return null
    }
    const user = parseOAuthUserInfoResponse(payload)
    if (!user) {
      console.warn('[AccountOAuth] userinfo failed: response did not contain a valid sub')
      return null
    }
    return user
  } catch (error) {
    console.warn(
      `[AccountOAuth] userinfo request threw: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return null
  } finally {
    clearTimeout(timer)
  }
}

function buildCredentials(
  token: ParsedOAuthTokenResponse,
  user: AccountOAuthUser,
  fallbackRefreshToken: string | null
): AccountOAuthCredentials {
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken ?? fallbackRefreshToken,
    expiresAt: token.expiresIn ? Date.now() + token.expiresIn * 1000 : null,
    scope: token.scope,
    tokenType: token.tokenType,
    user,
    updatedAt: Date.now()
  }
}

export function getAccountSession(): AccountOAuthSession | null {
  return toSession(readCredentials())
}

/** Main-process only. Returns a currently-valid access token, refreshing when near expiry. */
export async function getValidAccountAccessToken(): Promise<string | null> {
  await refreshAccountOAuth()
  return readCredentials()?.accessToken ?? null
}

export async function startAccountOAuth(): Promise<{
  started: boolean
  error?: AccountOAuthErrorCode
}> {
  clearPending()

  const state = base64Url(randomBytes(32))
  const codeVerifier = createCodeVerifier()
  pending = {
    state,
    codeVerifier,
    createdAt: Date.now(),
    // The browser may never come back (user closed the tab, denied in a way that
    // does not redirect). Abandon the flow so the UI can leave its pending state.
    timeout: setTimeout(() => failPending('timeout'), ACCOUNT_OAUTH_TIMEOUT_MS)
  }

  const authorizeUrl = new URL(endpoint('/api/oauth2/authorize'))
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('client_id', ACCOUNT_OAUTH_CLIENT_ID)
  authorizeUrl.searchParams.set('redirect_uri', ACCOUNT_OAUTH_REDIRECT_URI)
  authorizeUrl.searchParams.set('scope', ACCOUNT_OAUTH_SCOPE)
  authorizeUrl.searchParams.set('state', state)
  authorizeUrl.searchParams.set('code_challenge', createCodeChallenge(codeVerifier))
  authorizeUrl.searchParams.set('code_challenge_method', 'S256')

  try {
    await shell.openExternal(authorizeUrl.toString())
    return { started: true }
  } catch (error) {
    console.warn('[AccountOAuth] Failed to open the system browser:', error)
    clearPending()
    return { started: false, error: 'network_error' }
  }
}

export function cancelAccountOAuth(): void {
  clearPending()
}

/** Consumes a deep-link callback. Returns true when it belonged to a pending flow. */
export async function completeAccountOAuth(callback: OpenCoworkOAuthCallback): Promise<boolean> {
  const request = pending
  if (!request) {
    // A callback without a pending request must never write credentials.
    console.warn('[AccountOAuth] Received an OAuth callback without a pending request')
    return false
  }

  console.log(`[AccountOAuth] callback received: ${JSON.stringify({
    codePresent: Boolean(callback.code),
    codeLength: callback.code?.length ?? 0,
    statePresent: Boolean(callback.state),
    stateLength: callback.state?.length ?? 0,
    error: callback.error,
    errorDescription: callback.errorDescription
      ? callback.errorDescription.slice(0, 300)
      : null
  })}`)

  if (callback.error) {
    console.warn(
      `[AccountOAuth] callback returned OAuth error: ${callback.error}` +
        (callback.errorDescription ? ` (${callback.errorDescription.slice(0, 300)})` : '')
    )
    failPending(callback.error)
    return true
  }

  if (!callback.state || !safeStateEquals(request.state, callback.state)) {
    console.warn('[AccountOAuth] callback failed: state mismatch or missing state')
    failPending('state_mismatch')
    return true
  }

  if (!callback.code) {
    console.warn('[AccountOAuth] callback failed: authorization code is missing')
    failPending('invalid_request')
    return true
  }

  clearPending()

  const { ok, json } = await postForm('authorization_code', endpoint('/api/oauth2/token'), {
    grant_type: 'authorization_code',
    client_id: ACCOUNT_OAUTH_CLIENT_ID,
    code: callback.code,
    redirect_uri: ACCOUNT_OAUTH_REDIRECT_URI,
    code_verifier: request.codeVerifier
  })

  if (!ok || !json) {
    console.warn(
      `[AccountOAuth] authorization_code failed: no usable OAuth response (${oauthErrorSummary(json)})`
    )
    broadcast({ session: toSession(readCredentials()), error: parseOAuthError(json).code })
    return true
  }

  const token = parseOAuthTokenResponse(json)
  if (!token) {
    console.warn('[AccountOAuth] authorization_code failed: access_token is missing')
    broadcast({ session: toSession(readCredentials()), error: 'invalid_grant' })
    return true
  }

  const user = await fetchUserInfo(token.accessToken)
  if (!user) {
    broadcast({ session: toSession(readCredentials()), error: 'network_error' })
    return true
  }

  const credentials = buildCredentials(token, user, null)

  writeCredentials(credentials)
  broadcast({ session: toSession(credentials) })
  return true
}

/**
 * Refreshes the access token when it is close to expiry. Returns the current
 * session, or null when the user must sign in again.
 */
export async function refreshAccountOAuth(force = false): Promise<AccountOAuthSession | null> {
  const current = readCredentials()
  if (!current) return null

  const expiresAt = current.expiresAt
  if (!force && expiresAt !== null && expiresAt - Date.now() > REFRESH_SKEW_MS) {
    return toSession(current)
  }

  if (!current.refreshToken) {
    writeCredentials(null)
    broadcast({ session: null, error: 'refresh_expired' })
    return null
  }

  const { ok, json } = await postForm('refresh_token', endpoint('/api/oauth2/token'), {
    grant_type: 'refresh_token',
    client_id: ACCOUNT_OAUTH_CLIENT_ID,
    refresh_token: current.refreshToken
  })

  if (!ok || !json) {
    const error = parseOAuthError(json).code
    // Only a rejected grant means the session is gone; transient failures keep it.
    if (error === 'invalid_grant' || error === 'invalid_client') {
      writeCredentials(null)
      broadcast({ session: null, error: 'refresh_expired' })
      return null
    }
    broadcast({ session: toSession(current), error: 'network_error' })
    return toSession(current)
  }

  const token = parseOAuthTokenResponse(json)
  if (!token) {
    console.warn('[AccountOAuth] refresh_token failed: access_token is missing')
    broadcast({ session: toSession(current), error: 'unknown' })
    return toSession(current)
  }

  const next = buildCredentials(token, current.user, current.refreshToken)

  writeCredentials(next)
  broadcast({ session: toSession(next) })
  return toSession(next)
}

export async function logoutAccountOAuth(): Promise<void> {
  const current = readCredentials()
  clearPending()
  writeCredentials(null)

  if (current) {
    // Revocation is best-effort: local sign-out must succeed even when offline.
    try {
      await postForm('revoke', endpoint('/api/oauth2/revoke'), {
        client_id: ACCOUNT_OAUTH_CLIENT_ID,
        token: current.refreshToken ?? current.accessToken,
        token_type_hint: current.refreshToken ? 'refresh_token' : 'access_token'
      })
    } catch (error) {
      console.warn('[AccountOAuth] Token revocation failed:', error)
    }
  }

  broadcast({ session: null })
}
