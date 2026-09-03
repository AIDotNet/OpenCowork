import { nanoid } from 'nanoid'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { useChatStore, type SessionMode } from '@renderer/stores/chat-store'
import { useTaskStore, type TaskItem } from '@renderer/stores/task-store'
import { useTerminalStore } from '@renderer/stores/terminal-store'
import { useBackgroundSessionStore } from '@renderer/stores/background-session-store'
import { useGitStore, type GitStatusFile } from '@renderer/stores/git-store'
import { coerceAskUserQuestions, resolveAskUserAnswers } from '@renderer/lib/tools/ask-user-tool'
import { TASK_TOOL_NAME } from '@renderer/lib/agent/sub-agents/create-tool'
import type { ToolCallState } from '@renderer/lib/agent/types'
import {
  useProviderStore,
  isProviderAvailableForModelSelection
} from '@renderer/stores/provider-store'
import { resolveSessionModelSelection } from '@renderer/lib/session-model-resolution'
import { invokeMessagePackBinary } from '@renderer/lib/ipc/messagepack-ipc-client'
import { DB_SESSIONS_GET_MSGPACK_CHANNEL } from '../../../../shared/messagepack/binary-ipc'
import { applyModelSetting, buildModelSettings } from './model-settings'
import { toolDisplayName } from '@renderer/lib/chat/tool-display-name'
import { inputSummary } from '@renderer/components/chat/tool-call-summary'
import {
  isHiddenExecutionToolName,
  isOrdinaryContextToolName
} from '@renderer/components/chat/execution-outline'
import {
  useAgentStore,
  type AgentRunChangeSet,
  type AgentRunFileChange
} from '@renderer/stores/agent-store'
import {
  triggerSendMessage,
  stopSessionStreaming,
  abortSession,
  deleteSessionMessage,
  retrySessionMessage
} from '@renderer/hooks/use-chat-actions'
import { type ImageAttachment } from '@renderer/lib/image-attachments'
import {
  REMOTE_CONTROL_INITIAL_STATE as INITIAL,
  REMOTE_REQUEST_OPS as OPS,
  REMOTE_EVENT_OPS as EVENTS,
  REMOTE_DIFF_TEXT_LIMIT,
  REMOTE_SESSION_FLUSH_MS,
  truncateRemoteText,
  type RemoteControlState,
  type RemoteRendererRequest,
  type RemoteTask,
  type RemoteWorkspace,
  type RemoteSession,
  type RemoteMessage,
  type RemoteBlock,
  type RemoteImage,
  type RemoteModelProvider,
  type RemoteRequestOp,
  type RemoteSnapshot,
  type RemoteChangeSet,
  type RemoteDiff,
  type RemoteInboxItem,
  type RemoteAskQuestion,
  type RemoteGitStatus,
  type RemoteSubAgent,
  type RemoteTaskStatus,
  type RemoteToolStatus,
  type RemoteToolVisibility
} from '../../../../shared/remote-control'
import type { ContentBlock, UnifiedMessage } from '@renderer/lib/api/types'

let remoteState: RemoteControlState = INITIAL
/** Last frame sent per subscription, so unchanged state is not re-broadcast. */
const lastTaskSignatures = new Map<string, string>()
const lastSessionStatuses = new Map<string, string>()
/**
 * Revision last pushed per message, keyed `sessionId:messageId`.
 *
 * Keyed per message rather than per session on purpose: a turn's tail moves on as
 * soon as the next message opens, and a map that only remembers "the tail" leaves
 * whatever was streaming a moment ago frozen on the phone at its half-written state
 * — which is how a finished answer could be missing there while the desktop showed
 * it in full.
 */
const lastMessageRevisions = new Map<string, string>()
/** How many trailing messages a live push sweeps; one turn never spans more. */
const SESSION_PUSH_WINDOW = 8
let lastSessionListSignature = ''
/** Ids the phone was last told about, so a disappearance can be checked. */
let lastPublishedSessionIds = new Set<string>()
let lastInboxSignature = ''
let lastReviewSignature = ''
const sendEvent = (op: string, payload: unknown): void =>
  ipcClient.send(IPC.REMOTE_CONTROL_EVENT, { op, payload })
const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
const shortJson = (v: unknown): string => truncateRemoteText(JSON.stringify(v) ?? '', 512)

function workspace(
  p: ReturnType<typeof useChatStore.getState>['projects'][number]
): RemoteWorkspace {
  return {
    id: p.id,
    name: p.name,
    icon: p.icon,
    workingFolder: p.workingFolder,
    pinned: p.pinned,
    sessionCount: p.sessionCount,
    updatedAt: p.updatedAt
  }
}
function session(s: ReturnType<typeof useChatStore.getState>['sessions'][number]): RemoteSession {
  const providerStore = useProviderStore.getState()
  const selection = resolveSessionModelSelection({
    session: s,
    providers: providerStore.providers,
    activeProviderId: providerStore.activeProviderId,
    activeModelId: providerStore.activeModelId
  })
  return {
    id: s.id,
    title: s.title,
    icon: s.icon,
    mode: s.mode,
    projectId: s.projectId,
    workingFolder: s.workingFolder,
    pinned: s.pinned,
    messageCount: s.messageCount,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    running: useAgentStore.getState().isSessionRunActive(s.id),
    providerId: selection.providerId ?? undefined,
    modelId: selection.modelId ?? undefined,
    modelLabel: selection.model?.name ?? selection.modelId ?? undefined,
    providerName: selection.provider?.name ?? undefined
  }
}
/**
 * Pushes the whole session list whenever its shape changes.
 *
 * Nothing used to emit this, so a session deleted — or every session cleared —
 * on the desktop stayed on the phone until it reconnected, and opening one led
 * to a transcript that no longer existed.
 *
 * The signature reads raw store fields rather than the projection: `session()`
 * resolves a model per row, and this runs on every flush of a streaming turn. It
 * also leaves out `updatedAt`, which moves with every token and would re-send
 * the list several times a second while saying nothing the phone displays.
 */
