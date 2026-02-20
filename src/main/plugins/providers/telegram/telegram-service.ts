import type {
  PluginInstance,
  PluginEvent,
  PluginMessage,
  PluginGroup,
  MessagingPluginService,
} from '../../plugin-types'
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

  async replyMessage(_messageId: string, content: string): Promise<{ messageId: string }> {
    // Telegram reply requires chatId — for now send without reply context
    // In practice, the auto-reply pipeline provides chatId
    return this.api.sendMessage('', content)
  }

  async getGroupMessages(_chatId: string, _count?: number): Promise<PluginMessage[]> {
    // Telegram Bot API doesn't support fetching message history
    return []
  }

  async listGroups(): Promise<PluginGroup[]> {
    // Telegram Bot API doesn't support listing groups
    return []
  }
}

export function createTelegramService(
  instance: PluginInstance,
  notify: (event: PluginEvent) => void
): MessagingPluginService {
  return new TelegramService(instance, notify)
}
