import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseSystemCommandTag,
  serializeSystemCommandTag,
  stripSystemCommandTag
} from '../../src/renderer/src/lib/commands/system-command.ts'

test('serializeSystemCommandTag round-trips through parseSystemCommandTag', () => {
  const command = {
    name: 'init',
    content: 'Generate a file named AGENTS.md that serves as a contributor guide.'
  }

  const persisted = serializeSystemCommandTag(command)
  const parsed = parseSystemCommandTag(persisted)

  assert.ok(parsed)
  assert.equal(parsed.command.name, 'init')
  assert.equal(parsed.command.content, command.content)
  assert.equal(parsed.remainingText, '')
  assert.equal(stripSystemCommandTag(persisted), '')
})

test('serializeSystemCommandTag keeps user arguments outside the command card', () => {
  const persisted = serializeSystemCommandTag(
    { name: 'init', content: 'Write AGENTS.md' },
    'focus on the CLI'
  )
  const parsed = parseSystemCommandTag(persisted)

  assert.ok(parsed)
  assert.equal(parsed.command.name, 'init')
  assert.equal(parsed.command.content, 'Write AGENTS.md')
  assert.equal(parsed.remainingText, 'focus on the CLI')
})
