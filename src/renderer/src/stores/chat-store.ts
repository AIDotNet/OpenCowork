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
import { useBackgroundSessionStore } from './background-session-store'
import { useProviderStore } from './provider-store'
import { useSettingsStore } from './settings-store'
import { useInputDraftStore } from './input-draft-store'
import { invalidateVisibleSessionCache } from '../lib/agent/session-runtime-router'
import {
  summarizeToolInputForHistory,
  sanitizeMessagesForToolReplay
} from '../lib/tools/tool-input-sanitizer'

export type SessionMode = 'chat' | 'clarify' | 'cowork' | 'code' | 'acp'

export interface SessionPromptSnapshot {
  mode: SessionMode
  planMode: boolean
  systemPrompt: string
  toolDefs: ToolDefinition[]
  projectId?: string
  workingFolder?: string
  sshConnectionId?: string | null
  contextCacheKey?: string
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
  planId?: string
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

export interface CreateSessionOptions {
  longRunningMode?: boolean
  preserveProjectless?: boolean
  planId?: string | null
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
      planId: s.planId,
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

function sanitizeMessageContentForPersistence(
  content: UnifiedMessage['content']
): UnifiedMessage['content'] {
  if (!Array.isArray(content)) return content
  const [sanitized] = sanitizeMessagesForToolReplay([{ role: 'assistant', content }]) as Array<{
    role: string
    content: UnifiedMessage['content']
  }>
  return sanitized.content
}

function dbAddMessage(sessionId: string, msg: UnifiedMessage, sortOrder: number): void {
  ipcClient
    .invoke('db:messages:add', {
      id: msg.id,
      sessionId,
      role: msg.role,
      content: JSON.stringify(sanitizeMessageContentForPersistence(msg.content)),
      meta: msg.meta ? JSON.stringify(msg.meta) : null,
      createdAt: msg.createdAt,
      usage: msg.usage ? JSON.stringify(msg.usage) : null,
      sortOrder
    })
    .catch(() => {})
}

function dbUpdateMessage(msgId: string, content: unknown, usage?: unknown, meta?: unknown): void {
  const normalizedContent =
    typeof content === 'string' || Array.isArray(content)
      ? sanitizeMessageContentForPersistence(content)
      : content
  const patch: Record<string, unknown> = { content: JSON.stringify(normalizedContent) }
  if (usage !== undefined) patch.usage = JSON.stringify(usage)
  if (meta !== undefined) patch.meta = meta === null ? null : JSON.stringify(meta)
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

// --- RAF-batched streaming delta buffer ---
// Multiple tokens arrive per animation frame; batching them into a single
// set() call reduces Zustand/React re-renders from ~100/s to ≤60/s.
type StreamDelta =
  | { kind: 'text'; sessionId: string; msgId: string; text: string }
  | { kind: 'thinking'; sessionId: string; msgId: string; thinking: string }

const _pendingStreamDeltas: StreamDelta[] = []
let _streamDeltaRafId: number | null = null
// Assigned after useChatStore is created (avoids temporal dead zone).
let _scheduleStreamDeltaFlush: () => void = () => {}

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
      dbUpdateMessage(msg.id, msg.content, msg.usage, msg.meta ?? null)
    }, 500)
  )
}

function dbFlushMessageImmediate(msg: UnifiedMessage): void {
  const existing = _pendingFlush.get(msg.id)
  if (existing) {
    clearTimeout(existing)
    _pendingFlush.delete(msg.id)
  }
  dbUpdateMessage(msg.id, msg.content, msg.usage, msg.meta ?? null)
}

function clearPendingMessageFlushes(messageIds: string[]): void {
  for (const messageId of messageIds) {
    const pending = _pendingFlush.get(messageId)
    if (!pending) continue
    clearTimeout(pending)
    _pendingFlush.delete(messageId)
  }
}

// --- Session index helpers ---
// sessionsById maps session id -> index into the sessions array, so all per-session
// lookups are O(1). It must be rebuilt by syncSessionsById whenever the shape of the
// sessions array changes (push, splice, filter, wholesale replacement).
function syncSessionsById(state: {
  sessions: Session[]
  sessionsById: Record<string, number>
}): void {
  const next: Record<string, number> = {}
  for (let i = 0; i < state.sessions.length; i++) {
    next[state.sessions[i].id] = i
  }
  state.sessionsById = next
}

function getSessionByIdFromState(
  state: { sessions: Session[]; sessionsById: Record<string, number> },
  sessionId: string
): Session | undefined {
  const idx = state.sessionsById[sessionId]
  if (idx === undefined) return undefined
  const candidate = state.sessions[idx]
  // Defensive: if the index is stale (e.g. external mutation slipped through), fall back to a linear scan.
  if (candidate && candidate.id === sessionId) return candidate
  return state.sessions.find((s) => s.id === sessionId)
}

/** Bump the monotonic revision counter used by React.memo equality checks. */
function bumpMessageRevision(msg: UnifiedMessage): void {
  msg._revision = (msg._revision ?? 0) + 1
}

// --- Store ---

interface ChatStore {
  projects: Project[]
  sessions: Session[]
  /**
   * sessionId -> index into `sessions`. Maintained by syncSessionsById whenever the sessions
   * array shape changes. Enables O(1) per-session lookups (hot path: flushStreamDeltas,
   * MessageList selector), replacing previous O(n) sessions.find() scans.
   */
  sessionsById: Record<string, number>
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
    options?: CreateSessionOptions
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
  setSessionPlanId: (sessionId: string, planId: string | null) => void
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
  upsertSessionFromSync: (
    row: SyncedSessionRow,
    options?: { preserveLoadedMessages?: boolean }
  ) => void
  removeSessionFromSync: (sessionId: string) => void
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

