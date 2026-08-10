import 'katex/contrib/mhchem'
import { lazy, Suspense } from 'react'
import { defaultUrlTransform, type Components } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { IPC } from '../../ipc/channels'
import { ipcClient } from '../../ipc/ipc-client'

const MermaidBlock = lazy(async () => {
  const mod = await import('./MermaidBlock')
  return { default: mod.MermaidBlock }
})

const HTTP_URL_RE = /^https?:\/\//i
const FILE_URL_RE = /^file:\/\//i
const WINDOWS_ABSOLUTE_PATH_RE = /^[a-zA-Z]:[\\/]/
const OTHER_SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/
const ROOT_FILE_NAME_RE =
  /^(?:package(?:-lock)?\.json|pnpm-lock\.yaml|bun\.lock|tsconfig(?:\.[^.]+)?\.json|README(?:\.[A-Za-z0-9_-]+)?\.md|CHANGELOG\.md|LICENSE|AGENTS\.md|CLAUDE\.md|SOUL\.md|USER\.md|MEMORY\.md|Dockerfile|docker-compose(?:\.[A-Za-z0-9_-]+)?\.ya?ml|Makefile|\.env(?:\.[A-Za-z0-9_-]+)?)$/i
const SPECIAL_FILE_NAME_RE = /^(?:Dockerfile|Makefile|LICENSE)$/i
const PAREN_LINE_RE = /\s+\(line\s+(\d+)(?::(\d+))?\)$/i
const HASH_LINE_RE = /#L(\d+)(?:-L?\d+)?$/i
const COLON_LINE_RE = /(?<!^[a-zA-Z]):(\d+)(?::(\d+))?$/
const EXPLICIT_LINE_RE = /(?::\d+(?::\d+)?)$|#L\d+(?:-L?\d+)?$|\s+\(line\s+\d+(?::\d+)?\)$/i

type MarkdownCodeElementProps = {
  position?: {
    start?: { line?: number }
    end?: { line?: number }
  }
}

export const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkMath]
export const MARKDOWN_REHYPE_PLUGINS = [rehypeKatex]

function isMarkdownCodeBlock(rawCode: string, node?: MarkdownCodeElementProps): boolean {
  const startLine = node?.position?.start?.line
  const endLine = node?.position?.end?.line
  return (
    (typeof startLine === 'number' && typeof endLine === 'number' && startLine !== endLine) ||
    rawCode.includes('\n')
  )
}

function getActiveSessionContext(): { workingFolder?: string; sshConnectionId?: string } {
  const chatState = useChatStore.getState()
  const activeSession = chatState.sessions.find(
    (session) => session.id === chatState.activeSessionId
  )

  return {
    workingFolder: activeSession?.workingFolder?.trim(),
    sshConnectionId: activeSession?.sshConnectionId
  }
}

function stripLocalPathDecorators(value: string): string {
  let normalized = value.trim()
  normalized = normalized.replace(PAREN_LINE_RE, '')
  const queryIndex = normalized.indexOf('?')
  if (queryIndex >= 0) normalized = normalized.slice(0, queryIndex)
  const hashIndex = normalized.indexOf('#')
  if (hashIndex >= 0) normalized = normalized.slice(0, hashIndex)
  if (/(?<!^[a-zA-Z]):\d+(?::\d+)?$/.test(normalized)) {
    normalized = normalized.replace(/:\d+(?::\d+)?$/, '')
  }
  return normalized
}

