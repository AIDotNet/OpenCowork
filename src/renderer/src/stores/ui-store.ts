import { create } from 'zustand'
import {
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  clampLeftSidebarWidth
} from '@renderer/components/layout/right-panel-defs'
import { parseChatRoute, replaceChatRoute } from '@renderer/lib/chat-route'
import { useChatStore } from '@renderer/stores/chat-store'

export type AppMode = 'chat' | 'clarify' | 'cowork' | 'code' | 'acp'

export type NavItem = 'chat' | 'channels' | 'resources' | 'skills' | 'draw' | 'translate' | 'tasks'

export type ChatView = 'home' | 'project' | 'archive' | 'channels' | 'git' | 'session'

export type RightPanelTab =
  | 'steps'
  | 'orchestration'
  | 'artifacts'
  | 'context'
  | 'files'
  | 'plan'
  | 'preview'
  | 'browser'
  | 'terminal'
  | 'subagents'
  | 'team'
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
  | 'fallback-fast'
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
  toolsAllowed?: boolean
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
  markdownContent?: string
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
  | { type: 'change-review'; runId: string; initialChangeId?: string | null }
  | { type: 'document'; title: string; content: string }
  | { type: 'report'; title: string; data: unknown }

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
  tasksPageOpen: boolean
  openTasksPage: () => void
  closeTasksPage: () => void
  shortcutsOpen: boolean
  setShortcutsOpen: (open: boolean) => void
  changelogDialogOpen: boolean
  setChangelogDialogOpen: (open: boolean) => void
  conversationGuideOpen: boolean
  setConversationGuideOpen: (open: boolean) => void
  pendingInsertText: string | null
  setPendingInsertText: (text: string | null) => void
  detailPanelOpen: boolean
  detailPanelContent: DetailPanelContent | null
  openDetailPanel: (content: DetailPanelContent) => void
  closeDetailPanel: () => void
  previewPanelOpen: boolean
  previewPanelState: PreviewPanelState | null
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
  activeScopedSessionId: string | null
  syncSessionScopedState: (sessionId: string | null) => void
  messageListViewStatesBySession: Record<string, MessageListViewState | undefined>
  setMessageListViewState: (sessionId: string, state: MessageListViewState | null) => void
  getMessageListViewState: (sessionId?: string | null) => MessageListViewState | null
  releaseDormantSessionUiState: (sessionId?: string | null) => void
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
  selectedFiles: string[]
  setSelectedFiles: (files: string[]) => void
  toggleFileSelection: (filePath: string) => void
  clearSelectedFiles: () => void
  selectedOrchestrationRunId: string | null
  selectedOrchestrationMemberId: string | null
  orchestrationConsoleOpen: boolean
  orchestrationConsoleView: 'overview' | 'member' | 'tasks'
  openOrchestrationPanel: (runId?: string | null, memberId?: string | null) => void
  openOrchestrationMember: (runId: string, memberId?: string | null) => void
  closeOrchestrationPanel: () => void
  openSubAgentsPanel: (toolUseId?: string | null) => void
  browserUrl: string
  setBrowserUrl: (url: string) => void
  openBrowserTab: (url?: string) => void
  subAgentExecutionDetailOpen: boolean
  subAgentExecutionDetailToolUseId: string | null
  subAgentExecutionDetailInlineText: string | null
  openSubAgentExecutionDetail: (toolUseId: string, inlineText?: string | null) => void
  closeSubAgentExecutionDetail: () => void
  selectedSubAgentToolUseId: string | null
  setSelectedSubAgentToolUseId: (toolUseId: string | null) => void
  setSelectedOrchestrationRunId: (runId: string | null) => void
  setSelectedOrchestrationMemberId: (memberId: string | null) => void
  setOrchestrationConsoleView: (view: 'overview' | 'member' | 'tasks') => void
  planMode: boolean
  enterPlanMode: (sessionId?: string | null) => void
  exitPlanMode: (sessionId?: string | null) => void
  planModesBySession: Record<string, boolean>
  isPlanModeEnabled: (sessionId?: string | null) => boolean
  chatView: ChatView
  navigateToHome: () => void
  navigateToProject: (projectId?: string | null) => void
  navigateToArchive: (projectId?: string | null) => void
  navigateToChannels: (projectId?: string | null) => void
  navigateToGit: (projectId?: string | null) => void
  navigateToSession: (sessionId?: string | null) => void
  applyChatRouteFromLocation: () => void
}

