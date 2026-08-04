import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CellStyle, MergeRange, SheetModel, Selection } from './types'
import {
  COL_HEADER_HEIGHT_PX,
  ROW_HEADER_WIDTH_PX,
  cellKey,
  columnLabel,
  findMergeAt,
  normalizeSelection
} from './types'
import { defaultAlign } from './number-format'

interface SheetGridProps {
  sheet: SheetModel
  styles: CellStyle[]
  selection: Selection
  onSelectionChange: (selection: Selection) => void
  onCommit: (r: number, c: number, raw: string) => void
  onResizeColumn: (index: number, width: number) => void
  onResizeRow: (index: number, height: number) => void
  editing: { r: number; c: number; initial: string } | null
  onEditingChange: (editing: { r: number; c: number; initial: string } | null) => void
  zoom: number
}

function prefixSums(sizes: number[]): number[] {
  const out = new Array<number>(sizes.length + 1)
  out[0] = 0
  for (let i = 0; i < sizes.length; i++) out[i + 1] = out[i] + sizes[i]
  return out
}

function findIndex(offsets: number[], position: number): number {
  let lo = 0
  let hi = offsets.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (offsets[mid] <= position) lo = mid
    else hi = mid - 1
  }
  return lo
}

function styleToCss(style: CellStyle | undefined, isNumeric: boolean): React.CSSProperties {
  if (!style) {
    return { textAlign: isNumeric ? 'right' : 'left', justifyContent: 'flex-start' }
  }
  const align = style.hAlign ?? (isNumeric ? 'right' : 'left')
  return {
    fontWeight: style.bold ? 700 : undefined,
    fontStyle: style.italic ? 'italic' : undefined,
    textDecoration:
      [style.underline ? 'underline' : '', style.strike ? 'line-through' : '']
        .filter(Boolean)
        .join(' ') || undefined,
    fontFamily: style.fontName ? `"${style.fontName}", var(--font-sans)` : undefined,
    fontSize: style.fontSize ? `${style.fontSize}px` : undefined,
    color: style.color,
    background: style.fill,
    textAlign: align === 'center' ? 'center' : align === 'right' ? 'right' : 'left',
    alignItems:
      style.vAlign === 'top' ? 'flex-start' : style.vAlign === 'middle' ? 'center' : 'flex-end',
    whiteSpace: style.wrap ? 'pre-wrap' : 'nowrap',
    paddingLeft: style.indent ? 3 + style.indent * 9 : undefined,
    borderTop: style.border?.top,
    borderRight: style.border?.right,
    borderBottom: style.border?.bottom,
    borderLeft: style.border?.left
  }
}

