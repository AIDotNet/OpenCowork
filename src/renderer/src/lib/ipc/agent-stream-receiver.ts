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

    const isTerminal = envelope.events.some((e) => e.type === 'loop_end' || e.type === 'error')

    const lastSeq = this.lastSeqByRun.get(envelope.runId)
    // Idempotency: an envelope whose seq we've already applied is a duplicate —
    // e.g. journal replay on reattach overlapping frames the window already saw.
    // Skip it, EXCEPT a terminal envelope, which must always run its cleanup
    // (delete lastSeqByRun, let subscribers finalize the run).
    if (lastSeq !== undefined && envelope.seq <= lastSeq && !isTerminal) {
      return
    }
    if (lastSeq !== undefined && envelope.seq > lastSeq + 1) {
      console.warn(
        `[AgentStream] Gap detected for run ${envelope.runId}: expected ${lastSeq + 1}, got ${envelope.seq}`
      )
    }
    if (lastSeq === undefined || envelope.seq > lastSeq) {
      this.lastSeqByRun.set(envelope.runId, envelope.seq)
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

    if (isTerminal) {
      this.lastSeqByRun.delete(envelope.runId)
    }
  }

  /** Highest seq applied for a run, or undefined if none seen. Used to compute
   *  the `sinceSeq` for journal replay on reattach. */
  getLastSeq(runId: string): number | undefined {
    return this.lastSeqByRun.get(runId)
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
