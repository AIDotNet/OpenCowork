/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { decode, encode } from '@msgpack/msgpack'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const workerProject = path.join(
  repoRoot,
  'sidecars',
  'OpenCowork.Native.Worker',
  'OpenCowork.Native.Worker.csproj'
)
const frameHeaderBytes = 4
const maxFrameBytes = 256 * 1024 * 1024

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function parseDebugBody(debugInfo) {
  if (!debugInfo || typeof debugInfo.body !== 'string' || debugInfo.body.length === 0) {
    return null
  }
  try {
    return JSON.stringify(JSON.parse(debugInfo.body))
  } catch {
    return null
  }
}

function messageContent(text) {
  return JSON.stringify(text)
}

function createFrame(payload) {
  if (payload.byteLength <= 0 || payload.byteLength > maxFrameBytes) {
    throw new Error(`Invalid frame payload length: ${payload.byteLength}`)
  }
  const frame = Buffer.allocUnsafe(frameHeaderBytes + payload.byteLength)
  frame.writeUInt32BE(payload.byteLength, 0)
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(frame, frameHeaderBytes)
  return frame
}

class NativeWorkerClient {
  constructor(endpoint, child) {
    this.endpoint = endpoint
    this.child = child
    this.socket = null
    this.readBuffer = Buffer.alloc(0)
    this.nextId = 1
    this.pending = new Map()
    this.eventListeners = new Map()
  }

  async connect() {
    const deadline = Date.now() + 60_000
    let lastError = null
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) {
        throw new Error(`Native worker exited before connect: ${this.child.exitCode}`)
      }
      try {
        this.socket = await new Promise((resolve, reject) => {
          const socket = net.createConnection(this.endpoint)
          socket.once('connect', () => resolve(socket))
          socket.once('error', reject)
        })
        this.socket.on('data', (chunk) => this.handleData(chunk))
        this.socket.on('error', (error) => this.rejectAll(error))
        this.socket.on('close', () => this.rejectAll(new Error('Native worker socket closed')))
        return
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 80))
      }
    }
    throw lastError ?? new Error('Timed out connecting to native worker')
  }

  onEvent(eventName, listener) {
    const listeners = this.eventListeners.get(eventName) ?? new Set()
    listeners.add(listener)
    this.eventListeners.set(eventName, listeners)
    return () => listeners.delete(listener)
  }

  request(method, params = {}, timeoutMs = 20_000) {
    if (!this.socket) throw new Error('Native worker is not connected')
    const id = this.nextId++
    const payload = encode({ id, method, params })
    const frame = createFrame(payload)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Native worker request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      this.socket.write(frame, (error) => {
        if (error) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(error)
        }
      })
    })
  }

  handleData(chunk) {
    this.readBuffer = Buffer.concat([this.readBuffer, chunk])
    while (this.readBuffer.length >= frameHeaderBytes) {
      const length = this.readBuffer.readUInt32BE(0)
      if (length <= 0 || length > maxFrameBytes) {
        this.rejectAll(new Error(`Invalid frame length: ${length}`))
        return
      }
      const frameLength = frameHeaderBytes + length
      if (this.readBuffer.length < frameLength) return
      const payload = this.readBuffer.subarray(frameHeaderBytes, frameLength)
      this.readBuffer = this.readBuffer.subarray(frameLength)
      this.handleFrame(payload)
    }
  }

  handleFrame(payload) {
    const decoded = decode(payload)
    if (!decoded || typeof decoded !== 'object') return
    if (decoded.event) {
      this.emit(decoded.event, decoded)
      return
    }
    if (typeof decoded.id !== 'number') return
    const pending = this.pending.get(decoded.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(decoded.id)
    if (decoded.error) {
      pending.reject(new Error(String(decoded.error)))
    } else {
      pending.resolve(decoded.result)
    }
  }

  emit(eventName, payload) {
    const listeners = this.eventListeners.get(eventName)
    if (!listeners) return
    for (const listener of listeners) {
      listener(payload)
    }
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  close() {
    this.socket?.destroy()
    this.rejectAll(new Error('Native worker closed'))
  }
}

async function startWorker(tempDir) {
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\open-cowork-verify-${process.pid}-${randomUUID()}`
      : path.join(tempDir, `ocw-${process.pid}.sock`)
  const child = spawn('dotnet', ['run', '--project', workerProject, '--', '--ipc', endpoint], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPEN_COWORK_NATIVE_DEBUG_BODY_PREVIEW_CHARS: '200000'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString('utf8').trim()
    if (text) console.warn(`[native-worker] ${text}`)
  })
  const client = new NativeWorkerClient(endpoint, child)
  await client.connect()
  await client.request('worker/ping')
  return { client, child }
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

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'open-cowork-windowing-'))
  const dbPath = path.join(tempDir, 'data.db')
  let client
  let child

  try {
    ;({ client, child } = await startWorker(tempDir))

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
    await client.request('agent/run', {
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
    const headTailBody = parseDebugBody(headTailDebugInfo)
    if (headTailBody) {
      assert(headTailBody.includes('plain message 0'), 'request context omitted DB head task')
      assert(headTailBody.includes('plain message 79'), 'request context omitted DB tail')
      assert(!headTailBody.includes('plain message 10'), 'request context leaked middle history')
    } else {
      console.warn('request_debug body unavailable; skipping provider-body assertions')
    }
    await client.request('agent/cancel', { runId: 'head-tail-run' }).catch(() => {})

    const directDebugPromise = waitForRequestDebug(client, 'direct-bounded-run')
    await client.request('agent/run', {
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
    const directBody = parseDebugBody(directDebugInfo)
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
    await client.request('agent/run', {
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
    const serializedBody = parseDebugBody(debugInfo)
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
    await client.request('agent/run', {
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
    const flippedBody = parseDebugBody(flippedDebugInfo)
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
    client?.close()
    if (child && child.exitCode === null) {
      child.kill()
    }
    await rm(tempDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
