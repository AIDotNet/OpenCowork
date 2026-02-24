import * as https from 'https'

const BASE_URL = 'https://api.dingtalk.com'

interface HttpResponse {
  statusCode: number
  body: string
}

function request(
  method: string,
  urlPath: string,
  headers: Record<string, string>,
  body?: string
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE_URL)
    const bodyBuffer = body ? Buffer.from(body, 'utf-8') : null
    const reqHeaders: Record<string, string> = { ...headers }
    if (bodyBuffer) {
      reqHeaders['Content-Length'] = String(bodyBuffer.byteLength)
      reqHeaders['Content-Type'] = 'application/json; charset=utf-8'
    }

    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method,
        headers: reqHeaders,
      },
      (res) => {
        let responseBody = ''
        res.on('data', (chunk: Buffer) => {
          responseBody += chunk.toString()
        })
        res.on('end', () => {
          resolve({ statusCode: res.statusCode ?? 0, body: responseBody })
        })
      }
    )

    req.on('error', reject)
    req.setTimeout(15000, () => {
      req.destroy()
      reject(new Error('Request timed out (15s)'))
    })

    if (bodyBuffer) req.write(bodyBuffer)
    req.end()
  })
}

// ── DingTalk Server API Client ──

export class DingTalkApi {
  private accessToken = ''
  private tokenExpiresAt = 0

  constructor(
    private appKey: string,
    private appSecret: string
  ) {}

  /** Get or refresh access token */
  async ensureToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken
    }

    const res = await request(
      'POST',
      '/v1.0/oauth2/accessToken',
      {},
      JSON.stringify({ appKey: this.appKey, appSecret: this.appSecret })
    )

    const data = JSON.parse(res.body)
    if (!data.accessToken) {
      throw new Error(`DingTalk auth failed: ${data.message ?? JSON.stringify(data)}`)
    }

    this.accessToken = data.accessToken
    // Token expires in `expireIn` seconds, refresh 60s early
    this.tokenExpiresAt = Date.now() + ((data.expireIn ?? 7200) - 60) * 1000
    return this.accessToken
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.ensureToken()
    return { 'x-acs-dingtalk-access-token': token }
  }

  /** Send a message to a group conversation via robot */
  async sendMessage(
    openConversationId: string,
    content: string
  ): Promise<{ messageId: string }> {
    const headers = await this.authHeaders()
    const body = JSON.stringify({
      msgParam: JSON.stringify({ content }),
      msgKey: 'sampleText',
      openConversationId,
      robotCode: this.appKey,
    })

    const res = await request(
      'POST',
      '/v1.0/robot/groupMessages/send',
      headers,
      body
    )

    const data = JSON.parse(res.body)
    if (data.processQueryKey) {
      return { messageId: data.processQueryKey }
    }
    if (data.code) {
      throw new Error(`DingTalk sendMessage failed: ${data.message ?? data.code}`)
    }
    return { messageId: '' }
  }

  /** Reply to a specific message (uses the same send mechanism with quote) */
  async replyMessage(
    messageId: string,
    content: string,
    openConversationId: string
  ): Promise<{ messageId: string }> {
    // DingTalk doesn't have a direct reply API for robot messages in the same way.
    // We send a message to the same conversation as a workaround.
    // The messageId parameter is kept for interface conformance.
    console.log(`[DingTalkApi] Replying to messageId=${messageId} in conversation`)
    return this.sendMessage(openConversationId, content)
  }

  /** List groups the bot is in */
  async listGroups(): Promise<
    Array<{ openConversationId: string; name: string; memberCount?: number; raw: unknown }>
  > {
    const headers = await this.authHeaders()
    const body = JSON.stringify({
      robotCode: this.appKey,
      statusCode: 0, // 0 = active
      maxResults: 50,
    })

    const res = await request('POST', '/v1.0/robot/groups/lists', headers, body)

    const data = JSON.parse(res.body)
    if (data.code) {
      throw new Error(`DingTalk listGroups failed: ${data.message ?? data.code}`)
    }

    return (data.groups ?? []).map(
      (item: { openConversationId: string; name: string; memberCount?: number }) => ({
        openConversationId: item.openConversationId,
        name: item.name,
        memberCount: item.memberCount,
        raw: item,
      })
    )
  }

  /** Get messages from a conversation — DingTalk uses event subscription/stream for this.
   *  This is a placeholder that returns empty until stream mode is implemented. */
  async getMessages(
    _openConversationId: string,
    _count = 20
  ): Promise<
    Array<{
      messageId: string
      senderId: string
      senderName: string
      content: string
      createTime: number
      raw: unknown
    }>
  > {
    // DingTalk doesn't provide a simple REST API to list historical messages.
    // This requires Event Subscription or Stream mode which will be implemented later.
    console.warn('[DingTalkApi] getMessages: historical message retrieval requires Stream API (not yet implemented)')
    return []
  }

  // ── Card API — Streaming Card Support ──

  /**
   * Create and deliver a card to a chat.
   * Returns the outTrackId used for subsequent streaming updates.
   */
  async createAndDeliverCard(opts: {
    cardTemplateId: string
    outTrackId: string
    openSpaceId: string
    spaceType: 'IM_GROUP' | 'IM_ROBOT'
    initialContent: string
    key: string
  }): Promise<{ outTrackId: string }> {
    const headers = await this.authHeaders()

    const deliverModel = opts.spaceType === 'IM_GROUP'
      ? { imGroupOpenDeliverModel: { robotCode: this.appKey }, imGroupOpenSpaceModel: { supportForward: true } }
      : { imRobotOpenDeliverModel: { spaceType: 'IM_ROBOT' }, imRobotOpenSpaceModel: { supportForward: false } }

    const body = JSON.stringify({
      cardTemplateId: opts.cardTemplateId,
      outTrackId: opts.outTrackId,
      openSpaceId: opts.openSpaceId,
      callbackType: 'STREAM',
      cardData: {
        cardParamMap: { [opts.key]: opts.initialContent },
      },
      ...deliverModel,
    })

    const res = await request('POST', '/v1.0/card/instances/createAndDeliver', headers, body)
    const data = JSON.parse(res.body)
    if (data.success === false || data.errcode) {
      throw new Error(`DingTalk createAndDeliverCard failed: ${data.errmsg ?? data.message ?? JSON.stringify(data)}`)
    }
    return { outTrackId: opts.outTrackId }
  }

  /**
   * Stream update a card's AI content.
   * For markdown content, isFull must be true.
   */
  async streamingUpdate(opts: {
    outTrackId: string
    guid: string
    key: string
    content: string
    isFull: boolean
    isFinalize: boolean
    isError?: boolean
  }): Promise<boolean> {
    const headers = await this.authHeaders()
    const body = JSON.stringify({
      outTrackId: opts.outTrackId,
      guid: opts.guid,
      key: opts.key,
      content: opts.content,
      isFull: opts.isFull,
      isFinalize: opts.isFinalize,
      isError: opts.isError ?? false,
    })

    const res = await request('PUT', '/v1.0/card/streaming', headers, body)
    const data = JSON.parse(res.body)
    if (data.success === false) {
      console.warn(`[DingTalkApi] streamingUpdate failed: ${JSON.stringify(data)}`)
      return false
    }
    return true
  }
}
