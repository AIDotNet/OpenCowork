import type {
  ChannelEvent,
  ChannelGroup,
  ChannelIncomingMessageData,
  ChannelInstance,
  ChannelMessage,
  MessagingChannelService
} from '../../channel-types'
import { BasePluginService } from '../../base-plugin-service'
import {
  WeixinApi,
  type WeixinInboundMessage,
  type WeixinMessageItem,
  type WeixinImageItem,
  DEFAULT_WEIXIN_BASE_URL
} from './weixin-api'

const USER_MESSAGE_TYPE = 1
const TEXT_ITEM = 1
const IMAGE_ITEM = 2
const VOICE_ITEM = 3
const FILE_ITEM = 4
const VIDEO_ITEM = 5
const DEFAULT_POLL_DELAY_MS = 35000
/** Min interval between identical session-expiry warnings (avoid log spam on success/failure flaps). */
const SESSION_EXPIRY_LOG_INTERVAL_MS = 5 * 60 * 1000

function extractContent(items?: WeixinMessageItem[]): {
  content: string
  msgType: string
  imageItem?: WeixinImageItem
} {
  if (!items?.length) {
    return { content: '', msgType: 'text' }
  }

  for (const item of items) {
    if (item.type === TEXT_ITEM && item.text_item?.text) {
      return { content: item.text_item.text, msgType: 'text' }
    }
    if (item.type === VOICE_ITEM && item.voice_item?.text) {
      return { content: item.voice_item.text, msgType: 'voice' }
    }
    if (item.type === IMAGE_ITEM) {
      return {
        content: '[User sent an image]',
        msgType: 'image',
        imageItem: item.image_item
      }
    }
    if (item.type === FILE_ITEM) {
      return {
        content: `[文件${item.file_item?.file_name ? `: ${item.file_item.file_name}` : ''}]`,
        msgType: 'file'
      }
    }
    if (item.type === VIDEO_ITEM) {
      return { content: '[视频]', msgType: 'video' }
    }
  }

  return { content: '', msgType: 'unknown' }
}

export class WeixinService extends BasePluginService {
  readonly pluginType = 'weixin-official'

  private api!: WeixinApi
  private polling = false
  private pollPromise: Promise<void> | null = null
  private pollDelayMs = DEFAULT_POLL_DELAY_MS
  private syncBuf = ''
  private pollAbortController: AbortController | null = null
  private contextTokens = new Map<string, string>()
  private messageReplyMeta = new Map<string, { userId: string; contextToken: string }>()
  private hadPollingIssue = false
  /** Consecutive recoverable session timeouts — used for exponential backoff */
  private sessionTimeoutStreak = 0
  private lastSessionExpiryLogAt = 0

  protected async resolveWsUrl(): Promise<string | null> {
    return null
  }

  protected async onStart(): Promise<void> {
    const { token, baseUrl, accountId, routeTag } = this._instance.config
    if (!token || !accountId) {
      throw new Error('Missing required config: token and accountId must be provided')
    }

    this.api = new WeixinApi(baseUrl || DEFAULT_WEIXIN_BASE_URL, token, routeTag || undefined)
    this.polling = true
    this.pollPromise = this.runPollingLoop(accountId)
  }

  protected async onStop(): Promise<void> {
    this.polling = false
    this.pollAbortController?.abort()
    this.pollAbortController = null
    await this.pollPromise?.catch(() => undefined)
    this.pollPromise = null
  }

  private getContextTokenForChat(chatId: string): string {
    const accountId = this._instance.config.accountId || ''
    const contextToken = this.contextTokens.get(`${accountId}:${chatId}`)
    if (!contextToken) {
      throw new Error(
        'Missing context token for this Weixin chat. Send can only reply to existing conversations.'
      )
    }
    return contextToken
  }

  async sendMessage(chatId: string, content: string): Promise<{ messageId: string }> {
    return this.api.sendMessage({
      toUserId: chatId,
      text: content,
      contextToken: this.getContextTokenForChat(chatId)
    })
  }

  async sendImage(chatId: string, buffer: Buffer, text?: string): Promise<{ messageId: string }> {
    return this.api.sendImage({
      toUserId: chatId,
      buffer,
      text,
      contextToken: this.getContextTokenForChat(chatId)
    })
  }

  async sendFile(
    chatId: string,
    buffer: Buffer,
    fileName: string,
    text?: string
  ): Promise<{ messageId: string }> {
    return this.api.sendFile({
      toUserId: chatId,
      buffer,
      fileName,
      text,
      contextToken: this.getContextTokenForChat(chatId)
    })
  }

  async replyMessage(messageId: string, content: string): Promise<{ messageId: string }> {
    const meta = this.messageReplyMeta.get(messageId)
    if (!meta) {
      throw new Error('Weixin reply context not found for messageId')
    }
    return this.api.sendMessage({
      toUserId: meta.userId,
      text: content,
      contextToken: meta.contextToken
    })
  }

  async getGroupMessages(chatId: string, count?: number): Promise<ChannelMessage[]> {
    void chatId
    void count
    return []
  }

  async listGroups(): Promise<ChannelGroup[]> {
    return []
  }

  private resetPollingCursor(): void {
    this.syncBuf = ''
    this.pollDelayMs = DEFAULT_POLL_DELAY_MS
  }

  private getRecoverablePollingIssue(error: unknown): 'request_timeout' | 'session_timeout' | null {
    if (error instanceof Error && error.name === 'AbortError') {
      return 'request_timeout'
    }

    const message = error instanceof Error ? error.message : String(error)
    if (
      /session timeout|session expired|invalid session|invalid get_updates_buf|get_updates_buf/i.test(
        message
      )
    ) {
      return 'session_timeout'
    }

    return null
  }

