import type { CellData, CellValue, SheetModel } from './types'
import { cellKey } from './types'

/**
 * A small formula evaluator covering the functions people actually type into a
 * sheet by hand. Anything it cannot parse evaluates to #NAME? rather than
 * silently rendering blank, so a wrong result is visible instead of invisible.
 */

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'ref'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'fn'; value: string }

const FUNCTION_NAMES = new Set([
  'SUM',
  'AVERAGE',
  'COUNT',
  'COUNTA',
  'MIN',
  'MAX',
  'ROUND',
  'ABS',
  'IF',
  'CONCAT',
  'CONCATENATE',
  'LEN',
  'INT',
  'SQRT'
])

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (ch === ' ') {
      i++
      continue
    }
    if (ch === '"') {
      let j = i + 1
      let text = ''
      while (j < input.length && input[j] !== '"') text += input[j++]
      tokens.push({ kind: 'str', value: text })
      i = j + 1
      continue
    }
    if (/[0-9.]/.test(ch)) {
      let j = i
      while (j < input.length && /[0-9.]/.test(input[j])) j++
      tokens.push({ kind: 'num', value: Number(input.slice(i, j)) })
      i = j
      continue
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i
      while (j < input.length && /[A-Za-z0-9_$:.]/.test(input[j])) j++
      const word = input.slice(i, j)
      const upper = word.toUpperCase()
      if (FUNCTION_NAMES.has(upper) && input[j] === '(') tokens.push({ kind: 'fn', value: upper })
      else tokens.push({ kind: 'ref', value: word.replace(/\$/g, '').toUpperCase() })
      i = j
      continue
    }
    tokens.push({ kind: 'op', value: ch })
    i++
  }
  return tokens
}

function parseRef(ref: string): { r: number; c: number } | null {
  const match = /^([A-Z]+)(\d+)$/.exec(ref)
  if (!match) return null
  let col = 0
  for (const ch of match[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { r: Number(match[2]) - 1, c: col - 1 }
}

function expandRange(ref: string): Array<{ r: number; c: number }> | null {
  const [from, to] = ref.split(':')
  if (!to) {
    const single = parseRef(from)
    return single ? [single] : null
  }
  const a = parseRef(from)
  const b = parseRef(to)
  if (!a || !b) return null
  const out: Array<{ r: number; c: number }> = []
  for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) {
    for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) out.push({ r, c })
  }
  return out
}

const ERROR_NAME = '#NAME?'
const ERROR_VALUE = '#VALUE!'
const ERROR_DIV0 = '#DIV/0!'

type Value = number | string | boolean

function toNumber(value: Value | null): number {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isNaN(n) ? 0 : n
  }
  return 0
}

class Parser {
  private pos = 0

  constructor(
    private readonly tokens: Token[],
    private readonly lookup: (r: number, c: number) => CellValue
  ) {}

  parse(): Value {
    const value = this.expression()
    return value
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }

  private expression(): Value {
    let left = this.term()
    for (;;) {
      const token = this.peek()
      if (token?.kind !== 'op') break
      if (token.value === '+' || token.value === '-') {
        this.pos++
        const right = this.term()
        left =
          token.value === '+' ? toNumber(left) + toNumber(right) : toNumber(left) - toNumber(right)
      } else if (token.value === '&') {
        this.pos++
        const right = this.term()
        left = `${left}${right}`
      } else if (['=', '<', '>'].includes(token.value)) {
        this.pos++
        let op = token.value
        const next = this.peek()
        if (next?.kind === 'op' && (next.value === '=' || next.value === '>')) {
          op += next.value
          this.pos++
        }
        const right = this.term()
        const a = toNumber(left)
        const b = toNumber(right)
        left =
          op === '='
            ? a === b
            : op === '<'
              ? a < b
              : op === '>'
                ? a > b
                : op === '<='
                  ? a <= b
                  : op === '>='
                    ? a >= b
                    : a !== b
      } else break
    }
    return left
  }

  private term(): Value {
    let left = this.factor()
    for (;;) {
      const token = this.peek()
      if (token?.kind !== 'op' || (token.value !== '*' && token.value !== '/')) break
      this.pos++
      const right = this.factor()
      if (token.value === '*') left = toNumber(left) * toNumber(right)
      else {
        const divisor = toNumber(right)
        if (divisor === 0) throw new Error(ERROR_DIV0)
        left = toNumber(left) / divisor
      }
    }
    return left
  }

