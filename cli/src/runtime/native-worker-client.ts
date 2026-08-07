import { decode, encode } from '@msgpack/msgpack'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, rmSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FRAME_HEADER_BYTES = 4
const MAX_FRAME_BYTES = 256 * 1024 * 1024
const CONNECT_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 60_000
const HEARTBEAT_INTERVAL_MS = 15_000
const WORKER_PROTOCOL_VERSION = 1

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

function createFrame(payload: Uint8Array): Buffer {
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength)
  frame.writeUInt32BE(payload.byteLength, 0)
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(
    frame,
    FRAME_HEADER_BYTES
  )
  return frame
}

function getCurrentRid(): string {
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
      'net10.0',
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
      'net10.0',
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
      'net10.0',
      executable
    ),
    join(
      repositoryDirectory,
      'sidecars',
      'OpenCowork.Native.Worker',
      'bin',
      'Debug',
      'net10.0',
      executable
    )
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function createEndpoint(): string {
  const suffix = randomUUID().replaceAll('-', '')
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\open-cowork-cli-${process.pid}-${suffix}`
    : `/tmp/open-cowork-cli-${process.pid}-${suffix}.sock`
}

async function connectToEndpoint(endpoint: string, child: ChildProcess): Promise<Socket> {
  const startedAt = Date.now()
  let lastError: Error | null = null

  while (Date.now() - startedAt < CONNECT_TIMEOUT_MS) {
    if (child.exitCode !== null) {
      throw new Error(`Native worker exited before IPC connected (code ${child.exitCode})`)
    }

    try {
      return await new Promise<Socket>((resolveConnection, rejectConnection) => {
        const socket = createConnection(endpoint)
        const handleConnect = (): void => {
          socket.off('error', handleError)
          resolveConnection(socket)
        }
        const handleError = (error: Error): void => {
          socket.off('connect', handleConnect)
          socket.destroy()
          rejectConnection(error)
        }
        socket.once('connect', handleConnect)
        socket.once('error', handleError)
      })
    } catch (error) {
      lastError = asError(error)
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 35))
    }
  }

  throw new Error(`Timed out connecting to Native Worker: ${lastError?.message ?? endpoint}`)
}

export class NativeWorkerClient {
  private child: ChildProcess | null = null
  private socket: Socket | null = null
  private endpoint: string | null = null
  private executable: string | null = null
  private startPromise: Promise<void> | null = null
  private readChunks: Buffer[] = []
  private readBufferedBytes = 0
  private pendingFrameLength = -1
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private events = new EventEmitter()
  private stderrTail: string[] = []
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private runtimeInfo: Record<string, unknown> = {}
  private routeCount = 0

  constructor(private readonly options: NativeWorkerClientOptions) {}

  get isRunning(): boolean {
    return Boolean(
      this.child &&
      this.child.exitCode === null &&
      !this.child.killed &&
      this.socket &&
      !this.socket.destroyed
    )
  }

  on(eventName: string, listener: WorkerEventListener): () => void {
    this.events.on(eventName, listener)
    return () => this.events.off(eventName, listener)
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
    const socket = this.socket
    if (!socket || !this.isRunning) throw new Error('Native worker is not running')

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
      try {
        socket.write(createFrame(encode({ id, method, params })), (error) => {
          if (!error) return
          this.rejectPending(id, error)
        })
      } catch (error) {
        this.rejectPending(id, asError(error))
      }
    })
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
    const socket = this.socket
    const child = this.child
    const endpoint = this.endpoint
    this.socket = null
    this.child = null
    this.endpoint = null
    this.executable = null
    socket?.removeAllListeners()
    socket?.destroy()
    if (child && child.exitCode === null && !child.killed) child.kill()
    if (endpoint && process.platform !== 'win32') rmSync(endpoint, { force: true })
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

    const endpoint = createEndpoint()
    if (process.platform !== 'win32') rmSync(endpoint, { force: true })
    const child = spawn(workerPath, ['--ipc', endpoint], {
      cwd: dirname(workerPath),
      env: {
        ...process.env,
        OPEN_COWORK_APP_VERSION: this.options.appVersion,
        OPEN_COWORK_NATIVE_SLOW_MS: process.env.OPEN_COWORK_NATIVE_SLOW_MS ?? '750'
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })

    this.child = child
    this.endpoint = endpoint
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
      const socket = await connectToEndpoint(endpoint, child)
      this.socket = socket
      socket.on('data', (chunk) => this.handleSocketData(chunk))
      socket.on('error', (error) => this.handleDisconnect(error))
      socket.on('close', () => {
        if (this.socket === socket) this.handleDisconnect(new Error('Native worker IPC closed'))
      })

      const hello = await this.request<Record<string, unknown>>('worker/hello', {}, 10_000)
      if (hello.protocolVersion !== WORKER_PROTOCOL_VERSION) {
        throw new Error(
          `Native worker protocol mismatch: expected ${WORKER_PROTOCOL_VERSION}, ` +
            `received ${String(hello.protocolVersion)}`
        )
      }
      const routes = await this.request<{ methods?: unknown }>('worker/routes', {}, 10_000)
      const methods = Array.isArray(routes.methods)
        ? routes.methods.filter((item): item is string => typeof item === 'string')
        : []
      for (const required of [
        'initialize',
        'agent/run',
        'agent/cancel',
        'agent/reverse-response'
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
    if (!this.socket || !this.isRunning) return
    try {
      this.socket.write(createFrame(encode({ cancel: id })))
    } catch {
      // The original request is already rejected locally.
    }
  }

  private handleSocketData(chunk: Buffer): void {
    this.readChunks.push(chunk)
    this.readBufferedBytes += chunk.length

    while (true) {
      if (this.pendingFrameLength < 0) {
        if (this.readBufferedBytes < FRAME_HEADER_BYTES) return
        const header = this.consumeBytes(FRAME_HEADER_BYTES)
        const length = header.readUInt32BE(0)
        if (length <= 0 || length > MAX_FRAME_BYTES) {
          this.handleDisconnect(new Error(`Invalid native worker frame length: ${length}`))
          return
        }
        this.pendingFrameLength = length
      }
      if (this.readBufferedBytes < this.pendingFrameLength) return
      const payload = this.consumeBytes(this.pendingFrameLength)
      this.pendingFrameLength = -1
      this.handleFrame(payload)
    }
  }

  private consumeBytes(count: number): Buffer {
    const first = this.readChunks[0]
    if (first && first.length >= count) {
      const output = first.subarray(0, count)
      if (first.length === count) this.readChunks.shift()
      else this.readChunks[0] = first.subarray(count)
      this.readBufferedBytes -= count
      return output
    }

    const output = Buffer.allocUnsafe(count)
    let offset = 0
    while (offset < count) {
      const current = this.readChunks[0]
      if (!current) throw new Error('Native worker frame buffer underflow')
      const length = Math.min(current.length, count - offset)
      current.copy(output, offset, 0, length)
      if (length === current.length) this.readChunks.shift()
      else this.readChunks[0] = current.subarray(length)
      offset += length
    }
    this.readBufferedBytes -= count
    return output
  }

  private handleFrame(payload: Buffer): void {
    let decoded: unknown
    try {
      decoded = decode(payload)
    } catch (error) {
      this.handleDisconnect(
        new Error(`Invalid worker MessagePack frame: ${asError(error).message}`)
      )
      return
    }
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
    if (!this.child && !this.socket) return
    const socket = this.socket
    const child = this.child
    const endpoint = this.endpoint
    this.socket = null
    this.child = null
    this.endpoint = null
    this.readChunks = []
    this.readBufferedBytes = 0
    this.pendingFrameLength = -1
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    socket?.removeAllListeners()
    socket?.destroy()
    if (child && child.exitCode === null && !child.killed) child.kill()
    if (endpoint && process.platform !== 'win32') rmSync(endpoint, { force: true })
    const failure = asError(error)
    this.failPending(failure)
    this.events.emit('worker/disconnected', failure, { event: 'worker/disconnected' })
  }
}
