import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACP_MODE_ALLOWED_TOOLS,
  splitToolsForSubAgentCatalog
} from '../../src/shared/session-mode-tools.ts'

test('ACP lead tools exclude Write Edit and Bash', () => {
  assert.equal(ACP_MODE_ALLOWED_TOOLS.has('Task'), true)
  assert.equal(ACP_MODE_ALLOWED_TOOLS.has('Read'), true)
  assert.equal(ACP_MODE_ALLOWED_TOOLS.has('Write'), false)
  assert.equal(ACP_MODE_ALLOWED_TOOLS.has('Edit'), false)
  assert.equal(ACP_MODE_ALLOWED_TOOLS.has('Bash'), false)
})

test('ACP splits parent orchestration tools from the sub-agent catalog', () => {
  const availableTools = [
    { name: 'Read' },
    { name: 'Write' },
    { name: 'Edit' },
    { name: 'Bash' },
    { name: 'Task' }
  ]
  const { parentTools, subAgentToolCatalog } = splitToolsForSubAgentCatalog({
    mode: 'acp',
    availableTools
  })
  assert.deepEqual(
    parentTools.map((tool) => tool.name),
    ['Read', 'Task']
  )
  assert.deepEqual(
    subAgentToolCatalog.map((tool) => tool.name),
    ['Read', 'Write', 'Edit', 'Bash', 'Task']
  )
})

test('non-ACP modes keep parent tools and catalog aligned', () => {
  const availableTools = [{ name: 'Read' }, { name: 'Write' }]
  const { parentTools, subAgentToolCatalog } = splitToolsForSubAgentCatalog({
    mode: 'code',
    availableTools
  })
  assert.deepEqual(parentTools, availableTools)
  assert.deepEqual(subAgentToolCatalog, availableTools)
})
