import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  FileCode,
  FilePlus2,
  FileX2,
  FileEdit,
  Loader2,
  CheckCircle2,
  XCircle,
  Check,
  Copy,
  ChevronDown,
  ChevronRight
} from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import type { ToolCallStatus } from '@renderer/lib/agent/types'
import type { ToolResultContent } from '@renderer/lib/api/types'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import type { AgentRunFileChange } from '@renderer/stores/agent-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { MONO_FONT } from '@renderer/lib/constants'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { AnimatePresence, motion } from 'motion/react'
import { Button } from '@renderer/components/ui/button'
import { CodeDiffViewer, type DiffViewerChunk, type DiffViewerLine } from './CodeDiffViewer'

// ── Types ────────────────────────────────────────────────────────

interface FileChangeCardProps {
  /** Tool name: Write, Edit, Delete */
  name: string
  input: Record<string, unknown>
  output?: ToolResultContent
  status: ToolCallStatus | 'completed'
  error?: string
  startedAt?: number
  completedAt?: number
  trackedChange?: AgentRunFileChange
}

// ── Helpers ──────────────────────────────────────────────────────

function detectLang(filePath: string): string {
  const ext = filePath.includes('.') ? (filePath.split('.').pop()?.toLowerCase() ?? '') : ''
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    py: 'python',
    rs: 'rust',
    go: 'go',
    json: 'json',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    htm: 'html',
    xml: 'xml',
    svg: 'xml',
    md: 'markdown',
    mdx: 'markdown',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    sql: 'sql',
    graphql: 'graphql',
    gql: 'graphql',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cxx: 'cpp',
    cc: 'cpp',
    hpp: 'cpp',
    java: 'java',
    kt: 'kotlin',
    kts: 'kotlin',
    rb: 'ruby',
    php: 'php',
    swift: 'swift',
    dockerfile: 'docker',
    makefile: 'makefile',
    r: 'r',
    lua: 'lua',
    dart: 'dart',
    ini: 'ini',
    env: 'bash',
    conf: 'ini'
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

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function lineCount(text: string): number {
  const normalized = normalizeLineEndings(text)
  return normalized.length === 0 ? 0 : normalized.split('\n').length
}

function CodeFrame({
  content,
  maxHeight = 320,
  emptyLabel = ' '
}: {
  content: string
  maxHeight?: number
  emptyLabel?: string
}): React.JSX.Element {
  const lines = React.useMemo(() => normalizeLineEndings(content).split('\n'), [content])

  return (
    <div
      className="overflow-auto rounded-lg border border-border/60 bg-background/80 dark:border-zinc-800/80 dark:bg-[#111214]"
      style={{ maxHeight, fontFamily: MONO_FONT }}
    >
      {lines.map((line, index) => (
        <div
          key={`${index}-${line.length}`}
          className="grid grid-cols-[56px_minmax(0,1fr)] border-b border-border/60 text-[11px] leading-5 last:border-b-0 dark:border-zinc-900/80"
        >
          <span className="select-none border-r border-border/60 px-2 py-1 text-right text-muted-foreground dark:border-zinc-800/80 dark:text-zinc-500">
            {index + 1}
          </span>
          <span className="min-w-0 whitespace-pre-wrap break-all px-3 py-1 text-foreground/85 dark:text-zinc-200">
            {line || (index === 0 ? emptyLabel : ' ')}
          </span>
        </div>
      ))}
    </div>
  )
}

function snapshotText(
  snapshot: AgentRunFileChange['before'] | AgentRunFileChange['after']
): string {
  return snapshot.text ?? snapshot.previewText ?? ''
}

function snapshotLineTotal(
  snapshot: AgentRunFileChange['before'] | AgentRunFileChange['after']
): number {
  return typeof snapshot.lineCount === 'number'
    ? snapshot.lineCount
    : lineCount(snapshotText(snapshot))
}

function canRenderInlineSnapshot(
  snapshot: AgentRunFileChange['before'] | AgentRunFileChange['after']
): boolean {
  return typeof snapshot.text === 'string'
}

type DiffLine = DiffViewerLine

function computeLargeDiff(a: string[], b: string[]): DiffLine[] {
  const result: DiffLine[] = []
  const m = a.length
  const n = b.length

  let start = 0
  while (start < m && start < n && a[start] === b[start]) {
    result.push({ type: 'keep', text: a[start], oldNum: start + 1, newNum: start + 1 })
    start += 1
  }

  let endA = m - 1
  let endB = n - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1
    endB -= 1
  }

  for (let index = start; index <= endA; index += 1) {
    result.push({ type: 'del', text: a[index], oldNum: index + 1 })
  }

  for (let index = start; index <= endB; index += 1) {
    result.push({ type: 'add', text: b[index], newNum: index + 1 })
  }

  for (let offset = 1; endA + offset < m && endB + offset < n; offset += 1) {
    result.push({
      type: 'keep',
      text: a[endA + offset],
      oldNum: endA + offset + 1,
      newNum: endB + offset + 1
    })
  }

  return result
}

function computeDiff(oldStr: string, newStr: string): DiffLine[] {
  const a = normalizeLineEndings(oldStr).split('\n')
  const b = normalizeLineEndings(newStr).split('\n')
  const m = a.length,
    n = b.length

  if (m * n > 100000) {
    return computeLargeDiff(a, b)
  }

  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1))
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])

  const result: DiffLine[] = []
  let i = m,
    j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.push({ type: 'keep', text: a[i - 1], oldNum: i, newNum: j })
      i--
      j--
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

function summarizeDiff(lines: DiffLine[]): { added: number; deleted: number } {
  return lines.reduce(
    (acc, line) => {
      if (line.type === 'add') acc.added += 1
      if (line.type === 'del') acc.deleted += 1
      return acc
    },
    { added: 0, deleted: 0 }
  )
}

