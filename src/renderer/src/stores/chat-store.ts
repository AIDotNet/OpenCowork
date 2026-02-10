import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { persist, createJSONStorage } from 'zustand/middleware'
import { nanoid } from 'nanoid'
import type { UnifiedMessage, ContentBlock, TextBlock, ThinkingBlock, ToolUseBlock } from '../lib/api/types'

export type SessionMode = 'chat' | 'cowork' | 'code'

export interface Session {
  id: string
  title: string
  mode: SessionMode
  messages: UnifiedMessage[]
  createdAt: number
  updatedAt: number
  workingFolder?: string
  pinned?: boolean
}

interface ChatStore {
  sessions: Session[]
  activeSessionId: string | null

  // Session CRUD
  createSession: (mode: SessionMode) => string
  deleteSession: (id: string) => void
  setActiveSession: (id: string | null) => void
  updateSessionTitle: (id: string, title: string) => void
  updateSessionMode: (id: string, mode: SessionMode) => void
  setWorkingFolder: (sessionId: string, folder: string) => void
  clearSessionMessages: (sessionId: string) => void
  duplicateSession: (sessionId: string) => string | null
  togglePinSession: (sessionId: string) => void
  restoreSession: (session: Session) => void
  clearAllSessions: () => void
  removeLastAssistantMessage: (sessionId: string) => string | null
  removeLastUserMessage: (sessionId: string) => void
  truncateMessagesFrom: (sessionId: string, fromIndex: number) => void

  // Message operations
  addMessage: (sessionId: string, msg: UnifiedMessage) => void
  updateMessage: (sessionId: string, msgId: string, patch: Partial<UnifiedMessage>) => void
  appendTextDelta: (sessionId: string, msgId: string, text: string) => void
  appendThinkingDelta: (sessionId: string, msgId: string, thinking: string) => void
  completeThinking: (sessionId: string, msgId: string) => void
  appendToolUse: (sessionId: string, msgId: string, toolUse: ToolUseBlock) => void
  updateToolUseInput: (sessionId: string, msgId: string, toolUseId: string, input: Record<string, unknown>) => void

  // Streaming state
  streamingMessageId: string | null
  setStreamingMessageId: (id: string | null) => void

  // Helpers
  getActiveSession: () => Session | undefined
  getSessionMessages: (sessionId: string) => UnifiedMessage[]
}

