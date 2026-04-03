import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useTheme } from 'next-themes'
import { FileCode, FilePlus2, FileX2, FileEdit, Loader2, CheckCircle2, XCircle } from 'lucide-react'
import { PrismAsyncLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { cn } from '@renderer/lib/utils'
import type { ToolCallStatus } from '@renderer/lib/agent/types'
import type { ToolResultContent } from '@renderer/lib/api/types'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import type { AgentRunFileChange } from '@renderer/stores/agent-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { MONO_FONT } from '@renderer/lib/constants'
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
  trackedChange
}: {
  name: string
  input: Record<string, unknown>
  trackedChange?: AgentRunFileChange
}): React.JSX.Element | null {
  const { t } = useTranslation('chat')
  const trackedStats = React.useMemo(() => {
    if (!trackedChange || trackedChange.op === 'create') return null
    return summarizeDiff(
      computeDiff(trackedChange.before.text ?? '', trackedChange.after.text ?? '')
    )
  }, [trackedChange])
  const resolvedEdit = React.useMemo(() => resolveEditPayload(input), [input])
  const resolvedWrite = React.useMemo(() => resolveWritePayload(input), [input])

  if (trackedChange) {
    if (trackedChange.op === 'create') {
      const lines = lineCount(trackedChange.after.text ?? '')
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
    const stats =
      resolvedEdit.oldText || resolvedEdit.newText
        ? summarizeDiff(computeDiff(resolvedEdit.oldText, resolvedEdit.newText))
        : null
    return (
      <span className="flex items-center gap-1 text-[10px]">
        <span className="text-green-400/70">
          +{stats ? stats.added : Math.max(0, resolvedEdit.newChars - resolvedEdit.oldChars)}
        </span>
        <span className="text-red-400/70">
          -{stats ? stats.deleted : Math.max(0, resolvedEdit.oldChars - resolvedEdit.newChars)}
        </span>
      </span>
    )
  }
  if (name === 'Delete') {
    return (
      <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] text-red-400 font-medium">
        {t('fileChange.deleted')}
      </span>
    )
  }
  return null
}

// ── Inline Diff View ─────────────────────────────────────────────

function InlineDiff({ oldStr, newStr }: { oldStr: string; newStr: string }): React.JSX.Element {
  const chunks = React.useMemo(() => foldContext(computeDiff(oldStr, newStr)), [oldStr, newStr])
  return <CodeDiffViewer chunks={chunks} defaultMode="split" toolbarEnd={null} />
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
  const { resolvedTheme } = useTheme()
  const lang = detectLang(filePath)
  const lines = content.split('\n').length
  const truncated = !isStreaming && lines > 50
  const displayed = truncated ? content.split('\n').slice(0, 50).join('\n') : content
  const [expanded, setExpanded] = React.useState(false)
  const codeRef = React.useRef<HTMLDivElement>(null)

  // During streaming, auto-scroll the code block to show latest generated lines
  React.useEffect(() => {
    if (isStreaming && codeRef.current) {
      codeRef.current.scrollTop = codeRef.current.scrollHeight
    }
  }, [isStreaming, content])

  return (
    <div>
      <div
        ref={codeRef}
        style={{
          maxHeight: isStreaming ? '400px' : expanded ? '600px' : '200px',
          overflow: 'auto'
        }}
      >
        <SyntaxHighlighter
          language={lang}
          style={resolvedTheme === 'light' ? oneLight : oneDark}
          customStyle={{
            margin: 0,
            padding: '0.5rem',
            fontSize: '11px',
            background: 'transparent',
            fontFamily: MONO_FONT
          }}
          codeTagProps={{ style: { fontFamily: 'inherit' } }}
          showLineNumbers
          lineNumberStyle={{
            minWidth: '2em',
            paddingRight: '0.5em',
            color: resolvedTheme === 'light' ? 'rgba(15,23,42,0.28)' : 'rgba(74,222,128,0.3)',
            userSelect: 'none'
          }}
          lineProps={() => ({
            style: {
              background:
                resolvedTheme === 'light' ? 'rgba(15,23,42,0.035)' : 'rgba(74,222,128,0.05)'
            }
          })}
        >
          {expanded || isStreaming ? content : displayed}
        </SyntaxHighlighter>
      </div>
      {truncated && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="w-full border-t border-border/50 py-1 text-center text-[10px] text-muted-foreground/70 transition-colors hover:text-foreground dark:border-zinc-800/30 dark:text-zinc-500/60 dark:hover:text-zinc-400"
        >
          {t('fileChange.moreLines', { count: lines - 50 })}
        </button>
      )}
    </div>
  )
}

