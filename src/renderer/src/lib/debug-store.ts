import type { RequestDebugInfo } from './api/types'
import { useSettingsStore } from '../stores/settings-store'

export interface RequestTraceInfo {
  debugInfo?: RequestDebugInfo
  providerId?: string
  providerBuiltinId?: string
  model?: string
  executionPath?: 'sidecar' | 'hosted'
}

const MAX_DEBUG_STORE_ENTRIES = 80
const MAX_DEBUG_BODY_CHARS = 2_000
const MAX_RESIDENT_DEBUG_BODY_CHARS = 4_000
const MAX_PERSISTED_DEBUG_BODY_CHARS = 8_000

/**
 * Lightweight in-memory store for per-message request metadata.
 * Not persisted, not in Zustand — avoids bloating chat store and DB.
 * Capped at MAX_DEBUG_STORE_ENTRIES to prevent unbounded growth.
 */
const _store = new Map<string, RequestTraceInfo>()
const _insertionOrder: string[] = []

function evictOldest(): void {
  while (_insertionOrder.length > MAX_DEBUG_STORE_ENTRIES) {
    const oldest = _insertionOrder.shift()
    if (oldest) _store.delete(oldest)
  }
}

function stripBodyFields(info: RequestDebugInfo): RequestDebugInfo {
  const { body: _body, bodyRef: _bodyRef, bodyBytes: _bodyBytes, ...rest } = info
  return rest
}

function stripInlineBody(info: RequestDebugInfo): RequestDebugInfo {
  if (info.body === undefined) return info
  const { body: _body, ...rest } = info
  return rest
}

function truncateDebugText(value: string | undefined, max: number): string | undefined {
  if (!value || value.length <= max) return value
  return `${value.slice(0, max)}\n... [truncated, ${value.length} chars total]`
}

function truncateRequestDebugPayload(info: RequestDebugInfo, max: number): RequestDebugInfo {
  return {
    ...info,
    body: truncateDebugText(info.body, max),
    contextWindowBody: truncateDebugText(info.contextWindowBody, max)
  }
}

/**
 * Shrink request payloads before keeping them on resident message objects.
 * Full bodies stay in the capped debug-store for the current dev session only.
 */
export function createResidentRequestDebugInfo(info: RequestDebugInfo): RequestDebugInfo {
  return truncateRequestDebugPayload(info, MAX_RESIDENT_DEBUG_BODY_CHARS)
}

/** Shrink request payloads before persisting to usage DB — full bodies are UI-only in dev mode. */
export function truncateRequestDebugForPersistence(info: RequestDebugInfo): RequestDebugInfo {
  return stripBodyFields(truncateRequestDebugPayload(info, MAX_PERSISTED_DEBUG_BODY_CHARS))
}

export function getRequestDebugStoreStats(): {
  entries: number
  debugEntries: number
  bodyChars: number
  contextWindowChars: number
} {
  let debugEntries = 0
  let bodyChars = 0
  let contextWindowChars = 0

  for (const trace of _store.values()) {
    if (!trace.debugInfo) continue
    debugEntries += 1
    bodyChars += trace.debugInfo.body?.length ?? 0
    contextWindowChars += trace.debugInfo.contextWindowBody?.length ?? 0
  }

  return {
    entries: _store.size,
    debugEntries,
    bodyChars,
    contextWindowChars
  }
}

export function compactRequestDebugStore(maxChars = MAX_DEBUG_BODY_CHARS): void {
  for (const [id, trace] of _store.entries()) {
    if (!trace.debugInfo) continue
    _store.set(id, {
      ...trace,
      debugInfo: truncateRequestDebugPayload(trace.debugInfo, maxChars)
    })
  }
}

function mergeTraceIntoDebugInfo(msgId: string, info: RequestDebugInfo): RequestDebugInfo {
  const trace = _store.get(msgId)
  return {
    ...info,
    providerId: info.providerId ?? trace?.providerId,
    providerBuiltinId: info.providerBuiltinId ?? trace?.providerBuiltinId,
    model: info.model ?? trace?.model,
    executionPath: info.executionPath ?? trace?.executionPath
  }
}

/**
 * Inline bodies are large, so only the newest message keeps one. bodyRef is a
 * tiny file-reference string and MUST survive on every message — it is what
 * lets the debug panel load that message's last request body JSON later.
 */
function stripInlineDebugBodyFromOtherMessages(keepMsgId: string): void {
  for (const id of _insertionOrder) {
    if (id === keepMsgId) continue
    const t = _store.get(id)
    if (!t?.debugInfo) continue
    const stripped = stripInlineBody(t.debugInfo)
    if (stripped === t.debugInfo) continue
    _store.set(id, {
      ...t,
      debugInfo: stripped
    })
  }
}

export function setRequestTraceInfo(msgId: string, patch: Partial<RequestTraceInfo>): void {
  const isNew = !_store.has(msgId)
  const current = _store.get(msgId) ?? {}
  _store.set(msgId, { ...current, ...patch })
  if (isNew) {
    _insertionOrder.push(msgId)
    evictOldest()
  }
}

export function getRequestTraceInfo(msgId: string): RequestTraceInfo | undefined {
  return _store.get(msgId)
}

export function setLastDebugInfo(msgId: string, info: RequestDebugInfo): void {
  const current = _store.get(msgId)?.debugInfo
  if (
    current &&
    Number.isFinite(current.timestamp) &&
    Number.isFinite(info.timestamp) &&
    info.timestamp < current.timestamp
  ) {
    return
  }

  const devMode = useSettingsStore.getState().devMode
  const merged = mergeTraceIntoDebugInfo(msgId, info)
  const debugInfo = devMode ? merged : stripBodyFields(merged)
  if (devMode) {
    stripInlineDebugBodyFromOtherMessages(msgId)
  }
  setRequestTraceInfo(msgId, {
    debugInfo,
    providerId: merged.providerId,
    providerBuiltinId: merged.providerBuiltinId,
    model: merged.model,
    executionPath: merged.executionPath
  })
}

export function getLastDebugInfo(msgId: string): RequestDebugInfo | undefined {
  return _store.get(msgId)?.debugInfo
}

export function clearDebugStoreForSession(messageIds: string[]): void {
  for (const id of messageIds) {
    _store.delete(id)
  }
  const idSet = new Set(messageIds)
  const len = _insertionOrder.length
  for (let i = len - 1; i >= 0; i--) {
    if (idSet.has(_insertionOrder[i])) _insertionOrder.splice(i, 1)
  }
}
