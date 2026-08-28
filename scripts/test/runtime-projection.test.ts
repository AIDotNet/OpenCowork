import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'
import type { AgentStreamEvent } from '../../src/shared/agent-stream-protocol.ts'
import { RuntimeProjectionEngine } from '../../src/shared/runtime-projection/engine.ts'
import { RuntimePatchJournal } from '../../src/shared/runtime-projection/journal.ts'
import {
  applyRuntimeEnvelope,
  applyRuntimeEvent,
  assistantMessageIdForRun,
  createEmptyProjection,
  filterProjectionBySession,
  getUnmappedStreamEventCounts,
  isRunScopedAssistantMessageId,
  projectionHasSessionOverlay,
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

test('streamed tool arguments reach the overlay before the call is generated', () => {
  const engine = new RuntimeProjectionEngine('epoch-a', 'worker-a', { ids: sequentialIds() })
  engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 1,
    events: [
      { type: 'loop_start' },
      { type: 'tool_use_streaming_start', toolCallId: 'call-1', toolName: 'Read' }
    ]
  })
  assert.equal(engine.snapshot.toolCalls[0]?.input, null)

  engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 2,
    events: [{ type: 'tool_use_args_delta', toolCallId: 'call-1', partialInput: { path: 'AGE' } }]
  })

  // Without this the overlay showed a tool as streaming with no arguments until
  // the entire input had arrived.
  assert.equal(engine.snapshot.toolCalls[0]?.status, 'streaming')
  assert.equal(engine.snapshot.toolCalls[0]?.input?.path, 'AGE')
  assert.equal(engine.snapshot.toolCalls[0]?.toolName, 'Read')
})

test('an argument delta for an unknown call is ignored rather than inventing one', () => {
  const engine = new RuntimeProjectionEngine('epoch-a', 'worker-a', { ids: sequentialIds() })
  engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 1,
    events: [
      { type: 'loop_start' },
      // The delta carries no tool name, so a call it has never seen cannot be
      // materialised without inventing one.
      { type: 'tool_use_args_delta', toolCallId: 'ghost', partialInput: { path: 'x' } }
    ]
  })
  assert.deepEqual(engine.snapshot.toolCalls, [])
})

test('run lifecycle events land on the run overlay', () => {
  const engine = new RuntimeProjectionEngine('epoch-a', 'worker-a', { ids: sequentialIds() })
  engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 1,
    events: [
      { type: 'loop_start' },
      { type: 'iteration_start', iteration: 2 },
      {
        type: 'request_retry',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 500,
        statusCode: 429,
        reason: 'rate limited'
      }
    ]
  })

  const run = engine.snapshot.runs[0]
  assert.equal(run?.iteration, 2)
  assert.equal(run?.requestRetry?.attempt, 1)
  assert.equal(run?.requestRetry?.statusCode, 429)
  assert.equal(run?.requestRetry?.reason, 'rate limited')
})

test('a new iteration clears the retry left over from the previous one', () => {
  const engine = new RuntimeProjectionEngine('epoch-a', 'worker-a', { ids: sequentialIds() })
  engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 1,
    events: [
      { type: 'loop_start' },
      { type: 'request_retry', attempt: 1, maxAttempts: 3, delayMs: 500, reason: 'timeout' }
    ]
  })
  assert.ok(engine.snapshot.runs[0]?.requestRetry)

  engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 2,
    events: [{ type: 'iteration_start', iteration: 3 }]
  })

  // A retry banner that outlives the request it described is worse than none.
  assert.equal(engine.snapshot.runs[0]?.requestRetry, null)
  assert.equal(engine.snapshot.runs[0]?.iteration, 3)
})

