import * as React from 'react'
import {
  CircleHelp,
  Briefcase,
  Code2,
  ShieldCheck,
  FolderOpen,
  BookOpen,
  MessageSquare,
  PanelLeftOpen
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'
import { InputArea } from '@renderer/components/chat/InputArea'
import { WorkingFolderSelectorDialog } from '@renderer/components/chat/WorkingFolderSelectorDialog'
import { useUIStore } from '@renderer/stores/ui-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useChatActions } from '@renderer/hooks/use-chat-actions'
import type { ImageAttachment } from '@renderer/lib/image-attachments'
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

export function ProjectHomePage(): React.JSX.Element {
  const { t } = useTranslation('chat')
  const { t: tCommon } = useTranslation('common')
  const { t: tLayout } = useTranslation('layout')
  const mode = useUIStore((state) => state.mode)
  const setMode = useUIStore((state) => state.setMode)
  const leftSidebarOpen = useUIStore((state) => state.leftSidebarOpen)
  const toggleLeftSidebar = useUIStore((state) => state.toggleLeftSidebar)
  const activeProjectId = useChatStore((state) => state.activeProjectId)
  const projects = useChatStore((state) => state.projects)
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null
  const workingFolder = activeProject?.workingFolder
  const sshConnectionId = activeProject?.sshConnectionId
  const { sendMessage } = useChatActions()
  const [folderDialogOpen, setFolderDialogOpen] = React.useState(false)

  const handleSend = (text: string, images?: ImageAttachment[]): void => {
    if (!activeProjectId) return
    const chatStore = useChatStore.getState()
    const sessionId = chatStore.createSession(mode, activeProjectId)
    chatStore.setActiveSession(sessionId)
    useUIStore.getState().navigateToSession()
    void sendMessage(text, images)
  }

  const handleOpenFolderDialog = React.useCallback((): void => {
    setFolderDialogOpen(true)
  }, [])

  const updateProjectDirectory = React.useCallback(
    async (patch: { workingFolder: string; sshConnectionId: string | null }): Promise<void> => {
      if (!activeProjectId) return
      useChatStore.getState().updateProjectDirectory(activeProjectId, patch)
    },
    [activeProjectId]
  )

  if (!activeProject) {
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
        <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center px-4 py-8 text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">{t('projectHome.noProjectSelected', { defaultValue: '未选择项目' })}</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{t('projectHome.noProjectSelectedDesc', { defaultValue: '请返回首页选择或创建一个项目后再继续。' })}</p>
          <Button className="mt-6" onClick={() => useUIStore.getState().navigateToHome()}>{t('projectHome.backHome', { defaultValue: '返回首页' })}</Button>
        </div>
      </div>
    )
  }

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
        <div className="mb-6 flex justify-center">
          <div
            data-tour="mode-switch"
            className="flex items-center gap-0.5 rounded-xl border border-border/50 bg-background/95 p-0.5 shadow-md backdrop-blur-sm"
          >
            {modes.map((item, index) => (
              <Tooltip key={item.value}>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'relative h-8 gap-1.5 overflow-hidden rounded-lg px-3 text-xs font-medium transition-colors duration-200',
                      mode === item.value
                        ? cn(MODE_SWITCH_ACTIVE_TEXT_CLASS[item.value], 'font-semibold')
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                    onClick={() => setMode(item.value)}
                  >
                    <AnimatePresence initial={false}>
                      {mode === item.value && (
                        <motion.span
                          layoutId="project-home-mode-switch-highlight"
                          className={cn(
                            'pointer-events-none absolute inset-0 rounded-lg border',
                            MODE_SWITCH_HIGHLIGHT_CLASS[item.value]
                          )}
                          transition={MODE_SWITCH_TRANSITION}
                        />
                      )}
                    </AnimatePresence>
                    <span className="relative z-10 flex items-center gap-1.5">
                      {item.icon}
                      {tCommon(item.labelKey)}
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
                    mode: item.value,
                    labelKey: item.labelKey,
                    icon: item.icon,
                    shortcutIndex: index,
                    isActive: mode === item.value,
                    t: (key, options) => String(tLayout(key, options as never)),
                    tCommon: (key, options) => String(tCommon(key, options as never))
                  })}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        </div>

        <div className="flex flex-1 flex-col items-center justify-center py-6">
          <div className="text-center">
            <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              {activeProject.name}
            </h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              {t('projectHome.heroDesc', {
                defaultValue: '围绕当前项目继续推进，默认使用当前项目工作目录创建新会话。'
              })}
            </p>
          </div>

          <div className="mt-8 w-full max-w-4xl">
            <div className="mb-3 flex justify-center">
              <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-border/60 bg-background/55 px-4 py-2 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
                <FolderOpen className="size-3.5 shrink-0" />
                <span className="max-w-[680px] truncate">{workingFolder || activeProject.name}</span>
                {sshConnectionId ? <span className="ml-1 rounded-full border border-border/60 px-1.5 py-0.5 text-[10px] font-medium text-foreground">SSH</span> : null}
              </div>
            </div>
            <InputArea
              onSend={handleSend}
              onSelectFolder={handleOpenFolderDialog}
              workingFolder={workingFolder}
              hideWorkingFolderIndicator
              isStreaming={false}
            />
            <WorkingFolderSelectorDialog
              open={folderDialogOpen}
              onOpenChange={setFolderDialogOpen}
              workingFolder={workingFolder}
              sshConnectionId={sshConnectionId}
              onSelectLocalFolder={(folderPath) =>
                updateProjectDirectory({
                  workingFolder: folderPath,
                  sshConnectionId: null
                })
              }
              onSelectSshFolder={(folderPath, connectionId) =>
                updateProjectDirectory({
                  workingFolder: folderPath,
                  sshConnectionId: connectionId
                })
              }
            />
            <div className="mx-auto mt-3 flex w-full max-w-4xl items-center justify-between px-3">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-full px-3 text-[12px] text-muted-foreground hover:text-foreground"
                  onClick={() => useUIStore.getState().navigateToArchive()}
                >
                  <BookOpen className="size-3.5" />
                  {t('projectHome.openArchive', { defaultValue: '项目档案' })}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-full px-3 text-[12px] text-muted-foreground hover:text-foreground"
                  onClick={() => useUIStore.getState().navigateToChannels()}
                >
                  <MessageSquare className="size-3.5" />
                  {t('projectHome.openChannels', { defaultValue: '聊天频道' })}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
