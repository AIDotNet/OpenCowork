import { useState, useCallback, useMemo, useEffect, useId, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import mermaid from 'mermaid'
import {
  applyMermaidTheme,
  copyMermaidToClipboard,
  useMermaidThemeVersion
} from '@renderer/lib/utils/mermaid-theme'
import { Avatar, AvatarFallback } from '@renderer/components/ui/avatar'
import {
  Copy,
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  Bug,
  ImageDown,
  ZoomIn,
  Trash2,
  RotateCcw,
  Ellipsis,
  Languages,
  Volume2,
  Share2
} from 'lucide-react'
import { FadeIn, ScaleIn } from '@renderer/components/animate-ui'
import { ImageGeneratingLoader } from './ImageGeneratingLoader'
import { ImageGenerationErrorCard } from './ImageGenerationErrorCard'
import { ImagePreview } from './ImagePreview'
import { ImagePluginToolCard } from './ImagePluginToolCard'
import { DesktopActionToolCard } from './DesktopActionToolCard'
import { useChatStore } from '@renderer/stores/chat-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import type { AgentRunFileChange } from '@renderer/stores/agent-store'
import { useShallow } from 'zustand/react/shallow'
import type {
  ContentBlock,
  TokenUsage,
  ToolResultContent,
  RequestDebugInfo
} from '@renderer/lib/api/types'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { ToolCallCard } from './ToolCallCard'
import { ToolCallGroup } from './ToolCallGroup'
import { FileChangeCard } from './FileChangeCard'
import { RunChangeReviewCard } from './RunChangeReviewCard'
import { SubAgentCard } from './SubAgentCard'
import { TaskCard } from './TodoCard'
import { ThinkingBlock } from './ThinkingBlock'
import { TeamEventCard } from './TeamEventCard'
import { AskUserQuestionCard } from './AskUserQuestionCard'
import { TASK_TOOL_NAME } from '@renderer/lib/agent/sub-agents/create-tool'
import { TEAM_TOOL_NAMES } from '@renderer/lib/agent/teams/register'
import { useProviderStore } from '@renderer/stores/provider-store'
import { ModelIcon } from '@renderer/components/settings/provider-icons'
import {
  formatTokens,
  calculateCost,
  formatCost,
  getBillableInputTokens,
  getBillableTotalTokens
} from '@renderer/lib/format-tokens'
import { useMemoizedTokens } from '@renderer/hooks/use-estimated-tokens'
import { getLastDebugInfo, getRequestTraceInfo } from '@renderer/lib/debug-store'
import { MONO_FONT } from '@renderer/lib/constants'
import type { ToolCallState } from '@renderer/lib/agent/types'
import {
  DESKTOP_CLICK_TOOL_NAME,
  DESKTOP_SCREENSHOT_TOOL_NAME,
  DESKTOP_SCROLL_TOOL_NAME,
  DESKTOP_TYPE_TOOL_NAME,
  DESKTOP_WAIT_TOOL_NAME,
  IMAGE_GENERATE_TOOL_NAME
} from '@renderer/lib/app-plugin/types'
import { LazySyntaxHighlighter } from './LazySyntaxHighlighter'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useTranslateStore } from '@renderer/stores/translate-store'
import { useUIStore } from '@renderer/stores/ui-store'

type AssistantRenderMode = 'default' | 'transcript'

interface AssistantMessageProps {
  content: string | ContentBlock[]
  isStreaming?: boolean
  usage?: TokenUsage
  toolResults?: Map<string, { content: ToolResultContent; isError?: boolean }>
  liveToolCallMap?: Map<string, ToolCallState> | null
  msgId?: string
  showRetry?: boolean
  onRetry?: () => void
  onDelete?: (messageId: string) => void
  renderMode?: AssistantRenderMode
}

const MARKDOWN_WRAPPER_CLASS = 'text-sm leading-relaxed text-foreground break-words'
const THINK_OPEN_TAG_RE = /<\s*think\s*>/i
const SPECIAL_TOOLS = new Set([
  'TaskCreate',
  'TaskUpdate',
  'Write',
  'Edit',
  'Delete',
  'AskUserQuestion',
  IMAGE_GENERATE_TOOL_NAME,
  DESKTOP_SCREENSHOT_TOOL_NAME,
  DESKTOP_CLICK_TOOL_NAME,
  DESKTOP_TYPE_TOOL_NAME
])
const EMPTY_LIVE_TOOL_CALLS: ToolCallState[] = []

function stripThinkTagMarkers(text: string): string {
  return text.replace(/<\s*\/?\s*think\s*>/gi, '')
}

function formatMs(ms: number): string {
  if (ms >= 1000) {
    const seconds = ms / 1000
    const digits = seconds >= 10 ? 0 : 1
    return `${seconds.toFixed(digits)}s`
  }
  return `${Math.round(ms)}ms`
}

