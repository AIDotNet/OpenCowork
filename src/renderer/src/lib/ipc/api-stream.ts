import { nanoid } from 'nanoid'
import type { SSEEvent } from '../api/sse-parser'

export interface RequestDebugInfo {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  timestamp: number
}

export class ApiStreamError extends Error {
  debugInfo: RequestDebugInfo
  constructor(message: string, debugInfo: RequestDebugInfo) {
    super(message)
    this.name = 'ApiStreamError'
    this.debugInfo = debugInfo
  }
}

export function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {}
  const sensitiveKeys = ['authorization', 'x-api-key', 'api-key', 'x-goog-api-key']
  for (const [k, v] of Object.entries(headers)) {
    if (sensitiveKeys.includes(k.toLowerCase()) && v.length > 8) {
      masked[k] = v.slice(0, 4) + '****' + v.slice(-4)
    } else {
      masked[k] = v
    }
  }
  return masked
}

type QueueItem =
  | { type: 'chunk'; data: string }
  | { type: 'end' }
  | { type: 'error'; error: string }

type StreamQueueSink = {
  push: (item: QueueItem) => void
}

type ApiStreamDispatcherState = {
  initialized: boolean
  requests: Map<string, StreamQueueSink>
}

const API_STREAM_DISPATCHER_KEY = '__openCoworkApiStreamDispatcher__'

function getApiStreamDispatcherState(): ApiStreamDispatcherState {
  const scope = globalThis as typeof globalThis & {
    [API_STREAM_DISPATCHER_KEY]?: ApiStreamDispatcherState
  }

  if (!scope[API_STREAM_DISPATCHER_KEY]) {
    scope[API_STREAM_DISPATCHER_KEY] = {
      initialized: false,
      requests: new Map<string, StreamQueueSink>()
    }
  }

  return scope[API_STREAM_DISPATCHER_KEY]
}

function completeRequest(state: ApiStreamDispatcherState, requestId: string, item: QueueItem): void {
  const request = state.requests.get(requestId)
  if (!request) return
  request.push(item)
  if (item.type === 'end' || item.type === 'error') {
    state.requests.delete(requestId)
  }
}

function ensureApiStreamDispatcher(): void {
  const state = getApiStreamDispatcherState()
  if (state.initialized) return
  if (typeof window === 'undefined' || !window.electron?.ipcRenderer) return

  const ipc = window.electron.ipcRenderer

  ipc.on('api:stream-chunk', (_event: unknown, data: { requestId?: string; data?: string }) => {
    if (typeof data?.requestId !== 'string' || typeof data.data !== 'string') return
    completeRequest(state, data.requestId, { type: 'chunk', data: data.data })
  })

  ipc.on('api:stream-end', (_event: unknown, data: { requestId?: string }) => {
    if (typeof data?.requestId !== 'string') return
    completeRequest(state, data.requestId, { type: 'end' })
  })

  ipc.on('api:stream-error', (_event: unknown, data: { requestId?: string; error?: string }) => {
    if (typeof data?.requestId !== 'string') return
    completeRequest(state, data.requestId, {
      type: 'error',
      error: typeof data.error === 'string' ? data.error : 'Unknown stream error'
    })
  })

  state.initialized = true
}

function registerApiStreamRequest(requestId: string, push: (item: QueueItem) => void): () => void {
  const state = getApiStreamDispatcherState()
  state.requests.set(requestId, { push })
  return () => {
    state.requests.delete(requestId)
  }
}

/**
 * Streams an API request through the main process IPC proxy.
 * Returns an AsyncIterable of SSE events, matching the same interface
 * as the direct fetch-based SSE parser.
 */
export async function* ipcStreamRequest(params: {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
  useSystemProxy?: boolean
  providerId?: string
  providerBuiltinId?: string
}): AsyncIterable<SSEEvent> {
  const requestId = nanoid()
  const { url, method, headers, body, signal, useSystemProxy, providerId, providerBuiltinId } =
    params

  const queue: QueueItem[] = []
  let resolve: (() => void) | null = null
  let done = false

  const push = (item: QueueItem): void => {
    queue.push(item)
    if (resolve) {
      resolve()
      resolve = null
    }
  }

  const waitForItem = (): Promise<void> =>
    new Promise<void>((r) => {
      if (queue.length > 0) {
        r()
      } else {
        resolve = r
      }
    })

  const ipc = window.electron.ipcRenderer
  ensureApiStreamDispatcher()
  const unregisterRequest = registerApiStreamRequest(requestId, push)

  const abortHandler = (): void => {
    ipc.send('api:abort', { requestId })
    push({ type: 'end' })
  }
  signal?.addEventListener('abort', abortHandler, { once: true })

  ipc.send('api:stream-request', {
    requestId,
    url,
    method,
    headers,
    body,
    useSystemProxy,
    providerId,
    providerBuiltinId
  })

  let buffer = ''

  try {
    while (!done) {
      await waitForItem()

      while (queue.length > 0) {
        const item = queue.shift()!

        if (item.type === 'end') {
          done = true
          if (buffer.trim()) {
            const lines = buffer.split(/\r?\n/)
            const parsed: SSEEvent = { data: '' }
            const dataLines: string[] = []
            for (const line of lines) {
              if (line.startsWith('event:')) {
                parsed.event = line.slice(line.charAt(6) === ' ' ? 7 : 6)
              } else if (line.startsWith('data:')) {
                dataLines.push(line.slice(line.charAt(5) === ' ' ? 6 : 5))
              }
            }
            parsed.data = dataLines.join('\n')
            if (parsed.data) yield parsed
            buffer = ''
          }
          break
        }

        if (item.type === 'error') {
          done = true
          throw new ApiStreamError(item.error, {
            url,
            method,
            headers: maskHeaders(headers),
            body,
            timestamp: Date.now()
          })
        }

        buffer += item.data
        const events = buffer.split(/\r?\n\r?\n/)
        buffer = events.pop() || ''

        for (const eventStr of events) {
          const lines = eventStr.split(/\r?\n/)
          const parsed: SSEEvent = { data: '' }
          const dataLines: string[] = []
          for (const line of lines) {
            if (line.startsWith('event:')) parsed.event = line.slice(line.charAt(6) === ' ' ? 7 : 6)
            else if (line.startsWith('data:')) {
              dataLines.push(line.slice(line.charAt(5) === ' ' ? 6 : 5))
            }
          }
          parsed.data = dataLines.join('\n')
          if (parsed.data) yield parsed
        }
      }
    }
  } finally {
    unregisterRequest()
    signal?.removeEventListener('abort', abortHandler)
  }
}
