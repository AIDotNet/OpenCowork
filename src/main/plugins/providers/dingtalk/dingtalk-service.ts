import * as https from 'https'
import { DWClient, TOPIC_ROBOT, EventAck } from 'dingtalk-stream'
import type { DWClientDownStream } from 'dingtalk-stream'
import type {
  PluginInstance,
  PluginEvent,
  PluginMessage,
  PluginGroup,
  PluginIncomingMessageData,
  MessagingPluginService,
  StreamingHandle,
} from '../../plugin-types'
import { BasePluginService } from '../../base-plugin-service'
import { DingTalkApi } from './dingtalk-api'

interface WebhookEntry {
  url: string
  expiredTime: number
}

interface ChatMeta {
  conversationType: 'p2p' | 'group'
  senderId: string
}

/** Throttle interval for card streaming updates (ms) */
const STREAM_THROTTLE_MS = 500

export class DingTalkService extends BasePluginService {
  readonly pluginType = 'dingtalk-bot'
  private api!: DingTalkApi
  private client: DWClient | null = null
  /** Cache sessionWebhook URLs keyed by chatId for direct replies */
  private webhookCache = new Map<string, WebhookEntry>()
  /** Cache chat metadata for constructing card openSpaceId */
  private chatMetaCache = new Map<string, ChatMeta>()
  /** Sequence counter for streaming card GUIDs */
  private _guidCounter = 0

  /** Return null to prevent BasePluginService from creating a generic WS transport */
  protected async resolveWsUrl(): Promise<string | null> {
    return null
  }

  protected async onStart(): Promise<void> {
    const { appKey, appSecret } = this._instance.config
    if (!appKey || !appSecret) {
      throw new Error('Missing required config: App Key and App Secret must be provided')
    }
    this.api = new DingTalkApi(appKey, appSecret)
    await this.api.ensureToken()

    // Initialize official DingTalk Stream SDK client
    this.client = new DWClient({
      clientId: appKey,
      clientSecret: appSecret,
      keepAlive: true,
      debug: false,
    })

    // Register event listener for all events (auto-ACK handled by SDK)
    this.client.registerAllEventListener((msg: DWClientDownStream) => {
      this.processBotMessage(msg)
      return { status: EventAck.SUCCESS }
    })

    // Register callback listener for robot messages
    this.client.registerCallbackListener(TOPIC_ROBOT, (msg: DWClientDownStream) => {
      this.processBotMessage(msg)
      this.client?.send(msg.headers.messageId, { response: {} })
    })

    // Ensure DingTalk API bypasses system proxy (axios in SDK respects NO_PROXY)
    const noProxy = process.env.NO_PROXY || process.env.no_proxy || ''
    if (!noProxy.includes('dingtalk.com')) {
      process.env.NO_PROXY = noProxy ? `${noProxy},api.dingtalk.com,oapi.dingtalk.com` : 'api.dingtalk.com,oapi.dingtalk.com'
    }

    // Connect the stream
    try {
      await this.client.connect()
      console.log(`[DingTalk] Stream connected for plugin ${this.pluginId}`)
    } catch (err) {
      console.error('[DingTalk] Failed to connect stream:', err)
      this.emit({
        type: 'error',
        pluginId: this.pluginId,
        pluginType: this.pluginType,
        data: err instanceof Error ? err.message : String(err),
      })
    }
  }

  protected async onStop(): Promise<void> {
    if (this.client) {
      this.client.disconnect()
      this.client = null
    }
  }

  /** Process a bot message from the stream */
  private processBotMessage(msg: DWClientDownStream): void {
    if (msg.headers.topic !== TOPIC_ROBOT) return

    let payload: Record<string, unknown>
    try {
      payload = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data
    } catch {
      console.warn('[DingTalk] Failed to parse message data:', String(msg.data).slice(0, 200))
      return
    }

    // Extract message content
    const text = payload.text as Record<string, string> | undefined
    let content = ''
    if (text?.content) {
      try {
        const parsed = JSON.parse(text.content)
        content = parsed.content ?? text.content
      } catch {
        content = text.content
      }
    }

    // Strip leading whitespace (DingTalk prepends a space after @mention)
    content = content.trim()
    if (!content) return

    const timestamp = payload.createAt
      ? parseInt(String(payload.createAt), 10)
      : Date.now()

    // Filter stale messages (> 15 minutes old)
    if (Date.now() - timestamp > 15 * 60 * 1000) {
      console.log(`[DingTalk] Ignoring stale message from ${new Date(timestamp).toISOString()}`)
      return
    }

    const chatId = String(payload.conversationId ?? '')

    // Cache sessionWebhook for direct replies
    const sessionWebhook = payload.sessionWebhook as string | undefined
    const sessionWebhookExpiredTime = payload.sessionWebhookExpiredTime
      ? parseInt(String(payload.sessionWebhookExpiredTime), 10)
      : 0
    if (sessionWebhook && sessionWebhookExpiredTime) {
      this.webhookCache.set(chatId, { url: sessionWebhook, expiredTime: sessionWebhookExpiredTime })
      console.log(`[DingTalk] Cached sessionWebhook for chat ${chatId} (expires ${new Date(sessionWebhookExpiredTime).toISOString()})`)
    }

    // Cache chat metadata for card streaming
    const convType = payload.conversationType === '1' ? 'p2p' as const : 'group' as const
    const senderId = String(payload.senderStaffId ?? payload.senderId ?? '')
    this.chatMetaCache.set(chatId, { conversationType: convType, senderId })

    const parsed: PluginIncomingMessageData = {
      chatId,
      senderId: String(payload.senderStaffId ?? payload.senderId ?? ''),
      senderName: String(payload.senderNick ?? ''),
      content,
      messageId: String(payload.msgId ?? ''),
      timestamp,
      chatType: payload.conversationType === '1' ? 'p2p' : 'group',
      chatName: String(payload.conversationTitle ?? ''),
    }

    this.emit({
      type: 'incoming_message',
      pluginId: this.pluginId,
      pluginType: this.pluginType,
      data: parsed,
    })
  }