type DiffChunk = DiffViewerChunk

function foldContext(lines: DiffLine[], ctx: number = 2): DiffChunk[] {
  const chunks: DiffChunk[] = []
  let keepRun: DiffLine[] = []

  const flushKeep = (): void => {
    if (keepRun.length <= ctx * 2 + 1) {
      chunks.push({ type: 'lines', lines: keepRun })
    } else {
      chunks.push({ type: 'lines', lines: keepRun.slice(0, ctx) })
      chunks.push({
        type: 'collapsed',
        count: keepRun.length - ctx * 2,
        lines: keepRun.slice(ctx, -ctx)
      })
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
        ;(chunks[chunks.length - 1] as { type: 'lines'; lines: DiffLine[] }).lines.push(line)
      } else {
        chunks.push({ type: 'lines', lines: [line] })
      }
    }
  }
  if (keepRun.length > 0) flushKeep()
  return chunks
}

function diffDisplayLineNumber(line: DiffLine): number | undefined {
  if (line.type === 'del') return line.oldNum
  return line.newNum ?? line.oldNum
}

function buildDiffCopyText(lines: DiffLine[]): string {
  return lines
    .map((line) => {
      const lineNumber = diffDisplayLineNumber(line)
      const marker = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '
      return `${lineNumber ?? ''}\t${marker}${line.text}`
    })
    .join('\n')
}

function CompactDiffCopyButton({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation(['chat', 'common'])
  const [copied, setCopied] = React.useState(false)

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      }}
      className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
      title={t('action.copy', { ns: 'common' })}
      aria-label={t('action.copy', { ns: 'common' })}
    >
      {copied ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
    </button>
  )
}

