import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  clipboard,
  nativeImage,
  dialog,
  session
} from 'electron'

import { join, extname } from 'path'
import { pathToFileURL } from 'url'
import { mkdirSync, writeFileSync } from 'fs'
import { homedir, hostname, release, totalmem } from 'os'
import { randomUUID } from 'crypto'
import { spawn } from 'child_process'

// Delay import of @electron-toolkit/utils to avoid accessing app before ready
let electronApp: any
let optimizer: any
let is: any

import icon from '../../resources/icon.png?asset'
import icon_mac from '../../resources/icon-mac.png?asset'

import { registerFsHandlers } from './ipc/fs-handlers'
import { registerAgentChangeHandlers } from './ipc/agent-change-handlers'

import { registerShellHandlers } from './ipc/shell-handlers'

import { registerApiProxyHandlers } from './ipc/api-proxy'

import { registerSettingsHandlers } from './ipc/settings-handlers'

import { registerSkillsHandlers } from './ipc/skills-handlers'
import { registerAgentsHandlers } from './ipc/agents-handlers'
import { registerPromptsHandlers } from './ipc/prompts-handlers'
import { registerCommandsHandlers } from './ipc/commands-handlers'
import { registerProcessManagerHandlers, killAllManagedProcesses } from './ipc/process-manager'
import { registerTerminalHandlers, killAllTerminalSessions } from './ipc/terminal-handlers'
import { registerDbHandlers } from './ipc/db-handlers'
import { registerConfigHandlers } from './ipc/secure-key-store'
import { registerChannelHandlers, autoStartChannels } from './ipc/channel-handlers'
import { ChannelManager } from './channels/channel-manager'
import { autoConnectMcpServers, registerMcpHandlers } from './ipc/mcp-handlers'
import { registerCronHandlers } from './ipc/cron-handlers'
import { registerInputHandlers } from './ipc/input-handlers'
import { registerNotifyHandlers } from './ipc/notify-handlers'
import { registerScreenshotHandlers } from './ipc/screenshot-handlers'
import { registerWebSearchHandlers } from './ipc/web-search-handlers'
import { registerOauthHandlers } from './ipc/oauth-handlers'
import { registerImageGifHandlers } from './ipc/image-gif-handlers'
import { registerGitHandlers } from './ipc/git-handlers'
import { registerWikiHandlers } from './ipc/wiki-handlers'
import { registerMigrationHandlers } from './ipc/migration-handlers'
import { registerSidecarHandlers, getSidecarManager } from './ipc/sidecar-manager'
import { registerTeamRuntimeHandlers } from './ipc/team-runtime-handlers'
import { registerTeamWorkerHandlers, stopAllIsolatedTeamWorkers } from './ipc/team-worker-handlers'
import { loadPersistedJobs, cancelAllJobs } from './cron/cron-scheduler'
import { McpManager } from './mcp/mcp-manager'
import { closeDb } from './db/database'
import { registerSshHandlers, closeAllSshSessions } from './ipc/ssh-handlers'
import { writeCrashLog, getCrashLogDir } from './crash-logger'
import { setupAutoUpdater } from './updater'
import { safeSendToWindow } from './window-ipc'
import * as sessionsDao from './db/sessions-dao'

import { createFeishuService } from './channels/providers/feishu/feishu-service'
import { FeishuApi } from './channels/providers/feishu/feishu-api'
import { createDingTalkService } from './channels/providers/dingtalk/dingtalk-service'
import { createTelegramService } from './channels/providers/telegram/telegram-service'
import { parseTelegramWsMessage } from './channels/providers/telegram/parse-ws-message'
import { createDiscordService } from './channels/providers/discord/discord-service'
import { parseDiscordWsMessage } from './channels/providers/discord/parse-ws-message'
import { createWhatsAppService } from './channels/providers/whatsapp/whatsapp-service'
import { parseWhatsAppWsMessage } from './channels/providers/whatsapp/parse-ws-message'
import { createWeComService } from './channels/providers/wecom/wecom-service'
import { parseWeComWsMessage } from './channels/providers/wecom/parse-ws-message'
import { createQQService } from './channels/providers/qq/qq-service'
import { parseQQWsMessage } from './channels/providers/qq/parse-ws-message'
import { createWeixinService } from './channels/providers/weixin/weixin-service'
import { setPluginManager } from './channels/auto-reply'