function DebugToggleButton({ debugInfo }: { debugInfo: RequestDebugInfo }): React.JSX.Element {
  const [show, setShow] = useState(false)
  const bodyFormatted = (() => {
    if (!debugInfo.body) return null
    try {
      return JSON.stringify(JSON.parse(debugInfo.body), null, 2)
    } catch {
      return debugInfo.body
    }
  })()

  return (
    <>
      <button
        onClick={() => setShow(true)}
        className={`flex items-center rounded px-1 py-0.5 transition-colors ${show ? 'text-orange-500 bg-orange-500/10' : 'text-muted-foreground hover:bg-muted-foreground/10'}`}
      >
        <Bug className="size-3.5" />
      </button>
      <Dialog open={show} onOpenChange={setShow}>
        <DialogContent className="max-h-[80vh] max-w-[90vw] gap-0 overflow-hidden p-0 sm:max-w-3xl">
          <DialogHeader className="border-b bg-muted/30 px-4 py-2.5 pr-10 text-left">
            <DialogTitle className="flex items-center gap-2 text-xs font-medium">
              <Bug className="size-3.5 text-orange-500" />
              <span>Request Debug</span>
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto">
            <div
              className="space-y-1.5 border-b px-4 py-2 text-[11px]"
              style={{ fontFamily: MONO_FONT }}
            >
              <div className="flex gap-2">
                <span className="text-muted-foreground/60 shrink-0">URL</span>
                <span className="text-foreground break-all">{debugInfo.url}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-muted-foreground/60 shrink-0">Method</span>
                <span className="text-foreground">{debugInfo.method}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-muted-foreground/60 shrink-0">Time</span>
                <span className="text-foreground">
                  {new Date(debugInfo.timestamp).toLocaleTimeString()}
                </span>
              </div>
            </div>
            {bodyFormatted && (
              <div>
                <div className="flex items-center justify-between border-b bg-muted/20 px-4 py-1.5">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Request Body
                  </span>
                  <CopyButton text={bodyFormatted} />
                </div>
                <LazySyntaxHighlighter
                  language="json"
                  customStyle={{
                    margin: 0,
                    padding: '12px 16px',
                    fontSize: '11px',
                    fontFamily: MONO_FONT,
                    background: 'transparent',
                    wordBreak: 'break-all',
                    whiteSpace: 'pre-wrap'
                  }}
                  codeTagProps={{ style: { fontFamily: MONO_FONT } }}
                >
                  {bodyFormatted}
                </LazySyntaxHighlighter>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function CopyButton({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation('chat')
  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [text])

  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted-foreground/10 transition-colors"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? t('userMessage.copied') : t('action.copy', { ns: 'common' })}
    </button>
  )
}

function ActionIconButton({
  label,
  icon,
  onClick,
  danger = false
}: {
  label: string
  icon: ReactNode
  onClick: () => void
  danger?: boolean
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className={`flex size-7 items-center justify-center rounded-md border border-border/50 bg-background/80 text-muted-foreground transition-colors hover:bg-muted/80 ${danger ? 'hover:text-destructive' : 'hover:text-foreground'}`}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}

function MermaidImageCopyButton({ svg }: { svg: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const handleCopy = useCallback(async () => {
    if (!svg.trim()) return
    setBusy(true)
    try {
      await copyMermaidToClipboard(svg)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('[Mermaid] Copy image failed:', err)
    } finally {
      setBusy(false)
    }
  }, [svg])

  return (
    <button
      onClick={() => void handleCopy()}
      disabled={busy || !svg.trim()}
      title="复制 Mermaid 图到剪贴板"
      className="flex items-center rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted-foreground/10 transition-colors disabled:opacity-50"
    >
      {copied ? <Check className="size-3" /> : <ImageDown className="size-3" />}
      <span>{copied ? '已复制' : '下载'}</span>
    </button>
  )
}

function MermaidCodeBlock({ code }: { code: string }): React.JSX.Element {
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')
  const [zoomOpen, setZoomOpen] = useState(false)
  const diagramKey = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const themeVersion = useMermaidThemeVersion()

  useEffect(() => {
    let cancelled = false

    async function renderDiagram(): Promise<void> {
      const source = code.trim()
      if (!source) {
        setSvg('')
        setError('')
        return
      }
      try {
        applyMermaidTheme()
        const result = await mermaid.render(`mermaid-chat-${diagramKey}-${Date.now()}`, source)
        if (cancelled) return
        setSvg(result.svg)
        setError('')
      } catch (err) {
        if (cancelled) return
        setSvg('')
        setError(err instanceof Error ? err.message : 'Failed to render Mermaid diagram.')
      }
    }

    void renderDiagram()
    return () => {
      cancelled = true
    }
  }, [code, diagramKey, themeVersion])

  return (
    <div className="group relative my-3 overflow-hidden rounded-lg border border-border/60 shadow-sm">
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/40 px-3 py-1.5">
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70">
          mermaid
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setZoomOpen(true)}
            disabled={!svg.trim()}
            title="放大 Mermaid 图"
            className="flex items-center rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted-foreground/10 transition-colors disabled:opacity-50"
          >
            <ZoomIn className="size-3" />
            <span>放大</span>
          </button>
          <MermaidImageCopyButton svg={svg} />
          <CopyButton text={code} />
        </div>
      </div>
      <div className="bg-[hsl(var(--muted))] p-3">
        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-xs font-medium text-destructive/90">Mermaid render failed</p>
            <p className="mt-1 text-xs text-destructive/70">{error}</p>
          </div>
        ) : !svg ? (
          <div className="rounded-md border border-border/60 bg-background/70 p-3 text-xs text-muted-foreground">
            Rendering Mermaid diagram...
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md bg-background p-3">
            <div
              className="[&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
        )}
      </div>
      <Dialog open={zoomOpen} onOpenChange={setZoomOpen}>
        <DialogContent className="flex h-[90vh] w-[95vw] max-w-[95vw] flex-col p-4">
          <DialogHeader className="sr-only">
            <DialogTitle>Mermaid 放大预览</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-auto rounded-md bg-background p-4">
            {svg ? (
              <div
                className="flex min-h-full min-w-max items-start justify-center [&_svg]:h-auto [&_svg]:max-w-none"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function PlainCodeBlock({
  language,
  code
}: {
  language?: string
  code: string
}): React.JSX.Element {
  return (
    <div className="group relative rounded-lg border border-border/60 overflow-hidden my-3 shadow-sm">
      <div className="flex items-center justify-between bg-muted/40 px-3 py-1.5 border-b border-border/60">
        <span className="text-[10px] font-mono text-muted-foreground/70 uppercase tracking-wider">
          {language || 'text'}
        </span>
        <CopyButton text={code} />
      </div>
      <pre
        className="overflow-x-auto bg-[hsl(var(--muted))] px-[14px] py-[14px] text-xs leading-6"
        style={{
          fontFamily: MONO_FONT,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all'
        }}
      >
        {code}
      </pre>
    </div>
  )
}

function CodeBlock({
  language,
  children,
  isStreaming = false
}: {
  language?: string
  children: string
  isStreaming?: boolean
}): React.JSX.Element {
  const code = String(children).replace(/\n$/, '')
  if (isStreaming) {
    return <PlainCodeBlock language={language} code={code} />
  }
  if (language?.toLowerCase() === 'mermaid') {
    return <MermaidCodeBlock code={code} />
  }
  return (
    <div className="group relative rounded-lg border border-border/60 overflow-hidden my-3 shadow-sm">
      <div className="flex items-center justify-between bg-muted/40 px-3 py-1.5 border-b border-border/60">
        <span className="text-[10px] font-mono text-muted-foreground/70 uppercase tracking-wider">
          {language || 'text'}
        </span>
        <CopyButton text={code} />
      </div>
      <LazySyntaxHighlighter
        language={language || 'text'}
        customStyle={{
          margin: 0,
          padding: '14px',
          fontSize: '12px',
          lineHeight: '1.5',
          background: 'transparent',
          fontFamily: MONO_FONT,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all'
        }}
        codeTagProps={{
          style: {
            fontFamily: 'inherit',
            fontSize: 'inherit'
          }
        }}
        className="!bg-[hsl(var(--muted))] text-xs"
      >
        {code}
      </LazySyntaxHighlighter>
    </div>
  )
}

function MarkdownContent({
  text,
  isStreaming = false
}: {
  text: string
  isStreaming?: boolean
}): React.JSX.Element {
  const components: Components = {
    a: ({ href, children }) => (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault()
          if (href) window.electron.ipcRenderer.invoke('shell:openExternal', href)
        }}
        className="text-primary underline underline-offset-2 hover:text-primary/80 cursor-pointer break-all"
        title={href}
      >
        {children}
      </a>
    ),
    p: ({ children, ...props }) => (
      <p
        className="my-1 first:mt-0 last:mb-0 leading-snug whitespace-pre-wrap break-words"
        {...props}
      >
        {children}
      </p>
    ),
    img: ({ src, alt, ...props }) => (
      <img
        {...props}
        src={src || ''}
        alt={alt || ''}
        className="my-3 block max-w-full rounded-lg border border-border/50 shadow-sm"
        loading="lazy"
      />
    ),
    ul: ({ children, ...props }) => (
      <ul className="my-1 last:mb-0 list-disc pl-4 space-y-0.5" {...props}>
        {children}
      </ul>
    ),
    ol: ({ children, ...props }) => (
      <ol className="my-1 last:mb-0 list-decimal pl-4 space-y-0.5" {...props}>
        {children}
      </ol>
    ),
    li: ({ children, ...props }) => (
      <li className="leading-snug break-words [&>p]:m-0 [&>p]:whitespace-pre-wrap" {...props}>
        {children}
      </li>
    ),
    table: ({ children, ...props }) => (
      <div className="my-2 overflow-x-auto max-w-full">
        <table className="min-w-0 border-collapse text-sm" {...props}>
          {children}
        </table>
      </div>
    ),
    th: ({ children, ...props }) => (
      <th className="whitespace-pre-wrap break-words" {...props}>
        {children}
      </th>
    ),
    td: ({ children, ...props }) => (
      <td className="whitespace-pre-wrap break-words" {...props}>
        {children}
      </td>
    ),
    pre: ({ children }) => <>{children}</>,
    code: ({ children, className, ...props }) => {
      const match = /language-([\w-]+)/.exec(className || '')
      const isInline = !match && !className
      if (isInline) {
        return (
          <code
            className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono"
            style={{ fontFamily: MONO_FONT }}
            {...props}
          >
            {children}
          </code>
        )
      }
      return (
        <CodeBlock language={match?.[1]} isStreaming={isStreaming}>
          {String(children)}
        </CodeBlock>
      )
    }
  }

  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </Markdown>
  )
}

function StreamingMarkdownContent({
  text,
  isStreaming
}: {
  text: string
  isStreaming: boolean
}): React.JSX.Element {
  if (isStreaming) {
    return <div className="whitespace-pre-wrap break-words leading-relaxed">{text}</div>
  }
  return <MarkdownContent text={text} isStreaming={false} />
}

interface ThinkSegment {
  type: 'text' | 'think'
  content: string
  closed?: boolean
}

function parseThinkTags(text: string): ThinkSegment[] {
  if (!THINK_OPEN_TAG_RE.test(text)) {
    return [{ type: 'text', content: stripThinkTagMarkers(text) }]
  }

  const segments: ThinkSegment[] = []
  const regex = /<\s*think\s*>([\s\S]*?)(<\s*\/\s*think\s*>|$)/gi
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const before = stripThinkTagMarkers(text.slice(lastIndex, match.index))
      if (before.trim()) segments.push({ type: 'text', content: before })
    }
    segments.push({ type: 'think', content: stripThinkTagMarkers(match[1]), closed: !!match[2] })
    lastIndex = regex.lastIndex
  }

  if (lastIndex < text.length) {
    const remaining = stripThinkTagMarkers(text.slice(lastIndex))
    if (remaining.trim()) segments.push({ type: 'text', content: remaining })
  }

  return segments.length > 0 ? segments : [{ type: 'text', content: stripThinkTagMarkers(text) }]
}

function stripThinkTags(text: string): string {
  return text
    .replace(/<\s*think\s*>[\s\S]*?(<\s*\/\s*think\s*>|$)/gi, '')
    .replace(/<\s*\/?\s*think\s*>/gi, '')
    .trim()
}

function normalizeStructuredBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const hasStructuredThinkingBlocks = blocks.some((b) => b.type === 'thinking')
  const normalized: ContentBlock[] = []

  for (const block of blocks) {
    if (block.type === 'text') {
      const text = hasStructuredThinkingBlocks ? stripThinkTags(block.text) : block.text
      if (!text.trim()) continue
      const last = normalized[normalized.length - 1]
      if (last && last.type === 'text') {
        normalized[normalized.length - 1] = { ...last, text: `${last.text}${text}` }
      } else {
        normalized.push({ ...block, text })
      }
      continue
    }

    if (block.type === 'thinking') {
      const cleanedThinking = stripThinkTagMarkers(block.thinking).trim()
      if (!cleanedThinking) continue
      const last = normalized[normalized.length - 1]
      if (last && last.type === 'thinking') {
        const separator =
          last.thinking.endsWith('\n') || cleanedThinking.startsWith('\n') ? '' : '\n'
        normalized[normalized.length - 1] = {
          ...last,
          thinking: `${last.thinking}${separator}${cleanedThinking}`,
          startedAt: last.startedAt ?? block.startedAt,
          completedAt: block.completedAt ?? last.completedAt
        }
      } else {
        normalized.push({ ...block, thinking: cleanedThinking })
      }
      continue
    }

    normalized.push(block)
  }

  return normalized
}

