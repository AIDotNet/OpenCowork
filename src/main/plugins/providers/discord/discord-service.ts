import type {
  PluginInstance,
  PluginEvent,
  PluginMessage,
  PluginGroup,
  MessagingPluginService,
} from '../../plugin-types'
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

  async replyMessage(_messageId: string, content: string): Promise<{ messageId: string }> {
    // Discord reply requires channelId — stub for now
    return this.api.sendMessage('', content)
  }

  async getGroupMessages(_chatId: string, _count?: number): Promise<PluginMessage[]> {
    return []
  }

  async listGroups(): Promise<PluginGroup[]> {
    return []
  }
}

export function createDiscordService(
  instance: PluginInstance,
  notify: (event: PluginEvent) => void
): MessagingPluginService {
  return new DiscordService(instance, notify)
}
