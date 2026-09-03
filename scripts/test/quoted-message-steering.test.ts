import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildSteeringWireMessage,
  planQuotedMessageDelivery,
  reorderSteerMessageAfterToolResults,
  STEERING_MESSAGE_SYSTEM_REMIND
} from '../../src/renderer/src/lib/chat/quoted-message-steering.ts'

const ACTIVE = {
  activeRunId: 'run_1',
  hasActiveRun: true,
  hasCommand: false,
  hasSelectedFileReferences: false
}

// The regression this file exists to catch: a steer typed during a run must go to
// the running run, not to the queue that only drains after the run ends.
test('a steer typed during a live run is injected into that run', () => {
  assert.deepEqual(planQuotedMessageDelivery(ACTIVE), { route: 'inject', runId: 'run_1' })
})

test('falls back to the queue when there is no run to inject into', () => {
  assert.deepEqual(planQuotedMessageDelivery({ ...ACTIVE, hasActiveRun: false }), {
    route: 'queue',
    reason: 'no_active_run'
  })
})

test('falls back to the queue when the worker runId is unknown', () => {
  // A renderer reload drops the sessionId -> runId binding until runtime-reattach
  // rebuilds it. Injection has no address to send to during that window.
  for (const activeRunId of [undefined, null, '', '   ']) {
    assert.deepEqual(planQuotedMessageDelivery({ ...ACTIVE, activeRunId }), {
      route: 'queue',
      reason: 'unknown_run_id'
    })
  }
})

test('falls back to the queue when the message still needs the full send pipeline', () => {
  // Slash-command expansion and @file reads happen inside sendMessage. Injecting
  // the raw text would send an unexpanded /command to the model.
  assert.deepEqual(planQuotedMessageDelivery({ ...ACTIVE, hasCommand: true }), {
    route: 'queue',
    reason: 'needs_full_send_pipeline'
  })
  assert.deepEqual(planQuotedMessageDelivery({ ...ACTIVE, hasSelectedFileReferences: true }), {
    route: 'queue',
    reason: 'needs_full_send_pipeline'
  })
})

test('the wire copy leads with the steering reminder and keeps the user content', () => {
  const wire = buildSteeringWireMessage({
    id: 'm1',
    role: 'user',
    content: [{ type: 'text', text: 'check the official docs' }],
    createdAt: 1
  })

  assert.deepEqual(wire.content, [
    { type: 'text', text: STEERING_MESSAGE_SYSTEM_REMIND },
    { type: 'text', text: 'check the official docs' }
  ])
})

test('string content is normalized into blocks behind the reminder', () => {
  const wire = buildSteeringWireMessage({
    id: 'm1',
    role: 'user',
    content: 'check the official docs',
    createdAt: 1
  })

  assert.deepEqual(wire.content, [
    { type: 'text', text: STEERING_MESSAGE_SYSTEM_REMIND },
    { type: 'text', text: 'check the official docs' }
  ])
})

test('the wire copy drops quotedPending, which is transcript-only bookkeeping', () => {
  // Left on, request assembly on a later turn would shuffle this message to the
  // tail a second time.
  const wire = buildSteeringWireMessage({
    id: 'm1',
    role: 'user',
    content: 'steer',
    createdAt: 1,
    meta: { quotedPending: true }
  })
  assert.equal(wire.meta, undefined)

  const withOtherMeta = buildSteeringWireMessage({
    id: 'm2',
    role: 'user',
    content: 'steer',
    createdAt: 1,
    meta: { quotedPending: true, selectedFileReads: { files: [] } }
  })
  assert.deepEqual(withOtherMeta.meta, { selectedFileReads: { files: [] } })
})

const assistantWithToolUse = {
  id: 'a1',
  role: 'assistant' as const,
  content: [
    { type: 'text' as const, text: 'looking' },
    { type: 'tool_use' as const, id: 't1', name: 'Read', input: {} }
  ],
  createdAt: 1
}
const toolResult = {
  id: 'r1',
  role: 'user' as const,
  content: [{ type: 'tool_result' as const, toolUseId: 't1', content: 'ok' }],
  createdAt: 3
}
const steer = {
  id: 's1',
  role: 'user' as const,
  content: 'check the official docs',
  createdAt: 2,
  source: 'quoted' as const,
  meta: { quotedPending: true }
}

test('the steer moves below the tool results it was rendered above', () => {
  // Optimistic order: the bubble is appended while the tool call is still running,
  // so it lands between the assistant tool_use and its tool_result. Leaving it
  // there would put a user turn inside a tool pair on the next request.
  const settled = reorderSteerMessageAfterToolResults(
    [assistantWithToolUse, steer, toolResult],
    's1'
  )

  assert.deepEqual(
    settled?.map((message) => message.id),
    ['a1', 'r1', 's1']
  )
  assert.equal(settled?.[2].meta, undefined)
})

test('multiple tool result rows are all stepped over', () => {
  const second = { ...toolResult, id: 'r2' }
  const settled = reorderSteerMessageAfterToolResults(
    [assistantWithToolUse, steer, toolResult, second],
    's1'
  )

  assert.deepEqual(
    settled?.map((message) => message.id),
    ['a1', 'r1', 'r2', 's1']
  )
})

test('messages after the tool results keep their place', () => {
  const answer = { id: 'a2', role: 'assistant' as const, content: 'on it', createdAt: 4 }
  const settled = reorderSteerMessageAfterToolResults(
    [assistantWithToolUse, steer, toolResult, answer],
    's1'
  )

  // The steer belongs between the results and the reply to it, not at the tail.
  assert.deepEqual(
    settled?.map((message) => message.id),
    ['a1', 'r1', 's1', 'a2']
  )
})

test('a steer with no tool results behind it only loses the pending marker', () => {
  const settled = reorderSteerMessageAfterToolResults([assistantWithToolUse, steer], 's1')

  assert.deepEqual(
    settled?.map((message) => message.id),
    ['a1', 's1']
  )
  assert.equal(settled?.[1].meta, undefined)
})

test('an already settled steer reports no change', () => {
  const settled = { ...steer, meta: undefined }
  assert.equal(reorderSteerMessageAfterToolResults([assistantWithToolUse, settled], 's1'), null)
})

test('an unknown message id reports no change', () => {
  assert.equal(reorderSteerMessageAfterToolResults([assistantWithToolUse, steer], 'missing'), null)
})
