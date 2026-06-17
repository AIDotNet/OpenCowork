import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { ProviderConfig } from '@renderer/lib/api/types'
import { configStorage } from '@renderer/lib/ipc/config-storage'
import { useProviderStore } from './provider-store'
import { useChatStore } from './chat-store'
import {
  APP_PLUGIN_DESCRIPTORS,
  BROWSER_PLUGIN_ID,
  DESKTOP_CONTROL_PLUGIN_ID,
  IMAGE_PLUGIN_ID,
  isAppPluginEnabledByDefault,
  type AppPluginDescriptor,
  type AppPluginId,
  type AppPluginInstance
} from '@renderer/lib/app-plugin/types'

function createDefaultPlugin(id: AppPluginId): AppPluginInstance {
  return {
    id,
    enabled: isAppPluginEnabledByDefault(id),
    useGlobalModel: true,
    providerId: null,
    modelId: null
  }
}

const GLOBAL_PROJECT_ID = '__global__'

function sanitizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

function resolveProjectId(projectId?: string | null): string {
  return projectId ?? useChatStore.getState().activeProjectId ?? GLOBAL_PROJECT_ID
}

function clonePlugin(plugin: AppPluginInstance): AppPluginInstance {
  return {
    ...plugin,
    browserAllowedDomains: plugin.browserAllowedDomains
      ? [...plugin.browserAllowedDomains]
      : undefined,
    browserBlockedDomains: plugin.browserBlockedDomains
      ? [...plugin.browserBlockedDomains]
      : undefined
  }
}

function normalizePluginOverride(plugin: AppPluginInstance): AppPluginInstance {
  const next = clonePlugin(plugin)

  if (next.id === DESKTOP_CONTROL_PLUGIN_ID) {
    next.enabled = false
  }
  if (next.id === BROWSER_PLUGIN_ID) {
    next.browserAllowedDomains = sanitizeStringList(next.browserAllowedDomains)
    next.browserBlockedDomains = sanitizeStringList(next.browserBlockedDomains)
  }
  if (typeof next.useGlobalModel !== 'boolean') {
    next.useGlobalModel = true
  }
  if (next.providerId === undefined) {
    next.providerId = null
  }
  if (next.modelId === undefined) {
    next.modelId = null
  }

  return next
}

