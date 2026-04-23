import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { nanoid } from 'nanoid'
import type { UnifiedMessage } from '@renderer/lib/api/types'

const MAX_BUFFERED_ADDED_MESSAGES = 200

export type PendingInboxItemType =
  | 'ask_user'
  | 'approval'
  | 'preview_ready'
  | 'desktop_control'
  | 'foreground_bash'
  | 'error'

export interface PendingInboxPreviewTarget {
  kind: 'file'
  filePath: string
  viewMode: 'preview' | 'code'
  sshConnectionId?: string
}

export interface PendingInboxItem {
  id: string
  sessionId: string
  type: PendingInboxItemType
  title: string
  description?: string
  toolUseId?: string
  createdAt: number
  resolvedAt?: number
  target?: PendingInboxPreviewTarget
}

/**
 * Buffered state for a session whose UI is not currently visible.
 *
 * Structure:
 * - `patchedMessagesById`: in-place modifications of messages that already existed
 *   in chat-store when streaming started (or could be seeded from chat-store on demand).
 * - `addedMessagesById` + `addedMessageIds`: brand-new messages created by the agent
 *   while the session was in the background. The ordered id array preserves insertion
 *   order for deterministic replay when the session is brought back to the foreground.
 *
 * Refactored from the previous design (which used JSON.parse(JSON.stringify(msg))
 * for every delta and had O(n) findIndex on every append) to use Immer's structural
 * sharing and Record lookups, removing the per-delta GC pressure entirely.
 */
export interface BackgroundBufferedSessionState {
  patchedMessagesById: Record<string, UnifiedMessage>
  addedMessagesById: Record<string, UnifiedMessage>
  addedMessageIds: string[]
  unreadCount: number
  lastEventAt: number | null
}

interface BackgroundSessionStore {
  sessions: Record<string, BackgroundBufferedSessionState>
  inboxItems: PendingInboxItem[]
  unreadCountsBySession: Record<string, number>
  blockedCountsBySession: Record<string, number>
  ensureSessionState: (sessionId: string) => void
  /**
   * Insert a message into the buffer as either a patched clone (of an existing chat-store
   * message) or a brand-new added message. No-op if the message id is already buffered.
   */
  seedBufferedMessage: (
    sessionId: string,
    message: UnifiedMessage,
    kind: 'patched' | 'added'
  ) => void
  /**
   * Locate a buffered message (patched or added) and apply the mutator in-place via Immer.
   * If the message isn't in the buffer yet, a seed is created using `seedResolver` — which
   * is called with no access to chat-store here to avoid a cyclic import. Callers are
   * responsible for passing a resolver that can look up the current chat-store snapshot.
   * If `seedResolver` returns undefined, an empty assistant placeholder is created so the
   * mutation is never silently dropped.
   */
  mutateBufferedMessageInPlace: (
    sessionId: string,
    messageId: string,
    seedResolver: () => UnifiedMessage | undefined,
    mutator: (message: UnifiedMessage) => void
  ) => void
  /**
   * Queue a buffered mutation to be applied in the next microtask, coalescing multiple
   * mutations into a single Immer produce. Use `flushPendingMutationsNow()` to drain
   * the queue synchronously (e.g. before taking a snapshot).
   */
  queueBufferedMutation: (
    sessionId: string,
    messageId: string,
    seedResolver: () => UnifiedMessage | undefined,
    mutator: (message: UnifiedMessage) => void
  ) => void
  flushPendingMutationsNow: () => void
  /**
   * Atomically clear and return the buffered state for a session. Used when flushing
   * the buffer back to the chat-store so that any deltas arriving during the flush go
   * to the new foreground path (chat-store) instead of being overwritten by the flush.
   */
  takeSessionSnapshot: (sessionId: string) => BackgroundBufferedSessionState | null
  markSessionUpdate: (sessionId: string) => void
  clearBufferedSession: (sessionId: string) => void
  addInboxItem: (item: Omit<PendingInboxItem, 'id' | 'createdAt'> & { id?: string }) => string
  resolveInboxItem: (itemId: string) => void
  resolveInboxItemByToolUseId: (toolUseId: string) => void
  clearSession: (sessionId: string) => void
}

function createEmptySessionState(): BackgroundBufferedSessionState {
  return {
    patchedMessagesById: {},
    addedMessagesById: {},
    addedMessageIds: [],
    unreadCount: 0,
    lastEventAt: null
  }
}

function incrementBlockedCount(
  counts: Record<string, number>,
  sessionId: string,
  type: PendingInboxItemType
): void {
  if (type === 'error') return
  counts[sessionId] = (counts[sessionId] ?? 0) + 1
}