const channelManager = new ChannelManager()
setPluginManager(channelManager)
channelManager.registerFactory('feishu-bot', createFeishuService)
// Feishu uses official SDK WSClient — no generic parser needed
channelManager.registerFactory('dingtalk-bot', createDingTalkService)
// DingTalk uses built-in Stream protocol handling — no generic parser needed
channelManager.registerFactory('telegram-bot', createTelegramService)
channelManager.registerParser('telegram-bot', parseTelegramWsMessage)
channelManager.registerFactory('discord-bot', createDiscordService)
channelManager.registerParser('discord-bot', parseDiscordWsMessage)
channelManager.registerFactory('whatsapp-bot', createWhatsAppService)
channelManager.registerParser('whatsapp-bot', parseWhatsAppWsMessage)
channelManager.registerFactory('wecom-bot', createWeComService)
channelManager.registerParser('wecom-bot', parseWeComWsMessage)
channelManager.registerFactory('qq-bot', createQQService)
channelManager.registerParser('qq-bot', parseQQWsMessage)
channelManager.registerFactory('weixin-official', createWeixinService)

const mcpManager = new McpManager()

let mainWindow: BrowserWindow | null = null
let sshWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuiting = false
const detachedSessionWindows = new Map<string, BrowserWindow>()

const GENERATED_IMAGES_DIR = 'generated-images'
const MACOS_SHELL_ENV_TIMEOUT_MS = 4000
const SHELL_ENV_LINE_RE = /^[A-Za-z_][A-Za-z0-9_]*=/
const SHELL_ENV_SKIP_KEYS = new Set(['PWD', 'OLDPWD', 'SHLVL', '_'])
const SYSTEM_PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']

function getEnvProxyUrl(): string | null {
  for (const key of SYSTEM_PROXY_ENV_KEYS) {
    const value = process.env[key]?.trim()
    if (value) return value
  }
  return null
}

async function configureSystemProxy(): Promise<void> {
  try {
    const { readSettings } = await import('./ipc/settings-handlers')
    const saved = readSettings().systemProxyUrl
    const proxyUrl = (typeof saved === 'string' && saved.trim()) ? saved.trim() : getEnvProxyUrl()

    if (proxyUrl) {
      await session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: proxyUrl })
      console.log(`[Main] System proxy configured: ${proxyUrl}`)
    } else {
      await session.defaultSession.setProxy({ mode: 'system' })
      console.log('[Main] Using system proxy settings')
    }
  } catch (err) {
    console.error('[Main] Failed to configure system proxy:', err)
  }
}

function parseShellEnvironmentOutput(output: string): Record<string, string> {
  const nextEnv: Record<string, string> = {}
  const lines = output.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')

  for (const line of lines) {
    if (!SHELL_ENV_LINE_RE.test(line)) continue
    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0) continue

    const key = line.slice(0, separatorIndex)
    if (SHELL_ENV_SKIP_KEYS.has(key)) continue

    nextEnv[key] = line.slice(separatorIndex + 1)
  }

  return nextEnv
}

async function syncMacOSShellEnvironment(): Promise<void> {
  if (process.platform !== 'darwin') return

  const shellPath = process.env.SHELL?.trim() || '/bin/zsh'

  await new Promise<void>((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let timedOut = false

    const finish = (): void => {
      if (settled) return
      settled = true
      resolve()
    }

    const child = spawn(shellPath, ['-l', '-i', '-c', '/usr/bin/env'], {
      cwd: homedir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    })

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        finish()
      }
    }, MACOS_SHELL_ENV_TIMEOUT_MS)

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString('utf8')
    })

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString('utf8')
    })

    child.on('error', (error) => {
      clearTimeout(timer)
      console.warn('[Main] Failed to load macOS shell environment:', error)
      finish()
    })

    child.on('close', (code) => {
      clearTimeout(timer)

      if (timedOut) {
        console.warn('[Main] Timed out while loading macOS shell environment')
        finish()
        return
      }

      if (code !== 0) {
        console.warn(
          `[Main] macOS shell environment exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`
        )
        finish()
        return
      }

      const shellEnv = parseShellEnvironmentOutput(stdout)
      if (Object.keys(shellEnv).length === 0) {
        console.warn('[Main] macOS shell environment output was empty')
        finish()
        return
      }

      Object.assign(process.env, shellEnv)
      finish()
    })
  })
}

