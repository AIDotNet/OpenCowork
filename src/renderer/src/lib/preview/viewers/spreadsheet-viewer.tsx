import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { Undo2, Redo2, Search, Plus, Trash2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import type { ViewerProps } from '../viewer-registry'

function parseCSV(text: string): string[][] {
  const rows: string[][] = []
  let current = ''
  let inQuotes = false
  let row: string[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        current += '"'
        i++
      } else if (ch === '"') {
        inQuotes = false
      } else {
        current += ch
      }
    } else {
      if (ch === '"') {
        inQuotes = true
      } else if (ch === ',' || ch === '\t') {
        row.push(current)
        current = ''
      } else if (ch === '\n' || ch === '\r') {
        row.push(current)
        current = ''
        if (row.some((c) => c !== '')) rows.push(row)
        row = []
        if (ch === '\r' && text[i + 1] === '\n') i++
      } else {
        current += ch
      }
    }
  }
  row.push(current)
  if (row.some((c) => c !== '')) rows.push(row)
  return rows
}

function toCSV(data: string[][]): string {
  return data
    .map((row) =>
      row.map((cell) => (cell.includes(',') || cell.includes('"') || cell.includes('\n') ? `"${cell.replace(/"/g, '""')}"` : cell)).join(',')
    )
    .join('\n')
}

interface EditHistory {
  snapshots: string[]
  index: number
}

export function SpreadsheetViewer({ content, onContentChange }: ViewerProps): React.JSX.Element {
  const [data, setData] = useState<string[][]>(() => parseCSV(content))
  const [editingCell, setEditingCell] = useState<{ r: number; c: number } | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [, setHistory] = useState<EditHistory>({ snapshots: [content], index: 0 })
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const parsed = parseCSV(content)
    setData(parsed)
  }, [content])

  const pushHistory = useCallback(
    (newData: string[][]) => {
      const csv = toCSV(newData)
      setHistory((prev) => {
        const snapshots = prev.snapshots.slice(0, prev.index + 1)
        snapshots.push(csv)
        return { snapshots, index: snapshots.length - 1 }
      })
      onContentChange?.(csv)
    },
    [onContentChange]
  )

  const updateCell = useCallback(
    (r: number, c: number, value: string) => {
      setData((prev) => {
        const next = prev.map((row) => [...row])
        while (next[r].length <= c) next[r].push('')
        next[r][c] = value
        pushHistory(next)
        return next
      })
    },
    [pushHistory]
  )

  const undo = useCallback(() => {
    setHistory((prev) => {
      if (prev.index <= 0) return prev
      const newIndex = prev.index - 1
      setData(parseCSV(prev.snapshots[newIndex]))
      onContentChange?.(prev.snapshots[newIndex])
      return { ...prev, index: newIndex }
    })
  }, [onContentChange])

  const redo = useCallback(() => {
    setHistory((prev) => {
      if (prev.index >= prev.snapshots.length - 1) return prev
      const newIndex = prev.index + 1
      setData(parseCSV(prev.snapshots[newIndex]))
      onContentChange?.(prev.snapshots[newIndex])
      return { ...prev, index: newIndex }
    })
  }, [onContentChange])

  const addRow = useCallback(() => {
    setData((prev) => {
      const cols = Math.max(...prev.map((r) => r.length), 1)
      const next = [...prev, Array(cols).fill('')]
      pushHistory(next)
      return next
    })
  }, [pushHistory])

  const deleteRow = useCallback(
    (r: number) => {
      setData((prev) => {
        if (prev.length <= 1) return prev
        const next = prev.filter((_, i) => i !== r)
        pushHistory(next)
        return next
      })
    },
    [pushHistory]
  )

  const maxCols = useMemo(() => Math.max(...data.map((r) => r.length), 1), [data])

  const matchesSearch = useCallback(
    (cell: string) => searchTerm && cell.toLowerCase().includes(searchTerm.toLowerCase()),
    [searchTerm]
  )

  return (
    <div className="flex size-full flex-col">
      {/* Toolbar */}
      <div className="flex h-8 items-center gap-1 border-b px-2">
        <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={undo}>
          <Undo2 className="size-3" /> Undo
        </Button>
        <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={redo}>
          <Redo2 className="size-3" /> Redo
        </Button>
        <div className="mx-1 h-4 w-px bg-border" />
        <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={addRow}>
          <Plus className="size-3" /> Row
        </Button>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className={`h-6 gap-1 px-2 text-xs ${showSearch ? 'bg-muted' : ''}`}
          onClick={() => setShowSearch(!showSearch)}
        >
          <Search className="size-3" />
        </Button>
        {showSearch && (
          <input
            className="h-6 w-40 rounded border bg-background px-2 text-xs"
            placeholder="Search..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        )}
        <span className="text-[10px] text-muted-foreground">
          {data.length}×{maxCols}
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr>
              <th className="w-8 border-b border-r px-1 py-0.5 text-center text-[10px] text-muted-foreground">#</th>
              {Array.from({ length: maxCols }, (_, i) => (
                <th key={i} className="min-w-[80px] border-b border-r px-2 py-0.5 text-left font-medium text-muted-foreground">
                  {String.fromCharCode(65 + (i % 26))}
                  {i >= 26 ? String(Math.floor(i / 26)) : ''}
                </th>
              ))}
              <th className="w-6 border-b" />
            </tr>
          </thead>
          <tbody>
            {data.map((row, r) => (
              <tr key={r} className="hover:bg-muted/30">
                <td className="border-b border-r px-1 py-0.5 text-center text-[10px] text-muted-foreground">{r + 1}</td>
                {Array.from({ length: maxCols }, (_, c) => {
                  const cell = row[c] ?? ''
                  const isEditing = editingCell?.r === r && editingCell?.c === c
                  const isMatch = matchesSearch(cell)
                  return (
                    <td
                      key={c}
                      className={`border-b border-r px-0 py-0 ${isMatch ? 'bg-yellow-500/20' : ''}`}
                      onDoubleClick={() => {
                        setEditingCell({ r, c })
                        setTimeout(() => inputRef.current?.focus(), 0)
                      }}
                    >
                      {isEditing ? (
                        <input
                          ref={inputRef}
                          className="w-full bg-background px-2 py-0.5 text-xs outline-none ring-1 ring-primary"
                          defaultValue={cell}
                          onBlur={(e) => {
                            updateCell(r, c, e.target.value)
                            setEditingCell(null)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              updateCell(r, c, (e.target as HTMLInputElement).value)
                              setEditingCell(null)
                            }
                            if (e.key === 'Escape') setEditingCell(null)
                          }}
                        />
                      ) : (
                        <div className="truncate px-2 py-0.5">{cell}</div>
                      )}
                    </td>
                  )
                })}
                <td className="border-b px-0 py-0">
                  <button
                    className="flex size-full items-center justify-center text-muted-foreground/30 hover:text-destructive"
                    onClick={() => deleteRow(r)}
                  >
                    <Trash2 className="size-3" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
