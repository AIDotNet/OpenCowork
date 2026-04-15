import { toolRegistry } from '../agent/tool-registry'
import { joinFsPath } from '../agent/memory-files'
import { IPC } from '../ipc/channels'
import { encodeStructuredToolResult } from './tool-result-format'
import type { ToolHandler } from './tool-types'

type SearchLimitReason = 'max_results' | 'max_output_bytes' | 'timeout' | 'max_depth' | null

type SearchBackend = 'local' | 'ssh' | 'cron'

type SearchPathStyle = 'absolute' | 'relative_to_search_root'

type SearchMeta = {
  backend: SearchBackend
  searchRoot?: string
  pathStyle: SearchPathStyle
  truncated: boolean
  timedOut: boolean
  limitReason: SearchLimitReason
  pattern: string
  include?: string | null
  hiddenIncluded: boolean
  ignoredDefaultsApplied: boolean
  searchTime?: number
  warnings?: string[]
  maxDepth?: number | null
}

type GlobToolResult = {
  kind: 'glob'
  matches: Array<{ path: string; type?: 'file' | 'directory' }>
  meta: SearchMeta
  error?: string
}

type GrepToolResult = {
  kind: 'grep'
  matches: Array<{ path: string; line: number; text: string }>
  meta: SearchMeta
  error?: string
}

function isAbsolutePath(p: string): boolean {
  if (!p) return false
  if (p.startsWith('/') || p.startsWith('\\')) return true
  return /^[a-zA-Z]:[\\/]/.test(p)
}

