import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import { useTranslation } from 'react-i18next'
import {
  ArrowDownAZ,
  BookOpen,
  CalendarDays,
  ChevronRight,
  Copy,
  Download,
  Eraser,
  ExternalLink,
  FileText,
  FolderInput,
  GitBranch,
  Image as ImageIcon,
  ListFilter,
  Loader2,
  MessageSquare,
  PanelLeftClose,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Server,
  SquareKanban,
  SquarePen,
  Clock3,
  CloudSync,
  Library,
  Palette,
  Plug,
  Puzzle,
  Search,
  Sparkles,
  Trash2,
  Upload,
  Wand2
} from 'lucide-react'
import {
  AISidebar,
  type SidebarResource,
  type SidebarResourceMenuControls
} from '@renderer/components/agents/ai-sidebar'
import { SharedLayoutBg } from '@renderer/components/motion/shared-layout-bg'
import { ProjectIcon } from '@renderer/components/chat/ProjectIcon'
import { ProjectIconPickerDialog } from '@renderer/components/chat/ProjectIconPickerDialog'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@renderer/components/ui/alert-dialog'
import {
  useChatStore,
  type Project,
  type Session,
  type SessionMode
} from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useTeamStore } from '@renderer/stores/team-store'
import { useBackgroundSessionStore } from '@renderer/stores/background-session-store'
import {
  abortSession,
  clearPendingSessionMessages,
  getPendingSessionMessageCountForSession,
  subscribePendingSessionMessages
} from '@renderer/hooks/use-chat-actions'
import {
  exportSessionMarkdownFromDb,
  exportSessionSnapshotFromDb
} from '@renderer/lib/utils/export-chat'
import { openDetachedSessionWindow, openSessionOrFocusDetached } from '@renderer/lib/session-window'
import { cn } from '@renderer/lib/utils'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { DB_SESSIONS_CLEAR_PROJECT_MSGPACK_CHANNEL } from '../../../../shared/messagepack/binary-ipc'
import { invokeMessagePackBinary } from '@renderer/lib/ipc/messagepack-ipc-client'
import { getDroppedLocalPaths, filterDirectories } from '@renderer/lib/drag-folder'
import { generateSessionTitle } from '@renderer/lib/api/generate-title'
import { resolveIntlLocale } from '@renderer/lib/i18n-language'
import { clampLeftSidebarWidth, LEFT_SIDEBAR_DEFAULT_WIDTH } from './right-panel-defs'
import { WorkingFolderSelectorDialog } from '@renderer/components/chat/WorkingFolderSelectorDialog'
import { toast } from 'sonner'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { AccountMenu } from './AccountMenu'

const DEFAULT_VISIBLE_SESSIONS_PER_PROJECT = 4
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS
const PROJECT_SORT_STORAGE_KEY = 'openCowork.workspaceSidebar.projectSortMode'
const PROJECT_COLLAPSED_IDS_STORAGE_KEY = 'openCowork.workspaceSidebar.collapsedProjectIds'
const PROJECT_EXPANDED_IDS_STORAGE_KEY = 'openCowork.workspaceSidebar.expandedProjectIds'
const PROJECT_RESOURCE_PREFIX = 'project:'
const SESSION_RESOURCE_PREFIX = 'session:'
const CHATS_FOLDER_ID = 'folder:chats'
const LOAD_MORE_CHATS_ID = 'action:load-more-chats'
const SIDEBAR_NAV_BUTTON_CLASS =
  'relative flex min-h-7 w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-lg px-2 text-left text-sm font-medium outline-none text-muted-foreground transition-colors hover:text-foreground focus-visible:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring'
const SIDEBAR_RESOURCE_MENU_ITEM_CLASS =
  'flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-foreground outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40'
const SIDEBAR_RESOURCE_MENU_DESTRUCTIVE_CLASS =
  'flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-destructive outline-none transition-colors hover:bg-destructive/10 focus-visible:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40'

function projectResourceId(projectId: string): string {
  return `${PROJECT_RESOURCE_PREFIX}${projectId}`
}

function sessionResourceId(sessionId: string): string {
  return `${SESSION_RESOURCE_PREFIX}${sessionId}`
}

function loadMoreProjectId(projectId: string): string {
  return `action:load-more:${projectId}`
}

function parseProjectResourceId(id: string): string | null {
  return id.startsWith(PROJECT_RESOURCE_PREFIX) ? id.slice(PROJECT_RESOURCE_PREFIX.length) : null
}

function parseSessionResourceId(id: string): string | null {
  return id.startsWith(SESSION_RESOURCE_PREFIX) ? id.slice(SESSION_RESOURCE_PREFIX.length) : null
}

function parseLoadMoreProjectId(id: string): string | null {
  return id.startsWith('action:load-more:') && id !== LOAD_MORE_CHATS_ID
    ? id.slice('action:load-more:'.length)
    : null
}

function SidebarResourceMenuItem({
  icon,
  children,
  destructive = false,
  disabled = false,
  onSelect
}: {
  icon: React.ReactNode
  children: React.ReactNode
  destructive?: boolean
  disabled?: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={
        destructive ? SIDEBAR_RESOURCE_MENU_DESTRUCTIVE_CLASS : SIDEBAR_RESOURCE_MENU_ITEM_CLASS
      }
    >
      {icon}
      {children}
    </button>
  )
}

function SidebarResourceMenuSeparator(): React.JSX.Element {
  return <div className="my-1 h-px bg-border" />
}
const PROJECT_SORT_MODES = ['updatedAt', 'name', 'createdAt'] as const
type ProjectSortMode = (typeof PROJECT_SORT_MODES)[number]

const PROJECT_SORT_LABEL_KEYS: Record<ProjectSortMode, string> = {
  updatedAt: 'sidebar.projectSortRecentlyUpdated',
  name: 'sidebar.projectSortName',
  createdAt: 'sidebar.projectSortCreatedAt'
}

type FolderPickerTarget =
  | { type: 'create'; projectName: string; preferredSection?: 'local' | 'ssh' }
  | { type: 'project'; projectId: string }
type SessionListItem = ReturnType<typeof mapSession>
type ProjectListItem = ReturnType<typeof mapProject>

interface ProjectTreeGroup {
  project: ProjectListItem
  sessions: SessionListItem[]
  isRunning: boolean
  hasMore: boolean
  isLoadingMore: boolean
}

function projectGroupHasMoreSessions(
  page: { loaded: boolean; hasMore: boolean } | undefined,
  loadedSessionCount: number,
  knownSessionCount?: number
): boolean {
  if (typeof knownSessionCount === 'number' && loadedSessionCount >= knownSessionCount) {
    return false
  }
  return page?.loaded === true && page.hasMore === true
}

function mapSession(session: ReturnType<typeof useChatStore.getState>['sessions'][number]): {
  id: string
  title: string
  icon?: string
  mode: SessionMode
  updatedAt: number
  createdAt: number
  pinned?: boolean
  messageCount: number
  projectId?: string
} {
  return {
    id: session.id,
    title: session.title,
    icon: session.icon,
    mode: session.mode,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    pinned: session.pinned,
    messageCount: session.messageCount,
    projectId: session.projectId
  }
}

function mapProject(project: ReturnType<typeof useChatStore.getState>['projects'][number]): {
  id: string
  name: string
  icon?: string
  createdAt: number
  updatedAt: number
  workingFolder?: string
  sshConnectionId?: string
  pluginId?: string
  pinned?: boolean
  sessionCount?: number
} {
  return {
    id: project.id,
    name: project.name,
    icon: project.icon,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    workingFolder: project.workingFolder,
    sshConnectionId: project.sshConnectionId,
    pluginId: project.pluginId,
    pinned: project.pinned,
    sessionCount: project.sessionCount
  }
}

function areProjectListsEqual(
  left: ReturnType<typeof useChatStore.getState>['projects'],
  right: ReturnType<typeof useChatStore.getState>['projects']
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === b) continue
    if (
      a.id !== b.id ||
      a.name !== b.name ||
      a.icon !== b.icon ||
      a.createdAt !== b.createdAt ||
      a.updatedAt !== b.updatedAt ||
      a.workingFolder !== b.workingFolder ||
      a.sshConnectionId !== b.sshConnectionId ||
      a.pluginId !== b.pluginId ||
      !!a.pinned !== !!b.pinned
    ) {
      return false
    }
  }
  return true
}

function areSessionListsEqual(
  left: ReturnType<typeof useChatStore.getState>['sessions'],
  right: ReturnType<typeof useChatStore.getState>['sessions']
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === b) continue
    if (
      a.id !== b.id ||
      a.title !== b.title ||
      a.icon !== b.icon ||
      a.mode !== b.mode ||
      a.updatedAt !== b.updatedAt ||
      a.createdAt !== b.createdAt ||
      !!a.pinned !== !!b.pinned ||
      a.messageCount !== b.messageCount ||
      a.projectId !== b.projectId
    ) {
      return false
    }
  }
  return true
}

function deriveProjectNameFromFolder(folderPath?: string | null): string {
  const normalized = folderPath?.trim().replace(/[\\/]+$/, '')
  if (!normalized) return 'New Project'
  const parts = normalized.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || 'New Project'
}

function downloadMarkdown(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function sanitizeExportFileName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9-_ ]/g, '').trim()
  return sanitized || 'conversation'
}

function isProjectSortMode(value: string | null): value is ProjectSortMode {
  return PROJECT_SORT_MODES.includes(value as ProjectSortMode)
}

