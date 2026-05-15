import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { Glob } from 'glob'
import { createInterface } from 'readline'
import { recordLocalTextWriteChange } from './agent-change-handlers'
import { safeSendToWindow } from '../window-ipc'
import { createGitIgnoreMatcher } from './gitignore-utils'
import { getSidecarManager } from './sidecar-manager'

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
  '.ico',
  '.tiff',
  '.heic',
  '.heif'
])

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif'
}

const MAX_FILE_READ_BYTES = 50 * 1024 * 1024 // 50 MB
const MAX_IMAGE_READ_BYTES = 20 * 1024 * 1024 // 20 MB
const MAX_LIST_DIR_ITEMS = 1_000
const MAX_GLOB_MATCHES = 1_000
const SEARCH_TOOL_MAX_RESULTS = 20

async function assertFileSize(filePath: string, limit: number): Promise<number> {
  const stat = await fs.promises.stat(filePath)
  if (stat.size > limit) {
    throw new Error(
      `File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB, limit ${(limit / 1024 / 1024).toFixed(0)} MB): ${filePath}`
    )
  }
  return stat.size
}

const FILE_SEARCH_CACHE_TTL_MS = 5_000
const FILE_SEARCH_MAX_RESULTS = 20
const FILE_SEARCH_CACHE_MAX_ENTRIES = 50
const fileSearchCache = new Map<string, { expiresAt: number; files: string[] }>()
const FILE_OPERATION_RETRY_DELAYS_MS = [40, 120, 250, 500, 1_000]

type GrepMatchKind = 'match' | 'context'
type GrepOutputMode = 'matches' | 'files_with_matches' | 'files_without_matches' | 'count'
type GrepPathStyle = 'relative' | 'absolute'
type GrepPatternMode = 'fixed' | 'basic' | 'extended' | 'perl'
type GrepPatternOperator = 'or' | 'and'
type GrepResultItem = {
  file: string
  line?: number
  column?: number
  text?: string
  kind?: GrepMatchKind
  count?: number
}
type GrepLimitReason = 'max_results' | 'max_output_bytes' | 'timeout' | null
type SearchBackend = 'local' | 'ssh' | 'cron'
type SearchPathStyle = 'absolute' | 'relative_to_search_root'
type SearchEngine = 'git_grep' | 'sidecar' | 'ripgrep' | 'node_fallback'

type SearchMeta = {
  backend: SearchBackend
  engine?: SearchEngine
  searchRoot: string
  pathStyle: SearchPathStyle
  truncated: boolean
  timedOut: boolean
  limitReason: GrepLimitReason
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

type FileOperationError = NodeJS.ErrnoException & { message: string }

interface GrepCollector {
  results: GrepResultItem[]
  append: (
    filePath: string,
    line: number,
    text: string,
    kind?: GrepMatchKind,
    column?: number
  ) => boolean
  appendFile: (filePath: string) => boolean
  appendCount: (filePath: string, count: number) => boolean
  readonly limitReason: GrepLimitReason
  readonly truncated: boolean
}

type GrepSearchOptions = {
  pattern: string
  patternMode: GrepPatternMode
  patterns: string[]
  notPatterns: string[]
  patternOperator: GrepPatternOperator
  allMatch: boolean
  include?: string
  exclude?: string
  includePatterns: string[]
  excludePatterns: string[]
  caseSensitive: boolean
  smartCase: boolean
  literal: boolean
  word: boolean
  line: boolean
  invertMatch: boolean
  onlyMatching: boolean
  column: boolean
  beforeContext: number
  afterContext: number
  maxResults: number
  maxOutputBytes: number
  maxLineLength: number
  maxCount: number | null
  maxDepth: number | null
  hidden: boolean
  respectGitignore: boolean
  excludeStandard: boolean
  followSymlinks: boolean
  outputMode: GrepOutputMode
  pathStyle: GrepPathStyle
  untracked: boolean
  cached: boolean
  noIndex: boolean
  index: boolean
  text: boolean
  textconv: boolean
  threads: number | null
  pathspecs: string[]
  pathspecIncludePatterns: string[]
  pathspecExcludePatterns: string[]
}

type ProcessTextResult = {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

const GREP_IGNORE_DIR_NAMES = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.bzr',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  'coverage',
  '.nyc_output',
  '.cache',
  '.parcel-cache',
  'vendor',
  'target',
  'bin',
  'obj',
  '.gradle',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.venv',
  'venv',
  'env'
]
const GREP_IGNORE_DIRS = new Set(GREP_IGNORE_DIR_NAMES)

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildGlobIgnorePatterns(pattern: string): string[] {
  const normalizedPattern = pattern.replace(/\\/g, '/')
  const ignorePatterns: string[] = []

  for (const dirName of GREP_IGNORE_DIRS) {
    const targetsDir = new RegExp(`(^|/)${escapeRegex(dirName)}(/|$)`).test(normalizedPattern)
    if (targetsDir) continue

    ignorePatterns.push(`${dirName}`)
    ignorePatterns.push(`${dirName}/**`)
    ignorePatterns.push(`**/${dirName}`)
    ignorePatterns.push(`**/${dirName}/**`)
  }

  return ignorePatterns
}

function isDefaultIgnoredDirName(name: string): boolean {
  return GREP_IGNORE_DIRS.has(name.toLowerCase())
}

function includesDefaultIgnoredDir(filePath: string, searchRoot: string): boolean {
  const absolutePath = path.resolve(searchRoot, filePath)
  const relativePath = path.relative(searchRoot, absolutePath)
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return false
  return relativePath.split(/[\\/]+/).some((part) => isDefaultIgnoredDirName(part))
}

const GREP_BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
  '.ico',
  '.mp4',
  '.avi',
  '.mov',
  '.mkv',
  '.mp3',
  '.wav',
  '.flac',
  '.zip',
  '.tar',
  '.gz',
  '.rar',
  '.7z',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.db',
  '.sqlite',
  '.sqlite3'
])

const GREP_DEFAULT_MAX_RESULTS = SEARCH_TOOL_MAX_RESULTS
const GREP_MAX_RESULTS = 200
const GREP_MAX_FILE_SIZE = 10 * 1024 * 1024
const GREP_TIMEOUT_MS = 30000
const GREP_DEFAULT_MAX_LINE_LENGTH = 160
const GREP_MAX_LINE_LENGTH = 1000
const GREP_DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024
const GREP_MAX_OUTPUT_BYTES = 64 * 1024
const GREP_MAX_CONTEXT_LINES = 20
const GREP_MAX_DEPTH = 50

function parseDelimitedPatterns(value?: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => parseDelimitedPatterns(item))
  }

  return (typeof value === 'string' ? value : '')
    .split(',')
    .map((pattern) => pattern.trim())
    .filter(Boolean)
}

function parsePatternList(value?: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => {
        if (typeof item === 'string') return [item]
        if (
          item &&
          typeof item === 'object' &&
          typeof (item as { pattern?: unknown }).pattern === 'string'
        ) {
          return [(item as { pattern: string }).pattern]
        }
        return []
      })
      .map((pattern) => pattern.trim())
      .filter(Boolean)
  }

  return typeof value === 'string' && value.trim() ? [value.trim()] : []
}

function parseGlobPatterns(value?: unknown): string[] {
  return parseDelimitedPatterns(value)
}

