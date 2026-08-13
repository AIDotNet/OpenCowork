import assert from 'node:assert/strict'
import test from 'node:test'
import { computeTranscriptWindow, estimateMessageLines } from '../dist/lib/message-height.js'
import {
  estimateSubAgentGroupLines,
  formatElapsedDuration,
  formatSubAgentActivity,
  groupTranscriptMessages,
  layoutSubAgentRow,
  mergeSubAgentDisplay,
  subAgentGroupStartIndex,
  summarizeSubAgentGroup,
  toolPrimaryField
} from '../dist/lib/sub-agent-display.js'

function agentMessage(id, patch = {}) {
  return {
    id,
    kind: 'tool',
    title: patch.name ?? 'explore',
    status: patch.phase === 'completed' ? 'success' : patch.phase === 'error' ? 'error' : 'running',
    subAgent: {
      name: 'explore',
      description: 'Inspect workspace',
      model: 'K3-256k',
      effort: 'high',
      toolCount: 13,
      tokens: 31_000,
      startedAt: 1_000,
      phase: 'running',
      ...patch
    }
  }
}

test('toolPrimaryField prefers command/pattern over empty values', () => {
  assert.equal(toolPrimaryField({ pattern: 'Submit|Encode', path: 'src' }), 'Submit|Encode')
  assert.equal(toolPrimaryField({ command: 'ls -la' }), 'ls -la')
  assert.equal(toolPrimaryField({}), '')
})

test('formatSubAgentActivity includes the primary argument', () => {
  assert.equal(formatSubAgentActivity('Grep', 'Submit|Encode'), 'Used Grep (Submit|Encode)')
  assert.equal(formatSubAgentActivity('Read'), 'Used Read')
})

test('formatElapsedDuration matches the dense terminal style', () => {
  assert.equal(formatElapsedDuration(4_000), '4s')
  assert.equal(formatElapsedDuration(150_000), '2m 30s')
  assert.equal(formatElapsedDuration(180_000), '3m')
})

test('mergeSubAgentDisplay keeps current activity unless patched', () => {
  const merged = mergeSubAgentDisplay(
    {
      name: 'explore',
      description: 'Inspect workspace',
      toolCount: 1,
      startedAt: 1_000,
      phase: 'running',
      currentActivity: 'Used Grep (foo)'
    },
    { toolCount: 2, report: 'partial' }
  )
  assert.equal(merged.currentActivity, 'Used Grep (foo)')
  assert.equal(merged.toolCount, 2)
  assert.equal(merged.report, 'partial')
})

test('groupTranscriptMessages groups consecutive sub-agent rows', () => {
  const messages = [
    { id: 'u', kind: 'user', text: 'go' },
    agentMessage('a'),
    agentMessage('b', { description: 'Trace path', phase: 'completed', completedAt: 151_000 }),
    { id: 'r', kind: 'tool', title: 'Read fixture.txt', status: 'success', summary: 'Read 3 lines' },
    agentMessage('c')
  ]
  const blocks = groupTranscriptMessages(messages)
  assert.equal(blocks.length, 4)
  assert.equal(blocks[0].kind, 'message')
  assert.equal(blocks[1].kind, 'subAgentGroup')
  assert.deepEqual(
    blocks[1].messages.map((message) => message.id),
    ['a', 'b']
  )
  assert.equal(blocks[2].kind, 'message')
  assert.equal(blocks[3].kind, 'subAgentGroup')
  assert.equal(blocks[3].messages[0].id, 'c')
})

test('summarizeSubAgentGroup counts running vs completed agents', () => {
  const summary = summarizeSubAgentGroup(
    [
      agentMessage('a', { phase: 'completed', completedAt: 151_000 }).subAgent,
      agentMessage('b').subAgent
    ],
    211_000
  )
  assert.equal(summary.total, 2)
  assert.equal(summary.done, 1)
  assert.equal(summary.running, 1)
  assert.equal(summary.active, true)
  assert.equal(summary.elapsedMs, 210_000)
})

test('layoutSubAgentRow drops model/effort/tokens before truncating the name', () => {
  const wide = layoutSubAgentRow(
    agentMessage('a').subAgent,
    120,
    'Completed',
    151_000
  )
  assert.match(wide.meta, /K3-256k/)
  assert.match(wide.meta, /31k tok/)
  assert.match(wide.status, /Completed/)

  const narrow = layoutSubAgentRow(agentMessage('a').subAgent, 42, 'Running', 151_000)
  assert.equal(narrow.name, 'explore')
  assert.doesNotMatch(narrow.meta, /K3-256k/)
  assert.doesNotMatch(narrow.meta, /tok/)
  assert.match(narrow.status, /Running/)
})

test('estimateSubAgentGroupLines counts header, rows, and live activity', () => {
  const messages = [
    agentMessage('a', { phase: 'completed', completedAt: 151_000, currentActivity: '' }),
    agentMessage('b', { currentActivity: 'Used Grep (spawn agents)' })
  ]
  assert.equal(estimateSubAgentGroupLines(messages, 80, false), 5)
  const withReport = [
    agentMessage('a', {
      phase: 'completed',
      completedAt: 151_000,
      report: 'Found the fixture workspace layout.'
    })
  ]
  assert.ok(estimateSubAgentGroupLines(withReport, 80, true) > estimateSubAgentGroupLines(withReport, 80, false))
})

test('computeTranscriptWindow keeps a sub-agent group atomic', () => {
  const messages = [
    { id: 'u', kind: 'user', text: 'go' },
    agentMessage('a'),
    agentMessage('b')
  ]
  const window = computeTranscriptWindow({
    anchorIndex: 2,
    budgetLines: 4,
    messages,
    showDetails: false,
    width: 80
  })
  assert.deepEqual(
    window.messages.map((message) => message.id),
    ['a', 'b']
  )
  assert.equal(window.heights[0] > 0, true)
  assert.equal(window.heights[1], 0)
})

test('subAgentGroupStartIndex walks back through consecutive Task rows', () => {
  const messages = [agentMessage('a'), agentMessage('b'), { id: 'r', kind: 'tool', title: 'Read', status: 'running' }]
  assert.equal(subAgentGroupStartIndex(messages, 1), 0)
  assert.equal(subAgentGroupStartIndex(messages, 2), 2)
})

test('estimateMessageLines for a sub-agent row includes the group header', () => {
  const lines = estimateMessageLines(agentMessage('a'), 80, false)
  assert.ok(lines >= 3)
})
