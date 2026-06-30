import { ipcMain } from 'electron'
import { getNativeWorker } from '../lib/native-worker'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'

type WebSearchProvider =
  | 'tavily'
  | 'searxng'
  | 'exa'
  | 'exa-mcp'
  | 'bocha'
  | 'zhipu'
  | 'google'
  | 'bing'
  | 'baidu'

interface WebSearchRequest {
  query: string
  provider: WebSearchProvider
  maxResults?: number
  searchMode?: 'web' | 'news'
  apiKey?: string
  timeout?: number
}

interface WebFetchRequest {
  url?: string
  urls?: string[] | string
  format?: 'markdown' | 'text' | 'html'
  timeout?: number
}

const WEB_SEARCH_PROVIDERS: WebSearchProvider[] = [
  'tavily',
  'searxng',
  'exa',
  'exa-mcp',
  'bocha',
  'zhipu',
  'google',
  'bing',
  'baidu'
]

function normalizeNativeResult<T>(value: unknown): T | { error: string } {
  if (typeof value !== 'string') return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    return { error: value }
  }
}

async function requestNativeWeb<T>(
  method: 'web/search' | 'web/fetch',
  params: WebSearchRequest | WebFetchRequest
): Promise<T | { error: string }> {
  try {
    const result = await getNativeWorker().request<unknown>(method, params, 120_000)
    return normalizeNativeResult<T>(result)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function registerWebMessagePackHandler<TArgs>(
  channel: string,
  handler: (args: TArgs) => Promise<unknown>
): void {
  ipcMain.handle(toMessagePackChannel(channel), async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<TArgs>(bytes)
    return encodeMessagePackPayload(await handler(args))
  })
}

export function registerWebSearchHandlers(): void {
  registerWebMessagePackHandler<WebSearchRequest>('web:search', (args) =>
    requestNativeWeb('web/search', args)
  )

  registerWebMessagePackHandler<WebFetchRequest>('web:fetch', (args) =>
    requestNativeWeb('web/fetch', args)
  )

  registerWebMessagePackHandler<undefined>(
    'web:search-config',
    async (): Promise<{ providers: WebSearchProvider[] }> => {
      return { providers: WEB_SEARCH_PROVIDERS }
    }
  )

  registerWebMessagePackHandler<undefined>(
    'web:search-providers',
    async (): Promise<WebSearchProvider[]> => {
      return WEB_SEARCH_PROVIDERS
    }
  )
}
