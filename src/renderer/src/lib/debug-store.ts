import type { RequestDebugInfo } from './api/types'

export interface RequestTraceInfo {
  debugInfo?: RequestDebugInfo
  providerId?: string
  providerBuiltinId?: string
  model?: string
}

/**
 * Lightweight in-memory store for per-message request metadata.
 * Not persisted, not in Zustand — avoids bloating chat store and DB.
 */
const _store = new Map<string, RequestTraceInfo>()

export function setRequestTraceInfo(msgId: string, patch: Partial<RequestTraceInfo>): void {
  const current = _store.get(msgId) ?? {}
  _store.set(msgId, { ...current, ...patch })
}

export function getRequestTraceInfo(msgId: string): RequestTraceInfo | undefined {
  return _store.get(msgId)
}

export function setLastDebugInfo(msgId: string, info: RequestDebugInfo): void {
  setRequestTraceInfo(msgId, { debugInfo: info })
}

export function getLastDebugInfo(msgId: string): RequestDebugInfo | undefined {
  return _store.get(msgId)?.debugInfo
}