function normalizeGrepLine(text: string, maxLineLength: number): string {
  const normalized = text.trim()
  if (normalized.length <= maxLineLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLineLength - 3))}...`
}

function createIncludeMatcher(
  searchRoot: string,
  includePatterns: string[]
): (filePath: string) => boolean {
  if (includePatterns.length === 0) return () => true

  const includeRegexCache = new Map<string, RegExp>()
  const escapeRegExp = (value: string): string => value.replace(/[.+^${}()|[\]\\]/g, '\\$&')

  const toIncludeRegex = (globPattern: string): RegExp => {
    const cached = includeRegexCache.get(globPattern)
    if (cached) return cached

    const pattern = globPattern.replace(/\\/g, '/')
    const escaped = escapeRegExp(pattern)
    const regexBody = escaped
      .replace(/\*\*/g, '__DOUBLE_STAR__')
      .replace(/\*/g, '[^/]*')
      .replace(/__DOUBLE_STAR__/g, '.*')
      .replace(/\?/g, '.')

    const compiled = new RegExp(`^${regexBody}$`, 'i')
    includeRegexCache.set(globPattern, compiled)
    return compiled
  }

  return (filePath: string): boolean => {
    const relPath = path.relative(searchRoot, filePath).replace(/\\/g, '/')
    const fileName = path.basename(filePath)
    const ext = path.extname(filePath).toLowerCase()

    return includePatterns.some((rawPattern) => {
      let pattern = rawPattern.replace(/\\/g, '/')
      if (pattern.startsWith('./')) pattern = pattern.slice(2)
      if (pattern.startsWith('**/')) pattern = pattern.slice(3)

      if (pattern.startsWith('*.') && !pattern.includes('/')) {
        return ext === pattern.slice(1).toLowerCase()
      }

      if (!pattern.includes('*') && !pattern.includes('?')) {
        const lowered = pattern.toLowerCase()
        return (
          fileName.toLowerCase() === lowered || relPath.toLowerCase() === lowered || ext === lowered
        )
      }

      const regexPattern = toIncludeRegex(pattern)
      return regexPattern.test(relPath) || regexPattern.test(fileName)
    })
  }
}

function normalizeRipgrepGlob(pattern: string): string {
  let normalized = pattern.replace(/\\/g, '/')
  if (normalized.startsWith('./')) normalized = normalized.slice(2)
  if (normalized.startsWith('**/')) normalized = normalized.slice(3)
  if (!normalized.includes('*') && !normalized.includes('?') && normalized.startsWith('.')) {
    return `*${normalized}`
  }
  return normalized
}

function normalizeGitPathspecPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/+$/, '')
}

function splitGitPathspecMagic(pathspec: string): {
  pattern: string
  exclude: boolean
  hasMagic: boolean
} {
  const normalized = normalizeGitPathspecPath(pathspec.trim())
  if (!normalized) return { pattern: '', exclude: false, hasMagic: false }
  if (normalized.startsWith(':!') || normalized.startsWith(':^')) {
    return { pattern: normalized.slice(2), exclude: true, hasMagic: true }
  }
  if (!normalized.startsWith(':(')) {
    return { pattern: normalized, exclude: false, hasMagic: false }
  }

  const closeIndex = normalized.indexOf(')')
  if (closeIndex === -1) return { pattern: normalized, exclude: false, hasMagic: true }
  const magic = normalized
    .slice(2, closeIndex)
    .split(',')
    .map((item) => item.trim())
  return {
    pattern: normalized.slice(closeIndex + 1),
    exclude: magic.includes('exclude'),
    hasMagic: true
  }
}

function normalizeGitPathspecArgument(pathspec: string, forceExclude = false): string | null {
  const trimmed = normalizeGitPathspecPath(pathspec.trim())
  if (!trimmed) return null
  const parsed = splitGitPathspecMagic(trimmed)
  const exclude = forceExclude || parsed.exclude
  if (trimmed.startsWith(':(')) {
    if (!exclude || parsed.exclude) return trimmed
    return `:(exclude)${parsed.pattern}`
  }
  if (trimmed.startsWith(':!') || trimmed.startsWith(':^')) {
    return `:(exclude)${parsed.pattern}`
  }
  return exclude ? `:(exclude,glob)${trimmed}` : trimmed
}

function normalizeGitPathspecGlob(pattern: string): string {
  let normalized = pattern.replace(/\\/g, '/').trim()
  if (normalized.startsWith('./')) normalized = normalized.slice(2)
  if (!normalized.includes('*') && !normalized.includes('?') && normalized.startsWith('.')) {
    normalized = `*${normalized}`
  }
  return normalized
}

function joinGitPathspecGlob(base: string, globPattern: string): string {
  const normalizedBase = normalizeGitPathspecPath(base)
  const normalizedPattern = normalizeGitPathspecGlob(globPattern)
  const pattern = normalizedPattern.startsWith('**/')
    ? normalizedPattern.slice(3)
    : normalizedPattern

  if (!normalizedBase || normalizedBase === '.') {
    return pattern.includes('/') ? pattern : `**/${pattern}`
  }

  return pattern.includes('/') ? `${normalizedBase}/${pattern}` : `${normalizedBase}/**/${pattern}`
}

function buildGitGrepPathspecs(args: {
  repoRoot: string
  searchTarget: string
  targetIsDirectory: boolean
  options: GrepSearchOptions
}): string[] {
  const relativeTarget = normalizeGitPathspecPath(path.relative(args.repoRoot, args.searchTarget))
  const targetPathspec = relativeTarget || '.'
  const includePatterns = [...args.options.includePatterns, ...args.options.pathspecIncludePatterns]
  const excludePatterns = [...args.options.excludePatterns, ...args.options.pathspecExcludePatterns]
  const explicitPathspecs = args.options.pathspecs
    .map((pattern) => normalizeGitPathspecArgument(pattern))
    .filter((pattern): pattern is string => !!pattern)

  const pathspecs =
    args.targetIsDirectory && includePatterns.length > 0
      ? includePatterns.map((pattern) => `:(glob)${joinGitPathspecGlob(targetPathspec, pattern)}`)
      : [targetPathspec]

  pathspecs.push(...explicitPathspecs)

  for (const pattern of excludePatterns) {
    pathspecs.push(`:(exclude,glob)${joinGitPathspecGlob(targetPathspec, pattern)}`)
  }

  for (const pattern of args.options.pathspecs) {
    const parsed = splitGitPathspecMagic(pattern)
    if (!parsed.exclude) continue
    const normalized = normalizeGitPathspecArgument(pattern, true)
    if (normalized) pathspecs.push(normalized)
  }

  return pathspecs
}

function clampGrepNumber(value: unknown, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback
  const normalized = Math.floor(Number(value))
  if (normalized <= 0) return fallback
  return Math.min(normalized, max)
}

function clampGrepOptionalNumber(value: unknown, max: number): number | null {
  if (!Number.isFinite(value)) return null
  const normalized = Math.floor(Number(value))
  if (normalized <= 0) return null
  return Math.min(normalized, max)
}

function clampGrepContext(value: unknown): number {
  if (!Number.isFinite(value)) return 0
  const normalized = Math.floor(Number(value))
  if (normalized <= 0) return 0
  return Math.min(normalized, GREP_MAX_CONTEXT_LINES)
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function normalizeOptionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function normalizeGrepOutputMode(value: unknown): GrepOutputMode {
  return value === 'files_with_matches' || value === 'files_without_matches' || value === 'count'
    ? value
    : 'matches'
}

function normalizeGrepPathStyle(value: unknown): GrepPathStyle {
  return value === 'absolute' ? 'absolute' : 'relative'
}

function normalizeGrepPatternMode(args: {
  literal?: unknown
  fixed?: unknown
  fixedStrings?: unknown
  basic?: unknown
  basicRegexp?: unknown
  extended?: unknown
  extendedRegexp?: unknown
  perl?: unknown
  perlRegexp?: unknown
  patternMode?: unknown
  regexpType?: unknown
  regexMode?: unknown
}): GrepPatternMode {
  const mode = args.patternMode ?? args.regexpType ?? args.regexMode
  if (mode === 'fixed' || mode === 'literal' || mode === 'fixed_strings') return 'fixed'
  if (mode === 'basic' || mode === 'basic_regexp') return 'basic'
  if (mode === 'extended' || mode === 'extended_regexp') return 'extended'
  if (mode === 'perl' || mode === 'perl_regexp' || mode === 'pcre') return 'perl'
  if (args.literal === true || args.fixed === true || args.fixedStrings === true) {
    return 'fixed'
  }
  if (args.basic === true || args.basicRegexp === true) return 'basic'
  if (args.extended === true || args.extendedRegexp === true) return 'extended'
  if (args.perl === true || args.perlRegexp === true) return 'perl'
  return 'perl'
}

function normalizeGrepPatternOperator(value: unknown): GrepPatternOperator {
  return value === 'and' || value === 'AND' ? 'and' : 'or'
}

function normalizeGrepThreads(value: unknown): number | null {
  if (!Number.isFinite(value)) return null
  const normalized = Math.floor(Number(value))
  if (normalized <= 0) return null
  return Math.min(normalized, 64)
}

function normalizeGrepPatternInputs(args: {
  pattern?: unknown
  patterns?: unknown
  andPatterns?: unknown
  orPatterns?: unknown
  notPatterns?: unknown
}): { patterns: string[]; notPatterns: string[]; operator: GrepPatternOperator } {
  const positives: string[] = []
  const negatives: string[] = []

  const addPattern = (value: unknown, negated = false): void => {
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (!trimmed) return
      const target = negated ? negatives : positives
      target.push(trimmed)
      return
    }

    if (!value || typeof value !== 'object') return
    const record = value as {
      pattern?: unknown
      value?: unknown
      not?: unknown
      negated?: unknown
      invert?: unknown
    }
    const pattern = typeof record.pattern === 'string' ? record.pattern : record.value
    const patternNegated =
      negated || record.not === true || record.negated === true || record.invert === true
    addPattern(pattern, patternNegated)
  }

  if (args.patterns !== undefined) {
    if (Array.isArray(args.patterns)) {
      args.patterns.forEach((item) => addPattern(item))
    } else {
      addPattern(args.patterns)
    }
  } else {
    addPattern(args.pattern)
  }

  parsePatternList(args.orPatterns).forEach((pattern) => positives.push(pattern))
  const andPatterns = parsePatternList(args.andPatterns)
  parsePatternList(args.notPatterns).forEach((pattern) => negatives.push(pattern))

  if (andPatterns.length > 0) {
    positives.push(...andPatterns)
    return { patterns: positives, notPatterns: negatives, operator: 'and' }
  }

  return { patterns: positives, notPatterns: negatives, operator: 'or' }
}

function normalizeGrepOptions(args: {
  pattern?: unknown
  patterns?: unknown
  andPatterns?: unknown
  orPatterns?: unknown
  notPatterns?: unknown
  include?: unknown
  exclude?: unknown
  pathspec?: unknown
  pathspecs?: unknown
  pathspecInclude?: unknown
  pathspecIncludes?: unknown
  pathspecExclude?: unknown
  pathspecExcludes?: unknown
  includes?: unknown
  excludes?: unknown
  ignoreCase?: unknown
  caseSensitive?: unknown
  smartCase?: unknown
  literal?: unknown
  fixed?: unknown
  fixedStrings?: unknown
  basic?: unknown
  basicRegexp?: unknown
  extended?: unknown
  extendedRegexp?: unknown
  perl?: unknown
  perlRegexp?: unknown
  patternMode?: unknown
  regexpType?: unknown
  regexMode?: unknown
  patternOperator?: unknown
  operator?: unknown
  combine?: unknown
  matchOperator?: unknown
  allMatch?: unknown
  word?: unknown
  line?: unknown
  invertMatch?: unknown
  onlyMatching?: unknown
  column?: unknown
  context?: unknown
  beforeContext?: unknown
  afterContext?: unknown
  maxCount?: unknown
  maxResults?: unknown
  limit?: unknown
  maxOutputBytes?: unknown
  maxLineLength?: unknown
  maxDepth?: unknown
  hidden?: unknown
  respectGitignore?: unknown
  excludeStandard?: unknown
  followSymlinks?: unknown
  outputMode?: unknown
  pathStyle?: unknown
  filesWithMatches?: unknown
  filesWithoutMatches?: unknown
  count?: unknown
  untracked?: unknown
  cached?: unknown
  noIndex?: unknown
  index?: unknown
  text?: unknown
  textconv?: unknown
  threads?: unknown
}): GrepSearchOptions {
  const pattern = String(args.pattern ?? '')
  const patternMode = normalizeGrepPatternMode(args)
  const normalizedPatterns = normalizeGrepPatternInputs(args)
  const smartCase = normalizeBoolean(args.smartCase, false)
  const ignoreCase = normalizeOptionalBoolean(args.ignoreCase)
  const hasExplicitCaseSensitive = typeof args.caseSensitive === 'boolean'
  const caseSensitive = hasExplicitCaseSensitive
    ? Boolean(args.caseSensitive)
    : ignoreCase !== null
      ? !ignoreCase
      : smartCase
        ? normalizedPatterns.patterns.some((item) => /[A-Z]/.test(item))
        : true
  const context = clampGrepContext(args.context)
  const beforeContext =
    args.beforeContext === undefined ? context : clampGrepContext(args.beforeContext)
  const afterContext =
    args.afterContext === undefined ? context : clampGrepContext(args.afterContext)
  const include = typeof args.include === 'string' ? args.include.trim() : undefined
  const exclude = typeof args.exclude === 'string' ? args.exclude.trim() : undefined
  const pathspecs = [...parsePatternList(args.pathspec), ...parsePatternList(args.pathspecs)]
  const pathspecIncludePatterns = [
    ...parseGlobPatterns(args.pathspecInclude),
    ...parseGlobPatterns(args.pathspecIncludes),
    ...parseGlobPatterns(args.includes)
  ]
  const pathspecExcludePatterns = [
    ...parseGlobPatterns(args.pathspecExclude),
    ...parseGlobPatterns(args.pathspecExcludes),
    ...parseGlobPatterns(args.excludes)
  ]
  const requestedOutputMode = normalizeGrepOutputMode(args.outputMode)
  const outputMode =
    args.filesWithMatches === true
      ? 'files_with_matches'
      : args.filesWithoutMatches === true
        ? 'files_without_matches'
        : args.count === true
          ? 'count'
          : requestedOutputMode

  return {
    pattern,
    patternMode,
    patterns: normalizedPatterns.patterns.length > 0 ? normalizedPatterns.patterns : [pattern],
    notPatterns: normalizedPatterns.notPatterns,
    patternOperator: normalizeGrepPatternOperator(
      args.patternOperator ??
        args.operator ??
        args.combine ??
        args.matchOperator ??
        normalizedPatterns.operator
    ),
    allMatch: normalizeBoolean(args.allMatch, false),
    include: include || undefined,
    exclude: exclude || undefined,
    includePatterns: parseGlobPatterns(include),
    excludePatterns: parseGlobPatterns(exclude),
    caseSensitive,
    smartCase,
    literal: patternMode === 'fixed',
    word: normalizeBoolean(args.word, false),
    line: normalizeBoolean(args.line, false),
    invertMatch: normalizeBoolean(args.invertMatch, false),
    onlyMatching: normalizeBoolean(args.onlyMatching, false),
    column: normalizeBoolean(args.column, false),
    beforeContext,
    afterContext,
    maxResults: clampGrepNumber(
      args.maxResults ?? args.limit,
      GREP_DEFAULT_MAX_RESULTS,
      GREP_MAX_RESULTS
    ),
    maxOutputBytes: clampGrepNumber(
      args.maxOutputBytes,
      GREP_DEFAULT_MAX_OUTPUT_BYTES,
      GREP_MAX_OUTPUT_BYTES
    ),
    maxLineLength: clampGrepNumber(
      args.maxLineLength,
      GREP_DEFAULT_MAX_LINE_LENGTH,
      GREP_MAX_LINE_LENGTH
    ),
    maxCount: clampGrepOptionalNumber(args.maxCount, GREP_MAX_RESULTS),
    maxDepth: clampGrepOptionalNumber(args.maxDepth, GREP_MAX_DEPTH),
    hidden: normalizeBoolean(args.hidden, true),
    respectGitignore: normalizeBoolean(args.respectGitignore, true),
    excludeStandard: normalizeBoolean(
      args.excludeStandard,
      normalizeBoolean(args.respectGitignore, true)
    ),
    followSymlinks: normalizeBoolean(args.followSymlinks, false),
    outputMode,
    pathStyle: normalizeGrepPathStyle(args.pathStyle),
    untracked: normalizeBoolean(args.untracked, true),
    cached: normalizeBoolean(args.cached, false),
    noIndex: normalizeBoolean(args.noIndex, false),
    index: normalizeBoolean(args.index, false),
    text: normalizeBoolean(args.text, false),
    textconv: normalizeBoolean(args.textconv, false),
    threads: normalizeGrepThreads(args.threads),
    pathspecs,
    pathspecIncludePatterns,
    pathspecExcludePatterns
  }
}

function isBasicSidecarGrepOptions(options: GrepSearchOptions): boolean {
  return (
    options.patternMode === 'perl' &&
    options.patterns.length === 1 &&
    options.patterns[0] === options.pattern &&
    options.notPatterns.length === 0 &&
    options.patternOperator === 'or' &&
    !options.allMatch &&
    !options.exclude &&
    !options.caseSensitive &&
    !options.smartCase &&
    !options.literal &&
    !options.word &&
    !options.line &&
    !options.invertMatch &&
    !options.onlyMatching &&
    !options.column &&
    options.beforeContext === 0 &&
    options.afterContext === 0 &&
    options.maxResults === GREP_DEFAULT_MAX_RESULTS &&
    options.maxOutputBytes === GREP_DEFAULT_MAX_OUTPUT_BYTES &&
    options.maxLineLength === GREP_DEFAULT_MAX_LINE_LENGTH &&
    options.maxCount === null &&
    options.maxDepth === null &&
    options.hidden &&
    options.respectGitignore &&
    options.excludeStandard &&
    !options.followSymlinks &&
    options.outputMode === 'matches' &&
    options.pathStyle === 'relative' &&
    options.untracked &&
    !options.cached &&
    !options.noIndex &&
    !options.index &&
    !options.text &&
    !options.textconv &&
    options.threads === null &&
    options.pathspecs.length === 0 &&
    options.pathspecIncludePatterns.length === 0 &&
    options.pathspecExcludePatterns.length === 0
  )
}

function formatGrepResultPath(
  searchRoot: string,
  filePath: string,
  pathStyle: GrepPathStyle
): string {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(searchRoot, filePath)
  if (pathStyle === 'absolute') return absolutePath
  return path.relative(searchRoot, absolutePath) || path.basename(absolutePath)
}

function shouldSkipHiddenPath(filePath: string, searchRoot: string): boolean {
  const relativePath = path.relative(searchRoot, path.resolve(searchRoot, filePath))
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return false
  return relativePath.split(/[\\/]+/).some((part) => part.startsWith('.') && part !== '.')
}

function buildSearchPathMatchers(
  searchRoot: string,
  options: GrepSearchOptions
): {
  matchesInclude: (filePath: string) => boolean
  matchesExclude: (filePath: string) => boolean
} {
  const pathspecIncludes: string[] = []
  const pathspecExcludes: string[] = []

  for (const pathspec of options.pathspecs) {
    const parsed = splitGitPathspecMagic(pathspec)
    if (!parsed.pattern) continue
    if (parsed.exclude) {
      pathspecExcludes.push(parsed.pattern)
    } else {
      pathspecIncludes.push(parsed.pattern)
    }
  }

  const includePatterns = [
    ...options.includePatterns,
    ...options.pathspecIncludePatterns,
    ...pathspecIncludes
  ]
  const excludePatterns = [
    ...options.excludePatterns,
    ...options.pathspecExcludePatterns,
    ...pathspecExcludes
  ]

  return {
    matchesInclude: createIncludeMatcher(searchRoot, includePatterns),
    matchesExclude:
      excludePatterns.length > 0 ? createIncludeMatcher(searchRoot, excludePatterns) : () => false
  }
}

function createSearchMeta(args: {
  searchRoot: string
  pattern: string
  include?: string | null
  exclude?: string | null
  outputMode?: GrepOutputMode
  truncated?: boolean
  timedOut?: boolean
  limitReason?: GrepLimitReason
  engine?: SearchEngine
  searchTime?: number
  warnings?: string[]
  maxDepth?: number | null
  pathStyle?: SearchPathStyle
  hiddenIncluded?: boolean
  respectGitignore?: boolean
  followSymlinks?: boolean
  beforeContext?: number
  afterContext?: number
  maxResults?: number
  maxOutputBytes?: number
  maxLineLength?: number
}): SearchMeta {
  return {
    backend: 'local',
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
    ignoredDefaultsApplied: true,
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

function createGlobToolResult(args: {
  searchRoot: string
  pattern: string
  matches: Array<{ path: string; type?: 'file' | 'directory' }>
  truncated?: boolean
  limitReason?: GrepLimitReason
  warnings?: string[]
  error?: string
}): GlobToolResult {
  return {
    kind: 'glob',
    matches: args.matches,
    meta: createSearchMeta({
      searchRoot: args.searchRoot,
      pattern: args.pattern,
      truncated: args.truncated,
      limitReason: args.limitReason,
      warnings: args.warnings,
      pathStyle: 'absolute'
    }),
    error: args.error
  }
}

function formatGrepOutput(
  matches: GrepToolResult['matches'],
  outputMode: GrepOutputMode,
  includeColumn: boolean
): string {
  return matches
    .map((item) => {
      if (outputMode === 'files_with_matches' || outputMode === 'files_without_matches') {
        return item.path
      }
      if (outputMode === 'count') return `${item.path}:${item.count ?? 0}`
      if (typeof item.line !== 'number') return item.path

      const separator = item.kind === 'context' ? '-' : ':'
      if (includeColumn && typeof item.column === 'number' && item.kind !== 'context') {
        return `${item.path}${separator}${item.line}${separator}${item.column}${separator}${
          item.text ?? ''
        }`
      }
      return `${item.path}${separator}${item.line}${separator}${item.text ?? ''}`
    })
    .join('\n')
}

function createGrepToolResult(args: {
  searchRoot: string
  pattern: string
  include?: string | null
  exclude?: string | null
  outputMode?: GrepOutputMode
  matches: Array<{
    path: string
    line?: number
    column?: number
    text?: string
    kind?: GrepMatchKind
    count?: number
  }>
  truncated?: boolean
  timedOut?: boolean
  limitReason?: GrepLimitReason
  engine?: SearchEngine
  searchTime?: number
  warnings?: string[]
  options?: GrepSearchOptions
  output?: string
  error?: string
}): GrepToolResult {
  const options = args.options
  return {
    kind: 'grep',
    matches: args.matches,
    meta: createSearchMeta({
      searchRoot: args.searchRoot,
      pattern: args.pattern,
      include: args.include,
      exclude: args.exclude,
      outputMode: args.outputMode ?? options?.outputMode,
      truncated: args.truncated,
      timedOut: args.timedOut,
      limitReason: args.limitReason,
      engine: args.engine,
      searchTime: args.searchTime,
      warnings: args.warnings,
      pathStyle: options?.pathStyle === 'relative' ? 'relative_to_search_root' : 'absolute',
      hiddenIncluded: options?.hidden,
      respectGitignore: options?.respectGitignore,
      followSymlinks: options?.followSymlinks,
      maxDepth: options?.maxDepth,
      beforeContext: options?.beforeContext,
      afterContext: options?.afterContext,
      maxResults: options?.maxResults,
      maxOutputBytes: options?.maxOutputBytes,
      maxLineLength: options?.maxLineLength
    }),
    output:
      args.output ??
      formatGrepOutput(
        args.matches,
        args.outputMode ?? options?.outputMode ?? 'matches',
        options?.column === true
      ),
    error: args.error
  }
}

function clampToolResultLimit(value: unknown, max: number): number | null {
  if (!Number.isFinite(value)) return null
  const normalized = Math.floor(Number(value))
  if (normalized <= 0) return null
  return Math.min(normalized, max)
}

function scoreFileSearchMatch(filePath: string, query: string): number {
  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase()
  const normalizedQuery = query.replace(/\\/g, '/').trim().toLowerCase()
  if (!normalizedQuery) return Number.POSITIVE_INFINITY

  const fileName = path.basename(normalizedPath)
  if (fileName === normalizedQuery) return 0
  if (fileName.startsWith(normalizedQuery)) return 1

  const fileNameIndex = fileName.indexOf(normalizedQuery)
  if (fileNameIndex >= 0) return 10 + fileNameIndex

  if (normalizedPath === normalizedQuery) return 20

  const pathIndex = normalizedPath.indexOf(normalizedQuery)
  if (pathIndex >= 0) return 30 + pathIndex

  let cursor = 0
  let gapScore = 0
  for (const char of normalizedQuery) {
    const nextIndex = normalizedPath.indexOf(char, cursor)
    if (nextIndex < 0) return Number.POSITIVE_INFINITY
    gapScore += nextIndex - cursor
    cursor = nextIndex + 1
  }

  return 100 + gapScore
}

async function listSearchableFiles(searchRoot: string): Promise<string[]> {
  const normalizedRoot = path.resolve(searchRoot)
  const now = Date.now()
  const cached = fileSearchCache.get(normalizedRoot)
  if (cached && cached.expiresAt > now) {
    return cached.files
  }

  const matcher = await createLocalGitIgnoreContext(normalizedRoot)
  const files: string[] = []

  const walk = async (dirPath: string): Promise<void> => {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      const absolutePath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        if (isDefaultIgnoredDirName(entry.name)) continue
        if (await matcher.ignores(absolutePath, true)) continue
        await walk(absolutePath)
        continue
      }

      if (!entry.isFile()) continue
      if (await matcher.ignores(absolutePath, false)) continue

      files.push(path.relative(normalizedRoot, absolutePath).replace(/\\/g, '/'))
    }
  }

  await walk(normalizedRoot)

  fileSearchCache.set(normalizedRoot, {
    expiresAt: now + FILE_SEARCH_CACHE_TTL_MS,
    files
  })

  // Evict oldest entries if cache grows too large
  if (fileSearchCache.size > FILE_SEARCH_CACHE_MAX_ENTRIES) {
    const firstKey = fileSearchCache.keys().next().value
    if (firstKey !== undefined) fileSearchCache.delete(firstKey)
  }

  return files
}

async function isBinaryFile(filePath: string): Promise<boolean> {
  try {
    const ext = path.extname(filePath).toLowerCase()
    if (GREP_BINARY_EXTENSIONS.has(ext)) return true

    const handle = await fs.promises.open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(512)
      const { bytesRead } = await handle.read(buffer, 0, 512, 0)
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0) return true
      }
      return false
    } finally {
      await handle.close()
    }
  } catch {
    return true
  }
}

function isRetryableFileError(error: unknown): error is FileOperationError {
  if (!(error instanceof Error)) return false
  const code = (error as FileOperationError).code
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withFileOperationRetries<T>(operation: () => T | Promise<T>): Promise<T> {
  let lastError: unknown

  for (let attempt = 0; attempt <= FILE_OPERATION_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!isRetryableFileError(error) || attempt === FILE_OPERATION_RETRY_DELAYS_MS.length) {
        throw error
      }
      await delay(FILE_OPERATION_RETRY_DELAYS_MS[attempt])
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function writeTextFileWithRetries(filePath: string, content: string): Promise<void> {
  await withFileOperationRetries(async () => {
    await fs.promises.writeFile(filePath, content, 'utf-8')
  })
}

async function writeBinaryFileWithRetries(filePath: string, data: Buffer): Promise<void> {
  await withFileOperationRetries(async () => {
    await fs.promises.writeFile(filePath, data)
  })
}

async function moveFileWithRetries(from: string, to: string): Promise<void> {
  await withFileOperationRetries(async () => {
    await fs.promises.rename(from, to)
  })
}

function createGrepCollector(searchRoot: string, options: GrepSearchOptions): GrepCollector {
  const results: GrepResultItem[] = []
  let totalBytes = 2
  let limitReason: GrepLimitReason = null

  const appendItem = (candidate: GrepResultItem): boolean => {
    if (results.length >= options.maxResults) {
      limitReason ??= 'max_results'
      return false
    }

    const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8') + 1
    if (totalBytes + candidateBytes > options.maxOutputBytes) {
      limitReason ??= 'max_output_bytes'
      return false
    }

    results.push(candidate)
    totalBytes += candidateBytes
    return true
  }

  return {
    results,
    append(
      filePath: string,
      line: number,
      text: string,
      kind: GrepMatchKind = 'match',
      column?: number
    ): boolean {
      return appendItem({
        file: formatGrepResultPath(searchRoot, filePath, options.pathStyle),
        line,
        column,
        text: normalizeGrepLine(text, options.maxLineLength),
        kind
      })
    },
    appendFile(filePath: string): boolean {
      return appendItem({
        file: formatGrepResultPath(searchRoot, filePath, options.pathStyle)
      })
    },
    appendCount(filePath: string, count: number): boolean {
      return appendItem({
        file: formatGrepResultPath(searchRoot, filePath, options.pathStyle),
        count
      })
    },
    get limitReason(): GrepLimitReason {
      return limitReason
    },
    get truncated(): boolean {
      return limitReason !== null
    }
  }
}

type GrepLineMatchPart = {
  text: string
  column: number
}

type CompiledGrepPattern = {
  pattern: string
  testRegex: RegExp
  matchRegex: RegExp
}

type CompiledGrepMatcher = {
  positive: CompiledGrepPattern[]
  negative: CompiledGrepPattern[]
  warnings: string[]
  testLine: (line: string) => boolean
  positiveHits: (line: string) => boolean[]
  matchingParts: (line: string) => GrepLineMatchPart[]
  firstColumn: (line: string) => number | undefined
}

type ScanFileResult = {
  results: GrepResultItem[]
  hasMatch: boolean
  positiveHits: boolean[]
  count: number
  timedOut: boolean
}

function translateBasicRegexpToJavaScript(pattern: string): string {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    const next = pattern[index + 1]
    if (char === '\\' && next) {
      if ('()+?|{}'.includes(next)) {
        source += next
        index += 1
        continue
      }
      source += `${char}${next}`
      index += 1
      continue
    }

    if ('()+?|{}'.includes(char)) {
      source += `\\${char}`
    } else {
      source += char
    }
  }
  return source
}

function buildJavaScriptGrepSource(pattern: string, options: GrepSearchOptions): string {
  let source =
    options.patternMode === 'fixed'
      ? escapeRegex(pattern)
      : options.patternMode === 'basic'
        ? translateBasicRegexpToJavaScript(pattern)
        : pattern
  if (options.word) source = `\\b(?:${source})\\b`
  if (options.line) source = `^(?:${source})$`
  return source
}

function compileGrepMatcher(options: GrepSearchOptions): CompiledGrepMatcher {
  const flags = options.caseSensitive ? '' : 'i'
  const globalFlags = `${flags}g`
  const warnings: string[] = []

  if (options.patternMode === 'basic') {
    warnings.push('Node grep approximates POSIX basic-regexp semantics with JavaScript RegExp')
  } else if (options.patternMode === 'perl') {
    warnings.push('Node grep uses JavaScript RegExp for perl-regexp fallback matching')
  }

  const compilePattern = (pattern: string): CompiledGrepPattern => {
    const source = buildJavaScriptGrepSource(pattern, options)
    return {
      pattern,
      testRegex: new RegExp(source, flags),
      matchRegex: new RegExp(source, globalFlags)
    }
  }

  const positive = options.patterns.map((pattern) => compilePattern(pattern))
  const negative = options.notPatterns.map((pattern) => compilePattern(pattern))

  const testPattern = (compiled: CompiledGrepPattern, line: string): boolean => {
    compiled.testRegex.lastIndex = 0
    return compiled.testRegex.test(line)
  }

  const collectParts = (compiled: CompiledGrepPattern, line: string): GrepLineMatchPart[] => {
    const parts: GrepLineMatchPart[] = []
    compiled.matchRegex.lastIndex = 0

    while (true) {
      const match = compiled.matchRegex.exec(line)
      if (!match) break
      if (match[0].length === 0) {
        compiled.matchRegex.lastIndex += 1
        continue
      }
      parts.push({ text: match[0], column: match.index + 1 })
    }

    return parts
  }

  const positiveHits = (line: string): boolean[] =>
    positive.map((compiled) => testPattern(compiled, line))

  const testLine = (line: string): boolean => {
    const hits = positiveHits(line)
    const positiveMatch =
      positive.length === 0
        ? true
        : options.patternOperator === 'and'
          ? hits.every(Boolean)
          : hits.some(Boolean)
    if (!positiveMatch) return false
    return !negative.some((compiled) => testPattern(compiled, line))
  }

  const matchingParts = (line: string): GrepLineMatchPart[] => {
    const parts = positive
      .filter((compiled) => testPattern(compiled, line))
      .flatMap((compiled) => collectParts(compiled, line))
      .sort((left, right) => left.column - right.column || left.text.localeCompare(right.text))

    const seen = new Set<string>()
    return parts.filter((part) => {
      const key = `${part.column}\0${part.text}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  return {
    positive,
    negative,
    warnings,
    testLine,
    positiveHits,
    matchingParts,
    firstColumn(line: string): number | undefined {
      return matchingParts(line)[0]?.column
    }
  }
}

