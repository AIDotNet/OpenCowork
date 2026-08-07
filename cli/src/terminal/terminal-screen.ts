import type { TuiMode } from '../types.js'

const ENTER_ALTERNATE_SCREEN = '\u001B[?1049h\u001B[H'
const EXIT_ALTERNATE_SCREEN = '\u001B[?1049l'
const SET_TITLE = '\u001B]0;OpenCowork\u0007'
const CLEAR_TITLE = '\u001B]0;\u0007'

export class TerminalScreen {
  private active = false

  constructor(private readonly mode: TuiMode) {}

  enter(): void {
    if (this.active) return
    this.active = true

    process.stdout.write(SET_TITLE)
    if (this.mode === 'fullscreen') process.stdout.write(ENTER_ALTERNATE_SCREEN)
  }

  exit(): void {
    if (!this.active) return
    this.active = false

    if (this.mode === 'fullscreen') process.stdout.write(EXIT_ALTERNATE_SCREEN)
    process.stdout.write(CLEAR_TITLE)
  }
}
