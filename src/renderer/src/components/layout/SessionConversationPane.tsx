import { useCallback, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  Check,
  ClipboardCopy,
  Eraser,
  ExternalLink,
  ImageDown,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@renderer/components/ui/button'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { MessageList } from '@renderer/components/chat/MessageList'
import { ImageEditDialog } from '@renderer/components/chat/ImageEditDialog'
import { InputArea } from '@renderer/components/chat/InputArea'
import { ProjectTerminalDock } from '@renderer/components/terminal/ProjectTerminalDock'
import { WorkingFolderSelectorDialog } from '@renderer/components/chat/WorkingFolderSelectorDialog'
import {
  abortSession,
  clearPendingSessionMessages,
  useChatActions
} from '@renderer/hooks/use-chat-actions'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { openDetachedSessionWindow } from '@renderer/lib/session-window'
import { sessionToMarkdown } from '@renderer/lib/utils/export-chat'
import { cn } from '@renderer/lib/utils'
import { dataUrlToBlob, writeImageBlobToClipboard } from '@renderer/lib/utils/image-clipboard'
import { useChatStore } from '@renderer/stores/chat-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { toast } from 'sonner'

interface SessionConversationPaneProps {
  sessionId?: string | null
  allowOpenInNewWindow?: boolean
  windowHeaderOwnsTitle?: boolean
}

const EXPORT_IMAGE_PLACEHOLDER_DATA_URL = 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA='
const TERMINAL_DOCK_TRANSITION = {
  duration: 0.24,
  ease: [0.22, 1, 0.36, 1] as const
}

function isRemoteImageSrc(value: string | null): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

async function waitForExportImageReady(image: HTMLImageElement): Promise<void> {
  if (image.complete && image.naturalWidth > 0) return

  await new Promise<void>((resolve) => {
    const cleanup = (): void => {
      image.removeEventListener('load', handleDone)
      image.removeEventListener('error', handleDone)
    }

    const handleDone = (): void => {
      cleanup()
      resolve()
    }

    image.addEventListener('load', handleDone, { once: true })
    image.addEventListener('error', handleDone, { once: true })
  })
}

async function inlineRemoteImagesForExport(root: HTMLElement): Promise<void> {
  const images = Array.from(root.querySelectorAll('img'))
  if (images.length === 0) return

  const dataUrlCache = new Map<string, string>()

  await Promise.all(
    images.map(async (image) => {
      const src = image.getAttribute('src')?.trim() || ''
      if (!src) return

      image.removeAttribute('srcset')

      if (!isRemoteImageSrc(src)) {
        await waitForExportImageReady(image)
        return
      }

      let dataUrl = dataUrlCache.get(src)
      if (!dataUrl) {
        try {
          const result = (await window.api.fetchImageBase64({ url: src })) as {
            data?: string
            mimeType?: string
            error?: string
          }
          if (result.error) throw new Error(result.error)
          dataUrl = result.data
            ? `data:${result.mimeType || 'image/png'};base64,${result.data}`
            : EXPORT_IMAGE_PLACEHOLDER_DATA_URL
        } catch {
          dataUrl = EXPORT_IMAGE_PLACEHOLDER_DATA_URL
        }
        dataUrlCache.set(src, dataUrl)
      }

      image.setAttribute('src', dataUrl)
      await waitForExportImageReady(image)
    })
  )
}

export function SessionConversationPane({
  sessionId,
  allowOpenInNewWindow = true,
  windowHeaderOwnsTitle = false
}: SessionConversationPaneProps): React.JSX.Element {
  const { t } = useTranslation('layout')
  const renameSessionLabel = t('sidebar.renameSession', { defaultValue: 'Rename session' }).replace(
    /[:：]\s*$/,
    ''
  )
  const clearConversationLabel = t('layout.clearConversation', {
    defaultValue: 'Clear conversation'
  })
  const resolvedSessionId = useChatStore((state) => sessionId ?? state.activeSessionId)
  const sessionView = useChatStore(
    useShallow((state) => {
      const targetSessionId = sessionId ?? state.activeSessionId
      const currentSession = targetSessionId
        ? state.sessions.find((item) => item.id === targetSessionId)
        : undefined
      const currentProject = currentSession?.projectId
        ? state.projects.find((item) => item.id === currentSession.projectId)
        : undefined

      return {
        sessionId: targetSessionId,
        title: currentSession?.title ?? null,
        projectId: currentSession?.projectId ?? null,
        projectName: currentProject?.name ?? null,
        workingFolder: currentSession?.workingFolder ?? currentProject?.workingFolder,
        sshConnectionId: currentSession?.sshConnectionId ?? currentProject?.sshConnectionId ?? null,
        messageCount: currentSession?.messageCount ?? 0
      }
    })
  )
  const streamingMessageId = useChatStore((state) =>
    resolvedSessionId ? (state.streamingMessages[resolvedSessionId] ?? null) : null
  )
  const terminalDockOpen = useUIStore((state) =>
    sessionView.projectId
      ? Boolean(state.bottomTerminalDockOpenByProjectId[sessionView.projectId])
      : false
  )
  const animationsEnabled = useSettingsStore((state) => state.animationsEnabled)
  const isStreaming = Boolean(streamingMessageId)
  const {
    sendMessage,
    stopStreaming,
    continueLastToolExecution,
    retryLastMessage,
    editAndResend,
    deleteMessage,
    manualCompressContext
  } = useChatActions()
  const updateSessionTitle = useChatStore((state) => state.updateSessionTitle)
  const clearSessionMessages = useChatStore((state) => state.clearSessionMessages)
  const deleteSession = useChatStore((state) => state.deleteSession)
  const [copiedAll, setCopiedAll] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportRendering, setExportRendering] = useState(false)
  const [folderDialogOpen, setFolderDialogOpen] = useState(false)
  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [renameValue, setRenameValue] = useState('')

  const compactSessionHeader = sessionView.messageCount === 0
  const hasProjectFolderAction = Boolean(sessionView.projectId && sessionView.workingFolder)
  const hasTranscriptActions = sessionView.messageCount > 0
  const showSessionActionBar =
    hasProjectFolderAction || hasTranscriptActions || allowOpenInNewWindow
  const showTerminalDock = Boolean(
    sessionView.projectId &&
    terminalDockOpen &&
    (sessionView.workingFolder || sessionView.sshConnectionId)
  )

  const updateSessionProjectDirectory = useCallback(
    async (patch: Partial<{ workingFolder: string | null; sshConnectionId: string | null }>) => {
      const projectId = sessionView.projectId
      if (!projectId) return
      useChatStore.getState().updateProjectDirectory(projectId, patch)
    },
    [sessionView.projectId]
  )

  const handleOpenWorkingFolder = useCallback(async (): Promise<void> => {
    if (!sessionView.workingFolder) return
    await ipcClient.invoke(IPC.SHELL_OPEN_PATH, sessionView.workingFolder)
  }, [sessionView.workingFolder])

  const handleCopyAll = useCallback((): void => {
    if (!resolvedSessionId) return
    const session = useChatStore.getState().sessions.find((item) => item.id === resolvedSessionId)
    if (!session) return
    navigator.clipboard.writeText(sessionToMarkdown(session))
    setCopiedAll(true)
    window.setTimeout(() => setCopiedAll(false), 2000)
  }, [resolvedSessionId])

  const handleExportImage = useCallback(async (): Promise<void> => {
    if (!resolvedSessionId) return
    const session = useChatStore.getState().sessions.find((item) => item.id === resolvedSessionId)
    if (!session) return

    setExporting(true)

    const styleEl = document.createElement('style')
    styleEl.setAttribute('data-export-image', '')
    styleEl.textContent = `
      [data-message-content] * {
        max-width: 100% !important;
        overflow-wrap: break-word !important;
        word-break: break-word !important;
      }
      [data-message-content] pre,
      [data-message-content] code {
        white-space: pre-wrap !important;
        word-break: break-all !important;
      }
      [data-message-content] table {
        table-layout: fixed !important;
        width: 100% !important;
      }
      [data-message-content] img,
      [data-message-content] svg {
        max-width: 100% !important;
        height: auto !important;
      }
    `
    document.head.appendChild(styleEl)

    try {
      await useChatStore.getState().loadSessionMessages(resolvedSessionId, true)
      setExportRendering(true)

      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve())
        })
      })

      const node = document.querySelector('[data-message-content]') as HTMLElement | null
      if (!node) {
        throw new Error('Export target not found')
      }

      const exportStage = document.createElement('div')
      exportStage.setAttribute('data-export-image-stage', '')
      exportStage.style.cssText = [
        'position: fixed',
        'left: -100000px',
        'top: 0',
        'opacity: 0',
        'pointer-events: none',
        `width: ${node.clientWidth}px`
      ].join(';')

      const exportNode = node.cloneNode(true) as HTMLElement
      exportStage.appendChild(exportNode)
      document.body.appendChild(exportStage)

      try {
        await inlineRemoteImagesForExport(exportNode)
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => resolve())
          })
        })

        const bgRaw = getComputedStyle(document.documentElement)
          .getPropertyValue('--background')
          .trim()
        const bgColor = bgRaw ? `hsl(${bgRaw})` : '#ffffff'
        const { toPng } = await import('html-to-image')
        const captureWidth = node.clientWidth
        const captureHeight = Math.max(
          exportNode.scrollHeight,
          exportNode.offsetHeight,
          node.scrollHeight,
          node.offsetHeight
        )
        const dataUrl = await toPng(exportNode, {
          backgroundColor: bgColor,
          pixelRatio: 2,
          width: captureWidth,
          height: captureHeight,
          canvasWidth: captureWidth * 2,
          canvasHeight: captureHeight * 2,
          style: {
            overflow: 'visible',
            maxWidth: `${captureWidth}px`,
            width: `${captureWidth}px`,
            height: `${captureHeight}px`
          }
        })

        await writeImageBlobToClipboard(dataUrlToBlob(dataUrl))
      } finally {
        exportStage.remove()
      }
      toast.success(t('layout.imageCopied', { defaultValue: 'Image copied to clipboard' }))
    } catch (error) {
      console.error('Export image failed:', error)
      toast.error(t('layout.exportImageFailed', { defaultValue: 'Export image failed' }), {
        description: String(error)
      })
    } finally {
      setExportRendering(false)
      document.head.removeChild(styleEl)
      setExporting(false)
    }
  }, [resolvedSessionId, t])

  const handleOpenInWindow = useCallback(async (): Promise<void> => {
    if (!resolvedSessionId) return
    await openDetachedSessionWindow(resolvedSessionId)
  }, [resolvedSessionId])

  const handleOpenRenameDialog = useCallback((): void => {
    const nextTitle = sessionView.title?.trim()
    setRenameValue(nextTitle || '')
    setRenameDialogOpen(true)
  }, [sessionView.title])

  const handleRenameSession = useCallback((): void => {
    if (!resolvedSessionId) return
    const nextTitle = renameValue.trim()
    if (!nextTitle) return
    updateSessionTitle(resolvedSessionId, nextTitle)
    setRenameDialogOpen(false)
  }, [renameValue, resolvedSessionId, updateSessionTitle])

  const handleClearConversation = useCallback(async (): Promise<void> => {
    if (!resolvedSessionId || sessionView.messageCount === 0) return
    const confirmed = await confirm({
      title: t('layout.clearConfirm', { count: sessionView.messageCount }),
      variant: 'destructive'
    })
    if (!confirmed) return
    clearSessionMessages(resolvedSessionId)
    toast.success(t('layout.conversationCleared'))
  }, [clearSessionMessages, resolvedSessionId, sessionView.messageCount, t])

  const handleDeleteSession = useCallback(async (): Promise<void> => {
    if (!resolvedSessionId) return
    const confirmed = await confirm({
      title: t('layout.deleteConfirm', {
        title: sessionView.title ?? t('sidebar.newChat', { defaultValue: 'New chat' })
      }),
      variant: 'destructive'
    })
    if (!confirmed) return
    abortSession(resolvedSessionId)
    clearPendingSessionMessages(resolvedSessionId)
    deleteSession(resolvedSessionId)
  }, [deleteSession, resolvedSessionId, sessionView.title, t])

  const conversationRoot = useMemo(() => resolvedSessionId ?? 'empty', [resolvedSessionId])
  const showInlineSessionTitle = !windowHeaderOwnsTitle

  if (!resolvedSessionId) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {t('sidebar.newChat', { defaultValue: 'New chat' })}
      </div>
    )
  }

  return (
    <div className="relative flex min-w-0 flex-1 flex-col bg-background">
      <div
        className={cn(
          'absolute top-3 right-3 z-20 flex shrink-0 items-center gap-3 pointer-events-none',
          showInlineSessionTitle ? 'left-4 justify-between' : 'justify-end'
        )}
      >
        <div className="min-w-0 pointer-events-auto">
          {showInlineSessionTitle ? (
            <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-background/80 px-2 py-1 shadow-sm backdrop-blur-sm">
              <div
                className={cn(
                  'min-w-0 flex-1 truncate text-foreground',
                  compactSessionHeader ? 'text-[13px] font-medium' : 'text-[14px] font-medium'
                )}
              >
                {sessionView.title ?? t('sidebar.newChat', { defaultValue: 'New chat' })}
              </div>
              {sessionView.projectId ? (
                <div className="flex min-w-0 max-w-[38%] shrink items-center gap-1.5 text-[11px] text-muted-foreground/65">
                  <span className="shrink-0 text-muted-foreground/35">/</span>
                  {sessionView.workingFolder ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="truncate cursor-default">
                          {sessionView.projectName ??
                            t('sidebar.projects', { defaultValue: 'Project' })}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{sessionView.workingFolder}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <span className="truncate">
                      {sessionView.projectName ??
                        t('sidebar.projects', { defaultValue: 'Project' })}
                    </span>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1 pointer-events-auto">
          {showSessionActionBar ? (
            <div className="group flex items-center rounded-lg border border-border/60 bg-background/70 p-0.5 shadow-sm backdrop-blur-sm transition-all duration-300">
              <div className="flex items-center overflow-hidden transition-all duration-300 max-w-0 opacity-0 group-hover:max-w-[200px] group-hover:opacity-100">
                {hasProjectFolderAction ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 rounded-md text-muted-foreground/80 hover:text-foreground shrink-0"
                        onClick={() => void handleOpenWorkingFolder()}
                      >
                        <ExternalLink className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t('layout.openFolder', { defaultValue: 'Open folder' })}
                    </TooltipContent>
                  </Tooltip>
                ) : null}

                {hasProjectFolderAction && hasTranscriptActions ? (
                  <div className="mx-0.5 h-4 w-px bg-border/60 shrink-0" />
                ) : null}

                {hasTranscriptActions ? (
                  <>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 rounded-md text-muted-foreground/80 hover:text-foreground shrink-0"
                          onClick={handleCopyAll}
                          disabled={isStreaming}
                        >
                          {copiedAll ? (
                            <Check className="size-4 text-foreground" />
                          ) : (
                            <ClipboardCopy className="size-4" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {t('layout.copyAll', { defaultValue: 'Copy conversation' })}
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 rounded-md text-muted-foreground/80 hover:text-foreground shrink-0"
                          onClick={() => void handleExportImage()}
                          disabled={exporting || isStreaming}
                        >
                          {exporting ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <ImageDown className="size-4" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {t('layout.exportImage', { defaultValue: 'Copy as image' })}
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 rounded-md text-muted-foreground/80 hover:text-foreground shrink-0"
                          onClick={() => void handleClearConversation()}
                          disabled={isStreaming}
                        >
                          <Eraser className="size-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{clearConversationLabel}</TooltipContent>
                    </Tooltip>
                  </>
                ) : null}
                
                <div className="mx-0.5 mr-1 h-4 w-px bg-border/60 shrink-0" />
              </div>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 rounded-md text-muted-foreground/80 hover:text-foreground"
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  {hasProjectFolderAction ? (
                    <DropdownMenuItem onClick={() => void handleOpenWorkingFolder()}>
                      <ExternalLink className="size-4" />
                      {t('layout.openFolder', { defaultValue: 'Open folder' })}
                    </DropdownMenuItem>
                  ) : null}
                  {allowOpenInNewWindow ? (
                    <DropdownMenuItem onClick={() => void handleOpenInWindow()}>
                      <ExternalLink className="size-4" />
                      {t('sidebar.openInNewWindow', { defaultValue: 'Open in new window' })}
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem onClick={handleOpenRenameDialog}>
                    <Pencil className="size-4" />
                    {renameSessionLabel}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={handleCopyAll}
                    disabled={isStreaming || !hasTranscriptActions}
                  >
                    {copiedAll ? (
                      <Check className="size-4" />
                    ) : (
                      <ClipboardCopy className="size-4" />
                    )}
                    {t('layout.copyAll', { defaultValue: 'Copy conversation' })}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => void handleExportImage()}
                    disabled={exporting || isStreaming || !hasTranscriptActions}
                  >
                    {exporting ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <ImageDown className="size-4" />
                    )}
                    {t('layout.exportImage', { defaultValue: 'Copy as image' })}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => void handleClearConversation()}
                    disabled={sessionView.messageCount === 0}
                  >
                    <Eraser className="size-4" />
                    {clearConversationLabel}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => void handleDeleteSession()}
                  >
                    <Trash2 className="size-4" />
                    {t('layout.deleteConversation', { defaultValue: 'Delete conversation' })}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null}
        </div>
      </div>

      <div key={conversationRoot} className="flex min-h-0 flex-1 flex-col">
        <MessageList
          sessionId={resolvedSessionId}
          onRetry={retryLastMessage}
          onContinue={continueLastToolExecution}
          onEditUserMessage={editAndResend}
          onDeleteMessage={deleteMessage}
          exportAll={exportRendering}
        />
        <InputArea
          sessionId={resolvedSessionId}
          onSend={(text, images, options) =>
            void sendMessage(text, images, undefined, resolvedSessionId, undefined, undefined, {
              ...options,
              clearCompletedTasksOnTurnStart: true
            })
          }
          onStop={stopStreaming}
          onSelectFolder={sessionView.projectId ? () => setFolderDialogOpen(true) : undefined}
          workingFolder={sessionView.workingFolder}
          hideWorkingFolderIndicator
          onCompressContext={manualCompressContext}
          isStreaming={isStreaming}
        />
        {animationsEnabled ? (
          <AnimatePresence initial={false}>
            {showTerminalDock ? (
              <motion.div
                key={`terminal-dock-${sessionView.projectId}`}
                initial={{ height: 0, opacity: 0, y: 12 }}
                animate={{ height: 'auto', opacity: 1, y: 0 }}
                exit={{ height: 0, opacity: 0, y: 12 }}
                transition={{
                  height: TERMINAL_DOCK_TRANSITION,
                  y: TERMINAL_DOCK_TRANSITION,
                  opacity: { duration: 0.16, ease: 'easeOut' }
                }}
                className="min-h-0 overflow-hidden"
                style={{ willChange: 'height, opacity, transform' }}
              >
                <ProjectTerminalDock
                  projectId={sessionView.projectId!}
                  projectName={sessionView.projectName}
                  workingFolder={sessionView.workingFolder ?? null}
                  sshConnectionId={sessionView.sshConnectionId}
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
        ) : showTerminalDock ? (
          <ProjectTerminalDock
            projectId={sessionView.projectId!}
            projectName={sessionView.projectName}
            workingFolder={sessionView.workingFolder ?? null}
            sshConnectionId={sessionView.sshConnectionId}
          />
        ) : null}
      </div>

      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{renameSessionLabel}</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                handleRenameSession()
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDialogOpen(false)}>
              {t('action.cancel', { ns: 'common' })}
            </Button>
            <Button onClick={handleRenameSession} disabled={!renameValue.trim()}>
              {t('action.save', { ns: 'common' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {sessionView.projectId ? (
        <WorkingFolderSelectorDialog
          open={folderDialogOpen}
          onOpenChange={setFolderDialogOpen}
          workingFolder={sessionView.workingFolder}
          sshConnectionId={sessionView.sshConnectionId}
          onSelectLocalFolder={(folderPath) =>
            updateSessionProjectDirectory({
              workingFolder: folderPath,
              sshConnectionId: null
            })
          }
          onSelectSshFolder={(folderPath, connectionId) =>
            updateSessionProjectDirectory({
              workingFolder: folderPath,
              sshConnectionId: connectionId
            })
          }
        />
      ) : null}
      <ImageEditDialog sessionId={resolvedSessionId} />
    </div>
  )
}
