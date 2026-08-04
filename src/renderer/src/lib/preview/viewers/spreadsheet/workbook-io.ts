import type { CellStyle, CellValue, SheetModel, WorkbookModel } from './types'
import { DEFAULT_COL_WIDTH_PX, DEFAULT_ROW_HEIGHT_PX, cellKey } from './types'
import { formatCellText } from './number-format'

/* eslint-disable @typescript-eslint/no-explicit-any */

const THEME_COLORS = [
  '#FFFFFF',
  '#000000',
  '#E7E6E6',
  '#44546A',
  '#4472C4',
  '#ED7D31',
  '#A5A5A5',
  '#FFC000',
  '#5B9BD5',
  '#70AD47'
]

async function loadExcelJs(): Promise<any> {
  const mod: any = await import('exceljs')
  return mod.default ?? mod
}

function applyTint(hex: string, tint: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const shift = (channel: number): number => {
    const next = tint < 0 ? channel * (1 + tint) : channel * (1 - tint) + 255 * tint
    return Math.max(0, Math.min(255, Math.round(next)))
  }
  return `#${[shift(r), shift(g), shift(b)].map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

export function toCssColor(color: any): string | undefined {
  if (!color) return undefined
  if (typeof color.argb === 'string' && color.argb.length >= 6) {
    const hex = color.argb.length === 8 ? color.argb.slice(2) : color.argb
    return `#${hex}`
  }
  if (typeof color.theme === 'number') {
    const base = THEME_COLORS[color.theme] ?? '#000000'
    return typeof color.tint === 'number' && color.tint !== 0 ? applyTint(base, color.tint) : base
  }
  return undefined
}

const BORDER_WIDTH: Record<string, string> = {
  thin: '1px solid',
  hair: '1px solid',
  dotted: '1px dotted',
  dashed: '1px dashed',
  medium: '2px solid',
  thick: '3px solid',
  double: '3px double',
  mediumDashed: '2px dashed',
  slantDashDot: '1px dashed'
}

function readBorderEdge(edge: any): string | undefined {
  if (!edge?.style) return undefined
  const spec = BORDER_WIDTH[edge.style] ?? '1px solid'
  return `${spec} ${toCssColor(edge.color) ?? '#b0b0b0'}`
}

function readStyle(cell: any): CellStyle {
  const style: CellStyle = {}
  const font = cell.font
  if (font) {
    if (font.bold) style.bold = true
    if (font.italic) style.italic = true
    if (font.underline) style.underline = true
    if (font.strike) style.strike = true
    if (font.name) style.fontName = font.name
    if (typeof font.size === 'number') style.fontSize = font.size
    const color = toCssColor(font.color)
    if (color) style.color = color
  }

  const fill = cell.fill
  if (fill?.type === 'pattern' && fill.pattern !== 'none') {
    const bg = toCssColor(fill.fgColor) ?? toCssColor(fill.bgColor)
    if (bg) style.fill = bg
  }

  const alignment = cell.alignment
  if (alignment) {
    if (alignment.horizontal && alignment.horizontal !== 'general') {
      style.hAlign = alignment.horizontal as CellStyle['hAlign']
    }
    if (alignment.vertical) style.vAlign = alignment.vertical as CellStyle['vAlign']
    if (alignment.wrapText) style.wrap = true
    if (typeof alignment.indent === 'number' && alignment.indent > 0)
      style.indent = alignment.indent
  }

  const border = cell.border
  if (border) {
    const top = readBorderEdge(border.top)
    const right = readBorderEdge(border.right)
    const bottom = readBorderEdge(border.bottom)
    const left = readBorderEdge(border.left)
    if (top || right || bottom || left) style.border = { top, right, bottom, left }
  }

  if (cell.numFmt && cell.numFmt !== 'General') style.numFmt = cell.numFmt
  return style
}

class StyleTable {
  private readonly list: CellStyle[] = [{}]
  private readonly index = new Map<string, number>([['{}', 0]])

  intern(style: CellStyle): number {
    const key = JSON.stringify(style)
    const existing = this.index.get(key)
    if (existing !== undefined) return existing
    const next = this.list.length
    this.list.push(style)
    this.index.set(key, next)
    return next
  }

  toArray(): CellStyle[] {
    return this.list
  }
}

function readValue(raw: any): { value: CellValue; formula?: string } {
  if (raw === null || raw === undefined) return { value: null }
  if (raw instanceof Date) return { value: raw }
  if (typeof raw === 'object') {
    if ('formula' in raw || 'sharedFormula' in raw) {
      const result = raw.result
      const value =
        result && typeof result === 'object' && 'error' in result ? String(result.error) : result
      return { value: (value ?? null) as CellValue, formula: raw.formula ?? raw.sharedFormula }
    }
    if ('richText' in raw && Array.isArray(raw.richText)) {
      return { value: raw.richText.map((part: any) => part.text ?? '').join('') }
    }
    if ('text' in raw) return { value: String(raw.text) }
    if ('error' in raw) return { value: String(raw.error) }
    return { value: String(raw) }
  }
  return { value: raw as CellValue }
}

/** Excel column width is measured in "0" glyphs of the default font. */
function colWidthToPx(width: number | undefined): number {
  if (!width || width <= 0) return DEFAULT_COL_WIDTH_PX
  return Math.round(width * 7 + 5)
}

function rowHeightToPx(height: number | undefined): number {
  if (!height || height <= 0) return DEFAULT_ROW_HEIGHT_PX
  return Math.round((height * 96) / 72)
}

