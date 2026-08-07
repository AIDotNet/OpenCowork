import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { TitleBar } from './TitleBar'
import { WorkspaceSidebar } from './WorkspaceSidebar'
import { ChatHomePage } from '@renderer/components/chat/ChatHomePage'
import { ProjectHomePage } from '@renderer/components/chat/ProjectHomePage'
import { KeyboardShortcutsDialog } from '@renderer/components/settings/KeyboardShortcutsDialog'
import { PermissionDialog } from '@renderer/components/cowork/PermissionDialog'
import { ConversationGuideDialog } from '@renderer/components/chat/ConversationGuideDialog'
import { CommandPalette } from './CommandPalette'
import { ErrorBoundary } from '@renderer/components/error-boundary'
import { useUIStore, type AppMode } from '@renderer/stores/ui-store'
import { useChatStore, type SessionMode } from '@renderer/stores/chat-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useAppShortcuts } from '@renderer/hooks/use-app-shortcuts'
import { useChatActions } from '@renderer/hooks/use-chat-actions'
import { AnimatePresence } from 'motion/react'
import { PageTransition, PanelTransition } from '@renderer/components/animate-ui'
import { useShallow } from 'zustand/react/shallow'
import { selectSessionPendingApproval } from '@renderer/lib/agent/session-scoped-agent-state'

const SkillsPage = lazy(async () => {
  const mod = await import('@renderer/components/skills/SkillsPage')
  return { default: mod.SkillsPage }
})

const SoulsPage = lazy(async () => {
  const mod = await import('@renderer/components/souls/SoulsPage')
  return { default: mod.SoulsPage }
})

