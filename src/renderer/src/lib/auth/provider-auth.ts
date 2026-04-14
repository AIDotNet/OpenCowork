import { nanoid } from 'nanoid'
import { useProviderStore } from '@renderer/stores/provider-store'
import type {
  AccountRateLimit,
  AIProvider,
  OAuthConfig,
  OAuthToken,
  ProviderOAuthAccount
} from '@renderer/lib/api/types'
import { startOAuthFlow, refreshOAuthFlow, type StartOAuthFlowOptions } from './oauth'
import {
  clearCopilotQuota,
  exchangeCopilotToken,
  isCopilotProvider,
  resolveCopilotApiKey,
  syncCopilotQuota
} from './copilot'
import { sendChannelCode, verifyChannelCode, fetchChannelUserInfo } from './channel'

const REFRESH_SKEW_MS = 2 * 60 * 1000

function getProviderById(providerId: string): AIProvider | null {
  const providers = useProviderStore.getState().providers
  return providers.find((p) => p.id === providerId) ?? null
}

function resolveOAuthConfig(provider: AIProvider): OAuthConfig | null {
  if (provider.oauthConfig?.authorizeUrl && provider.oauthConfig?.tokenUrl)
    return provider.oauthConfig
  return provider.oauthConfig ?? null
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

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || undefined
  }
  if (typeof value === 'number') {
    return String(value)
  }
  return undefined
}

function parseManualOAuthPayload(raw: string): AIProvider['oauth'] {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error('invalid_json')
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('invalid_json_object')
  }
  const payload = data as Record<string, unknown>
  const accessToken = asString(
    payload.access_token ??
      payload.accessToken ??
      payload.authorization_token ??
      payload.authorizationToken ??
      payload.auth_token ??
      payload.authToken ??
      payload.token
  )
  if (!accessToken) {
    throw new Error('missing_access_token')
  }

  const refreshToken = asString(payload.refresh_token ?? payload.refreshToken)
  const scope = asString(payload.scope)
  const tokenType = asString(payload.token_type ?? payload.tokenType)
  const accountId = asString(payload.account_id ?? payload.accountId)
  const idToken = asString(payload.id_token ?? payload.idToken)
  const deviceId = asString(payload.device_id ?? payload.deviceId)
  const copilotAccessToken = asString(
    payload.copilot_access_token ?? payload.copilotAccessToken ?? payload.oauth_token
  )
  const copilotTokenType = asString(payload.copilot_token_type ?? payload.copilotTokenType)
  const copilotApiUrl = asString(payload.copilot_api_url ?? payload.copilotApiUrl)
  const copilotSku = asString(payload.sku ?? payload.copilotSku)
  const copilotTelemetry = asString(payload.telemetry ?? payload.copilotTelemetry)
  const copilotChatEnabledRaw = payload.chat_enabled ?? payload.copilotChatEnabled
  const copilotChatEnabled =
    typeof copilotChatEnabledRaw === 'boolean'
      ? copilotChatEnabledRaw
      : typeof copilotChatEnabledRaw === 'string'
        ? ['true', '1', 'yes', 'enabled'].includes(copilotChatEnabledRaw.trim().toLowerCase())
        : undefined

  const expiresAt =
    parseExpiryTimestamp(
      payload.expires_at ??
        payload.expiresAt ??
        payload.expired ??
        payload.expireAt ??
        payload.expire_at
    ) ??
    (() => {
      const expiresInRaw = payload.expires_in ?? payload.expiresIn
      const expiresIn =
        typeof expiresInRaw === 'number'
          ? expiresInRaw
          : typeof expiresInRaw === 'string'
            ? Number(expiresInRaw)
            : NaN
      return Number.isFinite(expiresIn) ? Date.now() + (expiresIn as number) * 1000 : undefined
    })()

  const copilotExpiresAt =
    parseExpiryTimestamp(payload.copilot_expires_at ?? payload.copilotExpiresAt) ??
    (() => {
      const expiresInRaw = payload.copilot_expires_in ?? payload.copilotExpiresIn
      const expiresIn =
        typeof expiresInRaw === 'number'
          ? expiresInRaw
          : typeof expiresInRaw === 'string'
            ? Number(expiresInRaw)
            : NaN
      return Number.isFinite(expiresIn) ? Date.now() + (expiresIn as number) * 1000 : undefined
    })()

  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(scope ? { scope } : {}),
    ...(tokenType ? { tokenType } : {}),
    ...(accountId ? { accountId } : {}),
    ...(idToken ? { idToken } : {}),
    ...(deviceId ? { deviceId } : {}),
    ...(copilotAccessToken ? { copilotAccessToken } : {}),
    ...(copilotTokenType ? { copilotTokenType } : {}),
    ...(copilotExpiresAt ? { copilotExpiresAt } : {}),
    ...(copilotApiUrl ? { copilotApiUrl } : {}),
    ...(copilotSku ? { copilotSku } : {}),
    ...(copilotTelemetry ? { copilotTelemetry } : {}),
    ...(copilotChatEnabled !== undefined ? { copilotChatEnabled } : {})
  }
}

