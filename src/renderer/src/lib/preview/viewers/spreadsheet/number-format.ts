import type { CellValue } from './types'

/**
 * A pragmatic subset of Excel number formatting — enough that a real workbook
 * looks right. Full ECMA-376 format parsing belongs in the worker-side adapter.
 */

const EXCEL_EPOCH = Date.UTC(1899, 11, 30)

function pad(n: number, width = 2): string {
  return String(Math.floor(Math.abs(n))).padStart(width, '0')
}

function excelSerialToDate(serial: number): Date {
  return new Date(EXCEL_EPOCH + Math.round(serial * 86400000))
}

function groupThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function formatNumber(value: number, decimals: number, thousands: boolean): string {
  const fixed = Math.abs(value).toFixed(decimals)
  const [intPart, fracPart] = fixed.split('.')
  const head = thousands ? groupThousands(intPart) : intPart
  const body = fracPart ? `${head}.${fracPart}` : head
  return value < 0 ? `-${body}` : body
}

function isDateFormat(format: string): boolean {
  const stripped = format.replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '')
  return /[dmyhs]/i.test(stripped) && !/[#0]/.test(stripped)
}

function formatDate(date: Date, format: string): string {
  const tokens: Array<[RegExp, () => string]> = [
    [/yyyy/gi, () => String(date.getFullYear())],
    [/yy/gi, () => pad(date.getFullYear() % 100)],
    [/mmmm/g, () => date.toLocaleString(undefined, { month: 'long' })],
    [/mmm/g, () => date.toLocaleString(undefined, { month: 'short' })],
    [/dddd/gi, () => date.toLocaleString(undefined, { weekday: 'long' })],
    [/ddd/gi, () => date.toLocaleString(undefined, { weekday: 'short' })],
    [/dd/gi, () => pad(date.getDate())],
    [/d/gi, () => String(date.getDate())],
    [/hh/g, () => pad(date.getHours())],
    [/h/g, () => String(date.getHours())],
    [/ss/g, () => pad(date.getSeconds())],
    [/s/g, () => String(date.getSeconds())]
  ]

  // Minutes vs months both use "m" in Excel; resolve by neighbouring tokens.
  let out = format.replace(/\[[^\]]*\]/g, '')
  out = out.replace(/mm(?=:)|(?<=:)mm/g, () => pad(date.getMinutes()))
  for (const [pattern, resolve] of tokens) {
    out = out.replace(pattern, resolve)
  }
  out = out.replace(/mm/g, () => pad(date.getMonth() + 1))
  out = out.replace(/m/g, () => String(date.getMonth() + 1))
  return out.replace(/["\\]/g, '')
}

export function formatCellText(value: CellValue, numFmt?: string): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'

  if (value instanceof Date) {
    return formatDate(value, numFmt && isDateFormat(numFmt) ? numFmt : 'yyyy-mm-dd')
  }

  if (typeof value === 'number') {
    if (!numFmt || numFmt === 'General') {
      if (Number.isInteger(value)) return String(value)
      return String(Number(value.toFixed(10)))
    }

    if (isDateFormat(numFmt)) return formatDate(excelSerialToDate(value), numFmt)

    // Use the positive section of a multi-section format.
    const section = numFmt.split(';')[0]
    const percent = section.includes('%')
    const scaled = percent ? value * 100 : value
    const thousands = section.includes('#,##') || section.includes('#,#')
    const decimalMatch = /\.([0#]+)/.exec(section)
    const decimals = decimalMatch ? decimalMatch[1].length : 0

    const literalPrefix = /^(?:\[[^\]]*\])?(?:"([^"]*)"|(\$|¥|€|£))/.exec(section)
    const prefix = literalPrefix ? (literalPrefix[1] ?? literalPrefix[2] ?? '') : ''

    const body = formatNumber(scaled, decimals, thousands)
    return `${prefix}${body}${percent ? '%' : ''}`
  }

  return String(value)
}

/** Right-align numbers and dates the way Excel does, unless overridden. */
export function defaultAlign(value: CellValue): 'left' | 'right' | 'center' {
  if (typeof value === 'number') return 'right'
  if (value instanceof Date) return 'right'
  if (typeof value === 'boolean') return 'center'
  return 'left'
}

/** Parses user input the way Excel does when they finish editing a cell. */
export function parseCellInput(raw: string): { value: CellValue; formula?: string } {
  const text = raw
  if (text.startsWith('=')) return { value: null, formula: text.slice(1) }
  if (text === '') return { value: null }

  const upper = text.toUpperCase()
  if (upper === 'TRUE') return { value: true }
  if (upper === 'FALSE') return { value: false }

  const numeric = text.replace(/,/g, '')
  if (numeric !== '' && !Number.isNaN(Number(numeric)) && /^-?[\d.]+(e[-+]?\d+)?$/i.test(numeric)) {
    return { value: Number(numeric) }
  }

  if (text.endsWith('%')) {
    const pct = Number(text.slice(0, -1))
    if (!Number.isNaN(pct)) return { value: pct / 100 }
  }

  return { value: text }
}
