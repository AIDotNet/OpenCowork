import { create } from 'zustand'
import {
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  clampLeftSidebarWidth
} from '@renderer/components/layout/right-panel-defs'

export type AppMode = 'chat' | 'clarify' | 'cowork' | 'code' | 'acp'

export type NavItem =
  | 'chat'
  | 'channels'
  | 'resources'
  | 'skills'
  | 'draw'
  | 'translate'
  | 'ssh'
  | 'tasks'

export type ChatView = 'home' | 'project' | 'archive' | 'channels' | 'git' | 'session'

export type RightPanelTab =
  | 'steps'
  | 'team'
  | 'artifacts'
  | 'context'
  | 'files'
  | 'plan'
  | 'preview'
  | 'terminal'
  | 'subagents'
  | 'acp'
export type RightPanelSection = 'execution' | 'resources' | 'collaboration' | 'monitoring'

export type PreviewSource = 'file' | 'dev-server' | 'markdown'

export type AutoModelRoute = 'main' | 'fast'

export type AutoModelTaskType =
  | 'rewrite'
  | 'summarize'
  | 'translate'
  | 'format'
  | 'qa'
  | 'explain'
  | 'compare'
  | 'extract'
  | 'plan'
  | 'debug'
  | 'implement'
  | 'analyze'
  | 'other'

export type AutoModelConfidence = 'high' | 'medium' | 'low'

export type AutoModelDecisionSource =
  | 'classifier'
  | 'legacy-classifier'
  | 'fallback-main'
  | 'fallback-last-high-confidence'

export interface AutoModelSelectionStatus {
  source: 'auto'
  mode?: AppMode
  target: AutoModelRoute
  providerId?: string
  modelId?: string
  providerName?: string
  modelName?: string
  taskType?: AutoModelTaskType
  confidence?: AutoModelConfidence
  decisionSource?: AutoModelDecisionSource
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

export interface MessageListViewState {
  scrollOffset: number
  messageCount: number
  loadedRangeStart: number
  loadedRangeEnd: number
}

export type SettingsTab =
  | 'general'
  | 'memory'
  | 'analytics'
  | 'migration'
  | 'provider'
  | 'modelManagement'
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

  isHoveringRightPanel: boolean
  setIsHoveringRightPanel: (hovering: boolean) => void

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

  conversationGuideOpen: boolean
  setConversationGuideOpen: (open: boolean) => void

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

  /** SubAgent panel */
  openSubAgentsPanel: (toolUseId?: string | null) => void
  subAgentExecutionDetailOpen: boolean
  subAgentExecutionDetailToolUseId: string | null
  subAgentExecutionDetailInlineText: string | null
  openSubAgentExecutionDetail: (toolUseId: string, inlineText?: string | null) => void
  closeSubAgentExecutionDetail: () => void

  /** Session-scoped UI state */
  activeScopedSessionId: string | null
  syncSessionScopedState: (sessionId: string | null) => void
  messageListViewStatesBySession: Record<string, MessageListViewState | undefined>
  setMessageListViewState: (sessionId: string, state: MessageListViewState | null) => void
  getMessageListViewState: (sessionId?: string | null) => MessageListViewState | null
  autoModelSelectionsBySession: Record<string, AutoModelSelectionStatus | null>
  autoModelHighConfidenceSelectionsBySession: Record<string, AutoModelSelectionStatus | null>
  autoModelRoutingStatesBySession: Record<string, AutoModelRoutingState>
  setAutoModelSelection: (sessionId: string, status: AutoModelSelectionStatus | null) => void
  getAutoModelSelection: (sessionId?: string | null) => AutoModelSelectionStatus | null
  setAutoModelHighConfidenceSelection: (
    sessionId: string,
    status: AutoModelSelectionStatus | null
  ) => void
  getAutoModelHighConfidenceSelection: (
    sessionId?: string | null
  ) => AutoModelSelectionStatus | null
  setAutoModelRoutingState: (sessionId: string, status: AutoModelRoutingState) => void
  getAutoModelRoutingState: (sessionId?: string | null) => AutoModelRoutingState

  /** Selected files in file tree panel */
  selectedFiles: string[]
  setSelectedFiles: (files: string[]) => void
  toggleFileSelection: (filePath: string) => void
  clearSelectedFiles: () => void

  /** Focused SubAgent in right panel */
  selectedSubAgentToolUseId: string | null
  setSelectedSubAgentToolUseId: (toolUseId: string | null) => void

  /** Plan mode state */
  planMode: boolean
  planModesBySession: Record<string, boolean>
  isPlanModeEnabled: (sessionId?: string | null) => boolean
  enterPlanMode: (sessionId?: string | null) => void
  exitPlanMode: (sessionId?: string | null) => void

