import type React from 'react'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import {
  BOTTOM_TERMINAL_DOCK_DEFAULT_HEIGHT,
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  WORKING_FOLDER_PANEL_DEFAULT_WIDTH,
  clampBottomTerminalDockHeight,
  clampLeftSidebarWidth,
  clampRightPanelWidth,
  clampWorkingFolderPanelWidth
} from '@renderer/components/layout/right-panel-defs'
import { ipcStorage } from '@renderer/lib/ipc/ipc-storage'
import { parseChatRoute, replaceChatRoute } from '@renderer/lib/chat-route'
import { useChatStore } from '@renderer/stores/chat-store'
import {
  DEFAULT_SETTINGS_TAB,
  parseSettingsRoute,
  replaceSettingsRoute
} from '@renderer/lib/settings-route'

export type AppMode = 'chat' | 'clarify' | 'cowork' | 'code' | 'acp'

export type NavItem =
  | 'chat'
  | 'channels'
  | 'resources'
  | 'skills'
  | 'souls'
  | 'sync'
  | 'draw'
  | 'translate'
  | 'tasks'

export type ChatView = 'home' | 'project' | 'archive' | 'channels' | 'git' | 'session'

export type LegacyRightPanelTab =
  | 'steps'
  | 'orchestration'
  | 'artifacts'
  | 'context'
  | 'files'
  | 'plan'
  | 'preview'
  | 'browser'
  | 'subagents'
  | 'team'
  | 'acp'
export type RightPanelSection = 'execution' | 'resources' | 'collaboration' | 'monitoring'
export type AgentFilesSurface = 'sheet'
export type AgentFilesTab = 'files' | 'changes'
export type AgentFilesChangeSource = 'all' | 'agent' | 'git'
export type RightPanelTabKind =
  | 'context'
  | 'review'
  | 'preview'
  | 'browser'
  | 'subagent'
  | 'terminal'

export interface RightPanelTabInstance {
  id: string
  kind: RightPanelTabKind
  title: string
  closable: boolean
  sessionId?: string | null
  toolUseId?: string | null
  inlineText?: string | null
  processId?: string
  previewTabId?: string
  projectId?: string | null
  initialChangeId?: string | null
  modified?: boolean
  createdAt: number
}

export type PreviewSource = 'file' | 'dev-server' | 'markdown' | 'diff'
export type DiffSource = 'git' | 'agent'
export type GitChangeSection = 'staged' | 'unstaged' | 'untracked' | 'conflicted'
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
export type AutoModelRoutingComplexity = 'simple' | 'medium' | 'complex'
export type AutoModelRoutingRisk = 'low' | 'medium' | 'high'
export type AutoModelDecisionSource =
  | 'classifier'
  | 'legacy-classifier'
  | 'heuristic'
  | 'policy'
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
  complexity?: AutoModelRoutingComplexity
  risk?: AutoModelRoutingRisk
  reasons?: string[]
  classifierRoute?: AutoModelRoute
  heuristicRoute?: AutoModelRoute
  fallbackReason?: string
  routingDurationMs?: number
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
  sessionId?: string | null
  projectId?: string | null
  targetLine?: number
  targetColumn?: number
  targetPositionKey?: number
  // Diff tabs (source === 'diff')
  diffSource?: DiffSource
  diffOriginal?: string
  diffModified?: string
  diffLanguage?: string
  diffModifiedEditable?: boolean
  diffIsBinary?: boolean
  /** git object prefix the original side was read from: 'HEAD' or '' (index). */
  diffOriginalRef?: string
  gitRepoPath?: string
  gitSection?: GitChangeSection
  agentRunId?: string
  agentChangeId?: string
}

export interface OpenDiffParams {
  filePath: string
  diffSource: DiffSource
  original: string
  modified: string
  modifiedEditable?: boolean
  isBinary?: boolean
  language?: string
  sshConnectionId?: string
  sessionId?: string | null
  projectId?: string | null
  diffOriginalRef?: string
  gitRepoPath?: string
  gitSection?: GitChangeSection
  agentRunId?: string
  agentChangeId?: string
  mirrorToRightPanel?: boolean
}

export interface PreviewPanelTab extends PreviewPanelState {
  id: string
  title: string
  modified?: boolean
  draftContent?: string
}

export interface MessageListViewState {
  scrollOffset: number
  messageCount: number
  loadedRangeStart: number
  loadedRangeEnd: number
}

export interface BrowserErrorInfo {
  code: number
  desc: string
  url: string
}

export interface BrowserPanelSessionState {
  url: string
  loading: boolean
  pageTitle: string
  canGoBack: boolean
  canGoForward: boolean
  errorInfo: BrowserErrorInfo | null
}

export type SettingsTab =
  | 'profile'
  | 'general'
  | 'system'
  | 'memory'
  | 'analytics'
  | 'migration'
  | 'provider'
  | 'modelManagement'
  | 'model'
  | 'plugin'
  | 'extension'
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

const RIGHT_PANEL_REVIEW_TAB_ID = 'review'

function createReviewTab(): RightPanelTabInstance {
  return {
    id: RIGHT_PANEL_REVIEW_TAB_ID,
    kind: 'review',
    title: 'Review',
    closable: true,
    createdAt: 0
  }
}

// Sanitize the tab list. Tabs can be closed freely; this never re-injects the
// built-in Review tab. It only normalizes a present Review tab to be closable.
function ensureRightPanelTabs(
  tabs: RightPanelTabInstance[] | null | undefined
): RightPanelTabInstance[] {
  return (tabs ?? []).map((tab) =>
    tab.id === RIGHT_PANEL_REVIEW_TAB_ID ? { ...tab, closable: true } : tab
  )
}

// Guarantee the Review tab exists. Used by the default/built-in entry points
// and when opening an otherwise-empty panel.
function ensureReviewTab(
  tabs: RightPanelTabInstance[] | null | undefined
): RightPanelTabInstance[] {
  const safeTabs = ensureRightPanelTabs(tabs)
  return safeTabs.some((tab) => tab.id === RIGHT_PANEL_REVIEW_TAB_ID)
    ? safeTabs
    : [createReviewTab(), ...safeTabs]
}

function getDefaultRightPanelTabs(): RightPanelTabInstance[] {
  return [createReviewTab()]
}

function keepGlobalRightPanelTabs(
  tabs: RightPanelTabInstance[] | null | undefined
): RightPanelTabInstance[] {
  return ensureReviewTab(
    (tabs ?? []).filter((tab) => tab.kind === 'review' || tab.kind === 'browser')
  )
}

function nextRightPanelActiveTab(
  tabs: RightPanelTabInstance[] | null | undefined,
  closedTabId: string
): string {
  const safeTabs = ensureRightPanelTabs(tabs)
  const index = safeTabs.findIndex((tab) => tab.id === closedTabId)
  const nextTabs = safeTabs.filter((tab) => tab.id !== closedTabId)
  return (
    nextTabs[Math.min(Math.max(index, 0), nextTabs.length - 1)]?.id ?? RIGHT_PANEL_REVIEW_TAB_ID
  )
}

function normalizeAgentChangeKey(initialChangeId?: string | null): string | null {
  if (!initialChangeId) return null
  return initialChangeId.includes(':') ? initialChangeId : `agent:${initialChangeId}`
}

function closeRightSidePanels(): { rightPanelOpen: false; workingFolderSheetOpen: false } {
  return {
    rightPanelOpen: false,
    workingFolderSheetOpen: false
  }
}

