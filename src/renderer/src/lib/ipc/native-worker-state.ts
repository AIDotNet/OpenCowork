import { ipcClient } from './ipc-client'

// Mirrors NativeWorkerStateSnapshot in src/main/lib/native-worker.ts.
export type NativeWorkerState = 'stopped' | 'starting' | 'ready' | 'restarting' | 'fatal'

export type NativeWorkerStateSnapshot = {
  id: 'native' | 'codegraph'
  state: NativeWorkerState
  pid: number | null
  restartAttempts: number
  lastError: string | null
}

type Listener = (snapshot: NativeWorkerStateSnapshot) => void

// Before the first push/pull resolves, assume ready: the worker is eagerly
// started at boot and pessimistic gating would delay first-turn timeouts.
let current: NativeWorkerStateSnapshot = {
  id: 'native',
  state: 'ready',
  pid: null,
  restartAttempts: 0,
  lastError: null
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
    pid: typeof record.pid === 'number' ? record.pid : null,
    restartAttempts: typeof record.restartAttempts === 'number' ? record.restartAttempts : 0,
    lastError: typeof record.lastError === 'string' ? record.lastError : null
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
