import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { nanoid } from 'nanoid'
import type {
  UnifiedMessage,
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultContent
} from '../lib/api/types'
import { ipcClient } from '../lib/ipc/ipc-client'
import { useAgentStore } from './agent-store'
import { useTeamStore } from './team-store'
import { useTaskStore } from './task-store'
import { usePlanStore } from './plan-store'
import { useUIStore } from './ui-store'
import { useProviderStore } from './provider-store'

export type SessionMode = 'chat' | 'cowork' | 'code'

export interface Session {
  id: string
  title: string
  icon?: string
  mode: SessionMode
  messages: UnifiedMessage[]
  messageCount: number
  messagesLoaded: boolean
  createdAt: number
  updatedAt: number
  workingFolder?: string
  sshConnectionId?: string
  pinned?: boolean
  /** Plugin ID if this session was created by auto-reply pipeline */
  pluginId?: string
  /** Composite key: plugin:{id}:chat:{chatId} */
  externalChatId?: string
  /** Bound provider ID (null = use global active provider) */
  providerId?: string
  /** Bound model ID (null = use global active model) */
  modelId?: string
}

// --- DB persistence helpers (fire-and-forget) ---

function dbCreateSession(s: Session): void {
  ipcClient.invoke('db:sessions:create', {
    id: s.id,
    title: s.title,
    icon: s.icon,
    mode: s.mode,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    workingFolder: s.workingFolder,
    sshConnectionId: s.sshConnectionId,
    pinned: s.pinned,
    providerId: s.providerId,
    modelId: s.modelId,
  }).catch(() => {})
}

function dbUpdateSession(id: string, patch: Record<string, unknown>): void {
  ipcClient.invoke('db:sessions:update', { id, patch }).catch(() => {})
}

function dbDeleteSession(id: string): void {
  ipcClient.invoke('db:sessions:delete', id).catch(() => {})
}

function dbClearAllSessions(): void {
  ipcClient.invoke('db:sessions:clear-all').catch(() => {})
}

function dbAddMessage(sessionId: string, msg: UnifiedMessage, sortOrder: number): void {
  ipcClient.invoke('db:messages:add', {
    id: msg.id,
    sessionId,
    role: msg.role,
    content: JSON.stringify(msg.content),
    createdAt: msg.createdAt,
    usage: msg.usage ? JSON.stringify(msg.usage) : null,
    sortOrder,
  }).catch(() => {})
}

function dbUpdateMessage(msgId: string, content: unknown, usage?: unknown): void {
  const patch: Record<string, unknown> = { content: JSON.stringify(content) }
  if (usage !== undefined) patch.usage = JSON.stringify(usage)
  ipcClient.invoke('db:messages:update', { id: msgId, patch }).catch(() => {})
}

function dbClearMessages(sessionId: string): void {
  ipcClient.invoke('db:messages:clear', sessionId).catch(() => {})
}

function dbTruncateMessagesFrom(sessionId: string, fromSortOrder: number): void {
  ipcClient.invoke('db:messages:truncate-from', { sessionId, fromSortOrder }).catch(() => {})
}

// --- Debounced message persistence for streaming ---

const _pendingFlush = new Map<string, ReturnType<typeof setTimeout>>()

function stripThinkTagMarkers(text: string): string {
  return text.replace(/<\s*\/?\s*think\s*>/gi, '')
}

function dbFlushMessage(_sessionId: string, msg: UnifiedMessage, _sortOrder: number): void {
  const key = msg.id
  const existing = _pendingFlush.get(key)
  if (existing) clearTimeout(existing)
  _pendingFlush.set(
    key,
    setTimeout(() => {
      _pendingFlush.delete(key)
      dbUpdateMessage(msg.id, msg.content, msg.usage)
    }, 500)
  )
}

function dbFlushMessageImmediate(_sessionId: string, msg: UnifiedMessage, _sortOrder: number): void {
  const existing = _pendingFlush.get(msg.id)
  if (existing) {
    clearTimeout(existing)
    _pendingFlush.delete(msg.id)
  }
  dbUpdateMessage(msg.id, msg.content, msg.usage)
}

