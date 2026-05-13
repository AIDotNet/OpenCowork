import { randomUUID } from 'crypto'

export const DEFAULT_WEIXIN_BASE_URL = 'https://ilinkai.weixin.qq.com'
const DEFAULT_ILINK_BOT_TYPE = '3'
const ACTIVE_LOGIN_TTL_MS = 5 * 60_000
const QR_LONG_POLL_TIMEOUT_MS = 35_000
const MAX_QR_REFRESH_COUNT = 3

type ActiveLogin = {
  sessionKey: string
  qrcode: string
  qrcodeUrl: string
  startedAt: number
}

type QRCodeResponse = {
  qrcode: string
  qrcode_img_content: string
}

type StatusResponse = {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired'
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
}

const activeLogins = new Map<string, ActiveLogin>()

function isLoginFresh(login: ActiveLogin): boolean {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS
}

function purgeExpiredLogins(): void {
  for (const [key, login] of activeLogins) {
    if (!isLoginFresh(login)) {
      activeLogins.delete(key)
    }
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return (baseUrl || DEFAULT_WEIXIN_BASE_URL).replace(/\/+$/, '')
}

function buildHeaders(routeTag?: string): Record<string, string> {
  const headers: Record<string, string> = {}
  if (routeTag) {
    headers.SKRouteTag = routeTag
  }
  return headers
}

async function fetchQRCode(
  apiBaseUrl: string,
  botType: string,
  routeTag?: string
): Promise<QRCodeResponse> {
  const url = `${normalizeBaseUrl(apiBaseUrl)}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`
  const response = await fetch(url, { headers: buildHeaders(routeTag) })
  const rawText = await response.text()
  if (!response.ok) {
    throw new Error(
      `Failed to fetch QR code: HTTP ${response.status} ${rawText || response.statusText}`
    )
  }
  return JSON.parse(rawText) as QRCodeResponse
}

async function pollQRStatus(
  apiBaseUrl: string,
  qrcode: string,
  routeTag?: string
): Promise<StatusResponse> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS)

  try {
    const url = `${normalizeBaseUrl(apiBaseUrl)}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
    const response = await fetch(url, {
      headers: {
        'iLink-App-ClientVersion': '1',
        ...buildHeaders(routeTag)
      },
      signal: controller.signal
    })
    const rawText = await response.text()

    if (!response.ok) {
      throw new Error(
        `Failed to poll QR status: HTTP ${response.status} ${rawText || response.statusText}`
      )
    }

    return rawText ? (JSON.parse(rawText) as StatusResponse) : { status: 'wait' }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { status: 'wait' }
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export async function startWeixinLoginWithQr(opts: {
  accountId?: string
  apiBaseUrl: string
  routeTag?: string
  botType?: string
  force?: boolean
}): Promise<{ qrcodeUrl?: string; message: string; sessionKey: string }> {
  const sessionKey = opts.accountId || randomUUID()
  purgeExpiredLogins()

  const existing = activeLogins.get(sessionKey)
  if (!opts.force && existing && isLoginFresh(existing) && existing.qrcodeUrl) {
    return {
      qrcodeUrl: existing.qrcodeUrl,
      message: 'QR code ready, please scan with WeChat.',
      sessionKey
    }
  }

  const qrResponse = await fetchQRCode(
    opts.apiBaseUrl,
    opts.botType || DEFAULT_ILINK_BOT_TYPE,
    opts.routeTag
  )

  activeLogins.set(sessionKey, {
    sessionKey,
    qrcode: qrResponse.qrcode,
    qrcodeUrl: qrResponse.qrcode_img_content,
    startedAt: Date.now()
  })

  return {
    qrcodeUrl: qrResponse.qrcode_img_content,
    message: 'Scan the QR code below with WeChat to complete the connection.',
    sessionKey
  }
}

export async function waitForWeixinLogin(opts: {
  sessionKey: string
  apiBaseUrl: string
  routeTag?: string
  timeoutMs?: number
  botType?: string
}): Promise<{
  connected: boolean
  message: string
  token?: string
  accountId?: string
  baseUrl?: string
  userId?: string
}> {
  let activeLogin = activeLogins.get(opts.sessionKey)
  if (!activeLogin) {
    return { connected: false, message: 'No login in progress, please initiate login first.' }
  }
  if (!isLoginFresh(activeLogin)) {
    activeLogins.delete(opts.sessionKey)
    return { connected: false, message: 'QR code expired, please regenerate.' }
  }

  const deadline = Date.now() + Math.max(opts.timeoutMs ?? 480_000, 1000)
  let qrRefreshCount = 1

  while (Date.now() < deadline) {
    const status = await pollQRStatus(opts.apiBaseUrl, activeLogin.qrcode, opts.routeTag)

    switch (status.status) {
      case 'wait':
      case 'scaned':
        break
      case 'expired': {
        qrRefreshCount += 1
        if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
          activeLogins.delete(opts.sessionKey)
          return {
            connected: false,
            message: 'Login timeout: QR code expired multiple times, please restart login flow.'
          }
        }

        const qrResponse = await fetchQRCode(
          opts.apiBaseUrl,
          opts.botType || DEFAULT_ILINK_BOT_TYPE,
          opts.routeTag
        )
        activeLogin = {
          ...activeLogin,
          qrcode: qrResponse.qrcode,
          qrcodeUrl: qrResponse.qrcode_img_content,
          startedAt: Date.now()
        }
        activeLogins.set(opts.sessionKey, activeLogin)
        break
      }
      case 'confirmed':
        activeLogins.delete(opts.sessionKey)
        if (!status.ilink_bot_id) {
          return { connected: false, message: 'Login failed: server did not return ilink_bot_id.' }
        }
        return {
          connected: true,
          message: '✅ Connected to WeChat successfully!',
          token: status.bot_token,
          accountId: status.ilink_bot_id,
          baseUrl: status.baseurl,
          userId: status.ilink_user_id
        }
    }

    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  activeLogins.delete(opts.sessionKey)
  return { connected: false, message: 'Login timeout, please retry.' }
}
