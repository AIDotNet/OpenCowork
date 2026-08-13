import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { safePostMessageToWindow, safeSendMessagePackToAllWindows } from '../window-ipc'
import {
  AGENT_STREAM_MSGPACK_CHANNEL,
  decodeAgentStreamEnvelope,
  encodeAgentStreamEnvelope
} from '../../shared/messagepack/agent-stream-codec'
import type { AgentStreamEvent, ToolCallStateWire } from '../../shared/agent-stream-protocol'
import { AGENT_STREAM_PROTOCOL_VERSION } from '../../shared/agent-stream-protocol'
import type { InteractiveAgentEvent, ToolCallState } from '../../shared/agent-loop-types'
import {
  SIDECAR_APPROVAL_RESPONSE_MSGPACK_CHANNEL,
  SIDECAR_RENDERER_TOOL_RESPONSE_MSGPACK_CHANNEL,
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'
import { getNativeAgentRuntimeManager } from './native-agent-runtime'
import { getRuntimeRegistry } from './runtime-registry'
import { getRuntimeProjectionHost } from './agent-runtime/runtime-projection'
import { getWorkerEventConsumer } from './agent-runtime/worker-event-consumer-host'
import { registerRuntimeIpcHandlers } from './agent-runtime/runtime-ipc-handlers'
import {
  createHostReverseRequestHandler,
  handleCodeGraphRequest
} from './agent-runtime/host-reverse-requests'
import {
  registerRuntimeCommandGateway,
  type TrackedRun
} from './agent-runtime/runtime-command-gateway'
import { RunTargetRouter } from './agent-runtime/run-target-router'
import { UiCapabilityRouter } from './agent-runtime/ui-capability-router'
import { asOptionalRecord } from './agent-runtime/request-utils'
import { getNativeWorker, stopNativeWorker } from '../lib/native-worker'
import { getGoalRuntimeService } from '../goals/goal-runtime'
import { emitGoalContinueRequested } from '../goals/goal-sync'
import { cancelHookRuns } from '../hooks/hooks-service'
import { HOOK_REVERSE_METHODS } from '../../shared/hooks/types'

export { handleCodeGraphRequest }

const DEBUG_BODY_TEMP_DIR = join(tmpdir(), 'opencowork-request-debug-bodies')
const CODEGRAPH_METHOD_PREFIX = 'codegraph/'

type SidecarBridgeManager = {
  setRawEventHandler: (
    handler: (frame: import('../lib/native-worker').NativeWorkerRawEventFrame) => void
  ) => void
  addRawEventListener: (
    handler: (frame: import('../lib/native-worker').NativeWorkerRawEventFrame) => void
  ) => () => void
  setRequestHandler: (
    handler: (id: number | string, method: string, params: unknown) => Promise<unknown>
  ) => void
  setReverseCancelHandler: (handler: (id: number | string, method?: string) => void) => void
  onDisconnect: (listener: () => void) => () => void
  onReconnect: (listener: () => void) => () => void
  setSessionVisibility: (sessionId: string, visible: boolean) => void
  start: () => Promise<boolean>
  ensureStarted: () => Promise<boolean>
  stop: () => Promise<void>
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>
  notify: (method: string, params?: unknown) => void
  hasActiveRuns: () => boolean
  readonly isRunning: boolean
}

function registerMessagePackInvokeHandler<TArgs>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, args: TArgs) => Promise<unknown> | unknown
): void {
  ipcMain.handle(toMessagePackChannel(channel), async (event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<TArgs>(bytes)
    return encodeMessagePackPayload(await handler(event, args))
  })
}

function registerSidecarMessagePackHandler<TArgs>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, args: TArgs) => Promise<unknown> | unknown
): void {
  ipcMain.handle(toMessagePackChannel(channel), async (event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<TArgs>(bytes)
    return encodeMessagePackPayload(await handler(event, args))
  })
}

export function getSidecarManager(): SidecarBridgeManager {
  return getNativeAgentRuntimeManager()
}

