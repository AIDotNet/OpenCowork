import type {
  ChannelInstance,
  ChannelEvent,
  ChannelMessage,
  ChannelGroup,
  MessagingChannelService
} from '../../channel-types'
import { BasePluginService } from '../../base-plugin-service'
import { DiscordApi } from './discord-api'

export class DiscordService extends BasePluginService {
  readonly pluginType = 'discord-bot'
  private api!: DiscordApi

  /** Discord Gateway WebSocket endpoint */
  protected async resolveWsUrl(): Promise<string | null> {
    return 'wss://gateway.discord.gg/?v=10&encoding=json'
  }

  protected async onStart(): Promise<void> {
    const { botToken } = this._instance.config
    if (!botToken) {
      throw new Error('Missing required config: Bot Token must be provided')
    }
    this.api = new DiscordApi(botToken)
    await this.api.validate()
  }

  async sendMessage(chatId: string, content: string): Promise<{ messageId: string }> {
    return this.api.sendMessage(chatId, content)
  }

  async replyMessage(messageId: string, content: string): Promise<{ messageId: string }> {
    const channelId = this.replyContext.getChatId(messageId)
    if (!channelId) {
      throw new Error('Discord reply context not found for messageId')
    }
    return this.api.replyMessage(channelId, messageId, content)
  }

  async getGroupMessages(_chatId: string, _count?: number): Promise<ChannelMessage[]> {
    return []
  }

  async listGroups(): Promise<ChannelGroup[]> {
    return []
  }
}

export function createDiscordService(
  instance: ChannelInstance,
  notify: (event: ChannelEvent) => void
): MessagingChannelService {
  return new DiscordService(instance, notify)
}
