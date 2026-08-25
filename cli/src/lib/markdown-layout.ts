import { Lexer, type Token, type Tokens } from 'marked'
import stringWidth from 'string-width'
import { countWrappedLines, stripTerminalPreviewControls, tailWrappedLines } from './text.js'

/**
 * Geometry for the terminal markdown renderer.
 *
 * `components/markdown.tsx` builds an Ink tree, but the transcript viewport has to know
 * how tall that tree will be *before* it is mounted — an under-measured frame grows past
 * the terminal and makes Ink hard-clear the screen on every render. So the block layout
 * rules live here once and both sides consume them: the component renders the tokens this
 * module lexes, and `message-height.ts` measures the very same tokens.
 *
 * `test/markdown-layout.test.mjs` renders markdown in a real PTY and asserts the measured
 * height matches the rendered row count, so drift between the two fails a test rather
 * than silently corrupting the viewport.
 */

/** Columns the transcript reserves left of an assistant body: bullet/spinner plus a space. */
export const MARKDOWN_GUTTER = 2

const LEX_CACHE_LIMIT = 16
const lexCache = new Map<string, Token[]>()

export function sanitizeMarkdown(value: string): string {
  return stripTerminalPreviewControls(value.replace(/\r\n?/gu, '\n'))
}

/**
 * Lexes markdown, memoized so a streaming reply is parsed once per frame instead of once
 * per consumer. Keyed on the sanitized source; the newest entries win because the live
 * message changes on every delta.
 */
export function lexMarkdown(text: string): Token[] {
  const source = sanitizeMarkdown(text)
  const cached = lexCache.get(source)
  if (cached) return cached

  let tokens: Token[]
  try {
    tokens = Lexer.lex(source, { breaks: false, gfm: true }) as Token[]
  } catch {
    tokens = [{ type: 'text', raw: source, text: source } as Tokens.Text]
  }

  lexCache.set(source, tokens)
  if (lexCache.size > LEX_CACHE_LIMIT) {
    const oldest = lexCache.keys().next()
    if (!oldest.done) lexCache.delete(oldest.value)
  }
  return tokens
}

export function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/giu, '\n')
    .replace(/<[^>]+>/gu, '')
    .trim()
}

export function inlinePlainText(tokens: Token[] | undefined): string {
  if (!tokens) return ''

  return tokens
    .map((token) => {
      if (token.type === 'br') return '\n'
      if (token.type === 'image') {
        const image = token as Tokens.Image
        return image.text || image.href
      }
      if ('tokens' in token && Array.isArray(token.tokens)) {
        return inlinePlainText(token.tokens)
      }
      if ('text' in token && typeof token.text === 'string') return token.text
      return ''
    })
    .join('')
}

/** Link labels reuse the plain text; the target is appended only when it adds information. */
export function linkSuffix(link: Tokens.Link): string {
  const label = inlinePlainText(link.tokens).trim()
  const target = link.href.trim()
  return target && label !== target ? ` (${target})` : ''
}

export function imageLabel(image: Tokens.Image): string {
  return `▣ ${image.text || 'image'}${image.href ? ` (${image.href})` : ''}`
}

/**
 * The characters `InlineMarkdown` puts on screen. Styling changes colors, not columns, so
 * this is what the wrapped width has to be measured against.
 */
export function inlineRenderedText(tokens: Token[] | undefined): string {
  if (!tokens || tokens.length === 0) return ''

  return tokens
    .map((token) => {
      switch (token.type) {
        case 'strong':
          return inlineRenderedText((token as Tokens.Strong).tokens)
        case 'em':
          return inlineRenderedText((token as Tokens.Em).tokens)
        case 'del':
          return inlineRenderedText((token as Tokens.Del).tokens)
        case 'codespan':
          return (token as Tokens.Codespan).text
        case 'link': {
          const link = token as Tokens.Link
          return `${inlineRenderedText(link.tokens)}${linkSuffix(link)}`
        }
        case 'image':
          return imageLabel(token as Tokens.Image)
        case 'br':
          return '\n'
        case 'html': {
          const html = token as Tokens.HTML | Tokens.Tag
          return stripHtml(html.text) || html.text
        }
        case 'text': {
          const text = token as Tokens.Text
          return text.tokens && text.tokens.length > 0 ? inlineRenderedText(text.tokens) : text.text
        }
        case 'escape':
          return (token as Tokens.Escape).text
        default:
          return 'text' in token && typeof token.text === 'string' ? String(token.text) : ''
      }
    })
    .join('')
}

