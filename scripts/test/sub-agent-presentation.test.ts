import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveSubAgentPresentation } from '../../src/renderer/src/lib/agent/sub-agents/presentation.ts'

test('live tracked running wins over a missing tool result', () => {
  const presentation = resolveSubAgentPresentation({
    tracked: { isRunning: true, success: null, errorMessage: null },
    hasToolResult: false
  })
  assert.equal(presentation.phase, 'running')
  assert.equal(presentation.isRunning, true)
})

test('live tracked completion wins even while the parent turn is still live', () => {
  const presentation = resolveSubAgentPresentation({
    tracked: { isRunning: false, success: true, errorMessage: null },
    hasToolResult: true,
    isLive: true
  })
  assert.equal(presentation.phase, 'completed')
  assert.equal(presentation.isRunning, false)
})

test('untracked in-flight Task is running, not completed', () => {
  const presentation = resolveSubAgentPresentation({
    tracked: null,
    hasToolResult: false,
    isLive: true
  })
  assert.equal(presentation.phase, 'running')
  assert.equal(presentation.isRunning, true)
})

test('untracked Task without a result stays running after the parent message stops streaming', () => {
  const presentation = resolveSubAgentPresentation({
    tracked: null,
    hasToolResult: false,
    isLive: false
  })
  assert.equal(presentation.phase, 'running')
})

test('untracked Task with a result is completed', () => {
  const presentation = resolveSubAgentPresentation({
    tracked: null,
    hasToolResult: true
  })
  assert.equal(presentation.phase, 'completed')
  assert.equal(presentation.isRunning, false)
})

test('overlay live tool status can mark an untracked Task as running', () => {
  const presentation = resolveSubAgentPresentation({
    tracked: null,
    hasToolResult: false,
    liveToolStatus: 'running'
  })
  assert.equal(presentation.phase, 'running')
})
