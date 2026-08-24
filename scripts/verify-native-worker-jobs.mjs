/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startWorkerOverHttp } from './lib/worker-http-harness.mjs'

const tempDirectory = mkdtempSync(join(tmpdir(), 'open-cowork-worker-jobs-'))
const workerDll = resolve(
  'sidecars/OpenCowork.Native.Worker/bin/Debug/net11.0/OpenCowork.Native.Worker.dll'
)
const providerRequestCounts = new Map()

function countProviderRequest(name) {
  const count = (providerRequestCounts.get(name) ?? 0) + 1
  providerRequestCounts.set(name, count)
  return count
}

function writeChatCompletion(response) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    [
      'data: {"choices":[{"delta":{"content":"retry recovered"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n'
    ].join('')
  )
}

function writeResponsesCompletion(response) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    [
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"retry recovered"}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"id":"resp_retry","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
      'data: [DONE]\n\n'
    ].join('')
  )
}

const providerServer = createServer((request, response) => {
  if (request.url?.startsWith('/compression/')) {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      [
        'data: {"choices":[{"delta":{"content":"Durable compression summary."},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}\n\n',
        'data: [DONE]\n\n'
      ].join('')
    )
    return
  }
  if (request.url?.startsWith('/headers-stall/')) {
    countProviderRequest('headers-stall')
    const finish = setTimeout(() => response.end(), 10_000)
    finish.unref()
    response.once('close', () => clearTimeout(finish))
    return
  }
  if (request.url?.startsWith('/responses-stream-overload/')) {
    if (countProviderRequest('responses-stream-overload') === 1) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        [
          'event: error\n',
          'data: {"type":"error","error":{"type":"service_unavailable_error","code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later.","param":null},"sequence_number":21}\n\n'
        ].join('')
      )
    } else {
      writeResponsesCompletion(response)
    }
    return
  }
  for (const statusCode of [408, 409, 425, 429, 500]) {
    const fixture = `retry-${statusCode}`
    if (request.url?.startsWith(`/${fixture}/`)) {
      if (countProviderRequest(fixture) === 1) {
        response.writeHead(statusCode, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: `transient HTTP ${statusCode}` } }))
      } else {
        writeChatCompletion(response)
      }
      return
    }
  }
  if (request.url?.startsWith('/no-retry-400/')) {
    countProviderRequest('no-retry-400')
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'invalid request fixture' } }))
    return
  }
  if (request.url?.startsWith('/stream-stall/')) {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.flushHeaders()
    const finish = setTimeout(() => response.end(), 10_000)
    finish.unref()
    response.once('close', () => clearTimeout(finish))
    return
  }
  if (request.url?.startsWith('/stall/')) {
    response.writeHead(400, { 'content-type': 'application/json' })
    response.write('{"error":{"message":"partial')
    const finish = setTimeout(() => response.end('"}}'), 10_000)
    finish.unref()
    response.once('close', () => clearTimeout(finish))
    return
  }
  response.writeHead(400, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: { message: 'intentional durable replay fixture' } }))
})
await new Promise((resolveListen, rejectListen) => {
  providerServer.once('error', rejectListen)
  providerServer.listen(0, '127.0.0.1', resolveListen)
})
const providerAddress = providerServer.address()
assert.ok(providerAddress && typeof providerAddress === 'object')
const providerBaseUrl = `http://127.0.0.1:${providerAddress.port}/v1`
const compressionProviderBaseUrl = `http://127.0.0.1:${providerAddress.port}/compression/v1`
const stalledProviderBaseUrl = `http://127.0.0.1:${providerAddress.port}/stall/v1`
const stalledHeadersBaseUrl = `http://127.0.0.1:${providerAddress.port}/headers-stall/v1`
const stalledStreamBaseUrl = `http://127.0.0.1:${providerAddress.port}/stream-stall/v1`
const responsesStreamOverloadBaseUrl = `http://127.0.0.1:${providerAddress.port}/responses-stream-overload/v1`
const retryStatusBaseUrls = new Map(
  [408, 409, 425, 429, 500].map((statusCode) => [
    statusCode,
    `http://127.0.0.1:${providerAddress.port}/retry-${statusCode}/v1`
  ])
)
const noRetry400BaseUrl = `http://127.0.0.1:${providerAddress.port}/no-retry-400/v1`