function rightPanelPreviewTabId(previewTabId: string): string {
  return `preview:${previewTabId}`
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
  runtimeStatusPanelOpen: boolean
  toggleRuntimeStatusPanel: () => void
  setRuntimeStatusPanelOpen: (open: boolean) => void
  workingFolderSheetOpen: boolean
  toggleWorkingFolderSheet: () => void
  setWorkingFolderSheetOpen: (open: boolean) => void
  workingFolderPanelWidth: number
  setWorkingFolderPanelWidth: (width: number) => void
  bottomTerminalDockOpenByProjectId: Record<string, boolean>
  setBottomTerminalDockOpen: (projectId: string, open: boolean) => void
  toggleBottomTerminalDock: (projectId: string) => void
  isBottomTerminalDockOpen: (projectId?: string | null) => boolean
  bottomTerminalDockHeight: number
  setBottomTerminalDockHeight: (height: number) => void
  rightPanelTab: LegacyRightPanelTab
  setRightPanelTab: (tab: LegacyRightPanelTab) => void
  rightPanelSection: RightPanelSection
  setRightPanelSection: (section: RightPanelSection) => void
  rightPanelTabs: RightPanelTabInstance[]
  rightPanelActiveTabId: string
  setRightPanelActiveTab: (tabId: string) => void
  openReviewTab: (initialChangeId?: string | null) => void
  ensureBrowserTab: (url?: string, sessionId?: string | null, projectId?: string | null) => void
  ensureSubAgentTab: (
    toolUseId?: string | null,
    inlineText?: string | null,
    title?: string | null,
    sessionId?: string | null
  ) => void
  ensureTerminalTab: (processId: string, title?: string | null) => void
  closeRightPanelTab: (tabId: string) => void
  rightPanelWidth: number
  setRightPanelWidth: (width: number) => void
  agentFilesActiveTabBySurface: Partial<Record<AgentFilesSurface, AgentFilesTab>>
  agentFilesSelectedChangeKey: string | null
  agentFilesChangeSource: AgentFilesChangeSource
  setAgentFilesActiveTab: (surface: AgentFilesSurface, tab: AgentFilesTab) => void
  setAgentFilesSelectedChangeKey: (key: string | null) => void
  setAgentFilesChangeSource: (source: AgentFilesChangeSource) => void
  isHoveringRightPanel: boolean
  setIsHoveringRightPanel: (hovering: boolean) => void
  runtimeStatusPanelTriggerHovered: boolean
  setRuntimeStatusPanelTriggerHovered: (hovering: boolean) => void
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
  soulsPageOpen: boolean
  openSoulsPage: () => void
  closeSoulsPage: () => void
  syncPageOpen: boolean
  openSyncPage: () => void
  closeSyncPage: () => void
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
  previewPanelTabs: PreviewPanelTab[]
  activePreviewPanelTabId: string | null
  openFilePreview: (
    filePath: string,
    viewMode?: 'preview' | 'code',
    sshConnectionId?: string,
    sessionId?: string | null,
    targetLine?: number,
    targetColumn?: number
  ) => void
  openDevServerPreview: (projectDir: string, port: number, sessionId?: string | null) => void
  openMarkdownPreview: (title: string, content: string, sessionId?: string | null) => void
  openPreviewTab: (
    state: PreviewPanelState,
    preserveExistingViewMode?: boolean,
    mirrorToRightPanel?: boolean
  ) => void
  openDiff: (params: OpenDiffParams) => void
  closePreviewTab: (tabId: string) => void
  setActivePreviewTab: (tabId: string | null) => void
  updatePreviewTab: (tabId: string, patch: Partial<PreviewPanelTab>) => void
  closePreviewPanel: (sessionId?: string | null) => void
  setPreviewViewMode: (mode: 'preview' | 'code', sessionId?: string | null) => void
  activeScopedSessionId: string | null
  activeScopedProjectId: string | null
  syncSessionScopedState: (sessionId: string | null, projectId?: string | null) => void
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
  openSubAgentsPanel: (toolUseId?: string | null, sessionId?: string | null) => void
  browserStatesBySession: Record<string, BrowserPanelSessionState | undefined>
  getBrowserState: (
    sessionId?: string | null,
    projectId?: string | null
  ) => BrowserPanelSessionState
  patchBrowserState: (
    sessionId: string | null | undefined,
    patch: Partial<BrowserPanelSessionState>,
    projectId?: string | null
  ) => void
  browserUrl: string
  setBrowserUrl: (url: string, sessionId?: string | null, projectId?: string | null) => void
  openBrowserTab: (url?: string, sessionId?: string | null, projectId?: string | null) => void
  browserLoading: boolean
  setBrowserLoading: (
    loading: boolean,
    sessionId?: string | null,
    projectId?: string | null
  ) => void
  browserPageTitle: string
  setBrowserPageTitle: (title: string, sessionId?: string | null, projectId?: string | null) => void
  browserCanGoBack: boolean
  setBrowserCanGoBack: (can: boolean, sessionId?: string | null, projectId?: string | null) => void
  browserCanGoForward: boolean
  setBrowserCanGoForward: (
    can: boolean,
    sessionId?: string | null,
    projectId?: string | null
  ) => void
  browserErrorInfo: BrowserErrorInfo | null
  setBrowserErrorInfo: (
    info: BrowserErrorInfo | null,
    sessionId?: string | null,
    projectId?: string | null
  ) => void
  browserWebviewRefsBySession: Record<
    string,
    React.RefObject<Electron.WebviewTag | null> | null | undefined
  >
  getBrowserWebviewRef: (
    sessionId?: string | null,
    projectId?: string | null
  ) => React.RefObject<Electron.WebviewTag | null> | null
  browserWebviewRef: React.RefObject<Electron.WebviewTag | null> | null
  setBrowserWebviewRef: (
    ref: React.RefObject<Electron.WebviewTag | null> | null,
    sessionId?: string | null,
    projectId?: string | null
  ) => void
  subAgentExecutionDetailOpen: boolean
  subAgentExecutionDetailToolUseId: string | null
  subAgentExecutionDetailInlineText: string | null
  openSubAgentExecutionDetail: (
    toolUseId: string,
    inlineText?: string | null,
    title?: string | null,
    sessionId?: string | null
  ) => void
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
  applyRouteFromLocation: () => void
  applyChatRouteFromLocation: () => void
}

const GLOBAL_BROWSER_SESSION_KEY = '__global__'

const DEFAULT_BROWSER_STATE: BrowserPanelSessionState = {
  url: '',
  loading: false,
  pageTitle: '',
  canGoBack: false,
  canGoForward: false,
  errorInfo: null
}

interface PanelScope {
  sessionId: string | null
  projectId: string | null
}

function normalizeScopeId(value?: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed || null
}

function resolveProjectIdForSession(sessionId?: string | null): string | null {
  const normalizedSessionId = normalizeScopeId(sessionId)
  if (!normalizedSessionId) return useChatStore.getState().activeProjectId ?? null
  const chatState = useChatStore.getState()
  return chatState.sessions.find((session) => session.id === normalizedSessionId)?.projectId ?? null
}

function resolvePanelScope(
  state: Pick<UIStore, 'activeScopedSessionId' | 'activeScopedProjectId'>,
  sessionId?: string | null,
  projectId?: string | null
): PanelScope {
  const resolvedSessionId = normalizeScopeId(
    sessionId !== undefined
      ? sessionId
      : (state.activeScopedSessionId ?? useChatStore.getState().activeSessionId ?? null)
  )
  const resolvedProjectId = normalizeScopeId(
    projectId !== undefined
      ? projectId
      : resolvedSessionId
        ? resolveProjectIdForSession(resolvedSessionId)
        : (state.activeScopedProjectId ?? useChatStore.getState().activeProjectId ?? null)
  )
  return {
    sessionId: resolvedSessionId,
    projectId: resolvedProjectId
  }
}

function getBrowserSessionKey(sessionId?: string | null, projectId?: string | null): string {
  const normalizedSessionId = normalizeScopeId(sessionId)
  if (normalizedSessionId) return normalizedSessionId
  const normalizedProjectId = normalizeScopeId(projectId)
  return normalizedProjectId ? `project:${normalizedProjectId}` : GLOBAL_BROWSER_SESSION_KEY
}

function getBrowserStateFromMap(
  states: Record<string, BrowserPanelSessionState | undefined> | null | undefined,
  sessionId?: string | null,
  projectId?: string | null
): BrowserPanelSessionState {
  return states?.[getBrowserSessionKey(sessionId, projectId)] ?? DEFAULT_BROWSER_STATE
}

function getBrowserScopeKey(scope: PanelScope): string {
  return getBrowserSessionKey(scope.sessionId, scope.projectId)
}

function isActiveBrowserScope(
  state: Pick<UIStore, 'activeScopedSessionId' | 'activeScopedProjectId'>,
  scope: PanelScope
): boolean {
  return getBrowserScopeKey(resolvePanelScope(state)) === getBrowserScopeKey(scope)
}

