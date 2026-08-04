export type SelectFileTextSegment =
  | {
      type: 'text'
      text: string
      raw: string
    }
  | {
      type: 'file'
      text: string
      raw: string
      /** Display label carried by the markdown link, when it differs from the path. */
      label?: string
    }
  | {
      type: 'plugin'
      text: string
      raw: string
      pluginId: string
      label: string
      prompt: string
    }

export interface SelectFileMentionQuery {
  start: number
  end: number
  query: string
}

export interface SelectFileTagRange {
  start: number
  end: number
  text: string
  raw: string
  syntax: 'markdown' | 'tag' | 'token' | 'plugin'
  label?: string
  pluginId?: string
  prompt?: string
}

/**
 * `[label](path)` — the canonical form. Legacy `<select-file>` tags and `@{path}` tokens are still
 * parsed so that messages persisted before the switch keep rendering as file chips.
 */
const SELECT_FILE_MARKDOWN_RE =
  /(!?)\[((?:\\.|[^\\[\]\n])*)\]\(\s*(?:<((?:\\.|[^\\<>\n])*)>|((?:\\.|[^\s()\\])+))\s*\)/g
const SELECT_FILE_TAG_RE = /<select-file>([\s\S]*?)<\/select-file>/gi
const SELECT_PLUGIN_TAG_RE = /<select-plugin>([\s\S]*?)<\/select-plugin>/gi
const SELECT_FILE_TOKEN_RE = /@\{([^}\r\n]+)\}/g
const SELECT_FILE_TAG_TEST_RE = /<select-file>[\s\S]*?<\/select-file>/i
const SELECT_FILE_TOKEN_TEST_RE = /@\{[^}\r\n]+\}/
const SELECT_PLUGIN_TAG_TEST_RE = /<select-plugin>[\s\S]*?<\/select-plugin>/i

const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/
const FILE_EXTENSION_RE = /\.[A-Za-z0-9]{1,10}$/

export interface SelectPluginPayload {
  pluginId: string
  label: string
  prompt: string
}

function decodeTagText(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

function encodeTagText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function normalizeFilePath(value: string): string {
  return value.replace(/\\/g, '/').trim()
}

function unescapeMarkdown(value: string): string {
  return value.replace(/\\([\\[\]()<>])/g, '$1')
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/[\\[\]]/g, (char) => `\\${char}`).replace(/\r?\n/g, ' ')
}

function encodeMarkdownDestination(value: string): string {
  if (/[\s()<>]/.test(value)) {
    return `<${value.replace(/[\\<>]/g, (char) => `\\${char}`)}>`
  }
  return value
}

function getBaseName(value: string): string {
  const segments = normalizeFilePath(value).split('/')
  return segments[segments.length - 1] || value
}

/**
 * Distinguishes a file reference from an ordinary markdown link. Web links, anchors and prose links
 * such as `[see here](somewhere)` must stay plain text — only destinations that actually look like a
 * path are promoted to file chips.
 */
function isFileDestination(destination: string, label: string): boolean {
  if (!destination) return false
  if (destination.startsWith('#')) return false
  if (!WINDOWS_DRIVE_RE.test(destination) && URI_SCHEME_RE.test(destination)) return false
  if (/[\\/]/.test(destination)) return true
  if (FILE_EXTENSION_RE.test(destination)) return true
  return normalizeFilePath(label) === normalizeFilePath(destination)
}

function normalizePluginPayload(value: Partial<SelectPluginPayload>): SelectPluginPayload | null {
  const pluginId = String(value.pluginId ?? '').trim()
  if (!pluginId) return null
  const label = String(value.label ?? pluginId).trim() || pluginId
  const prompt = String(value.prompt ?? '').trim()
  if (!prompt) return null
  return { pluginId, label, prompt }
}

function parsePluginPayload(value: string): SelectPluginPayload | null {
  try {
    const parsed = JSON.parse(decodeTagText(value)) as Partial<SelectPluginPayload>
    return normalizePluginPayload(parsed)
  } catch {
    return null
  }
}

function collectSelectFileRanges(text: string): SelectFileTagRange[] {
  if (!text) return []

  const ranges: SelectFileTagRange[] = []

  for (const match of text.matchAll(SELECT_FILE_MARKDOWN_RE)) {
    const start = match.index ?? -1
    const raw = match[0] ?? ''
    if (start < 0 || !raw) continue
    if (match[1]) continue // `![alt](src)` is an image, not a file reference
    const label = unescapeMarkdown(match[2] ?? '')
    const destination = normalizeFilePath(unescapeMarkdown(match[3] ?? match[4] ?? ''))
    if (!isFileDestination(destination, label)) continue
    ranges.push({
      start,
      end: start + raw.length,
      raw,
      text: destination,
      label: label || undefined,
      syntax: 'markdown'
    })
  }

  for (const match of text.matchAll(SELECT_FILE_TAG_RE)) {
    const start = match.index ?? -1
    const raw = match[0] ?? ''
    if (start < 0 || !raw) continue
    ranges.push({
      start,
      end: start + raw.length,
      raw,
      text: normalizeFilePath(decodeTagText(match[1] ?? '')),
      syntax: 'tag'
    })
  }

  for (const match of text.matchAll(SELECT_PLUGIN_TAG_RE)) {
    const start = match.index ?? -1
    const raw = match[0] ?? ''
    if (start < 0 || !raw) continue
    const payload = parsePluginPayload(match[1] ?? '')
    if (!payload) continue
    ranges.push({
      start,
      end: start + raw.length,
      raw,
      text: payload.label,
      syntax: 'plugin',
      pluginId: payload.pluginId,
      label: payload.label,
      prompt: payload.prompt
    })
  }

  for (const match of text.matchAll(SELECT_FILE_TOKEN_RE)) {
    const start = match.index ?? -1
    const raw = match[0] ?? ''
    if (start < 0 || !raw) continue
    ranges.push({
      start,
      end: start + raw.length,
      raw,
      text: normalizeFilePath(match[1] ?? ''),
      syntax: 'token'
    })
  }

  ranges.sort((left, right) => {
    if (left.start !== right.start) return left.start - right.start
    return left.end - right.end
  })

  const merged: SelectFileTagRange[] = []
  for (const range of ranges) {
    const previous = merged[merged.length - 1]
    if (previous && range.start < previous.end) continue
    if (!range.text) continue
    merged.push(range)
  }

  return merged
}

