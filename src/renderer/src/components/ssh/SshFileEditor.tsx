import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Save } from 'lucide-react'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { Button } from '@renderer/components/ui/button'
import { toast } from 'sonner'
import { cn } from '@renderer/lib/utils'

const MonacoEditor = React.lazy(async () => {
  const mod = await import('@monaco-editor/react')
  return { default: mod.default }
})

interface SshFileEditorProps {
  connectionId: string
  filePath: string
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

function guessLanguage(filePath: string): string {
  const ext = filePath.lastIndexOf('.') >= 0 ? filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase() : ''
  const map: Record<string, string> = {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    json: 'json', md: 'markdown', css: 'css', scss: 'scss', less: 'less',
    html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
    sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell',
    yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
    sql: 'sql', graphql: 'graphql', dockerfile: 'dockerfile',
    vue: 'html', svelte: 'html',
  }
  return map[ext] || 'plaintext'
}

export function SshFileEditor({ connectionId, filePath }: SshFileEditorProps): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const [content, setContent] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [modified, setModified] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const suppressChangeRef = React.useRef(false)
  const editorRef = React.useRef<import('monaco-editor').editor.IStandaloneCodeEditor | null>(null)
  const saveRef = React.useRef<() => void>(() => {})

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

  React.useEffect(() => {
    saveRef.current = () => {
      void handleSave()
    }
  }, [handleSave])

  const handleSave = React.useCallback(async () => {
    if (!modified || saving) return
    setSaving(true)
    try {
      const result = await ipcClient.invoke(IPC.SSH_FS_WRITE_FILE, { connectionId, path: filePath, content })
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

  const handleEditorMount = React.useCallback((editor: import('monaco-editor').editor.IStandaloneCodeEditor, monaco: typeof import('monaco-editor')) => {
    editorRef.current = editor
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveRef.current()
    })
  }, [])

  const handleChange = React.useCallback((value: string | undefined) => {
    if (suppressChangeRef.current) {
      suppressChangeRef.current = false
      return
    }
    setContent(value ?? '')
    setModified(true)
  }, [])

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#0a0a0a] text-zinc-400 text-sm">
        <Loader2 className="size-4 animate-spin text-amber-500" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#0a0a0a] text-zinc-500 text-xs">
        {error}
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#0a0a0a]">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5 text-[11px] text-zinc-400">
        <span className="truncate" title={filePath}>{fileName}</span>
        {modified && <span className="text-amber-500">●</span>}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-6 gap-1 px-2 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800',
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
        <React.Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Loading editor...
            </div>
          }
        >
          <MonacoEditor
            height="100%"
            language={guessLanguage(filePath)}
            theme="vs-dark"
            value={content}
            onChange={handleChange}
            onMount={handleEditorMount}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              lineNumbers: 'on',
              wordWrap: 'on',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
            }}
          />
        </React.Suspense>
      </div>
    </div>
  )
}
