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
import { useChatActions } from '@renderer/hooks/use-chat-actions'

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

function deriveOutputError(output: string | undefined): string | null {
  if (!output) return null
  const trimmed = output.trim()
  if (!trimmed) return null

  const parsed = decodeStructuredToolResult(trimmed)
  if (parsed) {
    if (!Array.isArray(parsed) && typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error.trim()
    }
    return null
  }

  return trimmed
}

function isErrorOnlyOutput(output: string | undefined): boolean {
  if (!output) return false
  const trimmed = output.trim()
  if (!trimmed) return false

  const parsed = decodeStructuredToolResult(trimmed)
  if (!parsed) return true
  if (Array.isArray(parsed)) return false

  return (
    Object.keys(parsed).length === 1 &&
    typeof parsed.error === 'string' &&
    parsed.error.trim().length > 0
  )
}

function isStructuredBashResult(output: string | undefined): boolean {
  if (!output) return false
  const parsed = decodeStructuredToolResult(output.trim())
  if (!parsed || Array.isArray(parsed)) return false
  return (
    'stdout' in parsed ||
    'stderr' in parsed ||
    'output' in parsed ||
    'exitCode' in parsed ||
    'processId' in parsed
  )
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

interface WidgetToolPayload {
  title: string
  loadingMessages: string[]
  widgetCode: string
  kind: 'svg' | 'html'
}

const WIDGET_BRIDGE_SOURCE = 'open_cowork_widget'
const DEFAULT_WIDGET_LOADING_MESSAGES = ['Rendering widget...']

function normalizeWidgetPayload(input: Record<string, unknown>): WidgetToolPayload | null {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  const rawCode =
    typeof input.widget_code === 'string'
      ? input.widget_code
      : typeof input.widget_code_preview === 'string'
        ? input.widget_code_preview
        : ''
  const widgetCode = rawCode.trim()
  const loadingMessages = Array.isArray(input.loading_messages)
    ? input.loading_messages
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    : []

  if (!title && !widgetCode) return null

  return {
    title: title || 'widget',
    loadingMessages: loadingMessages.length > 0 ? loadingMessages : DEFAULT_WIDGET_LOADING_MESSAGES,
    widgetCode,
    kind: /^<svg[\s>]/i.test(widgetCode) ? 'svg' : 'html'
  }
}

function buildWidgetDocument(payload: WidgetToolPayload): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body {
        margin: 0;
        padding: 0;
        background: transparent;
      }
      body {
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: #e5e7eb;
        overflow: hidden;
      }
      #open-cowork-widget-root {
        width: 100%;
      }
      ${payload.kind === 'svg' ? '#open-cowork-widget-root { line-height: 0; font-size: 0; } #open-cowork-widget-root > svg { display: block; width: 100%; height: auto; }' : ''}
    </style>
    <script>
      (() => {
        const bridgeSource = ${JSON.stringify(WIDGET_BRIDGE_SOURCE)};
        const post = (type, extra = {}) => {
          window.parent.postMessage({ source: bridgeSource, type, ...extra }, '*');
        };
        const getBoundingHeight = (element) => {
          if (!element) return 0;
          return element.getBoundingClientRect?.().height || 0;
        };
        const getContentHeight = (element) => {
          if (!element) return 0;
          return Math.max(
            getBoundingHeight(element),
            element.scrollHeight || 0,
            element.offsetHeight || 0
          );
        };
        const reportSize = () => {
          const root = document.getElementById('open-cowork-widget-root');
          const content = root?.firstElementChild;
          const nextHeight =
            getBoundingHeight(content) ||
            getBoundingHeight(root) ||
            getContentHeight(root) ||
            getBoundingHeight(document.body) ||
            getContentHeight(document.body);
          post('resize', { height: Math.max(nextHeight, 32) });
        };

        window.sendPrompt = (text) => {
          if (typeof text !== 'string') return;
          const trimmed = text.trim();
          if (!trimmed) return;
          post('send_prompt', { text: trimmed });
        };

        window.__openCoworkWidgetReady = () => {
          const root = document.getElementById('open-cowork-widget-root');
          if (typeof ResizeObserver !== 'undefined' && root) {
            const observer = new ResizeObserver(() => reportSize());
            observer.observe(root);
          }
          post('ready');
          reportSize();
          window.requestAnimationFrame(reportSize);
          setTimeout(reportSize, 120);
          setTimeout(reportSize, 360);
        };
      })();
    </script>
  </head>
  <body>
    <div id="open-cowork-widget-root">${payload.widgetCode}</div>
    <script>window.__openCoworkWidgetReady && window.__openCoworkWidgetReady();</script>
  </body>
