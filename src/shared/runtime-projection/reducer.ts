import type { AgentStreamEvent, LoopEndReasonWire } from '../agent-stream-protocol'
import {
  RUNTIME_MODEL_SCHEMA_VERSION,
  type AgentRuntimeProjection,
  type JsonObject,
  type JsonValue,
  type RunStatus,
  type RuntimeEvent,
  type RuntimeEventEnvelope,
  type RuntimeMessageOverlay,
  type RuntimeRunOverlay,
  type RuntimeSubAgentOverlay,
  type RuntimeToolCallOverlay,
  type SubAgentPhase,
  type SubAgentReportStatus
} from '../runtime-contracts/generated/contracts'

export type ProjectStreamContext = {
  runId: string
  sessionId: string
  seq: number
}

/**
 * Stream event types this projection does not model, counted by type.
 *
 * The projection covers a subset of the agent stream while the legacy render path
 * still owns the rest. That subset used to end in a silent `default`, so there was
 * no way to tell which events a real session dropped here — and no way to know
 * when the remaining gap is small enough for the legacy path to retire. Counting
 * them makes the gap observable instead of assumed.
 */
const unmappedStreamEvents = new Map<string, number>()

export function recordUnmappedStreamEvent(type: string): void {
  unmappedStreamEvents.set(type, (unmappedStreamEvents.get(type) ?? 0) + 1)
}

/** Snapshot of unmapped event types seen so far, highest count first. */
export function getUnmappedStreamEventCounts(): { type: string; count: number }[] {
  return [...unmappedStreamEvents.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((left, right) => right.count - left.count)
}

const RUN_SCOPED_ASSISTANT_MESSAGE_PREFIX = 'asst:'

/**
 * Cap on a sub-agent's live text preview, keeping the newest text.
 *
 * The preview exists so a card can show that work is happening, not to hold the
 * transcript. Without a cap a long-running sub-agent would grow this string
 * without bound and carry it in every snapshot.
 */
const MAX_SUB_AGENT_PREVIEW_CHARS = 2_000

export function assistantMessageIdForRun(runId: string): string {
  return `${RUN_SCOPED_ASSISTANT_MESSAGE_PREFIX}${runId}`
}

/**
 * Whether an id is the runtime's own handle for a run's assistant turn rather
 * than a stored transcript row.
 *
 * The Worker names the turn it is streaming this way, so the handle travels on
 * stream events and overlays, but no `messages` row ever carries it. Anything
 * that has to point at a real row must reject it instead of storing an id that
 * can never resolve.
 */
export function isRunScopedAssistantMessageId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(RUN_SCOPED_ASSISTANT_MESSAGE_PREFIX)
}

export function createEmptyProjection(
  gatewayEpoch: string,
  workerInstanceId: string
): AgentRuntimeProjection {
  return {
    gatewayEpoch,
    workerInstanceId,
    schemaVersion: RUNTIME_MODEL_SCHEMA_VERSION,
    projectionRevision: 0,
    runs: [],
    messages: [],
    toolCalls: [],
    approvals: [],
    pendingUiCapabilities: [],
    subAgents: []
  }
}

/**
 * Reads an overlay collection off a projection that may predate it.
 *
 * A projection crosses a process boundary and outlives the code that built it:
 * the host can be running an older or newer build than the window reading it, and
 * a dev reload leaves a live store holding an object shaped by the previous
 * module. A collection added since then is simply absent, and treating that as
 * empty is the difference between a missing overlay and a crashed renderer.
 */
function overlayList<T>(list: T[] | undefined): T[] {
  return list ?? []
}

export function filterProjectionBySession(
  projection: AgentRuntimeProjection,
  sessionId: string
): AgentRuntimeProjection {
  return {
    ...projection,
    runs: overlayList(projection.runs).filter((run) => run.sessionId === sessionId),
    messages: overlayList(projection.messages).filter((message) => message.sessionId === sessionId),
    toolCalls: overlayList(projection.toolCalls).filter(
      (toolCall) => toolCall.sessionId === sessionId
    ),
    approvals: overlayList(projection.approvals).filter(
      (approval) => approval.sessionId === sessionId
    ),
    pendingUiCapabilities: overlayList(projection.pendingUiCapabilities).filter(
      (capability) => capability.sessionId === sessionId
    ),
    subAgents: overlayList(projection.subAgents).filter(
      (subAgent) => subAgent.sessionId === sessionId
    )
  }
}