async function scanFileForMatches(
  filePath: string,
  matcher: CompiledGrepMatcher,
  startTime: number,
  options: GrepSearchOptions
): Promise<ScanFileResult> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  try {
    const results: GrepResultItem[] = []
    let lineNumber = 0
    let matchedCount = 0
    let emittedMatchCount = 0
    let hasMatch = false
    let afterContextRemaining = 0
    const beforeBuffer: Array<{ line: number; text: string }> = []
    const emittedContextLines = new Set<number>()
    const positiveHits = matcher.positive.map(() => false)

    const appendContext = (line: number, text: string): void => {
      if (emittedContextLines.has(line)) return
      emittedContextLines.add(line)
      results.push({
        file: filePath,
        line,
        text: normalizeGrepLine(text, options.maxLineLength),
        kind: 'context'
      })
    }

    for await (const line of rl) {
      lineNumber += 1
      if (Date.now() - startTime > GREP_TIMEOUT_MS) {
        return { results, hasMatch, positiveHits, count: matchedCount, timedOut: true }
      }

      matcher.positiveHits(line).forEach((hit, index) => {
        positiveHits[index] ||= hit
      })

      let matches = matcher.testLine(line)
      if (options.invertMatch) matches = !matches

      if (matches) {
        hasMatch = true
        if (options.maxCount === null || matchedCount < options.maxCount) {
          matchedCount += 1
        }

        if (options.outputMode === 'files_with_matches') {
          if (!options.allMatch) {
            return {
              results: [{ file: filePath }],
              hasMatch,
              positiveHits,
              count: matchedCount,
              timedOut: false
            }
          }
          continue
        }

        if (
          options.outputMode === 'matches' &&
          (options.maxCount === null || emittedMatchCount < options.maxCount)
        ) {
          if (!options.onlyMatching) {
            for (const contextLine of beforeBuffer) {
              appendContext(contextLine.line, contextLine.text)
            }
          }

          if (options.onlyMatching) {
            const parts = matcher.matchingParts(line)
            const matchingParts = parts.length > 0 ? parts : [{ text: line, column: 1 }]
            for (const part of matchingParts) {
              if (options.maxCount !== null && emittedMatchCount >= options.maxCount) break
              results.push({
                file: filePath,
                line: lineNumber,
                column: options.column ? part.column : undefined,
                text: normalizeGrepLine(part.text, options.maxLineLength),
                kind: 'match'
              })
              emittedMatchCount += 1
            }
          } else {
            results.push({
              file: filePath,
              line: lineNumber,
              column: options.column ? matcher.firstColumn(line) : undefined,
              text: normalizeGrepLine(line, options.maxLineLength),
              kind: 'match'
            })
            emittedMatchCount += 1
            afterContextRemaining = options.afterContext
          }
        }
      } else if (afterContextRemaining > 0 && options.outputMode === 'matches') {
        appendContext(lineNumber, line)
        afterContextRemaining -= 1
      }

      if (options.beforeContext > 0) {
        beforeBuffer.push({ line: lineNumber, text: line })
        if (beforeBuffer.length > options.beforeContext) beforeBuffer.shift()
      }
    }

    if (options.outputMode === 'count' && hasMatch) {
      results.push({ file: filePath, count: matchedCount })
    } else if (options.outputMode === 'files_with_matches' && hasMatch) {
      results.push({ file: filePath })
    } else if (options.outputMode === 'files_without_matches' && !hasMatch) {
      results.push({ file: filePath })
    }

    return { results, hasMatch, positiveHits, count: matchedCount, timedOut: false }
  } finally {
    rl.close()
    stream.destroy()
  }
}