async function publishSessionList(): Promise<void> {
  const rows = useChatStore.getState().sessions
  const signature = JSON.stringify(
    rows.map((s) => [s.id, s.title, s.projectId ?? '', s.mode, s.messageCount, s.pinned === true])
  )
  if (signature === lastSessionListSignature) return
  lastSessionListSignature = signature

  // `removedIds` is deliberately not "whatever is missing from this push".
  // `loadFromDb` replaces `sessions` with a single 50-row page, so a session
  // outside that page falls out of the working set while still existing —
  // reading that as a deletion threw the phone out of the session it was
  // watching, mid-run. Only the database can tell the two apart.
  const live = new Set(rows.map((s) => s.id))
  const removedIds: string[] = []
  for (const id of lastPublishedSessionIds) {
    if (live.has(id)) continue
    const found = await invokeMessagePackBinary<{ session?: unknown } | null>(
      DB_SESSIONS_GET_MSGPACK_CHANNEL,
      { id, includeMessages: false }
    ).catch(() => undefined)
    // The check failing says nothing either way, so it stays silent.
    if (found !== undefined && !found?.session) removedIds.push(id)
  }
  lastPublishedSessionIds = live

  // A deleted session leaves its per-message revisions behind, and nothing else
  // prunes them.
  for (const key of lastMessageRevisions.keys()) {
    if (!live.has(key.slice(0, key.indexOf(':')))) lastMessageRevisions.delete(key)
  }
  sendEvent(EVENTS.SESSION_LIST_CHANGED, { sessions: rows.map(session), removedIds })
}

function task(t: TaskItem): RemoteTask {
  return {
    id: t.id,
    sessionId: t.sessionId,
    subject: t.subject,
    description: t.description,
    activeForm: t.activeForm,
    status: t.status as RemoteTaskStatus,
    owner: t.owner,
    blocks: t.blocks,
    blockedBy: t.blockedBy,
    metadata: t.metadata,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt
  }
}
/**
 * Tool results arrive as their own blocks, usually in a later message, so the
 * summary a tool row shows is only computable once the whole window is in hand.
 */
interface ProjectionContext {
  results: Map<string, { text: string; isError: boolean }>
  running: boolean
}

const EMPTY_CONTEXT: ProjectionContext = { results: new Map(), running: false }

function toolUseBlock(
  b: Extract<ContentBlock, { type: 'tool_use' }>,
  ctx: ProjectionContext
): RemoteBlock {
  const result = ctx.results.get(b.id)
  const status: RemoteToolStatus = result
    ? result.isError
      ? 'error'
      : 'completed'
    : ctx.running
      ? 'running'
      : 'completed'
  const attention = status === 'error' || status === 'running'
  const visibility: RemoteToolVisibility = isHiddenExecutionToolName(b.name)
    ? 'hidden'
    : attention
      ? 'force'
      : isOrdinaryContextToolName(b.name)
        ? 'ordinary'
        : 'force'
  let summary = ''
  try {
    summary = inputSummary(b.name, b.input ?? {}, result?.text)
  } catch {
    summary = ''
  }
  return {
    type: 'tool_use',
    id: b.id,
    name: b.name,
    input: shortJson(b.input),
    label: toolDisplayName(b.name),
    summary,
    visibility,
    status,
    ...(b.name === TASK_TOOL_NAME ? { subAgent: subAgentSummary(b.id) } : {})
  }
}

/**
 * Headline state for a `Task` call. The sub-agent's own transcript stays on the
 * desktop — it is a full `UnifiedMessage[]` and would dwarf the turn it belongs to.
 */
function subAgentSummary(toolUseId: string): RemoteSubAgent | undefined {
  const agent = useAgentStore.getState()
  // A sub-agent lives in `activeSubAgents` while its session is in the foreground,
  // moves into the per-session live cache when the user switches away, and finally
  // settles in the summaries. The phone should see it in all three states.
  const cached = Object.values(agent.sessionSubAgentLiveCache).flatMap((cache) => [
    ...Object.values(cache.active),
    ...Object.values(cache.completed)
  ])
  const state =
    agent.activeSubAgents[toolUseId] ??
    cached.find((item) => item.toolUseId === toolUseId) ??
    Object.values(agent.sessionSubAgentSummaries)
      .flat()
      .find((item) => item.toolUseId === toolUseId)
  if (!state) return undefined
  return {
    name: state.name,
    displayName: state.displayName,
    description: state.description,
    isRunning: state.isRunning,
    isQueued: state.isQueued,
    success: state.success,
    errorMessage: state.errorMessage,
    iteration: state.iteration,
    toolCallCount: state.toolCalls.length,
    report: truncateRemoteText(state.report ?? '')
  }
}

