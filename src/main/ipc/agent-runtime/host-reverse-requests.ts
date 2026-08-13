import { app, dialog } from 'electron'
import { existsSync, statSync } from 'fs'
import * as path from 'path'
import {
  DESKTOP_INPUT_CLICK,
  DESKTOP_INPUT_SCROLL,
  DESKTOP_INPUT_TYPE,
  DESKTOP_SCREENSHOT_CAPTURE,
  captureDesktopScreenshot,
  desktopInputClick,
  desktopInputScroll,
  desktopInputType
} from '../desktop-control'
import {
  executeChannelSpecificPluginTool,
  executePluginAction,
  isPluginToolEnabled
} from '../channel-handlers'
import { showSystemNotification } from '../notify-handlers'
import {
  cancelJob,
  getActiveRunJobIds,
  getScheduledJobIds,
  scheduleJob,
  type CronJobRecord
} from '../../cron/cron-scheduler'
import { getCronExecutionState } from '../../cron/cron-agent-background'
import {
  executeMcpToolFromMain,
  MCP_REVERSE_METHODS,
  MCP_TOOL_HOOK_MODE,
  readMcpResourceFromMain
} from '../mcp-handlers'
import { executeJsExtensionToolInMain } from '../extension-js-runtime'
import { runHooks } from '../../hooks/hooks-service'
import {
  HOOK_EVENTS,
  HOOK_PERMISSION_BEHAVIOR,
  HOOK_REVERSE_METHODS
} from '../../../shared/hooks/types'
import { initializeSettingsCache, readCodeGraphEnabled } from '../settings-handlers'
import { getNativeWorker } from '../../lib/native-worker'
import { normalizeRendererRequestRecord, readNonEmptyString } from './request-utils'
import {
  isUiCapabilityMethod,
  type ReverseTargetWindow,
  type UiCapabilityRouter
} from './ui-capability-router'
import type { RunTargetRouter } from './run-target-router'

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

const activeSecurityScopedResources = new Map<string, () => void>()

function codeGraphNotReadyResult(message: string): {
  success: true
  isError: false
  errorKind: 'not_indexed'
  message: string
} {
  return { success: true, isError: false, errorKind: 'not_indexed', message }
}

