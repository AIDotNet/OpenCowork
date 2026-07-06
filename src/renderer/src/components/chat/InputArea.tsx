import * as React from 'react'
import { useState as useLocalState } from 'react'
import { toast } from 'sonner'
import {
  Send,
  FolderOpen,
  AlertTriangle,
  FileUp,
  FileCode2,
  Sparkles,
  X,
  Trash2,
  ImagePlus,
  ClipboardList,
  Globe,
  Wand2,
  CornerDownRight,
  Ellipsis,
  Command,
  Target,
  Puzzle,
  Activity,
  Brain,
  CheckCircle2,
  CircleHelp,
  Clock,
  ImageIcon,
  RefreshCcw,
  ShieldAlert,
  Shapes,
  Users,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { Textarea } from '@renderer/components/ui/textarea'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { useProviderStore, modelSupportsVision } from '@renderer/stores/provider-store'
import type {
  AIModelConfig,
  MessageRequestModelMeta,
  RequestTiming,
  SelectedFileReference,
  TokenUsage,
  UnifiedMessage
} from '@renderer/lib/api/types'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { updateWebSearchToolRegistration } from '@renderer/lib/tools'
import { useUIStore, type AppMode } from '@renderer/stores/ui-store'
import {
  calculateCost,
  calculateCostBreakdown,
  estimateTokens,
  formatCacheHitRate,
  formatCost,
  formatTokens,
  getBillableInputTokens,
  getCacheCreationTokens,
  getCacheCreationSplit,
  getCacheHitRate
} from '@renderer/lib/format-tokens'
import { formatDurationMs } from '@renderer/lib/format-duration'
import {
  getEffectiveContextWindow,
  resolveCompressionContextLength,
  resolveCompressionReservedOutputBudget,
  resolveCompressionThreshold
} from '@renderer/lib/agent/context-compression'
import { useDebouncedTokens } from '@renderer/hooks/use-estimated-tokens'
import { usePromptRecommendation } from '@renderer/hooks/use-prompt-recommendation'
import { useChatStore } from '@renderer/stores/chat-store'
import { useChannelStore } from '@renderer/stores/channel-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import {
  getHomeInputDraftKey,
  getProjectInputDraftKey,
  getSessionInputDraftKey,
  type InputDraftContext
} from '@renderer/lib/input-drafts'
import { useInputDraftPersistence } from '@renderer/hooks/use-input-draft-persistence'
import { useShallow } from 'zustand/react/shallow'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import { useTranslation } from 'react-i18next'
import {
  ACCEPTED_IMAGE_TYPES,
  cloneImageAttachments,
  fileToImageAttachment,
  hasEditableDraftContent,
  type EditableUserMessageDraft,
  type ImageAttachment
} from '@renderer/lib/image-attachments'
import {
  createSelectFileToken,
  getSelectFileMentionQuery,
  selectFileTextToPlainText
} from '@renderer/lib/select-file-tags'
import {
  deserializeEditorState,
  documentHasFileReferences,
  editorDocumentToPlainText,
  ensureSelectedFile,
  mergeSelectedFiles,
  createPluginReferenceNode,
  createTextReplacementNode,
  removeReferenceNode,
  replaceEditorRange,
  serializeEditorDocument,
  type EditorDocumentNode,
  type SelectedFileItem
} from '@renderer/lib/select-file-editor'
import { SkillsMenu } from './SkillsMenu'
import { ModelSwitcher } from './ModelSwitcher'
import { ModelIcon } from '@renderer/components/settings/provider-icons'
import { FileAwareEditor, type FileAwareEditorHandle } from './FileAwareEditor'
import { TokenCounter } from './TokenCounter'
import { listCommands, type CommandCatalogItem } from '@renderer/lib/commands/command-loader'
import { resolveEffectiveActiveMcpIds, useMcpStore } from '@renderer/stores/mcp-store'
import {
  resolveEffectiveActiveExtensionIds,
  useExtensionStore
} from '@renderer/stores/extension-store'
import { usePlanStore } from '@renderer/stores/plan-store'
import { useGoalStore } from '@renderer/stores/goal-store'
import { useSkillsStore } from '@renderer/stores/skills-store'
import { resolveSessionModelSelection } from '@renderer/lib/session-model-resolution'
import { resolvePluginsForProject, useAppPluginStore } from '@renderer/stores/app-plugin-store'
import { validateGoalObjective } from '@renderer/lib/agent/goal-context'
import {
  APP_PLUGIN_DESCRIPTORS,
  BROWSER_PLUGIN_ID,
  IMAGE_PLUGIN_ID,
  PRODUCT_DESIGN_PLUGIN_ID,
  type AppPluginId
} from '@renderer/lib/app-plugin/types'
import {
  clearPendingSessionMessages,
  dispatchNextQueuedMessageForSession,
  getPendingSessionMessages,
  isPendingSessionDispatchPaused,
  quotePendingSessionMessageIntoConversation,
  removePendingSessionMessage,
  subscribePendingSessionMessages,
  updatePendingSessionMessageDraft,
  type SendMessageOptions,
  type PendingSessionMessageItem,
  type ManualCompressionResult
} from '@renderer/hooks/use-chat-actions'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@renderer/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { cn } from '@renderer/lib/utils'
import { resolveProjectMemoryTextFile } from '@renderer/lib/agent/memory-files'
import { isProjectSession, workspaceContextAvailable } from '@renderer/lib/session-scope'
import { getDroppedLocalPaths } from '@renderer/lib/drag-folder'
import { GoalSessionBar } from '@renderer/components/goal/GoalSessionControls'

interface ContextRingProps {
  sessionId?: string | null
  onCompressContext?: () => void | Promise<void>
  isCompressing?: boolean
}

