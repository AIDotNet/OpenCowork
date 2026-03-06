import { ipcMain } from 'electron'
import * as https from 'https'
import * as http from 'http'

// TypeScript interfaces matching renderer
interface WebSearchRequest {
  query: string
  provider:
    | 'tavily'
    | 'searxng'
    | 'exa'
    | 'exa-mcp'
    | 'bocha'
    | 'zhipu'
    | 'google'
    | 'bing'
    | 'baidu'
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

interface WebFetchRequest {
  urls: string[]
  format?: 'markdown' | 'text' | 'html'
  timeout?: number
}

interface WebFetchResult {
  url: string
  finalUrl?: string
  title?: string
  content: string
  format: 'markdown' | 'text' | 'html'
  error?: string
}

interface WebFetchResponse {
  results: WebFetchResult[]
  format: 'markdown' | 'text' | 'html'
  totalResults: number
}

// Helper function for HTTP/HTTPS requests
function makeHttpRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
  timeout: number = 30000,
  redirectsLeft: number = 5
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
      timeout
    }

    const req = module.request(options, (res) => {
      const statusCode = res.statusCode ?? 0
      const location = res.headers.location

      if (location && statusCode >= 300 && statusCode < 400 && redirectsLeft > 0) {
        res.resume()
        const nextUrl = new URL(location, url).toString()
        const nextMethod = statusCode === 307 || statusCode === 308 ? method : 'GET'
        const nextBody = nextMethod === method ? body : undefined
        void makeHttpRequest(nextMethod, nextUrl, headers, nextBody, timeout, redirectsLeft - 1)
          .then(resolve)
          .catch(reject)
        return
      }

      let responseBody = ''

      res.on('data', (chunk: Buffer) => {
        responseBody += chunk.toString()
      })

      res.on('end', () => {
        resolve({ statusCode, body: responseBody })
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

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function stripHtml(input: string): string {
  return decodeHtmlEntities(
    input
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<em\b[^>]*>/gi, '')
      .replace(/<\/em>/gi, '')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeUrl(url: string): string {
  return decodeHtmlEntities(url)
    .replace(/\\u002F/g, '/')
    .replace(/\\u003A/g, ':')
    .trim()
}

function resolveSearchResultUrl(provider: 'google' | 'bing' | 'baidu', rawUrl: string): string {
  const normalized = normalizeUrl(rawUrl)

  if (provider === 'google') {
    try {
      const absolute = normalized.startsWith('/url?')
        ? `https://www.google.com${normalized}`
        : normalized
      const urlObj = new URL(absolute)
      const target = urlObj.searchParams.get('q') ?? urlObj.searchParams.get('url')
      return target ? normalizeUrl(target) : normalized
    } catch {
      return normalized
    }
  }

  if (normalized.startsWith('/')) {
    const baseUrl = provider === 'bing' ? 'https://www.bing.com' : 'https://www.baidu.com'
    return `${baseUrl}${normalized}`
  }

  return normalized
}

function extractSnippet(section: string, patterns: RegExp[], title: string): string {
  for (const pattern of patterns) {
    const match = pattern.exec(section)
    if (!match) continue
    const text = stripHtml(match[1] ?? '')
    if (text && text !== title) return text
  }

  return stripHtml(section).replace(title, '').trim()
}

function extractHtmlTagContent(html: string, tagName: string): string | null {
  const match = html.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\/${tagName}>`, 'i'))
  return match?.[1] ?? null
}

function extractPreferredContentHtml(html: string): string {
  const article = extractHtmlTagContent(html, 'article')
  if (article) return article

  const main = extractHtmlTagContent(html, 'main')
  if (main) return main

  const body = extractHtmlTagContent(html, 'body')
  return body ?? html
}

function sanitizeHtmlForContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form|button|svg|canvas)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
}

function resolveAbsoluteUrl(url: string, baseUrl: string): string {
  try {
    return new URL(url, baseUrl).toString()
  } catch {
    return url
  }
}

function extractTitleFromHtml(html: string): string | undefined {
  const title = extractHtmlTagContent(html, 'title')
  const normalized = title ? stripHtml(title) : ''
  return normalized || undefined
}

function convertInlineHtmlToMarkdown(input: string, baseUrl: string): string {
  return decodeHtmlEntities(
    input
      .replace(
        /<img\b[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*>/gi,
        (_, src, alt) => `![${stripHtml(alt)}](${resolveAbsoluteUrl(src, baseUrl)})`
      )
      .replace(
        /<img\b[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']+)["'][^>]*>/gi,
        (_, alt, src) => `![${stripHtml(alt)}](${resolveAbsoluteUrl(src, baseUrl)})`
      )
      .replace(
        /<img\b[^>]*src=["']([^"']+)["'][^>]*>/gi,
        (_, src) => `![](${resolveAbsoluteUrl(src, baseUrl)})`
      )
      .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
        const label = stripHtml(text) || resolveAbsoluteUrl(href, baseUrl)
        return `[${label}](${resolveAbsoluteUrl(href, baseUrl)})`
      })
      .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, text) => `**${stripHtml(text)}**`)
      .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, text) => `*${stripHtml(text)}*`)
      .replace(
        /<code\b[^>]*>([\s\S]*?)<\/code>/gi,
        (_, text) => `\`${stripHtml(text).replace(/`/g, '\\`')}\``
      )
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim()
}

function convertHtmlToMarkdown(html: string, baseUrl: string): string {
  let markdown = sanitizeHtmlForContent(extractPreferredContentHtml(html))

  markdown = markdown
    .replace(
      /<pre\b[^>]*><code\b[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
      (_, code) =>
        `\n\n@@CODE_BLOCK_START@@\n${decodeHtmlEntities(code).trim()}\n@@CODE_BLOCK_END@@\n\n`
    )
    .replace(
      /<pre\b[^>]*>([\s\S]*?)<\/pre>/gi,
      (_, code) => `\n\n@@CODE_BLOCK_START@@\n${stripHtml(code)}\n@@CODE_BLOCK_END@@\n\n`
    )
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_, level, text) =>
        `\n\n${'#'.repeat(Number(level))} ${convertInlineHtmlToMarkdown(text, baseUrl)}\n\n`
    )
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, text) => {
      const lines = convertInlineHtmlToMarkdown(text, baseUrl)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      return `\n\n${lines.map((line) => `> ${line}`).join('\n')}\n\n`
    })
    .replace(
      /<li\b[^>]*>([\s\S]*?)<\/li>/gi,
      (_, text) => `- ${convertInlineHtmlToMarkdown(text, baseUrl)}\n`
    )
    .replace(/<\/(ul|ol)>/gi, '\n')
    .replace(/<(ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<(p|div|section|article|main)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, text) => {
      const converted = convertInlineHtmlToMarkdown(text, baseUrl)
      return converted ? `\n\n${converted}\n\n` : '\n'
    })
    .replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, '')
    .replace(/<hr\s*\/?>/gi, '\n\n---\n\n')

  markdown = decodeHtmlEntities(markdown)
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/@@CODE_BLOCK_START@@/g, '```')
    .replace(/@@CODE_BLOCK_END@@/g, '```')
    .trim()

  return markdown
}

