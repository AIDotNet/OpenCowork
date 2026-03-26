import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  CheckCircle2,
  XCircle,
  Copy,
  Check,
  Terminal,
  SendHorizontal,
  Square,
  FileCode,
  Search,
  FolderTree,
  Folder,
  File,
  ListChecks,
  Circle,
  CircleDot,
  Clock,
  Bot
} from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import type { ToolCallStatus } from '@renderer/lib/agent/types'
import type { ToolResultContent } from '@renderer/lib/api/types'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import { MONO_FONT } from '@renderer/lib/constants'
import { estimateTokens, formatTokens } from '@renderer/lib/format-tokens'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { LazySyntaxHighlighter } from './LazySyntaxHighlighter'
import { inputSummary } from './tool-call-summary'

interface ToolCallCardProps {
  toolUseId?: string
  name: string
  input: Record<string, unknown>
  output?: ToolResultContent
  status: ToolCallStatus | 'completed'
  error?: string
  startedAt?: number
  completedAt?: number
}

/** Extract string representation from ToolResultContent for backward-compat rendering */
function outputAsString(output: ToolResultContent | undefined): string | undefined {
  if (output === undefined) return undefined
  if (typeof output === 'string') return output
  const texts = output
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
  return texts.join('\n') || undefined
}

/** Check if output contains image blocks */
function hasImageBlocks(output: ToolResultContent | undefined): boolean {
  return Array.isArray(output) && output.some((b) => b.type === 'image')
}

function CopyBtn({ text, title }: { text: string; title?: string }): React.JSX.Element {
  const [copied, setCopied] = React.useState(false)
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
      className="ml-auto rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors"
      title={title ?? 'Copy'}
    >
      {copied ? <Check className="size-3 text-green-500" /> : <Copy className="size-3" />}
    </button>
  )
}

function ImageOutputBlock({ output }: { output: ToolResultContent }): React.JSX.Element | null {
  const { t } = useTranslation('chat')
  if (!Array.isArray(output)) return null
  const images = output.filter((b) => b.type === 'image')
  if (images.length === 0) return null
  return (
    <div className="space-y-2">
      {images.map((img, i) => {
        if (img.type !== 'image') return null
        const src =
          img.source.url || `data:${img.source.mediaType || 'image/png'};base64,${img.source.data}`
        return (
          <div key={i}>
            <div className="mb-1 flex items-center gap-1.5">
              <p className="text-xs font-medium text-muted-foreground">{t('toolCall.image')}</p>
              <span className="text-[9px] text-muted-foreground/40">{img.source.mediaType}</span>
            </div>
            <img
              src={src}
              alt="Tool output"
              className="max-h-72 max-w-full rounded-md border object-contain bg-muted/30 dark:bg-zinc-950"
            />
          </div>
        )
      })}
    </div>
  )
}

function OutputBlock({ output }: { output: string }): React.JSX.Element {
  const { t } = useTranslation('chat')
  const [expanded, setExpanded] = React.useState(false)
  const isLong = output.length > 500
  const displayed = isLong && !expanded ? output.slice(0, 500) + '…' : output
  return (
    <div>
      <div className="mb-1 flex items-center">
        <p className="text-xs font-medium text-muted-foreground">{t('toolCall.output')}</p>
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
          {expanded
            ? t('action.showLess', { ns: 'common' })
            : t('toolCall.showAll', { chars: output.length, lines: output.split('\n').length })}
        </button>
      )}
    </div>
  )
}

function ReadOutputBlock({
  output,
  filePath
}: {
  output: string
  filePath: string
}): React.JSX.Element {
  const { t } = useTranslation('chat')
  const [expanded, setExpanded] = React.useState(false)
  // Detect line-number prefixed content (e.g. "1\tcode") from fs:read-file with offset/limit
  const hasLineNums = /^\d+\t/.test(output)
  const rawContent = hasLineNums
    ? output
        .split('\n')
        .map((l) => l.replace(/^\d+\t/, ''))
        .join('\n')
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
          title={t('toolCall.clickToInsert', { path: filePath })}
          onClick={() => {
            const short = filePath.split(/[\\/]/).slice(-2).join('/')
            import('@renderer/stores/ui-store').then(({ useUIStore }) =>
              useUIStore.getState().setPendingInsertText(short)
            )
          }}
        >
          {filePath.split(/[\\/]/).slice(-2).join('/')}
        </span>
        <span className="text-[9px] text-muted-foreground/40 font-mono">
          {lang} · {lines.length} lines
        </span>
        <CopyBtn text={rawContent} />
      </div>
      <LazySyntaxHighlighter
        language={lang}
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
      </LazySyntaxHighlighter>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded
            ? t('toolCall.showFirst40')
            : t('toolCall.showAllLines', { count: lines.length })}
        </button>
      )}
    </div>
  )
}

interface ShellOutputSummary {
  live?: boolean
  mode?: 'full' | 'compact' | 'tail'
  noisy?: boolean
  totalChars?: number
  totalLines?: number
  stdoutLines?: number
  stderrLines?: number
  errorLikeLines?: number
  warningLikeLines?: number
}

