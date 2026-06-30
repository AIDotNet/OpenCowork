import { toolRegistry } from '../agent/tool-registry'
import { encodeStructuredToolResult } from './tool-result-format'
import type { ToolHandler } from './tool-types'

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

function nativeOnlyResult(toolName: string): string {
  return encodeStructuredToolResult({
    error: `${toolName} execution has migrated to .NET Native Worker.`
  })
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
  execute: async () => nativeOnlyResult('WebSearch'),
  requiresApproval: () => false
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
  execute: async () => nativeOnlyResult('WebFetch'),
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
