/**
 * Spawns a Native Worker over its HTTP transport for verification harnesses.
 *
 * The harnesses used to each carry their own length-prefixed MessagePack client.
 * They now share this, which is both less code and a closer match to what the
 * worker actually speaks: the wire is JSON, so a harness reads exactly the bytes
 * the worker produced instead of a re-encoded copy.
 *
 * Deliberately not the production channel (`src/shared/worker-http-channel.ts`):
 * that one re-encodes every envelope as MessagePack for the run-frame journal,
 * which a harness would only have to undo.
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain Node script */
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

const READY_LINE_PREFIX = '__OPEN_COWORK_WORKER_HTTP__'
const READY_TIMEOUT_MS = 60_000
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

/**
 * Starts a worker and waits until it publishes its port.
 *
 * `command`/`commandArgs` exist because some harnesses run the managed DLL
 * through `dotnet` while others run a published native binary.
 */
export async function startWorkerOverHttp({
  command,
  commandArgs = [],
  hostId = `harness-${randomUUID()}`,
  env = {},
  cwd
} = {}) {
  if (!command) throw new Error('startWorkerOverHttp requires a command')

  const token = randomBytes(32).toString('hex')
  const child = spawn(command, [...commandArgs, '--http-token', token, '--host-id', hostId], {
    cwd,
    env: { ...process.env, ...env },
    // stdout must be piped: the worker publishes its chosen port there.
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const stderrTail = []
  child.stderr?.on('data', (chunk) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/u)) {
      if (line.trim()) stderrTail.push(line)
    }
    if (stderrTail.length > 60) stderrTail.splice(0, stderrTail.length - 60)
  })

  let port
  try {
    port = await readReadyPort(child)
  } catch (error) {
    child.kill()
    throw new Error(`${error.message}\nworker stderr:\n${stderrTail.join('\n')}`)
  }

  return new HarnessWorker({ child, port, token, hostId, stderrTail })
}

class HarnessWorker {
  constructor({ child, port, token, hostId, stderrTail }) {
    this.child = child
    this.port = port
    this.hostId = hostId
    this.baseUrl = `http://127.0.0.1:${port}`
    this.authorization = `Bearer ${token}`
    this.stderrTail = stderrTail
    this.events = new EventEmitter()
    this.nextId = 1
    this.eventAbort = null
    this.eventReady = null
    this.consumerId = hostId
    this.eventsPaused = false
    this.eventsResumed = Promise.resolve()
    this.markEventsResumed = null
    this.reverseAbort = null
    this.reverseReady = null
    this.closed = false
    // Harnesses attach listeners after start; an unhandled 'error' would kill
    // the run rather than fail an assertion.
    this.events.on('error', () => {})
  }

