import { Suspense, lazy, useCallback, useEffect } from 'react'
import {
  FolderOpen,
  HelpCircle,
  ListChecks,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  SquareTerminal
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { ConversationGuideDialog } from '@renderer/components/chat/ConversationGuideDialog'
import { PermissionDialog } from '@renderer/components/cowork/PermissionDialog'
import { KeyboardShortcutsDialog } from '@renderer/components/settings/KeyboardShortcutsDialog'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider
} from '@renderer/components/ui/tooltip'
import { useAppShortcuts } from '@renderer/hooks/use-app-shortcuts'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useChatStore, type SessionMode } from '@renderer/stores/chat-store'
import { useUIStore, type AppMode } from '@renderer/stores/ui-store'
import { cn } from '@renderer/lib/utils'
import { SessionConversationPane } from './SessionConversationPane'
import { TitlebarModeSwitch } from './TitlebarModeSwitch'
import { WindowControls } from './WindowControls'
import { RightPanel } from './RightPanel'
import { setSessionForegroundVisibility } from '@renderer/lib/agent/session-runtime-router'
import { agentStream } from '@renderer/lib/ipc/agent-stream-receiver'
import { selectSessionPendingApproval } from '@renderer/lib/agent/session-scoped-agent-state'

const SubAgentExecutionDetail = lazy(async () => {
  const mod = await import('./SubAgentExecutionDetail')
  return { default: mod.SubAgentExecutionDetail }
})

interface DetachedSessionPageProps {
  sessionId: string
}

const TOOL_BUTTON_CLASS =
  'workspace-titlebar-toolbutton titlebar-no-drag inline-flex size-[30px] items-center justify-center rounded-[11px] transition-all'

