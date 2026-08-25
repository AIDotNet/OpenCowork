// A dynamic frame taller than the terminal makes Ink hard-clear the screen and replay its
// whole static buffer on every render, which wipes scrollback and throws the scrollbar
// around. These tests pin the viewport math that keeps the live tail inside its budget.

import assert from 'node:assert/strict'
import test from 'node:test'
import { computeTranscriptWindow, estimateMessageLines } from '../dist/lib/message-height.js'
import { countWrappedLines, tailWrappedLines, wrapText } from '../dist/lib/text.js'

const WIDTH = 100

function assistantMessage(text, patch = {}) {
  return { id: 'assistant-1', kind: 'assistant', text, streaming: true, ...patch }
}

function longAnswer(paragraphs) {
  return Array.from(
    { length: paragraphs },
    (_, index) =>
      `Paragraph ${index}: the transcript viewport has to keep this reply inside the terminal even while it is still streaming.`
  ).join('\n')
}

test('wrapText breaks on word boundaries like Ink does', () => {
  const lines = wrapText('alpha beta gamma delta', 12)
  assert.deepEqual(lines, ['alpha beta ', 'gamma delta'])
  for (const line of lines) assert.ok(line.length <= 12)
})

test('wrapText keeps blank source lines and hard-breaks over-long words', () => {
  assert.deepEqual(wrapText('a\n\nb', 10), ['a', '', 'b'])
  assert.deepEqual(wrapText('supercalifragilistic', 10), ['supercalif', 'ragilistic'])
})

test('countWrappedLines saturates one past the cap', () => {
  const text = longAnswer(40)
  assert.equal(countWrappedLines(text, WIDTH, 5), 6)
  assert.equal(countWrappedLines(text, WIDTH, 10_000), wrapText(text, WIDTH).length)
})

test('tailWrappedLines returns the newest lines and counts the rest', () => {
  const text = longAnswer(30)
  const tail = tailWrappedLines(text, WIDTH, 4)
  assert.equal(tail.lines.length, 4)
  assert.ok(tail.lines.join('').includes('Paragraph 29'))
  assert.ok(!tail.lines.join('').includes('Paragraph 0:'))
  assert.ok(tail.hiddenLines > 0)
  for (const line of tail.lines) assert.ok(line.length <= WIDTH)
})

test('a huge unbroken line still yields an exact, stable tail', () => {
  const paragraph =
    'The transcript viewport has to keep this reply inside the terminal even while it is still streaming. '
  const base = paragraph.repeat(1200)

  let previous = null
  for (let index = 0; index < 50; index += 1) {
    const tail = tailWrappedLines(`${base}token ${index} `, WIDTH, 6)
    assert.equal(tail.lines.length, 6)
    for (const line of tail.lines) assert.ok(line.length <= WIDTH)
    // Appending must not reflow the rows above the last one, or the reply would shimmer.
    if (previous) assert.deepEqual(tail.lines.slice(0, -1), previous.slice(0, -1))
    previous = tail.lines
  }

  const tail = tailWrappedLines(`${base}THE VERY END`, WIDTH, 6)
  assert.ok(tail.lines.at(-1).endsWith('THE VERY END'))
})

test('a single oversized live message is clipped to the budget', () => {
  const message = assistantMessage(longAnswer(60))
  const budget = 20
  assert.ok(estimateMessageLines(message, WIDTH, false) > budget)

  const window = computeTranscriptWindow({
    anchorIndex: null,
    budgetLines: budget,
    messages: [message],
    showDetails: false,
    width: WIDTH
  })

  assert.equal(window.messages.length, 1)
  assert.ok(window.clippedLines > 0)
  // The clipped copy must render in exactly the budgeted rows: one row too many is what
  // pushes Ink over stdout.rows.
  assert.equal(estimateMessageLines(window.messages[0], WIDTH, false), budget)
  assert.equal(window.heights[0], budget)
})

test('clipping keeps the newest text and leaves the source message untouched', () => {
  const message = assistantMessage(longAnswer(60))
  const window = computeTranscriptWindow({
    anchorIndex: null,
    budgetLines: 20,
    messages: [message],
    showDetails: false,
    width: WIDTH
  })

  const clipped = window.messages[0]
  const rendered = clipped.segments.map((segment) => segment.text).join('\n')
  assert.ok(rendered.includes('Paragraph 59'))
  assert.ok(!rendered.includes('Paragraph 0:'))
  assert.equal(message.segments, undefined, 'the stored message must not be mutated')
  assert.ok(message.text.includes('Paragraph 0:'))
})

test('clipping drops whole leading segments before trimming the last one', () => {
  const message = assistantMessage('', {
    segments: [
      { kind: 'text', text: longAnswer(30) },
      { kind: 'text', text: longAnswer(30) }
    ]
  })
  const window = computeTranscriptWindow({
    anchorIndex: null,
    budgetLines: 12,
    messages: [message],
    showDetails: false,
    width: WIDTH
  })

  assert.equal(window.messages[0].segments.length, 1)
  assert.equal(estimateMessageLines(window.messages[0], WIDTH, false), 12)
})

test('a message that already fits is passed through unclipped', () => {
  const message = assistantMessage(longAnswer(3))
  const window = computeTranscriptWindow({
    anchorIndex: null,
    budgetLines: 20,
    messages: [message],
    showDetails: false,
    width: WIDTH
  })

  assert.equal(window.clippedLines, 0)
  assert.equal(window.messages[0], message)
})

test('older messages are dropped before the anchor is clipped', () => {
  const messages = [{ id: 'u', kind: 'user', text: 'go' }, assistantMessage(longAnswer(60))]
  const window = computeTranscriptWindow({
    anchorIndex: null,
    budgetLines: 20,
    messages,
    showDetails: false,
    width: WIDTH
  })

  assert.equal(window.messages.length, 1)
  assert.equal(window.hiddenAbove, 1)
  assert.ok(window.clippedLines > 0)
})