function setProviderAuth(providerId: string, patch: Partial<AIProvider>): void {
  useProviderStore.getState().updateProvider(providerId, patch)
}

/** Extract a usable email hint from an OAuth token (id_token claim or known fields). */
function extractEmailFromToken(token: OAuthToken): string | undefined {
  // Try id_token payload: base64url middle segment
  const idToken = token.idToken
  if (idToken && idToken.split('.').length === 3) {
    try {
      const payload = idToken.split('.')[1]
      const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
      const data = JSON.parse(json) as Record<string, unknown>
      const email = asString(data.email)
      if (email) return email
    } catch {
      // ignore — malformed id_token
    }
  }
  return undefined
}

/** Decide if an account should be considered rate-limited right now. Self-heals when resetAt elapses. */
function isAccountRateLimited(account: ProviderOAuthAccount): boolean {
  if (!account.rateLimit) return false
  if (account.rateLimit.resetAt <= Date.now()) return false
  return true
}

function getAccountsArray(provider: AIProvider): ProviderOAuthAccount[] {
  return provider.oauthAccounts ?? []
}

function findAccountById(
  provider: AIProvider,
  accountId: string | undefined
): ProviderOAuthAccount | undefined {
  if (!accountId) return undefined
  return getAccountsArray(provider).find((a) => a.id === accountId)
}

/**
 * Pick the next account to use for a provider.
 *   1. Sweep: remove rateLimit markers whose resetAt has elapsed.
 *   2. Prefer the currently active account if it's usable.
 *   3. Otherwise walk the list in order and return the first non-rate-limited entry.
 *   4. If all are rate-limited, return the one with the earliest resetAt (best-effort retry).
 *   5. If the list is empty, return null.
 *
 * Returns {account, accountsChanged, nextAccounts} so callers can persist the swept state.
 */
export function pickUsableAccount(provider: AIProvider): {
  account: ProviderOAuthAccount | null
  nextAccounts: ProviderOAuthAccount[]
  changed: boolean
} {
  const accounts = getAccountsArray(provider)
  if (accounts.length === 0) {
    return { account: null, nextAccounts: accounts, changed: false }
  }

  const now = Date.now()
  let changed = false
  const swept: ProviderOAuthAccount[] = accounts.map((acc) => {
    if (acc.rateLimit && acc.rateLimit.resetAt <= now) {
      changed = true
      const { rateLimit: _rl, ...rest } = acc
      return rest as ProviderOAuthAccount
    }
    return acc
  })

  // Prefer active account when it's still usable.
  const activeId = provider.activeAccountId
  if (activeId) {
    const active = swept.find((a) => a.id === activeId)
    if (active && !isAccountRateLimited(active)) {
      return { account: active, nextAccounts: swept, changed }
    }
  }

  // Otherwise first non-rate-limited in priority order.
  const firstUsable = swept.find((a) => !isAccountRateLimited(a))
  if (firstUsable) {
    return { account: firstUsable, nextAccounts: swept, changed }
  }

  // All limited → return the one with the earliest resetAt so we still attempt something.
  const earliest = [...swept].sort(
    (a, b) => (a.rateLimit?.resetAt ?? 0) - (b.rateLimit?.resetAt ?? 0)
  )[0]
  return { account: earliest ?? null, nextAccounts: swept, changed }
}