/**
 * Answers reverse RPC over the worker's dedicated reverse stream.
 *
 * The stream is separate from the event stream on purpose: this harness stalls
 * event delivery for long stretches, and a run blocked on a hook must still get
 * its answer. Sharing one stream would deadlock the run instead of exercising
 * the backpressure this file is here to verify.
 */
function answerReverseRequests(worker) {
  return worker.on('agent/reverse-request', (frame) => {
    const request = frame?.params
    const id = request?.id
    const method = request?.method
    if ((typeof id !== 'number' && typeof id !== 'string') || typeof method !== 'string') {
      throw new Error('Invalid agent/reverse-request fixture payload')
    }

    const response =
      method === 'hooks/run'
        ? { id, result: {} }
        : { id, error: `Unsupported reverse request in Job verification: ${method}` }
    void worker.request('agent/reverse-response', response).catch(() => {
      // The worker is going away; the assertions below report the real failure.
    })
  })
}

function collectAgentTerminals(worker, expectedRunIds, acknowledge) {
  const expected = new Set(expectedRunIds)
  const terminal = new Set()
  const seen = new Set()
  const lastSeqByRun = new Map()
  let timer
  let resolveCollection
  let rejectCollection
  const completed = new Promise((resolvePromise, rejectPromise) => {
    resolveCollection = resolvePromise
    rejectCollection = rejectPromise
  })

  const cleanup = () => {
    clearTimeout(timer)
    unsubscribeStream()
    unsubscribeError()
  }
  const unsubscribeError = worker.on('error', (error) => {
    cleanup()
    rejectCollection(error)
  })
  const unsubscribeStream = worker.on('agent/stream', (frame) => {
    if (
      typeof frame?.runId !== 'string' ||
      typeof frame.seq !== 'number' ||
      !expected.has(frame.runId)
    ) {
      return
    }
    const key = `${frame.runId}:${frame.seq}`
    if (seen.has(key)) {
      acknowledge(frame.runId, frame.seq)
      return
    }
    const lastSeq = lastSeqByRun.get(frame.runId) ?? 0
    if (frame.seq !== lastSeq + 1) {
      // Never ACK through a gap; a reconnect/replay may have stale later
      // frames ahead of the missing durable batch.
      return
    }
    seen.add(key)
    lastSeqByRun.set(frame.runId, frame.seq)
    acknowledge(frame.runId, frame.seq)
    if (
      Array.isArray(frame.events) &&
      frame.events.some((event) => event?.type === 'error' || event?.type === 'loop_end')
    ) {
      terminal.add(frame.runId)
    }
    if (terminal.size === expected.size) {
      cleanup()
      resolveCollection({ seen: seen.size, terminal: terminal.size })
    }
  })

  timer = setTimeout(() => {
    cleanup()
    rejectCollection(
      new Error(`Timed out replaying Agent events: ${terminal.size}/${expected.size} terminal`)
    )
  }, 20_000)
  return completed
}

async function waitForTerminal(client, jobId, timeoutMs = 20_000, onPoll) {
  const deadline = Date.now() + timeoutMs
  let lastStatus = null
  while (Date.now() < deadline) {
    await onPoll?.()
    const status = await client.request('jobs/result', { jobId })
    lastStatus = status
    if (['succeeded', 'failed', 'cancelled'].includes(status.state)) return status
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 75))
  }
  throw new Error(`Job did not become terminal: ${jobId} (${JSON.stringify(lastStatus)})`)
}

