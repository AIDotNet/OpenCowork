import { getNativeWorker } from '../../lib/native-worker'
import { getRuntimeRegistry } from '../runtime-registry'
import { getRuntimeProjectionHost } from './runtime-projection'
import { DESKTOP_EVENT_CONSUMER_ID, WorkerEventConsumer } from './worker-event-consumer'

let consumer: WorkerEventConsumer | null = null

export function getWorkerEventConsumer(): WorkerEventConsumer {
  if (!consumer) {
    consumer = new WorkerEventConsumer({
      recordFrame: (frame) => getRuntimeRegistry().recordFrame(frame),
      ingestFrame: (frame) => getRuntimeProjectionHost().ingestFrame(frame),
      publishPatches: (envelopes) => getRuntimeProjectionHost().publishPatches(envelopes),
      ack: (runId, throughSeq) => {
        void getNativeWorker()
          .request(
            'events/ack',
            { consumerId: DESKTOP_EVENT_CONSUMER_ID, jobId: runId, throughSeq },
            10_000
          )
          .catch((error: unknown) => {
            console.warn('[worker-event-consumer] durable event ack failed', {
              runId,
              throughSeq,
              error: error instanceof Error ? error.message : String(error)
            })
          })
      },
      isRunning: () => getNativeWorker().isRunning,
      request: (method, params, timeoutMs) => getNativeWorker().request(method, params, timeoutMs)
    })
  }
  return consumer
}
