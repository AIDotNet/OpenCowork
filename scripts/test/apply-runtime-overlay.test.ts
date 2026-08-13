import assert from 'node:assert/strict'
import test from 'node:test'
import { applyRuntimeOverlayToMessages } from '../../src/renderer/src/lib/chat/apply-runtime-overlay.ts'
import { createEmptyProjection } from '../../src/shared/runtime-projection/reducer.ts'
import type { AgentRuntimeProjection } from '../../src/shared/runtime-contracts/generated/contracts.ts'
import type { UnifiedMessage } from '../../src/renderer/src/lib/api/types.ts'

function projection(partial: Partial<AgentRuntimeProjection>): AgentRuntimeProjection {
  return {
    ...createEmptyProjection('epoch-a', 'worker-a'),
    projectionRevision: 4,
    ...partial
  }
}

function assistant(id: string, text: string): UnifiedMessage {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text }],
    createdAt: 1
  }
}

test('merges overlay text thinking and tools onto the streaming assistant', () => {
  const messages = [assistant('asst-live', 'Hel')]
  const view = applyRuntimeOverlayToMessages(
    messages,
    projection({
      runs: [
        {
          runId: 'run-1',
          sessionId: 'session-1',
          status: 'running',
          assistantMessageId: 'asst:run-1',
          lastSeq: 3
        }
      ],
      messages: [
        {
          messageId: 'asst:run-1',
          runId: 'run-1',
          sessionId: 'session-1',
          role: 'assistant',
          text: 'Hello',
          thinking: 'plan'
        }
      ],
      toolCalls: [
        {
          toolCallId: 'tool-1',
          runId: 'run-1',
          sessionId: 'session-1',
          toolName: 'Read',
          status: 'completed',
          input: { path: 'a.ts' },
          output: 'file contents'
        }
      ]
    }),
    'asst-live',
    'session-1'
  )

  assert.equal(view.isActive, true)
  assert.equal(view.streamingMessageId, 'asst-live')
  assert.equal(view.targetMessageId, 'asst-live')
  assert.equal(view.messages.length, 1)
  assert.equal(view.messages[0]?.id, 'asst-live')
  assert.deepEqual(view.messages[0]?.content, [
    { type: 'thinking', thinking: 'plan' },
    { type: 'text', text: 'Hello' },
    { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'a.ts' } }
  ])
  assert.equal(view.liveToolCallMap?.get('tool-1')?.output, 'file contents')
  assert.equal(view.liveToolCallMap?.get('tool-1')?.status, 'completed')
  assert.equal(view.messages[0]?._revision, 4)
})

test('injects a virtual assistant only when chat-store has no streaming message', () => {
  const view = applyRuntimeOverlayToMessages(
    [],
    projection({
      runs: [
        {
          runId: 'run-1',
          sessionId: 'session-1',
          status: 'running',
          assistantMessageId: 'asst:run-1',
          lastSeq: 1
        }
      ],
      messages: [
        {
          messageId: 'asst:run-1',
          runId: 'run-1',
          sessionId: 'session-1',
          role: 'assistant',
          text: 'Hi',
          thinking: null
        }
      ]
    }),
    null,
    'session-1'
  )

  assert.equal(view.messages.length, 1)
  assert.equal(view.messages[0]?.id, 'asst:run-1')
  assert.equal(view.streamingMessageId, 'asst:run-1')
})

test('does not inject a second assistant when the streaming id is off-screen', () => {
  const view = applyRuntimeOverlayToMessages(
    [assistant('older', 'history')],
    projection({
      runs: [
        {
          runId: 'run-1',
          sessionId: 'session-1',
          status: 'running',
          assistantMessageId: 'asst:run-1',
          lastSeq: 1
        }
      ],
      messages: [
        {
          messageId: 'asst:run-1',
          runId: 'run-1',
          sessionId: 'session-1',
          role: 'assistant',
          text: 'Hi',
          thinking: null
        }
      ]
    }),
    'asst-live',
    'session-1'
  )

  assert.equal(view.messages.length, 1)
  assert.equal(view.messages[0]?.id, 'older')
  assert.equal(view.streamingMessageId, 'asst-live')
})

test('keeps longer chat-store text while overlay is still catching up', () => {
  const view = applyRuntimeOverlayToMessages(
    [assistant('asst-live', 'Hello world')],
    projection({
      runs: [
        {
          runId: 'run-1',
          sessionId: 'session-1',
          status: 'running',
          assistantMessageId: 'asst:run-1',
          lastSeq: 1
        }
      ],
      messages: [
        {
          messageId: 'asst:run-1',
          runId: 'run-1',
          sessionId: 'session-1',
          role: 'assistant',
          text: 'Hello',
          thinking: null
        }
      ]
    }),
    'asst-live',
    'session-1'
  )

  assert.deepEqual(view.messages[0]?.content, [{ type: 'text', text: 'Hello world' }])
})

