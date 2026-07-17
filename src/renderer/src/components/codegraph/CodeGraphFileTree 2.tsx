import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, FileCode2, Search, Waypoints } from 'lucide-react'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import { useCodeGraphStore, type CgFileNode, type CgNode } from '@renderer/stores/codegraph-store'

interface FileRowProps {
  root: string
  file: CgFileNode
  onSelectSymbol: (node: CgNode) => void
}

function FileRow({ root, file, onSelectSymbol }: FileRowProps): React.JSX.Element {
  const { t } = useTranslation('layout')
  const fileSymbols = useCodeGraphStore((s) => s.fileSymbols)
  const [open, setOpen] = useState(false)
  const [symbols, setSymbols] = useState<CgNode[] | null>(null)
  const [loading, setLoading] = useState(false)

  const toggle = async (): Promise<void> => {
    const next = !open
    setOpen(next)
    if (next && symbols === null && !loading) {
      setLoading(true)
      try {
        setSymbols(await fileSymbols(root, file.path))
      } finally {
        setLoading(false)
      }
    }
  }

  return (
    <div className="border-b last:border-b-0">
      <button
        onClick={() => void toggle()}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-muted/50"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90'
          )}
        />
        <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
          {file.path}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {t('codegraphPage.files.symbols', { count: file.nodeCount })}
        </span>
      </button>
      {open ? (
        <div className="bg-muted/20 pb-1 pl-8 pr-2">
          {loading ? (
            <p className="flex items-center gap-2 py-1.5 text-[11px] text-muted-foreground">
              <Spinner className="size-3" />
              {t('codegraphPage.files.loadingSymbols')}
            </p>
          ) : symbols && symbols.length > 0 ? (
            symbols.map((sym) => (
              <button
                key={sym.id}
                onClick={() => onSelectSymbol(sym)}
                className="group flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-muted"
                title={`${sym.kind} · ${sym.filePath}:${sym.startLine}`}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{sym.name}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">{sym.kind}</span>
                <Waypoints className="size-3 shrink-0 text-muted-foreground/0 group-hover:text-primary" />
              </button>
            ))
          ) : (
            <p className="py-1.5 text-[11px] text-muted-foreground">
              {t('codegraphPage.files.noSymbols')}
            </p>
          )}
        </div>
      ) : null}
    </div>
  )
}

export function CodeGraphFileTree({
  root,
  onSelectSymbol
}: {
  root: string
  onSelectSymbol: (node: CgNode) => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const files = useCodeGraphStore((s) => s.files)
  const filesLoading = useCodeGraphStore((s) => s.filesLoading)
  const loadFiles = useCodeGraphStore((s) => s.loadFiles)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    if (files === null && !filesLoading) void loadFiles(root)
  }, [root, files, filesLoading, loadFiles])

  const filtered = useMemo(() => {
    if (!files) return []
    const q = filter.trim().toLowerCase()
    if (!q) return files
    return files.filter((f) => f.path.toLowerCase().includes(q))
  }, [files, filter])

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b p-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('codegraphPage.files.search')}
            className="w-full rounded-md border bg-background py-1.5 pl-7 pr-2 text-xs outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {filesLoading && files === null ? (
          <div className="flex h-full items-center justify-center">
            <Spinner className="size-4 text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="p-4 text-center text-xs text-muted-foreground">
            {t('codegraphPage.files.empty')}
          </p>
        ) : (
          filtered.map((file) => (
            <FileRow key={file.path} root={root} file={file} onSelectSymbol={onSelectSymbol} />
          ))
        )}
      </div>
    </div>
  )
}
