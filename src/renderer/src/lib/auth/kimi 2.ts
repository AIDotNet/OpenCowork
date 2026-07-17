import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import type { AIProvider } from '@renderer/lib/api/types'
import { useQuotaStore, type KimiQuota, type KimiQuotaWindow } from '@renderer/stores/quota-store'

const DEFAULT_KIMI_CODING_BASE_URL = 'https://api.kimi.com/coding/v1'

// 对齐 MoonshotAI/kimi-cli 的 /usages 响应（src/kimi_cli/ui/shell/usage.py）：
// 数值是 0-100 刻度的字符串，顶层 usage 为周额度，limits[] 按 window.duration/timeUnit
// 描述滚动窗口（线上为 300 分钟 = 5 小时）。接口只认 Bearer，聊天响应头不带额度。

function parseQuotaNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function parseWindowMinutes(window: Record<string, unknown> | undefined): number | undefined {
  const duration = parseQuotaNumber(window?.duration)
  if (duration === undefined) return undefined
  const unit = String(window?.timeUnit ?? '').toUpperCase()
  if (unit.includes('SECOND')) return Math.round(duration / 60)
  if (unit.includes('HOUR')) return duration * 60
  if (unit.includes('DAY')) return duration * 1440
  if (unit.includes('WEEK')) return duration * 10080
  if (unit.includes('MONTH')) return duration * 43200
  return duration
}

function parseResetAfterSeconds(detail: Record<string, unknown>): number | undefined {
  const relative = parseQuotaNumber(detail.reset_in ?? detail.resetIn ?? detail.ttl)
  if (relative !== undefined) return Math.max(0, relative)
  const raw = detail.resetTime ?? detail.reset_at ?? detail.resetAt ?? detail.reset_time
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  // 后端可能给纳秒级小数位，截断到毫秒再解析。
  const normalized = raw.trim().replace(/(\.\d{3})\d+(?=Z|[+-]\d{2}:?\d{2}$)/i, '$1')
  const parsed = Date.parse(normalized)
  if (Number.isNaN(parsed)) return undefined
  return Math.max(0, Math.round((parsed - Date.now()) / 1000))
}

function parseQuotaDetail(
  value: unknown,
  options?: { windowMinutes?: number; label?: string; keepResetAt?: boolean }
): KimiQuotaWindow | undefined {
  const detail = asRecord(value)
  if (!detail) return undefined

  const limit = parseQuotaNumber(detail.limit)
  const remaining = parseQuotaNumber(detail.remaining)
  let used = parseQuotaNumber(detail.used)
  if (used === undefined && limit !== undefined && remaining !== undefined) {
    used = limit - remaining
  }
  const usedPercent =
    limit !== undefined && limit > 0 && used !== undefined
      ? Math.min(100, Math.max(0, (used / limit) * 100))
      : undefined
  const resetAfterSeconds = parseResetAfterSeconds(detail)
  const resetRaw = detail.resetTime ?? detail.reset_at ?? detail.resetAt ?? detail.reset_time
  const resetAt =
    options?.keepResetAt && typeof resetRaw === 'string' && resetRaw.trim()
      ? resetRaw.trim()
      : undefined
  const label =
    options?.label ||
    [detail.name, detail.title, detail.scope].find(
      (v): v is string => typeof v === 'string' && !!v.trim()
    )

  const window: KimiQuotaWindow = {
    usedPercent,
    windowMinutes: options?.windowMinutes,
    resetAt,
    resetAfterSeconds,
    label
  }
  return Object.values(window).some((v) => v !== undefined) ? window : undefined
}

export function parseKimiUsagePayload(payload: unknown): KimiQuota | null {
  const outer = asRecord(payload)
  if (!outer) return null
  const root = asRecord(outer.data) ?? outer

  // 周额度展示重置日期即可，滚动窗口用相对剩余时间更直观。
  const weekly = parseQuotaDetail(root.usage, { keepResetAt: true })
  const windows = (Array.isArray(root.limits) ? root.limits : [])
    .map((item) => {
      const entry = asRecord(item)
      if (!entry) return undefined
      return parseQuotaDetail(entry.detail, {
        windowMinutes: parseWindowMinutes(asRecord(entry.window))
      })
    })
    .filter((w): w is KimiQuotaWindow => !!w)
  const parallelLimit = parseQuotaNumber(asRecord(root.parallel)?.limit)

  if (!weekly && windows.length === 0) return null
  return {
    type: 'kimi',
    weekly,
    windows: windows.length > 0 ? windows : undefined,
    parallelLimit,
    fetchedAt: Date.now()
  }
}

export async function fetchKimiQuota(provider: AIProvider): Promise<KimiQuota> {
  const token = provider.oauth?.accessToken?.trim() || provider.apiKey?.trim() || ''
  if (!token) {
    throw new Error('Missing Kimi access token')
  }

  const baseUrl = (provider.baseUrl?.trim() || DEFAULT_KIMI_CODING_BASE_URL).replace(/\/+$/, '')
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json'
  }
  if (provider.userAgent?.trim()) {
    headers['User-Agent'] = provider.userAgent.trim()
  }

  const result = (await ipcClient.invoke('api:request', {
    url: `${baseUrl}/usages`,
    method: 'GET',
    headers,
    useSystemProxy: provider.useSystemProxy,
    providerId: provider.id,
    providerBuiltinId: provider.builtinId
  })) as { statusCode?: number; error?: string; body?: string }

  if (result?.error) throw new Error(result.error)
  const status = result?.statusCode ?? 0
  if (status < 200 || status >= 300) {
    throw new Error(`HTTP ${status}: ${result?.body?.slice(0, 200) ?? ''}`)
  }
  if (!result.body) throw new Error('Empty usage response')

  const quota = parseKimiUsagePayload(JSON.parse(result.body))
  if (!quota) throw new Error('Unrecognized usage response')

  const store = useQuotaStore.getState()
  store.updateQuota(provider.id, quota)
  if (provider.builtinId) {
    store.updateQuota(provider.builtinId, quota)
  }
  return quota
}
