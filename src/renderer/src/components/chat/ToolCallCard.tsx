import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Copy,
  Check,
  Square,
  FileCode,
  Search,
  FolderTree,
  Folder,
  File,
  Clock,
  Bot,
  FileText
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { toast } from 'sonner'
import { cn } from '@renderer/lib/utils'
import type { ToolCallStatus } from '@renderer/lib/agent/types'
import type { ToolResultContent } from '@renderer/lib/api/types'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import { MONO_FONT } from '@renderer/lib/constants'
import { estimateTokens, formatTokens } from '@renderer/lib/format-tokens'
import { writeSvgStringToClipboard } from '@renderer/lib/utils/image-clipboard'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { Button } from '@renderer/components/ui/button'
import { LazySyntaxHighlighter } from './LazySyntaxHighlighter'
import { inputSummary } from './tool-call-summary'
import { useChatActions } from '@renderer/hooks/use-chat-actions'
import { LocalTerminal } from '@renderer/components/terminal/LocalTerminal'

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

function getBashInputTerminalId(input: Record<string, unknown>): string | null {
  const terminalId = input.terminalId
  return typeof terminalId === 'string' && terminalId.trim() ? terminalId.trim() : null
}

function shallowEqualRecord(prev: Record<string, unknown>, next: Record<string, unknown>): boolean {
  if (prev === next) return true
  const prevKeys = Object.keys(prev)
  const nextKeys = Object.keys(next)
  if (prevKeys.length !== nextKeys.length) return false
  for (const key of prevKeys) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) return false
    if (!Object.is(prev[key], next[key])) return false
  }
  return true
}

function toolResultContentEqual(
  prev: ToolResultContent | undefined,
  next: ToolResultContent | undefined
): boolean {
  if (prev === next) return true
  if (prev === undefined || next === undefined) return false
  if (typeof prev === 'string' || typeof next === 'string') return prev === next
  if (prev.length !== next.length) return false
  for (let i = 0; i < prev.length; i++) {
    const prevBlock = prev[i]
    const nextBlock = next[i]
    if (prevBlock === nextBlock) continue
    if (prevBlock.type !== nextBlock.type) return false
    if (prevBlock.type === 'text' && nextBlock.type === 'text') {
      if (prevBlock.text !== nextBlock.text) return false
      continue
    }
    if (prevBlock.type === 'image' && nextBlock.type === 'image') {
      if (
        prevBlock.source.type !== nextBlock.source.type ||
        prevBlock.source.mediaType !== nextBlock.source.mediaType ||
        prevBlock.source.data !== nextBlock.source.data ||
        prevBlock.source.url !== nextBlock.source.url ||
        prevBlock.source.filePath !== nextBlock.source.filePath
      ) {
        return false
      }
      continue
    }
    return false
  }
  return true
}

function areToolCallCardPropsEqual(prev: ToolCallCardProps, next: ToolCallCardProps): boolean {
  return (
    prev.toolUseId === next.toolUseId &&
    prev.name === next.name &&
    prev.status === next.status &&
    prev.error === next.error &&
    prev.startedAt === next.startedAt &&
    prev.completedAt === next.completedAt &&
    shallowEqualRecord(prev.input, next.input) &&
    toolResultContentEqual(prev.output, next.output)
  )
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
              <span className="text-[9px] text-muted-foreground/55">{img.source.mediaType}</span>
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
  const widgetCode = rawCode.trimStart()
  const loadingMessages = Array.isArray(input.loading_messages)
    ? input.loading_messages
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    : []
  const explicitKind =
    input.widget_kind === 'svg' || input.widget_kind === 'html' ? input.widget_kind : null

  if (!title && !widgetCode.trim()) return null

  return {
    title: title || 'widget',
    loadingMessages: loadingMessages.length > 0 ? loadingMessages : DEFAULT_WIDGET_LOADING_MESSAGES,
    widgetCode,
    kind: explicitKind ?? (/^<svg[\s>]/i.test(widgetCode) ? 'svg' : 'html')
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
        background: transparent !important;
      }
      html {
        color-scheme: dark;
      }
      body {
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: #e5e7eb;
        overflow: hidden;
      }
      #open-cowork-widget-root {
        width: 100%;
        background: transparent !important;
      }
      ${payload.kind === 'svg' ? '#open-cowork-widget-root { display: block; overflow: hidden; line-height: 0; font-size: 0; } #open-cowork-widget-root > svg { display: block; width: 100%; height: auto; margin: 0; background: transparent !important; overflow: hidden; }' : ''}
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
        let lastAppliedCode = '';

        const executeInsertedScripts = (root) => {
          const scripts = Array.from(root.querySelectorAll('script'));
          for (const script of scripts) {
            const next = document.createElement('script');
            for (const attr of Array.from(script.attributes)) {
              next.setAttribute(attr.name, attr.value);
            }
            next.text = script.textContent || '';
            script.replaceWith(next);
          }
        };

        const applyWidgetCode = (code) => {
          if (typeof code !== 'string' || code === lastAppliedCode) return;
          lastAppliedCode = code;
          const root = document.getElementById('open-cowork-widget-root');
          if (!root) return;
          root.innerHTML = code;
          executeInsertedScripts(root);
          reportSize();
          window.requestAnimationFrame(reportSize);
          setTimeout(reportSize, 80);
          setTimeout(reportSize, 240);
        };

        window.sendPrompt = (text) => {
          if (typeof text !== 'string') return;
          const trimmed = text.trim();
          if (!trimmed) return;
          post('send_prompt', { text: trimmed });
        };

        window.addEventListener('message', (event) => {
          const data = event.data;
          if (!data || typeof data !== 'object') return;
          if (data.source !== bridgeSource || data.type !== 'update_code') return;
          applyWidgetCode(data.code);
        });

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
    <div id="open-cowork-widget-root"></div>
    <script>window.__openCoworkWidgetReady && window.__openCoworkWidgetReady();</script>
  </body>
