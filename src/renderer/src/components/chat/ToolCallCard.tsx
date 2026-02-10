import * as React from 'react'
import { ChevronDown, CheckCircle2, XCircle, Copy, Check, ArrowRight, Terminal, FileCode, Search, FolderTree, Folder, File, ListChecks, Circle, CircleDot } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import type { ToolCallStatus } from '@renderer/lib/agent/types'
import { PrismAsyncLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { MONO_FONT } from '@renderer/lib/constants'

interface ToolCallCardProps {
  name: string
  input: Record<string, unknown>
  output?: string
  status: ToolCallStatus | 'completed'
  error?: string
  startedAt?: number
  completedAt?: number
}


function inputSummary(name: string, input: Record<string, unknown>): string {
  // Tool-specific smart summaries
  if (name === 'Bash' && input.command) return String(input.command).slice(0, 80)
  if (['Read', 'Write', 'LS'].includes(name)) {
    const p = String(input.file_path ?? input.path ?? '')
    return p.split(/[\\/]/).slice(-2).join('/')
  }
  if (name === 'Edit') {
    const p = String(input.file_path ?? input.path ?? '').split(/[\\/]/).slice(-2).join('/')
    const expl = typeof input.explanation === 'string' ? ` — ${input.explanation.slice(0, 50)}` : ''
    return `${p}${expl}`
  }
  if (name === 'MultiEdit') {
    const p = String(input.file_path ?? input.path ?? '').split(/[\\/]/).slice(-2).join('/')
    const count = Array.isArray(input.edits) ? ` (${input.edits.length} edits)` : ''
    const expl = typeof input.explanation === 'string' ? ` — ${input.explanation.slice(0, 40)}` : ''
    return `${p}${count}${expl}`
  }
  if (name === 'Delete') {
    const p = String(input.file_path ?? input.path ?? '')
    return `delete: ${p.split(/[\\/]/).slice(-2).join('/')}`
  }
  if (name === 'Glob' && input.pattern) return `pattern: ${input.pattern}`
  if (name === 'Grep' && input.pattern) return `grep: ${input.pattern}`
  if (name === 'TodoWrite' && input.todos) return `${(input.todos as unknown[]).length} items`
  if (name === 'TodoRead') return 'read todos'
  if (name === 'CodeSearch') return String(input.query ?? '').slice(0, 60)
  if (name === 'CodeReview') return `${input.target ?? ''} (${input.focus ?? 'all'})`
  if (name === 'Planner') return String(input.task ?? '').slice(0, 60)
  const keys = Object.keys(input)
  if (keys.length === 0) return ''
  const first = input[keys[0]]
  const val = typeof first === 'string' ? first : JSON.stringify(first)
  return val.length > 60 ? val.slice(0, 60) + '…' : val
}

function CopyBtn({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = React.useState(false)
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
      className="ml-auto rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors"
      title="Copy"
    >
      {copied ? <Check className="size-3 text-green-500" /> : <Copy className="size-3" />}
    </button>
  )
}

function OutputBlock({ output }: { output: string }): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false)
  const isLong = output.length > 500
  const displayed = isLong && !expanded ? output.slice(0, 500) + '…' : output
  return (
    <div>
      <div className="mb-1 flex items-center">
        <p className="text-xs font-medium text-muted-foreground">Output</p>
        <CopyBtn text={output} />
      </div>
      <pre
        className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs font-mono"
        style={{ fontFamily: MONO_FONT }}
      >
        {displayed}
      </pre>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? 'Show less' : `Show all (${output.length} chars, ${output.split('\n').length} lines)`}
        </button>
      )}
    </div>
  )
}

