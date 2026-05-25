import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { getDefaultApiUserAgent } from '../lib/api-user-agent'

export interface SoulMarketInfo {
  id: string
  slug: string
  name: string
  description: string
  category?: string
  downloads: number
  updatedAt?: string
  filePath?: string
  url: string
  downloadUrl: string
}

export interface SoulCategoryInfo {
  value: string
  label: string
}

const SKILLS_MARKET_BASE_URL = 'https://skills.open-cowork.shop'
const SKILLS_MARKET_API_BASE_URL = `${SKILLS_MARKET_BASE_URL}/api/v1`

const FALLBACK_SOUL_CATEGORIES: SoulCategoryInfo[] = [
  { value: 'assistant', label: 'Assistant' },
  { value: 'workflow', label: 'Workflow' },
  { value: 'coding', label: 'Coding' },
  { value: 'writing', label: 'Writing' },
  { value: 'research', label: 'Research' },
  { value: 'roleplay', label: 'Roleplay' },
  { value: 'business', label: 'Business' },
  { value: 'learning', label: 'Learning' }
]

function normaliseSoulItem(s: Record<string, unknown>, index: number): SoulMarketInfo {
  const slug = String(s['slug'] ?? s['name'] ?? `soul-${index}`)
  const name = String(s['name'] ?? slug)
  const description = s['description'] != null ? String(s['description']) : ''
  const category = s['category'] != null ? String(s['category']) : undefined
  const downloads = Number(s['downloads'] ?? 0)
  const updatedAt = s['updatedAt'] != null ? String(s['updatedAt']) : undefined
  const url = `${SKILLS_MARKET_BASE_URL}/souls/${encodeURIComponent(slug)}`

  return {
    id: String(s['id'] ?? slug),
    slug,
    name,
    description,
    category,
    downloads: Number.isFinite(downloads) ? downloads : 0,
    updatedAt,
    filePath: s['filePath'] != null ? String(s['filePath']) : undefined,
    url,
    downloadUrl: `${SKILLS_MARKET_API_BASE_URL}/souls/${encodeURIComponent(slug)}/download`
  }
}

function parseSoulsResponse(json: Record<string, unknown>): {
  total: number
  souls: SoulMarketInfo[]
} {
  if (json['success'] === false) {
    const err = json['error'] as Record<string, unknown> | undefined
    throw new Error(String(err?.['message'] ?? 'SOUL marketplace API returned failure'))
  }

  const rawSouls = Array.isArray(json['data']) ? (json['data'] as Record<string, unknown>[]) : []
  const total = Number(json['total'] ?? rawSouls.length)

  return {
    total: Number.isFinite(total) ? total : rawSouls.length,
    souls: rawSouls.map((soul, index) => normaliseSoulItem(soul, index))
  }
}

function parseCategories(json: Record<string, unknown>): SoulCategoryInfo[] {
  if (json['success'] === false) return FALLBACK_SOUL_CATEGORIES
  const raw = Array.isArray(json['data']) ? json['data'] : []
  const categories = raw
    .map((item) => {
      if (typeof item === 'string') return { value: item, label: item }
      if (!item || typeof item !== 'object') return null
      const record = item as Record<string, unknown>
      const value = String(record['value'] ?? record['slug'] ?? record['name'] ?? '').trim()
      if (!value) return null
      return { value, label: String(record['label'] ?? record['name'] ?? value) }
    })
    .filter((item): item is SoulCategoryInfo => Boolean(item))

  return categories.length > 0 ? categories : FALLBACK_SOUL_CATEGORIES
}

async function fetchJson(url: string, apiKey?: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      Accept: 'application/json',
      'User-Agent': getDefaultApiUserAgent()
    }
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`SOUL marketplace API ${res.status}: ${body || 'Unknown error'}`)
  }

  return (await res.json()) as Record<string, unknown>
}

function resolveGlobalSoulPath(): string {
  return path.join(os.homedir(), '.open-cowork', 'SOUL.md')
}

