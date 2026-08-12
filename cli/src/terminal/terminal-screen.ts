import type { TuiMode } from '../types.js'
import { detectTerminalCapabilities, type TerminalCapabilities } from './terminal-capabilities.js'

const ENTER_ALTERNATE_SCREEN = '\u001B[?1049h\u001B[H'
const EXIT_ALTERNATE_SCREEN = '\u001B[?1049l'
const SET_TITLE = '\u001B]0;OpenCowork\u0007'
const CLEAR_TITLE = '\u001B]0;\u0007'
const CLEAR_SCREEN = '\u001B[2J\u001B[3J\u001B[H'
const ENABLE_BRACKETED_PASTE = '\u001B[?2004h'
const DISABLE_BRACKETED_PASTE = '\u001B[?2004l'
// Button-event tracking (1000) with SGR extended coordinates (1006): wheel + clicks,
// no motion spam, coordinates beyond column 223.
const ENABLE_MOUSE = '\u001B[?1000h\u001B[?1006h'
const DISABLE_MOUSE = '\u001B[?1006l\u001B[?1000l'

export class TerminalScreen {
  private active = false
  readonly capabilities: TerminalCapabilities

  constructor(private readonly mode: TuiMode) {
    this.capabilities = detectTerminalCapabilities()
  }

  /** Mouse reporting only makes sense with an app-owned viewport (alt-screen mode). */
  get mouseEnabled(): boolean {
    return this.mode === 'fullscreen' && this.capabilities.mouse
  }

  enter(): void {
    if (this.active) return
    this.active = true

    process.stdout.write(SET_TITLE)
    if (this.mode === 'fullscreen') process.stdout.write(ENTER_ALTERNATE_SCREEN)
    if (this.capabilities.bracketedPaste) process.stdout.write(ENABLE_BRACKETED_PASTE)
    if (this.mouseEnabled) process.stdout.write(ENABLE_MOUSE)
    process.stdout.write(CLEAR_SCREEN)
  }

  redraw(): void {
    if (!this.active) return
    process.stdout.write(CLEAR_SCREEN)
  }

  exit(): void {
    if (!this.active) return
    this.active = false

    if (this.mouseEnabled) process.stdout.write(DISABLE_MOUSE)
    if (this.capabilities.bracketedPaste) process.stdout.write(DISABLE_BRACKETED_PASTE)
    if (this.mode === 'fullscreen') process.stdout.write(EXIT_ALTERNATE_SCREEN)
    process.stdout.write(CLEAR_TITLE)
  }
}
