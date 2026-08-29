import assert from 'node:assert/strict'
import test from 'node:test'
import {
  insertOrphanToolUseBlocks,
  listOrphanToolResultIds,
  parseFunctionCallsFromRequestDebugBody,
  resolveOrphanToolUses
} from '../../src/renderer/src/lib/chat/recover-missing-tool-uses.ts'
import type { ContentBlock } from '../../src/renderer/src/lib/api/types.ts'
import type { ToolCallState } from '../../src/renderer/src/lib/agent/types.ts'

test('lists tool_result ids that have no matching tool_use block', () => {
  const blocks: ContentBlock[] = [
    { type: 'thinking', thinking: 'look around' },
    { type: 'tool_use', id: 'kept', name: 'Grep', input: {} },
    { type: 'text', text: 'done' }
  ]
  const results = new Map([
    ['kept', { content: 'ok' }],
    ['missing-read', { content: 'file' }]
  ])
  assert.deepEqual(listOrphanToolResultIds(blocks, results), ['missing-read'])
})

test('resolves orphan reads from live tool calls and request debug', () => {
  const toolCalls: ToolCallState[] = [
    {
      id: 'read-1',
      name: 'Read',
      input: { file_path: 'a.ts' },
      status: 'completed',
      requiresApproval: false
    }
  ]
  const debug = parseFunctionCallsFromRequestDebugBody(
    JSON.stringify({
      input: [
        {
          type: 'function_call',
          call_id: 'read-2',
          name: 'Read',
          arguments: '{"file_path":"b.ts"}'
        }
      ]
    })
  )

  const resolved = resolveOrphanToolUses({
    orphanIds: ['read-1', 'read-2', 'unknown'],
    toolCalls,
    debugToolUses: debug
  })

  assert.equal(resolved.length, 2)
  assert.equal(resolved[0].id, 'read-1')
  assert.equal((resolved[0].input as { file_path?: string }).file_path, 'a.ts')
  assert.equal(resolved[1].id, 'read-2')
  assert.equal((resolved[1].input as { file_path?: string }).file_path, 'b.ts')
})

test('inserts recovered tool_use blocks before the trailing answer', () => {
  const blocks: ContentBlock[] = [
    { type: 'thinking', thinking: 'reason' },
    { type: 'text', text: 'answer' }
  ]
  const next = insertOrphanToolUseBlocks(blocks, [
    { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'a.ts' } }
  ])
  assert.deepEqual(
    next.map((block) => block.type),
    ['thinking', 'tool_use', 'text']
  )
})
