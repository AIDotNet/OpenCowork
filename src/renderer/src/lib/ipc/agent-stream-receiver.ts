import type {
  AgentStreamEnvelope,
  AgentStreamEvent
} from '../../../../shared/agent-stream-protocol'
import { AGENT_STREAM_PROTOCOL_VERSION } from '../../../../shared/agent-stream-protocol'
import {
  AGENT_STREAM_MSGPACK_CHANNEL,
  decodeAgentStreamEnvelopes
} from '../../../../shared/messagepack/agent-stream-codec'
import { ipcClient } from './ipc-client'

type RunEventCallback = (event: AgentStreamEvent) => void
type GlobalEventCallback = (runId: string, sessionId: string, event: AgentStreamEvent) => void

// Keep completed runs long enough to deduplicate an ACK-loss replay without
// allowing a long-lived Renderer process to grow this journal index forever.
const MAX_TRACKED_RUN_SEQUENCES = 4096

export class AgentStreamReceiver {
  private runHandlers = new Map<string, Set<RunEventCallback>>()
  private globalHandlers = new Set<GlobalEventCallback>()
  private lastSeqByRun = new Map<string, number>()
  private attached = false

  attach(): void {
    if (this.attached) return
    this.attached = true

    window.electron.ipcRenderer.on(
      AGENT_STREAM_MSGPACK_CHANNEL,
      (_ipcEvent: unknown, bytes: ArrayBuffer | ArrayBufferView) => {
        const startedAt = performance.now()
        try {
          const envelopes = decodeAgentStreamEnvelopes(bytes)
          const metrics = {
            byteLength: getByteLength(bytes),
            decodeMs: Math.round((performance.now() - startedAt) * 100) / 100
          }
          for (const envelope of envelopes) {
            this.acceptEnvelope(envelope, metrics)
          }
        } catch (error) {
          console.warn(
            '[AgentStream] Failed to decode MessagePack envelope',
            error instanceof Error ? error.message : String(error)
          )
        }
      }
    )
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

  private acceptEnvelope(
    envelope: AgentStreamEnvelope,
    metrics?: { byteLength: number; decodeMs: number }
  ): void {
    if (envelope.v !== AGENT_STREAM_PROTOCOL_VERSION) {
      console.warn('[AgentStream] Unknown protocol version', envelope.v)
      return
    }

    const lastSeq = this.lastSeqByRun.get(envelope.runId)
    // Idempotency: an envelope whose seq we've already applied is a duplicate —
    // e.g. journal replay on reattach overlapping frames the window already saw.
    // Terminal batches follow the same rule: finalizing a run twice can duplicate
    // messages and state transitions. Re-ACK every duplicate because the first ACK
    // may have been lost after reducers committed the original batch.
    if (lastSeq !== undefined && envelope.seq <= lastSeq) {
      // The original ACK may have been lost after the reducer committed. Re-ACK
      // duplicates so the worker's durable cursor and in-flight window can advance.
      void ipcClient
        .invoke('agent:event-ack', { runId: envelope.runId, throughSeq: envelope.seq })
        .catch(() => {})
      return
    }
    if (lastSeq !== undefined && envelope.seq > lastSeq + 1) {
      console.warn(
        `[AgentStream] Gap detected for run ${envelope.runId}: expected ${lastSeq + 1}, got ${envelope.seq}`
      )
      // Event reconnect already requests durable replay. Never apply/ACK past a
      // gap: ACK-through would permanently skip the missing envelope.
      return
    }
    if (lastSeq === undefined || envelope.seq > lastSeq) {
      this.rememberSequence(envelope.runId, envelope.seq)
    }

    if (shouldLogMessagePackTrace()) {
      console.debug('[AgentStream] MessagePack envelope decoded', {
        runId: envelope.runId,
        sessionId: envelope.sessionId,
        seq: envelope.seq,
        events: envelope.events.length,
        ...metrics
      })
    }

    for (const event of envelope.events) {
      this.dispatch(envelope.runId, envelope.sessionId, event)
    }

    // ACK only after every synchronous reducer/subscriber has applied the batch.
    // ACK loss is harmless: the worker replays and the seq guard above deduplicates it.
    void ipcClient
      .invoke('agent:event-ack', { runId: envelope.runId, throughSeq: envelope.seq })
      .catch(() => {})
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

function getByteLength(bytes: ArrayBuffer | ArrayBufferView): number {
  return bytes instanceof ArrayBuffer ? bytes.byteLength : bytes.byteLength
}

function shouldLogMessagePackTrace(): boolean {
  try {
    return localStorage.getItem('openCowork.msgpackTrace') === '1'
  } catch {
    return false
  }
}