function readBooleanEnv(name: string, defaultValue = false): boolean {
  const raw = process.env[name]
  if (raw === undefined) return defaultValue

  switch (raw.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false
    default:
      return defaultValue
  }
}

function isMessagePackTraceEnabled(): boolean {
  return readBooleanEnv('OPEN_COWORK_MSGPACK_TRACE', false)
}

function logMessagePackTrace(message: string, details: Record<string, unknown>): void {
  if (!isMessagePackTraceEnabled()) return
  console.log(`[Sidecar][MessagePack] ${message}`, details)
}

function normalizeInteractiveToolCall(toolCall: ToolCallStateWire): ToolCallState {
  return {
    id: toolCall.id,
    name: toolCall.name,
    input: toolCall.input,
    status: toolCall.status === 'canceled' ? 'error' : toolCall.status,
    output: toolCall.output,
    error:
      toolCall.error ?? (toolCall.status === 'canceled' ? 'Tool call was canceled' : undefined),
    requiresApproval: toolCall.requiresApproval,
    startedAt: toolCall.startedAt,
    completedAt: toolCall.completedAt
  }
}

function mapNativeGoalRuntimeEvent(event: AgentStreamEvent): InteractiveAgentEvent | null {
  switch (event.type) {
    case 'tool_use_streaming_start':
      return {
        type: 'tool_use_streaming_start',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...(event.extraContent
          ? { toolCallExtraContent: asOptionalRecord(event.extraContent) }
          : {})
      }
    case 'tool_use_generated':
      return {
        type: 'tool_use_generated',
        toolUseBlock: {
          id: event.toolUseBlock.id,
          name: event.toolUseBlock.name,
          input: event.toolUseBlock.input,
          ...(event.toolUseBlock.extraContent
            ? { extraContent: asOptionalRecord(event.toolUseBlock.extraContent) }
            : {})
        }
      }
    case 'tool_call_start':
      return {
        type: 'tool_call_start',
        toolCall: normalizeInteractiveToolCall(event.toolCall)
      }
    case 'tool_call_result':
      return {
        type: 'tool_call_result',
        toolCall: normalizeInteractiveToolCall(event.toolCall)
      }
    case 'message_end':
      return {
        type: 'message_end',
        usage: event.usage,
        timing: event.timing,
        providerResponseId: event.providerResponseId
      }
    case 'error':
      return {
        type: 'error',
        error: Object.assign(new Error(event.message), {
          name: event.errorType ?? 'NativeAgentError',
          details: event.details,
          stack: event.stackTrace
        })
      }
    case 'loop_end':
      return {
        type: 'loop_end',
        reason: event.reason
      }
    default:
      return null
  }
}

async function observeGoalRuntimeFrame(bytes: Uint8Array | Buffer): Promise<void> {
  let envelope: ReturnType<typeof decodeAgentStreamEnvelope>
  try {
    envelope = decodeAgentStreamEnvelope(bytes)
  } catch (error) {
    console.warn(
      '[Sidecar] Failed to decode native stream for goal runtime:',
      error instanceof Error ? error.message : String(error)
    )
    return
  }

  const goalRuntime = getGoalRuntimeService()
  const hasError = envelope.events.some((event) => event.type === 'error')
  const hasLoopEnd = envelope.events.some((event) => event.type === 'loop_end')
  for (const event of envelope.events) {
    const mapped = mapNativeGoalRuntimeEvent(event)
    if (!mapped) continue
    await goalRuntime.observeEvent(envelope.runId, mapped)
  }

  if (hasError && !hasLoopEnd) {
    await goalRuntime.observeEvent(envelope.runId, { type: 'loop_end', reason: 'error' })
  }

  if (!hasLoopEnd && !hasError) {
    return
  }

  const result = await goalRuntime.finalizeRun(envelope.runId)
  if (result.requestContinue && result.sessionId) {
    emitGoalContinueRequested({
      sessionId: result.sessionId,
      goalId: result.goalId,
      reason: 'goal-auto-continue'
    })
  }
}