const SyncPage = lazy(async () => {
  const mod = await import('@renderer/components/sync/SyncPage')
  return { default: mod.SyncPage }
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

const CodeGraphPage = lazy(async () => {
  const mod = await import('@renderer/components/codegraph/CodeGraphPage')
  return { default: mod.CodeGraphPage }
})

const TasksPage = lazy(async () => {
  const mod = await import('../tasks/TasksPage')
  return { default: mod.TasksPage }
})

const TaskBoardPage = lazy(async () => {
  const mod = await import('../taskboard/TaskBoardPage')
  return { default: mod.TaskBoardPage }
})

const SettingsPage = lazy(async () => {
  const mod = await import('@renderer/components/settings/SettingsPage')
  return { default: mod.SettingsPage }
})

const ProjectArchivePage = lazy(async () => {
  const mod = await import('@renderer/components/chat/ProjectArchivePage')
  return { default: mod.ProjectArchivePage }
})

const GitPage = lazy(async () => {
  const mod = await import('@renderer/components/chat/GitPage')
  return { default: mod.GitPage }
})

const SessionConversationPane = lazy(async () => {
  const mod = await import('./SessionConversationPane')
  return { default: mod.SessionConversationPane }
})

const RightPanel = lazy(async () => {
  const mod = await import('./RightPanel')
  return { default: mod.RightPanel }
})

const SubAgentExecutionDetail = lazy(async () => {
  const mod = await import('./SubAgentExecutionDetail')
  return { default: mod.SubAgentExecutionDetail }
})

const MIN_MAIN_WORKSPACE_WIDTH_WITH_SIDEBAR = 720

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
  downloaded: boolean
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
  const leftSidebarWidth = useUIStore((s) => s.leftSidebarWidth)
  const setLeftSidebarOpen = useUIStore((s) => s.setLeftSidebarOpen)
  const rightPanelOpen = useUIStore((s) => s.rightPanelOpen)
  const rightPanelWidth = useUIStore((s) => s.rightPanelWidth)
  const subAgentExecutionDetailOpen = useUIStore((s) => s.subAgentExecutionDetailOpen)
  const subAgentExecutionDetailToolUseId = useUIStore((s) => s.subAgentExecutionDetailToolUseId)
  const subAgentExecutionDetailInlineText = useUIStore((s) => s.subAgentExecutionDetailInlineText)
  const closeSubAgentExecutionDetail = useUIStore((s) => s.closeSubAgentExecutionDetail)
  const chatView = useUIStore((s) => s.chatView)
  const activeSessionView = useChatStore(
    useShallow((s) => {
      const activeSession = s.sessions.find((session) => session.id === s.activeSessionId)
      const explicitActiveProject = s.activeProjectId
        ? (s.projects.find((project) => project.id === s.activeProjectId) ?? null)
        : null
      const fallbackHomeProject =
        explicitActiveProject ??
        s.projects.find((project) => !project.pluginId) ??
        s.projects[0] ??
        null
      const activeProject = explicitActiveProject ?? fallbackHomeProject
      return {
        activeProjectId: activeSession?.projectId ?? s.activeProjectId ?? null,
        activeProjectName: activeProject?.name ?? null,
        activeProjectWorkingFolder: activeProject?.workingFolder ?? null,
        activeSessionProjectId: activeSession?.projectId ?? null,
        activeSessionTitle: activeSession?.title ?? null,
        activeSessionMode: activeSession?.mode as SessionMode | undefined
      }
    })
  )
  const {
    activeProjectId,
    activeProjectName,
    activeProjectWorkingFolder,
    activeSessionProjectId,
    activeSessionTitle,
    activeSessionMode
  } = activeSessionView
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const updateSessionMode = useChatStore((s) => s.updateSessionMode)
  const streamingMessageId = useChatStore((s) => s.streamingMessageId)
  const { pendingApproval, pendingApprovalCount: pendingToolCallCount } = useAgentStore(
    useShallow((s) => selectSessionPendingApproval(s, activeSessionId))
  )
  const resolveApproval = useAgentStore((s) => s.resolveApproval)
  const initBackgroundProcessTracking = useAgentStore((s) => s.initBackgroundProcessTracking)

  // Not for its return value: this keeps the module-level send hook and the
  // background→foreground message flush wired up for the workspace window.
  useChatActions()
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth
  )
  const autoCollapsedSidebarForCrowdingRef = useRef(false)

  const runningSubAgentNamesSig = useAgentStore((s) => s.runningSubAgentNamesSig)
  const runningSubAgentCount = runningSubAgentNamesSig
    ? runningSubAgentNamesSig.split('\u0000').length
    : 0
  const runningSubAgentLabel = runningSubAgentNamesSig
    ? runningSubAgentNamesSig.split('\u0000').join(', ')
    : ''

  const shouldUseStaticWindowTitle = import.meta.env.MODE === 'test' || navigator.webdriver

  useEffect(() => {
    void initBackgroundProcessTracking()
  }, [initBackgroundProcessTracking])

  useEffect(() => {
    const handleResize = (): void => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', handleResize)
    handleResize()
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    const rightSideWidth = rightPanelOpen ? rightPanelWidth : 0
    const widthLeftForMainWorkspace =
      viewportWidth - rightSideWidth - (leftSidebarOpen ? leftSidebarWidth : 0)
    const mainWorkspaceTooNarrow =
      rightPanelOpen && widthLeftForMainWorkspace < MIN_MAIN_WORKSPACE_WIDTH_WITH_SIDEBAR
    const shouldCollapseSidebar =
      chatView === 'session' && leftSidebarOpen && mainWorkspaceTooNarrow

    if (!shouldCollapseSidebar) {
      if (!rightPanelOpen) {
        autoCollapsedSidebarForCrowdingRef.current = false
      }
      return
    }

    if (autoCollapsedSidebarForCrowdingRef.current) return
    autoCollapsedSidebarForCrowdingRef.current = true
    setLeftSidebarOpen(false)
  }, [
    chatView,
    leftSidebarOpen,
    leftSidebarWidth,
    rightPanelOpen,
    rightPanelWidth,
    setLeftSidebarOpen,
    viewportWidth
  ])

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

    const nextMode = chatView !== 'home' && mode === 'chat' ? 'cowork' : null

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

  const settingsPageOpen = useUIStore((s) => s.settingsPageOpen)
  const conversationGuideOpen = useUIStore((s) => s.conversationGuideOpen)
  const setConversationGuideOpen = useUIStore((s) => s.setConversationGuideOpen)
  const skillsPageOpen = useUIStore((s) => s.skillsPageOpen)
  const soulsPageOpen = useUIStore((s) => s.soulsPageOpen)
  const syncPageOpen = useUIStore((s) => s.syncPageOpen)
  const resourcesPageOpen = useUIStore((s) => s.resourcesPageOpen)
  const drawPageOpen = useUIStore((s) => s.drawPageOpen)
  const codeGraphPageOpen = useUIStore((s) => s.codeGraphPageOpen)
  const translatePageOpen = useUIStore((s) => s.translatePageOpen)
  const tasksPageOpen = useUIStore((s) => s.tasksPageOpen)
  const taskBoardPageOpen = useUIStore((s) => s.taskBoardPageOpen)
  const contentHeader = useMemo(() => {
    if (tasksPageOpen) {
      return { title: t('navRail.tasks', { defaultValue: 'Tasks' }), subtitle: null }
    }
    if (taskBoardPageOpen) {
      return { title: t('navRail.taskBoard', { defaultValue: 'Task Board' }), subtitle: null }
    }
    if (resourcesPageOpen) {
      return { title: t('navRail.resources', { defaultValue: 'Resources' }), subtitle: null }
    }
    if (skillsPageOpen) {
      return { title: t('navRail.skills', { defaultValue: 'Tools' }), subtitle: null }
    }
    if (soulsPageOpen) {
      return { title: t('navRail.souls', { defaultValue: 'SOUL' }), subtitle: null }
    }
    if (syncPageOpen) {
      return { title: t('navRail.sync', { defaultValue: 'Sync' }), subtitle: null }
    }
    if (settingsPageOpen) {
      return { title: t('navRail.settings', { defaultValue: 'Settings' }), subtitle: null }
    }
    if (drawPageOpen) {
      return { title: t('navRail.draw', { defaultValue: 'Drawing' }), subtitle: null }
    }
    if (codeGraphPageOpen) {
      return { title: t('navRail.codegraph', { defaultValue: 'CodeGraph' }), subtitle: null }
    }
    if (translatePageOpen) {
      return { title: t('navRail.translate', { defaultValue: 'Translate' }), subtitle: null }
    }
    if (chatView === 'project') {
      return {
        title: activeProjectName ?? t('sidebar.projects', { defaultValue: 'Projects' }),
        subtitle: null,
        tooltip: activeProjectWorkingFolder
      }
    }
    if (chatView === 'archive') {
      return {
        title: t('sidebar.projectArchive', { defaultValue: 'Project archive' }),
        subtitle: null,
        tooltip: activeProjectWorkingFolder
      }
    }
    if (chatView === 'channels') {
      return {
        title: t('sidebar.projectChannels', { defaultValue: 'Channels' }),
        subtitle: null,
        tooltip: activeProjectWorkingFolder
      }
    }
    if (chatView === 'git') {
      return {
        title: t('sidebar.projectGit', { defaultValue: 'Git' }),
        subtitle: null,
        tooltip: activeProjectWorkingFolder
      }
    }
    if (chatView === 'session') {
      return {
        title: '',
        subtitle: null,
        tooltip: null
      }
    }
    return {
      title: t('sidebar.newChat', { defaultValue: 'New Chat' }),
      subtitle: null,
      tooltip: mode !== 'chat' ? activeProjectWorkingFolder : null
    }
  }, [
    activeProjectName,
    activeProjectWorkingFolder,
    chatView,
    codeGraphPageOpen,
    drawPageOpen,
    mode,
    resourcesPageOpen,
    settingsPageOpen,
    skillsPageOpen,
    soulsPageOpen,
    syncPageOpen,
    t,
    tasksPageOpen,
    taskBoardPageOpen,
    translatePageOpen
  ])

  useAppShortcuts()

  const showEmbeddedSidebar = leftSidebarOpen && !settingsPageOpen
  const mainContent = settingsPageOpen ? (
    <div className="h-screen overflow-hidden bg-background">
      <PageTransition key="settings-page-shell" className="h-full min-h-0 w-full overflow-hidden">
        <Suspense fallback={<LazyPageFallback />}>
          <SettingsPage />
        </Suspense>
      </PageTransition>
    </div>
  ) : (
    <div className="flex h-screen overflow-hidden bg-background">
      <AnimatePresence>
        {showEmbeddedSidebar && (
          <PanelTransition side="left" disabled={false} className="z-10 h-full shrink-0">
            <WorkspaceSidebar />
          </PanelTransition>
        )}
      </AnimatePresence>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <TitleBar
          updateInfo={updateInfo}
          onOpenUpdateDialog={onOpenUpdateDialog}
          title={contentHeader.title}
          subtitle={contentHeader.subtitle}
          tooltip={contentHeader.tooltip}
          showSidebarToggle={!showEmbeddedSidebar}
          insetForMacTrafficLights={!showEmbeddedSidebar}
        />

        <div className="flex min-h-0 flex-1 overflow-hidden">
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
            ) : taskBoardPageOpen ? (
              <PageTransition
                key="taskboard-page"
                className="flex-1 min-w-0 bg-background overflow-hidden"
              >
                <Suspense fallback={<LazyPageFallback />}>
                  <TaskBoardPage />
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
            ) : soulsPageOpen ? (
              <PageTransition
                key="souls-page"
                className="flex-1 min-w-0 bg-background overflow-hidden"
              >
                <Suspense fallback={<LazyPageFallback />}>
                  <SoulsPage />
                </Suspense>
              </PageTransition>
            ) : syncPageOpen ? (
              <PageTransition
                key="sync-page"
                className="flex-1 min-w-0 bg-background overflow-hidden"
              >
                <Suspense fallback={<LazyPageFallback />}>
                  <SyncPage />
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
            ) : codeGraphPageOpen ? (
              <PageTransition
                key="codegraph-page"
                className="flex-1 min-w-0 bg-background overflow-hidden"
              >
                <Suspense fallback={<LazyPageFallback />}>
                  <CodeGraphPage />
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
                <Suspense fallback={<LazyPageFallback />}>
                  <ProjectArchivePage />
                </Suspense>
              </PageTransition>
            ) : chatView === 'git' ? (
              <PageTransition
                key="project-git"
                className="flex flex-1 min-w-0 flex-col overflow-hidden"
              >
                <Suspense fallback={<LazyPageFallback />}>
                  <GitPage />
                </Suspense>
              </PageTransition>
            ) : (
              <PageTransition
                key="main-layout"
                className="flex flex-1 min-w-0 flex-col overflow-hidden"
              >
                <ErrorBoundary
                  renderFallback={(error, reset) => (
                    <div className="flex flex-1 flex-col items-center justify-center gap-4 overflow-hidden p-8 text-center">
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
                          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                          onClick={reset}
                        >
                          {t('layout.tryAgain')}
                        </button>
                        <button
                          className="rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          onClick={() => window.location.reload()}
                        >
                          {t('layout.reloadApp')}
                        </button>
                        <button
                          className="rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
                          <summary className="cursor-pointer text-[10px] text-muted-foreground transition-colors hover:text-foreground">
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
                  <Suspense fallback={<LazyPageFallback />}>
                    <div className="flex flex-1 overflow-hidden">
                      <SessionConversationPane windowHeaderOwnsTitle />
                      <RightPanel />
                    </div>
                  </Suspense>
                </ErrorBoundary>
              </PageTransition>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )

  return (
    <TooltipProvider delayDuration={0}>
      {mainContent}

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
          <Suspense fallback={<LazyPageFallback />}>
            <SubAgentExecutionDetail
              toolUseId={subAgentExecutionDetailToolUseId}
              inlineText={subAgentExecutionDetailInlineText ?? undefined}
              onClose={closeSubAgentExecutionDetail}
            />
          </Suspense>
        </DialogContent>
      </Dialog>

      <CommandPalette />
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
