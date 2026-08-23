import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mergeLiveToolCallMaps,
  resolveLiveToolCallStatus
} from '../../src/renderer/src/lib/chat/live-tool-call-status.ts'
import type { ToolCallState } from '../../src/renderer/src/lib/agent/types.ts'

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
