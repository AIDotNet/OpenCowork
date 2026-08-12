/**
 * Bracketed paste (DECSET 2004) markers. Ink strips one leading ESC from the chunk it
 * hands to useInput, so the ESC prefix is optional. A large paste spans several stdin
 * chunks: only the first carries the start marker and only the last the end marker.
 */
// eslint-disable-next-line no-control-regex -- ESC is the paste marker prefix
export const PASTE_START = /(?:\u001B)?\[200~/u
// eslint-disable-next-line no-control-regex -- ESC is the paste marker prefix
export const PASTE_END = /(?:\u001B)?\[201~/u

export function sanitizePastedText(text: string): string {
  return (
    text
      .replace(/\r\n?/gu, '\n')
      // eslint-disable-next-line no-control-regex -- stripping escape sequences is the point
      .replace(/\u001B\[[0-9;?]*[A-Za-z~]/gu, '')
      // eslint-disable-next-line no-control-regex -- filtering raw control bytes is the point
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/gu, '')
  )
}

export type BracketedPasteResult =
  | { kind: 'ignore' }
  | { kind: 'buffer'; next: string }
  | { kind: 'complete'; text: string }
  | { kind: 'pass' }

/**
 * Consume one useInput chunk against an in-progress (or newly started) bracketed paste.
 * Callers keep the returned buffer string in a ref between chunks.
 */
export function consumeBracketedPaste(input: string, buffer: string | null): BracketedPasteResult {
  if (buffer !== null) {
    const endMatch = PASTE_END.exec(input)
    if (!endMatch) return { kind: 'buffer', next: buffer + input }
    return {
      kind: 'complete',
      text: sanitizePastedText(buffer + input.slice(0, endMatch.index))
    }
  }

  const pasteStart = PASTE_START.exec(input)
  if (!pasteStart) return { kind: 'pass' }

  const afterStart = input.slice(pasteStart.index + pasteStart[0].length)
  const pasteEnd = PASTE_END.exec(afterStart)
  if (!pasteEnd) return { kind: 'buffer', next: afterStart }
  return {
    kind: 'complete',
    text: sanitizePastedText(afterStart.slice(0, pasteEnd.index))
  }
}