async function waitForAllTerminal(client, jobIds, timeoutMs = 20_000) {
  const expected = new Set(jobIds)
  const deadline = Date.now() + timeoutMs
  let lastStates = {}
  while (Date.now() < deadline) {
    const result = await client.request('jobs/list', { limit: 1000 })
    const jobs = Array.isArray(result.jobs) ? result.jobs : []
    lastStates = Object.fromEntries(
      jobs.filter((job) => expected.has(job.jobId)).map((job) => [job.jobId, job.state])
    )
    if (jobIds.every((jobId) => ['succeeded', 'failed', 'cancelled'].includes(lastStates[jobId]))) {
      return jobs.filter((job) => expected.has(job.jobId))
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Jobs did not become terminal: ${JSON.stringify(lastStates)}`)
}

async function verifyProviderTimeout(
  client,
  { baseUrl, requestTimeoutSeconds, streamIdleTimeoutSeconds, expectedError }
) {
  const runId = randomUUID()
  const submission = await client.request('jobs/submit', {
    method: 'agent/run',
    params: {
      runId,
      sessionId: `provider-timeout-${runId}`,
      messages: [
        {
          id: `message-${runId}`,
          role: 'user',
          content: 'provider timeout verification',
          createdAt: Date.now()
        }
      ],
      provider: {
        type: 'openai-chat',
        apiKey: 'test-key',
        baseUrl,
        model: 'provider-timeout-smoke',
        requestTimeoutSeconds,
        streamIdleTimeoutSeconds
      },
      tools: [],
      maxIterations: 1,
      forceApproval: false
    },
    jobId: runId,
    idempotencyKey: runId
  })
  assert.equal(submission.accepted, true)
  const result = await waitForTerminal(client, runId, 6_000, async () => {
    const ping = await client.request('worker/ping', {}, 2_000)
    assert.equal(ping.ok, true)
  })
  assert.equal(result.state, 'failed')
  assert.equal(result.errorCode, 'timeout')
  assert.match(result.error, expectedError)
}

async function verifyProviderStatusPolicy(
  client,
  { baseUrl, fixture, shouldRetry, providerType = 'openai-chat' }
) {
  const runId = randomUUID()
  const submission = await client.request('jobs/submit', {
    method: 'agent/run',
    params: {
      runId,
      sessionId: `provider-status-${runId}`,
      messages: [
        {
          id: `message-${runId}`,
          role: 'user',
          content: 'provider status retry verification',
          createdAt: Date.now()
        }
      ],
      provider: {
        type: providerType,
        apiKey: 'test-key',
        baseUrl,
        model: 'provider-status-smoke',
        requestTimeoutSeconds: 2,
        streamIdleTimeoutSeconds: 2
      },
      tools: [],
      maxIterations: 1,
      forceApproval: false
    },
    jobId: runId,
    idempotencyKey: runId
  })
  assert.equal(submission.accepted, true)
  const result = await waitForTerminal(client, runId, 6_000)
  assert.equal(result.state, shouldRetry ? 'succeeded' : 'failed')
  assert.equal(providerRequestCounts.get(fixture), shouldRetry ? 2 : 1)
}

const hostId = `verify-${process.pid}-${randomUUID().replaceAll('-', '')}`

let worker
let recoveryWorker
try {
  worker = await startWorkerOverHttp({
    command: 'dotnet',
    commandArgs: [workerDll],
    hostId,
    cwd: process.cwd(),
    env: {
      OPEN_COWORK_RUNTIME_DB_PATH: join(tempDirectory, 'runtime.db'),
      OPEN_COWORK_NATIVE_RETRY_TRANSPORT: '0'
    }
  })
  answerReverseRequests(worker)
  await worker.attachReverse()
  // Simulate a UI that stops draining progress events. Attaching first and then
  // stalling is what makes the worker buffer for a consumer that is present but
  // not reading; requests and reverse RPC ride their own connections and must be
  // unaffected.
  await worker.attachEvents()
  worker.pauseEvents()
  const client = worker

  const hello = await client.request('worker/hello')
  assert.equal(hello.protocolVersion, 2)
  const routes = await client.request('worker/routes')
  const descriptors = new Map(routes.routes.map((route) => [route.method, route]))
  assert.equal(descriptors.get('agent/run')?.resultMode, 'accepted')
  assert.equal(descriptors.get('agent/compress-context')?.executionMode, 'job')
  assert.equal(descriptors.get('shell/exec')?.executionMode, 'job')
  const directJobResult = await client.request('agent/run', {
    runId: randomUUID(),
    sessionId: 'direct-job-rejected'
  })
  assert.match(directJobResult.error, /must be submitted through jobs\/submit/u)

  const mismatchedRunId = randomUUID()
  const mismatchedAgentSubmission = await client.request('jobs/submit', {
    method: 'agent/run',
    params: { runId: mismatchedRunId },
    jobId: randomUUID()
  })
  assert.equal(mismatchedAgentSubmission.accepted, false)
  assert.match(mismatchedAgentSubmission.error, /jobId to match params\.runId/u)

  const fileJobId = randomUUID()
  const firstSubmission = await client.request('jobs/submit', {
    method: 'fs/read-document',
    params: { path: resolve('package.json') },
    jobId: fileJobId,
    idempotencyKey: fileJobId
  })
  assert.equal(firstSubmission.accepted, true)
  assert.equal(firstSubmission.state, 'queued')
  const duplicateSubmission = await client.request('jobs/submit', {
    method: 'fs/read-document',
    params: { path: resolve('package.json') },
    jobId: fileJobId,
    idempotencyKey: fileJobId
  })
  assert.equal(duplicateSubmission.duplicate, true)
  const fileResult = await waitForTerminal(client, fileJobId)
  assert.equal(fileResult.state, 'succeeded')
  assert.match(fileResult.result.content, /"name"\s*:\s*"open-cowork"/u)

  // Context compression is itself a Provider call. It must execute through the
  // durable queue, and its private summarizer deltas must not target the Agent
  // outbox because the synthetic compression run is not a standalone Job.
  const compressionJobId = randomUUID()
  const compressionSubmission = await client.request('jobs/submit', {
    method: 'agent/compress-context',
    params: {
      sessionId: `compression-${compressionJobId}`,
      messages: [
        {
          id: `compression-message-${compressionJobId}`,
          role: 'user',
          content: 'Remember that durable compression is covered by the Job queue.',
          createdAt: Date.now()
        }
      ],
      provider: {
        type: 'openai-chat',
        apiKey: 'test-key',
        baseUrl: compressionProviderBaseUrl,
        model: 'compression-job-smoke',
        requestTimeoutSeconds: 2,
        streamIdleTimeoutSeconds: 2
      },
      preTokens: 100,
      preserveCount: 0,
      trigger: 'manual'
    },
    jobId: compressionJobId,
    idempotencyKey: compressionJobId
  })
  assert.equal(compressionSubmission.accepted, true)
  const compressionResult = await waitForTerminal(client, compressionJobId, 6_000)
  assert.equal(compressionResult.state, 'succeeded')
  assert.equal(compressionResult.result.result.compressed, true)
  assert.match(JSON.stringify(compressionResult.result.messages), /Durable compression summary/u)

  const streamJobId = randomUUID()
  const nodeCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
    "process.stdout.write('x'.repeat(8 * 1024 * 1024))"
  )}`
  const streamSubmission = await client.request('jobs/submit', {
    method: 'shell/exec',
    params: {
      command: nodeCommand,
      cwd: process.cwd(),
      execId: streamJobId,
      sessionId: `stream-${streamJobId}`,
      timeout: 15_000
    },
    jobId: streamJobId,
    idempotencyKey: streamJobId
  })
  assert.equal(streamSubmission.accepted, true)
  let pingCount = 0
  const streamResult = await waitForTerminal(client, streamJobId, 20_000, async () => {
    const ping = await client.request('worker/ping', {}, 2_000)
    assert.equal(ping.ok, true)
    pingCount += 1
  })
  assert.equal(streamResult.state, 'succeeded')
  assert.ok(pingCount > 0)

  // A deep backlog in one active session must not hide another session behind
  // the scheduler's SQLite scan limit.
  const fairnessSession = `fairness-a-${randomUUID()}`
  const fairnessBlockerId = randomUUID()
  const laneBlockCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
    'setTimeout(() => {}, 30000)'
  )}`
  await client.request('jobs/submit', {
    method: 'shell/exec',
    params: {
      command: laneBlockCommand,
      cwd: process.cwd(),
      sessionId: fairnessSession,
      timeout: 35_000
    },
    jobId: fairnessBlockerId,
    idempotencyKey: fairnessBlockerId
  })
  const fairnessRunningDeadline = Date.now() + 5_000
  while (true) {
    const status = await client.request('jobs/status', { jobId: fairnessBlockerId })
    if (status.state === 'running') break
    if (Date.now() >= fairnessRunningDeadline) throw new Error('Fairness fixture did not start')
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30))
  }

  const sameLaneBacklog = []
  for (let index = 0; index < 128; index += 1) {
    const jobId = randomUUID()
    sameLaneBacklog.push(jobId)
    await client.request('jobs/submit', {
      method: 'fs/read-document',
      params: { path: resolve('package.json'), sessionId: fairnessSession },
      jobId,
      idempotencyKey: jobId
    })
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 5))
  const otherLaneJobId = randomUUID()
  await client.request('jobs/submit', {
    method: 'fs/read-document',
    params: { path: resolve('package.json'), sessionId: `fairness-b-${randomUUID()}` },
    jobId: otherLaneJobId,
    idempotencyKey: otherLaneJobId
  })
  const otherLaneResult = await waitForTerminal(client, otherLaneJobId, 3_000)
  assert.equal(otherLaneResult.state, 'succeeded')

  for (const jobId of sameLaneBacklog) {
    const cancelled = await client.request('jobs/cancel', { jobId })
    assert.equal(cancelled.state, 'cancelled')
  }
  await client.request('jobs/cancel', { jobId: fairnessBlockerId })
  const fairnessBlockerResult = await waitForTerminal(client, fairnessBlockerId, 5_000)
  assert.equal(fairnessBlockerResult.state, 'cancelled')

  const recoveryLane = `recovery-${randomUUID()}`
  const interruptedJobId = randomUUID()
  const queuedJobId = randomUUID()
  const waitCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
    'setTimeout(() => {}, 5000)'
  )}`
  await client.request('jobs/submit', {
    method: 'shell/exec',
    params: {
      command: waitCommand,
      cwd: process.cwd(),
      sessionId: recoveryLane,
      timeout: 15_000
    },
    jobId: interruptedJobId,
    idempotencyKey: interruptedJobId
  })
  const runningDeadline = Date.now() + 5_000
  while (true) {
    const status = await client.request('jobs/status', { jobId: interruptedJobId })
    if (status.state === 'running') break
    if (Date.now() >= runningDeadline) throw new Error('Recovery fixture did not start')
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30))
  }
  await client.request('jobs/submit', {
    method: 'fs/read-document',
    params: { path: resolve('package.json'), sessionId: recoveryLane },
    jobId: queuedJobId,
    idempotencyKey: queuedJobId
  })
  const queuedBeforeCrash = await client.request('jobs/status', { jobId: queuedJobId })
  assert.equal(queuedBeforeCrash.state, 'queued')

  // SIGKILL the worker with jobs still in flight; the replacement must recover
  // them from the durable store.
  worker.child.kill('SIGKILL')
  await new Promise((resolveExit) => worker.child.once('exit', resolveExit))
  await worker.close()
  worker = undefined

  recoveryWorker = await startWorkerOverHttp({
    command: 'dotnet',
    commandArgs: [workerDll],
    hostId,
    cwd: process.cwd(),
    env: {
      OPEN_COWORK_RUNTIME_DB_PATH: join(tempDirectory, 'runtime.db'),
      OPEN_COWORK_NATIVE_RETRY_TRANSPORT: '0',
      OPEN_COWORK_NATIVE_RETRY_TIMEOUT_ATTEMPTS: '2'
    }
  })
  answerReverseRequests(recoveryWorker)
  await recoveryWorker.attachReverse()
  await recoveryWorker.attachEvents()
  const recoveryClient = recoveryWorker
  await recoveryClient.request('worker/hello')
  const interruptedResult = await waitForTerminal(recoveryClient, interruptedJobId)
  assert.equal(interruptedResult.state, 'failed')
  assert.equal(interruptedResult.errorCode, 'worker_interrupted')
  const recoveredQueuedResult = await waitForTerminal(recoveryClient, queuedJobId)
  assert.equal(recoveredQueuedResult.state, 'succeeded')

  // Persist more Agent envelopes than the 32-batch unacked send window while the
  // event stream is not being drained. Jobs must still finish, and reattach +
  // replay + ACK must deliver every terminal envelope without disturbing requests.
  const replayConsumerId = `verify-replay-${randomUUID()}`
  await recoveryClient.request('events/subscribe', {
    consumerId: replayConsumerId,
    limit: 4096
  })
  // The subscription names a new consumer, so the stream has to move to that
  // consumer's lane; the pump delivers to the lane the subscription named.
  recoveryWorker.detachEvents()
  await recoveryWorker.attachEvents(replayConsumerId)
  recoveryWorker.pauseEvents()
  const replayRunIds = Array.from({ length: 12 }, () => randomUUID())
  for (const runId of replayRunIds) {
    const submission = await recoveryClient.request('jobs/submit', {
      method: 'agent/run',
      params: {
        runId,
        sessionId: `replay-${runId}`,
        messages: [
          {
            id: `message-${runId}`,
            role: 'user',
            content: 'durable event replay verification',
            createdAt: Date.now()
          }
        ],
        provider: {
          type: 'openai-chat',
          apiKey: 'test-key',
          baseUrl: providerBaseUrl,
          model: 'durable-replay-smoke',
          requestTimeoutSeconds: 2,
          streamIdleTimeoutSeconds: 2
        },
        tools: [],
        maxIterations: 1,
        forceApproval: false
      },
      jobId: runId,
      idempotencyKey: runId
    })
    assert.equal(submission.accepted, true)
  }
  const replayJobs = await waitForAllTerminal(recoveryClient, replayRunIds, 20_000)
  assert.equal(replayJobs.length, replayRunIds.length)
  assert.ok(replayJobs.every((job) => job.state === 'failed'))

  // Everything above was persisted while this consumer was not reading. Resuming
  // must deliver all of it: there is no acknowledgement window to exhaust any
  // more, so the property under test is completeness rather than a cap.
  const replayed = collectAgentTerminals(recoveryWorker, replayRunIds, (jobId, throughSeq) => {
    void recoveryClient
      .request('events/checkpoint', { consumerId: replayConsumerId, jobId, throughSeq })
      .catch(() => {})
  })
  recoveryWorker.resumeEvents()
  // events/replay is the explicit nudge a reconnecting consumer sends; it is a
  // safety net here because the pump also wakes on its own once the lane drains.
  await recoveryClient.request('events/replay', {
    consumerId: replayConsumerId,
    limit: 4096
  })
  // collectAgentTerminals refuses to advance across a sequence gap, so reaching
  // every run's terminal envelope proves the backlog arrived complete and ordered.
  const replayResult = await replayed
  assert.equal(replayResult.terminal, replayRunIds.length)
  assert.ok(replayResult.seen >= replayRunIds.length)
  const replayPing = await recoveryClient.request('worker/ping', {}, 2_000)
  assert.equal(replayPing.ok, true)

  // Response-header timeouts are safe to replay before any event reaches the UI. Exhausting the
  // retry budget must still fail only the background Job while Control remains responsive.
  await verifyProviderTimeout(recoveryClient, {
    baseUrl: stalledHeadersBaseUrl,
    requestTimeoutSeconds: 1,
    streamIdleTimeoutSeconds: 2,
    expectedError: /did not return response headers/u
  })
  assert.equal(providerRequestCounts.get('headers-stall'), 3)

  // Stream-idle timeouts may happen after visible output and are therefore never replayed.
  await verifyProviderTimeout(recoveryClient, {
    baseUrl: stalledStreamBaseUrl,
    requestTimeoutSeconds: 2,
    streamIdleTimeoutSeconds: 1,
    expectedError: /stream produced no data/u
  })
  await verifyProviderTimeout(recoveryClient, {
    baseUrl: stalledProviderBaseUrl,
    requestTimeoutSeconds: 2,
    streamIdleTimeoutSeconds: 1,
    expectedError: /error response body did not finish/u
  })

  const rejectedRunId = randomUUID()
  const rejectedEvents = collectAgentTerminals(
    recoveryWorker,
    [rejectedRunId],
    (jobId, throughSeq) => {
      void recoveryClient
        .request('events/checkpoint', { consumerId: replayConsumerId, jobId, throughSeq })
        .catch(() => {})
    }
  )
  await recoveryClient.request('jobs/submit', {
    method: 'agent/run',
    params: {
      runId: rejectedRunId,
      sessionId: `rejected-${rejectedRunId}`,
      runtimeProtocolVersion: 2,
      messages: [],
      provider: {
        type: 'openai-chat',
        apiKey: 'test-key',
        baseUrl: providerBaseUrl,
        model: 'preflight-rejection-smoke'
      },
      tools: []
    },
    jobId: rejectedRunId,
    idempotencyKey: rejectedRunId
  })
  const rejectedResult = await waitForTerminal(recoveryClient, rejectedRunId, 5_000)
  assert.equal(rejectedResult.state, 'failed')
  assert.match(rejectedResult.error, /requires a capabilitySnapshot/u)
  const rejectedEventResult = await rejectedEvents
  assert.equal(rejectedEventResult.terminal, 1)

  // Transient statuses recover, while parameter-shaped 4xx responses fail immediately. Keep
  // these last because the fixtures intentionally inspect Jobs without consuming their events.
  for (const [statusCode, baseUrl] of retryStatusBaseUrls) {
    await verifyProviderStatusPolicy(recoveryClient, {
      baseUrl,
      fixture: `retry-${statusCode}`,
      shouldRetry: true
    })
  }
  await verifyProviderStatusPolicy(recoveryClient, {
    baseUrl: noRetry400BaseUrl,
    fixture: 'no-retry-400',
    shouldRetry: false
  })
  await verifyProviderStatusPolicy(recoveryClient, {
    baseUrl: responsesStreamOverloadBaseUrl,
    fixture: 'responses-stream-overload',
    shouldRetry: true,
    providerType: 'openai-responses'
  })

  console.log('Native Worker durable Job + split HTTP stream verification passed.')
} finally {
  const failedWorker = [worker, recoveryWorker].find(
    (candidate) => candidate?.child.exitCode && candidate.child.exitCode !== 0
  )
  const stderrTail = failedWorker?.stderrTail?.join('\n')
  await worker?.close()
  await recoveryWorker?.close()
  providerServer.close()
  rmSync(tempDirectory, { recursive: true, force: true })
  if (stderrTail) {
    console.error(stderrTail)
  }
}
