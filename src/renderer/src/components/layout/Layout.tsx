import { Suspense, lazy, useCallback, useEffect, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useTheme } from 'next-themes'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { TitleBar } from './TitleBar'
import { WorkspaceSidebar } from './WorkspaceSidebar'
import { RightPanel } from './RightPanel'
import { PreviewPanel } from './PreviewPanel'
import { SubAgentExecutionDetail } from './SubAgentExecutionDetail'
import { RIGHT_PANEL_TAB_ORDER } from './right-panel-defs'
import { SettingsDialog } from '@renderer/components/settings/SettingsDialog'
import { ChatHomePage } from '@renderer/components/chat/ChatHomePage'
import { ProjectHomePage } from '@renderer/components/chat/ProjectHomePage'
import { ProjectArchivePage } from '@renderer/components/chat/ProjectArchivePage'
import { GitPage } from '@renderer/components/chat/GitPage'
import { KeyboardShortcutsDialog } from '@renderer/components/settings/KeyboardShortcutsDialog'
import { PermissionDialog } from '@renderer/components/cowork/PermissionDialog'
import { ConversationGuideDialog } from '@renderer/components/chat/ConversationGuideDialog'
import { CommandPalette } from './CommandPalette'
import { SessionConversationPane } from './SessionConversationPane'
import { ErrorBoundary } from '@renderer/components/error-boundary'
import { useUIStore, type AppMode } from '@renderer/stores/ui-store'
import { useChatStore, type SessionMode } from '@renderer/stores/chat-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useChatActions } from '@renderer/hooks/use-chat-actions'
import { toast } from 'sonner'
import { sessionToMarkdown } from '@renderer/lib/utils/export-chat'
import { AnimatePresence } from 'motion/react'
import { PageTransition, PanelTransition } from '@renderer/components/animate-ui'
import { openSessionOrFocusDetached } from '@renderer/lib/session-window'
import { useShallow } from 'zustand/react/shallow'

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
  const mode = useUIStore((s) => s.mode)
  const setMode = useUIStore((s) => s.setMode)
  const leftSidebarOpen = useUIStore((s) => s.leftSidebarOpen)
  const previewPanelOpen = useUIStore((s) => s.previewPanelOpen)
  const previewPanelState = useUIStore((s) => s.previewPanelState)
  const closePreviewPanel = useUIStore((s) => s.closePreviewPanel)
  const subAgentExecutionDetailOpen = useUIStore((s) => s.subAgentExecutionDetailOpen)
  const subAgentExecutionDetailToolUseId = useUIStore((s) => s.subAgentExecutionDetailToolUseId)
  const subAgentExecutionDetailInlineText = useUIStore((s) => s.subAgentExecutionDetailInlineText)
  const closeSubAgentExecutionDetail = useUIStore((s) => s.closeSubAgentExecutionDetail)
  const toolbarCollapsedByDefault = useSettingsStore((s) => s.toolbarCollapsedByDefault)
  const chatView = useUIStore((s) => s.chatView)
  const activeSessionView = useChatStore(
    useShallow((s) => {
      const activeSession = s.sessions.find((session) => session.id === s.activeSessionId)
      return {
        activeProjectId: activeSession?.projectId ?? s.activeProjectId ?? null,
        activeSessionProjectId: activeSession?.projectId ?? null,
        activeSessionTitle: activeSession?.title ?? null,
        activeSessionMode: activeSession?.mode as SessionMode | undefined
      }
    })
  )
  const { activeProjectId, activeSessionProjectId, activeSessionTitle, activeSessionMode } =
    activeSessionView
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const updateSessionMode = useChatStore((s) => s.updateSessionMode)
  const streamingMessageId = useChatStore((s) => s.streamingMessageId)
  const pendingToolCallCount = useAgentStore((s) => s.pendingToolCalls.length)
  const pendingApproval = useAgentStore((s) => s.pendingToolCalls[0] ?? null)
  const resolveApproval = useAgentStore((s) => s.resolveApproval)
  const initBackgroundProcessTracking = useAgentStore((s) => s.initBackgroundProcessTracking)

  const { resolvedTheme, setTheme: ntSetTheme } = useTheme()
  const { stopStreaming } = useChatActions()

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

  const handleCreateChatSession = useCallback((): void => {
    const store = useChatStore.getState()
    const uiStore = useUIStore.getState()
    store.setActiveSession(null)
    uiStore.setMode('chat')
    uiStore.navigateToHome()
  }, [])

  useEffect(() => {
    void initBackgroundProcessTracking()
  }, [initBackgroundProcessTracking])

  // Update window title (show pending approvals + streaming state + SubAgent)
  useEffect(() => {
    if (shouldUseStaticWindowTitle) {
      document.title = 'OpenCoWork'
      return
    }

    const base = activeSessionTitle ? `${activeSessionTitle} 闂?OpenCoWork` : 'OpenCoWork'
    const prefix =
      pendingToolCallCount > 0
        ? `(${pendingToolCallCount} pending) `
        : runningSubAgentCount > 0
          ? `濡絽鍠氬?${runningSubAgentLabel} | `
          : streamingMessageId
            ? '闂?'
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
    const normalizedSessionMode: AppMode = activeSessionProjectId
      ? activeSessionMode === 'chat'
        ? 'cowork'
        : activeSessionMode
      : 'chat'
    const currentMode = useUIStore.getState().mode
    if (currentMode !== normalizedSessionMode) {
      queueMicrotask(() => {
        if (useUIStore.getState().mode !== normalizedSessionMode) {
          useUIStore.getState().setMode(normalizedSessionMode)
        }
      })
    }
  }, [activeSessionId, activeSessionMode, activeSessionProjectId])

  useEffect(() => {
    if (chatView !== 'session' || !activeSessionId || !activeSessionMode) return

    if (activeSessionProjectId && activeSessionMode === 'chat') {
      updateSessionMode(activeSessionId, 'cowork')
      return
    }

    if (!activeSessionProjectId && activeSessionMode !== 'chat') {
      updateSessionMode(activeSessionId, 'chat')
    }
  }, [activeSessionId, activeSessionMode, activeSessionProjectId, chatView, updateSessionMode])

  useEffect(() => {
    if (chatView === 'session') return

    const nextMode = chatView === 'home' ? 'chat' : mode === 'chat' ? 'cowork' : null

    if (nextMode && mode !== nextMode) {
      setMode(nextMode)
    }
  }, [chatView, mode, setMode])

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
  const tasksPageOpen = useUIStore((s) => s.tasksPageOpen)
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
      // Ctrl+Shift+N: New independent chat session
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'N' || e.key === 'n')) {
        e.preventDefault()
        handleCreateChatSession()
        return
      }
      // Ctrl+1/2/3/4: Switch mode
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault()
        const modeMap = { '1': 'clarify', '2': 'cowork', '3': 'code', '4': 'acp' } as const
        handleModeChange(modeMap[e.key as '1' | '2' | '3' | '4'])
      }
      // Ctrl+N: New independent chat session
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault()
        handleCreateChatSession()
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
        void openSessionOrFocusDetached(sorted[next].id)
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
        const tabs = [...RIGHT_PANEL_TAB_ORDER]
        const idx = tabs.indexOf(ui.rightPanelTab)
        ui.setRightPanelTab(tabs[((idx >= 0 ? idx : 0) + 1) % tabs.length])
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
    handleCreateChatSession,
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

  const showEmbeddedSidebar = leftSidebarOpen

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

            {/* Main content area */}
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
              ) : chatView === 'git' ? (
                <PageTransition
                  key="project-git"
                  className="flex flex-1 min-w-0 flex-col overflow-hidden"
                >
                  <GitPage />
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
                      <SessionConversationPane />
                      <RightPanel />
                    </div>
                  </ErrorBoundary>
                </PageTransition>
              )}
            </AnimatePresence>
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
              {t('subAgentsPanel.executionDetailTitle', { defaultValue: 'Execution details' })}
            </DialogTitle>
          </DialogHeader>
          <SubAgentExecutionDetail
            toolUseId={subAgentExecutionDetailToolUseId}
            inlineText={subAgentExecutionDetailInlineText ?? undefined}
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
