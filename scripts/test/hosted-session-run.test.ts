import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveHostedTriggerMessageId,
  shouldUseHostedSessionRun
} from '../../src/renderer/src/lib/agent/hosted-session-run.ts'

const ready = {
  isPlanMode: false,
  isImageModel: false,
  triggerMessageId: 'user-1',
  providerId: 'prov-1',
  modelId: 'model-1'
}

test('hosted session run is used for a normal tool-capable user turn', () => {
  assert.equal(shouldUseHostedSessionRun(ready), true)
})

test('hosted session run is used for a quoted user turn when the trigger id is present', () => {
  assert.equal(shouldUseHostedSessionRun({ ...ready, source: 'quoted' }), true)
})

test('hosted session run stays off for continue, plan mode, image models, and missing ids', () => {
  assert.equal(shouldUseHostedSessionRun({ ...ready, source: 'continue' }), false)
  assert.equal(shouldUseHostedSessionRun({ ...ready, isPlanMode: true }), false)
  assert.equal(shouldUseHostedSessionRun({ ...ready, isImageModel: true }), false)
  assert.equal(shouldUseHostedSessionRun({ ...ready, triggerMessageId: '' }), false)
  assert.equal(shouldUseHostedSessionRun({ ...ready, providerId: '  ' }), false)
  assert.equal(shouldUseHostedSessionRun({ ...ready, modelId: '' }), false)
})

test('quoted turns resolve the pre-rendered user message as the hosted trigger', () => {
  assert.equal(
    resolveHostedTriggerMessageId(undefined, 'pre-rendered-1', 'pre-rendered-1'),
    'pre-rendered-1'
  )
  assert.equal(resolveHostedTriggerMessageId(null, null, 'quoted-user'), 'quoted-user')
  assert.equal(resolveHostedTriggerMessageId('appended-user', 'pre-rendered-1'), 'appended-user')
  assert.equal(resolveHostedTriggerMessageId('  ', '', null), '')
})
