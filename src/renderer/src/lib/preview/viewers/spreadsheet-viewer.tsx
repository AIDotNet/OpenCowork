import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { Undo2, Redo2, Search, Plus, Trash2, Save, FileSpreadsheet } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import type { ViewerProps } from '../viewer-registry'

// --- CSV helpers ---

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

// --- XLSX helpers (lazy-loaded) ---

async function parseXlsx(base64: string): Promise<{ sheets: string[]; data: Map<string, string[][]> }> {
  const XLSX = await import('xlsx')
  const buffer = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const wb = XLSX.read(buffer, { type: 'array' })
  const data = new Map<string, string[][]>()
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name]
    const rows: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
    data.set(name, rows.map((r) => r.map(String)))
  }
  return { sheets: wb.SheetNames, data }
}

async function buildXlsxBase64(sheetsData: Map<string, string[][]>): Promise<string> {
  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()
  for (const [name, rows] of sheetsData) {
    const ws = XLSX.utils.aoa_to_sheet(rows)
    XLSX.utils.book_append_sheet(wb, ws, name)
  }
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }) as string
}

// --- Types ---

interface EditHistory {
  snapshots: string[]
  index: number
}

function getExt(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  return dot >= 0 ? filePath.slice(dot).toLowerCase() : ''
}

// --- Component ---

