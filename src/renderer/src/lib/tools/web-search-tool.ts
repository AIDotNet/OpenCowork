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

const webSearchHandler: ToolHandler = {
  definition: {
    name: 'WebSearch',
    description: 'Search the web using the user-configured search provider. The provider is determined by the user\'s settings, not by the AI.',
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

    // Always use the user's configured provider from settings
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

let _registered = false

export function registerWebSearchTool(): void {
  if (_registered) return
  _registered = true
  toolRegistry.register(webSearchHandler)
}

export function unregisterWebSearchTool(): void {
  if (!_registered) return
  _registered = false
  toolRegistry.unregister(webSearchHandler.definition.name)
}

export function isWebSearchToolRegistered(): boolean {
  return _registered
}
