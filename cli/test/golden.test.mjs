/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain Node test script */
// PTY golden snapshot tests for the OpenCowork CLI (node:test + node-pty + @xterm/headless).
//
// The CLI runs inside a real pseudo-terminal with the deterministic fixture runtime
// (OPENCOWORK_CLI_FIXTURE=1), a scripted prompt flow is driven through it, and the final
// screen is rendered by a headless xterm and compared against committed golden files at
// the architecture doc's width matrix (40/60/80/100/120/160 columns).
//
//   node --test cli/test/                # compare against cli/test/golden/*.txt
//   UPDATE_GOLDEN=1 node --test cli/test # rewrite golden files
//
// Prompts, spinners, and status lines animate while a turn runs, so snapshots are taken
// only after the screen stabilizes (two identical reads 250ms apart).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const pty = require('node-pty')
const { Terminal } = require('@xterm/headless')

// npm strips the executable bit from node-pty's prebuilt spawn-helper on macOS/Linux
// (same issue scripts/postinstall.mjs fixes for the desktop app); restore it here so a
// fresh `npm install` in cli/ can run the tests without an extra setup step.
if (process.platform !== 'win32') {
  const { chmodSync, readdirSync } = await import('node:fs')
  const prebuilds = join(here, '..', 'node_modules', 'node-pty', 'prebuilds')
  try {
    for (const entry of readdirSync(prebuilds)) {
      try {
        chmodSync(join(prebuilds, entry, 'spawn-helper'), 0o755)
      } catch {
        // This platform directory ships no spawn-helper.
      }
    }
  } catch {
    // Compiled from source; nothing to fix.
  }
}

const cliEntry = join(here, '..', 'dist', 'index.js')
const goldenDir = join(here, 'golden')
const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === '1'

const WIDTH_MATRIX = [40, 60, 80, 100, 120, 160]
const ROWS = 30
const STEP_TIMEOUT_MS = 15_000

function screenText(terminal) {
  const buffer = terminal.buffer.active
  const lines = []
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.baseY + row)
    lines.push(line ? line.translateToString(true) : '')
  }
  return lines.join('\n')
}

function normalize(text, replacements) {
  let output = text
  for (const [from, to] of replacements) output = output.replaceAll(from, to)
  return (
    output
      .replace(/\d+\.\d+\.\d+/gu, 'X.Y.Z')
      .split('\n')
      .map((line) => line.replace(/\s+$/u, ''))
      .join('\n')
      .replace(/\n+$/u, '') + '\n'
  )
}

class CliSession {
  constructor({ cols, rows, tui }) {
    this.home = mkdtempSync(join(tmpdir(), 'oc-golden-home-'))
    this.cwd = mkdtempSync(join(tmpdir(), 'oc-golden-cwd-'))
    this.terminal = new Terminal({ cols, rows, allowProposedApi: true })
    this.output = ''
    this.child = pty.spawn(process.execPath, [cliEntry, '--tui', tui], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: this.cwd,
      env: {
        ...process.env,
        OPENCOWORK_CLI_FIXTURE: '1',
        OPENCOWORK_CLI_NO_UPDATE_CHECK: '1',
        HOME: this.home,
        TERM: 'xterm-256color',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8'
      }
    })
    this.child.onData((data) => {
      this.output += data
      this.terminal.write(data)
    })
  }

  clearOutput() {
    this.output = ''
  }

  write(data) {
    this.child.write(data)
  }

  async waitFor(predicate, label) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < STEP_TIMEOUT_MS) {
      if (predicate(screenText(this.terminal))) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`Timed out waiting for ${label}. Screen:\n${screenText(this.terminal)}`)
  }

  /** Spinners/status lines animate while a turn runs; settle on two identical reads. */
  async waitForStableScreen() {
    const startedAt = Date.now()
    let previous = screenText(this.terminal)
    while (Date.now() - startedAt < STEP_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      const current = screenText(this.terminal)
      if (current === previous) return current
      previous = current
    }
    throw new Error(`Screen never stabilized:\n${previous}`)
  }

  snapshot() {
    return normalize(screenText(this.terminal), [
      [this.cwd, '<cwd>'],
      [this.home, '<home>']
    ])
  }

  dispose() {
    try {
      this.child.kill()
    } catch {
      // Already exited.
    }
    this.terminal.dispose()
  }
}

