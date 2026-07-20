import { app, powerMonitor } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as net from 'net'
import * as path from 'path'
import { decode, encode } from '@msgpack/msgpack'
import { readNativeMessagePackRoute, type NativeMessagePackRoute } from './messagepack-route-reader'
import { writeCrashLog } from '../crash-logger'
// Resolved lazily at spawn time (function-level cycle — safe): tells the CodeGraph
// worker where to load its bundled, updated, or dev tree-sitter grammars from.
import { resolveCodeGraphGrammarsDir } from './codegraph-assets'

const NATIVE_WORKER_STDERR_TAIL_LINES = 40
const NATIVE_WORKER_STDERR_MAX_LINE = 2000

const DEFAULT_NATIVE_WORKER_TIMEOUT_MS = 60_000
const DEFAULT_NATIVE_WORKER_SLOW_REQUEST_MS = 750
const NATIVE_WORKER_CONNECT_TIMEOUT_MS = 10_000
const NATIVE_WORKER_CONNECT_RETRY_MS = 35
const NATIVE_WORKER_RESTART_BASE_MS = 300
const NATIVE_WORKER_RESTART_MAX_MS = 30_000
const NATIVE_WORKER_HEARTBEAT_INTERVAL_MS = 15_000
const NATIVE_WORKER_HEARTBEAT_TIMEOUT_MS = 5_000
const NATIVE_WORKER_HEARTBEAT_MAX_MISSES = 2
const NATIVE_WORKER_KILL_ESCALATION_MS = 3_000
const FRAME_HEADER_BYTES = 4
const MAX_FRAME_BYTES = 256 * 1024 * 1024
const REQUIRED_NATIVE_WORKER_METHODS = [
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
  startedAt: number
  payloadBytes: number
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  removeAbortListener?: () => void
}

type NativeWorkerResponse = {
  id?: number
  result?: unknown
  error?: string
}

type NativeWorkerEventFrame = {
  event?: string
  params?: unknown
}

type NativeWorkerRoutesResult = {
  methods?: unknown
}

export type NativeWorkerRawEventFrame = NativeMessagePackRoute & {
  bytes: Buffer
  byteLength: number
}

class NativeWorkerManager {
  private child: ChildProcess | null = null
  private socket: net.Socket | null = null
  private endpoint: string | null = null
  private events = new EventEmitter()
  private rawEvents = new EventEmitter()
  private pending = new Map<number, PendingRequest>()
  private readChunks: Buffer[] = []
  private readBufferedBytes = 0
  private pendingFrameLength = -1
  private nextId = 1
  private startPromise: Promise<void> | null = null
  private stopping = false
  private autoRestartDisabled = false
  private hasStartedOnce = false
  private restartAttempts = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatMisses = 0
  private lifecycle = new EventEmitter()
  private stderrTail: string[] = []

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
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : DEFAULT_NATIVE_WORKER_TIMEOUT_MS
    if (signal?.aborted) {
      throw createAbortError(method)
    }

    await this.ensureStarted()
    if (signal?.aborted) {
      throw createAbortError(method)
    }
    const socket = this.socket
    if (!socket || !this.isRunning) {
      throw new Error('Native worker is not running')
    }

    const id = this.nextId++
    const payload = encode({ id, method, params: params ?? {} })
    const frame = createFrame(payload)
    const startedAt = Date.now()
    const payloadBytes = payload.byteLength