function decrementBlockedCount(
  counts: Record<string, number>,
  sessionId: string,
  type: PendingInboxItemType
): void {
  if (type === 'error') return
  const next = (counts[sessionId] ?? 1) - 1
  if (next <= 0) {
    delete counts[sessionId]
  } else {
    counts[sessionId] = next
  }
}

function isSamePreviewTarget(
  left?: PendingInboxPreviewTarget,
  right?: PendingInboxPreviewTarget
): boolean {
  if (!left && !right) return true
  if (!left || !right) return false
  return (
    left.kind === right.kind &&
    left.filePath === right.filePath &&
    left.viewMode === right.viewMode &&
    left.sshConnectionId === right.sshConnectionId
  )
}

/**
 * Structured clone of a message. Used sparingly — only when seeding the buffer from a
 * chat-store message (so subsequent mutations don't leak into the foreground) and when
 * taking a snapshot for flush. The per-delta mutation path goes through Immer and does
 * NOT clone.
 */
function cloneMessageStructured(message: UnifiedMessage): UnifiedMessage {
  if (typeof structuredClone === 'function') {
    return structuredClone(message)
  }
  return JSON.parse(JSON.stringify(message)) as UnifiedMessage
}

// --- Microtask-coalesced mutation queue ---
// Background mutations arrive per-delta (~33 ms each). Queueing them and flushing in a
// single Immer produce per microtask reduces Zustand set() calls by 3-6x during streaming.
interface PendingBgMutation {
  sessionId: string
  messageId: string
  seedResolver: () => UnifiedMessage | undefined
  mutator: (message: UnifiedMessage) => void
}
const _pendingBgMutations: PendingBgMutation[] = []
let _bgMutationScheduled = false

function applyMutationBatch(
  state: { sessions: Record<string, BackgroundBufferedSessionState> },
  batch: PendingBgMutation[]
): void {
  for (const { sessionId, messageId, seedResolver, mutator } of batch) {
    const session = (state.sessions[sessionId] ??= createEmptySessionState())

    const patched = session.patchedMessagesById[messageId]
    if (patched) {
      mutator(patched)
      continue
    }

    const added = session.addedMessagesById[messageId]
    if (added) {
      mutator(added)
      continue
    }

    const seed = seedResolver()
    const cloned: UnifiedMessage = seed
      ? cloneMessageStructured(seed)
      : { id: messageId, role: 'assistant', content: [], createdAt: Date.now() }
    session.patchedMessagesById[messageId] = cloned
    mutator(cloned)
  }
}

