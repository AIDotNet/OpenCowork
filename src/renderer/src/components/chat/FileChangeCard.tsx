import * as React from 'react'
import { FileCode, FilePlus2, FileX2, FileEdit, Loader2, CheckCircle2, XCircle } from 'lucide-react'
import { PrismAsyncLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { cn } from '@renderer/lib/utils'
import type { ToolCallStatus } from '@renderer/lib/agent/types'
import { MONO_FONT } from '@renderer/lib/constants'

// ── Types ────────────────────────────────────────────────────────

interface FileChangeCardProps {
  /** Tool name: Write, Edit, MultiEdit, Delete */
  name: string
  input: Record<string, unknown>
  output?: string
  status: ToolCallStatus | 'completed'
  error?: string
  startedAt?: number
  completedAt?: number
}

// ── Helpers ──────────────────────────────────────────────────────

function detectLang(filePath: string): string {
  const ext = filePath.includes('.') ? filePath.split('.').pop()?.toLowerCase() ?? '' : ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', rs: 'rust', go: 'go', json: 'json',
    css: 'css', scss: 'scss', less: 'less',
    html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
    md: 'markdown', mdx: 'markdown',
    yaml: 'yaml', yml: 'yaml', toml: 'toml',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    sql: 'sql', graphql: 'graphql', gql: 'graphql',
    c: 'c', h: 'c', cpp: 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp',
    java: 'java', kt: 'kotlin', kts: 'kotlin',
    rb: 'ruby', php: 'php', swift: 'swift',
    dockerfile: 'docker', makefile: 'makefile',
    r: 'r', lua: 'lua', dart: 'dart',
    ini: 'ini', env: 'bash', conf: 'ini',
  }
  return map[ext] ?? 'text'
}

function shortPath(filePath: string): string {
  return filePath.split(/[\\/]/).slice(-2).join('/')
}

function fileName(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

type DiffLine = { type: 'keep' | 'add' | 'del'; text: string; oldNum?: number; newNum?: number }

function computeDiff(oldStr: string, newStr: string): DiffLine[] {
  const a = oldStr.split('\n')
  const b = newStr.split('\n')
  const m = a.length, n = b.length

  if (m * n > 100000) {
    return [
      ...a.map((t, i): DiffLine => ({ type: 'del', text: t, oldNum: i + 1 })),
      ...b.map((t, i): DiffLine => ({ type: 'add', text: t, newNum: i + 1 })),
    ]
  }

  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1))
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])

  const result: DiffLine[] = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.push({ type: 'keep', text: a[i - 1], oldNum: i, newNum: j })
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: 'add', text: b[j - 1], newNum: j })
      j--
    } else {
      result.push({ type: 'del', text: a[i - 1], oldNum: i })
      i--
    }
  }
  return result.reverse()
}

type DiffChunk = { type: 'lines'; lines: DiffLine[] } | { type: 'collapsed'; count: number; lines: DiffLine[] }

function foldContext(lines: DiffLine[], ctx: number = 2): DiffChunk[] {
  const chunks: DiffChunk[] = []
  let keepRun: DiffLine[] = []

  const flushKeep = (): void => {
    if (keepRun.length <= ctx * 2 + 1) {
      chunks.push({ type: 'lines', lines: keepRun })
    } else {
      chunks.push({ type: 'lines', lines: keepRun.slice(0, ctx) })
      chunks.push({ type: 'collapsed', count: keepRun.length - ctx * 2, lines: keepRun.slice(ctx, -ctx) })
      chunks.push({ type: 'lines', lines: keepRun.slice(-ctx) })
    }
    keepRun = []
  }

  for (const line of lines) {
    if (line.type === 'keep') {
      keepRun.push(line)
    } else {
      if (keepRun.length > 0) flushKeep()
      if (chunks.length > 0 && chunks[chunks.length - 1].type === 'lines') {
        (chunks[chunks.length - 1] as { type: 'lines'; lines: DiffLine[] }).lines.push(line)
      } else {
        chunks.push({ type: 'lines', lines: [line] })
      }
    }
  }
  if (keepRun.length > 0) flushKeep()
  return chunks
}

// ── Status Icon ──────────────────────────────────────────────────

function StatusIndicator({ status }: { status: FileChangeCardProps['status'] }): React.JSX.Element | null {
  switch (status) {
    case 'running':
      return <Loader2 className="size-3.5 animate-spin text-blue-500 shrink-0" />
    case 'error':
      return <XCircle className="size-3.5 text-destructive shrink-0" />
    case 'completed':
      return <CheckCircle2 className="size-3.5 text-green-500 shrink-0" />
    case 'pending_approval':
      return <Loader2 className="size-3.5 animate-spin text-amber-500 shrink-0" />
    case 'streaming':
      return <Loader2 className="size-3.5 animate-spin text-violet-500 shrink-0" />
    default:
      return null
  }
}

