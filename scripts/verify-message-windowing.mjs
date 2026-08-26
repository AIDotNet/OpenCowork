/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startWorkerOverHttp } from './lib/worker-http-harness.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..')
const workerProject = path.join(
  repoRoot,
  'sidecars',
  'OpenCowork.Native.Worker',
  'OpenCowork.Native.Worker.csproj'
)

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

/**
 * The provider request body is too large to ride along on the event, so
 * `request_debug` carries a `bodyRef` and the body itself is fetched on demand.
 * Reading only `debugInfo.body` makes every body assertion below skip silently.
 */
async function parseDebugBody(client, debugInfo) {
  let raw = typeof debugInfo?.body === 'string' && debugInfo.body.length > 0 ? debugInfo.body : null
  if (!raw && debugInfo?.bodyRef) {
    const fetched = await client
      .request('agent/debug-body-read', { bodyRef: debugInfo.bodyRef })
      .catch(() => null)
    raw = typeof fetched?.body === 'string' && fetched.body.length > 0 ? fetched.body : null
  }
  if (!raw) return null
  try {
    return JSON.stringify(JSON.parse(raw))
  } catch {
    return null
  }
}

function messageContent(text) {
  return JSON.stringify(text)
}

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000

/**
 * Wraps the shared HTTP harness with what these assertions need: the durable
 * consumer id, an `agent/stream` auto-ack (the outbox stops publishing once its
 * in-flight window fills, so a harness that never acks stalls after ~32 batches),
 * and the `jobs/submit` indirection `agent/run` requires.
 */
function createWindowingClient(worker, consumerId) {
  const client = {
    consumerId,
    request: (method, params = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) =>
      worker.request(method, params, timeoutMs),
    onEvent: (eventName, listener) => worker.on(eventName, listener),
    async submitAgentRun(params) {
      const runId = params.runId
      const submission = await client.request('jobs/submit', {
        method: 'agent/run',
        params,
        jobId: runId,
        idempotencyKey: runId
      })
      assert(
        submission.accepted,
        `agent/run was not durably accepted: ${JSON.stringify(submission)}`
      )
      return submission
    },
    close: () => worker.close()
  }

  worker.on('agent/stream', (frame) => {
    if (typeof frame?.runId !== 'string' || typeof frame?.seq !== 'number') return
    void client
      .request('events/checkpoint', { consumerId, jobId: frame.runId, throughSeq: frame.seq })
      .catch(() => {})
  })

  return client
}

async function startWorker(tempDir) {
  const suffix = `${process.pid}-${randomUUID()}`
  const consumerId = `verify-windowing-${process.pid}`
  const worker = await startWorkerOverHttp({
    command: 'dotnet',
    commandArgs: ['run', '--project', workerProject, '-f', 'net11.0', '--'],
    hostId: `verify-windowing-${suffix}`,
    cwd: repoRoot,
    env: {
      OPEN_COWORK_NATIVE_DEBUG_BODY_PREVIEW_CHARS: '200000',
      OPEN_COWORK_RUNTIME_DB_PATH: path.join(tempDir, 'runtime-jobs.db')
    }
  })
  const client = createWindowingClient(worker, consumerId)
  await worker.attachEvents(consumerId)
  await client.request('worker/ping')
  await client.request('events/subscribe', { consumerId, limit: 4096 })
  return { client, worker }
}

function buildSeedMessages(sessionId) {
  const messages = []
  const now = Date.now()
  for (let index = 0; index < 80; index += 1) {
    messages.push({
      id: `m${index}`,
      sessionId,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: messageContent(`plain message ${index}`),
      meta: null,
      createdAt: now + index,
      usage:
        index === 79
          ? JSON.stringify({
              inputTokens: 1200,
              outputTokens: 12,
              contextTokens: 1200
            })
          : null,
      sortOrder: index
    })
  }
  return messages
}

