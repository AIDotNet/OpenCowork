import {
  REMOTE_DESKTOP_SESSION_PATH,
  parseRemoteDesktopSessionResponse
} from '../../shared/remote-control'
import { getDefaultApiUserAgent } from '../lib/api-user-agent'
import { getValidAccountAccessToken } from './oauth-service'

// Hub JWT cache. The desktop OAuth access token is opaque and cannot pass
// SignalR [Authorize]; /api/remote/desktop-session exchanges it for a JWT.

const REFRESH_SKEW_MS = 2 * 60_000
const REQUEST_TIMEOUT_MS = 20_000

interface CachedHubToken {
  apiBaseUrl: string
  oauthToken: string
  accessToken: string
  expiresAt: number
}

let cached: CachedHubToken | null = null

export function clearRemoteControlAccessToken(): void {
  cached = null
}

export async function getValidRemoteControlAccessToken(apiBaseUrl: string): Promise<string | null> {
  const oauthToken = await getValidAccountAccessToken()
  if (!oauthToken) {
    cached = null
    return null
  }

  if (
    cached &&
    cached.apiBaseUrl === apiBaseUrl &&
    cached.oauthToken === oauthToken &&
    cached.expiresAt - Date.now() > REFRESH_SKEW_MS
  ) {
    return cached.accessToken
  }

  try {
    const session = await exchangeDesktopSession(apiBaseUrl, oauthToken)
    cached = {
      apiBaseUrl,
      oauthToken,
      accessToken: session.accessToken,
      expiresAt: Date.now() + session.expiresInSeconds * 1000
    }
    return session.accessToken
  } catch (error) {
    // Older ApiService builds have no desktop-session route; the hub can still
    // accept the opaque OAuth token after RemoteControlAuth is deployed.
    if (error instanceof Error && error.message.includes('desktop-session')) {
      return oauthToken
    }
    throw error
  }
}

async function exchangeDesktopSession(
  apiBaseUrl: string,
  oauthToken: string
): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${apiBaseUrl}${REMOTE_DESKTOP_SESSION_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${oauthToken}`,
        Accept: 'application/json',
        'User-Agent': getDefaultApiUserAgent()
      },
      signal: controller.signal
    })
    const responseText = await response.text()
    if (!response.ok) {
      throw new Error(describeExchangeFailure(response.status, responseText))
    }
    let json: unknown = null
    try {
      json = JSON.parse(responseText) as unknown
    } catch {
      throw new Error('Remote control desktop-session returned a non-JSON body.')
    }
    const session = parseRemoteDesktopSessionResponse(json)
    if (!session) {
      throw new Error('Remote control desktop-session did not return a hub token.')
    }
    return session
  } finally {
    clearTimeout(timer)
  }
}

function describeExchangeFailure(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return 'Remote control rejected the account session. Sign in again and retry.'
  }
  if (status === 404) {
    return 'Remote control server is missing /api/remote/desktop-session.'
  }
  if (status === 429) {
    return 'Remote control desktop-session is rate limited. Retry shortly.'
  }
  const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 160)
  return snippet
    ? `Failed to exchange a remote-control token: HTTP ${status} (${snippet})`
    : `Failed to exchange a remote-control token: HTTP ${status}`
}
