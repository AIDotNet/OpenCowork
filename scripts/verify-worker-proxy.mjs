/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { startWorkerOverHttp } from './lib/worker-http-harness.mjs'

const workerDll = resolve(
  'sidecars/OpenCowork.Native.Worker/bin/Debug/net11.0/OpenCowork.Native.Worker.dll'
)

// A host that can never resolve, so "went direct" and "went through the proxy" are
// unambiguously distinguishable: direct fails at DNS, proxied reaches this server.
const UNRESOLVABLE_BASE_URL = 'http://provider.invalid/v1'

const proxyHits = []
const proxyServer = createServer((request, response) => {
  proxyHits.push(request.url)
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    [
      'data: {"choices":[{"delta":{"content":"through the proxy"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n'
    ].join('')
  )
})
await new Promise((done) => proxyServer.listen(0, '127.0.0.1', done))
const proxyUrl = `http://127.0.0.1:${proxyServer.address().port}`

const worker = await startWorkerOverHttp({
  command: 'dotnet',
  commandArgs: [workerDll],
  // Prove the pushed override wins over an environment proxy rather than merely
  // filling a gap: point the environment at a port nothing is listening on.
  env: { HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' }
})

async function runAgentTurn() {
  const runId = randomUUID()
  const submission = await worker.request('jobs/submit', {
    method: 'agent/run',
    params: {
      runId,
      sessionId: `proxy-${runId}`,
      messages: [
        { id: `m-${runId}`, role: 'user', content: 'proxy verification', createdAt: Date.now() }
      ],
      provider: {
        type: 'openai-chat',
        apiKey: 'test-key',
        baseUrl: UNRESOLVABLE_BASE_URL,
        model: 'proxy-smoke',
        requestTimeoutSeconds: 5
      },
      tools: [],
      maxIterations: 1,
      forceApproval: false
    },
    jobId: runId,
    idempotencyKey: runId
  })
  assert.equal(submission.accepted, true)
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const result = await worker.request('jobs/result', { jobId: runId })
    if (result?.state && result.state !== 'running' && result.state !== 'queued') return result
    await new Promise((done) => setTimeout(done, 150))
  }
  throw new Error('agent run never reached a terminal state')
}

try {
  const routes = await worker.request('worker/routes', {})
  const methods = routes.methods ?? routes.Methods ?? []
  assert.ok(methods.includes('network/set-proxy'), 'network/set-proxy should be registered')
  console.log('✓ network/set-proxy is registered')

  const applied = await worker.request('network/set-proxy', { url: proxyUrl, bypass: [] })
  assert.equal(applied.success, true)
  assert.match(applied.proxy, /^http:\/\/127\.0\.0\.1:\d+$/)
  console.log(`✓ proxy accepted: ${applied.proxy}`)

  const proxied = await runAgentTurn()
  assert.equal(proxied.state, 'succeeded', `expected success, got ${JSON.stringify(proxied)}`)
  assert.equal(proxyHits.length, 1, `proxy should have seen exactly one request: ${proxyHits}`)
  assert.equal(proxyHits[0], 'http://provider.invalid/v1/chat/completions')
  console.log(`✓ provider request reached the proxy as ${proxyHits[0]}`)

  await worker.request('network/set-proxy', { url: proxyUrl, bypass: ['provider.invalid'] })
  const bypassed = await runAgentTurn()
  assert.equal(bypassed.state, 'failed')
  assert.equal(proxyHits.length, 1, 'a bypassed host must not reach the proxy')
  console.log(`✓ bypass honoured (run failed with: ${bypassed.errorCode})`)

  await worker.request('network/set-proxy', { url: '', bypass: [] })
  const cleared = await runAgentTurn()
  assert.equal(cleared.state, 'failed')
  assert.equal(proxyHits.length, 1, 'clearing the override must not fall back to the proxy')
  console.log('✓ clearing the override hands resolution back to the environment')

  console.log('\nNative worker proxy verification passed.')
} finally {
  await worker.close?.()
  proxyServer.close()
}
