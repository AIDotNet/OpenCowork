import { useCallback, useMemo, useRef, useState } from 'react'
import packageJson from '../../../../../package.json'
import { useTranslation } from 'react-i18next'
import appIconUrl from '../../../../../resources/icon.png'
import readmeZh from '../../../../../README.zh.md?raw'
import changelogMd from '../../../../../CHANGELOG.md?raw'
import {
  BookOpen,
  Library,
  BarChart3,
  CalendarDays,
  ChevronDown,
  CircleHelp,
  ShieldCheck,
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
  Wand2,
  Monitor,
  Pencil,
  FileText,
  MessageSquare,
  Copy,
  Eraser
} from 'lucide-react'
import { DynamicIcon } from 'lucide-react/dynamic'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Input } from '@renderer/components/ui/input'
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
import { useChatStore, type SessionMode } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useTeamStore } from '@renderer/stores/team-store'
import { abortSession, clearPendingSessionMessages } from '@renderer/hooks/use-chat-actions'
import { sessionToMarkdown } from '@renderer/lib/utils/export-chat'
import { cn } from '@renderer/lib/utils'
import { clampLeftSidebarWidth, LEFT_SIDEBAR_DEFAULT_WIDTH } from './right-panel-defs'
import { toast } from 'sonner'

const DAY_MS = 24 * 60 * 60 * 1000

const modeIcons: Record<SessionMode, React.ReactNode> = {
  chat: <MessageSquare className="size-4" />,
  clarify: <CircleHelp className="size-4" />,
  cowork: <FolderOpen className="size-4" />,
  code: <FileText className="size-4" />,
  acp: <ShieldCheck className="size-4" />
}

