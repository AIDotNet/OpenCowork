import assert from 'node:assert/strict'
import test from 'node:test'
import type { ContentBlock } from '../../src/renderer/src/lib/api/types.ts'
import {
  appendThinkingDeltaToBlocks,
  attachThinkingEncryptedToBlocks,
  attachThinkingReasoningIdToBlocks,
  insertBackfilledThinkingIntoBlocks
} from '../../src/renderer/src/lib/content-blocks.ts'

function thinking(
  text: string,
  encrypted?: string
): Extract<ContentBlock, { type: 'thinking' }> {
  return {
    type: 'thinking',
    thinking: text,
    ...(encrypted
      ? { encryptedContent: encrypted, encryptedContentProvider: 'anthropic' as const }
      : {})
  }
}

test('attaches a signature to the last unsigned thinking block', () => {
  const blocks: ContentBlock[] = [thinking('plan one'), { type: 'text', text: 'hello' }]

  attachThinkingEncryptedToBlocks(blocks, 'sig-1', 'anthropic')

  assert.deepEqual(blocks, [
    {
      type: 'thinking',
      thinking: 'plan one',
      encryptedContent: 'sig-1',
      encryptedContentProvider: 'anthropic'
    },
    { type: 'text', text: 'hello' }
  ])
})

test('does not steal an earlier signature when thinking follows text', () => {
  const blocks: ContentBlock[] = [
    thinking('plan one', 'sig-1'),
    { type: 'text', text: 'hello' }
  ]

  attachThinkingEncryptedToBlocks(blocks, 'sig-2', 'anthropic')

  assert.deepEqual(blocks, [
    {
      type: 'thinking',
      thinking: 'plan one',
      encryptedContent: 'sig-1',
      encryptedContentProvider: 'anthropic'
    },
    { type: 'text', text: 'hello' },
    {
      type: 'thinking',
      thinking: '',
      encryptedContent: 'sig-2',
      encryptedContentProvider: 'anthropic',
      redacted: true,
      startedAt: (blocks[2] as { startedAt?: number }).startedAt
    }
  ])
  assert.equal(typeof (blocks[2] as { startedAt?: number }).startedAt, 'number')
})

test('updates the current thinking block when signature_delta follows start', () => {
  const blocks: ContentBlock[] = [thinking('plan one', 'sig-start')]

  attachThinkingEncryptedToBlocks(blocks, 'sig-final', 'anthropic')

  assert.equal(blocks.length, 1)
  assert.deepEqual(blocks[0], {
    type: 'thinking',
    thinking: 'plan one',
    encryptedContent: 'sig-final',
    encryptedContentProvider: 'anthropic'
  })
})

test('keeps the first thinking block first when only text exists', () => {
  const blocks: ContentBlock[] = [{ type: 'text', text: 'hello' }]

  attachThinkingEncryptedToBlocks(blocks, 'sig-1', 'anthropic')

  assert.equal(blocks[0]?.type, 'thinking')
  assert.deepEqual(blocks[1], { type: 'text', text: 'hello' })
  assert.equal((blocks[0] as { encryptedContent?: string }).encryptedContent, 'sig-1')
})

test('later thinking deltas continue a newly signed interleaved block', () => {
  const blocks: ContentBlock[] = [
    thinking('plan one', 'sig-1'),
    { type: 'text', text: 'hello' }
  ]

  attachThinkingEncryptedToBlocks(blocks, 'sig-2', 'anthropic')
  appendThinkingDeltaToBlocks(blocks, 'plan two', 1)

  assert.equal(blocks.length, 3)
  assert.equal(blocks[0]?.type, 'thinking')
  assert.equal((blocks[0] as { encryptedContent?: string }).encryptedContent, 'sig-1')
  assert.equal(blocks[2]?.type, 'thinking')
  assert.equal((blocks[2] as { thinking?: string }).thinking, 'plan two')
  assert.equal((blocks[2] as { encryptedContent?: string }).encryptedContent, 'sig-2')
  assert.equal((blocks[2] as { redacted?: boolean }).redacted, undefined)
})

