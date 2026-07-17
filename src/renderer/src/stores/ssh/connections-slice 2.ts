// Extracted from the former monolithic ssh-store.ts; behavior unchanged.
import type { StateCreator } from 'zustand'
import { ipcClient } from '../../lib/ipc/ipc-client'
import { IPC } from '../../lib/ipc/channels'
import {
  rowToConnection,
  rowToGroup,
  renameTabTitle,
  type SshConnection,
  type SshConnectionRow,
  type SshGroup,
  type SshGroupRow,
  type SshSession
} from './types'
import { ensureSshEventsSubscribed } from './events'
import type { SshStore } from './store'

export interface SshConnectionsSlice {
  groups: SshGroup[]
  connections: SshConnection[]
  _loaded: boolean
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
}

export const createConnectionsSlice: StateCreator<SshStore, [], [], SshConnectionsSlice> = (
  set,
  get,
  api
) => ({
  groups: [],
  connections: [],
  _loaded: false,

  loadAll: async () => {
    try {
      ensureSshEventsSubscribed(api)
      const [groupRows, connRows, sessionRows] = await Promise.all([
        ipcClient.invoke(IPC.SSH_GROUP_LIST) as Promise<SshGroupRow[] | { error: string }>,
        ipcClient.invoke(IPC.SSH_CONNECTION_LIST) as Promise<
          SshConnectionRow[] | { error: string }
        >,
        ipcClient.invoke(IPC.SSH_SESSION_LIST) as Promise<
          { id: string; connectionId: string; status: string; error?: string }[] | { error: string }
        >
      ])

      const groups = Array.isArray(groupRows) ? groupRows.map(rowToGroup) : []
      const connections = Array.isArray(connRows) ? connRows.map(rowToConnection) : []
      const sessions = Array.isArray(sessionRows)
        ? sessionRows.reduce<Record<string, SshSession>>((acc, row) => {
            acc[row.id] = {
              id: row.id,
              connectionId: row.connectionId,
              status: row.status as SshSession['status'],
              error: row.error
            }
            return acc
          }, {})
        : {}

      set((state) => ({
        groups,
        connections,
        sessions,
        _loaded: true,
        openTabs: state.openTabs.map((tab) => {
          const connection = connections.find((item) => item.id === tab.connectionId)
          if (!connection || connection.name === tab.connectionName) return tab
          return {
            ...tab,
            connectionName: connection.name,
            title: renameTabTitle(tab.title, tab.connectionName, connection.name)
          }
        }),
        sftpPaneStates: {
          left: {
            ...state.sftpPaneStates.left,
            connectionId:
              state.sftpPaneStates.left.connectionId &&
              connections.some((item) => item.id === state.sftpPaneStates.left.connectionId)
                ? state.sftpPaneStates.left.connectionId
                : (connections[0]?.id ?? null)
          },
          right: {
            ...state.sftpPaneStates.right,
            connectionId:
              state.sftpPaneStates.right.connectionId &&
              connections.some((item) => item.id === state.sftpPaneStates.right.connectionId)
                ? state.sftpPaneStates.right.connectionId
                : null
          }
        }
      }))
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
      groups: [...s.groups, { id, name, sortOrder: maxOrder + 1, createdAt: now, updatedAt: now }]
    }))
    return id
  },

  updateGroup: async (id, name) => {
    await ipcClient.invoke(IPC.SSH_GROUP_UPDATE, { id, name })
    set((s) => ({
      groups: s.groups.map((g) => (g.id === id ? { ...g, name, updatedAt: Date.now() } : g))
    }))
  },

  deleteGroup: async (id) => {
    await ipcClient.invoke(IPC.SSH_GROUP_DELETE, { id })
    set((s) => ({
      groups: s.groups.filter((g) => g.id !== id),
      connections: s.connections.map((c) => (c.groupId === id ? { ...c, groupId: null } : c))
    }))
  },

  // ── Connection CRUD ──

  createConnection: async (data) => {
    const id = `sshc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const maxOrder = Math.max(0, ...get().connections.map((c) => c.sortOrder))
    await ipcClient.invoke(IPC.SSH_CONNECTION_CREATE, {
      id,
      ...data,
      sortOrder: maxOrder + 1
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
          hasPassword: Boolean(data.password),
          hasPassphrase: Boolean(data.passphrase)
        }
      ]
    }))
    return id
  },

  updateConnection: async (id, data) => {
    await ipcClient.invoke(IPC.SSH_CONNECTION_UPDATE, { id, ...data })
    set((s) => {
      const previousConnection = s.connections.find((connection) => connection.id === id)
      const nextName = typeof data.name === 'string' ? data.name : null

      return {
        connections: s.connections.map((c) => {
          if (c.id !== id) return c
          const updated = { ...c, updatedAt: Date.now() }
          if (data.name !== undefined) updated.name = data.name
          if (data.host !== undefined) updated.host = data.host
          if (data.port !== undefined) updated.port = data.port
          if (data.username !== undefined) updated.username = data.username
          if (data.authType !== undefined)
            updated.authType = data.authType as SshConnection['authType']
          if (data.privateKeyPath !== undefined) updated.privateKeyPath = data.privateKeyPath
          if (data.groupId !== undefined) updated.groupId = data.groupId
          if (data.startupCommand !== undefined) updated.startupCommand = data.startupCommand
          if (data.defaultDirectory !== undefined) updated.defaultDirectory = data.defaultDirectory
          if (data.proxyJump !== undefined) updated.proxyJump = data.proxyJump
          if (data.keepAliveInterval !== undefined) {
            updated.keepAliveInterval = data.keepAliveInterval
          }
          if (data.password !== undefined) updated.hasPassword = Boolean(data.password)
          if (data.passphrase !== undefined) updated.hasPassphrase = Boolean(data.passphrase)
          return updated
        }),
        openTabs: nextName
          ? s.openTabs.map((tab) => {
              if (tab.connectionId !== id) return tab
              const previousName = tab.connectionName || previousConnection?.name || ''
              return {
                ...tab,
                connectionName: nextName,
                title: renameTabTitle(tab.title, previousName, nextName)
              }
            })
          : s.openTabs
      }
    })
  },

  deleteConnection: async (id) => {
    await ipcClient.invoke(IPC.SSH_CONNECTION_DELETE, { id })
    set((s) => ({
      connections: s.connections.filter((c) => c.id !== id),
      selectedConnectionId: s.selectedConnectionId === id ? null : s.selectedConnectionId
    }))
  },

  testConnection: async (id) => {
    const result = (await ipcClient.invoke(IPC.SSH_CONNECTION_TEST, { id })) as {
      success: boolean
      error?: string
    }
    return result
  }
})