    logNativeWorkerDebug('request start', {
      id,
      method,
      payloadBytes,
      pending: this.pending.size + 1,
      timeoutMs: effectiveTimeoutMs
    })

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        pending.removeAbortListener?.()
        this.sendCancelRequest(id)
        console.warn('[NativeWorker] request timeout', {
          id,
          method,
          elapsedMs: Date.now() - startedAt,
          payloadBytes,
          pending: this.pending.size
        })
        pending.reject(new Error(`Native worker request timed out: ${method}`))
      }, effectiveTimeoutMs)

      const pending: PendingRequest = {
        method,
        startedAt,
        payloadBytes,
        resolve: (value) => resolve(value as T),
        reject,
        timer
      }

      if (signal) {
        const onAbort = (): void => {
          if (!this.pending.delete(id)) return
          clearTimeout(timer)
          pending.removeAbortListener?.()
          this.sendCancelRequest(id)
          pending.reject(createAbortError(method))
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
    })
  }

  async stop(): Promise<void> {
    this.autoRestartDisabled = true
    this.stopping = true
    this.clearSupervisedRestart()
    this.stopHeartbeat()
    this.closeWorker(new Error('Native worker stopped'))
    this.stopping = false
  }

  private async start(): Promise<void> {
    const workerPath = this.config.resolveBinaryPath()
    if (!workerPath) {
      throw new Error(this.config.missingBinaryMessage)
    }

    this.config.sweepStaleEndpoints()
    const endpoint = this.config.createEndpoint()
    cleanupNativeWorkerEndpoint(endpoint)
    const childEnv = this.config.createEnv()
    console.log('[NativeWorker] starting', {
      workerPath,
      transport: process.platform === 'win32' ? 'named-pipe' : 'unix-domain-socket',
      debug: isNativeWorkerDebugEnabled(),
      slowRequestMs: getNativeWorkerSlowRequestMs()
    })

    const child = spawn(workerPath, ['--ipc', endpoint], {
      cwd: path.dirname(workerPath),
      env: childEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })

    this.child = child
    this.endpoint = endpoint
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

      await this.request('worker/ping', {}, 10_000)
      await this.verifyRequiredMethods(workerPath)
      console.log('[NativeWorker] IPC connected', {
        pid: child.pid ?? null,
        workerPath,
        transport: process.platform === 'win32' ? 'named-pipe' : 'unix-domain-socket'
      })

      const reconnected = this.hasStartedOnce
      this.hasStartedOnce = true
      this.restartAttempts = 0
      this.clearSupervisedRestart()
      this.startHeartbeat()
      if (reconnected) {
        console.log('[NativeWorker] recovered after unexpected exit; re-initializing runtimes')
        this.lifecycle.emit('reconnected')
      }
    } catch (error) {
      this.closeWorker(asError(error))
      throw error
    }
  }

  private async verifyRequiredMethods(workerPath: string): Promise<void> {
    // An empty gate (the CodeGraph worker) never blocks boot: skip the route
    // probe entirely so a lazy sidecar starts on first use without a boot check.
    if (this.config.requiredMethods.length === 0) return

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
      this.handleResponseFrame(payload)
    }
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

  private handleResponseFrame(payload: Buffer): void {
    const routeStartedAt = performance.now()
    const route = readNativeMessagePackRoute(payload)
    if (
      route?.event === 'agent/stream' &&
      typeof route.runId === 'string' &&
      typeof route.sessionId === 'string'
    ) {
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

    clearTimeout(pending.timer)
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
    clearTimeout(pending.timer)
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
    const endpoint = this.endpoint

    this.child = null
    this.socket = null
    this.endpoint = null
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

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.removeAbortListener?.()
      pending.reject(error)
    }
    this.pending.clear()

    if (!this.stopping) {
      // Runs owned by the dead process are lost; let listeners fail them so the
      // UI recovers instead of hanging on a stream that will never resume.
      this.lifecycle.emit('disconnected')
    }
    if (!this.stopping && !this.autoRestartDisabled) {
      this.scheduleSupervisedRestart()
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

    const backoff = Math.min(
      NATIVE_WORKER_RESTART_MAX_MS,
      NATIVE_WORKER_RESTART_BASE_MS * 2 ** this.restartAttempts
    )
    const wait = Math.round(backoff + backoff * 0.25 * Math.random())
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
    // In-flight requests are their own liveness proof; probing while busy only
    // risks a false positive that would recycle a healthy worker mid-run.
    if (this.pending.size > 0) {
      this.heartbeatMisses = 0
      return
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

function createAbortError(method: string): Error {
  const error = new Error(`Native worker request aborted: ${method}`)
  error.name = 'AbortError'
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

  const executableName =
    process.platform === 'win32' ? 'OpenCowork.Native.Worker.exe' : 'OpenCowork.Native.Worker'
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
  const candidates = app.isPackaged
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

  return app.isPackaged
    ? (candidates.find(isNativeWorkerCandidateReady) ?? null)
    : findNewestNativeWorkerCandidate(candidates)
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
  const releaseNativePath = path.join(
    process.cwd(),
    'sidecars',
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
