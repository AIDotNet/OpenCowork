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

export type NewSessionModelSource = 'pending' | 'project' | 'fixed-default' | 'global'

export interface ModelBindingLike {
  providerId?: string | null
  modelId?: string | null
}

export interface ResolvedNewSessionModel {
  source: NewSessionModelSource
  providerId: string | undefined
  modelId: string | undefined
}

function asCompleteBinding(
  binding: ModelBindingLike | null | undefined
): { providerId: string; modelId: string } | null {
  const providerId = binding?.providerId?.trim()
  const modelId = binding?.modelId?.trim()
  return providerId && modelId ? { providerId, modelId } : null
}

/**
 * Which model a session created right now would use.
 *
 * A pick made in a composer that has no session yet outranks every configured
 * default: the project binding and the fixed default are ambient preferences,
 * while `pendingSelection` is the user pointing at a model for this very send.
 */
export function resolveNewSessionModel({
  pendingSelection,
  project,
  newSessionDefaultModel,
  activeProviderId,
  activeModelId
}: {
  pendingSelection?: ModelBindingLike | null
  project?: ModelBindingLike | null
  newSessionDefaultModel?: (ModelBindingLike & { useGlobalActiveModel?: boolean }) | null
  activeProviderId?: string | null
  activeModelId?: string | null
}): ResolvedNewSessionModel {
  const pending = asCompleteBinding(pendingSelection)
  if (pending) return { source: 'pending', ...pending }

  const projectBinding = asCompleteBinding(project)
  if (projectBinding) return { source: 'project', ...projectBinding }

  const fixedDefault =
    newSessionDefaultModel?.useGlobalActiveModel === false
      ? asCompleteBinding(newSessionDefaultModel)
      : null
  if (fixedDefault) return { source: 'fixed-default', ...fixedDefault }

  return {
    source: 'global',
    providerId: activeProviderId ?? undefined,
    modelId: activeModelId || undefined
  }
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
