import type {
  ChannelInstance,
  ChannelEvent,
  ChannelIncomingMessageData,
  ChannelMessage,
  ChannelGroup,
  MessagingChannelService
} from '../../channel-types'
import { BasePluginService } from '../../base-plugin-service'
import { WeComApi } from './wecom-api'

export class WeComService extends BasePluginService {
  readonly pluginType = 'wecom-bot'
  private api!: WeComApi
  private readonly groupChats = new Set<string>()

  protected async onStart(): Promise<void> {
    const { corpId, secret, agentId } = this._instance.config
    if (!corpId || !secret || !agentId) {
      throw new Error('Missing required config: Corp ID, Secret, and Agent ID must be provided')
    }
    this.api = new WeComApi(corpId, secret, agentId)
    await this.api.ensureToken()
  }

  protected onIncomingParsed(parsed: ChannelIncomingMessageData): void {
    super.onIncomingParsed(parsed)
    if (parsed.chatType === 'group') {
      this.groupChats.add(parsed.chatId)
    }
  }

  async sendMessage(chatId: string, content: string): Promise<{ messageId: string }> {
    return this.api.sendMessage(chatId, content, this.groupChats.has(chatId))
  }

  async replyMessage(messageId: string, content: string): Promise<{ messageId: string }> {
    const chatId = this.replyContext.getChatId(messageId)
    if (!chatId) {
      throw new Error('WeCom reply context not found for messageId')
    }
    return this.api.sendMessage(chatId, content, this.groupChats.has(chatId))
  }

  async getGroupMessages(_chatId: string, _count?: number): Promise<ChannelMessage[]> {
    return []
  }

  async listGroups(): Promise<ChannelGroup[]> {
    return []
  }
}

export function createWeComService(
  instance: ChannelInstance,
  notify: (event: ChannelEvent) => void
): MessagingChannelService {
  return new WeComService(instance, notify)
}
