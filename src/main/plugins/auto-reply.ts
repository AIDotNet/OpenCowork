import { BrowserWindow } from 'electron'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import { nanoid } from 'nanoid'
import { getDb } from '../db/database'
import type { PluginEvent, PluginInstance, PluginIncomingMessageData } from './plugin-types'
import type { PluginManager } from './plugin-manager'
import { tryHandleCommand } from './plugin-commands'

const PLUGINS_WORK_DIR = path.join(os.homedir(), '.open-cowork', 'plugins')
const PLUGINS_FILE = path.join(os.homedir(), '.open-cowork', 'plugins.json')

let _pluginManager: PluginManager | null = null

/** Must be called once at startup to wire the plugin manager */
export function setPluginManager(pm: PluginManager): void {
  _pluginManager = pm
}

/**
 * Auto-reply pipeline: routes incoming plugin messages to per-user/per-group sessions
 * and notifies the renderer to trigger the Agent Loop for auto-reply.
 */
export function handlePluginAutoReply(event: PluginEvent): void {
  if (event.type !== 'incoming_message') return

  const data = event.data as PluginIncomingMessageData
  if (!data || !data.chatId || (!data.content && !data.images?.length)) return

  const pluginId = event.pluginId
  const compositeKey = `plugin:${pluginId}:chat:${data.chatId}`

  try {
    const db = getDb()

    // Find existing session by external_chat_id
    let session = db
      .prepare('SELECT id, title FROM sessions WHERE external_chat_id = ? LIMIT 1')
      .get(compositeKey) as { id: string; title: string } | undefined

    const now = Date.now()

    // Create new session if not found
    const pluginWorkDir = path.join(PLUGINS_WORK_DIR, pluginId)
    // Look up plugin instance to get bound provider/model
    let pluginInstance: PluginInstance | undefined
    try {
      if (fs.existsSync(PLUGINS_FILE)) {
        const plugins = JSON.parse(fs.readFileSync(PLUGINS_FILE, 'utf-8')) as PluginInstance[]
        pluginInstance = plugins.find((p) => p.id === pluginId)
      }
    } catch { /* ignore read errors */ }
    const sessionProviderId = pluginInstance?.providerId ?? null
    const sessionModelId = pluginInstance?.model ?? null

    if (!session) {
      const sessionId = nanoid()
      const title = data.chatName || data.senderName || data.chatId
      // Ensure plugin working directory exists
      if (!fs.existsSync(pluginWorkDir)) {
        fs.mkdirSync(pluginWorkDir, { recursive: true })
      }
      db.prepare(
        `INSERT INTO sessions (id, title, icon, mode, created_at, updated_at, working_folder, pinned, plugin_id, external_chat_id, provider_id, model_id)
         VALUES (?, ?, NULL, 'cowork', ?, ?, ?, 0, ?, ?, ?, ?)`
      ).run(sessionId, title, now, now, pluginWorkDir, pluginId, compositeKey, sessionProviderId, sessionModelId)
      session = { id: sessionId, title }
    } else {
      // Update session timestamp
      db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, session.id)

      // Sync provider/model binding from plugin config (user may have changed it)
      if (sessionProviderId || sessionModelId) {
        db.prepare('UPDATE sessions SET provider_id = ?, model_id = ? WHERE id = ?')
          .run(sessionProviderId, sessionModelId, session.id)
      }

      // Update title if we now have a better name (e.g. chatName resolved after initial creation)
      const betterTitle = data.chatName || data.senderName
      if (betterTitle && session.title !== betterTitle && /^oc_/.test(session.title)) {
        db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(betterTitle, session.id)
        session.title = betterTitle
      }
    }

    // ── Command interception: handle /help, /new, /init, /status etc. before agent loop ──
    // Always attempt command parsing — tryHandleCommand handles @mention stripping internally
    if (_pluginManager && data.content?.trim()) {
      const commandResult = tryHandleCommand({
        pluginId,
        pluginType: event.pluginType,
        chatId: data.chatId,
        data,
        sessionId: session.id,
        pluginWorkDir,
        pluginManager: _pluginManager,
      })
      // true = fully handled, skip agent loop
      if (commandResult === true) return
      // string = command rewrote the message, pass to agent loop with new content
      if (typeof commandResult === 'string') {
        data.content = commandResult
      }
      // false = not a command, proceed with original content
    }

    // NOTE: We do NOT insert the user message here — the renderer's sendMessage
    // will handle it (via triggerSendMessage) to avoid duplicate messages and
    // ensure proper multi-modal content handling.

    // Check if the plugin service supports streaming
    const service = _pluginManager?.getService(pluginId)
    const supportsStreaming = !!(service?.supportsStreaming && service?.sendStreamingMessage)

    // Notify renderer to trigger Agent Loop auto-reply
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      win.webContents.send('plugin:session-task', {
        sessionId: session.id,
        pluginId,
        pluginType: event.pluginType,
        chatId: data.chatId,
        senderId: data.senderId,
        senderName: data.senderName,
        chatName: data.chatName,
        sessionTitle: session.title,
        content: data.content || '[User sent an image]',
        messageId: data.messageId,
        supportsStreaming,
        images: data.images,
        workingFolder: pluginWorkDir,
      })
    }

    console.log(
      `[AutoReply] Routed message from ${data.senderName || data.senderId} ` +
      `in chat ${data.chatId} to session ${session.id}`
    )
  } catch (err) {
    console.error('[AutoReply] Failed to route incoming message:', err)
  }
}
