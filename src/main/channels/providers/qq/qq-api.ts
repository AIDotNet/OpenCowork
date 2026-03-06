export type QQChatTargetType = 'c2c' | 'group' | 'channel'

export interface QQChatTarget {
  type: QQChatTargetType
  id: string
}

interface QQAccessTokenResponse {
  access_token?: string
  expires_in?: number
  message?: string
}

interface QQGatewayResponse {
  url?: string
}

interface QQMessageResponse {
  id?: string
  timestamp?: number | string
  message?: string
}

const PROD_API_BASE = 'https://api.sgroup.qq.com'
const SANDBOX_API_BASE = 'https://sandbox.api.sgroup.qq.com'
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'

interface QQApiOptions {
  useSandbox?: boolean
  markdownSupport?: boolean
}

export function parseQQChatId(chatId: string): QQChatTarget {
  const normalized = chatId.replace(/^qqbot:/i, '').trim()

  if (normalized.startsWith('c2c:')) {
    const id = normalized.slice(4).trim()
    if (!id) throw new Error(`Invalid QQ C2C chat ID: ${chatId}`)
    return { type: 'c2c', id }
  }

  if (normalized.startsWith('group:')) {
    const id = normalized.slice(6).trim()
    if (!id) throw new Error(`Invalid QQ group chat ID: ${chatId}`)
    return { type: 'group', id }
  }

  if (normalized.startsWith('channel:')) {
    const id = normalized.slice(8).trim()
    if (!id) throw new Error(`Invalid QQ channel chat ID: ${chatId}`)
    return { type: 'channel', id }
  }

  if (/^[0-9a-fA-F]{32}$/.test(normalized)) {
    return { type: 'c2c', id: normalized }
  }

  if (
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(normalized)
  ) {
    return { type: 'c2c', id: normalized }
  }

  throw new Error(`Unsupported QQ chat ID format: ${chatId}`)
}

export class QQApi {
  private cachedToken: { token: string; expiresAt: number } | null = null
  private readonly seqBaseTime = Math.floor(Date.now() / 1000) % 100000000
  private readonly msgSeqTracker = new Map<string, number>()
  private readonly apiBase: string
  private readonly markdownSupport: boolean

  constructor(
    private readonly appId: string,
    private readonly clientSecret: string,
    options: QQApiOptions = {}
  ) {
    this.apiBase = options.useSandbox ? SANDBOX_API_BASE : PROD_API_BASE
    this.markdownSupport = options.markdownSupport === true
  }

  async validate(): Promise<void> {
    await this.getGatewayAccessToken()
    await this.getGatewayUrl()
  }

  async getGatewayAccessToken(): Promise<string> {
    return this.getAccessToken()
  }

  clearTokenCache(): void {
    this.cachedToken = null
  }

  async getGatewayUrl(): Promise<string> {
    const data = await this.apiRequest<QQGatewayResponse>('GET', '/gateway')
    if (!data.url) {
      throw new Error(`Failed to get QQ gateway URL: ${JSON.stringify(data)}`)
    }
    return data.url
  }

  async sendMessage(
    target: QQChatTarget,
    content: string,
    replyToMessageId?: string
  ): Promise<{ messageId: string }> {
    switch (target.type) {
      case 'c2c':
        return this.sendC2CMessage(target.id, content, replyToMessageId)
      case 'group':
        return this.sendGroupMessage(target.id, content, replyToMessageId)
      case 'channel':
        return this.sendChannelMessage(target.id, content, replyToMessageId)
      default:
        throw new Error(`Unsupported QQ target type: ${target.type}`)
    }
  }

  async sendC2CMessage(
    openId: string,
    content: string,
    replyToMessageId?: string
  ): Promise<{ messageId: string }> {
    const data = await this.apiRequest<QQMessageResponse>(
      'POST',
      `/v2/users/${encodeURIComponent(openId)}/messages`,
      this.buildDirectMessageBody(content, replyToMessageId)
    )
    return { messageId: String(data.id ?? '') }
  }

  async sendGroupMessage(
    groupOpenId: string,
    content: string,
    replyToMessageId?: string
  ): Promise<{ messageId: string }> {
    const data = await this.apiRequest<QQMessageResponse>(
      'POST',
      `/v2/groups/${encodeURIComponent(groupOpenId)}/messages`,
      this.buildDirectMessageBody(content, replyToMessageId)
    )
    return { messageId: String(data.id ?? '') }
  }

  async sendChannelMessage(
    channelId: string,
    content: string,
    replyToMessageId?: string
  ): Promise<{ messageId: string }> {
    if (!content.trim()) {
      throw new Error('QQ channel message content cannot be empty')
    }

    const body: Record<string, unknown> = { content }
    if (replyToMessageId) {
      body.msg_id = replyToMessageId
    }

    const data = await this.apiRequest<QQMessageResponse>(
      'POST',
      `/channels/${encodeURIComponent(channelId)}/messages`,
      body
    )
    return { messageId: String(data.id ?? '') }
  }

  private buildDirectMessageBody(
    content: string,
    replyToMessageId?: string
  ): Record<string, unknown> {
    const trimmed = content.trim()
    if (!trimmed) {
      throw new Error('QQ message content cannot be empty')
    }

    const body: Record<string, unknown> = this.markdownSupport
      ? {
          markdown: { content: trimmed },
          msg_type: 2
        }
      : {
          content: trimmed,
          msg_type: 0
        }

    body.msg_seq = replyToMessageId ? this.getNextMsgSeq(replyToMessageId) : 1

    if (replyToMessageId) {
      body.msg_id = replyToMessageId
    }

    return body
  }

  private getNextMsgSeq(messageId: string): number {
    const current = this.msgSeqTracker.get(messageId) ?? 0
    const next = current + 1
    this.msgSeqTracker.set(messageId, next)

    if (this.msgSeqTracker.size > 1000) {
      const keys = Array.from(this.msgSeqTracker.keys())
      for (let index = 0; index < 500; index++) {
        const key = keys[index]
        if (key) this.msgSeqTracker.delete(key)
      }
    }

    return this.seqBaseTime + next
  }

  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - 5 * 60 * 1000) {
      return this.cachedToken.token
    }

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.clientSecret })
    })

    const rawText = await response.text()
    const data = this.parseJson<QQAccessTokenResponse>(rawText)

    if (!response.ok) {
      throw new Error(
        `QQ auth failed (${response.status}): ${data.message ?? rawText.slice(0, 300)}`
      )
    }

    if (!data.access_token) {
      throw new Error(`Failed to get QQ access token: ${rawText.slice(0, 300)}`)
    }

    this.cachedToken = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000
    }

    return data.access_token
  }

  private async apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getAccessToken()
    const response = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `QQBot ${token}`,
        'Content-Type': 'application/json'
      },
      body: body == null ? undefined : JSON.stringify(body)
    })

    const rawText = await response.text()
    const data = this.parseJson<T & { message?: string }>(rawText)

    if (!response.ok) {
      throw new Error(
        `QQ API request failed (${response.status}) ${path}: ${data.message ?? rawText.slice(0, 300)}`
      )
    }

    return data
  }

  private parseJson<T>(rawText: string): T {
    try {
      return JSON.parse(rawText) as T
    } catch {
      throw new Error(`Failed to parse QQ API response: ${rawText.slice(0, 300)}`)
    }
  }
}
