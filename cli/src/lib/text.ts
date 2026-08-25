import stringWidth from 'string-width'
import wrapAnsi from 'wrap-ansi'

const segmenter =
  typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : undefined

export function graphemes(value: string): string[] {
  if (!segmenter) return Array.from(value)
  return Array.from(segmenter.segment(value), ({ segment }) => segment)
}

export function fitText(value: string, width: number, suffix = '…'): string {
  if (width <= 0) return ''
  if (stringWidth(value) <= width) return value

  const suffixWidth = stringWidth(suffix)
  let output = ''

  for (const grapheme of graphemes(value)) {
    if (stringWidth(output + grapheme) + suffixWidth > width) break
    output += grapheme
  }

  return output + (width >= suffixWidth ? suffix : '')
}

/**
 * Wraps one newline-free line exactly the way Ink lays `<Text wrap="wrap">` out
 * (`wrap-ansi` with the same options). Height estimates drive the transcript viewport,
 * and a word-wrapping renderer measured with character wrapping under-reports by a line
 * per paragraph — enough drift for a frame to outgrow the terminal.
 */
function wrapSourceLine(sourceLine: string, safeWidth: number): string[] {
  if (!sourceLine) return ['']
  return wrapAnsi(sourceLine, safeWidth, { trim: false, hard: true }).split('\n')
}

export function wrapText(value: string, width: number): string[] {
  const safeWidth = Math.max(1, width)
  const lines: string[] = []
  for (const sourceLine of value.split(/\r?\n/u)) {
    lines.push(...wrapSourceLine(sourceLine, safeWidth))
  }
  return lines
}

/**
 * Number of wrapped lines `value` occupies, stopping once `cap` is exceeded. Returns
 * `cap + 1` for anything taller. The viewport only needs to know whether a message fits,
 * so capping keeps a growing multi-megabyte reply from being re-wrapped every frame.
 */
export function countWrappedLines(value: string, width: number, cap: number): number {
  const safeWidth = Math.max(1, width)
  const limit = Math.max(1, cap)
  let count = 0
  for (const sourceLine of value.split(/\r?\n/u)) {
    // Every character occupies at least one column, so a source line this long cannot
    // wrap into `limit` rows. Short-circuit instead of wrapping a multi-megabyte line.
    if (sourceLine.length > limit * safeWidth) return limit + 1
    count += wrapSourceLine(sourceLine, safeWidth).length
    if (count > limit) return limit + 1
  }
  return count
}

/**
 * Suffix of `sourceLine` guaranteed to contain the last `rows` wrapped lines: each of
 * those rows holds at most `width` columns and every character spans at least one column.
 *
 * Wrapping a suffix puts line breaks in slightly different places than wrapping the whole
 * line would, so the origin is quantized: a streaming reply then keeps the same breaks
 * while it grows instead of reflowing every visible row on every delta.
 */
function tailSlice(sourceLine: string, safeWidth: number, rows: number): string {
  const needed = (rows + 1) * safeWidth
  if (sourceLine.length <= needed) return sourceLine
  const chunk = safeWidth * 8
  const start = Math.floor((sourceLine.length - needed) / chunk) * chunk
  const slice = sourceLine.slice(start)
  const first = slice.charCodeAt(0)
  // Never start on the trailing half of a surrogate pair.
  return first >= 0xdc00 && first <= 0xdfff ? slice.slice(1) : slice
}

/**
 * Last `maxLines` wrapped lines of `value`, plus how many wrapped lines were dropped.
 * Source lines are consumed back-to-front and wrapping stops once the quota is filled,
 * so showing the tail of a huge streaming reply costs viewport-sized work.
 */
export function tailWrappedLines(
  value: string,
  width: number,
  maxLines: number
): { hiddenLines: number; lines: string[] } {
  const safeWidth = Math.max(1, width)
  const quota = Math.max(1, maxLines)
  const sourceLines = value.split(/\r?\n/u)
  const lines: string[] = []
  let hiddenLines = 0

  for (let index = sourceLines.length - 1; index >= 0; index -= 1) {
    if (lines.length >= quota) {
      // Counting the remaining wrapped lines exactly would mean wrapping the whole buffer
      // again, so charge one per source line — a floor on what is actually hidden.
      hiddenLines += 1
      continue
    }
    const sourceLine = sourceLines[index]!
    const room = quota - lines.length
    const slice = tailSlice(sourceLine, safeWidth, room)
    const wrapped = wrapSourceLine(slice, safeWidth)
    if (wrapped.length > room) {
      hiddenLines += wrapped.length - room
      // Charge the columns dropped by `tailSlice` too, at best-case density.
      if (slice.length < sourceLine.length) {
        hiddenLines += Math.ceil((sourceLine.length - slice.length) / safeWidth)
      }
      lines.unshift(...wrapped.slice(wrapped.length - room))
      continue
    }
    lines.unshift(...wrapped)
  }

  return { hiddenLines, lines }
}

export function hasTerminalInputControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * Drops control characters that would move the cursor or reprogram the terminal, keeping
 * tab, newline, and carriage return. Matched with a regex rather than a per-character
 * filter because this runs over whole assistant replies on every streamed frame.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const TERMINAL_PREVIEW_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u
const TERMINAL_PREVIEW_CONTROLS_GLOBAL = new RegExp(TERMINAL_PREVIEW_CONTROLS, 'gu')

export function stripTerminalPreviewControls(value: string): string {
  if (!TERMINAL_PREVIEW_CONTROLS.test(value)) return value
  return value.replace(TERMINAL_PREVIEW_CONTROLS_GLOBAL, '')
}

export function padText(value: string, width: number): string {
  const fitted = fitText(value, width)
  return fitted + ' '.repeat(Math.max(0, width - stringWidth(fitted)))
}

export function lineStart(graphemeList: string[], cursor: number): number {
  for (let index = cursor - 1; index >= 0; index -= 1) {
    if (graphemeList[index] === '\n') return index + 1
  }
  return 0
}

export function lineEnd(graphemeList: string[], cursor: number): number {
  const index = graphemeList.indexOf('\n', cursor)
  return index === -1 ? graphemeList.length : index
}

export function previousWordStart(graphemeList: string[], cursor: number): number {
  let index = cursor
  while (index > 0 && /\s/u.test(graphemeList[index - 1] ?? '')) index -= 1
  while (index > 0 && !/\s/u.test(graphemeList[index - 1] ?? '')) index -= 1
  return index
}

export function nextWordEnd(graphemeList: string[], cursor: number): number {
  let index = cursor
  while (index < graphemeList.length && /\s/u.test(graphemeList[index] ?? '')) index += 1
  while (index < graphemeList.length && !/\s/u.test(graphemeList[index] ?? '')) index += 1
  return index
}
