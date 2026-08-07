import stringWidth from 'string-width'

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

export function wrapText(value: string, width: number): string[] {
  const safeWidth = Math.max(1, width)
  const lines: string[] = []
  for (const sourceLine of value.split(/\r?\n/u)) {
    if (!sourceLine) {
      lines.push('')
      continue
    }
    let current = ''
    for (const grapheme of graphemes(sourceLine)) {
      if (stringWidth(current + grapheme) > safeWidth && current) {
        lines.push(current)
        current = ''
      }
      current += grapheme
    }
    lines.push(current)
  }
  return lines
}

export function hasTerminalInputControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export function stripTerminalPreviewControls(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0
      return !(
        code <= 0x08 ||
        code === 0x0b ||
        code === 0x0c ||
        (code >= 0x0e && code <= 0x1f) ||
        code === 0x7f
      )
    })
    .join('')
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
