import { useCallback, useMemo, useRef, useState } from 'react'
import packageJson from '../../../../../package.json'
import { useTranslation } from 'react-i18next'
import appIconUrl from '../../../../../resources/icon.png'
import readmeZh from '../../../../../README.zh.md?raw'
import {
  BookOpen,
  BarChart3,
  CalendarDays,
  ChevronDown,
  CircleHelp,
  Download,
  FolderInput,
  FolderOpen,
  FolderPlus,
  History,
  Home,
  Image,
  Info,
  Languages,
  Loader2,
  MoreHorizontal,
  PanelLeftClose,
  Pin,
  PinOff,
  Plus,
  Settings,
  Trash2,
  Upload,
  Wand2,
  Monitor,
  Pencil,
  FileText,
  MessageSquare,
  GitBranch,
  Copy,
  Eraser
} from 'lucide-react'
import { DynamicIcon } from 'lucide-react/dynamic'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
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
  DropdownMenuLabel,
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
import { useChatStore, type Project, type Session, type SessionMode } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useTeamStore } from '@renderer/stores/team-store'
import { abortSession, clearPendingSessionMessages } from '@renderer/hooks/use-chat-actions'
import { sessionToMarkdown } from '@renderer/lib/utils/export-chat'
import { cn } from '@renderer/lib/utils'
import { clampLeftSidebarWidth, LEFT_SIDEBAR_DEFAULT_WIDTH } from './right-panel-defs'
import { WorkingFolderSelectorDialog } from '@renderer/components/chat/WorkingFolderSelectorDialog'
import { toast } from 'sonner'

const DAY_MS = 24 * 60 * 60 * 1000

type SessionListItem = ReturnType<typeof mapSession>
type BucketKey = 'today' | 'recentThreeDays' | 'recentWeek' | 'oneMonth' | 'older'
type FolderPickerTarget =
  | { type: 'create'; projectName: string; preferredSection?: 'local' | 'ssh' }
  | { type: 'project'; projectId: string }

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

function deriveProjectIcon(projectId: string, sessions: SessionListItem[]): string | undefined {
  const inProject = sessions.filter((session) => session.projectId === projectId)
  if (inProject.length === 0) return undefined

  const recentIcon = inProject
    .slice()
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .find((session) => session.icon)?.icon
  if (recentIcon) return recentIcon

  return inProject
    .slice()
    .sort((left, right) => left.createdAt - right.createdAt)
    .find((session) => session.icon)?.icon
}

