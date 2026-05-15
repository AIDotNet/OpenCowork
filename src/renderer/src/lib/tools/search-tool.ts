import { toolRegistry } from '../agent/tool-registry'
import { joinFsPath } from '../agent/memory-files'
import { IPC } from '../ipc/channels'
import { encodeStructuredToolResult } from './tool-result-format'
import type { ToolHandler } from './tool-types'

type SearchLimitReason = 'max_results' | 'max_output_bytes' | 'timeout' | 'max_depth' | null

type SearchBackend = 'local' | 'ssh' | 'cron'
type SearchEngine =
  | 'git_grep'
  | 'sidecar'
  | 'ripgrep'
  | 'node_fallback'
  | 'remote_rg'
  | 'remote_grep'

type SearchPathStyle = 'absolute' | 'relative_to_search_root'
type GrepMatchKind = 'match' | 'context'
type GrepOutputMode = 'matches' | 'files_with_matches' | 'files_without_matches' | 'count'

type SearchMeta = {
  backend: SearchBackend
  engine?: SearchEngine
  searchRoot?: string
  pathStyle: SearchPathStyle
  truncated: boolean
  timedOut: boolean
  limitReason: SearchLimitReason
  pattern: string
  include?: string | null
  exclude?: string | null
  outputMode?: GrepOutputMode
  hiddenIncluded: boolean
  ignoredDefaultsApplied: boolean
  respectGitignore?: boolean
  followSymlinks?: boolean
  searchTime?: number
  warnings?: string[]
  maxDepth?: number | null
  beforeContext?: number
  afterContext?: number
  maxResults?: number
  maxOutputBytes?: number
  maxLineLength?: number
}

type GlobToolResult = {
  kind: 'glob'
  matches: Array<{ path: string; type?: 'file' | 'directory' }>
  meta: SearchMeta
  error?: string
}

type GrepToolResult = {
  kind: 'grep'
  matches: Array<{
    path: string
    line?: number
    column?: number
    text?: string
    kind?: GrepMatchKind
    count?: number
  }>
  meta: SearchMeta
  output?: string
  error?: string
}

const PROMPT_SEARCH_MAX_MATCHES = 20
const PROMPT_SEARCH_FETCH_LIMIT = PROMPT_SEARCH_MAX_MATCHES + 1
const PROMPT_SEARCH_MAX_OUTPUT_BYTES = 8 * 1024
const PROMPT_GREP_MAX_LINE_LENGTH = 160
const PROMPT_GREP_MAX_MATCHES = 200
const PROMPT_GREP_MAX_OUTPUT_BYTES = 64 * 1024
const textEncoder = new TextEncoder()

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

function normalizeSearchEngine(value: unknown): SearchEngine | undefined {
  if (value === 'node') return 'node_fallback'
  return value === 'git_grep' ||
    value === 'sidecar' ||
    value === 'ripgrep' ||
    value === 'node_fallback' ||
    value === 'remote_rg' ||
    value === 'remote_grep'
    ? value
    : undefined
}

function normalizeWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function normalizeGrepOutputMode(value: unknown): GrepOutputMode {
  return value === 'files_with_matches' || value === 'files_without_matches' || value === 'count'
    ? value
    : 'matches'
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
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

function normalizeGrepPathValue(
  rawPath: unknown,
  searchRoot: string | undefined,
  pathStyle: SearchPathStyle
): string | null {
  if (typeof rawPath !== 'string') return null
  const trimmed = rawPath.trim()
  if (!trimmed) return null
  if (pathStyle === 'relative_to_search_root' && !isAbsolutePath(trimmed)) return trimmed
  if (isAbsolutePath(trimmed) || pathStyle === 'absolute' || !searchRoot) return trimmed
  return joinFsPath(searchRoot, trimmed)
}

function createBaseMeta(args: {
  backend: SearchBackend
  engine?: SearchEngine
  pattern: string
  include?: string | null
  exclude?: string | null
  outputMode?: GrepOutputMode
  searchRoot?: string
  pathStyle?: SearchPathStyle
  hiddenIncluded?: boolean
  ignoredDefaultsApplied?: boolean
  respectGitignore?: boolean
  followSymlinks?: boolean
  truncated?: boolean
  timedOut?: boolean
  limitReason?: SearchLimitReason
  searchTime?: number
  warnings?: string[]
  maxDepth?: number | null
  beforeContext?: number
  afterContext?: number
  maxResults?: number
  maxOutputBytes?: number
  maxLineLength?: number
}): SearchMeta {
  return {
    backend: args.backend,
    engine: args.engine,
    searchRoot: args.searchRoot,
    pathStyle: args.pathStyle ?? 'absolute',
    truncated: args.truncated === true,
    timedOut: args.timedOut === true,
    limitReason: args.limitReason ?? null,
    pattern: args.pattern,
    include: args.include ?? null,
    exclude: args.exclude ?? null,
    outputMode: args.outputMode ?? 'matches',
    hiddenIncluded: args.hiddenIncluded ?? true,
    ignoredDefaultsApplied: args.ignoredDefaultsApplied ?? true,
    respectGitignore: args.respectGitignore ?? true,
    followSymlinks: args.followSymlinks ?? false,
    searchTime: args.searchTime,
    warnings: args.warnings ?? [],
    maxDepth: args.maxDepth ?? null,
    beforeContext: args.beforeContext ?? 0,
    afterContext: args.afterContext ?? 0,
    maxResults: args.maxResults,
    maxOutputBytes: args.maxOutputBytes,
    maxLineLength: args.maxLineLength
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
    engine: normalizeSearchEngine(rawMeta?.engine),
    pattern: typeof rawMeta?.pattern === 'string' ? rawMeta.pattern : options.pattern,
    searchRoot: typeof rawMeta?.searchRoot === 'string' ? rawMeta.searchRoot : options.searchRoot,
    pathStyle:
      rawMeta?.pathStyle === 'relative_to_search_root' ? 'relative_to_search_root' : 'absolute',
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

function estimatePromptBytes(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).length
}

function normalizePromptGrepText(text: string): string {
  const normalized = text.trim()
  if (normalized.length <= PROMPT_GREP_MAX_LINE_LENGTH) return normalized
  return `${normalized.slice(0, Math.max(0, PROMPT_GREP_MAX_LINE_LENGTH - 3))}...`
}

function limitGlobResultForPrompt(result: GlobToolResult): GlobToolResult {
  const matches: Array<{ path: string; type?: 'file' | 'directory' }> = []
  let totalBytes = 2
  let limitReason: SearchLimitReason = null

  for (const item of result.matches) {
    if (matches.length >= PROMPT_SEARCH_MAX_MATCHES) {
      limitReason = 'max_results'
      break
    }

    const candidateBytes = estimatePromptBytes(item.path) + 1
    if (totalBytes + candidateBytes > PROMPT_SEARCH_MAX_OUTPUT_BYTES) {
      limitReason = 'max_output_bytes'
      break
    }

    matches.push(item)
    totalBytes += candidateBytes
  }

  if (!limitReason) return result
  return {
    ...result,
    matches,
    meta: {
      ...result.meta,
      truncated: true,
      limitReason: result.meta.limitReason ?? limitReason
    }
  }
}

function limitGrepResultForPrompt(result: GrepToolResult): GrepToolResult {
  const matches: GrepToolResult['matches'] = []
  let totalBytes = 2
  let limitReason: SearchLimitReason = null
  const maxMatches = Math.min(
    result.meta.maxResults ?? PROMPT_SEARCH_MAX_MATCHES,
    PROMPT_GREP_MAX_MATCHES
  )
  const maxOutputBytes = Math.min(
    result.meta.maxOutputBytes ?? PROMPT_SEARCH_MAX_OUTPUT_BYTES,
    PROMPT_GREP_MAX_OUTPUT_BYTES
  )

  for (const item of result.matches) {
    if (matches.length >= maxMatches) {
      limitReason = 'max_results'
      break
    }

    const normalizedItem = {
      ...item,
      text: typeof item.text === 'string' ? normalizePromptGrepText(item.text) : item.text
    }
    const candidateBytes =
      estimatePromptBytes({
        file: normalizedItem.path,
        line: normalizedItem.line,
        column: normalizedItem.column,
        text: normalizedItem.text,
        kind: normalizedItem.kind,
        count: normalizedItem.count
      }) + 1
    if (totalBytes + candidateBytes > maxOutputBytes) {
      limitReason = 'max_output_bytes'
      break
    }

    matches.push(normalizedItem)
    totalBytes += candidateBytes
  }

  if (!limitReason && matches.length === result.matches.length) {
    return { ...result, matches }
  }

  return {
    ...result,
    matches,
    meta: {
      ...result.meta,
      truncated: result.meta.truncated || limitReason !== null,
      limitReason: result.meta.limitReason ?? limitReason
    }
  }
}

function shouldUseCompactSearchPayload(meta: SearchMeta, error?: string): boolean {
  return (
    !error &&
    !meta.engine &&
    !meta.truncated &&
    !meta.timedOut &&
    (meta.warnings?.length ?? 0) === 0
  )
}

function formatGlobResultForPrompt(result: GlobToolResult): Record<string, unknown> | unknown[] {
  const limitedResult = limitGlobResultForPrompt(result)

  if (shouldUseCompactSearchPayload(limitedResult.meta, limitedResult.error)) {
    return limitedResult.matches.map((item) => item.path)
  }

  return {
    matches: limitedResult.matches.map((item) => item.path),
    truncated: limitedResult.meta.truncated,
    timedOut: limitedResult.meta.timedOut,
    limitReason: limitedResult.meta.limitReason,
    engine: limitedResult.meta.engine,
    warnings: limitedResult.meta.warnings,
    error: limitedResult.error
  }
}

function formatGrepLine(
  item: GrepToolResult['matches'][number],
  outputMode: GrepOutputMode
): string {
  if (outputMode === 'files_with_matches' || outputMode === 'files_without_matches') {
    return item.path
  }
  if (outputMode === 'count') return `${item.path}:${item.count ?? 0}`
  if (typeof item.line !== 'number') return item.path
  const separator = item.kind === 'context' ? '-' : ':'
  if (typeof item.column === 'number' && item.kind !== 'context') {
    return `${item.path}${separator}${item.line}${separator}${item.column}${separator}${
      item.text ?? ''
    }`
  }
  return `${item.path}${separator}${item.line}${separator}${item.text ?? ''}`
}

function formatGrepOutput(result: GrepToolResult): string {
  const outputMode = result.meta.outputMode ?? 'matches'
  return result.matches.map((item) => formatGrepLine(item, outputMode)).join('\n')
}

function formatGrepResultForPrompt(result: GrepToolResult): string | Record<string, unknown> {
  const limitedResult = limitGrepResultForPrompt(result)
  const output = limitedResult.output ?? formatGrepOutput(limitedResult)

  if (output && shouldUseCompactSearchPayload(limitedResult.meta, limitedResult.error)) {
    return output
  }

  return {
    output,
    matches: limitedResult.matches.map((item) => ({
      file: item.path,
      line: item.line,
      column: item.column,
      text: item.text,
      kind: item.kind,
      count: item.count
    })),
    truncated: limitedResult.meta.truncated,
    timedOut: limitedResult.meta.timedOut,
    limitReason: limitedResult.meta.limitReason,
    engine: limitedResult.meta.engine,
    warnings: limitedResult.meta.warnings,
    error: limitedResult.error
  }
}

function normalizeGrepMatchItem(
  item: unknown,
  searchRoot: string | undefined,
  pathStyle: SearchPathStyle
): GrepToolResult['matches'][number] | null {
  if (!isRecord(item)) return null
  const path = normalizeGrepPathValue(item.path ?? item.file, searchRoot, pathStyle)
  if (!path) return null
  return {
    path,
    line: typeof item.line === 'number' ? item.line : undefined,
    column: typeof item.column === 'number' ? item.column : undefined,
    text: typeof item.text === 'string' ? item.text : '',
    kind: item.kind === 'context' ? 'context' : 'match',
    count: typeof item.count === 'number' ? item.count : undefined
  }
}

function normalizeGrepResult(
  raw: unknown,
  options: {
    backend: SearchBackend
    pattern: string
    searchRoot?: string
    include?: string | null
    exclude?: string | null
  }
): GrepToolResult {
  const fallbackMeta = createBaseMeta({
    backend: options.backend,
    pattern: options.pattern,
    include: options.include,
    exclude: options.exclude,
    searchRoot: options.searchRoot,
    pathStyle: 'relative_to_search_root'
  })

  if (Array.isArray(raw)) {
    return {
      kind: 'grep',
      matches: raw
        .map((item) => normalizeGrepMatchItem(item, options.searchRoot, 'absolute'))
        .filter((item): item is GrepToolResult['matches'][number] => !!item),
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
    engine: normalizeSearchEngine(rawMeta?.engine ?? raw.engine),
    pattern: typeof rawMeta?.pattern === 'string' ? rawMeta.pattern : options.pattern,
    include: typeof rawMeta?.include === 'string' ? rawMeta.include : options.include,
    exclude: typeof rawMeta?.exclude === 'string' ? rawMeta.exclude : options.exclude,
    outputMode: normalizeGrepOutputMode(rawMeta?.outputMode),
    searchRoot: typeof rawMeta?.searchRoot === 'string' ? rawMeta.searchRoot : options.searchRoot,
    pathStyle:
      rawMeta?.pathStyle === 'relative_to_search_root' ? 'relative_to_search_root' : 'absolute',
    truncated: rawMeta?.truncated === true || raw.truncated === true,
    timedOut: rawMeta?.timedOut === true || raw.timedOut === true,
    limitReason: normalizeLimitReason(rawMeta?.limitReason ?? raw.limitReason),
    hiddenIncluded: rawMeta?.hiddenIncluded !== false,
    ignoredDefaultsApplied: rawMeta?.ignoredDefaultsApplied !== false,
    respectGitignore: rawMeta?.respectGitignore !== false,
    followSymlinks: rawMeta?.followSymlinks === true,
    searchTime:
      typeof rawMeta?.searchTime === 'number'
        ? rawMeta.searchTime
        : typeof raw.searchTime === 'number'
          ? raw.searchTime
          : undefined,
    warnings: normalizeWarnings(rawMeta?.warnings),
    maxDepth: typeof rawMeta?.maxDepth === 'number' ? rawMeta.maxDepth : null,
    beforeContext: typeof rawMeta?.beforeContext === 'number' ? rawMeta.beforeContext : 0,
    afterContext: typeof rawMeta?.afterContext === 'number' ? rawMeta.afterContext : 0,
    maxResults: normalizeOptionalNumber(rawMeta?.maxResults),
    maxOutputBytes: normalizeOptionalNumber(rawMeta?.maxOutputBytes),
    maxLineLength: normalizeOptionalNumber(rawMeta?.maxLineLength)
  })

  const matchesSource = Array.isArray(raw.matches)
    ? raw.matches
    : Array.isArray(raw.results)
      ? raw.results
      : []

  const matches = matchesSource
    .map((item) => normalizeGrepMatchItem(item, meta.searchRoot, meta.pathStyle))
    .filter((item): item is GrepToolResult['matches'][number] => !!item)

  return {
    kind: 'grep',
    matches,
    meta,
    output: typeof raw.output === 'string' ? raw.output : undefined,
    error: typeof raw.error === 'string' ? raw.error : undefined
  }
}

const globHandler: ToolHandler = {
  definition: {
    name: 'Glob',
    description: 'Fast file pattern matching tool (returns at most 20 matches)',
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
        path: resolvedPath,
        limit: PROMPT_SEARCH_FETCH_LIMIT
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
      path: resolvedPath,
      limit: PROMPT_SEARCH_FETCH_LIMIT
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
    description:
      'Search file contents. Uses git grep in Git worktrees, then falls back to ripgrep/Node search. Defaults to grep-like file:line:text output.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        patterns: {
          type: 'array',
          items: {
            anyOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  pattern: { type: 'string' },
                  not: { type: 'boolean' }
                },
                required: ['pattern']
              }
            ]
          },
          description: 'Multiple patterns. Strings are positive patterns; objects may set not=true.'
        },
        path: {
          type: 'string',
          description: 'Directory to search in (absolute or relative to the working folder)'
        },
        pathspecs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Git pathspecs to include or exclude, e.g. :(glob)src/**/*.ts'
        },
        include: {
          type: 'string',
          description: 'Comma-separated file globs to include, e.g. *.ts,*.tsx'
        },
        exclude: { type: 'string', description: 'Comma-separated file globs to exclude' },
        patternMode: {
          type: 'string',
          enum: ['fixed', 'basic', 'extended', 'perl'],
          description: 'Pattern dialect, matching git grep -F/-G/-E/-P. Default perl.'
        },
        patternOperator: {
          type: 'string',
          enum: ['or', 'and'],
          description: 'How multiple positive patterns are combined. Default or.'
        },
        notPatterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Negative patterns, like git grep --not -e pattern'
        },
        allMatch: {
          type: 'boolean',
          description:
            'Only return files that match every positive pattern, like git grep --all-match'
        },
        caseSensitive: { type: 'boolean', description: 'Use case-sensitive matching' },
        ignoreCase: { type: 'boolean', description: 'Use case-insensitive matching' },
        smartCase: {
          type: 'boolean',
          description: 'Case-sensitive only when the pattern has uppercase'
        },
        literal: { type: 'boolean', description: 'Treat pattern as a literal string' },
        fixedStrings: { type: 'boolean', description: 'Alias for patternMode=fixed' },
        extendedRegexp: { type: 'boolean', description: 'Alias for patternMode=extended' },
        basicRegexp: { type: 'boolean', description: 'Alias for patternMode=basic' },
        perlRegexp: { type: 'boolean', description: 'Alias for patternMode=perl' },
        word: { type: 'boolean', description: 'Match whole words only' },
        line: { type: 'boolean', description: 'Match whole lines only' },
        invertMatch: { type: 'boolean', description: 'Return non-matching lines' },
        onlyMatching: { type: 'boolean', description: 'Return only the matching text spans' },
        column: { type: 'boolean', description: 'Include first-match column numbers' },
        context: {
          type: 'number',
          description: 'Number of context lines before and after each match'
        },
        beforeContext: { type: 'number', description: 'Number of context lines before each match' },
        afterContext: { type: 'number', description: 'Number of context lines after each match' },
        maxCount: { type: 'number', description: 'Maximum matches per file, like git grep -m' },
        maxResults: { type: 'number', description: 'Maximum result rows to return (default 20)' },
        maxOutputBytes: { type: 'number', description: 'Maximum encoded result size' },
        maxLineLength: { type: 'number', description: 'Maximum text length per result line' },
        maxDepth: { type: 'number', description: 'Maximum directory depth to search' },
        hidden: { type: 'boolean', description: 'Include hidden files and directories' },
        respectGitignore: { type: 'boolean', description: 'Respect .gitignore files' },
        excludeStandard: { type: 'boolean', description: 'Use git grep --exclude-standard' },
        followSymlinks: { type: 'boolean', description: 'Follow symbolic links' },
        untracked: { type: 'boolean', description: 'Search untracked files in Git worktrees' },
        cached: { type: 'boolean', description: 'Search the Git index instead of the worktree' },
        noIndex: { type: 'boolean', description: 'Use git grep --no-index style directory search' },
        text: { type: 'boolean', description: 'Process binary files as text' },
        textconv: { type: 'boolean', description: 'Use Git textconv filters when available' },
        threads: { type: 'number', description: 'Worker threads for git grep' },
        outputMode: {
          type: 'string',
          enum: ['matches', 'files_with_matches', 'files_without_matches', 'count'],
          description:
            'matches returns file:line:text, files_with_matches returns paths, files_without_matches returns paths without matches, count returns file:count'
        },
        pathStyle: {
          type: 'string',
          enum: ['relative', 'absolute'],
          description: 'Return relative or absolute paths'
        }
      },
      required: ['pattern']
    }
  },
  execute: async (input, ctx) => {
    const resolvedPath = resolveSearchPath(input.path, ctx.workingFolder)
    const backend: SearchBackend = ctx.sshConnectionId ? 'ssh' : 'local'
    const grepRequest = {
      pattern: input.pattern,
      patterns: input.patterns,
      path: resolvedPath,
      pathspecs: input.pathspecs,
      include: input.include,
      exclude: input.exclude,
      patternMode: input.patternMode,
      patternOperator: input.patternOperator,
      notPatterns: input.notPatterns,
      allMatch: input.allMatch,
      caseSensitive: input.caseSensitive,
      ignoreCase: input.ignoreCase,
      smartCase: input.smartCase,
      literal: input.literal,
      fixedStrings: input.fixedStrings,
      extendedRegexp: input.extendedRegexp,
      basicRegexp: input.basicRegexp,
      perlRegexp: input.perlRegexp,
      word: input.word,
      line: input.line,
      invertMatch: input.invertMatch,
      onlyMatching: input.onlyMatching,
      column: input.column,
      context: input.context,
      beforeContext: input.beforeContext,
      afterContext: input.afterContext,
      maxCount: input.maxCount,
      maxResults: input.maxResults,
      maxOutputBytes: input.maxOutputBytes,
      maxLineLength: input.maxLineLength,
      maxDepth: input.maxDepth,
      hidden: input.hidden,
      respectGitignore: input.respectGitignore,
      excludeStandard: input.excludeStandard,
      followSymlinks: input.followSymlinks,
      untracked: input.untracked,
      cached: input.cached,
      noIndex: input.noIndex,
      text: input.text,
      textconv: input.textconv,
      threads: input.threads,
      outputMode: input.outputMode,
      pathStyle: input.pathStyle
    }
    if (ctx.sshConnectionId) {
      const result = await ctx.ipc.invoke(IPC.SSH_FS_GREP, {
        ...grepRequest,
        connectionId: ctx.sshConnectionId
      })
      const formatted = formatGrepResultForPrompt(
        normalizeGrepResult(result, {
          backend,
          pattern: String(input.pattern ?? ''),
          searchRoot: resolvedPath,
          include: typeof input.include === 'string' ? input.include : null,
          exclude: typeof input.exclude === 'string' ? input.exclude : null
        })
      )
      return typeof formatted === 'string' ? formatted : encodeStructuredToolResult(formatted)
    }
    const result = await ctx.ipc.invoke(IPC.FS_GREP, {
      ...grepRequest
    })
    const formatted = formatGrepResultForPrompt(
      normalizeGrepResult(result, {
        backend,
        pattern: String(input.pattern ?? ''),
        searchRoot: resolvedPath,
        include: typeof input.include === 'string' ? input.include : null,
        exclude: typeof input.exclude === 'string' ? input.exclude : null
      })
    )
    return typeof formatted === 'string' ? formatted : encodeStructuredToolResult(formatted)
  },
  requiresApproval: () => false
}

export function registerSearchTools(): void {
  toolRegistry.register(globHandler)
  toolRegistry.register(grepHandler)
}
