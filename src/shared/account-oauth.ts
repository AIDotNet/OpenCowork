/** Shared contract between main and renderer for the RoutIn desktop account. */

export const ACCOUNT_OAUTH_CLIENT_ID = 'opencowork-desktop'
export const ACCOUNT_OAUTH_REDIRECT_URI = 'opencowork://oauth/callback'
export const ACCOUNT_OAUTH_SCOPE = 'openid profile email'
export const ACCOUNT_OAUTH_DEFAULT_BASE_URL = 'https://routin.ai'

export interface AccountOAuthUser {
  sub: string
  name: string | null
  email: string | null
  emailVerified: boolean | null
  picture: string | null
  preferredUsername: string | null
}

/** Renderer-visible session state. Never carries access or refresh tokens. */
export interface AccountOAuthSession {
  user: AccountOAuthUser
  scope: string | null
  /** Epoch milliseconds; null when the server did not send expires_in. */
  expiresAt: number | null
}

export type AccountOAuthErrorCode =
  | 'access_denied'
  | 'invalid_grant'
  | 'invalid_client'
  | 'invalid_request'
  | 'state_mismatch'
  | 'network_error'
  | 'refresh_expired'
  | 'timeout'
  | 'unknown'

/** How long main waits for the browser callback before abandoning the flow. */
export const ACCOUNT_OAUTH_TIMEOUT_MS = 3 * 60_000

export interface AccountOAuthChangedEvent {
  session: AccountOAuthSession | null
  /** Set when the change was caused by a failure the user should act on. */
  error?: AccountOAuthErrorCode
}

export interface AccountOAuthStartResult {
  started: boolean
  error?: AccountOAuthErrorCode
}

export interface AccountOAuthLogoutResult {
  success: true
}
