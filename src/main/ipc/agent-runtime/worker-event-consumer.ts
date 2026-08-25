import type { NativeWorkerRawEventFrame } from '../../lib/native-worker'
import { DESKTOP_EVENT_CONSUMER_ID } from '../../../shared/worker-event-consumers'
import type { RuntimeEventEnvelope } from '../../../shared/runtime-contracts/generated/contracts'

// Re-exported so existing importers keep resolving it from here.
export { DESKTOP_EVENT_CONSUMER_ID }

export type WorkerEventConsumerDiagnostics = {
  pendingAckCount: number
  pendingAckBytes: number
  ackedCount: number
  droppedUiFanouts: number
  withheldBatches: number
  forcedAcks: number
  lastAckAt: number | null
  lastError: string | null
}

export type ConsumeFrameResult = {
  journaled: boolean
  projected: boolean
  acked: boolean
  publishedUi: boolean
}

/**
 * How many consecutive undelivered batches one run may withhold before its cursor
 * is advanced anyway.
 *
 * The worker's unacknowledged window is shared across every run on this consumer,
 * so a run whose window never comes back would otherwise hold the whole window and
 * stall streaming for every other run. Staying well under that window keeps one
 * abandoned run from starving the rest.
 */
const MAX_WITHHELD_BATCHES_PER_RUN = 8

export type WorkerEventConsumerDeps = {
  recordFrame: (frame: NativeWorkerRawEventFrame) => void
  ingestFrame: (frame: NativeWorkerRawEventFrame) => RuntimeEventEnvelope[]
  publishPatches: (envelopes: RuntimeEventEnvelope[]) => void
  ack: (runId: string, throughSeq: number) => void
  isRunning: () => boolean
  request: (method: string, params: unknown, timeoutMs: number) => Promise<unknown>
}

type DurableJobListItem = {
  method?: string
  runId?: string
  jobId?: string
  state?: string
}

export class WorkerEventConsumer {
  private pendingAckCount = 0
  private pendingAckBytes = 0
  private ackedCount = 0
  private droppedUiFanouts = 0
  private withheldBatches = 0
  private forcedAcks = 0
  private lastAckAt: number | null = null
  private lastError: string | null = null
  private readonly withheldByRun = new Map<string, number>()

  private readonly deps: WorkerEventConsumerDeps

  constructor(deps: WorkerEventConsumerDeps) {
    this.deps = deps
  }

  getDiagnostics(): WorkerEventConsumerDiagnostics {
    return {
      pendingAckCount: this.pendingAckCount,
      pendingAckBytes: this.pendingAckBytes,
      ackedCount: this.ackedCount,
      droppedUiFanouts: this.droppedUiFanouts,
      withheldBatches: this.withheldBatches,
      forcedAcks: this.forcedAcks,
      lastAckAt: this.lastAckAt,
      lastError: this.lastError
    }
  }

  consumeFrame(frame: NativeWorkerRawEventFrame): ConsumeFrameResult {
    const byteLength = typeof frame.byteLength === 'number' ? frame.byteLength : 0
    this.pendingAckCount += 1
    this.pendingAckBytes += byteLength

    const result: ConsumeFrameResult = {
      journaled: false,
      projected: false,
      acked: false,
      publishedUi: false
    }

    try {
      this.deps.recordFrame(frame)
      result.journaled = true
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      console.warn('[worker-event-consumer] journal failed; withholding ACK', {
        runId: frame.runId ?? null,
        error: this.lastError
      })
      this.releasePending(byteLength)
      return result
    }

    let envelopes: RuntimeEventEnvelope[] = []
    try {
      envelopes = this.deps.ingestFrame(frame)
      result.projected = true
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      console.warn('[worker-event-consumer] projection ingest failed; withholding ACK', {
        runId: frame.runId ?? null,
        error: this.lastError
      })
      this.releasePending(byteLength)
      return result
    }

    this.releasePending(byteLength)

    try {
      this.deps.publishPatches(envelopes)
      result.publishedUi = envelopes.length > 0
    } catch (error) {
      // The projection patch channel is a shadow overlay today; the authoritative
      // render path is the batched agent stream, and that is what gates the ACK.
      // Failing here therefore costs overlay fidelity, not transcript content.
      this.droppedUiFanouts += 1
      this.lastError = error instanceof Error ? error.message : String(error)
      console.warn('[worker-event-consumer] dropped UI patch', {
        runId: frame.runId ?? null,
        error: this.lastError
      })
    }

    // Deliberately not acknowledged here. The durable cursor may only advance once
    // the frame has actually reached a renderer, which happens later when the
    // batch this frame joined is flushed — see acknowledgeDelivered.
    return result
  }

