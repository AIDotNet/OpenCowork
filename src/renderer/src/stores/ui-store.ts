import { create } from 'zustand'



export type AppMode = 'chat' | 'cowork' | 'code'

export type RightPanelTab = 'steps' | 'team' | 'artifacts' | 'context' | 'skills' | 'files'

export type PreviewSource = 'file' | 'dev-server' | 'markdown'

export interface PreviewPanelState {
  source: PreviewSource
  filePath: string
  viewMode: 'preview' | 'code'
  viewerType: string
  port?: number
  projectDir?: string
  /** In-memory markdown content (used when source is 'markdown') */
  markdownContent?: string
  /** Title for markdown preview */
  markdownTitle?: string
}



export type DetailPanelContent =

  | { type: 'team' }

  | { type: 'subagent'; toolUseId?: string }

  | { type: 'document'; title: string; content: string }

  | { type: 'report'; title: string; data: unknown }



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



  /** Detail panel (between chat and right panel) */

  detailPanelOpen: boolean

  detailPanelContent: DetailPanelContent | null

  openDetailPanel: (content: DetailPanelContent) => void

  closeDetailPanel: () => void

  /** Preview panel */
  previewPanelOpen: boolean
  previewPanelState: PreviewPanelState | null
  openFilePreview: (filePath: string, viewMode?: 'preview' | 'code') => void
  openDevServerPreview: (projectDir: string, port: number) => void
  openMarkdownPreview: (title: string, content: string) => void
  closePreviewPanel: () => void
  setPreviewViewMode: (mode: 'preview' | 'code') => void
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



  detailPanelOpen: false,

  detailPanelContent: null,

  openDetailPanel: (content) => set({ detailPanelOpen: true, detailPanelContent: content }),

  closeDetailPanel: () => set({ detailPanelOpen: false, detailPanelContent: null }),

  previewPanelOpen: false,
  previewPanelState: null,
  openFilePreview: (filePath, viewMode) => {
    const ext = filePath.lastIndexOf('.') >= 0 ? filePath.slice(filePath.lastIndexOf('.')).toLowerCase() : ''
    const previewExts = new Set(['.html', '.htm'])
    const spreadsheetExts = new Set(['.csv', '.tsv', '.xls', '.xlsx'])
    let viewerType = 'fallback'
    if (previewExts.has(ext)) viewerType = 'html'
    else if (spreadsheetExts.has(ext)) viewerType = 'spreadsheet'
    set({
      previewPanelOpen: true,
      previewPanelState: {
        source: 'file',
        filePath,
        viewMode: viewMode ?? (viewerType === 'html' ? 'preview' : 'code'),
        viewerType,
      },
      leftSidebarOpen: false,
      rightPanelOpen: false,
    })
  },
  openDevServerPreview: (projectDir, port) => set({
    previewPanelOpen: true,
    previewPanelState: {
      source: 'dev-server',
      filePath: '',
      viewMode: 'preview',
      viewerType: 'dev-server',
      port,
      projectDir,
    },
    leftSidebarOpen: false,
  }),
  openMarkdownPreview: (title, content) => set({
    previewPanelOpen: true,
    previewPanelState: {
      source: 'markdown',
      filePath: '',
      viewMode: 'preview',
      viewerType: 'markdown',
      markdownContent: content,
      markdownTitle: title,
    },
    leftSidebarOpen: false,
  }),
  closePreviewPanel: () => set({ previewPanelOpen: false, previewPanelState: null }),
  setPreviewViewMode: (mode) => set((s) => ({
    previewPanelState: s.previewPanelState ? { ...s.previewPanelState, viewMode: mode } : null,
  })),
}))