async function findLocalGitIgnoreRoot(startDir: string): Promise<string> {
  let currentDir = path.resolve(startDir)

  while (true) {
    if (fs.existsSync(path.join(currentDir, '.git'))) {
      return currentDir
    }

    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) {
      return path.resolve(startDir)
    }
    currentDir = parentDir
  }
}

async function createLocalGitIgnoreContext(
  searchTarget: string,
  extraPatterns?: string[]
): Promise<ReturnType<typeof createGitIgnoreMatcher>> {
  const baseDir = path.resolve(searchTarget)
  const gitIgnoreRoot = await findLocalGitIgnoreRoot(baseDir)
  return createGitIgnoreMatcher({
    rootDir: gitIgnoreRoot,
    extraPatterns,
    readIgnoreFile: async (filePath) => {
      try {
        return await fs.promises.readFile(filePath, 'utf8')
      } catch {
        return null
      }
    }
  })
}

async function runProcessText(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<ProcessTextResult> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    child.on('error', () => {
      finish(null)
    })

    child.on('close', (code) => {
      finish(code)
    })
  })
}

async function findGitWorktreeRoot(
  searchTarget: string,
  targetIsDirectory: boolean
): Promise<string | null> {
  const cwd = targetIsDirectory ? searchTarget : path.dirname(searchTarget)
  const result = await runProcessText('git', ['rev-parse', '--show-toplevel'], cwd, 5_000)
  if (result.timedOut || result.code !== 0) return null

  const root = result.stdout.trim().split(/\r?\n/)[0]
  if (!root) return null

  const resolvedRoot = path.resolve(root)
  const relative = path.relative(resolvedRoot, searchTarget)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null

  return resolvedRoot
}

