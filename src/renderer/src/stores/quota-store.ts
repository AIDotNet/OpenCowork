import { create } from 'zustand'

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

export type ProviderQuota = CodexQuota

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
    }),
}))

function resolveQuotaKey(payload: QuotaUpdatePayload): string | null {
  return payload.providerId || payload.providerBuiltinId || payload.quota?.type || null
}

let listenerRegistered = false

if (typeof window !== 'undefined' && window.electron?.ipcRenderer && !listenerRegistered) {
  listenerRegistered = true
  window.electron.ipcRenderer.on('api:quota-update', (_event, payload: QuotaUpdatePayload) => {
    if (!payload?.quota) return
    const key = resolveQuotaKey(payload)
    if (!key) return
    useQuotaStore.getState().updateQuota(key, payload.quota)
  })
}
