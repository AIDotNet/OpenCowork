import { invokeMessagePackBinary } from '../ipc/messagepack-ipc-client'
import { toMessagePackChannel } from '../../../../shared/messagepack/binary-ipc'

/**
 * Direct client for the Native Worker's loopback HTTP API.
 *
 * Commands and queries go straight from this window to the worker rather than
 * being relayed through the host process. The host still supervises the worker
 * and owns reverse RPC, so the only thing it hands over here is the endpoint and
 * bearer token.
 *
 * Job routes (`executionMode: "job"`) cannot be invoked as Control RPCs. This
 * client discovers them from `worker/routes` and submits them through
 * `jobs/submit`, matching the Main and CLI workers. A wait timeout only stops
 * polling; the committed Job keeps running until `jobs/cancel`.
 */

export type WorkerConnection = { baseUrl: string; token: string }

export type WorkerJobRoute = {
  resultMode: string
}

export type WorkerRpcCall = <T>(
  method: string,
  params?: unknown,
  timeoutMs?: number
) => Promise<T>

const RUN_ADDRESSED_JOBS = new Set([
  'agent/run',
  'agent/session-send',
  'agent/compress-context'
])

let cached: WorkerConnection | null = null
let resolving: Promise<WorkerConnection | null> | null = null
let nextRequestId = 1
let jobRoutes: Map<string, WorkerJobRoute> | null = null
let jobRoutesKey: string | null = null
let resolvingJobRoutes: { key: string; promise: Promise<Map<string, WorkerJobRoute>> } | null =
  null

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
  jobRoutes = null
  jobRoutesKey = null
  resolvingJobRoutes = null
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
 *
 * Background Job routes are submitted through `jobs/submit` and, unless the
 * route's result mode is `accepted`, waited out with `jobs/result`.
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

  const rpc: WorkerRpcCall = (rpcMethod, rpcParams, rpcTimeoutMs) =>
    requestWorkerAt(connection, rpcMethod, rpcParams, rpcTimeoutMs)

  if (isJobControlMethod(method)) {
    return await rpc<TResult>(method, params, timeoutMs)
  }

  const route = (await ensureJobRoutes(connection)).get(method)
  if (!route) {
    return await rpc<TResult>(method, params, timeoutMs)
  }

  return await submitAndAwaitWorkerJob<TResult>({
    request: rpc,
    method,
    params,
    resultMode: route.resultMode,
    timeoutMs
  })
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJobControlMethod(method: string): boolean {
  return method === 'worker/routes' || method.startsWith('jobs/')
}

function connectionKey(connection: WorkerConnection): string {
  return `${connection.baseUrl}\0${connection.token}`
}

async function ensureJobRoutes(
  connection: WorkerConnection
): Promise<Map<string, WorkerJobRoute>> {
  const key = connectionKey(connection)
  if (jobRoutes && jobRoutesKey === key) return jobRoutes
  if (resolvingJobRoutes?.key === key) return resolvingJobRoutes.promise

  const promise = requestWorkerAt(connection, 'worker/routes', {}, 10_000).then(
    collectWorkerJobRoutes
  )
  resolvingJobRoutes = { key, promise }
  try {
    const loaded = await promise
    jobRoutes = loaded
    jobRoutesKey = key
    return loaded
  } finally {
    if (resolvingJobRoutes?.promise === promise) resolvingJobRoutes = null
  }
}

export function collectWorkerJobRoutes(result: unknown): Map<string, WorkerJobRoute> {
  const routes = new Map<string, WorkerJobRoute>()
  if (!isRecord(result) || !Array.isArray(result.routes)) return routes
  for (const value of result.routes) {
    if (
      isRecord(value) &&
      typeof value.method === 'string' &&
      value.executionMode === 'job' &&
      typeof value.resultMode === 'string'
    ) {
      routes.set(value.method, { resultMode: value.resultMode })
    }
  }
  return routes
}

export async function submitAndAwaitWorkerJob<TResult>(args: {
  request: WorkerRpcCall
  method: string
  params?: unknown
  resultMode: string
  timeoutMs: number
  createJobId?: () => string
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}): Promise<TResult> {
  const source = isRecord(args.params) ? args.params : {}
  const runAddressed = RUN_ADDRESSED_JOBS.has(args.method)
  const sourceRunId =
    typeof source.runId === 'string' && source.runId.trim() ? source.runId.trim() : null
  const requestedRunId =
    args.method === 'agent/run' || args.method === 'agent/compress-context'
      ? sourceRunId ?? (args.createJobId?.() ?? crypto.randomUUID())
      : sourceRunId
  const jobParams = requestedRunId ? { ...source, runId: requestedRunId } : args.params
  const submitArgs: Record<string, unknown> = {
    method: args.method,
    params: jobParams ?? {}
  }
  if (requestedRunId) {
    submitArgs.jobId = requestedRunId
    submitArgs.idempotencyKey = requestedRunId
  } else if (!runAddressed) {
    const generatedJobId = args.createJobId?.() ?? crypto.randomUUID()
    submitArgs.jobId = generatedJobId
    submitArgs.idempotencyKey = generatedJobId
  }

  const submission = await args.request<{
    accepted?: boolean
    jobId?: string
    runId?: string
    assistantMessageId?: string
    state?: string
    duplicate?: boolean
    error?: string
    errorCode?: string
  }>('jobs/submit', submitArgs, 30_000)

  if (submission.accepted !== true || typeof submission.jobId !== 'string') {
    throw new Error(
      submission.error || `${submission.errorCode ?? 'queue_unavailable'}: Job was not committed`
    )
  }

  if (args.resultMode === 'accepted') {
    return {
      started: true,
      runId: submission.runId || requestedRunId || submission.jobId,
      assistantMessageId: submission.assistantMessageId,
      jobId: submission.jobId,
      state: submission.state || 'queued',
      duplicate: submission.duplicate === true
    } as TResult
  }

  const now = args.now ?? Date.now
  const sleep = args.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + args.timeoutMs
  let pollDelayMs = 100

  while (true) {
    if (now() >= deadline) {
      throw new Error(
        `Background Job wait timed out: ${args.method} (jobId=${submission.jobId}); ` +
          'the Job remains queued/running and can be queried with jobs/result.'
      )
    }

    const status = await args.request<{
      found?: boolean
      state?: string
      result?: unknown
      error?: string
      errorCode?: string
    }>('jobs/result', { jobId: submission.jobId }, 10_000)

    if (status.found === false) {
      throw new Error(`Background Job not found: ${args.method} (jobId=${submission.jobId})`)
    }
    if (status.state === 'succeeded') return status.result as TResult
    if (status.state === 'failed' || status.state === 'cancelled') {
      throw new Error(
        `${status.errorCode ?? status.state}: ${status.error ?? `Background Job ${status.state}`}`
      )
    }

    await sleep(pollDelayMs)
    pollDelayMs = Math.min(1_000, Math.ceil(pollDelayMs * 1.5))
  }
}
