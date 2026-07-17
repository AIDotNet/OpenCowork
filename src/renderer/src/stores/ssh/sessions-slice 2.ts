// Extracted from the former monolithic ssh-store.ts; behavior unchanged.
import type { StateCreator } from 'zustand'
import { ipcClient } from '../../lib/ipc/ipc-client'
import { IPC } from '../../lib/ipc/channels'
import { toast } from 'sonner'
import i18n from '@renderer/locales'
import type { SshConnectLogEntry, SshSession, SshSessionFile, SshTab } from './types'
import { ensureSshEventsSubscribed } from './events'
import type { SshStore } from './store'

export interface SshSessionsSlice {
  sessions: Record<string, SshSession>
  activeTerminalId: string | null
  selectedConnectionId: string | null

  openTabs: SshTab[]
  activeTabId: string | null

  sessionFiles: Record<string, SshSessionFile[]>
  activeSessionFile: Record<string, string | null>

  // Protocol-level connection log, keyed by connectionId.
  connectLogs: Record<string, SshConnectLogEntry[]>
  appendConnectLog: (connectionId: string, entry: SshConnectLogEntry, reset: boolean) => void

  connect: (connectionId: string) => Promise<string | null>
  openTerminalTab: (connectionId: string, projectId?: string | null) => Promise<string | null>
  disconnect: (sessionId: string) => Promise<void>
  setActiveTerminal: (sessionId: string | null) => void
  setSelectedConnection: (connectionId: string | null) => void
  updateSessionStatus: (sessionId: string, status: SshSession['status'], error?: string) => void
  removeSession: (sessionId: string) => void

  openTab: (tab: SshTab) => void
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string | null) => void
  setTabSurface: (tabId: string, surface: 'bottom' | 'right') => void
  replaceTab: (tabId: string, tab: SshTab) => void

  openSessionFile: (sessionId: string, file: SshSessionFile) => void
  closeSessionFile: (sessionId: string, filePath: string) => void
  setActiveSessionFile: (sessionId: string, filePath: string | null) => void
}

