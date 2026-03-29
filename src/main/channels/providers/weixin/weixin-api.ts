import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'

export const DEFAULT_WEIXIN_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const DEFAULT_WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

export interface WeixinCdnMedia {
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
  [key: string]: unknown
}

export interface WeixinImageItem {
  file_id?: string
  file_name?: string
  md5sum?: string
  aes_key?: string
  aeskey?: string
  media?: WeixinCdnMedia
  thumb_media?: WeixinCdnMedia
  url?: string
  mid_size?: number
  thumb_size?: number
  thumb_height?: number
  thumb_width?: number
  hd_size?: number
  width?: number
  height?: number
  [key: string]: unknown
}

export interface WeixinMessageItem {
  type?: number
  text_item?: { text?: string }
  voice_item?: { text?: string }
  image_item?: WeixinImageItem
  file_item?: { file_name?: string }
  video_item?: unknown
}

export interface WeixinInboundMessage {
  seq?: number
  message_id?: number
  client_id?: string
  from_user_id?: string
  to_user_id?: string
  create_time_ms?: number
  message_type?: number
  message_state?: number
  item_list?: WeixinMessageItem[]
  context_token?: string
}

export interface GetUpdatesResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinInboundMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

interface WeixinGetUploadUrlResponse {
  upload_param?: string
  thumb_upload_param?: string
}

interface WeixinUploadedFileInfo {
  fileKey: string
  downloadEncryptedQueryParam: string
  aesKeyHex: string
  fileSize: number
  fileSizeCiphertext: number
}

function normalizeBaseUrl(baseUrl: string): string {
  return (baseUrl || DEFAULT_WEIXIN_BASE_URL).replace(/\/+$/, '')
}

function buildXWechatUin(): string {
  const value = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(value), 'utf8').toString('base64')
}

function buildHeaders(
  token?: string,
  routeTag?: string,
  wechatUin?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token'
  }

  if (wechatUin) {
    headers['X-WECHAT-UIN'] = wechatUin
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  if (routeTag) {
    headers.SKRouteTag = routeTag
  }
  return headers
}

