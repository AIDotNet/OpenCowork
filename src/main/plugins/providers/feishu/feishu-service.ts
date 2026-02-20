import * as Lark from '@larksuiteoapi/node-sdk'
import type {
  PluginInstance,
  PluginEvent,
  PluginMessage,
  PluginGroup,
  MessagingPluginService,
  StreamingHandle,
  PluginIncomingMessageData,
} from '../../plugin-types'
import { FeishuApi } from './feishu-api'

/** Throttle interval for card updates (ms) */
const STREAM_THROTTLE_MS = 500

/**
 * Build a custom httpInstance for the Lark SDK that uses native fetch
 * instead of axios. This fixes the 400 error in Electron's main process
 * where axios requests to the WS endpoint fail.
 */
function buildFetchHttpInstance(): Lark.HttpInstance {
  const request = async (opts: { url: string; method: string; data?: unknown; headers?: Record<string, string> }) => {
    const res = await fetch(opts.url, {
      method: opts.method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'oapi-node-sdk/1.0.0',
        ...(opts.headers ?? {}),
      },
      body: opts.data != null ? JSON.stringify(opts.data) : undefined,
    })
    return res.json()
  }
  return {
    request,
    get: (url: string, opts?: unknown) => request({ url, method: 'GET', ...(opts as object ?? {}) }),
    post: (url: string, data?: unknown) => request({ url, method: 'POST', data }),
    put: (url: string, data?: unknown) => request({ url, method: 'PUT', data }),
    delete: (url: string) => request({ url, method: 'DELETE' }),
    head: (url: string) => request({ url, method: 'HEAD' }),
    options: (url: string) => request({ url, method: 'OPTIONS' }),
    patch: (url: string, data?: unknown) => request({ url, method: 'PATCH', data }),
  } as unknown as Lark.HttpInstance
}

/**
 * FeishuService — uses @larksuiteoapi/node-sdk WSClient with a custom
 * fetch-based httpInstance to bypass axios failures in Electron.
 * SDK handles protobuf frame parsing; we only handle event dispatch.
 */
export class FeishuService implements MessagingPluginService {
  readonly pluginId: string
  readonly pluginType = 'feishu-bot'
  readonly supportsStreaming = true

  private _instance: PluginInstance
  private _notify: (event: PluginEvent) => void
  private _running = false
  api!: FeishuApi
  private wsClient: Lark.WSClient | null = null
  private _cardSequences = new Map<string, number>()
  /** Dedup: track recently processed message IDs to prevent duplicate event delivery */
  private _processedMsgIds = new Set<string>()
  /** Cache: chat_id → chat name */
  private _chatNameCache = new Map<string, string>()
  /** Bot's own open_id — fetched once at startup for reliable @mention detection */
  private _botOpenId = ''

  constructor(instance: PluginInstance, notify: (event: PluginEvent) => void) {
    this._instance = instance
    this._notify = notify
    this.pluginId = instance.id
  }