function compareGolden(name, actual) {
  mkdirSync(goldenDir, { recursive: true })
  const goldenPath = join(goldenDir, `${name}.txt`)
  if (UPDATE_GOLDEN || !existsSync(goldenPath)) {
    writeFileSync(goldenPath, actual)
    return
  }
  const expected = readFileSync(goldenPath, 'utf8')
  assert.equal(
    actual,
    expected,
    `PTY golden mismatch for ${name}. Run UPDATE_GOLDEN=1 node --test cli/test to regenerate.`
  )
}

async function runPromptFlow({ cols, rows, tui }) {
  const session = new CliSession({ cols, rows, tui })
  try {
    await session.waitFor((screen) => screen.includes('❯'), 'prompt to appear')
    session.write('hello world')
    await session.waitFor((screen) => screen.includes('hello world'), 'typed prompt to echo')
    session.write('\r')
    await session.waitFor(
      (screen) => screen.includes('You said: hello world'),
      'fixture assistant reply'
    )
    await session.waitForStableScreen()
    return session.snapshot()
  } finally {
    session.dispose()
  }
}

for (const cols of WIDTH_MATRIX) {
  test(`classic prompt flow golden at ${cols} columns`, async () => {
    const snapshot = await runPromptFlow({ cols, rows: ROWS, tui: 'classic' })
    assert.ok(snapshot.includes('You said: hello world'))
    compareGolden(`classic-${cols}x${ROWS}`, snapshot)
  })
}

test('fullscreen prompt flow golden at 80 columns', async () => {
  const snapshot = await runPromptFlow({ cols: 80, rows: ROWS, tui: 'fullscreen' })
  assert.ok(snapshot.includes('You said: hello world'))
  compareGolden(`fullscreen-80x${ROWS}`, snapshot)
})

test('fullscreen resize redraw does not hard-clear the alternate screen', async () => {
  const session = new CliSession({ cols: 80, rows: ROWS, tui: 'fullscreen' })
  try {
    await session.waitFor((screen) => screen.includes('❯'), 'prompt to appear')
    session.clearOutput()
    session.child.resize(100, ROWS)
    await new Promise((resolve) => setTimeout(resolve, 150))
    // Ink clears its previous dynamic frame with line erases, but fullscreen resizing must not
    // inject CSI 2J/3J and leave a visibly blank alternate-screen frame before rerendering.
    assert.ok(!session.output.includes('\u001B[2J'), 'resize must not erase the fullscreen screen')
    assert.ok(!session.output.includes('\u001B[3J'), 'resize must not clear fullscreen scrollback')
  } finally {
    session.dispose()
  }
})

test('bracketed paste inserts multi-line text as one literal block', async () => {
  const session = new CliSession({ cols: 100, rows: ROWS, tui: 'classic' })
  try {
    await session.waitFor((screen) => screen.includes('❯'), 'prompt to appear')
    session.write('\u001B[200~line one\nline two?\u001B[201~')
    await session.waitFor(
      (screen) => screen.includes('line one') && screen.includes('line two?'),
      'pasted lines to render'
    )
    // The literal '?' inside the paste must not have toggled the shortcut panel.
    const screen = screenText(session.terminal)
    assert.ok(!screen.includes('Toggle shortcuts'), 'paste must not trigger key bindings')
  } finally {
    session.dispose()
  }
})

test('fullscreen wheel scroll locks the viewport and PgDn resumes follow', async () => {
  const session = new CliSession({ cols: 100, rows: 12, tui: 'fullscreen' })
  try {
    await session.waitFor((screen) => screen.includes('❯'), 'prompt to appear')
    // Several turns so the transcript outgrows the 12-row viewport. Text and Enter go
    // in separate PTY writes: a combined chunk would be parsed as one literal insert.
    for (let index = 0; index < 4; index += 1) {
      session.write(`turn ${index}`)
      await session.waitFor((screen) => screen.includes(`turn ${index}`), `typed turn ${index}`)
      session.write('\r')
      await session.waitFor(
        (screen) => screen.includes(`You said: turn ${index}`),
        `fixture reply ${index}`
      )
    }
    // SGR wheel-up report at column 5 / row 3: scroll up and lock.
    session.write('\u001B[<64;5;3M')
    await session.waitFor((screen) => screen.includes('newer'), 'scroll lock indicator')
    session.write('\u001B[6~') // PageDown resumes following the tail.
    await session.waitFor((screen) => !screen.includes('newer'), 'follow mode to resume')
  } finally {
    session.dispose()
  }
})
