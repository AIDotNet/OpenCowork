import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentStreamEvent } from '../../src/shared/agent-stream-protocol.ts'
import { RuntimeProjectionEngine } from '../../src/shared/runtime-projection/engine.ts'
import { RuntimePatchJournal } from '../../src/shared/runtime-projection/journal.ts'
import {
  applyRuntimeEnvelope,
  assistantMessageIdForRun,
  createEmptyProjection,
  isRunScopedAssistantMessageId,
  sessionOverlayRefsEqual
} from '../../src/shared/runtime-projection/reducer.ts'
import type { AgentRuntimeProjection } from '../../src/shared/runtime-contracts/generated/contracts.ts'

function sequentialIds() {
  let next = 0
  let now = 1_700_000_000_000
  return {
    now: () => {
      now += 1
      return now
    },
    nextId: () => {
      next += 1
      return `evt-${next}`
    }
  }
}

function overlay(projection: AgentRuntimeProjection) {
  return {
    revision: projection.projectionRevision,
    runs: projection.runs,
    messages: projection.messages,
    toolCalls: projection.toolCalls,
    approvals: projection.approvals
  }
}

function replay(envelopes: Parameters<typeof applyRuntimeEnvelope>[1][]) {
  let state = createEmptyProjection('epoch-a', 'worker-a')
  for (const envelope of envelopes) {
    state = applyRuntimeEnvelope(state, envelope)
  }
  return state
}

const startAndText: AgentStreamEvent[] = [
  { type: 'loop_start' },
  { type: 'text_delta', text: 'Hello' },
  { type: 'thinking_delta', thinking: 'hmm' },
  {
    type: 'tool_call_start',
    toolCall: {
      id: 'tool-1',
      name: 'Read',
      input: { path: 'a.ts' },
      status: 'running',
      requiresApproval: false
    }
  },
  {
    type: 'tool_call_result',
    toolCall: {
      id: 'tool-1',
      name: 'Read',
      input: { path: 'a.ts' },
      status: 'completed',
      output: 'file contents',
      requiresApproval: false
    }
  },
  { type: 'loop_end', reason: 'completed' }
]

test('snapshot plus patches matches a full replay', () => {
  const engine = new RuntimeProjectionEngine('epoch-a', 'worker-a', { ids: sequentialIds() })
  engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 1,
    events: [startAndText[0], startAndText[1]]
  })
  const checkpoint = engine.snapshot.projectionRevision
  const snapshot = structuredClone(engine.snapshot)
  engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 2,
    events: startAndText.slice(2)
  })

  const attach = engine.attach({
    subscriberId: 'sub-1',
    knownGatewayEpoch: 'epoch-a',
    knownProjectionRevision: checkpoint,
    sessionId: null
  })
  assert.equal(attach.mode, 'patches')
  let restored = structuredClone(snapshot)
  for (const envelope of attach.patches) {
    restored = applyRuntimeEnvelope(restored, envelope)
  }
  assert.deepEqual(overlay(restored), overlay(engine.snapshot))
})

test('full patch replay matches the live snapshot', () => {
  const engine = new RuntimeProjectionEngine('epoch-a', 'worker-a', { ids: sequentialIds() })
  const emitted = engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 3,
    events: startAndText
  })
  assert.deepEqual(overlay(replay(emitted)), overlay(engine.snapshot))
})

test('journal overflow forces a snapshot attach', () => {
  const engine = new RuntimeProjectionEngine('epoch-a', 'worker-a', {
    ids: sequentialIds(),
    journal: new RuntimePatchJournal(2, 1024)
  })
  engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 1,
    events: startAndText
  })
  assert.equal(engine.journalOverflowed, true)
  const attach = engine.attach({
    subscriberId: 'sub-1',
    knownGatewayEpoch: 'epoch-a',
    knownProjectionRevision: 0,
    sessionId: null
  })
  assert.equal(attach.mode, 'snapshot')
  assert.ok(attach.snapshot)
  assert.equal(attach.snapshot.messages[0]?.text, 'Hello')
})

test('expired attach after overlay retention commit', () => {
  const engine = new RuntimeProjectionEngine('epoch-a', 'worker-a', { ids: sequentialIds() })
  engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 1,
    events: startAndText
  })
  engine.commitRun('session-1', 'run-1')
  const attach = engine.attach({
    subscriberId: 'sub-1',
    knownGatewayEpoch: 'epoch-a',
    knownProjectionRevision: null,
    sessionId: 'session-1'
  })
  assert.equal(attach.mode, 'expired')
  assert.equal(attach.errorCode, 'runtime_expired')
})

