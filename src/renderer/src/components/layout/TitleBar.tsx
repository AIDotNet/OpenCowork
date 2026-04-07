import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Settings,
  Sun,
  Moon,
  Brain,
  Users,
  Terminal,
  Square,
  HelpCircle,
  Camera,
  Check,
  Pencil,
  Globe,
  Languages,
  Download,
  Loader2
} from 'lucide-react'
import appIconUrl from '../../../../../resources/icon.png'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@renderer/components/ui/hover-card'
import { Input } from '@renderer/components/ui/input'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { useUIStore } from '@renderer/stores/ui-store'
import { cn } from '@renderer/lib/utils'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useTeamStore } from '@renderer/stores/team-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { pickFriendlyMessage, type FriendlyStatus } from '@renderer/lib/api/generate-title'
import { useTheme } from 'next-themes'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
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

export function TitleBar({ updateInfo, onOpenUpdateDialog }: TitleBarProps): React.JSX.Element {
  const { t, i18n } = useTranslation('layout')
  const { t: tCommon } = useTranslation('common')
  const isMac = /Mac/.test(navigator.userAgent)
  const openDetailPanel = useUIStore((s) => s.openDetailPanel)
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const { theme, setTheme } = useTheme()

  const userAvatar = useSettingsStore((s) => s.userAvatar)
  const userName = useSettingsStore((s) => s.userName)
  const language = useSettingsStore((s) => s.language)
  const translatePageOpen = useUIStore((s) => s.translatePageOpen)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isEditingName, setIsEditingName] = useState(false)
  const [editName, setEditName] = useState(userName)
  const [friendlyMessage, setFriendlyMessage] = useState('')
  const hasCustomAvatar = Boolean(userAvatar)
  const displayAvatar = userAvatar || appIconUrl

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
  const runningSubAgentNamesSig = useAgentStore((s) => s.runningSubAgentNamesSig)
  const runningBackgroundCommandIdsSig = useAgentStore((s) =>
    Object.values(s.backgroundProcesses)
      .filter(
        (p) =>
          p.source === 'bash-tool' &&
          p.status === 'running' &&
          (!activeSessionId || p.sessionId === activeSessionId)
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((p) => p.id)
      .join('\u0000')
  )
  const stopBackgroundProcess = useAgentStore((s) => s.stopBackgroundProcess)
  const runningSubAgents = useMemo(
    () => (runningSubAgentNamesSig ? runningSubAgentNamesSig.split('\u0000') : []),
    [runningSubAgentNamesSig]
  )
  const activeTeamSummary = useTeamStore(
    useShallow((s) => {
      const team = s.activeTeam
      if (!team) return null
      return {
        name: team.name,
        total: team.tasks.length,
        completed: team.tasks.filter((task) => task.status === 'completed').length,
        working: team.members.filter((member) => member.status === 'working').length
      }
    })
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

  const statusType = useMemo<FriendlyStatus>(() => {
    if (errorCount > 0) return 'error'
    if (pendingApprovals > 0) return 'pending'
    if (streamingMessageId) return 'streaming'
    if (runningSubAgents.length > 0) return 'agents'
    if (runningBackgroundCommands.length > 0) return 'background'
    return 'idle'
  }, [
    errorCount,
    pendingApprovals,
    streamingMessageId,
    runningSubAgents.length,
    runningBackgroundCommands.length
  ])

  useEffect(() => {
    setFriendlyMessage(pickFriendlyMessage(statusType, language))
  }, [statusType, language])

  const toggleTheme = (): void => {
    setTheme(theme === 'dark' ? 'light' : 'dark')
  }

  const handleAvatarClick = (): void => {
    fileInputRef.current?.click()
  }

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      useSettingsStore.getState().updateSettings({ userAvatar: dataUrl })
    }
    reader.readAsDataURL(file)
    e.target.value = ''
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
        'titlebar-drag relative flex h-10 w-full shrink-0 items-center gap-2 overflow-hidden bg-background/80 backdrop-blur-md px-3',
        isMac ? 'pl-[78px]' : 'pr-[132px]'
      )}
      style={{
        paddingRight: isMac ? undefined : 'calc(132px + 0.75rem)'
      }}
    >
      {/* Left cluster: Logo + Avatar */}
      <div className="titlebar-no-drag flex shrink-0 items-center gap-2">
        <button
          type="button"
          className="text-[12px] font-medium cursor-default select-none"
          style={{
            userSelect: 'none'
          }}
          onClick={(e) => e.preventDefault()}
        >
          OpenCoWork
        </button>
        <HoverCard>
          <HoverCardTrigger asChild>
            <button className="flex size-7 items-center justify-center overflow-hidden rounded-full bg-muted ring-1 ring-border/50 transition-all hover:ring-primary/50 hover:scale-105">
              <img
                src={displayAvatar}
                alt="avatar"
                className={hasCustomAvatar ? 'size-full object-cover' : 'size-full object-contain p-0.5'}
              />
            </button>
          </HoverCardTrigger>
          <HoverCardContent side="bottom" align="start" className="w-60 p-0 overflow-hidden">
            {/* Header with gradient background */}
            <div className="relative h-16 bg-gradient-to-br from-primary/20 via-primary/10 to-transparent" />

            {/* Avatar overlapping header */}
            <div className="px-4 -mt-8">
              <button
                onClick={handleAvatarClick}
                className="group relative flex size-14 items-center justify-center overflow-hidden rounded-full bg-muted ring-2 ring-background shadow-md transition-all hover:ring-primary/50"
              >
                <img
                  src={displayAvatar}
                  alt="avatar"
                  className={hasCustomAvatar ? 'size-full object-cover' : 'size-full object-contain p-1'}
                />
                <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                  <Camera className="size-4 text-white" />
                </div>
              </button>
            </div>

            {/* User info */}
            <div className="px-4 pt-2 pb-3">
              <div className="flex items-center gap-1.5">
                {isEditingName ? (
                  <div className="flex items-center gap-1 flex-1">
                    <Input
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          useSettingsStore.getState().updateSettings({ userName: editName.trim() })
                          setIsEditingName(false)
                        }
                        if (e.key === 'Escape') {
                          setEditName(userName)
                          setIsEditingName(false)
                        }
                      }}
                      onBlur={() => {
                        useSettingsStore.getState().updateSettings({ userName: editName.trim() })
                        setIsEditingName(false)
                      }}
                      className="h-6 px-1.5 text-sm"
                      placeholder={t('titleBar.namePlaceholder')}
                    />
                    <button
                      onClick={() => {
                        useSettingsStore.getState().updateSettings({ userName: editName.trim() })
                        setIsEditingName(false)
                      }}
                      className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-muted"
                    >
                      <Check className="size-3 text-primary" />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      setEditName(userName)
                      setIsEditingName(true)
                    }}
                    className="group flex items-center gap-1 text-sm font-medium hover:text-primary transition-colors"
                  >
                    <span>{userName || t('titleBar.defaultName')}</span>
                    <Pencil className="size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </button>
                )}
              </div>

              {/* Open Source tag */}
              <div className="mt-2">
                <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 ring-1 ring-emerald-500/20">
                  {t('titleBar.openSourceEdition')}
                </span>
              </div>
            </div>

            {/* Menu items */}
            <div className="border-t px-1 py-1">
              <button
                onClick={() => useUIStore.getState().openTranslatePage()}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors',
                  translatePageOpen && 'bg-muted text-foreground'
                )}
              >
                <Languages className="size-3.5" />
                {t('navRail.translate')}
              </button>
              <button
                onClick={toggleTheme}
                className="flex w-full items-center justify-between rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              >
                <span className="flex items-center gap-2">
                  {theme === 'dark' ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
                  {t('titleBar.theme')}
                </span>
                <span className="text-[10px] text-muted-foreground/60">
                  {theme === 'dark' ? t('titleBar.themeLight') : t('titleBar.themeDark')}
                </span>
              </button>
              <button
                onClick={() => {
                  const next = language === 'zh' ? 'en' : 'zh'
                  useSettingsStore.getState().updateSettings({ language: next })
                  i18n.changeLanguage(next)
                }}
                className="flex w-full items-center justify-between rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              >
                <span className="flex items-center gap-2">
                  <Globe className="size-3.5" />
                  {t('titleBar.language')}
                </span>
                <span className="text-[10px] text-muted-foreground/60">
                  {language === 'zh' ? 'English' : '中文'}
                </span>
              </button>
              <button
                onClick={() => setSettingsOpen(true)}
                className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              >
                <Settings className="size-3.5" />
                {t('topbar.settings')}
              </button>
            </div>
          </HoverCardContent>
        </HoverCard>
        {friendlyMessage && (
          <div className="titlebar-no-drag max-w-[240px] truncate text-[11px] text-muted-foreground/80">
            {friendlyMessage}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleAvatarChange}
        />
      </div>


      {/* Right-side controls */}
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

        {/* Auto-approve toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-pressed={autoApprove}
              aria-label={autoApprove ? t('topbar.autoApproveOn') : t('topbar.autoApproveOff')}
              className={cn(
                'titlebar-no-drag rounded px-1.5 py-0.5 text-[9px] font-medium transition-colors',
                autoApprove
                  ? 'bg-destructive/10 text-destructive hover:bg-destructive/15'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground'
              )}
              onClick={() => void handleToggleAutoApprove()}
            >
              AUTO
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {autoApprove ? t('topbar.autoApproveOn') : t('topbar.autoApproveOff')} ·{' '}
            {t('topbar.clickToSwitch')}
          </TooltipContent>
        </Tooltip>

        {/* Pending approval indicator */}
        {pendingApprovals > 0 && (
          <Tooltip>
            <TooltipTrigger className="titlebar-no-drag hidden animate-pulse rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-600 dark:text-amber-400 cursor-default md:inline-flex">
              {t('topbar.pendingCount', { count: pendingApprovals })}
            </TooltipTrigger>
            <TooltipContent>{t('topbar.toolCallAwaiting')}</TooltipContent>
          </Tooltip>
        )}

        {/* SubAgent indicator */}
        {runningSubAgents.length > 0 && (
          <span className="titlebar-no-drag hidden max-w-[12rem] items-center gap-1 overflow-hidden rounded bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-medium text-violet-500 lg:inline-flex">
            <Brain className="size-3 animate-pulse shrink-0" />
            <span className="truncate">{runningSubAgents.join(', ')}</span>
          </span>
        )}

        {/* Team indicator */}
        {activeTeamSummary && (
          <button
            onClick={() => {
              const ui = useUIStore.getState()
              ui.setRightPanelOpen(true)
              ui.setRightPanelTab('team')
            }}
            className="titlebar-no-drag hidden max-w-[12rem] items-center gap-1 overflow-hidden rounded bg-cyan-500/10 px-1.5 py-0.5 text-[9px] font-medium text-cyan-500 hover:bg-cyan-500/20 transition-colors lg:inline-flex"
          >
            <Users className="size-3 shrink-0" />
            <span className="truncate">{activeTeamSummary.name}</span>
            {activeTeamSummary.total > 0 && (
              <span className="text-cyan-500/60">
                · {activeTeamSummary.completed}/{activeTeamSummary.total}✓
              </span>
            )}
            {activeTeamSummary.working > 0 && (
              <span className="flex items-center gap-0.5">
                <span className="size-1.5 rounded-full bg-cyan-500 animate-pulse" />
                {activeTeamSummary.working}
              </span>
            )}
          </button>
        )}

        {/* Error count indicator */}
        {errorCount > 0 && (
          <Tooltip>
            <TooltipTrigger className="titlebar-no-drag hidden rounded bg-destructive/10 px-1.5 py-0.5 text-[9px] font-medium text-destructive cursor-default md:inline-flex">
              {t('topbar.errorsCount', { count: errorCount })}
            </TooltipTrigger>
            <TooltipContent>{t('topbar.toolCallsFailed', { count: errorCount })}</TooltipContent>
          </Tooltip>
        )}

        {/* Background command indicator */}
        {runningBackgroundCommands.length > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="titlebar-no-drag hidden h-7 gap-1.5 px-2 text-[10px] md:inline-flex"
              >
                <Terminal className="size-3.5" />
                {t('topbar.backgroundCommandsCount', {
                  count: runningBackgroundCommands.length
                })}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[22rem] p-2">
              <div className="mb-1 text-xs font-medium text-foreground/85">
                {t('topbar.backgroundCommandsTitle', { count: runningBackgroundCommands.length })}
              </div>
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {runningBackgroundCommands.map((proc) => (
                  <div key={proc.id} className="rounded-md border px-2 py-1.5">
                    <div className="truncate font-mono text-[11px] text-foreground/85">
                      {proc.command}
                    </div>
                    {proc.cwd && (
                      <div className="truncate text-[10px] text-muted-foreground/60">
                        {proc.cwd}
                      </div>
                    )}
                    <div className="mt-1 flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 px-1.5 text-[10px] text-muted-foreground"
                        onClick={() => openDetailPanel({ type: 'terminal', processId: proc.id })}
                      >
                        {t('topbar.openSession')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 gap-1 px-1.5 text-[10px] text-destructive/80"
                        onClick={() => void stopBackgroundProcess(proc.id)}
                      >
                        <Square className="size-2.5 fill-current" />
                        {t('topbar.stopCommand')}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        )}

        {/* Help */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="titlebar-no-drag inline-flex size-7 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50 transition-all"
              onClick={() => useUIStore.getState().setConversationGuideOpen(true)}
            >
              <HelpCircle className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('topbar.help', { defaultValue: '新人引导' })}</TooltipContent>
        </Tooltip>
      </div>

      {/* Window Controls (Windows/Linux only) */}
      {!isMac && (
        <div className="absolute right-0 top-0 z-10">
          <WindowControls />
        </div>
      )}
    </header>
  )
}
