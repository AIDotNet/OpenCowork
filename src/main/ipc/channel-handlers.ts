import { ipcMain, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { FeishuApi } from '../channels/providers/feishu/feishu-api'
import { nanoid } from 'nanoid'
import { ChannelManager } from '../channels/channel-manager'
import {
  isChannelPluginToolEnabled,
  readChannelPlugins,
  writeChannelPlugins
} from '../channels/channel-config-store'
import { safeSendMessagePackToAllWindows } from '../window-ipc'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'
import { CHANNEL_PROVIDERS } from '../channels/channel-descriptors'
import { getNativeWorker } from '../lib/native-worker'
import { handleChannelAutoReply } from '../channels/auto-reply'
import type {
  ChannelInstance,
  ChannelEvent,
  ChannelProviderDescriptor
} from '../channels/channel-types'
import {
  startWeixinLoginWithQr,
  waitForWeixinLogin,
  DEFAULT_WEIXIN_BASE_URL
} from '../channels/providers/weixin/weixin-login'
import type { FeishuService } from '../channels/providers/feishu/feishu-service'
import type { WeixinService } from '../channels/providers/weixin/weixin-service'

let activeChannelManager: ChannelManager | null = null

interface NativeProjectRow {
  id: string
  name: string
  working_folder: string | null
  ssh_connection_id: string | null
  plugin_id?: string | null
  pinned: number
  created_at: number
  updated_at: number
}

interface NativePluginSessionRow {
  id: string
  title: string
  icon: string | null
  mode: string
  created_at: number
  updated_at: number
  project_id?: string | null
  working_folder: string | null
  ssh_connection_id?: string | null
  plan_id?: string | null
  pinned: number
  message_count?: number
  plugin_id?: string | null
  external_chat_id?: string | null
  provider_id?: string | null
  model_id?: string | null
  model_selection_mode?: string | null
}

interface NativePluginSessionMessageRow {
  id: string
  role: string
  content: string
  created_at: number
}

interface NativePluginSessionMutationResult {
  success: boolean
  changed: number
  deleted: number
  error?: string | null
}

interface NativePluginSessionFindResult {
  success: boolean
  session?: NativePluginSessionRow | null
  error?: string | null
}

async function requestNativeDb<T>(
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  return await getNativeWorker().request<T>(method, params, 120_000)
}

function registerChannelMessagePackHandler<TArgs>(
  channel: string,
  handler: (args: TArgs) => Promise<unknown>
): void {
  ipcMain.handle(toMessagePackChannel(channel), async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<TArgs>(bytes)
    return encodeMessagePackPayload(await handler(args))
  })
}

function assertNativeMutation(
  result: NativePluginSessionMutationResult,
  label: string
): NativePluginSessionMutationResult {
  if (!result.success) {
    throw new Error(result.error || `${label} failed`)
  }
  return result
}

async function captureQrPageAsDataUrl(url: string): Promise<string | undefined> {
  const win = new BrowserWindow({
    show: false,
    width: 720,
    height: 960,
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: false,
      offscreen: false
    }
  })

  try {
    await win.loadURL(url)
    await new Promise((resolve) => setTimeout(resolve, 1800))
    const image = await win.webContents.capturePage()
    const png = image.toPNG()
    return `data:image/png;base64,${png.toString('base64')}`
  } catch {
    return undefined
  } finally {
    if (!win.isDestroyed()) {
      win.destroy()
    }
  }
}

async function normalizeQrDisplayUrl(url?: string): Promise<string | undefined> {
  const value = url?.trim()
  if (!value) return undefined
  if (value.startsWith('data:image/')) return value
  if (!/^https?:\/\//i.test(value)) return value

  try {
    const response = await fetch(value)
    if (!response.ok) {
      return (await captureQrPageAsDataUrl(value)) || value
    }

    const contentType = response.headers.get('content-type') || ''

    if (contentType.startsWith('image/')) {
      const buffer = Buffer.from(await response.arrayBuffer())
      return `data:${contentType};base64,${buffer.toString('base64')}`
    }

    const html = await response.text()
    const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i)
    if (imgMatch?.[1]) {
      const imgSrc = new URL(imgMatch[1], value).toString()
      const imageResponse = await fetch(imgSrc)
      if (imageResponse.ok) {
        const imageType = imageResponse.headers.get('content-type') || 'image/png'
        const imageBuffer = Buffer.from(await imageResponse.arrayBuffer())
        return `data:${imageType};base64,${imageBuffer.toString('base64')}`
      }
    }

    return (await captureQrPageAsDataUrl(value)) || value
  } catch {
    return (await captureQrPageAsDataUrl(value)) || value
  }
}

function resolveSourceFileName(source: string, fallback: string): string {
  const value = source.trim()
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      const fileName = path.basename(url.pathname)
      return decodeURIComponent(fileName || fallback)
    } catch {
      return fallback
    }
  }

  const sanitized = value.split('?')[0]
  return path.basename(sanitized) || fallback
}

async function readBinarySource(
  source: string,
  fallbackName: string
): Promise<{ buffer: Buffer; fileName: string }> {
  const value = source.trim()
  if (!value) {
    throw new Error('File path is empty')
  }

  if (/^https?:\/\//i.test(value)) {
    const response = await fetch(value)
    if (!response.ok) {
      throw new Error(`Download URL failed: HTTP ${response.status}`)
    }
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      fileName: resolveSourceFileName(value, fallbackName)
    }
  }

  if (!fs.existsSync(value)) {
    throw new Error(`File not found: ${value}`)
  }

  return {
    buffer: fs.readFileSync(value),
    fileName: resolveSourceFileName(value, fallbackName)
  }
}

// ── Persistence helpers ──

