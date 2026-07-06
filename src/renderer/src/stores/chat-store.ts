import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { nanoid } from 'nanoid'
import type {
  UnifiedMessage,
  ContentBlock,
  TextBlock,
  ImageBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolDefinition
} from '../lib/api/types'
import { invokeMessagePack, invokeMessagePackBinary } from '../lib/ipc/messagepack-ipc-client'
import {
  DB_MESSAGES_ADD_BATCH_MSGPACK_CHANNEL,
  DB_MESSAGES_CLEAR_MSGPACK_CHANNEL,
  DB_MESSAGES_COUNT_MSGPACK_CHANNEL,
  DB_MESSAGES_DELETE_MSGPACK_CHANNEL,
  DB_MESSAGES_INSERT_ARTIFACTS_MSGPACK_CHANNEL,
  DB_MESSAGES_LIST_MSGPACK_CHANNEL,
  DB_MESSAGES_LIST_PAGE_MSGPACK_CHANNEL,
  DB_MESSAGES_REQUEST_CONTEXT_MSGPACK_CHANNEL,
  DB_MESSAGES_REPLACE_MSGPACK_CHANNEL,
  DB_MESSAGES_TRUNCATE_FROM_MSGPACK_CHANNEL,
  DB_MESSAGES_UPSERT_MSGPACK_CHANNEL,
  DB_MESSAGES_WINDOW_AROUND_MSGPACK_CHANNEL,
  DB_PROJECTS_CREATE_MSGPACK_CHANNEL,
  DB_PROJECTS_DELETE_MSGPACK_CHANNEL,
  DB_PROJECTS_ENSURE_DEFAULT_MSGPACK_CHANNEL,
  DB_PROJECTS_LIST_MSGPACK_CHANNEL,
  DB_PROJECTS_UPDATE_MSGPACK_CHANNEL,
  DB_SESSIONS_CLEAR_ALL_MSGPACK_CHANNEL,
  DB_SESSIONS_CREATE_MSGPACK_CHANNEL,
  DB_SESSIONS_DELETE_MSGPACK_CHANNEL,
  DB_SESSIONS_LIST_MSGPACK_CHANNEL,
  DB_SESSIONS_UPDATE_MSGPACK_CHANNEL
} from '../../../shared/messagepack/binary-ipc'
import { useAgentStore } from './agent-store'
import { useTeamStore } from './team-store'
import { useTaskStore } from './task-store'
import { usePlanStore } from './plan-store'
import { useUIStore } from './ui-store'
import { useBackgroundSessionStore } from './background-session-store'
import { useSettingsStore } from './settings-store'
import { removeSessionInputDraft } from '../lib/input-drafts'
import {
  invalidateVisibleSessionCache,
  isSessionForeground
} from '../lib/agent/session-runtime-router'
import { mergeUsageSnapshot } from '../lib/agent/usage-merge'
import { agentStream } from '../lib/ipc/agent-stream-receiver'
import { parseChatRoute } from '../lib/chat-route'
import {
  summarizeToolInputForHistory,
  sanitizeMessagesForToolReplay
} from '../lib/tools/tool-input-sanitizer'
import {
  isCompactArtifactMessage,
  isCompactBoundaryMessage,
  resolveActiveCompactArtifacts,
  type ActiveCompactArtifacts
} from '../lib/agent/context-compression'

export type SessionMode = 'chat' | 'clarify' | 'cowork' | 'code' | 'acp'
export type SessionModelSelectionMode = 'inherit' | 'auto' | 'manual'

export interface SessionPromptSnapshot {
  mode: SessionMode
  planMode: boolean
  systemPrompt: string
  toolDefs: ToolDefinition[]
  projectId?: string
  workingFolder?: string
  sshConnectionId?: string | null
  contextCacheKey?: string
  systemHash?: string
  toolsHash?: string
  toolCount?: number
  createdAt?: number
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
  /** How this session resolves its main model. */
  modelSelectionMode?: SessionModelSelectionMode
  /** Bound provider ID when modelSelectionMode is manual. */
  providerId?: string
  /** Bound model ID when modelSelectionMode is manual. */
  modelId?: string
  /** In-memory prompt snapshot reused within the current app session */
  promptSnapshot?: SessionPromptSnapshot
}

export function createRestorableSessionSnapshot(session: Session): Session {
  return {
    id: session.id,
    title: session.title,
    icon: session.icon,
    mode: session.mode,
    messages: session.messages,
    messageCount: session.messageCount,
    messagesLoaded: session.messagesLoaded,
    loadedRangeStart: session.loadedRangeStart,
    loadedRangeEnd: session.loadedRangeEnd,
    lastKnownMessageCount: session.lastKnownMessageCount,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    projectId: session.projectId,
    workingFolder: session.workingFolder,
    sshConnectionId: session.sshConnectionId,
    planId: session.planId,
    pinned: session.pinned,
    pluginId: session.pluginId,
    externalChatId: session.externalChatId,
    pluginChatType: session.pluginChatType,
    pluginSenderId: session.pluginSenderId,
    pluginSenderName: session.pluginSenderName,
    modelSelectionMode: session.modelSelectionMode,
    providerId: session.providerId,
    modelId: session.modelId,
    promptSnapshot: undefined
  }
}

export interface ImageGenerationTiming {
  startedAt: number
  completedAt?: number
}

export interface CreateSessionOptions {
  preserveProjectless?: boolean
  planId?: string | null
  workingFolder?: string | null
  sshConnectionId?: string | null
}

// --- DB persistence helpers (queued fire-and-forget) ---

const _pendingSessionCreates = new Map<string, Promise<unknown>>()
const _sessionMessageWriteQueues = new Map<string, Promise<void>>()
const _messageWriteGenerations = new Map<string, number>()
const _pendingMessageWriteCounts = new Map<string, number>()
const _pendingMessageUpserts = new Map<string, PendingMessageUpsert>()

type MessageUpsertReason =
  | 'message-upsert'
  | 'message-debounce'
  | 'message-immediate'
  | 'message-update'
  | 'streaming-checkpoint'
  | 'streaming-final'
  | 'strip-reminders'

interface PendingMessageUpsert {
  timer: ReturnType<typeof setTimeout> | null
  sessionId: string
  messageId: string
  sortOrder: number
  expectedGeneration: number
  reason: MessageUpsertReason
  payload: MessageUpsertPayload
  traceMessage: UnifiedMessage
}

interface MessageUpsertPayload {
  id: string
  sessionId: string
  role: UnifiedMessage['role']
  content: string
  meta: string | null
  createdAt: number
  usage: string | null
  sortOrder: number
  debugReason: MessageUpsertReason
}

const MESSAGE_UPSERT_TRACE_WINDOW_MS = 30_000
const DEFAULT_MESSAGE_UPSERT_COALESCE_MS = 1500
const BACKGROUND_MESSAGE_UPSERT_COALESCE_MS = 5000
const MESSAGE_UPSERT_MIN_CHANGED_CHARS = 1024
let _messageUpsertTraceWindowStartedAt = Date.now()
let _messageUpsertTraceTotal = 0
const _messageUpsertTraceByReason = new Map<MessageUpsertReason, number>()
const _messageUpsertTraceSessionIds = new Set<string>()

function shouldLogMessageUpsertTrace(): boolean {
  try {
    return (
      localStorage.getItem('openCowork.dbTrace') === '1' ||
      localStorage.getItem('openCowork.messagePersistenceTrace') === '1'
    )
  } catch {
    return false
  }
}

function logMessageUpsertDebug(message: string, details: Record<string, unknown>): void {
  if (!shouldLogMessageUpsertTrace()) return
  console.debug(message, details)
}

function readPositiveIntegerLocalStorage(key: string, fallback: number): number {
  try {
    const value = Number.parseInt(localStorage.getItem(key) ?? '', 10)
    return Number.isFinite(value) && value > 0 ? value : fallback
  } catch {
    return fallback
  }
}

function getMessageUpsertCoalesceMs(sessionId: string, reason: MessageUpsertReason): number {
  if (reason !== 'streaming-checkpoint' && reason !== 'message-debounce') {
    return readPositiveIntegerLocalStorage(
      'openCowork.messageUpsertCoalesceMs',
      DEFAULT_MESSAGE_UPSERT_COALESCE_MS
    )
  }
  const fallback = isSessionForeground(sessionId)
    ? DEFAULT_MESSAGE_UPSERT_COALESCE_MS
    : BACKGROUND_MESSAGE_UPSERT_COALESCE_MS
  return readPositiveIntegerLocalStorage('openCowork.messageUpsertCoalesceMs', fallback)
}

