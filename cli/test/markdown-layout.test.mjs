/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain Node test script */
// The transcript viewport sizes itself from lib/markdown-layout.ts before Ink mounts the
// markdown tree. If the two disagree the dynamic frame can outgrow the terminal, which
// makes Ink hard-clear the screen and replay its static buffer on every render.
//
// So these tests render every sample in a real PTY, count the rows Ink produced between
// sentinel lines, and require the measurement to match exactly.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { estimateMarkdownLines, clipMarkdownHead } from '../dist/lib/markdown-layout.js'
import { MARKDOWN_SAMPLES } from './markdown-samples.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const pty = require('node-pty')
const { Terminal } = require('@xterm/headless')

const WIDTHS = [40, 60, 80, 120]
const ROWS = 220

/** Renders every sample at `cols` and returns name -> rows Ink actually produced. */
function renderedHeights(cols) {
  return new Promise((resolve, reject) => {
    const terminal = new Terminal({ cols, rows: ROWS, allowProposedApi: true })
    const child = pty.spawn(process.execPath, [join(here, 'markdown-probe.mjs'), String(cols)], {
      name: 'xterm-256color',
      cols,
      rows: ROWS,
      cwd: join(here, '..'),
      env: { ...process.env, TERM: 'xterm-256color', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }
    })
    let stderr = ''
    child.onData((data) => {
      terminal.write(data)
      stderr += data
    })
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Already exited.
      }
      reject(new Error(`markdown probe timed out at ${cols} columns:\n${stderr}`))
    }, 20_000)

    child.onExit(() => {
      clearTimeout(timer)
      // Give xterm a tick to drain the final frame.
      setTimeout(() => {
        const buffer = terminal.buffer.active
        const lines = []
        for (let row = 0; row < ROWS; row += 1) {
          const line = buffer.getLine(row)
          lines.push(line ? line.translateToString(true).replace(/\s+$/u, '') : '')
        }
        const heights = new Map()
        for (const sample of MARKDOWN_SAMPLES) {
          const start = lines.indexOf(`<<<${sample.name}`)
          const end = lines.indexOf(`>>>${sample.name}`)
          if (start === -1 || end === -1) {
            reject(
              new Error(
                `missing sentinels for ${sample.name} at ${cols} columns. Screen:\n${lines.join('\n')}`
              )
            )
            return
          }
          heights.set(sample.name, end - start - 1)
        }
        resolve({ heights, lines })
      }, 100)
    })
  })
}

for (const cols of WIDTHS) {
  test(`markdown height estimates match the rendered rows at ${cols} columns`, async () => {
    const { heights } = await renderedHeights(cols)
    const mismatches = []
    for (const sample of MARKDOWN_SAMPLES) {
      const actual = heights.get(sample.name)
      const estimated = estimateMarkdownLines(sample.text, cols)
      if (actual !== estimated) {
        mismatches.push(`${sample.name}: rendered ${actual}, estimated ${estimated}`)
      }
    }
    assert.deepEqual(mismatches, [], `markdown height drift at ${cols} columns`)
  })
}

test('tables render with borders when wide and collapse when narrow', async () => {
  const { lines } = await renderedHeights(80)
  const start = lines.indexOf('<<<table')
  const end = lines.indexOf('>>>table')
  const table = lines.slice(start + 1, end)
  assert.ok(
    table.some((line) => line.includes('┌') && line.includes('┬')),
    `expected a bordered table, got:\n${table.join('\n')}`
  )
  assert.ok(table.some((line) => line.includes('Anthropic')))
  assert.ok(table.some((line) => line.includes('├') && line.includes('┼')))
  assert.ok(table.some((line) => line.includes('└') && line.includes('┴')))

  const narrow = await renderedHeights(40)
  const narrowTable = narrow.lines.slice(
    narrow.lines.indexOf('<<<table-many-columns') + 1,
    narrow.lines.indexOf('>>>table-many-columns')
  )
  // Ten bordered cells need more columns than 40; the compact form keeps the data readable.
  assert.ok(
    narrowTable.every((line) => !line.includes('┌')),
    `expected the compact table form, got:\n${narrowTable.join('\n')}`
  )
  assert.ok(narrowTable.some((line) => line.includes('│')))
})

test('clipMarkdownHead keeps whole trailing blocks within budget', () => {
  const doc = Array.from(
    { length: 12 },
    (_, index) => `## Section ${index}\n\nBody paragraph number ${index}.`
  ).join('\n\n')
  const clip = clipMarkdownHead(doc, 60, 10)

  assert.ok(clip.hiddenLines > 0)
  assert.ok(estimateMarkdownLines(clip.text, 60) <= 10)
  assert.ok(clip.text.includes('Section 11'), 'the newest block must survive')
  assert.ok(!clip.text.includes('Section 0\n'), 'the oldest block must be dropped')
})

test('clipMarkdownHead keeps a table whole rather than orphaning its rows', () => {
  const table = ['| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'].join('\n')
  const doc = `Intro paragraph that will be dropped.\n\nSecond paragraph also dropped.\n\n${table}`
  const clip = clipMarkdownHead(doc, 40, 7)

  assert.ok(!clip.text.includes('Intro paragraph'), 'the oldest block must be dropped')
  assert.ok(clip.text.includes('| a | b |'), `expected the header row, got: ${clip.text}`)
  assert.ok(clip.text.includes('| --- | --- |'), 'the separator keeps it parsing as a table')
  assert.ok(estimateMarkdownLines(clip.text, 40) <= 7)
})

test('clipMarkdownHead bounds a single oversized block', () => {
  const paragraph = `${'word '.repeat(4000)}END`
  const clip = clipMarkdownHead(paragraph, 60, 12)

  assert.ok(estimateMarkdownLines(clip.text, 60) <= 12)
  assert.ok(clip.text.trimEnd().endsWith('END'), 'the newest text must stay visible')
  assert.ok(clip.hiddenLines > 0)
})