function buildToolsMap(
  descriptor?: ChannelProviderDescriptor,
  existing?: Record<string, boolean>
): Record<string, boolean> | undefined {
  if (!descriptor?.tools || descriptor.tools.length === 0) {
    return existing
  }
  const next: Record<string, boolean> = {}
  for (const toolName of descriptor.tools) {
    next[toolName] = existing?.[toolName] ?? true
  }
  return next
}

async function readPlugins(): Promise<ChannelInstance[]> {
  return await readChannelPlugins()
}

export async function isPluginToolEnabled(pluginId: string, toolName: string): Promise<boolean> {
  return await isChannelPluginToolEnabled(pluginId, toolName)
}

async function writePlugins(plugins: ChannelInstance[]): Promise<void> {
  await writeChannelPlugins(plugins)
}

// ── Notify renderer of channel events ──

function notifyRenderer(event: ChannelEvent): void {
  safeSendMessagePackToAllWindows('plugin:incoming-message', event)

  // Route incoming messages through auto-reply pipeline
  if (event.type === 'incoming_message') {
    handleChannelAutoReply(event)
  }
}

// ── Register IPC handlers ──

/**
 * Auto-start plugins that have features.autoStart = true and are enabled.
 * Called once at app startup after handlers are registered.
 */
export async function autoStartChannels(channelManager: ChannelManager): Promise<void> {
  const channels = await readPlugins()
  const toStart = channels.filter(
    (p) => p.enabled && (p.features?.autoStart ?? true) // default true for backward compat
  )
  for (const instance of toStart) {
    try {
      await channelManager.startPlugin(instance, notifyRenderer)
      console.log(`[Channel Manager] Auto-started: ${instance.name} (${instance.type})`)
    } catch (err) {
      console.error(`[Channel Manager] Auto-start failed for ${instance.name}:`, err)
    }
  }
}

let _handlersRegistered = false

export async function executePluginAction(args: {
  pluginId: string
  action: string
  params: Record<string, unknown>
}): Promise<unknown> {
  const { pluginId, action, params } = args
  const service = activeChannelManager?.getService(pluginId)
  if (!service) {
    throw new Error(`Plugin ${pluginId} is not running`)
  }

  switch (action) {
    case 'sendMessage': {
      const target = service as typeof service & {
        sendWakeupMessage?: (chatId: string, content: string) => Promise<{ messageId: string }>
      }
      if (params.isWakeup === true && typeof target.sendWakeupMessage === 'function') {
        return await target.sendWakeupMessage(params.chatId as string, params.content as string)
      }
      return await service.sendMessage(params.chatId as string, params.content as string)
    }
    case 'replyMessage':
      return await service.replyMessage(params.messageId as string, params.content as string)
    case 'getGroupMessages':
      return await service.getGroupMessages(params.chatId as string, (params.count as number) ?? 20)
    case 'listGroups':
      return await service.listGroups()
    default:
      throw new Error(`Unknown action: ${action}`)
  }
}

