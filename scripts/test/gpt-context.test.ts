import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GPT_LONG_CONTEXT_LENGTH,
  GPT_STANDARD_CONTEXT_LENGTH,
  applyGptLongContextDefaults,
  modelSupportsGptLongContext,
  resolveEffectiveModelContextLength
} from '../../src/shared/gpt-context.ts'

test('GPT flagship models default to the 360K short-context window', () => {
  for (const id of ['gpt-5.4', 'gpt-5.5', 'gpt-5.6-sol', 'openai/gpt-5.4', 'gpt-4.1']) {
    assert.equal(modelSupportsGptLongContext({ id }), true)
    assert.equal(resolveEffectiveModelContextLength({ id, contextLength: 1_050_000 }), 360_000)
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

test('applyGptLongContextDefaults stores 360K plus a 1M long window', () => {
  const next = applyGptLongContextDefaults({
    id: 'gpt-5.4',
    contextLength: 1_050_000
  })
  assert.equal(next.contextLength, GPT_STANDARD_CONTEXT_LENGTH)
  assert.equal(next.longContextLength, 1_050_000)
  assert.equal(next.supportsLongContext, true)
  assert.equal(next.enableLongContext, false)
})

test('persisted 1M GPT models still default to 360K until the toggle is on', () => {
  const persisted = { id: 'gpt-5.5', contextLength: 1_050_000 }
  assert.equal(resolveEffectiveModelContextLength(persisted), GPT_STANDARD_CONTEXT_LENGTH)
  assert.equal(
    resolveEffectiveModelContextLength({ ...persisted, enableLongContext: true }),
    1_050_000
  )
})

test('non-GPT 1M models default to 360K and keep their native long window', () => {
  const models = [
    { id: 'gemini-3-pro-preview', contextLength: 1_048_576 },
    { id: 'claude-sonnet-4-6', contextLength: 1_000_000 },
    { id: 'qwen3.5-plus', contextLength: 1_000_000 }
  ]
  for (const model of models) {
    assert.equal(modelSupportsGptLongContext(model), true)
    assert.equal(resolveEffectiveModelContextLength(model), GPT_STANDARD_CONTEXT_LENGTH)
    assert.equal(
      resolveEffectiveModelContextLength({ ...model, enableLongContext: true }),
      model.contextLength
    )
    const next = applyGptLongContextDefaults(model)
    assert.equal(next.contextLength, GPT_STANDARD_CONTEXT_LENGTH)
    assert.equal(next.longContextLength, model.contextLength)
    assert.equal(next.enableLongContext, false)
  }
})

test('2M models default to 360K and restore the native window when enabled', () => {
  const model = { id: 'openrouter/gemini-2m', contextLength: 2_000_000 }
  assert.equal(modelSupportsGptLongContext(model), true)
  assert.equal(resolveEffectiveModelContextLength(model), GPT_STANDARD_CONTEXT_LENGTH)
  assert.equal(
    resolveEffectiveModelContextLength({ ...model, enableLongContext: true }),
    2_000_000
  )
})

test('non-GPT 1M windows are not raised to the GPT 1.048M fallback', () => {
  assert.equal(
    resolveEffectiveModelContextLength({
      id: 'qwen3.5-plus',
      contextLength: 1_000_000,
      enableLongContext: true
    }),
    1_000_000
  )
})