  /**
   * Atomically merge a background-session snapshot into the foreground chat-store.
   * Called by flushBackgroundSessionToForeground after a session is brought back to the front.
   * Handles both patched (existing message updates) and added (new messages) without relying
   * on the loaded window — if a patched message isn't currently resident, it's inserted as new.
   */
  applyBackgroundSnapshot: (
    sessionId: string,
    snapshot: {
      patchedMessagesById: Record<string, UnifiedMessage>
      addedMessagesById: Record<string, UnifiedMessage>
      addedMessageIds: string[]
    }
  ) => void

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
  getLatestSessionByPlanId: (planId: string) => Session | undefined
  getSessionMessages: (sessionId: string) => UnifiedMessage[]
  recoverFromRendererOom: (sessionId?: string | null) => Promise<void>
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
  plan_id?: string | null
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
  meta: string | null
  created_at: number
  usage: string | null
  sort_order: number
}

type SyncedSessionRow = SessionRow

// Initial tail shown the instant the user switches into a session. Small on
// purpose so the switch renders in ~1 frame. Older history streams in via
// the scroll-to-top load-more row.
const INITIAL_SESSION_DISPLAY_PAGE_SIZE = 20
// Page size used when the user scrolls up past the top of the resident window.
const RECENT_SESSION_MESSAGE_PAGE_SIZE = 40
const MIN_INITIAL_SESSION_MESSAGE_PAGE_SIZE = 5
const MESSAGE_WINDOW_MAX_SIZE = 240
const MESSAGE_WINDOW_TAIL_PRESERVE = 80
const REQUEST_CONTEXT_MAX_MESSAGES = 160
const REQUEST_CONTEXT_SAFE_BOUNDARY_SCAN = 12

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
    planId: row.plan_id ?? undefined,
    pinned: row.pinned === 1,
    pluginId: row.plugin_id ?? undefined,
    externalChatId: row.external_chat_id ?? undefined,
    providerId: row.provider_id ?? undefined,
    modelId: row.model_id ?? undefined,
    longRunningMode: row.long_running_mode === 1
  }
}

function mergeSessionSummary(
  session: Session,
  next: Session,
  options?: { preserveLoadedMessages?: boolean }
): void {
  const preserveLoadedMessages = options?.preserveLoadedMessages === true
  const messageCountChanged = session.messageCount !== next.messageCount

  session.title = next.title
  session.icon = next.icon
  session.mode = next.mode
  session.createdAt = next.createdAt
  session.updatedAt = next.updatedAt
  session.projectId = next.projectId
  session.workingFolder = next.workingFolder
  session.sshConnectionId = next.sshConnectionId
  session.planId = next.planId
  session.pinned = next.pinned
  session.pluginId = next.pluginId
  session.externalChatId = next.externalChatId
  session.providerId = next.providerId
  session.modelId = next.modelId
  session.longRunningMode = next.longRunningMode
  session.messageCount = next.messageCount

  if (next.messageCount === 0) {
    session.messages = []
    session.messagesLoaded = true
    session.loadedRangeStart = 0
    session.loadedRangeEnd = 0
    session.lastKnownMessageCount = 0
    return
  }

  session.lastKnownMessageCount = next.messageCount

  if (messageCountChanged && !preserveLoadedMessages) {
    session.messages = []
    session.messagesLoaded = false
    session.loadedRangeStart = next.messageCount
    session.loadedRangeEnd = next.messageCount
    return
  }

  if (session.loadedRangeEnd > next.messageCount) {
    session.loadedRangeEnd = next.messageCount
  }
  if (session.loadedRangeStart > session.loadedRangeEnd) {
    session.loadedRangeStart = session.loadedRangeEnd
  }
}

function rowToMessage(row: MessageRow): UnifiedMessage {
  let content: string | ContentBlock[]
  let meta: UnifiedMessage['meta']
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
  // Defensive: older DB rows may contain un-elided Write/Edit payloads written
  // before we lowered the inline limits. Strip them on load so the renderer
  // never has to hold a multi-MB tool_use.input in resident state.
  if (Array.isArray(content)) {
    content = sanitizeMessageContentForPersistence(content)
  }
  try {
    meta = row.meta ? (JSON.parse(row.meta) as UnifiedMessage['meta']) : undefined
  } catch {
    meta = undefined
  }
  return {
    id: row.id,
    role: row.role as UnifiedMessage['role'],
    content,
    ...(meta ? { meta } : {}),
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

function getResidentSessionIds(
  state: Pick<ChatStore, 'activeSessionId' | 'streamingMessages'>
): Set<string> {
  const residentSessionIds = new Set<string>()
  if (state.activeSessionId) {
    residentSessionIds.add(state.activeSessionId)
  }

  for (const sessionId of Object.keys(state.streamingMessages)) {
    residentSessionIds.add(sessionId)
  }

  return residentSessionIds
}

function releaseDormantSessionMemory(
  state: Pick<
    ChatStore,
    'sessions' | 'activeSessionId' | 'streamingMessages' | 'generatingImageMessages'
  >
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

function isToolResultOnlyUserMessage(message: UnifiedMessage): boolean {
  return (
    message.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.every((block) => block.type === 'tool_result')
  )
}

function estimateMessageWeight(message: UnifiedMessage): number {
  if (typeof message.content === 'string') return message.content.length
  if (!Array.isArray(message.content)) return 0

  let total = 0
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        total += block.text.length
        break
      case 'thinking':
        total += block.thinking.length
        break
      case 'tool_use':
        total += JSON.stringify(block.input ?? {}).length + String(block.name ?? '').length
        break
      case 'tool_result':
        total += JSON.stringify(block.content ?? '').length
        break
      default:
        total += JSON.stringify(block).length
        break
    }
  }

  return total
}

function hasToolReferenceSplit(messages: UnifiedMessage[], boundary: number): boolean {
  const compressedToolUseIds = new Set<string>()
  for (let index = 0; index < boundary; index += 1) {
    const message = messages[index]
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.id) {
        compressedToolUseIds.add(block.id)
      }
    }
  }

  if (compressedToolUseIds.size === 0) return false

  for (let index = boundary; index < messages.length; index += 1) {
    const message = messages[index]
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (
        block.type === 'tool_result' &&
        block.toolUseId &&
        compressedToolUseIds.has(block.toolUseId)
      ) {
        return true
      }
    }
  }

  return false
}

