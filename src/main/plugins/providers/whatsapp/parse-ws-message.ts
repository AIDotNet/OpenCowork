import type { PluginIncomingMessageData } from '../../plugin-types'

/**
 * Parse a WhatsApp WebSocket message frame into normalized data.
 * Supports WhatsApp Cloud API webhook format and simple JSON envelope.
 */
export function parseWhatsAppWsMessage(raw: string): PluginIncomingMessageData | null {
  try {
    const data = JSON.parse(raw)

    // WhatsApp Cloud API webhook format (from relay)
    if (data.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
      const change = data.entry[0].changes[0].value
      const msg = change.messages[0]
      const contact = change.contacts?.[0]
      return {
        chatId: msg.from ?? '',
        senderId: msg.from ?? '',
        senderName: contact?.profile?.name ?? '',
        content: msg.text?.body ?? '',
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