function block(b: ContentBlock, ctx: ProjectionContext = EMPTY_CONTEXT): RemoteBlock | null {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: truncateRemoteText(b.text) }
    case 'thinking':
      return { type: 'thinking', text: truncateRemoteText(b.thinking) }
    case 'image':
      return {
        type: 'image',
        url:
          b.source.type === 'url'
            ? (b.source.url ?? '')
            : `data:${b.source.mediaType ?? 'image/png'};base64,${b.source.data ?? ''}`
      }
    case 'tool_use':
      return toolUseBlock(b, ctx)
    case 'tool_result':
      return {
        type: 'tool_result',
        toolUseId: b.toolUseId,
        text: truncateRemoteText(typeof b.content === 'string' ? b.content : shortJson(b.content)),
        isError: b.isError
      }
    case 'agent_error':
      return { type: 'error', message: truncateRemoteText(b.message) }
    case 'image_error':
      return { type: 'error', message: truncateRemoteText(b.message) }
    case 'web_search':
      return { type: 'web_search', query: b.query, status: b.status }
    default:
      return null
  }
}
function message(m: UnifiedMessage, ctx: ProjectionContext = EMPTY_CONTEXT): RemoteMessage {
  const blocks =
    typeof m.content === 'string'
      ? [{ type: 'text' as const, text: truncateRemoteText(m.content) }]
      : m.content.map((b) => block(b, ctx)).filter((b): b is RemoteBlock => b !== null)
  return { id: m.id, role: m.role, createdAt: m.createdAt, blocks }
}

/** Projects a whole message window so every tool row can see its own result. */
function messageWindow(messages: UnifiedMessage[], running: boolean): RemoteMessage[] {
  const results = new Map<string, { text: string; isError: boolean }>()
  for (const m of messages) {
    if (typeof m.content === 'string') continue
    for (const b of m.content) {
      if (b.type !== 'tool_result') continue
      results.set(b.toolUseId, {
        text: typeof b.content === 'string' ? b.content : shortJson(b.content),
        isError: b.isError === true
      })
    }
  }
  const ctx: ProjectionContext = { results, running }
  return messages.map((m) => message(m, ctx))
}
/**
 * Everything currently waiting on a human.
 *
 * Two sources have to be merged. The renderer files an inbox item only when the
 * blocked session is in the background — a foreground session shows its prompt
 * inline instead — but a phone has no foreground, so the live agent state is
 * scanned as well. Without that merge the one run the user is actually watching
 * on their desktop would be the one run they cannot unblock remotely.
 */
function askQuestions(input: Record<string, unknown>): RemoteAskQuestion[] {
  return coerceAskUserQuestions(input.questions).map((item) => ({
    question: item.question,
    header: item.header,
    multiSelect: item.multiSelect,
    options: (item.options ?? []).map((option) => ({
      label: option.label,
      description: option.description
    }))
  }))
}

function liveToolCalls(): ToolCallState[] {
  const agent = useAgentStore.getState()
  return [
    ...agent.pendingToolCalls,
    ...Object.values(agent.sessionToolCallsCache).flatMap((cache) => cache.pending)
  ]
}

function inboxItems(): RemoteInboxItem[] {
  const chat = useChatStore.getState()
  const sessionOf = (id: string): { title?: string; projectId?: string } => {
    const found = chat.sessions.find((item) => item.id === id)
    return { title: found?.title, projectId: found?.projectId }
  }

  const byToolUseId = new Map<string, ToolCallState>()
  for (const call of liveToolCalls()) byToolUseId.set(call.id, call)

  const items: RemoteInboxItem[] = []
  const seen = new Set<string>()

  for (const item of useBackgroundSessionStore.getState().inboxItems) {
    if (item.resolvedAt) continue
    const call = item.toolUseId ? byToolUseId.get(item.toolUseId) : undefined
    const meta = sessionOf(item.sessionId)
    if (item.toolUseId) seen.add(item.toolUseId)
    items.push({
      id: item.id,
      sessionId: item.sessionId,
      sessionTitle: meta.title,
      projectId: meta.projectId,
      type: item.type,
      title: item.title,
      description: item.description,
      toolUseId: item.toolUseId,
      detail: call ? shortJson(call.input) : undefined,
      questions: call?.name === 'AskUserQuestion' ? askQuestions(call.input) : undefined,
      createdAt: item.createdAt
    })
  }

  for (const call of byToolUseId.values()) {
    if (seen.has(call.id)) continue
    const isQuestion = call.name === 'AskUserQuestion'
    const isApproval = call.requiresApproval || call.status === 'pending_approval'
    if (!isQuestion && !isApproval) continue
    const sessionId = call.sessionId ?? ''
    if (!sessionId) continue
    const meta = sessionOf(sessionId)
    items.push({
      id: `live:${call.id}`,
      sessionId,
      sessionTitle: meta.title,
      projectId: meta.projectId,
      type: isQuestion ? 'ask_user' : 'approval',
      title: isQuestion ? (askQuestions(call.input)[0]?.header ?? '需要你的选择') : call.name,
      description: meta.title,
      toolUseId: call.id,
      detail: shortJson(call.input),
      questions: isQuestion ? askQuestions(call.input) : undefined,
      createdAt: call.startedAt ?? Date.now()
    })
  }

  return items.sort((left, right) => right.createdAt - left.createdAt)
}

/**
 * Git over the wire.
 *
 * Reading status is always allowed; committing is gated on the desktop's
 * `gitWriteEnabled` switch, which is off unless someone turned it on — a leaked
 * pairing QR should not be able to write to the repository.
 */
