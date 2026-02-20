import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  CheckCircle2,
  XCircle,
  Copy,
  Check,
  ArrowRight,
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
import { MONO_FONT } from '@renderer/lib/constants'
import { estimateTokens, formatTokens } from '@renderer/lib/format-tokens'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { LazySyntaxHighlighter } from './LazySyntaxHighlighter'

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

export function inputSummary(name: string, input: Record<string, unknown>): string {
  // Tool-specific smart summaries
  if (name === 'Bash' && input.command) return String(input.command).slice(0, 80)
  if (['Read', 'Write', 'LS'].includes(name)) {
    const p = String(input.file_path ?? input.path ?? '')
    return p.split(/[\\/]/).slice(-2).join('/')
  }
  if (name === 'Edit') {
    const p = String(input.file_path ?? input.path ?? '')
      .split(/[\\/]/)
      .slice(-2)
      .join('/')
    const expl = typeof input.explanation === 'string' ? ` — ${input.explanation.slice(0, 50)}` : ''
    return `${p}${expl}`
  }
  if (name === 'MultiEdit') {
    const p = String(input.file_path ?? input.path ?? '')
      .split(/[\\/]/)
      .slice(-2)
      .join('/')
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
  if (name === 'TaskCreate' && input.subject) return String(input.subject).slice(0, 60)
  if (name === 'TaskUpdate' && input.taskId) return `#${input.taskId}${input.status ? ` → ${input.status}` : ''}`
  if (name === 'TaskGet' && input.taskId) return `#${input.taskId}`
  if (name === 'TaskList') return 'list tasks'
  if (name === 'CronAdd') {
    const n = input.name ? String(input.name) : ''
    const sched = input.schedule as { kind?: string; expr?: string } | undefined
    const kindLabel = sched?.kind ?? ''
    const expr = sched?.expr ?? ''
    return n ? `${n} (${kindLabel}${expr ? ` ${expr}` : ''})` : kindLabel
  }
  if (name === 'CronUpdate' && input.jobId) return `update: ${String(input.jobId)}`
  if (name === 'CronRemove' && input.jobId) return `remove: ${String(input.jobId)}`
  if (name === 'CronList') return 'list cron jobs'
  if (name === 'AskUserQuestion') {
    const qs = input.questions as Array<{ question?: string }> | undefined
    if (qs && qs.length > 0) return String(qs[0].question ?? '').slice(0, 60)
    return 'asking user...'
  }
  if (name === 'Task')
    return `[${input.subagent_type ?? '?'}] ${String(input.description ?? '').slice(0, 50)}`
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
      onClick={() => {
        navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
      className="ml-auto rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors"
      title="Copy"
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
              className="max-w-full max-h-72 rounded-md border object-contain bg-zinc-950"
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
          {expanded ? t('toolCall.showFirst40') : t('toolCall.showAllLines', { count: lines.length })}
        </button>
      )}
    </div>
  )
}

