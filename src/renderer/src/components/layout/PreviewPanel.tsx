import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bot,
  Check,
  Code2,
  Columns2,
  Copy,
  ExternalLink,
  Eye,
  File,
  FileDiff,
  FileOutput,
  FolderOpen,
  Globe,
  PanelRightClose,
  Plus,
  RefreshCw,
  Rows2,
  Save,
  X
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { useChatStore } from '@renderer/stores/chat-store'
import { useAppPluginStore } from '@renderer/stores/app-plugin-store'
import { useGitStore } from '@renderer/stores/git-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { MonacoDiffEditor } from '@renderer/components/editor/MonacoDiffEditor'
import { useUIStore, type PreviewPanelTab } from '@renderer/stores/ui-store'
import { useFileWatcher } from '@renderer/hooks/use-file-watcher'
import { viewerRegistry } from '@renderer/lib/preview/viewer-registry'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import {
  createMarkdownComponents,
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS
} from '@renderer/lib/preview/viewers/markdown-components'
import { BROWSER_PLUGIN_ID } from '@renderer/lib/app-plugin/types'
import { cn } from '@renderer/lib/utils'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@renderer/components/ui/alert-dialog'

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}

function relativePath(filePath: string, workingFolder?: string | null): string {
  if (!workingFolder) return filePath
  const normalizedFile = filePath.replace(/\\/g, '/')
  const normalizedFolder = workingFolder.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalizedFile.toLowerCase().startsWith(`${normalizedFolder.toLowerCase()}/`)) {
    return filePath
  }
  return normalizedFile.slice(normalizedFolder.length + 1)
}

function breadcrumbParts(filePath: string, workingFolder?: string | null): string[] {
  return relativePath(filePath, workingFolder)
    .split(/[\\/]+/)
    .filter(Boolean)
}

function fileExtension(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  return dot >= 0 ? filePath.slice(dot).toLowerCase() : ''
}

function isExternalUrl(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value)
}

function shouldReadPreviewText(tab: PreviewPanelTab | null): boolean {
  if (!tab || tab.source !== 'file') return false
  if (tab.viewerType === 'html' || tab.viewerType === 'svg' || tab.viewerType === 'markdown') {
    return true
  }
  if (tab.viewerType === 'spreadsheet') {
    const ext = fileExtension(tab.filePath)
    return ext === '.csv' || ext === '.tsv'
  }
  return tab.viewerType === 'fallback'
}

function tabTitle(tab: PreviewPanelTab): string {
  if (tab.source === 'markdown') return tab.markdownTitle || tab.title
  if (tab.source === 'dev-server') return tab.title
  return fileName(tab.filePath)
}

function tabPathTitle(tab: PreviewPanelTab): string {
  if (tab.source === 'markdown') return tab.markdownTitle || tab.title
  if (tab.source === 'dev-server') return tab.projectDir || tab.title
  return tab.filePath
}

function TabIcon({ tab }: { tab: PreviewPanelTab }): React.JSX.Element {
  if (tab.source === 'markdown') return <Bot className="size-3.5 text-violet-500" />
  if (tab.source === 'dev-server') return <Globe className="size-3.5 text-sky-500" />
  if (tab.source === 'diff') return <FileDiff className="size-3.5 text-amber-500" />
  return <File className="size-3.5 text-muted-foreground" />
}