function parseMergeRef(ref: string): { r0: number; c0: number; r1: number; c1: number } | null {
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref)
  if (!match) return null
  const toCol = (letters: string): number => {
    let n = 0
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
    return n - 1
  }
  return {
    r0: Number(match[2]) - 1,
    c0: toCol(match[1]),
    r1: Number(match[4]) - 1,
    c1: toCol(match[3])
  }
}

const MIN_ROWS = 60
const MIN_COLS = 20

export async function parseWorkbook(base64: string): Promise<WorkbookModel> {
  const ExcelJS = await loadExcelJs()
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes.buffer)

  const styles = new StyleTable()
  const sheets: SheetModel[] = []

  workbook.eachSheet((worksheet: any) => {
    const cells = new Map<string, ReturnType<typeof buildCell>>()
    let maxRow = 0
    let maxCol = 0

    worksheet.eachRow({ includeEmpty: false }, (row: any, rowNumber: number) => {
      row.eachCell({ includeEmpty: false }, (cell: any, colNumber: number) => {
        const { value, formula } = readValue(cell.value)
        const style = readStyle(cell)
        const styleId = styles.intern(style)
        if (value === null && styleId === 0) return
        const r = rowNumber - 1
        const c = colNumber - 1
        maxRow = Math.max(maxRow, rowNumber)
        maxCol = Math.max(maxCol, colNumber)
        cells.set(cellKey(r, c), buildCell(value, formula, styleId, style.numFmt))
      })
    })

    const merges: SheetModel['merges'] = []
    const rawMerges = worksheet.model?.merges ?? []
    for (const ref of rawMerges) {
      const parsed = parseMergeRef(String(ref))
      if (parsed) {
        merges.push(parsed)
        maxRow = Math.max(maxRow, parsed.r1 + 1)
        maxCol = Math.max(maxCol, parsed.c1 + 1)
      }
    }

    const rows = Math.max(maxRow + 20, MIN_ROWS)
    const cols = Math.max(maxCol + 5, MIN_COLS)

    const colWidths = new Array<number>(cols).fill(DEFAULT_COL_WIDTH_PX)
    for (let i = 0; i < cols; i++) {
      const column = worksheet.getColumn(i + 1)
      if (column?.width) colWidths[i] = colWidthToPx(column.width)
      if (column?.hidden) colWidths[i] = 0
    }

    const rowHeights = new Array<number>(rows).fill(DEFAULT_ROW_HEIGHT_PX)
    for (let i = 0; i < rows; i++) {
      const row = worksheet.findRow(i + 1)
      if (row?.height) rowHeights[i] = rowHeightToPx(row.height)
      if (row?.hidden) rowHeights[i] = 0
    }

    const view = worksheet.views?.[0]
    const frozen =
      view?.state === 'frozen'
        ? { rows: view.ySplit ?? 0, cols: view.xSplit ?? 0 }
        : { rows: 0, cols: 0 }

    sheets.push({
      name: worksheet.name,
      rows,
      cols,
      cells,
      merges,
      colWidths,
      rowHeights,
      frozen,
      hidden: worksheet.state === 'hidden' || worksheet.state === 'veryHidden',
      tabColor: toCssColor(worksheet.properties?.tabColor)
    })
  })

  if (sheets.length === 0) {
    sheets.push(createEmptySheet('Sheet1'))
  }

  return { sheets, styles: styles.toArray() }
}

function buildCell(
  value: CellValue,
  formula: string | undefined,
  styleId: number,
  numFmt: string | undefined
): SheetModel['cells'] extends Map<string, infer T> ? T : never {
  return {
    value,
    formula,
    styleId,
    text: formatCellText(value, numFmt)
  }
}

export function createEmptySheet(name: string): SheetModel {
  return {
    name,
    rows: MIN_ROWS,
    cols: MIN_COLS,
    cells: new Map(),
    merges: [],
    colWidths: new Array<number>(MIN_COLS).fill(DEFAULT_COL_WIDTH_PX),
    rowHeights: new Array<number>(MIN_ROWS).fill(DEFAULT_ROW_HEIGHT_PX),
    frozen: { rows: 0, cols: 0 },
    hidden: false
  }
}

/**
 * Writes the model back through ExcelJS, which preserves far more than a
 * rebuilt-from-values workbook: styles, number formats, merges, column widths,
 * row heights, frozen panes and formulas all survive. Charts and pivot tables
 * still do not — that needs the part-preserving worker path (see
 * plan/office-suite/02-架构设计.md §3).
 */
export async function serializeWorkbook(original: string, model: WorkbookModel): Promise<string> {
  const ExcelJS = await loadExcelJs()
  const bytes = Uint8Array.from(atob(original), (c) => c.charCodeAt(0))
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes.buffer)

  for (const sheet of model.sheets) {
    let worksheet = workbook.getWorksheet(sheet.name)
    if (!worksheet) worksheet = workbook.addWorksheet(sheet.name)

    for (const [key, cell] of sheet.cells) {
      if (!cell.dirty) continue
      const [r, c] = key.split(',').map(Number)
      const target = worksheet.getCell(r + 1, c + 1)
      if (cell.formula) {
        target.value = { formula: cell.formula, result: cell.value as any }
      } else {
        target.value = cell.value as any
      }
      const style = model.styles[cell.styleId]
      if (style?.numFmt) target.numFmt = style.numFmt
    }
  }

  const buffer: ArrayBuffer = await workbook.xlsx.writeBuffer()
  const view = new Uint8Array(buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