function CompactEditDiff({
  oldStr,
  newStr,
  filePath
}: {
  oldStr: string
  newStr: string
  filePath: string
}): React.JSX.Element {
  const { t } = useTranslation('chat')
  const lines = React.useMemo(() => computeDiff(oldStr, newStr), [oldStr, newStr])
  const chunks = React.useMemo(() => foldContext(lines), [lines])
  const stats = React.useMemo(() => summarizeDiff(lines), [lines])
  const copyText = React.useMemo(() => buildDiffCopyText(lines), [lines])
  const [expandedChunks, setExpandedChunks] = React.useState<Set<number>>(new Set())

  React.useEffect(() => {
    setExpandedChunks(new Set())
  }, [filePath, oldStr, newStr])

  const renderLine = (line: DiffLine, key: number): React.JSX.Element => {
    const lineNumber = diffDisplayLineNumber(line)

    return (
      <div
        key={key}
        className={cn(
          'grid grid-cols-[56px_minmax(0,1fr)] border-b border-border/60 text-[11px] leading-5 last:border-b-0 dark:border-zinc-900/80',
          line.type === 'add' && 'bg-emerald-500/10',
          line.type === 'del' && 'bg-red-500/10',
          line.type === 'keep' && 'bg-background dark:bg-[#111214]'
        )}
      >
        <span
          className={cn(
            'select-none border-r border-border/60 px-2 py-1 text-right dark:border-zinc-800/80',
            line.type === 'add' && 'text-emerald-600 dark:text-emerald-300',
            line.type === 'del' && 'text-red-600 dark:text-red-300',
            line.type === 'keep' && 'text-muted-foreground dark:text-zinc-500'
          )}
        >
          {lineNumber ?? ''}
        </span>
        <span
          className={cn(
            'min-w-0 whitespace-pre px-3 py-1',
            line.type === 'add' && 'text-emerald-700 dark:text-emerald-100/90',
            line.type === 'del' && 'text-red-700 dark:text-red-100/90',
            line.type === 'keep' && 'text-foreground/85 dark:text-zinc-200'
          )}
        >
          {line.text || ' '}
        </span>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-background/80 dark:border-white/[0.06] dark:bg-[#111214]">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-muted/30 px-3 py-2 dark:border-white/[0.05] dark:bg-[#141518]">
        <div className="min-w-0 flex items-center gap-2">
          <span
            className="truncate text-[11px] font-medium text-sky-600 dark:text-sky-300"
            title={filePath}
            style={{ fontFamily: MONO_FONT }}
          >
            {fileName(filePath)}
          </span>
          <span className="shrink-0 text-[11px] text-emerald-600 dark:text-emerald-400/90">+{stats.added}</span>
          <span className="shrink-0 text-[11px] text-red-600 dark:text-red-400/90">-{stats.deleted}</span>
        </div>
        <CompactDiffCopyButton text={copyText} />
      </div>
      <div className="max-h-80 overflow-auto" style={{ fontFamily: MONO_FONT }}>
        {chunks.map((chunk, ci) => {
          if (chunk.type === 'lines' || expandedChunks.has(ci)) {
            return chunk.lines.map((line, li) => renderLine(line, ci * 1000 + li))
          }

          return (
            <button
              key={`compact-inline-collapsed-${ci}`}
              type="button"
              className="flex w-full items-center justify-center border-y border-border/60 bg-muted/40 px-3 py-2 text-[10px] text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground dark:border-zinc-800/80 dark:bg-[#15171a]/60 dark:text-zinc-500 dark:hover:bg-[#1a1d21] dark:hover:text-zinc-200"
              onClick={() => setExpandedChunks((prev) => new Set([...prev, ci]))}
            >
              {t('toolCall.unchangedLines', {
                count: chunk.count,
                defaultValue: '··· {{count}} unchanged lines ···'
              })}
            </button>
          )
        })}
      </div>
    </div>
  )
}

interface TrackedDiffContent {
  beforeText: string
  afterText: string
}

// ── Status Icon ──────────────────────────────────────────────────

function StatusIndicator({
  status
}: {
  status: FileChangeCardProps['status']
}): React.JSX.Element | null {
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

function CompactStatusDot({
  status
}: {
  status: FileChangeCardProps['status']
}): React.JSX.Element {
  switch (status) {
    case 'completed':
      return (
        <span className="relative flex size-3.5 shrink-0 items-center justify-center">
          <span className="size-2 rounded-full bg-emerald-400" />
        </span>
      )
    case 'running':
      return (
        <span className="relative flex size-3.5 shrink-0 items-center justify-center">
          <span className="absolute size-2 rounded-full bg-blue-500/30 animate-ping" />
          <span className="size-2 rounded-full bg-blue-500" />
        </span>
      )
    case 'error':
      return (
        <span className="relative flex size-3.5 shrink-0 items-center justify-center">
          <span className="size-2 rounded-full bg-red-400" />
        </span>
      )
    case 'pending_approval':
      return (
        <span className="relative flex size-3.5 shrink-0 items-center justify-center">
          <span className="absolute size-2 rounded-full bg-amber-500/30 animate-ping" />
          <span className="size-2 rounded-full bg-amber-400" />
        </span>
      )
    case 'streaming':
      return (
        <span className="relative flex size-3.5 shrink-0 items-center justify-center">
          <span className="absolute size-2 rounded-full bg-violet-500/30 animate-ping" />
          <span className="size-2 rounded-full bg-violet-400" />
        </span>
      )
    default:
      return (
        <span className="relative flex size-3.5 shrink-0 items-center justify-center">
          <span className="size-2 rounded-full border border-zinc-600" />
        </span>
      )
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
      return <FileEdit className="size-4 text-amber-500" />
    default:
      return <FileCode className="size-4 text-muted-foreground" />
  }
}

// ── Change Stats Badge ───────────────────────────────────────────

function ChangeStats({
  name,
  input,
  trackedChange,
  minimal = false
}: {
  name: string
  input: Record<string, unknown>
  trackedChange?: AgentRunFileChange
  writeOp?: 'create' | 'modify'
  minimal?: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation('chat')
  const trackedStats = React.useMemo(() => {
    if (!trackedChange || trackedChange.op === 'create') return null
    if (
      !canRenderInlineSnapshot(trackedChange.before) ||
      !canRenderInlineSnapshot(trackedChange.after)
    ) {
      return null
    }
    return summarizeDiff(
      computeDiff(snapshotText(trackedChange.before), snapshotText(trackedChange.after))
    )
  }, [trackedChange])
  const resolvedEdit = React.useMemo(() => resolveEditPayload(input), [input])
  const resolvedWrite = React.useMemo(() => resolveWritePayload(input), [input])

  if (trackedChange) {
    if (trackedChange.op === 'create') {
      const lines = snapshotLineTotal(trackedChange.after)
      if (minimal) {
        return (
          <span className="flex items-center gap-1 text-[10px]">
            <span className="text-green-400/70">+{lines}</span>
            <span className="text-red-400/70">-0</span>
          </span>
        )
      }
      return (
        <span className="flex items-center gap-1.5 text-[10px]">
          <span className="rounded bg-green-500/15 px-1.5 py-0.5 text-green-500 font-medium">
            {t('fileChange.new')}
          </span>
          <span className="text-green-400/70">+{lines}</span>
        </span>
      )
    }

    if (!trackedStats) return null
    return (
      <span className="flex items-center gap-1 text-[10px]">
        <span className="text-green-400/70">+{trackedStats.added}</span>
        <span className="text-red-400/70">-{trackedStats.deleted}</span>
      </span>
    )
  }

  if (name === 'Write') {
    if (minimal) {
      return (
        <span className="flex items-center gap-1 text-[10px]">
          <span className="text-green-400/70">+{resolvedWrite.lineTotal}</span>
          <span className="text-red-400/70">-0</span>
        </span>
      )
    }
    return (
      <span className="flex items-center gap-1.5 text-[10px]">
        <span className="rounded bg-green-500/15 px-1.5 py-0.5 text-green-500 font-medium">
          {t('fileChange.new')}
        </span>
        <span className="text-green-400/70">+{resolvedWrite.lineTotal}</span>
      </span>
    )
  }
  if (name === 'Edit') {
    if (!resolvedEdit.oldPreview && !resolvedEdit.newPreview) return null
    return (
      <span className="flex items-center gap-1 text-[10px]">
        <span className="text-muted-foreground/50">
          {t('fileChange.charTransition', {
            from: resolvedEdit.oldChars,
            to: resolvedEdit.newChars
          })}
        </span>
      </span>
    )
  }
  if (name === 'Delete') {
    if (minimal) return null
    return (
      <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] text-red-400 font-medium">
        {t('fileChange.deleted')}
      </span>
    )
  }
  return null
}

// ── Inline Diff View ─────────────────────────────────────────────

function InlineDiff({
  oldStr,
  newStr,
  toolbarEnd = null
}: {
  oldStr: string
  newStr: string
  toolbarEnd?: React.ReactNode
}): React.JSX.Element {
  const chunks = React.useMemo(() => foldContext(computeDiff(oldStr, newStr)), [oldStr, newStr])
  return <CodeDiffViewer chunks={chunks} defaultMode="inline" toolbarEnd={toolbarEnd} />
}

function NewFileContent({
  content,
  filePath,
  isStreaming
}: {
  content: string
  filePath: string
  isStreaming?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('chat')
  const lines = content.split('\n').length
  const truncated = !isStreaming && lines > 50
  const displayed = truncated ? content.split('\n').slice(0, 50).join('\n') : content
  const [expanded, setExpanded] = React.useState(false)

  return (
    <div className="space-y-2 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground dark:text-zinc-500">
        <span
          className="rounded border border-border/60 bg-muted/30 px-1.5 py-0.5 font-mono uppercase dark:border-zinc-800/80 dark:bg-[#16181c]"
          style={{ fontFamily: MONO_FONT }}
        >
          {detectLang(filePath)}
        </span>
        <span>{lines} lines</span>
        {isStreaming ? <span>{t('fileChange.streaming')}</span> : null}
      </div>
      <CodeFrame
        content={expanded || isStreaming ? content : displayed}
        maxHeight={isStreaming ? 400 : 240}
      />
      {truncated && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="w-full text-center text-[10px] text-muted-foreground transition-colors hover:text-foreground dark:text-zinc-500 dark:hover:text-zinc-200"
        >
          {t('fileChange.moreLines', { count: lines - 50 })}
        </button>
      )}
    </div>
  )
}

function SnapshotSummaryNotice({
  before,
  after,
  children
}: {
  before?: AgentRunFileChange['before']
  after: AgentRunFileChange['after']
  children?: React.ReactNode
}): React.JSX.Element {
  const details = [
    typeof before?.lineCount === 'number' ? `before ${before.lineCount} lines` : null,
    typeof after.lineCount === 'number' ? `after ${after.lineCount} lines` : null,
    `${after.size} bytes`,
    after.hash ? `sha ${after.hash.slice(0, 12)}` : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="space-y-3 px-3 py-3 text-[11px] text-muted-foreground dark:text-zinc-400">
      <div className="space-y-1">
        <p>Large file snapshot summarized to avoid storing full before/after text in memory.</p>
        <p className="font-mono text-[10px] text-muted-foreground/70 dark:text-zinc-600" style={{ fontFamily: MONO_FONT }}>
          {details}
        </p>
      </div>
      {children}
      {after.previewText && (
        <pre
          className="overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-background/80 px-2.5 py-2 text-[11px] text-foreground/85 dark:border-zinc-800/80 dark:bg-[#111214] dark:text-zinc-200"
          style={{ fontFamily: MONO_FONT, maxHeight: '180px' }}
        >
          {after.previewText}
          {after.tailPreviewText ? '\n…\n' : ''}
          {after.tailPreviewText ?? ''}
        </pre>
      )}
    </div>
  )
}

function PendingEditPreview({ input }: { input: Record<string, unknown> }): React.JSX.Element {
  const { t } = useTranslation('chat')
  const filePath = String(input.file_path ?? input.path ?? '')
  const explanation = input.explanation ? String(input.explanation) : null
  const oldStr = typeof input.old_string === 'string' ? input.old_string : ''
  const newStr = typeof input.new_string === 'string' ? input.new_string : ''
  const oldPreview =
    typeof input.old_string_preview === 'string' ? input.old_string_preview : oldStr
  const newPreview =
    typeof input.new_string_preview === 'string' ? input.new_string_preview : newStr
  const oldChars =
    typeof input.old_string_chars === 'number' ? input.old_string_chars : oldStr.length
  const newChars =
    typeof input.new_string_chars === 'number' ? input.new_string_chars : newStr.length
  const showingExcerpt = Boolean(input.old_string_truncated || input.new_string_truncated)
  const hasCounts = oldChars > 0 || newChars > 0

  return (
    <div className="space-y-2 px-3 py-3 text-[11px] text-foreground/85 dark:text-zinc-300">
      <div className="flex flex-wrap items-center gap-2">
        {filePath && (
          <span className="font-mono text-[10px] text-muted-foreground dark:text-zinc-500" style={{ fontFamily: MONO_FONT }}>
            {shortPath(filePath)}
          </span>
        )}
        {hasCounts && (
          <span className="text-[10px] text-muted-foreground dark:text-zinc-500">
            {t('fileChange.charTransition', { from: oldChars, to: newChars })}
          </span>
        )}
      </div>
      {explanation && <p className="text-[11px] text-muted-foreground dark:text-zinc-400">{explanation}</p>}
      {showingExcerpt && (
        <p className="text-[10px] text-muted-foreground/70 dark:text-zinc-600">{t('fileChange.showingExcerpt')}</p>
      )}
      {(oldPreview || newPreview) && (
        <div className="grid gap-2 md:grid-cols-2">
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70 dark:text-zinc-600">
              {t('fileChange.oldString')}
            </div>
            <pre
              className="overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-background/80 px-2.5 py-2 text-[11px] text-foreground/85 dark:border-zinc-800/80 dark:bg-[#111214] dark:text-zinc-200"
              style={{ fontFamily: MONO_FONT, maxHeight: '180px' }}
            >
              {oldPreview || t('fileChange.empty')}
              {input.old_string_truncated ? '\n…' : ''}
            </pre>
          </div>
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70 dark:text-zinc-600">
              {t('fileChange.newString')}
            </div>
            <pre
              className="overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-background/80 px-2.5 py-2 text-[11px] text-foreground/85 dark:border-zinc-800/80 dark:bg-[#111214] dark:text-zinc-200"
              style={{ fontFamily: MONO_FONT, maxHeight: '180px' }}
            >
              {newPreview || t('fileChange.empty')}
              {input.new_string_truncated ? '\n…' : ''}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}

function TrackedEditDiff({
  change,
  filePath
}: {
  change: AgentRunFileChange
  filePath: string
}): React.JSX.Element {
  const { t } = useTranslation('chat')
  const [content, setContent] = React.useState<TrackedDiffContent | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)

  const canRenderInline =
    canRenderInlineSnapshot(change.before) && canRenderInlineSnapshot(change.after)

  React.useEffect(() => {
    if (canRenderInline) {
      setContent({
        beforeText: snapshotText(change.before),
        afterText: snapshotText(change.after)
      })
      setIsLoading(false)
      setLoadError(null)
      return
    }

    let cancelled = false
    const load = async (): Promise<void> => {
      setIsLoading(true)
      setLoadError(null)
      try {
        const result = await ipcClient.invoke(IPC.AGENT_CHANGES_DIFF_CONTENT, {
          runId: change.runId,
          changeId: change.id
        })
        if (cancelled) return
        if (
          result &&
          typeof result === 'object' &&
          'beforeText' in result &&
          'afterText' in result &&
          typeof result.beforeText === 'string' &&
          typeof result.afterText === 'string'
        ) {
          setContent({ beforeText: result.beforeText, afterText: result.afterText })
          return
        }
        if (
          result &&
          typeof result === 'object' &&
          'error' in result &&
          typeof result.error === 'string'
        ) {
          setLoadError(result.error)
          return
        }
        setLoadError('Failed to load full diff')
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [canRenderInline, change])

  if (isLoading && !content) {
    return (
      <SnapshotSummaryNotice before={change.before} after={change.after}>
        <div className="flex items-center gap-2">
          <Loader2 className="size-3.5 animate-spin" />
          <span>{t('thinking.thinkingEllipsis')}</span>
        </div>
      </SnapshotSummaryNotice>
    )
  }

  if (loadError && !content) {
    return (
      <SnapshotSummaryNotice before={change.before} after={change.after}>
        <div className="text-destructive/80">{loadError}</div>
      </SnapshotSummaryNotice>
    )
  }

  if (!content) {
    return <SnapshotSummaryNotice before={change.before} after={change.after} />
  }

  return (
    <CompactEditDiff oldStr={content.beforeText} newStr={content.afterText} filePath={filePath} />
  )
}

function PendingWritePreview({
  input,
  isStreaming
}: {
  input: Record<string, unknown>
  isStreaming: boolean
}): React.JSX.Element {
  const { t } = useTranslation('chat')
  const content = typeof input.content === 'string' ? input.content : null
  const preview = typeof input.content_preview === 'string' ? input.content_preview : null
  const lineTotal =
    typeof input.content_lines === 'number'
      ? input.content_lines
      : content !== null
        ? lineCount(content)
        : null
  const charTotal =
    typeof input.content_chars === 'number'
      ? input.content_chars
      : content !== null
        ? content.length
        : null
  const visiblePreview = content ?? preview

  return (
    <div className="px-3 py-3 space-y-2">
      {(lineTotal !== null || charTotal !== null) && (
        <div className="text-[10px] text-zinc-500">
          {[
            lineTotal !== null ? t('fileChange.lineCount', { count: lineTotal }) : null,
            charTotal !== null ? t('fileChange.charCount', { count: charTotal }) : null,
            isStreaming ? t('fileChange.streaming') : null
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      )}
      {visiblePreview && (
        <pre
          className="overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-background/80 px-2.5 py-2 text-[11px] text-foreground/85 dark:border-zinc-800/80 dark:bg-[#111214] dark:text-zinc-200"
          style={{ fontFamily: MONO_FONT, maxHeight: isStreaming ? '240px' : '180px' }}
        >
          {visiblePreview}
          {input.content_truncated ? '\n…' : ''}
        </pre>
      )}
    </div>
  )
}

interface ResolvedEditPayload {
  oldText: string
  newText: string
  oldPreview: string
  newPreview: string
  oldChars: number
  newChars: number
  oldTruncated: boolean
  newTruncated: boolean
}

interface ResolvedWritePayload {
  text: string
  preview: string
  lineTotal: number
}

function resolveEditPayload(input: Record<string, unknown>): ResolvedEditPayload {
  const oldText = typeof input.old_string === 'string' ? input.old_string : ''
  const newText = typeof input.new_string === 'string' ? input.new_string : ''
  const oldPreview =
    typeof input.old_string_preview === 'string' ? input.old_string_preview : oldText
  const newPreview =
    typeof input.new_string_preview === 'string' ? input.new_string_preview : newText
  const oldChars =
    typeof input.old_string_chars === 'number' ? input.old_string_chars : oldText.length
  const newChars =
    typeof input.new_string_chars === 'number' ? input.new_string_chars : newText.length
  const oldTruncated = Boolean(input.old_string_truncated)
  const newTruncated = Boolean(input.new_string_truncated)

  return {
    oldText,
    newText,
    oldPreview,
    newPreview,
    oldChars,
    newChars,
    oldTruncated,
    newTruncated
  }
}

function resolveWritePayload(input: Record<string, unknown>): ResolvedWritePayload {
  const text = typeof input.content === 'string' ? input.content : ''
  const preview = typeof input.content_preview === 'string' ? input.content_preview : text
  const lineTotal =
    typeof input.content_lines === 'number'
      ? input.content_lines
      : text
        ? lineCount(text)
        : preview
          ? lineCount(preview)
          : 0

  return { text, preview, lineTotal }
}

function hasPendingEditPreviewContent(input: Record<string, unknown>): boolean {
  const filePath = String(input.file_path ?? input.path ?? '').trim()
  const explanation = typeof input.explanation === 'string' ? input.explanation.trim() : ''
  const oldStr = typeof input.old_string === 'string' ? input.old_string : ''
  const newStr = typeof input.new_string === 'string' ? input.new_string : ''
  const oldPreview =
    typeof input.old_string_preview === 'string' ? input.old_string_preview : oldStr
  const newPreview =
    typeof input.new_string_preview === 'string' ? input.new_string_preview : newStr
  const oldChars =
    typeof input.old_string_chars === 'number' ? input.old_string_chars : oldStr.length
  const newChars =
    typeof input.new_string_chars === 'number' ? input.new_string_chars : newStr.length

  return Boolean(
    filePath ||
    explanation ||
    oldPreview ||
    newPreview ||
    oldChars > 0 ||
    newChars > 0 ||
    input.old_string_truncated ||
    input.new_string_truncated
  )
}

function resolveEditSummaryDiff(
  payload: ResolvedEditPayload,
  trackedChange?: AgentRunFileChange
): { added: number; deleted: number; oldStr: string; newStr: string } | null {
  if (
    trackedChange &&
    canRenderInlineSnapshot(trackedChange.before) &&
    canRenderInlineSnapshot(trackedChange.after)
  ) {
    const oldStr = snapshotText(trackedChange.before)
    const newStr = snapshotText(trackedChange.after)
    return {
      ...summarizeDiff(computeDiff(oldStr, newStr)),
      oldStr,
      newStr
    }
  }

  if (payload.oldTruncated || payload.newTruncated) return null

  const oldStr = payload.oldText || payload.oldPreview
  const newStr = payload.newText || payload.newPreview

  if (!oldStr && !newStr) return null

  return {
    ...summarizeDiff(computeDiff(oldStr, newStr)),
    oldStr,
    newStr
  }
}

function trackedStatusLabelKey(change: AgentRunFileChange): string {
  if (change.status === 'accepted') return 'fileChange.status.accepted'
  if (change.status === 'reverted') return 'fileChange.status.reverted'
  if (change.status === 'conflicted') return 'fileChange.status.conflict'
  return 'fileChange.status.pending'
}

function trackedTransportLabelKey(change: AgentRunFileChange): string {
  return change.transport === 'ssh' ? 'fileChange.transport.ssh' : 'fileChange.transport.local'
}

function trackedStatusTone(change: AgentRunFileChange): string {
  if (change.status === 'accepted')
    return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-500'
  if (change.status === 'reverted')
    return 'bg-muted text-foreground/70 dark:bg-zinc-500/10 dark:text-zinc-300'
  if (change.status === 'conflicted') return 'bg-amber-500/10 text-amber-600 dark:text-amber-500'
  return change.transport === 'ssh'
    ? 'bg-sky-500/10 text-sky-600 dark:text-sky-400'
    : 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
}

function trackedStatusDotTone(change: AgentRunFileChange): string {
  if (change.status === 'accepted') return 'bg-emerald-400'
  if (change.status === 'reverted') return 'bg-zinc-500'
  if (change.status === 'conflicted') return 'bg-amber-400'
  return change.transport === 'ssh' ? 'bg-sky-400' : 'bg-zinc-400'
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
  trackedChange
}: FileChangeCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const resolvedEdit = React.useMemo(() => resolveEditPayload(input), [input])
  const resolvedWrite = React.useMemo(() => resolveWritePayload(input), [input])
  const isActive = status === 'streaming' || status === 'running' || status === 'pending_approval'
  const [collapsed, setCollapsed] = React.useState(!isActive)
  const acceptFileChange = useAgentStore((state) => state.acceptFileChange)
  const rollbackFileChange = useAgentStore((state) => state.rollbackFileChange)
  const [isAcceptingFile, setIsAcceptingFile] = React.useState(false)
  const [isRollingBackFile, setIsRollingBackFile] = React.useState(false)

  const filePath = String(input.file_path ?? input.path ?? '')
  const elapsed =
    startedAt && completedAt ? ((completedAt - startedAt) / 1000).toFixed(1) + 's' : null
  const outputStr = typeof output === 'string' ? output : undefined
  const isFileActionable =
    trackedChange?.status === 'open' || trackedChange?.status === 'conflicted'
  const parsedOutput = outputStr ? decodeStructuredToolResult(outputStr) : null
  const parsedOutputError =
    parsedOutput && !Array.isArray(parsedOutput) && typeof parsedOutput.error === 'string'
      ? parsedOutput.error.trim()
      : null
  const isSuccess = !!(
    parsedOutput &&
    !Array.isArray(parsedOutput) &&
    parsedOutput.success === true
  )
  const writeOp =
    trackedChange?.op ??
    (parsedOutput &&
    !Array.isArray(parsedOutput) &&
    (parsedOutput.op === 'create' || parsedOutput.op === 'modify')
      ? (parsedOutput.op as 'create' | 'modify')
      : undefined)
  const compactActionOp: 'create' | 'modify' | 'delete' =
    name === 'Delete'
      ? 'delete'
      : (trackedChange?.op ?? (name === 'Write' ? (writeOp ?? 'create') : 'modify'))
  const isOutputError = outputStr
    ? Boolean(parsedOutputError) || (!parsedOutput && outputStr.length > 0)
    : false
  const hasCompactError = status === 'error' || (isOutputError && !isSuccess)
  const compactEditDiff = React.useMemo(
    () => resolveEditSummaryDiff(resolvedEdit, trackedChange),
    [resolvedEdit, trackedChange]
  )
  const useCompactChangeLayout =
    name === 'Edit' || name === 'Delete' || (name === 'Write' && !isActive)
  const canRenderTrackedWriteDiff =
    !!trackedChange &&
    trackedChange.op === 'modify' &&
    canRenderInlineSnapshot(trackedChange.before) &&
    canRenderInlineSnapshot(trackedChange.after)
  const showTrackedEditDiff = name === 'Edit' && !!trackedChange
  const showPendingEditPreview =
    name === 'Edit' &&
    !trackedChange &&
    status !== 'completed' &&
    status !== 'error' &&
    hasPendingEditPreviewContent(input)
  const showSettledCompactEditDiff =
    name === 'Edit' &&
    !trackedChange &&
    status !== 'streaming' &&
    status !== 'running' &&
    !!compactEditDiff
  const showTrackedWriteInlineDiff = name === 'Write' && canRenderTrackedWriteDiff
  const showTrackedWriteSnapshotSummary =
    name === 'Write' &&
    !!trackedChange &&
    trackedChange.op === 'modify' &&
    !canRenderTrackedWriteDiff
  const showTrackedWriteNewFile =
    name === 'Write' &&
    !!trackedChange &&
    trackedChange.op === 'create' &&
    canRenderInlineSnapshot(trackedChange.after)
  const showTrackedWriteNewFileSummary =
    name === 'Write' &&
    !!trackedChange &&
    trackedChange.op === 'create' &&
    !canRenderInlineSnapshot(trackedChange.after)
  const showPendingWriteStreaming =
    name === 'Write' && !trackedChange && (status === 'streaming' || status === 'running')
  const showSettledWriteModifyPreview =
    name === 'Write' &&
    !trackedChange &&
    status !== 'streaming' &&
    status !== 'running' &&
    writeOp === 'modify'
  const showSettledWriteNewFile =
    name === 'Write' &&
    !trackedChange &&
    status !== 'streaming' &&
    status !== 'running' &&
    writeOp !== 'modify' &&
    !!resolvedWrite.preview
  const showDeleteNotice = name === 'Delete'
  const hasExpandedContent =
    showTrackedEditDiff ||
    showPendingEditPreview ||
    showSettledCompactEditDiff ||
    showTrackedWriteInlineDiff ||
    showTrackedWriteSnapshotSummary ||
    showTrackedWriteNewFile ||
    showTrackedWriteNewFileSummary ||
    showPendingWriteStreaming ||
    showSettledWriteModifyPreview ||
    showSettledWriteNewFile ||
    showDeleteNotice

  const borderColor =
    status === 'streaming'
      ? 'border-violet-500/30'
      : status === 'running'
        ? 'border-blue-500/30'
        : status === 'error' || (isOutputError && !isSuccess)
          ? 'border-destructive/30'
          : trackedChange?.status === 'conflicted'
            ? 'border-amber-500/30'
            : trackedChange?.status === 'accepted'
              ? 'border-emerald-500/20'
              : name === 'Write'
                ? 'border-green-500/20'
                : name === 'Delete'
                  ? 'border-red-500/20'
                  : 'border-amber-500/20'

  const handleAcceptFile = async (): Promise<void> => {
    if (!trackedChange || !isFileActionable) return
    setIsAcceptingFile(true)
    try {
      await acceptFileChange(trackedChange.runId, trackedChange.id)
    } finally {
      setIsAcceptingFile(false)
    }
  }

  const handleRollbackFile = async (): Promise<void> => {
    if (!trackedChange || !isFileActionable) return
    setIsRollingBackFile(true)
    try {
      await rollbackFileChange(trackedChange.runId, trackedChange.id)
    } finally {
      setIsRollingBackFile(false)
    }
  }

  return (
    <div
      className={cn(
        useCompactChangeLayout
          ? 'my-0 overflow-hidden bg-transparent text-zinc-100 transition-all duration-200'
          : 'activity-card-shell my-3 overflow-hidden rounded-[18px] text-zinc-100 transition-all duration-200',
        borderColor
      )}
    >
      <button
        onClick={() => {
          setCollapsed((v) => !v)
        }}
        className={cn(
          useCompactChangeLayout
            ? 'group w-full px-1.5 py-0.5 text-left'
            : 'activity-card-header activity-card-header--interactive flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors',
          status === 'running' && 'bg-blue-500/[0.05]'
        )}
      >
        {useCompactChangeLayout ? (
          <div
            className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-zinc-400 transition-colors group-hover:bg-white/[0.015] group-hover:text-zinc-100"
            title={filePath || undefined}
          >
            <span className="shrink-0 text-[10px] font-medium text-zinc-400">
              {compactActionOp === 'create'
                ? t('fileChange.created')
                : compactActionOp === 'delete'
                  ? t('fileChange.deleted')
                  : t('fileChange.edited')}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-sky-300 transition-colors group-hover:text-sky-200">
              {filePath ? (
                fileName(filePath)
              ) : (
                <span className="text-zinc-500 italic animate-pulse">
                  {t('toolCall.receivingArgs')}
                </span>
              )}
            </span>
            {compactEditDiff ? (
              <>
                <span className="shrink-0 text-[10px] font-medium text-emerald-400/90">
                  +{compactEditDiff.added}
                </span>
                <span className="shrink-0 text-[10px] font-medium text-red-400/90">
                  -{compactEditDiff.deleted}
                </span>
              </>
            ) : (
              <ChangeStats name={name} input={input} trackedChange={trackedChange} minimal />
            )}
            {hasCompactError ? (
              <span
                className="size-1.5 shrink-0 rounded-full bg-red-400"
                title={error || parsedOutputError || t('error.label', { ns: 'common' })}
              />
            ) : trackedChange ? (
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  trackedStatusDotTone(trackedChange)
                )}
                title={`${t(trackedTransportLabelKey(trackedChange))} / ${t(trackedStatusLabelKey(trackedChange))}`}
              />
            ) : (
              <CompactStatusDot status={status} />
            )}
            {elapsed && (
              <span className="shrink-0 text-[9px] tabular-nums text-zinc-600">{elapsed}</span>
            )}
            {collapsed ? (
              <ChevronRight className="size-3 shrink-0 text-zinc-600" />
            ) : (
              <ChevronDown className="size-3 shrink-0 text-zinc-600" />
            )}
          </div>
        ) : (
          <>
            <FileIcon name={name} />
            <span
              className="text-xs font-medium truncate min-w-0 flex-1"
              title={filePath || undefined}
            >
              {filePath ? (
                fileName(filePath)
              ) : (
                <span className="text-zinc-500 italic animate-pulse">
                  {t('toolCall.receivingArgs')}
                </span>
              )}
            </span>
            <span
              className="text-[10px] text-zinc-500 font-mono truncate max-w-[180px] hidden sm:block"
              title={filePath}
            >
              {shortPath(filePath)}
            </span>
            <ChangeStats name={name} input={input} trackedChange={trackedChange} />
            {trackedChange && (
              <span
                className={cn(
                  'rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                  trackedStatusTone(trackedChange)
                )}
              >
                {t(trackedTransportLabelKey(trackedChange))} ·{' '}
                {t(trackedStatusLabelKey(trackedChange))}
              </span>
            )}
            {elapsed && (
              <span className="text-[9px] text-zinc-600 tabular-nums shrink-0">{elapsed}</span>
            )}
            <StatusIndicator status={status} />
          </>
        )}
      </button>

      <AnimatePresence initial={false}>
        {!collapsed && hasExpandedContent && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className={cn(
              'overflow-hidden',
              useCompactChangeLayout
                ? 'bg-transparent px-0 pb-3 pt-0.5'
                : 'activity-card-divider border-t bg-[#0f1012]'
            )}
          >
            {showTrackedEditDiff && trackedChange && (
              <TrackedEditDiff change={trackedChange} filePath={filePath} />
            )}
            {showPendingEditPreview && <PendingEditPreview input={input} />}
            {showSettledCompactEditDiff && compactEditDiff && (
              <CompactEditDiff
                oldStr={compactEditDiff.oldStr}
                newStr={compactEditDiff.newStr}
                filePath={filePath}
              />
            )}
            {showTrackedWriteInlineDiff && trackedChange && (
              <InlineDiff
                oldStr={snapshotText(trackedChange.before)}
                newStr={snapshotText(trackedChange.after)}
              />
            )}
            {showTrackedWriteSnapshotSummary && trackedChange && (
              <SnapshotSummaryNotice before={trackedChange.before} after={trackedChange.after} />
            )}
            {showTrackedWriteNewFile && trackedChange && (
              <NewFileContent
                content={snapshotText(trackedChange.after)}
                filePath={filePath}
                isStreaming={status === 'streaming'}
              />
            )}
            {showTrackedWriteNewFileSummary && trackedChange && (
              <SnapshotSummaryNotice after={trackedChange.after} />
            )}
            {showPendingWriteStreaming && (
              <PendingWritePreview input={input} isStreaming={status === 'streaming'} />
            )}
            {showSettledWriteModifyPreview && (
              <PendingWritePreview input={input} isStreaming={false} />
            )}
            {showSettledWriteNewFile && (
              <NewFileContent
                content={resolvedWrite.text || resolvedWrite.preview}
                filePath={filePath}
                isStreaming={false}
              />
            )}

            {showDeleteNotice && (
              <div className="px-3 py-3 text-[11px] text-red-300/80 italic">
                {t('fileChange.fileWillBeDeleted')}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {trackedChange && !collapsed && (
        <div
          className={cn(
            useCompactChangeLayout
              ? 'bg-transparent px-3 py-2'
              : 'activity-card-divider border-t bg-[#15171a] px-3 py-2'
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] text-zinc-500">
              {trackedChange.status === 'accepted'
                ? t('fileChange.kept')
                : trackedChange.status === 'reverted'
                  ? t('fileChange.restored')
                  : trackedChange.status === 'conflicted'
                    ? (trackedChange.conflict ?? t('fileChange.rollbackConflictDefault'))
                    : t('fileChange.individualActions')}
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="xs"
                variant={useCompactChangeLayout ? 'ghost' : 'outline'}
                className={
                  useCompactChangeLayout ? 'text-emerald-300 hover:bg-white/[0.04]' : undefined
                }
                onClick={handleAcceptFile}
                disabled={!isFileActionable || isAcceptingFile || isRollingBackFile}
              >
                {isAcceptingFile ? <Loader2 className="size-3 animate-spin" /> : null}
                {t('action.allow', { ns: 'common' })}
              </Button>
              <Button
                type="button"
                size="xs"
                variant={
                  useCompactChangeLayout
                    ? 'ghost'
                    : trackedChange.status === 'conflicted'
                      ? 'outline'
                      : 'destructive'
                }
                className={
                  useCompactChangeLayout
                    ? cn(
                        'hover:bg-white/[0.04]',
                        trackedChange.status === 'conflicted' ? 'text-amber-300' : 'text-zinc-200'
                      )
                    : undefined
                }
                onClick={handleRollbackFile}
                disabled={!isFileActionable || isAcceptingFile || isRollingBackFile}
              >
                {isRollingBackFile ? <Loader2 className="size-3 animate-spin" /> : null}
                {t('action.undo', { ns: 'common' })}
              </Button>
            </div>
          </div>
        </div>
      )}

      {(error || (parsedOutputError && !error)) && (
        <div
          className={cn(
            useCompactChangeLayout
              ? 'px-3 py-2'
              : 'border-t border-destructive/20 bg-destructive/8 px-3 py-2'
          )}
        >
          <p
            className={cn(
              'font-mono whitespace-pre-wrap break-words text-[11px] text-destructive',
              useCompactChangeLayout && 'text-red-300/90'
            )}
            style={{ fontFamily: MONO_FONT }}
          >
            {error || parsedOutputError}
          </p>
        </div>
      )}
      {outputStr && !error && !parsedOutputError && isOutputError && !isSuccess && (
        <div
          className={cn(
            useCompactChangeLayout
              ? 'px-3 py-2'
              : 'border-t border-destructive/20 bg-destructive/8 px-3 py-2'
          )}
        >
          <p
            className={cn(
              'font-mono whitespace-pre-wrap break-words text-[11px] text-destructive/80',
              useCompactChangeLayout && 'text-red-300/80'
            )}
            style={{ fontFamily: MONO_FONT }}
          >
            {outputStr.length > 500 ? `${outputStr.slice(0, 500)}...` : outputStr}
          </p>
        </div>
      )}
    </div>
  )
}