test('compression phases move from summarizing to completed', () => {
  const engine = new RuntimeProjectionEngine('epoch-a', 'worker-a', { ids: sequentialIds() })
  engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 1,
    events: [
      { type: 'loop_start' },
      { type: 'context_compression_start', attempt: 1, maxAttempts: 2, preTokens: 12_000 }
    ]
  })
  assert.equal(engine.snapshot.runs[0]?.compression?.phase, 'summarizing')
  assert.equal(engine.snapshot.runs[0]?.compression?.preTokens, 12_000)

  engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 2,
    events: [
      {
        type: 'context_compressed',
        originalCount: 40,
        newCount: 8,
        keptMessageCount: 6,
        summarizerFailed: false
      }
    ]
  })
  assert.equal(engine.snapshot.runs[0]?.compression?.phase, 'completed')
  assert.equal(engine.snapshot.runs[0]?.compression?.keptMessageCount, 6)
})

test('a sub-agent lifecycle lands on its own overlay row', () => {
  const engine = new RuntimeProjectionEngine('epoch-a', 'worker-a', { ids: sequentialIds() })
  engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 1,
    events: [
      { type: 'loop_start' },
      {
        type: 'sub_agent_queued',
        subAgentName: 'researcher',
        toolUseId: 'task-1',
        input: { subagent_type: 'Explore', description: 'find the thing' }
      }
    ]
  })
  let sub = engine.snapshot.subAgents[0]
  assert.equal(sub?.phase, 'queued')
  assert.equal(sub?.displayName, 'Explore')
  assert.equal(sub?.description, 'find the thing')

  engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 2,
    events: [
      { type: 'sub_agent_dequeued', subAgentName: 'researcher', toolUseId: 'task-1' },
      {
        type: 'sub_agent_iteration',
        subAgentName: 'researcher',
        toolUseId: 'task-1',
        iteration: 2,
        assistantMessage: { id: 'm1', role: 'assistant', content: '', createdAt: 1 }
      },
      {
        type: 'sub_agent_text_delta',
        subAgentName: 'researcher',
        toolUseId: 'task-1',
        text: 'looking'
      }
    ]
  })
  sub = engine.snapshot.subAgents[0]
  assert.equal(sub?.phase, 'running')
  assert.equal(sub?.iteration, 2)
  assert.equal(sub?.streamingText, 'looking')
  // Fields the later patches said nothing about must survive.
  assert.equal(sub?.displayName, 'Explore')

  engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 3,
    events: [
      {
        type: 'sub_agent_end',
        subAgentName: 'researcher',
        toolUseId: 'task-1',
        result: {
          success: true,
          output: 'found it',
          reportSubmitted: true,
          toolCallCount: 2,
          iterations: 2,
          usage: { inputTokens: 10, outputTokens: 5 }
        }
      }
    ]
  })
  sub = engine.snapshot.subAgents[0]
  assert.equal(sub?.phase, 'completed')
  assert.equal(sub?.success, true)
  assert.equal(sub?.report, 'found it')
  assert.equal(sub?.reportStatus, 'submitted')
  assert.ok(sub?.completedAt)
})

test('a synthesized fallback report stays fallback after sub-agent end', () => {
  const engine = new RuntimeProjectionEngine('epoch-a', 'worker-a', { ids: sequentialIds() })
  engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 1,
    events: [
      { type: 'loop_start' },
      {
        type: 'sub_agent_start',
        subAgentName: 'researcher',
        toolUseId: 'task-1',
        input: {},
        promptMessage: { id: 'p', role: 'user', content: 'go', createdAt: 1 }
      },
      {
        type: 'sub_agent_report_update',
        subAgentName: 'researcher',
        toolUseId: 'task-1',
        report: '',
        status: 'retrying'
      },
      {
        type: 'sub_agent_report_update',
        subAgentName: 'researcher',
        toolUseId: 'task-1',
        report: 'synthesized from transcript',
        status: 'fallback'
      },
      {
        type: 'sub_agent_end',
        subAgentName: 'researcher',
        toolUseId: 'task-1',
        result: {
          success: false,
          output: 'synthesized from transcript',
          reportSubmitted: true,
          reportStatus: 'fallback',
          toolCallCount: 3,
          iterations: 4,
          endReason: 'error',
          usage: { inputTokens: 10, outputTokens: 5 },
          error: 'Sub-agent finished without a final report.'
        }
      }
    ]
  })

  const sub = engine.snapshot.subAgents[0]
  assert.equal(sub?.phase, 'completed')
  assert.equal(sub?.success, false)
  assert.equal(sub?.report, 'synthesized from transcript')
  assert.equal(sub?.reportStatus, 'fallback')
})

