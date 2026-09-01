import {
  liveToolInputSignature,
  mergeWidgetToolInput,
  summarizeLiveToolInput,
  type LiveToolInputSummaryOptions
} from '../../../../shared/live-tool-input-summary'

const EDIT_TOOL_PREVIEW_CHARS = 800
const WRITE_TOOL_PREVIEW_CHARS = 1200
const WIDGET_TOOL_RENDER_CHARS = 64_000
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

function tailPreview(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const slice = text.slice(-maxChars)
  const firstLineBreak = slice.indexOf('\n')
  const body = firstLineBreak > 0 ? slice.slice(firstLineBreak + 1) : slice
  return body ? `…\n${body}` : '…'
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

function compactNotebookEditInputForHistory(
  input: Record<string, unknown>
): Record<string, unknown> {
  const source = typeof input.new_source === 'string' ? input.new_source : input.source
  if (typeof source !== 'string') return input

  const summary = summarizeLargeText(source, {
    inlineLimit: EDIT_TOOL_HISTORY_INLINE_LIMIT,
    omitFlag: 'source_omitted',
    hashKey: 'source_hash',
    byteLengthKey: 'source_bytes',
    lineCountKey: 'source_lines',
    headKey: 'source_preview',
    tailKey: 'source_preview_tail'
  })

  if (!summary.source_omitted && source.length <= EDIT_TOOL_PREVIEW_CHARS) return input

  return {
    ...(input.notebook_path !== undefined ? { notebook_path: input.notebook_path } : {}),
    ...(input.file_path !== undefined ? { file_path: input.file_path } : {}),
    ...(input.cell_id !== undefined ? { cell_id: input.cell_id } : {}),
    ...(input.cell_index !== undefined ? { cell_index: input.cell_index } : {}),
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.cell_type !== undefined ? { cell_type: input.cell_type } : {}),
    ...(summary.source_omitted
      ? summary
      : {
          source_preview: source.slice(0, EDIT_TOOL_PREVIEW_CHARS),
          source_chars: source.length,
          source_lines: lineCount(source),
          source_truncated: source.length > EDIT_TOOL_PREVIEW_CHARS
        }),
    full_content_available_in_history: false
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

    if (typeof input.old_string === 'string') {
      compact.old_string_preview = tailPreview(oldStr, EDIT_TOOL_PREVIEW_CHARS)
      compact.old_string_chars = oldStr.length
      compact.old_string_lines = lineCount(oldStr)
      if (oldStr.length > EDIT_TOOL_PREVIEW_CHARS) compact.old_string_truncated = true
    }

    if (typeof input.new_string === 'string') {
      compact.new_string_preview = tailPreview(newStr, EDIT_TOOL_PREVIEW_CHARS)
      compact.new_string_chars = newStr.length
      compact.new_string_lines = lineCount(newStr)
      if (newStr.length > EDIT_TOOL_PREVIEW_CHARS) compact.new_string_truncated = true
    }
  }

  if (hasWritePayload) {
    const content = String(input.content)
    compact.content_preview = tailPreview(content, WRITE_TOOL_PREVIEW_CHARS)
    compact.content_lines = content.length === 0 ? 0 : lineCount(content)
    compact.content_chars = content.length
    if (content.length > WRITE_TOOL_PREVIEW_CHARS) compact.content_truncated = true
  }

  if (hasWidgetPayload) {
    const widgetCode = String(input.widget_code)
    if (input.title !== undefined) compact.title = input.title
    if (input.loading_messages !== undefined) compact.loading_messages = input.loading_messages
    compact.widget_code = widgetCode.slice(0, WIDGET_TOOL_RENDER_CHARS)
    compact.widget_code_chars = widgetCode.length
    compact.widget_kind = widgetCode.trimStart().startsWith('<svg') ? 'svg' : 'html'
    if (widgetCode.length > WIDGET_TOOL_RENDER_CHARS) compact.widget_code_truncated = true
  }

  return compact
}

export function summarizeToolInputForLiveCard(
  toolName: string,
  input: Record<string, unknown>,
  options?: LiveToolInputSummaryOptions
): Record<string, unknown> {
  return summarizeLiveToolInput(toolName, input, options)
}

export { liveToolInputSignature, mergeWidgetToolInput }
export type { LiveLineCountCache } from '../../../../shared/live-tool-input-summary'

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

  if (toolName === 'NotebookEdit') {
    return compactNotebookEditInputForHistory(input)
  }

  return input
}

export function sanitizeMessagesForToolReplay<T extends { role: string; content: unknown }>(
  messages: T[]
): T[] {
  let changed = false
  const sanitized = messages.map((message) => {
    if (!Array.isArray(message.content)) return message

    let blockChanged = false
    const nextContent: unknown[] = []
    for (const block of message.content) {
      // Drop null/undefined or type-less blocks. These can sneak in when an
      // `undefined` element is pushed into a content array and later serialized
      // (JSON.stringify turns array holes/undefined into `null`), which makes
      // provider APIs reject the whole request with a 400 (invalid parameters).
      if (
        !block ||
        typeof block !== 'object' ||
        typeof (block as { type?: unknown }).type !== 'string'
      ) {
        blockChanged = true
        changed = true
        continue
      }

      if ((block as { type?: unknown }).type !== 'tool_use') {
        nextContent.push(block)
        continue
      }
      const toolUseBlock = block as {
        type: 'tool_use'
        name?: unknown
        input?: unknown
      }
      const toolName = typeof toolUseBlock.name === 'string' ? toolUseBlock.name : ''
      const toolInput =
        toolUseBlock.input &&
        typeof toolUseBlock.input === 'object' &&
        !Array.isArray(toolUseBlock.input)
          ? (toolUseBlock.input as Record<string, unknown>)
          : {}
      const nextInput = summarizeToolInputForHistory(toolName, toolInput)
      if (nextInput === toolInput) {
        nextContent.push(block)
        continue
      }
      blockChanged = true
      changed = true
      nextContent.push({ ...toolUseBlock, input: nextInput })
    }

    return blockChanged ? { ...message, content: nextContent } : message
  })

  return changed ? sanitized : messages
}
