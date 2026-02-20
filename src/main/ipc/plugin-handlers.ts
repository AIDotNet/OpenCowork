import { ipcMain, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { FeishuApi } from '../plugins/providers/feishu/feishu-api'
import { nanoid } from 'nanoid'
import { PluginManager } from '../plugins/plugin-manager'
import { PLUGIN_PROVIDERS } from '../plugins/plugin-descriptors'
import { getDb } from '../db/database'
import { handlePluginAutoReply } from '../plugins/auto-reply'
import type { PluginInstance, PluginEvent } from '../plugins/plugin-types'

const DATA_DIR = path.join(os.homedir(), '.open-cowork')
const PLUGINS_FILE = path.join(DATA_DIR, 'plugins.json')

// ── Persistence helpers ──

function readPlugins(): PluginInstance[] {
  try {
    if (fs.existsSync(PLUGINS_FILE)) {
      return JSON.parse(fs.readFileSync(PLUGINS_FILE, 'utf-8'))
    }
  } catch {
    // Return empty on any error
  }
  return []
}

function writePlugins(plugins: PluginInstance[]): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true })
    }
    fs.writeFileSync(PLUGINS_FILE, JSON.stringify(plugins, null, 2), 'utf-8')
  } catch (err) {
    console.error('[Plugins] Write error:', err)
  }
}

// ── Notify renderer of plugin events ──

function notifyRenderer(event: PluginEvent): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send('plugin:incoming-message', event)
  }

  // Route incoming messages through auto-reply pipeline
  if (event.type === 'incoming_message') {
    handlePluginAutoReply(event)
  }
}

// ── Register IPC handlers ──

/**
 * Auto-start plugins that have features.autoStart = true and are enabled.
 * Called once at app startup after handlers are registered.
 */
export async function autoStartPlugins(pluginManager: PluginManager): Promise<void> {
  const plugins = readPlugins()
  const toStart = plugins.filter(
    (p) => p.enabled && (p.features?.autoStart ?? true) // default true for backward compat
  )
  for (const instance of toStart) {
    try {
      await pluginManager.startPlugin(instance, notifyRenderer)
      console.log(`[Plugins] Auto-started: ${instance.name} (${instance.type})`)
    } catch (err) {
      console.error(`[Plugins] Auto-start failed for ${instance.name}:`, err)
    }
  }
}

let _handlersRegistered = false