function gitFiles(files: GitStatusFile[] | undefined): RemoteGitStatus['staged'] {
  return (files ?? []).map((file) => ({
    path: file.path,
    stagedStatus: file.stagedStatus,
    unstagedStatus: file.unstagedStatus
  }))
}

function resolveRepoPath(requested: unknown): string {
  if (typeof requested === 'string' && requested.trim()) return requested
  const chat = useChatStore.getState()
  const project = chat.projects.find((item) => item.id === chat.activeProjectId)
  const folder = project?.workingFolder
  if (!folder) throw new Error('No repository is open on the desktop')
  return folder
}

function changeset(c: AgentRunChangeSet): RemoteChangeSet {
  return {
    runId: c.runId,
    sessionId: c.sessionId,
    assistantMessageId: c.assistantMessageId,
    status: c.status,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    changes: c.changes.map((f) => ({ id: f.id, filePath: f.filePath, op: f.op, status: f.status }))
  }
}
function side(s: { exists: boolean; text?: string; previewText?: string; textOmitted?: boolean }): {
  exists: boolean
  text: string
  truncated: boolean
} {
  const omitted = s.textOmitted || s.text === undefined
  const text = s.text ?? s.previewText ?? ''
  return {
    exists: s.exists,
    text: text.slice(0, REMOTE_DIFF_TEXT_LIMIT),
    truncated: omitted || text.length > REMOTE_DIFF_TEXT_LIMIT
  }
}

