import type {
  PluginInstance,
  PluginEvent,
  PluginMessage,
  PluginGroup,
  MessagingPluginService,
} from '../../plugin-types'
import { BasePluginService } from '../../base-plugin-service'
import { WhatsAppApi } from './whatsapp-api'

export class WhatsAppService extends BasePluginService {
  readonly pluginType = 'whatsapp-bot'
  private api!: WhatsAppApi

  protected async onStart(): Promise<void> {
    const { phoneNumberId, accessToken } = this._instance.config
    if (!phoneNumberId || !accessToken) {
      throw new Error('Missing required config: Phone Number ID and Access Token must be provided')
    }
    this.api = new WhatsAppApi(phoneNumberId, accessToken)
    await this.api.validate()
  }

  async sendMessage(chatId: string, content: string): Promise<{ messageId: string }> {
    return this.api.sendMessage(chatId, content)
  }

  async replyMessage(_messageId: string, content: string): Promise<{ messageId: string }> {
    return this.api.sendMessage('', content)
  }

  async getGroupMessages(_chatId: string, _count?: number): Promise<PluginMessage[]> {
    return []
  }

  async listGroups(): Promise<PluginGroup[]> {
    return []
  }
}

export function createWhatsAppService(
  instance: PluginInstance,
  notify: (event: PluginEvent) => void
): MessagingPluginService {
  return new WhatsAppService(instance, notify)
}
