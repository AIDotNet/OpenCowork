/**
 * Shared contract between the Electron main process, the renderer, and the mobile
 * remote-control web client.
 *
 * Wire layering (see .plan/remote-control-wire-contract.md):
 *
 *   SignalR frame (MessagePack)
 *     └── RemoteEnvelope          ← the only shape the relay server understands
 *           └── Payload: bytes    ← opaque to the server, never parsed there
 *                 └── UTF-8 JSON  ← the desktop ⇄ mobile business payload
 *
 * The envelope keeps PascalCase field names because the server serialises it with
 * MessagePack `keyAsPropertyName: true`. Inner payloads never reach C#, so they use
 * ordinary camelCase.
 */

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export type RemoteEnvelopeKind = 'req' | 'res' | 'evt' | 'err'

/** Mirrors `Meteor.ApiService.Services.RemoteControl.Protocol.RemoteEnvelope`. */
export interface RemoteEnvelope {
  /** Correlates a response with its request; chunks of one message share it. */
  Id: string
  Kind: RemoteEnvelopeKind
  Op: string
  /** Target/origin phone. Absent when the desktop broadcasts to every phone. */
  MobileId?: string | null
  /** Chunk index, zero based. */
  Seq: number
  /** Chunk count; 1 means the payload was not split. */
  Total: number
  /** UTF-8 JSON bytes. Empty payloads use a zero-length array, never null. */
  Payload: Uint8Array
}

/** Per-chunk payload ceiling. The server caps a frame at 64KB; this leaves headroom. */
export const REMOTE_CHUNK_LIMIT = 48 * 1024

/** A partially reassembled message is dropped after this long. */
export const REMOTE_CHUNK_TIMEOUT_MS = 30_000

/** Ceiling on all in-flight reassembly buffers before the oldest are evicted. */
export const REMOTE_CHUNK_BUFFER_LIMIT = 32 * 1024 * 1024

/** A request without a response is failed after this long. */
export const REMOTE_REQUEST_TIMEOUT_MS = 30_000

/** Terminal output is batched over this window before being sent to a phone. */
export const REMOTE_TERMINAL_FLUSH_MS = 100

/**
 * Streaming message updates are batched over this window. The renderer already
 * coalesces deltas per animation frame (`chat-store`'s `flushStreamDeltas`), which
 * caps them near 60/s — still far too many for a phone on mobile data, so the
 * projector throttles again on top.
 */
export const REMOTE_SESSION_FLUSH_MS = 300

/** Oversized text blocks are truncated to this many characters in snapshots. */
export const REMOTE_TEXT_BLOCK_LIMIT = 8 * 1024

/** Per-side ceiling for a diff payload. */
export const REMOTE_DIFF_TEXT_LIMIT = 256 * 1024

export interface RemoteErrorPayload {
  code: RemoteErrorCode
  message: string
}

export type RemoteErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'internal'
  | 'timeout'
  | 'desktop_offline'
  | 'terminal_write_disabled'
  | 'terminal_command_denied'
  | 'unsupported_op'

// ---------------------------------------------------------------------------
// Operation codes
// ---------------------------------------------------------------------------

