import type { PluginIncomingMessageData } from '../../plugin-types'

/**
 * Parse a DingTalk WebSocket message frame into normalized data.
 * Supports DingTalk Stream mode callback format and simple JSON envelope.
 */
export function parseDingTalkWsMessage(raw: string): PluginIncomingMessageData | null {
  try {
    const data = JSON.parse(raw)

    // DingTalk Stream mode format
    if (data.headers?.topic === '/v1.0/im/bot/messages/get' && data.data) {
      const payload = typeof data.data === 'string' ? JSON.parse(data.data) : data.data
      let content = ''
      try {
        const parsed = JSON.parse(payload.text?.content ?? '{}')
        content = parsed.content ?? payload.text?.content ?? ''
      } catch {
        content = payload.text?.content ?? ''
      }

      return {
        chatId: payload.conversationId ?? '',
        senderId: payload.senderStaffId ?? payload.senderId ?? '',
        senderName: payload.senderNick ?? '',
        content,
        messageId: payload.msgId ?? '',
      }
    }

    // Simple JSON envelope format (for WS relay servers)
    if (data.chatId && data.content) {
      return {
        chatId: data.chatId,
        senderId: data.senderId ?? '',
        senderName: data.senderName ?? '',
        content: data.content,
        messageId: data.messageId ?? '',
      }
    }

    return null
  } catch {
    return null
  }
}