  /** Chat view navigation */
  chatView: ChatView
  navigateToHome: () => void
  navigateToProject: () => void
  navigateToArchive: () => void
  navigateToChannels: () => void
  navigateToGit: () => void
  navigateToSession: () => void
}

export const useUIStore = create<UIStore>((set, get) => ({
  mode: 'cowork',

  setMode: (mode) =>
    set((state) => ({
      mode,
      rightPanelOpen: mode === 'cowork' || mode === 'acp',
      rightPanelTab:
        mode === 'acp' ? 'acp' : state.rightPanelTab === 'acp' ? 'steps' : state.rightPanelTab,
      rightPanelSection: mode === 'acp' ? 'monitoring' : state.rightPanelSection,
      leftSidebarOpen: mode === 'cowork' || mode === 'acp' ? false : state.leftSidebarOpen
    })),

  activeNavItem: 'chat',
  setActiveNavItem: (item) =>
    set({ activeNavItem: item, leftSidebarOpen: true, rightPanelOpen: false }),

  leftSidebarOpen: true,
  leftSidebarWidth: LEFT_SIDEBAR_DEFAULT_WIDTH,

  toggleLeftSidebar: () =>
    set((state) => {
      const nextOpen = !state.leftSidebarOpen
      return {
        leftSidebarOpen: nextOpen,
        rightPanelOpen: nextOpen ? false : state.rightPanelOpen
      }
    }),

  setLeftSidebarOpen: (open) =>
    set((state) => ({
      leftSidebarOpen: open,
      rightPanelOpen: open ? false : state.rightPanelOpen
    })),
  setLeftSidebarWidth: (width) => set({ leftSidebarWidth: clampLeftSidebarWidth(width) }),

  rightPanelOpen: false,

  toggleRightPanel: () =>
    set((state) => {
      const nextOpen = !state.rightPanelOpen
      return {
        rightPanelOpen: nextOpen,
        leftSidebarOpen: nextOpen ? false : state.leftSidebarOpen
      }
    }),

  setRightPanelOpen: (open) =>
    set((state) => ({
      rightPanelOpen: open,
      leftSidebarOpen: open ? false : state.leftSidebarOpen
    })),

  rightPanelTab: 'steps',

  setRightPanelTab: (tab) => set({ rightPanelTab: tab }),

  rightPanelSection: 'execution',

  setRightPanelSection: (section) => set({ rightPanelSection: section }),

  rightPanelWidth: 384,

  setRightPanelWidth: (width) => set({ rightPanelWidth: width }),

  isHoveringRightPanel: false,
  setIsHoveringRightPanel: (hovering) => set({ isHoveringRightPanel: hovering }),

  settingsOpen: false,

  setSettingsOpen: (open) => set({ settingsOpen: open }),

  settingsPageOpen: false,
  settingsTab: 'general',
  openSettingsPage: (tab) =>
    set((state) => ({
      settingsPageOpen: true,
      settingsTab: tab ?? 'general',
      leftSidebarOpen: state.leftSidebarOpen,
      skillsPageOpen: false,
      resourcesPageOpen: false,
      translatePageOpen: false,
      drawPageOpen: false,
      sshPageOpen: false,
      tasksPageOpen: false
    })),
  closeSettingsPage: () => set({ settingsPageOpen: false }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),

  skillsPageOpen: false,
  openSkillsPage: () =>
    set((state) => ({
      activeNavItem: 'skills',
      skillsPageOpen: true,
      resourcesPageOpen: false,
      settingsPageOpen: false,
      translatePageOpen: false,
      drawPageOpen: false,
      sshPageOpen: false,
      tasksPageOpen: false,
      leftSidebarOpen: state.leftSidebarOpen
    })),
  closeSkillsPage: () => set({ skillsPageOpen: false }),

  resourcesPageOpen: false,
  openResourcesPage: () =>
    set((state) => ({
      activeNavItem: 'resources',
      resourcesPageOpen: true,
      settingsPageOpen: false,
      skillsPageOpen: false,
      translatePageOpen: false,
      drawPageOpen: false,
      sshPageOpen: false,
      tasksPageOpen: false,
      leftSidebarOpen: state.leftSidebarOpen
    })),
  closeResourcesPage: () => set({ resourcesPageOpen: false }),

  translatePageOpen: false,
  openTranslatePage: () =>
    set((state) => ({
      activeNavItem: 'translate',
      translatePageOpen: true,
      settingsPageOpen: false,
      skillsPageOpen: false,
      resourcesPageOpen: false,
      drawPageOpen: false,
      sshPageOpen: false,
      tasksPageOpen: false,
      leftSidebarOpen: state.leftSidebarOpen
    })),
  closeTranslatePage: () => set({ translatePageOpen: false }),

  drawPageOpen: false,
  openDrawPage: () =>
    set((state) => ({
      activeNavItem: 'draw',
      drawPageOpen: true,
      settingsPageOpen: false,
      skillsPageOpen: false,
      resourcesPageOpen: false,
      translatePageOpen: false,
      sshPageOpen: false,
      tasksPageOpen: false,
      leftSidebarOpen: state.leftSidebarOpen
    })),
  closeDrawPage: () => set({ drawPageOpen: false }),

  sshPageOpen: false,
  openSshPage: () =>
    set((state) => ({
      activeNavItem: 'ssh',
      sshPageOpen: true,
      settingsPageOpen: false,
      skillsPageOpen: false,
      resourcesPageOpen: false,
      translatePageOpen: false,
      drawPageOpen: false,
      tasksPageOpen: false,
      leftSidebarOpen: state.leftSidebarOpen
    })),
  closeSshPage: () => set({ sshPageOpen: false }),

  tasksPageOpen: false,
  openTasksPage: () =>
    set((state) => ({
      activeNavItem: 'tasks',
      tasksPageOpen: true,
      settingsPageOpen: false,
      skillsPageOpen: false,
      resourcesPageOpen: false,
      translatePageOpen: false,
      drawPageOpen: false,
      sshPageOpen: false,
      leftSidebarOpen: state.leftSidebarOpen
    })),
  closeTasksPage: () => set({ tasksPageOpen: false }),

  shortcutsOpen: false,

  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),

  conversationGuideOpen: false,
  setConversationGuideOpen: (open) => set({ conversationGuideOpen: open }),

  pendingInsertText: null,

  setPendingInsertText: (text) => set({ pendingInsertText: text }),

  detailPanelOpen: false,

  detailPanelContent: null,

  openDetailPanel: (content) =>
    set({
      detailPanelOpen: true,
      detailPanelContent: content,
      rightPanelTab: 'preview',
      rightPanelOpen: true,
      leftSidebarOpen: false
    }),

  closeDetailPanel: () => set({ detailPanelOpen: false, detailPanelContent: null }),

  previewPanelOpen: false,
  previewPanelState: null,
  previewPanelsBySession: {},
  activeScopedSessionId: null,
  messageListViewStatesBySession: {},
  autoModelSelectionsBySession: {},
  autoModelHighConfidenceSelectionsBySession: {},
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
  setMessageListViewState: (sessionId, state) =>
    set((currentState) => {
      const nextMessageListViewStatesBySession = { ...currentState.messageListViewStatesBySession }
      if (state) {
        nextMessageListViewStatesBySession[sessionId] = state
      } else {
        delete nextMessageListViewStatesBySession[sessionId]
      }

      return { messageListViewStatesBySession: nextMessageListViewStatesBySession }
    }),
  getMessageListViewState: (sessionId) => {
    const targetSessionId = resolveScopedSessionId(sessionId, get().activeScopedSessionId)
    if (!targetSessionId) return null
    return get().messageListViewStatesBySession[targetSessionId] ?? null
  },
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
  setAutoModelHighConfidenceSelection: (sessionId, status) =>
    set((state) => ({
      autoModelHighConfidenceSelectionsBySession: {
        ...state.autoModelHighConfidenceSelectionsBySession,
        [sessionId]: status
      }
    })),
  getAutoModelHighConfidenceSelection: (sessionId) => {
    const targetSessionId = resolveScopedSessionId(sessionId, get().activeScopedSessionId)
    if (!targetSessionId) return null
    return get().autoModelHighConfidenceSelectionsBySession[targetSessionId] ?? null
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
          previewPanelState: nextPreviewState
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
        previewPanelState: nextPreviewState
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
          leftSidebarOpen: false,
          rightPanelTab: 'preview',
          rightPanelOpen: true
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
        rightPanelTab: 'preview',
        rightPanelOpen: true
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
          rightPanelTab: 'preview',
          rightPanelOpen: true
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
        rightPanelTab: 'preview',
        rightPanelOpen: true
      }
    }),
  closePreviewPanel: (sessionId) =>
    set((state) => {
      const targetSessionId = resolveScopedSessionId(sessionId, state.activeScopedSessionId)
      if (!targetSessionId) {
        return {
          previewPanelOpen: false,
          previewPanelState: null,
          rightPanelTab:
            state.rightPanelTab === 'preview'
              ? state.detailPanelOpen
                ? 'preview'
                : 'steps'
              : state.rightPanelTab
        }
      }

      const nextPreviewPanelsBySession = { ...state.previewPanelsBySession }
      delete nextPreviewPanelsBySession[targetSessionId]

      if (state.activeScopedSessionId !== targetSessionId) {
        return { previewPanelsBySession: nextPreviewPanelsBySession }
      }

      return {
        previewPanelsBySession: nextPreviewPanelsBySession,
        previewPanelOpen: false,
        previewPanelState: null,
        rightPanelTab:
          state.rightPanelTab === 'preview'
            ? state.detailPanelOpen
              ? 'preview'
              : 'steps'
            : state.rightPanelTab
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

  selectedSubAgentToolUseId: null,
  setSelectedSubAgentToolUseId: (toolUseId) => set({ selectedSubAgentToolUseId: toolUseId }),
  subAgentExecutionDetailOpen: false,
  subAgentExecutionDetailToolUseId: null,
  subAgentExecutionDetailInlineText: null,
  openSubAgentsPanel: (toolUseId) =>
    set({
      selectedSubAgentToolUseId: toolUseId ?? null,
      rightPanelTab: 'subagents',
      rightPanelSection: 'collaboration',
      rightPanelOpen: true,
      leftSidebarOpen: false,
      detailPanelOpen: false,
      detailPanelContent: null,
      subAgentExecutionDetailOpen: false,
      subAgentExecutionDetailToolUseId: null,
      subAgentExecutionDetailInlineText: null
    }),
  openSubAgentExecutionDetail: (toolUseId, inlineText) =>
    set({
      selectedSubAgentToolUseId: toolUseId,
      subAgentExecutionDetailOpen: true,
      subAgentExecutionDetailToolUseId: toolUseId,
      subAgentExecutionDetailInlineText: inlineText?.trim() ? inlineText : null,
      rightPanelTab: 'subagents',
      rightPanelSection: 'collaboration',
      rightPanelOpen: true,
      leftSidebarOpen: false,
      detailPanelOpen: false,
      detailPanelContent: null
    }),
  closeSubAgentExecutionDetail: () =>
    set({
      subAgentExecutionDetailOpen: false,
      subAgentExecutionDetailToolUseId: null,
      subAgentExecutionDetailInlineText: null
    }),

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
        return {
          planMode: true,
          rightPanelTab: 'plan',
          rightPanelOpen: true,
          leftSidebarOpen: false
        }
      }

      const nextPlanModesBySession = { ...state.planModesBySession, [targetSessionId]: true }
      if (state.activeScopedSessionId !== targetSessionId) {
        return { planModesBySession: nextPlanModesBySession }
      }

      return {
        planModesBySession: nextPlanModesBySession,
        planMode: true,
        rightPanelTab: 'plan',
        rightPanelOpen: true,
        leftSidebarOpen: false
      }
    }),

  chatView: 'home',
  navigateToHome: () =>
    set({
      activeNavItem: 'chat',
      chatView: 'home',
      settingsPageOpen: false,
      skillsPageOpen: false,
      resourcesPageOpen: false,
      translatePageOpen: false,
      drawPageOpen: false,
      sshPageOpen: false,
      tasksPageOpen: false
    }),
  navigateToProject: () =>
    set({
      activeNavItem: 'chat',
      chatView: 'project',
      settingsPageOpen: false,
      skillsPageOpen: false,
      resourcesPageOpen: false,
      translatePageOpen: false,
      sshPageOpen: false,
      tasksPageOpen: false
    }),
  navigateToArchive: () =>
    set({
      activeNavItem: 'chat',
      chatView: 'archive',
      settingsPageOpen: false,
      skillsPageOpen: false,
      resourcesPageOpen: false,
      translatePageOpen: false,
      sshPageOpen: false,
      tasksPageOpen: false
    }),
  navigateToChannels: () =>
    set({
      activeNavItem: 'chat',
      chatView: 'channels',
      settingsPageOpen: false,
      skillsPageOpen: false,
      resourcesPageOpen: false,
      translatePageOpen: false,
      sshPageOpen: false,
      tasksPageOpen: false
    }),
  navigateToGit: () =>
    set({
      activeNavItem: 'chat',
      chatView: 'git',
      settingsPageOpen: false,
      skillsPageOpen: false,
      resourcesPageOpen: false,
      translatePageOpen: false,
      sshPageOpen: false,
      tasksPageOpen: false
    }),
  navigateToSession: () =>
    set({
      activeNavItem: 'chat',
      chatView: 'session',
      settingsPageOpen: false,
      skillsPageOpen: false,
      resourcesPageOpen: false,
      translatePageOpen: false,
      drawPageOpen: false,
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