function getGeneratedImagesDir(): string {
  const dir = join(app.getPath('userData'), GENERATED_IMAGES_DIR)
  mkdirSync(dir, { recursive: true })
  return dir
}

function guessMimeTypeFromExtension(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.bmp':
      return 'image/bmp'
    case '.svg':
      return 'image/svg+xml'
    default:
      return 'image/png'
  }
}

function guessExtensionFromMimeType(mediaType?: string): string {
  switch ((mediaType || '').toLowerCase()) {
    case 'image/jpeg':
      return '.jpg'
    case 'image/webp':
      return '.webp'
    case 'image/gif':
      return '.gif'
    case 'image/bmp':
      return '.bmp'
    case 'image/svg+xml':
      return '.svg'
    default:
      return '.png'
  }
}

function persistGeneratedImageFile(args: {
  buffer: Buffer
  mediaType?: string
  sourceUrl?: string
}): { filePath: string; mediaType: string; data: string } {
  const urlExt = args.sourceUrl ? extname(args.sourceUrl.split('?')[0]) : ''
  const mediaType =
    args.mediaType && args.mediaType !== 'url'
      ? args.mediaType
      : guessMimeTypeFromExtension(urlExt || '.png')
  const fileExt = urlExt || guessExtensionFromMimeType(mediaType)
  const filePath = join(getGeneratedImagesDir(), `${Date.now()}-${randomUUID()}${fileExt}`)
  writeFileSync(filePath, args.buffer)
  return {
    filePath,
    mediaType,
    data: args.buffer.toString('base64')
  }
}

function recordCrash(event: string, details: unknown): void {
  writeCrashLog(event, details)
}

function getWindowDiagnosticContext(window: BrowserWindow): Record<string, unknown> {
  const webContents = window.webContents
  return {
    windowId: window.id,
    webContentsId: webContents.id,
    url: webContents.getURL(),
    title: window.getTitle(),
    isVisible: window.isVisible(),
    processId: webContents.getProcessId()
  }
}

function buildReducedMemoryRecoveryUrl(rawUrl: string): string | null {
  if (!rawUrl) return null

  try {
    const nextUrl = new URL(rawUrl)
    nextUrl.searchParams.set('ocRecoverRendererOom', '1')
    return nextUrl.toString()
  } catch (error) {
    console.warn('[Main] Failed to build reduced-memory recovery URL:', error)
    return null
  }
}

function attachWindowCrashLogging(window: BrowserWindow): void {
  const webContents = window.webContents
  let attemptedOomReload = false
  let lastOomReloadAt = 0

  webContents.on('render-process-gone', (_event, details) => {
    const crashInfo = {
      ...getWindowDiagnosticContext(window),
      details
    }
    console.error('[Main] Window render process gone:', crashInfo)
    recordCrash('window_render_process_gone', crashInfo)

    if (details.reason === 'oom') {
      const now = Date.now()
      const elapsedSinceLastReload = now - lastOomReloadAt
      if (!attemptedOomReload || elapsedSinceLastReload > 15_000) {
        attemptedOomReload = true
        lastOomReloadAt = now
        setTimeout(() => {
          try {
            if (window.isDestroyed()) return
            const recoveryUrl = buildReducedMemoryRecoveryUrl(webContents.getURL())
            if (recoveryUrl) {
              void webContents.loadURL(recoveryUrl)
            } else {
              window.reload()
            }
          } catch (err) {
            console.warn('[Main] Post-OOM reduced-memory recovery failed:', err)
          }
        }, 400)
      }
    }
  })

  webContents.on('unresponsive', () => {
    const hangInfo = getWindowDiagnosticContext(window)
    console.error('[Main] Renderer became unresponsive:', hangInfo)
    recordCrash('window_renderer_unresponsive', hangInfo)
  })

  webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      const failInfo = {
        ...getWindowDiagnosticContext(window),
        validatedURL,
        errorCode,
        errorDescription
      }
      console.error('[Main] Renderer failed to load:', failInfo)
      recordCrash('window_did_fail_load', failInfo)
    }
  )

  webContents.on('preload-error', (_event, preloadPath, error) => {
    const preloadInfo = {
      ...getWindowDiagnosticContext(window),
      preloadPath,
      error
    }
    console.error('[Main] Renderer preload error:', preloadInfo)
    recordCrash('window_preload_error', preloadInfo)
  })
}

