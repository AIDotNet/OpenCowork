const EDIT_TOOL_PREVIEW_CHARS = 800
const WRITE_TOOL_PREVIEW_CHARS = 1200
// Inline limits deliberately aggressive: any Write > 4KB or Edit payload > 2KB
// gets replaced with a preview + hash + byte count. This bounds resident
// memory and DB footprint for file-mutating tools, and matches what the
// provider actually needs to see on replay (the tool already succeeded).
const WRITE_TOOL_HISTORY_INLINE_LIMIT = 4 * 1024
const EDIT_TOOL_HISTORY_INLINE_LIMIT = 2 * 1024
const HISTORY_PREVIEW_HEAD_CHARS = 800
const HISTORY_PREVIEW_TAIL_CHARS = 320

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function lineCount(text: string): number {
  const normalized = normalizeLineEndings(text)
  return normalized.length === 0 ? 0 : normalized.split('\n').length
}

function sharedPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let index = 0
  while (index < max && a[index] === b[index]) index += 1
  return index
}

function sharedSuffixLength(a: string, b: string, prefixLength: number): number {
  const max = Math.min(a.length, b.length) - prefixLength
  let index = 0
  while (
    index < max &&
    a[a.length - 1 - index] === b[b.length - 1 - index]
  ) {
    index += 1
  }
  return index
}

function excerptAroundRange(text: string, start: number, end: number, maxChars: number): string {
  if (text.length <= maxChars) return text

  const changedLength = Math.max(0, end - start)
  const desiredStart = Math.max(0, start - Math.floor((maxChars - changedLength) / 2))
  const desiredEnd = Math.min(text.length, desiredStart + maxChars)
  const actualStart = Math.max(0, desiredEnd - maxChars)
  const slice = text.slice(actualStart, desiredEnd)

  const prefix = actualStart > 0 ? '…' : ''
  const suffix = desiredEnd < text.length ? '…' : ''
  return `${prefix}${slice}${suffix}`
}

function buildEditPreviewPair(
  oldStr: string,
  newStr: string,
  maxChars: number = EDIT_TOOL_PREVIEW_CHARS
): { oldPreview: string; newPreview: string } {
  if (oldStr.length <= maxChars && newStr.length <= maxChars) {
    return { oldPreview: oldStr, newPreview: newStr }
  }

  const prefixLength = sharedPrefixLength(oldStr, newStr)
  const suffixLength = sharedSuffixLength(oldStr, newStr, prefixLength)
  const oldEnd = Math.max(prefixLength, oldStr.length - suffixLength)
  const newEnd = Math.max(prefixLength, newStr.length - suffixLength)

  return {
    oldPreview: excerptAroundRange(oldStr, prefixLength, oldEnd, maxChars),
    newPreview: excerptAroundRange(newStr, prefixLength, newEnd, maxChars)
  }
}

function fnv1aHash(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function summarizeLargeText(
  text: string,
  options?: {
    inlineLimit?: number
    previewHeadChars?: number
    previewTailChars?: number
    omitFlag?: string
    hashKey?: string
    byteLengthKey?: string
    lineCountKey?: string
    headKey?: string
    tailKey?: string
  }
): Record<string, unknown> {
  const inlineLimit = options?.inlineLimit ?? WRITE_TOOL_HISTORY_INLINE_LIMIT
  if (text.length <= inlineLimit) {
    return {}
  }

  const previewHeadChars = options?.previewHeadChars ?? HISTORY_PREVIEW_HEAD_CHARS
  const previewTailChars = options?.previewTailChars ?? HISTORY_PREVIEW_TAIL_CHARS

  return {
    [options?.omitFlag ?? 'content_omitted']: true,
    [options?.hashKey ?? 'content_hash']: fnv1aHash(text),
    [options?.byteLengthKey ?? 'content_bytes']: new TextEncoder().encode(text).length,
    [options?.lineCountKey ?? 'content_lines']: lineCount(text),
    [options?.headKey ?? 'content_preview']: text.slice(0, previewHeadChars),
    ...(text.length > previewTailChars
      ? { [options?.tailKey ?? 'content_preview_tail']: text.slice(-previewTailChars) }
      : {}),
    content_truncated: true
  }
}

export function compactStreamingToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const hasEditPayload =
    typeof input.old_string === 'string' || typeof input.new_string === 'string'
  const hasWritePayload = typeof input.content === 'string'
  const hasWidgetPayload = typeof input.widget_code === 'string'

  if (!hasEditPayload && !hasWritePayload && !hasWidgetPayload) return input

  const compact: Record<string, unknown> = {}
  if (input.file_path !== undefined) compact.file_path = input.file_path
  if (input.path !== undefined) compact.path = input.path

  if (hasEditPayload) {
    if (input.explanation !== undefined) compact.explanation = input.explanation
    if (input.replace_all !== undefined) compact.replace_all = input.replace_all

    const oldStr = typeof input.old_string === 'string' ? input.old_string : ''
    const newStr = typeof input.new_string === 'string' ? input.new_string : ''
    const { oldPreview, newPreview } = buildEditPreviewPair(oldStr, newStr)

    if (typeof input.old_string === 'string') {
      compact.old_string_preview = oldPreview
      compact.old_string_chars = oldStr.length
      if (oldStr.length > EDIT_TOOL_PREVIEW_CHARS) compact.old_string_truncated = true
    }

    if (typeof input.new_string === 'string') {
      compact.new_string_preview = newPreview
      compact.new_string_chars = newStr.length
      if (newStr.length > EDIT_TOOL_PREVIEW_CHARS) compact.new_string_truncated = true
    }
  }

  if (hasWritePayload) {
    const content = String(input.content)
    compact.content_preview = content.slice(0, WRITE_TOOL_PREVIEW_CHARS)
    compact.content_lines = content.length === 0 ? 0 : lineCount(content)
    compact.content_chars = content.length
    if (content.length > WRITE_TOOL_PREVIEW_CHARS) compact.content_truncated = true
  }

  if (hasWidgetPayload) {
    const widgetCode = String(input.widget_code)
    if (input.title !== undefined) compact.title = input.title
    if (input.loading_messages !== undefined) compact.loading_messages = input.loading_messages
    compact.widget_code_preview = widgetCode.slice(0, WRITE_TOOL_PREVIEW_CHARS)
    compact.widget_code_chars = widgetCode.length
    compact.widget_kind = widgetCode.trimStart().startsWith('<svg') ? 'svg' : 'html'
    if (widgetCode.length > WRITE_TOOL_PREVIEW_CHARS) compact.widget_code_truncated = true
  }

  return compact
}

