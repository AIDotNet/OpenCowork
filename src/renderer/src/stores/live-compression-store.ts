import { create } from 'zustand'

export interface LiveCompressionState {
  sessionId: string
  runId: string | null
  draft: string
  attempt: number
  maxAttempts: number
  startedAt: number
}

interface LiveCompressionStore {
  bySessionId: Record<string, LiveCompressionState>
  start: (
    sessionId: string,
    options?: { runId?: string | null; attempt?: number; maxAttempts?: number }
  ) => void
  appendDraft: (sessionId: string, text: string) => void
  clear: (sessionId: string) => void
}

export const useLiveCompressionStore = create<LiveCompressionStore>((set) => ({
  bySessionId: {},
  start: (sessionId, options) =>
    set((state) => {
      const existing = state.bySessionId[sessionId]
      const attempt = options?.attempt && options.attempt > 0 ? options.attempt : 1
      const resetDraft = !existing || attempt !== existing.attempt
      return {
        bySessionId: {
          ...state.bySessionId,
          [sessionId]: {
            sessionId,
            runId: options?.runId ?? existing?.runId ?? null,
            draft: resetDraft ? '' : existing.draft,
            attempt,
            maxAttempts:
              options?.maxAttempts && options.maxAttempts > 0
                ? options.maxAttempts
                : (existing?.maxAttempts ?? 1),
            startedAt: existing?.startedAt ?? Date.now()
          }
        }
      }
    }),
  appendDraft: (sessionId, text) =>
    set((state) => {
      const existing = state.bySessionId[sessionId]
      if (!existing) {
        return {
          bySessionId: {
            ...state.bySessionId,
            [sessionId]: {
              sessionId,
              runId: null,
              draft: text,
              attempt: 1,
              maxAttempts: 1,
              startedAt: Date.now()
            }
          }
        }
      }
      return {
        bySessionId: {
          ...state.bySessionId,
          [sessionId]: { ...existing, draft: existing.draft + text }
        }
      }
    }),
  clear: (sessionId) =>
    set((state) => {
      if (!state.bySessionId[sessionId]) return state
      const next = { ...state.bySessionId }
      delete next[sessionId]
      return { bySessionId: next }
    })
}))

export function applyLiveCompressionStreamEvent(
  sessionId: string,
  event: { type: string; text?: string; attempt?: number; maxAttempts?: number }
): void {
  const store = useLiveCompressionStore.getState()
  switch (event.type) {
    case 'context_compression_start':
      store.start(sessionId, {
        attempt: event.attempt,
        maxAttempts: event.maxAttempts
      })
      break
    case 'context_compression_delta':
      if (event.text) store.appendDraft(sessionId, event.text)
      break
    case 'context_compressed':
      store.clear(sessionId)
      break
    default:
      break
  }
}
