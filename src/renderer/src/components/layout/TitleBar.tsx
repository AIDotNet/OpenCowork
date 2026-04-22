import {
  Download,
  FolderOpen,
  HelpCircle,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  SquareTerminal,
  ShieldCheck
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useChatStore } from '@renderer/stores/chat-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { ensureProjectTerminalReady } from '@renderer/lib/terminal/project-terminal-context'
import { cn } from '@renderer/lib/utils'
import { PendingInboxPopover } from './PendingInboxPopover'
import { WindowControls } from './WindowControls'

interface TitleBarUpdateInfo {
  newVersion: string
  downloading: boolean
  downloadProgress: number | null
}

interface TitleBarProps {
  updateInfo: TitleBarUpdateInfo | null
  onOpenUpdateDialog: () => void
  title: string
  subtitle?: string | null
  showSidebarToggle?: boolean
  insetForMacTrafficLights?: boolean
}

export function TitleBar({
  updateInfo,
  onOpenUpdateDialog,
  title,
  subtitle = null,
  showSidebarToggle = true,
  insetForMacTrafficLights = false
}: TitleBarProps): React.JSX.Element {
  const { t } = useTranslation('layout')
  const { t: tCommon } = useTranslation('common')
  const isMac = /Mac/.test(navigator.userAgent)

  const leftSidebarOpen = useUIStore((s) => s.leftSidebarOpen)
  const toggleLeftSidebar = useUIStore((s) => s.toggleLeftSidebar)
  const rightPanelOpen = useUIStore((s) => s.rightPanelOpen)
  const toggleRightPanel = useUIStore((s) => s.toggleRightPanel)
  const workingFolderSheetOpen = useUIStore((s) => s.workingFolderSheetOpen)
  const toggleWorkingFolderSheet = useUIStore((s) => s.toggleWorkingFolderSheet)
  const setBottomTerminalDockOpen = useUIStore((s) => s.setBottomTerminalDockOpen)
  const chatView = useUIStore((s) => s.chatView)
  const mode = useUIStore((s) => s.mode)
  const settingsPageOpen = useUIStore((s) => s.settingsPageOpen)
  const skillsPageOpen = useUIStore((s) => s.skillsPageOpen)
  const resourcesPageOpen = useUIStore((s) => s.resourcesPageOpen)
  const drawPageOpen = useUIStore((s) => s.drawPageOpen)
  const translatePageOpen = useUIStore((s) => s.translatePageOpen)
  const tasksPageOpen = useUIStore((s) => s.tasksPageOpen)
  const sessionContext = useChatStore(
    useShallow((state) => {
      const activeSession = state.activeSessionId
        ? state.sessions.find((session) => session.id === state.activeSessionId)
        : null
      const activeSessionProject = activeSession?.projectId
        ? (state.projects.find((project) => project.id === activeSession.projectId) ?? null)
        : null
      const explicitActiveProject = state.activeProjectId
        ? (state.projects.find((project) => project.id === state.activeProjectId) ?? null)
        : null
      const fallbackHomeProject =
        explicitActiveProject ??
        state.projects.find((project) => !project.pluginId) ??
        state.projects[0] ??
        null
      const currentProject =
        chatView === 'session'
          ? activeSessionProject
          : chatView === 'project' || (chatView === 'home' && mode !== 'chat')
            ? fallbackHomeProject
            : null

      return {
        sessionWorkingFolder:
          activeSession?.workingFolder ?? activeSessionProject?.workingFolder ?? null,
        terminalProjectId: currentProject?.id ?? null,
        terminalProjectName: currentProject?.name ?? null,
        terminalWorkingFolder:
          chatView === 'session'
            ? (activeSession?.workingFolder ?? activeSessionProject?.workingFolder ?? null)
            : (currentProject?.workingFolder ?? null),
        terminalSshConnectionId:
          chatView === 'session'
            ? (activeSession?.sshConnectionId ?? activeSessionProject?.sshConnectionId ?? null)
            : (currentProject?.sshConnectionId ?? null)
      }
    })
  )
  const terminalDockOpen = useUIStore((s) =>
    sessionContext.terminalProjectId
      ? Boolean(s.bottomTerminalDockOpenByProjectId[sessionContext.terminalProjectId])
      : false
  )

  const autoApprove = useSettingsStore((s) => s.autoApprove)

  const chatSurfaceActive =
    !settingsPageOpen &&
    !skillsPageOpen &&
    !resourcesPageOpen &&
    !drawPageOpen &&
    !translatePageOpen &&
    !tasksPageOpen
  const showInspectorToggle = chatSurfaceActive && chatView === 'session'
  const showFileManagerToggle = chatSurfaceActive && chatView === 'session'
  const canOpenFileManager = Boolean(sessionContext.sessionWorkingFolder)
  const showProjectTerminalToggle =
    chatSurfaceActive &&
    Boolean(sessionContext.terminalProjectId) &&
    (chatView === 'project' || chatView === 'session' || (chatView === 'home' && mode !== 'chat'))
  const canOpenProjectTerminal = Boolean(
    sessionContext.terminalWorkingFolder || sessionContext.terminalSshConnectionId
  )
  const showProjectToolGroup =
    showProjectTerminalToggle || showFileManagerToggle || showInspectorToggle
  const projectToolButtonClass =
    'workspace-titlebar-toolbutton titlebar-no-drag inline-flex size-[30px] items-center justify-center rounded-[11px] transition-all'

  const handleToggleProjectTerminal = async (): Promise<void> => {
    if (!sessionContext.terminalProjectId || !canOpenProjectTerminal) return

    if (terminalDockOpen) {
      setBottomTerminalDockOpen(sessionContext.terminalProjectId, false)
      return
    }

    setBottomTerminalDockOpen(sessionContext.terminalProjectId, true)
    await ensureProjectTerminalReady({
      projectName: sessionContext.terminalProjectName,
      workingFolder: sessionContext.terminalWorkingFolder,
      sshConnectionId: sessionContext.terminalSshConnectionId
    })
  }

  const handleToggleAutoApprove = async (): Promise<void> => {
    if (!autoApprove) {
      const ok = await confirm({ title: t('autoApproveConfirm') })
      if (!ok) return
    }

    useSettingsStore.getState().updateSettings({ autoApprove: !autoApprove })
    toast.success(t(autoApprove ? 'autoApproveOff' : 'autoApproveOn'))
  }

  return (
    <header
      className={cn(
        'workspace-titlebar-surface titlebar-drag relative flex h-10 w-full shrink-0 items-center gap-3 overflow-hidden px-3',
        isMac && insetForMacTrafficLights ? 'pl-[78px]' : '',
        !isMac ? 'pr-[132px]' : ''
      )}
      style={{
        paddingRight: isMac ? undefined : 'calc(132px + 0.75rem)'
      }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {showSidebarToggle ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="workspace-titlebar-action titlebar-no-drag size-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
                onClick={toggleLeftSidebar}
              >
                {leftSidebarOpen ? (
                  <PanelLeftClose className="size-4" />
                ) : (
                  <PanelLeftOpen className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {t('commandPalette.toggleSidebar', { defaultValue: 'Toggle sidebar' })}
            </TooltipContent>
          </Tooltip>
        ) : null}

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <div className="truncate text-sm font-semibold text-foreground/92">{title}</div>
            {subtitle ? (
              <>
                <span className="shrink-0 text-muted-foreground/35">/</span>
                <div className="truncate text-xs text-muted-foreground/72">{subtitle}</div>
              </>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex min-w-0 shrink items-center justify-end gap-1 overflow-hidden pr-1">
        {updateInfo && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="titlebar-no-drag hidden h-7 max-w-[min(16rem,24vw)] shrink overflow-hidden border-amber-500/30 bg-amber-500/10 px-2 text-[10px] text-amber-600 hover:bg-amber-500/15 dark:text-amber-400 xl:inline-flex"
                onClick={onOpenUpdateDialog}
              >
                <span className="shrink-0">
                  {updateInfo.downloading ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Download className="size-3.5" />
                  )}
                </span>
                <span className="truncate">
                  {updateInfo.downloading
                    ? typeof updateInfo.downloadProgress === 'number'
                      ? tCommon('app.update.downloadingShort', {
                          progress: Math.round(updateInfo.downloadProgress)
                        })
                      : tCommon('app.update.downloading')
                    : tCommon('app.update.buttonLabel', { version: updateInfo.newVersion })}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{tCommon('app.update.buttonTooltip')}</TooltipContent>
          </Tooltip>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-pressed={autoApprove}
              aria-label={autoApprove ? t('topbar.autoApproveOn') : t('topbar.autoApproveOff')}
              className={cn(
                'titlebar-no-drag size-7 rounded-md transition-colors',
                autoApprove
                  ? 'bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/15 dark:text-emerald-400'
                  : 'workspace-titlebar-action text-muted-foreground hover:text-accent-foreground'
              )}
              onClick={() => void handleToggleAutoApprove()}
            >
              <ShieldCheck className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {autoApprove ? t('topbar.autoApproveOn') : t('topbar.autoApproveOff')}
          </TooltipContent>
        </Tooltip>

        <PendingInboxPopover />

        {showProjectToolGroup && (
          <div className="workspace-titlebar-toolgroup titlebar-no-drag flex items-center gap-0.5 rounded-[14px] border p-0.5">
            {showProjectTerminalToggle && sessionContext.terminalProjectId && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-pressed={terminalDockOpen}
                    data-active={terminalDockOpen ? 'true' : 'false'}
                    aria-disabled={!canOpenProjectTerminal}
                    className={cn(
                      projectToolButtonClass,
                      !canOpenProjectTerminal &&
                        'cursor-not-allowed opacity-40 hover:bg-transparent'
                    )}
                    onClick={() => {
                      void handleToggleProjectTerminal()
                    }}
                  >
                    <SquareTerminal className="size-[14px]" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {canOpenProjectTerminal
                    ? terminalDockOpen
                      ? t('topbar.closeProjectTerminal')
                      : t('topbar.openProjectTerminal')
                    : t('topbar.projectTerminalUnavailable')}
                </TooltipContent>
              </Tooltip>
            )}

            {showFileManagerToggle && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-pressed={workingFolderSheetOpen}
                    data-active={workingFolderSheetOpen ? 'true' : 'false'}
                    aria-disabled={!canOpenFileManager}
                    className={cn(
                      projectToolButtonClass,
                      !canOpenFileManager && 'cursor-not-allowed opacity-40 hover:bg-transparent'
                    )}
                    onClick={() => {
                      if (!canOpenFileManager) return
                      toggleWorkingFolderSheet()
                    }}
                  >
                    <FolderOpen className="size-[14px]" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {canOpenFileManager
                    ? workingFolderSheetOpen
                      ? t('topbar.closeFileManager', { defaultValue: 'Close file manager' })
                      : t('topbar.openFileManager', { defaultValue: 'Open file manager' })
                    : t('topbar.fileManagerUnavailable', {
                        defaultValue: 'Select a working folder to open the file manager'
                      })}
                </TooltipContent>
              </Tooltip>
            )}

            {showInspectorToggle && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-pressed={rightPanelOpen}
                    data-active={rightPanelOpen ? 'true' : 'false'}
                    className={projectToolButtonClass}
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
                  {rightPanelOpen
                    ? t('topbar.closeInspector', { defaultValue: 'Close inspector' })
                    : t('topbar.openInspector', { defaultValue: 'Open inspector' })}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="workspace-titlebar-action titlebar-no-drag inline-flex size-7 items-center justify-center rounded-md transition-all"
              onClick={() => useUIStore.getState().setConversationGuideOpen(true)}
            >
              <HelpCircle className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('topbar.help', { defaultValue: 'Open guide' })}</TooltipContent>
        </Tooltip>
      </div>

      {!isMac && (
        <div className="absolute right-0 top-0 z-10">
          <WindowControls />
        </div>
      )}
    </header>
  )
}
