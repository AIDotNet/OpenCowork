import { toolRegistry } from '../agent/tool-registry'
import { IPC } from '../ipc/channels'
import type { ToolHandler } from './tool-types'
import { useSettingsStore } from '../../stores/settings-store'

// Web search provider types
export type WebSearchProvider =
  | 'tavily'
  | 'searxng'
  | 'exa'
  | 'exa-mcp'
  | 'bocha'
  | 'zhipu'
  | 'google'
  | 'bing'
  | 'baidu'

export interface WebSearchConfig {
  provider: WebSearchProvider
  apiKey?: string
  searchEngine?: string // For local search engines
  maxResults?: number
  timeout?: number
}

export interface WebSearchResult {
  title: string
  url: string
  content: string
  score?: number
  publishedDate?: string
}

export interface WebSearchResponse {
  results: WebSearchResult[]
  query: string
  provider: WebSearchProvider
  totalResults?: number
}

export type WebFetchFormat = 'markdown' | 'text' | 'html'

export interface WebFetchResult {
  url: string
  finalUrl?: string
  title?: string
  content: string
  format: WebFetchFormat
  error?: string
}

export interface WebFetchResponse {
  results: WebFetchResult[]
  format: WebFetchFormat
  totalResults: number
}

const webSearchHandler: ToolHandler = {
  definition: {
    name: 'WebSearch',
    description:
      "Search the web using the user's configured provider. The model cannot choose or override the provider.",
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query to execute'
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of results to return',
          default: 5
        },
        searchMode: {
          type: 'string',
          description: 'Search mode (web, news, etc.)',
          enum: ['web', 'news'],
          default: 'web'
        }
      },
      required: ['query']
    }
  },
  execute: async (input, ctx) => {
    const query = input.query as string
    const maxResults = (input.maxResults as number) || 5
    const searchMode = (input.searchMode as string) || 'web'

    const settings = useSettingsStore.getState()
    const provider = settings.webSearchProvider
    const apiKey = settings.webSearchApiKey
    const timeout = settings.webSearchTimeout

    try {
      const result = await ctx.ipc.invoke(IPC.WEB_SEARCH, {
        query,
        provider,
        maxResults,
        searchMode,
        apiKey,
        timeout
      })
      return JSON.stringify(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return JSON.stringify({ error: `Web search failed: ${message}` })
    }
  },
  requiresApproval: () => false
}

function normalizeUrls(input: Record<string, unknown>): string[] {
  const directUrl = typeof input.url === 'string' ? input.url.trim() : ''
  const rawUrls = input.urls

  if (directUrl) return [directUrl]
  if (typeof rawUrls === 'string') {
    return rawUrls.trim() ? [rawUrls.trim()] : []
  }
  if (Array.isArray(rawUrls)) {
    return rawUrls
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
  }

  return []
}

const webFetchHandler: ToolHandler = {
  definition: {
    name: 'WebFetch',
    description:
      'Fetch one or more URLs and return page content. Accepts url or urls (string or string array) and defaults to markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'A single URL to fetch'
        },
        urls: {
          type: 'array',
          items: {
            type: 'string'
          },
          minItems: 1,
          description: 'A list of URLs to fetch'
        },
        format: {
          type: 'string',
          enum: ['markdown', 'text', 'html'],
          default: 'markdown',
          description: 'Output format, defaults to markdown'
        }
      },
      additionalProperties: false
    }
  },
  execute: async (input, ctx) => {
    const urls = normalizeUrls(input)
    const format = (input.format as WebFetchFormat) || 'markdown'
    const timeout = useSettingsStore.getState().webSearchTimeout

    if (urls.length === 0) {
      return JSON.stringify({ error: 'Web fetch requires a url or urls input' })
    }

    try {
      const result = await ctx.ipc.invoke(IPC.WEB_FETCH, {
        urls,
        format,
        timeout
      })
      return JSON.stringify(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return JSON.stringify({ error: `Web fetch failed: ${message}` })
    }
  },
  requiresApproval: () => false
}

let _registered = false

export function registerWebSearchTool(): void {
  if (_registered) return
  _registered = true
  toolRegistry.register(webSearchHandler)
  toolRegistry.register(webFetchHandler)
}

export function unregisterWebSearchTool(): void {
  if (!_registered) return
  _registered = false
  toolRegistry.unregister(webSearchHandler.definition.name)
  toolRegistry.unregister(webFetchHandler.definition.name)
}

export function isWebSearchToolRegistered(): boolean {
  return _registered
}