function buildOAuthProviderPatch(provider: AIProvider, token: OAuthToken): Partial<AIProvider> {
  const apiKey = getProviderApiKey(provider, token)
  const patch: Partial<AIProvider> = {
    authMode: 'oauth',
    oauth: token,
    apiKey
  }
  if (isCopilotProvider(provider) && token.copilotApiUrl) {
    patch.baseUrl = token.copilotApiUrl
  }
  return patch
}

/**
 * Build a provider patch that: replaces the accounts array, updates activeAccountId,
 * and projects the active account's token into the top-level oauth/apiKey/baseUrl fields
 * so all legacy readers (openai-chat.ts, etc.) just see the current account transparently.
 */
function buildAccountProjectionPatch(
  provider: AIProvider,
  accounts: ProviderOAuthAccount[],
  activeAccountId: string
): Partial<AIProvider> {
  const active = accounts.find((a) => a.id === activeAccountId)
  const patch: Partial<AIProvider> = {
    authMode: 'oauth',
    oauthAccounts: accounts,
    activeAccountId
  }
  if (active) {
    patch.oauth = active.oauth
    patch.apiKey = getProviderApiKey(provider, active.oauth)
    if (isCopilotProvider(provider) && active.oauth.copilotApiUrl) {
      patch.baseUrl = active.oauth.copilotApiUrl
    }
  } else {
    patch.oauth = undefined
    patch.apiKey = ''
  }
  return patch
}

function upsertAccountInList(
  accounts: ProviderOAuthAccount[],
  account: ProviderOAuthAccount
): ProviderOAuthAccount[] {
  const idx = accounts.findIndex((a) => a.id === account.id)
  if (idx >= 0) {
    const next = accounts.slice()
    next[idx] = account
    return next
  }
  return [...accounts, account]
}

function requiresOAuthConnectConfig(config: OAuthConfig | null): boolean {
  if (!config?.tokenUrl || !config.clientId) return false
  if ((config.flowType ?? 'authorization_code') === 'device_code') {
    return !!config.deviceCodeUrl
  }
  return !!config.authorizeUrl
}

function getProviderApiKey(provider: AIProvider, token: OAuthToken): string {
  return isCopilotProvider(provider) ? resolveCopilotApiKey(token) : token.accessToken
}

async function finalizeOAuthToken(provider: AIProvider, token: OAuthToken): Promise<OAuthToken> {
  if (!isCopilotProvider(provider)) {
    return token
  }
  const next =
    token.copilotAccessToken &&
    token.copilotExpiresAt &&
    token.copilotExpiresAt - Date.now() > REFRESH_SKEW_MS
      ? token
      : await exchangeCopilotToken(provider, token)
  syncCopilotQuota(provider, next)
  return next
}

/**
 * Start an OAuth login flow and add the resulting token as a NEW account entry.
 * If `email` is not supplied, we try to infer it from the id_token claim; if that
 * fails we fall back to a placeholder so the UI can prompt the user to complete it.
 *
 * Callers that still want single-account semantics can rely on the fact that the
 * active account is always set to the first entry when the list was previously empty.
 */
export async function startProviderOAuth(
  providerId: string,
  options?: AbortSignal | StartOAuthFlowOptions,
  email?: string
): Promise<ProviderOAuthAccount> {
  const provider = getProviderById(providerId)
  if (!provider) throw new Error('Provider not found')
  const config = resolveOAuthConfig(provider)
  if (!requiresOAuthConnectConfig(config) || !config) {
    throw new Error('OAuth config is incomplete')
  }

  const token = await startOAuthFlow(config, options)
  const finalToken = await finalizeOAuthToken(provider, token)

  const resolvedEmail =
    email?.trim() || extractEmailFromToken(finalToken) || finalToken.accountId || 'unknown@local'

  const account: ProviderOAuthAccount = {
    id: nanoid(),
    email: resolvedEmail,
    oauth: finalToken,
    createdAt: Date.now(),
    lastUsedAt: Date.now()
  }

  const latest = getProviderById(providerId) ?? provider
  const existing = getAccountsArray(latest)
  const nextAccounts = [...existing, account]
  setProviderAuth(
    providerId,
    buildAccountProjectionPatch(
      latest,
      nextAccounts,
      latest.activeAccountId && existing.some((a) => a.id === latest.activeAccountId)
        ? latest.activeAccountId
        : account.id
    )
  )
  return account
}

