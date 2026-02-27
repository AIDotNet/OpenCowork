import { create } from 'zustand'
import { nanoid } from 'nanoid'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { useChatStore } from '@renderer/stores/chat-store'
import { useProviderStore } from '@renderer/stores/provider-store'
import type {
  PluginProviderDescriptor,
  PluginInstance,
  PluginIncomingEvent,
} from '@renderer/lib/plugins/types'
import { IPC } from '@renderer/lib/ipc/channels'

interface PluginStore {
  plugins: PluginInstance[]
  providers: PluginProviderDescriptor[]
  selectedPluginId: string | null
  pluginStatuses: Record<string, 'running' | 'stopped' | 'error'>

  // Per-session activation (toggled via + menu)
  activePluginIds: string[]

  // Init
  loadProviders: () => Promise<void>
  loadPlugins: () => Promise<void>

  // CRUD
  addPlugin: (type: string, name: string, config: Record<string, string>, systemPrompt?: string) => Promise<string>
  updatePlugin: (id: string, patch: Partial<PluginInstance>) => Promise<void>
  removePlugin: (id: string) => Promise<void>
  togglePluginEnabled: (id: string) => Promise<void>

  // Service control
  startPlugin: (id: string) => Promise<string | undefined>
  stopPlugin: (id: string) => Promise<void>
  refreshStatus: (id: string) => Promise<void>

  // UI
  setSelectedPlugin: (id: string | null) => void

  // Per-session activation
  toggleActivePlugin: (id: string) => void
  clearActivePlugins: () => void

  // Plugin sessions
  pluginSessions: Record<string, unknown[]>
  loadPluginSessions: (pluginId: string) => Promise<void>

  // Helpers
  getDescriptor: (type: string) => PluginProviderDescriptor | undefined
  getConfiguredPlugins: () => PluginInstance[]
  getActivePlugins: () => PluginInstance[]
}

// Use window-level flags so HMR module reloads don't re-register listeners
declare global {
  interface Window {
    __pluginListenerActive?: boolean
    __pluginDispatchedIds?: Set<string>
  }
}

export function initPluginEventListener(): void {
  if (window.__pluginListenerActive) return
  window.__pluginListenerActive = true
  if (!window.__pluginDispatchedIds) window.__pluginDispatchedIds = new Set<string>()

  ipcClient.on(IPC.PLUGIN_INCOMING_MESSAGE, (...args: unknown[]) => {
    const data = args[0] as PluginIncomingEvent
    if (!data || !data.pluginId) return

    if (data.type === 'status_change') {
      const status = data.data as 'running' | 'stopped' | 'error'
      usePluginStore.setState((s) => ({
        pluginStatuses: { ...s.pluginStatuses, [data.pluginId]: status },
      }))
    }
    if (data.type === 'incoming_message') {
      console.log(`[Plugin:${data.pluginId}] Incoming message:`, data.data)
    }
    if (data.type === 'error') {
      console.error(`[Plugin:${data.pluginId}] Error:`, data.data)
      usePluginStore.setState((s) => ({
        pluginStatuses: { ...s.pluginStatuses, [data.pluginId]: 'error' },
      }))
    }
  })

  // Listen for auto-reply session tasks from main process
  ipcClient.on(IPC.PLUGIN_SESSION_TASK, (...args: unknown[]) => {
    const task = args[0] as {
      sessionId: string
      pluginId: string
      pluginType: string
      chatId: string
      content: string
      messageId?: string
      chatType?: 'p2p' | 'group'
      audio?: { fileKey: string; fileName?: string; mediaType?: string; durationMs?: number }
    }
    if (!task || !task.sessionId) return

    // Dedup by messageId — use window-level Set that survives HMR module reloads
    if (task.messageId) {
      const seen = window.__pluginDispatchedIds!
      if (seen.has(task.messageId)) {
        console.log(`[Plugin] Skipping duplicate task for messageId=${task.messageId}`)
        return
      }
      seen.add(task.messageId)
      if (seen.size > 200) {
        const first = seen.values().next().value
        if (first) seen.delete(first)
      }
    }

    window.dispatchEvent(
      new CustomEvent('plugin:auto-reply-task', { detail: task })
    )
  })
}

