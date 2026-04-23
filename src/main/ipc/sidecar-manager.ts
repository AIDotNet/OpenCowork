import { ipcMain, BrowserWindow } from 'electron'
import { safeSendToWindow } from '../window-ipc'
import * as fs from 'fs'
import * as path from 'path'
import {
  DESKTOP_INPUT_CLICK,
  DESKTOP_INPUT_SCROLL,
  DESKTOP_INPUT_TYPE,
  DESKTOP_SCREENSHOT_CAPTURE,
  captureDesktopScreenshot,
  desktopInputClick,
  desktopInputScroll,
  desktopInputType,
  isDesktopInputAvailable
} from './desktop-control'
import { listAgents } from './agents-handlers'
import { recordLocalTextWriteChange } from './agent-change-handlers'
import { JsAgentRuntimeManager } from './js-agent-runtime'

const SIDECAR_RENDERER_REQUEST_TIMEOUT_MS = 10 * 60_000

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

type ElectronInvokeParams = {
  channel?: string
  args?: unknown[]
}

type SidecarBridgeManager = {
  setEventHandler: (
    handler: (envelope: import('../../shared/agent-stream-protocol').AgentStreamEnvelope) => void
  ) => void
  setRequestHandler: (
    handler: (id: number | string, method: string, params: unknown) => Promise<unknown>
  ) => void
  setSessionVisibility: (sessionId: string, visible: boolean) => void
  start: () => Promise<boolean>
  ensureStarted: () => Promise<boolean>
  stop: () => Promise<void>
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>
  notify: (method: string, params?: unknown) => void
  readonly isRunning: boolean
}

// Singleton instance
let sidecarInstance: SidecarBridgeManager | null = null

export function getSidecarManager(): SidecarBridgeManager {
  if (!sidecarInstance) {
    sidecarInstance = new JsAgentRuntimeManager()
  }
  return sidecarInstance
}

/**
 * Register IPC handlers for the sidecar bridge.
 * Renderer sends requests to sidecar via main process.
 * Includes fallback detection for graceful degradation to Node.js path.
 */