/** Remove a specific account. If it was active, the next usable account becomes active. */
export function removeOauthAccount(providerId: string, accountId: string): void {
  const provider = getProviderById(providerId)
  if (!provider) return
  const nextAccounts = getAccountsArray(provider).filter((a) => a.id !== accountId)
  if (nextAccounts.length === 0) {
    if (isCopilotProvider(provider)) clearCopilotQuota(provider)
    setProviderAuth(providerId, {
      oauth: undefined,
      apiKey: '',
      oauthAccounts: [],
      activeAccountId: undefined
    })
    return
  }
  const nextActiveId =
    provider.activeAccountId === accountId ? nextAccounts[0].id : provider.activeAccountId!
  setProviderAuth(
    providerId,
    buildAccountProjectionPatch(provider, nextAccounts, nextActiveId)
  )
}

/** Disconnect ALL OAuth accounts for this provider (legacy "disconnect OAuth" button). */
export function disconnectProviderOAuth(providerId: string): void {
  const provider = getProviderById(providerId)
  if (provider && isCopilotProvider(provider)) {
    clearCopilotQuota(provider)
  }
  setProviderAuth(providerId, {
    oauth: undefined,
    apiKey: '',
    oauthAccounts: [],
    activeAccountId: undefined
  })
}

/** Set a specific account as active for subsequent requests. */
export function setActiveProviderAccount(providerId: string, accountId: string): void {
  const provider = getProviderById(providerId)
  if (!provider) return
  const accounts = getAccountsArray(provider)
  if (!accounts.some((a) => a.id === accountId)) return
  setProviderAuth(providerId, buildAccountProjectionPatch(provider, accounts, accountId))
}

/** Reorder the accounts array (priority order is array order). */
export function reorderProviderAccounts(providerId: string, orderedIds: string[]): void {
  const provider = getProviderById(providerId)
  if (!provider) return
  const byId = new Map(getAccountsArray(provider).map((a) => [a.id, a] as const))
  const next: ProviderOAuthAccount[] = []
  for (const id of orderedIds) {
    const acc = byId.get(id)
    if (acc) {
      next.push(acc)
      byId.delete(id)
    }
  }
  // Append any accounts that weren't in the provided order (defensive).
  for (const acc of byId.values()) next.push(acc)
  const activeId =
    provider.activeAccountId && next.some((a) => a.id === provider.activeAccountId)
      ? provider.activeAccountId
      : next[0]?.id
  if (!activeId) return
  setProviderAuth(providerId, buildAccountProjectionPatch(provider, next, activeId))
}

/** Update email/label metadata on an account. */
export function updateProviderAccountInfo(
  providerId: string,
  accountId: string,
  patch: { email?: string; label?: string }
): void {
  const provider = getProviderById(providerId)
  if (!provider) return
  const accounts = getAccountsArray(provider).map((a) => {
    if (a.id !== accountId) return a
    return {
      ...a,
      ...(patch.email !== undefined ? { email: patch.email.trim() || a.email } : {}),
      ...(patch.label !== undefined ? { label: patch.label.trim() || undefined } : {})
    }
  })
  setProviderAuth(
    providerId,
    buildAccountProjectionPatch(provider, accounts, provider.activeAccountId ?? accounts[0].id)
  )
}

/** Mark an account as rate-limited until `resetAt`. Triggers automatic fall-back via pickUsableAccount. */
export function markAccountRateLimited(
  providerId: string,
  accountId: string,
  info: Omit<AccountRateLimit, 'limitedAt'>
): void {
  const provider = getProviderById(providerId)
  if (!provider) return
  const accounts = getAccountsArray(provider).map((a) =>
    a.id === accountId
      ? { ...a, rateLimit: { limitedAt: Date.now(), ...info } satisfies AccountRateLimit }
      : a
  )
  if (accounts.length === 0) return
  const { account: next } = pickUsableAccount({ ...provider, oauthAccounts: accounts })
  const nextActiveId = next?.id ?? provider.activeAccountId ?? accounts[0].id
  setProviderAuth(providerId, buildAccountProjectionPatch(provider, accounts, nextActiveId))
}