export const usePluginStore = create<PluginStore>((set, get) => ({
  plugins: [],
  providers: [],
  selectedPluginId: null,
  pluginStatuses: {},
  activePluginIds: [],
  pluginSessions: {},

  loadProviders: async () => {
    try {
      const providers = (await ipcClient.invoke(IPC.PLUGIN_LIST_PROVIDERS)) as PluginProviderDescriptor[]
      set({ providers: Array.isArray(providers) ? providers : [] })
    } catch {
      set({ providers: [] })
    }
  },

  loadPlugins: async () => {
    try {
      const plugins = (await ipcClient.invoke(IPC.PLUGIN_LIST)) as PluginInstance[]
      const arr = Array.isArray(plugins) ? plugins : []
      console.log(`[PluginStore] Loaded ${arr.length} plugins:`, arr.map((p) => `${p.type}(${p.id})`))
      // Auto-activate all enabled plugins
      const enabledIds = arr.filter((p) => p.enabled).map((p) => p.id)
      set({ plugins: arr, activePluginIds: enabledIds })
    } catch (err) {
      console.error('[PluginStore] Failed to load plugins:', err)
      set({ plugins: [] })
    }
  },

  addPlugin: async (type, name, config, systemPrompt) => {
    const id = nanoid()
    const desc = get().providers.find((p) => p.type === type)
    const tools = desc?.tools?.reduce<Record<string, boolean>>((acc, toolName) => {
      acc[toolName] = true
      return acc
    }, {})
    const instance: PluginInstance = {
      id,
      type,
      name,
      enabled: true,
      userSystemPrompt: systemPrompt ?? '',
      config,
      createdAt: Date.now(),
      ...(tools ? { tools } : {}),
    }
    await ipcClient.invoke(IPC.PLUGIN_ADD, instance)
    set((s) => ({
      plugins: [...s.plugins, instance],
      activePluginIds: [...s.activePluginIds, id],
    }))
    return id
  },

  updatePlugin: async (id, patch) => {
    const normalizedPatch = { ...patch }
    if ('providerId' in patch && patch.providerId == null) {
      normalizedPatch.model = null
    }
    await ipcClient.invoke(IPC.PLUGIN_UPDATE, { id, patch: normalizedPatch })
    set((s) => ({
      plugins: s.plugins.map((p) => {
        if (p.id !== id) return p
        const next = { ...p, ...normalizedPatch }
        if (next.providerId == null) {
          next.model = null
        }
        return next
      }),
    }))

    if ('providerId' in normalizedPatch || 'model' in normalizedPatch) {
      const plugin = get().plugins.find((p) => p.id === id)
      const providerId = plugin?.providerId ?? null
      const modelId = providerId ? (plugin?.model ?? null) : null
      useChatStore.setState((state) => {
        for (const session of state.sessions) {
          if (session.pluginId !== id) continue
          session.providerId = providerId ?? undefined
          session.modelId = modelId ?? undefined
        }
      })

      const activeSessionId = useChatStore.getState().activeSessionId
      if (activeSessionId) {
        const activeSession = useChatStore.getState().sessions.find((s) => s.id === activeSessionId)
        if (activeSession?.pluginId === id && providerId && modelId) {
          const providerStore = useProviderStore.getState()
          if (providerStore.activeProviderId !== providerId) {
            providerStore.setActiveProvider(providerId)
          }
          if (providerStore.activeModelId !== modelId) {
            providerStore.setActiveModel(modelId)
          }
        }
      }
    }
  },

  removePlugin: async (id) => {
    await ipcClient.invoke(IPC.PLUGIN_REMOVE, id)
    set((s) => ({
      plugins: s.plugins.filter((p) => p.id !== id),
      selectedPluginId: s.selectedPluginId === id ? null : s.selectedPluginId,
      activePluginIds: s.activePluginIds.filter((pid) => pid !== id),
    }))
  },

  togglePluginEnabled: async (id) => {
    const plugin = get().plugins.find((p) => p.id === id)
    if (!plugin) return
    const enabled = !plugin.enabled
    await get().updatePlugin(id, { enabled })
    if (enabled) {
      // Auto-activate when enabling
      set((s) => ({
        activePluginIds: s.activePluginIds.includes(id)
          ? s.activePluginIds
          : [...s.activePluginIds, id],
      }))
    } else {
      await get().stopPlugin(id)
      // Deactivate when disabling
      set((s) => ({
        activePluginIds: s.activePluginIds.filter((pid) => pid !== id),
      }))
    }
  },

  startPlugin: async (id) => {
    try {
      const res = (await ipcClient.invoke(IPC.PLUGIN_START, id)) as {
        success: boolean
        error?: string
      }
      if (!res.success) {
        set((s) => ({
          pluginStatuses: { ...s.pluginStatuses, [id]: 'error' },
        }))
        return res.error ?? 'Unknown error'
      }
      set((s) => ({
        pluginStatuses: { ...s.pluginStatuses, [id]: 'running' },
      }))
      return undefined
    } catch (err) {
      set((s) => ({
        pluginStatuses: { ...s.pluginStatuses, [id]: 'error' },
      }))
      return err instanceof Error ? err.message : String(err)
    }
  },

  stopPlugin: async (id) => {
    try {
      await ipcClient.invoke(IPC.PLUGIN_STOP, id)
      set((s) => ({
        pluginStatuses: { ...s.pluginStatuses, [id]: 'stopped' },
      }))
    } catch {
      // ignore
    }
  },

  refreshStatus: async (id) => {
    try {
      const status = (await ipcClient.invoke(IPC.PLUGIN_STATUS, id)) as
        | 'running'
        | 'stopped'
        | 'error'
      set((s) => ({
        pluginStatuses: { ...s.pluginStatuses, [id]: status },
      }))
    } catch {
      // ignore
    }
  },

  setSelectedPlugin: (id) => set({ selectedPluginId: id }),

  toggleActivePlugin: (id) => {
    set((s) => {
      const isActive = s.activePluginIds.includes(id)
      return {
        activePluginIds: isActive
          ? s.activePluginIds.filter((pid) => pid !== id)
          : [...s.activePluginIds, id],
      }
    })
  },

  clearActivePlugins: () => set({ activePluginIds: [] }),

  loadPluginSessions: async (pluginId) => {
    try {
      const sessions = (await ipcClient.invoke(IPC.PLUGIN_SESSIONS_LIST, pluginId)) as unknown[]
      set((s) => ({
        pluginSessions: { ...s.pluginSessions, [pluginId]: sessions },
      }))
    } catch {
      // ignore
    }
  },

  getDescriptor: (type) => {
    return get().providers.find((p) => p.type === type)
  },

  getConfiguredPlugins: () => {
    return get().plugins.filter((p) => p.enabled)
  },

  getActivePlugins: () => {
    const { plugins, activePluginIds } = get()
    return plugins.filter((p) => activePluginIds.includes(p.id))
  },
}))