function ContextRing({
  sessionId,
  onCompressContext,
  isCompressing = false
}: ContextRingProps): React.JSX.Element | null {
  const { t } = useTranslation('chat')
  const activeSession = useChatStore((s) => {
    if (!sessionId) return null
    const idx = s.sessionsById[sessionId]
    return idx !== undefined ? (s.sessions[idx] ?? null) : null
  })
  const mainModelSelectionMode = useSettingsStore((s) => s.mainModelSelectionMode)
  const channels = useChannelStore((s) => s.channels)
  const autoSelection = useUIStore((s) =>
    activeSession ? (s.autoModelSelectionsBySession[activeSession.id] ?? null) : null
  )

  const activeModelCfg = useProviderStore((s) => {
    const activeChannel = activeSession?.pluginId
      ? (channels.find((item) => item.id === activeSession.pluginId) ?? null)
      : null
    const selection = resolveSessionModelSelection({
      session: activeSession,
      providers: s.providers,
      activeProviderId: s.activeProviderId,
      activeModelId: s.activeModelId,
      globalMode: mainModelSelectionMode,
      channelProviderId: activeChannel?.providerId,
      channelModelId: activeChannel?.model
    })
    const providerId =
      selection.isAutoModeActive && autoSelection?.providerId
        ? autoSelection.providerId
        : selection.providerId
    const modelId =
      selection.isAutoModeActive && autoSelection?.modelId
        ? autoSelection.modelId
        : selection.modelId
    if (!providerId || !modelId) return null
    const provider = s.providers.find((p) => p.id === providerId)
    return provider?.models.find((m) => m.id === modelId) ?? null
  }) as AIModelConfig | null
  const compressionConfig = activeModelCfg
    ? {
        enabled: true,
        contextLength: resolveCompressionContextLength(activeModelCfg),
        threshold: resolveCompressionThreshold(activeModelCfg),
        preCompressThreshold: 0.65,
        reservedOutputBudget: resolveCompressionReservedOutputBudget(activeModelCfg)
      }
    : null

  const [ctxUsedRaw, ctxLimitRaw] = useStoreWithEqualityFn(
    useChatStore,
    React.useCallback(
      (s): [number, number | null] => {
        if (!sessionId) return [0, null]
        const idx = s.sessionsById[sessionId]
        const activeSession = idx !== undefined ? s.sessions[idx] : undefined
        if (!activeSession) return [0, null]
        const messages = activeSession.messages
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index]
          const usage = message?.usage
          if (!usage) continue
          const contextTokens = usage.contextTokens ?? 0
          if (contextTokens <= 0) continue
          return [contextTokens, usage.contextLength ?? null]
        }
        return [0, null]
      },
      [sessionId]
    ),
    (a, b) => a[0] === b[0] && a[1] === b[1]
  )

  if (!sessionId || !activeSession) return null

  const ctxUsed = ctxUsedRaw
  const ctxLimit = ctxLimitRaw ?? compressionConfig?.contextLength ?? null
  const ctxGaugeLimit = compressionConfig ? getEffectiveContextWindow(compressionConfig) : ctxLimit

  if (!ctxGaugeLimit) return null

  const pct = Math.min((ctxUsed / ctxGaugeLimit) * 100, 100)
  const remaining = Math.max(ctxGaugeLimit - ctxUsed, 0)
  const strokeColor =
    pct > 80 ? 'stroke-red-500' : pct > 50 ? 'stroke-amber-500' : 'stroke-emerald-500'
  const canCompress = Boolean(onCompressContext) && !isCompressing
  const handleDoubleClick = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    if (!canCompress) return
    onCompressContext?.()
  }

  // SVG circular progress
  const size = 26
  const strokeWidth = 2.5
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - pct / 100)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-disabled={!canCompress}
          aria-label={t('input.doubleClickCompressContext', {
            defaultValue: 'Double-click to compress context'
          })}
          className={cn(
            'flex items-center justify-center rounded-full outline-none focus-visible:ring-1 focus-visible:ring-ring',
            canCompress ? 'cursor-pointer' : 'cursor-default',
            isCompressing && 'opacity-70'
          )}
          onDoubleClick={handleDoubleClick}
          onMouseDown={(event) => {
            event.preventDefault()
          }}
        >
          <div className="relative flex size-[26px] shrink-0 items-center justify-center">
            <svg width={size} height={size} className="-rotate-90">
              <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                className="stroke-muted/30"
                strokeWidth={strokeWidth}
              />
              <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                className={`${strokeColor} transition-all duration-500`}
                strokeWidth={strokeWidth}
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
                strokeLinecap="round"
              />
            </svg>
            <span className="absolute text-[7px] font-medium text-muted-foreground tabular-nums select-none">
              {pct.toFixed(0)}%
            </span>
          </div>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <div className="text-xs space-y-0.5">
          <p className="font-medium">{t('input.compressionBudget')}</p>
          <p className="text-muted-foreground">
            {formatTokens(ctxUsed)} / {formatTokens(ctxGaugeLimit)} ({pct.toFixed(1)}%)
          </p>
          <p className="text-muted-foreground">
            {formatTokens(remaining)} {t('input.remaining')}
          </p>
          {onCompressContext && (
            <p className="text-muted-foreground">
              {isCompressing
                ? t('input.compressingContext', { defaultValue: 'Compressing context...' })
                : t('input.doubleClickCompressContext', {
                    defaultValue: 'Double-click to compress context'
                  })}
            </p>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

function ActiveMcpsBadge({ projectId }: { projectId?: string | null }): React.JSX.Element | null {
  const { t } = useTranslation('chat')
  const activeMcpIdsByProject = useMcpStore((s) => s.activeMcpIdsByProject)
  const servers = useMcpStore((s) => s.servers)
  const serverStatuses = useMcpStore((s) => s.serverStatuses)
  const serverTools = useMcpStore((s) => s.serverTools)
  const activeMcpIds = React.useMemo(
    () =>
      resolveEffectiveActiveMcpIds({
        projectId,
        activeMcpIdsByProject,
        servers,
        serverStatuses
      }),
    [activeMcpIdsByProject, projectId, serverStatuses, servers]
  )
  if (activeMcpIds.length === 0) return null
  const activeServers = servers.filter((s) => activeMcpIds.includes(s.id))
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="composer-status-pill flex cursor-default items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px]">
          <span className="size-1.5 rounded-full bg-current animate-pulse opacity-80" />
          <span>{t('skills.mcpCount', { count: activeMcpIds.length })}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="text-xs font-medium">{t('skills.activeMcpServers')}</p>
        {activeServers.map((s) => (
          <p key={s.id} className="text-xs text-muted-foreground">
            {s.name} ({t('skills.mcpToolCount', { count: serverTools[s.id]?.length ?? 0 })})
          </p>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}

function ActiveExtensionsBadge({
  projectId
}: {
  projectId?: string | null
}): React.JSX.Element | null {
  const { t } = useTranslation('chat')
  const activeExtensionIdsByProject = useExtensionStore((s) => s.activeExtensionIdsByProject)
  const extensions = useExtensionStore((s) => s.extensions)
  const activeExtensionIds = React.useMemo(
    () =>
      resolveEffectiveActiveExtensionIds({
        projectId,
        activeExtensionIdsByProject,
        extensions
      }),
    [activeExtensionIdsByProject, extensions, projectId]
  )
  if (activeExtensionIds.length === 0) return null

  const activeExtensions = extensions.filter((extension) =>
    activeExtensionIds.includes(extension.id)
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="composer-status-pill flex cursor-default items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px]">
          <Shapes className="size-3" />
          <span>{t('skills.extensionCount', { count: activeExtensionIds.length })}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="text-xs font-medium">{t('skills.activeCustomExtensions')}</p>
        {activeExtensions.map((extension) => (
          <p key={extension.id} className="text-xs text-muted-foreground">
            {extension.manifest.name} (
            {t('skills.extensionToolCount', { count: extension.manifest.tools.length })})
          </p>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}

const placeholderKeys: Record<AppMode, string> = {
  chat: 'input.placeholder',
  clarify: 'input.placeholderClarify',
  cowork: 'input.placeholderCowork',
  code: 'input.placeholderCode',
  acp: 'input.placeholderAcp'
}

const defaultRecommendationKeys: Record<AppMode, string> = {
  chat: 'input.recommendationDefaultChat',
  clarify: 'input.recommendationDefaultClarify',
  cowork: 'input.recommendationDefaultCowork',
  code: 'input.recommendationDefaultCode',
  acp: 'input.recommendationDefaultAcp'
}

interface FileSearchItem {
  name: string
  path: string
}

interface SlashSuggestionItem {
  key: string
  name: string
  label?: string
  summary: string
  kind: 'command' | 'skill' | 'plugin'
  pluginId?: AppPluginId
}

interface AppPluginPromptItem {
  id: AppPluginId
  title: string
  description: string
}

const EMPTY_QUEUED_MESSAGES: PendingSessionMessageItem[] = []
const INTERNAL_FILE_DRAG_MIME = 'application/x-opencowork-file-paths'
const IMAGE_MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp'
}
const MIN_INPUT_HEIGHT = 120
const DEFAULT_SESSION_INPUT_HEIGHT = 160
const MAX_INPUT_HEIGHT = 500
const MIN_MESSAGE_LIST_HEIGHT = 120
const EDITOR_MIN_HEIGHT = 60
const FALLBACK_MAX_VIEWPORT_RATIO = 0.6
const MAX_SLASH_COMMAND_RESULTS = 8
const BUILTIN_SLASH_COMMANDS: CommandCatalogItem[] = []
type ContextCompressionStatus = 'idle' | 'compressing' | ManualCompressionResult

interface RuntimeOutputSnapshot {
  text: string
  hasTextOutput: boolean
  hasActiveThinking: boolean
}

type RuntimeMetricTone = 'input' | 'cacheHit' | 'cacheCreate' | 'output' | 'speed' | 'latency'

interface RuntimeStatusView {
  text: string
  Icon: LucideIcon
  className: string
  spin?: boolean
}

interface RuntimeUsageTotals {
  inputTokens: number
  outputTokens: number
  billableInputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  cacheCreation5mTokens: number
  cacheCreation1hTokens: number
  inputCost: number | null
  outputCost: number | null
  cacheReadCost: number | null
  cacheCreationCost: number | null
  totalCost: number | null
  latestRequestTiming: RequestTiming | null
}

function normalizeTokenCount(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

function toFinitePositiveNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function getLatestRequestTiming(usage: TokenUsage | undefined): RequestTiming | null {
  const timings = usage?.requestTimings
  if (!timings?.length) return null
  for (let index = timings.length - 1; index >= 0; index -= 1) {
    const timing = timings[index]
    if (
      toFinitePositiveNumber(timing?.ttftMs) !== null ||
      toFinitePositiveNumber(timing?.tps) !== null
    ) {
      return timing
    }
  }
  return null
}

function formatRuntimeThroughput(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return value >= 100 ? value.toFixed(1) : value.toFixed(2)
}

function formatRuntimeTtft(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)}s`
  return formatDurationMs(ms)
}

function sumNullableCost(current: number | null, next: number | null): number | null {
  if (next == null) return current
  return (current ?? 0) + next
}

function createEmptyRuntimeUsageTotals(): RuntimeUsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    billableInputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    inputCost: null,
    outputCost: null,
    cacheReadCost: null,
    cacheCreationCost: null,
    totalCost: null,
    latestRequestTiming: null
  }
}

function getBillableInputForUsage(usage: TokenUsage): number {
  return normalizeTokenCount(getBillableInputTokens(usage))
}

function addUsageToTotals(
  totals: RuntimeUsageTotals,
  usage: TokenUsage | undefined,
  modelCfg: import('@renderer/lib/api/types').AIModelConfig | null | undefined
): void {
  if (!usage) return
  totals.inputTokens += normalizeTokenCount(usage.inputTokens)
  totals.outputTokens += normalizeTokenCount(usage.outputTokens)
  totals.billableInputTokens += getBillableInputForUsage(usage)
  totals.cacheReadTokens += normalizeTokenCount(usage.cacheReadTokens)
  totals.cacheCreationTokens += normalizeTokenCount(getCacheCreationTokens(usage))
  const cacheCreationSplit = getCacheCreationSplit(usage)
  totals.cacheCreation5mTokens += normalizeTokenCount(cacheCreationSplit.fiveMinuteTokens)
  totals.cacheCreation1hTokens += normalizeTokenCount(cacheCreationSplit.oneHourTokens)
  totals.latestRequestTiming = getLatestRequestTiming(usage) ?? totals.latestRequestTiming

  const costBreakdown = calculateCostBreakdown(usage, modelCfg)
  totals.inputCost = sumNullableCost(totals.inputCost, costBreakdown.inputCost)
  totals.outputCost = sumNullableCost(totals.outputCost, costBreakdown.outputCost)
  totals.cacheReadCost = sumNullableCost(totals.cacheReadCost, costBreakdown.cacheReadCost)
  totals.cacheCreationCost = sumNullableCost(
    totals.cacheCreationCost,
    costBreakdown.cacheCreationCost
  )

  const msgCost = calculateCost(usage, modelCfg)
  if (msgCost !== null) {
    totals.totalCost = (totals.totalCost ?? 0) + msgCost
  }
}

function collectRuntimeOutputSnapshot(
  content: UnifiedMessage['content'] | undefined
): RuntimeOutputSnapshot {
  if (!content) {
    return { text: '', hasTextOutput: false, hasActiveThinking: false }
  }

  if (typeof content === 'string') {
    return {
      text: content,
      hasTextOutput: content.trim().length > 0,
      hasActiveThinking: false
    }
  }

  const parts: string[] = []
  let hasTextOutput = false
  let hasActiveThinking = false

  for (const block of content) {
    if (block.type === 'text') {
      if (block.text) {
        parts.push(block.text)
        hasTextOutput = hasTextOutput || block.text.trim().length > 0
      }
      continue
    }

    if (block.type === 'thinking') {
      if (block.thinking) {
        parts.push(block.thinking)
      }
      if (!block.completedAt && block.thinking.trim().length > 0) {
        hasActiveThinking = true
      }
    }
  }

  return {
    text: parts.join('\n'),
    hasTextOutput,
    hasActiveThinking
  }
}

function SmoothTokenNumber({
  value,
  animate = true,
  duration = 650
}: {
  value: number
  animate?: boolean
  duration?: number
}): React.JSX.Element {
  const safeValue = normalizeTokenCount(value)
  const previousValueRef = React.useRef(safeValue)
  const startFrom =
    animate && safeValue > previousValueRef.current ? previousValueRef.current : safeValue

  React.useEffect(() => {
    previousValueRef.current = safeValue
  }, [safeValue])

  return (
    <TokenCounter
      target={safeValue}
      startFrom={startFrom}
      duration={duration}
      animate={animate && safeValue !== startFrom}
    />
  )
}

const metricToneClasses: Record<RuntimeMetricTone, string> = {
  input: 'text-sky-500/85 dark:text-sky-300/85',
  cacheHit: 'text-emerald-500/85 dark:text-emerald-300/85',
  cacheCreate: 'text-amber-500/90 dark:text-amber-300/90',
  output: 'text-violet-500/85 dark:text-violet-300/85',
  speed: 'text-cyan-500/85 dark:text-cyan-300/85',
  latency: 'text-rose-500/80 dark:text-rose-300/80'
}

function MetricHoverTip({
  label,
  children
}: {
  label?: React.ReactNode
  children: React.ReactElement
}): React.JSX.Element {
  if (!label) return children
  return (
    <HoverCard openDelay={180} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="center"
        sideOffset={6}
        className="w-auto max-w-[260px] px-2.5 py-1.5 text-[11px] leading-snug"
      >
        {label}
      </HoverCardContent>
    </HoverCard>
  )
}

function RuntimeMetric({
  label,
  value,
  tone,
  animate = true,
  duration = 600,
  suffix,
  title
}: {
  label: string
  value: number
  tone: RuntimeMetricTone
  animate?: boolean
  duration?: number
  suffix?: string
  title?: React.ReactNode
}): React.JSX.Element {
  const body = (
    <span className={cn('shrink-0', title && 'cursor-help')}>
      <span className="text-muted-foreground/60">{label}</span>{' '}
      <span className={cn('tabular-nums font-medium', metricToneClasses[tone])}>
        <SmoothTokenNumber value={value} animate={animate} duration={duration} />
      </span>
      {suffix && <span className="ml-0.5 tabular-nums text-muted-foreground/50">{suffix}</span>}
    </span>
  )
  return <MetricHoverTip label={title}>{body}</MetricHoverTip>
}

function RuntimeTextMetric({
  label,
  value,
  tone,
  suffix,
  hint
}: {
  label: string
  value: string
  tone: RuntimeMetricTone
  suffix?: string
  hint?: string
}): React.JSX.Element {
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <span className="inline-flex items-center gap-1">
        <span className="text-muted-foreground/60">{label}</span>{' '}
        <span className={cn('tabular-nums font-medium', metricToneClasses[tone])}>{value}</span>
      </span>
      {suffix && <span className="ml-0.5 tabular-nums text-muted-foreground/50">{suffix}</span>}
      {hint ? (
        <MetricHoverTip label={hint}>
          <span className="inline-flex items-center">
            <CircleHelp
              className="size-3 shrink-0 cursor-help text-muted-foreground/50 hover:text-muted-foreground"
              aria-label={hint}
            />
          </span>
        </MetricHoverTip>
      ) : null}
    </span>
  )
}

interface ComposerRuntimeStatusProps {
  sessionId: string
  isStreaming: boolean
  draftInputTokens: number
  isOptimizing?: boolean
  pendingImageReads?: number
  contextCompressionStatus: ContextCompressionStatus
  contextCompressionStatusLabel: string
  model?: AIModelConfig | null
  className?: string
}

function ComposerRuntimeStatus({
  sessionId,
  isStreaming,
  draftInputTokens,
  isOptimizing = false,
  pendingImageReads = 0,
  contextCompressionStatus,
  contextCompressionStatusLabel,
  model,
  className
}: ComposerRuntimeStatusProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const live = useChatStore(
    useShallow((s) => {
      const targetSessionId = sessionId
      const streamingMessageId = s.streamingMessages[targetSessionId] ?? null
      const idx = s.sessionsById[targetSessionId]
      const totals = createEmptyRuntimeUsageTotals()
      const message =
        idx !== undefined && streamingMessageId
          ? s.sessions[idx]?.messages.find((item) => item.id === streamingMessageId)
          : undefined
      const messages = idx !== undefined ? s.sessions[idx]?.messages : undefined
      if (messages) {
        const { providers } = useProviderStore.getState()
        for (const item of messages) {
          const reqModel = item.meta?.requestModel
          const providerId = reqModel?.providerId ?? item.debugInfo?.providerId ?? null
          const modelId = reqModel?.modelId ?? item.debugInfo?.model ?? model?.id ?? null
          const provider = providerId ? (providers.find((p) => p.id === providerId) ?? null) : null
          const msgModelCfg =
            (provider && modelId
              ? (provider.models.find((m) => m.id === modelId) ?? null)
              : null) ??
            (model && modelId === model.id ? model : null) ??
            model ??
            null
          addUsageToTotals(totals, item.usage, msgModelCfg)
        }
      }
      const messageIndex =
        messages && streamingMessageId
          ? messages.findIndex((item) => item.id === streamingMessageId)
          : -1
      let previousUserMessage: UnifiedMessage | undefined
      if (messages && messageIndex > 0) {
        for (let index = messageIndex - 1; index >= 0; index -= 1) {
          if (messages[index]?.role === 'user') {
            previousUserMessage = messages[index]
            break
          }
        }
      }

      return {
        targetSessionId,
        streamingMessageId,
        content: message?.content,
        previousUserContent: previousUserMessage?.content,
        revision: message?._revision ?? 0,
        currentInputTokens: normalizeTokenCount(message?.usage?.inputTokens),
        currentOutputTokens: normalizeTokenCount(message?.usage?.outputTokens),
        currentContextTokens: normalizeTokenCount(message?.usage?.contextTokens),
        cumulativeInputTokens: totals.inputTokens,
        cumulativeOutputTokens: totals.outputTokens,
        cumulativeBillableInputTokens: totals.billableInputTokens,
        cumulativeCacheReadTokens: totals.cacheReadTokens,
        cumulativeCacheCreationTokens: totals.cacheCreationTokens,
        cumulativeCacheCreation5mTokens: totals.cacheCreation5mTokens,
        cumulativeCacheCreation1hTokens: totals.cacheCreation1hTokens,
        cumulativeInputCost: totals.inputCost,
        cumulativeOutputCost: totals.outputCost,
        cumulativeCacheReadCost: totals.cacheReadCost,
        cumulativeCacheCreationCost: totals.cacheCreationCost,
        cumulativeTotalCost: totals.totalCost,
        latestRequestTiming: totals.latestRequestTiming,
        isGeneratingImage: streamingMessageId
          ? Boolean(s.generatingImageMessages[streamingMessageId])
          : false
      }
    })
  )
  const targetSessionId = live.targetSessionId
  const agentRuntime = useAgentStore(
    useShallow((s) => {
      const useLiveBuckets = targetSessionId === s.liveSessionId
      const cache = targetSessionId ? s.sessionToolCallsCache[targetSessionId] : undefined
      const subAgentCache = targetSessionId
        ? s.sessionSubAgentLiveCache[targetSessionId]
        : undefined
      const pending = useLiveBuckets ? s.pendingToolCalls : (cache?.pending ?? [])
      const executed = useLiveBuckets ? s.executedToolCalls : (cache?.executed ?? [])
      const activeSubAgents = useLiveBuckets ? s.activeSubAgents : (subAgentCache?.active ?? {})
      const allToolCalls = [...pending, ...executed]
      const activeTool = [...allToolCalls]
        .reverse()
        .find((toolCall) => toolCall.status === 'streaming' || toolCall.status === 'running')
      const pendingApprovalTool = pending.find((toolCall) => toolCall.status === 'pending_approval')
      const activeSubAgentCount = Object.values(activeSubAgents).filter(
        (subAgent) => subAgent.isRunning
      ).length

      return {
        sessionStatus: targetSessionId ? (s.runningSessions[targetSessionId] ?? null) : null,
        retryAttempt: targetSessionId
          ? (s.sessionRequestRetryState[targetSessionId]?.attempt ?? null)
          : null,
        retryMaxAttempts: targetSessionId
          ? (s.sessionRequestRetryState[targetSessionId]?.maxAttempts ?? null)
          : null,
        activeToolName: activeTool?.name ?? null,
        pendingApprovalToolName: pendingApprovalTool?.name ?? null,
        activeSubAgentCount
      }
    })
  )
  const outputSnapshot = collectRuntimeOutputSnapshot(live.content)
  const estimatedOutputTokens = React.useMemo(
    () => estimateTokens(outputSnapshot.text),
    [outputSnapshot.text]
  )
  const previousUserInputSnapshot = collectRuntimeOutputSnapshot(live.previousUserContent)
  const previousUserInputTokens = React.useMemo(
    () => estimateTokens(previousUserInputSnapshot.text),
    [previousUserInputSnapshot.text]
  )
  const currentEstimatedInputTokens = Math.max(
    live.currentInputTokens,
    live.currentContextTokens,
    draftInputTokens,
    previousUserInputTokens
  )
  const pendingInputTokens =
    isStreaming && live.currentInputTokens === 0 ? currentEstimatedInputTokens : draftInputTokens
  const inputTokens = live.cumulativeBillableInputTokens + pendingInputTokens
  const outputTokens =
    live.cumulativeOutputTokens +
    (isStreaming ? Math.max(0, estimatedOutputTokens - live.currentOutputTokens) : 0)
  const cacheReadTokens = live.cumulativeCacheReadTokens
  const cacheCreationTokens = live.cumulativeCacheCreationTokens
  const cacheCreation5mTokens = live.cumulativeCacheCreation5mTokens
  const cacheCreation1hTokens = live.cumulativeCacheCreation1hTokens
  const cacheHitRate = getCacheHitRate(inputTokens, cacheReadTokens, cacheCreationTokens)
  const streamingExtraUsage = React.useMemo<TokenUsage | null>(() => {
    if (!isStreaming || !model) return null
    const estimatedBillableInputTokens =
      live.currentInputTokens === 0 ? currentEstimatedInputTokens : 0
    const estimatedOutputDelta = Math.max(0, estimatedOutputTokens - live.currentOutputTokens)
    if (estimatedBillableInputTokens <= 0 && estimatedOutputDelta <= 0) return null
    return {
      inputTokens: estimatedBillableInputTokens,
      billableInputTokens: estimatedBillableInputTokens,
      outputTokens: estimatedOutputDelta,
      cacheReadTokens: 0,
      cacheCreationTokens: 0
    }
  }, [
    currentEstimatedInputTokens,
    estimatedOutputTokens,
    isStreaming,
    live.currentInputTokens,
    live.currentOutputTokens,
    model
  ])
  const streamingExtraCostBreakdown = React.useMemo(
    () =>
      streamingExtraUsage && model ? calculateCostBreakdown(streamingExtraUsage, model) : null,
    [model, streamingExtraUsage]
  )
  const streamingExtraCost =
    streamingExtraUsage && model ? calculateCost(streamingExtraUsage, model) : null
  const totalInputCost = sumNullableCost(
    live.cumulativeInputCost ?? null,
    streamingExtraCostBreakdown?.inputCost ?? null
  )
  const totalOutputCost = sumNullableCost(
    live.cumulativeOutputCost ?? null,
    streamingExtraCostBreakdown?.outputCost ?? null
  )
  const totalCacheReadCost = sumNullableCost(
    live.cumulativeCacheReadCost ?? null,
    streamingExtraCostBreakdown?.cacheReadCost ?? null
  )
  const totalCacheCreationCost = sumNullableCost(
    live.cumulativeCacheCreationCost ?? null,
    streamingExtraCostBreakdown?.cacheCreationCost ?? null
  )
  const totalCost = sumNullableCost(live.cumulativeTotalCost ?? null, streamingExtraCost ?? null)
  const metricPricing = React.useMemo(() => {
    const inputPrice = model?.inputPrice ?? null
    const outputPrice = model?.outputPrice ?? null
    const cacheReadPrice = model?.cacheHitPrice ?? (inputPrice != null ? inputPrice * 0.1 : null)
    const cacheCreatePrice =
      model?.cacheCreationPrice ?? (inputPrice != null ? inputPrice * 1.25 : null)
    const cacheCreate1hPrice = inputPrice != null ? inputPrice * 2 : null
    return { inputPrice, outputPrice, cacheReadPrice, cacheCreatePrice, cacheCreate1hPrice }
  }, [model])
  const buildCostTitle = React.useCallback(
    (label: string, tokens: number, pricePerMillion: number | null): string | undefined => {
      if (pricePerMillion == null || !Number.isFinite(pricePerMillion) || tokens <= 0)
        return undefined
      return t('input.runtimeMetrics.cost', {
        defaultValue: '{{label}}: {{cost}}',
        label,
        cost: formatCost((tokens * pricePerMillion) / 1_000_000)
      })
    },
    [t]
  )
  // Cache-write tokens are billed at two different TTL rates (5m vs 1h). Split the hover
  // tooltip so each bucket's tokens and cost are shown separately instead of one lumped total.
  const cacheCreationTitle = React.useMemo<React.ReactNode>(() => {
    if (cacheCreationTokens <= 0) return undefined
    const rows = [
      {
        key: '5m',
        label: t('input.runtimeMetrics.cacheCreate5m', { defaultValue: 'Cache write (5m)' }),
        tokens: cacheCreation5mTokens,
        price: metricPricing.cacheCreatePrice
      },
      {
        key: '1h',
        label: t('input.runtimeMetrics.cacheCreate1h', { defaultValue: 'Cache write (1h)' }),
        tokens: cacheCreation1hTokens,
        price: metricPricing.cacheCreate1hPrice
      }
    ].filter((row) => row.tokens > 0)
    if (rows.length === 0) return undefined
    return (
      <div className="flex flex-col gap-0.5">
        {rows.map((row) => {
          const cost =
            row.price != null && Number.isFinite(row.price)
              ? formatCost((row.tokens * row.price) / 1_000_000)
              : null
          return (
            <div key={row.key} className="flex items-center justify-between gap-3 tabular-nums">
              <span className="text-muted-foreground/70">{row.label}</span>
              <span>
                {formatTokens(row.tokens)}
                {cost ? ` · ${cost}` : ''}
              </span>
            </div>
          )
        })}
      </div>
    )
  }, [
    cacheCreationTokens,
    cacheCreation5mTokens,
    cacheCreation1hTokens,
    metricPricing.cacheCreatePrice,
    metricPricing.cacheCreate1hPrice,
    t
  ])
  const latestTps = toFinitePositiveNumber(live.latestRequestTiming?.tps)
  const latestTtftMs = toFinitePositiveNumber(live.latestRequestTiming?.ttftMs)
  const statusView = React.useMemo<RuntimeStatusView>(() => {
    if (isOptimizing) {
      return {
        text: t('input.runtimeStatus.optimizing', { defaultValue: 'Optimizing' }),
        Icon: Sparkles,
        className: 'text-violet-500/80 dark:text-violet-300/80'
      }
    }
    if (pendingImageReads > 0) {
      return {
        text: t('input.runtimeStatus.loadingMedia', { defaultValue: 'Loading media' }),
        Icon: ImageIcon,
        className: 'text-amber-500/85 dark:text-amber-300/85'
      }
    }
    if (contextCompressionStatus !== 'idle' && contextCompressionStatusLabel) {
      return {
        text: contextCompressionStatusLabel,
        Icon: contextCompressionStatus === 'compressed' ? CheckCircle2 : RefreshCcw,
        className:
          contextCompressionStatus === 'compressed'
            ? 'text-emerald-500/80 dark:text-emerald-300/80'
            : contextCompressionStatus === 'failed'
              ? 'text-red-500/80 dark:text-red-300/80'
              : 'text-amber-500/85 dark:text-amber-300/85',
        spin: contextCompressionStatus === 'compressing'
      }
    }
    if (agentRuntime.pendingApprovalToolName) {
      return {
        text: t('input.runtimeStatus.awaitingApproval', {
          defaultValue: 'Awaiting approval: {{tool}}',
          tool: agentRuntime.pendingApprovalToolName
        }),
        Icon: ShieldAlert,
        className: 'text-amber-500/90 dark:text-amber-300/90'
      }
    }
    if (agentRuntime.sessionStatus === 'retrying') {
      const attempt =
        agentRuntime.retryAttempt && agentRuntime.retryMaxAttempts
          ? `${agentRuntime.retryAttempt}/${agentRuntime.retryMaxAttempts}`
          : ''
      return {
        text: t('input.runtimeStatus.retrying', {
          defaultValue: 'Retrying {{attempt}}',
          attempt
        }).trim(),
        Icon: RefreshCcw,
        className: 'text-amber-500/90 dark:text-amber-300/90',
        spin: true
      }
    }
    if (live.isGeneratingImage) {
      return {
        text: t('input.runtimeStatus.generatingImage', { defaultValue: 'Generating image' }),
        Icon: ImageIcon,
        className: 'text-violet-500/80 dark:text-violet-300/80'
      }
    }
    if (agentRuntime.activeToolName) {
      return {
        text: t('input.runtimeStatus.runningTool', {
          defaultValue: 'Running {{tool}}',
          tool: agentRuntime.activeToolName
        }),
        Icon: Wrench,
        className: 'text-sky-500/85 dark:text-sky-300/85'
      }
    }
    if (agentRuntime.activeSubAgentCount > 0) {
      return {
        text: t('input.runtimeStatus.runningSubAgents', {
          defaultValue: '{{count}} sub-agents running',
          count: agentRuntime.activeSubAgentCount
        }),
        Icon: Users,
        className: 'text-cyan-500/85 dark:text-cyan-300/85'
      }
    }
    if (isStreaming && outputSnapshot.hasActiveThinking && !outputSnapshot.hasTextOutput) {
      return {
        text: t('input.runtimeStatus.thinking', { defaultValue: 'Thinking' }),
        Icon: Brain,
        className: 'text-violet-500/85 dark:text-violet-300/85'
      }
    }
    if (isStreaming && (outputTokens > 0 || outputSnapshot.hasTextOutput)) {
      return {
        text: t('input.runtimeStatus.receiving', { defaultValue: 'Receiving' }),
        Icon: Activity,
        className: 'text-emerald-500/85 dark:text-emerald-300/85'
      }
    }
    if (isStreaming) {
      return {
        text: t('input.runtimeStatus.waiting', { defaultValue: 'Waiting' }),
        Icon: Clock,
        className: 'text-sky-500/80 dark:text-sky-300/80'
      }
    }
    return {
      text: t('input.runtimeStatus.ready', { defaultValue: 'Ready' }),
      Icon: CheckCircle2,
      className: 'text-muted-foreground/55'
    }
  }, [
    agentRuntime.activeSubAgentCount,
    agentRuntime.activeToolName,
    agentRuntime.pendingApprovalToolName,
    agentRuntime.retryAttempt,
    agentRuntime.retryMaxAttempts,
    agentRuntime.sessionStatus,
    contextCompressionStatus,
    contextCompressionStatusLabel,
    isOptimizing,
    isStreaming,
    live.isGeneratingImage,
    outputSnapshot.hasActiveThinking,
    outputSnapshot.hasTextOutput,
    outputTokens,
    pendingImageReads,
    t
  ])
  const StatusIcon = statusView.Icon
  const totalCostRows = React.useMemo(
    () =>
      [
        {
          key: 'input',
          label: t('input.runtimeMetrics.input', { defaultValue: 'Uncached input' }),
          color: '#38bdf8',
          value: totalInputCost
        },
        {
          key: 'cacheHit',
          label: t('input.runtimeMetrics.cacheHit', { defaultValue: 'Cache hit' }),
          color: '#84cc16',
          value: totalCacheReadCost
        },
        {
          key: 'cacheCreate',
          label: t('input.runtimeMetrics.cacheCreate', { defaultValue: 'Cache write' }),
          color: '#f59e0b',
          value: totalCacheCreationCost
        },
        {
          key: 'output',
          label: t('input.runtimeMetrics.output', { defaultValue: 'Output' }),
          color: '#a855f7',
          value: totalOutputCost
        }
      ].filter(
        (row): row is { key: string; label: string; color: string; value: number } =>
          typeof row.value === 'number' && row.value > 0
      ),
    [t, totalCacheCreationCost, totalCacheReadCost, totalInputCost, totalOutputCost]
  )

  return (
    <div
      className={cn(
        'flex min-h-4 min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[10px] leading-4 text-muted-foreground/65',
        className
      )}
      aria-live={isStreaming ? 'polite' : 'off'}
    >
      <RuntimeMetric
        label={t('input.runtimeMetrics.input', { defaultValue: 'Uncached input' })}
        value={inputTokens}
        tone="input"
        animate={isStreaming}
        duration={520}
        title={buildCostTitle(
          t('input.runtimeMetrics.input', { defaultValue: 'Uncached input' }),
          inputTokens,
          metricPricing.inputPrice
        )}
      />
      <span className="shrink-0 text-muted-foreground/35">/</span>
      <RuntimeMetric
        label={t('input.runtimeMetrics.cacheHit', { defaultValue: 'Cache hit' })}
        value={cacheReadTokens}
        tone="cacheHit"
        animate={isStreaming}
        duration={620}
        suffix={formatCacheHitRate(cacheHitRate)}
        title={buildCostTitle(
          t('input.runtimeMetrics.cacheHit', { defaultValue: 'Cache hit' }),
          cacheReadTokens,
          metricPricing.cacheReadPrice
        )}
      />
      <span className="shrink-0 text-muted-foreground/35">/</span>
      <RuntimeMetric
        label={t('input.runtimeMetrics.cacheCreate', { defaultValue: 'Cache write' })}
        value={cacheCreationTokens}
        tone="cacheCreate"
        animate={isStreaming}
        duration={620}
        title={
          cacheCreationTitle ??
          buildCostTitle(
            t('input.runtimeMetrics.cacheCreate', { defaultValue: 'Cache write' }),
            cacheCreationTokens,
            metricPricing.cacheCreatePrice
          )
        }
      />
      <span className="shrink-0 text-muted-foreground/35">/</span>
      <RuntimeMetric
        label={t('input.runtimeMetrics.output', { defaultValue: 'Output' })}
        value={outputTokens}
        tone="output"
        animate
        duration={760}
        title={buildCostTitle(
          t('input.runtimeMetrics.output', { defaultValue: 'Output' }),
          outputTokens,
          metricPricing.outputPrice
        )}
      />
      {latestTps !== null && (
        <>
          <span className="shrink-0 text-muted-foreground/35">/</span>
          <RuntimeTextMetric
            label={t('input.runtimeMetrics.tps', { defaultValue: 'TPS' })}
            value={formatRuntimeThroughput(latestTps)}
            tone="speed"
            hint={t('input.runtimeMetrics.tpsHint', {
              defaultValue: 'Output tokens generated per second'
            })}
          />
        </>
      )}
      {latestTtftMs !== null && (
        <>
          <span className="shrink-0 text-muted-foreground/35">/</span>
          <RuntimeTextMetric
            label={t('input.runtimeMetrics.ttft', { defaultValue: 'TTFT' })}
            value={formatRuntimeTtft(latestTtftMs)}
            tone="latency"
            hint={t('input.runtimeMetrics.ttftHint', {
              defaultValue: 'Time to first token'
            })}
          />
        </>
      )}
      <span className="shrink-0 text-muted-foreground/35">/</span>
      <span className={cn('inline-flex min-w-0 items-center gap-1 truncate', statusView.className)}>
        <StatusIcon className={cn('size-3 shrink-0', statusView.spin && 'animate-spin')} />
        <span className="min-w-0 truncate">{statusView.text}</span>
      </span>
      {totalCost !== null && totalCost > 0 && (
        <>
          <span className="shrink-0 text-muted-foreground/35">/</span>
          <HoverCard openDelay={180} closeDelay={100}>
            <HoverCardTrigger asChild>
              <span className="shrink-0 cursor-help tabular-nums text-muted-foreground/60">
                <span className="text-muted-foreground/60">
                  {t('input.runtimeMetrics.totalCost', { defaultValue: 'Cost' })}
                </span>{' '}
                <span className="font-medium text-emerald-500/85 dark:text-emerald-300/85">
                  {formatCost(totalCost)}
                </span>
              </span>
            </HoverCardTrigger>
            <HoverCardContent
              side="top"
              align="end"
              sideOffset={6}
              className="w-[280px] rounded-lg border-[#262626] bg-[#101010] p-3 text-zinc-100 shadow-2xl"
            >
              <div className="space-y-1">
                {totalCostRows.map((row) => (
                  <div key={row.key} className="flex items-center justify-between gap-4 text-xs">
                    <span className="flex min-w-0 items-center gap-1.5 text-zinc-400">
                      <span
                        className="size-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: row.color }}
                      />
                      <span className="truncate">{row.label}</span>
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums text-zinc-100">
                      {formatCost(row.value)}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-2 border-t border-white/9 pt-2">
                <div className="flex items-center justify-between gap-4 text-xs">
                  <span className="truncate text-zinc-400">
                    {t('input.runtimeMetrics.totalCost', { defaultValue: 'Cost' })}
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums text-zinc-100">
                    {formatCost(totalCost)}
                  </span>
                </div>
              </div>
            </HoverCardContent>
          </HoverCard>
        </>
      )}
    </div>
  )
}

function getAppPluginPromptContent(pluginId: AppPluginId): string {
  if (pluginId === PRODUCT_DESIGN_PLUGIN_ID) {
    return [
      `[Skill: ${PRODUCT_DESIGN_PLUGIN_ID}]`,
      'Use the Product Design workflow plugin for this request.',
      'Start by loading the product-design skill, confirm the design brief when needed, use saved Product Design context when relevant, and follow the workflow guardrails before building or handing off.'
    ].join('\n')
  }

  if (pluginId === IMAGE_PLUGIN_ID) {
    return [
      `[Plugin: ${pluginId}]`,
      'Use the Image Plugin for this request. When generating images, call ImageGenerate with a concrete prompt; when reference images are selected, pass them through reference_images.'
    ].join('\n')
  }

  if (pluginId === BROWSER_PLUGIN_ID) {
    return [
      `[Plugin: ${pluginId}]`,
      'Use the Browser Plugin for this request. Navigate, inspect, capture screenshots, and read page content with the browser tools when web evidence or prototype QA is needed.'
    ].join('\n')
  }

  return [
    `[Plugin: ${pluginId}]`,
    `Use the ${pluginId} plugin for this request when its tools or workflow are relevant.`
  ].join('\n')
}

function getSlashCommandQuery(text: string): string | null {
  const normalized = text.trimStart()
  const match = normalized.match(/^\/([^\s]*)$/)
  return match ? (match[1] ?? '') : null
}

function scoreSlashCommand(name: string, query: string): number {
  const normalizedName = name.toLowerCase()
  const normalizedQuery = query.trim().toLowerCase()

  if (!normalizedQuery) return 0
  if (normalizedName === normalizedQuery) return 0
  if (normalizedName.startsWith(normalizedQuery)) return 1

  const containsIndex = normalizedName.indexOf(normalizedQuery)
  if (containsIndex >= 0) return 10 + containsIndex

  let cursor = 0
  let gapScore = 0
  for (const char of normalizedQuery) {
    const nextIndex = normalizedName.indexOf(char, cursor)
    if (nextIndex < 0) return Number.POSITIVE_INFINITY
    gapScore += nextIndex - cursor
    cursor = nextIndex + 1
  }

  return 100 + gapScore
}

function areQueuedMessagesEqual(
  left: PendingSessionMessageItem[],
  right: PendingSessionMessageItem[]
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) {
    const leftMsg = left[i]
    const rightMsg = right[i]
    if (leftMsg.id !== rightMsg.id) return false
    if (leftMsg.text !== rightMsg.text) return false
    if (leftMsg.createdAt !== rightMsg.createdAt) return false
    if (leftMsg.command?.name !== rightMsg.command?.name) return false
    if (leftMsg.command?.content !== rightMsg.command?.content) return false
    if (leftMsg.images.length !== rightMsg.images.length) return false
    for (let j = 0; j < leftMsg.images.length; j += 1) {
      if (leftMsg.images[j].id !== rightMsg.images[j].id) return false
    }
  }
  return true
}

function summarizeQueuedMessage(text: string): string {
  const normalized = selectFileTextToPlainText(text).replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > 72 ? `${normalized.slice(0, 72)}…` : normalized
}

function isReferenceOnlyDocument(document: EditorDocumentNode[]): boolean {
  if (document.length === 0) return false

  return document.every((node) => node.type !== 'text' || node.text.trim().length === 0)
}

function getImageMediaTypeForPath(filePath: string): string | null {
  const normalized = filePath.split(/[?#]/, 1)[0]?.toLowerCase() ?? ''
  const extension = normalized.match(/\.([a-z0-9]+)$/)?.[1]
  return extension ? (IMAGE_MEDIA_TYPE_BY_EXTENSION[extension] ?? null) : null
}

function createImageAttachmentId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `image-${Date.now()}-${Math.random().toString(36)}`
}

function selectedFileItemToReference(file: SelectedFileItem): SelectedFileReference {
  return {
    id: file.id,
    name: file.name,
    originalPath: file.originalPath,
    sendPath: file.sendPath,
    previewPath: file.previewPath,
    isWorkspaceFile: file.isWorkspaceFile
  }
}

function ReadOnlyModelBadge({
  model
}: {
  model?: MessageRequestModelMeta | null
}): React.JSX.Element {
  const { t } = useTranslation('chat')
  const modelName =
    model?.modelName?.trim() ||
    model?.modelId?.trim() ||
    t('input.modelResolving', { defaultValue: 'Model pending' })
  const providerName =
    model?.providerName?.trim() ||
    model?.providerBuiltinId?.trim() ||
    model?.providerId?.trim() ||
    ''
  const title = providerName
    ? t('input.readOnlyModelWithProvider', {
        defaultValue: 'Sub-agent model: {{model}} · {{provider}}',
        model: modelName,
        provider: providerName
      })
    : t('input.readOnlyModel', {
        defaultValue: 'Sub-agent model: {{model}}',
        model: modelName
      })

  return (
    <div
      className="composer-control inline-flex h-8 max-w-[14rem] cursor-default items-center gap-2 rounded-lg border border-border/65 bg-muted/35 px-2 text-left text-foreground/85"
      title={title}
      aria-label={title}
      aria-readonly="true"
    >
      <ModelIcon
        icon={model?.modelIcon ?? undefined}
        modelId={model?.modelId ?? undefined}
        providerBuiltinId={model?.providerBuiltinId ?? undefined}
        size={16}
        className="shrink-0"
      />
      <span className="min-w-0 truncate text-xs font-medium">{modelName}</span>
    </div>
  )
}

interface InputAreaProps {
  sessionId?: string | null
  onSend: (text: string, images?: ImageAttachment[], options?: SendMessageOptions) => void
  onStop?: () => void
  onSelectFolder?: () => void
  isStreaming?: boolean
  workingFolder?: string
  hideWorkingFolderIndicator?: boolean
  hideWorkingFolderPicker?: boolean
  onCompressContext?: () => ManualCompressionResult | void | Promise<ManualCompressionResult | void>
  disabled?: boolean
  draftKeyOverride?: string | null
  suppressPendingQueue?: boolean
  hideGoalSessionBar?: boolean
  hideModeSwitch?: boolean
  modelRoute?: 'main' | 'fast'
  readOnlyModel?: MessageRequestModelMeta | null
  attachedFooter?: boolean
  fullWidth?: boolean
}

export function InputArea({
  sessionId,
  onSend,
  onStop,
  onSelectFolder,
  isStreaming = false,
  workingFolder,
  hideWorkingFolderIndicator = false,
  hideWorkingFolderPicker = false,
  onCompressContext,
  disabled = false,
  draftKeyOverride,
  suppressPendingQueue = false,
  hideGoalSessionBar = false,
  hideModeSwitch = false,
  modelRoute = 'main',
  readOnlyModel,
  attachedFooter = false,
  fullWidth = false
}: InputAreaProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const chatView = useUIStore((s) => s.chatView)
  const isSessionComposer = chatView === 'session' || Boolean(sessionId)
  const isHomeComposer = chatView === 'home' || chatView === 'project'
  const minComposerHeight = MIN_INPUT_HEIGHT
  const defaultSessionInputHeight = Math.max(DEFAULT_SESSION_INPUT_HEIGHT, minComposerHeight)
  const [documentNodes, setDocumentNodes] = React.useState<EditorDocumentNode[]>([])
  const [selectedFiles, setSelectedFiles] = React.useState<SelectedFileItem[]>([])
  const [highlightedFileId, setHighlightedFileId] = React.useState<string | null>(null)
  const [editorSelection, setEditorSelection] = React.useState({ start: 0, end: 0 })
  const text = React.useMemo(
    () => editorDocumentToPlainText(documentNodes, selectedFiles),
    [documentNodes, selectedFiles]
  )
  const finalSerializedText = React.useMemo(
    () => serializeEditorDocument(documentNodes, selectedFiles),
    [documentNodes, selectedFiles]
  )
  const debouncedTokens = useDebouncedTokens(finalSerializedText)
  const [selectedSkill, setSelectedSkill] = React.useState<string | null>(null)
  const [slashCommands, setSlashCommands] = React.useState<CommandCatalogItem[]>([])
  const [slashCommandsLoading, setSlashCommandsLoading] = React.useState(false)
  const [selectedSlashIndex, setSelectedSlashIndex] = React.useState(0)
  const [fileSearchResults, setFileSearchResults] = React.useState<FileSearchItem[]>([])
  const [fileSearchLoading, setFileSearchLoading] = React.useState(false)
  const [selectedFileSearchIndex, setSelectedFileSearchIndex] = React.useState(0)
  const [attachedImages, setAttachedImages] = React.useState<ImageAttachment[]>([])
  const [previewImage, setPreviewImage] = React.useState<ImageAttachment | null>(null)
  const [pendingImageReads, setPendingImageReads] = React.useState(0)
  const [isOptimizing, setIsOptimizing] = React.useState(false)
  const [contextCompressionStatus, setContextCompressionStatus] =
    React.useState<ContextCompressionStatus>('idle')
  const [, setOptimizingText] = React.useState('')
  const [optimizationOptions, setOptimizationOptions] = React.useState<
    Array<{ title: string; focus: string; content: string }>
  >([])
  const [showOptimizationDialog, setShowOptimizationDialog] = React.useState(false)
  const [selectedOptionIndex, setSelectedOptionIndex] = React.useState(0)
  const currentLanguage = useSettingsStore((state) => state.language)
  const mainModelSelectionMode = useSettingsStore((state) => state.mainModelSelectionMode)
  const clarifyAutoAcceptRecommended = useSettingsStore(
    (state) => state.clarifyAutoAcceptRecommended
  )
  const contentScrollRef = React.useRef<HTMLDivElement>(null)
  const editorRef = React.useRef<FileAwareEditorHandle | null>(null)
  const queueFileInputRef = React.useRef<HTMLInputElement>(null)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const draftSaveTimerRef = React.useRef<ReturnType<typeof setTimeout>>(undefined)
  const contextCompressionStatusTimerRef = React.useRef<ReturnType<typeof setTimeout>>(undefined)
  const [inputHeight, setInputHeight] = React.useState<number | null>(() =>
    isSessionComposer ? defaultSessionInputHeight : null
  )
  const [autoInputHeight, setAutoInputHeight] = React.useState<number>(() => minComposerHeight)
  const dragRef = React.useRef<{
    startY: number
    startH: number
    minH: number
    maxH: number
  } | null>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const imagePreviewRef = React.useRef<HTMLDivElement>(null)
  const bottomToolbarRef = React.useRef<HTMLDivElement>(null)
  const textRef = React.useRef(text)
  const documentRef = React.useRef(documentNodes)
  const selectedFilesRef = React.useRef(selectedFiles)
  const isContextCompressing = contextCompressionStatus === 'compressing'

  const getMaxInputHeight = React.useCallback(() => {
    const container = containerRef.current
    if (!container) {
      return Math.max(
        minComposerHeight,
        Math.min(MAX_INPUT_HEIGHT, Math.floor(window.innerHeight * FALLBACK_MAX_VIEWPORT_RATIO))
      )
    }
    const root = rootRef.current
    const messageListEl = root?.parentElement?.querySelector(
      '[data-message-list]'
    ) as HTMLElement | null
    if (messageListEl) {
      const messageListHeight = messageListEl.getBoundingClientRect().height
      const available = Math.max(0, messageListHeight - MIN_MESSAGE_LIST_HEIGHT)
      const dynamicMax = container.offsetHeight + available
      return Math.max(minComposerHeight, Math.min(MAX_INPUT_HEIGHT, Math.floor(dynamicMax)))
    }
    return Math.max(
      minComposerHeight,
      Math.min(MAX_INPUT_HEIGHT, Math.floor(window.innerHeight * FALLBACK_MAX_VIEWPORT_RATIO))
    )
  }, [minComposerHeight])
  const [autoMaxInputHeight, setAutoMaxInputHeight] = React.useState(() =>
    Math.max(
      MIN_INPUT_HEIGHT,
      Math.min(MAX_INPUT_HEIGHT, Math.floor(window.innerHeight * FALLBACK_MAX_VIEWPORT_RATIO))
    )
  )
  const composerWidthClass = fullWidth
    ? 'mx-auto w-full max-w-none'
    : 'mx-auto w-full max-w-[820px]'

  React.useEffect(() => {
    setInputHeight((current) => {
      if (!isSessionComposer) {
        return current === null ? current : null
      }

      return current ?? defaultSessionInputHeight
    })
  }, [defaultSessionInputHeight, isSessionComposer])

  React.useEffect(() => {
    return () => clearTimeout(contextCompressionStatusTimerRef.current)
  }, [])

  const getMinInputHeight = React.useCallback(() => {
    const container = containerRef.current
    const editorMetrics = editorRef.current?.getScrollMetrics()
    const imagePreviewHeight = imagePreviewRef.current?.offsetHeight ?? 0
    const bottomToolbarHeight = bottomToolbarRef.current?.offsetHeight ?? 0
    const explicitChromeHeight = imagePreviewHeight + bottomToolbarHeight + 28

    if (!container || !editorMetrics) {
      return Math.max(minComposerHeight, explicitChromeHeight + EDITOR_MIN_HEIGHT)
    }

    const chromeHeight = Math.max(0, container.offsetHeight - editorMetrics.clientHeight)
    return Math.max(
      minComposerHeight,
      Math.ceil(Math.max(chromeHeight, explicitChromeHeight) + EDITOR_MIN_HEIGHT)
    )
  }, [minComposerHeight])

  React.useEffect(() => {
    const updateAutoMaxInputHeight = (): void => {
      setAutoMaxInputHeight(getMaxInputHeight())
    }

    updateAutoMaxInputHeight()

    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            updateAutoMaxInputHeight()
          })
    const container = containerRef.current
    const root = rootRef.current
    const messageListEl = root?.parentElement?.querySelector(
      '[data-message-list]'
    ) as HTMLElement | null

    if (observer && container) {
      observer.observe(container)
    }
    if (observer && messageListEl) {
      observer.observe(messageListEl)
    }

    window.addEventListener('resize', updateAutoMaxInputHeight)
    return () => {
      window.removeEventListener('resize', updateAutoMaxInputHeight)
      observer?.disconnect()
    }
  }, [getMaxInputHeight])

  React.useEffect(() => {
    const onMouseMove = (e: MouseEvent): void => {
      if (!dragRef.current) return
      const delta = dragRef.current.startY - e.clientY
      const newH = Math.min(
        dragRef.current.maxH,
        Math.max(dragRef.current.minH, dragRef.current.startH + delta)
      )
      setInputHeight(newH)
    }
    const onMouseUp = (): void => {
      if (dragRef.current) {
        dragRef.current = null
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  React.useEffect(() => {
    if (inputHeight === null) return
    const clampInputHeight = (): void => {
      const minH = getMinInputHeight()
      const maxH = Math.max(minH, getMaxInputHeight())
      setInputHeight((prev) => {
        if (prev === null) return prev
        return Math.min(Math.max(prev, minH), maxH)
      })
    }
    clampInputHeight()
    window.addEventListener('resize', clampInputHeight)
    return () => window.removeEventListener('resize', clampInputHeight)
  }, [getMaxInputHeight, getMinInputHeight, inputHeight])

  const handleDragStart = React.useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const el = containerRef.current
      if (!el) return
      const minH = getMinInputHeight()
      dragRef.current = {
        startY: e.clientY,
        startH: el.offsetHeight,
        minH,
        maxH: Math.max(minH, getMaxInputHeight())
      }
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
    },
    [getMaxInputHeight, getMinInputHeight]
  )
  const targetSession = useChatStore(
    useShallow((s) => {
      const targetSessionId = sessionId ?? s.activeSessionId
      const idx = targetSessionId ? s.sessionsById[targetSessionId] : undefined
      const session = idx !== undefined ? s.sessions[idx] : undefined
      if (!session) return undefined
      return {
        id: session.id,
        projectId: session.projectId,
        pluginId: session.pluginId,
        providerId: session.providerId,
        modelId: session.modelId,
        modelSelectionMode: session.modelSelectionMode
      } as Pick<
        import('@renderer/stores/chat-store').Session,
        'id' | 'projectId' | 'pluginId' | 'providerId' | 'modelId' | 'modelSelectionMode'
      >
    })
  )
  const channels = useChannelStore((s) => s.channels)
  const autoSelection = useUIStore((s) =>
    targetSession ? (s.autoModelSelectionsBySession[targetSession.id] ?? null) : null
  )
  const activeProvider = useProviderStore(
    useShallow((s) => {
      const { providers, activeProviderId, activeModelId } = s
      const fastConfig = modelRoute === 'fast' ? s.getFastProviderConfig() : null
      const session = isSessionComposer ? targetSession : null
      const channel = session?.pluginId
        ? (channels.find((item) => item.id === session.pluginId) ?? null)
        : null
      const selection = session
        ? resolveSessionModelSelection({
            session,
            providers,
            activeProviderId,
            activeModelId,
            globalMode: mainModelSelectionMode,
            channelProviderId: channel?.providerId,
            channelModelId: channel?.model
          })
        : null
      const providerId =
        fastConfig?.providerId ??
        (selection
          ? selection.isAutoModeActive && autoSelection?.providerId
            ? autoSelection.providerId
            : selection.providerId
          : activeProviderId)
      const modelId =
        fastConfig?.model ??
        (selection
          ? selection.isAutoModeActive && autoSelection?.modelId
            ? autoSelection.modelId
            : selection.modelId
          : activeModelId)
      if (!providerId || !modelId) return null
      const provider = providers.find((item) => item.id === providerId)
      if (!provider) return null
      const model = provider.models.find((item) => item.id === modelId)
      if (!model) return null
      return {
        apiKey: provider.apiKey,
        requiresApiKey: provider.requiresApiKey,
        type: provider.type,
        models: provider.models,
        modelId
      }
    })
  )
  const supportsVision = React.useMemo(() => {
    if (!activeProvider) return false
    const model = activeProvider.models.find((m) => m.id === activeProvider.modelId)
    return modelSupportsVision(model, activeProvider.type)
  }, [activeProvider])
  const composerModelCfg = React.useMemo<AIModelConfig | null>(() => {
    if (!activeProvider) return null
    return activeProvider.models.find((m) => m.id === activeProvider.modelId) ?? null
  }, [activeProvider])
  const webSearchEnabled = useSettingsStore((s) => s.webSearchEnabled)
  const webSearchProvider = useSettingsStore((s) => s.webSearchProvider)
  const webSearchApiKey = useSettingsStore((s) => s.webSearchApiKey)
  const webSearchRequiresApiKey = [
    'tavily',
    'searxng',
    'exa',
    'exa-mcp',
    'bocha',
    'zhipu'
  ].includes(webSearchProvider)
  const canToggleWebSearch = !webSearchRequiresApiKey || Boolean(webSearchApiKey)
  const toggleWebSearch = React.useCallback(() => {
    const store = useSettingsStore.getState()
    const newEnabled = !store.webSearchEnabled
    useSettingsStore.getState().updateSettings({ webSearchEnabled: newEnabled })
    updateWebSearchToolRegistration(newEnabled)
  }, [])
  const openSettingsPage = useUIStore((s) => s.openSettingsPage)
  const openFilePreview = useUIStore((s) => s.openFilePreview)
  const mode = useUIStore((s) => s.mode)
  // Only select fields actually used — avoids re-renders on every streaming message delta
  const activeProjectId = useChatStore((s) => {
    const targetSessionId = sessionId ?? s.activeSessionId
    const idx = targetSessionId ? s.sessionsById[targetSessionId] : undefined
    const targetSession = idx !== undefined ? s.sessions[idx] : undefined
    return targetSession?.projectId ?? s.activeProjectId
  })
  const activeSshConnectionId = useChatStore((s) => {
    const targetSessionId = sessionId ?? s.activeSessionId
    const idx = targetSessionId ? s.sessionsById[targetSessionId] : undefined
    const targetSession = idx !== undefined ? s.sessions[idx] : undefined
    const projectId = targetSession?.projectId ?? s.activeProjectId
    const activeProject = projectId
      ? s.projects.find((project) => project.id === projectId)
      : undefined
    return targetSession?.sshConnectionId ?? activeProject?.sshConnectionId ?? null
  })
  const showInlineClearConversation = false
  const { installedSkills, skillsLoading, loadSkills } = useSkillsStore(
    useShallow((s) => ({
      installedSkills: s.skills,
      skillsLoading: s.loading,
      loadSkills: s.loadSkills
    }))
  )
  const pluginsByProject = useAppPluginStore((s) => s.pluginsByProject)
  const { activeSessionId, hasMessages, clearSessionMessages } = useChatStore(
    useShallow((s) => {
      const targetSessionId = sessionId ?? s.activeSessionId
      const idx = targetSessionId ? s.sessionsById[targetSessionId] : undefined
      const targetSession = idx !== undefined ? s.sessions[idx] : undefined
      return {
        activeSessionId: targetSessionId,
        hasMessages: (targetSession?.messageCount ?? 0) > 0,
        clearSessionMessages: s.clearSessionMessages
      }
    })
  )
  // Stable getter — reads messages lazily so streaming deltas don't re-render InputArea
  const getSessionMessages = React.useCallback(
    () => useChatStore.getState().getSessionMessages(activeSessionId ?? ''),
    [activeSessionId]
  )
  const draftSessionId = sessionId ?? (chatView === 'session' ? activeSessionId : null)
  const projectScoped = isProjectSession({
    chatView,
    session: targetSession,
    activeProjectId,
    workingFolder
  })
  const workspaceReady = workspaceContextAvailable({
    chatView,
    session: targetSession,
    activeProjectId,
    workingFolder
  })
  const activeDraftKey = React.useMemo(() => {
    if (draftKeyOverride) return draftKeyOverride
    if (draftSessionId) return getSessionInputDraftKey(draftSessionId)
    if (activeProjectId) return getProjectInputDraftKey(activeProjectId, mode)
    return getHomeInputDraftKey(mode)
  }, [activeProjectId, draftKeyOverride, draftSessionId, mode])
  const draftContext = React.useMemo<InputDraftContext>(() => {
    if (draftKeyOverride) {
      return {
        scope: draftKeyOverride.startsWith('subagent:') ? 'subagent' : 'custom',
        sessionId: draftSessionId,
        projectId: activeProjectId,
        mode,
        workingFolder: workingFolder ?? null
      }
    }

    if (draftSessionId) {
      return {
        scope: 'session',
        sessionId: draftSessionId,
        projectId: activeProjectId,
        mode,
        workingFolder: workingFolder ?? null
      }
    }

    if (activeProjectId) {
      return {
        scope: 'project',
        projectId: activeProjectId,
        mode,
        workingFolder: workingFolder ?? null
      }
    }

    return {
      scope: 'home',
      mode,
      workingFolder: workingFolder ?? null
    }
  }, [activeProjectId, draftKeyOverride, draftSessionId, mode, workingFolder])
  const {
    hydrated: inputDraftHydrated,
    loadedDraft: persistedDraft,
    saveDraft: savePersistedDraft,
    removeDraft: removePersistedDraft
  } = useInputDraftPersistence({
    draftKey: activeDraftKey,
    context: draftContext
  })
  const draftReadyKeyRef = React.useRef<string | null>(null)
  const queuedMessagesSnapshotRef = React.useRef<PendingSessionMessageItem[]>(EMPTY_QUEUED_MESSAGES)
  const getQueuedMessagesSnapshot = React.useCallback(() => {
    if (suppressPendingQueue) return EMPTY_QUEUED_MESSAGES
    const next = activeSessionId
      ? getPendingSessionMessages(activeSessionId)
      : EMPTY_QUEUED_MESSAGES
    const prev = queuedMessagesSnapshotRef.current
    if (prev !== next && areQueuedMessagesEqual(prev, next)) {
      return prev
    }
    queuedMessagesSnapshotRef.current = next
    return next
  }, [activeSessionId, suppressPendingQueue])
  const queuedMessages = React.useSyncExternalStore(
    subscribePendingSessionMessages,
    getQueuedMessagesSnapshot,
    () => EMPTY_QUEUED_MESSAGES
  )
  const isQueueDispatchPaused = React.useSyncExternalStore(
    subscribePendingSessionMessages,
    () =>
      !suppressPendingQueue && activeSessionId
        ? isPendingSessionDispatchPaused(activeSessionId)
        : false,
    () => false
  )
  const [editingQueueItemId, setEditingQueueItemId] = React.useState<string | null>(null)
  const [editingQueueText, setEditingQueueText] = React.useState('')
  const [editingQueueImages, setEditingQueueImages] = React.useState<ImageAttachment[]>([])
  const [queueClearConfirmOpen, setQueueClearConfirmOpen] = React.useState(false)
  const [autoAcceptCountdown, setAutoAcceptCountdown] = React.useState<number | null>(null)
  const [isWorkspaceAgentsMissing, setIsWorkspaceAgentsMissing] = React.useState(false)
  const [pendingPlanMode, setPendingPlanMode] = React.useState(false)
  const [pendingGoalMode, setPendingGoalMode] = React.useState(false)

  React.useLayoutEffect(() => {
    if (inputHeight === null) return
    const minH = getMinInputHeight()
    const maxH = Math.max(minH, getMaxInputHeight())
    setInputHeight((prev) => {
      if (prev === null) return prev
      if (prev >= minH && prev <= maxH) return prev
      return Math.min(Math.max(prev, minH), maxH)
    })
  }, [attachedImages.length, selectedSkill, getMaxInputHeight, getMinInputHeight, inputHeight])

  const syncAutoInputHeight = React.useCallback(() => {
    if (inputHeight !== null) return
    const container = containerRef.current
    const editorMetrics = editorRef.current?.getScrollMetrics()
    if (!container || !editorMetrics) return

    const chromeHeight = Math.max(0, container.offsetHeight - editorMetrics.clientHeight)
    const minHeight = Math.max(minComposerHeight, Math.ceil(chromeHeight + EDITOR_MIN_HEIGHT))
    const nextHeight = Math.max(
      minHeight,
      Math.min(
        autoMaxInputHeight,
        Math.ceil(chromeHeight + Math.max(EDITOR_MIN_HEIGHT, editorMetrics.scrollHeight))
      )
    )

    setAutoInputHeight((prev) => (prev === nextHeight ? prev : nextHeight))
  }, [autoMaxInputHeight, inputHeight, minComposerHeight])

  React.useLayoutEffect(() => {
    syncAutoInputHeight()
  }, [syncAutoInputHeight, documentNodes, selectedFiles, attachedImages.length, selectedSkill])

  React.useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(() => {
      if (inputHeight === null) {
        syncAutoInputHeight()
        return
      }

      const minH = getMinInputHeight()
      const maxH = Math.max(minH, getMaxInputHeight())
      setInputHeight((prev) => {
        if (prev === null) return prev
        return Math.min(Math.max(prev, minH), maxH)
      })
    })

    const container = containerRef.current
    const imagePreview = imagePreviewRef.current
    const bottomToolbar = bottomToolbarRef.current

    if (container) observer.observe(container)
    if (imagePreview) observer.observe(imagePreview)
    if (bottomToolbar) observer.observe(bottomToolbar)

    return () => {
      observer.disconnect()
    }
  }, [getMaxInputHeight, getMinInputHeight, inputHeight, syncAutoInputHeight])

  const startEditQueuedMessage = React.useCallback((msg: PendingSessionMessageItem) => {
    setEditingQueueItemId(msg.id)
    setEditingQueueText(msg.text)
    setEditingQueueImages(cloneImageAttachments(msg.images))
  }, [])

  const cancelEditQueuedMessage = React.useCallback(() => {
    setEditingQueueItemId(null)
    setEditingQueueText('')
    setEditingQueueImages([])
  }, [])

  const removeQueuedMessage = React.useCallback(
    (id: string) => {
      if (!activeSessionId) return
      removePendingSessionMessage(activeSessionId, id)
      if (editingQueueItemId === id) {
        setEditingQueueItemId(null)
        setEditingQueueText('')
        setEditingQueueImages([])
      }
    },
    [activeSessionId, editingQueueItemId]
  )

  const addQueuedImages = React.useCallback(async (files: File[]) => {
    const results = await Promise.all(files.map(fileToImageAttachment))
    const valid = results.filter(Boolean) as ImageAttachment[]
    if (valid.length > 0) {
      setEditingQueueImages((prev) => [...prev, ...valid])
    }
  }, [])

  const getPastedImageFiles = React.useCallback(
    (clipboardData: DataTransfer | null | undefined): File[] => {
      if (!supportsVision || !clipboardData) return []
      return Array.from(clipboardData.items)
        .filter((item) => item.kind === 'file' && ACCEPTED_IMAGE_TYPES.includes(item.type))
        .map((item) => item.getAsFile())
        .filter(Boolean) as File[]
    },
    [supportsVision]
  )

  const removeQueuedImage = React.useCallback((id: string) => {
    setEditingQueueImages((prev) => prev.filter((img) => img.id !== id))
    setPreviewImage((current) => (current?.id === id ? null : current))
  }, [])

  const saveQueuedMessage = React.useCallback(
    (id: string) => {
      if (!activeSessionId) return
      const targetMessage = queuedMessages.find((msg) => msg.id === id)
      if (!targetMessage) return

      const nextDraft: EditableUserMessageDraft = {
        text: editingQueueText.trim(),
        images: cloneImageAttachments(editingQueueImages),
        command: targetMessage.command
      }

      if (!hasEditableDraftContent(nextDraft)) {
        removePendingSessionMessage(activeSessionId, id)
        setEditingQueueItemId(null)
        setEditingQueueText('')
        setEditingQueueImages([])
        return
      }

      updatePendingSessionMessageDraft(activeSessionId, id, nextDraft)
      setEditingQueueItemId(null)
      setEditingQueueText('')
      setEditingQueueImages([])
    },
    [activeSessionId, queuedMessages, editingQueueText, editingQueueImages]
  )

  const clearQueuedMessagesForActiveSession = React.useCallback(() => {
    if (!activeSessionId) return
    const cleared = clearPendingSessionMessages(activeSessionId)
    if (cleared === 0) return
    setQueueClearConfirmOpen(false)
    cancelEditQueuedMessage()
    toast.success(t('input.queueCleared', { defaultValue: 'Queued messages cleared' }))
  }, [activeSessionId, cancelEditQueuedMessage, t])

  const handleClearQueuedMessages = React.useCallback(() => {
    if (queuedMessages.length <= 1) {
      clearQueuedMessagesForActiveSession()
      return
    }
    setQueueClearConfirmOpen(true)
  }, [clearQueuedMessagesForActiveSession, queuedMessages.length])

  const resumeQueuedMessages = React.useCallback(() => {
    if (!activeSessionId) return
    dispatchNextQueuedMessageForSession(activeSessionId)
  }, [activeSessionId])

  React.useEffect(() => {
    textRef.current = text
  }, [text])
  React.useEffect(() => {
    documentRef.current = documentNodes
  }, [documentNodes])
  React.useEffect(() => {
    selectedFilesRef.current = selectedFiles
  }, [selectedFiles])

  React.useEffect(() => {
    if (!highlightedFileId) return
    const timer = window.setTimeout(() => {
      setHighlightedFileId((current) => (current === highlightedFileId ? null : current))
    }, 1600)
    return () => window.clearTimeout(timer)
  }, [highlightedFileId])

  const applyEditorStateFromSerializedText = React.useCallback(
    (nextText: string, baseFiles: SelectedFileItem[] = selectedFilesRef.current) => {
      const nextState = deserializeEditorState(nextText, workingFolder, baseFiles)
      setDocumentNodes(nextState.document)
      setSelectedFiles(nextState.selectedFiles)
    },
    [workingFolder]
  )

  const setText = React.useCallback(
    (value: string | ((prev: string) => string)) => {
      const previousText = textRef.current
      const nextText = typeof value === 'function' ? value(previousText) : value
      applyEditorStateFromSerializedText(nextText, selectedFilesRef.current)
    },
    [applyEditorStateFromSerializedText]
  )

  const focusInputAtEnd = React.useCallback(() => {
    editorRef.current?.focusAtEnd()
  }, [])

  const hasFileReferences = React.useMemo(() => selectedFiles.length > 0, [selectedFiles])

  const quoteQueuedMessage = React.useCallback(
    (id: string) => {
      if (!activeSessionId) return
      const quoted = quotePendingSessionMessageIntoConversation(activeSessionId, id)
      if (!quoted) return
      if (editingQueueItemId === id) {
        setEditingQueueItemId(null)
        setEditingQueueText('')
        setEditingQueueImages([])
      }
      toast.success(t('input.queueQuoted', { defaultValue: 'Inserted into conversation' }))
    },
    [activeSessionId, editingQueueItemId, t]
  )

  const replaceSelectionWithText = React.useCallback(
    (
      replacement: string,
      selection: { start: number; end: number } = editorSelection,
      cursorOffset = 0,
      nextSelectedFiles?: SelectedFileItem[]
    ) => {
      const replacementState = deserializeEditorState(
        replacement,
        workingFolder,
        nextSelectedFiles ?? selectedFilesRef.current
      )
      const candidateFiles = mergeSelectedFiles(
        nextSelectedFiles ?? selectedFilesRef.current,
        replacementState.selectedFiles
      )
      const nextDocument = replaceEditorRange(
        documentRef.current,
        selectedFilesRef.current,
        selection.start,
        selection.end,
        replacementState.document
      )
      const referencedFileIds = new Set(
        nextDocument
          .filter(
            (node): node is Extract<EditorDocumentNode, { type: 'file' }> => node.type === 'file'
          )
          .map((node) => node.fileId)
      )
      const nextFiles = candidateFiles.filter((file) => referencedFileIds.has(file.id))
      const nextCursor =
        selection.start +
        editorDocumentToPlainText(replacementState.document, candidateFiles).length +
        cursorOffset

      setDocumentNodes(nextDocument)
      setSelectedFiles(nextFiles)
      requestAnimationFrame(() => {
        editorRef.current?.focus()
        editorRef.current?.setSelectionOffsets(nextCursor, nextCursor)
        setEditorSelection({ start: nextCursor, end: nextCursor })
      })
    },
    [editorSelection, workingFolder]
  )

  const shouldRecommendInit = workspaceReady && !activeSshConnectionId && isWorkspaceAgentsMissing
  const recommendationFallback = shouldRecommendInit
    ? t('input.recommendationInitWorkspace')
    : t(defaultRecommendationKeys[mode])
  const shouldAutoAcceptRecommendation =
    mode === 'clarify' && clarifyAutoAcceptRecommended && !disabled && !isOptimizing && !isStreaming
  const getCaretAtEnd = React.useCallback(() => {
    return editorSelection.start === editorSelection.end && editorSelection.end === text.length
  }, [editorSelection.end, editorSelection.start, text.length])
  const {
    suggestionText,
    effectivePlaceholder,
    acceptSuggestion,
    cancelPendingRequest: cancelPromptRecommendation,
    handleFocus: handleRecommendationFocus,
    handleBlur: handleRecommendationBlur,
    handleSelectionChange: handleRecommendationSelectionChange,
    handleCompositionStart: handleRecommendationCompositionStart,
    handleCompositionEnd: handleRecommendationCompositionEnd
  } = usePromptRecommendation({
    mode,
    sessionId: activeSessionId,
    text,
    getRecentMessages: getSessionMessages,
    selectedSkill,
    images: attachedImages,
    disabled: disabled || isOptimizing,
    isStreaming,
    fallbackSuggestion: recommendationFallback,
    getCaretAtEnd
  })
  const activeFileMention = React.useMemo(() => {
    if (editorSelection.start === editorSelection.end) {
      const selectionMention = getSelectFileMentionQuery(text, editorSelection.end)
      if (selectionMention) return selectionMention
    }

    return getSelectFileMentionQuery(text, text.length)
  }, [editorSelection.end, editorSelection.start, text])
  const fileQuery = activeFileMention?.query.trim() ?? ''
  const fileMenuOpen = projectScoped && Boolean(activeFileMention)
  const slashQuery = React.useMemo(() => getSlashCommandQuery(text), [text])
  const availableAppPlugins = React.useMemo<AppPluginPromptItem[]>(() => {
    const projectPlugins = resolvePluginsForProject(pluginsByProject, activeProjectId)

    return APP_PLUGIN_DESCRIPTORS.filter((descriptor) => !descriptor.hidden)
      .map((descriptor) => {
        const plugin = projectPlugins.find((item) => item.id === descriptor.id)
        if (!plugin?.enabled) return null

        return {
          id: descriptor.id,
          title: t(`plugin.items.${descriptor.id}.title`, {
            ns: 'settings',
            defaultValue: descriptor.id
          }),
          description: t(`plugin.items.${descriptor.id}.description`, {
            ns: 'settings',
            defaultValue: ''
          })
        }
      })
      .filter((item): item is AppPluginPromptItem => item !== null)
  }, [activeProjectId, pluginsByProject, t])
  const filteredSlashSuggestions = React.useMemo(() => {
    const query = slashQuery ?? ''
    const suggestionsByIdentity = new Map<string, SlashSuggestionItem>()

    for (const command of [...BUILTIN_SLASH_COMMANDS, ...slashCommands]) {
      suggestionsByIdentity.set(`command:${command.name.toLowerCase()}`, {
        key: `command:${command.name}`,
        name: command.name,
        summary: command.summary,
        kind: 'command'
      })
    }

    for (const plugin of availableAppPlugins) {
      suggestionsByIdentity.set(`plugin:${plugin.id}`, {
        key: `plugin:${plugin.id}`,
        name: plugin.id,
        label: plugin.title,
        summary: plugin.description,
        kind: 'plugin',
        pluginId: plugin.id
      })
    }

    const appPluginIds = new Set(
      APP_PLUGIN_DESCRIPTORS.filter((descriptor) => !descriptor.hidden).map(
        (descriptor) => descriptor.id
      )
    )
    for (const skill of installedSkills) {
      if (appPluginIds.has(skill.name as AppPluginId)) continue
      suggestionsByIdentity.set(`skill:${skill.name.toLowerCase()}`, {
        key: `skill:${skill.name}`,
        name: skill.name,
        summary: skill.description,
        kind: 'skill'
      })
    }

    return [...suggestionsByIdentity.values()]
      .map((item) => ({ item, score: scoreSlashCommand(item.name, query) }))
      .filter((item) => Number.isFinite(item.score))
      .sort((left, right) => {
        if (left.score !== right.score) return left.score - right.score
        if (left.item.kind !== right.item.kind) {
          const order = { command: 0, plugin: 1, skill: 2 }
          return order[left.item.kind] - order[right.item.kind]
        }
        return left.item.name.localeCompare(right.item.name, undefined, {
          sensitivity: 'base'
        })
      })
      .slice(0, MAX_SLASH_COMMAND_RESULTS)
      .map((item) => item.item)
  }, [availableAppPlugins, installedSkills, slashCommands, slashQuery])
  const slashMenuOpen = slashQuery !== null
  const slashSuggestionsLoading = slashCommandsLoading || skillsLoading

  React.useEffect(() => {
    if (!slashMenuOpen) {
      setSelectedSlashIndex(0)
      setSlashCommandsLoading(false)
      return
    }

    let cancelled = false
    setSlashCommandsLoading(true)

    void Promise.all([listCommands(), loadSkills()])
      .then(([commands]) => {
        if (cancelled) return
        setSlashCommands(commands)
      })
      .finally(() => {
        if (cancelled) return
        setSlashCommandsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [loadSkills, slashMenuOpen])

  React.useEffect(() => {
    setSelectedSlashIndex(0)
  }, [slashQuery])

  React.useEffect(() => {
    setSelectedFileSearchIndex(0)
  }, [fileQuery])

  React.useEffect(() => {
    if (!fileMenuOpen) {
      setFileSearchResults([])
      setFileSearchLoading(false)
      return
    }

    if (!workingFolder) {
      setFileSearchResults([])
      setFileSearchLoading(false)
      return
    }

    let cancelled = false
    setFileSearchLoading(true)

    const timer = window.setTimeout(() => {
      void ipcClient
        .invoke('fs:search-files', {
          path: workingFolder,
          query: fileQuery,
          limit: 20
        })
        .then((result) => {
          if (cancelled) return
          if (Array.isArray(result)) {
            setFileSearchResults(result as FileSearchItem[])
            return
          }
          setFileSearchResults([])
        })
        .finally(() => {
          if (cancelled) return
          setFileSearchLoading(false)
        })
    }, 120)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [fileMenuOpen, fileQuery, workingFolder])

  const insertSelectedFile = React.useCallback(
    (filePath: string) => {
      setSelectedSkill(null)

      const { files: nextFiles, file } = ensureSelectedFile(
        selectedFilesRef.current,
        filePath,
        workingFolder
      )
      if (!file) return

      const mention = activeFileMention ?? {
        start: editorSelection.start,
        end: editorSelection.end
      }
      const suffix =
        text.slice(mention.end).startsWith(' ') ||
        text.slice(mention.end).startsWith('\n') ||
        mention.end >= text.length
          ? ''
          : ' '

      replaceSelectionWithText(
        `${createSelectFileToken(file.sendPath)}${suffix}`,
        mention,
        0,
        nextFiles
      )
    },
    [
      activeFileMention,
      editorSelection.end,
      editorSelection.start,
      replaceSelectionWithText,
      text,
      workingFolder
    ]
  )

  const insertSlashCommand = React.useCallback(
    (commandName: string) => {
      setSelectedSkill(null)
      applyEditorStateFromSerializedText(`/${commandName} `, selectedFiles)
      requestAnimationFrame(() => {
        focusInputAtEnd()
      })
    },
    [applyEditorStateFromSerializedText, focusInputAtEnd, selectedFiles]
  )
  const selectSlashSkill = React.useCallback(
    (skillName: string) => {
      setSelectedSkill(skillName)
      applyEditorStateFromSerializedText('')
      requestAnimationFrame(() => {
        focusInputAtEnd()
      })
    },
    [applyEditorStateFromSerializedText, focusInputAtEnd]
  )
  const insertPluginPrompt = React.useCallback(
    (pluginId: AppPluginId, replaceAll = false) => {
      setSelectedSkill(null)
      const plugin = availableAppPlugins.find((item) => item.id === pluginId)
      const label = plugin?.title ?? pluginId
      const pluginNode = createPluginReferenceNode(
        pluginId,
        label,
        getAppPluginPromptContent(pluginId)
      )
      const pluginDocument: EditorDocumentNode[] = [pluginNode, createTextReplacementNode('\n')]

      if (replaceAll) {
        setDocumentNodes(pluginDocument)
        setSelectedFiles([])
        requestAnimationFrame(() => {
          focusInputAtEnd()
        })
        return
      }

      if (
        documentRef.current.some((node) => node.type === 'plugin' && node.pluginId === pluginId)
      ) {
        requestAnimationFrame(() => {
          focusInputAtEnd()
        })
        return
      }

      const selection = editorRef.current?.getSelectionOffsets() ?? editorSelection
      const nextDocument = replaceEditorRange(
        documentRef.current,
        selectedFilesRef.current,
        selection.start,
        selection.end,
        pluginDocument
      )
      const referencedFileIds = new Set(
        nextDocument
          .filter(
            (node): node is Extract<EditorDocumentNode, { type: 'file' }> => node.type === 'file'
          )
          .map((node) => node.fileId)
      )

      setDocumentNodes(nextDocument)
      setSelectedFiles((currentFiles) =>
        currentFiles.filter((file) => referencedFileIds.has(file.id))
      )
      requestAnimationFrame(() => {
        focusInputAtEnd()
      })
    },
    [availableAppPlugins, editorSelection, focusInputAtEnd]
  )
  const applySlashSuggestion = React.useCallback(
    (item: SlashSuggestionItem) => {
      if (item.kind === 'skill') {
        selectSlashSkill(item.name)
        return
      }
      if (item.kind === 'plugin' && item.pluginId) {
        insertPluginPrompt(item.pluginId, true)
        return
      }
      insertSlashCommand(item.name)
    },
    [insertPluginPrompt, insertSlashCommand, selectSlashSkill]
  )
  const hasApiKey = !!activeProvider?.apiKey || activeProvider?.requiresApiKey === false
  const needsWorkingFolder = projectScoped && !workingFolder
  const planMode = useUIStore((s) =>
    draftSessionId ? Boolean(s.planModesBySession[draftSessionId]) : pendingPlanMode
  )
  const activeGoal = useGoalStore((s) =>
    draftSessionId ? s.goalsBySession[draftSessionId] : undefined
  )
  const hasActiveGoal = activeGoal?.status === 'active'
  const hasPendingGoalMode = pendingGoalMode && !hasActiveGoal
  const goalModeEnabled = hasActiveGoal || hasPendingGoalMode
  const pendingReviewPlanId = usePlanStore((s) =>
    draftSessionId ? (s.getPendingReviewPlan(draftSessionId)?.id ?? null) : null
  )

  React.useEffect(() => {
    if (draftSessionId) {
      setPendingPlanMode(false)
    }
    setPendingGoalMode(false)
  }, [draftSessionId])

  React.useEffect(() => {
    if (hasActiveGoal) {
      setPendingGoalMode(false)
    }
  }, [hasActiveGoal])

  React.useEffect(() => {
    let cancelled = false

    if (!workspaceReady || activeSshConnectionId) {
      setIsWorkspaceAgentsMissing(false)
      return
    }

    setIsWorkspaceAgentsMissing(false)

    void resolveProjectMemoryTextFile(ipcClient, workingFolder ?? '', 'AGENTS.md').then(
      ({ missingFile }) => {
        if (cancelled) return
        setIsWorkspaceAgentsMissing(missingFile)
      }
    )

    return () => {
      cancelled = true
    }
  }, [activeSshConnectionId, workspaceReady, workingFolder])

  React.useEffect(() => {
    if (!shouldAutoAcceptRecommendation || !suggestionText || !text.trim()) {
      setAutoAcceptCountdown(null)
      return
    }

    setAutoAcceptCountdown(8)

    const intervalId = window.setInterval(() => {
      setAutoAcceptCountdown((prev) => {
        if (prev === null) return null
        return prev > 1 ? prev - 1 : 0
      })
    }, 1000)

    const timeoutId = window.setTimeout(() => {
      const acceptedSuggestion = acceptSuggestion()
      if (!acceptedSuggestion) return
      applyEditorStateFromSerializedText(acceptedSuggestion, selectedFiles)
      setAutoAcceptCountdown(null)
      requestAnimationFrame(() => {
        focusInputAtEnd()
        handleRecommendationSelectionChange()
      })
    }, 8000)

    return () => {
      window.clearInterval(intervalId)
      window.clearTimeout(timeoutId)
    }
  }, [
    acceptSuggestion,
    applyEditorStateFromSerializedText,
    focusInputAtEnd,
    handleRecommendationSelectionChange,
    selectedFiles,
    shouldAutoAcceptRecommendation,
    suggestionText,
    text
  ])

  React.useEffect(() => {
    setEditingQueueItemId(null)
    setEditingQueueText('')
    setEditingQueueImages([])
    setQueueClearConfirmOpen(false)
  }, [activeSessionId])

  React.useEffect(() => {
    if (!editingQueueItemId) return
    if (queuedMessages.some((msg) => msg.id === editingQueueItemId)) return
    setEditingQueueItemId(null)
    setEditingQueueText('')
    setEditingQueueImages([])
  }, [queuedMessages, editingQueueItemId])

  React.useEffect(() => {
    if (!isStreaming) {
      cancelEditQueuedMessage()
    }
  }, [isStreaming, cancelEditQueuedMessage])

  React.useEffect(() => {
    if (queuedMessages.length > 0) return
    setQueueClearConfirmOpen(false)
  }, [queuedMessages.length])

  React.useEffect(() => {
    if (!inputDraftHydrated) return

    clearTimeout(draftSaveTimerRef.current)
    const persistedText = persistedDraft?.text ?? ''
    const persistedSelectedFiles = persistedDraft?.selectedFiles ?? []
    const shouldResetHomeReferenceDraft =
      isHomeComposer &&
      !persistedDraft?.skill &&
      (persistedDraft?.images?.length ?? 0) === 0 &&
      isReferenceOnlyDocument(
        deserializeEditorState(persistedText, workingFolder, persistedSelectedFiles).document
      )

    draftReadyKeyRef.current = null
    applyEditorStateFromSerializedText(
      shouldResetHomeReferenceDraft ? '' : persistedText,
      shouldResetHomeReferenceDraft ? [] : persistedSelectedFiles
    )
    setAttachedImages(persistedDraft?.images ? cloneImageAttachments(persistedDraft.images) : [])
    setPreviewImage(null)
    setSelectedSkill(persistedDraft?.skill ?? null)
    setHighlightedFileId(null)
    setEditorSelection({ start: 0, end: 0 })

    const rafId = window.requestAnimationFrame(() => {
      draftReadyKeyRef.current = activeDraftKey
    })

    return () => {
      window.cancelAnimationFrame(rafId)
    }
  }, [
    activeDraftKey,
    applyEditorStateFromSerializedText,
    inputDraftHydrated,
    isHomeComposer,
    persistedDraft,
    workingFolder
  ])

  React.useEffect(() => {
    if (isStreaming || disabled || !inputDraftHydrated) return

    const rafId = window.requestAnimationFrame(() => {
      if (activeDraftKey && draftReadyKeyRef.current !== activeDraftKey) return

      const activeElement = document.activeElement
      if (
        activeElement &&
        activeElement !== document.body &&
        !rootRef.current?.contains(activeElement)
      ) {
        return
      }

      editorRef.current?.focus()
    })

    return () => {
      window.cancelAnimationFrame(rafId)
    }
  }, [activeDraftKey, disabled, inputDraftHydrated, isStreaming])

  React.useEffect(() => {
    if (!activeDraftKey || !inputDraftHydrated) return
    if (draftReadyKeyRef.current !== activeDraftKey) return

    clearTimeout(draftSaveTimerRef.current)
    draftSaveTimerRef.current = setTimeout(() => {
      const nextDraft = {
        text: finalSerializedText,
        images: cloneImageAttachments(attachedImages),
        skill: selectedSkill,
        selectedFiles: selectedFiles.map((file) => ({ ...file }))
      }

      void savePersistedDraft(nextDraft)
    }, 400)

    return () => clearTimeout(draftSaveTimerRef.current)
  }, [
    activeDraftKey,
    attachedImages,
    finalSerializedText,
    inputDraftHydrated,
    selectedFiles,
    selectedSkill,
    savePersistedDraft
  ])

  // Consume pendingInsertText from FileTree clicks
  const pendingInsert = useUIStore((s) => s.pendingInsertText)
  React.useEffect(() => {
    if (!pendingInsert) return

    const selection = editorRef.current?.getSelectionOffsets() ?? {
      start: text.length,
      end: text.length
    }
    const pendingPlainText = selectFileTextToPlainText(pendingInsert)
    const needsPrefix =
      selection.start === selection.end &&
      selection.start > 0 &&
      !/\s$/.test(text.slice(0, selection.start)) &&
      pendingPlainText.length > 0 &&
      !/^\s/.test(pendingPlainText)

    replaceSelectionWithText(`${needsPrefix ? ' ' : ''}${pendingInsert}`, selection)
    useUIStore.getState().setPendingInsertText(null)
  }, [pendingInsert, replaceSelectionWithText, text])

  // --- Image helpers ---
  const addImages = React.useCallback(async (files: File[]) => {
    if (files.length === 0) return

    setPendingImageReads((prev) => prev + files.length)
    try {
      const results = await Promise.all(files.map(fileToImageAttachment))
      const valid = results.filter(Boolean) as ImageAttachment[]
      if (valid.length > 0) {
        setAttachedImages((prev) => [...prev, ...valid])
      }
    } finally {
      setPendingImageReads((prev) => Math.max(0, prev - files.length))
    }
  }, [])

  const removeImage = React.useCallback((id: string) => {
    setAttachedImages((prev) => prev.filter((img) => img.id !== id))
    setPreviewImage((current) => (current?.id === id ? null : current))
  }, [])

  const readImagePathAsAttachment = React.useCallback(
    async (filePath: string): Promise<ImageAttachment | null> => {
      const mediaType = getImageMediaTypeForPath(filePath)
      if (!mediaType) return null

      const result = (await ipcClient.invoke(IPC.FS_READ_FILE_BINARY, { path: filePath })) as {
        data?: string
        error?: string
      }
      if (result.error || !result.data) {
        console.warn('[InputArea] Failed to read selected image:', result.error ?? filePath)
        return null
      }

      return {
        id: createImageAttachmentId(),
        dataUrl: `data:${mediaType};base64,${result.data}`,
        mediaType
      }
    },
    []
  )

  const addFilesToEditor = React.useCallback(
    (filePaths: string[], selection?: { start: number; end: number }) => {
      const nextSelection = selection ??
        editorRef.current?.getSelectionOffsets() ?? {
          start: editorSelection.start,
          end: editorSelection.end
        }
      const filesToInsert: SelectedFileItem[] = []
      let mergedFiles = selectedFilesRef.current

      for (const filePath of filePaths) {
        const ensured = ensureSelectedFile(mergedFiles, filePath, workingFolder)
        mergedFiles = ensured.files
        if (ensured.file) {
          filesToInsert.push(ensured.file)
        }
      }

      if (filesToInsert.length === 0) return

      const replacement = filesToInsert
        .map((file) => createSelectFileToken(file.sendPath))
        .filter(Boolean)
        .join('\n')

      replaceSelectionWithText(replacement, nextSelection, 0, mergedFiles)
    },
    [editorSelection.end, editorSelection.start, replaceSelectionWithText, workingFolder]
  )

  const handleAttachMedia = React.useCallback(async (): Promise<void> => {
    try {
      const result = (await ipcClient.invoke(IPC.FS_SELECT_FILE, {
        multiSelections: true,
        filters: [
          {
            name: t('input.mediaFilter'),
            extensions: [
              'png',
              'jpg',
              'jpeg',
              'gif',
              'webp',
              'md',
              'txt',
              'docx',
              'pdf',
              'html',
              'csv',
              'json',
              'xml',
              'yaml',
              'yml',
              'ts',
              'js',
              'tsx',
              'jsx'
            ]
          },
          { name: t('input.allFilesFilter'), extensions: ['*'] }
        ]
      })) as { canceled?: boolean; path?: string; paths?: string[] }

      const paths = Array.from(
        new Set(
          (Array.isArray(result.paths) && result.paths.length > 0
            ? result.paths
            : result.path
              ? [result.path]
              : []
          ).filter((filePath): filePath is string => Boolean(filePath))
        )
      )
      if (result.canceled || paths.length === 0) return

      const imagePaths = supportsVision
        ? paths.filter((filePath) => Boolean(getImageMediaTypeForPath(filePath)))
        : []
      const filePaths = paths.filter((filePath) => !imagePaths.includes(filePath))
      const imageFallbackPaths: string[] = []

      if (imagePaths.length > 0) {
        setPendingImageReads((prev) => prev + imagePaths.length)
        try {
          const images = await Promise.all(
            imagePaths.map(async (filePath) => {
              const attachment = await readImagePathAsAttachment(filePath)
              if (!attachment) imageFallbackPaths.push(filePath)
              return attachment
            })
          )
          const validImages = images.filter((image): image is ImageAttachment => Boolean(image))
          if (validImages.length > 0) {
            setAttachedImages((prev) => [...prev, ...validImages])
          }
        } finally {
          setPendingImageReads((prev) => Math.max(0, prev - imagePaths.length))
        }
      }

      const pathsForFileReferences = [...filePaths, ...imageFallbackPaths]
      if (pathsForFileReferences.length > 0) {
        addFilesToEditor(pathsForFileReferences)
      }
    } catch (error) {
      console.error('[InputArea] Failed to attach media:', error)
      toast.error(t('input.attachMediaFailed'))
    }
  }, [addFilesToEditor, readImagePathAsAttachment, supportsVision, t])

  const handlePreviewFile = React.useCallback(
    (fileId: string) => {
      const file = selectedFilesRef.current.find((item) => item.id === fileId)
      if (file) {
        openFilePreview(file.previewPath)
      }
    },
    [openFilePreview]
  )

  const handleLocateFileReference = React.useCallback((fileId: string) => {
    setHighlightedFileId(fileId)
    editorRef.current?.scrollToReference(fileId)
    editorRef.current?.focus()
  }, [])

  const handleEditorSelectionChange = React.useCallback(
    (selection: { start: number; end: number }) => {
      setEditorSelection((current) =>
        current.start === selection.start && current.end === selection.end ? current : selection
      )
      handleRecommendationSelectionChange()
    },
    [handleRecommendationSelectionChange]
  )

  const handleRemoveFileReference = React.useCallback((nodeId: string) => {
    const currentDocument = documentRef.current
    const targetNode = currentDocument.find((node) => node.type !== 'text' && node.id === nodeId)
    if (!targetNode) return

    const nextDocument = removeReferenceNode(currentDocument, nodeId, selectedFilesRef.current)
    const nextFiles =
      targetNode.type === 'file' && !documentHasFileReferences(nextDocument, targetNode.fileId)
        ? selectedFilesRef.current.filter((file) => file.id !== targetNode.fileId)
        : selectedFilesRef.current

    setDocumentNodes(nextDocument)
    setSelectedFiles(nextFiles)
  }, [])

  const handleEditorDocumentChange = React.useCallback((nextDocument: EditorDocumentNode[]) => {
    const referencedFileIds = new Set(
      nextDocument
        .filter(
          (node): node is Extract<EditorDocumentNode, { type: 'file' }> => node.type === 'file'
        )
        .map((node) => node.fileId)
    )
    setDocumentNodes(nextDocument)
    setSelectedFiles((currentFiles) =>
      currentFiles.filter((file) => referencedFileIds.has(file.id))
    )
  }, [])

  const getLiveEditorState = React.useCallback(() => {
    const liveDocument = editorRef.current?.getDocumentSnapshot() ?? documentRef.current
    const referencedFileIds = new Set(
      liveDocument
        .filter(
          (node): node is Extract<EditorDocumentNode, { type: 'file' }> => node.type === 'file'
        )
        .map((node) => node.fileId)
    )
    const liveSelectedFiles = selectedFilesRef.current.filter((file) =>
      referencedFileIds.has(file.id)
    )

    return {
      plainText: editorDocumentToPlainText(liveDocument, liveSelectedFiles),
      serializedText: serializeEditorDocument(liveDocument, liveSelectedFiles),
      promptText: serializeEditorDocument(liveDocument, liveSelectedFiles, {
        expandPluginPrompts: true
      }),
      selectedFiles: liveSelectedFiles
    }
  }, [])

  const resetComposer = React.useCallback((): void => {
    clearTimeout(draftSaveTimerRef.current)
    void removePersistedDraft()

    setDocumentNodes([])
    setSelectedFiles([])
    setHighlightedFileId(null)
    setEditorSelection({ start: 0, end: 0 })
    setAttachedImages([])
    setPreviewImage(null)
    setSelectedSkill(null)
    requestAnimationFrame(() => {
      editorRef.current?.setSelectionOffsets(0, 0)
    })
  }, [removePersistedDraft])

  const handleSend = React.useCallback((): void => {
    const liveEditorState = getLiveEditorState()
    const promptText = liveEditorState.promptText.trim()
    if (!promptText && attachedImages.length === 0) return
    if (disabled || needsWorkingFolder || pendingImageReads > 0) return

    let goalObjective: string | undefined
    if (hasPendingGoalMode && promptText) {
      const validation = validateGoalObjective(promptText)
      if (validation) {
        toast.error(t('goal.toasts.objectiveInvalid'), { description: validation })
        return
      }
      goalObjective = promptText
    }

    cancelPromptRecommendation()

    const hasLeadingSlashCommand = liveEditorState.plainText.trimStart().startsWith('/')
    const message =
      selectedSkill && !hasLeadingSlashCommand
        ? `[Skill: ${selectedSkill}]\n${promptText}`
        : promptText
    const sendOptions: SendMessageOptions = {
      clearCompletedTasksOnTurnStart: true,
      enablePlanMode: planMode || undefined
    }
    const selectedFileReferences = liveEditorState.selectedFiles.map(selectedFileItemToReference)
    if (selectedFileReferences.length > 0) {
      sendOptions.selectedFileReferences = selectedFileReferences
    }
    if (goalObjective) {
      sendOptions.goalObjective = goalObjective
    }

    onSend(message, attachedImages.length > 0 ? attachedImages : undefined, sendOptions)

    resetComposer()
    if (goalObjective) {
      setPendingGoalMode(false)
    }
  }, [
    getLiveEditorState,
    attachedImages,
    disabled,
    needsWorkingFolder,
    pendingImageReads,
    hasPendingGoalMode,
    cancelPromptRecommendation,
    selectedSkill,
    onSend,
    planMode,
    resetComposer,
    t
  ])

  const handlePlanModeChange = React.useCallback(
    (enabled: boolean): void => {
      if (enabled && !projectScoped) {
        toast.error(
          t('input.planModeUnavailable', {
            defaultValue: 'Plan Mode needs a project working folder.'
          })
        )
        return
      }

      if (draftSessionId) {
        if (enabled) {
          useUIStore.getState().enterPlanMode(draftSessionId)
        } else {
          useUIStore.getState().exitPlanMode(draftSessionId)
        }
        return
      }

      setPendingPlanMode(enabled)
    },
    [draftSessionId, projectScoped, t]
  )

  const handleGoalModeChange = React.useCallback(
    (enabled: boolean): void => {
      if (disabled || isStreaming || isOptimizing || pendingImageReads > 0) return

      if (!enabled) {
        setPendingGoalMode(false)
        if (draftSessionId && hasActiveGoal) {
          void useGoalStore
            .getState()
            .loadGoalForSession(draftSessionId, true)
            .then(() => useGoalStore.getState().updateGoal(draftSessionId, { status: 'paused' }))
            .then((result) => {
              if (!result.success) {
                toast.error(t('goal.toasts.updateFailed'), { description: result.error })
              }
            })
        }
        return
      }

      if (hasActiveGoal) return
      setPendingGoalMode(true)
      requestAnimationFrame(() => {
        focusInputAtEnd()
      })
    },
    [
      disabled,
      draftSessionId,
      focusInputAtEnd,
      hasActiveGoal,
      isOptimizing,
      isStreaming,
      pendingImageReads,
      t
    ]
  )

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      // keyCode 229 marks the keydown that starts an IME composition, which
      // fires before nativeEvent.isComposing becomes true.
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || isOptimizing) return

      if (fileMenuOpen) {
        if (!e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedFileSearchIndex((prev) =>
            fileSearchResults.length === 0 ? 0 : (prev + 1) % fileSearchResults.length
          )
          return
        }
        if (!e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedFileSearchIndex((prev) =>
            fileSearchResults.length === 0
              ? 0
              : (prev - 1 + fileSearchResults.length) % fileSearchResults.length
          )
          return
        }
        if (!e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'Tab' || e.key === 'Enter')) {
          const selectedFile = fileSearchResults[selectedFileSearchIndex]
          if (selectedFile) {
            e.preventDefault()
            insertSelectedFile(selectedFile.path)
            return
          }
        }
        if (!e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'Escape') {
          e.preventDefault()
          const nextCursor = activeFileMention?.start ?? 0
          editorRef.current?.focus()
          editorRef.current?.setSelectionOffsets(nextCursor, nextCursor)
          setEditorSelection({ start: nextCursor, end: nextCursor })
          handleRecommendationSelectionChange()
          return
        }
      }

      if (slashMenuOpen) {
        if (!e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedSlashIndex((prev) =>
            filteredSlashSuggestions.length === 0 ? 0 : (prev + 1) % filteredSlashSuggestions.length
          )
          return
        }
        if (!e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedSlashIndex((prev) =>
            filteredSlashSuggestions.length === 0
              ? 0
              : (prev - 1 + filteredSlashSuggestions.length) % filteredSlashSuggestions.length
          )
          return
        }
        if (!e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'Tab' || e.key === 'Enter')) {
          const selectedSuggestion = filteredSlashSuggestions[selectedSlashIndex]
          if (selectedSuggestion) {
            e.preventDefault()
            applySlashSuggestion(selectedSuggestion)
            return
          }
        }
      }

      if (!e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === 'Tab') {
        const acceptedSuggestion = acceptSuggestion()
        if (acceptedSuggestion) {
          e.preventDefault()
          applyEditorStateFromSerializedText(acceptedSuggestion, selectedFiles)
          requestAnimationFrame(() => {
            focusInputAtEnd()
            handleRecommendationSelectionChange()
          })
          return
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [
      isOptimizing,
      fileMenuOpen,
      slashMenuOpen,
      fileSearchResults,
      selectedFileSearchIndex,
      filteredSlashSuggestions,
      selectedSlashIndex,
      activeFileMention,
      insertSelectedFile,
      applySlashSuggestion,
      acceptSuggestion,
      applyEditorStateFromSerializedText,
      selectedFiles,
      focusInputAtEnd,
      handleRecommendationSelectionChange,
      handleSend
    ]
  )

  const handlePaste = React.useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>): void => {
      const imageFiles = getPastedImageFiles(e.clipboardData)

      if (imageFiles.length > 0) {
        e.preventDefault()
        void addImages(imageFiles)
        return
      }

      const plainText = e.clipboardData.getData('text/plain')
      if (!plainText) return

      e.preventDefault()
      const selection = editorRef.current?.getSelectionOffsets() ?? editorSelection
      replaceSelectionWithText(plainText, selection)
    },
    [addImages, editorSelection, getPastedImageFiles, replaceSelectionWithText]
  )

  const handleQueueEditPaste = React.useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
      const imageFiles = getPastedImageFiles(e.clipboardData)
      if (imageFiles.length === 0) return
      e.preventDefault()
      void addQueuedImages(imageFiles)
    },
    [addQueuedImages, getPastedImageFiles]
  )

  const getDraggedFilePaths = React.useCallback((dataTransfer: DataTransfer | null): string[] => {
    if (!dataTransfer) return []
    const payload = dataTransfer.getData(INTERNAL_FILE_DRAG_MIME)
    if (!payload) return []

    try {
      const parsed = JSON.parse(payload)
      if (!Array.isArray(parsed)) return []
      return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
    } catch {
      return []
    }
  }, [])

  const handleDropFiles = React.useCallback(
    (dataTransfer: DataTransfer | null) => {
      if (!dataTransfer || dataTransfer.files.length === 0) return
      const paths = getDroppedLocalPaths(dataTransfer)
      const fallbackPaths = Array.from(dataTransfer.files)
        .map((f) => (f as File & { path?: string }).path)
        .filter((filePath): filePath is string => Boolean(filePath))
      const uniquePaths = Array.from(new Set([...paths, ...fallbackPaths]))

      if (uniquePaths.length > 0) {
        addFilesToEditor(uniquePaths)
      }
    },
    [addFilesToEditor]
  )

  const [dragging, setDragging] = useLocalState(false)

  const handleDragOver = React.useCallback(
    (e: React.DragEvent<HTMLDivElement>): void => {
      const transfer = e.dataTransfer
      const types = Array.from(transfer?.types ?? [])
      const canHandle = types.includes('Files') || types.includes(INTERNAL_FILE_DRAG_MIME)
      if (!canHandle) return
      e.preventDefault()
      if (transfer) {
        transfer.dropEffect = 'copy'
      }
      setDragging(true)
    },
    [setDragging]
  )

  const handleDragLeave = React.useCallback(
    (e: React.DragEvent<HTMLDivElement>): void => {
      const nextTarget = e.relatedTarget as Node | null
      if (nextTarget && e.currentTarget.contains(nextTarget)) return
      setDragging(false)
    },
    [setDragging]
  )

  const handleDropWrapped = React.useCallback(
    (e: React.DragEvent<HTMLDivElement>): void => {
      const draggedPaths = getDraggedFilePaths(e.dataTransfer)
      const hasNativeFiles = (e.dataTransfer?.files?.length ?? 0) > 0
      if (draggedPaths.length === 0 && !hasNativeFiles) return
      e.preventDefault()
      setDragging(false)
      if (draggedPaths.length > 0) {
        addFilesToEditor(draggedPaths)
        return
      }
      handleDropFiles(e.dataTransfer ?? null)
    },
    [addFilesToEditor, getDraggedFilePaths, handleDropFiles, setDragging]
  )

  // Optimize prompt handler
  const handleOptimizePrompt = React.useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed || isOptimizing) return

    console.log('[Optimizer] Starting optimization...')
    setIsOptimizing(true)
    setOptimizingText('')
    setOptimizationOptions([])

    try {
      const { optimizePrompt } = await import('@renderer/lib/prompt-optimizer/optimizer')

      console.log('[Optimizer] Current language:', currentLanguage)

      // Find a fast model (haiku) from available providers
      const providerStore = useProviderStore.getState()
      const { providers } = providerStore

      let fastProvider = providers.find(
        (p) =>
          p.enabled &&
          p.models.some(
            (m) =>
              m.enabled &&
              (m.id.includes('haiku') || m.id.includes('4o-mini') || m.id.includes('gpt-4o-mini'))
          )
      )

      if (!fastProvider) {
        fastProvider = providers.find((p) => p.enabled && p.models.some((m) => m.enabled))
      }

      if (!fastProvider) {
        console.error('[Optimizer] No enabled provider found')
        toast.error('No AI provider available', {
          description: 'Please configure an AI provider in Settings'
        })
        setIsOptimizing(false)
        return
      }

      const fastModel =
        fastProvider.models.find(
          (m) =>
            m.enabled &&
            (m.id.includes('haiku') || m.id.includes('4o-mini') || m.id.includes('gpt-4o-mini'))
        ) || fastProvider.models.find((m) => m.enabled)

      if (!fastModel) {
        console.error('[Optimizer] No enabled model found')
        toast.error('No AI model available', { description: 'Please enable a model in Settings' })
        setIsOptimizing(false)
        return
      }

      console.log('[Optimizer] Using provider:', fastProvider.type, 'model:', fastModel.id)

      const providerConfig = {
        type: fastProvider.type,
        apiKey: fastProvider.apiKey,
        baseUrl: fastProvider.baseUrl,
        model: fastModel.id,
        providerId: fastProvider.id,
        maxTokens: 4096,
        temperature: 0.7,
        systemPrompt: ''
      }

      console.log('[Optimizer] Starting optimization stream...')
      for await (const event of optimizePrompt(trimmed, providerConfig, currentLanguage)) {
        console.log('[Optimizer] Event:', event.type)
        if (event.type === 'text') {
          setOptimizingText((prev) => prev + event.content)
        } else if (event.type === 'result' && event.options && event.options.length > 0) {
          console.log('[Optimizer] Got results:', event.options.length, 'options')
          setOptimizationOptions(event.options)
          setSelectedOptionIndex(0)
          setShowOptimizationDialog(true)
        }
      }
      console.log('[Optimizer] Stream completed')
    } catch (error) {
      console.error('[Optimizer] Error:', error)
      toast.error('Optimization failed', {
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      console.log('[Optimizer] Cleanup')
      setIsOptimizing(false)
    }
  }, [text, isOptimizing, currentLanguage])

  const handleSelectOption = React.useCallback(
    (content: string) => {
      setText(content)
      setOptimizationOptions([])
      setOptimizingText('')
      setSelectedOptionIndex(0)
      setShowOptimizationDialog(false)
      requestAnimationFrame(() => {
        focusInputAtEnd()
      })
    },
    [focusInputAtEnd, setText]
  )

  const handleCancelOptimization = React.useCallback(() => {
    setOptimizationOptions([])
    setOptimizingText('')
    setSelectedOptionIndex(0)
    setShowOptimizationDialog(false)
  }, [])

  const handleCompressContext = React.useCallback(() => {
    if (!onCompressContext || isContextCompressing) return

    clearTimeout(contextCompressionStatusTimerRef.current)
    setContextCompressionStatus('compressing')
    void Promise.resolve()
      .then(() => onCompressContext())
      .then((result) => {
        setContextCompressionStatus(result ?? 'compressed')
      })
      .catch((error) => {
        console.error('[InputArea] Context compression failed', error)
        setContextCompressionStatus('failed')
      })
      .finally(() => {
        contextCompressionStatusTimerRef.current = setTimeout(() => {
          setContextCompressionStatus('idle')
        }, 3200)
      })
  }, [isContextCompressing, onCompressContext])

  const contextCompressionStatusLabel = React.useMemo(() => {
    switch (contextCompressionStatus) {
      case 'compressing':
        return t('input.compressingContext', { defaultValue: 'Compressing context...' })
      case 'compressed':
        return t('input.contextCompressed', { defaultValue: 'Context compressed' })
      case 'skipped':
        return t('input.contextCompressionSkipped', { defaultValue: 'No compression needed' })
      case 'blocked':
        return t('input.contextCompressionBlocked', {
          defaultValue: 'Compression temporarily unavailable'
        })
      case 'failed':
        return t('input.contextCompressionFailed', { defaultValue: 'Compression failed' })
      default:
        return ''
    }
  }, [contextCompressionStatus, t])

  const composerVariant = 'session'
  const composerIconControlClass = 'composer-control rounded-xl'

  const webSearchToggleControl = canToggleWebSearch && (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={composerIconControlClass}
          data-active={webSearchEnabled ? 'true' : 'false'}
          onClick={toggleWebSearch}
          disabled={disabled || isStreaming}
        >
          <Globe className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {webSearchEnabled
          ? t('input.disableWebSearch', { defaultValue: 'Disable web search' })
          : t('input.enableWebSearch', { defaultValue: 'Enable web search' })}
      </TooltipContent>
    </Tooltip>
  )

  const skillsMenuControl = (
    <SkillsMenu
      onSelectSkill={(name) => {
        setSelectedSkill(name)
        editorRef.current?.focus()
      }}
      onSelectCommand={(name) => {
        insertSlashCommand(name)
      }}
      onSelectPlugin={(pluginId) => {
        insertPluginPrompt(pluginId)
      }}
      onAttachMedia={() => void handleAttachMedia()}
      disabled={disabled || isStreaming}
      projectId={activeProjectId}
      showChannels={mode !== 'chat'}
      triggerClassName={composerIconControlClass}
      menuClassName="composer-flyout"
      showModeToggles={!hideModeSwitch}
      planModeEnabled={planMode}
      goalModeEnabled={goalModeEnabled}
      planModeDisabled={disabled || isStreaming || !projectScoped}
      goalModeDisabled={disabled || isStreaming || isOptimizing || pendingImageReads > 0}
      onPlanModeChange={handlePlanModeChange}
      onGoalModeChange={handleGoalModeChange}
    />
  )

  const activeMcpBadge = <ActiveMcpsBadge projectId={activeProjectId} />
  const activeExtensionBadge = <ActiveExtensionsBadge projectId={activeProjectId} />

  const folderControl = onSelectFolder && !hideWorkingFolderPicker && (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={composerIconControlClass}
          onClick={onSelectFolder}
        >
          <FolderOpen className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('input.selectFolder')}</TooltipContent>
    </Tooltip>
  )

  const stopControl = isStreaming && (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={composerIconControlClass}
          data-tone="warning"
          onClick={onStop}
        >
          <Spinner className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('input.stopTooltip')}</TooltipContent>
    </Tooltip>
  )

  const optimizeControl = !isStreaming && (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={composerIconControlClass}
          onClick={handleOptimizePrompt}
          disabled={!text.trim() || disabled || isOptimizing}
        >
          {isOptimizing ? <Spinner className="size-4" /> : <Wand2 className="size-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {isOptimizing ? t('input.optimizing') : t('input.optimizePrompt')}
      </TooltipContent>
    </Tooltip>
  )

  const sendControl = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="default"
          className="composer-send rounded-xl px-3.5 transition-[filter,box-shadow] duration-200"
          data-composer-variant={composerVariant}
          onMouseDown={(event) => {
            event.preventDefault()
          }}
          onClick={handleSend}
          disabled={
            (!finalSerializedText.trim() && attachedImages.length === 0) ||
            disabled ||
            needsWorkingFolder ||
            pendingImageReads > 0 ||
            isOptimizing
          }
        >
          <>
            <span>{t('action.start', { ns: 'common' })}</span>
            <Send className="ml-1.5 size-3.5" />
          </>
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {isStreaming
          ? t('input.sendTooltipWhileRunning', { defaultValue: 'Send after current run' })
          : t('input.sendTooltip')}
      </TooltipContent>
    </Tooltip>
  )

  const queuedMessagesPanel =
    queuedMessages.length > 0 ? (
      <>
        <div
          className={cn(
            composerWidthClass,
            'mb-2 overflow-hidden rounded-lg border border-border/50 bg-muted/20 shadow-sm backdrop-blur'
          )}
        >
          <div className="max-h-40 overflow-y-auto py-1">
            {queuedMessages.map((msg, index) => {
              const isEditing = editingQueueItemId === msg.id
              const summaryText = summarizeQueuedMessage(msg.text)
              const commandLabel = msg.command ? `/${msg.command.name}` : ''
              const fallbackText =
                summaryText ||
                commandLabel ||
                t('input.queueImageOnly', { defaultValue: '[Images only]' })
              const quoteLabel = t('input.queueQuote', { defaultValue: 'Quote' })

              return (
                <div
                  key={msg.id}
                  className={cn(
                    'border-b border-border/35 last:border-b-0',
                    isEditing ? 'px-3 py-2' : 'group flex min-h-8 items-center gap-2 px-3 py-1'
                  )}
                >
                  {isEditing ? (
                    <div className="w-full space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10px] font-medium text-muted-foreground">
                          {t('input.queueEditing', { defaultValue: 'Edit queued message' })}
                        </span>
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 rounded-md px-2 text-[10px] text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                            onClick={() => saveQueuedMessage(msg.id)}
                          >
                            {t('action.save', { ns: 'common' })}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 rounded-md px-2 text-[10px] text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                            onClick={cancelEditQueuedMessage}
                          >
                            {t('action.cancel', { ns: 'common' })}
                          </Button>
                        </div>
                      </div>
                      {msg.command && (
                        <div className="rounded-md border border-violet-500/20 bg-violet-500/5 px-2.5 py-1.5 text-[10px] font-medium text-violet-700 dark:text-violet-300">
                          /{msg.command.name}
                        </div>
                      )}
                      <Textarea
                        value={editingQueueText}
                        onChange={(e) => setEditingQueueText(e.target.value)}
                        onPaste={handleQueueEditPaste}
                        className="composer-aux-textarea min-h-[56px] max-h-36 resize-none text-xs"
                        rows={2}
                      />
                      {editingQueueImages.length > 0 && (
                        <div className="flex gap-2 overflow-x-auto pb-1">
                          {editingQueueImages.map((img) => (
                            <div key={img.id} className="relative group/img shrink-0">
                              <button
                                type="button"
                                className="block cursor-zoom-in rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                aria-label={t('userMessage.imagePreview')}
                                title={t('userMessage.imagePreview')}
                                onClick={() => setPreviewImage(img)}
                              >
                                <img
                                  src={img.dataUrl}
                                  alt=""
                                  className="composer-image-thumb size-12 rounded-lg object-cover transition-transform group-hover/img:scale-[1.03]"
                                />
                              </button>
                              <button
                                type="button"
                                className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-sm opacity-0 transition-opacity group-hover/img:opacity-100"
                                aria-label={t('userMessage.removeImage')}
                                title={t('userMessage.removeImage')}
                                onClick={() => removeQueuedImage(img.id)}
                              >
                                <X className="size-2.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="flex items-center justify-between gap-2">
                        {editingQueueImages.length > 0 ? (
                          <p className="text-[10px] text-muted-foreground">
                            {t('input.queueImageCount', {
                              defaultValue: '{{count}} images',
                              count: editingQueueImages.length
                            })}
                          </p>
                        ) : (
                          <span />
                        )}
                        {supportsVision && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 rounded-md px-2 text-[10px] text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                            onClick={() => queueFileInputRef.current?.click()}
                          >
                            <ImagePlus className="size-3" />
                            {t('input.attachImages')}
                          </Button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <>
                      <CornerDownRight className="size-3 shrink-0 text-muted-foreground/65" />
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        title={fallbackText}
                        onClick={() => startEditQueuedMessage(msg)}
                      >
                        <span className="block truncate text-xs leading-5 text-muted-foreground/90 group-hover:text-foreground">
                          {fallbackText}
                        </span>
                      </button>
                      {commandLabel && summaryText ? (
                        <span className="hidden shrink-0 rounded border border-violet-500/20 px-1.5 py-0.5 text-[10px] text-violet-700 sm:inline-flex dark:text-violet-300">
                          {commandLabel}
                        </span>
                      ) : null}
                      {msg.images.length > 0 ? (
                        <span className="hidden shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline-flex">
                          {t('input.queueImageCount', {
                            defaultValue: '{{count}} images',
                            count: msg.images.length
                          })}
                        </span>
                      ) : null}
                      <div className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
                        {isQueueDispatchPaused && index === 0 ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 rounded-md px-2 text-[10px] text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                            onClick={resumeQueuedMessages}
                            title={t('input.queueResume', { defaultValue: 'Resume' })}
                            aria-label={t('input.queueResume', { defaultValue: 'Resume' })}
                          >
                            <Send className="size-3" />
                            <span className="hidden sm:inline">
                              {t('input.queueResume', { defaultValue: 'Resume' })}
                            </span>
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 rounded-md px-2 text-[10px] text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                          onClick={() => quoteQueuedMessage(msg.id)}
                          title={quoteLabel}
                          aria-label={quoteLabel}
                        >
                          <CornerDownRight className="size-3" />
                          <span className="hidden sm:inline">{quoteLabel}</span>
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => removeQueuedMessage(msg.id)}
                          title={t('action.delete', { ns: 'common' })}
                          aria-label={t('action.delete', { ns: 'common' })}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-7 rounded-md text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                              title={t('action.more', { ns: 'common' })}
                              aria-label={t('action.more', { ns: 'common' })}
                            >
                              <Ellipsis className="size-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="min-w-36">
                            {isQueueDispatchPaused ? (
                              <DropdownMenuItem onSelect={resumeQueuedMessages}>
                                <Send className="size-3.5" />
                                {t('input.queueResume', { defaultValue: 'Resume' })}
                              </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuItem onSelect={() => quoteQueuedMessage(msg.id)}>
                              <CornerDownRight className="size-3.5" />
                              {quoteLabel}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={handleClearQueuedMessages}
                            >
                              <Trash2 className="size-3.5" />
                              {t('action.clear', { ns: 'common' })}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <AlertDialog open={queueClearConfirmOpen} onOpenChange={setQueueClearConfirmOpen}>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('input.queueClearConfirmTitle', {
                  defaultValue: 'Clear queued messages?'
                })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t('input.queueClearConfirmDesc', {
                  defaultValue:
                    'This will delete {{count}} pending messages in the current session.',
                  count: queuedMessages.length
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel size="sm">
                {t('action.cancel', { ns: 'common' })}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                size="sm"
                onClick={clearQueuedMessagesForActiveSession}
              >
                {t('action.clear', { ns: 'common' })}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    ) : null

  return (
    <div
      ref={rootRef}
      data-tour="composer"
      className={cn('px-4 py-3', attachedFooter ? 'pb-0' : 'pb-4')}
    >
      {/* API key warning */}
      {!hasApiKey && (
        <button
          type="button"
          className="mb-2 flex w-full items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-left text-xs text-amber-600 dark:text-amber-400 transition-colors hover:bg-amber-500/10"
          onClick={() => openSettingsPage('provider')}
        >
          <AlertTriangle className="size-3.5 shrink-0" />
          <span>{t('input.noApiKey')}</span>
        </button>
      )}

      {/* Working folder required warning */}
      {needsWorkingFolder && onSelectFolder && (
        <button
          type="button"
          className="mb-2 flex w-full items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-left text-xs text-amber-600 dark:text-amber-400 transition-colors hover:bg-amber-500/10"
          onClick={onSelectFolder}
        >
          <FolderOpen className="size-3.5 shrink-0" />
          <span>{t('input.noWorkingFolder', { mode })}</span>
        </button>
      )}

      {/* Plan mode banner */}
      {planMode && projectScoped && (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-violet-500/30 bg-violet-500/5 px-3 py-1.5">
          <div className="flex items-center gap-1.5 text-xs text-violet-600 dark:text-violet-400">
            <ClipboardList className="size-3.5 shrink-0" />
            <span>
              {t('input.planModeActive', {
                defaultValue: 'Plan Mode — exploring codebase, no file changes'
              })}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-[10px] text-violet-600 dark:text-violet-400 hover:bg-violet-500/10"
            onClick={() => useUIStore.getState().exitPlanMode(draftSessionId)}
          >
            {t('input.exitPlanMode', { defaultValue: 'Exit Plan Mode' })}
          </Button>
        </div>
      )}

      {/* Working folder indicator */}
      {workingFolder && !hideWorkingFolderIndicator && (
        <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <FolderOpen className="size-3" />
          <span className="truncate">{workingFolder}</span>
        </div>
      )}

      {queuedMessagesPanel}

      {!hideGoalSessionBar && draftSessionId && (
        <GoalSessionBar
          sessionId={draftSessionId}
          className={cn('mb-2', fullWidth && 'max-w-none')}
        />
      )}

      {hasPendingGoalMode && (
        <div
          className={cn(
            composerWidthClass,
            'mb-2 flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-1.5 text-xs text-emerald-700 dark:text-emerald-300'
          )}
        >
          <Target className="size-3.5 shrink-0" />
          <span>
            {t('input.pendingGoalBanner', {
              defaultValue:
                'Goal pursuit is ready. Your next text message will be used as the goal and sent normally.'
            })}
          </span>
        </div>
      )}

      <div className={composerWidthClass}>
        <div
          ref={containerRef}
          className={cn(
            'composer-shell relative flex flex-col transition-[box-shadow,border-color] duration-200',
            fileMenuOpen || slashMenuOpen ? 'overflow-visible' : 'overflow-hidden',
            attachedFooter && 'composer-shell--attached-footer',
            dragging && 'ring-2 ring-primary/50'
          )}
          data-composer-variant={composerVariant}
          style={
            inputHeight !== null
              ? { height: inputHeight }
              : { height: autoInputHeight, maxHeight: autoMaxInputHeight }
          }
        >
          {/* Top drag handle */}
          {isSessionComposer && (
            <div
              className="composer-drag-handle flex h-3 cursor-row-resize items-center justify-center"
              onMouseDown={handleDragStart}
            >
              <div className="composer-drag-grip h-1 w-11 rounded-full" />
            </div>
          )}
          {/* Skill tag */}
          {selectedSkill && (
            <div className="shrink-0 px-3 pt-3 pb-0">
              <span className="composer-skill-tag inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium">
                <Sparkles className="size-3" />
                {selectedSkill}
                <button
                  type="button"
                  className="ml-0.5 rounded-full p-0.5 transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                  onClick={() => setSelectedSkill(null)}
                >
                  <X className="size-3" />
                </button>
              </span>
            </div>
          )}

          {/* Image preview strip */}
          {attachedImages.length > 0 && (
            <div
              ref={imagePreviewRef}
              className="shrink-0 flex gap-2 overflow-x-auto px-3 pt-3 pb-1"
            >
              {attachedImages.map((img) => (
                <div key={img.id} className="relative group/img shrink-0">
                  <button
                    type="button"
                    className="block cursor-zoom-in rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={t('userMessage.imagePreview')}
                    title={t('userMessage.imagePreview')}
                    onClick={() => setPreviewImage(img)}
                  >
                    <img
                      src={img.dataUrl}
                      alt=""
                      className="composer-image-thumb size-16 rounded-xl object-cover transition-transform group-hover/img:scale-[1.03]"
                    />
                  </button>
                  <button
                    type="button"
                    className="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-destructive text-destructive-foreground shadow-md opacity-0 group-hover/img:opacity-100 transition-opacity flex items-center justify-center"
                    aria-label={t('userMessage.removeImage')}
                    title={t('userMessage.removeImage')}
                    onClick={() => removeImage(img.id)}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <Dialog
            open={Boolean(previewImage)}
            onOpenChange={(open) => {
              if (!open) setPreviewImage(null)
            }}
          >
            <DialogContent className="max-h-[90vh] !w-fit !max-w-[min(96vw,1100px)] overflow-hidden p-2 sm:!max-w-[min(96vw,1100px)]">
              <DialogTitle className="sr-only">{t('userMessage.imagePreview')}</DialogTitle>
              {previewImage && (
                <div className="flex max-w-full items-center justify-center overflow-hidden">
                  <img
                    src={previewImage.dataUrl}
                    alt={t('userMessage.imagePreview')}
                    className="block h-auto max-h-[calc(90vh-1rem)] w-auto max-w-[min(92vw,1068px)] rounded object-contain"
                  />
                </div>
              )}
            </DialogContent>
          </Dialog>

          {/* Optimizing indicator - only show spinner, hide text */}
          {isOptimizing && (
            <div className="shrink-0 px-3 pt-3 pb-1">
              <div className="composer-panel rounded-[14px] px-3 py-2">
                <div className="flex items-center gap-2 text-[var(--composer-chip-text)]">
                  <Spinner className="size-3.5" />
                  <span className="text-xs font-semibold">
                    {t('input.optimizing', { defaultValue: 'Optimizing your prompt...' })}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Optimization Dialog */}
          <Dialog open={showOptimizationDialog} onOpenChange={setShowOptimizationDialog}>
            <DialogContent className="max-w-7xl max-h-[90vh] overflow-hidden flex flex-col gap-4">
              <DialogHeader className="space-y-2">
                <DialogTitle className="text-xl flex items-center gap-2">
                  <Wand2 className="size-5 text-primary" />
                  {t('input.optimizationResults', { defaultValue: 'Optimized Prompt Options' })}
                </DialogTitle>
                <DialogDescription className="text-sm">
                  {t('input.optimizationResultsDesc', {
                    defaultValue:
                      'Select one of the optimized versions below to use in your prompt.'
                  })}
                </DialogDescription>
              </DialogHeader>

              {/* Tab-style Layout */}
              <div className="flex-1 flex flex-col overflow-hidden gap-4">
                {/* Tabs - Options as tabs at top */}
                <div className="flex gap-2 border-b border-border pb-2">
                  {optimizationOptions.map((option, idx) => (
                    <button
                      key={idx}
                      type="button"
                      className={`flex-1 px-4 py-3 rounded-t-lg border-2 border-b-0 transition-all ${
                        selectedOptionIndex === idx
                          ? 'border-primary bg-primary/5 -mb-[2px] border-b-2 border-b-background'
                          : 'border-transparent hover:bg-muted/30'
                      }`}
                      onClick={() => {
                        setSelectedOptionIndex(idx)
                        // Scroll content to top when switching tabs
                        if (contentScrollRef.current) {
                          contentScrollRef.current.scrollTop = 0
                        }
                      }}
                    >
                      <div className="flex items-center justify-center gap-2">
                        <span
                          className={`inline-flex items-center justify-center size-6 rounded-full text-xs font-bold ${
                            selectedOptionIndex === idx
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          {idx + 1}
                        </span>
                        <div className="text-left">
                          <p className="text-sm font-semibold text-foreground">{option.title}</p>
                          <p className="text-xs text-muted-foreground truncate max-w-[200px]">
                            {option.focus}
                          </p>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>

                {/* Content Area - Show selected option's detailed content */}
                <div className="flex-1 overflow-hidden rounded-lg border border-border bg-background">
                  <div ref={contentScrollRef} className="h-full overflow-y-auto px-6 py-4">
                    <div className="prose prose-sm dark:prose-invert max-w-none">
                      <div className="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed font-sans">
                        {optimizationOptions[selectedOptionIndex]?.content}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <DialogFooter className="flex items-center justify-between">
                <Button variant="outline" onClick={handleCancelOptimization}>
                  {t('action.cancel', { ns: 'common' })}
                </Button>
                <Button
                  onClick={() =>
                    handleSelectOption(optimizationOptions[selectedOptionIndex]?.content)
                  }
                >
                  {t('input.useThisOption', { defaultValue: 'Use This' })}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Text input area */}
          <div
            className={cn(
              'composer-editor-region relative flex min-h-0 flex-1 flex-col px-3',
              selectedSkill || attachedImages.length > 0 ? 'pt-1.5' : 'pt-3'
            )}
            onDrop={handleDropWrapped}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            {dragging && (
              <div className="composer-drop-overlay absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                <span className="flex items-center gap-1.5 text-xs text-primary/70 font-medium">
                  <FileUp className="size-3.5" />
                  {supportsVision ? t('input.dropImages') : t('input.dropFiles')}
                </span>
              </div>
            )}
            <div className="relative flex-1 min-h-0 overflow-visible">
              {shouldAutoAcceptRecommendation &&
                autoAcceptCountdown !== null &&
                suggestionText &&
                !hasFileReferences && (
                  <div className="pointer-events-none absolute right-2 top-2 z-20 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                    {autoAcceptCountdown}s
                  </div>
                )}
              <FileAwareEditor
                ref={editorRef}
                document={documentNodes}
                files={selectedFiles}
                disabled={disabled || isOptimizing}
                placeholder={
                  pendingReviewPlanId
                    ? t('input.placeholderPlanReview', {
                        defaultValue:
                          'Enter suggestions for this plan, or click the card above to implement it...'
                      })
                    : hasPendingGoalMode
                      ? t('input.placeholderPendingGoal', {
                          defaultValue: 'Describe the goal to pursue...'
                        })
                      : (effectivePlaceholder ??
                        (shouldRecommendInit
                          ? t('input.placeholderInitWorkspace')
                          : t(placeholderKeys[mode] ?? 'input.placeholder')))
                }
                suggestionText={suggestionText}
                showSuggestion={Boolean(
                  suggestionText &&
                  text.length > 0 &&
                  !hasFileReferences &&
                  !activeFileMention &&
                  !slashMenuOpen
                )}
                highlightedFileId={highlightedFileId}
                onDocumentChange={handleEditorDocumentChange}
                onSelectionChange={handleEditorSelectionChange}
                onFocus={handleRecommendationFocus}
                onBlur={handleRecommendationBlur}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onCompositionStart={handleRecommendationCompositionStart}
                onCompositionEnd={() => {
                  handleRecommendationCompositionEnd()
                }}
                onReferencePreview={handlePreviewFile}
                onReferenceLocate={handleLocateFileReference}
                onReferenceDelete={handleRemoveFileReference}
                className="h-full w-full"
              />
              {fileMenuOpen && (
                <div className="composer-flyout absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-[18px]">
                  <div className="composer-flyout-header flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground">
                    <Command className="size-3.5" />
                    <span>{t('input.fileSuggestions', { defaultValue: 'File suggestions' })}</span>
                    <span className="composer-status-pill ml-auto rounded-full px-1.5 py-0.5 text-[10px]">
                      @{fileQuery || ''}
                    </span>
                  </div>
                  <div className="max-h-64 overflow-y-auto p-1.5">
                    {!workingFolder ? (
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-3 text-left text-xs text-amber-600 transition-colors hover:bg-amber-500/10 dark:text-amber-400"
                        onMouseDown={(event) => {
                          event.preventDefault()
                          onSelectFolder?.()
                        }}
                      >
                        <FolderOpen className="size-3.5 shrink-0" />
                        <span>
                          {t('input.noWorkingFolderSelected', {
                            defaultValue: 'Please select a working directory first'
                          })}
                        </span>
                      </button>
                    ) : fileSearchLoading ? (
                      <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                        <Spinner className="size-3.5" />
                        <span>
                          {t('input.loadingFiles', { defaultValue: 'Searching files...' })}
                        </span>
                      </div>
                    ) : fileSearchResults.length === 0 ? (
                      <div className="px-2 py-3 text-xs text-muted-foreground">
                        {t('input.noFilesFound', { defaultValue: 'No matching files' })}
                      </div>
                    ) : (
                      fileSearchResults.map((file, index) => {
                        const isSelected = index === selectedFileSearchIndex
                        return (
                          <button
                            key={file.path}
                            type="button"
                            className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                              isSelected
                                ? 'bg-accent text-accent-foreground'
                                : 'hover:bg-muted/50 text-foreground'
                            }`}
                            onMouseDown={(event) => {
                              event.preventDefault()
                              insertSelectedFile(file.path)
                            }}
                            onClick={(event) => {
                              event.preventDefault()
                            }}
                          >
                            <FileCode2 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium">{file.name}</div>
                              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                                {file.path}
                              </div>
                            </div>
                          </button>
                        )
                      })
                    )}
                  </div>
                </div>
              )}
              {slashMenuOpen && (
                <div className="composer-flyout absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-[18px]">
                  <div className="composer-flyout-header flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground">
                    <Command className="size-3.5" />
                    <span>
                      {t('input.slashSuggestions', {
                        defaultValue: 'Command, plugin & skill suggestions'
                      })}
                    </span>
                    <span className="composer-status-pill ml-auto rounded-full px-1.5 py-0.5 text-[10px]">
                      /{slashQuery ?? ''}
                    </span>
                  </div>
                  <div className="max-h-64 overflow-y-auto p-1">
                    {slashSuggestionsLoading ? (
                      <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                        <Spinner className="size-3.5" />
                        <span>
                          {t('input.loadingSlashSuggestions', {
                            defaultValue: 'Loading commands, plugins, and skills...'
                          })}
                        </span>
                      </div>
                    ) : filteredSlashSuggestions.length === 0 ? (
                      <div className="px-2 py-3 text-xs text-muted-foreground">
                        {t('input.noSlashSuggestionsFound', {
                          defaultValue: 'No matching commands, plugins, or skills'
                        })}
                      </div>
                    ) : (
                      filteredSlashSuggestions.map((item, index) => {
                        const isSelected = index === selectedSlashIndex
                        return (
                          <button
                            key={item.key}
                            type="button"
                            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                              isSelected
                                ? 'bg-accent text-accent-foreground'
                                : 'hover:bg-muted/50 text-foreground'
                            }`}
                            onMouseDown={(event) => {
                              event.preventDefault()
                              applySlashSuggestion(item)
                            }}
                          >
                            {item.kind === 'skill' ? (
                              <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
                            ) : item.kind === 'plugin' ? (
                              <Puzzle className="size-3.5 shrink-0 text-muted-foreground" />
                            ) : (
                              <Command className="size-3.5 shrink-0 text-muted-foreground" />
                            )}
                            <div className="min-w-0 flex flex-1 items-center gap-2 overflow-hidden">
                              <div className="max-w-[45%] shrink-0 truncate text-sm font-medium">
                                {item.kind === 'command'
                                  ? `/${item.name}`
                                  : (item.label ?? item.name)}
                              </div>
                              {item.summary && (
                                <div className="truncate text-[11px] text-muted-foreground">
                                  {item.summary}
                                </div>
                              )}
                            </div>
                            <span className="composer-status-pill shrink-0 rounded-full px-1.5 py-0.5 text-[10px]">
                              {item.kind === 'command'
                                ? t('skills.commandsLabel')
                                : item.kind === 'plugin'
                                  ? t('skills.pluginsLabel')
                                  : t('skills.skillsLabel')}
                            </span>
                          </button>
                        )
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Hidden file input for queue image upload */}
          <input
            ref={queueFileInputRef}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES.join(',')}
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) {
                void addQueuedImages(Array.from(e.target.files))
              }
              e.target.value = ''
            }}
          />

          {/* Bottom toolbar */}
          <div
            ref={bottomToolbarRef}
            className="composer-toolbar relative z-20 mt-1 shrink-0 flex items-center justify-between gap-2 px-2 pb-2"
          >
            <div className="flex w-full items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pr-1 [scrollbar-width:none]">
                <div className="shrink-0">
                  {readOnlyModel !== undefined ? (
                    <ReadOnlyModelBadge model={readOnlyModel} />
                  ) : (
                    <ModelSwitcher modelRoute={modelRoute} sessionId={draftSessionId} />
                  )}
                </div>
                {webSearchToggleControl}
                {skillsMenuControl}
                {activeMcpBadge}
                {activeExtensionBadge}
                {folderControl}
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <ContextRing
                  sessionId={draftSessionId}
                  onCompressContext={onCompressContext ? handleCompressContext : undefined}
                  isCompressing={isContextCompressing}
                />

                {showInlineClearConversation && hasMessages && !isStreaming && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="composer-control rounded-lg"
                        data-tone="danger"
                        aria-label={t('input.clearConversation')}
                        title={t('input.clearConversation')}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent size="sm">
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t('input.clearConfirmTitle')}</AlertDialogTitle>
                        <AlertDialogDescription>
                          {queuedMessages.length > 0
                            ? t('input.clearConfirmDescWithQueue', {
                                defaultValue:
                                  'This will delete all messages in this conversation and clear {{count}} pending messages in the current session. This action cannot be undone.',
                                count: queuedMessages.length
                              })
                            : t('input.clearConfirmDesc')}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel size="sm">
                          {t('action.cancel', { ns: 'common' })}
                        </AlertDialogCancel>
                        <AlertDialogAction
                          variant="destructive"
                          size="sm"
                          onClick={() => {
                            if (!activeSessionId) return
                            clearSessionMessages(activeSessionId)
                            clearPendingSessionMessages(activeSessionId)
                          }}
                        >
                          {t('action.clear', { ns: 'common' })}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}

                {stopControl}
                {optimizeControl}
                {sendControl}
              </div>
            </div>
          </div>
        </div>

        {draftSessionId && (
          <ComposerRuntimeStatus
            sessionId={draftSessionId}
            isStreaming={isStreaming}
            draftInputTokens={debouncedTokens}
            isOptimizing={isOptimizing}
            pendingImageReads={pendingImageReads}
            contextCompressionStatus={contextCompressionStatus}
            contextCompressionStatusLabel={contextCompressionStatusLabel}
            model={composerModelCfg}
            className="mt-1.5 px-3"
          />
        )}
      </div>
    </div>
  )
}
