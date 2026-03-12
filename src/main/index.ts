import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  clipboard,
  nativeImage,
  dialog
} from 'electron'

import { join, extname } from 'path'
import { mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'

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
import { registerProcessManagerHandlers, killAllManagedProcesses } from './ipc/process-manager'
import { registerDbHandlers } from './ipc/db-handlers'
import { registerConfigHandlers } from './ipc/secure-key-store'
import { registerChannelHandlers, autoStartChannels } from './ipc/channel-handlers'
import { ChannelManager } from './channels/channel-manager'
import { registerMcpHandlers } from './ipc/mcp-handlers'
import { registerCronHandlers } from './ipc/cron-handlers'
import { registerInputHandlers } from './ipc/input-handlers'
import { registerNotifyHandlers } from './ipc/notify-handlers'
import { registerScreenshotHandlers } from './ipc/screenshot-handlers'
import { registerWebSearchHandlers } from './ipc/web-search-handlers'
import { registerOauthHandlers } from './ipc/oauth-handlers'
import { loadPersistedJobs, cancelAllJobs } from './cron/cron-scheduler'
import { McpManager } from './mcp/mcp-manager'
import { closeDb } from './db/database'
import { registerSshHandlers, closeAllSshSessions } from './ipc/ssh-handlers'
import { writeCrashLog, getCrashLogDir } from './crash-logger'
import { setupAutoUpdater } from './updater'

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

const mcpManager = new McpManager()

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuiting = false

function recordCrash(event: string, details: unknown): void {
  writeCrashLog(event, details)
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

  tray.setToolTip('OpenCowork')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show App',

      click: () => showMainWindow()
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

function createWindow(): void {
  // Create the browser window.

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

  // Window control IPC handlers

  ipcMain.handle('window:minimize', () => window.minimize())

  ipcMain.handle('window:maximize', () => {
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })

  ipcMain.handle('window:close', () => window.close())

  ipcMain.handle('window:isMaximized', () => window.isMaximized())

  // Forward maximize state changes to renderer

  window.on('maximize', () => window.webContents.send('window:maximized', true))

  window.on('unmaximize', () => window.webContents.send('window:maximized', false))

  window.on('ready-to-show', () => {
    window.show()
  })

  window.on('close', (event) => {
    if (!isQuiting) {
      event.preventDefault()

      window.hide()
    }
  })

  window.on('closed', () => {
    mainWindow = null
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

  window.webContents.on('render-process-gone', (_event, details) => {
    const crashInfo = {
      windowId: window.id,
      webContentsId: window.webContents.id,
      url: window.webContents.getURL(),
      details
    }
    console.error('[Main] Window render process gone:', crashInfo)
    recordCrash('window_render_process_gone', crashInfo)
  })

  window.webContents.on('unresponsive', () => {
    const hangInfo = {
      windowId: window.id,
      webContentsId: window.webContents.id,
      url: window.webContents.getURL()
    }
    console.error('[Main] Renderer became unresponsive:', hangInfo)
    recordCrash('window_renderer_unresponsive', hangInfo)
  })

  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      const failInfo = {
        windowId: window.id,
        webContentsId: window.webContents.id,
        url: window.webContents.getURL(),
        validatedURL,
        errorCode,
        errorDescription
      }
      console.error('[Main] Renderer failed to load:', failInfo)
      recordCrash('window_did_fail_load', failInfo)
    }
  )

  // HMR for renderer base on electron-vite cli.

  // Load the remote URL for development or the local html file for production.

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }
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

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

if (gotSingleInstanceLock) {
  app.on('second-instance', () => {
    showMainWindow()
  })

  app.whenReady().then(() => {
    // Import @electron-toolkit/utils after app is ready
    const utils = require('@electron-toolkit/utils')
    electronApp = utils.electronApp
    optimizer = utils.optimizer
    is = utils.is

    recordCrash('app_started', {
      userDataPath: app.getPath('userData'),
      crashLogDir: getCrashLogDir()
    })
    console.log(`[CrashLogger] Logs will be written to ${getCrashLogDir()}`)

    // Set app identity for Windows integration
    app.setName('OpenCoWork')
    electronApp.setAppUserModelId('com.opencowork.app')

    // Default open or close DevTools by F12 in development

    // and ignore CommandOrControl + R in production.

    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    // IPC test

    ipcMain.on('ping', () => console.log('pong'))

    ipcMain.handle('app:homedir', () => homedir())

    // Register IPC handlers

    registerFsHandlers()
    registerAgentChangeHandlers()

    registerShellHandlers()

    registerApiProxyHandlers()

    registerSettingsHandlers()

    registerSkillsHandlers()
    registerAgentsHandlers()
    registerPromptsHandlers()
    registerProcessManagerHandlers()
    registerDbHandlers()
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
  closeAllSshSessions()
  cancelAllJobs()
  closeDb()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process

// code. You can also put them in separate files and require them here.
