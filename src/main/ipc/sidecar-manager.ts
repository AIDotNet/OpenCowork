import { ipcMain, app, BrowserWindow } from 'electron'
import { safeSendToWindow } from '../window-ipc'
import { spawn, type ChildProcess } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
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

const SIDECAR_RESTART_DELAY_MS = 2000
const SIDECAR_MAX_RESTARTS = 5
const SIDECAR_PING_INTERVAL_MS = 30_000
const SIDECAR_PING_TIMEOUT_MS = 5000
const SIDECAR_RENDERER_REQUEST_TIMEOUT_MS = 10 * 60_000
const SIDECAR_MAX_BUFFER_BYTES = 1024 * 1024 // 1 MB

interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

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

export class SidecarManager {
  private process: ChildProcess | null = null
  private restartCount = 0
  private nextRequestId = 1
  private pendingRequests = new Map<number | string, PendingRequest>()
  private buffer = ''
  private isShuttingDown = false
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private onEvent: ((method: string, params: unknown) => void) | null = null
  private onRequestFromSidecar:
    | ((id: number | string, method: string, params: unknown) => Promise<unknown>)
    | null = null
  private devPublishPromise: Promise<boolean> | null = null
  private initializePromise: Promise<boolean> | null = null
  private initialized = false

  /**
   * Register a callback for notifications (events) from the sidecar.
   */
  setEventHandler(handler: (method: string, params: unknown) => void): void {
    this.onEvent = handler
  }

  /**
   * Register a handler for requests FROM the sidecar (e.g. approval, electron/invoke).
   */
  setRequestHandler(
    handler: (id: number | string, method: string, params: unknown) => Promise<unknown>
  ): void {
    this.onRequestFromSidecar = handler
  }

  private getSidecarRuntime(): string {
    if (process.platform === 'win32') {
      return process.arch === 'arm64' ? 'win-arm64' : 'win-x64'
    }

    if (process.platform === 'darwin') {
      return process.arch === 'x64' ? 'osx-x64' : 'osx-arm64'
    }

    return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
  }

  private getDevPublishedSidecarPath(): string {
    const ext = process.platform === 'win32' ? '.exe' : ''
    return path.join(
      app.getAppPath(),
      'out',
      'sidecar',
      this.getSidecarRuntime(),
      `OpenCowork.Agent${ext}`
    )
  }

  private shouldAutoPublishDevSidecar(): boolean {
    return !app.isPackaged && process.env.npm_lifecycle_event === 'dev'
  }

