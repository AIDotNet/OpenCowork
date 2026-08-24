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

/**
 * Applies an envelope and reports the outcome. A `gap` result means the sink
 * refused it because an earlier sequence never arrived.
 */
type EnvelopeSink = (envelope: AgentStreamEnvelope) => EnvelopeApplyResult

type EnvelopeApplyResult =
  | { status: 'applied' }
  | { status: 'duplicate' }
  | { status: 'rejected' }
  | { status: 'gap'; runId: string; expected: number }

type StreamHooks = {
  /** Highest sequence the sink has applied for a run, if any. */
  lastAppliedSeq: (runId: string) => number | undefined
}

let connection: WorkerConnection | null = null
let abort: AbortController | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let started = false
let sink: EnvelopeSink | null = null
let hooks: StreamHooks | null = null
/** Runs with a replay already in flight, so a burst of gaps asks only once. */
const healingRuns = new Set<string>()

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

export function startWorkerEventStream(
  applyEnvelope: EnvelopeSink,
  streamHooks: StreamHooks
): void {
  if (started) return
  started = true
  sink = applyEnvelope
  hooks = streamHooks
  void connectStream({ resubscribe: true })
}

export function stopWorkerEventStream(): void {
  started = false
  sink = null
  hooks = null
  healingRuns.clear()
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
  let result: EnvelopeApplyResult
  try {
    result = sink?.(envelope) ?? { status: 'rejected' }
  } catch (error) {
    // Do not checkpoint what the UI failed to take: leaving the cursor behind is
    // what lets the outbox re-deliver it.
    console.warn(
      '[worker-event-stream] failed to apply envelope; withholding checkpoint',
      error instanceof Error ? error.message : String(error)
    )
    return
  }

  if (result.status === 'gap') {
    // The sink is holding out for an earlier sequence and will refuse everything
    // after it, so the run would go silent — no terminal event, no sub-agent
    // completion, not even what a cancel emits. Refill from the durable outbox.
    healRunFromOutbox(result.runId, result.expected)
    return
  }
  // Checkpointing a rejected envelope would move the cursor past something the UI
  // never took, making it unrecoverable.
  if (result.status !== 'applied') return

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

/**
 * Asks the worker to re-send a run from the last sequence the UI actually
 * applied.
 *
 * This is the durable outbox earning its keep: the events are still on disk, so a
 * gap is recoverable rather than terminal. It replaced a host-side journal that
 * used to serve the same purpose from memory, capped, and lossy on long runs.
 */
function healRunFromOutbox(runId: string, expected: number): void {
  if (healingRuns.has(runId)) return
  healingRuns.add(runId)

  const sinceSeq = Math.max(0, hooks?.lastAppliedSeq(runId) ?? expected - 1)
  console.warn('[worker-event-stream] sequence gap; replaying run from the outbox', {
    runId,
    expected,
    sinceSeq
  })

  void requestWorker(
    'events/replay',
    { consumerId, jobId: runId, sinceSeq, limit: 4096 },
    CHECKPOINT_TIMEOUT_MS
  )
    .catch((error) => {
      console.warn(
        '[worker-event-stream] gap replay failed',
        error instanceof Error ? error.message : String(error)
      )
    })
    .finally(() => {
      healingRuns.delete(runId)
    })
}

function scheduleReconnect(): void {
  if (reconnectTimer || !started) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void connectStream({ resubscribe: true })
  }, RECONNECT_DELAY_MS)
}