export function PreviewPanel({
  embedded = false,
  showTabStrip = !embedded
}: {
  embedded?: boolean
  showTabStrip?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const tabs = useUIStore((s) => s.previewPanelTabs)
  const activeTabId = useUIStore((s) => s.activePreviewPanelTabId)
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null
  const closePreviewTab = useUIStore((s) => s.closePreviewTab)
  const setActivePreviewTab = useUIStore((s) => s.setActivePreviewTab)
  const updatePreviewTab = useUIStore((s) => s.updatePreviewTab)
  const setViewMode = useUIStore((s) => s.setPreviewViewMode)
  const setRightPanelOpen = useUIStore((s) => s.setRightPanelOpen)
  const setRightPanelTab = useUIStore((s) => s.setRightPanelTab)
  const activeProjectId = useChatStore((state) => state.activeProjectId)
  const browserPluginEnabled = useAppPluginStore((state) =>
    Boolean(state.getPlugin(BROWSER_PLUGIN_ID, activeProjectId)?.enabled)
  )
  const workingFolder = useChatStore((state) => {
    const activeSession = state.sessions.find((session) => session.id === state.activeSessionId)
    const activeProject = activeSession?.projectId
      ? state.projects.find((project) => project.id === activeSession.projectId)
      : null
    return activeSession?.workingFolder ?? activeProject?.workingFolder ?? null
  })

  const watchedFilePath =
    activeTab?.source === 'file' && !isExternalUrl(activeTab.filePath) ? activeTab.filePath : null
  const shouldReadActiveFileText = shouldReadPreviewText(activeTab)
  const {
    content: fileContent,
    setContent,
    loading: fileLoading,
    reload,
    version: fileVersion
  } = useFileWatcher(watchedFilePath, activeTab?.sshConnectionId, {
    readContent: shouldReadActiveFileText
  })
  const content =
    activeTab?.modified && activeTab.draftContent !== undefined
      ? activeTab.draftContent
      : fileContent
  const isMarkdown = activeTab?.source === 'markdown'
  const isDiff = activeTab?.source === 'diff'
  const diffViewMode = useSettingsStore((s) => s.fileDiffViewMode)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const diffModifiedValue =
    activeTab && isDiff ? (activeTab.draftContent ?? activeTab.diffModified ?? '') : ''
  const viewerDef = activeTab ? viewerRegistry.getByType(activeTab.viewerType) : undefined
  const ViewerComponent = viewerDef?.component
  const [copied, setCopied] = useState(false)
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null)
  const pendingCloseTab = tabs.find((tab) => tab.id === pendingCloseTabId) ?? null

  const fileDisplayName = activeTab
    ? tabTitle(activeTab)
    : t('rightPanel.preview', { defaultValue: 'Preview' })
  const pendingFileDisplayName = pendingCloseTab ? tabTitle(pendingCloseTab) : fileDisplayName
  const canOpenInSystem =
    activeTab?.source === 'file' && !!activeTab.filePath && !activeTab.sshConnectionId
  const canToggleViewMode =
    activeTab?.source === 'file' &&
    (activeTab.viewerType === 'html' ||
      activeTab.viewerType === 'svg' ||
      activeTab.viewerType === 'markdown')
  const activeFilePath = activeTab?.source === 'file' ? activeTab.filePath : ''
  const breadcrumbs = activeFilePath ? breadcrumbParts(activeFilePath, workingFolder) : []

  const MIN_WIDTH = 320
  const MAX_WIDTH = 960
  const DEFAULT_WIDTH = 480
  const [panelWidth, setPanelWidth] = useState(DEFAULT_WIDTH)
  const draggingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(DEFAULT_WIDTH)
  const [isDragging, setIsDragging] = useState(false)

  const onResizeStart = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      draggingRef.current = true
      startXRef.current = event.clientX
      startWidthRef.current = panelWidth
      setIsDragging(true)
    },
    [panelWidth]
  )

  useEffect(() => {
    if (!isDragging) return

    const onMouseMove = (event: MouseEvent): void => {
      if (!draggingRef.current) return
      const delta = startXRef.current - event.clientX
      setPanelWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidthRef.current + delta)))
    }
    const onMouseUp = (): void => {
      draggingRef.current = false
      setIsDragging(false)
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [isDragging])

  const handleContentChange = (newContent: string): void => {
    if (!activeTab) return
    if (activeTab.source === 'file') setContent(newContent)
    updatePreviewTab(activeTab.id, {
      draftContent: newContent,
      modified: true
    })
  }

  const saveTab = async (tab: PreviewPanelTab): Promise<boolean> => {
    const isEditableDiff = tab.source === 'diff' && Boolean(tab.diffModifiedEditable)
    if ((tab.source !== 'file' && !isEditableDiff) || !tab.filePath) return false

    const tabContent = isEditableDiff
      ? (tab.draftContent ?? tab.diffModified ?? '')
      : tab.id === activeTab?.id
        ? content
        : tab.draftContent
    if (tabContent === undefined) return false

    try {
      const channel = tab.sshConnectionId ? IPC.SSH_FS_WRITE_FILE : IPC.FS_WRITE_FILE
      const args = tab.sshConnectionId
        ? { connectionId: tab.sshConnectionId, path: tab.filePath, content: tabContent }
        : { path: tab.filePath, content: tabContent }
      await ipcClient.invoke(channel, args)
      if (isEditableDiff) {
        // The on-disk file now matches the modified side; refresh git state so
        // the SCM list and any cached diff reflect the save.
        updatePreviewTab(tab.id, {
          draftContent: undefined,
          modified: false,
          diffModified: tabContent
        })
        if (tab.gitRepoPath) {
          useGitStore.getState().invalidateFileDiff(tab.gitRepoPath, tab.filePath)
          void useGitStore.getState().refreshRepository(tab.gitRepoPath)
        }
      } else {
        if (tab.id === activeTab?.id) setContent(tabContent)
        updatePreviewTab(tab.id, {
          draftContent: undefined,
          modified: false
        })
      }
      return true
    } catch (err) {
      console.error('[PreviewPanel] Save failed:', err)
      return false
    }
  }

  const handleSave = async (): Promise<void> => {
    if (!activeTab) return
    await saveTab(activeTab)
  }

  const handleSaveDialogOpenChange = (open: boolean): void => {
    setShowSaveDialog(open)
    if (!open) setPendingCloseTabId(null)
  }

  const handleSaveDialogConfirm = async (): Promise<void> => {
    const tabToClose = tabs.find((tab) => tab.id === pendingCloseTabId)
    if (!tabToClose) {
      setShowSaveDialog(false)
      setPendingCloseTabId(null)
      return
    }

    const saved = await saveTab(tabToClose)
    if (!saved) return

    setShowSaveDialog(false)
    closePreviewTab(tabToClose.id)
    setPendingCloseTabId(null)
  }

  const handleSaveDialogDiscard = (): void => {
    if (pendingCloseTabId) {
      updatePreviewTab(pendingCloseTabId, {
        draftContent: undefined,
        modified: false
      })
      closePreviewTab(pendingCloseTabId)
    }
    setPendingCloseTabId(null)
    setShowSaveDialog(false)
  }

  const handleReload = (): void => {
    try {
      if (activeTab?.modified) {
        updatePreviewTab(activeTab.id, {
          draftContent: undefined,
          modified: false
        })
      }
      void reload()
    } catch (err) {
      console.error('[PreviewPanel] Reload failed:', err)
    }
  }

  const handleOpenInSystem = async (): Promise<void> => {
    if (!activeTab?.filePath || activeTab.sshConnectionId) return
    try {
      await ipcClient.invoke(IPC.SHELL_OPEN_PATH, activeTab.filePath)
    } catch (err) {
      console.error('[PreviewPanel] Open in system app failed:', err)
    }
  }

  const requestCloseTab = (tab: PreviewPanelTab): void => {
    if (tab.modified) {
      setActivePreviewTab(tab.id)
      setPendingCloseTabId(tab.id)
      setShowSaveDialog(true)
      return
    }
    closePreviewTab(tab.id)
  }

  const handleCopyMarkdown = (): void => {
    if (!activeTab?.markdownContent) return
    navigator.clipboard.writeText(activeTab.markdownContent)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const handleOpenLocalFiles = async (): Promise<void> => {
    const result = (await ipcClient.invoke(IPC.FS_SELECT_FILE, {
      multiSelections: true
    })) as { canceled?: boolean; path?: string; paths?: string[] }
    if (result.canceled) return

    const selectedPaths = result.paths?.length ? result.paths : result.path ? [result.path] : []
    for (const selectedPath of selectedPaths) {
      useUIStore.getState().openFilePreview(selectedPath)
    }
  }

  if (!activeTab) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        {showTabStrip ? (
          <div className="flex h-10 shrink-0 items-center justify-end border-b border-border/50 px-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7">
                  <Plus className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onSelect={() => void handleOpenLocalFiles()}>
                  <FolderOpen className="size-4" />
                  {t('preview.openFile', { defaultValue: 'Open file' })}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              onClick={() => setRightPanelOpen(false)}
              title={t('rightPanelAction.closePanel', { defaultValue: 'Close panel' })}
            >
              <PanelRightClose className="size-4" />
            </Button>
          </div>
        ) : null}
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          {t('rightPanel.previewEmpty', { defaultValue: 'No preview content' })}
        </div>
      </div>
    )
  }

  return (
    <div
      className="relative flex h-full min-h-0 min-w-0 flex-col bg-background"
      style={embedded ? undefined : { width: panelWidth }}
    >
      {!embedded && (
        <div
          className="absolute bottom-0 left-0 top-0 z-20 w-1 cursor-col-resize transition-colors hover:bg-primary/20 active:bg-primary/30"
          onMouseDown={onResizeStart}
        />
      )}
      {isDragging && !embedded && <div className="absolute inset-0 z-10" />}

      {showTabStrip ? (
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/50 bg-background px-1">
          <div className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto pt-1">
            {tabs.map((tab) => {
              const active = tab.id === activeTab.id
              return (
                <div
                  key={tab.id}
                  className={cn(
                    'group flex h-8 min-w-0 max-w-48 shrink-0 items-center gap-1.5 rounded-t-md border border-transparent px-2 text-left text-xs transition-colors',
                    active
                      ? 'border-border/70 border-b-background bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  )}
                  title={tabPathTitle(tab)}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    onClick={() => setActivePreviewTab(tab.id)}
                  >
                    <TabIcon tab={tab} />
                    <span className="min-w-0 truncate">{tabTitle(tab)}</span>
                    {tab.modified && (
                      <span
                        className="size-1.5 shrink-0 rounded-full bg-amber-500"
                        title={t('preview.modified')}
                      />
                    )}
                  </button>
                  <button
                    type="button"
                    className="ml-0.5 rounded p-0.5 opacity-60 transition-opacity hover:bg-muted hover:opacity-100"
                    title={t('action.close', { ns: 'common' })}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      requestCloseTab(tab)
                    }}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              )
            })}
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7 shrink-0">
                <Plus className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onSelect={() => void handleOpenLocalFiles()}>
                <FolderOpen className="size-4" />
                {t('preview.openFile', { defaultValue: 'Open file' })}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {browserPluginEnabled && (
                <DropdownMenuItem onSelect={() => setRightPanelTab('browser')}>
                  <Globe className="size-4" />
                  {t('rightPanel.browser')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => setRightPanelTab('artifacts')}>
                <FileOutput className="size-4" />
                {t('rightPanel.artifacts')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => setRightPanelOpen(false)}
            title={t('rightPanelAction.closePanel', { defaultValue: 'Close panel' })}
          >
            <PanelRightClose className="size-4" />
          </Button>
        </div>
      ) : null}

      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/40 bg-muted/20 px-3">
        <div className="flex min-w-0 flex-1 items-center gap-1 text-[11px] text-muted-foreground">
          {isMarkdown ? (
            <>
              <Bot className="size-3.5 shrink-0 text-violet-500" />
              <span className="truncate text-foreground">{fileDisplayName}</span>
            </>
          ) : breadcrumbs.length > 0 ? (
            breadcrumbs.map((part, index) => (
              <span key={`${part}-${index}`} className="flex min-w-0 items-center gap-1">
                {index > 0 && <span className="text-muted-foreground/50">/</span>}
                <span
                  className={cn(
                    'truncate',
                    index === breadcrumbs.length - 1 && 'font-medium text-foreground'
                  )}
                >
                  {part}
                </span>
              </span>
            ))
          ) : (
            <span className="truncate text-foreground">{fileDisplayName}</span>
          )}
        </div>

        {canToggleViewMode && (
          <div className="flex shrink-0 items-center rounded-md border border-border/60 bg-background p-0.5">
            <Button
              variant={activeTab.viewMode === 'preview' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-5 gap-1 px-2 text-[10px]"
              onClick={() => setViewMode('preview')}
            >
              <Eye className="size-3" />
              {t('preview.preview')}
            </Button>
            <Button
              variant={activeTab.viewMode === 'code' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-5 gap-1 px-2 text-[10px]"
              onClick={() => setViewMode('code')}
            >
              <Code2 className="size-3" />
              {t('preview.code')}
            </Button>
          </div>
        )}

        {isMarkdown && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={handleCopyMarkdown}
            title={copied ? t('preview.copied') : t('action.copy', { ns: 'common' })}
          >
            {copied ? <Check className="size-3.5 text-green-500" /> : <Copy className="size-3.5" />}
          </Button>
        )}

        {isDiff && (
          <div className="flex shrink-0 items-center rounded-md border border-border/60 bg-background p-0.5">
            <Button
              variant={diffViewMode !== 'inline' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-5 gap-1 px-2 text-[10px]"
              onClick={() => updateSettings({ fileDiffViewMode: 'split' })}
              title={t('preview.diffSplit', { defaultValue: 'Split' })}
            >
              <Columns2 className="size-3" />
            </Button>
            <Button
              variant={diffViewMode === 'inline' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-5 gap-1 px-2 text-[10px]"
              onClick={() => updateSettings({ fileDiffViewMode: 'inline' })}
              title={t('preview.diffInline', { defaultValue: 'Inline' })}
            >
              <Rows2 className="size-3" />
            </Button>
          </div>
        )}

        {isDiff && activeTab.diffModifiedEditable && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={() => void handleSave()}
            disabled={!activeTab.modified}
            title={t('action.save', { ns: 'common' })}
          >
            <Save className="size-3.5" />
          </Button>
        )}

        {activeTab.source === 'file' && (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              onClick={() => void handleSave()}
              disabled={!activeTab.modified}
              title={t('action.save', { ns: 'common' })}
            >
              <Save className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              onClick={handleReload}
              title={t('action.refresh', { ns: 'common', defaultValue: 'Refresh' })}
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </>
        )}

        {canOpenInSystem && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={() => void handleOpenInSystem()}
            title={t('preview.openInSystem')}
          >
            <ExternalLink className="size-3.5" />
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {isDiff ? (
          <MonacoDiffEditor
            filePath={activeTab.filePath}
            original={activeTab.diffOriginal ?? ''}
            modified={diffModifiedValue}
            language={activeTab.diffLanguage}
            modifiedEditable={Boolean(activeTab.diffModifiedEditable)}
            renderSideBySide={diffViewMode !== 'inline'}
            isBinary={Boolean(activeTab.diffIsBinary)}
            onModifiedChange={handleContentChange}
            onSave={handleSave}
          />
        ) : isMarkdown ? (
          <div className="size-full overflow-y-auto p-6">
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown
                remarkPlugins={MARKDOWN_REMARK_PLUGINS}
                rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
                components={createMarkdownComponents()}
              >
                {activeTab.markdownContent || ''}
              </ReactMarkdown>
            </div>
          </div>
        ) : fileLoading && !activeTab.modified ? (
          <div className="flex size-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <RefreshCw className="size-4 animate-spin" />
            Loading preview...
          </div>
        ) : ViewerComponent ? (
          <Suspense
            fallback={
              <div className="flex size-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <RefreshCw className="size-4 animate-spin" />
                Loading preview...
              </div>
            }
          >
            <ViewerComponent
              filePath={activeTab.filePath}
              content={content}
              viewMode={activeTab.viewMode}
              onContentChange={handleContentChange}
              onSave={handleSave}
              sshConnectionId={activeTab.sshConnectionId}
              initialLine={activeTab.targetLine}
              initialColumn={activeTab.targetColumn}
              initialPositionKey={activeTab.targetPositionKey}
              fileVersion={fileVersion}
            />
          </Suspense>
        ) : (
          <div className="flex size-full items-center justify-center text-sm text-muted-foreground">
            {t('preview.noViewer')}
          </div>
        )}
      </div>

      <AlertDialog open={showSaveDialog} onOpenChange={handleSaveDialogOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('preview.unsavedChanges')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('preview.unsavedChangesDesc', { fileName: pendingFileDisplayName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={(event) => {
                event.preventDefault()
                handleSaveDialogDiscard()
              }}
            >
              {t('preview.discard')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                void handleSaveDialogConfirm()
              }}
            >
              {t('action.save', { ns: 'common' })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
