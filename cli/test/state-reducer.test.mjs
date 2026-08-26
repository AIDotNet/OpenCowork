import assert from 'node:assert/strict'
import test from 'node:test'
import { cliReducer, reduceCliState } from '../dist/state/cli-reducer.js'
import { createInitialCliState, resolveActiveOverlay } from '../dist/state/cli-state.js'

function assistantStart(id = 'assistant-1') {
  return { type: 'assistant.start', id, model: 'test-model' }
}

function permission(id) {
  return { id, tool: 'Bash', title: `Permission ${id}`, detail: 'Run a command' }
}

function askUser(id) {
  return {
    id,
    toolUseId: `tool-${id}`,
    questions: [
      {
        question: 'Which option?',
        header: 'Option',
        options: [{ label: 'One' }, { label: 'Two' }],
        multiSelect: false
      }
    ]
  }
}

function plan(id, status = 'drafting') {
  return {
    id,
    sessionId: 'session-1',
    title: 'Test plan',
    status,
    createdAt: 1,
    updatedAt: 1
  }
}

function overlayInputs(overrides = {}) {
  return {
    askUserRequest: null,
    agentPanelOpen: false,
    configCatalog: null,
    configOpen: false,
    effortConfiguration: null,
    modelConfiguration: null,
    modelPickerPurpose: null,
    permissionMode: 'manual',
    permissionRequest: null,
    plan: null,
    providerSetupCatalog: null,
    resumeOpen: false,
    ...overrides
  }
}

test('assistant text and thinking deltas preserve ordered segments', () => {
  let state = createInitialCliState()
  state = reduceCliState(state, assistantStart())
  state = reduceCliState(state, { type: 'assistant.thinking', id: 'assistant-1', thinking: 'think ' })
  state = reduceCliState(state, { type: 'assistant.delta', id: 'assistant-1', text: 'answer' })
  state = reduceCliState(state, { type: 'assistant.thinking', id: 'assistant-1', thinking: ' again' })

  const message = state.messages[0]
  assert.equal(message.kind, 'assistant')
  assert.equal(message.text, 'answer')
  assert.deepEqual(
    message.segments?.map((segment) => [segment.kind, segment.text]),
    [
      ['thinking', 'think '],
      ['text', 'answer'],
      ['thinking', ' again']
    ]
  )
})

test('assistant and tool updates for unknown IDs are safe no-ops', () => {
  const state = createInitialCliState()
  const next = reduceCliState(state, { type: 'assistant.delta', id: 'missing', text: 'ignored' })
  const toolNext = reduceCliState(next, {
    type: 'tool.update',
    id: 'missing',
    summary: 'ignored'
  })
  assert.deepEqual(toolNext, state)
})

test('tool start, update, and done merge into one row', () => {
  let state = createInitialCliState()
  state = reduceCliState(state, {
    type: 'tool.start',
    id: 'tool-1',
    title: 'Bash',
    detail: 'pwd'
  })
  state = reduceCliState(state, {
    type: 'tool.update',
    id: 'tool-1',
    detail: 'running',
    summary: 'working'
  })
  state = reduceCliState(state, {
    type: 'tool.done',
    id: 'tool-1',
    status: 'success',
    summary: 'done'
  })

  assert.deepEqual(state.messages, [
    {
      id: 'tool-1',
      kind: 'tool',
      title: 'Bash',
      detail: 'running',
      status: 'success',
      summary: 'done'
    }
  ])
})

test('permission and AskUser cancellation only clear the matching request', () => {
  let state = reduceCliState(createInitialCliState(), {
    type: 'permission.request',
    request: permission('new')
  })
  state = reduceCliState(state, { type: 'permission.cancel', requestId: 'old' })
  assert.equal(state.permissionRequest?.id, 'new')
  state = reduceCliState(state, { type: 'permission.cancel', requestId: 'new' })
  assert.equal(state.permissionRequest, null)

  state = reduceCliState(state, { type: 'askUser.request', request: askUser('new') })
  state = reduceCliState(state, { type: 'askUser.cancel', requestId: 'old' })
  assert.equal(state.askUserRequest?.id, 'new')
  state = reduceCliState(state, { type: 'askUser.cancel', requestId: 'new' })
  assert.equal(state.askUserRequest, null)
})

test('plan updates preserve existing content during a metadata-only sync', () => {
  let state = reduceCliState(createInitialCliState(), {
    type: 'plan.update',
    action: 'enter',
    plan: { ...plan('plan-1'), content: 'Detailed plan' }
  })
  state = reduceCliState(state, {
    type: 'plan.update',
    action: 'sync',
    plan: { ...plan('plan-1'), status: 'awaiting_review', content: undefined }
  })
  assert.equal(state.plan?.content, 'Detailed plan')
  assert.equal(state.plan?.status, 'awaiting_review')
})

test('turn.done clears transient turn status without changing transcript or overlays', () => {
  let state = createInitialCliState()
  state = cliReducer(state, {
    type: 'turn-status/replace',
    status: {
      activeResponseCharacters: 3,
      completedOutputTokens: 0,
      generationMs: 0,
      id: 'turn-1',
      phase: 'responding',
      requestTokens: 1,
      startedAt: 1,
      verb: 'Working'
    }
  })
  state = cliReducer(state, {
    type: 'permission/replace',
    request: permission('permission-1')
  })
  const next = reduceCliState(state, { type: 'turn.done' })
  assert.equal(next.turnStatus, null)
  assert.equal(next.permissionRequest?.id, 'permission-1')
})

test('duplicate system events collapse while retaining the Worker message ID', () => {
  const message = { id: 'worker-system-1', kind: 'system', text: 'Notice', tone: 'success' }
  let state = reduceCliState(createInitialCliState(), { type: 'system', message })
  state = reduceCliState(state, { type: 'system', message: { ...message, id: 'worker-system-2' } })
  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0].id, 'worker-system-1')
})

test('overlay priority and plan mode gate input', () => {
  const request = permission('permission-1')
  const question = askUser('ask-1')
  const draft = plan('plan-1')

  assert.equal(resolveActiveOverlay(overlayInputs({ permissionRequest: request }))?.type, 'permission')
  assert.equal(
    resolveActiveOverlay(
      overlayInputs({ permissionRequest: request, askUserRequest: question })
    )?.type,
    'askUser'
  )
  assert.equal(
    resolveActiveOverlay(overlayInputs({ plan: draft, permissionMode: 'plan' }))?.type,
    'plan'
  )
  assert.equal(resolveActiveOverlay(overlayInputs({ plan: draft })), null)
  assert.equal(
    resolveActiveOverlay(overlayInputs({ resumeOpen: true, agentPanelOpen: true }))?.type,
    'resume'
  )
})
