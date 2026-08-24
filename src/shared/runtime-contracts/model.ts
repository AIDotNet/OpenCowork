/**
 * Generated Renderer ↔ Main runtime protocol (control plane).
 *
 * `npm run contracts:gen` compiles this model into:
 *   - src/shared/runtime-contracts/generated/contracts.ts
 *   - src/shared/runtime-contracts/generated/ipc.ts
 *   - sidecars/OpenCowork.Native.Worker/Generated/AgentRuntimeContracts.g.cs
 *
 * Authoring rules (see scripts/lib/contract-model.mjs):
 *   - `export const constants = { NAME: <int literal> } as const`
 *   - `export type Enum = 'a' | 'b'` for string literal enums
 *   - `export type Union = A | B` for discriminated DTO unions (each member has `type: '...'`)
 *   - DTO fields: boolean | number | string | T[] | `T | null` | enum | DTO | JsonValue |
 *     JsonObject | Record<string, JsonValue>. Use `T | null` instead of optional fields.
 *   - Annotate C# integer width with `@cs int` / `@cs long` (numbers default to double).
 *   - Map interfaces use string-literal keys and `{ params; result }`, `{ payload }`,
 *     or `{ request; response }` object values.
 *
 * This slice is the control plane only. Do not fold the full AgentStreamEvent union in
 * here until a later migration phase.
 */

export const constants = {
  /** Independent of worker framing and agent/stream envelope versions. */
  RUNTIME_MODEL_SCHEMA_VERSION: 1
} as const

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue }
export type JsonObject = { readonly [key: string]: JsonValue }

export type RuntimeRolloutMode = 'legacy' | 'shadow' | 'v2'
export type CompressionPhase = 'idle' | 'summarizing' | 'completed'
export type SubAgentPhase = 'queued' | 'running' | 'completed'
export type SubAgentReportStatus =
  | 'pending'
  | 'queued'
  | 'submitted'
  | 'retrying'
  | 'fallback'
  | 'missing'
export type RunStatus = 'queued' | 'running' | 'completed' | 'error' | 'cancelled' | 'interrupted'
export type ApprovalDecision = 'approved' | 'denied'
export type AttachMode = 'snapshot' | 'patches' | 'expired'
export type UiCapabilityKind =
  | 'AskUser'
  | 'PlanUiUpdate'
  | 'TeamUiUpdate'
  | 'SubAgentUiUpdate'
  | 'BrowserVisualAction'
  | 'CanvasAction'
export type RuntimeErrorCode =
  | 'runtime_expired'
  | 'session_evicted'
  | 'worker_interrupted'
  | 'protocol_mismatch'
  | 'unknown'

/** Worker `agent/initialize` feature flags. Distinct from Renderer↔Main initialize. */
export interface WorkerFeatureSet {
  capabilitySnapshot: boolean
  strictToolValidation: boolean
  durableEvents: boolean
  durableInbox: boolean
  checkpointRecovery: boolean
  toolReconciliation: boolean
  laneScheduler: boolean
}

export interface WorkerCompatibility {
  acceptsV1RunRequest: boolean
  canRecoverV2Run: boolean
  minimumRendererVersion: string
  minimumMainVersion: string
}

export interface WorkerInitializeResult {
  ok: boolean
  runtime: string
  version: string
  /** @cs int */
  protocolVersion: number
  /** @cs int */
  supportedManifestSchemaVersions: number[]
  coreManifestHash: string
  workerInstanceId: string
  features: WorkerFeatureSet
  compatibility: WorkerCompatibility
}

export interface ReverseRequestEnvelope {
  id: string
  method: string
  params: JsonValue
}

export interface ReverseCancelEnvelope {
  id: string
  method: string
}

export interface ReverseResponseResult {
  ok: boolean
}

export interface RuntimeEventEnvelope {
  /** @cs int */
  schemaVersion: number
  gatewayEpoch: string
  workerInstanceId: string
  eventId: string
  correlationId: string
  causationId: string
  runId: string | null
  sessionId: string | null
  /** @cs int */
  runSeq: number
  /** @cs int */
  projectionRevision: number
  /** @cs long */
  occurredAt: number
  event: RuntimeEvent
}

