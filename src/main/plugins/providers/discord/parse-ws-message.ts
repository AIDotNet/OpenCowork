import type { PluginIncomingMessageData } from '../../plugin-types'

/**
 * Parse a Discord WebSocket message frame into normalized data.
 * Supports Discord Gateway MESSAGE_CREATE event and simple JSON envelope.
 */
export function parseDiscordWsMessage(raw: string): PluginIncomingMessageData | null {
  try {
    const data = JSON.parse(raw)

    // Discord Gateway MESSAGE_CREATE event (from relay)
    if (data.t === 'MESSAGE_CREATE' && data.d) {
      const msg = data.d
      return {
        chatId: msg.channel_id ?? '',
        senderId: msg.author?.id ?? '',
        senderName: msg.author?.username ?? '',
        content: msg.content ?? '',
        messageId: msg.id ?? '',
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