function hashString(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function buildMessagePayloadFingerprint(payload: MessageUpsertPayload): string {
  return hashString(
    [
      payload.role,
      payload.content,
      payload.meta ?? '',
      payload.usage ?? '',
      String(payload.createdAt),
      String(payload.sortOrder)
    ].join('\u001f')
  )
}

function recordMessageUpsertTrace(
  reason: MessageUpsertReason,
  sessionId: string,
  msg: UnifiedMessage,
  sortOrder: number
): void {
  if (!shouldLogMessageUpsertTrace()) return

  _messageUpsertTraceTotal += 1
  _messageUpsertTraceByReason.set(reason, (_messageUpsertTraceByReason.get(reason) ?? 0) + 1)
  _messageUpsertTraceSessionIds.add(sessionId)

  const now = Date.now()
  if (now - _messageUpsertTraceWindowStartedAt < MESSAGE_UPSERT_TRACE_WINDOW_MS) return

  console.debug('[ChatStore] db:messages:upsert summary', {
    windowMs: now - _messageUpsertTraceWindowStartedAt,
    total: _messageUpsertTraceTotal,
    byReason: Object.fromEntries(_messageUpsertTraceByReason.entries()),
    sessionCount: _messageUpsertTraceSessionIds.size,
    last: {
      reason,
      sessionId,
      messageId: msg.id,
      role: msg.role,
      revision: msg._revision ?? 0,
      sortOrder
    }
  })

  _messageUpsertTraceWindowStartedAt = now
  _messageUpsertTraceTotal = 0
  _messageUpsertTraceByReason.clear()
  _messageUpsertTraceSessionIds.clear()
}

function getMessageWriteGeneration(sessionId: string): number {
  return _messageWriteGenerations.get(sessionId) ?? 0
}

function bumpMessageWriteGeneration(sessionId: string): void {
  _messageWriteGenerations.set(sessionId, getMessageWriteGeneration(sessionId) + 1)
}

function trackPendingMessageWrite(messageIds: string[], pending: Promise<void>): void {
  for (const messageId of messageIds) {
    _pendingMessageWriteCounts.set(messageId, (_pendingMessageWriteCounts.get(messageId) ?? 0) + 1)
  }
  void pending.finally(() => {
    for (const messageId of messageIds) {
      const nextCount = (_pendingMessageWriteCounts.get(messageId) ?? 1) - 1
      if (nextCount > 0) {
        _pendingMessageWriteCounts.set(messageId, nextCount)
      } else {
        _pendingMessageWriteCounts.delete(messageId)
      }
    }
  })
}

function enqueueSessionMessageWrite(
  sessionId: string,
  write: () => Promise<unknown>,
  expectedGeneration?: number
): Promise<void> {
  const previous = _sessionMessageWriteQueues.get(sessionId) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(async () => {
      if (
        expectedGeneration !== undefined &&
        getMessageWriteGeneration(sessionId) !== expectedGeneration
      ) {
        return
      }

      await (_pendingSessionCreates.get(sessionId) ?? Promise.resolve()).catch(() => {})

      if (
        expectedGeneration !== undefined &&
        getMessageWriteGeneration(sessionId) !== expectedGeneration
      ) {
        return
      }

      await write()
    })
    .catch(() => {})

  _sessionMessageWriteQueues.set(sessionId, next)
  void next.finally(() => {
    if (_sessionMessageWriteQueues.get(sessionId) === next) {
      _sessionMessageWriteQueues.delete(sessionId)
    }
  })
  return next
}

function dbCreateSession(s: Session): void {
  const pending = invokeMessagePack(DB_SESSIONS_CREATE_MSGPACK_CHANNEL, {
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
    modelSelectionMode: s.modelSelectionMode ?? (s.providerId && s.modelId ? 'manual' : 'inherit')
  })
    .catch(() => {})
    .finally(() => {
      if (_pendingSessionCreates.get(s.id) === pending) {
        _pendingSessionCreates.delete(s.id)
      }
    })

  _pendingSessionCreates.set(s.id, pending)
}

function dbUpdateSession(id: string, patch: Record<string, unknown>): void {
  invokeMessagePack(DB_SESSIONS_UPDATE_MSGPACK_CHANNEL, { id, patch }).catch(() => {})
}

function dbDeleteSession(id: string): void {
  bumpMessageWriteGeneration(id)
  _sessionMessageWriteQueues.delete(id)
  void (_pendingSessionCreates.get(id) ?? Promise.resolve())
    .catch(() => {})
    .then(() => invokeMessagePack(DB_SESSIONS_DELETE_MSGPACK_CHANNEL, id))
    .catch(() => {})
}

function dbClearAllSessions(sessionIds: string[] = []): void {
  const pendingWrites = sessionIds.map((sessionId) => {
    bumpMessageWriteGeneration(sessionId)
    return _sessionMessageWriteQueues.get(sessionId)?.catch(() => {}) ?? Promise.resolve()
  })
  void Promise.all(pendingWrites)
    .then(() => invokeMessagePack(DB_SESSIONS_CLEAR_ALL_MSGPACK_CHANNEL, {}))
    .catch(() => {})
}

function dbCreateProject(project: Project): void {
  invokeMessagePack(DB_PROJECTS_CREATE_MSGPACK_CHANNEL, {
    id: project.id,
    name: project.name,
    workingFolder: project.workingFolder,
    sshConnectionId: project.sshConnectionId,
    pluginId: project.pluginId,
    pinned: project.pinned,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  }).catch(() => {})
}

function dbUpdateProject(id: string, patch: Record<string, unknown>): void {
  invokeMessagePack(DB_PROJECTS_UPDATE_MSGPACK_CHANNEL, { id, patch }).catch(() => {})
}

function dbDeleteProject(id: string): void {
  invokeMessagePack(DB_PROJECTS_DELETE_MSGPACK_CHANNEL, id).catch(() => {})
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
  const generation = getMessageWriteGeneration(sessionId)
  const pending = enqueueSessionMessageWrite(
    sessionId,
    () =>
      invokeMessagePack(DB_MESSAGES_ADD_BATCH_MSGPACK_CHANNEL, [
        {
          id: msg.id,
          sessionId,
          role: msg.role,
          content: JSON.stringify(sanitizeMessageContentForPersistence(msg.content)),
          meta: msg.meta ? JSON.stringify(msg.meta) : null,
          createdAt: msg.createdAt,
          usage: msg.usage ? JSON.stringify(msg.usage) : null,
          sortOrder
        }
      ]),
    generation
  )
  trackPendingMessageWrite([msg.id], pending)
}

function dbAddMessageBatch(
  sessionId: string,
  items: Array<{ msg: UnifiedMessage; sortOrder: number }>
): void {
  if (items.length === 0) return
  const generation = getMessageWriteGeneration(sessionId)
  const pending = enqueueSessionMessageWrite(
    sessionId,
    () =>
      invokeMessagePack(
        DB_MESSAGES_ADD_BATCH_MSGPACK_CHANNEL,
        items.map(({ msg, sortOrder }) => ({
          id: msg.id,
          sessionId,
          role: msg.role,
          content: JSON.stringify(sanitizeMessageContentForPersistence(msg.content)),
          meta: msg.meta ? JSON.stringify(msg.meta) : null,
          createdAt: msg.createdAt,
          usage: msg.usage ? JSON.stringify(msg.usage) : null,
          sortOrder
        }))
      ),
    generation
  )
  trackPendingMessageWrite(
    items.map(({ msg }) => msg.id),
    pending
  )
}

function resolveMessageSortOrder(
  session: Pick<Session, 'messages' | 'loadedRangeStart' | 'messageCount'> | undefined,
  msgId: string,
  fallback = 0
): number {
  if (!session) return Math.max(0, fallback)
  const index = session.messages.findIndex((message) => message.id === msgId)
  if (index >= 0) return Math.max(0, session.loadedRangeStart + index)
  return Math.max(0, session.messageCount - 1, fallback)
}

function buildPendingMessageUpsertKey(sessionId: string, messageId: string): string {
  return `${sessionId}:${messageId}`
}

function shouldCoalesceMessageUpsert(reason: MessageUpsertReason): boolean {
  return reason !== 'streaming-final'
}

function dispatchMessageUpsert(pendingUpsert: PendingMessageUpsert): void {
  const key = buildPendingMessageUpsertKey(pendingUpsert.sessionId, pendingUpsert.messageId)
  const current = _pendingMessageUpserts.get(key)
  if (current === pendingUpsert) {
    _pendingMessageUpserts.delete(key)
  }

  const pending = enqueueSessionMessageWrite(
    pendingUpsert.sessionId,
    () => invokeMessagePack(DB_MESSAGES_UPSERT_MSGPACK_CHANNEL, pendingUpsert.payload),
    pendingUpsert.expectedGeneration
  )
  trackPendingMessageWrite([pendingUpsert.messageId], pending)
  recordMessageUpsertTrace(
    pendingUpsert.reason,
    pendingUpsert.sessionId,
    pendingUpsert.traceMessage,
    pendingUpsert.sortOrder
  )
}

function flushPendingMessageUpsert(sessionId: string, messageId: string): void {
  const key = buildPendingMessageUpsertKey(sessionId, messageId)
  const pendingUpsert = _pendingMessageUpserts.get(key)
  if (!pendingUpsert) return
  if (pendingUpsert.timer) clearTimeout(pendingUpsert.timer)
  dispatchMessageUpsert(pendingUpsert)
}

function clearPendingMessageUpsert(sessionId: string, messageId: string): void {
  const key = buildPendingMessageUpsertKey(sessionId, messageId)
  const pendingUpsert = _pendingMessageUpserts.get(key)
  if (!pendingUpsert) return
  if (pendingUpsert.timer) clearTimeout(pendingUpsert.timer)
  _pendingMessageUpserts.delete(key)
}

function clearPendingMessageUpsertsForSession(sessionId: string, fromSortOrder = 0): void {
  for (const [key, pendingUpsert] of _pendingMessageUpserts.entries()) {
    if (pendingUpsert.sessionId !== sessionId || pendingUpsert.sortOrder < fromSortOrder) {
      continue
    }
    if (pendingUpsert.timer) clearTimeout(pendingUpsert.timer)
    _pendingMessageUpserts.delete(key)
  }
}

function dbUpsertMessage(
  sessionId: string,
  msg: UnifiedMessage,
  sortOrder: number,
  expectedGeneration = getMessageWriteGeneration(sessionId),
  reason: MessageUpsertReason = 'message-upsert'
): void {
  const normalizedContent =
    typeof msg.content === 'string' || Array.isArray(msg.content)
      ? sanitizeMessageContentForPersistence(msg.content)
      : msg.content
  if (Array.isArray(normalizedContent)) {
    for (const b of normalizedContent) {
      if (
        b &&
        typeof b === 'object' &&
        (b as { type?: unknown }).type === 'tool_use' &&
        (b as { name?: unknown }).name === 'visualize_show_widget'
      ) {
        const input = (b as { input?: Record<string, unknown> }).input ?? {}
        logWidgetTrace('log', '[WidgetTrace] dbUpdateMessage persist', {
          msgId: msg.id,
          toolUseId: (b as { id?: string }).id,
          inputKeys: Object.keys(input),
          widget_code_len: typeof input.widget_code === 'string' ? input.widget_code.length : null
        })
      }
    }
  }
  const payload: MessageUpsertPayload = {
    id: msg.id,
    sessionId,
    role: msg.role,
    content: JSON.stringify(normalizedContent),
    meta: msg.meta ? JSON.stringify(msg.meta) : null,
    createdAt: msg.createdAt,
    usage: msg.usage ? JSON.stringify(msg.usage) : null,
    sortOrder,
    debugReason: reason
  }
  const persistKey = buildMessagePersistKey(payload, sortOrder, expectedGeneration)
  const pendingKey = buildPendingMessageUpsertKey(sessionId, msg.id)
  const existingPending = _pendingMessageUpserts.get(pendingKey)
  if (_lastScheduledMessagePersistKeys.get(msg.id) === persistKey) {
    if (existingPending && !shouldCoalesceMessageUpsert(reason)) {
      flushPendingMessageUpsert(sessionId, msg.id)
    }
    logMessageUpsertDebug('[ChatStore] db:messages:upsert skipped duplicate payload', {
      sessionId,
      messageId: msg.id,
      reason,
      revision: getMessageRevision(msg),
      sortOrder,
      expectedGeneration,
      fingerprint: buildMessagePayloadFingerprint(payload)
    })
    return
  }
  rememberScheduledMessagePersist(msg.id, persistKey)
  if (!shouldCoalesceMessageUpsert(reason)) {
    if (existingPending) {
      if (existingPending.timer) clearTimeout(existingPending.timer)
      _pendingMessageUpserts.delete(pendingKey)
    }
    dispatchMessageUpsert({
      timer: null,
      sessionId,
      messageId: msg.id,
      sortOrder,
      expectedGeneration,
      reason,
      payload,
      traceMessage: msg
    })
    return
  }

  if (existingPending) {
    if (existingPending.timer) clearTimeout(existingPending.timer)
  }
  const pendingUpsert: PendingMessageUpsert = {
    timer: setTimeout(
      () => {
        dispatchMessageUpsert(pendingUpsert)
      },
      getMessageUpsertCoalesceMs(sessionId, reason)
    ),
    sessionId,
    messageId: msg.id,
    sortOrder,
    expectedGeneration,
    reason,
    payload,
    traceMessage: msg
  }
  _pendingMessageUpserts.set(pendingKey, pendingUpsert)
}

function dbClearMessages(sessionId: string): void {
  bumpMessageWriteGeneration(sessionId)
  clearPendingMessageUpsertsForSession(sessionId)
  enqueueSessionMessageWrite(sessionId, () =>
    invokeMessagePack(DB_MESSAGES_CLEAR_MSGPACK_CHANNEL, sessionId)
  )
}

function dbDeleteMessage(sessionId: string, messageId: string): void {
  clearPendingMessageUpsert(sessionId, messageId)
  const generation = getMessageWriteGeneration(sessionId)
  const pending = enqueueSessionMessageWrite(
    sessionId,
    () => invokeMessagePack(DB_MESSAGES_DELETE_MSGPACK_CHANNEL, { sessionId, messageId }),
    generation
  )
  trackPendingMessageWrite([messageId], pending)
}

function dbTruncateMessagesFrom(sessionId: string, fromSortOrder: number): void {
  bumpMessageWriteGeneration(sessionId)
  clearPendingMessageUpsertsForSession(sessionId, fromSortOrder)
  enqueueSessionMessageWrite(sessionId, () =>
    invokeMessagePack(DB_MESSAGES_TRUNCATE_FROM_MSGPACK_CHANNEL, { sessionId, fromSortOrder })
  )
}

function dbListMessages(sessionId: string): Promise<MessageRow[]> {
  return invokeMessagePackBinary<MessageRow[]>(DB_MESSAGES_LIST_MSGPACK_CHANNEL, sessionId)
}

function dbListMessagesPage(args: {
  sessionId: string
  limit: number
  offset: number
}): Promise<MessageRow[]> {
  return invokeMessagePackBinary<MessageRow[]>(DB_MESSAGES_LIST_PAGE_MSGPACK_CHANNEL, args)
}

function dbListMessagesRequestContext(args: {
  sessionId: string
  maxMessages: number
  headLimit?: number
}): Promise<MessageRow[]> {
  return invokeMessagePackBinary<MessageRow[]>(DB_MESSAGES_REQUEST_CONTEXT_MSGPACK_CHANNEL, args)
}

function dbListMessagesWindowAround(args: {
  sessionId: string
  messageId?: string | null
  sortOrder?: number | null
  limit: number
}): Promise<MessageWindowResult> {
  return invokeMessagePackBinary<MessageWindowResult>(
    DB_MESSAGES_WINDOW_AROUND_MSGPACK_CHANNEL,
    args
  )
}

async function dbInsertCompactArtifacts(
  sessionId: string,
  artifacts: UnifiedMessage[],
  options: {
    insertBeforeMessageId?: string | null
    insertSortOrder: number
  }
): Promise<MessageInsertArtifactsResult> {
  const generation = getMessageWriteGeneration(sessionId)
  let result: MessageInsertArtifactsResult | null = null
  const artifactIds = artifacts.map((artifact) => artifact.id)

  if (options.insertBeforeMessageId) {
    flushPendingMessageUpsert(sessionId, options.insertBeforeMessageId)
  }
  for (const artifactId of artifactIds) {
    clearPendingMessageUpsert(sessionId, artifactId)
  }

  const pending = enqueueSessionMessageWrite(
    sessionId,
    async () => {
      result = await invokeMessagePack<MessageInsertArtifactsResult>(
        DB_MESSAGES_INSERT_ARTIFACTS_MSGPACK_CHANNEL,
        {
          sessionId,
          insertBeforeMessageId: options.insertBeforeMessageId ?? null,
          insertSortOrder: Math.max(0, Math.floor(options.insertSortOrder)),
          messages: artifacts.map((msg, index) => ({
            id: msg.id,
            role: msg.role,
            content: JSON.stringify(sanitizeMessageContentForPersistence(msg.content)),
            meta: msg.meta ? JSON.stringify(msg.meta) : null,
            createdAt: msg.createdAt,
            usage: msg.usage ? JSON.stringify(msg.usage) : null,
            sortOrder: Math.max(0, Math.floor(options.insertSortOrder)) + index
          }))
        }
      )
    },
    generation
  )
  trackPendingMessageWrite(artifactIds, pending)
  await pending

  const resolvedResult = result as MessageInsertArtifactsResult | null
  if (!resolvedResult) {
    throw new Error('Compact artifact insert was skipped by a newer message rewrite')
  }
  if (!resolvedResult.success) {
    throw new Error(resolvedResult.error || 'Compact artifact insert failed')
  }
  return resolvedResult
}

// --- Debounced message persistence for streaming ---

const _pendingFlush = new Map<string, ReturnType<typeof setTimeout>>()
const _streamingDirtyMessageIds = new Set<string>()
const _activeStreamingMessageIds = new Set<string>()
const _lastPersistedMessageRevisions = new Map<string, number>()
const _lastPersistedMessageContentSizes = new Map<string, number>()
const _lastScheduledMessagePersistKeys = new Map<string, string>()

const MAX_PERSISTED_MESSAGE_REVISION_CACHE = 2_000
// Streaming deltas update the renderer every frame, but DB persistence only needs
// a crash-recovery checkpoint. Keep this deliberately coarse and force one final
// write when streaming ends.
const STREAMING_PERIODIC_FLUSH_MS = 30_000
const _streamingFlushIntervals = new Map<
  string,
  { msgId: string; intervalId: ReturnType<typeof setInterval> }
>()

function shouldLogWidgetTrace(): boolean {
  try {
    return localStorage.getItem('openCowork.widgetTrace') === '1'
  } catch {
    return false
  }
}

function logWidgetTrace(
  level: 'log' | 'trace',
  message: string,
  details: Record<string, unknown>
): void {
  if (!shouldLogWidgetTrace()) return
  console[level](message, details)
}

function getMessageRevision(msg: UnifiedMessage): number {
  return msg._revision ?? 0
}

function rememberPersistedMessageRevision(msg: UnifiedMessage): void {
  _lastPersistedMessageRevisions.set(msg.id, getMessageRevision(msg))
  while (_lastPersistedMessageRevisions.size > MAX_PERSISTED_MESSAGE_REVISION_CACHE) {
    const oldest = _lastPersistedMessageRevisions.keys().next().value
    if (!oldest) break
    _lastPersistedMessageRevisions.delete(oldest)
  }
}

function hasPersistedCurrentRevision(msg: UnifiedMessage): boolean {
  return _lastPersistedMessageRevisions.get(msg.id) === getMessageRevision(msg)
}

function estimateMessagePersistenceSize(msg: UnifiedMessage): number {
  if (typeof msg.content === 'string') return msg.content.length
  try {
    return JSON.stringify(msg.content).length
  } catch {
    return 0
  }
}

function buildMessagePersistKey(
  payload: MessageUpsertPayload,
  sortOrder: number,
  expectedGeneration: number
): string {
  return `${expectedGeneration}:${sortOrder}:${buildMessagePayloadFingerprint(payload)}`
}

function rememberScheduledMessagePersist(messageId: string, persistKey: string): void {
  _lastScheduledMessagePersistKeys.set(messageId, persistKey)
  while (_lastScheduledMessagePersistKeys.size > MAX_PERSISTED_MESSAGE_REVISION_CACHE) {
    const oldest = _lastScheduledMessagePersistKeys.keys().next().value
    if (!oldest) break
    _lastScheduledMessagePersistKeys.delete(oldest)
  }
}

function flushStreamingMessageIfDirty(
  sessionId: string,
  msgId: string,
  getState: () => ChatStore,
  force = false
): void {
  if (!force) {
    flushDeferredMessageAdds(sessionId)
  }

  const isDirty = _streamingDirtyMessageIds.has(msgId)
  if (!force && !isDirty) return

  const session = getSessionByIdFromState(getState(), sessionId)
  const msg = session?.messages.find((m) => m.id === msgId)
  if (!msg) {
    _streamingDirtyMessageIds.delete(msgId)
    return
  }

  if (hasPersistedCurrentRevision(msg)) {
    _streamingDirtyMessageIds.delete(msgId)
    logMessageUpsertDebug('[ChatStore] streaming flush skipped current revision', {
      sessionId,
      msgId,
      force,
      revision: getMessageRevision(msg)
    })
    return
  }

  const contentSize = estimateMessagePersistenceSize(msg)
  const previousContentSize = _lastPersistedMessageContentSizes.get(msg.id)
  if (
    !force &&
    previousContentSize !== undefined &&
    Math.abs(contentSize - previousContentSize) < MESSAGE_UPSERT_MIN_CHANGED_CHARS
  ) {
    logMessageUpsertDebug('[ChatStore] streaming checkpoint skipped small content delta', {
      sessionId,
      msgId,
      revision: getMessageRevision(msg),
      changedChars: Math.abs(contentSize - previousContentSize),
      minChangedChars: MESSAGE_UPSERT_MIN_CHANGED_CHARS
    })
    return
  }

  _streamingDirtyMessageIds.delete(msgId)
  dbUpsertMessage(
    sessionId,
    msg,
    resolveMessageSortOrder(session, msgId),
    undefined,
    force ? 'streaming-final' : 'streaming-checkpoint'
  )
  rememberPersistedMessageRevision(msg)
  _lastPersistedMessageContentSizes.set(msg.id, contentSize)
  logMessageUpsertDebug('[ChatStore] streaming flush persisted', {
    sessionId,
    msgId,
    force,
    revision: getMessageRevision(msg),
    intervalMs: STREAMING_PERIODIC_FLUSH_MS
  })
}

function startStreamingPeriodicFlush(
  sessionId: string,
  msgId: string,
  getState: () => ChatStore
): void {
  const existing = _streamingFlushIntervals.get(sessionId)
  if (existing?.msgId === msgId) return

  stopStreamingPeriodicFlush(sessionId)
  const intervalId = setInterval(() => {
    flushStreamingMessageIfDirty(sessionId, msgId, getState)
  }, STREAMING_PERIODIC_FLUSH_MS)
  _streamingFlushIntervals.set(sessionId, { msgId, intervalId })
}

function stopStreamingPeriodicFlush(sessionId: string): void {
  const entry = _streamingFlushIntervals.get(sessionId)
  if (entry) {
    clearInterval(entry.intervalId)
    _streamingFlushIntervals.delete(sessionId)
  }
}
const _deferredMessageAdds: Array<{
  sessionId: string
  msg: UnifiedMessage
  sortOrder: number
}> = []

function clearDeferredMessageAdds(sessionId: string, fromSortOrder = 0): void {
  for (let i = _deferredMessageAdds.length - 1; i >= 0; i--) {
    const entry = _deferredMessageAdds[i]
    if (entry.sessionId === sessionId && entry.sortOrder >= fromSortOrder) {
      _deferredMessageAdds.splice(i, 1)
    }
  }
}

function clearDeferredMessageAddById(sessionId: string, messageId: string): void {
  for (let i = _deferredMessageAdds.length - 1; i >= 0; i--) {
    const entry = _deferredMessageAdds[i]
    if (entry.sessionId === sessionId && entry.msg.id === messageId) {
      _deferredMessageAdds.splice(i, 1)
    }
  }
}

function flushDeferredMessageAdds(sessionId: string): number {
  const toFlush: typeof _deferredMessageAdds = []
  for (let i = _deferredMessageAdds.length - 1; i >= 0; i--) {
    if (_deferredMessageAdds[i].sessionId === sessionId) {
      toFlush.push(_deferredMessageAdds[i])
      _deferredMessageAdds.splice(i, 1)
    }
  }
  if (toFlush.length === 0) return 0
  toFlush.reverse()
  dbAddMessageBatch(
    sessionId,
    toFlush.map(({ msg, sortOrder }) => ({ msg, sortOrder }))
  )
  return toFlush.length
}

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
const _streamingBackfillBlockedSessionIds = new Set<string>()

function stripThinkTagMarkers(text: string): string {
  return text.replace(/<\s*\/?\s*think\s*>/gi, '')
}

function dbFlushMessage(sessionId: string, msg: UnifiedMessage): void {
  if (_activeStreamingMessageIds.has(msg.id)) {
    _streamingDirtyMessageIds.add(msg.id)
    return
  }
  if (Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (
        b &&
        typeof b === 'object' &&
        (b as { type?: unknown }).type === 'tool_use' &&
        (b as { name?: unknown }).name === 'visualize_show_widget'
      ) {
        const input = (b as { input?: Record<string, unknown> }).input ?? {}
        if (Object.keys(input).length === 0) {
          logWidgetTrace('trace', '[WidgetTrace] dbFlushMessage sees EMPTY input', {
            msgId: msg.id,
            toolUseId: (b as { id?: string }).id
          })
        }
      }
    }
  }
  const key = msg.id
  const generation = getMessageWriteGeneration(sessionId)
  const existing = _pendingFlush.get(key)
  if (existing) clearTimeout(existing)
  _pendingFlush.set(
    key,
    setTimeout(() => {
      _pendingFlush.delete(key)
      const session = getSessionByIdFromState(useChatStore.getState(), sessionId)
      dbUpsertMessage(
        sessionId,
        msg,
        resolveMessageSortOrder(session, msg.id),
        generation,
        'message-debounce'
      )
    }, 2000)
  )
}