  /** Sends one request and returns its `result`. */
  async request(method, params = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const id = this.nextId++
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)
    try {
      const response = await fetch(`${this.baseUrl}/rpc`, {
        method: 'POST',
        headers: { Authorization: this.authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, method, params }),
        signal: abort.signal
      })
      if (!response.ok) {
        throw new Error(`Worker HTTP ${response.status} for ${method}: ${await response.text()}`)
      }
      const envelope = await response.json()
      return envelope.result
    } catch (error) {
      if (abort.signal.aborted) throw new Error(`Timed out: ${method}`)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Attaches the SSE stream. Each event is emitted twice: under its own name and
   * under `*`, so a harness can either target one event or watch everything.
   *
   * Resolves once the stream is established. Awaiting matters: the worker only
   * buffers live-only events for a consumer whose stream exists, so a request
   * issued before the attach landed would lose the events it produced.
   */
  attachEvents(consumerId = this.hostId) {
    if (this.eventAbort || this.closed) return this.eventReady ?? Promise.resolve()
    const abort = new AbortController()
    this.eventAbort = abort
    this.consumerId = consumerId
    let markReady
    this.eventReady = new Promise((resolve) => {
      markReady = resolve
    })
    void this.pumpEvents(abort, markReady)
    return this.eventReady
  }

  async pumpEvents(abort, markReady) {
    try {
      // Must be the same id the caller passes to events/subscribe: the worker
      // routes durable events to the lane named by the subscription, so a
      // mismatched stream attaches successfully and then receives nothing.
      const url = `${this.baseUrl}/events?consumerId=${encodeURIComponent(this.consumerId)}`
      const response = await fetch(url, {
        headers: { Authorization: this.authorization, Accept: 'text/event-stream' },
        signal: abort.signal
      })
      if (!response.ok || !response.body) {
        throw new Error(`Worker event stream returned HTTP ${response.status}`)
      }
      markReady?.()

      const reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffered = ''
      for (;;) {
        // Honouring the pause gate before reading is what makes this a real
        // stalled consumer: bytes stay unread, so the worker's queue fills and
        // its per-lane budget engages, exactly as a paused socket did.
        if (this.eventsPaused) await this.eventsResumed
        const { done, value } = await reader.read()
        if (done) return
        buffered += decoder.decode(value, { stream: true })
        let newlineAt = buffered.indexOf('\n')
        while (newlineAt >= 0) {
          const line = buffered.slice(0, newlineAt).replace(/\r$/u, '')
          buffered = buffered.slice(newlineAt + 1)
          this.consumeEventLine(line)
          newlineAt = buffered.indexOf('\n')
        }
      }
    } catch (error) {
      if (!abort.signal.aborted && !this.closed) {
        this.events.emit('error', error)
      }
    }
  }

  /**
   * Stops draining the event stream, standing in for a UI that has gone away
   * without detaching. Requests and reverse RPC ride separate connections, so
   * both must keep working while this is in effect.
   */
  pauseEvents() {
    if (this.eventsPaused) return
    this.eventsPaused = true
    this.eventsResumed = new Promise((resolve) => {
      this.markEventsResumed = resolve
    })
  }

  resumeEvents() {
    if (!this.eventsPaused) return
    this.eventsPaused = false
    this.markEventsResumed?.()
    this.markEventsResumed = null
  }

  /**
   * Drops the event stream entirely, freeing the consumer's lane so a later
   * attach can claim it — including under a different consumer id.
   */
  detachEvents() {
    this.resumeEvents()
    this.eventAbort?.abort()
    this.eventAbort = null
    this.eventReady = null
  }

  consumeEventLine(line) {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trimStart()
    if (!data) return
    let envelope
    try {
      envelope = JSON.parse(data)
    } catch {
      return
    }
    const name = typeof envelope?.event === 'string' ? envelope.event : null
    if (name) this.events.emit(name, envelope)
    this.events.emit('*', envelope)
  }

  on(eventName, listener) {
    this.events.on(eventName, listener)
    return () => this.events.off(eventName, listener)
  }

  /**
   * Attaches the reverse-RPC stream on its own connection, so it keeps delivering
   * while the event stream is paused. Emits `agent/reverse-request` like any other
   * event; the caller answers with `agent/reverse-response` over /rpc.
   */
  attachReverse() {
    if (this.reverseAbort || this.closed) return this.reverseReady ?? Promise.resolve()
    const abort = new AbortController()
    this.reverseAbort = abort
    let markReady
    this.reverseReady = new Promise((resolve) => {
      markReady = resolve
    })
    void this.pumpReverse(abort, markReady)
    return this.reverseReady
  }

  async pumpReverse(abort, markReady) {
    try {
      const response = await fetch(`${this.baseUrl}/reverse`, {
        headers: { Authorization: this.authorization, Accept: 'text/event-stream' },
        signal: abort.signal
      })
      if (!response.ok || !response.body) {
        throw new Error(`Worker reverse stream returned HTTP ${response.status}`)
      }
      markReady?.()

      const reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffered = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buffered += decoder.decode(value, { stream: true })
        let newlineAt = buffered.indexOf('\n')
        while (newlineAt >= 0) {
          const line = buffered.slice(0, newlineAt).replace(/\r$/u, '')
          buffered = buffered.slice(newlineAt + 1)
          this.consumeEventLine(line)
          newlineAt = buffered.indexOf('\n')
        }
      }
    } catch (error) {
      if (!abort.signal.aborted && !this.closed) {
        this.events.emit('error', error)
      }
    }
  }

  async close() {
    this.closed = true
    this.eventAbort?.abort()
    this.eventAbort = null
    this.reverseAbort?.abort()
    this.reverseAbort = null
    this.resumeEvents()
    if (this.child.exitCode === null && !this.child.killed) this.child.kill()
    // Let the worker release its SQLite handles before a harness deletes the
    // temp directory underneath it.
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

function readReadyPort(child) {
  return new Promise((resolve, reject) => {
    let buffered = ''
    let settled = false
    const finish = (error, port) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.off('exit', onExit)
      if (error) reject(error)
      else resolve(port)
    }

    const timer = setTimeout(
      () => finish(new Error('Worker did not publish an HTTP port before the deadline')),
      READY_TIMEOUT_MS
    )
    timer.unref?.()

    const onData = (chunk) => {
      buffered += chunk.toString('utf8')
      let newlineAt = buffered.indexOf('\n')
      while (newlineAt >= 0) {
        const line = buffered.slice(0, newlineAt).trim()
        buffered = buffered.slice(newlineAt + 1)
        if (line.startsWith(READY_LINE_PREFIX)) {
          try {
            const parsed = JSON.parse(line.slice(READY_LINE_PREFIX.length).trim())
            if (!Number.isInteger(parsed.port) || parsed.port <= 0) {
              throw new Error(`Worker published an invalid port: ${String(parsed.port)}`)
            }
            finish(null, parsed.port)
          } catch (error) {
            finish(error)
          }
          return
        }
        newlineAt = buffered.indexOf('\n')
      }
    }

    const onExit = (code, signal) =>
      finish(
        new Error(
          `Worker exited before publishing its HTTP port: code=${code ?? 'null'} signal=${signal ?? 'null'}`
        )
      )

    child.stdout?.on('data', onData)
    child.once('exit', onExit)
  })
}
