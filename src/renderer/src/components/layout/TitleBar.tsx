import {
  Briefcase,
  Check,
  ChevronDown,
  CircleHelp,
  Code2,
  Download,
  FolderOpen,
  HelpCircle,
  ListChecks,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Send,
  SquareTerminal,
  ShieldCheck
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useChatStore } from '@renderer/stores/chat-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useUIStore, type AppMode } from '@renderer/stores/ui-store'
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
  tooltip?: string | null
  showSidebarToggle?: boolean
  insetForMacTrafficLights?: boolean
}

function getTitlebarModeOptions(tCommon: (key: string) => string): Array<{
  value: AppMode
  label: string
  description: string
  icon: React.JSX.Element
}> {
  return [
    {
      value: 'chat',
      label: tCommon('mode.chat'),
      description: tCommon('mode.descriptions.chat'),
      icon: <Send className="size-3.5 text-inherit" />
    },
    {
      value: 'clarify',
      label: tCommon('mode.clarify'),
      description: tCommon('mode.descriptions.clarify'),
      icon: <CircleHelp className="size-3.5 text-inherit" />
    },
    {
      value: 'cowork',
      label: tCommon('mode.cowork'),
      description: tCommon('mode.descriptions.cowork'),
      icon: <Briefcase className="size-3.5 text-inherit" />
    },
    {
      value: 'code',
      label: tCommon('mode.code'),
      description: tCommon('mode.descriptions.code'),
      icon: <Code2 className="size-3.5 text-inherit" />
    },
    {
      value: 'acp',
      label: tCommon('mode.acp'),
      description: tCommon('mode.descriptions.acp'),
      icon: <ShieldCheck className="size-3.5 text-inherit" />
    }
  ]
}

