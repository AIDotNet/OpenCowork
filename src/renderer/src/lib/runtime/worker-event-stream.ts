import { isAgentStreamEnvelope } from '../../../../shared/messagepack/agent-stream-codec'
import type { AgentStreamEnvelope } from '../../../../shared/agent-stream-protocol'
import {
  getWorkerConnection,
  invalidateWorkerConnection,
  requestWorker,
  type WorkerConnection
} from './worker-http-client'

/**
 * This window's own subscription to the worker's durable event stream.
 *
 * The window is a durable consumer in its own right rather than a recipient of
 * frames the host relays: it holds its own cursor, and it acknowledges only after
 * an envelope has been applied. That ordering is what makes a reload recoverable
 * from the worker's on-disk outbox instead of from a bounded in-memory journal in
 * the host, which drops the middle of long runs.
 */

const RECONNECT_DELAY_MS = 500
const CHECKPOINT_TIMEOUT_MS = 10_000

/**
 * Envelopes applied between cursor writes.
 *
 * The cursor is not an acknowledgement — nothing is held back waiting for it, and
 * this window states its real position by resubscribing with a sequence. Writing
 * it per envelope cost thousands of round trips per run for no added safety; the
 * only thing at stake is how far a resubscribe rewinds.
 */
const CHECKPOINT_EVERY = 64

type EnvelopeSink = (envelope: AgentStreamEnvelope) => void

let connection: WorkerConnection | null = null
let abort: AbortController | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let started = false
let sink: EnvelopeSink | null = null

const CONSUMER_ID_STORAGE_KEY = 'openCowork.workerConsumerId'

/**
 * This window's durable consumer id, stable across reloads.
 *
 * The worker keeps one cursor per consumer, so a fresh id on every reload would
 * strand the old cursor and replay each run from its beginning. sessionStorage is
 * scoped to this window and survives a reload, which is exactly the lifetime a
 * window's subscription should have.
 */
function resolveConsumerId(): { consumerId: string; isNew: boolean } {
  try {
    const existing = sessionStorage.getItem(CONSUMER_ID_STORAGE_KEY)
    if (existing) return { consumerId: existing, isNew: false }
    const minted = `window-${crypto.randomUUID()}`
    sessionStorage.setItem(CONSUMER_ID_STORAGE_KEY, minted)
    return { consumerId: minted, isNew: true }
  } catch {
    // Private mode or a blocked storage partition: a per-load id still streams,
    // it just cannot resume across a reload.
    return { consumerId: `window-${crypto.randomUUID()}`, isNew: true }
  }
}

const { consumerId, isNew: isFreshConsumer } = resolveConsumerId()

/**
 * True until this window has subscribed once.
 *
 * A consumer id the worker has never seen has no cursor, and a missing cursor
 * reads as zero, so an ordinary subscribe would replay every run still inside the
 * retention window into a window that only wants what happens next. History for a
 * specific run is requested separately when attaching to it.
 */
let needsLiveOnlySubscribe = isFreshConsumer

/**
 * Highest applied seq per run, so a reconnect resumes rather than replaying from
 * the start of every unacknowledged run.
 */
const lastAppliedSeq = new Map<string, number>()
/** Envelopes applied for a run since its cursor was last written. */
const sinceCheckpoint = new Map<string, number>()

export function startWorkerEventStream(applyEnvelope: EnvelopeSink): void {
  if (started) return
  started = true
  sink = applyEnvelope
  void connectStream({ resubscribe: true })
}

export function stopWorkerEventStream(): void {
  started = false
  sink = null
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
  abort?.abort()
  abort = null
}

export function isWorkerEventStreamConnected(): boolean {
  return abort !== null && !abort.signal.aborted
}

