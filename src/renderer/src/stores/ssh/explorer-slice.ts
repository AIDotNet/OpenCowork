// Extracted from the former monolithic ssh-store.ts; behavior unchanged.
import type { StateCreator } from 'zustand'
import { ipcClient } from '../../lib/ipc/ipc-client'
import { IPC } from '../../lib/ipc/channels'
import type { SshFileEntry } from './types'
import {
  acquireListDirSlot,
  areStringSetsEqual,
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

export interface SshExplorerSlice {
  fileExplorerOpen: boolean
  fileExplorerPaths: Record<string, string>
  fileExplorerEntries: Record<string, Record<string, SshFileEntry[]>>
  fileExplorerPageInfo: Record<string, Record<string, FileExplorerPageInfo>>
  fileExplorerExpanded: Record<string, Set<string>>
  fileExplorerLoading: Record<string, Record<string, boolean>>
  fileExplorerErrors: Record<string, Record<string, string | null>>

  toggleFileExplorer: () => void
  setFileExplorerPath: (sessionId: string, path: string) => void
  loadFileExplorerEntries: (sessionId: string, path: string, force?: boolean) => Promise<void>
  loadMoreFileExplorerEntries: (sessionId: string, path: string) => Promise<void>
  toggleFileExplorerDir: (sessionId: string, dirPath: string) => void
  setFileExplorerExpanded: (sessionId: string, expanded: string[]) => void
}

export const createExplorerSlice: StateCreator<SshStore, [], [], SshExplorerSlice> = (
  set,
  get,
  _api
) => ({
  fileExplorerOpen: false,
  fileExplorerPaths: {},
  fileExplorerEntries: {},
  fileExplorerPageInfo: {},
  fileExplorerExpanded: {},
  fileExplorerLoading: {},
  fileExplorerErrors: {},

  // ── File explorer ──

  toggleFileExplorer: () => set((s) => ({ fileExplorerOpen: !s.fileExplorerOpen })),

  setFileExplorerPath: (sessionId, path) => {
    set((s) => ({ fileExplorerPaths: { ...s.fileExplorerPaths, [sessionId]: path } }))
  },

  loadFileExplorerEntries: async (sessionId, path, force = false) => {
    const state = get()
    const sessionLoading = state.fileExplorerLoading[sessionId] ?? {}
    const sessionEntries = state.fileExplorerEntries[sessionId] ?? {}
    const now = Date.now()
    const listDirKey = getListDirKey(sessionId, path)
    const startedAt = listDirInFlightSince.get(listDirKey)

    if (sessionLoading[path]) {
      if (!force && Object.prototype.hasOwnProperty.call(sessionEntries, path)) {
        console.debug('[SshStore] loadDir guard: already has entries, clearing loading', { path })
        listDirInFlightSince.delete(listDirKey)
        set((s) => ({
          fileExplorerLoading: {
            ...s.fileExplorerLoading,
            [sessionId]: { ...(s.fileExplorerLoading[sessionId] ?? {}), [path]: false }
          }
        }))
        return
      }
      if (!startedAt) {
        console.warn('[SshStore] Clearing orphaned loading state (no in-flight record)', {
          sessionId,
          path
        })
        listDirInFlightSince.delete(listDirKey)
        set((s) => ({
          fileExplorerLoading: {
            ...s.fileExplorerLoading,
            [sessionId]: { ...(s.fileExplorerLoading[sessionId] ?? {}), [path]: false }
          }
        }))
      } else if (now - startedAt > SSH_FILE_EXPLORER_STALE_LOAD_MS) {
        console.warn('[SshStore] Clearing stale list-dir loading state', { sessionId, path })
        listDirInFlightSince.delete(listDirKey)
        set((s) => ({
          fileExplorerLoading: {
            ...s.fileExplorerLoading,
            [sessionId]: { ...(s.fileExplorerLoading[sessionId] ?? {}), [path]: false }
          }
        }))
      } else {
        console.debug('[SshStore] loadDir guard: already loading, skipping', { path })
        return
      }
    }

    if (!force && Object.prototype.hasOwnProperty.call(sessionEntries, path)) return

    const connectionId = get().sessions[sessionId]?.connectionId
    console.debug('[SshStore] loadDir START', { sessionId, path, connectionId, force })

    set((s) => ({
      fileExplorerLoading: {
        ...s.fileExplorerLoading,
        [sessionId]: { ...(s.fileExplorerLoading[sessionId] ?? {}), [path]: true }
      },
      fileExplorerErrors: {
        ...s.fileExplorerErrors,
        [sessionId]: { ...(s.fileExplorerErrors[sessionId] ?? {}), [path]: null }
      }
    }))
    listDirInFlightSince.set(listDirKey, now)
    console.debug('[SshStore] loadDir: waiting for slot', { path })
    const release = await acquireListDirSlot(sessionId)
    console.debug('[SshStore] loadDir: slot acquired, invoking IPC', { path, connectionId })
    try {
      const result = await ipcWithTimeout(
        ipcClient.invoke(IPC.SSH_FS_LIST_DIR, {
          connectionId: get().sessions[sessionId]?.connectionId,
          path,
          limit: SSH_FILE_EXPLORER_PAGE_SIZE,
          refresh: force
        }),
        IPC_LIST_DIR_TIMEOUT_MS
      )

      console.debug('[SshStore] loadDir: IPC returned', {
        path,
        resultType: typeof result,
        isArray: Array.isArray(result),
        keys: result && typeof result === 'object' ? Object.keys(result) : null
      })

      if (result && typeof result === 'object' && 'error' in result) {
        const errorMessage = String((result as { error?: string }).error ?? 'Failed to load')
        console.error('[SshStore] loadDir ERROR from IPC:', { path, errorMessage })
        set((s) => ({
          fileExplorerErrors: {
            ...s.fileExplorerErrors,
            [sessionId]: { ...(s.fileExplorerErrors[sessionId] ?? {}), [path]: errorMessage }
          }
        }))
        return
      }

      const entries = Array.isArray(result)
        ? result
        : Array.isArray((result as ListDirPagedResult | undefined)?.entries)
          ? ((result as ListDirPagedResult).entries ?? [])
          : null

      if (entries) {
        const sorted = sortEntries(entries)
        const pageInfo = Array.isArray(result)
          ? { hasMore: false }
          : normalizePageInfo(result as ListDirPagedResult)
        console.debug('[SshStore] loadDir: setting entries', {
          path,
          count: sorted.length,
          pageInfo
        })
        set((s) => ({
          fileExplorerEntries: {
            ...s.fileExplorerEntries,
            [sessionId]: { ...(s.fileExplorerEntries[sessionId] ?? {}), [path]: sorted }
          },
          fileExplorerPageInfo: {
            ...s.fileExplorerPageInfo,
            [sessionId]: { ...(s.fileExplorerPageInfo[sessionId] ?? {}), [path]: pageInfo }
          },
          fileExplorerErrors: {
            ...s.fileExplorerErrors,
            [sessionId]: { ...(s.fileExplorerErrors[sessionId] ?? {}), [path]: null }
          }
        }))
      } else {
        console.error('[SshStore] loadDir: entries is null, result:', result)
        const errorMessage = 'Failed to load'
        set((s) => ({
          fileExplorerErrors: {
            ...s.fileExplorerErrors,
            [sessionId]: { ...(s.fileExplorerErrors[sessionId] ?? {}), [path]: errorMessage }
          }
        }))
      }
    } catch (err) {
      console.error('[SshStore] loadDir CATCH:', err)
      const errorMessage = err instanceof Error ? err.message : 'Failed to load'
      set((s) => ({
        fileExplorerErrors: {
          ...s.fileExplorerErrors,
          [sessionId]: { ...(s.fileExplorerErrors[sessionId] ?? {}), [path]: errorMessage }
        }
      }))
    } finally {
      console.debug('[SshStore] loadDir FINALLY', { path })
      release()
      listDirInFlightSince.delete(listDirKey)
      set((s) => ({
        fileExplorerLoading: {
          ...s.fileExplorerLoading,
          [sessionId]: { ...(s.fileExplorerLoading[sessionId] ?? {}), [path]: false }
        }
      }))
    }
  },

  loadMoreFileExplorerEntries: async (sessionId, path) => {
    const state = get()
    const sessionLoading = state.fileExplorerLoading[sessionId] ?? {}
    const now = Date.now()
    const listDirKey = getListDirKey(sessionId, path)
    const startedAt = listDirInFlightSince.get(listDirKey)

    if (sessionLoading[path]) {
      if (!startedAt) {
        console.warn('[SshStore] loadMore: clearing orphaned loading state', { sessionId, path })
        listDirInFlightSince.delete(listDirKey)
        set((s) => ({
          fileExplorerLoading: {
            ...s.fileExplorerLoading,
            [sessionId]: { ...(s.fileExplorerLoading[sessionId] ?? {}), [path]: false }
          }
        }))
      } else if (now - startedAt > SSH_FILE_EXPLORER_STALE_LOAD_MS) {
        console.warn('[SshStore] Clearing stale list-dir loading state', { sessionId, path })
        listDirInFlightSince.delete(listDirKey)
        set((s) => ({
          fileExplorerLoading: {
            ...s.fileExplorerLoading,
            [sessionId]: { ...(s.fileExplorerLoading[sessionId] ?? {}), [path]: false }
          }
        }))
      } else {
        return
      }
    }

    const pageInfo = state.fileExplorerPageInfo[sessionId]?.[path]
    if (!pageInfo?.hasMore || !pageInfo.cursor) return

    set((s) => ({
      fileExplorerLoading: {
        ...s.fileExplorerLoading,
        [sessionId]: { ...(s.fileExplorerLoading[sessionId] ?? {}), [path]: true }
      },
      fileExplorerErrors: {
        ...s.fileExplorerErrors,
        [sessionId]: { ...(s.fileExplorerErrors[sessionId] ?? {}), [path]: null }
      }
    }))

    listDirInFlightSince.set(listDirKey, now)
    const release = await acquireListDirSlot(sessionId)
    try {
      const result = await ipcWithTimeout(
        ipcClient.invoke(IPC.SSH_FS_LIST_DIR, {
          connectionId: get().sessions[sessionId]?.connectionId,
          path,
          cursor: pageInfo.cursor,
          limit: SSH_FILE_EXPLORER_PAGE_SIZE
        }),
        IPC_LIST_DIR_TIMEOUT_MS
      )

      if (result && typeof result === 'object' && 'error' in result) {
        const errorMessage = String((result as { error?: string }).error ?? 'Failed to load')
        console.error('[SshStore] Failed to load file entries:', result)
        set((s) => ({
          fileExplorerErrors: {
            ...s.fileExplorerErrors,
            [sessionId]: { ...(s.fileExplorerErrors[sessionId] ?? {}), [path]: errorMessage }
          }
        }))
        return
      }

      const entries = Array.isArray(result)
        ? result
        : Array.isArray((result as ListDirPagedResult | undefined)?.entries)
          ? ((result as ListDirPagedResult).entries ?? [])
          : null

      if (entries) {
        const sorted = sortEntries(entries)
        set((s) => {
          const existing = s.fileExplorerEntries[sessionId]?.[path] ?? []
          const combined = sortEntries([...existing, ...sorted])
          const nextInfo = Array.isArray(result)
            ? { hasMore: false }
            : normalizePageInfo(result as ListDirPagedResult)
          return {
            fileExplorerEntries: {
              ...s.fileExplorerEntries,
              [sessionId]: { ...(s.fileExplorerEntries[sessionId] ?? {}), [path]: combined }
            },
            fileExplorerPageInfo: {
              ...s.fileExplorerPageInfo,
              [sessionId]: { ...(s.fileExplorerPageInfo[sessionId] ?? {}), [path]: nextInfo }
            },
            fileExplorerErrors: {
              ...s.fileExplorerErrors,
              [sessionId]: { ...(s.fileExplorerErrors[sessionId] ?? {}), [path]: null }
            }
          }
        })
      } else {
        const errorMessage = 'Failed to load'
        set((s) => ({
          fileExplorerErrors: {
            ...s.fileExplorerErrors,
            [sessionId]: { ...(s.fileExplorerErrors[sessionId] ?? {}), [path]: errorMessage }
          }
        }))
      }
    } catch (err) {
      console.error('[SshStore] Failed to load file entries:', err)
      const errorMessage = err instanceof Error ? err.message : 'Failed to load'
      set((s) => ({
        fileExplorerErrors: {
          ...s.fileExplorerErrors,
          [sessionId]: { ...(s.fileExplorerErrors[sessionId] ?? {}), [path]: errorMessage }
        }
      }))
    } finally {
      release()
      listDirInFlightSince.delete(listDirKey)
      set((s) => ({
        fileExplorerLoading: {
          ...s.fileExplorerLoading,
          [sessionId]: { ...(s.fileExplorerLoading[sessionId] ?? {}), [path]: false }
        }
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
        fileExplorerExpanded: { ...s.fileExplorerExpanded, [sessionId]: next }
      }
    })
  },

  setFileExplorerExpanded: (sessionId, expanded) => {
    set((s) => {
      const next = new Set(expanded)
      if (areStringSetsEqual(s.fileExplorerExpanded[sessionId], next)) return s
      return {
        fileExplorerExpanded: { ...s.fileExplorerExpanded, [sessionId]: next }
      }
    })
  }
})
