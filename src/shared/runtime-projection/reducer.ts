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
  type RuntimeToolCallOverlay
} from '../runtime-contracts/generated/contracts'

export type ProjectStreamContext = {
  runId: string
  sessionId: string
  seq: number
}

export function assistantMessageIdForRun(runId: string): string {
  return `asst:${runId}`
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
    pendingUiCapabilities: []
  }
}

export function filterProjectionBySession(
  projection: AgentRuntimeProjection,
  sessionId: string
): AgentRuntimeProjection {
  return {
    ...projection,
    runs: projection.runs.filter((run) => run.sessionId === sessionId),
    messages: projection.messages.filter((message) => message.sessionId === sessionId),
    toolCalls: projection.toolCalls.filter((toolCall) => toolCall.sessionId === sessionId),
    approvals: projection.approvals.filter((approval) => approval.sessionId === sessionId),
    pendingUiCapabilities: projection.pendingUiCapabilities.filter(
      (capability) => capability.sessionId === sessionId
    )
  }
}

export function projectionHasSessionOverlay(
  projection: AgentRuntimeProjection,
  sessionId: string
): boolean {
  return (
    projection.runs.some((run) => run.sessionId === sessionId) ||
    projection.messages.some((message) => message.sessionId === sessionId) ||
    projection.toolCalls.some((toolCall) => toolCall.sessionId === sessionId) ||
    projection.approvals.some((approval) => approval.sessionId === sessionId) ||
    projection.pendingUiCapabilities.some((capability) => capability.sessionId === sessionId)
  )
}

export function sessionOverlayRefsEqual(
  left: AgentRuntimeProjection,
  right: AgentRuntimeProjection
): boolean {
  return (
    sameRefItems(left.runs, right.runs) &&
    sameRefItems(left.messages, right.messages) &&
    sameRefItems(left.toolCalls, right.toolCalls) &&
    sameRefItems(left.approvals, right.approvals) &&
    sameRefItems(left.pendingUiCapabilities, right.pendingUiCapabilities)
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
          assistantMessageId: messageId
        },
        {
          type: 'runtime.message-started',
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          messageId
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
    case 'thinking_delta':
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
    default:
      return []
  }
}

export function applyRuntimeEvent(
  state: AgentRuntimeProjection,
  event: RuntimeEvent
): AgentRuntimeProjection {
  const nextRevision = state.projectionRevision + 1
  switch (event.type) {
    case 'runtime.reset':
      return {
        ...createEmptyProjection(state.gatewayEpoch, event.workerInstanceId),
        projectionRevision: nextRevision
      }
    case 'runtime.run-changed':
      return {
        ...state,
        projectionRevision: nextRevision,
        runs: upsertBy(state.runs, (run) => run.runId, {
          runId: event.runId,
          sessionId: event.sessionId,
          status: event.status,
          assistantMessageId: event.assistantMessageId,
          lastSeq: findRun(state, event.runId)?.lastSeq ?? 0
        })
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
          thinking: findMessage(state, event.messageId)?.thinking ?? null
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
            : `${existing?.thinking ?? ''}${event.thinking}`
      }
      return {
        ...state,
        projectionRevision: nextRevision,
        messages: upsertBy(state.messages, (message) => message.messageId, nextMessage)
      }
    }
    case 'runtime.message-block-changed':
      return { ...state, projectionRevision: nextRevision }
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
        lastSeq: existing?.lastSeq ?? 0
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