export function summarizeToolInputForLiveCard(
  toolName: string,
  input: Record<string, unknown>
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input

  if (toolName === 'visualize_show_widget') {
    return input
  }

  if (toolName === 'Write' && typeof input.content === 'string') {
    const content = input.content
    return {
      ...(input.file_path !== undefined ? { file_path: input.file_path } : {}),
      ...(input.path !== undefined ? { path: input.path } : {}),
      content_lines: content.length === 0 ? 0 : lineCount(content),
      content_chars: content.length,
      content_hidden_until_complete: true,
      ...(content.length > WRITE_TOOL_PREVIEW_CHARS ? { content_truncated: true } : {})
    }
  }

  if (
    toolName === 'Edit' &&
    (typeof input.old_string === 'string' || typeof input.new_string === 'string')
  ) {
    const oldStr = typeof input.old_string === 'string' ? input.old_string : ''
    const newStr = typeof input.new_string === 'string' ? input.new_string : ''
    return {
      ...(input.file_path !== undefined ? { file_path: input.file_path } : {}),
      ...(input.path !== undefined ? { path: input.path } : {}),
      ...(input.explanation !== undefined ? { explanation: input.explanation } : {}),
      ...(input.replace_all !== undefined ? { replace_all: input.replace_all } : {}),
      ...(typeof input.old_string === 'string'
        ? {
            old_string_lines: oldStr.length === 0 ? 0 : lineCount(oldStr),
            old_string_chars: oldStr.length
          }
        : {}),
      ...(typeof input.new_string === 'string'
        ? {
            new_string_lines: newStr.length === 0 ? 0 : lineCount(newStr),
            new_string_chars: newStr.length
          }
        : {}),
      content_hidden_until_complete: true
    }
  }

  return compactStreamingToolInput(input)
}

export function summarizeToolInputForHistory(
  toolName: string,
  input: Record<string, unknown>
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input

  if (toolName === 'visualize_show_widget') {
    return input
  }

  if (toolName === 'Write' && typeof input.content === 'string') {
    const content = input.content
    const base = compactStreamingToolInput(input)
    const summary = summarizeLargeText(content, {
      inlineLimit: WRITE_TOOL_HISTORY_INLINE_LIMIT,
      omitFlag: 'content_omitted'
    })
    if (!summary.content_omitted) {
      return input
    }
    return {
      ...base,
      ...summary,
      full_content_available_in_history: false
    }
  }

  if (
    toolName === 'Edit' &&
    (typeof input.old_string === 'string' || typeof input.new_string === 'string')
  ) {
    const oldStr = typeof input.old_string === 'string' ? input.old_string : ''
    const newStr = typeof input.new_string === 'string' ? input.new_string : ''
    const base = compactStreamingToolInput(input)
    const oldSummary = summarizeLargeText(oldStr, {
      inlineLimit: EDIT_TOOL_HISTORY_INLINE_LIMIT,
      omitFlag: 'old_string_omitted',
      hashKey: 'old_string_hash',
      byteLengthKey: 'old_string_bytes',
      lineCountKey: 'old_string_lines',
      headKey: 'old_string_preview',
      tailKey: 'old_string_preview_tail'
    })
    const newSummary = summarizeLargeText(newStr, {
      inlineLimit: EDIT_TOOL_HISTORY_INLINE_LIMIT,
      omitFlag: 'new_string_omitted',
      hashKey: 'new_string_hash',
      byteLengthKey: 'new_string_bytes',
      lineCountKey: 'new_string_lines',
      headKey: 'new_string_preview',
      tailKey: 'new_string_preview_tail'
    })
    if (!oldSummary.old_string_omitted && !newSummary.new_string_omitted) {
      return input
    }
    return {
      ...base,
      ...oldSummary,
      ...newSummary,
      full_content_available_in_history: false
    }
  }

  return input
}

export function sanitizeMessagesForToolReplay<T extends { role: string; content: unknown }>(
  messages: T[]
): T[] {
  let changed = false
  const sanitized = messages.map((message) => {
    if (!Array.isArray(message.content)) return message

    const nextContent = message.content.map((block) => {
      if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'tool_use') {
        return block
      }
      const toolUseBlock = block as {
        type: 'tool_use'
        name?: unknown
        input?: unknown
      }
      const toolName = typeof toolUseBlock.name === 'string' ? toolUseBlock.name : ''
      const toolInput =
        toolUseBlock.input && typeof toolUseBlock.input === 'object' && !Array.isArray(toolUseBlock.input)
          ? (toolUseBlock.input as Record<string, unknown>)
          : {}
      const nextInput = summarizeToolInputForHistory(toolName, toolInput)
      if (nextInput === toolInput) return block
      changed = true
      return { ...toolUseBlock, input: nextInput }
    })

    return nextContent === message.content ? message : { ...message, content: nextContent }
  })

  return changed ? sanitized : messages
}