async function fetchUrlContent(
  request: WebFetchRequest,
  targetUrl: string
): Promise<WebFetchResult> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), request.timeout || 30000)
  const format = request.format ?? 'markdown'

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    })

    const finalUrl = response.url || targetUrl
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    const raw = await response.text()

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    let content = raw
    let title: string | undefined

    if (contentType.includes('text/html') || /<html\b|<body\b|<main\b|<article\b/i.test(raw)) {
      title = extractTitleFromHtml(raw)
      if (format === 'markdown') {
        content = convertHtmlToMarkdown(raw, finalUrl)
      } else if (format === 'text') {
        content = stripHtml(sanitizeHtmlForContent(extractPreferredContentHtml(raw)))
      }
    } else if (format === 'markdown') {
      content = raw.trim()
    } else if (format === 'text') {
      content = raw.trim()
    }

    return {
      url: targetUrl,
      finalUrl,
      ...(title ? { title } : {}),
      content,
      format
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      url: targetUrl,
      content: '',
      format,
      error: message
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

async function webFetch(request: WebFetchRequest): Promise<WebFetchResponse> {
  const results = await Promise.all(request.urls.map((url) => fetchUrlContent(request, url)))
  return {
    results,
    format: request.format ?? 'markdown',
    totalResults: results.filter((item) => !item.error).length
  }
}

function extractBaiduResults(html: string, maxResults: number): WebSearchResult[] {
  const headingRegex =
    /<h3\b[^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/gi
  const headings = Array.from(html.matchAll(headingRegex))
  const results: WebSearchResult[] = []
  const seen = new Set<string>()

  for (let index = 0; index < headings.length && results.length < maxResults; index += 1) {
    const match = headings[index]
    const rawUrl = match[1]
    const rawTitle = match[2]
    const title = stripHtml(rawTitle)
    const url = resolveSearchResultUrl('baidu', rawUrl)

    if (!title || !url) continue

    const dedupeKey = `${title}::${url}`
    if (seen.has(dedupeKey)) continue

    const start = match.index ?? 0
    const nextStart = headings[index + 1]?.index ?? Math.min(start + 4000, html.length)
    const section = html.slice(start, Math.min(nextStart, start + 4000))

    const snippetMatches = Array.from(
      section.matchAll(
        /<(div|span|p)\b[^>]*class=["'][^"']*(?:c-abstract|content-right_[^"']*|content-right|c-span-last|c-color-text|result-op[^"']*)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi
      )
    )

    const snippet =
      snippetMatches
        .map((candidate) => stripHtml(candidate[2]))
        .find((text) => !!text && text !== title) ?? stripHtml(section).replace(title, '').trim()

    seen.add(dedupeKey)
    results.push({
      title,
      url,
      content: snippet
    })
  }

  return results
}

function extractGoogleResults(html: string, maxResults: number): WebSearchResult[] {
  const headingRegex =
    /<a\b[^>]*href=["']([^"']*(?:\/url\?(?:[^"']*?[?&])?(?:q|url)=[^"']+|https?:\/\/[^"']+))["'][^>]*>[\s\S]*?<h3\b[^>]*>([\s\S]*?)<\/h3>/gi
  const headings = Array.from(html.matchAll(headingRegex))
  const results: WebSearchResult[] = []
  const seen = new Set<string>()

  for (let index = 0; index < headings.length && results.length < maxResults; index += 1) {
    const match = headings[index]
    const title = stripHtml(match[2])
    const url = resolveSearchResultUrl('google', match[1])

    if (!title || !url || url.includes('/search?')) continue

    const dedupeKey = `${title}::${url}`
    if (seen.has(dedupeKey)) continue

    const start = match.index ?? 0
    const nextStart = headings[index + 1]?.index ?? Math.min(start + 6000, html.length)
    const section = html.slice(start, Math.min(nextStart, start + 6000))
    const snippet = extractSnippet(
      section,
      [
        /<div\b[^>]*class=["'][^"']*(?:VwiC3b|yXK7lf|MUxGbd|kvH3mc)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
        /<span\b[^>]*class=["'][^"']*(?:aCOpRe|hgKElc)[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
        /<div\b[^>]*data-sncf=["'][^"']*["'][^>]*>([\s\S]*?)<\/div>/i
      ],
      title
    )

    seen.add(dedupeKey)
    results.push({ title, url, content: snippet })
  }

  return results
}

function extractBingResults(html: string, maxResults: number): WebSearchResult[] {
  const blockRegex = /<li\b[^>]*class=["'][^"']*b_algo[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi
  const blocks = Array.from(html.matchAll(blockRegex))
  const results: WebSearchResult[] = []
  const seen = new Set<string>()

  for (const block of blocks) {
    if (results.length >= maxResults) break
    const section = block[1]
    const headingMatch = section.match(
      /<h2\b[^>]*>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i
    )
    if (!headingMatch) continue

    const title = stripHtml(headingMatch[2])
    const url = resolveSearchResultUrl('bing', headingMatch[1])
    if (!title || !url) continue

    const dedupeKey = `${title}::${url}`
    if (seen.has(dedupeKey)) continue

    const snippet = extractSnippet(
      section,
      [
        /<div\b[^>]*class=["'][^"']*b_caption[^"']*["'][^>]*>[\s\S]*?<p>([\s\S]*?)<\/p>/i,
        /<p>([\s\S]*?)<\/p>/i
      ],
      title
    )

    seen.add(dedupeKey)
    results.push({ title, url, content: snippet })
  }

  return results
}

async function searchGoogle(request: WebSearchRequest): Promise<WebSearchResponse> {
  const searchUrl = `https://www.google.com/search?hl=en&num=${request.maxResults || 5}&gbv=1&q=${encodeURIComponent(request.query)}`
  const response = await makeHttpRequest(
    'GET',
    searchUrl,
    {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache'
    },
    undefined,
    request.timeout || 30000
  )

  if (response.statusCode !== 200) {
    throw new Error(`Google search error: ${response.statusCode}`)
  }

  if (
    /unusual traffic|detected unusual traffic|sorry\/index|To continue, please type/i.test(
      response.body
    )
  ) {
    throw new Error('Google blocked background crawling for this request')
  }

  const results = extractGoogleResults(response.body, request.maxResults || 5)
  if (results.length === 0) {
    throw new Error('Google returned no parseable search results')
  }

  return {
    results,
    query: request.query,
    provider: 'google',
    totalResults: results.length
  }
}

async function searchBing(request: WebSearchRequest): Promise<WebSearchResponse> {
  const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(request.query)}&count=${request.maxResults || 5}`
  const response = await makeHttpRequest(
    'GET',
    searchUrl,
    {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache'
    },
    undefined,
    request.timeout || 30000
  )

  if (response.statusCode !== 200) {
    throw new Error(`Bing search error: ${response.statusCode}`)
  }

  const results = extractBingResults(response.body, request.maxResults || 5)
  if (results.length === 0) {
    throw new Error('Bing returned no parseable search results')
  }

  return {
    results,
    query: request.query,
    provider: 'bing',
    totalResults: results.length
  }
}

async function searchBaidu(request: WebSearchRequest): Promise<WebSearchResponse> {
  const searchUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(request.query)}&rn=${request.maxResults || 5}`
  const response = await makeHttpRequest(
    'GET',
    searchUrl,
    {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache'
    },
    undefined,
    request.timeout || 30000
  )

  if (response.statusCode !== 200) {
    throw new Error(`Baidu search error: ${response.statusCode}`)
  }

  if (/百度安全验证|网络不给力|请输入验证码|verify/i.test(response.body)) {
    throw new Error('Baidu blocked background crawling for this request')
  }

  const results = extractBaiduResults(response.body, request.maxResults || 5)
  if (results.length === 0) {
    throw new Error('Baidu returned no parseable search results')
  }

  return {
    results,
    query: request.query,
    provider: 'baidu',
    totalResults: results.length
  }
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
    search_mode: request.searchMode || 'web'
  })

  const response = await makeHttpRequest(
    'POST',
    'https://api.tavily.com/search',
    {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body).toString()
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
      publishedDate: r.published_date
    })),
    query: request.query,
    provider: 'tavily',
    totalResults: results.length
  }
}