</html>`
}

function SvgWidgetCopyButton({ svg }: { svg: string }): React.JSX.Element {
  const [copied, setCopied] = React.useState(false)
  const [copying, setCopying] = React.useState(false)
  const resetTimerRef = React.useRef<number | null>(null)

  React.useEffect(() => {
    return () => {
      if (resetTimerRef.current != null) {
        window.clearTimeout(resetTimerRef.current)
      }
    }
  }, [])

  const handleCopy = React.useCallback(async (): Promise<void> => {
    if (copying || !svg.trim()) return

    try {
      setCopying(true)
      await writeSvgStringToClipboard(svg)
      setCopied(true)
      toast.success('Image copied to clipboard')

      if (resetTimerRef.current != null) {
        window.clearTimeout(resetTimerRef.current)
      }
      resetTimerRef.current = window.setTimeout(() => {
        setCopied(false)
        resetTimerRef.current = null
      }, 1500)
    } catch (error) {
      console.error('[Widget] Copy SVG image failed:', error)
      toast.error('Failed to copy image')
    } finally {
      setCopying(false)
    }
  }, [copying, svg])

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="absolute right-2 top-2 z-20 size-8 border border-border/60 bg-background/85 text-muted-foreground shadow-sm backdrop-blur hover:bg-background hover:text-foreground disabled:opacity-60"
      onClick={() => void handleCopy()}
      disabled={copying || !svg.trim()}
      title={copied ? 'Copied' : 'Copy image to clipboard'}
      aria-label={copied ? 'Copied' : 'Copy image to clipboard'}
    >
      {copied ? <Check className="size-3.5 text-green-500" /> : <Copy className="size-3.5" />}
    </Button>
  )
}

export function WidgetOutputBlock({
  input,
  status
}: {
  input: Record<string, unknown>
  status: ToolCallStatus | 'completed'
}): React.JSX.Element | null {
  const isExecuting = status === 'streaming' || status === 'running'
  const payload = normalizeWidgetPayload(input)
  const hasPayload = Boolean(payload)
  const loadingMessages = payload?.loadingMessages ?? DEFAULT_WIDGET_LOADING_MESSAGES
  const iframeRef = React.useRef<HTMLIFrameElement>(null)
  const resizeRafRef = React.useRef<number | null>(null)
  const lastAppliedHeightRef = React.useRef<number>(0)
  const [loaded, setLoaded] = React.useState(false)
  const [frameHeight, setFrameHeight] = React.useState(240)
  const [loadingIndex, setLoadingIndex] = React.useState(0)
  const frameKey = payload ? `${payload.title}:${payload.kind}` : 'widget-empty'
  const pendingWidgetCodeRef = React.useRef('')
  const lastPostedWidgetCodeRef = React.useRef('')
  const { sendMessage } = useChatActions()

  const postWidgetCode = React.useCallback((code: string): void => {
    const frameWindow = iframeRef.current?.contentWindow
    if (!frameWindow || !code || code === lastPostedWidgetCodeRef.current) return
    lastPostedWidgetCodeRef.current = code
    frameWindow.postMessage(
      {
        source: WIDGET_BRIDGE_SOURCE,
        type: 'update_code',
        code
      },
      '*'
    )
  }, [])

  React.useEffect(() => {
    setLoaded(false)
    setLoadingIndex(0)
    setFrameHeight(payload?.kind === 'svg' ? 320 : 420)
    lastPostedWidgetCodeRef.current = ''
  }, [payload?.title, payload?.kind])

  React.useEffect(() => {
    pendingWidgetCodeRef.current = payload?.widgetCode ?? ''
    if (loaded && payload?.widgetCode) {
      postWidgetCode(payload.widgetCode)
    }
  }, [loaded, payload?.widgetCode, postWidgetCode])

  React.useEffect(() => {
    if (!hasPayload || loadingMessages.length <= 1 || loaded) return
    const timer = window.setInterval(() => {
      setLoadingIndex((index) => (index + 1) % loadingMessages.length)
    }, 1400)
    return () => window.clearInterval(timer)
  }, [hasPayload, loaded, loadingMessages.length])

  React.useEffect(() => {
    const handleMessage = (event: MessageEvent): void => {
      if (event.source !== iframeRef.current?.contentWindow) return
      const data = event.data
      if (!data || typeof data !== 'object') return
      if ((data as { source?: unknown }).source !== WIDGET_BRIDGE_SOURCE) return

      const type = (data as { type?: unknown }).type
      if (type === 'ready') {
        setLoaded(true)
        postWidgetCode(pendingWidgetCodeRef.current)
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
  }, [postWidgetCode, sendMessage])

  if (isExecuting && !payload?.widgetCode) {
    const title =
      typeof input.title === 'string' && input.title.trim() ? input.title.trim() : 'widget'
    const chars =
      typeof input.widget_code_chars === 'number'
        ? input.widget_code_chars
        : typeof input.widget_code === 'string'
          ? input.widget_code.length
          : null
    return (
      <div className="my-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <div className="font-medium text-foreground/75">{title}</div>
        <div className="mt-0.5 text-[11px]">
          Rendering widget{chars !== null ? ` (${chars} chars)` : ''}...
        </div>
      </div>
    )
  }

  if (!payload) return null

  const isPending = isExecuting && !loaded && !payload.widgetCode
  const loadingMessage = loadingMessages[loadingIndex] ?? DEFAULT_WIDGET_LOADING_MESSAGES[0]

  return (
    <div className="my-2 space-y-2">
      <div
        className="relative overflow-hidden rounded-xl bg-transparent shadow-sm"
        style={{ width: '100%', border: 'none', backgroundColor: 'transparent' }}
      >
        {payload.widgetCode ? (
          <div
            className="w-full overflow-hidden bg-transparent leading-none"
            style={{ lineHeight: 0, fontSize: 0 }}
          >
            <iframe
              key={frameKey}
              ref={iframeRef}
              title={payload.title}
              sandbox="allow-scripts allow-forms"
              srcDoc={buildWidgetDocument(payload)}
              className="block border-0 bg-transparent transition-[height] duration-200"
              style={{
                width: 'calc(100% + 1px)',
                height: `${frameHeight}px`,
                marginRight: '-1px',
                verticalAlign: 'top',
                backgroundColor: 'transparent',
                colorScheme: 'dark'
              }}
            />
            {payload.kind === 'svg' ? <SvgWidgetCopyButton svg={payload.widgetCode} /> : null}
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
        <FileCode className="size-3 text-blue-500 dark:text-blue-400" />
        <span
          className="cursor-pointer truncate text-xs font-medium text-sky-600 transition-colors hover:text-sky-700 dark:text-muted-foreground dark:hover:text-blue-400"
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
        <span className="text-[9px] text-muted-foreground/55 font-mono">
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
  totalMs?: number
  spawnMs?: number
  firstChunkMs?: number
  shell?: string
  executionEngine?: 'main' | 'sidecar'
  timedOut?: boolean
  aborted?: boolean
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
    <section
      className={cn(
        'overflow-hidden rounded-lg border',
        tone === 'error'
          ? 'border-destructive/20 bg-destructive/[0.035]'
          : 'border-border/70 bg-zinc-50/80 dark:bg-background/70'
      )}
    >
      <div
        className={cn(
          'flex items-center justify-between gap-2 border-b px-3 py-1.5',
          tone === 'error'
            ? 'border-destructive/15 bg-destructive/[0.04]'
            : 'border-border/60 bg-zinc-100/70 dark:bg-muted/30'
        )}
      >
        <span
          className={cn(
            'text-[10px] font-medium uppercase tracking-[0.12em]',
            tone === 'error' ? 'text-destructive/80' : 'text-muted-foreground/80'
          )}
        >
          {title}
        </span>
        <span className="text-[10px] tabular-nums text-muted-foreground/60">
          {lineCount(text)} lines
        </span>
      </div>
      <pre
        className={cn(
          'max-h-56 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 text-[11px] leading-5 antialiased',
          tone === 'error' ? 'text-destructive/90' : 'text-foreground/88'
        )}
        style={{ fontFamily: MONO_FONT }}
      >
        {displayed}
      </pre>
    </section>
  )
}

function BashOutputBlock({
  output,
  input,
  toolUseId,
  status
}: {
  output: string
  input: Record<string, unknown>
  toolUseId?: string
  status: ToolCallStatus | 'completed'
}): React.JSX.Element {
  const { t } = useTranslation('chat')
  const openDetailPanel = useUIStore((s) => s.openDetailPanel)
  const sendBackgroundProcessInput = useAgentStore((s) => s.sendBackgroundProcessInput)
  const stopBackgroundProcess = useAgentStore((s) => s.stopBackgroundProcess)
  const abortForegroundShellExec = useAgentStore((s) => s.abortForegroundShellExec)
  const hasForegroundExec = useAgentStore((s) =>
    toolUseId ? Boolean(s.foregroundShellExecByToolUseId[toolUseId]) : false
  )

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
        terminalId?: string
        summary?: ShellOutputSummary
      }
    }
    return null
  }, [output])

  const processId = parsed?.processId ? String(parsed.processId) : null
  const process = useAgentStore((s) => (processId ? s.backgroundProcesses[processId] : undefined))
  const inputTerminalId = React.useMemo(() => getBashInputTerminalId(input), [input])
  const terminalId = process?.terminalId ?? parsed?.terminalId ?? inputTerminalId ?? null
  const isProcessRunning = process?.status === 'running'
  const exitCode = process?.exitCode ?? parsed?.exitCode
  const statusText = process ? t(`toolCall.processStatus.${process.status}`) : null
  const canStopForegroundExec = !process && status === 'running' && !!toolUseId && hasForegroundExec

  const stdoutText = process ? process.output : (parsed?.stdout ?? parsed?.output ?? '')
  const stderrText = process ? '' : (parsed?.stderr ?? '')
  const text = process ? process.output : [stderrText, stdoutText].filter(Boolean).join('\n\n')
  const lineCount = text ? text.split('\n').length : 0
  const tokenCount = React.useMemo(() => estimateTokens(text), [text])
  const showTerminal = Boolean(terminalId)

  return (
    <div className="space-y-2">
      <div className="activity-card-shell overflow-hidden rounded-xl border border-border/60 bg-zinc-50/80 shadow-none dark:bg-background/60">
        <div className="activity-card-header flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium text-foreground">{t('toolCall.shell')}</span>
            {processId ? (
              <span className="rounded-md border border-border/60 bg-muted/60 px-1.5 py-0.5 text-[9px] text-muted-foreground">
                {processId}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-1.5">
            {!showTerminal ? <CopyBtn text={text} /> : null}
          </div>
        </div>

        {showTerminal ? (
          <div className="border-b border-border/60 bg-black/90">
            <div className="h-[320px] min-h-[220px] w-full">
              <LocalTerminal terminalId={terminalId ?? ''} readOnly={!isProcessRunning} />
            </div>
          </div>
        ) : (
          <div
            className="activity-card-divider border-b border-border/60 px-3 py-2.5 text-[11px]"
            style={{ fontFamily: MONO_FONT }}
          >
            {text ? (
              stderrText ? (
                <div className="space-y-3">
                  <ShellTextPane title="stderr" text={stderrText} expanded tone="error" />
                  <ShellTextPane
                    title={stderrText ? 'stdout' : 'output'}
                    text={stdoutText}
                    expanded
                  />
                </div>
              ) : (
                <pre className="whitespace-pre-wrap break-words leading-5 text-foreground/88">
                  {text}
                </pre>
              )
            ) : (
              <pre className="whitespace-pre-wrap break-words text-muted-foreground">
                {t('toolCall.noOutputYet')}
              </pre>
            )}
          </div>
        )}

        {(statusText || exitCode !== undefined || lineCount > 0) && (
          <div className="activity-card-divider flex items-center justify-between gap-2 px-3 py-2">
            <span className="text-[10px] text-muted-foreground">
              {lineCount} lines · {formatTokens(tokenCount)} tokens
            </span>
            <div className="flex items-center gap-2 text-[11px]">
              {statusText && exitCode === undefined ? (
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5',
                    process?.status === 'running'
                      ? 'bg-blue-500/12 text-blue-600 dark:text-blue-300'
                      : process?.status === 'error'
                        ? 'bg-destructive/10 text-destructive'
                        : 'bg-muted text-muted-foreground'
                  )}
                >
                  {statusText}
                </span>
              ) : null}
              {exitCode !== undefined ? (
                exitCode === 0 ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-0.5 text-emerald-600 dark:text-emerald-300">
                    <Check className="size-3" />
                    {t('toolCall.success')}
                  </span>
                ) : (
                  <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">
                    {t('toolCall.exitCode', { code: exitCode })}
                  </span>
                )
              ) : null}
            </div>
          </div>
        )}
      </div>

      {process ? (
        <div className="mt-2 flex items-center gap-1.5">
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
      ) : null}

      {canStopForegroundExec ? (
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
      ) : null}
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
          <span
            key={i}
            className="rounded-sm bg-amber-200/70 px-px text-amber-900 dark:bg-amber-500/25 dark:text-amber-200"
          >
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  )
}

type SearchOutputMeta = {
  engine?: string
  truncated: boolean
  timedOut: boolean
  limitReason?: string | null
  warnings: string[]
  error?: string
}

type SearchVisualState = 'found' | 'empty' | 'warning' | 'error'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeSearchMeta(decoded: unknown): SearchOutputMeta {
  if (!isRecord(decoded)) {
    return { truncated: false, timedOut: false, warnings: [] }
  }
  const rawMeta = isRecord(decoded.meta) ? decoded.meta : null
  const rawEngine = decoded.engine ?? rawMeta?.engine
  return {
    engine: typeof rawEngine === 'string' ? rawEngine : undefined,
    truncated: decoded.truncated === true,
    timedOut: decoded.timedOut === true,
    limitReason: typeof decoded.limitReason === 'string' ? decoded.limitReason : null,
    warnings: Array.isArray(decoded.warnings)
      ? decoded.warnings.filter(
          (item): item is string => typeof item === 'string' && item.length > 0
        )
      : [],
    error: typeof decoded.error === 'string' ? decoded.error : undefined
  }
}

function formatSearchEngineLabel(engine: string | undefined): string | null {
  if (!engine) return null
  if (engine === 'git_grep') return 'git grep'
  if (engine === 'ripgrep') return 'ripgrep'
  if (engine === 'sidecar') return 'sidecar'
  if (engine === 'node' || engine === 'node_fallback') return 'Node fallback'
  if (engine === 'remote_rg') return 'remote rg'
  if (engine === 'remote_grep') return 'remote grep'
  return engine
}

type ParsedGrepEntry = {
  file: string
  line?: number
  column?: number
  text: string
  kind?: 'match' | 'context'
  count?: number
}

function parseLegacyGrepMatch(value: unknown): ParsedGrepEntry | null {
  if (typeof value !== 'string') return null
  const match = value.match(/^(.+?)([:-])(\d+)\2(?:(\d+)\2)?(.*)$/)
  if (!match) return null
  return {
    file: match[1],
    line: Number(match[3]),
    column: match[4] ? Number(match[4]) : undefined,
    text: match[5] ?? '',
    kind: match[2] === '-' ? 'context' : 'match'
  }
}

function parseGrepTextMatches(text: string): ParsedGrepEntry[] {
  return text
    .split(/\r?\n/)
    .map((line) => parseLegacyGrepMatch(line))
    .filter((item): item is ParsedGrepEntry => !!item)
}

function getSearchVisualState(meta: SearchOutputMeta, matchCount: number): SearchVisualState {
  if (meta.error) return 'error'
  if (meta.truncated || meta.timedOut || meta.warnings.length > 0) return 'warning'
  if (matchCount > 0) return 'found'
  return 'empty'
}

function SearchStateBadge({ state }: { state: SearchVisualState }): React.JSX.Element {
  const { t } = useTranslation('chat')
  const config =
    state === 'error'
      ? {
          label: t('toolCall.searchState.error'),
          className: 'border-destructive/30 bg-destructive/10 text-destructive'
        }
      : state === 'warning'
        ? {
            label: t('toolCall.searchState.warning'),
            className: 'border-amber-400/30 bg-amber-400/10 text-amber-500'
          }
        : state === 'found'
          ? {
              label: t('toolCall.searchState.found'),
              className: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-500'
            }
          : {
              label: t('toolCall.searchState.noMatches'),
              className: 'border-muted-foreground/20 bg-muted/40 text-muted-foreground'
            }

  return (
    <span
      className={cn('rounded-full border px-1.5 py-0.5 text-[9px] font-medium', config.className)}
    >
      {config.label}
    </span>
  )
}

function SearchEmptyState(): React.JSX.Element {
  const { t } = useTranslation('chat')
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
      {t('toolCall.searchState.noMatches')}
    </div>
  )
}

function parseGrepOutput(output: string): {
  matches: ParsedGrepEntry[]
  meta: SearchOutputMeta
  output?: string
} | null {
  const decoded = decodeStructuredToolResult(output)
  if (!decoded) {
    const matches = parseGrepTextMatches(output)
    if (matches.length === 0 && output.trim().length === 0) return null
    return {
      matches,
      meta: { truncated: false, timedOut: false, warnings: [] },
      output
    }
  }

  if (Array.isArray(decoded)) {
    return {
      matches: decoded
        .map((item) => {
          const legacyMatch = parseLegacyGrepMatch(item)
          if (legacyMatch) return legacyMatch
          if (!isRecord(item)) return null
          const file =
            typeof item.file === 'string'
              ? item.file
              : typeof item.path === 'string'
                ? item.path
                : null
          const line = typeof item.line === 'number' ? item.line : null
          const column = typeof item.column === 'number' ? item.column : undefined
          const text = typeof item.text === 'string' ? item.text : ''
          const count = typeof item.count === 'number' ? item.count : undefined
          if (!file) return null
          if (line == null && count === undefined) return { file, text }
          return { file, line: line ?? undefined, column, text, count }
        })
        .filter((item): item is ParsedGrepEntry => !!item),
      meta: { truncated: false, timedOut: false, warnings: [] }
    }
  }

  if (!isRecord(decoded)) return null
  const rawOutput = typeof decoded.output === 'string' ? decoded.output : undefined
  const matchesSource = Array.isArray(decoded.matches)
    ? decoded.matches
    : Array.isArray(decoded.results)
      ? decoded.results
      : []

  const parsedMatches = matchesSource
    .map((item) => {
      const legacyMatch = parseLegacyGrepMatch(item)
      if (legacyMatch) return legacyMatch
      if (!isRecord(item)) return null
      const file =
        typeof item.file === 'string' ? item.file : typeof item.path === 'string' ? item.path : null
      const line = typeof item.line === 'number' ? item.line : null
      const column = typeof item.column === 'number' ? item.column : undefined
      const text = typeof item.text === 'string' ? item.text : ''
      const count = typeof item.count === 'number' ? item.count : undefined
      if (!file) return null
      if (line == null && count === undefined) {
        return {
          file,
          text,
          kind: item.kind === 'context' ? 'context' : 'match'
        }
      }
      return {
        file,
        line: line ?? undefined,
        column,
        text,
        count,
        kind: item.kind === 'context' ? 'context' : 'match'
      }
    })
    .filter((item): item is ParsedGrepEntry => !!item)
  const outputMatches =
    parsedMatches.length === 0 && rawOutput ? parseGrepTextMatches(rawOutput) : []

  return {
    matches: parsedMatches.length > 0 ? parsedMatches : outputMatches,
    meta: normalizeSearchMeta(decoded),
    output: rawOutput
  }
}

function parseGlobOutput(output: string): { matches: string[]; meta: SearchOutputMeta } | null {
  const decoded = decodeStructuredToolResult(output)
  if (!decoded) return null

  if (Array.isArray(decoded)) {
    return {
      matches: decoded.filter((item): item is string => typeof item === 'string'),
      meta: { truncated: false, timedOut: false, warnings: [] }
    }
  }

  if (!isRecord(decoded)) return null
  const matchesSource = Array.isArray(decoded.matches)
    ? decoded.matches
    : Array.isArray(decoded.results)
      ? decoded.results
      : []

  return {
    matches: matchesSource
      .map((item) => {
        if (typeof item === 'string') return item
        if (isRecord(item) && typeof item.path === 'string') return item.path
        return null
      })
      .filter((item): item is string => !!item),
    meta: normalizeSearchMeta(decoded)
  }
}

function SearchMetaHint({ meta }: { meta: SearchOutputMeta }): React.JSX.Element | null {
  const { t } = useTranslation('chat')
  const notes = [
    meta.error,
    meta.truncated
      ? t('toolCall.searchState.truncated', {
          reason: meta.limitReason ? `: ${meta.limitReason}` : ''
        })
      : null,
    meta.timedOut ? t('toolCall.searchState.timedOut') : null,
    ...meta.warnings
  ].filter((item): item is string => typeof item === 'string' && item.length > 0)

  if (notes.length === 0) return null

  return (
    <div className="mt-1 text-[10px] text-amber-600/80 dark:text-amber-400/80">
      {notes.join(' · ')}
    </div>
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
  const parsed = React.useMemo(() => parseGrepOutput(output), [output])

  // Group by file - must be called before early return to maintain hook order
  const groups = React.useMemo(() => {
    if (!parsed) return []
    const map = new Map<
      string,
      Array<{ line?: number; column?: number; text: string; count?: number }>
    >()
    for (const r of parsed.matches) {
      const list = map.get(r.file) ?? []
      list.push({ line: r.line, column: r.column, text: r.text, count: r.count })
      map.set(r.file, list)
    }
    return Array.from(map.entries())
  }, [parsed])

  if (!parsed) return <OutputBlock output={output} />
  if (parsed.matches.length === 0 && parsed.meta.error) return <OutputBlock output={output} />
  if (parsed.matches.length === 0 && parsed.output?.trim()) {
    return <OutputBlock output={parsed.output} />
  }

  const matchCount = parsed.matches.length
  const visualState = getSearchVisualState(parsed.meta, matchCount)
  const engineLabel = formatSearchEngineLabel(parsed.meta.engine)
  const copyText = output

  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <Search className="size-3 text-amber-500 dark:text-amber-400" />
        <p className="text-xs font-medium text-muted-foreground">{t('toolCall.grepResults')}</p>
        <SearchStateBadge state={visualState} />
        {engineLabel && (
          <span className="rounded border border-border/70 bg-muted/40 px-1.5 py-0.5 text-[9px] text-muted-foreground">
            {engineLabel}
          </span>
        )}
        {pattern && (
          <span className="text-[9px] font-mono text-amber-600/70 dark:text-amber-400/50">
            /{pattern}/
          </span>
        )}
        <span className="text-[9px] text-muted-foreground/55">
          {t('toolCall.matchesInFiles', { matches: matchCount, files: groups.length })}
        </span>
        <CopyBtn text={copyText} />
      </div>
      <SearchMetaHint meta={parsed.meta} />
      {groups.length === 0 ? (
        <SearchEmptyState />
      ) : (
        <div
          className="max-h-72 overflow-auto rounded-md border border-border/70 bg-zinc-50 text-[11px] font-mono divide-y divide-border/70 dark:bg-zinc-950 dark:divide-zinc-800"
          style={{ fontFamily: MONO_FONT }}
        >
          {groups.map(([file, matches]) => (
            <div key={file} className="px-2 py-1.5">
              <div
                className="text-sky-600 truncate mb-0.5 cursor-pointer hover:text-sky-700 transition-colors dark:text-blue-400/70 dark:hover:text-blue-300"
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
                  <span className="w-12 shrink-0 select-none text-right text-muted-foreground/70 dark:text-zinc-600">
                    {typeof m.count === 'number'
                      ? m.count
                      : typeof m.line === 'number'
                        ? m.column
                          ? `${m.line}:${m.column}`
                          : m.line
                        : ''}
                  </span>
                  <span className="truncate">
                    {m.text ? <HighlightText text={m.text} pattern={pattern} /> : null}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function GlobOutputBlock({ output }: { output: string }): React.JSX.Element {
  const { t } = useTranslation('chat')
  const maxVisibleItems = 200
  const parsed = React.useMemo(() => parseGlobOutput(output), [output])
  if (!parsed) return <OutputBlock output={output} />
  if (parsed.matches.length === 0 && parsed.meta.error) return <OutputBlock output={output} />
  const visibleItems = parsed.matches.slice(0, maxVisibleItems)
  const hiddenCount = Math.max(0, parsed.matches.length - visibleItems.length)
  const visualState = getSearchVisualState(parsed.meta, parsed.matches.length)

  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400">
          {t('Glob')}
        </span>
        <SearchStateBadge state={visualState} />
        <span className="text-[9px] text-muted-foreground">
          {t('toolCall.pathCount', { count: parsed.matches.length })}
        </span>
        <CopyBtn text={parsed.matches.join('\n')} />
      </div>
      <SearchMetaHint meta={parsed.meta} />
      {visibleItems.length === 0 ? (
        <SearchEmptyState />
      ) : (
        <div
          className="max-h-48 space-y-0.5 overflow-auto rounded-xl border border-border/70 bg-zinc-50 px-3 py-2 text-[11px] font-mono text-zinc-700 dark:border-white/[0.06] dark:bg-[#111214] dark:text-zinc-400"
          style={{ fontFamily: MONO_FONT }}
        >
          {visibleItems.map((p, i) => (
            <div
              key={i}
              className="truncate cursor-pointer text-sky-600 transition-colors hover:text-sky-700 dark:text-sky-300 dark:hover:text-sky-200"
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
            <div className="pt-1 text-[10px] text-muted-foreground">
              {t('toolCall.moreResultsHidden', { shown: visibleItems.length, hidden: hiddenCount })}
            </div>
          )}
        </div>
      )}
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
        <FolderTree className="size-3 text-amber-500 dark:text-amber-400" />
        <p className="text-xs font-medium text-muted-foreground">
          {t('toolCall.directoryListing')}
        </p>
        <span className="text-[9px] text-muted-foreground/55">
          {t('toolCall.foldersAndFiles', { folders: dirs.length, files: files.length })}
        </span>
        <CopyBtn text={parsed.map((e) => e.name).join('\n')} />
      </div>
      <div
        className="max-h-48 overflow-auto rounded-md border border-border/70 bg-zinc-50 px-3 py-2 text-[11px] font-mono space-y-0.5 dark:bg-zinc-950"
        style={{ fontFamily: MONO_FONT }}
      >
        {dirs.map((e) => (
          <div
            key={e.name}
            className="flex items-center gap-1.5 text-amber-600/80 dark:text-amber-400/70"
          >
            <Folder className="size-3 shrink-0" />
            <span>{e.name}/</span>
          </div>
        ))}
        {files.map((e) => (
          <div
            key={e.name}
            className="flex cursor-pointer items-center gap-1.5 text-foreground/70 transition-colors hover:text-sky-600 dark:text-zinc-400 dark:hover:text-blue-400"
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
  tone = 'default',
  truncated
}: {
  label: string
  value: string
  tone?: 'default' | 'old' | 'new'
  truncated?: boolean
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
        <span className="text-muted-foreground/55">{lineCount(value)} lines</span>
        <span className="text-muted-foreground/55">{value.length} chars</span>
        {truncated && (
          <span className="rounded bg-muted px-1 py-0.5 text-[9px] normal-case text-muted-foreground/60">
            preview
          </span>
        )}
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

function getNumericInputValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function getSubmitReportText(input: Record<string, unknown>): {
  text: string
  fullText: string
  chars: number
  lines: number
  truncated: boolean
} {
  const fullText =
    typeof input.report === 'string'
      ? input.report
      : typeof input.preview === 'string'
        ? input.preview
        : ''
  const previewText =
    typeof input.report_preview === 'string'
      ? input.report_preview
      : typeof input.preview === 'string'
        ? input.preview
        : fullText
  const text = previewText || fullText
  const chars = getNumericInputValue(input.report_chars) ?? (fullText.length || text.length)
  const lines = getNumericInputValue(input.report_lines) ?? (text ? lineCount(text) : 0)
  const truncated =
    input.report_truncated === true ||
    input._truncated === true ||
    (typeof input.report_preview === 'string' && typeof input.report !== 'string')

  return { text, fullText, chars, lines, truncated }
}

function extractReportHeadings(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.match(/^#{1,6}\s+(.+?)\s*$/)?.[1]?.trim())
    .filter((line): line is string => !!line)
    .slice(0, 4)
}

function SubmitReportPreviewLine({ line }: { line: string }): React.JSX.Element | null {
  const trimmed = line.trim()
  if (!trimmed) return <div className="h-2" />

  const heading = trimmed.match(/^#{1,6}\s+(.+)/)?.[1]?.trim()
  if (heading) {
    return (
      <div className="mt-2 flex items-center gap-2 first:mt-0">
        <span className="h-4 w-1 rounded-full bg-violet-400/70" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-foreground/90">
          {heading}
        </span>
      </div>
    )
  }

  const bullet = trimmed.match(/^[-*]\s+(.+)/)?.[1]?.trim()
  if (bullet) {
    return (
      <div className="flex gap-2 text-[11px] leading-5 text-foreground/78">
        <span className="mt-2 size-1.5 shrink-0 rounded-full bg-emerald-400/70" />
        <span className="min-w-0 break-words">{bullet}</span>
      </div>
    )
  }

  return (
    <p className="whitespace-pre-wrap break-words text-[11px] leading-5 text-foreground/78">
      {line}
    </p>
  )
}

function SubmitReportInputBlock({
  input,
  status
}: {
  input: Record<string, unknown>
  status?: ToolCallCardProps['status']
}): React.JSX.Element {
  const report = getSubmitReportText(input)
  const isLive = status === 'streaming' || status === 'running'
  const isComplete = status === 'completed'
  const headings = extractReportHeadings(report.text)
  const visibleLines = report.text.split('\n').slice(0, 18)
  const density = Math.min(1, Math.max(0.08, report.chars / 6000))
  const blockCount =
    headings.length ||
    report.text
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .filter(Boolean).length
  const copyText = report.fullText || report.text

  return (
    <div className="overflow-hidden rounded-xl border border-violet-500/20 bg-violet-500/[0.04]">
      <div className="border-b border-violet-500/15 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-lg border border-violet-400/25 bg-violet-400/10 text-violet-300">
            <FileText className="size-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-semibold text-foreground/90">
                {isComplete ? 'Report submitted' : 'Submitting report'}
              </span>
              {isLive ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-violet-400/25 bg-violet-400/10 px-1.5 py-0.5 text-[9px] text-violet-200">
                  <span className="size-1.5 rounded-full bg-violet-300 animate-pulse" />
                  live
                </span>
              ) : null}
              {report.truncated ? (
                <span className="rounded-full border border-border/60 bg-background/60 px-1.5 py-0.5 text-[9px] text-muted-foreground/70">
                  preview
                </span>
              ) : null}
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-background/70">
              <div
                className="h-full rounded-full bg-violet-400/80 transition-[width] duration-300"
                style={{ width: `${Math.round(density * 100)}%` }}
              />
            </div>
          </div>
          {copyText ? <CopyBtn text={copyText} title="Copy report" /> : null}
        </div>

        <div className="mt-2 grid grid-cols-3 gap-1.5">
          {[
            ['chars', report.chars.toLocaleString()],
            ['lines', report.lines.toLocaleString()],
            ['blocks', blockCount.toLocaleString()]
          ].map(([label, value]) => (
            <div
              key={label}
              className="rounded-md border border-border/50 bg-background/55 px-2 py-1.5"
            >
              <div className="text-[9px] uppercase tracking-wide text-muted-foreground/55">
                {label}
              </div>
              <div className="mt-0.5 text-[12px] font-semibold tabular-nums text-foreground/85">
                {value}
              </div>
            </div>
          ))}
        </div>

        {headings.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {headings.map((heading) => (
              <span
                key={heading}
                className="max-w-[180px] truncate rounded-full border border-violet-400/20 bg-violet-400/10 px-2 py-0.5 text-[10px] text-violet-200/90"
              >
                {heading}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="max-h-72 overflow-auto px-3 py-2.5">
        {report.text ? (
          <div className="space-y-1">
            {visibleLines.map((line, index) => (
              <SubmitReportPreviewLine key={`${index}:${line.slice(0, 16)}`} line={line} />
            ))}
            {(report.truncated || report.text.split('\n').length > visibleLines.length) && (
              <div className="pt-1 text-[10px] text-muted-foreground/60">
                Preview continues as the report streams in...
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground/65">
            <span className="size-1.5 rounded-full bg-violet-300 animate-pulse" />
            Waiting for report text...
          </div>
        )}
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

const STRUCTURED_INPUT_VALUE_CHARS = 300
const STRUCTURED_INPUT_OBJECT_KEY_LIMIT = 12
const STRUCTURED_INPUT_ARRAY_ITEM_LIMIT = 6

function formatPrimitiveInputValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 80 ? `${value.slice(0, 80)}...` : value
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    value === null
  ) {
    return String(value)
  }
  return value === undefined ? 'undefined' : typeof value
}

function formatStructuredInputValue(value: unknown): { text: string; mono: boolean } {
  if (typeof value === 'string') {
    const text =
      value.length > STRUCTURED_INPUT_VALUE_CHARS
        ? `${value.slice(0, STRUCTURED_INPUT_VALUE_CHARS)}... (${value.length} chars)`
        : value
    return { text, mono: false }
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    value === null
  ) {
    return { text: String(value), mono: true }
  }

  if (Array.isArray(value)) {
    const preview = value.slice(0, STRUCTURED_INPUT_ARRAY_ITEM_LIMIT).map(formatPrimitiveInputValue)
    const suffix = value.length > STRUCTURED_INPUT_ARRAY_ITEM_LIMIT ? ', ...' : ''
    return {
      text: preview.length > 0 ? `[${preview.join(', ')}${suffix}] (${value.length} items)` : '[]',
      mono: true
    }
  }

  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    const visibleKeys = keys.slice(0, STRUCTURED_INPUT_OBJECT_KEY_LIMIT)
    const suffix = keys.length > STRUCTURED_INPUT_OBJECT_KEY_LIMIT ? ', ...' : ''
    return {
      text:
        visibleKeys.length > 0
          ? `{ ${visibleKeys.join(', ')}${suffix} } (${keys.length} keys)`
          : '{}',
      mono: true
    }
  }

  return { text: String(value), mono: true }
}

/** Render tool input as structured UI instead of raw JSON */
function StructuredInput({
  name,
  input,
  status
}: {
  name: string
  input: Record<string, unknown>
  status?: ToolCallCardProps['status']
}): React.JSX.Element {
  const { t } = useTranslation('chat')

  // Bash: command in terminal-style block + description/timeout as fields
  if (name === 'Bash') {
    const command = String(input.command ?? '')
    const description = input.description ? String(input.description) : null
    const timeout = input.timeout ? String(input.timeout) : null
    return (
      <div className="space-y-0.5">
        <div className="flex items-start gap-1.5 text-xs">
          <span className="shrink-0 select-none pt-0.5 font-mono text-[11px] text-zinc-500">$</span>
          <span
            className="break-all font-mono text-[11px] text-sky-600 dark:text-sky-300"
            style={{ fontFamily: MONO_FONT }}
          >
            {command}
          </span>
        </div>
        {(description || timeout) && (
          <div className="flex flex-wrap items-center gap-2 pl-[18px]">
            {description && <p className="text-[10px] text-muted-foreground/60">{description}</p>}
            {timeout && (
              <span className="text-[10px] text-muted-foreground/55">timeout: {timeout}ms</span>
            )}
          </div>
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
              <span className="text-[10px] text-muted-foreground/55">offset: {offset}</span>
            )}
            {limit && <span className="text-[10px] text-muted-foreground/55">limit: {limit}</span>}
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
    const oldTruncated = !oldStr && !!oldPreview
    const newTruncated = !newStr && !!newPreview
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
            <FileCode className="size-3 text-amber-500 dark:text-amber-400" />
            <span className="font-mono text-[11px] break-all" style={{ fontFamily: MONO_FONT }}>
              {filePath}
            </span>
            {replaceAll && (
              <span className="rounded bg-amber-500/10 px-1 py-0.5 text-[9px] text-amber-600/80 dark:text-amber-400/80">
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
          <div className="pl-[18px] text-[10px] text-muted-foreground/55">
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
            {visibleOld && (
              <EditPayloadPane
                label="old_string"
                value={visibleOld}
                tone="old"
                truncated={oldTruncated}
              />
            )}
            {visibleNew && (
              <EditPayloadPane
                label="new_string"
                value={visibleNew}
                tone="new"
                truncated={newTruncated}
              />
            )}
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
              <FileCode className="size-3 text-emerald-500 dark:text-green-400" />
              <span className="font-mono text-[11px] break-all" style={{ fontFamily: MONO_FONT }}>
                {filePath}
              </span>
            </div>
          )}
          {(lineTotal !== null || charTotal !== null) && (
            <div className="pl-[18px] text-[10px] text-muted-foreground/55">
              {lineTotal !== null ? `${lineTotal} lines` : ''}
              {lineTotal !== null && charTotal !== null ? ' · ' : ''}
              {charTotal !== null ? `${charTotal} chars` : ''}
            </div>
          )}
          {visiblePreview && (
            <pre
              className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-zinc-50 px-2.5 py-2 text-[11px] text-foreground/80 dark:bg-zinc-950 dark:text-zinc-300/80"
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

  if (name === 'SubmitReport') {
    return <SubmitReportInputBlock input={input} status={status} />
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
          className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-zinc-50 px-2.5 py-2 text-[11px] text-foreground/80 dark:bg-zinc-950 dark:text-zinc-300/80"
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
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="shrink-0 text-[10px] font-medium text-zinc-500 dark:text-zinc-400">
            {t('Glob')}
          </span>
          <span
            className="font-mono text-[11px] text-sky-600 dark:text-sky-300"
            style={{ fontFamily: MONO_FONT }}
          >
            {pattern}
          </span>
        </div>
        {path && (
          <div>
            <span className="text-[10px] text-zinc-500 font-mono" style={{ fontFamily: MONO_FONT }}>
              {path}
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
          <Search className="size-3 text-amber-500 dark:text-amber-400" />
          <span
            className="font-mono text-[11px] text-amber-600/80 dark:text-amber-400/80"
            style={{ fontFamily: MONO_FONT }}
          >
            /{pattern}/
          </span>
        </div>
        {(path || include) && (
          <div className="flex items-center gap-2 pl-[18px]">
            {path && (
              <span
                className="text-[10px] text-muted-foreground/55 font-mono"
                style={{ fontFamily: MONO_FONT }}
              >
                in {path}
              </span>
            )}
            {include && (
              <span
                className="text-[10px] text-muted-foreground/55 font-mono"
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
    const kindLabels: Record<string, string> = { at: 'Once', every: 'Interval', cron: 'Cron' }
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
            <span className="text-[9px] text-muted-foreground/55">{schedule.tz}</span>
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
        const formatted = formatStructuredInputValue(value)
        return <InputField key={key} label={key} value={formatted.text} mono={formatted.mono} />
      })}
    </div>
  )
}

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

function compactToolPrimaryText(
  name: string,
  input: Record<string, unknown>,
  fallback?: string
): string {
  if (name === 'Bash') {
    const command =
      typeof input.command === 'string' ? input.command.replace(/\s+/g, ' ').trim() : ''
    return command || fallback || ''
  }

  if (name === 'Glob') {
    const pattern = typeof input.pattern === 'string' ? input.pattern.trim() : ''
    const path = typeof input.path === 'string' ? input.path.trim() : ''
    return pattern || path || fallback || ''
  }

  return fallback || ''
}

function compactToolTitle(name: string, input: Record<string, unknown>, fallback?: string): string {
  if (name === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    return command || fallback || name
  }

  if (name === 'Glob') {
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    const path = typeof input.path === 'string' ? input.path : ''
    return [pattern, path].filter(Boolean).join('\n') || fallback || name
  }

  return fallback || name
}

function compactToolPrefixKey(name: string): string | null {
  switch (name) {
    case 'Bash':
      return 'toolCall.compactPrefix.bash'
    case 'Read':
      return 'toolCall.compactPrefix.read'
    case 'Grep':
      return 'toolCall.compactPrefix.grep'
    case 'Glob':
      return 'toolCall.compactPrefix.glob'
    case 'LS':
      return 'toolCall.compactPrefix.ls'
    default:
      return null
  }
}

function hasFocusedExpandedOutput(
  name: string,
  output: ToolResultContent | undefined,
  outputText: string | undefined
): boolean {
  if (!output) return false
  if (name === 'Read') return true
  return ['Grep', 'Glob', 'LS'].includes(name) && (outputText?.length ?? 0) > 0
}

function ToolCallCardInner({
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
  const isProcessing = status === 'streaming' || status === 'running'
  const isActive = isProcessing || status === 'pending_approval'
  const [open, setOpen] = React.useState(isActive)
  const prevIsActiveRef = React.useRef(isActive)
  React.useEffect(() => {
    if (prevIsActiveRef.current && !isActive) {
      setOpen(false)
    }
    prevIsActiveRef.current = isActive
  }, [isActive])
  const outputText = React.useMemo(() => outputAsString(output), [output])
  const summary = React.useMemo(
    () => inputSummary(name, input, outputText),
    [input, name, outputText]
  )
  const displayName = React.useMemo(
    () => t(`permission.toolLabels.${name}`, { defaultValue: name }),
    [name, t]
  )
  const headerSummary = React.useMemo(() => {
    if (name !== 'TaskList') return summary
    if (!outputText) return null

    const data = decodeStructuredToolResult(outputText)
    if (!data || Array.isArray(data) || !Array.isArray(data.tasks)) return null

    const completed = data.tasks.filter(
      (task) =>
        task && typeof task === 'object' && (task as { status?: unknown }).status === 'completed'
    ).length
    return t('todo.tasksDone', { completed, total: data.tasks.length })
  }, [name, outputText, summary, t])
  const outputIsErrorOnly = React.useMemo(() => isErrorOnlyOutput(outputText), [outputText])
  const outputError = React.useMemo(() => deriveOutputError(outputText), [outputText])
  const suppressErrorPanel = name === 'Bash' && isStructuredBashResult(outputText)
  const displayError = suppressErrorPanel
    ? null
    : error || (status === 'error' ? outputError : null)
  const shouldRenderOutputPanels = !displayError || !outputIsErrorOnly
  const hideLivePayload =
    isProcessing &&
    (name === 'Write' || name === 'Edit') &&
    input.content_hidden_until_complete === true
  const showSettledWriteContent =
    name === 'Write' &&
    status !== 'streaming' &&
    status !== 'running' &&
    !!(input.content || input.content_preview)
  const elapsed =
    startedAt && completedAt ? ((completedAt - startedAt) / 1000).toFixed(1) + 's' : null
  const useCompactToolHeader = !isActive && ['Bash', 'Read', 'Grep', 'Glob', 'LS'].includes(name)
  const compactPrimary = React.useMemo(
    () => compactToolPrimaryText(name, input, summary ?? undefined),
    [input, name, summary]
  )
  const compactTitle = React.useMemo(
    () => compactToolTitle(name, input, summary ?? undefined),
    [input, name, summary]
  )
  const compactPrefixKey = compactToolPrefixKey(name)
  const compactHeaderError = Boolean(displayError) || (status === 'error' && !!outputError)
  const settledBashHasFocusedOutput =
    shouldRenderOutputPanels &&
    name === 'Bash' &&
    !isActive &&
    Boolean(outputText || getBashInputTerminalId(input))
  const hasFocusedOutput =
    shouldRenderOutputPanels &&
    (hasFocusedExpandedOutput(name, output, outputText) || settledBashHasFocusedOutput)
  const shouldShowStructuredInput = !(showSettledWriteContent || hasFocusedOutput)

  return (
    <div
      className={cn(
        useCompactToolHeader ? 'my-0 min-w-0 overflow-hidden' : 'my-5 min-w-0 overflow-hidden'
      )}
    >
      {/* Header — click to toggle */}
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          useCompactToolHeader
            ? 'group w-full rounded-md px-2 py-0.5 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-accent/50'
            : 'flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground'
        )}
      >
        {useCompactToolHeader ? (
          <div
            className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-muted-foreground transition-colors group-hover:text-foreground"
            title={compactTitle}
          >
            {compactPrefixKey ? (
              <span className="shrink-0 text-[11px] font-medium text-muted-foreground/85">
                {t(compactPrefixKey)}
              </span>
            ) : (
              <span className="shrink-0 text-[10px] font-medium text-muted-foreground/85">
                {displayName}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground/80 transition-colors group-hover:text-foreground">
              {compactPrimary || t('toolCall.receivingArgs')}
            </span>
            {compactHeaderError ? (
              <span
                className="size-1.5 shrink-0 rounded-full bg-red-500 dark:bg-red-400"
                title={displayError ?? outputError ?? t('error.label')}
              />
            ) : null}
            {elapsed && (
              <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground/60">
                {elapsed}
              </span>
            )}
            {open ? (
              <ChevronDown className="size-3 shrink-0 text-muted-foreground/60" />
            ) : (
              <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" />
            )}
          </div>
        ) : (
          <>
            <ToolStatusDot status={status} />
            <span className="font-medium">{displayName}</span>
            {isProcessing && !error && (
              <>
                {name === 'Write' && (input.file_path || input.path) ? (
                  <span className="text-blue-500/80 text-[10px] animate-pulse dark:text-blue-400/70">
                    Write:{' '}
                    {String(input.file_path || input.path)
                      .split(/[\\/]/)
                      .slice(-2)
                      .join('/')}
                    {typeof input.content_lines === 'number'
                      ? ` (${input.content_lines} lines)`
                      : ''}
                  </span>
                ) : name === 'Edit' && (input.file_path || input.path) ? (
                  <span className="text-amber-600/80 text-[10px] animate-pulse dark:text-amber-400/70">
                    Edit:{' '}
                    {String(input.file_path || input.path)
                      .split(/[\\/]/)
                      .slice(-2)
                      .join('/')}
                  </span>
                ) : (
                  <span className="text-violet-500/80 text-[10px] animate-pulse dark:text-violet-400/70">
                    {t('toolCall.receivingArgs')}
                  </span>
                )}
              </>
            )}
            {error && status === 'streaming' && (
              <span className="text-red-500/80 text-[10px] animate-pulse dark:text-red-400/70">
                {t('error.label')}
              </span>
            )}
            {status !== 'streaming' && headerSummary && !open && (
              <span className="max-w-[300px] truncate text-muted-foreground/70">
                {headerSummary}
              </span>
            )}
            {elapsed && (
              <span className="text-[10px] tabular-nums text-muted-foreground/55">{elapsed}</span>
            )}
            <ChevronDown
              className={cn(
                'size-3 text-muted-foreground/55 transition-transform duration-200',
                !open && '-rotate-90'
              )}
            />
          </>
        )}
      </button>

      {/* Expanded details */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className={cn(
              'min-w-0 overflow-hidden',
              useCompactToolHeader ? 'mt-0.5 pl-4' : 'mt-1.5 pl-5'
            )}
          >
            <div className="space-y-2 pb-0.5">
              {hideLivePayload ? (
                <div className="space-y-2">
                  <StructuredInput name={name} input={input} status={status} />
                  <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground/70">
                    Detailed Write/Edit content stays hidden until the tool finishes.
                  </div>
                </div>
              ) : (
                <>
                  {/* Write: show content with syntax highlighting */}
                  {showSettledWriteContent &&
                    name === 'Write' &&
                    (() => {
                      const writeContent = typeof input.content === 'string' ? input.content : null
                      const writePreview =
                        typeof input.content_preview === 'string' ? input.content_preview : null
                      const writePreviewTail =
                        typeof input.content_preview_tail === 'string'
                          ? input.content_preview_tail
                          : null
                      const displayContent =
                        writeContent ??
                        (writePreviewTail
                          ? `${writePreview}\n…\n${writePreviewTail}`
                          : writePreview) ??
                        ''
                      const isOmitted = !writeContent && !!input.content_omitted
                      const totalLines =
                        typeof input.content_lines === 'number'
                          ? input.content_lines
                          : writeContent
                            ? writeContent.split('\n').length
                            : null
                      return (
                        <div>
                          <div className="mb-1 flex items-center gap-1.5">
                            <p className="text-xs font-medium text-muted-foreground">
                              {t('toolCall.content')}
                            </p>
                            <span className="text-[9px] text-muted-foreground/55 font-mono">
                              {detectLang(String(input.file_path ?? input.path ?? ''))}
                              {totalLines !== null ? ` · ${totalLines} lines` : ''}
                            </span>
                            {isOmitted && (
                              <span className="rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground/60">
                                preview
                              </span>
                            )}
                            {writeContent && <CopyBtn text={writeContent} />}
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
                            {displayContent}
                          </LazySyntaxHighlighter>
                        </div>
                      )
                    })()}
                  {/* Structured Input — tool-specific rendering */}
                  {shouldShowStructuredInput && (
                    <StructuredInput name={name} input={input} status={status} />
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
                    (status === 'running' || outputText || getBashInputTerminalId(input)) && (
                      <BashOutputBlock
                        output={outputText ?? ''}
                        input={input}
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
                  {shouldRenderOutputPanels &&
                    output &&
                    ['Edit', 'Write', 'Delete'].includes(name) &&
                    (() => {
                      const s = outputText ?? ''
                      const parsed = decodeStructuredToolResult(s)
                      const success = !!(
                        parsed &&
                        !Array.isArray(parsed) &&
                        parsed.success === true
                      )
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
                      <p className="mb-1 text-xs font-medium text-destructive">
                        {t('error.label')}
                      </p>
                      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs text-destructive font-mono">
                        {displayError}
                      </pre>
                    </div>
                  )}
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export const ToolCallCard = React.memo(ToolCallCardInner, areToolCallCardPropsEqual)
ToolCallCard.displayName = 'ToolCallCard'
