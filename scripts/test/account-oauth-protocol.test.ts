import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseOAuthError,
  parseOAuthTokenResponse,
  parseOAuthUserInfoResponse
} from '../../src/shared/account-oauth-protocol.ts'
import { parseOpenCoworkOAuthCallbackUrl } from '../../src/main/lib/opencowork-oauth-link.ts'

test('parses OAuth token responses with standard snake_case fields', () => {
  assert.deepEqual(
    parseOAuthTokenResponse({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 7200,
      token_type: 'Bearer',
      scope: 'openid profile email'
    }),
    {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 7200,
      scope: 'openid profile email',
      tokenType: 'Bearer'
    }
  )
})

test('unwraps API response envelopes without changing OAuth fields', () => {
  const token = parseOAuthTokenResponse({
    data: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 7200
    },
    code: 200
  })

  assert.equal(token?.accessToken, 'access-token')
  assert.equal(token?.refreshToken, 'refresh-token')
  assert.equal(token?.expiresIn, 7200)
})

test('accepts legacy casing while the server is being upgraded', () => {
  const token = parseOAuthTokenResponse({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresIn: 7200,
    tokenType: 'Bearer'
  })

  assert.deepEqual(token, {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresIn: 7200,
    scope: null,
    tokenType: 'Bearer'
  })
})

test('rejects a token response without access_token', () => {
  assert.equal(parseOAuthTokenResponse({ expires_in: 7200 }), null)
})

test('parses OIDC userinfo fields from the API envelope', () => {
  assert.deepEqual(
    parseOAuthUserInfoResponse({
      data: {
        sub: 'user-id',
        name: 'Token',
        email: 'token@example.com',
        email_verified: true,
        picture: 'https://example.com/avatar.png',
        preferred_username: 'token'
      },
      code: 200
    }),
    {
      sub: 'user-id',
      name: 'Token',
      email: 'token@example.com',
      emailVerified: true,
      picture: 'https://example.com/avatar.png',
      preferredUsername: 'token'
    }
  )
})

test('normalizes OAuth errors from standard and legacy response casing', () => {
  assert.deepEqual(parseOAuthError({ error: 'invalid_grant', error_description: 'expired' }), {
    code: 'invalid_grant',
    description: 'expired'
  })
  assert.deepEqual(parseOAuthError({ Error: 'invalid_client', ErrorDescription: 'disabled' }), {
    code: 'invalid_client',
    description: 'disabled'
  })
})

test('parses only the expected OpenCowork OAuth callback fields', () => {
  const callback = parseOpenCoworkOAuthCallbackUrl(
    'opencowork://oauth/callback?code=code-1&state=state-1&access_token=should-be-ignored'
  )

  assert.deepEqual(callback, {
    code: 'code-1',
    state: 'state-1',
    error: null,
    errorDescription: null
  })
})

test('rejects non-OAuth OpenCowork deep links as OAuth callbacks', () => {
  assert.equal(parseOpenCoworkOAuthCallbackUrl('opencowork://import?token=abc'), null)
})
