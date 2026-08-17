import type { AIModelConfig, ProviderConfig, UnifiedMessage } from '../api/types'
import { useProviderStore } from '../../stores/provider-store'
import { useSettingsStore } from '../../stores/settings-store'
import {
  buildLoopCompressionConfig,
  compressMessages,
  type CompressionConfig
} from './context-compression'
import type { AgentLoopConfig } from './types'

function findModelConfig(providerConfig: ProviderConfig): AIModelConfig | null {
  const { providers } = useProviderStore.getState()

  if (providerConfig.providerId) {
    const provider = providers.find((item) => item.id === providerConfig.providerId)
    const model = provider?.models.find((item) => item.id === providerConfig.model)
    if (model) return model
  }

  for (const provider of providers) {
    const model = provider.models.find((item) => item.id === providerConfig.model)
    if (model) return model
  }

  return null
}

export function buildRuntimeCompressionConfig(
  providerConfig: ProviderConfig
): CompressionConfig | null {
  const settings = useSettingsStore.getState()
  return buildLoopCompressionConfig({
    enabled: settings.contextCompressionEnabled,
    threshold: settings.contextCompressionThreshold,
    model: findModelConfig(providerConfig)
  })
}

export function buildRuntimeCompression(
  providerConfig: ProviderConfig,
  signal: AbortSignal
): AgentLoopConfig['contextCompression'] | undefined {
  const config = buildRuntimeCompressionConfig(providerConfig)
  if (!config) return undefined

  return {
    config,
    compressFn: async (messages: UnifiedMessage[], options) => {
      const { messages: compressed } = await compressMessages(
        messages,
        useProviderStore.getState().getCompressionProviderConfig() ?? providerConfig,
        signal,
        options?.preserveCount,
        undefined,
        undefined,
        'auto'
      )
      return compressed
    }
  }
}
