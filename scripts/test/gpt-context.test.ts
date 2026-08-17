import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GPT_LONG_CONTEXT_LENGTH,
  GPT_STANDARD_CONTEXT_LENGTH,
  applyGptLongContextDefaults,
  modelSupportsGptLongContext,
  resolveEffectiveModelContextLength
} from '../../src/shared/gpt-context.ts'

test('GPT flagship models default to the 272K short-context tier', () => {
  for (const id of ['gpt-5.4', 'gpt-5.5', 'gpt-5.6-sol', 'openai/gpt-5.4', 'gpt-4.1']) {
    assert.equal(modelSupportsGptLongContext({ id }), true)
    assert.equal(resolveEffectiveModelContextLength({ id, contextLength: 1_050_000 }), 272_000)
  }
})

test('enabling 1M context uses the long-context window', () => {
  assert.equal(
    resolveEffectiveModelContextLength({
      id: 'gpt-5.5',
      contextLength: 1_050_000,
      enableLongContext: true
    }),
    1_050_000
  )
  assert.equal(
    resolveEffectiveModelContextLength({
      id: 'gpt-5.4-mini',
      contextLength: 400_000,
      enableLongContext: true
    }),
    GPT_LONG_CONTEXT_LENGTH
  )
})

test('small-window GPT models keep their native limit', () => {
  for (const id of ['gpt-4o', 'gpt-5-chat', 'gpt-5.3-codex-spark']) {
    assert.equal(modelSupportsGptLongContext({ id }), false)
    assert.equal(resolveEffectiveModelContextLength({ id, contextLength: 128_000 }), 128_000)
  }
})

test('applyGptLongContextDefaults stores 272K plus a 1M long window', () => {
  const next = applyGptLongContextDefaults({
    id: 'gpt-5.4',
    contextLength: 1_050_000
  })
  assert.equal(next.contextLength, GPT_STANDARD_CONTEXT_LENGTH)
  assert.equal(next.longContextLength, 1_050_000)
  assert.equal(next.supportsLongContext, true)
  assert.equal(next.enableLongContext, false)
})

test('persisted 1M GPT models still default to 272K until the toggle is on', () => {
  const persisted = { id: 'gpt-5.5', contextLength: 1_050_000 }
  assert.equal(resolveEffectiveModelContextLength(persisted), GPT_STANDARD_CONTEXT_LENGTH)
  assert.equal(
    resolveEffectiveModelContextLength({ ...persisted, enableLongContext: true }),
    1_050_000
  )
})
