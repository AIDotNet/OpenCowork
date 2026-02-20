import * as https from 'https'

const BASE_URL = 'https://api.telegram.org'

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

export class TelegramApi {
  constructor(private botToken: string) {}

  private get baseUrl(): string {
    return `/bot${this.botToken}`
  }

  /** Validate the bot token */
  async validate(): Promise<void> {
    const res = await request('GET', `${this.baseUrl}/getMe`, {})
    const data = JSON.parse(res.body)
    if (!data.ok) {
      throw new Error(`Telegram auth failed: ${data.description ?? JSON.stringify(data)}`)
    }
  }

  /** Send a message to a chat */
  async sendMessage(chatId: string, content: string): Promise<{ messageId: string }> {
    const res = await request(
      'POST',
      `${this.baseUrl}/sendMessage`,
      {},
      JSON.stringify({ chat_id: chatId, text: content })
    )
    const data = JSON.parse(res.body)
    if (!data.ok) {
      throw new Error(`Telegram sendMessage failed: ${data.description ?? data.error_code}`)
    }
    return { messageId: String(data.result?.message_id ?? '') }
  }

  /** Reply to a specific message */
  async replyMessage(messageId: string, chatId: string, content: string): Promise<{ messageId: string }> {
    const res = await request(
      'POST',
      `${this.baseUrl}/sendMessage`,
      {},
      JSON.stringify({
        chat_id: chatId,
        text: content,
        reply_to_message_id: parseInt(messageId, 10),
      })
    )
    const data = JSON.parse(res.body)
    if (!data.ok) {
      throw new Error(`Telegram replyMessage failed: ${data.description ?? data.error_code}`)
    }
    return { messageId: String(data.result?.message_id ?? '') }
  }
}