function readProjectSortMode(): ProjectSortMode {
  try {
    const stored = window.localStorage.getItem(PROJECT_SORT_STORAGE_KEY)
    if (isProjectSortMode(stored)) return stored
  } catch {
    // Ignore storage failures and keep the existing default order.
  }
  return 'updatedAt'
}

function writeProjectSortMode(mode: ProjectSortMode): void {
  try {
    window.localStorage.setItem(PROJECT_SORT_STORAGE_KEY, mode)
  } catch {
    // Sorting still works for the current session if persistence is unavailable.
  }
}

function readCollapsedProjectIds(): Set<string> {
  try {
    const stored = window.localStorage.getItem(PROJECT_COLLAPSED_IDS_STORAGE_KEY)
    if (stored) return new Set(JSON.parse(stored))
  } catch {
    // Fallback to empty set if persistence is unavailable.
  }
  return new Set()
}

function writeCollapsedProjectIds(ids: Set<string>): void {
  try {
    window.localStorage.setItem(PROJECT_COLLAPSED_IDS_STORAGE_KEY, JSON.stringify([...ids]))
  } catch {
    // Collapse state still works for the current session if persistence is unavailable.
  }
}

function hasStoredCollapsedProjectIds(): boolean {
  try {
    return window.localStorage.getItem(PROJECT_COLLAPSED_IDS_STORAGE_KEY) !== null
  } catch {
    return false
  }
}

function readExpandedProjectIds(): Set<string> {
  try {
    const stored = window.localStorage.getItem(PROJECT_EXPANDED_IDS_STORAGE_KEY)
    if (stored) return new Set(JSON.parse(stored))
  } catch {
    // Fallback to empty set if persistence is unavailable.
  }
  return new Set()
}

function writeExpandedProjectIds(ids: Set<string>): void {
  try {
    window.localStorage.setItem(PROJECT_EXPANDED_IDS_STORAGE_KEY, JSON.stringify([...ids]))
  } catch {
    // Expansion state still works for the current session if persistence is unavailable.
  }
}

function compareProjectNames(
  left: ProjectListItem,
  right: ProjectListItem,
  collator: Intl.Collator
): number {
  return collator.compare(left.name, right.name)
}

function compareProjectIds(left: ProjectListItem, right: ProjectListItem): number {
  return left.id.localeCompare(right.id)
}

function sortProjects(
  left: ProjectListItem,
  right: ProjectListItem,
  mode: ProjectSortMode,
  collator: Intl.Collator
): number {
  if (!!left.pinned !== !!right.pinned) return left.pinned ? -1 : 1
  if (mode === 'name') {
    return (
      compareProjectNames(left, right, collator) ||
      right.updatedAt - left.updatedAt ||
      right.createdAt - left.createdAt ||
      compareProjectIds(left, right)
    )
  }
  if (mode === 'createdAt') {
    return (
      right.createdAt - left.createdAt ||
      compareProjectNames(left, right, collator) ||
      right.updatedAt - left.updatedAt ||
      compareProjectIds(left, right)
    )
  }
  return (
    right.updatedAt - left.updatedAt ||
    compareProjectNames(left, right, collator) ||
    right.createdAt - left.createdAt ||
    compareProjectIds(left, right)
  )
}

function sortSessions(left: SessionListItem, right: SessionListItem): number {
  if (!!left.pinned !== !!right.pinned) return left.pinned ? -1 : 1
  return right.updatedAt - left.updatedAt || right.id.localeCompare(left.id)
}

function formatRelativeTime(updatedAt: number, locale: string): string {
  const elapsed = Date.now() - updatedAt
  const rtf = new Intl.RelativeTimeFormat(locale, {
    numeric: 'always',
    style: 'narrow'
  })
  if (elapsed < HOUR_MS) {
    return rtf.format(-Math.max(1, Math.round(elapsed / MINUTE_MS)), 'minute')
  }
  if (elapsed < DAY_MS) {
    return rtf.format(-Math.max(1, Math.round(elapsed / HOUR_MS)), 'hour')
  }
  if (elapsed < WEEK_MS) {
    return rtf.format(-Math.max(1, Math.round(elapsed / DAY_MS)), 'day')
  }
  return rtf.format(-Math.max(1, Math.round(elapsed / WEEK_MS)), 'week')
}