// ── File Icon ────────────────────────────────────────────────────

function FileIcon({ name }: { name: string }): React.JSX.Element {
  switch (name) {
    case 'Write':
      return <FilePlus2 className="size-4 text-green-500" />
    case 'Delete':
      return <FileX2 className="size-4 text-destructive" />
    case 'Edit':
    case 'MultiEdit':
      return <FileEdit className="size-4 text-amber-500" />
    default:
      return <FileCode className="size-4 text-muted-foreground" />
  }
}

// ── Change Stats Badge ───────────────────────────────────────────

function ChangeStats({ name, input }: { name: string; input: Record<string, unknown> }): React.JSX.Element | null {
  if (name === 'Write') {
    const content = String(input.content ?? '')
    const lines = content.split('\n').length
    return (
      <span className="flex items-center gap-1.5 text-[10px]">
        <span className="rounded bg-green-500/15 px-1.5 py-0.5 text-green-500 font-medium">new</span>
        <span className="text-green-400/70">+{lines}</span>
      </span>
    )
  }
  if (name === 'Edit') {
    const oldStr = String(input.old_string ?? '')
    const newStr = String(input.new_string ?? '')
    const removed = oldStr.split('\n').length
    const added = newStr.split('\n').length
    return (
      <span className="flex items-center gap-1 text-[10px]">
        <span className="text-green-400/70">+{added}</span>
        <span className="text-red-400/70">-{removed}</span>
      </span>
    )
  }
  if (name === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits as Array<Record<string, unknown>> : []
    let totalAdded = 0, totalRemoved = 0
    for (const edit of edits) {
      totalRemoved += String(edit.old_string ?? '').split('\n').length
      totalAdded += String(edit.new_string ?? '').split('\n').length
    }
    return (
      <span className="flex items-center gap-1 text-[10px]">
        <span className="text-green-400/70">+{totalAdded}</span>
        <span className="text-red-400/70">-{totalRemoved}</span>
      </span>
    )
  }
  if (name === 'Delete') {
    return (
      <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] text-red-400 font-medium">deleted</span>
    )
  }
  return null
}

// ── Inline Diff View ─────────────────────────────────────────────

function InlineDiff({ oldStr, newStr }: { oldStr: string; newStr: string }): React.JSX.Element {
  const lines = React.useMemo(() => computeDiff(oldStr, newStr), [oldStr, newStr])
  const chunks = React.useMemo(() => foldContext(lines), [lines])
  const [expandedChunks, setExpandedChunks] = React.useState<Set<number>>(new Set())

  const renderLine = (line: DiffLine, key: number): React.JSX.Element => (
    <div key={key} className={cn('flex', line.type === 'del' && 'bg-red-500/10', line.type === 'add' && 'bg-green-500/10')}>
      <span className={cn(
        'select-none w-5 shrink-0 text-right pr-1',
        line.type === 'del' ? 'text-red-400/40' : line.type === 'add' ? 'text-green-400/40' : 'text-zinc-600'
      )}>
        {line.oldNum ?? line.newNum ?? ''}
      </span>
      <span className={cn(
        'px-1.5 flex-1',
        line.type === 'del' && 'text-red-300/80',
        line.type === 'add' && 'text-green-300/80',
        line.type === 'keep' && 'text-zinc-500',
      )}>
        {line.type === 'del' ? '- ' : line.type === 'add' ? '+ ' : '  '}{line.text}
      </span>
    </div>
  )

  return (
    <div
      className="overflow-auto max-h-64 text-[11px] font-mono leading-relaxed"
      style={{ fontFamily: MONO_FONT }}
    >
      {chunks.map((chunk, ci) => {
        if (chunk.type === 'lines') {
          return chunk.lines.map((line, li) => renderLine(line, ci * 1000 + li))
        }
        if (expandedChunks.has(ci)) {
          return chunk.lines.map((line, li) => renderLine(line, ci * 1000 + li))
        }
        return (
          <button
            key={`c${ci}`}
            className="flex w-full items-center justify-center py-0.5 text-[9px] text-zinc-500/50 hover:text-zinc-400 hover:bg-zinc-800/30 transition-colors border-y border-zinc-800/30"
            onClick={() => setExpandedChunks((prev) => new Set([...prev, ci]))}
          >
            ··· {chunk.count} unchanged lines ···
          </button>
        )
      })}
    </div>
  )
}

// ── New File Content View ────────────────────────────────────────