export function AssistantMessage({
  content,
  isStreaming,
  usage,
  toolResults,
  liveToolCallMap,
  msgId,
  showRetry,
  onRetry,
  onDelete,
  renderMode = 'default'
}: AssistantMessageProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const devMode = useSettingsStore((s) => s.devMode)
  const debugInfo = devMode && msgId ? getLastDebugInfo(msgId) : undefined
  const openTranslatePage = useUIStore((s) => s.openTranslatePage)
  const setTranslateSourceText = useTranslateStore((s) => s.setSourceText)
  const [toolsCollapsed, setToolsCollapsed] = useState(false)
  const [collapsed, setCollapsed] = useState(false)

  // Memoize the plain text extraction for token estimation (used only when no API usage)
  const plainTextForTokens = useMemo(() => {
    if (usage || isStreaming) return '' // skip expensive computation when API provides usage
    if (typeof content === 'string') return stripThinkTags(content)
    if (!Array.isArray(content)) return ''
    return content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => stripThinkTags(b.text))
      .join('\n')
  }, [content, usage, isStreaming])
  const fallbackTokens = useMemoizedTokens(plainTextForTokens)

  const isGeneratingImage = useChatStore((s) =>
    msgId ? !!s.generatingImageMessages[msgId] : false
  )
  const runChangeSet = useAgentStore((s) => (msgId ? s.runChangesByRunId[msgId] : undefined))
  const refreshRunChanges = useAgentStore((s) => s.refreshRunChanges)

  const stringSegments = useMemo(
    () => (typeof content === 'string' ? parseThinkTags(content) : null),
    [content]
  )
  const normalizedContent = useMemo(
    () => (Array.isArray(content) ? normalizeStructuredBlocks(content) : null),
    [content]
  )
  const liveToolCallIds = useMemo(() => {
    if (!isStreaming || !normalizedContent) return []
    return normalizedContent
      .filter(
        (block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use'
      )
      .map((block) => block.id)
  }, [isStreaming, normalizedContent])
  const liveToolCalls = useAgentStore(
    useShallow((s) => {
      if (liveToolCallMap || !isStreaming || liveToolCallIds.length === 0) {
        return EMPTY_LIVE_TOOL_CALLS
      }
      const idSet = new Set(liveToolCallIds)
      const matches: ToolCallState[] = []
      for (const toolCall of s.pendingToolCalls) {
        if (idSet.has(toolCall.id)) matches.push(toolCall)
      }
      for (const toolCall of s.executedToolCalls) {
        if (idSet.has(toolCall.id)) matches.push(toolCall)
      }
      return matches
    })
  )
  const effectiveLiveToolCallMap = useMemo(() => {
    if (liveToolCallMap) return liveToolCallMap
    if (!isStreaming || liveToolCalls.length === 0) return null
    const map = new Map<string, ToolCallState>()
    for (const toolCall of liveToolCalls) {
      map.set(toolCall.id, toolCall)
    }
    return map
  }, [isStreaming, liveToolCalls, liveToolCallMap])
  const structuredToolCount = useMemo(
    () => normalizedContent?.filter((block) => block.type === 'tool_use').length ?? 0,
    [normalizedContent]
  )
  const trackedChangeByToolUseId = useMemo(() => {
    const map = new Map<string, AgentRunFileChange>()
    for (const change of runChangeSet?.changes ?? []) {
      if (change.toolUseId) {
        map.set(change.toolUseId, change)
      }
    }
    return map
  }, [runChangeSet])
  const hasStructuredThinkingBlocks = useMemo(
    () => normalizedContent?.some((block) => block.type === 'thinking') ?? false,
    [normalizedContent]
  )
  const lastStructuredTextIdx = useMemo(() => {
    if (!isStreaming || !normalizedContent) return -1
    return normalizedContent.reduce(
      (acc: number, block, idx) => (block.type === 'text' ? idx : acc),
      -1
    )
  }, [isStreaming, normalizedContent])
  useEffect(() => {
    if (!msgId || isStreaming) return
    void refreshRunChanges(msgId)
  }, [isStreaming, msgId, refreshRunChanges])

  const renderItems = useMemo(() => {
    if (!normalizedContent) return []
    type RenderItem =
      | { kind: 'block'; index: number }
      | { kind: 'group'; toolName: string; indices: number[] }

    const items: RenderItem[] = []
    for (let i = 0; i < normalizedContent.length; i++) {
      const block = normalizedContent[i]
      if (
        block.type === 'tool_use' &&
        !SPECIAL_TOOLS.has(block.name) &&
        !TEAM_TOOL_NAMES.has(block.name) &&
        block.name !== TASK_TOOL_NAME
      ) {
        const last = items[items.length - 1]
        if (last && last.kind === 'group' && last.toolName === block.name) {
          last.indices.push(i)
        } else {
          items.push({ kind: 'group', toolName: block.name, indices: [i] })
        }
        continue
      }
      items.push({ kind: 'block', index: i })
    }
    return items
  }, [normalizedContent])
  const foregroundSubAgentTaskBlocks = useMemo(
    () =>
      normalizedContent?.filter(
        (block): block is Extract<ContentBlock, { type: 'tool_use' }> =>
          block.type === 'tool_use' &&
          block.name === TASK_TOOL_NAME &&
          !block.input.run_in_background
      ) ?? [],
    [normalizedContent]
  )

  const renderContent = (): React.JSX.Element => {
    // Show image generation loader when generating images
    if (isGeneratingImage && isStreaming) {
      return <ImageGeneratingLoader />
    }

    // Show thinking indicator when streaming just started
    if (isStreaming && typeof content === 'string' && content.length === 0) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="flex gap-1">
            <span
              className="size-1.5 rounded-full bg-foreground/30 animate-bounce"
              style={{ animationDelay: '0ms' }}
            />
            <span
              className="size-1.5 rounded-full bg-foreground/30 animate-bounce"
              style={{ animationDelay: '150ms' }}
            />
            <span
              className="size-1.5 rounded-full bg-foreground/30 animate-bounce"
              style={{ animationDelay: '300ms' }}
            />
          </span>
          <span className="text-xs text-muted-foreground/60">{t('thinking.thinkingEllipsis')}</span>
        </div>
      )
    }

    if (typeof content === 'string') {
      const segments = stringSegments ?? []
      const hasThink = segments.some((s) => s.type === 'think')

      if (!hasThink) {
        return (
          <div className={MARKDOWN_WRAPPER_CLASS}>
            <StreamingMarkdownContent text={content} isStreaming={!!isStreaming} />
            {isStreaming && (
              <span className="inline-block w-1.5 h-4 bg-primary/70 animate-pulse ml-0.5 rounded-sm" />
            )}
          </div>
        )
      }

      const lastTextSegIdx = segments.reduce(
        (acc: number, s, idx) => (s.type === 'text' ? idx : acc),
        -1
      )
      const lastSegment = segments[segments.length - 1]
      const showOuterCursor = isStreaming && !(lastSegment?.type === 'think' && !lastSegment.closed)

      return (
        <div className="space-y-2">
          {segments.map((seg, idx) => {
            if (seg.type === 'think') {
              return (
                <ThinkingBlock
                  key={idx}
                  thinking={stripThinkTagMarkers(seg.content)}
                  isStreaming={!!isStreaming && !seg.closed}
                />
              )
            }
            return (
              <div key={idx} className={MARKDOWN_WRAPPER_CLASS}>
                <StreamingMarkdownContent
                  text={seg.content}
                  isStreaming={!!isStreaming && idx === lastTextSegIdx}
                />
              </div>
            )
          })}
          {showOuterCursor && (
            <span className="inline-block w-1.5 h-4 bg-primary/70 animate-pulse ml-0.5 rounded-sm" />
          )}
        </div>
      )
    }

    if (!normalizedContent) {
      return <div className={MARKDOWN_WRAPPER_CLASS} />
    }

    const renderToolBlock = (
      block: Extract<ContentBlock, { type: 'tool_use' }>,
      key: string
    ): React.JSX.Element | null => {
      if (toolsCollapsed) return null
      if (block.name === 'TaskCreate') {
        const result = toolResults?.get(block.id)
        const liveTc = effectiveLiveToolCallMap?.get(block.id)
        return (
          <ScaleIn key={key} className="w-full origin-left">
            <TaskCard
              name={block.name}
              input={block.input}
              output={liveTc?.output ?? result?.content}
            />
          </ScaleIn>
        )
      }
      if (block.name === 'TaskUpdate') {
        const result = toolResults?.get(block.id)
        const liveTc = effectiveLiveToolCallMap?.get(block.id)
        return (
          <ScaleIn key={key} className="w-full origin-left">
            <TaskCard
              name={block.name}
              input={block.input}
              output={liveTc?.output ?? result?.content}
            />
          </ScaleIn>
        )
      }
      if (block.name === 'AskUserQuestion') {
        const result = toolResults?.get(block.id)
        const liveTc = effectiveLiveToolCallMap?.get(block.id)
        return (
          <ScaleIn key={key} className="w-full origin-left">
            <AskUserQuestionCard
              toolUseId={block.id}
              input={block.input}
              output={liveTc?.output ?? result?.content}
              status={liveTc?.status ?? (result?.isError ? 'error' : 'completed')}
              isLive={!!isStreaming}
            />
          </ScaleIn>
        )
      }
      if (TEAM_TOOL_NAMES.has(block.name)) {
        const result = toolResults?.get(block.id)
        return (
          <FadeIn key={key} className="w-full">
            <TeamEventCard name={block.name} input={block.input} output={result?.content} />
          </FadeIn>
        )
      }
      if (block.name === TASK_TOOL_NAME) {
        if (block.input.run_in_background) {
          const result = toolResults?.get(block.id)
          return (
            <FadeIn key={key} className="w-full">
              <TeamEventCard name={block.name} input={block.input} output={result?.content} />
            </FadeIn>
          )
        }
        const result = toolResults?.get(block.id)
        return (
          <ScaleIn key={key} className="w-full origin-left">
            <SubAgentCard
              name={block.name}
              toolUseId={block.id}
              input={block.input}
              output={result?.content}
              isLive={!!isStreaming}
            />
          </ScaleIn>
        )
      }
      if (['Write', 'Edit', 'Delete'].includes(block.name)) {
        const result = toolResults?.get(block.id)
        const liveTc = effectiveLiveToolCallMap?.get(block.id)
        return (
          <ScaleIn key={key} className="w-full origin-left">
            <FileChangeCard
              name={block.name}
              input={block.input}
              output={liveTc?.output ?? result?.content}
              status={liveTc?.status ?? (result?.isError ? 'error' : 'completed')}
              error={liveTc?.error}
              startedAt={liveTc?.startedAt}
              completedAt={liveTc?.completedAt}
              trackedChange={trackedChangeByToolUseId.get(block.id)}
            />
          </ScaleIn>
        )
      }
      if (block.name === IMAGE_GENERATE_TOOL_NAME) {
        const result = toolResults?.get(block.id)
        const liveTc = effectiveLiveToolCallMap?.get(block.id)
        return (
          <ScaleIn key={key} className="w-full origin-left">
            <ImagePluginToolCard
              toolUseId={block.id}
              input={liveTc?.input ?? block.input}
              output={liveTc?.output ?? result?.content}
              status={liveTc?.status ?? (result?.isError ? 'error' : 'completed')}
              error={liveTc?.error}
            />
          </ScaleIn>
        )
      }
      if (
        block.name === DESKTOP_SCREENSHOT_TOOL_NAME ||
        block.name === DESKTOP_CLICK_TOOL_NAME ||
        block.name === DESKTOP_TYPE_TOOL_NAME ||
        block.name === DESKTOP_SCROLL_TOOL_NAME ||
        block.name === DESKTOP_WAIT_TOOL_NAME
      ) {
        const result = toolResults?.get(block.id)
        const liveTc = effectiveLiveToolCallMap?.get(block.id)
        return (
          <ScaleIn key={key} className="w-full origin-left">
            <DesktopActionToolCard
              name={block.name}
              input={block.input}
              output={liveTc?.output ?? result?.content}
              status={liveTc?.status ?? (result?.isError ? 'error' : 'completed')}
              error={liveTc?.error}
            />
          </ScaleIn>
        )
      }
      // Generic ToolCallCard
      const result = toolResults?.get(block.id)
      const liveTc = effectiveLiveToolCallMap?.get(block.id)
      return (
        <ScaleIn key={key} className="w-full origin-left">
          <ToolCallCard
            toolUseId={block.id}
            name={block.name}
            input={block.input}
            output={liveTc?.output ?? result?.content}
            status={liveTc?.status ?? (result?.isError ? 'error' : 'completed')}
            error={liveTc?.error}
            startedAt={liveTc?.startedAt}
            completedAt={liveTc?.completedAt}
          />
        </ScaleIn>
      )
    }

    if (renderMode === 'default' && foregroundSubAgentTaskBlocks.length > 0) {
      return (
        <div className="space-y-2">
          {foregroundSubAgentTaskBlocks.map((block) => renderToolBlock(block, block.id))}
        </div>
      )
    }

    return (
      <div className="space-y-2">
        {structuredToolCount >= 2 && (
          <button
            onClick={() => setToolsCollapsed((v) => !v)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted-foreground/10 transition-colors"
          >
            {toolsCollapsed ? (
              <ChevronsUpDown className="size-3" />
            ) : (
              <ChevronsDownUp className="size-3" />
            )}
            {toolsCollapsed
              ? t('assistantMessage.showToolCalls', { count: structuredToolCount })
              : t('assistantMessage.collapseToolCalls', { count: structuredToolCount })}
          </button>
        )}
        {renderItems.map((item) => {
          if (item.kind === 'block') {
            const block = normalizedContent[item.index]
            switch (block.type) {
              case 'thinking':
                return (
                  <ThinkingBlock
                    key={item.index}
                    thinking={stripThinkTagMarkers(block.thinking)}
                    isStreaming={isStreaming}
                    startedAt={block.startedAt}
                    completedAt={block.completedAt}
                  />
                )
              case 'text': {
                // When provider already streamed structured thinking blocks, ignore any
                // duplicated <think>...</think> segments embedded in text blocks.
                if (hasStructuredThinkingBlocks) {
                  const visibleText = stripThinkTags(block.text)
                  if (!visibleText.trim()) return null
                  return (
                    <div key={item.index} className={MARKDOWN_WRAPPER_CLASS}>
                      <StreamingMarkdownContent
                        text={visibleText}
                        isStreaming={item.index === lastStructuredTextIdx}
                      />
                    </div>
                  )
                }

                const textSegments = parseThinkTags(block.text)
                const hasThinkInBlock = textSegments.some((s) => s.type === 'think')
                if (!hasThinkInBlock) {
                  return (
                    <div key={item.index} className={MARKDOWN_WRAPPER_CLASS}>
                      <StreamingMarkdownContent
                        text={block.text}
                        isStreaming={item.index === lastStructuredTextIdx}
                      />
                    </div>
                  )
                }
                const isBlockStreaming = !!(isStreaming && item.index === lastStructuredTextIdx)
                const lastTxtSeg = textSegments.reduce(
                  (acc: number, s, j) => (s.type === 'text' ? j : acc),
                  -1
                )
                return (
                  <div key={item.index}>
                    {textSegments.map((seg, j) => {
                      if (seg.type === 'think') {
                        return (
                          <ThinkingBlock
                            key={j}
                            thinking={stripThinkTagMarkers(seg.content)}
                            isStreaming={isBlockStreaming && !seg.closed}
                          />
                        )
                      }
                      return (
                        <div key={j} className={MARKDOWN_WRAPPER_CLASS}>
                          <StreamingMarkdownContent
                            text={seg.content}
                            isStreaming={isBlockStreaming && j === lastTxtSeg}
                          />
                        </div>
                      )
                    })}
                  </div>
                )
              }
              case 'image': {
                const imgBlock = block as Extract<ContentBlock, { type: 'image' }>
                const imgSrc =
                  imgBlock.source.type === 'base64'
                    ? `data:${imgBlock.source.mediaType};base64,${imgBlock.source.data}`
                    : (imgBlock.source.url ?? '')
                if (!imgSrc) return null
                return (
                  <ScaleIn key={item.index} className="w-full origin-left">
                    <ImagePreview
                      src={imgSrc}
                      alt="Generated image"
                      filePath={imgBlock.source.filePath}
                    />
                  </ScaleIn>
                )
              }
              case 'image_error': {
                const imageError = block as Extract<ContentBlock, { type: 'image_error' }>
                return (
                  <ScaleIn key={item.index} className="w-full origin-left">
                    <ImageGenerationErrorCard code={imageError.code} message={imageError.message} />
                  </ScaleIn>
                )
              }
              case 'tool_use':
                return renderToolBlock(block, block.id)
              default:
                return null
            }
          }

          // kind === 'group': render grouped tool calls
          if (toolsCollapsed) return null
          const groupBlocks = item.indices.map(
            (idx) => normalizedContent[idx] as Extract<ContentBlock, { type: 'tool_use' }>
          )
          const groupKey = `group-${item.indices[0]}`

          // Single item in group — render directly without wrapper
          if (groupBlocks.length === 1) {
            const block = groupBlocks[0]
            const result = toolResults?.get(block.id)
            const liveTc = effectiveLiveToolCallMap?.get(block.id)
            return (
              <ScaleIn key={block.id} className="w-full origin-left">
                <ToolCallCard
                  toolUseId={block.id}
                  name={block.name}
                  input={block.input}
                  output={liveTc?.output ?? result?.content}
                  status={liveTc?.status ?? (result?.isError ? 'error' : 'completed')}
                  error={liveTc?.error}
                  startedAt={liveTc?.startedAt}
                  completedAt={liveTc?.completedAt}
                />
              </ScaleIn>
            )
          }

          // Multiple items — wrap in ToolCallGroup
          const groupItems = groupBlocks.map((block) => {
            const result = toolResults?.get(block.id)
            const liveTc = effectiveLiveToolCallMap?.get(block.id)
            return {
              id: block.id,
              name: block.name,
              input: block.input,
              output: liveTc?.output ?? result?.content,
              status: (liveTc?.status ?? (result?.isError ? 'error' : 'completed')) as
                | import('@renderer/lib/agent/types').ToolCallStatus
                | 'completed',
              error: liveTc?.error,
              startedAt: liveTc?.startedAt,
              completedAt: liveTc?.completedAt
            }
          })

          return (
            <ScaleIn key={groupKey} className="w-full origin-left">
              <ToolCallGroup toolName={item.toolName} items={groupItems}>
                {groupBlocks.map((block) => {
                  const result = toolResults?.get(block.id)
                  const liveTc = effectiveLiveToolCallMap?.get(block.id)
                  return (
                    <ToolCallCard
                      key={block.id}
                      toolUseId={block.id}
                      name={block.name}
                      input={block.input}
                      output={liveTc?.output ?? result?.content}
                      status={liveTc?.status ?? (result?.isError ? 'error' : 'completed')}
                      error={liveTc?.error}
                      startedAt={liveTc?.startedAt}
                      completedAt={liveTc?.completedAt}
                    />
                  )
                })}
              </ToolCallGroup>
            </ScaleIn>
          )
        })}
        {isStreaming && (
          <span className="inline-block w-1.5 h-4 bg-primary/70 animate-pulse ml-0.5 rounded-sm" />
        )}
      </div>
    )
  }

  const plainText =
    typeof content === 'string'
      ? stripThinkTags(content)
      : Array.isArray(content)
        ? content
            .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => stripThinkTags(b.text))
            .join('\n')
        : ''

  const handleCopy = useCallback((): void => {
    if (!plainText) return
    navigator.clipboard.writeText(plainText)
  }, [plainText])

  const handleTranslate = useCallback((): void => {
    const text = plainText.trim()
    if (!text) return
    setTranslateSourceText(text)
    openTranslatePage()
    toast.success(t('messageActions.sentToTranslator'))
  }, [openTranslatePage, plainText, setTranslateSourceText, t])

  const handleSpeak = useCallback((): void => {
    const text = plainText.trim()
    if (!text) return
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      toast.error(t('messageActions.speechNotSupported'))
      return
    }
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = /[\u4e00-\u9fff]/.test(text) ? 'zh-CN' : 'en-US'
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utterance)
  }, [plainText, t])

  const handleShare = useCallback(async (): Promise<void> => {
    const text = plainText.trim()
    if (!text) return
    try {
      if (navigator.share) {
        await navigator.share({ text })
        return
      }
      await navigator.clipboard.writeText(text)
      toast.success(t('messageActions.copiedForShare'))
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      toast.error(t('messageActions.shareFailed'))
    }
  }, [plainText, t])

  const handleDeleteAndRegenerate = useCallback((): void => {
    if (!showRetry || !onRetry) return
    onRetry()
  }, [onRetry, showRetry])

  const timingSummary = useMemo(() => {
    if (!usage) return null
    const totalDuration = usage.totalDurationMs ? formatMs(usage.totalDurationMs) : null
    const perRequest = usage.requestTimings ?? []
    const lastTiming = perRequest.length > 0 ? perRequest[perRequest.length - 1] : null
    if (!totalDuration && !lastTiming) return null

    let lastDetail: string | null = null
    if (lastTiming) {
      const parts: string[] = []
      parts.push(
        `${t('assistantMessage.req', { count: perRequest.length })} ${formatMs(lastTiming.totalMs)}`
      )
      if (lastTiming.ttftMs !== undefined)
        parts.push(`${t('assistantMessage.ttft')} ${formatMs(lastTiming.ttftMs)}`)
      if (lastTiming.tps !== undefined)
        parts.push(`${t('assistantMessage.tps')} ${lastTiming.tps.toFixed(1)}`)
      lastDetail = parts.join(' · ')
    }

    return {
      totalDuration,
      lastDetail
    }
  }, [t, usage])

  const requestTrace = msgId ? getRequestTraceInfo(msgId) : undefined
  const tracedProvider = useProviderStore((s) => {
    const pid = requestTrace?.providerId
    return pid ? (s.providers.find((p) => p.id === pid) ?? null) : null
  })
  const tracedModelId = requestTrace?.model
  const tracedModelCfg = tracedProvider?.models.find((m) => m.id === tracedModelId)
  const modelDisplayName =
    tracedModelCfg?.name ||
    tracedModelId
      ?.split('/')
      .pop()
      ?.replace(/-\d{8}$/, '') ||
    'Assistant'

  return (
    <div className="group/msg flex gap-3">
      <Avatar className="size-7 shrink-0 ring-1 ring-border/50">
        <AvatarFallback className="bg-gradient-to-br from-secondary to-muted text-secondary-foreground text-xs">
          <ModelIcon
            icon={tracedModelCfg?.icon}
            modelId={tracedModelId}
            providerBuiltinId={tracedProvider?.builtinId ?? requestTrace?.providerBuiltinId}
            size={16}
          />
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 pt-0.5 overflow-hidden">
        <div className="mb-1 flex items-center gap-2">
          <p className="text-sm font-medium">{modelDisplayName}</p>
        </div>
        {collapsed ? (
          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            <div className="max-h-10 overflow-hidden whitespace-pre-wrap break-words">
              {plainText.trim() || t('messageActions.collapsedMessage')}
            </div>
          </div>
        ) : (
          <>
            {renderContent()}
            {!isStreaming && runChangeSet && runChangeSet.changes.length > 0 && (
              <RunChangeReviewCard runId={runChangeSet.runId} changeSet={runChangeSet} />
            )}
            {!isStreaming && plainText && (
              <p className="mt-1 text-[10px] text-muted-foreground/40 tabular-nums">
                {usage
                  ? (() => {
                      const u = usage!
                      const provider = requestTrace?.providerId
                        ? useProviderStore
                            .getState()
                            .providers.find((item) => item.id === requestTrace.providerId)
                        : null
                      const modelCfg =
                        provider?.models.find((item) => item.id === requestTrace?.model) ?? null
                      const total = getBillableTotalTokens(u, modelCfg?.type)
                      const billableInput = getBillableInputTokens(u, modelCfg?.type)
                      const cost = calculateCost(u, modelCfg)
                      return (
                        <>
                          {`${formatTokens(total)} ${t('unit.tokens', { ns: 'common' })} (${formatTokens(billableInput)}↓ ${formatTokens(u.outputTokens)}↑`}
                          {u.cacheReadTokens
                            ? ` · ${formatTokens(u.cacheReadTokens)} ${t('unit.cached', { ns: 'common' })}`
                            : ''}
                          {u.reasoningTokens
                            ? ` · ${formatTokens(u.reasoningTokens)} ${t('unit.reasoning', { ns: 'common' })}`
                            : ''}
                          {')'}
                          {cost !== null && (
                            <span className="text-emerald-500/70"> · {formatCost(cost)}</span>
                          )}
                        </>
                      )
                    })()
                  : `~${formatTokens(fallbackTokens)} ${t('unit.tokens', { ns: 'common' })}`}
              </p>
            )}
            {!isStreaming && timingSummary && (
              <div className="mt-1 space-y-0.5 text-[10px] text-muted-foreground/40 tabular-nums">
                {timingSummary.totalDuration && (
                  <div>
                    {t('assistantMessage.totalDuration', { duration: timingSummary.totalDuration })}
                  </div>
                )}
                {timingSummary.lastDetail && <div>{timingSummary.lastDetail}</div>}
              </div>
            )}
          </>
        )}
        {!isStreaming &&
          (plainText ||
            (msgId && onDelete) ||
            (devMode && debugInfo) ||
            (showRetry && onRetry)) && (
            <div className="mt-2 flex items-center gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100">
              {plainText && (
                <ActionIconButton
                  label={t('action.copy', { ns: 'common' })}
                  icon={<Copy className="size-3.5" />}
                  onClick={handleCopy}
                />
              )}
              {showRetry && onRetry ? (
                <ActionIconButton
                  label={t('assistantMessage.regenerateReference', {
                    defaultValue: '重新生成参考'
                  })}
                  icon={<RotateCcw className="size-3.5" />}
                  onClick={onRetry}
                />
              ) : null}
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={t('action.showMore', { ns: 'common' })}
                        className="flex size-7 items-center justify-center rounded-md border border-border/50 bg-background/80 text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
                      >
                        <Ellipsis className="size-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {t('action.showMore', { ns: 'common' })}
                  </TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuItem onSelect={handleCopy} disabled={!plainText.trim()}>
                    <Copy className="size-4" />
                    {t('action.copy', { ns: 'common' })}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleTranslate} disabled={!plainText.trim()}>
                    <Languages className="size-4" />
                    {t('messageActions.translate')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleSpeak} disabled={!plainText.trim()}>
                    <Volume2 className="size-4" />
                    {t('messageActions.readAloud')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => void handleShare()}
                    disabled={!plainText.trim()}
                  >
                    <Share2 className="size-4" />
                    {t('messageActions.share')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setCollapsed((value) => !value)}>
                    {collapsed ? (
                      <ChevronsDownUp className="size-4" />
                    ) : (
                      <ChevronsUpDown className="size-4" />
                    )}
                    {collapsed ? t('messageActions.expand') : t('messageActions.collapse')}
                  </DropdownMenuItem>
                  {showRetry && onRetry && (
                    <DropdownMenuItem onSelect={onRetry}>
                      <RotateCcw className="size-4" />
                      {t('assistantMessage.regenerateReference', {
                        defaultValue: '重新生成参考'
                      })}
                    </DropdownMenuItem>
                  )}
                  {showRetry && onRetry && (
                    <DropdownMenuItem onSelect={handleDeleteAndRegenerate}>
                      <RotateCcw className="size-4" />
                      {t('messageActions.deleteAndRegenerate')}
                    </DropdownMenuItem>
                  )}
                  {msgId && onDelete && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onSelect={() => onDelete(msgId)}>
                        <Trash2 className="size-4" />
                        {t('action.delete', { ns: 'common' })}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              {devMode && debugInfo && <DebugToggleButton debugInfo={debugInfo} />}
            </div>
          )}
      </div>
    </div>
  )
}
