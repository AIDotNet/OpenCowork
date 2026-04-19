import { useState, useRef, useCallback, useMemo, useEffect, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { formatTokens, getBillableTotalTokens } from '@renderer/lib/format-tokens'
import {
  Plus,
  MessageSquare,
  CircleHelp,
  Trash2,
  Eraser,
  Search,
  Briefcase,
  Code2,
  ShieldCheck,
  Download,
  Copy,
  X,
  Pin,
  PinOff,
  Pencil,
  Loader2,
  CheckCircle2,
  PanelLeftClose,
  FolderOpen,
  FolderPlus,
  ChevronRight,
  Sparkles
} from 'lucide-react'
import { DynamicIcon } from 'lucide-react/dynamic'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@renderer/components/ui/context-menu'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
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
import { toast } from 'sonner'
import { useChatStore, type SessionMode } from '@renderer/stores/chat-store'
import type { ProviderType } from '@renderer/lib/api/types'
import {
  isProviderAvailableForModelSelection,
  useProviderStore
} from '@renderer/stores/provider-store'
import { ModelIcon } from '@renderer/components/settings/provider-icons'
import { useUIStore } from '@renderer/stores/ui-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useBackgroundSessionStore } from '@renderer/stores/background-session-store'
import { useTeamStore } from '@renderer/stores/team-store'
import {
  abortSession,
  clearPendingSessionMessages,
  getPendingSessionMessageCountForSession,
  subscribePendingSessionMessages
} from '@renderer/hooks/use-chat-actions'
import { sessionToMarkdown } from '@renderer/lib/utils/export-chat'
import { cn } from '@renderer/lib/utils'
import { WorkingFolderSelectorDialog } from '@renderer/components/chat/WorkingFolderSelectorDialog'
import { createProvider } from '@renderer/lib/api/provider'
import type { UnifiedMessage } from '@renderer/lib/api/types'
import { clampLeftSidebarWidth, LEFT_SIDEBAR_DEFAULT_WIDTH } from './right-panel-defs'

const modeIcons: Record<SessionMode, React.ReactNode> = {
  chat: <MessageSquare className="size-4" />,
  clarify: <CircleHelp className="size-4" />,
  cowork: <Briefcase className="size-4" />,
  code: <Code2 className="size-4" />,
  acp: <ShieldCheck className="size-4" />
}

interface SessionListItem {
  id: string
  title: string
  icon?: string
  mode: SessionMode
  createdAt: number
  updatedAt: number
  pinned?: boolean
  messageCount: number
  pluginId?: string
  projectId?: string
}

interface ProjectListItem {
  id: string
  name: string
  updatedAt: number
  workingFolder?: string | null
  sshConnectionId?: string | null
  pluginId?: string
  pinned?: boolean
}

type FolderPickerTarget = { type: 'create' } | { type: 'project'; projectId: string }

interface VisibleProjectGroup {
  project: ProjectListItem
  items: SessionListItem[]
  isMissing: boolean
}

const SESSION_LIST_PAGE_SIZE = 20
const HISTORY_AUTO_COLLAPSE_AFTER_MS = 7 * 24 * 60 * 60 * 1000
const RECENT_MINUTES_MS = 10 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS
const TWO_WEEKS_MS = 14 * DAY_MS
const MONTH_MS = 30 * DAY_MS

function deriveProjectNameFromFolder(folderPath?: string | null): string {
  const normalized = folderPath?.trim().replace(/[\\/]+$/, '')
  if (!normalized) return 'New Project'
  const parts = normalized.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || 'New Project'
}

export function SessionListPanel(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const projectsRaw = useChatStore((s) => s.projects)
  const projects = useMemo<ProjectListItem[]>(
    () =>
      projectsRaw.map((project) => ({
        id: project.id,
        name: project.name,
        updatedAt: project.updatedAt,
        workingFolder: project.workingFolder,
        sshConnectionId: project.sshConnectionId,
        pluginId: project.pluginId,
        pinned: project.pinned
      })),
    [projectsRaw]
  )
  const sessionDigest = useChatStore((s) =>
    s.sessions
      .map((session) =>
        [
          session.id,
          session.title,
          session.icon ?? '',
          session.mode,
          session.createdAt,
          session.updatedAt,
          session.pinned ? 1 : 0,
          session.messageCount,
          session.messagesLoaded ? 1 : 0,
          session.pluginId ?? '',
          session.projectId ?? ''
        ].join('|')
      )
      .join('¦')
  )
  const sessions = useMemo<SessionListItem[]>(() => {
    void sessionDigest
    return useChatStore.getState().sessions.map((session) => ({
      id: session.id,
      title: session.title,
      icon: session.icon,
      mode: session.mode,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      pinned: session.pinned,
      messageCount: session.messageCount,
      pluginId: session.pluginId,
      projectId: session.projectId
    }))
  }, [sessionDigest])
  const activeProjectId = useChatStore((s) => s.activeProjectId)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const streamingSessionIdsSig = useChatStore((s) =>
    Object.keys(s.streamingMessages).sort().join('\u0000')
  )
  const activeSessionProjectId = useMemo(
    () => sessions.find((session) => session.id === activeSessionId)?.projectId ?? null,
    [activeSessionId, sessions]
  )
  const deleteSession = useChatStore((s) => s.deleteSession)
  const setActiveSession = useChatStore((s) => s.setActiveSession)
  const setActiveProject = useChatStore((s) => s.setActiveProject)
  const createProject = useChatStore((s) => s.createProject)
  const renameProject = useChatStore((s) => s.renameProject)
  const deleteProject = useChatStore((s) => s.deleteProject)
  const togglePinProject = useChatStore((s) => s.togglePinProject)
  const updateProjectDirectory = useChatStore((s) => s.updateProjectDirectory)
  const updateSessionTitle = useChatStore((s) => s.updateSessionTitle)
  const clearSessionMessages = useChatStore((s) => s.clearSessionMessages)
  const duplicateSession = useChatStore((s) => s.duplicateSession)
  const updateSessionMode = useChatStore((s) => s.updateSessionMode)
  const togglePinSession = useChatStore((s) => s.togglePinSession)
  const mode = useUIStore((s) => s.mode)
  const runtimeLeftSidebarWidth = useUIStore((s) => s.leftSidebarWidth)
  const setRuntimeLeftSidebarWidth = useUIStore((s) => s.setLeftSidebarWidth)
  const persistedLeftSidebarWidth = useSettingsStore((s) => s.leftSidebarWidth)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const providers = useProviderStore((s) => s.providers)
  const runningSessions = useAgentStore((s) => s.runningSessions)
  const blockedCountsBySession = useBackgroundSessionStore((s) => s.blockedCountsBySession)
  const unreadCountsBySession = useBackgroundSessionStore((s) => s.unreadCountsBySession)
  const runningSubAgentSessionIdsSig = useAgentStore((s) => s.runningSubAgentSessionIdsSig)
  const runningBackgroundSessionIdsSig = useAgentStore((s) =>
    Object.values(s.backgroundProcesses)
      .filter((process) => process.sessionId && process.status === 'running')
      .map((process) => process.sessionId as string)
      .sort()
      .join('\u0000')
  )
  const activeTeamSessionId = useTeamStore((s) => s.activeTeam?.sessionId ?? null)
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const editRef = useRef<HTMLInputElement>(null)
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string
    title: string
    msgCount: number
    queueCount: number
  } | null>(null)
  const [projectDeleteTarget, setProjectDeleteTarget] = useState<{
    id: string
    name: string
    sessionCount: number
  } | null>(null)
  const [renameDialog, setRenameDialog] = useState<{
    type: 'project' | 'session'
    id: string
    currentName: string
  } | null>(null)
  const [folderPickerTarget, setFolderPickerTarget] = useState<FolderPickerTarget | null>(null)
  const [projectModelDialog, setProjectModelDialog] = useState<{
    projectId: string
    projectName: string
  } | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const [autoRenamingSessionId, setAutoRenamingSessionId] = useState<string | null>(null)
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set())
  const [expandedHistoryProjectIds, setExpandedHistoryProjectIds] = useState<Set<string>>(
    () => new Set()
  )
  const [visibleSessionCount, setVisibleSessionCount] = useState(SESSION_LIST_PAGE_SIZE)
  const sessionListScrollRef = useRef<HTMLDivElement>(null)
  const projectIdSet = useMemo(() => new Set(projects.map((project) => project.id)), [projects])
  const initialProjectCollapseAppliedRef = useRef(false)
  const draggingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(
    runtimeLeftSidebarWidth || persistedLeftSidebarWidth || LEFT_SIDEBAR_DEFAULT_WIDTH
  )
  const [isDraggingSidebar, setIsDraggingSidebar] = useState(false)
  const applyLeftSidebarWidth = useCallback(
    (width: number): void => {
      setRuntimeLeftSidebarWidth(clampLeftSidebarWidth(width))
    },
    [setRuntimeLeftSidebarWidth]
  )
  const getSessionSnapshot = useCallback(
    (sessionId: string) =>
      useChatStore.getState().sessions.find((session) => session.id === sessionId),
    []
  )
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
  const formatSessionRecency = useCallback(
    (updatedAt: number): string => {
      const elapsed = Date.now() - updatedAt
      if (elapsed < RECENT_MINUTES_MS) {
        return t('sidebar.recentMinutes', { defaultValue: '最近几分钟' })
      }
      if (elapsed < DAY_MS) {
        return t('sidebar.today')
      }
      if (elapsed < DAY_MS * 2) {
        return t('sidebar.yesterday')
      }
      if (elapsed < WEEK_MS) {
        return t('sidebar.recentWeek', { defaultValue: '最近一周' })
      }
      if (elapsed < TWO_WEEKS_MS) {
        return t('sidebar.twoWeeks', { defaultValue: '2周内' })
      }
      if (elapsed < MONTH_MS) {
        return t('sidebar.oneMonth', { defaultValue: '1个月内' })
      }
      return t('sidebar.older')
    },
    [t]
  )

  useEffect(() => {
    if (!renameDialog) return
    requestAnimationFrame(() => renameInputRef.current?.select())
  }, [renameDialog])

  useEffect(() => {
    if (initialProjectCollapseAppliedRef.current || projects.length === 0) return
    const expandedProjectId = activeSessionProjectId ?? activeProjectId
    setCollapsedProjectIds(
      new Set(
        projects
          .map((project) => project.id)
          .filter((projectId) => !expandedProjectId || projectId !== expandedProjectId)
      )
    )
    initialProjectCollapseAppliedRef.current = true
  }, [activeProjectId, activeSessionProjectId, projects])

  useEffect(() => {
    const expandedProjectId = activeSessionProjectId ?? activeProjectId
    if (!expandedProjectId) return
    setCollapsedProjectIds((prev) => {
      if (!prev.has(expandedProjectId)) return prev
      const next = new Set(prev)
      next.delete(expandedProjectId)
      return next
    })
  }, [activeProjectId, activeSessionProjectId])

  useEffect(() => {
    if (isDraggingSidebar) return
    const nextWidth = clampLeftSidebarWidth(
      persistedLeftSidebarWidth || runtimeLeftSidebarWidth || LEFT_SIDEBAR_DEFAULT_WIDTH
    )
    if (runtimeLeftSidebarWidth !== nextWidth) {
      setRuntimeLeftSidebarWidth(nextWidth)
    }
  }, [
    isDraggingSidebar,
    persistedLeftSidebarWidth,
    runtimeLeftSidebarWidth,
    setRuntimeLeftSidebarWidth
  ])

  useEffect(() => {
    if (!isDraggingSidebar) return

    const handleMouseMove = (event: MouseEvent): void => {
      if (!draggingRef.current) return
      const delta = event.clientX - startXRef.current
      applyLeftSidebarWidth(startWidthRef.current + delta)
    }

    const handleMouseUp = (): void => {
      draggingRef.current = false
      const nextWidth = clampLeftSidebarWidth(
        useUIStore.getState().leftSidebarWidth ||
          persistedLeftSidebarWidth ||
          LEFT_SIDEBAR_DEFAULT_WIDTH
      )
      setRuntimeLeftSidebarWidth(nextWidth)
      updateSettings({ leftSidebarWidth: nextWidth })
      setIsDraggingSidebar(false)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [
    applyLeftSidebarWidth,
    isDraggingSidebar,
    persistedLeftSidebarWidth,
    setRuntimeLeftSidebarWidth,
    updateSettings
  ])

  const deleteTargetRunningInfo = useMemo(() => {
    void pendingQueueSignature
    if (!deleteTarget) return null
    const id = deleteTarget.id
    const isAgentRunning = runningSessions[id] === 'running'
    const hasActiveSubAgents = runningSubAgentSessionIds.has(id)
    const hasActiveBackgroundProcess = runningBackgroundSessionIds.has(id)
    const hasStreaming = streamingSessionIds.has(id)
    const hasActiveTeam = activeTeamSessionId === id
    const hasRunning =
      isAgentRunning ||
      hasActiveSubAgents ||
      hasActiveBackgroundProcess ||
      hasStreaming ||
      hasActiveTeam
    return {
      isAgentRunning,
      hasActiveSubAgents,
      hasActiveBackgroundProcess,
      hasStreaming,
      hasActiveTeam,
      hasRunning
    }
  }, [
    deleteTarget,
    runningSessions,
    runningSubAgentSessionIds,
    runningBackgroundSessionIds,
    streamingSessionIds,
    activeTeamSessionId,
    pendingQueueSignature
  ])
  const folderPickerProjectId =
    folderPickerTarget?.type === 'project' ? folderPickerTarget.projectId : null
  const folderPickerProject = folderPickerProjectId
    ? projects.find((project) => project.id === folderPickerProjectId)
    : undefined

  const confirmDelete = useCallback(() => {
    if (!deleteTarget) return
    const session = getSessionSnapshot(deleteTarget.id)
    if (!session) {
      setDeleteTarget(null)
      return
    }
    const hasRunning =
      runningSessions[session.id] === 'running' ||
      runningSubAgentSessionIds.has(session.id) ||
      runningBackgroundSessionIds.has(session.id) ||
      streamingSessionIds.has(session.id) ||
      activeTeamSessionId === session.id
    if (hasRunning) {
      abortSession(session.id)
    }
    clearPendingSessionMessages(session.id)
    const snapshot = JSON.parse(JSON.stringify(session))
    deleteSession(session.id)
    setDeleteTarget(null)
    toast.success(t('sidebar_toast.sessionDeleted'), {
      action: {
        label: t('action.undo', { ns: 'common' }),
        onClick: () => useChatStore.getState().restoreSession(snapshot)
      },
      duration: 5000
    })
  }, [
    activeTeamSessionId,
    deleteTarget,
    deleteSession,
    getSessionSnapshot,
    runningBackgroundSessionIds,
    runningSessions,
    runningSubAgentSessionIds,
    streamingSessionIds,
    t
  ])

  const handleNewSession = (): void => {
    setActiveSession(null)
    const uiStore = useUIStore.getState()
    uiStore.setMode('chat')
    uiStore.navigateToHome()
  }

  const handleCreateProject = useCallback((): void => {
    setFolderPickerTarget({ type: 'create' })
  }, [])

  const handleCreateProjectWithDirectory = useCallback(
    async (workingFolder: string, sshConnectionId: string | null): Promise<void> => {
      const id = await createProject({
        name: deriveProjectNameFromFolder(workingFolder),
        workingFolder,
        sshConnectionId: sshConnectionId ?? undefined
      })
      setActiveProject(id)
      setFolderPickerTarget(null)
      useUIStore.getState().navigateToHome()
      toast.success(t('sidebar_toast.projectCreated', { defaultValue: 'Project created' }))
    },
    [createProject, setActiveProject, t]
  )

  const toggleProjectHistoryExpanded = useCallback((projectId: string): void => {
    setExpandedHistoryProjectIds((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
  }, [])

  const openRenameDialog = useCallback(
    (type: 'project' | 'session', id: string, currentName: string): void => {
      setRenameDialog({ type, id, currentName })
      setRenameValue(currentName)
    },
    []
  )

  const handleRenameProject = useCallback(
    (projectId: string, currentName: string): void => {
      openRenameDialog('project', projectId, currentName)
    },
    [openRenameDialog]
  )

  const handleDeleteProject = useCallback(
    (projectId: string, name: string, sessionCount: number): void => {
      setProjectDeleteTarget({ id: projectId, name, sessionCount })
    },
    []
  )

  const handleEditProjectDirectory = useCallback((projectId: string): void => {
    setFolderPickerTarget({ type: 'project', projectId })
  }, [])

  const toggleProjectCollapsed = useCallback((projectId: string): void => {
    setCollapsedProjectIds((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
  }, [])

  const chatProviderGroups = useMemo(
    () =>
      providers
        .filter(isProviderAvailableForModelSelection)
        .map((provider) => ({
          provider,
          models: provider.models
        }))
        .filter((group) => group.models.length > 0),
    [providers]
  )

  const buildModelValue = useCallback((providerId: string, modelId: string): string => {
    return `${providerId}:${modelId}`
  }, [])

  const confirmRename = useCallback((): void => {
    if (!renameDialog) return
    const nextName = renameValue.trim()
    if (!nextName) return

    const current = renameDialog.currentName.trim()
    if (nextName !== current) {
      if (renameDialog.type === 'project') {
        renameProject(renameDialog.id, nextName)
        toast.success(t('sidebar_toast.projectRenamed', { defaultValue: 'Project renamed' }))
      } else {
        updateSessionTitle(renameDialog.id, nextName)
        toast.success(t('sidebar_toast.sessionRenamed', { defaultValue: 'Session renamed' }))
      }
    }

    setRenameDialog(null)
    setRenameValue('')
  }, [renameDialog, renameValue, renameProject, t, updateSessionTitle])

  const handleEditProjectModel = useCallback((projectId: string, projectName: string): void => {
    setProjectModelDialog({ projectId, projectName })
  }, [])

  const applyProjectModel = useCallback(
    (value: string): void => {
      if (!projectModelDialog) return
      const project = useChatStore
        .getState()
        .projects.find((item) => item.id === projectModelDialog.projectId)
      if (!project) return

      if (value === '__global__') {
        const now = Date.now()
        useChatStore.setState((state) => {
          const target = state.projects.find((item) => item.id === projectModelDialog.projectId)
          if (!target) return
          target.providerId = undefined
          target.modelId = undefined
          target.updatedAt = now
        })
        setProjectModelDialog(null)
        toast.success('项目默认模型已改为跟随全局')
        return
      }

      const [providerId, modelId] = value.split(':')
      if (!providerId || !modelId) return

      const now = Date.now()
      useChatStore.setState((state) => {
        const target = state.projects.find((item) => item.id === projectModelDialog.projectId)
        if (!target) return
        target.providerId = providerId
        target.modelId = modelId
        target.updatedAt = now
      })
      setProjectModelDialog(null)
      toast.success('项目默认模型已更新')
    },
    [projectModelDialog]
  )

  const confirmDeleteProject = useCallback(async (): Promise<void> => {
    if (!projectDeleteTarget) return

    const relatedSessionIds = useChatStore
      .getState()
      .sessions.filter((session) => session.projectId === projectDeleteTarget.id)
      .map((session) => session.id)

    for (const sessionId of relatedSessionIds) {
      abortSession(sessionId)
      clearPendingSessionMessages(sessionId)
    }

    await deleteProject(projectDeleteTarget.id)
    setCollapsedProjectIds((prev) => {
      if (!prev.has(projectDeleteTarget.id)) return prev
      const next = new Set(prev)
      next.delete(projectDeleteTarget.id)
      return next
    })
    setProjectDeleteTarget(null)
    toast.success(t('sidebar_toast.projectDeleted', { defaultValue: 'Project deleted' }))
  }, [deleteProject, projectDeleteTarget, t])

  const handleAutoRenameSession = useCallback(
    async (sessionId: string): Promise<void> => {
      if (autoRenamingSessionId) return
      setAutoRenamingSessionId(sessionId)

      try {
        await useChatStore.getState().loadSessionMessages(sessionId)
        const session = getSessionSnapshot(sessionId)
        if (!session) return

        const providerStore = useProviderStore.getState()
        const providerConfig =
          session.providerId && session.modelId
            ? providerStore.getProviderConfigById(session.providerId, session.modelId)
            : providerStore.getActiveProviderConfig()

        if (!providerConfig) {
          toast.error('当前没有可用模型')
          return
        }

        const provider = createProvider(providerConfig)
        const transcript = session.messages
          .slice(0, 12)
          .map((message) => {
            const text =
              typeof message.content === 'string'
                ? message.content
                : message.content
                    .filter(
                      (
                        block
                      ): block is Extract<UnifiedMessage['content'][number], { type: 'text' }> =>
                        block.type === 'text'
                    )
                    .map((block) => block.text)
                    .join('\n')
            return text.trim() ? `${message.role}: ${text.trim()}` : ''
          })
          .filter(Boolean)
          .join('\n\n')
          .slice(0, 6000)

        if (!transcript.trim()) {
          toast.error('该会话没有可用于重命名的文本内容')
          return
        }

        const messages: UnifiedMessage[] = [
          {
            id: crypto.randomUUID(),
            role: 'user',
            content:
              '请基于下面的会话内容，生成一个简短、准确的中文会话标题。要求：1）不超过18个字；2）不要使用引号、书名号、句号；3）只输出标题本身，不要解释。\n\n' +
              transcript,
            createdAt: Date.now()
          }
        ]

        let nextTitle = ''
        for await (const event of provider.sendMessage(messages, [], {
          ...providerConfig,
          systemPrompt:
            '你是一个会话标题生成器。只返回一个简短准确的中文标题，不要解释，不要使用标点包裹。'
        })) {
          if (event.type === 'text_delta' && event.text) {
            nextTitle += event.text
          }
        }

        const cleanedTitle = nextTitle
          .replace(/[\r\n"“”'‘’《》【】]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 18)

        if (!cleanedTitle) {
          toast.error('AI 未生成有效标题')
          return
        }

        updateSessionTitle(sessionId, cleanedTitle)
        toast.success('已自动重命名会话')
      } catch (error) {
        toast.error('自动重命名失败', {
          description: error instanceof Error ? error.message : String(error)
        })
      } finally {
        setAutoRenamingSessionId((current) => (current === sessionId ? null : current))
      }
    },
    [autoRenamingSessionId, getSessionSnapshot, updateSessionTitle]
  )

  const handleExport = async (sessionId: string): Promise<void> => {
    await useChatStore.getState().loadSessionMessages(sessionId)
    const session = getSessionSnapshot(sessionId)
    if (!session) return
    const md = sessionToMarkdown(session)
    const filename =
      session.title
        .replace(/[^a-zA-Z0-9-_ ]/g, '')
        .slice(0, 50)
        .trim() || 'conversation'
    const blob = new Blob([md], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${filename}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  const startResize = useCallback(
    (event: React.MouseEvent): void => {
      event.preventDefault()
      draggingRef.current = true
      startXRef.current = event.clientX
      startWidthRef.current = clampLeftSidebarWidth(
        runtimeLeftSidebarWidth || persistedLeftSidebarWidth || LEFT_SIDEBAR_DEFAULT_WIDTH
      )
      setIsDraggingSidebar(true)
    },
    [persistedLeftSidebarWidth, runtimeLeftSidebarWidth]
  )

  const sortedSessions = useMemo(() => {
    return sessions.slice().sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      return b.updatedAt - a.updatedAt
    })
  }, [sessions])

  const searchQuery = search.trim().toLowerCase()

  useEffect(() => {
    setVisibleSessionCount(SESSION_LIST_PAGE_SIZE)
    const container = sessionListScrollRef.current
    if (container) {
      container.scrollTop = 0
    }
  }, [searchQuery, activeProjectId])

  const visibleSessions = useMemo(() => {
    if (searchQuery) return sortedSessions
    return sortedSessions.slice(0, visibleSessionCount)
  }, [searchQuery, sortedSessions, visibleSessionCount])

  const hasMoreSessions = !searchQuery && visibleSessionCount < sortedSessions.length

  const loadMoreSessions = useCallback((): void => {
    if (searchQuery) return
    setVisibleSessionCount((current) => {
      if (current >= sortedSessions.length) return current
      return Math.min(current + SESSION_LIST_PAGE_SIZE, sortedSessions.length)
    })
  }, [searchQuery, sortedSessions.length])

  const handleSessionListScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>): void => {
      if (searchQuery || !hasMoreSessions) return
      const container = event.currentTarget
      const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight
      if (distanceToBottom <= 96) {
        loadMoreSessions()
      }
    },
    [hasMoreSessions, loadMoreSessions, searchQuery]
  )

  const contentSearchMeta = useMemo(() => {
    const matchedIds = new Set<string>()
    const snippetBySessionId = new Map<string, string>()
    if (!searchQuery) return { matchedIds, snippetBySessionId }

    void sessionDigest
    const rawSessions = useChatStore.getState().sessions
    for (const session of rawSessions) {
      if (
        session.title.toLowerCase().includes(searchQuery) ||
        session.mode.toLowerCase().includes(searchQuery)
      ) {
        continue
      }
      if (!session.messagesLoaded) continue
      for (const message of session.messages) {
        const text =
          typeof message.content === 'string'
            ? message.content
            : Array.isArray(message.content)
              ? message.content
                  .filter((block) => block.type === 'text')
                  .map((block) => block.text)
                  .join('\n')
              : ''
        const lower = text.toLowerCase()
        const idx = lower.indexOf(searchQuery)
        if (idx === -1) continue
        matchedIds.add(session.id)
        const start = Math.max(0, idx - 20)
        const snippet =
          (start > 0 ? '...' : '') +
          text.slice(start, idx + searchQuery.length + 30).replace(/\n/g, ' ') +
          (idx + searchQuery.length + 30 < text.length ? '...' : '')
        snippetBySessionId.set(session.id, snippet)
        break
      }
    }

    return { matchedIds, snippetBySessionId }
  }, [searchQuery, sessionDigest])

  const filteredSessions = searchQuery
    ? sortedSessions.filter((session) => {
        if (session.title.toLowerCase().includes(searchQuery)) return true
        if (session.mode.toLowerCase().includes(searchQuery)) return true
        return contentSearchMeta.matchedIds.has(session.id)
      })
    : visibleSessions

  const sessionsByProject = useMemo(() => {
    const map = new Map<string, SessionListItem[]>()
    for (const session of filteredSessions) {
      if (!session.projectId) continue
      const list = map.get(session.projectId)
      if (list) {
        list.push(session)
      } else {
        map.set(session.projectId, [session])
      }
    }
    return map
  }, [filteredSessions])

  const filteredProjectGroups = useMemo<VisibleProjectGroup[]>(() => {
    const sortedProjects = projects.slice().sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
      if (!!a.pluginId !== !!b.pluginId) return a.pluginId ? 1 : -1
      return b.updatedAt - a.updatedAt
    })

    const visibleGroups = sortedProjects
      .filter((project) => {
        const hasSessions = (sessionsByProject.get(project.id)?.length ?? 0) > 0
        if (!searchQuery) return true
        return project.name.toLowerCase().includes(searchQuery) || hasSessions
      })
      .map((project) => ({
        project,
        items: sessionsByProject.get(project.id) ?? [],
        isMissing: false
      }))

    const knownIds = new Set(sortedProjects.map((project) => project.id))
    for (const [projectId, items] of sessionsByProject.entries()) {
      if (knownIds.has(projectId)) continue
      visibleGroups.push({
        project: {
          id: projectId,
          name: t('sidebar.unknownProject', { defaultValue: 'Unknown Project' }),
          updatedAt: Date.now(),
          pinned: false
        },
        items,
        isMissing: true
      })
    }

    return visibleGroups
  }, [projects, sessionsByProject, searchQuery, t])

  const pinnedProjectGroups = useMemo(
    () => filteredProjectGroups.filter((group) => group.project.pinned && !group.isMissing),
    [filteredProjectGroups]
  )
  const regularProjectGroups = useMemo(
    () => filteredProjectGroups.filter((group) => !group.project.pinned || group.isMissing),
    [filteredProjectGroups]
  )

  useEffect(() => {
    if (searchQuery || !hasMoreSessions) return
    const container = sessionListScrollRef.current
    if (!container) return
    if (container.scrollHeight <= container.clientHeight + 96) {
      loadMoreSessions()
    }
  }, [filteredProjectGroups.length, hasMoreSessions, loadMoreSessions, searchQuery])

  const historyCollapseThreshold = Date.now() - HISTORY_AUTO_COLLAPSE_AFTER_MS

  const renderSessionItem = (session: SessionListItem): React.JSX.Element => (
    <ContextMenu key={session.id}>
      <ContextMenuTrigger asChild>
        <button
          className={cn(
            'group flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors',
            session.id === activeSessionId &&
              useUIStore.getState().chatView === 'session' &&
              !useUIStore.getState().settingsPageOpen
              ? 'bg-accent text-accent-foreground'
              : 'text-foreground/80 hover:bg-muted/60'
          )}
          onClick={() => {
            setActiveSession(session.id)
            useUIStore.getState().navigateToSession()
          }}
          onDoubleClick={(e) => {
            e.preventDefault()
            setEditingId(session.id)
            setEditTitle(session.title)
            setTimeout(() => editRef.current?.select(), 0)
          }}
          onMouseEnter={() => setHoveredSessionId(session.id)}
          onMouseLeave={() =>
            setHoveredSessionId((current) => (current === session.id ? null : current))
          }
        >
          <span className="relative flex size-4 shrink-0 items-center justify-center">
            {session.pinned ? (
              <button
                type="button"
                className="flex size-4 items-center justify-center text-amber-500/75 transition-all duration-150 hover:-rotate-12 hover:text-amber-500"
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  togglePinSession(session.id)
                }}
                onMouseDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
                title={t('action.unpin', { ns: 'common' })}
              >
                <Pin className="size-3.5" />
              </button>
            ) : hoveredSessionId === session.id ? (
              <button
                type="button"
                className="flex size-4 items-center justify-center text-muted-foreground/65 transition-all duration-150 hover:scale-105 hover:text-foreground/80"
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  togglePinSession(session.id)
                }}
                onMouseDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
                title={t('sidebar.pinToTop')}
              >
                <Pin className="size-3.25" />
              </button>
            ) : session.icon ? (
              <DynamicIcon name={session.icon as never} className="size-4" />
            ) : (
              modeIcons[session.mode]
            )}
          </span>
          {editingId === session.id ? (
            <input
              ref={editRef}
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onBlur={() => {
                const trimmed = editTitle.trim()
                if (trimmed && trimmed !== session.title) {
                  useChatStore.getState().updateSessionTitle(session.id, trimmed)
                  toast.success(t('action.rename', { ns: 'common' }))
                }
                setEditingId(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') {
                  setEditingId(null)
                }
              }}
              onClick={(e) => e.stopPropagation()}
              className="h-6 w-full min-w-0 rounded border bg-background px-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          ) : (
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm leading-4">{session.title}</span>
              {searchQuery &&
                !session.title.toLowerCase().includes(searchQuery) &&
                contentSearchMeta.snippetBySessionId.get(session.id) && (
                  <span className="truncate text-[9px] text-muted-foreground/40">
                    {contentSearchMeta.snippetBySessionId.get(session.id)}
                  </span>
                )}
            </div>
          )}
          {editingId !== session.id && (
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {(runningSessions[session.id] === 'running' ||
                runningSubAgentSessionIds.has(session.id) ||
                runningBackgroundSessionIds.has(session.id) ||
                streamingSessionIds.has(session.id) ||
                activeTeamSessionId === session.id) && (
                <Loader2 className="size-3.5 animate-spin text-blue-500" />
              )}
              {runningSessions[session.id] === 'completed' && (
                <CheckCircle2 className="size-3.5 text-emerald-500" />
              )}
              {(blockedCountsBySession[session.id] ?? 0) > 0 && (
                <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-600 dark:text-amber-400">
                  {(blockedCountsBySession[session.id] ?? 0) > 99
                    ? '99+'
                    : blockedCountsBySession[session.id]}
                </span>
              )}
              {(unreadCountsBySession[session.id] ?? 0) > 0 && (
                <span className="rounded-full border border-sky-500/20 bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-medium text-sky-600 dark:text-sky-400">
                  {(unreadCountsBySession[session.id] ?? 0) > 99
                    ? '99+'
                    : unreadCountsBySession[session.id]}
                </span>
              )}
              {getPendingSessionMessageCountForSession(session.id) > 0 && (
                <span className="rounded-full border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                  {getPendingSessionMessageCountForSession(session.id)}
                </span>
              )}
              {session.mode !== mode && (
                <span className="rounded bg-muted px-1 py-px text-[8px] uppercase text-muted-foreground/40">
                  {session.mode}
                </span>
              )}
              <span className="text-[10px] text-muted-foreground/40">
                {formatSessionRecency(session.updatedAt)}
              </span>
            </span>
          )}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem
          onClick={() => {
            togglePinSession(session.id)
            toast.success(
              session.pinned
                ? t('sidebar_toast.sessionUnpinned', { defaultValue: '会话已取消置顶' })
                : t('sidebar_toast.sessionPinned', { defaultValue: '会话已置顶' })
            )
          }}
        >
          {session.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
          {session.pinned ? t('action.unpin', { ns: 'common' }) : t('sidebar.pinToTop')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => openRenameDialog('session', session.id, session.title)}>
          <Pencil className="size-4" />
          {t('action.rename', { ns: 'common' })}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={autoRenamingSessionId === session.id}
          onClick={() => {
            void handleAutoRenameSession(session.id)
          }}
        >
          {autoRenamingSessionId === session.id ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Sparkles className="size-4" />
          )}
          自动重命名
        </ContextMenuItem>
        {session.messageCount > 0 && (
          <>
            <ContextMenuItem
              onClick={async () => {
                await handleExport(session.id)
                toast.success(t('sidebar_toast.exportedOne'))
              }}
            >
              <Download className="size-4" />
              {t('sidebar.exportAsMarkdown')}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={async () => {
                await useChatStore.getState().loadSessionMessages(session.id)
                const snapshot = getSessionSnapshot(session.id)
                if (!snapshot) return
                const json = JSON.stringify(snapshot, null, 2)
                const blob = new Blob([json], {
                  type: 'application/json'
                })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = `${
                  session.title
                    .replace(/[^a-zA-Z0-9-_ ]/g, '')
                    .slice(0, 50)
                    .trim() || 'session'
                }.json`
                a.click()
                URL.revokeObjectURL(url)
                toast.success(t('sidebar_toast.exportedAsJson'))
              }}
            >
              <Download className="size-4" />
              {t('sidebar.exportAsJson')}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                duplicateSession(session.id)
                toast.success(t('sidebar_toast.sessionDuplicated'))
              }}
            >
              <Copy className="size-4" />
              {t('action.duplicate', { ns: 'common' })}
            </ContextMenuItem>
            <ContextMenuSeparator />
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
          </>
        )}
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            {modeIcons[session.mode]}
            {t('sidebar.switchMode')}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {(['chat', 'clarify', 'cowork', 'code', 'acp'] as const).map((m) => (
              <ContextMenuItem
                key={m}
                disabled={session.mode === m}
                onClick={() => {
                  updateSessionMode(session.id, m)
                  toast.success(t('sidebar_toast.switchedMode', { mode: m }))
                }}
              >
                {modeIcons[m]}
                <span className="capitalize">{t(`sidebar.mode.${m}`)}</span>
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          onClick={() => {
            const hasRunning =
              runningSessions[session.id] === 'running' ||
              runningSubAgentSessionIds.has(session.id) ||
              runningBackgroundSessionIds.has(session.id) ||
              streamingSessionIds.has(session.id) ||
              activeTeamSessionId === session.id
            const queueCount = getPendingSessionMessageCountForSession(session.id)
            if (session.messageCount > 0 || hasRunning || queueCount > 0) {
              setDeleteTarget({
                id: session.id,
                title: session.title,
                msgCount: session.messageCount,
                queueCount
              })
              return
            }
            const snapshot = getSessionSnapshot(session.id)
            if (!snapshot) return
            clearPendingSessionMessages(snapshot.id)
            deleteSession(snapshot.id)
            toast.success(t('sidebar_toast.sessionDeleted'), {
              action: {
                label: t('action.undo', { ns: 'common' }),
                onClick: () => useChatStore.getState().restoreSession(snapshot)
              },
              duration: 5000
            })
          }}
        >
          <Trash2 className="size-4" />
          {t('action.delete', { ns: 'common' })}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )

  const renderProjectGroup = (group: VisibleProjectGroup): React.JSX.Element => {
    const isCollapsed = collapsedProjectIds.has(group.project.id)
    const canManageProject = !group.isMissing && projectIdSet.has(group.project.id)
    const shouldAutoCollapseHistory = !searchQuery
    const recentItems = shouldAutoCollapseHistory
      ? group.items.filter((session) => session.updatedAt >= historyCollapseThreshold)
      : group.items
    const historicalItems = shouldAutoCollapseHistory
      ? group.items.filter((session) => session.updatedAt < historyCollapseThreshold)
      : []
    const isHistoryExpanded =
      expandedHistoryProjectIds.has(group.project.id) ||
      historicalItems.some((session) => session.id === activeSessionId)

    return (
      <div key={group.project.id} className="mb-1.5">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              className={cn(
                'mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium transition-colors',
                activeProjectId === group.project.id
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground'
              )}
              onClick={() => setActiveProject(group.project.id)}
              title={group.project.name}
            >
              <span
                className="inline-flex size-4 shrink-0 items-center justify-center"
                onClick={(event) => {
                  event.stopPropagation()
                  toggleProjectCollapsed(group.project.id)
                }}
              >
                <ChevronRight
                  className={cn(
                    'size-3.5 transition-transform duration-200 ease-in-out',
                    !isCollapsed && 'rotate-90'
                  )}
                />
              </span>
              <FolderOpen className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{group.project.name}</span>
              {group.project.pinned && (
                <Pin className="size-3 text-muted-foreground/35 -rotate-45" />
              )}
              <span className="text-xs text-muted-foreground/60">{group.items.length}</span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-48">
            <ContextMenuItem
              disabled={!canManageProject}
              onClick={() => {
                togglePinProject(group.project.id)
                toast.success(
                  group.project.pinned
                    ? t('sidebar_toast.projectUnpinned', { defaultValue: '项目已取消置顶' })
                    : t('sidebar_toast.projectPinned', { defaultValue: '项目已置顶' })
                )
              }}
            >
              {group.project.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
              {group.project.pinned ? t('action.unpin', { ns: 'common' }) : t('sidebar.pinToTop')}
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!canManageProject}
              onClick={() => handleRenameProject(group.project.id, group.project.name)}
            >
              <Pencil className="size-4" />
              {t('action.rename', { ns: 'common' })}
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!canManageProject}
              onClick={() => handleEditProjectDirectory(group.project.id)}
            >
              <FolderOpen className="size-4" />
              修改工作目录
            </ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger inset>修改默认模型</ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-72">
                <ContextMenuItem
                  onClick={() => handleEditProjectModel(group.project.id, group.project.name)}
                >
                  打开模型选择
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              disabled={!canManageProject}
              onClick={() =>
                handleDeleteProject(group.project.id, group.project.name, group.items.length)
              }
            >
              <Trash2 className="size-4" />
              {t('action.delete', { ns: 'common' })}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <div
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-200 ease-in-out',
            isCollapsed
              ? 'grid-rows-[0fr] opacity-0 pointer-events-none'
              : 'grid-rows-[1fr] opacity-100'
          )}
        >
          <div className="overflow-hidden">
            <div className="ml-4 border-l border-border/40 pl-2">
              {recentItems.map(renderSessionItem)}
              {historicalItems.length > 0 && (
                <div className="mt-1 border-t border-border/30 pt-1">
                  <button
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                    onClick={() => toggleProjectHistoryExpanded(group.project.id)}
                  >
                    <ChevronRight
                      className={cn(
                        'size-3.5 transition-transform duration-200 ease-in-out',
                        isHistoryExpanded && 'rotate-90'
                      )}
                    />
                    <span>
                      {isHistoryExpanded
                        ? t('sidebar.collapseOlderSessions', { defaultValue: '收起历史记录' })
                        : t('sidebar.expandOlderSessions', {
                            count: historicalItems.length,
                            defaultValue: '展开历史记录（{{count}}）'
                          })}
                    </span>
                  </button>
                  {isHistoryExpanded && historicalItems.map(renderSessionItem)}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <div
        data-tour="left-sidebar"
        className="relative flex h-full shrink-0 flex-col overflow-hidden border-r bg-background/50"
        style={{
          width: clampLeftSidebarWidth(
            runtimeLeftSidebarWidth || persistedLeftSidebarWidth || LEFT_SIDEBAR_DEFAULT_WIDTH
          )
        }}
      >
        <div className="flex items-center justify-between px-3 pb-1 pt-3">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-foreground/80">
              {t('sidebar.conversations')}
            </span>
            {sessions.length > 0 && (
              <span className="text-[10px] text-muted-foreground">({sessions.length})</span>
            )}
          </div>
          <div data-tour="session-actions" className="flex items-center gap-1">
            {sessions.some((s) => s.messageCount > 0) && (
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={() => {
                  const withMessages = sessions.filter((s) => s.messageCount > 0)
                  Promise.all(withMessages.map((s) => handleExport(s.id)))
                    .then(() => toast.success(t('sidebar_toast.exported')))
                    .catch(() => {})
                }}
                title={t('sidebar.exportAll')}
              >
                <Download className="size-3" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={handleCreateProject}
              title={t('sidebar.newProject', { defaultValue: 'New Project' })}
            >
              <FolderPlus className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={handleNewSession}
              title={t('sidebar.newChat')}
            >
              <Plus className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={() => useUIStore.getState().setLeftSidebarOpen(false)}
              title={t('sidebar.collapse', { defaultValue: 'Collapse sidebar' })}
            >
              <PanelLeftClose className="size-3.5" />
            </Button>
          </div>
        </div>

        {sessions.length > 3 && (
          <div className="px-3 pb-1.5 pt-1">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground/60" />
              <Input
                ref={searchRef}
                placeholder={t('sidebar.filterSessions')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setSearch('')
                    searchRef.current?.blur()
                  }
                }}
                className={`h-7 rounded-lg border-transparent bg-muted/50 pl-7 text-xs transition-colors focus:border-border ${search ? 'pr-6' : ''}`}
              />
              {search && (
                <>
                  <span className="pointer-events-none absolute right-6 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground/40">
                    {filteredSessions.length}/{sortedSessions.length}
                  </span>
                  <button
                    onClick={() => {
                      setSearch('')
                      searchRef.current?.focus()
                    }}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        <div
          ref={sessionListScrollRef}
          className="flex-1 overflow-y-auto px-1.5"
          onScroll={handleSessionListScroll}
        >
          {filteredProjectGroups.length === 0 ? (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground">
              {sessions.length === 0 ? t('sidebar.noConversations') : t('sidebar.noMatches')}
            </div>
          ) : (
            <>
              {pinnedProjectGroups.length > 0 && (
                <div className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
                  {t('sidebar.pinnedProjects', { defaultValue: '置顶项目' })}
                </div>
              )}
              {pinnedProjectGroups.map(renderProjectGroup)}

              {regularProjectGroups.length > 0 && (
                <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
                  {t('sidebar.projects', { defaultValue: '项目' })}
                </div>
              )}
              {regularProjectGroups.map(renderProjectGroup)}
              {hasMoreSessions && (
                <div className="px-2 py-3 text-center text-[10px] text-muted-foreground/60">
                  {t('common.loading', { ns: 'common', defaultValue: '加载中...' })}
                </div>
              )}
            </>
          )}
        </div>

        {isDraggingSidebar && <div className="absolute inset-0 z-30" />}
        <div
          className="absolute right-0 top-0 z-20 h-full w-1.5 cursor-col-resize transition-colors hover:bg-primary/20"
          onMouseDown={startResize}
        />

        <div className="border-t px-3 py-2">
          <p className="text-center text-[10px] text-muted-foreground/25">
            {sessions.length} {t('sidebar.sessions')} ·{' '}
            {sessions.reduce((sum, session) => sum + session.messageCount, 0)} {t('sidebar.msgs')}
            {(() => {
              const rawSessions = useChatStore.getState().sessions
              const providerState = useProviderStore.getState()
              const getSessionRequestType = (
                session: (typeof rawSessions)[number]
              ): ProviderType | undefined => {
                const provider = session.providerId
                  ? providerState.providers.find((item) => item.id === session.providerId)
                  : null
                const model = session.modelId
                  ? provider?.models.find((item) => item.id === session.modelId)
                  : null
                return model?.type ?? provider?.type
              }
              let total = rawSessions.reduce(
                (a, s) =>
                  a +
                  s.messages.reduce(
                    (b, m) =>
                      b + (m.usage ? getBillableTotalTokens(m.usage, getSessionRequestType(s)) : 0),
                    0
                  ),
                0
              )
              const teamState = useTeamStore.getState()
              const allMembers = [
                ...(teamState.activeTeam?.members ?? []),
                ...teamState.teamHistory.flatMap((t) => t.members)
              ]
              for (const m of allMembers) {
                if (m.usage) total += getBillableTotalTokens(m.usage)
              }
              return total > 0 ? ` · ${formatTokens(total)} tokens` : ''
            })()}
          </p>
        </div>
      </div>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('sidebar.deleteConversation')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  {t('sidebar.deleteConfirm', {
                    title: deleteTarget?.title
                  })}
                </p>
                {deleteTarget?.queueCount ? (
                  <p>
                    {t('sidebar.deleteQueuedMessagesNotice', {
                      defaultValue: '该会话还有 {{count}} 条待发送消息，也会一起删除。',
                      count: deleteTarget.queueCount
                    })}
                  </p>
                ) : null}
                {deleteTargetRunningInfo?.hasRunning && (
                  <p className="font-medium text-destructive">
                    {t('sidebar.deleteRunningNotice', {
                      defaultValue: '该会话存在正在运行的任务，删除前会先停止当前运行。'
                    })}
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('action.cancel', { ns: 'common' })}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDelete}>
              {deleteTargetRunningInfo?.hasRunning
                ? t('sidebar.stopAndDelete')
                : t('action.delete', { ns: 'common' })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!projectDeleteTarget}
        onOpenChange={(open) => {
          if (!open) setProjectDeleteTarget(null)
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('sidebar.deleteProject', { defaultValue: 'Delete project' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('sidebar.deleteProjectConfirm', {
                defaultValue:
                  (projectDeleteTarget?.sessionCount ?? 0) > 0
                    ? `Delete project "${projectDeleteTarget?.name ?? ''}" and ${projectDeleteTarget?.sessionCount ?? 0} sessions?`
                    : `Delete project "${projectDeleteTarget?.name ?? ''}"?`,
                projectName: projectDeleteTarget?.name ?? '',
                count: projectDeleteTarget?.sessionCount ?? 0
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('action.cancel', { ns: 'common' })}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                void confirmDeleteProject()
              }}
            >
              {t('action.delete', { ns: 'common' })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={!!projectModelDialog}
        onOpenChange={(open) => {
          if (!open) setProjectModelDialog(null)
        }}
      >
        <DialogContent className="p-4 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sm">
              修改项目默认模型{projectModelDialog ? ` · ${projectModelDialog.projectName}` : ''}
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-80 space-y-2 overflow-y-auto">
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start"
              onClick={() => applyProjectModel('__global__')}
            >
              跟随全局默认模型
            </Button>
            {chatProviderGroups.map(({ provider, models }) => (
              <div key={`project-model-${provider.id}`} className="space-y-1">
                <div className="px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {provider.name}
                </div>
                {models.map((model) => (
                  <Button
                    key={`project-model-${provider.id}-${model.id}`}
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start"
                    onClick={() => applyProjectModel(buildModelValue(provider.id, model.id))}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <ModelIcon
                        icon={model.icon}
                        modelId={model.id}
                        providerBuiltinId={provider.builtinId}
                        size={16}
                        className="text-muted-foreground/70"
                      />
                      <div className="flex min-w-0 flex-col items-start text-left">
                        <span className="max-w-[220px] truncate">{model.name}</span>
                        <span className="max-w-[220px] truncate text-[10px] text-muted-foreground/60">
                          {model.id}
                        </span>
                      </div>
                    </div>
                  </Button>
                ))}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <WorkingFolderSelectorDialog
        open={!!folderPickerTarget}
        onOpenChange={(open) => {
          if (!open) setFolderPickerTarget(null)
        }}
        workingFolder={folderPickerProject?.workingFolder ?? undefined}
        sshConnectionId={folderPickerProject?.sshConnectionId ?? null}
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
            t('sidebar_toast.projectWorkingFolderUpdated', {
              defaultValue: 'Project working folder updated'
            })
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
            t('sidebar_toast.projectWorkingFolderUpdated', {
              defaultValue: 'Project working folder updated'
            })
          )
        }}
      />

      <Dialog
        open={!!renameDialog}
        onOpenChange={(open) => {
          if (!open) setRenameDialog(null)
        }}
      >
        <DialogContent className="sm:max-w-sm p-4">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {renameDialog?.type === 'project'
                ? t('sidebar.renameProject', { defaultValue: 'Rename project' })
                : t('sidebar.renameSession')}
            </DialogTitle>
          </DialogHeader>
          <Input
            ref={renameInputRef}
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                confirmRename()
              }
              if (event.key === 'Escape') {
                setRenameDialog(null)
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRenameDialog(null)}>
              {t('action.cancel', { ns: 'common' })}
            </Button>
            <Button size="sm" onClick={confirmRename} disabled={!renameValue.trim()}>
              {t('action.rename', { ns: 'common' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
