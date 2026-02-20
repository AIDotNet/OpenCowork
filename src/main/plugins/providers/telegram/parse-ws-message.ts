import type { PluginIncomingMessageData } from '../../plugin-types'

/**
 * Parse a Telegram WebSocket message frame into normalized data.
 * Supports Telegram Bot API update format and simple JSON envelope.
 */
export function parseTelegramWsMessage(raw: string): PluginIncomingMessageData | null {
  try {
    const data = JSON.parse(raw)

    // Telegram Bot API update format (from relay)
    if (data.message) {
      const msg = data.message
      return {
        chatId: String(msg.chat?.id ?? ''),
        senderId: String(msg.from?.id ?? ''),
        senderName: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || '',
        content: msg.text ?? '',
        messageId: String(msg.message_id ?? ''),
      }
    }

    // Simple JSON envelope format
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