function buildCompactArtifacts(sessionId, insertSortOrder) {
  const now = Date.now() + 10_000
  return [
    {
      id: 'compact-boundary',
      sessionId,
      role: 'system',
      content: messageContent('Conversation compacted'),
      meta: JSON.stringify({
        compactBoundary: {
          trigger: 'auto',
          preTokens: 1200,
          messagesSummarized: 60,
          preservedSegment: {
            headId: 'm60',
            anchorId: 'compact-summary',
            tailId: 'm61'
          }
        }
      }),
      createdAt: now,
      usage: null,
      sortOrder: insertSortOrder
    },
    {
      id: 'compact-summary',
      sessionId,
      role: 'user',
      content: messageContent(
        '[Context Memory Compressed Summary]\n\nSummary of messages 0 through 59. Keep this text.'
      ),
      meta: JSON.stringify({
        compactSummary: {
          messagesSummarized: 60,
          recentMessagesPreserved: true
        }
      }),
      createdAt: now + 1,
      usage: null,
      sortOrder: insertSortOrder + 1
    }
  ]
}

async function waitForRequestDebug(client, runId) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('Timed out waiting for request_debug event'))
    }, 20_000)
    const unsubscribe = client.onEvent('agent/stream', (frame) => {
      if (frame.runId !== runId) return
      for (const event of frame.events ?? []) {
        if (event.type === 'request_debug') {
          clearTimeout(timer)
          unsubscribe()
          resolve(event.debugInfo)
        }
      }
    })
  })
}

/**
 * The recorded compaction cut is what keeps summarized turns out of the context
 * window. Exercise it end to end against the Worker: commit a cut, confirm the
 * request only carries the summary plus what came after it, and confirm the two
 * ways a cut can be reported twice or invalidated.
 */
