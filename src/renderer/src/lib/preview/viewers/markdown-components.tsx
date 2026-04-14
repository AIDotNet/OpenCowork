import type { Components } from 'react-markdown'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { IPC } from '../../ipc/channels'
import { ipcClient } from '../../ipc/ipc-client'
import { MermaidBlock } from './MermaidBlock'

const HTTP_URL_RE = /^https?:\/\//i
const FILE_URL_RE = /^file:\/\//i
const WINDOWS_ABSOLUTE_PATH_RE = /^[a-zA-Z]:[\\/]/
const OTHER_SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/
const ROOT_FILE_NAME_RE =
  /^(?:package(?:-lock)?\.json|pnpm-lock\.yaml|bun\.lock|tsconfig(?:\.[^.]+)?\.json|README(?:\.[A-Za-z0-9_-]+)?\.md|CHANGELOG\.md|LICENSE|AGENTS\.md|CLAUDE\.md|SOUL\.md|USER\.md|MEMORY\.md|Dockerfile|docker-compose(?:\.[A-Za-z0-9_-]+)?\.ya?ml|Makefile|\.env(?:\.[A-Za-z0-9_-]+)?)$/i
const SPECIAL_FILE_NAME_RE = /^(?:Dockerfile|Makefile|LICENSE)$/i
const EXPLICIT_LINE_RE = /(?::\d+(?::\d+)?)$|#L\d+(?:-L?\d+)?$/i

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
  const queryIndex = normalized.indexOf('?')
  if (queryIndex >= 0) normalized = normalized.slice(0, queryIndex)
  const hashIndex = normalized.indexOf('#')
  if (hashIndex >= 0) normalized = normalized.slice(0, hashIndex)
  if (/(?<!^[a-zA-Z]):\d+(?::\d+)?$/.test(normalized)) {
    normalized = normalized.replace(/:\d+(?::\d+)?$/, '')
  }
  return normalized
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

  const normalized = stripLocalPathDecorators(raw)
  if (!normalized) return false
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

  let target = FILE_URL_RE.test(value) ? decodeFileUrlPath(value) : stripLocalPathDecorators(value)
  try {
    target = decodeURIComponent(target)
  } catch {
    // ignore decode failures and keep original target
  }

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
  const viewMode = EXPLICIT_LINE_RE.test(value.trim()) ? 'code' : undefined
  useUIStore.getState().openFilePreview(resolved, viewMode, sshConnectionId)
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
      <h1 className="mt-6 mb-3 first:mt-0 text-2xl font-bold text-foreground border-b border-border/40 pb-2" {...props}>
        {children}
      </h1>
    ),
    h2: ({ children, ...props }) => (
      <h2 className="mt-5 mb-2 first:mt-0 text-xl font-semibold text-foreground border-b border-border/30 pb-1" {...props}>
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
      <h5 className="mt-2 mb-1 first:mt-0 text-sm font-medium text-foreground/80 uppercase tracking-wide" {...props}>
        {children}
      </h5>
    ),
    h6: ({ children, ...props }) => (
      <h6 className="mt-2 mb-1 first:mt-0 text-sm font-medium text-muted-foreground uppercase tracking-wide" {...props}>
        {children}
      </h6>
    ),
    blockquote: ({ children, ...props }) => (
      <blockquote className="my-3 border-l-2 border-primary/40 pl-4 text-muted-foreground italic" {...props}>
        {children}
      </blockquote>
    ),
    hr: ({ ...props }) => <hr className="my-4 border-border/50" {...props} />,
    a: ({ href, children, ...props }) => {
      const link = href?.trim() || ''

      return (
        <a
          {...props}
          href={link || href}
          className="text-primary underline underline-offset-2 hover:text-primary/80 break-all"
          title={link || href}
          onClick={(event) => {
            const handled = link ? openMarkdownHref(link, filePath) : false
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
    code: ({ children, className }) => {
      const code = String(children ?? '').replace(/\n$/, '')
      const languageMatch = /language-([\w-]+)/.exec(className || '')
      const language = languageMatch?.[1]?.toLowerCase()

      if (!className) {
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
        return <code className="rounded bg-muted px-1 py-0.5 text-xs">{children}</code>
      }

      if (language === 'mermaid') {
        return <MermaidBlock code={code} />
      }

      return (
        <pre className="my-3 overflow-x-auto rounded-md bg-muted/60 p-3 text-xs">
          <code className={className}>{children}</code>
        </pre>
      )
    }
  }
}