function isWithinSearchRoot(searchRoot: string, filePath: string): boolean {
  const relative = path.relative(searchRoot, path.resolve(filePath))
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function getSearchRootDepth(searchRoot: string, filePath: string): number {
  const relative = path.relative(searchRoot, path.resolve(filePath))
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return 0
  return relative.split(/[\\/]+/).length - 1
}

function shouldKeepGitGrepPath(
  absolutePath: string,
  searchRoot: string,
  options: GrepSearchOptions,
  matchesInclude: (filePath: string) => boolean,
  matchesExclude: (filePath: string) => boolean
): boolean {
  if (!isWithinSearchRoot(searchRoot, absolutePath)) return false
  if (!options.hidden && shouldSkipHiddenPath(absolutePath, searchRoot)) return false
  if (
    options.maxDepth !== null &&
    getSearchRootDepth(searchRoot, absolutePath) > options.maxDepth
  ) {
    return false
  }
  return matchesInclude(absolutePath) && !matchesExclude(absolutePath)
}

type GrepBackendResult = {
  results: GrepResultItem[]
  truncated: boolean
  timedOut: boolean
  limitReason: GrepLimitReason
  warnings?: string[]
}

function appendGitPatternExpression(gitArgs: string[], options: GrepSearchOptions): void {
  if (options.allMatch) gitArgs.push('--all-match')
  const normalizePattern = (pattern: string): string => {
    if (!options.line) return pattern
    if (options.patternMode === 'fixed') return `^${escapeRegex(pattern)}$`
    if (options.patternMode === 'basic') return `^${pattern}$`
    return `^(?:${pattern})$`
  }

  const expression: string[] = []
  const appendPositives = (target: string[]): void => {
    options.patterns.forEach((pattern, index) => {
      if (index > 0) target.push(options.patternOperator === 'and' ? '--and' : '--or')
      target.push('-e', normalizePattern(pattern))
    })
  }

  if (options.patterns.length > 0) {
    if (options.patterns.length > 1 && options.notPatterns.length > 0) {
      expression.push('(')
      appendPositives(expression)
      expression.push(')')
    } else {
      appendPositives(expression)
    }
  }

  for (const pattern of options.notPatterns) {
    if (expression.length > 0) expression.push('--and')
    expression.push('--not', '-e', normalizePattern(pattern))
  }

  if (expression.length === 0) expression.push('-e', normalizePattern(options.pattern))
  gitArgs.push(...expression)
}

function appendGitGrepModeArgs(gitArgs: string[], options: GrepSearchOptions): void {
  const patternMode = options.line && options.patternMode === 'fixed' ? 'perl' : options.patternMode
  if (patternMode === 'fixed') gitArgs.push('--fixed-strings')
  if (patternMode === 'basic') gitArgs.push('--basic-regexp')
  if (patternMode === 'extended') gitArgs.push('--extended-regexp')
  if (patternMode === 'perl') gitArgs.push('--perl-regexp')

  if (options.outputMode === 'files_with_matches') {
    gitArgs.push('--files-with-matches')
  } else if (options.outputMode === 'files_without_matches') {
    gitArgs.push('--files-without-match')
  } else if (options.outputMode === 'count') {
    gitArgs.push('--count')
  } else {
    if (options.onlyMatching) gitArgs.push('--only-matching')
    if (options.beforeContext > 0) gitArgs.push('--before-context', String(options.beforeContext))
    if (options.afterContext > 0) gitArgs.push('--after-context', String(options.afterContext))
  }

  if (!options.caseSensitive) gitArgs.push('--ignore-case')
  if (options.word) gitArgs.push('--word-regexp')
  if (options.invertMatch) gitArgs.push('--invert-match')
  if (options.column) gitArgs.push('--column')
  if (options.maxCount !== null) gitArgs.push('--max-count', String(options.maxCount))
  if (options.maxDepth !== null) gitArgs.push('--max-depth', String(options.maxDepth))
  if (options.threads !== null) gitArgs.push('--threads', String(options.threads))
  if (options.text) gitArgs.push('--text')
  else gitArgs.push('-I')
  if (options.textconv) gitArgs.push('--textconv')
}

function stripGitContextSeparator(stdoutBuffer: string): string {
  let buffer = stdoutBuffer
  while (buffer.startsWith('--\n') || buffer.startsWith('--\r\n')) {
    buffer = buffer.startsWith('--\r\n') ? buffer.slice(4) : buffer.slice(3)
  }
  return buffer
}

async function runGitGrepSearch(args: {
  searchRoot: string
  searchTarget: string
  targetIsDirectory: boolean
  options: GrepSearchOptions
  startTime: number
}): Promise<GrepBackendResult | null> {
  if (args.options.followSymlinks) return null

  const repoRoot = args.options.noIndex
    ? args.searchRoot
    : await findGitWorktreeRoot(args.searchTarget, args.targetIsDirectory)
  if (!repoRoot) return null

  const pathspecs = buildGitGrepPathspecs({
    repoRoot,
    searchTarget: args.searchTarget,
    targetIsDirectory: args.targetIsDirectory,
    options: args.options
  })
  const collector = createGrepCollector(args.searchRoot, args.options)
  const { matchesInclude, matchesExclude } = buildSearchPathMatchers(args.searchRoot, args.options)
  let matcher: CompiledGrepMatcher | null = null
  try {
    matcher = compileGrepMatcher(args.options)
  } catch {
    matcher = null
  }

  const gitArgs = ['grep', '--line-number', '--null', '--no-color', '--full-name']
  if (args.options.noIndex) {
    gitArgs.push('--no-index')
  } else if (args.options.index) {
    gitArgs.push('--index')
  }
  if (args.options.cached) {
    gitArgs.push('--cached')
  } else if (!args.options.noIndex && args.options.untracked) {
    gitArgs.push('--untracked')
  }
  if (args.options.excludeStandard && (args.options.untracked || args.options.noIndex)) {
    gitArgs.push('--exclude-standard')
  }
  appendGitGrepModeArgs(gitArgs, args.options)
  appendGitPatternExpression(gitArgs, args.options)
  gitArgs.push('--', ...pathspecs)

  return await new Promise((resolve) => {
    const child = spawn('git', gitArgs, { cwd: repoRoot, windowsHide: true })
    let stdoutBuffer = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const finish = (value: GrepBackendResult | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    const shouldKeepPath = (rawPath: string): string | null => {
      if (!rawPath) return null
      const absolutePath = path.resolve(repoRoot, rawPath)
      if (
        !shouldKeepGitGrepPath(
          absolutePath,
          args.searchRoot,
          args.options,
          matchesInclude,
          matchesExclude
        )
      ) {
        return null
      }
      return absolutePath
    }

    const appendRecord = (item: GrepResultItem): void => {
      const absolutePath = shouldKeepPath(item.file)
      if (!absolutePath) return
      if (typeof item.count === 'number') {
        if (item.count <= 0) return
        if (!collector.appendCount(absolutePath, item.count)) child.kill()
        return
      }
      if (typeof item.line === 'number' && typeof item.text === 'string') {
        if (!collector.append(absolutePath, item.line, item.text, item.kind, item.column)) {
          child.kill()
        }
        return
      }
      if (!collector.appendFile(absolutePath)) child.kill()
    }

    const appendFile = (rawPath: string): void => {
      appendRecord({ file: rawPath })
    }

    const appendCount = (rawPath: string, rawCount: string): void => {
      const count = Number(rawCount)
      if (!Number.isFinite(count)) return
      appendRecord({ file: rawPath, count })
    }

    const appendMatch = (
      rawPath: string,
      rawLine: string,
      text: string,
      rawColumn?: string
    ): void => {
      const line = Number(rawLine)
      if (!Number.isFinite(line) || line <= 0) return
      const column = rawColumn === undefined ? NaN : Number(rawColumn)
      const hasColumn = Number.isFinite(column) && column > 0
      const isMatch =
        hasColumn ||
        args.options.onlyMatching ||
        !matcher ||
        (args.options.invertMatch ? !matcher.testLine(text) : matcher.testLine(text))
      appendRecord({
        file: rawPath,
        line,
        column: hasColumn ? column : undefined,
        text,
        kind: isMatch ? 'match' : 'context'
      })
    }

    const flushStdout = (flush = false): void => {
      stdoutBuffer = stripGitContextSeparator(stdoutBuffer)
      if (
        args.options.outputMode === 'files_with_matches' ||
        args.options.outputMode === 'files_without_matches'
      ) {
        let separatorIndex = stdoutBuffer.indexOf('\0')
        while (separatorIndex !== -1 || (flush && stdoutBuffer.length > 0)) {
          const endIndex = separatorIndex === -1 ? stdoutBuffer.length : separatorIndex
          const rawPath = stdoutBuffer.slice(0, endIndex)
          stdoutBuffer = stdoutBuffer.slice(Math.min(endIndex + 1, stdoutBuffer.length))
          appendFile(rawPath)
          if (settled) return
          separatorIndex = stdoutBuffer.indexOf('\0')
        }
        return
      }

      if (args.options.outputMode === 'count') {
        let pathEnd = stdoutBuffer.indexOf('\0')
        let lineEnd = pathEnd === -1 ? -1 : stdoutBuffer.indexOf('\n', pathEnd + 1)
        while (pathEnd !== -1 && (lineEnd !== -1 || (flush && stdoutBuffer.length > pathEnd))) {
          const endIndex = lineEnd === -1 ? stdoutBuffer.length : lineEnd
          appendCount(stdoutBuffer.slice(0, pathEnd), stdoutBuffer.slice(pathEnd + 1, endIndex))
          stdoutBuffer = stdoutBuffer.slice(Math.min(endIndex + 1, stdoutBuffer.length))
          if (settled) return
          pathEnd = stdoutBuffer.indexOf('\0')
          lineEnd = pathEnd === -1 ? -1 : stdoutBuffer.indexOf('\n', pathEnd + 1)
        }
        return
      }

      let pathEnd = stdoutBuffer.indexOf('\0')
      let lineEnd = pathEnd === -1 ? -1 : stdoutBuffer.indexOf('\0', pathEnd + 1)
      let newlineEnd = lineEnd === -1 ? -1 : stdoutBuffer.indexOf('\n', lineEnd + 1)
      while (
        pathEnd !== -1 &&
        lineEnd !== -1 &&
        (newlineEnd !== -1 || (flush && stdoutBuffer.length > lineEnd))
      ) {
        const endIndex = newlineEnd === -1 ? stdoutBuffer.length : newlineEnd
        const columnEnd = stdoutBuffer.indexOf('\0', lineEnd + 1)
        const hasColumn = columnEnd !== -1 && columnEnd < endIndex
        appendMatch(
          stdoutBuffer.slice(0, pathEnd),
          stdoutBuffer.slice(pathEnd + 1, lineEnd),
          stdoutBuffer.slice(hasColumn ? columnEnd + 1 : lineEnd + 1, endIndex).replace(/\r$/, ''),
          hasColumn ? stdoutBuffer.slice(lineEnd + 1, columnEnd) : undefined
        )
        stdoutBuffer = stdoutBuffer.slice(Math.min(endIndex + 1, stdoutBuffer.length))
        if (settled) return
        stdoutBuffer = stripGitContextSeparator(stdoutBuffer)
        pathEnd = stdoutBuffer.indexOf('\0')
        lineEnd = pathEnd === -1 ? -1 : stdoutBuffer.indexOf('\0', pathEnd + 1)
        newlineEnd = lineEnd === -1 ? -1 : stdoutBuffer.indexOf('\n', lineEnd + 1)
      }
    }

    const remainingTime = Math.max(1000, GREP_TIMEOUT_MS - (Date.now() - args.startTime))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, remainingTime)

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      flushStdout()
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    child.on('error', () => {
      finish(null)
    })

    child.on('close', (code) => {
      flushStdout(true)
      if (settled) return

      if (timedOut || collector.truncated) {
        finish({
          results: collector.results,
          truncated: true,
          timedOut,
          limitReason: timedOut ? 'timeout' : collector.limitReason,
          warnings: matcher
            ? []
            : ['Git grep context kind classification used a best-effort parser']
        })
        return
      }

      if (code === 0 || code === 1) {
        finish({
          results: collector.results,
          truncated: false,
          timedOut: false,
          limitReason: null,
          warnings: matcher
            ? []
            : ['Git grep context kind classification used a best-effort parser']
        })
        return
      }

      void stderr
      finish(null)
    })
  })
}

async function runSidecarGrepSearch(args: {
  pattern: string
  searchTarget: string
  include?: string
}): Promise<{
  results: GrepResultItem[]
  truncated: boolean
  timedOut: boolean
  limitReason: GrepLimitReason
  searchTime: number
} | null> {
  try {
    const sidecar = getSidecarManager()
    const ready = await sidecar.ensureStarted()
    if (!ready) return null

    const result = (await sidecar.request(
      'fs/grep',
      {
        pattern: args.pattern,
        path: args.searchTarget,
        include: args.include,
        ignoredDirs: GREP_IGNORE_DIR_NAMES,
        maxResults: GREP_DEFAULT_MAX_RESULTS,
        maxLineLength: GREP_DEFAULT_MAX_LINE_LENGTH,
        maxOutputBytes: GREP_DEFAULT_MAX_OUTPUT_BYTES,
        timeoutMs: GREP_TIMEOUT_MS
      },
      GREP_TIMEOUT_MS + 5_000
    )) as {
      results?: GrepResultItem[]
      truncated?: boolean
      timedOut?: boolean
      limitReason?: GrepLimitReason
      searchTime?: number
    }

    if (!Array.isArray(result?.results)) return null

    return {
      results: result.results,
      truncated: result.truncated === true,
      timedOut: result.timedOut === true,
      limitReason: result.limitReason ?? null,
      searchTime: typeof result.searchTime === 'number' ? result.searchTime : 0
    }
  } catch {
    return null
  }
}

async function runRipgrepSearch(args: {
  searchRoot: string
  searchTarget: string
  targetIsDirectory: boolean
  options: GrepSearchOptions
  startTime: number
}): Promise<{
  results: GrepResultItem[]
  truncated: boolean
  timedOut: boolean
  limitReason: GrepLimitReason
} | null> {
  if (
    args.options.patternMode === 'basic' ||
    args.options.notPatterns.length > 0 ||
    args.options.patternOperator !== 'or' ||
    args.options.allMatch ||
    args.options.pathspecs.length > 0 ||
    args.options.cached ||
    args.options.index ||
    args.options.textconv
  ) {
    return null
  }

  const collector = createGrepCollector(args.searchRoot, args.options)
  const rgArgs = [
    '--line-number',
    '--color',
    'never',
    '--no-messages',
    '--max-filesize',
    `${Math.floor(GREP_MAX_FILE_SIZE / (1024 * 1024))}M`
  ]

  if (args.options.outputMode === 'matches') {
    rgArgs.unshift('--json')
    if (args.options.beforeContext > 0) {
      rgArgs.push('--before-context', String(args.options.beforeContext))
    }
    if (args.options.afterContext > 0) {
      rgArgs.push('--after-context', String(args.options.afterContext))
    }
  } else if (args.options.outputMode === 'files_with_matches') {
    rgArgs.push('--files-with-matches')
  } else if (args.options.outputMode === 'files_without_matches') {
    rgArgs.push('--files-without-match')
  } else {
    rgArgs.push('--count')
  }

  if (args.options.patternMode === 'perl') rgArgs.push('--pcre2')
  if (args.options.smartCase) {
    rgArgs.push('--smart-case')
  } else if (!args.options.caseSensitive) {
    rgArgs.push('--ignore-case')
  }
  if (args.options.literal) rgArgs.push('--fixed-strings')
  if (args.options.word) rgArgs.push('--word-regexp')
  if (args.options.line) rgArgs.push('--line-regexp')
  if (args.options.invertMatch) rgArgs.push('--invert-match')
  if (args.options.onlyMatching) rgArgs.push('--only-matching')
  if (args.options.column) rgArgs.push('--column')
  if (args.options.hidden) rgArgs.push('--hidden')
  if (!args.options.respectGitignore) rgArgs.push('--no-ignore')
  if (args.options.followSymlinks) rgArgs.push('--follow')
  if (args.options.maxDepth !== null) rgArgs.push('--max-depth', String(args.options.maxDepth))
  if (args.options.maxCount !== null) rgArgs.push('--max-count', String(args.options.maxCount))
  if (args.options.threads !== null) rgArgs.push('--threads', String(args.options.threads))
  if (args.options.text) rgArgs.push('--text')

  for (const dir of GREP_IGNORE_DIRS) {
    rgArgs.push('--glob', `!${dir}/**`)
    rgArgs.push('--glob', `!**/${dir}/**`)
  }

  for (const includePattern of args.options.includePatterns) {
    rgArgs.push('--glob', normalizeRipgrepGlob(includePattern))
  }
  for (const includePattern of args.options.pathspecIncludePatterns) {
    rgArgs.push('--glob', normalizeRipgrepGlob(includePattern))
  }

  for (const excludePattern of args.options.excludePatterns) {
    rgArgs.push('--glob', `!${normalizeRipgrepGlob(excludePattern)}`)
  }
  for (const excludePattern of args.options.pathspecExcludePatterns) {
    rgArgs.push('--glob', `!${normalizeRipgrepGlob(excludePattern)}`)
  }

  const patterns = args.options.patterns.length > 0 ? args.options.patterns : [args.options.pattern]
  for (const pattern of patterns) {
    rgArgs.push('--regexp', pattern)
  }
  rgArgs.push('--', args.targetIsDirectory ? '.' : path.basename(args.searchTarget))

  return await new Promise((resolve) => {
    const child = spawn('rg', rgArgs, {
      cwd: args.searchRoot,
      windowsHide: true
    })

    let timedOut = false
    let stdoutBuffer = ''
    let settled = false

    const finish = (
      value: {
        results: GrepResultItem[]
        truncated: boolean
        timedOut: boolean
        limitReason: GrepLimitReason
      } | null
    ): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    const processLine = (rawLine: string): void => {
      if (!rawLine.trim()) return

      if (args.options.outputMode !== 'matches') {
        const line = rawLine.trimEnd()
        if (
          args.options.outputMode === 'files_with_matches' ||
          args.options.outputMode === 'files_without_matches'
        ) {
          const absolutePath = path.isAbsolute(line) ? line : path.join(args.searchRoot, line)
          if (includesDefaultIgnoredDir(absolutePath, args.searchRoot)) return
          if (!collector.appendFile(absolutePath)) child.kill()
          return
        }

        const countMatch = line.match(/^(.*?):(\d+)$/)
        const count = countMatch ? Number(countMatch[2]) : /^\d+$/.test(line) ? Number(line) : null
        const rawPath = countMatch?.[1] || path.basename(args.searchTarget)
        if (count == null || count <= 0) return
        const absolutePath = path.isAbsolute(rawPath)
          ? rawPath
          : path.join(args.searchRoot, rawPath)
        if (includesDefaultIgnoredDir(absolutePath, args.searchRoot)) return
        if (!collector.appendCount(absolutePath, count)) child.kill()
        return
      }

      try {
        const parsed = JSON.parse(rawLine) as {
          type?: string
          data?: {
            path?: { text?: string }
            lines?: { text?: string }
            line_number?: number
            submatches?: Array<{ match?: { text?: string }; start?: number; end?: number }>
          }
        }
        if (parsed.type !== 'match' && parsed.type !== 'context') return

        const rawPath = parsed.data?.path?.text
        const lineNumber = parsed.data?.line_number
        const text = parsed.data?.lines?.text ?? ''
        if (typeof rawPath !== 'string' || typeof lineNumber !== 'number') return

        const absolutePath = path.isAbsolute(rawPath)
          ? rawPath
          : path.join(args.searchRoot, rawPath)
        if (includesDefaultIgnoredDir(absolutePath, args.searchRoot)) return

        const submatches = Array.isArray(parsed.data?.submatches) ? parsed.data.submatches : []
        if (args.options.onlyMatching && parsed.type === 'match' && submatches.length > 0) {
          for (const submatch of submatches) {
            const matchText = submatch.match?.text
            if (typeof matchText !== 'string') continue
            const column =
              args.options.column && typeof submatch.start === 'number'
                ? submatch.start + 1
                : undefined
            if (!collector.append(absolutePath, lineNumber, matchText, 'match', column)) {
              child.kill()
              break
            }
          }
          return
        }

        const column =
          args.options.column && parsed.type === 'match' && typeof submatches[0]?.start === 'number'
            ? submatches[0].start + 1
            : undefined
        if (
          !collector.append(absolutePath, lineNumber, text, parsed.type as GrepMatchKind, column)
        ) {
          child.kill()
        }
      } catch {
        finish(null)
      }
    }

    const flushStdout = (flush = false): void => {
      let newlineIndex = stdoutBuffer.indexOf('\n')
      while (newlineIndex !== -1 || (flush && stdoutBuffer.length > 0)) {
        const endIndex = newlineIndex === -1 ? stdoutBuffer.length : newlineIndex
        const line = stdoutBuffer.slice(0, endIndex)
        stdoutBuffer = stdoutBuffer.slice(Math.min(endIndex + 1, stdoutBuffer.length))
        processLine(line)
        if (settled) return
        newlineIndex = stdoutBuffer.indexOf('\n')
      }
    }

    const remainingTime = Math.max(1000, GREP_TIMEOUT_MS - (Date.now() - args.startTime))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, remainingTime)

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      flushStdout()
    })

    child.on('error', () => {
      finish(null)
    })

    child.on('close', (code) => {
      flushStdout(true)
      if (settled) return

      if (timedOut || collector.truncated) {
        finish({
          results: collector.results,
          truncated: true,
          timedOut,
          limitReason: timedOut ? 'timeout' : collector.limitReason
        })
        return
      }

      if (code === 0 || code === 1) {
        finish({
          results: collector.results,
          truncated: false,
          timedOut: false,
          limitReason: null
        })
        return
      }

      finish(null)
    })
  })
}

