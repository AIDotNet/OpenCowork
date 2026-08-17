import { create } from 'zustand'
import { nanoid } from 'nanoid'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { useChatStore } from '@renderer/stores/chat-store'
import { useProviderStore } from '@renderer/stores/provider-store'
import type {
  PluginProviderDescriptor,
  PluginInstance,
  PluginIncomingEvent
} from '@renderer/lib/channel/types'
import { IPC } from '@renderer/lib/ipc/channels'

interface ChannelStore {
  channels: PluginInstance[]
  providers: PluginProviderDescriptor[]
  selectedChannelId: string | null
  channelStatuses: Record<string, 'running' | 'stopped' | 'error'>

  // Per-project activation (toggled via + menu)
  activeChannelIdsByProject: Record<string, string[]>

  // Init
  loadProviders: () => Promise<void>
  loadChannels: () => Promise<void>

  // CRUD
  addChannel: (type: string, name: string, config: Record<string, string>) => Promise<string>
  updateChannel: (id: string, patch: Partial<PluginInstance>) => Promise<void>
  removeChannel: (id: string) => Promise<void>
  toggleChannelEnabled: (id: string) => Promise<void>

  // Service control
  startChannel: (id: string) => Promise<string | undefined>
  stopChannel: (id: string) => Promise<void>
  refreshChannelStatus: (id: string) => Promise<void>

  // UI
  setSelectedChannel: (id: string | null) => void

  // Per-project activation
  toggleActiveChannel: (id: string, projectId?: string | null) => void
  clearActiveChannels: (projectId?: string | null) => void
  getActiveChannelIds: (projectId?: string | null) => string[]

  // Channel sessions
  channelSessions: Record<string, unknown[]>
  loadChannelSessions: (channelId: string) => Promise<void>

  // Helpers
  getDescriptor: (type: string) => PluginProviderDescriptor | undefined
  getConfiguredChannels: () => PluginInstance[]
  getActiveChannels: () => PluginInstance[]
}

// Use window-level flags so HMR module reloads don't re-register listeners
declare global {
  interface Window {
    __pluginListenerActive?: boolean
    __pluginAutoReplyListenerActive?: boolean
    __pluginDispatchedIds?: Set<string>
  }
}

export function initChannelEventListener(): void {
  if (window.__pluginListenerActive) return
  window.__pluginListenerActive = true
  if (!window.__pluginDispatchedIds) window.__pluginDispatchedIds = new Set<string>()

  ipcClient.on(IPC.PLUGIN_INCOMING_MESSAGE, (...args: unknown[]) => {
    const data = args[0] as PluginIncomingEvent
    if (!data || !data.pluginId) return

    if (data.type === 'status_change') {
      const status = data.data as 'running' | 'stopped' | 'error'
      useChannelStore.setState((s) => ({
        channelStatuses: { ...s.channelStatuses, [data.pluginId]: status }
      }))
    }
    if (data.type === 'incoming_message') {
      console.log(`[Plugin:${data.pluginId}] Incoming message:`, data.data)
    }
    if (data.type === 'error') {
      console.error(`[Plugin:${data.pluginId}] Error:`, data.data)
      useChannelStore.setState((s) => ({
        channelStatuses: { ...s.channelStatuses, [data.pluginId]: 'error' }
      }))
    }
  })

  // Listen for auto-reply session tasks from main process
  ipcClient.on(IPC.PLUGIN_SESSION_TASK, (...args: unknown[]) => {
    const task = args[0] as {
      taskId?: string
      sessionId: string
      pluginId: string
      pluginType: string
      chatId: string
      content: string
      messageId?: string
      projectId?: string
      workingFolder?: string
      sshConnectionId?: string | null
      chatType?: 'p2p' | 'group'
      audio?: { fileKey: string; fileName?: string; mediaType?: string; durationMs?: number }
    }
    if (!task || !task.sessionId) return

    // Ack ownership so main does not fall back to the headless runner.
    if (task.taskId) {
      void ipcClient.invoke(IPC.PLUGIN_SESSION_TASK_ACK, task.taskId).catch(() => {})
    }

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

    window.dispatchEvent(new CustomEvent('plugin:auto-reply-task', { detail: task }))
  })
}