function PendingEditPreview({ input }: { input: Record<string, unknown> }): React.JSX.Element {
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
  const canDiff = oldStr.length > 0 || newStr.length > 0
  const stats = React.useMemo(
    () => (canDiff ? summarizeDiff(computeDiff(oldStr, newStr)) : null),
    [canDiff, oldStr, newStr]
  )

  return (
    <div className="px-3 py-2 space-y-2 text-[11px] text-muted-foreground/70">
      <div className="flex flex-wrap items-center gap-2">
        {filePath && (
          <span
            className="font-mono text-[10px] text-muted-foreground/50"
            style={{ fontFamily: MONO_FONT }}
          >
            {shortPath(filePath)}
          </span>
        )}
        {hasCounts && (
          <span className="text-[10px] text-muted-foreground/50">
            {stats
              ? `-${stats.deleted} / +${stats.added} lines`
              : `${oldChars} → ${newChars} chars`}
          </span>
        )}
      </div>
      {explanation && <p className="text-[11px] text-muted-foreground/60">{explanation}</p>}
      {showingExcerpt && (
        <p className="text-[10px] text-muted-foreground/45">
          Showing excerpt for long edit payload
        </p>
      )}
      {(oldPreview || newPreview) && (
        <div className="grid gap-2 md:grid-cols-2">
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/45">
              old_string
            </div>
            <pre
              className="overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 px-2.5 py-2 text-[11px] text-foreground/75 dark:bg-zinc-950 dark:text-zinc-300/75"
              style={{ fontFamily: MONO_FONT, maxHeight: '180px' }}
            >
              {oldPreview || '(empty)'}
              {input.old_string_truncated ? '\n…' : ''}
            </pre>
          </div>
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/45">
              new_string
            </div>
            <pre
              className="overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 px-2.5 py-2 text-[11px] text-foreground/75 dark:bg-zinc-950 dark:text-zinc-300/75"
              style={{ fontFamily: MONO_FONT, maxHeight: '180px' }}
            >
              {newPreview || '(empty)'}
              {input.new_string_truncated ? '\n…' : ''}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}

function PendingWritePreview({
  input,
  isStreaming
}: {
  input: Record<string, unknown>
  isStreaming: boolean
}): React.JSX.Element {
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
    <div className="px-3 py-2 space-y-2">
      {(lineTotal !== null || charTotal !== null) && (
        <div className="text-[10px] text-muted-foreground/50">
          {lineTotal !== null ? `${lineTotal} lines` : ''}
          {lineTotal !== null && charTotal !== null ? ' · ' : ''}
          {charTotal !== null ? `${charTotal} chars` : ''}
          {isStreaming ? ' · streaming' : ''}
        </div>
      )}
      {visiblePreview && (
        <pre
          className="overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 px-2.5 py-2 text-[11px] text-foreground/80 dark:bg-zinc-950 dark:text-zinc-300/80"
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

function trackedStatusLabel(change: AgentRunFileChange): string {
  if (change.status === 'accepted') return 'Accepted'
  if (change.status === 'reverted') return 'Reverted'
  if (change.status === 'conflicted') return 'Conflict'
  return 'Pending'
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
  const [collapsed, setCollapsed] = React.useState(false)
  const acceptFileChange = useAgentStore((state) => state.acceptFileChange)
  const rollbackFileChange = useAgentStore((state) => state.rollbackFileChange)
  const [isAcceptingFile, setIsAcceptingFile] = React.useState(false)
  const [isRollingBackFile, setIsRollingBackFile] = React.useState(false)

  // Auto-collapse successful non-Write file actions
  const prevStatusRef = React.useRef(status)
  React.useEffect(() => {
    if (
      name !== 'Write' &&
      prevStatusRef.current !== 'completed' &&
      status === 'completed' &&
      !error
    ) {
      setCollapsed(true)
    }
    prevStatusRef.current = status
  }, [name, status, error])

  const filePath = String(input.file_path ?? input.path ?? '')
  const elapsed =
    startedAt && completedAt ? ((completedAt - startedAt) / 1000).toFixed(1) + 's' : null
  const outputStr = typeof output === 'string' ? output : undefined
  const isFileActionable =
    trackedChange?.status === 'open' || trackedChange?.status === 'conflicted'
  const resolvedEdit = React.useMemo(() => resolveEditPayload(input), [input])
  const resolvedWrite = React.useMemo(() => resolveWritePayload(input), [input])
  const parsedOutput = outputStr ? decodeStructuredToolResult(outputStr) : null
  const isSuccess = !!(
    parsedOutput &&
    !Array.isArray(parsedOutput) &&
    parsedOutput.success === true
  )
  const isOutputError = outputStr
    ? !!(parsedOutput && !Array.isArray(parsedOutput) && typeof parsedOutput.error === 'string') ||
      (!parsedOutput && outputStr.length > 0)
    : false

  // Determine border color based on status
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
        'my-5 rounded-lg border overflow-hidden transition-all duration-200',
        borderColor
      )}
    >
      {/* Header */}
      <button
        onClick={() => setCollapsed((v) => !v)}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/20',
          status === 'running' && 'bg-blue-500/[0.03]'
        )}
      >
        <FileIcon name={name} />
        <span className="text-xs font-medium truncate min-w-0 flex-1" title={filePath || undefined}>
          {filePath ? (
            fileName(filePath)
          ) : (
            <span className="text-muted-foreground/50 italic animate-pulse">
              {t('toolCall.receivingArgs')}
            </span>
          )}
        </span>
        <span
          className="text-[10px] text-muted-foreground/40 font-mono truncate max-w-[120px] hidden sm:block"
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
            {trackedChange.transport === 'ssh' ? 'SSH' : 'Local'} ·{' '}
            {trackedStatusLabel(trackedChange)}
          </span>
        )}
        {elapsed && (
          <span className="text-[9px] text-muted-foreground/30 tabular-nums shrink-0">
            {elapsed}
          </span>
        )}
        <StatusIndicator status={status} />
      </button>

      {/* Body — diff or content */}
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden border-t border-inherit bg-muted/20 dark:bg-zinc-950"
          >
            {/* Edit: delay diff rendering until the tool settles */}
            {name === 'Edit' && trackedChange && (
              <InlineDiff
                oldStr={trackedChange.before.text ?? ''}
                newStr={trackedChange.after.text ?? ''}
              />
            )}
            {name === 'Edit' && !trackedChange && status !== 'completed' && status !== 'error' && (
              <PendingEditPreview input={input} />
            )}
            {name === 'Edit' &&
              !trackedChange &&
              status !== 'streaming' &&
              status !== 'running' &&
              !!(resolvedEdit.oldPreview || resolvedEdit.newPreview) &&
              !(resolvedEdit.oldTruncated || resolvedEdit.newTruncated) && (
                <InlineDiff oldStr={resolvedEdit.oldText} newStr={resolvedEdit.newText} />
              )}
            {name === 'Edit' &&
              !trackedChange &&
              status !== 'streaming' &&
              status !== 'running' &&
              !!(resolvedEdit.oldPreview || resolvedEdit.newPreview) &&
              (resolvedEdit.oldTruncated || resolvedEdit.newTruncated) && (
                <PendingEditPreview input={input} />
              )}

            {/* Write: new file content or overwrite diff */}
            {name === 'Write' && trackedChange?.op === 'modify' && (
              <InlineDiff
                oldStr={trackedChange.before.text ?? ''}
                newStr={trackedChange.after.text ?? ''}
              />
            )}
            {name === 'Write' && trackedChange?.op === 'create' && (
              <NewFileContent
                content={trackedChange.after.text ?? ''}
                filePath={filePath}
                isStreaming={status === 'streaming'}
              />
            )}
            {name === 'Write' &&
              !trackedChange &&
              (status === 'streaming' || status === 'running') && (
                <PendingWritePreview input={input} isStreaming={status === 'streaming'} />
              )}
            {name === 'Write' &&
              !trackedChange &&
              status !== 'streaming' &&
              status !== 'running' &&
              !!resolvedWrite.preview && (
                <NewFileContent
                  content={resolvedWrite.text || resolvedWrite.preview}
                  filePath={filePath}
                  isStreaming={false}
                />
              )}

            {/* Delete: minimal indicator */}
            {name === 'Delete' && (
              <div className="px-3 py-2 text-[11px] text-red-400/60 italic">
                {t('fileChange.fileWillBeDeleted')}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {trackedChange && (
        <div className="border-t border-border/50 bg-background/40 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] text-muted-foreground/70">
              {trackedChange.status === 'accepted'
                ? 'This file is kept.'
                : trackedChange.status === 'reverted'
                  ? 'This file has been restored.'
                  : trackedChange.status === 'conflicted'
                    ? (trackedChange.conflict ?? 'This file has a rollback conflict.')
                    : 'You can keep or revert this file individually.'}
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={handleAcceptFile}
                disabled={!isFileActionable || isAcceptingFile || isRollingBackFile}
              >
                {isAcceptingFile ? <Loader2 className="size-3 animate-spin" /> : null}
                {t('action.allow', { ns: 'common' })}
              </Button>
              <Button
                type="button"
                size="xs"
                variant={trackedChange.status === 'conflicted' ? 'outline' : 'destructive'}
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

      {/* Error / output feedback */}
      {error && (
        <div className="border-t border-destructive/20 px-3 py-1.5 bg-destructive/5">
          <p
            className="text-[11px] text-destructive font-mono whitespace-pre-wrap break-words"
            style={{ fontFamily: MONO_FONT }}
          >
            {error}
          </p>
        </div>
      )}
      {outputStr && !error && isOutputError && !isSuccess && (
        <div className="border-t border-destructive/20 px-3 py-1.5 bg-destructive/5">
          <p
            className="text-[11px] text-destructive/80 font-mono whitespace-pre-wrap break-words"
            style={{ fontFamily: MONO_FONT }}
          >
            {outputStr.length > 500 ? `${outputStr.slice(0, 500)}...` : outputStr}
          </p>
        </div>
      )}
    </div>
  )
}
