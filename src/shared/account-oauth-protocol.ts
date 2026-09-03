import type { AccountOAuthErrorCode, AccountOAuthUser } from './account-oauth'

export interface ParsedOAuthTokenResponse {
  accessToken: string
  refreshToken: string | null
  expiresIn: number | null
  scope: string | null
  tokenType: string
}

export interface ParsedOAuthError {
  code: AccountOAuthErrorCode
  description: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unwrapPayload(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  const data = value.data
  return isRecord(data) ? data : value
}

function firstValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key]
  }
  return null
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

export function parseOAuthTokenResponse(value: unknown): ParsedOAuthTokenResponse | null {
  const payload = unwrapPayload(value)
  if (!payload) return null

  const accessToken = asNullableString(
    firstValue(payload, ['access_token', 'accessToken', 'AccessToken'])
  )
  if (!accessToken) return null

  const rawExpiresIn = firstValue(payload, ['expires_in', 'expiresIn', 'ExpiresIn'])
  const expiresIn =
    typeof rawExpiresIn === 'number'
      ? rawExpiresIn
      : typeof rawExpiresIn === 'string' && rawExpiresIn.trim()
        ? Number(rawExpiresIn)
        : null

  return {
    accessToken,
    refreshToken: asNullableString(
      firstValue(payload, ['refresh_token', 'refreshToken', 'RefreshToken'])
    ),
    expiresIn: expiresIn !== null && Number.isFinite(expiresIn) ? expiresIn : null,
    scope: asNullableString(firstValue(payload, ['scope', 'Scope'])),
    tokenType:
      asNullableString(firstValue(payload, ['token_type', 'tokenType', 'TokenType'])) ?? 'Bearer'
  }
}

export function parseOAuthUserInfoResponse(value: unknown): AccountOAuthUser | null {
  const payload = unwrapPayload(value)
  if (!payload) return null

  const sub = asNullableString(firstValue(payload, ['sub', 'Sub']))
  if (!sub) return null

  const emailVerified = firstValue(payload, ['email_verified', 'emailVerified', 'EmailVerified'])

  return {
    sub,
    name: asNullableString(firstValue(payload, ['name', 'Name'])),
    email: asNullableString(firstValue(payload, ['email', 'Email'])),
    emailVerified: typeof emailVerified === 'boolean' ? emailVerified : null,
    picture: asNullableString(firstValue(payload, ['picture', 'Picture'])),
    preferredUsername: asNullableString(
      firstValue(payload, ['preferred_username', 'preferredUsername', 'PreferredUsername'])
    )
  }
}

function normalizeErrorValue(value: unknown): { code: string | null; description: string | null } {
  if (typeof value === 'string') return { code: value, description: null }
  if (!isRecord(value)) return { code: null, description: null }

  return {
    code: asNullableString(firstValue(value, ['error', 'Error'])),
    description: asNullableString(
      firstValue(value, ['error_description', 'errorDescription', 'ErrorDescription'])
    )
  }
}

export function parseOAuthError(value: unknown): ParsedOAuthError {
  const payload = unwrapPayload(value)
  if (!payload) return { code: 'unknown', description: null }

  const nested = normalizeErrorValue(firstValue(payload, ['error', 'Error']))
  const rawCode = nested.code ?? asNullableString(firstValue(payload, ['code', 'Code']))
  const description =
    nested.description ??
    asNullableString(firstValue(payload, ['error_description', 'errorDescription', 'ErrorDescription']))

  switch (rawCode) {
    case 'access_denied':
    case 'invalid_grant':
    case 'invalid_client':
    case 'invalid_request':
      return { code: rawCode, description }
    default:
      return { code: 'unknown', description }
  }
}
