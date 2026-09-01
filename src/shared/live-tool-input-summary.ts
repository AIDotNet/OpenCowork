const LIVE_PREVIEW_CHARS = 1_200
const LIVE_WIDGET_RENDER_CHARS = 64_000
const LIVE_PRECISE_LINE_COUNT_LIMIT = 128 * 1024
const SIGNATURE_CHARS = 64

export interface LiveLineCountCacheEntry {
  length: number
  lines?: number
  head: string
  tail: string
}

export type LiveLineCountCache = Map<string, LiveLineCountCacheEntry>

export interface LiveToolInputSummaryOptions {
  lineCountCache?: LiveLineCountCache
  cacheKeyPrefix?: string
  preciseLineCountLimit?: number
}

function countNewlines(text: string): number {
  let count = 0
  let index = text.indexOf('\n')
  while (index !== -1) {
    count += 1
    index = text.indexOf('\n', index + 1)
  }
  return count
}

function exactLineCount(text: string): number {
  return text.length === 0 ? 0 : countNewlines(text) + 1
}

function getHead(text: string): string {
  return text.slice(0, SIGNATURE_CHARS)
}

function getTail(text: string): string {
  return text.slice(-SIGNATURE_CHARS)
}

function isLikelyAppend(previous: LiveLineCountCacheEntry, text: string): boolean {
  if (text.length < previous.length) return false
  if (previous.length === 0) return true
  if (!text.startsWith(previous.head)) return false

  const tailStart = Math.max(0, previous.length - previous.tail.length)
  return text.slice(tailStart, previous.length) === previous.tail
}

function countLiveLines(
  text: string,
  key: string,
  options?: LiveToolInputSummaryOptions
): number | undefined {
  const cache = options?.lineCountCache
  const cacheKey = cache ? `${options?.cacheKeyPrefix ?? 'live'}:${key}` : ''
  const previous = cacheKey ? cache?.get(cacheKey) : undefined
  const limit = options?.preciseLineCountLimit ?? LIVE_PRECISE_LINE_COUNT_LIMIT
  let lines: number | undefined

  if (previous?.lines !== undefined && isLikelyAppend(previous, text)) {
    const suffix = text.slice(previous.length)
    lines =
      previous.length === 0 && suffix.length > 0
        ? countNewlines(suffix) + 1
        : previous.lines + countNewlines(suffix)
  } else if (text.length <= limit) {
    lines = exactLineCount(text)
  }

  if (cacheKey && cache) {
    cache.set(cacheKey, {
      length: text.length,
      lines,
      head: getHead(text),
      tail: getTail(text)
    })
  }

  return lines
}

function copyPathFields(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(input.file_path !== undefined ? { file_path: input.file_path } : {}),
    ...(input.path !== undefined ? { path: input.path } : {})
  }
}

function summarizeTextMetric(
  result: Record<string, unknown>,
  key: string,
  text: string,
  options?: LiveToolInputSummaryOptions
): void {
  result[`${key}_chars`] = text.length
  const lines = countLiveLines(text, key, options)
  if (lines !== undefined) {
    result[`${key}_lines`] = lines
  }
  if (text.length > LIVE_PREVIEW_CHARS) {
    result[`${key}_truncated`] = true
  }
}

function buildLiveTailPreview(text: string, maxChars: number = LIVE_PREVIEW_CHARS): string {
  if (text.length <= maxChars) return text
  const slice = text.slice(-maxChars)
  const firstLineBreak = slice.indexOf('\n')
  const body = firstLineBreak > 0 ? slice.slice(firstLineBreak + 1) : slice
  return body ? `…\n${body}` : '…'
}

function summarizeWriteInput(
  input: Record<string, unknown>,
  options?: LiveToolInputSummaryOptions
): Record<string, unknown> {
  const content = typeof input.content === 'string' ? input.content : ''
  const result: Record<string, unknown> = {
    ...copyPathFields(input),
    content_preview: buildLiveTailPreview(content)
  }
  summarizeTextMetric(result, 'content', content, options)
  return result
}

