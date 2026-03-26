import * as React from 'react'
import { useEffect } from 'react'
import { CircleHelp, Briefcase, Code2, ShieldCheck, BookOpen, PanelLeftOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'
import { InputArea } from '@renderer/components/chat/InputArea'
import { useUIStore } from '@renderer/stores/ui-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useProviderStore, modelSupportsVision } from '@renderer/stores/provider-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useChatActions } from '@renderer/hooks/use-chat-actions'
import appIconUrl from '../../../../../resources/icon.png'
import type { ImageAttachment } from '@renderer/lib/image-attachments'
import { WorkingFolderSelectorDialog } from './WorkingFolderSelectorDialog'
import {
  renderModeTooltipContent,
  type ModeOption,
  type SelectableMode
} from '@renderer/lib/mode-tooltips'
import { AnimatePresence, motion } from 'motion/react'

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

function formatContextLength(length?: number): string | null {
  if (!length) return null
  if (length >= 1_000_000) {
    return `${(length / 1_000_000).toFixed(length % 1_000_000 === 0 ? 0 : 1)}M`
  }
  if (length >= 1_000) return `${Math.round(length / 1_000)}K`
  return String(length)
}

export function ChatHomePage(): React.JSX.Element {
  const { t } = useTranslation('chat')
  const { t: tCommon } = useTranslation('common')
  const { t: tLayout } = useTranslation('layout')
  const mode = useUIStore((s) => s.mode)
  const setMode = useUIStore((s) => s.setMode)
  const leftSidebarOpen = useUIStore((s) => s.leftSidebarOpen)
  const toggleLeftSidebar = useUIStore((s) => s.toggleLeftSidebar)
  const activeProjectId = useChatStore((s) => s.activeProjectId)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const projects = useChatStore((s) => s.projects)
  const sessions = useChatStore((s) => s.sessions)
  const activeProject =
    projects.find((project) => project.id === activeProjectId) ??
    projects.find((project) => !project.pluginId) ??
    projects[0]
  const workingFolder = activeProject?.workingFolder
  const sshConnectionId = activeProject?.sshConnectionId
  const { sendMessage } = useChatActions()
  const [folderDialogOpen, setFolderDialogOpen] = React.useState(false)
  const activeProviderId = useProviderStore((s) => s.activeProviderId)
  const activeModelId = useProviderStore((s) => s.activeModelId)
  const providers = useProviderStore((s) => s.providers)
  const mainModelSelectionMode = useSettingsStore((s) => s.mainModelSelectionMode)
  const conversationGuideSeen = useSettingsStore((s) => s.conversationGuideSeen)
  const autoModelSelectionsBySession = useUIStore((s) => s.autoModelSelectionsBySession)
  const autoSelection = activeSessionId
    ? (autoModelSelectionsBySession[activeSessionId] ?? null)
    : null
  const handleSend = (text: string, images?: ImageAttachment[]): void => {
    const chatStore = useChatStore.getState()
    const sessionId = chatStore.createSession(mode, activeProject?.id ?? undefined)
    chatStore.setActiveSession(sessionId)
    useUIStore.getState().navigateToSession()
    void sendMessage(text, images)
  }

  const updateHomeProjectDirectory = React.useCallback(
    async (patch: { workingFolder: string; sshConnectionId: string | null }): Promise<void> => {
      const chatStore = useChatStore.getState()
      let projectId: string | null = activeProject?.id ?? activeProjectId ?? null
      if (!projectId) {
        const ensured = await chatStore.ensureDefaultProject()
        projectId = ensured?.id ?? null
      }
      if (!projectId) return
      chatStore.setActiveProject(projectId)
      chatStore.updateProjectDirectory(projectId, patch)
    },
    [activeProject?.id, activeProjectId]
  )

  const handleOpenFolderDialog = React.useCallback((): void => {
    setFolderDialogOpen(true)
  }, [])

  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const sessionProviderId = activeSession?.providerId ?? null
  const sessionModelId = activeSession?.modelId ?? null
  const isSessionBound = Boolean(sessionProviderId && sessionModelId)
  const displayProviderId = sessionProviderId ?? activeProviderId
  const displayModelId = sessionModelId ?? activeModelId
  const displayProvider = providers.find((provider) => provider.id === displayProviderId)
  const displayModel = displayProvider?.models.find((model) => model.id === displayModelId)
  const isAutoModeActive = !isSessionBound && mainModelSelectionMode === 'auto'
  const autoResolvedProvider = autoSelection?.providerId
    ? providers.find((provider) => provider.id === autoSelection.providerId)
    : null
  const autoResolvedModel = autoResolvedProvider?.models.find(
    (model) => model.id === autoSelection?.modelId
  )
  const homeProvider = isAutoModeActive
    ? (autoResolvedProvider ?? displayProvider)
    : displayProvider
  const homeModel = isAutoModeActive ? (autoResolvedModel ?? displayModel) : displayModel
  const homeHasVision = modelSupportsVision(homeModel, homeProvider?.type)
  const homeHasTools = homeModel?.supportsFunctionCall === true
  const homeHasThinking = homeModel?.supportsThinking === true
  const homeModelTitle = isAutoModeActive
    ? autoSelection?.modelName
      ? `${tLayout('topbar.autoModel')} · ${autoSelection.modelName}`
      : tLayout('topbar.autoModel')
    : (homeModel?.name ?? displayModelId ?? t('messageList.homeModelUnavailable'))
  const homeTitle = {
    chat: t('messageList.homeTitleChat'),
    clarify: t('messageList.homeTitleClarify'),
    cowork: t('messageList.homeTitleCowork'),
    code: t('messageList.homeTitleCode'),
    acp: t('messageList.homeTitleAcp')
  }[mode]

  let homeDescription = t('messageList.homeDescChatGeneral')
  if (isAutoModeActive) {
    homeDescription = {
      chat: t('messageList.homeDescAutoChat'),
      clarify: t('messageList.homeDescAutoClarify'),
      cowork: t('messageList.homeDescAutoCowork'),
      code: t('messageList.homeDescAutoCode')
    }[mode]
  } else if (mode === 'clarify') {
    homeDescription = homeHasThinking
      ? t('messageList.homeDescClarifyThinking')
      : t('messageList.homeDescClarifyGeneral')
  } else if (mode === 'cowork') {
    homeDescription = homeHasTools
      ? t('messageList.homeDescCoworkTools')
      : t('messageList.homeDescCoworkGeneral')
  } else if (mode === 'code') {
    homeDescription = homeHasThinking
      ? t('messageList.homeDescCodeThinking')
      : homeHasVision
        ? t('messageList.homeDescCodeVision')
        : t('messageList.homeDescCodeGeneral')
  } else if (mode === 'acp') {
    homeDescription = t('messageList.homeDescAcp')
  } else {
    homeDescription = homeHasVision
      ? t('messageList.homeDescChatVision')
      : t('messageList.homeDescChatGeneral')
  }

  const homeModelMetaParts = [
    homeProvider?.name,
    homeHasVision ? tLayout('topbar.vision') : null,
    homeHasTools ? tLayout('topbar.tools') : null,
    homeHasThinking ? tLayout('topbar.thinking') : null,
    formatContextLength(homeModel?.contextLength)
  ].filter((value): value is string => Boolean(value))
  const homeModelMeta =
    homeModelMetaParts.join(' · ') || (isAutoModeActive ? t('messageList.homeAutoMeta') : '')

  useEffect(() => {
    if (conversationGuideSeen) return
    if (sessions.length > 0) return
    const timer = window.setTimeout(() => {
      useUIStore.getState().setConversationGuideOpen(true)
    }, 240)
    return () => window.clearTimeout(timer)
  }, [conversationGuideSeen, sessions.length])

  return (
    <div className="relative flex flex-1 flex-col overflow-auto bg-gradient-to-b from-background via-background to-muted/20">
      {!leftSidebarOpen && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute left-4 top-4 z-10 size-8 rounded-lg border border-border/60 bg-background/80 backdrop-blur-sm"
          onClick={toggleLeftSidebar}
        >
          <PanelLeftOpen className="size-4" />
        </Button>
      )}
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 py-8">
        <div className="mb-5 flex justify-center">
          <div
            data-tour="mode-switch"
            className="flex items-center gap-0.5 rounded-xl border border-border/50 bg-background/95 p-0.5 shadow-md backdrop-blur-sm"
          >
            {modes.map((m, i) => (
              <Tooltip key={m.value}>
                <TooltipTrigger asChild>
                  <Button
                    data-tour={`mode-${m.value}`}
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'relative h-8 gap-1.5 overflow-hidden rounded-lg px-3 text-xs font-medium transition-colors duration-200',
                      mode === m.value
                        ? cn(MODE_SWITCH_ACTIVE_TEXT_CLASS[m.value], 'font-semibold')
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                    onClick={() => setMode(m.value)}
                  >
                    <AnimatePresence initial={false}>
                      {mode === m.value && (
                        <motion.span
                          layoutId="home-mode-switch-highlight"
                          className={cn(
                            'pointer-events-none absolute inset-0 rounded-lg border',
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
                  align="center"
                  sideOffset={8}
                  className="max-w-[340px] rounded-xl px-3 py-3"
                >
                  {renderModeTooltipContent({
                    mode: m.value,
                    labelKey: m.labelKey,
                    icon: m.icon,
                    shortcutIndex: i,
                    isActive: mode === m.value,
                    t: (key, options) => String(tLayout(key, options as never)),
                    tCommon: (key, options) => String(tCommon(key, options as never))
                  })}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        </div>

        <div className="mb-5 flex min-h-[240px] flex-1 flex-col">
          <div className="flex flex-1 items-center justify-center">
            <img
              src={appIconUrl}
              alt="OpenCowork"
              className="size-24 rounded-[28px] object-cover shadow-xl ring-1 ring-border/50"
            />
          </div>
          <div className="text-center">
            <p className="text-xs font-medium tracking-wide text-muted-foreground/80">
              {t('messageList.homeCurrentModel', { model: homeModelTitle })}
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              {homeTitle}
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{homeDescription}</p>
            {homeModelMeta && (
              <p className="mt-1 text-xs text-muted-foreground/70">{homeModelMeta}</p>
            )}
          </div>
        </div>

        <div className="mt-auto">
          <div className="mx-auto w-full max-w-4xl">
            <InputArea
              onSend={handleSend}
              onSelectFolder={mode !== 'chat' ? handleOpenFolderDialog : undefined}
              workingFolder={workingFolder}
              hideWorkingFolderIndicator
              isStreaming={false}
            />
          </div>

          {mode !== 'chat' && (
            <WorkingFolderSelectorDialog
              open={folderDialogOpen}
              onOpenChange={setFolderDialogOpen}
              workingFolder={workingFolder}
              sshConnectionId={sshConnectionId}
              onSelectLocalFolder={(folderPath) =>
                updateHomeProjectDirectory({
                  workingFolder: folderPath,
                  sshConnectionId: null
                })
              }
              onSelectSshFolder={(folderPath, connectionId) =>
                updateHomeProjectDirectory({
                  workingFolder: folderPath,
                  sshConnectionId: connectionId
                })
              }
            />
          )}

          <div className="mx-auto mt-4 flex w-full max-w-3xl items-center justify-between gap-3 rounded-xl border bg-primary/5 px-5 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <BookOpen className="size-4 text-primary" />
                <span>{t('guide.bannerTitle')}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{t('guide.bannerDesc')}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => useUIStore.getState().setConversationGuideOpen(true)}
            >
              {t('guide.openButton')}
            </Button>
          </div>

          {/* Keyboard shortcuts hint */}
          <div className="mx-auto mt-4 w-full max-w-3xl rounded-xl border bg-muted/30 px-5 py-3">
            <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[11px]">
              <div className="flex items-center gap-2">
                <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  Ctrl+N
                </kbd>
                <span className="text-muted-foreground/60">{t('messageList.newChat')}</span>
              </div>
              <div className="flex items-center gap-2">
                <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  Ctrl+K
                </kbd>
                <span className="text-muted-foreground/60">{t('messageList.commands')}</span>
              </div>
              <div className="flex items-center gap-2">
                <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  Ctrl+B
                </kbd>
                <span className="text-muted-foreground/60">{t('messageList.sidebarShortcut')}</span>
              </div>
              <div className="flex items-center gap-2">
                <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  Ctrl+/
                </kbd>
                <span className="text-muted-foreground/60">
                  {t('messageList.shortcutsShortcut')}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  Ctrl+,
                </kbd>
                <span className="text-muted-foreground/60">
                  {t('messageList.settingsShortcut')}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  Ctrl+D
                </kbd>
                <span className="text-muted-foreground/60">
                  {t('messageList.duplicateShortcut')}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
