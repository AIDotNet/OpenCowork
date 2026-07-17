// Extracted from the former monolithic ssh-store.ts; behavior unchanged.
import type { StateCreator } from 'zustand'
import { ipcClient } from '../../lib/ipc/ipc-client'
import { IPC } from '../../lib/ipc/channels'
import type {
  SftpConflictPolicy,
  SftpConnectionState,
  SftpInspectorTab,
  SftpPaneId,
  SftpPaneState,
  SshFileEntry
} from './types'
import {
  acquireListDirSlot,
  getListDirKey,
  ipcWithTimeout,
  listDirInFlightSince,
  normalizePageInfo,
  sortEntries,
  IPC_LIST_DIR_TIMEOUT_MS,
  SSH_FILE_EXPLORER_PAGE_SIZE,
  SSH_FILE_EXPLORER_STALE_LOAD_MS,
  type FileExplorerPageInfo,
  type ListDirPagedResult
} from './list-dir'
import type { SshStore } from './store'

export interface SshSftpSlice {
  sftpConnections: Record<string, SftpConnectionState>
  sftpPaneStates: Record<SftpPaneId, SftpPaneState>
  sftpCompareMode: boolean
  sftpActivePane: SftpPaneId
  sftpEntries: Record<string, Record<string, SshFileEntry[]>>
  sftpPageInfo: Record<string, Record<string, FileExplorerPageInfo>>
  sftpLoading: Record<string, Record<string, boolean>>
  sftpErrors: Record<string, Record<string, string | null>>
  sftpSelections: Record<SftpPaneId, Record<string, SshFileEntry>>
  sftpConflictPolicy: SftpConflictPolicy
  sftpInspectorTab: SftpInspectorTab

  connectSftpConnection: (
    connectionId: string
  ) => Promise<{ homeDir?: string | null; error?: string }>
  disconnectSftpConnection: (connectionId: string) => Promise<void>
  setSftpPaneConnection: (paneId: SftpPaneId, connectionId: string | null) => void
  setSftpPanePath: (paneId: SftpPaneId, path: string) => void
  setSftpCompareMode: (enabled: boolean) => void
  setSftpActivePane: (paneId: SftpPaneId) => void
  loadSftpEntries: (connectionId: string, path: string, force?: boolean) => Promise<void>
  loadMoreSftpEntries: (connectionId: string, path: string) => Promise<void>
  setSftpSelection: (paneId: SftpPaneId, entries: SshFileEntry[]) => void
  toggleSftpSelection: (paneId: SftpPaneId, entry: SshFileEntry) => void
  clearSftpSelection: (paneId: SftpPaneId) => void
  setSftpConflictPolicy: (policy: SftpConflictPolicy) => void
  setSftpInspectorTab: (tab: SftpInspectorTab) => void
}

