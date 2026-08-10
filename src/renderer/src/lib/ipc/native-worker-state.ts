import { ipcClient } from './ipc-client'

// Mirrors NativeWorkerStateSnapshot in src/main/lib/native-worker.ts.
export type NativeWorkerState = 'stopped' | 'starting' | 'ready' | 'restarting' | 'fatal'
export type NativeWorkerStartupPhase =
  | 'idle'
  | 'resolving-binary'
  | 'spawning'
  | 'connecting-ipc'
  | 'handshaking'
  | 'verifying-routes'
  | 'ready'
  | 'restart-backoff'
  | 'stopping'
  | 'fatal'

export type NativeWorkerStateSnapshot = {
  id: 'native' | 'codegraph'
  state: NativeWorkerState
  phase: NativeWorkerStartupPhase
  pid: number | null
  restartAttempts: number
  lastError: string | null
  workerPath: string | null
  lastStartAttemptAt: number | null
  readyAt: number | null
}

type Listener = (snapshot: NativeWorkerStateSnapshot) => void

// The Worker is required and eagerly started. Until the pull/push snapshot
// proves readiness, retain a starting state so a first turn never mistakes an
// unresolved boot for a healthy runtime.
let current: NativeWorkerStateSnapshot = {
  id: 'native',
  state: 'starting',
  phase: 'resolving-binary',
  pid: null,
  restartAttempts: 0,
  lastError: null,
  workerPath: null,
  lastStartAttemptAt: null,
  readyAt: null
}
const listeners = new Set<Listener>()
let installed = false

function applySnapshot(snapshot: unknown): void {
  if (!snapshot || typeof snapshot !== 'object') return
  const record = snapshot as Partial<NativeWorkerStateSnapshot>
  if (record.id !== 'native') return
  if (typeof record.state !== 'string') return
  current = {
    id: 'native',
    state: record.state as NativeWorkerState,
    phase:
      typeof record.phase === 'string'
        ? (record.phase as NativeWorkerStartupPhase)
        : record.state === 'ready'
          ? 'ready'
          : 'idle',
    pid: typeof record.pid === 'number' ? record.pid : null,
    restartAttempts: typeof record.restartAttempts === 'number' ? record.restartAttempts : 0,
    lastError: typeof record.lastError === 'string' ? record.lastError : null,
    workerPath: typeof record.workerPath === 'string' ? record.workerPath : null,
    lastStartAttemptAt:
      typeof record.lastStartAttemptAt === 'number' ? record.lastStartAttemptAt : null,
    readyAt: typeof record.readyAt === 'number' ? record.readyAt : null
  }
  for (const listener of listeners) {
    try {
      listener(current)
    } catch (error) {
      console.warn('[NativeWorkerState] listener failed:', error)
    }
  }
}

function ensureInstalled(): void {
  if (installed) return
  installed = true
  ipcClient.on('sidecar:worker-state', applySnapshot)
  void ipcClient
    .invoke('sidecar:worker-state')
    .then(applySnapshot)
    .catch(() => {
      // Main not ready yet; the push channel will correct us.
    })
}

export function getNativeWorkerState(): NativeWorkerStateSnapshot {
  ensureInstalled()
  return current
}

export function subscribeNativeWorkerState(listener: Listener): () => void {
  ensureInstalled()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