function BashOutputBlock({
  output,
  toolUseId,
  status,
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
    try {
      const obj = JSON.parse(output) as {
        stdout?: string
        stderr?: string
        exitCode?: number
        output?: string
        processId?: string
      }
      if (
        typeof obj === 'object' &&
        obj !== null &&
        ('stdout' in obj || 'output' in obj || 'exitCode' in obj || 'processId' in obj)
      ) {
        return obj
      }
    } catch {
      /* not JSON */
    }
    return null
  }, [output])

  const processId = parsed?.processId ? String(parsed.processId) : null
  const process = useAgentStore((s) =>
    processId ? s.backgroundProcesses[processId] : undefined
  )

  const fallbackText = parsed
    ? (parsed.stdout ?? parsed.output ?? '') + (parsed.stderr ? `\n${parsed.stderr}` : '')
    : output
  const text = process?.output || fallbackText
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
                  : 'bg-zinc-500/15 text-zinc-300/70'
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
        className="rounded-md border bg-zinc-950 overflow-auto max-h-72 text-[11px] font-mono"
        style={{ fontFamily: MONO_FONT }}
      >
        {text ? (
          <pre className="px-3 py-2 whitespace-pre-wrap break-words text-zinc-300/80">{displayed}</pre>
        ) : (
          <pre className="px-3 py-2 whitespace-pre-wrap break-words text-zinc-500/70">
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
            <span key={i} className="bg-amber-500/25 text-amber-300 rounded-sm px-px">
              {part}
            </span>
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

function GrepOutputBlock({
  output,
  pattern
}: {
  output: string
  pattern?: string
}): React.JSX.Element {
  const { t } = useTranslation('chat')
  const parsed = React.useMemo(() => {
    try {
      return JSON.parse(output) as Array<{ file: string; line: number; text: string }>
    } catch {
      return null
    }
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
        <p className="text-xs font-medium text-muted-foreground">{t('toolCall.grepResults')}</p>
        {pattern && <span className="text-[9px] font-mono text-amber-400/50">/{pattern}/</span>}
        <span className="text-[9px] text-muted-foreground/40">
          {t('toolCall.matchesInFiles', { matches: parsed.length, files: groups.length })}
        </span>
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
                import('@renderer/stores/ui-store').then(({ useUIStore }) =>
                  useUIStore.getState().setPendingInsertText(short)
                )
              }}
            >
              {file.split(/[\\/]/).slice(-3).join('/')}
            </div>
            {matches.map((m, i) => (
              <div key={i} className="flex gap-2 text-zinc-400">
                <span className="select-none text-zinc-600 w-5 text-right shrink-0">{m.line}</span>
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
  const parsed = React.useMemo(() => {
    try {
      return JSON.parse(output) as string[]
    } catch {
      return null
    }
  }, [output])
  if (!parsed || !Array.isArray(parsed)) return <OutputBlock output={output} />

  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <FolderTree className="size-3 text-amber-400" />
        <p className="text-xs font-medium text-muted-foreground">{t('toolCall.globMatches')}</p>
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
              import('@renderer/stores/ui-store').then(({ useUIStore }) =>
                useUIStore.getState().setPendingInsertText(short)
              )
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
  const { t } = useTranslation('chat')
  const parsed = React.useMemo(() => {
    try {
      return JSON.parse(output) as Array<{ name: string; type: string; path: string }>
    } catch {
      return null
    }
  }, [output])
  if (!parsed || !Array.isArray(parsed)) return <OutputBlock output={output} />

  const dirs = parsed.filter((e) => e.type === 'directory')
  const files = parsed.filter((e) => e.type === 'file')

  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <FolderTree className="size-3 text-amber-400" />
        <p className="text-xs font-medium text-muted-foreground">{t('toolCall.directoryListing')}</p>
        <span className="text-[9px] text-muted-foreground/40">
          {t('toolCall.foldersAndFiles', { folders: dirs.length, files: files.length })}
        </span>
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

function TaskCreateInputBlock({ input }: { input: Record<string, unknown> }): React.JSX.Element | null {
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
    try {
      const data = JSON.parse(output)
      if (data.tasks && Array.isArray(data.tasks)) return data.tasks as Array<{ id: string; subject: string; status: string; owner?: string | null }>
    } catch {
      /* not JSON */
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

function DiffBlock({
  oldStr,
  newStr,
  filePath
}: {
  oldStr: string
  newStr: string
  filePath?: string
}): React.JSX.Element {
  const { t } = useTranslation('chat')
  const lines = React.useMemo(() => computeDiff(oldStr, newStr), [oldStr, newStr])
  const chunks = React.useMemo(() => foldContext(lines), [lines])
  const [expandedChunks, setExpandedChunks] = React.useState<Set<number>>(new Set())
  const added = lines.filter((l) => l.type === 'add').length
  const removed = lines.filter((l) => l.type === 'del').length

  const renderLine = (line: DiffLine, i: number): React.JSX.Element => (
    <div
      key={i}
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
              ? 'text-green-400/40'
              : 'text-zinc-600'
        )}
      >
        {line.oldNum ?? line.newNum ?? ''}
      </span>
      <span
        className={cn(
          'px-1.5 flex-1',
          line.type === 'del' && 'text-red-300/80',
          line.type === 'add' && 'text-green-300/80',
          line.type === 'keep' && 'text-zinc-500'
        )}
      >
        {line.type === 'del' ? '- ' : line.type === 'add' ? '+ ' : '  '}
        {line.text}
      </span>
    </div>
  )

  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <ArrowRight className="size-3 text-muted-foreground" />
        <p className="text-xs font-medium text-muted-foreground">{t('toolCall.diff')}</p>
        {filePath && (
          <span className="text-[10px] text-muted-foreground/40 font-mono truncate">
            {filePath.split(/[\\/]/).slice(-2).join('/')}
          </span>
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

  // LS: path
  if (name === 'LS') {
    const path = String(input.path ?? '')
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <Folder className="size-3 text-amber-400" />
        <span
          className="font-mono text-[11px]"
          style={{ fontFamily: MONO_FONT }}
        >
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
    const schedule = input.schedule as { kind?: string; at?: string; every?: number; expr?: string; tz?: string } | undefined
    const prompt = input.prompt ? String(input.prompt) : null
    const deleteAfterRun = Boolean(input.deleteAfterRun)
    const agentId = input.agentId ? String(input.agentId) : null
    const kindLabels: Record<string, string> = { at: '一次性', every: '间隔', cron: 'Cron' }
    const kindColors: Record<string, string> = {
      at: 'bg-amber-500/10 text-amber-400',
      every: 'bg-cyan-500/10 text-cyan-400',
      cron: 'bg-violet-500/10 text-violet-400',
    }
    const kind = schedule?.kind ?? 'cron'
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs">
          <Clock className="size-3 text-blue-400" />
          {schedule?.expr && (
            <span className="font-mono text-[11px] text-blue-400/80" style={{ fontFamily: MONO_FONT }}>
              {schedule.expr}
            </span>
          )}
          {schedule?.every && (
            <span className="font-mono text-[11px] text-cyan-400/80" style={{ fontFamily: MONO_FONT }}>
              every {schedule.every >= 3600000 ? `${(schedule.every / 3600000).toFixed(1)}h` : `${Math.round(schedule.every / 60000)}m`}
            </span>
          )}
          {schedule?.at && (
            <span className="font-mono text-[11px] text-amber-400/80" style={{ fontFamily: MONO_FONT }}>
              {String(schedule.at).slice(0, 19)}
            </span>
          )}
          <span className={cn('text-[9px] px-1 rounded', kindColors[kind] ?? 'bg-zinc-700/60 text-zinc-400')}>
            {kindLabels[kind] ?? kind}
          </span>
          {deleteAfterRun && <span className="text-[9px] px-1 rounded bg-amber-500/10 text-amber-400/80">auto-delete</span>}
          {schedule?.tz && schedule.tz !== 'UTC' && (
            <span className="text-[9px] text-muted-foreground/40">{schedule.tz}</span>
          )}
        </div>
        {jobName && <p className="text-xs text-muted-foreground/60 italic pl-[18px]">{jobName}</p>}
        {prompt && (
          <div className="pl-[18px] flex items-center gap-1.5">
            <Bot className="size-2.5 text-violet-400" />
            <span className="text-[10px] text-violet-400/70 truncate max-w-[260px]">{prompt.slice(0, 100)}</span>
          </div>
        )}
        {agentId && agentId !== 'CronAgent' && (
          <div className="pl-[18px]">
            <span className="text-[9px] px-1 rounded bg-violet-500/10 text-violet-400">agent: {agentId}</span>
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
        <span className="font-mono text-[11px] text-muted-foreground/70" style={{ fontFamily: MONO_FONT }}>
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
const EXPAND_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'Delete', 'Bash', 'TaskCreate'])

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

function MultiEditList({ edits, filePath }: { edits: any[]; filePath: string }): React.JSX.Element | null {
  if (!edits || edits.length === 0) return null
  return (
    <div className="space-y-2">
      {edits.map((edit: any, i: number) => (
        <div key={i}>
          {edits.length > 1 && (
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="text-[9px] text-muted-foreground/40 font-mono">
                edit {i + 1}/{edits.length}
              </span>
              {typeof edit?.explanation === 'string' && (
                <span className="text-[9px] text-muted-foreground/30 truncate">
                  {edit.explanation}
                </span>
              )}
            </div>
          )}
          {typeof edit?.old_string === 'string' && typeof edit?.new_string === 'string' ? (
            <DiffBlock
              oldStr={edit.old_string}
              newStr={edit.new_string}
              filePath={filePath}
            />
          ) : null}
        </div>
      ))}
    </div>
  )
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
  const shouldAutoExpand = status === 'error' || (!!output && EXPAND_TOOLS.has(name)) || (name === 'Bash' && status === 'running')
  const [open, setOpen] = React.useState(shouldAutoExpand)

  React.useEffect(() => {
    if (shouldAutoExpand) setOpen(true)
  }, [shouldAutoExpand])

  const summary = inputSummary(name, input)
  const elapsed =
    startedAt && completedAt ? ((completedAt - startedAt) / 1000).toFixed(1) + 's' : null

  const multiEdits: any[] = React.useMemo(() => {
    if (name === 'MultiEdit' && Array.isArray(input.edits)) {
      return input.edits as any[]
    }
    return []
  }, [name, input.edits])

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
                写入: {String(input.file_path || input.path).split(/[\\/]/).slice(-2).join('/')}
                {typeof input.content === 'string' && ` (${input.content.split('\n').length} lines)`}
              </span>
            ) : (
              <span className="text-violet-400/70 text-[10px] animate-pulse">{t('toolCall.receivingArgs')}</span>
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
          {/* Diff view for Edit tools */}
          {(name === 'Edit' || name === 'MultiEdit') &&
            !!input.old_string &&
            !!input.new_string && (
              <DiffBlock
                oldStr={String(input.old_string)}
                newStr={String(input.new_string)}
                filePath={String(input.file_path ?? input.path ?? '')}
              />
            )}
          {/* MultiEdit: show all edits as diffs */}
          {name === 'MultiEdit' && multiEdits.length > 0 && (
             <MultiEditList
               edits={multiEdits}
               filePath={String(input.file_path ?? input.path ?? '')}
             />
          )}
          {/* Write: show content with syntax highlighting */}
          {name === 'Write' && !!input.content && (
            <div>
              <div className="mb-1 flex items-center gap-1.5">
                <p className="text-xs font-medium text-muted-foreground">{t('toolCall.content')}</p>
                <span className="text-[9px] text-muted-foreground/40 font-mono">
                  {detectLang(String(input.file_path ?? input.path ?? ''))} ·{' '}
                  {typeof input.content === 'string' ? input.content.split('\n').length : '?'} lines
                  {status === 'streaming' && ' (streaming...)'}
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
            (name === 'Edit' && !!input.old_string) ||
            (name === 'MultiEdit' && (!!input.old_string || Array.isArray(input.edits))) ||
            (name === 'Write' && !!input.content) ||
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
            ['Edit', 'MultiEdit', 'Write', 'Delete'].includes(name) &&
            (() => {
              const s = outputAsString(output) ?? ''
              return (
                <div className="flex items-center gap-1.5 text-xs">
                  {s.includes('"success"') || s.includes('success') ? (
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
              'MultiEdit',
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