export interface OpenAgentSessionParams {
  sessionId: string
  mode: string
  providerId: string
  modelId: string
  workingFolder: string | null
  metadata: JsonObject | null
}

export interface OpenAgentSessionResult {
  ok: boolean
  sessionId: string
  /** @cs int */
  messageCount: number
}

export interface StartRunParams {
  sessionId: string
  triggerMessageId: string
  mode: string
  providerId: string
  modelId: string
  attachmentIds: string[]
  commandMetadata: JsonObject | null
}

export interface StartRunResult {
  accepted: boolean
  runId: string
  sessionId: string
  assistantMessageId: string
  errorCode: RuntimeErrorCode | null
  /**
   * Raw failure description (worker errorCode + message, transport error, …).
   * `errorCode` is a coarse classification; this keeps the actual cause so the
   * UI can show it instead of an opaque "unknown".
   */
  errorDetail: string | null
}

export interface SendSessionTurnParams {
  sessionId: string
  triggerMessageId: string
  attachmentIds: string[]
  commandMetadata: JsonObject | null
}

export interface SendSessionTurnResult {
  accepted: boolean
  runId: string
  sessionId: string
  assistantMessageId: string
  errorCode: RuntimeErrorCode | null
  errorDetail: string | null
}

export interface CancelRunParams {
  runId: string
  sessionId: string
}

export interface CancelRunResult {
  cancelled: boolean
  runId: string | null
}

export interface RequestStopRunParams {
  runId: string
  sessionId: string
}

export interface RequestStopRunResult {
  stopped: boolean
  runId: string | null
}

export interface AppendRunMessagesParams {
  runId: string
  sessionId: string
  messages: JsonValue[]
}

export interface AppendRunMessagesResult {
  appended: boolean
  runId: string | null
  /** @cs int */
  count: number
}

export interface ResolveApprovalParams {
  requestId: string
  runId: string
  sessionId: string
  decision: ApprovalDecision
}

export interface ResolveApprovalResult {
  ok: boolean
  requestId: string
}

export interface CompleteUiCapabilityParams {
  requestId: string
  runId: string
  sessionId: string
  capability: UiCapabilityKind
  response: JsonObject
}

export interface CompleteUiCapabilityResult {
  ok: boolean
  requestId: string
}

export interface CloseAgentSessionParams {
  sessionId: string
}

export interface CloseAgentSessionResult {
  ok: boolean
  sessionId: string
  closed: boolean
}

export interface InitializeRuntimeParams {
  subscriberId: string
}

export interface InitializeRuntimeResult {
  ok: boolean
  gatewayEpoch: string
  workerInstanceId: string
  /** @cs int */
  schemaVersion: number
  rolloutMode: RuntimeRolloutMode
}

export interface AttachRuntimeParams {
  subscriberId: string
  knownGatewayEpoch: string | null
  /** @cs int */
  knownProjectionRevision: number | null
  sessionId: string | null
}

export interface AttachRuntimeResult {
  mode: AttachMode
  gatewayEpoch: string
  workerInstanceId: string
  /** @cs int */
  projectionRevision: number
  snapshot: AgentRuntimeProjection | null
  patches: RuntimeEventEnvelope[]
  errorCode: RuntimeErrorCode | null
}

export interface GetRuntimeSnapshotParams {
  subscriberId: string
}

export interface GetRuntimeSnapshotResult {
  snapshot: AgentRuntimeProjection
}

export interface GetSessionRuntimeSnapshotParams {
  subscriberId: string
  sessionId: string
}

export interface GetSessionRuntimeSnapshotResult {
  snapshot: AgentRuntimeProjection
}

export interface GetToolCatalogParams {
  sessionId: string
  mode: string
}

export interface GetToolCatalogResult {
  tools: RuntimeToolCatalogEntry[]
}

export interface RuntimeToolCatalogEntry {
  toolId: string
  wireName: string
  executionLocation: string
  capabilityKind: string
}

export interface GetDiagnosticsParams {
  subscriberId: string
}

export interface GetDiagnosticsResult {
  ok: boolean
  details: JsonObject
}