/** Phone → desktop requests. */
export const REMOTE_REQUEST_OPS = {
  SNAPSHOT_BOOTSTRAP: 'snapshot.bootstrap',
  WORKSPACE_LIST: 'workspace.list',
  SESSION_LIST: 'session.list',
  SESSION_MESSAGES: 'session.messages',
  SESSION_SEND: 'session.send',
  SESSION_STOP: 'session.stop',
  SESSION_CREATE: 'session.create',
  SESSION_DELETE: 'session.delete',
  SESSION_CLEAR: 'session.clear',
  MESSAGE_DELETE: 'message.delete',
  MESSAGE_RETRY: 'message.retry',
  TASK_LIST: 'task.list',
  TASK_CREATE: 'task.create',
  TASK_UPDATE: 'task.update',
  TASK_ACTION: 'task.action',
  APPROVAL_RESPOND: 'approval.respond',
  TERMINAL_LIST: 'terminal.list',
  TERMINAL_CREATE: 'terminal.create',
  TERMINAL_INPUT: 'terminal.input',
  TERMINAL_RESIZE: 'terminal.resize',
  TERMINAL_KILL: 'terminal.kill',
  TERMINAL_SUBSCRIBE: 'terminal.subscribe',
  TERMINAL_UNSUBSCRIBE: 'terminal.unsubscribe',
  REVIEW_CHANGESETS: 'review.changesets',
  REVIEW_DIFF: 'review.diff',
  REVIEW_REVERT: 'review.revert',
  SESSION_KEEPALIVE: 'session.keepalive',
  MODEL_LIST: 'model.list',
  MODEL_SELECT: 'model.select',
  MODEL_SETTINGS: 'model.settings',
  MODEL_SETTINGS_SET: 'model.settings.set',
  SESSION_MODE_SET: 'session.mode',
  INBOX_LIST: 'inbox.list',
  ASKUSER_RESPOND: 'askuser.respond',
  GIT_STATUS: 'git.status',
  GIT_COMMIT: 'git.commit'
} as const

export type RemoteRequestOp = (typeof REMOTE_REQUEST_OPS)[keyof typeof REMOTE_REQUEST_OPS]

/** Desktop → phone events. */
export const REMOTE_EVENT_OPS = {
  SNAPSHOT: 'evt.snapshot',
  SESSION_DELTA: 'evt.session.delta',
  SESSION_STATUS: 'evt.session.status',
  SESSION_MESSAGE: 'evt.session.message',
  /**
   * The desktop's whole session list, pushed whenever it changes shape.
   *
   * Sending the list rather than delete/rename deltas is what makes a phone that
   * missed an event still correct: the next push overwrites whatever it thought.
   * Without this a session deleted on the desktop stayed on the phone until it
   * reconnected, and tapping it opened a transcript that no longer existed.
   */
  SESSION_LIST_CHANGED: 'evt.session.list',
  TASK_CHANGED: 'evt.task.changed',
  APPROVAL_REQUEST: 'evt.approval.request',
  APPROVAL_RESOLVED: 'evt.approval.resolved',
  /**
   * The whole pending-inbox list, pushed on every change. Sending the list rather
   * than add/remove deltas keeps the phone correct across reconnects and drops —
   * the same list is also on the snapshot, so there is one shape to trust.
   */
  INBOX_CHANGED: 'evt.inbox.changed',
  TERMINAL_OUTPUT: 'evt.terminal.output',
  TERMINAL_EXIT: 'evt.terminal.exit',
  REVIEW_CHANGED: 'evt.review.changed',
  DESKTOP_OFFLINE: 'evt.desktop.offline',
  /**
   * The remote link itself was revoked — the client tears the hub down and shows
   * its "invalidated" screen. NOT a transcript event: use SESSION_TRUNCATED to
   * say that a session's history changed shape.
   */
  SESSION_INVALIDATED: 'evt.session.invalidated',
  /**
   * A session's history shrank — regenerated, a message deleted, a transcript
   * compacted. `SESSION_MESSAGE` is an upsert and cannot express a removal, so
   * without acting on this the client keeps rendering messages the desktop no
   * longer has and appends the replacement turn below them. Clients must respond
   * by re-fetching the window with `session.messages`.
   */
  SESSION_TRUNCATED: 'evt.session.truncated',
  CAPABILITIES: 'evt.capabilities'
} as const

export type RemoteEventOp = (typeof REMOTE_EVENT_OPS)[keyof typeof REMOTE_EVENT_OPS]

/**
 * Ops the main process serves on its own, without asking the renderer. Terminals
 * live in main (node-pty), so routing them through the renderer would add a hop
 * and break whenever the renderer is busy.
 */
