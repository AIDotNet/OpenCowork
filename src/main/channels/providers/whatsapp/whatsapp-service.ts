import type {
  ChannelInstance,
  ChannelEvent,
  ChannelMessage,
  ChannelGroup,
  MessagingChannelService
} from '../../channel-types'
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

  async replyMessage(messageId: string, content: string): Promise<{ messageId: string }> {
    const to = this.replyContext.getChatId(messageId)
    if (!to) {
      throw new Error('WhatsApp reply context not found for messageId')
    }
    return this.api.replyMessage(to, messageId, content)
  }

  async getGroupMessages(_chatId: string, _count?: number): Promise<ChannelMessage[]> {
    return []
  }

  async listGroups(): Promise<ChannelGroup[]> {
    return []
  }
}

export function createWhatsAppService(
  instance: ChannelInstance,
  notify: (event: ChannelEvent) => void
): MessagingChannelService {
  return new WhatsAppService(instance, notify)
}