function dbFlushMessageImmediate(sessionId: string, msg: UnifiedMessage): void {
  if (_activeStreamingMessageIds.has(msg.id)) {
    _streamingDirtyMessageIds.add(msg.id)
    return
  }
  const existing = _pendingFlush.get(msg.id)
  if (existing) {
    clearTimeout(existing)
    _pendingFlush.delete(msg.id)
  }
  const session = getSessionByIdFromState(useChatStore.getState(), sessionId)
  dbUpsertMessage(
    sessionId,
    msg,
    resolveMessageSortOrder(session, msg.id),
    undefined,
    'message-immediate'
  )
}

function clearPendingMessageFlushes(messageIds: string[]): void {
  const messageIdSet = new Set(messageIds)
  for (const [key, pendingUpsert] of _pendingMessageUpserts.entries()) {
    if (!messageIdSet.has(pendingUpsert.messageId)) continue
    if (pendingUpsert.timer) clearTimeout(pendingUpsert.timer)
    _pendingMessageUpserts.delete(key)
  }
  for (const messageId of messageIds) {
    _lastPersistedMessageRevisions.delete(messageId)
    _lastPersistedMessageContentSizes.delete(messageId)
    _lastScheduledMessagePersistKeys.delete(messageId)
    const pending = _pendingFlush.get(messageId)
    if (!pending) continue
    clearTimeout(pending)
    _pendingFlush.delete(messageId)
  }
}

function scheduleAfterNextPaint(callback: () => void): void {
  if (typeof window === 'undefined') {
    setTimeout(callback, 0)
    return
  }
  window.requestAnimationFrame(() => {
    window.setTimeout(callback, 0)
  })
}

function cleanupDeletedSessionMessages(messageIds: string[]): void {
  if (messageIds.length === 0) return
  clearPendingMessageFlushes(messageIds)
  for (const messageId of messageIds) {
    _streamingDirtyMessageIds.delete(messageId)
  }
}

let _deferredSessionMaintenanceToken = 0
let _deferredSessionMaintenanceTimer: ReturnType<typeof setTimeout> | null = null
let _activeSessionHydrationToken = 0

function scheduleDeferredSessionMaintenance(getState: () => ChatStore, delayMs = 160): void {
  const token = ++_deferredSessionMaintenanceToken
  if (_deferredSessionMaintenanceTimer) {
    clearTimeout(_deferredSessionMaintenanceTimer)
    _deferredSessionMaintenanceTimer = null
  }

  scheduleAfterNextPaint(() => {
    if (token !== _deferredSessionMaintenanceToken) return
    _deferredSessionMaintenanceTimer = setTimeout(() => {
      if (token !== _deferredSessionMaintenanceToken) return
      _deferredSessionMaintenanceTimer = null
      getState().releaseDormantSessions()
    }, delayMs)
  })
}

function scheduleActiveSessionHydration(
  getState: () => ChatStore,
  sessionId: string,
  options: { fallbackPlanId?: string | null } = {}
): void {
  const token = ++_activeSessionHydrationToken
  scheduleAfterNextPaint(() => {
    if (token !== _activeSessionHydrationToken) return
    if (getState().activeSessionId !== sessionId) return

    void useTaskStore.getState().loadTasksForSession(sessionId)
    void getState()
      .loadRecentSessionMessages(sessionId)
      .finally(() => scheduleDeferredSessionMaintenance(getState))

    void usePlanStore
      .getState()
      .loadPlanForSession(sessionId)
      .then((loadedPlan) => {
        if (token !== _activeSessionHydrationToken) return
        if (getState().activeSessionId !== sessionId) return
        usePlanStore.getState().setActivePlan(loadedPlan?.id ?? options.fallbackPlanId ?? null)
      })
  })
}

function cancelActiveSessionHydration(): void {
  _activeSessionHydrationToken += 1
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
  if (idx !== undefined) {
    const candidate = state.sessions[idx]
    if (candidate && candidate.id === sessionId) return candidate
  }
  // Defensive: if the index is stale or missing (e.g. external mutation slipped through),
  // fall back to a linear scan instead of treating an existing session as absent.
  return state.sessions.find((s) => s.id === sessionId)
}

function getResidentSessionScore(session: Session): number {
  return (
    (session.messagesLoaded ? 1_000_000 : 0) +
    session.messages.length * 1_000 +
    Math.max(0, session.loadedRangeEnd - session.loadedRangeStart)
  )
}

function chooseResidentSession(left: Session, right: Session): Session {
  const leftScore = getResidentSessionScore(left)
  const rightScore = getResidentSessionScore(right)
  if (rightScore > leftScore) return right
  if (leftScore > rightScore) return left
  return right.updatedAt > left.updatedAt ? right : left
}

function copyResidentSessionState(target: Session, source: Session): void {
  target.messages = source.messages
  target.messageCount = source.messageCount
  target.messagesLoaded = source.messagesLoaded
  target.loadedRangeStart = source.loadedRangeStart
  target.loadedRangeEnd = source.loadedRangeEnd
  target.lastKnownMessageCount = source.lastKnownMessageCount
  target.promptSnapshot = source.promptSnapshot
  target.pluginChatType = source.pluginChatType
  target.pluginSenderId = source.pluginSenderId
  target.pluginSenderName = source.pluginSenderName
}

function dedupeSessionsById(
  state: { sessions: Session[]; sessionsById: Record<string, number> },
  sessionId: string
): Session | undefined {
  const matches = state.sessions.filter((session) => session.id === sessionId)
  if (matches.length === 0) return undefined

  const keeper = matches.reduce(chooseResidentSession)
  for (const duplicate of matches) {
    if (duplicate === keeper) continue
    if (chooseResidentSession(keeper, duplicate) === duplicate) {
      copyResidentSessionState(keeper, duplicate)
    }
    keeper.updatedAt = Math.max(keeper.updatedAt, duplicate.updatedAt)
    keeper.createdAt = Math.min(keeper.createdAt, duplicate.createdAt)
    keeper.pluginChatType = keeper.pluginChatType ?? duplicate.pluginChatType
    keeper.pluginSenderId = keeper.pluginSenderId ?? duplicate.pluginSenderId
    keeper.pluginSenderName = keeper.pluginSenderName ?? duplicate.pluginSenderName
    keeper.promptSnapshot = keeper.promptSnapshot ?? duplicate.promptSnapshot
  }

  if (matches.length > 1) {
    state.sessions = state.sessions.filter(
      (session) => session.id !== sessionId || session === keeper
    )
  }
  syncSessionsById(state)
  return keeper
}

const MESSAGE_LOAD_SNAPSHOT_TAIL_SIZE = 8

