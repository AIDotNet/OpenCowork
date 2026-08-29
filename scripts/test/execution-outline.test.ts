import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mergeLiveToolCallMaps,
  resolveLiveToolCallStatus
} from '../../src/renderer/src/lib/chat/live-tool-call-status.ts'
import type { ToolCallState } from '../../src/renderer/src/lib/agent/types.ts'
import {
  groupToolExecutionRuns,
  type GroupableExecutionBlock
} from '../../src/renderer/src/lib/chat/execution-run-grouping.ts'

function live(
  id: string,
  name: string,
  status: ToolCallState['status'],
  extra: Partial<ToolCallState> = {}
): ToolCallState {
  return { id, name, input: {}, status, requiresApproval: false, ...extra }
}

test('completed tool results beat overlay streaming status', () => {
  assert.equal(
    resolveLiveToolCallStatus(true, live('t1', 'Read', 'streaming'), { isError: false }),
    'completed'
  )
  assert.equal(
    resolveLiveToolCallStatus(true, live('t1', 'Read', 'streaming'), { isError: true }),
    'error'
  )
})

test('in-flight tools without results keep live overlay status', () => {
  assert.equal(resolveLiveToolCallStatus(true, live('t1', 'Read', 'running'), undefined), 'running')
  assert.equal(
    resolveLiveToolCallStatus(true, live('t1', 'Read', 'streaming'), undefined),
    'streaming'
  )
})

test('mergeLiveToolCallMaps prefers completed store status over overlay streaming', () => {
  const overlay = new Map([['t1', live('t1', 'Read', 'streaming')]])
  const store = new Map([
    ['t1', live('t1', 'Read', 'completed', { output: 'done', input: { path: 'a.ts' } })]
  ])
  const merged = mergeLiveToolCallMaps(overlay, store)
  assert.equal(merged?.get('t1')?.status, 'completed')
  assert.equal(merged?.get('t1')?.output, 'done')
  assert.equal((merged?.get('t1')?.input as { path?: string }).path, 'a.ts')
})

test('ended tools without results do not default to canceled', () => {
  assert.equal(resolveLiveToolCallStatus(false, undefined, undefined), 'completed')
  assert.equal(
    resolveLiveToolCallStatus(false, live('t1', 'Read', 'running'), undefined, 'completed'),
    'completed'
  )
})

test('explicit cancellation and terminal run failures remain visible', () => {
  assert.equal(
    resolveLiveToolCallStatus(false, live('t1', 'Read', 'canceled'), undefined),
    'canceled'
  )
  assert.equal(resolveLiveToolCallStatus(false, undefined, undefined, 'cancelled'), 'canceled')
  assert.equal(resolveLiveToolCallStatus(false, undefined, undefined, 'interrupted'), 'canceled')
  assert.equal(resolveLiveToolCallStatus(false, undefined, undefined, 'error'), 'error')
})

function ordinary(id: string): GroupableExecutionBlock {
  return { type: 'tool', id, visibility: 'ordinary' }
}

test('completed thoughts join the adjacent Exploring run', () => {
  const spans = groupToolExecutionRuns([
    { type: 'thinking' },
    ordinary('r1'),
    { type: 'thinking' },
    ordinary('r2'),
    { type: 'other' }
  ])

  assert.equal(spans.length, 1)
  assert.equal(spans[0].startBlockIndex, 0)
  assert.equal(spans[0].endBlockIndex, 3)
  assert.deepEqual(spans[0].itemIds, ['r1', 'r2'])
})

test('live thinking stays in the Exploring run so it can fold into the header', () => {
  const spans = groupToolExecutionRuns([{ type: 'thinking' }, ordinary('r1'), { type: 'thinking' }])

  assert.equal(spans.length, 1)
  assert.equal(spans[0].startBlockIndex, 0)
  assert.equal(spans[0].endBlockIndex, 2)
})

test('thinking without visible tools does not emit an Exploring run', () => {
  const spans = groupToolExecutionRuns([{ type: 'thinking' }, { type: 'other' }])
  assert.equal(spans.length, 0)
})

test('force-visible tools do not swallow a leading thought into their run', () => {
  const spans = groupToolExecutionRuns([
    { type: 'thinking' },
    { type: 'tool', id: 'ask', visibility: 'force' }
  ])

  assert.equal(spans.length, 1)
  assert.equal(spans[0].startBlockIndex, 1)
  assert.equal(spans[0].endBlockIndex, 1)
  assert.deepEqual(spans[0].itemIds, ['ask'])
})

test('settled store results override a stale overlay cancellation', () => {
  const canceledOverlay = new Map([['t1', live('t1', 'Read', 'canceled')]])
  const completedStore = new Map([['t1', live('t1', 'Read', 'completed', { output: 'done' })]])
  const failedStore = new Map([['t1', live('t1', 'Read', 'error', { error: 'failed' })]])

  assert.equal(
    mergeLiveToolCallMaps(canceledOverlay, completedStore)?.get('t1')?.status,
    'completed'
  )
  assert.equal(mergeLiveToolCallMaps(canceledOverlay, failedStore)?.get('t1')?.status, 'error')
  assert.equal(
    mergeLiveToolCallMaps(canceledOverlay, new Map([['t1', live('t1', 'Read', 'running')]]))?.get(
      't1'
    )?.status,
    'canceled'
  )
})
