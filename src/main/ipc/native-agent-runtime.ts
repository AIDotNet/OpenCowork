import { getNativeWorker, type NativeWorkerRawEventFrame } from '../lib/native-worker'
import type { RuntimeInitializeResultV2 } from '../../shared/agent-runtime-v2'

type RawEventHandler = (frame: NativeWorkerRawEventFrame) => void
type RequestHandler = (id: number | string, method: string, params: unknown) => Promise<unknown>
type ReverseCancelHandler = (id: number | string, method?: string) => void

type NativeReverseRequest = {
  id?: number | string
  method?: string
  params?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export class NativeAgentRuntimeManager {
  private running = false
  private rawEventHandler: RawEventHandler | null = null
  private rawEventListeners = new Set<RawEventHandler>()
  private requestHandler: RequestHandler | null = null
  private reverseCancelHandler: ReverseCancelHandler | null = null
  private unsubscribeRawAgentStream: (() => void) | null = null
  private unsubscribeReverseRequest: (() => void) | null = null
  private unsubscribeReverseCancel: (() => void) | null = null
  private unsubscribeReconnect: (() => void) | null = null
  private activeRunIds = new Set<string>()
  private initializeResult: RuntimeInitializeResultV2 | null = null

  get isRunning(): boolean {
    return this.running && getNativeWorker().isRunning
  }

  get runtimeCapabilities(): RuntimeInitializeResultV2 | null {
    return this.initializeResult
  }

  setRawEventHandler(handler: RawEventHandler): void {
    this.rawEventHandler = handler
  }

  addRawEventListener(handler: RawEventHandler): () => void {
    this.rawEventListeners.add(handler)
    this.installEventBridge()
    return () => {
      this.rawEventListeners.delete(handler)
    }
  }

  setRequestHandler(handler: RequestHandler): void {
    this.requestHandler = handler
  }

  setReverseCancelHandler(handler: ReverseCancelHandler): void {
    this.reverseCancelHandler = handler
    this.installEventBridge()
  }

  setSessionVisibility(sessionId: string, visible: boolean): void {
    this.notify('agent/session-visibility', { sessionId, visible })
  }

  onDisconnect(listener: () => void): () => void {
    return getNativeWorker().onDisconnect(listener)
  }

  onReconnect(listener: () => void): () => void {
    return getNativeWorker().onReconnect(listener)
  }

  hasActiveRuns(): boolean {
    return this.activeRunIds.size > 0
  }

  async start(): Promise<boolean> {
    await getNativeWorker().ensureStarted()
    this.installEventBridge()
    const result = await getNativeWorker().request('initialize', { runtime: 'agent' }, 30_000)
    this.initializeResult = this.validateInitializeResult(result)
    this.running = true
    return true
  }

  async ensureStarted(): Promise<boolean> {
    if (this.isRunning) return true
    return await this.start()
  }

  async stop(): Promise<void> {
    if (getNativeWorker().isRunning) {
      await getNativeWorker()
        .request('shutdown', { runtime: 'agent' }, 30_000)
        .catch(() => {})
    }
    this.activeRunIds.clear()
    this.initializeResult = null
    this.running = false
    this.unsubscribeRawAgentStream?.()
    this.unsubscribeRawAgentStream = null
    this.unsubscribeReverseRequest?.()
    this.unsubscribeReverseRequest = null
    this.unsubscribeReverseCancel?.()
    this.unsubscribeReverseCancel = null
    this.unsubscribeReconnect?.()
    this.unsubscribeReconnect = null
  }

  // The supervisor may respawn a fresh worker underneath us. The new process is
  // blank, so re-run the agent handshake and drop the run ids it never knew.
  private async handleWorkerReconnected(): Promise<void> {
    this.activeRunIds.clear()
    if (!this.running) return

    try {
      const result = await getNativeWorker().request('initialize', { runtime: 'agent' }, 30_000)
      this.initializeResult = this.validateInitializeResult(result)
      console.log('[NativeAgentRuntime] re-initialized after worker restart')
    } catch (error) {
      this.running = false
      this.initializeResult = null
      console.warn(
        `[NativeAgentRuntime] re-initialize after worker restart failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  private validateInitializeResult(result: unknown): RuntimeInitializeResultV2 {
    if (!isRecord(result) || result.ok !== true) {
      throw new Error('Native Agent Runtime initialize returned an invalid result')
    }
    if (result.protocolVersion !== 2) {
      throw new Error(`Unsupported Native Agent Runtime protocol: ${String(result.protocolVersion)}`)
    }
    if (!isRecord(result.features)) {
      throw new Error('Native Agent Runtime did not report feature capabilities')
    }
    if (result.features.capabilitySnapshot !== true || result.features.strictToolValidation !== true) {
      throw new Error('Native Agent Runtime is missing required v2 safety features')
    }
    return result as unknown as RuntimeInitializeResultV2
  }

  async request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    await this.ensureStarted()
    const result = await getNativeWorker().request(method, params ?? {}, timeoutMs)
    if (
      method === 'agent/run' &&
      isRecord(result) &&
      result.started === true &&
      typeof result.runId === 'string'
    ) {
      this.activeRunIds.add(result.runId)
    }
    return result
  }

  notify(method: string, params?: unknown): void {
    if (!this.running) return
    void getNativeWorker()
      .request(method, params ?? {}, 10_000)
      .catch((error) => {
        console.warn(
          `[NativeAgentRuntime] notify failed: ${method}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      })
  }

  private installEventBridge(): void {
    if (!this.unsubscribeRawAgentStream) {
      this.unsubscribeRawAgentStream = getNativeWorker().onRawEvent('agent/stream', (frame) => {
        if (frame.hasTerminalEvent && frame.runId) {
          this.activeRunIds.delete(frame.runId)
        }
        this.rawEventHandler?.(frame)
        for (const listener of this.rawEventListeners) {
          listener(frame)
        }
      })
    }

    if (!this.unsubscribeReverseRequest) {
      this.unsubscribeReverseRequest = getNativeWorker().onEvent(
        'agent/reverse-request',
        (params) => {
          void this.handleReverseRequest(params as NativeReverseRequest)
        }
      )
    }

    if (!this.unsubscribeReverseCancel) {
      this.unsubscribeReverseCancel = getNativeWorker().onEvent(
        'agent/reverse-cancel',
        (params) => {
          const request = params as NativeReverseRequest
          const id = request?.id
          if (typeof id !== 'number' && typeof id !== 'string') return
          this.reverseCancelHandler?.(
            id,
            typeof request.method === 'string' ? request.method : undefined
          )
        }
      )
    }

    if (!this.unsubscribeReconnect) {
      this.unsubscribeReconnect = getNativeWorker().onReconnect(() => {
        void this.handleWorkerReconnected()
      })
    }
  }

  private async handleReverseRequest(request: NativeReverseRequest): Promise<void> {
    const id = request?.id
    const method = request?.method
    if ((typeof id !== 'number' && typeof id !== 'string') || typeof method !== 'string') {
      return
    }

    if (!this.requestHandler) {
      await this.sendReverseResponse(id, undefined, 'No reverse request handler registered')
      return
    }

    try {
      const result = await this.requestHandler(id, method, request.params ?? {})
      await this.sendReverseResponse(id, result, undefined)
    } catch (error) {
      await this.sendReverseResponse(
        id,
        undefined,
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  private async sendReverseResponse(
    id: number | string,
    result: unknown,
    error: string | undefined
  ): Promise<void> {
    await getNativeWorker()
      .request(
        'agent/reverse-response',
        {
          id,
          ...(typeof error === 'string' ? { error } : { result })
        },
        30_000
      )
      .catch((sendError) => {
        console.warn(
          `[NativeAgentRuntime] reverse response failed: ${
            sendError instanceof Error ? sendError.message : String(sendError)
          }`
        )
      })
  }
}

let nativeAgentRuntimeManager: NativeAgentRuntimeManager | null = null

export function getNativeAgentRuntimeManager(): NativeAgentRuntimeManager {
  if (!nativeAgentRuntimeManager) {
    nativeAgentRuntimeManager = new NativeAgentRuntimeManager()
  }
  return nativeAgentRuntimeManager
}