test('a report arriving after a sub-agent finished does not revive it', () => {
  const engine = new RuntimeProjectionEngine('epoch-a', 'worker-a', { ids: sequentialIds() })
  engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 1,
    events: [
      { type: 'loop_start' },
      {
        type: 'sub_agent_start',
        subAgentName: 'r',
        toolUseId: 'task-1',
        input: {},
        promptMessage: { id: 'p', role: 'user', content: 'go', createdAt: 1 }
      },
      {
        type: 'sub_agent_end',
        subAgentName: 'r',
        toolUseId: 'task-1',
        result: {
          success: true,
          output: 'done',
          toolCallCount: 0,
          iterations: 1,
          usage: { inputTokens: 1, outputTokens: 1 }
        }
      },
      {
        type: 'sub_agent_report_update',
        subAgentName: 'r',
        toolUseId: 'task-1',
        report: 'late report',
        status: 'submitted'
      }
    ]
  })

  const sub = engine.snapshot.subAgents[0]
  assert.equal(sub?.phase, 'completed')
  assert.equal(sub?.report, 'late report')
})

test('a sub-agent delta for an unknown task is dropped', () => {
  const engine = new RuntimeProjectionEngine('epoch-a', 'worker-a', { ids: sequentialIds() })
  engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 1,
    events: [
      { type: 'loop_start' },
      { type: 'sub_agent_text_delta', subAgentName: 'ghost', toolUseId: 'nope', text: 'x' }
    ]
  })
  assert.deepEqual(engine.snapshot.subAgents, [])
})

test('an unprojectable event is excluded on purpose, not counted as a gap', () => {
  // request_debug is dev-only diagnostics with no overlay reader, and the
  // summarizer's draft tokens never reach this projection at all: the worker
  // publishes them as live-only frames the host skips before ingest. Counting
  // either as an unmapped gap would overstate the work left to retire legacy.
  const before = getUnmappedStreamEventCounts()
  const engine = new RuntimeProjectionEngine('epoch-a', 'worker-a', { ids: sequentialIds() })
  engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 1,
    events: [
      { type: 'loop_start' },
      { type: 'context_compression_delta', text: 'draft' },
      { type: 'translation_buffer_update', content: 'x' }
    ]
  })
  const after = getUnmappedStreamEventCounts()
  for (const type of ['context_compression_delta', 'translation_buffer_update']) {
    const wasCounted = before.find((entry) => entry.type === type)?.count ?? 0
    const isCounted = after.find((entry) => entry.type === type)?.count ?? 0
    assert.equal(isCounted, wasCounted, `${type} must not be reported as an unmapped gap`)
  }
})

test('an event type this build does not know is counted rather than dropped silently', () => {
  // Every type in the current protocol is decided, so this only fires when a
  // worker is newer than the window reading it. Counting it is what makes that
  // skew visible instead of a silently missing overlay.
  const unknownType = 'future_event_from_a_newer_worker'
  const before =
    getUnmappedStreamEventCounts().find((entry) => entry.type === unknownType)?.count ?? 0
  const engine = new RuntimeProjectionEngine('epoch-a', 'worker-a', { ids: sequentialIds() })
  engine.applyStreamEnvelope({
    runId: 'run-1',
    sessionId: 'session-1',
    seq: 1,
    events: [{ type: 'loop_start' }, { type: unknownType } as unknown as AgentStreamEvent]
  })
  const after =
    getUnmappedStreamEventCounts().find((entry) => entry.type === unknownType)?.count ?? 0
  assert.equal(after, before + 1)
})

