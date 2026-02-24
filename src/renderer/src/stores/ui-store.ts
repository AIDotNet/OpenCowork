import { create } from 'zustand'



export type AppMode = 'chat' | 'cowork' | 'code'

export type NavItem = 'chat' | 'plugins' | 'skills'

export type RightPanelTab = 'steps' | 'team' | 'artifacts' | 'context' | 'skills' | 'files' | 'plan' | 'cron'

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



export type SettingsTab = 'general' | 'provider' | 'plugin' | 'mcp' | 'model' | 'about'

export type DetailPanelContent =

  | { type: 'team' }

  | { type: 'subagent'; toolUseId?: string }

  | { type: 'terminal'; processId: string }

  | { type: 'document'; title: string; content: string }

  | { type: 'report'; title: string; data: unknown }



interface UIStore {

  mode: AppMode

  setMode: (mode: AppMode) => void

  activeNavItem: NavItem
  setActiveNavItem: (item: NavItem) => void



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

  settingsPageOpen: boolean
  settingsTab: SettingsTab
  openSettingsPage: (tab?: SettingsTab) => void
  closeSettingsPage: () => void
  setSettingsTab: (tab: SettingsTab) => void

  skillsPageOpen: boolean
  openSkillsPage: () => void
  closeSkillsPage: () => void



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

  /** Selected files in file tree panel */
  selectedFiles: string[]
  setSelectedFiles: (files: string[]) => void
  toggleFileSelection: (filePath: string) => void
  clearSelectedFiles: () => void

  /** Plan mode state */
  planMode: boolean
  enterPlanMode: () => void
  exitPlanMode: () => void
}



export const useUIStore = create<UIStore>((set) => ({

  mode: 'chat',

  setMode: (mode) => set({ mode, rightPanelOpen: mode === 'cowork' }),

  activeNavItem: 'chat',
  setActiveNavItem: (item) => set({ activeNavItem: item, leftSidebarOpen: true }),



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

  settingsPageOpen: false,
  settingsTab: 'general',
  openSettingsPage: (tab) => set({ settingsPageOpen: true, settingsTab: tab ?? 'general', leftSidebarOpen: false, skillsPageOpen: false }),
  closeSettingsPage: () => set({ settingsPageOpen: false }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),

  skillsPageOpen: false,
  openSkillsPage: () => set({ skillsPageOpen: true, settingsPageOpen: false, leftSidebarOpen: false }),
  closeSkillsPage: () => set({ skillsPageOpen: false }),



  shortcutsOpen: false,

  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),



  pendingInsertText: null,

  setPendingInsertText: (text) => set({ pendingInsertText: text }),



  detailPanelOpen: false,

  detailPanelContent: null,

  openDetailPanel: (content) => set({ detailPanelOpen: true, detailPanelContent: content, rightPanelOpen: false }),

  closeDetailPanel: () => set({ detailPanelOpen: false, detailPanelContent: null }),

  previewPanelOpen: false,
  previewPanelState: null,
  openFilePreview: (filePath, viewMode) => {
    const ext = filePath.lastIndexOf('.') >= 0 ? filePath.slice(filePath.lastIndexOf('.')).toLowerCase() : ''
    const previewExts = new Set(['.html', '.htm'])
    const spreadsheetExts = new Set(['.csv', '.tsv', '.xls', '.xlsx'])
    const markdownExts = new Set(['.md', '.mdx', '.markdown'])
    const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico'])
    const docxExts = new Set(['.docx'])
    const pdfExts = new Set(['.pdf'])
    let viewerType = 'fallback'
    if (previewExts.has(ext)) viewerType = 'html'
    else if (spreadsheetExts.has(ext)) viewerType = 'spreadsheet'
    else if (markdownExts.has(ext)) viewerType = 'markdown'
    else if (imageExts.has(ext)) viewerType = 'image'
    else if (docxExts.has(ext)) viewerType = 'docx'
    else if (pdfExts.has(ext)) viewerType = 'pdf'
    const previewTypes = new Set(['html', 'markdown', 'docx', 'pdf', 'image', 'spreadsheet'])
    const defaultMode = previewTypes.has(viewerType) ? 'preview' : 'code'
    set({
      previewPanelOpen: true,
      previewPanelState: {
        source: 'file',
        filePath,
        viewMode: viewMode ?? defaultMode,
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
    rightPanelOpen: false,
  }),
  closePreviewPanel: () => set({ previewPanelOpen: false, previewPanelState: null }),
  setPreviewViewMode: (mode) => set((s) => ({
    previewPanelState: s.previewPanelState ? { ...s.previewPanelState, viewMode: mode } : null,
  })),

  selectedFiles: [],
  setSelectedFiles: (files) => set({ selectedFiles: files }),
  toggleFileSelection: (filePath) => set((s) => {
    const isSelected = s.selectedFiles.includes(filePath)
    return {
      selectedFiles: isSelected
        ? s.selectedFiles.filter(f => f !== filePath)
        : [...s.selectedFiles, filePath]
    }
  }),
  clearSelectedFiles: () => set({ selectedFiles: [] }),

  planMode: false,
  enterPlanMode: () => set({ planMode: true, rightPanelTab: 'plan', rightPanelOpen: true }),
  exitPlanMode: () => set({ planMode: false }),
}))

