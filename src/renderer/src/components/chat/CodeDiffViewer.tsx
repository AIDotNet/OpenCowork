import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { MONO_FONT } from '@renderer/lib/constants'
import { useSettingsStore } from '@renderer/stores/settings-store'

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
  mode?: 'split' | 'inline'
  showModeToggle?: boolean
  toolbarEnd?: React.ReactNode
  /** Fill the parent's height instead of capping the diff at a fixed max height. */
  fillHeight?: boolean
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

function rowTone(line: DiffViewerLine | undefined): string {
  if (!line) return 'bg-background dark:bg-[#111214]'
  if (line.type === 'add') return 'bg-emerald-500/8'
  if (line.type === 'del') return 'bg-red-500/8'
  return 'bg-background dark:bg-[#111214]'
}

export function CodeDiffViewer({
  chunks,
  defaultMode = 'split',
  mode,
  showModeToggle = true,
  toolbarEnd,
  fillHeight = false
}: CodeDiffViewerProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const persistedViewMode = useSettingsStore((state) => state.fileDiffViewMode)
  const updateSettings = useSettingsStore((state) => state.updateSettings)
  const [expandedChunks, setExpandedChunks] = React.useState<Set<number>>(new Set())
  const viewMode = mode ?? persistedViewMode ?? defaultMode

  React.useEffect(() => {
    setExpandedChunks(new Set())
  }, [chunks, viewMode])

  const renderInlineLine = (line: DiffViewerLine, key: number): React.JSX.Element => {
    const lineNumber = line.oldNum ?? line.newNum ?? ''
    const marker = line.type === 'del' ? '-' : line.type === 'add' ? '+' : ' '

    return (
      <div
        key={key}
        className={cn(
          'grid grid-cols-[18px_56px_minmax(0,1fr)] border-b border-border/60 text-[11px] leading-5 last:border-b-0 dark:border-zinc-900/80',
          rowTone(line)
        )}
      >
        <span
          className={cn(
            'flex select-none items-start justify-center px-1 py-1 font-semibold',
            line.type === 'del' && 'text-red-600 dark:text-red-300',
            line.type === 'add' && 'text-emerald-600 dark:text-emerald-300',
            line.type === 'keep' && 'text-muted-foreground/60 dark:text-zinc-700'
          )}
        >
          {marker}
        </span>
        <span className="select-none border-x border-border/60 px-2 py-1 text-right text-muted-foreground dark:border-zinc-800/80 dark:text-zinc-500">
          {lineNumber}
        </span>
        <span
          className={cn(
            'min-w-0 whitespace-pre-wrap break-all px-3 py-1',
            line.type === 'del' && 'text-red-700 dark:text-red-100/90',
            line.type === 'add' && 'text-emerald-700 dark:text-emerald-100/90',
            line.type === 'keep' && 'text-foreground/85 dark:text-zinc-300/90'
          )}
        >
          {line.text || ' '}
        </span>
      </div>
    )
  }

  const renderSplitCell = (
    line: DiffViewerLine | undefined,
    side: 'left' | 'right'
  ): React.JSX.Element => {
    const isDelete = side === 'left' && line?.type === 'del'
    const isAdd = side === 'right' && line?.type === 'add'
    const lineNumber = side === 'left' ? line?.oldNum : line?.newNum

    return (
      <div
        className={cn(
          'grid min-w-0 grid-cols-[56px_minmax(0,1fr)] border-b border-border/60 last:border-b-0 dark:border-zinc-900/80',
          side === 'left' && 'border-r border-border/60 dark:border-zinc-800/80',
          isDelete && 'bg-red-500/8',
          isAdd && 'bg-emerald-500/8',
          !isDelete && !isAdd && 'bg-background dark:bg-[#111214]'
        )}
      >
        <span className="select-none border-r border-border/60 px-2 py-1 text-right text-[11px] text-muted-foreground dark:border-zinc-800/80 dark:text-zinc-500">
          {lineNumber ?? ''}
        </span>
        <span
          className={cn(
            'min-w-0 whitespace-pre-wrap break-all px-3 py-1 text-[11px] leading-5',
            isDelete && 'text-red-700 dark:text-red-100/90',
            isAdd && 'text-emerald-700 dark:text-emerald-100/90',
            !isDelete &&
              !isAdd &&
              (line ? 'text-foreground/85 dark:text-zinc-300/90' : 'text-transparent')
          )}
        >
          {line?.text ?? ' '}
        </span>
      </div>
    )
  }

  return (
    <div className={cn(fillHeight ? 'flex h-full min-h-0 flex-col gap-2' : 'space-y-2')}>
      {showModeToggle || toolbarEnd ? (
        <div className="flex items-center justify-between gap-3">
          {showModeToggle ? (
            <div className="inline-flex items-center rounded-md border border-border/60 bg-muted/30 p-0.5 text-[10px] dark:border-zinc-800/80 dark:bg-[#111214]">
              <button
                type="button"
                onClick={() => updateSettings({ fileDiffViewMode: 'inline' })}
                className={cn(
                  'rounded px-2 py-1 transition-colors',
                  viewMode === 'inline'
                    ? 'bg-background text-foreground shadow-sm dark:bg-zinc-800 dark:text-zinc-100'
                    : 'text-muted-foreground hover:text-foreground dark:text-zinc-500 dark:hover:text-zinc-200'
                )}
              >
                {t('diffViewer.inline', { defaultValue: 'Inline' })}
              </button>
              <button
                type="button"
                onClick={() => updateSettings({ fileDiffViewMode: 'split' })}
                className={cn(
                  'rounded px-2 py-1 transition-colors',
                  viewMode === 'split'
                    ? 'bg-background text-foreground shadow-sm dark:bg-zinc-800 dark:text-zinc-100'
                    : 'text-muted-foreground hover:text-foreground dark:text-zinc-500 dark:hover:text-zinc-200'
                )}
              >
                {t('diffViewer.sideBySide', { defaultValue: 'Split' })}
              </button>
            </div>
          ) : (
            <div />
          )}
          {toolbarEnd ? (
            <div className="flex items-center justify-end gap-2 text-[10px] text-muted-foreground">
              {toolbarEnd}
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        className={cn(
          'overflow-hidden rounded-lg border border-border/60 bg-background/80 shadow-[0_0_0_1px_rgba(255,255,255,0.02)] dark:border-zinc-800/80 dark:bg-[#111214]',
          fillHeight && 'flex min-h-0 flex-1 flex-col'
        )}
        style={{ fontFamily: MONO_FONT }}
      >
        {viewMode === 'split' ? (
          <div
            className={cn(fillHeight ? 'min-h-0 flex-1 overflow-auto' : 'max-h-80 overflow-auto')}
          >
            <div className="sticky top-0 z-10 grid grid-cols-2 border-b border-border/60 bg-muted/70 text-[10px] uppercase tracking-[0.14em] text-muted-foreground dark:border-zinc-800/80 dark:bg-[#15171a] dark:text-zinc-500">
              <div className="border-r border-border/60 px-3 py-2 dark:border-zinc-800/80">
                {t('diffViewer.before', { defaultValue: 'Before' })}
              </div>
              <div className="px-3 py-2">{t('diffViewer.after', { defaultValue: 'After' })}</div>
            </div>
            {chunks.map((chunk, ci) => {
              if (chunk.type === 'lines' || expandedChunks.has(ci)) {
                return buildSplitRows(chunk.lines).map((row, rowIndex) => (
                  <div key={`split-${ci}-${rowIndex}`} className="grid grid-cols-2">
                    {renderSplitCell(row.left, 'left')}
                    {renderSplitCell(row.right, 'right')}
                  </div>
                ))
              }

              return (
                <button
                  key={`split-collapsed-${ci}`}
                  type="button"
                  className="flex w-full items-center justify-center border-b border-border/60 bg-muted/40 px-3 py-2 text-[10px] text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground dark:border-zinc-800/80 dark:bg-[#15171a]/60 dark:text-zinc-500 dark:hover:bg-[#1a1d21] dark:hover:text-zinc-200"
                  onClick={() => setExpandedChunks((prev) => new Set([...prev, ci]))}
                >
                  {t('diffViewer.unchangedLines', {
                    count: chunk.count,
                    defaultValue: 'Show {{count}} unchanged lines'
                  })}
                </button>
              )
            })}
          </div>
        ) : (
          <div
            className={cn(fillHeight ? 'min-h-0 flex-1 overflow-auto' : 'max-h-80 overflow-auto')}
          >
            {chunks.map((chunk, ci) => {
              if (chunk.type === 'lines' || expandedChunks.has(ci)) {
                return chunk.lines.map((line, li) => renderInlineLine(line, ci * 1000 + li))
              }

              return (
                <button
                  key={`inline-collapsed-${ci}`}
                  type="button"
                  className="flex w-full items-center justify-center border-y border-border/60 bg-muted/40 px-3 py-2 text-[10px] text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground dark:border-zinc-800/80 dark:bg-[#15171a]/60 dark:text-zinc-500 dark:hover:bg-[#1a1d21] dark:hover:text-zinc-200"
                  onClick={() => setExpandedChunks((prev) => new Set([...prev, ci]))}
                >
                  {t('diffViewer.unchangedLines', {
                    count: chunk.count,
                    defaultValue: 'Show {{count}} unchanged lines'
                  })}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
