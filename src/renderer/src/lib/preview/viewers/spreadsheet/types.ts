export const DEFAULT_COL_WIDTH_PX = 64
export const DEFAULT_ROW_HEIGHT_PX = 20
export const ROW_HEADER_WIDTH_PX = 46
export const COL_HEADER_HEIGHT_PX = 22

export type CellValue = string | number | boolean | Date | null

export interface CellStyle {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  fontName?: string
  fontSize?: number
  color?: string
  fill?: string
  hAlign?: 'left' | 'center' | 'right' | 'justify' | 'fill' | 'distributed'
  vAlign?: 'top' | 'middle' | 'bottom'
  wrap?: boolean
  indent?: number
  numFmt?: string
  border?: {
    top?: string
    right?: string
    bottom?: string
    left?: string
  }
}

export interface CellData {
  value: CellValue
  formula?: string
  styleId: number
  text: string
  /** Set when the cell was edited in this session; drives the write-back path. */
  dirty?: boolean
}

export interface MergeRange {
  r0: number
  c0: number
  r1: number
  c1: number
}

export interface SheetModel {
  name: string
  rows: number
  cols: number
  cells: Map<string, CellData>
  merges: MergeRange[]
  colWidths: number[]
  rowHeights: number[]
  frozen: { rows: number; cols: number }
  hidden: boolean
  tabColor?: string
}

export interface WorkbookModel {
  sheets: SheetModel[]
  styles: CellStyle[]
}

export interface CellAddress {
  r: number
  c: number
}

export interface Selection {
  anchor: CellAddress
  focus: CellAddress
}

export function cellKey(r: number, c: number): string {
  return `${r},${c}`
}

export function columnLabel(index: number): string {
  let label = ''
  let n = index
  while (n >= 0) {
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26) - 1
  }
  return label
}

export function cellRef(r: number, c: number): string {
  return `${columnLabel(c)}${r + 1}`
}

export function normalizeSelection(selection: Selection): MergeRange {
  return {
    r0: Math.min(selection.anchor.r, selection.focus.r),
    c0: Math.min(selection.anchor.c, selection.focus.c),
    r1: Math.max(selection.anchor.r, selection.focus.r),
    c1: Math.max(selection.anchor.c, selection.focus.c)
  }
}

export function selectionRef(selection: Selection): string {
  const range = normalizeSelection(selection)
  if (range.r0 === range.r1 && range.c0 === range.c1) return cellRef(range.r0, range.c0)
  const rows = range.r1 - range.r0 + 1
  const cols = range.c1 - range.c0 + 1
  return `${rows}R x ${cols}C`
}

export function findMergeAt(sheet: SheetModel, r: number, c: number): MergeRange | undefined {
  return sheet.merges.find((m) => r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1)
}