function resolveProjectSoulPath(projectRootPath?: string): string | null {
  const root = projectRootPath?.trim()
  if (!root) return null
  return path.join(root, '.agents', 'SOUL.md')
}

export function registerSoulsHandlers(): void {
  ipcMain.handle(
    'souls:market-list',
    async (
      _event,
      args: {
        query?: string
        category?: string
        offset?: number
        limit?: number
        sortBy?: 'recent' | 'name'
        apiKey?: string
      }
    ): Promise<{ total: number; souls: SoulMarketInfo[] }> => {
      try {
        const limit = Math.min(args.limit ?? 20, 100)
        const page = Math.floor((args.offset ?? 0) / limit) + 1
        const params = new URLSearchParams({
          page: String(page),
          limit: String(limit),
          sortBy: args.sortBy ?? 'recent'
        })
        const query = args.query?.trim()
        const category = args.category?.trim()
        if (query) params.set('q', query)
        if (category) params.set('category', category)

        const json = await fetchJson(
          `${SKILLS_MARKET_API_BASE_URL}/souls/search?${params.toString()}`,
          args.apiKey
        )
        return parseSoulsResponse(json)
      } catch (err) {
        console.error('[Souls] Marketplace API error:', err)
        return { total: 0, souls: [] }
      }
    }
  )

  ipcMain.handle(
    'souls:categories',
    async (_event, args: { apiKey?: string } = {}): Promise<{ categories: SoulCategoryInfo[] }> => {
      try {
        const json = await fetchJson(`${SKILLS_MARKET_API_BASE_URL}/souls/categories`, args.apiKey)
        return { categories: parseCategories(json) }
      } catch (err) {
        console.error('[Souls] Categories API error:', err)
        return { categories: FALLBACK_SOUL_CATEGORIES }
      }
    }
  )

  ipcMain.handle(
    'souls:download-remote',
    async (
      _event,
      args: { slug?: string; downloadUrl?: string; apiKey?: string }
    ): Promise<{ content?: string; error?: string }> => {
      try {
        const slug = args.slug?.trim()
        if (!slug) return { error: 'Missing SOUL slug for marketplace download' }
        const downloadUrl =
          args.downloadUrl ??
          `${SKILLS_MARKET_API_BASE_URL}/souls/${encodeURIComponent(slug)}/download`
        const response = await fetch(downloadUrl, {
          headers: {
            ...(args.apiKey ? { Authorization: `Bearer ${args.apiKey}` } : {}),
            Accept: 'text/markdown, text/plain;q=0.9, */*;q=0.8',
            'User-Agent': getDefaultApiUserAgent()
          }
        })

        if (!response.ok) {
          const body = await response.text().catch(() => '')
          return {
            error: `SOUL marketplace download failed ${response.status}: ${body || 'Unknown error'}`
          }
        }

        return { content: await response.text() }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle(
    'souls:get-target-paths',
    async (_event, args: { projectRootPath?: string } = {}) => {
      const projectPath = resolveProjectSoulPath(args.projectRootPath)
      return {
        global: { available: true, path: resolveGlobalSoulPath() },
        project: { available: Boolean(projectPath), path: projectPath }
      }
    }
  )

  ipcMain.handle(
    'souls:install',
    async (
      _event,
      args: { content?: string; target?: 'global' | 'project'; projectRootPath?: string }
    ): Promise<{ success: boolean; path?: string; error?: string }> => {
      try {
        const content = args.content ?? ''
        if (!content.trim()) return { success: false, error: 'SOUL content is empty' }

        const targetPath =
          args.target === 'project'
            ? resolveProjectSoulPath(args.projectRootPath)
            : resolveGlobalSoulPath()
        if (!targetPath) return { success: false, error: 'Project SOUL target is unavailable' }

        fs.mkdirSync(path.dirname(targetPath), { recursive: true })
        fs.writeFileSync(targetPath, content, 'utf-8')
        return { success: true, path: targetPath }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    }
  )
}
