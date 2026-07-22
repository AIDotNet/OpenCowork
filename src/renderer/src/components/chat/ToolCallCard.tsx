import * as React from 'react'
import { useTranslation } from 'react-i18next'
import Markdown from 'react-markdown'
import {
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS
} from '@renderer/lib/preview/viewers/markdown-components'
import {
  Waypoints,
  ChevronDown,
  CheckCircle2,
  XCircle,
  Copy,
  Check,
  Square,
  FileCode,
  Search,
  FolderTree,
  SquareTerminal,
  Trash2,
  ListTodo,
  CalendarClock,
  Bell,
  Globe2,
  MousePointerClick,
  Keyboard,
  ScrollText,
  Camera,
  Monitor,
  Box,
  Database,
  Target,
  LogIn,
  LogOut,
  HelpCircle,
  Code2,
  Folder,
  File,
  Clock,
  Bot,
  FileText
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@renderer/lib/utils'
import type { ToolCallStatus } from '@renderer/lib/agent/types'
import type { ImageBlock, TextBlock, ToolResultContent } from '@renderer/lib/api/types'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import { MONO_FONT } from '@renderer/lib/constants'
import { estimateTokens, formatTokens } from '@renderer/lib/format-tokens'
import { writeSvgStringToClipboard } from '@renderer/lib/utils/image-clipboard'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { Button } from '@renderer/components/ui/button'
import { LazySyntaxHighlighter } from './LazySyntaxHighlighter'
import { inputSummary } from './tool-call-summary'
import { CollapsibleHeightPanel } from './CollapsibleHeightPanel'
import { useChatActions } from '@renderer/hooks/use-chat-actions'
import { ImagePreview } from './ImagePreview'
import { ExtensionToolResultCard } from './ExtensionToolResultCard'
import {
  CompactToolCallHeader,
  type CompactToolHeaderBadge,
  type CompactToolHeaderModel
} from './CompactToolCallHeader'
import { parseExtensionToolResult } from '@renderer/lib/extensions/extension-result'
import { isMcpTool, parseMcpToolName } from '@renderer/lib/mcp/mcp-tools'

interface ToolCallCardProps {
  toolUseId?: string
  name: string
  input: Record<string, unknown>
  output?: ToolResultContent
  status: ToolCallStatus | 'completed'
  error?: string
  startedAt?: number
  completedAt?: number
  forceOpen?: boolean
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

function formatMcpToolDisplayName(name: string): string {
  const parsed = parseMcpToolName(name)
  const toolName = parsed?.toolName ?? name
  const label = toolName
    .split(/[-_\s]+/)
    .filter(Boolean)
    .join(' ')
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : toolName
}

function McpToolIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-3.5 text-white/90"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M7.2 15.8 10.8 12.2" />
      <path d="M8.8 17.4 12.4 13.8" />
      <path d="M10.4 10.8 13.2 8" />
      <path d="M13.8 14.2 16.6 11.4" />
      <path d="M9.8 11.2 12.8 14.2 15.2 11.8 12.2 8.8Z" fill="currentColor" stroke="none" />
      <path
        d="M7.2 15.8c-.6.6-.6 1.6 0 2.2s1.6.6 2.2 0l.6-.6-2.2-2.2Z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  )
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
    prev.forceOpen === next.forceOpen &&
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

function getSkillNameFromInput(input: Record<string, unknown>): string {
  const raw = input.SkillName ?? input.skillName ?? input.name
  return typeof raw === 'string' ? raw.trim() : ''
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

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function getStringInput(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function compactPath(value: string, depth = 2): string {
  const parts = value.split(/[\\/]/).filter(Boolean)
  if (parts.length === 0) return value
  return parts.slice(-depth).join('/')
}

function pathFileName(value: string): string {
  return compactPath(value, 1)
}

function pathParent(value: string, depth = 3): string {
  const parts = value.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 1) return ''
  return parts.slice(Math.max(0, parts.length - depth - 1), -1).join('/')
}

function stripReadLineNumbers(output: string): string {
  return /^\s*\d+\t/.test(output)
    ? output
        .split('\n')
        .map((line) => line.replace(/^\s*\d+\t/, ''))
        .join('\n')
    : output
}

function getReadOutputLineCount(output: string | undefined): number | null {
  if (!output?.trim()) return null
  const decoded = decodeStructuredToolResult(output)
  if (decoded && !Array.isArray(decoded) && typeof decoded.error === 'string') return null
  return stripReadLineNumbers(output).split('\n').length
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

function getImageBlockPreviewSrc(image: ImageBlock): string {
  if (image.source.type === 'base64' && image.source.data) {
    return `data:${image.source.mediaType || 'image/png'};base64,${image.source.data}`
  }
  return image.source.url ?? ''
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
  const images = output.filter((b): b is ImageBlock => b.type === 'image')
  const notes = output.filter((b): b is TextBlock => b.type === 'text' && b.text.trim().length > 0)
  if (images.length === 0) return null
  return (
    <div className="space-y-3">
      {images.map((img, i) => {
        const src = getImageBlockPreviewSrc(img)
        if (!src && !img.source.filePath) return null
        return (
          <div
            key={`${img.source.filePath ?? img.source.url ?? img.source.data?.slice(0, 48) ?? i}-${i}`}
          >
            <div className="mb-1 flex items-center gap-1.5">
              <p className="text-xs font-medium text-muted-foreground">{t('toolCall.image')}</p>
              <span className="text-[9px] text-muted-foreground/55">{img.source.mediaType}</span>
            </div>
            <ImagePreview src={src} alt="Tool output" filePath={img.source.filePath} />
          </div>
        )
      })}
      {notes.length > 0 && (
        <div className="space-y-1">
          {notes.map((note, index) => (
            <p
              key={`${note.text}-${index}`}
              className="rounded-md bg-muted/20 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap break-words"
            >
              {note.text}
            </p>
          ))}
        </div>
      )}
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
    loadingMessages,
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
  const { t } = useTranslation('chat')
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
      toast.success(t('toolCall.widget.imageCopied'))

      if (resetTimerRef.current != null) {
        window.clearTimeout(resetTimerRef.current)
      }
      resetTimerRef.current = window.setTimeout(() => {
        setCopied(false)
        resetTimerRef.current = null
      }, 1500)
    } catch (error) {
      console.error('[Widget] Copy SVG image failed:', error)
      toast.error(t('toolCall.widget.copyImageFailed'))
    } finally {
      setCopying(false)
    }
  }, [copying, svg, t])

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="absolute right-2 top-2 z-20 size-8 border border-border/60 bg-background/85 text-muted-foreground shadow-sm backdrop-blur hover:bg-background hover:text-foreground disabled:opacity-60"
      onClick={() => void handleCopy()}
      disabled={copying || !svg.trim()}
      title={copied ? t('toolCall.widget.copied') : t('toolCall.widget.copyImage')}
      aria-label={copied ? t('toolCall.widget.copied') : t('toolCall.widget.copyImage')}
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
  const { t } = useTranslation('chat')
  const isExecuting = status === 'streaming' || status === 'running'
  const payload = normalizeWidgetPayload(input)
  const hasPayload = Boolean(payload)
  const defaultLoadingMessage = t('toolCall.widget.rendering')
  const loadingMessages =
    payload?.loadingMessages && payload.loadingMessages.length > 0
      ? payload.loadingMessages
      : [defaultLoadingMessage]
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

  if (!payload) return null
  if (!payload.widgetCode) {
    return isExecuting ? null : (
      <div className="my-2 text-xs text-muted-foreground/60">
        {t('toolCall.widget.waitingCode')}
      </div>
    )
  }

  const isPending = isExecuting && !loaded
  const loadingMessage = loadingMessages[loadingIndex] ?? defaultLoadingMessage

  return (
    <div className="my-2">
      <div
        className="relative overflow-hidden bg-transparent"
        style={{ width: '100%', border: 'none', backgroundColor: 'transparent' }}
      >
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
        {isPending && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/70 backdrop-blur-[1px]">
            <div className="rounded-md bg-background/90 px-3 py-2 text-xs text-muted-foreground shadow-sm">
              {loadingMessage}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// Markdown-rendered tool output (codegraph_explore & friends return agent-facing
// markdown: per-file source sections, call paths, impact). Collapsed = clamped
// height (no string slicing — cutting markdown mid-fence breaks rendering);
// the copy button still copies the raw text.
function MarkdownOutputBlock({ output }: { output: string }): React.JSX.Element {
  const { t } = useTranslation('chat')
  const [expanded, setExpanded] = React.useState(false)
  const isLong = output.length > 800 || output.split('\n').length > 16
  return (
    <div>
      <div className="mb-1 flex items-center">
        <p className="text-xs font-medium text-muted-foreground">{t('toolCall.output')}</p>
        <CopyBtn text={output} />
      </div>
      <div
        className={`overflow-auto rounded-md border border-border/50 bg-muted/10 px-3 py-2 ${
          isLong && !expanded ? 'max-h-48' : 'max-h-[480px]'
        }`}
      >
        <div className="prose prose-sm dark:prose-invert max-w-none text-xs prose-headings:mb-1.5 prose-headings:mt-3 prose-headings:text-sm prose-p:my-1.5 prose-ul:my-1.5 prose-li:my-0.5 prose-pre:bg-muted prose-pre:px-2.5 prose-pre:py-2 prose-code:before:content-none prose-code:after:content-none">
          <Markdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} rehypePlugins={MARKDOWN_REHYPE_PLUGINS}>
            {output}
          </Markdown>
        </div>
      </div>
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
  // fs:read-file may prefix each line as "1\tcode"; the visible preview should stay copyable.
  const rawContent = stripReadLineNumbers(output)
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
          {lang} · {t('toolCall.lineCount', { count: lines.length })}
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

interface LiveShellOutputState {
  execId: string | null
  text: string
}

interface ParsedShellResult {
  stdout?: string
  stderr?: string
  output?: string
  exitCode?: number
  processId?: string
  terminalId?: string
  summary?: ShellOutputSummary
  cwd?: string
  command?: string
  timedOut?: boolean
  totalMs?: number
}

const LIVE_SHELL_OUTPUT_MAX_CHARS = 12_000
const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g')

function normalizeLiveShellChunk(chunk: string): string {
  return chunk.replace(ANSI_ESCAPE_RE, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function clampLiveShellText(text: string): string {
  if (text.length <= LIVE_SHELL_OUTPUT_MAX_CHARS) return text
  return text.slice(-LIVE_SHELL_OUTPUT_MAX_CHARS)
}

function appendLiveShellOutput(
  state: LiveShellOutputState,
  execId: string,
  chunk: string
): LiveShellOutputState {
  const base =
    state.execId === execId
      ? state
      : {
          execId,
          text: ''
        }
  const text = normalizeLiveShellChunk(chunk)
  if (!text) return base
  return {
    ...base,
    text: clampLiveShellText(`${base.text}${text}`)
  }
}

function getShellInputCommand(input: Record<string, unknown>, fallback?: string): string {
  if (typeof fallback === 'string' && fallback.trim()) return fallback
  return (
    getStringInput(input, ['command', 'command_preview']) ||
    (typeof fallback === 'string' ? fallback : '')
  )
}

function getShellCwd(input: Record<string, unknown>, fallback?: string): string {
  if (typeof fallback === 'string' && fallback.trim()) return fallback.trim()
  return (
    getStringInput(input, ['cwd', 'workingDirectory', 'working_dir', 'workingFolder']) ||
    (typeof fallback === 'string' && fallback.trim() ? fallback.trim() : '~')
  )
}

function buildShellPromptLine(toolName: string, cwd: string, command: string): string {
  const normalizedCommand = normalizeLiveShellChunk(command).trimEnd()
  const isPowerShell = toolName === 'PowerShell'
  const prefix = isPowerShell ? `PS ${cwd}>` : `${cwd} $`
  if (!normalizedCommand) return prefix

  const lines = normalizedCommand.split('\n')
  const continuation = isPowerShell ? '>>' : '>'
  return [`${prefix} ${lines[0]}`, ...lines.slice(1).map((line) => `${continuation} ${line}`)].join(
    '\n'
  )
}

function getStringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  return typeof field === 'string' ? field : undefined
}

function getNumberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key]
  return typeof field === 'number' ? field : undefined
}

function normalizeShellResult(value: unknown): ParsedShellResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const source =
    record.result && typeof record.result === 'object' && !Array.isArray(record.result)
      ? (record.result as Record<string, unknown>)
      : record
  if (
    !('stdout' in source) &&
    !('stderr' in source) &&
    !('output' in source) &&
    !('exitCode' in source) &&
    !('processId' in source)
  ) {
    return null
  }

  return {
    stdout: getStringField(source, 'stdout'),
    stderr: getStringField(source, 'stderr'),
    output: getStringField(source, 'output'),
    exitCode: getNumberField(source, 'exitCode'),
    processId: getStringField(source, 'processId'),
    terminalId: getStringField(source, 'terminalId'),
    summary:
      source.summary && typeof source.summary === 'object' && !Array.isArray(source.summary)
        ? (source.summary as ShellOutputSummary)
        : undefined,
    cwd: getStringField(source, 'cwd'),
    command: getStringField(source, 'command'),
    timedOut: typeof source.timedOut === 'boolean' ? source.timedOut : undefined,
    totalMs: getNumberField(source, 'totalMs')
  }
}

function buildStoredShellOutput(parsed: ParsedShellResult | null): string {
  if (!parsed) return ''
  if (parsed.output) return parsed.output
  return [parsed.stderr, parsed.stdout ?? parsed.output]
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .join('\n')
}

function BashOutputBlock({
  name,
  output,
  input,
  toolUseId,
  status
}: {
  name: string
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
  const foregroundExec = useAgentStore((s) =>
    toolUseId ? s.foregroundShellExecByToolUseId[toolUseId] : undefined
  )
  const foregroundExecId =
    foregroundExec?.execId ??
    ((status === 'running' || status === 'streaming') && toolUseId ? toolUseId : undefined)
  const [liveShellOutput, setLiveShellOutput] = React.useState<LiveShellOutputState>({
    execId: null,
    text: ''
  })
  const terminalRef = React.useRef<HTMLPreElement>(null)

  React.useEffect(() => {
    if (!foregroundExecId || (status !== 'running' && status !== 'streaming')) {
      setLiveShellOutput((current) =>
        current.execId === null ? current : { execId: null, text: '' }
      )
      return
    }

    setLiveShellOutput({ execId: foregroundExecId, text: '' })
    return ipcClient.on(IPC.SHELL_OUTPUT, (payload) => {
      const data = payload as { execId?: unknown; chunk?: unknown; stream?: unknown }
      const chunk = data.chunk
      if (data.execId !== foregroundExecId || typeof chunk !== 'string') return
      setLiveShellOutput((current) => appendLiveShellOutput(current, foregroundExecId, chunk))
    })
  }, [foregroundExecId, status])

  const parsed = React.useMemo(() => {
    const obj = decodeStructuredToolResult(output)
    return normalizeShellResult(obj)
  }, [output])

  const processId = parsed?.processId ? String(parsed.processId) : null
  const process = useAgentStore((s) => (processId ? s.backgroundProcesses[processId] : undefined))
  const inputTerminalId = React.useMemo(() => getBashInputTerminalId(input), [input])
  const isProcessRunning = process?.status === 'running'
  const exitCode = process?.exitCode ?? parsed?.exitCode
  const statusText = process ? t(`toolCall.processStatus.${process.status}`) : null
  const canStopForegroundExec =
    !process && status === 'running' && !!toolUseId && !!foregroundExecId

  const liveText = liveShellOutput.execId === foregroundExecId ? liveShellOutput.text : ''
  const storedText = parsed ? buildStoredShellOutput(parsed) : normalizeLiveShellChunk(output)
  const rawText = process
    ? process.output
    : liveText.length > storedText.length
      ? liveText
      : storedText
  const command = getShellInputCommand(input, foregroundExec?.command ?? parsed?.command)
  const cwd = getShellCwd(input, foregroundExec?.cwd ?? parsed?.cwd)
  const promptLine = buildShellPromptLine(name, cwd, command)
  const text = rawText ? `${promptLine}\n${rawText.replace(/^\n+/, '')}` : promptLine
  const lineCount = text.split('\n').length
  const tokenCount = React.useMemo(() => estimateTokens(text), [text])

  React.useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const el = terminalRef.current
      if (!el) return
      el.scrollTop = el.scrollHeight
    })
    return () => window.cancelAnimationFrame(frame)
  }, [text])

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-xl border border-border/70 bg-transparent shadow-none dark:border-white/[0.08]">
        <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-transparent px-3 py-2 dark:border-white/[0.08]">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium text-foreground/85">
              {t('toolCall.shell')}
            </span>
            {processId ? (
              <span className="rounded-md border border-border/60 bg-transparent px-1.5 py-0.5 text-[9px] text-muted-foreground dark:border-white/[0.08]">
                {processId}
              </span>
            ) : null}
            {inputTerminalId ? (
              <span className="rounded-md border border-border/60 bg-transparent px-1.5 py-0.5 text-[9px] text-muted-foreground dark:border-white/[0.08]">
                {inputTerminalId}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-1.5">
            <CopyBtn text={text} />
          </div>
        </div>

        <pre
          ref={terminalRef}
          className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 text-[11px] leading-5 text-foreground/90"
          style={{ fontFamily: MONO_FONT }}
        >
          {text}
        </pre>

        {(statusText || exitCode !== undefined || lineCount > 0) && (
          <div className="flex items-center justify-between gap-2 border-t border-border/60 bg-transparent px-3 py-2 dark:border-white/[0.08]">
            <span className="text-[10px] text-muted-foreground/70">
              {t('toolCall.lineCount', { count: lineCount })} ·{' '}
              {t('toolCall.tokenCount', { value: formatTokens(tokenCount) })}
            </span>
            <div className="flex items-center gap-2 text-[11px]">
              {statusText && exitCode === undefined ? (
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5',
                    process?.status === 'running'
                      ? 'bg-blue-500/12 text-blue-300'
                      : process?.status === 'error'
                        ? 'bg-destructive/10 text-destructive'
                        : 'bg-white/[0.06] text-zinc-400'
                  )}
                >
                  {statusText}
                </span>
              ) : null}
              {exitCode !== undefined ? (
                exitCode === 0 ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-0.5 text-emerald-300">
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
  if (engine === 'native_aot') return '.NET native'
  if (engine === 'node' || engine.startsWith('node_')) return 'legacy local search'
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
                title={t('toolCall.clickToInsert', { path: file })}
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
              title={t('toolCall.clickToInsert', { path: p })}
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

type LsEntry = { name: string; type: string; path?: string }

function parseLsEntries(output: string | undefined): LsEntry[] | null {
  if (!output?.trim()) return null
  const decoded = decodeStructuredToolResult(output)
  if (!Array.isArray(decoded)) return null
  return decoded
    .map((entry): LsEntry | null => {
      if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.type !== 'string') {
        return null
      }
      return {
        name: entry.name,
        type: entry.type,
        path: typeof entry.path === 'string' ? entry.path : undefined
      }
    })
    .filter((entry): entry is LsEntry => !!entry)
}

function LSOutputBlock({ output }: { output: string }): React.JSX.Element {
  const { t } = useTranslation('chat')
  const parsed = React.useMemo(() => parseLsEntries(output), [output])
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
            title={t('toolCall.clickToInsert', { path: e.path || e.name })}
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

function EditPayloadPane({
  label,
  value,
  language,
  tone = 'default',
  truncated
}: {
  label: string
  value: string
  language?: string
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
  const { t } = useTranslation('chat')

  return (
    <div className={cn('rounded-md border bg-muted/20 dark:bg-zinc-950/70', borderTone)}>
      <div className="flex items-center gap-1.5 border-b border-border/50 px-2.5 py-1.5 text-[10px] uppercase tracking-wide">
        <span className={headerTone}>{label}</span>
        <span className="text-muted-foreground/55">
          {t('toolCall.lineCount', { count: lineCount(value) })}
        </span>
        <span className="text-muted-foreground/55">
          {t('toolCall.charCount', { count: value.length })}
        </span>
        {truncated && (
          <span className="rounded bg-muted px-1 py-0.5 text-[9px] normal-case text-muted-foreground/60">
            {t('toolCall.preview')}
          </span>
        )}
        <CopyBtn text={value} />
      </div>
      <LazySyntaxHighlighter
        language={language}
        showLineNumbers
        customStyle={{
          margin: 0,
          padding: '0.5rem',
          borderRadius: 0,
          fontSize: '11px',
          maxHeight: '12rem',
          overflow: 'auto',
          fontFamily: MONO_FONT
        }}
        codeTagProps={{ style: { fontFamily: 'inherit' } }}
      >
        {value}
      </LazySyntaxHighlighter>
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

function ToolDetailSectionHeader({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between border-b border-border/45 pb-2 pt-0.5 text-[12px] font-semibold text-foreground/88 dark:border-white/[0.08]">
      <span>{label}</span>
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
  input
}: {
  name: string
  input: Record<string, unknown>
}): React.JSX.Element {
  const { t } = useTranslation('chat')

  if (name === 'Skill') {
    const skillName = getSkillNameFromInput(input)
    return (
      <div className="flex items-center gap-2 rounded-md bg-muted/20 px-3 py-2 text-xs">
        <span className="shrink-0 text-muted-foreground/65">{t('toolCall.skillName')}</span>
        <span className="min-w-0 truncate font-mono text-foreground/85">{skillName || '-'}</span>
      </div>
    )
  }

  // Shell-like tools: command in terminal-style block + compact execution metadata.
  if (COMMAND_TOOL_NAMES.has(name)) {
    const command =
      typeof input.command === 'string'
        ? input.command
        : typeof input.command_preview === 'string'
          ? input.command_preview
          : ''
    const description = input.description ? String(input.description) : null
    const timeout = input.timeout ? String(input.timeout) : null
    const commandChars = typeof input.command_chars === 'number' ? input.command_chars : null
    const commandLines = typeof input.command_lines === 'number' ? input.command_lines : null
    const commandTruncated = input.command_truncated === true
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
        {(description ||
          timeout ||
          commandChars !== null ||
          commandLines !== null ||
          commandTruncated) && (
          <div className="flex flex-wrap items-center gap-2 pl-[18px]">
            {description && <p className="text-[10px] text-muted-foreground/60">{description}</p>}
            {commandLines !== null && (
              <span className="text-[10px] text-muted-foreground/55">
                {t('toolCall.lineCount', { count: commandLines })}
              </span>
            )}
            {commandChars !== null && (
              <span className="text-[10px] text-muted-foreground/55">
                {t('toolCall.charCount', { count: commandChars })}
              </span>
            )}
            {commandTruncated && (
              <span className="rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-600 dark:text-amber-300">
                {t('toolCall.preview')}
              </span>
            )}
            {timeout && (
              <span className="text-[10px] text-muted-foreground/55">
                {t('toolCall.timeoutMs', { value: timeout })}
              </span>
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
            {t('toolCall.lineDelta', {
              old: oldLineTotal !== null ? oldLineTotal : '?',
              next: newLineTotal !== null ? newLineTotal : '?'
            })}
            {(oldCharTotal !== null || newCharTotal !== null) && (
              <>
                {' · '}
                {t('toolCall.charDelta', {
                  old: oldCharTotal !== null ? oldCharTotal : '?',
                  next: newCharTotal !== null ? newCharTotal : '?'
                })}
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
                language={detectLang(filePath)}
                tone="old"
                truncated={oldTruncated}
              />
            )}
            {visibleNew && (
              <EditPayloadPane
                label="new_string"
                value={visibleNew}
                language={detectLang(filePath)}
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
              {lineTotal !== null ? t('toolCall.lineCount', { count: lineTotal }) : ''}
              {lineTotal !== null && charTotal !== null ? ' · ' : ''}
              {charTotal !== null ? t('toolCall.charCount', { count: charTotal }) : ''}
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
                {t('toolCall.searchInPath', { path })}
              </span>
            )}
            {include && (
              <span
                className="text-[10px] text-muted-foreground/55 font-mono"
                style={{ fontFamily: MONO_FONT }}
              >
                {t('toolCall.includeGlob', { include })}
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

const COMMAND_TOOL_NAMES = new Set(['Bash', 'Shell', 'PowerShell'])
const COMPACT_BUILTIN_TOOL_NAMES = new Set([
  'AskUserQuestion',
  'Bash',
  'BrowserClick',
  'BrowserGetContent',
  'BrowserNavigate',
  'BrowserScreenshot',
  'BrowserScroll',
  'BrowserSnapshot',
  'BrowserType',
  'CronAdd',
  'CronCreate',
  'CronDelete',
  'CronList',
  'CronRemove',
  'CronUpdate',
  'Delete',
  'Edit',
  'EnterPlanMode',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'LS',
  'MemoryList',
  'MemoryRead',
  'MemorySearch',
  'Monitor',
  'NotebookEdit',
  'Notify',
  'PowerShell',
  'Read',
  'SavePlan',
  'Shell',
  'Skill',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'WebFetch',
  'WebSearch',
  'Write',
  'create_goal',
  'get_goal',
  'update_goal',
  'visualize_show_widget'
])

function compactStatusLabel(
  status: ToolCallCardProps['status'],
  t: (key: string, options?: Record<string, unknown>) => string
): string | null {
  if (status === 'streaming') return t('toolCall.receivingArgs')
  if (status === 'running') return t('toolCall.executing')
  if (status === 'pending_approval') return t('permission.title')
  if (status === 'error') return t('error.label')
  if (status === 'canceled') return t('toolCall.canceled', { defaultValue: 'Canceled' })
  return null
}

function lineRangeBadge(
  input: Record<string, unknown>,
  t: (key: string, options?: Record<string, unknown>) => string
): string | null {
  const rawOffset = input.offset
  const rawLimit = input.limit
  const offset = typeof rawOffset === 'number' && Number.isFinite(rawOffset) ? rawOffset : null
  const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? rawLimit : null
  if (offset === null) return null
  if (limit === null || limit <= 0) return t('toolCall.lineRangeFrom', { start: offset })
  return t('toolCall.lineRange', { start: offset, end: offset + limit - 1 })
}

function searchScopeText(
  input: Record<string, unknown>,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  const path = getStringInput(input, ['path'])
  const include = getStringInput(input, ['include'])
  const exclude = getStringInput(input, ['exclude'])
  return [
    path ? t('toolCall.searchInPath', { path: compactPath(path, 3) }) : null,
    include ? t('toolCall.includeGlob', { include }) : null,
    exclude ? t('toolCall.excludeGlob', { exclude }) : null
  ]
    .filter((item): item is string => !!item)
    .join(' · ')
}

function bashOutputStats(outputText: string | undefined): {
  lines: number | null
  exitCode: number | null
} {
  if (!outputText?.trim()) return { lines: null, exitCode: null }
  const decoded = decodeStructuredToolResult(outputText)
  if (decoded && !Array.isArray(decoded)) {
    const stdout =
      typeof decoded.stdout === 'string'
        ? decoded.stdout
        : typeof decoded.output === 'string'
          ? decoded.output
          : ''
    const stderr = typeof decoded.stderr === 'string' ? decoded.stderr : ''
    const text = [stderr, stdout].filter(Boolean).join('\n\n')
    return {
      lines: text ? lineCount(text) : null,
      exitCode: typeof decoded.exitCode === 'number' ? decoded.exitCode : null
    }
  }
  return { lines: lineCount(outputText), exitCode: null }
}

function firstStringInput(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

function fileToolPath(input: Record<string, unknown>): string {
  return firstStringInput(input, [
    'file_path',
    'path',
    'notebook_path',
    'notebook',
    'targetPath',
    'target_path'
  ])
}

function compactToolPathSummary(value: string): {
  primary: string
  secondary?: string
} {
  return {
    primary: pathFileName(value),
    secondary: value ? pathParent(value) || compactPath(value, 2) : undefined
  }
}

function genericCompactToolHeaderModel({
  icon,
  primary,
  secondary,
  displayName
}: {
  icon: React.ReactNode
  primary?: string
  secondary?: string
  displayName: string
}): CompactToolHeaderModel {
  return {
    icon,
    primary: primary || displayName,
    secondary,
    badges: [],
    title: [primary, secondary].filter(Boolean).join('\n') || displayName
  }
}

function getBuiltinToolIcon(name: string): React.ReactNode {
  if (['Write', 'SavePlan'].includes(name)) return <FileCode className="size-3.5" />
  if (['Edit', 'NotebookEdit'].includes(name)) return <FileCode className="size-3.5" />
  if (name === 'Delete') return <Trash2 className="size-3.5" />
  if (name.startsWith('Task')) return <ListTodo className="size-3.5" />
  if (name.startsWith('Cron')) return <CalendarClock className="size-3.5" />
  if (name === 'Notify') return <Bell className="size-3.5" />
  if (name === 'AskUserQuestion') return <HelpCircle className="size-3.5" />
  if (name === 'visualize_show_widget') return <Code2 className="size-3.5" />
  if (name === 'WebSearch' || name === 'WebFetch' || name.startsWith('Browser')) {
    if (name === 'BrowserClick') return <MousePointerClick className="size-3.5" />
    if (name === 'BrowserType') return <Keyboard className="size-3.5" />
    if (name === 'BrowserScroll') return <ScrollText className="size-3.5" />
    if (name === 'BrowserScreenshot') return <Camera className="size-3.5" />
    if (name === 'BrowserSnapshot') return <Monitor className="size-3.5" />
    return <Globe2 className="size-3.5" />
  }
  if (name === 'Monitor') return <SquareTerminal className="size-3.5" />
  if (name === 'EnterPlanMode') return <LogIn className="size-3.5" />
  if (name === 'ExitPlanMode') return <LogOut className="size-3.5" />
  if (name === 'Skill') return <FileText className="size-3.5" />
  if (name.endsWith('goal')) return <Target className="size-3.5" />
  if (name.startsWith('Memory')) return <Database className="size-3.5" />
  return <Box className="size-3.5" />
}

function getToolNamespace(name: string): string {
  if (['Read', 'Write', 'Edit', 'NotebookEdit', 'LS', 'Delete'].includes(name)) return 'files'
  if (['Glob', 'Grep'].includes(name)) return 'search'
  if (COMMAND_TOOL_NAMES.has(name) || name === 'Monitor') return 'shell'
  if (name.startsWith('Browser') || name === 'WebSearch' || name === 'WebFetch') return 'web'
  if (name.startsWith('Task')) return 'tasks'
  if (name.startsWith('Cron')) return 'cron'
  if (name.startsWith('Memory')) return 'memory'
  if (name.endsWith('goal')) return 'goal'
  if (name === 'visualize_show_widget') return 'widget'
  if (name === 'Notify') return 'notify'
  if (name === 'Skill') return 'skill'
  return 'open-cowork'
}

function buildCompactToolHeaderModel({
  name,
  input,
  output,
  outputText,
  displayName,
  summary,
  t
}: {
  name: string
  input: Record<string, unknown>
  output?: ToolResultContent
  outputText?: string
  displayName: string
  summary?: string | null
  t: (key: string, options?: Record<string, unknown>) => string
}): CompactToolHeaderModel {
  if (COMMAND_TOOL_NAMES.has(name)) {
    const command = compactWhitespace(getStringInput(input, ['command', 'command_preview']))
    const description = getStringInput(input, ['description'])
    const stats = bashOutputStats(outputText)
    const badges: CompactToolHeaderBadge[] = []
    if (stats.exitCode !== null)
      badges.push({ label: t('toolCall.exitCode', { code: stats.exitCode }) })
    if (stats.lines !== null) {
      badges.push({ label: t('toolCall.outputLineCount', { count: stats.lines }), tone: 'blue' })
    }
    const commandLines = typeof input.command_lines === 'number' ? input.command_lines : null
    if (commandLines !== null && stats.lines === null) {
      badges.push({ label: t('toolCall.lineCount', { count: commandLines }), tone: 'blue' })
    }
    return {
      icon: <SquareTerminal className="size-3.5" />,
      primary: command || summary || t('toolCall.receivingArgs'),
      secondary: description || undefined,
      badges,
      title: command || summary || displayName
    }
  }

  if (name.startsWith('codegraph_')) {
    // The QUERY is the informative bit (the project path is ambient context).
    const query = compactWhitespace(getStringInput(input, ['query', 'symbol', 'file']))
    const projectPath = getStringInput(input, ['projectPath', 'workingFolder'])
    const badges: CompactToolHeaderBadge[] = []
    if (outputText) {
      badges.push({
        label: t('toolCall.outputLineCount', { count: outputText.split('\n').length }),
        tone: 'blue'
      })
    }
    return {
      icon: <Waypoints className="size-3.5" />,
      primary: query || summary || t('toolCall.receivingArgs'),
      secondary: projectPath ? pathFileName(projectPath) || projectPath : undefined,
      badges,
      title: [query, projectPath].filter(Boolean).join('\n') || displayName
    }
  }

  if (name === 'Read') {
    const filePath = getStringInput(input, ['file_path', 'path'])
    const lines = getReadOutputLineCount(outputText)
    const range = lineRangeBadge(input, t)
    const badges: CompactToolHeaderBadge[] = []
    if (lines !== null)
      badges.push({ label: t('toolCall.lineCount', { count: lines }), tone: 'blue' })
    if (range) badges.push({ label: range })
    if (hasImageBlocks(output)) badges.push({ label: t('toolCall.imageFile'), tone: 'blue' })
    return {
      icon: <FileCode className="size-3.5" />,
      primary: pathFileName(filePath) || summary || t('toolCall.receivingArgs'),
      secondary: filePath ? pathParent(filePath) || compactPath(filePath, 2) : undefined,
      badges,
      title: filePath || summary || displayName
    }
  }

  if (['Write', 'Edit', 'Delete', 'NotebookEdit', 'SavePlan'].includes(name)) {
    const targetPath = fileToolPath(input)
    const pathSummary = compactToolPathSummary(targetPath)
    const badges: CompactToolHeaderBadge[] = []
    const lineTotal =
      typeof input.content_lines === 'number'
        ? input.content_lines
        : typeof input.old_string_lines === 'number' || typeof input.new_string_lines === 'number'
          ? Math.max(
              typeof input.old_string_lines === 'number' ? input.old_string_lines : 0,
              typeof input.new_string_lines === 'number' ? input.new_string_lines : 0
            )
          : null
    const editCount = Array.isArray(input.edits) ? input.edits.length : null
    if (editCount !== null) badges.push({ label: t('toolCall.pathCount', { count: editCount }) })
    if (lineTotal !== null) {
      badges.push({ label: t('toolCall.lineCount', { count: lineTotal }), tone: 'blue' })
    }
    if (
      input.content_truncated === true ||
      input.old_string_truncated === true ||
      input.new_string_truncated === true
    ) {
      badges.push({ label: t('toolCall.preview'), tone: 'amber' })
    }
    return {
      icon: getBuiltinToolIcon(name),
      primary: pathSummary.primary || summary || displayName,
      secondary: pathSummary.secondary,
      badges,
      title: targetPath || summary || displayName
    }
  }

  if (name === 'Grep') {
    const pattern = getStringInput(input, ['pattern'])
    const parsed = outputText ? parseGrepOutput(outputText) : null
    const matchCount = parsed?.matches.length ?? null
    const fileCount = parsed ? new Set(parsed.matches.map((match) => match.file)).size : null
    const badges: CompactToolHeaderBadge[] = []
    if (matchCount !== null && fileCount !== null) {
      badges.push({
        label: t('toolCall.matchesInFiles', { matches: matchCount, files: fileCount }),
        tone: matchCount > 0 ? 'amber' : 'default'
      })
    }
    return {
      icon: <Search className="size-3.5" />,
      primary: pattern ? `/${pattern}/` : summary || t('toolCall.receivingArgs'),
      secondary: searchScopeText(input, t) || undefined,
      badges,
      statusBadge: parsed ? (
        <SearchStateBadge state={getSearchVisualState(parsed.meta, parsed.matches.length)} />
      ) : undefined,
      title: [pattern ? `/${pattern}/` : '', searchScopeText(input, t)].filter(Boolean).join('\n')
    }
  }

  if (name === 'Glob') {
    const pattern = getStringInput(input, ['pattern'])
    const path = getStringInput(input, ['path'])
    const parsed = outputText ? parseGlobOutput(outputText) : null
    const badges: CompactToolHeaderBadge[] = []
    if (parsed) {
      badges.push({
        label: t('toolCall.pathCount', { count: parsed.matches.length }),
        tone: parsed.matches.length > 0 ? 'green' : 'default'
      })
    }
    return {
      icon: <Search className="size-3.5" />,
      primary: pattern || summary || t('toolCall.receivingArgs'),
      secondary: path ? t('toolCall.searchInPath', { path: compactPath(path, 3) }) : undefined,
      badges,
      statusBadge: parsed ? (
        <SearchStateBadge state={getSearchVisualState(parsed.meta, parsed.matches.length)} />
      ) : undefined,
      title: [pattern, path].filter(Boolean).join('\n') || summary || displayName
    }
  }

  if (name === 'LS') {
    const path = getStringInput(input, ['path'])
    const parsed = parseLsEntries(outputText)
    const dirs = parsed?.filter((entry) => entry.type === 'directory').length ?? null
    const files = parsed?.filter((entry) => entry.type === 'file').length ?? null
    const badges: CompactToolHeaderBadge[] = []
    if (dirs !== null && files !== null) {
      badges.push({ label: t('toolCall.foldersAndFiles', { folders: dirs, files }) })
    }
    return {
      icon: <FolderTree className="size-3.5" />,
      primary: compactPath(path, 3) || summary || t('toolCall.receivingArgs'),
      secondary: path && compactPath(path, 3) !== path ? path : undefined,
      badges,
      title: path || summary || displayName
    }
  }

  if (name.startsWith('Task')) {
    const taskTitle = firstStringInput(input, ['title', 'subject', 'name', 'content'])
    const taskId = firstStringInput(input, ['taskId', 'task_id', 'id'])
    const taskStatus = firstStringInput(input, ['status', 'state'])
    return genericCompactToolHeaderModel({
      icon: getBuiltinToolIcon(name),
      primary: taskTitle || (taskId ? `#${taskId}` : summary || displayName),
      secondary: taskStatus || undefined,
      displayName
    })
  }

  if (name.startsWith('Cron')) {
    const cronName = firstStringInput(input, ['name', 'title', 'id', 'cronId'])
    const schedule = firstStringInput(input, ['expr', 'cron', 'schedule', 'rrule'])
    return genericCompactToolHeaderModel({
      icon: getBuiltinToolIcon(name),
      primary: cronName || summary || displayName,
      secondary: schedule || undefined,
      displayName
    })
  }

  if (name === 'AskUserQuestion') {
    const questions = Array.isArray(input.questions) ? input.questions.length : null
    return {
      icon: getBuiltinToolIcon(name),
      primary: summary || displayName,
      secondary: questions ? t('toolCall.pathCount', { count: questions }) : undefined,
      badges: [],
      title: summary || displayName
    }
  }

  if (name === 'Skill') {
    const skillName = getSkillNameFromInput(input)
    return {
      icon: getBuiltinToolIcon(name),
      primary: skillName || summary || displayName,
      badges: [],
      title: skillName || summary || displayName
    }
  }

  if (name === 'visualize_show_widget') {
    const title = firstStringInput(input, ['title', 'name'])
    const chars =
      typeof input.widget_code_chars === 'number'
        ? input.widget_code_chars
        : typeof input.widget_code === 'string'
          ? input.widget_code.length
          : null
    return {
      icon: getBuiltinToolIcon(name),
      primary: title || summary || displayName,
      badges:
        chars !== null ? [{ label: t('toolCall.charCount', { count: chars }), tone: 'blue' }] : [],
      title: title || summary || displayName
    }
  }

  if (name.startsWith('Browser') || name === 'WebFetch' || name === 'WebSearch') {
    const target = firstStringInput(input, ['url', 'query', 'selector', 'text'])
    return genericCompactToolHeaderModel({
      icon: getBuiltinToolIcon(name),
      primary: target || summary || displayName,
      displayName
    })
  }

  if (
    [
      'Notify',
      'Monitor',
      'EnterPlanMode',
      'ExitPlanMode',
      'get_goal',
      'create_goal',
      'update_goal',
      'MemoryList',
      'MemoryRead',
      'MemorySearch'
    ].includes(name)
  ) {
    const primary = firstStringInput(input, [
      'message',
      'objective',
      'query',
      'name',
      'uri',
      'path',
      'command',
      'reason'
    ])
    return genericCompactToolHeaderModel({
      icon: getBuiltinToolIcon(name),
      primary: primary || summary || displayName,
      displayName
    })
  }

  return {
    icon: getBuiltinToolIcon(name),
    primary: summary || displayName,
    badges: [],
    title: summary || displayName
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
  completedAt,
  forceOpen = false
}: ToolCallCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const isProcessing = status === 'streaming' || status === 'running'
  const isActive = isProcessing || status === 'pending_approval'
  const isCommandTool = COMMAND_TOOL_NAMES.has(name)
  const isLiveCommandTool = isCommandTool && isProcessing
  const toolNamePulseClass =
    status === 'running'
      ? `tool-name-live-pulse tool-name-live-pulse--${isCommandTool ? 'shell' : 'running'}`
      : status === 'streaming'
        ? `tool-name-live-pulse tool-name-live-pulse--${isCommandTool ? 'shell' : 'streaming'}`
        : null
  const hasVisualOutput = hasImageBlocks(output)
  const isReadTextTool = name === 'Read' && !hasVisualOutput
  const [open, setOpen] = React.useState(
    forceOpen || (isActive && !isReadTextTool) || hasVisualOutput
  )
  // Text Read output can be large; only mount it after the user opens the Read card.
  const [readTextOutputRevealed, setReadTextOutputRevealed] = React.useState(false)
  const prevIsActiveRef = React.useRef(isActive)
  const wasLiveCommandToolRef = React.useRef(isLiveCommandTool)
  const toggleOpen = React.useCallback(() => {
    if (forceOpen) return
    if (isLiveCommandTool) return
    if (name === 'Read' && !open) {
      setReadTextOutputRevealed(true)
    }
    setOpen((current) => !current)
  }, [forceOpen, isLiveCommandTool, name, open])

  React.useEffect(() => {
    if (forceOpen) {
      setOpen(true)
      if (isReadTextTool) {
        setReadTextOutputRevealed(true)
      }
      prevIsActiveRef.current = isActive
      wasLiveCommandToolRef.current = isLiveCommandTool
      return
    }
    if (hasVisualOutput) {
      setOpen(true)
      prevIsActiveRef.current = isActive
      wasLiveCommandToolRef.current = isLiveCommandTool
      return
    }
    if (isLiveCommandTool) {
      setOpen(true)
      prevIsActiveRef.current = isActive
      wasLiveCommandToolRef.current = true
      return
    }
    if (wasLiveCommandToolRef.current) {
      setOpen(false)
      wasLiveCommandToolRef.current = false
      prevIsActiveRef.current = isActive
      return
    }
    if (isReadTextTool) {
      if (!readTextOutputRevealed) {
        setOpen(false)
      }
      prevIsActiveRef.current = isActive
      wasLiveCommandToolRef.current = isLiveCommandTool
      return
    }
    if (prevIsActiveRef.current && !isActive) {
      setOpen(false)
    }
    prevIsActiveRef.current = isActive
    wasLiveCommandToolRef.current = isLiveCommandTool
  }, [
    forceOpen,
    hasVisualOutput,
    isActive,
    isLiveCommandTool,
    isReadTextTool,
    readTextOutputRevealed
  ])
  const outputText = React.useMemo(() => outputAsString(output), [output])
  const extensionToolResult = React.useMemo(
    () => (open ? parseExtensionToolResult(output) : null),
    [open, output]
  )
  const summary = React.useMemo(
    () => inputSummary(name, input, outputText),
    [input, name, outputText]
  )
  const displayName = React.useMemo(
    () =>
      isMcpTool(name)
        ? formatMcpToolDisplayName(name)
        : t(`permission.toolLabels.${name}`, { defaultValue: name }),
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
  const suppressErrorPanel = isCommandTool && isStructuredBashResult(outputText)
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
  const isMcpToolCall = isMcpTool(name)
  const useCompactToolHeader = COMPACT_BUILTIN_TOOL_NAMES.has(name)
  const compactHeader = React.useMemo(() => {
    const model = buildCompactToolHeaderModel({
      name,
      input,
      output,
      outputText,
      displayName,
      summary,
      t
    })
    return {
      ...model,
      toolLabel: displayName,
      namespace: getToolNamespace(name)
    }
  }, [displayName, input, name, output, outputText, summary, t])
  const compactStatus = compactStatusLabel(status, t)
  const compactHeaderError = Boolean(displayError) || (status === 'error' && !!outputError)
  const bashHasFocusedOutput =
    shouldRenderOutputPanels &&
    isCommandTool &&
    Boolean(
      status === 'running' ||
      status === 'streaming' ||
      outputText ||
      getBashInputTerminalId(input) ||
      getShellInputCommand(input)
    )
  const hasFocusedOutput =
    shouldRenderOutputPanels &&
    (hasFocusedExpandedOutput(name, output, outputText) || bashHasFocusedOutput)
  const suppressSkillOutput = name === 'Skill'
  const shouldShowStructuredInput = !(showSettledWriteContent || hasFocusedOutput)
  const shouldShowResultHeader =
    !suppressSkillOutput &&
    shouldRenderOutputPanels &&
    (Boolean(output) ||
      (isCommandTool &&
        Boolean(
          status === 'running' ||
          status === 'streaming' ||
          getBashInputTerminalId(input) ||
          getShellInputCommand(input)
        )))

  return (
    <div
      className={cn(
        useCompactToolHeader || isMcpToolCall
          ? 'my-1 min-w-0 overflow-hidden'
          : 'my-5 min-w-0 overflow-hidden'
      )}
    >
      {/* Header — click to toggle */}
      <button
        onClick={toggleOpen}
        className={cn(
          useCompactToolHeader
            ? 'group w-full rounded-lg p-0 text-left transition-colors'
            : isMcpToolCall
              ? 'group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] text-foreground/92 transition-colors hover:bg-muted/35 hover:text-foreground dark:hover:bg-white/[0.035]'
              : 'flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground'
        )}
      >
        {useCompactToolHeader ? (
          <CompactToolCallHeader
            model={compactHeader}
            status={status}
            statusLabel={compactStatus}
            hasError={compactHeaderError}
            errorTitle={displayError ?? outputError ?? t('error.label')}
            elapsed={elapsed}
            open={open}
          />
        ) : isMcpToolCall ? (
          <>
            <span
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-full border border-white/18 bg-transparent text-white/90',
                isProcessing && 'animate-pulse'
              )}
            >
              <McpToolIcon />
            </span>
            <span className={cn('min-w-0 shrink truncate font-medium', toolNamePulseClass)}>
              {displayName}
            </span>
            {status !== 'streaming' && headerSummary && !open ? (
              <span className="min-w-0 flex-1 truncate text-muted-foreground/62">
                {headerSummary}
              </span>
            ) : (
              <span className="min-w-0 flex-1" />
            )}
            {elapsed && (
              <span className="text-[10px] tabular-nums text-muted-foreground/55">{elapsed}</span>
            )}
            <ChevronDown
              className={cn(
                'size-3 shrink-0 text-muted-foreground/55 transition-transform duration-200 group-hover:text-foreground/80',
                !open && '-rotate-90'
              )}
            />
          </>
        ) : (
          <>
            <ToolStatusDot status={status} />
            <span className={cn('font-medium', toolNamePulseClass)}>{displayName}</span>
            {isProcessing && !error && (
              <>
                {name === 'Write' && (input.file_path || input.path) ? (
                  <span className={cn('text-[11px]', toolNamePulseClass)}>
                    Write:{' '}
                    {String(input.file_path || input.path)
                      .split(/[\\/]/)
                      .slice(-2)
                      .join('/')}
                    {typeof input.content_lines === 'number'
                      ? ` (${t('toolCall.lineCount', { count: input.content_lines })})`
                      : ''}
                  </span>
                ) : name === 'Edit' && (input.file_path || input.path) ? (
                  <span className={cn('text-[11px]', toolNamePulseClass)}>
                    Edit:{' '}
                    {String(input.file_path || input.path)
                      .split(/[\\/]/)
                      .slice(-2)
                      .join('/')}
                  </span>
                ) : (
                  <span className={cn('text-[11px]', toolNamePulseClass)}>
                    {status === 'streaming'
                      ? t('toolCall.receivingArgs')
                      : headerSummary || t('toolCall.executing')}
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

      {/* Expanded details — same pixel-height tween as ThinkingBlock */}
      <CollapsibleHeightPanel
        open={open}
        className={cn(
          'min-w-0 overflow-hidden',
          useCompactToolHeader
            ? 'ml-3 mt-1.5 border-l border-border/45 pl-5 dark:border-white/[0.08]'
            : 'mt-1.5 pl-5'
        )}
        contentClassName={cn(
          'space-y-2 pb-0.5',
          useCompactToolHeader &&
            !isCommandTool &&
            'rounded-lg border border-border/55 bg-background/55 px-3 py-3 dark:border-white/[0.08] dark:bg-[#0d0d0e]'
        )}
      >
        {hideLivePayload ? (
          <div className="space-y-2">
            <StructuredInput name={name} input={input} />
            <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground/70">
              {t('toolCall.hiddenLivePayload')}
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
                  typeof input.content_preview_tail === 'string' ? input.content_preview_tail : null
                const displayContent =
                  writeContent ??
                  (writePreviewTail ? `${writePreview}\n…\n${writePreviewTail}` : writePreview) ??
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
                        {totalLines !== null
                          ? ` · ${t('toolCall.lineCount', { count: totalLines })}`
                          : ''}
                      </span>
                      {isOmitted && (
                        <span className="rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground/60">
                          {t('toolCall.preview')}
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
              <div className="space-y-2">
                <ToolDetailSectionHeader label={t('toolCall.parameters')} />
                <StructuredInput name={name} input={input} />
              </div>
            )}
            {shouldShowResultHeader && <ToolDetailSectionHeader label={t('toolCall.result')} />}
            {/* Output — tool-specific rendering */}
            {output && name === 'Read' && hasImageBlocks(output) && (
              <ImageOutputBlock output={output} />
            )}
            {shouldRenderOutputPanels &&
              output &&
              name === 'Read' &&
              !hasImageBlocks(output) &&
              readTextOutputRevealed &&
              outputText && (
                <ReadOutputBlock
                  output={outputText}
                  filePath={String(input.file_path ?? input.path ?? '')}
                />
              )}
            {shouldRenderOutputPanels &&
              isCommandTool &&
              (status === 'running' ||
                status === 'streaming' ||
                outputText ||
                getBashInputTerminalId(input) ||
                getShellInputCommand(input)) && (
                <BashOutputBlock
                  name={name}
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
            {shouldRenderOutputPanels && output && extensionToolResult && (
              <ExtensionToolResultCard output={output} />
            )}
            {/* CodeGraph tools return agent-facing markdown — render it as such. */}
            {shouldRenderOutputPanels &&
              output &&
              name.startsWith('codegraph_') &&
              outputText && <MarkdownOutputBlock output={outputText} />}
            {shouldRenderOutputPanels &&
              output &&
              !extensionToolResult &&
              !name.startsWith('codegraph_') &&
              ![
                'Read',
                'Bash',
                'Shell',
                'PowerShell',
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
                'Skill',
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
      </CollapsibleHeightPanel>
    </div>
  )
}

export const ToolCallCard = React.memo(ToolCallCardInner, areToolCallCardPropsEqual)
ToolCallCard.displayName = 'ToolCallCard'