// --- Store ---

interface ChatStore {
  sessions: Session[]
  activeSessionId: string | null
  _loaded: boolean

  // Initialization
  loadFromDb: () => Promise<void>
  loadSessionMessages: (sessionId: string, force?: boolean) => Promise<void>

  // Session CRUD
  createSession: (mode: SessionMode) => string
  deleteSession: (id: string) => void
  setActiveSession: (id: string | null) => void
  updateSessionTitle: (id: string, title: string) => void
  updateSessionIcon: (id: string, icon: string) => void
  updateSessionMode: (id: string, mode: SessionMode) => void
  setWorkingFolder: (sessionId: string, folder: string) => void
  setSshConnectionId: (sessionId: string, connectionId: string | null) => void
  updateSessionModel: (sessionId: string, providerId: string, modelId: string) => void
  clearSessionMessages: (sessionId: string) => void
  duplicateSession: (sessionId: string) => Promise<string | null>
  togglePinSession: (sessionId: string) => void
  restoreSession: (session: Session) => void
  clearAllSessions: () => void
  removeLastAssistantMessage: (sessionId: string) => string | null
  removeLastUserMessage: (sessionId: string) => void
  truncateMessagesFrom: (sessionId: string, fromIndex: number) => void
  replaceSessionMessages: (sessionId: string, messages: UnifiedMessage[]) => void
  sanitizeToolErrorsForResend: (sessionId: string) => void
  stripOldSystemReminders: (sessionId: string) => void

  // Message operations
  addMessage: (sessionId: string, msg: UnifiedMessage) => void
  updateMessage: (sessionId: string, msgId: string, patch: Partial<UnifiedMessage>) => void
  appendTextDelta: (sessionId: string, msgId: string, text: string) => void
  appendThinkingDelta: (sessionId: string, msgId: string, thinking: string) => void
  setThinkingEncryptedContent: (
    sessionId: string,
    msgId: string,
    encryptedContent: string,
    provider: 'anthropic' | 'openai-responses'
  ) => void
  completeThinking: (sessionId: string, msgId: string) => void
  appendToolUse: (sessionId: string, msgId: string, toolUse: ToolUseBlock) => void
  updateToolUseInput: (sessionId: string, msgId: string, toolUseId: string, input: Record<string, unknown>) => void

  // Streaming state (per-session)
  streamingMessageId: string | null
  /** Per-session streaming message map — allows concurrent agents across sessions */
  streamingMessages: Record<string, string>
  setStreamingMessageId: (sessionId: string, id: string | null) => void

  // Helpers
  getActiveSession: () => Session | undefined
  getSessionMessages: (sessionId: string) => UnifiedMessage[]
}

interface SessionRow {
  id: string
  title: string
  icon: string | null
  mode: string
  created_at: number
  updated_at: number
  working_folder: string | null
  ssh_connection_id?: string | null
  pinned: number
  message_count?: number
  plugin_id?: string | null
  external_chat_id?: string | null
  provider_id?: string | null
  model_id?: string | null
}

interface MessageRow {
  id: string
  session_id: string
  role: string
  content: string
  created_at: number
  usage: string | null
  sort_order: number
}

function rowToSession(row: SessionRow, messages: UnifiedMessage[] = []): Session {
  const messageCount = row.message_count ?? messages.length
  return {
    id: row.id,
    title: row.title,
    icon: row.icon ?? undefined,
    mode: row.mode as SessionMode,
    messages,
    messageCount,
    messagesLoaded: messages.length > 0 || messageCount === 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    workingFolder: row.working_folder ?? undefined,
    sshConnectionId: row.ssh_connection_id ?? undefined,
    pinned: row.pinned === 1,
    pluginId: row.plugin_id ?? undefined,
    externalChatId: row.external_chat_id ?? undefined,
    providerId: row.provider_id ?? undefined,
    modelId: row.model_id ?? undefined,
  }
}

