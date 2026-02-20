import type { PluginIncomingMessageData } from '../../plugin-types'

/**
 * Parse a WeCom (企业微信) WebSocket message frame into normalized data.
 * Supports WeCom callback event format and simple JSON envelope.
 */
export function parseWeComWsMessage(raw: string): PluginIncomingMessageData | null {
  try {
    const data = JSON.parse(raw)

    // WeCom callback event format (from relay)
    if (data.MsgType === 'text' && data.Content) {
      return {
        chatId: data.ChatId ?? data.FromUserName ?? '',
        senderId: data.FromUserName ?? '',
        senderName: data.FromUserName ?? '',
        content: data.Content ?? '',
        messageId: String(data.MsgId ?? ''),
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