export async function handleRemoteRequest(op: string, payload: unknown): Promise<unknown> {
  const p = asRecord(payload)
  const chat = useChatStore.getState()
  switch (op as RemoteRequestOp) {
    case OPS.SNAPSHOT_BOOTSTRAP:
      await Promise.all(
        chat.projects.map((project) => chat.loadProjectSessions(project.id).catch(() => undefined))
      )
      return buildSnapshot()
    case OPS.WORKSPACE_LIST:
      return { workspaces: useChatStore.getState().projects.map(workspace) }
    case OPS.SESSION_LIST: {
      const projectId = typeof p.projectId === 'string' ? p.projectId : ''
      if (projectId) await chat.loadProjectSessions(projectId)
      const latest = useChatStore.getState()
      const rows = latest.sessions.filter((s) => !projectId || s.projectId === projectId)
      const page = projectId ? latest.sessionListPageState[projectId] : undefined
      return {
        sessions: rows.map(session),
        nextCursor: page?.cursor ?? null,
        hasMore: Boolean(page?.hasMore)
      }
    }
    case OPS.SESSION_MESSAGES: {
      const id = typeof p.sessionId === 'string' ? p.sessionId : ''
      const limit = typeof p.limit === 'number' ? p.limit : undefined
      if (p.older === true) await chat.loadOlderSessionMessages(id, limit)
      else await chat.ensureSessionWindow(id)
      const s = useChatStore.getState().sessions.find((x) => x.id === id)
      const all = s?.messages ?? []
      return {
        messages: messageWindow(all, useAgentStore.getState().isSessionRunActive(id)),
        total: s?.messageCount ?? all.length,
        hasOlder: Boolean(s?.hasOlder)
      }
    }
    case OPS.SESSION_SEND: {
      const images = Array.isArray(p.images) ? (p.images as RemoteImage[]) : []
      const attachments: ImageAttachment[] = images.map((i) => ({
        id: nanoid(),
        mediaType: i.mediaType,
        dataUrl: `data:${i.mediaType};base64,${i.dataBase64}`
      }))
      triggerSendMessage(typeof p.text === 'string' ? p.text : '', String(p.sessionId), attachments)
      return { ok: true }
    }
    case OPS.SESSION_STOP: {
      const id = String(p.sessionId)
      if (p.force) abortSession(id)
      else stopSessionStreaming(id)
      return { ok: true }
    }
    case OPS.SESSION_CREATE: {
      const id = chat.createSession(
        (typeof p.mode === 'string' ? p.mode : 'chat') as SessionMode,
        typeof p.projectId === 'string' ? p.projectId : null,
        { workingFolder: typeof p.workingFolder === 'string' ? p.workingFolder : undefined }
      )
      return { sessionId: id }
    }
    case OPS.SESSION_MODE_SET: {
      chat.updateSessionMode(String(p.sessionId), String(p.mode) as SessionMode)
      return { ok: true }
    }
    case OPS.SESSION_DELETE: {
      const id = String(p.sessionId ?? '')
      if (!id) throw new Error('sessionId is required')
      if (!chat.sessions.some((item) => item.id === id)) throw new Error('Session not found')
      // A run left going would keep streaming into a transcript that is gone.
      if (useAgentStore.getState().isSessionRunActive(id)) abortSession(id)
      chat.deleteSession(id)
      await publishSessionList()
      return { ok: true }
    }
    case OPS.SESSION_CLEAR: {
      // The phone's dialog is the real confirmation; this only makes sure the op
      // cannot be reached by a payload that lost its body on the way here.
      if (p.confirm !== true) throw new Error('confirm is required')
      const projectId = typeof p.projectId === 'string' ? p.projectId : ''
      const agent = useAgentStore.getState()
      const targets = chat.sessions.filter((item) => !projectId || item.projectId === projectId)
      for (const item of targets) if (agent.isSessionRunActive(item.id)) abortSession(item.id)
      // Scoped to a project this has to go session by session; the store's own
      // sweep is all-or-nothing.
      if (projectId) for (const item of targets) chat.deleteSession(item.id)
      else chat.clearAllSessions()
      await publishSessionList()
      return { deleted: targets.length }
    }
    case OPS.MESSAGE_DELETE: {
      const sessionId = String(p.sessionId ?? '')
      const messageId = String(p.messageId ?? '')
      if (!sessionId || !messageId) throw new Error('sessionId and messageId are required')
      if (!(await deleteSessionMessage(sessionId, messageId))) {
        throw new Error('This message cannot be deleted on its own')
      }
      return { ok: true }
    }
    case OPS.MESSAGE_RETRY: {
      const sessionId = String(p.sessionId ?? '')
      if (!sessionId) throw new Error('sessionId is required')
      const messageId = typeof p.messageId === 'string' && p.messageId ? p.messageId : undefined
      if (!(await retrySessionMessage(sessionId, messageId))) {
        throw new Error('Nothing to regenerate in this session')
      }
      return { ok: true }
    }
    case OPS.INBOX_LIST:
      return { inbox: inboxItems() }
    case OPS.GIT_STATUS: {
      const repoPath = resolveRepoPath(p.repoPath)
      const git = useGitStore.getState()
      await git.refreshRepository(repoPath, { force: true })
      const details = useGitStore.getState().repoDetailsByPath[repoPath]
      const status = details?.status
      if (!status) throw new Error(details?.error || 'Not a git repository')
      return {
        repoPath,
        branch: status.branch,
        upstream: status.upstream,
        ahead: status.ahead,
        behind: status.behind,
        staged: gitFiles(status.staged),
        unstaged: gitFiles(status.unstaged),
        untracked: gitFiles(status.untracked),
        conflicted: gitFiles(status.conflicted),
        canCommit: remoteState.gitWriteEnabled
      } satisfies RemoteGitStatus
    }
    case OPS.GIT_COMMIT: {
      if (!remoteState.gitWriteEnabled) {
        throw new Error('桌面端未开启「允许手机提交」')
      }
      const message = typeof p.message === 'string' ? p.message.trim() : ''
      if (!message) throw new Error('Commit message is required')
      const repoPath = resolveRepoPath(p.repoPath)
      const git = useGitStore.getState()
      if (p.stageAll !== false) {
        const staged = await git.stageAll(repoPath)
        if (!staged.success) throw new Error(staged.error || 'Failed to stage changes')
      }
      const result = await git.commit(repoPath, message)
      if (!result.success) throw new Error(result.error || 'Commit failed')
      return { ok: true }
    }
    case OPS.ASKUSER_RESPOND: {
      const toolUseId = String(p.toolUseId ?? '')
      if (!toolUseId) throw new Error('toolUseId is required')
      const answers =
        p.answers && typeof p.answers === 'object'
          ? (p.answers as Record<string, string | string[]>)
          : {}
      // A question answered on the desktop first leaves no resolver behind, and
      // `resolveAskUserAnswers` is a no-op in that case — the phone losing a race
      // should not surface as an error.
      resolveAskUserAnswers(toolUseId, { answers })
      return { ok: true }
    }
    case OPS.MODEL_LIST: {
      const providerStore = useProviderStore.getState()
      const providers: RemoteModelProvider[] = providerStore.providers
        .filter((provider) => isProviderAvailableForModelSelection(provider))
        .map((provider) => ({
          id: provider.id,
          name: provider.name,
          icon: provider.icon,
          models: provider.models
            .filter((model) => model.enabled && (model.category ?? 'chat') === 'chat')
            .map((model) => ({
              id: model.id,
              name: model.name || model.id,
              icon: model.icon,
              contextLength: model.contextLength,
              supportsVision: model.supportsVision,
              supportsThinking: model.supportsThinking,
              supportsFunctionCall: model.supportsFunctionCall
            }))
        }))
        .filter((provider) => provider.models.length > 0)
      const scoped = typeof p.sessionId === 'string' ? p.sessionId : ''
      const selection = resolveSessionModelSelection({
        session: scoped ? chat.sessions.find((item) => item.id === scoped) : null,
        providers: providerStore.providers,
        activeProviderId: providerStore.activeProviderId,
        activeModelId: providerStore.activeModelId
      })
      return {
        providers,
        selectedProviderId: selection.providerId,
        selectedModelId: selection.modelId
      }
    }
    case OPS.MODEL_SELECT: {
      const providerId = String(p.providerId ?? '')
      const modelId = String(p.modelId ?? '')
      if (!providerId || !modelId) throw new Error('providerId and modelId are required')
      const providerStore = useProviderStore.getState()
      const provider = providerStore.providers.find((item) => item.id === providerId)
      if (!provider) throw new Error('Provider not found')
      if (!provider.models.some((item) => item.id === modelId)) throw new Error('Model not found')
      const sessionId = typeof p.sessionId === 'string' ? p.sessionId : ''
      if (sessionId) {
        chat.setSessionModelManual(sessionId, providerId, modelId)
      } else {
        if (providerId !== providerStore.activeProviderId)
          providerStore.setActiveProvider(providerId)
        providerStore.setActiveModel(modelId)
      }
      return { ok: true, providerId, modelId }
    }
    case OPS.MODEL_SETTINGS:
      return buildModelSettings(typeof p.sessionId === 'string' ? p.sessionId : '')
    case OPS.MODEL_SETTINGS_SET: {
      const controlId = String(p.controlId ?? '')
      if (!controlId) throw new Error('controlId is required')
      const value = p.value
      if (typeof value !== 'boolean' && typeof value !== 'string' && typeof value !== 'number') {
        throw new Error('value must be a boolean, string, or number')
      }
      return applyModelSetting(typeof p.sessionId === 'string' ? p.sessionId : '', controlId, value)
    }
    case OPS.TASK_LIST:
      return {
        tasks: (p.sessionId
          ? useTaskStore.getState().getTasksBySession(String(p.sessionId))
          : useTaskStore.getState().getTasks()
        ).map(task)
      }
    case OPS.TASK_CREATE: {
      const now = Date.now()
      const item: TaskItem = {
        id: nanoid(),
        sessionId: typeof p.sessionId === 'string' ? p.sessionId : undefined,
        subject: String(p.subject ?? ''),
        description: typeof p.description === 'string' ? p.description : '',
        status: 'pending',
        blocks: [],
        blockedBy: [],
        metadata:
          p.metadata && typeof p.metadata === 'object'
            ? (p.metadata as Record<string, unknown>)
            : undefined,
        createdAt: now,
        updatedAt: now
      }
      return { task: task(useTaskStore.getState().addTask(item)) }
    }
    case OPS.TASK_UPDATE: {
      const updated = useTaskStore
        .getState()
        .updateTask(
          String(p.taskId),
          asRecord(p.patch) as Partial<Omit<TaskItem, 'id' | 'createdAt'>>
        )
      if (!updated) throw new Error('Task not found')
      return { task: task(updated) }
    }
    case OPS.TASK_ACTION: {
      const id = String(p.taskId)
      const action = String(p.action)
      const found = useTaskStore.getState().getTask(id)
      if (!found) throw new Error('Task not found')
      if (action === 'rename')
        useTaskStore.getState().updateTask(id, { subject: String(p.value ?? '') })
      else if (action === 'archive') useTaskStore.getState().updateTask(id, { status: 'completed' })
      else if (action === 'pin' || action === 'markUnread')
        useTaskStore.getState().updateTask(id, {
          metadata: {
            ...(found.metadata ?? {}),
            [action === 'pin' ? 'remotePinned' : 'remoteUnread']: true
          }
        })
      else if (action === 'copyPath')
        return {
          ok: true,
          path: found.sessionId
            ? (useChatStore.getState().sessions.find((s) => s.id === found.sessionId)
                ?.workingFolder ?? '')
            : ''
        }
      return { ok: true }
    }
    case OPS.APPROVAL_RESPOND: {
      const requestId = String(p.requestId)
      const agent = useAgentStore.getState()
      const pending = [
        ...agent.pendingToolCalls,
        ...Object.values(agent.sessionToolCallsCache).flatMap((cache) => cache.pending)
      ]
      const match = pending.find(
        (call) =>
          call.id === requestId ||
          (call.extraContent && JSON.stringify(call.extraContent).includes(requestId))
      )
      if (!match) throw new Error('Approval request not found')
      agent.resolveApproval(match.id, p.approved === true)
      sendEvent(EVENTS.APPROVAL_RESOLVED, { requestId })
      return { ok: true }
    }
    case OPS.REVIEW_CHANGESETS: {
      const sessionId =
        typeof p.sessionId === 'string' && p.sessionId
          ? p.sessionId
          : (useChatStore.getState().activeSessionId ?? '')
      if (sessionId) await useAgentStore.getState().refreshSessionRunChanges(sessionId)
      const seen = new Set<string>()
      const out: RemoteChangeSet[] = []
      for (const c of Object.values(useAgentStore.getState().runChangesByRunId))
        if ((!sessionId || c.sessionId === sessionId) && !seen.has(c.runId)) {
          seen.add(c.runId)
          out.push(changeset(c))
        }
      return { changesets: out }
    }
    case OPS.REVIEW_DIFF: {
      const c = findChange(String(p.runId), String(p.changeId))
      if (!c) throw new Error('Change not found')
      return {
        changeId: c.id,
        filePath: c.filePath,
        op: c.op,
        before: side(c.before),
        after: side(c.after)
      } as RemoteDiff
    }
    case OPS.REVIEW_REVERT: {
      const result = p.changeId
        ? await useAgentStore.getState().undoFileChange(String(p.runId), String(p.changeId))
        : await useAgentStore.getState().undoRunChanges(String(p.runId))
      if (result.error) throw new Error(result.error)
      return { ok: true }
    }
    default:
      throw new Error(`Unsupported operation: ${op}`)
  }
}
function findChange(runId: string, id: string): AgentRunFileChange | undefined {
  return useAgentStore.getState().runChangesByRunId[runId]?.changes.find((c) => c.id === id)
}
function buildSnapshot(): RemoteSnapshot {
  const c = useChatStore.getState()
  return {
    deviceName: remoteState.deviceName || remoteState.deviceId || 'OpenCowork',
    activeProjectId: c.activeProjectId,
    activeSessionId: c.activeSessionId,
    workspaces: c.projects.map(workspace),
    sessions: c.sessions.map(session),
    tasks: useTaskStore.getState().getTasks().map(task),
    terminals: useTerminalStore.getState().tabs.map((t) => ({
      id: t.id,
      title: t.title,
      cwd: t.cwd,
      shell: t.shell,
      status: t.status,
      exitCode: t.exitCode,
      projectId: t.projectId
    })),
    capabilities: {
      terminalWriteEnabled: remoteState.terminalWriteEnabled,
      gitWriteEnabled: remoteState.gitWriteEnabled
    },
    inbox: inboxItems(),
    unreadBySession: { ...useBackgroundSessionStore.getState().unreadCountsBySession },
    serverTimeMs: Date.now()
  }
}