function NewFileContent({ content, filePath }: { content: string; filePath: string }): React.JSX.Element {
  const lang = detectLang(filePath)
  const lines = content.split('\n').length
  const truncated = lines > 50
  const displayed = truncated ? content.split('\n').slice(0, 50).join('\n') : content
  const [expanded, setExpanded] = React.useState(false)

  return (
    <div>
      <SyntaxHighlighter
        language={lang}
        style={oneDark}
        customStyle={{
          margin: 0,
          padding: '0.5rem',
          fontSize: '11px',
          maxHeight: expanded ? '600px' : '200px',
          overflow: 'auto',
          background: 'transparent',
          fontFamily: MONO_FONT,
        }}
        codeTagProps={{ style: { fontFamily: 'inherit' } }}
        showLineNumbers
        lineNumberStyle={{ minWidth: '2em', paddingRight: '0.5em', color: 'rgba(74,222,128,0.3)', userSelect: 'none' }}
        lineProps={() => ({ style: { background: 'rgba(74,222,128,0.05)' } })}
      >
        {expanded ? content : displayed}
      </SyntaxHighlighter>
      {truncated && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="w-full py-1 text-[10px] text-center text-zinc-500/60 hover:text-zinc-400 transition-colors border-t border-zinc-800/30"
        >
          +{lines - 50} more lines
        </button>
      )}
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────────

export function FileChangeCard({
  name,
  input,
  output,
  status,
  error,
  startedAt,
  completedAt,
}: FileChangeCardProps): React.JSX.Element {
  const [collapsed, setCollapsed] = React.useState(false)

  const filePath = String(input.file_path ?? input.path ?? '')
  const elapsed = startedAt && completedAt ? ((completedAt - startedAt) / 1000).toFixed(1) + 's' : null
  const isSuccess = output ? (output.includes('"success"') || output.includes('success')) : false
  const isOutputError = output ? (!isSuccess && output.length > 0) : false

  // Determine border color based on status
  const borderColor =
    status === 'streaming' ? 'border-violet-500/30' :
    status === 'running' ? 'border-blue-500/30' :
    status === 'error' || (isOutputError && !isSuccess) ? 'border-destructive/30' :
    name === 'Write' ? 'border-green-500/20' :
    name === 'Delete' ? 'border-red-500/20' :
    'border-amber-500/20'

  return (
    <div className={cn('my-5 rounded-lg border overflow-hidden transition-all duration-200', borderColor)}>
      {/* Header */}
      <button
        onClick={() => setCollapsed((v) => !v)}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/20',
          status === 'running' && 'bg-blue-500/[0.03]',
        )}
      >
        <FileIcon name={name} />
        <span className="text-xs font-medium truncate min-w-0 flex-1" title={filePath || undefined}>
          {filePath ? fileName(filePath) : <span className="text-muted-foreground/50 italic animate-pulse">receiving...</span>}
        </span>
        <span className="text-[10px] text-muted-foreground/40 font-mono truncate max-w-[120px] hidden sm:block" title={filePath}>
          {shortPath(filePath)}
        </span>
        <ChangeStats name={name} input={input} />
        {elapsed && (
          <span className="text-[9px] text-muted-foreground/30 tabular-nums shrink-0">{elapsed}</span>
        )}
        <StatusIndicator status={status} />
      </button>

      {/* Body — diff or content */}
      {!collapsed && (
        <div className="border-t border-inherit bg-zinc-950">
          {/* Edit: single diff */}
          {name === 'Edit' && !!input.old_string && !!input.new_string && (
            <InlineDiff oldStr={String(input.old_string)} newStr={String(input.new_string)} />
          )}

          {/* MultiEdit: multiple diffs */}
          {name === 'MultiEdit' && Array.isArray(input.edits) && (
            <div className="divide-y divide-zinc-800/40">
              {(input.edits as Array<Record<string, unknown>>).map((edit, i) => (
                <div key={i}>
                  {(input.edits as unknown[]).length > 1 && typeof edit.explanation === 'string' && (
                    <div className="px-3 py-1 text-[9px] text-zinc-500/60 bg-zinc-900/50">
                      edit {i + 1}/{(input.edits as unknown[]).length}: {edit.explanation}
                    </div>
                  )}
                  {edit.old_string && edit.new_string ? (
                    <InlineDiff oldStr={String(edit.old_string)} newStr={String(edit.new_string)} />
                  ) : null}
                </div>
              ))}
            </div>
          )}

          {/* Write: new file content */}
          {name === 'Write' && !!input.content && (
            <NewFileContent content={String(input.content)} filePath={filePath} />
          )}

          {/* Delete: minimal indicator */}
          {name === 'Delete' && (
            <div className="px-3 py-2 text-[11px] text-red-400/60 italic">
              File will be deleted
            </div>
          )}
        </div>
      )}

      {/* Error / output feedback */}
      {error && (
        <div className="border-t border-destructive/20 px-3 py-1.5 bg-destructive/5">
          <p className="text-[11px] text-destructive truncate">{error}</p>
        </div>
      )}
      {output && !error && isOutputError && !isSuccess && (
        <div className="border-t border-destructive/20 px-3 py-1.5 bg-destructive/5">
          <p className="text-[11px] text-destructive/80 font-mono truncate">{output.slice(0, 120)}</p>
        </div>
      )}
    </div>
  )
}
