import type { AgentStreamEvent } from '../agent-stream-protocol'
import {
  RUNTIME_MODEL_SCHEMA_VERSION,
  type AgentRuntimeProjection,
  type AttachRuntimeParams,
  type AttachRuntimeResult,
  type RuntimeEvent,
  type RuntimeEventEnvelope
} from '../runtime-contracts/generated/contracts'
import { RuntimePatchJournal } from './journal'
import {
  applyRuntimeEvent,
  createEmptyProjection,
  filterProjectionBySession,
  projectStreamEvent,
  projectionHasSessionOverlay,
  withRunSeq
} from './reducer'

export type RuntimeProjectionIds = {
  now(): number
  nextId(): string
}

const defaultIds = (): RuntimeProjectionIds => {
  let next = 0
  return {
    now: () => Date.now(),
    nextId: () => {
      next += 1
      return `rev-${next}`
    }
  }
}

export type RuntimeProjectionOptions = {
  ids?: RuntimeProjectionIds
  journal?: RuntimePatchJournal
}

export class RuntimeProjectionEngine {
  private state: AgentRuntimeProjection
  private readonly journal: RuntimePatchJournal
  private readonly expiredSessions = new Set<string>()
  private readonly ids: RuntimeProjectionIds

  constructor(
    gatewayEpoch: string,
    workerInstanceId: string,
    options: RuntimeProjectionOptions = {}
  ) {
    this.ids = options.ids ?? defaultIds()
    this.journal = options.journal ?? new RuntimePatchJournal()
    this.state = createEmptyProjection(gatewayEpoch, workerInstanceId)
  }

  get snapshot(): AgentRuntimeProjection {
    return this.state
  }

  get gatewayEpoch(): string {
    return this.state.gatewayEpoch
  }

  get workerInstanceId(): string {
    return this.state.workerInstanceId
  }

  get journalOverflowed(): boolean {
    return this.journal.didOverflow
  }

  sessionSnapshot(sessionId: string): AgentRuntimeProjection {
    return filterProjectionBySession(this.state, sessionId)
  }

  reset(gatewayEpoch: string, workerInstanceId: string, reason: string): RuntimeEventEnvelope[] {
    this.journal.clear()
    this.expiredSessions.clear()
    this.state = createEmptyProjection(gatewayEpoch, workerInstanceId)
    return this.commitEvent(
      {
        type: 'runtime.reset',
        reason,
        workerInstanceId
      },
      { runId: null, sessionId: null, runSeq: 0 }
    )
  }

  applyStreamEnvelope(input: {
    runId: string
    sessionId: string
    seq: number
    events: AgentStreamEvent[]
  }): RuntimeEventEnvelope[] {
    const existing = this.state.runs.find((run) => run.runId === input.runId)
    if (existing && input.seq > 0 && input.seq <= existing.lastSeq) {
      return []
    }

    const ctx = { runId: input.runId, sessionId: input.sessionId, seq: input.seq }
    const emitted: RuntimeEventEnvelope[] = []
    for (const streamEvent of input.events) {
      const domainEvents = projectStreamEvent(this.state, streamEvent, ctx)
      for (const event of domainEvents) {
        emitted.push(
          ...this.commitEvent(event, {
            runId: ctx.runId,
            sessionId: ctx.sessionId,
            runSeq: ctx.seq
          })
        )
      }
    }
    this.expiredSessions.delete(input.sessionId)
    return emitted
  }

  commitRun(sessionId: string, runId: string | null): RuntimeEventEnvelope[] {
    const envelopes = this.commitEvent(
      {
        type: 'runtime.session-transcript-committed',
        sessionId,
        runId,
        revision: this.state.projectionRevision + 1
      },
      { runId, sessionId, runSeq: 0 }
    )
    if (!projectionHasSessionOverlay(this.state, sessionId)) {
      this.expiredSessions.add(sessionId)
    }
    return envelopes
  }

  attach(params: AttachRuntimeParams): AttachRuntimeResult {
    const sessionId = params.sessionId
    if (
      sessionId &&
      this.expiredSessions.has(sessionId) &&
      !projectionHasSessionOverlay(this.state, sessionId)
    ) {
      return this.attachResult('expired', null, [], 'runtime_expired')
    }

    const sameEpoch =
      params.knownGatewayEpoch !== null && params.knownGatewayEpoch === this.state.gatewayEpoch
    const knownRevision = params.knownProjectionRevision
    if (sameEpoch && knownRevision !== null) {
      const lookup = this.journal.patchesSince(knownRevision)
      if (lookup.mode === 'patches') {
        const patches = sessionId
          ? lookup.patches.filter(
              (envelope) => envelope.sessionId === sessionId || envelope.sessionId === null
            )
          : lookup.patches
        return this.attachResult('patches', null, patches, null)
      }
    }

    const snapshot = sessionId ? this.sessionSnapshot(sessionId) : this.state
    return this.attachResult('snapshot', snapshot, [], null)
  }

  private commitEvent(
    event: RuntimeEvent,
    route: { runId: string | null; sessionId: string | null; runSeq: number }
  ): RuntimeEventEnvelope[] {
    const eventId = this.ids.nextId()
    const occurredAt = this.ids.now()
    this.state = applyRuntimeEvent(this.state, event)
    if (route.runId) this.state = withRunSeq(this.state, route.runId, route.runSeq)
    const envelope: RuntimeEventEnvelope = {
      schemaVersion: RUNTIME_MODEL_SCHEMA_VERSION,
      gatewayEpoch: this.state.gatewayEpoch,
      workerInstanceId: this.state.workerInstanceId,
      eventId,
      correlationId: route.runId ?? this.state.gatewayEpoch,
      causationId: route.runId ?? this.state.gatewayEpoch,
      runId: route.runId,
      sessionId: route.sessionId,
      runSeq: route.runSeq,
      projectionRevision: this.state.projectionRevision,
      occurredAt,
      event
    }
    this.journal.append(envelope, estimateEnvelopeBytes(envelope))
    return [envelope]
  }

  private attachResult(
    mode: AttachRuntimeResult['mode'],
    snapshot: AgentRuntimeProjection | null,
    patches: RuntimeEventEnvelope[],
    errorCode: AttachRuntimeResult['errorCode']
  ): AttachRuntimeResult {
    return {
      mode,
      gatewayEpoch: this.state.gatewayEpoch,
      workerInstanceId: this.state.workerInstanceId,
      projectionRevision: this.state.projectionRevision,
      snapshot,
      patches,
      errorCode
    }
  }
}

function estimateEnvelopeBytes(envelope: RuntimeEventEnvelope): number {
  return JSON.stringify(envelope).length
}