function rowToMessage(row: MessageRow): UnifiedMessage {
  let content: string | ContentBlock[]
  try {
    content = JSON.parse(row.content)
  } catch {
    content = row.content
  }
  return {
    id: row.id,
    role: row.role as UnifiedMessage['role'],
    content,
    createdAt: row.created_at,
    usage: row.usage ? JSON.parse(row.usage) : undefined,
  }
}

function isLikelyToolErrorContent(content: ToolResultContent): boolean {
  if (typeof content !== 'string') return false
  try {
    const parsed = JSON.parse(content) as { error?: unknown } | null
    if (!parsed || typeof parsed !== 'object') return false
    const keys = Object.keys(parsed)
    return keys.length === 1 && keys[0] === 'error' && typeof parsed.error === 'string'
  } catch {
    return false
  }
}

function sanitizeToolBlocksForResend(messages: UnifiedMessage[]): {
  messages: UnifiedMessage[]
  changed: boolean
} {
  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()
  const erroredToolIds = new Set<string>()

  for (const msg of messages) {
    if (typeof msg.content === 'string') continue
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === 'tool_use') {
        toolUseIds.add(block.id)
        continue
      }
      if (block.type === 'tool_result') {
        toolResultIds.add(block.toolUseId)
        if (block.isError || isLikelyToolErrorContent(block.content)) {
          erroredToolIds.add(block.toolUseId)
        }
      }
    }
  }

  const stripIds = new Set<string>(erroredToolIds)
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) stripIds.add(id)
  }
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) stripIds.add(id)
  }

  if (stripIds.size === 0) {
    return { messages, changed: false }
  }

  let changed = false
  const sanitized = messages.flatMap((msg) => {
    if (typeof msg.content === 'string') return [msg]

    const blocks = msg.content as ContentBlock[]
    const filtered = blocks.filter((block) => {
      if (block.type === 'tool_use') return !stripIds.has(block.id)
      if (block.type === 'tool_result') return !stripIds.has(block.toolUseId)
      return true
    })

    if (filtered.length === blocks.length) {
      return [msg]
    }

    changed = true
    if (filtered.length === 0) return []
    return [{ ...msg, content: filtered }]
  })

  return { messages: sanitized, changed }
}