function browserAliasState(
  browserState: BrowserPanelSessionState
): Pick<
  UIStore,
  | 'browserUrl'
  | 'browserLoading'
  | 'browserPageTitle'
  | 'browserCanGoBack'
  | 'browserCanGoForward'
  | 'browserErrorInfo'
> {
  return {
    browserUrl: browserState.url,
    browserLoading: browserState.loading,
    browserPageTitle: browserState.pageTitle,
    browserCanGoBack: browserState.canGoBack,
    browserCanGoForward: browserState.canGoForward,
    browserErrorInfo: browserState.errorInfo
  }
}

function updateBrowserStateForSession(
  state: Pick<
    UIStore,
    'activeScopedSessionId' | 'activeScopedProjectId' | 'browserStatesBySession'
  >,
  sessionId: string | null | undefined,
  patch: Partial<BrowserPanelSessionState>,
  projectId?: string | null
): Partial<UIStore> {
  const scope = resolvePanelScope(state, sessionId, projectId)
  const key = getBrowserScopeKey(scope)
  const browserStatesBySession = state.browserStatesBySession ?? {}
  const nextBrowserState = {
    ...getBrowserStateFromMap(browserStatesBySession, scope.sessionId, scope.projectId),
    ...patch
  }
  return {
    browserStatesBySession: {
      ...browserStatesBySession,
      [key]: nextBrowserState
    },
    ...(isActiveBrowserScope(state, scope) ? browserAliasState(nextBrowserState) : {})
  }
}

const CHAT_SURFACE_NAV_RESET = {
  settingsPageOpen: false,
  skillsPageOpen: false,
  soulsPageOpen: false,
  syncPageOpen: false,
  resourcesPageOpen: false,
  translatePageOpen: false,
  drawPageOpen: false,
  tasksPageOpen: false,
  pendingInsertText: null
} as const

function replaceChatRouteFromCurrentState(chatView: ChatView): void {
  const chatStore = useChatStore.getState()
  const activeSession = chatStore.activeSessionId
    ? chatStore.sessions.find((item) => item.id === chatStore.activeSessionId)
    : null

  if (chatView === 'session' && activeSession) {
    replaceChatRoute({
      chatView: 'session',
      projectId: activeSession.projectId ?? null,
      sessionId: activeSession.id
    })
    return
  }

  const projectId = chatStore.activeProjectId ?? activeSession?.projectId ?? null
  if (chatView !== 'home' && projectId) {
    replaceChatRoute({ chatView, projectId, sessionId: null })
    return
  }

  replaceChatRoute({ chatView: 'home', projectId: null, sessionId: null })
}

