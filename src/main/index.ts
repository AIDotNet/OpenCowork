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
  session,
  net,
  type IpcMainEvent
} from 'electron'

import { join, extname, resolve, sep } from 'path'
import { pathToFileURL } from 'url'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { homedir, hostname, release, totalmem } from 'os'
import { randomUUID } from 'crypto'
import { spawn } from 'child_process'

// Delay import of @electron-toolkit/utils to avoid accessing app before ready
let electronApp: { setAppUserModelId: (id: string) => void }
let optimizer: { watchWindowShortcuts: (window: BrowserWindow) => void }
let is: { dev: boolean }

import icon from '../../resources/icon.png?asset'
import icon_mac from '../../resources/icon-mac.png?asset'

import { registerFsHandlers } from './ipc/fs-handlers'
import { getRuntimeRegistry } from './ipc/runtime-registry'
import {
  registerLocalMediaSchemePrivileges,
  registerLocalMediaProtocolHandler
} from './local-media-protocol'
import { registerCodeGraphHandlers } from './ipc/codegraph-handlers'
import { registerAgentChangeHandlers } from './ipc/agent-change-handlers'

import { registerShellHandlers } from './ipc/shell-handlers'

import { registerApiProxyHandlers } from './ipc/api-proxy'

import {
  registerSettingsHandlers,
  flushSettingsSync,
  initializeSettingsCache,
  readSettings
} from './ipc/settings-handlers'
import { registerAgentHistoryHandlers } from './ipc/agent-history-handlers'

import { registerSkillsHandlers } from './ipc/skills-handlers'
import { registerSoulsHandlers } from './ipc/souls-handlers'
import { registerAgentsHandlers } from './ipc/agents-handlers'
import { registerPromptsHandlers } from './ipc/prompts-handlers'
import { registerCommandsHandlers } from './ipc/commands-handlers'
import { registerProcessManagerHandlers, killAllManagedProcesses } from './ipc/process-manager'
import { registerDbHandlers } from './ipc/db-handlers'
import { registerGoalRuntimeHandlers } from './ipc/goal-runtime-handlers'
import { registerMemoryAutomationHandlers } from './ipc/memory-automation-handlers'
import { registerConfigHandlers } from './ipc/secure-key-store'
import { registerAiProviderHandlers } from './ipc/ai-provider-handlers'
import { registerExtensionHandlers } from './ipc/extension-handlers'
import { registerChannelHandlers, autoStartChannels } from './ipc/channel-handlers'
import { ChannelManager } from './channels/channel-manager'
import { registerMcpHandlers } from './ipc/mcp-handlers'
import { registerCronHandlers } from './ipc/cron-handlers'
import { registerInputHandlers } from './ipc/input-handlers'
import { registerInputDraftHandlers } from './ipc/input-draft-handlers'
import { registerNotifyHandlers } from './ipc/notify-handlers'
import {
  registerPetHandlers,
  togglePetWindow,
  openPetWindowOnStartupIfEnabled,
  installBuiltinPets
} from './ipc/pet-handlers'
import { registerScreenshotHandlers } from './ipc/screenshot-handlers'
import { registerWebSearchHandlers } from './ipc/web-search-handlers'
import { registerBrowserHandlers } from './ipc/browser-handlers'
import { registerOauthHandlers } from './ipc/oauth-handlers'
import { registerGitHandlers } from './ipc/git-handlers'
import { registerSyncHandlers } from './ipc/sync-handlers'
import { registerHooksHandlers } from './ipc/hooks-handlers'
import { initializeHookRuntimeSettings } from './hooks/hooks-service'
import { registerSidecarHandlers, getSidecarManager } from './ipc/sidecar-manager'
import {
  getNativeWorker,
  latchNativeWorkerShutdown,
  setNativeWorkerStartupBarrier,
  stopCodeGraphWorker,
  stopNativeWorker
} from './lib/native-worker'
import { registerTeamRuntimeHandlers } from './ipc/team-runtime-handlers'
import { loadPersistedJobs, cancelAllJobs } from './cron/cron-scheduler'
import { McpManager } from './mcp/mcp-manager'
import { closeDb } from './db/database'
import { cleanupExpiredUsageEvents } from './db/usage-events-dao'
import {
  writeCrashLog,
  writeCrashLogDeferred,
  getCrashLogDir,
  getNativeCrashDumpsDir,
  startNativeCrashReporter
} from './crash-logger'
import { safeSendMessagePackToWindow } from './window-ipc'
import { registerMessagePackHandler } from './ipc/messagepack-handler'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../shared/messagepack/binary-ipc'
import * as sessionsDao from './db/sessions-dao'
import {
  configureBuiltInBrowserSession,
  flushBuiltInBrowserStorage,
  resolveBrowserSessionStorageMode
} from './browser/browser-emulation'