/**
 * Every agent stream event type must have a decided projection status: mapped to
 * a runtime event, or explicitly excluded with a reason. Silence is the failure
 * mode this guards — a new event type added to the protocol would otherwise fall
 * into `default` and be dropped without anyone choosing that.
 */
test('every stream event type has a decided projection status', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..')
  const protocol = readFileSync(path.join(repoRoot, 'src/shared/agent-stream-protocol.ts'), 'utf8')
  const reducer = readFileSync(
    path.join(repoRoot, 'src/shared/runtime-projection/reducer.ts'),
    'utf8'
  )

  const union = protocol.slice(
    protocol.indexOf('export type AgentStreamEvent'),
    protocol.indexOf('export type AgentStreamEnvelope')
  )
  // Top-level union members only: nested block shapes such as the `tool_use`
  // inside tool_use_generated are not stream events.
  const streamTypes = new Set(
    [...union.matchAll(/^\s{2}\|\s*\{?\s*type:\s*'([a-z_0-9]+)'/gmu)].map((match) => match[1])
  )
  assert.ok(streamTypes.size > 40, `expected the full union, parsed ${streamTypes.size}`)

  const projectFn = reducer.slice(
    reducer.indexOf('export function projectStreamEvent'),
    reducer.indexOf('export function applyRuntimeEvent')
  )
  const decided = new Set(
    [...projectFn.matchAll(/case '([a-z_0-9]+)':/gu)].map((match) => match[1])
  )

  const undecided = [...streamTypes].filter((type) => !decided.has(type)).sort()

  // Every type is now either mapped or explicitly excluded with a reason. A new
  // stream event added to the protocol lands here until someone decides which it
  // is, which is the point: the alternative is silently dropping it.
  assert.deepEqual(undecided, [])
})

test('a projection missing a newer overlay collection is read, not crashed on', () => {
  // A projection outlives the code that built it: the host can be on a different
  // build than the window reading it, and a dev reload leaves a live store holding
  // an object shaped by the previous module. Treating an absent collection as
  // empty is the difference between a missing overlay and a dead renderer.
  const stale = createEmptyProjection('epoch-a', 'worker-a') as AgentRuntimeProjection & {
    subAgents?: unknown
  }
  delete stale.subAgents

  const filtered = filterProjectionBySession(stale as AgentRuntimeProjection, 'session-1')
  assert.deepEqual(filtered.subAgents, [])
  assert.equal(projectionHasSessionOverlay(stale as AgentRuntimeProjection, 'session-1'), false)
  assert.equal(
    sessionOverlayRefsEqual(stale as AgentRuntimeProjection, filtered),
    true,
    'an empty stale projection still compares equal to its filtered form'
  )

  const applied = applyRuntimeEvent(stale as AgentRuntimeProjection, {
    type: 'runtime.run-changed',
    runId: 'run-1',
    sessionId: 'session-1',
    status: 'running',
    assistantMessageId: null,
    iteration: null,
    lastStopReason: null,
    requestRetry: null,
    compression: null
  })
  assert.equal(applied.runs.length, 1)
  assert.deepEqual(applied.subAgents, [])
})

test('run-scoped assistant message ids are recognisable so they never reach stored records', () => {
  assert.equal(isRunScopedAssistantMessageId(assistantMessageIdForRun('run-1')), true)
  // Transcript rows are renderer-generated nanoids; anything that must name a
  // stored row relies on this telling the two apart.
  assert.equal(isRunScopedAssistantMessageId('rca2c5z5sSm4zy2j2aMCd'), false)
  assert.equal(isRunScopedAssistantMessageId(null), false)
})