// Searxng Search API (uses fixed URL: https://searxng.org)
async function searchSearxng(request: WebSearchRequest): Promise<WebSearchResponse> {
  const baseUrl = 'https://searxng.org'
  const url = `${baseUrl}/search?q=${encodeURIComponent(request.query)}&format=json&limit=${request.maxResults || 5}`

  const response = await makeHttpRequest('GET', url, {}, undefined, request.timeout || 30000)

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
      publishedDate: r.published_date
    })),
    query: request.query,
    provider: 'searxng',
    totalResults: results.length
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
    searchMode: request.searchMode || 'web'
  })

  const response = await makeHttpRequest(
    'POST',
    'https://api.exa.ai/search',
    {
      'Content-Type': 'application/json',
      'x-api-key': request.apiKey
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
      publishedDate: r.publishedDate
    })),
    query: request.query,
    provider: 'exa',
    totalResults: results.length
  }
}

// Bocha Search API (Chinese search engine)
async function searchBocha(request: WebSearchRequest): Promise<WebSearchResponse> {
  if (!request.apiKey) {
    throw new Error('Bocha API key is required')
  }

  const body = JSON.stringify({
    query: request.query,
    limit: request.maxResults || 5
  })

  const response = await makeHttpRequest(
    'POST',
    'https://api.bocha.cn/search',
    {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${request.apiKey}`
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
      publishedDate: r.publishedDate
    })),
    query: request.query,
    provider: 'bocha',
    totalResults: results.length
  }
}

// Zhipu Search API
async function searchZhipu(request: WebSearchRequest): Promise<WebSearchResponse> {
  if (!request.apiKey) {
    throw new Error('Zhipu API key is required')
  }

  const body = JSON.stringify({
    prompt: request.query,
    max_results: request.maxResults || 5
  })

  const response = await makeHttpRequest(
    'POST',
    'https://open.bigmodel.cn/api/paas/v4/tools/search',
    {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${request.apiKey}`
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
      publishedDate: r.publishedDate
    })),
    query: request.query,
    provider: 'zhipu',
    totalResults: results.length
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
        content:
          'Exa MCP search requires an MCP server connection. Please configure an MCP server with Exa search capabilities.'
      }
    ],
    query: request.query,
    provider: 'exa-mcp',
    totalResults: 0
  }
}

