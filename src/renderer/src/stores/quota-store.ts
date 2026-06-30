import { create } from 'zustand'
import { markAccountRateLimited } from '@renderer/lib/auth/provider-auth'
import type { AccountRateLimit } from '@renderer/lib/api/types'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'

export interface CodexQuotaWindow {
  usedPercent?: number
  windowMinutes?: number
  resetAt?: string
  resetAfterSeconds?: number
}

export interface CodexQuota {
  type: 'codex'
  planType?: string
  primary?: CodexQuotaWindow
  secondary?: CodexQuotaWindow
  primaryOverSecondaryLimitPercent?: number
  credits?: {
    hasCredits?: boolean
    balance?: number
    unlimited?: boolean
  }
  fetchedAt: number
}

export interface CopilotQuota {
  type: 'copilot'
  sku?: string
  chatEnabled?: boolean
  telemetry?: string
  apiBaseUrl?: string
  tokenExpiresAt?: number
  fetchedAt: number
}

export type ProviderQuota = CodexQuota | CopilotQuota

export interface QuotaUpdatePayload {
  requestId?: string
  url?: string
  providerId?: string
  providerBuiltinId?: string
  quota: ProviderQuota
}

interface QuotaStore {
  quotaByKey: Record<string, ProviderQuota>
  updateQuota: (key: string, quota: ProviderQuota) => void
  clearQuota: (key: string) => void
}

export const useQuotaStore = create<QuotaStore>((set) => ({
  quotaByKey: {},
  updateQuota: (key, quota) =>
    set((state) => ({ quotaByKey: { ...state.quotaByKey, [key]: quota } })),
  clearQuota: (key) =>
    set((state) => {
      const next = { ...state.quotaByKey }
      delete next[key]
      return { quotaByKey: next }
    })
}))

function resolveQuotaKey(payload: QuotaUpdatePayload): string | null {
  return payload.providerId || payload.providerBuiltinId || payload.quota?.type || null
}

let listenerRegistered = false

interface AccountRateLimitedPayload {
  providerId?: string
  providerBuiltinId?: string
  accountId?: string
  resetAt: number
  reason: 'http-429' | 'codex-quota'
  windowType?: 'primary' | 'secondary'
  message?: string
}

if (typeof window !== 'undefined' && !listenerRegistered) {
  listenerRegistered = true
  ipcClient.on(IPC.API_QUOTA_UPDATE, (payload: unknown) => {
    const quotaPayload = payload as QuotaUpdatePayload
    if (!quotaPayload?.quota) return
    const key = resolveQuotaKey(quotaPayload)
    if (!key) return
    useQuotaStore.getState().updateQuota(key, quotaPayload.quota)
  })

  ipcClient.on(IPC.API_ACCOUNT_RATE_LIMITED, (payload: unknown) => {
    const rateLimitPayload = payload as AccountRateLimitedPayload
    if (!rateLimitPayload || !rateLimitPayload.accountId) return
    const providerId = rateLimitPayload.providerId || rateLimitPayload.providerBuiltinId
    if (!providerId) return
    const info: Omit<AccountRateLimit, 'limitedAt'> = {
      resetAt: rateLimitPayload.resetAt,
      reason: rateLimitPayload.reason,
      windowType: rateLimitPayload.windowType,
      message: rateLimitPayload.message
    }
    markAccountRateLimited(providerId, rateLimitPayload.accountId, info)
  })
}