  private async ensureDevSidecarPublished(): Promise<boolean> {
    if (!this.shouldAutoPublishDevSidecar()) return true
    if (this.devPublishPromise) return this.devPublishPromise

    this.devPublishPromise = new Promise<boolean>((resolve) => {
      const projectPath = path.join(
        app.getAppPath(),
        'src',
        'dotnet',
        'OpenCowork.Agent',
        'OpenCowork.Agent.csproj'
      )
      const outputDir = path.join(app.getAppPath(), 'out', 'sidecar', this.getSidecarRuntime())

      if (!fs.existsSync(projectPath)) {
        console.warn(`[Sidecar] Dev auto-publish skipped, project missing: ${projectPath}`)
        resolve(false)
        return
      }

      console.log(`[Sidecar] Dev auto-publish starting -> ${outputDir}`)
      const child = spawn(
        'dotnet',
        [
          'publish',
          projectPath,
          '--configuration',
          'Release',
          '--runtime',
          this.getSidecarRuntime(),
          '--output',
          outputDir,
          '/p:PublishAot=true',
          '/p:TrimMode=full',
          '/p:StripSymbols=true'
        ],
        {
          cwd: app.getAppPath(),
          windowsHide: true,
          env: { ...process.env }
        }
      )

      let stderr = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim()
        if (text) console.log(`[Sidecar build] ${text}`)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim()
        if (!text) return
        stderr += `${text}\n`
        console.warn(`[Sidecar build] ${text}`)
      })
      child.on('error', (error) => {
        console.error(`[Sidecar] Dev auto-publish failed: ${error.message}`)
        resolve(false)
      })
      child.on('exit', (code) => {
        if (code === 0) {
          console.log('[Sidecar] Dev auto-publish completed successfully')
          resolve(true)
          return
        }
        console.error(
          `[Sidecar] Dev auto-publish failed with code=${code}${stderr ? ` stderr=${stderr.trim()}` : ''}`
        )
        resolve(false)
      })
    }).finally(() => {
      this.devPublishPromise = null
    })

    return this.devPublishPromise
  }

  /**
   * Find the sidecar binary path based on platform and packaging.
   */
  private getSidecarPath(): string {
    const isDev = !app.isPackaged
    const platform = process.platform
    const ext = platform === 'win32' ? '.exe' : ''
    const binaryName = `OpenCowork.Agent${ext}`

    if (isDev) {
      const runtime = this.getSidecarRuntime()

      // In development, prefer the explicitly published sidecar output used by local packaging flows.
      const outPath = path.join(app.getAppPath(), 'out', 'sidecar', runtime, binaryName)

      // Fallback to the dotnet release output directory.
      const devPath = path.join(
        app.getAppPath(),
        'src',
        'dotnet',
        'OpenCowork.Agent',
        'bin',
        'Release',
        'net10.0',
        runtime,
        'publish',
        binaryName
      )

      // Final fallback to Debug.
      const debugPath = path.join(
        app.getAppPath(),
        'src',
        'dotnet',
        'OpenCowork.Agent',
        'bin',
        'Debug',
        'net10.0',
        binaryName
      )

      if (fs.existsSync(outPath)) return outPath
      if (fs.existsSync(devPath)) return devPath
      if (fs.existsSync(debugPath)) return debugPath
      // Last resort: try dotnet run
      return ''
    }

    const runtime = this.getSidecarRuntime()

    // In production, tolerate both flattened and runtime-scoped sidecar layouts.
    const prodCandidates = [
      path.join(process.resourcesPath, 'sidecar', binaryName),
      path.join(process.resourcesPath, 'sidecar', runtime, binaryName),
      path.join(process.resourcesPath, 'resources', 'sidecar', binaryName),
      path.join(process.resourcesPath, 'resources', 'sidecar', runtime, binaryName),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'sidecar', binaryName),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'sidecar', runtime, binaryName)
    ]

    for (const candidate of prodCandidates) {
      if (fs.existsSync(candidate)) return candidate
    }

    console.warn(`[Sidecar] No production binary found. Checked: ${prodCandidates.join(', ')}`)
    return prodCandidates[0]
  }

  async start(): Promise<boolean> {
    if (this.process) {
      console.log('[Sidecar] start() skipped: process already exists')
      return true
    }

    this.isShuttingDown = false

    if (this.shouldAutoPublishDevSidecar()) {
      const published = await this.ensureDevSidecarPublished()
      if (!published && !fs.existsSync(this.getDevPublishedSidecarPath())) {
        console.warn('[Sidecar] Dev auto-publish did not produce a usable sidecar binary')
      }
    }

    const sidecarPath = this.getSidecarPath()
    console.log(
      `[Sidecar] start() called. appPath=${app.getAppPath()} packaged=${app.isPackaged} resolvedPath=${sidecarPath || '<dotnet-run>'}`
    )

    if (!sidecarPath) {
      // Dev mode without AOT build: run via dotnet
      return this.startViaDotnetRun()
    }

    if (!fs.existsSync(sidecarPath)) {
      console.warn(`[Sidecar] Binary not found at ${sidecarPath}`)
      return false
    }

    return this.spawnProcess(sidecarPath, [])
  }

  private async startViaDotnetRun(): Promise<boolean> {
    const projectDir = path.join(app.getAppPath(), 'src', 'dotnet', 'OpenCowork.Agent')
    const projectFile = path.join(projectDir, 'OpenCowork.Agent.csproj')
    console.log(`[Sidecar] startViaDotnetRun projectDir=${projectDir}`)
    if (!fs.existsSync(projectFile)) {
      console.warn(`[Sidecar] .NET project not found for dev mode: ${projectFile}`)
      return false
    }
    return this.spawnProcess('dotnet', ['run', '--project', projectDir])
  }

  private spawnProcess(command: string, args: string[]): boolean {
    try {
      console.log(`[Sidecar] Starting: ${command} ${args.join(' ')}`)

      this.process = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
        windowsHide: true
      })

      this.buffer = ''

      this.process.stdout!.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString()
        // Guard against unbounded buffer growth if processBuffer() can't keep up
        if (this.buffer.length > SIDECAR_MAX_BUFFER_BYTES) {
          console.warn(
            `[Sidecar] Buffer exceeded ${SIDECAR_MAX_BUFFER_BYTES} bytes, truncating to last newline`
          )
          const lastNewline = this.buffer.lastIndexOf('\n')
          this.buffer = lastNewline >= 0 ? this.buffer.slice(lastNewline + 1) : ''
        }
        this.processBuffer()
      })

      this.process.stderr!.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim()
        if (text) console.log(`[Sidecar stderr] ${text}`)
      })

      this.process.on('exit', (code, signal) => {
        console.log(`[Sidecar] Exited with code=${code} signal=${signal}`)
        this.process = null
        this.initialized = false
        this.initializePromise = null
        this.rejectAllPending('Sidecar process exited')

        if (!this.isShuttingDown && this.restartCount < SIDECAR_MAX_RESTARTS) {
          this.restartCount++
          console.log(
            `[Sidecar] Restarting (attempt ${this.restartCount}/${SIDECAR_MAX_RESTARTS})...`
          )
          setTimeout(() => this.start(), SIDECAR_RESTART_DELAY_MS)
        }
      })

      this.process.on('error', (err) => {
        console.error(`[Sidecar] Process error: ${err.message}`)
        this.process = null
        this.initialized = false
        this.initializePromise = null
      })

      this.startPingTimer()
      return true
    } catch (err) {
      console.error(`[Sidecar] Failed to spawn: ${err}`)
      return false
    }
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      try {
        const msg = JSON.parse(trimmed) as JsonRpcMessage
        this.handleMessage(msg)
      } catch {
        console.warn(`[Sidecar] Failed to parse: ${trimmed.slice(0, 200)}`)
      }
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    // Response to our request
    if (msg.id !== undefined && !msg.method) {
      const pending = this.pendingRequests.get(msg.id)
      if (pending) {
        this.pendingRequests.delete(msg.id)
        clearTimeout(pending.timer)
        if (msg.error) {
          pending.reject(new Error(`JSON-RPC error ${msg.error.code}: ${msg.error.message}`))
        } else {
          pending.resolve(msg.result)
        }
      }
      return
    }

    // Notification from sidecar (no id)
    if (msg.method && msg.id === undefined) {
      this.onEvent?.(msg.method, msg.params)
      return
    }

    // Request from sidecar (has id and method) -- e.g. approval, electron/invoke
    if (msg.method && msg.id !== undefined) {
      this.handleRequestFromSidecar(msg)
    }
  }

  private async handleRequestFromSidecar(msg: JsonRpcMessage): Promise<void> {
    if (!this.onRequestFromSidecar) {
      this.sendMessage({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'No handler registered' }
      })
      return
    }

    try {
      const result = await this.onRequestFromSidecar(msg.id!, msg.method!, msg.params)
      this.sendMessage({ jsonrpc: '2.0', id: msg.id, result })
    } catch (err) {
      this.sendMessage({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) }
      })
    }
  }

  /**
   * Send a JSON-RPC request to the sidecar and wait for a response.
   */
  async request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (!this.process) throw new Error('Sidecar not running')

    const id = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Sidecar request timeout: ${method}`))
      }, timeoutMs)

      this.pendingRequests.set(id, { resolve, reject, timer })
      this.sendMessage({ jsonrpc: '2.0', id, method, params })
    })
  }

  /**
   * Send a JSON-RPC notification to the sidecar (no response expected).
   */
  notify(method: string, params?: unknown): void {
    this.sendMessage({ jsonrpc: '2.0', method, params })
  }

  private sendMessage(msg: JsonRpcMessage): void {
    if (!this.process?.stdin?.writable) return
    const line = JSON.stringify(msg) + '\n'
    this.process.stdin.write(line)
  }

  private startPingTimer(): void {
    this.stopPingTimer()
    this.pingTimer = setInterval(async () => {
      try {
        await this.request('ping', { timestamp: Date.now() }, SIDECAR_PING_TIMEOUT_MS)
        this.restartCount = 0 // Reset on successful ping
      } catch {
        console.warn('[Sidecar] Ping failed')
      }
    }, SIDECAR_PING_INTERVAL_MS)
  }

  private stopPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.pendingRequests.clear()
  }

  get isRunning(): boolean {
    return this.process !== null
  }

  async ensureStarted(): Promise<boolean> {
    if (!this.process) {
      const ok = await this.start()
      if (!ok) return false
    }

    if (this.initialized) return true
    if (this.initializePromise) return this.initializePromise

    this.initializePromise = this.request('initialize', {}, 30_000)
      .then(() => {
        this.initialized = true
        return true
      })
      .catch((error) => {
        this.initialized = false
        throw error
      })
      .finally(() => {
        this.initializePromise = null
      })

    return this.initializePromise
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true
    this.initialized = false
    this.initializePromise = null
    this.stopPingTimer()

    if (!this.process) return

    try {
      await this.request('shutdown', undefined, 3000)
    } catch {
      // Force kill if graceful shutdown fails
    }

    if (this.process) {
      this.process.kill()
      this.process = null
    }

    this.rejectAllPending('Sidecar stopped')
  }
}

// Singleton instance
let sidecarInstance: SidecarManager | null = null

export function getSidecarManager(): SidecarManager {
  if (!sidecarInstance) {
    sidecarInstance = new SidecarManager()
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

  manager.setEventHandler((method, params) => {
    if (method === 'agent/event') {
      const payload = params as { runId?: string; event?: { type?: string } } | null
      console.log(
        `[Sidecar] event forwarded: ${payload?.event?.type ?? 'unknown'} runId=${payload?.runId ?? ''}`
      )
    }
    for (const win of BrowserWindow.getAllWindows()) {
      safeSendToWindow(win, 'sidecar:event', { method, params })
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
          (win) => !win.isDestroyed() && !win.webContents.isDestroyed() && !win.webContents.isCrashed()
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
          default:
            throw new Error(`Unsupported electron invoke channel: ${channel}`)
        }
      }
      case 'renderer/tool-request': {
        const requestId = `sidecar-renderer-tool-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        const focusedWindow = BrowserWindow.getFocusedWindow()
        const candidateWindows = focusedWindow
          ? [focusedWindow, ...BrowserWindow.getAllWindows().filter((win) => win !== focusedWindow)]
          : BrowserWindow.getAllWindows()

        const targetWindow = candidateWindows.find(
          (win) => !win.isDestroyed() && !win.webContents.isDestroyed() && !win.webContents.isCrashed()
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
