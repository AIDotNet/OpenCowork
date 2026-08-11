import React from 'react'
import { highlight, supportsLanguage } from 'cli-highlight'
import { Box, Text } from 'ink'
import { Lexer, type Token, type Tokens } from 'marked'
import stringWidth from 'string-width'
import { fitText, padText, stripTerminalPreviewControls } from '../lib/text.js'
import { theme } from '../theme.js'

interface TerminalMarkdownProps {
  text: string
  width: number
}

interface MarkdownBlocksProps {
  compact?: boolean
  depth?: number
  tokens: Token[]
  width: number
}

const languageAliases: Record<string, string> = {
  cjs: 'javascript',
  cs: 'csharp',
  csharp: 'csharp',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  tsx: 'typescript',
  yml: 'yaml'
}

const listBullets = ['•', '◦', '▪']

function sanitizeMarkdown(value: string): string {
  return stripTerminalPreviewControls(value.replace(/\r\n?/gu, '\n'))
}

function normalizeLanguage(value: string | undefined): string | undefined {
  const info = value?.trim().split(/\s+/u)[0]
  if (!info) return undefined

  const normalized = info
    .replace(/^language-/u, '')
    .replace(/^\{?\.?/u, '')
    .replace(/\}?$/u, '')
    .toLowerCase()
  return languageAliases[normalized] ?? normalized
}

function highlightedCode(value: string, language: string | undefined): string {
  if (!value || !language || !supportsLanguage(language)) return value
  try {
    return highlight(value, { ignoreIllegals: true, language })
  } catch {
    return value
  }
}

function inlinePlainText(tokens: Token[] | undefined): string {
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

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/giu, '\n')
    .replace(/<[^>]+>/gu, '')
    .trim()
}

function InlineMarkdown({
  keyPrefix,
  tokens
}: {
  keyPrefix: string
  tokens: Token[] | undefined
}): React.JSX.Element {
  if (!tokens || tokens.length === 0) return <></>

  return (
    <>
      {tokens.map((token, index) => {
        const key = `${keyPrefix}-${index}-${token.type}`

        if (token.type === 'strong') {
          const strong = token as Tokens.Strong
          return (
            <Text bold key={key}>
              <InlineMarkdown keyPrefix={key} tokens={strong.tokens} />
            </Text>
          )
        }

        if (token.type === 'em') {
          const emphasis = token as Tokens.Em
          return (
            <Text italic key={key}>
              <InlineMarkdown keyPrefix={key} tokens={emphasis.tokens} />
            </Text>
          )
        }

        if (token.type === 'del') {
          const deleted = token as Tokens.Del
          return (
            <Text color={theme.muted} key={key} strikethrough>
              <InlineMarkdown keyPrefix={key} tokens={deleted.tokens} />
            </Text>
          )
        }

        if (token.type === 'codespan') {
          const code = token as Tokens.Codespan
          return (
            <Text backgroundColor={theme.inlineCodeBackground} color={theme.code} key={key}>
              {code.text}
            </Text>
          )
        }

        if (token.type === 'link') {
          const link = token as Tokens.Link
          const label = inlinePlainText(link.tokens).trim()
          const target = link.href.trim()
          const showTarget = Boolean(target && label !== target)
          return (
            <Text key={key}>
              <Text color={theme.accent} underline>
                <InlineMarkdown keyPrefix={key} tokens={link.tokens} />
              </Text>
              {showTarget ? <Text color={theme.dim}> ({target})</Text> : null}
            </Text>
          )
        }

        if (token.type === 'image') {
          const image = token as Tokens.Image
          return (
            <Text color={theme.muted} key={key}>
              ▣ {image.text || 'image'}
              {image.href ? <Text color={theme.dim}> ({image.href})</Text> : null}
            </Text>
          )
        }

        if (token.type === 'br') return <React.Fragment key={key}>{'\n'}</React.Fragment>

        if (token.type === 'html') {
          const html = token as Tokens.HTML | Tokens.Tag
          const visible = stripHtml(html.text)
          return <React.Fragment key={key}>{visible || html.text}</React.Fragment>
        }

        if (token.type === 'text') {
          const text = token as Tokens.Text
          return (
            <React.Fragment key={key}>
              {text.tokens && text.tokens.length > 0 ? (
                <InlineMarkdown keyPrefix={key} tokens={text.tokens} />
              ) : (
                text.text
              )}
            </React.Fragment>
          )
        }

        if (token.type === 'escape') {
          return <React.Fragment key={key}>{(token as Tokens.Escape).text}</React.Fragment>
        }

        return <React.Fragment key={key}>{'text' in token ? String(token.text) : ''}</React.Fragment>
      })}
    </>
  )
}

function codeRule(width: number, language: string | undefined): string {
  const safeWidth = Math.max(1, width)
  if (!language) return '─'.repeat(safeWidth)

  const label = ` ${language} `
  if (stringWidth(label) >= safeWidth) return fitText(language, safeWidth)
  return `${'─'.repeat(safeWidth - stringWidth(label))}${label}`
}