function configureChromiumCachePaths(): void {
  const sessionDataPath = join(app.getPath('userData'), 'session-data')
  const diskCachePath = join(sessionDataPath, 'Cache')

  try {
    mkdirSync(sessionDataPath, { recursive: true })
    mkdirSync(diskCachePath, { recursive: true })
    app.setPath('sessionData', sessionDataPath)
    app.commandLine.appendSwitch('disk-cache-dir', diskCachePath)
  } catch (error) {
    console.error('[Main] Failed to configure Chromium cache paths:', error)
    recordCrash('configure_chromium_cache_failed', { error })
  }
}

/** Cap renderer V8 old-space to 1/4 of system RAM (min 512 MB). Must run before ready. */
function configureRendererHeapLimit(): void {
  try {
    const systemMemMb = Math.floor(totalmem() / (1024 * 1024))
    const heapSizeMb = Math.max(512, Math.floor(systemMemMb / 4))
    app.commandLine.appendSwitch('js-flags', `--max-old-space-size=${heapSizeMb}`)
  } catch (error) {
    console.warn('[Main] Failed to set renderer heap limit:', error)
  }
}

function showMainWindow(): void {
  if (!mainWindow) {
    createWindow()

    return
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }

  mainWindow.show()

  mainWindow.focus()
}

function buildRendererUrl(searchParams?: URLSearchParams): string {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const baseUrl = new URL(process.env['ELECTRON_RENDERER_URL'])
    if (searchParams) {
      for (const [key, value] of searchParams.entries()) {
        baseUrl.searchParams.set(key, value)
      }
    }
    return baseUrl.toString()
  }

  const fileUrl = pathToFileURL(join(__dirname, '../renderer/index.html'))
  if (searchParams) {
    for (const [key, value] of searchParams.entries()) {
      fileUrl.searchParams.set(key, value)
    }
  }
  return fileUrl.toString()
}

async function loadRendererWindow(window: BrowserWindow, searchParams?: URLSearchParams): Promise<void> {
  await window.loadURL(buildRendererUrl(searchParams))
}

function showSshWindow(): void {
  if (!sshWindow || sshWindow.isDestroyed()) {
    void createSshWindow()
    return
  }

  if (sshWindow.isMinimized()) {
    sshWindow.restore()
  }

  sshWindow.show()
  sshWindow.focus()
}

function getAttachedDetachedSessionWindow(sessionId: string): BrowserWindow | null {
  const existing = detachedSessionWindows.get(sessionId)
  if (!existing) return null
  if (existing.isDestroyed()) {
    detachedSessionWindows.delete(sessionId)
    return null
  }
  return existing
}

function focusDetachedSessionWindow(sessionId: string): boolean {
  const window = getAttachedDetachedSessionWindow(sessionId)
  if (!window) return false

  if (window.isMinimized()) {
    window.restore()
  }

  window.show()
  window.focus()
  return true
}

function closeDetachedSessionWindow(sessionId: string): boolean {
  const window = getAttachedDetachedSessionWindow(sessionId)
  if (!window) return false

  detachedSessionWindows.delete(sessionId)
  window.close()
  return true
}

async function openDetachedSessionWindow(
  sessionId: string
): Promise<{ handled: boolean; created?: boolean; error?: string }> {
  if (!sessionId) {
    return { handled: false, error: 'missing-session-id' }
  }

  if (focusDetachedSessionWindow(sessionId)) {
    return { handled: true, created: false }
  }

  const session = sessionsDao.getSession(sessionId)
  if (!session) {
    return { handled: false, error: 'session-not-found' }
  }

  const window = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    show: false,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 12, y: 12 } }
      : { frame: false }),
    autoHideMenuBar: true,
    icon: icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  detachedSessionWindows.set(sessionId, window)

  configureAppWindow(window, {
    onClosed: () => {
      const current = detachedSessionWindows.get(sessionId)
      if (current === window) {
        detachedSessionWindows.delete(sessionId)
      }
    }
  })

  const params = new URLSearchParams({ appView: 'session', sessionId })

  try {
    await loadRendererWindow(window, params)
    return { handled: true, created: true }
  } catch (error) {
    detachedSessionWindows.delete(sessionId)
    if (!window.isDestroyed()) {
      window.destroy()
    }
    console.error('[Main] Failed to open detached session window:', sessionId, error)
    return { handled: false, error: 'window-load-failed' }
  }
}