export function SpreadsheetViewer({ filePath, content, onContentChange, sshConnectionId }: ViewerProps): React.JSX.Element {
  const ext = getExt(filePath)
  const isXlsx = ext === '.xlsx' || ext === '.xls'

  const [data, setData] = useState<string[][]>(() => (isXlsx ? [] : parseCSV(content)))
  const [sheetNames, setSheetNames] = useState<string[]>([])
  const [allSheets, setAllSheets] = useState<Map<string, string[][]>>(new Map())
  const [activeSheet, setActiveSheet] = useState<string>('')
  const [xlsxLoading, setXlsxLoading] = useState(isXlsx)
  const [xlsxError, setXlsxError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const [editingCell, setEditingCell] = useState<{ r: number; c: number } | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [, setHistory] = useState<EditHistory>({ snapshots: [content], index: 0 })
  const inputRef = useRef<HTMLInputElement>(null)

  // Load xlsx binary
  useEffect(() => {
    if (!isXlsx) return
    let cancelled = false
    setXlsxLoading(true)
    setXlsxError(null)
    const channel = sshConnectionId ? IPC.SSH_FS_READ_FILE_BINARY : IPC.FS_READ_FILE_BINARY
    const args = sshConnectionId
      ? { connectionId: sshConnectionId, path: filePath }
      : { path: filePath }
    ipcClient.invoke(channel, args).then(async (raw: unknown) => {
      if (cancelled) return
      const result = raw as { data?: string; error?: string }
      if (result.error || !result.data) {
        setXlsxError(result.error || 'Failed to read file')
        setXlsxLoading(false)
        return
      }
      try {
        const parsed = await parseXlsx(result.data)
        if (cancelled) return
        setSheetNames(parsed.sheets)
        setAllSheets(parsed.data)
        const first = parsed.sheets[0] || ''
        setActiveSheet(first)
        setData(parsed.data.get(first) || [])
      } catch (err) {
        if (!cancelled) setXlsxError(String(err))
      } finally {
        if (!cancelled) setXlsxLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [filePath, isXlsx, sshConnectionId])

  // CSV: sync from content prop
  useEffect(() => {
    if (isXlsx) return
    setData(parseCSV(content))
  }, [content, isXlsx])

  // Switch sheet
  const handleSwitchSheet = useCallback((name: string) => {
    setAllSheets((prev) => {
      const next = new Map(prev)
      next.set(activeSheet, data)
      return next
    })
    setActiveSheet(name)
    setData(allSheets.get(name) || [])
  }, [activeSheet, data, allSheets])

  const pushHistory = useCallback(
    (newData: string[][]) => {
      if (isXlsx) {
        setAllSheets((prev) => {
          const next = new Map(prev)
          next.set(activeSheet, newData)
          return next
        })
      } else {
        const csv = toCSV(newData)
        setHistory((prev) => {
          const snapshots = prev.snapshots.slice(0, prev.index + 1)
          snapshots.push(csv)
          return { snapshots, index: snapshots.length - 1 }
        })
        onContentChange?.(csv)
      }
    },
    [isXlsx, activeSheet, onContentChange]
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
    if (isXlsx) return
    setHistory((prev) => {
      if (prev.index <= 0) return prev
      const newIndex = prev.index - 1
      setData(parseCSV(prev.snapshots[newIndex]))
      onContentChange?.(prev.snapshots[newIndex])
      return { ...prev, index: newIndex }
    })
  }, [isXlsx, onContentChange])

  const redo = useCallback(() => {
    if (isXlsx) return
    setHistory((prev) => {
      if (prev.index >= prev.snapshots.length - 1) return prev
      const newIndex = prev.index + 1
      setData(parseCSV(prev.snapshots[newIndex]))
      onContentChange?.(prev.snapshots[newIndex])
      return { ...prev, index: newIndex }
    })
  }, [isXlsx, onContentChange])

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

  // Save xlsx
  const handleSaveXlsx = useCallback(async () => {
    if (!isXlsx) return
    setSaving(true)
    try {
      const sheets = new Map(allSheets)
      sheets.set(activeSheet, data)
      const base64 = await buildXlsxBase64(sheets)
      const channel = sshConnectionId ? IPC.SSH_FS_WRITE_FILE_BINARY : IPC.FS_WRITE_FILE_BINARY
      const args = sshConnectionId
        ? { connectionId: sshConnectionId, path: filePath, data: base64 }
        : { path: filePath, data: base64 }
      await ipcClient.invoke(channel, args)
    } catch (err) {
      console.error('[SpreadsheetViewer] Save xlsx failed:', err)
    } finally {
      setSaving(false)
    }
  }, [isXlsx, filePath, allSheets, activeSheet, data, sshConnectionId])

  const maxCols = useMemo(() => Math.max(...data.map((r) => r.length), 1), [data])

  const matchesSearch = useCallback(
    (cell: string) => searchTerm && cell.toLowerCase().includes(searchTerm.toLowerCase()),
    [searchTerm]
  )

  if (xlsxLoading) {
    return (
      <div className="flex size-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <FileSpreadsheet className="size-5 animate-pulse" />
        Loading spreadsheet...
      </div>
    )
  }
  if (xlsxError) {
    return (
      <div className="flex size-full items-center justify-center text-sm text-destructive">
        {xlsxError}
      </div>
    )
  }

  return (
    <div className="flex size-full flex-col">
      {/* Toolbar */}
      <div className="flex h-8 items-center gap-1 border-b px-2">
        {!isXlsx && (
          <>
            <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={undo}>
              <Undo2 className="size-3" /> Undo
            </Button>
            <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={redo}>
              <Redo2 className="size-3" /> Redo
            </Button>
            <div className="mx-1 h-4 w-px bg-border" />
          </>
        )}
        <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={addRow}>
          <Plus className="size-3" /> Row
        </Button>
        {isXlsx && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-xs"
            onClick={handleSaveXlsx}
            disabled={saving}
          >
            <Save className="size-3" /> {saving ? 'Saving...' : 'Save'}
          </Button>
        )}
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

      {/* Sheet tabs (xlsx with multiple sheets) */}
      {isXlsx && sheetNames.length > 1 && (
        <div className="flex h-7 items-center gap-0.5 border-b px-2 overflow-x-auto">
          {sheetNames.map((name) => (
            <button
              key={name}
              className={`h-5 rounded px-2 text-[10px] transition-colors ${
                name === activeSheet
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-muted-foreground hover:bg-muted/60'
              }`}
              onClick={() => handleSwitchSheet(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}

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