test('backfilled reasoning lands in front of the answer it produced', () => {
  const blocks: ContentBlock[] = [{ type: 'text', text: 'here is the answer' }]

  insertBackfilledThinkingIntoBlocks(blocks, 'weighed two options', 5)

  assert.equal(blocks.length, 2)
  assert.equal(blocks[0]?.type, 'thinking')
  assert.equal((blocks[0] as { thinking?: string }).thinking, 'weighed two options')
  assert.deepEqual(blocks[1], { type: 'text', text: 'here is the answer' })
})

test('backfilled reasoning steps over the whole trailing text run', () => {
  const blocks: ContentBlock[] = [
    { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
    { type: 'text', text: 'first' },
    { type: 'text', text: 'second' }
  ]

  insertBackfilledThinkingIntoBlocks(blocks, 'late reasoning', 5)

  assert.equal(blocks.length, 4)
  assert.equal(blocks[0]?.type, 'tool_use')
  assert.equal(blocks[1]?.type, 'thinking')
  assert.equal(blocks[2]?.type, 'text')
  assert.equal(blocks[3]?.type, 'text')
})

test('backfilled reasoning merges into the think block already in that slot', () => {
  const blocks: ContentBlock[] = [
    { type: 'thinking', thinking: 'first pass', startedAt: 1, completedAt: 2 },
    { type: 'text', text: 'answer' }
  ]

  insertBackfilledThinkingIntoBlocks(blocks, 'second pass', 5)

  assert.equal(blocks.length, 2)
  assert.equal((blocks[0] as { thinking?: string }).thinking, 'first pass\nsecond pass')
  assert.deepEqual(blocks[1], { type: 'text', text: 'answer' })
})

test('backfilled reasoning after a tool call is appended, not moved', () => {
  const blocks: ContentBlock[] = [
    { type: 'text', text: 'answer' },
    { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }
  ]

  insertBackfilledThinkingIntoBlocks(blocks, 'next step', 5)

  assert.equal(blocks.length, 3)
  assert.equal(blocks[2]?.type, 'thinking')
  assert.equal((blocks[2] as { thinking?: string }).thinking, 'next step')
})

test('backfilled reasoning keeps growing an open think block', () => {
  const blocks: ContentBlock[] = [{ type: 'thinking', thinking: 'planning', startedAt: 1 }]

  insertBackfilledThinkingIntoBlocks(blocks, ' more', 5)

  assert.equal(blocks.length, 1)
  assert.equal((blocks[0] as { thinking?: string }).thinking, 'planning more')
})

test('a reasoning id lands on the newest think block that lacks one', () => {
  const blocks: ContentBlock[] = [
    { type: 'thinking', thinking: 'plan A', reasoningItemId: 'rs_1' },
    { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
    { type: 'thinking', thinking: 'plan B' }
  ]

  attachThinkingReasoningIdToBlocks(blocks, 'rs_2')

  assert.equal((blocks[0] as { reasoningItemId?: string }).reasoningItemId, 'rs_1')
  assert.equal((blocks[2] as { reasoningItemId?: string }).reasoningItemId, 'rs_2')
})

test('a reasoning id never overwrites the id a think block already carries', () => {
  const blocks: ContentBlock[] = [
    { type: 'thinking', thinking: 'plan A', reasoningItemId: 'rs_1' },
    { type: 'text', text: 'answer' }
  ]

  attachThinkingReasoningIdToBlocks(blocks, 'rs_2')

  assert.equal(blocks.length, 2)
  assert.equal((blocks[0] as { reasoningItemId?: string }).reasoningItemId, 'rs_1')
})

test('reasoning with no summary still keeps its replay handle', () => {
  const blocks: ContentBlock[] = [{ type: 'text', text: 'answer' }]

  attachThinkingReasoningIdToBlocks(blocks, 'rs_1')

  assert.equal(blocks[0]?.type, 'thinking')
  assert.equal((blocks[0] as { reasoningItemId?: string }).reasoningItemId, 'rs_1')
  assert.equal((blocks[0] as { redacted?: boolean }).redacted, true)
  assert.deepEqual(blocks[1], { type: 'text', text: 'answer' })
})
