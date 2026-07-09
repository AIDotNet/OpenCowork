import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { safePostMessageToWindow } from '../window-ipc'
import {
  AGENT_STREAM_MSGPACK_CHANNEL,
  decodeAgentStreamEnvelope
} from '../../shared/messagepack/agent-stream-codec'
import type { AgentStreamEvent, ToolCallStateWire } from '../../shared/agent-stream-protocol'
import type { InteractiveAgentEvent, ToolCallState } from '../../shared/agent-loop-types'
import {
  SIDECAR_APPROVAL_REQUEST_MSGPACK_CHANNEL,
  SIDECAR_APPROVAL_RESPONSE_MSGPACK_CHANNEL,
  SIDECAR_RENDERER_TOOL_REQUEST_MSGPACK_CHANNEL,
  SIDECAR_RENDERER_TOOL_RESPONSE_MSGPACK_CHANNEL,
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'
import {
  DESKTOP_INPUT_CLICK,
  DESKTOP_INPUT_SCROLL,
  DESKTOP_INPUT_TYPE,
  DESKTOP_SCREENSHOT_CAPTURE,
  captureDesktopScreenshot,
  desktopInputClick,
  desktopInputScroll,
  desktopInputType
} from './desktop-control'
import { getNativeAgentRuntimeManager } from './native-agent-runtime'
import { getNativeSshConnectionPayload } from './ssh-handlers'
import {
  executeChannelSpecificPluginTool,
  executePluginAction,
  isPluginToolEnabled
} from './channel-handlers'
import { showSystemNotification } from './notify-handlers'
import { getGoalRuntimeService } from '../goals/goal-runtime'
import { emitGoalContinueRequested } from '../goals/goal-sync'
import {
  cancelJob,
  getActiveRunJobIds,
  getScheduledJobIds,
  scheduleJob,
  type CronJobRecord
} from '../cron/cron-scheduler'
import { getCronExecutionState } from '../cron/cron-agent-background'
import {
  executeMcpToolFromMain,
  MCP_REVERSE_METHODS,
  MCP_TOOL_HOOK_MODE,
  readMcpResourceFromMain
} from './mcp-handlers'
import { executeJsExtensionToolInMain } from './extension-js-runtime'
import { cancelHookRuns, runHooks } from '../hooks/hooks-service'
import {
  collectHookContextTexts,
  HOOK_COMPACT_TRIGGER,
  HOOK_EVENTS,
  HOOK_PERMISSION_BEHAVIOR,
  HOOK_REVERSE_METHODS,
  HOOK_RUN_SOURCE,
  HOOK_SESSION_START_SOURCE,
  type HookRunSource
} from '../../shared/hooks/types'

const SIDECAR_RENDERER_REQUEST_TIMEOUT_MS = 10 * 60_000
const DEBUG_BODY_TEMP_DIR = join(tmpdir(), 'opencowork-request-debug-bodies')

const CHANNEL_SPECIFIC_PLUGIN_INVOKE_CHANNELS = new Set([
  'plugin:weixin:send-image',
  'plugin:weixin:send-file',
  'plugin:feishu:send-image',
  'plugin:feishu:send-file',
  'plugin:feishu:send-mention',
  'plugin:feishu:list-members',
  'plugin:feishu:send-urgent',
  'plugin:feishu:bitable:list-apps',
  'plugin:feishu:bitable:list-tables',
  'plugin:feishu:bitable:list-fields',
  'plugin:feishu:bitable:get-records',
  'plugin:feishu:bitable:create-records',
  'plugin:feishu:bitable:update-records',
  'plugin:feishu:bitable:delete-records'
])

type PendingRendererApprovalResponse = { approved: boolean; reason?: string }

type PendingRendererApprovalRequest = {
  resolve: (value: PendingRendererApprovalResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type PendingRendererToolRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type McpCallToolInvokeArgs = {
  serverId?: string
  toolName?: string
  args?: Record<string, unknown>
}

type McpReadResourceInvokeArgs = {
  serverId?: string
  uri?: string
  resourceName?: string
}

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

function normalizeRendererRequestRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
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

function enrichAgentRunParams(params: unknown): unknown {
  const record = normalizeRendererRequestRecord(params)
  const sshConnectionId = readNonEmptyString(record.sshConnectionId)
  if (!sshConnectionId || record.connection) return params

  const connection = getNativeSshConnectionPayload(sshConnectionId)
  if (!connection) {
    console.warn(`[Sidecar] SSH connection not found for native agent run: ${sshConnectionId}`)
    return params
  }

  return {
    ...record,
    connection
  }
}

async function prepareGoalAwareAgentRunParams(
  params: unknown,
  manager: SidecarBridgeManager
): Promise<unknown> {
  const enrichedParams = enrichAgentRunParams(params)
  const record = normalizeRendererRequestRecord(enrichedParams)
  const runId = readNonEmptyString(record.runId)
  const sessionId = readNonEmptyString(record.sessionId)
  const messages = Array.isArray(record.messages) ? record.messages : null

  if (!runId || !sessionId || !messages) {
    return enrichedParams
  }

  const preparedMessages = await getGoalRuntimeService().prepareRun({
    runId,
    sessionId,
    planMode: record.planMode === true,
    source: readAgentRunSource(record.goalRunSource),
    messages: messages as Parameters<
      ReturnType<typeof getGoalRuntimeService>['prepareRun']
    >[0]['messages'],
    enqueueMessages: (queuedMessages) => {
      void manager
        .request(
          'agent/append-messages',
          {
            runId,
            messages: queuedMessages
          },
          10_000
        )
        .catch((error) => {
          console.warn(
            '[Sidecar] Failed to append goal runtime messages:',
            error instanceof Error ? error.message : String(error)
          )
        })
    }
  })

  return {
    ...record,
    messages: preparedMessages
  }
}

function readAgentRunSource(value: unknown): 'user_turn' | 'continue' {
  return value === 'continue' ? 'continue' : 'user_turn'
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function getProviderRecord(params: Record<string, unknown>): Record<string, unknown> {
  return normalizeRendererRequestRecord(params.provider)
}

async function runSessionStartHook(params: unknown): Promise<unknown> {
  const record = normalizeRendererRequestRecord(params)
  const provider = getProviderRecord(record)
  const tools = Array.isArray(record.tools) ? record.tools : []
  const toolNames = tools
    .map((tool) => normalizeRendererRequestRecord(tool).name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
  const sessionId = readNonEmptyString(record.sessionId)
  const runId = readNonEmptyString(record.runId)
  const workingFolder = readNonEmptyString(record.workingFolder)
  const sshConnectionId = readNonEmptyString(record.sshConnectionId)
  const goalRunSource = readNonEmptyString(record.goalRunSource)
  const hookResult = await runHooks({
    eventName: HOOK_EVENTS.sessionStart,
    matcherValue:
      goalRunSource === HOOK_RUN_SOURCE.continue
        ? HOOK_SESSION_START_SOURCE.resume
        : HOOK_SESSION_START_SOURCE.startup,
    sessionId,
    runId,
    projectRoot: workingFolder,
    sshConnectionId,
    input: {
      source:
        goalRunSource === HOOK_RUN_SOURCE.continue
          ? HOOK_SESSION_START_SOURCE.resume
          : HOOK_SESSION_START_SOURCE.startup,
      runSource: resolveSessionStartRunSource(record),
      sessionMode: readNonEmptyString(record.sessionMode),
      toolNames,
      providerType: readNonEmptyString(provider.type) ?? '',
      modelId: readNonEmptyString(provider.model)
    }
  })
  if (hookResult.blocked) {
    throw new Error(hookResult.reason || 'SessionStart hook blocked agent run')
  }
  const hookContextTexts = collectHookContextTexts(hookResult)
  if (hookContextTexts.length === 0) return params
  return {
    ...record,
    requestContextTexts: [...readStringArray(record.requestContextTexts), ...hookContextTexts]
  }
}

function resolveSessionStartRunSource(record: Record<string, unknown>): HookRunSource {
  if (readNonEmptyString(record.goalRunSource) === HOOK_RUN_SOURCE.continue) {
    return HOOK_RUN_SOURCE.continue
  }
  if (record.translation) return HOOK_RUN_SOURCE.translation
  if (readNonEmptyString(record.pluginId)) return HOOK_RUN_SOURCE.pluginAutoReply
  if (readNonEmptyString(record.cronJobId)) return HOOK_RUN_SOURCE.cron
  return HOOK_RUN_SOURCE.chat
}

async function runPermissionRequestHook(params: unknown): Promise<{
  handled: boolean
  approved: boolean
  reason?: string
}> {
  const record = normalizeRendererRequestRecord(params)
  const toolCall = normalizeRendererRequestRecord(record.toolCall)
  const toolName = readNonEmptyString(toolCall.name)
  if (!toolName) return { handled: false, approved: false }
  const hookResult = await runHooks({
    eventName: HOOK_EVENTS.permissionRequest,
    matcherValue: toolName,
    sessionId: readNonEmptyString(record.sessionId),
    runId: readNonEmptyString(record.runId),
    input: {
      toolName,
      toolInput: toolCall.input ?? {},
      reason: readNonEmptyString(record.reason),
      sourceRequiresUserApproval: true
    }
  })
  if (hookResult.blocked) {
    return {
      handled: true,
      approved: false,
      reason: hookResult.reason || 'Denied by hook'
    }
  }
  const decision = hookResult.permissionDecision
  if (decision?.behavior === HOOK_PERMISSION_BEHAVIOR.deny) {
    return { handled: true, approved: false, reason: decision.message || 'Denied by hook' }
  }
  if (decision?.behavior === HOOK_PERMISSION_BEHAVIOR.allow) {
    return { handled: true, approved: true, reason: decision.message }
  }
  return { handled: false, approved: false }
}

async function runManualCompactHooks(
  phase: typeof HOOK_EVENTS.preCompact | typeof HOOK_EVENTS.postCompact,
  params: unknown,
  result?: unknown
): Promise<void> {
  const record = normalizeRendererRequestRecord(params)
  const resultRecord = normalizeRendererRequestRecord(result)
  const compressionResult = normalizeRendererRequestRecord(resultRecord.result)
  const hookResult = await runHooks({
    eventName: phase,
    matcherValue: 'manual',
    sessionId: readNonEmptyString(record.sessionId),
    projectRoot: readNonEmptyString(record.workingFolder),
    sshConnectionId: readNonEmptyString(record.sshConnectionId),
    input: {
      trigger: HOOK_COMPACT_TRIGGER.manual,
      originalCount:
        typeof compressionResult.originalCount === 'number'
          ? compressionResult.originalCount
          : undefined,
      newCount:
        typeof compressionResult.newCount === 'number' ? compressionResult.newCount : undefined
    }
  })
  if (hookResult.blocked) {
    if (phase === HOOK_EVENTS.postCompact) {
      console.warn(
        `[Hooks] PostCompact hook requested block after compression: ${hookResult.reason || 'Blocked by hook'}`
      )
      return
    }
    throw new Error(hookResult.reason || `${phase} hook blocked context compression`)
  }
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

function isUsableRendererWindow(window: BrowserWindow | null | undefined): window is BrowserWindow {
  return (
    !!window &&
    !window.isDestroyed() &&
    !window.webContents.isDestroyed() &&
    !window.webContents.isCrashed()
  )
}

function pickFallbackRendererWindow(): BrowserWindow | null {
  const focusedWindow = BrowserWindow.getFocusedWindow()
  const candidateWindows = focusedWindow
    ? [focusedWindow, ...BrowserWindow.getAllWindows().filter((win) => win !== focusedWindow)]
    : BrowserWindow.getAllWindows()

  return candidateWindows.find((win) => isUsableRendererWindow(win)) ?? null
}

function resolveRendererTargetWindow(
  params: unknown,
  runWindowIds: Map<string, number>,
  sessionWindowIds: Map<string, number>,
  options?: { allowFallback?: boolean }
): BrowserWindow | null {
  const record = normalizeRendererRequestRecord(params)
  const agentRunId = readNonEmptyString(record.agentRunId)
  const runId = readNonEmptyString(record.runId)
  const sessionId = readNonEmptyString(record.sessionId)
  const mappedWindowIds = [
    agentRunId ? runWindowIds.get(agentRunId) : undefined,
    runId ? runWindowIds.get(runId) : undefined,
    sessionId ? sessionWindowIds.get(sessionId) : undefined
  ]

  for (const windowId of mappedWindowIds) {
    if (typeof windowId !== 'number') continue
    const mappedWindow = BrowserWindow.fromId(windowId)
    if (isUsableRendererWindow(mappedWindow)) {
      return mappedWindow
    }
  }

  if (agentRunId) runWindowIds.delete(agentRunId)
  if (runId) runWindowIds.delete(runId)
  if (sessionId) sessionWindowIds.delete(sessionId)
  if (options?.allowFallback === false && sessionId) return null
  return pickFallbackRendererWindow()
}

function rememberRendererOrigin(
  event: IpcMainInvokeEvent,
  params: unknown,
  runWindowIds: Map<string, number>,
  sessionWindowIds: Map<string, number>,
  resolvedRunId?: string
): void {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender)
  if (!isUsableRendererWindow(sourceWindow)) return

  const record = normalizeRendererRequestRecord(params)
  const requestedRunId = readNonEmptyString(record.runId)
  const sessionId = readNonEmptyString(record.sessionId)

  if (requestedRunId) {
    runWindowIds.set(requestedRunId, sourceWindow.id)
  }
  if (resolvedRunId) {
    runWindowIds.set(resolvedRunId, sourceWindow.id)
  }
  if (sessionId) {
    sessionWindowIds.set(sessionId, sourceWindow.id)
  }
}

/**
 * Register IPC handlers for the sidecar bridge.
 * Renderer sends requests to sidecar via main process.
 */
export function registerSidecarHandlers(): void {
  cleanupDebugBodyTempFiles()
  const manager = getSidecarManager()
  const pendingApprovalRequests = new Map<string, PendingRendererApprovalRequest>()
  const pendingRendererToolRequests = new Map<string, PendingRendererToolRequest>()
  const runWindowIds = new Map<string, number>()
  const sessionWindowIds = new Map<string, number>()
  const goalRuntimeObservationChains = new Map<string, Promise<void>>()

  const cleanupAgentRunIfTerminal = (runId: string, terminal: boolean): void => {
    if (!terminal) return
    runWindowIds.delete(runId)
  }

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

    // Fully decoding every frame just to have observeEvent no-op on untracked
    // runs blocks the main thread on large payloads; gate on the runId that
    // the cheap route scan already extracted.
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

  // Forwarding one IPC message per provider delta floods the renderer with
  // 60-200 postMessage calls/sec. Frames are buffered per run for a short
  // window and concatenated on flush — MessagePack envelopes are
  // self-delimiting, so the renderer splits them back out with decodeMulti.
  // Arrival order within a run is preserved; terminal events flush inline.
  const STREAM_BATCH_FLUSH_MS = 33
  const STREAM_BATCH_MAX_BYTES = 256 * 1024
  interface PendingStreamBatch {
    frames: Buffer[]
    byteLength: number
    timer: NodeJS.Timeout | null
    runId: string
    sessionId: string
  }
  const pendingStreamBatches = new Map<string, PendingStreamBatch>()

  const flushStreamBatch = (runId: string): void => {
    const batch = pendingStreamBatches.get(runId)
    if (!batch) return
    pendingStreamBatches.delete(runId)
    if (batch.timer !== null) clearTimeout(batch.timer)

    const targetWindow = resolveRendererTargetWindow(
      { runId: batch.runId, sessionId: batch.sessionId },
      runWindowIds,
      sessionWindowIds,
      { allowFallback: false }
    )
    if (!targetWindow) return

    const bytes = batch.frames.length === 1 ? batch.frames[0] : Buffer.concat(batch.frames)
    sendAgentStreamBytes(targetWindow, bytes, {
      source: 'native-raw',
      runId: batch.runId,
      sessionId: batch.sessionId,
      frames: batch.frames.length
    })
  }

  const flushAllStreamBatches = (): void => {
    for (const runId of Array.from(pendingStreamBatches.keys())) {
      flushStreamBatch(runId)
    }
  }

  manager.setRawEventHandler((frame) => {
    queueGoalRuntimeObservation(frame)

    if (!frame.runId || !frame.sessionId) {
      const targetWindow = resolveRendererTargetWindow(frame, runWindowIds, sessionWindowIds, {
        allowFallback: false
      })
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
        sessionId: frame.sessionId
      }
      pendingStreamBatches.set(runId, batch)
    }
    batch.frames.push(Buffer.isBuffer(frame.bytes) ? frame.bytes : Buffer.from(frame.bytes))
    batch.byteLength += frame.byteLength

    const terminal = frame.hasTerminalEvent === true
    if (terminal || batch.byteLength >= STREAM_BATCH_MAX_BYTES) {
      flushStreamBatch(runId)
    } else if (batch.timer === null) {
      batch.timer = setTimeout(() => flushStreamBatch(runId), STREAM_BATCH_FLUSH_MS)
    }

    if (terminal) cleanupAgentRunIfTerminal(runId, true)
  })

  manager.setReverseCancelHandler((id, method) => {
    if (method === HOOK_REVERSE_METHODS.run) {
      cancelHookRuns(String(id))
    }
  })

  manager.setRequestHandler(async (_id, method, params) => {
    // Reverse requests (approvals, renderer tool execution) must not overtake
    // stream events that were emitted before them.
    flushAllStreamBatches()
    switch (method) {
      case 'approval/request': {
        const hookDecision: { handled: boolean; approved: boolean; reason?: string } =
          await runPermissionRequestHook(params).catch((error) => {
            console.warn(
              `[Hooks] PermissionRequest failed: ${error instanceof Error ? error.message : String(error)}`
            )
            return { handled: false, approved: false }
          })
        if (hookDecision.handled) {
          return {
            approved: hookDecision.approved,
            ...(hookDecision.reason ? { reason: hookDecision.reason } : {})
          }
        }

        const requestId = `sidecar-approval-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        const targetWindow = resolveRendererTargetWindow(params, runWindowIds, sessionWindowIds)

        if (!targetWindow) {
          return { approved: false, reason: 'No renderer available for approval request' }
        }

        return await new Promise<{ approved: boolean; reason?: string }>((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingApprovalRequests.delete(requestId)
            reject(new Error('Renderer approval request timed out'))
          }, SIDECAR_RENDERER_REQUEST_TIMEOUT_MS)

          pendingApprovalRequests.set(requestId, { resolve, reject, timer })

          const sent = sendReverseRequest(targetWindow, SIDECAR_APPROVAL_REQUEST_MSGPACK_CHANNEL, {
            requestId,
            method,
            params
          })

          if (!sent) {
            clearTimeout(timer)
            pendingApprovalRequests.delete(requestId)
            resolve({ approved: false, reason: 'Failed to deliver approval request to renderer' })
          }
        })
      }
      case HOOK_REVERSE_METHODS.run:
        return await runHooks({
          ...(normalizeRendererRequestRecord(params) as unknown as Parameters<typeof runHooks>[0]),
          cancellationKey: String(_id)
        })
      case 'cron/schedule-job': {
        const cronParams = params as { job?: CronJobRecord } | null
        if (!cronParams?.job?.id) {
          throw new Error('cron/schedule-job requires job')
        }
        const scheduled = scheduleJob(cronParams.job)
        return { success: true, scheduled }
      }
      case 'cron/cancel-job': {
        const cronParams = params as { jobId?: string } | null
        if (!cronParams?.jobId) {
          throw new Error('cron/cancel-job requires jobId')
        }
        const canceled = cancelJob(cronParams.jobId)
        return { success: true, canceled }
      }
      case 'cron/runtime-state': {
        const scheduledIds = getScheduledJobIds()
        const runningIds = getActiveRunJobIds()
        const executionStates = Object.fromEntries(
          runningIds.map((jobId) => [jobId, getCronExecutionState(jobId)])
        )
        return { success: true, scheduledIds, runningIds, executionStates }
      }
      case 'notify:desktop': {
        const notifyArgs = (params ?? {}) as {
          title?: string
          body?: string
          type?: string
          duration?: number
        }
        try {
          showSystemNotification(notifyArgs.title ?? 'OpenCoWork', notifyArgs.body ?? '')
          return { success: true }
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
      case 'plugin:exec': {
        const pluginArgs = (params ?? {}) as {
          pluginId?: string
          action?: string
          params?: Record<string, unknown>
          toolName?: string
        }
        if (!pluginArgs.pluginId || !pluginArgs.action) {
          throw new Error('plugin:exec requires pluginId and action')
        }
        if (
          pluginArgs.toolName &&
          !(await isPluginToolEnabled(pluginArgs.pluginId, pluginArgs.toolName))
        ) {
          return { error: `Tool "${pluginArgs.toolName}" is disabled for this channel.` }
        }
        return await executePluginAction({
          pluginId: pluginArgs.pluginId,
          action: pluginArgs.action,
          params: pluginArgs.params ?? {}
        })
      }
      case 'plugin:tool-enabled': {
        const pluginArgs = (params ?? {}) as {
          pluginId?: string
          toolName?: string
        }
        if (!pluginArgs.pluginId || !pluginArgs.toolName) {
          throw new Error('plugin:tool-enabled requires pluginId and toolName')
        }
        return {
          enabled: await isPluginToolEnabled(pluginArgs.pluginId, pluginArgs.toolName)
        }
      }
      case DESKTOP_SCREENSHOT_CAPTURE:
        return await captureDesktopScreenshot()
      case DESKTOP_INPUT_CLICK:
        return desktopInputClick((params ?? {}) as Parameters<typeof desktopInputClick>[0])
      case DESKTOP_INPUT_TYPE:
        return desktopInputType((params ?? {}) as Parameters<typeof desktopInputType>[0])
      case DESKTOP_INPUT_SCROLL:
        return desktopInputScroll((params ?? {}) as Parameters<typeof desktopInputScroll>[0])
      case MCP_REVERSE_METHODS.callTool: {
        const mcpArgs = (params ?? {}) as McpCallToolInvokeArgs
        if (!mcpArgs.serverId || !mcpArgs.toolName) {
          throw new Error('mcp:call-tool requires serverId and toolName')
        }
        return await executeMcpToolFromMain(
          {
            serverId: mcpArgs.serverId,
            toolName: mcpArgs.toolName,
            args: mcpArgs.args ?? {}
          },
          { hookMode: MCP_TOOL_HOOK_MODE.disabled }
        )
      }
      case MCP_REVERSE_METHODS.readResource: {
        const mcpArgs = (params ?? {}) as McpReadResourceInvokeArgs
        if (!mcpArgs.serverId) {
          throw new Error('mcp:read-resource requires serverId')
        }
        return await readMcpResourceFromMain({
          serverId: mcpArgs.serverId,
          uri: mcpArgs.uri,
          resourceName: mcpArgs.resourceName
        })
      }
      case 'extension:execute-js-tool':
        return await executeJsExtensionToolInMain(params)
      case 'ask-user/request':
      case 'plan/ui-update':
      case 'team/ui-update':
      case 'browser/tool-request': {
        const requestId = `sidecar-${method.replace(/[^a-z0-9]+/gi, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        const targetWindow = resolveRendererTargetWindow(params, runWindowIds, sessionWindowIds)
        const requestLabel =
          method === 'ask-user/request'
            ? 'AskUserQuestion request'
            : method === 'browser/tool-request'
              ? 'Browser tool request'
              : method === 'team/ui-update'
                ? 'Team UI update request'
                : 'Plan UI update request'

        if (!targetWindow) {
          throw new Error(`No renderer available for ${requestLabel}`)
        }

        return await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingRendererToolRequests.delete(requestId)
            reject(new Error(`${requestLabel} timed out`))
          }, SIDECAR_RENDERER_REQUEST_TIMEOUT_MS)

          pendingRendererToolRequests.set(requestId, { resolve, reject, timer })

          const sent = sendReverseRequest(
            targetWindow,
            SIDECAR_RENDERER_TOOL_REQUEST_MSGPACK_CHANNEL,
            {
              requestId,
              method,
              params
            }
          )

          if (!sent) {
            clearTimeout(timer)
            pendingRendererToolRequests.delete(requestId)
            reject(new Error(`Failed to deliver ${requestLabel} to renderer`))
          }
        })
      }
      default:
        if (CHANNEL_SPECIFIC_PLUGIN_INVOKE_CHANNELS.has(method)) {
          return await executeChannelSpecificPluginTool(
            method,
            (params ?? {}) as Record<string, unknown>
          )
        }
        throw new Error(`Unsupported reverse method: ${method}`)
    }
  })

  registerSidecarMessagePackHandler<undefined>('sidecar:status', () => {
    return { running: manager.isRunning }
  })

  registerSidecarMessagePackHandler<undefined>('sidecar:start', async () => {
    return { ok: await manager.ensureStarted() }
  })

  registerSidecarMessagePackHandler<undefined>('sidecar:stop', async () => {
    await manager.stop()
    return { ok: true }
  })

  registerMessagePackInvokeHandler<{
    method: string
    params?: unknown
    timeoutMs?: number
  }>('sidecar:request', async (_event, { method, params, timeoutMs }) => {
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

  registerMessagePackInvokeHandler<unknown>('agent:run', async (event, params) => {
    console.log('[Sidecar] agent:run requested')
    rememberRendererOrigin(event, params, runWindowIds, sessionWindowIds)
    const ready = await manager.ensureStarted()
    if (!ready) throw new Error('SIDECAR_UNAVAILABLE')
    const enrichedParams = await prepareGoalAwareAgentRunParams(params, manager)
    const hookAdjustedParams = await runSessionStartHook(enrichedParams)
    try {
      const result = (await manager.request('agent/run', hookAdjustedParams, 60_000)) as {
        started: boolean
        runId: string
      }
      rememberRendererOrigin(
        event,
        hookAdjustedParams,
        runWindowIds,
        sessionWindowIds,
        result.runId
      )
      console.log('[Sidecar] agent:run request accepted')
      return result
    } catch (error) {
      console.warn(
        `[Sidecar] agent:run failed: ${error instanceof Error ? error.message : String(error)}`
      )
      throw error
    }
  })

  registerMessagePackInvokeHandler<unknown>('agent:cancel', async (_event, params) => {
    if (!manager.isRunning) {
      return { cancelled: false }
    }
    const result = (await manager.request('agent/cancel', params, 10_000)) as {
      cancelled: boolean
      runId?: string
    }
    if (result.cancelled && result.runId) {
      runWindowIds.delete(result.runId)
    }
    return result
  })

  registerMessagePackInvokeHandler<unknown>('agent:request-stop', async (_event, params) => {
    if (!manager.isRunning) {
      return { stopped: false }
    }
    return await manager.request('agent/request-stop', params, 10_000)
  })

  registerMessagePackInvokeHandler<unknown>('agent:append-messages', async (_event, params) => {
    if (!manager.isRunning) {
      return { appended: false, count: 0 }
    }
    return await manager.request('agent/append-messages', params, 10_000)
  })

  registerMessagePackInvokeHandler<unknown>('agent:compress-context', async (_event, params) => {
    const ready = await manager.ensureStarted()
    if (!ready) throw new Error('SIDECAR_UNAVAILABLE')
    await runManualCompactHooks(HOOK_EVENTS.preCompact, params)
    const result = await manager.request('agent/compress-context', params, 130_000)
    await runManualCompactHooks(HOOK_EVENTS.postCompact, params, result)
    return result
  })

  ipcMain.on(toMessagePackChannel('agent:session-visibility'), (event, bytes: Uint8Array) => {
    const payload = decodeMessagePackPayload<{ sessionId?: string; visible?: boolean }>(bytes)
    const sessionId = readNonEmptyString(payload?.sessionId)
    if (!sessionId) return

    const sourceWindow = BrowserWindow.fromWebContents(event.sender)
    if (isUsableRendererWindow(sourceWindow)) {
      if (payload.visible === true) {
        sessionWindowIds.set(sessionId, sourceWindow.id)
      } else if (sessionWindowIds.get(sessionId) === sourceWindow.id) {
        sessionWindowIds.delete(sessionId)
      }
    }

    manager.setSessionVisibility(sessionId, payload.visible === true)
  })

  ipcMain.on(toMessagePackChannel('sidecar:notify'), (_event, bytes: Uint8Array) => {
    const [method, params] = decodeMessagePackPayload<[unknown, unknown]>(bytes)
    if (manager.isRunning && typeof method === 'string') {
      manager.notify(method, params)
    }
  })

  const completeApprovalResponse = (payload: {
    requestId: string
    approved: boolean
    reason?: string
  }): { ok: boolean } => {
    const pending = pendingApprovalRequests.get(payload.requestId)
    if (!pending) return { ok: false }

    pendingApprovalRequests.delete(payload.requestId)
    clearTimeout(pending.timer)
    pending.resolve({
      approved: payload.approved === true,
      ...(payload.reason ? { reason: payload.reason } : {})
    })
    return { ok: true }
  }

  const completeRendererToolResponse = (payload: {
    requestId: string
    result?: unknown
    error?: string
  }): { ok: boolean } => {
    const pending = pendingRendererToolRequests.get(payload.requestId)
    if (!pending) return { ok: false }

    pendingRendererToolRequests.delete(payload.requestId)
    clearTimeout(pending.timer)
    if (payload.error) {
      pending.reject(new Error(payload.error))
    } else {
      pending.resolve(payload.result)
    }
    return { ok: true }
  }

  ipcMain.handle(
    SIDECAR_APPROVAL_RESPONSE_MSGPACK_CHANNEL,
    async (_event, bytes: Uint8Array): Promise<{ ok: boolean }> => {
      return completeApprovalResponse(
        decodeMessagePackPayload<{ requestId: string; approved: boolean; reason?: string }>(bytes)
      )
    }
  )

  ipcMain.handle(
    SIDECAR_RENDERER_TOOL_RESPONSE_MSGPACK_CHANNEL,
    async (_event, bytes: Uint8Array): Promise<{ ok: boolean }> => {
      return completeRendererToolResponse(
        decodeMessagePackPayload<{ requestId: string; result?: unknown; error?: string }>(bytes)
      )
    }
  )

  /**
   * Check if the sidecar can handle a specific capability.
   * Used by the renderer to route only capabilities that are implemented
   * in the native worker.
   */
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