  private async runPollingLoop(accountId: string): Promise<void> {
    while (this.polling) {
      try {
        this.pollAbortController = new AbortController()
        const response = await this.api.getUpdates(
          this.syncBuf,
          this.pollDelayMs + 5000,
          this.pollAbortController.signal
        )

        if (typeof response.get_updates_buf === 'string') {
          this.syncBuf = response.get_updates_buf
        }
        if (
          typeof response.longpolling_timeout_ms === 'number' &&
          response.longpolling_timeout_ms > 0
        ) {
          this.pollDelayMs = response.longpolling_timeout_ms
        }

        if ((response.ret ?? 0) !== 0 || response.errcode) {
          throw new Error(
            response.errmsg || `Weixin getupdates failed: ${response.errcode ?? response.ret}`
          )
        }

        if (this.hadPollingIssue) {
          this.hadPollingIssue = false
          this.emit({
            type: 'status_change',
            pluginId: this.pluginId,
            pluginType: this.pluginType,
            data: 'running'
          })
        }

        this.sessionTimeoutStreak = 0

        for (const msg of response.msgs || []) {
          void this.handleIncomingMessage(accountId, msg)
        }
      } catch (error) {
        if (!this.polling) {
          break
        }

        const recoverableIssue = this.getRecoverablePollingIssue(error)
        this.hadPollingIssue = true

        if (recoverableIssue === 'session_timeout') {
          this.sessionTimeoutStreak += 1
          this.resetPollingCursor()
          const now = Date.now()
          const shouldLogExpiry =
            this.lastSessionExpiryLogAt === 0 ||
            now - this.lastSessionExpiryLogAt >= SESSION_EXPIRY_LOG_INTERVAL_MS
          if (shouldLogExpiry) {
            console.warn(
              `[Weixin:${this.pluginId}] Poll session expired, resetting sync state` +
                (this.sessionTimeoutStreak > 1
                  ? ` (failures in a row: ${this.sessionTimeoutStreak}; next backoff ≤120s)`
                  : '')
            )
            this.lastSessionExpiryLogAt = now
          }
        } else if (recoverableIssue === 'request_timeout') {
          console.warn(`[Weixin:${this.pluginId}] Poll request timed out, retrying`)
        } else {
          this.emit({
            type: 'error',
            pluginId: this.pluginId,
            pluginType: this.pluginType,
            data: error instanceof Error ? error.message : String(error)
          })
        }

        const delayMs =
          recoverableIssue === 'session_timeout'
            ? Math.min(120_000, 1000 * Math.pow(2, Math.min(this.sessionTimeoutStreak - 1, 16)))
            : recoverableIssue
              ? 2000
              : 3000
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      } finally {
        this.pollAbortController = null
      }
    }
  }

  private async handleIncomingMessage(accountId: string, msg: WeixinInboundMessage): Promise<void> {
    if (msg.message_type !== USER_MESSAGE_TYPE) {
      return
    }

    const userId = msg.from_user_id || ''
    if (!userId) {
      return
    }

    const { content, msgType, imageItem } = extractContent(msg.item_list)
    if (!content && msgType !== 'image') {
      return
    }

    const timestamp = msg.create_time_ms || Date.now()
    if (timestamp < Date.now() - 15 * 60 * 1000) {
      return
    }

    const messageId = String(msg.message_id ?? msg.client_id ?? `${timestamp}-${userId}`)
    const contextToken = msg.context_token || ''
    if (contextToken) {
      const ctxKey = `${accountId}:${userId}`
      this.contextTokens.set(ctxKey, contextToken)
      if (this.contextTokens.size > 500) {
        const oldest = this.contextTokens.keys().next().value
        if (oldest) {
          this.contextTokens.delete(oldest)
        }
      }
      this.messageReplyMeta.set(messageId, { userId, contextToken })
      if (this.messageReplyMeta.size > 500) {
        const oldest = this.messageReplyMeta.keys().next().value
        if (oldest) {
          this.messageReplyMeta.delete(oldest)
        }
      }
    }

    let images: ChannelIncomingMessageData['images']
    let effectiveContent = content

    if (msgType === 'image' && imageItem) {
      try {
        const download = await this.api.downloadInboundImage({
          messageId: msg.message_id ?? msg.client_id ?? messageId,
          fileId: imageItem.file_id,
          aesKey: imageItem.aes_key,
          rawAesKeyHex: imageItem.aeskey,
          md5sum: imageItem.md5sum,
          fileName: imageItem.file_name,
          media: imageItem.media,
          thumbMedia: imageItem.thumb_media
        })
        if (download.buffer.byteLength > 0) {
          images = [
            {
              base64: download.buffer.toString('base64'),
              mediaType: download.mediaType || 'image/png'
            }
          ]
        }
      } catch (error) {
        console.warn('[Weixin] Failed to download inbound image:', error)
        effectiveContent = `[User sent an image but download failed: ${imageItem.file_id || imageItem.media?.encrypt_query_param || 'unknown'}]`
      }
    }

    const parsed: ChannelIncomingMessageData = {
      chatId: userId,
      senderId: userId,
      senderName: userId,
      content: effectiveContent,
      messageId,
      timestamp,
      images,
      msgType,
      chatType: 'p2p',
      chatName: userId
    }

    this.emit({
      type: 'incoming_message',
      pluginId: this.pluginId,
      pluginType: this.pluginType,
      data: parsed
    })
  }
}

export function createWeixinService(
  instance: ChannelInstance,
  notify: (event: ChannelEvent) => void
): MessagingChannelService {
  return new WeixinService(instance, notify)
}