/**
 * Attempt to switch the provider to a different usable account.
 * Returns the previous accountId and the new one if a switch happened, else null.
 * Used by the agent loop to fail over after a rate-limit error.
 */
export function trySwitchProviderAccount(providerId: string): {
  previousAccountId: string | undefined
  nextAccountId: string
} | null {
  const provider = getProviderById(providerId)
  if (!provider) return null
  const accounts = getAccountsArray(provider)
  if (accounts.length < 2) return null
  const previousAccountId = provider.activeAccountId
  const others = accounts.filter(
    (a) => a.id !== previousAccountId && !isAccountRateLimited(a)
  )
  if (others.length === 0) return null
  const next = others[0]
  setProviderAuth(providerId, buildAccountProjectionPatch(provider, accounts, next.id))
  return { previousAccountId, nextAccountId: next.id }
}

/** True when the provider has more than one OAuth account registered. */
export function hasMultipleOauthAccounts(providerId: string): boolean {
  const provider = getProviderById(providerId)
  return !!provider && getAccountsArray(provider).length > 1
}

/** Clear the rate-limit flag on an account (user-initiated "reactivate"). */
export function clearAccountRateLimit(providerId: string, accountId: string): void {
  const provider = getProviderById(providerId)
  if (!provider) return
  const accounts = getAccountsArray(provider).map((a) =>
    a.id === accountId ? { ...a, rateLimit: undefined } : a
  )
  setProviderAuth(
    providerId,
    buildAccountProjectionPatch(
      provider,
      accounts,
      provider.activeAccountId ?? accounts[0]?.id ?? ''
    )
  )
}

/**
 * Parse a single OAuth record. Reuses parseManualOAuthPayload but requires an `email` field
 * to be present either at the top level or as a sibling of the token keys.
 */
function parseImportRecord(record: unknown): { email: string; token: OAuthToken; label?: string } {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('invalid_record')
  }
  const raw = record as Record<string, unknown>
  const email = asString(raw.email)
  if (!email) throw new Error('missing_email')
  const label = asString(raw.label ?? raw.name ?? raw.nickname)
  const token = parseManualOAuthPayload(JSON.stringify(raw))
  if (!token) throw new Error('invalid_token')
  return { email, token, ...(label ? { label } : {}) }
}

/** Apply a manually-pasted OAuth JSON as a NEW account (requires email). */
export async function applyManualProviderOAuth(
  providerId: string,
  rawJson: string,
  email?: string
): Promise<ProviderOAuthAccount> {
  const provider = getProviderById(providerId)
  if (!provider) throw new Error('Provider not found')

  // Backwards-compatible path: legacy single-account JSON without an email wrapper.
  let resolvedEmail = email?.trim()
  let token: OAuthToken | undefined
  try {
    // First try as a full import record with email.
    const parsed = parseImportRecord(JSON.parse(rawJson))
    resolvedEmail = resolvedEmail || parsed.email
    token = parsed.token
  } catch {
    token = parseManualOAuthPayload(rawJson)
    if (!token) throw new Error('Invalid OAuth payload')
  }
  const finalToken = await finalizeOAuthToken(provider, token)
  if (!resolvedEmail) {
    resolvedEmail =
      extractEmailFromToken(finalToken) || finalToken.accountId || 'unknown@local'
  }

  const account: ProviderOAuthAccount = {
    id: nanoid(),
    email: resolvedEmail,
    oauth: finalToken,
    createdAt: Date.now()
  }
  const latest = getProviderById(providerId) ?? provider
  const nextAccounts = [...getAccountsArray(latest), account]
  setProviderAuth(
    providerId,
    buildAccountProjectionPatch(
      latest,
      nextAccounts,
      latest.activeAccountId &&
        getAccountsArray(latest).some((a) => a.id === latest.activeAccountId)
        ? latest.activeAccountId
        : account.id
    )
  )
  return account
}

export interface ImportOAuthAccountsResult {
  imported: ProviderOAuthAccount[]
  skipped: { index: number; reason: string }[]
}