export const useChatStore = create<ChatStore>()(
  persist(
  immer((set, get) => ({
    sessions: [],
    activeSessionId: null,
    streamingMessageId: null,

    createSession: (mode) => {
      const id = nanoid()
      const now = Date.now()
      set((state) => {
        state.sessions.push({
          id,
          title: 'New Conversation',
          mode,
          messages: [],
          createdAt: now,
          updatedAt: now,
        })
        state.activeSessionId = id
      })
      return id
    },

    deleteSession: (id) => {
      set((state) => {
        const idx = state.sessions.findIndex((s) => s.id === id)
        if (idx !== -1) state.sessions.splice(idx, 1)
        if (state.activeSessionId === id) {
          state.activeSessionId = state.sessions[0]?.id ?? null
        }
      })
    },

    setActiveSession: (id) => set({ activeSessionId: id }),

    updateSessionTitle: (id, title) => {
      set((state) => {
        const session = state.sessions.find((s) => s.id === id)
        if (session) {
          session.title = title
          session.updatedAt = Date.now()
        }
      })
    },

    updateSessionMode: (id, mode) => {
      set((state) => {
        const session = state.sessions.find((s) => s.id === id)
        if (session) {
          session.mode = mode
          session.updatedAt = Date.now()
        }
      })
    },

    setWorkingFolder: (sessionId, folder) => {
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (session) session.workingFolder = folder
      })
    },

    togglePinSession: (sessionId) => {
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (session) {
          session.pinned = !session.pinned
        }
      })
    },

    restoreSession: (session) => {
      set((state) => {
        state.sessions.push(session)
        state.activeSessionId = session.id
      })
    },

    clearAllSessions: () => {
      set((state) => {
        state.sessions = []
        state.activeSessionId = null
      })
    },

    clearSessionMessages: (sessionId) => {
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (session) {
          session.messages = []
          session.title = 'New Conversation'
          session.updatedAt = Date.now()
        }
      })
    },

    duplicateSession: (sessionId) => {
      const source = get().sessions.find((s) => s.id === sessionId)
      if (!source) return null
      const newId = nanoid()
      const now = Date.now()
      set((state) => {
        state.sessions.push({
          id: newId,
          title: `${source.title} (copy)`,
          mode: source.mode,
          messages: JSON.parse(JSON.stringify(source.messages)),
          createdAt: now,
          updatedAt: now,
          workingFolder: source.workingFolder,
        })
        state.activeSessionId = newId
      })
      return newId
    },

    removeLastAssistantMessage: (sessionId) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session || session.messages.length === 0) return null
      const lastMsg = session.messages[session.messages.length - 1]
      if (lastMsg.role !== 'assistant') return null
      set((state) => {
        const s = state.sessions.find((s) => s.id === sessionId)
        if (s) s.messages.pop()
      })
      // Return the last user message text for retry
      const updated = get().sessions.find((s) => s.id === sessionId)
      const lastUser = updated?.messages.findLast((m) => m.role === 'user')
      return lastUser ? (typeof lastUser.content === 'string' ? lastUser.content : null) : null
    },

    removeLastUserMessage: (sessionId) => {
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (!session || session.messages.length === 0) return
        const lastMsg = session.messages[session.messages.length - 1]
        if (lastMsg.role === 'user') session.messages.pop()
      })
    },

    truncateMessagesFrom: (sessionId, fromIndex) => {
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (session && fromIndex >= 0 && fromIndex < session.messages.length) {
          session.messages.splice(fromIndex)
          session.updatedAt = Date.now()
        }
      })
    },

    addMessage: (sessionId, msg) => {
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (session) {
          session.messages.push(msg)
          session.updatedAt = Date.now()
        }
      })
    },

    updateMessage: (sessionId, msgId, patch) => {
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (!session) return
        const msg = session.messages.find((m) => m.id === msgId)
        if (msg) Object.assign(msg, patch)
      })
    },

    appendTextDelta: (sessionId, msgId, text) => {
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (!session) return
        const msg = session.messages.find((m) => m.id === msgId)
        if (!msg) return

        if (typeof msg.content === 'string') {
          msg.content += text
        } else {
          // Find last text block or create one
          const blocks = msg.content as ContentBlock[]
          const lastBlock = blocks[blocks.length - 1]
          if (lastBlock && lastBlock.type === 'text') {
            ;(lastBlock as TextBlock).text += text
          } else {
            blocks.push({ type: 'text', text })
          }
        }
      })
    },

    appendThinkingDelta: (sessionId, msgId, thinking) => {
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (!session) return
        const msg = session.messages.find((m) => m.id === msgId)
        if (!msg) return

        const now = Date.now()
        if (typeof msg.content === 'string') {
          // Convert empty string to block array with a thinking block
          msg.content = [{ type: 'thinking', thinking, startedAt: now }]
        } else {
          const blocks = msg.content as ContentBlock[]
          const lastBlock = blocks[blocks.length - 1]
          if (lastBlock && lastBlock.type === 'thinking') {
            ;(lastBlock as ThinkingBlock).thinking += thinking
          } else {
            blocks.push({ type: 'thinking', thinking, startedAt: now })
          }
        }
      })
    },

    completeThinking: (sessionId, msgId) => {
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (!session) return
        const msg = session.messages.find((m) => m.id === msgId)
        if (!msg || typeof msg.content === 'string') return

        const blocks = msg.content as ContentBlock[]
        for (const block of blocks) {
          if (block.type === 'thinking' && !block.completedAt) {
            block.completedAt = Date.now()
          }
        }
      })
    },

    appendToolUse: (sessionId, msgId, toolUse) => {
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (!session) return
        const msg = session.messages.find((m) => m.id === msgId)
        if (!msg) return

        if (typeof msg.content === 'string') {
          msg.content = [{ type: 'text', text: msg.content }, toolUse]
        } else {
          ;(msg.content as ContentBlock[]).push(toolUse)
        }
      })
    },

    updateToolUseInput: (sessionId, msgId, toolUseId, input) => {
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (!session) return
        const msg = session.messages.find((m) => m.id === msgId)
        if (!msg || typeof msg.content === 'string') return

        const block = (msg.content as ContentBlock[]).find(
          (b) => b.type === 'tool_use' && (b as ToolUseBlock).id === toolUseId
        ) as ToolUseBlock | undefined
        if (block) block.input = input
      })
    },

    setStreamingMessageId: (id) => set({ streamingMessageId: id }),

    getActiveSession: () => {
      const { sessions, activeSessionId } = get()
      return sessions.find((s) => s.id === activeSessionId)
    },

    getSessionMessages: (sessionId) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      return session?.messages ?? []
    },
  })),
  {
    name: 'opencowork-chat',
    storage: createJSONStorage(() => localStorage),
    partialize: (state) => ({
      sessions: state.sessions,
      activeSessionId: state.activeSessionId,
    }),
  }
  )
)
