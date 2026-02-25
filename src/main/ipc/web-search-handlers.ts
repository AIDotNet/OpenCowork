import { ipcMain } from 'electron'
import * as https from 'https'
import * as http from 'http'
import { shell } from 'electron'

// TypeScript interfaces matching renderer
interface WebSearchRequest {
  query: string
  provider: 'tavily' | 'searxng' | 'exa' | 'exa-mcp' | 'bocha' | 'zhipu' | 'google' | 'bing' | 'baidu'
  maxResults?: number
  searchMode?: 'web' | 'news'
  apiKey?: string
  timeout?: number
}

interface WebSearchResult {
  title: string
  url: string
  content: string
  score?: number
  publishedDate?: string
}

interface WebSearchResponse {
  results: WebSearchResult[]
  query: string
  provider: string
  totalResults?: number
}

// Helper function for HTTP/HTTPS requests
function makeHttpRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
  timeout: number = 30000
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const isHttps = urlObj.protocol === 'https:'
    const module = isHttps ? https : http

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method,
      headers,
      timeout,
    }

    const req = module.request(options, (res) => {
      let responseBody = ''

      res.on('data', (chunk: Buffer) => {
        responseBody += chunk.toString()
      })

      res.on('end', () => {
        resolve({ statusCode: res.statusCode ?? 0, body: responseBody })
      })
    })

    req.on('error', (err) => {
      reject(err)
    })

    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`Request timeout after ${timeout}ms`))
    })

    if (body) {
      req.write(body)
    }

    req.end()
  })
}

// Tavily Search API
async function searchTavily(request: WebSearchRequest): Promise<WebSearchResponse> {
  if (!request.apiKey) {
    throw new Error('Tavily API key is required')
  }

  const body = JSON.stringify({
    query: request.query,
    api_key: request.apiKey,
    max_results: request.maxResults || 5,
    search_mode: request.searchMode || 'web',
  })

  const response = await makeHttpRequest(
    'POST',
    'https://api.tavily.com/search',
    {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body).toString(),
    },
    body,
    request.timeout || 30000
  )

  if (response.statusCode !== 200) {
    throw new Error(`Tavily API error: ${response.statusCode} - ${response.body}`)
  }

  const data = JSON.parse(response.body)
  const results = data.results || []

  return {
    results: results.map((r: any) => ({
      title: r.title || '',
      url: r.url || '',
      content: r.content || '',
      score: r.score,
      publishedDate: r.published_date,
    })),
    query: request.query,
    provider: 'tavily',
    totalResults: results.length,
  }
}

// Searxng Search API (uses fixed URL: https://searxng.org)
async function searchSearxng(request: WebSearchRequest): Promise<WebSearchResponse> {
  const baseUrl = 'https://searxng.org'
  const url = `${baseUrl}/search?q=${encodeURIComponent(request.query)}&format=json&limit=${request.maxResults || 5}`

  const response = await makeHttpRequest(
    'GET',
    url,
    {},
    undefined,
    request.timeout || 30000
  )

  if (response.statusCode !== 200) {
    throw new Error(`Searxng API error: ${response.statusCode} - ${response.body}`)
  }

  const data = JSON.parse(response.body)
  const results = data.results || []

  return {
    results: results.map((r: any) => ({
      title: r.title || '',
      url: r.url || '',
      content: r.content || '',
      score: r.score,
      publishedDate: r.published_date,
    })),
    query: request.query,
    provider: 'searxng',
    totalResults: results.length,
  }
}

// Exa Search API
async function searchExa(request: WebSearchRequest): Promise<WebSearchResponse> {
  if (!request.apiKey) {
    throw new Error('Exa API key is required')
  }

  const body = JSON.stringify({
    query: request.query,
    numResults: request.maxResults || 5,
    searchMode: request.searchMode || 'web',
  })

  const response = await makeHttpRequest(
    'POST',
    'https://api.exa.ai/search',
    {
      'Content-Type': 'application/json',
      'x-api-key': request.apiKey,
    },
    body,
    request.timeout || 30000
  )

  if (response.statusCode !== 200) {
    throw new Error(`Exa API error: ${response.statusCode} - ${response.body}`)
  }

  const data = JSON.parse(response.body)
  const results = data.results || []

  return {
    results: results.map((r: any) => ({
      title: r.title || '',
      url: r.url || '',
      content: r.snippet || '',
      score: r.score,
      publishedDate: r.publishedDate,
    })),
    query: request.query,
    provider: 'exa',
    totalResults: results.length,
  }
}