function decodePathEncoding(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * react-markdown rejects drive-letter and file:// URLs as unknown schemes. Keep only the local
 * path forms that our click handler understands; every other URL still uses its safe default.
 */
export function markdownUrlTransform(value: string): string {
  const decoded = decodePathEncoding(value.trim())
  if (FILE_URL_RE.test(decoded) || WINDOWS_ABSOLUTE_PATH_RE.test(decoded)) {
    return value
  }
  return defaultUrlTransform(value)
}

function getLocalPathTarget(value: string): { line?: number; column?: number } {
  const raw = value.trim()
  const parenMatch = PAREN_LINE_RE.exec(raw)
  const hashMatch = HASH_LINE_RE.exec(raw)
  const colonMatch = COLON_LINE_RE.exec(raw.replace(PAREN_LINE_RE, '').split('#', 1)[0])
  const lineText = parenMatch?.[1] ?? hashMatch?.[1] ?? colonMatch?.[1]
  if (!lineText) return {}

  const line = Number(lineText)
  const columnText = parenMatch?.[2] ?? colonMatch?.[2]
  const column = columnText ? Number(columnText) : undefined
  return {
    line: Number.isFinite(line) && line > 0 ? line : undefined,
    column: column !== undefined && Number.isFinite(column) && column > 0 ? column : undefined
  }
}

function decodeFileUrlPath(value: string): string {
  try {
    const url = new URL(value)
    let pathname = decodeURIComponent(url.pathname || '')
    if (/^\/[a-zA-Z]:/.test(pathname)) pathname = pathname.slice(1)
    if (url.host) {
      return `//${decodeURIComponent(url.host)}${pathname}`
    }
    return pathname
  } catch {
    const raw = value.replace(FILE_URL_RE, '')
    const normalized = raw.startsWith('/') && /^\/[a-zA-Z]:/.test(raw) ? raw.slice(1) : raw
    try {
      return decodeURIComponent(normalized)
    } catch {
      return normalized
    }
  }
}

function hasFileLikeName(value: string): boolean {
  const lastSegment = value.split(/[\\/]/).pop()?.trim() ?? ''
  if (!lastSegment) return false
  return /\.[A-Za-z0-9._-]+$/.test(lastSegment) || SPECIAL_FILE_NAME_RE.test(lastSegment)
}

function joinPath(baseDir: string, relativePath: string): string {
  const trimmedBase = baseDir.replace(/[\\/]+$/, '')
  const trimmedRelative = relativePath.replace(/^\.[\\/]/, '')
  const separator = trimmedBase.includes('\\') && !trimmedBase.includes('/') ? '\\' : '/'
  return `${trimmedBase}${separator}${trimmedRelative}`
}

export function isLikelyLocalFilePath(value: string): boolean {
  const raw = value.trim()
  if (!raw || raw.startsWith('#') || HTTP_URL_RE.test(raw)) return false
  if (FILE_URL_RE.test(raw)) return true

  const normalized = decodePathEncoding(stripLocalPathDecorators(raw))
  if (!normalized) return false
  if (FILE_URL_RE.test(normalized)) return true
  if (OTHER_SCHEME_RE.test(normalized) && !WINDOWS_ABSOLUTE_PATH_RE.test(normalized)) return false

  if (
    WINDOWS_ABSOLUTE_PATH_RE.test(normalized) ||
    normalized.startsWith('\\\\') ||
    normalized.startsWith('/') ||
    normalized.startsWith('./') ||
    normalized.startsWith('../')
  ) {
    return hasFileLikeName(normalized)
  }

  if (normalized.includes('/') || normalized.includes('\\')) {
    return hasFileLikeName(normalized)
  }

  return ROOT_FILE_NAME_RE.test(normalized)
}

export function resolveLocalFilePath(value: string, filePath?: string): string | null {
  if (!isLikelyLocalFilePath(value)) return null

  const stripped = stripLocalPathDecorators(value)
  const decoded = decodePathEncoding(stripped)
  const target = FILE_URL_RE.test(stripped)
    ? decodeFileUrlPath(stripped)
    : FILE_URL_RE.test(decoded)
      ? decodeFileUrlPath(decoded)
      : decoded

  if (
    WINDOWS_ABSOLUTE_PATH_RE.test(target) ||
    target.startsWith('\\\\') ||
    target.startsWith('/')
  ) {
    return target
  }

  const baseDir =
    (filePath ? filePath.replace(/[\\/][^\\/]*$/, '') : getActiveSessionContext().workingFolder) ||
    ''
  if (!baseDir) return null

  return joinPath(baseDir, target)
}

export function openLocalFilePath(value: string, filePath?: string): boolean {
  const resolved = resolveLocalFilePath(value, filePath)
  if (!resolved) return false

  const { sshConnectionId } = getActiveSessionContext()
  const target = getLocalPathTarget(value)
  const viewMode = EXPLICIT_LINE_RE.test(value.trim()) ? 'code' : undefined
  useUIStore
    .getState()
    .openFilePreview(resolved, viewMode, sshConnectionId, undefined, target.line, target.column)
  return true
}

export function openMarkdownHref(href: string, filePath?: string): boolean {
  const link = href.trim()
  if (!link) return false
  if (HTTP_URL_RE.test(link)) {
    void ipcClient.invoke(IPC.SHELL_OPEN_EXTERNAL, link)
    return true
  }
  return openLocalFilePath(link, filePath)
}

export function createMarkdownComponents(filePath?: string): Components {
  const fileDir = filePath ? filePath.replace(/[\\/][^\\/]*$/, '') : ''

  return {
    h1: ({ children, ...props }) => (
      <h1
        className="mt-6 mb-3 first:mt-0 text-2xl font-bold text-foreground border-b border-border/40 pb-2"
        {...props}
      >
        {children}
      </h1>
    ),
    h2: ({ children, ...props }) => (
      <h2
        className="mt-5 mb-2 first:mt-0 text-xl font-semibold text-foreground border-b border-border/30 pb-1"
        {...props}
      >
        {children}
      </h2>
    ),
    h3: ({ children, ...props }) => (
      <h3 className="mt-4 mb-2 first:mt-0 text-lg font-semibold text-foreground" {...props}>
        {children}
      </h3>
    ),
    h4: ({ children, ...props }) => (
      <h4 className="mt-3 mb-1 first:mt-0 text-base font-medium text-foreground/90" {...props}>
        {children}
      </h4>
    ),
    h5: ({ children, ...props }) => (
      <h5
        className="mt-2 mb-1 first:mt-0 text-sm font-medium text-foreground/80 uppercase tracking-wide"
        {...props}
      >
        {children}
      </h5>
    ),
    h6: ({ children, ...props }) => (
      <h6
        className="mt-2 mb-1 first:mt-0 text-sm font-medium text-muted-foreground uppercase tracking-wide"
        {...props}
      >
        {children}
      </h6>
    ),
    blockquote: ({ children, ...props }) => (
      <blockquote
        className="my-3 border-l-2 border-primary/40 pl-4 text-muted-foreground italic"
        {...props}
      >
        {children}
      </blockquote>
    ),
    hr: ({ ...props }) => <hr className="my-4 border-border/50" {...props} />,
    a: ({ href, children, ...props }) => {
      const link = href?.trim() || ''

      return (
        <a
          {...props}
          href={link || undefined}
          className="text-primary underline underline-offset-2 hover:text-primary/80 break-all"
          title={link || href}
          onClick={(event) => {
            if (!link) {
              event.preventDefault()
              return
            }
            const handled = openMarkdownHref(link, filePath)
            if (handled) event.preventDefault()
          }}
        >
          {children}
        </a>
      )
    },
    p: ({ children, ...props }) => (
      <p className="whitespace-pre-wrap break-words" {...props}>
        {children}
      </p>
    ),
    li: ({ children, ...props }) => (
      <li className="break-words [&>p]:whitespace-pre-wrap" {...props}>
        {children}
      </li>
    ),
    table: ({ children, ...props }) => (
      <div className="my-3 overflow-x-auto rounded-lg border border-border/60">
        <table className="min-w-0 w-full border-collapse text-sm" {...props}>
          {children}
        </table>
      </div>
    ),
    thead: ({ children, ...props }) => (
      <thead className="bg-muted/60" {...props}>
        {children}
      </thead>
    ),
    tbody: ({ children, ...props }) => (
      <tbody className="divide-y divide-border/40" {...props}>
        {children}
      </tbody>
    ),
    tr: ({ children, ...props }) => (
      <tr className="hover:bg-muted/30 transition-colors" {...props}>
        {children}
      </tr>
    ),
    th: ({ children, ...props }) => (
      <th
        className="whitespace-pre-wrap break-words px-3 py-2 text-left font-semibold text-foreground/90 border-b border-border/60"
        {...props}
      >
        {children}
      </th>
    ),
    td: ({ children, ...props }) => (
      <td
        className="whitespace-pre-wrap break-words px-3 py-2 text-foreground/80 border-r border-border/30 last:border-r-0"
        {...props}
      >
        {children}
      </td>
    ),
    img: ({ src, alt, ...props }) => {
      let resolvedSrc = src || ''
      if (
        fileDir &&
        resolvedSrc &&
        !resolvedSrc.startsWith('http') &&
        !resolvedSrc.startsWith('data:') &&
        !resolvedSrc.startsWith('file://')
      ) {
        const sep = fileDir.includes('/') ? '/' : '\\'
        resolvedSrc = `file://${fileDir}${sep}${resolvedSrc.replace(/^\.[/\\]/, '')}`
      }
      return (
        <img
          {...props}
          src={resolvedSrc}
          alt={alt || ''}
          className="my-4 block max-w-full rounded-lg border border-border/50 shadow-sm"
          loading="lazy"
        />
      )
    },
    pre: ({ children }) => <>{children}</>,
    code: ({ children, className, node }) => {
      const rawCode = String(children ?? '')
      const code = rawCode.replace(/\n$/, '')
      const languageMatch = /language-([\w-]+)/.exec(className || '')
      const language = languageMatch?.[1]?.toLowerCase()

      if (!className && !isMarkdownCodeBlock(rawCode, node)) {
        const resolvedPath = resolveLocalFilePath(code, filePath)
        if (resolvedPath) {
          return (
            <button
              type="button"
              className="cursor-pointer rounded bg-muted px-1 py-0.5 text-xs font-mono text-primary underline-offset-2 hover:underline"
              title={resolvedPath}
              onClick={() => {
                void openLocalFilePath(code, filePath)
              }}
            >
              {children}
            </button>
          )
        }
        return (
          <code className="not-prose rounded bg-muted px-1 py-0.5 text-xs text-foreground">
            {children}
          </code>
        )
      }

      if (language === 'mermaid') {
        return (
          <Suspense
            fallback={
              <pre className="not-prose my-3 overflow-x-auto rounded-md border border-border/50 bg-muted/60 p-3 text-xs leading-relaxed text-foreground">
                <code className="font-mono text-inherit">{code}</code>
              </pre>
            }
          >
            <MermaidBlock code={code} />
          </Suspense>
        )
      }

      return (
        <pre className="not-prose my-3 overflow-x-auto rounded-md border border-border/50 bg-muted/60 p-3 text-xs leading-relaxed text-foreground">
          <code className={[className, 'font-mono text-inherit'].filter(Boolean).join(' ')}>
            {children}
          </code>
        </pre>
      )
    }
  }
}
