import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Code2, Eye, RefreshCw, Save, Copy, Check, Bot } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useUIStore } from '@renderer/stores/ui-store'
import { useFileWatcher } from '@renderer/hooks/use-file-watcher'
import { viewerRegistry } from '@renderer/lib/preview/viewer-registry'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'

export function PreviewPanel(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const state = useUIStore((s) => s.previewPanelState)
  const closePreviewPanel = useUIStore((s) => s.closePreviewPanel)
  const setViewMode = useUIStore((s) => s.setPreviewViewMode)

  const isMarkdown = state?.source === 'markdown'
  const filePath = state?.source === 'file' ? state.filePath : null
  const { content, setContent, reload } = useFileWatcher(filePath)
  const [modified, setModified] = useState(false)
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [pendingClose, setPendingClose] = useState(false)

  const handleContentChange = useCallback(
    (newContent: string) => {
      setContent(newContent)
      setModified(true)
    },
    [setContent]
  )

  const handleSave = useCallback(async () => {
    if (!state?.filePath) return
    try {
      await ipcClient.invoke(IPC.FS_WRITE_FILE, { path: state.filePath, content })
      setModified(false)
    } catch (err) {
      console.error('[PreviewPanel] Save failed:', err)
    }
  }, [state?.filePath, content])

  const handleClose = useCallback(() => {
    if (modified) {
      setPendingClose(true)
      setShowSaveDialog(true)
    } else {
      closePreviewPanel()
    }
  }, [modified, closePreviewPanel])

  const handleSaveDialogConfirm = useCallback(async () => {
    await handleSave()
    setShowSaveDialog(false)
    if (pendingClose) {
      setPendingClose(false)
      closePreviewPanel()
    }
  }, [handleSave, pendingClose, closePreviewPanel])

  const handleSaveDialogDiscard = useCallback(() => {
    setShowSaveDialog(false)
    setModified(false)
    if (pendingClose) {
      setPendingClose(false)
      closePreviewPanel()
    }
  }, [pendingClose, closePreviewPanel])

  const [copied, setCopied] = useState(false)
  const handleCopyMarkdown = useCallback(() => {
    if (state?.markdownContent) {
      navigator.clipboard.writeText(state.markdownContent)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }, [state?.markdownContent])

  // --- Resize logic ---
  const MIN_WIDTH = 320
  const MAX_WIDTH = 960
  const DEFAULT_WIDTH = 480
  const [panelWidth, setPanelWidth] = useState(DEFAULT_WIDTH)
  const draggingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(DEFAULT_WIDTH)
  const [isDragging, setIsDragging] = useState(false)

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true
    startXRef.current = e.clientX
    startWidthRef.current = panelWidth
    setIsDragging(true)
  }, [panelWidth])

  useEffect(() => {
    if (!isDragging) return
    const onMouseMove = (e: MouseEvent): void => {
      if (!draggingRef.current) return
      const delta = startXRef.current - e.clientX
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidthRef.current + delta))
      setPanelWidth(newWidth)
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

  if (!state) return <div />

  const viewerDef = viewerRegistry.getByType(state.viewerType)
  const ViewerComponent = viewerDef?.component

  const fileName = isMarkdown
    ? (state.markdownTitle || t('preview.markdownPreview'))
    : state.filePath ? state.filePath.split(/[\/\\]/).pop() || state.filePath : t('preview.devServer')

  return (
    <div className="relative flex min-w-0 h-full flex-col border-l bg-background" style={{ width: panelWidth }}>
      {/* Left-edge resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-20 hover:bg-primary/20 active:bg-primary/30 transition-colors"
        onMouseDown={onResizeStart}
      />
      {/* Overlay to prevent iframe from stealing mouse events during drag */}
      {isDragging && <div className="absolute inset-0 z-10" />}
      {/* Header */}
      <div className="flex h-10 items-center gap-2 border-b px-3">
        {isMarkdown && <Bot className="size-3.5 text-violet-500 shrink-0" />}
        <span className="truncate text-xs font-medium">{fileName}</span>
        {modified && <span className="text-[10px] text-amber-500">{t('preview.modified')}</span>}
        <div className="flex-1" />

        {/* View mode toggle (file HTML / Markdown) */}
        {state.source === 'file' && (state.viewerType === 'html' || state.viewerType === 'markdown') && (
          <div className="flex items-center rounded-md border p-0.5">
            <Button
              variant={state.viewMode === 'preview' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-5 gap-1 px-2 text-[10px]"
              onClick={() => setViewMode('preview')}
            >
              <Eye className="size-3" /> {t('preview.preview')}
            </Button>
            <Button
              variant={state.viewMode === 'code' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-5 gap-1 px-2 text-[10px]"
              onClick={() => setViewMode('code')}
            >
              <Code2 className="size-3" /> {t('preview.code')}
            </Button>
          </div>
        )}

        {/* Markdown copy button */}
        {isMarkdown && (
          <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={handleCopyMarkdown}>
            {copied ? <Check className="size-3 text-green-500" /> : <Copy className="size-3" />}
            {copied ? t('preview.copied') : t('action.copy', { ns: 'common' })}
          </Button>
        )}

        {/* File-specific buttons */}
        {!isMarkdown && modified && (
          <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={handleSave}>
            <Save className="size-3" /> {t('action.save', { ns: 'common' })}
          </Button>
        )}
        {!isMarkdown && (
          <Button variant="ghost" size="sm" className="h-6 px-1" onClick={reload}>
            <RefreshCw className="size-3" />
          </Button>
        )}
        <Button variant="ghost" size="sm" className="h-6 px-1" onClick={handleClose}>
          <X className="size-3.5" />
        </Button>
      </div>

      {/* Viewer content */}
      <div className="flex-1 overflow-hidden">
        {isMarkdown ? (
          <div className="size-full overflow-y-auto p-6">
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {state.markdownContent || ''}
              </ReactMarkdown>
            </div>
          </div>
        ) : ViewerComponent ? (
          <ViewerComponent
            filePath={state.filePath}
            content={content}
            viewMode={state.viewMode}
            onContentChange={handleContentChange}
          />
        ) : (
          <div className="flex size-full items-center justify-center text-sm text-muted-foreground">
            {t('preview.noViewer')}
          </div>
        )}
      </div>

      {/* Save confirmation dialog */}
      <AlertDialog open={showSaveDialog} onOpenChange={setShowSaveDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('preview.unsavedChanges')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('preview.unsavedChangesDesc', { fileName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleSaveDialogDiscard}>{t('preview.discard')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleSaveDialogConfirm}>{t('action.save', { ns: 'common' })}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