export interface AgentRuntimeProjection {
  gatewayEpoch: string
  workerInstanceId: string
  /** @cs int */
  schemaVersion: number
  /** @cs int */
  projectionRevision: number
  runs: RuntimeRunOverlay[]
  messages: RuntimeMessageOverlay[]
  toolCalls: RuntimeToolCallOverlay[]
  approvals: RuntimeApprovalOverlay[]
  pendingUiCapabilities: RuntimeUiCapabilityOverlay[]
  subAgents: RuntimeSubAgentOverlay[]
}

/**
 * A provider request being retried for the current iteration.
 *
 * Carried on the run because the UI shows it against the run, not a message: a
 * retry banner, the composer status, and the session list indicator all read the
 * same state.
 */
export interface RuntimeRequestRetryOverlay {
  /** @cs int */
  attempt: number
  /** @cs int */
  maxAttempts: number
  /** @cs int */
  delayMs: number
  /** @cs int */
  statusCode: number | null
  reason: string
}

/**
 * Context summarization progress for a run.
 *
 * The draft text the summarizer streams is deliberately absent: the worker emits
 * those tokens as live-only frames that never enter the durable outbox, so they
 * cannot reach this projection at all. Only the phase transitions can.
 */
export interface RuntimeCompressionOverlay {
  phase: CompressionPhase
  /** @cs int */
  attempt: number | null
  /** @cs int */
  maxAttempts: number | null
  /** @cs int */
  preTokens: number | null
  /** @cs int */
  keptMessageCount: number | null
  summarizerFailed: boolean | null
  summaryMessageId: string | null
}

export interface RuntimeRunOverlay {
  runId: string
  sessionId: string
  status: RunStatus
  assistantMessageId: string | null
  /** @cs int */
  lastSeq: number
  /** Current provider turn, or null before the first iteration is announced. */
  /** @cs int */
  iteration: number | null
  /** Stop reason from the last completed iteration. */
  lastStopReason: string | null
  requestRetry: RuntimeRequestRetryOverlay | null
  compression: RuntimeCompressionOverlay | null
}

/**
 * A sub-agent spawned by a run, keyed by the parent tool-use id.
 *
 * This is the lifecycle spine only — phase, progress, outcome and a short live
 * text preview. It deliberately does not carry the sub-agent's inner transcript.
 * Patches land in a journal capped at 2000 entries and 8 MiB, and a transcript
 * snapshot on every inner tool or image event would exhaust that budget within
 * one busy sub-agent, forcing every late attach onto the expensive full-snapshot
 * path. Inner transcript detail stays with the legacy render path.
 */
export interface RuntimeSubAgentOverlay {
  toolUseId: string
  runId: string
  sessionId: string
  name: string
  displayName: string | null
  description: string | null
  phase: SubAgentPhase
  reportStatus: SubAgentReportStatus
  report: string
  /** @cs int */
  iteration: number
  success: boolean | null
  endReason: string | null
  errorMessage: string | null
  /** Bounded live preview of the sub-agent's assistant text. */
  streamingText: string
  usage: JsonObject | null
  /** @cs long */
  startedAt: number
  /** @cs long */
  completedAt: number | null
}

export interface RuntimeMessageOverlay {
  messageId: string
  runId: string
  sessionId: string
  role: string
  text: string
  thinking: string | null
  /**
   * Ordered content the flat text and thinking strings cannot hold: generated
   * images, image failures, and web-search activity. Serialized content blocks,
   * in arrival order.
   *
   * A window that opens part-way through a turn starts its own subscription live,
   * so this overlay is the only place the turn's earlier media can come from —
   * the transcript in the database covers only what a window was around to write.
   */
  blocks: JsonObject[]
  /** Token usage reported at the end of a provider call. */
  usage: JsonObject | null
}

export interface RuntimeToolCallOverlay {
  toolCallId: string
  runId: string
  sessionId: string
  toolName: string
  status: string
  input: JsonObject | null
  output: string | null
}

export interface RuntimeApprovalOverlay {
  requestId: string
  runId: string | null
  sessionId: string | null
  toolName: string
  params: JsonObject
}

export interface RuntimeUiCapabilityOverlay {
  requestId: string
  runId: string
  sessionId: string
  capability: UiCapabilityKind
  /** @cs long */
  deadlineAt: number | null
}

export interface RuntimeReset {
  type: 'runtime.reset'
  reason: string
  workerInstanceId: string
}

