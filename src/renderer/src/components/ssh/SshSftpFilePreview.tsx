import * as React from 'react'
import { Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { Code2, Eye, Loader2, RefreshCw, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { CodeEditor } from '@renderer/components/editor/CodeEditor'
import { useFileWatcher } from '@renderer/hooks/use-file-watcher'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { viewerRegistry } from '@renderer/lib/preview/viewer-registry'
import { createSshWorkspace, getParentPath } from '@renderer/lib/monaco/workspace'

interface SshSftpFilePreviewProps {
  connectionId: string
  filePath: string
  workspaceRoot?: string | null
  onOpenFile?: (filePath: string) => void
}

function getViewerType(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : ''
  return viewerRegistry.getByExtension(ext)?.type ?? 'fallback'
}

export function SshSftpFilePreview({
  connectionId,
  filePath,
  workspaceRoot,
  onOpenFile
}: SshSftpFilePreviewProps): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const viewerType = React.useMemo(() => getViewerType(filePath), [filePath])
  const viewerDef = React.useMemo(
    () => viewerRegistry.getByType(viewerType) ?? viewerRegistry.getByType('fallback'),
    [viewerType]
  )
  const Viewer = viewerDef?.component
  const textBased = viewerType === 'fallback' || viewerType === 'markdown' || viewerType === 'html'
  const [viewMode, setViewMode] = React.useState<'preview' | 'code'>(
    viewerType === 'html' || viewerType === 'markdown' ? 'preview' : 'code'
  )
  const [modified, setModified] = React.useState(false)
  const [saving, setSaving] = React.useState(false)

  const { content, setContent, loading, reload } = useFileWatcher(
    textBased ? filePath : null,
    connectionId
  )

  React.useEffect(() => {
    setModified(false)
    setViewMode(viewerType === 'html' || viewerType === 'markdown' ? 'preview' : 'code')
  }, [filePath, viewerType])

  const handleContentChange = React.useCallback(
    (value: string) => {
      setContent(value)
      setModified(true)
    },
    [setContent]
  )

  const handleSave = React.useCallback(async () => {
    if (!textBased || saving || !modified) return
    setSaving(true)
    try {
      const result = await ipcClient.invoke(IPC.SSH_FS_WRITE_FILE, {
        connectionId,
        path: filePath,
        content
      })
      if (result && typeof result === 'object' && 'error' in result) {
        throw new Error(String((result as { error?: string }).error ?? 'Save failed'))
      }
      setModified(false)
      toast.success(t('fileExplorer.saved'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [connectionId, content, filePath, modified, saving, t, textBased])

  const workspace = React.useMemo(
    () => createSshWorkspace(connectionId, workspaceRoot ?? getParentPath(filePath)),
    [connectionId, filePath, workspaceRoot]
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-[#e0e7f0] px-4 py-3">
        {textBased && (viewerType === 'html' || viewerType === 'markdown') ? (
          <div className="flex items-center rounded-[12px] border border-[#d2dbe6] bg-white p-0.5">
            <Button
              variant={viewMode === 'preview' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 gap-1 rounded-[10px] px-2 text-[0.74rem]"
              onClick={() => setViewMode('preview')}
            >
              <Eye className="size-3.5" />
              {t('workspace.sftp.preview', { defaultValue: 'Preview' })}
            </Button>
            <Button
              variant={viewMode === 'code' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 gap-1 rounded-[10px] px-2 text-[0.74rem]"
              onClick={() => setViewMode('code')}
            >
              <Code2 className="size-3.5" />
              {t('workspace.sftp.code', { defaultValue: 'Code' })}
            </Button>
          </div>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {textBased ? (
            <Button
              variant="outline"
              size="sm"
              className="h-8 rounded-[12px] border-[#d0d8e4] bg-white px-3 text-[0.74rem] font-semibold text-[#51627a] shadow-none hover:bg-[#f3f7fb]"
              onClick={() => void reload()}
            >
              <RefreshCw className="size-3.5" />
              {t('fileExplorer.refresh')}
            </Button>
          ) : null}
          {textBased ? (
            <Button
              size="sm"
              className="h-8 rounded-[12px] bg-[#2f8cf3] px-3 text-[0.74rem] font-semibold text-white hover:bg-[#247fe6]"
              onClick={() => void handleSave()}
              disabled={!modified || saving}
            >
              {saving ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Save className="size-3.5" />
              )}
              {t('fileExplorer.save')}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden bg-white">
        {textBased && loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-5 animate-spin text-[#2f8cf3]" />
          </div>
        ) : viewerType === 'fallback' ? (
          <CodeEditor
            filePath={filePath}
            content={content}
            onChange={handleContentChange}
            onSave={handleSave}
            onOpenFile={onOpenFile}
            workspace={workspace}
          />
        ) : Viewer ? (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center">
                <Loader2 className="size-5 animate-spin text-[#2f8cf3]" />
              </div>
            }
          >
            <Viewer
              filePath={filePath}
              content={textBased ? content : ''}
              viewMode={viewMode}
              onContentChange={textBased ? handleContentChange : undefined}
              sshConnectionId={connectionId}
            />
          </Suspense>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No viewer available
          </div>
        )}
      </div>
    </div>
  )
}
