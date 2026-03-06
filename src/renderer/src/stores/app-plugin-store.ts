import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { ProviderConfig } from '@renderer/lib/api/types'
import { configStorage } from '@renderer/lib/ipc/config-storage'
import { useProviderStore } from './provider-store'
import {
  APP_PLUGIN_DESCRIPTORS,
  IMAGE_PLUGIN_ID,
  type AppPluginDescriptor,
  type AppPluginId,
  type AppPluginInstance
} from '@renderer/lib/app-plugin/types'

function createDefaultPlugin(id: AppPluginId): AppPluginInstance {
  return {
    id,
    enabled: false,
    useGlobalModel: true,
    providerId: null,
    modelId: null
  }
}

function provisionBuiltinPlugins(plugins: AppPluginInstance[]): AppPluginInstance[] {
  const next = plugins.map((plugin) => ({ ...plugin }))

  for (const descriptor of APP_PLUGIN_DESCRIPTORS) {
    const existing = next.find((plugin) => plugin.id === descriptor.id)
    if (!existing) {
      next.push(createDefaultPlugin(descriptor.id))
      continue
    }

    if (typeof existing.useGlobalModel !== 'boolean') {
      existing.useGlobalModel = true
    }
    if (existing.providerId === undefined) {
      existing.providerId = null
    }
    if (existing.modelId === undefined) {
      existing.modelId = null
    }
  }

  return next
}

function isImageModelEnabled(providerId: string, modelId: string): boolean {
  const provider = useProviderStore.getState().providers.find((item) => item.id === providerId)
  if (!provider || !provider.enabled) return false
  const model = provider.models.find((item) => item.id === modelId)
  if (!model || !model.enabled) return false
  return (model.category ?? 'chat') === 'image'
}

interface AppPluginStore {
  plugins: AppPluginInstance[]
  getDescriptors: () => AppPluginDescriptor[]
  getPlugin: (id: AppPluginId) => AppPluginInstance | null
  updatePlugin: (id: AppPluginId, patch: Partial<AppPluginInstance>) => void
  togglePluginEnabled: (id: AppPluginId) => void
  getEnabledPlugins: () => AppPluginInstance[]
  getResolvedImagePluginConfig: () => ProviderConfig | null
  isImageToolAvailable: () => boolean
}

export const useAppPluginStore = create<AppPluginStore>()(
  persist(
    (set, get) => ({
      plugins: provisionBuiltinPlugins([]),

      getDescriptors: () => APP_PLUGIN_DESCRIPTORS,

      getPlugin: (id) => get().plugins.find((plugin) => plugin.id === id) ?? null,

      updatePlugin: (id, patch) =>
        set((state) => ({
          plugins: state.plugins.map((plugin) =>
            plugin.id === id ? { ...plugin, ...patch } : plugin
          )
        })),

      togglePluginEnabled: (id) =>
        set((state) => ({
          plugins: state.plugins.map((plugin) =>
            plugin.id === id ? { ...plugin, enabled: !plugin.enabled } : plugin
          )
        })),

      getEnabledPlugins: () => get().plugins.filter((plugin) => plugin.enabled),

      getResolvedImagePluginConfig: () => {
        const plugin = get().getPlugin(IMAGE_PLUGIN_ID)
        if (!plugin?.enabled) return null

        const providerStore = useProviderStore.getState()
        const providerId = plugin.useGlobalModel
          ? providerStore.activeImageProviderId
          : plugin.providerId
        const modelId = plugin.useGlobalModel ? providerStore.activeImageModelId : plugin.modelId

        if (!providerId || !modelId) return null
        if (!isImageModelEnabled(providerId, modelId)) return null

        return providerStore.getProviderConfigById(providerId, modelId)
      },

      isImageToolAvailable: () => get().getResolvedImagePluginConfig() !== null
    }),
    {
      name: 'opencowork-app-plugins',
      version: 1,
      storage: createJSONStorage(() => configStorage),
      migrate: (persisted) => {
        const state = (persisted ?? {}) as { plugins?: AppPluginInstance[] }
        return {
          ...state,
          plugins: provisionBuiltinPlugins(Array.isArray(state.plugins) ? state.plugins : [])
        }
      },
      partialize: (state) => ({
        plugins: state.plugins
      })
    }
  )
)

function ensureBuiltinPlugins(): void {
  const current = useAppPluginStore.getState().plugins
  const next = provisionBuiltinPlugins(current)
  if (JSON.stringify(current) !== JSON.stringify(next)) {
    useAppPluginStore.setState({ plugins: next })
  }
}

export function initAppPluginStore(): void {
  if (useAppPluginStore.persist.hasHydrated()) {
    ensureBuiltinPlugins()
  }

  useAppPluginStore.persist.onFinishHydration(() => {
    ensureBuiltinPlugins()
  })
}
