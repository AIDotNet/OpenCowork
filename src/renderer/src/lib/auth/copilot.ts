import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import type { AIProvider, OAuthConfig, OAuthToken } from '@renderer/lib/api/types'
import { useQuotaStore, type CopilotQuota } from '@renderer/stores/quota-store'
import {
  buildCopilotClientHeaders,
  buildCopilotUserAgent,
  isCopilotOAuthClientId
} from '../../../../shared/oauth-client-identity'

const DEFAULT_COPILOT_HOST = 'https://github.com'
const DEFAULT_COPILOT_API_HOST = 'https://api.github.com'
const DEFAULT_COPILOT_API_BASE = 'https://api.githubcopilot.com'

export interface CopilotDeviceCodeInfo {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresAt?: number
  intervalSeconds?: number
}

export interface ResolvedCopilotOAuthConfig {
  host: string
  apiHost: string
  authorizeUrl: string
  tokenUrl: string
  deviceCodeUrl: string
  tokenExchangeUrl: string
}

function normalizeUrl(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  if (!trimmed) return fallback
  return trimmed.replace(/\/+$/, '')
}

function parseExpiryTimestamp(value: unknown): number | undefined {
  if (value == null) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.floor(value) : Math.floor(value * 1000)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    const numeric = Number(trimmed)
    if (Number.isFinite(numeric)) {
      return numeric > 10_000_000_000 ? Math.floor(numeric) : Math.floor(numeric * 1000)
    }
    const parsed = Date.parse(trimmed)
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'disabled'].includes(normalized)) return false
  return undefined
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) ? parsed : undefined
}

export function isCopilotProvider(
  provider: Pick<AIProvider, 'builtinId'> | Pick<OAuthConfig, 'clientId'> | null | undefined
): boolean {
  return (
    (provider as Pick<AIProvider, 'builtinId'> | undefined)?.builtinId === 'copilot-oauth' ||
    isCopilotOAuthClientId((provider as Pick<OAuthConfig, 'clientId'> | undefined)?.clientId)
  )
}

export function resolveCopilotOAuthConfig(config: OAuthConfig): ResolvedCopilotOAuthConfig {
  const host = normalizeUrl(config.host, DEFAULT_COPILOT_HOST)
  const apiHost = normalizeUrl(
    config.apiHost,
    /^https?:\/\/github\.com$/i.test(host) ? DEFAULT_COPILOT_API_HOST : `${host}/api/v3`
  )

  return {
    host,
    apiHost,
    authorizeUrl: normalizeUrl(config.authorizeUrl, `${host}/login/oauth/authorize`),
    tokenUrl: normalizeUrl(config.tokenUrl, `${host}/login/oauth/access_token`),
    deviceCodeUrl: normalizeUrl(config.deviceCodeUrl, `${host}/login/device/code`),
    tokenExchangeUrl: normalizeUrl(config.tokenExchangeUrl, `${apiHost}/copilot_internal/v2/token`)
  }
}

export function resolveCopilotApiBaseUrl(provider: AIProvider, token?: OAuthToken): string {
  return (
    token?.copilotApiUrl?.trim() ||
    provider.baseUrl?.trim() ||
    DEFAULT_COPILOT_API_BASE
  ).replace(/\/+$/, '')
}

export function resolveCopilotModelId(modelId: string | undefined): string {
  const normalized = modelId?.trim()
  if (!normalized) return 'gpt-5.6-sol'

  const bare = normalized.split('/').pop()?.trim() || normalized
  const lower = bare.toLowerCase()

  if (lower === 'gpt-5-codex' || lower === 'gpt-5.1-codex') return 'gpt-5.3-codex'
  if (lower === 'gpt-5' || lower === 'gpt-5.2') return 'gpt-5.6-sol'
  if (lower === 'gpt-5.1-codex-mini') return 'gpt-5-mini'
  if (lower === 'gpt-4.1' || lower === 'gpt-4o') return 'gpt-5-mini'
  if (lower === 'gemini-2.5-pro' || lower === 'gemini-3-flash-preview') return 'gemini-3.7-flash'

  return bare
}

export function resolveCopilotApiKey(token: OAuthToken | undefined): string {
  return token?.copilotAccessToken?.trim() || token?.accessToken?.trim() || ''
}