function clampRequestContext(messages: UnifiedMessage[]): UnifiedMessage[] {
  if (messages.length <= REQUEST_CONTEXT_MAX_MESSAGES) return messages

  let boundary = Math.max(1, messages.length - REQUEST_CONTEXT_MAX_MESSAGES)
  for (let attempt = 0; attempt < REQUEST_CONTEXT_SAFE_BOUNDARY_SCAN; attempt += 1) {
    if (!hasToolReferenceSplit(messages, boundary)) break
    boundary = Math.max(1, boundary - 1)
  }

  return messages.slice(boundary)
}

function mergeResidentTailWithFetchedPrefix(
  residentMessages: UnifiedMessage[],
  fetchedMessages: UnifiedMessage[]
): UnifiedMessage[] {
  if (residentMessages.length === 0) return clampRequestContext(fetchedMessages)
  if (fetchedMessages.length === 0) return clampRequestContext(residentMessages)

  const merged = [...fetchedMessages]
  const seenIds = new Set(fetchedMessages.map((message) => message.id))
  for (const message of residentMessages) {
    if (seenIds.has(message.id)) continue
    merged.push(message)
    seenIds.add(message.id)
  }

  return clampRequestContext(merged)
}

async function loadRequestContextMessages(session: Session): Promise<UnifiedMessage[]> {
  const knownCount = session.messageCount ?? session.messages.length
  if (knownCount <= 0) return []

  const residentMessages = session.messages
  const residentHasFullHistory =
    session.messagesLoaded && session.loadedRangeStart === 0 && session.loadedRangeEnd >= knownCount

  if (residentHasFullHistory) {
    return clampRequestContext(residentMessages)
  }

  const residentTailStart =
    session.messagesLoaded && residentMessages.length > 0
      ? Math.max(
          0,
          Math.min(session.loadedRangeStart, session.loadedRangeEnd - residentMessages.length)
        )
      : knownCount
  const residentWeight = residentMessages.reduce(
    (total, message) => total + estimateMessageWeight(message),
    0
  )
  const weightAdjustedLimit = residentWeight > 200_000 ? 96 : REQUEST_CONTEXT_MAX_MESSAGES
  const targetLimit = Math.max(MIN_INITIAL_SESSION_MESSAGE_PAGE_SIZE, weightAdjustedLimit)
  const tailCount = Math.min(targetLimit, knownCount)
  const tailOffset = Math.max(0, knownCount - tailCount)

  if (session.messagesLoaded && residentMessages.length > 0 && residentTailStart <= tailOffset) {
    return clampRequestContext(residentMessages)
  }

  const fetchLimit = Math.max(0, residentTailStart - tailOffset)
  if (fetchLimit <= 0) {
    return clampRequestContext(residentMessages)
  }

  const msgRows = (await ipcClient.invoke('db:messages:list-page', {
    sessionId: session.id,
    limit: fetchLimit,
    offset: tailOffset
  })) as MessageRow[]
  const fetchedMessages = msgRows.map(rowToMessage)
  return mergeResidentTailWithFetchedPrefix(residentMessages, fetchedMessages)
}

function hasMeaningfulAssistantContent(message: UnifiedMessage): boolean {
  if (message.role !== 'assistant') return true
  if (typeof message.content === 'string') return message.content.trim().length > 0
  if (!Array.isArray(message.content)) return false

  return message.content.some((block) => {
    switch (block.type) {
      case 'text':
        return block.text.trim().length > 0
      case 'thinking':
        return block.thinking.trim().length > 0 || !!block.encryptedContent
      case 'tool_use':
      case 'image':
      case 'image_error':
      case 'agent_error':
        return true
      default:
        return false
    }
  })
}

function stripTrailingAssistantAgentErrors(messages: UnifiedMessage[]): {
  messages: UnifiedMessage[]
  changed: boolean
} {
  if (messages.length === 0) {
    return { messages, changed: false }
  }

  const trimmedMessages = [...messages]
  let changed = false
  while (trimmedMessages.length > 0) {
    const lastMessage = trimmedMessages[trimmedMessages.length - 1]
    if (lastMessage.role !== 'assistant' || !Array.isArray(lastMessage.content)) break

    const filteredBlocks = lastMessage.content.filter((block) => block.type !== 'agent_error')
    if (filteredBlocks.length === lastMessage.content.length) break

    changed = true
    if (filteredBlocks.length === 0) {
      trimmedMessages.pop()
      continue
    }

    trimmedMessages[trimmedMessages.length - 1] = { ...lastMessage, content: filteredBlocks }
    break
  }

  return changed ? { messages: trimmedMessages, changed: true } : { messages, changed: false }
}

