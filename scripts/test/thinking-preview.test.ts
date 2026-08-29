import assert from 'node:assert/strict'
import test from 'node:test'
import { getLiveThinkingPreview } from '../../src/renderer/src/lib/chat/thinking-preview.ts'

test('uses the last cleaned fragment after **** separators', () => {
  const preview = getLiveThinkingPreview(
    'Verifying code status****Verifying code status****Designing bot challenge middleware with route metadata'
  )
  assert.equal(preview.text, 'Designing bot challenge middleware with route metadata')
  assert.equal(preview.generation, 3)
})

test('does not bump generation while the same fragment grows', () => {
  const first = getLiveThinkingPreview('Checking the session store')
  const second = getLiveThinkingPreview('Checking the session store for stale tokens')
  assert.equal(first.generation, 1)
  assert.equal(second.generation, 1)
  assert.equal(second.text, 'Checking the session store for stale tokens')
})

test('caps a long last fragment', () => {
  const preview = getLiveThinkingPreview('A'.repeat(90))
  assert.equal(preview.text.endsWith('…'), true)
  assert.ok(preview.text.length <= 72)
})

test('uses the last sentence of a long unseparated paragraph', () => {
  const preview = getLiveThinkingPreview(
    `${'Checking the session store for stale tokens. '.repeat(3)}Designing bot challenge middleware.`
  )
  assert.equal(preview.text, 'Designing bot challenge middleware.')
  assert.equal(preview.generation, 1)
})
