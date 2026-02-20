import * as https from 'https'

const BASE_URL = 'https://discord.com'

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

export class DiscordApi {
  constructor(private botToken: string) {}

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bot ${this.botToken}` }
  }

  /** Validate the bot token */
  async validate(): Promise<void> {
    const res = await request('GET', '/api/v10/users/@me', this.authHeaders())
    const data = JSON.parse(res.body)
    if (data.code || data.message === '401: Unauthorized') {
      throw new Error(`Discord auth failed: ${data.message ?? JSON.stringify(data)}`)
    }
  }

  /** Send a message to a channel */
  async sendMessage(channelId: string, content: string): Promise<{ messageId: string }> {
    const res = await request(
      'POST',
      `/api/v10/channels/${channelId}/messages`,
      this.authHeaders(),
      JSON.stringify({ content })
    )
    const data = JSON.parse(res.body)
    if (data.code) {
      throw new Error(`Discord sendMessage failed: ${data.message ?? data.code}`)
    }
    return { messageId: data.id ?? '' }
  }

  /** Reply to a specific message */
  async replyMessage(channelId: string, messageId: string, content: string): Promise<{ messageId: string }> {
    const res = await request(
      'POST',
      `/api/v10/channels/${channelId}/messages`,
      this.authHeaders(),
      JSON.stringify({
        content,
        message_reference: { message_id: messageId },
      })
    )
    const data = JSON.parse(res.body)
    if (data.code) {
      throw new Error(`Discord replyMessage failed: ${data.message ?? data.code}`)
    }
    return { messageId: data.id ?? '' }
  }
}
