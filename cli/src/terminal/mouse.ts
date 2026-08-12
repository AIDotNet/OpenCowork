/**
 * SGR extended mouse reporting (DECSET 1006) parser. Sequences look like
 * `ESC [ < button ; column ; row (M|m)` — `M` press / wheel, `m` release. Ink strips a
 * single leading ESC from the chunk it hands to useInput handlers, so the pattern
 * treats the ESC prefix as optional.
 */

export interface TerminalMouseEvent {
  button: number
  column: number
  row: number
  release: boolean
}

// eslint-disable-next-line no-control-regex -- ESC is the SGR mouse report prefix
const MOUSE_SEQUENCE = /(?:\u001B)?\[<(\d+);(\d+);(\d+)([Mm])/gu

export function containsMouseSequence(input: string): boolean {
  MOUSE_SEQUENCE.lastIndex = 0
  return MOUSE_SEQUENCE.test(input)
}

export function parseMouseEvents(input: string): TerminalMouseEvent[] {
  const events: TerminalMouseEvent[] = []
  MOUSE_SEQUENCE.lastIndex = 0
  for (const match of input.matchAll(MOUSE_SEQUENCE)) {
    events.push({
      button: Number(match[1]),
      column: Number(match[2]),
      row: Number(match[3]),
      release: match[4] === 'm'
    })
  }
  return events
}

/** Wheel steps: negative scrolls up (older content), positive scrolls down. */
export function wheelDelta(event: TerminalMouseEvent): number {
  if (event.button === 64) return -1
  if (event.button === 65) return 1
  return 0
}

/** Left button press without the motion flag (bit 5). */
export function isLeftClickPress(event: TerminalMouseEvent): boolean {
  return !event.release && (event.button & 0b1100_0011) === 0
}