async function verifyCompactionCut(client, dbPath) {
  const sessionId = 'session-compaction-cut'
  await client.request('db/sessions-create', {
    dbPath,
    id: sessionId,
    title: 'Compaction cut smoke',
    mode: 'chat',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })

  const now = Date.now()
  const seeded = Array.from({ length: 20 }, (_, index) => ({
    id: `cut-${index}`,
    sessionId,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: messageContent(`cut message ${index}`),
    meta: null,
    createdAt: now + index,
    usage: null,
    sortOrder: index
  }))
  await client.request('db/messages-add-batch', { dbPath, messages: seeded })

  // The turn that was streaming when compression ran is inside the compacted
  // range but must survive it, so it is reported as compacted and kept.
  const commit = await client.request('db/session-compaction-commit', {
    dbPath,
    sessionId,
    summaryMessage: {
      id: 'cut-summary',
      role: 'user',
      content: messageContent('Here is a summary of our conversation so far. Keep this text.'),
      createdAt: now + 1_000
    },
    compactedMessageIds: seeded.map((message) => message.id),
    keepMessageIds: ['cut-19'],
    compactedMessageCount: 20,
    trigger: 'auto',
    preTokens: 120_000,
    createdAt: now + 1_000
  })
  assert(commit.success, `compaction commit failed: ${commit.error ?? 'unknown error'}`)
  assert(
    commit.compaction.generation === 1,
    `expected generation 1, got ${commit.compaction.generation}`
  )
  assert(
    commit.compaction.throughMessageId === 'cut-18',
    `cut should stop before the spared row, got ${commit.compaction.throughMessageId}`
  )
  assert(
    commit.summarySortOrder === 20,
    `summary should land at the tail, got ${commit.summarySortOrder}`
  )
  assert(commit.total === 21, `expected total=21 after the summary, got ${commit.total}`)

  const read = await client.request('db/session-compaction-get', { dbPath, sessionId })
  assert(read.success && read.compaction, 'compaction read-back failed')
  assert(
    read.compaction.summaryMessageId === 'cut-summary',
    'compaction read-back lost the summary'
  )
  assert(
    read.compaction.keepMessageIds.join(',') === 'cut-19',
    `compaction read-back lost the spared rows: ${read.compaction.keepMessageIds.join(',')}`
  )

  // The event outbox delivers at least once; a replayed report must not move the
  // cut, or every replay would force a pointless hosted-session reopen.
  const replay = await client.request('db/session-compaction-commit', {
    dbPath,
    sessionId,
    summaryMessage: {
      id: 'cut-summary',
      role: 'user',
      content: messageContent('Here is a summary of our conversation so far. Keep this text.'),
      createdAt: now + 1_000
    },
    compactedMessageIds: seeded.map((message) => message.id),
    keepMessageIds: ['cut-19'],
    compactedMessageCount: 20,
    trigger: 'auto',
    preTokens: 120_000,
    createdAt: now + 2_000
  })
  assert(replay.success, `replayed commit failed: ${replay.error ?? 'unknown error'}`)
  assert(
    replay.compaction.generation === 1,
    `replayed commit moved the generation to ${replay.compaction.generation}`
  )
  assert(replay.total === 21, `replayed commit changed the row count to ${replay.total}`)

  const cutDebugPromise = waitForRequestDebug(client, 'compaction-cut-run')
  await client.submitAgentRun({
    dbPath,
    runId: 'compaction-cut-run',
    sessionId,
    messages: [],
    contextSource: { sessionId, maxMessages: 60, compressionMode: 'auto' },
    provider: {
      type: 'openai-chat',
      apiKey: 'test-key',
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'windowing-smoke-model'
    },
    tools: [],
    maxIterations: 1,
    forceApproval: false,
    includeFullDebugBody: true
  })
  const cutBody = await parseDebugBody(client, await cutDebugPromise)
  if (cutBody) {
    assert(cutBody.includes('Keep this text'), 'compacted request omitted the summary')
    assert(cutBody.includes('cut message 19'), 'compacted request dropped the spared turn')
    assert(!cutBody.includes('cut message 5'), 'compacted request leaked summarized history')
  } else {
    console.warn('request_debug body unavailable; skipping compaction-cut assertions')
  }
  await client.request('agent/cancel', { runId: 'compaction-cut-run' }).catch(() => {})

  // Rewinding past the summary makes the cut meaningless: it must be dropped so
  // the session falls back to its (now shorter) full history.
  const deleted = await client.request('db/messages-delete', {
    dbPath,
    sessionId,
    messageId: 'cut-summary'
  })
  assert(deleted.success && deleted.deleted, 'summary delete failed')
  const orphaned = await client.request('db/session-compaction-get', { dbPath, sessionId })
  assert(orphaned.success, 'orphaned compaction read failed')
  assert(!orphaned.compaction, 'a cut survived the loss of its summary')
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'open-cowork-windowing-'))
  const dbPath = path.join(tempDir, 'data.db')
  let client
  let worker

  try {
    ;({ client, worker } = await startWorker(tempDir))

    const memory = await client.request('worker/memory')
    assert(memory.success, `worker/memory failed: ${memory.error ?? 'unknown error'}`)
    assert(memory.pid > 0, `worker/memory returned invalid pid: ${memory.pid}`)
    assert(
      memory.workingSetBytes > 0,
      `worker/memory returned invalid working set: ${memory.workingSetBytes}`
    )

    const sessionId = 'session-windowing-smoke'
    const init = await client.request('db/initialize', { dbPath })
    assert(init.success, `db/initialize failed: ${init.error ?? 'unknown error'}`)
    await client.request('db/sessions-create', {
      dbPath,
      id: sessionId,
      title: 'Windowing smoke',
      mode: 'chat',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    await client.request('db/messages-add-batch', {
      dbPath,
      messages: buildSeedMessages(sessionId)
    })

    const tailIndex = await client.request('db/messages-window-index', {
      dbPath,
      sessionId,
      direction: 'tail',
      byteBudget: 16 * 1024,
      maxRows: 240
    })
    assert(tailIndex.success, `tail index failed: ${tailIndex.error ?? 'unknown error'}`)
    assert(tailIndex.rows.at(-1)?.id === 'm79', 'tail index did not end at the newest row')
    const tailRange = await client.request('db/messages-range', {
      dbPath,
      sessionId,
      start: tailIndex.start,
      end: tailIndex.end
    })
    assert(tailRange.success, `tail range failed: ${tailRange.error ?? 'unknown error'}`)
    assert(tailRange.rows.length === tailIndex.rows.length, 'tail index/range count mismatch')
    const olderIndex = await client.request('db/messages-window-index', {
      dbPath,
      sessionId,
      direction: 'older',
      anchorSortOrder: 40,
      byteBudget: 8 * 1024,
      maxRows: 240
    })
    assert(
      olderIndex.success && olderIndex.rows.at(-1)?.sort_order < 40,
      'older index crossed anchor'
    )
    const newerIndex = await client.request('db/messages-window-index', {
      dbPath,
      sessionId,
      direction: 'newer',
      anchorSortOrder: 40,
      byteBudget: 8 * 1024,
      maxRows: 240
    })
    assert(newerIndex.success && newerIndex.rows[0]?.sort_order >= 40, 'newer index crossed anchor')

    const largeSessionId = 'session-windowing-large'
    await client.request('db/sessions-create', {
      dbPath,
      id: largeSessionId,
      title: 'Large message smoke',
      mode: 'chat',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    await client.request('db/messages-add-batch', {
      dbPath,
      messages: Array.from({ length: 30 }, (_, index) => ({
        id: `large-${index}`,
        sessionId: largeSessionId,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: messageContent(`ordinary ${index}`),
        meta: null,
        createdAt: Date.now() + index,
        usage: null,
        sortOrder: index
      })).concat(
        {
          id: 'large-30',
          sessionId: largeSessionId,
          role: 'tool',
          content: messageContent('x'.repeat(3 * 1024 * 1024)),
          meta: null,
          createdAt: Date.now() + 30,
          usage: null,
          sortOrder: 30
        },
        {
          id: 'large-31',
          sessionId: largeSessionId,
          role: 'tool',
          content: messageContent('x'.repeat(1024 * 1024)),
          meta: null,
          createdAt: Date.now() + 31,
          usage: null,
          sortOrder: 31
        },
        {
          id: 'large-32',
          sessionId: largeSessionId,
          role: 'tool',
          content: messageContent('x'.repeat(500 * 1024)),
          meta: null,
          createdAt: Date.now() + 32,
          usage: null,
          sortOrder: 32
        }
      )
    })
    const largeIndex = await client.request('db/messages-window-index', {
      dbPath,
      sessionId: largeSessionId,
      direction: 'tail',
      byteBudget: 256 * 1024,
      maxRows: 240
    })
    assert(
      largeIndex.rows.length === 1 && largeIndex.rows[0].id === 'large-32',
      'oversized tail selection failed'
    )
    for (const [sortOrder, expectedBytes, expectedState] of [
      [30, 3 * 1024 * 1024, 'preview'],
      [31, 1024 * 1024, 'preview'],
      [32, 500 * 1024, 'full']
    ]) {
      const largeRange = await client.request('db/messages-range', {
        dbPath,
        sessionId: largeSessionId,
        start: sortOrder,
        end: sortOrder + 1,
        oversizedBytes: 512 * 1024
      })
      assert(
        largeRange.rows[0].content_state === expectedState,
        `unexpected content state for row ${sortOrder}`
      )
      assert(
        expectedState === 'preview'
          ? largeRange.rows[0].content == null
          : typeof largeRange.rows[0].content === 'string',
        `unexpected content transfer for row ${sortOrder}`
      )
      assert(
        largeRange.rows[0].content_bytes >= expectedBytes,
        `content byte index is wrong for row ${sortOrder}`
      )
    }
    const fullLargeContent = await client.request('db/messages-content', {
      dbPath,
      sessionId: largeSessionId,
      messageId: 'large-30'
    })
    assert(fullLargeContent.success && fullLargeContent.row, 'full oversized content lookup failed')
    assert(
      fullLargeContent.row.content.length > 3 * 1024 * 1024,
      'full oversized content lookup was truncated'
    )
    assert(
      fullLargeContent.row.content_bytes > 3 * 1024 * 1024,
      'full oversized content lookup omitted its byte weight'
    )

    // Exercise the sidebar cursor boundary with more than the old 2000-row
    // hard limit. All rows share one timestamp so the id tie-breaker is tested
    // as well; the renderer can safely merge injected rows without moving the
    // ordinary page cursor.
    const cursorSessionCount = 2055
    const cursorUpdatedAt = 1_700_000_000_000
    for (let index = 0; index < cursorSessionCount; index += 1) {
      const created = await client.request('db/sessions-create', {
        dbPath,
        id: `cursor-session-${String(index).padStart(4, '0')}`,
        title: `Cursor ${index}`,
        mode: 'chat',
        createdAt: cursorUpdatedAt + index,
        updatedAt: cursorUpdatedAt,
        pinned: index % 3 === 0
      })
      assert(created.success, `cursor session ${index} failed to create`)
    }
    const injectedPage = await client.request('db/sessions-list-page', {
      dbPath,
      projectId: null,
      limit: 50,
      includeSessionIds: ['cursor-session-0000']
    })
    assert(
      injectedPage.rows.some((row) => row.id === 'cursor-session-0000'),
      'current-session injection did not include an old row'
    )
    const pinnedInjectedPage = await client.request('db/sessions-list-page', {
      dbPath,
      projectId: null,
      limit: 50,
      includePinned: true
    })
    assert(
      pinnedInjectedPage.rows.some((row) => row.id === 'cursor-session-0003'),
      'pinned-session injection did not include an old pinned row'
    )

    const cursorRows = new Map()
    let cursor = null
    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      const page = await client.request('db/sessions-list-page', {
        dbPath,
        projectId: null,
        limit: 50,
        cursor
      })
      for (const row of page.rows) {
        if (!row.id.startsWith('cursor-session-')) continue
        assert(!cursorRows.has(row.id), `cursor pagination duplicated ${row.id}`)
        cursorRows.set(row.id, row)
      }
      if (!page.hasMore) break
      assert(page.nextCursor, `cursor page ${pageIndex} reported hasMore without cursor`)
      cursor = page.nextCursor
      if (pageIndex === 99) throw new Error('cursor pagination exceeded 100 pages')
    }
    assert(
      cursorRows.size === cursorSessionCount,
      `cursor pagination lost rows: expected ${cursorSessionCount}, got ${cursorRows.size}`
    )

    const around = await client.request('db/messages-window-around', {
      dbPath,
      sessionId,
      messageId: 'm50',
      limit: 11
    })
    assert(around.success, `window-around failed: ${around.error ?? 'unknown error'}`)
    assert(around.total === 80, `expected total=80 before artifacts, got ${around.total}`)
    assert(around.rows.length === 11, `expected 11 window rows, got ${around.rows.length}`)
    assert(around.anchorSortOrder === 50, `expected anchor sort 50, got ${around.anchorSortOrder}`)
    assert(around.rows[0].id === 'm45', `expected first window row m45, got ${around.rows[0]?.id}`)
    assert(
      around.rows.at(-1)?.id === 'm55',
      `expected last window row m55, got ${around.rows.at(-1)?.id}`
    )

    const requestContextRows = await client.request('db/messages-request-context', {
      dbPath,
      sessionId,
      maxMessages: 6
    })
    const requestContextIds = requestContextRows.map((row) => row.id)
    assert(
      requestContextIds.join(',') === 'm0,m75,m76,m77,m78,m79',
      `unexpected request context ids: ${requestContextIds.join(',')}`
    )

    const headTailDebugPromise = waitForRequestDebug(client, 'head-tail-run')
    await client.submitAgentRun({
      dbPath,
      runId: 'head-tail-run',
      sessionId,
      messages: [],
      contextSource: {
        sessionId,
        maxMessages: 6,
        compressionMode: 'auto'
      },
      provider: {
        type: 'openai-chat',
        apiKey: 'test-key',
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'windowing-smoke-model'
      },
      tools: [],
      maxIterations: 1,
      forceApproval: false,
      includeFullDebugBody: true
    })
    const headTailDebugInfo = await headTailDebugPromise
    const headTailBody = await parseDebugBody(client, headTailDebugInfo)
    if (headTailBody) {
      assert(headTailBody.includes('plain message 0'), 'request context omitted DB head task')
      assert(headTailBody.includes('plain message 79'), 'request context omitted DB tail')
      assert(!headTailBody.includes('plain message 10'), 'request context leaked middle history')
    } else {
      console.warn('request_debug body unavailable; skipping provider-body assertions')
    }
    await client.request('agent/cancel', { runId: 'head-tail-run' }).catch(() => {})

    const directDebugPromise = waitForRequestDebug(client, 'direct-bounded-run')
    await client.submitAgentRun({
      dbPath,
      runId: 'direct-bounded-run',
      sessionId,
      messages: [
        {
          id: 'direct-renderer-task',
          role: 'user',
          content: 'direct renderer bounded task context',
          createdAt: Date.now() + 30_000
        },
        {
          id: 'direct-renderer-tail',
          role: 'assistant',
          content: 'direct renderer tail context',
          createdAt: Date.now() + 30_001
        }
      ],
      contextSource: {
        sessionId,
        maxMessages: 6,
        compressionMode: 'auto'
      },
      provider: {
        type: 'openai-chat',
        apiKey: 'test-key',
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'windowing-smoke-model'
      },
      tools: [],
      maxIterations: 1,
      forceApproval: false,
      includeFullDebugBody: true
    })
    const directDebugInfo = await directDebugPromise
    const directBody = await parseDebugBody(client, directDebugInfo)
    if (directBody) {
      assert(directBody.includes('direct renderer bounded task context'), 'direct messages omitted')
      assert(
        !directBody.includes('plain message 79'),
        'direct messages were replaced by DB context'
      )
    }
    await client.request('agent/cancel', { runId: 'direct-bounded-run' }).catch(() => {})

    const insert = await client.request('db/messages-insert-artifacts', {
      dbPath,
      sessionId,
      insertBeforeMessageId: 'm60',
      insertSortOrder: 60,
      messages: buildCompactArtifacts(sessionId, 60)
    })
    assert(insert.success, `insert artifacts failed: ${insert.error ?? 'unknown error'}`)
    assert(insert.inserted === 2, `expected inserted=2, got ${insert.inserted}`)
    assert(
      insert.start === 60 && insert.end === 62,
      `expected artifact range [60,62), got [${insert.start},${insert.end})`
    )
    assert(insert.total === 82, `expected total=82 after artifacts, got ${insert.total}`)

    const afterInsert = await client.request('db/messages-window-around', {
      dbPath,
      sessionId,
      sortOrder: 61,
      limit: 5
    })
    assert(
      afterInsert.success,
      `post-insert window failed: ${afterInsert.error ?? 'unknown error'}`
    )
    const postIds = afterInsert.rows.map((row) => row.id)
    assert(
      postIds.join(',') === 'm59,compact-boundary,compact-summary,m60,m61',
      `unexpected post-insert ids: ${postIds.join(',')}`
    )

    const compactRequestContextRows = await client.request('db/messages-request-context', {
      dbPath,
      sessionId,
      maxMessages: 6
    })
    const compactContextIds = compactRequestContextRows.map((row) => row.id)
    assert(compactContextIds.includes('m0'), 'compact request context omitted DB head')
    assert(compactContextIds.includes('compact-summary'), 'compact request context omitted summary')
    assert(compactContextIds.includes('m79'), 'compact request context omitted tail')
    assert(!compactContextIds.includes('m10'), 'compact request context leaked middle history')

    const count = await client.request('db/messages-count', { dbPath, sessionId })
    assert(
      count.success && count.count === 82,
      `expected persisted count 82, got ${JSON.stringify(count)}`
    )

    const debugPromise = waitForRequestDebug(client, 'windowing-run')
    await client.submitAgentRun({
      dbPath,
      runId: 'windowing-run',
      sessionId,
      messages: [],
      contextSource: {
        sessionId,
        maxMessages: 6,
        compressionMode: 'auto'
      },
      liveOverlayMessages: [
        {
          id: 'live-overlay-user',
          role: 'user',
          content: 'live overlay request from renderer',
          createdAt: Date.now() + 20_000
        }
      ],
      provider: {
        type: 'openai-chat',
        apiKey: 'test-key',
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'windowing-smoke-model'
      },
      tools: [],
      maxIterations: 1,
      forceApproval: false,
      includeFullDebugBody: true
    })
    const debugInfo = await debugPromise
    const serializedBody = await parseDebugBody(client, debugInfo)
    if (serializedBody) {
      assert(
        serializedBody.includes('Summary of messages 0 through 59'),
        'request context omitted compact summary'
      )
      assert(serializedBody.includes('plain message 79'), 'request context omitted DB tail')
      assert(
        serializedBody.includes('live overlay request from renderer'),
        'request context omitted live overlay'
      )
      assert(
        !serializedBody.includes('plain message 10'),
        'request context leaked old pre-summary history'
      )
    }

    await client.request('agent/cancel', { runId: 'windowing-run' }).catch(() => {})

    // Sort-order normalization can move a compact summary before its boundary
    // (same createdAt). The request view must still pair them by summaryId and
    // keep the request compacted instead of falling back to the full history.
    const flippedSessionId = 'session-flipped-compact'
    await client.request('db/sessions-create', {
      dbPath,
      id: flippedSessionId,
      title: 'Flipped compact smoke',
      mode: 'chat',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    const flippedNow = Date.now()
    await client.request('db/messages-add-batch', {
      dbPath,
      messages: [
        ...Array.from({ length: 40 }, (_, index) => ({
          id: `flip-${index}`,
          sessionId: flippedSessionId,
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: messageContent(`flip message ${index}`),
          meta: null,
          createdAt: flippedNow + index,
          usage:
            index === 39
              ? JSON.stringify({ inputTokens: 900, outputTokens: 9, contextTokens: 900 })
              : null,
          sortOrder: index
        })),
        {
          id: 'flip-summary',
          sessionId: flippedSessionId,
          role: 'user',
          content: messageContent(
            '[Context Memory Compressed Summary]\n\nSummary of flip messages 0 through 39.'
          ),
          meta: JSON.stringify({
            compactSummary: { messagesSummarized: 40, recentMessagesPreserved: false }
          }),
          createdAt: flippedNow + 100,
          usage: null,
          sortOrder: 40
        },
        {
          id: 'flip-boundary',
          sessionId: flippedSessionId,
          role: 'system',
          content: messageContent('Conversation compacted'),
          meta: JSON.stringify({
            compactBoundary: {
              trigger: 'manual',
              preTokens: 900,
              messagesSummarized: 40,
              summaryId: 'flip-summary'
            }
          }),
          createdAt: flippedNow + 100,
          usage: null,
          sortOrder: 41
        },
        {
          id: 'flip-after',
          sessionId: flippedSessionId,
          role: 'user',
          content: messageContent('flip follow-up after compaction'),
          meta: null,
          createdAt: flippedNow + 200,
          usage: null,
          sortOrder: 42
        }
      ]
    })
    const flippedDebugPromise = waitForRequestDebug(client, 'flipped-compact-run')
    await client.submitAgentRun({
      dbPath,
      runId: 'flipped-compact-run',
      sessionId: flippedSessionId,
      messages: [],
      contextSource: {
        sessionId: flippedSessionId,
        maxMessages: 60,
        compressionMode: 'auto'
      },
      provider: {
        type: 'openai-chat',
        apiKey: 'test-key',
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'windowing-smoke-model'
      },
      tools: [],
      maxIterations: 1,
      forceApproval: false,
      includeFullDebugBody: true
    })
    const flippedDebugInfo = await flippedDebugPromise
    const flippedBody = await parseDebugBody(client, flippedDebugInfo)
    if (flippedBody) {
      assert(
        flippedBody.includes('Summary of flip messages 0 through 39'),
        'flipped compact view omitted the summary'
      )
      assert(
        flippedBody.includes('flip follow-up after compaction'),
        'flipped compact view omitted the post-compaction tail'
      )
      assert(
        !flippedBody.includes('flip message 5'),
        'flipped compact view leaked pre-summary history'
      )
    } else {
      console.warn('request_debug body unavailable; skipping flipped-compact assertions')
    }
    await client.request('agent/cancel', { runId: 'flipped-compact-run' }).catch(() => {})

    await verifyCompactionCut(client, dbPath)

    const clearedProjectless = await client.request('db/sessions-clear-project', {
      dbPath,
      projectId: null,
      excludeSessionIds: [sessionId]
    })
    assert(clearedProjectless.success, 'projectless session clear failed')
    assert(
      clearedProjectless.deletedSessions >= cursorSessionCount,
      'projectless session clear did not include unloaded cursor pages'
    )
    const preservedPrimarySession = await client.request('db/sessions-get', {
      dbPath,
      id: sessionId
    })
    assert(
      preservedPrimarySession.success && preservedPrimarySession.session?.id === sessionId,
      'projectless session clear ignored its running-session exclusion'
    )
    const deletedCursorSession = await client.request('db/sessions-get', {
      dbPath,
      id: 'cursor-session-0000'
    })
    assert(
      deletedCursorSession.success && !deletedCursorSession.session,
      'projectless session clear left an unloaded cursor row behind'
    )

    console.log('message-windowing verification passed')
  } finally {
    await worker?.close()
    await rm(tempDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