export function projectionHasSessionOverlay(
  projection: AgentRuntimeProjection,
  sessionId: string
): boolean {
  return (
    overlayList(projection.runs).some((run) => run.sessionId === sessionId) ||
    overlayList(projection.messages).some((message) => message.sessionId === sessionId) ||
    overlayList(projection.toolCalls).some((toolCall) => toolCall.sessionId === sessionId) ||
    overlayList(projection.approvals).some((approval) => approval.sessionId === sessionId) ||
    overlayList(projection.pendingUiCapabilities).some(
      (capability) => capability.sessionId === sessionId
    ) ||
    overlayList(projection.subAgents).some((subAgent) => subAgent.sessionId === sessionId)
  )
}

export function sessionOverlayRefsEqual(
  left: AgentRuntimeProjection,
  right: AgentRuntimeProjection
): boolean {
  return (
    sameRefItems(overlayList(left.runs), overlayList(right.runs)) &&
    sameRefItems(overlayList(left.messages), overlayList(right.messages)) &&
    sameRefItems(overlayList(left.toolCalls), overlayList(right.toolCalls)) &&
    sameRefItems(overlayList(left.approvals), overlayList(right.approvals)) &&
    sameRefItems(
      overlayList(left.pendingUiCapabilities),
      overlayList(right.pendingUiCapabilities)
    ) &&
    sameRefItems(overlayList(left.subAgents), overlayList(right.subAgents))
  )
}