function summarizeEditInput(
  input: Record<string, unknown>,
  options?: LiveToolInputSummaryOptions
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ...copyPathFields(input),
    ...(input.explanation !== undefined ? { explanation: input.explanation } : {}),
    ...(input.replace_all !== undefined ? { replace_all: input.replace_all } : {})
  }

  if (typeof input.old_string === 'string') {
    result.old_string_preview = buildLiveTailPreview(input.old_string)
    summarizeTextMetric(result, 'old_string', input.old_string, options)
  }
  if (typeof input.new_string === 'string') {
    result.new_string_preview = buildLiveTailPreview(input.new_string)
    summarizeTextMetric(result, 'new_string', input.new_string, options)
  }

  return result
}

export function getWidgetRenderCode(input?: Record<string, unknown>): string {
  if (!input) return ''
  if (typeof input.widget_code === 'string') return input.widget_code
  if (typeof input.widget_code_preview === 'string') return input.widget_code_preview
  return ''
}

export function mergeWidgetToolInput(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!next || Object.keys(next).length === 0) return previous ?? {}
  if (!previous || Object.keys(previous).length === 0) return next

  const previousCode = getWidgetRenderCode(previous)
  const nextCode = getWidgetRenderCode(next)
  if (next._truncated === true && !nextCode && previousCode) {
    return previous
  }
  if (!previousCode || nextCode.length >= previousCode.length) return next

  return {
    ...previous,
    ...next,
    ...(typeof previous.widget_code === 'string' ? { widget_code: previous.widget_code } : {}),
    ...(typeof previous.widget_code_preview === 'string' && typeof previous.widget_code !== 'string'
      ? { widget_code_preview: previous.widget_code_preview }
      : {}),
    widget_code_chars:
      typeof next.widget_code_chars === 'number' && typeof previous.widget_code_chars === 'number'
        ? Math.max(previous.widget_code_chars, next.widget_code_chars)
        : (next.widget_code_chars ?? previous.widget_code_chars)
  }
}

function summarizeWidgetInput(
  input: Record<string, unknown>,
  options?: LiveToolInputSummaryOptions
): Record<string, unknown> {
  const widgetCode = typeof input.widget_code === 'string' ? input.widget_code : ''
  const renderCode = widgetCode.slice(0, LIVE_WIDGET_RENDER_CHARS)
  const result: Record<string, unknown> = {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.loading_messages !== undefined ? { loading_messages: input.loading_messages } : {}),
    widget_kind: widgetCode.trimStart().startsWith('<svg') ? 'svg' : 'html',
    ...(renderCode ? { widget_code: renderCode } : {})
  }
  summarizeTextMetric(result, 'widget_code', widgetCode, options)
  if (widgetCode.length > LIVE_WIDGET_RENDER_CHARS) {
    result.widget_code_preview_truncated = true
  }
  return result
}

function summarizeGenericInput(
  input: Record<string, unknown>,
  options?: LiveToolInputSummaryOptions
): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string' || value.length <= LIVE_PREVIEW_CHARS) {
      result[key] = value
      continue
    }

    result[`${key}_preview`] = value.slice(0, LIVE_PREVIEW_CHARS)
    summarizeTextMetric(result, key, value, options)
  }

  return result
}

export function summarizeLiveToolInput(
  toolName: string,
  input: Record<string, unknown>,
  options?: LiveToolInputSummaryOptions
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input

  if (toolName === 'Write' && typeof input.content === 'string') {
    return summarizeWriteInput(input, options)
  }

  if (
    toolName === 'Edit' &&
    (typeof input.old_string === 'string' || typeof input.new_string === 'string')
  ) {
    return summarizeEditInput(input, options)
  }

  if (toolName === 'visualize_show_widget' && typeof input.widget_code === 'string') {
    return summarizeWidgetInput(input, options)
  }

  return summarizeGenericInput(input, options)
}

function valueSignature(value: unknown): string {
  if (typeof value === 'string') {
    return `s:${value.length}:${value.slice(0, 32)}:${value.slice(-32)}`
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return `${typeof value}:${String(value)}`
  }
  if (Array.isArray(value)) {
    return `a:${value.length}`
  }
  if (value && typeof value === 'object') {
    return `o:${Object.keys(value as Record<string, unknown>)
      .sort()
      .join(',')}`
  }
  return typeof value
}

export function liveToolInputSignature(input: Record<string, unknown>): string {
  return Object.keys(input)
    .sort()
    .map((key) => `${key}:${valueSignature(input[key])}`)
    .join('|')
}
