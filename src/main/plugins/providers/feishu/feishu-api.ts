import * as https from 'https'
import * as http from 'http'

const BASE_URL = 'https://open.feishu.cn'

interface HttpResponse {
  statusCode: number
  body: string
}

function request(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL)
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

// ── Feishu Open API Client ──

export class FeishuApi {
  private accessToken = ''
  private tokenExpiresAt = 0

  constructor(
    private appId: string,
    private appSecret: string
  ) {}

  /** Get or refresh tenant access token */
  async ensureToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken
    }

    const res = await request(
      'POST',
      '/open-apis/auth/v3/tenant_access_token/internal',
      {},
      JSON.stringify({ app_id: this.appId, app_secret: this.appSecret })
    )

    const data = JSON.parse(res.body)
    if (data.code !== 0) {
      throw new Error(`Feishu auth failed: ${data.msg}`)
    }

    this.accessToken = data.tenant_access_token
    // Token expires in `expire` seconds, refresh 60s early
    this.tokenExpiresAt = Date.now() + (data.expire - 60) * 1000
    return this.accessToken
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.ensureToken()
    return { Authorization: `Bearer ${token}` }
  }

  /** Get the bot's own identity (open_id, app_name) */
  async getBotInfo(): Promise<{ openId: string; appName: string }> {
    const headers = await this.authHeaders()
    const res = await request('GET', '/open-apis/bot/v3/info', headers)
    const data = JSON.parse(res.body)
    if (data.code !== 0) {
      throw new Error(`Feishu getBotInfo failed: ${data.msg}`)
    }
    return {
      openId: data.bot?.open_id ?? '',
      appName: data.bot?.app_name ?? '',
    }
  }

  /** Send a message to a chat */
  async sendMessage(
    chatId: string,
    content: string,
    msgType = 'text'
  ): Promise<{ messageId: string }> {
    const headers = await this.authHeaders()
    const body = JSON.stringify({
      receive_id: chatId,
      msg_type: msgType,
      content: msgType === 'text' ? JSON.stringify({ text: content }) : content,
    })

    const res = await request(
      'POST',
      `/open-apis/im/v1/messages?receive_id_type=chat_id`,
      headers,
      body
    )

    const data = JSON.parse(res.body)
    if (data.code !== 0) {
      throw new Error(`Feishu sendMessage failed: ${data.msg}`)
    }
    return { messageId: data.data?.message_id ?? '' }
  }

  /** Reply to a specific message */
  async replyMessage(messageId: string, content: string): Promise<{ messageId: string }> {
    const headers = await this.authHeaders()
    const body = JSON.stringify({
      msg_type: 'text',
      content: JSON.stringify({ text: content }),
    })

    const res = await request(
      'POST',
      `/open-apis/im/v1/messages/${messageId}/reply`,
      headers,
      body
    )

    const data = JSON.parse(res.body)
    if (data.code !== 0) {
      throw new Error(`Feishu replyMessage failed: ${data.msg}`)
    }
    return { messageId: data.data?.message_id ?? '' }
  }

  /** Get chat info by chat_id — returns chat name, type, etc. */
  async getChatInfo(chatId: string): Promise<{ name: string; chatType: string } | null> {
    try {
      const headers = await this.authHeaders()
      const res = await request('GET', `/open-apis/im/v1/chats/${chatId}`, headers)
      const data = JSON.parse(res.body)
      if (data.code !== 0) return null
      return {
        name: data.data?.name ?? '',
        chatType: data.data?.chat_type ?? '',
      }
    } catch {
      return null
    }
  }

  /** List chats/groups the bot is in */
  async listChats(): Promise<
    Array<{ chat_id: string; name: string; member_count?: number; raw: unknown }>
  > {
    const headers = await this.authHeaders()
    const res = await request('GET', '/open-apis/im/v1/chats?page_size=50', headers)

    const data = JSON.parse(res.body)
    if (data.code !== 0) {
      throw new Error(`Feishu listChats failed: ${data.msg}`)
    }

    return (data.data?.items ?? []).map(
      (item: { chat_id: string; name: string; member_count?: number }) => ({
        chat_id: item.chat_id,
        name: item.name,
        member_count: item.member_count,
        raw: item,
      })
    )
  }

  // ── CardKit API — Streaming Card Support ──

  /**
   * Create a card entity for streaming updates.
   * Returns the card_id used for subsequent updates.
   */
  async createCard(
    initialContent: string,
    title = 'AI Assistant'
  ): Promise<{ cardId: string }> {
    const headers = await this.authHeaders()
    const cardData = {
      schema: '2.0',
      config: { update_multi: true, streaming_mode: true },
      header: {
        title: { tag: 'plain_text', content: title },
      },
      body: {
        elements: [{ tag: 'markdown', content: initialContent }],
      },
    }

    const res = await request(
      'POST',
      '/open-apis/cardkit/v1/cards',
      headers,
      JSON.stringify({
        type: 'card_json',
        data: JSON.stringify(cardData),
      })
    )

    const data = JSON.parse(res.body)
    if (data.code !== 0) {
      throw new Error(`Feishu createCard failed: ${data.msg}`)
    }
    return { cardId: data.data?.card_id ?? '' }
  }

  /**
   * Update a card entity content.
   * `sequence` must be strictly incrementing per card_id.
   */
  async updateCard(
    cardId: string,
    content: string,
    sequence: number
  ): Promise<boolean> {
    const headers = await this.authHeaders()
    const cardData = {
      schema: '2.0',
      config: { update_multi: true, streaming_mode: true },
      body: {
        elements: [{ tag: 'markdown', content }],
      },
    }

    const res = await request(
      'PUT',
      `/open-apis/cardkit/v1/cards/${cardId}`,
      headers,
      JSON.stringify({
        card: {
          type: 'card_json',
          data: JSON.stringify(cardData),
        },
        sequence,
      })
    )

    const data = JSON.parse(res.body)
    if (data.code !== 0) {
      console.warn(`[Feishu] updateCard failed (seq=${sequence}): ${data.msg}`)
      return false
    }
    return true
  }

  /**
   * Send a card message to a chat using an existing card_id.
   * Returns the message_id of the sent card message.
   */
  async sendCardMessage(
    chatId: string,
    cardId: string
  ): Promise<{ messageId: string }> {
    const headers = await this.authHeaders()
    const body = JSON.stringify({
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
    })

    const res = await request(
      'POST',
      '/open-apis/im/v1/messages?receive_id_type=chat_id',
      headers,
      body
    )

    const data = JSON.parse(res.body)
    if (data.code !== 0) {
      throw new Error(`Feishu sendCardMessage failed: ${data.msg}`)
    }
    return { messageId: data.data?.message_id ?? '' }
  }

  /**
   * Reply to a specific message with a card using an existing card_id.
   * Returns the message_id of the reply card message.
   */
  async replyCardMessage(
    replyMessageId: string,
    cardId: string
  ): Promise<{ messageId: string }> {
    const headers = await this.authHeaders()
    const body = JSON.stringify({
      msg_type: 'interactive',
      content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
    })

    const res = await request(
      'POST',
      `/open-apis/im/v1/messages/${replyMessageId}/reply`,
      headers,
      body
    )

    const data = JSON.parse(res.body)
    if (data.code !== 0) {
      throw new Error(`Feishu replyCardMessage failed: ${data.msg}`)
    }
    return { messageId: data.data?.message_id ?? '' }
  }

  // ── Image / File Operations ──

  /**
   * Download a message resource (image/file) by message_id and file_key.
   * Returns the raw binary buffer.
   */
  async downloadMessageResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file' = 'image'
  ): Promise<Buffer> {
    const token = await this.ensureToken()
    return new Promise((resolve, reject) => {
      const url = new URL(
        `/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=${type}`,
        BASE_URL
      )
      const req = https.request(
        {
          hostname: url.hostname,
          port: 443,
          path: url.pathname + url.search,
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            const buf = Buffer.concat(chunks)
            if (res.statusCode !== 200) {
              reject(new Error(`Download resource failed: HTTP ${res.statusCode}`))
              return
            }
            resolve(buf)
          })
        }
      )
      req.on('error', reject)
      req.setTimeout(30000, () => {
        req.destroy()
        reject(new Error('Download resource timed out (30s)'))
      })
      req.end()
    })
  }

  /**
   * Upload an image to Feishu and get an image_key.
   * Accepts a Buffer of image data.
   */
  async uploadImage(imageBuffer: Buffer, fileName = 'image.png'): Promise<string> {
    const token = await this.ensureToken()
    const boundary = `----FormBoundary${Date.now()}`

    const parts: Buffer[] = []
    // image_type field
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image_type"\r\n\r\nmessage\r\n`
    ))
    // image file field
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    ))
    parts.push(imageBuffer)
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))

    const body = Buffer.concat(parts)

    return new Promise((resolve, reject) => {
      const url = new URL('/open-apis/im/v1/images', BASE_URL)
      const req = https.request(
        {
          hostname: url.hostname,
          port: 443,
          path: url.pathname,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': String(body.byteLength),
          },
        },
        (res) => {
          let responseBody = ''
          res.on('data', (chunk: Buffer) => { responseBody += chunk.toString() })
          res.on('end', () => {
            try {
              const data = JSON.parse(responseBody)
              if (data.code !== 0) {
                reject(new Error(`Upload image failed: ${data.msg}`))
                return
              }
              resolve(data.data?.image_key ?? '')
            } catch (e) {
              reject(new Error(`Upload image parse error: ${responseBody.slice(0, 200)}`))
            }
          })
        }
      )
      req.on('error', reject)
      req.setTimeout(30000, () => {
        req.destroy()
        reject(new Error('Upload image timed out (30s)'))
      })
      req.write(body)
      req.end()
    })
  }

  /**
   * Upload a file to Feishu and get a file_key.
   */
  async uploadFile(
    fileBuffer: Buffer,
    fileName: string,
    fileType: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' = 'stream'
  ): Promise<string> {
    const token = await this.ensureToken()
    const boundary = `----FormBoundary${Date.now()}`

    const parts: Buffer[] = []
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file_type"\r\n\r\n${fileType}\r\n`
    ))
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file_name"\r\n\r\n${fileName}\r\n`
    ))
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    ))
    parts.push(fileBuffer)
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))

    const body = Buffer.concat(parts)

    return new Promise((resolve, reject) => {
      const url = new URL('/open-apis/im/v1/files', BASE_URL)
      const req = https.request(
        {
          hostname: url.hostname,
          port: 443,
          path: url.pathname,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': String(body.byteLength),
          },
        },
        (res) => {
          let responseBody = ''
          res.on('data', (chunk: Buffer) => { responseBody += chunk.toString() })
          res.on('end', () => {
            try {
              const data = JSON.parse(responseBody)
              if (data.code !== 0) {
                reject(new Error(`Upload file failed: ${data.msg}`))
                return
              }
              resolve(data.data?.file_key ?? '')
            } catch (e) {
              reject(new Error(`Upload file parse error: ${responseBody.slice(0, 200)}`))
            }
          })
        }
      )
      req.on('error', reject)
      req.setTimeout(60000, () => {
        req.destroy()
        reject(new Error('Upload file timed out (60s)'))
      })
      req.write(body)
      req.end()
    })
  }

  /**
   * Download a file from an HTTP/HTTPS URL and return the raw buffer.
   */
  static downloadUrl(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http
      mod.get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow one redirect
          FeishuApi.downloadUrl(res.headers.location).then(resolve).catch(reject)
          return
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download URL failed: HTTP ${res.statusCode}`))
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', reject)
      }).on('error', reject)
    })
  }

  /** Send an image message to a chat using an image_key */
  async sendImageMessage(
    chatId: string,
    imageKey: string
  ): Promise<{ messageId: string }> {
    const headers = await this.authHeaders()
    const body = JSON.stringify({
      receive_id: chatId,
      msg_type: 'image',
      content: JSON.stringify({ image_key: imageKey }),
    })

    const res = await request(
      'POST',
      '/open-apis/im/v1/messages?receive_id_type=chat_id',
      headers,
      body
    )

    const data = JSON.parse(res.body)
    if (data.code !== 0) {
      throw new Error(`Feishu sendImageMessage failed: ${data.msg}`)
    }
    return { messageId: data.data?.message_id ?? '' }
  }

  /** Send a file message to a chat using a file_key */
  async sendFileMessage(
    chatId: string,
    fileKey: string
  ): Promise<{ messageId: string }> {
    const headers = await this.authHeaders()
    const body = JSON.stringify({
      receive_id: chatId,
      msg_type: 'file',
      content: JSON.stringify({ file_key: fileKey }),
    })

    const res = await request(
      'POST',
      '/open-apis/im/v1/messages?receive_id_type=chat_id',
      headers,
      body
    )

    const data = JSON.parse(res.body)
    if (data.code !== 0) {
      throw new Error(`Feishu sendFileMessage failed: ${data.msg}`)
    }
    return { messageId: data.data?.message_id ?? '' }
  }

  /** Get messages from a chat */
  async getMessages(
    chatId: string,
    count = 20
  ): Promise<
    Array<{
      message_id: string
      sender_id: string
      sender_name: string
      content: string
      create_time: string
      raw: unknown
    }>
  > {
    const headers = await this.authHeaders()
    const res = await request(
      'GET',
      `/open-apis/im/v1/messages?container_id_type=chat&container_id=${chatId}&page_size=${count}`,
      headers
    )

    const data = JSON.parse(res.body)
    if (data.code !== 0) {
      throw new Error(`Feishu getMessages failed: ${data.msg}`)
    }

    return (data.data?.items ?? []).map(
      (item: {
        message_id: string
        sender: { sender_id: string; sender_type: string; tenant_key: string }
        body: { content: string }
        create_time: string
      }) => {
        let content = ''
        try {
          const parsed = JSON.parse(item.body?.content ?? '{}')
          content = parsed.text ?? item.body?.content ?? ''
        } catch {
          content = item.body?.content ?? ''
        }
        return {
          message_id: item.message_id,
          sender_id: item.sender?.sender_id ?? '',
          sender_name: '',
          content,
          create_time: item.create_time,
          raw: item,
        }
      }
    )
  }
}