export async function executeChannelSpecificPluginTool(
  channel: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const pluginId = typeof args.pluginId === 'string' ? args.pluginId : ''
  const toolName = typeof args.toolName === 'string' ? args.toolName : ''
  if (!pluginId) {
    return { error: 'Missing pluginId' }
  }
  if (toolName && !(await isPluginToolEnabled(pluginId, toolName))) {
    return { error: `Tool "${toolName}" is disabled for this channel.` }
  }

  switch (channel) {
    case 'plugin:weixin:send-image': {
      const service = activeChannelManager?.getService(pluginId) as WeixinService | undefined
      if (!service) return { error: 'Weixin plugin not running or not found' }

      try {
        const { buffer } = await readBinarySource(String(args.filePath ?? ''), 'image.png')
        const result = await service.sendImage(
          String(args.chatId ?? ''),
          buffer,
          typeof args.content === 'string' ? args.content : undefined
        )
        return { ok: true, messageId: result.messageId }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[Weixin] send-image failed:', msg)
        return { error: msg }
      }
    }
    case 'plugin:weixin:send-file': {
      const service = activeChannelManager?.getService(pluginId) as WeixinService | undefined
      if (!service) return { error: 'Weixin plugin not running or not found' }

      try {
        const { buffer, fileName } = await readBinarySource(String(args.filePath ?? ''), 'file')
        const result = await service.sendFile(
          String(args.chatId ?? ''),
          buffer,
          fileName,
          typeof args.content === 'string' ? args.content : undefined
        )
        return { ok: true, messageId: result.messageId }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[Weixin] send-file failed:', msg)
        return { error: msg }
      }
    }
    case 'plugin:feishu:send-image': {
      const service = activeChannelManager?.getService(pluginId) as FeishuService | undefined
      if (!service?.api) return { error: 'Feishu plugin not running or not found' }

      try {
        let buf: Buffer
        const src = String(args.filePath ?? '').trim()
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
        const result = await service.api.sendImageMessage(String(args.chatId ?? ''), imageKey)
        console.log(`[Feishu] Sent image to ${args.chatId}: messageId=${result.messageId}`)
        return { ok: true, messageId: result.messageId }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[Feishu] send-image failed:', msg)
        return { error: msg }
      }
    }
    case 'plugin:feishu:send-file': {
      const service = activeChannelManager?.getService(pluginId) as FeishuService | undefined
      if (!service?.api) return { error: 'Feishu plugin not running or not found' }

      try {
        let buf: Buffer
        const src = String(args.filePath ?? '').trim()
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
        const ext = path.extname(fileName).toLowerCase().replace('.', '')
        const typeMap: Record<string, 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'> = {
          opus: 'opus',
          mp4: 'mp4',
          pdf: 'pdf',
          doc: 'doc',
          docx: 'doc',
          xls: 'xls',
          xlsx: 'xls',
          ppt: 'ppt',
          pptx: 'ppt'
        }
        const rawFileType = typeof args.fileType === 'string' ? args.fileType : undefined
        const fileType =
          rawFileType === 'opus' ||
          rawFileType === 'mp4' ||
          rawFileType === 'pdf' ||
          rawFileType === 'doc' ||
          rawFileType === 'xls' ||
          rawFileType === 'ppt' ||
          rawFileType === 'stream'
            ? rawFileType
            : (typeMap[ext] ?? 'stream')

        console.log(
          `[Feishu] Uploading file "${fileName}" (${buf.byteLength} bytes, type=${fileType})...`
        )
        const fileKey = await service.api.uploadFile(buf, fileName, fileType)
        console.log(`[Feishu] Uploaded file_key=${fileKey}, sending to chat...`)
        const result = await service.api.sendFileMessage(String(args.chatId ?? ''), fileKey)
        console.log(
          `[Feishu] Sent file "${fileName}" to ${args.chatId}: messageId=${result.messageId}`
        )
        return { ok: true, messageId: result.messageId }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[Feishu] send-file failed:', msg)
        return { error: msg }
      }
    }
    case 'plugin:feishu:send-mention': {
      const service = activeChannelManager?.getService(pluginId) as FeishuService | undefined
      if (!service?.api) return { error: 'Feishu plugin not running or not found' }

      try {
        const chatId = typeof args.chatId === 'string' ? args.chatId.trim() : ''
        if (!chatId) return { error: 'Missing chatId' }
        const info = await service.api.getChatInfo(chatId)
        if (info?.chatType !== 'group') {
          return { error: 'FeishuAtMember is only available in group chats.' }
        }

        const userIds = Array.isArray(args.userIds)
          ? args.userIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
          : []
        const text = typeof args.text === 'string' ? args.text.trim() : ''
        const elements: Array<Record<string, string>> = []
        if (args.atAll === true) {
          elements.push({ tag: 'at', user_id: 'all' })
        }
        for (const uid of userIds) {
          elements.push({ tag: 'at', user_id: uid })
        }
        if (text) {
          const textValue = elements.length > 0 ? ` ${text}` : text
          elements.push({ tag: 'text', text: textValue })
        }
        if (elements.length === 0) return { error: 'Message content is empty' }

        const postContent = {
          zh_cn: {
            content: [elements]
          }
        }

        const result = await service.api.sendMessage(chatId, JSON.stringify(postContent), 'post')
        return { ok: true, messageId: result.messageId }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[Feishu] send-mention failed:', msg)
        return { error: msg }
      }
    }
    case 'plugin:feishu:list-members': {
      const service = activeChannelManager?.getService(pluginId) as FeishuService | undefined
      if (!service?.api) return { error: 'Feishu plugin not running or not found' }

      try {
        const chatId = typeof args.chatId === 'string' ? args.chatId.trim() : ''
        if (!chatId) return { error: 'Missing chatId' }
        return await service.api.listChatMembers({
          chatId,
          pageToken: typeof args.pageToken === 'string' ? args.pageToken : undefined,
          pageSize: typeof args.pageSize === 'number' ? args.pageSize : undefined,
          memberIdType:
            args.memberIdType === 'user_id' || args.memberIdType === 'union_id'
              ? args.memberIdType
              : 'open_id'
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[Feishu] list-members failed:', msg)
        return { error: msg }
      }
    }
    case 'plugin:feishu:send-urgent': {
      const service = activeChannelManager?.getService(pluginId) as FeishuService | undefined
      if (!service?.api) return { error: 'Feishu plugin not running or not found' }

      try {
        const userIds = Array.isArray(args.userIds)
          ? args.userIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
          : []
        const types = Array.isArray(args.urgentTypes)
          ? args.urgentTypes.filter((t): t is 'app' | 'sms' => t === 'app' || t === 'sms')
          : []
        const messageId = typeof args.messageId === 'string' ? args.messageId : ''
        if (!messageId || userIds.length === 0 || types.length === 0) {
          return { error: 'Missing messageId, userIds, or urgentTypes' }
        }
        for (const t of types) {
          await service.api.sendUrgent(messageId, userIds, t, 'user_id')
        }
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[Feishu] send-urgent failed:', msg)
        return { error: msg }
      }
    }
    case 'plugin:feishu:bitable:list-apps':
    case 'plugin:feishu:bitable:list-tables':
    case 'plugin:feishu:bitable:list-fields':
    case 'plugin:feishu:bitable:get-records':
    case 'plugin:feishu:bitable:create-records':
    case 'plugin:feishu:bitable:update-records':
    case 'plugin:feishu:bitable:delete-records': {
      const service = activeChannelManager?.getService(pluginId) as FeishuService | undefined
      if (!service?.api) return { error: 'Feishu plugin not running or not found' }
      try {
        switch (channel) {
          case 'plugin:feishu:bitable:list-apps':
            return { ok: true, data: await service.api.listBitableApps() }
          case 'plugin:feishu:bitable:list-tables':
            return {
              ok: true,
              data: await service.api.listBitableTables(String(args.appToken ?? ''))
            }
          case 'plugin:feishu:bitable:list-fields':
            return {
              ok: true,
              data: await service.api.listBitableFields(
                String(args.appToken ?? ''),
                String(args.tableId ?? '')
              )
            }
          case 'plugin:feishu:bitable:get-records':
            return {
              ok: true,
              data: await service.api.getBitableRecords(
                String(args.appToken ?? ''),
                String(args.tableId ?? ''),
                {
                  filter: typeof args.filter === 'string' ? args.filter : undefined,
                  pageSize: typeof args.pageSize === 'number' ? args.pageSize : undefined,
                  pageToken: typeof args.pageToken === 'string' ? args.pageToken : undefined
                }
              )
            }
          case 'plugin:feishu:bitable:create-records':
            return {
              ok: true,
              data: await service.api.createBitableRecords(
                String(args.appToken ?? ''),
                String(args.tableId ?? ''),
                Array.isArray(args.records) ? args.records : []
              )
            }
          case 'plugin:feishu:bitable:update-records':
            return {
              ok: true,
              data: await service.api.updateBitableRecords(
                String(args.appToken ?? ''),
                String(args.tableId ?? ''),
                Array.isArray(args.records) ? args.records : []
              )
            }
          case 'plugin:feishu:bitable:delete-records':
            return {
              ok: true,
              data: await service.api.deleteBitableRecords(
                String(args.appToken ?? ''),
                String(args.tableId ?? ''),
                Array.isArray(args.recordIds)
                  ? args.recordIds.filter(
                      (id): id is string => typeof id === 'string' && id.length > 0
                    )
                  : []
              )
            }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { error: msg }
      }
    }
  }

  throw new Error(`Unsupported channel-specific plugin tool channel: ${channel}`)
}

export function registerChannelHandlers(channelManager: ChannelManager): void {
  activeChannelManager = channelManager
  if (_handlersRegistered) return
  _handlersRegistered = true

  // List available provider descriptors
  registerChannelMessagePackHandler<undefined>('plugin:list-providers', async () => {
    return CHANNEL_PROVIDERS
  })

  registerChannelMessagePackHandler<{
    pluginId: string
    baseUrl?: string
    routeTag?: string
    accountId?: string
    force?: boolean
  }>('plugin:weixin:login-start', async (args) => {
    try {
      const result = await startWeixinLoginWithQr({
        accountId: args.accountId,
        apiBaseUrl: args.baseUrl || DEFAULT_WEIXIN_BASE_URL,
        routeTag: args.routeTag,
        force: args.force
      })
      return {
        qrDataUrl: await normalizeQrDisplayUrl(result.qrcodeUrl),
        qrUrl: result.qrcodeUrl,
        message: result.message,
        sessionKey: result.sessionKey
      }
    } catch (err) {
      return {
        message: err instanceof Error ? err.message : String(err),
        sessionKey: args.accountId || ''
      }
    }
  })

  registerChannelMessagePackHandler<{
    pluginId: string
    baseUrl?: string
    routeTag?: string
    sessionKey: string
    timeoutMs?: number
  }>('plugin:weixin:login-wait', async (args) => {
    try {
      return await waitForWeixinLogin({
        sessionKey: args.sessionKey,
        apiBaseUrl: args.baseUrl || DEFAULT_WEIXIN_BASE_URL,
        routeTag: args.routeTag,
        timeoutMs: args.timeoutMs
      })
    } catch (err) {
      return {
        connected: false,
        message: err instanceof Error ? err.message : String(err)
      }
    }
  })

  // List persisted plugin instances (auto-provisions built-in plugins)
  registerChannelMessagePackHandler<undefined>('plugin:list', async () => {
    const plugins = await readPlugins()
    const projects = await requestNativeDb<NativeProjectRow[]>('db/plugin-normal-projects')
    let changed = false

    // Migrate legacy unbound built-ins to the first normal project when there is only one.
    if (projects.length === 1) {
      for (const descriptor of CHANNEL_PROVIDERS) {
        const legacyUnbound = plugins.find((p) => p.type === descriptor.type && !p.projectId)
        const hasBoundInstance = plugins.some(
          (p) => p.type === descriptor.type && p.projectId === projects[0].id
        )
        if (legacyUnbound && !hasBoundInstance) {
          legacyUnbound.projectId = projects[0].id
          changed = true
        }
      }
    }

    // Auto-provision one built-in channel instance per normal project and provider type.
    for (const project of projects) {
      for (const descriptor of CHANNEL_PROVIDERS) {
        const existing = plugins.find(
          (p) => p.type === descriptor.type && p.projectId === project.id
        )
        if (!existing) {
          const config: Record<string, string> = {}
          for (const field of descriptor.configSchema) {
            config[field.key] =
              descriptor.type === 'weixin-official' && field.key === 'baseUrl'
                ? DEFAULT_WEIXIN_BASE_URL
                : ''
          }
          plugins.push({
            id: nanoid(),
            type: descriptor.type,
            name: descriptor.displayName,
            enabled: false,
            builtin: true,
            config,
            createdAt: Date.now(),
            projectId: project.id,
            tools: buildToolsMap(descriptor)
          })
          changed = true
        } else {
          if (!existing.builtin) {
            existing.builtin = true
            changed = true
          }
          if (existing.name !== descriptor.displayName) {
            existing.name = descriptor.displayName
            changed = true
          }
        }
      }
    }

    // Ensure old plugin instances have config keys matching their current schema
    for (const p of plugins) {
      const desc = CHANNEL_PROVIDERS.find((d) => d.type === p.type)
      if (!desc) continue
      const schemaKeys = new Set(desc.configSchema.map((f) => f.key))
      for (const field of desc.configSchema) {
        if (!(field.key in p.config)) {
          p.config[field.key] =
            desc.type === 'weixin-official' && field.key === 'baseUrl'
              ? DEFAULT_WEIXIN_BASE_URL
              : ''
          changed = true
        }
      }
      if (desc.type === 'weixin-official' && !p.config.baseUrl) {
        p.config.baseUrl = DEFAULT_WEIXIN_BASE_URL
        changed = true
      }
      // Remove config keys that are no longer in the schema
      for (const key of Object.keys(p.config)) {
        if (!schemaKeys.has(key)) {
          delete p.config[key]
          changed = true
        }
      }
      // Remove legacy top-level fields that are no longer supported
      for (const key of Object.keys(p)) {
        if (
          ![
            'id',
            'type',
            'name',
            'enabled',
            'builtin',
            'config',
            'createdAt',
            'projectId',
            'tools',
            'providerId',
            'model',
            'features',
            'permissions'
          ].includes(key)
        ) {
          delete (p as unknown as Record<string, unknown>)[key]
          changed = true
        }
      }
      // Ensure tools map matches descriptor
      const nextTools = buildToolsMap(desc, p.tools)
      if (nextTools && JSON.stringify(nextTools) !== JSON.stringify(p.tools)) {
        p.tools = nextTools
        changed = true
      }
    }

    if (changed) await writePlugins(plugins)
    console.log(
      `[Channels] Loaded ${plugins.length} channels (${plugins.filter((p) => p.builtin).length} built-in)`
    )
    return plugins
  })

  // Add a new plugin instance
  registerChannelMessagePackHandler<ChannelInstance>('plugin:add', async (instance) => {
    const plugins = await readPlugins()
    const desc = CHANNEL_PROVIDERS.find((d) => d.type === instance.type)
    const nextTools = buildToolsMap(desc, instance.tools)
    plugins.push({
      ...instance,
      ...(nextTools ? { tools: nextTools } : {})
    })
    await writePlugins(plugins)
    return { success: true }
  })

  // Update a plugin instance
  registerChannelMessagePackHandler<{ id: string; patch: Partial<ChannelInstance> }>(
    'plugin:update',
    async ({ id, patch }) => {
      const plugins = await readPlugins()
      const idx = plugins.findIndex((p) => p.id === id)
      if (idx === -1) return { success: false, error: 'Plugin not found' }
      const next = { ...plugins[idx], ...patch }
      if ('providerId' in patch && patch.providerId == null) {
        next.model = null
      }
      plugins[idx] = next
      await writePlugins(plugins)

      if ('providerId' in patch || 'model' in patch) {
        try {
          const providerId = next.providerId ?? null
          const modelId = providerId ? (next.model ?? null) : null
          assertNativeMutation(
            await requestNativeDb<NativePluginSessionMutationResult>(
              'db/plugin-sync-session-models',
              {
                pluginId: id,
                providerId,
                modelId
              }
            ),
            'Sync channel session model'
          )
        } catch (err) {
          console.error('[Channels] Failed to sync channel session model:', err)
        }
      }

      if ('projectId' in patch) {
        try {
          assertNativeMutation(
            await requestNativeDb<NativePluginSessionMutationResult>(
              'db/plugin-sync-session-project',
              {
                pluginId: id,
                projectId: next.projectId ?? null
              }
            ),
            'Sync channel project binding'
          )
        } catch (err) {
          console.error('[Channels] Failed to sync channel project binding:', err)
        }
      }
      return { success: true }
    }
  )

  // Remove a plugin instance (also cascade-deletes plugin sessions)
  // Built-in plugins cannot be removed.
  registerChannelMessagePackHandler<string>('plugin:remove', async (id) => {
    const allPlugins = await readPlugins()
    const target = allPlugins.find((p) => p.id === id)
    if (target?.builtin) {
      return { success: false, error: 'Built-in plugins cannot be removed' }
    }
    // Stop service if running
    await channelManager.stopPlugin(id)
    const plugins = allPlugins.filter((p) => p.id !== id)
    await writePlugins(plugins)
    // Cascade-delete plugin sessions and their messages
    try {
      assertNativeMutation(
        await requestNativeDb<NativePluginSessionMutationResult>('db/plugin-remove-data', {
          pluginId: id
        }),
        'Remove channel data'
      )
    } catch (err) {
      console.error('[Channels] Failed to cascade-delete sessions:', err)
    }
    return { success: true }
  })

  // Start a plugin service
  registerChannelMessagePackHandler<string>('plugin:start', async (id) => {
    const plugins = await readPlugins()
    const instance = plugins.find((p) => p.id === id)
    if (!instance) return { success: false, error: 'Plugin not found' }

    try {
      await channelManager.startPlugin(instance, notifyRenderer)
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  })

  // Stop a plugin service
  registerChannelMessagePackHandler<string>('plugin:stop', async (id) => {
    await channelManager.stopPlugin(id)
    return { success: true }
  })

  // Get plugin status
  registerChannelMessagePackHandler<string>('plugin:status', async (id) => {
    return channelManager.getStatus(id)
  })

  // Unified action dispatch — routes to the correct MessagingPluginService method
  registerChannelMessagePackHandler<{
    pluginId: string
    action: string
    params: Record<string, unknown>
  }>('plugin:exec', async ({ pluginId, action, params }) => {
    return await executePluginAction({ pluginId, action, params })
  })

  // List plugin sessions (filtered by plugin_id)
  registerChannelMessagePackHandler<string>('plugin:sessions:list', async (pluginId) => {
    return await requestNativeDb<NativePluginSessionRow[]>('db/plugin-sessions-list', { pluginId })
  })

  // Create a plugin session
  registerChannelMessagePackHandler<{
    id: string
    pluginId: string
    title: string
    mode: string
    createdAt: number
    updatedAt: number
    externalChatId?: string
  }>('plugin:sessions:create', async (args) => {
    const plugin = (await readPlugins()).find((item) => item.id === args.pluginId)
    const result = await requestNativeDb<NativePluginSessionMutationResult>(
      'db/plugin-sessions-create',
      {
        ...args,
        projectId: plugin?.projectId ?? null,
        providerId: plugin?.providerId ?? null,
        modelId: plugin?.model ?? null
      }
    )
    if (!result.success) {
      return { success: false, error: result.error || 'Create plugin session failed' }
    }
    return { success: true }
  })

  // Find a plugin session by external chat ID
  registerChannelMessagePackHandler<string>('plugin:sessions:find-by-chat', async (externalChatId) => {
    const result = await requestNativeDb<NativePluginSessionFindResult>(
      'db/plugin-sessions-find-by-chat',
      { externalChatId }
    )
    if (!result.success) {
      throw new Error(result.error || 'Find plugin session failed')
    }
    return result.session ?? null
  })

  // ── Streaming output IPC ──

  // Active streaming handles keyed by per-reply streamId.
  const streamHandles = new Map<
    string,
    import('../channels/channel-types').ChannelStreamingHandle
  >()
  const streamContents = new Map<string, string>()

  /**
   * Start a streaming message for a plugin chat.
   * Returns { ok: true, supportsStreaming: true } if streaming was initiated,
   * or { ok: false } if the plugin doesn't support streaming (caller should fallback).
   */
  registerChannelMessagePackHandler<{
    pluginId: string
    chatId: string
    streamId?: string
    initialContent: string
    messageId?: string
  }>('plugin:stream:start', async (args) => {
    const service = channelManager.getService(args.pluginId)
    if (!service || !service.supportsStreaming || !service.sendStreamingMessage) {
      return { ok: false, supportsStreaming: false }
    }

    try {
      const handle = await service.sendStreamingMessage(
        args.chatId,
        args.initialContent,
        args.messageId
      )
      const key = args.streamId || `${args.pluginId}:${args.chatId}`
      streamHandles.set(key, handle)
      streamContents.set(key, args.initialContent ?? '')
      console.log(`[PluginStream] Started streaming for ${args.pluginId}:${args.chatId}:${key}`)
      return { ok: true, supportsStreaming: true }
    } catch (err) {
      console.error('[PluginStream] Failed to start streaming:', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ── Plugin Session Management ──

  /** List all plugin sessions (sessions with plugin_id set) */
  registerChannelMessagePackHandler<undefined>('plugin:sessions:list-all', async () => {
    return await requestNativeDb<NativePluginSessionRow[]>('db/plugin-sessions-list-all')
  })

  /** Get messages for a plugin session */
  registerChannelMessagePackHandler<{ sessionId: string; limit?: number; offset?: number }>(
    'plugin:sessions:messages',
    async (args) => {
      return await requestNativeDb<NativePluginSessionMessageRow[]>(
        'db/plugin-sessions-messages',
        args as Record<string, unknown>
      )
    }
  )

  /** Clear all messages in a plugin session */
  registerChannelMessagePackHandler<{ sessionId: string }>('plugin:sessions:clear', async (args) => {
    const result = assertNativeMutation(
      await requestNativeDb<NativePluginSessionMutationResult>(
        'db/plugin-sessions-clear',
        args as Record<string, unknown>
      ),
      'Clear plugin session'
    )
    return { deleted: result.deleted }
  })

  /** Delete a plugin session and its messages */
  registerChannelMessagePackHandler<{ sessionId: string }>('plugin:sessions:delete', async (args) => {
    assertNativeMutation(
      await requestNativeDb<NativePluginSessionMutationResult>(
        'db/plugin-sessions-delete',
        args as Record<string, unknown>
      ),
      'Delete plugin session'
    )
    // Notify renderer to remove from store
    const payload = { sessionId: args.sessionId }
    safeSendMessagePackToAllWindows('plugin:session-deleted', payload)
    return { ok: true }
  })

  /** Rename a plugin session */
  registerChannelMessagePackHandler<{ sessionId: string; title: string }>(
    'plugin:sessions:rename',
    async (args) => {
      assertNativeMutation(
        await requestNativeDb<NativePluginSessionMutationResult>(
          'db/plugin-sessions-rename',
          args as Record<string, unknown>
        ),
        'Rename plugin session'
      )
      return { ok: true }
    }
  )

  // ── Weixin media send ──

  registerChannelMessagePackHandler<{
    pluginId: string
    chatId: string
    filePath: string
    content?: string
  }>('plugin:weixin:send-image', async (args) => {
    const service = channelManager.getService(args.pluginId) as
      | import('../channels/providers/weixin/weixin-service').WeixinService
      | undefined
    if (!service) return { error: 'Weixin plugin not running or not found' }

    try {
      const { buffer } = await readBinarySource(args.filePath, 'image.png')
      const result = await service.sendImage(args.chatId, buffer, args.content)
      return { ok: true, messageId: result.messageId }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Weixin] send-image failed:', msg)
      return { error: msg }
    }
  })

  registerChannelMessagePackHandler<{
    pluginId: string
    chatId: string
    filePath: string
    content?: string
  }>('plugin:weixin:send-file', async (args) => {
    const service = channelManager.getService(args.pluginId) as
      | import('../channels/providers/weixin/weixin-service').WeixinService
      | undefined
    if (!service) return { error: 'Weixin plugin not running or not found' }

    try {
      const { buffer, fileName } = await readBinarySource(args.filePath, 'file')
      const result = await service.sendFile(args.chatId, buffer, fileName, args.content)
      return { ok: true, messageId: result.messageId }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Weixin] send-file failed:', msg)
      return { error: msg }
    }
  })

  // ── Feishu media send ──

  /**
   * Send an image to a Feishu chat.
   * `source` can be:
   *   - An absolute local file path  (e.g. /home/user/pic.png or C:\...\pic.png)
   *   - An HTTP/HTTPS URL            (e.g. https://example.com/image.png)
   */
  registerChannelMessagePackHandler<{ pluginId: string; chatId: string; filePath: string }>(
    'plugin:feishu:send-image',
    async (args) => {
      const service = channelManager.getService(args.pluginId) as
        | import('../channels/providers/feishu/feishu-service').FeishuService
        | undefined
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
  registerChannelMessagePackHandler<{
    pluginId: string
    chatId: string
    filePath: string
    fileType?: string
  }>('plugin:feishu:send-file', async (args) => {
    const service = channelManager.getService(args.pluginId) as
      | import('../channels/providers/feishu/feishu-service').FeishuService
      | undefined
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
        opus: 'opus',
        mp4: 'mp4',
        pdf: 'pdf',
        doc: 'doc',
        docx: 'doc',
        xls: 'xls',
        xlsx: 'xls',
        ppt: 'ppt',
        pptx: 'ppt'
      }
      const fileType =
        (args.fileType as 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' | undefined) ??
        typeMap[ext] ??
        'stream'

      console.log(
        `[Feishu] Uploading file "${fileName}" (${buf.byteLength} bytes, type=${fileType})...`
      )
      const fileKey = await service.api.uploadFile(buf, fileName, fileType)
      console.log(`[Feishu] Uploaded file_key=${fileKey}, sending to chat...`)
      const result = await service.api.sendFileMessage(args.chatId, fileKey)
      console.log(
        `[Feishu] Sent file "${fileName}" to ${args.chatId}: messageId=${result.messageId}`
      )
      return { ok: true, messageId: result.messageId }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Feishu] send-file failed:', msg)
      return { error: msg }
    }
  })

  /** Mention members in a Feishu group chat */
  registerChannelMessagePackHandler<{
    pluginId: string
    chatId?: string
    userIds?: string[]
    atAll?: boolean
    text?: string
  }>('plugin:feishu:send-mention', async (args) => {
    const service = channelManager.getService(args.pluginId) as
      | import('../channels/providers/feishu/feishu-service').FeishuService
      | undefined
    if (!service?.api) return { error: 'Feishu plugin not running or not found' }

    try {
      const chatId = args.chatId?.trim()
      if (!chatId) return { error: 'Missing chatId' }
      const info = await service.api.getChatInfo(chatId)
      if (info?.chatType !== 'group') {
        return { error: 'FeishuAtMember is only available in group chats.' }
      }

      const userIds = Array.isArray(args.userIds) ? args.userIds.filter(Boolean) : []
      const text = args.text?.trim() ?? ''
      const elements: Array<Record<string, string>> = []
      if (args.atAll) {
        elements.push({ tag: 'at', user_id: 'all' })
      }
      for (const uid of userIds) {
        elements.push({ tag: 'at', user_id: uid })
      }
      if (text) {
        const textValue = elements.length > 0 ? ` ${text}` : text
        elements.push({ tag: 'text', text: textValue })
      }
      if (elements.length === 0) return { error: 'Message content is empty' }

      const postContent = {
        zh_cn: {
          content: [elements]
        }
      }

      const result = await service.api.sendMessage(chatId, JSON.stringify(postContent), 'post')
      return { ok: true, messageId: result.messageId }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Feishu] send-mention failed:', msg)
      return { error: msg }
    }
  })

  /** List members in a Feishu chat */
  registerChannelMessagePackHandler<{
    pluginId: string
    chatId?: string
    pageToken?: string
    pageSize?: number
    memberIdType?: 'open_id' | 'user_id' | 'union_id'
  }>('plugin:feishu:list-members', async (args) => {
    const service = channelManager.getService(args.pluginId) as
      | import('../channels/providers/feishu/feishu-service').FeishuService
      | undefined
    if (!service?.api) return { error: 'Feishu plugin not running or not found' }

    try {
      const chatId = args.chatId?.trim()
      if (!chatId) return { error: 'Missing chatId' }
      const result = await service.api.listChatMembers({
        chatId,
        pageToken: args.pageToken,
        pageSize: args.pageSize,
        memberIdType: args.memberIdType
      })
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Feishu] list-members failed:', msg)
      return { error: msg }
    }
  })

  /** Send urgent push (app/sms) */
  registerChannelMessagePackHandler<{
    pluginId: string
    messageId: string
    userIds: string[]
    urgentTypes: Array<'app' | 'sms'>
  }>('plugin:feishu:send-urgent', async (args) => {
    const service = channelManager.getService(args.pluginId) as
      | import('../channels/providers/feishu/feishu-service').FeishuService
      | undefined
    if (!service?.api) return { error: 'Feishu plugin not running or not found' }

    try {
      const types = Array.isArray(args.urgentTypes)
        ? args.urgentTypes.filter((t) => t === 'app' || t === 'sms')
        : []
      if (!args.messageId || !args.userIds?.length || types.length === 0) {
        return { error: 'Missing messageId, userIds, or urgentTypes' }
      }
      for (const t of types) {
        await service.api.sendUrgent(args.messageId, args.userIds, t, 'user_id')
      }
      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Feishu] send-urgent failed:', msg)
      return { error: msg }
    }
  })

  /** Download Feishu message resource (audio/file) as base64 */
  registerChannelMessagePackHandler<{
    pluginId: string
    messageId: string
    fileKey: string
    type?: 'image' | 'file'
    mediaType?: string
  }>('plugin:feishu:download-resource', async (args) => {
    const service = channelManager.getService(args.pluginId) as
      | import('../channels/providers/feishu/feishu-service').FeishuService
      | undefined
    if (!service?.api) return { error: 'Feishu plugin not running or not found' }

    try {
      const buf = await service.api.downloadMessageResource(
        args.messageId,
        args.fileKey,
        args.type ?? 'file'
      )
      return {
        ok: true,
        base64: buf.toString('base64'),
        mediaType: args.mediaType ?? 'application/octet-stream'
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Feishu] download-resource failed:', msg)
      return { error: msg }
    }
  })

  // ── Feishu Bitable ──

  registerChannelMessagePackHandler<{ pluginId: string }>(
    'plugin:feishu:bitable:list-apps',
    async (args) => {
      const service = channelManager.getService(args.pluginId) as
        | import('../channels/providers/feishu/feishu-service').FeishuService
        | undefined
      if (!service?.api) return { error: 'Feishu plugin not running or not found' }
      try {
        const data = await service.api.listBitableApps()
        return { ok: true, data }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { error: msg }
      }
    }
  )

  registerChannelMessagePackHandler<{ pluginId: string; appToken: string }>(
    'plugin:feishu:bitable:list-tables',
    async (args) => {
      const service = channelManager.getService(args.pluginId) as
        | import('../channels/providers/feishu/feishu-service').FeishuService
        | undefined
      if (!service?.api) return { error: 'Feishu plugin not running or not found' }
      try {
        const data = await service.api.listBitableTables(args.appToken)
        return { ok: true, data }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { error: msg }
      }
    }
  )

  registerChannelMessagePackHandler<{ pluginId: string; appToken: string; tableId: string }>(
    'plugin:feishu:bitable:list-fields',
    async (args) => {
      const service = channelManager.getService(args.pluginId) as
        | import('../channels/providers/feishu/feishu-service').FeishuService
        | undefined
      if (!service?.api) return { error: 'Feishu plugin not running or not found' }
      try {
        const data = await service.api.listBitableFields(args.appToken, args.tableId)
        return { ok: true, data }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { error: msg }
      }
    }
  )

  registerChannelMessagePackHandler<{
    pluginId: string
    appToken: string
    tableId: string
    filter?: string
    pageSize?: number
    pageToken?: string
  }>('plugin:feishu:bitable:get-records', async (args) => {
    const service = channelManager.getService(args.pluginId) as
      | import('../channels/providers/feishu/feishu-service').FeishuService
      | undefined
    if (!service?.api) return { error: 'Feishu plugin not running or not found' }
    try {
      const data = await service.api.getBitableRecords(args.appToken, args.tableId, {
        filter: args.filter,
        pageSize: args.pageSize,
        pageToken: args.pageToken
      })
      return { ok: true, data }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { error: msg }
    }
  })

  registerChannelMessagePackHandler<{
    pluginId: string
    appToken: string
    tableId: string
    records: unknown[]
  }>('plugin:feishu:bitable:create-records', async (args) => {
    const service = channelManager.getService(args.pluginId) as
      | import('../channels/providers/feishu/feishu-service').FeishuService
      | undefined
    if (!service?.api) return { error: 'Feishu plugin not running or not found' }
    try {
      const data = await service.api.createBitableRecords(args.appToken, args.tableId, args.records)
      return { ok: true, data }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { error: msg }
    }
  })

  registerChannelMessagePackHandler<{
    pluginId: string
    appToken: string
    tableId: string
    records: unknown[]
  }>('plugin:feishu:bitable:update-records', async (args) => {
    const service = channelManager.getService(args.pluginId) as
      | import('../channels/providers/feishu/feishu-service').FeishuService
      | undefined
    if (!service?.api) return { error: 'Feishu plugin not running or not found' }
    try {
      const data = await service.api.updateBitableRecords(args.appToken, args.tableId, args.records)
      return { ok: true, data }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { error: msg }
    }
  })

  registerChannelMessagePackHandler<{
    pluginId: string
    appToken: string
    tableId: string
    recordIds: string[]
  }>('plugin:feishu:bitable:delete-records', async (args) => {
    const service = channelManager.getService(args.pluginId) as
      | import('../channels/providers/feishu/feishu-service').FeishuService
      | undefined
    if (!service?.api) return { error: 'Feishu plugin not running or not found' }
    try {
      const data = await service.api.deleteBitableRecords(
        args.appToken,
        args.tableId,
        args.recordIds
      )
      return { ok: true, data }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { error: msg }
    }
  })

  // ── Streaming ──

  /** Send a streaming content update (accumulated text, not delta) */
  registerChannelMessagePackHandler<{
    pluginId: string
    chatId: string
    streamId?: string
    content: string
  }>('plugin:stream:update', async (args) => {
    const key = args.streamId || `${args.pluginId}:${args.chatId}`
    const handle = streamHandles.get(key)
    if (!handle) return { ok: false }

    try {
      streamContents.set(key, args.content)
      await handle.update(args.content)
      return { ok: true }
    } catch (err) {
      console.warn(`[PluginStream] Update failed for ${key}:`, err)
      return { ok: false }
    }
  })

  /** Append a streaming delta and forward the accumulated content to providers */
  registerChannelMessagePackHandler<{
    pluginId: string
    chatId: string
    streamId?: string
    delta: string
  }>('plugin:stream:append', async (args) => {
    const key = args.streamId || `${args.pluginId}:${args.chatId}`
    const handle = streamHandles.get(key)
    if (!handle) return { ok: false }

    try {
      const nextContent = `${streamContents.get(key) ?? ''}${args.delta ?? ''}`
      streamContents.set(key, nextContent)
      await handle.update(nextContent)
      return { ok: true }
    } catch (err) {
      console.warn(`[PluginStream] Append failed for ${key}:`, err)
      return { ok: false }
    }
  })

  /** Finish the streaming message with final content */
  registerChannelMessagePackHandler<{
    pluginId: string
    chatId: string
    streamId?: string
    content: string
  }>('plugin:stream:finish', async (args) => {
    const key = args.streamId || `${args.pluginId}:${args.chatId}`
    const handle = streamHandles.get(key)
    if (!handle) return { ok: false }

    try {
      streamContents.set(key, args.content)
      await handle.finish(args.content)
      streamHandles.delete(key)
      streamContents.delete(key)
      console.log(`[PluginStream] Finished streaming for ${args.pluginId}:${args.chatId}:${key}`)
      return { ok: true }
    } catch (err) {
      console.error(`[PluginStream] Finish failed for ${args.pluginId}:${args.chatId}:${key}:`, err)
      streamHandles.delete(key)
      streamContents.delete(key)
      return { ok: false }
    }
  })
}
