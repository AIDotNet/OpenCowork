import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { safePostMessageToWindow } from '../window-ipc'
import { AGENT_STREAM_MSGPACK_CHANNEL } from '../../shared/messagepack/agent-stream-codec'
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
import {
  cancelJob,
  getActiveRunJobIds,
  getScheduledJobIds,
  scheduleJob,
  type CronJobRecord
} from '../cron/cron-scheduler'
import { getCronExecutionState } from '../cron/cron-agent-background'
import { executeMcpToolFromMain, readMcpResourceFromMain } from './mcp-handlers'
import { executeJsExtensionToolInMain } from './extension-js-runtime'

const SIDECAR_RENDERER_REQUEST_TIMEOUT_MS = 10 * 60_000

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
  const manager = getSidecarManager()
  const pendingApprovalRequests = new Map<string, PendingRendererApprovalRequest>()
  const pendingRendererToolRequests = new Map<string, PendingRendererToolRequest>()
  const runWindowIds = new Map<string, number>()
  const sessionWindowIds = new Map<string, number>()

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

  manager.setRawEventHandler((frame) => {
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
    if (frame.runId) cleanupAgentRunIfTerminal(frame.runId, frame.hasTerminalEvent === true)
  })

  manager.setRequestHandler(async (_id, method, params) => {
    switch (method) {
      case 'approval/request': {
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
      case 'mcp:call-tool': {
        const mcpArgs = (params ?? {}) as McpCallToolInvokeArgs
        if (!mcpArgs.serverId || !mcpArgs.toolName) {
          throw new Error('mcp:call-tool requires serverId and toolName')
        }
        return await executeMcpToolFromMain({
          serverId: mcpArgs.serverId,
          toolName: mcpArgs.toolName,
          args: mcpArgs.args ?? {}
        })
      }
      case 'mcp:read-resource': {
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
      console.warn(`[Sidecar] request rejected, not running: ${method}`)
      throw new Error('SIDECAR_UNAVAILABLE')
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
    const enrichedParams = enrichAgentRunParams(params)
    try {
      const result = (await manager.request('agent/run', enrichedParams, 60_000)) as {
        started: boolean
        runId: string
      }
      rememberRendererOrigin(event, enrichedParams, runWindowIds, sessionWindowIds, result.runId)
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

  registerMessagePackInvokeHandler<unknown>('agent:append-messages', async (_event, params) => {
    if (!manager.isRunning) {
      return { appended: false, count: 0 }
    }
    return await manager.request('agent/append-messages', params, 10_000)
  })

  registerMessagePackInvokeHandler<unknown>('agent:compress-context', async (_event, params) => {
    const ready = await manager.ensureStarted()
    if (!ready) throw new Error('SIDECAR_UNAVAILABLE')
    return await manager.request('agent/compress-context', params, 130_000)
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
