import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileSpreadsheet, TriangleAlert } from 'lucide-react'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { useUIStore } from '@renderer/stores/ui-store'
import type { ViewerProps } from '../../viewer-registry'
import type { CellData, CellStyle, Selection, SheetModel, WorkbookModel } from './types'
import {
  DEFAULT_COL_WIDTH_PX,
  DEFAULT_ROW_HEIGHT_PX,
  cellKey,
  cellRef,
  columnLabel,
  normalizeSelection,
  selectionRef
} from './types'
import { formatCellText, parseCellInput } from './number-format'
import { recalculate } from './formula'
import { createEmptySheet, parseWorkbook, serializeWorkbook } from './workbook-io'
import { SheetGrid } from './SheetGrid'
import { FormulaBar, SheetTabBar, StatusBar } from './Chrome'
import { Ribbon, type RibbonCommand } from './Ribbon'

const EXCELJS_FORMATS = new Set(['.xlsx', '.xlsm'])
const LEGACY_FORMATS = new Set(['.xls', '.xlsb', '.ods'])

function getExt(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  return dot >= 0 ? filePath.slice(dot).toLowerCase() : ''
}

/* ---------- delimited text ---------- */

function parseDelimited(text: string, delimiter: string): SheetModel {
  const sheet = createEmptySheet('Sheet1')
  let row = 0
  let col = 0
  let current = ''
  let quoted = false

  const push = (): void => {
    if (current !== '') {
      const parsed = parseCellInput(current)
      sheet.cells.set(cellKey(row, col), {
        value: parsed.value,
        formula: parsed.formula,
        styleId: 0,
        text: formatCellText(parsed.value)
      })
    }
    current = ''
    col++
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        current += '"'
        i++
      } else if (ch === '"') quoted = false
      else current += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === delimiter) push()
    else if (ch === '\n' || ch === '\r') {
      push()
      if (ch === '\r' && text[i + 1] === '\n') i++
      row++
      col = 0
    } else current += ch
  }
  push()

  sheet.rows = Math.max(row + 20, sheet.rows)
  let maxCol = 0
  for (const key of sheet.cells.keys()) maxCol = Math.max(maxCol, Number(key.split(',')[1]))
  sheet.cols = Math.max(maxCol + 5, sheet.cols)
  sheet.colWidths = new Array<number>(sheet.cols).fill(DEFAULT_COL_WIDTH_PX)
  sheet.rowHeights = new Array<number>(sheet.rows).fill(DEFAULT_ROW_HEIGHT_PX)
  return sheet
}

function serializeDelimited(sheet: SheetModel, delimiter: string): string {
  let maxRow = -1
  let maxCol = -1
  for (const key of sheet.cells.keys()) {
    const [r, c] = key.split(',').map(Number)
    maxRow = Math.max(maxRow, r)
    maxCol = Math.max(maxCol, c)
  }
  const lines: string[] = []
  for (let r = 0; r <= maxRow; r++) {
    const cells: string[] = []
    for (let c = 0; c <= maxCol; c++) {
      const cell = sheet.cells.get(cellKey(r, c))
      const raw = cell?.formula ? `=${cell.formula}` : (cell?.text ?? '')
      cells.push(
        raw.includes(delimiter) || raw.includes('"') || raw.includes('\n')
          ? `"${raw.replace(/"/g, '""')}"`
          : raw
      )
    }
    lines.push(cells.join(delimiter))
  }
  return lines.join('\n')
}

/* ---------- undo ---------- */

type UndoEntry =
  | { kind: 'cells'; sheet: string; entries: Array<[string, CellData | undefined]> }
  | { kind: 'sheet'; sheet: string; before: SheetModel }

function cloneSheet(sheet: SheetModel): SheetModel {
  return {
    ...sheet,
    cells: new Map([...sheet.cells].map(([k, v]) => [k, { ...v }])),
    merges: sheet.merges.map((m) => ({ ...m })),
    colWidths: [...sheet.colWidths],
    rowHeights: [...sheet.rowHeights]
  }
}

/* ---------- component ---------- */

