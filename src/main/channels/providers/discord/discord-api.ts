import * as https from 'https'
import { requireTextChunks } from '../../split-text'

const BASE_URL = 'https://discord.com'
const TEXT_LIMIT = 2000

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
        headers: reqHeaders
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
    return {
      Authorization: `Bot ${this.botToken}`,
      'User-Agent': 'OpenCowork-Bot (https://github.com, 1.0)'
    }
  }

  /** Validate the bot token */
  async validate(): Promise<void> {
    const res = await request('GET', '/api/v10/users/@me', this.authHeaders())
    const data = JSON.parse(res.body || '{}') as { id?: string; message?: string }
    if (res.statusCode !== 200 || !data.id) {
      throw new Error(`Discord auth failed: ${data.message ?? JSON.stringify(data)}`)
    }
  }

  /** Send a message to a channel */
  async sendMessage(channelId: string, content: string): Promise<{ messageId: string }> {
    if (!channelId) {
      throw new Error('Discord sendMessage requires channelId')
    }

    let messageId = ''
    for (const text of requireTextChunks(content, TEXT_LIMIT, 'Discord')) {
      messageId = (await this.postMessage(channelId, { content: text })).messageId
    }
    return { messageId }
  }

  /** Reply to a specific message */
  async replyMessage(
    channelId: string,
    messageId: string,
    content: string
  ): Promise<{ messageId: string }> {
    if (!channelId) {
      throw new Error('Discord replyMessage requires channelId')
    }

    const chunks = requireTextChunks(content, TEXT_LIMIT, 'Discord')
    const first = chunks[0] ?? ''
    let lastId = (
      await this.postMessage(channelId, {
        content: first,
        message_reference: { message_id: messageId }
      })
    ).messageId
    for (const text of chunks.slice(1)) {
      lastId = (await this.postMessage(channelId, { content: text })).messageId
    }
    return { messageId: lastId }
  }

  private async postMessage(
    channelId: string,
    payload: Record<string, unknown>
  ): Promise<{ messageId: string }> {
    const res = await request(
      'POST',
      `/api/v10/channels/${channelId}/messages`,
      this.authHeaders(),
      JSON.stringify(payload)
    )
    const data = JSON.parse(res.body || '{}') as { id?: string; message?: string; code?: number }
    if (res.statusCode < 200 || res.statusCode >= 300 || !data.id) {
      throw new Error(
        `Discord sendMessage failed: ${data.message ?? data.code ?? `HTTP ${res.statusCode}`}`
      )
    }
    return { messageId: data.id }
  }
}
