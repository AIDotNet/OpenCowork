import type { JsonObject } from '../../../shared/runtime-contracts/generated/contracts'
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
    lastAckAt: consumer.lastAckAt,
    lastError: consumer.lastError
  }
}
