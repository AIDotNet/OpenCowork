import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyLatestCompactRequestView,
  compactRequestFence,
  parsePersistedMessageContent,
  parsePersistedMessageMeta,
  parsePersistedMessageUsage
} from '../../src/shared/compact-request-view.ts'

function makeHistory(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
    createdAt: 1_000 + index
  }))
}

function boundary(overrides: Record<string, unknown> = {}) {
  return {
    id: 'boundary',
    role: 'system',
    content: 'Conversation compacted',
    createdAt: 5_000,
    meta: {
      compactBoundary: {
        trigger: 'manual',
        preTokens: 900,
        messagesSummarized: 40,
        summaryId: 'summary'
      }
    },
    ...overrides
  }
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    id: 'summary',
    role: 'user',
    content: '[Context Memory Compressed Summary]\n\nSummary text.',
    createdAt: 5_001,
    meta: { compactSummary: { messagesSummarized: 40, recentMessagesPreserved: false } },
    ...overrides
  }
}

const followUp = { id: 'follow-up', role: 'user', content: 'next question', createdAt: 6_000 }

test('zero-preserve compact view drops earlier history', () => {
  const view = applyLatestCompactRequestView([...makeHistory(40), boundary(), summary(), followUp])
  assert.deepEqual(
    view.map((message) => message.id),
    ['boundary', 'summary', 'follow-up']
  )
  assert.equal(compactRequestFence(view), 'boundary:summary')
})

test('summaryId pairing survives flipped sort order', () => {
  const view = applyLatestCompactRequestView([...makeHistory(40), summary(), boundary(), followUp])
  assert.deepEqual(
    view.map((message) => message.id),
    ['boundary', 'summary', 'follow-up']
  )
})

test('legacy preservedSegment pairing keeps the marked tail', () => {
  const legacyBoundary = boundary({
    meta: {
      compactBoundary: {
        trigger: 'auto',
        preTokens: 900,
        messagesSummarized: 38,
        preservedSegment: { headId: 'm38', anchorId: 'summary', tailId: 'm39' }
      }
    }
  })
  const view = applyLatestCompactRequestView([
    ...makeHistory(40),
    summary(),
    legacyBoundary,
    followUp
  ])
  assert.deepEqual(
    view.map((message) => message.id),
    ['boundary', 'summary', 'm38', 'm39', 'follow-up']
  )
})

test('orphan summary truncates instead of sending full history', () => {
  const view = applyLatestCompactRequestView([...makeHistory(40), summary(), followUp])
  assert.deepEqual(
    view.map((message) => message.id),
    ['summary', 'follow-up']
  )
})

test('latest compact pair wins when the transcript kept older artifacts', () => {
  const first = [
    ...makeHistory(10),
    boundary({ id: 'b1', createdAt: 2_000, meta: { compactBoundary: { summaryId: 's1' } } }),
    summary({ id: 's1', createdAt: 2_001, meta: { compactSummary: { messagesSummarized: 10 } } })
  ]
  const second = [
    ...first,
    { id: 'mid', role: 'assistant', content: 'later work', createdAt: 3_000 },
    boundary({ id: 'b2', createdAt: 4_000, meta: { compactBoundary: { summaryId: 's2' } } }),
    summary({ id: 's2', createdAt: 4_001, meta: { compactSummary: { messagesSummarized: 12 } } }),
    followUp
  ]
  const view = applyLatestCompactRequestView(second)
  assert.deepEqual(
    view.map((message) => message.id),
    ['b2', 's2', 'follow-up']
  )
})

test('plain history passes through unchanged', () => {
  const view = applyLatestCompactRequestView(makeHistory(5))
  assert.equal(view.length, 5)
  assert.equal(compactRequestFence(view), '')
})

test('persisted JSON content and meta are restored for compact marks', () => {
  const content = parsePersistedMessageContent(
    JSON.stringify('[Context Memory Compressed Summary]\n\nKept.')
  )
  const meta = parsePersistedMessageMeta(
    JSON.stringify({ compactSummary: { messagesSummarized: 3, recentMessagesPreserved: false } })
  )
  assert.equal(typeof content, 'string')
  assert.equal(meta?.compactSummary?.messagesSummarized, 3)
})

test('persisted usage is restored for compression trigger tokens', () => {
  const usage = parsePersistedMessageUsage(
    JSON.stringify({ inputTokens: 1200, outputTokens: 40, contextTokens: 1200, contextLength: 200000 })
  )
  assert.equal(usage?.contextTokens, 1200)
  assert.equal(usage?.contextLength, 200000)
  assert.equal(parsePersistedMessageUsage(null), undefined)
  assert.equal(parsePersistedMessageUsage('not-json'), undefined)
})
