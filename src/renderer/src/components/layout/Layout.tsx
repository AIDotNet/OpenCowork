import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import {
  CircleHelp,
  Briefcase,
  Code2,
  ShieldCheck,
  ClipboardCopy,
  Check,
  ImageDown,
  Loader2,
  PanelLeftOpen,
  ExternalLink
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useTheme } from 'next-themes'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider
} from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'
import { TitleBar } from './TitleBar'
import { WorkspaceSidebar } from './WorkspaceSidebar'
import { RightPanel } from './RightPanel'
import { PreviewPanel } from './PreviewPanel'
import { SubAgentExecutionDetail } from './SubAgentExecutionDetail'
import { RIGHT_PANEL_TAB_ORDER } from './right-panel-defs'
import { MessageList } from '@renderer/components/chat/MessageList'
import { InputArea } from '@renderer/components/chat/InputArea'
import { SettingsDialog } from '@renderer/components/settings/SettingsDialog'
import { ChatHomePage } from '@renderer/components/chat/ChatHomePage'
import { ProjectHomePage } from '@renderer/components/chat/ProjectHomePage'
import { ProjectArchivePage } from '@renderer/components/chat/ProjectArchivePage'
import { WorkingFolderSelectorDialog } from '@renderer/components/chat/WorkingFolderSelectorDialog'
import { KeyboardShortcutsDialog } from '@renderer/components/settings/KeyboardShortcutsDialog'
import { PermissionDialog } from '@renderer/components/cowork/PermissionDialog'
import { ConversationGuideDialog } from '@renderer/components/chat/ConversationGuideDialog'
import { CommandPalette } from './CommandPalette'
import { ErrorBoundary } from '@renderer/components/error-boundary'
import { useUIStore, type AppMode } from '@renderer/stores/ui-store'
import { useChatStore, type SessionMode } from '@renderer/stores/chat-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useChatActions } from '@renderer/hooks/use-chat-actions'
import { toast } from 'sonner'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { sessionToMarkdown } from '@renderer/lib/utils/export-chat'
import { AnimatePresence, motion } from 'motion/react'
import { PageTransition, PanelTransition } from '@renderer/components/animate-ui'
import { useShallow } from 'zustand/react/shallow'
import {
  renderModeTooltipContent,
  type ModeOption,
  type SelectableMode
} from '@renderer/lib/mode-tooltips'

const modes: ModeOption[] = [
  { value: 'clarify', labelKey: 'mode.clarify', icon: <CircleHelp className="size-3.5" /> },
  { value: 'cowork', labelKey: 'mode.cowork', icon: <Briefcase className="size-3.5" /> },
  { value: 'code', labelKey: 'mode.code', icon: <Code2 className="size-3.5" /> },
  { value: 'acp', labelKey: 'mode.acp', icon: <ShieldCheck className="size-3.5" /> }
]

const MODE_SWITCH_TRANSITION = {
  type: 'spring',
  stiffness: 320,
  damping: 26,
  mass: 0.7
} as const

const MODE_SWITCH_HIGHLIGHT_CLASS: Record<SelectableMode, string> = {
  clarify: 'border-amber-500/15 bg-amber-500/5 shadow-sm',
  cowork: 'border-emerald-500/15 bg-emerald-500/5 shadow-sm',
  code: 'border-violet-500/15 bg-violet-500/5 shadow-sm',
  acp: 'border-cyan-500/15 bg-cyan-500/5 shadow-sm'
}

const MODE_SWITCH_ACTIVE_TEXT_CLASS: Record<SelectableMode, string> = {
  clarify: 'text-foreground',
  cowork: 'text-foreground',
  code: 'text-foreground',
  acp: 'text-foreground'
}

const SettingsPage = lazy(async () => {
  const mod = await import('@renderer/components/settings/SettingsPage')
  return { default: mod.SettingsPage }
})

const SkillsPage = lazy(async () => {
  const mod = await import('@renderer/components/skills/SkillsPage')
  return { default: mod.SkillsPage }
})

const ResourcesPage = lazy(async () => {
  const mod = await import('@renderer/components/resources/ResourcesPage')
  return { default: mod.ResourcesPage }
})

const TranslatePage = lazy(async () => {
  const mod = await import('@renderer/components/translate/TranslatePage')
  return { default: mod.TranslatePage }
})

const DrawPage = lazy(async () => {
  const mod = await import('@renderer/components/draw/DrawPage')
  return { default: mod.DrawPage }
})

const SshPage = lazy(async () => {
  const mod = await import('@renderer/components/ssh/SshPage')
  return { default: mod.SshPage }
})

const TasksPage = lazy(async () => {
  const mod = await import('../tasks/TasksPage')
  return { default: mod.TasksPage }
})

function LazyPageFallback(): React.JSX.Element {
  return (
    <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
    </div>
  )
}

interface LayoutUpdateInfo {
  newVersion: string
  downloading: boolean
  downloadProgress: number | null
}

interface LayoutProps {
  updateInfo: LayoutUpdateInfo | null
  onOpenUpdateDialog: () => void
}