// Main handler registration
export function registerWebSearchHandlers(): void {
  // Main web search handler
  ipcMain.handle(
    'web:search',
    async (_event, args: WebSearchRequest): Promise<WebSearchResponse | { error: string }> => {
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
            return await searchGoogle(args)
          case 'bing':
            return await searchBing(args)
          case 'baidu':
            return await searchBaidu(args)
          default:
            return { error: `Unsupported provider: ${args.provider}` }
        }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'web:fetch',
    async (_event, args: WebFetchRequest): Promise<WebFetchResponse | { error: string }> => {
      try {
        return await webFetch(args)
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // Config handler for getting web search configuration
  ipcMain.handle('web:search-config', async (): Promise<{ providers: string[] }> => {
    return {
      providers: [
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
    }
  })

  // Providers list handler
  ipcMain.handle(
    'web:search-providers',
    async (): Promise<{
      providers: Array<{ value: string; label: string; description: string }>
    }> => {
      return {
        providers: [
          { value: 'tavily', label: 'Tavily', description: 'AI-powered search API' },
          { value: 'searxng', label: 'Searxng', description: 'Open-source metasearch engine' },
          { value: 'exa', label: 'Exa', description: 'AI search API' },
          { value: 'exa-mcp', label: 'Exa MCP', description: 'Exa via MCP server' },
          { value: 'bocha', label: 'Bocha', description: 'Chinese search engine' },
          { value: 'zhipu', label: 'Zhipu', description: 'ZhiPu AI search' },
          { value: 'google', label: 'Google', description: 'Background crawl in main process' },
          { value: 'bing', label: 'Bing', description: 'Background crawl in main process' },
          { value: 'baidu', label: 'Baidu', description: 'Background crawl in main process' }
        ]
      }
    }
  )
}