/**
 * Register IPC handlers for the sidecar bridge.
 * Renderer sends requests to sidecar via main process.
 */
export function registerSidecarHandlers(): void {
  cleanupDebugBodyTempFiles()
  const manager = getSidecarManager()
  const windows = new RunTargetRouter()
  const activeRunSessions = new Map<string, TrackedRun>()
  const goalRuntimeObservationChains = new Map<string, Promise<void>>()

  const sendReverseRequest = (
    targetWindow: BrowserWindow,
    msgpackChannel: string,
    payload: unknown
  ): boolean => {
    const bytes = encodeMessagePackPayload(payload)
    const sent = safePostMessageToWindow(targetWindow, msgpackChannel, bytes)
    logMessagePackTrace('reverse request sent', {
      channel: msgpackChannel,
      sent,
      bytes: bytes.byteLength
    })
    return sent
  }

  const uiCapabilities = new UiCapabilityRouter<BrowserWindow>({
    resolveWindow: (params) => windows.resolve(params),
    sendReverseRequest
  })

  const buildSidecarDiagnostics = (
    runId?: string,
    sessionId?: string,
    trackedRunOverride?: TrackedRun
  ): Record<string, unknown> => {
    const worker = getNativeWorker().getDiagnosticsSnapshot()
    const trackedRun = trackedRunOverride ?? (runId ? activeRunSessions.get(runId) : undefined)
    const journalFrames = runId ? getRuntimeRegistry().getFramesSince(runId, -1).length : 0
    return {
      capturedAt: Date.now(),
      worker,
      agentRuntime: getNativeAgentRuntimeManager().getDiagnosticsSnapshot(),
      stream: {
        runId: runId ?? null,
        sessionId: sessionId ?? trackedRun?.sessionId ?? null,
        tracked: Boolean(trackedRun),
        dispatchedAt: trackedRun?.dispatchedAt ?? null,
        accepted: trackedRun?.acceptedAt !== null && trackedRun?.acceptedAt !== undefined,
        acceptedAt: trackedRun?.acceptedAt ?? null,
        lastEventAt: trackedRun?.lastEventAt ?? null,
        jobState: trackedRun?.jobState ?? null,
        lastSeq: trackedRun?.lastSeq ?? null,
        journalFrames,
        mappedRunWindowId: runId ? windows.getRunWindowId(runId) : null,
        mappedSessionWindowId: sessionId ? windows.getSessionWindowId(sessionId) : null
      },
      durableConsumer: getWorkerEventConsumer().getDiagnostics()
    }
  }

  getRuntimeRegistry().setApprovalSnapshotSupplier(() => uiCapabilities.getApprovalSnapshots())

  const sendAgentStreamBytes = (
    targetWindow: BrowserWindow,
    bytes: Uint8Array | Buffer,
    details: Record<string, unknown>
  ): boolean => {
    const sent = safePostMessageToWindow(targetWindow, AGENT_STREAM_MSGPACK_CHANNEL, bytes)
    logMessagePackTrace('agent stream sent', {
      channel: AGENT_STREAM_MSGPACK_CHANNEL,
      sent,
      bytes: bytes.byteLength,
      ...details
    })
    return sent
  }

  const queueGoalRuntimeObservation = (
    frame: import('../lib/native-worker').NativeWorkerRawEventFrame
  ): void => {
    if (!frame.runId) {
      void observeGoalRuntimeFrame(frame.bytes).catch((error) => {
        console.warn(
          '[Sidecar] Goal runtime stream observation failed:',
          error instanceof Error ? error.message : String(error)
        )
      })
      return
    }

    if (!getGoalRuntimeService().hasRun(frame.runId)) {
      return
    }

    const runId = frame.runId
    const previous = goalRuntimeObservationChains.get(runId) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(() => observeGoalRuntimeFrame(frame.bytes))
      .catch((error) => {
        console.warn(
          '[Sidecar] Goal runtime stream observation failed:',
          error instanceof Error ? error.message : String(error)
        )
      })

    goalRuntimeObservationChains.set(runId, next)
    void next.finally(() => {
      if (goalRuntimeObservationChains.get(runId) === next) {
        goalRuntimeObservationChains.delete(runId)
      }
    })
  }

  const STREAM_BATCH_FLUSH_MS = 33
  const STREAM_BATCH_MAX_BYTES = 256 * 1024
  interface PendingStreamBatch {
    frames: Buffer[]
    byteLength: number
    timer: NodeJS.Timeout | null
    runId: string
    sessionId: string
    lastSeq: number
  }
  const pendingStreamBatches = new Map<string, PendingStreamBatch>()

  const recoverDurableEventPump = async (
    runId?: string
  ): Promise<{ published: number; jobState: string | null }> => {
    const recovery = await getWorkerEventConsumer().recoverPump(runId)
    if (runId && recovery.jobState) {
      const tracked = activeRunSessions.get(runId)
      if (tracked && (recovery.jobState === 'queued' || recovery.jobState === 'running')) {
        activeRunSessions.set(runId, {
          ...tracked,
          jobState: recovery.jobState === 'running' ? 'running' : 'queued'
        })
      }
    }
    return recovery
  }

  const STALLED_STREAM_RECOVERY_MS = 8_000
  const stalledStreamRecoveryAt = new Map<string, number>()
  const stalledStreamWatchdog = setInterval(() => {
    if (!manager.isRunning || activeRunSessions.size === 0) return
    const now = Date.now()
    for (const [runId, info] of activeRunSessions) {
      if (info.lastEventAt != null || info.acceptedAt == null) continue
      if (now - info.acceptedAt < STALLED_STREAM_RECOVERY_MS) continue
      const lastAttempt = stalledStreamRecoveryAt.get(runId) ?? 0
      if (now - lastAttempt < STALLED_STREAM_RECOVERY_MS) continue
      stalledStreamRecoveryAt.set(runId, now)
      console.warn('[Sidecar] proactive stalled-stream recovery', {
        runId,
        sessionId: info.sessionId,
        waitedMs: now - info.acceptedAt
      })
      void recoverDurableEventPump(runId).catch((error) => {
        console.warn('[Sidecar] proactive stalled-stream recovery failed', {
          runId,
          error: error instanceof Error ? error.message : String(error)
        })
      })
    }
    for (const runId of Array.from(stalledStreamRecoveryAt.keys())) {
      if (!activeRunSessions.has(runId)) stalledStreamRecoveryAt.delete(runId)
    }
  }, 2_000)
  stalledStreamWatchdog.unref?.()

  const flushStreamBatch = (runId: string): void => {
    const batch = pendingStreamBatches.get(runId)
    if (!batch) return
    pendingStreamBatches.delete(runId)
    if (batch.timer !== null) clearTimeout(batch.timer)

    let targetWindow = windows.resolve(
      { runId: batch.runId, sessionId: batch.sessionId },
      { allowFallback: false }
    )
    if (!targetWindow) {
      targetWindow = windows.resolve({ runId: batch.runId, sessionId: batch.sessionId })
      if (targetWindow) {
        console.warn('[Sidecar] agent stream using fallback renderer window', {
          runId: batch.runId,
          sessionId: batch.sessionId,
          windowId: targetWindow.id,
          frames: batch.frames.length
        })
      }
    }

    const bytes = batch.frames.length === 1 ? batch.frames[0] : Buffer.concat(batch.frames)
    if (targetWindow) {
      sendAgentStreamBytes(targetWindow, bytes, {
        source: 'native-raw',
        runId: batch.runId,
        sessionId: batch.sessionId,
        frames: batch.frames.length
      })

      windows.forEachObserver(batch.runId, (extraWindow) => {
        if (extraWindow.id === targetWindow.id) return
        sendAgentStreamBytes(extraWindow, bytes, {
          source: 'attach-fanout',
          runId: batch.runId,
          sessionId: batch.sessionId
        })
      })
    } else {
      console.warn('[Sidecar] agent stream has no renderer window; durable cursor already acked', {
        runId: batch.runId,
        sessionId: batch.sessionId,
        frames: batch.frames.length,
        lastSeq: batch.lastSeq
      })
    }
  }

  const flushAllStreamBatches = (): void => {
    for (const runId of Array.from(pendingStreamBatches.keys())) {
      flushStreamBatch(runId)
    }
  }

  manager.setRawEventHandler((frame) => {
    queueGoalRuntimeObservation(frame)
    getWorkerEventConsumer().consumeFrame(frame)

    if (frame.runId && frame.sessionId) {
      if (frame.hasTerminalEvent === true) {
        activeRunSessions.delete(frame.runId)
      } else {
        const trackedRun = activeRunSessions.get(frame.runId)
        const receivedAt = Date.now()
        activeRunSessions.set(frame.runId, {
          sessionId: frame.sessionId,
          lastSeq: typeof frame.seq === 'number' ? frame.seq : (trackedRun?.lastSeq ?? 0),
          dispatchedAt: trackedRun?.dispatchedAt ?? receivedAt,
          acceptedAt: trackedRun?.acceptedAt ?? receivedAt,
          lastEventAt: receivedAt,
          jobState: 'running'
        })
      }
    }

    if (!frame.runId || !frame.sessionId) {
      const targetWindow =
        windows.resolve(frame, { allowFallback: false }) ?? windows.resolve(frame)
      if (targetWindow) {
        sendAgentStreamBytes(targetWindow, frame.bytes, {
          source: 'native-raw',
          runId: frame.runId,
          sessionId: frame.sessionId,
          seq: frame.seq
        })
      }
      return
    }

    const runId = frame.runId
    let batch = pendingStreamBatches.get(runId)
    if (!batch) {
      batch = {
        frames: [],
        byteLength: 0,
        timer: null,
        runId,
        sessionId: frame.sessionId,
        lastSeq: 0
      }
      pendingStreamBatches.set(runId, batch)
    }
    batch.frames.push(Buffer.isBuffer(frame.bytes) ? frame.bytes : Buffer.from(frame.bytes))
    batch.byteLength += frame.byteLength
    if (typeof frame.seq === 'number' && frame.seq > batch.lastSeq) {
      batch.lastSeq = frame.seq
    }

    const terminal = frame.hasTerminalEvent === true
    if (terminal || batch.byteLength >= STREAM_BATCH_MAX_BYTES) {
      flushStreamBatch(runId)
    } else if (batch.timer === null) {
      batch.timer = setTimeout(() => flushStreamBatch(runId), STREAM_BATCH_FLUSH_MS)
    }

    if (terminal) windows.forgetRun(runId)
  })

  manager.setReverseCancelHandler((id, method) => {
    if (method === HOOK_REVERSE_METHODS.run) {
      cancelHookRuns(String(id))
    }
  })

  manager.onDisconnect(() => {
    safeSendMessagePackToAllWindows('sidecar:lifecycle', { state: 'disconnected' })
  })
  manager.onReconnect(() => {
    const workerInstanceId =
      getNativeAgentRuntimeManager().runtimeCapabilities?.workerInstanceId ?? 'uninitialized'
    getRuntimeProjectionHost().reset(workerInstanceId, 'worker-reconnect')
    safeSendMessagePackToAllWindows('sidecar:lifecycle', { state: 'reconnected' })
  })

  getNativeWorker().onStateChange((snapshot) => {
    safeSendMessagePackToAllWindows('sidecar:worker-state', snapshot)
  })

  const failInterruptedRun = (
    runId: string,
    info: TrackedRun,
    errorType = 'worker_interrupted',
    message = 'Native worker stopped while this Job was running.'
  ): void => {
    activeRunSessions.delete(runId)
    const targetWindow = windows.resolve(
      { runId, sessionId: info.sessionId },
      { allowFallback: false }
    )
    windows.forgetRun(runId)
    if (!targetWindow) return

    const bytes = encodeAgentStreamEnvelope({
      v: AGENT_STREAM_PROTOCOL_VERSION,
      runId,
      sessionId: info.sessionId,
      seq: info.lastSeq + 1,
      events: [
        {
          type: 'error',
          message,
          errorType,
          details: JSON.stringify(buildSidecarDiagnostics(runId, info.sessionId, info), null, 2)
        },
        { type: 'loop_end', reason: 'error' }
      ]
    })
    sendAgentStreamBytes(targetWindow, bytes, {
      source: 'worker-disconnect',
      runId,
      sessionId: info.sessionId
    })
  }

  manager.onDisconnect(() => {
    if (activeRunSessions.size === 0) return
    flushAllStreamBatches()
    for (const [runId, info] of Array.from(activeRunSessions.entries())) {
      if (info.jobState === 'running') failInterruptedRun(runId, info)
    }
  })

  manager.onReconnect(() => {
    void Promise.all(
      Array.from(activeRunSessions.entries()).map(async ([runId, info]) => {
        try {
          const status = (await getNativeWorker().request(
            'jobs/status',
            { jobId: runId },
            10_000
          )) as { state?: string; errorCode?: string; error?: string }
          if (status.state === 'running') {
            activeRunSessions.set(runId, { ...info, jobState: 'running' })
          } else if (status.state === 'failed' || status.state === 'cancelled') {
            failInterruptedRun(
              runId,
              info,
              status.errorCode ?? status.state,
              status.error ?? `Background Job ${status.state}.`
            )
          }
        } catch (error) {
          console.warn('[Sidecar] failed to audit queued Job after worker reconnect', {
            runId,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      })
    )
  })

  manager.setRequestHandler(
    createHostReverseRequestHandler({
      flushStreamBatches: flushAllStreamBatches,
      windows,
      uiCapabilities
    })
  )

  registerSidecarMessagePackHandler<undefined>('sidecar:status', () => {
    return { running: manager.isRunning }
  })

  registerSidecarMessagePackHandler<{ runId?: string; sessionId?: string }>(
    'sidecar:diagnostics',
    (_event, params) => {
      const diagnostics = buildSidecarDiagnostics(params?.runId, params?.sessionId)
      const stream = diagnostics.stream as {
        accepted?: boolean
        lastEventAt?: number | null
        journalFrames?: number
        runId?: string | null
      }
      if (
        stream.accepted === true &&
        stream.lastEventAt == null &&
        stream.journalFrames === 0 &&
        manager.isRunning
      ) {
        const runId = stream.runId ?? params?.runId
        console.warn('[Sidecar] stalled stream diagnostics; recovering durable event pump', {
          runId: runId ?? null
        })
        void recoverDurableEventPump(runId ?? undefined).catch((error) => {
          console.warn('[Sidecar] durable event pump recovery failed', {
            error: error instanceof Error ? error.message : String(error)
          })
        })
      }
      return diagnostics
    }
  )

  registerSidecarMessagePackHandler<undefined>('sidecar:start', async () => {
    return { ok: await manager.ensureStarted() }
  })

  registerSidecarMessagePackHandler<undefined>('sidecar:stop', async () => {
    await manager.stop()
    return { ok: true }
  })

  registerSidecarMessagePackHandler<undefined>('sidecar:recycle', async () => {
    console.warn('[Sidecar] recycle requested: replacing native worker process')
    await manager.stop().catch(() => {})
    await stopNativeWorker()
    const ready = await manager.ensureStarted()
    return { ok: ready }
  })

  registerMessagePackInvokeHandler<{
    method: string
    params?: unknown
    timeoutMs?: number
  }>('sidecar:request', async (_event, { method, params, timeoutMs }) => {
    if (typeof method === 'string' && method.startsWith(CODEGRAPH_METHOD_PREFIX)) {
      return await handleCodeGraphRequest(method, params, timeoutMs)
    }
    console.log(`[Sidecar] request start: ${method}`)
    if (!manager.isRunning) {
      console.warn(`[Sidecar] request starting sidecar because it is not running: ${method}`)
      try {
        const ready = await manager.ensureStarted()
        if (!ready) {
          throw new Error('SIDECAR_UNAVAILABLE')
        }
      } catch (error) {
        console.warn(
          `[Sidecar] request failed to start sidecar: ${method}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        throw new Error('SIDECAR_UNAVAILABLE')
      }
    }
    try {
      const result = await manager.request(method, params, timeoutMs)
      console.log(`[Sidecar] request success: ${method}`)
      return result
    } catch (error) {
      console.warn(
        `[Sidecar] request failed: ${method}: ${error instanceof Error ? error.message : String(error)}`
      )
      throw error
    }
  })

  registerRuntimeCommandGateway({
    isRunning: () => manager.isRunning,
    ensureStarted: () => manager.ensureStarted(),
    request: (method, params, timeoutMs) => manager.request(method, params, timeoutMs),
    notify: (method, params) => manager.notify(method, params),
    setSessionVisibility: (sessionId, visible) => manager.setSessionVisibility(sessionId, visible),
    windows,
    uiCapabilities,
    activeRuns: activeRunSessions,
    recoverPump: recoverDurableEventPump,
    flushStreamBatches: flushAllStreamBatches,
    sendAgentStreamBytes
  })

  ipcMain.on(toMessagePackChannel('sidecar:notify'), (_event, bytes: Uint8Array) => {
    const [method, params] = decodeMessagePackPayload<[unknown, unknown]>(bytes)
    if (manager.isRunning && typeof method === 'string') {
      manager.notify(method, params)
    }
  })

  ipcMain.handle(
    SIDECAR_APPROVAL_RESPONSE_MSGPACK_CHANNEL,
    async (_event, bytes: Uint8Array): Promise<{ ok: boolean }> => {
      return uiCapabilities.completeApproval(
        decodeMessagePackPayload<{ requestId: string; approved: boolean; reason?: string }>(bytes)
      )
    }
  )

  ipcMain.handle(
    SIDECAR_RENDERER_TOOL_RESPONSE_MSGPACK_CHANNEL,
    async (_event, bytes: Uint8Array): Promise<{ ok: boolean }> => {
      return uiCapabilities.completeUiCapability(
        decodeMessagePackPayload<{ requestId: string; result?: unknown; error?: string }>(bytes)
      )
    }
  )

  registerSidecarMessagePackHandler<string>('sidecar:can-handle', async (_event, capability) => {
    console.log(`[Sidecar] capability check requested: ${capability}`)

    try {
      const ready = await manager.ensureStarted()
      if (!ready) {
        console.warn(`[Sidecar] capability check failed to start sidecar: ${capability}`)
        return false
      }
    } catch (err) {
      console.warn(
        `[Sidecar] initialize failed during capability check: ${err instanceof Error ? err.message : String(err)}`
      )
      return false
    }

    try {
      const result = (await manager.request('capabilities/check', {
        capability
      })) as { supported: boolean }
      console.log(`[Sidecar] capability ${capability} => ${result?.supported ?? false}`)
      return result?.supported ?? false
    } catch (err) {
      console.warn(
        `[Sidecar] capability check failed for ${capability}: ${err instanceof Error ? err.message : String(err)}`
      )
      return false
    }
  })

  registerSidecarMessagePackHandler<unknown>('sidecar:worker-state', async () => {
    return getNativeWorker().getStateSnapshot()
  })

  registerRuntimeIpcHandlers({
    isRunning: () => manager.isRunning,
    ensureStarted: () => manager.ensureStarted(),
    request: (method, params, timeoutMs) => manager.request(method, params, timeoutMs),
    resolveApproval: (payload) => uiCapabilities.completeApproval(payload),
    getWorkerInstanceId: () =>
      getNativeAgentRuntimeManager().runtimeCapabilities?.workerInstanceId ?? 'uninitialized',
    windows,
    activeRuns: activeRunSessions
  })
}

function cleanupDebugBodyTempFiles(): void {
  try {
    rmSync(DEBUG_BODY_TEMP_DIR, { recursive: true, force: true })
  } catch (error) {
    console.warn(
      `[Sidecar] failed to clean debug body temp files: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}
