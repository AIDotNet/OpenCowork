import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { nanoid } from 'nanoid'
import type {
  UnifiedMessage,
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolDefinition
} from '../lib/api/types'
import { ipcClient } from '../lib/ipc/ipc-client'
import { useAgentStore } from './agent-store'
import { useTeamStore } from './team-store'
import { useTaskStore } from './task-store'
import { usePlanStore } from './plan-store'
import { useUIStore } from './ui-store'
import { useProviderStore } from './provider-store'
import { useSettingsStore } from './settings-store'
import { useInputDraftStore } from './input-draft-store'

export type SessionMode = 'chat' | 'clarify' | 'cowork' | 'code' | 'acp'

export interface SessionPromptSnapshot {
  mode: SessionMode
  planMode: boolean
  systemPrompt: string
  toolDefs: ToolDefinition[]
  projectId?: string
  workingFolder?: string
  sshConnectionId?: string | null
}

export interface Project {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  workingFolder?: string
  sshConnectionId?: string
  pluginId?: string
  pinned?: boolean
  providerId?: string
  modelId?: string
}

export interface Session {
  id: string
  title: string
  icon?: string
  mode: SessionMode
  messages: UnifiedMessage[]
  messageCount: number
  messagesLoaded: boolean
  loadedRangeStart: number
  loadedRangeEnd: number
  lastKnownMessageCount?: number
  createdAt: number
  updatedAt: number
  projectId?: string
  workingFolder?: string
  sshConnectionId?: string
  pinned?: boolean
  /** Plugin ID if this session was created by auto-reply pipeline */
  pluginId?: string
  /** Composite key: plugin:{id}:chat:{chatId} */
  externalChatId?: string
  /** Plugin chat type (p2p | group) */
  pluginChatType?: 'p2p' | 'group'
  /** Plugin sender identifiers (last known) */
  pluginSenderId?: string
  pluginSenderName?: string
  /** Bound provider ID (null = use global active provider) */
  providerId?: string
  /** Bound model ID (null = use global active model) */
  modelId?: string
  /** In-memory prompt snapshot reused within the current app session */
  promptSnapshot?: SessionPromptSnapshot
  longRunningMode?: boolean
}

// --- DB persistence helpers (fire-and-forget) ---