/**
 * Batch import OAuth accounts from a JSON array. Each record MUST contain an `email` field.
 * Records without email are skipped with reason 'missing_email'. Records that fail parse
 * are skipped with reason 'invalid_record' or 'invalid_token'. Copilot token exchange is
 * performed for Copilot providers but its failure only skips the offending record.
 */
export async function importOauthAccountsFromJson(
  providerId: string,
  rawJson: string
): Promise<ImportOAuthAccountsResult> {
  const provider = getProviderById(providerId)
  if (!provider) throw new Error('Provider not found')

  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    throw new Error('invalid_json')
  }
  if (!Array.isArray(parsed)) throw new Error('expected_array')

  const imported: ProviderOAuthAccount[] = []
  const skipped: { index: number; reason: string }[] = []

  // Pull the latest provider snapshot once; we'll append incrementally then write at the end.
  let working = getAccountsArray(getProviderById(providerId) ?? provider)

  for (let i = 0; i < parsed.length; i += 1) {
    try {
      const { email, token, label } = parseImportRecord(parsed[i])
      // eslint-disable-next-line no-await-in-loop
      const finalToken = await finalizeOAuthToken(provider, token)
      const account: ProviderOAuthAccount = {
        id: nanoid(),
        email,
        oauth: finalToken,
        createdAt: Date.now(),
        ...(label ? { label } : {})
      }
      working = [...working, account]
      imported.push(account)
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'invalid_record'
      skipped.push({ index: i, reason })
    }
  }

  if (imported.length > 0) {
    const latest = getProviderById(providerId) ?? provider
    const activeId =
      latest.activeAccountId && working.some((a) => a.id === latest.activeAccountId)
        ? latest.activeAccountId
        : working[0].id
    setProviderAuth(providerId, buildAccountProjectionPatch(latest, working, activeId))
  }

  return { imported, skipped }
}

/** Serialize all accounts for export. Emits the same schema importOauthAccountsFromJson accepts. */
export function exportProviderAccounts(providerId: string): string {
  const provider = getProviderById(providerId)
  if (!provider) return '[]'
  const records = getAccountsArray(provider).map((a) => {
    const t = a.oauth
    return {
      email: a.email,
      ...(a.label ? { label: a.label } : {}),
      access_token: t.accessToken,
      ...(t.refreshToken ? { refresh_token: t.refreshToken } : {}),
      ...(t.expiresAt ? { expires_at: t.expiresAt } : {}),
      ...(t.scope ? { scope: t.scope } : {}),
      ...(t.tokenType ? { token_type: t.tokenType } : {}),
      ...(t.accountId ? { account_id: t.accountId } : {}),
      ...(t.idToken ? { id_token: t.idToken } : {}),
      ...(t.deviceId ? { device_id: t.deviceId } : {}),
      ...(t.copilotAccessToken ? { copilot_access_token: t.copilotAccessToken } : {}),
      ...(t.copilotExpiresAt ? { copilot_expires_at: t.copilotExpiresAt } : {}),
      ...(t.copilotApiUrl ? { copilot_api_url: t.copilotApiUrl } : {})
    }
  })
  return JSON.stringify(records, null, 2)
}

