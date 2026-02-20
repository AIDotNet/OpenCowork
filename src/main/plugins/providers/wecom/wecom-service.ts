import type {
  PluginInstance,
  PluginEvent,
  PluginMessage,
  PluginGroup,
  MessagingPluginService,
} from '../../plugin-types'
import { BasePluginService } from '../../base-plugin-service'
import { WeComApi } from './wecom-api'

export class WeComService extends BasePluginService {
  readonly pluginType = 'wecom-bot'
  private api!: WeComApi

  protected async onStart(): Promise<void> {
    const { corpId, secret, agentId } = this._instance.config
    if (!corpId || !secret || !agentId) {
      throw new Error('Missing required config: Corp ID, Secret, and Agent ID must be provided')
    }
    this.api = new WeComApi(corpId, secret, agentId)
    await this.api.ensureToken()
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

export function createWeComService(
  instance: PluginInstance,
  notify: (event: PluginEvent) => void
): MessagingPluginService {
  return new WeComService(instance, notify)
}
