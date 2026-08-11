import { app, powerMonitor } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as net from 'net'
import * as path from 'path'
import { decode, encode } from '@msgpack/msgpack'
import { readNativeMessagePackRoute, type NativeMessagePackRoute } from './messagepack-route-reader'
import { getCrashLogDir, writeCrashLog } from '../crash-logger'
import {
  WORKER_PROTOCOL_VERSION,
  type WorkerHelloResult
} from '../../shared/worker-contracts/generated/contracts'
// Resolved lazily at spawn time (function-level cycle — safe): tells the CodeGraph
// worker where to load its bundled, updated, or dev tree-sitter grammars from.
import { resolveCodeGraphGrammarsDir } from './codegraph-assets'

const NATIVE_WORKER_STDERR_TAIL_LINES = 40
const NATIVE_WORKER_STDERR_MAX_LINE = 2000

const DEFAULT_NATIVE_WORKER_TIMEOUT_MS = 60_000
/** Explicit request deadline opt-out. Omitted/null timeouts still use the safe default. */
export const NATIVE_WORKER_NO_TIMEOUT = 0
const DEFAULT_NATIVE_WORKER_SLOW_REQUEST_MS = 750
const NATIVE_WORKER_CONNECT_TIMEOUT_MS = 10_000
const NATIVE_WORKER_CONNECT_RETRY_MS = 35
const NATIVE_WORKER_RESTART_BASE_MS = 300
const NATIVE_WORKER_RESTART_MAX_MS = 30_000
// Consecutive failed supervised restarts before the manager stops burning CPU
// and surfaces a fatal state; an explicit ensureStarted() re-arms recovery.
const NATIVE_WORKER_RESTART_FATAL_ATTEMPTS = 5
const NATIVE_WORKER_HEARTBEAT_INTERVAL_MS = 15_000
const NATIVE_WORKER_HEARTBEAT_TIMEOUT_MS = 5_000
const NATIVE_WORKER_HEARTBEAT_MAX_MISSES = 2
const NATIVE_WORKER_KILL_ESCALATION_MS = 3_000
const FRAME_HEADER_BYTES = 4
const MAX_FRAME_BYTES = 256 * 1024 * 1024

// Read-only methods that are safe to transparently replay on the fresh worker
// after a crash instead of failing the caller. Mutations never replay: the dead
// worker may or may not have committed them.
const IDEMPOTENT_METHOD_PATTERN = new RegExp(
  '^(?:' +
    'worker/(?:ping|hello|routes|memory)|' +
    'jobs/(?:submit|status|result|list)|' +
    'events/(?:subscribe|ack|replay)|' +
    'settings/(?:read|get)|' +
    'file/read|' +
    'db/[a-z0-9-]+(?:-list|-get|-status|-index|-find|-search)(?:-[a-z0-9-]+)?' +
    ')$'
)
const REQUIRED_NATIVE_WORKER_METHODS = [
  'jobs/submit',
  'jobs/status',
  'jobs/result',
  'jobs/cancel',
  'events/subscribe',
  'events/ack',
  'events/replay',
  'settings/read',
  'settings/get',
  'settings/set',
  'settings/delete',
  'db/sub-agent-history-index',
  'db/sub-agent-history-list',
  'souls/builtin-list',
  'sync/files-capture',
  'sync/files-apply',
  'sync/files-delete'
]

// Per-worker configuration. The two supervised sidecars (the eager main worker
// and the opt-in CodeGraph worker) share all transport/lifecycle machinery and
// differ only in the values below. NATIVE_CONFIG reproduces the historical
// hard-coded main-worker behavior exactly, so getNativeWorker() is byte-identical
// to the pre-parameterization manager.
export interface NativeWorkerConfig {
  /** Stable id used in diagnostics; distinguishes the two worker instances. */
  id: 'native' | 'codegraph'
  /** Resolves the worker executable path (name + readiness gate) or null when absent. */
  resolveBinaryPath: () => string | null
  /** Error thrown by start() when the binary cannot be resolved. */
  missingBinaryMessage: string
  /** Boot gate: routes that must exist after connect. Empty ⇒ never gate boot. */
  requiredMethods: string[]
  /** Heartbeat cadence — CodeGraph runs looser because it is isolated + compute-heavy. */
  heartbeatIntervalMs: number
  heartbeatTimeoutMs: number
  heartbeatMaxMisses: number
  /** Creates the per-spawn IPC endpoint (unix socket path / Windows named pipe). */
  createEndpoint: () => string
  /** Builds the child-process environment. */
  createEnv: () => NodeJS.ProcessEnv
  /** Removes orphaned endpoint files left by previous, now-dead main processes. */
  sweepStaleEndpoints: () => void
}

const NATIVE_CONFIG: NativeWorkerConfig = {
  id: 'native',
  resolveBinaryPath: resolveNativeWorkerPath,
  missingBinaryMessage:
    'Native worker is missing. Run `npm run native:publish` before starting OpenCowork.',
  requiredMethods: REQUIRED_NATIVE_WORKER_METHODS,
  heartbeatIntervalMs: NATIVE_WORKER_HEARTBEAT_INTERVAL_MS,
  heartbeatTimeoutMs: NATIVE_WORKER_HEARTBEAT_TIMEOUT_MS,
  heartbeatMaxMisses: NATIVE_WORKER_HEARTBEAT_MAX_MISSES,
  createEndpoint: createNativeWorkerEndpoint,
  createEnv: createNativeWorkerEnv,
  sweepStaleEndpoints: sweepStaleNativeWorkerEndpoints
}

// The opt-in CodeGraph sidecar: never gates boot (requiredMethods empty), runs a
// looser heartbeat so a heavy index cannot trip a strict ping, and uses a distinct
// endpoint prefix + sweep so it never collides with the main worker's sockets.
const CODEGRAPH_CONFIG: NativeWorkerConfig = {
  id: 'codegraph',
  resolveBinaryPath: resolveCodeGraphWorkerPath,
  missingBinaryMessage:
    'CodeGraph worker is missing. Run `npm run native:publish` before enabling CodeGraph.',
  requiredMethods: [],
  heartbeatIntervalMs: 30_000,
  heartbeatTimeoutMs: 10_000,
  heartbeatMaxMisses: 3,
  createEndpoint: createCodeGraphWorkerEndpoint,
  createEnv: createCodeGraphWorkerEnv,
  sweepStaleEndpoints: sweepStaleCodeGraphWorkerEndpoints
}

let nativeWorkerStartupBarrier: Promise<void> | null = null
let nativeWorkerShutdownLatched = false

/**
 * Terminal latch for app quit. Unlike stop() — whose supervision disable is
 * deliberately re-armed by the next ensureStarted() (macOS window-all-closed
 * then reopen) — this permanently blocks new spawns, so a straggler request
 * during before-quit cannot respawn a worker that nothing will ever kill.
 */
export function latchNativeWorkerShutdown(): void {
  nativeWorkerShutdownLatched = true
}

/**
 * Delay the first worker spawn until process-wide startup prerequisites (notably
 * the macOS login-shell environment) settle. Requests may be registered and
 * queued immediately, allowing the BrowserWindow to load without spawning the
 * worker with a stale PATH.
 */
export function setNativeWorkerStartupBarrier(barrier: Promise<void>): void {
  const guarded = barrier.catch((error) => {
    console.warn(
      '[NativeWorker] startup barrier failed; continuing with current environment:',
      error
    )
  })
  const tracked = guarded.finally(() => {
    if (nativeWorkerStartupBarrier === tracked) {
      nativeWorkerStartupBarrier = null
    }
  })
  nativeWorkerStartupBarrier = tracked
}

type PendingRequest = {
  method: string
  params: unknown
  timeoutMs: number | null
  signal?: AbortSignal
  startedAt: number
  payloadBytes: number
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
  removeAbortListener?: () => void
  /** Read-only request eligible for one transparent replay after a worker restart. */
  replayable: boolean
  replayed: boolean
}

type NativeWorkerResponse = {
  id?: number
  result?: unknown
  error?: string
}

type NativeWorkerHelloResult = Partial<WorkerHelloResult>

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