function matchesMessageLoadSnapshot(
  session: Pick<Session, 'messageCount' | 'messages'> | undefined,
  expectedMessageCount: number,
  expectedTailMessageIds: string[]
): boolean {
  if (!session) return false
  const currentKnownCount = session.messageCount ?? session.messages.length
  if (currentKnownCount !== expectedMessageCount) return false
  if (expectedTailMessageIds.length === 0) return true
  if (session.messages.length === 0) return true

  const currentTailMessageIds = session.messages
    .slice(-expectedTailMessageIds.length)
    .map((message) => message.id)

  return (
    currentTailMessageIds.length === expectedTailMessageIds.length &&
    currentTailMessageIds.every((messageId, index) => messageId === expectedTailMessageIds[index])
  )
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
  loadMessageWindowAround: (
    sessionId: string,
    anchor: { messageId?: string | null; sortOrder?: number | null },
    limit?: number
  ) => Promise<void>
  loadSessionMessages: (sessionId: string, force?: boolean) => Promise<void>
  loadWindowSessionMessages: (sessionId: string, offset: number, limit: number) => Promise<void>
  insertCompactArtifacts: (
    sessionId: string,
    artifacts: UnifiedMessage[],
    options?: {
      insertBeforeMessageId?: string | null
      insertSortOrder?: number | null
      insertAtEnd?: boolean
    }
  ) => Promise<boolean>
  getSessionMessagesForRequest: (
    sessionId: string,
    options?: {
      includeTrailingAssistantPlaceholder?: boolean
      requestContextMaxMessages?: number | null
    }
  ) => Promise<UnifiedMessage[]>
  getFullSessionMessagesForMutation: (sessionId: string) => Promise<UnifiedMessage[]>
  ensureDefaultProject: () => Promise<Project | null>

  // Project CRUD
  setActiveProject: (id: string | null) => void
  setActiveProjectHome: (id: string | null) => void
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
  setSessionModelManual: (sessionId: string, providerId: string, modelId: string) => void
  setSessionModelAuto: (sessionId: string) => void
  setSessionModelInherit: (sessionId: string) => void
  updateSessionModel: (sessionId: string, providerId: string, modelId: string) => void
  clearSessionModelBinding: (sessionId: string) => void
  setSessionPlanId: (sessionId: string, planId: string | null) => void
  setSessionPromptSnapshot: (sessionId: string, snapshot: SessionPromptSnapshot) => void
  clearSessionPromptSnapshot: (sessionId: string) => void
  clearSessionMessages: (sessionId: string) => void
  duplicateSession: (sessionId: string) => Promise<string | null>
  forkSessionFromMessage: (sessionId: string, messageId: string) => Promise<string | null>
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
  beginUserTurn: (
    sessionId: string,
    userMsg: UnifiedMessage | null,
    assistantMsg: UnifiedMessage | null,
    streamingMessageId: string | null
  ) => void
  updateMessage: (sessionId: string, msgId: string, patch: Partial<UnifiedMessage>) => void
  removeMessageById: (sessionId: string, msgId: string) => boolean
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
  imageGenerationTimings: Record<string, ImageGenerationTiming>
  generatingImagePreviews: Record<string, ImageBlock>
  setGeneratingImage: (msgId: string, generating: boolean, occurredAt?: number) => void
  setGeneratingImagePreview: (msgId: string, preview: ImageBlock | null) => void

  // Helpers
  getActiveSession: () => Session | undefined
  getLatestSessionByPlanId: (planId: string) => Session | undefined
  getSessionMessages: (sessionId: string) => UnifiedMessage[]
  recoverFromRendererOom: (sessionId?: string | null) => Promise<void>
  releaseDormantSessions: () => void
  trimResidentMessageWindows: () => void
  scheduleSessionMaintenance: () => void
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
  model_selection_mode?: string | null
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

interface MessageWindowResult {
  success: boolean
  rows: MessageRow[]
  start: number
  end: number
  total: number
  anchorSortOrder: number
  error?: string | null
}

interface MessageInsertArtifactsResult {
  success: boolean
  inserted: number
  start: number
  end: number
  total: number
  error?: string | null
}

type SyncedSessionRow = SessionRow

// Initial tail shown the instant the user switches into a session. Small on
// purpose so the switch renders in ~1 frame. Older history streams in via
// the scroll-to-top load-more row.
const INITIAL_SESSION_DISPLAY_PAGE_SIZE = 30
// Page size used when the user scrolls up past the top of the resident window.
const RECENT_SESSION_MESSAGE_PAGE_SIZE = 30
const MIN_INITIAL_SESSION_MESSAGE_PAGE_SIZE = 5
const MESSAGE_WINDOW_MAX_SIZE = 120
const MESSAGE_WINDOW_TAIL_PRESERVE = 60
const REQUEST_CONTEXT_MAX_MESSAGES = 160
const REQUEST_CONTEXT_HEAD_MESSAGES = 12
const REQUEST_CONTEXT_SAFE_BOUNDARY_SCAN = 12

function normalizeSessionModelSelectionMode(
  value?: string | null,
  providerId?: string | null,
  modelId?: string | null
): SessionModelSelectionMode {
  if (providerId && modelId && value !== 'auto') return 'manual'
  if (value === 'inherit' || value === 'auto' || value === 'manual') return value
  return 'inherit'
}

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
    modelSelectionMode: normalizeSessionModelSelectionMode(
      row.model_selection_mode,
      row.provider_id,
      row.model_id
    ),
    providerId: row.provider_id ?? undefined,
    modelId: row.model_id ?? undefined
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
  session.modelSelectionMode = next.modelSelectionMode
  session.providerId = next.providerId
  session.modelId = next.modelId
  // When preserveLoadedMessages is true the in-memory state may already be
  // ahead of the DB snapshot (e.g. beginUserTurn appended messages that the
  // fire-and-forget persist hasn't landed yet). Accepting a stale lower count
  // would wipe those resident messages and leave MessageList empty.
  if (preserveLoadedMessages && next.messageCount < session.messageCount) {
    return
  }

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
  return cloneMessagesForNewSession(source)
}

function cloneMessagesForNewSession(messages: UnifiedMessage[]): UnifiedMessage[] {
  const cloned = JSON.parse(JSON.stringify(messages)) as UnifiedMessage[]
  return cloned.map((message) => {
    const next = {
      ...message,
      id: nanoid()
    }
    delete next._revision
    return next
  })
}

function trimSessionMessageWindow(session: Session, preserve: 'head' | 'tail' = 'tail'): void {
  if (session.messages.length <= MESSAGE_WINDOW_MAX_SIZE) return
  const removableCount = session.messages.length - MESSAGE_WINDOW_MAX_SIZE

  if (preserve === 'head') {
    const trimCount = Math.min(removableCount, session.messages.length)
    if (trimCount <= 0) return
    session.messages.splice(session.messages.length - trimCount, trimCount)
    session.loadedRangeEnd = Math.max(session.loadedRangeStart, session.loadedRangeEnd - trimCount)
    return
  }

  const maxRemovable = Math.max(0, session.messages.length - MESSAGE_WINDOW_TAIL_PRESERVE)
  const trimCount = Math.min(removableCount, maxRemovable)
  if (trimCount <= 0) return
  session.messages.splice(0, trimCount)
  session.loadedRangeStart = Math.min(session.messageCount, session.loadedRangeStart + trimCount)
}

function getMessageWindowPreserveMode(
  session: Session,
  fallback: 'head' | 'tail'
): 'head' | 'tail' {
  const status = useAgentStore.getState().runningSessions[session.id]
  if (status === 'running' || status === 'retrying') return 'tail'
  if (session.messages.some((message) => hasPendingLocalMessageWrite(message.id))) return 'tail'
  return fallback
}

function backfillStreamingMessage(
  state: Pick<ChatStore, 'activeSessionId' | 'streamingMessageId' | 'streamingMessages'>,
  sessionId: string,
  msgId: string
): void {
  if (_streamingBackfillBlockedSessionIds.has(sessionId)) return
  if (state.streamingMessages[sessionId] !== msgId) {
    state.streamingMessages[sessionId] = msgId
  }
  if (sessionId === state.activeSessionId && state.streamingMessageId !== msgId) {
    state.streamingMessageId = msgId
  }
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

  // Any session that is currently executing (agent loop, sub-agents, background
  // processes, or team runtime) must stay resident. Otherwise a brief window
  // between execution phases (when streamingMessages is temporarily empty) can
  // cause its messages to be wiped and force MessageList into its skeleton
  // branch, producing a visible flash.
  const agentState = useAgentStore.getState()
  for (const [sessionId, status] of Object.entries(agentState.runningSessions)) {
    if (status) residentSessionIds.add(sessionId)
  }
  if (agentState.runningSubAgentSessionIdsSig) {
    for (const sessionId of agentState.runningSubAgentSessionIdsSig.split('\u0000')) {
      if (sessionId) residentSessionIds.add(sessionId)
    }
  }
  for (const process of Object.values(agentState.backgroundProcesses)) {
    if (process.sessionId && process.status === 'running') {
      residentSessionIds.add(process.sessionId)
    }
  }
  const activeTeamSessionId = useTeamStore.getState().activeTeam?.sessionId
  if (activeTeamSessionId) {
    residentSessionIds.add(activeTeamSessionId)
  }

  return residentSessionIds
}