function ShellTextPane({
  title,
  text,
  expanded,
  tone = 'default'
}: {
  title: string
  text: string
  expanded: boolean
  tone?: 'default' | 'error'
}): React.JSX.Element | null {
  if (!text) return null
  const isLong = text.length > 1000
  const displayed = isLong && !expanded ? `...\n${text.slice(-1000)}` : text
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/50">
        <span
          className={cn(
            'inline-flex rounded px-1 py-0.5',
            tone === 'error'
              ? 'bg-red-500/10 text-red-700/85 dark:text-red-300/80'
              : 'bg-muted text-foreground/70 dark:bg-zinc-800/70 dark:text-zinc-300/70'
          )}
        >
          {title}
        </span>
        <span>{text.split('\n').length} lines</span>
      </div>
      <pre
        className={cn(
          'whitespace-pre-wrap break-words text-[11px]',
          tone === 'error'
            ? 'text-red-700/85 dark:text-red-200/85'
            : 'text-foreground/80 dark:text-zinc-300/80'
        )}
      >
        {displayed}
      </pre>
    </div>
  )
}

function BashOutputBlock({
  output,
  toolUseId,
  status
}: {
  output: string
  toolUseId?: string
  status: ToolCallStatus | 'completed'
}): React.JSX.Element {
  const { t } = useTranslation('chat')
  const [expanded, setExpanded] = React.useState(false)
  const [terminalInput, setTerminalInput] = React.useState('')
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const openDetailPanel = useUIStore((s) => s.openDetailPanel)
  const sendBackgroundProcessInput = useAgentStore((s) => s.sendBackgroundProcessInput)
  const stopBackgroundProcess = useAgentStore((s) => s.stopBackgroundProcess)
  const abortForegroundShellExec = useAgentStore((s) => s.abortForegroundShellExec)
  const hasForegroundExec = useAgentStore((s) =>
    toolUseId ? Boolean(s.foregroundShellExecByToolUseId[toolUseId]) : false
  )

  // Try to parse JSON output from shell tool (may contain stdout, stderr, exitCode, processId)
  const parsed = React.useMemo(() => {
    const obj = decodeStructuredToolResult(output)
    if (
      obj &&
      !Array.isArray(obj) &&
      ('stdout' in obj || 'output' in obj || 'exitCode' in obj || 'processId' in obj)
    ) {
      return obj as {
        stdout?: string
        stderr?: string
        exitCode?: number
        output?: string
        processId?: string
        summary?: ShellOutputSummary
      }
    }
    return null
  }, [output])

  const processId = parsed?.processId ? String(parsed.processId) : null
  const process = useAgentStore((s) => (processId ? s.backgroundProcesses[processId] : undefined))

  const summary = parsed?.summary ?? null
  const stdoutText = process ? process.output : (parsed?.stdout ?? parsed?.output ?? '')
  const stderrText = process ? '' : (parsed?.stderr ?? '')
  const hasStructuredStreams = !process && !!parsed && (Boolean(stdoutText) || Boolean(stderrText))
  const text = process ? process.output : [stderrText, stdoutText].filter(Boolean).join('\n\n')
  const exitCode = process?.exitCode ?? parsed?.exitCode
  const isProcessRunning = process?.status === 'running'
  const statusText = process ? t(`toolCall.processStatus.${process.status}`) : null
  const canStopForegroundExec = !process && status === 'running' && !!toolUseId && hasForegroundExec

  const isLong = text.length > 1000
  const displayed = isLong && !expanded ? `...\n${text.slice(-1000)}` : text
  const lineCount = text.split('\n').length
  const tokenCount = React.useMemo(() => estimateTokens(text), [text])

  const handleSendInput = (): void => {
    if (!process || !isProcessRunning || terminalInput.length === 0) return
    void sendBackgroundProcessInput(process.id, terminalInput, true)
    setTerminalInput('')
  }

  // Auto-scroll to bottom when output is streaming
  React.useEffect(() => {
    if ((isProcessRunning || exitCode === undefined) && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [text, exitCode, isProcessRunning])

  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <Terminal className="size-3 text-green-400" />
        <p className="text-xs font-medium text-muted-foreground">{t('toolCall.terminal')}</p>
        {statusText && (
          <span
            className={cn(
              'text-[9px] font-mono px-1 rounded',
              process?.status === 'running'
                ? 'bg-blue-500/10 text-blue-400/70'
                : process?.status === 'error'
                  ? 'bg-red-500/10 text-red-400/70'
                  : 'bg-muted text-muted-foreground dark:bg-zinc-500/15 dark:text-zinc-300/70'
            )}
          >
            {statusText}
          </span>
        )}
        {exitCode !== undefined && (
          <span
            className={cn(
              'text-[9px] font-mono px-1 rounded',
              exitCode === 0 ? 'bg-green-500/10 text-green-400/70' : 'bg-red-500/10 text-red-400/70'
            )}
          >
            {t('toolCall.exitCode', { code: exitCode })}
          </span>
        )}
        {processId && <span className="text-[9px] text-muted-foreground/30">{processId}</span>}
        <span className="text-[9px] text-muted-foreground/30">{lineCount} lines</span>
        <CopyBtn text={text} />
      </div>
      <div
        ref={scrollRef}
        className="max-h-72 overflow-auto rounded-md border bg-muted/30 text-[11px] font-mono dark:bg-zinc-950"
        style={{ fontFamily: MONO_FONT }}
      >
        {text ? (
          <div className="px-3 py-2 space-y-2">
            {summary && (
              <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground/50">
                <span className="rounded bg-muted px-1 py-0.5 dark:bg-zinc-800/80">
                  {summary.mode ?? 'full'}
                </span>
                {summary.noisy && (
                  <span className="rounded bg-amber-500/10 px-1 py-0.5 text-amber-700/85 dark:text-amber-300/80">
                    noise reduced
                  </span>
                )}
                {typeof summary.totalLines === 'number' && (
                  <span className="rounded bg-muted/70 px-1 py-0.5 dark:bg-zinc-800/60">
                    {summary.totalLines} lines
                  </span>
                )}
                {typeof summary.errorLikeLines === 'number' && summary.errorLikeLines > 0 && (
                  <span className="rounded bg-red-500/10 px-1 py-0.5 text-red-700/85 dark:text-red-300/80">
                    {summary.errorLikeLines} error-like
                  </span>
                )}
                {typeof summary.warningLikeLines === 'number' && summary.warningLikeLines > 0 && (
                  <span className="rounded bg-amber-500/10 px-1 py-0.5 text-amber-700/85 dark:text-amber-300/80">
                    {summary.warningLikeLines} warning-like
                  </span>
                )}
              </div>
            )}
            {hasStructuredStreams ? (
              <>
                <ShellTextPane title="stderr" text={stderrText} expanded={expanded} tone="error" />
                <ShellTextPane
                  title={stderrText ? 'stdout' : 'output'}
                  text={stdoutText}
                  expanded={expanded}
                />
              </>
            ) : (
              <pre className="whitespace-pre-wrap break-words text-foreground/80 dark:text-zinc-300/80">
                {displayed}
              </pre>
            )}
          </div>
        ) : (
          <pre className="px-3 py-2 whitespace-pre-wrap break-words text-muted-foreground/70 dark:text-zinc-500/70">
            {t('toolCall.noOutputYet')}
          </pre>
        )}
      </div>

      {process && (
        <div className="mt-2 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px]"
              onClick={() => openDetailPanel({ type: 'terminal', processId: process.id })}
            >
              {t('toolCall.openSession')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[10px]"
              disabled={!isProcessRunning}
              onClick={() => void sendBackgroundProcessInput(process.id, '\u0003', false)}
            >
              {t('toolCall.sendCtrlC')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-6 gap-1 px-2 text-[10px]"
              disabled={!isProcessRunning}
              onClick={() => void stopBackgroundProcess(process.id)}
            >
              <Square className="size-2.5 fill-current" />
              {t('toolCall.stopProcess')}
            </Button>
          </div>
          <div className="flex items-center gap-1.5">
            <Input
              value={terminalInput}
              onChange={(e) => setTerminalInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSendInput()
                }
              }}
              disabled={!isProcessRunning}
              placeholder={t('toolCall.inputPlaceholder')}
              className="h-7 text-[11px]"
            />
            <Button
              size="sm"
              className="h-7 gap-1 px-2 text-[10px]"
              disabled={!isProcessRunning || terminalInput.length === 0}
              onClick={handleSendInput}
            >
              <SendHorizontal className="size-3.5" />
              {t('toolCall.sendInput')}
            </Button>
          </div>
        </div>
      )}

      {canStopForegroundExec && (
        <div className="mt-2 flex items-center gap-1.5">
          <Button
            variant="destructive"
            size="sm"
            className="h-6 gap-1 px-2 text-[10px]"
            onClick={() => {
              if (!toolUseId) return
              void abortForegroundShellExec(toolUseId)
            }}
          >
            <Square className="size-2.5 fill-current" />
            {t('toolCall.stopProcess')}
          </Button>
        </div>
      )}

      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded
            ? t('action.showLess', { ns: 'common' })
            : t('toolCall.showAllTokens', { tokens: formatTokens(tokenCount), lines: lineCount })}
        </button>
      )}
    </div>
  )
}