function sameRefItems<T>(left: T[], right: T[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

export function projectStreamEvent(
  state: AgentRuntimeProjection,
  event: AgentStreamEvent,
  ctx: ProjectStreamContext
): RuntimeEvent[] {
  const messageId = resolveProjectedAssistantMessageId(state, event, ctx.runId)
  switch (event.type) {
    case 'loop_start':
      return [
        {
          type: 'runtime.run-changed',
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          status: 'running',
          assistantMessageId: messageId,
          iteration: null,
          lastStopReason: null,
          requestRetry: null,
          compression: null
        },
        {
          type: 'runtime.message-started',
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          messageId
        }
      ]
    case 'iteration_start':
      return [
        {
          type: 'runtime.run-changed',
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          status: 'running',
          assistantMessageId: messageId,
          iteration: event.iteration,
          lastStopReason: null,
          // A new turn starting means any retry from the previous one is over.
          requestRetry: null,
          compression: null
        }
      ]
    case 'iteration_end':
      // Only the stop reason is projected. `toolResults` creates persisted user
      // messages and can interrupt a queued turn, which is transcript and
      // orchestration work the overlay has no business doing.
      return [
        {
          type: 'runtime.run-changed',
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          status: 'running',
          assistantMessageId: messageId,
          iteration: null,
          lastStopReason: event.stopReason,
          requestRetry: null,
          compression: null
        }
      ]
    case 'request_retry':
      return [
        {
          type: 'runtime.run-changed',
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          status: 'running',
          assistantMessageId: messageId,
          iteration: null,
          lastStopReason: null,
          requestRetry: {
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
            statusCode: event.statusCode ?? null,
            reason: event.reason
          },
          compression: null
        }
      ]
    case 'context_compression_start':
      return [
        {
          type: 'runtime.run-changed',
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          status: 'running',
          assistantMessageId: messageId,
          iteration: null,
          lastStopReason: null,
          requestRetry: null,
          compression: {
            phase: 'summarizing',
            attempt: event.attempt ?? null,
            maxAttempts: event.maxAttempts ?? null,
            preTokens: event.preTokens ?? null,
            keptMessageCount: null,
            summarizerFailed: null,
            summaryMessageId: null
          }
        }
      ]
    case 'context_compressed':
      // The summary row itself is written by the host, which owns the compaction
      // cut; this only reports that summarizing finished.
      return [
        {
          type: 'runtime.run-changed',
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          status: 'running',
          assistantMessageId: messageId,
          iteration: null,
          lastStopReason: null,
          requestRetry: null,
          compression: {
            phase: 'completed',
            attempt: null,
            maxAttempts: null,
            preTokens: event.preTokens ?? null,
            keptMessageCount: event.keptMessageCount ?? null,
            summarizerFailed: event.summarizerFailed ?? false,
            summaryMessageId: event.compactSummaryMessage?.id ?? null
          }
        }
      ]
    case 'text_delta':
      return [
        {
          type: 'runtime.message-delta',
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          messageId,
          text: event.text,
          thinking: null
        }
      ]
    // `thinking_backfill` is reasoning a provider disclosed only after its answer had
    // streamed. The overlay carries thinking as one flat string, so it produces the same
    // patch as a delta here; placement is resolved where the overlay merges into a
    // structured timeline (apply-runtime-overlay), which puts thinking ahead of the
    // trailing text run.
    case 'thinking_delta':
    case 'thinking_backfill':
      return [
        {
          type: 'runtime.message-delta',
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          messageId,
          text: '',
          thinking: event.thinking
        }
      ]
    case 'tool_use_streaming_start':
      return [
        {
          type: 'runtime.tool-call-changed',
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: 'streaming',
          input: null,
          output: null
        }
      ]
    case 'tool_use_args_delta': {
      // The delta carries no tool name, so the call must already be on the
      // overlay from tool_use_streaming_start. Without this the overlay showed a
      // tool as streaming with no arguments until the whole input had arrived.
      const streaming = state.toolCalls.find((toolCall) => toolCall.toolCallId === event.toolCallId)
      if (!streaming) return []
      return [
        {
          type: 'runtime.tool-call-changed',
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          toolCallId: event.toolCallId,
          toolName: streaming.toolName,
          status: 'streaming',
          input: toJsonObject(event.partialInput),
          output: null
        }
      ]
    }
    case 'tool_use_generated':
      return [
        {
          type: 'runtime.tool-call-changed',
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          toolCallId: event.toolUseBlock.id,
          toolName: event.toolUseBlock.name,
          status: 'running',
          input: toJsonObject(event.toolUseBlock.input),
          output: null
        }
      ]
    case 'tool_call_start':
    case 'tool_call_update':
    case 'tool_call_result':
      return [toolCallChangedFromWire(ctx, event.toolCall)]
    case 'tool_call_approval_needed':
      return [
        toolCallChangedFromWire(ctx, event.toolCall),
        {
          type: 'runtime.approval-changed',
          requestId: event.toolCall.id,
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          toolName: event.toolCall.name,
          status: 'pending'
        }
      ]
    case 'loop_end':
      return [
        {
          type: 'runtime.run-completed',
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          status: statusFromLoopEnd(event.reason),
          errorCode: event.reason === 'error' ? 'unknown' : null
        }
      ]
    case 'error':
      return [
        {
          type: 'runtime.run-completed',
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          status: 'error',
          errorCode: 'unknown'
        }
      ]
    // Sub-agent lifecycle spine. The transcript-shaped events are excluded below.
    case 'sub_agent_queued':
      return [
        subAgentChanged(event.subAgentName, event.toolUseId, ctx, {
          phase: 'queued',
          reportStatus: 'queued',
          displayName: readSubAgentInput(event.input, 'subagent_type'),
          description: readSubAgentInput(event.input, 'description')
        })
      ]
    case 'sub_agent_dequeued':
      return [
        subAgentChanged(event.subAgentName, event.toolUseId, ctx, {
          phase: 'running',
          reportStatus: 'pending'
        })
      ]
    case 'sub_agent_start':
      return [
        subAgentChanged(event.subAgentName, event.toolUseId, ctx, {
          phase: 'running',
          reportStatus: 'pending',
          displayName: readSubAgentInput(event.input, 'subagent_type'),
          description: readSubAgentInput(event.input, 'description')
        })
      ]
    case 'sub_agent_iteration':
      return [
        subAgentChanged(event.subAgentName, event.toolUseId, ctx, {
          phase: 'running',
          iteration: event.iteration
        })
      ]
    case 'sub_agent_text_delta':
      return [
        {
          type: 'runtime.sub-agent-delta',
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          toolUseId: event.toolUseId,
          text: event.text
        }
      ]
    case 'sub_agent_message_end':
      return [
        subAgentChanged(event.subAgentName, event.toolUseId, ctx, {
          phase: 'running',
          usage: toJsonObject(event.usage)
        })
      ]
    case 'sub_agent_report_update':
      return [
        subAgentChanged(event.subAgentName, event.toolUseId, ctx, {
          // A report can arrive after the run finished, so this must not force the
          // phase back to running.
          phase: subAgentPhase(state, event.toolUseId),
          report: event.report,
          reportStatus: event.status
        })
      ]
    case 'sub_agent_end':
      return [
        subAgentChanged(event.subAgentName, event.toolUseId, ctx, {
          phase: 'completed',
          success: event.result.success,
          endReason: event.result.endReason ?? null,
          errorMessage: event.result.error ?? null,
          report: event.result.output,
          reportStatus: resolveSubAgentEndReportStatus(
            event.result,
            state.subAgents.find((item) => item.toolUseId === event.toolUseId)?.reportStatus
          ),
          usage: toJsonObject(event.result.usage),
          completedAt: Date.now()
        })
      ]
    case 'image_generated':
      return [
        messageBlockChanged(ctx, messageId, { type: 'image', source: event.imageBlock.source })
      ]
    case 'image_error':
      return [
        messageBlockChanged(ctx, messageId, {
          type: 'image_error',
          code: event.imageError.code,
          message: event.imageError.message
        })
      ]
    case 'web_search':
      // Search activity is revised in place: it arrives once as `searching` and
      // again as `completed`, and the second must replace the first rather than
      // appear as a second chip.
      return [
        messageBlockChanged(
          ctx,
          messageId,
          {
            type: 'web_search',
            query: event.content ?? '',
            ...(event.webSearchId ? { id: event.webSearchId } : {}),
            ...(event.status ? { status: event.status } : {}),
            ...(event.webSearchSources ? { sources: event.webSearchSources as JsonValue } : {})
          },
          event.webSearchId ?? null
        )
      ]
    case 'message_end':
      return [
        {
          type: 'runtime.message-metadata-changed',
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          messageId,
          usage: toJsonObject(event.usage)
        }
      ]
    // Deliberately not projected, rather than merely unmapped:
    //   image_generation_started / image_generation_partial — the spinner and the
    //     partial preview are live chrome for the window that is watching. A
    //     window that arrives later wants the finished image, which
    //     `image_generated` provides; replaying a stale preview would show
    //     progress for work that already finished.
    //   thinking_encrypted / thinking_reasoning_id — provider bookkeeping that
    //     lets a later request replay reasoning. Both patch a thinking block
    //     rather than rendering, and the overlay holds thinking as one flat
    //     string with nowhere to put them. Nothing visible is lost by leaving
    //     them to the transcript.
    //   request_debug — a large dev-only diagnostics payload attached to a
    //     message, with no overlay reader and no rendering role.
    //   context_compression_delta — the worker publishes summarizer draft tokens
    //     as live-only frames that never enter the durable outbox, and the host
    //     skips live frames before projection ingest, so mapping it here could
    //     never fire. It reaches the UI on the live stream instead.
    //   translation_buffer_update — belongs to the translation service, not a
    //     chat run.
    case 'image_generation_started':
    case 'image_generation_partial':
    case 'thinking_encrypted':
    case 'thinking_reasoning_id':
    case 'request_debug':
    case 'context_compression_delta':
    case 'translation_buffer_update':
      return []
    // A sub-agent's inner transcript is already durable: the whole state,
    // transcript included, is persisted to `sub_agent_history` keyed by the same
    // `toolUseId` these overlays use, and read back through
    // `db/sub-agent-history-list`. Projecting these would rebuild that store in an
    // ephemeral overlay and pay for it twice — once in every patch, once in every
    // snapshot — to serve a drawer the user opens on demand and which can query
    // the durable copy directly. The lifecycle spine above is what the always-on
    // surfaces (cards, sidebar, composer status) actually read.
    case 'sub_agent_thinking_delta':
    case 'sub_agent_thinking_encrypted':
    case 'sub_agent_tool_use_streaming_start':
    case 'sub_agent_tool_use_args_delta':
    case 'sub_agent_tool_use_generated':
    case 'sub_agent_image_generated':
    case 'sub_agent_image_error':
    case 'sub_agent_tool_result_message':
    case 'sub_agent_user_message':
    case 'sub_agent_tool_call':
      return []
    default:
      // Unreachable for the current protocol: every type above is either mapped
      // or explicitly excluded. It stays as a runtime guard because a worker can
      // be newer than the window reading it, and an event nobody decided about
      // should be counted rather than vanish.
      recordUnmappedStreamEvent((event as { type: string }).type)
      return []
  }
}

/**
 * Fills in overlay collections a projection was built without.
 *
 * Returns the same object when nothing is missing, so the common path allocates
 * nothing and reference equality used for render bailouts is preserved.
 */
function withOverlayDefaults(state: AgentRuntimeProjection): AgentRuntimeProjection {
  if (
    state.runs &&
    state.messages &&
    state.toolCalls &&
    state.approvals &&
    state.pendingUiCapabilities &&
    state.subAgents
  ) {
    return state
  }
  return {
    ...state,
    runs: overlayList(state.runs),
    messages: overlayList(state.messages),
    toolCalls: overlayList(state.toolCalls),
    approvals: overlayList(state.approvals),
    pendingUiCapabilities: overlayList(state.pendingUiCapabilities),
    subAgents: overlayList(state.subAgents)
  }
}

export function applyRuntimeEvent(
  incoming: AgentRuntimeProjection,
  event: RuntimeEvent
): AgentRuntimeProjection {
  // Normalized once here rather than guarded at every access below: a projection
  // built by a different build of this code is missing whatever collections were
  // added since, and every branch reads at least one of them.
  const state = withOverlayDefaults(incoming)
  const nextRevision = state.projectionRevision + 1
  switch (event.type) {
    case 'runtime.reset':
      return {
        ...createEmptyProjection(state.gatewayEpoch, event.workerInstanceId),
        projectionRevision: nextRevision
      }
    case 'runtime.run-changed': {
      const existingRun = findRun(state, event.runId)
      return {
        ...state,
        projectionRevision: nextRevision,
        runs: upsertBy(state.runs, (run) => run.runId, {
          runId: event.runId,
          sessionId: event.sessionId,
          status: event.status,
          assistantMessageId: event.assistantMessageId,
          lastSeq: existingRun?.lastSeq ?? 0,
          // A patch carries the fields it knows about. `undefined` means the
          // emitter had nothing to say, so the previous value stands; `null` is an
          // explicit clear, which is how a retry that has resolved disappears.
          iteration: event.iteration ?? existingRun?.iteration ?? null,
          lastStopReason: event.lastStopReason ?? existingRun?.lastStopReason ?? null,
          requestRetry:
            event.requestRetry === undefined
              ? (existingRun?.requestRetry ?? null)
              : event.requestRetry,
          compression:
            event.compression === undefined ? (existingRun?.compression ?? null) : event.compression
        })
      }
    }
    case 'runtime.message-started':
      return {
        ...state,
        projectionRevision: nextRevision,
        messages: upsertBy(state.messages, (message) => message.messageId, {
          messageId: event.messageId,
          runId: event.runId,
          sessionId: event.sessionId,
          role: 'assistant',
          text: findMessage(state, event.messageId)?.text ?? '',
          thinking: findMessage(state, event.messageId)?.thinking ?? null,
          blocks: findMessage(state, event.messageId)?.blocks ?? [],
          usage: findMessage(state, event.messageId)?.usage ?? null
        })
      }
    case 'runtime.message-delta': {
      const existing = findMessage(state, event.messageId)
      const nextMessage: RuntimeMessageOverlay = {
        messageId: event.messageId,
        runId: event.runId,
        sessionId: event.sessionId,
        role: existing?.role ?? 'assistant',
        text: `${existing?.text ?? ''}${event.text}`,
        thinking:
          event.thinking === null
            ? (existing?.thinking ?? null)
            : `${existing?.thinking ?? ''}${event.thinking}`,
        blocks: existing?.blocks ?? [],
        usage: existing?.usage ?? null
      }
      return {
        ...state,
        projectionRevision: nextRevision,
        messages: upsertBy(state.messages, (message) => message.messageId, nextMessage)
      }
    }
    case 'runtime.message-block-changed': {
      const existing = findMessage(state, event.messageId)
      const previous = existing?.blocks ?? []
      // A keyed block is revised in place; an unkeyed one is appended. This used
      // to bump the revision and throw the block away, which made the variant
      // look wired up while rendering nothing.
      const keyed =
        event.blockKey === null ? -1 : previous.findIndex((block) => block.id === event.blockKey)
      const blocks =
        keyed >= 0
          ? previous.map((block, index) => (index === keyed ? event.block : block))
          : [...previous, event.block]
      const nextMessage: RuntimeMessageOverlay = {
        messageId: event.messageId,
        runId: event.runId,
        sessionId: event.sessionId,
        role: existing?.role ?? 'assistant',
        text: existing?.text ?? '',
        thinking: existing?.thinking ?? null,
        blocks,
        usage: existing?.usage ?? null
      }
      return {
        ...state,
        projectionRevision: nextRevision,
        messages: upsertBy(state.messages, (message) => message.messageId, nextMessage)
      }
    }
    case 'runtime.message-metadata-changed': {
      const existing = findMessage(state, event.messageId)
      const nextMessage: RuntimeMessageOverlay = {
        messageId: event.messageId,
        runId: event.runId,
        sessionId: event.sessionId,
        role: existing?.role ?? 'assistant',
        text: existing?.text ?? '',
        thinking: existing?.thinking ?? null,
        blocks: existing?.blocks ?? [],
        usage: event.usage ?? existing?.usage ?? null
      }
      return {
        ...state,
        projectionRevision: nextRevision,
        messages: upsertBy(state.messages, (message) => message.messageId, nextMessage)
      }
    }
    case 'runtime.tool-call-changed': {
      const existing = state.toolCalls.find((toolCall) => toolCall.toolCallId === event.toolCallId)
      const nextTool: RuntimeToolCallOverlay = {
        toolCallId: event.toolCallId,
        runId: event.runId,
        sessionId: event.sessionId,
        toolName: event.toolName,
        status: event.status,
        input: event.input ?? existing?.input ?? null,
        output: event.output ?? existing?.output ?? null
      }
      return {
        ...state,
        projectionRevision: nextRevision,
        toolCalls: upsertBy(state.toolCalls, (toolCall) => toolCall.toolCallId, nextTool)
      }
    }
    case 'runtime.approval-changed': {
      if (event.status !== 'pending') {
        return {
          ...state,
          projectionRevision: nextRevision,
          approvals: state.approvals.filter((approval) => approval.requestId !== event.requestId)
        }
      }
      return {
        ...state,
        projectionRevision: nextRevision,
        approvals: upsertBy(state.approvals, (approval) => approval.requestId, {
          requestId: event.requestId,
          runId: event.runId,
          sessionId: event.sessionId,
          toolName: event.toolName,
          params: {}
        })
      }
    }
    case 'runtime.ui-capability-changed': {
      if (event.status !== 'pending') {
        return {
          ...state,
          projectionRevision: nextRevision,
          pendingUiCapabilities: state.pendingUiCapabilities.filter(
            (capability) => capability.requestId !== event.requestId
          )
        }
      }
      return {
        ...state,
        projectionRevision: nextRevision,
        pendingUiCapabilities: upsertBy(
          state.pendingUiCapabilities,
          (capability) => capability.requestId,
          {
            requestId: event.requestId,
            runId: event.runId,
            sessionId: event.sessionId,
            capability: event.capability,
            deadlineAt: null
          }
        )
      }
    }
    case 'runtime.run-completed': {
      const existing = findRun(state, event.runId)
      const nextRun: RuntimeRunOverlay = {
        runId: event.runId,
        sessionId: event.sessionId,
        status: event.status,
        assistantMessageId: existing?.assistantMessageId ?? assistantMessageIdForRun(event.runId),
        lastSeq: existing?.lastSeq ?? 0,
        // The iteration and stop reason a run finished on stay readable; in-flight
        // state cannot outlive the run that owned it.
        iteration: existing?.iteration ?? null,
        lastStopReason: existing?.lastStopReason ?? null,
        requestRetry: null,
        compression: existing?.compression ?? null
      }
      return {
        ...state,
        projectionRevision: nextRevision,
        runs: upsertBy(state.runs, (run) => run.runId, nextRun),
        approvals: state.approvals.filter((approval) => approval.runId !== event.runId)
      }
    }
    case 'runtime.session-transcript-committed':
      return dropRunOverlay(state, event.sessionId, event.runId, nextRevision)
    case 'runtime.sub-agent-changed': {
      const existing = state.subAgents.find((subAgent) => subAgent.toolUseId === event.toolUseId)
      const next: RuntimeSubAgentOverlay = {
        toolUseId: event.toolUseId,
        runId: event.runId,
        sessionId: event.sessionId,
        name: event.name,
        displayName: event.displayName ?? existing?.displayName ?? null,
        description: event.description ?? existing?.description ?? null,
        phase: event.phase,
        reportStatus: event.reportStatus ?? existing?.reportStatus ?? 'pending',
        report: event.report ?? existing?.report ?? '',
        iteration: event.iteration ?? existing?.iteration ?? 0,
        success: event.success ?? existing?.success ?? null,
        endReason: event.endReason ?? existing?.endReason ?? null,
        errorMessage: event.errorMessage ?? existing?.errorMessage ?? null,
        streamingText: existing?.streamingText ?? '',
        usage: event.usage ?? existing?.usage ?? null,
        startedAt: existing?.startedAt ?? 0,
        completedAt: event.completedAt ?? existing?.completedAt ?? null
      }
      return {
        ...state,
        projectionRevision: nextRevision,
        subAgents: upsertBy(state.subAgents, (subAgent) => subAgent.toolUseId, next)
      }
    }
    case 'runtime.sub-agent-delta': {
      const existing = state.subAgents.find((subAgent) => subAgent.toolUseId === event.toolUseId)
      // A delta for a sub-agent that never announced itself is dropped rather
      // than materialising a nameless row.
      if (!existing) return { ...state, projectionRevision: nextRevision }
      const appended = `${existing.streamingText}${event.text}`
      return {
        ...state,
        projectionRevision: nextRevision,
        subAgents: upsertBy(state.subAgents, (subAgent) => subAgent.toolUseId, {
          ...existing,
          streamingText:
            appended.length > MAX_SUB_AGENT_PREVIEW_CHARS
              ? appended.slice(appended.length - MAX_SUB_AGENT_PREVIEW_CHARS)
              : appended
        })
      }
    }
    default:
      return { ...state, projectionRevision: nextRevision }
  }
}

export function applyRuntimeEnvelope(
  state: AgentRuntimeProjection,
  envelope: RuntimeEventEnvelope
): AgentRuntimeProjection {
  let next = applyRuntimeEvent(state, envelope.event)
  if (envelope.runId) next = withRunSeq(next, envelope.runId, envelope.runSeq)
  return next
}

export function withRunSeq(
  state: AgentRuntimeProjection,
  runId: string,
  seq: number
): AgentRuntimeProjection {
  const existing = findRun(state, runId)
  if (!existing) return state
  return {
    ...state,
    runs: upsertBy(state.runs, (run) => run.runId, {
      ...existing,
      lastSeq: Math.max(existing.lastSeq, seq)
    })
  }
}

function dropRunOverlay(
  state: AgentRuntimeProjection,
  sessionId: string,
  runId: string | null,
  projectionRevision: number
): AgentRuntimeProjection {
  const matchesRun = (id: string | null): boolean => (runId === null ? true : id === runId)
  return {
    ...state,
    projectionRevision,
    runs: state.runs.filter((run) => run.sessionId !== sessionId || !matchesRun(run.runId)),
    messages: state.messages.filter(
      (message) => message.sessionId !== sessionId || !matchesRun(message.runId)
    ),
    toolCalls: state.toolCalls.filter(
      (toolCall) => toolCall.sessionId !== sessionId || !matchesRun(toolCall.runId)
    ),
    approvals: state.approvals.filter(
      (approval) => approval.sessionId !== sessionId || !matchesRun(approval.runId)
    ),
    pendingUiCapabilities: state.pendingUiCapabilities.filter(
      (capability) => capability.sessionId !== sessionId || !matchesRun(capability.runId)
    ),
    subAgents: state.subAgents.filter(
      (subAgent) => subAgent.sessionId !== sessionId || !matchesRun(subAgent.runId)
    )
  }
}

function toolCallChangedFromWire(
  ctx: ProjectStreamContext,
  toolCall: {
    id: string
    name: string
    status: string
    input: Record<string, unknown>
    output?: unknown
  }
): Extract<RuntimeEvent, { type: 'runtime.tool-call-changed' }> {
  return {
    type: 'runtime.tool-call-changed',
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    status: toolCall.status,
    input: toJsonObject(toolCall.input),
    output: toolOutputToString(toolCall.output)
  }
}

function messageBlockChanged(
  ctx: ProjectStreamContext,
  messageId: string,
  block: JsonObject,
  blockKey: string | null = null
): Extract<RuntimeEvent, { type: 'runtime.message-block-changed' }> {
  return {
    type: 'runtime.message-block-changed',
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    messageId,
    block,
    blockKey
  }
}

/** Builds a sub-agent patch, leaving unspecified fields for the reducer to keep. */
function subAgentChanged(
  name: string,
  toolUseId: string,
  ctx: ProjectStreamContext,
  patch: {
    phase: SubAgentPhase
    reportStatus?: SubAgentReportStatus
    report?: string
    displayName?: string | null
    description?: string | null
    iteration?: number
    success?: boolean | null
    endReason?: string | null
    errorMessage?: string | null
    usage?: JsonObject | null
    completedAt?: number | null
  }
): Extract<RuntimeEvent, { type: 'runtime.sub-agent-changed' }> {
  return {
    type: 'runtime.sub-agent-changed',
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    toolUseId,
    name,
    displayName: patch.displayName ?? null,
    description: patch.description ?? null,
    phase: patch.phase,
    reportStatus: patch.reportStatus ?? null,
    report: patch.report ?? null,
    iteration: patch.iteration ?? null,
    success: patch.success ?? null,
    endReason: patch.endReason ?? null,
    errorMessage: patch.errorMessage ?? null,
    usage: patch.usage ?? null,
    completedAt: patch.completedAt ?? null
  }
}

function resolveSubAgentEndReportStatus(
  result: {
    reportSubmitted?: boolean
    reportStatus?: SubAgentReportStatus | string
  },
  previous?: SubAgentReportStatus
): SubAgentReportStatus {
  if (
    result.reportStatus === 'fallback' ||
    result.reportStatus === 'submitted' ||
    result.reportStatus === 'missing' ||
    result.reportStatus === 'retrying'
  ) {
    return result.reportStatus
  }
  if (result.reportSubmitted === true) {
    return previous === 'fallback' ? 'fallback' : 'submitted'
  }
  return 'missing'
}

/** Current phase of a known sub-agent, defaulting to running for a new one. */
function subAgentPhase(state: AgentRuntimeProjection, toolUseId: string): SubAgentPhase {
  return state.subAgents.find((subAgent) => subAgent.toolUseId === toolUseId)?.phase ?? 'running'
}

/** Reads a string field out of the parent tool's input, when present. */
function readSubAgentInput(input: Record<string, unknown>, key: string): string | null {
  const value = input?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function toolOutputToString(output: unknown): string | null {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) return null
  const text = output
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
        return part.text
      }
      return ''
    })
    .join('')
  return text.length > 0 ? text : null
}

