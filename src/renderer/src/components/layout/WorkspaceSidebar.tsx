import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import packageJson from '../../../../../package.json'
import { useTranslation } from 'react-i18next'
import readmeZh from '../../../../../README.zh.md?raw'
import {
  BookOpen,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Copy,
  Download,
  Eraser,
  FileText,
  FolderInput,
  FolderOpen,
  FolderPlus,
  GitBranch,
  History,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Trash2,
  Upload,
  Wand2,
  ExternalLink
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@renderer/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
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
import { sessionToMarkdown } from '@renderer/lib/utils/export-chat'
import {
  openDetachedSessionWindow,
  openSessionOrFocusDetached
} from '@renderer/lib/session-window'
import { cn } from '@renderer/lib/utils'
import { clampLeftSidebarWidth, LEFT_SIDEBAR_DEFAULT_WIDTH } from './right-panel-defs'
import { WorkingFolderSelectorDialog } from '@renderer/components/chat/WorkingFolderSelectorDialog'
import { toast } from 'sonner'
import { confirm } from '@renderer/components/ui/confirm-dialog'

const DEFAULT_VISIBLE_SESSIONS_PER_PROJECT = 4
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS
const SIDEBAR_TREE_ROW_CLASS = 'min-h-8 rounded-lg border border-transparent'
const SIDEBAR_TREE_ACTIVE_CLASS =
  'border-border/70 bg-accent text-accent-foreground shadow-[0_1px_2px_rgba(15,23,42,0.06)]'
const SIDEBAR_TREE_HOVER_CLASS =
  'text-foreground/85 hover:border-border/70 hover:bg-accent hover:text-accent-foreground'
const SIDEBAR_TREE_SUBITEM_HOVER_CLASS =
  'text-foreground/80 hover:border-border/60 hover:bg-accent/80 hover:text-accent-foreground'
const SIDEBAR_TREE_ACTION_BUTTON_CLASS = 'size-6 rounded-md text-muted-foreground'
const SIDEBAR_TREE_LABEL_CLASS = 'text-[13px] leading-5'
const SIDEBAR_TREE_META_CLASS = 'text-[10px]'

type FolderPickerTarget =
  | { type: 'create'; projectName: string; preferredSection?: 'local' | 'ssh' }
  | { type: 'project'; projectId: string }
type SessionListItem = ReturnType<typeof mapSession>
type ProjectListItem = ReturnType<typeof mapProject>

interface ProjectTreeGroup {
  project: ProjectListItem
  sessions: SessionListItem[]
  isRunning: boolean
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
  createdAt: number
  updatedAt: number
  workingFolder?: string
  sshConnectionId?: string
  pluginId?: string
  pinned?: boolean
} {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    workingFolder: project.workingFolder,
    sshConnectionId: project.sshConnectionId,
    pluginId: project.pluginId,
    pinned: project.pinned
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

function sortProjects(left: ProjectListItem, right: ProjectListItem): number {
  if (!!left.pinned !== !!right.pinned) return left.pinned ? -1 : 1
  return right.updatedAt - left.updatedAt
}

function sortSessions(left: SessionListItem, right: SessionListItem): number {
  if (!!left.pinned !== !!right.pinned) return left.pinned ? -1 : 1
  return right.updatedAt - left.updatedAt
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
  const chatView = useUIStore((state) => state.chatView)
  const settingsPageOpen = useUIStore((state) => state.settingsPageOpen)
  const skillsPageOpen = useUIStore((state) => state.skillsPageOpen)
  const resourcesPageOpen = useUIStore((state) => state.resourcesPageOpen)
  const drawPageOpen = useUIStore((state) => state.drawPageOpen)
  const translatePageOpen = useUIStore((state) => state.translatePageOpen)
  const tasksPageOpen = useUIStore((state) => state.tasksPageOpen)
  const leftSidebarWidth = useUIStore((state) => state.leftSidebarWidth)
  const setLeftSidebarWidth = useUIStore((state) => state.setLeftSidebarWidth)
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
  const renameProject = useChatStore((state) => state.renameProject)
  const deleteProject = useChatStore((state) => state.deleteProject)
  const togglePinProject = useChatStore((state) => state.togglePinProject)
  const updateProjectDirectory = useChatStore((state) => state.updateProjectDirectory)
  const deleteSession = useChatStore((state) => state.deleteSession)
  const updateSessionTitle = useChatStore((state) => state.updateSessionTitle)
  const duplicateSession = useChatStore((state) => state.duplicateSession)
  const clearSessionMessages = useChatStore((state) => state.clearSessionMessages)
  const clearAllSessions = useChatStore((state) => state.clearAllSessions)
  const togglePinSession = useChatStore((state) => state.togglePinSession)
  const importSession = useChatStore((state) => state.importSession)
  const importProjectArchive = useChatStore((state) => state.importProjectArchive)
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
  const unreadCountsBySession = useBackgroundSessionStore((state) => state.unreadCountsBySession)
  const blockedCountsBySession = useBackgroundSessionStore((state) => state.blockedCountsBySession)
  const language = useSettingsStore((state) => state.language)
  const importSessionInputRef = useRef<HTMLInputElement>(null)
  const importProjectInputRef = useRef<HTMLInputElement>(null)
  const treeScrollRef = useRef<HTMLDivElement>(null)
  const [renameDialog, setRenameDialog] = useState<
    | { type: 'project'; id: string; currentName: string }
    | { type: 'session'; id: string; currentName: string }
    | null
  >(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<
    | { type: 'project'; id: string; name: string; sessionCount: number }
    | { type: 'session'; id: string; title: string }
    | null
  >(null)
  const [folderPickerTarget, setFolderPickerTarget] = useState<FolderPickerTarget | null>(null)
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set())
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set())
  const runningSubAgentSessionIds = useMemo(
    () => new Set(runningSubAgentSessionIdsSig ? runningSubAgentSessionIdsSig.split('\u0000') : []),
    [runningSubAgentSessionIdsSig]
  )
  const runningBackgroundSessionIds = useMemo(
    () =>
      new Set(runningBackgroundSessionIdsSig ? runningBackgroundSessionIdsSig.split('\u0000') : []),
    [runningBackgroundSessionIdsSig]
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
  const activeSessionProjectId = useMemo(
    () => sessions.find((session) => session.id === activeSessionId)?.projectId ?? null,
    [activeSessionId, sessions]
  )
  const currentProjectId = activeSessionProjectId ?? activeProjectId ?? null
  const visibleProjects = useMemo(
    () =>
      projects
        .filter((project) => !project.pluginId)
        .slice()
        .sort(sortProjects),
    [projects]
  )
  const folderPickerProjectId =
    folderPickerTarget?.type === 'project' ? folderPickerTarget.projectId : null
  const folderPickerProject = folderPickerProjectId
    ? visibleProjects.find((project) => project.id === folderPickerProjectId)
    : undefined
  const chatSurfaceActive =
    !settingsPageOpen &&
    !skillsPageOpen &&
    !resourcesPageOpen &&
    !drawPageOpen &&
    !translatePageOpen &&
    !tasksPageOpen
  const featureMenuActive = resourcesPageOpen || skillsPageOpen
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

  const projectGroups = useMemo<ProjectTreeGroup[]>(() => {
    return visibleProjects.map((project) => {
      const projectSessions = sessionsByProject.get(project.id) ?? []
      const isRunning = projectSessions.some((session) => {
        return (
          runningSessions[session.id] === 'running' ||
          runningSubAgentSessionIds.has(session.id) ||
          runningBackgroundSessionIds.has(session.id) ||
          streamingSessionIds.has(session.id) ||
          activeTeamSessionId === session.id
        )
      })
      return {
        project,
        sessions: projectSessions,
        isRunning
      }
    })
  }, [
    activeTeamSessionId,
    runningBackgroundSessionIds,
    runningSessions,
    runningSubAgentSessionIds,
    sessionsByProject,
    streamingSessionIds,
    visibleProjects
  ])

  useEffect(() => {
    const projectId = activeSessionProjectId ?? activeProjectId
    if (!projectId) return
    setCollapsedProjectIds((current) => {
      if (!current.has(projectId)) return current
      const next = new Set(current)
      next.delete(projectId)
      return next
    })
  }, [activeProjectId, activeSessionProjectId])

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
    const chatStore = useChatStore.getState()
    const uiStore = useUIStore.getState()
    chatStore.setActiveSession(null)
    uiStore.setMode('chat')
    uiStore.navigateToHome()
  }, [])

  const openProjectHome = useCallback((projectId: string) => {
    const chatStore = useChatStore.getState()
    chatStore.setActiveProject(projectId)
    chatStore.setActiveSession(null)
    useUIStore.getState().navigateToProject(projectId)
  }, [])

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

  const handleCreateProject = useCallback(() => {
    setFolderPickerTarget({
      type: 'create',
      projectName: 'New Project',
      preferredSection: 'local'
    })
  }, [])

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

  const handleCreateSession = useCallback(
    (projectId: string) => {
      openProjectHome(projectId)
    },
    [openProjectHome]
  )

  const handleOpenDocs = useCallback(() => {
    useUIStore.getState().openMarkdownPreview(t('sidebar.docsTitle'), readmeZh)
  }, [t])

  const handleOpenChangelog = useCallback(() => {
    useUIStore.getState().setChangelogDialogOpen(true)
  }, [])

  const handleClearAllSessions = useCallback(async () => {
    const total = useChatStore.getState().sessions.length
    if (total === 0) {
      toast.info(t('sidebar.noConversations'))
      return
    }
    const ok = await confirm({
      title: t('sidebar.deleteAllConfirm', { count: total }),
      variant: 'destructive'
    })
    if (!ok) return
    clearAllSessions()
    useUIStore.getState().navigateToHome()
    toast.success(t('sidebar_toast.allDeleted'))
  }, [clearAllSessions, t])

  const confirmRename = useCallback(() => {
    if (!renameDialog) return
    const nextName = renameValue.trim()
    if (!nextName) return
    if (renameDialog.type === 'project') {
      renameProject(renameDialog.id, nextName)
    } else {
      updateSessionTitle(renameDialog.id, nextName)
    }
    setRenameDialog(null)
    toast.success(tCommon('action.rename'))
  }, [renameDialog, renameProject, renameValue, tCommon, updateSessionTitle])

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

  const startRename = useCallback((dialog: NonNullable<typeof renameDialog>) => {
    setRenameDialog(dialog)
    setRenameValue(dialog.currentName)
  }, [])

  const toggleProjectCollapsed = useCallback((projectId: string) => {
    setCollapsedProjectIds((current) => {
      const next = new Set(current)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
  }, [])

  const toggleProjectExpansion = useCallback((projectId: string) => {
    setExpandedProjectIds((current) => {
      const next = new Set(current)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
  }, [])

  const navItems = [
    {
      key: 'new-chat',
      label: t('sidebar.newChat', { defaultValue: '新建聊天' }),
      icon: <Pencil className="size-4 shrink-0" />,
      active: false,
      onClick: handleCreateChatSession
    },
    {
      key: 'search',
      label: t('sidebar.searchLabel', { defaultValue: '搜索' }),
      icon: <Search className="size-4 shrink-0" />,
      active: false,
      onClick: openCommandPalette
    },
    {
      key: 'plugins',
      label: t('sidebar.pluginsLabel', { defaultValue: '插件' }),
      icon: <Wand2 className="size-4 shrink-0" />,
      active: settingsPageOpen && useUIStore.getState().settingsTab === 'plugin',
      onClick: () => useUIStore.getState().openSettingsPage('plugin')
    },
    {
      key: 'automation',
      label: t('sidebar.automationLabel', { defaultValue: '自动化' }),
      icon: <CalendarDays className="size-4 shrink-0" />,
      active: tasksPageOpen,
      onClick: () => useUIStore.getState().openTasksPage()
    }
  ]

  const renderNavItem = (item: (typeof navItems)[number]): React.JSX.Element => (
    <button
      key={item.key}
      type="button"
      onClick={item.onClick}
      className={cn(
        'flex h-8 w-full items-center gap-2 px-2 text-[13px] font-medium transition-colors',
        SIDEBAR_TREE_ROW_CLASS,
        item.active ? SIDEBAR_TREE_ACTIVE_CLASS : SIDEBAR_TREE_HOVER_CLASS
      )}
    >
      {item.icon}
      <span className="truncate">{item.label}</span>
    </button>
  )

  const renderSessionItem = (
    session: SessionListItem,
    locale: string,
    active: boolean
  ): React.JSX.Element => {
    void pendingQueueSignature
    const isRunning =
      runningSessions[session.id] === 'running' ||
      runningSubAgentSessionIds.has(session.id) ||
      runningBackgroundSessionIds.has(session.id) ||
      streamingSessionIds.has(session.id) ||
      activeTeamSessionId === session.id
    const unreadCount = unreadCountsBySession[session.id] ?? 0
    const blockedCount = blockedCountsBySession[session.id] ?? 0
    const pendingCount = getPendingSessionMessageCountForSession(session.id)

    return (
      <ContextMenu key={session.id}>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'group/session flex w-full items-center gap-1.5 px-1.5 py-1 text-left transition-colors',
              SIDEBAR_TREE_ROW_CLASS,
              active ? SIDEBAR_TREE_ACTIVE_CLASS : SIDEBAR_TREE_HOVER_CLASS
            )}
            onClick={() => openSession(session.id)}
          >
            <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
              {isRunning ? (
                <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
              ) : session.pinned ? (
                <Pin className="size-3.5 text-amber-500" />
              ) : (
                <span aria-hidden="true" className="size-3.5 shrink-0" />
              )}
            </span>
            <span className={cn('min-w-0 flex-1 truncate font-medium', SIDEBAR_TREE_LABEL_CLASS)}>
              {session.title}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {blockedCount > 0 && (
                <span className="rounded-full bg-amber-500/12 px-1.5 py-0.5 text-[9px] font-medium text-amber-600 dark:text-amber-400">
                  {blockedCount > 99 ? '99+' : blockedCount}
                </span>
              )}
              {unreadCount > 0 && (
                <span className="rounded-full bg-sky-500/12 px-1.5 py-0.5 text-[9px] font-medium text-sky-600 dark:text-sky-400">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
              {pendingCount > 0 && (
                <span className="rounded-full bg-primary/12 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                  {pendingCount > 99 ? '99+' : pendingCount}
                </span>
              )}
              <span className={cn('text-muted-foreground/70', SIDEBAR_TREE_META_CLASS)}>
                {formatRelativeTime(session.updatedAt, locale)}
              </span>
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem onClick={() => openSession(session.id)}>
            <MessageSquare className="size-4" />
            {t('topbar.openSession')}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void openDetachedSessionWindow(session.id)}>
            <ExternalLink className="size-4" />
            {t('sidebar.openInNewWindow', { defaultValue: 'Open in new window' })}
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() =>
              deferDropdownAction(() =>
                startRename({
                  type: 'session',
                  id: session.id,
                  currentName: session.title
                })
              )
            }
          >
            <Pencil className="size-4" />
            {tCommon('action.rename')}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              togglePinSession(session.id)
              toast.success(
                session.pinned ? t('sidebar_toast.unpinned') : t('sidebar_toast.pinnedMsg')
              )
            }}
          >
            {session.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
            {session.pinned ? tCommon('action.unpin') : t('sidebar.pinToTop')}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={async () => {
              await duplicateSession(session.id)
              toast.success(t('sidebar_toast.sessionDuplicated'))
            }}
          >
            <Copy className="size-4" />
            {tCommon('action.duplicate')}
          </ContextMenuItem>
          {session.messageCount > 0 && (
            <ContextMenuItem
              onClick={async () => {
                await useChatStore.getState().loadSessionMessages(session.id)
                const snapshot = useChatStore
                  .getState()
                  .sessions.find((item) => item.id === session.id)
                if (!snapshot) return
                downloadMarkdown(
                  `${sanitizeExportFileName(snapshot.title)}.md`,
                  sessionToMarkdown(snapshot)
                )
                toast.success(t('sidebar_toast.exportedOne'))
              }}
            >
              <FileText className="size-4" />
              {t('sidebar.exportAsMarkdown')}
            </ContextMenuItem>
          )}
          <ContextMenuItem
            onClick={async () => {
              await useChatStore.getState().loadSessionMessages(session.id)
              const snapshot = useChatStore
                .getState()
                .sessions.find((item) => item.id === session.id)
              if (!snapshot) return
              downloadJson(`${sanitizeExportFileName(snapshot.title)}.json`, {
                version: 1,
                type: 'session',
                session: snapshot
              } satisfies ExportedSessionPayload)
              toast.success(t('sidebar.exportedAsJson'))
            }}
          >
            <Download className="size-4" />
            {t('sidebar.exportAsJson')}
          </ContextMenuItem>
          {session.messageCount > 0 && (
            <ContextMenuItem
              onClick={() => {
                clearSessionMessages(session.id)
                clearPendingSessionMessages(session.id)
                toast.success(t('sidebar_toast.messagesCleared'))
              }}
            >
              <Eraser className="size-4" />
              {t('sidebar.clearMessages')}
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            onSelect={() =>
              deferDropdownAction(() =>
                setDeleteTarget({
                  type: 'session',
                  id: session.id,
                  title: session.title
                })
              )
            }
          >
            <Trash2 className="size-4" />
            {tCommon('action.delete')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  const relativeTimeLocale = language === 'zh' ? 'zh-CN' : 'en'

  const handleExportProject = useCallback(
    async (project: ProjectListItem) => {
      const projectSessions = useChatStore
        .getState()
        .sessions.filter((session) => session.projectId === project.id)
      for (const session of projectSessions) {
        await useChatStore.getState().loadSessionMessages(session.id)
      }
      const snapshotSessions = useChatStore
        .getState()
        .sessions.filter((session) => session.projectId === project.id)
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

  return (
    <>
      <aside
        className="flex h-full shrink-0 flex-col border-r bg-background"
        style={{ width: currentSidebarWidth }}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="space-y-1 border-b border-border/60 px-2 py-1.5">
            {navItems.slice(0, 3).map(renderNavItem)}

            <div className="group/resources-menu space-y-1">
              <button
                type="button"
                className={cn(
                  'flex h-8 w-full items-center gap-2 px-2 text-[13px] font-medium transition-colors',
                  SIDEBAR_TREE_ROW_CLASS,
                  featureMenuActive ? SIDEBAR_TREE_ACTIVE_CLASS : SIDEBAR_TREE_HOVER_CLASS
                )}
              >
                <FolderOpen className="size-4 shrink-0" />
                <span className="truncate">{t('navRail.resources')}</span>
                <ChevronRight
                  className={cn(
                    'ml-auto size-3.5 shrink-0 transition-transform',
                    featureMenuActive ? 'rotate-90' : 'group-hover/resources-menu:rotate-90'
                  )}
                />
              </button>

              <div
                className={cn(
                  'grid overflow-hidden pl-6 transition-all duration-150',
                  featureMenuActive
                    ? 'grid-rows-[1fr] opacity-100'
                    : 'grid-rows-[0fr] opacity-0 group-hover/resources-menu:grid-rows-[1fr] group-hover/resources-menu:opacity-100'
                )}
              >
                <div className="space-y-1 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => useUIStore.getState().openResourcesPage()}
                    className={cn(
                      'flex h-7 w-full items-center gap-2 px-2 text-[12px] font-medium transition-colors',
                      SIDEBAR_TREE_ROW_CLASS,
                      resourcesPageOpen
                        ? SIDEBAR_TREE_ACTIVE_CLASS
                        : SIDEBAR_TREE_SUBITEM_HOVER_CLASS
                    )}
                  >
                    <FolderOpen className="size-3.5 shrink-0" />
                    <span className="truncate">{t('navRail.resources')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => useUIStore.getState().openSkillsPage()}
                    className={cn(
                      'flex h-7 w-full items-center gap-2 px-2 text-[12px] font-medium transition-colors',
                      SIDEBAR_TREE_ROW_CLASS,
                      skillsPageOpen
                        ? SIDEBAR_TREE_ACTIVE_CLASS
                        : SIDEBAR_TREE_SUBITEM_HOVER_CLASS
                    )}
                  >
                    <Wand2 className="size-3.5 shrink-0" />
                    <span className="truncate">{t('navRail.skills')}</span>
                  </button>
                </div>
              </div>
            </div>

            {navItems.slice(3).map(renderNavItem)}
          </div>

          <div className="mt-1 flex items-center justify-between gap-2 px-2 pb-1 pt-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="text-[9px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/80">
                {t('sidebar.projects')}
              </span>
              <span className="rounded-full border border-border/60 bg-muted/30 px-1 py-0.5 text-[9px] text-muted-foreground">
                {visibleProjects.length}
              </span>
            </div>
            <div className="flex items-center gap-0.5">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-4"
                    title={tCommon('action.more', { defaultValue: 'More' })}
                  >
                    <MoreHorizontal className="size-2.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuItem onClick={() => importSessionInputRef.current?.click()}>
                    <Upload className="size-4" />
                    {t('sidebar.importSession')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => importProjectInputRef.current?.click()}>
                    <FolderInput className="size-4" />
                    {t('sidebar.importProject')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => deferDropdownAction(() => void handleClearAllSessions())}
                    disabled={sessions.length === 0}
                  >
                    <Trash2 className="size-4" />
                    {t('sidebar.deleteAllSessions')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="ghost"
                size="icon"
                className="size-4"
                onClick={() => void handleCreateProject()}
                title={t('sidebar.newProject')}
              >
                <FolderPlus className="size-2.5" />
              </Button>
            </div>
          </div>

          <div ref={treeScrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {projectGroups.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/60 px-3.5 py-5 text-center text-[12px] text-muted-foreground">
                {t('sidebar.noProjects')}
              </div>
            ) : (
              <div className="space-y-1">
                {projectGroups.map((group) => {
                  const project = group.project
                  const isCollapsed = collapsedProjectIds.has(project.id)
                  const isProjectActive =
                    chatSurfaceActive && currentProjectId === project.id && chatView !== 'home'
                  const defaultVisibleSessions = group.sessions.filter(
                    (session, index) =>
                      index < DEFAULT_VISIBLE_SESSIONS_PER_PROJECT || session.id === activeSessionId
                  )
                  const displayedSessions = expandedProjectIds.has(project.id)
                    ? group.sessions
                    : defaultVisibleSessions
                  const remainingSessions = Math.max(
                    0,
                    group.sessions.length - displayedSessions.length
                  )
                  const canToggleExpansion =
                    group.sessions.length > DEFAULT_VISIBLE_SESSIONS_PER_PROJECT
                  const projectToggleTitle = isCollapsed
                    ? t('rightPanel.expand', { defaultValue: 'Expand' })
                    : t('rightPanel.collapse')

                  return (
                    <div key={project.id} className="space-y-1">
                      <ContextMenu>
                        <ContextMenuTrigger asChild>
                          <div
                            className={cn(
                              'group/project flex items-center gap-1.5 px-1.5 py-1 transition-colors',
                              SIDEBAR_TREE_ROW_CLASS,
                              isProjectActive
                                ? SIDEBAR_TREE_ACTIVE_CLASS
                                : SIDEBAR_TREE_HOVER_CLASS
                            )}
                          >
                            <Button
                              variant="ghost"
                              size="icon"
                              className={cn(
                                SIDEBAR_TREE_ACTION_BUTTON_CLASS,
                                'shrink-0 text-muted-foreground hover:text-foreground'
                              )}
                              onClick={() => toggleProjectCollapsed(project.id)}
                              title={projectToggleTitle}
                            >
                              {isCollapsed ? (
                                <ChevronRight className="size-3.5" />
                              ) : (
                                <ChevronDown className="size-3.5" />
                              )}
                            </Button>

                            <button
                              type="button"
                              className="min-w-0 flex-1 rounded-md px-1 py-1 text-left"
                              onClick={() => toggleProjectCollapsed(project.id)}
                              title={projectToggleTitle}
                            >
                              <div className="flex min-w-0 items-center gap-1.5">
                                <FolderOpen
                                  className={cn(
                                    'size-3.5 shrink-0',
                                    isProjectActive
                                      ? 'text-accent-foreground/80'
                                      : 'text-muted-foreground/70'
                                  )}
                                />
                                <span
                                  className={cn(
                                    'truncate font-semibold text-foreground',
                                    SIDEBAR_TREE_LABEL_CLASS
                                  )}
                                >
                                  {project.name}
                                </span>
                              </div>
                            </button>

                            <div className="relative flex h-8 w-[116px] shrink-0 items-center justify-end overflow-hidden">
                              <div
                                className={cn(
                                  'absolute inset-0 flex items-center justify-end gap-1 text-muted-foreground transition-opacity',
                                  SIDEBAR_TREE_META_CLASS,
                                  isProjectActive
                                    ? 'pointer-events-none opacity-0'
                                    : 'opacity-100 group-hover/project:opacity-0'
                                )}
                              >
                                {group.isRunning ? (
                                  <Loader2 className="size-3.5 animate-spin text-primary" />
                                ) : null}
                                {project.pinned ? (
                                  <Pin className="size-3.5 text-amber-500" />
                                ) : null}
                                <span className="text-muted-foreground/70">
                                  {project.sshConnectionId ? 'SSH' : '本地'}
                                </span>
                                <span>{group.sessions.length}</span>
                              </div>

                              <div
                                className={cn(
                                  'absolute inset-0 flex items-center justify-end gap-0.5 transition-opacity',
                                  isProjectActive
                                    ? 'opacity-100'
                                    : 'pointer-events-none opacity-0 group-hover/project:pointer-events-auto group-hover/project:opacity-100'
                                )}
                              >
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className={SIDEBAR_TREE_ACTION_BUTTON_CLASS}
                                  onClick={() => handleCreateSession(project.id)}
                                  title={t('sidebar.newChat')}
                                >
                                  <Plus className="size-3.5" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className={SIDEBAR_TREE_ACTION_BUTTON_CLASS}
                                  onClick={() => openProjectSession(project.id)}
                                  title={t('sidebar.openProject')}
                                >
                                  <FolderOpen className="size-3.5" />
                                </Button>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className={SIDEBAR_TREE_ACTION_BUTTON_CLASS}
                                      title={tCommon('action.more', { defaultValue: 'More' })}
                                    >
                                      <MoreHorizontal className="size-3.5" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="w-52">
                                    <DropdownMenuItem
                                      onClick={() => openProjectSession(project.id)}
                                    >
                                      <FolderOpen className="size-4" />
                                      {t('sidebar.openProject')}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onSelect={() =>
                                        deferDropdownAction(() =>
                                          startRename({
                                            type: 'project',
                                            id: project.id,
                                            currentName: project.name
                                          })
                                        )
                                      }
                                    >
                                      <Pencil className="size-4" />
                                      {tCommon('action.rename')}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onSelect={() =>
                                        deferDropdownAction(() =>
                                          setFolderPickerTarget({
                                            type: 'project',
                                            projectId: project.id
                                          })
                                        )
                                      }
                                    >
                                      <FolderInput className="size-4" />
                                      {t('sidebar.changeWorkingFolder')}
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      onClick={() => navigateProjectView(project.id, 'archive')}
                                    >
                                      <BookOpen className="size-4" />
                                      {t('sidebar.projectArchive')}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={() => navigateProjectView(project.id, 'channels')}
                                    >
                                      <MessageSquare className="size-4" />
                                      {t('sidebar.projectChannels')}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={() => navigateProjectView(project.id, 'git')}
                                    >
                                      <GitBranch className="size-4" />
                                      {t('sidebar.projectGit')}
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      onClick={() => void handleExportProject(project)}
                                    >
                                      <Download className="size-4" />
                                      {t('sidebar.exportProjectAsJson')}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={() => {
                                        togglePinProject(project.id)
                                        toast.success(
                                          project.pinned
                                            ? t('sidebar_toast.projectUnpinned')
                                            : t('sidebar_toast.projectPinned')
                                        )
                                      }}
                                    >
                                      {project.pinned ? (
                                        <PinOff className="size-4" />
                                      ) : (
                                        <Pin className="size-4" />
                                      )}
                                      {project.pinned
                                        ? tCommon('action.unpin')
                                        : t('sidebar.pinToTop')}
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      variant="destructive"
                                      onSelect={() =>
                                        deferDropdownAction(() =>
                                          setDeleteTarget({
                                            type: 'project',
                                            id: project.id,
                                            name: project.name,
                                            sessionCount: group.sessions.length
                                          })
                                        )
                                      }
                                    >
                                      <Trash2 className="size-4" />
                                      {tCommon('action.delete')}
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>
                            </div>
                          </div>
                        </ContextMenuTrigger>
                        <ContextMenuContent className="w-52">
                          <ContextMenuItem onClick={() => openProjectSession(project.id)}>
                            <FolderOpen className="size-4" />
                            {t('sidebar.openProject')}
                          </ContextMenuItem>
                          <ContextMenuItem
                            onSelect={() =>
                              deferDropdownAction(() =>
                                startRename({
                                  type: 'project',
                                  id: project.id,
                                  currentName: project.name
                                })
                              )
                            }
                          >
                            <Pencil className="size-4" />
                            {tCommon('action.rename')}
                          </ContextMenuItem>
                          <ContextMenuItem
                            onSelect={() =>
                              deferDropdownAction(() =>
                                setFolderPickerTarget({
                                  type: 'project',
                                  projectId: project.id
                                })
                              )
                            }
                          >
                            <FolderInput className="size-4" />
                            {t('sidebar.changeWorkingFolder')}
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            onClick={() => navigateProjectView(project.id, 'archive')}
                          >
                            <BookOpen className="size-4" />
                            {t('sidebar.projectArchive')}
                          </ContextMenuItem>
                          <ContextMenuItem
                            onClick={() => navigateProjectView(project.id, 'channels')}
                          >
                            <MessageSquare className="size-4" />
                            {t('sidebar.projectChannels')}
                          </ContextMenuItem>
                          <ContextMenuItem onClick={() => navigateProjectView(project.id, 'git')}>
                            <GitBranch className="size-4" />
                            {t('sidebar.projectGit')}
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem onClick={() => void handleExportProject(project)}>
                            <Download className="size-4" />
                            {t('sidebar.exportProjectAsJson')}
                          </ContextMenuItem>
                          <ContextMenuItem
                            onClick={() => {
                              togglePinProject(project.id)
                              toast.success(
                                project.pinned
                                  ? t('sidebar_toast.projectUnpinned')
                                  : t('sidebar_toast.projectPinned')
                              )
                            }}
                          >
                            {project.pinned ? (
                              <PinOff className="size-4" />
                            ) : (
                              <Pin className="size-4" />
                            )}
                            {project.pinned ? tCommon('action.unpin') : t('sidebar.pinToTop')}
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            variant="destructive"
                            onSelect={() =>
                              deferDropdownAction(() =>
                                setDeleteTarget({
                                  type: 'project',
                                  id: project.id,
                                  name: project.name,
                                  sessionCount: group.sessions.length
                                })
                              )
                            }
                          >
                            <Trash2 className="size-4" />
                            {tCommon('action.delete')}
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>

                      {!isCollapsed ? (
                        <div className="space-y-0.5 pl-7">
                          {displayedSessions.length > 0 ? (
                            <>
                              {displayedSessions.map((session) =>
                                renderSessionItem(
                                  session,
                                  relativeTimeLocale,
                                  chatSurfaceActive &&
                                    chatView === 'session' &&
                                    session.id === activeSessionId
                                )
                              )}
                              {canToggleExpansion ? (
                                <button
                                  type="button"
                                  className={cn(
                                    'flex h-6 items-center gap-1 rounded-md border border-transparent px-1.5 text-[10px] text-muted-foreground transition-colors',
                                    'hover:border-border/60 hover:bg-accent/80 hover:text-accent-foreground'
                                  )}
                                  onClick={() => toggleProjectExpansion(project.id)}
                                >
                                  {expandedProjectIds.has(project.id) ? (
                                    <ChevronDown className="size-3" />
                                  ) : (
                                    <ChevronRight className="size-3" />
                                  )}
                                  <span>
                                    {expandedProjectIds.has(project.id)
                                      ? t('sidebar.showLessSessions')
                                      : t('sidebar.showMoreSessions', {
                                          count: remainingSessions
                                        })}
                                  </span>
                                </button>
                              ) : null}
                            </>
                          ) : (
                            <div className="px-1.5 py-1 text-[10px] text-muted-foreground">
                              {t('sidebar.noProjectSessions')}
                            </div>
                          )}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            )}

            <div className="mt-4 border-t border-border/50 pt-3">
              <div className="flex items-center justify-between gap-2 px-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="text-[9px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/80">
                    {t('sidebar.chats', { defaultValue: '聊天' })}
                  </span>
                  <span className="rounded-full border border-border/60 bg-muted/30 px-1 py-0.5 text-[9px] text-muted-foreground">
                    {chatSessions.length}
                  </span>
                </div>
                <div className="flex items-center gap-0.5">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-4"
                        title={tCommon('action.more', { defaultValue: 'More' })}
                      >
                        <MoreHorizontal className="size-2.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                      <DropdownMenuItem onClick={() => importSessionInputRef.current?.click()}>
                        <Upload className="size-4" />
                        {t('sidebar.importSession')}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => deferDropdownAction(() => void handleClearAllSessions())}
                        disabled={sessions.length === 0}
                      >
                        <Trash2 className="size-4" />
                        {t('sidebar.deleteAllSessions')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-4"
                    onClick={handleCreateChatSession}
                    title={t('sidebar.newChat', { defaultValue: '新建聊天' })}
                  >
                    <Plus className="size-2.5" />
                  </Button>
                </div>
              </div>

              <div className="mt-2 space-y-0.5">
                {chatSessions.length > 0 ? (
                  chatSessions.map((session) =>
                    renderSessionItem(
                      session,
                      relativeTimeLocale,
                      chatSurfaceActive && chatView === 'session' && session.id === activeSessionId
                    )
                  )
                ) : (
                  <div className="px-1.5 py-1 text-[10px] text-muted-foreground">
                    {t('sidebar.noChats', { defaultValue: '暂无聊天' })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
        <div className="mt-auto px-2 pb-2 pt-1.5">
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7 shrink-0 rounded-full">
                  <CircleHelp className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-44">
                <DropdownMenuItem onSelect={() => deferDropdownAction(handleOpenDocs)}>
                  <BookOpen className="size-4" />
                  {t('sidebar.docsTitle')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => deferDropdownAction(handleOpenChangelog)}>
                  <History className="size-4" />
                  {t('sidebar.changelogTitle')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="ghost"
              className={cn(
                'h-8 flex-1 justify-between gap-2 px-2 text-[12px]',
                SIDEBAR_TREE_ROW_CLASS,
                SIDEBAR_TREE_HOVER_CLASS
              )}
              onClick={() => useUIStore.getState().openSettingsPage('general')}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Settings className="size-4 shrink-0" />
                <span className="truncate">{t('sidebar.systemSettings')}</span>
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground/70">
                v{packageJson.version}
              </span>
            </Button>
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

      <Dialog open={!!renameDialog} onOpenChange={(open) => !open && setRenameDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{tCommon('action.rename')}</DialogTitle>
          </DialogHeader>
          <Input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDialog(null)}>
              {tCommon('action.cancel')}
            </Button>
            <Button onClick={confirmRename}>{tCommon('action.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
