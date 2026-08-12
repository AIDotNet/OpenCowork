/**
 * Conservative terminal capability detection for progressive TUI enhancement.
 *
 * Bracketed paste and SGR mouse reporting are part of the de-facto xterm baseline every
 * modern emulator implements, so they are keyed off a real TTY only. The Kitty keyboard
 * protocol is detected via environment identity (the reliable out-of-band signal) but is
 * NOT pushed: Ink 5's keypress parser only understands legacy encodings, so enabling
 * CSI-u reporting would break Esc/Enter handling. The detection result is surfaced so
 * status/doctor output can explain the input feature set.
 */

export interface TerminalCapabilities {
  bracketedPaste: boolean
  kittyKeyboard: boolean
  mouse: boolean
  tty: boolean
}

const KITTY_TERM_PROGRAMS = new Set(['wezterm', 'ghostty', 'kitty'])

export function detectTerminalCapabilities(
  env: NodeJS.ProcessEnv = process.env,
  stdout: { isTTY?: boolean } = process.stdout
): TerminalCapabilities {
  const tty = stdout.isTTY === true
  const term = (env.TERM ?? '').toLowerCase()
  const termProgram = (env.TERM_PROGRAM ?? '').toLowerCase()
  const kittyKeyboard =
    tty &&
    (Boolean(env.KITTY_WINDOW_ID) ||
      term.includes('kitty') ||
      term.includes('ghostty') ||
      KITTY_TERM_PROGRAMS.has(termProgram))

  return {
    bracketedPaste: tty,
    kittyKeyboard,
    mouse: tty,
    tty
  }
}