export function Layout({ updateInfo, onOpenUpdateDialog }: LayoutProps): React.JSX.Element {
  const { t } = useTranslation('layout')
  const { t: tCommon } = useTranslation('common')
  const mode = useUIStore((s) => s.mode)
  const setMode = useUIStore((s) => s.setMode)
  const leftSidebarOpen = useUIStore((s) => s.leftSidebarOpen)
  const previewPanelOpen = useUIStore((s) => s.previewPanelOpen)
  const previewPanelState = useUIStore((s) => s.previewPanelState)
  const closePreviewPanel = useUIStore((s) => s.closePreviewPanel)
  const subAgentExecutionDetailOpen = useUIStore((s) => s.subAgentExecutionDetailOpen)
  const subAgentExecutionDetailToolUseId = useUIStore((s) => s.subAgentExecutionDetailToolUseId)
  const closeSubAgentExecutionDetail = useUIStore((s) => s.closeSubAgentExecutionDetail)
  const toolbarCollapsedByDefault = useSettingsStore((s) => s.toolbarCollapsedByDefault)
  const chatView = useUIStore((s) => s.chatView)
  const activeSessionView = useChatStore(
    useShallow((s) => {
      const activeSession = s.sessions.find((session) => session.id === s.activeSessionId)
      const activeProjectId = activeSession?.projectId ?? s.activeProjectId
      const activeProject = activeProjectId
        ? s.projects.find((project) => project.id === activeProjectId)
        : undefined
      return {
        activeProjectId: activeProjectId ?? null,
        activeSessionTitle: activeSession?.title,
        activeSessionMode: activeSession?.mode as SessionMode | undefined,
        activeWorkingFolder: activeProject?.workingFolder,
        activeSessionSshConnectionId: activeProject?.sshConnectionId
      }
    })
  )
  const { activeProjectId, activeSessionTitle, activeSessionMode, activeWorkingFolder } =
    activeSessionView
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const updateSessionMode = useChatStore((s) => s.updateSessionMode)
  const streamingMessageId = useChatStore((s) => s.streamingMessageId)
  const isStreaming = !!streamingMessageId
  const pendingToolCallCount = useAgentStore((s) => s.pendingToolCalls.length)
  const pendingApproval = useAgentStore((s) => s.pendingToolCalls[0] ?? null)
  const resolveApproval = useAgentStore((s) => s.resolveApproval)
  const initBackgroundProcessTracking = useAgentStore((s) => s.initBackgroundProcessTracking)

  const { resolvedTheme, setTheme: ntSetTheme } = useTheme()
  const {
    sendMessage,
    stopStreaming,
    continueLastToolExecution,
    retryLastMessage,
    editAndResend,
    deleteMessage
  } = useChatActions()

  const [copiedAll, setCopiedAll] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [folderDialogOpen, setFolderDialogOpen] = useState(false)

  const runningSubAgentNamesSig = useAgentStore((s) => s.runningSubAgentNamesSig)
  const runningSubAgentCount = runningSubAgentNamesSig
    ? runningSubAgentNamesSig.split('\u0000').length
    : 0
  const runningSubAgentLabel = runningSubAgentNamesSig
    ? runningSubAgentNamesSig.split('\u0000').join(', ')
    : ''

  const shouldUseStaticWindowTitle = import.meta.env.MODE === 'test' || navigator.webdriver

  const handleModeChange = useCallback(
    (nextMode: AppMode): void => {
      setMode(nextMode)
      if (chatView === 'session' && activeSessionId) {
        updateSessionMode(activeSessionId, nextMode)
      }
    },
    [activeSessionId, chatView, setMode, updateSessionMode]
  )

  useEffect(() => {
    void initBackgroundProcessTracking()
  }, [initBackgroundProcessTracking])

  useEffect(() => {
    if (mode === 'chat') {
      setFolderDialogOpen(false)
    }
  }, [mode])

  // Update window title (show pending approvals + streaming state + SubAgent)
  useEffect(() => {
    if (shouldUseStaticWindowTitle) {
      document.title = 'OpenCoWork'
      return
    }

    const base = activeSessionTitle ? `${activeSessionTitle} — OpenCoWork` : 'OpenCoWork'
    const prefix =
      pendingToolCallCount > 0
        ? `(${pendingToolCallCount} pending) `
        : runningSubAgentCount > 0
          ? `🧠 ${runningSubAgentLabel} | `
          : streamingMessageId
            ? '⏳ '
            : ''
    document.title = `${prefix}${base}`
  }, [
    activeSessionTitle,
    pendingToolCallCount,
    runningSubAgentCount,
    runningSubAgentLabel,
    shouldUseStaticWindowTitle,
    streamingMessageId
  ])

  // Sync UI mode only when session info changes, so manual top-bar toggles are respected
  useEffect(() => {
    if (!activeSessionMode) return
    const currentMode = useUIStore.getState().mode
    if (currentMode !== activeSessionMode) {
      queueMicrotask(() => {
        if (useUIStore.getState().mode !== activeSessionMode) {
          useUIStore.getState().setMode(activeSessionMode)
        }
      })
    }
  }, [activeSessionId, activeSessionMode])

  useEffect(() => {
    if (chatView !== 'session' || activeSessionId) return
    if (activeProjectId) {
      useUIStore.getState().navigateToProject()
      return
    }
    useUIStore.getState().navigateToHome()
  }, [activeProjectId, activeSessionId, chatView])

  // Close detail panel when switching sessions
  const prevActiveSessionRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevActiveSessionRef.current
    prevActiveSessionRef.current = activeSessionId
    if (prev !== null && prev !== activeSessionId) {
      useUIStore.getState().closeDetailPanel()
      useUIStore.getState().closeSubAgentExecutionDetail()
    }
  }, [activeSessionId])

  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const settingsPageOpen = useUIStore((s) => s.settingsPageOpen)
  const conversationGuideOpen = useUIStore((s) => s.conversationGuideOpen)
  const setConversationGuideOpen = useUIStore((s) => s.setConversationGuideOpen)
  const skillsPageOpen = useUIStore((s) => s.skillsPageOpen)
  const resourcesPageOpen = useUIStore((s) => s.resourcesPageOpen)
  const drawPageOpen = useUIStore((s) => s.drawPageOpen)
  const translatePageOpen = useUIStore((s) => s.translatePageOpen)
  const sshPageOpen = useUIStore((s) => s.sshPageOpen)
  const tasksPageOpen = useUIStore((s) => s.tasksPageOpen)
  const sshPageEverOpened = useRef(false)
  if (sshPageOpen) sshPageEverOpened.current = true
  const toggleLeftSidebar = useUIStore((s) => s.toggleLeftSidebar)
  const _loaded = useChatStore((s) => s._loaded)
  const appliedDefaultToolbarStateRef = useRef(false)

  useEffect(() => {
    if (appliedDefaultToolbarStateRef.current) return
    useUIStore.getState().setLeftSidebarOpen(!toolbarCollapsedByDefault)
    appliedDefaultToolbarStateRef.current = true
  }, [toolbarCollapsedByDefault])

  // On initial DB load, restore last active session if any
  useEffect(() => {
    if (_loaded) {
      const activeId = useChatStore.getState().activeSessionId
      if (activeId) {
        useUIStore.getState().navigateToSession()
      }
    }
  }, [_loaded])

  const getActiveSessionSnapshot = useCallback(
    (): ReturnType<typeof useChatStore.getState>['sessions'][number] | undefined =>
      useChatStore.getState().sessions.find((session) => session.id === activeSessionId),
    [activeSessionId]
  )

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent): Promise<void> => {
      // Ctrl+Shift+N: New session — navigate to home
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'N' || e.key === 'n')) {
        e.preventDefault()
        useUIStore.getState().navigateToHome()
        return
      }
      // Ctrl+1/2/3: Switch mode
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && ['1', '2', '3'].includes(e.key)) {
        e.preventDefault()
        const modeMap = { '1': 'clarify', '2': 'cowork', '3': 'code' } as const
        handleModeChange(modeMap[e.key as '1' | '2' | '3'])
      }
      // Ctrl+N: New chat — navigate to home
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault()
        useUIStore.getState().navigateToHome()
      }
      // Ctrl+,: Open settings
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        useUIStore.getState().openSettingsPage()
      }
      // Ctrl+B: Toggle left sidebar
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'b') {
        e.preventDefault()
        toggleLeftSidebar()
      }
      // Ctrl+Shift+B: Toggle right panel
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'B') {
        e.preventDefault()
        useUIStore.getState().toggleRightPanel()
      }
      // Ctrl+L: Clear current conversation
      if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
        e.preventDefault()
        if (activeSessionId) {
          const session = getActiveSessionSnapshot()
          if (session && session.messageCount > 0) {
            const ok = await confirm({
              title: t('layout.clearConfirm', { count: session.messageCount }),
              variant: 'destructive'
            })
            if (!ok) return
          }
          useChatStore.getState().clearSessionMessages(activeSessionId)
          if (session && session.messageCount > 0) toast.success(t('layout.conversationCleared'))
        }
      }
      // Ctrl+D: Duplicate current session
      if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
        e.preventDefault()
        if (activeSessionId) {
          useChatStore.getState().duplicateSession(activeSessionId)
          toast.success(t('layout.sessionDuplicated'))
        }
      }
      // Ctrl+P: Pin/unpin current session
      if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
        e.preventDefault()
        if (activeSessionId) {
          const session = getActiveSessionSnapshot()
          useChatStore.getState().togglePinSession(activeSessionId)
          toast.success(session?.pinned ? t('layout.unpinned') : t('layout.pinned'))
        }
      }
      // Ctrl+Up/Down: Navigate between sessions
      if ((e.metaKey || e.ctrlKey) && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        const store = useChatStore.getState()
        const sorted = store.sessions.slice().sort((a, b) => {
          if (a.pinned && !b.pinned) return -1
          if (!a.pinned && b.pinned) return 1
          return b.updatedAt - a.updatedAt
        })
        if (sorted.length < 2) return
        const idx = sorted.findIndex((s) => s.id === store.activeSessionId)
        const next =
          e.key === 'ArrowDown'
            ? (idx + 1) % sorted.length
            : (idx - 1 + sorted.length) % sorted.length
        store.setActiveSession(sorted[next].id)
      }
      // Ctrl+Home/End: Scroll to top/bottom of messages
      if ((e.metaKey || e.ctrlKey) && (e.key === 'Home' || e.key === 'End')) {
        e.preventDefault()
        const container = document.querySelector('.overflow-y-auto')
        if (container) {
          container.scrollTo({
            top: e.key === 'Home' ? 0 : container.scrollHeight,
            behavior: 'smooth'
          })
        }
      }
      // Escape: Stop streaming
      if (e.key === 'Escape' && streamingMessageId) {
        e.preventDefault()
        stopStreaming()
      }
      // Ctrl+/: Keyboard shortcuts
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault()
        useUIStore.getState().setShortcutsOpen(true)
      }
      // Ctrl+Shift+C: Copy conversation as markdown
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        e.preventDefault()
        if (activeSessionId) {
          await useChatStore.getState().loadSessionMessages(activeSessionId)
        }
        const session = useChatStore.getState().sessions.find((s) => s.id === activeSessionId)
        if (session && session.messageCount > 0) {
          navigator.clipboard.writeText(sessionToMarkdown(session))
          toast.success(t('layout.conversationCopied'))
        }
        return
      }
      // Ctrl+Shift+A: Toggle auto-approve tools
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        e.preventDefault()
        const current = useSettingsStore.getState().autoApprove
        if (!current) {
          const ok = await confirm({ title: t('layout.autoApproveConfirm') })
          if (!ok) return
        }
        useSettingsStore.getState().updateSettings({ autoApprove: !current })
        toast.success(current ? t('layout.autoApproveOff') : t('layout.autoApproveOn'))
        return
      }
      // Ctrl+Shift+Delete: Clear all sessions
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'Delete') {
        e.preventDefault()
        const store = useChatStore.getState()
        const count = store.sessions.length
        if (count > 0) {
          const ok = await confirm({
            title: t('layout.deleteAllConfirm', { count }),
            variant: 'destructive'
          })
          if (!ok) return
          store.clearAllSessions()
          toast.success(t('layout.deletedSessions', { count }))
        }
      }
      // Ctrl+Shift+T: Cycle right panel tab forward
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'T' || e.key === 't')) {
        e.preventDefault()
        const ui = useUIStore.getState()
        if (!ui.rightPanelOpen) {
          ui.setRightPanelOpen(true)
          return
        }
        const tabs = RIGHT_PANEL_TAB_ORDER.filter((tab) => tab !== 'acp')
        const idx = tabs.indexOf(ui.rightPanelTab === 'acp' ? 'steps' : ui.rightPanelTab)
        ui.setRightPanelTab(tabs[(idx + 1) % tabs.length])
        return
      }
      // Ctrl+Shift+D: Toggle dark/light theme
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault()
        const current = resolvedTheme
        const next = current === 'dark' ? 'light' : 'dark'
        useSettingsStore.getState().updateSettings({ theme: next })
        ntSetTheme(next)
        toast.success(`${t('layout.theme')}: ${next}`)
        return
      }
      // Ctrl+Shift+O: Import sessions from JSON backup
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'O' || e.key === 'o')) {
        e.preventDefault()
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.json'
        input.onchange = async () => {
          const file = input.files?.[0]
          if (!file) return
          try {
            const text = await file.text()
            const data = JSON.parse(text)
            const sessions = Array.isArray(data) ? data : [data]
            const store = useChatStore.getState()
            let imported = 0
            for (const s of sessions) {
              if (s && s.id && Array.isArray(s.messages)) {
                const exists = store.sessions.some((e) => e.id === s.id)
                if (!exists) {
                  store.restoreSession(s)
                  imported++
                }
              }
            }
            if (imported > 0) {
              toast.success(t('layout.importedSessions', { count: imported }))
            } else {
              toast.info(t('layout.noNewSessions'))
            }
          } catch (err) {
            toast.error(
              t('layout.importFailed', { error: err instanceof Error ? err.message : String(err) })
            )
          }
        }
        input.click()
        return
      }
      // Ctrl+Shift+S: Backup all sessions as JSON
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'S' || e.key === 's')) {
        e.preventDefault()
        const allSessions = useChatStore.getState().sessions
        if (allSessions.length === 0) {
          toast.error(t('layout.noSessionsToBackup'))
          return
        }
        await Promise.all(allSessions.map((s) => useChatStore.getState().loadSessionMessages(s.id)))
        const latestSessions = useChatStore.getState().sessions
        const json = JSON.stringify(latestSessions, null, 2)
        const blob = new Blob([json], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `opencowork-backup-${new Date().toISOString().slice(0, 10)}.json`
        a.click()
        URL.revokeObjectURL(url)
        toast.success(t('layout.backedUpSessions', { count: latestSessions.length }))
        return
      }
      // Ctrl+Shift+E: Export current conversation
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'E') {
        e.preventDefault()
        if (activeSessionId) {
          await useChatStore.getState().loadSessionMessages(activeSessionId)
        }
        const session = useChatStore.getState().sessions.find((s) => s.id === activeSessionId)
        if (session && session.messageCount > 0) {
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
          toast.success(t('layout.exportedConversation'))
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    mode,
    setSettingsOpen,
    toggleLeftSidebar,
    activeSessionId,
    ntSetTheme,
    resolvedTheme,
    stopStreaming,
    streamingMessageId,
    t,
    getActiveSessionSnapshot,
    handleModeChange
  ])

  const resolveActiveProjectId = async (): Promise<string | null> => {
    if (activeProjectId) return activeProjectId
    const chatStore = useChatStore.getState()
    if (chatStore.activeProjectId) return chatStore.activeProjectId
    const ensured = await chatStore.ensureDefaultProject()
    return ensured?.id ?? null
  }

  const updateActiveProjectDirectory = async (
    patch: Partial<{ workingFolder: string | null; sshConnectionId: string | null }>
  ): Promise<void> => {
    const chatStore = useChatStore.getState()
    const projectId = await resolveActiveProjectId()
    if (!projectId) return
    chatStore.updateProjectDirectory(projectId, patch)
  }

  const handleOpenFolderDialog = (): void => {
    setFolderDialogOpen(true)
  }

  const handleOpenWorkingFolder = async (): Promise<void> => {
    if (!activeWorkingFolder) return
    await ipcClient.invoke(IPC.SHELL_OPEN_PATH, activeWorkingFolder)
  }

  const handleCopyAll = (): void => {
    const session = useChatStore.getState().sessions.find((s) => s.id === activeSessionId)
    if (!session) return
    const md = sessionToMarkdown(session)
    navigator.clipboard.writeText(md)
    setCopiedAll(true)
    setTimeout(() => setCopiedAll(false), 2000)
  }

  const handleExportImage = async (): Promise<void> => {
    const node = document.querySelector('[data-message-content]') as HTMLElement | null
    const session = useChatStore.getState().sessions.find((s) => s.id === activeSessionId)
    if (!node || !session) return
    setExporting(true)

    // Inject temporary styles to force all content to fit within container width.
    // html-to-image clones the DOM and may lose layout constraints, causing overflow.
    const styleEl = document.createElement('style')
    styleEl.setAttribute('data-export-image', '')
    styleEl.textContent = `
      [data-message-content] * {
        max-width: 100% !important;
        overflow-wrap: break-word !important;
        word-break: break-word !important;
      }
      [data-message-content] pre,
      [data-message-content] code {
        white-space: pre-wrap !important;
        word-break: break-all !important;
      }
      [data-message-content] table {
        table-layout: fixed !important;
        width: 100% !important;
      }
      [data-message-content] img,
      [data-message-content] svg {
        max-width: 100% !important;
        height: auto !important;
      }
    `
    document.head.appendChild(styleEl)

    try {
      // Wait for reflow so the browser applies the injected styles
      await new Promise<void>((r) => requestAnimationFrame(() => r()))

      const bgRaw = getComputedStyle(document.documentElement)
        .getPropertyValue('--background')
        .trim()
      const bgColor = bgRaw ? `hsl(${bgRaw})` : '#ffffff'
      const { toPng } = await import('html-to-image')
      const captureWidth = node.clientWidth
      const dataUrl = await toPng(node, {
        backgroundColor: bgColor,
        pixelRatio: 2,
        width: captureWidth,
        style: {
          overflow: 'hidden',
          maxWidth: `${captureWidth}px`,
          width: `${captureWidth}px`
        }
      })

      const base64 = dataUrl.split(',')[1]
      const result = (await ipcClient.invoke(IPC.CLIPBOARD_WRITE_IMAGE, { data: base64 })) as {
        success?: boolean
        error?: string
      }
      if (!result?.success) {
        throw new Error(result?.error || 'Clipboard write failed')
      }
      toast.success(t('layout.imageCopied', { defaultValue: 'Image copied to clipboard' }))
    } catch (err) {
      console.error('Export image failed:', err)
      toast.error(t('layout.exportImageFailed', { defaultValue: 'Export image failed' }), {
        description: String(err)
      })
    } finally {
      document.head.removeChild(styleEl)
      setExporting(false)
    }
  }

  const chatSurfaceActive =
    !tasksPageOpen &&
    !resourcesPageOpen &&
    !skillsPageOpen &&
    !settingsPageOpen &&
    !drawPageOpen &&
    !translatePageOpen &&
    !sshPageOpen
  const showEmbeddedSidebar = leftSidebarOpen
  const showGlobalExpandButton = !leftSidebarOpen && !chatSurfaceActive && !settingsPageOpen

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex h-screen flex-col overflow-hidden">
        {/* Full-width title bar */}
        <TitleBar updateInfo={updateInfo} onOpenUpdateDialog={onOpenUpdateDialog} />

        <div className="flex flex-1 overflow-hidden px-1 pt-1 pb-1.5">
          <div className="relative flex flex-1 overflow-hidden rounded-lg border border-border/60 bg-background/85 shadow-[0_12px_40px_-20px_rgba(0,0,0,0.55)] backdrop-blur-sm">
            {/* Embedded workspace sidebar */}
            <AnimatePresence>
              {showEmbeddedSidebar && (
                <PanelTransition side="left" disabled={false} className="h-full z-10">
                  <WorkspaceSidebar />
                </PanelTransition>
              )}
            </AnimatePresence>

            {showGlobalExpandButton && (
              <div className="titlebar-no-drag absolute left-3 top-3 z-20">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="titlebar-no-drag size-8 rounded-lg border border-border/60 bg-background/80 backdrop-blur-sm"
                      onMouseDown={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                      }}
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        toggleLeftSidebar()
                      }}
                    >
                      <PanelLeftOpen className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {t('layout.expandSidebar', { defaultValue: 'Expand sidebar' })}
                  </TooltipContent>
                </Tooltip>
              </div>
            )}

            {/* SSH page – always mounted after first visit, hidden via CSS to preserve xterm buffers */}
            {sshPageEverOpened.current && (
              <div
                className="flex-1 min-w-0 bg-background overflow-hidden"
                style={{ display: sshPageOpen ? undefined : 'none' }}
              >
                <Suspense fallback={<LazyPageFallback />}>
                  <SshPage />
                </Suspense>
              </div>
            )}

            {/* Main content area (hidden when SSH page is active) */}
            {!sshPageOpen && (
              <AnimatePresence mode="wait">
                {tasksPageOpen ? (
                  <PageTransition
                    key="tasks-page"
                    className="flex-1 min-w-0 bg-background overflow-hidden"
                  >
                    <Suspense fallback={<LazyPageFallback />}>
                      <TasksPage />
                    </Suspense>
                  </PageTransition>
                ) : resourcesPageOpen ? (
                  <PageTransition
                    key="resources-page"
                    className="flex-1 min-w-0 bg-background overflow-hidden"
                  >
                    <Suspense fallback={<LazyPageFallback />}>
                      <ResourcesPage />
                    </Suspense>
                  </PageTransition>
                ) : skillsPageOpen ? (
                  <PageTransition
                    key="skills-page"
                    className="flex-1 min-w-0 bg-background overflow-hidden"
                  >
                    <Suspense fallback={<LazyPageFallback />}>
                      <SkillsPage />
                    </Suspense>
                  </PageTransition>
                ) : settingsPageOpen ? (
                  <PageTransition
                    key="settings-page"
                    className="flex-1 min-w-0 bg-background overflow-hidden"
                  >
                    <Suspense fallback={<LazyPageFallback />}>
                      <SettingsPage />
                    </Suspense>
                  </PageTransition>
                ) : drawPageOpen ? (
                  <PageTransition
                    key="draw-page"
                    className="flex-1 min-w-0 bg-background overflow-hidden"
                  >
                    <Suspense fallback={<LazyPageFallback />}>
                      <DrawPage />
                    </Suspense>
                  </PageTransition>
                ) : translatePageOpen ? (
                  <PageTransition
                    key="translate-page"
                    className="flex-1 min-w-0 bg-background overflow-hidden"
                  >
                    <Suspense fallback={<LazyPageFallback />}>
                      <TranslatePage />
                    </Suspense>
                  </PageTransition>
                ) : chatView === 'home' ? (
                  <PageTransition
                    key="chat-home"
                    className="flex flex-1 min-w-0 flex-col overflow-hidden"
                  >
                    <ChatHomePage />
                  </PageTransition>
                ) : chatView === 'project' ? (
                  <PageTransition
                    key="project-home"
                    className="flex flex-1 min-w-0 flex-col overflow-hidden"
                  >
                    <ProjectHomePage />
                  </PageTransition>
                ) : chatView === 'archive' || chatView === 'channels' ? (
                  <PageTransition
                    key={chatView === 'channels' ? 'project-channels' : 'project-archive'}
                    className="flex flex-1 min-w-0 flex-col overflow-hidden"
                  >
                    <ProjectArchivePage />
                  </PageTransition>
                ) : (
                  <PageTransition
                    key="main-layout"
                    className="flex flex-1 min-w-0 flex-col overflow-hidden"
                  >
                    <ErrorBoundary
                      renderFallback={(error, reset) => (
                        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center overflow-hidden">
                          <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
                            <svg
                              className="size-6 text-destructive"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={2}
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
                              />
                            </svg>
                          </div>
                          <div className="space-y-1">
                            <h3 className="text-sm font-semibold text-foreground">
                              {t('layout.somethingWentWrong')}
                            </h3>
                            <p className="max-w-md text-xs text-muted-foreground">
                              {error?.message || t('layout.unexpectedError')}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                              onClick={reset}
                            >
                              {t('layout.tryAgain')}
                            </button>
                            <button
                              className="rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                              onClick={() => window.location.reload()}
                            >
                              {t('layout.reloadApp')}
                            </button>
                            <button
                              className="rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                              onClick={() => {
                                const text = `Error: ${error?.message}\nStack: ${error?.stack}`
                                navigator.clipboard.writeText(text)
                              }}
                            >
                              {t('layout.copyError')}
                            </button>
                          </div>
                          {error?.stack && (
                            <details className="w-full max-w-lg text-left">
                              <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground transition-colors">
                                {t('layout.errorDetails')}
                              </summary>
                              <pre className="mt-1 max-h-32 overflow-auto rounded-md bg-muted p-2 text-[10px] leading-relaxed text-muted-foreground">
                                {error.stack}
                              </pre>
                            </details>
                          )}
                        </div>
                      )}
                    >
                      <div className="flex flex-1 overflow-hidden">
                        {/* Center: Chat Area */}
                        <div className="flex min-w-0 flex-1 flex-col bg-gradient-to-b from-background to-muted/20 relative">
                          {/* Mode selector toolbar */}
                          <div className="flex shrink-0 items-center gap-2 px-3 py-2">
                            {!leftSidebarOpen && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="size-7 shrink-0"
                                    onClick={toggleLeftSidebar}
                                  >
                                    <PanelLeftOpen className="size-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  {t('layout.expandSidebar', { defaultValue: 'Expand sidebar' })}
                                </TooltipContent>
                              </Tooltip>
                            )}
                            <div
                              data-tour="mode-switch"
                              className="flex items-center gap-0.5 rounded-lg border border-border/50 bg-background/95 p-0.5 shadow-md backdrop-blur-sm"
                            >
                              {modes.map((m, i) => (
                                <Tooltip key={m.value}>
                                  <TooltipTrigger asChild>
                                    <Button
                                      data-tour={`mode-${m.value}`}
                                      variant="ghost"
                                      size="sm"
                                      className={cn(
                                        'relative h-6 gap-1.5 overflow-hidden rounded-md px-2.5 text-xs font-medium transition-colors duration-200',
                                        mode === m.value
                                          ? cn(
                                              MODE_SWITCH_ACTIVE_TEXT_CLASS[m.value],
                                              'font-semibold'
                                            )
                                          : 'text-muted-foreground hover:text-foreground'
                                      )}
                                      onClick={() => handleModeChange(m.value)}
                                    >
                                      <AnimatePresence initial={false}>
                                        {mode === m.value && (
                                          <motion.span
                                            layoutId="layout-mode-switch-highlight"
                                            className={cn(
                                              'pointer-events-none absolute inset-0 rounded-md border',
                                              MODE_SWITCH_HIGHLIGHT_CLASS[m.value]
                                            )}
                                            transition={MODE_SWITCH_TRANSITION}
                                          />
                                        )}
                                      </AnimatePresence>
                                      <span className="relative z-10 flex items-center gap-1.5">
                                        {m.icon}
                                        {tCommon(m.labelKey)}
                                      </span>
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent
                                    side="bottom"
                                    align="start"
                                    sideOffset={8}
                                    className="max-w-[340px] rounded-xl px-3 py-3"
                                  >
                                    {renderModeTooltipContent({
                                      mode: m.value,
                                      labelKey: m.labelKey,
                                      icon: m.icon,
                                      shortcutIndex: i,
                                      isActive: mode === m.value,
                                      t,
                                      tCommon
                                    })}
                                  </TooltipContent>
                                </Tooltip>
                              ))}
                            </div>
                            <div className="flex-1" />
                            <div className="flex items-center gap-0.5 rounded-lg border bg-background/80 px-0.5 py-0.5 shadow-sm backdrop-blur-sm">
                              {mode !== 'chat' && activeWorkingFolder && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <button
                                      className="group/btn flex h-6 items-center gap-1 rounded-md px-1.5 text-muted-foreground transition-all duration-200 hover:bg-muted/60 hover:text-foreground"
                                      onClick={() => void handleOpenWorkingFolder()}
                                    >
                                      <ExternalLink className="size-3.5 shrink-0" />
                                      <span
                                        className="max-w-0 overflow-hidden pl-0 text-[10px] whitespace-nowrap opacity-0 group-hover/btn:max-w-[140px] group-hover/btn:pl-1 group-hover/btn:opacity-100"
                                        style={{
                                          transition:
                                            'max-width 220ms cubic-bezier(0.4, 0, 0.2, 1), opacity 160ms ease, padding 180ms ease'
                                        }}
                                      >
                                        {t('layout.openFolder', { defaultValue: 'Open folder' })}
                                      </span>
                                    </button>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    {t('layout.openFolder', { defaultValue: 'Open folder' })}
                                  </TooltipContent>
                                </Tooltip>
                              )}
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    className="group/btn flex h-6 items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-all duration-200 disabled:opacity-50"
                                    onClick={() => void handleExportImage()}
                                    disabled={exporting || isStreaming}
                                  >
                                    {exporting ? (
                                      <Loader2 className="size-3.5 shrink-0 animate-spin" />
                                    ) : (
                                      <ImageDown className="size-3.5 shrink-0" />
                                    )}
                                    <span
                                      className="max-w-0 overflow-hidden pl-0 text-[10px] opacity-0 whitespace-nowrap group-hover/btn:max-w-[140px] group-hover/btn:pl-1 group-hover/btn:opacity-100"
                                      style={{
                                        transition:
                                          'max-width 220ms cubic-bezier(0.4, 0, 0.2, 1), opacity 160ms ease, padding 180ms ease'
                                      }}
                                    >
                                      {exporting
                                        ? t('layout.exporting', { defaultValue: 'Exporting...' })
                                        : t('layout.exportImage', {
                                            defaultValue: 'Copy as image'
                                          })}
                                    </span>
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  {t('layout.exportImage', { defaultValue: 'Copy as image' })}
                                </TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    className="group/btn flex h-6 items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-all duration-200 disabled:opacity-50"
                                    onClick={handleCopyAll}
                                    disabled={isStreaming}
                                  >
                                    {copiedAll ? (
                                      <Check className="size-3.5 shrink-0" />
                                    ) : (
                                      <ClipboardCopy className="size-3.5 shrink-0" />
                                    )}
                                    <span
                                      className="max-w-0 overflow-hidden pl-0 text-[10px] opacity-0 whitespace-nowrap group-hover/btn:max-w-[140px] group-hover/btn:pl-1 group-hover/btn:opacity-100"
                                      style={{
                                        transition:
                                          'max-width 220ms cubic-bezier(0.4, 0, 0.2, 1), opacity 160ms ease, padding 180ms ease'
                                      }}
                                    >
                                      {copiedAll
                                        ? t('layout.copied', { defaultValue: 'Copied' })
                                        : t('layout.copyAll', {
                                            defaultValue: 'Copy conversation'
                                          })}
                                    </span>
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  {t('layout.copyAll', { defaultValue: 'Copy conversation' })}
                                </TooltipContent>
                              </Tooltip>
                            </div>
                          </div>
                          <MessageList
                            onRetry={retryLastMessage}
                            onContinue={continueLastToolExecution}
                            onEditUserMessage={editAndResend}
                            onDeleteMessage={deleteMessage}
                          />
                          <InputArea
                            onSend={(text, images) => void sendMessage(text, images)}
                            onStop={stopStreaming}
                            onSelectFolder={mode !== 'chat' ? handleOpenFolderDialog : undefined}
                            workingFolder={activeWorkingFolder}
                            hideWorkingFolderIndicator
                            isStreaming={isStreaming}
                          />
                          {mode !== 'chat' && (
                            <WorkingFolderSelectorDialog
                              open={folderDialogOpen}
                              onOpenChange={setFolderDialogOpen}
                              workingFolder={activeWorkingFolder}
                              sshConnectionId={activeSessionView.activeSessionSshConnectionId}
                              onSelectLocalFolder={(folderPath) =>
                                updateActiveProjectDirectory({
                                  workingFolder: folderPath,
                                  sshConnectionId: null
                                })
                              }
                              onSelectSshFolder={(folderPath, connectionId) =>
                                updateActiveProjectDirectory({
                                  workingFolder: folderPath,
                                  sshConnectionId: connectionId
                                })
                              }
                            />
                          )}
                        </div>

                        {/* Right: Cowork/Code Panel */}
                        {mode !== 'chat' && <RightPanel />}
                      </div>
                    </ErrorBoundary>
                  </PageTransition>
                )}
              </AnimatePresence>
            )}
          </div>
        </div>
      </div>

      <Dialog
        open={previewPanelOpen && previewPanelState?.source === 'file'}
        onOpenChange={(open) => {
          if (!open) closePreviewPanel()
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="h-[calc(100vh-4rem)] w-[calc(100vw-4rem)] max-w-6xl overflow-hidden p-0 sm:max-w-6xl"
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <DialogHeader className="sr-only">
            <DialogTitle>
              {previewPanelState?.filePath?.split(/[\\/]/).pop() ?? 'File Preview'}
            </DialogTitle>
          </DialogHeader>
          <PreviewPanel embedded />
        </DialogContent>
      </Dialog>

      <Dialog
        open={subAgentExecutionDetailOpen}
        onOpenChange={(open) => {
          if (!open) closeSubAgentExecutionDetail()
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-[1400px] overflow-hidden p-0 sm:max-w-[1400px]"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>
              {t('subAgentsPanel.executionDetailTitle', { defaultValue: '执行详情' })}
            </DialogTitle>
          </DialogHeader>
          <SubAgentExecutionDetail
            toolUseId={subAgentExecutionDetailToolUseId}
            onClose={closeSubAgentExecutionDetail}
          />
        </DialogContent>
      </Dialog>

      <CommandPalette />
      <SettingsDialog />
      <KeyboardShortcutsDialog />
      <ConversationGuideDialog
        open={conversationGuideOpen}
        onOpenChange={setConversationGuideOpen}
      />
      <PermissionDialog
        toolCall={pendingApproval}
        onAllow={() => pendingApproval && resolveApproval(pendingApproval.id, true)}
        onDeny={() => pendingApproval && resolveApproval(pendingApproval.id, false)}
      />
    </TooltipProvider>
  )
}