function dbCreateSession(s: Session): void {
  ipcClient
    .invoke('db:sessions:create', {
      id: s.id,
      title: s.title,
      icon: s.icon,
      mode: s.mode,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      projectId: s.projectId,
      workingFolder: s.workingFolder,
      sshConnectionId: s.sshConnectionId,
      pinned: s.pinned,
      providerId: s.providerId,
      modelId: s.modelId,
      longRunningMode: s.longRunningMode
    })
    .catch(() => {})
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

function dbCreateProject(project: Project): void {
  ipcClient
    .invoke('db:projects:create', {
      id: project.id,
      name: project.name,
      workingFolder: project.workingFolder,
      sshConnectionId: project.sshConnectionId,
      pluginId: project.pluginId,
      pinned: project.pinned,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt
    })
    .catch(() => {})
}

function dbUpdateProject(id: string, patch: Record<string, unknown>): void {
  ipcClient.invoke('db:projects:update', { id, patch }).catch(() => {})
}

function dbDeleteProject(id: string): void {
  ipcClient.invoke('db:projects:delete', id).catch(() => {})
}

function dbAddMessage(sessionId: string, msg: UnifiedMessage, sortOrder: number): void {
  ipcClient
    .invoke('db:messages:add', {
      id: msg.id,
      sessionId,
      role: msg.role,
      content: JSON.stringify(msg.content),
      createdAt: msg.createdAt,
      usage: msg.usage ? JSON.stringify(msg.usage) : null,
      sortOrder
    })
    .catch(() => {})
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

function dbFlushMessage(msg: UnifiedMessage): void {
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

function dbFlushMessageImmediate(msg: UnifiedMessage): void {
  const existing = _pendingFlush.get(msg.id)
  if (existing) {
    clearTimeout(existing)
    _pendingFlush.delete(msg.id)
  }
  dbUpdateMessage(msg.id, msg.content, msg.usage)
}

function clearPendingMessageFlushes(messageIds: string[]): void {
  for (const messageId of messageIds) {
    const pending = _pendingFlush.get(messageId)
    if (!pending) continue
    clearTimeout(pending)
    _pendingFlush.delete(messageId)
  }
}

// --- Store ---

interface ChatStore {
  projects: Project[]
  sessions: Session[]
  activeProjectId: string | null
  activeSessionId: string | null
  _loaded: boolean

  // Initialization
  loadFromDb: () => Promise<void>
  loadRecentSessionMessages: (sessionId: string, force?: boolean, limit?: number) => Promise<void>
  loadOlderSessionMessages: (sessionId: string, limit?: number) => Promise<number>
  loadSessionMessages: (sessionId: string, force?: boolean) => Promise<void>
  loadWindowSessionMessages: (sessionId: string, offset: number, limit: number) => Promise<void>
  getSessionMessagesForRequest: (
    sessionId: string,
    options?: { includeTrailingAssistantPlaceholder?: boolean }
  ) => Promise<UnifiedMessage[]>
  ensureDefaultProject: () => Promise<Project | null>

  // Project CRUD
  setActiveProject: (id: string | null) => void
  createProject: (
    input?: Partial<Pick<Project, 'name' | 'workingFolder' | 'sshConnectionId' | 'pluginId'>>
  ) => Promise<string>
  renameProject: (projectId: string, name: string) => void
  deleteProject: (projectId: string) => Promise<void>
  togglePinProject: (projectId: string) => void
  updateProjectDirectory: (
    projectId: string,
    patch: Partial<{
      workingFolder: string | null
      sshConnectionId: string | null
    }>
  ) => void

  // Session CRUD
  createSession: (
    mode: SessionMode,
    projectId?: string | null,
    options?: { longRunningMode?: boolean }
  ) => string
  deleteSession: (id: string) => void
  setActiveSession: (id: string | null) => void
  updateSessionTitle: (id: string, title: string) => void
  updateSessionIcon: (id: string, icon: string) => void
  updateSessionMode: (id: string, mode: SessionMode) => void
  setWorkingFolder: (sessionId: string, folder: string) => void
  setSshConnectionId: (sessionId: string, connectionId: string | null) => void
  updateSessionModel: (sessionId: string, providerId: string, modelId: string) => void
  clearSessionModelBinding: (sessionId: string) => void
  setSessionLongRunningMode: (sessionId: string, enabled: boolean) => void
  setSessionPromptSnapshot: (sessionId: string, snapshot: SessionPromptSnapshot) => void
  clearSessionPromptSnapshot: (sessionId: string) => void
  clearSessionMessages: (sessionId: string) => void
  duplicateSession: (sessionId: string) => Promise<string | null>
  togglePinSession: (sessionId: string) => void
  restoreSession: (session: Session) => void
  importSession: (session: Session, projectId?: string | null) => string
  importProjectArchive: (payload: { project: Project; sessions: Session[] }) => string
  clearAllSessions: () => void
  removeLastAssistantMessage: (sessionId: string) => boolean
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
    provider: 'anthropic' | 'openai-responses' | 'google'
  ) => void
  completeThinking: (sessionId: string, msgId: string) => void
  appendToolUse: (sessionId: string, msgId: string, toolUse: ToolUseBlock) => void
  updateToolUseInput: (
    sessionId: string,
    msgId: string,
    toolUseId: string,
    input: Record<string, unknown>
  ) => void
  appendContentBlock: (sessionId: string, msgId: string, block: ContentBlock) => void

  // Streaming state (per-session)
  streamingMessageId: string | null
  /** Per-session streaming message map — allows concurrent agents across sessions */
  streamingMessages: Record<string, string>
  setStreamingMessageId: (sessionId: string, id: string | null) => void
  /** Image generation state (per-message) - using Record instead of Set for Immer compatibility */
  generatingImageMessages: Record<string, boolean>
  setGeneratingImage: (msgId: string, generating: boolean) => void

  // Helpers
  getActiveSession: () => Session | undefined
  getSessionMessages: (sessionId: string) => UnifiedMessage[]
  releaseDormantSessions: () => void
}

interface ProjectRow {
  id: string
  name: string
  created_at: number
  updated_at: number
  working_folder: string | null
  ssh_connection_id: string | null
  plugin_id?: string | null
  pinned: number
}

interface SessionRow {
  id: string
  title: string
  icon: string | null
  mode: string
  created_at: number
  updated_at: number
  project_id?: string | null
  working_folder: string | null
  ssh_connection_id?: string | null
  pinned: number
  message_count?: number
  plugin_id?: string | null
  external_chat_id?: string | null
  provider_id?: string | null
  model_id?: string | null
  long_running_mode?: number | null
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

const RECENT_SESSION_MESSAGE_PAGE_SIZE = 160
const MIN_INITIAL_SESSION_MESSAGE_PAGE_SIZE = 5
const MESSAGE_WINDOW_MAX_SIZE = 240
const MESSAGE_WINDOW_TAIL_PRESERVE = 80

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    workingFolder: row.working_folder ?? undefined,
    sshConnectionId: row.ssh_connection_id ?? undefined,
    pluginId: row.plugin_id ?? undefined,
    pinned: row.pinned === 1
  }
}

function rowToSession(row: SessionRow, messages: UnifiedMessage[] = []): Session {
  const messageCount = row.message_count ?? messages.length
  const loadedRangeEnd = messages.length > 0 ? messageCount : 0
  const loadedRangeStart = Math.max(0, loadedRangeEnd - messages.length)
  return {
    id: row.id,
    title: row.title,
    icon: row.icon ?? undefined,
    mode: row.mode as SessionMode,
    messages,
    messageCount,
    messagesLoaded: messages.length > 0 || messageCount === 0,
    loadedRangeStart,
    loadedRangeEnd,
    lastKnownMessageCount: messageCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    projectId: row.project_id ?? undefined,
    workingFolder: row.working_folder ?? undefined,
    sshConnectionId: row.ssh_connection_id ?? undefined,
    pinned: row.pinned === 1,
    pluginId: row.plugin_id ?? undefined,
    externalChatId: row.external_chat_id ?? undefined,
    providerId: row.provider_id ?? undefined,
    modelId: row.model_id ?? undefined,
    longRunningMode: row.long_running_mode === 1
  }
}

function rowToMessage(row: MessageRow): UnifiedMessage {
  let content: string | ContentBlock[]
  try {
    const parsed = JSON.parse(row.content)
    if (typeof parsed === 'string' || Array.isArray(parsed)) {
      content = parsed
    } else if (parsed == null) {
      content = ''
    } else {
      content = row.content
    }
  } catch {
    content = row.content
  }
  return {
    id: row.id,
    role: row.role as UnifiedMessage['role'],
    content,
    createdAt: row.created_at,
    usage: row.usage ? JSON.parse(row.usage) : undefined
  }
}

function cloneImportedMessages(messages: UnifiedMessage[] | undefined): UnifiedMessage[] {
  const source = Array.isArray(messages) ? messages : []
  const cloned = JSON.parse(JSON.stringify(source)) as UnifiedMessage[]
  return cloned.map((message) => ({
    ...message,
    id: nanoid()
  }))
}

function trimSessionMessageWindow(session: Session): void {
  if (session.messages.length <= MESSAGE_WINDOW_MAX_SIZE) return
  const removableCount = session.messages.length - MESSAGE_WINDOW_MAX_SIZE
  const maxRemovable = Math.max(0, session.messages.length - MESSAGE_WINDOW_TAIL_PRESERVE)
  const trimCount = Math.min(removableCount, maxRemovable)
  if (trimCount <= 0) return
  session.messages.splice(0, trimCount)
  session.loadedRangeStart = Math.min(session.messageCount, session.loadedRangeStart + trimCount)
}

function getResidentSessionIds(state: Pick<ChatStore, 'activeSessionId' | 'streamingMessages'>): Set<string> {
  const residentSessionIds = new Set<string>()
  if (state.activeSessionId) {
    residentSessionIds.add(state.activeSessionId)
  }

  const uiState = useUIStore.getState()
  if (uiState.miniSessionWindowOpen && uiState.miniSessionWindowSessionId) {
    residentSessionIds.add(uiState.miniSessionWindowSessionId)
  }

  for (const sessionId of Object.keys(state.streamingMessages)) {
    residentSessionIds.add(sessionId)
  }

  return residentSessionIds
}

function releaseDormantSessionMemory(
  state: Pick<ChatStore, 'sessions' | 'activeSessionId' | 'streamingMessages' | 'generatingImageMessages'>
): void {
  const residentSessionIds = getResidentSessionIds(state)
  const releasedMessageIds = new Set<string>()
  useAgentStore.getState().releaseDormantSessionData([...residentSessionIds])
  usePlanStore.getState().releaseDormantPlans(state.activeSessionId)
  useTaskStore.getState().releaseDormantSessionTasks([...residentSessionIds])
  useUIStore.getState().releaseDormantSessionUiState(state.activeSessionId)

  for (const session of state.sessions) {
    if (residentSessionIds.has(session.id)) continue

    delete session.promptSnapshot

    if (state.streamingMessages[session.id]) continue
    if (!session.messagesLoaded && session.messages.length === 0) continue

    for (const message of session.messages) {
      releasedMessageIds.add(message.id)
    }

    session.lastKnownMessageCount = session.messageCount
    session.messagesLoaded = false
    session.messages = []
    session.loadedRangeStart = session.messageCount
    session.loadedRangeEnd = session.messageCount
  }

  if (releasedMessageIds.size === 0) return

  for (const messageId of Object.keys(state.generatingImageMessages)) {
    if (releasedMessageIds.has(messageId)) {
      delete state.generatingImageMessages[messageId]
    }
  }
}

function sanitizeToolBlocksForResend(messages: UnifiedMessage[]): {
  messages: UnifiedMessage[]
  changed: boolean
} {
  if (messages.length === 0) {
    return { messages, changed: false }
  }

  const trimmedMessages = [...messages]
  let trimmedChanged = false
  while (trimmedMessages.length > 0) {
    const lastMessage = trimmedMessages[trimmedMessages.length - 1]
    if (lastMessage.role !== 'assistant' || !Array.isArray(lastMessage.content)) break

    const filteredBlocks = lastMessage.content.filter((block) => block.type !== 'agent_error')
    if (filteredBlocks.length === lastMessage.content.length) break

    trimmedChanged = true
    if (filteredBlocks.length === 0) {
      trimmedMessages.pop()
    } else {
      trimmedMessages[trimmedMessages.length - 1] = { ...lastMessage, content: filteredBlocks }
      break
    }
  }

  messages = trimmedMessages

  let tailStart = messages.length
  while (tailStart > 0) {
    const message = messages[tailStart - 1]
    if (
      message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.every((block) => block.type === 'tool_result')
    ) {
      tailStart -= 1
      continue
    }
    break
  }

  if (tailStart === 0) {
    return { messages, changed: false }
  }

  const assistantIndex = tailStart - 1
  const assistantMessage = messages[assistantIndex]
  if (assistantMessage.role !== 'assistant' || !Array.isArray(assistantMessage.content)) {
    return { messages, changed: false }
  }

  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()

  for (const block of assistantMessage.content as ContentBlock[]) {
    if (block.type === 'tool_use') {
      toolUseIds.add(block.id)
    }
  }

  for (let index = assistantIndex + 1; index < messages.length; index += 1) {
    const message = messages[index]
    if (
      message.role !== 'user' ||
      !Array.isArray(message.content) ||
      !message.content.every((block) => block.type === 'tool_result')
    ) {
      return { messages, changed: false }
    }

    for (const block of message.content as ContentBlock[]) {
      if (block.type !== 'tool_result') continue
      toolResultIds.add(block.toolUseId)
    }
  }

  const stripIds = new Set<string>()
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) stripIds.add(id)
  }
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) stripIds.add(id)
  }

  if (stripIds.size === 0) {
    return { messages, changed: trimmedChanged }
  }

  const strippedWriteToolUseIds = [...stripIds].filter((id) => {
    const block = (assistantMessage.content as ContentBlock[]).find(
      (item) => item.type === 'tool_use' && item.id === id
    )
    return block?.type === 'tool_use' && block.name === 'Write'
  })
  if (strippedWriteToolUseIds.length > 0) {
    console.log('[WriteTrace] sanitizeToolErrorsForResend stripping write tool blocks', {
      assistantIndex,
      stripIds: [...stripIds],
      strippedWriteToolUseIds,
      toolUseIds: [...toolUseIds],
      toolResultIds: [...toolResultIds],
      tailMessageCount: messages.length - assistantIndex
    })
  }

  let changed = false
  const nextMessages = [...messages]
  const filteredAssistantBlocks = (assistantMessage.content as ContentBlock[]).filter((block) => {
    if (block.type === 'tool_use') return !stripIds.has(block.id)
    return true
  })

  if (filteredAssistantBlocks.length !== assistantMessage.content.length) {
    changed = true
    if (filteredAssistantBlocks.length === 0) {
      nextMessages.splice(assistantIndex, 1)
    } else {
      nextMessages[assistantIndex] = { ...assistantMessage, content: filteredAssistantBlocks }
    }
  }

  const resultMessageIndexesToRemove: number[] = []
  for (let index = assistantIndex + 1; index < nextMessages.length; index += 1) {
    const message = nextMessages[index]
    if (
      message.role !== 'user' ||
      !Array.isArray(message.content) ||
      !message.content.every((block) => block.type === 'tool_result')
    ) {
      break
    }

    const filteredBlocks = (message.content as ContentBlock[]).filter(
      (block) => block.type !== 'tool_result' || !stripIds.has(block.toolUseId)
    )

    if (filteredBlocks.length !== message.content.length) {
      changed = true
      if (filteredBlocks.length === 0) {
        resultMessageIndexesToRemove.push(index)
      } else {
        nextMessages[index] = { ...message, content: filteredBlocks }
      }
    }
  }

  for (let i = resultMessageIndexesToRemove.length - 1; i >= 0; i -= 1) {
    nextMessages.splice(resultMessageIndexesToRemove[i], 1)
  }

  return changed || trimmedChanged
    ? { messages: nextMessages, changed: true }
    : { messages, changed: false }
}

