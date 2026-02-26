import * as React from 'react'
import { useEffect, useState } from 'react'
import { MessageSquare, Briefcase, Code2, FolderOpen, Monitor, Server, Pencil } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'
import { InputArea } from '@renderer/components/chat/InputArea'
import { useUIStore, type AppMode } from '@renderer/stores/ui-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useSshStore } from '@renderer/stores/ssh-store'
import { useChatActions } from '@renderer/hooks/use-chat-actions'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { Input } from '@renderer/components/ui/input'
import type { ImageAttachment } from '@renderer/components/chat/InputArea'

const modes: { value: AppMode; labelKey: string; icon: React.ReactNode }[] = [
  { value: 'chat', labelKey: 'mode.chat', icon: <MessageSquare className="size-3.5" /> },
  { value: 'cowork', labelKey: 'mode.cowork', icon: <Briefcase className="size-3.5" /> },
  { value: 'code', labelKey: 'mode.code', icon: <Code2 className="size-3.5" /> }
]
const DEFAULT_SSH_WORKDIR = '~/workspace'

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

export function ChatHomePage(): React.JSX.Element {
  const { t } = useTranslation('chat')
  const { t: tCommon } = useTranslation('common')
  const mode = useUIStore((s) => s.mode)
  const setMode = useUIStore((s) => s.setMode)
  const [workingFolder, setWorkingFolder] = useState<string | undefined>()
  const [sshConnectionId, setSshConnectionId] = useState<string | undefined>()
  const [folderDialogOpen, setFolderDialogOpen] = useState(false)
  const [desktopDirectories, setDesktopDirectories] = useState<DesktopDirectoryOption[]>([])
  const [desktopDirectoriesLoading, setDesktopDirectoriesLoading] = useState(false)
  const { sendMessage } = useChatActions()
  const sshConnections = useSshStore((s) => s.connections)
  const sshLoaded = useSshStore((s) => s._loaded)
  const [sshDirInputs, setSshDirInputs] = useState<Record<string, string>>({})
  const [sshDirEditingId, setSshDirEditingId] = useState<string | null>(null)

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
    if (mode === 'chat') {
      setDesktopDirectories([])
      setFolderDialogOpen(false)
      return
    }
    void loadDesktopDirectories()
  }, [mode, loadDesktopDirectories])

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
    setWorkingFolder(folderPath)
    setSshConnectionId(undefined)
    setFolderDialogOpen(false)
  }

  const handleSelectOtherFolder = async (): Promise<void> => {
    const result = (await ipcClient.invoke('fs:select-folder')) as {
      canceled?: boolean
      path?: string
    }
    if (!result.canceled && result.path) {
      setWorkingFolder(result.path)
      setSshConnectionId(undefined)
      setFolderDialogOpen(false)
    }
  }

  const handleSelectSshFolder = (connId: string): void => {
    const conn = sshConnections.find((c) => c.id === connId)
    if (!conn) return
    const dir = sshDirInputs[connId]?.trim() || conn.defaultDirectory || DEFAULT_SSH_WORKDIR
    setWorkingFolder(dir)
    setSshConnectionId(connId)
    setSshDirEditingId(null)
    setFolderDialogOpen(false)
  }

  const handleSend = (text: string, images?: ImageAttachment[]): void => {
    const chatStore = useChatStore.getState()
    const sessionId = chatStore.createSession(mode)
    if (workingFolder) {
      chatStore.setWorkingFolder(sessionId, workingFolder)
    }
    if (sshConnectionId) {
      chatStore.setSshConnectionId(sessionId, sshConnectionId)
    }
    useUIStore.getState().navigateToSession()
    void sendMessage(text, images)
  }

  const suggestions =
    mode === 'chat'
      ? [t('messageList.explainAsync'), t('messageList.compareRest'), t('messageList.writeRegex')]
      : mode === 'cowork'
        ? [
            t('messageList.summarizeProject'),
            t('messageList.findBugs'),
            t('messageList.addErrorHandling')
          ]
        : [t('messageList.buildCli'), t('messageList.createRestApi'), t('messageList.writeScript')]

  const modeHint = {
    chat: {
      icon: <MessageSquare className="size-10 text-muted-foreground/30" />,
      title: t('messageList.startConversation'),
      desc: t('messageList.startConversationDesc')
    },
    cowork: {
      icon: <Briefcase className="size-10 text-muted-foreground/30" />,
      title: t('messageList.startCowork'),
      desc: t('messageList.startCoworkDesc')
    },
    code: {
      icon: <Code2 className="size-10 text-muted-foreground/30" />,
      title: t('messageList.startCoding'),
      desc: t('messageList.startCodingDesc')
    }
  }[mode]

  const handleSuggestionClick = (prompt: string): void => {
    useUIStore.getState().setPendingInsertText(prompt)
  }

  const normalizedWorkingFolder = workingFolder?.toLowerCase()

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-gradient-to-b from-background to-muted/20">
      <div className="flex flex-1 flex-col items-center justify-center px-4 pb-4">
        {/* Mode switcher */}
        <div className="mb-8 flex items-center gap-0.5 rounded-lg bg-background/95 backdrop-blur-sm p-0.5 shadow-md border border-border/50">
          {modes.map((m, i) => (
            <Tooltip key={m.value}>
              <TooltipTrigger asChild>
                <Button
                  variant={mode === m.value ? 'secondary' : 'ghost'}
                  size="sm"
                  className={cn(
                    'h-7 gap-1.5 rounded-md px-3 text-xs font-medium transition-all duration-200',
                    mode === m.value
                      ? 'bg-background shadow-sm ring-1 ring-border/50'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                  onClick={() => {
                    setMode(m.value)
                    if (m.value === 'chat') {
                      setWorkingFolder(undefined)
                      setFolderDialogOpen(false)
                    }
                  }}
                >
                  {m.icon}
                  {tCommon(m.labelKey)}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {tCommon(m.labelKey)} (Ctrl+{i + 1})
              </TooltipContent>
            </Tooltip>
          ))}
        </div>

        {/* Icon + title */}
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="rounded-2xl bg-muted/40 p-4">{modeHint.icon}</div>
          <div>
            <p className="text-base font-semibold text-foreground/80">{modeHint.title}</p>
            <p className="mt-1.5 text-sm text-muted-foreground/60 max-w-[340px]">{modeHint.desc}</p>
          </div>
        </div>

        {/* Suggestion chips */}
        <div className="mb-6 flex flex-wrap justify-center gap-2 max-w-[420px]">
          {suggestions.map((prompt) => (
            <button
              key={prompt}
              className="rounded-lg border bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground/60 hover:text-foreground hover:bg-muted/60 transition-colors"
              onClick={() => handleSuggestionClick(prompt)}
            >
              {prompt}
            </button>
          ))}
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
                    className="text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                    onClick={() => void loadDesktopDirectories()}
                  >
                    {t('action.refresh', { ns: 'common', defaultValue: 'Refresh' })}
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
                              : 'border-border/70 bg-muted/20 text-muted-foreground hover:text-foreground hover:bg-muted/50'
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
                    className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                    onClick={() => void handleSelectOtherFolder()}
                  >
                    <FolderOpen className="size-3 shrink-0" />
                    {t('input.selectOtherFolder', { defaultValue: 'Select other folder' })}
                  </button>
                </div>

                {/* SSH Connections */}
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
                            <div className="flex-1 min-w-0">
                              <div className="text-[11px] font-medium truncate">{conn.name}</div>
                              <div className="text-[9px] text-muted-foreground/50 truncate">
                                {conn.username}@{conn.host}:{conn.port}
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <button
                                className={cn(
                                  'flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-all duration-200',
                                  isEditingDir
                                    ? 'max-w-0 opacity-0 -translate-x-1 pointer-events-none'
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
                                    : 'max-w-0 opacity-0 pointer-events-none'
                                )}
                              >
                                <Input
                                  value={dirValue}
                                  onChange={(e) =>
                                    setSshDirInputs((prev) => ({
                                      ...prev,
                                      [conn.id]: e.target.value,
                                    }))
                                  }
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleSelectSshFolder(conn.id)
                                    if (e.key === 'Escape') setSshDirEditingId(null)
                                  }}
                                  placeholder={t('input.sshDirectoryPlaceholder', {
                                    defaultValue: '/home/user/project',
                                  })}
                                  className="h-6 w-40 text-[10px] bg-background/60"
                                />
                              </div>
                              <button
                                className={cn(
                                  'shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors',
                                  isEditingDir
                                    ? 'border-primary/50 text-primary'
                                    : 'border-border/70 hover:text-foreground hover:bg-muted/50'
                                )}
                                onClick={() =>
                                  setSshDirEditingId(isEditingDir ? null : conn.id)
                                }
                              >
                                <Pencil className="size-3" />
                              </button>
                              <button
                                className="shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/10 transition-colors"
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
                        defaultValue: 'No SSH connections configured',
                      })}
                    </span>
                  )}
                </div>
              </div>
            </DialogContent>
          </Dialog>
        )}

        {/* Input area */}
        <div className="w-full max-w-3xl">
          <InputArea
            onSend={handleSend}
            onSelectFolder={mode !== 'chat' ? handleOpenFolderDialog : undefined}
            workingFolder={workingFolder}
            hideWorkingFolderIndicator
            isStreaming={false}
          />
        </div>

        {/* Keyboard shortcuts hint */}
        <div className="mt-4 rounded-xl border bg-muted/30 px-5 py-3">
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
              <span className="text-muted-foreground/60">{t('messageList.shortcutsShortcut')}</span>
            </div>
            <div className="flex items-center gap-2">
              <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                Ctrl+,
              </kbd>
              <span className="text-muted-foreground/60">{t('messageList.settingsShortcut')}</span>
            </div>
            <div className="flex items-center gap-2">
              <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                Ctrl+D
              </kbd>
              <span className="text-muted-foreground/60">{t('messageList.duplicateShortcut')}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
