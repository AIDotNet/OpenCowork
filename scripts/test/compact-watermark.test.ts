import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyCompactWatermark,
  compactWatermarkFence,
  deriveCompactWatermarkFromTranscript,
  normalizeCompactWatermark,
  type CompactWatermark,
  type WatermarkMessage
} from '../../src/shared/compact-watermark.ts'

function history(count: number, startSortOrder = 0): WatermarkMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
    createdAt: 1_000 + index,
    sortOrder: startSortOrder + index
  }))
}

function cut(overrides: Partial<CompactWatermark> = {}): CompactWatermark {
  return {
    generation: 1,
    summaryMessageId: 'summary',
    throughMessageId: 'm39',
    throughSortOrder: 39,
    keepMessageIds: [],
    compactedMessageCount: 40,
    trigger: 'auto',
    preTokens: 120_000,
    createdAt: 5_000,
    ...overrides
  }
}

const summaryRow: WatermarkMessage = {
  id: 'summary',
  role: 'user',
  content: 'Here is a summary of our conversation so far.',
  createdAt: 5_000,
  sortOrder: 40
}

const followUp: WatermarkMessage = {
  id: 'follow-up',
  role: 'user',
  content: 'next question',
  createdAt: 6_000,
  sortOrder: 41
}

test('the cut reduces the transcript to the summary plus later turns', () => {
  const view = applyCompactWatermark([...history(40), summaryRow, followUp], cut())
  assert.deepEqual(
    view.map((message) => message.id),
    ['summary', 'follow-up']
  )
})

test('a second compaction does not resurrect the first compacted range', () => {
  const laterWork: WatermarkMessage[] = [
    { id: 'later-1', role: 'assistant', content: 'more work', createdAt: 6_100, sortOrder: 42 },
    { id: 'later-2', role: 'user', content: 'and more', createdAt: 6_200, sortOrder: 43 }
  ]
  const secondSummary: WatermarkMessage = {
    id: 'summary-2',
    role: 'user',
    content: 'Here is a summary of our conversation so far, again.',
    createdAt: 7_000,
    sortOrder: 44
  }
  const view = applyCompactWatermark(
    [...history(40), summaryRow, followUp, ...laterWork, secondSummary],
    cut({
      generation: 2,
      summaryMessageId: 'summary-2',
      throughMessageId: 'later-2',
      throughSortOrder: 43
    })
  )
  assert.deepEqual(
    view.map((message) => message.id),
    ['summary-2']
  )
})

test('the turn that was streaming when compression ran survives the cut', () => {
  const streaming: WatermarkMessage = {
    id: 'asst-live',
    role: 'assistant',
    content: 'still producing output',
    createdAt: 4_900,
    sortOrder: 39
  }
  const view = applyCompactWatermark(
    [...history(39), streaming, summaryRow, followUp],
    cut({ throughMessageId: 'asst-live', throughSortOrder: 39, keepMessageIds: ['asst-live'] })
  )
  assert.deepEqual(
    view.map((message) => message.id),
    ['summary', 'asst-live', 'follow-up']
  )
})

test('the cut follows the boundary row through a sort-order renumber', () => {
  const renumbered = [...history(40), summaryRow, followUp].map((message) => ({
    ...message,
    sortOrder: (message.sortOrder ?? 0) + 500
  }))
  const view = applyCompactWatermark(renumbered, cut())
  assert.deepEqual(
    view.map((message) => message.id),
    ['summary', 'follow-up']
  )
})

test('rows still waiting for their database position count as the newest', () => {
  const pending: WatermarkMessage = {
    id: 'pending',
    role: 'user',
    content: 'just typed',
    createdAt: 6_500
  }
  const view = applyCompactWatermark([...history(40), summaryRow, pending], cut())
  assert.deepEqual(
    view.map((message) => message.id),
    ['summary', 'pending']
  )
})