export const REMOTE_MAIN_HANDLED_OPS: readonly string[] = [
  REMOTE_REQUEST_OPS.TERMINAL_LIST,
  REMOTE_REQUEST_OPS.TERMINAL_CREATE,
  REMOTE_REQUEST_OPS.TERMINAL_INPUT,
  REMOTE_REQUEST_OPS.TERMINAL_RESIZE,
  REMOTE_REQUEST_OPS.TERMINAL_KILL,
  REMOTE_REQUEST_OPS.TERMINAL_SUBSCRIBE,
  REMOTE_REQUEST_OPS.TERMINAL_UNSUBSCRIBE,
  REMOTE_REQUEST_OPS.SESSION_KEEPALIVE
]

// ---------------------------------------------------------------------------
// Business payloads (desktop ⇄ mobile, camelCase)
// ---------------------------------------------------------------------------

/** Projected from the renderer's `Project`. */
export interface RemoteWorkspace {
  id: string
  name: string
  icon?: string
  workingFolder?: string
  pinned?: boolean
  sessionCount?: number
  updatedAt: number
}

/** Projected from the renderer's `Session`; messages are fetched separately. */
export interface RemoteSession {
  id: string
  title: string
  icon?: string
  mode: string
  projectId?: string
  workingFolder?: string
  pinned?: boolean
  messageCount: number
  createdAt: number
  updatedAt: number
  running: boolean
  /** Model bound to this session, resolved the same way the desktop pill resolves it. */
  providerId?: string
  modelId?: string
  /** Display label for the model pill, e.g. `Grok 4.6`. */
  modelLabel?: string
  providerName?: string
}

/** Mirrors the renderer's `SessionListCursor`. */
export interface RemoteCursor {
  pinned: number
  updatedAt: number
  id: string
}

export type RemoteMessageRole = 'system' | 'user' | 'assistant' | 'tool'

/**
 * How the phone should treat a tool call, mirroring `execution-outline`'s
 * classification: `ordinary` calls fold into one `Explored` run, `force` calls
 * stay on screen, `hidden` ones never render.
 */
export type RemoteToolVisibility = 'hidden' | 'ordinary' | 'force'

/**
 * A sub-agent's progress, summarised.
 *
 * The desktop's `SubAgentCard` can show the sub-agent's whole inner transcript;
 * that is a full `UnifiedMessage[]` and would dwarf the rest of the payload, so
 * only the headline state and the final report travel to a phone.
 */
export interface RemoteSubAgent {
  name: string
  displayName?: string
  description: string
  isRunning: boolean
  isQueued?: boolean
  success: boolean | null
  errorMessage?: string | null
  iteration: number
  toolCallCount: number
  /** Final result text; empty while the sub-agent is still working. */
  report: string
}

export type RemoteToolStatus =
  | 'streaming'
  | 'running'
  | 'pending_approval'
  | 'completed'
  | 'error'
  | 'canceled'

/**
 * Flattened message block. The renderer collapses `string | ContentBlock[]` into
 * this shape so the phone can render without knowing provider content models.
 */
export type RemoteBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'image'; url: string }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: string
      /** Tool label as the desktop transcript prints it (MCP names are prettified). */
      label?: string
      /** One-line detail the desktop shows next to the label. */
      summary?: string
      visibility?: RemoteToolVisibility
      status?: RemoteToolStatus
      /** Present on `Task` calls, so the phone can render a sub-agent card. */
      subAgent?: RemoteSubAgent
    }
  | { type: 'tool_result'; toolUseId: string; text: string; isError?: boolean }
  | { type: 'web_search'; query: string; status?: string }
  | { type: 'error'; message: string }

export interface RemoteMessage {
  id: string
  role: RemoteMessageRole
  createdAt: number
  blocks: RemoteBlock[]
}

export interface RemoteImage {
  mediaType: string
  dataBase64: string
}

export type RemoteTaskStatus = 'pending' | 'in_progress' | 'blocked' | 'in_review' | 'completed'

export type RemoteTaskAction = 'pin' | 'rename' | 'archive' | 'markUnread' | 'copyPath'