export type NativeWorkerDiagnosticsSnapshot = NativeWorkerStateSnapshot & {
  transport: 'named-pipe' | 'unix-domain-socket'
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

type NativeWorkerEventFrame = {
  event?: string
  params?: unknown
}

type NativeWorkerRoutesResult = {
  methods?: unknown
  routes?: unknown
}

type NativeWorkerRouteDescriptor = {
  method: string
  executionMode: string
  resultMode: string
  lanePolicy?: string | null
}

type NativeJobSubmission = {
  accepted?: boolean
  duplicate?: boolean
  jobId?: string
  runId?: string
  state?: string
  error?: string
  errorCode?: string
}

type NativeJobStatus = {
  found?: boolean
  jobId?: string
  state?: string
  result?: unknown
  error?: string
  errorCode?: string
}

export type NativeWorkerRawEventFrame = NativeMessagePackRoute & {
  bytes: Buffer
  byteLength: number
}

class NativeWorkerManager {
  private child: ChildProcess | null = null
  private socket: net.Socket | null = null
  private eventSocket: net.Socket | null = null
  private endpoint: string | null = null
  private eventEndpoint: string | null = null
  private events = new EventEmitter()
  private rawEvents = new EventEmitter()
  private pending = new Map<number, PendingRequest>()
  private replayQueue: PendingRequest[] = []
  private readChunks: Buffer[] = []
  private readBufferedBytes = 0
  private pendingFrameLength = -1
  private eventReadChunks: Buffer[] = []
  private eventReadBufferedBytes = 0
  private eventPendingFrameLength = -1
  private eventReconnectTimer: ReturnType<typeof setTimeout> | null = null
  private nextId = 1
  private startPromise: Promise<void> | null = null
  private stopping = false
  private autoRestartDisabled = false
  private hasStartedOnce = false
  private restartAttempts = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatMisses = 0
  private lastFrameReceivedAt = 0
  private lastAgentStreamAt = 0
  private lastAgentStreamRunId: string | null = null
  private state: NativeWorkerState = 'stopped'
  private phase: NativeWorkerStartupPhase = 'idle'
  private lastError: string | null = null
  private workerPath: string | null = null
  private lastStartAttemptAt = 0
  private readyAt = 0
  private lastExit: NativeWorkerDiagnosticsSnapshot['lastExit'] = null
  private lastDisconnect: NativeWorkerDiagnosticsSnapshot['lastDisconnect'] = null
  private lifecycle = new EventEmitter()
  private stderrTail: string[] = []
  private jobRoutes = new Map<string, NativeWorkerRouteDescriptor>()

  constructor(private config: NativeWorkerConfig = NATIVE_CONFIG) {
    // powerMonitor is only usable once the app is ready; the manager may be
    // constructed earlier during module init.
    void app.whenReady().then(() => this.installPowerMonitor())
  }

  get isRunning(): boolean {
    return (
      this.child !== null &&
      !this.child.killed &&
      this.child.exitCode === null &&
      this.socket !== null &&
      !this.socket.destroyed
    )
  }

  get processId(): number | null {
    return this.child?.pid ?? null
  }

  async ensureStarted(): Promise<void> {
    if (this.isRunning) return
    if (nativeWorkerShutdownLatched) {
      throw new Error('Native worker is shutting down')
    }
    const startupBarrier = nativeWorkerStartupBarrier
    if (startupBarrier) await startupBarrier
    if (this.isRunning) return
    // A caller explicitly asking for the worker re-arms supervision even if a
    // prior stop() disabled it (e.g. macOS window-all-closed then reopen).
    this.autoRestartDisabled = false
    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = null
      })
    }
    await this.startPromise
  }

  onEvent(eventName: string, listener: (params: unknown) => void): () => void {
    this.events.on(eventName, listener)
    return () => {
      this.events.off(eventName, listener)
    }
  }

  onRawEvent(eventName: string, listener: (frame: NativeWorkerRawEventFrame) => void): () => void {
    this.rawEvents.on(eventName, listener)
    return () => {
      this.rawEvents.off(eventName, listener)
    }
  }

  // Fired after the supervisor transparently respawns and reconnects to a fresh
  // worker process. Higher layers use this to re-run their own handshake
  // (the new process starts blank — no `initialize`, no active runs).
  onReconnect(listener: () => void): () => void {
    this.lifecycle.on('reconnected', listener)
    return () => {
      this.lifecycle.off('reconnected', listener)
    }
  }

  // Fired when the worker goes down unexpectedly (crash, IPC drop). Any runs the
  // dead process owned can never resume, so listeners use this to fail them
  // instead of leaving the renderer hung on a stream that stopped mid-flight.
  onDisconnect(listener: () => void): () => void {
    this.lifecycle.on('disconnected', listener)
    return () => {
      this.lifecycle.off('disconnected', listener)
    }
  }

  onEventReconnect(listener: () => void): () => void {
    this.lifecycle.on('event-reconnected', listener)
    return () => {
      this.lifecycle.off('event-reconnected', listener)
    }
  }

  onStateChange(listener: (snapshot: NativeWorkerStateSnapshot) => void): () => void {
    this.lifecycle.on('state', listener)
    return () => {
      this.lifecycle.off('state', listener)
    }
  }

  getStateSnapshot(): NativeWorkerStateSnapshot {
    return {
      id: this.config.id,
      state: this.state,
      phase: this.phase,
      pid: this.processId,
      restartAttempts: this.restartAttempts,
      lastError: this.lastError,
      workerPath: this.workerPath,
      lastStartAttemptAt: this.lastStartAttemptAt || null,
      readyAt: this.readyAt || null
    }
  }

  getDiagnosticsSnapshot(): NativeWorkerDiagnosticsSnapshot {
    const now = Date.now()
    return {
      ...this.getStateSnapshot(),
      transport: process.platform === 'win32' ? 'named-pipe' : 'unix-domain-socket',
      endpoint: this.endpoint,
      eventEndpoint: this.eventEndpoint,
      eventConnected: Boolean(this.eventSocket && !this.eventSocket.destroyed),
      lastFrameReceivedAt: this.lastFrameReceivedAt || null,
      lastAgentStreamAt: this.lastAgentStreamAt || null,
      lastAgentStreamRunId: this.lastAgentStreamRunId,
      stderrTail: [...this.stderrTail],
      pendingRequests: Array.from(this.pending.values()).map((pending) => ({
        method: pending.method,
        elapsedMs: Math.max(0, now - pending.startedAt)
      })),
      lastExit: this.lastExit,
      lastDisconnect: this.lastDisconnect,
      binaryCandidates: this.config.id === 'native' ? getNativeWorkerCandidateDiagnostics() : [],
      logDirectory: getCrashLogDir()
    }
  }

  private publishState(): void {
    this.lifecycle.emit('state', this.getStateSnapshot())
  }

  private setState(next: NativeWorkerState, errorMessage?: string | null): void {
    const nextError = errorMessage === undefined ? this.lastError : errorMessage
    if (this.state === next && this.lastError === nextError) return
    this.state = next
    this.lastError = nextError
    this.publishState()
  }

  private setPhase(next: NativeWorkerStartupPhase): void {
    if (this.phase === next) return
    this.phase = next
    this.publishState()
  }

  // Unrecoverable without user action (stale binary, protocol mismatch, restart
  // budget exhausted). Supervision stops; an explicit ensureStarted() re-arms it.
  private enterFatal(message: string): void {
    this.autoRestartDisabled = true
    this.clearSupervisedRestart()
    this.failReplayQueue(new Error(message))
    this.setPhase('fatal')
    this.setState('fatal', message)
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs?: number | null,
    signal?: AbortSignal
  ): Promise<T> {
    // Renderer requests arrive over MessagePack, which encodes an omitted
    // timeout as nil -> null, bypassing a default parameter; setTimeout(cb, null)
    // would fire at ~1ms and fail the request before the worker can answer.
    const effectiveTimeoutMs =
      timeoutMs === NATIVE_WORKER_NO_TIMEOUT
        ? null
        : typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
          ? timeoutMs
          : DEFAULT_NATIVE_WORKER_TIMEOUT_MS
    if (signal?.aborted) {
      throw createAbortError(method)
    }

    await this.ensureStarted()
    if (signal?.aborted) {
      throw createAbortError(method)
    }
    if (!this.socket || !this.isRunning) {
      throw new Error('Native worker is not running')
    }

    const jobRoute = this.jobRoutes.get(method)
    if (jobRoute) {
      return await this.requestViaJob<T>(method, params ?? {}, jobRoute, timeoutMs, signal)
    }

    return await new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        method,
        params: params ?? {},
        timeoutMs: effectiveTimeoutMs,
        signal,
        startedAt: Date.now(),
        payloadBytes: 0,
        resolve: (value) => resolve(value as T),
        reject,
        replayable: IDEMPOTENT_METHOD_PATTERN.test(method),
        replayed: false
      }
      this.dispatchPending(pending)
    })
  }

  private async requestViaJob<T>(
    method: string,
    params: unknown,
    route: NativeWorkerRouteDescriptor,
    timeoutMs: number | null | undefined,
    signal?: AbortSignal
  ): Promise<T> {
    const source = isRecord(params) ? params : {}
    const requestedRunId =
      method === 'agent/run' && typeof source.runId === 'string' && source.runId.trim()
        ? source.runId.trim()
        : method === 'agent/run'
          ? randomUUID()
          : null
    const jobId = requestedRunId ?? randomUUID()
    const jobParams = requestedRunId ? { ...source, runId: requestedRunId } : params
    let submission: NativeJobSubmission
    try {
      submission = await this.request<NativeJobSubmission>(
        'jobs/submit',
        {
          method,
          params: jobParams,
          jobId,
          idempotencyKey: jobId
        },
        30_000,
        signal
      )
    } catch (error) {
      // The SQLite commit can win a race with local AbortSignal delivery. We know
      // the deterministic Job id even when the submit response was cancelled, so
      // make a best-effort cancellation instead of leaving an orphaned Job.
      if (signal?.aborted) {
        await this.request('jobs/cancel', { jobId }, 10_000).catch(() => {})
      }
      throw error
    }
    if (submission.accepted !== true || typeof submission.jobId !== 'string') {
      throw new Error(
        submission.error ||
          `${submission.errorCode ?? 'queue_unavailable'}: Worker did not commit the Job`
      )
    }

    if (signal?.aborted) {
      await this.request('jobs/cancel', { jobId: submission.jobId }, 10_000).catch(() => {})
      throw createAbortError(method)
    }

    if (route.resultMode === 'accepted') {
      return {
        started: true,
        runId: submission.runId || requestedRunId || submission.jobId,
        jobId: submission.jobId,
        state: submission.state || 'queued',
        duplicate: submission.duplicate === true
      } as unknown as T
    }

    const effectiveTimeoutMs =
      timeoutMs === NATIVE_WORKER_NO_TIMEOUT
        ? null
        : typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
          ? timeoutMs
          : DEFAULT_NATIVE_WORKER_TIMEOUT_MS
    const deadline = effectiveTimeoutMs === null ? null : Date.now() + effectiveTimeoutMs
    let pollDelayMs = 100
    try {
      while (true) {
        if (signal?.aborted) throw createAbortError(method)
        if (deadline !== null && Date.now() >= deadline) {
          throw new Error(
            `Background Job wait timed out: ${method} (jobId=${submission.jobId}); ` +
              'the Job remains queued/running and can be queried with jobs/result.'
          )
        }

        const status = await this.request<NativeJobStatus>(
          'jobs/result',
          { jobId: submission.jobId },
          10_000,
          signal
        )
        if (status.state === 'succeeded') return status.result as T
        if (status.state === 'failed' || status.state === 'cancelled') {
          throw new Error(
            `${status.errorCode ?? status.state}: ${status.error ?? `Background Job ${status.state}`}`
          )
        }
        await waitForNativeJobPoll(signal, pollDelayMs)
        pollDelayMs = Math.min(1_000, Math.ceil(pollDelayMs * 1.5))
      }
    } catch (error) {
      if (signal?.aborted) {
        await this.request('jobs/cancel', { jobId: submission.jobId }, 10_000).catch(() => {})
        throw createAbortError(method)
      }
      throw error
    }
  }

  // Encodes and writes one request onto the CURRENT socket. Called for fresh
  // requests and again (with a fresh id) when a queued idempotent request is
  // replayed onto the respawned worker.
  private dispatchPending(pending: PendingRequest): void {
    const socket = this.socket
    if (!socket || !this.isRunning) {
      pending.reject(new Error('Native worker is not running'))
      return
    }

    const id = this.nextId++
    const payload = encode({ id, method: pending.method, params: pending.params })
    const frame = createFrame(payload)
    pending.startedAt = Date.now()
    pending.payloadBytes = payload.byteLength

    logNativeWorkerDebug('request start', {
      id,
      method: pending.method,
      payloadBytes: pending.payloadBytes,
      pending: this.pending.size + 1,
      timeoutMs: pending.timeoutMs ?? 'none',
      replayed: pending.replayed
    })

    pending.timer =
      pending.timeoutMs === null
        ? undefined
        : setTimeout(() => {
            if (!this.pending.delete(id)) return
            pending.removeAbortListener?.()
            pending.removeAbortListener = undefined
            this.sendCancelRequest(id)
            console.warn('[NativeWorker] request timeout', {
              id,
              method: pending.method,
              elapsedMs: Date.now() - pending.startedAt,
              payloadBytes: pending.payloadBytes,
              pending: this.pending.size
            })
            pending.reject(new Error(`Native worker request timed out: ${pending.method}`))
          }, pending.timeoutMs)

    if (pending.signal) {
      const signal = pending.signal
      const onAbort = (): void => {
        if (!this.pending.delete(id)) return
        if (pending.timer) clearTimeout(pending.timer)
        pending.removeAbortListener = undefined
        this.sendCancelRequest(id)
        pending.reject(createAbortError(pending.method))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      pending.removeAbortListener = () => signal.removeEventListener('abort', onAbort)
    }

    this.pending.set(id, pending)

    try {
      socket.write(frame, (error) => {
        if (!error) return
        this.rejectPendingRequest(id, error)
      })
    } catch (error) {
      this.rejectPendingRequest(id, asError(error))
    }
  }

  async stop(): Promise<void> {
    this.autoRestartDisabled = true
    this.stopping = true
    this.setPhase('stopping')
    this.clearSupervisedRestart()
    this.stopHeartbeat()
    this.failReplayQueue(new Error('Native worker stopped'))
    this.closeWorker(new Error('Native worker stopped'))
    this.stopping = false
    this.setPhase('idle')
  }

  private async start(): Promise<void> {
    this.lastStartAttemptAt = Date.now()
    this.readyAt = 0
    this.setPhase('resolving-binary')
    this.setState(this.hasStartedOnce ? 'restarting' : 'starting')
    const workerPath = this.config.resolveBinaryPath()
    if (!workerPath) {
      const resolutionDetails =
        this.config.id === 'native' ? formatNativeWorkerCandidateFailure() : ''
      const message = [this.config.missingBinaryMessage, resolutionDetails]
        .filter(Boolean)
        .join(' ')
      this.enterFatal(message)
      throw new Error(message)
    }
    this.workerPath = workerPath

    this.config.sweepStaleEndpoints()
    const endpoint = this.config.createEndpoint()
    const eventEndpoint = this.config.createEndpoint()
    cleanupNativeWorkerEndpoint(endpoint)
    cleanupNativeWorkerEndpoint(eventEndpoint)
    const childEnv = this.config.createEnv()
    console.log('[NativeWorker] starting', {
      workerPath,
      transport: process.platform === 'win32' ? 'named-pipe' : 'unix-domain-socket',
      debug: isNativeWorkerDebugEnabled(),
      slowRequestMs: getNativeWorkerSlowRequestMs()
    })

    this.setPhase('spawning')
    const hostId = this.config.id === 'native' ? 'desktop' : 'desktop-codegraph'
    const child = spawn(
      workerPath,
      ['--control-ipc', endpoint, '--event-ipc', eventEndpoint, '--host-id', hostId],
      {
        cwd: path.dirname(workerPath),
        env: childEnv,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      }
    )

    this.child = child
    this.endpoint = endpoint
    this.eventEndpoint = eventEndpoint
    this.stderrTail = []
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (!text) return
      console.warn(`[NativeWorker] ${text}`)
      this.captureStderr(text)
    })
    child.on('error', (error) => {
      // A replaced child's late events must not tear down its successor:
      // closeWorker operates on the *current* child/socket, so without this
      // guard a slow-dying old worker would kill the healthy replacement.
      if (this.child !== child) return
      // A spawn/launch failure (e.g. bad binary, blocked by AV) never reaches
      // the exit handler with useful context; persist what we have.
      if (!this.stopping) {
        writeCrashLog('native_worker_spawn_error', {
          workerPath,
          pid: child.pid ?? null,
          error: error.message,
          stderrTail: this.stderrTail.slice(-NATIVE_WORKER_STDERR_TAIL_LINES)
        })
      }
      this.closeWorker(error)
    })
    child.on('exit', (code, signal) => {
      this.lastExit = { code, signal, at: Date.now() }
      const stale = this.child !== child
      // The worker's own diagnostics go to stderr, which is invisible in a
      // packaged app (no console). Persist the exit code + stderr tail so a
      // failure like a trimming/AOT crash or a missing native dep (e_sqlite3,
      // ICU) is diagnosable from ~/.open-cowork/logs instead of opaque.
      // Logged before the stale-child guard: on a spontaneous crash the socket
      // EOF can reach closeWorker first and replace this.child, but the crash
      // is still worth persisting. A stale child that died of our own
      // SIGTERM/SIGKILL, by contrast, died as intended — not a crash.
      const supervisorKill = stale && (signal === 'SIGTERM' || signal === 'SIGKILL')
      if (!this.stopping && (code !== 0 || signal) && !supervisorKill) {
        writeCrashLog('native_worker_exited', {
          code,
          signal,
          workerPath,
          pid: child.pid ?? null,
          stderrTail: this.stderrTail.slice(-NATIVE_WORKER_STDERR_TAIL_LINES)
        })
      }
      if (stale) return
      this.closeWorker(
        new Error(`Native worker exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`)
      )
    })

    try {
      this.setPhase('connecting-ipc')
      this.socket = await connectNativeWorker(endpoint, child)
      this.socket.on('data', (chunk) => this.handleSocketData(chunk))
      this.socket.on('error', (error) => {
        if (!this.stopping) this.closeWorker(error)
      })
      this.socket.on('close', () => {
        if (!this.stopping && this.child) {
          this.closeWorker(new Error('Native worker IPC closed'))
        }
      })

      this.eventSocket = await connectNativeWorker(eventEndpoint, child)
      this.installEventSocket(this.eventSocket)

      this.setPhase('handshaking')
      await this.performHandshake(workerPath)
      this.setPhase('verifying-routes')
      await this.verifyRequiredMethods(workerPath)
      console.log('[NativeWorker] IPC connected', {
        pid: child.pid ?? null,
        workerPath,
        transport: process.platform === 'win32' ? 'named-pipe' : 'unix-domain-socket',
        eventTransport: 'connected'
      })

      const reconnected = this.hasStartedOnce
      this.hasStartedOnce = true
      this.restartAttempts = 0
      this.clearSupervisedRestart()
      this.lastFrameReceivedAt = Date.now()
      this.startHeartbeat()
      this.readyAt = Date.now()
      this.setPhase('ready')
      this.setState('ready', null)
      this.flushReplayQueue()
      if (reconnected) {
        console.log('[NativeWorker] recovered after unexpected exit; re-initializing runtimes')
        this.lifecycle.emit('reconnected')
      }
    } catch (error) {
      const failure = asError(error)
      writeCrashLog('native_worker_start_failed', {
        phase: this.phase,
        workerPath: this.workerPath,
        endpoint: this.endpoint,
        error: failure,
        stderrTail: this.stderrTail.slice(-NATIVE_WORKER_STDERR_TAIL_LINES)
      })
      this.closeWorker(failure)
      if (failure.name === 'WorkerProtocolMismatchError') {
        this.enterFatal(failure.message)
      }
      throw failure
    }
  }

  // Version gate: refuse to serve traffic through a worker whose IPC contract
  // does not match this supervisor build. Failing loudly here beats the subtle
  // field-level corruption a silently mismatched binary produces.
  private async performHandshake(workerPath: string): Promise<void> {
    let hello: NativeWorkerHelloResult
    try {
      hello = await this.request<NativeWorkerHelloResult>('worker/hello', {}, 10_000)
    } catch (error) {
      const message = asError(error).message
      if (/unsupported method/i.test(message)) {
        throw createProtocolMismatchError(
          `Native worker at ${workerPath} predates the handshake protocol.`
        )
      }
      throw error
    }

    if (hello?.protocolVersion !== WORKER_PROTOCOL_VERSION) {
      throw createProtocolMismatchError(
        `Native worker at ${workerPath} speaks protocol ` +
          `${typeof hello?.protocolVersion === 'number' ? `v${hello.protocolVersion}` : '(unreported)'}, ` +
          `supervisor expects v${WORKER_PROTOCOL_VERSION}.`
      )
    }

    logNativeWorkerDebug('handshake ok', {
      workerPath,
      pid: hello.pid ?? null,
      protocolVersion: hello.protocolVersion,
      appVersion: hello.appVersion ?? null
    })
  }

  private async verifyRequiredMethods(workerPath: string): Promise<void> {
    let routes: NativeWorkerRoutesResult
    try {
      routes = await this.request<NativeWorkerRoutesResult>('worker/routes', {}, 10_000)
    } catch (error) {
      throw new Error(
        [
          `Native worker at ${workerPath} does not expose worker/routes.`,
          'The running binary is likely stale; run `npm run native:publish` and restart OpenCowork.',
          `Original error: ${asError(error).message}`
        ].join(' ')
      )
    }

    const methods = new Set(
      Array.isArray(routes.methods)
        ? routes.methods.filter((method): method is string => typeof method === 'string')
        : []
    )
    this.jobRoutes.clear()
    if (Array.isArray(routes.routes)) {
      for (const value of routes.routes) {
        if (
          isRecord(value) &&
          typeof value.method === 'string' &&
          value.executionMode === 'job' &&
          typeof value.resultMode === 'string'
        ) {
          this.jobRoutes.set(value.method, {
            method: value.method,
            executionMode: value.executionMode,
            resultMode: value.resultMode,
            lanePolicy: typeof value.lanePolicy === 'string' ? value.lanePolicy : null
          })
        }
      }
    }
    const missing = this.config.requiredMethods.filter((method) => !methods.has(method))
    if (missing.length > 0) {
      throw new Error(
        [
          `Native worker at ${workerPath} is missing required methods: ${missing.join(', ')}.`,
          'Run `npm run native:publish` and restart OpenCowork.'
        ].join(' ')
      )
    }

    logNativeWorkerDebug('route check ok', {
      workerPath,
      methodCount: methods.size
    })
  }

  private installEventSocket(socket: net.Socket): void {
    socket.on('data', (chunk) => this.handleEventSocketData(chunk))
    socket.on('error', (error) => {
      if (this.eventSocket === socket && !this.stopping) this.resetEventConnection(error)
    })
    socket.on('close', () => {
      if (this.eventSocket === socket && !this.stopping) {
        this.resetEventConnection(new Error('Native worker Event IPC closed'))
      }
    })
  }

  private resetEventConnection(error: Error): void {
    const socket = this.eventSocket
    if (!socket) return
    this.eventSocket = null
    socket.removeAllListeners()
    socket.destroy()
    this.eventReadChunks = []
    this.eventReadBufferedBytes = 0
    this.eventPendingFrameLength = -1
    console.warn('[NativeWorker] Event IPC disconnected; jobs remain healthy', {
      error: error.message
    })
    this.scheduleEventReconnect()
  }

  private scheduleEventReconnect(): void {
    if (
      this.eventReconnectTimer ||
      this.stopping ||
      !this.child ||
      !this.eventEndpoint ||
      !this.isRunning
    ) {
      return
    }

    this.eventReconnectTimer = setTimeout(() => {
      this.eventReconnectTimer = null
      void this.reconnectEventSocket()
    }, 250)
    this.eventReconnectTimer.unref?.()
  }

  private async reconnectEventSocket(): Promise<void> {
    const child = this.child
    const endpoint = this.eventEndpoint
    if (!child || !endpoint || this.stopping || !this.isRunning || this.eventSocket) return

    try {
      const socket = await connectNativeWorker(endpoint, child)
      if (this.child !== child || this.stopping || !this.isRunning) {
        socket.destroy()
        return
      }
      this.eventSocket = socket
      this.installEventSocket(socket)
      console.log('[NativeWorker] Event IPC reconnected')
      this.lifecycle.emit('event-reconnected')
    } catch (error) {
      if (this.child === child && !this.stopping && this.isRunning) {
        console.warn('[NativeWorker] Event IPC reconnect failed', {
          error: asError(error).message
        })
        this.scheduleEventReconnect()
      }
    }
  }

  // Chunks are queued as-is and only joined once a full frame has arrived;
  // concatenating the whole backlog on every socket chunk is O(n²) for large
  // frames and blocks the main thread.
  private handleSocketData(chunk: Buffer): void {
    this.readChunks.push(chunk)
    this.readBufferedBytes += chunk.length

    while (true) {
      if (this.pendingFrameLength < 0) {
        if (this.readBufferedBytes < FRAME_HEADER_BYTES) return
        const header = this.consumeBufferedBytes(FRAME_HEADER_BYTES)
        const length = header.readUInt32BE(0)
        if (length <= 0 || length > MAX_FRAME_BYTES) {
          this.closeWorker(new Error(`Invalid native worker frame length: ${length}`))
          return
        }
        this.pendingFrameLength = length
      }

      if (this.readBufferedBytes < this.pendingFrameLength) return
      const payload = this.consumeBufferedBytes(this.pendingFrameLength)
      this.pendingFrameLength = -1
      this.handleResponseFrame(payload, 'control')
    }
  }

  private handleEventSocketData(chunk: Buffer): void {
    this.eventReadChunks.push(chunk)
    this.eventReadBufferedBytes += chunk.length

    while (true) {
      if (this.eventPendingFrameLength < 0) {
        if (this.eventReadBufferedBytes < FRAME_HEADER_BYTES) return
        const header = this.consumeEventBufferedBytes(FRAME_HEADER_BYTES)
        const length = header.readUInt32BE(0)
        if (length <= 0 || length > MAX_FRAME_BYTES) {
          this.resetEventConnection(
            new Error(`Invalid native worker Event IPC frame length: ${length}`)
          )
          return
        }
        this.eventPendingFrameLength = length
      }
      if (this.eventReadBufferedBytes < this.eventPendingFrameLength) return
      const payload = this.consumeEventBufferedBytes(this.eventPendingFrameLength)
      this.eventPendingFrameLength = -1
      this.handleResponseFrame(payload, 'event')
    }
  }

  private consumeEventBufferedBytes(count: number): Buffer {
    const first = this.eventReadChunks[0]
    if (first && first.length >= count) {
      const output = first.subarray(0, count)
      if (first.length === count) this.eventReadChunks.shift()
      else this.eventReadChunks[0] = first.subarray(count)
      this.eventReadBufferedBytes -= count
      return output
    }

    const output = Buffer.allocUnsafe(count)
    let offset = 0
    while (offset < count) {
      const current = this.eventReadChunks[0]
      if (!current) throw new Error('Native worker Event IPC frame buffer underflow')
      const length = Math.min(current.length, count - offset)
      current.copy(output, offset, 0, length)
      if (length === current.length) this.eventReadChunks.shift()
      else this.eventReadChunks[0] = current.subarray(length)
      offset += length
    }
    this.eventReadBufferedBytes -= count
    return output
  }

  private consumeBufferedBytes(count: number): Buffer {
    const first = this.readChunks[0]
    if (first.length >= count) {
      const out = first.subarray(0, count)
      if (first.length === count) {
        this.readChunks.shift()
      } else {
        this.readChunks[0] = first.subarray(count)
      }
      this.readBufferedBytes -= count
      return out
    }

    const out = Buffer.allocUnsafe(count)
    let offset = 0
    while (offset < count) {
      const chunk = this.readChunks[0]
      const take = Math.min(chunk.length, count - offset)
      chunk.copy(out, offset, 0, take)
      if (take === chunk.length) {
        this.readChunks.shift()
      } else {
        this.readChunks[0] = chunk.subarray(take)
      }
      offset += take
    }
    this.readBufferedBytes -= count
    return out
  }

  private handleResponseFrame(payload: Buffer, source: 'control' | 'event'): void {
    if (source === 'control') this.lastFrameReceivedAt = Date.now()
    const routeStartedAt = performance.now()
    const route = readNativeMessagePackRoute(payload)
    if (
      route?.event === 'agent/stream' &&
      typeof route.runId === 'string' &&
      typeof route.sessionId === 'string'
    ) {
      this.lastAgentStreamAt = Date.now()
      this.lastAgentStreamRunId = route.runId
      logMessagePackTrace('raw agent stream route', {
        runId: route.runId,
        sessionId: route.sessionId,
        seq: route.seq,
        bytes: payload.byteLength,
        elapsedMs: Math.round((performance.now() - routeStartedAt) * 100) / 100
      })
      this.rawEvents.emit(route.event, {
        ...route,
        bytes: Buffer.from(payload),
        byteLength: payload.byteLength
      } satisfies NativeWorkerRawEventFrame)
      return
    }

    const decodeStartedAt = performance.now()
    let decoded: unknown
    try {
      decoded = decode(payload)
    } catch (error) {
      console.warn(
        `[NativeWorker] invalid MessagePack response: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return
    }
    logMessagePackTrace('decoded frame', {
      bytes: payload.byteLength,
      elapsedMs: Math.round((performance.now() - decodeStartedAt) * 100) / 100,
      rawRoute: route?.event === 'agent/stream'
    })

    if (!isRecord(decoded)) return
    const eventFrame = decoded as NativeWorkerEventFrame
    if (typeof eventFrame.event === 'string' && eventFrame.event) {
      logNativeWorkerDebug('event', { event: eventFrame.event })
      this.events.emit(eventFrame.event, extractEventParameters(eventFrame.event, decoded))
      return
    }

    const response = decoded as NativeWorkerResponse
    if (typeof response.id !== 'number') return
    const pending = this.pending.get(response.id)
    if (!pending) return

    if (pending.timer) clearTimeout(pending.timer)
    pending.removeAbortListener?.()
    this.pending.delete(response.id)
    const elapsedMs = Date.now() - pending.startedAt
    if (typeof response.error === 'string' && response.error) {
      console.warn('[NativeWorker] request failed', {
        id: response.id,
        method: pending.method,
        elapsedMs,
        payloadBytes: pending.payloadBytes,
        responseBytes: payload.byteLength,
        pending: this.pending.size,
        error: response.error
      })
      pending.reject(new Error(response.error))
    } else {
      logNativeWorkerCompletion({
        id: response.id,
        method: pending.method,
        elapsedMs,
        payloadBytes: pending.payloadBytes,
        responseBytes: payload.byteLength,
        pending: this.pending.size
      })
      pending.resolve(response.result)
    }
  }

  private rejectPendingRequest(id: number, error: Error): void {
    const pending = this.pending.get(id)
    if (!pending) return
    if (pending.timer) clearTimeout(pending.timer)
    pending.removeAbortListener?.()
    this.pending.delete(id)
    console.warn('[NativeWorker] request write failed', {
      id,
      method: pending.method,
      elapsedMs: Date.now() - pending.startedAt,
      payloadBytes: pending.payloadBytes,
      pending: this.pending.size,
      error: error.message
    })
    pending.reject(error)
  }

  private closeWorker(error: Error): void {
    this.stopHeartbeat()
    const child = this.child
    const socket = this.socket
    const eventSocket = this.eventSocket
    const endpoint = this.endpoint
    const eventEndpoint = this.eventEndpoint
    const hadWorkerActivity = Boolean(child || socket || this.pending.size > 0)

    if (!this.stopping && hadWorkerActivity) {
      const disconnectedAt = Date.now()
      this.lastDisconnect = {
        at: disconnectedAt,
        error: error.message,
        pendingRequests: Array.from(this.pending.values()).map((pending) => ({
          method: pending.method,
          elapsedMs: Math.max(0, disconnectedAt - pending.startedAt)
        }))
      }
    }

    this.child = null
    this.socket = null
    this.eventSocket = null
    this.endpoint = null
    this.eventEndpoint = null
    this.readChunks = []
    this.readBufferedBytes = 0
    this.pendingFrameLength = -1

    if (child || socket || this.pending.size > 0) {
      const level = this.stopping ? console.log : console.warn
      level('[NativeWorker] closing', {
        pid: child?.pid ?? null,
        pending: this.pending.size,
        reason: error.message
      })
    }

    socket?.removeAllListeners()
    socket?.destroy()
    eventSocket?.removeAllListeners()
    eventSocket?.destroy()
    if (this.eventReconnectTimer) {
      clearTimeout(this.eventReconnectTimer)
      this.eventReconnectTimer = null
    }
    this.eventReadChunks = []
    this.eventReadBufferedBytes = 0
    this.eventPendingFrameLength = -1
    if (child && !child.killed && child.exitCode === null) {
      child.kill()
      // SIGTERM is advisory: a worker wedged in native code (the usual reason a
      // heartbeat recycle lands here) can ignore it and linger next to its
      // replacement. Escalate if it has not exited shortly.
      const killTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return
        console.warn('[NativeWorker] worker did not exit after SIGTERM; sending SIGKILL', {
          pid: child.pid ?? null
        })
        try {
          child.kill('SIGKILL')
        } catch {
          // Process already reaped.
        }
      }, NATIVE_WORKER_KILL_ESCALATION_MS)
      killTimer.unref?.()
      child.once('exit', () => clearTimeout(killTimer))
    }
    if (endpoint) {
      cleanupNativeWorkerEndpoint(endpoint)
    }
    if (eventEndpoint) {
      cleanupNativeWorkerEndpoint(eventEndpoint)
    }

    for (const pending of this.pending.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer)
        pending.timer = undefined
      }
      pending.removeAbortListener?.()
      pending.removeAbortListener = undefined
      // Read-only requests survive one restart: park them for replay on the
      // fresh worker instead of failing the caller for a crash it can't act on.
      if (
        pending.replayable &&
        !pending.replayed &&
        !this.stopping &&
        !this.autoRestartDisabled &&
        !nativeWorkerShutdownLatched
      ) {
        pending.replayed = true
        this.replayQueue.push(pending)
      } else {
        pending.reject(error)
      }
    }
    this.pending.clear()

    if (this.replayQueue.length > 0) {
      console.log('[NativeWorker] parked idempotent requests for replay', {
        count: this.replayQueue.length
      })
    }

    const shouldRestart = !this.stopping && !this.autoRestartDisabled
    if (shouldRestart) {
      this.setPhase('restart-backoff')
      this.setState('restarting', error.message)
      this.scheduleSupervisedRestart()
    } else if (this.state !== 'fatal') {
      this.setPhase(this.stopping ? 'stopping' : 'idle')
      this.setState('stopped', error.message)
    }
    if (!this.stopping) {
      // Runs owned by the dead process are lost; publish the updated failure
      // state first so disconnect listeners can capture an accurate snapshot.
      this.lifecycle.emit('disconnected')
    }
  }

  private flushReplayQueue(): void {
    if (this.replayQueue.length === 0) return
    const queued = this.replayQueue.splice(0)
    console.log('[NativeWorker] replaying idempotent requests', { count: queued.length })
    for (const pending of queued) {
      if (pending.signal?.aborted) {
        pending.reject(createAbortError(pending.method))
        continue
      }
      this.dispatchPending(pending)
    }
  }

  private failReplayQueue(error: Error): void {
    if (this.replayQueue.length === 0) return
    const queued = this.replayQueue.splice(0)
    for (const pending of queued) {
      pending.reject(error)
    }
  }

  // Proactively bring the worker back after an unexpected exit/close so the next
  // user turn does not hit SIDECAR_UNAVAILABLE. Backoff (with jitter) keeps a
  // hard-down worker — e.g. a missing/stale binary awaiting `native:publish` —
  // from spinning; a live user request still starts immediately via
  // ensureStarted(), so this only governs the background self-heal cadence.
  private scheduleSupervisedRestart(): void {
    if (nativeWorkerShutdownLatched) return
    if (this.autoRestartDisabled || this.stopping || this.restartTimer) return
    if (this.restartAttempts >= NATIVE_WORKER_RESTART_FATAL_ATTEMPTS) {
      console.error(
        `[NativeWorker] giving up supervised restarts after ${this.restartAttempts} failed attempts`
      )
      this.enterFatal(
        `Native worker failed to restart after ${this.restartAttempts} attempts` +
          (this.lastError ? `: ${this.lastError}` : '')
      )
      return
    }

    const backoff = Math.min(
      NATIVE_WORKER_RESTART_MAX_MS,
      NATIVE_WORKER_RESTART_BASE_MS * 2 ** this.restartAttempts
    )
    const wait = Math.round(backoff + backoff * 0.25 * Math.random())
    this.setPhase('restart-backoff')
    this.restartAttempts += 1
    if (this.restartAttempts <= 5) {
      console.warn(
        `[NativeWorker] scheduling supervised restart in ${wait}ms (attempt ${this.restartAttempts})`
      )
    }

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.autoRestartDisabled || this.stopping || this.isRunning) return
      void this.ensureStarted().catch((restartError) => {
        // A failed attempt runs closeWorker, which reschedules with more backoff.
        logNativeWorkerDebug('supervised restart attempt failed', {
          message: asError(restartError).message
        })
      })
    }, wait)
    this.restartTimer.unref?.()
  }

  private clearSupervisedRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      void this.runHeartbeat()
    }, this.config.heartbeatIntervalMs)
    this.heartbeatTimer.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.heartbeatMisses = 0
  }

  private async runHeartbeat(): Promise<void> {
    if (!this.isRunning || this.stopping || this.autoRestartDisabled) return
    // A busy pipe proves liveness through its response/event frames — but a
    // wedged worker with stuck in-flight requests emits none, so probe once the
    // pipe has been silent for a full interval. worker/ping bypasses dispatch
    // slots worker-side, so saturation cannot fake a death.
    if (this.pending.size > 0) {
      const silentMs = Date.now() - this.lastFrameReceivedAt
      if (silentMs < this.config.heartbeatIntervalMs) {
        this.heartbeatMisses = 0
        return
      }
    }

    try {
      await this.request('worker/ping', {}, this.config.heartbeatTimeoutMs)
      this.heartbeatMisses = 0
    } catch (error) {
      if (!this.isRunning || this.stopping || this.autoRestartDisabled) return
      this.heartbeatMisses += 1
      console.warn('[NativeWorker] heartbeat miss', {
        misses: this.heartbeatMisses,
        error: asError(error).message
      })
      if (this.heartbeatMisses >= this.config.heartbeatMaxMisses) {
        this.closeWorker(new Error('Native worker heartbeat failed'))
      }
    }
  }

  private installPowerMonitor(): void {
    powerMonitor.on('suspend', () => {
      // Timers do not fire while the system sleeps; stop the heartbeat so a
      // stale interval cannot count phantom misses around the sleep edge.
      this.stopHeartbeat()
    })
    powerMonitor.on('resume', () => {
      void this.handleSystemResume()
    })
  }

  // Sleep/wake used to surface only through the 15s heartbeat (worst case
  // ~35s of a wedged worker after wake). Probe immediately instead, and if the
  // worker is already down skip any pending backoff so it comes back now.
  private async handleSystemResume(): Promise<void> {
    if (this.stopping || this.autoRestartDisabled || nativeWorkerShutdownLatched) return

    if (!this.isRunning) {
      if (!this.hasStartedOnce) return
      this.restartAttempts = 0
      this.clearSupervisedRestart()
      void this.ensureStarted().catch((error) => {
        logNativeWorkerDebug('post-resume restart failed', {
          message: asError(error).message
        })
      })
      return
    }

    this.startHeartbeat()
    if (this.pending.size > 0) return
    try {
      await this.request('worker/ping', {}, this.config.heartbeatTimeoutMs)
      logNativeWorkerDebug('post-resume health check ok', {})
    } catch (error) {
      if (!this.isRunning || this.stopping || this.autoRestartDisabled) return
      console.warn('[NativeWorker] post-resume health check failed; recycling worker', {
        error: asError(error).message
      })
      this.closeWorker(new Error('Native worker unhealthy after system resume'))
    }
  }

  private captureStderr(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      this.stderrTail.push(
        trimmed.length > NATIVE_WORKER_STDERR_MAX_LINE
          ? `${trimmed.slice(0, NATIVE_WORKER_STDERR_MAX_LINE)}…`
          : trimmed
      )
    }
    if (this.stderrTail.length > NATIVE_WORKER_STDERR_TAIL_LINES) {
      this.stderrTail.splice(0, this.stderrTail.length - NATIVE_WORKER_STDERR_TAIL_LINES)
    }
  }

  private sendCancelRequest(requestId: number): void {
    const socket = this.socket
    if (!socket || socket.destroyed || !this.isRunning) return

    try {
      const payload = encode({ method: 'worker/cancel', params: { requestId } })
      socket.write(createFrame(payload), (error) => {
        if (error) {
          logNativeWorkerDebug('cancel frame write failed', {
            requestId,
            message: error.message
          })
        }
      })
    } catch (error) {
      logNativeWorkerDebug('cancel frame encode failed', {
        requestId,
        message: asError(error).message
      })
    }
  }
}

let nativeWorker: NativeWorkerManager | null = null

export function getNativeWorker(): NativeWorkerManager {
  nativeWorker ??= new NativeWorkerManager(NATIVE_CONFIG)
  return nativeWorker
}

export async function stopNativeWorker(): Promise<void> {
  await nativeWorker?.stop()
}

// The opt-in CodeGraph sidecar mirrors the main-worker singleton but is LAZY:
// this getter constructs the manager, yet nothing calls ensureStarted() at boot.
// The first `codegraph/*` request (routed only when the feature is enabled) is
// what spawns the process; disabling the feature calls stopCodeGraphWorker().
let codeGraphWorker: NativeWorkerManager | null = null

export function getCodeGraphWorker(): NativeWorkerManager {
  codeGraphWorker ??= new NativeWorkerManager(CODEGRAPH_CONFIG)
  return codeGraphWorker
}

export async function stopCodeGraphWorker(): Promise<void> {
  await codeGraphWorker?.stop()
}

// Status probe for the plugin settings UI — true only after a lazy spawn.
export function isCodeGraphWorkerRunning(): boolean {
  return codeGraphWorker?.isRunning === true
}

// Main-worker status probe (CodeGraph is source-merged into it).
export function isNativeWorkerRunning(): boolean {
  return nativeWorker?.isRunning === true
}

function createFrame(payload: Uint8Array): Buffer {
  if (payload.byteLength <= 0 || payload.byteLength > MAX_FRAME_BYTES) {
    throw new Error(`Invalid native worker request length: ${payload.byteLength}`)
  }

  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength)
  frame.writeUInt32BE(payload.byteLength, 0)
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(
    frame,
    FRAME_HEADER_BYTES
  )
  return frame
}

function waitForNativeJobPoll(signal: AbortSignal | undefined, delayMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError('jobs/result'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(createAbortError('jobs/result'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function createAbortError(method: string): Error {
  const error = new Error(`Native worker request aborted: ${method}`)
  error.name = 'AbortError'
  return error
}

function createProtocolMismatchError(detail: string): Error {
  const error = new Error(`${detail} Run \`npm run native:publish\` and restart OpenCowork.`)
  error.name = 'WorkerProtocolMismatchError'
  return error
}

async function connectNativeWorker(endpoint: string, child: ChildProcess): Promise<net.Socket> {
  const deadline = Date.now() + NATIVE_WORKER_CONNECT_TIMEOUT_MS
  let lastError: Error | null = null

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Native worker exited before IPC connection: code=${child.exitCode}`)
    }

    try {
      return await connectOnce(endpoint)
    } catch (error) {
      lastError = asError(error)
      await delay(NATIVE_WORKER_CONNECT_RETRY_MS)
    }
  }

  throw new Error(
    `Native worker IPC connection timed out: ${lastError ? lastError.message : endpoint}`
  )
}

function connectOnce(endpoint: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`Native worker IPC connect timeout: ${endpoint}`))
    }, 1_000)

    const cleanup = (): void => {
      clearTimeout(timer)
      socket.off('connect', onConnect)
      socket.off('error', onError)
    }
    const onConnect = (): void => {
      cleanup()
      resolve(socket)
    }
    const onError = (error: Error): void => {
      cleanup()
      socket.destroy()
      reject(error)
    }

    socket.once('connect', onConnect)
    socket.once('error', onError)
  })
}

function createNativeWorkerEndpoint(): string {
  const id = `${process.pid}-${Date.now().toString(36)}-${randomUUID()}`
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\open-cowork-native-${id}`
  }

  return path.join('/tmp', `open-cowork-native-${id}.sock`)
}

function cleanupNativeWorkerEndpoint(endpoint: string): void {
  if (process.platform === 'win32') return
  try {
    fs.rmSync(endpoint, { force: true })
  } catch {
    // The worker also removes the Unix socket path on orderly shutdown.
  }
}

let staleEndpointSweepDone = false

// Endpoint filenames embed the owning Electron main PID. A hard-killed main
// never runs cleanupNativeWorkerEndpoint, so its socket files linger in /tmp
// forever; remove the ones whose owner is gone. Files only — never processes —
// so a recycled PID can at worst keep a stale file, not lose a live one.
function sweepStaleNativeWorkerEndpoints(): void {
  if (process.platform === 'win32' || staleEndpointSweepDone) return
  staleEndpointSweepDone = true

  let entries: string[]
  try {
    entries = fs.readdirSync('/tmp')
  } catch {
    return
  }

  for (const entry of entries) {
    const match = /^open-cowork-native-(\d+)-.+\.sock$/.exec(entry)
    if (!match) continue
    const ownerPid = Number.parseInt(match[1], 10)
    if (!Number.isFinite(ownerPid) || ownerPid === process.pid || isProcessAlive(ownerPid)) {
      continue
    }
    try {
      fs.rmSync(path.join('/tmp', entry), { force: true })
      console.log('[NativeWorker] removed stale endpoint of dead process', { entry, ownerPid })
    } catch {
      // Best effort; a locked file just stays behind.
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the pid exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createNativeWorkerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (readBooleanEnv('OPEN_COWORK_NATIVE_DEBUG') === null && !app.isPackaged) {
    env.OPEN_COWORK_NATIVE_DEBUG = '1'
  }
  env.OPEN_COWORK_APP_VERSION = app.getVersion().trim()
  env.OPEN_COWORK_NATIVE_SLOW_MS ??= String(getNativeWorkerSlowRequestMs())
  // CodeGraph is source-merged into this worker: point its tree-sitter loads at
  // the nested CodeGraph assets, dev NuGet directory, or explicit override.
  const grammarsDir = resolveCodeGraphGrammarsDir()
  if (grammarsDir) {
    env.OPEN_COWORK_CODEGRAPH_GRAMMARS_DIR ??= grammarsDir
  }
  return env
}

function logNativeWorkerCompletion(details: {
  id: number
  method: string
  elapsedMs: number
  payloadBytes: number
  responseBytes: number
  pending: number
}): void {
  if (details.elapsedMs >= getNativeWorkerSlowRequestMs()) {
    console.warn('[NativeWorker] slow request', details)
    return
  }

  logNativeWorkerDebug('request success', details)
}

function logNativeWorkerDebug(message: string, details: Record<string, unknown>): void {
  if (!isNativeWorkerDebugEnabled()) return
  console.log(`[NativeWorker] ${message}`, details)
}

function logMessagePackTrace(message: string, details: Record<string, unknown>): void {
  if (!isMessagePackTraceEnabled()) return
  console.log(`[NativeWorker][MessagePack] ${message}`, details)
}

function isNativeWorkerDebugEnabled(): boolean {
  return readBooleanEnv('OPEN_COWORK_NATIVE_DEBUG') ?? !app.isPackaged
}

function isMessagePackTraceEnabled(): boolean {
  return readBooleanEnv('OPEN_COWORK_MSGPACK_TRACE') ?? false
}

function getNativeWorkerSlowRequestMs(): number {
  const raw = process.env.OPEN_COWORK_NATIVE_SLOW_MS
  if (!raw) return DEFAULT_NATIVE_WORKER_SLOW_REQUEST_MS

  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_NATIVE_WORKER_SLOW_REQUEST_MS
}

function readBooleanEnv(name: string): boolean | null {
  const raw = process.env[name]
  if (raw === undefined) return null

  const value = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(value)) return true
  if (['0', 'false', 'no', 'off'].includes(value)) return false
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractEventParameters(eventName: string, decoded: Record<string, unknown>): unknown {
  if ('params' in decoded) return decoded.params
  if (eventName !== 'agent/stream') return undefined

  const envelope = {
    v: decoded.v,
    runId: decoded.runId,
    sessionId: decoded.sessionId,
    seq: decoded.seq,
    events: decoded.events
  }
  return envelope
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export function resolveNativeWorkerPath(): string | null {
  const overridePath = process.env.OPEN_COWORK_NATIVE_WORKER_PATH?.trim()
  if (overridePath && fs.existsSync(overridePath)) {
    return overridePath
  }

  const candidates = getNativeWorkerCandidatePaths().filter(
    (candidate) => candidate !== overridePath
  )
  return app.isPackaged
    ? (candidates.find(isNativeWorkerCandidateReady) ?? null)
    : findNewestNativeWorkerCandidate(candidates)
}

function getNativeWorkerCandidatePaths(): string[] {
  const executableName = getNativeWorkerExecutableName()
  const releaseNativePath = path.join(
    process.cwd(),
    'sidecars',
    'OpenCowork.Native.Worker',
    'bin',
    'Release',
    'net10.0',
    getCurrentRid(),
    'native',
    executableName
  )
  const releasePublishPath = path.join(
    process.cwd(),
    'sidecars',
    'OpenCowork.Native.Worker',
    'bin',
    'Release',
    'net10.0',
    getCurrentRid(),
    'publish',
    executableName
  )
  const resourceWorkerPath = path.join(process.cwd(), 'resources', 'native-worker', executableName)
  const packagedOrDevelopmentCandidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, 'native-worker', executableName),
        path.join(process.resourcesPath, 'resources', 'native-worker', executableName),
        path.join(
          process.resourcesPath,
          'app.asar.unpacked',
          'resources',
          'native-worker',
          executableName
        )
      ]
    : [resourceWorkerPath, releaseNativePath, releasePublishPath]
  const overridePath = process.env.OPEN_COWORK_NATIVE_WORKER_PATH?.trim()

  return overridePath
    ? [overridePath, ...packagedOrDevelopmentCandidates.filter((item) => item !== overridePath)]
    : packagedOrDevelopmentCandidates
}

function getNativeWorkerExecutableName(): string {
  return process.platform === 'win32' ? 'OpenCowork.Native.Worker.exe' : 'OpenCowork.Native.Worker'
}

function getNativeWorkerCandidateDiagnostics(): NativeWorkerDiagnosticsSnapshot['binaryCandidates'] {
  const dependencyNames = getSqliteNativeLibraryNames()
  return getNativeWorkerCandidatePaths().map((candidate) => {
    const exists = fs.existsSync(candidate)
    const candidateDir = path.dirname(candidate)
    const dependencyPresent = dependencyNames.some(
      (name) =>
        fs.existsSync(path.join(candidateDir, name)) ||
        fs.existsSync(path.join(candidateDir, 'runtimes', getCurrentRid(), 'native', name))
    )
    return {
      path: candidate,
      exists,
      ready: exists && dependencyPresent,
      missingDependencies: dependencyPresent ? [] : dependencyNames
    }
  })
}

function formatNativeWorkerCandidateFailure(): string {
  const checked = getNativeWorkerCandidateDiagnostics()
    .map((candidate) => {
      if (!candidate.exists) return `${candidate.path} (executable missing)`
      if (candidate.missingDependencies.length > 0) {
        return `${candidate.path} (missing ${candidate.missingDependencies.join(' or ')})`
      }
      return `${candidate.path} (not usable)`
    })
    .join('; ')
  return checked ? `Checked worker candidates: ${checked}. Logs: ${getCrashLogDir()}.` : ''
}

function getCurrentRid(): string {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'osx-arm64' : 'osx-x64'
  if (process.platform === 'win32') return process.arch === 'arm64' ? 'win-arm64' : 'win-x64'
  if (process.platform === 'linux') return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
  return `${process.platform}-${process.arch}`
}

function isNativeWorkerCandidateReady(candidate: string): boolean {
  if (!fs.existsSync(candidate)) return false

  const candidateDir = path.dirname(candidate)
  const sqliteLibrary = getSqliteNativeLibraryNames().find(
    (name) =>
      fs.existsSync(path.join(candidateDir, name)) ||
      fs.existsSync(path.join(candidateDir, 'runtimes', getCurrentRid(), 'native', name))
  )
  return Boolean(sqliteLibrary)
}

function findNewestNativeWorkerCandidate(candidates: string[]): string | null {
  const existing = candidates.filter((candidate) => fs.existsSync(candidate))
  const ready = existing
    .filter(isNativeWorkerCandidateReady)
    .map((candidate) => ({
      candidate,
      mtimeMs: fs.statSync(candidate).mtimeMs
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  if (ready.length === 0 && existing.length > 0) {
    console.warn(
      '[NativeWorker] no usable native worker candidate (missing SQLite native library)',
      {
        candidates: existing,
        expected: getSqliteNativeLibraryNames()
      }
    )
  }

  return ready[0]?.candidate ?? null
}

function getSqliteNativeLibraryNames(): string[] {
  if (process.platform === 'win32') return ['e_sqlite3.dll']
  if (process.platform === 'darwin') return ['libe_sqlite3.dylib', 'e_sqlite3.dylib']
  if (process.platform === 'linux') return ['libe_sqlite3.so', 'e_sqlite3.so']
  return ['libe_sqlite3']
}

// --- CodeGraph sidecar helpers ------------------------------------------------
// These mirror the main-worker resolvers but target the OpenCowork.CodeGraph.Worker
// binary and a distinct endpoint namespace. They are only reached through
// getCodeGraphWorker()/CODEGRAPH_CONFIG, so the main-worker path above is untouched.

export function resolveCodeGraphWorkerPath(): string | null {
  const overridePath = process.env.OPEN_COWORK_CODEGRAPH_WORKER_PATH?.trim()
  if (overridePath && fs.existsSync(overridePath)) {
    return overridePath
  }

  const executableName =
    process.platform === 'win32' ? 'OpenCowork.CodeGraph.Worker.exe' : 'OpenCowork.CodeGraph.Worker'
  // The CodeGraph projects live in the sidecars/codegraph submodule.
  const releaseNativePath = path.join(
    process.cwd(),
    'sidecars',
    'codegraph',
    'OpenCowork.CodeGraph.Worker',
    'bin',
    'Release',
    'net10.0',
    getCurrentRid(),
    'native',
    executableName
  )
  const releasePublishPath = path.join(
    process.cwd(),
    'sidecars',
    'codegraph',
    'OpenCowork.CodeGraph.Worker',
    'bin',
    'Release',
    'net10.0',
    getCurrentRid(),
    'publish',
    executableName
  )
  const resourceWorkerPath = path.join(
    process.cwd(),
    'resources',
    'native-worker',
    'codegraph-worker',
    executableName
  )
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, 'native-worker', 'codegraph-worker', executableName),
        path.join(
          process.resourcesPath,
          'resources',
          'native-worker',
          'codegraph-worker',
          executableName
        ),
        path.join(
          process.resourcesPath,
          'app.asar.unpacked',
          'resources',
          'native-worker',
          'codegraph-worker',
          executableName
        ),
        // Compatibility with legacy standalone CodeGraph worker packages.
        path.join(process.resourcesPath, 'codegraph-worker', executableName),
        path.join(process.resourcesPath, 'resources', 'codegraph-worker', executableName),
        path.join(
          process.resourcesPath,
          'app.asar.unpacked',
          'resources',
          'codegraph-worker',
          executableName
        )
      ]
    : [resourceWorkerPath, releaseNativePath, releasePublishPath]

  return app.isPackaged
    ? (candidates.find(isCodeGraphWorkerCandidateReady) ?? null)
    : findNewestCodeGraphWorkerCandidate(candidates)
}

// SQLite is a hard startup dependency just like it is for the main worker. Never
// select a partially published executable that is missing its RID-specific library.
function isCodeGraphWorkerCandidateReady(candidate: string): boolean {
  return isNativeWorkerCandidateReady(candidate)
}

function findNewestCodeGraphWorkerCandidate(candidates: string[]): string | null {
  const ready = candidates
    .filter(isCodeGraphWorkerCandidateReady)
    .map((candidate) => ({
      candidate,
      mtimeMs: fs.statSync(candidate).mtimeMs
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  return ready[0]?.candidate ?? null
}

function createCodeGraphWorkerEndpoint(): string {
  const id = `${process.pid}-${Date.now().toString(36)}-${randomUUID()}`
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\open-cowork-codegraph-${id}`
  }

  return path.join('/tmp', `open-cowork-codegraph-${id}.sock`)
}

function createCodeGraphWorkerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (readBooleanEnv('OPEN_COWORK_NATIVE_DEBUG') === null && !app.isPackaged) {
    env.OPEN_COWORK_NATIVE_DEBUG = '1'
  }
  env.OPEN_COWORK_APP_VERSION = app.getVersion().trim()
  env.OPEN_COWORK_NATIVE_SLOW_MS ??= String(getNativeWorkerSlowRequestMs())
  // Point the worker at the resolved grammar dir (download cache, dev NuGet, or
  // an explicit override) so its [LibraryImport] tree-sitter loads resolve.
  const grammarsDir = resolveCodeGraphGrammarsDir()
  if (grammarsDir) {
    env.OPEN_COWORK_CODEGRAPH_GRAMMARS_DIR ??= grammarsDir
  }
  return env
}

let staleCodeGraphEndpointSweepDone = false

// Parallels sweepStaleNativeWorkerEndpoints but matches the codegraph-prefixed
// socket names, with its own one-shot guard so each namespace is swept once.
function sweepStaleCodeGraphWorkerEndpoints(): void {
  if (process.platform === 'win32' || staleCodeGraphEndpointSweepDone) return
  staleCodeGraphEndpointSweepDone = true

  let entries: string[]
  try {
    entries = fs.readdirSync('/tmp')
  } catch {
    return
  }

  for (const entry of entries) {
    const match = /^open-cowork-codegraph-(\d+)-.+\.sock$/.exec(entry)
    if (!match) continue
    const ownerPid = Number.parseInt(match[1], 10)
    if (!Number.isFinite(ownerPid) || ownerPid === process.pid || isProcessAlive(ownerPid)) {
      continue
    }
    try {
      fs.rmSync(path.join('/tmp', entry), { force: true })
      console.log('[CodeGraphWorker] removed stale endpoint of dead process', { entry, ownerPid })
    } catch {
      // Best effort; a locked file just stays behind.
    }
  }
}
