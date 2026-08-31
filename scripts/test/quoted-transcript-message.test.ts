import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isLiveQuotedTranscriptMessage,
  shouldKeepUnfetchedQuotedResident
} from '../../src/renderer/src/lib/chat/quoted-transcript-message.ts'

test('live quoted transcript messages are user rows marked quoted', () => {
  assert.equal(isLiveQuotedTranscriptMessage({ role: 'user', source: 'quoted' }), true)
  assert.equal(isLiveQuotedTranscriptMessage({ role: 'user', source: 'queued' }), false)
  assert.equal(isLiveQuotedTranscriptMessage({ role: 'assistant', source: 'quoted' }), false)
})

test('keeps a quoted bubble whose sortOrder is already inside the fetched window', () => {
  // Session count moved when the optimistic row was appended, so the reload
  // reports fetchedWindowEnd === residentEnd. The quoted sortOrder sits just
  // inside that range and is missing from SQLite for a beat.
  assert.equal(
    shouldKeepUnfetchedQuotedResident({
      isPendingLocalWrite: false,
      isLiveQuoted: true,
      logicalIndex: 100,
      residentStart: 20,
      windowStart: 20,
      fetchedWindowEnd: 101,
      knownCount: 101,
      residentEnd: 101,
      sessionMessageCount: 101,
      fetchedCount: 80
    }),
    true
  )
})

test('legacy tail-not-in-db rule still keeps a pending write without the quoted flag', () => {
  assert.equal(
    shouldKeepUnfetchedQuotedResident({
      isPendingLocalWrite: true,
      isLiveQuoted: false,
      logicalIndex: 100,
      residentStart: 20,
      windowStart: 20,
      fetchedWindowEnd: 100,
      knownCount: 101,
      residentEnd: 101,
      sessionMessageCount: 101,
      fetchedCount: 80
    }),
    true
  )
})

test('drops an unrelated resident row that the fetched window already covers', () => {
  assert.equal(
    shouldKeepUnfetchedQuotedResident({
      isPendingLocalWrite: false,
      isLiveQuoted: false,
      logicalIndex: 50,
      residentStart: 20,
      windowStart: 20,
      fetchedWindowEnd: 101,
      knownCount: 101,
      residentEnd: 101,
      sessionMessageCount: 101,
      fetchedCount: 80
    }),
    false
  )
})
