import type {
  ChannelInstance,
  ChannelEvent,
  ChannelMessage,
  ChannelGroup,
  MessagingChannelService
} from '../../channel-types'
import { BasePluginService } from '../../base-plugin-service'
import { TelegramApi } from './telegram-api'

export class TelegramService extends BasePluginService {
  readonly pluginType = 'telegram-bot'
  private api!: TelegramApi

  protected async onStart(): Promise<void> {
    const { botToken } = this._instance.config
    if (!botToken) {
      throw new Error('Missing required config: Bot Token must be provided')
    }
    this.api = new TelegramApi(botToken)
    await this.api.validate()
  }

  async sendMessage(chatId: string, content: string): Promise<{ messageId: string }> {
    return this.api.sendMessage(chatId, content)
  }

  async replyMessage(messageId: string, content: string): Promise<{ messageId: string }> {
    const chatId = this.replyContext.getChatId(messageId)
    if (!chatId) {
      throw new Error('Telegram reply context not found for messageId')
    }
    return this.api.replyMessage(messageId, chatId, content)
  }

  async getGroupMessages(_chatId: string, _count?: number): Promise<ChannelMessage[]> {
    // Telegram Bot API doesn't support fetching message history
    return []
  }

  async listGroups(): Promise<ChannelGroup[]> {
    // Telegram Bot API doesn't support listing groups
    return []
  }
}

export function createTelegramService(
  instance: ChannelInstance,
  notify: (event: ChannelEvent) => void
): MessagingChannelService {
  return new TelegramService(instance, notify)
}
