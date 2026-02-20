import * as https from 'https'

const BASE_URL = 'https://qyapi.weixin.qq.com'

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

export class WeComApi {
  private accessToken = ''
  private tokenExpiresAt = 0

  constructor(
    private corpId: string,
    private secret: string,
    private agentId: string
  ) {}

  /** Get or refresh access token */
  async ensureToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken
    }

    const res = await request(
      'GET',
      `/cgi-bin/gettoken?corpid=${this.corpId}&corpsecret=${this.secret}`,
      {}
    )

    const data = JSON.parse(res.body)
    if (data.errcode !== 0) {
      throw new Error(`WeCom auth failed: ${data.errmsg ?? JSON.stringify(data)}`)
    }

    this.accessToken = data.access_token
    this.tokenExpiresAt = Date.now() + ((data.expires_in ?? 7200) - 60) * 1000
    return this.accessToken
  }

  /** Send a text message */
  async sendMessage(toUser: string, content: string): Promise<{ messageId: string }> {
    const token = await this.ensureToken()
    const res = await request(
      'POST',
      `/cgi-bin/message/send?access_token=${token}`,
      {},
      JSON.stringify({
        touser: toUser,
        msgtype: 'text',
        agentid: parseInt(this.agentId, 10),
        text: { content },
      })
    )

    const data = JSON.parse(res.body)
    if (data.errcode !== 0) {
      throw new Error(`WeCom sendMessage failed: ${data.errmsg ?? data.errcode}`)
    }
    return { messageId: data.msgid ?? '' }
  }

  /** Reply (same as send for WeCom) */
  async replyMessage(toUser: string, _messageId: string, content: string): Promise<{ messageId: string }> {
    return this.sendMessage(toUser, content)
  }
}
