import * as React from 'react'
import { useEffect, useState } from 'react'
import {
  CircleHelp,
  Briefcase,
  Code2,
  FolderOpen,
  Monitor,
  Server,
  Pencil,
  BookOpen,
  MessageSquare,
  ChevronRight,
  ChevronDown,
  PanelLeftOpen,
  Plus
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { Input } from '@renderer/components/ui/input'
import { cn } from '@renderer/lib/utils'
import { InputArea } from '@renderer/components/chat/InputArea'
import { useUIStore } from '@renderer/stores/ui-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useSshStore } from '@renderer/stores/ssh-store'
import { useChatActions } from '@renderer/hooks/use-chat-actions'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
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
  { value: 'code', labelKey: 'mode.code', icon: <Code2 className="size-3.5" /> }
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
  code: 'border-violet-500/15 bg-violet-500/5 shadow-sm'
}

const MODE_SWITCH_ACTIVE_TEXT_CLASS: Record<SelectableMode, string> = {
  clarify: 'text-foreground',
  cowork: 'text-foreground',
  code: 'text-foreground'
}

const DEFAULT_SSH_WORKDIR = ''

interface DesktopDirectoryOption {
  name: string
  path: string
  isDesktop: boolean
}

interface DesktopDirectorySuccessResult {
  desktopPath: string
  directories: DesktopDirectoryOption[]
}

interface DesktopDirectoryErrorResult {
  error: string
}

