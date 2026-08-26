import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectWorkerJobRoutes,
  submitAndAwaitWorkerJob
} from '../../src/renderer/src/lib/runtime/worker-http-client.ts'

test('collectWorkerJobRoutes keeps only job descriptors', () => {
  const routes = collectWorkerJobRoutes({
    methods: ['worker/hello', 'openai-images/generate', 'jobs/submit'],
    routes: [
      { method: 'worker/hello', executionMode: 'inline', resultMode: 'direct' },
      { method: 'openai-images/generate', executionMode: 'job', resultMode: 'result' },
      { method: 'agent/run', executionMode: 'job', resultMode: 'accepted' },
      { method: 'broken', executionMode: 'job' }
    ]
  })

  assert.deepEqual([...routes.keys()], ['openai-images/generate', 'agent/run'])
  assert.equal(routes.get('openai-images/generate')?.resultMode, 'result')
  assert.equal(routes.get('agent/run')?.resultMode, 'accepted')
})

test('submitAndAwaitWorkerJob submits openai-images/generate through jobs/submit', async () => {
  const calls: Array<{ method: string; params: unknown }> = []
  const result = await submitAndAwaitWorkerJob<{ images: Array<{ data: string }> }>({
    method: 'openai-images/generate',
    params: { prompt: 'a whale poster' },
    resultMode: 'result',
    timeoutMs: 5_000,
    createJobId: () => 'job-images-1',
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'jobs/submit') {
        return { accepted: true, jobId: 'job-images-1', state: 'queued' }
      }
      if (method === 'jobs/result') {
        return {
          found: true,
          state: 'succeeded',
          result: { images: [{ data: 'base64-png' }] }
        }
      }
      throw new Error(`unexpected method ${method}`)
    }
  })

  assert.deepEqual(
    calls.map((call) => call.method),
    ['jobs/submit', 'jobs/result']
  )
  const submit = calls[0]?.params as {
    method?: string
    jobId?: string
    params?: { prompt?: string }
  }
  assert.equal(submit.method, 'openai-images/generate')
  assert.equal(submit.jobId, 'job-images-1')
  assert.equal(submit.params?.prompt, 'a whale poster')
  assert.deepEqual(result, { images: [{ data: 'base64-png' }] })
})

test('submitAndAwaitWorkerJob returns accepted jobs without polling', async () => {
  const methods: string[] = []
  const result = await submitAndAwaitWorkerJob<{
    started: boolean
    jobId: string
    runId: string
  }>({
    method: 'agent/run',
    params: { runId: 'run-1' },
    resultMode: 'accepted',
    timeoutMs: 5_000,
    request: async (method, params) => {
      methods.push(method)
      if (method === 'jobs/submit') {
        const body = params as { jobId?: string }
        return { accepted: true, jobId: body.jobId, runId: body.jobId, state: 'queued' }
      }
      throw new Error(`unexpected method ${method}`)
    }
  })

  assert.deepEqual(methods, ['jobs/submit'])
  assert.equal(result.started, true)
  assert.equal(result.jobId, 'run-1')
  assert.equal(result.runId, 'run-1')
})

test('submitAndAwaitWorkerJob surfaces a failed image job', async () => {
  await assert.rejects(
    () =>
      submitAndAwaitWorkerJob({
        method: 'openai-images/generate',
        params: { prompt: 'nope' },
        resultMode: 'result',
        timeoutMs: 5_000,
        createJobId: () => 'job-fail',
        request: async (method) => {
          if (method === 'jobs/submit') {
            return { accepted: true, jobId: 'job-fail', state: 'queued' }
          }
          return {
            found: true,
            state: 'failed',
            errorCode: 'provider_error',
            error: 'upstream 401'
          }
        }
      }),
    /provider_error: upstream 401/
  )
})

test('submitAndAwaitWorkerJob times out without cancelling the committed job', async () => {
  let now = 0
  await assert.rejects(
    () =>
      submitAndAwaitWorkerJob({
        method: 'openai-images/generate',
        params: { prompt: 'slow' },
        resultMode: 'result',
        timeoutMs: 250,
        createJobId: () => 'job-slow',
        now: () => now,
        sleep: async (ms) => {
          now += ms
        },
        request: async (method) => {
          if (method === 'jobs/submit') {
            return { accepted: true, jobId: 'job-slow', state: 'queued' }
          }
          return { found: true, state: 'running' }
        }
      }),
    /Background Job wait timed out: openai-images\/generate/
  )
})