function statusFromLoopEnd(reason: LoopEndReasonWire): RunStatus {
  switch (reason) {
    case 'completed':
    case 'max_iterations':
      return 'completed'
    case 'aborted':
      return 'cancelled'
    case 'error':
      return 'error'
    default:
      return 'completed'
  }
}

function resolveProjectedAssistantMessageId(
  state: AgentRuntimeProjection,
  event: AgentStreamEvent,
  runId: string
): string {
  if (event.type === 'loop_start') {
    const published = event.assistantMessageId?.trim()
    if (published) return published
  }
  const existing = findRun(state, runId)?.assistantMessageId?.trim()
  if (existing) return existing
  return assistantMessageIdForRun(runId)
}

function findRun(state: AgentRuntimeProjection, runId: string): RuntimeRunOverlay | undefined {
  return state.runs.find((run) => run.runId === runId)
}

function findMessage(
  state: AgentRuntimeProjection,
  messageId: string
): RuntimeMessageOverlay | undefined {
  return state.messages.find((message) => message.messageId === messageId)
}

function upsertBy<T>(items: T[], key: (item: T) => string, next: T): T[] {
  const id = key(next)
  const index = items.findIndex((item) => key(item) === id)
  if (index === -1) return [...items, next]
  const copy = items.slice()
  copy[index] = next
  return copy
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) {
    const items: JsonValue[] = []
    for (const item of value) {
      const mapped = toJsonValue(item)
      if (mapped === undefined) continue
      items.push(mapped)
    }
    return items
  }
  if (value && typeof value === 'object') {
    const record: { [key: string]: JsonValue } = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const mapped = toJsonValue(item)
      if (mapped === undefined) continue
      record[key] = mapped
    }
    return record
  }
  return undefined
}

function toJsonObject(value: unknown): JsonObject | null {
  const mapped = toJsonValue(value)
  if (!mapped || typeof mapped !== 'object' || Array.isArray(mapped)) return null
  return mapped
}