function sanitizeToolReplayConsistency(messages: UnifiedMessage[]): {
  messages: UnifiedMessage[]
  changed: boolean
} {
  if (messages.length === 0) {
    return { messages, changed: false }
  }

  const validToolUseIds = new Set<string>()
  const pairedToolUseIdsByAssistantIndex = new Map<number, Set<string>>()

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue

    const blocks = message.content as ContentBlock[]
    const toolUseIds = new Set(
      blocks
        .filter((block): block is ToolUseBlock => block.type === 'tool_use')
        .map((block) => block.id)
    )
    if (toolUseIds.size === 0) continue

    const pairedToolUseIds = new Set<string>()
    for (let candidateIndex = index + 1; candidateIndex < messages.length; candidateIndex += 1) {
      const candidateMessage = messages[candidateIndex]
      if (candidateMessage.role !== 'user' || !Array.isArray(candidateMessage.content)) break

      const candidateBlocks = candidateMessage.content as ContentBlock[]
      if (!candidateBlocks.some((block) => block.type === 'tool_result')) break

      for (const block of candidateBlocks) {
        if (block.type !== 'tool_result' || !toolUseIds.has(block.toolUseId)) continue
        pairedToolUseIds.add(block.toolUseId)
        validToolUseIds.add(block.toolUseId)
      }
    }

    pairedToolUseIdsByAssistantIndex.set(index, pairedToolUseIds)
  }

  let changed = false
  const sanitizedMessages: UnifiedMessage[] = []

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (!Array.isArray(message.content)) {
      sanitizedMessages.push(message)
      continue
    }

    const pairedToolUseIds = pairedToolUseIdsByAssistantIndex.get(index)
    const filteredBlocks = (message.content as ContentBlock[]).filter((block) => {
      if (block.type === 'tool_use') {
        return pairedToolUseIds ? pairedToolUseIds.has(block.id) : true
      }
      if (block.type === 'tool_result') {
        return validToolUseIds.has(block.toolUseId)
      }
      return true
    })

    if (filteredBlocks.length === message.content.length) {
      sanitizedMessages.push(message)
      continue
    }

    changed = true
    if (filteredBlocks.length === 0) continue
    sanitizedMessages.push({ ...message, content: filteredBlocks })
  }

  return changed ? { messages: sanitizedMessages, changed: true } : { messages, changed: false }
}

function sanitizeToolBlocksForResend(messages: UnifiedMessage[]): {
  messages: UnifiedMessage[]
  changed: boolean
} {
  if (messages.length === 0) {
    return { messages, changed: false }
  }

  const trimmed = stripTrailingAssistantAgentErrors(messages)
  const sanitized = sanitizeToolReplayConsistency(trimmed.messages)

  if (!trimmed.changed && !sanitized.changed) {
    return { messages, changed: false }
  }

  return { messages: sanitized.messages, changed: true }
}