export function SheetGrid({
  sheet,
  styles,
  selection,
  onSelectionChange,
  onCommit,
  onResizeColumn,
  onResizeRow,
  editing,
  onEditingChange,
  zoom
}: SheetGridProps): React.JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null)
  const colHeaderRef = useRef<HTMLDivElement>(null)
  const rowHeaderRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLInputElement>(null)
  const draggingRef = useRef(false)
  const resizeRef = useRef<{
    kind: 'col' | 'row'
    index: number
    start: number
    size: number
  } | null>(null)

  const [viewport, setViewport] = useState({ top: 0, left: 0, width: 0, height: 0 })

  const colOffsets = useMemo(
    () => prefixSums(sheet.colWidths.map((w) => Math.round(w * zoom))),
    [sheet.colWidths, zoom]
  )
  const rowOffsets = useMemo(
    () => prefixSums(sheet.rowHeights.map((h) => Math.round(h * zoom))),
    [sheet.rowHeights, zoom]
  )
  const totalWidth = colOffsets[colOffsets.length - 1]
  const totalHeight = rowOffsets[rowOffsets.length - 1]

  const range = normalizeSelection(selection)

  const syncHeaders = useCallback(() => {
    const el = bodyRef.current
    if (!el) return
    if (colHeaderRef.current) {
      colHeaderRef.current.scrollLeft = el.scrollLeft
    }
    if (rowHeaderRef.current) {
      rowHeaderRef.current.scrollTop = el.scrollTop
    }
    setViewport({
      top: el.scrollTop,
      left: el.scrollLeft,
      width: el.clientWidth,
      height: el.clientHeight
    })
  }, [])

  useLayoutEffect(() => {
    syncHeaders()
    const el = bodyRef.current
    if (!el) return
    const observer = new ResizeObserver(syncHeaders)
    observer.observe(el)
    return () => observer.disconnect()
  }, [syncHeaders])

  const visible = useMemo(() => {
    const OVERSCAN = 4
    const r0 = Math.max(0, findIndex(rowOffsets, viewport.top) - OVERSCAN)
    const r1 = Math.min(
      sheet.rows - 1,
      findIndex(rowOffsets, viewport.top + viewport.height) + OVERSCAN
    )
    const c0 = Math.max(0, findIndex(colOffsets, viewport.left) - OVERSCAN)
    const c1 = Math.min(
      sheet.cols - 1,
      findIndex(colOffsets, viewport.left + viewport.width) + OVERSCAN
    )
    return { r0, r1, c0, c1 }
  }, [rowOffsets, colOffsets, viewport, sheet.rows, sheet.cols])

  const scrollIntoView = useCallback(
    (r: number, c: number) => {
      const el = bodyRef.current
      if (!el) return
      const top = rowOffsets[r]
      const bottom = rowOffsets[r + 1]
      const left = colOffsets[c]
      const right = colOffsets[c + 1]
      if (top < el.scrollTop) el.scrollTop = top
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight
      if (left < el.scrollLeft) el.scrollLeft = left
      else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth
    },
    [rowOffsets, colOffsets]
  )

  useEffect(() => {
    if (editing) {
      requestAnimationFrame(() => {
        editorRef.current?.focus()
        editorRef.current?.setSelectionRange(
          editorRef.current.value.length,
          editorRef.current.value.length
        )
      })
    }
  }, [editing])

  const hitTest = useCallback(
    (event: React.MouseEvent): { r: number; c: number } | null => {
      const el = bodyRef.current
      if (!el) return null
      const rect = el.getBoundingClientRect()
      const x = event.clientX - rect.left + el.scrollLeft
      const y = event.clientY - rect.top + el.scrollTop
      if (x < 0 || y < 0) return null
      return { r: findIndex(rowOffsets, y), c: findIndex(colOffsets, x) }
    },
    [rowOffsets, colOffsets]
  )

  const commitEditor = useCallback(
    (move: 'down' | 'right' | 'none') => {
      if (!editing) return
      const raw = editorRef.current?.value ?? ''
      onCommit(editing.r, editing.c, raw)
      onEditingChange(null)
      const next =
        move === 'down'
          ? { r: Math.min(sheet.rows - 1, editing.r + 1), c: editing.c }
          : move === 'right'
            ? { r: editing.r, c: Math.min(sheet.cols - 1, editing.c + 1) }
            : { r: editing.r, c: editing.c }
      onSelectionChange({ anchor: next, focus: next })
      scrollIntoView(next.r, next.c)
      bodyRef.current?.focus()
    },
    [editing, onCommit, onEditingChange, onSelectionChange, scrollIntoView, sheet.rows, sheet.cols]
  )

  const moveSelection = useCallback(
    (dr: number, dc: number, extend: boolean) => {
      const base = extend ? selection.focus : selection.focus
      const r = Math.max(0, Math.min(sheet.rows - 1, base.r + dr))
      const c = Math.max(0, Math.min(sheet.cols - 1, base.c + dc))
      onSelectionChange(
        extend
          ? { anchor: selection.anchor, focus: { r, c } }
          : { anchor: { r, c }, focus: { r, c } }
      )
      scrollIntoView(r, c)
    },
    [selection, onSelectionChange, scrollIntoView, sheet.rows, sheet.cols]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (editing) return
      const { key, shiftKey, metaKey, ctrlKey } = event
      const mod = metaKey || ctrlKey

      if (key === 'ArrowUp')
        return void (event.preventDefault(), moveSelection(mod ? -sheet.rows : -1, 0, shiftKey))
      if (key === 'ArrowDown')
        return void (event.preventDefault(), moveSelection(mod ? sheet.rows : 1, 0, shiftKey))
      if (key === 'ArrowLeft')
        return void (event.preventDefault(), moveSelection(0, mod ? -sheet.cols : -1, shiftKey))
      if (key === 'ArrowRight')
        return void (event.preventDefault(), moveSelection(0, mod ? sheet.cols : 1, shiftKey))
      if (key === 'Tab')
        return void (event.preventDefault(), moveSelection(0, shiftKey ? -1 : 1, false))
      if (key === 'Enter') {
        event.preventDefault()
        const { r, c } = selection.focus
        const existing = sheet.cells.get(cellKey(r, c))
        onEditingChange({
          r,
          c,
          initial: existing?.formula ? `=${existing.formula}` : (existing?.text ?? '')
        })
        return
      }
      if (key === 'F2') {
        event.preventDefault()
        const { r, c } = selection.focus
        const existing = sheet.cells.get(cellKey(r, c))
        onEditingChange({
          r,
          c,
          initial: existing?.formula ? `=${existing.formula}` : (existing?.text ?? '')
        })
        return
      }
      if (key === 'Delete' || key === 'Backspace') {
        event.preventDefault()
        for (let r = range.r0; r <= range.r1; r++) {
          for (let c = range.c0; c <= range.c1; c++) onCommit(r, c, '')
        }
        return
      }
      if (key.length === 1 && !mod) {
        event.preventDefault()
        const { r, c } = selection.focus
        onEditingChange({ r, c, initial: key })
      }
    },
    [editing, moveSelection, selection, sheet, onEditingChange, onCommit, range]
  )

  // Column / row resize drag
  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      const state = resizeRef.current
      if (!state) return
      if (state.kind === 'col') {
        const next = Math.max(0, state.size + (event.clientX - state.start) / zoom)
        onResizeColumn(state.index, next)
      } else {
        const next = Math.max(0, state.size + (event.clientY - state.start) / zoom)
        onResizeRow(state.index, next)
      }
    }
    const onUp = (): void => {
      resizeRef.current = null
      draggingRef.current = false
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [onResizeColumn, onResizeRow, zoom])

  const covered = useMemo(() => {
    const set = new Set<string>()
    for (const m of sheet.merges) {
      for (let r = m.r0; r <= m.r1; r++) {
        for (let c = m.c0; c <= m.c1; c++) {
          if (r !== m.r0 || c !== m.c0) set.add(cellKey(r, c))
        }
      }
    }
    return set
  }, [sheet.merges])

  const cellNodes: React.JSX.Element[] = []
  for (let r = visible.r0; r <= visible.r1; r++) {
    if (rowOffsets[r + 1] === rowOffsets[r]) continue
    for (let c = visible.c0; c <= visible.c1; c++) {
      if (colOffsets[c + 1] === colOffsets[c]) continue
      const key = cellKey(r, c)
      if (covered.has(key)) continue
      const merge: MergeRange | undefined = findMergeAt(sheet, r, c)
      const width = merge
        ? colOffsets[Math.min(merge.c1 + 1, sheet.cols)] - colOffsets[merge.c0]
        : colOffsets[c + 1] - colOffsets[c]
      const height = merge
        ? rowOffsets[Math.min(merge.r1 + 1, sheet.rows)] - rowOffsets[merge.r0]
        : rowOffsets[r + 1] - rowOffsets[r]
      const data = sheet.cells.get(key)
      const style = data ? styles[data.styleId] : undefined
      const isNumeric = defaultAlign(data?.value ?? null) === 'right'
      const inRange = r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1
      const isFocus = r === selection.focus.r && c === selection.focus.c

      cellNodes.push(
        <div
          key={key}
          className="absolute flex overflow-hidden border-b border-r border-[#d4d4d4] px-[3px] leading-tight dark:border-[#3a3a3a]"
          style={{
            left: colOffsets[c],
            top: rowOffsets[r],
            width,
            height,
            fontSize: `${11 * zoom}px`,
            ...styleToCss(style, isNumeric),
            ...(inRange && !isFocus
              ? { boxShadow: 'inset 0 0 0 9999px rgba(33,115,70,0.08)' }
              : null)
          }}
        >
          <span className="w-full truncate">{data?.text ?? ''}</span>
        </div>
      )
    }
  }

  const focusMerge = findMergeAt(sheet, selection.focus.r, selection.focus.c)
  const selBox = {
    left: colOffsets[range.c0],
    top: rowOffsets[range.r0],
    width: colOffsets[Math.min(range.c1 + 1, sheet.cols)] - colOffsets[range.c0],
    height: rowOffsets[Math.min(range.r1 + 1, sheet.rows)] - rowOffsets[range.r0]
  }
  const editorBox = editing
    ? {
        left: colOffsets[editing.c],
        top: rowOffsets[editing.r],
        width:
          (focusMerge && focusMerge.c0 === editing.c
            ? colOffsets[Math.min(focusMerge.c1 + 1, sheet.cols)] - colOffsets[focusMerge.c0]
            : colOffsets[editing.c + 1] - colOffsets[editing.c]) + 1,
        height: rowOffsets[editing.r + 1] - rowOffsets[editing.r] + 1
      }
    : null

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white dark:bg-[#1b1b1b]">
      {/* Header row: corner + column headers */}
      <div className="flex shrink-0">
        <div
          className="shrink-0 border-b border-r border-[#b1b1b1] bg-[#f0f0f0] dark:border-[#4a4a4a] dark:bg-[#2b2b2b]"
          style={{ width: ROW_HEADER_WIDTH_PX, height: COL_HEADER_HEIGHT_PX }}
        />
        <div ref={colHeaderRef} className="relative flex-1 overflow-hidden">
          <div className="relative" style={{ width: totalWidth, height: COL_HEADER_HEIGHT_PX }}>
            {Array.from({ length: visible.c1 - visible.c0 + 1 }, (_, i) => {
              const c = visible.c0 + i
              const width = colOffsets[c + 1] - colOffsets[c]
              if (width === 0) return null
              const active = c >= range.c0 && c <= range.c1
              return (
                <div
                  key={c}
                  className={`absolute flex select-none items-center justify-center border-b border-r text-[11px] ${
                    active
                      ? 'border-[#217346] bg-[#d3e5db] font-semibold text-[#217346] dark:bg-[#1f3d30] dark:text-[#4ec98a]'
                      : 'border-[#b1b1b1] bg-[#f0f0f0] text-[#444] dark:border-[#4a4a4a] dark:bg-[#2b2b2b] dark:text-[#c8c8c8]'
                  }`}
                  style={{ left: colOffsets[c], width, height: COL_HEADER_HEIGHT_PX }}
                  onMouseDown={() => {
                    onSelectionChange({ anchor: { r: 0, c }, focus: { r: sheet.rows - 1, c } })
                  }}
                >
                  {columnLabel(c)}
                  <div
                    className="absolute right-0 top-0 h-full w-[4px] cursor-col-resize hover:bg-[#217346]"
                    onMouseDown={(event) => {
                      event.stopPropagation()
                      draggingRef.current = true
                      resizeRef.current = {
                        kind: 'col',
                        index: c,
                        start: event.clientX,
                        size: sheet.colWidths[c]
                      }
                    }}
                  />
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Row headers */}
        <div
          ref={rowHeaderRef}
          className="shrink-0 overflow-hidden"
          style={{ width: ROW_HEADER_WIDTH_PX }}
        >
          <div className="relative" style={{ width: ROW_HEADER_WIDTH_PX, height: totalHeight }}>
            {Array.from({ length: visible.r1 - visible.r0 + 1 }, (_, i) => {
              const r = visible.r0 + i
              const height = rowOffsets[r + 1] - rowOffsets[r]
              if (height === 0) return null
              const active = r >= range.r0 && r <= range.r1
              return (
                <div
                  key={r}
                  className={`absolute flex select-none items-center justify-center border-b border-r text-[11px] ${
                    active
                      ? 'border-[#217346] bg-[#d3e5db] font-semibold text-[#217346] dark:bg-[#1f3d30] dark:text-[#4ec98a]'
                      : 'border-[#b1b1b1] bg-[#f0f0f0] text-[#444] dark:border-[#4a4a4a] dark:bg-[#2b2b2b] dark:text-[#c8c8c8]'
                  }`}
                  style={{ top: rowOffsets[r], height, width: ROW_HEADER_WIDTH_PX }}
                  onMouseDown={() => {
                    onSelectionChange({ anchor: { r, c: 0 }, focus: { r, c: sheet.cols - 1 } })
                  }}
                >
                  {r + 1}
                  <div
                    className="absolute bottom-0 left-0 h-[4px] w-full cursor-row-resize hover:bg-[#217346]"
                    onMouseDown={(event) => {
                      event.stopPropagation()
                      draggingRef.current = true
                      resizeRef.current = {
                        kind: 'row',
                        index: r,
                        start: event.clientY,
                        size: sheet.rowHeights[r]
                      }
                    }}
                  />
                </div>
              )
            })}
          </div>
        </div>

        {/* Body */}
        <div
          ref={bodyRef}
          tabIndex={0}
          className="relative min-w-0 flex-1 overflow-auto outline-none"
          onScroll={syncHeaders}
          onKeyDown={handleKeyDown}
          onMouseDown={(event) => {
            if (resizeRef.current) return
            const hit = hitTest(event)
            if (!hit) return
            bodyRef.current?.focus()
            if (event.shiftKey) onSelectionChange({ anchor: selection.anchor, focus: hit })
            else onSelectionChange({ anchor: hit, focus: hit })
            draggingRef.current = true
          }}
          onMouseMove={(event) => {
            if (!draggingRef.current || resizeRef.current) return
            const hit = hitTest(event)
            if (hit) onSelectionChange({ anchor: selection.anchor, focus: hit })
          }}
          onMouseUp={() => {
            draggingRef.current = false
          }}
          onDoubleClick={(event) => {
            const hit = hitTest(event)
            if (!hit) return
            const existing = sheet.cells.get(cellKey(hit.r, hit.c))
            onEditingChange({
              r: hit.r,
              c: hit.c,
              initial: existing?.formula ? `=${existing.formula}` : (existing?.text ?? '')
            })
          }}
        >
          <div className="relative" style={{ width: totalWidth, height: totalHeight }}>
            {cellNodes}

            {/* Selection outline */}
            <div
              className="pointer-events-none absolute z-10 border-[2px] border-[#217346]"
              style={selBox}
            >
              <div className="absolute -bottom-[4px] -right-[4px] size-[7px] cursor-crosshair border border-white bg-[#217346]" />
            </div>

            {editing && editorBox ? (
              <input
                ref={editorRef}
                defaultValue={editing.initial}
                className="absolute z-20 border-[2px] border-[#217346] bg-white px-[2px] outline-none dark:bg-[#1b1b1b]"
                style={{ ...editorBox, fontSize: `${11 * zoom}px` }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitEditor('down')
                  } else if (event.key === 'Tab') {
                    event.preventDefault()
                    commitEditor('right')
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    onEditingChange(null)
                    bodyRef.current?.focus()
                  }
                }}
                onBlur={() => commitEditor('none')}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
