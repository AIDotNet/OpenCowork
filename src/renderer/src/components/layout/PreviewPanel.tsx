import { useCallback, useState } from 'react'
import { X, Code2, Eye, RefreshCw, Save } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useUIStore } from '@renderer/stores/ui-store'
import { useFileWatcher } from '@renderer/hooks/use-file-watcher'
import { viewerRegistry } from '@renderer/lib/preview/viewer-registry'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
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
  const state = useUIStore((s) => s.previewPanelState)
  const closePreviewPanel = useUIStore((s) => s.closePreviewPanel)
  const setViewMode = useUIStore((s) => s.setPreviewViewMode)

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

  if (!state) return <div />

  const viewerDef = viewerRegistry.getByType(state.viewerType)
  const ViewerComponent = viewerDef?.component

  const fileName = state.filePath ? state.filePath.split(/[\\/]/).pop() || state.filePath : 'Dev Server'

  return (
    <div className="flex min-w-0 flex-1 flex-col border-l bg-background">
      {/* Header */}
      <div className="flex h-10 items-center gap-2 border-b px-3">
        <span className="truncate text-xs font-medium">{fileName}</span>
        {modified && <span className="text-[10px] text-amber-500">modified</span>}
        <div className="flex-1" />

        {/* View mode toggle */}
        {state.source === 'file' && state.viewerType === 'html' && (
          <div className="flex items-center rounded-md border p-0.5">
            <Button
              variant={state.viewMode === 'preview' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-5 gap-1 px-2 text-[10px]"
              onClick={() => setViewMode('preview')}
            >
              <Eye className="size-3" /> Preview
            </Button>
            <Button
              variant={state.viewMode === 'code' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-5 gap-1 px-2 text-[10px]"
              onClick={() => setViewMode('code')}
            >
              <Code2 className="size-3" /> Code
            </Button>
          </div>
        )}

        {modified && (
          <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={handleSave}>
            <Save className="size-3" /> Save
          </Button>
        )}
        <Button variant="ghost" size="sm" className="h-6 px-1" onClick={reload}>
          <RefreshCw className="size-3" />
        </Button>
        <Button variant="ghost" size="sm" className="h-6 px-1" onClick={handleClose}>
          <X className="size-3.5" />
        </Button>
      </div>

      {/* Viewer content */}
      <div className="flex-1 overflow-hidden">
        {ViewerComponent ? (
          <ViewerComponent
            filePath={state.filePath}
            content={content}
            viewMode={state.viewMode}
            onContentChange={handleContentChange}
          />
        ) : (
          <div className="flex size-full items-center justify-center text-sm text-muted-foreground">
            No viewer available for this file type
          </div>
        )}
      </div>

      {/* Save confirmation dialog */}
      <AlertDialog open={showSaveDialog} onOpenChange={setShowSaveDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes to {fileName}. What would you like to do?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleSaveDialogDiscard}>Discard</AlertDialogCancel>
            <AlertDialogAction onClick={handleSaveDialogConfirm}>Save</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
