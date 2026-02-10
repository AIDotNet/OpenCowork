import { create } from 'zustand'

export type AppMode = 'chat' | 'cowork' | 'code'
export type RightPanelTab = 'steps' | 'team' | 'artifacts' | 'context' | 'skills' | 'files'

interface UIStore {
  mode: AppMode
  setMode: (mode: AppMode) => void

  leftSidebarOpen: boolean
  toggleLeftSidebar: () => void
  setLeftSidebarOpen: (open: boolean) => void

  rightPanelOpen: boolean
  toggleRightPanel: () => void
  setRightPanelOpen: (open: boolean) => void

  rightPanelTab: RightPanelTab
  setRightPanelTab: (tab: RightPanelTab) => void

  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void

  shortcutsOpen: boolean
  setShortcutsOpen: (open: boolean) => void

  /** Text to insert into chat input (consumed by InputArea) */
  pendingInsertText: string | null
  setPendingInsertText: (text: string | null) => void
}

export const useUIStore = create<UIStore>((set) => ({
  mode: 'chat',
  setMode: (mode) => set({ mode, rightPanelOpen: mode === 'cowork' }),

  leftSidebarOpen: true,
  toggleLeftSidebar: () => set((s) => ({ leftSidebarOpen: !s.leftSidebarOpen })),
  setLeftSidebarOpen: (open) => set({ leftSidebarOpen: open }),

  rightPanelOpen: false,
  toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
  setRightPanelOpen: (open) => set({ rightPanelOpen: open }),

  rightPanelTab: 'steps',
  setRightPanelTab: (tab) => set({ rightPanelTab: tab }),

  settingsOpen: false,
  setSettingsOpen: (open) => set({ settingsOpen: open }),

  shortcutsOpen: false,
  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),

  pendingInsertText: null,
  setPendingInsertText: (text) => set({ pendingInsertText: text }),
}))
