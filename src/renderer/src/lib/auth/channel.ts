import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import type { ChannelConfig } from '@renderer/lib/api/types'

interface SendCodeArgs {
  config: ChannelConfig
  appId: string
  appToken?: string
  channelType: 'sms' | 'email'
  mobile?: string
  email?: string
}

interface VerifyCodeArgs {
  config: ChannelConfig
  appId: string
  appToken?: string
  channelType: 'sms' | 'email'
  code: string
  mobile?: string
  email?: string
}

export async function sendChannelCode(args: SendCodeArgs): Promise<void> {
  const { config, appId, appToken, channelType, mobile, email } = args
  if (!appId) throw new Error('Missing appId')
  const token = appToken?.trim()
  if (!token && config.requiresAppToken !== false) throw new Error('Missing appToken')
  if (channelType === 'sms' && !mobile) throw new Error('Missing mobile number')
  if (channelType === 'email' && !email) throw new Error('Missing email address')

  const body = {
    appid: appId,
    channel_type: channelType,
    ...(channelType === 'sms' ? { mobile } : { email }),
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const result = (await ipcClient.invoke('api:request', {
    url: config.vcodeUrl,
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })) as { statusCode?: number; error?: string; body?: string }

  if (result?.error) throw new Error(result.error)
  if (result?.statusCode && result.statusCode >= 400) {
    throw new Error(`HTTP ${result.statusCode}: ${result.body?.slice(0, 200) ?? ''}`)
  }
}

export async function verifyChannelCode(args: VerifyCodeArgs): Promise<{ accessToken: string }> {
  const { config, appId, appToken, channelType, code, mobile, email } = args
  if (!appId) throw new Error('Missing appId')
  const token = appToken?.trim()
  if (!token && config.requiresAppToken !== false) throw new Error('Missing appToken')
  if (!code) throw new Error('Missing verification code')
  if (channelType === 'sms' && !mobile) throw new Error('Missing mobile number')
  if (channelType === 'email' && !email) throw new Error('Missing email address')

  const body = {
    appid: appId,
    channel_type: channelType,
    code,
    ...(channelType === 'sms' ? { mobile } : { email }),
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const result = (await ipcClient.invoke('api:request', {
    url: config.tokenUrl,
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })) as { statusCode?: number; error?: string; body?: string }

  if (result?.error) throw new Error(result.error)
  if (!result?.body) throw new Error('Empty token response')
  if (result?.statusCode && result.statusCode >= 400) {
    throw new Error(`HTTP ${result.statusCode}: ${result.body.slice(0, 200)}`)
  }

  const data = JSON.parse(result.body) as { access_token?: string }
  const accessToken = data.access_token
  if (!accessToken) throw new Error('Missing access_token in response')
  return { accessToken }
}

export async function fetchChannelUserInfo(config: ChannelConfig, accessToken: string): Promise<Record<string, unknown>> {
  if (!accessToken) throw new Error('Missing access token')

  const result = (await ipcClient.invoke('api:request', {
    url: config.userUrl,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })) as { statusCode?: number; error?: string; body?: string }

  if (result?.error) throw new Error(result.error)
  if (!result?.body) throw new Error('Empty user response')
  if (result?.statusCode && result.statusCode >= 400) {
    throw new Error(`HTTP ${result.statusCode}: ${result.body.slice(0, 200)}`)
  }

  return JSON.parse(result.body) as Record<string, unknown>
}