/** Measurements saturate just past `cap`; the viewport only needs "does it fit". */
const UNCAPPED = Number.MAX_SAFE_INTEGER

function wrappedRows(text: string, width: number, cap = UNCAPPED): number {
  if (!text) return 0
  return countWrappedLines(text, Math.max(1, width), cap)
}

export interface TableLayout {
  /** Column content widths, excluding the `│ ` / ` │` padding. */
  widths: number[]
  /** Cell text per row, header first, padded to the column count. */
  rows: string[][]
  /** True when the terminal is too narrow for bordered cells. */
  compact: boolean
}

export function tableLayout(token: Tokens.Table, width: number): TableLayout {
  const columnCount = Math.max(token.header.length, ...token.rows.map((row) => row.length))
  const allRows = [token.header, ...token.rows]
  const rows = allRows.map((row) =>
    Array.from({ length: columnCount }, (_, index) => {
      const cell = row[index]
      return cell ? inlinePlainText(cell.tokens).replace(/\s+/gu, ' ').trim() : ''
    })
  )
  // Each column is rendered as `│ cell `, plus the closing `│`.
  const available = width - (columnCount * 3 + 1)
  if (columnCount === 0 || available < columnCount) {
    return { widths: [], rows, compact: true }
  }

  const widths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(1, ...rows.map((row) => stringWidth(row[column] ?? '')))
  )
  // Shave the widest column until the row fits; mirrors allocateColumnWidths.
  while (widths.reduce((sum, value) => sum + value, 0) > available) {
    let widest = 0
    for (let index = 1; index < widths.length; index += 1) {
      if ((widths[index] ?? 0) > (widths[widest] ?? 0)) widest = index
    }
    if ((widths[widest] ?? 1) <= 1) break
    widths[widest] = (widths[widest] ?? 1) - 1
  }
  return { widths, rows, compact: false }
}

function listMarkerWidth(token: Tokens.List): number {
  const start = typeof token.start === 'number' ? token.start : 1
  const markers = token.items.map((item, index) => {
    if (item.task) return item.checked ? '☒' : '☐'
    if (token.ordered) return `${start + index}.`
    return '•'
  })
  return Math.max(2, ...markers.map((marker) => stringWidth(marker) + 1))
}

function blockRows(token: Token, width: number, depth: number, cap = UNCAPPED): number {
  switch (token.type) {
    case 'heading':
      return wrappedRows(inlineRenderedText((token as Tokens.Heading).tokens), width, cap)
    case 'paragraph':
      return wrappedRows(inlineRenderedText((token as Tokens.Paragraph).tokens), width, cap)
    case 'text': {
      const text = token as Tokens.Text
      const rendered =
        text.tokens && text.tokens.length > 0 ? inlineRenderedText(text.tokens) : text.text
      return wrappedRows(rendered, width, cap)
    }
    case 'code': {
      const code = token as Tokens.Code
      const source = sanitizeMarkdown(code.text).replace(/\t/gu, '  ')
      // A language rule above, a plain rule below, and paddingX={1} on the source box.
      return 2 + Math.max(1, wrappedRows(source, Math.max(1, width - 2), cap))
    }
    case 'blockquote':
      // Left border plus paddingLeft={1}; the bar adds columns, not rows.
      return markdownRows(
        (token as Tokens.Blockquote).tokens,
        Math.max(1, width - 2),
        depth + 1,
        false,
        cap
      )
    case 'list': {
      const list = token as Tokens.List
      const contentWidth = Math.max(1, width - listMarkerWidth(list))
      let rows = 0
      for (const item of list.items) {
        const itemTokens: Token[] =
          item.tokens.length > 0
            ? item.tokens
            : [{ type: 'text', raw: item.text, text: item.text } as Tokens.Text]
        // The marker occupies one row, so an empty item still costs a row.
        rows += Math.max(1, markdownRows(itemTokens, contentWidth, depth + 1, !item.loose, cap))
        if (rows > cap) return rows
      }
      return rows
    }
    case 'table': {
      const table = token as Tokens.Table
      const layout = tableLayout(table, width)
      // Compact falls back to one line per row; bordered adds top, separator, and bottom.
      return layout.compact ? layout.rows.length : table.rows.length + 4
    }
    case 'hr':
      return 1
    case 'html':
      return wrappedRows(stripHtml((token as Tokens.HTML).text), width, cap)
    case 'space':
    case 'def':
      return 0
    default: {
      const fallback =
        'text' in token && typeof token.text === 'string' ? token.text : (token.raw ?? '')
      return wrappedRows(fallback, width, cap)
    }
  }
}