/** Projected from the renderer's `TaskItem`. */
export interface RemoteTask {
  id: string
  sessionId?: string
  subject: string
  description: string
  activeForm?: string
  status: RemoteTaskStatus
  owner?: string | null
  blocks: string[]
  blockedBy: string[]
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export type RemoteTerminalStatus = 'running' | 'exited' | 'error'

export interface RemoteTerminal {
  id: string
  title: string
  cwd: string
  shell: string
  status: RemoteTerminalStatus
  exitCode?: number
  projectId?: string | null
}

export interface RemoteChangeFile {
  id: string
  filePath: string
  op: 'create' | 'modify'
  status: 'open' | 'reverted'
}

/** Projected from the renderer's `AgentRunChangeSet`; file text is fetched on demand. */
export interface RemoteChangeSet {
  runId: string
  sessionId?: string
  assistantMessageId: string
  status: 'open' | 'reverted'
  createdAt: number
  updatedAt: number
  changes: RemoteChangeFile[]
}

export interface RemoteDiffSide {
  exists: boolean
  text: string
  truncated: boolean
}

export interface RemoteDiff {
  changeId: string
  filePath: string
  op: 'create' | 'modify'
  before: RemoteDiffSide
  after: RemoteDiffSide
}

export interface RemoteCapabilities {
  /**
   * Whether phones may write to terminals. Surfaced in the desktop dialog so a
   * leaked QR code cannot silently grant shell access.
   */
  terminalWriteEnabled: boolean
  /**
   * Whether phones may commit. Same reasoning as terminal write and defaulted off
   * for the same reason: a QR code that leaked should not be able to write to the
   * repository. Reading git status is always allowed.
   */
  gitWriteEnabled: boolean
}

export interface RemoteGitFile {
  path: string
  stagedStatus: string
  unstagedStatus: string
}

/** Projected from the renderer's `GitStatusDetailed`. */
export interface RemoteGitStatus {
  repoPath: string
  branch: string
  upstream?: string
  ahead: number
  behind: number
  staged: RemoteGitFile[]
  unstaged: RemoteGitFile[]
  untracked: RemoteGitFile[]
  conflicted: RemoteGitFile[]
  /** False when the desktop has git writes switched off; the phone renders read-only. */
  canCommit: boolean
}

export interface RemoteGitStatusRequest {
  /** Defaults to the active project's working folder. */
  repoPath?: string
}

export interface RemoteGitCommitRequest {
  repoPath?: string
  message: string
  /** Stage every change first — the usual intent from a phone. */
  stageAll?: boolean
}

export interface RemoteSnapshot {
  deviceName: string
  activeProjectId: string | null
  activeSessionId: string | null
  workspaces: RemoteWorkspace[]
  sessions: RemoteSession[]
  tasks: RemoteTask[]
  terminals: RemoteTerminal[]
  /** Everything currently waiting on a human, newest first. */
  inbox: RemoteInboxItem[]
  /** Unread assistant activity per session, for the phone's home screen. */
  unreadBySession: Record<string, number>
  capabilities: RemoteCapabilities
  serverTimeMs: number
}

// ---------------------------------------------------------------------------
// Request/response payloads
// ---------------------------------------------------------------------------

export interface RemoteSessionListRequest {
  projectId?: string
  cursor?: RemoteCursor | null
  limit?: number
}

export interface RemoteSessionListResponse {
  sessions: RemoteSession[]
  nextCursor: RemoteCursor | null
  hasMore: boolean
}

export interface RemoteSessionMessagesRequest {
  sessionId: string
  offset?: number
  limit?: number
  /** Load the previous page of the desktop message window. */
  older?: boolean
}

export interface RemoteSessionMessagesResponse {
  messages: RemoteMessage[]
  total: number
  hasOlder: boolean
}

export interface RemoteSessionSendRequest {
  sessionId: string
  text: string
  images?: RemoteImage[]
}

export interface RemoteSessionCreateRequest {
  projectId?: string
  mode?: string
  workingFolder?: string
}

export interface RemoteSessionDeleteRequest {
  sessionId: string
}

/**
 * Wipes sessions on the desktop, optionally narrowed to one project.
 *
 * `confirm` is required and has exactly one accepted value. This is the only
 * remote op with nothing to undo it, so it should not be reachable by a mistyped
 * payload or a replayed envelope that lost its body.
 */
export interface RemoteSessionClearRequest {
  confirm: true
  /** Omitted clears every session on the desktop, not just one project's. */
  projectId?: string
}

export interface RemoteSessionClearResponse {
  deleted: number
}

export interface RemoteMessageDeleteRequest {
  sessionId: string
  messageId: string
}

/**
 * Re-runs the turn that produced `messageId`. The desktop truncates back to the
 * user message above it and resends that same prompt — the phone deliberately
 * does not carry the prompt, so a stale transcript cannot resend the wrong one.
 */
export interface RemoteMessageRetryRequest {
  sessionId: string
  messageId: string
}

/** One selectable model, projected from the renderer's `AIModelConfig`. */
export interface RemoteModel {
  id: string
  name: string
  icon?: string
  contextLength?: number
  supportsVision?: boolean
  supportsThinking?: boolean
  supportsFunctionCall?: boolean
}

/** Models grouped by their provider, the same grouping the desktop switcher shows. */
export interface RemoteModelProvider {
  id: string
  name: string
  icon?: string
  models: RemoteModel[]
}

export interface RemoteModelListRequest {
  /** Scopes the `selected` echo to one session; omitted means the global default. */
  sessionId?: string
}

export interface RemoteModelListResponse {
  providers: RemoteModelProvider[]
  selectedProviderId: string | null
  selectedModelId: string | null
}

export interface RemoteModelSelectRequest {
  /** Omitted means the global default rather than one session's binding. */
  sessionId?: string
  providerId: string
  modelId: string
}

/**
 * The desktop's model-settings popover, projected as controls rather than fields.
 *
 * Which knobs a model exposes, what they are worth right now, and how one change
 * ripples into another (raising the thinking budget also switches thinking on) are
 * all decided by renderer helpers. Sending the resolved controls means the phone
 * renders what the desktop would render without re-deriving any of it, and a knob
 * added on the desktop needs no phone release.
 */
export type RemoteModelControl =
  | {
      id: string
      kind: 'toggle'
      label: string
      description?: string
      value: boolean
    }
  | {
      id: string
      kind: 'choice'
      label: string
      description?: string
      value: string
      options: { value: string; label: string }[]
    }
  | {
      id: string
      kind: 'slider'
      label: string
      description?: string
      value: number
      min: number
      max: number
      step: number
      /** Pre-formatted for display, so the phone never re-implements the formatting. */
      valueLabel?: string
    }

export interface RemoteModelSettingSection {
  id: string
  title: string
  controls: RemoteModelControl[]
}

export interface RemoteModelSettingsRequest {
  /** Omitted means the global default rather than one session's binding. */
  sessionId?: string
}

export interface RemoteModelSettingsResponse {
  model: {
    providerId: string
    modelId: string
    name: string
    providerName: string
    /** `anthropic`, `responses`, … — the badge the desktop shows beside the name. */
    requestType?: string
  } | null
  /** Empty when the selected model exposes nothing adjustable. */
  sections: RemoteModelSettingSection[]
}

export interface RemoteModelSettingsSetRequest {
  sessionId?: string
  controlId: string
  value: boolean | string | number
}

export interface RemoteSessionModeRequest {
  sessionId: string
  mode: string
}
/**
 * Why a session is waiting on a human, mirroring the renderer's
 * `PendingInboxItemType`. The phone sorts its home screen by this.
 */
export type RemoteInboxItemType =
  | 'approval'
  | 'ask_user'
  | 'error'
  | 'preview_ready'
  | 'desktop_control'
  | 'foreground_bash'

export interface RemoteAskOption {
  label: string
  description?: string
}

export interface RemoteAskQuestion {
  question: string
  header?: string
  multiSelect?: boolean
  options: RemoteAskOption[]
}

/**
 * One thing blocking a session.
 *
 * The desktop only files an inbox item when the session is in the background,
 * because a foreground session shows the prompt inline. A phone has no
 * foreground, so the projection merges the desktop's filed items with whatever
 * is live in the agent store — otherwise the run the user is watching on their
 * desktop would be the one they cannot unblock from their phone.
 */
export interface RemoteInboxItem {
  id: string
  sessionId: string
  sessionTitle?: string
  projectId?: string
  type: RemoteInboxItemType
  title: string
  description?: string
  toolUseId?: string
  /** Tool input, so the phone can decide without opening the session. */
  detail?: string
  /** Present for `ask_user`: what to render as choices. */
  questions?: RemoteAskQuestion[]
  createdAt: number
}

export interface RemoteInboxListResponse {
  inbox: RemoteInboxItem[]
}

export interface RemoteAskUserRespondRequest {
  toolUseId: string
  /** Keyed by question index, matching the renderer's `AskUserAnswers`. */
  answers: Record<string, string | string[]>
}

export interface RemoteTaskActionRequest {
  taskId: string
  action: RemoteTaskAction
  /** Required when `action` is `rename`. */
  value?: string
}

export interface RemoteApprovalRespondRequest {
  requestId: string
  approved: boolean
  reason?: string
}

export interface RemoteTerminalCreateRequest {
  cwd?: string
  title?: string
  projectId?: string
}

export interface RemoteTerminalInputRequest {
  terminalId: string
  data: string
}

export interface RemoteTerminalSubscribeResponse {
  /** Replayed tail of the main-process ring buffer. */
  backlog: string
  seq: number
}

export interface RemoteReviewDiffRequest {
  runId: string
  changeId: string
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

export interface RemoteSessionDeltaEvent {
  sessionId: string
  messageId: string
  kind: 'text' | 'thinking'
  text: string
}

export interface RemoteSessionStatusEvent {
  sessionId: string
  status: 'running' | 'completed' | 'stopped' | 'error'
  error?: string
}

/** See {@link REMOTE_EVENT_OPS.SESSION_TRUNCATED}. */
export interface RemoteSessionTruncatedEvent {
  sessionId: string
}

export interface RemoteSessionListChangedEvent {
  /** The desktop's in-memory working set, not every session it stores. */
  sessions: RemoteSession[]
  /** Sessions confirmed gone from the desktop's database. */
  removedIds: string[]
}

export interface RemoteApprovalRequestEvent {
  requestId: string
  sessionId?: string
  toolName: string
  inputSummary: string
  createdAt: number
}

export interface RemoteTerminalOutputEvent {
  terminalId: string
  data: string
  seq: number
}

export interface RemoteTerminalExitEvent {
  terminalId: string
  exitCode: number
}

// ---------------------------------------------------------------------------
// Desktop-local state (main → renderer)
// ---------------------------------------------------------------------------

export type RemoteControlPhase = 'disabled' | 'connecting' | 'online' | 'reconnecting' | 'error'

/** SignalR / remote-control API host. Distinct from the RoutIn website used for OAuth. */
export const REMOTE_CONTROL_DEFAULT_API_BASE_URL = 'https://api.routin.ai'

/** Desktop exchanges an opaque OAuth token for a hub JWT here before SignalR negotiate. */
export const REMOTE_DESKTOP_SESSION_PATH = '/api/remote/desktop-session'

export interface RemoteDesktopSession {
  accessToken: string
  expiresInSeconds: number
}

export function normalizeRemoteControlApiBaseUrl(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return REMOTE_CONTROL_DEFAULT_API_BASE_URL
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
  return withScheme.replace(/\/+$/, '')
}

export interface RemoteMobileConnection {
  mobileId: string
  userAgent: string
  ipAddress: string
  attachedAtMs: number
}

export interface RemoteControlState {
  phase: RemoteControlPhase
  enabled: boolean
  pairingCode: string | null
  /** `{webBase}/remote?c={pairingCode}` — the value encoded in the QR code. */
  remoteUrl: string | null
  /** Host used for `/hubs/remote-control`. Editable in the desktop dialog. */
  apiBaseUrl: string
  deviceId: string | null
  deviceName: string | null
  mobiles: RemoteMobileConnection[]
  terminalWriteEnabled: boolean
  /** Off by default: committing from a phone is opt-in, unlike terminal write. */
  gitWriteEnabled: boolean
  error: string | null
  /**
   * Set when the server reissued the pairing code (Redis has no persistence, so a
   * restart invalidates every code). The dialog uses it to tell the user the QR
   * code changed and must be rescanned.
   */
  pairingRotatedAt: number | null
}

export const REMOTE_CONTROL_INITIAL_STATE: RemoteControlState = {
  phase: 'disabled',
  enabled: false,
  pairingCode: null,
  remoteUrl: null,
  apiBaseUrl: REMOTE_CONTROL_DEFAULT_API_BASE_URL,
  deviceId: null,
  deviceName: null,
  mobiles: [],
  terminalWriteEnabled: true,
  gitWriteEnabled: false,
  error: null,
  pairingRotatedAt: null
}

// ---------------------------------------------------------------------------
// Main ⇄ renderer bridge
// ---------------------------------------------------------------------------

/** Main asks the renderer to serve one phone request. */
export interface RemoteRendererRequest {
  id: string
  op: string
  payload: unknown
}

/** The renderer's answer, correlated by `id`. */
export interface RemoteRendererResponse {
  id: string
  ok: boolean
  data?: unknown
  error?: RemoteErrorPayload
}

/** The renderer pushing an event outward, unprompted. */
export interface RemoteRendererEvent {
  op: RemoteEventOp
  payload: unknown
}

// ---------------------------------------------------------------------------
// Payload codec
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function encodeRemotePayload(value: unknown): Uint8Array {
  if (value === undefined) return new Uint8Array(0)
  return textEncoder.encode(JSON.stringify(value))
}

export function decodeRemotePayload<T>(bytes: Uint8Array | undefined | null): T | undefined {
  if (!bytes || bytes.byteLength === 0) return undefined
  return JSON.parse(textDecoder.decode(bytes)) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unwrapRemotePayload(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  return isRecord(value.data) ? value.data : value
}

function firstRemoteValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key]
  }
  return null
}

