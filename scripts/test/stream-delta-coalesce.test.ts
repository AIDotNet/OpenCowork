import assert from 'node:assert/strict'
import test from 'node:test'
import {
  coalesceStreamAppend,
  collapseFanoutRepeatedChunks
} from '../../src/shared/stream-delta-coalesce.ts'

test('appends incremental tokens', () => {
  assert.equal(coalesceStreamAppend('', '任'), '任')
  assert.equal(coalesceStreamAppend('任', '务'), '任务')
  assert.equal(coalesceStreamAppend('任务', '状态'), '任务状态')
})

test('replaces a snapshot that already contains the accumulated text', () => {
  assert.equal(coalesceStreamAppend('任务', '任务状态'), '任务状态')
  assert.equal(
    coalesceStreamAppend(
      'Running dotnet tests and inspecting build status',
      'Running dotnet tests and inspecting build status'
    ),
    'Running dotnet tests and inspecting build status'
  )
})

test('drops an exact replay of the current text', () => {
  assert.equal(coalesceStreamAppend('任务状态', '任务状态'), '任务状态')
})

test('collapses a fan-out that delivered the same chunk three times', () => {
  const chunks = collapseFanoutRepeatedChunks(
    ['任务', '任务', '任务', '状态', '状态', '状态'],
    (chunk) => chunk
  )
  assert.deepEqual(chunks, ['任务', '状态'])
})

test('keeps a legitimate double token', () => {
  const chunks = collapseFanoutRepeatedChunks(['的', '的', '人'], (chunk) => chunk)
  assert.deepEqual(chunks, ['的', '的', '人'])
})