function getTrayIcon() {
  if (process.platform === 'darwin') {
    const image = nativeImage.createFromPath(icon_mac)
    const resized = image.resize({ width: 18, height: 18 })
    resized.setTemplateImage(true)
    return resized
  }

  const image = nativeImage.createFromPath(icon)
  return image
}

function createTray(): void {
  if (tray) return

  tray = new Tray(getTrayIcon())

  tray.setToolTip('OpenCoWork')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show App',

      click: () => showMainWindow()
    },
    {
      label: 'Open SSH',

      click: () => showSshWindow()
    },

    { type: 'separator' },

    {
      label: 'Exit',

      click: () => {
        isQuiting = true

        app.quit()
      }
    }
  ])

  tray.setContextMenu(contextMenu)

  tray.on('click', showMainWindow)
}

function registerWindowControlHandlers(): void {
  ipcMain.handle('window:minimize', (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender)
    targetWindow?.minimize()
  })

  ipcMain.handle('window:maximize', (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender)
    if (!targetWindow) return
    if (targetWindow.isMaximized()) targetWindow.unmaximize()
    else targetWindow.maximize()
  })

  ipcMain.handle('window:close', (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender)
    targetWindow?.close()
  })

  ipcMain.handle('window:isMaximized', (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender)
    return targetWindow?.isMaximized() ?? false
  })

  ipcMain.handle('ssh-window:open', () => {
    showSshWindow()
    return { success: true }
  })

  ipcMain.handle('session-window:open', async (_event, sessionId: string) => {
    return openDetachedSessionWindow(sessionId)
  })

  ipcMain.handle('session-window:focus-if-open', (_event, sessionId: string) => {
    return { handled: focusDetachedSessionWindow(sessionId) }
  })
}

function configureAppWindow(window: BrowserWindow, options?: { hideOnClose?: boolean; onClosed?: () => void }): void {
  window.on('maximize', () => safeSendToWindow(window, 'window:maximized', true))

  window.on('unmaximize', () => safeSendToWindow(window, 'window:maximized', false))

  window.on('ready-to-show', () => {
    window.show()
  })

  window.on('close', (event) => {
    if (options?.hideOnClose && !isQuiting) {
      event.preventDefault()

      window.hide()
    }
  })

  window.on('closed', () => {
    options?.onClosed?.()
  })

  window.webContents.setWindowOpenHandler((details) => {
    const url = details.url || ''
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url).catch((error) => {
        console.error('[Main] Failed to open external URL:', url, error)
      })
    }

    return { action: 'deny' }
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,

    height: 800,

    minWidth: 900,

    minHeight: 600,

    show: false,

    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 12, y: 12 } }
      : { frame: false }),

    autoHideMenuBar: true,

    icon: icon,

    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),

      sandbox: false
    }
  })

  const window = mainWindow

  if (!window) {
    return
  }

  configureAppWindow(window, {
    hideOnClose: true,
    onClosed: () => {
      mainWindow = null
    }
  })

  void loadRendererWindow(window)
}

async function createSshWindow(): Promise<void> {
  if (sshWindow && !sshWindow.isDestroyed()) {
    showSshWindow()
    return
  }

  sshWindow = new BrowserWindow({
    width: 1400,

    height: 900,

    minWidth: 1000,

    minHeight: 700,

    show: false,

    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 12, y: 12 } }
      : { frame: false }),

    autoHideMenuBar: true,

    icon: icon,

    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),

      sandbox: false
    }
  })

  const window = sshWindow
  if (!window) return

  configureAppWindow(window, {
    onClosed: () => {
      sshWindow = null
    }
  })

  const params = new URLSearchParams({ appView: 'ssh' })
  await loadRendererWindow(window, params)
}

