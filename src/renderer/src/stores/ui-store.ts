import { create } from 'zustand'
import {
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  clampLeftSidebarWidth
} from '@renderer/components/layout/right-panel-defs'

export type AppMode = 'chat' | 'clarify' | 'cowork' | 'code'

export type NavItem =
  | 'chat'
  | 'channels'
  | 'resources'
  | 'skills'
  | 'draw'
  | 'translate'
  | 'ssh'
  | 'tasks'

export type ChatView = 'home' | 'session'

export type RightPanelTab = 'steps' | 'team' | 'artifacts' | 'context' | 'skills' | 'files' | 'plan'
export type RightPanelSection = 'execution' | 'resources' | 'collaboration' | 'monitoring'

export type PreviewSource = 'file' | 'dev-server' | 'markdown'

export type AutoModelRoute = 'main' | 'fast'

export interface AutoModelSelectionStatus {
  source: 'auto'
  target: AutoModelRoute
  providerId?: string
  modelId?: string
  providerName?: string
  modelName?: string
  fallbackReason?: string
  selectedAt: number
}

export type AutoModelRoutingState = 'idle' | 'routing'

export interface PreviewPanelState {
  source: PreviewSource
  filePath: string
  viewMode: 'preview' | 'code'
  viewerType: string
  sshConnectionId?: string
  port?: number
  projectDir?: string
  /** In-memory markdown content (used when source is 'markdown') */
  markdownContent?: string
  /** Title for markdown preview */
  markdownTitle?: string
}

export type SettingsTab =
  | 'general'
  | 'memory'
  | 'provider'
  | 'model'
  | 'plugin'
  | 'channel'
  | 'mcp'
  | 'websearch'
  | 'skillsmarket'
  | 'about'

export type DetailPanelContent =
  | { type: 'team' }
  | { type: 'subagent'; toolUseId?: string; text?: string }
  | { type: 'terminal'; processId: string }
  | { type: 'document'; title: string; content: string }
  | { type: 'report'; title: string; data: unknown }

function buildFilePreviewState(
  filePath: string,
  viewMode?: 'preview' | 'code',
  sshConnectionId?: string
): PreviewPanelState {
  const ext =
    filePath.lastIndexOf('.') >= 0 ? filePath.slice(filePath.lastIndexOf('.')).toLowerCase() : ''
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

  return {
    source: 'file',
    filePath,
    viewMode: viewMode ?? defaultMode,
    viewerType,
    sshConnectionId: sshConnectionId || undefined
  }
}

function resolveScopedSessionId(
  explicitSessionId: string | null | undefined,
  currentSessionId: string | null
): string | null {
  return explicitSessionId ?? currentSessionId
}

interface UIStore {
  mode: AppMode

  setMode: (mode: AppMode) => void

  activeNavItem: NavItem
  setActiveNavItem: (item: NavItem) => void

  leftSidebarOpen: boolean
  leftSidebarWidth: number

  toggleLeftSidebar: () => void

  setLeftSidebarOpen: (open: boolean) => void
  setLeftSidebarWidth: (width: number) => void

  rightPanelOpen: boolean

  toggleRightPanel: () => void

  setRightPanelOpen: (open: boolean) => void

  rightPanelTab: RightPanelTab

  setRightPanelTab: (tab: RightPanelTab) => void

  rightPanelSection: RightPanelSection

  setRightPanelSection: (section: RightPanelSection) => void

  rightPanelWidth: number

  setRightPanelWidth: (width: number) => void

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

  resourcesPageOpen: boolean
  openResourcesPage: () => void
  closeResourcesPage: () => void

  translatePageOpen: boolean
  openTranslatePage: () => void
  closeTranslatePage: () => void

  drawPageOpen: boolean
  openDrawPage: () => void
  closeDrawPage: () => void

  sshPageOpen: boolean
  openSshPage: () => void
  closeSshPage: () => void