import { setPluginManager } from './channels/auto-reply'

const channelManager = new ChannelManager()
setPluginManager(channelManager)

const mcpManager = new McpManager()

let mainWindow: BrowserWindow | null = null
let sshWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuiting = false
let killAllTerminalSessions: () => void = () => {}
let closeAllSshSessions: () => void = () => {}
const detachedSessionWindows = new Map<string, BrowserWindow>()
const visibleSessionWindowIds = new Map<string, Set<number>>()

function ensureGlobalMemoryHome(): string {
  const rootPath = join(homedir(), '.open-cowork')
  mkdirSync(join(rootPath, 'memory'), { recursive: true })
  return rootPath
}

const GENERATED_IMAGES_DIR = 'open-cowork'
const GENERATED_IMAGES_SUBDIR = 'image'
const MACOS_SHELL_ENV_TIMEOUT_MS = 4000
const USAGE_EVENTS_STARTUP_CLEANUP_DELAY_MS = 5000
const USAGE_EVENTS_CLEANUP_INTERVAL_MS = 30 * 60 * 1000
const DEFAULT_RENDERER_HEAP_FRACTION = 0.2
const MIN_RENDERER_HEAP_MB = 1024
const MAX_DEFAULT_RENDERER_HEAP_MB = 4096
const MAX_RENDERER_HEAP_FRACTION = 0.75
const SHELL_ENV_LINE_RE = /^[A-Za-z_][A-Za-z0-9_]*=/
const SHELL_ENV_SKIP_KEYS = new Set(['PWD', 'OLDPWD', 'SHLVL', '_'])
const SYSTEM_PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy'
]

function getEnvProxyUrl(): string | null {
  for (const key of SYSTEM_PROXY_ENV_KEYS) {
    const value = process.env[key]?.trim()
    if (value) return value
  }
  return null
}