function getBucketKey(updatedAt: number): BucketKey {
  const elapsed = Date.now() - updatedAt
  if (elapsed < DAY_MS) return 'today'
  if (elapsed < DAY_MS * 3) return 'recentThreeDays'
  if (elapsed < DAY_MS * 7) return 'recentWeek'
  if (elapsed < DAY_MS * 30) return 'oneMonth'
  return 'older'
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

type VirtualListItem<T> =
  | { type: 'header'; key: string; label: string }
  | { type: 'item'; key: string; data: T }

function buildVirtualListItems<T>(
  sections: Array<{ key: string; label: string; items: T[] }>
): VirtualListItem<T>[] {
  return sections.flatMap((section) => [
    { type: 'header' as const, key: `header-${section.key}`, label: section.label },
    ...section.items.map((item, index) => ({
      type: 'item' as const,
      key: `${section.key}-${index}`,
      data: item
    }))
  ])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function WorkspaceSidebar(): React.JSX.Element {
  const { t, i18n } = useTranslation('layout')
  const { t: tCommon } = useTranslation('common')
  const { t: tChat } = useTranslation('chat')
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
  const projectDigest = useChatStore((state) =>
    state.projects
      .map((project) =>
        [
          project.id,
          project.name,
          project.updatedAt,
          project.workingFolder ?? '',
          project.sshConnectionId ?? '',
          project.pluginId ?? '',
          project.pinned ? 1 : 0
        ].join('|')
      )
      .join('¦')
  )
  const sessionDigest = useChatStore((state) =>
    state.sessions
      .map((session) =>
        [
          session.id,
          session.title,
          session.icon ?? '',
          session.mode,
          session.updatedAt,
          session.createdAt,
          session.pinned ? 1 : 0,
          session.messageCount,
          session.projectId ?? ''
        ].join('|')
      )
      .join('¦')
  )
  const projects = useMemo(() => {
    void projectDigest
    return useChatStore.getState().projects.map(mapProject)
  }, [projectDigest])
  const sessions = useMemo(() => {
    void sessionDigest
    return useChatStore.getState().sessions.map(mapSession)
  }, [sessionDigest])
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
  const userAvatar = useSettingsStore((state) => state.userAvatar)
  const userName = useSettingsStore((state) => state.userName)
  const language = useSettingsStore((state) => state.language)
  const projectDefaultDirectoryMode = useSettingsStore((state) => state.projectDefaultDirectoryMode)
  const projectDefaultDirectory = useSettingsStore((state) => state.projectDefaultDirectory)
  const lastProjectDirectory = useSettingsStore((state) => state.lastProjectDirectory)
  const searchRef = useRef<HTMLInputElement>(null)
  const importSessionInputRef = useRef<HTMLInputElement>(null)
  const importProjectInputRef = useRef<HTMLInputElement>(null)
  const projectScrollRef = useRef<HTMLDivElement>(null)
  const sessionScrollRef = useRef<HTMLDivElement>(null)
  const [search, setSearch] = useState('')
  const [projectScrollTop, setProjectScrollTop] = useState(0)
  const [sessionScrollTop, setSessionScrollTop] = useState(0)
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
  const [createProjectDialogOpen, setCreateProjectDialogOpen] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const runningSubAgentSessionIds = useMemo(
    () => new Set(runningSubAgentSessionIdsSig ? runningSubAgentSessionIdsSig.split('\u0000') : []),
    [runningSubAgentSessionIdsSig]
  )
  const runningBackgroundSessionIds = useMemo(
    () => new Set(runningBackgroundSessionIdsSig ? runningBackgroundSessionIdsSig.split('\u0000') : []),
    [runningBackgroundSessionIdsSig]
  )
  const streamingSessionIds = useMemo(
    () => new Set(streamingSessionIdsSig ? streamingSessionIdsSig.split('\u0000') : []),
    [streamingSessionIdsSig]
  )
  const runningProjectIds = useMemo(() => {
    const projectIds = new Set<string>()
    for (const session of sessions) {
      if (!session.projectId) continue
      const isRunning =
        runningSessions[session.id] === 'running' ||
        runningSubAgentSessionIds.has(session.id) ||
        runningBackgroundSessionIds.has(session.id) ||
        streamingSessionIds.has(session.id) ||
        activeTeamSessionId === session.id
      if (isRunning) {
        projectIds.add(session.projectId)
      }
    }
    return projectIds
  }, [
    sessions,
    runningSessions,
    runningSubAgentSessionIds,
    runningBackgroundSessionIds,
    streamingSessionIds,
    activeTeamSessionId
  ])
  const visibleProjects = useMemo(
    () =>
      projects
        .filter((project) => !project.pluginId)
        .sort((left, right) => {
          if (!!left.pinned !== !!right.pinned) return left.pinned ? -1 : 1
          return right.updatedAt - left.updatedAt
        }),
    [projects]
  )
  const activeProject =
    visibleProjects.find((project) => project.id === activeProjectId) ?? visibleProjects[0] ?? null
  const folderPickerProjectId =
    folderPickerTarget?.type === 'project' ? folderPickerTarget.projectId : null
  const folderPickerProject = folderPickerProjectId
    ? projects.find((project) => project.id === folderPickerProjectId)
    : undefined
  const chatSurfaceActive =
    !settingsPageOpen &&
    !skillsPageOpen &&
    !resourcesPageOpen &&
    !drawPageOpen &&
    !translatePageOpen &&
    !tasksPageOpen
  const isProjectScoped =
    chatSurfaceActive &&
    (chatView === 'project' ||
      chatView === 'archive' ||
      chatView === 'channels' ||
      chatView === 'git' ||
      chatView === 'session')
  const scopedProjectId = isProjectScoped ? (activeProject?.id ?? null) : null
  const projectIcon = scopedProjectId ? deriveProjectIcon(scopedProjectId, sessions) : undefined
  const projectSessions = useMemo(() => {
    if (!scopedProjectId) return []
    return sessions
      .filter((session) => session.projectId === scopedProjectId)
      .sort((left, right) => {
        const leftBucket = getBucketKey(left.updatedAt)
        const rightBucket = getBucketKey(right.updatedAt)
        if (leftBucket !== rightBucket) {
          const order: BucketKey[] = ['today', 'recentThreeDays', 'recentWeek', 'oneMonth', 'older']
          return order.indexOf(leftBucket) - order.indexOf(rightBucket)
        }
        if (!!left.pinned !== !!right.pinned) return left.pinned ? -1 : 1
        return right.updatedAt - left.updatedAt
      })
  }, [scopedProjectId, sessions])
  const searchQuery = search.trim().toLowerCase()
  const filteredProjects = useMemo(() => {
    if (!searchQuery) return visibleProjects
    return visibleProjects.filter((project) => {
      if (project.name.toLowerCase().includes(searchQuery)) return true
      return sessions.some(
        (session) =>
          session.projectId === project.id && session.title.toLowerCase().includes(searchQuery)
      )
    })
  }, [searchQuery, sessions, visibleProjects])
  const filteredProjectSessions = useMemo(() => {
    if (!searchQuery) return projectSessions
    return projectSessions.filter((session) => session.title.toLowerCase().includes(searchQuery))
  }, [projectSessions, searchQuery])
  const groupedSessions = useMemo(() => {
    const grouped: Record<BucketKey, SessionListItem[]> = {
      today: [],
      recentThreeDays: [],
      recentWeek: [],
      oneMonth: [],
      older: []
    }
    for (const session of filteredProjectSessions) {
      grouped[getBucketKey(session.updatedAt)].push(session)
    }
    return grouped
  }, [filteredProjectSessions])

  const currentSidebarWidth = clampLeftSidebarWidth(
    leftSidebarWidth || persistedLeftSidebarWidth || LEFT_SIDEBAR_DEFAULT_WIDTH
  )

  const effectiveDefaultProjectDirectory =
    projectDefaultDirectoryMode === 'custom' && projectDefaultDirectory.trim()
      ? projectDefaultDirectory.trim()
      : lastProjectDirectory.trim()

  const openHome = useCallback(() => {
    useUIStore.getState().navigateToHome()
  }, [])

  const openProject = useCallback(
    (projectId: string) => {
      setActiveProject(projectId)
      useUIStore.getState().navigateToProject()
    },
    [setActiveProject]
  )

  const openArchive = useCallback(() => {
    useUIStore.getState().navigateToArchive()
  }, [])

  const openChannels = useCallback(() => {
    useUIStore.getState().navigateToChannels()
  }, [])

  const openGit = useCallback(() => {
    useUIStore.getState().navigateToGit()
  }, [])

  const openSession = useCallback((sessionId: string) => {
    useChatStore.getState().setActiveSession(sessionId)
    useUIStore.getState().navigateToSession()
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
    setNewProjectName('')
    setCreateProjectDialogOpen(true)
  }, [])

  const confirmCreateProject = useCallback(async () => {
    const trimmedName = newProjectName.trim()
    const nextProjectName = trimmedName || 'New Project'
    const settingsState = useSettingsStore.getState()
    const preferredBaseDirectory =
      settingsState.projectDefaultDirectoryMode === 'custom'
        ? settingsState.projectDefaultDirectory.trim()
        : settingsState.lastProjectDirectory.trim()

    const projectId = await createProject({
      name: nextProjectName
    })

    if (preferredBaseDirectory) {
      settingsState.updateSettings({
        lastProjectDirectory: preferredBaseDirectory
      })
    }

    setActiveProject(projectId)
    useUIStore.getState().navigateToProject()
    setCreateProjectDialogOpen(false)
    toast.success(t('sidebar_toast.projectCreated'))
  }, [createProject, newProjectName, setActiveProject, t])

  const openCreateProjectFolderPicker = useCallback(
    (preferredSection: 'local' | 'ssh' = 'local') => {
      const trimmedName = newProjectName.trim()
      setFolderPickerTarget({
        type: 'create',
        projectName: trimmedName || 'New Project',
        preferredSection
      })
      setCreateProjectDialogOpen(false)
    },
    [newProjectName]
  )

  const handleCreateProjectWithDirectory = useCallback(
    async (workingFolder: string, sshConnectionId: string | null) => {
      const projectId = await createProject({
        name: deriveProjectNameFromFolder(workingFolder),
        workingFolder,
        sshConnectionId: sshConnectionId ?? undefined
      })
      setActiveProject(projectId)
      useUIStore.getState().navigateToProject()
      toast.success(t('sidebar_toast.projectCreated'))
    },
    [createProject, setActiveProject, t]
  )

  const handleCreateSession = useCallback(() => {
    const projectId = scopedProjectId ?? activeProject?.id ?? null
    if (!projectId) return
    setActiveProject(projectId)
    useUIStore.getState().navigateToProject()
  }, [activeProject?.id, scopedProjectId, setActiveProject])

  const handleOpenDocs = useCallback(() => {
    useUIStore.getState().openMarkdownPreview(t('sidebar.docsTitle'), readmeZh)
  }, [t])

  const handleOpenChangelog = useCallback(() => {
    useUIStore.getState().setChangelogDialogOpen(true)
  }, [])

  const handleToggleLanguage = useCallback(() => {
    const next = language === 'zh' ? 'en' : 'zh'
    updateSettings({ language: next })
    void i18n.changeLanguage(next)
  }, [i18n, language, updateSettings])

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
      if (useChatStore.getState().activeSessionId === deleteTarget.id) {
        useUIStore.getState().navigateToProject()
      }
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

  const bucketDefs: Array<{ key: BucketKey; label: string }> = useMemo(
    () => [
      { key: 'today', label: t('sidebar.today') },
      {
        key: 'recentThreeDays',
        label: t('sidebar.recentThreeDays')
      },
      {
        key: 'recentWeek',
        label: t('sidebar.recentWeek')
      },
      {
        key: 'oneMonth',
        label: t('sidebar.oneMonth')
      },
      { key: 'older', label: t('sidebar.older') }
    ],
    [t]
  )
  const projectSections = useMemo(
    () => [{ key: 'projects', label: t('sidebar.projects'), items: filteredProjects }],
    [filteredProjects, t]
  )
  const virtualProjectItems = useMemo(() => buildVirtualListItems(projectSections), [projectSections])
  const sessionSections = useMemo(
    () =>
      bucketDefs
        .map((bucket) => ({ key: bucket.key, label: bucket.label, items: groupedSessions[bucket.key] }))
        .filter((section) => section.items.length > 0),
    [bucketDefs, groupedSessions]
  )
  const virtualSessionItems = useMemo(() => buildVirtualListItems(sessionSections), [sessionSections])

  const PROJECT_ROW_HEIGHT = 42
  const SESSION_ROW_HEIGHT = 38
  const HEADER_ROW_HEIGHT = 26
  const OVERSCAN = 8

  const projectVisibleRange = useMemo(() => {
    const viewportHeight = projectScrollRef.current?.clientHeight ?? 400
    const start = Math.max(0, Math.floor(projectScrollTop / PROJECT_ROW_HEIGHT) - OVERSCAN)
    const end = Math.min(
      virtualProjectItems.length,
      Math.ceil((projectScrollTop + viewportHeight) / PROJECT_ROW_HEIGHT) + OVERSCAN
    )
    return { start, end }
  }, [projectScrollTop, virtualProjectItems.length])

  const sessionOffsets = useMemo(() => {
    const offsets: number[] = []
    let total = 0
    for (const item of virtualSessionItems) {
      offsets.push(total)
      total += item.type === 'header' ? HEADER_ROW_HEIGHT : SESSION_ROW_HEIGHT
    }
    return { offsets, total }
  }, [virtualSessionItems])

  const sessionVisibleRange = useMemo(() => {
    const viewportHeight = sessionScrollRef.current?.clientHeight ?? 400
    let start = 0
    while (
      start < virtualSessionItems.length &&
      sessionOffsets.offsets[start] + (virtualSessionItems[start]?.type === 'header' ? HEADER_ROW_HEIGHT : SESSION_ROW_HEIGHT) <
        sessionScrollTop
    ) {
      start += 1
    }
    start = Math.max(0, start - OVERSCAN)
    let end = start
    while (end < virtualSessionItems.length && sessionOffsets.offsets[end] < sessionScrollTop + viewportHeight) {
      end += 1
    }
    end = Math.min(virtualSessionItems.length, end + OVERSCAN)
    return { start, end }
  }, [sessionOffsets.offsets, sessionScrollTop, virtualSessionItems])

  const navItems = [
    {
      key: 'home',
      label: t('sidebar.homeLabel'),
      icon: <Home className="size-4" />,
      active: chatView === 'home',
      onClick: openHome
    },
    {
      key: 'tasks',
      label: t('sidebar.tasksLabel'),
      icon: <CalendarDays className="size-4" />,
      active: useUIStore.getState().tasksPageOpen,
      onClick: () => useUIStore.getState().openTasksPage()
    },
    {
      key: 'resources',
      label: t('sidebar.resourcesLabel'),
      icon: <FolderOpen className="size-4" />,
      active: useUIStore.getState().resourcesPageOpen,
      onClick: () => useUIStore.getState().openResourcesPage()
    },
    {
      key: 'skills',
      label: t('sidebar.skillsLabel'),
      icon: <Wand2 className="size-4" />,
      active: useUIStore.getState().skillsPageOpen,
      onClick: () => useUIStore.getState().openSkillsPage()
    },
    {
      key: 'draw',
      label: t('sidebar.drawLabel'),
      icon: <Image className="size-4" />,
      active: useUIStore.getState().drawPageOpen,
      onClick: () => useUIStore.getState().openDrawPage()
    },
    {
      key: 'ssh',
      label: t('sidebar.sshLabel'),
      icon: <Monitor className="size-4" />,
      active: false,
      onClick: () => void ipcClient.invoke(IPC.SSH_WINDOW_OPEN)
    }
  ]

  const renderProjectIcon = (icon?: string, className?: string): React.JSX.Element => {
    if (icon) {
      return <DynamicIcon name={icon as never} className={cn('size-4', className)} />
    }
    return <FolderOpen className={cn('size-4', className)} />
  }

  return (
    <>
      <aside
        className="flex h-full shrink-0 flex-col border-r bg-background"
        style={{ width: currentSidebarWidth }}
      >
        {isProjectScoped && activeProject ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-start justify-between gap-2 px-2.5 pb-2.5 pt-2.5">
              <button
                type="button"
                className="flex min-w-0 items-center gap-3 text-left"
                onClick={() => openProject(activeProject.id)}
              >
                <div className="flex size-8 shrink-0 items-center justify-center rounded-xl border bg-muted/40 text-foreground">
                  {renderProjectIcon(projectIcon, 'size-5')}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold text-foreground">
                    {activeProject.name}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {t('sidebar.projectLabel')}
                  </div>
                </div>
              </button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                onClick={() => useUIStore.getState().setLeftSidebarOpen(false)}
                title={t('rightPanel.collapse')}
              >
                <PanelLeftClose className="size-4" />
              </Button>
            </div>

            <div className="space-y-1.5 px-2.5 pb-2.5">
              <div className="flex items-center gap-1.5">
                <Button
                  className="h-8 flex-1 justify-start gap-2 text-[12px]"
                  onClick={handleCreateSession}
                >
                  <Plus className="size-4" />
                  {t('sidebar.newChat')}
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8 shrink-0"
                  onClick={() => importSessionInputRef.current?.click()}
                  title={t('sidebar.importSession')}
                >
                  <Upload className="size-4" />
                </Button>
              </div>
              <Button
                variant={chatView === 'archive' ? 'secondary' : 'ghost'}
                className="h-8 w-full justify-start gap-2 text-[12px]"
                onClick={openArchive}
              >
                <BookOpen className="size-4" />
                {t('sidebar.projectArchive')}
              </Button>
              <Button
                variant={chatView === 'channels' ? 'secondary' : 'ghost'}
                className="h-8 w-full justify-start gap-2 text-[12px]"
                onClick={openChannels}
              >
                <MessageSquare className="size-4" />
                {t('sidebar.projectChannels')}
              </Button>
              <Button
                variant={chatView === 'git' ? 'secondary' : 'ghost'}
                className="h-8 w-full justify-start gap-2 text-[12px]"
                onClick={openGit}
              >
                <GitBranch className="size-4" />
                {t('sidebar.projectGit')}
              </Button>
              <Button
                variant="ghost"
                className="h-8.5 w-full justify-start gap-2 text-[13px]"
                onClick={openHome}
              >
                <Home className="size-4" />
                {t('sidebar.backHome')}
              </Button>
            </div>

            <div className="px-2.5 pb-2.5">
              <div className="relative">
                <Input
                  ref={searchRef}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t('sidebar.searchSessions')}
                  className="h-7.5 rounded-xl border-border/60 bg-muted/20 pr-8 text-[12px]"
                />
              </div>
            </div>

            <div
              ref={sessionScrollRef}
              className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
              onScroll={(event) => setSessionScrollTop(event.currentTarget.scrollTop)}
            >
              {filteredProjectSessions.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border/60 px-4 py-6 text-center text-sm text-muted-foreground">
                  {searchQuery
                    ? t('sidebar.noMatches')
                    : t('sidebar.noProjectSessions')}
                </div>
              ) : (
                <div style={{ height: sessionOffsets.total, position: 'relative' }}>
                  {virtualSessionItems.slice(sessionVisibleRange.start, sessionVisibleRange.end).map((entry, index) => {
                    const actualIndex = sessionVisibleRange.start + index
                    const top = sessionOffsets.offsets[actualIndex] ?? 0
                    if (entry.type === 'header') {
                      return (
                        <div
                          key={entry.key}
                          className="px-1 text-[11px] font-medium text-muted-foreground"
                          style={{ position: 'absolute', top, left: 0, right: 0, height: HEADER_ROW_HEIGHT }}
                        >
                          {entry.label}
                        </div>
                      )
                    }
                    const session = entry.data
                    const isActive = session.id === activeSessionId && chatView === 'session'
                    const isRunning =
                      runningSessions[session.id] === 'running' ||
                      runningSubAgentSessionIds.has(session.id) ||
                      runningBackgroundSessionIds.has(session.id) ||
                      streamingSessionIds.has(session.id) ||
                      activeTeamSessionId === session.id
                    return (
                      <div
                        key={session.id}
                        style={{ position: 'absolute', top, left: 0, right: 0, height: SESSION_ROW_HEIGHT }}
                      >
                        <ContextMenu>
                          <ContextMenuTrigger asChild>
                            <div
                              className={cn(
                                'group flex h-[34px] items-center gap-2 rounded-lg px-2 py-1.5 transition-colors',
                                isActive
                                  ? 'bg-accent text-accent-foreground'
                                  : 'hover:bg-muted/50 text-foreground/85'
                              )}
                            >
                              <button
                                type="button"
                                className="flex min-w-0 flex-1 items-center text-left"
                                onClick={() => openSession(session.id)}
                              >
                                <span className="line-clamp-1 min-w-0 flex-1 text-[13px] font-medium leading-5">
                                  {session.title}
                                </span>
                              </button>
                              {isRunning && (
                                <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
                              )}
                            </div>
                          </ContextMenuTrigger>
                          <ContextMenuContent className="w-52">
                            <ContextMenuItem onClick={() => openSession(session.id)}>
                              <MessageSquare className="size-4" />
                              {t('topbar.openSession')}
                            </ContextMenuItem>
                            <ContextMenuItem
                              onSelect={() =>
                                deferDropdownAction(() =>
                                  startRename({ type: 'session', id: session.id, currentName: session.title })
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
                                  session.pinned
                                    ? t('sidebar_toast.unpinned')
                                    : t('sidebar_toast.pinnedMsg')
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
                                  const fileName = `${sanitizeExportFileName(snapshot.title)}.md`
                                  downloadMarkdown(fileName, sessionToMarkdown(snapshot))
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
                                  setDeleteTarget({ type: 'session', id: session.id, title: session.title })
                                )
                              }
                            >
                              <Trash2 className="size-4" />
                              {tCommon('action.delete')}
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-start justify-between gap-2 px-2.5 pb-2.5 pt-2.5">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="flex min-w-0 items-center gap-3 rounded-2xl px-1 py-1 text-left transition-colors hover:bg-muted/40">
                    <img
                      src={userAvatar || appIconUrl}
                      alt="avatar"
                      className="size-9 shrink-0 rounded-xl border bg-muted object-cover"
                    />
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-semibold text-foreground">
                        {userName || t('titleBar.defaultName', { defaultValue: 'OpenCoWork' })}
                      </div>
                      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        {t('sidebar.profileMenu')}
                        <ChevronDown className="size-3" />
                      </div>
                    </div>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-52">
                  <DropdownMenuLabel>
                    {userName || t('titleBar.defaultName', { defaultValue: 'OpenCoWork' })}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => useUIStore.getState().openSettingsPage('general')}
                  >
                    <Settings className="size-4" />
                    {t('sidebar.systemSettings')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => useUIStore.getState().openSettingsPage('memory')}
                  >
                    <BookOpen className="size-4" />
                    {t('sidebar.memoryLabel')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => useUIStore.getState().openSettingsPage('analytics')}
                  >
                    <BarChart3 className="size-4" />
                    {t('sidebar.analyticsLabel')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleToggleLanguage}>
                    <Languages className="size-4" />
                    {language === 'zh'
                      ? t('sidebar.switchToEnglish')
                      : t('sidebar.switchToChinese')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => useUIStore.getState().openSettingsPage('about')}>
                    <Info className="size-4" />
                    {t('sidebar.aboutLabel')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                onClick={() => useUIStore.getState().setLeftSidebarOpen(false)}
                title={t('rightPanel.collapse')}
              >
                <PanelLeftClose className="size-4" />
              </Button>
            </div>

            <div className="space-y-0.5 px-2 pb-2">
              {navItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={item.onClick}
                  className={cn(
                    'flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[12px] transition-colors',
                    item.active
                      ? 'bg-accent text-accent-foreground'
                      : 'text-foreground/80 hover:bg-muted/40'
                  )}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
            </div>

            <div className="flex items-center justify-between px-2 pb-1 pt-1">
              <div className="text-[10px] font-medium text-muted-foreground">
                {t('sidebar.projects')}
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  onClick={() => importProjectInputRef.current?.click()}
                  title={t('sidebar.importProject')}
                >
                  <Upload className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  onClick={() => void handleCreateProject()}
                  title={t('sidebar.newProject')}
                >
                  <FolderPlus className="size-3.5" />
                </Button>
              </div>
            </div>

            <div className="px-2 pb-2">
              <Input
                ref={searchRef}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('sidebar.searchProjects')}
                className="h-7 rounded-lg border-border/60 bg-muted/20 text-[12px]"
              />
            </div>

            <div
              ref={projectScrollRef}
              className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2.5"
              onScroll={(event) => setProjectScrollTop(event.currentTarget.scrollTop)}
            >
              {filteredProjects.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border/60 px-4 py-6 text-center text-sm text-muted-foreground">
                  {searchQuery
                    ? t('sidebar.noMatches')
                    : t('sidebar.noProjects')}
                </div>
              ) : (
                <div style={{ height: virtualProjectItems.length * PROJECT_ROW_HEIGHT, position: 'relative' }}>
                  {virtualProjectItems.slice(projectVisibleRange.start, projectVisibleRange.end).map((entry, index) => {
                    const actualIndex = projectVisibleRange.start + index
                    const top = actualIndex * PROJECT_ROW_HEIGHT
                    if (entry.type === 'header') {
                      return (
                        <div
                          key={entry.key}
                          className="px-0.5 text-[10px] font-medium text-muted-foreground"
                          style={{ position: 'absolute', top, left: 0, right: 0, height: PROJECT_ROW_HEIGHT }}
                        >
                          {entry.label}
                        </div>
                      )
                    }
                    const project = entry.data
                    const icon = deriveProjectIcon(project.id, sessions)
                    const count = sessions.filter((session) => session.projectId === project.id).length
                    const isActive = activeProjectId === project.id && chatView !== 'home'
                    const isRunning = runningProjectIds.has(project.id)
                    return (
                      <div
                        key={project.id}
                        style={{ position: 'absolute', top, left: 0, right: 0, height: PROJECT_ROW_HEIGHT }}
                      >
                        <div
                          className={cn(
                            'group flex h-[38px] items-center gap-2 rounded-lg px-2 py-1.5 transition-colors',
                            isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/40'
                          )}
                        >
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-3 text-left"
                            onClick={() => openProject(project.id)}
                          >
                            <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/40 text-foreground">
                              {renderProjectIcon(icon, 'size-3.5')}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-[12px] font-medium text-foreground">
                                  {project.name}
                                </span>
                                {project.sshConnectionId ? (
                                  <Badge variant="secondary" className="h-4 px-1 text-[9px] leading-none">
                                    SSH
                                  </Badge>
                                ) : null}
                              </div>
                            </div>
                          </button>
                          <div className="flex shrink-0 items-center gap-1">
                            {isRunning && <Loader2 className="size-3.5 animate-spin text-blue-500" />}
                            {project.pinned && <Pin className="size-3.5 text-amber-500" />}
                            <span className="text-[10px] text-muted-foreground">{count}</span>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-7 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
                                >
                                  <MoreHorizontal className="size-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-44">
                                <DropdownMenuItem onClick={() => openProject(project.id)}>
                                  <FolderOpen className="size-4" />
                                  {t('sidebar.openProject')}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={() =>
                                    deferDropdownAction(() =>
                                      startRename({ type: 'project', id: project.id, currentName: project.name })
                                    )
                                  }
                                >
                                  <Pencil className="size-4" />
                                  {tCommon('action.rename')}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={() =>
                                    deferDropdownAction(() =>
                                      setFolderPickerTarget({ type: 'project', projectId: project.id })
                                    )
                                  }
                                >
                                  <FolderInput className="size-4" />
                                  {t('sidebar.changeWorkingFolder')}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={async () => {
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
                                  }}
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
                                  {project.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                                  {project.pinned ? tCommon('action.unpin') : t('sidebar.pinToTop')}
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
                                        sessionCount: count
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
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="mt-auto px-2 py-2">
          <div className="flex items-center gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-8 shrink-0 rounded-full">
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
              className="h-8 flex-1 justify-between gap-2 px-2.5 text-[12px] text-foreground/80 hover:bg-muted/40"
              onClick={() => useUIStore.getState().openSettingsPage('general')}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Settings className="size-4 shrink-0" />
                <span className="truncate">{t('sidebar.systemSettings')}</span>
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground/70">
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

      <Dialog open={createProjectDialogOpen} onOpenChange={setCreateProjectDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('sidebar.newProject')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <div className="text-[12px] font-medium text-foreground">
                {tChat('input.projectName')}
              </div>
              <Input
                value={newProjectName}
                onChange={(event) => setNewProjectName(event.target.value)}
                placeholder={tChat('input.projectNamePlaceholder')}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void confirmCreateProject()
                }}
              />
            </div>
            <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
              <div className="font-medium text-foreground/80">
                {tChat('input.defaultProjectDirectory')}
              </div>
              <div className="mt-1 break-all">
                {effectiveDefaultProjectDirectory ||
                  tChat('input.defaultProjectDirectoryFallback')}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateProjectDialogOpen(false)}>
              {tCommon('action.cancel')}
            </Button>
            <Button variant="outline" onClick={() => void openCreateProjectFolderPicker()}>
              {tChat('input.selectFolder')}
            </Button>
            <Button onClick={() => void confirmCreateProject()}>
              {tChat('input.createProject')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
        projectName={folderPickerTarget?.type === 'create' ? folderPickerTarget.projectName : undefined}
        createMode={folderPickerTarget?.type === 'create'}
        preferredSection={folderPickerTarget?.type === 'create' ? folderPickerTarget.preferredSection : undefined}
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
          toast.success(
            t('sidebar_toast.projectWorkingFolderUpdated')
          )
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
          toast.success(
            t('sidebar_toast.projectWorkingFolderUpdated')
          )
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