export function TitleBar({
  updateInfo,
  onOpenUpdateDialog,
  title,
  tooltip = null,
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
  const runtimeStatusPanelOpen = useUIStore((s) => s.runtimeStatusPanelOpen)
  const toggleRuntimeStatusPanel = useUIStore((s) => s.toggleRuntimeStatusPanel)
  const workingFolderSheetOpen = useUIStore((s) => s.workingFolderSheetOpen)
  const toggleWorkingFolderSheet = useUIStore((s) => s.toggleWorkingFolderSheet)
  const setBottomTerminalDockOpen = useUIStore((s) => s.setBottomTerminalDockOpen)
  const chatView = useUIStore((s) => s.chatView)
  const mode = useUIStore((s) => s.mode)
  const setMode = useUIStore((s) => s.setMode)
  const settingsPageOpen = useUIStore((s) => s.settingsPageOpen)
  const skillsPageOpen = useUIStore((s) => s.skillsPageOpen)
  const soulsPageOpen = useUIStore((s) => s.soulsPageOpen)
  const resourcesPageOpen = useUIStore((s) => s.resourcesPageOpen)
  const drawPageOpen = useUIStore((s) => s.drawPageOpen)
  const translatePageOpen = useUIStore((s) => s.translatePageOpen)
  const tasksPageOpen = useUIStore((s) => s.tasksPageOpen)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const activeSessionIsStreaming = useChatStore((s) =>
    activeSessionId ? Boolean(s.streamingMessages[activeSessionId]) : false
  )
  const activeProjectId = useChatStore((s) => s.activeProjectId)
  const updateSessionMode = useChatStore((s) => s.updateSessionMode)
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
        sessionProjectId: activeSession?.projectId ?? null,
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
    !soulsPageOpen &&
    !resourcesPageOpen &&
    !drawPageOpen &&
    !translatePageOpen &&
    !tasksPageOpen
  const allModeOptions = getTitlebarModeOptions(tCommon)
  const modeProjectScoped =
    chatView === 'session' ? Boolean(sessionContext.sessionProjectId) : Boolean(activeProjectId)
  const availableModeOptions = modeProjectScoped
    ? allModeOptions.filter((option) => option.value !== 'chat')
    : allModeOptions.filter((option) => option.value === 'chat')
  const showTitlebarModeSwitch =
    chatSurfaceActive &&
    (chatView === 'home' || chatView === 'project' || chatView === 'session') &&
    availableModeOptions.length > 1
  const defaultProjectModeOption =
    allModeOptions.find((option) => option.value === 'cowork') ?? allModeOptions[0]!
  const activeTitlebarMode =
    availableModeOptions.find((option) => option.value === mode) ??
    (modeProjectScoped ? defaultProjectModeOption : undefined) ??
    availableModeOptions[0] ??
    allModeOptions[0]!
  const showInspectorToggle = chatSurfaceActive && chatView === 'session'
  const showRuntimeStatusToggle = chatSurfaceActive && chatView === 'session'
  const showFileManagerToggle =
    chatSurfaceActive && chatView === 'session' && Boolean(sessionContext.sessionProjectId)
  const canOpenFileManager = Boolean(sessionContext.sessionWorkingFolder)
  const showProjectTerminalToggle =
    chatSurfaceActive &&
    Boolean(sessionContext.terminalProjectId) &&
    (chatView === 'project' || chatView === 'session' || (chatView === 'home' && mode !== 'chat'))
  const canOpenProjectTerminal = Boolean(
    sessionContext.terminalWorkingFolder || sessionContext.terminalSshConnectionId
  )
  const showProjectToolGroup =
    showRuntimeStatusToggle ||
    showProjectTerminalToggle ||
    showFileManagerToggle ||
    showInspectorToggle
  const projectToolButtonClass =
    'workspace-titlebar-toolbutton titlebar-no-drag inline-flex size-[30px] items-center justify-center rounded-[11px] transition-all'

  const handleToggleProjectTerminal = async (): Promise<void> => {
    if (!sessionContext.terminalProjectId || !canOpenProjectTerminal) return

    const nextOpen = !terminalDockOpen
    setBottomTerminalDockOpen(sessionContext.terminalProjectId, nextOpen)
  }

  const handleTitlebarModeSwitch = (nextMode: AppMode): void => {
    setMode(nextMode)
    if (chatView === 'session' && activeSessionId) {
      updateSessionMode(activeSessionId, nextMode)
    }
  }

  const handleToggleAutoApprove = async (): Promise<void> => {
    if (!autoApprove) {
      const ok = await confirm({ title: t('layout.autoApproveConfirm') })
      if (!ok) return
    }

    useSettingsStore.getState().updateSettings({ autoApprove: !autoApprove })
    toast.success(t(autoApprove ? 'autoApproveOff' : 'autoApproveOn'))
  }

  return (
    <header
      className={cn(
        'workspace-titlebar-surface titlebar-drag relative flex h-10 w-full shrink-0 items-center gap-3 overflow-hidden px-3',
        isMac && insetForMacTrafficLights ? 'pl-[104px]' : '',
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
            <TooltipContent>{t('commandPalette.toggleSidebar')}</TooltipContent>
          </Tooltip>
        ) : null}

        {showTitlebarModeSwitch ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                data-tour="mode-switch"
                className="workspace-titlebar-action titlebar-no-drag group h-7 gap-1.5 rounded-md px-2 text-[11px] text-muted-foreground hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
                disabled={activeSessionIsStreaming}
              >
                <span className="text-primary">{activeTitlebarMode.icon}</span>
                <span className="font-medium">{activeTitlebarMode.label}</span>
                <ChevronDown className="size-3.5 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64 p-1.5">
              {availableModeOptions.map((option) => {
                const active = mode === option.value
                return (
                  <DropdownMenuItem
                    key={option.value}
                    className={cn(
                      'group items-start gap-2.5 rounded-lg px-2 py-2',
                      active && 'bg-accent/50 focus:bg-accent'
                    )}
                    onSelect={() => handleTitlebarModeSwitch(option.value)}
                  >
                    <span
                      className={cn(
                        'mt-px flex size-7 shrink-0 items-center justify-center rounded-md border transition-colors',
                        active
                          ? 'border-primary/30 bg-primary/10 text-primary'
                          : 'border-border/60 bg-muted/40 text-muted-foreground group-focus:text-foreground'
                      )}
                    >
                      {option.icon}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-1.5 text-[13px] font-medium leading-none text-foreground">
                        {option.label}
                        {active ? (
                          <Check className="size-3.5 text-primary" strokeWidth={2.5} />
                        ) : null}
                      </span>
                      <span className="text-[11px] leading-snug text-muted-foreground">
                        {option.description}
                      </span>
                    </span>
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        <div className="min-w-0 flex-1">
          {title ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex min-w-0 items-center gap-2">
                  <div className="truncate text-sm font-semibold text-foreground/92">{title}</div>
                </div>
              </TooltipTrigger>
              {tooltip ? <TooltipContent>{tooltip}</TooltipContent> : null}
            </Tooltip>
          ) : null}
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
          <div className="titlebar-no-drag flex items-center gap-1">
            {showRuntimeStatusToggle && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-pressed={runtimeStatusPanelOpen}
                    data-active={runtimeStatusPanelOpen ? 'true' : 'false'}
                    className={projectToolButtonClass}
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
            )}

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
                      ? t('topbar.closeFileManager')
                      : t('topbar.openFileManager')
                    : t('topbar.fileManagerUnavailable')}
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
                  {rightPanelOpen ? t('topbar.closeInspector') : t('topbar.openInspector')}
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
          <TooltipContent>{t('topbar.help')}</TooltipContent>
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
