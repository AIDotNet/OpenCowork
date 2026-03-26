import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Save } from 'lucide-react'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { Button } from '@renderer/components/ui/button'
import { CodeEditor } from '@renderer/components/editor/CodeEditor'
import { createSshWorkspace, getParentPath } from '@renderer/lib/monaco/workspace'
import { useSshStore } from '@renderer/stores/ssh-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { toast } from 'sonner'
import { cn } from '@renderer/lib/utils'

interface SshFileEditorProps {
  connectionId: string
  filePath: string
  sessionId?: string
}

function tryParseReadError(value: string): string | null {
  if (!value.trim().startsWith('{')) return null
  try {
    const parsed = JSON.parse(value) as { error?: unknown }
    if (parsed && typeof parsed.error === 'string' && parsed.error.length > 0) {
      return parsed.error
    }
  } catch {
    return null
  }
  return null
}

export function SshFileEditor({
  connectionId,
  filePath,
  sessionId
}: SshFileEditorProps): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const [content, setContent] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [modified, setModified] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const suppressChangeRef = React.useRef(false)

  const explorerPath = useSshStore((s) => (sessionId ? s.fileExplorerPaths[sessionId] : undefined))
  const connectionDefaultDirectory = useSshStore(
    (s) => s.connections.find((connection) => connection.id === connectionId)?.defaultDirectory
  )

  const workspace = React.useMemo(
    () =>
      createSshWorkspace(
        connectionId,
        explorerPath ?? connectionDefaultDirectory ?? getParentPath(filePath)
      ),
    [connectionDefaultDirectory, connectionId, explorerPath, filePath]
  )

  const fileName = React.useMemo(() => {
    const parts = filePath.split('/')
    return parts[parts.length - 1] || filePath
  }, [filePath])

  const loadFile = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await ipcClient.invoke(IPC.SSH_FS_READ_FILE, { connectionId, path: filePath })
      if (typeof result === 'string') {
        const readError = tryParseReadError(result)
        if (readError) {
          setError(readError)
          setContent('')
        } else {
          suppressChangeRef.current = true
          setContent(result)
          setModified(false)
        }
      } else if (result && typeof result === 'object' && 'error' in result) {
        setError(String((result as { error?: string }).error ?? 'Failed to load'))
        setContent('')
      } else {
        setError('Failed to load')
        setContent('')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
      setContent('')
    } finally {
      setLoading(false)
    }
  }, [connectionId, filePath])

  React.useEffect(() => {
    void loadFile()
  }, [loadFile])

  const handleSave = React.useCallback(async () => {
    if (!modified || saving) return
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
      const message = err instanceof Error ? err.message : 'Save failed'
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }, [modified, saving, connectionId, filePath, content, t])

  const handleChange = React.useCallback((value: string) => {
    if (suppressChangeRef.current) {
      suppressChangeRef.current = false
      return
    }
    setContent(value)
    setModified(true)
  }, [])

  const handleOpenFile = React.useCallback(
    (targetPath: string) => {
      useUIStore.getState().openFilePreview(targetPath, undefined, connectionId, sessionId)
    },
    [connectionId, sessionId]
  )

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background text-muted-foreground text-sm">
        <Loader2 className="size-4 animate-spin text-amber-500" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background text-muted-foreground text-xs">
        {error}
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="truncate" title={filePath}>
          {fileName}
        </span>
        {modified && <span className="text-amber-500">●</span>}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60',
            (!modified || saving) && 'opacity-50'
          )}
          onClick={() => void handleSave()}
          disabled={!modified || saving}
        >
          {saving ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
          {t('fileExplorer.save')}
        </Button>
      </div>
      <div className="flex-1 overflow-hidden">
        <CodeEditor
          filePath={filePath}
          content={content}
          onChange={handleChange}
          onOpenFile={handleOpenFile}
          onSave={handleSave}
          workspace={workspace}
        />
      </div>
    </div>
  )
}