export const createSftpSlice: StateCreator<SshStore, [], [], SshSftpSlice> = (set, get, _api) => ({
  sftpConnections: {},
  sftpPaneStates: {
    left: { connectionId: null, currentPath: null },
    right: { connectionId: null, currentPath: null }
  },
  sftpCompareMode: false,
  sftpActivePane: 'left',
  sftpEntries: {},
  sftpPageInfo: {},
  sftpLoading: {},
  sftpErrors: {},
  sftpSelections: {
    left: {},
    right: {}
  },
  sftpConflictPolicy: 'skip',
  sftpInspectorTab: 'details',

  connectSftpConnection: async (connectionId) => {
    const existing = get().sftpConnections[connectionId]
    if (existing?.status === 'connected') {
      return { homeDir: existing.homeDir ?? null }
    }
    if (existing?.status === 'connecting') {
      return { homeDir: existing.homeDir ?? null }
    }

    set((state) => ({
      sftpConnections: {
        ...state.sftpConnections,
        [connectionId]: {
          ...(state.sftpConnections[connectionId] ?? { homeDir: null }),
          status: 'connecting',
          error: undefined
        }
      }
    }))

    const result = (await ipcClient.invoke(IPC.SSH_FS_CONNECT, {
      connectionId
    })) as { success?: boolean; homeDir?: string | null; error?: string }

    if (result?.error || !result?.success) {
      set((state) => ({
        sftpConnections: {
          ...state.sftpConnections,
          [connectionId]: {
            ...(state.sftpConnections[connectionId] ?? { homeDir: null }),
            status: 'error',
            error: result?.error ?? 'Failed to connect'
          }
        }
      }))
      return { error: result?.error ?? 'Failed to connect' }
    }

    set((state) => {
      const leftNeedsPath =
        state.sftpPaneStates.left.connectionId === connectionId &&
        !state.sftpPaneStates.left.currentPath
      const rightNeedsPath =
        state.sftpPaneStates.right.connectionId === connectionId &&
        !state.sftpPaneStates.right.currentPath
      return {
        sftpConnections: {
          ...state.sftpConnections,
          [connectionId]: {
            status: 'connected',
            error: undefined,
            homeDir: result.homeDir ?? null,
            lastConnectedAt: Date.now()
          }
        },
        sftpPaneStates: {
          left: leftNeedsPath
            ? { ...state.sftpPaneStates.left, currentPath: result.homeDir ?? '/' }
            : state.sftpPaneStates.left,
          right: rightNeedsPath
            ? { ...state.sftpPaneStates.right, currentPath: result.homeDir ?? '/' }
            : state.sftpPaneStates.right
        }
      }
    })

    return { homeDir: result.homeDir ?? null }
  },

  disconnectSftpConnection: async (connectionId) => {
    await ipcClient.invoke(IPC.SSH_FS_DISCONNECT, { connectionId })
    set((state) => ({
      sftpConnections: {
        ...state.sftpConnections,
        [connectionId]: {
          ...(state.sftpConnections[connectionId] ?? { homeDir: null }),
          status: 'idle',
          error: undefined
        }
      }
    }))
  },

  setSftpPaneConnection: (paneId, connectionId) => {
    set((state) => {
      const connection = connectionId
        ? (state.connections.find((item) => item.id === connectionId) ?? null)
        : null
      const currentState = connectionId ? state.sftpConnections[connectionId] : null
      const nextPath =
        connectionId == null ? null : (currentState?.homeDir ?? connection?.defaultDirectory ?? '/')

      return {
        sftpPaneStates: {
          ...state.sftpPaneStates,
          [paneId]: {
            connectionId,
            currentPath: nextPath
          }
        },
        sftpSelections: {
          ...state.sftpSelections,
          [paneId]: {}
        }
      }
    })
  },

  setSftpPanePath: (paneId, path) => {
    set((state) => ({
      sftpPaneStates: {
        ...state.sftpPaneStates,
        [paneId]: {
          ...state.sftpPaneStates[paneId],
          currentPath: path
        }
      }
    }))
  },

  setSftpCompareMode: (enabled) => set({ sftpCompareMode: enabled }),

  setSftpActivePane: (paneId) => set({ sftpActivePane: paneId }),

  loadSftpEntries: async (connectionId, path, force = false) => {
    const state = get()
    const sessionLoading = state.sftpLoading[connectionId] ?? {}
    const sessionEntries = state.sftpEntries[connectionId] ?? {}
    const now = Date.now()
    const listDirKey = getListDirKey(connectionId, path)
    const startedAt = listDirInFlightSince.get(listDirKey)

    if (sessionLoading[path]) {
      if (!force && Object.prototype.hasOwnProperty.call(sessionEntries, path)) {
        listDirInFlightSince.delete(listDirKey)
        set((s) => ({
          sftpLoading: {
            ...s.sftpLoading,
            [connectionId]: { ...(s.sftpLoading[connectionId] ?? {}), [path]: false }
          }
        }))
        return
      }

      if (!startedAt || now - startedAt > SSH_FILE_EXPLORER_STALE_LOAD_MS) {
        listDirInFlightSince.delete(listDirKey)
        set((s) => ({
          sftpLoading: {
            ...s.sftpLoading,
            [connectionId]: { ...(s.sftpLoading[connectionId] ?? {}), [path]: false }
          }
        }))
      } else {
        return
      }
    }

    if (!force && Object.prototype.hasOwnProperty.call(sessionEntries, path)) return

    const connectResult = await get().connectSftpConnection(connectionId)
    if (connectResult.error) return

    set((s) => ({
      sftpLoading: {
        ...s.sftpLoading,
        [connectionId]: { ...(s.sftpLoading[connectionId] ?? {}), [path]: true }
      },
      sftpErrors: {
        ...s.sftpErrors,
        [connectionId]: { ...(s.sftpErrors[connectionId] ?? {}), [path]: null }
      }
    }))

    listDirInFlightSince.set(listDirKey, now)
    const release = await acquireListDirSlot(connectionId)

    try {
      const result = await ipcWithTimeout(
        ipcClient.invoke(IPC.SSH_FS_LIST_DIR, {
          connectionId,
          path,
          limit: SSH_FILE_EXPLORER_PAGE_SIZE,
          refresh: force
        }),
        IPC_LIST_DIR_TIMEOUT_MS
      )

      if (result && typeof result === 'object' && 'error' in result) {
        const errorMessage = String((result as { error?: string }).error ?? 'Failed to load')
        set((s) => ({
          sftpErrors: {
            ...s.sftpErrors,
            [connectionId]: { ...(s.sftpErrors[connectionId] ?? {}), [path]: errorMessage }
          },
          sftpConnections: {
            ...s.sftpConnections,
            [connectionId]: {
              ...(s.sftpConnections[connectionId] ?? { homeDir: null }),
              status: 'error',
              error: errorMessage
            }
          }
        }))
        return
      }

      const entries = Array.isArray(result)
        ? result
        : Array.isArray((result as ListDirPagedResult | undefined)?.entries)
          ? ((result as ListDirPagedResult).entries ?? [])
          : null

      if (!entries) {
        throw new Error('Failed to load')
      }

      const sorted = sortEntries(entries)
      const pageInfo = Array.isArray(result)
        ? { hasMore: false }
        : normalizePageInfo(result as ListDirPagedResult)

      set((s) => ({
        sftpEntries: {
          ...s.sftpEntries,
          [connectionId]: { ...(s.sftpEntries[connectionId] ?? {}), [path]: sorted }
        },
        sftpPageInfo: {
          ...s.sftpPageInfo,
          [connectionId]: { ...(s.sftpPageInfo[connectionId] ?? {}), [path]: pageInfo }
        },
        sftpErrors: {
          ...s.sftpErrors,
          [connectionId]: { ...(s.sftpErrors[connectionId] ?? {}), [path]: null }
        },
        sftpConnections: {
          ...s.sftpConnections,
          [connectionId]: {
            ...(s.sftpConnections[connectionId] ?? { homeDir: null }),
            status: 'connected',
            error: undefined
          }
        }
      }))
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load'
      set((s) => ({
        sftpErrors: {
          ...s.sftpErrors,
          [connectionId]: { ...(s.sftpErrors[connectionId] ?? {}), [path]: errorMessage }
        },
        sftpConnections: {
          ...s.sftpConnections,
          [connectionId]: {
            ...(s.sftpConnections[connectionId] ?? { homeDir: null }),
            status: 'error',
            error: errorMessage
          }
        }
      }))
    } finally {
      release()
      listDirInFlightSince.delete(listDirKey)
      set((s) => ({
        sftpLoading: {
          ...s.sftpLoading,
          [connectionId]: { ...(s.sftpLoading[connectionId] ?? {}), [path]: false }
        }
      }))
    }
  },

  loadMoreSftpEntries: async (connectionId, path) => {
    const state = get()
    const sessionLoading = state.sftpLoading[connectionId] ?? {}
    const pageInfo = state.sftpPageInfo[connectionId]?.[path]
    const now = Date.now()
    const listDirKey = getListDirKey(connectionId, path)
    const startedAt = listDirInFlightSince.get(listDirKey)

    if (sessionLoading[path]) {
      if (!startedAt || now - startedAt > SSH_FILE_EXPLORER_STALE_LOAD_MS) {
        listDirInFlightSince.delete(listDirKey)
        set((s) => ({
          sftpLoading: {
            ...s.sftpLoading,
            [connectionId]: { ...(s.sftpLoading[connectionId] ?? {}), [path]: false }
          }
        }))
      } else {
        return
      }
    }

    if (!pageInfo?.hasMore || !pageInfo.cursor) return

    const connectResult = await get().connectSftpConnection(connectionId)
    if (connectResult.error) return

    set((s) => ({
      sftpLoading: {
        ...s.sftpLoading,
        [connectionId]: { ...(s.sftpLoading[connectionId] ?? {}), [path]: true }
      },
      sftpErrors: {
        ...s.sftpErrors,
        [connectionId]: { ...(s.sftpErrors[connectionId] ?? {}), [path]: null }
      }
    }))

    listDirInFlightSince.set(listDirKey, now)
    const release = await acquireListDirSlot(connectionId)

    try {
      const result = await ipcWithTimeout(
        ipcClient.invoke(IPC.SSH_FS_LIST_DIR, {
          connectionId,
          path,
          cursor: pageInfo.cursor,
          limit: SSH_FILE_EXPLORER_PAGE_SIZE
        }),
        IPC_LIST_DIR_TIMEOUT_MS
      )

      if (result && typeof result === 'object' && 'error' in result) {
        throw new Error(String((result as { error?: string }).error ?? 'Failed to load'))
      }

      const entries = Array.isArray(result)
        ? result
        : Array.isArray((result as ListDirPagedResult | undefined)?.entries)
          ? ((result as ListDirPagedResult).entries ?? [])
          : null

      if (!entries) throw new Error('Failed to load')

      const sorted = sortEntries(entries)
      const nextInfo = Array.isArray(result)
        ? { hasMore: false }
        : normalizePageInfo(result as ListDirPagedResult)

      set((s) => {
        const existing = s.sftpEntries[connectionId]?.[path] ?? []
        const combined = sortEntries([...existing, ...sorted])
        return {
          sftpEntries: {
            ...s.sftpEntries,
            [connectionId]: { ...(s.sftpEntries[connectionId] ?? {}), [path]: combined }
          },
          sftpPageInfo: {
            ...s.sftpPageInfo,
            [connectionId]: { ...(s.sftpPageInfo[connectionId] ?? {}), [path]: nextInfo }
          },
          sftpErrors: {
            ...s.sftpErrors,
            [connectionId]: { ...(s.sftpErrors[connectionId] ?? {}), [path]: null }
          }
        }
      })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load'
      set((s) => ({
        sftpErrors: {
          ...s.sftpErrors,
          [connectionId]: { ...(s.sftpErrors[connectionId] ?? {}), [path]: errorMessage }
        }
      }))
    } finally {
      release()
      listDirInFlightSince.delete(listDirKey)
      set((s) => ({
        sftpLoading: {
          ...s.sftpLoading,
          [connectionId]: { ...(s.sftpLoading[connectionId] ?? {}), [path]: false }
        }
      }))
    }
  },

  setSftpSelection: (paneId, entries) => {
    set((state) => ({
      sftpSelections: {
        ...state.sftpSelections,
        [paneId]: entries.reduce<Record<string, SshFileEntry>>((acc, entry) => {
          acc[entry.path] = entry
          return acc
        }, {})
      }
    }))
  },

  toggleSftpSelection: (paneId, entry) => {
    set((state) => {
      const current = { ...(state.sftpSelections[paneId] ?? {}) }
      if (current[entry.path]) delete current[entry.path]
      else current[entry.path] = entry
      return {
        sftpSelections: {
          ...state.sftpSelections,
          [paneId]: current
        }
      }
    })
  },

  clearSftpSelection: (paneId) => {
    set((state) => ({
      sftpSelections: {
        ...state.sftpSelections,
        [paneId]: {}
      }
    }))
  },

  setSftpConflictPolicy: (policy) => set({ sftpConflictPolicy: policy }),
  setSftpInspectorTab: (tab) => set({ sftpInspectorTab: tab })
})
