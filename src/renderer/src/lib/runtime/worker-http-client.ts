import { invokeMessagePackBinary } from '../ipc/messagepack-ipc-client'
import { toMessagePackChannel } from '../../../../shared/messagepack/binary-ipc'

/**
 * Direct client for the Native Worker's loopback HTTP API.
 *
 * Commands and queries go straight from this window to the worker rather than
 * being relayed through the host process. The host still supervises the worker
 * and owns reverse RPC, so the only thing it hands over here is the endpoint and
 * bearer token.
 */

export type WorkerConnection = { baseUrl: string; token: string }

let cached: WorkerConnection | null = null
let resolving: Promise<WorkerConnection | null> | null = null
let nextRequestId = 1

/**
 * Asks the host where the worker is listening. Cached because it only changes
 * when the worker is replaced, which surfaces as a failed request below.
 */
async function resolveConnection(): Promise<WorkerConnection | null> {
  if (cached) return cached
  if (resolving) return resolving

  resolving = (async () => {
    try {
      const result = await invokeMessagePackBinary<WorkerConnection | null>(
        toMessagePackChannel('sidecar:connection'),
        undefined
      )
      cached = result && result.baseUrl && result.token ? result : null
      return cached
    } catch {
      cached = null
      return null
    } finally {
      resolving = null
    }
  })()

  return resolving
}

/** Resolves this window's worker endpoint, starting nothing on its own. */
export async function getWorkerConnection(): Promise<WorkerConnection | null> {
  return await resolveConnection()
}

/** Drops the cached endpoint so the next call re-asks the host. */
export function invalidateWorkerConnection(): void {
  cached = null
}

export function hasWorkerConnection(): boolean {
  return cached !== null
}

export class WorkerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkerUnavailableError'
  }
}

/**
 * Issues one command or query. Handler errors arrive inside the response body,
 * matching the worker's contract that HTTP status codes are reserved for
 * transport faults; those are raised as {@link WorkerUnavailableError} so the
 * caller can fall back to asking the host to restart the worker.
 */
export async function requestWorker<TResult = unknown>(
  method: string,
  params?: unknown,
  timeoutMs = 30_000
): Promise<TResult> {
  const connection = await resolveConnection()
  if (!connection) {
    throw new WorkerUnavailableError(`Native worker is not running; cannot call ${method}`)
  }
  return await requestWorkerAt<TResult>(connection, method, params, timeoutMs)
}

/**
 * The wire half of {@link requestWorker}, against an already-known endpoint.
 * Separated so the request/response and failure-mapping behaviour can be
 * exercised against a real worker without an Electron host to ask for the
 * endpoint.
 */
export async function requestWorkerAt<TResult = unknown>(
  connection: WorkerConnection,
  method: string,
  params?: unknown,
  timeoutMs = 30_000
): Promise<TResult> {
  const id = nextRequestId++
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)

  try {
    const response = await fetch(`${connection.baseUrl}/rpc`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${connection.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ id, method, params: params ?? {} }),
      signal: abort.signal
    })

    if (!response.ok) {
      // A replaced worker answers on a stale port with a connection error or on a
      // new one with 401; either way the cached endpoint is no longer valid.
      invalidateWorkerConnection()
      throw new WorkerUnavailableError(
        `Native worker returned HTTP ${response.status} for ${method}`
      )
    }

    const envelope = (await response.json()) as { result?: unknown; error?: unknown }
    const error = readError(envelope)
    if (error) throw new Error(error)
    return envelope.result as TResult
  } catch (error) {
    if (abort.signal.aborted) {
      throw new Error(`Native worker request timed out: ${method}`)
    }
    if (error instanceof TypeError) {
      // fetch rejects with TypeError when the socket is gone.
      invalidateWorkerConnection()
      throw new WorkerUnavailableError(`Native worker is unreachable; cannot call ${method}`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Asks the worker to abandon an in-flight request. Best effort: the request may
 * already have completed, and the caller has stopped waiting either way.
 */
export function cancelWorkerRequest(requestId: number): void {
  const connection = cached
  if (!connection) return
  void fetch(`${connection.baseUrl}/cancel`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${connection.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ requestId })
  }).catch(() => {
    // Nothing to do; the caller already gave up on this request.
  })
}

function readError(envelope: { result?: unknown; error?: unknown }): string | null {
  if (typeof envelope.error === 'string' && envelope.error) return envelope.error
  const result = envelope.result
  if (result && typeof result === 'object' && 'error' in result) {
    const nested = (result as { error?: unknown }).error
    if (typeof nested === 'string' && nested) return nested
  }
  return null
}