function ReadOutputBlock({ output, filePath }: { output: string; filePath: string }): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false)
  // Detect line-number prefixed content (e.g. "1\tcode") from fs:read-file with offset/limit
  const hasLineNums = /^\d+\t/.test(output)
  const rawContent = hasLineNums
    ? output.split('\n').map((l) => l.replace(/^\d+\t/, '')).join('\n')
    : output
  const lines = rawContent.split('\n')
  const isLong = lines.length > 40
  const displayed = isLong && !expanded ? lines.slice(0, 40).join('\n') : rawContent
  const lang = detectLang(filePath)
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <FileCode className="size-3 text-blue-400" />
        <span
          className="text-xs font-medium text-muted-foreground cursor-pointer hover:text-blue-400 transition-colors truncate"
          title={`Click to insert: ${filePath}`}
          onClick={() => {
            const short = filePath.split(/[\\/]/).slice(-2).join('/')
            import('@renderer/stores/ui-store').then(({ useUIStore }) => useUIStore.getState().setPendingInsertText(short))
          }}
        >
          {filePath.split(/[\\/]/).slice(-2).join('/')}
        </span>
        <span className="text-[9px] text-muted-foreground/40 font-mono">{lang} · {lines.length} lines</span>
        <CopyBtn text={rawContent} />
      </div>
      <SyntaxHighlighter
        language={lang}
        style={oneDark}
        showLineNumbers
        customStyle={{
          margin: 0,
          padding: '0.5rem',
          borderRadius: '0.375rem',
          fontSize: '11px',
          maxHeight: '300px',
          overflow: 'auto',
          fontFamily: MONO_FONT
        }}
        codeTagProps={{ style: { fontFamily: 'inherit' } }}
      >
        {displayed}
      </SyntaxHighlighter>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? 'Show first 40 lines' : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  )
}

function BashOutputBlock({ command, output }: { command: string; output: string }): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false)
  // Try to parse JSON output from shell tool (may contain stdout, stderr, exitCode)
  const parsed = React.useMemo(() => {
    try {
      const obj = JSON.parse(output) as { stdout?: string; stderr?: string; exitCode?: number; output?: string }
      if (typeof obj === 'object' && obj !== null && ('stdout' in obj || 'output' in obj || 'exitCode' in obj)) return obj
    } catch { /* not JSON */ }
    return null
  }, [output])
  const text = parsed ? (parsed.stdout ?? parsed.output ?? '') + (parsed.stderr ? `\n${parsed.stderr}` : '') : output
  const exitCode = parsed?.exitCode
  const isLong = text.length > 1000
  const displayed = isLong && !expanded ? text.slice(0, 1000) + '\n…' : text
  const lineCount = text.split('\n').length
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <Terminal className="size-3 text-green-400" />
        <p className="text-xs font-medium text-muted-foreground">Terminal</p>
        {exitCode !== undefined && (
          <span className={cn('text-[9px] font-mono px-1 rounded', exitCode === 0 ? 'bg-green-500/10 text-green-400/70' : 'bg-red-500/10 text-red-400/70')}>
            exit {exitCode}
          </span>
        )}
        <span className="text-[9px] text-muted-foreground/30">{lineCount} lines</span>
        <CopyBtn text={text} />
      </div>
      <div
        className="rounded-md border bg-zinc-950 overflow-auto max-h-72 text-[11px] font-mono"
        style={{ fontFamily: MONO_FONT }}
      >
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-zinc-800 text-green-400/80">
          <span className="select-none text-green-500/60">$</span>
          <span>{command}</span>
        </div>
        {text && (
          <pre className="px-3 py-2 whitespace-pre-wrap break-words text-zinc-300/80">{displayed}</pre>
        )}
      </div>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? 'Show less' : `Show all (${text.length} chars, ${lineCount} lines)`}
        </button>
      )}
    </div>
  )
}