/** Rows a block contributes on top of its own content, mirroring blockMarginTop. */
export function blockMarginRows(token: Token, index: number, compact: boolean): number {
  if (index === 0) return 0
  if (compact && (token.type === 'text' || token.type === 'paragraph' || token.type === 'list')) {
    return 0
  }
  return 1
}

export function visibleMarkdownTokens(tokens: Token[]): Token[] {
  return tokens.filter((token) => token.type !== 'space' && token.type !== 'def')
}

/** Rendered height of a token list, mirroring MarkdownBlocks. */
export function markdownRows(
  tokens: Token[],
  width: number,
  depth = 0,
  compact = false,
  cap = UNCAPPED
): number {
  const visible = visibleMarkdownTokens(tokens)
  let rows = 0
  for (let index = 0; index < visible.length; index += 1) {
    const token = visible[index]!
    rows += blockMarginRows(token, index, compact) + blockRows(token, width, depth, cap)
    if (rows > cap) return rows
  }
  return rows
}

/** Rendered height of a markdown string at `width`. */
export function estimateMarkdownLines(text: string, width: number): number {
  if (!text) return 0
  return markdownRows(lexMarkdown(text), Math.max(1, width))
}

export interface MarkdownClip {
  /** Markdown source for the blocks that still fit, newest last. */
  text: string
  /** Rendered rows dropped from the head. */
  hiddenLines: number
}

/**
 * Trims whole leading blocks until the remainder renders in at most `maxLines` rows.
 *
 * Clipping at block boundaries keeps markdown parseable: slicing raw lines could strip a
 * table's header and separator, which would make the surviving rows lex as a paragraph.
 * When the newest block alone is too tall, its trailing source lines are kept instead so
 * something current stays on screen; that is only reached for a single oversized block.
 */
export function clipMarkdownHead(text: string, width: number, maxLines: number): MarkdownClip {
  const safeWidth = Math.max(1, width)
  const budget = Math.max(1, maxLines)
  const tokens = visibleMarkdownTokens(lexMarkdown(text))
  if (tokens.length === 0) return { text, hiddenLines: 0 }

  const last = tokens.length - 1
  let kept = last
  // Measurements saturate past the budget so an oversized block is not wrapped in full.
  let rows = blockRows(tokens[last]!, safeWidth, 0, budget + 1)
  for (let index = last - 1; index >= 0; index -= 1) {
    // Extending upwards also adds the separator row the newly-second block gains.
    const cost = blockRows(tokens[index]!, safeWidth, 0, budget + 1) + 1
    if (rows + cost > budget) break
    rows += cost
    kept = index
  }

  // The blank lines between blocks live in the `space` tokens filtered out above, so raw
  // sources are rejoined with an explicit block break instead of concatenated.
  const clipped = tokens
    .slice(kept)
    .map((token) => token.raw.replace(/\n+$/u, ''))
    .join('\n\n')
  // Source lines dropped, as a difference rather than a walk over every dropped block:
  // measuring the rendered height of content nobody can see would cost the whole reply.
  // Like the hint it feeds, this is a floor.
  const hiddenLines = Math.max(0, sourceLineCount(text) - sourceLineCount(clipped))

  if (rows <= budget) return { text: clipped, hiddenLines }

  // The newest block alone overflows. Fall back to its trailing source lines, then shrink
  // until the re-parsed remainder measures within budget so the frame stays bounded.
  const tail = tailWrappedLines(clipped, safeWidth, budget)
  let visible = tail.lines
  while (visible.length > 1 && estimateMarkdownLines(visible.join('\n'), safeWidth) > budget) {
    visible = visible.slice(1)
  }
  return {
    text: visible.join('\n'),
    hiddenLines: hiddenLines + tail.hiddenLines + (tail.lines.length - visible.length)
  }
}

function sourceLineCount(raw: string): number {
  let lines = 1
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === '\n') lines += 1
  }
  return lines
}

/**
 * Height of a markdown string, saturating at `cap + 1`.
 *
 * Measuring cannot be skipped by checking the plain-text height first: blank-line runs
 * collapse into a single margin row and a compact table drops a row, so markdown can be
 * *shorter* than its source and a fitting reply would be reported as oversized.
 */
export function countMarkdownLines(text: string, width: number, cap: number): number {
  if (!text) return 0
  const limit = Math.max(1, cap)
  return Math.min(limit + 1, markdownRows(lexMarkdown(text), Math.max(1, width), 0, false, limit))
}