function resolveSearchPath(inputPath: unknown, workingFolder?: string): string | undefined {
  const raw = typeof inputPath === 'string' ? inputPath.trim() : ''
  const base = workingFolder?.trim()
  if (!raw || raw === '.') {
    return base && base.length > 0 ? base : undefined
  }
  if (isAbsolutePath(raw)) return raw
  if (base && base.length > 0) return joinFsPath(base, raw)
  return raw
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeLimitReason(value: unknown): SearchLimitReason {
  return value === 'max_results' ||
    value === 'max_output_bytes' ||
    value === 'timeout' ||
    value === 'max_depth'
    ? value
    : null
}

function normalizeWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function normalizePathValue(
  rawPath: unknown,
  searchRoot: string | undefined,
  pathStyle: SearchPathStyle
): string | null {
  if (typeof rawPath !== 'string') return null
  const trimmed = rawPath.trim()
  if (!trimmed) return null
  if (isAbsolutePath(trimmed) || pathStyle === 'absolute' || !searchRoot) return trimmed
  return joinFsPath(searchRoot, trimmed)
}

function createBaseMeta(args: {
  backend: SearchBackend
  pattern: string
  include?: string | null
  searchRoot?: string
  pathStyle?: SearchPathStyle
  hiddenIncluded?: boolean
  ignoredDefaultsApplied?: boolean
  truncated?: boolean
  timedOut?: boolean
  limitReason?: SearchLimitReason
  searchTime?: number
  warnings?: string[]
  maxDepth?: number | null
}): SearchMeta {
  return {
    backend: args.backend,
    searchRoot: args.searchRoot,
    pathStyle: args.pathStyle ?? 'absolute',
    truncated: args.truncated === true,
    timedOut: args.timedOut === true,
    limitReason: args.limitReason ?? null,
    pattern: args.pattern,
    include: args.include ?? null,
    hiddenIncluded: args.hiddenIncluded ?? true,
    ignoredDefaultsApplied: args.ignoredDefaultsApplied ?? true,
    searchTime: args.searchTime,
    warnings: args.warnings ?? [],
    maxDepth: args.maxDepth ?? null
  }
}

function normalizeGlobResult(
  raw: unknown,
  options: {
    backend: SearchBackend
    pattern: string
    searchRoot?: string
  }
): GlobToolResult {
  const fallbackMeta = createBaseMeta({
    backend: options.backend,
    pattern: options.pattern,
    searchRoot: options.searchRoot,
    pathStyle: 'absolute'
  })

  if (Array.isArray(raw)) {
    return {
      kind: 'glob',
      matches: raw
        .map((item) => normalizePathValue(item, options.searchRoot, 'relative_to_search_root'))
        .filter((item): item is string => !!item)
        .map((path) => ({ path })),
      meta: fallbackMeta
    }
  }

  if (!isRecord(raw)) {
    return {
      kind: 'glob',
      matches: [],
      meta: fallbackMeta,
      error: raw == null ? undefined : String(raw)
    }
  }

  const rawMeta = isRecord(raw.meta) ? raw.meta : null
  const meta = createBaseMeta({
    backend:
      rawMeta?.backend === 'ssh' || rawMeta?.backend === 'cron' || rawMeta?.backend === 'local'
        ? rawMeta.backend
        : options.backend,
    pattern: typeof rawMeta?.pattern === 'string' ? rawMeta.pattern : options.pattern,
    searchRoot:
      typeof rawMeta?.searchRoot === 'string' ? rawMeta.searchRoot : options.searchRoot,
    pathStyle: rawMeta?.pathStyle === 'relative_to_search_root' ? 'relative_to_search_root' : 'absolute',
    truncated: rawMeta?.truncated === true,
    timedOut: rawMeta?.timedOut === true,
    limitReason: normalizeLimitReason(rawMeta?.limitReason),
    hiddenIncluded: rawMeta?.hiddenIncluded !== false,
    ignoredDefaultsApplied: rawMeta?.ignoredDefaultsApplied !== false,
    searchTime: typeof rawMeta?.searchTime === 'number' ? rawMeta.searchTime : undefined,
    warnings: normalizeWarnings(rawMeta?.warnings),
    maxDepth: typeof rawMeta?.maxDepth === 'number' ? rawMeta.maxDepth : null
  })

  const matchesSource = Array.isArray(raw.matches)
    ? raw.matches
    : Array.isArray(raw.results)
      ? raw.results
      : []

  const matches = matchesSource
    .map((item) => {
      if (typeof item === 'string') {
        const path = normalizePathValue(item, meta.searchRoot, meta.pathStyle)
        return path ? { path } : null
      }
      if (!isRecord(item)) return null
      const path = normalizePathValue(item.path, meta.searchRoot, meta.pathStyle)
      if (!path) return null
      const type = item.type === 'directory' || item.type === 'file' ? item.type : undefined
      return { path, type }
    })
    .filter((item): item is { path: string; type?: 'file' | 'directory' } => !!item)

  return {
    kind: 'glob',
    matches,
    meta,
    error: typeof raw.error === 'string' ? raw.error : undefined
  }
}

function shouldUseCompactSearchPayload(meta: SearchMeta, error?: string): boolean {
  return !error && !meta.truncated && !meta.timedOut && (meta.warnings?.length ?? 0) === 0
}

function formatGlobResultForPrompt(result: GlobToolResult): Record<string, unknown> | unknown[] {
  if (shouldUseCompactSearchPayload(result.meta, result.error)) {
    return result.matches.map((item) => item.path)
  }

  return {
    matches: result.matches.map((item) => item.path),
    truncated: result.meta.truncated,
    timedOut: result.meta.timedOut,
    limitReason: result.meta.limitReason,
    warnings: result.meta.warnings,
    error: result.error
  }
}

function formatGrepResultForPrompt(result: GrepToolResult): Record<string, unknown> | unknown[] {
  const compactMatches = result.matches.map((item) => ({
    file: item.path,
    line: item.line,
    text: item.text
  }))

  if (shouldUseCompactSearchPayload(result.meta, result.error)) {
    return compactMatches
  }

  return {
    matches: compactMatches,
    truncated: result.meta.truncated,
    timedOut: result.meta.timedOut,
    limitReason: result.meta.limitReason,
    warnings: result.meta.warnings,
    error: result.error
  }
}

function normalizeGrepResult(
  raw: unknown,
  options: {
    backend: SearchBackend
    pattern: string
    searchRoot?: string
    include?: string | null
  }
): GrepToolResult {
  const fallbackMeta = createBaseMeta({
    backend: options.backend,
    pattern: options.pattern,
    include: options.include,
    searchRoot: options.searchRoot,
    pathStyle: 'absolute'
  })

  if (Array.isArray(raw)) {
    return {
      kind: 'grep',
      matches: raw
        .map((item) => {
          if (!isRecord(item)) return null
          const path = normalizePathValue(item.file ?? item.path, options.searchRoot, 'absolute')
          const line = typeof item.line === 'number' ? item.line : null
          const text = typeof item.text === 'string' ? item.text : ''
          if (!path || line == null) return null
          return { path, line, text }
        })
        .filter((item): item is { path: string; line: number; text: string } => !!item),
      meta: fallbackMeta
    }
  }

  if (!isRecord(raw)) {
    return {
      kind: 'grep',
      matches: [],
      meta: fallbackMeta,
      error: raw == null ? undefined : String(raw)
    }
  }

  const rawMeta = isRecord(raw.meta) ? raw.meta : null
  const meta = createBaseMeta({
    backend:
      rawMeta?.backend === 'ssh' || rawMeta?.backend === 'cron' || rawMeta?.backend === 'local'
        ? rawMeta.backend
        : options.backend,
    pattern: typeof rawMeta?.pattern === 'string' ? rawMeta.pattern : options.pattern,
    include: typeof rawMeta?.include === 'string' ? rawMeta.include : options.include,
    searchRoot:
      typeof rawMeta?.searchRoot === 'string' ? rawMeta.searchRoot : options.searchRoot,
    pathStyle: rawMeta?.pathStyle === 'relative_to_search_root' ? 'relative_to_search_root' : 'absolute',
    truncated: rawMeta?.truncated === true || raw.truncated === true,
    timedOut: rawMeta?.timedOut === true || raw.timedOut === true,
    limitReason: normalizeLimitReason(rawMeta?.limitReason ?? raw.limitReason),
    hiddenIncluded: rawMeta?.hiddenIncluded !== false,
    ignoredDefaultsApplied: rawMeta?.ignoredDefaultsApplied !== false,
    searchTime:
      typeof rawMeta?.searchTime === 'number'
        ? rawMeta.searchTime
        : typeof raw.searchTime === 'number'
          ? raw.searchTime
          : undefined,
    warnings: normalizeWarnings(rawMeta?.warnings),
    maxDepth: typeof rawMeta?.maxDepth === 'number' ? rawMeta.maxDepth : null
  })

  const matchesSource = Array.isArray(raw.matches)
    ? raw.matches
    : Array.isArray(raw.results)
      ? raw.results
      : []

  const matches = matchesSource
    .map((item) => {
      if (!isRecord(item)) return null
      const path = normalizePathValue(item.path ?? item.file, meta.searchRoot, meta.pathStyle)
      const line = typeof item.line === 'number' ? item.line : null
      const text = typeof item.text === 'string' ? item.text : ''
      if (!path || line == null) return null
      return { path, line, text }
    })
    .filter((item): item is { path: string; line: number; text: string } => !!item)

  return {
    kind: 'grep',
    matches,
    meta,
    error: typeof raw.error === 'string' ? raw.error : undefined
  }
}

const globHandler: ToolHandler = {
  definition: {
    name: 'Glob',
    description: 'Fast file pattern matching tool',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match files' },
        path: {
          type: 'string',
          description: 'Optional search directory (absolute or relative to the working folder)'
        }
      },
      required: ['pattern']
    }
  },
  execute: async (input, ctx) => {
    const resolvedPath = resolveSearchPath(input.path, ctx.workingFolder)
    const backend: SearchBackend = ctx.sshConnectionId ? 'ssh' : 'local'
    if (ctx.sshConnectionId) {
      const result = await ctx.ipc.invoke(IPC.SSH_FS_GLOB, {
        connectionId: ctx.sshConnectionId,
        pattern: input.pattern,
        path: resolvedPath
      })
      return encodeStructuredToolResult(
        formatGlobResultForPrompt(
          normalizeGlobResult(result, {
            backend,
            pattern: String(input.pattern ?? ''),
            searchRoot: resolvedPath
          })
        )
      )
    }
    const result = await ctx.ipc.invoke(IPC.FS_GLOB, {
      pattern: input.pattern,
      path: resolvedPath
    })
    return encodeStructuredToolResult(
      formatGlobResultForPrompt(
        normalizeGlobResult(result, {
          backend,
          pattern: String(input.pattern ?? ''),
          searchRoot: resolvedPath
        })
      )
    )
  },
  requiresApproval: () => false
}

