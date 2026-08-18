import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACP_MODE_ALLOWED_TOOLS,
  splitToolsForSubAgentCatalog
} from '../../src/shared/session-mode-tools.ts'

test('ACP lead tools exclude Write Edit and Bash', () => {
  assert.equal(ACP_MODE_ALLOWED_TOOLS.has('Task'), true)
  assert.equal(ACP_MODE_ALLOWED_TOOLS.has('Read'), true)
  assert.equal(ACP_MODE_ALLOWED_TOOLS.has('Skill'), true)
  assert.equal(ACP_MODE_ALLOWED_TOOLS.has('MemoryRead'), true)
  assert.equal(ACP_MODE_ALLOWED_TOOLS.has('codegraph_explore'), true)
  assert.equal(ACP_MODE_ALLOWED_TOOLS.has('WebSearch'), true)
  assert.equal(ACP_MODE_ALLOWED_TOOLS.has('WebFetch'), true)
  assert.equal(ACP_MODE_ALLOWED_TOOLS.has('TeamCreate'), true)
  assert.equal(ACP_MODE_ALLOWED_TOOLS.has('SendMessage'), true)
  assert.equal(ACP_MODE_ALLOWED_TOOLS.has('CronList'), true)
  assert.equal(ACP_MODE_ALLOWED_TOOLS.has('Notify'), true)
  assert.equal(ACP_MODE_ALLOWED_TOOLS.has('Write'), false)
  assert.equal(ACP_MODE_ALLOWED_TOOLS.has('Edit'), false)
  assert.equal(ACP_MODE_ALLOWED_TOOLS.has('Bash'), false)
  assert.equal(ACP_MODE_ALLOWED_TOOLS.has('CronAdd'), false)
})

test('ACP splits parent orchestration tools from the sub-agent catalog', () => {
  const availableTools = [
    { name: 'Read' },
    { name: 'Write' },
    { name: 'Edit' },
    { name: 'Bash' },
    { name: 'Skill' },
    { name: 'MemorySearch' },
    { name: 'codegraph_explore' },
    { name: 'WebSearch' },
    { name: 'TeamCreate' },
    { name: 'CronAdd' },
    { name: 'Task' }
  ]
  const { parentTools, subAgentToolCatalog } = splitToolsForSubAgentCatalog({
    mode: 'acp',
    availableTools
  })
  assert.deepEqual(
    parentTools.map((tool) => tool.name),
    ['Read', 'Skill', 'MemorySearch', 'codegraph_explore', 'WebSearch', 'TeamCreate', 'Task']
  )
  assert.deepEqual(
    subAgentToolCatalog.map((tool) => tool.name),
    availableTools.map((tool) => tool.name)
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
