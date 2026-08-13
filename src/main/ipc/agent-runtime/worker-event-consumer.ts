import type { NativeWorkerRawEventFrame } from '../../lib/native-worker'
import type { RuntimeEventEnvelope } from '../../../shared/runtime-contracts/generated/contracts'

export const DESKTOP_EVENT_CONSUMER_ID = 'desktop'

export type WorkerEventConsumerDiagnostics = {
  pendingAckCount: number
  pendingAckBytes: number
  ackedCount: number
  droppedUiFanouts: number
  lastAckAt: number | null
  lastError: string | null
}

export type ConsumeFrameResult = {
  journaled: boolean
  projected: boolean
  acked: boolean
  publishedUi: boolean
}

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
  private lastAckAt: number | null = null
  private lastError: string | null = null

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

    result.acked = this.acknowledge(frame)
    this.releasePending(byteLength)

    try {
      this.deps.publishPatches(envelopes)
      result.publishedUi = envelopes.length > 0
    } catch (error) {
      this.droppedUiFanouts += 1
      this.lastError = error instanceof Error ? error.message : String(error)
      console.warn('[worker-event-consumer] dropped UI patch after ACK', {
        runId: frame.runId ?? null,
        error: this.lastError
      })
    }

    return result
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

  private acknowledge(frame: NativeWorkerRawEventFrame): boolean {
    const runId = typeof frame.runId === 'string' ? frame.runId : ''
    const throughSeq = typeof frame.seq === 'number' ? frame.seq : 0
    if (!runId || !Number.isFinite(throughSeq) || throughSeq <= 0) return false
    this.deps.ack(runId, throughSeq)
    this.ackedCount += 1
    this.lastAckAt = Date.now()
    return true
  }

  private releasePending(byteLength: number): void {
    this.pendingAckCount = Math.max(0, this.pendingAckCount - 1)
    this.pendingAckBytes = Math.max(0, this.pendingAckBytes - byteLength)
  }
}