/**
 * The bridge currently listening, so a second one can never exist.
 *
 * Every op behind `handleRemoteRequest` is a write, and none of them are
 * idempotent: two listeners on `remote-control:request` turn one phone tap into
 * two `session.create` calls, or two `message.retry` calls that each truncate and
 * resend the same turn. Main dedupes by envelope id, but that is upstream of this
 * IPC hop and cannot see a fan-out that happens here. A hot reload or a remount
 * that failed to clean up is all it takes.
 */
let activeBridge: (() => void) | null = null

/**
 * Request ids already served, so a duplicate delivery cannot run the write twice.
 *
 * Belt to the single-bridge braces: this one covers a fan-out anywhere upstream
 * of the renderer, which the bridge guard cannot. Ids are never reused — the
 * phone mints a fresh one per request and does not retry.
 */
const servedRequestIds = new Map<string, number>()
const SERVED_REQUEST_TTL_MS = 5 * 60_000
const SERVED_REQUEST_LIMIT = 4096

function claimRendererRequest(id: string): boolean {
  const now = Date.now()
  // Insertion order is chronological, so the first entry still inside the window
  // ends the sweep.
  for (const [servedId, servedAt] of servedRequestIds) {
    if (now - servedAt < SERVED_REQUEST_TTL_MS) break
    servedRequestIds.delete(servedId)
  }
  if (servedRequestIds.has(id)) return false
  servedRequestIds.set(id, now)
  if (servedRequestIds.size > SERVED_REQUEST_LIMIT) {
    const oldest = servedRequestIds.keys().next()
    if (!oldest.done) servedRequestIds.delete(oldest.value)
  }
  return true
}

