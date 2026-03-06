import type { ChannelIncomingMessageData } from '../../channel-types'

interface QQGatewayPayload {
  op?: number
  d?: unknown
  s?: number
  t?: string
}

const QQ_REPLY_REF_PREFIX = 'qqref:'

export function encodeQQReplyReference(chatId: string, messageId: string): string {
  const payload = JSON.stringify({ chatId, messageId })
  return `${QQ_REPLY_REF_PREFIX}${Buffer.from(payload, 'utf8').toString('base64url')}`
}

export function decodeQQReplyReference(
  encoded: string
): { chatId: string; messageId: string } | null {
  if (!encoded.startsWith(QQ_REPLY_REF_PREFIX)) return null

  try {
    const raw = Buffer.from(encoded.slice(QQ_REPLY_REF_PREFIX.length), 'base64url').toString('utf8')
    const data = JSON.parse(raw) as { chatId?: string; messageId?: string }
    if (!data.chatId || !data.messageId) return null
    return { chatId: data.chatId, messageId: data.messageId }
  } catch {
    return null
  }
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value === 'number') {
    return value > 1_000_000_000_000 ? value : value * 1000
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed

    const asNumber = Number(value)
    if (!Number.isNaN(asNumber)) {
      return asNumber > 1_000_000_000_000 ? asNumber : asNumber * 1000
    }
  }

  return Date.now()
}

function describeAttachments(attachments: unknown): string {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return ''
  }

  const first = attachments[0] as { content_type?: string } | undefined
  const contentType = first?.content_type ?? ''

  if (contentType.startsWith('image/')) return '[User sent an image]'
  if (contentType.startsWith('audio/')) return '[User sent an audio message]'
  if (contentType.startsWith('video/')) return '[User sent a video]'
  return '[User sent an attachment]'
}

function stripLeadingMentions(content: string): string {
  return content
    .replace(/^(?:<@!?[^>]+>\s*)+/, '')
    .replace(/^(?:@\S+\s*)+/, '')
    .trim()
}

function normalizeContent(content: unknown, attachments?: unknown): string {
  const text = typeof content === 'string' ? stripLeadingMentions(content) : ''
  if (text) return text
  return describeAttachments(attachments)
}

function buildIncomingMessage(data: ChannelIncomingMessageData): ChannelIncomingMessageData | null {
  if (!data.chatId || !data.messageId) return null
  if (!data.content && !data.images?.length && !data.audio) return null
  return data
}

export function parseQQWsMessage(raw: string): ChannelIncomingMessageData | null {
  try {
    const payload = JSON.parse(raw) as QQGatewayPayload & Record<string, unknown>

    if (payload.op === 0 && typeof payload.t === 'string') {
      const event = (payload.d ?? {}) as Record<string, unknown>

      if (payload.t === 'C2C_MESSAGE_CREATE') {
        const author = (event.author ?? {}) as Record<string, unknown>
        const senderId = String(author.user_openid ?? author.id ?? '')
        const chatId = `c2c:${senderId}`
        const rawMessageId = String(event.id ?? '')
        return buildIncomingMessage({
          chatId,
          senderId,
          senderName: senderId,
          content: normalizeContent(event.content, event.attachments),
          messageId: encodeQQReplyReference(chatId, rawMessageId),
          timestamp: normalizeTimestamp(event.timestamp),
          chatType: 'p2p',
          chatName: senderId
        })
      }

      if (payload.t === 'GROUP_AT_MESSAGE_CREATE') {
        const author = (event.author ?? {}) as Record<string, unknown>
        const senderId = String(author.member_openid ?? author.id ?? '')
        const groupOpenId = String(event.group_openid ?? event.group_id ?? '')
        const chatId = `group:${groupOpenId}`
        const rawMessageId = String(event.id ?? '')
        return buildIncomingMessage({
          chatId,
          senderId,
          senderName: senderId,
          content: normalizeContent(event.content, event.attachments),
          messageId: encodeQQReplyReference(chatId, rawMessageId),
          timestamp: normalizeTimestamp(event.timestamp),
          chatType: 'group',
          chatName: groupOpenId
        })
      }

      if (payload.t === 'AT_MESSAGE_CREATE') {
        const author = (event.author ?? {}) as Record<string, unknown>
        if (author.bot === true) return null

        const member = (event.member ?? {}) as Record<string, unknown>
        const senderName = String(member.nick ?? author.username ?? author.id ?? '')
        const channelId = String(event.channel_id ?? '')
        const guildId = String(event.guild_id ?? '')
        const chatId = `channel:${channelId}`
        const rawMessageId = String(event.id ?? '')
        return buildIncomingMessage({
          chatId,
          senderId: String(author.id ?? ''),
          senderName,
          content: normalizeContent(event.content, event.attachments),
          messageId: encodeQQReplyReference(chatId, rawMessageId),
          timestamp: normalizeTimestamp(event.timestamp),
          chatType: 'group',
          chatName: guildId || channelId
        })
      }

      if (payload.t === 'DIRECT_MESSAGE_CREATE') {
        const author = (event.author ?? {}) as Record<string, unknown>
        if (author.bot === true) return null

        const channelId = String(event.channel_id ?? '')
        const guildId = String(event.guild_id ?? '')
        const rawMessageId = String(event.id ?? '')
        const chatId = channelId ? `channel:${channelId}` : `c2c:${String(author.id ?? '')}`
        return buildIncomingMessage({
          chatId,
          senderId: String(author.id ?? ''),
          senderName: String(author.username ?? author.id ?? ''),
          content: normalizeContent(event.content, event.attachments),
          messageId: encodeQQReplyReference(chatId, rawMessageId),
          timestamp: normalizeTimestamp(event.timestamp),
          chatType: 'p2p',
          chatName: String(author.username ?? guildId ?? channelId ?? '')
        })
      }

      return null
    }

    if (typeof payload.chatId === 'string' && typeof payload.content === 'string') {
      return buildIncomingMessage({
        chatId: payload.chatId,
        senderId: typeof payload.senderId === 'string' ? payload.senderId : '',
        senderName: typeof payload.senderName === 'string' ? payload.senderName : '',
        content: payload.content,
        messageId:
          typeof payload.messageId === 'string' && payload.messageId
            ? payload.messageId
            : encodeQQReplyReference(payload.chatId, String(Date.now())),
        timestamp: normalizeTimestamp(payload.timestamp),
        chatType: payload.chatType === 'group' ? 'group' : 'p2p',
        chatName: typeof payload.chatName === 'string' ? payload.chatName : undefined
      })
    }

    return null
  } catch {
    return null
  }
}
