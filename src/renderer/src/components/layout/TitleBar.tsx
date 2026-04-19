import { useMemo } from 'react'
import {
  Brain,
  Download,
  HelpCircle,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  ShieldCheck,
  Square,
  Terminal,
  Users
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useTeamStore } from '@renderer/stores/team-store'
import { useUIStore } from '@renderer/stores/ui-store'
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
}

type ActivityTone = 'primary' | 'amber' | 'destructive' | 'violet' | 'cyan' | 'slate'

interface ActivityItem {
  key: string
  tone: ActivityTone
  label: string
  detail: string
}

const ACTIVITY_TONE_CLASS: Record<ActivityTone, string> = {
  primary: 'border-primary/20 bg-primary/10 text-primary',
  amber: 'border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  destructive: 'border-destructive/25 bg-destructive/10 text-destructive',
  violet: 'border-violet-500/25 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  cyan: 'border-cyan-500/25 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400',
  slate: 'border-border/70 bg-muted/60 text-foreground/80'
}

export function TitleBar({ updateInfo, onOpenUpdateDialog }: TitleBarProps): React.JSX.Element {
  const { t } = useTranslation('layout')
  const { t: tCommon } = useTranslation('common')
  const isMac = /Mac/.test(navigator.userAgent)

  const leftSidebarOpen = useUIStore((s) => s.leftSidebarOpen)
  const toggleLeftSidebar = useUIStore((s) => s.toggleLeftSidebar)
  const openDetailPanel = useUIStore((s) => s.openDetailPanel)
  const rightPanelOpen = useUIStore((s) => s.rightPanelOpen)
  const toggleRightPanel = useUIStore((s) => s.toggleRightPanel)
  const chatView = useUIStore((s) => s.chatView)
  const settingsPageOpen = useUIStore((s) => s.settingsPageOpen)
  const skillsPageOpen = useUIStore((s) => s.skillsPageOpen)
  const resourcesPageOpen = useUIStore((s) => s.resourcesPageOpen)
  const drawPageOpen = useUIStore((s) => s.drawPageOpen)
  const translatePageOpen = useUIStore((s) => s.translatePageOpen)
  const tasksPageOpen = useUIStore((s) => s.tasksPageOpen)

  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const streamingMessageId = useChatStore((s) => s.streamingMessageId)
  const autoApprove = useSettingsStore((s) => s.autoApprove)

  const pendingApprovals = useAgentStore((s) => s.pendingToolCalls.length)
  const errorCount = useAgentStore((s) =>
    s.executedToolCalls.reduce(
      (count, toolCall) => count + (toolCall.status === 'error' ? 1 : 0),
      0
    )
  )
  const runningSubAgentNamesSig = useAgentStore((s) =>
    Object.values(s.activeSubAgents)
      .filter((subAgent) => subAgent.isRunning)
      .map((subAgent) => subAgent.name)
      .join('\u0000')
  )
  const runningBackgroundCommandIdsSig = useAgentStore((s) =>
    Object.values(s.backgroundProcesses)
      .filter(
        (process) =>
          process.source === 'bash-tool' &&
          process.status === 'running' &&
          (!activeSessionId || process.sessionId === activeSessionId)
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((process) => process.id)
      .join('\u0000')
  )
  const stopBackgroundProcess = useAgentStore((s) => s.stopBackgroundProcess)

  const activeTeamSummary = useTeamStore(
    useShallow((s) => {
      const team = s.activeTeam
      if (!team || team.sessionId !== activeSessionId) return null
      return {
        name: team.name,
        total: team.tasks.length,
        completed: team.tasks.filter((task) => task.status === 'completed').length,
        working: team.members.filter((member) => member.status === 'working').length
      }
    })
  )

  const runningSubAgents = useMemo(
    () => (runningSubAgentNamesSig ? runningSubAgentNamesSig.split('\u0000') : []),
    [runningSubAgentNamesSig]
  )

  const runningBackgroundCommands = useMemo(
    () =>
      runningBackgroundCommandIdsSig
        ? runningBackgroundCommandIdsSig.split('\u0000').reduce(
            (list, id) => {
              const process = useAgentStore.getState().backgroundProcesses[id]
              if (process) list.push(process)
              return list
            },
            [] as Array<ReturnType<typeof useAgentStore.getState>['backgroundProcesses'][string]>
          )
        : [],
    [runningBackgroundCommandIdsSig]
  )

  const chatSurfaceActive =
    !settingsPageOpen &&
    !skillsPageOpen &&
    !resourcesPageOpen &&
    !drawPageOpen &&
    !translatePageOpen &&
    !tasksPageOpen
  const showInspectorToggle = chatSurfaceActive && chatView === 'session'

  const handleToggleAutoApprove = async (): Promise<void> => {
    if (!autoApprove) {
      const ok = await confirm({ title: t('autoApproveConfirm') })
      if (!ok) return
    }

    useSettingsStore.getState().updateSettings({ autoApprove: !autoApprove })
    toast.success(t(autoApprove ? 'autoApproveOff' : 'autoApproveOn'))
  }

  const activityItems = useMemo<ActivityItem[]>(() => {
    const items: ActivityItem[] = []

    if (streamingMessageId) {
      items.push({
        key: 'streaming',
        tone: 'primary',
        label: t('topbar.runningNow', { defaultValue: 'Running now' }),
        detail: t('topbar.runningNowDesc', {
          defaultValue: 'The assistant is actively working in the current session.'
        })
      })
    }

    if (pendingApprovals > 0) {
      items.push({
        key: 'pending',
        tone: 'amber',
        label: t('topbar.pendingCount', { count: pendingApprovals }),
        detail: t('topbar.toolCallAwaiting')
      })
    }

    if (errorCount > 0) {
      items.push({
        key: 'errors',
        tone: 'destructive',
        label: t('topbar.errorsCount', { count: errorCount }),
        detail: t('topbar.toolCallsFailed', { count: errorCount })
      })
    }

    if (runningSubAgents.length > 0) {
      items.push({
        key: 'subagents',
        tone: 'violet',
        label: t('topbar.subAgentsRunning', {
          defaultValue: '{{count}} subagents',
          count: runningSubAgents.length
        }),
        detail: runningSubAgents.join(', ')
      })
    }

    if (activeTeamSummary) {
      items.push({
        key: 'team',
        tone: 'cyan',
        label: activeTeamSummary.name,
        detail:
          activeTeamSummary.total > 0
            ? t('topbar.teamProgress', {
                defaultValue: '{{completed}}/{{total}} completed',
                completed: activeTeamSummary.completed,
                total: activeTeamSummary.total
              })
            : t('topbar.teamActive', { defaultValue: 'Team collaboration active' })
      })
    }

    if (runningBackgroundCommands.length > 0) {
      items.push({
        key: 'background',
        tone: 'slate',
        label: t('topbar.backgroundCommandsCount', {
          count: runningBackgroundCommands.length
        }),
        detail: t('topbar.backgroundCommandsTitle', {
          count: runningBackgroundCommands.length
        })
      })
    }

    return items
  }, [
    activeTeamSummary,
    errorCount,
    pendingApprovals,
    runningBackgroundCommands.length,
    runningSubAgents,
    streamingMessageId,
    t
  ])

  const primaryActivity = activityItems[0] ?? null
  const extraActivityCount = Math.max(0, activityItems.length - 1)

  return (
    <header
      className={cn(
        'titlebar-drag relative flex h-10 w-full shrink-0 items-center gap-2 overflow-hidden bg-background/80 px-3 backdrop-blur-md',
        isMac ? 'pl-[78px]' : 'pr-[132px]'
      )}
      style={{
        paddingRight: isMac ? undefined : 'calc(132px + 0.75rem)'
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="titlebar-no-drag size-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
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

      <div className="min-w-0 flex-1" />

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

        {primaryActivity && (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  'titlebar-no-drag hidden h-7 max-w-[min(14rem,24vw)] gap-1.5 rounded-md px-2 text-[10px] md:inline-flex',
                  ACTIVITY_TONE_CLASS[primaryActivity.tone]
                )}
              >
                {primaryActivity.key === 'background' ? (
                  <Terminal className="size-3.5 shrink-0" />
                ) : primaryActivity.key === 'team' ? (
                  <Users className="size-3.5 shrink-0" />
                ) : primaryActivity.key === 'subagents' ? (
                  <Brain className="size-3.5 shrink-0" />
                ) : primaryActivity.key === 'errors' ? (
                  <Square className="size-3 shrink-0 fill-current" />
                ) : (
                  <Loader2
                    className={cn(
                      'size-3.5 shrink-0',
                      primaryActivity.key === 'streaming' || primaryActivity.key === 'pending'
                        ? 'animate-spin'
                        : ''
                    )}
                  />
                )}
                <span className="truncate">{primaryActivity.label}</span>
                {extraActivityCount > 0 && <span className="shrink-0">+{extraActivityCount}</span>}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[22rem] p-2">
              <div className="space-y-2">
                <div className="text-xs font-medium text-foreground/85">
                  {t('topbar.activitySummary', { defaultValue: 'Session activity' })}
                </div>

                <div className="space-y-1">
                  {activityItems.map((item) => (
                    <div
                      key={item.key}
                      className="rounded-md border border-border/60 bg-background/80 px-2.5 py-2"
                    >
                      <div className="text-[11px] font-medium text-foreground/90">{item.label}</div>
                      <div className="mt-0.5 text-[10px] text-muted-foreground">{item.detail}</div>

                      {item.key === 'team' && activeTeamSummary && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="mt-1 h-6 px-2 text-[10px]"
                          onClick={() => {
                            const ui = useUIStore.getState()
                            ui.setRightPanelOpen(true)
                            ui.setRightPanelTab('team')
                          }}
                        >
                          {t('topbar.openTeamPanel', { defaultValue: 'Open team panel' })}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>

                {runningBackgroundCommands.length > 0 && (
                  <div className="space-y-1">
                    {runningBackgroundCommands.map((process) => (
                      <div
                        key={process.id}
                        className="rounded-md border border-border/60 px-2 py-1.5"
                      >
                        <div className="truncate font-mono text-[11px] text-foreground/85">
                          {process.command}
                        </div>
                        {process.cwd && (
                          <div className="truncate text-[10px] text-muted-foreground/60">
                            {process.cwd}
                          </div>
                        )}
                        <div className="mt-1 flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 px-1.5 text-[10px] text-muted-foreground"
                            onClick={() =>
                              openDetailPanel({ type: 'terminal', processId: process.id })
                            }
                          >
                            {t('topbar.openSession')}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 gap-1 px-1.5 text-[10px] text-destructive/80"
                            onClick={() => void stopBackgroundProcess(process.id)}
                          >
                            <Square className="size-2.5 fill-current" />
                            {t('topbar.stopCommand')}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </PopoverContent>
          </Popover>
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
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
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

        {showInspectorToggle && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-pressed={rightPanelOpen}
                className={cn(
                  'titlebar-no-drag inline-flex size-7 items-center justify-center rounded-md transition-all',
                  rightPanelOpen
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50'
                )}
                onClick={toggleRightPanel}
              >
                {rightPanelOpen ? (
                  <PanelRightClose className="size-4" />
                ) : (
                  <PanelRightOpen className="size-4" />
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

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="titlebar-no-drag inline-flex size-7 items-center justify-center rounded-md transition-all hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50"
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
