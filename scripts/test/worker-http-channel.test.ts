/**
 * Integration test for the Native Worker HTTP channel against the real worker binary.
 *
 * This is the transport that replaced the length-prefixed MessagePack dual-socket
 * protocol, so the properties worth proving are the ones the socket protocol used
 * to guarantee for free: the worker's port is discoverable, request/response
 * correlates, handler errors stay inside `result`, the event stream stays attached,
 * and every frame reaches the supervisor already parsed.
 *
 * Skips itself when the worker binary has not been published.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { after, describe, it } from 'node:test'
import { WorkerHttpChannel } from '../../src/shared/worker-http-channel'
import { DESKTOP_EVENT_CONSUMER_ID } from '../../src/shared/worker-event-consumers'
import {
  requestWorkerAt,
  WorkerUnavailableError
} from '../../src/renderer/src/lib/runtime/worker-http-client'

const repoRoot = path.resolve(import.meta.dirname, '../..')

function resolveWorkerBinary(): string | null {
  const candidates = [
    process.env.OPEN_COWORK_NATIVE_WORKER_PATH,
    path.join(repoRoot, 'resources/native-worker/OpenCowork.Native.Worker'),
    path.join(
      repoRoot,
      'sidecars/OpenCowork.Native.Worker/bin/Release/net11.0/osx-arm64/publish/OpenCowork.Native.Worker'
    )
  ].filter((candidate): candidate is string => typeof candidate === 'string')
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

interface ReceivedFrame {
  source: 'control' | 'event'
  envelope: Record<string, unknown>
}

const workerBinary = resolveWorkerBinary()

describe('native worker HTTP channel', { skip: workerBinary === null }, () => {
  const binary = workerBinary as string
  const frames: ReceivedFrame[] = []
  const eventDisconnects: string[] = []
  let child: ChildProcess | null = null
  let channel: WorkerHttpChannel | null = null
  let workerToken = ''

  after(async () => {
    channel?.dispose()
    child?.kill()
    // Give the worker a moment to exit so it does not outlive the test run.
    await new Promise((resolve) => setTimeout(resolve, 200))
  })

  it('discovers the published port and answers worker/hello', async () => {
    channel = new WorkerHttpChannel({
      consumerId: 'http-channel-test',
      isActive: () => true,
      hooks: {
        onFrame: (frame, source) => {
          frames.push({ source, envelope: frame as Record<string, unknown> })
        },
        onControlFailure: () => undefined,
        onEventDisconnected: (error) => eventDisconnects.push(error.message),
        onEventReconnected: () => undefined
      }
    })

    const args = channel.spawnArgs('http-channel-test')
    assert.equal(args[0], '--http-token')
    assert.equal(args.length, 4)
    workerToken = args[1]

    child = spawn(binary, args, {
      cwd: path.dirname(binary),
      env: { ...process.env, OPEN_COWORK_APP_VERSION: '0.0.0-test' },
      // stdout must be piped: the worker publishes its chosen port there.
      stdio: ['ignore', 'pipe', 'pipe']
    })
    // A worker that refuses these flags exits before publishing a port; its
    // stderr is the only thing that says why.
    const stderr: string[] = []
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')))

    try {
      await channel.connect(child)
    } catch (error) {
      assert.fail(
        `${(error as Error).message}\nworker binary: ${binary}\nworker stderr:\n${stderr.join('')}`
      )
    }
    assert.match(channel.endpoint ?? '', /^http:\/\/127\.0\.0\.1:\d+$/)

    await channel.send(1, 'worker/hello', {})
    const hello = frames.find((frame) => frame.envelope.id === 1)
    assert.ok(hello, 'worker/hello produced no frame')
    assert.equal(hello.source, 'control')
    const helloResult = hello.envelope.result as Record<string, unknown>
    assert.equal(helloResult.ok, true)
    assert.equal(typeof helloResult.protocolVersion, 'number')
  })

  it('rejects a request signed with the wrong token', async () => {
    // A second channel mints its own token, so the running worker must refuse it.
    const foreign = new WorkerHttpChannel({
      consumerId: 'http-channel-test-foreign',
      isActive: () => false,
      hooks: {
        onFrame: () => undefined,
        onControlFailure: () => undefined,
        onEventDisconnected: () => undefined,
        onEventReconnected: () => undefined
      }
    })
    foreign.spawnArgs('http-channel-test-foreign')
    // Point it at the live worker without going through connect().
    const live = channel as WorkerHttpChannel
    Object.assign(foreign as unknown as Record<string, unknown>, {
      baseUrl: live.endpoint
    })

    await assert.rejects(() => foreign.send(99, 'worker/hello', {}), /HTTP 401/)
    foreign.dispose()
  })

  it('keeps handler errors inside result rather than the HTTP status', async () => {
    const live = channel as WorkerHttpChannel
    await live.send(2, 'definitely/not/a/route', {})
    const failure = frames.find((frame) => frame.envelope.id === 2)
    assert.ok(failure, 'unknown method produced no frame')
    const result = failure.envelope.result as Record<string, unknown>
    assert.match(String(result.error), /Unsupported method/)
  })

  it('refuses to run a job route inline, as the frame protocol did', async () => {
    const live = channel as WorkerHttpChannel
    await live.send(3, 'agent/run', {})
    const rejected = frames.find((frame) => frame.envelope.id === 3)
    assert.ok(rejected, 'agent/run produced no frame')
    const result = rejected.envelope.result as Record<string, unknown>
    assert.match(String(result.error), /jobs\/submit/)
  })

  it('reports the full route catalog', async () => {
    const live = channel as WorkerHttpChannel
    await live.send(4, 'worker/routes', {})
    const routes = frames.find((frame) => frame.envelope.id === 4)
    assert.ok(routes, 'worker/routes produced no frame')
    const result = routes.envelope.result as { routes?: unknown[] }
    assert.ok(Array.isArray(result.routes))
    assert.ok(result.routes.length > 300, `expected a full catalog, saw ${result.routes.length}`)
  })

  it('holds both streams open without reporting a disconnect', async () => {
    const live = channel as WorkerHttpChannel
    assert.equal(live.isEventStreamConnected, true)
    // Reverse RPC gets its own connection so a stalled output consumer cannot
    // block an approval or a hook the run is waiting on.
    assert.equal(live.isReverseStreamConnected, true)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    assert.deepEqual(eventDisconnects, [])
    assert.equal(live.isEventStreamConnected, true)
    assert.equal(live.isReverseStreamConnected, true)
  })

  it('reports both streams as attached on /health', async () => {
    const live = channel as WorkerHttpChannel
    await live.send(5, 'worker/hello', {})
    const health = await fetch(`${live.endpoint}/health`, {
      headers: { Authorization: `Bearer ${workerToken}` }
    })
    const body = (await health.json()) as Record<string, unknown>
    assert.equal(body.eventStreamAttached, true)
    assert.equal(body.reverseStreamAttached, true)
  })

  it('answers a browser preflight without requiring the token', async () => {
    const live = channel as WorkerHttpChannel
    // A preflight never carries Authorization, so authenticating it would reject
    // every cross-origin call the renderer makes before the real request is sent.
    const response = await fetch(`${live.endpoint}/rpc`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type'
      }
    })
    assert.equal(response.status, 204)
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173')
    assert.match(response.headers.get('access-control-allow-headers') ?? '', /Authorization/iu)
  })

  it('allows the opaque origin a packaged file:// renderer sends', async () => {
    const live = channel as WorkerHttpChannel
    const response = await fetch(`${live.endpoint}/rpc`, {
      method: 'OPTIONS',
      headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST' }
    })
    assert.equal(response.status, 204)
    assert.equal(response.headers.get('access-control-allow-origin'), 'null')
  })

  it('refuses a preflight from a non-loopback origin', async () => {
    const live = channel as WorkerHttpChannel
    // The token is the real gate, but an arbitrary site should not even be told
    // it is allowed to try.
    const response = await fetch(`${live.endpoint}/rpc`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' }
    })
    assert.equal(response.status, 403)
    assert.equal(response.headers.get('access-control-allow-origin'), null)
  })

  it('rejects an event stream that names no consumer', async () => {
    const live = channel as WorkerHttpChannel
    // Defaulting the id would let two clients collide on one lane and stall one
    // of them, which is the failure the per-consumer split exists to prevent.
    const response = await fetch(`${live.endpoint}/events`, {
      headers: { Authorization: `Bearer ${workerToken}`, Accept: 'text/event-stream' }
    })
    assert.equal(response.status, 400)
    await response.body?.cancel()
  })

  it('serves a second consumer its own stream instead of a 409', async () => {
    const live = channel as WorkerHttpChannel
    // The renderer and the host are independent consumers of one worker; the
    // second to attach must not be turned away the way a shared lane did.
    const abort = new AbortController()
    try {
      const second = await fetch(`${live.endpoint}/events?consumerId=second-consumer`, {
        headers: { Authorization: `Bearer ${workerToken}`, Accept: 'text/event-stream' },
        signal: abort.signal
      })
      assert.equal(second.status, 200)

      const health = await fetch(`${live.endpoint}/health`, {
        headers: { Authorization: `Bearer ${workerToken}` }
      })
      const body = (await health.json()) as { consumers?: { consumerId: string }[] }
      const ids = (body.consumers ?? []).map((entry) => entry.consumerId).sort()
      assert.deepEqual(ids, ['http-channel-test', 'second-consumer'])
    } finally {
      abort.abort()
    }
  })

  it('attaches and subscribes the desktop host under one consumer id', async () => {
    // The desktop host's stream URL and its events/subscribe call have to name the
    // same consumer: the worker routes durable events to the lane the subscription
    // named, so a mismatch attaches successfully and then delivers nothing — the
    // desktop app would show no streamed output at all. Both sides read this
    // constant, and this asserts they still agree at runtime, not just at compile
    // time.
    const hostFrames: Record<string, unknown>[] = []
    const host = new WorkerHttpChannel({
      consumerId: DESKTOP_EVENT_CONSUMER_ID,
      isActive: () => true,
      hooks: {
        onFrame: (frame) => {
          hostFrames.push(frame as Record<string, unknown>)
        },
        onControlFailure: () => undefined,
        onEventDisconnected: () => undefined,
        onEventReconnected: () => undefined
      }
    })
    const hostArgs = host.spawnArgs('desktop-consumer-test')
    const hostChild = spawn(binary, hostArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    })

    try {
      await host.connect(hostChild)
      await host.send(1, 'events/subscribe', {
        consumerId: DESKTOP_EVENT_CONSUMER_ID,
        limit: 4096
      })
      const subscribe = hostFrames.find((frame) => frame.id === 1)?.result as
        | { subscribed?: boolean; published?: number; error?: string }
        | undefined
      assert.equal(subscribe?.error, undefined)
      assert.equal(subscribe?.subscribed, true)
      assert.equal(typeof subscribe?.published, 'number')

      const health = await fetch(`${host.endpoint}/health`, {
        headers: { Authorization: `Bearer ${hostArgs[1]}` }
      })
      const body = (await health.json()) as {
        consumers?: { consumerId: string; attached: boolean }[]
      }
      const desktop = (body.consumers ?? []).find(
        (entry) => entry.consumerId === DESKTOP_EVENT_CONSUMER_ID
      )
      assert.ok(desktop, `worker has no lane for '${DESKTOP_EVENT_CONSUMER_ID}'`)
      assert.equal(desktop.attached, true)
    } finally {
      host.dispose()
      hostChild.kill()
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  })

  // The renderer is a direct client of the same API, with its own request and
  // failure-mapping code rather than the supervisor's channel. These run that
  // module against the real worker; only the CORS handshake needs a browser.
  describe('renderer direct client', () => {
    it('reads a result out of the response envelope', async () => {
      const live = channel as WorkerHttpChannel
      const hello = await requestWorkerAt<{ protocolVersion?: number }>(
        { baseUrl: live.endpoint as string, token: workerToken },
        'worker/hello',
        {}
      )
      assert.equal(hello.protocolVersion, 2)
    })

    it('raises a handler error as a plain Error, not a transport failure', async () => {
      const live = channel as WorkerHttpChannel
      // The worker answers 200 with the error inside `result`, so treating this
      // as unavailable would send the renderer into a pointless worker restart.
      await assert.rejects(
        () =>
          requestWorkerAt(
            { baseUrl: live.endpoint as string, token: workerToken },
            'definitely/not-a-route',
            {}
          ),
        (error: unknown) => error instanceof Error && !(error instanceof WorkerUnavailableError)
      )
    })

    it('maps a rejected token to WorkerUnavailableError so the caller can recover', async () => {
      const live = channel as WorkerHttpChannel
      // A replaced worker is the real cause of a 401 here: the renderer cached an
      // endpoint from a process that is gone, and must re-ask the host.
      await assert.rejects(
        () =>
          requestWorkerAt(
            { baseUrl: live.endpoint as string, token: 'not-the-token' },
            'worker/hello',
            {}
          ),
        WorkerUnavailableError
      )
    })

    it('reports an unreachable endpoint as WorkerUnavailableError', async () => {
      await assert.rejects(
        () =>
          requestWorkerAt(
            { baseUrl: 'http://127.0.0.1:1', token: workerToken },
            'worker/hello',
            {}
          ),
        WorkerUnavailableError
      )
    })
  })

  it('ships no trace of the dual-socket protocol it replaced', () => {
    // The socket server is still source-linked from the CodeGraph submodule, so
    // "we deleted the branch in Program.Main" does not by itself mean the protocol
    // is gone from what users run — it means the trimmer had the chance to drop it.
    // Asserting on the binary is what makes the replacement real rather than
    // merely bypassed, and it fails loudly if anything ever makes that code
    // reachable again.
    const binaryBytes = readFileSync(binary).toString('latin1')
    for (const marker of ['--control-ipc', '--event-ipc', 'LocalIpcWorkerServer']) {
      assert.equal(
        binaryBytes.includes(marker),
        false,
        `published worker still contains '${marker}', so the socket transport is reachable`
      )
    }
  })

  it('refuses a duplicate attach for the same consumer', async () => {
    const live = channel as WorkerHttpChannel
    // Two readers of one consumer's lane would split its frames between them.
    const response = await fetch(`${live.endpoint}/events?consumerId=http-channel-test`, {
      headers: { Authorization: `Bearer ${workerToken}`, Accept: 'text/event-stream' }
    })
    assert.equal(response.status, 409)
    await response.body?.cancel()
  })
})