/**
 * A patch to a run's overlay.
 *
 * Lifecycle fields are carried here rather than as their own event variants
 * because they arrive interleaved with status changes and always describe the
 * same row. Null clears a field; the reducer leaves anything absent untouched.
 */
export interface RunChanged {
  type: 'runtime.run-changed'
  runId: string
  sessionId: string
  status: RunStatus
  assistantMessageId: string | null
  /** @cs int */
  iteration: number | null
  lastStopReason: string | null
  requestRetry: RuntimeRequestRetryOverlay | null
  compression: RuntimeCompressionOverlay | null
}

export interface MessageStarted {
  type: 'runtime.message-started'
  runId: string
  sessionId: string
  messageId: string
}

export interface MessageDelta {
  type: 'runtime.message-delta'
  runId: string
  sessionId: string
  messageId: string
  text: string
  thinking: string | null
}

/**
 * Adds or replaces one content block on a message overlay.
 *
 * `blockKey` identifies a block that can be revised in place — web-search
 * activity arrives twice, first as `searching` and then `completed`, and the
 * second must not appear as a duplicate chip.
 */
export interface MessageBlockChanged {
  type: 'runtime.message-block-changed'
  runId: string
  sessionId: string
  messageId: string
  block: JsonObject
  blockKey: string | null
}

/** Usage and provider metadata reported when a provider call finishes. */
export interface MessageMetadataChanged {
  type: 'runtime.message-metadata-changed'
  runId: string
  sessionId: string
  messageId: string
  usage: JsonObject | null
}

/**
 * A patch to one sub-agent's overlay. Null clears a field; the reducer leaves
 * anything the emitter had no opinion about untouched.
 */
export interface SubAgentChanged {
  type: 'runtime.sub-agent-changed'
  runId: string
  sessionId: string
  toolUseId: string
  name: string
  displayName: string | null
  description: string | null
  phase: SubAgentPhase
  reportStatus: SubAgentReportStatus | null
  report: string | null
  /** @cs int */
  iteration: number | null
  success: boolean | null
  endReason: string | null
  errorMessage: string | null
  usage: JsonObject | null
  /** @cs long */
  completedAt: number | null
}

/** Streamed assistant text from a sub-agent, appended to its live preview. */
export interface SubAgentTextDelta {
  type: 'runtime.sub-agent-delta'
  runId: string
  sessionId: string
  toolUseId: string
  text: string
}

export interface ToolCallChanged {
  type: 'runtime.tool-call-changed'
  runId: string
  sessionId: string
  toolCallId: string
  toolName: string
  status: string
  input: JsonObject | null
  output: string | null
}

export interface ApprovalChanged {
  type: 'runtime.approval-changed'
  requestId: string
  runId: string
  sessionId: string
  toolName: string
  status: string
}

export interface UiCapabilityChanged {
  type: 'runtime.ui-capability-changed'
  requestId: string
  runId: string
  sessionId: string
  capability: UiCapabilityKind
  status: string
}

export interface RunCompleted {
  type: 'runtime.run-completed'
  runId: string
  sessionId: string
  status: RunStatus
  errorCode: RuntimeErrorCode | null
}

export interface SessionTranscriptCommitted {
  type: 'runtime.session-transcript-committed'
  sessionId: string
  runId: string | null
  /** @cs int */
  revision: number
}

export type RuntimeEvent =
  | RuntimeReset
  | RunChanged
  | MessageStarted
  | MessageDelta
  | MessageBlockChanged
  | ToolCallChanged
  | ApprovalChanged
  | UiCapabilityChanged
  | RunCompleted
  | SessionTranscriptCommitted
  | SubAgentChanged
  | SubAgentTextDelta
  | MessageMetadataChanged

export interface UiCapabilityIdentity {
  requestId: string
  runId: string
  sessionId: string
  workerInstanceId: string
  subscriberId: string | null
  /** @cs long */
  deadlineAt: number | null
}

export interface AskUserQuestion {
  id: string
  prompt: string
  options: string[]
  allowMultiple: boolean
}

export interface AskUserRequest {
  identity: UiCapabilityIdentity
  questions: AskUserQuestion[]
}

export interface AskUserResponse {
  requestId: string
  answers: JsonObject
}

export interface PlanUiUpdateRequest {
  identity: UiCapabilityIdentity
  action: string
  payload: JsonObject
}