function HighlightText({ text, pattern }: { text: string; pattern?: string }): React.JSX.Element {
  if (!pattern) return <>{text}</>
  try {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(${escaped})`, 'gi')
    const parts = text.split(re)
    if (parts.length <= 1) return <>{text}</>
    // split with capture group: odd indices are matched groups
    return (
      <>
        {parts.map((part, i) =>
          i % 2 === 1 ? (
            <span key={i} className="bg-amber-500/25 text-amber-300 rounded-sm px-px">{part}</span>
          ) : (
            <span key={i}>{part}</span>
          )
        )}
      </>
    )
  } catch {
    return <>{text}</>
  }
}

function GrepOutputBlock({ output, pattern }: { output: string; pattern?: string }): React.JSX.Element {
  const parsed = React.useMemo(() => {
    try { return JSON.parse(output) as Array<{ file: string; line: number; text: string }> } catch { return null }
  }, [output])
  if (!parsed || !Array.isArray(parsed)) return <OutputBlock output={output} />

  // Group by file
  const groups = React.useMemo(() => {
    const map = new Map<string, Array<{ line: number; text: string }>>()
    for (const r of parsed) {
      const list = map.get(r.file) ?? []
      list.push({ line: r.line, text: r.text })
      map.set(r.file, list)
    }
    return Array.from(map.entries())
  }, [parsed])

  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <Search className="size-3 text-amber-400" />
        <p className="text-xs font-medium text-muted-foreground">Grep Results</p>
        {pattern && <span className="text-[9px] font-mono text-amber-400/50">/{pattern}/</span>}
        <span className="text-[9px] text-muted-foreground/40">{parsed.length} matches in {groups.length} files</span>
        <CopyBtn text={output} />
      </div>
      <div
        className="rounded-md border bg-zinc-950 overflow-auto max-h-72 text-[11px] font-mono divide-y divide-zinc-800"
        style={{ fontFamily: MONO_FONT }}
      >
        {groups.map(([file, matches]) => (
          <div key={file} className="px-2 py-1.5">
            <div
              className="text-blue-400/70 truncate mb-0.5 cursor-pointer hover:text-blue-300 transition-colors"
              title={`Click to insert: ${file}`}
              onClick={() => {
                const short = file.split(/[\\/]/).slice(-2).join('/')
                import('@renderer/stores/ui-store').then(({ useUIStore }) => useUIStore.getState().setPendingInsertText(short))
              }}
            >
              {file.split(/[\\/]/).slice(-3).join('/')}
            </div>
            {matches.map((m, i) => (
              <div key={i} className="flex gap-2 text-zinc-400">
                <span className="select-none text-zinc-600 w-5 text-right shrink-0">{m.line}</span>
                <span className="truncate"><HighlightText text={m.text} pattern={pattern} /></span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function GlobOutputBlock({ output }: { output: string }): React.JSX.Element {
  const parsed = React.useMemo(() => {
    try { return JSON.parse(output) as string[] } catch { return null }
  }, [output])
  if (!parsed || !Array.isArray(parsed)) return <OutputBlock output={output} />

  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <FolderTree className="size-3 text-amber-400" />
        <p className="text-xs font-medium text-muted-foreground">Matches</p>
        <span className="text-[9px] text-muted-foreground/40">{parsed.length} files</span>
        <CopyBtn text={parsed.join('\n')} />
      </div>
      <div
        className="rounded-md border bg-zinc-950 overflow-auto max-h-48 px-3 py-2 text-[11px] font-mono text-zinc-400 space-y-0.5"
        style={{ fontFamily: MONO_FONT }}
      >
        {parsed.map((p, i) => (
          <div
            key={i}
            className="truncate cursor-pointer hover:text-blue-400 transition-colors"
            title={`Click to insert: ${p}`}
            onClick={() => {
              const short = p.split(/[\\/]/).slice(-2).join('/')
              import('@renderer/stores/ui-store').then(({ useUIStore }) => useUIStore.getState().setPendingInsertText(short))
            }}
          >
            {p}
          </div>
        ))}
      </div>
    </div>
  )
}

function LSOutputBlock({ output }: { output: string }): React.JSX.Element {
  const parsed = React.useMemo(() => {
    try { return JSON.parse(output) as Array<{ name: string; type: string; path: string }> } catch { return null }
  }, [output])
  if (!parsed || !Array.isArray(parsed)) return <OutputBlock output={output} />

  const dirs = parsed.filter((e) => e.type === 'directory')
  const files = parsed.filter((e) => e.type === 'file')

  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <FolderTree className="size-3 text-amber-400" />
        <p className="text-xs font-medium text-muted-foreground">Directory Listing</p>
        <span className="text-[9px] text-muted-foreground/40">{dirs.length} folders · {files.length} files</span>
        <CopyBtn text={parsed.map((e) => e.name).join('\n')} />
      </div>
      <div
        className="rounded-md border bg-zinc-950 overflow-auto max-h-48 px-3 py-2 text-[11px] font-mono space-y-0.5"
        style={{ fontFamily: MONO_FONT }}
      >
        {dirs.map((e) => (
          <div key={e.name} className="flex items-center gap-1.5 text-amber-400/70">
            <Folder className="size-3 shrink-0" />
            <span>{e.name}/</span>
          </div>
        ))}
        {files.map((e) => (
          <div
            key={e.name}
            className="flex items-center gap-1.5 text-zinc-400 cursor-pointer hover:text-blue-400 transition-colors"
            title={`Click to insert: ${e.path || e.name}`}
            onClick={() => {
              const short = (e.path || e.name).split(/[\\/]/).slice(-2).join('/')
              import('@renderer/stores/ui-store').then(({ useUIStore }) => useUIStore.getState().setPendingInsertText(short))
            }}
          >
            <File className="size-3 shrink-0 text-zinc-500" />
            <span>{e.name}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function TodoInputBlock({ input }: { input: Record<string, unknown> }): React.JSX.Element | null {
  const todos = input.todos as Array<{ id: string; content: string; status: string; priority: string }> | undefined
  if (!todos || !Array.isArray(todos)) return null

  const statusIcon = (s: string): React.ReactNode => {
    if (s === 'completed') return <CheckCircle2 className="size-3 text-green-500" />
    if (s === 'in_progress') return <CircleDot className="size-3 text-blue-500" />
    return <Circle className="size-3 text-muted-foreground/40" />
  }
  const prioClass = (p: string): string => {
    if (p === 'high') return 'text-red-400 bg-red-500/10'
    if (p === 'medium') return 'text-amber-400 bg-amber-500/10'
    return 'text-muted-foreground/50 bg-muted/30'
  }

  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <ListChecks className="size-3 text-blue-400" />
        <p className="text-xs font-medium text-muted-foreground">Task List</p>
        <span className="text-[9px] text-muted-foreground/40">{todos.length} items</span>
      </div>
      <div className="rounded-md border bg-muted/10 divide-y divide-border/50 text-[12px]">
        {todos.map((t) => (
          <div key={t.id} className="flex items-center gap-2 px-2.5 py-1.5">
            {statusIcon(t.status)}
            <span className={cn('flex-1', t.status === 'completed' && 'line-through text-muted-foreground/50')}>{t.content}</span>
            <span className={cn('rounded px-1 py-0.5 text-[9px] font-medium', prioClass(t.priority))}>{t.priority}</span>
          </div>
        ))}
      </div>
    </div>
  )
}


function TodoOutputBlock({ output }: { output: string }): React.JSX.Element {
  const parsed = React.useMemo(() => {
    try {
      const data = JSON.parse(output)
      if (Array.isArray(data)) return data as Array<{ id: string; content: string; status: string; priority: string }>
      if (data.todos && Array.isArray(data.todos)) return data.todos as Array<{ id: string; content: string; status: string; priority: string }>
    } catch { /* not JSON */ }
    return null
  }, [output])

  if (!parsed) return <OutputBlock output={output} />

  const completed = parsed.filter((t) => t.status === 'completed').length
  const statusIcon = (s: string): React.ReactNode => {
    if (s === 'completed') return <CheckCircle2 className="size-3 text-green-500" />
    if (s === 'in_progress') return <CircleDot className="size-3 text-blue-500" />
    return <Circle className="size-3 text-muted-foreground/40" />
  }
  const prioClass = (p: string): string => {
    if (p === 'high') return 'text-red-400 bg-red-500/10'
    if (p === 'medium') return 'text-amber-400 bg-amber-500/10'
    return 'text-muted-foreground/50 bg-muted/30'
  }

  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <ListChecks className="size-3 text-blue-400" />
        <p className="text-xs font-medium text-muted-foreground">Todos</p>
        <span className="text-[9px] text-muted-foreground/40">{completed}/{parsed.length} done</span>
      </div>
      <div className="rounded-md border bg-muted/10 divide-y divide-border/50 text-[12px]">
        {parsed.map((t) => (
          <div key={t.id} className="flex items-center gap-2 px-2.5 py-1.5">
            {statusIcon(t.status)}
            <span className={cn('flex-1', t.status === 'completed' && 'line-through text-muted-foreground/50')}>{t.content}</span>
            <span className={cn('rounded px-1 py-0.5 text-[9px] font-medium', prioClass(t.priority))}>{t.priority}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

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

type DiffLine = { type: 'keep' | 'add' | 'del'; text: string; oldNum?: number; newNum?: number }

function computeDiff(oldStr: string, newStr: string): DiffLine[] {
  const a = oldStr.split('\n')
  const b = newStr.split('\n')
  const m = a.length, n = b.length

  // Simple LCS DP for small inputs; fall back to naive for large diffs
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

function DiffBlock({ oldStr, newStr, filePath }: { oldStr: string; newStr: string; filePath?: string }): React.JSX.Element {
  const lines = React.useMemo(() => computeDiff(oldStr, newStr), [oldStr, newStr])
  const chunks = React.useMemo(() => foldContext(lines), [lines])
  const [expandedChunks, setExpandedChunks] = React.useState<Set<number>>(new Set())
  const added = lines.filter((l) => l.type === 'add').length
  const removed = lines.filter((l) => l.type === 'del').length

  const renderLine = (line: DiffLine, i: number): React.JSX.Element => (
    <div key={i} className={cn('flex', line.type === 'del' && 'bg-red-500/10', line.type === 'add' && 'bg-green-500/10')}>
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
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <ArrowRight className="size-3 text-muted-foreground" />
        <p className="text-xs font-medium text-muted-foreground">Diff</p>
        {filePath && (
          <span className="text-[10px] text-muted-foreground/40 font-mono truncate">{filePath.split(/[\\/]/).slice(-2).join('/')}</span>
        )}
        <span className="text-[9px] text-muted-foreground/30">
          {removed > 0 && <span className="text-red-400/60">-{removed}</span>}
          {removed > 0 && added > 0 && ' '}
          {added > 0 && <span className="text-green-400/60">+{added}</span>}
        </span>
      </div>
      <div
        className="rounded-md border bg-zinc-950 overflow-auto max-h-64 text-[11px] font-mono leading-relaxed"
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
    </div>
  )
}

/** Structured input field row */
function InputField({ label, value, mono, icon }: { label: string; value: string; mono?: boolean; icon?: React.ReactNode }): React.JSX.Element | null {
  if (!value) return null
  return (
    <div className="flex items-start gap-2 text-[12px]">
      <span className="shrink-0 text-muted-foreground/50 min-w-[70px] text-right select-none flex items-center justify-end gap-1">
        {icon}{label}
      </span>
      <span className={cn('break-all', mono && 'font-mono text-[11px]')} style={mono ? { fontFamily: MONO_FONT } : undefined}>
        {value}
      </span>
    </div>
  )
}

/** Render tool input as structured UI instead of raw JSON */
function StructuredInput({ name, input }: { name: string; input: Record<string, unknown> }): React.JSX.Element {
  // Bash: command in terminal-style block + description/timeout as fields
  if (name === 'Bash') {
    const command = String(input.command ?? '')
    const description = input.description ? String(input.description) : null
    const timeout = input.timeout ? String(input.timeout) : null
    return (
      <div className="space-y-1.5">
        {description && (
          <p className="text-xs text-muted-foreground/60 italic">{description}</p>
        )}
        <div
          className="rounded-md border bg-zinc-950 text-[11px] font-mono overflow-auto max-h-40"
          style={{ fontFamily: MONO_FONT }}
        >
          <div className="flex items-start gap-1.5 px-3 py-2 text-green-400/80">
            <span className="select-none text-green-500/60 shrink-0">$</span>
            <span className="whitespace-pre-wrap break-all">{command}</span>
          </div>
        </div>
        {timeout && (
          <span className="text-[10px] text-muted-foreground/40">timeout: {timeout}ms</span>
        )}
      </div>
    )
  }

  // Read: file path + optional offset/limit
  if (name === 'Read') {
    const filePath = String(input.file_path ?? input.path ?? '')
    const offset = input.offset != null ? String(input.offset) : null
    const limit = input.limit != null ? String(input.limit) : null
    return (
      <div className="space-y-0.5">
        <div className="flex items-center gap-1.5 text-xs">
          <FileCode className="size-3 text-blue-400" />
          <span className="font-mono text-[11px] break-all" style={{ fontFamily: MONO_FONT }}>{filePath}</span>
        </div>
        {(offset || limit) && (
          <div className="flex items-center gap-2 pl-[18px]">
            {offset && <span className="text-[10px] text-muted-foreground/40">offset: {offset}</span>}
            {limit && <span className="text-[10px] text-muted-foreground/40">limit: {limit}</span>}
          </div>
        )}
      </div>
    )
  }

  // LS: path
  if (name === 'LS') {
    const path = String(input.path ?? '')
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <Folder className="size-3 text-amber-400" />
        <span className="font-mono text-[11px] break-all" style={{ fontFamily: MONO_FONT }}>{path}</span>
      </div>
    )
  }

  // Delete: file path
  if (name === 'Delete') {
    const filePath = String(input.file_path ?? input.path ?? '')
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <File className="size-3 text-red-400" />
        <span className="font-mono text-[11px] break-all text-red-400/70" style={{ fontFamily: MONO_FONT }}>{filePath}</span>
      </div>
    )
  }

  // Glob: pattern + optional path
  if (name === 'Glob') {
    const pattern = String(input.pattern ?? '')
    const path = input.path ? String(input.path) : null
    return (
      <div className="space-y-0.5">
        <div className="flex items-center gap-1.5 text-xs">
          <FolderTree className="size-3 text-amber-400" />
          <span className="font-mono text-[11px] text-amber-400/80" style={{ fontFamily: MONO_FONT }}>{pattern}</span>
        </div>
        {path && (
          <div className="pl-[18px]">
            <span className="text-[10px] text-muted-foreground/40 font-mono" style={{ fontFamily: MONO_FONT }}>in {path}</span>
          </div>
        )}
      </div>
    )
  }

  // Grep: pattern + path + optional include
  if (name === 'Grep') {
    const pattern = String(input.pattern ?? '')
    const path = input.path ? String(input.path) : null
    const include = input.include ? String(input.include) : null
    return (
      <div className="space-y-0.5">
        <div className="flex items-center gap-1.5 text-xs">
          <Search className="size-3 text-amber-400" />
          <span className="font-mono text-[11px] text-amber-400/80" style={{ fontFamily: MONO_FONT }}>/{pattern}/</span>
        </div>
        {(path || include) && (
          <div className="flex items-center gap-2 pl-[18px]">
            {path && <span className="text-[10px] text-muted-foreground/40 font-mono" style={{ fontFamily: MONO_FONT }}>in {path}</span>}
            {include && <span className="text-[10px] text-muted-foreground/40 font-mono" style={{ fontFamily: MONO_FONT }}>include: {include}</span>}
          </div>
        )}
      </div>
    )
  }

  // SubAgents (CodeSearch, CodeReview, Planner)
  if (name === 'CodeSearch' || name === 'CodeReview' || name === 'Planner') {
    const fields: Array<{ label: string; value: string }> = []
    for (const [k, v] of Object.entries(input)) {
      if (v != null && v !== '') fields.push({ label: k, value: String(v) })
    }
    return (
      <div className="space-y-0.5">
        {fields.map((f) => (
          <InputField key={f.label} label={f.label} value={f.value.length > 200 ? f.value.slice(0, 200) + '…' : f.value} />
        ))}
      </div>
    )
  }

  // Generic fallback: structured key-value pairs instead of raw JSON
  const entries = Object.entries(input).filter(([, v]) => v != null && v !== '')
  if (entries.length === 0) return <></>
  return (
    <div className="space-y-0.5">
      {entries.map(([key, value]) => {
        const str = typeof value === 'string' ? value : JSON.stringify(value)
        const isLong = str.length > 300
        return (
          <InputField
            key={key}
            label={key}
            value={isLong ? str.slice(0, 300) + '…' : str}
            mono={typeof value !== 'string'}
          />
        )
      })}
    </div>
  )
}

// Tools that auto-expand when they have output (mutation/action tools)
const EXPAND_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'Delete', 'Bash', 'TodoWrite'])

function ToolStatusDot({ status }: { status: ToolCallCardProps['status'] }): React.JSX.Element {
  switch (status) {
    case 'completed':
      return (
        <span className="relative flex size-3.5 shrink-0 items-center justify-center">
          <span className="size-2.5 rounded-full bg-green-500" />
        </span>
      )
    case 'running':
      return (
        <span className="relative flex size-3.5 shrink-0 items-center justify-center">
          <span className="absolute size-2.5 rounded-full bg-blue-500/30 animate-ping" />
          <span className="size-2.5 rounded-full bg-blue-500" />
        </span>
      )
    case 'error':
      return (
        <span className="relative flex size-3.5 shrink-0 items-center justify-center">
          <span className="size-2.5 rounded-full bg-destructive" />
        </span>
      )
    case 'pending_approval':
      return (
        <span className="relative flex size-3.5 shrink-0 items-center justify-center">
          <span className="absolute size-2.5 rounded-full bg-amber-500/30 animate-ping" />
          <span className="size-2.5 rounded-full bg-amber-500" />
        </span>
      )
    case 'streaming':
      return (
        <span className="relative flex size-3.5 shrink-0 items-center justify-center">
          <span className="absolute size-2.5 rounded-full bg-violet-500/30 animate-ping" />
          <span className="size-2.5 rounded-full bg-violet-500" />
        </span>
      )
    default:
      return (
        <span className="relative flex size-3.5 shrink-0 items-center justify-center">
          <span className="size-2.5 rounded-full border border-muted-foreground/30" />
        </span>
      )
  }
}

export function ToolCallCard({
  name,
  input,
  output,
  status,
  error,
  startedAt,
  completedAt,
}: ToolCallCardProps): React.JSX.Element {
  // Auto-expand for errors and mutation tools with output; keep read-heavy tools collapsed
  const shouldAutoExpand = status === 'error' || (!!output && EXPAND_TOOLS.has(name))
  const [open, setOpen] = React.useState(shouldAutoExpand)

  React.useEffect(() => {
    if (shouldAutoExpand) setOpen(true)
  }, [shouldAutoExpand])

  const summary = inputSummary(name, input)
  const elapsed = startedAt && completedAt ? ((completedAt - startedAt) / 1000).toFixed(1) + 's' : null

  return (
    <div className="my-5 min-w-0 overflow-hidden">
      {/* Header — click to toggle */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ToolStatusDot status={status} />
        <span className="font-medium">{name}</span>
        {status === 'streaming' && (
          <span className="text-violet-400/70 text-[10px] animate-pulse">receiving args...</span>
        )}
        {status !== 'streaming' && summary && !open && (
          <span className="truncate text-muted-foreground/50 max-w-[300px]">{summary}</span>
        )}
        {elapsed && (
          <span className="text-muted-foreground/30 tabular-nums text-[10px]">{elapsed}</span>
        )}
        <ChevronDown
          className={cn(
            'size-3 text-muted-foreground/40 transition-transform duration-200',
            !open && '-rotate-90'
          )}
        />
      </button>

      {/* Expanded details */}
      {open && (
        <div className="mt-1.5 space-y-2 pl-5 min-w-0 overflow-hidden">
          {/* Diff view for Edit tools */}
          {(name === 'Edit' || name === 'MultiEdit') && !!input.old_string && !!input.new_string && (
            <DiffBlock
              oldStr={String(input.old_string)}
              newStr={String(input.new_string)}
              filePath={String(input.file_path ?? input.path ?? '')}
            />
          )}
          {/* MultiEdit: show all edits as diffs */}
          {name === 'MultiEdit' && Array.isArray(input.edits) && (
            <div className="space-y-2">
              {(input.edits as Array<Record<string, unknown>>).map((edit, i) => (
                <div key={i}>
                  {(input.edits as unknown[]).length > 1 && (
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="text-[9px] text-muted-foreground/40 font-mono">edit {i + 1}/{(input.edits as unknown[]).length}</span>
                      {typeof edit.explanation === 'string' && <span className="text-[9px] text-muted-foreground/30 truncate">{edit.explanation}</span>}
                    </div>
                  )}
                  {edit.old_string && edit.new_string ? (
                    <DiffBlock oldStr={String(edit.old_string)} newStr={String(edit.new_string)} filePath={String(input.file_path ?? input.path ?? '')} />
                  ) : null}
                </div>
              ))}
            </div>
          )}
          {/* Write: show content with syntax highlighting */}
          {name === 'Write' && !!input.content && (
            <div>
              <div className="mb-1 flex items-center gap-1.5">
                <p className="text-xs font-medium text-muted-foreground">Content</p>
                <span className="text-[9px] text-muted-foreground/40 font-mono">
                  {detectLang(String(input.file_path ?? input.path ?? ''))} · {String(input.content).split('\n').length} lines
                </span>
                <CopyBtn text={String(input.content)} />
              </div>
              <SyntaxHighlighter
                language={detectLang(String(input.file_path ?? input.path ?? ''))}
                style={oneDark}
                wrapLongLines
                customStyle={{
                  margin: 0,
                  padding: '0.5rem',
                  borderRadius: '0.375rem',
                  fontSize: '11px',
                  maxHeight: '200px',
                  overflow: 'auto',
                  fontFamily: MONO_FONT
                }}
                codeTagProps={{ style: { fontFamily: 'inherit' } }}
              >
                {String(input.content)}
              </SyntaxHighlighter>
            </div>
          )}
          {/* TodoWrite: checklist-style input */}
          {name === 'TodoWrite' && Array.isArray(input.todos) && (
            <TodoInputBlock input={input} />
          )}
          {/* Structured Input — tool-specific rendering */}
          {!((name === 'Edit' && !!input.old_string) || (name === 'MultiEdit' && (!!input.old_string || Array.isArray(input.edits))) || (name === 'Write' && !!input.content) || (name === 'TodoWrite' && Array.isArray(input.todos))) && (
            <StructuredInput name={name} input={input} />
          )}
          {/* Output — tool-specific rendering */}
          {output && name === 'Read' && (
            <ReadOutputBlock output={output} filePath={String(input.file_path ?? input.path ?? '')} />
          )}
          {output && name === 'Bash' && (
            <BashOutputBlock command={String(input.command ?? '')} output={output} />
          )}
          {output && name === 'Grep' && (
            <GrepOutputBlock output={output} pattern={String(input.pattern ?? '')} />
          )}
          {output && name === 'Glob' && (
            <GlobOutputBlock output={output} />
          )}
          {output && name === 'LS' && (
            <LSOutputBlock output={output} />
          )}
          {output && (name === 'TodoRead' || name === 'TodoWrite') && (
            <TodoOutputBlock output={output} />
          )}
          {output && ['Edit', 'MultiEdit', 'Write', 'Delete'].includes(name) && (
            <div className="flex items-center gap-1.5 text-xs">
              {output.includes('"success"') || output.includes('success') ? (
                <>
                  <CheckCircle2 className="size-3 text-green-500" />
                  <span className="text-green-500/70">Applied successfully</span>
                </>
              ) : (
                <>
                  <XCircle className="size-3 text-destructive" />
                  <span className="text-destructive/70 font-mono truncate">{output.slice(0, 100)}</span>
                </>
              )}
            </div>
          )}
          {output && !['Read', 'Bash', 'Grep', 'Glob', 'LS', 'TodoWrite', 'TodoRead', 'Edit', 'MultiEdit', 'Write', 'Delete'].includes(name) && (
            <OutputBlock output={output} />
          )}
          {/* Error */}
          {error && (
            <div>
              <p className="mb-1 text-xs font-medium text-destructive">Error</p>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs text-destructive font-mono">{error}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
