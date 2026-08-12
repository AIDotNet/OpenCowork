// One-shot smoke test for the Worker session-host routes (agent/session-open/close).
// Usage: node cli/scripts/smoke-session-host.mjs <worker-path>
import { NativeWorkerClient } from '../dist/runtime/native-worker-client.js'

const workerPath = process.argv[2]
const client = new NativeWorkerClient({ appVersion: '0.0.0-smoke', workerPath })

try {
  const capability = await client.request(
    'capabilities/check',
    { capability: 'agent.session-host' },
    30_000
  )
  console.log('capability agent.session-host:', JSON.stringify(capability))

  const opened = await client.request(
    'agent/session-open',
    {
      sessionId: 'smoke-session-1',
      provider: { type: 'openai-chat', apiKey: 'smoke', model: 'smoke-model' },
      workingFolder: process.cwd(),
      messages: [{ role: 'user', content: 'hello' }]
    },
    30_000
  )
  console.log('session-open:', JSON.stringify(opened))

  const closed = await client.request('agent/session-close', { sessionId: 'smoke-session-1' }, 30_000)
  console.log('session-close:', JSON.stringify(closed))

  const closedAgain = await client.request(
    'agent/session-close',
    { sessionId: 'smoke-session-1' },
    30_000
  )
  console.log('session-close (again):', JSON.stringify(closedAgain))

  let sendError = ''
  try {
    await client.request(
      'agent/session-send',
      { sessionId: 'smoke-session-1', runId: 'smoke-run-1', messages: [] },
      30_000
    )
  } catch (error) {
    sendError = error instanceof Error ? error.message : String(error)
  }
  console.log('session-send on closed session rejected:', JSON.stringify(sendError))
} finally {
  await client.stop()
}