test('a missing summary leaves the transcript uncut', () => {
  const visible = [...history(40), followUp]
  const view = applyCompactWatermark(visible, cut())
  assert.deepEqual(
    view.map((message) => message.id),
    visible.map((message) => message.id)
  )
})

test('renderer-only status rows never reach the request', () => {
  const statusRow: WatermarkMessage = {
    id: 'status',
    role: 'system',
    content: '',
    createdAt: 5_500,
    sortOrder: 40,
    meta: { compressionStatus: { state: 'done' } }
  }
  const view = applyCompactWatermark([...history(40), statusRow, summaryRow, followUp], cut())
  assert.deepEqual(
    view.map((message) => message.id),
    ['summary', 'follow-up']
  )
})

test('no cut leaves the transcript alone', () => {
  const view = applyCompactWatermark(history(5), null)
  assert.equal(view.length, 5)
  assert.equal(compactWatermarkFence(null), 'none')
})

test('the fence moves once per compaction and never flaps back', () => {
  const first = compactWatermarkFence(cut())
  const second = compactWatermarkFence(cut({ generation: 2, summaryMessageId: 'summary-2' }))
  assert.notEqual(first, second)
  assert.equal(compactWatermarkFence(cut()), first)
})

test('a legacy boundary/summary pair becomes an equivalent cut', () => {
  const legacy: WatermarkMessage[] = [
    ...history(40),
    {
      id: 'boundary',
      role: 'system',
      content: 'Conversation compacted',
      createdAt: 5_000,
      sortOrder: 40,
      meta: { compactBoundary: { summaryId: 'legacy-summary' } }
    },
    {
      id: 'legacy-summary',
      role: 'user',
      content: '[Context Memory Compressed Summary]\n\nEarlier work.',
      createdAt: 5_001,
      sortOrder: 41,
      meta: { compactSummary: { messagesSummarized: 40 } }
    },
    { ...followUp, sortOrder: 42 }
  ]
  const derived = deriveCompactWatermarkFromTranscript(legacy)
  assert.equal(derived?.summaryMessageId, 'legacy-summary')
  assert.equal(derived?.throughSortOrder, 41)
  assert.equal(derived?.compactedMessageCount, 40)
  assert.deepEqual(
    applyCompactWatermark(legacy, derived).map((message) => message.id),
    ['legacy-summary', 'follow-up']
  )
})

test('a legacy summarizer failure yields no cut', () => {
  const legacy: WatermarkMessage[] = [
    ...history(10),
    {
      id: 'boundary',
      role: 'system',
      content: 'Conversation compacted',
      createdAt: 5_000,
      sortOrder: 10,
      meta: { compactBoundary: { summaryId: 'legacy-summary' } }
    },
    {
      id: 'legacy-summary',
      role: 'user',
      content: '[Context Memory Compressed Summary]\n\nFailed.',
      createdAt: 5_001,
      sortOrder: 11,
      meta: { compactSummary: { summarizerFailed: true } }
    }
  ]
  assert.equal(deriveCompactWatermarkFromTranscript(legacy), null)
})

test('a transcript with no compaction yields no cut', () => {
  assert.equal(deriveCompactWatermarkFromTranscript(history(5)), null)
})

test('a wire payload without a summary id is not a cut', () => {
  assert.equal(normalizeCompactWatermark({ throughSortOrder: 4 }), null)
  assert.equal(normalizeCompactWatermark({ summaryMessageId: 's' }), null)
  assert.equal(normalizeCompactWatermark(null), null)
  const parsed = normalizeCompactWatermark({
    generation: 3,
    summaryMessageId: 's',
    throughMessageId: 'm9',
    throughSortOrder: 9,
    keepMessageIds: ['a', 2, ''],
    compactedMessageCount: 12,
    trigger: 'manual',
    preTokens: 1_000,
    createdAt: 42
  })
  assert.equal(parsed?.generation, 3)
  assert.deepEqual(parsed?.keepMessageIds, ['a'])
  assert.equal(parsed?.trigger, 'manual')
})