export const useChannelStore = create<ChannelStore>((set, get) => ({
  channels: [],
  providers: [],
  selectedChannelId: null,
  channelStatuses: {},
  activeChannelIdsByProject: {},
  channelSessions: {},

  loadProviders: async () => {
    try {
      const providers = (await ipcClient.invoke(
        IPC.PLUGIN_LIST_PROVIDERS
      )) as PluginProviderDescriptor[]
      set({ providers: Array.isArray(providers) ? providers : [] })
    } catch {
      set({ providers: [] })
    }
  },

  loadChannels: async () => {
    try {
      const plugins = (await ipcClient.invoke(IPC.PLUGIN_LIST)) as PluginInstance[]
      const arr = Array.isArray(plugins) ? plugins : []
      console.log(
        `[ChannelStore] Loaded ${arr.length} plugins:`,
        arr.map((p) => `${p.type}(${p.id})`)
      )
      set({ channels: arr })
    } catch (err) {
      console.error('[ChannelStore] Failed to load plugins:', err)
      set({ channels: [] })
    }
  },

  addChannel: async (type, name, config) => {
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
      config,
      createdAt: Date.now(),
      ...(tools ? { tools } : {})
    }
    await ipcClient.invoke(IPC.PLUGIN_ADD, instance)
    set((s) => ({
      channels: [...s.channels, instance]
    }))
    return id
  },

  updateChannel: async (id, patch) => {
    const normalizedPatch = { ...patch }
    if ('providerId' in patch && patch.providerId == null) {
      normalizedPatch.model = null
    }
    await ipcClient.invoke(IPC.PLUGIN_UPDATE, { id, patch: normalizedPatch })
    set((s) => ({
      channels: s.channels.map((p) => {
        if (p.id !== id) return p
        const next = { ...p, ...normalizedPatch }
        if (next.providerId == null) {
          next.model = null
        }
        return next
      })
    }))

    if ('providerId' in normalizedPatch || 'model' in normalizedPatch) {
      const plugin = get().channels.find((p) => p.id === id)
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

    if ('projectId' in normalizedPatch) {
      const boundProject = normalizedPatch.projectId
        ? useChatStore
            .getState()
            .projects.find((project) => project.id === normalizedPatch.projectId)
        : undefined
      useChatStore.setState((state) => {
        for (const session of state.sessions) {
          if (session.pluginId !== id) continue
          session.projectId = boundProject?.id
          session.workingFolder = boundProject?.workingFolder
          session.sshConnectionId = boundProject?.sshConnectionId
          delete session.promptSnapshot
        }
      })
    }
  },

  removeChannel: async (id) => {
    await ipcClient.invoke(IPC.PLUGIN_REMOVE, id)
    set((s) => ({
      channels: s.channels.filter((p) => p.id !== id),
      selectedChannelId: s.selectedChannelId === id ? null : s.selectedChannelId,
      activeChannelIdsByProject: Object.fromEntries(
        Object.entries(s.activeChannelIdsByProject).map(([projectId, ids]) => [
          projectId,
          ids.filter((pid) => pid !== id)
        ])
      )
    }))
  },

  toggleChannelEnabled: async (id) => {
    const plugin = get().channels.find((p) => p.id === id)
    if (!plugin) return
    const enabled = !plugin.enabled
    await get().updateChannel(id, { enabled })
    if (!enabled) {
      await get().stopChannel(id)
      set((s) => ({
        activeChannelIdsByProject: Object.fromEntries(
          Object.entries(s.activeChannelIdsByProject).map(([projectId, ids]) => [
            projectId,
            ids.filter((pid) => pid !== id)
          ])
        )
      }))
    }
  },

  startChannel: async (id) => {
    try {
      const res = (await ipcClient.invoke(IPC.PLUGIN_START, id)) as {
        success: boolean
        error?: string
      }
      if (!res.success) {
        set((s) => ({
          channelStatuses: { ...s.channelStatuses, [id]: 'error' }
        }))
        return res.error ?? 'Unknown error'
      }
      set((s) => ({
        channelStatuses: { ...s.channelStatuses, [id]: 'running' }
      }))
      return undefined
    } catch (err) {
      set((s) => ({
        channelStatuses: { ...s.channelStatuses, [id]: 'error' }
      }))
      return err instanceof Error ? err.message : String(err)
    }
  },

  stopChannel: async (id) => {
    try {
      await ipcClient.invoke(IPC.PLUGIN_STOP, id)
      set((s) => ({
        channelStatuses: { ...s.channelStatuses, [id]: 'stopped' }
      }))
    } catch {
      // ignore
    }
  },

  refreshChannelStatus: async (id) => {
    try {
      const status = (await ipcClient.invoke(IPC.PLUGIN_STATUS, id)) as
        | 'running'
        | 'stopped'
        | 'error'
      set((s) => ({
        channelStatuses: { ...s.channelStatuses, [id]: status }
      }))
    } catch {
      // ignore
    }
  },

  setSelectedChannel: (id) => set({ selectedChannelId: id }),

  getActiveChannelIds: (projectId) => {
    const resolvedProjectId = projectId ?? useChatStore.getState().activeProjectId ?? '__global__'
    return get().activeChannelIdsByProject[resolvedProjectId] ?? []
  },

  toggleActiveChannel: (id, projectId) => {
    const resolvedProjectId = projectId ?? useChatStore.getState().activeProjectId ?? '__global__'
    set((s) => {
      const currentIds = s.activeChannelIdsByProject[resolvedProjectId] ?? []
      const isActive = currentIds.includes(id)
      return {
        activeChannelIdsByProject: {
          ...s.activeChannelIdsByProject,
          [resolvedProjectId]: isActive
            ? currentIds.filter((pid) => pid !== id)
            : [...currentIds, id]
        }
      }
    })
  },

  clearActiveChannels: (projectId) => {
    const resolvedProjectId = projectId ?? useChatStore.getState().activeProjectId ?? '__global__'
    set((s) => ({
      activeChannelIdsByProject: {
        ...s.activeChannelIdsByProject,
        [resolvedProjectId]: []
      }
    }))
  },

  loadChannelSessions: async (pluginId) => {
    try {
      const sessions = (await ipcClient.invoke(IPC.PLUGIN_SESSIONS_LIST, pluginId)) as unknown[]
      set((s) => ({
        channelSessions: { ...s.channelSessions, [pluginId]: sessions }
      }))
    } catch {
      // ignore
    }
  },

  getDescriptor: (type) => {
    return get().providers.find((p) => p.type === type)
  },

  getConfiguredChannels: () => {
    return get().channels.filter((p) => p.enabled)
  },

  getActiveChannels: () => {
    const { channels } = get()
    const activeChannelIds = get().getActiveChannelIds()
    return channels.filter((p) => activeChannelIds.includes(p.id))
  }
}))
