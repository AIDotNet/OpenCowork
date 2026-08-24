import type { NativeWorkerClient, NativeWorkerProbe, WorkerEventListener } from './native-worker-client.js'

/** The subset of NativeWorkerClient that OpenCoworkWorkerRuntime actually uses. */
export type WorkerBackendClient = Pick<
  NativeWorkerClient,
  | 'on'
  | 'request'
  | 'ackEvent'
  | 'replayEvents'
  | 'ensureStarted'
  | 'probe'
  | 'stop'
  | 'isRunning'
>

export type { NativeWorkerProbe, WorkerEventListener }