function MarkdownCodeBlock({ token, width }: { token: Tokens.Code; width: number }): React.JSX.Element {
  const language = normalizeLanguage(token.lang)
  const source = sanitizeMarkdown(token.text).replace(/\t/gu, '  ')
  const rendered = React.useMemo(() => highlightedCode(source, language), [language, source])
  const innerWidth = Math.max(1, width - 2)

  return (
    <Box flexDirection="column" width={width}>
      <Text color={theme.dim}>{codeRule(width, language)}</Text>
      <Box paddingX={1} width={width}>
        <Text wrap="wrap">{rendered || ' '}</Text>
      </Box>
      <Text color={theme.dim}>{'─'.repeat(Math.max(1, width))}</Text>
    </Box>
  )
}

function listMarker(
  ordered: boolean,
  start: number,
  index: number,
  item: Tokens.ListItem,
  depth: number
): string {
  if (item.task) return item.checked ? '☒' : '☐'
  if (ordered) return `${start + index}.`
  return listBullets[depth % listBullets.length] ?? '•'
}

function MarkdownList({
  depth,
  token,
  width
}: {
  depth: number
  token: Tokens.List
  width: number
}): React.JSX.Element {
  const start = typeof token.start === 'number' ? token.start : 1
  const markers = token.items.map((item, index) =>
    listMarker(token.ordered, start, index, item, depth)
  )
  const markerWidth = Math.max(2, ...markers.map((marker) => stringWidth(marker) + 1))
  const contentWidth = Math.max(1, width - markerWidth)

  return (
    <Box flexDirection="column" width={width}>
      {token.items.map((item, index) => {
        const marker = markers[index] ?? '•'
        const markerPadding = ' '.repeat(Math.max(0, markerWidth - stringWidth(marker) - 1))
        const markerColor = item.task && item.checked ? theme.success : theme.muted
        const itemTokens: Token[] =
          item.tokens.length > 0
            ? item.tokens
            : [{ type: 'text', raw: item.text, text: item.text } as Tokens.Text]

        return (
          <Box alignItems="flex-start" key={`${index}-${item.raw}`} width={width}>
            <Text color={markerColor}>
              {markerPadding}
              {marker}{' '}
            </Text>
            <Box flexDirection="column" width={contentWidth}>
              <MarkdownBlocks
                compact={!item.loose}
                depth={depth + 1}
                tokens={itemTokens}
                width={contentWidth}
              />
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

function allocateColumnWidths(preferred: number[], available: number): number[] {
  const widths = preferred.map((value) => Math.max(1, value))
  while (widths.reduce((sum, value) => sum + value, 0) > available) {
    let widestIndex = 0
    for (let index = 1; index < widths.length; index += 1) {
      if ((widths[index] ?? 0) > (widths[widestIndex] ?? 0)) widestIndex = index
    }
    if ((widths[widestIndex] ?? 1) <= 1) break
    widths[widestIndex] = (widths[widestIndex] ?? 1) - 1
  }
  return widths
}

function alignedCell(value: string, width: number, alignment: Tokens.TableCell['align']): string {
  const fitted = fitText(value, width)
  const padding = Math.max(0, width - stringWidth(fitted))
  if (alignment === 'right') return `${' '.repeat(padding)}${fitted}`
  if (alignment === 'center') {
    const left = Math.floor(padding / 2)
    return `${' '.repeat(left)}${fitted}${' '.repeat(padding - left)}`
  }
  return padText(fitted, width)
}

function MarkdownTable({ token, width }: { token: Tokens.Table; width: number }): React.JSX.Element {
  const columnCount = Math.max(token.header.length, ...token.rows.map((row) => row.length))
  const allRows = [token.header, ...token.rows]
  const textRows = allRows.map((row) =>
    Array.from({ length: columnCount }, (_, index) => {
      const cell = row[index]
      return cell ? inlinePlainText(cell.tokens).replace(/\s+/gu, ' ').trim() : ''
    })
  )
  const overhead = columnCount * 3 + 1
  const available = width - overhead

  if (columnCount === 0 || available < columnCount) {
    return (
      <Box flexDirection="column" width={width}>
        {textRows.map((row, index) => (
          <Text bold={index === 0} key={`${index}-${row.join('|')}`} wrap="wrap">
            {fitText(row.join(' │ '), width)}
          </Text>
        ))}
      </Box>
    )
  }

  const preferred = Array.from({ length: columnCount }, (_, column) =>
    Math.max(1, ...textRows.map((row) => stringWidth(row[column] ?? '')))
  )
  const widths = allocateColumnWidths(preferred, available)
  const border = (left: string, middle: string, right: string): string =>
    `${left}${widths.map((cellWidth) => '─'.repeat(cellWidth + 2)).join(middle)}${right}`
  const rowText = (row: string[], cells: Tokens.TableCell[]): string =>
    `│ ${widths
      .map((cellWidth, index) => alignedCell(row[index] ?? '', cellWidth, cells[index]?.align ?? null))
      .join(' │ ')} │`

  return (
    <Box flexDirection="column" width={width}>
      <Text color={theme.dim}>{border('┌', '┬', '┐')}</Text>
      <Text bold color={theme.text}>
        {rowText(textRows[0] ?? [], token.header)}
      </Text>
      <Text color={theme.dim}>{border('├', '┼', '┤')}</Text>
      {token.rows.map((row, index) => (
        <Text color={theme.text} key={`${index}-${textRows[index + 1]?.join('|') ?? ''}`}>
          {rowText(textRows[index + 1] ?? [], row)}
        </Text>
      ))}
      <Text color={theme.dim}>{border('└', '┴', '┘')}</Text>
    </Box>
  )
}

function MarkdownBlock({
  depth,
  token,
  width
}: {
  depth: number
  token: Token
  width: number
}): React.JSX.Element | null {
  if (token.type === 'heading') {
    const heading = token as Tokens.Heading
    return (
      <Text bold color={heading.depth <= 2 ? theme.accent : theme.text} wrap="wrap">
        <InlineMarkdown keyPrefix={`heading-${depth}`} tokens={heading.tokens} />
      </Text>
    )
  }

  if (token.type === 'paragraph') {
    const paragraph = token as Tokens.Paragraph
    return (
      <Text color={theme.text} wrap="wrap">
        <InlineMarkdown keyPrefix={`paragraph-${depth}`} tokens={paragraph.tokens} />
      </Text>
    )
  }

  if (token.type === 'text') {
    const text = token as Tokens.Text
    return (
      <Text color={theme.text} wrap="wrap">
        {text.tokens && text.tokens.length > 0 ? (
          <InlineMarkdown keyPrefix={`text-${depth}`} tokens={text.tokens} />
        ) : (
          text.text
        )}
      </Text>
    )
  }

  if (token.type === 'code') {
    return <MarkdownCodeBlock token={token as Tokens.Code} width={width} />
  }

  if (token.type === 'blockquote') {
    const quote = token as Tokens.Blockquote
    return (
      <Box
        borderColor={theme.border}
        borderLeft
        borderRight={false}
        borderStyle="single"
        borderTop={false}
        borderBottom={false}
        paddingLeft={1}
        width={width}
      >
        <MarkdownBlocks depth={depth + 1} tokens={quote.tokens} width={Math.max(1, width - 2)} />
      </Box>
    )
  }

  if (token.type === 'list') {
    return <MarkdownList depth={depth} token={token as Tokens.List} width={width} />
  }

  if (token.type === 'table') {
    return <MarkdownTable token={token as Tokens.Table} width={width} />
  }

  if (token.type === 'hr') {
    return <Text color={theme.dim}>{'─'.repeat(Math.max(1, width))}</Text>
  }

  if (token.type === 'html') {
    const html = token as Tokens.HTML
    const visible = stripHtml(html.text)
    return visible ? (
      <Text color={theme.text} wrap="wrap">
        {visible}
      </Text>
    ) : null
  }

  if (token.type === 'space' || token.type === 'def') return null

  const fallback = 'text' in token && typeof token.text === 'string' ? token.text : token.raw
  return fallback ? (
    <Text color={theme.text} wrap="wrap">
      {fallback}
    </Text>
  ) : null
}

function blockMarginTop(token: Token, index: number, compact: boolean): number {
  if (index === 0) return 0
  if (compact && (token.type === 'text' || token.type === 'paragraph' || token.type === 'list')) {
    return 0
  }
  return 1
}

function MarkdownBlocks({
  compact = false,
  depth = 0,
  tokens,
  width
}: MarkdownBlocksProps): React.JSX.Element {
  const visibleTokens = tokens.filter((token) => token.type !== 'space' && token.type !== 'def')

  return (
    <Box flexDirection="column" width={width}>
      {visibleTokens.map((token, index) => (
        <Box
          flexDirection="column"
          key={`${index}-${token.type}-${token.raw}`}
          marginTop={blockMarginTop(token, index, compact)}
          width={width}
        >
          <MarkdownBlock depth={depth} token={token} width={width} />
        </Box>
      ))}
    </Box>
  )
}

export function TerminalMarkdown({ text, width }: TerminalMarkdownProps): React.JSX.Element {
  const safeText = React.useMemo(() => sanitizeMarkdown(text), [text])
  const parsed = React.useMemo(() => {
    try {
      return { tokens: Lexer.lex(safeText, { breaks: false, gfm: true }) as Token[] }
    } catch {
      return { fallback: safeText, tokens: [] as Token[] }
    }
  }, [safeText])

  if (parsed.fallback !== undefined) {
    return (
      <Text color={theme.text} wrap="wrap">
        {parsed.fallback}
      </Text>
    )
  }

  return <MarkdownBlocks tokens={parsed.tokens} width={Math.max(1, width)} />
}
