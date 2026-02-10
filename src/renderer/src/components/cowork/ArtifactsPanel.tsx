import { useState, useCallback } from 'react'
import { FileText, FilePen, CheckCircle2, XCircle, Copy, Check, Eye, Trash2, Table2 } from 'lucide-react'
import { Badge } from '@renderer/components/ui/badge'
import { Separator } from '@renderer/components/ui/separator'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useUIStore } from '@renderer/stores/ui-store'

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])
const DELETE_TOOLS = new Set(['Delete'])

const PREVIEWABLE_EXTENSIONS = new Set(['.html', '.htm'])
const SPREADSHEET_EXTENSIONS = new Set(['.csv', '.tsv', '.xls', '.xlsx'])

function getFileExtension(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  return dot >= 0 ? filePath.slice(dot).toLowerCase() : ''
}

export function ArtifactsPanel(): React.JSX.Element {
  const executedToolCalls = useAgentStore((s) => s.executedToolCalls)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const handleCopyPath = useCallback((id: string, path: string) => {
    navigator.clipboard.writeText(path)
    useUIStore.getState().setPendingInsertText(path.split(/[\\/]/).slice(-2).join('/'))
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 1500)
  }, [])

  const fileOps = executedToolCalls.filter((tc) => FILE_TOOLS.has(tc.name))
  const deleteOps = executedToolCalls.filter((tc) => DELETE_TOOLS.has(tc.name))

  if (fileOps.length === 0 && deleteOps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <FileText className="mb-3 size-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">No artifacts yet</p>
        <p className="mt-1 text-xs text-muted-foreground/60">
          Files created or edited by the assistant will appear here
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
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Modified Files
        </h4>
        <div className="flex items-center gap-1">
          {uniqueFiles.filter((f) => f.ops.has('Write')).length > 0 && (
            <Badge variant="secondary" className="text-[10px] gap-0.5">
              <FileText className="size-2.5" />
              {uniqueFiles.filter((f) => f.ops.has('Write')).length} new
            </Badge>
          )}
          {uniqueFiles.filter((f) => !f.ops.has('Write')).length > 0 && (
            <Badge variant="secondary" className="text-[10px] gap-0.5">
              <FilePen className="size-2.5" />
              {uniqueFiles.filter((f) => !f.ops.has('Write')).length} edited
            </Badge>
          )}
        </div>
      </div>
      <div className="space-y-0.5">
        {uniqueFiles.map(({ tc, count, ops }) => {
          const filePath = String(tc.input.file_path ?? tc.input.path ?? '')
          const fileName = filePath.split(/[\\/]/).pop() || filePath
          const isError = tc.status === 'error'
          const isCopied = copiedId === tc.id
          const ext = getFileExtension(filePath)
          const isPreviewable = PREVIEWABLE_EXTENSIONS.has(ext) || SPREADSHEET_EXTENSIONS.has(ext)

          return (
            <button
              key={tc.id}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/50 transition-colors group"
              onClick={() => {
                if (isPreviewable) {
                  useUIStore.getState().openFilePreview(filePath)
                } else {
                  handleCopyPath(tc.id, filePath)
                }
              }}
              title={isPreviewable ? `${filePath}\nClick to preview` : `${filePath}\nClick to copy path`}
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
              <div className="flex items-center gap-0.5 shrink-0">
                {PREVIEWABLE_EXTENSIONS.has(ext) && (
                  <Eye className="size-3.5 shrink-0 text-blue-500" />
                )}
                {SPREADSHEET_EXTENSIONS.has(ext) && (
                  <Table2 className="size-3.5 shrink-0 text-green-500" />
                )}
                {isPreviewable && (
                  <button
                    className="size-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleCopyPath(tc.id, filePath)
                    }}
                    title="Copy path"
                  >
                    {isCopied ? <Check className="size-3" /> : <Copy className="size-3" />}
                  </button>
                )}
                {!isPreviewable && (
                  <>
                    {isCopied ? (
                      <Check className="size-3 shrink-0 text-green-500" />
                    ) : isError ? (
                      <XCircle className="size-3.5 shrink-0 text-destructive" />
                    ) : (
                      <>
                        <CheckCircle2 className="size-3.5 shrink-0 text-green-500 group-hover:hidden" />
                        <Copy className="size-3.5 shrink-0 text-muted-foreground hidden group-hover:block" />
                      </>
                    )}
                  </>
                )}
              </div>
            </button>
          )
        })}
      </div>

      {/* Deleted Files */}
      {deleteOps.length > 0 && (
        <>
          {fileOps.length > 0 && <Separator className="my-2" />}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Deleted Files
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