export interface PlanUiUpdateResponse {
  requestId: string
  ok: boolean
  error: string | null
}

export interface TeamUiUpdateRequest {
  identity: UiCapabilityIdentity
  action: string
  payload: JsonObject
}

export interface TeamUiUpdateResponse {
  requestId: string
  ok: boolean
  error: string | null
}

export interface SubAgentUiUpdateRequest {
  identity: UiCapabilityIdentity
  action: string
  payload: JsonObject
}

export interface SubAgentUiUpdateResponse {
  requestId: string
  ok: boolean
  error: string | null
}

export interface BrowserVisualActionRequest {
  identity: UiCapabilityIdentity
  action: string
  input: JsonObject
}

export interface BrowserVisualActionResponse {
  requestId: string
  ok: boolean
  result: JsonValue | null
  error: string | null
}

export interface CanvasActionRequest {
  identity: UiCapabilityIdentity
  action: string
  input: JsonObject
}

export interface CanvasActionResponse {
  requestId: string
  ok: boolean
  result: JsonValue | null
  error: string | null
}

export interface RuntimeCommands {
  'runtime:open-session': { params: OpenAgentSessionParams; result: OpenAgentSessionResult }
  'runtime:start-run': { params: StartRunParams; result: StartRunResult }
  'runtime:send-turn': { params: SendSessionTurnParams; result: SendSessionTurnResult }
  'runtime:cancel-run': { params: CancelRunParams; result: CancelRunResult }
  'runtime:request-stop': { params: RequestStopRunParams; result: RequestStopRunResult }
  'runtime:append-messages': { params: AppendRunMessagesParams; result: AppendRunMessagesResult }
  'runtime:resolve-approval': { params: ResolveApprovalParams; result: ResolveApprovalResult }
  'runtime:complete-ui-capability': {
    params: CompleteUiCapabilityParams
    result: CompleteUiCapabilityResult
  }
  'runtime:close-session': { params: CloseAgentSessionParams; result: CloseAgentSessionResult }
}

export interface RuntimeQueries {
  'runtime:initialize': { params: InitializeRuntimeParams; result: InitializeRuntimeResult }
  'runtime:attach': { params: AttachRuntimeParams; result: AttachRuntimeResult }
  'runtime:snapshot': { params: GetRuntimeSnapshotParams; result: GetRuntimeSnapshotResult }
  'runtime:session-snapshot': {
    params: GetSessionRuntimeSnapshotParams
    result: GetSessionRuntimeSnapshotResult
  }
  'runtime:tool-catalog': { params: GetToolCatalogParams; result: GetToolCatalogResult }
  'runtime:diagnostics': { params: GetDiagnosticsParams; result: GetDiagnosticsResult }
}

export interface RuntimeEvents {
  'runtime.reset': { payload: RuntimeReset }
  'runtime.run-changed': { payload: RunChanged }
  'runtime.message-started': { payload: MessageStarted }
  'runtime.message-delta': { payload: MessageDelta }
  'runtime.message-block-changed': { payload: MessageBlockChanged }
  'runtime.tool-call-changed': { payload: ToolCallChanged }
  'runtime.approval-changed': { payload: ApprovalChanged }
  'runtime.ui-capability-changed': { payload: UiCapabilityChanged }
  'runtime.run-completed': { payload: RunCompleted }
  'runtime.session-transcript-committed': { payload: SessionTranscriptCommitted }
  'runtime.sub-agent-changed': { payload: SubAgentChanged }
  'runtime.sub-agent-delta': { payload: SubAgentTextDelta }
  'runtime.message-metadata-changed': { payload: MessageMetadataChanged }
}

export interface UiCapabilities {
  AskUser: { request: AskUserRequest; response: AskUserResponse }
  PlanUiUpdate: { request: PlanUiUpdateRequest; response: PlanUiUpdateResponse }
  TeamUiUpdate: { request: TeamUiUpdateRequest; response: TeamUiUpdateResponse }
  SubAgentUiUpdate: { request: SubAgentUiUpdateRequest; response: SubAgentUiUpdateResponse }
  BrowserVisualAction: {
    request: BrowserVisualActionRequest
    response: BrowserVisualActionResponse
  }
  CanvasAction: { request: CanvasActionRequest; response: CanvasActionResponse }
}