export const createSessionsSlice: StateCreator<SshStore, [], [], SshSessionsSlice> = (
  set,
  get,
  api
) => ({
  sessions: {},
  activeTerminalId: null,
  selectedConnectionId: null,

  openTabs: [],
  activeTabId: null,

  sessionFiles: {},
  activeSessionFile: {},

  connectLogs: {},
  appendConnectLog: (connectionId, entry, reset) => {
    set((s) => {
      const prev = reset ? [] : (s.connectLogs[connectionId] ?? [])
      // Cap so a chatty handshake can't grow unbounded.
      const next = [...prev, entry].slice(-500)
      return { connectLogs: { ...s.connectLogs, [connectionId]: next } }
    })
  },

  // ── Terminal sessions ──

  connect: async (connectionId) => {
    ensureSshEventsSubscribed(api)
    const result = (await ipcClient.invoke(IPC.SSH_CONNECT, { connectionId })) as {
      sessionId?: string
      error?: string
    }
    if (result.error || !result.sessionId) {
      if (result.error) {
        toast.error(i18n.t('connectionFailed', { ns: 'ssh' }), { description: result.error })
      }
      return null
    }
    const session: SshSession = {
      id: result.sessionId,
      connectionId,
      status: 'connecting'
    }
    set((s) => {
      const existing = s.sessions[result.sessionId!]
      return {
        sessions: {
          ...s.sessions,
          [result.sessionId!]: existing && existing.status !== 'connecting' ? existing : session
        },
        activeTerminalId: result.sessionId!,
        connections: s.connections.map((c) =>
          c.id === connectionId ? { ...c, lastConnectedAt: Date.now() } : c
        )
      }
    })
    return result.sessionId
  },

  openTerminalTab: async (connectionId, projectId) => {
    const conn = get().connections.find((item) => item.id === connectionId)
    if (!conn) return null

    const pendingTabId = `pending-${connectionId}-${Date.now()}`
    set((state) => ({
      openTabs: [
        ...state.openTabs,
        {
          id: pendingTabId,
          type: 'terminal',
          sessionId: null,
          connectionId,
          connectionName: conn.name,
          title: conn.name,
          projectId: projectId ?? null,
          surface: 'bottom',
          status: 'connecting'
        }
      ],
      activeTabId: pendingTabId,
      workspaceSection: 'terminal'
    }))

    const sessionId = await get().connect(connectionId)
    if (!sessionId) {
      get().closeTab(pendingTabId)
      return null
    }

    const stillOpen = get().openTabs.find((tab) => tab.id === pendingTabId)
    if (!stillOpen) {
      await get().disconnect(sessionId)
      return null
    }

    const resolvedTabId = `tab-${sessionId}`
    get().replaceTab(pendingTabId, {
      id: resolvedTabId,
      type: 'terminal',
      sessionId,
      connectionId,
      connectionName: conn.name,
      title: conn.name,
      projectId: projectId ?? null,
      surface: stillOpen.surface ?? 'bottom'
    })
    get().setActiveTerminal(sessionId)
    return resolvedTabId
  },

  disconnect: async (sessionId) => {
    await ipcClient.invoke(IPC.SSH_DISCONNECT, { sessionId })
    set((s) => {
      const updated = { ...s.sessions }
      delete updated[sessionId]
      const remainingTabs = s.openTabs.filter((t) => t.sessionId !== sessionId)
      const closedActiveTab =
        s.activeTabId && s.openTabs.find((t) => t.id === s.activeTabId)?.sessionId === sessionId
      const sessionFiles = { ...s.sessionFiles }
      const activeSessionFile = { ...s.activeSessionFile }
      delete sessionFiles[sessionId]
      delete activeSessionFile[sessionId]
      return {
        sessions: updated,
        activeTerminalId: s.activeTerminalId === sessionId ? null : s.activeTerminalId,
        openTabs: remainingTabs,
        sessionFiles,
        activeSessionFile,
        activeTabId: closedActiveTab
          ? (remainingTabs[remainingTabs.length - 1]?.id ?? null)
          : s.activeTabId
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
          [sessionId]: { ...existing, status, error }
        }
      }
    })
  },

  removeSession: (sessionId) => {
    set((s) => {
      const updated = { ...s.sessions }
      delete updated[sessionId]
      const remainingTabs = s.openTabs.filter((t) => t.sessionId !== sessionId)
      const closedActiveTab =
        s.activeTabId && s.openTabs.find((t) => t.id === s.activeTabId)?.sessionId === sessionId
      const sessionFiles = { ...s.sessionFiles }
      const activeSessionFile = { ...s.activeSessionFile }
      delete sessionFiles[sessionId]
      delete activeSessionFile[sessionId]
      return {
        sessions: updated,
        activeTerminalId: s.activeTerminalId === sessionId ? null : s.activeTerminalId,
        openTabs: remainingTabs,
        sessionFiles,
        activeSessionFile,
        activeTabId: closedActiveTab
          ? (remainingTabs[remainingTabs.length - 1]?.id ?? null)
          : s.activeTabId
      }
    })
  },

  // ── Tab management ──

  openTab: (tab) => {
    set((s) => {
      const exists = s.openTabs.find((t) => t.id === tab.id)
      if (exists) return { activeTabId: tab.id, workspaceSection: 'terminal' }
      return {
        openTabs: [...s.openTabs, tab],
        activeTabId: tab.id,
        workspaceSection: 'terminal'
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
        workspaceSection:
          wasActive && remaining.length === 0 && s.workspaceSection === 'terminal'
            ? 'hosts'
            : s.workspaceSection
      }
    })
  },

  setActiveTab: (tabId) =>
    set((s) => ({
      activeTabId: tabId,
      workspaceSection: tabId ? 'terminal' : s.workspaceSection
    })),

  setTabSurface: (tabId, surface) =>
    set((s) => ({
      openTabs: s.openTabs.map((tab) => (tab.id === tabId ? { ...tab, surface } : tab))
    })),

  replaceTab: (tabId, tab) => {
    set((s) => {
      const openTabs = s.openTabs.map((t) => (t.id === tabId ? tab : t))
      const activeTabId = s.activeTabId === tabId ? tab.id : s.activeTabId
      return { openTabs, activeTabId, workspaceSection: 'terminal' }
    })
  },

  // ── Session file tabs ──
  openSessionFile: (sessionId, file) => {
    set((s) => {
      const current = s.sessionFiles[sessionId] ?? []
      const exists = current.some((item) => item.path === file.path)
      return {
        sessionFiles: exists
          ? s.sessionFiles
          : { ...s.sessionFiles, [sessionId]: [...current, file] },
        activeSessionFile: { ...s.activeSessionFile, [sessionId]: file.path }
      }
    })
  },

  closeSessionFile: (sessionId, filePath) => {
    set((s) => {
      const current = s.sessionFiles[sessionId] ?? []
      const idx = current.findIndex((item) => item.path === filePath)
      if (idx === -1) return {}
      const remaining = current.filter((item) => item.path !== filePath)
      const wasActive = s.activeSessionFile[sessionId] === filePath
      const nextActive = wasActive
        ? (remaining[idx]?.path ?? remaining[idx - 1]?.path ?? remaining[0]?.path ?? null)
        : s.activeSessionFile[sessionId]
      return {
        sessionFiles: { ...s.sessionFiles, [sessionId]: remaining },
        activeSessionFile: { ...s.activeSessionFile, [sessionId]: nextActive }
      }
    })
  },

  setActiveSessionFile: (sessionId, filePath) => {
    set((s) => ({
      activeSessionFile: { ...s.activeSessionFile, [sessionId]: filePath }
    }))
  }
})