export function registerPluginHandlers(pluginManager: PluginManager): void {
  if (_handlersRegistered) return
  _handlersRegistered = true

  // List available provider descriptors
  ipcMain.handle('plugin:list-providers', () => {
    return PLUGIN_PROVIDERS
  })

  // List persisted plugin instances (auto-provisions built-in plugins)
  ipcMain.handle('plugin:list', () => {
    const plugins = readPlugins()
    let changed = false

    // Auto-provision built-in plugins that don't exist yet
    for (const descriptor of PLUGIN_PROVIDERS) {
      const existing = plugins.find((p) => p.type === descriptor.type)
      if (!existing) {
        const config: Record<string, string> = {}
        for (const field of descriptor.configSchema) {
          config[field.key] = ''
        }
        plugins.push({
          id: nanoid(),
          type: descriptor.type,
          name: descriptor.displayName,
          enabled: false,
          builtin: true,
          userSystemPrompt: '',
          config,
          createdAt: Date.now(),
        })
        changed = true
      } else if (!existing.builtin) {
        // Mark existing plugin as builtin if it matches a built-in type
        existing.builtin = true
        changed = true
      }
    }

    // Ensure old plugin instances have config keys matching their current schema
    for (const p of plugins) {
      const desc = PLUGIN_PROVIDERS.find((d) => d.type === p.type)
      if (!desc) continue
      const schemaKeys = new Set(desc.configSchema.map((f) => f.key))
      for (const field of desc.configSchema) {
        if (!(field.key in p.config)) {
          p.config[field.key] = ''
          changed = true
        }
      }
      // Remove config keys that are no longer in the schema
      for (const key of Object.keys(p.config)) {
        if (!schemaKeys.has(key)) {
          delete p.config[key]
          changed = true
        }
      }
    }

    if (changed) writePlugins(plugins)
    console.log(`[Plugins] Loaded ${plugins.length} plugins (${plugins.filter((p) => p.builtin).length} built-in)`)
    return plugins
  })

  // Add a new plugin instance
  ipcMain.handle('plugin:add', (_event, instance: PluginInstance) => {
    const plugins = readPlugins()
    plugins.push(instance)
    writePlugins(plugins)
    return { success: true }
  })

  // Update a plugin instance
  ipcMain.handle(
    'plugin:update',
    (_event, { id, patch }: { id: string; patch: Partial<PluginInstance> }) => {
      const plugins = readPlugins()
      const idx = plugins.findIndex((p) => p.id === id)
      if (idx === -1) return { success: false, error: 'Plugin not found' }
      plugins[idx] = { ...plugins[idx], ...patch }
      writePlugins(plugins)
      return { success: true }
    }
  )

  // Remove a plugin instance (also cascade-deletes plugin sessions)
  // Built-in plugins cannot be removed.
  ipcMain.handle('plugin:remove', async (_event, id: string) => {
    const allPlugins = readPlugins()
    const target = allPlugins.find((p) => p.id === id)
    if (target?.builtin) {
      return { success: false, error: 'Built-in plugins cannot be removed' }
    }
    // Stop service if running
    await pluginManager.stopPlugin(id)
    const plugins = allPlugins.filter((p) => p.id !== id)
    writePlugins(plugins)
    // Cascade-delete plugin sessions and their messages
    try {
      const db = getDb()
      const sessionIds = db
        .prepare('SELECT id FROM sessions WHERE plugin_id = ?')
        .all(id) as { id: string }[]
      if (sessionIds.length > 0) {
        const ids = sessionIds.map((s) => s.id)
        for (const sid of ids) {
          db.prepare('DELETE FROM messages WHERE session_id = ?').run(sid)
        }
        db.prepare('DELETE FROM sessions WHERE plugin_id = ?').run(id)
      }
    } catch (err) {
      console.error('[Plugins] Failed to cascade-delete sessions:', err)
    }
    return { success: true }
  })

  // Start a plugin service
  ipcMain.handle('plugin:start', async (_event, id: string) => {
    const plugins = readPlugins()
    const instance = plugins.find((p) => p.id === id)
    if (!instance) return { success: false, error: 'Plugin not found' }

    try {
      await pluginManager.startPlugin(instance, notifyRenderer)
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  })

  // Stop a plugin service
  ipcMain.handle('plugin:stop', async (_event, id: string) => {
    await pluginManager.stopPlugin(id)
    return { success: true }
  })

  // Get plugin status
  ipcMain.handle('plugin:status', (_event, id: string) => {
    return pluginManager.getStatus(id)
  })

  // Unified action dispatch — routes to the correct MessagingPluginService method
  ipcMain.handle(
    'plugin:exec',
    async (
      _event,
      { pluginId, action, params }: { pluginId: string; action: string; params: Record<string, unknown> }
    ) => {
      const service = pluginManager.getService(pluginId)
      if (!service) {
        throw new Error(`Plugin ${pluginId} is not running`)
      }

      // Dispatch to the unified MessagingPluginService method with named params
      switch (action) {
        case 'sendMessage':
          return await service.sendMessage(
            params.chatId as string,
            params.content as string
          )
        case 'replyMessage':
          return await service.replyMessage(
            params.messageId as string,
            params.content as string
          )
        case 'getGroupMessages':
          return await service.getGroupMessages(
            params.chatId as string,
            (params.count as number) ?? 20
          )
        case 'listGroups':
          return await service.listGroups()
        default:
          throw new Error(`Unknown action: ${action}`)
      }
    }
  )

  // List plugin sessions (filtered by plugin_id)
  ipcMain.handle('plugin:sessions:list', (_event, pluginId: string) => {
    const db = getDb()
    return db
      .prepare('SELECT * FROM sessions WHERE plugin_id = ? ORDER BY updated_at DESC')
      .all(pluginId)
  })

  // Create a plugin session
  ipcMain.handle(
    'plugin:sessions:create',
    (
      _event,
      args: {
        id: string
        pluginId: string
        title: string
        mode: string
        createdAt: number
        updatedAt: number
        externalChatId?: string
      }
    ) => {
      const db = getDb()
      db.prepare(
        `INSERT INTO sessions (id, title, icon, mode, created_at, updated_at, working_folder, pinned, plugin_id, external_chat_id)
         VALUES (?, ?, NULL, ?, ?, ?, NULL, 0, ?, ?)`
      ).run(args.id, args.title, args.mode, args.createdAt, args.updatedAt, args.pluginId, args.externalChatId ?? null)
      return { success: true }
    }
  )

  // Find a plugin session by external chat ID
  ipcMain.handle('plugin:sessions:find-by-chat', (_event, externalChatId: string) => {
    const db = getDb()
    return db
      .prepare('SELECT * FROM sessions WHERE external_chat_id = ? LIMIT 1')
      .get(externalChatId) ?? null
  })

  // ── Streaming output IPC ──

  // Active streaming handles keyed by `${pluginId}:${chatId}`
  const streamHandles = new Map<string, import('../plugins/plugin-types').StreamingHandle>()

  /**
   * Start a streaming message for a plugin chat.
   * Returns { ok: true, supportsStreaming: true } if streaming was initiated,
   * or { ok: false } if the plugin doesn't support streaming (caller should fallback).
   */
  ipcMain.handle(
    'plugin:stream:start',
    async (
      _event,
      args: { pluginId: string; chatId: string; initialContent: string; messageId?: string }
    ) => {
      const service = pluginManager.getService(args.pluginId)
      if (!service || !service.supportsStreaming || !service.sendStreamingMessage) {
        return { ok: false, supportsStreaming: false }
      }

      try {
        const handle = await service.sendStreamingMessage(args.chatId, args.initialContent, args.messageId)
        const key = `${args.pluginId}:${args.chatId}`
        streamHandles.set(key, handle)
        console.log(`[PluginStream] Started streaming for ${key}`)
        return { ok: true, supportsStreaming: true }
      } catch (err) {
        console.error('[PluginStream] Failed to start streaming:', err)
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // ── Plugin Session Management ──

  /** List all plugin sessions (sessions with plugin_id set) */
  ipcMain.handle('plugin:sessions:list-all', async () => {
    const db = getDb()
    const rows = db.prepare(
      `SELECT s.id, s.title, s.plugin_id, s.external_chat_id, s.created_at, s.updated_at,
              (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) as message_count
       FROM sessions s WHERE s.plugin_id IS NOT NULL AND s.plugin_id != ''
       ORDER BY s.updated_at DESC`
    ).all()
    return rows
  })

  /** Get messages for a plugin session */
  ipcMain.handle('plugin:sessions:messages', async (_event, args: { sessionId: string; limit?: number; offset?: number }) => {
    const db = getDb()
    const limit = args.limit ?? 50
    const offset = args.offset ?? 0
    const rows = db.prepare(
      `SELECT id, role, content, created_at FROM messages
       WHERE session_id = ? ORDER BY sort_order ASC LIMIT ? OFFSET ?`
    ).all(args.sessionId, limit, offset)
    return rows
  })

  /** Clear all messages in a plugin session */
  ipcMain.handle('plugin:sessions:clear', async (_event, args: { sessionId: string }) => {
    const db = getDb()
    const result = db.prepare('DELETE FROM messages WHERE session_id = ?').run(args.sessionId)
    return { deleted: result.changes }
  })

  /** Delete a plugin session and its messages */
  ipcMain.handle('plugin:sessions:delete', async (_event, args: { sessionId: string }) => {
    const db = getDb()
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(args.sessionId)
    db.prepare('DELETE FROM sessions WHERE id = ?').run(args.sessionId)
    // Notify renderer to remove from store
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      win.webContents.send('plugin:session-deleted', { sessionId: args.sessionId })
    }
    return { ok: true }
  })

  /** Rename a plugin session */
  ipcMain.handle('plugin:sessions:rename', async (_event, args: { sessionId: string; title: string }) => {
    const db = getDb()
    db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(args.title, args.sessionId)
    return { ok: true }
  })

  // ── Feishu media send ──

  /**
   * Send an image to a Feishu chat.
   * `source` can be:
   *   - An absolute local file path  (e.g. /home/user/pic.png or C:\...\pic.png)
   *   - An HTTP/HTTPS URL            (e.g. https://example.com/image.png)
   */
  ipcMain.handle(
    'plugin:feishu:send-image',
    async (_event, args: { pluginId: string; chatId: string; filePath: string }) => {
      const service = pluginManager.getService(args.pluginId) as import('../plugins/providers/feishu/feishu-service').FeishuService | undefined
      if (!service?.api) return { error: 'Feishu plugin not running or not found' }

      try {
        let buf: Buffer
        const src = args.filePath.trim()
        console.log(`[Feishu] send-image: src=${src}, chatId=${args.chatId}`)
        if (/^https?:\/\//i.test(src)) {
          console.log(`[Feishu] Downloading image from URL...`)
          buf = await FeishuApi.downloadUrl(src)
        } else {
          if (!fs.existsSync(src)) {
            const msg = `File not found: ${src}`
            console.error(`[Feishu] send-image failed: ${msg}`)
            return { error: msg }
          }
          buf = fs.readFileSync(src)
        }
        console.log(`[Feishu] Uploading image (${buf.byteLength} bytes)...`)
        const fileName = path.basename(src.split('?')[0]) || 'image.png'
        const imageKey = await service.api.uploadImage(buf, fileName)
        console.log(`[Feishu] Uploaded image_key=${imageKey}, sending to chat...`)
        const result = await service.api.sendImageMessage(args.chatId, imageKey)
        console.log(`[Feishu] Sent image to ${args.chatId}: messageId=${result.messageId}`)
        return { ok: true, messageId: result.messageId }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[Feishu] send-image failed:', msg)
        return { error: msg }
      }
    }
  )

  /**
   * Send a file to a Feishu chat.
   * `source` can be:
   *   - An absolute local file path  (e.g. /home/user/doc.pdf)
   *   - An HTTP/HTTPS URL            (e.g. https://example.com/report.pdf)
   * `fileType` is auto-detected from extension if not provided.
   */
  ipcMain.handle(
    'plugin:feishu:send-file',
    async (_event, args: { pluginId: string; chatId: string; filePath: string; fileType?: string }) => {
      const service = pluginManager.getService(args.pluginId) as import('../plugins/providers/feishu/feishu-service').FeishuService | undefined
      if (!service?.api) return { error: 'Feishu plugin not running or not found' }

      try {
        let buf: Buffer
        const src = args.filePath.trim()
        console.log(`[Feishu] send-file: src=${src}, chatId=${args.chatId}`)
        if (/^https?:\/\//i.test(src)) {
          console.log(`[Feishu] Downloading file from URL...`)
          buf = await FeishuApi.downloadUrl(src)
        } else {
          if (!fs.existsSync(src)) {
            const msg = `File not found: ${src}`
            console.error(`[Feishu] send-file failed: ${msg}`)
            return { error: msg }
          }
          buf = fs.readFileSync(src)
        }
        const fileName = path.basename(src.split('?')[0]) || 'file'

        // Auto-detect file type from extension
        const ext = path.extname(fileName).toLowerCase().replace('.', '')
        const typeMap: Record<string, 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'> = {
          opus: 'opus', mp4: 'mp4', pdf: 'pdf',
          doc: 'doc', docx: 'doc',
          xls: 'xls', xlsx: 'xls',
          ppt: 'ppt', pptx: 'ppt',
        }
        const fileType = (args.fileType as 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' | undefined)
          ?? typeMap[ext]
          ?? 'stream'

        console.log(`[Feishu] Uploading file "${fileName}" (${buf.byteLength} bytes, type=${fileType})...`)
        const fileKey = await service.api.uploadFile(buf, fileName, fileType)
        console.log(`[Feishu] Uploaded file_key=${fileKey}, sending to chat...`)
        const result = await service.api.sendFileMessage(args.chatId, fileKey)
        console.log(`[Feishu] Sent file "${fileName}" to ${args.chatId}: messageId=${result.messageId}`)
        return { ok: true, messageId: result.messageId }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[Feishu] send-file failed:', msg)
        return { error: msg }
      }
    }
  )

  // ── Streaming ──

  /** Send a streaming content update (accumulated text, not delta) */
  ipcMain.handle(
    'plugin:stream:update',
    async (_event, args: { pluginId: string; chatId: string; content: string }) => {
      const key = `${args.pluginId}:${args.chatId}`
      const handle = streamHandles.get(key)
      if (!handle) return { ok: false }

      try {
        await handle.update(args.content)
        return { ok: true }
      } catch (err) {
        console.warn(`[PluginStream] Update failed for ${key}:`, err)
        return { ok: false }
      }
    }
  )

  /** Finish the streaming message with final content */
  ipcMain.handle(
    'plugin:stream:finish',
    async (_event, args: { pluginId: string; chatId: string; content: string }) => {
      const key = `${args.pluginId}:${args.chatId}`
      const handle = streamHandles.get(key)
      if (!handle) return { ok: false }

      try {
        await handle.finish(args.content)
        streamHandles.delete(key)
        console.log(`[PluginStream] Finished streaming for ${key}`)
        return { ok: true }
      } catch (err) {
        console.error(`[PluginStream] Finish failed for ${key}:`, err)
        streamHandles.delete(key)
        return { ok: false }
      }
    }
  )
}