// Bocha Search API (Chinese search engine)
async function searchBocha(request: WebSearchRequest): Promise<WebSearchResponse> {
  if (!request.apiKey) {
    throw new Error('Bocha API key is required')
  }

  const body = JSON.stringify({
    query: request.query,
    limit: request.maxResults || 5,
  })

  const response = await makeHttpRequest(
    'POST',
    'https://api.bocha.cn/search',
    {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${request.apiKey}`,
    },
    body,
    request.timeout || 30000
  )

  if (response.statusCode !== 200) {
    throw new Error(`Bocha API error: ${response.statusCode} - ${response.body}`)
  }

  const data = JSON.parse(response.body)
  const results = data.results || []

  return {
    results: results.map((r: any) => ({
      title: r.title || '',
      url: r.url || '',
      content: r.snippet || '',
      score: r.score,
      publishedDate: r.publishedDate,
    })),
    query: request.query,
    provider: 'bocha',
    totalResults: results.length,
  }
}

// Zhipu Search API
async function searchZhipu(request: WebSearchRequest): Promise<WebSearchResponse> {
  if (!request.apiKey) {
    throw new Error('Zhipu API key is required')
  }

  const body = JSON.stringify({
    prompt: request.query,
    max_results: request.maxResults || 5,
  })

  const response = await makeHttpRequest(
    'POST',
    'https://open.bigmodel.cn/api/paas/v4/tools/search',
    {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${request.apiKey}`,
    },
    body,
    request.timeout || 30000
  )

  if (response.statusCode !== 200) {
    throw new Error(`Zhipu API error: ${response.statusCode} - ${response.body}`)
  }

  const data = JSON.parse(response.body)
  const results = data.results || []

  return {
    results: results.map((r: any) => ({
      title: r.title || '',
      url: r.url || '',
      content: r.content || r.snippet || '',
      score: r.score,
      publishedDate: r.publishedDate,
    })),
    query: request.query,
    provider: 'zhipu',
    totalResults: results.length,
  }
}

// Local search engines (Google, Bing, Baidu) - open in browser
async function searchLocalEngine(request: WebSearchRequest): Promise<WebSearchResponse> {
  let searchUrl: string

  switch (request.provider) {
    case 'google':
      searchUrl = `https://www.google.com/search?q=${encodeURIComponent(request.query)}`
      break
    case 'bing':
      searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(request.query)}`
      break
    case 'baidu':
      searchUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(request.query)}`
      break
    default:
      throw new Error(`Unsupported local search engine: ${request.provider}`)
  }

  // Open the search URL in the default browser
  try {
    await shell.openExternal(searchUrl)
  } catch (err) {
    throw new Error(`Failed to open browser: ${err instanceof Error ? err.message : String(err)}`)
  }

  return {
    results: [
      {
        title: `Search opened in browser`,
        url: searchUrl,
        content: `Your search for "${request.query}" has been opened in your default browser.`,
      },
    ],
    query: request.query,
    provider: request.provider,
    totalResults: 1,
  }
}

// Exa MCP Search (placeholder - would need MCP server connection)
async function searchExaMcp(request: WebSearchRequest): Promise<WebSearchResponse> {
  // This would require connecting to an MCP server that provides Exa search
  // For now, return a placeholder response
  return {
    results: [
      {
        title: 'Exa MCP Search',
        url: '',
        content: 'Exa MCP search requires an MCP server connection. Please configure an MCP server with Exa search capabilities.',
      },
    ],
    query: request.query,
    provider: 'exa-mcp',
    totalResults: 0,
  }
}

// Main handler registration
export function registerWebSearchHandlers(): void {
  // Main web search handler
  ipcMain.handle('web:search', async (_event, args: WebSearchRequest): Promise<WebSearchResponse | { error: string }> => {
    try {
      // Route to appropriate provider
      switch (args.provider) {
        case 'tavily':
          return await searchTavily(args)
        case 'searxng':
          return await searchSearxng(args)
        case 'exa':
          return await searchExa(args)
        case 'exa-mcp':
          return await searchExaMcp(args)
        case 'bocha':
          return await searchBocha(args)
        case 'zhipu':
          return await searchZhipu(args)
        case 'google':
        case 'bing':
        case 'baidu':
          return await searchLocalEngine(args)
        default:
          return { error: `Unsupported provider: ${args.provider}` }
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Config handler for getting web search configuration
  ipcMain.handle('web:search-config', async (): Promise<{ providers: string[] }> => {
    return {
      providers: ['tavily', 'searxng', 'exa', 'exa-mcp', 'bocha', 'zhipu', 'google', 'bing', 'baidu'],
    }
  })

  // Providers list handler
  ipcMain.handle('web:search-providers', async (): Promise<{ providers: Array<{ value: string; label: string; description: string }> }> => {
    return {
      providers: [
        { value: 'tavily', label: 'Tavily', description: 'AI-powered search API' },
        { value: 'searxng', label: 'Searxng', description: 'Open-source metasearch engine' },
        { value: 'exa', label: 'Exa', description: 'AI search API' },
        { value: 'exa-mcp', label: 'Exa MCP', description: 'Exa via MCP server' },
        { value: 'bocha', label: 'Bocha', description: 'Chinese search engine' },
        { value: 'zhipu', label: 'Zhipu', description: 'ZhiPu AI search' },
        { value: 'google', label: 'Google', description: 'Local search via browser' },
        { value: 'bing', label: 'Bing', description: 'Local search via browser' },
        { value: 'baidu', label: 'Baidu', description: 'Local search via browser' },
      ],
    }
  })
}
