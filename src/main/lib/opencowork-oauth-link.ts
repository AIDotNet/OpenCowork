import { ACCOUNT_OAUTH_REDIRECT_URI, type AccountOAuthErrorCode } from '../../shared/account-oauth'

// Deep-link parsing for opencowork://oauth/callback. Kept strictly separate from
// the API-key import protocol so a callback URL can never be applied as a
// provider import and vice versa.

const OAUTH_CALLBACK_HOST = 'oauth'
const OAUTH_CALLBACK_PATH = '/callback'

export interface OpenCoworkOAuthCallback {
  code: string | null
  state: string | null
  error: AccountOAuthErrorCode | null
  errorDescription: string | null
}

function parseCallbackUrl(rawUrl: string): URL | null {
  if (typeof rawUrl !== 'string') return null
  if (!rawUrl.startsWith('opencowork:')) return null

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }

  if (url.protocol !== 'opencowork:') return null
  if (url.hostname !== OAUTH_CALLBACK_HOST) return null
  // Trailing slashes are accepted, anything deeper is not our callback.
  const normalizedPath = url.pathname.replace(/\/+$/, '') || '/'
  if (normalizedPath !== OAUTH_CALLBACK_PATH) return null
  return url
}

export function isOpenCoworkOAuthCallbackUrl(rawUrl: string): boolean {
  return parseCallbackUrl(rawUrl) !== null
}

function toErrorCode(value: string | null): AccountOAuthErrorCode | null {
  if (!value) return null
  switch (value) {
    case 'access_denied':
    case 'invalid_grant':
    case 'invalid_client':
    case 'invalid_request':
      return value
    default:
      return 'unknown'
  }
}

/**
 * Parses a callback deep link into the OAuth response fields. Only
 * code/state/error/error_description are read; tokens are never accepted here.
 */
export function parseOpenCoworkOAuthCallbackUrl(rawUrl: string): OpenCoworkOAuthCallback | null {
  const url = parseCallbackUrl(rawUrl)
  if (!url) return null

  return {
    code: url.searchParams.get('code'),
    state: url.searchParams.get('state'),
    error: toErrorCode(url.searchParams.get('error')),
    errorDescription: url.searchParams.get('error_description')
  }
}

export function findOpenCoworkOAuthCallbackUrl(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    if (isOpenCoworkOAuthCallbackUrl(candidate)) return candidate
  }
  return null
}

export { ACCOUNT_OAUTH_REDIRECT_URI }
