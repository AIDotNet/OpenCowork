import { create } from 'zustand'
import { ipcClient } from '../lib/ipc/ipc-client'
import { IPC } from '../lib/ipc/channels'

// ── Types ──

export interface SshGroup {
  id: string
  name: string
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export interface SshConnection {
  id: string
  groupId: string | null
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey' | 'agent'
  privateKeyPath: string | null
  startupCommand: string | null
  defaultDirectory: string | null
  proxyJump: string | null
  keepAliveInterval: number
  sortOrder: number
  lastConnectedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface SshSession {
  id: string
  connectionId: string
  status: 'connecting' | 'connected' | 'disconnected' | 'error'
  error?: string
}

export interface SshTab {
  id: string
  type: 'terminal' | 'file'
  sessionId: string | null
  connectionId: string
  connectionName: string
  title: string
  filePath?: string
  status?: 'connecting' | 'connected' | 'error'
  error?: string
}

export interface SshFileEntry {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink'
  size: number
  modifyTime: number
}

interface SshGroupRow {
  id: string
  name: string
  sort_order: number
  created_at: number
  updated_at: number
}

interface SshConnectionRow {
  id: string
  group_id: string | null
  name: string
  host: string
  port: number
  username: string
  auth_type: string
  private_key_path: string | null
  startup_command: string | null
  default_directory: string | null
  proxy_jump: string | null
  keep_alive_interval: number
  sort_order: number
  last_connected_at: number | null
  created_at: number
  updated_at: number
}

function rowToGroup(row: SshGroupRow): SshGroup {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToConnection(row: SshConnectionRow): SshConnection {
  return {
    id: row.id,
    groupId: row.group_id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    authType: row.auth_type as SshConnection['authType'],
    privateKeyPath: row.private_key_path,
    startupCommand: row.startup_command,
    defaultDirectory: row.default_directory,
    proxyJump: row.proxy_jump,
    keepAliveInterval: row.keep_alive_interval,
    sortOrder: row.sort_order,
    lastConnectedAt: row.last_connected_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const MAX_CONCURRENT_LIST_DIR = 2

type ListDirQueue = {
  active: number
  queue: Array<() => void>
}

const listDirQueues = new Map<string, ListDirQueue>()

function getListDirQueue(sessionId: string): ListDirQueue {
  const existing = listDirQueues.get(sessionId)
  if (existing) return existing
  const created = { active: 0, queue: [] }
  listDirQueues.set(sessionId, created)
  return created
}

function acquireListDirSlot(sessionId: string): Promise<() => void> {
  const queue = getListDirQueue(sessionId)
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (queue.active < MAX_CONCURRENT_LIST_DIR) {
        queue.active += 1
        resolve(() => {
          queue.active = Math.max(0, queue.active - 1)
          const next = queue.queue.shift()
          if (next) next()
        })
        return
      }
      queue.queue.push(tryAcquire)
    }
    tryAcquire()
  })
}

// ── Store ──

interface SshStore {
  groups: SshGroup[]
  connections: SshConnection[]
  sessions: Record<string, SshSession>
  activeTerminalId: string | null
  selectedConnectionId: string | null
  _loaded: boolean

  // Tab management
  openTabs: SshTab[]
  activeTabId: string | null

  // File explorer
  fileExplorerOpen: boolean
  fileExplorerPaths: Record<string, string>
  fileExplorerEntries: Record<string, Record<string, SshFileEntry[]>>
  fileExplorerExpanded: Record<string, Set<string>>
  fileExplorerLoading: Record<string, Record<string, boolean>>
  fileExplorerErrors: Record<string, Record<string, string | null>>

  // Data loading
  loadAll: () => Promise<void>

  // Group CRUD
  createGroup: (name: string) => Promise<string>
  updateGroup: (id: string, name: string) => Promise<void>
  deleteGroup: (id: string) => Promise<void>

  // Connection CRUD
  createConnection: (data: {
    name: string
    host: string
    port?: number
    username: string
    authType?: string
    password?: string
    privateKeyPath?: string
    passphrase?: string
    groupId?: string
    startupCommand?: string
    defaultDirectory?: string
    proxyJump?: string
    keepAliveInterval?: number
  }) => Promise<string>
  updateConnection: (
    id: string,
    data: {
      name?: string
      host?: string
      port?: number
      username?: string
      authType?: string
      password?: string | null
      privateKeyPath?: string | null
      passphrase?: string | null
      groupId?: string | null
      startupCommand?: string | null
      defaultDirectory?: string | null
      proxyJump?: string | null
      keepAliveInterval?: number
    }
  ) => Promise<void>
  deleteConnection: (id: string) => Promise<void>
  testConnection: (id: string) => Promise<{ success: boolean; error?: string }>

  // Terminal sessions
  connect: (connectionId: string) => Promise<string | null>
  disconnect: (sessionId: string) => Promise<void>
  setActiveTerminal: (sessionId: string | null) => void
  setSelectedConnection: (connectionId: string | null) => void
  updateSessionStatus: (sessionId: string, status: SshSession['status'], error?: string) => void
  removeSession: (sessionId: string) => void

  // Tab management
  openTab: (tab: SshTab) => void
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  replaceTab: (tabId: string, tab: SshTab) => void

  // File explorer
  toggleFileExplorer: () => void
  setFileExplorerPath: (sessionId: string, path: string) => void
  loadFileExplorerEntries: (sessionId: string, path: string, force?: boolean) => Promise<void>
  toggleFileExplorerDir: (sessionId: string, dirPath: string) => void
  setFileExplorerExpanded: (sessionId: string, expanded: string[]) => void
}

export const useSshStore = create<SshStore>()((set, get) => ({
  groups: [],
  connections: [],
  sessions: {},
  activeTerminalId: null,
  selectedConnectionId: null,
  _loaded: false,

  openTabs: [],
  activeTabId: null,

  fileExplorerOpen: true,
  fileExplorerPaths: {},
  fileExplorerEntries: {},
  fileExplorerExpanded: {},
  fileExplorerLoading: {},
  fileExplorerErrors: {},

  loadAll: async () => {
    try {
      const [groupRows, connRows, sessionRows] = await Promise.all([
        ipcClient.invoke(IPC.SSH_GROUP_LIST) as Promise<SshGroupRow[] | { error: string }>,
        ipcClient.invoke(IPC.SSH_CONNECTION_LIST) as Promise<SshConnectionRow[] | { error: string }>,
        ipcClient.invoke(IPC.SSH_SESSION_LIST) as Promise<
          { id: string; connectionId: string; status: string; error?: string }[] | { error: string }
        >,
      ])

      const groups = Array.isArray(groupRows) ? groupRows.map(rowToGroup) : []
      const connections = Array.isArray(connRows) ? connRows.map(rowToConnection) : []
      const sessions = Array.isArray(sessionRows)
        ? sessionRows.reduce<Record<string, SshSession>>((acc, row) => {
            acc[row.id] = {
              id: row.id,
              connectionId: row.connectionId,
              status: row.status as SshSession['status'],
              error: row.error,
            }
            return acc
          }, {})
        : {}

      set({ groups, connections, sessions, _loaded: true })
    } catch (err) {
      console.error('[SshStore] Failed to load:', err)
      set({ _loaded: true })
    }
  },

  // ── Group CRUD ──

  createGroup: async (name) => {
    const id = `sshg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const maxOrder = Math.max(0, ...get().groups.map((g) => g.sortOrder))
    await ipcClient.invoke(IPC.SSH_GROUP_CREATE, { id, name, sortOrder: maxOrder + 1 })
    const now = Date.now()
    set((s) => ({
      groups: [...s.groups, { id, name, sortOrder: maxOrder + 1, createdAt: now, updatedAt: now }],
    }))
    return id
  },

  updateGroup: async (id, name) => {
    await ipcClient.invoke(IPC.SSH_GROUP_UPDATE, { id, name })
    set((s) => ({
      groups: s.groups.map((g) => (g.id === id ? { ...g, name, updatedAt: Date.now() } : g)),
    }))
  },

  deleteGroup: async (id) => {
    await ipcClient.invoke(IPC.SSH_GROUP_DELETE, { id })
    set((s) => ({
      groups: s.groups.filter((g) => g.id !== id),
      connections: s.connections.map((c) => (c.groupId === id ? { ...c, groupId: null } : c)),
    }))
  },

  // ── Connection CRUD ──

  createConnection: async (data) => {
    const id = `sshc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const maxOrder = Math.max(0, ...get().connections.map((c) => c.sortOrder))
    await ipcClient.invoke(IPC.SSH_CONNECTION_CREATE, {
      id,
      ...data,
      sortOrder: maxOrder + 1,
    })
    const now = Date.now()
    set((s) => ({
      connections: [
        ...s.connections,
        {
          id,
          groupId: data.groupId ?? null,
          name: data.name,
          host: data.host,
          port: data.port ?? 22,
          username: data.username,
          authType: (data.authType as SshConnection['authType']) ?? 'password',
          privateKeyPath: data.privateKeyPath ?? null,
          startupCommand: data.startupCommand ?? null,
          defaultDirectory: data.defaultDirectory ?? null,
          proxyJump: data.proxyJump ?? null,
          keepAliveInterval: data.keepAliveInterval ?? 60,
          sortOrder: maxOrder + 1,
          lastConnectedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
    }))
    return id
  },

  updateConnection: async (id, data) => {
    await ipcClient.invoke(IPC.SSH_CONNECTION_UPDATE, { id, ...data })
    set((s) => ({
      connections: s.connections.map((c) => {
        if (c.id !== id) return c
        const updated = { ...c, updatedAt: Date.now() }
        if (data.name !== undefined) updated.name = data.name
        if (data.host !== undefined) updated.host = data.host
        if (data.port !== undefined) updated.port = data.port
        if (data.username !== undefined) updated.username = data.username
        if (data.authType !== undefined) updated.authType = data.authType as SshConnection['authType']
        if (data.privateKeyPath !== undefined) updated.privateKeyPath = data.privateKeyPath
        if (data.groupId !== undefined) updated.groupId = data.groupId
        if (data.startupCommand !== undefined) updated.startupCommand = data.startupCommand
        if (data.defaultDirectory !== undefined) updated.defaultDirectory = data.defaultDirectory
        if (data.proxyJump !== undefined) updated.proxyJump = data.proxyJump
        if (data.keepAliveInterval !== undefined) updated.keepAliveInterval = data.keepAliveInterval
        return updated
      }),
    }))
  },

  deleteConnection: async (id) => {
    await ipcClient.invoke(IPC.SSH_CONNECTION_DELETE, { id })
    set((s) => ({
      connections: s.connections.filter((c) => c.id !== id),
      selectedConnectionId: s.selectedConnectionId === id ? null : s.selectedConnectionId,
    }))
  },

  testConnection: async (id) => {
    const result = (await ipcClient.invoke(IPC.SSH_CONNECTION_TEST, { id })) as {
      success: boolean
      error?: string
    }
    return result
  },

  // ── Terminal sessions ──

  connect: async (connectionId) => {
    const result = (await ipcClient.invoke(IPC.SSH_CONNECT, { connectionId })) as {
      sessionId?: string
      error?: string
    }
    if (result.error || !result.sessionId) {
      return null
    }
    const session: SshSession = {
      id: result.sessionId,
      connectionId,
      status: 'connecting',
    }
    set((s) => ({
      sessions: { ...s.sessions, [result.sessionId!]: session },
      activeTerminalId: result.sessionId!,
      connections: s.connections.map((c) =>
        c.id === connectionId ? { ...c, lastConnectedAt: Date.now() } : c
      ),
    }))
    return result.sessionId
  },

  disconnect: async (sessionId) => {
    await ipcClient.invoke(IPC.SSH_DISCONNECT, { sessionId })
    set((s) => {
      const updated = { ...s.sessions }
      delete updated[sessionId]
      const remainingTabs = s.openTabs.filter((t) => t.sessionId !== sessionId)
      const closedActiveTab = s.activeTabId && s.openTabs.find((t) => t.id === s.activeTabId)?.sessionId === sessionId
      return {
        sessions: updated,
        activeTerminalId: s.activeTerminalId === sessionId ? null : s.activeTerminalId,
        openTabs: remainingTabs,
        activeTabId: closedActiveTab
          ? (remainingTabs[remainingTabs.length - 1]?.id ?? null)
          : s.activeTabId,
      }
    })
  },

  setActiveTerminal: (sessionId) => set({ activeTerminalId: sessionId }),

  setSelectedConnection: (connectionId) => set({ selectedConnectionId: connectionId }),

  updateSessionStatus: (sessionId, status, error) => {
    set((s) => {
      const existing = s.sessions[sessionId]
      if (!existing) return s
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: { ...existing, status, error },
        },
      }
    })
  },

  removeSession: (sessionId) => {
    set((s) => {
      const updated = { ...s.sessions }
      delete updated[sessionId]
      const remainingTabs = s.openTabs.filter((t) => t.sessionId !== sessionId)
      const closedActiveTab = s.activeTabId && s.openTabs.find((t) => t.id === s.activeTabId)?.sessionId === sessionId
      return {
        sessions: updated,
        activeTerminalId: s.activeTerminalId === sessionId ? null : s.activeTerminalId,
        openTabs: remainingTabs,
        activeTabId: closedActiveTab
          ? (remainingTabs[remainingTabs.length - 1]?.id ?? null)
          : s.activeTabId,
      }
    })
  },

  // ── Tab management ──

  openTab: (tab) => {
    set((s) => {
      const exists = s.openTabs.find((t) => t.id === tab.id)
      if (exists) return { activeTabId: tab.id }
      return {
        openTabs: [...s.openTabs, tab],
        activeTabId: tab.id,
      }
    })
  },

  closeTab: (tabId) => {
    set((s) => {
      const idx = s.openTabs.findIndex((t) => t.id === tabId)
      const remaining = s.openTabs.filter((t) => t.id !== tabId)
      const wasActive = s.activeTabId === tabId
      const tab = s.openTabs[idx]

      return {
        openTabs: remaining,
        activeTabId: wasActive
          ? (remaining[Math.min(idx, remaining.length - 1)]?.id ?? null)
          : s.activeTabId,
        activeTerminalId: tab && s.activeTerminalId === tab.sessionId ? null : s.activeTerminalId,
      }
    })
  },

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  replaceTab: (tabId, tab) => {
    set((s) => {
      const openTabs = s.openTabs.map((t) => (t.id === tabId ? tab : t))
      const activeTabId = s.activeTabId === tabId ? tab.id : s.activeTabId
      return { openTabs, activeTabId }
    })
  },

  // ── File explorer ──

  toggleFileExplorer: () => set((s) => ({ fileExplorerOpen: !s.fileExplorerOpen })),

  setFileExplorerPath: (sessionId, path) => {
    set((s) => ({ fileExplorerPaths: { ...s.fileExplorerPaths, [sessionId]: path } }))
  },

  loadFileExplorerEntries: async (sessionId, path, force = false) => {
    const state = get()
    const sessionLoading = state.fileExplorerLoading[sessionId] ?? {}
    if (sessionLoading[path]) return

    const sessionEntries = state.fileExplorerEntries[sessionId] ?? {}
    if (!force && Object.prototype.hasOwnProperty.call(sessionEntries, path)) return

    set((s) => ({
      fileExplorerLoading: {
        ...s.fileExplorerLoading,
        [sessionId]: { ...(s.fileExplorerLoading[sessionId] ?? {}), [path]: true },
      },
      fileExplorerErrors: {
        ...s.fileExplorerErrors,
        [sessionId]: { ...(s.fileExplorerErrors[sessionId] ?? {}), [path]: null },
      },
    }))
    const release = await acquireListDirSlot(sessionId)
    try {
      const result = await ipcClient.invoke(IPC.SSH_FS_LIST_DIR, {
        connectionId: get().sessions[sessionId]?.connectionId,
        path,
      })

      const entries = Array.isArray(result)
        ? result
        : Array.isArray((result as { entries?: unknown })?.entries)
          ? ((result as { entries?: SshFileEntry[] }).entries ?? [])
          : null

      if (entries) {
        const sorted = [...entries].sort((a, b) => {
          if (a.type === 'directory' && b.type !== 'directory') return -1
          if (a.type !== 'directory' && b.type === 'directory') return 1
          return a.name.localeCompare(b.name)
        })
        set((s) => ({
          fileExplorerEntries: {
            ...s.fileExplorerEntries,
            [sessionId]: { ...(s.fileExplorerEntries[sessionId] ?? {}), [path]: sorted },
          },
          fileExplorerErrors: {
            ...s.fileExplorerErrors,
            [sessionId]: { ...(s.fileExplorerErrors[sessionId] ?? {}), [path]: null },
          },
        }))
      } else if (result && typeof result === 'object' && 'error' in result) {
        const errorMessage = String((result as { error?: string }).error ?? 'Failed to load')
        console.error('[SshStore] Failed to load file entries:', result)
        set((s) => ({
          fileExplorerErrors: {
            ...s.fileExplorerErrors,
            [sessionId]: { ...(s.fileExplorerErrors[sessionId] ?? {}), [path]: errorMessage },
          },
        }))
      } else {
        const errorMessage = 'Failed to load'
        set((s) => ({
          fileExplorerErrors: {
            ...s.fileExplorerErrors,
            [sessionId]: { ...(s.fileExplorerErrors[sessionId] ?? {}), [path]: errorMessage },
          },
        }))
      }
    } catch (err) {
      console.error('[SshStore] Failed to load file entries:', err)
      const errorMessage = err instanceof Error ? err.message : 'Failed to load'
      set((s) => ({
        fileExplorerErrors: {
          ...s.fileExplorerErrors,
          [sessionId]: { ...(s.fileExplorerErrors[sessionId] ?? {}), [path]: errorMessage },
        },
      }))
    } finally {
      release()
      set((s) => ({
        fileExplorerLoading: {
          ...s.fileExplorerLoading,
          [sessionId]: { ...(s.fileExplorerLoading[sessionId] ?? {}), [path]: false },
        },
      }))
    }
  },

  toggleFileExplorerDir: (sessionId, dirPath) => {
    set((s) => {
      const current = s.fileExplorerExpanded[sessionId] ?? new Set<string>()
      const next = new Set(current)
      if (next.has(dirPath)) next.delete(dirPath)
      else next.add(dirPath)
      return {
        fileExplorerExpanded: { ...s.fileExplorerExpanded, [sessionId]: next },
      }
    })
  },

  setFileExplorerExpanded: (sessionId, expanded) => {
    set((s) => ({
      fileExplorerExpanded: { ...s.fileExplorerExpanded, [sessionId]: new Set(expanded) },
    }))
  },
}))