function getSessionMessageText(message: Session['messages'][number]): string {
  if (typeof message.content === 'string') return message.content.trim()

  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

function buildSmartRenameInput(session: Session): string {
  const excerpts: string[] = []

  for (const message of session.messages) {
    if (message.role === 'system') continue
    const text = getSessionMessageText(message)
    if (!text) continue
    excerpts.push(`${message.role}: ${text.slice(0, 1200)}`)
    if (excerpts.length >= 16) break
  }

  const transcript = excerpts.join('\n\n').slice(0, 6000).trim()
  if (!transcript) return ''

  return [
    'Generate a concise session title from this conversation.',
    `Current title: ${session.title}`,
    'Conversation excerpt:',
    transcript
  ].join('\n\n')
}

type ExportedSessionPayload = {
  version: 1
  type: 'session'
  session: Session
}

type ExportedProjectPayload = {
  version: 1
  type: 'project'
  project: Project
  sessions: Session[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function WorkspaceSidebar(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const { t: tCommon } = useTranslation('common')
  const isMac = /Mac/.test(navigator.userAgent)
  const chatView = useUIStore((state) => state.chatView)
  const settingsPageOpen = useUIStore((state) => state.settingsPageOpen)
  const settingsTab = useUIStore((state) => state.settingsTab)
  const skillsPageOpen = useUIStore((state) => state.skillsPageOpen)
  const soulsPageOpen = useUIStore((state) => state.soulsPageOpen)
  const syncPageOpen = useUIStore((state) => state.syncPageOpen)
  const resourcesPageOpen = useUIStore((state) => state.resourcesPageOpen)
  const drawPageOpen = useUIStore((state) => state.drawPageOpen)
  const translatePageOpen = useUIStore((state) => state.translatePageOpen)
  const tasksPageOpen = useUIStore((state) => state.tasksPageOpen)
  const taskBoardPageOpen = useUIStore((state) => state.taskBoardPageOpen)
  const leftSidebarWidth = useUIStore((state) => state.leftSidebarWidth)
  const setLeftSidebarWidth = useUIStore((state) => state.setLeftSidebarWidth)
  const toggleLeftSidebar = useUIStore((state) => state.toggleLeftSidebar)
  const persistedLeftSidebarWidth = useSettingsStore((state) => state.leftSidebarWidth)
  const updateSettings = useSettingsStore((state) => state.updateSettings)
  const projectsRaw = useStoreWithEqualityFn(
    useChatStore,
    (state) => state.projects,
    areProjectListsEqual
  )
  const sessionsRaw = useStoreWithEqualityFn(
    useChatStore,
    (state) => state.sessions,
    areSessionListsEqual
  )
  const projects = useMemo(() => projectsRaw.map(mapProject), [projectsRaw])
  const sessions = useMemo(() => sessionsRaw.map(mapSession), [sessionsRaw])
  const activeProjectId = useChatStore((state) => state.activeProjectId)
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  const streamingSessionIdsSig = useChatStore((state) =>
    Object.keys(state.streamingMessages).sort().join('\u0000')
  )
  const createProject = useChatStore((state) => state.createProject)
  const setActiveProject = useChatStore((state) => state.setActiveProject)
  const setActiveProjectHome = useChatStore((state) => state.setActiveProjectHome)
  const renameProject = useChatStore((state) => state.renameProject)
  const deleteProject = useChatStore((state) => state.deleteProject)
  const togglePinProject = useChatStore((state) => state.togglePinProject)
  const updateProjectIcon = useChatStore((state) => state.updateProjectIcon)
  const updateProjectDirectory = useChatStore((state) => state.updateProjectDirectory)
  const deleteSession = useChatStore((state) => state.deleteSession)
  const updateSessionTitle = useChatStore((state) => state.updateSessionTitle)
  const updateSessionIcon = useChatStore((state) => state.updateSessionIcon)
  const duplicateSession = useChatStore((state) => state.duplicateSession)
  const clearSessionMessages = useChatStore((state) => state.clearSessionMessages)
  const togglePinSession = useChatStore((state) => state.togglePinSession)
  const importSession = useChatStore((state) => state.importSession)
  const importProjectArchive = useChatStore((state) => state.importProjectArchive)
  const loadProjectSessions = useChatStore((state) => state.loadProjectSessions)
  const loadMoreProjectSessions = useChatStore((state) => state.loadMoreProjectSessions)
  const loadMoreChatSessions = useChatStore((state) => state.loadMoreChatSessions)
  const sessionListPageState = useChatStore((state) => state.sessionListPageState)
  const runningSessions = useAgentStore((state) => state.runningSessions)
  const runningSubAgentSessionIdsSig = useAgentStore((state) => state.runningSubAgentSessionIdsSig)
  const runningBackgroundSessionIdsSig = useAgentStore((state) =>
    Object.values(state.backgroundProcesses)
      .filter((process) => process.sessionId && process.status === 'running')
      .map((process) => process.sessionId as string)
      .sort()
      .join('\u0000')
  )
  const activeTeamSessionId = useTeamStore((state) => state.activeTeam?.sessionId ?? null)
  const waitingReplySessionIdsSig = useBackgroundSessionStore((state) => {
    const ids = new Set<string>()
    for (const item of state.inboxItems) {
      if (item.type === 'ask_user') ids.add(item.sessionId)
    }
    return [...ids].sort().join('\u0000')
  })
  const language = useSettingsStore((state) => state.language)
  const relativeTimeLocale = useMemo(() => resolveIntlLocale(language), [language])
  const projectNameCollator = useMemo(
    () => new Intl.Collator(relativeTimeLocale, { numeric: true, sensitivity: 'base' }),
    [relativeTimeLocale]
  )
  const importSessionInputRef = useRef<HTMLInputElement>(null)
  const importProjectInputRef = useRef<HTMLInputElement>(null)
  const treeScrollRef = useRef<HTMLDivElement>(null)
  const [deleteTarget, setDeleteTarget] = useState<
    | { type: 'project'; id: string; name: string; sessionCount: number }
    | { type: 'session'; id: string; title: string }
    | null
  >(null)
  const [clearSessionTarget, setClearSessionTarget] = useState<{
    id: string
    title: string
    pendingCount: number
  } | null>(null)
  const [clearProjectSessionsTarget, setClearProjectSessionsTarget] = useState<{
    id: string
    name: string
    clearableCount: number
    runningCount: number
  } | null>(null)
  const [autoRenamingSessionId, setAutoRenamingSessionId] = useState<string | null>(null)
  const [folderPickerTarget, setFolderPickerTarget] = useState<FolderPickerTarget | null>(null)
  const [iconPickerTarget, setIconPickerTarget] = useState<{
    id: string
    name: string
  } | null>(null)
  const [featureMenuOpen, setFeatureMenuOpen] = useState(false)
  const [projectSortMode, setProjectSortMode] = useState<ProjectSortMode>(readProjectSortMode)
  const [isFolderDragOver, setIsFolderDragOver] = useState(false)
  const [chatsSectionCollapsed, setChatsSectionCollapsed] = useState(false)
  const [collapsedProjectIds, setCollapsedProjectIds] =
    useState<Set<string>>(readCollapsedProjectIds)
  const collapseStateInitializedRef = useRef(false)
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(readExpandedProjectIds)
  const featureMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const runningSubAgentSessionIds = useMemo(
    () => new Set(runningSubAgentSessionIdsSig ? runningSubAgentSessionIdsSig.split('\u0000') : []),
    [runningSubAgentSessionIdsSig]
  )
  const runningBackgroundSessionIds = useMemo(
    () =>
      new Set(runningBackgroundSessionIdsSig ? runningBackgroundSessionIdsSig.split('\u0000') : []),
    [runningBackgroundSessionIdsSig]
  )
  const waitingReplySessionIds = useMemo(
    () => new Set(waitingReplySessionIdsSig ? waitingReplySessionIdsSig.split('\u0000') : []),
    [waitingReplySessionIdsSig]
  )
  const streamingSessionIds = useMemo(
    () => new Set(streamingSessionIdsSig ? streamingSessionIdsSig.split('\u0000') : []),
    [streamingSessionIdsSig]
  )
  const pendingQueueSignature = useSyncExternalStore(
    subscribePendingSessionMessages,
    () =>
      sessions
        .map((session) => `${session.id}:${getPendingSessionMessageCountForSession(session.id)}`)
        .join('|'),
    () => ''
  )
  const visibleProjects = useMemo(
    () =>
      projects
        .filter((project) => !project.pluginId)
        .slice()
        .sort((left, right) => sortProjects(left, right, projectSortMode, projectNameCollator)),
    [projectNameCollator, projectSortMode, projects]
  )
  const folderPickerProjectId =
    folderPickerTarget?.type === 'project' ? folderPickerTarget.projectId : null
  const folderPickerProject = folderPickerProjectId
    ? visibleProjects.find((project) => project.id === folderPickerProjectId)
    : undefined
  const iconPickerProject = iconPickerTarget
    ? visibleProjects.find((project) => project.id === iconPickerTarget.id)
    : undefined
  const chatSurfaceActive =
    !settingsPageOpen &&
    !skillsPageOpen &&
    !soulsPageOpen &&
    !syncPageOpen &&
    !resourcesPageOpen &&
    !drawPageOpen &&
    !translatePageOpen &&
    !tasksPageOpen &&
    !taskBoardPageOpen
  const featureMenuActive =
    drawPageOpen ||
    resourcesPageOpen ||
    skillsPageOpen ||
    soulsPageOpen ||
    syncPageOpen ||
    (settingsPageOpen && settingsTab === 'plugin')
  const sessionsByProject = useMemo(() => {
    const next = new Map<string, SessionListItem[]>()
    for (const session of sessions) {
      if (!session.projectId) continue
      const bucket = next.get(session.projectId)
      if (bucket) {
        bucket.push(session)
      } else {
        next.set(session.projectId, [session])
      }
    }
    for (const bucket of next.values()) {
      bucket.sort(sortSessions)
    }
    return next
  }, [sessions])
  const chatSessions = useMemo(
    () =>
      sessions
        .filter((session) => !session.projectId)
        .slice()
        .sort(sortSessions),
    [sessions]
  )
  const chatSessionPageState = sessionListPageState.__chats__

  const projectGroups = useMemo<ProjectTreeGroup[]>(() => {
    return visibleProjects.map((project) => {
      const projectSessions = sessionsByProject.get(project.id) ?? []
      const isRunning = projectSessions.some((session) => {
        return (
          runningSessions[session.id] === 'running' ||
          runningSessions[session.id] === 'retrying' ||
          runningSubAgentSessionIds.has(session.id) ||
          runningBackgroundSessionIds.has(session.id) ||
          streamingSessionIds.has(session.id) ||
          activeTeamSessionId === session.id
        )
      })
      return {
        project,
        sessions: projectSessions,
        isRunning,
        hasMore: projectGroupHasMoreSessions(
          sessionListPageState[project.id],
          projectSessions.length,
          project.sessionCount
        ),
        isLoadingMore: sessionListPageState[project.id]?.loading ?? false
      }
    })
  }, [
    activeTeamSessionId,
    runningBackgroundSessionIds,
    runningSessions,
    runningSubAgentSessionIds,
    sessionsByProject,
    sessionListPageState,
    streamingSessionIds,
    visibleProjects
  ])

  const currentSidebarWidth = clampLeftSidebarWidth(
    leftSidebarWidth || persistedLeftSidebarWidth || LEFT_SIDEBAR_DEFAULT_WIDTH
  )

  const openCommandPalette = useCallback(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'k',
        ctrlKey: true,
        bubbles: true
      })
    )
  }, [])

  const openChatHome = useCallback(() => {
    const uiStore = useUIStore.getState()
    setActiveProjectHome(null)
    uiStore.setMode('chat')
    uiStore.navigateToHome()
  }, [setActiveProjectHome])

  const openProjectHome = useCallback(
    (projectId: string) => {
      const uiStore = useUIStore.getState()
      setActiveProjectHome(projectId)
      if (uiStore.mode === 'chat') {
        uiStore.setMode('cowork')
      }
      uiStore.navigateToProject(projectId)
    },
    [setActiveProjectHome]
  )

  const openProjectNewSession = useCallback(
    (projectId: string) => {
      const uiStore = useUIStore.getState()
      setActiveProjectHome(projectId)
      if (uiStore.mode === 'chat') {
        uiStore.setMode('cowork')
      }
      uiStore.navigateToHome()
    },
    [setActiveProjectHome]
  )

  const handleCreateChatSession = useCallback(() => {
    openChatHome()
  }, [openChatHome])

  const navigateProjectView = useCallback(
    (projectId: string, view: 'project' | 'archive' | 'channels' | 'git' = 'project') => {
      setActiveProject(projectId)
      const ui = useUIStore.getState()
      if (view === 'archive') {
        ui.navigateToArchive(projectId)
        return
      }
      if (view === 'channels') {
        ui.navigateToChannels(projectId)
        return
      }
      if (view === 'git') {
        ui.navigateToGit(projectId)
        return
      }
      ui.navigateToProject(projectId)
    },
    [setActiveProject]
  )

  const openProjectSession = useCallback(
    (projectId: string) => {
      const latestSession = (sessionsByProject.get(projectId) ?? [])[0]
      if (!latestSession) {
        openProjectHome(projectId)
        return
      }
      void openSessionOrFocusDetached(latestSession.id)
    },
    [openProjectHome, sessionsByProject]
  )

  const openSession = useCallback((sessionId: string) => {
    void openSessionOrFocusDetached(sessionId)
  }, [])

  const handleImportSessionFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (!file) return
      try {
        const text = await file.text()
        const payload = JSON.parse(text) as unknown
        if (!isRecord(payload) || payload.type !== 'session' || !('session' in payload)) {
          throw new Error('invalid-session-file')
        }
        importSession(payload.session as Session, activeProjectId)
        toast.success(t('sidebar.importSuccess'))
      } catch {
        toast.error(t('sidebar.importFailed'))
      }
    },
    [activeProjectId, importSession, t]
  )

  const handleImportProjectFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (!file) return
      try {
        const text = await file.text()
        const payload = JSON.parse(text) as unknown
        if (
          !isRecord(payload) ||
          payload.type !== 'project' ||
          !('project' in payload) ||
          !('sessions' in payload) ||
          !Array.isArray(payload.sessions)
        ) {
          throw new Error('invalid-project-file')
        }
        importProjectArchive({
          project: payload.project as Project,
          sessions: payload.sessions as Session[]
        })
        toast.success(t('sidebar.importSuccess'))
      } catch {
        toast.error(t('sidebar.importFailed'))
      }
    },
    [importProjectArchive, t]
  )

  const handleCreateProjectWithDirectory = useCallback(
    async (workingFolder: string, sshConnectionId: string | null) => {
      const projectId = await createProject({
        name: deriveProjectNameFromFolder(workingFolder),
        workingFolder,
        sshConnectionId: sshConnectionId ?? undefined
      })
      openProjectHome(projectId)
      toast.success(t('sidebar_toast.projectCreated'))
    },
    [createProject, openProjectHome, t]
  )

  const handleRevealProject = useCallback(
    async (workingFolder?: string | null) => {
      if (!workingFolder) return
      const result = (await ipcClient.invoke(IPC.SHELL_SHOW_ITEM_IN_FOLDER, workingFolder)) as
        | { error?: string }
        | undefined
      if (result && typeof result === 'object' && typeof result.error === 'string') {
        toast.error(t('sidebar_toast.revealFailed'), { description: result.error })
      }
    },
    [t]
  )

  const handleDropFolders = useCallback(
    async (dataTransfer: DataTransfer | null) => {
      const localPaths = getDroppedLocalPaths(dataTransfer)
      if (localPaths.length === 0) return
      const folders = await filterDirectories(localPaths)
      if (folders.length === 0) {
        toast.error(t('sidebar_toast.dropNotFolder'))
        return
      }
      if (folders.length === 1) {
        await handleCreateProjectWithDirectory(folders[0], null)
        return
      }
      for (const folder of folders) {
        await createProject({
          name: deriveProjectNameFromFolder(folder),
          workingFolder: folder
        })
      }
      toast.success(t('sidebar_toast.projectsCreatedCount', { count: folders.length }))
    },
    [createProject, handleCreateProjectWithDirectory, t]
  )

  const handleCreateSession = useCallback(
    (projectId: string) => {
      openProjectNewSession(projectId)
    },
    [openProjectNewSession]
  )

  const handleProjectSortModeChange = useCallback((value: string) => {
    if (!isProjectSortMode(value)) return
    setProjectSortMode(value)
    writeProjectSortMode(value)
  }, [])

  const handleClearChatSessions = useCallback(async () => {
    const loadedChatSessions = useChatStore
      .getState()
      .sessions.filter((session) => !session.projectId)
    const total = loadedChatSessions.length
    if (total === 0) {
      toast.info(t('sidebar.noConversations'))
      return
    }
    const ok = await confirm({
      title: t('sidebar.deleteAllSessions'),
      variant: 'destructive'
    })
    if (!ok) return
    const runningIds = loadedChatSessions
      .filter(
        (session) =>
          runningSessions[session.id] === 'running' ||
          runningSessions[session.id] === 'retrying' ||
          runningSubAgentSessionIds.has(session.id) ||
          runningBackgroundSessionIds.has(session.id) ||
          streamingSessionIds.has(session.id) ||
          activeTeamSessionId === session.id
      )
      .map((session) => session.id)
    for (const sessionId of runningIds) {
      abortSession(sessionId)
    }
    const result = await invokeMessagePackBinary<{
      sessionIds: string[]
      deletedSessions: number
    }>(DB_SESSIONS_CLEAR_PROJECT_MSGPACK_CHANNEL, {
      projectId: null,
      excludeSessionIds: []
    })
    for (const sessionId of result.sessionIds) {
      clearPendingSessionMessages(sessionId)
      useChatStore.getState().removeSessionFromSync(sessionId, null)
    }
    toast.success(t('sidebar_toast.allDeleted'))
  }, [
    activeTeamSessionId,
    runningBackgroundSessionIds,
    runningSessions,
    runningSubAgentSessionIds,
    streamingSessionIds,
    t
  ])

  const confirmClearSessionMessages = useCallback(() => {
    if (!clearSessionTarget) return
    clearSessionMessages(clearSessionTarget.id)
    clearPendingSessionMessages(clearSessionTarget.id)
    toast.success(t('sidebar_toast.messagesCleared'))
    setClearSessionTarget(null)
  }, [clearSessionMessages, clearSessionTarget, t])

  const isSessionRunning = useCallback(
    (sessionId: string): boolean =>
      runningSessions[sessionId] === 'running' ||
      runningSessions[sessionId] === 'retrying' ||
      runningSubAgentSessionIds.has(sessionId) ||
      runningBackgroundSessionIds.has(sessionId) ||
      streamingSessionIds.has(sessionId) ||
      activeTeamSessionId === sessionId,
    [
      activeTeamSessionId,
      runningBackgroundSessionIds,
      runningSessions,
      runningSubAgentSessionIds,
      streamingSessionIds
    ]
  )

  const confirmClearProjectSessions = useCallback(async () => {
    if (!clearProjectSessionsTarget) return
    const state = useChatStore.getState()
    const runningIds = state.sessions
      .filter((session) => session.projectId === clearProjectSessionsTarget.id)
      .filter((session) => isSessionRunning(session.id))
      .map((session) => session.id)
    const result = await invokeMessagePackBinary<{
      sessionIds: string[]
      deletedSessions: number
    }>(DB_SESSIONS_CLEAR_PROJECT_MSGPACK_CHANNEL, {
      projectId: clearProjectSessionsTarget.id,
      excludeSessionIds: runningIds
    })
    for (const sessionId of result.sessionIds) {
      clearPendingSessionMessages(sessionId)
      useChatStore.getState().removeSessionFromSync(sessionId)
    }
    setClearProjectSessionsTarget(null)
    if (result.deletedSessions === 0) {
      toast.info(t('sidebar_toast.noProjectSessionsCleared'))
      return
    }
    toast.success(t('sidebar_toast.projectSessionsCleared', { count: result.deletedSessions }))
    void useChatStore.getState().loadFromDb()
  }, [clearProjectSessionsTarget, isSessionRunning, t])

  const handleSmartRenameSession = useCallback(
    async (sessionId: string) => {
      if (autoRenamingSessionId) return
      setAutoRenamingSessionId(sessionId)

      try {
        // The title prompt only needs a bounded tail. The content-aware window
        // keeps large tool results as previews, so renaming never hydrates an
        // entire conversation just to read its first few words.
        await useChatStore.getState().ensureSessionWindow(sessionId)
        const session = useChatStore.getState().sessions.find((item) => item.id === sessionId)
        if (!session) return

        const titleInput = buildSmartRenameInput(session)
        if (!titleInput) {
          toast.error(t('sidebar_toast.smartRenameNoContent'))
          return
        }

        const result = await generateSessionTitle(titleInput, {
          maxInputChars: 6000,
          workspace: {
            projectId: session.projectId,
            workingFolder: session.workingFolder,
            sshConnectionId: session.sshConnectionId,
            target: session.sshConnectionId ? 'ssh' : 'local'
          }
        })
        const nextTitle = result?.title.trim()
        const nextIcon = result?.icon.trim()
        if (!nextTitle) {
          toast.error(t('sidebar_toast.smartRenameFailed'))
          return
        }

        updateSessionTitle(sessionId, nextTitle)
        if (nextIcon) {
          updateSessionIcon(sessionId, nextIcon)
        }
        toast.success(t('sidebar_toast.smartRenameSuccess'))
      } catch (error) {
        toast.error(t('sidebar_toast.smartRenameFailed'), {
          description: error instanceof Error ? error.message : String(error)
        })
      } finally {
        setAutoRenamingSessionId((current) => (current === sessionId ? null : current))
      }
    },
    [autoRenamingSessionId, t, updateSessionIcon, updateSessionTitle]
  )

  const deferDropdownAction = useCallback((action: () => void) => {
    window.setTimeout(action, 0)
  }, [])

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return
    if (deleteTarget.type === 'project') {
      await deleteProject(deleteTarget.id)
      if (useChatStore.getState().activeProjectId === deleteTarget.id) {
        useUIStore.getState().navigateToHome()
      }
      toast.success(t('sidebar_toast.projectDeleted'))
    } else {
      const hasRunning =
        runningSessions[deleteTarget.id] === 'running' ||
        runningSessions[deleteTarget.id] === 'retrying' ||
        runningSubAgentSessionIds.has(deleteTarget.id) ||
        runningBackgroundSessionIds.has(deleteTarget.id) ||
        streamingSessionIds.has(deleteTarget.id) ||
        activeTeamSessionId === deleteTarget.id
      if (hasRunning) {
        abortSession(deleteTarget.id)
      }
      clearPendingSessionMessages(deleteTarget.id)
      deleteSession(deleteTarget.id)
      toast.success(t('sidebar_toast.sessionDeleted'))
    }
    setDeleteTarget(null)
  }, [
    activeTeamSessionId,
    deleteProject,
    deleteSession,
    deleteTarget,
    runningBackgroundSessionIds,
    runningSessions,
    runningSubAgentSessionIds,
    streamingSessionIds,
    t
  ])

  useEffect(() => {
    if (collapseStateInitializedRef.current || projectGroups.length === 0) return
    collapseStateInitializedRef.current = true
    if (!hasStoredCollapsedProjectIds()) {
      setCollapsedProjectIds(new Set(projectGroups.map((group) => group.project.id)))
      return
    }

    // Remove IDs for projects that no longer exist without overwriting the
    // user's persisted expanded/collapsed choices for the remaining projects.
    const projectIds = new Set(projectGroups.map((group) => group.project.id))
    setCollapsedProjectIds((current) => {
      const next = new Set([...current].filter((projectId) => projectIds.has(projectId)))
      return next.size === current.size ? current : next
    })
  }, [projectGroups])

  // A persisted expanded project must hydrate its first cursor page on mount;
  // otherwise the tree would show an empty project until the user toggles it.
  // A failed load must NOT be retried here: the error write re-triggers this
  // effect (it depends on sessionListPageState), so retrying on error spins
  // load -> error -> effect -> load at full speed and pegs the renderer at
  // 100% CPU on every launch (issue #155). Errored pages are only retried
  // through explicit user expansion (handleResourceExpandedChange).
  useEffect(() => {
    if (!collapseStateInitializedRef.current) return
    for (const group of projectGroups) {
      if (collapsedProjectIds.has(group.project.id)) continue
      const page = sessionListPageState[group.project.id]
      if (!page || (!page.loaded && !page.loading && !page.error)) {
        void loadProjectSessions(group.project.id)
      }
    }
  }, [collapsedProjectIds, loadProjectSessions, projectGroups, sessionListPageState])

  const toggleProjectExpansion = useCallback((projectId: string) => {
    setExpandedProjectIds((current) => {
      const next = new Set(current)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      writeExpandedProjectIds(next)
      return next
    })
  }, [])

  const handleTreeScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const element = event.currentTarget
      if (element.scrollHeight - element.scrollTop - element.clientHeight > 120) return
      void loadMoreChatSessions()
    },
    [loadMoreChatSessions]
  )

  const navItems = [
    {
      key: 'new-chat',
      label: t('sidebar.newChat'),
      icon: SquarePen,
      active: false,
      onClick: handleCreateChatSession
    },
    {
      key: 'search',
      label: t('sidebar.searchLabel'),
      icon: Search,
      active: false,
      onClick: openCommandPalette
    },
    {
      key: 'automation',
      label: t('sidebar.automationLabel'),
      icon: Clock3,
      active: tasksPageOpen,
      onClick: () => useUIStore.getState().openTasksPage()
    },
    {
      key: 'taskboard',
      label: t('sidebar.taskBoardLabel', { defaultValue: 'Task Board' }),
      icon: SquareKanban,
      active: taskBoardPageOpen,
      onClick: () => useUIStore.getState().openTaskBoardPage()
    }
  ]

  const renderNavItem = (item: (typeof navItems)[number]): React.JSX.Element => {
    const Icon = item.icon
    return (
      <li key={item.key}>
        <button
          type="button"
          onClick={item.onClick}
          className={cn(SIDEBAR_NAV_BUTTON_CLASS, item.active && 'text-foreground')}
        >
          <Icon className="relative z-10 size-4 shrink-0" />
          <span className="relative z-10 truncate">{item.label}</span>
        </button>
      </li>
    )
  }

  const clearFeatureMenuCloseTimer = useCallback(() => {
    if (!featureMenuCloseTimerRef.current) return
    clearTimeout(featureMenuCloseTimerRef.current)
    featureMenuCloseTimerRef.current = null
  }, [])

  const openFeatureMenu = useCallback(() => {
    clearFeatureMenuCloseTimer()
    setFeatureMenuOpen(true)
  }, [clearFeatureMenuCloseTimer])

  const closeFeatureMenu = useCallback(() => {
    clearFeatureMenuCloseTimer()
    setFeatureMenuOpen(false)
  }, [clearFeatureMenuCloseTimer])

  const scheduleFeatureMenuClose = useCallback(() => {
    clearFeatureMenuCloseTimer()
    featureMenuCloseTimerRef.current = setTimeout(() => {
      setFeatureMenuOpen(false)
      featureMenuCloseTimerRef.current = null
    }, 200)
  }, [clearFeatureMenuCloseTimer])

  useEffect(() => clearFeatureMenuCloseTimer, [clearFeatureMenuCloseTimer])

  const renderSessionMenu = (
    session: SessionListItem,
    controls: SidebarResourceMenuControls
  ): React.ReactNode => {
    void pendingQueueSignature
    const pendingCount = getPendingSessionMessageCountForSession(session.id)
    const canClearSession = session.messageCount > 0 || pendingCount > 0

    return (
      <>
        <SidebarResourceMenuItem
          icon={<MessageSquare className="size-3.5" />}
          onSelect={() => {
            controls.close()
            openSession(session.id)
          }}
        >
          {t('topbar.openSession')}
        </SidebarResourceMenuItem>
        <SidebarResourceMenuItem
          icon={<ExternalLink className="size-3.5" />}
          onSelect={() => {
            controls.close()
            void openDetachedSessionWindow(session.id)
          }}
        >
          {t('sidebar.openInNewWindow')}
        </SidebarResourceMenuItem>
        <SidebarResourceMenuItem
          icon={<Pencil className="size-3.5" />}
          onSelect={() => controls.rename()}
        >
          {tCommon('action.rename')}
        </SidebarResourceMenuItem>
        <SidebarResourceMenuItem
          icon={
            autoRenamingSessionId === session.id ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Wand2 className="size-3.5" />
            )
          }
          disabled={!!autoRenamingSessionId || session.messageCount === 0}
          onSelect={() => {
            controls.close()
            void handleSmartRenameSession(session.id)
          }}
        >
          {autoRenamingSessionId === session.id
            ? t('sidebar.smartRenaming')
            : t('sidebar.smartRename')}
        </SidebarResourceMenuItem>
        <SidebarResourceMenuItem
          icon={session.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
          onSelect={() => {
            controls.close()
            togglePinSession(session.id)
            toast.success(
              session.pinned ? t('sidebar_toast.unpinned') : t('sidebar_toast.pinnedMsg')
            )
          }}
        >
          {session.pinned ? tCommon('action.unpin') : t('sidebar.pinToTop')}
        </SidebarResourceMenuItem>
        <SidebarResourceMenuItem
          icon={<Copy className="size-3.5" />}
          onSelect={() => {
            controls.close()
            void duplicateSession(session.id).then(() => {
              toast.success(t('sidebar_toast.sessionDuplicated'))
            })
          }}
        >
          {tCommon('action.duplicate')}
        </SidebarResourceMenuItem>
        {session.messageCount > 0 ? (
          <SidebarResourceMenuItem
            icon={<FileText className="size-3.5" />}
            onSelect={() => {
              controls.close()
              void (async () => {
                const snapshot = useChatStore
                  .getState()
                  .sessions.find((item) => item.id === session.id)
                if (!snapshot) return
                downloadMarkdown(
                  `${sanitizeExportFileName(snapshot.title)}.md`,
                  await exportSessionMarkdownFromDb(snapshot)
                )
                toast.success(t('sidebar_toast.exportedOne'))
              })()
            }}
          >
            {t('sidebar.exportAsMarkdown')}
          </SidebarResourceMenuItem>
        ) : null}
        <SidebarResourceMenuItem
          icon={<Download className="size-3.5" />}
          onSelect={() => {
            controls.close()
            void (async () => {
              const snapshot = useChatStore
                .getState()
                .sessions.find((item) => item.id === session.id)
              if (!snapshot) return
              downloadJson(`${sanitizeExportFileName(snapshot.title)}.json`, {
                version: 1,
                type: 'session',
                session: await exportSessionSnapshotFromDb(snapshot)
              } satisfies ExportedSessionPayload)
              toast.success(t('sidebar.exportedAsJson'))
            })()
          }}
        >
          {t('sidebar.exportAsJson')}
        </SidebarResourceMenuItem>
        <SidebarResourceMenuItem
          icon={<Eraser className="size-3.5" />}
          disabled={!canClearSession}
          onSelect={() => {
            controls.close()
            deferDropdownAction(() =>
              setClearSessionTarget({
                id: session.id,
                title: session.title,
                pendingCount
              })
            )
          }}
        >
          {t('sidebar.clearMessages')}
        </SidebarResourceMenuItem>
        <SidebarResourceMenuSeparator />
        <SidebarResourceMenuItem
          icon={<Trash2 className="size-3.5" />}
          destructive
          onSelect={() => {
            controls.close()
            deferDropdownAction(() =>
              setDeleteTarget({
                type: 'session',
                id: session.id,
                title: session.title
              })
            )
          }}
        >
          {tCommon('action.delete')}
        </SidebarResourceMenuItem>
      </>
    )
  }

  const handleExportProject = useCallback(
    async (project: ProjectListItem) => {
      const projectSessions = useChatStore
        .getState()
        .sessions.filter((session) => session.projectId === project.id)
      const snapshotSessions = await Promise.all(projectSessions.map(exportSessionSnapshotFromDb))
      downloadJson(`${sanitizeExportFileName(project.name)}.json`, {
        version: 1,
        type: 'project',
        project,
        sessions: snapshotSessions
      } satisfies ExportedProjectPayload)
      toast.success(t('sidebar.exportedAsJson'))
    },
    [t]
  )

  const projectSortLabel = t(PROJECT_SORT_LABEL_KEYS[projectSortMode])
  const ProjectSortIcon =
    projectSortMode === 'name'
      ? ArrowDownAZ
      : projectSortMode === 'createdAt'
        ? CalendarDays
        : ListFilter

  const renderProjectMenu = (
    group: ProjectTreeGroup,
    controls: SidebarResourceMenuControls
  ): React.ReactNode => {
    const project = group.project
    const runningProjectSessionCount = group.sessions.filter((session) =>
      isSessionRunning(session.id)
    ).length
    const clearableProjectSessionCount = Math.max(
      0,
      (project.sessionCount ?? 0) - runningProjectSessionCount
    )
    const OpenProjectMenuIcon = project.sshConnectionId ? Server : SquareKanban

    return (
      <>
        <SidebarResourceMenuItem
          icon={<OpenProjectMenuIcon className="size-3.5" />}
          onSelect={() => {
            controls.close()
            openProjectSession(project.id)
          }}
        >
          {t('sidebar.openProject')}
        </SidebarResourceMenuItem>
        <SidebarResourceMenuItem
          icon={<Pencil className="size-3.5" />}
          onSelect={() => controls.rename()}
        >
          {tCommon('action.rename')}
        </SidebarResourceMenuItem>
        <SidebarResourceMenuItem
          icon={<ImageIcon className="size-3.5" />}
          onSelect={() => {
            controls.close()
            deferDropdownAction(() =>
              setIconPickerTarget({
                id: project.id,
                name: project.name
              })
            )
          }}
        >
          {t('sidebar.changeProjectIcon', { defaultValue: 'Change icon' })}
        </SidebarResourceMenuItem>
        <SidebarResourceMenuItem
          icon={<FolderInput className="size-3.5" />}
          onSelect={() => {
            controls.close()
            deferDropdownAction(() =>
              setFolderPickerTarget({ type: 'project', projectId: project.id })
            )
          }}
        >
          {t('sidebar.changeWorkingFolder')}
        </SidebarResourceMenuItem>
        {project.workingFolder && !project.sshConnectionId ? (
          <SidebarResourceMenuItem
            icon={<ExternalLink className="size-3.5" />}
            onSelect={() => {
              controls.close()
              void handleRevealProject(project.workingFolder)
            }}
          >
            {t('sidebar.revealInFolder')}
          </SidebarResourceMenuItem>
        ) : null}
        <SidebarResourceMenuSeparator />
        <SidebarResourceMenuItem
          icon={<BookOpen className="size-3.5" />}
          onSelect={() => {
            controls.close()
            navigateProjectView(project.id, 'archive')
          }}
        >
          {t('sidebar.projectArchive')}
        </SidebarResourceMenuItem>
        <SidebarResourceMenuItem
          icon={<MessageSquare className="size-3.5" />}
          onSelect={() => {
            controls.close()
            navigateProjectView(project.id, 'channels')
          }}
        >
          {t('sidebar.projectChannels')}
        </SidebarResourceMenuItem>
        <SidebarResourceMenuItem
          icon={<GitBranch className="size-3.5" />}
          onSelect={() => {
            controls.close()
            navigateProjectView(project.id, 'git')
          }}
        >
          {t('sidebar.projectGit')}
        </SidebarResourceMenuItem>
        <SidebarResourceMenuSeparator />
        <SidebarResourceMenuItem
          icon={<Download className="size-3.5" />}
          onSelect={() => {
            controls.close()
            void handleExportProject(project)
          }}
        >
          {t('sidebar.exportProjectAsJson')}
        </SidebarResourceMenuItem>
        <SidebarResourceMenuItem
          icon={<Eraser className="size-3.5" />}
          destructive
          disabled={clearableProjectSessionCount === 0}
          onSelect={() => {
            controls.close()
            deferDropdownAction(() =>
              setClearProjectSessionsTarget({
                id: project.id,
                name: project.name,
                clearableCount: clearableProjectSessionCount,
                runningCount: runningProjectSessionCount
              })
            )
          }}
        >
          {t('sidebar.clearProjectSessions')}
        </SidebarResourceMenuItem>
        <SidebarResourceMenuItem
          icon={project.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
          onSelect={() => {
            controls.close()
            togglePinProject(project.id)
            toast.success(
              project.pinned ? t('sidebar_toast.projectUnpinned') : t('sidebar_toast.projectPinned')
            )
          }}
        >
          {project.pinned ? tCommon('action.unpin') : t('sidebar.pinToTop')}
        </SidebarResourceMenuItem>
        <SidebarResourceMenuSeparator />
        <SidebarResourceMenuItem
          icon={<Trash2 className="size-3.5" />}
          destructive
          onSelect={() => {
            controls.close()
            deferDropdownAction(() =>
              setDeleteTarget({
                type: 'project',
                id: project.id,
                name: project.name,
                sessionCount: group.sessions.length
              })
            )
          }}
        >
          {tCommon('action.delete')}
        </SidebarResourceMenuItem>
      </>
    )
  }

  const mapSessionResource = (session: SessionListItem): SidebarResource => ({
    id: sessionResourceId(session.id),
    label: session.title,
    kind: 'file'
  })

  const resourceItems = useMemo<SidebarResource[]>(() => {
    const items: SidebarResource[] = projectGroups.map((group) => {
      const expanded = expandedProjectIds.has(group.project.id)
      const displayedSessions = expanded
        ? group.sessions
        : group.sessions.filter(
            (session, index) =>
              index < DEFAULT_VISIBLE_SESSIONS_PER_PROJECT || session.id === activeSessionId
          )
      const canToggleExpansion =
        group.sessions.length > DEFAULT_VISIBLE_SESSIONS_PER_PROJECT || group.hasMore
      const remainingSessions = Math.max(0, group.sessions.length - displayedSessions.length)
      const children: SidebarResource[] = displayedSessions.map(mapSessionResource)
      if (displayedSessions.length > 0 && canToggleExpansion) {
        children.push({
          id: loadMoreProjectId(group.project.id),
          label: group.isLoadingMore
            ? t('sidebar.loadingSessions', { defaultValue: 'Loading…' })
            : expanded && group.hasMore
              ? t('sidebar.loadMoreSessions', { defaultValue: 'Load more sessions' })
              : expanded
                ? t('sidebar.showLessSessions')
                : t('sidebar.showMoreSessions', { count: remainingSessions || 50 }),
          kind: 'bookmark'
        })
      } else if (displayedSessions.length === 0 && group.isLoadingMore) {
        children.push({
          id: loadMoreProjectId(group.project.id),
          label: t('sidebar.loadingSessions', { defaultValue: 'Loading…' }),
          kind: 'bookmark',
          disabled: true
        })
      }
      return {
        id: projectResourceId(group.project.id),
        label: group.project.name,
        kind: 'project',
        children
      }
    })

    const chatChildren: SidebarResource[] = chatSessions.map(mapSessionResource)
    if (chatSessionPageState?.loaded && chatSessionPageState.hasMore) {
      chatChildren.push({
        id: LOAD_MORE_CHATS_ID,
        label: chatSessionPageState.loading
          ? t('sidebar.loadingSessions', { defaultValue: 'Loading…' })
          : t('sidebar.loadMoreSessions', { defaultValue: 'Load more sessions' }),
        kind: 'bookmark'
      })
    }

    items.push({
      id: CHATS_FOLDER_ID,
      label: t('sidebar.chats'),
      kind: 'folder',
      children: chatChildren
    })

    return items
  }, [
    activeSessionId,
    chatSessionPageState?.hasMore,
    chatSessionPageState?.loaded,
    chatSessionPageState?.loading,
    chatSessions,
    expandedProjectIds,
    projectGroups,
    t
  ])

  const expandedResourceIds = useMemo(() => {
    const ids = projectGroups
      .filter((group) => !collapsedProjectIds.has(group.project.id))
      .map((group) => projectResourceId(group.project.id))
    if (!chatsSectionCollapsed) ids.push(CHATS_FOLDER_ID)
    return ids
  }, [chatsSectionCollapsed, collapsedProjectIds, projectGroups])

  const activeResourceId =
    chatSurfaceActive && chatView === 'session' && activeSessionId
      ? sessionResourceId(activeSessionId)
      : null

  const sessionsById = useMemo(() => {
    const next = new Map<string, SessionListItem>()
    for (const session of sessions) next.set(session.id, session)
    return next
  }, [sessions])

  const projectGroupsById = useMemo(() => {
    const next = new Map<string, ProjectTreeGroup>()
    for (const group of projectGroups) next.set(group.project.id, group)
    return next
  }, [projectGroups])

  const handleResourceActiveChange = useCallback(
    (id: string) => {
      const sessionId = parseSessionResourceId(id)
      if (sessionId) {
        openSession(sessionId)
        return
      }
      if (id === LOAD_MORE_CHATS_ID) {
        void loadMoreChatSessions()
        return
      }
      const loadMoreProjectId = parseLoadMoreProjectId(id)
      if (loadMoreProjectId) {
        const group = projectGroupsById.get(loadMoreProjectId)
        if (!group) return
        const expanded = expandedProjectIds.has(loadMoreProjectId)
        if (expanded && group.hasMore) {
          void loadMoreProjectSessions(loadMoreProjectId)
          return
        }
        toggleProjectExpansion(loadMoreProjectId)
        return
      }
      const projectId = parseProjectResourceId(id)
      if (projectId) openProjectSession(projectId)
    },
    [
      expandedProjectIds,
      loadMoreChatSessions,
      loadMoreProjectSessions,
      openProjectSession,
      openSession,
      projectGroupsById,
      toggleProjectExpansion
    ]
  )

  const handleResourceExpandedChange = useCallback(
    (id: string, expanded: boolean) => {
      if (id === CHATS_FOLDER_ID) {
        setChatsSectionCollapsed(!expanded)
        return
      }
      const projectId = parseProjectResourceId(id)
      if (!projectId) return
      if (expanded) void loadProjectSessions(projectId)
      setCollapsedProjectIds((current) => {
        const next = new Set(current)
        if (expanded) next.delete(projectId)
        else next.add(projectId)
        writeCollapsedProjectIds(next)
        return next
      })
    },
    [loadProjectSessions]
  )

  const handleResourceRename = useCallback(
    (item: SidebarResource, label: string) => {
      const projectId = parseProjectResourceId(item.id)
      if (projectId) {
        renameProject(projectId, label)
        toast.success(tCommon('action.rename'))
        return
      }
      const sessionId = parseSessionResourceId(item.id)
      if (sessionId) {
        updateSessionTitle(sessionId, label)
        toast.success(tCommon('action.rename'))
      }
    },
    [renameProject, tCommon, updateSessionTitle]
  )

  const renderResourceMenu = (item: SidebarResource, controls: SidebarResourceMenuControls) => {
    if (item.id.startsWith('action:')) return null
    if (item.id === CHATS_FOLDER_ID) {
      return (
        <>
          <SidebarResourceMenuItem
            icon={<Upload className="size-3.5" />}
            onSelect={() => {
              controls.close()
              importSessionInputRef.current?.click()
            }}
          >
            {t('sidebar.importSession')}
          </SidebarResourceMenuItem>
          <SidebarResourceMenuSeparator />
          <SidebarResourceMenuItem
            icon={<Trash2 className="size-3.5" />}
            destructive
            disabled={chatSessions.length === 0}
            onSelect={() => {
              controls.close()
              deferDropdownAction(() => void handleClearChatSessions())
            }}
          >
            {t('sidebar.deleteAllSessions')}
          </SidebarResourceMenuItem>
        </>
      )
    }
    const projectId = parseProjectResourceId(item.id)
    if (projectId) {
      const group = projectGroupsById.get(projectId)
      return group ? renderProjectMenu(group, controls) : null
    }
    const sessionId = parseSessionResourceId(item.id)
    if (!sessionId) return null
    const session = sessionsById.get(sessionId)
    return session ? renderSessionMenu(session, controls) : null
  }

  const renderResourceIcon = useCallback(
    (item: SidebarResource) => {
      const sessionId = parseSessionResourceId(item.id)
      if (sessionId) {
        const session = sessionsById.get(sessionId)
        const sessionRunStatus = runningSessions[sessionId]
        const isRunning =
          sessionRunStatus === 'running' ||
          sessionRunStatus === 'retrying' ||
          runningSubAgentSessionIds.has(sessionId) ||
          runningBackgroundSessionIds.has(sessionId) ||
          streamingSessionIds.has(sessionId) ||
          activeTeamSessionId === sessionId
        if (isRunning) {
          return (
            <Loader2
              className={cn(
                'size-4 animate-spin',
                sessionRunStatus === 'retrying' ? 'text-amber-500' : 'text-primary'
              )}
            />
          )
        }
        if (session?.pinned) return <Pin className="size-4 text-amber-500" />
        return <FileText className="size-4" />
      }
      const projectId = parseProjectResourceId(item.id)
      if (projectId) {
        const group = projectGroupsById.get(projectId)
        const expanded = !collapsedProjectIds.has(projectId)
        if (group?.isRunning) {
          return <Loader2 className="size-4 animate-spin text-primary" />
        }
        return (
          <ProjectIcon
            icon={group?.project.icon}
            sshConnectionId={group?.project.sshConnectionId}
            expanded={expanded}
          />
        )
      }
      if (item.id === CHATS_FOLDER_ID) return <MessageSquare className="size-4" />
      if (item.id.startsWith('action:')) return <ChevronRight className="size-4" />
      return undefined
    },
    [
      activeTeamSessionId,
      collapsedProjectIds,
      projectGroupsById,
      runningBackgroundSessionIds,
      runningSessions,
      runningSubAgentSessionIds,
      sessionsById,
      streamingSessionIds
    ]
  )

  const renderResourceTrailing = useCallback(
    (item: SidebarResource) => {
      void pendingQueueSignature
      if (item.id === CHATS_FOLDER_ID) {
        return (
          <span className="flex shrink-0 items-center">
            <span className="px-1 text-[10px] text-muted-foreground/80 group-hover/resource:hidden">
              {chatSessions.length}
            </span>
            <button
              type="button"
              className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-foreground/5 hover:text-foreground group-hover/resource:opacity-100"
              title={t('sidebar.newChat')}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                handleCreateChatSession()
              }}
            >
              <Plus className="size-3.5" />
            </button>
          </span>
        )
      }
      const sessionId = parseSessionResourceId(item.id)
      if (!sessionId) {
        const projectId = parseProjectResourceId(item.id)
        if (!projectId) return null
        const group = projectGroupsById.get(projectId)
        if (!group) return null
        return (
          <span className="relative flex size-6 shrink-0 items-center justify-center">
            <span className="text-[10px] text-muted-foreground/80 group-hover/resource:opacity-0">
              {group.project.sessionCount ?? group.sessions.length}
            </span>
            <button
              type="button"
              className="absolute inset-0 grid place-items-center rounded-lg text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-foreground/5 hover:text-foreground pointer-events-none group-hover/resource:pointer-events-auto group-hover/resource:opacity-100"
              title={t('sidebar.newAgentIn', { projectName: group.project.name })}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                handleCreateSession(projectId)
              }}
            >
              <Plus className="size-3.5" />
            </button>
          </span>
        )
      }
      const session = sessionsById.get(sessionId)
      if (!session) return null
      const pendingCount = getPendingSessionMessageCountForSession(session.id)
      const hasWaitingReply = waitingReplySessionIds.has(session.id)
      return (
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {hasWaitingReply ? (
            <span className="whitespace-nowrap rounded-full bg-amber-500/12 px-1.5 py-0.5 text-[9px] font-medium text-amber-600 dark:text-amber-400">
              {t('sidebar.waitingReply', { defaultValue: 'Waiting reply' })}
            </span>
          ) : null}
          {pendingCount > 0 ? (
            <span className="rounded-full bg-primary/12 px-1.5 py-0.5 text-[9px] font-medium text-primary">
              {pendingCount > 99 ? '99+' : pendingCount}
            </span>
          ) : null}
          <span className="text-[10px] text-muted-foreground/80">
            {formatRelativeTime(session.updatedAt, relativeTimeLocale)}
          </span>
        </span>
      )
    },
    [
      chatSessions.length,
      handleCreateChatSession,
      handleCreateSession,
      pendingQueueSignature,
      projectGroupsById,
      relativeTimeLocale,
      sessionsById,
      t,
      waitingReplySessionIds
    ]
  )

  return (
    <>
      <aside
        className="workspace-sidebar-surface relative flex h-full shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground"
        style={{ width: currentSidebarWidth }}
      >
        <div
          className={cn(
            'workspace-sidebar-titlebar titlebar-drag flex h-10 shrink-0 items-center gap-2 px-2',
            isMac ? 'pl-[104px]' : ''
          )}
        >
          <Button
            variant="ghost"
            size="icon"
            className="workspace-titlebar-action titlebar-no-drag size-7 shrink-0 rounded-md text-sidebar-foreground/70 hover:text-sidebar-foreground"
            onClick={toggleLeftSidebar}
            title={t('commandPalette.toggleSidebar')}
          >
            <PanelLeftClose className="size-4" />
          </Button>
          <div className="min-w-0 flex-1 truncate text-sm font-semibold text-sidebar-foreground/90">
            OpenCowork
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-2 py-4">
          <SharedLayoutBg
            as="ul"
            inset={0}
            pillClassName="rounded-lg bg-muted/70"
            pillContainerClassName="inset-y-auto top-0 h-7"
            className="flex w-full min-w-0 shrink-0 list-none flex-col gap-0.5 px-1"
          >
            {navItems.slice(0, 2).map(renderNavItem)}
            <li>
              <DropdownMenu
                open={featureMenuOpen}
                onOpenChange={(open) => {
                  if (open) openFeatureMenu()
                  else closeFeatureMenu()
                }}
              >
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    onMouseEnter={openFeatureMenu}
                    onMouseLeave={scheduleFeatureMenuClose}
                    className={cn(
                      SIDEBAR_NAV_BUTTON_CLASS,
                      (featureMenuActive || featureMenuOpen) && 'text-foreground'
                    )}
                  >
                    <Plug className="relative z-10 size-4 shrink-0" />
                    <span className="relative z-10 truncate">{t('sidebar.extensionsLabel')}</span>
                    <ChevronRight className="relative z-10 ml-auto size-3.5 shrink-0" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="right"
                  align="start"
                  sideOffset={2}
                  className="w-40"
                  onCloseAutoFocus={(e) => e.preventDefault()}
                  onMouseEnter={openFeatureMenu}
                  onMouseLeave={scheduleFeatureMenuClose}
                >
                  <DropdownMenuItem
                    onSelect={() => useUIStore.getState().openDrawPage()}
                    className={cn(drawPageOpen && 'bg-accent text-accent-foreground')}
                  >
                    <Palette className="size-4" />
                    <span>{t('sidebar.drawLabel')}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => useUIStore.getState().openResourcesPage()}
                    className={cn(resourcesPageOpen && 'bg-accent text-accent-foreground')}
                  >
                    <Library className="size-4" />
                    <span>{t('navRail.resources')}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => useUIStore.getState().openSettingsPage('plugin')}
                    className={cn(
                      settingsPageOpen &&
                        settingsTab === 'plugin' &&
                        'bg-accent text-accent-foreground'
                    )}
                  >
                    <Puzzle className="size-4" />
                    <span>{t('sidebar.pluginsLabel')}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => useUIStore.getState().openSkillsPage()}
                    className={cn(skillsPageOpen && 'bg-accent text-accent-foreground')}
                  >
                    <Wand2 className="size-4" />
                    <span>{t('navRail.skills')}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => useUIStore.getState().openSoulsPage()}
                    className={cn(soulsPageOpen && 'bg-accent text-accent-foreground')}
                  >
                    <Sparkles className="size-4" />
                    <span>{t('navRail.souls')}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => useUIStore.getState().openSyncPage()}
                    className={cn(syncPageOpen && 'bg-accent text-accent-foreground')}
                  >
                    <CloudSync className="size-4" />
                    <span>{t('navRail.sync')}</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => {
                      void ipcClient.invoke(IPC.SSH_WINDOW_OPEN)
                    }}
                  >
                    <Server className="size-4" />
                    <span>{t('navRail.ssh')}</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
            {navItems.slice(2).map(renderNavItem)}
          </SharedLayoutBg>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="mb-1 flex h-8 shrink-0 items-center justify-between gap-2 px-2">
              <span className="text-xs font-medium text-muted-foreground">
                {t('sidebar.projects')}
              </span>
              <div className="flex items-center gap-0.5">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 rounded-lg"
                      title={t('sidebar.projectSortTitle', { sort: projectSortLabel })}
                      aria-label={t('sidebar.projectSortTitle', { sort: projectSortLabel })}
                    >
                      <ProjectSortIcon className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuLabel className="px-2 py-1 text-[11px] text-muted-foreground">
                      {t('sidebar.projectSortBy')}
                    </DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={projectSortMode}
                      onValueChange={handleProjectSortModeChange}
                    >
                      {PROJECT_SORT_MODES.map((mode) => {
                        const SortOptionIcon =
                          mode === 'name'
                            ? ArrowDownAZ
                            : mode === 'createdAt'
                              ? CalendarDays
                              : ListFilter
                        return (
                          <DropdownMenuRadioItem key={mode} value={mode}>
                            <SortOptionIcon className="size-4" />
                            <span>{t(PROJECT_SORT_LABEL_KEYS[mode])}</span>
                          </DropdownMenuRadioItem>
                        )
                      })}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 rounded-lg"
                  onClick={() => importProjectInputRef.current?.click()}
                  title={t('sidebar.importProject')}
                >
                  <Upload className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 rounded-lg"
                  onClick={() =>
                    setFolderPickerTarget({
                      type: 'create',
                      projectName: t('sidebar.newProject'),
                      preferredSection: 'local'
                    })
                  }
                  title={t('sidebar.newProject')}
                >
                  <Plus className="size-3.5" />
                </Button>
              </div>
            </div>
            <div
              ref={treeScrollRef}
              className={cn(
                'relative min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8 [overflow-anchor:none] [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
                isFolderDragOver && 'rounded-lg ring-2 ring-primary/50 ring-inset'
              )}
              onDragOver={(event) => {
                if (!Array.from(event.dataTransfer.types).includes('Files')) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'copy'
                if (!isFolderDragOver) setIsFolderDragOver(true)
              }}
              onDragLeave={(event) => {
                const next = event.relatedTarget as Node | null
                if (next && event.currentTarget.contains(next)) return
                setIsFolderDragOver(false)
              }}
              onDrop={(event) => {
                if (!Array.from(event.dataTransfer.types).includes('Files')) return
                event.preventDefault()
                setIsFolderDragOver(false)
                void handleDropFolders(event.dataTransfer)
              }}
              onScroll={handleTreeScroll}
            >
              {projectGroups.length === 0 && chatSessions.length === 0 ? (
                <div className="px-3 py-5 text-center text-xs text-muted-foreground">
                  {t('sidebar.noProjects')}
                </div>
              ) : (
                <AISidebar
                  items={resourceItems}
                  activeId={activeResourceId}
                  expandedIds={expandedResourceIds}
                  enableMove={false}
                  ariaLabel={t('sidebar.projects')}
                  menuContentClassName="w-56 max-h-[min(24rem,calc(100vh-24px))] overflow-y-auto p-1.5"
                  onActiveChange={handleResourceActiveChange}
                  onExpandedChange={handleResourceExpandedChange}
                  onRename={handleResourceRename}
                  renderIcon={renderResourceIcon}
                  renderTrailing={renderResourceTrailing}
                  renderMenu={renderResourceMenu}
                />
              )}
              <div
                aria-hidden="true"
                className="pointer-events-none sticky bottom-0 z-20 h-8 bg-gradient-to-t from-sidebar via-sidebar/80 to-transparent"
              />
            </div>
            <div className="px-1 pb-1 pt-2">
              <AccountMenu />
            </div>
          </div>
        </div>

        <input
          ref={importSessionInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={handleImportSessionFile}
        />
        <input
          ref={importProjectInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={handleImportProjectFile}
        />
        <div
          className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize transition-colors hover:bg-primary/20"
          onMouseDown={(event) => {
            event.preventDefault()
            const startX = event.clientX
            const startWidth = currentSidebarWidth
            const handleMouseMove = (mouseEvent: MouseEvent): void => {
              setLeftSidebarWidth(startWidth + (mouseEvent.clientX - startX))
            }
            const handleMouseUp = (): void => {
              const nextWidth = clampLeftSidebarWidth(useUIStore.getState().leftSidebarWidth)
              setLeftSidebarWidth(nextWidth)
              updateSettings({ leftSidebarWidth: nextWidth })
              window.removeEventListener('mousemove', handleMouseMove)
              window.removeEventListener('mouseup', handleMouseUp)
            }
            window.addEventListener('mousemove', handleMouseMove)
            window.addEventListener('mouseup', handleMouseUp)
          }}
        />
      </aside>

      <WorkingFolderSelectorDialog
        open={!!folderPickerTarget}
        onOpenChange={(open) => {
          if (!open) setFolderPickerTarget(null)
        }}
        workingFolder={folderPickerProject?.workingFolder}
        sshConnectionId={folderPickerProject?.sshConnectionId}
        projectName={
          folderPickerTarget?.type === 'create' ? folderPickerTarget.projectName : undefined
        }
        createMode={folderPickerTarget?.type === 'create'}
        preferredSection={
          folderPickerTarget?.type === 'create' ? folderPickerTarget.preferredSection : undefined
        }
        onSelectLocalFolder={async (folderPath) => {
          if (folderPickerTarget?.type === 'create') {
            await handleCreateProjectWithDirectory(folderPath, null)
            return
          }
          if (!folderPickerProjectId) return
          updateProjectDirectory(folderPickerProjectId, {
            workingFolder: folderPath,
            sshConnectionId: null
          })
          toast.success(t('sidebar_toast.projectWorkingFolderUpdated'))
        }}
        onSelectSshFolder={async (folderPath, connectionId) => {
          if (folderPickerTarget?.type === 'create') {
            await handleCreateProjectWithDirectory(folderPath, connectionId)
            return
          }
          if (!folderPickerProjectId) return
          updateProjectDirectory(folderPickerProjectId, {
            workingFolder: folderPath,
            sshConnectionId: connectionId
          })
          toast.success(t('sidebar_toast.projectWorkingFolderUpdated'))
        }}
      />

      <ProjectIconPickerDialog
        open={!!iconPickerTarget}
        projectName={iconPickerTarget?.name ?? ''}
        currentIcon={iconPickerProject?.icon}
        sshConnectionId={iconPickerProject?.sshConnectionId}
        onOpenChange={(open) => {
          if (!open) setIconPickerTarget(null)
        }}
        onSelect={(icon) => {
          if (!iconPickerTarget) return
          updateProjectIcon(iconPickerTarget.id, icon)
        }}
      />

      <AlertDialog
        open={!!clearSessionTarget}
        onOpenChange={(open) => !open && setClearSessionTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('sidebar.clearMessagesConfirmTitle', {
                title: clearSessionTarget?.title ?? ''
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('sidebar.clearMessagesConfirmDescription')}
              {(clearSessionTarget?.pendingCount ?? 0) > 0
                ? ` ${t('sidebar.clearQueuedMessagesNotice', {
                    count: clearSessionTarget?.pendingCount ?? 0
                  })}`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon('action.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmClearSessionMessages}>
              {t('sidebar.clearMessagesConfirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!clearProjectSessionsTarget}
        onOpenChange={(open) => !open && setClearProjectSessionsTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('sidebar.clearProjectSessionsConfirmTitle', {
                projectName: clearProjectSessionsTarget?.name ?? ''
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('sidebar.clearProjectSessionsConfirmDescription', {
                count: clearProjectSessionsTarget?.clearableCount ?? 0
              })}
              {(clearProjectSessionsTarget?.runningCount ?? 0) > 0
                ? ` ${t('sidebar.clearProjectSessionsRunningNotice', {
                    count: clearProjectSessionsTarget?.runningCount ?? 0
                  })}`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon('action.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmClearProjectSessions}>
              {t('sidebar.clearProjectSessionsConfirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tCommon('action.delete')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.type === 'project'
                ? t('sidebar.deleteProjectConfirm', {
                    projectName: deleteTarget.name,
                    count: deleteTarget.sessionCount
                  })
                : t('sidebar.deleteConfirm', { title: deleteTarget?.title ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon('action.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmDelete()}>
              {tCommon('action.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
