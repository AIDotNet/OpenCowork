import assert from 'node:assert/strict'
import test from 'node:test'
import { cliReducer } from '../dist/state/cli-reducer.js'
import { createInitialCliState, isPlanOverlayVisible } from '../dist/state/cli-state.js'

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function plan(patch = {}) {
  return {
    id: 'plan-1',
    sessionId: 'session-1',
    title: 'Implement the feature',
    status: 'drafting',
    content: '# Implement the feature\n\n1. Update the CLI state projection.',
    createdAt: 1,
    updatedAt: 2,
    ...patch
  }
}

test('ExitPlanMode keeps the complete plan visible for review after the turn ends', () => {
  const state = createInitialCliState()
  const afterExit = cliReducer(state, {
    type: 'runtime',
    event: { type: 'plan.update', action: 'exit', plan: plan({ status: 'drafting' }) }
  })

  assert.equal(afterExit.plan?.status, 'awaiting_review')
  assert.equal(
    afterExit.plan?.content,
    '# Implement the feature\n\n1. Update the CLI state projection.'
  )
  assert.equal(isPlanOverlayVisible(afterExit.plan), true)

  const afterTurn = cliReducer(afterExit, {
    type: 'runtime',
    event: { type: 'turn.done' }
  })

  assert.equal(afterTurn.plan?.status, 'awaiting_review')
  assert.equal(afterTurn.plan?.content, afterExit.plan?.content)
  assert.equal(isPlanOverlayVisible(afterTurn.plan), true)
})

test('plan updates without content retain the existing markdown preview', () => {
  const drafted = cliReducer(createInitialCliState(), {
    type: 'runtime',
    event: { type: 'plan.update', action: 'exit', plan: plan() }
  })
  const synced = cliReducer(drafted, {
    type: 'runtime',
    event: {
      type: 'plan.update',
      action: 'sync',
      plan: plan({ status: 'awaiting_review', content: undefined, updatedAt: 3 })
    }
  })

  assert.equal(synced.plan?.status, 'awaiting_review')
  assert.equal(synced.plan?.content, drafted.plan?.content)
  assert.equal(isPlanOverlayVisible(synced.plan), true)
})
