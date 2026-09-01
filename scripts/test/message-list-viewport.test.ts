import assert from 'node:assert/strict'
import test from 'node:test'
import {
  VIEWPORT,
  canChaseTail,
  resolveTurnSpacer,
  shouldFinishPositioning
} from '../../src/renderer/src/components/chat/message-list-viewport.ts'

test('positioning finishes once the tail is stable', () => {
  assert.equal(
    shouldFinishPositioning({
      stable: true,
      frameCount: 2,
      startedAt: 0,
      now: 32
    }),
    true
  )
})

test('positioning finishes at the frame limit even if height is still moving', () => {
  assert.equal(
    shouldFinishPositioning({
      stable: false,
      frameCount: VIEWPORT.positionFrameLimit,
      startedAt: 0,
      now: 100
    }),
    true
  )
})

test('positioning finishes at the time limit even if height is still moving', () => {
  assert.equal(
    shouldFinishPositioning({
      stable: false,
      frameCount: 10,
      startedAt: 0,
      now: VIEWPORT.positionTimeLimitMs
    }),
    true
  )
})

test('positioning keeps waiting before both limits when the tail is not stable', () => {
  assert.equal(
    shouldFinishPositioning({
      stable: false,
      frameCount: 10,
      startedAt: 0,
      now: 200
    }),
    false
  )
})

test('turn spacer keeps the previous value when the last user row is not mounted', () => {
  assert.equal(
    resolveTurnSpacer({
      clientHeight: 800,
      measuredTurnHeight: null,
      estimatedTurnHeight: 180,
      previousSpacer: 240
    }),
    240
  )
})

test('turn spacer uses the estimate only on the first following paint', () => {
  assert.equal(
    resolveTurnSpacer({
      clientHeight: 800,
      measuredTurnHeight: null,
      estimatedTurnHeight: 200,
      previousSpacer: 0
    }),
    600
  )
})

test('turn spacer pads a short last turn to the viewport', () => {
  assert.equal(
    resolveTurnSpacer({
      clientHeight: 800,
      measuredTurnHeight: 220,
      estimatedTurnHeight: 180,
      previousSpacer: 0
    }),
    580
  )
})

test('turn spacer collapses to the minimum when the last turn fills the viewport', () => {
  assert.equal(
    resolveTurnSpacer({
      clientHeight: 800,
      measuredTurnHeight: 1200,
      estimatedTurnHeight: 180,
      previousSpacer: 240
    }),
    VIEWPORT.turnSpacerMinHeight
  )
})

test('following an idle transcript does not keep chasing the tail', () => {
  assert.equal(
    canChaseTail({
      mode: 'following',
      restoring: false,
      isSessionOutputting: false,
      canStreamFollow: false,
      now: 2_000,
      chaseUntil: 1_000
    }),
    false
  )
})

test('following settles for a short window after the stream ends', () => {
  assert.equal(
    canChaseTail({
      mode: 'following',
      restoring: false,
      isSessionOutputting: false,
      canStreamFollow: false,
      now: 1_500,
      chaseUntil: 2_000
    }),
    true
  )
})

test('following a live stream chases only when this view may follow it', () => {
  assert.equal(
    canChaseTail({
      mode: 'following',
      restoring: false,
      isSessionOutputting: true,
      canStreamFollow: true,
      now: 0,
      chaseUntil: 0
    }),
    true
  )
  assert.equal(
    canChaseTail({
      mode: 'following',
      restoring: false,
      isSessionOutputting: true,
      canStreamFollow: false,
      now: 0,
      chaseUntil: Number.POSITIVE_INFINITY
    }),
    false
  )
})

test('browsing never chases the tail', () => {
  assert.equal(
    canChaseTail({
      mode: 'browsing',
      restoring: false,
      isSessionOutputting: true,
      canStreamFollow: true,
      now: 0,
      chaseUntil: Number.POSITIVE_INFINITY
    }),
    false
  )
})

test('turn spacer ignores two-pixel measurement jitter', () => {
  assert.equal(
    resolveTurnSpacer({
      clientHeight: 800,
      measuredTurnHeight: 222,
      estimatedTurnHeight: 180,
      previousSpacer: 580
    }),
    580
  )
})