function buildCopilotStatus(provider: AIProvider, token: OAuthToken): CopilotQuota {
  return {
    type: 'copilot' as const,
    sku: token.copilotSku,
    chatEnabled: token.copilotChatEnabled,
    telemetry: token.copilotTelemetry,
    apiBaseUrl: resolveCopilotApiBaseUrl(provider, token),
    tokenExpiresAt: token.copilotExpiresAt,
    fetchedAt: Date.now()
  }
}

export function syncCopilotQuota(provider: AIProvider, token: OAuthToken | undefined): void {
  if (!token) return
  const payload = buildCopilotStatus(provider, token)
  const store = useQuotaStore.getState()
  store.updateQuota(provider.id, payload)
  if (provider.builtinId) {
    store.updateQuota(provider.builtinId, payload)
  }
  store.updateQuota('copilot', payload)
}

export function clearCopilotQuota(provider: AIProvider): void {
  const store = useQuotaStore.getState()
  store.clearQuota(provider.id)
  if (provider.builtinId) {
    store.clearQuota(provider.builtinId)
  }
  store.clearQuota('copilot')
}

export async function exchangeCopilotToken(
  provider: AIProvider,
  oauth: OAuthToken
): Promise<OAuthToken> {
  const githubAccessToken = oauth.accessToken?.trim()
  if (!githubAccessToken) {
    throw new Error('Missing GitHub access token')
  }

  const resolved = resolveCopilotOAuthConfig(
    provider.oauthConfig ?? { authorizeUrl: '', tokenUrl: '', clientId: '' }
  )
  const headers: Record<string, string> = {
    Authorization: `token ${githubAccessToken}`,
    Accept: 'application/json',
    'User-Agent': buildCopilotUserAgent(),
    ...buildCopilotClientHeaders()
  }

  const result = (await ipcClient.invoke('api:request', {
    url: resolved.tokenExchangeUrl,
    method: 'GET',
    headers,
    useSystemProxy: provider.useSystemProxy,
    providerId: provider.id,
    providerBuiltinId: provider.builtinId
  })) as { statusCode?: number; error?: string; body?: string }

  if (result?.error) throw new Error(result.error)
  if (!result?.body) throw new Error('Empty Copilot token response')
  if (result.statusCode && result.statusCode >= 400) {
    throw new Error(`HTTP ${result.statusCode}: ${result.body.slice(0, 200)}`)
  }

  const data = JSON.parse(result.body) as Record<string, unknown>
  const copilotAccessToken =
    typeof data.token === 'string'
      ? data.token.trim()
      : typeof data.access_token === 'string'
        ? data.access_token.trim()
        : ''

  if (!copilotAccessToken) {
    throw new Error('Missing Copilot access token')
  }

  const endpoints =
    data.endpoints && typeof data.endpoints === 'object' && !Array.isArray(data.endpoints)
      ? (data.endpoints as Record<string, unknown>)
      : undefined
  const apiBaseUrl =
    (typeof endpoints?.api === 'string' && endpoints.api.trim()) ||
    (typeof data.api_url === 'string' && data.api_url.trim()) ||
    resolveCopilotApiBaseUrl(provider, oauth)

  const refreshIn = parseNumber(data.refresh_in)
  const expiresAt =
    parseExpiryTimestamp(data.expires_at ?? data.expiresAt) ??
    (refreshIn ? Date.now() + refreshIn * 1000 : undefined)

  const next: OAuthToken = {
    ...oauth,
    copilotAccessToken,
    copilotTokenType:
      typeof data.token_type === 'string' ? data.token_type.trim() : oauth.copilotTokenType,
    ...(expiresAt ? { copilotExpiresAt: expiresAt } : {}),
    ...(refreshIn ? { copilotRefreshAt: Date.now() + refreshIn * 1000 } : {}),
    copilotApiUrl: apiBaseUrl,
    copilotChatEnabled: parseBoolean(data.chat_enabled),
    copilotSku: typeof data.sku === 'string' ? data.sku.trim() : oauth.copilotSku,
    copilotTelemetry:
      typeof data.telemetry === 'string' ? data.telemetry.trim() : oauth.copilotTelemetry
  }

  syncCopilotQuota(provider, next)
  return next
}