// This method will be called when Electron has finished

// initialization and is ready to create browser windows.

// Some APIs can only be used after this event occurs.

// Prevent hard crashes from unhandled errors

process.on('uncaughtException', (err) => {
  console.error('[Main] Uncaught exception:', err)
  recordCrash('main_uncaught_exception', { error: err })
})

process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled rejection:', reason)
  recordCrash('main_unhandled_rejection', { reason })
})

app.on('child-process-gone', (_event, details) => {
  console.error('[Main] App child-process-gone:', details)
  recordCrash('app_child_process_gone', { details })
})

app.on('before-quit', () => {
  isQuiting = true
})

configureChromiumCachePaths()
configureRendererHeapLimit()

// 防止dev环境和生产环境冲突，导致无法启动
if (!app.isPackaged) {
  app.setName('OpenCoWork-dev')
} else {
  app.setName('OpenCoWork')
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

if (gotSingleInstanceLock) {
  app.on('second-instance', (_event, commandLine) => {
    const shouldOpenSsh = commandLine.some((arg) => arg.includes('appView=ssh'))
    if (shouldOpenSsh) {
      showSshWindow()
      return
    }
    showMainWindow()
  })

  app.whenReady().then(async () => {
    // Import @electron-toolkit/utils after app is ready
    const utils = require('@electron-toolkit/utils')
    electronApp = utils.electronApp
    optimizer = utils.optimizer
    is = utils.is

    await syncMacOSShellEnvironment()
    await configureSystemProxy()

    recordCrash('app_started', {
      userDataPath: app.getPath('userData'),
      crashLogDir: getCrashLogDir()
    })
    console.log(`[CrashLogger] Logs will be written to ${getCrashLogDir()}`)


    // Set app identity for Windows integration
    electronApp.setAppUserModelId('com.opencowork.app')

    // Default open or close DevTools by F12 in development

    // and ignore CommandOrControl + R in production.

    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
      attachWindowCrashLogging(window)
    })

    // IPC test

    ipcMain.on('ping', () => console.log('pong'))

    ipcMain.handle('app:homedir', () => homedir())
    ipcMain.handle('app:system-info', () => ({
      machineName: hostname(),
      platform: process.platform,
      arch: process.arch,
      release: release()
    }))
    registerWindowControlHandlers()

    // Register IPC handlers

    registerFsHandlers()
    registerAgentChangeHandlers()

    registerShellHandlers()

    registerApiProxyHandlers()

    registerSettingsHandlers()

    registerSkillsHandlers()
    registerAgentsHandlers()
    registerPromptsHandlers()
    registerCommandsHandlers()
    registerProcessManagerHandlers()
    registerTerminalHandlers()
    registerDbHandlers({
      onSessionDeleted: (sessionId) => {
        closeDetachedSessionWindow(sessionId)
      }
    })
    registerConfigHandlers()
    registerSshHandlers()
    registerChannelHandlers(channelManager)
    registerMcpHandlers(mcpManager)
    registerCronHandlers()
    registerScreenshotHandlers()
    registerInputHandlers()
    loadPersistedJobs()
    registerNotifyHandlers()
    registerWebSearchHandlers()
    registerOauthHandlers()
    registerImageGifHandlers()
    registerGitHandlers()
    registerWikiHandlers()
    registerMigrationHandlers()
    registerSidecarHandlers()
    registerTeamRuntimeHandlers()
    registerTeamWorkerHandlers()

    try {
      const sidecarReady = await getSidecarManager().ensureStarted()
      console.log(`[Sidecar] global startup ${sidecarReady ? 'ready' : 'unavailable'}`)
    } catch (error) {
      console.warn(
        `[Sidecar] global startup failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    // Clipboard: write PNG image from base64 data
    ipcMain.handle('clipboard:write-image', (_event, args: { data: string }) => {
      try {
        const buffer = Buffer.from(args.data, 'base64')
        const image = nativeImage.createFromBuffer(buffer)
        if (image.isEmpty()) return { error: 'Failed to create image from data' }
        clipboard.writeImage(image)
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    })

    ipcMain.handle(
      'window:capture-region',
      async (event, args: { x: number; y: number; width: number; height: number }) => {
        try {
          const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
          if (!win) return { error: 'No active window found' }

          const [contentWidth, contentHeight] = win.getContentSize()
          const x = Math.max(0, Math.min(Math.floor(args.x), Math.max(0, contentWidth - 1)))
          const y = Math.max(0, Math.min(Math.floor(args.y), Math.max(0, contentHeight - 1)))
          const width = Math.max(1, Math.min(Math.ceil(args.width), contentWidth - x))
          const height = Math.max(1, Math.min(Math.ceil(args.height), contentHeight - y))

          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
            return { error: 'Invalid capture bounds' }
          }

          const image = await win.webContents.capturePage({ x, y, width, height })
          if (image.isEmpty()) return { error: 'Failed to capture window region' }

          return {
            data: image.toPNG().toString('base64'),
            mediaType: 'image/png'
          }
        } catch (err) {
          return { error: String(err) }
        }
      }
    )

    ipcMain.handle(
      'image:persist-generated',
      async (
        _event,
        args: { data?: string; mediaType?: string; url?: string }
      ): Promise<{ filePath?: string; mediaType?: string; data?: string; error?: string }> => {
        try {
          let buffer: Buffer
          if (typeof args.data === 'string' && args.data.trim()) {
            buffer = Buffer.from(args.data, 'base64')
          } else if (typeof args.url === 'string' && args.url.trim()) {
            buffer = await FeishuApi.downloadUrl(args.url)
          } else {
            return { error: 'Missing image data or url' }
          }

          return persistGeneratedImageFile({
            buffer,
            mediaType: args.mediaType,
            sourceUrl: args.url
          })
        } catch (err) {
          return { error: String(err) }
        }
      }
    )

    ipcMain.handle('image:fetch-base64', async (_event, args: { url: string }) => {
      try {
        const buffer = await FeishuApi.downloadUrl(args.url)
        const fileExt = extname(args.url.split('?')[0]).toLowerCase()
        const mimeType =
          fileExt === '.jpg' || fileExt === '.jpeg'
            ? 'image/jpeg'
            : fileExt === '.webp'
              ? 'image/webp'
              : fileExt === '.gif'
                ? 'image/gif'
                : 'image/png'
        return { data: buffer.toString('base64'), mimeType }
      } catch (err) {
        return { error: String(err) }
      }
    })

    ipcMain.handle(
      'image:download',
      async (_event, args: { url: string; defaultName?: string }) => {
        const win = BrowserWindow.getFocusedWindow()
        if (!win) return { canceled: true }
        try {
          const buffer = await FeishuApi.downloadUrl(args.url)
          const rawName =
            args.defaultName?.trim() ||
            `image-${Date.now()}${extname(args.url.split('?')[0]) || '.png'}`
          const result = await dialog.showSaveDialog(win, {
            defaultPath: rawName,
            filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
          })
          if (result.canceled || !result.filePath) return { canceled: true }
          writeFileSync(result.filePath, buffer)
          return { success: true, filePath: result.filePath }
        } catch (err) {
          return { error: String(err) }
        }
      }
    )

    // Auto-start plugins with autoStart feature enabled
    void autoStartChannels(channelManager)
    void autoConnectMcpServers(mcpManager)

    createWindow()

    createTray()

    setupAutoUpdater({
      getMainWindow: () => mainWindow,
      markAppWillQuit: () => {
        isQuiting = true
      }
    })

    app.on('activate', function () {
      // On macOS it's common to re-create a window in the app when the

      // dock icon is clicked and there are no other windows open.

      if (!mainWindow) createWindow()
      else showMainWindow()
    })
  })
}

// Quit when all windows are closed, except on macOS. There, it's common

// for applications and their menu bar to stay active until the user quits

// explicitly with Cmd + Q.

app.on('window-all-closed', () => {
  channelManager.stopAll()
  mcpManager.disconnectAll()
  killAllManagedProcesses()
  killAllTerminalSessions()
  closeAllSshSessions()
  cancelAllJobs()
  stopAllIsolatedTeamWorkers()
  getSidecarManager().stop().catch(() => { })
  closeDb()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process

// code. You can also put them in separate files and require them here.