  tasksPageOpen: boolean
  openTasksPage: () => void
  closeTasksPage: () => void

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
  previewPanelsBySession: Record<string, PreviewPanelState | null>
  openFilePreview: (
    filePath: string,
    viewMode?: 'preview' | 'code',
    sshConnectionId?: string,
    sessionId?: string | null
  ) => void
  openDevServerPreview: (projectDir: string, port: number, sessionId?: string | null) => void
  openMarkdownPreview: (title: string, content: string, sessionId?: string | null) => void
  closePreviewPanel: (sessionId?: string | null) => void
  setPreviewViewMode: (mode: 'preview' | 'code', sessionId?: string | null) => void

  /** Session-scoped UI state */
  activeScopedSessionId: string | null
  syncSessionScopedState: (sessionId: string | null) => void
  autoModelSelectionsBySession: Record<string, AutoModelSelectionStatus | null>
  autoModelRoutingStatesBySession: Record<string, AutoModelRoutingState>
  setAutoModelSelection: (sessionId: string, status: AutoModelSelectionStatus | null) => void
  getAutoModelSelection: (sessionId?: string | null) => AutoModelSelectionStatus | null
  setAutoModelRoutingState: (sessionId: string, status: AutoModelRoutingState) => void
  getAutoModelRoutingState: (sessionId?: string | null) => AutoModelRoutingState

  /** Selected files in file tree panel */
  selectedFiles: string[]
  setSelectedFiles: (files: string[]) => void
  toggleFileSelection: (filePath: string) => void
  clearSelectedFiles: () => void

  /** Plan mode state */
  planMode: boolean
  planModesBySession: Record<string, boolean>
  isPlanModeEnabled: (sessionId?: string | null) => boolean
  enterPlanMode: (sessionId?: string | null) => void
  exitPlanMode: (sessionId?: string | null) => void

  /** Chat view navigation: 'home' = /chat homepage, 'session' = /chat/:id */
  chatView: ChatView
  navigateToHome: () => void
  navigateToSession: () => void
}

