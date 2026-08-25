/**
 * Host-facing contract for the Agent Runtime worker.
 *
 * One implementation serves it: the .NET Native AOT worker, supervised as a child
 * process. Every consumer above the transport (`native-agent-runtime.ts`,
 * `sidecar-manager.ts`, the runtime projection/journal, the CLI adapter) is
 * written against this interface only, so changing how the worker is reached never
 * reaches past `getNativeWorker()`.
 *
 * Node-only module (uses Buffer); do not import from renderer code.
 */

/**
 * Which implementation is serving a runtime slot. Retained as a single-value union
 * rather than dropped so diagnostics and the renderer's worker-state channel keep a
 * stable shape.
 */
export type WorkerRuntimeBackend = 'csharp'

/**
 * Which runtime slot a client occupies. This is deliberately independent of
 * `WorkerRuntimeBackend`: the renderer's worker-state channel keys off `native`
 * meaning "the main agent runtime", regardless of which backend implements it.
 */
export type WorkerRuntimeSlot = 'native' | 'codegraph'

export type WorkerRuntimeState = 'stopped' | 'starting' | 'ready' | 'restarting' | 'fatal'

export type WorkerRuntimeStartupPhase =
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

export type WorkerRuntimeTransport = 'http'

export type WorkerRuntimeStateSnapshot = {
  id: WorkerRuntimeSlot
  backend: WorkerRuntimeBackend
  state: WorkerRuntimeState
  phase: WorkerRuntimeStartupPhase
  pid: number | null
  restartAttempts: number
  lastError: string | null
  workerPath: string | null
  lastStartAttemptAt: number | null
  readyAt: number | null
}

export type WorkerRuntimeDiagnosticsSnapshot = WorkerRuntimeStateSnapshot & {
  transport: WorkerRuntimeTransport
  endpoint: string | null
  eventEndpoint: string | null
  eventConnected: boolean
  lastFrameReceivedAt: number | null
  lastAgentStreamAt: number | null
  lastAgentStreamRunId: string | null
  stderrTail: string[]
  pendingRequests: Array<{ method: string; elapsedMs: number }>
  lastExit: {
    code: number | null
    signal: NodeJS.Signals | null
    at: number
  } | null
  lastDisconnect: {
    at: number
    error: string
    pendingRequests: Array<{ method: string; elapsedMs: number }>
  } | null
  binaryCandidates: Array<{
    path: string
    exists: boolean
    ready: boolean
    missingDependencies: string[]
  }>
  logDirectory: string
}

/**
 * Routing metadata read off an `agent/stream` frame without decoding its body.
 * Structurally identical to `NativeMessagePackRoute` so the fast-path reader in
 * main and the Node worker's emitter produce the same shape.
 */
export interface WorkerStreamRoute {
  event: string
  runId?: string
  sessionId?: string
  seq?: number
  v?: number
  hasTerminalEvent?: boolean
  live?: boolean
}

/**
 * An `agent/stream` frame handed to consumers already parsed. `envelope` is the
 * frame the worker sent; `byteLength` is its size on the wire, kept for
 * diagnostics rather than for re-encoding.
 */
export interface WorkerRawEventFrame extends WorkerStreamRoute {
  envelope: unknown
  byteLength: number
}

/** Explicit request deadline opt-out. Omitted/null timeouts use the safe default. */
export const WORKER_RUNTIME_NO_TIMEOUT = 0

export interface WorkerRuntimeClient {
  /** True once the runtime is connected and serving requests. */
  readonly isRunning: boolean
  /** OS pid of the child worker, or of the host process for the in-process runtime. */
  readonly processId: number | null
  /**
   * Loopback endpoint and bearer token for callers that talk to the worker
   * directly instead of relaying through this client — the renderer does this so
   * its commands and queries skip a process hop. Null while the worker is down.
   */
  readonly connection: { baseUrl: string; token: string } | null

  ensureStarted(): Promise<void>
  stop(): Promise<void>

  request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs?: number | null,
    signal?: AbortSignal
  ): Promise<T>

  onEvent(eventName: string, listener: (params: unknown) => void): () => void
  onRawEvent(eventName: string, listener: (frame: WorkerRawEventFrame) => void): () => void
  /** Fired after the supervisor transparently replaced the runtime instance. */
  onReconnect(listener: () => void): () => void
  /** Fired when the runtime goes down unexpectedly; owned runs can never resume. */
  onDisconnect(listener: () => void): () => void
  onEventReconnect(listener: () => void): () => void
  onStateChange(listener: (snapshot: WorkerRuntimeStateSnapshot) => void): () => void

  getStateSnapshot(): WorkerRuntimeStateSnapshot
  getDiagnosticsSnapshot(): WorkerRuntimeDiagnosticsSnapshot
}
