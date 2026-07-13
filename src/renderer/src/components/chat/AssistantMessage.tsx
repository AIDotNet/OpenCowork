import * as React from 'react'
import { useState, useCallback, useMemo, useEffect, useId, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import Markdown, { type Components } from 'react-markdown'
import {
  applyMermaidTheme,
  copyMermaidToClipboard,
  useMermaidThemeVersion
} from '@renderer/lib/utils/mermaid-theme'
import {
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Bug,
  ImageDown,
  ZoomIn,
  Trash2,
  RotateCcw,
  Play,
  Loader2,
  CheckCircle2,
  Ellipsis,
  Eraser,
  Languages,
  Pencil,
  Volume2,
  Share2,
  GitFork,
  CircleHelp
} from 'lucide-react'
import { FadeIn, ScaleIn } from '@renderer/components/animate-ui'
import { AnimatePresence, motion } from 'motion/react'
import { cn } from '@renderer/lib/utils'
import { WebSearchBlock } from './WebSearchBlock'
import { ImageGeneratingLoader } from './ImageGeneratingLoader'
import { ImageGenerationErrorCard } from './ImageGenerationErrorCard'
import { AgentErrorCard } from './AgentErrorCard'
import { ImagePreview } from './ImagePreview'
import { ImagePluginToolCard } from './ImagePluginToolCard'
import { DesktopActionToolCard } from './DesktopActionToolCard'
import { BrowserToolCard } from './BrowserToolCard'
import { useChatStore } from '@renderer/stores/chat-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import type { AgentRunChangeSet, AgentRunFileChange } from '@renderer/stores/agent-store'
import { useShallow } from 'zustand/react/shallow'
import type {
  ContentBlock,
  UnifiedMessage,
  TokenUsage,
  ToolResultContent,
  RequestDebugInfo,
  MessageMeta
} from '@renderer/lib/api/types'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { ToolCallCard, WidgetOutputBlock } from './ToolCallCard'
import { FileChangeCard } from './FileChangeCard'
import { BashArtifactsCard } from './BashArtifactsCard'
import { SubAgentCard } from './SubAgentCard'
import { ThinkingBlock } from './ThinkingBlock'
import { CollapsibleHeightPanel } from './CollapsibleHeightPanel'
import { TeamEventCard } from './TeamEventCard'
import { AskUserQuestionCard } from './AskUserQuestionCard'
import { OrchestrationBlock } from './OrchestrationBlock'
import { PlanReviewCard } from './PlanReviewCard'
import { ContextCompressionMessage } from './ContextCompressionMessage'
import type { OrchestrationRun } from '@renderer/lib/orchestration/types'
import { TASK_TOOL_NAME } from '@renderer/lib/agent/sub-agents/create-tool'
import { TEAM_TOOL_NAMES } from '@renderer/lib/agent/teams/register'
import { useProviderStore } from '@renderer/stores/provider-store'
import {
  getBillableInputTokens,
  getCacheCreationTokens,
  getUsageCacheHitRate,
  formatCacheHitRate
} from '@renderer/lib/format-tokens'
import { formatDurationMs } from '@renderer/lib/format-duration'
import { useMemoizedTokens } from '@renderer/hooks/use-estimated-tokens'
import { getLastDebugInfo, getRequestTraceInfo } from '@renderer/lib/debug-store'
import { readSidecarDebugBody } from '@renderer/lib/ipc/agent-bridge'
import { MONO_FONT } from '@renderer/lib/constants'
import {
  getLiveOutputComponentClass,
  getLiveOutputCursorClass
} from '@renderer/lib/live-output-animation'
import type { RequestRetryState, ToolCallState, ToolCallStatus } from '@renderer/lib/agent/types'
import {
  DESKTOP_CLICK_TOOL_NAME,
  DESKTOP_SCREENSHOT_TOOL_NAME,
  DESKTOP_SCROLL_TOOL_NAME,
  DESKTOP_TYPE_TOOL_NAME,
  DESKTOP_WAIT_TOOL_NAME,
  IMAGE_GENERATE_TOOL_NAME
} from '@renderer/lib/app-plugin/types'
import { isBrowserToolName } from '@renderer/lib/app-plugin/browser-tool-names'
import { LazySyntaxHighlighter } from './LazySyntaxHighlighter'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { aggregateDisplayableRunFileChanges } from './file-change-utils'
import type { AggregatedFileChange } from './file-change-utils'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import {
  buildToolExecutionOutline,
  isHiddenExecutionToolName,
  isOrdinaryContextToolName,
  type ToolExecutionItem,
  type ToolExecutionRun
} from './execution-outline'
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
import { useStreamingRenderPool } from '@renderer/hooks/use-typewriter'
import { useStreamingMarkdownBlocks } from '@renderer/hooks/use-streaming-markdown-blocks'
import {
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS,
  openMarkdownHref,
  resolveLocalFilePath,
  openLocalFilePath
} from '@renderer/lib/preview/viewers/markdown-components'
import { imageBlockToAttachment } from '@renderer/lib/image-attachments'
import { useImageEditStore } from '@renderer/stores/image-edit-store'
import { ModelIcon } from '@renderer/components/settings/provider-icons'
import { isMcpTool } from '@renderer/lib/mcp/mcp-tools'

type AssistantRenderMode = 'default' | 'transcript' | 'static'

interface AssistantMessageProps {
  content: string | ContentBlock[]
  isStreaming?: boolean
  usage?: TokenUsage
  toolResults?: Map<string, { content: ToolResultContent; isError?: boolean }>
  liveToolCallMap?: Map<string, ToolCallState> | null
  inlineCompactSummaries?: readonly UnifiedMessage[]
  msgId?: string
  sessionId?: string | null
  sessionAssistantMessageIds?: readonly string[]
  sessionToolUseIds?: readonly string[]
  showRetry?: boolean
  showContinue?: boolean
  isLastAssistantMessage?: boolean
  onRetry?: (messageId: string) => void
  onContinue?: () => void
  onDelete?: (messageId: string) => void
  renderMode?: AssistantRenderMode
  orchestrationRun?: OrchestrationRun | null
  hiddenToolUseIds?: Set<string>
  requestRetryState?: RequestRetryState | null
  requestDebugInfo?: RequestDebugInfo
  meta?: MessageMeta
}

type AssistantRenderItem = { kind: 'block'; index: number } | { kind: 'tool-run'; runId: string }

type AssistantRenderItemWithInlineSummary =
  | AssistantRenderItem
  | { kind: 'compact-summary'; message: UnifiedMessage }

interface InlineCompactSummaryEntry {
  message: UnifiedMessage
  afterContentBlockCount: number
  afterNormalizedBlockIndex: number
  afterToolUseId?: string
}

interface ModelThinkingIndicatorProps {
  modelName: string
  label: string
}

const MARKDOWN_WRAPPER_CLASS = 'text-sm leading-relaxed text-foreground break-words'
const THINK_OPEN_TAG_RE = /<\s*think\s*>/i
const EMPTY_LIVE_TOOL_CALLS: ToolCallState[] = []
// Stable defaults for optional array props: a `= []` inline default creates a
// new reference on every render, which retriggers the run-change refresh
// effect (its memoized deps chain off these) in a render/fetch loop.
const EMPTY_INLINE_COMPACT_SUMMARIES: readonly UnifiedMessage[] = []
const EMPTY_ID_LIST: readonly string[] = []

function formatRetryDelay(delayMs: number): string {
  if (delayMs < 1000) return `${delayMs}ms`
  if (delayMs < 10_000) return `${(delayMs / 1000).toFixed(1)}s`
  return `${Math.round(delayMs / 1000)}s`
}

function resolveToolCallStatus(
  isStreaming: boolean | undefined,
  liveToolCall: ToolCallState | undefined,
  result?: { isError?: boolean }
): ToolCallStatus | 'completed' {
  if (result) return result.isError ? 'error' : 'completed'
  if (liveToolCall?.status) return liveToolCall.status
  return isStreaming ? 'streaming' : 'canceled'
}

function resolvePendingToolCallStatus(
  isRunningFallback: boolean | undefined,
  liveToolCall: ToolCallState | undefined,
  result?: { isError?: boolean; content?: ToolResultContent }
): ToolCallStatus | 'completed' {
  if (result) return result.isError ? 'error' : 'completed'
  if (liveToolCall?.status) return liveToolCall.status
  return isRunningFallback ? 'running' : 'canceled'
}

function getWidgetRenderCode(input?: Record<string, unknown>): string {
  if (!input) return ''
  if (typeof input.widget_code === 'string') return input.widget_code
  if (typeof input.widget_code_preview === 'string') return input.widget_code_preview
  return ''
}

function mergeWidgetToolInput(
  blockInput: Record<string, unknown>,
  liveInput?: Record<string, unknown>
): Record<string, unknown> {
  if (!liveInput || Object.keys(liveInput).length === 0) return blockInput
  if (!blockInput || Object.keys(blockInput).length === 0) return liveInput

  const merged: Record<string, unknown> = { ...blockInput, ...liveInput }
  const blockCode = getWidgetRenderCode(blockInput)
  const liveCode = getWidgetRenderCode(liveInput)

  if (blockCode && (!liveCode || blockCode.length > liveCode.length)) {
    if (typeof blockInput.widget_code === 'string') {
      merged.widget_code = blockInput.widget_code
    } else if (typeof blockInput.widget_code_preview === 'string') {
      merged.widget_code_preview = blockInput.widget_code_preview
    }
  }

  if (
    typeof blockInput.widget_code_chars === 'number' &&
    typeof liveInput.widget_code_chars === 'number'
  ) {
    merged.widget_code_chars = Math.max(blockInput.widget_code_chars, liveInput.widget_code_chars)
  }

  return merged
}

interface ToolCallRenderState {
  id: string
  toolUseId: string
  name: string
  input: Record<string, unknown>
  output?: ToolResultContent
  status: ToolCallStatus | 'completed'
  error?: string
  startedAt?: number
  completedAt?: number
}

function buildToolCallRenderState(
  block: Extract<ContentBlock, { type: 'tool_use' }>,
  options: {
    isStreaming?: boolean
    toolResults?: Map<string, { content: ToolResultContent; isError?: boolean }>
    liveToolCallMap?: Map<string, ToolCallState> | null
    executionItem?: ToolExecutionItem
  }
): ToolCallRenderState {
  const result = options.toolResults?.get(block.id)
  const liveToolCall = options.liveToolCallMap?.get(block.id)
  const liveInput = liveToolCall?.input
  const effectiveInput = liveInput && Object.keys(liveInput).length > 0 ? liveInput : block.input
  const status =
    options.executionItem?.status ??
    resolveToolCallStatus(options.isStreaming, liveToolCall, result)
  return {
    id: block.id,
    toolUseId: block.id,
    name: block.name,
    input: effectiveInput,
    output: result?.content ?? liveToolCall?.output,
    status,
    error: options.executionItem?.error ?? liveToolCall?.error,
    startedAt: liveToolCall?.startedAt,
    completedAt: liveToolCall?.completedAt
  }
}

function shouldShowToolInMessageList(name: string): boolean {
  return !isHiddenExecutionToolName(name)
}

interface BashArtifactEntry {
  path: string
  size: number
}

function decodeBashArtifacts(
  output: ToolResultContent | undefined
): { artifacts: BashArtifactEntry[]; truncated?: number } | null {
  if (typeof output !== 'string') return null
  const decoded = decodeStructuredToolResult(output)
  if (!decoded || Array.isArray(decoded)) return null
  const artifacts = decoded.artifacts
  if (!Array.isArray(artifacts) || artifacts.length === 0) return null

  const entries = artifacts.filter(
    (entry): entry is BashArtifactEntry =>
      !!entry &&
      typeof entry === 'object' &&
      typeof (entry as BashArtifactEntry).path === 'string' &&
      typeof (entry as BashArtifactEntry).size === 'number'
  )
  if (entries.length === 0) return null

  const truncated =
    typeof decoded.artifactsTruncated === 'number' ? decoded.artifactsTruncated : undefined
  return { artifacts: entries, truncated }
}

function isWorkspaceCollapsibleTool(name: string): boolean {
  return shouldShowToolInMessageList(name) && isOrdinaryContextToolName(name)
}

function summarizeWorkspaceTools(
  blocks: ContentBlock[] | null,
  t: (key: string, options?: Record<string, unknown>) => string,
  options: {
    aggregatedChanges?: AggregatedFileChange[]
    toolResults?: Map<string, { content: ToolResultContent; isError?: boolean }>
    liveToolCallMap?: Map<string, ToolCallState> | null
    shouldIncludeTool?: (block: Extract<ContentBlock, { type: 'tool_use' }>) => boolean
  } = {}
): string {
  if (!blocks) return ''

  const counts = new Map<string, number>()
  const createdPaths = new Set<string>()
  const editedPaths = new Set<string>()
  const deletedPaths = new Set<string>()

  const toolResultText = (content: ToolResultContent | undefined): string | null => {
    if (!content) return null
    if (typeof content === 'string') return content
    const text = content
      .filter((block) => block.type === 'text')
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n')
      .trim()
    return text || null
  }

  const inferWriteKind = (
    block: Extract<ContentBlock, { type: 'tool_use' }>
  ): 'create' | 'edit' => {
    const output =
      options.liveToolCallMap?.get(block.id)?.output ?? options.toolResults?.get(block.id)?.content
    const outputText = toolResultText(output)
    if (outputText) {
      const decoded = decodeStructuredToolResult(outputText)
      if (isRecord(decoded) && decoded.op === 'modify') {
        return 'edit'
      }
    }
    return 'create'
  }

  const isFailedFileTool = (block: Extract<ContentBlock, { type: 'tool_use' }>): boolean => {
    const liveToolCall = options.liveToolCallMap?.get(block.id)
    if (liveToolCall?.status === 'error' || liveToolCall?.error) return true

    const result = options.toolResults?.get(block.id)
    if (result?.isError) return true

    const outputText = toolResultText(liveToolCall?.output ?? result?.content)
    if (!outputText) return false

    const decoded = decodeStructuredToolResult(outputText)
    if (!isRecord(decoded) || typeof decoded.error !== 'string') return false

    return decoded.success === false || Object.keys(decoded).length === 1
  }

  for (const change of options.aggregatedChanges ?? []) {
    if (change.op === 'create') {
      createdPaths.add(change.filePath)
    } else {
      editedPaths.add(change.filePath)
    }
  }

  for (const block of blocks) {
    if (block.type !== 'tool_use' || !isWorkspaceCollapsibleTool(block.name)) continue
    if (options.shouldIncludeTool && !options.shouldIncludeTool(block)) continue
    counts.set(block.name, (counts.get(block.name) ?? 0) + 1)

    const filePath = block.input.file_path ?? block.input.path
    if (typeof filePath !== 'string' || !filePath.trim()) continue

    if (['Write', 'Edit', 'Delete'].includes(block.name) && isFailedFileTool(block)) {
      continue
    }

    if (block.name === 'Delete') {
      deletedPaths.add(filePath)
      continue
    }

    if ((options.aggregatedChanges?.length ?? 0) > 0) continue

    if (block.name === 'Edit') {
      editedPaths.add(filePath)
      continue
    }

    if (block.name === 'Write') {
      if (inferWriteKind(block) === 'edit') {
        editedPaths.add(filePath)
      } else {
        createdPaths.add(filePath)
      }
    }
  }

  const parts: string[] = []
  const createdCount = createdPaths.size
  const editedCount = editedPaths.size
  const deletedCount = deletedPaths.size
  const changedFileCount = createdCount + editedCount + deletedCount

  if (createdCount > 0) {
    parts.push(t('assistantMessage.createdFiles', { count: createdCount }))
  }
  if (editedCount > 0) {
    parts.push(t('assistantMessage.editedFiles', { count: editedCount }))
  }
  if (deletedCount > 0) {
    parts.push(t('assistantMessage.deletedFiles', { count: deletedCount }))
  }
  if (parts.length === 0 && changedFileCount > 0) {
    parts.push(t('assistantMessage.changedFiles', { count: changedFileCount }))
  }

  const commandCount =
    (counts.get('Bash') ?? 0) + (counts.get('Shell') ?? 0) + (counts.get('PowerShell') ?? 0)
  if (commandCount > 0) parts.push(t('assistantMessage.ranCommandsInline', { count: commandCount }))

  const readCount = counts.get('Read') ?? 0
  if (readCount > 0) {
    parts.push(t('toolGroup.readActions', { count: readCount, defaultValue: '读取 {{count}} 次' }))
  }

  const searchCount = (counts.get('Grep') ?? 0) + (counts.get('Glob') ?? 0)
  if (searchCount > 0) {
    parts.push(
      t('toolGroup.searchActions', { count: searchCount, defaultValue: '搜索 {{count}} 次' })
    )
  }

  const listDirCount = counts.get('LS') ?? 0
  if (listDirCount > 0) {
    parts.push(
      t('toolGroup.listDirActions', { count: listDirCount, defaultValue: '列目录 {{count}} 次' })
    )
  }

  const mcpCallCount = [...counts.entries()].reduce(
    (total, [name, count]) => total + (isMcpTool(name) ? count : 0),
    0
  )
  if (mcpCallCount > 0) {
    parts.push(
      t('toolGroup.mcpCalls', { count: mcpCallCount, defaultValue: '调用 MCP {{count}} 次' })
    )
  }

  const coveredTools = new Set([
    'Write',
    'Edit',
    'Delete',
    'NotebookEdit',
    'SavePlan',
    'Bash',
    'Shell',
    'PowerShell',
    'Read',
    'Grep',
    'Glob',
    'LS'
  ])
  const fallbackEntries = [...counts.entries()]
    .filter(([name]) => !coveredTools.has(name) && !isMcpTool(name))
    .sort(([a], [b]) => a.localeCompare(b))
  parts.push(...fallbackEntries.map(([name, count]) => `${name}${count > 1 ? ` x${count}` : ''}`))

  const visibleParts = parts.slice(0, 3)
  const summary = visibleParts.join(t('assistantMessage.summarySeparator', { defaultValue: ', ' }))
  const hiddenKinds = parts.length - visibleParts.length

  return hiddenKinds > 0
    ? `${summary}${t('assistantMessage.summarySeparator', { defaultValue: ', ' })}${t(
        'assistantMessage.moreKinds',
        {
          count: hiddenKinds,
          defaultValue: `+${hiddenKinds}`
        }
      )}`
    : summary
}

function stripThinkTagMarkers(text: string): string {
  return text.replace(/<\s*\/?\s*think\s*>/gi, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

interface CompletionTokenSegment {
  key: string
  label: string
  value: number
  color: string
}

interface CompletionDetailRow {
  key: string
  label: string
  value: string
  color?: string
  hint?: string
}

interface CompletionSummaryData {
  totalTokens: number
  totalValue: string
  estimated: boolean
  modelName?: string | null
  modelId?: string | null
  modelIcon?: string
  providerName?: string | null
  providerBuiltinId?: string
  segments: CompletionTokenSegment[]
  tokenRows: CompletionDetailRow[]
  metricRows: CompletionDetailRow[]
}

function formatTokenMetric(value: number): string {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0
  if (safeValue < 1_000) return String(Math.round(safeValue))
  if (safeValue < 1_000_000) return `${(safeValue / 1_000).toFixed(1)}K`
  return `${(safeValue / 1_000_000).toFixed(safeValue < 10_000_000 ? 2 : 1)}M`
}

function formatPreciseDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)}s`
  return formatDurationMs(ms)
}

function formatThroughput(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return value >= 100 ? value.toFixed(1) : value.toFixed(2)
}

function CompletionTokenSummary({
  summary
}: {
  summary: CompletionSummaryData
}): React.JSX.Element {
  const { t } = useTranslation('chat')
  const totalForSegments = summary.segments.reduce((sum, segment) => sum + segment.value, 0)
  const showDetails = summary.tokenRows.length > 0 || summary.metricRows.length > 0
  const triggerTitle = t('assistantMessage.tokenTotal', {
    defaultValue: 'Token total'
  })
  const trigger = (
    <button
      type="button"
      className="inline-flex h-5 items-center rounded-md px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground/58 transition-colors hover:bg-muted/45 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50 dark:hover:bg-white/[0.045]"
      title={`${triggerTitle}: ${new Intl.NumberFormat().format(summary.totalTokens)}`}
    >
      {summary.estimated ? '~' : ''}
      {summary.totalValue}
    </button>
  )

  return (
    <div className="mt-1.5 flex justify-end">
      {!showDetails ? (
        trigger
      ) : (
        <HoverCard openDelay={120} closeDelay={120}>
          <HoverCardTrigger asChild>{trigger}</HoverCardTrigger>
          <HoverCardContent
            side="top"
            align="end"
            sideOffset={6}
            className="w-[280px] rounded-lg border-[#262626] bg-[#101010] p-3 text-zinc-100 shadow-2xl"
          >
            <div className="mb-3 flex min-w-0 items-center gap-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[#232323] ring-1 ring-white/8">
                <ModelIcon
                  icon={summary.modelIcon}
                  modelId={summary.modelId ?? undefined}
                  providerBuiltinId={summary.providerBuiltinId}
                  size={18}
                />
              </span>
              <div className="min-w-0">
                <div className="truncate text-xs font-medium leading-4 text-zinc-100">
                  {summary.modelName ||
                    t('assistantMessage.tokenUsage', { defaultValue: 'Token usage' })}
                </div>
                {summary.providerName || summary.modelId ? (
                  <div className="truncate text-[10px] leading-3 text-zinc-500">
                    {summary.providerName ?? summary.modelId}
                  </div>
                ) : null}
              </div>
            </div>

            {totalForSegments > 0 ? (
              <div className="mb-2 flex h-1.5 overflow-hidden rounded-full bg-zinc-700/85">
                {summary.segments.map((segment) => {
                  const width = Math.max(0, (segment.value / totalForSegments) * 100)
                  if (width <= 0) return null
                  return (
                    <span
                      key={segment.key}
                      className="h-full"
                      title={`${segment.label}: ${segment.value}`}
                      style={{ width: `${width}%`, backgroundColor: segment.color }}
                    />
                  )
                })}
              </div>
            ) : null}

            <div className="space-y-1">
              {summary.tokenRows.map((row) => (
                <div key={row.key} className="flex items-center justify-between gap-4 text-xs">
                  <span className="flex min-w-0 items-center gap-1.5 text-zinc-400">
                    {row.color ? (
                      <span
                        className="size-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: row.color }}
                      />
                    ) : null}
                    <span className="truncate">{row.label}</span>
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums text-zinc-100">
                    {row.value}
                  </span>
                </div>
              ))}
            </div>

            {summary.metricRows.length > 0 ? (
              <div className="mt-2 space-y-1 border-t border-white/9 pt-2">
                {summary.metricRows.map((row) => (
                  <div key={row.key} className="flex items-center justify-between gap-4 text-xs">
                    <span className="flex min-w-0 items-center gap-1.5 text-zinc-400">
                      <span className="truncate">{row.label}</span>
                      {row.hint ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <CircleHelp
                              className="size-3 shrink-0 text-zinc-500"
                              aria-label={row.hint}
                            />
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-[220px] text-center text-xs">
                            {row.hint}
                          </TooltipContent>
                        </Tooltip>
                      ) : null}
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums text-zinc-100">
                      {row.value}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </HoverCardContent>
        </HoverCard>
      )}
    </div>
  )
}

function CompletionSummaryBar({ summary }: { summary: CompletionSummaryData }): React.JSX.Element {
  return <CompletionTokenSummary summary={summary} />
}

function DebugToggleButton({
  debugInfo,
  sessionId
}: {
  debugInfo: RequestDebugInfo
  sessionId?: string | null
}): React.JSX.Element {
  const [show, setShow] = useState(false)
  const [bodyText, setBodyText] = useState<string | null>(null)
  const [bodyLoading, setBodyLoading] = useState(false)
  const [bodyLoadError, setBodyLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!show) {
      setBodyText(null)
      setBodyLoading(false)
      setBodyLoadError(null)
      return
    }

    let cancelled = false
    setBodyLoadError(null)

    if (debugInfo.body) {
      setBodyText(debugInfo.body)
      setBodyLoading(false)
      return
    }

    setBodyText(null)
    if (!debugInfo.bodyRef && !sessionId) {
      setBodyLoading(false)
      return
    }

    setBodyLoading(true)
    readSidecarDebugBody({ bodyRef: debugInfo.bodyRef, sessionId })
      .then((body) => {
        if (!cancelled) {
          setBodyText(body)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setBodyLoadError(error instanceof Error ? error.message : 'Debug body is unavailable')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBodyLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [debugInfo.body, debugInfo.bodyRef, sessionId, show])

  const bodyFormatted = (() => {
    if (!bodyText) return null
    try {
      return JSON.stringify(JSON.parse(bodyText), null, 2)
    } catch {
      return bodyText
    }
  })()

  return (
    <>
      <button
        type="button"
        onClick={() => setShow(true)}
        aria-label="Debug"
        title="Debug"
        className={`flex items-center gap-1 rounded px-1 py-0.5 text-[11px] transition-colors ${show ? 'bg-orange-500/10 text-orange-500' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'}`}
      >
        <Bug className="size-3.5" />
        <span>Debug</span>
      </button>
      <Dialog open={show} onOpenChange={setShow}>
        <DialogContent className="flex max-h-[80vh] max-w-[90vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
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
            <div>
              <div className="flex items-center justify-between border-b bg-muted/20 px-4 py-1.5">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Request Body
                </span>
                {bodyFormatted ? <CopyButton text={bodyFormatted} /> : null}
              </div>
              {bodyFormatted ? (
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
              ) : (
                <div className="px-4 py-3 text-[11px] text-muted-foreground">
                  {bodyLoading
                    ? 'Loading request body...'
                    : (bodyLoadError ?? 'Request body is unavailable')}
                </div>
              )}
            </div>
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
      type="button"
      onClick={handleCopy}
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
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
  danger = false,
  disabled = false
}: {
  label: string
  icon: ReactNode
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
          className={`flex size-7 items-center justify-center rounded-md border border-border/50 bg-background/90 text-muted-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50 ${danger ? 'hover:text-destructive' : 'hover:text-accent-foreground'}`}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}

function GenerationProcessLine({
  active,
  label,
  detail,
  expanded,
  collapsible = false,
  onClick
}: {
  active: boolean
  label: string
  detail?: string | null
  expanded?: boolean
  collapsible?: boolean
  onClick?: () => void
}): React.JSX.Element {
  const content = (
    <>
      <span
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full border bg-transparent',
          active
            ? 'border-sky-500/25 text-sky-600 dark:text-sky-300'
            : 'border-lime-500/25 text-lime-600 dark:text-lime-400'
        )}
      >
        {active ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3" />}
      </span>
      <span className="shrink-0 font-mono font-medium text-foreground/82">{label}</span>
      {detail ? (
        <span className="min-w-0 flex-1 truncate text-muted-foreground/60">({detail})</span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      {collapsible ? (
        expanded ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground" />
        )
      ) : null}
    </>
  )

  const className =
    'group flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] text-muted-foreground transition-colors hover:bg-muted/35 hover:text-foreground dark:hover:bg-white/[0.035]'

  if (collapsible) {
    return (
      <button type="button" onClick={onClick} aria-expanded={expanded} className={className}>
        {content}
      </button>
    )
  }

  return <div className={className}>{content}</div>
}

function ModelThinkingIndicator({
  modelName,
  label
}: ModelThinkingIndicatorProps): React.JSX.Element {
  const statusLabel = modelName ? `${modelName} ${label}` : label

  return (
    <div className="pending-assistant-status" role="status" aria-label={statusLabel}>
      <span className="pending-assistant-wave" aria-hidden="true">
        {[0, 1, 2, 3].map((index) => (
          <span
            key={index}
            className="pending-assistant-bar"
            style={{ animationDelay: `${index * 130}ms` }}
          />
        ))}
      </span>
      <span className="pending-assistant-label">{label}</span>
    </div>
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
      type="button"
      onClick={() => void handleCopy()}
      disabled={busy || !svg.trim()}
      title="Copy Mermaid diagram to clipboard"
      className="flex items-center rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
    >
      {copied ? <Check className="size-3" /> : <ImageDown className="size-3" />}
      <span>{copied ? 'Copied' : 'Download'}</span>
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
        const mermaid = await applyMermaidTheme()
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
            type="button"
            onClick={() => setZoomOpen(true)}
            disabled={!svg.trim()}
            title="Zoom in Mermaid diagram"
            className="flex items-center rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
          >
            <ZoomIn className="size-3" />
            <span>Zoom in</span>
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
            <DialogTitle>Mermaid zoom preview</DialogTitle>
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

// Hoisted once so react-markdown sees a stable `components` reference on every render;
// without this the Markdown AST was being fully rebuilt every time even when `text` was
// unchanged, because React was diffing on the components prop identity.

// isStreaming used to be captured via closure inside the inline `components` object,
// which forced us to recreate the whole object every render. We now pass it through a
// context so the components themselves can be module-level constants.
const IsStreamingContext = React.createContext(false)

type MarkdownCodeElementProps = {
  position?: {
    start?: { line?: number }
    end?: { line?: number }
  }
}

function isMarkdownCodeBlock(rawCode: string, node?: MarkdownCodeElementProps): boolean {
  const startLine = node?.position?.start?.line
  const endLine = node?.position?.end?.line
  return (
    (typeof startLine === 'number' && typeof endLine === 'number' && startLine !== endLine) ||
    rawCode.includes('\n')
  )
}

// Extracted as a proper capitalized component so eslint-plugin-react-hooks lets us call
// useContext inside. The markdown renderer will pass it the standard `code` props.
// eslint-disable-next-line react/prop-types
const MarkdownCode: NonNullable<Components['code']> = ({ children, className, node, ...props }) => {
  const isStreaming = React.useContext(IsStreamingContext)
  const match = /language-([\w-]+)/.exec(className || '')
  const rawCode = String(children ?? '')
  const isInline = !match && !className && !isMarkdownCodeBlock(rawCode, node)
  if (isInline) {
    const code = rawCode.replace(/\n$/, '')
    const resolvedPath = resolveLocalFilePath(code)
    if (resolvedPath) {
      return (
        <button
          type="button"
          className="cursor-pointer rounded bg-muted px-1.5 py-0.5 text-xs font-mono text-primary underline-offset-2 hover:underline"
          style={{ fontFamily: MONO_FONT }}
          title={resolvedPath}
          onClick={() => {
            void openLocalFilePath(code)
          }}
        >
          {children}
        </button>
      )
    }
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
      {rawCode}
    </CodeBlock>
  )
}

const MARKDOWN_COMPONENTS: Components = {
  h1: ({ children, ...props }) => (
    <h1
      className="mt-4 mb-2 first:mt-0 text-lg font-bold text-foreground border-b border-border/40 pb-1"
      {...props}
    >
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 className="mt-3 mb-1.5 first:mt-0 text-base font-semibold text-foreground" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 className="mt-2 mb-1 first:mt-0 text-sm font-semibold text-foreground" {...props}>
      {children}
    </h3>
  ),
  h4: ({ children, ...props }) => (
    <h4 className="mt-2 mb-1 first:mt-0 text-sm font-medium text-foreground/90" {...props}>
      {children}
    </h4>
  ),
  h5: ({ children, ...props }) => (
    <h5
      className="mt-1.5 mb-0.5 first:mt-0 text-xs font-medium text-foreground/80 uppercase tracking-wide"
      {...props}
    >
      {children}
    </h5>
  ),
  h6: ({ children, ...props }) => (
    <h6
      className="mt-1.5 mb-0.5 first:mt-0 text-xs font-medium text-muted-foreground uppercase tracking-wide"
      {...props}
    >
      {children}
    </h6>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote
      className="my-2 border-l-2 border-primary/40 pl-3 text-muted-foreground italic"
      {...props}
    >
      {children}
    </blockquote>
  ),
  hr: ({ ...props }) => <hr className="my-3 border-border/50" {...props} />,
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        if (!href) return
        const handled = openMarkdownHref(href)
        if (handled) e.preventDefault()
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
    <div className="my-3 overflow-x-auto max-w-full rounded-lg border border-border/60">
      <table className="min-w-0 w-full border-collapse text-sm" {...props}>
        {children}
      </table>
    </div>
  ),
  thead: ({ children, ...props }) => (
    <thead className="bg-muted/60" {...props}>
      {children}
    </thead>
  ),
  tbody: ({ children, ...props }) => (
    <tbody className="divide-y divide-border/40" {...props}>
      {children}
    </tbody>
  ),
  tr: ({ children, ...props }) => (
    <tr className="hover:bg-muted/30 transition-colors" {...props}>
      {children}
    </tr>
  ),
  th: ({ children, ...props }) => (
    <th
      className="whitespace-pre-wrap break-words px-3 py-2 text-left font-semibold text-foreground/90 border-b border-border/60"
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td
      className="whitespace-pre-wrap break-words px-3 py-2 text-foreground/80 border-r border-border/30 last:border-r-0"
      {...props}
    >
      {children}
    </td>
  ),
  pre: ({ children }) => <>{children}</>,
  code: MarkdownCode
}

const MarkdownContent = React.memo(function MarkdownContent({
  text,
  isStreaming = false
}: {
  text: string
  isStreaming?: boolean
}): React.JSX.Element {
  return (
    <IsStreamingContext.Provider value={isStreaming}>
      <Markdown
        remarkPlugins={MARKDOWN_REMARK_PLUGINS}
        rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
        components={MARKDOWN_COMPONENTS}
      >
        {text}
      </Markdown>
    </IsStreamingContext.Provider>
  )
})

function StreamingMarkdownContent({
  text,
  isStreaming
}: {
  text: string
  isStreaming: boolean
}): React.JSX.Element {
  const liveOutputAnimationStyle = useSettingsStore((s) => s.liveOutputAnimationStyle)
  const renderPool = useStreamingRenderPool(text, isStreaming, liveOutputAnimationStyle)
  // Settled blocks keep stable strings so the memoized MarkdownContent skips
  // re-parsing them; each render-pool tick only re-parses the small tail.
  const blocks = useStreamingMarkdownBlocks(renderPool.text, isStreaming)

  if (!text.trim()) {
    return <div className="whitespace-pre-wrap break-words leading-relaxed">{text}</div>
  }

  if (isStreaming) {
    return (
      <div
        className="contents"
        data-render-pool-size={renderPool.poolSize}
        data-rendered-length={renderPool.renderedLength}
        data-target-length={renderPool.targetLength}
      >
        {blocks.settled.map((block, index) => (
          <MarkdownContent key={index} text={block} isStreaming={false} />
        ))}
        {blocks.tail.trim() ? <MarkdownContent text={blocks.tail} isStreaming={false} /> : null}
      </div>
    )
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

function normalizeStructuredBlocks(
  blocks: ContentBlock[],
  options: { preserveBoundaryAfterRawIndices?: Set<number> } = {}
): ContentBlock[] {
  const hasStructuredThinkingBlocks = blocks.some((b) => b.type === 'thinking')
  const normalized: ContentBlock[] = []
  const toolUseIndices = new Map<string, number>()

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex]
    const previousRawIndex = blockIndex - 1
    const preservePreviousBoundary = options.preserveBoundaryAfterRawIndices?.has(previousRawIndex)

    if (block.type === 'text') {
      const text = hasStructuredThinkingBlocks ? stripThinkTags(block.text) : block.text
      if (!text.trim()) continue
      const last = normalized[normalized.length - 1]
      if (last && last.type === 'text' && !preservePreviousBoundary) {
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
      if (last && last.type === 'thinking' && !preservePreviousBoundary) {
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

    if (block.type === 'tool_use' && block.id) {
      const existingIndex = toolUseIndices.get(block.id)
      if (existingIndex !== undefined) {
        normalized[existingIndex] = {
          ...(normalized[existingIndex] as Extract<ContentBlock, { type: 'tool_use' }>),
          ...block
        }
        continue
      }

      toolUseIndices.set(block.id, normalized.length)
    }

    normalized.push(block)
  }

  return normalized
}

function resolveRunChangeSetForMessage(
  changesByRunId: Record<string, AgentRunChangeSet>,
  msgId?: string,
  sessionId?: string | null,
  toolUseIds: readonly string[] = []
): AgentRunChangeSet | undefined {
  if (!msgId) return undefined

  const exact = changesByRunId[msgId]
  if (exact) return exact

  const uniqueChangeSets = new Map<string, AgentRunChangeSet>()
  for (const changeSet of Object.values(changesByRunId)) {
    uniqueChangeSets.set(changeSet.runId, changeSet)
  }

  for (const changeSet of uniqueChangeSets.values()) {
    if (changeSet.assistantMessageId === msgId) return changeSet
  }

  const toolUseIdSet = new Set(toolUseIds)
  if (toolUseIdSet.size === 0) return undefined

  let bestMatch: { changeSet: AgentRunChangeSet; matchCount: number } | null = null
  for (const changeSet of uniqueChangeSets.values()) {
    let matchCount = 0
    for (const change of changeSet.changes) {
      if (change.toolUseId && toolUseIdSet.has(change.toolUseId)) {
        matchCount += 1
      }
    }
    if (matchCount === 0) continue
    if (
      sessionId &&
      changeSet.sessionId &&
      changeSet.sessionId !== sessionId &&
      !changeSet.changes.some((change) => change.sessionId === sessionId)
    ) {
      continue
    }

    if (
      !bestMatch ||
      matchCount > bestMatch.matchCount ||
      (matchCount === bestMatch.matchCount && changeSet.updatedAt > bestMatch.changeSet.updatedAt)
    ) {
      bestMatch = { changeSet, matchCount }
    }
  }

  return bestMatch?.changeSet
}

function changeSetBelongsToSession(
  changeSet: AgentRunChangeSet,
  sessionId?: string | null
): boolean {
  if (!sessionId) return false
  return (
    changeSet.sessionId === sessionId ||
    changeSet.changes.some((change) => change.sessionId === sessionId)
  )
}

function resolveLatestSessionRunChangeSet(
  changesByRunId: Record<string, AgentRunChangeSet>,
  sessionId?: string | null,
  assistantMessageIds: readonly string[] = [],
  toolUseIds: readonly string[] = []
): AgentRunChangeSet | undefined {
  if (!sessionId) return undefined

  const uniqueChangeSets = new Map<string, AgentRunChangeSet>()
  for (const changeSet of Object.values(changesByRunId)) {
    uniqueChangeSets.set(changeSet.runId, changeSet)
  }

  const assistantMessageIdSet = new Set(assistantMessageIds)
  const toolUseIdSet = new Set(toolUseIds)
  let latest: AgentRunChangeSet | undefined
  for (const changeSet of uniqueChangeSets.values()) {
    const matchesSession =
      changeSetBelongsToSession(changeSet, sessionId) ||
      assistantMessageIdSet.has(changeSet.assistantMessageId) ||
      assistantMessageIdSet.has(changeSet.runId) ||
      changeSet.changes.some((change) => change.toolUseId && toolUseIdSet.has(change.toolUseId))

    if (!matchesSession) continue
    if (aggregateDisplayableRunFileChanges(changeSet.changes).length === 0) continue
    if (!latest || changeSet.updatedAt > latest.updatedAt) {
      latest = changeSet
    }
  }

  return latest
}

export function AssistantMessage({
  content,
  isStreaming,
  usage,
  toolResults,
  liveToolCallMap,
  inlineCompactSummaries = EMPTY_INLINE_COMPACT_SUMMARIES,
  msgId,
  sessionId,
  sessionAssistantMessageIds = EMPTY_ID_LIST,
  sessionToolUseIds = EMPTY_ID_LIST,
  showRetry,
  showContinue,
  isLastAssistantMessage,
  onRetry,
  onContinue,
  onDelete,
  renderMode = 'default',
  orchestrationRun,
  hiddenToolUseIds,
  requestRetryState,
  requestDebugInfo,
  meta
}: AssistantMessageProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const devMode = useSettingsStore((s) => s.devMode)
  const animationsEnabled = useSettingsStore((s) => s.animationsEnabled)
  const liveOutputAnimationStyle = useSettingsStore((s) => s.liveOutputAnimationStyle)
  const liveComponentClassName = isStreaming
    ? getLiveOutputComponentClass(liveOutputAnimationStyle)
    : ''
  const liveScaleInClassName = liveComponentClassName
    ? `w-full origin-left ${liveComponentClassName}`
    : 'w-full origin-left'
  const liveFadeInClassName = liveComponentClassName ? `w-full ${liveComponentClassName}` : 'w-full'
  const debugInfo = devMode
    ? ((msgId ? getLastDebugInfo(msgId) : undefined) ?? requestDebugInfo)
    : undefined
  const openTranslatePage = useUIStore((s) => s.openTranslatePage)
  const navigateToSession = useUIStore((s) => s.navigateToSession)
  const setTranslateSourceText = useTranslateStore((s) => s.setSourceText)
  const openImageEditor = useImageEditStore((s) => s.openEditor)
  const forkSessionFromMessage = useChatStore((s) => s.forkSessionFromMessage)
  const [collapsed, setCollapsed] = useState(false)
  const [forking, setForking] = useState(false)
  const sessionModelBinding = useChatStore(
    useShallow((state) => {
      const sessionIndex = sessionId ? state.sessionsById[sessionId] : undefined
      const session = sessionIndex !== undefined ? state.sessions[sessionIndex] : undefined
      return {
        providerId: session?.providerId ?? null,
        modelId: session?.modelId ?? null
      }
    })
  )
  const thinkingModel = useProviderStore(
    useShallow((state) => {
      const providerId = sessionModelBinding.providerId ?? state.activeProviderId
      const provider = providerId ? state.providers.find((item) => item.id === providerId) : null
      const fallbackModelId =
        provider?.defaultModel ??
        provider?.models.find((item) => item.enabled)?.id ??
        provider?.models[0]?.id ??
        ''
      const modelId =
        sessionModelBinding.modelId ??
        (provider?.id === state.activeProviderId ? state.activeModelId : fallbackModelId)
      const model = provider?.models.find((item) => item.id === modelId)

      return {
        modelId: modelId || null,
        modelName: model?.name ?? modelId ?? 'AI',
        modelIcon: model?.icon,
        providerName: provider?.name ?? null,
        providerBuiltinId: provider?.builtinId
      }
    })
  )
  const canEditGeneratedImages = useProviderStore((state) => {
    if (renderMode !== 'default') return false

    const providerId = sessionModelBinding.providerId ?? state.activeProviderId
    if (!providerId) return false

    const provider = state.providers.find((item) => item.id === providerId)
    if (!provider) return false

    const fallbackModelId =
      provider.defaultModel ??
      provider.models.find((item) => item.enabled)?.id ??
      provider.models[0]?.id ??
      ''
    const resolvedModelId =
      sessionModelBinding.modelId ??
      (provider.id === state.activeProviderId ? state.activeModelId : fallbackModelId)
    const model = provider.models.find((item) => item.id === resolvedModelId)
    const requestType = model?.type ?? provider.type

    return requestType === 'openai-responses'
  })

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

  const isLiveMode = renderMode === 'default'

  const isGeneratingImage = useChatStore((s) =>
    isLiveMode && msgId ? !!s.generatingImageMessages[msgId] : false
  )
  const imageGenerationTiming = useChatStore((s) =>
    isLiveMode && msgId ? s.imageGenerationTimings[msgId] : undefined
  )
  const generatingImagePreview = useChatStore((s) =>
    isLiveMode && msgId ? s.generatingImagePreviews[msgId] : undefined
  )

  const stringSegments = useMemo(
    () => (typeof content === 'string' ? parseThinkTags(content) : null),
    [content]
  )
  const compactSummaryRawBoundaryIndices = useMemo(() => {
    const indices = new Set<number>()
    if (!msgId || inlineCompactSummaries.length === 0 || !Array.isArray(content)) return indices

    for (const message of inlineCompactSummaries) {
      const anchor = message.meta?.compactSummary?.displayAnchor
      if (!anchor || anchor.assistantMessageId !== msgId) continue
      const afterContentBlockCount = Number.isFinite(anchor.afterContentBlockCount)
        ? Math.max(0, Math.floor(anchor.afterContentBlockCount))
        : 0
      if (afterContentBlockCount > 0) indices.add(afterContentBlockCount - 1)
    }

    return indices
  }, [content, inlineCompactSummaries, msgId])
  const normalizedContent = useMemo(
    () =>
      Array.isArray(content)
        ? normalizeStructuredBlocks(content, {
            preserveBoundaryAfterRawIndices: compactSummaryRawBoundaryIndices
          })
        : null,
    [compactSummaryRawBoundaryIndices, content]
  )
  const messageToolUseIds = useMemo(() => {
    if (!normalizedContent) return []
    return normalizedContent
      .filter(
        (block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use'
      )
      .map((block) => block.id)
  }, [normalizedContent])
  const runChangeSet = useAgentStore((s) => {
    if (!isLiveMode) return undefined

    const directChangeSet = resolveRunChangeSetForMessage(
      s.runChangesByRunId,
      msgId,
      sessionId,
      messageToolUseIds
    )

    if (directChangeSet) return directChangeSet

    return isLastAssistantMessage
      ? resolveLatestSessionRunChangeSet(
          s.runChangesByRunId,
          sessionId,
          sessionAssistantMessageIds,
          sessionToolUseIds
        )
      : undefined
  })
  const refreshRunChanges = useAgentStore((s) => s.refreshRunChanges)
  const refreshSessionRunChanges = useAgentStore((s) => s.refreshSessionRunChanges)

  const liveToolCallIds = useMemo(() => {
    if (!isStreaming) return []
    return messageToolUseIds
  }, [isStreaming, messageToolUseIds])
  const liveToolCalls = useAgentStore(
    useShallow((s) => {
      if (!isLiveMode || liveToolCallMap || !isStreaming || liveToolCallIds.length === 0) {
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
  const orchestrationAnchorIndex = useMemo(() => {
    if (!normalizedContent || orchestrationRun?.kind !== 'team') return -1
    return normalizedContent.findIndex(
      (block) =>
        block.type === 'tool_use' && block.name === TASK_TOOL_NAME && !block.input.run_in_background
    )
  }, [normalizedContent, orchestrationRun])
  const outlineHiddenToolUseIds = useMemo(() => {
    if (!hiddenToolUseIds) return undefined

    // Orchestration summaries may hide their source Task calls. Task calls are also the
    // chronological anchors for SubAgentCard, so keep every one visible and only let the
    // orchestration layer hide non-Task team events.
    const ids = new Set(hiddenToolUseIds)
    for (const block of normalizedContent ?? []) {
      if (block.type === 'tool_use' && block.name === TASK_TOOL_NAME) {
        ids.delete(block.id)
      }
    }
    return ids.size === hiddenToolUseIds.size ? hiddenToolUseIds : ids
  }, [hiddenToolUseIds, normalizedContent])
  const trackedChangeByToolUseId = useMemo(() => {
    const map = new Map<string, AgentRunFileChange>()
    for (const change of runChangeSet?.changes ?? []) {
      if (change.toolUseId) {
        map.set(change.toolUseId, change)
      }
    }
    return map
  }, [runChangeSet])
  const inlineCompactSummaryEntries = useMemo(() => {
    if (!msgId || inlineCompactSummaries.length === 0) return []
    const rawBlocks = Array.isArray(content) ? content : null

    const entries: InlineCompactSummaryEntry[] = []
    for (const message of inlineCompactSummaries) {
      const anchor = message.meta?.compactSummary?.displayAnchor
      if (!anchor || anchor.assistantMessageId !== msgId) continue

      const afterContentBlockCount = Number.isFinite(anchor.afterContentBlockCount)
        ? Math.max(0, Math.floor(anchor.afterContentBlockCount))
        : 0
      const normalizedPrefixCount = rawBlocks
        ? normalizeStructuredBlocks(rawBlocks.slice(0, afterContentBlockCount), {
            preserveBoundaryAfterRawIndices: compactSummaryRawBoundaryIndices
          }).length
        : afterContentBlockCount

      entries.push({
        message,
        afterContentBlockCount,
        afterNormalizedBlockIndex: Math.max(-1, normalizedPrefixCount - 1),
        ...(anchor.afterToolUseId ? { afterToolUseId: anchor.afterToolUseId } : {})
      })
    }

    return entries.sort((a, b) => a.afterNormalizedBlockIndex - b.afterNormalizedBlockIndex)
  }, [compactSummaryRawBoundaryIndices, content, inlineCompactSummaries, msgId])
  const toolRunBoundaryAfterToolUseIds = useMemo(() => {
    const ids = new Set<string>()
    for (const entry of inlineCompactSummaryEntries) {
      if (entry.afterToolUseId) ids.add(entry.afterToolUseId)
    }
    return ids
  }, [inlineCompactSummaryEntries])
  const toolRunBoundaryAfterBlockIndices = useMemo(() => {
    const indices = new Set<number>()
    for (const entry of inlineCompactSummaryEntries) {
      if (entry.afterNormalizedBlockIndex >= 0) indices.add(entry.afterNormalizedBlockIndex)
    }
    return indices
  }, [inlineCompactSummaryEntries])
  const toolExecutionOutline = useMemo(
    () =>
      buildToolExecutionOutline({
        blocks: normalizedContent,
        isStreaming,
        toolResults,
        liveToolCallMap: effectiveLiveToolCallMap,
        boundaryAfterBlockIndices: toolRunBoundaryAfterBlockIndices,
        boundaryAfterToolUseIds: toolRunBoundaryAfterToolUseIds,
        hiddenToolUseIds: outlineHiddenToolUseIds,
        t
      }),
    [
      effectiveLiveToolCallMap,
      normalizedContent,
      isStreaming,
      outlineHiddenToolUseIds,
      t,
      toolResults,
      toolRunBoundaryAfterBlockIndices,
      toolRunBoundaryAfterToolUseIds
    ]
  )
  const toolRunSummaryById = useMemo(() => {
    const summaryById = new Map<string, string>()
    for (const run of toolExecutionOutline.runs) {
      const ordinaryIds = new Set(run.ordinaryItemIds)
      const runBlocks = run.itemIds
        .map((toolUseId) => toolExecutionOutline.itemByToolUseId.get(toolUseId))
        .map((item) => (item ? normalizedContent?.[item.blockIndex] : null))
        .filter((block): block is ContentBlock => !!block)
      summaryById.set(
        run.id,
        summarizeWorkspaceTools(runBlocks, t, {
          toolResults,
          liveToolCallMap: effectiveLiveToolCallMap,
          shouldIncludeTool: (block) => ordinaryIds.has(block.id)
        })
      )
    }
    return summaryById
  }, [
    effectiveLiveToolCallMap,
    normalizedContent,
    t,
    toolExecutionOutline.itemByToolUseId,
    toolExecutionOutline.runs,
    toolResults
  ])
  const [toolRunCollapseState, setToolRunCollapseState] = useState<{
    msgId?: string
    collapsedByRunId: Record<string, boolean>
  }>({
    msgId,
    collapsedByRunId: {}
  })
  const getToolRunCollapsed = useCallback(
    (run: ToolExecutionRun): boolean => {
      if (toolRunCollapseState.msgId !== msgId) return run.defaultCollapsed
      return toolRunCollapseState.collapsedByRunId[run.id] ?? run.defaultCollapsed
    },
    [msgId, toolRunCollapseState]
  )
  const toggleToolRunCollapsed = useCallback(
    (run: ToolExecutionRun): void => {
      setToolRunCollapseState((current) => {
        const currentCollapsed =
          current.msgId === msgId
            ? (current.collapsedByRunId[run.id] ?? run.defaultCollapsed)
            : run.defaultCollapsed
        return {
          msgId,
          collapsedByRunId: {
            ...(current.msgId === msgId ? current.collapsedByRunId : {}),
            [run.id]: !currentCollapsed
          }
        }
      })
    },
    [msgId]
  )
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
    if (!isLiveMode || !msgId || isStreaming) return
    void refreshRunChanges(msgId, {
      ...(sessionId ? { sessionId } : {}),
      ...(messageToolUseIds.length > 0 ? { toolUseIds: messageToolUseIds } : {})
    })
    if (isLastAssistantMessage && sessionId) {
      void refreshSessionRunChanges(sessionId, {
        ...(sessionAssistantMessageIds.length > 0
          ? { assistantMessageIds: [...sessionAssistantMessageIds] }
          : {}),
        ...(sessionToolUseIds.length > 0 ? { toolUseIds: [...sessionToolUseIds] } : {})
      })
    }
  }, [
    isLastAssistantMessage,
    isLiveMode,
    isStreaming,
    messageToolUseIds,
    msgId,
    refreshRunChanges,
    refreshSessionRunChanges,
    sessionAssistantMessageIds,
    sessionId,
    sessionToolUseIds
  ])

  const renderItems = useMemo(() => {
    if (!normalizedContent) return []

    const items: AssistantRenderItem[] = []
    for (let i = 0; i < normalizedContent.length; i++) {
      const block = normalizedContent[i]
      if (block.type === 'tool_use') {
        const run = toolExecutionOutline.runByStartBlockIndex.get(i)
        if (run) {
          items.push({ kind: 'tool-run', runId: run.id })
          i = run.endBlockIndex
          continue
        }

        const executionItem = toolExecutionOutline.itemByToolUseId.get(block.id)
        if (executionItem && executionItem.visibility !== 'hidden') {
          items.push({ kind: 'block', index: i })
        }
        continue
      }
      items.push({ kind: 'block', index: i })
    }
    return items
  }, [normalizedContent, toolExecutionOutline])
  const renderItemsWithInlineSummaries = useMemo<AssistantRenderItemWithInlineSummary[]>(() => {
    if (!normalizedContent || inlineCompactSummaryEntries.length === 0) return renderItems

    const summariesByInsertIndex = new Map<number, UnifiedMessage[]>()

    const getItemMaxBlockIndex = (item: AssistantRenderItem): number => {
      if (item.kind === 'block') return item.index
      return toolExecutionOutline.runById.get(item.runId)?.endBlockIndex ?? -1
    }

    const itemContainsToolUseId = (item: AssistantRenderItem, toolUseId: string): boolean => {
      if (item.kind === 'tool-run') {
        return toolExecutionOutline.runById.get(item.runId)?.itemIds.includes(toolUseId) ?? false
      }
      return [item.index].some((index) => {
        const block = normalizedContent[index]
        return block?.type === 'tool_use' && block.id === toolUseId
      })
    }

    const findLastItemAtOrBeforeBlockIndex = (afterBlockIndex: number): number => {
      let insertAfterIndex = -1
      for (let index = 0; index < renderItems.length; index += 1) {
        if (getItemMaxBlockIndex(renderItems[index]) <= afterBlockIndex) {
          insertAfterIndex = index
        }
      }
      return insertAfterIndex
    }

    for (const entry of inlineCompactSummaryEntries) {
      let insertAfterIndex = findLastItemAtOrBeforeBlockIndex(entry.afterNormalizedBlockIndex)
      const afterToolUseId = entry.afterToolUseId
      if (insertAfterIndex < 0 && afterToolUseId) {
        insertAfterIndex = renderItems.findIndex((item) =>
          itemContainsToolUseId(item, afterToolUseId)
        )
      }

      const existing = summariesByInsertIndex.get(insertAfterIndex)
      if (existing) {
        existing.push(entry.message)
      } else {
        summariesByInsertIndex.set(insertAfterIndex, [entry.message])
      }
    }

    const items: AssistantRenderItemWithInlineSummary[] = []
    const pushSummaries = (insertAfterIndex: number): void => {
      for (const message of summariesByInsertIndex.get(insertAfterIndex) ?? []) {
        items.push({ kind: 'compact-summary', message })
      }
    }

    pushSummaries(-1)
    for (let index = 0; index < renderItems.length; index += 1) {
      items.push(renderItems[index])
      pushSummaries(index)
    }

    return items
  }, [inlineCompactSummaryEntries, normalizedContent, renderItems, toolExecutionOutline.runById])
  const renderContent = (): React.JSX.Element => {
    const shouldShowImageGeneratingLoader = isGeneratingImage && isStreaming
    const hasEmptyContent =
      (typeof content === 'string' && content.length === 0) ||
      (Array.isArray(normalizedContent) && normalizedContent.length === 0)
    const generatingImagePreviewSrc =
      generatingImagePreview?.source.type === 'base64' && generatingImagePreview.source.data
        ? `data:${generatingImagePreview.source.mediaType || 'image/png'};base64,${generatingImagePreview.source.data}`
        : (generatingImagePreview?.source.url ?? '')

    if (shouldShowImageGeneratingLoader && hasEmptyContent) {
      return (
        <div className={liveComponentClassName || undefined}>
          <ImageGeneratingLoader
            previewSrc={generatingImagePreviewSrc || undefined}
            previewFilePath={generatingImagePreview?.source.filePath}
            startedAt={imageGenerationTiming?.startedAt}
          />
        </div>
      )
    }

    if (generatingImagePreviewSrc && hasEmptyContent) {
      return (
        <div className={liveComponentClassName || undefined}>
          <ImagePreview
            src={generatingImagePreviewSrc}
            alt="Generated image preview"
            filePath={generatingImagePreview?.source.filePath}
          />
        </div>
      )
    }

    // Show thinking indicator when streaming starts with no displayable content yet.
    if (isStreaming && hasEmptyContent) {
      return (
        <div className={liveComponentClassName || undefined}>
          <ModelThinkingIndicator
            modelName={thinkingModel.modelName}
            label={t('assistantMessage.thinkingStatus', {
              defaultValue: 'Thinking...'
            })}
          />
        </div>
      )
    }

    if (hasEmptyContent) {
      return <></>
    }

    if (typeof content === 'string') {
      const segments = stringSegments ?? []
      const hasThink = segments.some((s) => s.type === 'think')

      if (!hasThink) {
        return (
          <div className="space-y-2">
            {isStreaming ? (
              <ModelThinkingIndicator
                modelName={thinkingModel.modelName}
                label={t('assistantMessage.thinkingStatus', {
                  defaultValue: 'Thinking...'
                })}
              />
            ) : null}
            <div className={MARKDOWN_WRAPPER_CLASS}>
              <StreamingMarkdownContent text={content} isStreaming={!!isStreaming} />
              {isStreaming && (
                <span className={getLiveOutputCursorClass(liveOutputAnimationStyle)} />
              )}
            </div>
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
          {isStreaming ? (
            <ModelThinkingIndicator
              modelName={thinkingModel.modelName}
              label={t('assistantMessage.thinkingStatus', {
                defaultValue: 'Thinking...'
              })}
            />
          ) : null}
          {segments.map((seg, idx) => {
            if (seg.type === 'think') {
              return (
                <ThinkingBlock
                  key={`${idx}-${seg.closed ? 'settled' : 'active'}`}
                  thinking={seg.content}
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
            <span className={getLiveOutputCursorClass(liveOutputAnimationStyle)} />
          )}
        </div>
      )
    }

    if (!normalizedContent) {
      return <div className={MARKDOWN_WRAPPER_CLASS} />
    }

    const renderToolBlock = (
      block: Extract<ContentBlock, { type: 'tool_use' }>,
      key: string,
      blockIndex: number
    ): React.JSX.Element | null => {
      const executionItem = toolExecutionOutline.itemByToolUseId.get(block.id)
      if (
        executionItem?.visibility === 'hidden' ||
        (!executionItem && !shouldShowToolInMessageList(block.name))
      ) {
        return null
      }
      if (hiddenToolUseIds?.has(block.id)) {
        const isOrchestrationAnchor =
          orchestrationRun?.kind === 'team' &&
          block.name === TASK_TOOL_NAME &&
          !block.input.run_in_background &&
          blockIndex === orchestrationAnchorIndex
        if (block.name !== TASK_TOOL_NAME && !isOrchestrationAnchor) return null
      }
      if (block.name === 'AskUserQuestion') {
        const result = toolResults?.get(block.id)
        const liveTc = effectiveLiveToolCallMap?.get(block.id)
        const shouldUsePendingFallback = isLastAssistantMessage && !result && !liveTc
        const statusValue = shouldUsePendingFallback
          ? resolvePendingToolCallStatus(true, liveTc, result)
          : (executionItem?.status ?? resolvePendingToolCallStatus(isStreaming, liveTc, result))
        return (
          <ScaleIn key={key} className={liveScaleInClassName}>
            <AskUserQuestionCard
              toolUseId={block.id}
              input={block.input}
              output={result?.content ?? liveTc?.output}
              status={statusValue}
              isLive={!!isStreaming}
            />
          </ScaleIn>
        )
      }
      if (block.name === 'ExitPlanMode') {
        const result = toolResults?.get(block.id)
        const liveTc = effectiveLiveToolCallMap?.get(block.id)
        const shouldUsePendingFallback = isLastAssistantMessage && !result && !liveTc
        const statusValue = shouldUsePendingFallback
          ? resolvePendingToolCallStatus(true, liveTc, result)
          : (executionItem?.status ?? resolvePendingToolCallStatus(isStreaming, liveTc, result))
        return (
          <ScaleIn key={key} className={liveScaleInClassName}>
            <PlanReviewCard
              output={result?.content ?? liveTc?.output}
              status={statusValue}
              isLive={!!isStreaming}
              sessionId={sessionId}
            />
          </ScaleIn>
        )
      }
      if (block.name === 'visualize_show_widget') {
        const result = toolResults?.get(block.id)
        const liveTc = effectiveLiveToolCallMap?.get(block.id)
        const widgetInput = mergeWidgetToolInput(block.input, liveTc?.input)
        const statusValue =
          executionItem?.status ?? resolvePendingToolCallStatus(isStreaming, liveTc, result)
        return (
          <ScaleIn key={key} className={liveScaleInClassName}>
            <WidgetOutputBlock input={widgetInput} status={statusValue} />
          </ScaleIn>
        )
      }
      if (TEAM_TOOL_NAMES.has(block.name)) {
        const result = toolResults?.get(block.id)
        return (
          <FadeIn key={key} className={liveFadeInClassName}>
            <TeamEventCard
              name={block.name}
              input={block.input}
              output={result?.content}
              status={executionItem?.status}
              error={executionItem?.error}
            />
          </FadeIn>
        )
      }
      if (block.name === TASK_TOOL_NAME) {
        const result = toolResults?.get(block.id)
        return (
          <React.Fragment key={key}>
            {orchestrationRun?.kind === 'team' && blockIndex === orchestrationAnchorIndex ? (
              <FadeIn className={liveFadeInClassName}>
                <OrchestrationBlock run={orchestrationRun} />
              </FadeIn>
            ) : null}
            <ScaleIn className={liveScaleInClassName}>
              <SubAgentCard
                name={block.name}
                toolUseId={block.id}
                input={block.input}
                output={result?.content}
                isLive={!!isStreaming}
                sessionId={sessionId}
                isBackground={block.input.run_in_background === true}
              />
            </ScaleIn>
          </React.Fragment>
        )
      }
      if (['Write', 'Edit', 'Delete'].includes(block.name)) {
        const result = toolResults?.get(block.id)
        const liveTc = effectiveLiveToolCallMap?.get(block.id)
        const statusValue =
          executionItem?.status ?? resolveToolCallStatus(isStreaming, liveTc, result)
        return (
          <ScaleIn key={key} className={liveScaleInClassName}>
            <FileChangeCard
              name={block.name}
              input={block.input}
              output={result?.content ?? liveTc?.output}
              status={statusValue}
              error={liveTc?.error}
              startedAt={liveTc?.startedAt}
              completedAt={liveTc?.completedAt}
              trackedChange={trackedChangeByToolUseId.get(block.id)}
              forceOpen={executionItem?.forceExpanded}
            />
          </ScaleIn>
        )
      }
      if (block.name === IMAGE_GENERATE_TOOL_NAME) {
        const result = toolResults?.get(block.id)
        const liveTc = effectiveLiveToolCallMap?.get(block.id)
        const statusValue =
          executionItem?.status ?? resolveToolCallStatus(isStreaming, liveTc, result)
        return (
          <ScaleIn key={key} className={liveScaleInClassName}>
            <ImagePluginToolCard
              toolUseId={block.id}
              input={liveTc?.input ?? block.input}
              output={result?.content ?? liveTc?.output}
              status={statusValue}
              error={liveTc?.error}
              forceOpen={executionItem?.forceExpanded}
            />
          </ScaleIn>
        )
      }
      if (isBrowserToolName(block.name)) {
        const toolCallState = buildToolCallRenderState(block, {
          isStreaming,
          toolResults,
          liveToolCallMap: effectiveLiveToolCallMap,
          executionItem
        })
        return (
          <ScaleIn key={key} className={liveScaleInClassName}>
            <BrowserToolCard
              name={toolCallState.name}
              input={toolCallState.input}
              output={toolCallState.output}
              status={toolCallState.status}
              error={toolCallState.error}
              forceOpen={executionItem?.forceExpanded}
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
        const statusValue =
          executionItem?.status ?? resolveToolCallStatus(isStreaming, liveTc, result)
        return (
          <ScaleIn key={key} className={liveScaleInClassName}>
            <DesktopActionToolCard
              name={block.name}
              input={block.input}
              output={liveTc?.output ?? result?.content}
              status={statusValue}
              error={liveTc?.error}
              forceOpen={executionItem?.forceExpanded}
            />
          </ScaleIn>
        )
      }
      if (block.name === 'Skill') {
        const toolCallState = buildToolCallRenderState(block, {
          isStreaming,
          toolResults,
          liveToolCallMap: effectiveLiveToolCallMap,
          executionItem
        })
        return (
          <ScaleIn key={key} className={liveScaleInClassName}>
            <ToolCallCard
              toolUseId={toolCallState.toolUseId}
              name={toolCallState.name}
              input={toolCallState.input}
              output={toolCallState.output}
              status={toolCallState.status}
              error={toolCallState.error}
              startedAt={toolCallState.startedAt}
              completedAt={toolCallState.completedAt}
              forceOpen={executionItem?.forceExpanded}
            />
          </ScaleIn>
        )
      }
      if (block.name === 'Bash' || block.name === 'Shell') {
        const toolCallState = buildToolCallRenderState(block, {
          isStreaming,
          toolResults,
          liveToolCallMap: effectiveLiveToolCallMap,
          executionItem
        })
        const bashArtifacts = decodeBashArtifacts(toolCallState.output)
        return (
          <ScaleIn key={key} className={liveScaleInClassName}>
            <ToolCallCard
              toolUseId={toolCallState.toolUseId}
              name={toolCallState.name}
              input={toolCallState.input}
              output={toolCallState.output}
              status={toolCallState.status}
              error={toolCallState.error}
              startedAt={toolCallState.startedAt}
              completedAt={toolCallState.completedAt}
              forceOpen={executionItem?.forceExpanded}
            />
            {bashArtifacts ? (
              <BashArtifactsCard
                artifacts={bashArtifacts.artifacts}
                truncated={bashArtifacts.truncated}
              />
            ) : null}
          </ScaleIn>
        )
      }

      // Generic ToolCallCard — only ordinary context tools are hidden by the workspace collapse.
      const toolCallState = buildToolCallRenderState(block, {
        isStreaming,
        toolResults,
        liveToolCallMap: effectiveLiveToolCallMap,
        executionItem
      })
      return (
        <ScaleIn key={key} className={liveScaleInClassName}>
          <ToolCallCard
            toolUseId={toolCallState.toolUseId}
            name={toolCallState.name}
            input={toolCallState.input}
            output={toolCallState.output}
            status={toolCallState.status}
            error={toolCallState.error}
            startedAt={toolCallState.startedAt}
            completedAt={toolCallState.completedAt}
            forceOpen={executionItem?.forceExpanded}
          />
        </ScaleIn>
      )
    }

    const renderToolRun = (runId: string): React.JSX.Element | null => {
      const run = toolExecutionOutline.runById.get(runId)
      if (!run) return null

      const collapsed = getToolRunCollapsed(run)
      const detail =
        run.activeSummary ||
        toolRunSummaryById.get(run.id) ||
        (run.activeCount > 0
          ? t('assistantMessage.activeTools', { count: run.activeCount })
          : run.ordinaryItemCount > 0
            ? t('assistantMessage.toolExecutions', { count: run.ordinaryItemCount })
            : null)

      const renderedTools = run.itemIds
        .map((toolUseId) => {
          const item = toolExecutionOutline.itemByToolUseId.get(toolUseId)
          if (!item || item.visibility === 'hidden') return null
          // Keep ordinary tools mounted for collapsible runs so close tween can measure height.
          if (item.visibility === 'ordinary' && collapsed && !run.showToggle) return null

          const block = normalizedContent[item.blockIndex]
          if (!block || block.type !== 'tool_use') return null

          return renderToolBlock(block, `${run.id}:${toolUseId}`, item.blockIndex)
        })
        .filter((node): node is React.JSX.Element => !!node)

      if (!run.showToggle && renderedTools.length === 0) return null

      return (
        <React.Fragment key={run.id}>
          {run.showToggle ? (
            <GenerationProcessLine
              active={run.activeCount > 0}
              label={t('assistantMessage.processTools')}
              detail={detail}
              collapsible={run.showToggle}
              expanded={!collapsed}
              onClick={() => toggleToolRunCollapsed(run)}
            />
          ) : null}
          {run.showToggle ? (
            <CollapsibleHeightPanel open={!collapsed} className="overflow-hidden">
              <div className="space-y-2">{renderedTools}</div>
            </CollapsibleHeightPanel>
          ) : (
            renderedTools
          )}
        </React.Fragment>
      )
    }

    return (
      <div className="space-y-2">
        {orchestrationRun?.kind === 'team' && orchestrationAnchorIndex < 0 ? (
          <OrchestrationBlock run={orchestrationRun} />
        ) : null}
        {renderItemsWithInlineSummaries.map((item) => {
          if (item.kind === 'compact-summary') {
            return (
              <ContextCompressionMessage
                key={`compact-summary-${item.message.id}`}
                message={item.message}
              />
            )
          }

          if (item.kind === 'block') {
            const block = normalizedContent[item.index]
            switch (block.type) {
              case 'thinking':
                return (
                  <ThinkingBlock
                    key={`${item.index}-${block.completedAt ? 'settled' : 'active'}`}
                    thinking={block.thinking}
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
                        isStreaming={!!isStreaming && item.index === lastStructuredTextIdx}
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
                        isStreaming={!!isStreaming && item.index === lastStructuredTextIdx}
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
                            key={`${item.index}-${j}-${seg.closed ? 'settled' : 'active'}`}
                            thinking={seg.content}
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
                  imgBlock.source.type === 'base64' && imgBlock.source.data
                    ? `data:${imgBlock.source.mediaType || 'image/png'};base64,${imgBlock.source.data}`
                    : (imgBlock.source.url ?? '')
                if (!imgSrc && !imgBlock.source.filePath) return null
                const editableImage = imageBlockToAttachment(imgBlock)
                const actions =
                  canEditGeneratedImages && sessionId && editableImage
                    ? [
                        {
                          key: 'edit',
                          label: t('assistantMessage.editImage', {
                            defaultValue: 'Edit image'
                          }),
                          icon: <Pencil className="size-4" />,
                          onClick: () =>
                            openImageEditor({
                              sessionId,
                              image: editableImage,
                              mode: 'edit'
                            })
                        },
                        {
                          key: 'mask',
                          label: t('assistantMessage.maskEditImage', {
                            defaultValue: 'Mask edit'
                          }),
                          icon: <Eraser className="size-4" />,
                          onClick: () =>
                            openImageEditor({
                              sessionId,
                              image: editableImage,
                              mode: 'mask'
                            })
                        }
                      ]
                    : undefined
                return (
                  <ScaleIn key={item.index} className={liveScaleInClassName}>
                    <ImagePreview
                      src={imgSrc}
                      alt="Generated image"
                      filePath={imgBlock.source.filePath}
                      actions={actions}
                    />
                  </ScaleIn>
                )
              }
              case 'image_error': {
                const imageError = block as Extract<ContentBlock, { type: 'image_error' }>
                return (
                  <ScaleIn key={item.index} className={liveScaleInClassName}>
                    <ImageGenerationErrorCard code={imageError.code} message={imageError.message} />
                  </ScaleIn>
                )
              }
              case 'agent_error': {
                const agentError = block as Extract<ContentBlock, { type: 'agent_error' }>
                return (
                  <ScaleIn key={item.index} className={liveScaleInClassName}>
                    <AgentErrorCard
                      code={agentError.code}
                      message={agentError.message}
                      errorType={agentError.errorType}
                      details={agentError.details}
                      stackTrace={agentError.stackTrace}
                    />
                  </ScaleIn>
                )
              }
              case 'tool_use':
                return renderToolBlock(block, block.id, item.index)
              case 'web_search': {
                const webSearch = block as Extract<ContentBlock, { type: 'web_search' }>
                return (
                  <ScaleIn key={item.index} className={liveScaleInClassName}>
                    <WebSearchBlock block={webSearch} />
                  </ScaleIn>
                )
              }
              default:
                return null
            }
          }

          return renderToolRun(item.runId)
        })}
        {isStreaming && <span className={getLiveOutputCursorClass(liveOutputAnimationStyle)} />}
        {shouldShowImageGeneratingLoader && (
          <div className={`pt-3${liveComponentClassName ? ` ${liveComponentClassName}` : ''}`}>
            <ImageGeneratingLoader
              previewSrc={generatingImagePreviewSrc || undefined}
              previewFilePath={generatingImagePreview?.source.filePath}
              startedAt={imageGenerationTiming?.startedAt}
            />
          </div>
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

  const handleFork = useCallback(async (): Promise<void> => {
    if (!sessionId || !msgId || forking) return

    setForking(true)
    try {
      const forkedSessionId = await forkSessionFromMessage(sessionId, msgId)
      if (!forkedSessionId) {
        toast.error(t('messageActions.forkFailed'))
        return
      }

      navigateToSession(forkedSessionId)
      toast.success(t('messageActions.forked'))
    } catch (error) {
      console.error('[AssistantMessage] Failed to fork session:', error)
      toast.error(t('messageActions.forkFailed'))
    } finally {
      setForking(false)
    }
  }, [forkSessionFromMessage, forking, msgId, navigateToSession, sessionId, t])

  const handleDeleteAndRegenerate = useCallback((): void => {
    if (!showRetry || !onRetry || !msgId) return
    onRetry(msgId)
  }, [msgId, onRetry, showRetry])

  const requestTrace = msgId ? getRequestTraceInfo(msgId) : undefined
  const completionSummary = useMemo<CompletionSummaryData | null>(() => {
    if (!usage) {
      if (fallbackTokens <= 0) return null
      return {
        totalTokens: fallbackTokens,
        totalValue: formatTokenMetric(fallbackTokens),
        estimated: true,
        modelName: thinkingModel.modelName,
        modelId: thinkingModel.modelId,
        modelIcon: thinkingModel.modelIcon,
        providerName: thinkingModel.providerName,
        providerBuiltinId: thinkingModel.providerBuiltinId,
        segments: [],
        tokenRows: [],
        metricRows: []
      }
    }

    const providerStore = useProviderStore.getState()
    const providers = providerStore.providers
    const requestModel = meta?.requestModel
    const tracedProviderId = requestDebugInfo?.providerId ?? requestTrace?.providerId ?? null
    const tracedModelId = requestDebugInfo?.model ?? requestTrace?.model ?? null
    const fastProviderConfig =
      renderMode === 'transcript' && !requestModel?.providerId && !tracedProviderId
        ? providerStore.getFastProviderConfig()
        : null
    const fallbackProviderId =
      requestModel?.providerId ??
      tracedProviderId ??
      fastProviderConfig?.providerId ??
      sessionModelBinding.providerId ??
      null
    const provider = fallbackProviderId
      ? providers.find((item) => item.id === fallbackProviderId)
      : null
    const modelId =
      requestModel?.modelId ??
      tracedModelId ??
      fastProviderConfig?.model ??
      sessionModelBinding.modelId ??
      thinkingModel.modelId
    const modelCfg = provider?.models.find((item) => item.id === modelId) ?? null
    const billableInput = getBillableInputTokens(usage, modelCfg?.type)
    const cacheRead = Math.max(0, usage.cacheReadTokens ?? 0)
    const cacheCreation = getCacheCreationTokens(usage)
    const output = Math.max(0, usage.outputTokens ?? 0)
    const composedInput = billableInput + cacheRead + cacheCreation
    const rawInput = Math.max(0, usage.inputTokens ?? 0, composedInput)
    const totalTokens = rawInput + output
    const cacheHitRate = getUsageCacheHitRate(usage, modelCfg?.type)
    const uncachedColor = '#737373'
    const cacheReadColor = '#f59e0b'
    const cacheCreationColor = '#a78bfa'
    const outputColor = '#a3e635'
    const tokenRows: CompletionDetailRow[] = []
    const metricRows: CompletionDetailRow[] = []
    const segments: CompletionTokenSegment[] = []

    if (billableInput > 0 || rawInput > 0) {
      tokenRows.push({
        key: 'uncached-input',
        label: t('assistantMessage.uncachedInput', { defaultValue: 'Uncached input' }),
        value: formatTokenMetric(billableInput),
        color: uncachedColor
      })
      segments.push({
        key: 'uncached-input',
        label: t('assistantMessage.uncachedInput', { defaultValue: 'Uncached input' }),
        value: billableInput,
        color: uncachedColor
      })
    }

    if (cacheRead > 0) {
      tokenRows.push({
        key: 'cache-read',
        label: t('assistantMessage.cachedInput', { defaultValue: 'Input cache' }),
        value: formatTokenMetric(cacheRead),
        color: cacheReadColor
      })
      segments.push({
        key: 'cache-read',
        label: t('assistantMessage.cachedInput', { defaultValue: 'Input cache' }),
        value: cacheRead,
        color: cacheReadColor
      })
    }

    if (cacheCreation > 0) {
      tokenRows.push({
        key: 'cache-write',
        label: t('assistantMessage.cacheWrite', { defaultValue: 'Cache write' }),
        value: formatTokenMetric(cacheCreation),
        color: cacheCreationColor
      })
      segments.push({
        key: 'cache-write',
        label: t('assistantMessage.cacheWrite', { defaultValue: 'Cache write' }),
        value: cacheCreation,
        color: cacheCreationColor
      })
    }

    if (output > 0) {
      tokenRows.push({
        key: 'output',
        label: t('analytics.outputTokens', { ns: 'settings', defaultValue: 'Output Tokens' }),
        value: formatTokenMetric(output),
        color: outputColor
      })
      segments.push({
        key: 'output',
        label: t('analytics.outputTokens', { ns: 'settings', defaultValue: 'Output Tokens' }),
        value: output,
        color: outputColor
      })
    }

    if (usage.reasoningTokens) {
      tokenRows.push({
        key: 'reasoning',
        label: t('unit.reasoning', { ns: 'common', defaultValue: 'Reasoning' }),
        value: formatTokenMetric(usage.reasoningTokens),
        color: '#38bdf8'
      })
    }

    if (billableInput + cacheRead > 0) {
      metricRows.push({
        key: 'cache-hit-rate',
        label: t('analytics.cacheTokenShare', {
          ns: 'settings',
          defaultValue: 'Cached Token Share'
        }),
        value: formatCacheHitRate(cacheHitRate)
      })
    }

    if (totalTokens > 0) {
      metricRows.push({
        key: 'total-usage',
        label: t('assistantMessage.totalUsage', { defaultValue: 'Total usage' }),
        value: formatTokenMetric(totalTokens)
      })
    }

    const perRequest = usage.requestTimings ?? []
    const lastTiming = perRequest.length > 0 ? perRequest[perRequest.length - 1] : null
    if (lastTiming) {
      const tps = toFiniteNumber(lastTiming.tps)
      const ttftMs = toFiniteNumber(lastTiming.ttftMs)

      if (tps !== null) {
        metricRows.push({
          key: 'tps',
          label: t('assistantMessage.tps'),
          value: formatThroughput(tps),
          hint: t('assistantMessage.tpsHint', {
            defaultValue: 'Output tokens generated per second'
          })
        })
      }
      if (ttftMs !== null) {
        metricRows.push({
          key: 'ttft',
          label: t('assistantMessage.ttft'),
          value: formatPreciseDurationMs(ttftMs),
          hint: t('assistantMessage.ttftHint', {
            defaultValue: 'Time to first token'
          })
        })
      }
    }

    return {
      totalTokens,
      totalValue: formatTokenMetric(totalTokens),
      estimated: false,
      modelName: requestModel?.modelName ?? modelCfg?.name ?? thinkingModel.modelName,
      modelId,
      modelIcon: requestModel?.modelIcon ?? modelCfg?.icon ?? thinkingModel.modelIcon,
      providerName: requestModel?.providerName ?? provider?.name ?? thinkingModel.providerName,
      providerBuiltinId:
        requestModel?.providerBuiltinId ?? provider?.builtinId ?? thinkingModel.providerBuiltinId,
      segments,
      tokenRows,
      metricRows
    }
  }, [
    fallbackTokens,
    meta?.requestModel,
    renderMode,
    requestDebugInfo?.model,
    requestDebugInfo?.providerId,
    requestTrace?.model,
    requestTrace?.providerId,
    sessionModelBinding.modelId,
    sessionModelBinding.providerId,
    thinkingModel.modelIcon,
    thinkingModel.modelId,
    thinkingModel.modelName,
    thinkingModel.providerBuiltinId,
    thinkingModel.providerName,
    t,
    usage
  ])

  return (
    <div className="group/msg flex flex-col">
      <div className="min-w-0 overflow-hidden pl-1.5 sm:pl-2">
        <AnimatePresence>
          {requestRetryState && (
            <motion.div
              key="request-retry"
              initial={animationsEnabled ? { opacity: 0, y: 4 } : false}
              animate={{ opacity: 1, y: 0 }}
              exit={animationsEnabled ? { opacity: 0 } : undefined}
              transition={animationsEnabled ? { duration: 0.15, ease: 'easeOut' } : { duration: 0 }}
              className="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
            >
              <RotateCcw className="mt-0.5 size-3.5 shrink-0 animate-spin" />
              <div className="min-w-0">
                <div className="font-medium">
                  {t('assistantMessage.retryingRequest', {
                    defaultValue: 'Request retrying'
                  })}
                </div>
                <div className="mt-0.5 break-words text-[11px] text-amber-700/80 dark:text-amber-200/80">
                  {t('assistantMessage.retryingRequestDetail', {
                    defaultValue:
                      'Attempt {{attempt}} / {{maxAttempts}} retry, resend after {{delay}}{{statusSuffix}}',
                    attempt: requestRetryState.attempt,
                    maxAttempts: requestRetryState.maxAttempts,
                    delay: formatRetryDelay(requestRetryState.delayMs),
                    statusSuffix: requestRetryState.statusCode
                      ? `, status code ${requestRetryState.statusCode}`
                      : ''
                  })}
                  {requestRetryState.reason ? ` · ${requestRetryState.reason}` : ''}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        {collapsed ? (
          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            <div className="max-h-10 overflow-hidden whitespace-pre-wrap break-words">
              {plainText.trim() || t('messageActions.collapsedMessage')}
            </div>
          </div>
        ) : (
          <>
            {renderContent()}
            {!isStreaming && renderMode !== 'transcript' && completionSummary && (
              <CompletionSummaryBar summary={completionSummary} />
            )}
          </>
        )}
        {!isStreaming &&
          (plainText ||
            (isLiveMode && sessionId && msgId) ||
            (msgId && onDelete) ||
            (devMode && debugInfo) ||
            (showContinue && onContinue) ||
            (showRetry && onRetry)) && (
            <div
              className={`mt-2 flex items-center gap-1 transition-opacity ${showContinue && onContinue ? 'opacity-100' : 'opacity-0 group-hover/msg:opacity-100'}`}
            >
              {plainText && (
                <ActionIconButton
                  label={t('action.copy', { ns: 'common' })}
                  icon={<Copy className="size-3.5" />}
                  onClick={handleCopy}
                />
              )}
              {isLiveMode && sessionId && msgId ? (
                <ActionIconButton
                  label={t('messageActions.fork')}
                  icon={<GitFork className="size-3.5" />}
                  onClick={() => void handleFork()}
                  disabled={forking}
                />
              ) : null}
              {showContinue && onContinue ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={onContinue}
                      aria-label={t('assistantMessage.continueToolExecution', {
                        defaultValue: 'Continue execution'
                      })}
                      className="flex size-7 items-center justify-center rounded-md border border-border/50 bg-background/90 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                      <Play className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {t('assistantMessage.continueToolExecutionHint', {
                      defaultValue:
                        'Detected that the last run stopped at tool execution. Click to continue in this message without creating a new AI message'
                    })}
                  </TooltipContent>
                </Tooltip>
              ) : null}
              {showRetry && onRetry ? (
                <ActionIconButton
                  label={t('assistantMessage.regenerateReference', {
                    defaultValue: 'Regenerate reference'
                  })}
                  icon={<RotateCcw className="size-3.5" />}
                  onClick={() => msgId && onRetry?.(msgId)}
                />
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t('action.showMore', { ns: 'common' })}
                    title={t('action.showMore', { ns: 'common' })}
                    className="flex size-7 items-center justify-center rounded-md border border-border/50 bg-background/90 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    <Ellipsis className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuItem onSelect={handleCopy} disabled={!plainText.trim()}>
                    <Copy className="size-4" />
                    {t('action.copy', { ns: 'common' })}
                  </DropdownMenuItem>
                  {isLiveMode && sessionId && msgId ? (
                    <DropdownMenuItem onSelect={() => void handleFork()} disabled={forking}>
                      <GitFork className="size-4" />
                      {t('messageActions.fork')}
                    </DropdownMenuItem>
                  ) : null}
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
                  {showContinue && onContinue && (
                    <DropdownMenuItem onSelect={onContinue}>
                      <Play className="size-4" />
                      {t('assistantMessage.continueToolExecution', {
                        defaultValue: 'Continue execution'
                      })}
                    </DropdownMenuItem>
                  )}
                  {showRetry && onRetry && (
                    <DropdownMenuItem onSelect={() => msgId && onRetry?.(msgId)}>
                      <RotateCcw className="size-4" />
                      {t('assistantMessage.regenerateReference', {
                        defaultValue: 'Regenerate reference'
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
              {devMode && debugInfo && (
                <DebugToggleButton debugInfo={debugInfo} sessionId={sessionId} />
              )}
            </div>
          )}
      </div>
    </div>
  )
}