function provisionBuiltinPlugins(plugins: AppPluginInstance[]): AppPluginInstance[] {
  const next = plugins.map((plugin) => ({ ...plugin }))

  for (const descriptor of APP_PLUGIN_DESCRIPTORS) {
    const existing = next.find((plugin) => plugin.id === descriptor.id)
    if (!existing) {
      next.push(createDefaultPlugin(descriptor.id))
      continue
    }
    if (descriptor.id === DESKTOP_CONTROL_PLUGIN_ID) {
      existing.enabled = false
    }
    if (descriptor.id === BROWSER_PLUGIN_ID) {
      existing.browserAllowedDomains = sanitizeStringList(existing.browserAllowedDomains)
      existing.browserBlockedDomains = sanitizeStringList(existing.browserBlockedDomains)
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

export function resolvePluginsForProject(
  pluginsByProject: Record<string, AppPluginInstance[]>,
  projectId?: string | null
): AppPluginInstance[] {
  const globalPlugins = provisionBuiltinPlugins(pluginsByProject[GLOBAL_PROJECT_ID] ?? []).map(
    clonePlugin
  )
  const resolvedProjectId = resolveProjectId(projectId)

  if (resolvedProjectId === GLOBAL_PROJECT_ID) {
    return globalPlugins
  }

  const projectOverrides = Array.isArray(pluginsByProject[resolvedProjectId])
    ? pluginsByProject[resolvedProjectId].map(normalizePluginOverride)
    : []

  return globalPlugins.map((plugin) => {
    const override = projectOverrides.find((item) => item.id === plugin.id)
    return override ? { ...plugin, ...override } : plugin
  })
}

function migrateProjectPlugins(
  plugins: AppPluginInstance[],
  persistedVersion?: number
): AppPluginInstance[] {
  const next = provisionBuiltinPlugins(plugins)
  const storedVersion = typeof persistedVersion === 'number' ? persistedVersion : 0

  if (storedVersion >= 3) {
    return next
  }

  return next.map((plugin) => {
    if (
      plugin.id === IMAGE_PLUGIN_ID &&
      !plugin.enabled &&
      plugin.useGlobalModel &&
      plugin.providerId === null &&
      plugin.modelId === null
    ) {
      return { ...plugin, enabled: true }
    }

    return plugin
  })
}

function isImageModelEnabled(providerId: string, modelId: string): boolean {
  const provider = useProviderStore.getState().providers.find((item) => item.id === providerId)
  if (!provider || !provider.enabled) return false
  const model = provider.models.find((item) => item.id === modelId)
  if (!model || !model.enabled) return false
  return (model.category ?? 'chat') === 'image'
}

interface AppPluginStore {
  pluginsByProject: Record<string, AppPluginInstance[]>
  getPlugins: (projectId?: string | null) => AppPluginInstance[]
  getDescriptors: () => AppPluginDescriptor[]
  getPlugin: (id: AppPluginId, projectId?: string | null) => AppPluginInstance | null
  updatePlugin: (
    id: AppPluginId,
    patch: Partial<AppPluginInstance>,
    projectId?: string | null
  ) => void
  togglePluginEnabled: (id: AppPluginId, projectId?: string | null) => void
  getEnabledPlugins: (projectId?: string | null) => AppPluginInstance[]
  getResolvedImagePluginConfig: (projectId?: string | null) => ProviderConfig | null
  isImageToolAvailable: (projectId?: string | null) => boolean
  isBrowserToolAvailable: (projectId?: string | null) => boolean
  isDesktopControlToolAvailable: () => boolean
}

export const useAppPluginStore = create<AppPluginStore>()(
  persist(
    (set, get) => ({
      pluginsByProject: {
        [GLOBAL_PROJECT_ID]: provisionBuiltinPlugins([])
      },

      getPlugins: (projectId) => resolvePluginsForProject(get().pluginsByProject, projectId),

      getDescriptors: () => APP_PLUGIN_DESCRIPTORS,

      getPlugin: (id, projectId) =>
        get()
          .getPlugins(projectId)
          .find((plugin) => plugin.id === id) ?? null,

      updatePlugin: (id, patch, projectId) => {
        const resolvedProjectId = resolveProjectId(projectId)
        set((state) => {
          const current = resolvePluginsForProject(state.pluginsByProject, resolvedProjectId)
          const next = current.map((plugin) =>
            plugin.id === id ? { ...plugin, ...patch } : plugin
          )
          return { pluginsByProject: { ...state.pluginsByProject, [resolvedProjectId]: next } }
        })
      },

      togglePluginEnabled: (id, projectId) => {
        const resolvedProjectId = resolveProjectId(projectId)
        set((state) => {
          const current = resolvePluginsForProject(state.pluginsByProject, resolvedProjectId)
          const next = current.map((plugin) =>
            plugin.id === id ? { ...plugin, enabled: !plugin.enabled } : plugin
          )
          return { pluginsByProject: { ...state.pluginsByProject, [resolvedProjectId]: next } }
        })
      },

      getEnabledPlugins: (projectId) =>
        get()
          .getPlugins(projectId)
          .filter((plugin) => plugin.enabled),

      getResolvedImagePluginConfig: (projectId) => {
        const plugin = get().getPlugin(IMAGE_PLUGIN_ID, projectId)
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

      isImageToolAvailable: (projectId) => get().getResolvedImagePluginConfig(projectId) !== null,

      isBrowserToolAvailable: (projectId) => {
        const plugin = get().getPlugin(BROWSER_PLUGIN_ID, projectId)
        return Boolean(plugin?.enabled)
      },

      isDesktopControlToolAvailable: () => false
    }),
    {
      name: 'opencowork-app-plugins',
      version: 4,
      storage: createJSONStorage(() => configStorage),
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as {
          plugins?: AppPluginInstance[]
          pluginsByProject?: Record<string, AppPluginInstance[]>
        }

        if (state.pluginsByProject) {
          return {
            pluginsByProject: Object.fromEntries(
              Object.entries(state.pluginsByProject).map(([projectId, plugins]) => [
                projectId,
                migrateProjectPlugins(Array.isArray(plugins) ? plugins : [], version)
              ])
            )
          }
        }

        return {
          pluginsByProject: {
            [GLOBAL_PROJECT_ID]: migrateProjectPlugins(
              Array.isArray(state.plugins) ? state.plugins : [],
              version
            )
          }
        }
      },
      partialize: (state) => ({
        pluginsByProject: state.pluginsByProject
      })
    }
  )
)

function ensureBuiltinPlugins(): void {
  const current = useAppPluginStore.getState().pluginsByProject
  const next = Object.fromEntries(
    Object.entries(current).map(([projectId, plugins]) => [
      projectId,
      provisionBuiltinPlugins(Array.isArray(plugins) ? plugins : [])
    ])
  )
  if (JSON.stringify(current) !== JSON.stringify(next)) {
    useAppPluginStore.setState({ pluginsByProject: next })
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