export const useChatStore = create<ChatStore>()(
  immer((set, get) => ({
    projects: [],
    sessions: [],
    activeProjectId: null,
    activeSessionId: null,
    streamingMessageId: null,
    streamingMessages: {},
    generatingImageMessages: {},
    _loaded: false,

    ensureDefaultProject: async () => {
      try {
        const row = (await ipcClient.invoke('db:projects:ensure-default')) as ProjectRow | null
        if (!row) return null
        const project = rowToProject(row)
        set((state) => {
          const existing = state.projects.find((item) => item.id === project.id)
          if (existing) {
            Object.assign(existing, project)
          } else {
            state.projects.unshift(project)
          }
          if (!state.activeProjectId) {
            state.activeProjectId = project.id
          }
        })
        return project
      } catch (err) {
        console.error('[ChatStore] Failed to ensure default project:', err)
        return null
      }
    },

    setActiveProject: (id) => {
      let nextSessionId: string | null = null
      set((state) => {
        state.activeProjectId = id
        if (!id) {
          state.activeSessionId = null
          return
        }
        const currentSession = state.sessions.find((s) => s.id === state.activeSessionId)
        if (currentSession?.projectId === id) return
        const sessionsInProject = state.sessions
          .filter((s) => s.projectId === id)
          .sort((a, b) => b.updatedAt - a.updatedAt)
        nextSessionId = sessionsInProject[0]?.id ?? null
        state.activeSessionId = nextSessionId
      })
      useUIStore.getState().syncSessionScopedState(nextSessionId)
      get().releaseDormantSessions()
      if (nextSessionId) {
        void get()
          .loadRecentSessionMessages(nextSessionId)
          .finally(() => get().releaseDormantSessions())
        void usePlanStore
          .getState()
          .loadPlanForSession(nextSessionId)
          .then((plan) => {
            const planStore = usePlanStore.getState()
            if (useChatStore.getState().activeSessionId === nextSessionId) {
              planStore.setActivePlan(plan?.id ?? null)
            }
          })
      } else {
        usePlanStore.getState().setActivePlan(null)
      }
    },

    createProject: async (input) => {
      const now = Date.now()
      const payload = {
        id: nanoid(),
        name: input?.name ?? 'New Project',
        workingFolder: input?.workingFolder ?? null,
        sshConnectionId: input?.sshConnectionId ?? null,
        pluginId: input?.pluginId ?? null,
        pinned: false,
        createdAt: now,
        updatedAt: now
      }

      try {
        const row = (await ipcClient.invoke('db:projects:create', payload)) as ProjectRow
        const project = rowToProject(row)
        set((state) => {
          state.projects.unshift(project)
          state.activeProjectId = project.id
        })
        return project.id
      } catch (err) {
        console.error('[ChatStore] Failed to create project:', err)
        const fallbackProject: Project = {
          id: payload.id,
          name: payload.name,
          createdAt: now,
          updatedAt: now,
          workingFolder: payload.workingFolder ?? undefined,
          sshConnectionId: payload.sshConnectionId ?? undefined,
          pluginId: payload.pluginId ?? undefined,
          pinned: false
        }
        set((state) => {
          state.projects.unshift(fallbackProject)
          state.activeProjectId = fallbackProject.id
        })
        dbCreateProject(fallbackProject)
        return fallbackProject.id
      }
    },

    renameProject: (projectId, name) => {
      const nextName = name.trim()
      if (!nextName) return
      const now = Date.now()

      set((state) => {
        const project = state.projects.find((item) => item.id === projectId)
        if (!project) return
        project.name = nextName
        project.updatedAt = now
      })

      dbUpdateProject(projectId, {
        name: nextName,
        updatedAt: now
      })
    },

    deleteProject: async (projectId) => {
      const localSessions = get().sessions.filter((session) => session.projectId === projectId)
      const localSessionIds = localSessions.map((session) => session.id)
      const deletedMessageIds = localSessions.flatMap((session) =>
        session.messages.map((message) => message.id)
      )

      let deletedSessionIds = localSessionIds
      try {
        const result = (await ipcClient.invoke('db:projects:delete', projectId)) as {
          projectId: string
          sessionIds: string[]
        } | null
        if (result?.sessionIds) {
          deletedSessionIds = Array.from(new Set([...localSessionIds, ...result.sessionIds]))
        }
      } catch (err) {
        console.error('[ChatStore] Failed to delete project from DB:', err)
        for (const sessionId of localSessionIds) {
          dbDeleteSession(sessionId)
        }
        dbDeleteProject(projectId)
      }

      let nextActiveSessionId: string | null = null
      let shouldEnsureDefaultProject = false
      const deletedSet = new Set(deletedSessionIds)

      set((state) => {
        state.projects = state.projects.filter((project) => project.id !== projectId)

        state.sessions = state.sessions.filter((session) => {
          const shouldDelete = deletedSet.has(session.id) || session.projectId === projectId
          if (shouldDelete) {
            delete state.streamingMessages[session.id]
          }
          return !shouldDelete
        })

        if (
          state.activeSessionId &&
          !state.sessions.some((session) => session.id === state.activeSessionId)
        ) {
          state.activeSessionId = state.sessions[0]?.id ?? null
        }

        nextActiveSessionId = state.activeSessionId
        const activeSession = state.sessions.find((session) => session.id === nextActiveSessionId)

        if (activeSession?.projectId) {
          state.activeProjectId = activeSession.projectId
        } else if (
          state.activeProjectId === projectId ||
          !state.projects.some((project) => project.id === state.activeProjectId)
        ) {
          state.activeProjectId =
            state.projects.find((project) => !project.pluginId)?.id ?? state.projects[0]?.id ?? null
        }

        shouldEnsureDefaultProject = state.projects.length === 0
      })

      const agentState = useAgentStore.getState()
      const teamState = useTeamStore.getState()
      const planState = usePlanStore.getState()
      const taskState = useTaskStore.getState()

      for (const sessionId of deletedSessionIds) {
        agentState.setSessionStatus(sessionId, null)
        agentState.clearSessionData(sessionId)
        teamState.clearSessionTeam(sessionId)
        const plan = planState.getPlanBySession(sessionId)
        if (plan) {
          planState.deletePlan(plan.id)
        }
        taskState.deleteSessionTasks(sessionId)
        useInputDraftStore.getState().removeSessionDraft(sessionId)
      }
      clearPendingMessageFlushes(deletedMessageIds)
      agentState.clearToolCalls()

      if (nextActiveSessionId) {
        await get().loadSessionMessages(nextActiveSessionId)
        await useTaskStore.getState().loadTasksForSession(nextActiveSessionId)
        const activePlan = usePlanStore.getState().getPlanBySession(nextActiveSessionId)
        usePlanStore.getState().setActivePlan(activePlan?.id ?? null)
      } else {
        useTaskStore.getState().clearTasks()
        usePlanStore.getState().setActivePlan(null)
      }
      useUIStore.getState().syncSessionScopedState(nextActiveSessionId)

      if (shouldEnsureDefaultProject) {
        await get().ensureDefaultProject()
      }
    },

    togglePinProject: (projectId) => {
      const now = Date.now()
      let pinned = false

      set((state) => {
        const project = state.projects.find((item) => item.id === projectId)
        if (!project) return
        project.pinned = !project.pinned
        project.updatedAt = now
        pinned = !!project.pinned
      })

      dbUpdateProject(projectId, {
        pinned,
        updatedAt: now
      })
    },

    updateProjectDirectory: (projectId, patch) => {
      const now = Date.now()
      const current = get().projects.find((project) => project.id === projectId)
      if (!current) return

      const nextWorkingFolder =
        patch.workingFolder !== undefined
          ? (patch.workingFolder ?? undefined)
          : current.workingFolder
      const nextSshConnectionId =
        patch.sshConnectionId !== undefined
          ? (patch.sshConnectionId ?? undefined)
          : current.sshConnectionId

      if (nextWorkingFolder) {
        useSettingsStore.getState().pushRecentWorkingTarget({
          workingFolder: nextWorkingFolder,
          sshConnectionId: nextSshConnectionId ?? null
        })
      }

      if (
        nextWorkingFolder === current.workingFolder &&
        nextSshConnectionId === current.sshConnectionId
      ) {
        return
      }

      const affectedSessionIds = get()
        .sessions.filter((session) => session.projectId === projectId)
        .map((session) => session.id)

      set((state) => {
        const project = state.projects.find((item) => item.id === projectId)
        if (project) {
          project.workingFolder = nextWorkingFolder
          project.sshConnectionId = nextSshConnectionId
          project.updatedAt = now
        }

        for (const session of state.sessions) {
          if (session.projectId !== projectId) continue
          session.workingFolder = nextWorkingFolder
          session.sshConnectionId = nextSshConnectionId
          delete session.promptSnapshot
          session.updatedAt = now
        }
      })

      dbUpdateProject(projectId, {
        workingFolder: nextWorkingFolder ?? null,
        sshConnectionId: nextSshConnectionId ?? null,
        updatedAt: now
      })

      for (const sessionId of affectedSessionIds) {
        dbUpdateSession(sessionId, {
          workingFolder: nextWorkingFolder ?? null,
          sshConnectionId: nextSshConnectionId ?? null,
          updatedAt: now
        })
      }
    },

    loadRecentSessionMessages: async (sessionId, force = false, limit) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session) return
      const knownCount = session.messageCount ?? session.messages.length
      const requestedLimit = Math.max(
        MIN_INITIAL_SESSION_MESSAGE_PAGE_SIZE,
        Math.min(limit ?? MIN_INITIAL_SESSION_MESSAGE_PAGE_SIZE, knownCount || MIN_INITIAL_SESSION_MESSAGE_PAGE_SIZE)
      )
      if (!force && session.messagesLoaded && session.messages.length > 0) {
        const loadedAtTail = session.loadedRangeEnd === knownCount
        if (loadedAtTail && session.messages.length >= requestedLimit) return
      }
      if (knownCount === 0) {
        set((state) => {
          const target = state.sessions.find((s) => s.id === sessionId)
          if (!target) return
          target.messages = []
          target.messagesLoaded = true
          target.messageCount = 0
          target.loadedRangeStart = 0
          target.loadedRangeEnd = 0
          target.lastKnownMessageCount = 0
        })
        return
      }
      try {
        const nextLimit = Math.max(
          MIN_INITIAL_SESSION_MESSAGE_PAGE_SIZE,
          Math.min(limit ?? RECENT_SESSION_MESSAGE_PAGE_SIZE, knownCount)
        )
        const offset = Math.max(0, knownCount - nextLimit)
        const msgRows = (await ipcClient.invoke('db:messages:list-page', {
          sessionId,
          limit: nextLimit,
          offset
        })) as MessageRow[]
        const messages = msgRows.map(rowToMessage)
        set((state) => {
          const target = state.sessions.find((s) => s.id === sessionId)
          if (!target) return
          target.messages = messages
          target.messagesLoaded = true
          target.messageCount = knownCount
          target.loadedRangeStart = offset
          target.loadedRangeEnd = offset + messages.length
          target.lastKnownMessageCount = knownCount
        })
      } catch (err) {
        console.error('[ChatStore] Failed to load recent session messages:', err)
      }
    },

    loadOlderSessionMessages: async (sessionId, limit = RECENT_SESSION_MESSAGE_PAGE_SIZE) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session) return 0
      if (!session.messagesLoaded) {
        await get().loadRecentSessionMessages(sessionId)
      }
      const latest = get().sessions.find((s) => s.id === sessionId)
      if (!latest) return 0
      const olderCount = Math.max(0, latest.loadedRangeStart)
      if (olderCount === 0) return 0
      const nextCount = Math.min(limit, olderCount)
      const offset = olderCount - nextCount
      try {
        const msgRows = (await ipcClient.invoke('db:messages:list-page', {
          sessionId,
          limit: nextCount,
          offset
        })) as MessageRow[]
        const olderMessages = msgRows.map(rowToMessage)
        if (olderMessages.length === 0) return 0
        set((state) => {
          const target = state.sessions.find((s) => s.id === sessionId)
          if (!target) return
          const existingIds = new Set(target.messages.map((message) => message.id))
          const merged = olderMessages.filter((message) => !existingIds.has(message.id))
          if (merged.length === 0) return
          target.messages = [...merged, ...target.messages]
          target.messagesLoaded = true
          target.loadedRangeStart = offset
          target.loadedRangeEnd = Math.max(target.loadedRangeEnd, offset + target.messages.length)
          target.lastKnownMessageCount = target.messageCount
        })
        return olderMessages.length
      } catch (err) {
        console.error('[ChatStore] Failed to load older session messages:', err)
        return 0
      }
    },

    loadSessionMessages: async (sessionId, force = false) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session) return
      const knownCount = session.messageCount ?? session.messages.length
      const shouldSkip =
        !force && session.messagesLoaded && session.loadedRangeStart === 0 && knownCount <= session.messages.length
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
          target.loadedRangeStart = 0
          target.loadedRangeEnd = messages.length
          target.lastKnownMessageCount = messages.length
        })
      } catch (err) {
        console.error('[ChatStore] Failed to load session messages:', err)
      }
    },

    loadWindowSessionMessages: async (sessionId, offset, limit) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session) return
      const safeOffset = Math.max(0, offset)
      const safeLimit = Math.max(MIN_INITIAL_SESSION_MESSAGE_PAGE_SIZE, limit)
      try {
        const msgRows = (await ipcClient.invoke('db:messages:list-page', {
          sessionId,
          limit: safeLimit,
          offset: safeOffset
        })) as MessageRow[]
        const messages = msgRows.map(rowToMessage)
        set((state) => {
          const target = state.sessions.find((s) => s.id === sessionId)
          if (!target) return
          target.messages = messages
          target.messagesLoaded = true
          target.loadedRangeStart = safeOffset
          target.loadedRangeEnd = safeOffset + messages.length
          target.lastKnownMessageCount = target.messageCount
        })
      } catch (err) {
        console.error('[ChatStore] Failed to load window session messages:', err)
      }
    },

    getSessionMessagesForRequest: async (sessionId, options) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session) return []
      const includeTrailingAssistantPlaceholder = options?.includeTrailingAssistantPlaceholder ?? true
      const hasFullHistory =
        session.messagesLoaded &&
        session.loadedRangeStart === 0 &&
        session.loadedRangeEnd >= session.messageCount

      let messages = hasFullHistory
        ? session.messages
        : ((await ipcClient.invoke('db:messages:list', sessionId)) as MessageRow[]).map(rowToMessage)

      if (!includeTrailingAssistantPlaceholder) {
        messages = messages.filter((message, index) => {
          if (index !== messages.length - 1 || message.role !== 'assistant') return true
          if (typeof message.content === 'string') return message.content.trim().length > 0
          return Array.isArray(message.content) ? message.content.length > 0 : true
        })
      }

      return messages
    },

    loadFromDb: async () => {
      try {
        const projectRows = (await ipcClient.invoke('db:projects:list')) as ProjectRow[]
        let projects = projectRows.map(rowToProject)

        if (projects.length === 0) {
          const ensured = await get().ensureDefaultProject()
          projects = ensured ? [ensured] : []
        }

        const projectMap = new Map(projects.map((project) => [project.id, project]))
        const fallbackProject = projects.find((project) => !project.pluginId) ?? projects[0]

        const sessionRows = (await ipcClient.invoke('db:sessions:list')) as SessionRow[]
        const sessions: Session[] = sessionRows.map((row) => {
          const session = rowToSession(row, [])
          if (!session.projectId && fallbackProject) {
            session.projectId = fallbackProject.id
          }
          if (session.projectId) {
            const project = projectMap.get(session.projectId)
            if (project) {
              session.workingFolder = project.workingFolder
              session.sshConnectionId = project.sshConnectionId
            }
          }
          if (session.messageCount === 0) {
            session.messagesLoaded = true
            session.loadedRangeStart = 0
            session.loadedRangeEnd = 0
            session.lastKnownMessageCount = 0
          }
          return session
        })

        let nextActiveSessionId: string | null = null
        let nextActiveProjectId: string | null = null

        set((state) => {
          state.projects = projects
          state.sessions = sessions
          state._loaded = true

          nextActiveSessionId = state.activeSessionId ?? sessions[0]?.id ?? null
          state.activeSessionId = nextActiveSessionId

          const activeSession = sessions.find((session) => session.id === nextActiveSessionId)
          const preferredProjectId = activeSession?.projectId
          nextActiveProjectId =
            preferredProjectId ??
            state.activeProjectId ??
            projects.find((project) => !project.pluginId)?.id ??
            projects[0]?.id ??
            null
          state.activeProjectId = nextActiveProjectId
        })

        if (nextActiveSessionId) {
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
          await get().loadRecentSessionMessages(nextActiveSessionId)
          await useTaskStore.getState().loadTasksForSession(nextActiveSessionId)
          const planStore = usePlanStore.getState()
          const activePlan = await planStore.loadPlanForSession(nextActiveSessionId)
          planStore.setActivePlan(activePlan?.id ?? null)
        } else {
          useTaskStore.getState().clearTasks()
          usePlanStore.getState().setActivePlan(null)
        }
        useUIStore.getState().syncSessionScopedState(nextActiveSessionId)
        get().releaseDormantSessions()
      } catch (err) {
        console.error('[ChatStore] Failed to load from DB:', err)
        set({ _loaded: true })
      }
    },

    createSession: (mode, projectId, options) => {
      const id = nanoid()
      const now = Date.now()
      const { activeProviderId, activeModelId } = useProviderStore.getState()
      const { newSessionDefaultModel } = useSettingsStore.getState()

      let targetProjectId =
        projectId ??
        get().activeProjectId ??
        get().projects.find((project) => !project.pluginId)?.id ??
        get().projects[0]?.id ??
        null

      const targetProject = get().projects.find((project) => project.id === targetProjectId)

      if (targetProject) {
        targetProjectId = targetProject.id
      }

      const followGlobalModel =
        !targetProject?.providerId && newSessionDefaultModel?.useGlobalActiveModel !== false
      const sessionProviderId = targetProject?.providerId
        ? targetProject.providerId
        : followGlobalModel
          ? undefined
          : (newSessionDefaultModel?.providerId ?? activeProviderId ?? undefined)
      const sessionModelId = targetProject?.providerId
        ? targetProject.modelId
        : followGlobalModel
          ? undefined
          : newSessionDefaultModel?.modelId || activeModelId || undefined

      const newSession: Session = {
        id,
        title: 'New Conversation',
        mode,
        messages: [],
        messageCount: 0,
        messagesLoaded: true,
        loadedRangeStart: 0,
        loadedRangeEnd: 0,
        lastKnownMessageCount: 0,
        createdAt: now,
        updatedAt: now,
        projectId: targetProjectId ?? undefined,
        workingFolder: targetProject?.workingFolder,
        sshConnectionId: targetProject?.sshConnectionId,
        providerId: sessionProviderId,
        modelId: sessionModelId,
        longRunningMode: options?.longRunningMode ?? false
      }
      set((state) => {
        state.sessions.push(newSession)
        state.activeSessionId = id
        if (targetProjectId) {
          state.activeProjectId = targetProjectId
        }
      })
      dbCreateSession(newSession)
      if (!targetProjectId) {
        void get()
          .ensureDefaultProject()
          .then((project) => {
            if (!project) return
            set((state) => {
              const session = state.sessions.find((item) => item.id === id)
              if (!session || session.projectId) return
              session.projectId = project.id
              session.workingFolder = project.workingFolder
              session.sshConnectionId = project.sshConnectionId
              state.activeProjectId = project.id
            })
            dbUpdateSession(id, {
              projectId: project.id,
              workingFolder: project.workingFolder ?? null,
              sshConnectionId: project.sshConnectionId ?? null
            })
          })
      }
      useTaskStore.getState().clearTasks()
      usePlanStore.getState().setActivePlan(null)
      useUIStore.getState().syncSessionScopedState(id)
      get().releaseDormantSessions()
      return id
    },

    deleteSession: (id) => {
      const deletedSession = get().sessions.find((session) => session.id === id)
      const wasActiveSession = get().activeSessionId === id
      const fallbackProjectId = deletedSession?.projectId ?? get().activeProjectId ?? null
      const fallbackMode = deletedSession?.mode ?? 'chat'
      let nextActiveId: string | null = null
      let shouldCreateReplacementSession = false

      set((state) => {
        const idx = state.sessions.findIndex((s) => s.id === id)
        const deletedSessionInState = idx >= 0 ? state.sessions[idx] : undefined
        const deletedProjectId = deletedSessionInState?.projectId ?? fallbackProjectId
        if (idx !== -1) state.sessions.splice(idx, 1)

        if (wasActiveSession) {
          const sameProjectSessions = deletedProjectId
            ? state.sessions
                .filter((session) => session.projectId === deletedProjectId)
                .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
            : []

          state.activeSessionId = sameProjectSessions[0]?.id ?? null
          if (deletedProjectId) {
            state.activeProjectId = deletedProjectId
          }
          if (!state.activeSessionId) {
            shouldCreateReplacementSession = true
          }
        }

        nextActiveId = state.activeSessionId
        delete state.streamingMessages[id]
      })

      const agentState = useAgentStore.getState()
      agentState.setSessionStatus(id, null)
      agentState.clearSessionData(id)
      agentState.clearToolCalls()
      useTeamStore.getState().clearSessionTeam(id)
      const plan = usePlanStore.getState().getPlanBySession(id)
      if (plan) usePlanStore.getState().deletePlan(plan.id)
      useTaskStore.getState().deleteSessionTasks(id)
      useInputDraftStore.getState().removeSessionDraft(id)
      clearPendingMessageFlushes(deletedSession?.messages.map((message) => message.id) ?? [])
      dbDeleteSession(id)

      if (shouldCreateReplacementSession) {
        nextActiveId = get().createSession(fallbackMode, fallbackProjectId ?? undefined)
      }

      if (nextActiveId) {
        void get()
          .loadRecentSessionMessages(nextActiveId)
          .finally(() => get().releaseDormantSessions())
        void useTaskStore.getState().loadTasksForSession(nextActiveId)
        const planStore = usePlanStore.getState()
        void planStore.loadPlanForSession(nextActiveId).then((loadedPlan) => {
          if (useChatStore.getState().activeSessionId !== nextActiveId) return
          usePlanStore.getState().setActivePlan(loadedPlan?.id ?? null)
        })
      } else {
        useTaskStore.getState().clearTasks()
        usePlanStore.getState().setActivePlan(null)
      }
      useUIStore.getState().syncSessionScopedState(nextActiveId)
      get().releaseDormantSessions()
    },

    setActiveSession: (id) => {
      const prevId = get().activeSessionId
      set((state) => {
        state.activeSessionId = id
        const activeSession = state.sessions.find((session) => session.id === id)
        if (activeSession?.projectId) {
          state.activeProjectId = activeSession.projectId
        }
        state.streamingMessageId = id ? (state.streamingMessages[id] ?? null) : null
      })
      useUIStore.getState().syncSessionScopedState(id)
      get().releaseDormantSessions()
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
        void get()
          .loadRecentSessionMessages(id)
          .finally(() => get().releaseDormantSessions())
        const planStore = usePlanStore.getState()
        const activePlan = planStore.getPlanBySession(id)
        planStore.setActivePlan(activePlan?.id ?? null)
        void planStore.loadPlanForSession(id).then((loadedPlan) => {
          if (useChatStore.getState().activeSessionId !== id) return
          usePlanStore.getState().setActivePlan(loadedPlan?.id ?? activePlan?.id ?? null)
        })
      } else {
        useTaskStore.getState().clearTasks()
        usePlanStore.getState().setActivePlan(null)
        usePlanStore.getState().releaseDormantPlans(null)
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
          const shouldClearPromptSnapshot =
            session.mode !== mode ||
            (session.mode === 'chat') !== (mode === 'chat') ||
            (session.mode === 'acp') !== (mode === 'acp')
          session.mode = mode
          if (shouldClearPromptSnapshot) {
            delete session.promptSnapshot
          }
          session.updatedAt = now
        }
      })
      dbUpdateSession(id, { mode, updatedAt: now })
    },

    setWorkingFolder: (sessionId, folder) => {
      const session = get().sessions.find((item) => item.id === sessionId)
      if (!session) return
      if (session.projectId) {
        get().updateProjectDirectory(session.projectId, { workingFolder: folder })
        get().clearSessionPromptSnapshot(sessionId)
        return
      }

      set((state) => {
        const target = state.sessions.find((item) => item.id === sessionId)
        if (target) {
          target.workingFolder = folder
          delete target.promptSnapshot
        }
      })
      dbUpdateSession(sessionId, { workingFolder: folder })
    },

    setSshConnectionId: (sessionId, connectionId) => {
      const session = get().sessions.find((item) => item.id === sessionId)
      if (!session) return
      if (session.projectId) {
        get().updateProjectDirectory(session.projectId, {
          sshConnectionId: connectionId
        })
        get().clearSessionPromptSnapshot(sessionId)
        return
      }

      set((state) => {
        const target = state.sessions.find((item) => item.id === sessionId)
        if (target) {
          target.sshConnectionId = connectionId ?? undefined
          delete target.promptSnapshot
        }
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
          delete session.promptSnapshot
          session.updatedAt = now
        }
      })
      dbUpdateSession(sessionId, { providerId, modelId, updatedAt: now })
    },

    clearSessionModelBinding: (sessionId) => {
      const now = Date.now()
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (session) {
          delete session.providerId
          delete session.modelId
          delete session.promptSnapshot
          session.updatedAt = now
        }
      })
      dbUpdateSession(sessionId, { providerId: null, modelId: null, updatedAt: now })
    },

    setSessionLongRunningMode: (sessionId, enabled) => {
      const now = Date.now()
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (session) {
          session.longRunningMode = enabled
          delete session.promptSnapshot
          session.updatedAt = now
        }
      })
      dbUpdateSession(sessionId, { longRunningMode: enabled, updatedAt: now })
    },

    setSessionPromptSnapshot: (sessionId, snapshot) => {
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (!session) return
        session.promptSnapshot = {
          mode: snapshot.mode,
          planMode: snapshot.planMode,
          systemPrompt: snapshot.systemPrompt,
          toolDefs: snapshot.toolDefs.slice(),
          projectId: snapshot.projectId,
          workingFolder: snapshot.workingFolder,
          sshConnectionId: snapshot.sshConnectionId
        }
      })
    },

    clearSessionPromptSnapshot: (sessionId) => {
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (!session?.promptSnapshot) return
        delete session.promptSnapshot
      })
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
      let targetProjectId =
        session.projectId ??
        get().activeProjectId ??
        get().projects.find((project) => !project.pluginId)?.id ??
        get().projects[0]?.id ??
        null

      const project = get().projects.find((item) => item.id === targetProjectId)
      if (project) {
        targetProjectId = project.id
      }

      const normalizedSession: Session = {
        ...session,
        promptSnapshot: undefined,
        projectId: targetProjectId ?? undefined,
        workingFolder: session.workingFolder ?? project?.workingFolder,
        sshConnectionId: session.sshConnectionId ?? project?.sshConnectionId,
        messageCount: session.messageCount ?? session.messages.length,
        messagesLoaded: session.messagesLoaded ?? true,
        loadedRangeStart: session.loadedRangeStart ?? 0,
        loadedRangeEnd: session.loadedRangeEnd ?? session.messages.length,
        lastKnownMessageCount: session.lastKnownMessageCount ?? session.messageCount ?? session.messages.length
      }
      set((state) => {
        state.sessions.push(normalizedSession)
        state.activeSessionId = normalizedSession.id
        if (targetProjectId) {
          state.activeProjectId = targetProjectId
        }
      })
      dbCreateSession(normalizedSession)
      if (!targetProjectId) {
        void get()
          .ensureDefaultProject()
          .then((defaultProject) => {
            if (!defaultProject) return
            set((state) => {
              const target = state.sessions.find((item) => item.id === normalizedSession.id)
              if (!target || target.projectId) return
              target.projectId = defaultProject.id
              target.workingFolder = defaultProject.workingFolder
              target.sshConnectionId = defaultProject.sshConnectionId
              state.activeProjectId = defaultProject.id
            })
            dbUpdateSession(normalizedSession.id, {
              projectId: defaultProject.id,
              workingFolder: defaultProject.workingFolder ?? null,
              sshConnectionId: defaultProject.sshConnectionId ?? null
            })
          })
      }
      normalizedSession.messages.forEach((msg, i) => dbAddMessage(normalizedSession.id, msg, i))
      useTaskStore.getState().clearTasks()
      const activePlan = usePlanStore.getState().getPlanBySession(normalizedSession.id)
      usePlanStore.getState().setActivePlan(activePlan?.id ?? null)
      useUIStore.getState().syncSessionScopedState(normalizedSession.id)
    },

    importSession: (session, projectId) => {
      let targetProjectId =
        projectId ??
        session.projectId ??
        get().activeProjectId ??
        get().projects.find((project) => !project.pluginId)?.id ??
        get().projects[0]?.id ??
        null

      const project = get().projects.find((item) => item.id === targetProjectId)
      if (project) {
        targetProjectId = project.id
      }

      const importedMessages = cloneImportedMessages(session.messages)
      const normalizedSession: Session = {
        ...session,
        id: nanoid(),
        messages: importedMessages,
        messageCount: importedMessages.length,
        messagesLoaded: true,
        loadedRangeStart: 0,
        loadedRangeEnd: importedMessages.length,
        lastKnownMessageCount: importedMessages.length,
        promptSnapshot: undefined,
        projectId: targetProjectId ?? undefined,
        workingFolder: project?.workingFolder ?? session.workingFolder,
        sshConnectionId: project?.sshConnectionId ?? session.sshConnectionId,
        pluginId: undefined,
        externalChatId: undefined,
        pluginChatType: undefined,
        pluginSenderId: undefined,
        pluginSenderName: undefined
      }

      set((state) => {
        state.sessions.push(normalizedSession)
        state.activeSessionId = normalizedSession.id
        if (targetProjectId) {
          state.activeProjectId = targetProjectId
        }
      })
      dbCreateSession(normalizedSession)
      if (!targetProjectId) {
        void get()
          .ensureDefaultProject()
          .then((defaultProject) => {
            if (!defaultProject) return
            set((state) => {
              const target = state.sessions.find((item) => item.id === normalizedSession.id)
              if (!target || target.projectId) return
              target.projectId = defaultProject.id
              target.workingFolder = defaultProject.workingFolder
              target.sshConnectionId = defaultProject.sshConnectionId
              state.activeProjectId = defaultProject.id
            })
            dbUpdateSession(normalizedSession.id, {
              projectId: defaultProject.id,
              workingFolder: defaultProject.workingFolder ?? null,
              sshConnectionId: defaultProject.sshConnectionId ?? null
            })
          })
      }
      normalizedSession.messages.forEach((msg, i) => dbAddMessage(normalizedSession.id, msg, i))
      useTaskStore.getState().clearTasks()
      const activePlan = usePlanStore.getState().getPlanBySession(normalizedSession.id)
      usePlanStore.getState().setActivePlan(activePlan?.id ?? null)
      useUIStore.getState().syncSessionScopedState(normalizedSession.id)
      return normalizedSession.id
    },

    importProjectArchive: ({ project, sessions }) => {
      const now = Date.now()
      const importedProject: Project = {
        ...project,
        id: nanoid(),
        createdAt: now,
        updatedAt: now,
        pluginId: undefined
      }

      dbCreateProject(importedProject)

      const importedSessionIds: string[] = []
      for (const session of sessions) {
        const importedSessionId = get().importSession(session, importedProject.id)
        importedSessionIds.push(importedSessionId)
      }

      set((state) => {
        state.activeProjectId = importedProject.id
        state.activeSessionId = importedSessionIds[0] ?? state.activeSessionId
      })

      return importedProject.id
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
        useInputDraftStore.getState().removeSessionDraft(id)
      }
      agentState.clearToolCalls()
      useUIStore.getState().syncSessionScopedState(null)
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
          session.loadedRangeStart = 0
          session.loadedRangeEnd = 0
          session.lastKnownMessageCount = 0
          delete session.promptSnapshot
          session.updatedAt = now
        }
      })
      dbClearMessages(sessionId)
      dbUpdateSession(sessionId, { updatedAt: now })
      useAgentStore.getState().setSessionStatus(sessionId, null)
      useAgentStore.getState().clearSessionData(sessionId)
      useAgentStore.getState().clearToolCalls()
      useTeamStore.getState().clearSessionTeam(sessionId)
      const plan = usePlanStore.getState().getPlanBySession(sessionId)
      if (plan) usePlanStore.getState().deletePlan(plan.id)
      useTaskStore.getState().deleteSessionTasks(sessionId)
      useInputDraftStore.getState().removeSessionDraft(sessionId)
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
        loadedRangeStart: 0,
        loadedRangeEnd: clonedMessages.length,
        lastKnownMessageCount: clonedMessages.length,
        createdAt: now,
        updatedAt: now,
        projectId: source.projectId,
        workingFolder: source.workingFolder,
        sshConnectionId: source.sshConnectionId,
        providerId: source.providerId,
        modelId: source.modelId,
        longRunningMode: source.longRunningMode ?? false
      }
      set((state) => {
        state.sessions.push(newSession)
        state.activeSessionId = newId
        if (source.projectId) {
          state.activeProjectId = source.projectId
        }
      })
      dbCreateSession(newSession)
      clonedMessages.forEach((msg, i) => dbAddMessage(newId, msg, i))
      useTaskStore.getState().clearTasks()
      usePlanStore.getState().setActivePlan(null)
      useUIStore.getState().syncSessionScopedState(newId)
      return newId
    },

    removeLastAssistantMessage: (sessionId) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session || session.messages.length === 0) return false
      // Find the last assistant message, skipping trailing tool_result-only user messages
      let assistantIdx = -1
      for (let i = session.messages.length - 1; i >= 0; i--) {
        const m = session.messages[i]
        if (m.role === 'assistant') {
          assistantIdx = i
          break
        }
        // Skip tool_result-only user messages (they are API-level, not real user input)
        if (
          m.role === 'user' &&
          Array.isArray(m.content) &&
          m.content.every((b) => b.type === 'tool_result')
        )
          continue
        break // hit a real user message or something else — stop
      }
      if (assistantIdx < 0) return false
      // Truncate from the assistant message onward (removes it + trailing tool_result messages)
      set((state) => {
        const s = state.sessions.find((s) => s.id === sessionId)
        if (s) {
          s.messages.splice(assistantIdx)
          s.messageCount = s.messages.length
          s.loadedRangeStart = 0
          s.loadedRangeEnd = s.messages.length
          s.lastKnownMessageCount = s.messages.length
        }
      })
      const newLen = get().sessions.find((s) => s.id === sessionId)?.messages.length ?? 0
      dbTruncateMessagesFrom(sessionId, newLen)
      return true
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
          s.loadedRangeStart = 0
          s.loadedRangeEnd = s.messages.length
          s.lastKnownMessageCount = s.messages.length
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
          session.loadedRangeStart = 0
          session.loadedRangeEnd = session.messages.length
          session.lastKnownMessageCount = session.messages.length
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
          session.loadedRangeStart = 0
          session.loadedRangeEnd = messages.length
          session.lastKnownMessageCount = messages.length
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
      let shouldPersist = false
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (!session) return
        shouldPersist = true
        sortOrder = session.messageCount
        if (!session.messagesLoaded) {
          session.messagesLoaded = true
          session.messages = []
          session.loadedRangeStart = session.messageCount
          session.loadedRangeEnd = session.messageCount
        }
        session.messages.push(msg)
        session.messageCount += 1
        session.loadedRangeEnd = session.messageCount
        session.lastKnownMessageCount = session.messageCount
        trimSessionMessageWindow(session)
        session.updatedAt = Date.now()
        releaseDormantSessionMemory(state)
      })
      if (!shouldPersist) return
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
      if (msg) dbFlushMessage(msg)
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
      if (msg) dbFlushMessage(msg)
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
      if (msg) dbFlushMessage(msg)
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
      if (msg) dbFlushMessageImmediate(msg)
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
      if (msg) dbFlushMessageImmediate(msg)
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
      if (msg) dbFlushMessage(msg)
    },

    appendContentBlock: (sessionId, msgId, block) => {
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (!session) return
        const msg = session.messages.find((m) => m.id === msgId)
        if (!msg) return

        if (typeof msg.content === 'string') {
          msg.content = [{ type: 'text', text: msg.content }, block]
        } else {
          ;(msg.content as ContentBlock[]).push(block)
        }
      })
      const session = get().sessions.find((s) => s.id === sessionId)
      const msg = session?.messages.find((m) => m.id === msgId)
      if (msg) dbFlushMessageImmediate(msg)
    },

    setStreamingMessageId: (sessionId, id) =>
      set((state) => {
        if (id) {
          state.streamingMessages[sessionId] = id
        } else {
          delete state.streamingMessages[sessionId]
        }
        releaseDormantSessionMemory(state)
        // Sync convenience field when updating the active session
        if (sessionId === state.activeSessionId) {
          state.streamingMessageId = id
        }
      }),

    setGeneratingImage: (msgId, generating) =>
      set((state) => {
        if (generating) {
          state.generatingImageMessages[msgId] = true
        } else {
          delete state.generatingImageMessages[msgId]
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

    releaseDormantSessions: () => {
      set((state) => {
        releaseDormantSessionMemory(state)
        state.streamingMessageId = state.activeSessionId
          ? (state.streamingMessages[state.activeSessionId] ?? null)
          : null
      })
    }
  }))
)