</html>`
}

export function WidgetOutputBlock({
  input,
  status
}: {
  input: Record<string, unknown>
  status: ToolCallStatus | 'completed'
}): React.JSX.Element | null {
  const payload = React.useMemo(() => normalizeWidgetPayload(input), [input])
  const iframeRef = React.useRef<HTMLIFrameElement>(null)
  const resizeRafRef = React.useRef<number | null>(null)
  const lastAppliedHeightRef = React.useRef<number>(0)
  const [loaded, setLoaded] = React.useState(false)
  const [frameHeight, setFrameHeight] = React.useState(240)
  const [loadingIndex, setLoadingIndex] = React.useState(0)
  const { sendMessage } = useChatActions()

  React.useEffect(() => {
    setLoaded(false)
    setLoadingIndex(0)
    setFrameHeight(payload?.kind === 'svg' ? 320 : 420)
  }, [payload?.title, payload?.widgetCode, payload?.kind])

  React.useEffect(() => {
    if (!payload || payload.loadingMessages.length <= 1 || loaded) return
    const timer = window.setInterval(() => {
      setLoadingIndex((index) => (index + 1) % payload.loadingMessages.length)
    }, 1400)
    return () => window.clearInterval(timer)
  }, [loaded, payload])

  React.useEffect(() => {
    const handleMessage = (event: MessageEvent): void => {
      if (event.source !== iframeRef.current?.contentWindow) return
      const data = event.data
      if (!data || typeof data !== 'object') return
      if ((data as { source?: unknown }).source !== WIDGET_BRIDGE_SOURCE) return

      const type = (data as { type?: unknown }).type
      if (type === 'ready') {
        setLoaded(true)
        return
      }

      if (type === 'resize') {
        const nextHeight = (data as { height?: unknown }).height
        if (typeof nextHeight === 'number' && Number.isFinite(nextHeight)) {
          const normalizedHeight = Math.max(80, nextHeight)
          if (Math.abs(normalizedHeight - lastAppliedHeightRef.current) >= 0.5) {
            lastAppliedHeightRef.current = normalizedHeight
            if (resizeRafRef.current != null) {
              window.cancelAnimationFrame(resizeRafRef.current)
            }
            resizeRafRef.current = window.requestAnimationFrame(() => {
              setFrameHeight(normalizedHeight)
              resizeRafRef.current = null
            })
          }
        }
        return
      }

      if (type === 'send_prompt') {
        const text = (data as { text?: unknown }).text
        if (typeof text === 'string' && text.trim()) {
          void sendMessage(text.trim())
        }
      }
    }

    window.addEventListener('message', handleMessage)
    return () => {
      window.removeEventListener('message', handleMessage)
      if (resizeRafRef.current != null) {
        window.cancelAnimationFrame(resizeRafRef.current)
        resizeRafRef.current = null
      }
    }
  }, [sendMessage])

  if (!payload) return null

  const isPending = status === 'streaming' || status === 'running' || !loaded
  const loadingMessage = payload.loadingMessages[loadingIndex] ?? DEFAULT_WIDGET_LOADING_MESSAGES[0]

  return (
    <div className="my-2 space-y-2">
      <div className="relative overflow-hidden rounded-xl bg-transparent shadow-sm" style={{ width: '100%', border: 'none', backgroundColor: 'transparent' }}>
        {payload.widgetCode ? (
          <div className="w-full overflow-hidden bg-transparent leading-none" style={{ lineHeight: 0, fontSize: 0 }}>
            <iframe
              ref={iframeRef}
              title={payload.title}
              sandbox="allow-scripts allow-forms"
              srcDoc={buildWidgetDocument(payload)}
              className="block border-0 bg-transparent transition-[height] duration-200"
              style={{ width: 'calc(100% + 1px)', height: `${frameHeight}px`, marginRight: '-1px', verticalAlign: 'top' }}
            />
          </div>
        ) : (
          <div className="flex h-48 items-center justify-center text-xs text-muted-foreground/60">
            Waiting for widget code...
          </div>
        )}
        {isPending && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/70 backdrop-blur-[1px]">
            <div className="rounded-md border border-border/60 bg-background/90 px-3 py-2 text-xs text-muted-foreground shadow-sm">
              {loadingMessage}
            </div>
          </div>
        )}
      </div>
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

function visualizeWhitespace(text: string): string {
  return text.replace(/\t/g, '→\t').replace(/ /g, '·')
}

function EditPayloadPane({
  label,
  value,
  tone = 'default'
}: {
  label: string
  value: string
  tone?: 'default' | 'old' | 'new'
}): React.JSX.Element {
  const borderTone =
    tone === 'old'
      ? 'border-red-500/20'
      : tone === 'new'
        ? 'border-green-500/20'
        : 'border-border/60'
  const headerTone =
    tone === 'old'
      ? 'text-red-400/80'
      : tone === 'new'
        ? 'text-green-400/80'
        : 'text-muted-foreground/60'

  return (
    <div className={cn('rounded-md border bg-muted/20 dark:bg-zinc-950/70', borderTone)}>
      <div className="flex items-center gap-1.5 border-b border-border/50 px-2.5 py-1.5 text-[10px] uppercase tracking-wide">
        <span className={headerTone}>{label}</span>
        <span className="text-muted-foreground/40">{lineCount(value)} lines</span>
        <span className="text-muted-foreground/40">{value.length} chars</span>
        <CopyBtn text={value} />
      </div>
      <pre
        className="max-h-48 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 text-[11px] text-foreground/80 dark:text-zinc-300/80"
        style={{ fontFamily: MONO_FONT }}
      >
        {visualizeWhitespace(value)}
      </pre>
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

  // Edit: show file path + counts during streaming, full payload when available
  if (name === 'Edit') {
    const filePath = String(input.file_path ?? input.path ?? '')
    const explanation = input.explanation ? String(input.explanation) : null
    const oldStr = typeof input.old_string === 'string' ? input.old_string : ''
    const newStr = typeof input.new_string === 'string' ? input.new_string : ''
    const oldPreview = typeof input.old_string_preview === 'string' ? input.old_string_preview : ''
    const newPreview = typeof input.new_string_preview === 'string' ? input.new_string_preview : ''
    const replaceAll = input.replace_all === true
    const visibleOld = oldStr || oldPreview
    const visibleNew = newStr || newPreview
    const oldLineTotal =
      typeof input.old_string_lines === 'number'
        ? input.old_string_lines
        : visibleOld
          ? lineCount(visibleOld)
          : null
    const newLineTotal =
      typeof input.new_string_lines === 'number'
        ? input.new_string_lines
        : visibleNew
          ? lineCount(visibleNew)
          : null
    const oldCharTotal = typeof input.old_string_chars === 'number' ? input.old_string_chars : null
    const newCharTotal = typeof input.new_string_chars === 'number' ? input.new_string_chars : null

    return (
      <div className="space-y-1">
        {filePath && (
          <div className="flex items-center gap-1.5 text-xs">
            <FileCode className="size-3 text-amber-400" />
            <span className="font-mono text-[11px] break-all" style={{ fontFamily: MONO_FONT }}>
              {filePath}
            </span>
            {replaceAll && (
              <span className="rounded bg-amber-500/10 px-1 py-0.5 text-[9px] text-amber-400/80">
                replace_all
              </span>
            )}
          </div>
        )}
        {explanation && (
          <p className="pl-[18px] text-[11px] text-muted-foreground/60">{explanation}</p>
        )}
        {(oldLineTotal !== null ||
          newLineTotal !== null ||
          oldCharTotal !== null ||
          newCharTotal !== null) && (
          <div className="pl-[18px] text-[10px] text-muted-foreground/40">
            {oldLineTotal !== null ? `-${oldLineTotal} lines` : '-? lines'}
            {' / '}
            {newLineTotal !== null ? `+${newLineTotal} lines` : '+? lines'}
            {(oldCharTotal !== null || newCharTotal !== null) && (
              <>
                {' · '}
                {oldCharTotal !== null ? `-${oldCharTotal} chars` : '-? chars'}
                {' / '}
                {newCharTotal !== null ? `+${newCharTotal} chars` : '+? chars'}
              </>
            )}
          </div>
        )}
        {(visibleOld || visibleNew) && (
          <div className="space-y-2 pl-[18px]">
            {visibleOld && <EditPayloadPane label="old_string" value={visibleOld} tone="old" />}
            {visibleNew && <EditPayloadPane label="new_string" value={visibleNew} tone="new" />}
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
          {(lineTotal !== null || charTotal !== null) && (
            <div className="pl-[18px] text-[10px] text-muted-foreground/40">
              {lineTotal !== null ? `${lineTotal} lines` : ''}
              {lineTotal !== null && charTotal !== null ? ' · ' : ''}
              {charTotal !== null ? `${charTotal} chars` : ''}
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
  if (name === 'visualize_show_widget') {
    const payload = normalizeWidgetPayload(input)
    const messages = Array.isArray(input.loading_messages)
      ? input.loading_messages.filter((item): item is string => typeof item === 'string')
      : []
    return (
      <div className="space-y-0.5">
        <InputField label="title" value={payload?.title ?? String(input.title ?? '')} />
        <InputField label="kind" value={payload?.kind ?? 'html'} />
        {messages.length > 0 && <InputField label="loading" value={messages.join(' / ')} />}
      </div>
    )
  }

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
const EXPAND_TOOLS = new Set(['Delete', 'Bash', 'TaskCreate', 'TaskList', 'visualize_show_widget'])

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

  const isProcessing = status === 'streaming' || status === 'running'
  const summary = inputSummary(name, input)
  const outputText = outputAsString(output)
  const outputIsErrorOnly = isErrorOnlyOutput(outputText)
  const outputError = deriveOutputError(outputText)
  const suppressErrorPanel = name === 'Bash' && isStructuredBashResult(outputText)
  const displayError = suppressErrorPanel ? null : error || (status === 'error' ? outputError : null)
  const shouldRenderOutputPanels = !displayError || !outputIsErrorOnly
  const hideLivePayload =
    isProcessing &&
    (name === 'Write' || name === 'Edit') &&
    input.content_hidden_until_complete === true
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
        {isProcessing && !error && (
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
          {hideLivePayload ? (
            <div className="space-y-2">
              <StructuredInput name={name} input={input} />
              <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground/70">
                Detailed Write/Edit content stays hidden until the tool finishes.
              </div>
            </div>
          ) : (
            <>
              {/* Write: show content with syntax highlighting */}
              {showSettledWriteContent && name === 'Write' && (
                <div>
                  <div className="mb-1 flex items-center gap-1.5">
                    <p className="text-xs font-medium text-muted-foreground">
                      {t('toolCall.content')}
                    </p>
                    <span className="text-[9px] text-muted-foreground/40 font-mono">
                      {detectLang(String(input.file_path ?? input.path ?? ''))} ·{' '}
                      {typeof input.content === 'string' ? input.content.split('\n').length : '?'}{' '}
                      lines
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
              {!(showSettledWriteContent || (name === 'TaskCreate' && !!input.subject)) && (
                <StructuredInput name={name} input={input} />
              )}
              {/* Output — tool-specific rendering */}
              {output && name === 'Read' && hasImageBlocks(output) && (
                <ImageOutputBlock output={output} />
              )}
              {shouldRenderOutputPanels &&
                output &&
                name === 'Read' &&
                !hasImageBlocks(output) &&
                outputText && (
                  <ReadOutputBlock
                    output={outputText}
                    filePath={String(input.file_path ?? input.path ?? '')}
                  />
                )}
              {shouldRenderOutputPanels &&
                name === 'Bash' &&
                (status === 'running' || outputText) && (
                  <BashOutputBlock
                    output={outputText ?? ''}
                    toolUseId={toolUseId}
                    status={status}
                  />
                )}
              {shouldRenderOutputPanels && output && name === 'Grep' && outputText && (
                <GrepOutputBlock output={outputText} pattern={String(input.pattern ?? '')} />
              )}
              {shouldRenderOutputPanels && output && name === 'Glob' && outputText && (
                <GlobOutputBlock output={outputText} />
              )}
              {shouldRenderOutputPanels && output && name === 'LS' && outputText && (
                <LSOutputBlock output={outputText} />
              )}
              {shouldRenderOutputPanels && output && name === 'TaskList' && outputText && (
                <TaskListOutputBlock output={outputText} />
              )}
              {shouldRenderOutputPanels &&
                output &&
                ['Edit', 'Write', 'Delete'].includes(name) &&
                (() => {
                  const s = outputText ?? ''
                  const parsed = decodeStructuredToolResult(s)
                  const success = !!(parsed && !Array.isArray(parsed) && parsed.success === true)
                  return (
                    <div className="flex items-center gap-1.5 text-xs">
                      {success ? (
                        <>
                          <CheckCircle2 className="size-3 text-green-500" />
                          <span className="text-green-500/70">
                            {t('toolCall.appliedSuccessfully')}
                          </span>
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
              {shouldRenderOutputPanels &&
                output &&
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
                  'AskUserQuestion',
                  'visualize_show_widget'
                ].includes(name) &&
                (hasImageBlocks(output) ? (
                  <ImageOutputBlock output={output} />
                ) : outputText ? (
                  <OutputBlock output={outputText} />
                ) : null)}
              {/* Error */}
              {displayError && (
                <div>
                  <p className="mb-1 text-xs font-medium text-destructive">{t('error.label')}</p>
                  <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs text-destructive font-mono">
                    {displayError}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
