import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getWidgetRenderCode,
  mergeWidgetToolInput
} from '../../src/shared/live-tool-input-summary.ts'

test('mergeWidgetToolInput keeps a longer widget_code when the next snapshot is shorter', () => {
  const previous = {
    title: 'Architecture',
    widget_code: '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
  }
  const next = { title: 'Architecture', widget_code: '<svg' }

  const merged = mergeWidgetToolInput(previous, next)

  assert.equal(merged.widget_code, previous.widget_code)
  assert.equal(merged.title, 'Architecture')
})

test('mergeWidgetToolInput keeps previous code when the settled snapshot is truncated', () => {
  const previous = {
    title: 'Architecture',
    widget_code: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
  }
  const next = { _truncated: true, preview: '{"title":"Architecture"' }

  const merged = mergeWidgetToolInput(previous, next)

  assert.equal(getWidgetRenderCode(merged), previous.widget_code)
})

test('mergeWidgetToolInput prefers an empty previous over losing a complete next payload', () => {
  const next = {
    title: 'Architecture',
    widget_code: '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
  }

  assert.deepEqual(mergeWidgetToolInput({}, next), next)
  assert.deepEqual(mergeWidgetToolInput(undefined, next), next)
})