const CHAT_SURFACE_NAV_RESET = {
  settingsPageOpen: false,
  skillsPageOpen: false,
  resourcesPageOpen: false,
  translatePageOpen: false,
  drawPageOpen: false,
  tasksPageOpen: false
} as const

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

export const useUIStore = create<UIStore>((set, get) => ({
  mode: 'cowork',
  setMode: (mode) => set({ mode }),
  activeNavItem: 'chat',
  setActiveNavItem: (item) =>
    set({ activeNavItem: item, leftSidebarOpen: true, rightPanelOpen: false }),
  leftSidebarOpen: true,
  leftSidebarWidth: LEFT_SIDEBAR_DEFAULT_WIDTH,
  toggleLeftSidebar: () => set((state) => ({ leftSidebarOpen: !state.leftSidebarOpen })),
  setLeftSidebarOpen: (open) => set({ leftSidebarOpen: open }),
  setLeftSidebarWidth: (width) => set({ leftSidebarWidth: clampLeftSidebarWidth(width) }),
  rightPanelOpen: false,
  toggleRightPanel: () => set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),
  setRightPanelOpen: (open) => set({ rightPanelOpen: open }),
  rightPanelTab: 'files',
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
    set({
      settingsPageOpen: true,
      settingsTab: tab ?? 'general',
      skillsPageOpen: false,
      resourcesPageOpen: false,
      translatePageOpen: false,
      drawPageOpen: false,
      tasksPageOpen: false
    }),
  closeSettingsPage: () => set({ settingsPageOpen: false }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  skillsPageOpen: false,
  openSkillsPage: () =>
    set({
      activeNavItem: 'skills',
      skillsPageOpen: true,
      settingsPageOpen: false,
      resourcesPageOpen: false,
      translatePageOpen: false,
      drawPageOpen: false,
      tasksPageOpen: false
    }),
  closeSkillsPage: () => set({ skillsPageOpen: false }),
  resourcesPageOpen: false,
  openResourcesPage: () =>
    set({
      activeNavItem: 'resources',
      resourcesPageOpen: true,
      settingsPageOpen: false,
      skillsPageOpen: false,
      translatePageOpen: false,
      drawPageOpen: false,
      tasksPageOpen: false
    }),
  closeResourcesPage: () => set({ resourcesPageOpen: false }),
  translatePageOpen: false,
  openTranslatePage: () =>
    set({
      activeNavItem: 'translate',
      translatePageOpen: true,
      settingsPageOpen: false,
      skillsPageOpen: false,
      resourcesPageOpen: false,
      drawPageOpen: false,
      tasksPageOpen: false
    }),
  closeTranslatePage: () => set({ translatePageOpen: false }),
  drawPageOpen: false,
  openDrawPage: () =>
    set({
      activeNavItem: 'draw',
      drawPageOpen: true,
      settingsPageOpen: false,
      skillsPageOpen: false,
      resourcesPageOpen: false,
      translatePageOpen: false,
      tasksPageOpen: false
    }),
  closeDrawPage: () => set({ drawPageOpen: false }),
  tasksPageOpen: false,
  openTasksPage: () =>
    set({
      activeNavItem: 'tasks',
      tasksPageOpen: true,
      settingsPageOpen: false,
      skillsPageOpen: false,
      resourcesPageOpen: false,
      translatePageOpen: false,
      drawPageOpen: false
    }),
  closeTasksPage: () => set({ tasksPageOpen: false }),
  shortcutsOpen: false,
  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
  changelogDialogOpen: false,
  setChangelogDialogOpen: (open) => set({ changelogDialogOpen: open }),
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
      previewPanelOpen: false,
      previewPanelState: null,
      rightPanelTab: 'preview',
      rightPanelOpen: true
    }),
  closeDetailPanel: () => set({ detailPanelOpen: false, detailPanelContent: null }),
  previewPanelOpen: false,
  previewPanelState: null,
  openFilePreview: (filePath, viewMode, sshConnectionId) =>
    set({
      previewPanelOpen: true,
      previewPanelState: buildFilePreviewState(filePath, viewMode, sshConnectionId)
    }),
  openDevServerPreview: (projectDir, port) =>
    set({
      previewPanelOpen: true,
      previewPanelState: {
        source: 'dev-server',
        filePath: '',
        viewMode: 'preview',
        viewerType: 'dev-server',
        port,
        projectDir
      },
      rightPanelTab: 'preview',
      rightPanelOpen: true
    }),
  openMarkdownPreview: (title, content) =>
    set({
      previewPanelOpen: true,
      previewPanelState: {
        source: 'markdown',
        filePath: '',
        viewMode: 'preview',
        viewerType: 'markdown',
        markdownContent: content,
        markdownTitle: title
      },
      rightPanelTab: 'preview',
      rightPanelOpen: true
    }),
  closePreviewPanel: () => set({ previewPanelOpen: false, previewPanelState: null }),
  setPreviewViewMode: (mode) =>
    set((state) => ({
      previewPanelState: state.previewPanelState
        ? { ...state.previewPanelState, viewMode: mode }
        : null
    })),
  activeScopedSessionId: null,
  syncSessionScopedState: (sessionId) =>
    set((state) => ({
      activeScopedSessionId: sessionId,
      planMode: sessionId ? (state.planModesBySession[sessionId] ?? false) : false
    })),
  messageListViewStatesBySession: {},
  setMessageListViewState: (sessionId, state) =>
    set((current) => ({
      messageListViewStatesBySession: state
        ? { ...current.messageListViewStatesBySession, [sessionId]: state }
        : Object.fromEntries(
            Object.entries(current.messageListViewStatesBySession).filter(
              ([key]) => key !== sessionId
            )
          )
    })),
  getMessageListViewState: (sessionId) =>
    sessionId ? (get().messageListViewStatesBySession[sessionId] ?? null) : null,
  releaseDormantSessionUiState: () => undefined,
  autoModelSelectionsBySession: {},
  autoModelHighConfidenceSelectionsBySession: {},
  autoModelRoutingStatesBySession: {},
  setAutoModelSelection: (sessionId, status) =>
    set((state) => ({
      autoModelSelectionsBySession: { ...state.autoModelSelectionsBySession, [sessionId]: status }
    })),
  getAutoModelSelection: (sessionId) =>
    sessionId ? (get().autoModelSelectionsBySession[sessionId] ?? null) : null,
  setAutoModelHighConfidenceSelection: (sessionId, status) =>
    set((state) => ({
      autoModelHighConfidenceSelectionsBySession: {
        ...state.autoModelHighConfidenceSelectionsBySession,
        [sessionId]: status
      }
    })),
  getAutoModelHighConfidenceSelection: (sessionId) =>
    sessionId ? (get().autoModelHighConfidenceSelectionsBySession[sessionId] ?? null) : null,
  setAutoModelRoutingState: (sessionId, status) =>
    set((state) => ({
      autoModelRoutingStatesBySession: {
        ...state.autoModelRoutingStatesBySession,
        [sessionId]: status
      }
    })),
  getAutoModelRoutingState: (sessionId) =>
    sessionId ? (get().autoModelRoutingStatesBySession[sessionId] ?? 'idle') : 'idle',
  selectedFiles: [],
  setSelectedFiles: (files) => set({ selectedFiles: files }),
  toggleFileSelection: (filePath) =>
    set((state) => ({
      selectedFiles: state.selectedFiles.includes(filePath)
        ? state.selectedFiles.filter((file) => file !== filePath)
        : [...state.selectedFiles, filePath]
    })),
  clearSelectedFiles: () => set({ selectedFiles: [] }),
  selectedOrchestrationRunId: null,
  selectedOrchestrationMemberId: null,
  orchestrationConsoleOpen: false,
  orchestrationConsoleView: 'overview',
  openOrchestrationPanel: (runId, memberId) =>
    set({
      selectedOrchestrationRunId: runId ?? null,
      selectedOrchestrationMemberId: memberId ?? null,
      orchestrationConsoleOpen: true,
      orchestrationConsoleView: memberId ? 'member' : 'overview',
      rightPanelTab: 'orchestration',
      rightPanelSection: 'collaboration',
      rightPanelOpen: true
    }),
  openOrchestrationMember: (runId, memberId) =>
    set({
      selectedOrchestrationRunId: runId,
      selectedOrchestrationMemberId: memberId ?? null,
      orchestrationConsoleOpen: true,
      orchestrationConsoleView: memberId ? 'member' : 'overview',
      rightPanelTab: 'orchestration',
      rightPanelSection: 'collaboration',
      rightPanelOpen: true
    }),
  closeOrchestrationPanel: () =>
    set({
      orchestrationConsoleOpen: false,
      selectedOrchestrationRunId: null,
      selectedOrchestrationMemberId: null
    }),
  openSubAgentsPanel: (toolUseId) =>
    set({
      selectedSubAgentToolUseId: toolUseId ?? null,
      rightPanelTab: 'subagents',
      rightPanelSection: 'collaboration',
      orchestrationConsoleOpen: false,
      rightPanelOpen: true
    }),
  browserUrl: '',
  setBrowserUrl: (url) => set({ browserUrl: url }),
  openBrowserTab: (url) =>
    set({
      rightPanelTab: 'browser',
      rightPanelOpen: true,
      ...(url !== undefined ? { browserUrl: url } : {})
    }),
  subAgentExecutionDetailOpen: false,
  subAgentExecutionDetailToolUseId: null,
  subAgentExecutionDetailInlineText: null,
  openSubAgentExecutionDetail: (toolUseId, inlineText) =>
    set({
      selectedSubAgentToolUseId: toolUseId,
      subAgentExecutionDetailOpen: true,
      subAgentExecutionDetailToolUseId: toolUseId,
      subAgentExecutionDetailInlineText: inlineText?.trim() ? inlineText : null,
      rightPanelTab: 'subagents',
      rightPanelSection: 'collaboration',
      orchestrationConsoleOpen: false,
      rightPanelOpen: true
    }),
  closeSubAgentExecutionDetail: () =>
    set({
      subAgentExecutionDetailOpen: false,
      subAgentExecutionDetailToolUseId: null,
      subAgentExecutionDetailInlineText: null
    }),
  selectedSubAgentToolUseId: null,
  setSelectedSubAgentToolUseId: (toolUseId) => set({ selectedSubAgentToolUseId: toolUseId }),
  setSelectedOrchestrationRunId: (runId) => set({ selectedOrchestrationRunId: runId }),
  setSelectedOrchestrationMemberId: (memberId) =>
    set({
      selectedOrchestrationMemberId: memberId,
      orchestrationConsoleView: memberId ? 'member' : 'overview'
    }),
  setOrchestrationConsoleView: (view) => set({ orchestrationConsoleView: view }),
  planMode: false,
  enterPlanMode: (sessionId) =>
    set((state) => {
      const resolvedSessionId =
        sessionId ?? state.activeScopedSessionId ?? useChatStore.getState().activeSessionId
      return {
        planMode: true,
        planModesBySession: resolvedSessionId
          ? { ...state.planModesBySession, [resolvedSessionId]: true }
          : state.planModesBySession
      }
    }),
  exitPlanMode: (sessionId) =>
    set((state) => {
      const resolvedSessionId =
        sessionId ?? state.activeScopedSessionId ?? useChatStore.getState().activeSessionId
      const nextPlanModesBySession = { ...state.planModesBySession }
      if (resolvedSessionId) {
        delete nextPlanModesBySession[resolvedSessionId]
      }
      const nextPlanMode = resolvedSessionId
        ? Boolean(nextPlanModesBySession[resolvedSessionId])
        : false
      return {
        planMode: nextPlanMode,
        planModesBySession: nextPlanModesBySession
      }
    }),
  planModesBySession: {},
  isPlanModeEnabled: (sessionId) => {
    const resolvedSessionId =
      sessionId ?? get().activeScopedSessionId ?? useChatStore.getState().activeSessionId
    if (!resolvedSessionId) return false
    return Boolean(get().planModesBySession[resolvedSessionId])
  },
  chatView: 'home',
  navigateToHome: () => {
    set({ activeNavItem: 'chat', chatView: 'home', ...CHAT_SURFACE_NAV_RESET })
    replaceChatRoute({ chatView: 'home', projectId: null, sessionId: null })
  },
  navigateToProject: (projectId) => {
    const resolvedProjectId = projectId ?? useChatStore.getState().activeProjectId ?? null
    set({ activeNavItem: 'chat', chatView: 'project', ...CHAT_SURFACE_NAV_RESET })
    replaceChatRoute({ chatView: 'project', projectId: resolvedProjectId, sessionId: null })
  },
  navigateToArchive: (projectId) => {
    const resolvedProjectId = projectId ?? useChatStore.getState().activeProjectId ?? null
    set({ activeNavItem: 'chat', chatView: 'archive', ...CHAT_SURFACE_NAV_RESET })
    replaceChatRoute({ chatView: 'archive', projectId: resolvedProjectId, sessionId: null })
  },
  navigateToChannels: (projectId) => {
    const resolvedProjectId = projectId ?? useChatStore.getState().activeProjectId ?? null
    set({ activeNavItem: 'chat', chatView: 'channels', ...CHAT_SURFACE_NAV_RESET })
    replaceChatRoute({ chatView: 'channels', projectId: resolvedProjectId, sessionId: null })
  },
  navigateToGit: (projectId) => {
    const resolvedProjectId = projectId ?? useChatStore.getState().activeProjectId ?? null
    set({ activeNavItem: 'chat', chatView: 'git', ...CHAT_SURFACE_NAV_RESET })
    replaceChatRoute({ chatView: 'git', projectId: resolvedProjectId, sessionId: null })
  },
  navigateToSession: (sessionId) => {
    const store = useChatStore.getState()
    const resolvedSessionId = sessionId ?? store.activeSessionId ?? null
    const resolvedSession = resolvedSessionId
      ? store.sessions.find((item) => item.id === resolvedSessionId)
      : null
    const resolvedProjectId = resolvedSession?.projectId ?? store.activeProjectId ?? null
    set({ activeNavItem: 'chat', chatView: 'session', ...CHAT_SURFACE_NAV_RESET })
    replaceChatRoute({
      chatView: resolvedSessionId ? 'session' : resolvedProjectId ? 'project' : 'home',
      projectId: resolvedProjectId,
      sessionId: resolvedSessionId
    })
  },
  applyChatRouteFromLocation: () => {
    const route = parseChatRoute(window.location.hash)
    const chatStore = useChatStore.getState()

    if (route.projectId) {
      const hasProject = chatStore.projects.some((project) => project.id === route.projectId)
      if (hasProject) {
        chatStore.setActiveProject(route.projectId)
      }
    }

    if (route.sessionId) {
      const session = chatStore.sessions.find((item) => item.id === route.sessionId)
      if (session) {
        chatStore.setActiveSession(session.id)
        set({ activeNavItem: 'chat', chatView: 'session' })
        return
      }
    }

    if (route.chatView !== 'home') {
      const resolvedProjectId = route.projectId ?? chatStore.activeProjectId ?? null
      if (!resolvedProjectId) {
        set({ activeNavItem: 'chat', chatView: 'home' })
        replaceChatRoute({ chatView: 'home', projectId: null, sessionId: null })
        return
      }
    }

    set({ activeNavItem: 'chat', chatView: route.chatView })
    replaceChatRoute({
      chatView: route.chatView,
      projectId: route.projectId ?? chatStore.activeProjectId ?? null,
      sessionId: null
    })
  }
}))
