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
  const sensitiveKeys = ['authorization', 'x-api-key', 'api-key']
  for (const [k, v] of Object.entries(headers)) {
    if (sensitiveKeys.includes(k.toLowerCase()) && v.length > 8) {
      masked[k] = v.slice(0, 4) + '****' + v.slice(-4)
    } else {
      masked[k] = v
    }
  }
  return masked
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
  const { url, method, headers, body, signal, useSystemProxy, providerId, providerBuiltinId } = params

  // Queue to bridge IPC callbacks → async iterator
  type QueueItem =
    | { type: 'chunk'; data: string }
    | { type: 'end' }
    | { type: 'error'; error: string }

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

  // Register IPC listeners
  const ipc = window.electron.ipcRenderer

  const onChunk = (_event: unknown, data: { requestId: string; data: string }): void => {
    if (data.requestId === requestId) push({ type: 'chunk', data: data.data })
  }
  const onEnd = (_event: unknown, data: { requestId: string }): void => {
    if (data.requestId === requestId) push({ type: 'end' })
  }
  const onError = (_event: unknown, data: { requestId: string; error: string }): void => {
    if (data.requestId === requestId) push({ type: 'error', error: data.error })
  }

  ipc.on('api:stream-chunk', onChunk)
  ipc.on('api:stream-end', onEnd)
  ipc.on('api:stream-error', onError)

  // Handle abort
  const abortHandler = (): void => {
    ipc.send('api:abort', { requestId })
    push({ type: 'end' })
  }
  signal?.addEventListener('abort', abortHandler, { once: true })

  // Send request to main process
  ipc.send('api:stream-request', {
    requestId,
    url,
    method,
    headers,
    body,
    useSystemProxy,
    providerId,
    providerBuiltinId,
  })

  // SSE line parser state
  let buffer = ''

  try {
    while (!done) {
      await waitForItem()

      while (queue.length > 0) {
        const item = queue.shift()!

        if (item.type === 'end') {
          done = true
          // Flush any remaining data in the SSE buffer that wasn't
          // terminated with a double newline (some providers omit the trailing blank line).
          if (buffer.trim()) {
            const lines = buffer.split(/\r?\n/)
            const parsed: SSEEvent = { data: '' }
            const dataLines: string[] = []
            for (const line of lines) {
              if (line.startsWith('event:')) parsed.event = line.slice(line.charAt(6) === ' ' ? 7 : 6)
              else if (line.startsWith('data:')) dataLines.push(line.slice(line.charAt(5) === ' ' ? 6 : 5))
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
            timestamp: Date.now(),
          })
        }

        // Parse SSE from chunk
        buffer += item.data
        const events = buffer.split(/\r?\n\r?\n/)
        buffer = events.pop() || ''

        for (const eventStr of events) {
          const lines = eventStr.split(/\r?\n/)
          const parsed: SSEEvent = { data: '' }
          const dataLines: string[] = []
          for (const line of lines) {
            if (line.startsWith('event:')) parsed.event = line.slice(line.charAt(6) === ' ' ? 7 : 6)
            else if (line.startsWith('data:')) dataLines.push(line.slice(line.charAt(5) === ' ' ? 6 : 5))
          }
          parsed.data = dataLines.join('\n')
          if (parsed.data) yield parsed
        }
      }
    }
  } finally {
    // Cleanup listeners
    ipc.removeListener('api:stream-chunk', onChunk)
    ipc.removeListener('api:stream-end', onEnd)
    ipc.removeListener('api:stream-error', onError)
    signal?.removeEventListener('abort', abortHandler)
  }
}