async function configureSystemProxy(): Promise<void> {
  try {
    const saved = readSettings().systemProxyUrl
    const proxyUrl = typeof saved === 'string' && saved.trim() ? saved.trim() : getEnvProxyUrl()

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
  const dir = join(homedir(), GENERATED_IMAGES_DIR, GENERATED_IMAGES_SUBDIR)
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

async function downloadUrlBuffer(url: string): Promise<Buffer> {
  const response = await net.fetch(url, { redirect: 'follow' })
  if (!response.ok) {
    throw new Error(`Image download failed: HTTP ${response.status}`)
  }
  return Buffer.from(await response.arrayBuffer())
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

type ClipboardWriteImageArgs = { data: string }
type ImagePersistGeneratedArgs = {
  data?: string
  mediaType?: string
  url?: string
  filePath?: string
}
type ImageFetchBase64Args = { url: string }

function registerBinaryInvokeHandler<TArgs>(
  channel: string,
  handler: (args: TArgs) => Promise<unknown> | unknown
): void {
  ipcMain.handle(toMessagePackChannel(channel), async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<TArgs>(bytes)
    return encodeMessagePackPayload(await handler(args))
  })
}

function handleClipboardWriteImage(args: ClipboardWriteImageArgs): {
  success?: boolean
  error?: string
} {
  try {
    const buffer = Buffer.from(args.data, 'base64')
    const image = nativeImage.createFromBuffer(buffer)
    if (image.isEmpty()) return { error: 'Failed to create image from data' }
    clipboard.writeImage(image)
    return { success: true }
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleImagePersistGenerated(
  args: ImagePersistGeneratedArgs
): Promise<{ filePath?: string; mediaType?: string; data?: string; error?: string }> {
  try {
    let buffer: Buffer
    if (typeof args.data === 'string' && args.data.trim()) {
      buffer = Buffer.from(args.data, 'base64')
    } else if (typeof args.url === 'string' && args.url.trim()) {
      buffer = await downloadUrlBuffer(args.url)
    } else if (typeof args.filePath === 'string' && args.filePath.trim()) {
      const allowedRoot = resolve(homedir(), '.open-cowork', 'media', 'images')
      const filePath = resolve(args.filePath)
      const comparisonPath = process.platform === 'win32' ? filePath.toLowerCase() : filePath
      const comparisonRoot =
        process.platform === 'win32' ? `${allowedRoot.toLowerCase()}${sep}` : `${allowedRoot}${sep}`
      if (!comparisonPath.startsWith(comparisonRoot)) {
        return { error: 'Generated image path is outside the native media directory' }
      }
      if (statSync(filePath).size > 32 * 1024 * 1024) {
        return { error: 'Generated image exceeds the 32 MiB persistence limit' }
      }
      buffer = readFileSync(filePath)
      return {
        filePath,
        mediaType: args.mediaType || guessMimeTypeFromExtension(extname(filePath)),
        data: buffer.toString('base64')
      }
    } else {
      return { error: 'Missing image data, url or filePath' }
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

async function handleImageFetchBase64(
  args: ImageFetchBase64Args
): Promise<{ data?: string; mimeType?: string; error?: string }> {
  try {
    const buffer = await downloadUrlBuffer(args.url)
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
}

function recordCrash(event: string, details: unknown): void {
  writeCrashLog(event, details)
}

function recordStartupStep(
  step: string,
  phase: 'start' | 'success' | 'failure',
  details?: unknown
): void {
  writeCrashLogDeferred('main_startup_step', {
    step,
    phase,
    ...(details === undefined ? {} : { details })
  })
}

function runLoggedStartupStep<T>(step: string, task: () => T): T {
  const startedAt = Date.now()
  recordStartupStep(step, 'start')
  try {
    const result = task()
    recordStartupStep(step, 'success', { durationMs: Date.now() - startedAt })
    return result
  } catch (error) {
    recordStartupStep(step, 'failure', { durationMs: Date.now() - startedAt, error })
    throw error
  }
}

async function runLoggedStartupStepAsync<T>(step: string, task: () => Promise<T>): Promise<T> {
  const startedAt = Date.now()
  recordStartupStep(step, 'start')
  try {
    const result = await task()
    recordStartupStep(step, 'success', { durationMs: Date.now() - startedAt })
    return result
  } catch (error) {
    recordStartupStep(step, 'failure', { durationMs: Date.now() - startedAt, error })
    throw error
  }
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
  const browserStorageMode = resolveBrowserSessionStorageMode(app.getPath('userData'))
  const sessionDataPath = browserStorageMode.sessionDataPath
  const diskCachePath = join(sessionDataPath, 'Cache')

  try {
    mkdirSync(sessionDataPath, { recursive: true })
    mkdirSync(diskCachePath, { recursive: true })
    app.setPath('sessionData', sessionDataPath)
    app.commandLine.appendSwitch('disk-cache-dir', diskCachePath)
    if (browserStorageMode.usingDetectedBrowserProfile) {
      console.log(
        `[Browser] Using isolated browser storage while emulating ${browserStorageMode.browserName} profile: ${browserStorageMode.browserProfilePath}`
      )
    } else if (browserStorageMode.reuseEnabled) {
      console.log('[Browser] Browser profile reuse enabled, but no supported profile was found')
    }
  } catch (error) {
    console.error('[Main] Failed to configure Chromium cache paths:', error)
    recordCrash('configure_chromium_cache_failed', { error })
  }
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function resolveRendererHeapLimitMb(systemMemMb: number): number {
  const maxAllowed = Math.max(
    MIN_RENDERER_HEAP_MB,
    Math.floor(systemMemMb * MAX_RENDERER_HEAP_FRACTION)
  )
  const envOverride = parsePositiveInteger(process.env.OPEN_COWORK_RENDERER_HEAP_MB)
  if (envOverride) {
    return Math.min(Math.max(envOverride, MIN_RENDERER_HEAP_MB), maxAllowed)
  }

  const defaultLimit = Math.floor(systemMemMb * DEFAULT_RENDERER_HEAP_FRACTION)
  return Math.min(Math.max(defaultLimit, MIN_RENDERER_HEAP_MB), MAX_DEFAULT_RENDERER_HEAP_MB)
}

/** Keep renderer V8 headroom bounded while allowing explicit overrides for large local runs. */
function configureRendererHeapLimit(): void {
  try {
    const systemMemMb = Math.floor(totalmem() / (1024 * 1024))
    const rendererHeapMb = resolveRendererHeapLimitMb(systemMemMb)
    app.commandLine.appendSwitch('js-flags', `--max-old-space-size=${rendererHeapMb}`)
    if (process.env.OPEN_COWORK_DISABLE_MEMORY_PRESSURE === '1') {
      app.commandLine.appendSwitch('disable-features', 'MemoryPressureBasedSourceBufferGC')
      app.commandLine.appendSwitch('memory-pressure-off')
    }
  } catch (error) {
    console.warn('[Main] Failed to set renderer heap limit:', error)
  }
}

function scheduleUsageEventsStartupCleanup(): void {
  const runCleanup = (): void => {
    if (isQuiting) return

    void cleanupExpiredUsageEvents()
      .then((result) => {
        if (result.deleted <= 0) return

        console.log(
          `[UsageEvents] Aggregated and deleted ${result.deleted} raw analytics log entries older than ${new Date(
            result.cutoff
          ).toISOString()}`
        )
      })
      .catch((error) => {
        console.warn('[UsageEvents] Failed to clean expired analytics logs:', error)
      })
  }

  setTimeout(runCleanup, USAGE_EVENTS_STARTUP_CLEANUP_DELAY_MS)
  const interval = setInterval(runCleanup, USAGE_EVENTS_CLEANUP_INTERVAL_MS)
  interval.unref?.()
}

let deferredIpcHandlersPromise: Promise<void> | null = null

function ensureDeferredIpcHandlers(): Promise<void> {
  deferredIpcHandlersPromise ??= runLoggedStartupStepAsync(
    'register_deferred_ipc_handlers',
    async () => {
      const [terminalModule, sshModule, imageGifModule, migrationModule] = await Promise.all([
        import('./ipc/terminal-handlers'),
        import('./ipc/ssh-handlers'),
        import('./ipc/image-gif-handlers'),
        import('./ipc/migration-handlers')
      ])

      terminalModule.registerTerminalHandlers()
      killAllTerminalSessions = terminalModule.killAllTerminalSessions
      closeAllSshSessions = sshModule.closeAllSshSessions
      imageGifModule.registerImageGifHandlers()
      migrationModule.registerMigrationHandlers()
      const { registerSeedanceVideoHandlers } = await import('./ipc/seedance-video-handlers')
      registerSeedanceVideoHandlers()
      await sshModule.registerSshHandlers()
    }
  )
  return deferredIpcHandlersPromise
}

let channelStartupPromise: Promise<void> | null = null

function startChannelServices(): Promise<void> {
  channelStartupPromise ??= runLoggedStartupStepAsync('channel_services_startup', async () => {
    const { registerBuiltInChannelProviders } = await import('./channels/register-providers')
    registerBuiltInChannelProviders(channelManager)
    await autoStartChannels(channelManager)
  })
  return channelStartupPromise
}

type AutoUpdaterModule = typeof import('./updater')

const autoUpdateOptions = {
  getMainWindow: (): BrowserWindow | null => mainWindow,
  markAppWillQuit: (): void => {
    isQuiting = true
  }
}

let autoUpdaterStartupPromise: Promise<AutoUpdaterModule> | null = null

function startAutoUpdater(): Promise<AutoUpdaterModule> {
  autoUpdaterStartupPromise ??= import('./updater').then((updaterModule) => {
    updaterModule.setupAutoUpdater(autoUpdateOptions)
    return updaterModule
  })

  return autoUpdaterStartupPromise
}

function registerUpdaterHandlers(updaterReady: Promise<AutoUpdaterModule>): void {
  const withUpdater = async <T>(
    operation: (updaterModule: AutoUpdaterModule) => T | Promise<T>
  ): Promise<T | { success: false; error: string }> => {
    try {
      return await operation(await updaterReady)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[Updater] Deferred startup failed:', error)
      return { success: false, error: message }
    }
  }

  // Register the lightweight IPC boundary before renderer navigation. The heavyweight
  // electron-updater module still waits for settings and proxy initialization.
  registerMessagePackHandler<void>('update:check', () =>
    withUpdater((updaterModule) => updaterModule.requestUpdateCheck())
  )
  registerMessagePackHandler<void>('update:download', () =>
    withUpdater((updaterModule) => updaterModule.requestUpdateDownload())
  )
  registerMessagePackHandler<void>('update:status', () =>
    withUpdater((updaterModule) => updaterModule.getUpdateStatus())
  )
  registerMessagePackHandler<void>('update:install', () =>
    withUpdater((updaterModule) => updaterModule.requestUpdateInstall(autoUpdateOptions))
  )
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

async function loadRendererWindow(
  window: BrowserWindow,
  searchParams?: URLSearchParams
): Promise<void> {
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

function normalizeIpcRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function readRuntimePayloadSessionId(payload: unknown): string | null {
  const record = normalizeIpcRecord(payload)
  const directSessionId = readNonEmptyString(record.sessionId)
  if (directSessionId) return directSessionId

  const nestedCandidates = [
    normalizeIpcRecord(record.event),
    normalizeIpcRecord(record.toolCall),
    normalizeIpcRecord(record.task),
    normalizeIpcRecord(record.snapshot),
    normalizeIpcRecord(record.patch)
  ]

  for (const candidate of nestedCandidates) {
    const sessionId = readNonEmptyString(candidate.sessionId)
    if (sessionId) return sessionId
  }

  return null
}

function isUsableSyncWindow(window: BrowserWindow | null | undefined): window is BrowserWindow {
  return (
    !!window &&
    !window.isDestroyed() &&
    !window.webContents.isDestroyed() &&
    !window.webContents.isCrashed()
  )
}

function addRuntimeSyncTarget(
  targets: Map<number, BrowserWindow>,
  window: BrowserWindow | null | undefined
): void {
  if (isUsableSyncWindow(window)) {
    targets.set(window.id, window)
  }
}

function getSessionRuntimeSyncTargets(sessionId: string): BrowserWindow[] {
  const targets = new Map<number, BrowserWindow>()
  const visibleWindowIds = visibleSessionWindowIds.get(sessionId)

  if (visibleWindowIds) {
    for (const windowId of Array.from(visibleWindowIds)) {
      const window = BrowserWindow.fromId(windowId)
      if (isUsableSyncWindow(window)) {
        targets.set(window.id, window)
      } else {
        visibleWindowIds.delete(windowId)
      }
    }
    if (visibleWindowIds.size === 0) {
      visibleSessionWindowIds.delete(sessionId)
    }
  }

  addRuntimeSyncTarget(targets, getAttachedDetachedSessionWindow(sessionId))
  return Array.from(targets.values())
}

function getGlobalRuntimeSyncTargets(): BrowserWindow[] {
  const targets = new Map<number, BrowserWindow>()
  addRuntimeSyncTarget(targets, mainWindow)
  for (const window of detachedSessionWindows.values()) {
    addRuntimeSyncTarget(targets, window)
  }
  return Array.from(targets.values())
}

function forgetVisibleSessionWindow(windowId: number): void {
  for (const [sessionId, windowIds] of visibleSessionWindowIds) {
    windowIds.delete(windowId)
    if (windowIds.size === 0) {
      visibleSessionWindowIds.delete(sessionId)
    }
  }
}

function rememberVisibleSessionWindow(
  event: IpcMainEvent,
  payload: { sessionId?: string; visible?: boolean } | undefined
): void {
  const sessionId = readNonEmptyString(payload?.sessionId)
  if (!sessionId) return
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!isUsableSyncWindow(window)) return

  if (payload?.visible === true) {
    let windowIds = visibleSessionWindowIds.get(sessionId)
    if (!windowIds) {
      windowIds = new Set()
      visibleSessionWindowIds.set(sessionId, windowIds)
    }
    windowIds.add(window.id)
    return
  }

  const windowIds = visibleSessionWindowIds.get(sessionId)
  if (!windowIds) return
  windowIds.delete(window.id)
  if (windowIds.size === 0) {
    visibleSessionWindowIds.delete(sessionId)
  }
}

function routeRuntimeSync(event: IpcMainEvent, channel: string, payload: unknown): void {
  const sessionId = readRuntimePayloadSessionId(payload)
  const targets = sessionId
    ? getSessionRuntimeSyncTargets(sessionId)
    : getGlobalRuntimeSyncTargets()

  for (const window of targets) {
    if (window.webContents.id === event.sender.id) continue
    safeSendMessagePackToWindow(window, channel, payload)
  }
}

// The assistant message id a run streams into is renderer-local (nanoid) and is
// only ever announced on session-runtime:sync. Observe it here so a window that
// (re)mounts mid-run can learn, via agent:runtime-state, which message the
// replayed event tail belongs to.
function observeSessionRuntimeSyncForRegistry(payload: unknown): void {
  const record = normalizeIpcRecord(payload)
  const kind = record.kind
  if (kind === 'set_streaming_message') {
    const sessionId = readNonEmptyString(record.sessionId)
    if (!sessionId) return
    const messageId = typeof record.messageId === 'string' ? record.messageId : null
    getRuntimeRegistry().setStreamingMessageId(sessionId, messageId)
    return
  }
  if (kind === 'add_message') {
    const sessionId = readNonEmptyString(record.sessionId)
    if (!sessionId) return
    const message = normalizeIpcRecord(record.message)
    if (message.role !== 'assistant') return
    const messageId = readNonEmptyString(message.id)
    // Only seed if we don't already have a streaming target — set_streaming_message
    // is authoritative when present.
    if (messageId && !getRuntimeRegistry().getStreamingMessageId(sessionId)) {
      getRuntimeRegistry().setStreamingMessageId(sessionId, messageId)
    }
  }
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

  const session = await sessionsDao.getSession(sessionId)
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
      sandbox: false,
      webviewTag: true
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

function getTrayIcon(): ReturnType<typeof nativeImage.createFromPath> {
  if (process.platform === 'darwin') {
    const image = nativeImage.createFromPath(icon_mac)
    const resized = image.resize({ width: 18, height: 18 })
    resized.setTemplateImage(true)
    return resized
  }

  const image = nativeImage.createFromPath(icon)
  return image
}

function setMacDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) return

  try {
    app.dock.setIcon(nativeImage.createFromPath(icon_mac))
  } catch (error) {
    console.warn('[Main] Failed to set macOS dock icon:', error)
  }
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
    {
      label: 'Show/Hide Pet',

      click: () => {
        void togglePetWindow()
      }
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
  registerMessagePackHandler<void>('window:minimize', (_args, event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender)
    targetWindow?.minimize()
  })

  registerMessagePackHandler<void>('window:maximize', (_args, event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender)
    if (!targetWindow) return
    if (targetWindow.isMaximized()) targetWindow.unmaximize()
    else targetWindow.maximize()
  })

  registerMessagePackHandler<void>('window:close', (_args, event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender)
    targetWindow?.close()
  })

  registerMessagePackHandler<void>('window:isMaximized', (_args, event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender)
    return targetWindow?.isMaximized() ?? false
  })

  registerMessagePackHandler<void>('ssh-window:open', () => {
    showSshWindow()
    return { success: true }
  })

  registerMessagePackHandler<string>('session-window:open', async (sessionId) => {
    return openDetachedSessionWindow(sessionId)
  })

  registerMessagePackHandler<string>('session-window:focus-if-open', (sessionId) => {
    return { handled: focusDetachedSessionWindow(sessionId) }
  })

  ipcMain.on(toMessagePackChannel('agent:session-visibility'), (event, bytes: Uint8Array) => {
    rememberVisibleSessionWindow(
      event,
      decodeMessagePackPayload<{ sessionId?: string; visible?: boolean }>(bytes)
    )
  })

  ipcMain.on(toMessagePackChannel('session-runtime:sync'), (event, bytes: Uint8Array) => {
    const payload = decodeMessagePackPayload(bytes)
    observeSessionRuntimeSyncForRegistry(payload)
    routeRuntimeSync(event, 'session-runtime:sync', payload)
  })

  ipcMain.on(toMessagePackChannel('session-control:sync'), (event, bytes: Uint8Array) => {
    routeRuntimeSync(event, 'session-control:sync', decodeMessagePackPayload(bytes))
  })

  ipcMain.on(toMessagePackChannel('agent-runtime:sync'), (event, bytes: Uint8Array) => {
    routeRuntimeSync(event, 'agent-runtime:sync', decodeMessagePackPayload(bytes))
  })
}

function configureAppWindow(
  window: BrowserWindow,
  options?: { hideOnClose?: boolean; onClosed?: () => void }
): void {
  window.on('maximize', () => {
    safeSendMessagePackToWindow(window, 'window:maximized', true)
  })

  window.on('unmaximize', () => {
    safeSendMessagePackToWindow(window, 'window:maximized', false)
  })

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
    forgetVisibleSessionWindow(window.id)
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
      sandbox: false,
      webviewTag: true
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

  // Zoom support: Ctrl/Cmd + Plus/Minus/0 and trackpad pinch
  const ZOOM_MIN = 0.75
  const ZOOM_MAX = 2.0
  const ZOOM_STEP = 0.1

  function clampZoom(zoom: number): number {
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom))
  }

  window.webContents.on('before-input-event', (_event, input) => {
    if (input.control || input.meta) {
      if (input.key === '=' || input.key === '+') {
        const current = window.webContents.getZoomFactor()
        window.webContents.setZoomFactor(clampZoom(current + ZOOM_STEP))
      } else if (input.key === '-') {
        const current = window.webContents.getZoomFactor()
        window.webContents.setZoomFactor(clampZoom(current - ZOOM_STEP))
      } else if (input.key === '0') {
        window.webContents.setZoomFactor(1.0)
      }
    }
  })

  // Trackpad pinch-to-zoom
  window.webContents.setVisualZoomLevelLimits(1, 5).catch(() => {})
}

async function createSshWindow(): Promise<void> {
  if (sshWindow && !sshWindow.isDestroyed()) {
    showSshWindow()
    return
  }

  await ensureDeferredIpcHandlers()

  sshWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    show: false,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 12, y: 12 } }
      : { frame: false }),
    autoHideMenuBar: true,
    icon: icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webviewTag: true
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
  // Permanently block worker respawns first: a straggler request racing this
  // handler could otherwise re-arm supervision and spawn a leaked process.
  latchNativeWorkerShutdown()
  flushBuiltInBrowserStorage()
  void flushSettingsSync()
  void stopNativeWorker()
  void stopCodeGraphWorker()
})

