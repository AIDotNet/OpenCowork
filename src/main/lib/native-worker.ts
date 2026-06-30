import { app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as net from 'net'
import * as path from 'path'
import { decode, encode } from '@msgpack/msgpack'
import { readNativeMessagePackRoute, type NativeMessagePackRoute } from './messagepack-route-reader'

const DEFAULT_NATIVE_WORKER_TIMEOUT_MS = 60_000
const DEFAULT_NATIVE_WORKER_SLOW_REQUEST_MS = 750
const NATIVE_WORKER_CONNECT_TIMEOUT_MS = 10_000
const NATIVE_WORKER_CONNECT_RETRY_MS = 35
const FRAME_HEADER_BYTES = 4
const MAX_FRAME_BYTES = 256 * 1024 * 1024
const REQUIRED_NATIVE_WORKER_METHODS = [
  'settings/read',
  'settings/get',
  'settings/set',
  'settings/delete',
  'souls/builtin-list',
  'sync/files-capture',
  'sync/files-apply',
  'sync/files-delete'
]

type PendingRequest = {
  method: string
  startedAt: number
  payloadBytes: number
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
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
  private readBuffer = Buffer.alloc(0)
  private nextId = 1
  private startPromise: Promise<void> | null = null
  private stopping = false

  get isRunning(): boolean {
    return (
      this.child !== null &&
      !this.child.killed &&
      this.child.exitCode === null &&
      this.socket !== null &&
      !this.socket.destroyed
    )
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

  async request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs = DEFAULT_NATIVE_WORKER_TIMEOUT_MS
  ): Promise<T> {
    await this.ensureStarted()
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
      timeoutMs
    })

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        console.warn('[NativeWorker] request timeout', {
          id,
          method,
          elapsedMs: Date.now() - startedAt,
          payloadBytes,
          pending: this.pending.size
        })
        reject(new Error(`Native worker request timed out: ${method}`))
      }, timeoutMs)

      this.pending.set(id, {
        method,
        startedAt,
        payloadBytes,
        resolve: (value) => resolve(value as T),
        reject,
        timer
      })

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
    this.stopping = true
    this.closeWorker(new Error('Native worker stopped'))
    this.stopping = false
  }

  private async start(): Promise<void> {
    const workerPath = resolveNativeWorkerPath()
    if (!workerPath) {
      throw new Error(
        'Native worker is missing. Run `npm run native:publish` before starting OpenCowork.'
      )
    }

    const endpoint = createNativeWorkerEndpoint()
    cleanupNativeWorkerEndpoint(endpoint)
    const childEnv = createNativeWorkerEnv()
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
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text) console.warn(`[NativeWorker] ${text}`)
    })
    child.on('error', (error) => this.closeWorker(error))
    child.on('exit', (code, signal) => {
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
    } catch (error) {
      this.closeWorker(asError(error))
      throw error
    }
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
    const missing = REQUIRED_NATIVE_WORKER_METHODS.filter((method) => !methods.has(method))
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

  private handleSocketData(chunk: Buffer): void {
    this.readBuffer = Buffer.concat([this.readBuffer, chunk])

    while (this.readBuffer.length >= FRAME_HEADER_BYTES) {
      const length = this.readBuffer.readUInt32BE(0)
      if (length <= 0 || length > MAX_FRAME_BYTES) {
        this.closeWorker(new Error(`Invalid native worker frame length: ${length}`))
        return
      }

      const frameLength = FRAME_HEADER_BYTES + length
      if (this.readBuffer.length < frameLength) {
        return
      }

      const payload = this.readBuffer.subarray(FRAME_HEADER_BYTES, frameLength)
      this.readBuffer = this.readBuffer.subarray(frameLength)
      this.handleResponseFrame(payload)
    }
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
    const child = this.child
    const socket = this.socket
    const endpoint = this.endpoint

    this.child = null
    this.socket = null
    this.endpoint = null
    this.readBuffer = Buffer.alloc(0)

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
    }
    if (endpoint) {
      cleanupNativeWorkerEndpoint(endpoint)
    }

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

let nativeWorker: NativeWorkerManager | null = null

export function getNativeWorker(): NativeWorkerManager {
  nativeWorker ??= new NativeWorkerManager()
  return nativeWorker
}

export async function stopNativeWorker(): Promise<void> {
  await nativeWorker?.stop()
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createNativeWorkerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (readBooleanEnv('OPEN_COWORK_NATIVE_DEBUG') === null && !app.isPackaged) {
    env.OPEN_COWORK_NATIVE_DEBUG = '1'
  }
  env.OPEN_COWORK_NATIVE_SLOW_MS ??= String(getNativeWorkerSlowRequestMs())
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

function resolveNativeWorkerPath(): string | null {
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
    : [releaseNativePath, resourceWorkerPath, releasePublishPath]

  return candidates.find(isNativeWorkerCandidateReady) ?? null
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
  const sqliteLibrary = getSqliteNativeLibraryNames().find((name) =>
    fs.existsSync(path.join(candidateDir, name))
  )
  if (sqliteLibrary) return true

  console.warn('[NativeWorker] skipping candidate with missing SQLite native library', {
    workerPath: candidate,
    expected: getSqliteNativeLibraryNames()
  })
  return false
}

function getSqliteNativeLibraryNames(): string[] {
  if (process.platform === 'win32') return ['e_sqlite3.dll']
  if (process.platform === 'darwin') return ['libe_sqlite3.dylib', 'e_sqlite3.dylib']
  if (process.platform === 'linux') return ['libe_sqlite3.so', 'e_sqlite3.so']
  return ['libe_sqlite3']
}
