import { useProviderStore } from '@renderer/stores/provider-store'
import type { AIProvider, OAuthConfig } from '@renderer/lib/api/types'
import { startOAuthFlow, refreshOAuthFlow } from './oauth'
import { sendChannelCode, verifyChannelCode, fetchChannelUserInfo } from './channel'

const REFRESH_SKEW_MS = 2 * 60 * 1000

function getProviderById(providerId: string): AIProvider | null {
  const providers = useProviderStore.getState().providers
  return providers.find((p) => p.id === providerId) ?? null
}

function resolveOAuthConfig(provider: AIProvider): OAuthConfig | null {
  if (provider.oauthConfig?.authorizeUrl && provider.oauthConfig?.tokenUrl) return provider.oauthConfig
  return provider.oauthConfig ?? null
}

function setProviderAuth(providerId: string, patch: Partial<AIProvider>): void {
  useProviderStore.getState().updateProvider(providerId, patch)
}

export async function startProviderOAuth(
  providerId: string,
  signal?: AbortSignal
): Promise<void> {
  const provider = getProviderById(providerId)
  if (!provider) throw new Error('Provider not found')
  const config = resolveOAuthConfig(provider)
  if (!config?.authorizeUrl || !config.tokenUrl || !config.clientId) {
    throw new Error('OAuth config is incomplete')
  }

  const token = await startOAuthFlow(config, signal)
  setProviderAuth(providerId, {
    authMode: 'oauth',
    oauth: token,
    apiKey: token.accessToken,
  })
}

export function disconnectProviderOAuth(providerId: string): void {
  setProviderAuth(providerId, { oauth: undefined, apiKey: '' })
}

export async function refreshProviderOAuth(providerId: string, force = false): Promise<boolean> {
  const provider = getProviderById(providerId)
  if (!provider || provider.authMode !== 'oauth') return false
  const config = resolveOAuthConfig(provider)
  if (!config || !config.tokenUrl || !config.clientId) return false
  const current = provider.oauth
  if (!current?.refreshToken) return false

  const expiresAt = current.expiresAt ?? 0
  if (!force && expiresAt && expiresAt - Date.now() > REFRESH_SKEW_MS) {
    return true
  }

  const next = await refreshOAuthFlow(config, current.refreshToken)
  setProviderAuth(providerId, {
    oauth: {
      ...current,
      ...next,
      refreshToken: next.refreshToken ?? current.refreshToken,
    },
    apiKey: next.accessToken,
  })
  return true
}

export async function ensureProviderAuthReady(providerId: string): Promise<boolean> {
  const provider = getProviderById(providerId)
  if (!provider) return false

  const authMode = provider.authMode ?? 'apiKey'
  if (authMode === 'apiKey') {
    if (provider.requiresApiKey === false) return true
    return !!provider.apiKey
  }

  if (authMode === 'oauth') {
    const token = provider.oauth
    if (!token?.accessToken) return false
    const expiresAt = token.expiresAt ?? 0
    if (expiresAt && expiresAt - Date.now() <= REFRESH_SKEW_MS) {
      try {
        const refreshed = await refreshProviderOAuth(providerId, true)
        return refreshed
      } catch {
        return false
      }
    }
    if (!provider.apiKey) {
      setProviderAuth(providerId, { apiKey: token.accessToken })
    }
    return true
  }

  if (authMode === 'channel') {
    const accessToken = provider.channel?.accessToken
    if (!accessToken) return false
    if (!provider.apiKey) {
      setProviderAuth(providerId, { apiKey: accessToken })
    }
    const expiresAt = provider.channel?.accessTokenExpiresAt
    if (expiresAt && Date.now() > expiresAt) {
      return false
    }
    return true
  }

  return false
}

export async function sendProviderChannelCode(args: {
  providerId: string
  channelType: 'sms' | 'email'
  mobile?: string
  email?: string
}): Promise<void> {
  const provider = getProviderById(args.providerId)
  if (!provider) throw new Error('Provider not found')
  if (!provider.channelConfig) throw new Error('Channel config missing')
  const appId =
    provider.channel?.appId?.trim() || provider.channelConfig?.defaultAppId?.trim() || ''
  const appToken = provider.channel?.appToken?.trim() || ''

  await sendChannelCode({
    config: provider.channelConfig,
    appId,
    appToken,
    channelType: args.channelType,
    mobile: args.mobile,
    email: args.email,
  })
}

export async function verifyProviderChannelCode(args: {
  providerId: string
  channelType: 'sms' | 'email'
  code: string
  mobile?: string
  email?: string
}): Promise<void> {
  const provider = getProviderById(args.providerId)
  if (!provider) throw new Error('Provider not found')
  if (!provider.channelConfig) throw new Error('Channel config missing')
  const appId =
    provider.channel?.appId?.trim() || provider.channelConfig?.defaultAppId?.trim() || ''
  const appToken = provider.channel?.appToken?.trim() || ''

  const { accessToken } = await verifyChannelCode({
    config: provider.channelConfig,
    appId,
    appToken,
    channelType: args.channelType,
    code: args.code,
    mobile: args.mobile,
    email: args.email,
  })

  let userInfo: Record<string, unknown> | undefined
  try {
    userInfo = await fetchChannelUserInfo(provider.channelConfig, accessToken)
  } catch {
    userInfo = undefined
  }

  setProviderAuth(args.providerId, {
    authMode: 'channel',
    channel: {
      appId,
      appToken,
      accessToken,
      channelType: args.channelType,
      userInfo,
    },
    apiKey: accessToken,
  })
}

export async function refreshProviderChannelUserInfo(providerId: string): Promise<void> {
  const provider = getProviderById(providerId)
  if (!provider?.channelConfig || !provider.channel?.accessToken) return
  const userInfo = await fetchChannelUserInfo(provider.channelConfig, provider.channel.accessToken)
  setProviderAuth(providerId, {
    channel: {
      ...(provider.channel ?? { appId: '', appToken: '' }),
      userInfo,
    },
  })
}

export function clearProviderChannelAuth(providerId: string): void {
  setProviderAuth(providerId, { channel: undefined, apiKey: '' })
}