  /**
   * Advances the durable cursor for a batch that reached a renderer.
   *
   * Splitting this from {@link consumeFrame} is the point: acknowledging on receipt
   * told the worker it could forget events the UI had not seen, which left an
   * in-memory journal bounded at 8 MiB per run as the only way to recover them.
   */
  acknowledgeDelivered(runId: string, throughSeq: number): boolean {
    if (!runId || !Number.isFinite(throughSeq) || throughSeq <= 0) return false
    this.withheldByRun.delete(runId)
    this.deps.ack(runId, throughSeq)
    this.ackedCount += 1
    this.lastAckAt = Date.now()
    return true
  }

  /**
   * Records a batch no renderer received.
   *
   * Withholding keeps the events replayable from the worker's durable outbox, but
   * only up to {@link MAX_WITHHELD_BATCHES_PER_RUN}: the unacknowledged window is
   * shared across runs, so a run whose renderer never returns must eventually give
   * its slots back rather than stall streaming for everything else.
   */
  acknowledgeUndelivered(runId: string, throughSeq: number, reason: string): boolean {
    if (!runId || !Number.isFinite(throughSeq) || throughSeq <= 0) return false

    const withheld = (this.withheldByRun.get(runId) ?? 0) + 1
    if (withheld <= MAX_WITHHELD_BATCHES_PER_RUN) {
      this.withheldByRun.set(runId, withheld)
      this.withheldBatches += 1
      console.warn('[worker-event-consumer] withholding ACK; frames stay replayable', {
        runId,
        throughSeq,
        reason,
        withheld
      })
      return false
    }

    this.withheldByRun.delete(runId)
    this.forcedAcks += 1
    console.warn('[worker-event-consumer] forcing ACK to free the shared window', {
      runId,
      throughSeq,
      reason,
      withheld
    })
    this.deps.ack(runId, throughSeq)
    this.ackedCount += 1
    this.lastAckAt = Date.now()
    return true
  }

  forgetRun(runId: string): void {
    this.withheldByRun.delete(runId)
  }

  async recoverPump(runId?: string): Promise<{ published: number; jobState: string | null }> {
    if (!this.deps.isRunning()) {
      return { published: 0, jobState: null }
    }

    const subscribed = (await this.deps.request(
      'events/subscribe',
      { consumerId: DESKTOP_EVENT_CONSUMER_ID, limit: 4096 },
      30_000
    )) as { published?: number }

    let published = typeof subscribed.published === 'number' ? subscribed.published : 0
    let jobState: string | null = null

    if (!runId) return { published, jobState }

    try {
      const replayed = (await this.deps.request(
        'events/replay',
        { consumerId: DESKTOP_EVENT_CONSUMER_ID, jobId: runId, sinceSeq: 0, limit: 4096 },
        30_000
      )) as { published?: number }
      if (typeof replayed.published === 'number') {
        published = Math.max(published, replayed.published)
      }
      await this.deps.request(
        'events/subscribe',
        { consumerId: DESKTOP_EVENT_CONSUMER_ID, limit: 4096 },
        30_000
      )
    } catch (error) {
      console.warn('[worker-event-consumer] durable event replay failed', {
        runId,
        error: error instanceof Error ? error.message : String(error)
      })
    }

    try {
      const status = (await this.deps.request('jobs/status', { jobId: runId }, 10_000)) as {
        state?: string
        found?: boolean
      }
      if (status.found === false) {
        jobState = 'missing'
      } else if (typeof status.state === 'string') {
        jobState = status.state
      }
    } catch (error) {
      console.warn('[worker-event-consumer] jobs/status during stream recovery failed', {
        runId,
        error: error instanceof Error ? error.message : String(error)
      })
    }

    return { published, jobState }
  }

  async rebuildActiveOverlay(): Promise<number> {
    await this.recoverPump()
    const listed = (await this.deps.request('jobs/list', { limit: 1000 }, 30_000)) as {
      jobs?: DurableJobListItem[]
    }
    const active = (listed.jobs ?? []).filter(
      (job) => job.method === 'agent/run' && (job.state === 'queued' || job.state === 'running')
    )
    let published = 0
    for (const job of active) {
      const runId = job.runId || job.jobId
      if (!runId) continue
      const recovered = await this.recoverPump(runId)
      published += recovered.published
    }
    return published
  }

  private releasePending(byteLength: number): void {
    this.pendingAckCount = Math.max(0, this.pendingAckCount - 1)
    this.pendingAckBytes = Math.max(0, this.pendingAckBytes - byteLength)
  }
}