export const useUIStore = create<UIStore>((set, get) => ({
  mode: 'cowork',

  setMode: (mode) => set({ mode, rightPanelOpen: mode === 'cowork' }),

  activeNavItem: 'chat',
  setActiveNavItem: (item) => set({ activeNavItem: item, leftSidebarOpen: true }),

  leftSidebarOpen: true,
  leftSidebarWidth: LEFT_SIDEBAR_DEFAULT_WIDTH,

  toggleLeftSidebar: () => set((s) => ({ leftSidebarOpen: !s.leftSidebarOpen })),

  setLeftSidebarOpen: (open) => set({ leftSidebarOpen: open }),
  setLeftSidebarWidth: (width) => set({ leftSidebarWidth: clampLeftSidebarWidth(width) }),

  rightPanelOpen: false,

  toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),

  setRightPanelOpen: (open) => set({ rightPanelOpen: open }),

  rightPanelTab: 'steps',

  setRightPanelTab: (tab) => set({ rightPanelTab: tab }),

  rightPanelSection: 'execution',

  setRightPanelSection: (section) => set({ rightPanelSection: section }),

  rightPanelWidth: 384,

  setRightPanelWidth: (width) => set({ rightPanelWidth: width }),

  settingsOpen: false,

  setSettingsOpen: (open) => set({ settingsOpen: open }),

  settingsPageOpen: false,
  settingsTab: 'general',
  openSettingsPage: (tab) =>
    set({
      settingsPageOpen: true,
      settingsTab: tab ?? 'general',
      leftSidebarOpen: false,
      skillsPageOpen: false,
      resourcesPageOpen: false,
      translatePageOpen: false,
      drawPageOpen: false,
      sshPageOpen: false,
      tasksPageOpen: false
    }),
  closeSettingsPage: () => set({ settingsPageOpen: false }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),

  skillsPageOpen: false,
  openSkillsPage: () =>
    set({
      skillsPageOpen: true,
      resourcesPageOpen: false,
      settingsPageOpen: false,
      translatePageOpen: false,
      drawPageOpen: false,
      sshPageOpen: false,
      tasksPageOpen: false,
      leftSidebarOpen: false
    }),
  closeSkillsPage: () => set({ skillsPageOpen: false }),

  resourcesPageOpen: false,
  openResourcesPage: () =>
    set({
      resourcesPageOpen: true,
      settingsPageOpen: false,
      skillsPageOpen: false,
      translatePageOpen: false,
      drawPageOpen: false,
      sshPageOpen: false,
      tasksPageOpen: false,
      leftSidebarOpen: false
    }),
  closeResourcesPage: () => set({ resourcesPageOpen: false }),

  translatePageOpen: false,
  openTranslatePage: () =>
    set({
      translatePageOpen: true,
      settingsPageOpen: false,
      skillsPageOpen: false,
      resourcesPageOpen: false,
      drawPageOpen: false,
      sshPageOpen: false,
      tasksPageOpen: false,
      leftSidebarOpen: false
    }),
  closeTranslatePage: () => set({ translatePageOpen: false }),

  drawPageOpen: false,
  openDrawPage: () =>
    set({
      drawPageOpen: true,
      settingsPageOpen: false,
      skillsPageOpen: false,
      resourcesPageOpen: false,
      translatePageOpen: false,
      sshPageOpen: false,
      tasksPageOpen: false,
      leftSidebarOpen: false
    }),
  closeDrawPage: () => set({ drawPageOpen: false }),

  sshPageOpen: false,
  openSshPage: () =>
    set({
      sshPageOpen: true,
      settingsPageOpen: false,
      skillsPageOpen: false,
      resourcesPageOpen: false,
      translatePageOpen: false,
      drawPageOpen: false,
      tasksPageOpen: false,
      leftSidebarOpen: false
    }),
  closeSshPage: () => set({ sshPageOpen: false }),

  tasksPageOpen: false,
  openTasksPage: () =>
    set({
      tasksPageOpen: true,
      settingsPageOpen: false,
      skillsPageOpen: false,
      resourcesPageOpen: false,
      translatePageOpen: false,
      drawPageOpen: false,
      sshPageOpen: false,
      leftSidebarOpen: false
    }),
  closeTasksPage: () => set({ tasksPageOpen: false }),

  shortcutsOpen: false,

  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),

  pendingInsertText: null,

  setPendingInsertText: (text) => set({ pendingInsertText: text }),

  detailPanelOpen: false,

  detailPanelContent: null,

  openDetailPanel: (content) =>
    set({ detailPanelOpen: true, detailPanelContent: content, rightPanelOpen: false }),

  closeDetailPanel: () => set({ detailPanelOpen: false, detailPanelContent: null }),

  previewPanelOpen: false,
  previewPanelState: null,
  previewPanelsBySession: {},
  activeScopedSessionId: null,
  autoModelSelectionsBySession: {},
  autoModelRoutingStatesBySession: {},
  syncSessionScopedState: (sessionId) =>
    set((state) => {
      const scopedPreviewState = sessionId
        ? (state.previewPanelsBySession[sessionId] ?? null)
        : null
      return {
        activeScopedSessionId: sessionId,
        planMode: sessionId ? !!state.planModesBySession[sessionId] : false,
        previewPanelOpen: !!scopedPreviewState,
        previewPanelState: scopedPreviewState
      }
    }),
  setAutoModelSelection: (sessionId, status) =>
    set((state) => ({
      autoModelSelectionsBySession: {
        ...state.autoModelSelectionsBySession,
        [sessionId]: status
      }
    })),
  getAutoModelSelection: (sessionId) => {
    const targetSessionId = resolveScopedSessionId(sessionId, get().activeScopedSessionId)
    if (!targetSessionId) return null
    return get().autoModelSelectionsBySession[targetSessionId] ?? null
  },
  setAutoModelRoutingState: (sessionId, status) =>
    set((state) => ({
      autoModelRoutingStatesBySession: {
        ...state.autoModelRoutingStatesBySession,
        [sessionId]: status
      }
    })),
  getAutoModelRoutingState: (sessionId) => {
    const targetSessionId = resolveScopedSessionId(sessionId, get().activeScopedSessionId)
    if (!targetSessionId) return 'idle'
    return get().autoModelRoutingStatesBySession[targetSessionId] ?? 'idle'
  },
  openFilePreview: (filePath, viewMode, sshConnectionId, sessionId) =>
    set((state) => {
      const targetSessionId = resolveScopedSessionId(sessionId, state.activeScopedSessionId)
      const nextPreviewState = buildFilePreviewState(filePath, viewMode, sshConnectionId)

      if (!targetSessionId) {
        return {
          previewPanelOpen: true,
          previewPanelState: nextPreviewState,
          leftSidebarOpen: false,
          rightPanelOpen: false
        }
      }

      const nextPreviewPanelsBySession = {
        ...state.previewPanelsBySession,
        [targetSessionId]: nextPreviewState
      }

      if (state.activeScopedSessionId !== targetSessionId) {
        return { previewPanelsBySession: nextPreviewPanelsBySession }
      }

      return {
        previewPanelsBySession: nextPreviewPanelsBySession,
        previewPanelOpen: true,
        previewPanelState: nextPreviewState,
        leftSidebarOpen: false,
        rightPanelOpen: false
      }
    }),
  openDevServerPreview: (projectDir, port, sessionId) =>
    set((state) => {
      const targetSessionId = resolveScopedSessionId(sessionId, state.activeScopedSessionId)
      const nextPreviewState: PreviewPanelState = {
        source: 'dev-server',
        filePath: '',
        viewMode: 'preview',
        viewerType: 'dev-server',
        port,
        projectDir
      }

      if (!targetSessionId) {
        return {
          previewPanelOpen: true,
          previewPanelState: nextPreviewState,
          leftSidebarOpen: false
        }
      }

      const nextPreviewPanelsBySession = {
        ...state.previewPanelsBySession,
        [targetSessionId]: nextPreviewState
      }

      if (state.activeScopedSessionId !== targetSessionId) {
        return { previewPanelsBySession: nextPreviewPanelsBySession }
      }

      return {
        previewPanelsBySession: nextPreviewPanelsBySession,
        previewPanelOpen: true,
        previewPanelState: nextPreviewState,
        leftSidebarOpen: false
      }
    }),
  openMarkdownPreview: (title, content, sessionId) =>
    set((state) => {
      const targetSessionId = resolveScopedSessionId(sessionId, state.activeScopedSessionId)
      const nextPreviewState: PreviewPanelState = {
        source: 'markdown',
        filePath: '',
        viewMode: 'preview',
        viewerType: 'markdown',
        markdownContent: content,
        markdownTitle: title
      }

      if (!targetSessionId) {
        return {
          previewPanelOpen: true,
          previewPanelState: nextPreviewState,
          leftSidebarOpen: false,
          rightPanelOpen: false
        }
      }

      const nextPreviewPanelsBySession = {
        ...state.previewPanelsBySession,
        [targetSessionId]: nextPreviewState
      }

      if (state.activeScopedSessionId !== targetSessionId) {
        return { previewPanelsBySession: nextPreviewPanelsBySession }
      }

      return {
        previewPanelsBySession: nextPreviewPanelsBySession,
        previewPanelOpen: true,
        previewPanelState: nextPreviewState,
        leftSidebarOpen: false,
        rightPanelOpen: false
      }
    }),
  closePreviewPanel: (sessionId) =>
    set((state) => {
      const targetSessionId = resolveScopedSessionId(sessionId, state.activeScopedSessionId)
      if (!targetSessionId) {
        return { previewPanelOpen: false, previewPanelState: null }
      }

      const nextPreviewPanelsBySession = { ...state.previewPanelsBySession }
      delete nextPreviewPanelsBySession[targetSessionId]

      if (state.activeScopedSessionId !== targetSessionId) {
        return { previewPanelsBySession: nextPreviewPanelsBySession }
      }

      return {
        previewPanelsBySession: nextPreviewPanelsBySession,
        previewPanelOpen: false,
        previewPanelState: null
      }
    }),
  setPreviewViewMode: (mode, sessionId) =>
    set((state) => {
      const targetSessionId = resolveScopedSessionId(sessionId, state.activeScopedSessionId)
      if (!targetSessionId) {
        return {
          previewPanelState: state.previewPanelState
            ? { ...state.previewPanelState, viewMode: mode }
            : null
        }
      }

      const currentPreviewState = state.previewPanelsBySession[targetSessionId]
      if (!currentPreviewState) return {}

      const nextPreviewState = { ...currentPreviewState, viewMode: mode }
      const nextPreviewPanelsBySession = {
        ...state.previewPanelsBySession,
        [targetSessionId]: nextPreviewState
      }

      if (state.activeScopedSessionId !== targetSessionId) {
        return { previewPanelsBySession: nextPreviewPanelsBySession }
      }

      return {
        previewPanelsBySession: nextPreviewPanelsBySession,
        previewPanelState: nextPreviewState
      }
    }),

  selectedFiles: [],
  setSelectedFiles: (files) => set({ selectedFiles: files }),
  toggleFileSelection: (filePath) =>
    set((s) => {
      const isSelected = s.selectedFiles.includes(filePath)
      return {
        selectedFiles: isSelected
          ? s.selectedFiles.filter((f) => f !== filePath)
          : [...s.selectedFiles, filePath]
      }
    }),
  clearSelectedFiles: () => set({ selectedFiles: [] }),

  planMode: false,
  planModesBySession: {},
  isPlanModeEnabled: (sessionId) => {
    const targetSessionId = resolveScopedSessionId(sessionId, get().activeScopedSessionId)
    if (!targetSessionId) return get().planMode
    return !!get().planModesBySession[targetSessionId]
  },
  enterPlanMode: (sessionId) =>
    set((state) => {
      const targetSessionId = resolveScopedSessionId(sessionId, state.activeScopedSessionId)
      if (!targetSessionId) {
        return { planMode: true, rightPanelTab: 'plan', rightPanelOpen: true }
      }

      const nextPlanModesBySession = { ...state.planModesBySession, [targetSessionId]: true }
      if (state.activeScopedSessionId !== targetSessionId) {
        return { planModesBySession: nextPlanModesBySession }
      }

      return {
        planModesBySession: nextPlanModesBySession,
        planMode: true,
        rightPanelTab: 'plan',
        rightPanelOpen: true
      }
    }),

  chatView: 'home',
  navigateToHome: () =>
    set({
      chatView: 'home',
      settingsPageOpen: false,
      skillsPageOpen: false,
      resourcesPageOpen: false,
      translatePageOpen: false,
      sshPageOpen: false,
      tasksPageOpen: false
    }),
  navigateToSession: () =>
    set({
      chatView: 'session',
      settingsPageOpen: false,
      skillsPageOpen: false,
      resourcesPageOpen: false,
      translatePageOpen: false,
      sshPageOpen: false,
      tasksPageOpen: false
    }),
  exitPlanMode: (sessionId) =>
    set((state) => {
      const targetSessionId = resolveScopedSessionId(sessionId, state.activeScopedSessionId)
      if (!targetSessionId) {
        return { planMode: false }
      }

      const nextPlanModesBySession = { ...state.planModesBySession }
      delete nextPlanModesBySession[targetSessionId]

      if (state.activeScopedSessionId !== targetSessionId) {
        return { planModesBySession: nextPlanModesBySession }
      }

      return {
        planModesBySession: nextPlanModesBySession,
        planMode: false
      }
    })
}))