  private factor(): Value {
    const token = this.peek()
    if (!token) throw new Error(ERROR_VALUE)

    if (token.kind === 'op' && token.value === '-') {
      this.pos++
      return -toNumber(this.factor())
    }
    if (token.kind === 'op' && token.value === '(') {
      this.pos++
      const value = this.expression()
      if (this.peek()?.kind === 'op' && (this.peek() as { value: string }).value === ')') this.pos++
      return value
    }
    if (token.kind === 'num') {
      this.pos++
      return token.value
    }
    if (token.kind === 'str') {
      this.pos++
      return token.value
    }
    if (token.kind === 'fn') {
      this.pos++
      return this.callFunction(token.value)
    }
    if (token.kind === 'ref') {
      this.pos++
      const upper = token.value.toUpperCase()
      if (upper === 'TRUE') return true
      if (upper === 'FALSE') return false
      const cells = expandRange(token.value)
      if (!cells || cells.length !== 1) throw new Error(ERROR_NAME)
      const value = this.lookup(cells[0].r, cells[0].c)
      if (value === null) return 0
      if (value instanceof Date) return value.getTime()
      return value
    }
    throw new Error(ERROR_VALUE)
  }

  private collectArgs(): Array<{ scalar?: Value; range?: Array<{ r: number; c: number }> }> {
    const args: Array<{ scalar?: Value; range?: Array<{ r: number; c: number }> }> = []
    if (this.peek()?.kind === 'op' && (this.peek() as { value: string }).value === '(') this.pos++
    for (;;) {
      const token = this.peek()
      if (!token) break
      if (token.kind === 'op' && token.value === ')') {
        this.pos++
        break
      }
      if (token.kind === 'op' && token.value === ',') {
        this.pos++
        continue
      }
      if (token.kind === 'ref' && token.value.includes(':')) {
        const range = expandRange(token.value)
        this.pos++
        args.push({ range: range ?? [] })
        continue
      }
      args.push({ scalar: this.expression() })
    }
    return args
  }

  private flatten(
    args: Array<{ scalar?: Value; range?: Array<{ r: number; c: number }> }>
  ): CellValue[] {
    const out: CellValue[] = []
    for (const arg of args) {
      if (arg.range) {
        for (const { r, c } of arg.range) out.push(this.lookup(r, c))
      } else if (arg.scalar !== undefined) {
        out.push(arg.scalar as CellValue)
      }
    }
    return out
  }

  private callFunction(name: string): Value {
    const args = this.collectArgs()
    const values = this.flatten(args)
    const numbers = values.filter((v): v is number => typeof v === 'number')

    switch (name) {
      case 'SUM':
        return numbers.reduce((a, b) => a + b, 0)
      case 'AVERAGE':
        return numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : 0
      case 'COUNT':
        return numbers.length
      case 'COUNTA':
        return values.filter((v) => v !== null && v !== '').length
      case 'MIN':
        return numbers.length ? Math.min(...numbers) : 0
      case 'MAX':
        return numbers.length ? Math.max(...numbers) : 0
      case 'ABS':
        return Math.abs(toNumber(values[0] as Value))
      case 'INT':
        return Math.floor(toNumber(values[0] as Value))
      case 'SQRT':
        return Math.sqrt(toNumber(values[0] as Value))
      case 'LEN':
        return String(values[0] ?? '').length
      case 'ROUND': {
        const digits = toNumber(values[1] as Value)
        const factor = 10 ** digits
        return Math.round(toNumber(values[0] as Value) * factor) / factor
      }
      case 'IF':
        return (values[0] ? values[1] : values[2]) as Value
      case 'CONCAT':
      case 'CONCATENATE':
        return values.map((v) => (v === null ? '' : String(v))).join('')
      default:
        throw new Error(ERROR_NAME)
    }
  }
}

export function evaluateFormula(
  formula: string,
  lookup: (r: number, c: number) => CellValue
): CellValue {
  try {
    const parser = new Parser(tokenize(formula), lookup)
    const result = parser.parse()
    if (typeof result === 'boolean') return result
    if (typeof result === 'number') return Number.isFinite(result) ? result : ERROR_DIV0
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : ERROR_VALUE
    return message.startsWith('#') ? message : ERROR_VALUE
  }
}

/**
 * Recomputes every formula cell. Chains resolve by iterating a few passes,
 * which is enough for hand-authored sheets and cannot loop forever.
 */
export function recalculate(sheet: SheetModel, format: (cell: CellData) => string): void {
  const lookup = (r: number, c: number): CellValue => sheet.cells.get(cellKey(r, c))?.value ?? null
  const formulaKeys = [...sheet.cells.entries()]
    .filter(([, cell]) => cell.formula)
    .map(([key]) => key)
  if (formulaKeys.length === 0) return

  for (let pass = 0; pass < 3; pass++) {
    let changed = false
    for (const key of formulaKeys) {
      const cell = sheet.cells.get(key)
      if (!cell?.formula) continue
      const next = evaluateFormula(cell.formula, lookup)
      if (next !== cell.value) {
        cell.value = next
        cell.text = format(cell)
        changed = true
      }
    }
    if (!changed) break
  }
}