function HighlightText({ text, pattern }: { text: string; pattern?: string }): React.JSX.Element {
  if (!pattern) return <>{text}</>
  let parts: string[] | null = null
  try {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(${escaped})`, 'gi')
    parts = text.split(re)
  } catch {
    parts = null
  }
  if (!parts || parts.length <= 1) return <>{text}</>
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="bg-amber-500/25 text-amber-300 rounded-sm px-px">
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  )
}

function GrepOutputBlock({
  output,
  pattern
}: {
  output: string
  pattern?: string
}): React.JSX.Element {
  const { t } = useTranslation('chat')
  const parsed = React.useMemo(() => {
    const decoded = decodeStructuredToolResult(output)
    return Array.isArray(decoded)
      ? (decoded as Array<{ file: string; line: number; text: string }>)
      : null
  }, [output])

  // Group by file - must be called before early return to maintain hook order
  const groups = React.useMemo(() => {
    if (!parsed || !Array.isArray(parsed)) return []
    const map = new Map<string, Array<{ line: number; text: string }>>()
    for (const r of parsed) {
      const list = map.get(r.file) ?? []
      list.push({ line: r.line, text: r.text })
      map.set(r.file, list)
    }
    return Array.from(map.entries())
  }, [parsed])

  if (!parsed || !Array.isArray(parsed)) return <OutputBlock output={output} />

  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <Search className="size-3 text-amber-400" />
        <p className="text-xs font-medium text-muted-foreground">{t('toolCall.grepResults')}</p>
        {pattern && <span className="text-[9px] font-mono text-amber-400/50">/{pattern}/</span>}
        <span className="text-[9px] text-muted-foreground/40">
          {t('toolCall.matchesInFiles', { matches: parsed.length, files: groups.length })}
        </span>
        <CopyBtn text={output} />
      </div>
      <div
        className="max-h-72 overflow-auto rounded-md border bg-muted/30 text-[11px] font-mono divide-y divide-border dark:bg-zinc-950 dark:divide-zinc-800"
        style={{ fontFamily: MONO_FONT }}
      >
        {groups.map(([file, matches]) => (
          <div key={file} className="px-2 py-1.5">
            <div
              className="text-blue-400/70 truncate mb-0.5 cursor-pointer hover:text-blue-300 transition-colors"
              title={`Click to insert: ${file}`}
              onClick={() => {
                const short = file.split(/[\\/]/).slice(-2).join('/')
                import('@renderer/stores/ui-store').then(({ useUIStore }) =>
                  useUIStore.getState().setPendingInsertText(short)
                )
              }}
            >
              {file.split(/[\\/]/).slice(-3).join('/')}
            </div>
            {matches.map((m, i) => (
              <div key={i} className="flex gap-2 text-foreground/70 dark:text-zinc-400">
                <span className="w-5 shrink-0 select-none text-right text-muted-foreground/70 dark:text-zinc-600">
                  {m.line}
                </span>
                <span className="truncate">
                  <HighlightText text={m.text} pattern={pattern} />
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function GlobOutputBlock({ output }: { output: string }): React.JSX.Element {
  const { t } = useTranslation('chat')
  const maxVisibleItems = 200
  const parsed = React.useMemo(() => {
    const decoded = decodeStructuredToolResult(output)
    return Array.isArray(decoded) ? (decoded as string[]) : null
  }, [output])
  if (!parsed || !Array.isArray(parsed)) return <OutputBlock output={output} />
  const visibleItems = parsed.slice(0, maxVisibleItems)
  const hiddenCount = Math.max(0, parsed.length - visibleItems.length)

  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <FolderTree className="size-3 text-amber-400" />
        <p className="text-xs font-medium text-muted-foreground">{t('toolCall.globMatches')}</p>
        <span className="text-[9px] text-muted-foreground/40">{parsed.length} files</span>
        <CopyBtn text={parsed.join('\n')} />
      </div>
      <div
        className="max-h-48 overflow-auto rounded-md border bg-muted/30 px-3 py-2 text-[11px] font-mono text-foreground/70 space-y-0.5 dark:bg-zinc-950 dark:text-zinc-400"
        style={{ fontFamily: MONO_FONT }}
      >
        {visibleItems.map((p, i) => (
          <div
            key={i}
            className="truncate cursor-pointer hover:text-blue-400 transition-colors"
            title={`Click to insert: ${p}`}
            onClick={() => {
              const short = p.split(/[\\/]/).slice(-2).join('/')
              import('@renderer/stores/ui-store').then(({ useUIStore }) =>
                useUIStore.getState().setPendingInsertText(short)
              )
            }}
          >
            {p}
          </div>
        ))}
        {hiddenCount > 0 && (
          <div className="pt-1 text-[10px] text-muted-foreground/60">
            Showing first {visibleItems.length} results, {hiddenCount} more hidden.
          </div>
        )}
      </div>
    </div>
  )
}

function LSOutputBlock({ output }: { output: string }): React.JSX.Element {
  const { t } = useTranslation('chat')
  const parsed = React.useMemo(() => {
    const decoded = decodeStructuredToolResult(output)
    return Array.isArray(decoded)
      ? (decoded as Array<{ name: string; type: string; path: string }>)
      : null
  }, [output])
  if (!parsed || !Array.isArray(parsed)) return <OutputBlock output={output} />

  const dirs = parsed.filter((e) => e.type === 'directory')
  const files = parsed.filter((e) => e.type === 'file')

  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <FolderTree className="size-3 text-amber-400" />
        <p className="text-xs font-medium text-muted-foreground">
          {t('toolCall.directoryListing')}
        </p>
        <span className="text-[9px] text-muted-foreground/40">
          {t('toolCall.foldersAndFiles', { folders: dirs.length, files: files.length })}
        </span>
        <CopyBtn text={parsed.map((e) => e.name).join('\n')} />
      </div>
      <div
        className="max-h-48 overflow-auto rounded-md border bg-muted/30 px-3 py-2 text-[11px] font-mono space-y-0.5 dark:bg-zinc-950"
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
            className="flex cursor-pointer items-center gap-1.5 text-foreground/70 transition-colors hover:text-blue-400 dark:text-zinc-400"
            title={`Click to insert: ${e.path || e.name}`}
            onClick={() => {
              const short = (e.path || e.name).split(/[\\/]/).slice(-2).join('/')
              import('@renderer/stores/ui-store').then(({ useUIStore }) =>
                useUIStore.getState().setPendingInsertText(short)
              )
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

function TaskCreateInputBlock({
  input
}: {
  input: Record<string, unknown>
}): React.JSX.Element | null {
  const { t } = useTranslation('chat')
  const subject = input.subject ? String(input.subject) : null
  const description = input.description ? String(input.description) : null
  if (!subject) return null

  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <ListChecks className="size-3 text-blue-400" />
        <p className="text-xs font-medium text-muted-foreground">{t('toolCall.taskList')}</p>
      </div>
      <div className="rounded-md border bg-muted/10 px-2.5 py-1.5 text-[12px] space-y-0.5">
        <div className="flex items-center gap-2">
          <Circle className="size-3 text-muted-foreground/40" />
          <span className="flex-1 font-medium">{subject}</span>
        </div>
        {description && (
          <p className="pl-5 text-[11px] text-muted-foreground/60 line-clamp-2">{description}</p>
        )}
      </div>
    </div>
  )
}

function TaskListOutputBlock({ output }: { output: string }): React.JSX.Element {
  const { t } = useTranslation('chat')
  const parsed = React.useMemo(() => {
    const data = decodeStructuredToolResult(output)
    if (data && !Array.isArray(data) && Array.isArray(data.tasks)) {
      return data.tasks as Array<{
        id: string
        subject: string
        status: string
        owner?: string | null
      }>
    }
    return null
  }, [output])

  if (!parsed) return <OutputBlock output={output} />

  const completed = parsed.filter((t) => t.status === 'completed').length
  const statusIcon = (s: string): React.ReactNode => {
    if (s === 'completed') return <CheckCircle2 className="size-3 text-green-500" />
    if (s === 'in_progress') return <CircleDot className="size-3 text-blue-500" />
    return <Circle className="size-3 text-muted-foreground/40" />
  }

  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <ListChecks className="size-3 text-blue-400" />
        <p className="text-xs font-medium text-muted-foreground">{t('toolCall.taskList')}</p>
        <span className="text-[9px] text-muted-foreground/40">
          {completed}/{parsed.length}
        </span>
      </div>
      <div className="rounded-md border bg-muted/10 divide-y divide-border/50 text-[12px]">
        {parsed.map((task) => (
          <div key={task.id} className="flex items-center gap-2 px-2.5 py-1.5">
            {statusIcon(task.status)}
            <span
              className={cn(
                'flex-1',
                task.status === 'completed' && 'line-through text-muted-foreground/50'
              )}
            >
              {task.subject}
            </span>
            {task.owner && (
              <span className="text-[9px] text-muted-foreground/40">{task.owner}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length
}

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

type DiffLine = { type: 'keep' | 'add' | 'del'; text: string; oldNum?: number; newNum?: number }

function computeDiff(oldStr: string, newStr: string): DiffLine[] {
  const a = oldStr.split('\n')
  const b = newStr.split('\n')
  const m = a.length,
    n = b.length

  // Simple LCS DP for small inputs; fall back to naive for large diffs
  if (m * n > 100000) {
    return [
      ...a.map((t, i): DiffLine => ({ type: 'del', text: t, oldNum: i + 1 })),
      ...b.map((t, i): DiffLine => ({ type: 'add', text: t, newNum: i + 1 }))
    ]
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

type DiffChunk =
  | { type: 'lines'; lines: DiffLine[] }
  | { type: 'collapsed'; count: number; lines: DiffLine[] }

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

function InlineDiff({ oldStr, newStr }: { oldStr: string; newStr: string }): React.JSX.Element {
  const { t } = useTranslation('chat')
  const lines = React.useMemo(() => computeDiff(oldStr, newStr), [oldStr, newStr])
  const chunks = React.useMemo(() => foldContext(lines), [lines])
  const [expandedChunks, setExpandedChunks] = React.useState<Set<number>>(new Set())

  const renderLine = (line: DiffLine, key: number): React.JSX.Element => (
    <div
      key={key}
      className={cn(
        'flex',
        line.type === 'del' && 'bg-red-500/10',
        line.type === 'add' && 'bg-green-500/10'
      )}
    >
      <span
        className={cn(
          'select-none w-5 shrink-0 text-right pr-1',
          line.type === 'del'
            ? 'text-red-400/40'
            : line.type === 'add'
              ? 'text-green-600/50 dark:text-green-400/40'
              : 'text-muted-foreground/70 dark:text-zinc-600'
        )}
      >
        {line.oldNum ?? line.newNum ?? ''}
      </span>
      <span
        className={cn(
          'px-1.5 flex-1 font-mono',
          line.type === 'del' && 'text-red-700/85 dark:text-red-300/80',
          line.type === 'add' && 'text-green-700/85 dark:text-green-300/80',
          line.type === 'keep' && 'text-foreground/70 dark:text-zinc-500'
        )}
        style={{ fontFamily: MONO_FONT, whiteSpace: 'pre-wrap' }}
      >
        {line.type === 'del' ? '- ' : line.type === 'add' ? '+ ' : '  '}
        {line.text}
      </span>
    </div>
  )

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-end gap-2 text-[10px] text-muted-foreground/60">
        <CopyBtn
          text={oldStr}
          title={t('fileChange.copyOldString', { defaultValue: 'Copy old string' })}
        />
        <CopyBtn
          text={newStr}
          title={t('fileChange.copyNewString', { defaultValue: 'Copy new string' })}
        />
      </div>
      <div
        className="max-h-64 overflow-auto rounded-md border bg-muted/30 text-[11px] font-mono leading-relaxed dark:bg-zinc-950"
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
              className="flex w-full items-center justify-center border-y border-border/50 py-0.5 text-[9px] text-muted-foreground/60 transition-colors hover:bg-muted/40 hover:text-foreground dark:border-zinc-800/30 dark:text-zinc-500/50 dark:hover:bg-zinc-800/30 dark:hover:text-zinc-400"
              onClick={() => setExpandedChunks((prev) => new Set([...prev, ci]))}
            >
              {t('toolCall.unchangedLines', { count: chunk.count })}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Structured input field row */
function InputField({
  label,
  value,
  mono,
  icon
}: {
  label: string
  value: string
  mono?: boolean
  icon?: React.ReactNode
}): React.JSX.Element | null {
  if (!value) return null
  return (
    <div className="flex items-start gap-2 text-[12px]">
      <span className="shrink-0 text-muted-foreground/50 min-w-[70px] text-right select-none flex items-center justify-end gap-1">
        {icon}
        {label}
      </span>
      <span
        className={cn('break-all', mono && 'font-mono text-[11px]')}
        style={mono ? { fontFamily: MONO_FONT } : undefined}
      >
        {value}
      </span>
    </div>
  )
}

/** Render tool input as structured UI instead of raw JSON */
function StructuredInput({
  name,
  input
}: {
  name: string
  input: Record<string, unknown>
}): React.JSX.Element {
  // Bash: command in terminal-style block + description/timeout as fields
  if (name === 'Bash') {
    const command = String(input.command ?? '')
    const description = input.description ? String(input.description) : null
    const timeout = input.timeout ? String(input.timeout) : null
    return (
      <div className="space-y-1.5">
        {description && <p className="text-xs text-muted-foreground/60 italic">{description}</p>}
        <div
          className="max-h-40 overflow-auto rounded-md border bg-muted/30 text-[11px] font-mono dark:bg-zinc-950"
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
          <span className="font-mono text-[11px] break-all" style={{ fontFamily: MONO_FONT }}>
            {filePath}
          </span>
        </div>
        {(offset || limit) && (
          <div className="flex items-center gap-2 pl-[18px]">
            {offset && (
              <span className="text-[10px] text-muted-foreground/40">offset: {offset}</span>
            )}
            {limit && <span className="text-[10px] text-muted-foreground/40">limit: {limit}</span>}
          </div>
        )}
      </div>
    )
  }

  // Edit: lightweight preview until the diff is ready to render
  if (name === 'Edit') {
    const filePath = String(input.file_path ?? input.path ?? '')
    const explanation = input.explanation ? String(input.explanation) : null
    const oldStr = typeof input.old_string === 'string' ? input.old_string : ''
    const newStr = typeof input.new_string === 'string' ? input.new_string : ''
    const hasCounts = oldStr.length > 0 || newStr.length > 0

    return (
      <div className="space-y-0.5">
        {filePath && (
          <div className="flex items-center gap-1.5 text-xs">
            <FileCode className="size-3 text-amber-400" />
            <span className="font-mono text-[11px] break-all" style={{ fontFamily: MONO_FONT }}>
              {filePath}
            </span>
          </div>
        )}
        {explanation && (
          <p className="pl-[18px] text-[11px] text-muted-foreground/60">{explanation}</p>
        )}
        {hasCounts && (
          <div className="pl-[18px] text-[10px] text-muted-foreground/40">
            -{lineCount(oldStr)} / +{lineCount(newStr)} lines
          </div>
        )}
      </div>
    )
  }

  // Write: lightweight preview while content is still streaming/running
  if (name === 'Write') {
    const filePath = String(input.file_path ?? input.path ?? '')
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

    if (!content) {
      return (
        <div className="space-y-1">
          {filePath && (
            <div className="flex items-center gap-1.5 text-xs">
              <FileCode className="size-3 text-green-400" />
              <span className="font-mono text-[11px] break-all" style={{ fontFamily: MONO_FONT }}>
                {filePath}
              </span>
            </div>
          )}
          {visiblePreview && (
            <pre
              className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 px-2.5 py-2 text-[11px] text-foreground/80 dark:bg-zinc-950 dark:text-zinc-300/80"
              style={{ fontFamily: MONO_FONT }}
            >
              {visiblePreview}
              {input.content_truncated ? '\n…' : ''}
            </pre>
          )}
          {!filePath && (lineTotal !== null || charTotal !== null) && (
            <div className="pl-[18px] text-[10px] text-muted-foreground/40">
              {lineTotal !== null ? `${lineTotal} lines` : ''}
              {lineTotal !== null && charTotal !== null ? ' · ' : ''}
              {charTotal !== null ? `${charTotal} chars` : ''}
            </div>
          )}
        </div>
      )
    }
  }

  // SavePlan: preview-only rendering, always prefer content_preview then content
  if (name === 'SavePlan') {
    const preview =
      (typeof input.content_preview === 'string' && input.content_preview) ||
      (typeof input.content === 'string' && input.content) ||
      ''
    if (!preview) return <></>
    return (
      <div className="space-y-1">
        <pre
          className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 px-2.5 py-2 text-[11px] text-foreground/80 dark:bg-zinc-950 dark:text-zinc-300/80"
          style={{ fontFamily: MONO_FONT }}
        >
          {preview}
        </pre>
      </div>
    )
  }

  // LS: path
  if (name === 'LS') {
    const path = String(input.path ?? '')
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <Folder className="size-3 text-amber-400" />
        <span className="font-mono text-[11px]" style={{ fontFamily: MONO_FONT }}>
          {path}
        </span>
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
          <span
            className="font-mono text-[11px] text-amber-400/80"
            style={{ fontFamily: MONO_FONT }}
          >
            {pattern}
          </span>
        </div>
        {path && (
          <div className="pl-[18px]">
            <span
              className="text-[10px] text-muted-foreground/40 font-mono"
              style={{ fontFamily: MONO_FONT }}
            >
              in {path}
            </span>
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
          <span
            className="font-mono text-[11px] text-amber-400/80"
            style={{ fontFamily: MONO_FONT }}
          >
            /{pattern}/
          </span>
        </div>
        {(path || include) && (
          <div className="flex items-center gap-2 pl-[18px]">
            {path && (
              <span
                className="text-[10px] text-muted-foreground/40 font-mono"
                style={{ fontFamily: MONO_FONT }}
              >
                in {path}
              </span>
            )}
            {include && (
              <span
                className="text-[10px] text-muted-foreground/40 font-mono"
                style={{ fontFamily: MONO_FONT }}
              >
                include: {include}
              </span>
            )}
          </div>
        )}
      </div>
    )
  }

  // Unified Task tool (SubAgents)
  if (name === 'Task') {
    return (
      <div className="space-y-0.5">
        <InputField label="subagent_type" value={String(input.subagent_type ?? '')} />
        <InputField label="description" value={String(input.description ?? '')} />
        {input.prompt != null && (
          <InputField
            label="prompt"
            value={
              String(input.prompt).length > 200
                ? String(input.prompt).slice(0, 200) + '…'
                : String(input.prompt)
            }
          />
        )}
      </div>
    )
  }

  // CronAdd: schedule kind + name + prompt
  if (name === 'CronAdd') {
    const jobName = input.name ? String(input.name) : null
    const schedule = input.schedule as
      | { kind?: string; at?: string; every?: number; expr?: string; tz?: string }
      | undefined
    const prompt = input.prompt ? String(input.prompt) : null
    const deleteAfterRun = Boolean(input.deleteAfterRun)
    const agentId = input.agentId ? String(input.agentId) : null
    const kindLabels: Record<string, string> = { at: '一次性', every: '间隔', cron: 'Cron' }
    const kindColors: Record<string, string> = {
      at: 'bg-amber-500/10 text-amber-400',
      every: 'bg-cyan-500/10 text-cyan-400',
      cron: 'bg-violet-500/10 text-violet-400'
    }
    const kind = schedule?.kind ?? 'cron'
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs">
          <Clock className="size-3 text-blue-400" />
          {schedule?.expr && (
            <span
              className="font-mono text-[11px] text-blue-400/80"
              style={{ fontFamily: MONO_FONT }}
            >
              {schedule.expr}
            </span>
          )}
          {schedule?.every && (
            <span
              className="font-mono text-[11px] text-cyan-400/80"
              style={{ fontFamily: MONO_FONT }}
            >
              every{' '}
              {schedule.every >= 3600000
                ? `${(schedule.every / 3600000).toFixed(1)}h`
                : `${Math.round(schedule.every / 60000)}m`}
            </span>
          )}
          {schedule?.at && (
            <span
              className="font-mono text-[11px] text-amber-400/80"
              style={{ fontFamily: MONO_FONT }}
            >
              {String(schedule.at).slice(0, 19)}
            </span>
          )}
          <span
            className={cn(
              'text-[9px] px-1 rounded',
              kindColors[kind] ?? 'bg-zinc-700/60 text-zinc-400'
            )}
          >
            {kindLabels[kind] ?? kind}
          </span>
          {deleteAfterRun && (
            <span className="text-[9px] px-1 rounded bg-amber-500/10 text-amber-400/80">
              auto-delete
            </span>
          )}
          {schedule?.tz && schedule.tz !== 'UTC' && (
            <span className="text-[9px] text-muted-foreground/40">{schedule.tz}</span>
          )}
        </div>
        {jobName && <p className="text-xs text-muted-foreground/60 italic pl-[18px]">{jobName}</p>}
        {prompt && (
          <div className="pl-[18px] flex items-center gap-1.5">
            <Bot className="size-2.5 text-violet-400" />
            <span className="text-[10px] text-violet-400/70 truncate max-w-[260px]">
              {prompt.slice(0, 100)}
            </span>
          </div>
        )}
        {agentId && agentId !== 'CronAgent' && (
          <div className="pl-[18px]">
            <span className="text-[9px] px-1 rounded bg-violet-500/10 text-violet-400">
              agent: {agentId}
            </span>
          </div>
        )}
      </div>
    )
  }

  // CronUpdate: jobId + patch summary
  if (name === 'CronUpdate') {
    const jobId = String(input.jobId ?? '')
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <Clock className="size-3 text-blue-400/70" />
        <span className="font-mono text-[11px] text-blue-400/70" style={{ fontFamily: MONO_FONT }}>
          {jobId}
        </span>
        <span className="text-[9px] text-muted-foreground/50">patch</span>
      </div>
    )
  }

  // CronRemove / CronList: simple display
  if (name === 'CronRemove') {
    const jobId = String(input.jobId ?? '')
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <Clock className="size-3 text-muted-foreground/50" />
        <span
          className="font-mono text-[11px] text-muted-foreground/70"
          style={{ fontFamily: MONO_FONT }}
        >
          {jobId}
        </span>
      </div>
    )
  }

  if (name === 'CronList') {
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <Clock className="size-3 text-muted-foreground/50" />
        <span className="text-muted-foreground/60">list all scheduled cron jobs</span>
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
const EXPAND_TOOLS = new Set(['Edit', 'Write', 'Delete', 'Bash', 'TaskCreate', 'TaskList'])

export function ToolStatusDot({
  status
}: {
  status: ToolCallCardProps['status']
}): React.JSX.Element {
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
  toolUseId,
  name,
  input,
  output,
  status,
  error,
  startedAt,
  completedAt
}: ToolCallCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  // Auto-expand for errors and mutation tools with output; keep read-heavy tools collapsed
  const shouldAutoExpand =
    status === 'error' ||
    (!!output && EXPAND_TOOLS.has(name)) ||
    (name === 'Bash' && status === 'running')
  const [open, setOpen] = React.useState(shouldAutoExpand)

  React.useEffect(() => {
    if (shouldAutoExpand) setOpen(true)
  }, [shouldAutoExpand])

  const summary = inputSummary(name, input)
  const showSettledEditDiff =
    name === 'Edit' &&
    status !== 'streaming' &&
    status !== 'running' &&
    !!input.old_string &&
    !!input.new_string
  const showSettledWriteContent =
    name === 'Write' && status !== 'streaming' && status !== 'running' && !!input.content
  const elapsed =
    startedAt && completedAt ? ((completedAt - startedAt) / 1000).toFixed(1) + 's' : null

  return (
    <div className="my-5 min-w-0 overflow-hidden">
      {/* Header — click to toggle */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ToolStatusDot status={status} />
        <span className="font-medium">{name}</span>
        {status === 'streaming' && !error && (
          <>
            {name === 'Write' && (input.file_path || input.path) ? (
              <span className="text-blue-400/70 text-[10px] animate-pulse">
                写入:{' '}
                {String(input.file_path || input.path)
                  .split(/[\\/]/)
                  .slice(-2)
                  .join('/')}
                {((typeof input.content === 'string' && lineCount(input.content)) ||
                  (typeof input.content_lines === 'number' && input.content_lines)) &&
                  ` (${typeof input.content_lines === 'number' ? input.content_lines : lineCount(String(input.content ?? ''))} lines)`}
              </span>
            ) : name === 'Edit' && (input.file_path || input.path) ? (
              <span className="text-amber-400/70 text-[10px] animate-pulse">
                编辑:{' '}
                {String(input.file_path || input.path)
                  .split(/[\\/]/)
                  .slice(-2)
                  .join('/')}
              </span>
            ) : (
              <span className="text-violet-400/70 text-[10px] animate-pulse">
                {t('toolCall.receivingArgs')}
              </span>
            )}
          </>
        )}
        {error && status === 'streaming' && (
          <span className="text-red-400/70 text-[10px] animate-pulse">{t('error.label')}</span>
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
          {/* Diff view for Edit tool */}
          {showSettledEditDiff && (
            <InlineDiff oldStr={String(input.old_string)} newStr={String(input.new_string)} />
          )}
          {/* Write: show content with syntax highlighting */}
          {showSettledWriteContent && name === 'Write' && (
            <div>
              <div className="mb-1 flex items-center gap-1.5">
                <p className="text-xs font-medium text-muted-foreground">{t('toolCall.content')}</p>
                <span className="text-[9px] text-muted-foreground/40 font-mono">
                  {detectLang(String(input.file_path ?? input.path ?? ''))} ·{' '}
                  {typeof input.content === 'string' ? input.content.split('\n').length : '?'} lines
                </span>
                <CopyBtn text={String(input.content)} />
              </div>
              <LazySyntaxHighlighter
                language={detectLang(String(input.file_path ?? input.path ?? ''))}
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
              </LazySyntaxHighlighter>
            </div>
          )}
          {/* TaskCreate: checklist-style input */}
          {name === 'TaskCreate' && !!input.subject && <TaskCreateInputBlock input={input} />}
          {/* Structured Input — tool-specific rendering */}
          {!(
            showSettledEditDiff ||
            showSettledWriteContent ||
            (name === 'TaskCreate' && !!input.subject)
          ) && <StructuredInput name={name} input={input} />}
          {/* Output — tool-specific rendering */}
          {output && name === 'Read' && hasImageBlocks(output) && (
            <ImageOutputBlock output={output} />
          )}
          {output && name === 'Read' && !hasImageBlocks(output) && outputAsString(output) && (
            <ReadOutputBlock
              output={outputAsString(output)!}
              filePath={String(input.file_path ?? input.path ?? '')}
            />
          )}
          {name === 'Bash' && (status === 'running' || outputAsString(output)) && (
            <BashOutputBlock
              output={outputAsString(output) ?? ''}
              toolUseId={toolUseId}
              status={status}
            />
          )}
          {output && name === 'Grep' && outputAsString(output) && (
            <GrepOutputBlock
              output={outputAsString(output)!}
              pattern={String(input.pattern ?? '')}
            />
          )}
          {output && name === 'Glob' && outputAsString(output) && (
            <GlobOutputBlock output={outputAsString(output)!} />
          )}
          {output && name === 'LS' && outputAsString(output) && (
            <LSOutputBlock output={outputAsString(output)!} />
          )}
          {output && name === 'TaskList' && outputAsString(output) && (
            <TaskListOutputBlock output={outputAsString(output)!} />
          )}
          {output &&
            ['Edit', 'Write', 'Delete'].includes(name) &&
            (() => {
              const s = outputAsString(output) ?? ''
              return (
                <div className="flex items-center gap-1.5 text-xs">
                  {(() => {
                    const parsed = decodeStructuredToolResult(s)
                    return !!(parsed && !Array.isArray(parsed) && parsed.success === true)
                  })() ? (
                    <>
                      <CheckCircle2 className="size-3 text-green-500" />
                      <span className="text-green-500/70">{t('toolCall.appliedSuccessfully')}</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="size-3 text-destructive" />
                      <span className="text-destructive/70 font-mono truncate">
                        {s.slice(0, 100)}
                      </span>
                    </>
                  )}
                </div>
              )
            })()}
          {output &&
            ![
              'Read',
              'Bash',
              'Grep',
              'Glob',
              'LS',
              'TaskCreate',
              'TaskUpdate',
              'TaskGet',
              'TaskList',
              'Edit',
              'Write',
              'Delete',
              'AskUserQuestion'
            ].includes(name) &&
            (hasImageBlocks(output) ? (
              <ImageOutputBlock output={output} />
            ) : outputAsString(output) ? (
              <OutputBlock output={outputAsString(output)!} />
            ) : null)}
          {/* Error */}
          {error && (
            <div>
              <p className="mb-1 text-xs font-medium text-destructive">{t('error.label')}</p>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs text-destructive font-mono">
                {error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