export function registerSidecarHandlers(): void {
  const manager = getSidecarManager()
  const pendingApprovalRequests = new Map<string, PendingRendererApprovalRequest>()
  const pendingRendererToolRequests = new Map<string, PendingRendererToolRequest>()
  const pendingProviderStreamRequests = new Map<string, PendingRendererToolRequest>()

  // New protocol: typed AgentStreamEnvelope on 'agent:stream'
  manager.setEventHandler((envelope) => {
    for (const win of BrowserWindow.getAllWindows()) {
      safeSendToWindow(win, 'agent:stream', envelope)
    }
  })

  manager.setRequestHandler(async (_id, method, params) => {
    switch (method) {
      case 'approval/request': {
        const requestId = `sidecar-approval-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        const focusedWindow = BrowserWindow.getFocusedWindow()
        const candidateWindows = focusedWindow
          ? [focusedWindow, ...BrowserWindow.getAllWindows().filter((win) => win !== focusedWindow)]
          : BrowserWindow.getAllWindows()

        const targetWindow = candidateWindows.find(
          (win) =>
            !win.isDestroyed() && !win.webContents.isDestroyed() && !win.webContents.isCrashed()
        )

        if (!targetWindow) {
          return { approved: false, reason: 'No renderer available for approval request' }
        }

        return await new Promise<{ approved: boolean; reason?: string }>((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingApprovalRequests.delete(requestId)
            reject(new Error('Renderer approval request timed out'))
          }, SIDECAR_RENDERER_REQUEST_TIMEOUT_MS)

          pendingApprovalRequests.set(requestId, { resolve, reject, timer })

          const sent = safeSendToWindow(targetWindow, 'sidecar:approval-request', {
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
      case 'electron/invoke': {
        const invoke = params as ElectronInvokeParams | null
        const channel = invoke?.channel
        const args = Array.isArray(invoke?.args) ? invoke.args : []

        if (!channel || typeof channel !== 'string') {
          throw new Error('electron/invoke requires a string channel')
        }

        switch (channel) {
          case DESKTOP_SCREENSHOT_CAPTURE:
            return await captureDesktopScreenshot()
          case DESKTOP_INPUT_CLICK:
            return desktopInputClick((args[0] ?? {}) as Parameters<typeof desktopInputClick>[0])
          case DESKTOP_INPUT_TYPE:
            return desktopInputType((args[0] ?? {}) as Parameters<typeof desktopInputType>[0])
          case DESKTOP_INPUT_SCROLL:
            return desktopInputScroll((args[0] ?? {}) as Parameters<typeof desktopInputScroll>[0])
          case 'desktop:input:available':
            return isDesktopInputAvailable()
          case 'agents:list':
            return listAgents()
          case 'fs:write-file': {
            const writeArgs = args[0] as {
              path: string
              content: string
              changeMeta?: {
                runId?: string
                sessionId?: string
                toolUseId?: string
                toolName?: string
              }
            }
            if (!writeArgs?.path || typeof writeArgs.content !== 'string') {
              throw new Error('fs:write-file requires path and content')
            }
            try {
              const beforeExists = fs.existsSync(writeArgs.path)
              let beforeText: string | undefined
              if (beforeExists) {
                try {
                  beforeText = await fs.promises.readFile(writeArgs.path, 'utf-8')
                } catch {
                  // best-effort: skip diff if read fails
                }
              }
              const dir = path.dirname(writeArgs.path)
              if (!fs.existsSync(dir)) {
                await fs.promises.mkdir(dir, { recursive: true })
              }
              await fs.promises.writeFile(writeArgs.path, writeArgs.content, 'utf-8')
              recordLocalTextWriteChange({
                meta: writeArgs.changeMeta,
                filePath: writeArgs.path,
                beforeExists,
                beforeText,
                afterText: writeArgs.content
              })
              return { success: true, op: beforeExists ? 'modify' : 'create' }
            } catch (err) {
              return { error: String(err) }
            }
          }
          default:
            throw new Error(`Unsupported electron invoke channel: ${channel}`)
        }
      }
      case 'renderer/provider-stream-start': {
        const requestId = `sidecar-provider-stream-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        const focusedWindow = BrowserWindow.getFocusedWindow()
        const candidateWindows = focusedWindow
          ? [focusedWindow, ...BrowserWindow.getAllWindows().filter((win) => win !== focusedWindow)]
          : BrowserWindow.getAllWindows()

        const targetWindow = candidateWindows.find(
          (win) =>
            !win.isDestroyed() && !win.webContents.isDestroyed() && !win.webContents.isCrashed()
        )

        if (!targetWindow) {
          throw new Error('No renderer available for provider stream request')
        }

        return await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingProviderStreamRequests.delete(requestId)
            reject(new Error('Renderer provider stream request timed out'))
          }, SIDECAR_RENDERER_REQUEST_TIMEOUT_MS)

          pendingProviderStreamRequests.set(requestId, { resolve, reject, timer })

          const sent = safeSendToWindow(targetWindow, 'sidecar:provider-stream-start', {
            requestId,
            method,
            params
          })

          if (!sent) {
            clearTimeout(timer)
            pendingProviderStreamRequests.delete(requestId)
            reject(new Error('Failed to deliver provider stream request to renderer'))
          }
        })
      }
      case 'renderer/tool-request': {
        const requestId = `sidecar-renderer-tool-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        const focusedWindow = BrowserWindow.getFocusedWindow()
        const candidateWindows = focusedWindow
          ? [focusedWindow, ...BrowserWindow.getAllWindows().filter((win) => win !== focusedWindow)]
          : BrowserWindow.getAllWindows()

        const targetWindow = candidateWindows.find(
          (win) =>
            !win.isDestroyed() && !win.webContents.isDestroyed() && !win.webContents.isCrashed()
        )

        if (!targetWindow) {
          throw new Error('No renderer available for tool request')
        }

        return await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingRendererToolRequests.delete(requestId)
            reject(new Error('Renderer tool request timed out'))
          }, SIDECAR_RENDERER_REQUEST_TIMEOUT_MS)

          pendingRendererToolRequests.set(requestId, { resolve, reject, timer })

          const sent = safeSendToWindow(targetWindow, 'sidecar:renderer-tool-request', {
            requestId,
            method,
            params
          })

          if (!sent) {
            clearTimeout(timer)
            pendingRendererToolRequests.delete(requestId)
            reject(new Error('Failed to deliver tool request to renderer'))
          }
        })
      }
      default:
        throw new Error(`Unsupported reverse method: ${method}`)
    }
  })

  ipcMain.handle('sidecar:status', () => {
    return { running: manager.isRunning }
  })

  ipcMain.handle('sidecar:start', async () => {
    return { ok: await manager.ensureStarted() }
  })

  ipcMain.handle('sidecar:stop', async () => {
    await manager.stop()
    return { ok: true }
  })

  ipcMain.handle('sidecar:request', async (_event, method: string, params: unknown) => {
    console.log(`[Sidecar] request start: ${method}`)
    if (!manager.isRunning) {
      console.warn(`[Sidecar] request rejected, not running: ${method}`)
      throw new Error('SIDECAR_UNAVAILABLE')
    }
    try {
      const result = await manager.request(method, params)
      console.log(`[Sidecar] request success: ${method}`)
      return result
    } catch (error) {
      console.warn(
        `[Sidecar] request failed: ${method}: ${error instanceof Error ? error.message : String(error)}`
      )
      throw error
    }
  })

  ipcMain.handle('agent:run', async (_event, params: unknown) => {
    console.log('[Sidecar] agent:run requested')
    const ready = await manager.ensureStarted()
    if (!ready) throw new Error('SIDECAR_UNAVAILABLE')
    try {
      const result = await manager.request('agent/run', params, 60_000)
      console.log('[Sidecar] agent:run request accepted')
      return result
    } catch (error) {
      console.warn(
        `[Sidecar] agent:run failed: ${error instanceof Error ? error.message : String(error)}`
      )
      throw error
    }
  })

  ipcMain.handle('agent:cancel', async (_event, params: unknown) => {
    if (!manager.isRunning) {
      return { cancelled: false }
    }
    return await manager.request('agent/cancel', params, 10_000)
  })

  ipcMain.handle('agent:append-messages', async (_event, params: unknown) => {
    if (!manager.isRunning) {
      return { appended: false, count: 0 }
    }
    return await manager.request('agent/append-messages', params, 10_000)
  })

  ipcMain.on(
    'agent:session-visibility',
    (_event, payload: { sessionId: string; visible: boolean }) => {
      if (payload?.sessionId) {
        manager.setSessionVisibility(payload.sessionId, payload.visible === true)
      }
    }
  )

  ipcMain.on('sidecar:notify', (_event, method: string, params: unknown) => {
    if (manager.isRunning) {
      manager.notify(method, params)
    }
  })

  ipcMain.handle(
    'sidecar:approval-response',
    async (
      _event,
      payload: { requestId: string; approved: boolean; reason?: string }
    ): Promise<{ ok: boolean }> => {
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
  )

  ipcMain.handle(
    'sidecar:provider-stream-response',
    async (
      _event,
      payload: { requestId: string; result?: unknown; error?: string }
    ): Promise<{ ok: boolean }> => {
      const pending = pendingProviderStreamRequests.get(payload.requestId)
      if (!pending) return { ok: false }

      pendingProviderStreamRequests.delete(payload.requestId)
      clearTimeout(pending.timer)
      if (payload.error) {
        pending.reject(new Error(payload.error))
      } else {
        pending.resolve(payload.result)
      }
      return { ok: true }
    }
  )

  // Streaming SSE events coming back from the renderer provider bridge.
  // Forwarded to the sidecar as a JSON-RPC notification (no response).
  ipcMain.on(
    'sidecar:provider-stream-event',
    (_event, payload: { streamId: string; event?: unknown; done?: boolean; error?: string }) => {
      if (!payload || typeof payload.streamId !== 'string') return
      if (manager.isRunning) {
        manager.notify('provider/stream-event', {
          streamId: payload.streamId,
          event: payload.event ?? null,
          done: payload.done === true,
          ...(payload.error ? { error: payload.error } : {})
        })
      }
    }
  )

  ipcMain.handle(
    'sidecar:renderer-tool-response',
    async (
      _event,
      payload: { requestId: string; result?: unknown; error?: string }
    ): Promise<{ ok: boolean }> => {
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
  )

  /**
   * Check if the sidecar can handle a specific capability.
   * Used by the renderer to decide whether to route through
   * sidecar or use the existing Node.js fallback path.
   */
  ipcMain.handle('sidecar:can-handle', async (_event, capability: string) => {
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