export function registerFsHandlers(): void {
  ipcMain.handle(
    'fs:read-file',
    async (_event, args: { path: string; offset?: number; limit?: number; raw?: boolean }) => {
      try {
        const ext = path.extname(args.path).toLowerCase()
        if (IMAGE_EXTENSIONS.has(ext)) {
          await assertFileSize(args.path, MAX_IMAGE_READ_BYTES)
          const buffer = await fs.promises.readFile(args.path)
          return {
            type: 'image',
            mediaType: IMAGE_MIME_TYPES[ext] || 'application/octet-stream',
            data: buffer.toString('base64')
          }
        }
        await assertFileSize(args.path, MAX_FILE_READ_BYTES)
        const content = await fs.promises.readFile(args.path, 'utf-8')

        // Default to raw; only format with line numbers when raw is explicitly false
        if (args.raw !== false) {
          return content
        }

        const normalized = content.replace(/\r\n/g, '\n')
        const lines = normalized.split('\n')
        const MAX_READ_LINES = 2000
        const start = Math.max(0, (args.offset ?? 1) - 1)
        const count = Math.max(0, Math.min(args.limit ?? MAX_READ_LINES, MAX_READ_LINES))
        const clampedEnd = Math.min(start + count, lines.length)
        const lineNoWidth = Math.max(6, String(clampedEnd).length)
        return lines
          .slice(start, clampedEnd)
          .map((line, i) => `${String(start + i + 1).padStart(lineNoWidth)}\t${line}`)
          .join('\n')
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle(
    'fs:write-file',
    async (
      _event,
      args: {
        path: string
        content: string
        changeMeta?: { runId?: string; sessionId?: string; toolUseId?: string; toolName?: string }
      }
    ) => {
      try {
        const beforeExists = fs.existsSync(args.path)
        let beforeText: string | undefined
        if (beforeExists) {
          try {
            beforeText = await fs.promises.readFile(args.path, 'utf-8')
          } catch {
            // best-effort: skip diff if read fails
          }
        }
        const dir = path.dirname(args.path)
        if (!fs.existsSync(dir)) {
          await fs.promises.mkdir(dir, { recursive: true })
        }
        await writeTextFileWithRetries(args.path, args.content)
        recordLocalTextWriteChange({
          meta: args.changeMeta,
          filePath: args.path,
          beforeExists,
          beforeText,
          afterText: args.content
        })
        return { success: true, op: beforeExists ? 'modify' : 'create' }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle(
    'fs:list-dir',
    async (_event, args: { path: string; ignore?: string[]; limit?: number }) => {
      try {
        const resolvedPath = path.resolve(args.path)
        const matcher = await createLocalGitIgnoreContext(resolvedPath, args.ignore)
        const entries = await fs.promises.readdir(resolvedPath, { withFileTypes: true })
        const items: Array<{ name: string; type: 'directory' | 'file'; path: string }> = []
        const limit = clampToolResultLimit(args.limit, MAX_LIST_DIR_ITEMS)

        for (const entry of entries) {
          const entryPath = path.join(resolvedPath, entry.name)
          if (await matcher.ignores(entryPath, entry.isDirectory())) continue
          if (!entry.isDirectory() && !entry.isFile()) continue

          items.push({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
            path: entryPath
          })

          if (limit !== null && items.length >= limit) break
        }

        return items
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle('fs:mkdir', async (_event, args: { path: string }) => {
    try {
      await fs.promises.mkdir(args.path, { recursive: true })
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle('fs:delete', async (_event, args: { path: string }) => {
    try {
      await fs.promises.rm(args.path, { recursive: true, force: true })
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle('fs:move', async (_event, args: { from: string; to: string }) => {
    try {
      await moveFileWithRetries(args.from, args.to)
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle('fs:select-folder', async (_event, args?: { defaultPath?: string }) => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return { canceled: true }
    const defaultPath = args?.defaultPath?.trim()
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      defaultPath: defaultPath || undefined
    })
    if (result.canceled) return { canceled: true }
    return { path: result.filePaths[0] }
  })

  ipcMain.handle('fs:list-desktop-directories', async () => {
    try {
      const desktopPath = app.getPath('desktop')
      const desktopName = path.basename(desktopPath) || 'Desktop'
      const entries = await fs.promises.readdir(desktopPath, { withFileTypes: true })
      const directories = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          name: entry.name,
          path: path.join(desktopPath, entry.name),
          isDesktop: false
        }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

      return {
        desktopPath,
        directories: [
          {
            name: desktopName,
            path: desktopPath,
            isDesktop: true
          },
          ...directories
        ]
      }
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle(
    'fs:glob',
    async (_event, args: { pattern: string; path?: string; limit?: number }) => {
      const cwd = path.resolve(args.path || process.cwd())
      try {
        const matcher = await createLocalGitIgnoreContext(cwd)
        const filteredMatches: Array<{ path: string; type?: 'file' | 'directory' }> = []
        const limit = clampToolResultLimit(args.limit, MAX_GLOB_MATCHES)
        let truncated = false
        const globber = new Glob(args.pattern, {
          cwd,
          mark: true,
          dot: true,
          ignore: buildGlobIgnorePatterns(args.pattern)
        })

        for await (const match of globber) {
          const isDir = /[\\/]$/.test(match)
          const normalizedMatch = match.replace(/[\\/]+$/, '')
          if (!normalizedMatch) continue
          const absolutePath = path.resolve(cwd, normalizedMatch)
          if (await matcher.ignores(absolutePath, isDir)) continue
          filteredMatches.push({ path: absolutePath, type: isDir ? 'directory' : 'file' })

          if (limit !== null && filteredMatches.length >= limit) {
            truncated = true
            break
          }
        }

        return createGlobToolResult({
          searchRoot: cwd,
          pattern: args.pattern,
          matches: filteredMatches,
          truncated,
          limitReason: truncated ? 'max_results' : null
        })
      } catch (err) {
        return createGlobToolResult({
          searchRoot: cwd,
          pattern: args.pattern,
          matches: [],
          error: String(err)
        })
      }
    }
  )

  ipcMain.handle(
    'fs:search-files',
    async (_event, args: { path: string; query: string; limit?: number }) => {
      try {
        const searchRoot = path.resolve(args.path || process.cwd())
        const normalizedQuery = args.query?.trim() ?? ''
        const files = await listSearchableFiles(searchRoot)
        const limit = Math.max(1, Math.min(args.limit ?? FILE_SEARCH_MAX_RESULTS, 100))

        if (!normalizedQuery) {
          return [...files]
            .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
            .slice(0, limit)
            .map((filePath) => ({
              path: filePath,
              name: path.basename(filePath)
            }))
        }

        const topMatches: Array<{ path: string; score: number }> = []

        for (const filePath of files) {
          const score = scoreFileSearchMatch(filePath, normalizedQuery)
          if (!Number.isFinite(score)) continue

          const candidate = { path: filePath, score }
          let insertAt = topMatches.findIndex(
            (item) =>
              score < item.score ||
              (score === item.score &&
                filePath.localeCompare(item.path, undefined, { sensitivity: 'base' }) < 0)
          )
          if (insertAt === -1) insertAt = topMatches.length

          if (insertAt >= limit && topMatches.length >= limit) continue
          topMatches.splice(insertAt, 0, candidate)
          if (topMatches.length > limit) topMatches.length = limit
        }

        return topMatches.map((item) => ({
          path: item.path,
          name: path.basename(item.path)
        }))
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle(
    'fs:grep',
    async (
      _event,
      args: {
        pattern: string
        patterns?: unknown
        andPatterns?: unknown
        orPatterns?: unknown
        notPatterns?: unknown
        path?: string
        include?: string
        exclude?: string
        pathspec?: unknown
        pathspecs?: unknown
        pathspecInclude?: unknown
        pathspecIncludes?: unknown
        pathspecExclude?: unknown
        pathspecExcludes?: unknown
        includes?: unknown
        excludes?: unknown
        ignoreCase?: boolean
        caseSensitive?: boolean
        smartCase?: boolean
        literal?: boolean
        fixed?: boolean
        fixedStrings?: boolean
        basic?: boolean
        basicRegexp?: boolean
        extended?: boolean
        extendedRegexp?: boolean
        perl?: boolean
        perlRegexp?: boolean
        patternMode?: unknown
        regexpType?: unknown
        regexMode?: unknown
        patternOperator?: unknown
        operator?: unknown
        combine?: unknown
        matchOperator?: unknown
        allMatch?: boolean
        word?: boolean
        line?: boolean
        invertMatch?: boolean
        onlyMatching?: boolean
        column?: boolean
        context?: number
        beforeContext?: number
        afterContext?: number
        maxCount?: number
        maxResults?: number
        limit?: number
        maxOutputBytes?: number
        maxLineLength?: number
        maxDepth?: number
        hidden?: boolean
        respectGitignore?: boolean
        excludeStandard?: boolean
        followSymlinks?: boolean
        filesWithMatches?: boolean
        filesWithoutMatches?: boolean
        count?: boolean
        untracked?: boolean
        cached?: boolean
        noIndex?: boolean
        index?: boolean
        text?: boolean
        textconv?: boolean
        threads?: number
        outputMode?: GrepOutputMode
        pathStyle?: GrepPathStyle
      }
    ) => {
      try {
        const options = normalizeGrepOptions(args)
        const searchTarget = path.resolve(args.path || process.cwd())
        const startTime = Date.now()

        let targetStats: fs.Stats
        try {
          targetStats = await fs.promises.stat(searchTarget)
        } catch {
          return createGrepToolResult({
            searchRoot: searchTarget,
            pattern: options.pattern,
            include: options.include,
            exclude: options.exclude,
            outputMode: options.outputMode,
            matches: [],
            options,
            error: `Search path does not exist: ${searchTarget}`
          })
        }

        const searchRoot = targetStats.isDirectory() ? searchTarget : path.dirname(searchTarget)

        const gitGrepResult = await runGitGrepSearch({
          searchRoot,
          searchTarget,
          targetIsDirectory: targetStats.isDirectory(),
          options,
          startTime
        })

        if (gitGrepResult) {
          return createGrepToolResult({
            searchRoot,
            pattern: options.pattern,
            include: options.include,
            exclude: options.exclude,
            outputMode: options.outputMode,
            matches: gitGrepResult.results.map((item) => ({
              path: item.file,
              line: item.line,
              column: item.column,
              text: item.text,
              kind: item.kind,
              count: item.count
            })),
            truncated: gitGrepResult.truncated,
            timedOut: gitGrepResult.timedOut,
            limitReason: gitGrepResult.limitReason,
            engine: 'git_grep',
            searchTime: Date.now() - startTime,
            warnings: gitGrepResult.warnings,
            options
          })
        }

        if (isBasicSidecarGrepOptions(options)) {
          const sidecarResult = await runSidecarGrepSearch({
            pattern: options.pattern,
            searchTarget,
            include: options.include
          })

          if (sidecarResult) {
            return createGrepToolResult({
              searchRoot,
              pattern: options.pattern,
              include: options.include,
              exclude: options.exclude,
              outputMode: options.outputMode,
              matches: sidecarResult.results
                .filter((item) => !includesDefaultIgnoredDir(item.file, searchRoot))
                .map((item) => ({
                  path: formatGrepResultPath(searchRoot, item.file, options.pathStyle),
                  line: item.line,
                  text: item.text,
                  kind: 'match' as const
                })),
              truncated: sidecarResult.truncated,
              timedOut: sidecarResult.timedOut,
              limitReason: sidecarResult.limitReason,
              engine: 'sidecar',
              searchTime: sidecarResult.searchTime,
              options
            })
          }
        }

        const ripgrepResult = await runRipgrepSearch({
          searchRoot,
          searchTarget,
          targetIsDirectory: targetStats.isDirectory(),
          options,
          startTime
        })

        if (ripgrepResult) {
          return createGrepToolResult({
            searchRoot,
            pattern: options.pattern,
            include: options.include,
            exclude: options.exclude,
            outputMode: options.outputMode,
            matches: ripgrepResult.results.map((item) => ({
              path: item.file,
              line: item.line,
              column: item.column,
              text: item.text,
              kind: item.kind,
              count: item.count
            })),
            truncated: ripgrepResult.truncated,
            timedOut: ripgrepResult.timedOut,
            limitReason: ripgrepResult.limitReason,
            engine: 'ripgrep',
            searchTime: Date.now() - startTime,
            options
          })
        }

        let matcher: CompiledGrepMatcher
        try {
          matcher = compileGrepMatcher(options)
        } catch (err) {
          return createGrepToolResult({
            searchRoot,
            pattern: options.pattern,
            include: options.include,
            exclude: options.exclude,
            outputMode: options.outputMode,
            matches: [],
            options,
            error: `Invalid regex pattern: ${err}`
          })
        }

        const { matchesInclude, matchesExclude } = buildSearchPathMatchers(searchRoot, options)
        const gitIgnoreMatcher =
          options.respectGitignore && targetStats.isDirectory()
            ? await createLocalGitIgnoreContext(searchRoot)
            : null

        const collector = createGrepCollector(searchRoot, options)
        let timedOut = false
        const appendNodeResult = (item: GrepResultItem): boolean => {
          if (typeof item.count === 'number') {
            return collector.appendCount(item.file, item.count)
          }
          if (typeof item.line === 'number' && typeof item.text === 'string') {
            return collector.append(item.file, item.line, item.text, item.kind, item.column)
          }
          return collector.appendFile(item.file)
        }

        const searchFile = async (filePath: string): Promise<boolean> => {
          try {
            if (Date.now() - startTime > GREP_TIMEOUT_MS) {
              timedOut = true
              return true
            }

            const stats = await fs.promises.stat(filePath)
            if (stats.size > GREP_MAX_FILE_SIZE || stats.size === 0) return false
            if (gitIgnoreMatcher && (await gitIgnoreMatcher.ignores(filePath, false))) return false
            if (!options.hidden && shouldSkipHiddenPath(filePath, searchRoot)) return false
            if (await isBinaryFile(filePath)) return false

            const scanResult = await scanFileForMatches(filePath, matcher, startTime, options)
            if (scanResult.timedOut) {
              timedOut = true
              return true
            }
            const hasAllPatternMatches = !options.allMatch || scanResult.positiveHits.every(Boolean)
            const results = hasAllPatternMatches
              ? scanResult.results
              : options.outputMode === 'files_without_matches'
                ? [{ file: filePath }]
                : []
            for (const item of results) {
              if (!appendNodeResult(item)) return true
            }
            return collector.truncated
          } catch {
            return false
          }
        }

        const walkDir = async (dir: string): Promise<boolean> => {
          try {
            if (Date.now() - startTime > GREP_TIMEOUT_MS) {
              timedOut = true
              return true
            }

            const entries = await fs.promises.readdir(dir, { withFileTypes: true })
            for (const entry of entries) {
              if (collector.truncated) return true

              const fullPath = path.join(dir, entry.name)
              const relativeDepth = path.relative(searchRoot, fullPath).split(/[\\/]+/).length - 1
              if (options.maxDepth !== null && relativeDepth > options.maxDepth) continue
              if (entry.isDirectory()) {
                if (isDefaultIgnoredDirName(entry.name)) continue
                if (!options.hidden && entry.name.startsWith('.')) continue
                if (gitIgnoreMatcher && (await gitIgnoreMatcher.ignores(fullPath, true))) continue
                if (await walkDir(fullPath)) return true
                continue
              }

              if (entry.isSymbolicLink() && !options.followSymlinks) continue
              let isFile = entry.isFile()
              if (!isFile && options.followSymlinks) {
                try {
                  isFile = (await fs.promises.stat(fullPath)).isFile()
                } catch {
                  isFile = false
                }
              }
              if (!isFile || !matchesInclude(fullPath) || matchesExclude(fullPath)) continue
              if (await searchFile(fullPath)) return true
            }
            return false
          } catch {
            return false
          }
        }

        if (targetStats.isDirectory()) {
          await walkDir(searchTarget)
        } else if (matchesInclude(searchTarget) && !matchesExclude(searchTarget)) {
          await searchFile(searchTarget)
        }

        return createGrepToolResult({
          searchRoot,
          pattern: options.pattern,
          include: options.include,
          exclude: options.exclude,
          outputMode: options.outputMode,
          matches: collector.results.map((item) => ({
            path: item.file,
            line: item.line,
            column: item.column,
            text: item.text,
            kind: item.kind,
            count: item.count
          })),
          truncated: collector.truncated || timedOut,
          timedOut,
          limitReason: timedOut ? 'timeout' : collector.limitReason,
          engine: 'node_fallback',
          searchTime: Date.now() - startTime,
          warnings: matcher.warnings,
          options
        })
      } catch (err) {
        const options = normalizeGrepOptions(args)
        const searchRoot = path.resolve(args.path || process.cwd())
        return createGrepToolResult({
          searchRoot,
          pattern: options.pattern,
          include: options.include,
          exclude: options.exclude,
          outputMode: options.outputMode,
          matches: [],
          options,
          error: String(err)
        })
      }
    }
  )

  ipcMain.handle(
    'fs:save-image',
    async (_event, args: { defaultName: string; dataUrl: string }) => {
      const win = BrowserWindow.getFocusedWindow()
      if (!win) return { canceled: true }
      const result = await dialog.showSaveDialog(win, {
        defaultPath: args.defaultName,
        filters: [{ name: 'PNG Image', extensions: ['png'] }]
      })
      if (result.canceled || !result.filePath) return { canceled: true }
      try {
        const base64 = args.dataUrl.replace(/^data:image\/\w+;base64,/, '')
        await writeBinaryFileWithRetries(result.filePath, Buffer.from(base64, 'base64'))
        return { success: true, filePath: result.filePath }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle(
    'fs:select-save-file',
    async (_event, args?: { defaultPath?: string; filters?: Electron.FileFilter[] }) => {
      const win = BrowserWindow.getFocusedWindow()
      if (!win) return { canceled: true }
      const result = await dialog.showSaveDialog(win, {
        defaultPath: args?.defaultPath,
        filters: args?.filters
      })
      if (result.canceled || !result.filePath) return { canceled: true }
      return { path: result.filePath }
    }
  )

  // Binary file read (returns base64)
  ipcMain.handle('fs:read-file-binary', async (_event, args: { path: string }) => {
    try {
      await assertFileSize(args.path, MAX_FILE_READ_BYTES)
      const buffer = await fs.promises.readFile(args.path)
      return { data: buffer.toString('base64') }
    } catch (err) {
      return { error: String(err) }
    }
  })

  // Binary file write (accepts base64)
  ipcMain.handle('fs:write-file-binary', async (_event, args: { path: string; data: string }) => {
    try {
      const dir = path.dirname(args.path)
      if (!fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true })
      }
      await writeBinaryFileWithRetries(args.path, Buffer.from(args.data, 'base64'))
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  // File watching
  const watchers = new Map<string, fs.FSWatcher>()
  const debounceTimers = new Map<string, NodeJS.Timeout>()

  ipcMain.handle('fs:watch-file', async (_event, args: { path: string }) => {
    const filePath = args.path
    if (watchers.has(filePath)) return { success: true }
    try {
      const watcher = fs.watch(filePath, () => {
        const existing = debounceTimers.get(filePath)
        if (existing) clearTimeout(existing)
        debounceTimers.set(
          filePath,
          setTimeout(() => {
            debounceTimers.delete(filePath)
            const win = BrowserWindow.getAllWindows()[0]
            if (win) {
              safeSendToWindow(win, 'fs:file-changed', { path: filePath })
            }
          }, 300)
        )
      })
      watchers.set(filePath, watcher)
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle('fs:unwatch-file', async (_event, args: { path: string }) => {
    const filePath = args.path
    const watcher = watchers.get(filePath)
    if (watcher) {
      watcher.close()
      watchers.delete(filePath)
    }
    const timer = debounceTimers.get(filePath)
    if (timer) {
      clearTimeout(timer)
      debounceTimers.delete(filePath)
    }
    return { success: true }
  })

  ipcMain.handle(
    'fs:select-file',
    async (_event, args?: { filters?: Electron.FileFilter[]; multiSelections?: boolean }) => {
      const win = BrowserWindow.getFocusedWindow()
      if (!win) return { canceled: true }
      const result = await dialog.showOpenDialog(win, {
        properties: args?.multiSelections ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: args?.filters ?? [
          {
            name: 'Documents',
            extensions: [
              'md',
              'txt',
              'docx',
              'pdf',
              'html',
              'csv',
              'json',
              'xml',
              'yaml',
              'yml',
              'ts',
              'js',
              'tsx',
              'jsx'
            ]
          },
          { name: 'All Files', extensions: ['*'] }
        ]
      })
      if (result.canceled || result.filePaths.length === 0) return { canceled: true }
      return {
        path: result.filePaths[0],
        paths: result.filePaths
      }
    }
  )

  ipcMain.handle('fs:read-document', async (_event, args: { path: string }) => {
    try {
      const ext = path.extname(args.path).toLowerCase()
      if (ext === '.docx') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mammoth = require('mammoth') as typeof import('mammoth')
        const result = await mammoth.extractRawText({ path: args.path })
        return { content: result.value, name: path.basename(args.path) }
      }
      await assertFileSize(args.path, MAX_FILE_READ_BYTES)
      const content = await fs.promises.readFile(args.path, 'utf-8')
      return { content, name: path.basename(args.path) }
    } catch (err) {
      return { error: String(err) }
    }
  })
}