startNativeCrashReporter()
runLoggedStartupStep('configure_chromium_cache_paths', configureChromiumCachePaths)
runLoggedStartupStep('configure_renderer_heap_limit', configureRendererHeapLimit)
runLoggedStartupStep('register_local_media_scheme', registerLocalMediaSchemePrivileges)

// 防止dev环境和生产环境冲突，导致无法启动
runLoggedStartupStep('set_app_name', () => {
  if (!app.isPackaged) {
    app.setName('OpenCoWork-dev')
  } else {
    app.setName('OpenCoWork')
  }
})

const gotSingleInstanceLock = app.requestSingleInstanceLock()
recordStartupStep('request_single_instance_lock', gotSingleInstanceLock ? 'success' : 'failure')
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
    recordStartupStep('app_when_ready', 'start')
    // Import @electron-toolkit/utils after app is ready
    const utils = await runLoggedStartupStepAsync(
      'import_electron_toolkit_utils',
      () => import('@electron-toolkit/utils')
    )
    electronApp = utils.electronApp
    optimizer = utils.optimizer
    is = utils.is

    const shellEnvironmentReady = runLoggedStartupStepAsync(
      'sync_macos_shell_environment',
      syncMacOSShellEnvironment
    )
    setNativeWorkerStartupBarrier(shellEnvironmentReady)

    const settingsStartup = runLoggedStartupStepAsync(
      'native_worker_settings_startup',
      async () => {
        await getNativeWorker().ensureStarted()
        await initializeSettingsCache()
        initializeHookRuntimeSettings()
      }
    )
    void settingsStartup
      .then(() => console.log('[NativeWorker] settings startup ready'))
      .catch((error) => {
        console.warn(
          `[NativeWorker] settings startup failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      })

    const networkConfigurationReady = settingsStartup
      .catch(() => undefined)
      .then(async () => {
        await runLoggedStartupStepAsync('configure_system_proxy', configureSystemProxy)
        const browserEmulationStatus = runLoggedStartupStep(
          'configure_builtin_browser_session',
          configureBuiltInBrowserSession
        )
        recordCrash('browser_emulation_configured', browserEmulationStatus)
      })
    void networkConfigurationReady.catch((error) => {
      console.warn('[Main] Post-settings startup failed:', error)
    })

    const updaterReady = networkConfigurationReady.then(startAutoUpdater)
    registerUpdaterHandlers(updaterReady)
    void updaterReady.catch((error) => {
      console.warn('[Updater] Startup prerequisite failed:', error)
    })

    recordCrash('app_started', {
      userDataPath: app.getPath('userData'),
      crashLogDir: getCrashLogDir(),
      nativeCrashDumpsDir: getNativeCrashDumpsDir(),
      browserEmulation: 'initializing'
    })
    console.log(`[CrashLogger] Logs will be written to ${getCrashLogDir()}`)
    console.log(`[CrashLogger] Native crash dumps will be written to ${getNativeCrashDumpsDir()}`)

    // Set app identity for Windows integration
    runLoggedStartupStep('set_app_user_model_id', () => {
      electronApp.setAppUserModelId('com.opencowork.app')
    })

    // Default open or close DevTools by F12 in development

    // and ignore CommandOrControl + R in production.

    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
      attachWindowCrashLogging(window)
    })

    registerMessagePackHandler<void>('app:homedir', () => homedir())
    registerMessagePackHandler<void>('app:global-memory-home', () => {
      return ensureGlobalMemoryHome()
    })
    registerMessagePackHandler<void>('app:system-info', () => ({
      machineName: hostname(),
      platform: process.platform,
      arch: process.arch,
      release: release()
    }))
    registerWindowControlHandlers()

    runLoggedStartupStep('register_local_media_protocol', registerLocalMediaProtocolHandler)

    // Register IPC handlers

    registerFsHandlers()
    registerCodeGraphHandlers()
    registerAgentChangeHandlers()

    registerShellHandlers()

    registerApiProxyHandlers()

    registerSettingsHandlers()
    registerAgentHistoryHandlers()

    registerSkillsHandlers()
    registerSoulsHandlers()
    registerAgentsHandlers()
    registerPromptsHandlers()
    registerCommandsHandlers()
    registerProcessManagerHandlers()

    const databaseReady = runLoggedStartupStepAsync('register_db_handlers', () =>
      registerDbHandlers({
        onSessionDeleted: (sessionId) => {
          closeDetachedSessionWindow(sessionId)
        }
      })
    )
    void databaseReady.catch((error) => {
      console.error('[DB] Startup failed:', error)
    })
    registerGoalRuntimeHandlers()
    registerMemoryAutomationHandlers()
    registerConfigHandlers()
    registerAiProviderHandlers()
    registerExtensionHandlers(mcpManager)
    registerChannelHandlers(channelManager)
    registerMcpHandlers(mcpManager)
    registerCronHandlers()
    registerScreenshotHandlers()
    registerInputHandlers()
    registerInputDraftHandlers()
    registerHooksHandlers()

    registerSidecarHandlers()
    registerTeamRuntimeHandlers()
    registerNotifyHandlers()
    registerPetHandlers({ loadRendererWindow, showMainWindow })
    registerWebSearchHandlers()
    registerBrowserHandlers()
    registerOauthHandlers()
    registerGitHandlers()
    registerSyncHandlers()

    // Clipboard/image payloads can be large; renderer callers use MessagePack where possible.
    registerBinaryInvokeHandler<ClipboardWriteImageArgs>(
      'clipboard:write-image',
      handleClipboardWriteImage
    )

    registerMessagePackHandler<{
      x: number
      y: number
      width: number
      height: number
    }>('window:capture-region', async (args, event) => {
      try {
        const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
        if (!win) return { error: 'No active window found' }

        const [contentWidth, contentHeight] = win.getContentSize()
        const x = Math.max(0, Math.min(Math.floor(args.x), Math.max(0, contentWidth - 1)))
        const y = Math.max(0, Math.min(Math.floor(args.y), Math.max(0, contentHeight - 1)))
        const width = Math.max(1, Math.min(Math.ceil(args.width), contentWidth - x))
        const height = Math.max(1, Math.min(Math.ceil(args.height), contentHeight - y))

        if (
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          !Number.isFinite(width) ||
          !Number.isFinite(height)
        ) {
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
    })

    registerBinaryInvokeHandler<ImagePersistGeneratedArgs>(
      'image:persist-generated',
      handleImagePersistGenerated
    )

    registerBinaryInvokeHandler<ImageFetchBase64Args>('image:fetch-base64', handleImageFetchBase64)

    registerMessagePackHandler<{ url: string; defaultName?: string }>(
      'image:download',
      async (args) => {
        const win = BrowserWindow.getFocusedWindow()
        if (!win) return { canceled: true }
        try {
          const buffer = await downloadUrlBuffer(args.url)
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

    setMacDockIcon()
    runLoggedStartupStep('create_main_window', createWindow)
    scheduleUsageEventsStartupCleanup()

    createTray()

    // Optional runtimes start after navigation begins. Their IPC boundaries are either
    // already registered or installed in the background well before a user can invoke them.
    void ensureDeferredIpcHandlers().catch((error) => {
      console.warn('[Main] Deferred IPC startup failed:', error)
    })
    void networkConfigurationReady
      .then(() => startChannelServices())
      .catch((error) => {
        console.warn('[Channels] Startup failed:', error)
      })
    void runLoggedStartupStepAsync('sidecar_global_startup', () =>
      getSidecarManager().ensureStarted()
    )
      .then((sidecarReady) => {
        console.log(`[Sidecar] global startup ${sidecarReady ? 'ready' : 'unavailable'}`)
      })
      .catch((error) => {
        console.warn(
          `[Sidecar] global startup failed: ${error instanceof Error ? error.message : String(error)}`
        )
      })
    void databaseReady
      .then(() => runLoggedStartupStepAsync('load_persisted_jobs', loadPersistedJobs))
      .catch((error) => {
        console.warn('[Cron] Failed to restore persisted jobs:', error)
      })

    void installBuiltinPets().then(() => openPetWindowOnStartupIfEnabled())
    recordStartupStep('app_when_ready', 'success')

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
  void stopNativeWorker()
  void stopCodeGraphWorker()
  getSidecarManager()
    .stop()
    .catch(() => {})
  closeDb()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process

// code. You can also put them in separate files and require them here.