/** Accepts both a raw payload and the API `{ data }` envelope. */
export function parseRemoteDesktopSessionResponse(value: unknown): RemoteDesktopSession | null {
  const payload = unwrapRemotePayload(value)
  if (!payload) return null

  const accessToken = firstRemoteValue(payload, ['accessToken', 'access_token', 'AccessToken'])
  if (typeof accessToken !== 'string' || accessToken.trim().length === 0) return null

  const rawExpires = firstRemoteValue(payload, [
    'expiresInSeconds',
    'expires_in',
    'expiresIn',
    'ExpiresInSeconds'
  ])
  const expiresInSeconds =
    typeof rawExpires === 'number'
      ? rawExpires
      : typeof rawExpires === 'string' && rawExpires.trim()
        ? Number(rawExpires)
        : NaN
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) return null

  return { accessToken, expiresInSeconds }
}

/** Truncates oversized text so one message cannot dominate a snapshot. */
export function truncateRemoteText(text: string, limit = REMOTE_TEXT_BLOCK_LIMIT): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…`
}

/**
 * Renderer replies travel as `{ id, ok, data | error }`. The phone expects the
 * business payload (or error) at the envelope root — never that wrapper.
 */
export function unwrapRemoteRouteResult(
  result: unknown,
  source: 'main' | 'renderer'
): { kind: 'res' | 'err'; payload: unknown } {
  if (source === 'renderer' && isRecord(result)) {
    const response = result as unknown as RemoteRendererResponse
    if (response.ok === false || response.error) {
      return {
        kind: 'err',
        payload: response.error ?? { code: 'internal', message: 'Remote request failed' }
      }
    }
    return { kind: 'res', payload: response.data }
  }
  if (isRecord(result) && result.error && typeof result.error === 'object') {
    return { kind: 'err', payload: result.error }
  }
  return { kind: 'res', payload: result }
}