export function SpreadsheetViewer({
  filePath,
  content,
  onContentChange,
  sshConnectionId,
  fileVersion
}: ViewerProps): React.JSX.Element {
  const ext = getExt(filePath)
  const isDelimited = ext === '.csv' || ext === '.tsv'
  const isLegacy = LEGACY_FORMATS.has(ext)
  const canSave = isDelimited || EXCELJS_FORMATS.has(ext)

  const [model, setModel] = useState<WorkbookModel | null>(null)
  const [activeSheetName, setActiveSheetName] = useState('')
  const [loading, setLoading] = useState(!isDelimited)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [selection, setSelection] = useState<Selection>({
    anchor: { r: 0, c: 0 },
    focus: { r: 0, c: 0 }
  })
  const [editing, setEditing] = useState<{ r: number; c: number; initial: string } | null>(null)
  const [formulaDraft, setFormulaDraft] = useState<string | null>(null)

  const originalRef = useRef<string>('')
  const undoRef = useRef<UndoEntry[]>([])
  const redoRef = useRef<UndoEntry[]>([])
  const [historyTick, setHistoryTick] = useState(0)

  const sheet = useMemo(
    () => model?.sheets.find((s) => s.name === activeSheetName) ?? model?.sheets[0],
    [model, activeSheetName]
  )

  /* ---- tab dirty flag (fixes the close-without-warning gap) ---- */
  useEffect(() => {
    if (isDelimited) return
    const state = useUIStore.getState()
    const tab = state.previewPanelTabs.find((item) => item.filePath === filePath)
    if (tab) state.updatePreviewTab(tab.id, { modified: dirty })
  }, [dirty, filePath, isDelimited])

  /* ---- load ---- */
  useEffect(() => {
    if (isDelimited) {
      const delimiter = ext === '.tsv' ? '\t' : ','
      setModel({ sheets: [parseDelimited(content, delimiter)], styles: [{}] })
      setActiveSheetName('Sheet1')
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    const channel = sshConnectionId ? IPC.SSH_FS_READ_FILE_BINARY : IPC.FS_READ_FILE_BINARY
    const args = sshConnectionId
      ? { connectionId: sshConnectionId, path: filePath }
      : { path: filePath }

    void ipcClient.invoke(channel, args).then(async (raw: unknown) => {
      if (cancelled) return
      const result = raw as { data?: string; error?: string }
      if (result.error || !result.data) {
        setError(result.error || 'Failed to read file')
        setLoading(false)
        return
      }
      originalRef.current = result.data
      try {
        const parsed = isLegacy
          ? await parseLegacyWorkbook(result.data)
          : await parseWorkbook(result.data)
        if (cancelled) return
        setModel(parsed)
        setActiveSheetName(parsed.sheets.find((s) => !s.hidden)?.name ?? parsed.sheets[0].name)
        setDirty(false)
        undoRef.current = []
        redoRef.current = []
      } catch (err) {
        if (!cancelled) setError(String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })

    return () => {
      cancelled = true
    }
  }, [filePath, fileVersion, sshConnectionId, isDelimited, isLegacy, ext, content])

  /* ---- mutation helpers ---- */

  const pushUndo = useCallback((entry: UndoEntry) => {
    undoRef.current.push(entry)
    if (undoRef.current.length > 100) undoRef.current.shift()
    redoRef.current = []
    setHistoryTick((t) => t + 1)
  }, [])

  const commitModel = useCallback(
    (next: WorkbookModel, target: SheetModel) => {
      recalculate(target, (cell) => formatCellText(cell.value, next.styles[cell.styleId]?.numFmt))
      setModel({ ...next, sheets: [...next.sheets] })
      setDirty(true)
      if (isDelimited) {
        onContentChange?.(serializeDelimited(target, ext === '.tsv' ? '\t' : ','))
      }
    },
    [isDelimited, onContentChange, ext]
  )

  const mutateCells = useCallback(
    (keys: string[], mutate: (cell: CellData) => CellData | undefined) => {
      if (!model || !sheet) return
      const before: Array<[string, CellData | undefined]> = keys.map((key) => {
        const existing = sheet.cells.get(key)
        return [key, existing ? { ...existing } : undefined]
      })
      pushUndo({ kind: 'cells', sheet: sheet.name, entries: before })

      for (const key of keys) {
        const existing = sheet.cells.get(key) ?? {
          value: null,
          styleId: 0,
          text: ''
        }
        const next = mutate({ ...existing })
        if (next === undefined) sheet.cells.delete(key)
        else sheet.cells.set(key, { ...next, dirty: true })
      }
      commitModel(model, sheet)
    },
    [model, sheet, pushUndo, commitModel]
  )

  const internStyle = useCallback(
    (patch: Partial<CellStyle>, base: CellStyle | undefined): number => {
      if (!model) return 0
      const merged = { ...(base ?? {}), ...patch }
      for (const [key, value] of Object.entries(merged)) {
        if (value === undefined || value === false) delete (merged as Record<string, unknown>)[key]
      }
      const serialized = JSON.stringify(merged)
      const existing = model.styles.findIndex((s) => JSON.stringify(s) === serialized)
      if (existing >= 0) return existing
      model.styles.push(merged)
      return model.styles.length - 1
    },
    [model]
  )

  const selectionKeys = useCallback((): string[] => {
    const range = normalizeSelection(selection)
    const keys: string[] = []
    for (let r = range.r0; r <= range.r1; r++) {
      for (let c = range.c0; c <= range.c1; c++) keys.push(cellKey(r, c))
    }
    return keys
  }, [selection])

  const focusCell = sheet?.cells.get(cellKey(selection.focus.r, selection.focus.c))
  const focusStyle = focusCell ? model?.styles[focusCell.styleId] : undefined

  const handleCommit = useCallback(
    (r: number, c: number, raw: string) => {
      const parsed = parseCellInput(raw)
      mutateCells([cellKey(r, c)], (cell) => {
        if (parsed.value === null && !parsed.formula && !cell.styleId) return undefined
        const numFmt = model?.styles[cell.styleId]?.numFmt
        return {
          ...cell,
          value: parsed.value,
          formula: parsed.formula,
          text: formatCellText(parsed.value, numFmt)
        }
      })
    },
    [mutateCells, model]
  )

  const applyStylePatch = useCallback(
    (patch: Partial<CellStyle>) => {
      mutateCells(selectionKeys(), (cell) => {
        const styleId = internStyle(patch, model?.styles[cell.styleId])
        const numFmt = model?.styles[styleId]?.numFmt
        return { ...cell, styleId, text: formatCellText(cell.value, numFmt) }
      })
    },
    [mutateCells, selectionKeys, internStyle, model]
  )

  const handleUndo = useCallback(() => {
    const entry = undoRef.current.pop()
    if (!entry || !model) return
    const target = model.sheets.find((s) => s.name === entry.sheet)
    if (!target) return

    if (entry.kind === 'cells') {
      const redoEntries: Array<[string, CellData | undefined]> = entry.entries.map(([key]) => {
        const current = target.cells.get(key)
        return [key, current ? { ...current } : undefined]
      })
      for (const [key, value] of entry.entries) {
        if (value === undefined) target.cells.delete(key)
        else target.cells.set(key, value)
      }
      redoRef.current.push({ kind: 'cells', sheet: entry.sheet, entries: redoEntries })
    } else {
      const current = cloneSheet(target)
      const index = model.sheets.indexOf(target)
      model.sheets[index] = entry.before
      redoRef.current.push({ kind: 'sheet', sheet: entry.sheet, before: current })
    }
    setHistoryTick((t) => t + 1)
    commitModel(model, model.sheets.find((s) => s.name === entry.sheet) ?? target)
  }, [model, commitModel])

  const handleRedo = useCallback(() => {
    const entry = redoRef.current.pop()
    if (!entry || !model) return
    const target = model.sheets.find((s) => s.name === entry.sheet)
    if (!target) return
    if (entry.kind === 'cells') {
      const undoEntries: Array<[string, CellData | undefined]> = entry.entries.map(([key]) => {
        const current = target.cells.get(key)
        return [key, current ? { ...current } : undefined]
      })
      for (const [key, value] of entry.entries) {
        if (value === undefined) target.cells.delete(key)
        else target.cells.set(key, value)
      }
      undoRef.current.push({ kind: 'cells', sheet: entry.sheet, entries: undoEntries })
    } else {
      const index = model.sheets.indexOf(target)
      undoRef.current.push({ kind: 'sheet', sheet: entry.sheet, before: cloneSheet(target) })
      model.sheets[index] = entry.before
    }
    setHistoryTick((t) => t + 1)
    commitModel(model, model.sheets.find((s) => s.name === entry.sheet) ?? target)
  }, [model, commitModel])

  const handleSave = useCallback(async () => {
    if (!model || !sheet || !canSave) return
    if (isDelimited) {
      onContentChange?.(serializeDelimited(sheet, ext === '.tsv' ? '\t' : ','))
      setDirty(false)
      return
    }
    setSaving(true)
    try {
      const base64 = await serializeWorkbook(originalRef.current, model)
      const channel = sshConnectionId ? IPC.SSH_FS_WRITE_FILE_BINARY : IPC.FS_WRITE_FILE_BINARY
      const args = sshConnectionId
        ? { connectionId: sshConnectionId, path: filePath, data: base64 }
        : { path: filePath, data: base64 }
      await ipcClient.invoke(channel, args)
      originalRef.current = base64
      for (const item of model.sheets) {
        for (const cell of item.cells.values()) cell.dirty = false
      }
      setDirty(false)
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }, [model, sheet, canSave, isDelimited, onContentChange, ext, sshConnectionId, filePath])

  const handleCommand = useCallback(
    (command: RibbonCommand) => {
      if (!model || !sheet) return
      const range = normalizeSelection(selection)

      switch (command.kind) {
        case 'style':
          return applyStylePatch(command.patch)
        case 'toggle':
          return applyStylePatch({ [command.key]: !focusStyle?.[command.key] })
        case 'numFmt':
          return applyStylePatch({
            numFmt: command.format === 'General' ? undefined : command.format
          })
        case 'decimals': {
          const current = focusStyle?.numFmt ?? '0'
          const match = /\.([0#]+)/.exec(current)
          const digits = Math.max(0, (match ? match[1].length : 0) + command.delta)
          const base = current.replace(/\.[0#]+/, '')
          return applyStylePatch({ numFmt: digits === 0 ? base : `${base}.${'0'.repeat(digits)}` })
        }
        case 'merge': {
          pushUndo({ kind: 'sheet', sheet: sheet.name, before: cloneSheet(sheet) })
          sheet.merges = sheet.merges.filter(
            (m) => m.r1 < range.r0 || m.r0 > range.r1 || m.c1 < range.c0 || m.c0 > range.c1
          )
          sheet.merges.push(range)
          return commitModel(model, sheet)
        }
        case 'unmerge': {
          pushUndo({ kind: 'sheet', sheet: sheet.name, before: cloneSheet(sheet) })
          sheet.merges = sheet.merges.filter(
            (m) => m.r1 < range.r0 || m.r0 > range.r1 || m.c1 < range.c0 || m.c0 > range.c1
          )
          return commitModel(model, sheet)
        }
        case 'insertRow':
        case 'deleteRow':
        case 'insertCol':
        case 'deleteCol': {
          pushUndo({ kind: 'sheet', sheet: sheet.name, before: cloneSheet(sheet) })
          shiftCells(sheet, command.kind, command.kind.endsWith('Row') ? range.r0 : range.c0)
          return commitModel(model, sheet)
        }
        case 'autoSum': {
          const { r, c } = selection.focus
          let start = r - 1
          while (start >= 0 && typeof sheet.cells.get(cellKey(start, c))?.value === 'number')
            start--
          start++
          if (start >= r) return
          const formula = `SUM(${cellRef(start, c)}:${cellRef(r - 1, c)})`
          return handleCommit(r, c, `=${formula}`)
        }
        case 'undo':
          return handleUndo()
        case 'redo':
          return handleRedo()
        case 'save':
          return void handleSave()
        case 'copy':
        case 'cut': {
          const text = selectionKeys()
            .reduce<string[][]>((rows, key) => {
              const [r, c] = key.split(',').map(Number)
              const rowIndex = r - range.r0
              rows[rowIndex] = rows[rowIndex] ?? []
              rows[rowIndex][c - range.c0] = sheet.cells.get(key)?.text ?? ''
              return rows
            }, [])
            .map((row) => row.join('\t'))
            .join('\n')
          void navigator.clipboard.writeText(text)
          if (command.kind === 'cut') mutateCells(selectionKeys(), () => undefined)
          return
        }
        case 'paste': {
          void navigator.clipboard.readText().then((text) => {
            const rows = text.split(/\r?\n/).map((line) => line.split('\t'))
            const keys: string[] = []
            const values = new Map<string, string>()
            rows.forEach((row, dr) =>
              row.forEach((value, dc) => {
                const key = cellKey(range.r0 + dr, range.c0 + dc)
                keys.push(key)
                values.set(key, value)
              })
            )
            mutateCells(keys, (cell) => {
              const key = cellKey(0, 0)
              void key
              return cell
            })
            for (const key of keys) {
              const [r, c] = key.split(',').map(Number)
              handleCommit(r, c, values.get(key) ?? '')
            }
          })
          return
        }
        case 'find':
          return
      }
    },
    [
      model,
      sheet,
      selection,
      applyStylePatch,
      focusStyle,
      pushUndo,
      commitModel,
      handleCommit,
      handleUndo,
      handleRedo,
      handleSave,
      selectionKeys,
      mutateCells
    ]
  )

  /* ---- Ctrl+S / Ctrl+Z / Ctrl+B ---- */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return
      const key = event.key.toLowerCase()
      if (key === 's' && canSave) {
        event.preventDefault()
        void handleSave()
      } else if (key === 'z') {
        event.preventDefault()
        if (event.shiftKey) handleRedo()
        else handleUndo()
      } else if (key === 'y') {
        event.preventDefault()
        handleRedo()
      } else if (key === 'b') {
        event.preventDefault()
        applyStylePatch({ bold: !focusStyle?.bold })
      } else if (key === 'i') {
        event.preventDefault()
        applyStylePatch({ italic: !focusStyle?.italic })
      } else if (key === 'u') {
        event.preventDefault()
        applyStylePatch({ underline: !focusStyle?.underline })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleSave, handleUndo, handleRedo, applyStylePatch, focusStyle, canSave])

  /* ---- status bar stats ---- */
  const stats = useMemo(() => {
    if (!sheet) return null
    const range = normalizeSelection(selection)
    let count = 0
    let numericCount = 0
    let sum = 0
    for (let r = range.r0; r <= range.r1; r++) {
      for (let c = range.c0; c <= range.c1; c++) {
        const cell = sheet.cells.get(cellKey(r, c))
        if (!cell || cell.value === null || cell.value === '') continue
        count++
        if (typeof cell.value === 'number') {
          numericCount++
          sum += cell.value
        }
      }
    }
    return { count, numericCount, sum, average: numericCount ? sum / numericCount : 0 }
  }, [sheet, selection])

  const formulaValue =
    formulaDraft ?? (focusCell?.formula ? `=${focusCell.formula}` : (focusCell?.text ?? ''))

  if (loading) {
    return (
      <div className="flex size-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <FileSpreadsheet className="size-5 animate-pulse" />
        正在打开工作簿…
      </div>
    )
  }

  if (error || !model || !sheet) {
    return (
      <div className="flex size-full items-center justify-center p-6">
        <div className="flex max-w-sm items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{error ?? '无法解析该工作簿'}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex size-full flex-col overflow-hidden bg-[#f5f5f5] dark:bg-[#252525]">
      <Ribbon
        activeStyle={focusStyle}
        canUndo={undoRef.current.length > 0}
        canRedo={redoRef.current.length > 0}
        dirty={dirty}
        saving={saving}
        onCommand={handleCommand}
        key={`ribbon-${historyTick}-${selection.focus.r}-${selection.focus.c}`}
      />

      <FormulaBar
        reference={selectionRef(selection)}
        value={formulaValue}
        editing={formulaDraft !== null}
        onChange={setFormulaDraft}
        onBeginEdit={() => setFormulaDraft((v) => v ?? formulaValue)}
        onCommit={() => {
          if (formulaDraft !== null)
            handleCommit(selection.focus.r, selection.focus.c, formulaDraft)
          setFormulaDraft(null)
        }}
        onCancel={() => setFormulaDraft(null)}
      />

      {isLegacy ? (
        <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[11px] text-amber-700 dark:text-amber-300">
          <TriangleAlert className="size-3.5 shrink-0" />
          {ext} 为旧版格式，仅支持只读预览（保存会破坏原文件结构，已禁用）。
        </div>
      ) : null}

      <SheetGrid
        sheet={sheet}
        styles={model.styles}
        selection={selection}
        onSelectionChange={(next) => {
          setSelection(next)
          setFormulaDraft(null)
        }}
        onCommit={handleCommit}
        onResizeColumn={(index, width) => {
          sheet.colWidths[index] = width
          setModel({ ...model, sheets: [...model.sheets] })
        }}
        onResizeRow={(index, height) => {
          sheet.rowHeights[index] = height
          setModel({ ...model, sheets: [...model.sheets] })
        }}
        editing={editing}
        onEditingChange={setEditing}
        zoom={zoom}
      />

      <SheetTabBar
        sheets={model.sheets}
        active={sheet.name}
        onSelect={(name) => {
          setActiveSheetName(name)
          setSelection({ anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 } })
        }}
        onAdd={() => {
          const name = `Sheet${model.sheets.length + 1}`
          model.sheets.push(createEmptySheet(name))
          setModel({ ...model, sheets: [...model.sheets] })
          setActiveSheetName(name)
          setDirty(true)
        }}
        onRename={(name, next) => {
          const target = model.sheets.find((s) => s.name === name)
          if (!target || next === name) return
          target.name = next
          setModel({ ...model, sheets: [...model.sheets] })
          setActiveSheetName(next)
          setDirty(true)
        }}
      />

      <StatusBar
        stats={stats}
        zoom={zoom}
        onZoomChange={setZoom}
        dimensions={`${sheet.rows} 行 × ${columnLabel(sheet.cols - 1)} 列`}
      />
    </div>
  )
}

function shiftCells(
  sheet: SheetModel,
  kind: 'insertRow' | 'deleteRow' | 'insertCol' | 'deleteCol',
  at: number
): void {
  const next = new Map<string, CellData>()
  const isRow = kind.endsWith('Row')
  const insert = kind.startsWith('insert')

  for (const [key, cell] of sheet.cells) {
    const [r, c] = key.split(',').map(Number)
    const axis = isRow ? r : c
    if (!insert && axis === at) continue
    const shifted = axis < at ? axis : insert ? axis + 1 : axis - 1
    next.set(isRow ? cellKey(shifted, c) : cellKey(r, shifted), cell)
  }
  sheet.cells = next

  if (isRow) {
    if (insert) sheet.rowHeights.splice(at, 0, DEFAULT_ROW_HEIGHT_PX)
    else sheet.rowHeights.splice(at, 1)
    sheet.rows = sheet.rowHeights.length
  } else {
    if (insert) sheet.colWidths.splice(at, 0, DEFAULT_COL_WIDTH_PX)
    else sheet.colWidths.splice(at, 1)
    sheet.cols = sheet.colWidths.length
  }
}

/** Legacy .xls/.xlsb/.ods stay read-only through SheetJS: values but no styles. */
async function parseLegacyWorkbook(base64: string): Promise<WorkbookModel> {
  const XLSX = await import('xlsx')
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const workbook = XLSX.read(bytes, { type: 'array', cellDates: true })
  const sheets: SheetModel[] = []

  for (const name of workbook.SheetNames) {
    const sheet = createEmptySheet(name)
    const rows: unknown[][] = XLSX.utils.sheet_to_json(workbook.Sheets[name], {
      header: 1,
      defval: null,
      raw: true
    })
    rows.forEach((row, r) =>
      row.forEach((value, c) => {
        if (value === null || value === undefined || value === '') return
        const typed = value as CellData['value']
        sheet.cells.set(cellKey(r, c), { value: typed, styleId: 0, text: formatCellText(typed) })
      })
    )
    sheet.rows = Math.max(rows.length + 20, sheet.rows)
    sheet.cols = Math.max(...rows.map((row) => row.length), 20) + 5
    sheet.colWidths = new Array<number>(sheet.cols).fill(DEFAULT_COL_WIDTH_PX)
    sheet.rowHeights = new Array<number>(sheet.rows).fill(DEFAULT_ROW_HEIGHT_PX)
    sheets.push(sheet)
  }

  return { sheets: sheets.length ? sheets : [createEmptySheet('Sheet1')], styles: [{}] }
}