  // ── Reply via sessionWebhook ──

  /** POST a text reply to the DingTalk sessionWebhook URL */
  private postWebhook(webhookUrl: string, content: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(webhookUrl)
      const body = JSON.stringify({ msgtype: 'text', text: { content } })
      const bodyBuffer = Buffer.from(body, 'utf-8')

      const req = https.request(
        {
          hostname: url.hostname,
          port: 443,
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': String(bodyBuffer.byteLength),
          },
        },
        (res) => {
          let responseBody = ''
          res.on('data', (chunk: Buffer) => { responseBody += chunk.toString() })
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              console.log(`[DingTalk] Webhook reply sent successfully`)
              resolve()
            } else {
              reject(new Error(`Webhook POST failed: ${res.statusCode} ${responseBody}`))
            }
          })
        }
      )

      req.on('error', reject)
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Webhook reply timeout')) })
      req.write(bodyBuffer)
      req.end()
    })
  }

  // ── API Methods ──

  async sendMessage(chatId: string, content: string): Promise<{ messageId: string }> {
    // Try sessionWebhook first (direct reply, no token needed)
    const webhook = this.webhookCache.get(chatId)
    if (webhook && Date.now() < webhook.expiredTime) {
      try {
        await this.postWebhook(webhook.url, content)
        return { messageId: '' }
      } catch (err) {
        console.warn('[DingTalk] Webhook reply failed, falling back to REST API:', err)
      }
    }
    // Fall back to REST API
    return this.api.sendMessage(chatId, content)
  }

  async replyMessage(messageId: string, content: string): Promise<{ messageId: string }> {
    // replyMessage also uses the webhook-first approach via sendMessage
    // The messageId's chatId isn't directly available, so try all cached webhooks
    // For now, fall back to REST API
    return this.api.replyMessage(messageId, content, '')
  }

  async getGroupMessages(chatId: string, count?: number): Promise<PluginMessage[]> {
    const messages = await this.api.getMessages(chatId, count)
    return messages.map((m) => ({
      id: m.messageId,
      senderId: m.senderId,
      senderName: m.senderName,
      chatId,
      content: m.content,
      timestamp: m.createTime,
      raw: m.raw,
    }))
  }

  async listGroups(): Promise<PluginGroup[]> {
    const groups = await this.api.listGroups()
    return groups.map((g) => ({
      id: g.openConversationId,
      name: g.name,
      memberCount: g.memberCount,
      raw: g.raw,
    }))
  }

  // ── Streaming Output via AI Card ──

  get supportsStreaming(): boolean {
    return !!this._instance.config.cardTemplateId
  }

  private _nextGuid(): string {
    this._guidCounter++
    return `${this.pluginId}-${Date.now()}-${this._guidCounter}`
  }

  async sendStreamingMessage(
    chatId: string,
    initialContent: string,
    _replyToMessageId?: string
  ): Promise<StreamingHandle> {
    const cardTemplateId = this._instance.config.cardTemplateId
    if (!cardTemplateId) {
      throw new Error('cardTemplateId not configured — streaming not available')
    }

    const meta = this.chatMetaCache.get(chatId)
    const spaceType = meta?.conversationType === 'p2p' ? 'IM_ROBOT' : 'IM_GROUP'
    const spaceId = spaceType === 'IM_ROBOT' ? (meta?.senderId ?? chatId) : chatId
    const openSpaceId = `dtv1.card//${spaceType}.${spaceId}`
    const outTrackId = `oc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const streamKey = 'content'

    await this.api.createAndDeliverCard({
      cardTemplateId,
      outTrackId,
      openSpaceId,
      spaceType,
      initialContent: initialContent || '⏳ Thinking...',
      key: streamKey,
    })

    console.log(`[DingTalk] Created streaming card ${outTrackId} in space ${openSpaceId}`)

    let lastUpdateTime = 0

    const handle: StreamingHandle = {
      update: async (content: string) => {
        const now = Date.now()
        if (now - lastUpdateTime < STREAM_THROTTLE_MS) return
        lastUpdateTime = now
        await this.api.streamingUpdate({
          outTrackId,
          guid: this._nextGuid(),
          key: streamKey,
          content,
          isFull: true,
          isFinalize: false,
        })
      },
      finish: async (finalContent: string) => {
        await this.api.streamingUpdate({
          outTrackId,
          guid: this._nextGuid(),
          key: streamKey,
          content: finalContent,
          isFull: true,
          isFinalize: true,
        })
        console.log(`[DingTalk] Finalized streaming card ${outTrackId}`)
      },
    }

    return handle
  }
}

export function createDingTalkService(
  instance: PluginInstance,
  notify: (event: PluginEvent) => void
): MessagingPluginService {
  return new DingTalkService(instance, notify)
}
