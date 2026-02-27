import { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, FilePen, CheckCircle2, XCircle, Copy, Check, Eye, Trash2, ChevronDown, ChevronUp } from 'lucide-react'
import { Badge } from '@renderer/components/ui/badge'
import { Separator } from '@renderer/components/ui/separator'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { cn } from '@renderer/lib/utils'

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])
const DELETE_TOOLS = new Set(['Delete'])

const PREVIEWABLE_EXTENSIONS = new Set(['.html', '.htm', '.md', '.mdx', '.markdown', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico', '.docx', '.pdf'])
const SPREADSHEET_EXTENSIONS = new Set(['.csv', '.tsv', '.xls', '.xlsx'])

function getFileExtension(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  return dot >= 0 ? filePath.slice(dot).toLowerCase() : ''
}

export function ArtifactsPanel(): React.JSX.Element {
  const { t } = useTranslation('cowork')
  const executedToolCalls = useAgentStore((s) => s.executedToolCalls)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [loadingContent, setLoadingContent] = useState(false)
  const [showPreview, setShowPreview] = useState(true)

  const handleCopyPath = useCallback((id: string, path: string) => {
    navigator.clipboard.writeText(path)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 1500)
  }, [])

  const handleOpenPreview = useCallback((path: string) => {
    if (!path) return
    useUIStore.getState().openFilePreview(path)
  }, [])

  const handleSelectFile = useCallback((path: string) => {
    setSelectedFilePath(path)
  }, [])

  const fileOps = executedToolCalls.filter((tc) => FILE_TOOLS.has(tc.name))
  const deleteOps = executedToolCalls.filter((tc) => DELETE_TOOLS.has(tc.name))

  // Auto-select the most recent file
  useEffect(() => {
    if (fileOps.length > 0 && !selectedFilePath) {
      const latestFile = fileOps[fileOps.length - 1]
      const path = String(latestFile.input.file_path ?? latestFile.input.path ?? '')
      setSelectedFilePath(path)
    }
  }, [fileOps, selectedFilePath])

  // Load file content when selected
  useEffect(() => {
    if (!selectedFilePath) {
      setFileContent(null)
      return
    }

    const loadContent = async (): Promise<void> => {
      setLoadingContent(true)
      try {
        const result = await ipcClient.invoke(IPC.FS_READ_FILE, { path: selectedFilePath })
        if (result && typeof result === 'object' && 'content' in result) {
          setFileContent(result.content as string)
        }
      } catch (err) {
        console.error('[ArtifactsPanel] Failed to load file:', err)
        setFileContent(null)
      } finally {
        setLoadingContent(false)
      }
    }

    void loadContent()
  }, [selectedFilePath])

  if (fileOps.length === 0 && deleteOps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <FileText className="mb-3 size-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">{t('artifacts.noArtifacts')}</p>
        <p className="mt-1 text-xs text-muted-foreground/60">
          {t('artifacts.noArtifactsDesc')}
        </p>
      </div>
    )
  }

  // Deduplicate by file path, keeping latest operation + count
  const fileMap = new Map<string, { tc: typeof fileOps[0]; count: number; ops: Set<string> }>()
  for (const tc of fileOps) {
    const fp = String(tc.input.file_path ?? tc.input.path ?? '')
    const existing = fileMap.get(fp)
    if (existing) {
      existing.tc = tc
      existing.count++
      existing.ops.add(tc.name)
    } else {
      fileMap.set(fp, { tc, count: 1, ops: new Set([tc.name]) })
    }
  }
  const uniqueFiles = Array.from(fileMap.values())

  return (
    <div className="flex flex-col h-full">
      <div className="space-y-2 flex-shrink-0">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {t('artifacts.modifiedFiles')}
          </h4>
          <div className="flex items-center gap-1">
            {uniqueFiles.filter((f) => f.ops.has('Write')).length > 0 && (
              <Badge variant="secondary" className="text-[10px] gap-0.5">
                <FileText className="size-2.5" />
                {t('artifacts.new', { count: uniqueFiles.filter((f) => f.ops.has('Write')).length })}
              </Badge>
            )}
            {uniqueFiles.filter((f) => !f.ops.has('Write')).length > 0 && (
              <Badge variant="secondary" className="text-[10px] gap-0.5">
                <FilePen className="size-2.5" />
                {t('artifacts.edited', { count: uniqueFiles.filter((f) => !f.ops.has('Write')).length })}
              </Badge>
            )}
          </div>
        </div>
        <div className="space-y-0.5 max-h-[200px] overflow-y-auto">
          {uniqueFiles.map(({ tc, count, ops }) => {
            const filePath = String(tc.input.file_path ?? tc.input.path ?? '')
            const fileName = filePath.split(/[\\/]/).pop() || filePath
            const isError = tc.status === 'error'
            const isCopied = copiedId === tc.id
            const ext = getFileExtension(filePath)
            const isPreviewable = PREVIEWABLE_EXTENSIONS.has(ext) || SPREADSHEET_EXTENSIONS.has(ext)
            const isSelected = selectedFilePath === filePath

            return (
              <button
                key={tc.id}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors group",
                  isSelected ? "bg-muted" : "hover:bg-muted/50"
                )}
                onClick={() => handleSelectFile(filePath)}
                title={filePath}
              >
                {ops.has('Write') ? (
                  <FileText className="size-3.5 shrink-0 text-blue-500" />
                ) : (
                  <FilePen className="size-3.5 shrink-0 text-amber-500" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-xs">{fileName}</div>
                  <div className="flex items-center gap-1 text-[10px] text-muted-foreground/50">
                    <span className="truncate">{filePath}</span>
                    {count > 1 && <span className="shrink-0 text-muted-foreground/30">{count}×</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {isPreviewable && (
                    <button
                      type="button"
                      className="rounded-full p-1 text-blue-500/60 hover:bg-muted/70"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleOpenPreview(filePath)
                      }}
                      title={t('artifacts.openInPreview')}
                    >
                      <Eye className="size-3.5 shrink-0" />
                    </button>
                  )}
                  {isError ? (
                    <XCircle className="size-3.5 shrink-0 text-destructive" />
                  ) : (
                    <CheckCircle2 className="size-3.5 shrink-0 text-green-500" />
                  )}
                  <button
                    type="button"
                    className="rounded-full p-1 text-muted-foreground hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleCopyPath(tc.id, filePath)
                    }}
                    aria-label={t('artifacts.copyPath')}
                  >
                    {isCopied ? (
                      <Check className="size-3 text-green-500" />
                    ) : (
                      <Copy className="size-3" />
                    )}
                  </button>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* File Preview Section */}
      {selectedFilePath && (
        <>
          <Separator className="my-2" />
          <div className="flex-1 flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {t('artifacts.preview')}
              </h4>
              <button
                className="text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setShowPreview(!showPreview)}
              >
                {showPreview ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
              </button>
            </div>
            {showPreview && (
              <div className="flex-1 min-h-0 rounded-md border bg-muted/20 overflow-hidden">
                {loadingContent ? (
                  <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                    {t('artifacts.loading')}
                  </div>
                ) : fileContent ? (
                  <pre className="h-full overflow-auto p-3 text-[10px] leading-relaxed font-mono">
                    <code>{fileContent}</code>
                  </pre>
                ) : (
                  <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                    {t('artifacts.noPreview')}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* Deleted Files */}
      {deleteOps.length > 0 && (
        <>
          <Separator className="my-2" />
          <div className="space-y-2 flex-shrink-0">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {t('artifacts.deletedFiles')}
              </h4>
              <Badge variant="destructive" className="text-[10px] gap-0.5">
                <Trash2 className="size-2.5" />
                {deleteOps.length}
              </Badge>
            </div>
            <div className="space-y-0.5">
              {deleteOps.map((tc) => {
                const fp = String(tc.input.file_path ?? tc.input.path ?? '')
                const fileName = fp.split(/[\\/]/).pop() || fp
                return (
                  <button
                    key={tc.id}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/50 transition-colors group"
                    onClick={() => handleCopyPath(tc.id, fp)}
                    title={`${fp}\nClick to copy path`}
                  >
                    <Trash2 className="size-3.5 shrink-0 text-destructive/70" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-xs line-through text-muted-foreground">{fileName}</div>
                      <div className="truncate text-[10px] text-muted-foreground/50">{fp}</div>
                    </div>
                    {copiedId === tc.id ? (
                      <Check className="size-3 shrink-0 text-green-500" />
                    ) : tc.status === 'error' ? (
                      <XCircle className="size-3.5 shrink-0 text-destructive" />
                    ) : (
                      <Copy className="size-3.5 shrink-0 text-muted-foreground hidden group-hover:block" />
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