export function startRemoteStateBridge(): () => void {
  activeBridge?.()
  const offRequest = ipcClient.on(IPC.REMOTE_CONTROL_REQUEST, (value: unknown) => {
    const req = value as RemoteRendererRequest
    if (!claimRendererRequest(req.id)) {
      console.warn('[remote-control] renderer dropped an already-served request', {
        id: req.id,
        op: req.op
      })
      return
    }
    void handleRemoteRequest(req.op, req.payload)
      .then((data) => ipcClient.send(IPC.REMOTE_CONTROL_RESPONSE, { id: req.id, ok: true, data }))
      .catch((error: unknown) =>
        ipcClient.send(IPC.REMOTE_CONTROL_RESPONSE, {
          id: req.id,
          ok: false,
          error: {
            code: 'internal',
            message: error instanceof Error ? error.message : 'Remote request failed'
          }
        })
      )
  })
  const offChanged = ipcClient.on(IPC.REMOTE_CONTROL_CHANGED, (value: unknown) => {
    if (value && typeof value === 'object') remoteState = value as RemoteControlState
  })
  void ipcClient
    .invoke(IPC.REMOTE_CONTROL_GET)
    .then((value) => {
      if (value && typeof value === 'object') remoteState = value as RemoteControlState
    })
    .catch(() => {})
  const offTask = useTaskStore.subscribe(() => {
    // Both stores fire on every mutation, several times per streamed token. Sending
    // only when the projected shape actually differs keeps a running turn from
    // flooding the phone with identical frames.
    const current = useTaskStore.getState().getTasks()
    for (const t of current) {
      const projected = task(t)
      const signature = JSON.stringify(projected)
      if (lastTaskSignatures.get(t.id) === signature) continue
      lastTaskSignatures.set(t.id, signature)
      sendEvent(EVENTS.TASK_CHANGED, { task: projected })
    }
    const live = new Set(current.map((t) => t.id))
    for (const id of lastTaskSignatures.keys()) if (!live.has(id)) lastTaskSignatures.delete(id)
  })
  const offSession = useAgentStore.subscribe(() => {
    const running = useAgentStore.getState().runningSessions
    for (const [id, status] of Object.entries(running)) {
      const normalized = status === 'retrying' ? 'running' : status
      if (lastSessionStatuses.get(id) === normalized) continue
      lastSessionStatuses.set(id, normalized)
      sendEvent(EVENTS.SESSION_STATUS, { sessionId: id, status: normalized })
    }
    /**
     * A finished run is *removed* from `runningSessions` rather than moved to a
     * terminal value, so iterating its keys alone can never report the end of a
     * turn — the phone keeps the last status it was sent, `running`, and shows a
     * thinking indicator and a stop button for a turn that is long over.
     *
     * Only a clean completion announces itself: that path sets `completed` before
     * the key is swept three seconds later. Every abort, provider error and failed
     * preflight calls `setSessionStatus(id, null)`, which deletes the key outright.
     * So a key that disappears without having reported `completed` ended without
     * completing, and `stopped` is what the phone needs to hear.
     */
    for (const [id, last] of lastSessionStatuses) {
      if (id in running) continue
      lastSessionStatuses.delete(id)
      if (last === 'completed') continue
      sendEvent(EVENTS.SESSION_STATUS, { sessionId: id, status: 'stopped' })
    }
  })
  const publishInbox = (): void => {
    const inbox = inboxItems()
    const signature = JSON.stringify(inbox)
    if (signature === lastInboxSignature) return
    lastInboxSignature = signature
    sendEvent(EVENTS.INBOX_CHANGED, { inbox })
  }
  const offInbox = useBackgroundSessionStore.subscribe(publishInbox)
  // Approvals and questions for a *foreground* session are never filed in the
  // background store, so the agent store has to be watched too.
  const offInboxAgent = useAgentStore.subscribe(publishInbox)

  /**
   * Pushes every message of a running turn that changed since the last flush.
   *
   * Nothing used to emit this, so a phone watching a live turn had to re-download
   * the whole message window on a timer just to see tool calls appear. `chat-store`
   * already coalesces deltas per animation frame and bumps `_revision` on every
   * mutation, so a revision check plus one more throttle is enough — no deep
   * comparison of message content.
   *
   * Only the *tail* used to go out, which quietly lost content: the moment the next
   * message opened, the one that had been streaming stopped being pushed and stayed
   * on the phone in whatever half-written state it was last seen — usually empty,
   * because a fresh assistant message opens before it has produced anything. So the
   * whole tail window is swept, and each message is sent only when its own revision
   * moved.
   *
   * The whole message goes out rather than a text delta: it is idempotent, it
   * survives a reconnect without the phone stitching fragments together, and tool
   * calls ride along with it.
   */
  let sessionFlushTimer: ReturnType<typeof setTimeout> | null = null
  const publishSessionMessages = (): void => {
    const agent = useAgentStore.getState()
    for (const session of useChatStore.getState().sessions) {
      if (!agent.isSessionRunActive(session.id)) continue
      const messages = session.messages ?? []
      if (messages.length === 0) continue
      // A tool row's summary needs its result, and results land in later messages —
      // so the whole window is scanned even though only changed ones are sent.
      const results = new Map<string, { text: string; isError: boolean }>()
      for (const m of messages) {
        if (typeof m.content === 'string') continue
        for (const b of m.content) {
          if (b.type !== 'tool_result') continue
          results.set(b.toolUseId, {
            text: typeof b.content === 'string' ? b.content : shortJson(b.content),
            isError: b.isError === true
          })
        }
      }
      // One turn cannot span more than a handful of messages, and anything older
      // than that is settled — the phone already has it from its window fetch.
      for (const m of messages.slice(-SESSION_PUSH_WINDOW)) {
        const key = `${session.id}:${m.id}`
        const revision = String(m._revision ?? 0)
        if (lastMessageRevisions.get(key) === revision) continue
        lastMessageRevisions.set(key, revision)
        sendEvent(EVENTS.SESSION_MESSAGE, {
          sessionId: session.id,
          message: message(m, { results, running: true })
        })
      }
    }
  }
  /**
   * Tells the phone to re-read a transcript whose history *shrank*.
   *
   * `SESSION_MESSAGE` is an upsert — it can add a message and it can update one,
   * but it has no way to say that a message is gone. Regenerating truncates the
   * session from the retried user message down (`retrySessionMessage`), and
   * deleting a message takes its dependents with it, so after either the phone
   * would still be rendering messages the desktop no longer has and would append
   * the replacement turn *below* the dead one. That is what a phone shows after
   * tapping regenerate on a failed turn: the failed turn stays, and the retry
   * appears under it.
   *
   * A previously-published id that is no longer in the session is the signal, and
   * its revision entry is dropped so the replacement turn republishes cleanly.
   */
  const publishSessionTruncations = (): void => {
    for (const session of useChatStore.getState().sessions) {
      const live = new Set((session.messages ?? []).map((m) => m.id))
      const prefix = `${session.id}:`
      let dropped = false
      for (const key of lastMessageRevisions.keys()) {
        // Sliced by the known prefix length rather than split on ':', because a
        // message id may contain one.
        if (!key.startsWith(prefix) || live.has(key.slice(prefix.length))) continue
        lastMessageRevisions.delete(key)
        dropped = true
      }
      if (dropped) sendEvent(EVENTS.SESSION_TRUNCATED, { sessionId: session.id })
    }
  }
  const offSessionMessages = useChatStore.subscribe(() => {
    if (sessionFlushTimer !== null) return
    sessionFlushTimer = setTimeout(() => {
      sessionFlushTimer = null
      // Before the pushes: the phone must drop the truncated tail first, or the
      // replacement turn lands underneath the messages it replaces.
      publishSessionTruncations()
      publishSessionMessages()
      // Same timer on purpose: deleting a session mutates the store once, and a
      // second throttle would only add a way for the two views to disagree.
      void publishSessionList()
    }, REMOTE_SESSION_FLUSH_MS)
  })

  /** Reviewable changes, so the phone's changes screen stops needing a manual open. */
  const offReview = useAgentStore.subscribe(() => {
    const seen = new Set<string>()
    const changesets: RemoteChangeSet[] = []
    for (const c of Object.values(useAgentStore.getState().runChangesByRunId)) {
      if (seen.has(c.runId)) continue
      seen.add(c.runId)
      changesets.push(changeset(c))
    }
    const signature = JSON.stringify(changesets)
    if (signature === lastReviewSignature) return
    lastReviewSignature = signature
    sendEvent(EVENTS.REVIEW_CHANGED, { changesets })
  })

  const stop = (): void => {
    // Only clear the handle if this bridge is still the live one; a bridge that
    // was already replaced must not un-register its successor.
    if (activeBridge === stop) activeBridge = null
    offRequest()
    offChanged()
    offTask()
    offSession()
    offInbox()
    offInboxAgent()
    offSessionMessages()
    offReview()
    if (sessionFlushTimer !== null) clearTimeout(sessionFlushTimer)
  }
  activeBridge = stop
  return stop
}

export const startRemoteControlProjector = startRemoteStateBridge