  async start(): Promise<void> {
    const { appId, appSecret } = this._instance.config
    if (!appId || !appSecret) {
      throw new Error('Missing required config: App ID and App Secret must be provided')
    }

    this.api = new FeishuApi(appId, appSecret)
    await this.api.ensureToken()

    // Fetch bot's own open_id for reliable @mention detection in group chats
    try {
      const botInfo = await this.api.getBotInfo()
      this._botOpenId = botInfo.openId
      console.log(`[Feishu] Bot identity: ${botInfo.appName} (${botInfo.openId})`)
    } catch (err) {
      console.warn('[Feishu] Failed to fetch bot info, group @mention detection may be unreliable:', err)
    }

    // Use custom fetch-based httpInstance to fix axios 400 in Electron
    this.wsClient = new Lark.WSClient({
      appId,
      appSecret,
      loggerLevel: Lark.LoggerLevel.info,
      httpInstance: buildFetchHttpInstance(),
    })

    this.wsClient.start({
      eventDispatcher: new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          try {
            const msg = data as {
              message?: {
                message_id?: string
                chat_id?: string
                chat_type?: string // 'p2p' | 'group'
                content?: string
                message_type?: string
                mentions?: Array<{ key: string; id: { open_id?: string; union_id?: string }; name: string }>
              }
              sender?: { sender_id?: { open_id?: string; user_id?: string } }
            }

            const chatId = msg.message?.chat_id ?? ''
            const messageId = msg.message?.message_id ?? ''
            const msgType = msg.message?.message_type ?? 'text'
            const chatType = (msg.message?.chat_type ?? 'p2p') as 'p2p' | 'group'
            const senderId = msg.sender?.sender_id?.open_id ?? msg.sender?.sender_id?.user_id ?? ''
            const mentions = msg.message?.mentions ?? []

            // Group chat filter: only respond when the bot is @mentioned
            if (chatType === 'group') {
              const isBotMentioned = mentions.some((m) =>
                m.key === '@_all' ||
                (this._botOpenId && m.id?.open_id === this._botOpenId) ||
                (!this._botOpenId && m.name === (this._instance.name || ''))
              )
              if (!isBotMentioned) {
                return
              }
            }

            // Dedup: skip if we've already processed this message
            if (messageId && this._processedMsgIds.has(messageId)) {
              console.log(`[Feishu] Skipping duplicate message ${messageId}`)
              return
            }
            this._processedMsgIds.add(messageId)
            // Evict old entries to prevent unbounded memory growth
            if (this._processedMsgIds.size > 500) {
              const first = this._processedMsgIds.values().next().value
              if (first) this._processedMsgIds.delete(first)
            }

            let content = ''
            let images: Array<{ base64: string; mediaType: string }> | undefined

            try {
              const parsed = JSON.parse(msg.message?.content ?? '{}')

              if (msgType === 'image' && parsed.image_key) {
                // Image message: download and convert to base64
                content = '[User sent an image]'
                try {
                  const buf = await this.api.downloadMessageResource(messageId, parsed.image_key, 'image')
                  images = [{ base64: buf.toString('base64'), mediaType: 'image/png' }]
                  console.log(`[Feishu] Downloaded image ${parsed.image_key} (${buf.byteLength} bytes)`)
                } catch (err) {
                  console.warn(`[Feishu] Failed to download image:`, err)
                  content = `[User sent an image but download failed: ${parsed.image_key}]`
                }
              } else {
                content = parsed.text ?? ''
              }
            } catch {
              content = msg.message?.content ?? ''
            }

            // Strip @bot mention placeholder from content (Feishu uses @_user_1 style placeholders)
            if (mentions.length > 0 && content) {
              for (const m of mentions) {
                content = content.replace(new RegExp(m.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '').trim()
              }
            }

            if (!chatId || (!content && !images)) return

            console.log(`[Feishu] ${msgType} [${chatType}] in ${chatId}: ${content.slice(0, 60)}${images ? ` [+${images.length} image(s)]` : ''}`)

            // Resolve chat name (cached)
            let chatName = this._chatNameCache.get(chatId)
            if (!chatName) {
              try {
                const info = await this.api.getChatInfo(chatId)
                chatName = info?.name || ''
                if (chatName) this._chatNameCache.set(chatId, chatName)
              } catch { /* ignore */ }
            }

            this._notify({
              type: 'incoming_message',
              pluginId: this.pluginId,
              pluginType: this.pluginType,
              data: {
                chatId,
                senderId,
                senderName: '',
                content,
                messageId,
                images,
                msgType,
                chatName,
                chatType,
              } as PluginIncomingMessageData,
            })
          } catch (err) {
            console.error('[Feishu] Error handling message:', err)
          }
        },
      }),
    })

    this._running = true
    this._notify({
      type: 'status_change',
      pluginId: this.pluginId,
      pluginType: this.pluginType,
      data: 'running',
    })
    console.log(`[Feishu] Started for plugin ${this.pluginId}`)
  }

  async stop(): Promise<void> {
    this._running = false
    if (this.wsClient) {
      try { this.wsClient.close() } catch { /* ignore */ }
      this.wsClient = null
    }
    console.log(`[Feishu] Stopped plugin ${this.pluginId}`)
  }

  isRunning(): boolean {
    return this._running
  }

  /** Expose the REST API client for IPC handlers that need direct access */
  getApi(): FeishuApi {
    return this.api
  }

  // ── Messaging API (via our REST client) ──

  async sendMessage(chatId: string, content: string): Promise<{ messageId: string }> {
    return this.api.sendMessage(chatId, content)
  }

  async replyMessage(messageId: string, content: string): Promise<{ messageId: string }> {
    return this.api.replyMessage(messageId, content)
  }

  async getGroupMessages(chatId: string, count?: number): Promise<PluginMessage[]> {
    const messages = await this.api.getMessages(chatId, count)
    return messages.map((m) => ({
      id: m.message_id,
      senderId: m.sender_id,
      senderName: m.sender_name,
      chatId,
      content: m.content,
      timestamp: parseInt(m.create_time, 10) || Date.now(),
      raw: m.raw,
    }))
  }

  async listGroups(): Promise<PluginGroup[]> {
    const chats = await this.api.listChats()
    return chats.map((c) => ({
      id: c.chat_id,
      name: c.name,
      memberCount: c.member_count,
      raw: c.raw,
    }))
  }

  // ── Streaming Output via CardKit ──

  private _nextSeq(cardId: string): number {
    const seq = (this._cardSequences.get(cardId) ?? 0) + 1
    this._cardSequences.set(cardId, seq)
    return seq
  }

  async sendStreamingMessage(
    chatId: string,
    initialContent: string,
    replyToMessageId?: string
  ): Promise<StreamingHandle> {
    const { cardId } = await this.api.createCard(
      initialContent || '⏳ Thinking...',
      this._instance.name || 'AI Assistant'
    )

    // Reply to the original message if messageId is provided, otherwise send as new message
    if (replyToMessageId) {
      await this.api.replyCardMessage(replyToMessageId, cardId)
    } else {
      await this.api.sendCardMessage(chatId, cardId)
    }

    let lastUpdateTime = 0

    const handle: StreamingHandle = {
      update: async (content: string) => {
        const now = Date.now()
        if (now - lastUpdateTime < STREAM_THROTTLE_MS) return
        lastUpdateTime = now
        const seq = this._nextSeq(cardId)
        await this.api.updateCard(cardId, content, seq)
      },
      finish: async (finalContent: string) => {
        const seq = this._nextSeq(cardId)
        await this.api.updateCard(cardId, finalContent, seq)
        this._cardSequences.delete(cardId)
      },
    }

    return handle
  }
}

export function createFeishuService(
  instance: PluginInstance,
  notify: (event: PluginEvent) => void
): MessagingPluginService {
  return new FeishuService(instance, notify)
}