test('keeps a later thinking block after tools instead of rewriting the first think', () => {
  const messages: UnifiedMessage[] = [
    {
      id: 'asst-live',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'plan A', startedAt: 10, completedAt: 20 },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'a.ts' } },
        { type: 'tool_use', id: 'tool-2', name: 'Grep', input: { pattern: 'x' } },
        { type: 'thinking', thinking: 'plan B', startedAt: 30 }
      ],
      createdAt: 1
    }
  ]
  const view = applyRuntimeOverlayToMessages(
    messages,
    projection({
      runs: [
        {
          runId: 'run-1',
          sessionId: 'session-1',
          status: 'running',
          assistantMessageId: 'asst:run-1',
          lastSeq: 8
        }
      ],
      messages: [
        {
          messageId: 'asst:run-1',
          runId: 'run-1',
          sessionId: 'session-1',
          role: 'assistant',
          text: '',
          thinking: 'plan Aplan B more'
        }
      ],
      toolCalls: [
        {
          toolCallId: 'tool-1',
          runId: 'run-1',
          sessionId: 'session-1',
          toolName: 'Read',
          status: 'completed',
          input: { path: 'a.ts' },
          output: 'file contents'
        },
        {
          toolCallId: 'tool-2',
          runId: 'run-1',
          sessionId: 'session-1',
          toolName: 'Grep',
          status: 'streaming',
          input: { pattern: 'x' },
          output: null
        }
      ]
    }),
    'asst-live',
    'session-1'
  )

  assert.deepEqual(view.messages[0]?.content, [
    { type: 'thinking', thinking: 'plan A', startedAt: 10, completedAt: 20 },
    { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'a.ts' } },
    { type: 'tool_use', id: 'tool-2', name: 'Grep', input: { pattern: 'x' } },
    { type: 'thinking', thinking: 'plan B more', startedAt: 30 }
  ])
})

test('starts a new thinking block when overlay thinking continues after tools', () => {
  const messages: UnifiedMessage[] = [
    {
      id: 'asst-live',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'plan A', startedAt: 10 },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'a.ts' } }
      ],
      createdAt: 1
    }
  ]
  const view = applyRuntimeOverlayToMessages(
    messages,
    projection({
      runs: [
        {
          runId: 'run-1',
          sessionId: 'session-1',
          status: 'running',
          assistantMessageId: 'asst:run-1',
          lastSeq: 4
        }
      ],
      messages: [
        {
          messageId: 'asst:run-1',
          runId: 'run-1',
          sessionId: 'session-1',
          role: 'assistant',
          text: '',
          thinking: 'plan Aplan B'
        }
      ],
      toolCalls: [
        {
          toolCallId: 'tool-1',
          runId: 'run-1',
          sessionId: 'session-1',
          toolName: 'Read',
          status: 'running',
          input: { path: 'a.ts' },
          output: null
        }
      ]
    }),
    'asst-live',
    'session-1'
  )

  assert.deepEqual(view.messages[0]?.content, [
    { type: 'thinking', thinking: 'plan A', startedAt: 10, completedAt: 10 },
    { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'a.ts' } },
    { type: 'thinking', thinking: 'plan B' }
  ])
})

test('seals an open think after text when overlay already has the next tools', () => {
  const messages: UnifiedMessage[] = [
    {
      id: 'asst-live',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'plan A', startedAt: 10, completedAt: 20 },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'a.ts' } },
        { type: 'text', text: 'I will explore the frontend.' },
        { type: 'thinking', thinking: 'plan B', startedAt: 30 }
      ],
      createdAt: 1
    }
  ]
  const view = applyRuntimeOverlayToMessages(
    messages,
    projection({
      runs: [
        {
          runId: 'run-1',
          sessionId: 'session-1',
          status: 'running',
          assistantMessageId: 'asst:run-1',
          lastSeq: 9
        }
      ],
      messages: [
        {
          messageId: 'asst:run-1',
          runId: 'run-1',
          sessionId: 'session-1',
          role: 'assistant',
          text: 'I will explore the frontend.',
          thinking: 'plan Aplan B more'
        }
      ],
      toolCalls: [
        {
          toolCallId: 'tool-1',
          runId: 'run-1',
          sessionId: 'session-1',
          toolName: 'Read',
          status: 'completed',
          input: { path: 'a.ts' },
          output: 'ok'
        },
        {
          toolCallId: 'tool-2',
          runId: 'run-1',
          sessionId: 'session-1',
          toolName: 'Grep',
          status: 'completed',
          input: { pattern: 'x' },
          output: 'ok'
        }
      ]
    }),
    'asst-live',
    'session-1'
  )

  assert.deepEqual(view.messages[0]?.content, [
    { type: 'thinking', thinking: 'plan A', startedAt: 10, completedAt: 20 },
    { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'a.ts' } },
    { type: 'text', text: 'I will explore the frontend.' },
    { type: 'thinking', thinking: 'plan B', startedAt: 30, completedAt: 30 },
    { type: 'tool_use', id: 'tool-2', name: 'Grep', input: { pattern: 'x' } },
    { type: 'thinking', thinking: ' more' }
  ])
})
