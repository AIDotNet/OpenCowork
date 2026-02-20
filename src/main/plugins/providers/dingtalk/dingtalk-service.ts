import type {
  PluginInstance,
  PluginEvent,
  PluginMessage,
  PluginGroup,
  MessagingPluginService,
} from '../../plugin-types'
import { BasePluginService } from '../../base-plugin-service'
import { DingTalkApi } from './dingtalk-api'

export class DingTalkService extends BasePluginService {
  readonly pluginType = 'dingtalk-bot'
  private api!: DingTalkApi

  /** DingTalk stream API: obtain dynamic WS URL via gateway connection */
  protected async resolveWsUrl(): Promise<string | null> {
    try {
      const { appKey, appSecret } = this._instance.config
      const res = await fetch('https://api.dingtalk.com/v1.0/gateway/connections/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: appKey, clientSecret: appSecret }),
      })
      const data = (await res.json()) as { endpoint?: string; ticket?: string }
      if (data.endpoint && data.ticket) {
        return `${data.endpoint}?ticket=${data.ticket}`
      }
      console.warn('[DingTalk] Gateway did not return WS endpoint:', data)
      return null
    } catch (err) {
      console.error('[DingTalk] Failed to obtain WS URL:', err)
      return null
    }
  }

  protected async onStart(): Promise<void> {
    const { appKey, appSecret } = this._instance.config
    if (!appKey || !appSecret) {
      throw new Error('Missing required config: App Key and App Secret must be provided')
    }
    this.api = new DingTalkApi(appKey, appSecret)
    await this.api.ensureToken()
  }

  async sendMessage(chatId: string, content: string): Promise<{ messageId: string }> {
    return this.api.sendMessage(chatId, content)
  }

  async replyMessage(messageId: string, content: string): Promise<{ messageId: string }> {
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
}

export function createDingTalkService(
  instance: PluginInstance,
  notify: (event: PluginEvent) => void
): MessagingPluginService {
  return new DingTalkService(instance, notify)
}