const grepHandler: ToolHandler = {
  definition: {
    name: 'Grep',
    description: 'Search file contents using regular expressions',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: {
          type: 'string',
          description: 'Directory to search in (absolute or relative to the working folder)'
        },
        include: { type: 'string', description: 'File pattern filter, e.g. *.ts' }
      },
      required: ['pattern']
    }
  },
  execute: async (input, ctx) => {
    const resolvedPath = resolveSearchPath(input.path, ctx.workingFolder)
    const backend: SearchBackend = ctx.sshConnectionId ? 'ssh' : 'local'
    if (ctx.sshConnectionId) {
      const result = await ctx.ipc.invoke(IPC.SSH_FS_GREP, {
        connectionId: ctx.sshConnectionId,
        pattern: input.pattern,
        path: resolvedPath,
        include: input.include
      })
      return encodeStructuredToolResult(
        formatGrepResultForPrompt(
          normalizeGrepResult(result, {
            backend,
            pattern: String(input.pattern ?? ''),
            searchRoot: resolvedPath,
            include: typeof input.include === 'string' ? input.include : null
          })
        )
      )
    }
    const result = await ctx.ipc.invoke(IPC.FS_GREP, {
      pattern: input.pattern,
      path: resolvedPath,
      include: input.include
    })
    return encodeStructuredToolResult(
      formatGrepResultForPrompt(
        normalizeGrepResult(result, {
          backend,
          pattern: String(input.pattern ?? ''),
          searchRoot: resolvedPath,
          include: typeof input.include === 'string' ? input.include : null
        })
      )
    )
  },
  requiresApproval: () => false
}

export function registerSearchTools(): void {
  toolRegistry.register(globHandler)
  toolRegistry.register(grepHandler)
}