export const useChatStore = create<ChatStore>()(
  immer((set, get) => ({
    sessions: [],
    activeSessionId: null,
    streamingMessageId: null,
    streamingMessages: {},
    _loaded: false,

    loadSessionMessages: async (sessionId, force = false) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session) return
      const knownCount = session.messageCount ?? session.messages.length
      const shouldSkip = !force && session.messagesLoaded && knownCount <= session.messages.length
      if (shouldSkip) return
      try {
        const msgRows = (await ipcClient.invoke('db:messages:list', sessionId)) as MessageRow[]
        const messages = msgRows.map(rowToMessage)
        set((state) => {
          const target = state.sessions.find((s) => s.id === sessionId)
          if (!target) return
          target.messages = messages
          target.messagesLoaded = true
          target.messageCount = messages.length
        })
      } catch (err) {
        console.error('[ChatStore] Failed to load session messages:', err)
      }
    },

    loadFromDb: async () => {
      try {
        const sessionRows = (await ipcClient.invoke('db:sessions:list')) as SessionRow[]
        const sessions: Session[] = sessionRows.map((row) => {
          const session = rowToSession(row, [])
          if (session.messageCount === 0) {
            session.messagesLoaded = true
          }
          return session
        })
        let nextActiveSessionId: string | null = null
        set((state) => {
          state.sessions = sessions
          state._loaded = true
          nextActiveSessionId = state.activeSessionId ?? sessions[0]?.id ?? null
          state.activeSessionId = nextActiveSessionId
        })
        if (nextActiveSessionId) {
          // Restore per-session model selection to global provider store
          const activeSession = sessions.find((s) => s.id === nextActiveSessionId)
          if (activeSession?.providerId && activeSession?.modelId) {
            const providerStore = useProviderStore.getState()
            if (activeSession.providerId !== providerStore.activeProviderId) {
              providerStore.setActiveProvider(activeSession.providerId)
            }
            if (activeSession.modelId !== providerStore.activeModelId) {
              providerStore.setActiveModel(activeSession.modelId)
            }
          }
          await get().loadSessionMessages(nextActiveSessionId)
          await useTaskStore.getState().loadTasksForSession(nextActiveSessionId)
          const activePlan = usePlanStore.getState().getPlanBySession(nextActiveSessionId)
          usePlanStore.getState().setActivePlan(activePlan?.id ?? null)
        } else {
          useTaskStore.getState().clearTasks()
          usePlanStore.getState().setActivePlan(null)
        }
      } catch (err) {
        console.error('[ChatStore] Failed to load from DB:', err)
        set({ _loaded: true })
      }
    },

    createSession: (mode) => {
      const id = nanoid()
      const now = Date.now()
      const { activeProviderId, activeModelId } = useProviderStore.getState()
      const newSession: Session = {
        id,
        title: 'New Conversation',
        mode,
        messages: [],
        messageCount: 0,
        messagesLoaded: true,
        createdAt: now,
        updatedAt: now,
        providerId: activeProviderId ?? undefined,
        modelId: activeModelId || undefined,
      }
      set((state) => {
        state.sessions.push(newSession)
        state.activeSessionId = id
      })
      dbCreateSession(newSession)
      useTaskStore.getState().clearTasks()
      usePlanStore.getState().setActivePlan(null)
      if (useUIStore.getState().planMode) {
        useUIStore.getState().exitPlanMode()
      }
      return id
    },

    deleteSession: (id) => {
      let nextActiveId: string | null = null
      set((state) => {
        const idx = state.sessions.findIndex((s) => s.id === id)
        if (idx !== -1) state.sessions.splice(idx, 1)
        if (state.activeSessionId === id) {
          state.activeSessionId = state.sessions[0]?.id ?? null
        }
        nextActiveId = state.activeSessionId
        // Clean up per-session streaming state
        delete state.streamingMessages[id]
      })
      if (nextActiveId) {
        void get().loadSessionMessages(nextActiveId)
        void useTaskStore.getState().loadTasksForSession(nextActiveId)
        const activePlan = usePlanStore.getState().getPlanBySession(nextActiveId)
        usePlanStore.getState().setActivePlan(activePlan?.id ?? null)
      } else {
        useTaskStore.getState().clearTasks()
        usePlanStore.getState().setActivePlan(null)
      }
      // Clean up agent-store per-session state
      const agentState = useAgentStore.getState()
      agentState.setSessionStatus(id, null)
      agentState.clearSessionData(id)
      agentState.clearToolCalls()
      // Clean up team-store per-session state
      useTeamStore.getState().clearSessionTeam(id)
      // Clean up plan-store per-session state
      const plan = usePlanStore.getState().getPlanBySession(id)
      if (plan) usePlanStore.getState().deletePlan(plan.id)
      // Clean up task-store per-session state
      useTaskStore.getState().deleteSessionTasks(id)
      dbDeleteSession(id)
    },

    setActiveSession: (id) => {
      const prevId = get().activeSessionId
      set((state) => {
        state.activeSessionId = id
        // Sync convenience field to the new active session's streaming state
        state.streamingMessageId = id ? (state.streamingMessages[id] ?? null) : null
      })
      if (prevId !== id && useUIStore.getState().planMode) {
        useUIStore.getState().exitPlanMode()
      }
      // Switch per-session tool calls in agent-store
      useAgentStore.getState().switchToolCallSession(prevId, id)
      // Restore per-session model selection to global provider store
      if (id) {
        const session = get().sessions.find((s) => s.id === id)
        if (session?.providerId && session?.modelId) {
          const providerStore = useProviderStore.getState()
          if (session.providerId !== providerStore.activeProviderId) {
            providerStore.setActiveProvider(session.providerId)
          }
          if (session.modelId !== providerStore.activeModelId) {
            providerStore.setActiveModel(session.modelId)
          }
        }
      }
      // Load tasks for the new session
      if (id) {
        void useTaskStore.getState().loadTasksForSession(id)
        void get().loadSessionMessages(id)
        const activePlan = usePlanStore.getState().getPlanBySession(id)
        usePlanStore.getState().setActivePlan(activePlan?.id ?? null)
      } else {
        useTaskStore.getState().clearTasks()
        usePlanStore.getState().setActivePlan(null)
      }
    },

    updateSessionTitle: (id, title) => {
      const now = Date.now()
      set((state) => {
        const session = state.sessions.find((s) => s.id === id)
        if (session) {
          session.title = title
          session.updatedAt = now
        }
      })
      dbUpdateSession(id, { title, updatedAt: now })
    },

    updateSessionIcon: (id, icon) => {
      const now = Date.now()
      set((state) => {
        const session = state.sessions.find((s) => s.id === id)
        if (session) {
          session.icon = icon
          session.updatedAt = now
        }
      })
      dbUpdateSession(id, { icon, updatedAt: now })
    },

    updateSessionMode: (id, mode) => {
      const now = Date.now()
      set((state) => {
        const session = state.sessions.find((s) => s.id === id)
        if (session) {
          session.mode = mode
          session.updatedAt = now
        }
      })
      dbUpdateSession(id, { mode, updatedAt: now })
    },

    setWorkingFolder: (sessionId, folder) => {
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (session) session.workingFolder = folder
      })
      dbUpdateSession(sessionId, { workingFolder: folder })
    },

    setSshConnectionId: (sessionId, connectionId) => {
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (session) session.sshConnectionId = connectionId ?? undefined
      })
      dbUpdateSession(sessionId, { sshConnectionId: connectionId })
    },

    updateSessionModel: (sessionId, providerId, modelId) => {
      const now = Date.now()
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (session) {
          session.providerId = providerId
          session.modelId = modelId
          session.updatedAt = now
        }
      })
      dbUpdateSession(sessionId, { providerId, modelId, updatedAt: now })
    },

    togglePinSession: (sessionId) => {
      let pinned = false
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (session) {
          session.pinned = !session.pinned
          pinned = session.pinned
        }
      })
      dbUpdateSession(sessionId, { pinned })
    },

    restoreSession: (session) => {
      const normalizedSession: Session = {
        ...session,
        messageCount: session.messageCount ?? session.messages.length,
        messagesLoaded: session.messagesLoaded ?? true,
      }
      set((state) => {
        state.sessions.push(normalizedSession)
        state.activeSessionId = normalizedSession.id
      })
      dbCreateSession(normalizedSession)
      normalizedSession.messages.forEach((msg, i) => dbAddMessage(normalizedSession.id, msg, i))
      useTaskStore.getState().clearTasks()
      const activePlan = usePlanStore.getState().getPlanBySession(normalizedSession.id)
      usePlanStore.getState().setActivePlan(activePlan?.id ?? null)
    },

    clearAllSessions: () => {
      const ids = get().sessions.map((s) => s.id)
      set((state) => {
        state.sessions = []
        state.activeSessionId = null
      })
      // Clean up agent-store, team-store, plan-store, task-store for all sessions
      const agentState = useAgentStore.getState()
      const teamState = useTeamStore.getState()
      const planState = usePlanStore.getState()
      const taskState = useTaskStore.getState()
      for (const id of ids) {
        agentState.setSessionStatus(id, null)
        agentState.clearSessionData(id)
        teamState.clearSessionTeam(id)
        const plan = planState.getPlanBySession(id)
        if (plan) planState.deletePlan(plan.id)
        taskState.deleteSessionTasks(id)
      }
      agentState.clearToolCalls()
      dbClearAllSessions()
    },

    clearSessionMessages: (sessionId) => {
      const now = Date.now()
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (session) {
          session.messages = []
          session.messageCount = 0
          session.messagesLoaded = true
          session.title = 'New Conversation'
          session.updatedAt = now
        }
      })
      dbClearMessages(sessionId)
      dbUpdateSession(sessionId, { title: 'New Conversation', updatedAt: now })
      useAgentStore.getState().setSessionStatus(sessionId, null)
      useAgentStore.getState().clearSessionData(sessionId)
      useAgentStore.getState().clearToolCalls()
      useTeamStore.getState().clearSessionTeam(sessionId)
      const plan = usePlanStore.getState().getPlanBySession(sessionId)
      if (plan) usePlanStore.getState().deletePlan(plan.id)
      useTaskStore.getState().deleteSessionTasks(sessionId)
    },

    duplicateSession: async (sessionId) => {
      await get().loadSessionMessages(sessionId)
      const source = get().sessions.find((s) => s.id === sessionId)
      if (!source) return null
      const newId = nanoid()
      const now = Date.now()
      const clonedMessages: UnifiedMessage[] = JSON.parse(JSON.stringify(source.messages))
      const newSession: Session = {
        id: newId,
        title: `${source.title} (copy)`,
        icon: source.icon,
        mode: source.mode,
        messages: clonedMessages,
        messageCount: clonedMessages.length,
        messagesLoaded: true,
        createdAt: now,
        updatedAt: now,
        workingFolder: source.workingFolder,
        providerId: source.providerId,
        modelId: source.modelId,
      }
      set((state) => {
        state.sessions.push(newSession)
        state.activeSessionId = newId
      })
      dbCreateSession(newSession)
      clonedMessages.forEach((msg, i) => dbAddMessage(newId, msg, i))
      useTaskStore.getState().clearTasks()
      usePlanStore.getState().setActivePlan(null)
      return newId
    },

    removeLastAssistantMessage: (sessionId) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session || session.messages.length === 0) return null
      // Find the last assistant message, skipping trailing tool_result-only user messages
      let assistantIdx = -1
      for (let i = session.messages.length - 1; i >= 0; i--) {
        const m = session.messages[i]
        if (m.role === 'assistant') { assistantIdx = i; break }
        // Skip tool_result-only user messages (they are API-level, not real user input)
        if (m.role === 'user' && Array.isArray(m.content) && m.content.every((b) => b.type === 'tool_result')) continue
        break // hit a real user message or something else — stop
      }
      if (assistantIdx < 0) return null
      // Truncate from the assistant message onward (removes it + trailing tool_result messages)
      set((state) => {
        const s = state.sessions.find((s) => s.id === sessionId)
        if (s) {
          s.messages.splice(assistantIdx)
          s.messageCount = s.messages.length
        }
      })
      const newLen = get().sessions.find((s) => s.id === sessionId)?.messages.length ?? 0
      dbTruncateMessagesFrom(sessionId, newLen)
      // Return the last user message text for retry
      const updated = get().sessions.find((s) => s.id === sessionId)
      const lastUser = updated?.messages.findLast((m) => m.role === 'user')
      if (!lastUser) return null
      if (typeof lastUser.content === 'string') return lastUser.content
      const textBlocks = lastUser.content.filter((b) => b.type === 'text')
      return textBlocks.length > 0 ? textBlocks.map((b) => b.type === 'text' ? b.text : '').join('\n') : null
    },

    removeLastUserMessage: (sessionId) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session || session.messages.length === 0) return
      const lastMsg = session.messages[session.messages.length - 1]
      if (lastMsg.role !== 'user') return
      set((state) => {
        const s = state.sessions.find((s) => s.id === sessionId)
        if (s && s.messages.length > 0 && s.messages[s.messages.length - 1].role === 'user') {
          s.messages.pop()
          s.messageCount = s.messages.length
        }
      })
      const newLen = get().sessions.find((s) => s.id === sessionId)?.messages.length ?? 0
      dbTruncateMessagesFrom(sessionId, newLen)
    },

    truncateMessagesFrom: (sessionId, fromIndex) => {
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (session && fromIndex >= 0 && fromIndex < session.messages.length) {
          session.messages.splice(fromIndex)
          session.messageCount = session.messages.length
          session.updatedAt = Date.now()
        }
      })
      dbTruncateMessagesFrom(sessionId, fromIndex)
      dbUpdateSession(sessionId, { updatedAt: Date.now() })
    },

    replaceSessionMessages: (sessionId, messages) => {
      const now = Date.now()
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (session) {
          session.messages = messages
          session.messageCount = messages.length
          session.messagesLoaded = true
          session.updatedAt = now
        }
      })
      // Clear old DB messages and write new ones
      dbClearMessages(sessionId)
      messages.forEach((msg, i) => dbAddMessage(sessionId, msg, i))
      dbUpdateSession(sessionId, { updatedAt: now })
    },

    sanitizeToolErrorsForResend: (sessionId) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session || session.messages.length === 0) return
      const sanitized = sanitizeToolBlocksForResend(session.messages)
      if (!sanitized.changed) return
      get().replaceSessionMessages(sessionId, sanitized.messages)
    },

    stripOldSystemReminders: (sessionId) => {
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (!session || session.messages.length === 0) return

        let changed = false
        for (const msg of session.messages) {
          if (msg.role !== 'user') continue
          if (typeof msg.content === 'string') continue
          if (!Array.isArray(msg.content)) continue

          // Filter out system-reminder blocks from user messages
          const filtered = msg.content.filter((block) => {
            if (block.type === 'text' && typeof block.text === 'string') {
              return !block.text.trim().startsWith('<system-reminder>')
            }
            return true
          })

          if (filtered.length !== msg.content.length) {
            msg.content = filtered
            changed = true
          }
        }

        if (changed) {
          session.updatedAt = Date.now()
        }
      })

      // Persist changes to DB
      const session = get().sessions.find((s) => s.id === sessionId)
      if (session) {
        session.messages.forEach((msg) => {
          dbUpdateMessage(msg.id, msg.content, msg.usage)
        })
        dbUpdateSession(sessionId, { updatedAt: session.updatedAt })
      }
    },

    addMessage: (sessionId, msg) => {
      let sortOrder = 0
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (session) {
          sortOrder = session.messageCount
          if (!session.messagesLoaded) {
            session.messagesLoaded = true
            session.messages = []
          }
          session.messages.push(msg)
          session.messageCount += 1
          session.updatedAt = Date.now()
        }
      })
      dbAddMessage(sessionId, msg, sortOrder)
      dbUpdateSession(sessionId, { updatedAt: Date.now() })
    },

    updateMessage: (sessionId, msgId, patch) => {
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (!session) return
        const msg = session.messages.find((m) => m.id === msgId)
        if (msg) Object.assign(msg, patch)
      })
      // Persist updated message
      const session = get().sessions.find((s) => s.id === sessionId)
      const msg = session?.messages.find((m) => m.id === msgId)
      if (msg) dbUpdateMessage(msgId, msg.content, msg.usage)
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
      // Debounced persist for streaming
      const session = get().sessions.find((s) => s.id === sessionId)
      const msg = session?.messages.find((m) => m.id === msgId)
      const idx = session?.messages.indexOf(msg!) ?? 0
      if (msg) dbFlushMessage(sessionId, msg, idx)
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
          const cleanedThinking = stripThinkTagMarkers(thinking)
          if (!cleanedThinking) return
          msg.content = [{ type: 'thinking', thinking: cleanedThinking, startedAt: now }]
        } else {
          const blocks = msg.content as ContentBlock[]
          const cleanedThinking = stripThinkTagMarkers(thinking)
          if (!cleanedThinking) return

          // Claude interleaved-thinking may emit text between thinking deltas.
          // Continue writing into the latest unfinished thinking block instead
          // of always creating a new block.
          let targetThinkingBlock: ThinkingBlock | null = null
          for (let i = blocks.length - 1; i >= 0; i--) {
            const block = blocks[i]
            if (block.type === 'thinking' && !block.completedAt) {
              targetThinkingBlock = block as ThinkingBlock
              break
            }
          }

          if (targetThinkingBlock) {
            targetThinkingBlock.thinking = stripThinkTagMarkers(
              `${targetThinkingBlock.thinking}${cleanedThinking}`
            )
          } else {
            blocks.push({ type: 'thinking', thinking: cleanedThinking, startedAt: now })
          }
        }
      })
      // Debounced persist
      const session = get().sessions.find((s) => s.id === sessionId)
      const msg = session?.messages.find((m) => m.id === msgId)
      const idx = session?.messages.indexOf(msg!) ?? 0
      if (msg) dbFlushMessage(sessionId, msg, idx)
    },

    setThinkingEncryptedContent: (sessionId, msgId, encryptedContent, provider) => {
      if (!encryptedContent) return

      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (!session) return
        const msg = session.messages.find((m) => m.id === msgId)
        if (!msg) return

        const now = Date.now()
        if (typeof msg.content === 'string') {
          const existingText = msg.content
          msg.content = [
            {
              type: 'thinking',
              thinking: '',
              encryptedContent,
              encryptedContentProvider: provider,
              startedAt: now
            },
            ...(existingText ? [{ type: 'text' as const, text: existingText }] : [])
          ]
          return
        }

        const blocks = msg.content as ContentBlock[]
        let targetThinkingBlock: ThinkingBlock | null = null
        let providerMatchedThinkingBlock: ThinkingBlock | null = null

        for (let i = blocks.length - 1; i >= 0; i--) {
          const block = blocks[i]
          if (block.type !== 'thinking') continue

          const thinkingBlock = block as ThinkingBlock
          if (!thinkingBlock.encryptedContent) {
            targetThinkingBlock = thinkingBlock
            break
          }

          if (
            !providerMatchedThinkingBlock &&
            thinkingBlock.encryptedContentProvider === provider
          ) {
            providerMatchedThinkingBlock = thinkingBlock
          }
        }

        if (!targetThinkingBlock && providerMatchedThinkingBlock) {
          targetThinkingBlock = providerMatchedThinkingBlock
        }

        if (targetThinkingBlock) {
          targetThinkingBlock.encryptedContent = encryptedContent
          targetThinkingBlock.encryptedContentProvider = provider
        } else {
          blocks.push({
            type: 'thinking',
            thinking: '',
            encryptedContent,
            encryptedContentProvider: provider,
            startedAt: now
          })
        }
      })

      const session = get().sessions.find((s) => s.id === sessionId)
      const msg = session?.messages.find((m) => m.id === msgId)
      const idx = session?.messages.indexOf(msg!) ?? 0
      if (msg) dbFlushMessage(sessionId, msg, idx)
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
      // Immediate persist after thinking completes
      const session = get().sessions.find((s) => s.id === sessionId)
      const msg = session?.messages.find((m) => m.id === msgId)
      const idx = session?.messages.indexOf(msg!) ?? 0
      if (msg) dbFlushMessageImmediate(sessionId, msg, idx)
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
      // Persist immediately for tool use blocks
      const session = get().sessions.find((s) => s.id === sessionId)
      const msg = session?.messages.find((m) => m.id === msgId)
      const idx = session?.messages.indexOf(msg!) ?? 0
      if (msg) dbFlushMessageImmediate(sessionId, msg, idx)
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
      const session = get().sessions.find((s) => s.id === sessionId)
      const msg = session?.messages.find((m) => m.id === msgId)
      const idx = session?.messages.indexOf(msg!) ?? 0
      if (msg) dbFlushMessage(sessionId, msg, idx)
    },

    setStreamingMessageId: (sessionId, id) => set((state) => {
      if (id) {
        state.streamingMessages[sessionId] = id
      } else {
        delete state.streamingMessages[sessionId]
      }
      // Sync convenience field when updating the active session
      if (sessionId === state.activeSessionId) {
        state.streamingMessageId = id
      }
    }),

    getActiveSession: () => {
      const { sessions, activeSessionId } = get()
      return sessions.find((s) => s.id === activeSessionId)
    },

    getSessionMessages: (sessionId) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      return session?.messages ?? []
    },
  }))
)
