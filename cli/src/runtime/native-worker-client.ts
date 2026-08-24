import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WORKER_PROTOCOL_VERSION,
  WORKER_HEARTBEAT_INTERVAL_MS as HEARTBEAT_INTERVAL_MS
} from '../vendor/native-worker-protocol.js'
import { WorkerHttpChannel } from '../vendor/worker-http-channel.js'

const REQUEST_TIMEOUT_MS = 60_000

type PendingRequest = {
  method: string
  reject(error: Error): void
  resolve(value: unknown): void
  timer: ReturnType<typeof setTimeout>
  removeAbortListener?: () => void
}

type WorkerResponse = {
  id?: number
  result?: unknown
  error?: string
}

type WorkerEventFrame = {
  event?: string
  params?: unknown
  [key: string]: unknown
}

type WorkerRouteDescriptor = {
  method: string
  executionMode: string
  resultMode: string
}

type JobSubmission = {
  accepted?: boolean
  duplicate?: boolean
  jobId?: string
  runId?: string
  state?: string
  error?: string
  errorCode?: string
}

type JobStatus = {
  state?: string
  result?: unknown
  error?: string
  errorCode?: string
}

export type WorkerEventListener = (params: unknown, raw: Record<string, unknown>) => void

export interface NativeWorkerClientOptions {
  appVersion: string
  workerPath?: string
}

export interface NativeWorkerProbe {
  agentProtocolVersion: number
  executable: string
  pid: number
  protocolVersion: number
  runtime: string
  runtimeVersion: string
  routeCount: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function createAbortError(method: string): Error {
  const error = new Error(`Native worker request aborted: ${method}`)
  error.name = 'AbortError'
  return error
}

function waitForJobPoll(signal: AbortSignal | undefined, delayMs: number): Promise<void> {
  return new Promise((resolveWait, rejectWait) => {
    if (signal?.aborted) {
      rejectWait(createAbortError('jobs/result'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort)
      resolveWait()
    }, delayMs)
    const handleAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', handleAbort)
      rejectWait(createAbortError('jobs/result'))
    }
    signal?.addEventListener('abort', handleAbort, { once: true })
    if (signal?.aborted) handleAbort()
  })
}

export function getCurrentRid(): string {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'osx-arm64' : 'osx-x64'
  if (process.platform === 'win32') return process.arch === 'arm64' ? 'win-arm64' : 'win-x64'
  if (process.platform === 'linux') return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
  return `${process.platform}-${process.arch}`
}