/**
 * Builds the markdown link that represents a file reference in message text.
 * The label defaults to the file's base name so the raw text stays readable outside the composer.
 */
export function createFileReferenceMarkdown(filePath: string, label?: string): string {
  const normalized = normalizeFilePath(filePath)
  if (!normalized) return ''
  const displayLabel = (label ?? getBaseName(normalized)).trim() || normalized
  return `[${escapeMarkdownLabel(displayLabel)}](${encodeMarkdownDestination(normalized)})`
}

export function createSelectPluginTag(payload: SelectPluginPayload): string {
  const normalized = normalizePluginPayload(payload)
  if (!normalized) return ''
  return `<select-plugin>${encodeTagText(JSON.stringify(normalized))}</select-plugin>`
}

export function parseSelectFileText(text: string): SelectFileTextSegment[] {
  if (!text) return []

  const segments: SelectFileTextSegment[] = []
  let lastIndex = 0

  for (const range of collectSelectFileRanges(text)) {
    if (range.start > lastIndex) {
      const plainText = text.slice(lastIndex, range.start)
      if (plainText) {
        segments.push({ type: 'text', text: plainText, raw: plainText })
      }
    }

    if (range.syntax === 'plugin' && range.pluginId && range.label && range.prompt) {
      segments.push({
        type: 'plugin',
        text: range.label,
        raw: range.raw,
        pluginId: range.pluginId,
        label: range.label,
        prompt: range.prompt
      })
    } else {
      segments.push({
        type: 'file',
        text: range.text,
        raw: range.raw,
        label: range.label
      })
    }

    lastIndex = range.end
  }

  if (lastIndex < text.length) {
    const plainText = text.slice(lastIndex)
    if (plainText) {
      segments.push({ type: 'text', text: plainText, raw: plainText })
    }
  }

  return segments
}

export function getSelectFileTagRanges(text: string): SelectFileTagRange[] {
  return collectSelectFileRanges(text)
}

export function hasSelectFileTag(text: string): boolean {
  if (!text) return false
  return (
    SELECT_FILE_TAG_TEST_RE.test(text) ||
    SELECT_FILE_TOKEN_TEST_RE.test(text) ||
    SELECT_PLUGIN_TAG_TEST_RE.test(text) ||
    collectSelectFileRanges(text).some((range) => range.syntax === 'markdown')
  )
}

export function selectFileTextToPlainText(text: string): string {
  const segments = parseSelectFileText(text)
  if (segments.length === 0) return text
  return segments.map((segment) => segment.text).join('')
}

/** Rewrites every recognized reference into the canonical markdown form. */
export function serializeSelectFileText(text: string): string {
  if (!text) return ''
  const segments = parseSelectFileText(text)
  if (segments.length === 0) return text
  return segments
    .map((segment) => {
      if (segment.type === 'file') return createFileReferenceMarkdown(segment.text, segment.label)
      if (segment.type === 'plugin') return createSelectPluginTag(segment)
      return segment.raw
    })
    .join('')
}

export function findSelectFileTagAt(text: string, cursor: number): SelectFileTagRange | null {
  const safeCursor = Math.max(0, Math.min(cursor, text.length))
  for (const range of collectSelectFileRanges(text)) {
    if (safeCursor > range.start && safeCursor < range.end) {
      return range
    }
  }
  return null
}

export function getSelectFileMentionQuery(
  text: string,
  cursor: number
): SelectFileMentionQuery | null {
  const safeCursor = Math.max(0, Math.min(cursor, text.length))
  if (findSelectFileTagAt(text, safeCursor)) return null

  let mentionStart = -1

  for (let index = safeCursor - 1; index >= 0; index -= 1) {
    const char = text[index]
    if (/\s/.test(char)) break
    if (char === '}' || char === '<' || char === '>') return null
    if (char === '@') {
      if (text[index + 1] === '{') return null
      mentionStart = index
      break
    }
  }

  if (mentionStart < 0) return null

  const prefixChar = mentionStart > 0 ? text[mentionStart - 1] : ''
  if (prefixChar && /[A-Za-z0-9_./\\-]/.test(prefixChar)) {
    return null
  }

  return {
    start: mentionStart,
    end: safeCursor,
    query: text.slice(mentionStart + 1, safeCursor)
  }
}
