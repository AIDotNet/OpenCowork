import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { MONO_FONT } from '@renderer/lib/constants'

export type DiffViewerLine = {
  type: 'keep' | 'add' | 'del'
  text: string
  oldNum?: number
  newNum?: number
}

export type DiffViewerChunk =
  | { type: 'lines'; lines: DiffViewerLine[] }
  | { type: 'collapsed'; count: number; lines: DiffViewerLine[] }

interface CodeDiffViewerProps {
  chunks: DiffViewerChunk[]
  defaultMode?: 'split' | 'inline'
  toolbarEnd?: React.ReactNode
}

function buildSplitRows(
  lines: DiffViewerLine[]
): Array<{ left?: DiffViewerLine; right?: DiffViewerLine }> {
  const rows: Array<{ left?: DiffViewerLine; right?: DiffViewerLine }> = []
  let deleted: DiffViewerLine[] = []
  let added: DiffViewerLine[] = []

  const flushChanges = (): void => {
    if (deleted.length === 0 && added.length === 0) return
    const rowCount = Math.max(deleted.length, added.length)
    for (let index = 0; index < rowCount; index += 1) {
      rows.push({ left: deleted[index], right: added[index] })
    }
    deleted = []
    added = []
  }

  for (const line of lines) {
    if (line.type === 'keep') {
      flushChanges()
      rows.push({ left: line, right: line })
      continue
    }

    if (line.type === 'del') {
      deleted.push(line)
    } else {
      added.push(line)
    }
  }

  flushChanges()
  return rows
}