export function DetachedSessionPage({ sessionId }: DetachedSessionPageProps): React.JSX.Element {
  const { t } = useTranslation('layout')
  const sessionView = useChatStore(
    useShallow((state) => {
      const session = state.sessions.find((item) => item.id === sessionId)
      const project = session?.projectId
        ? state.projects.find((item) => item.id === session.projectId)
        : undefined

      return {
        projectId: session?.projectId ?? null,
        projectName: session?.projectId ? (project?.name ?? null) : null,
        title: session?.title ?? null,
        workingFolder: session?.workingFolder ?? project?.workingFolder ?? null,
        sshConnectionId: session?.sshConnectionId ?? project?.sshConnectionId ?? null,
        mode: session?.mode as SessionMode | undefined
      }
    })
  )
  const isStreaming = useChatStore((state) => Boolean(state.streamingMessages[sessionId]))
  const updateSessionMode = useChatStore((state) => state.updateSessionMode)
  const { pendingApproval, pendingApprovalCount } = useAgentStore(
    useShallow((state) => selectSessionPendingApproval(state, sessionId))
  )
  const resolveApproval = useAgentStore((state) => state.resolveApproval)
  const initBackgroundProcessTracking = useAgentStore(
    (state) => state.initBackgroundProcessTracking
  )

  const mode = useUIStore((state) => state.mode)
  const rightPanelOpen = useUIStore((state) => state.rightPanelOpen)
  const rightPanelActiveTabKind = useUIStore(
    (state) =>
      state.rightPanelTabs.find((tab) => tab.id === state.rightPanelActiveTabId)?.kind ?? null
  )
  const runtimeStatusPanelOpen = useUIStore((state) => state.runtimeStatusPanelOpen)
  const toggleRuntimeStatusPanel = useUIStore((state) => state.toggleRuntimeStatusPanel)
  const terminalDockOpen = useUIStore((state) =>
    sessionView.projectId
      ? Boolean(state.bottomTerminalDockOpenByProjectId[sessionView.projectId])
      : false
  )
  const setBottomTerminalDockOpen = useUIStore((state) => state.setBottomTerminalDockOpen)
  const setRightPanelOpen = useUIStore((state) => state.setRightPanelOpen)
  const toggleRightPanel = useUIStore((state) => state.toggleRightPanel)
  const openFilesTab = useUIStore((state) => state.openFilesTab)
  const conversationGuideOpen = useUIStore((state) => state.conversationGuideOpen)
  const setConversationGuideOpen = useUIStore((state) => state.setConversationGuideOpen)
  const subAgentExecutionDetailOpen = useUIStore((state) => state.subAgentExecutionDetailOpen)
  const subAgentExecutionDetailToolUseId = useUIStore(
    (state) => state.subAgentExecutionDetailToolUseId
  )
  const subAgentExecutionDetailInlineText = useUIStore(
    (state) => state.subAgentExecutionDetailInlineText
  )
  const closeSubAgentExecutionDetail = useUIStore((state) => state.closeSubAgentExecutionDetail)

  const isMac = /Mac/.test(navigator.userAgent)
  const fileManagerOpen = rightPanelOpen && rightPanelActiveTabKind === 'files'
  const canOpenTerminal = Boolean(sessionView.workingFolder || sessionView.sshConnectionId)

  useAppShortcuts({ detachedSessionId: sessionId })

  useEffect(() => {
    void initBackgroundProcessTracking()
  }, [initBackgroundProcessTracking])

  useEffect(() => {
    const base = sessionView.title ? `${sessionView.title} — OpenCoWork` : 'OpenCoWork'
    const prefix =
      pendingApprovalCount > 0 ? `(${pendingApprovalCount} pending) ` : isStreaming ? '⏳ ' : ''
    document.title = `${prefix}${base}`
  }, [isStreaming, pendingApprovalCount, sessionView.title])

  useEffect(() => {
    setSessionForegroundVisibility(sessionId, true)
    agentStream.notifySessionVisibility(sessionId, true)
    return () => {
      setSessionForegroundVisibility(sessionId, false)
      agentStream.notifySessionVisibility(sessionId, false)
    }
  }, [sessionId])

  // Mirror the session's mode into this window's UI store — the workspace window
  // does the same, but its Layout never mounts here.
  useEffect(() => {
    if (!sessionView.mode) return
    const normalizedSessionMode: AppMode = sessionView.projectId
      ? sessionView.mode === 'chat'
        ? 'cowork'
        : sessionView.mode
      : 'chat'
    if (useUIStore.getState().mode === normalizedSessionMode) return
    queueMicrotask(() => {
      if (useUIStore.getState().mode !== normalizedSessionMode) {
        useUIStore.getState().setMode(normalizedSessionMode)
      }
    })
  }, [sessionId, sessionView.mode, sessionView.projectId])

  useEffect(() => {
    if (!sessionView.mode) return
    if (sessionView.projectId && sessionView.mode === 'chat') {
      updateSessionMode(sessionId, 'cowork')
      return
    }
    if (!sessionView.projectId && sessionView.mode !== 'chat') {
      updateSessionMode(sessionId, 'chat')
    }
  }, [sessionId, sessionView.mode, sessionView.projectId, updateSessionMode])

  const handleModeChange = useCallback(
    (nextMode: AppMode): void => {
      useUIStore.getState().setMode(nextMode)
      updateSessionMode(sessionId, nextMode)
    },
    [sessionId, updateSessionMode]
  )

  const handleToggleFileManager = useCallback((): void => {
    if (!sessionView.workingFolder) return
    if (fileManagerOpen) {
      setRightPanelOpen(false)
      return
    }
    openFilesTab('files', sessionId, sessionView.projectId)
  }, [
    fileManagerOpen,
    openFilesTab,
    sessionId,
    sessionView.projectId,
    sessionView.workingFolder,
    setRightPanelOpen
  ])

  const handleToggleTerminal = useCallback((): void => {
    if (!sessionView.projectId || !canOpenTerminal) return
    setBottomTerminalDockOpen(sessionView.projectId, !terminalDockOpen)
  }, [canOpenTerminal, sessionView.projectId, setBottomTerminalDockOpen, terminalDockOpen])

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex h-screen flex-col overflow-hidden bg-background">
        <header
          className={cn(
            'titlebar-drag relative flex h-10 shrink-0 items-center gap-3 bg-background/85 px-3 backdrop-blur-md',
            isMac ? 'pl-[78px]' : 'pr-[132px]'
          )}
          style={{ paddingRight: isMac ? undefined : 'calc(132px + 0.75rem)' }}
        >
          <TitlebarModeSwitch
            mode={mode}
            projectScoped={Boolean(sessionView.projectId)}
            disabled={isStreaming}
            onSelect={handleModeChange}
          />

          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="min-w-0 truncate text-sm font-medium text-foreground/85">
              {sessionView.title ?? t('sidebar.newChat', { defaultValue: 'New chat' })}
            </div>
            {sessionView.projectId ? (
              <div className="flex min-w-0 max-w-[38%] shrink items-center gap-1.5 text-[11px] text-muted-foreground/65">
                <span className="shrink-0 text-muted-foreground/35">/</span>
                {sessionView.workingFolder ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-default truncate">
                        {sessionView.projectName ??
                          t('sidebar.projects', { defaultValue: 'Project' })}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{sessionView.workingFolder}</TooltipContent>
                  </Tooltip>
                ) : (
                  <span className="truncate">
                    {sessionView.projectName ?? t('sidebar.projects', { defaultValue: 'Project' })}
                  </span>
                )}
              </div>
            ) : null}
          </div>

          <div className="titlebar-no-drag flex shrink-0 items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-pressed={runtimeStatusPanelOpen}
                  data-active={runtimeStatusPanelOpen ? 'true' : 'false'}
                  className={TOOL_BUTTON_CLASS}
                  onClick={toggleRuntimeStatusPanel}
                >
                  <ListChecks className="size-[14px]" />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {runtimeStatusPanelOpen
                  ? t('topbar.closeRuntimeStatus')
                  : t('topbar.openRuntimeStatus')}
              </TooltipContent>
            </Tooltip>

            {sessionView.projectId ? (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-pressed={terminalDockOpen}
                      data-active={terminalDockOpen ? 'true' : 'false'}
                      aria-disabled={!canOpenTerminal}
                      className={cn(
                        TOOL_BUTTON_CLASS,
                        !canOpenTerminal && 'cursor-not-allowed opacity-40 hover:bg-transparent'
                      )}
                      onClick={handleToggleTerminal}
                    >
                      <SquareTerminal className="size-[14px]" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {canOpenTerminal
                      ? terminalDockOpen
                        ? t('topbar.closeProjectTerminal')
                        : t('topbar.openProjectTerminal')
                      : t('topbar.projectTerminalUnavailable')}
                  </TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-pressed={fileManagerOpen}
                      data-active={fileManagerOpen ? 'true' : 'false'}
                      aria-disabled={!sessionView.workingFolder}
                      className={cn(
                        TOOL_BUTTON_CLASS,
                        !sessionView.workingFolder &&
                          'cursor-not-allowed opacity-40 hover:bg-transparent'
                      )}
                      onClick={handleToggleFileManager}
                    >
                      <FolderOpen className="size-[14px]" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {sessionView.workingFolder
                      ? fileManagerOpen
                        ? t('topbar.closeFileManager')
                        : t('topbar.openFileManager')
                      : t('topbar.fileManagerUnavailable')}
                  </TooltipContent>
                </Tooltip>
              </>
            ) : null}

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-pressed={rightPanelOpen}
                  data-active={rightPanelOpen ? 'true' : 'false'}
                  className={TOOL_BUTTON_CLASS}
                  onClick={toggleRightPanel}
                >
                  {rightPanelOpen ? (
                    <PanelRightClose className="size-[14px]" />
                  ) : (
                    <PanelRightOpen className="size-[14px]" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {rightPanelOpen ? t('topbar.closeInspector') : t('topbar.openInspector')}
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="workspace-titlebar-action titlebar-no-drag size-7 rounded-md text-muted-foreground hover:text-foreground"
                  onClick={() => setConversationGuideOpen(true)}
                >
                  <HelpCircle className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('topbar.help')}</TooltipContent>
            </Tooltip>
          </div>

          {!isMac ? (
            <div className="absolute right-0 top-0 z-10">
              <WindowControls />
            </div>
          ) : null}
        </header>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <SessionConversationPane
            sessionId={sessionId}
            allowOpenInNewWindow={false}
            windowHeaderOwnsTitle
          />
          <RightPanel sessionId={sessionId} />
        </div>

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
            <Suspense
              fallback={
                <div className="flex h-full w-full items-center justify-center">
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                </div>
              }
            >
              <SubAgentExecutionDetail
                toolUseId={subAgentExecutionDetailToolUseId}
                inlineText={subAgentExecutionDetailInlineText ?? undefined}
                onClose={closeSubAgentExecutionDetail}
              />
            </Suspense>
          </DialogContent>
        </Dialog>

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
      </div>
    </TooltipProvider>
  )
}