function buildFilePreviewState(
  filePath: string,
  viewMode?: 'preview' | 'code',
  sshConnectionId?: string,
  sessionId?: string | null,
  projectId?: string | null,
  targetLine?: number,
  targetColumn?: number
): PreviewPanelState {
  const pathWithoutQuery = filePath.split(/[?#]/)[0] ?? filePath
  const ext =
    pathWithoutQuery.lastIndexOf('.') >= 0
      ? pathWithoutQuery.slice(pathWithoutQuery.lastIndexOf('.')).toLowerCase()
      : ''
  const onlineOfficeFile = /^https:\/\/\S+/i.test(filePath)
  const previewExts = new Set(['.html', '.htm', '.xhtml', '.shtml'])
  const spreadsheetExts = new Set(['.csv', '.tsv', '.xls', '.xlsx', '.xlsm', '.xlsb', '.ods'])
  const markdownExts = new Set(['.md', '.mdx', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdwn'])
  const imageExts = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.jfif',
    '.pjpeg',
    '.pjp',
    '.gif',
    '.apng',
    '.bmp',
    '.webp',
    '.avif',
    '.ico',
    '.cur',
    '.tif',
    '.tiff',
    '.heic',
    '.heif',
    '.jxl'
  ])
  const videoExts = new Set([
    '.mp4',
    '.webm',
    '.ogv',
    '.mov',
    '.m4v',
    '.mkv',
    '.avi',
    '.mpeg',
    '.mpg',
    '.3gp',
    '.3g2',
    '.mts',
    '.m2ts'
  ])
  const audioExts = new Set([
    '.mp3',
    '.wav',
    '.wave',
    '.ogg',
    '.oga',
    '.m4a',
    '.aac',
    '.flac',
    '.opus',
    '.weba',
    '.aif',
    '.aiff'
  ])
  const svgExts = new Set(['.svg'])
  const fontExts = new Set(['.ttf', '.otf', '.woff', '.woff2'])
  const docxExts = new Set(['.docx', '.docm', '.dotx', '.dotm'])
  const officeOnlineExts = new Set([
    '.doc',
    '.docx',
    '.docm',
    '.dotx',
    '.dotm',
    '.ppt',
    '.pptx',
    '.pps',
    '.ppsx',
    '.odp',
    '.odt',
    '.ott',
    '.rtf',
    '.xls',
    '.xlsx',
    '.xlsm'
  ])
  const pdfExts = new Set(['.pdf'])
  const binaryExts = new Set([
    '.zip',
    '.rar',
    '.7z',
    '.tar',
    '.gz',
    '.tgz',
    '.bz2',
    '.xz',
    '.zst',
    '.jar',
    '.war',
    '.ear',
    '.dmg',
    '.iso',
    '.img',
    '.exe',
    '.msi',
    '.dll',
    '.so',
    '.dylib',
    '.bin',
    '.dat',
    '.sqlite',
    '.sqlite3',
    '.db'
  ])
  let viewerType = 'fallback'
  if (onlineOfficeFile && officeOnlineExts.has(ext)) viewerType = 'office-online'
  else if (previewExts.has(ext)) viewerType = 'html'
  else if (spreadsheetExts.has(ext)) viewerType = 'spreadsheet'
  else if (markdownExts.has(ext)) viewerType = 'markdown'
  else if (svgExts.has(ext)) viewerType = 'svg'
  else if (imageExts.has(ext)) viewerType = 'image'
  else if (videoExts.has(ext)) viewerType = 'video'
  else if (audioExts.has(ext)) viewerType = 'audio'
  else if (fontExts.has(ext)) viewerType = 'font'
  else if (docxExts.has(ext)) viewerType = 'docx'
  else if (officeOnlineExts.has(ext)) viewerType = 'office-online'
  else if (pdfExts.has(ext)) viewerType = 'pdf'
  else if (binaryExts.has(ext)) viewerType = 'binary'
  const previewTypes = new Set([
    'html',
    'markdown',
    'svg',
    'docx',
    'office-online',
    'pdf',
    'image',
    'video',
    'audio',
    'font',
    'binary',
    'spreadsheet'
  ])
  const defaultMode = previewTypes.has(viewerType) ? 'preview' : 'code'

  return {
    source: 'file',
    filePath,
    viewMode: viewMode ?? (targetLine ? 'code' : defaultMode),
    viewerType,
    sshConnectionId: sshConnectionId || undefined,
    sessionId: sessionId === undefined ? undefined : normalizeScopeId(sessionId),
    projectId: projectId === undefined ? undefined : normalizeScopeId(projectId),
    targetLine,
    targetColumn,
    targetPositionKey: targetLine ? Date.now() : undefined
  }
}

function previewScopeKey(state: Pick<PreviewPanelState, 'sessionId' | 'projectId'>): string {
  const sessionId = normalizeScopeId(state.sessionId)
  if (sessionId) return `session:${sessionId}`
  const projectId = normalizeScopeId(state.projectId)
  return projectId ? `project:${projectId}` : 'global'
}

function previewTabId(state: PreviewPanelState): string {
  const scopeKey = previewScopeKey(state)
  if (state.source === 'file') {
    return `file:${scopeKey}:${state.sshConnectionId ?? 'local'}:${state.filePath}`
  }
  if (state.source === 'dev-server') {
    return `dev-server:${scopeKey}:${state.projectDir ?? ''}:${state.port ?? ''}`
  }
  if (state.source === 'diff') {
    const variant = state.gitSection ?? state.agentRunId ?? state.diffSource ?? 'git'
    return `diff:${scopeKey}:${variant}:${state.filePath}`
  }
  return `markdown:${scopeKey}:${state.markdownTitle ?? ''}`
}

function previewTabTitle(state: PreviewPanelState): string {
  if (state.source === 'markdown') return state.markdownTitle || 'Markdown Preview'
  if (state.source === 'dev-server') return state.port ? `localhost:${state.port}` : 'Dev Server'
  const name = state.filePath.split(/[\\/]/).pop() || state.filePath
  if (state.source === 'diff') return `${name} ⇄`
  return name
}

function withPreviewTab(state: PreviewPanelState): PreviewPanelTab {
  return {
    ...state,
    id: previewTabId(state),
    title: previewTabTitle(state)
  }
}

function withPreviewScope(state: PreviewPanelState, scope: PanelScope): PreviewPanelState {
  return {
    ...state,
    sessionId: scope.sessionId,
    projectId: scope.projectId
  }
}

function activatePreviewTab(
  tabs: PreviewPanelTab[],
  activeId: string | null
): PreviewPanelTab | null {
  if (!activeId) return null
  return tabs.find((tab) => tab.id === activeId) ?? null
}

export const useUIStore = create<UIStore>()(
  persist(
    (set, get) => ({
      mode: 'cowork',
      setMode: (mode) => set({ mode }),
      activeNavItem: 'chat',
      setActiveNavItem: (item) =>
        set({ activeNavItem: item, leftSidebarOpen: true, ...closeRightSidePanels() }),
      leftSidebarOpen: true,
      leftSidebarWidth: LEFT_SIDEBAR_DEFAULT_WIDTH,
      toggleLeftSidebar: () =>
        set((state) => {
          const leftSidebarOpen = !state.leftSidebarOpen
          return {
            leftSidebarOpen,
            ...closeRightSidePanels()
          }
        }),
      setLeftSidebarOpen: (open) =>
        set({
          leftSidebarOpen: open,
          ...(open ? closeRightSidePanels() : {})
        }),
      setLeftSidebarWidth: (width) => set({ leftSidebarWidth: clampLeftSidebarWidth(width) }),
      rightPanelOpen: false,
      toggleRightPanel: () =>
        set((state) => {
          const nextOpen = !state.rightPanelOpen
          if (!nextOpen) return { rightPanelOpen: false }
          const sanitized = ensureRightPanelTabs(state.rightPanelTabs)
          const rightPanelTabs = sanitized.length > 0 ? sanitized : [createReviewTab()]
          const rightPanelActiveTabId = rightPanelTabs.some(
            (tab) => tab.id === state.rightPanelActiveTabId
          )
            ? state.rightPanelActiveTabId
            : (rightPanelTabs[0]?.id ?? RIGHT_PANEL_REVIEW_TAB_ID)
          return {
            rightPanelOpen: true,
            rightPanelTabs,
            rightPanelActiveTabId
          }
        }),
      setRightPanelOpen: (open) =>
        set((state) => {
          if (!open) return { rightPanelOpen: false }
          const sanitized = ensureRightPanelTabs(state.rightPanelTabs)
          const rightPanelTabs = sanitized.length > 0 ? sanitized : [createReviewTab()]
          const rightPanelActiveTabId = rightPanelTabs.some(
            (tab) => tab.id === state.rightPanelActiveTabId
          )
            ? state.rightPanelActiveTabId
            : (rightPanelTabs[0]?.id ?? RIGHT_PANEL_REVIEW_TAB_ID)
          return {
            rightPanelOpen: true,
            rightPanelTabs,
            rightPanelActiveTabId
          }
        }),
      runtimeStatusPanelOpen: true,
      toggleRuntimeStatusPanel: () =>
        set((state) => ({ runtimeStatusPanelOpen: !state.runtimeStatusPanelOpen })),
      setRuntimeStatusPanelOpen: (open) => set({ runtimeStatusPanelOpen: open }),
      workingFolderSheetOpen: false,
      toggleWorkingFolderSheet: () =>
        set((state) => ({ workingFolderSheetOpen: !state.workingFolderSheetOpen })),
      setWorkingFolderSheetOpen: (open) => set({ workingFolderSheetOpen: open }),
      workingFolderPanelWidth: WORKING_FOLDER_PANEL_DEFAULT_WIDTH,
      setWorkingFolderPanelWidth: (width) =>
        set({ workingFolderPanelWidth: clampWorkingFolderPanelWidth(width) }),
      bottomTerminalDockOpenByProjectId: {},
      bottomTerminalDockHeight: BOTTOM_TERMINAL_DOCK_DEFAULT_HEIGHT,
      setBottomTerminalDockOpen: (projectId, open) =>
        set((state) => ({
          bottomTerminalDockOpenByProjectId: {
            ...state.bottomTerminalDockOpenByProjectId,
            [projectId]: open
          }
        })),
      toggleBottomTerminalDock: (projectId) =>
        set((state) => ({
          bottomTerminalDockOpenByProjectId: {
            ...state.bottomTerminalDockOpenByProjectId,
            [projectId]: !state.bottomTerminalDockOpenByProjectId[projectId]
          }
        })),
      isBottomTerminalDockOpen: (projectId) =>
        projectId ? Boolean(get().bottomTerminalDockOpenByProjectId[projectId]) : false,
      setBottomTerminalDockHeight: (height) =>
        set({ bottomTerminalDockHeight: clampBottomTerminalDockHeight(height) }),
      rightPanelTab: 'preview',
      setRightPanelTab: (tab) => {
        if (tab === 'browser') {
          get().ensureBrowserTab()
          return
        }
        if (tab === 'files') {
          set((state) => ({
            workingFolderSheetOpen: true,
            agentFilesActiveTabBySurface: {
              ...state.agentFilesActiveTabBySurface,
              sheet: 'files'
            },
            rightPanelTab: tab
          }))
          return
        }
        if (tab === 'subagents') {
          get().ensureSubAgentTab()
          return
        }
        if (tab === 'team' || tab === 'orchestration') {
          get().openOrchestrationPanel()
          return
        }
        set((state) => ({
          rightPanelTabs: ensureReviewTab(state.rightPanelTabs),
          rightPanelActiveTabId: RIGHT_PANEL_REVIEW_TAB_ID,
          rightPanelTab: tab,
          rightPanelOpen: true
        }))
      },
      rightPanelSection: 'execution',
      setRightPanelSection: (section) => set({ rightPanelSection: section }),
      rightPanelTabs: getDefaultRightPanelTabs(),
      rightPanelActiveTabId: RIGHT_PANEL_REVIEW_TAB_ID,
      setRightPanelActiveTab: (tabId) =>
        set((state) => {
          const sanitized = ensureRightPanelTabs(state.rightPanelTabs)
          const targetTab = sanitized.find((tab) => tab.id === tabId)
          if (!targetTab) {
            return {
              rightPanelTabs: ensureReviewTab(sanitized),
              rightPanelActiveTabId: RIGHT_PANEL_REVIEW_TAB_ID,
              rightPanelOpen: true
            }
          }
          const rightPanelTabs = sanitized
          return {
            rightPanelTabs,
            rightPanelActiveTabId: tabId,
            rightPanelOpen: true,
            ...(targetTab.kind === 'preview' && targetTab.previewTabId
              ? {
                  activePreviewPanelTabId: targetTab.previewTabId,
                  previewPanelState: activatePreviewTab(
                    state.previewPanelTabs,
                    targetTab.previewTabId
                  ),
                  previewPanelOpen: true,
                  detailPanelOpen: false,
                  detailPanelContent: null
                }
              : {})
          }
        }),
      openReviewTab: (initialChangeId) =>
        set((state) => ({
          workingFolderSheetOpen: true,
          agentFilesActiveTabBySurface: {
            ...state.agentFilesActiveTabBySurface,
            sheet: 'changes'
          },
          agentFilesSelectedChangeKey:
            normalizeAgentChangeKey(initialChangeId) ?? state.agentFilesSelectedChangeKey
        })),
      ensureBrowserTab: (url, sessionId, projectId) =>
        set((state) => {
          const existing = state.rightPanelTabs.find((tab) => tab.kind === 'browser')
          const tab: RightPanelTabInstance = existing ?? {
            id: 'browser',
            kind: 'browser',
            title: 'Browser',
            closable: true,
            createdAt: Date.now()
          }
          const rightPanelTabs = existing
            ? ensureRightPanelTabs(state.rightPanelTabs)
            : ensureRightPanelTabs([...state.rightPanelTabs, tab])
          return {
            rightPanelTabs,
            rightPanelActiveTabId: tab.id,
            rightPanelTab: 'browser',
            rightPanelOpen: true,
            ...updateBrowserStateForSession(
              state,
              sessionId,
              {
                errorInfo: null,
                ...(url !== undefined ? { url } : {})
              },
              projectId
            )
          }
        }),
      ensureSubAgentTab: (toolUseId, inlineText, title, requestedSessionId) =>
        set((state) => {
          const tabId = toolUseId ? `subagent:${toolUseId}` : 'subagent:overview'
          const sessionId =
            normalizeScopeId(requestedSessionId) ??
            state.activeScopedSessionId ??
            useChatStore.getState().activeSessionId ??
            null
          const existing = state.rightPanelTabs.find((tab) => tab.id === tabId)
          const tab: RightPanelTabInstance = existing
            ? {
                ...existing,
                sessionId: sessionId ?? existing.sessionId ?? null,
                title: title?.trim() || existing.title,
                inlineText: inlineText?.trim() ? inlineText : existing.inlineText
              }
            : {
                id: tabId,
                kind: 'subagent',
                title: title?.trim() || (toolUseId ? 'SubAgent' : 'SubAgents'),
                closable: true,
                sessionId,
                toolUseId: toolUseId ?? null,
                inlineText: inlineText?.trim() ? inlineText : null,
                createdAt: Date.now()
              }
          const rightPanelTabs = ensureRightPanelTabs(
            existing
              ? state.rightPanelTabs.map((item) => (item.id === tabId ? tab : item))
              : [...state.rightPanelTabs, tab]
          )
          return {
            selectedSubAgentToolUseId: toolUseId ?? null,
            subAgentExecutionDetailOpen: false,
            subAgentExecutionDetailToolUseId: toolUseId ?? null,
            subAgentExecutionDetailInlineText: inlineText?.trim() ? inlineText : null,
            orchestrationConsoleOpen: false,
            rightPanelTabs,
            rightPanelActiveTabId: tabId,
            rightPanelTab: 'subagents',
            rightPanelOpen: true
          }
        }),
      ensureTerminalTab: (processId, title) =>
        set((state) => {
          const tabId = `terminal:${processId}`
          const sessionId =
            state.activeScopedSessionId ?? useChatStore.getState().activeSessionId ?? null
          const existing = state.rightPanelTabs.find((tab) => tab.id === tabId)
          const tab: RightPanelTabInstance = existing
            ? {
                ...existing,
                sessionId: sessionId ?? existing.sessionId ?? null,
                title: title?.trim() || existing.title
              }
            : {
                id: tabId,
                kind: 'terminal',
                title: title?.trim() || 'Terminal',
                closable: true,
                sessionId,
                processId,
                createdAt: Date.now()
              }
          const rightPanelTabs = ensureRightPanelTabs(
            existing
              ? state.rightPanelTabs.map((item) => (item.id === tabId ? tab : item))
              : [...state.rightPanelTabs, tab]
          )
          return {
            rightPanelTabs,
            rightPanelActiveTabId: tabId,
            rightPanelTab: 'context',
            rightPanelOpen: true
          }
        }),
      closeRightPanelTab: (tabId) =>
        set((state) => {
          const target = state.rightPanelTabs.find((tab) => tab.id === tabId)
          const nextPreviewTabs =
            target?.kind === 'preview' && target.previewTabId
              ? state.previewPanelTabs.filter((tab) => tab.id !== target.previewTabId)
              : state.previewPanelTabs
          const nextRightPanelTabs = ensureRightPanelTabs(
            state.rightPanelTabs.filter((tab) => tab.id !== tabId)
          )
          // Closing the last tab collapses the right panel entirely.
          const panelEmpty = nextRightPanelTabs.length === 0
          const rightPanelActiveTabId =
            state.rightPanelActiveTabId === tabId
              ? nextRightPanelActiveTab(state.rightPanelTabs, tabId)
              : nextRightPanelTabs.some((tab) => tab.id === state.rightPanelActiveTabId)
                ? state.rightPanelActiveTabId
                : (nextRightPanelTabs[0]?.id ?? RIGHT_PANEL_REVIEW_TAB_ID)
          const nextActiveRightPanelTab = nextRightPanelTabs.find(
            (tab) => tab.id === rightPanelActiveTabId
          )
          const nextActivePreviewTabId =
            nextActiveRightPanelTab?.kind === 'preview'
              ? (nextActiveRightPanelTab.previewTabId ?? null)
              : target?.kind === 'preview' && target.previewTabId === state.activePreviewPanelTabId
                ? null
                : state.activePreviewPanelTabId
          return {
            rightPanelTabs: nextRightPanelTabs,
            rightPanelActiveTabId,
            ...(panelEmpty ? { rightPanelOpen: false } : {}),
            ...(target?.kind === 'preview'
              ? {
                  previewPanelTabs: nextPreviewTabs,
                  activePreviewPanelTabId: nextActivePreviewTabId,
                  previewPanelState: activatePreviewTab(nextPreviewTabs, nextActivePreviewTabId),
                  previewPanelOpen: nextPreviewTabs.length > 0 ? state.previewPanelOpen : false
                }
              : {}),
            ...(target?.kind === 'subagent'
              ? {
                  subAgentExecutionDetailOpen: false,
                  subAgentExecutionDetailToolUseId: null,
                  subAgentExecutionDetailInlineText: null
                }
              : {})
          }
        }),
      rightPanelWidth: 384,
      setRightPanelWidth: (width) => set({ rightPanelWidth: clampRightPanelWidth(width) }),
      agentFilesActiveTabBySurface: {},
      agentFilesSelectedChangeKey: null,
      agentFilesChangeSource: 'all',
      setAgentFilesActiveTab: (surface, tab) =>
        set((state) => ({
          agentFilesActiveTabBySurface: {
            ...state.agentFilesActiveTabBySurface,
            [surface]: tab
          }
        })),
      setAgentFilesSelectedChangeKey: (key) => set({ agentFilesSelectedChangeKey: key }),
      setAgentFilesChangeSource: (source) => set({ agentFilesChangeSource: source }),
      isHoveringRightPanel: false,
      setIsHoveringRightPanel: (hovering) => set({ isHoveringRightPanel: hovering }),
      runtimeStatusPanelTriggerHovered: false,
      setRuntimeStatusPanelTriggerHovered: (hovering) =>
        set({ runtimeStatusPanelTriggerHovered: hovering }),
      settingsOpen: false,
      setSettingsOpen: (open) => set({ settingsOpen: open }),
      settingsPageOpen: false,
      settingsTab: DEFAULT_SETTINGS_TAB,
      openSettingsPage: (tab) => {
        const nextTab = tab ?? DEFAULT_SETTINGS_TAB
        set({
          settingsPageOpen: true,
          settingsOpen: false,
          settingsTab: nextTab,
          skillsPageOpen: false,
          soulsPageOpen: false,
          syncPageOpen: false,
          resourcesPageOpen: false,
          translatePageOpen: false,
          drawPageOpen: false,
          tasksPageOpen: false,
          ...closeRightSidePanels()
        })
        replaceSettingsRoute(nextTab)
      },
      closeSettingsPage: () => {
        set({ settingsPageOpen: false })
        if (parseSettingsRoute(window.location.hash)) {
          replaceChatRouteFromCurrentState(get().chatView)
        }
      },
      setSettingsTab: (tab) => {
        set({ settingsTab: tab })
        if (get().settingsPageOpen || parseSettingsRoute(window.location.hash)) {
          replaceSettingsRoute(tab)
        }
      },
      skillsPageOpen: false,
      openSkillsPage: () =>
        set({
          activeNavItem: 'skills',
          skillsPageOpen: true,
          settingsPageOpen: false,
          soulsPageOpen: false,
          syncPageOpen: false,
          resourcesPageOpen: false,
          translatePageOpen: false,
          drawPageOpen: false,
          tasksPageOpen: false,
          ...closeRightSidePanels()
        }),
      closeSkillsPage: () => set({ skillsPageOpen: false }),
      soulsPageOpen: false,
      openSoulsPage: () =>
        set({
          activeNavItem: 'souls',
          soulsPageOpen: true,
          settingsPageOpen: false,
          skillsPageOpen: false,
          syncPageOpen: false,
          resourcesPageOpen: false,
          translatePageOpen: false,
          drawPageOpen: false,
          tasksPageOpen: false,
          ...closeRightSidePanels()
        }),
      closeSoulsPage: () => set({ soulsPageOpen: false }),
      syncPageOpen: false,
      openSyncPage: () =>
        set({
          activeNavItem: 'sync',
          syncPageOpen: true,
          settingsPageOpen: false,
          skillsPageOpen: false,
          soulsPageOpen: false,
          resourcesPageOpen: false,
          translatePageOpen: false,
          drawPageOpen: false,
          tasksPageOpen: false,
          ...closeRightSidePanels()
        }),
      closeSyncPage: () => set({ syncPageOpen: false }),
      resourcesPageOpen: false,
      openResourcesPage: () =>
        set({
          activeNavItem: 'resources',
          resourcesPageOpen: true,
          settingsPageOpen: false,
          skillsPageOpen: false,
          soulsPageOpen: false,
          syncPageOpen: false,
          translatePageOpen: false,
          drawPageOpen: false,
          tasksPageOpen: false,
          ...closeRightSidePanels()
        }),
      closeResourcesPage: () => set({ resourcesPageOpen: false }),
      translatePageOpen: false,
      openTranslatePage: () =>
        set({
          activeNavItem: 'translate',
          translatePageOpen: true,
          settingsPageOpen: false,
          skillsPageOpen: false,
          soulsPageOpen: false,
          syncPageOpen: false,
          resourcesPageOpen: false,
          drawPageOpen: false,
          tasksPageOpen: false,
          ...closeRightSidePanels()
        }),
      closeTranslatePage: () => set({ translatePageOpen: false }),
      drawPageOpen: false,
      openDrawPage: () =>
        set({
          activeNavItem: 'draw',
          drawPageOpen: true,
          settingsPageOpen: false,
          skillsPageOpen: false,
          soulsPageOpen: false,
          syncPageOpen: false,
          resourcesPageOpen: false,
          translatePageOpen: false,
          tasksPageOpen: false,
          ...closeRightSidePanels()
        }),
      closeDrawPage: () => set({ drawPageOpen: false }),
      tasksPageOpen: false,
      openTasksPage: () =>
        set({
          activeNavItem: 'tasks',
          tasksPageOpen: true,
          settingsPageOpen: false,
          skillsPageOpen: false,
          soulsPageOpen: false,
          syncPageOpen: false,
          resourcesPageOpen: false,
          translatePageOpen: false,
          drawPageOpen: false,
          ...closeRightSidePanels()
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
      openDetailPanel: (content) => {
        if (content.type === 'change-review') {
          set({ detailPanelOpen: false, detailPanelContent: content })
          get().openReviewTab(content.initialChangeId ?? null)
          return
        }

        if (content.type === 'terminal') {
          set({ detailPanelOpen: false, detailPanelContent: content })
          get().ensureTerminalTab(content.processId)
          return
        }

        if (content.type === 'subagent') {
          set({ detailPanelOpen: false, detailPanelContent: content })
          get().ensureSubAgentTab(content.toolUseId ?? null, content.text ?? null)
          return
        }

        set({
          detailPanelOpen: true,
          detailPanelContent: content,
          previewPanelOpen: false,
          previewPanelState: null,
          rightPanelOpen: true
        })
      },
      closeDetailPanel: () => set({ detailPanelOpen: false, detailPanelContent: null }),
      previewPanelOpen: false,
      previewPanelState: null,
      previewPanelTabs: [],
      activePreviewPanelTabId: null,
      openPreviewTab: (previewState, preserveExistingViewMode = false, mirrorToRightPanel = true) =>
        set((state) => {
          const scope = resolvePanelScope(state, previewState.sessionId, previewState.projectId)
          const scopedPreviewState = withPreviewScope(previewState, scope)
          const nextTab = withPreviewTab(scopedPreviewState)
          const existing = state.previewPanelTabs.find((tab) => tab.id === nextTab.id)
          const nextTabs = existing
            ? state.previewPanelTabs.map((tab) =>
                tab.id === nextTab.id
                  ? {
                      ...tab,
                      ...nextTab,
                      viewMode: preserveExistingViewMode ? tab.viewMode : nextTab.viewMode,
                      modified: tab.modified,
                      draftContent: tab.draftContent
                    }
                  : tab
              )
            : [...state.previewPanelTabs, nextTab]
          const activePreviewPanelTabId = nextTab.id
          const previewBase = {
            previewPanelOpen: true,
            previewPanelTabs: nextTabs,
            activePreviewPanelTabId,
            previewPanelState: activatePreviewTab(nextTabs, activePreviewPanelTabId),
            detailPanelOpen: false,
            detailPanelContent: null
          }
          // The WorkspaceView opens tabs in its own central editor and must NOT
          // force the right panel open; chat-driven previews still mirror.
          if (!mirrorToRightPanel) return previewBase

          const previewRightPanelTabId = rightPanelPreviewTabId(nextTab.id)
          const existingRightPanelTab = state.rightPanelTabs.find(
            (tab) => tab.id === previewRightPanelTabId
          )
          const rightPanelTab: RightPanelTabInstance = {
            ...(existingRightPanelTab ?? {
              id: previewRightPanelTabId,
              kind: 'preview' as const,
              closable: true,
              createdAt: Date.now()
            }),
            title: previewTabTitle(nextTab),
            sessionId: scope.sessionId,
            projectId: scope.projectId,
            previewTabId: nextTab.id,
            modified: existing?.modified ?? nextTab.modified ?? false
          }
          const rightPanelTabs = ensureRightPanelTabs(
            existingRightPanelTab
              ? state.rightPanelTabs.map((tab) =>
                  tab.id === previewRightPanelTabId ? rightPanelTab : tab
                )
              : [...state.rightPanelTabs, rightPanelTab]
          )
          return {
            ...previewBase,
            rightPanelTabs,
            rightPanelActiveTabId: previewRightPanelTabId,
            rightPanelOpen: true
          }
        }),
      openDiff: (params) =>
        get().openPreviewTab(
          {
            source: 'diff',
            filePath: params.filePath,
            viewMode: 'code',
            viewerType: 'diff',
            sshConnectionId: params.sshConnectionId || undefined,
            sessionId: params.sessionId,
            projectId: params.projectId,
            diffSource: params.diffSource,
            diffOriginal: params.original,
            diffModified: params.modified,
            diffLanguage: params.language,
            diffModifiedEditable: params.modifiedEditable ?? false,
            diffIsBinary: params.isBinary ?? false,
            diffOriginalRef: params.diffOriginalRef,
            gitRepoPath: params.gitRepoPath,
            gitSection: params.gitSection,
            agentRunId: params.agentRunId,
            agentChangeId: params.agentChangeId
          },
          false,
          params.mirrorToRightPanel ?? true
        ),
      closePreviewTab: (tabId) =>
        set((state) => {
          const index = state.previewPanelTabs.findIndex((tab) => tab.id === tabId)
          if (index < 0) return {}
          const nextTabs = state.previewPanelTabs.filter((tab) => tab.id !== tabId)
          const rightPanelTabId = rightPanelPreviewTabId(tabId)
          const nextRightPanelTabs = ensureRightPanelTabs(
            state.rightPanelTabs.filter((tab) => tab.id !== rightPanelTabId)
          )
          const nextActiveId =
            state.activePreviewPanelTabId === tabId
              ? (nextTabs[Math.min(index, nextTabs.length - 1)]?.id ?? null)
              : state.activePreviewPanelTabId
          return {
            previewPanelTabs: nextTabs,
            activePreviewPanelTabId: nextActiveId,
            previewPanelState: activatePreviewTab(nextTabs, nextActiveId),
            previewPanelOpen: nextTabs.length > 0 ? state.previewPanelOpen : false,
            rightPanelTabs: nextRightPanelTabs,
            rightPanelActiveTabId:
              state.rightPanelActiveTabId === rightPanelTabId
                ? (nextRightPanelTabs.find(
                    (tab) => tab.id === rightPanelPreviewTabId(nextActiveId ?? '')
                  )?.id ?? RIGHT_PANEL_REVIEW_TAB_ID)
                : state.rightPanelActiveTabId
          }
        }),
      setActivePreviewTab: (tabId) =>
        set((state) => {
          const rightPanelTabId = tabId ? rightPanelPreviewTabId(tabId) : null
          return {
            activePreviewPanelTabId: tabId,
            previewPanelState: activatePreviewTab(state.previewPanelTabs, tabId),
            previewPanelOpen: tabId ? true : state.previewPanelOpen,
            detailPanelOpen: tabId ? false : state.detailPanelOpen,
            detailPanelContent: tabId ? null : state.detailPanelContent,
            ...(rightPanelTabId && state.rightPanelTabs.some((tab) => tab.id === rightPanelTabId)
              ? {
                  rightPanelActiveTabId: rightPanelTabId,
                  rightPanelOpen: true
                }
              : {})
          }
        }),
      updatePreviewTab: (tabId, patch) =>
        set((state) => {
          const nextTabs = state.previewPanelTabs.map((tab) =>
            tab.id === tabId ? { ...tab, ...patch } : tab
          )
          const updatedTab = nextTabs.find((tab) => tab.id === tabId)
          const rightPanelTabId = rightPanelPreviewTabId(tabId)
          return {
            previewPanelTabs: nextTabs,
            previewPanelState: activatePreviewTab(nextTabs, state.activePreviewPanelTabId),
            rightPanelTabs: updatedTab
              ? state.rightPanelTabs.map((tab) =>
                  tab.id === rightPanelTabId
                    ? {
                        ...tab,
                        title: previewTabTitle(updatedTab),
                        modified: updatedTab.modified ?? false
                      }
                    : tab
                )
              : state.rightPanelTabs
          }
        }),
      openFilePreview: (filePath, viewMode, sshConnectionId, sessionId, targetLine, targetColumn) =>
        get().openPreviewTab(
          buildFilePreviewState(
            filePath,
            viewMode,
            sshConnectionId,
            sessionId,
            undefined,
            targetLine,
            targetColumn
          ),
          viewMode === undefined && !targetLine
        ),
      openDevServerPreview: (projectDir, port, sessionId) =>
        get().openPreviewTab({
          source: 'dev-server',
          filePath: '',
          viewMode: 'preview',
          viewerType: 'dev-server',
          port,
          projectDir,
          sessionId
        }),
      openMarkdownPreview: (title, content, sessionId) =>
        get().openPreviewTab({
          source: 'markdown',
          filePath: '',
          viewMode: 'preview',
          viewerType: 'markdown',
          markdownContent: content,
          markdownTitle: title,
          sessionId
        }),
      closePreviewPanel: () => set({ previewPanelOpen: false }),
      setPreviewViewMode: (mode) =>
        set((state) => ({
          previewPanelTabs: state.previewPanelTabs.map((tab) =>
            tab.id === state.activePreviewPanelTabId ? { ...tab, viewMode: mode } : tab
          ),
          previewPanelState: state.previewPanelState
            ? { ...state.previewPanelState, viewMode: mode }
            : null
        })),
      activeScopedSessionId: null,
      activeScopedProjectId: null,
      syncSessionScopedState: (sessionId, projectId) =>
        set((state) => {
          const scope = resolvePanelScope(state, sessionId, projectId)
          const scopeChanged =
            state.activeScopedSessionId !== scope.sessionId ||
            state.activeScopedProjectId !== scope.projectId
          const browserState = getBrowserStateFromMap(
            state.browserStatesBySession,
            scope.sessionId,
            scope.projectId
          )
          const browserWebviewRefsBySession = state.browserWebviewRefsBySession ?? {}
          const planModesBySession = state.planModesBySession ?? {}
          const browserWebviewRef = browserWebviewRefsBySession[getBrowserScopeKey(scope)] ?? null
          const scopedPanelState = scopeChanged
            ? {
                rightPanelTabs: keepGlobalRightPanelTabs(state.rightPanelTabs),
                rightPanelActiveTabId: RIGHT_PANEL_REVIEW_TAB_ID,
                previewPanelOpen: false,
                previewPanelState: null,
                activePreviewPanelTabId: null,
                subAgentExecutionDetailOpen: false,
                subAgentExecutionDetailToolUseId: null,
                subAgentExecutionDetailInlineText: null,
                selectedSubAgentToolUseId: null
              }
            : {}
          return {
            activeScopedSessionId: scope.sessionId,
            activeScopedProjectId: scope.projectId,
            planMode: scope.sessionId ? (planModesBySession[scope.sessionId] ?? false) : false,
            browserWebviewRef,
            ...browserAliasState(browserState),
            ...scopedPanelState
          }
        }),
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
      releaseDormantSessionUiState: (keepSessionId) =>
        set((state) => {
          const keep = (key: string): boolean => key === keepSessionId
          const messageListViewStatesBySession = state.messageListViewStatesBySession ?? {}
          const autoModelSelectionsBySession = state.autoModelSelectionsBySession ?? {}
          const autoModelHighConfidenceSelectionsBySession =
            state.autoModelHighConfidenceSelectionsBySession ?? {}
          const autoModelRoutingStatesBySession = state.autoModelRoutingStatesBySession ?? {}
          const planModesBySession = state.planModesBySession ?? {}
          return {
            messageListViewStatesBySession: Object.fromEntries(
              Object.entries(messageListViewStatesBySession).filter(([k]) => keep(k))
            ),
            autoModelSelectionsBySession: Object.fromEntries(
              Object.entries(autoModelSelectionsBySession).filter(([k]) => keep(k))
            ),
            autoModelHighConfidenceSelectionsBySession: Object.fromEntries(
              Object.entries(autoModelHighConfidenceSelectionsBySession).filter(([k]) => keep(k))
            ),
            autoModelRoutingStatesBySession: Object.fromEntries(
              Object.entries(autoModelRoutingStatesBySession).filter(([k]) => keep(k))
            ),
            planModesBySession: Object.fromEntries(
              Object.entries(planModesBySession).filter(([k]) => keep(k))
            )
          }
        }),
      autoModelSelectionsBySession: {},
      autoModelHighConfidenceSelectionsBySession: {},
      autoModelRoutingStatesBySession: {},
      setAutoModelSelection: (sessionId, status) =>
        set((state) => ({
          autoModelSelectionsBySession: {
            ...state.autoModelSelectionsBySession,
            [sessionId]: status
          }
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
      openSubAgentsPanel: (toolUseId, sessionId) =>
        get().ensureSubAgentTab(toolUseId ?? null, null, null, sessionId),
      browserStatesBySession: {},
      getBrowserState: (sessionId, projectId) => {
        const state = get()
        const scope = resolvePanelScope(state, sessionId, projectId)
        return getBrowserStateFromMap(
          state.browserStatesBySession,
          scope.sessionId,
          scope.projectId
        )
      },
      patchBrowserState: (sessionId, patch, projectId) =>
        set((state) => updateBrowserStateForSession(state, sessionId, patch, projectId)),
      browserUrl: '',
      setBrowserUrl: (url, sessionId, projectId) =>
        set((state) => updateBrowserStateForSession(state, sessionId, { url }, projectId)),
      openBrowserTab: (url, sessionId, projectId) =>
        get().ensureBrowserTab(url, sessionId, projectId),
      browserLoading: false,
      setBrowserLoading: (loading, sessionId, projectId) =>
        set((state) => updateBrowserStateForSession(state, sessionId, { loading }, projectId)),
      browserPageTitle: '',
      setBrowserPageTitle: (pageTitle, sessionId, projectId) =>
        set((state) => updateBrowserStateForSession(state, sessionId, { pageTitle }, projectId)),
      browserCanGoBack: false,
      setBrowserCanGoBack: (canGoBack, sessionId, projectId) =>
        set((state) => updateBrowserStateForSession(state, sessionId, { canGoBack }, projectId)),
      browserCanGoForward: false,
      setBrowserCanGoForward: (canGoForward, sessionId, projectId) =>
        set((state) => updateBrowserStateForSession(state, sessionId, { canGoForward }, projectId)),
      browserErrorInfo: null,
      setBrowserErrorInfo: (errorInfo, sessionId, projectId) =>
        set((state) => updateBrowserStateForSession(state, sessionId, { errorInfo }, projectId)),
      browserWebviewRefsBySession: {},
      getBrowserWebviewRef: (sessionId, projectId) => {
        const state = get()
        const scope = resolvePanelScope(state, sessionId, projectId)
        return state.browserWebviewRefsBySession[getBrowserScopeKey(scope)] ?? null
      },
      browserWebviewRef: null,
      setBrowserWebviewRef: (ref, sessionId, projectId) =>
        set((state) => {
          const scope = resolvePanelScope(state, sessionId, projectId)
          const key = getBrowserScopeKey(scope)
          const browserWebviewRefsBySession = { ...state.browserWebviewRefsBySession }
          if (ref) {
            browserWebviewRefsBySession[key] = ref
          } else {
            delete browserWebviewRefsBySession[key]
          }
          return {
            browserWebviewRefsBySession,
            ...(isActiveBrowserScope(state, scope) ? { browserWebviewRef: ref } : {})
          }
        }),
      subAgentExecutionDetailOpen: false,
      subAgentExecutionDetailToolUseId: null,
      subAgentExecutionDetailInlineText: null,
      openSubAgentExecutionDetail: (toolUseId, inlineText, title, sessionId) =>
        get().ensureSubAgentTab(toolUseId, inlineText ?? null, title ?? null, sessionId),
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
        // 进入主页（新建会话视图）意味着没有活动会话，立即退订当前会话，
        // 避免旧的 MessageList 在视图退场动画期间继续全量重渲染与 IPC 加载造成卡顿。
        if (useChatStore.getState().activeSessionId) {
          useChatStore.getState().setActiveSession(null)
        }
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
        const resolvedProjectId = resolvedSession
          ? (resolvedSession.projectId ?? null)
          : (store.activeProjectId ?? null)
        set({ activeNavItem: 'chat', chatView: 'session', ...CHAT_SURFACE_NAV_RESET })
        replaceChatRoute({
          chatView: resolvedSessionId ? 'session' : resolvedProjectId ? 'project' : 'home',
          projectId: resolvedProjectId,
          sessionId: resolvedSessionId
        })
      },
      applyRouteFromLocation: () => {
        const settingsRoute = parseSettingsRoute(window.location.hash)
        if (settingsRoute) {
          set({
            settingsPageOpen: true,
            settingsOpen: false,
            settingsTab: settingsRoute.tab,
            skillsPageOpen: false,
            soulsPageOpen: false,
            syncPageOpen: false,
            resourcesPageOpen: false,
            translatePageOpen: false,
            drawPageOpen: false,
            tasksPageOpen: false,
            ...closeRightSidePanels()
          })
          if (window.location.hash !== settingsRoute.canonicalHash) {
            window.history.replaceState(null, '', settingsRoute.canonicalHash)
          }
          return
        }

        get().applyChatRouteFromLocation()
      },
      applyChatRouteFromLocation: () => {
        const route = parseChatRoute(window.location.hash)
        const chatStore = useChatStore.getState()
        let resolvedRouteProjectId = route.projectId

        if (route.projectId) {
          const hasProject = chatStore.projects.some((project) => project.id === route.projectId)
          if (hasProject) {
            chatStore.setActiveProject(route.projectId)
          } else {
            resolvedRouteProjectId = null
          }
        }

        if (route.sessionId) {
          const session = chatStore.sessions.find((item) => item.id === route.sessionId)
          if (session) {
            chatStore.setActiveSession(session.id)
            set({ activeNavItem: 'chat', chatView: 'session', ...CHAT_SURFACE_NAV_RESET })
            replaceChatRoute({
              chatView: 'session',
              projectId: session.projectId ?? null,
              sessionId: session.id
            })
            return
          }
        }

        chatStore.setActiveSession(null)

        if (route.chatView !== 'home') {
          const resolvedProjectId = resolvedRouteProjectId ?? chatStore.activeProjectId ?? null
          if (!resolvedProjectId) {
            set({ activeNavItem: 'chat', chatView: 'home', ...CHAT_SURFACE_NAV_RESET })
            replaceChatRoute({ chatView: 'home', projectId: null, sessionId: null })
            return
          }
        }

        set({ activeNavItem: 'chat', chatView: route.chatView, ...CHAT_SURFACE_NAV_RESET })
        replaceChatRoute({
          chatView: route.chatView,
          projectId: resolvedRouteProjectId ?? chatStore.activeProjectId ?? null,
          sessionId: null
        })
      }
    }),
    {
      name: 'opencowork-ui-state',
      version: 1,
      storage: createJSONStorage(() => ipcStorage),
      partialize: (state) => ({
        leftSidebarOpen: state.leftSidebarOpen,
        leftSidebarWidth: clampLeftSidebarWidth(state.leftSidebarWidth),
        rightPanelOpen: state.rightPanelOpen,
        runtimeStatusPanelOpen: state.runtimeStatusPanelOpen,
        rightPanelWidth: clampRightPanelWidth(state.rightPanelWidth),
        workingFolderSheetOpen: state.workingFolderSheetOpen,
        workingFolderPanelWidth: clampWorkingFolderPanelWidth(state.workingFolderPanelWidth),
        agentFilesActiveTabBySurface: state.agentFilesActiveTabBySurface,
        agentFilesChangeSource: state.agentFilesChangeSource,
        bottomTerminalDockOpenByProjectId: state.bottomTerminalDockOpenByProjectId,
        bottomTerminalDockHeight: clampBottomTerminalDockHeight(state.bottomTerminalDockHeight)
      }),
      merge: (persisted, current) => {
        const state = persisted as Partial<UIStore>
        return {
          ...current,
          ...state,
          toolbarCollapsedByDefault: undefined,
          leftSidebarOpen:
            typeof state.leftSidebarOpen === 'boolean'
              ? state.leftSidebarOpen
              : !(state as { toolbarCollapsedByDefault?: boolean }).toolbarCollapsedByDefault,
          leftSidebarWidth: clampLeftSidebarWidth(
            state.leftSidebarWidth ?? current.leftSidebarWidth
          ),
          rightPanelWidth: clampRightPanelWidth(state.rightPanelWidth ?? current.rightPanelWidth),
          runtimeStatusPanelOpen:
            typeof state.runtimeStatusPanelOpen === 'boolean'
              ? state.runtimeStatusPanelOpen
              : current.runtimeStatusPanelOpen,
          rightPanelTabs: getDefaultRightPanelTabs(),
          rightPanelActiveTabId: RIGHT_PANEL_REVIEW_TAB_ID,
          rightPanelTab: 'preview',
          rightPanelSection: 'execution',
          agentFilesActiveTabBySurface:
            state.agentFilesActiveTabBySurface ?? current.agentFilesActiveTabBySurface ?? {},
          agentFilesSelectedChangeKey: null,
          agentFilesChangeSource:
            state.agentFilesChangeSource ?? current.agentFilesChangeSource ?? 'all',
          browserStatesBySession:
            state.browserStatesBySession ?? current.browserStatesBySession ?? {},
          browserWebviewRefsBySession: current.browserWebviewRefsBySession ?? {},
          messageListViewStatesBySession:
            state.messageListViewStatesBySession ?? current.messageListViewStatesBySession ?? {},
          autoModelSelectionsBySession:
            state.autoModelSelectionsBySession ?? current.autoModelSelectionsBySession ?? {},
          autoModelHighConfidenceSelectionsBySession:
            state.autoModelHighConfidenceSelectionsBySession ??
            current.autoModelHighConfidenceSelectionsBySession ??
            {},
          autoModelRoutingStatesBySession:
            state.autoModelRoutingStatesBySession ?? current.autoModelRoutingStatesBySession ?? {},
          planModesBySession: state.planModesBySession ?? current.planModesBySession ?? {},
          workingFolderPanelWidth: clampWorkingFolderPanelWidth(
            state.workingFolderPanelWidth ?? current.workingFolderPanelWidth
          ),
          bottomTerminalDockHeight: clampBottomTerminalDockHeight(
            state.bottomTerminalDockHeight ?? current.bottomTerminalDockHeight
          )
        }
      }
    }
  )
)