export const useChatStore = create<ChatStore>()(
  immer((set, get) => ({
    projects: [],
    sessions: [],
    sessionsById: {},
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
        syncSessionsById(state)

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
        useBackgroundSessionStore.getState().clearSession(sessionId)
        teamState.clearSessionTeam(sessionId)
        const plan = planState.getPlanBySession(sessionId)
        if (plan) {
          planState.deletePlan(plan.id)
        }
        taskState.deleteSessionTasks(sessionId)
        useInputDraftStore.getState().removeSessionDraft(sessionId)
      }
      clearPendingMessageFlushes(deletedMessageIds)
      const liveSessionId = agentState.liveSessionId
      if (liveSessionId && deletedSessionIds.includes(liveSessionId)) {
        agentState.resetLiveSessionExecution(liveSessionId)
        agentState.switchToolCallSession(null, nextActiveSessionId)
      }

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
        Math.min(
          limit ?? MIN_INITIAL_SESSION_MESSAGE_PAGE_SIZE,
          knownCount || MIN_INITIAL_SESSION_MESSAGE_PAGE_SIZE
        )
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
          Math.min(limit ?? INITIAL_SESSION_DISPLAY_PAGE_SIZE, knownCount)
        )
        let windowStart = Math.max(0, knownCount - nextLimit)
        const msgRows = (await ipcClient.invoke('db:messages:list-page', {
          sessionId,
          limit: nextLimit,
          offset: windowStart
        })) as MessageRow[]
        let messages = msgRows.map(rowToMessage)

        while (
          windowStart > 0 &&
          messages.length > 0 &&
          messages.every((message) => isToolResultOnlyUserMessage(message))
        ) {
          const prependCount = Math.min(nextLimit, windowStart)
          const prependOffset = Math.max(0, windowStart - prependCount)
          const prependRows = (await ipcClient.invoke('db:messages:list-page', {
            sessionId,
            limit: prependCount,
            offset: prependOffset
          })) as MessageRow[]
          const prependMessages = prependRows.map(rowToMessage)
          if (prependMessages.length === 0) break
          messages = [...prependMessages, ...messages]
          windowStart = prependOffset
        }

        set((state) => {
          const target = state.sessions.find((s) => s.id === sessionId)
          if (!target) return
          target.messages = messages
          target.messagesLoaded = true
          target.messageCount = knownCount
          target.loadedRangeStart = windowStart
          target.loadedRangeEnd = knownCount
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
      let offset = olderCount - nextCount
      try {
        const msgRows = (await ipcClient.invoke('db:messages:list-page', {
          sessionId,
          limit: nextCount,
          offset
        })) as MessageRow[]
        let olderMessages = msgRows.map(rowToMessage)

        while (
          offset > 0 &&
          olderMessages.length > 0 &&
          olderMessages.every((message) => isToolResultOnlyUserMessage(message))
        ) {
          const prependCount = Math.min(limit, offset)
          const prependOffset = Math.max(0, offset - prependCount)
          const prependRows = (await ipcClient.invoke('db:messages:list-page', {
            sessionId,
            limit: prependCount,
            offset: prependOffset
          })) as MessageRow[]
          const prependMessages = prependRows.map(rowToMessage)
          if (prependMessages.length === 0) break
          olderMessages = [...prependMessages, ...olderMessages]
          offset = prependOffset
        }

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
        !force &&
        session.messagesLoaded &&
        session.loadedRangeStart === 0 &&
        knownCount <= session.messages.length
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
      const includeTrailingAssistantPlaceholder =
        options?.includeTrailingAssistantPlaceholder ?? true

      let messages = await loadRequestContextMessages(session)
      const sanitized = sanitizeToolBlocksForResend(messages)
      messages = sanitized.messages

      // Always strip empty assistant messages — they cause API errors ("must not be empty").
      // When includeTrailingAssistantPlaceholder is true we still keep a trailing assistant
      // message that has real content (used for the "continue" bubble path).
      messages = messages.filter((message, index) => {
        if (message.role !== 'assistant') return true
        if (hasMeaningfulAssistantContent(message)) return true
        // Keep a trailing assistant placeholder only when the caller explicitly opts in
        // (i.e. continuing on an existing bubble that already has content).
        if (includeTrailingAssistantPlaceholder && index === messages.length - 1) return true
        return false
      })

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
          syncSessionsById(state)
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
      const preserveProjectless = options?.preserveProjectless === true

      let targetProjectId = preserveProjectless
        ? (projectId ?? null)
        : (projectId ??
          get().activeProjectId ??
          get().projects.find((project) => !project.pluginId)?.id ??
          get().projects[0]?.id ??
          null)

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
        planId: options?.planId ?? undefined,
        providerId: sessionProviderId,
        modelId: sessionModelId,
        longRunningMode: options?.longRunningMode ?? false
      }
      set((state) => {
        state.sessions.push(newSession)
        syncSessionsById(state)
        state.activeSessionId = id
        if (targetProjectId) {
          state.activeProjectId = targetProjectId
        }
      })
      dbCreateSession(newSession)
      if (!targetProjectId && !preserveProjectless) {
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
      const deletedProjectId = deletedSession?.projectId ?? null
      const currentChatView = useUIStore.getState().chatView
      let nextActiveId: string | null = null

      set((state) => {
        const idx = state.sessions.findIndex((s) => s.id === id)
        if (idx !== -1) {
          state.sessions.splice(idx, 1)
          syncSessionsById(state)
        }

        if (wasActiveSession) {
          state.activeSessionId = null
          state.activeProjectId = deletedProjectId
        }

        nextActiveId = state.activeSessionId
        delete state.streamingMessages[id]
      })

      const agentState = useAgentStore.getState()
      const wasLiveSession = agentState.liveSessionId === id
      agentState.setSessionStatus(id, null)
      agentState.clearSessionData(id)
      useBackgroundSessionStore.getState().clearSession(id)
      if (wasLiveSession) {
        agentState.resetLiveSessionExecution(id)
      }
      useTeamStore.getState().clearSessionTeam(id)
      const plan = usePlanStore.getState().getPlanBySession(id)
      if (plan) usePlanStore.getState().deletePlan(plan.id)
      useTaskStore.getState().deleteSessionTasks(id)
      useInputDraftStore.getState().removeSessionDraft(id)
      clearPendingMessageFlushes(deletedSession?.messages.map((message) => message.id) ?? [])
      dbDeleteSession(id)

      if (wasLiveSession) {
        agentState.switchToolCallSession(null, nextActiveId)
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
      if (wasActiveSession && !nextActiveId) {
        if (deletedProjectId && currentChatView !== 'home') {
          useUIStore.getState().navigateToProject(deletedProjectId)
        } else {
          useUIStore.getState().navigateToHome()
        }
      }
      get().releaseDormantSessions()
    },

    setActiveSession: (id) => {
      const prevId = get().activeSessionId
      invalidateVisibleSessionCache()
      set((state) => {
        state.activeSessionId = id
        const activeSession = state.sessions.find((session) => session.id === id)
        if (activeSession?.projectId) {
          state.activeProjectId = activeSession.projectId
        } else if (id) {
          state.activeProjectId = null
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

    setSessionPlanId: (sessionId, planId) => {
      const now = Date.now()
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (session) {
          session.planId = planId ?? undefined
          session.updatedAt = now
        }
      })
      dbUpdateSession(sessionId, { planId, updatedAt: now })
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
          sshConnectionId: snapshot.sshConnectionId,
          contextCacheKey: snapshot.contextCacheKey
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
        lastKnownMessageCount:
          session.lastKnownMessageCount ?? session.messageCount ?? session.messages.length
      }
      set((state) => {
        state.sessions.push(normalizedSession)
        syncSessionsById(state)
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
        syncSessionsById(state)
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
        state.sessionsById = {}
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
        useBackgroundSessionStore.getState().clearSession(id)
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

    upsertSessionFromSync: (row, options) => {
      const syncedSession = rowToSession(row, [])
      const activeSessionId = get().activeSessionId

      set((state) => {
        const existing = getSessionByIdFromState(state, row.id)
        if (existing) {
          mergeSessionSummary(existing, syncedSession, options)
        } else {
          state.sessions.push(syncedSession)
          syncSessionsById(state)
        }

        if (state.activeSessionId === row.id) {
          state.activeProjectId = syncedSession.projectId ?? null
          state.streamingMessageId = state.streamingMessages[row.id] ?? null
        } else if (!state.activeProjectId && syncedSession.projectId) {
          state.activeProjectId = syncedSession.projectId
        }
      })

      if (activeSessionId === row.id && syncedSession.providerId && syncedSession.modelId) {
        const providerStore = useProviderStore.getState()
        if (providerStore.activeProviderId !== syncedSession.providerId) {
          providerStore.setActiveProvider(syncedSession.providerId)
        }
        if (providerStore.activeModelId !== syncedSession.modelId) {
          providerStore.setActiveModel(syncedSession.modelId)
        }
      }

      get().releaseDormantSessions()
    },

    removeSessionFromSync: (sessionId) => {
      const deletedSession = get().sessions.find((session) => session.id === sessionId)
      if (!deletedSession) return

      const wasActiveSession = get().activeSessionId === sessionId
      const deletedProjectId = deletedSession.projectId ?? null
      const currentChatView = useUIStore.getState().chatView

      set((state) => {
        state.sessions = state.sessions.filter((session) => session.id !== sessionId)
        syncSessionsById(state)

        if (wasActiveSession) {
          state.activeSessionId = null
          state.activeProjectId = deletedProjectId
        }

        delete state.streamingMessages[sessionId]
        state.streamingMessageId = state.activeSessionId
          ? (state.streamingMessages[state.activeSessionId] ?? null)
          : null
      })

      const agentState = useAgentStore.getState()
      const wasLiveSession = agentState.liveSessionId === sessionId
      agentState.setSessionStatus(sessionId, null)
      agentState.clearSessionData(sessionId)
      useBackgroundSessionStore.getState().clearSession(sessionId)
      if (wasLiveSession) {
        agentState.resetLiveSessionExecution(sessionId)
        agentState.switchToolCallSession(sessionId, null)
      }
      useTeamStore.getState().clearSessionTeam(sessionId)
      const plan = usePlanStore.getState().getPlanBySession(sessionId)
      if (plan) usePlanStore.getState().deletePlan(plan.id)
      useTaskStore.getState().deleteSessionTasks(sessionId)
      useInputDraftStore.getState().removeSessionDraft(sessionId)
      clearPendingMessageFlushes(deletedSession.messages.map((message) => message.id))
      useUIStore.getState().syncSessionScopedState(useChatStore.getState().activeSessionId)

      if (wasActiveSession) {
        useTaskStore.getState().clearTasks()
        usePlanStore.getState().setActivePlan(null)

        if (deletedProjectId && currentChatView !== 'home') {
          useUIStore.getState().navigateToProject(deletedProjectId)
        } else {
          useUIStore.getState().navigateToHome()
        }
      }

      get().releaseDormantSessions()
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
      useBackgroundSessionStore.getState().clearSession(sessionId)
      useAgentStore.getState().resetLiveSessionExecution(sessionId)
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
      const clonedMessages: UnifiedMessage[] =
        typeof structuredClone === 'function'
          ? structuredClone(source.messages)
          : JSON.parse(JSON.stringify(source.messages))
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
        syncSessionsById(state)
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
      ipcClient
        .invoke('db:messages:replace', {
          sessionId,
          messages: messages.map((msg, i) => ({
            id: msg.id,
            role: msg.role,
            content: JSON.stringify(sanitizeMessageContentForPersistence(msg.content)),
            meta: msg.meta ? JSON.stringify(msg.meta) : null,
            createdAt: msg.createdAt,
            usage: msg.usage ? JSON.stringify(msg.usage) : null,
            sortOrder: i
          }))
        })
        .catch(() => {})
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
          dbUpdateMessage(msg.id, msg.content, msg.usage, msg.meta ?? null)
        })
        dbUpdateSession(sessionId, { updatedAt: session.updatedAt })
      }
    },

    addMessage: (sessionId, msg) => {
      let sortOrder = 0
      let shouldPersist = false
      set((state) => {
        const session = getSessionByIdFromState(state, sessionId)
        if (!session) return
        shouldPersist = true
        sortOrder = session.messageCount
        if (!session.messagesLoaded) {
          session.messagesLoaded = true
          session.messages = []
          session.loadedRangeStart = session.messageCount
          session.loadedRangeEnd = session.messageCount
        }
        msg._revision = (msg._revision ?? 0) + 1
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
        const session = getSessionByIdFromState(state, sessionId)
        if (!session) return
        const msg = session.messages.find((m) => m.id === msgId)
        if (msg) {
          Object.assign(msg, patch)
          bumpMessageRevision(msg)
        }
      })
      // Persist updated message
      const session = getSessionByIdFromState(get(), sessionId)
      const msg = session?.messages.find((m) => m.id === msgId)
      if (msg) dbUpdateMessage(msgId, msg.content, msg.usage, msg.meta ?? null)
    },

    appendTextDelta: (sessionId, msgId, text) => {
      _pendingStreamDeltas.push({ kind: 'text', sessionId, msgId, text })
      _scheduleStreamDeltaFlush()
    },

    appendThinkingDelta: (sessionId, msgId, thinking) => {
      const cleanedThinking = stripThinkTagMarkers(thinking)
      if (!cleanedThinking) return
      _pendingStreamDeltas.push({ kind: 'thinking', sessionId, msgId, thinking: cleanedThinking })
      _scheduleStreamDeltaFlush()
    },

    setThinkingEncryptedContent: (sessionId, msgId, encryptedContent, provider) => {
      if (!encryptedContent) return

      set((state) => {
        const session = getSessionByIdFromState(state, sessionId)
        if (!session) return
        const msg = session.messages.find((m) => m.id === msgId)
        if (!msg) return
        bumpMessageRevision(msg)

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

      const session = getSessionByIdFromState(get(), sessionId)
      const msg = session?.messages.find((m) => m.id === msgId)
      if (msg) dbFlushMessage(msg)
    },

    completeThinking: (sessionId, msgId) => {
      flushPendingStreamDeltasForMessage(sessionId, msgId)
      set((state) => {
        const session = getSessionByIdFromState(state, sessionId)
        if (!session) return
        const msg = session.messages.find((m) => m.id === msgId)
        if (!msg || typeof msg.content === 'string') return

        const blocks = msg.content as ContentBlock[]
        for (const block of blocks) {
          if (block.type === 'thinking' && !block.completedAt) {
            block.completedAt = Date.now()
          }
        }
        bumpMessageRevision(msg)
      })
      // Immediate persist after thinking completes
      const session = getSessionByIdFromState(get(), sessionId)
      const msg = session?.messages.find((m) => m.id === msgId)
      if (msg) dbFlushMessageImmediate(msg)
    },

    appendToolUse: (sessionId, msgId, toolUse) => {
      flushPendingStreamDeltasForMessage(sessionId, msgId)
      set((state) => {
        const session = getSessionByIdFromState(state, sessionId)
        if (!session) return
        const msg = session.messages.find((m) => m.id === msgId)
        if (!msg) return

        const normalizedToolUse: ToolUseBlock = {
          ...toolUse,
          input: summarizeToolInputForHistory(toolUse.name, toolUse.input)
        }
        if (typeof msg.content === 'string') {
          msg.content = msg.content
            ? [{ type: 'text', text: msg.content }, normalizedToolUse]
            : [normalizedToolUse]
        } else {
          ;(msg.content as ContentBlock[]).push(normalizedToolUse)
        }
        bumpMessageRevision(msg)
      })
      // Persist immediately for tool use blocks
      const session = getSessionByIdFromState(get(), sessionId)
      const msg = session?.messages.find((m) => m.id === msgId)
      if (msg) dbFlushMessageImmediate(msg)
    },

    updateToolUseInput: (sessionId, msgId, toolUseId, input) => {
      set((state) => {
        const session = getSessionByIdFromState(state, sessionId)
        if (!session) return
        const msg = session.messages.find((m) => m.id === msgId)
        if (!msg || typeof msg.content === 'string') return

        const block = (msg.content as ContentBlock[]).find(
          (b) => b.type === 'tool_use' && (b as ToolUseBlock).id === toolUseId
        ) as ToolUseBlock | undefined
        if (block) {
          block.input = summarizeToolInputForHistory(block.name, input)
          bumpMessageRevision(msg)
        }
      })
      const session = getSessionByIdFromState(get(), sessionId)
      const msg = session?.messages.find((m) => m.id === msgId)
      if (msg) dbFlushMessage(msg)
    },

    appendContentBlock: (sessionId, msgId, block) => {
      flushPendingStreamDeltasForMessage(sessionId, msgId)
      set((state) => {
        const session = getSessionByIdFromState(state, sessionId)
        if (!session) return
        const msg = session.messages.find((m) => m.id === msgId)
        if (!msg) return

        if (typeof msg.content === 'string') {
          msg.content = msg.content ? [{ type: 'text', text: msg.content }, block] : [block]
        } else {
          ;(msg.content as ContentBlock[]).push(block)
        }
        bumpMessageRevision(msg)
      })
      const session = getSessionByIdFromState(get(), sessionId)
      const msg = session?.messages.find((m) => m.id === msgId)
      if (msg) dbFlushMessageImmediate(msg)
    },

    applyBackgroundSnapshot: (sessionId, snapshot) => {
      let mergedAny = false
      set((state) => {
        const session = getSessionByIdFromState(state, sessionId)
        if (!session) return

        // 1. Apply patched messages: existing -> override fields, missing -> insert as new.
        //    This eliminates the "silent updateMessage failure when id isn't in the loaded window" bug.
        for (const [msgId, bufferedMsg] of Object.entries(snapshot.patchedMessagesById)) {
          const existing = session.messages.find((m) => m.id === msgId)
          if (existing) {
            existing.content = bufferedMsg.content
            if (bufferedMsg.usage) existing.usage = bufferedMsg.usage
            if (bufferedMsg.providerResponseId) {
              existing.providerResponseId = bufferedMsg.providerResponseId
            }
            bumpMessageRevision(existing)
            mergedAny = true
          } else {
            const cloned: UnifiedMessage = { ...bufferedMsg, _revision: 1 }
            session.messages.push(cloned)
            session.messageCount = Math.max(session.messageCount, session.messages.length)
            session.loadedRangeEnd = session.messageCount
            session.lastKnownMessageCount = session.messageCount
            mergedAny = true
          }
        }

        // 2. Apply added messages in insertion order; skip duplicates.
        for (const msgId of snapshot.addedMessageIds) {
          if (session.messages.some((m) => m.id === msgId)) continue
          const msg = snapshot.addedMessagesById[msgId]
          if (!msg) continue
          const cloned: UnifiedMessage = { ...msg, _revision: 1 }
          session.messages.push(cloned)
          session.messageCount = Math.max(session.messageCount, session.messages.length)
          session.loadedRangeEnd = session.messageCount
          session.lastKnownMessageCount = session.messageCount
          mergedAny = true
        }

        if (mergedAny) {
          session.updatedAt = Date.now()
        }
      })

      if (!mergedAny) return

      // Persist merged messages to DB (fire-and-forget, debounced per message).
      const session = getSessionByIdFromState(get(), sessionId)
      if (!session) return
      const mergedIds = new Set<string>([
        ...Object.keys(snapshot.patchedMessagesById),
        ...snapshot.addedMessageIds
      ])
      for (const msg of session.messages) {
        if (!mergedIds.has(msg.id)) continue
        dbFlushMessageImmediate(msg)
      }
      dbUpdateSession(sessionId, { updatedAt: session.updatedAt })
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
      const state = get()
      if (!state.activeSessionId) return undefined
      return getSessionByIdFromState(state, state.activeSessionId)
    },

    getLatestSessionByPlanId: (planId) => {
      if (!planId) return undefined
      return [...get().sessions]
        .filter((session) => session.planId === planId)
        .sort((left, right) => right.updatedAt - left.updatedAt)[0]
    },

    getSessionMessages: (sessionId) => {
      const session = getSessionByIdFromState(get(), sessionId)
      return session?.messages ?? []
    },

    recoverFromRendererOom: async (sessionId) => {
      const targetSessionId = sessionId ?? get().activeSessionId

      set((state) => {
        state.sessions = state.sessions.map((session) => {
          if (session.id === targetSessionId) {
            return {
              ...session,
              messages: [],
              messagesLoaded: session.messageCount === 0,
              loadedRangeStart: session.messageCount,
              loadedRangeEnd: session.messageCount,
              lastKnownMessageCount: session.messageCount,
              promptSnapshot: undefined
            }
          }

          return {
            ...session,
            messages: [],
            messagesLoaded: session.messageCount === 0,
            loadedRangeStart: session.messageCount,
            loadedRangeEnd: session.messageCount,
            lastKnownMessageCount: session.messageCount,
            promptSnapshot: undefined
          }
        })
        syncSessionsById(state)
        state.streamingMessages = targetSessionId
          ? Object.fromEntries(
              Object.entries(state.streamingMessages).filter(([key]) => key === targetSessionId)
            )
          : {}
        state.streamingMessageId = targetSessionId
          ? (state.streamingMessages[targetSessionId] ?? null)
          : null
      })

      useAgentStore.getState().releaseDormantSessionData(targetSessionId ? [targetSessionId] : [])
      if (targetSessionId) {
        useBackgroundSessionStore.getState().clearSession(targetSessionId)
      }
      useTaskStore.getState().releaseDormantSessionTasks(targetSessionId ? [targetSessionId] : [])
      usePlanStore.getState().releaseDormantPlans(targetSessionId ?? null)

      if (targetSessionId) {
        await get().loadRecentSessionMessages(targetSessionId, true, 40)
        await useTaskStore.getState().loadTasksForSession(targetSessionId)
        const planStore = usePlanStore.getState()
        const activePlan = await planStore.loadPlanForSession(targetSessionId)
        planStore.setActivePlan(activePlan?.id ?? null)
      } else {
        useTaskStore.getState().clearTasks()
        usePlanStore.getState().setActivePlan(null)
      }

      get().releaseDormantSessions()
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

// --- RAF delta flush (wired after store creation to avoid TDZ) ---

function groupStreamDeltasBySession(deltas: StreamDelta[]): Map<string, StreamDelta[]> {
  const bySession = new Map<string, StreamDelta[]>()
  for (const delta of deltas) {
    let arr = bySession.get(delta.sessionId)
    if (!arr) {
      arr = []
      bySession.set(delta.sessionId, arr)
    }
    arr.push(delta)
  }
  return bySession
}

function applyStreamDeltas(
  bySession: Map<string, StreamDelta[]>,
  affectedMessages: Array<{ sessionId: string; msgId: string }>
): void {
  useChatStore.setState((state) => {
    const now = Date.now()
    for (const [sessionId, sessionDeltas] of bySession) {
      const session = getSessionByIdFromState(state, sessionId)
      if (!session) continue

      const msgMap = new Map<string, UnifiedMessage>()
      for (const msg of session.messages) msgMap.set(msg.id, msg)

      for (const delta of sessionDeltas) {
        const msg = msgMap.get(delta.msgId)
        if (!msg) continue

        if (delta.kind === 'text') {
          if (typeof msg.content === 'string') {
            msg.content += delta.text
          } else {
            const blocks = msg.content as ContentBlock[]
            const lastBlock = blocks[blocks.length - 1]
            if (lastBlock?.type === 'text') {
              ;(lastBlock as TextBlock).text += delta.text
            } else {
              blocks.push({ type: 'text', text: delta.text })
            }
          }
        } else {
          if (typeof msg.content === 'string') {
            msg.content = [{ type: 'thinking', thinking: delta.thinking, startedAt: now }]
          } else {
            const blocks = msg.content as ContentBlock[]
            let target: ThinkingBlock | null = null
            for (let i = blocks.length - 1; i >= 0; i--) {
              const b = blocks[i]
              if (b.type === 'thinking' && !(b as ThinkingBlock).completedAt) {
                target = b as ThinkingBlock
                break
              }
            }
            if (target) {
              target.thinking = stripThinkTagMarkers(`${target.thinking}${delta.thinking}`)
            } else {
              blocks.push({ type: 'thinking', thinking: delta.thinking, startedAt: now })
            }
          }
        }

        bumpMessageRevision(msg)
        affectedMessages.push({ sessionId, msgId: delta.msgId })
      }
    }
  })
}

function persistAffectedMessages(
  affectedMessages: Array<{ sessionId: string; msgId: string }>
): void {
  if (affectedMessages.length === 0) return

  const state = useChatStore.getState()
  const seen = new Set<string>()
  for (const { sessionId, msgId } of affectedMessages) {
    const key = `${sessionId}\u0000${msgId}`
    if (seen.has(key)) continue
    seen.add(key)
    const session = getSessionByIdFromState(state, sessionId)
    if (!session) continue
    const msg = session.messages.find((m) => m.id === msgId)
    if (msg) dbFlushMessage(msg)
  }
}

function flushPendingStreamDeltasForMessage(sessionId: string, msgId: string): void {
  if (_pendingStreamDeltas.length === 0) return

  const matching: StreamDelta[] = []
  for (let index = _pendingStreamDeltas.length - 1; index >= 0; index -= 1) {
    const delta = _pendingStreamDeltas[index]
    if (delta.sessionId !== sessionId || delta.msgId !== msgId) continue
    matching.push(delta)
    _pendingStreamDeltas.splice(index, 1)
  }

  if (matching.length === 0) return

  matching.reverse()
  const affectedMessages: Array<{ sessionId: string; msgId: string }> = []
  applyStreamDeltas(groupStreamDeltasBySession(matching), affectedMessages)
  persistAffectedMessages(affectedMessages)
}

function flushStreamDeltas(): void {
  _streamDeltaRafId = null
  if (_pendingStreamDeltas.length === 0) return

  const deltas = _pendingStreamDeltas.splice(0)
  const affectedMessages: Array<{ sessionId: string; msgId: string }> = []
  applyStreamDeltas(groupStreamDeltasBySession(deltas), affectedMessages)
  persistAffectedMessages(affectedMessages)
}

_scheduleStreamDeltaFlush = () => {
  if (_streamDeltaRafId !== null) return
  _streamDeltaRafId = requestAnimationFrame(flushStreamDeltas)
}