export function CodeDiffViewer({
  chunks,
  defaultMode = 'split',
  toolbarEnd
}: CodeDiffViewerProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const [expandedChunks, setExpandedChunks] = React.useState<Set<number>>(new Set())
  const [viewMode, setViewMode] = React.useState<'split' | 'inline'>(defaultMode)

  React.useEffect(() => {
    setExpandedChunks(new Set())
  }, [chunks, viewMode])

  const renderInlineLine = (line: DiffViewerLine, key: number): React.JSX.Element => (
    <div
      key={key}
      className={cn(
        'flex',
        line.type === 'del' && 'bg-red-500/10',
        line.type === 'add' && 'bg-green-500/10'
      )}
    >
      <span
        className={cn(
          'select-none w-5 shrink-0 text-right pr-1',
          line.type === 'del'
            ? 'text-red-600/50 dark:text-red-400/40'
            : line.type === 'add'
              ? 'text-green-600/50 dark:text-green-400/40'
              : 'text-muted-foreground/70 dark:text-zinc-600'
        )}
      >
        {line.oldNum ?? line.newNum ?? ''}
      </span>
      <span
        className={cn(
          'px-1.5 flex-1 whitespace-pre-wrap break-all',
          line.type === 'del' && 'text-red-700/85 dark:text-red-300/80',
          line.type === 'add' && 'text-green-700/85 dark:text-green-300/80',
          line.type === 'keep' && 'text-foreground/70 dark:text-zinc-500'
        )}
      >
        {line.type === 'del' ? '- ' : line.type === 'add' ? '+ ' : '  '}
        {line.text}
      </span>
    </div>
  )

  const renderSplitCell = (
    line: DiffViewerLine | undefined,
    side: 'left' | 'right'
  ): React.JSX.Element => {
    const isDelete = side === 'left' && line?.type === 'del'
    const isAdd = side === 'right' && line?.type === 'add'
    const isKeep = line?.type === 'keep'
    const lineNumber = side === 'left' ? line?.oldNum : line?.newNum

    return (
      <div
        className={cn(
          'flex min-w-0',
          side === 'left' && 'border-r border-border/50',
          isDelete && 'bg-red-500/10',
          isAdd && 'bg-green-500/10',
          isKeep && 'bg-background/20',
          !line && 'bg-background/10'
        )}
      >
        <span
          className={cn(
            'select-none w-10 shrink-0 border-r border-border/30 px-1.5 py-0.5 text-right',
            isDelete
              ? 'text-red-600/50 dark:text-red-400/40'
              : isAdd
                ? 'text-green-600/50 dark:text-green-400/40'
                : 'text-muted-foreground/70 dark:text-zinc-600'
          )}
        >
          {lineNumber ?? ''}
        </span>
        <span
          className={cn(
            'min-w-0 flex-1 whitespace-pre-wrap break-all px-2 py-0.5',
            isDelete && 'text-red-700/85 dark:text-red-300/80',
            isAdd && 'text-green-700/85 dark:text-green-300/80',
            isKeep && 'text-foreground/70 dark:text-zinc-500',
            !line && 'text-transparent'
          )}
        >
          {line?.text ?? ' '}
        </span>
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex items-center rounded-md border bg-background/60 p-0.5 text-[10px]">
          <button
            type="button"
            onClick={() => setViewMode('split')}
            className={cn(
              'rounded px-2 py-1 transition-colors',
              viewMode === 'split'
                ? 'bg-muted text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {t('diffViewer.sideBySide', { defaultValue: '左右对比' })}
          </button>
          <button
            type="button"
            onClick={() => setViewMode('inline')}
            className={cn(
              'rounded px-2 py-1 transition-colors',
              viewMode === 'inline'
                ? 'bg-muted text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {t('diffViewer.inline', { defaultValue: '单列对比' })}
          </button>
        </div>
        {toolbarEnd ? (
          <div className="flex items-center justify-end gap-2 text-[10px] text-muted-foreground/60">
            {toolbarEnd}
          </div>
        ) : null}
      </div>
      <div
        className="max-h-64 overflow-auto rounded-md border bg-muted/30 text-[11px] font-mono leading-relaxed dark:bg-zinc-950"
        style={{ fontFamily: MONO_FONT }}
      >
        {viewMode === 'split' ? (
          <div className="min-w-[420px]">
            <div className="sticky top-0 z-10 grid grid-cols-2 border-b border-border/50 bg-background/95 text-[10px] uppercase tracking-wide text-muted-foreground/50 dark:bg-zinc-950/95">
              <div className="border-r border-border/50 px-2 py-1">
                {t('diffViewer.before', { defaultValue: '修改前' })}
              </div>
              <div className="px-2 py-1">{t('diffViewer.after', { defaultValue: '修改后' })}</div>
            </div>
            {chunks.map((chunk, ci) => {
              if (chunk.type === 'lines' || expandedChunks.has(ci)) {
                return buildSplitRows(chunk.lines).map((row, rowIndex) => (
                  <div
                    key={`split-${ci}-${rowIndex}`}
                    className="grid grid-cols-2 border-b border-border/30 last:border-b-0"
                  >
                    {renderSplitCell(row.left, 'left')}
                    {renderSplitCell(row.right, 'right')}
                  </div>
                ))
              }

              return (
                <button
                  key={`c${ci}`}
                  type="button"
                  className="flex w-full items-center justify-center border-b border-border/30 py-0.5 text-[9px] text-muted-foreground/60 transition-colors hover:bg-muted/40 hover:text-foreground dark:text-zinc-500/50 dark:hover:bg-zinc-800/30 dark:hover:text-zinc-400"
                  onClick={() => setExpandedChunks((prev) => new Set([...prev, ci]))}
                >
                  {t('diffViewer.unchangedLines', {
                    count: chunk.count,
                    defaultValue: '显示 {{count}} 行未改动内容'
                  })}
                </button>
              )
            })}
          </div>
        ) : (
          chunks.map((chunk, ci) => {
            if (chunk.type === 'lines') {
              return chunk.lines.map((line, li) => renderInlineLine(line, ci * 1000 + li))
            }

            if (expandedChunks.has(ci)) {
              return chunk.lines.map((line, li) => renderInlineLine(line, ci * 1000 + li))
            }

            return (
              <button
                key={`c${ci}`}
                type="button"
                className="flex w-full items-center justify-center border-y border-border/50 py-0.5 text-[9px] text-muted-foreground/60 transition-colors hover:bg-muted/40 hover:text-foreground dark:border-zinc-800/30 dark:text-zinc-500/50 dark:hover:bg-zinc-800/30 dark:hover:text-zinc-400"
                onClick={() => setExpandedChunks((prev) => new Set([...prev, ci]))}
              >
                {t('diffViewer.unchangedLines', {
                  count: chunk.count,
                  defaultValue: '显示 {{count}} 行未改动内容'
                })}
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