type SessionListItem = ReturnType<typeof mapSession>
type BucketKey = 'today' | 'recentThreeDays' | 'recentWeek' | 'oneMonth' | 'older'

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
  updatedAt: number
  workingFolder?: string
  sshConnectionId?: string
  pluginId?: string
  pinned?: boolean
} {
  return {
    id: project.id,
    name: project.name,
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

function formatSessionStamp(updatedAt: number): string {
  const date = new Date(updatedAt)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString([], { month: 'numeric', day: 'numeric' })
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

export function WorkspaceSidebar(): React.JSX.Element {
  const { t, i18n } = useTranslation('layout')
  const { t: tCommon } = useTranslation('common')
  const chatView = useUIStore((state) => state.chatView)
  const settingsPageOpen = useUIStore((state) => state.settingsPageOpen)
  const skillsPageOpen = useUIStore((state) => state.skillsPageOpen)
  const resourcesPageOpen = useUIStore((state) => state.resourcesPageOpen)
  const drawPageOpen = useUIStore((state) => state.drawPageOpen)
  const translatePageOpen = useUIStore((state) => state.translatePageOpen)
  const sshPageOpen = useUIStore((state) => state.sshPageOpen)
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
  const createProject = useChatStore((state) => state.createProject)
  const setActiveProject = useChatStore((state) => state.setActiveProject)
  const renameProject = useChatStore((state) => state.renameProject)
  const deleteProject = useChatStore((state) => state.deleteProject)
  const togglePinProject = useChatStore((state) => state.togglePinProject)
  const deleteSession = useChatStore((state) => state.deleteSession)
  const updateSessionTitle = useChatStore((state) => state.updateSessionTitle)
  const duplicateSession = useChatStore((state) => state.duplicateSession)
  const clearSessionMessages = useChatStore((state) => state.clearSessionMessages)
  const togglePinSession = useChatStore((state) => state.togglePinSession)
  const runningSessions = useAgentStore((state) => state.runningSessions)
  const runningSubAgentSessionIdsSig = useAgentStore((state) => state.runningSubAgentSessionIdsSig)
  const activeTeamSessionId = useTeamStore((state) => state.activeTeam?.sessionId ?? null)
  const userAvatar = useSettingsStore((state) => state.userAvatar)
  const userName = useSettingsStore((state) => state.userName)
  const language = useSettingsStore((state) => state.language)
  const searchRef = useRef<HTMLInputElement>(null)
  const [search, setSearch] = useState('')
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
  const runningSubAgentSessionIds = useMemo(
    () => new Set(runningSubAgentSessionIdsSig ? runningSubAgentSessionIdsSig.split('\u0000') : []),
    [runningSubAgentSessionIdsSig]
  )
  const runningProjectIds = useMemo(() => {
    const projectIds = new Set<string>()
    for (const session of sessions) {
      if (!session.projectId) continue
      const isRunning =
        runningSessions[session.id] === 'running' ||
        runningSubAgentSessionIds.has(session.id) ||
        activeTeamSessionId === session.id
      if (isRunning) {
        projectIds.add(session.projectId)
      }
    }
    return projectIds
  }, [sessions, runningSessions, runningSubAgentSessionIds, activeTeamSessionId])
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
  const chatSurfaceActive =
    !settingsPageOpen &&
    !skillsPageOpen &&
    !resourcesPageOpen &&
    !drawPageOpen &&
    !translatePageOpen &&
    !sshPageOpen &&
    !tasksPageOpen
  const isProjectScoped =
    chatSurfaceActive &&
    (chatView === 'project' ||
      chatView === 'archive' ||
      chatView === 'channels' ||
      chatView === 'wiki' ||
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

  const openWiki = useCallback(() => {
    useUIStore.getState().navigateToWiki()
  }, [])

  const openSession = useCallback((sessionId: string) => {
    useChatStore.getState().setActiveSession(sessionId)
    useUIStore.getState().navigateToSession()
  }, [])

  const handleCreateProject = useCallback(async () => {
    const projectId = await createProject({ name: 'New Project' })
    setActiveProject(projectId)
    useUIStore.getState().navigateToProject()
    toast.success(t('sidebar_toast.projectCreated', { defaultValue: '项目已创建' }))
  }, [createProject, setActiveProject, t])

  const handleCreateSession = useCallback(() => {
    const projectId = scopedProjectId ?? activeProject?.id ?? null
    if (!projectId) return
    setActiveProject(projectId)
    useUIStore.getState().navigateToProject()
  }, [activeProject?.id, scopedProjectId, setActiveProject])

  const handleOpenDocs = useCallback(() => {
    useUIStore
      .getState()
      .openMarkdownPreview(t('sidebar.docsTitle', { defaultValue: '使用文档' }), readmeZh)
  }, [t])

  const handleOpenChangelog = useCallback(() => {
    useUIStore
      .getState()
      .openMarkdownPreview(t('sidebar.changelogTitle', { defaultValue: '更新日志' }), changelogMd)
  }, [t])

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
      toast.success(t('sidebar_toast.projectDeleted', { defaultValue: '项目已删除' }))
    } else {
      const hasRunning =
        runningSessions[deleteTarget.id] === 'running' ||
        runningSubAgentSessionIds.has(deleteTarget.id) ||
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
    runningSessions,
    runningSubAgentSessionIds,
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
        label: t('sidebar.recentThreeDays', { defaultValue: '最近3天' })
      },
      {
        key: 'recentWeek',
        label: t('sidebar.recentWeek', { defaultValue: '最近1周' })
      },
      {
        key: 'oneMonth',
        label: t('sidebar.oneMonth', { defaultValue: '最近1个月' })
      },
      { key: 'older', label: t('sidebar.older') }
    ],
    [t]
  )

  const navItems = [
    {
      key: 'home',
      label: t('sidebar.homeLabel', { defaultValue: '首页' }),
      icon: <Home className="size-4" />,
      active: chatView === 'home',
      onClick: openHome
    },
    {
      key: 'tasks',
      label: t('sidebar.tasksLabel', { defaultValue: '任务' }),
      icon: <CalendarDays className="size-4" />,
      active: useUIStore.getState().tasksPageOpen,
      onClick: () => useUIStore.getState().openTasksPage()
    },
    {
      key: 'resources',
      label: t('sidebar.resourcesLabel', { defaultValue: '资源' }),
      icon: <FolderOpen className="size-4" />,
      active: useUIStore.getState().resourcesPageOpen,
      onClick: () => useUIStore.getState().openResourcesPage()
    },
    {
      key: 'skills',
      label: t('sidebar.skillsLabel', { defaultValue: '技能' }),
      icon: <Wand2 className="size-4" />,
      active: useUIStore.getState().skillsPageOpen,
      onClick: () => useUIStore.getState().openSkillsPage()
    },
    {
      key: 'draw',
      label: t('sidebar.drawLabel', { defaultValue: '绘图' }),
      icon: <Image className="size-4" />,
      active: useUIStore.getState().drawPageOpen,
      onClick: () => useUIStore.getState().openDrawPage()
    },
    {
      key: 'ssh',
      label: t('sidebar.sshLabel', { defaultValue: 'SSH' }),
      icon: <Monitor className="size-4" />,
      active: useUIStore.getState().sshPageOpen,
      onClick: () => useUIStore.getState().openSshPage()
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
                    {t('sidebar.projectLabel', { defaultValue: '项目' })}
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
              <Button
                className="h-8 w-full justify-start gap-2 text-[12px]"
                onClick={handleCreateSession}
              >
                <Plus className="size-4" />
                {t('sidebar.newChat')}
              </Button>
              <Button
                variant={chatView === 'archive' ? 'secondary' : 'ghost'}
                className="h-8 w-full justify-start gap-2 text-[12px]"
                onClick={openArchive}
              >
                <BookOpen className="size-4" />
                {t('sidebar.projectArchive', { defaultValue: '项目档案' })}
              </Button>
              <Button
                variant={chatView === 'wiki' ? 'secondary' : 'ghost'}
                className="h-8 w-full justify-start gap-2 text-[12px]"
                onClick={openWiki}
              >
                <Library className="size-4" />
                {t('sidebar.projectWiki', { defaultValue: '项目 Wiki' })}
              </Button>
              <Button
                variant={chatView === 'channels' ? 'secondary' : 'ghost'}
                className="h-8 w-full justify-start gap-2 text-[12px]"
                onClick={openChannels}
              >
                <MessageSquare className="size-4" />
                {t('sidebar.projectChannels', { defaultValue: '聊天频道' })}
              </Button>
              <Button
                variant="ghost"
                className="h-8.5 w-full justify-start gap-2 text-[13px]"
                onClick={openHome}
              >
                <Home className="size-4" />
                {t('sidebar.backHome', { defaultValue: '返回首页' })}
              </Button>
            </div>

            <div className="px-2.5 pb-2.5">
              <div className="relative">
                <Input
                  ref={searchRef}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t('sidebar.searchSessions', { defaultValue: '搜索会话...' })}
                  className="h-7.5 rounded-xl border-border/60 bg-muted/20 pr-8 text-[12px]"
                />
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {filteredProjectSessions.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border/60 px-4 py-6 text-center text-sm text-muted-foreground">
                  {searchQuery
                    ? t('sidebar.noMatches')
                    : t('sidebar.noProjectSessions', { defaultValue: '当前项目还没有会话' })}
                </div>
              ) : (
                <div className="space-y-4">
                  {bucketDefs.map((bucket) => {
                    const items = groupedSessions[bucket.key]
                    if (items.length === 0) return null
                    return (
                      <section key={bucket.key} className="space-y-1.5">
                        <div className="px-1 text-[11px] font-medium text-muted-foreground">
                          {bucket.label}
                        </div>
                        <div className="space-y-1">
                          {items.map((session) => {
                            const isActive =
                              session.id === activeSessionId && chatView === 'session'
                            const isRunning = runningSessions[session.id] === 'running'
                            return (
                              <div
                                key={session.id}
                                className={cn(
                                  'group flex items-center gap-2 rounded-lg px-1.5 py-1 transition-colors',
                                  isActive
                                    ? 'bg-accent text-accent-foreground'
                                    : 'hover:bg-muted/50 text-foreground/85'
                                )}
                              >
                                <button
                                  type="button"
                                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                  onClick={() => openSession(session.id)}
                                >
                                  <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-background/50 text-muted-foreground">
                                    {session.pinned ? (
                                      <Pin className="size-3.5 text-amber-500" />
                                    ) : session.icon ? (
                                      <DynamicIcon
                                        name={session.icon as never}
                                        className="size-4"
                                      />
                                    ) : (
                                      modeIcons[session.mode]
                                    )}
                                  </span>
                                  <span className="min-w-0 flex-1">
                                    <span className="line-clamp-1 block text-[12px] font-medium">
                                      {session.title}
                                    </span>
                                    <span className="mt-0.5 block text-[10px] text-muted-foreground">
                                      {formatSessionStamp(session.updatedAt)}
                                    </span>
                                  </span>
                                </button>
                                {isRunning && (
                                  <Loader2 className="size-3.5 animate-spin text-primary" />
                                )}
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="size-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
                                    >
                                      <MoreHorizontal className="size-4" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="w-44">
                                    <DropdownMenuItem onClick={() => openSession(session.id)}>
                                      <MessageSquare className="size-4" />
                                      {t('sidebar.openSession', { defaultValue: '打开会话' })}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
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
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={() => {
                                        togglePinSession(session.id)
                                        toast.success(
                                          session.pinned
                                            ? t('sidebar_toast.unpinned')
                                            : t('sidebar_toast.pinnedMsg')
                                        )
                                      }}
                                    >
                                      {session.pinned ? (
                                        <PinOff className="size-4" />
                                      ) : (
                                        <Pin className="size-4" />
                                      )}
                                      {session.pinned
                                        ? tCommon('action.unpin')
                                        : t('sidebar.pinToTop')}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={async () => {
                                        await duplicateSession(session.id)
                                        toast.success(t('sidebar_toast.sessionDuplicated'))
                                      }}
                                    >
                                      <Copy className="size-4" />
                                      {tCommon('action.duplicate')}
                                    </DropdownMenuItem>
                                    {session.messageCount > 0 && (
                                      <DropdownMenuItem
                                        onClick={async () => {
                                          const full = useChatStore
                                            .getState()
                                            .sessions.find((item) => item.id === session.id)
                                          if (!full) return
                                          await useChatStore
                                            .getState()
                                            .loadSessionMessages(session.id)
                                          const snapshot = useChatStore
                                            .getState()
                                            .sessions.find((item) => item.id === session.id)
                                          if (!snapshot) return
                                          const fileName = `${snapshot.title.replace(/[^a-zA-Z0-9-_ ]/g, '').trim() || 'conversation'}.md`
                                          downloadMarkdown(fileName, sessionToMarkdown(snapshot))
                                          toast.success(t('sidebar_toast.exportedOne'))
                                        }}
                                      >
                                        <FileText className="size-4" />
                                        {t('sidebar.exportAsMarkdown')}
                                      </DropdownMenuItem>
                                    )}
                                    {session.messageCount > 0 && (
                                      <DropdownMenuItem
                                        onClick={() => {
                                          clearSessionMessages(session.id)
                                          clearPendingSessionMessages(session.id)
                                          toast.success(t('sidebar_toast.messagesCleared'))
                                        }}
                                      >
                                        <Eraser className="size-4" />
                                        {t('sidebar.clearMessages')}
                                      </DropdownMenuItem>
                                    )}
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
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
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>
                            )
                          })}
                        </div>
                      </section>
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
                        {userName || t('titleBar.defaultName', { defaultValue: 'OpenCowork' })}
                      </div>
                      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        {t('sidebar.profileMenu', { defaultValue: '个人菜单' })}
                        <ChevronDown className="size-3" />
                      </div>
                    </div>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-52">
                  <DropdownMenuLabel>
                    {userName || t('titleBar.defaultName', { defaultValue: 'OpenCowork' })}
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
                    {t('sidebar.memoryLabel', { defaultValue: '记忆' })}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => useUIStore.getState().openSettingsPage('analytics')}
                  >
                    <BarChart3 className="size-4" />
                    {t('sidebar.analyticsLabel', { defaultValue: '数据统计' })}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleToggleLanguage}>
                    <Languages className="size-4" />
                    {language === 'zh'
                      ? t('sidebar.switchToEnglish', { defaultValue: '切换到 English' })
                      : t('sidebar.switchToChinese', { defaultValue: '切换到中文' })}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => useUIStore.getState().openSettingsPage('about')}>
                    <Info className="size-4" />
                    {t('sidebar.aboutLabel', { defaultValue: '关于' })}
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
                {t('sidebar.projects', { defaultValue: '项目' })}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={() => void handleCreateProject()}
                title={t('sidebar.newProject', { defaultValue: '新建项目' })}
              >
                <FolderPlus className="size-3.5" />
              </Button>
            </div>

            <div className="px-2 pb-2">
              <Input
                ref={searchRef}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('sidebar.searchProjects', { defaultValue: '搜索项目...' })}
                className="h-7 rounded-lg border-border/60 bg-muted/20 text-[12px]"
              />
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2.5">
              {filteredProjects.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border/60 px-4 py-6 text-center text-sm text-muted-foreground">
                  {searchQuery
                    ? t('sidebar.noMatches')
                    : t('sidebar.noProjects', { defaultValue: '还没有项目' })}
                </div>
              ) : (
                <div className="space-y-0.5">
                  {filteredProjects.map((project) => {
                    const icon = deriveProjectIcon(project.id, sessions)
                    const count = sessions.filter(
                      (session) => session.projectId === project.id
                    ).length
                    const isActive = activeProjectId === project.id && chatView !== 'home'
                    const isRunning = runningProjectIds.has(project.id)
                    return (
                      <div
                        key={project.id}
                        className={cn(
                          'group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors',
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
                                {t('sidebar.openProject', { defaultValue: '打开项目' })}
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
                                onClick={() => {
                                  togglePinProject(project.id)
                                  toast.success(
                                    project.pinned
                                      ? t('sidebar_toast.projectUnpinned', {
                                          defaultValue: '项目已取消置顶'
                                        })
                                      : t('sidebar_toast.projectPinned', {
                                          defaultValue: '项目已置顶'
                                        })
                                  )
                                }}
                              >
                                {project.pinned ? (
                                  <PinOff className="size-4" />
                                ) : (
                                  <Pin className="size-4" />
                                )}
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
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="mt-auto px-2 py-2">
          <div className="flex flex-col gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-8 rounded-full">
                  <CircleHelp className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-44">
                <DropdownMenuItem onSelect={() => deferDropdownAction(handleOpenDocs)}>
                  <BookOpen className="size-4" />
                  {t('sidebar.docsTitle', { defaultValue: '使用文档' })}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => deferDropdownAction(handleOpenChangelog)}>
                  <History className="size-4" />
                  {t('sidebar.changelogTitle', { defaultValue: '更新日志' })}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="ghost"
              className="h-8 w-full justify-between gap-2 px-2.5 text-[12px] text-foreground/80 hover:bg-muted/40"
              onClick={() => useUIStore.getState().openSettingsPage('general')}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Settings className="size-4 shrink-0" />
                <span className="truncate">{t('sidebar.systemSettings')}</span>
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground/70">v{packageJson.version}</span>
            </Button>
          </div>
        </div>

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

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tCommon('action.delete')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.type === 'project'
                ? t('sidebar.deleteProjectConfirm', {
                    defaultValue:
                      deleteTarget.sessionCount > 0
                        ? `确定删除项目「${deleteTarget.name}」及其 ${deleteTarget.sessionCount} 个会话吗？`
                        : `确定删除项目「${deleteTarget.name}」吗？`,
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
