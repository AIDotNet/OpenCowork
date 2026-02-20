import type { PluginIncomingMessageData } from '../../plugin-types'

/**
 * Parse a Feishu WebSocket message frame into normalized data.
 * Supports both Feishu event subscription format (im.message.receive_v1)
 * and a simple JSON envelope format from WS relay servers.
 */
export function parseFeishuWsMessage(raw: string): PluginIncomingMessageData | null {
  try {
    const data = JSON.parse(raw)

    // Feishu event subscription format
    if (data.header?.event_type === 'im.message.receive_v1' && data.event) {
      const event = data.event
      const message = event.message
      const sender = event.sender

      let content = ''
      try {
        const parsed = JSON.parse(message?.content ?? '{}')
        content = parsed.text ?? message?.content ?? ''
      } catch {
        content = message?.content ?? ''
      }

      // Feishu create_time is in seconds, convert to milliseconds
      const timestamp = message?.create_time ? parseInt(message.create_time, 10) * 1000 : Date.now()

      return {
        chatId: message?.chat_id ?? '',
        senderId: sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? '',
        senderName: sender?.sender_id?.open_id ?? '',
        content,
        messageId: message?.message_id ?? '',
        timestamp,
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
        timestamp: data.timestamp ?? Date.now(),
      }
    }

    return null
  } catch {
    return null
  }
}
