import { app, shell, BrowserWindow, ipcMain, Menu, Tray, clipboard, nativeImage } from 'electron'

import { join } from 'path'
import { mkdirSync } from 'fs'
import { homedir } from 'os'

import { electronApp, optimizer, is } from '@electron-toolkit/utils'

import icon from '../../resources/icon.png?asset'

import { registerFsHandlers } from './ipc/fs-handlers'

import { registerShellHandlers } from './ipc/shell-handlers'

import { registerApiProxyHandlers } from './ipc/api-proxy'

import { registerSettingsHandlers } from './ipc/settings-handlers'

import { registerSkillsHandlers } from './ipc/skills-handlers'
import { registerAgentsHandlers } from './ipc/agents-handlers'
import { registerProcessManagerHandlers, killAllManagedProcesses } from './ipc/process-manager'
import { registerDbHandlers } from './ipc/db-handlers'
import { registerConfigHandlers } from './ipc/secure-key-store'
import { registerPluginHandlers, autoStartPlugins } from './ipc/plugin-handlers'
import { PluginManager } from './plugins/plugin-manager'
import { registerMcpHandlers } from './ipc/mcp-handlers'
import { registerCronHandlers } from './ipc/cron-handlers'
import { registerNotifyHandlers } from './ipc/notify-handlers'
import { loadPersistedJobs, cancelAllJobs } from './cron/cron-scheduler'
import { McpManager } from './mcp/mcp-manager'
import { closeDb } from './db/database'
import { writeCrashLog, getCrashLogDir } from './crash-logger'
import { setupAutoUpdater } from './updater'

import { createFeishuService } from './plugins/providers/feishu/feishu-service'
import { createDingTalkService } from './plugins/providers/dingtalk/dingtalk-service'
import { parseDingTalkWsMessage } from './plugins/providers/dingtalk/parse-ws-message'
import { createTelegramService } from './plugins/providers/telegram/telegram-service'
import { parseTelegramWsMessage } from './plugins/providers/telegram/parse-ws-message'
import { createDiscordService } from './plugins/providers/discord/discord-service'
import { parseDiscordWsMessage } from './plugins/providers/discord/parse-ws-message'
import { createWhatsAppService } from './plugins/providers/whatsapp/whatsapp-service'
import { parseWhatsAppWsMessage } from './plugins/providers/whatsapp/parse-ws-message'
import { createWeComService } from './plugins/providers/wecom/wecom-service'
import { parseWeComWsMessage } from './plugins/providers/wecom/parse-ws-message'
import { setPluginManager } from './plugins/auto-reply'

const pluginManager = new PluginManager()
setPluginManager(pluginManager)
pluginManager.registerFactory('feishu-bot', createFeishuService)
// Feishu uses official SDK WSClient — no generic parser needed
pluginManager.registerFactory('dingtalk-bot', createDingTalkService)
pluginManager.registerParser('dingtalk-bot', parseDingTalkWsMessage)
pluginManager.registerFactory('telegram-bot', createTelegramService)
pluginManager.registerParser('telegram-bot', parseTelegramWsMessage)
pluginManager.registerFactory('discord-bot', createDiscordService)
pluginManager.registerParser('discord-bot', parseDiscordWsMessage)
pluginManager.registerFactory('whatsapp-bot', createWhatsAppService)
pluginManager.registerParser('whatsapp-bot', parseWhatsAppWsMessage)
pluginManager.registerFactory('wecom-bot', createWeComService)
pluginManager.registerParser('wecom-bot', parseWeComWsMessage)

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

function createTray(): void {

  if (tray) return

  tray = new Tray(icon)

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

    icon:icon,

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

    shell.openExternal(details.url)

    return { action: 'deny' }

  })

  window.webContents.on('render-process-gone', (_event, details) => {
    const crashInfo = {
      windowId: window.id,
      webContentsId: window.webContents.id,
      url: window.webContents.getURL(),
      details,
    }
    console.error('[Main] Window render process gone:', crashInfo)
    recordCrash('window_render_process_gone', crashInfo)
  })

  window.webContents.on('unresponsive', () => {
    const hangInfo = {
      windowId: window.id,
      webContentsId: window.webContents.id,
      url: window.webContents.getURL(),
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
        errorDescription,
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

  recordCrash('app_started', {
    userDataPath: app.getPath('userData'),
    crashLogDir: getCrashLogDir(),
  })
  console.log(`[CrashLogger] Logs will be written to ${getCrashLogDir()}`)

  // Set app user model id for windows

  electronApp.setAppUserModelId('com.electron')



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

  registerShellHandlers()

  registerApiProxyHandlers()

  registerSettingsHandlers()

  registerSkillsHandlers()
  registerAgentsHandlers()
  registerProcessManagerHandlers()
  registerDbHandlers()
  registerConfigHandlers()
  registerPluginHandlers(pluginManager)
  registerMcpHandlers(mcpManager)
  registerCronHandlers()
  loadPersistedJobs()
  registerNotifyHandlers()

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

  // Auto-start plugins with autoStart feature enabled
  void autoStartPlugins(pluginManager)



  createWindow()



  createTray()

  setupAutoUpdater({
    getMainWindow: () => mainWindow,
    markAppWillQuit: () => {
      isQuiting = true
    },
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
  pluginManager.stopAll()
  mcpManager.disconnectAll()
  killAllManagedProcesses()
  cancelAllJobs()
  closeDb()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})



// In this file you can include the rest of your app's specific main process

// code. You can also put them in separate files and require them here.