export const useBackgroundSessionStore = create<BackgroundSessionStore>()(
  immer((set, get) => ({
    sessions: {},
    inboxItems: [],
    unreadCountsBySession: {},
    blockedCountsBySession: {},

    ensureSessionState: (sessionId) => {
      set((state) => {
        state.sessions[sessionId] ??= createEmptySessionState()
      })
    },

    seedBufferedMessage: (sessionId, message, kind) => {
      set((state) => {
        const session = (state.sessions[sessionId] ??= createEmptySessionState())
        if (kind === 'patched') {
          if (session.patchedMessagesById[message.id]) return
          session.patchedMessagesById[message.id] = cloneMessageStructured(message)
          return
        }
        // kind === 'added'
        if (session.addedMessagesById[message.id]) return
        session.addedMessagesById[message.id] = cloneMessageStructured(message)
        session.addedMessageIds.push(message.id)
        if (session.addedMessageIds.length > MAX_BUFFERED_ADDED_MESSAGES) {
          const overflow = session.addedMessageIds.length - MAX_BUFFERED_ADDED_MESSAGES
          const removed = session.addedMessageIds.splice(0, overflow)
          for (const id of removed) {
            delete session.addedMessagesById[id]
          }
        }
      })
    },

    mutateBufferedMessageInPlace: (sessionId, messageId, seedResolver, mutator) => {
      set((state) => {
        const session = (state.sessions[sessionId] ??= createEmptySessionState())

        // 1. Already buffered as a patch — mutate in place.
        const patched = session.patchedMessagesById[messageId]
        if (patched) {
          mutator(patched)
          return
        }

        // 2. Already buffered as an added message — mutate in place.
        const added = session.addedMessagesById[messageId]
        if (added) {
          mutator(added)
          return
        }

        // 3. Need to seed. Prefer resolver-provided snapshot (usually from chat-store).
        //    If the message isn't resolvable anywhere, create an empty placeholder so
        //    deltas are never silently dropped — they'll be merged back as a new message
        //    when the session flushes to the foreground.
        const seed = seedResolver()
        const cloned: UnifiedMessage = seed
          ? cloneMessageStructured(seed)
          : {
              id: messageId,
              role: 'assistant',
              content: [],
              createdAt: Date.now()
            }
        session.patchedMessagesById[messageId] = cloned
        mutator(cloned)
      })
    },

    queueBufferedMutation: (sessionId, messageId, seedResolver, mutator) => {
      _pendingBgMutations.push({ sessionId, messageId, seedResolver, mutator })
      if (!_bgMutationScheduled) {
        _bgMutationScheduled = true
        queueMicrotask(() => {
          _bgMutationScheduled = false
          if (_pendingBgMutations.length === 0) return
          const batch = _pendingBgMutations.splice(0)
          set((state) => {
            applyMutationBatch(state, batch)
          })
        })
      }
    },

    flushPendingMutationsNow: () => {
      _bgMutationScheduled = false
      if (_pendingBgMutations.length === 0) return
      const batch = _pendingBgMutations.splice(0)
      set((state) => {
        applyMutationBatch(state, batch)
      })
    },

    takeSessionSnapshot: (sessionId) => {
      get().flushPendingMutationsNow()
      const session = get().sessions[sessionId]
      if (!session) return null

      // Take a structural snapshot BEFORE mutating state, so what we return is stable.
      const snapshot: BackgroundBufferedSessionState = {
        patchedMessagesById: { ...session.patchedMessagesById },
        addedMessagesById: { ...session.addedMessagesById },
        addedMessageIds: [...session.addedMessageIds],
        unreadCount: session.unreadCount,
        lastEventAt: session.lastEventAt
      }

      set((state) => {
        delete state.sessions[sessionId]
        delete state.unreadCountsBySession[sessionId]
      })

      return snapshot
    },

    markSessionUpdate: (sessionId) => {
      set((state) => {
        const session =
          state.sessions[sessionId] ?? (state.sessions[sessionId] = createEmptySessionState())
        const nextUnread = session.unreadCount + 1
        session.unreadCount = nextUnread
        session.lastEventAt = Date.now()
        state.unreadCountsBySession[sessionId] = nextUnread
      })
    },

    clearBufferedSession: (sessionId) => {
      set((state) => {
        if (!state.sessions[sessionId]) return
        delete state.sessions[sessionId]
        delete state.unreadCountsBySession[sessionId]
      })
    },

    addInboxItem: (item) => {
      const toolUseId = item.toolUseId?.trim() || undefined
      const sessionId = item.sessionId
      const type = item.type
      const title = item.title.trim()

      if (!sessionId || !title) return ''

      const existing = get().inboxItems.find(
        (candidate) =>
          candidate.sessionId === sessionId &&
          candidate.type === type &&
          ((toolUseId && candidate.toolUseId === toolUseId) ||
            (!toolUseId &&
              candidate.title === title &&
              candidate.description === item.description &&
              isSamePreviewTarget(candidate.target, item.target)))
      )
      if (existing) return existing.id

      const nextId = item.id?.trim() || nanoid()
      set((state) => {
        state.inboxItems.unshift({
          id: nextId,
          sessionId,
          type,
          title,
          ...(item.description ? { description: item.description } : {}),
          ...(toolUseId ? { toolUseId } : {}),
          ...(item.target ? { target: item.target } : {}),
          createdAt: Date.now()
        })
        incrementBlockedCount(state.blockedCountsBySession, sessionId, type)
      })
      return nextId
    },

    resolveInboxItem: (itemId) => {
      if (!itemId) return
      set((state) => {
        const idx = state.inboxItems.findIndex((candidate) => candidate.id === itemId)
        if (idx === -1) return
        const item = state.inboxItems[idx]
        if (item.resolvedAt) return
        state.inboxItems.splice(idx, 1)
        decrementBlockedCount(state.blockedCountsBySession, item.sessionId, item.type)
      })
    },

    resolveInboxItemByToolUseId: (toolUseId) => {
      if (!toolUseId) return
      set((state) => {
        const remaining: PendingInboxItem[] = []
        for (const item of state.inboxItems) {
          if (item.toolUseId === toolUseId && !item.resolvedAt) {
            decrementBlockedCount(state.blockedCountsBySession, item.sessionId, item.type)
          } else {
            remaining.push(item)
          }
        }
        state.inboxItems = remaining
      })
    },

    clearSession: (sessionId) => {
      set((state) => {
        delete state.sessions[sessionId]
        delete state.unreadCountsBySession[sessionId]
        state.inboxItems = state.inboxItems.filter((item) => item.sessionId !== sessionId)
        delete state.blockedCountsBySession[sessionId]
      })
    }
  }))
)
