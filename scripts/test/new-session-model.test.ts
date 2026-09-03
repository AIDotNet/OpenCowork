import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveNewSessionModel } from '../../src/renderer/src/lib/session-model-resolution.ts'

const GLOBAL = { activeProviderId: 'openai', activeModelId: 'gpt-global' }

test('a pick made before the session exists beats the project binding', () => {
  const resolved = resolveNewSessionModel({
    pendingSelection: { providerId: 'anthropic', modelId: 'claude-picked' },
    project: { providerId: 'openai', modelId: 'gpt-project' },
    ...GLOBAL
  })
  assert.equal(resolved.source, 'pending')
  assert.equal(resolved.providerId, 'anthropic')
  assert.equal(resolved.modelId, 'claude-picked')
})

test('a pick made before the session exists beats the fixed new-session default', () => {
  const resolved = resolveNewSessionModel({
    pendingSelection: { providerId: 'anthropic', modelId: 'claude-picked' },
    newSessionDefaultModel: {
      useGlobalActiveModel: false,
      providerId: 'openai',
      modelId: 'gpt-fixed'
    },
    ...GLOBAL
  })
  assert.equal(resolved.source, 'pending')
  assert.equal(resolved.modelId, 'claude-picked')
})

test('without a pick the project binding still wins over the fixed default', () => {
  const resolved = resolveNewSessionModel({
    project: { providerId: 'anthropic', modelId: 'claude-project' },
    newSessionDefaultModel: {
      useGlobalActiveModel: false,
      providerId: 'openai',
      modelId: 'gpt-fixed'
    },
    ...GLOBAL
  })
  assert.equal(resolved.source, 'project')
  assert.equal(resolved.modelId, 'claude-project')
})

test('the fixed default applies only when it opts out of the global active model', () => {
  const binding = { providerId: 'openai', modelId: 'gpt-fixed' }

  assert.equal(
    resolveNewSessionModel({
      newSessionDefaultModel: { useGlobalActiveModel: false, ...binding },
      ...GLOBAL
    }).source,
    'fixed-default'
  )
  assert.equal(
    resolveNewSessionModel({
      newSessionDefaultModel: { useGlobalActiveModel: true, ...binding },
      ...GLOBAL
    }).source,
    'global'
  )
})

test('half-filled bindings fall through instead of producing an unusable selection', () => {
  const resolved = resolveNewSessionModel({
    pendingSelection: { providerId: 'anthropic', modelId: '' },
    project: { providerId: '', modelId: 'claude-project' },
    ...GLOBAL
  })
  assert.equal(resolved.source, 'global')
  assert.equal(resolved.providerId, 'openai')
  assert.equal(resolved.modelId, 'gpt-global')
})

test('an empty global selection resolves to undefined rather than an empty id', () => {
  const resolved = resolveNewSessionModel({ activeProviderId: null, activeModelId: '' })
  assert.equal(resolved.source, 'global')
  assert.equal(resolved.providerId, undefined)
  assert.equal(resolved.modelId, undefined)
})