function releaseDormantSessionMemory(
  state: Pick<
    ChatStore,
    | 'sessions'
    | 'activeSessionId'
    | 'streamingMessages'
    | 'generatingImageMessages'
    | 'imageGenerationTimings'
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
  for (const messageId of Object.keys(state.imageGenerationTimings)) {
    if (releasedMessageIds.has(messageId)) {
      delete state.imageGenerationTimings[messageId]
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

function normalizeRequestContextMaxMessages(value?: number | null): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return REQUEST_CONTEXT_MAX_MESSAGES
  }
  return Math.max(MIN_INITIAL_SESSION_MESSAGE_PAGE_SIZE, Math.floor(value))
}

function clampRequestContext(
  messages: UnifiedMessage[],
  maxMessagesArg?: number | null
): UnifiedMessage[] {
  const maxMessages = normalizeRequestContextMaxMessages(maxMessagesArg)
  if (maxMessages === null || messages.length <= maxMessages) return messages

  let boundary = Math.max(1, messages.length - maxMessages)
  for (let attempt = 0; attempt < REQUEST_CONTEXT_SAFE_BOUNDARY_SCAN; attempt += 1) {
    if (!hasToolReferenceSplit(messages, boundary)) break
    boundary = Math.max(1, boundary - 1)
  }

  return messages.slice(boundary)
}

function clampWindowedRequestContext(
  messages: UnifiedMessage[],
  maxMessagesArg?: number | null
): UnifiedMessage[] {
  const maxMessages = normalizeRequestContextMaxMessages(maxMessagesArg)
  if (maxMessages === null || messages.length <= maxMessages) return messages

  const headCount = Math.min(
    REQUEST_CONTEXT_HEAD_MESSAGES,
    Math.max(0, Math.floor(maxMessages / 4))
  )
  const selectedIds = new Set<string>()
  for (const message of messages.slice(0, headCount)) {
    selectedIds.add(message.id)
  }
  for (const message of messages) {
    if (isCompactArtifactMessage(message)) {
      selectedIds.add(message.id)
    }
  }

  const tailBudget = Math.max(1, maxMessages - selectedIds.size)
  for (const message of messages.slice(-tailBudget)) {
    selectedIds.add(message.id)
  }

  return messages.filter((message) => selectedIds.has(message.id))
}

function isUiOnlyRequestMessage(message: UnifiedMessage): boolean {
  if (message.role !== 'system') return false
  if (message.meta?.compressionStatus) return true
  if (message.meta?.compactBoundary) return false
  if (typeof message.content === 'string') return message.content.trim().length === 0
  return Array.isArray(message.content) && message.content.length === 0
}

function stripThinkingBlocksForCompactRequest(message: UnifiedMessage): UnifiedMessage {
  if (!Array.isArray(message.content)) return message

  const content = message.content.filter((block) => block.type !== 'thinking')
  if (content.length === message.content.length) return message

  return { ...message, content }
}

function appendCompactRequestMessage(
  result: UnifiedMessage[],
  seenIds: Set<string>,
  message: UnifiedMessage | undefined,
  activeCompact: ActiveCompactArtifacts
): void {
  if (!message || seenIds.has(message.id) || isUiOnlyRequestMessage(message)) return
  if (isCompactArtifactMessage(message)) {
    if (isCompactBoundaryMessage(message)) {
      if (message.id !== activeCompact.boundaryId) return
    } else if (message.id !== activeCompact.summaryId) {
      return
    }
  }

  result.push(stripThinkingBlocksForCompactRequest(message))
  seenIds.add(message.id)
}

function collectCompactPreservedMessages(
  messages: UnifiedMessage[],
  boundaryMessage: UnifiedMessage | undefined,
  activeCompact: ActiveCompactArtifacts
): UnifiedMessage[] {
  const preservedSegment = boundaryMessage?.meta?.compactBoundary?.preservedSegment
  const preservedHeadId = preservedSegment?.headId?.trim() ?? ''
  const preservedTailId = preservedSegment?.tailId?.trim() ?? ''
  if (!preservedHeadId || !preservedTailId) return []

  const headIndex = messages.findIndex((message) => message.id === preservedHeadId)
  if (headIndex < 0) return []

  let tailIndex = -1
  for (let index = headIndex; index < messages.length; index += 1) {
    if (messages[index]?.id === preservedTailId) {
      tailIndex = index
      break
    }
  }
  if (tailIndex < headIndex) return []

  const preservedMessages: UnifiedMessage[] = []
  const seenIds = new Set<string>()
  for (const message of messages.slice(headIndex, tailIndex + 1)) {
    appendCompactRequestMessage(preservedMessages, seenIds, message, activeCompact)
  }
  return preservedMessages
}

function applyLatestCompactRequestView(messages: UnifiedMessage[]): UnifiedMessage[] {
  const activeCompact = resolveActiveCompactArtifacts(messages)
  if (!activeCompact || activeCompact.boundaryIndex < 0) {
    return messages.filter((message) => {
      if (isUiOnlyRequestMessage(message)) return false
      if (!isCompactArtifactMessage(message)) return true
      return false
    })
  }

  const compactMessages: UnifiedMessage[] = []
  const seenIds = new Set<string>()
  const boundaryMessage = activeCompact.boundaryId
    ? messages.find((message) => message.id === activeCompact.boundaryId)
    : undefined
  const summaryMessage = activeCompact.summaryId
    ? messages.find((message) => message.id === activeCompact.summaryId)
    : undefined

  appendCompactRequestMessage(compactMessages, seenIds, boundaryMessage, activeCompact)
  appendCompactRequestMessage(compactMessages, seenIds, summaryMessage, activeCompact)

  const preservedMessages = collectCompactPreservedMessages(
    messages,
    boundaryMessage,
    activeCompact
  )
  for (const message of preservedMessages) {
    appendCompactRequestMessage(compactMessages, seenIds, message, activeCompact)
  }

  const trailingStartIndex =
    activeCompact.summaryIndex >= 0
      ? activeCompact.summaryIndex + 1
      : activeCompact.boundaryIndex + 1

  for (const message of messages.slice(Math.max(0, trailingStartIndex))) {
    if (seenIds.has(message.id)) continue
    appendCompactRequestMessage(compactMessages, seenIds, message, activeCompact)
  }

  return compactMessages
}

function mergeResidentTailWithFetchedPrefix(
  residentMessages: UnifiedMessage[],
  fetchedMessages: UnifiedMessage[],
  maxMessagesArg?: number | null
): UnifiedMessage[] {
  if (residentMessages.length === 0) return clampRequestContext(fetchedMessages, maxMessagesArg)
  if (fetchedMessages.length === 0) return clampRequestContext(residentMessages, maxMessagesArg)

  const merged = [...fetchedMessages]
  const seenIds = new Set(fetchedMessages.map((message) => message.id))
  for (const message of residentMessages) {
    if (seenIds.has(message.id)) continue
    merged.push(message)
    seenIds.add(message.id)
  }

  return clampRequestContext(merged, maxMessagesArg)
}

function mergeRequestContextRowsWithResident(
  session: Session,
  fetchedRows: MessageRow[],
  knownCount: number,
  maxMessagesArg?: number | null
): UnifiedMessage[] {
  const maxMessages = normalizeRequestContextMaxMessages(maxMessagesArg)
  const residentMessages = session.messages
  const residentStart =
    session.messagesLoaded && residentMessages.length > 0
      ? Math.max(
          0,
          Math.min(session.loadedRangeStart, session.loadedRangeEnd - residentMessages.length)
        )
      : knownCount
  const requestTailFloor = maxMessages === null ? 0 : Math.max(0, knownCount - maxMessages)
  const entriesById = new Map<
    string,
    { index: number; sequence: number; message: UnifiedMessage }
  >()

  fetchedRows.forEach((row, sequence) => {
    entriesById.set(row.id, {
      index: row.sort_order,
      sequence,
      message: rowToMessage(row)
    })
  })

  residentMessages.forEach((resident, index) => {
    const logicalIndex = Math.max(0, residentStart + index)
    const existing = entriesById.get(resident.id)
    if (existing) {
      const fetched = existing.message
      const message =
        shouldPreferResidentMessage(resident, fetched) || hasPendingLocalMessageWrite(resident.id)
          ? resident
          : resident.usage || fetched.usage
            ? {
                ...fetched,
                usage: mergeUsageSnapshot(resident.usage, fetched.usage)
              }
            : fetched
      entriesById.set(resident.id, {
        index: existing.index,
        sequence: existing.sequence,
        message
      })
      return
    }

    const shouldIncludeResident =
      maxMessages === null ||
      hasPendingLocalMessageWrite(resident.id) ||
      isCompactArtifactMessage(resident) ||
      logicalIndex >= requestTailFloor
    if (!shouldIncludeResident) return

    entriesById.set(resident.id, {
      index: logicalIndex,
      sequence: fetchedRows.length + index,
      message: resident
    })
  })

  const messages = [...entriesById.values()]
    .sort((left, right) => left.index - right.index || left.sequence - right.sequence)
    .map((entry) => entry.message)

  return clampWindowedRequestContext(messages, maxMessages)
}

async function loadRequestContextMessages(
  session: Session,
  maxMessagesArg?: number | null
): Promise<UnifiedMessage[]> {
  const knownCount = session.messageCount ?? session.messages.length
  if (knownCount <= 0) return []
  const maxMessages = normalizeRequestContextMaxMessages(maxMessagesArg)

  const residentMessages = session.messages
  if (maxMessages === null) {
    const msgRows = await dbListMessagesPage({
      sessionId: session.id,
      limit: knownCount,
      offset: 0
    })
    const fetchedMessages = msgRows.map(rowToMessage)
    return mergeResidentTailWithFetchedPrefix(residentMessages, fetchedMessages, maxMessages)
  }

  try {
    const requestRows = await dbListMessagesRequestContext({
      sessionId: session.id,
      maxMessages,
      headLimit: REQUEST_CONTEXT_HEAD_MESSAGES
    })
    if (requestRows.length > 0) {
      return mergeRequestContextRowsWithResident(session, requestRows, knownCount, maxMessages)
    }
  } catch (error) {
    console.warn('[ChatStore] Failed to load request context window:', error)
  }

  if (
    session.messagesLoaded &&
    residentMessages.length > 0 &&
    session.loadedRangeStart === 0 &&
    session.loadedRangeEnd >= knownCount
  ) {
    return clampWindowedRequestContext(residentMessages, maxMessages)
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
  const weightAdjustedLimit =
    maxMessages === null
      ? knownCount
      : residentWeight > 200_000
        ? Math.min(96, maxMessages)
        : maxMessages
  const targetLimit =
    maxMessages === null
      ? knownCount
      : Math.max(MIN_INITIAL_SESSION_MESSAGE_PAGE_SIZE, weightAdjustedLimit)
  const tailCount = Math.min(targetLimit, knownCount)
  const tailOffset = Math.max(0, knownCount - tailCount)

  if (session.messagesLoaded && residentMessages.length > 0 && residentTailStart <= tailOffset) {
    return clampRequestContext(residentMessages, maxMessages)
  }

  const fetchLimit = Math.max(0, residentTailStart - tailOffset)
  if (fetchLimit <= 0) {
    return clampRequestContext(residentMessages, maxMessages)
  }

  const msgRows = await dbListMessagesPage({
    sessionId: session.id,
    limit: fetchLimit,
    offset: tailOffset
  })
  const fetchedMessages = msgRows.map(rowToMessage)
  return mergeResidentTailWithFetchedPrefix(residentMessages, fetchedMessages, maxMessages)
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

function hasPendingLocalMessageWrite(messageId: string): boolean {
  return (
    _activeStreamingMessageIds.has(messageId) ||
    _streamingDirtyMessageIds.has(messageId) ||
    _pendingFlush.has(messageId) ||
    _pendingMessageWriteCounts.has(messageId)
  )
}

function shouldPreferResidentMessage(resident: UnifiedMessage, fetched: UnifiedMessage): boolean {
  if (hasPendingLocalMessageWrite(resident.id)) return true

  const residentWeight = estimateMessageWeight(resident)
  const fetchedWeight = estimateMessageWeight(fetched)
  if (residentWeight > fetchedWeight) return true

  if (resident.usage && !fetched.usage) return true
  if (resident.meta && !fetched.meta) return true
  if (resident.providerResponseId && !fetched.providerResponseId) return true
  if (hasMeaningfulAssistantContent(resident) && !hasMeaningfulAssistantContent(fetched)) {
    return true
  }

  return false
}

function mergeLoadedMessagesWithResident(
  session: Session,
  fetchedMessages: UnifiedMessage[],
  windowStart: number,
  fetchedWindowEnd: number,
  knownCount: number,
  fetchedSortOrders: number[] = []
): {
  messages: UnifiedMessage[]
  messageCount: number
  loadedRangeStart: number
  loadedRangeEnd: number
} {
  if (session.messages.length === 0) {
    return {
      messages: fetchedMessages,
      messageCount: Math.max(knownCount, fetchedWindowEnd),
      loadedRangeStart: windowStart,
      loadedRangeEnd: Math.max(fetchedWindowEnd, windowStart + fetchedMessages.length)
    }
  }

  const residentById = new Map(session.messages.map((message) => [message.id, message]))
  const seen = new Set<string>()
  const entries: Array<{ index: number; sequence: number; message: UnifiedMessage }> = []

  fetchedMessages.forEach((fetched, index) => {
    const resident = residentById.get(fetched.id)
    const preferResident = resident && shouldPreferResidentMessage(resident, fetched)
    const message =
      resident && preferResident
        ? resident
        : resident && (resident.usage || fetched.usage)
          ? {
              ...fetched,
              usage: mergeUsageSnapshot(resident.usage, fetched.usage)
            }
          : fetched
    entries.push({
      index: fetchedSortOrders[index] ?? windowStart + index,
      sequence: index,
      message
    })
    seen.add(fetched.id)
  })

  const residentStart = session.loadedRangeStart ?? 0
  const residentEnd = session.loadedRangeEnd ?? residentStart + session.messages.length
  session.messages.forEach((resident, index) => {
    if (seen.has(resident.id)) return
    const logicalIndex = Math.max(0, residentStart + index)
    const isResidentPrefixOutsideFetchedWindow =
      logicalIndex < windowStart && logicalIndex >= residentStart && logicalIndex < knownCount
    const isLocalTailNotInDbYet =
      logicalIndex >= windowStart &&
      logicalIndex >= fetchedWindowEnd &&
      logicalIndex < knownCount &&
      residentEnd > fetchedWindowEnd
    const isMissingFromShortDbSnapshot =
      logicalIndex >= windowStart &&
      logicalIndex < knownCount &&
      session.messageCount > fetchedMessages.length &&
      residentEnd > fetchedWindowEnd
    if (
      !hasPendingLocalMessageWrite(resident.id) &&
      !isResidentPrefixOutsideFetchedWindow &&
      !isLocalTailNotInDbYet &&
      !isMissingFromShortDbSnapshot
    ) {
      return
    }

    entries.push({
      index: logicalIndex,
      sequence: fetchedMessages.length + index,
      message: resident
    })
    seen.add(resident.id)
  })

  entries.sort((left, right) => left.index - right.index || left.sequence - right.sequence)

  const messages = entries.map((entry) => entry.message)
  const loadedRangeStart =
    entries.length > 0 ? Math.min(windowStart, ...entries.map((entry) => entry.index)) : windowStart
  const loadedRangeEnd =
    entries.length > 0
      ? Math.max(fetchedWindowEnd, ...entries.map((entry) => entry.index + 1))
      : fetchedWindowEnd
  const messageCount = Math.max(knownCount, session.messageCount, loadedRangeEnd)

  return {
    messages,
    messageCount,
    loadedRangeStart,
    loadedRangeEnd
  }
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

function countToolReplayBlocks(messages: UnifiedMessage[]): {
  messages: number
  toolUses: number
  toolResults: number
} {
  let toolUses = 0
  let toolResults = 0
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        toolUses += 1
      } else if (block.type === 'tool_result') {
        toolResults += 1
      }
    }
  }

  return {
    messages: messages.length,
    toolUses,
    toolResults
  }
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
    imageGenerationTimings: {},
    generatingImagePreviews: {},
    _loaded: false,

    ensureDefaultProject: async () => {
      try {
        const row = await invokeMessagePackBinary<ProjectRow | null>(
          DB_PROJECTS_ENSURE_DEFAULT_MSGPACK_CHANNEL,
          {}
        )
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
      const prevSessionId = get().activeSessionId
      let nextSessionId: string | null = null
      set((state) => {
        state.activeProjectId = id
        if (!id) {
          state.activeSessionId = null
          return
        }
        const currentSession = state.sessions.find((s) => s.id === state.activeSessionId)
        if (currentSession?.projectId === id) {
          nextSessionId = state.activeSessionId
          return
        }
        const sessionsInProject = state.sessions
          .filter((s) => s.projectId === id)
          .sort((a, b) => b.updatedAt - a.updatedAt)
        nextSessionId = sessionsInProject[0]?.id ?? null
        state.activeSessionId = nextSessionId
      })
      if (prevSessionId !== nextSessionId) {
        invalidateVisibleSessionCache()
        if (prevSessionId) {
          agentStream.notifySessionVisibility(prevSessionId, false)
        }
        if (nextSessionId) {
          agentStream.notifySessionVisibility(nextSessionId, true)
        }
      }
      useUIStore.getState().syncSessionScopedState(nextSessionId, id)
      scheduleDeferredSessionMaintenance(get)
      if (nextSessionId) {
        const planStore = usePlanStore.getState()
        const cachedPlan = planStore.getPlanBySession(nextSessionId)
        planStore.setActivePlan(cachedPlan?.id ?? null)
        scheduleActiveSessionHydration(get, nextSessionId, {
          fallbackPlanId: cachedPlan?.id ?? null
        })
      } else {
        cancelActiveSessionHydration()
        useTaskStore.getState().clearTasks()
        usePlanStore.getState().setActivePlan(null)
      }
    },

    setActiveProjectHome: (id) => {
      const prevSessionId = get().activeSessionId
      set((state) => {
        state.activeProjectId = id
        state.activeSessionId = null
        state.streamingMessageId = null
      })
      if (prevSessionId) {
        invalidateVisibleSessionCache()
        agentStream.notifySessionVisibility(prevSessionId, false)
      }
      useAgentStore.getState().switchToolCallSession(prevSessionId, null)
      useTaskStore.getState().clearTasks()
      usePlanStore.getState().setActivePlan(null)
      useUIStore.getState().syncSessionScopedState(null, id)
      cancelActiveSessionHydration()
      scheduleDeferredSessionMaintenance(get)
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
        const row = await invokeMessagePackBinary<ProjectRow>(
          DB_PROJECTS_CREATE_MSGPACK_CHANNEL,
          payload
        )
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
        const result = await invokeMessagePackBinary<{
          projectId: string
          sessionIds: string[]
        } | null>(DB_PROJECTS_DELETE_MSGPACK_CHANNEL, projectId)
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
        bumpMessageWriteGeneration(sessionId)
        clearDeferredMessageAdds(sessionId)
        const plan = planState.getPlanBySession(sessionId)
        if (plan) {
          planState.deletePlan(plan.id)
        }
        taskState.deleteSessionTasks(sessionId)
        void removeSessionInputDraft(sessionId)
      }
      scheduleAfterNextPaint(() => cleanupDeletedSessionMessages(deletedMessageIds))
      const liveSessionId = agentState.liveSessionId
      if (liveSessionId && deletedSessionIds.includes(liveSessionId)) {
        agentState.resetLiveSessionExecution(liveSessionId)
        agentState.switchToolCallSession(null, nextActiveSessionId)
      }

      if (nextActiveSessionId) {
        const planStore = usePlanStore.getState()
        const activePlan = planStore.getPlanBySession(nextActiveSessionId)
        planStore.setActivePlan(activePlan?.id ?? null)
        scheduleActiveSessionHydration(get, nextActiveSessionId, {
          fallbackPlanId: activePlan?.id ?? null
        })
      } else {
        cancelActiveSessionHydration()
        useTaskStore.getState().clearTasks()
        usePlanStore.getState().setActivePlan(null)
      }
      useUIStore
        .getState()
        .syncSessionScopedState(nextActiveSessionId, useChatStore.getState().activeProjectId)

      if (shouldEnsureDefaultProject) {
        await get().ensureDefaultProject()
      }
      scheduleDeferredSessionMaintenance(get)
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
      const sessionTailMessageIds = session.messages
        .slice(-MESSAGE_LOAD_SNAPSHOT_TAIL_SIZE)
        .map((message) => message.id)
      const requestedLimit = Math.max(
        MIN_INITIAL_SESSION_MESSAGE_PAGE_SIZE,
        Math.min(
          limit ?? INITIAL_SESSION_DISPLAY_PAGE_SIZE,
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
        let effectiveKnownCount = knownCount
        let windowStart = Math.max(0, effectiveKnownCount - nextLimit)
        let msgRows = await dbListMessagesPage({
          sessionId,
          limit: nextLimit,
          offset: windowStart
        })

        if (msgRows.length === 0) {
          const actualCount = await invokeMessagePackBinary<number>(
            DB_MESSAGES_COUNT_MSGPACK_CHANNEL,
            sessionId
          )
          if (actualCount !== effectiveKnownCount) {
            effectiveKnownCount = actualCount
            windowStart = Math.max(0, effectiveKnownCount - nextLimit)
            msgRows = await dbListMessagesPage({
              sessionId,
              limit: nextLimit,
              offset: windowStart
            })
          }
        }

        let messages = msgRows.map(rowToMessage)
        let messageSortOrders = msgRows.map((row) => row.sort_order)

        while (
          windowStart > 0 &&
          messages.length > 0 &&
          messages.every((message) => isToolResultOnlyUserMessage(message))
        ) {
          const prependCount = Math.min(nextLimit, windowStart)
          const prependOffset = Math.max(0, windowStart - prependCount)
          const prependRows = await dbListMessagesPage({
            sessionId,
            limit: prependCount,
            offset: prependOffset
          })
          const prependMessages = prependRows.map(rowToMessage)
          const prependSortOrders = prependRows.map((row) => row.sort_order)
          if (prependMessages.length === 0) break
          messages = [...prependMessages, ...messages]
          messageSortOrders = [...prependSortOrders, ...messageSortOrders]
          windowStart = prependOffset
        }

        const latestSession = get().sessions.find((s) => s.id === sessionId)
        if (!matchesMessageLoadSnapshot(latestSession, knownCount, sessionTailMessageIds)) {
          return
        }

        set((state) => {
          const target = state.sessions.find((s) => s.id === sessionId)
          if (!target || !matchesMessageLoadSnapshot(target, knownCount, sessionTailMessageIds)) {
            return
          }
          if (
            !force &&
            target.messagesLoaded &&
            target.loadedRangeStart === 0 &&
            target.loadedRangeEnd >= effectiveKnownCount &&
            target.messages.length >= effectiveKnownCount
          ) {
            return
          }
          const merged = mergeLoadedMessagesWithResident(
            target,
            messages,
            windowStart,
            Math.max(windowStart + messages.length, ...messageSortOrders.map((order) => order + 1)),
            effectiveKnownCount,
            messageSortOrders
          )
          target.messages = merged.messages
          target.messagesLoaded = true
          target.messageCount = merged.messageCount
          target.loadedRangeStart = merged.loadedRangeStart
          target.loadedRangeEnd = merged.loadedRangeEnd
          target.lastKnownMessageCount = merged.messageCount
          trimSessionMessageWindow(target, 'tail')
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
        const msgRows = await dbListMessagesPage({
          sessionId,
          limit: nextCount,
          offset
        })
        let olderMessages = msgRows.map(rowToMessage)

        while (
          offset > 0 &&
          olderMessages.length > 0 &&
          olderMessages.every((message) => isToolResultOnlyUserMessage(message))
        ) {
          const prependCount = Math.min(limit, offset)
          const prependOffset = Math.max(0, offset - prependCount)
          const prependRows = await dbListMessagesPage({
            sessionId,
            limit: prependCount,
            offset: prependOffset
          })
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
          trimSessionMessageWindow(target, getMessageWindowPreserveMode(target, 'head'))
        })
        return olderMessages.length
      } catch (err) {
        console.error('[ChatStore] Failed to load older session messages:', err)
        return 0
      }
    },

    loadMessageWindowAround: async (
      sessionId,
      anchor,
      limit = INITIAL_SESSION_DISPLAY_PAGE_SIZE
    ) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session) return
      const safeLimit = Math.max(
        MIN_INITIAL_SESSION_MESSAGE_PAGE_SIZE,
        Math.min(MESSAGE_WINDOW_MAX_SIZE, Math.floor(limit))
      )
      try {
        const result = await dbListMessagesWindowAround({
          sessionId,
          messageId: anchor.messageId,
          sortOrder: anchor.sortOrder,
          limit: safeLimit
        })
        if (!result.success) {
          throw new Error(result.error || 'Failed to load message window')
        }

        const messages = result.rows.map(rowToMessage)
        const messageSortOrders = result.rows.map((row) => row.sort_order)
        set((state) => {
          const target = state.sessions.find((s) => s.id === sessionId)
          if (!target) return
          const merged = mergeLoadedMessagesWithResident(
            target,
            messages,
            result.start,
            result.end,
            result.total,
            messageSortOrders
          )
          target.messages = merged.messages
          target.messagesLoaded = true
          target.messageCount = result.total
          target.loadedRangeStart = merged.loadedRangeStart
          target.loadedRangeEnd = merged.loadedRangeEnd
          target.lastKnownMessageCount = result.total
          trimSessionMessageWindow(
            target,
            getMessageWindowPreserveMode(
              target,
              result.end >= result.total - MESSAGE_WINDOW_TAIL_PRESERVE ? 'tail' : 'head'
            )
          )
        })
      } catch (err) {
        console.error('[ChatStore] Failed to load message window:', err)
      }
    },

    insertCompactArtifacts: async (sessionId, artifacts, options) => {
      const artifactMessages = artifacts.filter(isCompactArtifactMessage)
      if (artifactMessages.length === 0) return false

      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session) return false

      const insertBeforeMessageId = options?.insertBeforeMessageId ?? null
      const insertBeforeIndex = insertBeforeMessageId
        ? session.messages.findIndex((message) => message.id === insertBeforeMessageId)
        : -1
      const fallbackInsertSortOrder =
        typeof options?.insertSortOrder === 'number' && Number.isFinite(options.insertSortOrder)
          ? options.insertSortOrder
          : options?.insertAtEnd
            ? session.messageCount
            : insertBeforeIndex >= 0
              ? session.loadedRangeStart + insertBeforeIndex
              : session.loadedRangeEnd

      let result: MessageInsertArtifactsResult
      try {
        result = await dbInsertCompactArtifacts(sessionId, artifactMessages, {
          insertBeforeMessageId,
          insertSortOrder: fallbackInsertSortOrder
        })
      } catch (err) {
        console.error('[ChatStore] Failed to insert compact artifacts:', err)
        return false
      }

      const now = Date.now()
      const removedArtifactIds: string[] = []
      const insertedArtifactIds = artifactMessages.map((artifact) => artifact.id)

      set((state) => {
        const target = state.sessions.find((s) => s.id === sessionId)
        if (!target) return

        const oldMessageCount = target.messageCount
        const wasLoadedAtTail = target.loadedRangeEnd >= oldMessageCount
        const residentWithoutArtifacts: UnifiedMessage[] = []

        for (const message of target.messages) {
          if (isCompactArtifactMessage(message)) {
            removedArtifactIds.push(message.id)
            continue
          }
          residentWithoutArtifacts.push(message)
        }

        let residentInsertIndex = -1
        if (insertBeforeMessageId) {
          residentInsertIndex = residentWithoutArtifacts.findIndex(
            (message) => message.id === insertBeforeMessageId
          )
        }
        if (
          residentInsertIndex < 0 &&
          result.start >= target.loadedRangeStart &&
          result.start <= target.loadedRangeEnd
        ) {
          residentInsertIndex = Math.min(
            residentWithoutArtifacts.length,
            Math.max(0, result.start - target.loadedRangeStart)
          )
        }
        if (
          residentInsertIndex < 0 &&
          (options?.insertAtEnd ||
            wasLoadedAtTail ||
            result.end >= result.total - MESSAGE_WINDOW_TAIL_PRESERVE)
        ) {
          residentInsertIndex = residentWithoutArtifacts.length
        }

        const revisedArtifacts = artifactMessages.map((artifact) => ({
          ...artifact,
          _revision: (artifact._revision ?? 0) + 1
        }))
        target.messages =
          residentInsertIndex >= 0
            ? [
                ...residentWithoutArtifacts.slice(0, residentInsertIndex),
                ...revisedArtifacts,
                ...residentWithoutArtifacts.slice(residentInsertIndex)
              ]
            : residentWithoutArtifacts
        target.messagesLoaded = target.messages.length > 0 || result.total === 0
        target.messageCount = result.total
        if (wasLoadedAtTail || residentInsertIndex === residentWithoutArtifacts.length) {
          target.loadedRangeEnd = result.total
          target.loadedRangeStart = Math.max(0, result.total - target.messages.length)
          trimSessionMessageWindow(target, 'tail')
        } else {
          target.loadedRangeStart = Math.min(target.loadedRangeStart, result.total)
          target.loadedRangeEnd = Math.min(
            result.total,
            target.loadedRangeStart + target.messages.length
          )
          trimSessionMessageWindow(target, getMessageWindowPreserveMode(target, 'head'))
        }
        target.lastKnownMessageCount = result.total
        target.updatedAt = now
      })

      const touchedArtifactIds = [...new Set([...removedArtifactIds, ...insertedArtifactIds])]
      clearPendingMessageFlushes(touchedArtifactIds)
      for (const messageId of touchedArtifactIds) {
        clearPendingMessageUpsert(sessionId, messageId)
        _streamingDirtyMessageIds.delete(messageId)
      }
      dbUpdateSession(sessionId, { updatedAt: now })
      return true
    },

    loadSessionMessages: async (sessionId, force = false) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session) return
      const knownCount = session.messageCount ?? session.messages.length
      const sessionTailMessageIds = session.messages
        .slice(-MESSAGE_LOAD_SNAPSHOT_TAIL_SIZE)
        .map((message) => message.id)
      const shouldSkip =
        !force &&
        session.messagesLoaded &&
        session.loadedRangeStart === 0 &&
        knownCount <= session.messages.length
      if (shouldSkip) return
      try {
        const msgRows = await dbListMessages(sessionId)
        const messages = msgRows.map(rowToMessage)
        const messageSortOrders = msgRows.map((row) => row.sort_order)
        const latestSession = get().sessions.find((s) => s.id === sessionId)
        if (!matchesMessageLoadSnapshot(latestSession, knownCount, sessionTailMessageIds)) {
          return
        }
        set((state) => {
          const target = state.sessions.find((s) => s.id === sessionId)
          if (!target || !matchesMessageLoadSnapshot(target, knownCount, sessionTailMessageIds)) {
            return
          }
          const merged = mergeLoadedMessagesWithResident(
            target,
            messages,
            0,
            Math.max(messages.length, ...messageSortOrders.map((order) => order + 1)),
            messages.length,
            messageSortOrders
          )
          target.messages = merged.messages
          target.messagesLoaded = true
          target.messageCount = merged.messageCount
          target.loadedRangeStart = merged.loadedRangeStart
          target.loadedRangeEnd = merged.loadedRangeEnd
          target.lastKnownMessageCount = merged.messageCount
        })
      } catch (err) {
        console.error('[ChatStore] Failed to load session messages:', err)
      }
    },

    loadWindowSessionMessages: async (sessionId, offset, limit) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session) return
      const knownCount = session.messageCount ?? session.messages.length
      const sessionTailMessageIds = session.messages
        .slice(-MESSAGE_LOAD_SNAPSHOT_TAIL_SIZE)
        .map((message) => message.id)
      const safeOffset = Math.max(0, offset)
      const safeLimit = Math.max(MIN_INITIAL_SESSION_MESSAGE_PAGE_SIZE, limit)
      try {
        const msgRows = await dbListMessagesPage({
          sessionId,
          limit: safeLimit,
          offset: safeOffset
        })
        const messages = msgRows.map(rowToMessage)
        const messageSortOrders = msgRows.map((row) => row.sort_order)
        const latestSession = get().sessions.find((s) => s.id === sessionId)
        if (!matchesMessageLoadSnapshot(latestSession, knownCount, sessionTailMessageIds)) {
          return
        }
        set((state) => {
          const target = state.sessions.find((s) => s.id === sessionId)
          if (!target || !matchesMessageLoadSnapshot(target, knownCount, sessionTailMessageIds)) {
            return
          }
          const merged = mergeLoadedMessagesWithResident(
            target,
            messages,
            safeOffset,
            Math.max(safeOffset + messages.length, ...messageSortOrders.map((order) => order + 1)),
            knownCount,
            messageSortOrders
          )
          target.messages = merged.messages
          target.messagesLoaded = true
          target.messageCount = merged.messageCount
          target.loadedRangeStart = merged.loadedRangeStart
          target.loadedRangeEnd = merged.loadedRangeEnd
          target.lastKnownMessageCount = merged.messageCount
          trimSessionMessageWindow(target, 'tail')
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

      let messages = await loadRequestContextMessages(session, options?.requestContextMaxMessages)
      const initialShape = countToolReplayBlocks(messages)
      const preCompactSanitized = sanitizeToolBlocksForResend(messages)
      messages = applyLatestCompactRequestView(preCompactSanitized.messages)
      const postCompactSanitized = sanitizeToolBlocksForResend(messages)
      messages = postCompactSanitized.messages
      if (preCompactSanitized.changed || postCompactSanitized.changed) {
        console.warn('[ChatStore] Sanitized tool replay request context', {
          sessionId,
          preCompactChanged: preCompactSanitized.changed,
          postCompactChanged: postCompactSanitized.changed,
          before: initialShape,
          after: countToolReplayBlocks(messages)
        })
      }

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

    getFullSessionMessagesForMutation: async (sessionId) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session) return []
      return loadRequestContextMessages(session, null)
    },

    loadFromDb: async () => {
      try {
        const isInitialLoad = !get()._loaded
        const initialRoute =
          isInitialLoad && typeof window !== 'undefined'
            ? parseChatRoute(window.location.hash)
            : null
        const [projectRows, sessionRows] = await Promise.all([
          invokeMessagePackBinary<ProjectRow[]>(DB_PROJECTS_LIST_MSGPACK_CHANNEL, {}),
          invokeMessagePackBinary<SessionRow[]>(DB_SESSIONS_LIST_MSGPACK_CHANNEL, {})
        ])
        let projects = projectRows.map(rowToProject)

        if (projects.length === 0) {
          const ensured = await get().ensureDefaultProject()
          projects = ensured ? [ensured] : []
        }

        const projectMap = new Map(projects.map((project) => [project.id, project]))

        const sessions: Session[] = sessionRows.map((row) => {
          const session = rowToSession(row, [])
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

          const routeSessionId =
            initialRoute?.sessionId &&
            sessions.some((session) => session.id === initialRoute.sessionId)
              ? initialRoute.sessionId
              : null
          const preservedActiveSessionId =
            state.activeSessionId &&
            sessions.some((session) => session.id === state.activeSessionId)
              ? state.activeSessionId
              : null

          nextActiveSessionId = isInitialLoad
            ? routeSessionId
            : (preservedActiveSessionId ?? sessions[0]?.id ?? null)
          state.activeSessionId = nextActiveSessionId

          const activeSession = sessions.find((session) => session.id === nextActiveSessionId)
          const routeProjectId =
            initialRoute?.projectId &&
            projects.some((project) => project.id === initialRoute.projectId)
              ? initialRoute.projectId
              : null
          if (activeSession) {
            nextActiveProjectId = activeSession.projectId ?? null
          } else {
            nextActiveProjectId =
              routeProjectId ??
              state.activeProjectId ??
              projects.find((project) => !project.pluginId)?.id ??
              projects[0]?.id ??
              null
          }
          state.activeProjectId = nextActiveProjectId
        })

        if (nextActiveSessionId) {
          const planStore = usePlanStore.getState()
          const [, , activePlan] = await Promise.all([
            get().loadRecentSessionMessages(nextActiveSessionId),
            useTaskStore.getState().loadTasksForSession(nextActiveSessionId),
            planStore.loadPlanForSession(nextActiveSessionId)
          ])
          planStore.setActivePlan(activePlan?.id ?? null)
        } else {
          useTaskStore.getState().clearTasks()
          usePlanStore.getState().setActivePlan(null)
        }
        useUIStore.getState().syncSessionScopedState(nextActiveSessionId, nextActiveProjectId)
        scheduleDeferredSessionMaintenance(get)
      } catch (err) {
        console.error('[ChatStore] Failed to load from DB:', err)
        set({ _loaded: true })
      }
    },

    createSession: (mode, projectId, options) => {
      const id = nanoid()
      const now = Date.now()
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

      const projectHasModelBinding = Boolean(targetProject?.providerId && targetProject?.modelId)
      const hasFixedDefaultModel = Boolean(
        !projectHasModelBinding &&
        newSessionDefaultModel?.useGlobalActiveModel === false &&
        newSessionDefaultModel.providerId &&
        newSessionDefaultModel.modelId
      )
      const sessionProviderId = projectHasModelBinding
        ? targetProject?.providerId
        : hasFixedDefaultModel
          ? newSessionDefaultModel?.providerId
          : undefined
      const sessionModelId = projectHasModelBinding
        ? targetProject?.modelId
        : hasFixedDefaultModel
          ? newSessionDefaultModel?.modelId
          : undefined
      const modelSelectionMode: SessionModelSelectionMode =
        projectHasModelBinding || hasFixedDefaultModel ? 'manual' : 'inherit'

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
        workingFolder: targetProject?.workingFolder ?? options?.workingFolder ?? undefined,
        sshConnectionId: targetProject?.sshConnectionId ?? options?.sshConnectionId ?? undefined,
        planId: options?.planId ?? undefined,
        modelSelectionMode,
        providerId: sessionProviderId,
        modelId: sessionModelId
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
      cancelActiveSessionHydration()
      scheduleDeferredSessionMaintenance(get)
      return id
    },

    deleteSession: (id) => {
      const deletedSession = get().sessions.find((session) => session.id === id)
      const wasActiveSession = get().activeSessionId === id
      const deletedProjectId = deletedSession?.projectId ?? null
      const deletedStreamingMsgId = get().streamingMessages[id]
      const deletedMessageIds = deletedSession?.messages.map((message) => message.id) ?? []
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

      // Clean up deferred streaming state for deleted session
      if (deletedStreamingMsgId) {
        _activeStreamingMessageIds.delete(deletedStreamingMsgId)
        _streamingDirtyMessageIds.delete(deletedStreamingMsgId)
      }
      clearDeferredMessageAdds(id)

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
      void removeSessionInputDraft(id)
      scheduleAfterNextPaint(() => cleanupDeletedSessionMessages(deletedMessageIds))
      dbDeleteSession(id)

      if (wasLiveSession) {
        agentState.switchToolCallSession(null, nextActiveId)
      }

      if (nextActiveId) {
        const planStore = usePlanStore.getState()
        const cachedPlan = planStore.getPlanBySession(nextActiveId)
        planStore.setActivePlan(cachedPlan?.id ?? null)
        scheduleActiveSessionHydration(get, nextActiveId, {
          fallbackPlanId: cachedPlan?.id ?? null
        })
      } else {
        cancelActiveSessionHydration()
        useTaskStore.getState().clearTasks()
        usePlanStore.getState().setActivePlan(null)
      }
      useUIStore
        .getState()
        .syncSessionScopedState(nextActiveId, useChatStore.getState().activeProjectId)
      if (wasActiveSession && !nextActiveId) {
        if (deletedProjectId && currentChatView !== 'home') {
          useUIStore.getState().navigateToProject(deletedProjectId)
        } else {
          useUIStore.getState().navigateToHome()
        }
      }
      scheduleDeferredSessionMaintenance(get)
    },

    setActiveSession: (id) => {
      const prevId = get().activeSessionId
      invalidateVisibleSessionCache()
      if (prevId && prevId !== id) {
        agentStream.notifySessionVisibility(prevId, false)
      }
      if (id) {
        agentStream.notifySessionVisibility(id, true)
      }
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
      useUIStore.getState().syncSessionScopedState(id, useChatStore.getState().activeProjectId)
      scheduleDeferredSessionMaintenance(get)
      // Switch per-session tool calls in agent-store
      useAgentStore.getState().switchToolCallSession(prevId, id)
      // Load tasks for the new session
      if (id) {
        const planStore = usePlanStore.getState()
        const activePlan = planStore.getPlanBySession(id)
        planStore.setActivePlan(activePlan?.id ?? null)
        scheduleActiveSessionHydration(get, id, {
          fallbackPlanId: activePlan?.id ?? null
        })
      } else {
        cancelActiveSessionHydration()
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

    setSessionModelManual: (sessionId, providerId, modelId) => {
      const now = Date.now()
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (session) {
          session.modelSelectionMode = 'manual'
          session.providerId = providerId
          session.modelId = modelId
          delete session.promptSnapshot
          session.updatedAt = now
        }
      })
      dbUpdateSession(sessionId, {
        modelSelectionMode: 'manual',
        providerId,
        modelId,
        updatedAt: now
      })
    },

    setSessionModelAuto: (sessionId) => {
      const now = Date.now()
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (session) {
          session.modelSelectionMode = 'auto'
          delete session.providerId
          delete session.modelId
          delete session.promptSnapshot
          session.updatedAt = now
        }
      })
      dbUpdateSession(sessionId, {
        modelSelectionMode: 'auto',
        providerId: null,
        modelId: null,
        updatedAt: now
      })
    },

    setSessionModelInherit: (sessionId) => {
      const now = Date.now()
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (session) {
          session.modelSelectionMode = 'inherit'
          delete session.providerId
          delete session.modelId
          delete session.promptSnapshot
          session.updatedAt = now
        }
      })
      dbUpdateSession(sessionId, {
        modelSelectionMode: 'inherit',
        providerId: null,
        modelId: null,
        updatedAt: now
      })
    },

    updateSessionModel: (sessionId, providerId, modelId) => {
      get().setSessionModelManual(sessionId, providerId, modelId)
    },

    clearSessionModelBinding: (sessionId) => {
      get().setSessionModelInherit(sessionId)
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
          contextCacheKey: snapshot.contextCacheKey,
          systemHash: snapshot.systemHash,
          toolsHash: snapshot.toolsHash,
          toolCount: snapshot.toolCount,
          createdAt: snapshot.createdAt
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
          session.lastKnownMessageCount ?? session.messageCount ?? session.messages.length,
        modelSelectionMode: normalizeSessionModelSelectionMode(
          session.modelSelectionMode,
          session.providerId,
          session.modelId
        )
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
        pluginSenderName: undefined,
        modelSelectionMode: normalizeSessionModelSelectionMode(
          session.modelSelectionMode,
          session.providerId,
          session.modelId
        )
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

      set((state) => {
        state.projects.unshift(importedProject)
        state.activeProjectId = importedProject.id
      })

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
      const deletedMessageIds = get().sessions.flatMap((s) =>
        s.messages.map((message) => message.id)
      )
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
        bumpMessageWriteGeneration(id)
        clearDeferredMessageAdds(id)
        const plan = planState.getPlanBySession(id)
        if (plan) planState.deletePlan(plan.id)
        taskState.deleteSessionTasks(id)
        void removeSessionInputDraft(id)
      }
      clearPendingMessageFlushes(deletedMessageIds)
      for (const messageId of deletedMessageIds) {
        _streamingDirtyMessageIds.delete(messageId)
      }
      agentState.clearToolCalls()
      useUIStore.getState().syncSessionScopedState(null, null)
      dbClearAllSessions(ids)
    },

    upsertSessionFromSync: (row, options) => {
      const syncedSession = rowToSession(row, [])

      set((state) => {
        const existing = dedupeSessionsById(state, row.id)
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

      scheduleDeferredSessionMaintenance(get)
    },

    removeSessionFromSync: (sessionId) => {
      const deletedSession = get().sessions.find((session) => session.id === sessionId)
      if (!deletedSession) return

      const wasActiveSession = get().activeSessionId === sessionId
      const deletedProjectId = deletedSession.projectId ?? null
      const deletedMessageIds = deletedSession.messages.map((message) => message.id)
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

      bumpMessageWriteGeneration(sessionId)
      clearDeferredMessageAdds(sessionId)
      scheduleAfterNextPaint(() => cleanupDeletedSessionMessages(deletedMessageIds))

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
      void removeSessionInputDraft(sessionId)
      useUIStore
        .getState()
        .syncSessionScopedState(
          useChatStore.getState().activeSessionId,
          useChatStore.getState().activeProjectId
        )

      if (wasActiveSession) {
        useTaskStore.getState().clearTasks()
        usePlanStore.getState().setActivePlan(null)

        if (deletedProjectId && currentChatView !== 'home') {
          useUIStore.getState().navigateToProject(deletedProjectId)
        } else {
          useUIStore.getState().navigateToHome()
        }
      }

      scheduleDeferredSessionMaintenance(get)
    },

    clearSessionMessages: (sessionId) => {
      const now = Date.now()
      const deletedMessageIds =
        get()
          .sessions.find((s) => s.id === sessionId)
          ?.messages.map((message) => message.id) ?? []
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
      clearPendingMessageFlushes(deletedMessageIds)
      clearDeferredMessageAdds(sessionId)
      for (const messageId of deletedMessageIds) {
        _streamingDirtyMessageIds.delete(messageId)
      }
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
      void removeSessionInputDraft(sessionId)
    },

    duplicateSession: async (sessionId) => {
      await get().loadSessionMessages(sessionId)
      const source = get().sessions.find((s) => s.id === sessionId)
      if (!source) return null
      const newId = nanoid()
      const now = Date.now()
      const clonedMessages = cloneMessagesForNewSession(source.messages)
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
        modelSelectionMode: normalizeSessionModelSelectionMode(
          source.modelSelectionMode,
          source.providerId,
          source.modelId
        ),
        providerId: source.providerId,
        modelId: source.modelId
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

    forkSessionFromMessage: async (sessionId, messageId) => {
      await get().loadSessionMessages(sessionId)
      const source = get().sessions.find((s) => s.id === sessionId)
      if (!source) return null

      const messageIndex = source.messages.findIndex((message) => message.id === messageId)
      if (messageIndex < 0) return null

      const newId = nanoid()
      const now = Date.now()
      const clonedMessages = cloneMessagesForNewSession(source.messages.slice(0, messageIndex + 1))
      const newSession: Session = {
        id: newId,
        title: source.title,
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
        modelSelectionMode: normalizeSessionModelSelectionMode(
          source.modelSelectionMode,
          source.providerId,
          source.modelId
        ),
        providerId: source.providerId,
        modelId: source.modelId
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
      const deletedMessageIds = session.messages.slice(assistantIdx).map((message) => message.id)
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
      clearPendingMessageFlushes(deletedMessageIds)
      clearDeferredMessageAdds(sessionId, newLen)
      for (const messageId of deletedMessageIds) {
        _streamingDirtyMessageIds.delete(messageId)
      }
      dbTruncateMessagesFrom(sessionId, newLen)
      return true
    },

    removeLastUserMessage: (sessionId) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session || session.messages.length === 0) return
      const lastMsg = session.messages[session.messages.length - 1]
      if (lastMsg.role !== 'user') return
      const deletedMessageIds = [lastMsg.id]
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
      clearPendingMessageFlushes(deletedMessageIds)
      clearDeferredMessageAdds(sessionId, newLen)
      for (const messageId of deletedMessageIds) {
        _streamingDirtyMessageIds.delete(messageId)
      }
      dbTruncateMessagesFrom(sessionId, newLen)
    },

    truncateMessagesFrom: (sessionId, fromIndex) => {
      const deletedMessageIds =
        get()
          .sessions.find((s) => s.id === sessionId)
          ?.messages.slice(Math.max(0, fromIndex))
          .map((message) => message.id) ?? []
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
      clearPendingMessageFlushes(deletedMessageIds)
      clearDeferredMessageAdds(sessionId, fromIndex)
      for (const messageId of deletedMessageIds) {
        _streamingDirtyMessageIds.delete(messageId)
      }
      dbTruncateMessagesFrom(sessionId, fromIndex)
      dbUpdateSession(sessionId, { updatedAt: Date.now() })
    },

    replaceSessionMessages: (sessionId, messages) => {
      const now = Date.now()
      const previousMessageIds =
        get()
          .sessions.find((s) => s.id === sessionId)
          ?.messages.map((message) => message.id) ?? []
      const revisedMessages = messages.map((message) => ({
        ...message,
        _revision: (message._revision ?? 0) + 1
      }))
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId)
        if (session) {
          session.messages = revisedMessages
          session.messageCount = revisedMessages.length
          session.messagesLoaded = true
          session.loadedRangeStart = 0
          session.loadedRangeEnd = revisedMessages.length
          session.lastKnownMessageCount = revisedMessages.length
          session.updatedAt = now
        }
      })
      // Clear deferred writes for this session — the full replacement covers everything.
      bumpMessageWriteGeneration(sessionId)
      clearDeferredMessageAdds(sessionId)
      const replacedMessageIds = [
        ...new Set([...previousMessageIds, ...revisedMessages.map((message) => message.id)])
      ]
      clearPendingMessageFlushes(replacedMessageIds)
      for (const messageId of replacedMessageIds) {
        _streamingDirtyMessageIds.delete(messageId)
      }
      const streamingMsgId = get().streamingMessages[sessionId]
      if (streamingMsgId) {
        _streamingDirtyMessageIds.delete(streamingMsgId)
      }
      enqueueSessionMessageWrite(sessionId, () =>
        invokeMessagePack(DB_MESSAGES_REPLACE_MSGPACK_CHANNEL, {
          sessionId,
          messages: revisedMessages.map((msg, i) => ({
            id: msg.id,
            role: msg.role,
            content: JSON.stringify(sanitizeMessageContentForPersistence(msg.content)),
            meta: msg.meta ? JSON.stringify(msg.meta) : null,
            createdAt: msg.createdAt,
            usage: msg.usage ? JSON.stringify(msg.usage) : null,
            sortOrder: i
          }))
        })
      )
      dbUpdateSession(sessionId, { updatedAt: now })
    },

    sanitizeToolErrorsForResend: (sessionId) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session || session.messages.length === 0) return
      const trimmed = stripTrailingAssistantAgentErrors(session.messages)
      if (!trimmed.changed) return
      get().replaceSessionMessages(sessionId, trimmed.messages)
    },

    stripOldSystemReminders: (sessionId) => {
      const changedMsgIds = new Set<string>()
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
              return !/^<system-remind(?:er)?>/i.test(block.text.trim())
            }
            return true
          })

          if (filtered.length !== msg.content.length) {
            msg.content = filtered
            changed = true
            changedMsgIds.add(msg.id)
          }
        }

        if (changed) {
          session.updatedAt = Date.now()
        }
      })

      // Persist changes to DB
      const session = get().sessions.find((s) => s.id === sessionId)
      if (session && session.messages.length > 0) {
        const changedMsgs = session.messages.filter((m) => changedMsgIds.has(m.id))
        for (const msg of changedMsgs) {
          dbUpsertMessage(
            sessionId,
            msg,
            resolveMessageSortOrder(session, msg.id),
            undefined,
            'strip-reminders'
          )
        }
        if (changedMsgs.length > 0) {
          dbUpdateSession(sessionId, { updatedAt: session.updatedAt })
        }
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
      if (get().streamingMessages[sessionId]) {
        // Streaming turns can create many tool-result messages in quick bursts.
        // Batch them with the other deferred adds and flush at periodic checkpoints
        // or at stream finalization, instead of upserting on every tool result.
        _deferredMessageAdds.push({ sessionId, msg, sortOrder })
        return
      }
      dbAddMessage(sessionId, msg, sortOrder)
      dbUpdateSession(sessionId, { updatedAt: Date.now() })
    },

    beginUserTurn: (sessionId, userMsg, assistantMsg, streamingMessageId) => {
      let userSortOrder = 0
      let assistantSortOrder = 0
      let shouldPersistUser = false
      let shouldPersistAssistant = false
      set((state) => {
        const session = getSessionByIdFromState(state, sessionId)
        if (!session) return
        if (!session.messagesLoaded) {
          session.messagesLoaded = true
          session.messages = []
          session.loadedRangeStart = session.messageCount
          session.loadedRangeEnd = session.messageCount
        }
        if (userMsg) {
          shouldPersistUser = true
          userSortOrder = session.messageCount
          userMsg._revision = (userMsg._revision ?? 0) + 1
          session.messages.push(userMsg)
          session.messageCount += 1
        }
        if (assistantMsg) {
          shouldPersistAssistant = true
          assistantSortOrder = session.messageCount
          assistantMsg._revision = (assistantMsg._revision ?? 0) + 1
          session.messages.push(assistantMsg)
          session.messageCount += 1
        }
        session.loadedRangeEnd = session.messageCount
        session.lastKnownMessageCount = session.messageCount
        trimSessionMessageWindow(session)
        session.updatedAt = Date.now()

        if (streamingMessageId !== null) {
          _streamingBackfillBlockedSessionIds.delete(sessionId)
          state.streamingMessages[sessionId] = streamingMessageId
          if (sessionId === state.activeSessionId) {
            state.streamingMessageId = streamingMessageId
          }
        }

        releaseDormantSessionMemory(state)
      })
      if (streamingMessageId !== null) {
        _activeStreamingMessageIds.add(streamingMessageId)
        startStreamingPeriodicFlush(sessionId, streamingMessageId, get)
      }
      const now = Date.now()
      const batch: Array<{ msg: UnifiedMessage; sortOrder: number }> = []
      if (shouldPersistUser && userMsg) batch.push({ msg: userMsg, sortOrder: userSortOrder })
      if (shouldPersistAssistant && assistantMsg)
        batch.push({ msg: assistantMsg, sortOrder: assistantSortOrder })
      if (batch.length > 0) {
        dbAddMessageBatch(sessionId, batch)
        dbUpdateSession(sessionId, { updatedAt: now })
      }
    },

    updateMessage: (sessionId, msgId, patch) => {
      set((state) => {
        const session = getSessionByIdFromState(state, sessionId)
        if (!session) return
        const msg = session.messages.find((m) => m.id === msgId)
        if (msg) {
          const { usage, ...messagePatch } = patch
          Object.assign(msg, messagePatch)
          if (usage) {
            msg.usage = mergeUsageSnapshot(msg.usage, usage)
          }
          bumpMessageRevision(msg)
        }
      })
      if (_activeStreamingMessageIds.has(msgId)) {
        _streamingDirtyMessageIds.add(msgId)
        return
      }
      const session = getSessionByIdFromState(get(), sessionId)
      const msg = session?.messages.find((m) => m.id === msgId)
      if (msg)
        dbUpsertMessage(
          sessionId,
          msg,
          resolveMessageSortOrder(session, msgId),
          undefined,
          'message-update'
        )
    },

    removeMessageById: (sessionId, msgId) => {
      let removed = false
      let wasStreamingMessage = false
      const now = Date.now()
      set((state) => {
        const session = getSessionByIdFromState(state, sessionId)
        if (!session) return
        const index = session.messages.findIndex((message) => message.id === msgId)
        if (index < 0) return

        removed = true
        wasStreamingMessage = state.streamingMessages[sessionId] === msgId
        session.messages.splice(index, 1)
        session.messageCount = Math.max(0, session.messageCount - 1)
        if (session.messageCount === 0) {
          session.messagesLoaded = true
          session.loadedRangeStart = 0
          session.loadedRangeEnd = 0
          session.lastKnownMessageCount = 0
        } else {
          session.loadedRangeEnd = Math.max(session.loadedRangeStart, session.loadedRangeEnd - 1)
          session.lastKnownMessageCount = session.messageCount
        }
        session.updatedAt = now

        if (wasStreamingMessage) {
          _streamingBackfillBlockedSessionIds.add(sessionId)
          delete state.streamingMessages[sessionId]
          if (sessionId === state.activeSessionId) {
            state.streamingMessageId = null
          }
        }
        releaseDormantSessionMemory(state)
      })

      if (!removed) return false

      clearPendingMessageFlushes([msgId])
      clearDeferredMessageAddById(sessionId, msgId)
      discardPendingStreamDeltasForMessage(sessionId, msgId)
      _streamingDirtyMessageIds.delete(msgId)
      _activeStreamingMessageIds.delete(msgId)
      if (wasStreamingMessage) stopStreamingPeriodicFlush(sessionId)
      dbDeleteMessage(sessionId, msgId)
      dbUpdateSession(sessionId, { updatedAt: now })
      return true
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
        backfillStreamingMessage(state, sessionId, msgId)
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
      if (msg) dbFlushMessage(sessionId, msg)
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
      if (msg) dbFlushMessageImmediate(sessionId, msg)
    },

    appendToolUse: (sessionId, msgId, toolUse) => {
      flushPendingStreamDeltasForMessage(sessionId, msgId)
      set((state) => {
        const session = getSessionByIdFromState(state, sessionId)
        if (!session) return
        const msg = session.messages.find((m) => m.id === msgId)
        if (!msg) return
        backfillStreamingMessage(state, sessionId, msgId)

        const normalizedToolUse: ToolUseBlock = {
          ...toolUse,
          input: summarizeToolInputForHistory(toolUse.name, toolUse.input)
        }
        if (typeof msg.content === 'string') {
          msg.content = msg.content
            ? [{ type: 'text', text: msg.content }, normalizedToolUse]
            : [normalizedToolUse]
        } else {
          const blocks = msg.content as ContentBlock[]
          const existingIndex = normalizedToolUse.id
            ? blocks.findIndex(
                (block): block is ToolUseBlock =>
                  block.type === 'tool_use' && block.id === normalizedToolUse.id
              )
            : -1

          if (existingIndex === -1) {
            blocks.push(normalizedToolUse)
          } else {
            blocks[existingIndex] = {
              ...(blocks[existingIndex] as ToolUseBlock),
              ...normalizedToolUse,
              input: normalizedToolUse.input
            }
          }
        }
        bumpMessageRevision(msg)
      })
      // Persist immediately for tool use blocks
      const session = getSessionByIdFromState(get(), sessionId)
      const msg = session?.messages.find((m) => m.id === msgId)
      if (msg) dbFlushMessageImmediate(sessionId, msg)
    },

    updateToolUseInput: (sessionId, msgId, toolUseId, input) => {
      if (input && typeof input === 'object' && 'widget_code' in input) {
        logWidgetTrace('log', '[WidgetTrace] updateToolUseInput', {
          msgId,
          toolUseId,
          inputKeys: Object.keys(input),
          widget_code_len:
            typeof (input as Record<string, unknown>).widget_code === 'string'
              ? ((input as Record<string, unknown>).widget_code as string).length
              : null
        })
      }
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
          if (block.name === 'visualize_show_widget') {
            logWidgetTrace('log', '[WidgetTrace] block.input written', {
              msgId,
              toolUseId,
              blockInputKeys: Object.keys(block.input ?? {}),
              widget_code_len:
                typeof (block.input as Record<string, unknown>)?.widget_code === 'string'
                  ? ((block.input as Record<string, unknown>).widget_code as string).length
                  : null
            })
          }
          bumpMessageRevision(msg)
        }
      })
      const session = getSessionByIdFromState(get(), sessionId)
      const msg = session?.messages.find((m) => m.id === msgId)
      if (msg) dbFlushMessage(sessionId, msg)
    },

    appendContentBlock: (sessionId, msgId, block) => {
      flushPendingStreamDeltasForMessage(sessionId, msgId)
      set((state) => {
        const session = getSessionByIdFromState(state, sessionId)
        if (!session) return
        const msg = session.messages.find((m) => m.id === msgId)
        if (!msg) return
        backfillStreamingMessage(state, sessionId, msgId)

        if (typeof msg.content === 'string') {
          msg.content = msg.content ? [{ type: 'text', text: msg.content }, block] : [block]
        } else {
          ;(msg.content as ContentBlock[]).push(block)
        }
        bumpMessageRevision(msg)
      })
      const session = getSessionByIdFromState(get(), sessionId)
      const msg = session?.messages.find((m) => m.id === msgId)
      if (msg) dbFlushMessageImmediate(sessionId, msg)
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
            if (bufferedMsg.usage) {
              existing.usage = mergeUsageSnapshot(existing.usage, bufferedMsg.usage)
            }
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
        dbFlushMessageImmediate(sessionId, msg)
      }
      dbUpdateSession(sessionId, { updatedAt: session.updatedAt })
    },

    setStreamingMessageId: (sessionId, id) => {
      const prevStreamingMsgId = get().streamingMessages[sessionId]
      const stateBefore = get()
      const needsStateUpdate =
        (id ? prevStreamingMsgId !== id : Boolean(prevStreamingMsgId)) ||
        (sessionId === stateBefore.activeSessionId && stateBefore.streamingMessageId !== id)

      if (needsStateUpdate) {
        set((state) => {
          if (id) {
            _streamingBackfillBlockedSessionIds.delete(sessionId)
            state.streamingMessages[sessionId] = id
          } else {
            _streamingBackfillBlockedSessionIds.add(sessionId)
            delete state.streamingMessages[sessionId]
          }
          releaseDormantSessionMemory(state)
          // Sync convenience field when updating the active session
          if (sessionId === state.activeSessionId) {
            state.streamingMessageId = id
          }
        })
      } else if (id) {
        _streamingBackfillBlockedSessionIds.delete(sessionId)
      } else {
        _streamingBackfillBlockedSessionIds.add(sessionId)
      }

      if (id) {
        _activeStreamingMessageIds.add(id)
        startStreamingPeriodicFlush(sessionId, id, get)
        if (prevStreamingMsgId && prevStreamingMsgId !== id) {
          flushPendingStreamDeltasForMessage(sessionId, prevStreamingMsgId)
          _activeStreamingMessageIds.delete(prevStreamingMsgId)
          flushDeferredMessageAdds(sessionId)
          flushStreamingMessageIfDirty(sessionId, prevStreamingMsgId, get, true)
        }
        return
      }

      if (!id && prevStreamingMsgId) {
        flushPendingStreamDeltasForMessage(sessionId, prevStreamingMsgId)
        stopStreamingPeriodicFlush(sessionId)
        _activeStreamingMessageIds.delete(prevStreamingMsgId)
        flushDeferredMessageAdds(sessionId)
        flushStreamingMessageIfDirty(sessionId, prevStreamingMsgId, get, true)
        dbUpdateSession(sessionId, { updatedAt: Date.now() })
      }
    },

    setGeneratingImage: (msgId, generating, occurredAt = Date.now()) =>
      set((state) => {
        const timing = state.imageGenerationTimings[msgId]
        if (generating) {
          state.generatingImageMessages[msgId] = true
          if (!timing || timing.completedAt) {
            state.imageGenerationTimings[msgId] = { startedAt: occurredAt }
          }
        } else {
          delete state.generatingImageMessages[msgId]
          if (timing?.startedAt && !timing.completedAt) {
            timing.completedAt = occurredAt
          }
        }
      }),

    setGeneratingImagePreview: (msgId, preview) =>
      set((state) => {
        if (preview) {
          state.generatingImagePreviews[msgId] = preview
        } else {
          delete state.generatingImagePreviews[msgId]
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
        await get().loadRecentSessionMessages(
          targetSessionId,
          true,
          INITIAL_SESSION_DISPLAY_PAGE_SIZE
        )
        await useTaskStore.getState().loadTasksForSession(targetSessionId)
        const planStore = usePlanStore.getState()
        const activePlan = await planStore.loadPlanForSession(targetSessionId)
        planStore.setActivePlan(activePlan?.id ?? null)
      } else {
        useTaskStore.getState().clearTasks()
        usePlanStore.getState().setActivePlan(null)
      }

      scheduleDeferredSessionMaintenance(get)
    },

    releaseDormantSessions: () => {
      set((state) => {
        releaseDormantSessionMemory(state)
        state.streamingMessageId = state.activeSessionId
          ? (state.streamingMessages[state.activeSessionId] ?? null)
          : null
      })
    },

    trimResidentMessageWindows: () => {
      set((state) => {
        for (const session of state.sessions) {
          if (session.messages.length <= MESSAGE_WINDOW_MAX_SIZE) continue
          trimSessionMessageWindow(
            session,
            getMessageWindowPreserveMode(
              session,
              session.loadedRangeEnd >= session.messageCount - MESSAGE_WINDOW_TAIL_PRESERVE
                ? 'tail'
                : 'head'
            )
          )
        }
      })
    },

    scheduleSessionMaintenance: () => {
      scheduleDeferredSessionMaintenance(get)
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
        backfillStreamingMessage(state, sessionId, delta.msgId)

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
    if (msg) dbFlushMessage(sessionId, msg)
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

function discardPendingStreamDeltasForMessage(sessionId: string, msgId: string): void {
  for (let index = _pendingStreamDeltas.length - 1; index >= 0; index -= 1) {
    const delta = _pendingStreamDeltas[index]
    if (delta.sessionId === sessionId && delta.msgId === msgId) {
      _pendingStreamDeltas.splice(index, 1)
    }
  }
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