async function connectStream({ resubscribe }: { resubscribe: boolean }): Promise<void> {
  if (!started) return

  connection = await getWorkerConnection()
  if (!connection) {
    scheduleReconnect()
    return
  }

  const controller = new AbortController()
  abort = controller

  try {
    // Subscribing before reading declares the cursor, so anything persisted while
    // this window was away is pushed onto the stream we are about to read.
    if (resubscribe) {
      await requestWorker('events/subscribe', {
        consumerId,
        limit: 4096,
        ...(needsLiveOnlySubscribe ? { fromLatest: true } : {})
      })
      needsLiveOnlySubscribe = false
    }

    const url = `${connection.baseUrl}/events?consumerId=${encodeURIComponent(consumerId)}`
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${connection.token}`,
        Accept: 'text/event-stream'
      },
      signal: controller.signal
    })
    if (!response.ok || !response.body) {
      throw new Error(`worker event stream returned HTTP ${response.status}`)
    }

    await readStream(response.body, controller)
    throw new Error('worker event stream ended')
  } catch (error) {
    if (!started || controller.signal.aborted) return
    // A replaced worker answers on a stale port, so the cached endpoint has to go
    // before the next attempt.
    invalidateWorkerConnection()
    console.warn(
      '[worker-event-stream] disconnected; will resubscribe',
      error instanceof Error ? error.message : String(error)
    )
    scheduleReconnect()
  }
}

async function readStream(
  body: ReadableStream<Uint8Array>,
  controller: AbortController
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffered = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || controller.signal.aborted) return
      buffered += decoder.decode(value, { stream: true })
      let newlineAt = buffered.indexOf('\n')
      while (newlineAt >= 0) {
        const line = buffered.slice(0, newlineAt).replace(/\r$/u, '')
        buffered = buffered.slice(newlineAt + 1)
        consumeLine(line)
        newlineAt = buffered.indexOf('\n')
      }
    }
  } finally {
    reader.cancel().catch(() => {
      // The stream is already going away; nothing to recover.
    })
  }
}

/**
 * The worker writes one `data:` line per event and never splits an envelope
 * across lines; `:keepalive` comments and `id:` lines carry no payload.
 */
function consumeLine(line: string): void {
  if (!line.startsWith('data:')) return
  const data = line.slice(5).trimStart()
  if (!data) return

  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch (error) {
    console.warn(
      '[worker-event-stream] unparsable event payload',
      error instanceof Error ? error.message : String(error)
    )
    return
  }

  const envelope = readAgentStreamEnvelope(payload)
  if (!envelope) return
  applyAndAcknowledge(envelope)
}

function readAgentStreamEnvelope(payload: unknown): AgentStreamEnvelope | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const frame = payload as Record<string, unknown>
  if (frame.event !== 'agent/stream') return null
  if (isAgentStreamEnvelope(frame.params)) return frame.params
  const flat = {
    v: frame.v,
    runId: frame.runId,
    sessionId: frame.sessionId,
    seq: frame.seq,
    events: frame.events,
    ...(frame.live === true ? { live: true } : {})
  }
  return isAgentStreamEnvelope(flat) ? flat : null
}

function applyAndAcknowledge(envelope: AgentStreamEnvelope): void {
  try {
    sink?.(envelope)
  } catch (error) {
    // Do not acknowledge what the UI failed to take: leaving it unacknowledged is
    // what lets the outbox re-deliver it.
    console.warn(
      '[worker-event-stream] failed to apply envelope; withholding ack',
      error instanceof Error ? error.message : String(error)
    )
    return
  }

  // Live frames are not in the durable outbox, so there is no cursor to advance.
  if (envelope.live === true) return

  const previous = lastAppliedSeq.get(envelope.runId) ?? 0
  if (envelope.seq <= previous) return
  lastAppliedSeq.set(envelope.runId, envelope.seq)

  const applied = (sinceCheckpoint.get(envelope.runId) ?? 0) + 1
  const terminal = envelope.events.some(
    (event) => event.type === 'loop_end' || event.type === 'error'
  )
  if (applied < CHECKPOINT_EVERY && !terminal) {
    sinceCheckpoint.set(envelope.runId, applied)
    return
  }

  sinceCheckpoint.delete(envelope.runId)
  void requestWorker(
    'events/checkpoint',
    { consumerId, jobId: envelope.runId, throughSeq: envelope.seq },
    CHECKPOINT_TIMEOUT_MS
  ).catch(() => {
    // Losing a checkpoint only means resubscribing rewinds further.
  })
}

function scheduleReconnect(): void {
  if (reconnectTimer || !started) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void connectStream({ resubscribe: true })
  }, RECONNECT_DELAY_MS)
}
