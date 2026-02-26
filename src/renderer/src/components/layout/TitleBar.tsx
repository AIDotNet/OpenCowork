import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Settings,
  Sun,
  Moon,
  Keyboard,
  Brain,
  Users,
  Terminal,
  Square,
  HelpCircle,
  User,
  Camera,
  Check,
  Pencil,
  Globe
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@renderer/components/ui/hover-card'
import { Input } from '@renderer/components/ui/input'
import { useUIStore } from '@renderer/stores/ui-store'
import { cn } from '@renderer/lib/utils'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useTeamStore } from '@renderer/stores/team-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useProviderStore } from '@renderer/stores/provider-store'
import { generateFriendlyMessage } from '@renderer/lib/api/generate-title'
import { useTheme } from 'next-themes'
import { useTranslation } from 'react-i18next'
import { WindowControls } from './WindowControls'

export function TitleBar(): React.JSX.Element {
  const { t, i18n } = useTranslation('layout')
  const isMac = /Mac/.test(navigator.userAgent)
  const openDetailPanel = useUIStore((s) => s.openDetailPanel)
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const setShortcutsOpen = useUIStore((s) => s.setShortcutsOpen)
  const { theme, setTheme } = useTheme()

  const userAvatar = useSettingsStore((s) => s.userAvatar)
  const userName = useSettingsStore((s) => s.userName)
  const language = useSettingsStore((s) => s.language)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isEditingName, setIsEditingName] = useState(false)
  const [editName, setEditName] = useState(userName)
  const [friendlyMessage, setFriendlyMessage] = useState('')
  const messageRequestIdRef = useRef(0)

  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const streamingMessageId = useChatStore((s) => s.streamingMessageId)
  const autoApprove = useSettingsStore((s) => s.autoApprove)
  const pendingApprovals = useAgentStore((s) => s.pendingToolCalls.length)
  const errorCount = useAgentStore(
    (s) => s.executedToolCalls.filter((t) => t.status === 'error').length
  )
  const activeSubAgents = useAgentStore((s) => s.activeSubAgents)
  const backgroundProcesses = useAgentStore((s) => s.backgroundProcesses)
  const stopBackgroundProcess = useAgentStore((s) => s.stopBackgroundProcess)
  const runningSubAgents = useMemo(
    () => Object.values(activeSubAgents).filter((sa) => sa.isRunning),
    [activeSubAgents]
  )
  const activeTeam = useTeamStore((s) => s.activeTeam)
  const activeProviderId = useProviderStore((s) => s.activeProviderId)
  const activeFastModelId = useProviderStore((s) => s.activeFastModelId)
  const providers = useProviderStore((s) => s.providers)
  const runningBackgroundCommands = useMemo(
    () =>
      Object.values(backgroundProcesses)
        .filter(
          (p) =>
            p.source === 'bash-tool' &&
            p.status === 'running' &&
            (!activeSessionId || p.sessionId === activeSessionId)
        )
        .sort((a, b) => b.createdAt - a.createdAt),
    [backgroundProcesses, activeSessionId]
  )

  const fastModelInfo = useMemo(() => {
    if (!activeProviderId) return null
    const provider = providers.find((p) => p.id === activeProviderId)
    if (!provider) return null
    const modelId = activeFastModelId || provider.models[0]?.id || ''
    const model = provider.models.find((m) => m.id === modelId)
    return { provider, model, modelId }
  }, [activeProviderId, activeFastModelId, providers])

  const fastModelReady = useMemo(() => {
    if (!fastModelInfo) return false
    const { provider, model, modelId } = fastModelInfo
    if (!modelId) return false
    if (provider.requiresApiKey !== false && !provider.apiKey) return false
    if (!provider.enabled) return false
    if (model && !model.enabled) return false
    return true
  }, [fastModelInfo])

  const { statusType, statusSummary } = useMemo(() => {
    if (errorCount > 0) {
      return { statusType: 'error', statusSummary: `errors=${errorCount}` }
    }
    if (pendingApprovals > 0) {
      return { statusType: 'pending', statusSummary: `pending=${pendingApprovals}` }
    }
    if (streamingMessageId) {
      return { statusType: 'streaming', statusSummary: 'streaming=1' }
    }
    if (runningSubAgents.length > 0) {
      return { statusType: 'agents', statusSummary: `agents=${runningSubAgents.length}` }
    }
    if (runningBackgroundCommands.length > 0) {
      return { statusType: 'background', statusSummary: `background=${runningBackgroundCommands.length}` }
    }
    return { statusType: 'idle', statusSummary: 'idle' }
  }, [
    errorCount,
    pendingApprovals,
    streamingMessageId,
    runningSubAgents.length,
    runningBackgroundCommands.length
  ])

  useEffect(() => {
    if (!fastModelReady) {
      setFriendlyMessage('')
      return
    }
    const requestId = messageRequestIdRef.current + 1
    messageRequestIdRef.current = requestId
    generateFriendlyMessage({
      language,
      status: statusType,
      detail: statusSummary
    })
      .then((message) => {
        if (messageRequestIdRef.current !== requestId) return
        if (message) setFriendlyMessage(message)
      })
      .catch(() => {
        if (messageRequestIdRef.current !== requestId) return
      })
  }, [fastModelReady, language, statusType, statusSummary])

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

  return (
    <header
      className={cn(
        'titlebar-drag relative flex h-10 w-full shrink-0 items-center gap-2 overflow-hidden border-b bg-background/80 backdrop-blur-md px-3',
        isMac ? 'pl-[78px]' : 'pr-[132px]'
      )}
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
          OpenCowork
        </button>
        <HoverCard>
          <HoverCardTrigger asChild>
            <button className="flex size-7 items-center justify-center overflow-hidden rounded-full bg-muted ring-1 ring-border/50 transition-all hover:ring-primary/50 hover:scale-105">
              {userAvatar ? (
                <img src={userAvatar} alt="avatar" className="size-full object-cover" />
              ) : (
                <User className="size-4 text-muted-foreground" />
              )}
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
                {userAvatar ? (
                  <img src={userAvatar} alt="avatar" className="size-full object-cover" />
                ) : (
                  <User className="size-7 text-muted-foreground" />
                )}
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
        {fastModelReady && friendlyMessage && (
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

      <div className="flex-1" />

      {/* Right-side controls */}
      <div className="flex shrink-0 items-center gap-1">
        {/* Auto-approve warning */}
        {autoApprove && (
          <Tooltip>
            <TooltipTrigger className="titlebar-no-drag rounded bg-destructive/10 px-1.5 py-0.5 text-[9px] font-medium text-destructive cursor-default">
              AUTO
            </TooltipTrigger>
            <TooltipContent>{t('topbar.autoApproveOn')}</TooltipContent>
          </Tooltip>
        )}

        {/* Pending approval indicator */}
        {pendingApprovals > 0 && (
          <Tooltip>
            <TooltipTrigger className="titlebar-no-drag animate-pulse rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-600 dark:text-amber-400 cursor-default">
              {t('topbar.pendingCount', { count: pendingApprovals })}
            </TooltipTrigger>
            <TooltipContent>{t('topbar.toolCallAwaiting')}</TooltipContent>
          </Tooltip>
        )}

        {/* SubAgent indicator */}
        {runningSubAgents.length > 0 && (
          <span className="titlebar-no-drag flex items-center gap-1 rounded bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-medium text-violet-500">
            <Brain className="size-3 animate-pulse" />
            {runningSubAgents.map((sa) => sa.name).join(', ')}
          </span>
        )}

        {/* Team indicator */}
        {activeTeam &&
          (() => {
            const completed = activeTeam.tasks.filter((t) => t.status === 'completed').length
            const total = activeTeam.tasks.length
            const working = activeTeam.members.filter((m) => m.status === 'working').length
            return (
              <button
                onClick={() => {
                  const ui = useUIStore.getState()
                  ui.setRightPanelOpen(true)
                  ui.setRightPanelTab('team')
                }}
                className="titlebar-no-drag flex items-center gap-1 rounded bg-cyan-500/10 px-1.5 py-0.5 text-[9px] font-medium text-cyan-500 hover:bg-cyan-500/20 transition-colors"
              >
                <Users className="size-3" />
                {activeTeam.name}
                {total > 0 && (
                  <span className="text-cyan-500/60">
                    · {completed}/{total}✓
                  </span>
                )}
                {working > 0 && (
                  <span className="flex items-center gap-0.5">
                    <span className="size-1.5 rounded-full bg-cyan-500 animate-pulse" />
                    {working}
                  </span>
                )}
              </button>
            )
          })()}

        {/* Error count indicator */}
        {errorCount > 0 && (
          <Tooltip>
            <TooltipTrigger className="titlebar-no-drag rounded bg-destructive/10 px-1.5 py-0.5 text-[9px] font-medium text-destructive cursor-default">
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
                className="titlebar-no-drag h-7 gap-1.5 px-2 text-[10px]"
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

        {/* Keyboard Shortcuts */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="titlebar-no-drag size-7"
              onClick={() => setShortcutsOpen(true)}
            >
              <Keyboard className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('topbar.shortcuts')}</TooltipContent>
        </Tooltip>

        {/* Help */}
        <Tooltip>
          <TooltipTrigger asChild>
            <a 
              href="https://open-cowork.shop/" 
              target="_blank" 
              rel="noreferrer"
              className="titlebar-no-drag inline-flex size-7 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50 transition-all"
            >
              <HelpCircle className="size-4" />
            </a>
          </TooltipTrigger>
          <TooltipContent>{t('topbar.help', { defaultValue: 'Help Center' })}</TooltipContent>
        </Tooltip>

        {/* Settings */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="titlebar-no-drag size-7"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('topbar.settings')}</TooltipContent>
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
