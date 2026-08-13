import { randomUUID } from 'crypto'
import { decodeAgentStreamEnvelope } from '../../../shared/messagepack/agent-stream-codec'
import { RUNTIME_OVERLAY_RETENTION_MS } from '../../../shared/runtime-projection/journal'
import { RuntimeProjectionEngine } from '../../../shared/runtime-projection/engine'
import type { AgentRuntimeProjection } from '../../../shared/runtime-contracts/generated/contracts'
import type {
  AttachRuntimeParams,
  AttachRuntimeResult,
  RuntimeEventEnvelope
} from '../../../shared/runtime-contracts/generated/contracts'
import type { NativeWorkerRawEventFrame } from '../../lib/native-worker'
import { getRuntimeRegistry } from '../runtime-registry'
import { RuntimeWindowRouter } from './runtime-window-router'

export class RuntimeProjectionHost {
  private engine: RuntimeProjectionEngine
  private readonly router = new RuntimeWindowRouter()
  private readonly expireTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor() {
    this.engine = new RuntimeProjectionEngine(randomUUID(), 'uninitialized')
  }

  get snapshot(): AgentRuntimeProjection {
    return this.engine.snapshot
  }

  get gatewayEpoch(): string {
    return this.engine.gatewayEpoch
  }

  get workerInstanceId(): string {
    return this.engine.workerInstanceId
  }

  bindSubscriber(subscriberId: string, webContentsId: number, sessionId: string | null): void {
    this.router.bind(subscriberId, webContentsId, sessionId)
  }

  unbindSubscriber(subscriberId: string): void {
    this.router.unbind(subscriberId)
  }

  attach(params: AttachRuntimeParams): AttachRuntimeResult {
    this.router.setSessionFilter(params.subscriberId, params.sessionId)
    return this.engine.attach(params)
  }

  sessionSnapshot(sessionId: string): AgentRuntimeProjection {
    return this.engine.sessionSnapshot(sessionId)
  }

  reset(workerInstanceId: string, reason: string): void {
    for (const timer of this.expireTimers.values()) clearTimeout(timer)
    this.expireTimers.clear()
    const envelopes = this.engine.reset(randomUUID(), workerInstanceId, reason)
    this.router.fanout(envelopes)
  }

  applyFrame(frame: NativeWorkerRawEventFrame): RuntimeEventEnvelope[] {
    const envelopes = this.ingestFrame(frame)
    this.publishPatches(envelopes)
    return envelopes
  }

  ingestFrame(frame: NativeWorkerRawEventFrame): RuntimeEventEnvelope[] {
    const runId = typeof frame.runId === 'string' ? frame.runId : ''
    const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : ''
    if (!runId || !sessionId) return []

    let events
    try {
      events = decodeAgentStreamEnvelope(frame.bytes).events
    } catch (error) {
      console.warn(
        '[runtime-projection] failed to decode stream frame',
        error instanceof Error ? error.message : String(error)
      )
      return []
    }

    const pending = this.expireTimers.get(runId)
    if (pending) {
      clearTimeout(pending)
      this.expireTimers.delete(runId)
    }

    const envelopes = this.engine.applyStreamEnvelope({
      runId,
      sessionId,
      seq: typeof frame.seq === 'number' ? frame.seq : 0,
      events
    })
    this.compareShadow(runId)

    if (frame.hasTerminalEvent === true) {
      this.expireTimers.set(
        runId,
        setTimeout(() => {
          this.expireTimers.delete(runId)
          this.publishPatches(this.engine.commitRun(sessionId, runId))
        }, RUNTIME_OVERLAY_RETENTION_MS)
      )
    }

    return envelopes
  }

  publishPatches(envelopes: RuntimeEventEnvelope[]): void {
    this.router.fanout(envelopes)
  }

  private compareShadow(runId: string): void {
    const legacy = getRuntimeRegistry()
      .getRunSnapshots()
      .find((run) => run.runId === runId)
    const next = this.engine.snapshot.runs.find((run) => run.runId === runId)
    if (!legacy || !next) return
    const legacyRunning = legacy.status === 'running'
    const nextRunning = next.status === 'running' || next.status === 'queued'
    if (legacyRunning !== nextRunning) {
      console.warn('[runtime-projection][shadow] run status mismatch', {
        runId,
        legacy: legacy.status,
        next: next.status
      })
    }
  }
}

let host: RuntimeProjectionHost | null = null

export function getRuntimeProjectionHost(): RuntimeProjectionHost {
  if (!host) host = new RuntimeProjectionHost()
  return host
}