function resolveWorkerPath(explicitPath?: string): string | null {
  const override = explicitPath?.trim() || process.env.OPEN_COWORK_NATIVE_WORKER_PATH?.trim()
  if (override) return existsSync(override) ? resolve(override) : null

  const executable =
    process.platform === 'win32' ? 'OpenCowork.Native.Worker.exe' : 'OpenCowork.Native.Worker'
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const cliDirectory = resolve(moduleDirectory, '../..')
  const repositoryDirectory = resolve(cliDirectory, '..')
  const rid = getCurrentRid()
  const candidates = [
    join(cliDirectory, 'native-worker', executable),
    join(cliDirectory, 'native-workers', rid, executable),
    join(cliDirectory, 'resources', 'native-worker', executable),
    join(repositoryDirectory, 'resources', 'native-worker', executable),
    join(
      repositoryDirectory,
      'sidecars',
      'OpenCowork.Native.Worker',
      'bin',
      'Release',
      'net11.0',
      rid,
      'native',
      executable
    ),
    join(
      repositoryDirectory,
      'sidecars',
      'OpenCowork.Native.Worker',
      'bin',
      'Release',
      'net11.0',
      rid,
      'publish',
      executable
    ),
    join(
      repositoryDirectory,
      'sidecars',
      'OpenCowork.Native.Worker',
      'bin',
      'Release',
      'net11.0',
      executable
    ),
    join(
      repositoryDirectory,
      'sidecars',
      'OpenCowork.Native.Worker',
      'bin',
      'Debug',
      'net11.0',
      executable
    )
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

export class NativeWorkerClient {
  private child: ChildProcess | null = null
  private channel: WorkerHttpChannel | null = null
  private readonly hostId = `cli-${randomUUID().replaceAll('-', '')}`
  private executable: string | null = null
  private startPromise: Promise<void> | null = null
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private events = new EventEmitter()
  private stderrTail: string[] = []
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private runtimeInfo: Record<string, unknown> = {}
  private routeCount = 0
  private jobRoutes = new Map<string, WorkerRouteDescriptor>()

  constructor(private readonly options: NativeWorkerClientOptions) {}

  get isRunning(): boolean {
    return Boolean(
      this.child &&
      this.child.exitCode === null &&
      !this.child.killed &&
      this.channel?.endpoint != null
    )
  }

  on(eventName: string, listener: WorkerEventListener): () => void {
    this.events.on(eventName, listener)
    return () => this.events.off(eventName, listener)
  }

  ackEvent(jobId: string, throughSeq: number): void {
    if (!this.isRunning || !jobId || throughSeq <= 0) return
    void this.request('events/checkpoint', { consumerId: this.hostId, jobId, throughSeq }, 10_000).catch(
      () => {}
    )
  }

  /**
   * Clear the durable outbox in-flight window and republish batches after the
   * consumer cursor (and optional sinceSeq). Used when the live Event socket
   * skipped a sequence without disconnecting.
   */
  async replayEvents(
    options: {
      jobId?: string
      sinceSeq?: number
      limit?: number
    } = {}
  ): Promise<number> {
    if (!this.isRunning) return 0
    const result = await this.request<{ published?: number }>(
      'events/replay',
      {
        consumerId: this.hostId,
        limit: options.limit ?? 4096,
        ...(options.jobId ? { jobId: options.jobId } : {}),
        ...(options.sinceSeq !== undefined ? { sinceSeq: options.sinceSeq } : {})
      },
      30_000
    )
    return typeof result.published === 'number' ? result.published : 0
  }

  async ensureStarted(): Promise<void> {
    if (this.isRunning) return
    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = null
      })
    }
    await this.startPromise
  }

  async request<T>(
    method: string,
    params: unknown = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<T> {
    if (signal?.aborted) throw createAbortError(method)
    await this.ensureStarted()
    if (signal?.aborted) throw createAbortError(method)
    const channel = this.channel
    if (!channel || !this.isRunning) throw new Error('Native worker is not running')

    const jobRoute = this.jobRoutes.get(method)
    if (jobRoute) {
      return await this.requestViaJob<T>(method, params, jobRoute, timeoutMs, signal)
    }

    return await new Promise<T>((resolveRequest, rejectRequest) => {
      const id = this.nextId
      this.nextId += 1
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        pending.removeAbortListener?.()
        this.sendCancellation(id)
        rejectRequest(new Error(`Native worker request timed out: ${method}`))
      }, timeoutMs)
      const pending: PendingRequest = {
        method,
        timer,
        resolve: (value) => resolveRequest(value as T),
        reject: rejectRequest
      }

      if (signal) {
        const handleAbort = (): void => {
          if (!this.pending.delete(id)) return
          clearTimeout(timer)
          this.sendCancellation(id)
          rejectRequest(createAbortError(method))
        }
        signal.addEventListener('abort', handleAbort, { once: true })
        pending.removeAbortListener = () => signal.removeEventListener('abort', handleAbort)
      }

      this.pending.set(id, pending)
      // The response comes back through handleFrame, the same ingress the event
      // stream uses, so correlation stays in one place.
      channel.send(id, method, params).catch((error) => {
        this.rejectPending(id, asError(error))
      })
    })
  }

  private async requestViaJob<T>(
    method: string,
    params: unknown,
    route: WorkerRouteDescriptor,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<T> {
    const source = isRecord(params) ? params : {}
    // Run-addressed jobs must use jobId === params.runId so durable events can address
    // the job. agent/session-send shares agent/run's stream and cancel semantics.
    const runAddressed =
      method === 'agent/run' ||
      method === 'agent/session-send' ||
      method === 'agent/compress-context'
    const runId = runAddressed
      ? (typeof source.runId === 'string' && source.runId.trim()) || randomUUID()
      : null
    const jobId = runId ?? randomUUID()
    let submission: JobSubmission
    try {
      submission = await this.request<JobSubmission>(
        'jobs/submit',
        {
          method,
          params: runId ? { ...source, runId } : params,
          jobId,
          idempotencyKey: jobId
        },
        30_000,
        signal
      )
    } catch (error) {
      if (signal?.aborted) {
        await this.request('jobs/cancel', { jobId }, 10_000).catch(() => {})
      }
      throw error
    }
    if (submission.accepted !== true || typeof submission.jobId !== 'string') {
      throw new Error(
        submission.error || `${submission.errorCode ?? 'queue_unavailable'}: Job was not committed`
      )
    }
    if (signal?.aborted) {
      await this.request('jobs/cancel', { jobId: submission.jobId }, 10_000).catch(() => {})
      throw createAbortError(method)
    }
    if (route.resultMode === 'accepted') {
      return {
        started: true,
        runId: submission.runId || runId || submission.jobId,
        jobId: submission.jobId,
        state: submission.state || 'queued',
        duplicate: submission.duplicate === true
      } as unknown as T
    }

    const deadline = Date.now() + timeoutMs
    let pollDelayMs = 100
    try {
      while (true) {
        if (signal?.aborted) throw createAbortError(method)
        if (Date.now() >= deadline) {
          throw new Error(
            `Background Job wait timed out: ${method} (jobId=${submission.jobId}); ` +
              'the Job continues in the worker.'
          )
        }
        const status = await this.request<JobStatus>(
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
        await waitForJobPoll(signal, pollDelayMs)
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

  async probe(): Promise<NativeWorkerProbe> {
    await this.ensureStarted()
    return {
      agentProtocolVersion:
        typeof this.runtimeInfo.protocolVersion === 'number' ? this.runtimeInfo.protocolVersion : 0,
      executable: this.executable ?? '(unknown)',
      pid: this.child?.pid ?? 0,
      protocolVersion: WORKER_PROTOCOL_VERSION,
      runtime:
        typeof this.runtimeInfo.runtime === 'string' ? this.runtimeInfo.runtime : '(unknown)',
      runtimeVersion:
        typeof this.runtimeInfo.version === 'string' ? this.runtimeInfo.version : '(unknown)',
      routeCount: this.routeCount
    }
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    const channel = this.channel
    const child = this.child
    this.channel = null
    this.child = null
    this.executable = null
    channel?.dispose()
    if (child && child.exitCode === null && !child.killed) child.kill()
    this.failPending(new Error('Native worker stopped'))
  }

  private async start(): Promise<void> {
    const workerPath = resolveWorkerPath(this.options.workerPath)
    if (!workerPath) {
      throw new Error(
        'OpenCowork Native Worker was not found. Re-run `npm install -g @aidotnet/opencowork`, ' +
          'or set OPEN_COWORK_NATIVE_WORKER_PATH to a published worker executable.'
      )
    }

    // Assigned right after spawn so the channel's guards can tell this worker
    // from a predecessor that is still dying.
    let ownChild: ChildProcess | null = null
    const ownsWorker = (): boolean => ownChild !== null && this.child === ownChild
    const channel = new WorkerHttpChannel({
      // Same id this client subscribes and acknowledges with, so the worker routes
      // its durable backlog to this client's stream.
      consumerId: this.hostId,
      isActive: () => ownsWorker() && this.isRunning,
      hooks: {
        onFrame: (frame, source) => this.handleFrame(frame, source),
        onControlFailure: (error) => {
          if (ownsWorker()) this.handleDisconnect(error)
        },
        onEventDisconnected: () => {
          // Requests still work; the channel retries on its own. The durable
          // outbox is authoritative, so nothing is lost meanwhile.
        },
        onEventReconnected: () => {
          if (!ownsWorker()) return
          // Republish anything the stream missed while it was detached.
          void this.request(
            'events/replay',
            { consumerId: this.hostId, limit: 4096 },
            30_000
          ).catch(() => {})
          this.events.emit('worker/event-reconnected', {}, { event: 'worker/event-reconnected' })
        }
      }
    })

    // stdout is piped because the worker publishes its chosen HTTP port there.
    const child = spawn(workerPath, channel.spawnArgs(this.hostId), {
      cwd: dirname(workerPath),
      env: {
        ...process.env,
        OPEN_COWORK_APP_VERSION: this.options.appVersion,
        OPEN_COWORK_NATIVE_SLOW_MS: process.env.OPEN_COWORK_NATIVE_SLOW_MS ?? '750'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    ownChild = child

    this.child = child
    this.channel = channel
    this.executable = workerPath
    this.stderrTail = []
    child.stderr?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString('utf8').split(/\r?\n/u).filter(Boolean)
      this.stderrTail.push(...lines)
      if (this.stderrTail.length > 40) this.stderrTail.splice(0, this.stderrTail.length - 40)
    })

    child.once('error', (error) => this.handleDisconnect(error))
    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      const tail = this.stderrTail.slice(-8).join('\n')
      this.handleDisconnect(
        new Error(
          `Native worker exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})` +
            (tail ? `\n${tail}` : '')
        )
      )
    })

    try {
      await channel.connect(child)

      const hello = await this.request<Record<string, unknown>>('worker/hello', {}, 10_000)
      if (hello.protocolVersion !== WORKER_PROTOCOL_VERSION) {
        throw new Error(
          `Native worker protocol mismatch: expected ${WORKER_PROTOCOL_VERSION}, ` +
            `received ${String(hello.protocolVersion)}`
        )
      }
      const routes = await this.request<{ methods?: unknown; routes?: unknown }>(
        'worker/routes',
        {},
        10_000
      )
      const methods = Array.isArray(routes.methods)
        ? routes.methods.filter((item): item is string => typeof item === 'string')
        : []
      this.jobRoutes.clear()
      if (Array.isArray(routes.routes)) {
        for (const route of routes.routes) {
          if (
            isRecord(route) &&
            typeof route.method === 'string' &&
            route.executionMode === 'job' &&
            typeof route.resultMode === 'string'
          ) {
            this.jobRoutes.set(route.method, {
              method: route.method,
              executionMode: route.executionMode,
              resultMode: route.resultMode
            })
          }
        }
      }
      for (const required of [
        'initialize',
        'db/initialize',
        'db/sessions-create',
        'agent/run',
        'agent/cancel',
        'agent/reverse-response',
        'jobs/submit',
        'jobs/result',
        'events/subscribe',
        'events/checkpoint'
      ]) {
        if (!methods.includes(required)) {
          throw new Error(`Native worker is missing required route: ${required}`)
        }
      }
      this.routeCount = methods.length
      this.runtimeInfo = await this.request<Record<string, unknown>>(
        'initialize',
        { runtime: 'agent' },
        10_000
      )
      const runtimeFeatures = isRecord(this.runtimeInfo.features) ? this.runtimeInfo.features : null
      const manifestVersions = Array.isArray(this.runtimeInfo.supportedManifestSchemaVersions)
        ? this.runtimeInfo.supportedManifestSchemaVersions
        : []
      if (
        this.runtimeInfo.ok !== true ||
        this.runtimeInfo.protocolVersion !== 2 ||
        runtimeFeatures?.capabilitySnapshot !== true ||
        runtimeFeatures.strictToolValidation !== true ||
        !manifestVersions.includes(2)
      ) {
        throw new Error(
          'OpenCowork Native Worker is missing the Agent Runtime v2 capability-snapshot contract.'
        )
      }
      // Desktop main calls db/initialize before any DAO traffic. Fresh CLI-only installs
      // never hit that path: RuntimeJobStore may create ~/.open-cowork/data.db with only
      // runtime_* tables, then db/sessions-create fails with "no such table: sessions".
      const dbInit = await this.request<{ success?: boolean; error?: string | null }>(
        'db/initialize',
        {},
        120_000
      )
      if (dbInit.success !== true) {
        throw new Error(dbInit.error || 'Native DB initialization failed')
      }
      await this.request('events/subscribe', { consumerId: this.hostId, limit: 4096 }, 30_000)
      this.startHeartbeat()
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = setInterval(() => {
      if (!this.isRunning) return
      void this.request('worker/ping', {}, 5_000).catch((error) => this.handleDisconnect(error))
    }, HEARTBEAT_INTERVAL_MS)
    this.heartbeat.unref?.()
  }

  private sendCancellation(id: number): void {
    if (!this.channel || !this.isRunning) return
    this.channel.cancel(id)
  }

  private handleFrame(decoded: unknown, _source: 'control' | 'event'): void {
    if (!isRecord(decoded)) return

    const eventFrame = decoded as WorkerEventFrame
    if (typeof eventFrame.event === 'string' && eventFrame.event) {
      const params = 'params' in eventFrame ? eventFrame.params : decoded
      this.events.emit(eventFrame.event, params, decoded)
      return
    }

    const response = decoded as WorkerResponse
    if (typeof response.id !== 'number') return
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.pending.delete(response.id)
    clearTimeout(pending.timer)
    pending.removeAbortListener?.()
    if (typeof response.error === 'string' && response.error) {
      pending.reject(new Error(response.error))
    } else {
      pending.resolve(response.result)
    }
  }

  private rejectPending(id: number, error: Error): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.removeAbortListener?.()
    pending.reject(error)
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.removeAbortListener?.()
      pending.reject(error)
    }
    this.pending.clear()
  }

  private handleDisconnect(error: unknown): void {
    if (!this.child && !this.channel) return
    const channel = this.channel
    const child = this.child
    this.channel = null
    this.child = null
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    channel?.dispose()
    if (child && child.exitCode === null && !child.killed) child.kill()
    const failure = asError(error)
    this.failPending(failure)
    this.events.emit('worker/disconnected', failure, { event: 'worker/disconnected' })
  }
}
