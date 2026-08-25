import type {
  AgentStreamEnvelope,
  AgentStreamEvent
} from '../../../../shared/agent-stream-protocol'
import { AGENT_STREAM_PROTOCOL_VERSION } from '../../../../shared/agent-stream-protocol'
import {
  AGENT_STREAM_INJECTED_CHANNEL,
  readAgentStreamEnvelope
} from '../../../../shared/messagepack/agent-stream-codec'
import { startWorkerEventStream, stopWorkerEventStream } from '../runtime/worker-event-stream'
import { ipcClient } from './ipc-client'

type RunEventCallback = (event: AgentStreamEvent) => void
type GlobalEventCallback = (runId: string, sessionId: string, event: AgentStreamEvent) => void

/** Outcome of handing one envelope to the receiver. */
export type AgentStreamApplyResult =
  | { status: 'applied' }
  | { status: 'duplicate' }
  | { status: 'rejected' }
  | { status: 'gap'; runId: string; expected: number }

// Keep completed runs long enough to deduplicate an ACK-loss replay without
// allowing a long-lived Renderer process to grow this journal index forever.
const MAX_TRACKED_RUN_SEQUENCES = 4096

export class AgentStreamReceiver {
  private runHandlers = new Map<string, Set<RunEventCallback>>()
  private globalHandlers = new Set<GlobalEventCallback>()
  private lastSeqByRun = new Map<string, number>()
  private attached = false

  /**
   * Subscribes this window directly to the worker's durable event stream.
   *
   * Frames no longer arrive relayed from the host. Owning the subscription means
   * this window has its own cursor, so a reload resumes from the worker's on-disk
   * outbox rather than from a size-bounded journal in the host process.
   */
  attach(): void {
    if (this.attached) return
    this.attached = true
    startWorkerEventStream((envelope) => this.acceptEnvelope(envelope), {
      lastAppliedSeq: (runId) => this.getLastSeq(runId)
    })

    // Envelopes the worker could not send itself, such as the terminal error for
    // a run whose worker died. Without this a lost worker leaves the UI streaming
    // forever, because the subscription it was reading simply stops.
    window.electron.ipcRenderer.on(
      AGENT_STREAM_INJECTED_CHANNEL,
      (_ipcEvent: unknown, payload: unknown) => {
        const envelope = readAgentStreamEnvelope(payload)
        if (!envelope) return
        this.acceptEnvelope(envelope)
      }
    )
  }

  detach(): void {
    if (!this.attached) return
    this.attached = false
    stopWorkerEventStream()
  }

  get isAttached(): boolean {
    return this.attached
  }

  subscribe(runId: string, callback: RunEventCallback): () => void {
    let handlers = this.runHandlers.get(runId)
    if (!handlers) {
      handlers = new Set()
      this.runHandlers.set(runId, handlers)
    }
    handlers.add(callback)

    return () => {
      handlers!.delete(callback)
      if (handlers!.size === 0) {
        this.runHandlers.delete(runId)
      }
    }
  }

  subscribeAll(callback: GlobalEventCallback): () => void {
    this.globalHandlers.add(callback)
    return () => {
      this.globalHandlers.delete(callback)
    }
  }

  notifySessionVisibility(sessionId: string, visible: boolean): void {
    ipcClient.send('agent:session-visibility', { sessionId, visible })
  }

  /**
   * Applies one envelope, reporting why it did not when it did not.
   *
   * A gap must be reported rather than swallowed. The sequence is not advanced
   * past it, so every later envelope for that run would also read as a gap and
   * the run would go silent for good — no terminal event, no sub-agent
   * completion, not even the events a cancel produces. The caller answers a gap
   * by replaying the run from the worker's durable outbox.
   */
  private acceptEnvelope(envelope: AgentStreamEnvelope): AgentStreamApplyResult {
    if (envelope.v !== AGENT_STREAM_PROTOCOL_VERSION) {
      console.warn('[AgentStream] Unknown protocol version', envelope.v)
      return { status: 'rejected' }
    }

    const lastSeq = this.lastSeqByRun.get(envelope.runId)
    const live = envelope.live === true
    // Live frames are not part of the durable cursor. Applying them through the
    // seq gate would either drop draft tokens or create a hole before the
    // completed context_compressed event.
    if (!live) {
      if (lastSeq !== undefined && envelope.seq <= lastSeq) {
        return { status: 'duplicate' }
      }
      if (lastSeq !== undefined && envelope.seq > lastSeq + 1) {
        return { status: 'gap', runId: envelope.runId, expected: lastSeq + 1 }
      }
      if (lastSeq === undefined || envelope.seq > lastSeq) {
        this.rememberSequence(envelope.runId, envelope.seq)
      }
    }

    if (shouldLogStreamTrace()) {
      console.debug('[AgentStream] envelope applied', {
        runId: envelope.runId,
        sessionId: envelope.sessionId,
        seq: envelope.seq,
        events: envelope.events.length
      })
    }

    for (const event of envelope.events) {
      this.dispatch(envelope.runId, envelope.sessionId, event)
    }
    return { status: 'applied' }
  }

  /** Highest seq applied for a run, or undefined if none seen. Used to compute
   *  the `sinceSeq` for journal replay on reattach. */
  getLastSeq(runId: string): number | undefined {
    return this.lastSeqByRun.get(runId)
  }

  private rememberSequence(runId: string, seq: number): void {
    // Delete first so Map insertion order acts as a compact LRU. Active runs are
    // touched on every batch and therefore cannot be displaced by older terminals.
    this.lastSeqByRun.delete(runId)
    this.lastSeqByRun.set(runId, seq)
    while (this.lastSeqByRun.size > MAX_TRACKED_RUN_SEQUENCES) {
      const oldestRunId = this.lastSeqByRun.keys().next().value
      if (typeof oldestRunId !== 'string') break
      this.lastSeqByRun.delete(oldestRunId)
    }
  }

  private dispatch(runId: string, sessionId: string, event: AgentStreamEvent): void {
    const handlers = this.runHandlers.get(runId)
    if (handlers) {
      for (const handler of handlers) {
        handler(event)
      }
    }

    for (const handler of this.globalHandlers) {
      handler(runId, sessionId, event)
    }
  }
}

export const agentStream = new AgentStreamReceiver()

function shouldLogStreamTrace(): boolean {
  try {
    return localStorage.getItem('openCowork.msgpackTrace') === '1'
  } catch {
    return false
  }
}
