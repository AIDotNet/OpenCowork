import { create } from 'zustand'
import { toast } from 'sonner'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'

export interface LocalTerminalTab {
  id: string
  title: string
  cwd: string
  shell: string
  createdAt: number
  status: 'running' | 'exited' | 'error'
  exitCode?: number
}

interface TerminalStore {
  tabs: LocalTerminalTab[]
  activeTabId: string | null
  initialized: boolean
  init: () => void
  createTab: (cwd?: string) => Promise<string | null>
  closeTab: (id: string) => Promise<void>
  setActiveTab: (id: string) => void
  markExited: (id: string, exitCode?: number) => void
}

let subscribed = false

function buildNextTitle(tabs: LocalTerminalTab[]): string {
  const nextIndex = tabs.length + 1
  return nextIndex === 1 ? 'Terminal' : `Terminal ${nextIndex}`
}

export const useTerminalStore = create<TerminalStore>()((set, get) => ({
  tabs: [],
  activeTabId: null,
  initialized: false,
  init: () => {
    if (subscribed) {
      if (!get().initialized) set({ initialized: true })
      return
    }

    subscribed = true

    ipcClient.on(IPC.TERMINAL_EXIT, (payload) => {
      const data = payload as { id?: string; exitCode?: number }
      if (!data?.id) return
      get().markExited(data.id, data.exitCode)
    })

    set({ initialized: true })
  },
  createTab: async (cwd) => {
    const title = buildNextTitle(get().tabs)
    const result = (await ipcClient.invoke(IPC.TERMINAL_CREATE, {
      cwd,
      title
    })) as
      | {
          id?: string
          cwd?: string
          shell?: string
          createdAt?: number
          title?: string
          error?: string
        }
      | undefined

    if (!result?.id || result.error) {
      toast.error('创建终端失败', {
        description: result?.error || '未知错误'
      })
      return null
    }

    const tab: LocalTerminalTab = {
      id: result.id,
      title: result.title || title,
      cwd: result.cwd || cwd || '',
      shell: result.shell || '',
      createdAt: result.createdAt || Date.now(),
      status: 'running'
    }

    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id
    }))

    return tab.id
  },
  closeTab: async (id) => {
    await ipcClient.invoke(IPC.TERMINAL_KILL, { id })
    set((state) => {
      const idx = state.tabs.findIndex((tab) => tab.id === id)
      const tabs = state.tabs.filter((tab) => tab.id !== id)
      return {
        tabs,
        activeTabId:
          state.activeTabId === id
            ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null)
            : state.activeTabId
      }
    })
  },
  setActiveTab: (id) => set({ activeTabId: id }),
  markExited: (id, exitCode) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id
          ? {
              ...tab,
              status: exitCode === 0 ? 'exited' : 'error',
              exitCode
            }
          : tab
      )
    }))
}))
