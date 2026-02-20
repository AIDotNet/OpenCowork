import * as https from 'https'

const BASE_URL = 'https://graph.facebook.com'

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

export class WhatsAppApi {
  constructor(
    private phoneNumberId: string,
    private accessToken: string
  ) {}

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}` }
  }

  /** Validate the access token */
  async validate(): Promise<void> {
    const res = await request(
      'GET',
      `/v18.0/${this.phoneNumberId}`,
      this.authHeaders()
    )
    const data = JSON.parse(res.body)
    if (data.error) {
      throw new Error(`WhatsApp auth failed: ${data.error.message ?? JSON.stringify(data)}`)
    }
  }

  /** Send a text message */
  async sendMessage(to: string, content: string): Promise<{ messageId: string }> {
    const res = await request(
      'POST',
      `/v18.0/${this.phoneNumberId}/messages`,
      this.authHeaders(),
      JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: content },
      })
    )
    const data = JSON.parse(res.body)
    if (data.error) {
      throw new Error(`WhatsApp sendMessage failed: ${data.error.message ?? data.error.code}`)
    }
    return { messageId: data.messages?.[0]?.id ?? '' }
  }

  /** Reply to a message (WhatsApp uses context for replies) */
  async replyMessage(to: string, _messageId: string, content: string): Promise<{ messageId: string }> {
    return this.sendMessage(to, content)
  }
}