/** Refresh the OAuth token on a specific account (or the active one if accountId is omitted). */
export async function refreshProviderOAuth(
  providerId: string,
  force = false,
  accountId?: string
): Promise<boolean> {
  const provider = getProviderById(providerId)
  if (!provider || provider.authMode !== 'oauth') return false
  const config = resolveOAuthConfig(provider)
  if (!config || !config.tokenUrl || !config.clientId) return false

  const targetId = accountId ?? provider.activeAccountId
  const target = targetId ? findAccountById(provider, targetId) : undefined

  // Multi-account path
  if (target) {
    const current = target.oauth
    if (!current?.refreshToken) return false
    const expiresAt = current.expiresAt ?? 0
    if (!force && expiresAt && expiresAt - Date.now() > REFRESH_SKEW_MS) return true
    const next = await refreshOAuthFlow(config, current.refreshToken, current.deviceId)
    const mergedToken: OAuthToken = {
      ...current,
      ...next,
      refreshToken: next.refreshToken ?? current.refreshToken
    }
    const finalToken = await finalizeOAuthToken(provider, mergedToken)
    const updated: ProviderOAuthAccount = { ...target, oauth: finalToken }
    const accounts = upsertAccountInList(getAccountsArray(provider), updated)
    setProviderAuth(
      providerId,
      buildAccountProjectionPatch(
        provider,
        accounts,
        provider.activeAccountId ?? updated.id
      )
    )
    return true
  }

  // Legacy single-token fallback (no accounts array).
  const current = provider.oauth
  if (!current?.refreshToken) return false
  const expiresAt = current.expiresAt ?? 0
  if (!force && expiresAt && expiresAt - Date.now() > REFRESH_SKEW_MS) return true
  const next = await refreshOAuthFlow(config, current.refreshToken, current.deviceId)
  const mergedToken: OAuthToken = {
    ...current,
    ...next,
    refreshToken: next.refreshToken ?? current.refreshToken
  }
  const finalToken = await finalizeOAuthToken(provider, mergedToken)
  setProviderAuth(providerId, buildOAuthProviderPatch(provider, finalToken))
  return true
}

export async function ensureProviderAuthReady(providerId: string): Promise<boolean> {
  const provider = getProviderById(providerId)
  if (!provider) return false

  const authMode = provider.authMode ?? 'apiKey'
  if (authMode === 'apiKey') {
    if (provider.requiresApiKey === false) return true
    return !!provider.apiKey
  }

  if (authMode === 'oauth') {
    // --- Multi-account path ---
    const accounts = getAccountsArray(provider)
    if (accounts.length > 0) {
      // 1. Pick a usable account and persist any sweep/activation change.
      const { account, nextAccounts, changed } = pickUsableAccount(provider)
      if (!account) return false

      let working = provider
      if (changed || provider.activeAccountId !== account.id) {
        setProviderAuth(
          providerId,
          buildAccountProjectionPatch(provider, nextAccounts, account.id)
        )
        working = getProviderById(providerId) ?? provider
      }

      // 2. Refresh that account's token if it's near expiry.
      let targetAccount = findAccountById(working, account.id) ?? account
      const expiresAt = targetAccount.oauth.expiresAt ?? 0
      if (expiresAt && expiresAt - Date.now() <= REFRESH_SKEW_MS) {
        try {
          const refreshed = await refreshProviderOAuth(providerId, true, targetAccount.id)
          if (!refreshed) return false
          working = getProviderById(providerId) ?? working
          targetAccount = findAccountById(working, account.id) ?? targetAccount
        } catch {
          return false
        }
      }

      // 3. Copilot: maintain derived copilotAccessToken.
      if (isCopilotProvider(working)) {
        const token = targetAccount.oauth
        const copilotExpiresAt = token.copilotExpiresAt ?? 0
        if (
          !token.copilotAccessToken ||
          (copilotExpiresAt && copilotExpiresAt - Date.now() <= REFRESH_SKEW_MS)
        ) {
          try {
            const next = await exchangeCopilotToken(working, token)
            const updatedAccount: ProviderOAuthAccount = { ...targetAccount, oauth: next }
            const updatedAccounts = upsertAccountInList(
              getAccountsArray(working),
              updatedAccount
            )
            setProviderAuth(
              providerId,
              buildAccountProjectionPatch(working, updatedAccounts, updatedAccount.id)
            )
            syncCopilotQuota(working, next)
            return true
          } catch {
            return false
          }
        }
        syncCopilotQuota(working, token)
      }

      // 4. Stamp lastUsedAt (best-effort, no full projection rewrite needed).
      const latest = getProviderById(providerId) ?? working
      const touched = getAccountsArray(latest).map((a) =>
        a.id === targetAccount.id ? { ...a, lastUsedAt: Date.now() } : a
      )
      setProviderAuth(providerId, {
        oauthAccounts: touched
      })
      return true
    }

    // --- Legacy single-token path (pre-migration) ---
    let latestProvider = provider
    let token = latestProvider.oauth
    if (!token?.accessToken) return false

    const expiresAt = token.expiresAt ?? 0
    if (expiresAt && expiresAt - Date.now() <= REFRESH_SKEW_MS) {
      try {
        const refreshed = await refreshProviderOAuth(providerId, true)
        if (!refreshed) return false
        latestProvider = getProviderById(providerId) ?? latestProvider
        token = latestProvider.oauth
        if (!token?.accessToken) return false
      } catch {
        return false
      }
    }

    if (isCopilotProvider(latestProvider)) {
      const copilotExpiresAt = token.copilotExpiresAt ?? 0
      if (
        !token.copilotAccessToken ||
        (copilotExpiresAt && copilotExpiresAt - Date.now() <= REFRESH_SKEW_MS)
      ) {
        try {
          const next = await exchangeCopilotToken(latestProvider, token)
          setProviderAuth(providerId, buildOAuthProviderPatch(latestProvider, next))
          return true
        } catch {
          return false
        }
      }
      const apiKey = resolveCopilotApiKey(token)
      if (!apiKey) return false
      if (
        latestProvider.apiKey !== apiKey ||
        (token.copilotApiUrl && latestProvider.baseUrl !== token.copilotApiUrl)
      ) {
        setProviderAuth(providerId, {
          apiKey,
          ...(token.copilotApiUrl ? { baseUrl: token.copilotApiUrl } : {})
        })
      }
      syncCopilotQuota(latestProvider, token)
      return true
    }

    if (!latestProvider.apiKey) {
      setProviderAuth(providerId, { apiKey: token.accessToken })
    }
    return true
  }

  if (authMode === 'channel') {
    const accessToken = provider.channel?.accessToken
    if (!accessToken) return false
    if (!provider.apiKey) {
      setProviderAuth(providerId, { apiKey: accessToken })
    }
    const expiresAt = provider.channel?.accessTokenExpiresAt
    if (expiresAt && Date.now() > expiresAt) {
      return false
    }
    return true
  }

  return false
}