type DesktopDirectoryResult = DesktopDirectorySuccessResult | DesktopDirectoryErrorResult

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
  const setActiveProject = useChatStore((state) => state.setActiveProject)
  const createProject = useChatStore((state) => state.createProject)
  const updateProjectDirectory = useChatStore((state) => state.updateProjectDirectory)
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null
  const workingFolder = activeProject?.workingFolder
  const sshConnectionId = activeProject?.sshConnectionId
  const [folderDialogOpen, setFolderDialogOpen] = useState(false)
  const [desktopDirectories, setDesktopDirectories] = useState<DesktopDirectoryOption[]>([])
  const [desktopDirectoriesLoading, setDesktopDirectoriesLoading] = useState(false)
  const sshConnections = useSshStore((state) => state.connections)
  const sshLoaded = useSshStore((state) => state._loaded)
  const [sshDirInputs, setSshDirInputs] = useState<Record<string, string>>({})
  const [sshDirEditingId, setSshDirEditingId] = useState<string | null>(null)
  const { sendMessage } = useChatActions()

  const loadDesktopDirectories = React.useCallback(async (): Promise<void> => {
    if (mode === 'chat') return

    setDesktopDirectoriesLoading(true)
    try {
      const result = (await ipcClient.invoke(
        'fs:list-desktop-directories'
      )) as DesktopDirectoryResult
      if ('error' in result || !Array.isArray(result.directories)) {
        setDesktopDirectories([])
        return
      }

      const seen = new Set<string>()
      const deduped = result.directories.filter((directory) => {
        const key = directory.path.toLowerCase()
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      setDesktopDirectories(deduped)
    } catch {
      setDesktopDirectories([])
    } finally {
      setDesktopDirectoriesLoading(false)
    }
  }, [mode])

  useEffect(() => {
    if (!folderDialogOpen) {
      setSshDirEditingId(null)
    }
  }, [folderDialogOpen])

  const handleOpenFolderDialog = (): void => {
    setFolderDialogOpen(true)
    void loadDesktopDirectories()
    if (!sshLoaded) void useSshStore.getState().loadAll()
  }

  const handleSelectDesktopFolder = (folderPath: string): void => {
    if (!activeProjectId) return
    updateProjectDirectory(activeProjectId, {
      workingFolder: folderPath,
      sshConnectionId: null
    })
    setFolderDialogOpen(false)
  }

  const handleSelectOtherFolder = async (): Promise<void> => {
    const result = (await ipcClient.invoke('fs:select-folder')) as {
      canceled?: boolean
      path?: string
    }
    if (!result.canceled && result.path && activeProjectId) {
      updateProjectDirectory(activeProjectId, {
        workingFolder: result.path,
        sshConnectionId: null
      })
      setFolderDialogOpen(false)
    }
  }

  const handleSelectSshFolder = (connId: string): void => {
    if (!activeProjectId) return
    const conn = sshConnections.find((item) => item.id === connId)
    if (!conn) return
    const dir = sshDirInputs[connId]?.trim() || conn.defaultDirectory || DEFAULT_SSH_WORKDIR
    updateProjectDirectory(activeProjectId, {
      workingFolder: dir,
      sshConnectionId: connId
    })
    setSshDirEditingId(null)
    setFolderDialogOpen(false)
  }

  const handleCreateNewProject = async (): Promise<void> => {
    const result = (await ipcClient.invoke('fs:select-folder')) as {
      canceled?: boolean
      path?: string
    }
    if (!result.canceled && result.path) {
      const folderName = result.path.split(/[\\/]/).pop() || 'New Project'
      const projectId = await createProject({
        name: folderName,
        workingFolder: result.path
      })
      setActiveProject(projectId)
    }
  }

  const handleSend = (text: string, images?: ImageAttachment[]): void => {
    if (!activeProjectId) return
    const chatStore = useChatStore.getState()
    const sessionId = chatStore.createSession(mode, activeProjectId)
    chatStore.setActiveSession(sessionId)
    useUIStore.getState().navigateToSession()
    void sendMessage(text, images)
  }

  const normalizedWorkingFolder = workingFolder?.toLowerCase()

  if (!activeProject) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="max-w-md text-center">
          <div className="text-xl font-semibold text-foreground">
            {t('projectHome.noProjectTitle', { defaultValue: '未选择项目' })}
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('projectHome.noProjectDesc', {
              defaultValue: '先从首页选择一个项目，再进入项目内开始会话。'
            })}
          </p>
          <Button className="mt-4" onClick={() => useUIStore.getState().navigateToHome()}>
            <ChevronRight className="size-4" />
            {t('projectHome.backHome', { defaultValue: '返回首页' })}
          </Button>
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
              </div>
            </div>
            <InputArea
              onSend={handleSend}
              onSelectFolder={mode !== 'chat' ? handleOpenFolderDialog : undefined}
              workingFolder={workingFolder}
              hideWorkingFolderIndicator
              isStreaming={false}
            />
            <div className="mx-auto mt-3 flex w-full max-w-4xl items-center justify-between px-3">
              <HoverCard openDelay={120} closeDelay={120}>
                <HoverCardTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/50 bg-background/40 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                    onMouseEnter={() => {
                      void loadDesktopDirectories()
                      if (!sshLoaded) void useSshStore.getState().loadAll()
                    }}
                  >
                    <FolderOpen className="size-3.5 shrink-0" />
                    <span className="max-w-[260px] truncate">
                      {activeProject.name}
                      {workingFolder ? ` · ${workingFolder}` : ''}
                    </span>
                    <ChevronDown className="size-3 opacity-60" />
                  </button>
                </HoverCardTrigger>
                <HoverCardContent className="w-[380px] p-3">
                  <div className="space-y-3">
                    <div>
                      <div className="mb-2 text-[11px] font-medium text-muted-foreground">
                        {t('input.selectProject', { defaultValue: '选择项目' })}
                      </div>
                      <div className="max-h-40 space-y-1 overflow-y-auto pr-1">
                        {projects
                          .filter((project) => !project.pluginId)
                          .map((project) => (
                            <button
                              key={project.id}
                              type="button"
                              className={cn(
                                'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors',
                                activeProjectId === project.id
                                  ? 'bg-accent text-accent-foreground'
                                  : 'hover:bg-muted/50'
                              )}
                              onClick={() => setActiveProject(project.id)}
                            >
                              <FolderOpen className="size-3.5 shrink-0" />
                              <span className="min-w-0 flex-1 truncate">{project.name}</span>
                            </button>
                          ))}
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-primary transition-colors hover:bg-primary/10"
                          onClick={() => void handleCreateNewProject()}
                        >
                          <Plus className="size-3.5 shrink-0" />
                          <span>{t('input.newProject', { defaultValue: '新建项目' })}</span>
                        </button>
                      </div>
                    </div>

                    <div className="border-t pt-3">
                      <div className="mb-2 text-[11px] font-medium text-muted-foreground">
                        {t('input.currentWorkingFolder', { defaultValue: '当前工作目录' })}
                      </div>
                      <div className="mb-2 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 text-[11px] text-muted-foreground">
                        {workingFolder ||
                          t('input.noWorkingFolderSelected', {
                            defaultValue: 'No folder selected'
                          })}
                      </div>
                      <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto pr-1">
                        {desktopDirectoriesLoading ? (
                          <span className="text-[11px] text-muted-foreground/60">
                            {t('input.loadingFolders', { defaultValue: 'Loading folders...' })}
                          </span>
                        ) : (
                          desktopDirectories.map((directory) => (
                            <button
                              key={directory.path}
                              type="button"
                              className={cn(
                                'inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors',
                                directory.path.toLowerCase() === normalizedWorkingFolder
                                  ? 'border-primary/60 bg-primary/10 text-primary'
                                  : 'border-border/70 bg-muted/20 text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                              )}
                              onClick={() => handleSelectDesktopFolder(directory.path)}
                              title={directory.path}
                            >
                              <FolderOpen className="size-3 shrink-0" />
                              <span className="max-w-[180px] truncate">{directory.name}</span>
                            </button>
                          ))
                        )}
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                          onClick={() => void handleSelectOtherFolder()}
                        >
                          <Pencil className="size-3 shrink-0" />
                          {t('input.selectOtherFolder', { defaultValue: '选择其他目录' })}
                        </button>
                      </div>
                    </div>

                    <div className="border-t pt-3">
                      <div className="mb-2 text-[11px] font-medium text-muted-foreground">
                        {t('input.sshConnections', { defaultValue: 'SSH 连接' })}
                      </div>
                      {sshConnections.length > 0 ? (
                        <div className="max-h-40 space-y-1.5 overflow-y-auto pr-1">
                          {sshConnections.map((conn) => {
                            const isSelected = sshConnectionId === conn.id
                            const dirValue =
                              sshDirInputs[conn.id] ?? conn.defaultDirectory ?? DEFAULT_SSH_WORKDIR
                            const isEditingDir = sshDirEditingId === conn.id
                            return (
                              <div
                                key={conn.id}
                                className={cn(
                                  'rounded-md border px-2 py-1.5',
                                  isSelected ? 'border-primary/60 bg-primary/10' : 'border-border/70 bg-muted/20'
                                )}
                              >
                                <div className="flex items-center gap-2">
                                  <Server className="size-3 shrink-0 text-muted-foreground/60" />
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-[11px] font-medium">{conn.name}</div>
                                    <div className="truncate text-[9px] text-muted-foreground/50">
                                      {conn.username}@{conn.host}:{conn.port}
                                    </div>
                                  </div>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 px-2 text-[10px]"
                                    onClick={() => handleSelectSshFolder(conn.id)}
                                  >
                                    {t('input.sshSelect', { defaultValue: 'Select' })}
                                  </Button>
                                </div>
                                <div className="mt-1.5 flex items-center gap-1.5">
                                  <Input
                                    value={dirValue}
                                    onFocus={() => setSshDirEditingId(conn.id)}
                                    onChange={(event) =>
                                      setSshDirInputs((current) => ({
                                        ...current,
                                        [conn.id]: event.target.value
                                      }))
                                    }
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter') handleSelectSshFolder(conn.id)
                                      if (event.key === 'Escape') setSshDirEditingId(null)
                                    }}
                                    placeholder={t('input.sshDirectoryPlaceholder', {
                                      defaultValue: '/home/user/project'
                                    })}
                                    className={cn(
                                      'h-7 text-[10px]',
                                      isEditingDir ? 'border-primary/50' : 'border-border/60'
                                    )}
                                  />
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      ) : (
                        <span className="text-[11px] text-muted-foreground/60">
                          {t('input.noSshConnections', {
                            defaultValue: 'No SSH connections configured'
                          })}
                        </span>
                      )}
                    </div>

                    <div className="border-t pt-3 space-y-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-full justify-start gap-2 text-[12px]"
                        onClick={() => useUIStore.getState().navigateToArchive()}
                      >
                        <BookOpen className="size-3.5" />
                        {t('projectHome.openArchive', { defaultValue: '项目档案' })}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-full justify-start gap-2 text-[12px]"
                        onClick={() => useUIStore.getState().navigateToChannels()}
                      >
                        <MessageSquare className="size-3.5" />
                        {t('projectHome.openChannels', { defaultValue: '聊天频道' })}
                      </Button>
                    </div>
                  </div>
                </HoverCardContent>
              </HoverCard>
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

      {mode !== 'chat' && (
        <Dialog open={folderDialogOpen} onOpenChange={setFolderDialogOpen}>
          <DialogContent className="p-4 sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle className="text-sm">
                {t('input.desktopFolders', { defaultValue: 'Desktop folders' })}
              </DialogTitle>
            </DialogHeader>

            <div className="-mt-1 rounded-xl border bg-background/60 p-3">
              <div className="mb-2 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5">
                <p className="text-[10px] text-muted-foreground/70">
                  {t('input.currentWorkingFolder', {
                    defaultValue: 'Current working folder'
                  })}
                </p>
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <FolderOpen className="size-3 shrink-0" />
                  <span className="truncate">
                    {workingFolder ??
                      t('input.noWorkingFolderSelected', {
                        defaultValue: 'No folder selected'
                      })}
                  </span>
                </div>
              </div>

              <div className="mb-2 flex items-center justify-end">
                <button
                  className="text-[10px] text-muted-foreground/60 transition-colors hover:text-muted-foreground"
                  onClick={() => void loadDesktopDirectories()}
                >
                  {tCommon('action.refresh', { defaultValue: 'Refresh' })}
                </button>
              </div>

              <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto pr-1">
                {desktopDirectoriesLoading ? (
                  <span className="text-[11px] text-muted-foreground/60">
                    {t('input.loadingFolders', { defaultValue: 'Loading folders...' })}
                  </span>
                ) : desktopDirectories.length > 0 ? (
                  desktopDirectories.map((directory) => {
                    const selected = directory.path.toLowerCase() === normalizedWorkingFolder
                    return (
                      <button
                        key={directory.path}
                        className={cn(
                          'inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors',
                          selected
                            ? 'border-primary/60 bg-primary/10 text-primary'
                            : 'border-border/70 bg-muted/20 text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                        )}
                        onClick={() => handleSelectDesktopFolder(directory.path)}
                        title={directory.path}
                      >
                        <FolderOpen className="size-3 shrink-0" />
                        <span className="max-w-[260px] truncate">{directory.name}</span>
                      </button>
                    )
                  })
                ) : (
                  <span className="text-[11px] text-muted-foreground/60">
                    {t('input.noDesktopFolders', { defaultValue: 'No folders found on Desktop' })}
                  </span>
                )}

                <button
                  className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                  onClick={() => void handleSelectOtherFolder()}
                >
                  <FolderOpen className="size-3 shrink-0" />
                  {t('input.selectOtherFolder', { defaultValue: 'Select other folder' })}
                </button>
              </div>

              <div className="mt-3 border-t pt-3">
                <p className="mb-2 flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground/70">
                  <Monitor className="size-3" />
                  {t('input.sshConnections', { defaultValue: 'SSH Connections' })}
                </p>
                {sshConnections.length > 0 ? (
                  <div className="space-y-1.5">
                    {sshConnections.map((conn) => {
                      const isSelected = sshConnectionId === conn.id
                      const dirValue =
                        sshDirInputs[conn.id] ?? conn.defaultDirectory ?? DEFAULT_SSH_WORKDIR
                      const displayDir = dirValue.trim() || DEFAULT_SSH_WORKDIR
                      const isEditingDir = sshDirEditingId === conn.id
                      return (
                        <div
                          key={conn.id}
                          className={cn(
                            'flex items-center gap-2 rounded-md border px-2 py-1.5 transition-colors',
                            isSelected
                              ? 'border-primary/60 bg-primary/10'
                              : 'border-border/70 bg-muted/20 hover:bg-muted/50'
                          )}
                        >
                          <Server className="size-3 shrink-0 text-muted-foreground/60" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[11px] font-medium">{conn.name}</div>
                            <div className="truncate text-[9px] text-muted-foreground/50">
                              {conn.username}@{conn.host}:{conn.port}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <button
                              className={cn(
                                'flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-all duration-200',
                                isEditingDir
                                  ? 'pointer-events-none max-w-0 -translate-x-1 opacity-0'
                                  : 'max-w-[180px] bg-background/40 hover:bg-muted/40'
                              )}
                              onClick={() => setSshDirEditingId(conn.id)}
                              title={displayDir}
                            >
                              <FolderOpen className="size-3 shrink-0" />
                              <span className="truncate">{displayDir}</span>
                            </button>
                            <div
                              className={cn(
                                'overflow-hidden transition-all duration-200',
                                isEditingDir
                                  ? 'max-w-[200px] opacity-100'
                                  : 'pointer-events-none max-w-0 opacity-0'
                              )}
                            >
                              <Input
                                value={dirValue}
                                onChange={(event) =>
                                  setSshDirInputs((current) => ({
                                    ...current,
                                    [conn.id]: event.target.value
                                  }))
                                }
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') handleSelectSshFolder(conn.id)
                                  if (event.key === 'Escape') setSshDirEditingId(null)
                                }}
                                placeholder={t('input.sshDirectoryPlaceholder', {
                                  defaultValue: '/home/user/project'
                                })}
                                className="h-6 w-40 bg-background/60 text-[10px]"
                              />
                            </div>
                            <button
                              className={cn(
                                'shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors',
                                isEditingDir
                                  ? 'border-primary/50 text-primary'
                                  : 'border-border/70 hover:bg-muted/50 hover:text-foreground'
                              )}
                              onClick={() => setSshDirEditingId(isEditingDir ? null : conn.id)}
                            >
                              <Pencil className="size-3" />
                            </button>
                            <button
                              className="shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-medium text-primary transition-colors hover:bg-primary/10"
                              onClick={() => handleSelectSshFolder(conn.id)}
                            >
                              {t('input.sshSelect', { defaultValue: 'Select' })}
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <span className="text-[11px] text-muted-foreground/60">
                    {t('input.noSshConnections', {
                      defaultValue: 'No SSH connections configured'
                    })}
                  </span>
                )}
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
