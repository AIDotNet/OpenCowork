import type { JsonObject } from '../../../shared/runtime-contracts/generated/contracts'
import { getUnmappedStreamEventCounts } from '../../../shared/runtime-projection/reducer'
import { getRuntimeProjectionHost } from './runtime-projection'
import { getWorkerEventConsumer } from './worker-event-consumer-host'

export function getRuntimeDiagnosticsDetails(): JsonObject {
  const host = getRuntimeProjectionHost()
  const consumer = getWorkerEventConsumer().getDiagnostics()
  return {
    gatewayEpoch: host.gatewayEpoch,
    workerInstanceId: host.workerInstanceId,
    runCount: host.snapshot.runs.length,
    projectionRevision: host.snapshot.projectionRevision,
    rolloutMode: 'shadow',
    pendingAckCount: consumer.pendingAckCount,
    pendingAckBytes: consumer.pendingAckBytes,
    ackedCount: consumer.ackedCount,
    droppedUiFanouts: consumer.droppedUiFanouts,
    withheldBatches: consumer.withheldBatches,
    forcedAcks: consumer.forcedAcks,
    lastAckAt: consumer.lastAckAt,
    lastError: consumer.lastError,
    // Stream event types the projection does not model yet. The legacy render
    // path still handles these, so this is the measured size of what stands
    // between the projection and retiring that path.
    unmappedStreamEvents: getUnmappedStreamEventCounts()
  }
}