export async function handleCodeGraphRequest(
  method: string,
  params: unknown,
  timeoutMs?: number
): Promise<unknown> {
  await initializeSettingsCache()
  if (!readCodeGraphEnabled()) {
    return codeGraphNotReadyResult(
      'CodeGraph is disabled. Enable it in Settings to index this project for code navigation.'
    )
  }
  try {
    return await getNativeWorker().request(method, params, timeoutMs)
  } catch (error) {
    return codeGraphNotReadyResult(
      `CodeGraph is unavailable: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function normalizeComparableFsPath(filePath: string): string {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isPathInsideOrEqual(parentPath: string, candidatePath: string): boolean {
  const parent = normalizeComparableFsPath(parentPath)
  const candidate = normalizeComparableFsPath(candidatePath)
  if (candidate === parent) return true

  const relativePath = path.relative(parent, candidate)
  return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
}

function getSystemAccessDefaultPath(requestPath: string): string | undefined {
  try {
    if (existsSync(requestPath)) {
      const stat = statSync(requestPath)
      return stat.isDirectory() ? requestPath : path.dirname(requestPath)
    }
  } catch {
    // Fall back to the parent path below.
  }

  const parentPath = path.dirname(requestPath)
  return parentPath && parentPath !== requestPath ? parentPath : undefined
}

function rememberSecurityScopedBookmark(selectedPath: string, bookmark?: string): void {
  if (process.platform !== 'darwin' || !bookmark) return

  const key = normalizeComparableFsPath(selectedPath)
  if (activeSecurityScopedResources.has(key)) return

  try {
    const stopAccessing = app.startAccessingSecurityScopedResource(bookmark)
    activeSecurityScopedResources.set(key, () => {
      stopAccessing()
    })
  } catch (error) {
    console.warn(
      `[Sidecar] Failed to start security-scoped file access: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

async function requestSystemFileAccess(
  params: unknown,
  windows: RunTargetRouter
): Promise<{ granted: boolean; canceled?: boolean; path?: string; reason?: string }> {
  const record = normalizeRendererRequestRecord(params)
  const requestedPath = readNonEmptyString(record.path)
  if (!requestedPath) {
    return { granted: false, reason: 'Missing path for system access request' }
  }

  const targetWindow = windows.resolve(record)
  if (!targetWindow) {
    return { granted: false, reason: 'No renderer available for system access request' }
  }

  const defaultPath = getSystemAccessDefaultPath(requestedPath)
  const operation = readNonEmptyString(record.operation) ?? 'access'
  const result = await dialog.showOpenDialog(targetWindow, {
    title: 'Allow OpenCoWork to access this folder',
    message: `OpenCoWork needs system permission to ${operation}:\n${requestedPath}`,
    buttonLabel: 'Allow Access',
    properties: ['openDirectory'],
    defaultPath,
    securityScopedBookmarks: process.platform === 'darwin'
  })

  if (result.canceled || result.filePaths.length === 0) {
    return { granted: false, canceled: true, reason: 'User canceled system access request' }
  }

  const selectedPath = result.filePaths[0]
  if (!isPathInsideOrEqual(selectedPath, requestedPath)) {
    return {
      granted: false,
      path: selectedPath,
      reason: `Selected folder does not include requested path: ${requestedPath}`
    }
  }

  rememberSecurityScopedBookmark(selectedPath, result.bookmarks?.[0])
  return { granted: true, path: selectedPath }
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

export type HostReverseRequestDeps<TWindow extends ReverseTargetWindow = ReverseTargetWindow> = {
  flushStreamBatches: () => void
  windows: RunTargetRouter
  uiCapabilities: UiCapabilityRouter<TWindow>
}

export function createHostReverseRequestHandler<
  TWindow extends ReverseTargetWindow = ReverseTargetWindow
>(
  deps: HostReverseRequestDeps<TWindow>
): (id: number | string, method: string, params: unknown) => Promise<unknown> {
  return async (id, method, params) => {
    deps.flushStreamBatches()
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
        return await deps.uiCapabilities.requestApproval(params)
      }
      case HOOK_REVERSE_METHODS.run:
        return await runHooks({
          ...(normalizeRendererRequestRecord(params) as unknown as Parameters<typeof runHooks>[0]),
          cancellationKey: String(id)
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
      case 'fs/request-system-access':
        return await requestSystemFileAccess(params, deps.windows)
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
      case 'codegraph:tool': {
        const cgArgs = (params ?? {}) as {
          name?: string
          input?: Record<string, unknown>
          workingFolder?: string
        }
        const toolName = typeof cgArgs.name === 'string' ? cgArgs.name : ''
        if (!toolName.startsWith('codegraph_')) {
          return codeGraphNotReadyResult(`Unknown CodeGraph tool: ${toolName || '(missing)'}`)
        }
        const cgMethod = `codegraph/${toolName.slice('codegraph_'.length)}`
        const input =
          cgArgs.input && typeof cgArgs.input === 'object'
            ? { ...(cgArgs.input as Record<string, unknown>) }
            : {}
        if (
          cgArgs.workingFolder &&
          input.projectPath === undefined &&
          input.workingFolder === undefined
        ) {
          input.workingFolder = cgArgs.workingFolder
        }
        return await handleCodeGraphRequest(cgMethod, input, 120_000)
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
      default:
        if (isUiCapabilityMethod(method)) {
          return await deps.uiCapabilities.requestUiCapability(method, params)
        }
        if (CHANNEL_SPECIFIC_PLUGIN_INVOKE_CHANNELS.has(method)) {
          return await executeChannelSpecificPluginTool(
            method,
            (params ?? {}) as Record<string, unknown>
          )
        }
        throw new Error(`Unsupported reverse method: ${method}`)
    }
  }
}
