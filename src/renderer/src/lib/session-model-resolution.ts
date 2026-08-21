import type { AIModelConfig, AIProvider } from '@renderer/lib/api/types'
import type { Session } from '@renderer/stores/chat-store'

export type ResolvedSessionModelSource = 'plugin' | 'session' | 'global'

export interface ResolvedSessionModelSelection {
  source: ResolvedSessionModelSource
  providerId: string | null
  modelId: string | null
  provider: AIProvider | null
  model: AIModelConfig | null
}

export function resolveProviderDefaultModelId(
  providers: AIProvider[],
  providerId: string | null | undefined
): string | null {
  if (!providerId) return null
  const provider = providers.find((item) => item.id === providerId)
  if (!provider) return null
  if (provider.defaultModel) {
    const model = provider.models.find((item) => item.id === provider.defaultModel)
    if (model) return model.id
  }
  const enabledChatModels = provider.models.filter(
    (model) => model.enabled && (!model.category || model.category === 'chat')
  )
  if (enabledChatModels.length > 0) return enabledChatModels[0].id
  const enabledModels = provider.models.filter((model) => model.enabled)
  return enabledModels[0]?.id ?? provider.models[0]?.id ?? null
}

function resolveProviderAndModel(
  providers: AIProvider[],
  providerId: string | null,
  modelId: string | null
): Pick<ResolvedSessionModelSelection, 'provider' | 'model'> {
  const provider = providerId ? (providers.find((item) => item.id === providerId) ?? null) : null
  const model =
    provider && modelId ? (provider.models.find((item) => item.id === modelId) ?? null) : null
  return { provider, model }
}

export function resolveSessionModelSelection({
  session,
  providers,
  activeProviderId,
  activeModelId,
  channelProviderId,
  channelModelId
}: {
  session?: Pick<Session, 'pluginId' | 'providerId' | 'modelId'> | null
  providers: AIProvider[]
  activeProviderId: string | null
  activeModelId: string
  channelProviderId?: string | null
  channelModelId?: string | null
}): ResolvedSessionModelSelection {
  const pluginProviderId = channelProviderId ?? session?.providerId ?? null
  const pluginModelId =
    channelModelId ?? session?.modelId ?? resolveProviderDefaultModelId(providers, pluginProviderId)
  if (session?.pluginId && pluginProviderId && pluginModelId) {
    const { provider, model } = resolveProviderAndModel(providers, pluginProviderId, pluginModelId)
    return {
      source: 'plugin',
      providerId: pluginProviderId,
      modelId: pluginModelId,
      provider,
      model
    }
  }

  if (!session?.pluginId && session?.providerId && session.modelId) {
    const { provider, model } = resolveProviderAndModel(
      providers,
      session.providerId,
      session.modelId
    )
    return {
      source: 'session',
      providerId: session.providerId,
      modelId: session.modelId,
      provider,
      model
    }
  }

  const { provider, model } = resolveProviderAndModel(providers, activeProviderId, activeModelId)
  return {
    source: 'global',
    providerId: activeProviderId,
    modelId: activeModelId || null,
    provider,
    model
  }
}