test('batched and unbatched stream envelopes reduce to the same overlay', () => {
  const batched = new RuntimeProjectionEngine('epoch-a', 'worker-a', { ids: sequentialIds() })
  batched.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 3,
    events: startAndText
  })

  const unbatched = new RuntimeProjectionEngine('epoch-a', 'worker-a', { ids: sequentialIds() })
  startAndText.forEach((event, index) => {
    unbatched.applyStreamEnvelope({
      runId: 'run-1',
      sessionId: 'session-1',
      seq: index + 1,
      events: [event]
    })
  })

  const left = overlay(batched.snapshot)
  const right = overlay(unbatched.snapshot)
  assert.equal(left.messages[0]?.text, right.messages[0]?.text)
  assert.equal(left.messages[0]?.thinking, right.messages[0]?.thinking)
  assert.equal(left.toolCalls[0]?.toolCallId, right.toolCalls[0]?.toolCallId)
  assert.equal(left.toolCalls[0]?.output, 'file contents')
  assert.equal(left.runs[0]?.status, right.runs[0]?.status)
  assert.equal(left.revision, right.revision)
})

test('duplicate stream seqs are ignored so durable replay cannot double-apply', () => {
  const engine = new RuntimeProjectionEngine('epoch-a', 'worker-a', { ids: sequentialIds() })
  engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 1,
    events: startAndText
  })
  const first = overlay(engine.snapshot)
  const skipped = engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 1,
    events: startAndText
  })
  assert.equal(skipped.length, 0)
  assert.deepEqual(overlay(engine.snapshot), first)
})

test('session overlay equality ignores other sessions and global revision', () => {
  const run = {
    runId: 'run-1',
    sessionId: 'session-1',
    status: 'running' as const,
    assistantMessageId: 'asst:run-1',
    lastSeq: 1
  }
  const left = {
    ...createEmptyProjection('epoch-a', 'worker-a'),
    projectionRevision: 4,
    runs: [run]
  }
  const right = {
    ...createEmptyProjection('epoch-a', 'worker-a'),
    projectionRevision: 9,
    runs: [run]
  }
  assert.equal(sessionOverlayRefsEqual(left, right), true)
  assert.equal(sessionOverlayRefsEqual(left, { ...right, runs: [{ ...run, lastSeq: 2 }] }), false)
})

test('loop_start assistantMessageId is reused for later deltas on the same run', () => {
  const engine = new RuntimeProjectionEngine('epoch-a', 'worker-a', { ids: sequentialIds() })
  engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 1,
    events: [
      { type: 'loop_start', assistantMessageId: 'msg-worker' },
      { type: 'text_delta', text: 'Hi' }
    ]
  })
  engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 2,
    events: [{ type: 'text_delta', text: ' there' }]
  })
  assert.equal(engine.snapshot.runs[0]?.assistantMessageId, 'msg-worker')
  assert.equal(engine.snapshot.messages[0]?.messageId, 'msg-worker')
  assert.equal(engine.snapshot.messages[0]?.text, 'Hi there')
})

test('tool_use_generated leaves streaming so live cards stop showing receiving args', () => {
  const engine = new RuntimeProjectionEngine('epoch-a', 'worker-a', { ids: sequentialIds() })
  engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 1,
    events: [
      { type: 'loop_start' },
      {
        type: 'tool_use_streaming_start',
        toolCallId: 'call-1',
        toolName: 'Read'
      }
    ]
  })
  assert.equal(engine.snapshot.toolCalls[0]?.status, 'streaming')

  engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 2,
    events: [
      {
        type: 'tool_use_generated',
        toolUseBlock: {
          id: 'call-1',
          name: 'Read',
          input: { path: 'AGENTS.md' }
        }
      }
    ]
  })

  assert.equal(engine.snapshot.toolCalls[0]?.status, 'running')
  assert.equal(engine.snapshot.toolCalls[0]?.input?.path, 'AGENTS.md')
})

test('run-scoped assistant message ids are recognisable so they never reach stored records', () => {
  assert.equal(isRunScopedAssistantMessageId(assistantMessageIdForRun('run-1')), true)
  // Transcript rows are renderer-generated nanoids; anything that must name a
  // stored row relies on this telling the two apart.
  assert.equal(isRunScopedAssistantMessageId('rca2c5z5sSm4zy2j2aMCd'), false)
  assert.equal(isRunScopedAssistantMessageId(null), false)
})