export async function sendProviderChannelCode(args: {
  providerId: string
  channelType: 'sms' | 'email'
  mobile?: string
  email?: string
}): Promise<void> {
  const provider = getProviderById(args.providerId)
  if (!provider) throw new Error('Provider not found')
  if (!provider.channelConfig) throw new Error('Channel config missing')
  const appId =
    provider.channel?.appId?.trim() || provider.channelConfig?.defaultAppId?.trim() || ''
  const appToken = provider.channel?.appToken?.trim() || ''

  await sendChannelCode({
    config: provider.channelConfig,
    appId,
    appToken,
    channelType: args.channelType,
    mobile: args.mobile,
    email: args.email
  })
}

export async function verifyProviderChannelCode(args: {
  providerId: string
  channelType: 'sms' | 'email'
  code: string
  mobile?: string
  email?: string
}): Promise<void> {
  const provider = getProviderById(args.providerId)
  if (!provider) throw new Error('Provider not found')
  if (!provider.channelConfig) throw new Error('Channel config missing')
  const appId =
    provider.channel?.appId?.trim() || provider.channelConfig?.defaultAppId?.trim() || ''
  const appToken = provider.channel?.appToken?.trim() || ''

  const { accessToken } = await verifyChannelCode({
    config: provider.channelConfig,
    appId,
    appToken,
    channelType: args.channelType,
    code: args.code,
    mobile: args.mobile,
    email: args.email
  })

  let userInfo: Record<string, unknown> | undefined
  try {
    userInfo = await fetchChannelUserInfo(provider.channelConfig, accessToken)
  } catch {
    userInfo = undefined
  }

  setProviderAuth(args.providerId, {
    authMode: 'channel',
    channel: {
      appId,
      appToken,
      accessToken,
      channelType: args.channelType,
      userInfo
    },
    apiKey: accessToken
  })
}

export async function refreshProviderChannelUserInfo(providerId: string): Promise<void> {
  const provider = getProviderById(providerId)
  if (!provider?.channelConfig || !provider.channel?.accessToken) return
  const userInfo = await fetchChannelUserInfo(provider.channelConfig, provider.channel.accessToken)
  setProviderAuth(providerId, {
    channel: {
      ...(provider.channel ?? { appId: '', appToken: '' }),
      userInfo
    }
  })
}

export function clearProviderChannelAuth(providerId: string): void {
  setProviderAuth(providerId, { channel: undefined, apiKey: '' })
}