async function postJson<T>(params: {
  baseUrl: string
  path: string
  body: unknown
  token?: string
  routeTag?: string
  wechatUin?: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 40000)
  const signal = params.signal
    ? AbortSignal.any([params.signal, controller.signal])
    : controller.signal

  try {
    const response = await fetch(`${normalizeBaseUrl(params.baseUrl)}/${params.path}`, {
      method: 'POST',
      headers: buildHeaders(params.token, params.routeTag, params.wechatUin),
      body: JSON.stringify(params.body),
      signal
    })

    const rawText = await response.text()
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${rawText || response.statusText}`)
    }

    return rawText ? (JSON.parse(rawText) as T) : ({} as T)
  } finally {
    clearTimeout(timeout)
  }
}

async function postBinary(params: {
  baseUrl: string
  path: string
  body: unknown
  token?: string
  routeTag?: string
  wechatUin?: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<{ buffer: Buffer; mediaType: string }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 40000)
  const signal = params.signal
    ? AbortSignal.any([params.signal, controller.signal])
    : controller.signal

  try {
    const response = await fetch(`${normalizeBaseUrl(params.baseUrl)}/${params.path}`, {
      method: 'POST',
      headers: buildHeaders(params.token, params.routeTag, params.wechatUin),
      body: JSON.stringify(params.body),
      signal
    })

    if (!response.ok) {
      const rawText = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status}: ${rawText || response.statusText}`)
    }

    const mediaType = response.headers.get('content-type') || 'application/octet-stream'
    const buffer = Buffer.from(await response.arrayBuffer())
    return { buffer, mediaType }
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchBinary(
  url: string,
  timeoutMs = 20000,
  signal?: AbortSignal
): Promise<{ buffer: Buffer; mediaType: string }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const effectiveSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal

  try {
    const response = await fetch(url, { method: 'GET', signal: effectiveSignal })
    if (!response.ok) {
      const rawText = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status}: ${rawText || response.statusText}`)
    }

    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      mediaType: response.headers.get('content-type') || 'application/octet-stream'
    }
  } finally {
    clearTimeout(timeout)
  }
}

function normalizeCdnBaseUrl(baseUrl: string): string {
  return (baseUrl || DEFAULT_WEIXIN_CDN_BASE_URL).replace(/\/+$/, '')
}

function buildCdnDownloadUrl(cdnBaseUrl: string, encryptedQueryParam: string): string {
  return `${normalizeCdnBaseUrl(cdnBaseUrl)}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`
}

function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64')
  if (decoded.length === 16) {
    return decoded
  }

  const ascii = decoded.toString('ascii')
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(ascii)) {
    return Buffer.from(ascii, 'hex')
  }

  throw new Error(`Invalid Weixin media aes_key format: decoded ${decoded.length} bytes`)
}

function decryptAesEcb(buffer: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(buffer), decipher.final()])
}

function sniffImageMediaType(buffer: Buffer): string | undefined {
  if (buffer.length < 12) {
    return undefined
  }

  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png'
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return 'image/gif'
  }
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp'
  }
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return 'image/bmp'
  }

  return undefined
}

function detectImageMediaType(buffer: Buffer, fallback?: string): string {
  const normalizedFallback = (fallback || '').split(';', 1)[0].trim().toLowerCase()
  if (
    normalizedFallback &&
    normalizedFallback !== 'application/octet-stream' &&
    normalizedFallback !== 'binary/octet-stream'
  ) {
    return normalizedFallback
  }

  return sniffImageMediaType(buffer) || normalizedFallback || 'image/png'
}

function encryptAesEcb(buffer: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(buffer), cipher.final()])
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16
}

function buildCdnUploadUrl(cdnBaseUrl: string, uploadParam: string, fileKey: string): string {
  return `${normalizeCdnBaseUrl(cdnBaseUrl)}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(fileKey)}`
}

async function uploadBufferToCdn(params: {
  buffer: Buffer
  uploadParam: string
  fileKey: string
  cdnBaseUrl: string
  aesKey: Buffer
  signal?: AbortSignal
}): Promise<string> {
  const ciphertext = encryptAesEcb(params.buffer, params.aesKey)
  const url = buildCdnUploadUrl(params.cdnBaseUrl, params.uploadParam, params.fileKey)

  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30000)
      const signal = params.signal
        ? AbortSignal.any([params.signal, controller.signal])
        : controller.signal

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(ciphertext),
          signal
        })

        if (response.status >= 400 && response.status < 500) {
          const rawText =
            response.headers.get('x-error-message') || (await response.text().catch(() => ''))
          throw new Error(
            `Weixin CDN upload client error ${response.status}: ${rawText || response.statusText}`
          )
        }
        if (response.status !== 200) {
          const rawText =
            response.headers.get('x-error-message') || (await response.text().catch(() => ''))
          throw new Error(
            `Weixin CDN upload server error ${response.status}: ${rawText || response.statusText}`
          )
        }

        const downloadParam = response.headers.get('x-encrypted-param') || ''
        if (!downloadParam) {
          throw new Error('Weixin CDN upload response missing x-encrypted-param header')
        }
        return downloadParam
      } finally {
        clearTimeout(timeout)
      }
    } catch (error) {
      lastError = error
      if (
        error instanceof Error &&
        (error.message.includes('client error') ||
          error.message.includes('missing x-encrypted-param'))
      ) {
        throw error
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Weixin CDN upload failed')
}

export class WeixinApi {
  private readonly wechatUin: string

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly routeTag?: string
  ) {
    this.wechatUin = buildXWechatUin()
  }

  async getUpdates(
    syncBuf: string,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<GetUpdatesResponse> {
    return postJson<GetUpdatesResponse>({
      baseUrl: this.baseUrl,
      path: 'ilink/bot/getupdates',
      body: { get_updates_buf: syncBuf || '' },
      token: this.token,
      routeTag: this.routeTag,
      wechatUin: this.wechatUin,
      timeoutMs,
      signal
    })
  }

  private async getUploadUrl(params: {
    fileKey: string
    toUserId: string
    rawSize: number
    rawFileMd5: string
    fileSize: number
    aesKeyHex: string
    mediaType: number
    signal?: AbortSignal
  }): Promise<WeixinGetUploadUrlResponse> {
    return postJson<WeixinGetUploadUrlResponse>({
      baseUrl: this.baseUrl,
      path: 'ilink/bot/getuploadurl',
      body: {
        filekey: params.fileKey,
        media_type: params.mediaType,
        to_user_id: params.toUserId,
        rawsize: params.rawSize,
        rawfilemd5: params.rawFileMd5,
        filesize: params.fileSize,
        no_need_thumb: true,
        aeskey: params.aesKeyHex
      },
      token: this.token,
      routeTag: this.routeTag,
      wechatUin: this.wechatUin,
      timeoutMs: 20000,
      signal: params.signal
    })
  }

  private async uploadMedia(params: {
    toUserId: string
    buffer: Buffer
    mediaType: number
    cdnBaseUrl?: string
    signal?: AbortSignal
  }): Promise<WeixinUploadedFileInfo> {
    const fileKey = randomBytes(16).toString('hex')
    const aesKey = randomBytes(16)
    const rawSize = params.buffer.length
    const rawFileMd5 = createHash('md5').update(params.buffer).digest('hex')
    const fileSize = aesEcbPaddedSize(rawSize)
    const aesKeyHex = aesKey.toString('hex')
    const uploadUrl = await this.getUploadUrl({
      fileKey,
      toUserId: params.toUserId,
      rawSize,
      rawFileMd5,
      fileSize,
      aesKeyHex,
      mediaType: params.mediaType,
      signal: params.signal
    })

    if (!uploadUrl.upload_param) {
      throw new Error('Weixin getuploadurl returned empty upload_param')
    }

    const downloadEncryptedQueryParam = await uploadBufferToCdn({
      buffer: params.buffer,
      uploadParam: uploadUrl.upload_param,
      fileKey,
      cdnBaseUrl: params.cdnBaseUrl || DEFAULT_WEIXIN_CDN_BASE_URL,
      aesKey,
      signal: params.signal
    })

    return {
      fileKey,
      downloadEncryptedQueryParam,
      aesKeyHex,
      fileSize: rawSize,
      fileSizeCiphertext: fileSize
    }
  }

  private async sendItems(params: {
    toUserId: string
    contextToken: string
    items: Array<Record<string, unknown>>
    signal?: AbortSignal
  }): Promise<{ messageId: string }> {
    let clientId = ''

    for (const item of params.items) {
      clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      await postJson({
        baseUrl: this.baseUrl,
        path: 'ilink/bot/sendmessage',
        body: {
          msg: {
            from_user_id: '',
            to_user_id: params.toUserId,
            client_id: clientId,
            message_type: 2,
            message_state: 2,
            item_list: [item],
            context_token: params.contextToken
          }
        },
        token: this.token,
        routeTag: this.routeTag,
        wechatUin: this.wechatUin,
        timeoutMs: 20000,
        signal: params.signal
      })
    }

    return { messageId: clientId }
  }

  async downloadMessageImage(params: {
    messageId: number | string
    fileId: string
    aesKey?: string
    md5sum?: string
    fileName?: string
    signal?: AbortSignal
  }): Promise<{ buffer: Buffer; mediaType: string }> {
    return postBinary({
      baseUrl: this.baseUrl,
      path: 'ilink/bot/downloadmessageimage',
      body: {
        message_id: params.messageId,
        file_id: params.fileId,
        aes_key: params.aesKey || '',
        md5sum: params.md5sum || '',
        file_name: params.fileName || ''
      },
      token: this.token,
      routeTag: this.routeTag,
      wechatUin: this.wechatUin,
      timeoutMs: 20000,
      signal: params.signal
    })
  }

  async downloadInboundImage(params: {
    messageId: number | string
    fileId?: string
    aesKey?: string
    rawAesKeyHex?: string
    md5sum?: string
    fileName?: string
    media?: WeixinCdnMedia
    thumbMedia?: WeixinCdnMedia
    cdnBaseUrl?: string
    signal?: AbortSignal
  }): Promise<{ buffer: Buffer; mediaType: string }> {
    const media = params.media?.encrypt_query_param
      ? params.media
      : params.thumbMedia?.encrypt_query_param
        ? params.thumbMedia
        : undefined

    if (media?.encrypt_query_param) {
      const hexAesKey = params.rawAesKeyHex?.trim()
      if (hexAesKey && !/^[0-9a-fA-F]{32}$/.test(hexAesKey)) {
        throw new Error('Invalid Weixin image aeskey format')
      }
      const aesKeyBase64 = hexAesKey
        ? Buffer.from(hexAesKey, 'hex').toString('base64')
        : media.aes_key || params.aesKey || ''
      const download = await fetchBinary(
        buildCdnDownloadUrl(
          params.cdnBaseUrl || DEFAULT_WEIXIN_CDN_BASE_URL,
          media.encrypt_query_param
        ),
        20000,
        params.signal
      )
      const buffer = aesKeyBase64
        ? decryptAesEcb(download.buffer, parseAesKey(aesKeyBase64))
        : download.buffer
      return {
        buffer,
        mediaType: detectImageMediaType(buffer, download.mediaType)
      }
    }

    if (params.fileId) {
      return this.downloadMessageImage({
        messageId: params.messageId,
        fileId: params.fileId,
        aesKey: params.aesKey,
        md5sum: params.md5sum,
        fileName: params.fileName,
        signal: params.signal
      })
    }

    throw new Error('Missing Weixin inbound image reference')
  }

  async sendMessage(params: {
    toUserId: string
    text: string
    contextToken: string
    signal?: AbortSignal
  }): Promise<{ messageId: string }> {
    return this.sendItems({
      toUserId: params.toUserId,
      contextToken: params.contextToken,
      items: [
        {
          type: 1,
          text_item: { text: params.text }
        }
      ],
      signal: params.signal
    })
  }

  async sendImage(params: {
    toUserId: string
    contextToken: string
    buffer: Buffer
    text?: string
    cdnBaseUrl?: string
    signal?: AbortSignal
  }): Promise<{ messageId: string }> {
    if (!sniffImageMediaType(params.buffer)) {
      throw new Error('The provided payload is not a supported image file')
    }

    const uploaded = await this.uploadMedia({
      toUserId: params.toUserId,
      buffer: params.buffer,
      mediaType: 1,
      cdnBaseUrl: params.cdnBaseUrl,
      signal: params.signal
    })

    const items: Array<Record<string, unknown>> = []
    if (params.text) {
      items.push({
        type: 1,
        text_item: { text: params.text }
      })
    }
    items.push({
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: uploaded.downloadEncryptedQueryParam,
          aes_key: Buffer.from(uploaded.aesKeyHex, 'hex').toString('base64'),
          encrypt_type: 1
        },
        mid_size: uploaded.fileSizeCiphertext
      }
    })

    return this.sendItems({
      toUserId: params.toUserId,
      contextToken: params.contextToken,
      items,
      signal: params.signal
    })
  }

  async sendFile(params: {
    toUserId: string
    contextToken: string
    buffer: Buffer
    fileName: string
    text?: string
    cdnBaseUrl?: string
    signal?: AbortSignal
  }): Promise<{ messageId: string }> {
    const uploaded = await this.uploadMedia({
      toUserId: params.toUserId,
      buffer: params.buffer,
      mediaType: 3,
      cdnBaseUrl: params.cdnBaseUrl,
      signal: params.signal
    })

    const items: Array<Record<string, unknown>> = []
    if (params.text) {
      items.push({
        type: 1,
        text_item: { text: params.text }
      })
    }
    items.push({
      type: 4,
      file_item: {
        media: {
          encrypt_query_param: uploaded.downloadEncryptedQueryParam,
          aes_key: Buffer.from(uploaded.aesKeyHex, 'hex').toString('base64'),
          encrypt_type: 1
        },
        file_name: params.fileName,
        len: String(uploaded.fileSize)
      }
    })

    return this.sendItems({
      toUserId: params.toUserId,
      contextToken: params.contextToken,
      items,
      signal: params.signal
    })
  }
}
