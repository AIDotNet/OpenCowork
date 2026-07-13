import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useShallow } from 'zustand/react/shallow'
import { useVirtualizer } from '@tanstack/react-virtual'
import { MessageSquare, CircleHelp, Briefcase, Code2, ShieldCheck, ArrowDown } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import type { ContentBlock, ToolResultContent, UnifiedMessage } from '@renderer/lib/api/types'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useTeamStore, type ActiveTeam } from '@renderer/stores/team-store'
import { cn } from '@renderer/lib/utils'
import { MessageItem } from './MessageItem'
import { SessionChangeSummaryCard } from './SessionChangeSummaryCard'
import {
  buildChatRenderableMessageMetaFromAnalysis,
  buildTranscriptStaticAnalysis,
  type ChatRenderableMessageMeta,
  type TailToolExecutionState
} from './transcript-utils'
import { buildOrchestrationRuns } from '@renderer/lib/orchestration/build-runs'
import { type EditableUserMessageDraft } from '@renderer/lib/image-attachments'
import type { RequestRetryState } from '@renderer/lib/agent/types'
import { isStreamingPerfEnabled, recordStreamingReactCommit } from '@renderer/lib/streaming-perf'
import { invokeMessagePackBinary } from '@renderer/lib/ipc/messagepack-ipc-client'
import { selectSessionScopedAgentState } from '@renderer/lib/agent/session-scoped-agent-state'
import {
  getCompactSummaryDisplayText,
  resolveActiveCompactArtifacts
} from '@renderer/lib/agent/context-compression'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import { DB_MESSAGES_LIST_LOCATOR_MSGPACK_CHANNEL } from '../../../../shared/messagepack/binary-ipc'

const modeHints = {
  chat: {
    icon: <MessageSquare className="size-12 text-muted-foreground/20" />,
    titleKey: 'messageList.startConversation',
    descKey: 'messageList.startConversationDesc'
  },
  clarify: {
    icon: <CircleHelp className="size-12 text-muted-foreground/20" />,
    titleKey: 'messageList.startClarify',
    descKey: 'messageList.startClarifyDesc'
  },
  cowork: {
    icon: <Briefcase className="size-12 text-muted-foreground/20" />,
    titleKey: 'messageList.startCowork',
    descKey: 'messageList.startCoworkDesc'
  },
  code: {
    icon: <Code2 className="size-12 text-muted-foreground/20" />,
    titleKey: 'messageList.startCoding',
    descKey: 'messageList.startCodingDesc'
  },
  acp: {
    icon: <ShieldCheck className="size-12 text-muted-foreground/20" />,
    titleKey: 'messageList.startAcp',
    descKey: 'messageList.startAcpDesc'
  }
}

interface MessageListProps {
  sessionId?: string | null
  onRetry?: () => void
  onContinue?: () => void
  onEditUserMessage?: (messageId: string, draft: EditableUserMessageDraft) => void
  onDeleteMessage?: (messageId: string) => void
  exportAll?: boolean
  fullWidth?: boolean
}

type RenderableMessage = ChatRenderableMessageMeta

type ToolResultsLookup = Map<string, { content: ToolResultContent; isError?: boolean }>

type MessageListRow = { type: 'message'; key: string; data: RenderableMessage }

type AutoScrollMode = 'off' | 'user' | 'stream'

interface AskUserQuestionPresence {
  assistantMessageId: string
  toolUseId: string
}

function getMessageToolUseIds(message: UnifiedMessage): string[] {
  if (!Array.isArray(message.content)) return []
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> => {
      return block.type === 'tool_use'
    })
    .map((block) => block.id)
    .filter(Boolean)
}

function toolResultContentToText(content: ToolResultContent | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
}

function getPlanReviewPlanId(content: ToolResultContent | undefined): string | null {
  const text = toolResultContentToText(content)
  if (!text.trim()) return null
  const parsed = decodeStructuredToolResult(text)
  if (!parsed || Array.isArray(parsed)) return null
  const planId = typeof parsed.plan_id === 'string' ? parsed.plan_id.trim() : ''
  return planId || null
}

function collectDuplicatePlanReviewToolUseIds(
  messages: UnifiedMessage[],
  toolResultsLookup: Map<string, ToolResultsLookup>
): Set<string> {
  const latestByPlanId = new Map<string, { toolUseId: string; order: number }>()
  const occurrences: Array<{ planId: string; toolUseId: string; order: number }> = []
  let order = 0

  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      order += 1
      continue
    }

    const toolResults = toolResultsLookup.get(message.id)
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue
      if (block.name !== 'ExitPlanMode') continue

      const planId = getPlanReviewPlanId(toolResults?.get(block.id)?.content)
      if (!planId) {
        order += 1
        continue
      }

      const occurrence = { planId, toolUseId: block.id, order }
      occurrences.push(occurrence)
      const previous = latestByPlanId.get(planId)
      if (!previous || occurrence.order > previous.order) {
        latestByPlanId.set(planId, occurrence)
      }
      order += 1
    }
  }

  const hidden = new Set<string>()
  for (const occurrence of occurrences) {
    const latest = latestByPlanId.get(occurrence.planId)
    if (latest && latest.toolUseId !== occurrence.toolUseId) {
      hidden.add(occurrence.toolUseId)
    }
  }
  return hidden
}

function mergeHiddenToolUseIds(first?: Set<string>, second?: Set<string>): Set<string> | undefined {
  if (!first || first.size === 0) return second && second.size > 0 ? second : undefined
  if (!second || second.size === 0) return first
  return new Set([...first, ...second])
}

function hasCompleteTailToolExecutionResults(state: TailToolExecutionState | null): boolean {
  if (!state || state.toolUseBlocks.length === 0) return false

  return state.toolUseBlocks.every((toolUse) => state.toolResultMap.has(toolUse.id))
}

function hasEmptyAssistantContent(message: UnifiedMessage): boolean {
  if (message.role !== 'assistant') return false
  if (typeof message.content === 'string') return message.content.length === 0
  return Array.isArray(message.content) && message.content.length === 0
}

interface MessageLocatorIndexRow {
  id: string
  session_id: string
  role: string
  content: string
  meta: string | null
  created_at: number
  sort_order: number
}

interface MessageLocatorSource {
  id: string
  role: UnifiedMessage['role']
  content: UnifiedMessage['content']
  meta?: UnifiedMessage['meta']
  createdAt: number
  sortOrder: number
  source?: UnifiedMessage['source']
}

type AssistantRailMarkerKind = 'assistant' | 'streaming' | 'summary' | 'user'

interface AssistantRailLayoutRow extends MessageLocatorSource {
  estimatedTop: number
  estimatedHeight: number
  markerKind: AssistantRailMarkerKind | null
}

interface AssistantReplyRailItem {
  id: string
  index: number
  preview: string
  time: string
  position: number
  sortOrder: number
  createdAt: number
  estimatedTop: number
  estimatedHeight: number
  kind: AssistantRailMarkerKind
}

interface AssistantRailLayout {
  rows: AssistantRailLayoutRow[]
  items: AssistantReplyRailItem[]
  totalEstimatedHeight: number
}

type ChatStoreSnapshot = ReturnType<typeof useChatStore.getState>
type TeamStoreSnapshot = ReturnType<typeof useTeamStore.getState>

interface MessageRowProps {
  message: UnifiedMessage
  sessionId?: string | null
  sessionAssistantMessageIds?: readonly string[]
  sessionToolUseIds?: readonly string[]
  isStreaming: boolean
  isLastUserMessage: boolean
  isLastAssistantMessage: boolean
  showContinue: boolean
  disableAnimation: boolean
  toolResults?: ToolResultsLookup
  inlineCompactSummaries?: readonly UnifiedMessage[]
  orchestrationRun?: import('@renderer/lib/orchestration/types').OrchestrationRun | null
  hiddenToolUseIds?: Set<string>
  anchorMessageId?: string | null
  highlightMessageId?: string | null
  requestRetryState?: RequestRetryState | null
  renderMode?: 'default' | 'transcript' | 'static'
  showChangeSummary?: boolean
  fullWidth?: boolean
  onRetry?: () => void
  onContinue?: () => void
  onEditUserMessage?: (messageId: string, draft: EditableUserMessageDraft) => void
  onDeleteMessage?: (messageId: string) => void
}

const EMPTY_MESSAGES: UnifiedMessage[] = []
const EMPTY_TEAM_HISTORY: ActiveTeam[] = []
const AUTO_SCROLL_BOTTOM_THRESHOLD = 24
const STREAMING_AUTO_SCROLL_BOTTOM_THRESHOLD = 80
const STREAMING_AUTO_SCROLL_STOP_THRESHOLD = 240
const TAIL_STATIC_MESSAGE_COUNT = 4
const TAIL_LIVE_MESSAGE_COUNT = 6
const INITIAL_SCROLL_SETTLE_FRAMES = 2
const FOLLOW_BOTTOM_SETTLE_FRAMES = 3
const BOTTOM_SCROLL_CORRECTION_EPSILON = 2
const AUTO_SCROLL_MIN_DELTA = 24
const PROGRAMMATIC_SCROLL_GUARD_MS = 160
const STREAMING_AUTO_SCROLL_POLL_MS = 500
const USER_LOCATOR_HIGHLIGHT_MS = 1400
const ASSISTANT_RAIL_PREVIEW_LIMIT = 120
const ASSISTANT_RAIL_SCROLL_OFFSET = 28
const ASSISTANT_RAIL_DENSE_THRESHOLD = 80
const OLDER_MESSAGE_LOAD_SCROLL_THRESHOLD = 72
const MIN_RENDERABLE_HISTORY_ROWS = 3
const VIRTUAL_ROW_ESTIMATED_HEIGHT = 180
const VIRTUAL_ROW_OVERSCAN = 8
const EMPTY_ORCHESTRATION_STATE = { runs: [], byId: new Map(), byMessageId: new Map() }
const MESSAGE_COLUMN_CLASS = 'mx-auto w-full max-w-[820px] px-5'
const MESSAGE_COLUMN_COMPACT_CLASS = 'mx-auto w-full max-w-[720px] px-5'
const MESSAGE_COLUMN_FULL_WIDTH_CLASS = 'mx-auto w-full max-w-none px-5'
const EMPTY_MESSAGE_LOCATOR_ROWS: MessageLocatorIndexRow[] = []
const EMPTY_ASSISTANT_RAIL_LAYOUT: AssistantRailLayout = {
  rows: [],
  items: [],
  totalEstimatedHeight: 0
}

function getMessageColumnClass(fullWidth: boolean): string {
  return fullWidth ? MESSAGE_COLUMN_FULL_WIDTH_CLASS : MESSAGE_COLUMN_CLASS
}

function getMessageColumnCompactClass(fullWidth: boolean): string {
  return fullWidth ? MESSAGE_COLUMN_FULL_WIDTH_CLASS : MESSAGE_COLUMN_COMPACT_CLASS
}

interface MessageListSessionSelection {
  messages: UnifiedMessage[]
  messagesLoaded: boolean
  messageCount: number
  workingFolder?: string
  loadedRangeStart: number
  projectId?: string
}

interface SessionScopedTeamSelection {
  activeTeam: ActiveTeam | null
  teamHistory: ActiveTeam[]
  isTeamRunning: boolean
  hasOrchestrationData: boolean
  signature: string
}

const EMPTY_MESSAGE_LIST_SESSION_SELECTION: MessageListSessionSelection = {
  messages: EMPTY_MESSAGES,
  messagesLoaded: false,
  messageCount: 0,
  loadedRangeStart: 0,
  projectId: undefined,
  workingFolder: undefined
}

const EMPTY_SESSION_TEAM_SELECTION: SessionScopedTeamSelection = {
  activeTeam: null,
  teamHistory: EMPTY_TEAM_HISTORY,
  isTeamRunning: false,
  hasOrchestrationData: false,
  signature: 'empty'
}

const sessionScopedTeamSelectionCache = new Map<string, SessionScopedTeamSelection>()

function areToolResultsEqual(a?: ToolResultsLookup, b?: ToolResultsLookup): boolean {
  if (a === b) return true
  if (!a || !b) return !a && !b
  if (a.size !== b.size) return false

  for (const [id, value] of a) {
    const other = b.get(id)
    if (!other) return false
    if (other.isError !== value.isError) return false
    if (other.content !== value.content) return false
  }

  return true
}

function areStringSetsEqual(a?: Set<string>, b?: Set<string>): boolean {
  if (a === b) return true
  if (!a || !b) return !a && !b
  if (a.size !== b.size) return false

  for (const value of a) {
    if (!b.has(value)) return false
  }

  return true
}

function areStringArraysEqual(a?: readonly string[], b?: readonly string[]): boolean {
  if (a === b) return true
  if (!a || !b) return !a && !b
  if (a.length !== b.length) return false

  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false
  }

  return true
}

function areRequestRetryStatesEqual(
  a?: RequestRetryState | null,
  b?: RequestRetryState | null
): boolean {
  if (a === b) return true
  if (!a || !b) return !a && !b

  return (
    a.attempt === b.attempt &&
    a.maxAttempts === b.maxAttempts &&
    a.delayMs === b.delayMs &&
    a.statusCode === b.statusCode &&
    a.reason === b.reason
  )
}

function buildTeamMemberRenderSignature(team: ActiveTeam): string {
  return team.members
    .map((member) =>
      [
        member.id,
        member.name,
        member.agentName ?? '',
        member.role ?? '',
        member.status,
        String(member.iteration),
        String(member.currentTaskId ?? ''),
        String(member.startedAt),
        String(member.completedAt ?? ''),
        member.streamingText ?? '',
        String(member.toolCalls.length)
      ].join(':')
    )
    .join('|')
}

function buildTeamTaskRenderSignature(team: ActiveTeam): string {
  return team.tasks
    .map((task) =>
      [
        task.id,
        task.subject,
        task.status,
        task.owner ?? '',
        task.description ?? '',
        task.report ?? ''
      ].join(':')
    )
    .join('|')
}

function buildTeamMessageRenderSignature(team: ActiveTeam): string {
  const lastMessage = team.messages[team.messages.length - 1]
  return [
    String(team.messages.length),
    lastMessage?.id ?? '',
    lastMessage?.summary ?? '',
    lastMessage?.timestamp ?? ''
  ].join(':')
}

function buildTeamRenderSignature(team: ActiveTeam): string {
  return [
    team.name,
    team.description,
    team.sessionId ?? '',
    String(team.createdAt),
    String(team.lastRuntimeSyncAt ?? ''),
    buildTeamMemberRenderSignature(team),
    buildTeamTaskRenderSignature(team),
    buildTeamMessageRenderSignature(team)
  ].join('::')
}

function isActiveTeamRunning(team: ActiveTeam): boolean {
  return (
    team.tasks.some((task) => task.status !== 'completed') ||
    team.members.some((member) => member.status === 'working' || member.status === 'waiting')
  )
}

function selectMessageListSession(
  state: ChatStoreSnapshot,
  sessionId: string | null | undefined
): MessageListSessionSelection {
  if (!sessionId) return EMPTY_MESSAGE_LIST_SESSION_SELECTION

  const idx = state.sessionsById[sessionId]
  if (idx === undefined) return EMPTY_MESSAGE_LIST_SESSION_SELECTION

  const session = state.sessions[idx]
  return {
    messages: session.messages ?? EMPTY_MESSAGES,
    messagesLoaded: session.messagesLoaded ?? false,
    messageCount: session.messageCount ?? 0,
    workingFolder: session.workingFolder,
    loadedRangeStart: session.loadedRangeStart ?? 0,
    projectId: session.projectId
  }
}

function selectSessionScopedTeamState(
  state: TeamStoreSnapshot,
  sessionId: string | null | undefined
): SessionScopedTeamSelection {
  if (!sessionId) return EMPTY_SESSION_TEAM_SELECTION

  const activeTeam = state.activeTeam?.sessionId === sessionId ? state.activeTeam : null
  let teamHistory = EMPTY_TEAM_HISTORY
  const signatureParts: string[] = []

  if (activeTeam) {
    signatureParts.push(`active:${buildTeamRenderSignature(activeTeam)}`)
  }

  for (const team of state.teamHistory) {
    if (team.sessionId !== sessionId) continue
    if (teamHistory === EMPTY_TEAM_HISTORY) teamHistory = []
    teamHistory.push(team)
    signatureParts.push(`history:${buildTeamRenderSignature(team)}`)
  }

  const signature = signatureParts.join('\u0001')
  const cached = sessionScopedTeamSelectionCache.get(sessionId)
  if (cached?.signature === signature) return cached

  const nextSelection: SessionScopedTeamSelection = {
    activeTeam,
    teamHistory,
    isTeamRunning: activeTeam ? isActiveTeamRunning(activeTeam) : false,
    hasOrchestrationData: Boolean(activeTeam) || teamHistory !== EMPTY_TEAM_HISTORY,
    signature
  }

  sessionScopedTeamSelectionCache.set(sessionId, nextSelection)
  return nextSelection
}

function getOrchestrationRunSignature(
  run?: import('@renderer/lib/orchestration/types').OrchestrationRun | null
): string {
  if (!run) return ''

  const memberSig = run.members
    .map(
      (member) =>
        `${member.id}:${member.status}:${member.iteration}:${member.progress}:${member.toolCallCount}:${member.completedAt ?? ''}:${member.latestAction}:${member.summary}`
    )
    .join('|')

  return [
    run.id,
    run.status,
    run.stageIndex,
    run.stageCount,
    run.selectedMemberId ?? '',
    run.completedAt ?? '',
    run.summary,
    run.latestAction,
    memberSig
  ].join('::')
}
void getOrchestrationRunSignature

function areMessageRowPropsEqual(prev: MessageRowProps, next: MessageRowProps): boolean {
  return (
    prev.message === next.message &&
    prev.sessionId === next.sessionId &&
    areStringArraysEqual(prev.sessionAssistantMessageIds, next.sessionAssistantMessageIds) &&
    areStringArraysEqual(prev.sessionToolUseIds, next.sessionToolUseIds) &&
    prev.isStreaming === next.isStreaming &&
    prev.isLastUserMessage === next.isLastUserMessage &&
    prev.isLastAssistantMessage === next.isLastAssistantMessage &&
    prev.showContinue === next.showContinue &&
    prev.disableAnimation === next.disableAnimation &&
    prev.fullWidth === next.fullWidth &&
    (prev.toolResults === next.toolResults ||
      areToolResultsEqual(prev.toolResults, next.toolResults)) &&
    prev.inlineCompactSummaries === next.inlineCompactSummaries &&
    prev.orchestrationRun === next.orchestrationRun &&
    prev.hiddenToolUseIds === next.hiddenToolUseIds &&
    prev.anchorMessageId === next.anchorMessageId &&
    prev.highlightMessageId === next.highlightMessageId &&
    prev.renderMode === next.renderMode &&
    prev.showChangeSummary === next.showChangeSummary &&
    areRequestRetryStatesEqual(prev.requestRetryState, next.requestRetryState) &&
    prev.onRetry === next.onRetry &&
    prev.onContinue === next.onContinue &&
    prev.onEditUserMessage === next.onEditUserMessage &&
    prev.onDeleteMessage === next.onDeleteMessage
  )
}

function getDistanceToBottom(ref: HTMLDivElement): number {
  return Math.max(0, ref.scrollHeight - ref.scrollTop - ref.clientHeight)
}

function findPendingAskUserQuestion(
  rows: MessageListRow[],
  toolResultsLookup: Map<string, ToolResultsLookup>,
  messageLookup: Map<string, UnifiedMessage>
): AskUserQuestionPresence | null {
  for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
    const row = rows[rowIndex]
    if (row.type !== 'message') continue

    const message = messageLookup.get(row.data.messageId)
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) continue

    const toolResults = toolResultsLookup.get(row.data.messageId)
    for (const block of message.content) {
      if (block.type !== 'tool_use' || block.name !== 'AskUserQuestion') continue
      if (toolResults?.has(block.id)) continue
      return { assistantMessageId: row.data.messageId, toolUseId: block.id }
    }
  }

  return null
}

function normalizeLocatorPreview(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function truncateAssistantRailPreview(text: string): string {
  if (text.length <= ASSISTANT_RAIL_PREVIEW_LIMIT) return text
  return `${text.slice(0, ASSISTANT_RAIL_PREVIEW_LIMIT - 1).trimEnd()}...`
}

function isSystemPromptText(text: string): boolean {
  return text.trim().toLowerCase().startsWith('<system')
}

function getUserMessageText(content: UnifiedMessage['content']): string {
  if (typeof content === 'string') return isSystemPromptText(content) ? '' : content
  return content
    .filter(
      (block) =>
        block.type === 'text' && typeof block.text === 'string' && !isSystemPromptText(block.text)
    )
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
}

function getAssistantVisibleText(content: UnifiedMessage['content']): string {
  if (typeof content === 'string') return content
  return content
    .filter((block) => block.type === 'text' || block.type === 'agent_error')
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'agent_error') return block.message
      return ''
    })
    .join('\n')
}

function countToolUseBlocks(content: UnifiedMessage['content']): number {
  if (typeof content === 'string') return 0
  return content.filter((block) => block.type === 'tool_use').length
}

function countCodeFenceBlocks(text: string): number {
  return text.match(/```/g)?.length ?? 0
}

function isTeamLocatorSource(source: MessageLocatorSource): boolean {
  if (source.source === 'team') return true
  return (
    typeof source.content === 'string' && /^\[Team message from .+?\]:\n?/u.test(source.content)
  )
}

function shouldShowAssistantRailMarker(
  source: MessageLocatorSource,
  hiddenCompactSummaryIds: Set<string>
): boolean {
  if (hiddenCompactSummaryIds.has(source.id)) return false
  if (source.meta?.compactSummary) return true
  if (source.meta?.compactBoundary) return false
  if (source.meta?.compressionStatus) return false
  if (isTeamLocatorSource(source)) return false
  if (source.role === 'user') {
    return (
      Boolean(normalizeLocatorPreview(getUserMessageText(source.content))) ||
      countImageBlocks(source.content) > 0
    )
  }
  if (source.role !== 'assistant') return false
  return true
}

function getAssistantRailMarkerKind(
  source: MessageLocatorSource,
  streamingMessageId: string | null,
  hiddenCompactSummaryIds: Set<string>
): AssistantRailMarkerKind | null {
  if (!shouldShowAssistantRailMarker(source, hiddenCompactSummaryIds)) return null
  if (source.meta?.compactSummary) return 'summary'
  if (source.role === 'user') return 'user'
  if (source.id === streamingMessageId) return 'streaming'
  return 'assistant'
}

function buildAssistantRailPreview(
  source: MessageLocatorSource,
  kind: AssistantRailMarkerKind,
  t: TFunction
): string {
  const text =
    kind === 'summary'
      ? getCompactSummaryDisplayText({
          id: source.id,
          role: source.role,
          content: source.content,
          createdAt: source.createdAt,
          meta: source.meta
        })
      : kind === 'user'
        ? getUserMessageText(source.content)
        : getAssistantVisibleText(source.content)
  const preview = truncateAssistantRailPreview(normalizeLocatorPreview(text))
  if (preview) return preview

  if (kind === 'user') {
    const imageCount = countImageBlocks(source.content)
    if (imageCount > 0) {
      return t('messageList.userLocator.imageMessage', {
        count: imageCount,
        defaultValue: imageCount === 1 ? 'Image message' : '{{count}} images'
      })
    }
    return t('messageList.userLocator.emptyMessage', {
      defaultValue: 'Empty message'
    })
  }

  const toolUseCount = countToolUseBlocks(source.content)
  if (toolUseCount > 0) {
    return t('messageList.assistantRail.toolOnlyPreview', {
      count: toolUseCount,
      defaultValue: toolUseCount === 1 ? '1 tool call' : '{{count}} tool calls'
    })
  }

  if (kind === 'summary') {
    return t('messageList.assistantRail.summaryPreview', {
      defaultValue: 'Compressed history summary'
    })
  }

  return t('messageList.assistantRail.emptyPreview', {
    defaultValue: 'Assistant reply'
  })
}

function estimateLocatorRowHeight(source: MessageLocatorSource): number {
  if (source.meta?.compressionStatus) return 64
  if (source.meta?.compactBoundary) return 40
  if (source.meta?.compactSummary) return 112

  const text =
    source.role === 'assistant'
      ? getAssistantVisibleText(source.content)
      : getUserMessageText(source.content)
  const normalizedLength = normalizeLocatorPreview(text).length
  const newlineCount = text.split('\n').length - 1
  const imageCount = countImageBlocks(source.content)
  const toolUseCount = countToolUseBlocks(source.content)
  const codeFenceCount = countCodeFenceBlocks(text)

  if (source.role === 'assistant') {
    return Math.max(
      96,
      96 +
        Math.ceil(normalizedLength / 82) * 22 +
        newlineCount * 8 +
        Math.ceil(codeFenceCount / 2) * 96 +
        toolUseCount * 88 +
        imageCount * 180
    )
  }

  if (source.role === 'user') {
    return Math.max(72, 72 + Math.ceil(normalizedLength / 90) * 18 + imageCount * 120)
  }

  if (source.role === 'tool') return 64 + Math.min(120, Math.ceil(normalizedLength / 120) * 18)
  return 48
}

function buildAssistantRailLayout(args: {
  sources: MessageLocatorSource[]
  streamingMessageId: string | null
  measuredHeights: Map<string, number>
  hiddenCompactSummaryIds: Set<string>
  t: TFunction
}): AssistantRailLayout {
  if (args.sources.length === 0) return EMPTY_ASSISTANT_RAIL_LAYOUT

  const rows: AssistantRailLayoutRow[] = []
  let estimatedTop = 0

  for (const source of args.sources) {
    const estimatedHeight = Math.max(
      1,
      args.measuredHeights.get(source.id) ?? estimateLocatorRowHeight(source)
    )
    const markerKind = getAssistantRailMarkerKind(
      source,
      args.streamingMessageId,
      args.hiddenCompactSummaryIds
    )
    rows.push({ ...source, estimatedTop, estimatedHeight, markerKind })
    estimatedTop += estimatedHeight
  }

  const totalEstimatedHeight = Math.max(1, estimatedTop)
  const items: AssistantReplyRailItem[] = []
  for (const row of rows) {
    if (!row.markerKind) continue
    items.push({
      id: row.id,
      index: items.length + 1,
      preview: buildAssistantRailPreview(row, row.markerKind, args.t),
      time: formatLocatorTime(row.createdAt),
      position: (row.estimatedTop + row.estimatedHeight / 2) / totalEstimatedHeight,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      estimatedTop: row.estimatedTop,
      estimatedHeight: row.estimatedHeight,
      kind: row.markerKind
    })
  }

  return { rows, items, totalEstimatedHeight }
}

function parseLocatorRowSource(row: MessageLocatorIndexRow): MessageLocatorSource {
  return {
    id: row.id,
    role: row.role as UnifiedMessage['role'],
    content: parseLocatorContent(row.content),
    meta: parseLocatorMeta(row.meta),
    createdAt: row.created_at,
    sortOrder: row.sort_order
  }
}

function countImageBlocks(content: UnifiedMessage['content']): number {
  if (typeof content === 'string') return 0
  return content.filter((block) => block.type === 'image' || block.type === 'image_error').length
}

function getCompactRailGapPx(total: number): number {
  return Math.max(3.5, Math.min(9, 176 / (Math.max(2, total) - 1)))
}

function getCompactRailMarkerOffsetPx(index: number, total: number): number {
  const safeTotal = Math.max(1, total)
  if (safeTotal === 1) return 0

  const gapPx = getCompactRailGapPx(safeTotal)
  return (index - (safeTotal - 1) / 2) * gapPx
}

function getCompactRailMarkerTop(index: number, total: number): string {
  const offsetPx = getCompactRailMarkerOffsetPx(index, total)
  return `calc(50% + ${Number(offsetPx.toFixed(2))}px)`
}

function getCompactRailMarkerY(rect: DOMRect, index: number, total: number): number {
  return rect.top + rect.height / 2 + getCompactRailMarkerOffsetPx(index, total)
}

function formatLocatorTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function splitLocatorPreview(preview: string): { title: string; detail: string | null } {
  const normalized = preview.trim()
  if (normalized.length <= 30) return { title: normalized, detail: null }

  const sentenceEnd = normalized.search(/[。.!！?？]/)
  const splitOnSentence = sentenceEnd >= 12 && sentenceEnd <= 34
  const titleEnd = splitOnSentence ? sentenceEnd + 1 : Math.min(30, normalized.length)
  const title = normalized.slice(0, titleEnd).trim()
  const detail = normalized.slice(titleEnd).trim()

  return {
    title: !splitOnSentence && title.length < normalized.length ? `${title}...` : title,
    detail: detail || normalized
  }
}

function parseLocatorContent(rawContent: string): UnifiedMessage['content'] {
  try {
    const parsed = JSON.parse(rawContent)
    if (typeof parsed === 'string' || Array.isArray(parsed)) return parsed
  } catch {
    return rawContent
  }
  return ''
}

function parseLocatorMeta(rawMeta: string | null): UnifiedMessage['meta'] {
  if (!rawMeta) return undefined
  try {
    return JSON.parse(rawMeta) as UnifiedMessage['meta']
  } catch {
    return undefined
  }
}

function AssistantReplyRail({
  items,
  activeMessageIds,
  onJump
}: {
  items: AssistantReplyRailItem[]
  activeMessageIds: Set<string>
  onJump: (item: AssistantReplyRailItem) => void
}): React.JSX.Element | null {
  const { t } = useTranslation('chat')
  const [previewMessageId, setPreviewMessageId] = React.useState<string | null>(null)
  const [pointerPosition, setPointerPosition] = React.useState<{
    y: number
    railHeight: number
  } | null>(null)
  const pointerFrameRef = React.useRef<number | null>(null)
  const pendingPointerPositionRef = React.useRef<typeof pointerPosition>(null)
  const dense = items.length >= ASSISTANT_RAIL_DENSE_THRESHOLD

  const getNearestItem = React.useCallback(
    (clientY: number, target: HTMLElement): AssistantReplyRailItem | null => {
      if (items.length === 0) return null
      const rect = target.getBoundingClientRect()
      if (rect.height <= 0) return null
      let nearestItem = items[0]
      let nearestDistance = Number.POSITIVE_INFINITY
      for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
        const item = items[itemIndex]
        const markerY = getCompactRailMarkerY(rect, itemIndex, items.length)
        const distance = Math.abs(markerY - clientY)
        if (distance < nearestDistance) {
          nearestDistance = distance
          nearestItem = item
        }
      }
      return nearestItem
    },
    [items]
  )

  const schedulePointerPosition = React.useCallback((position: typeof pointerPosition) => {
    pendingPointerPositionRef.current = position
    if (pointerFrameRef.current !== null) return

    pointerFrameRef.current = window.requestAnimationFrame(() => {
      pointerFrameRef.current = null
      setPointerPosition(pendingPointerPositionRef.current)
    })
  }, [])

  React.useEffect(() => {
    return () => {
      if (pointerFrameRef.current !== null) {
        window.cancelAnimationFrame(pointerFrameRef.current)
      }
    }
  }, [])

  if (items.length < 2) return null

  const previewItem = previewMessageId
    ? (items.find((item) => item.id === previewMessageId) ?? null)
    : null
  const previewItemIndex = previewItem ? items.findIndex((item) => item.id === previewItem.id) : -1
  const previewCopy = previewItem ? splitLocatorPreview(previewItem.preview) : null
  const previewTop =
    previewItemIndex >= 0 ? getCompactRailMarkerTop(previewItemIndex, items.length) : '50%'

  const getMarkerWaveScale = (itemIndex: number): number => {
    if (!pointerPosition) return 1
    const markerY =
      pointerPosition.railHeight / 2 + getCompactRailMarkerOffsetPx(itemIndex, items.length)
    const distance = Math.abs(markerY - pointerPosition.y)
    const influenceRadius = Math.max(24, getCompactRailGapPx(items.length) * 4.5)
    if (distance >= influenceRadius) return 1

    const normalizedDistance = distance / influenceRadius
    const extension = 7 * Math.exp(-4 * normalizedDistance * normalizedDistance)
    return (12 + extension) / 12
  }

  const renderMarker = (
    item: AssistantReplyRailItem,
    itemIndex: number,
    previewing: boolean
  ): React.JSX.Element => {
    const active = activeMessageIds.has(item.id)
    return (
      <span
        className={cn(
          'block h-0.5 w-3 origin-left rounded-full transition-[color,background-color,opacity,transform] duration-100 ease-out will-change-transform',
          item.kind === 'summary'
            ? 'bg-amber-500/55'
            : item.kind === 'user'
              ? 'bg-primary/45'
              : item.kind === 'streaming'
                ? 'bg-primary/65'
                : 'bg-muted-foreground/35',
          item.kind === 'streaming' && 'animate-pulse',
          active ? 'bg-foreground/85 opacity-100' : 'opacity-65',
          previewing && 'bg-foreground/95 opacity-100'
        )}
        style={{ transform: `scaleX(${getMarkerWaveScale(itemIndex)})` }}
      />
    )
  }

  const getLabel = (item: AssistantReplyRailItem): string => {
    if (activeMessageIds.has(item.id)) {
      return t('messageList.assistantRail.currentLabel', {
        index: item.index,
        preview: item.preview,
        defaultValue: 'Current message {{index}}: {{preview}}'
      })
    }
    if (item.kind === 'user') {
      return t('messageList.assistantRail.userLabel', {
        index: item.index,
        preview: item.preview,
        defaultValue: 'Jump to user message {{index}}: {{preview}}'
      })
    }
    if (item.kind === 'streaming') {
      return t('messageList.assistantRail.streamingLabel', {
        index: item.index,
        preview: item.preview,
        defaultValue: 'Jump to streaming assistant reply {{index}}: {{preview}}'
      })
    }
    if (item.kind === 'summary') {
      return t('messageList.assistantRail.summaryLabel', {
        index: item.index,
        preview: item.preview,
        defaultValue: 'Jump to compressed history summary {{index}}: {{preview}}'
      })
    }
    return t('messageList.assistantRail.jumpLabel', {
      index: item.index,
      preview: item.preview,
      defaultValue: 'Jump to message {{index}}: {{preview}}'
    })
  }

  return (
    <div className="pointer-events-none absolute bottom-5 left-2 top-5 z-20 hidden md:block">
      <div className="pointer-events-none relative h-full w-[min(320px,calc(100vw-3rem))]">
        {previewItem && previewCopy ? (
          <div
            className="absolute left-7 w-[min(276px,calc(100vw-5rem))] -translate-y-1/2 animate-in fade-in-0 slide-in-from-left-1 duration-150"
            style={{ top: previewTop }}
          >
            <div className="overflow-hidden rounded-xl border border-border/70 bg-popover/95 px-3 py-2.5 text-popover-foreground shadow-xl backdrop-blur-xl">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    previewItem.kind === 'summary'
                      ? 'bg-amber-500/80'
                      : previewItem.kind === 'user'
                        ? 'bg-primary/80'
                        : previewItem.kind === 'streaming'
                          ? 'bg-primary/80'
                          : 'bg-muted-foreground/70'
                  )}
                />
                <div className="min-w-0 flex-1 line-clamp-1 text-[12px] font-semibold leading-5">
                  {previewCopy.title}
                </div>
              </div>
              {previewCopy.detail ? (
                <div className="mt-0.5 line-clamp-2 text-[11px] leading-[18px] text-muted-foreground">
                  {previewCopy.detail}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        <div
          className={cn(
            'pointer-events-auto absolute left-0 top-0 h-full w-6',
            dense && 'cursor-pointer'
          )}
          onPointerMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            schedulePointerPosition({
              y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
              railHeight: rect.height
            })
            if (dense) {
              const item = getNearestItem(event.clientY, event.currentTarget)
              setPreviewMessageId((prev) => (prev === item?.id ? prev : (item?.id ?? null)))
            }
          }}
          onPointerLeave={() => {
            pendingPointerPositionRef.current = null
            if (pointerFrameRef.current !== null) {
              window.cancelAnimationFrame(pointerFrameRef.current)
              pointerFrameRef.current = null
            }
            setPointerPosition(null)
            if (dense) setPreviewMessageId(null)
          }}
          onClick={
            dense
              ? (event) => {
                  const item = getNearestItem(event.clientY, event.currentTarget)
                  if (item) onJump(item)
                }
              : undefined
          }
        >
          {items.map((item, itemIndex) => {
            const previewing = previewMessageId === item.id
            return dense ? (
              <span
                key={item.id}
                className="absolute left-0 flex h-3 w-6 -translate-y-1/2 items-center justify-start"
                style={{ top: getCompactRailMarkerTop(itemIndex, items.length) }}
              >
                {renderMarker(item, itemIndex, previewing)}
              </span>
            ) : (
              <button
                key={item.id}
                type="button"
                aria-current={activeMessageIds.has(item.id) ? 'true' : undefined}
                aria-label={getLabel(item)}
                title={item.preview}
                className="pointer-events-auto group/assistant-marker absolute left-0 flex w-6 -translate-y-1/2 items-center justify-start rounded-sm outline-none"
                style={{
                  top: getCompactRailMarkerTop(itemIndex, items.length),
                  // Hit areas must tile without overlap: taller buttons would let the
                  // next (later-in-DOM) marker steal hover below each line.
                  height: getCompactRailGapPx(items.length)
                }}
                onPointerEnter={() => setPreviewMessageId(item.id)}
                onPointerLeave={() => setPreviewMessageId(null)}
                onFocus={() => setPreviewMessageId(item.id)}
                onBlur={() => setPreviewMessageId(null)}
                onClick={() => onJump(item)}
              >
                {renderMarker(item, itemIndex, previewing)}
              </button>
            )
          })}
        </div>

        {dense ? (
          <div className="sr-only">
            {items.map((item) => (
              <button
                key={`assistant-rail-keyboard-${item.id}`}
                type="button"
                aria-current={activeMessageIds.has(item.id) ? 'true' : undefined}
                aria-label={getLabel(item)}
                onFocus={() => setPreviewMessageId(item.id)}
                onBlur={() => setPreviewMessageId(null)}
                onClick={() => onJump(item)}
              >
                {item.preview}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

const MessageRow = React.memo(function MessageRow({
  message,
  sessionId,
  sessionAssistantMessageIds,
  sessionToolUseIds,
  isStreaming,
  isLastUserMessage,
  isLastAssistantMessage,
  showContinue,
  disableAnimation,
  toolResults,
  inlineCompactSummaries,
  orchestrationRun,
  hiddenToolUseIds,
  anchorMessageId,
  highlightMessageId,
  requestRetryState,
  renderMode,
  showChangeSummary = true,
  fullWidth = false,
  onRetry,
  onContinue,
  onEditUserMessage,
  onDeleteMessage
}: MessageRowProps): React.JSX.Element {
  const isAnchor = anchorMessageId === message.id
  const isHighlighted = highlightMessageId === message.id
  const messageToolUseIds = React.useMemo(() => getMessageToolUseIds(message), [message])

  return (
    <div
      data-message-id={message.id}
      data-anchor={isAnchor ? 'true' : undefined}
      className={`${getMessageColumnClass(fullWidth)} pb-7 transition-colors duration-500 ${
        isHighlighted ? 'rounded-md bg-primary/5 ring-1 ring-primary/20' : ''
      }`}
    >
      <MessageItem
        message={message}
        messageId={message.id}
        sessionId={sessionId}
        sessionAssistantMessageIds={sessionAssistantMessageIds}
        sessionToolUseIds={sessionToolUseIds}
        isStreaming={isStreaming}
        isLastUserMessage={isLastUserMessage}
        isLastAssistantMessage={isLastAssistantMessage}
        showContinue={showContinue}
        disableAnimation={disableAnimation}
        renderMode={renderMode}
        onRetryAssistantMessage={onRetry}
        onContinueAssistantMessage={onContinue}
        onEditUserMessage={onEditUserMessage}
        onDeleteMessage={onDeleteMessage}
        toolResults={toolResults}
        inlineCompactSummaries={inlineCompactSummaries}
        orchestrationRun={orchestrationRun}
        hiddenToolUseIds={hiddenToolUseIds}
        requestRetryState={requestRetryState}
      />
      {showChangeSummary && message.role === 'assistant' && !isStreaming && sessionId ? (
        <SessionChangeSummaryCard
          sessionId={sessionId}
          messageId={message.id}
          toolUseIds={messageToolUseIds}
        />
      ) : null}
    </div>
  )
}, areMessageRowPropsEqual)

export interface StaticMessageTranscriptProps {
  sessionId?: string | null
  messages: UnifiedMessage[]
  className?: string
}

export function StaticMessageTranscript({
  sessionId,
  messages,
  className
}: StaticMessageTranscriptProps): React.JSX.Element {
  const transcriptAnalysis = React.useMemo(
    () => buildTranscriptStaticAnalysis(messages),
    [messages]
  )
  const { messageLookup, toolResultsLookup } = transcriptAnalysis
  const duplicatePlanReviewToolUseIds = React.useMemo(
    () => collectDuplicatePlanReviewToolUseIds(messages, toolResultsLookup),
    [messages, toolResultsLookup]
  )
  const renderableMessages = React.useMemo(
    () => buildChatRenderableMessageMetaFromAnalysis(transcriptAnalysis, null, null),
    [transcriptAnalysis]
  )
  const inlineCompactSummaryState = React.useMemo(() => {
    const byAssistantId = new Map<string, UnifiedMessage[]>()
    const summaryIds = new Set<string>()
    const activeCompact = resolveActiveCompactArtifacts(messages)
    const activeSummaryId = activeCompact?.summaryId ?? null
    if (!activeSummaryId) return { byAssistantId, summaryIds }

    const summary = messages.find((message) => message.id === activeSummaryId)
    const anchor = summary?.meta?.compactSummary?.displayAnchor
    if (!summary || !anchor?.assistantMessageId) return { byAssistantId, summaryIds }

    const assistantExists = messages.some(
      (message) => message.id === anchor.assistantMessageId && message.role === 'assistant'
    )
    if (!assistantExists) return { byAssistantId, summaryIds }

    byAssistantId.set(anchor.assistantMessageId, [summary])
    summaryIds.add(summary.id)
    return { byAssistantId, summaryIds }
  }, [messages])
  const assistantChangeTargets = React.useMemo(
    () =>
      messages
        .filter((message) => message.role === 'assistant')
        .map((message) => ({
          messageId: message.id,
          toolUseIds: getMessageToolUseIds(message)
        })),
    [messages]
  )
  const sessionAssistantMessageIds = React.useMemo(
    () => assistantChangeTargets.map((target) => target.messageId),
    [assistantChangeTargets]
  )
  const sessionToolUseIds = React.useMemo(
    () => Array.from(new Set(assistantChangeTargets.flatMap((target) => target.toolUseIds))),
    [assistantChangeTargets]
  )
  const {
    activeSubAgents,
    completedSubAgents,
    subAgentHistory,
    hasOrchestrationData: hasAgentOrchestrationData
  } = useAgentStore((s) => selectSessionScopedAgentState(s, sessionId, { mode: 'coarse' }))
  const {
    activeTeam,
    teamHistory,
    hasOrchestrationData: hasTeamOrchestrationData
  } = useTeamStore((s) => selectSessionScopedTeamState(s, sessionId))
  const hasSessionOrchestrationData = hasAgentOrchestrationData || hasTeamOrchestrationData
  const orchestrationState = React.useMemo(
    () =>
      hasSessionOrchestrationData
        ? buildOrchestrationRuns({
            sessionId,
            messages,
            activeSubAgents,
            completedSubAgents,
            subAgentHistory,
            activeTeam,
            teamHistory
          })
        : EMPTY_ORCHESTRATION_STATE,
    [
      activeSubAgents,
      activeTeam,
      completedSubAgents,
      hasSessionOrchestrationData,
      messages,
      sessionId,
      subAgentHistory,
      teamHistory
    ]
  )

  return (
    <div className={className} data-message-content data-session-image-transcript>
      {renderableMessages
        .filter((row) => !inlineCompactSummaryState.summaryIds.has(row.messageId))
        .map((row) => {
          const message = messageLookup.get(row.messageId)
          if (!message) return null

          return (
            <MessageRow
              key={row.messageId}
              message={message}
              sessionId={sessionId}
              sessionAssistantMessageIds={sessionAssistantMessageIds}
              sessionToolUseIds={sessionToolUseIds}
              isStreaming={false}
              isLastUserMessage={row.isLastUserMessage}
              isLastAssistantMessage={row.isLastAssistantMessage}
              showContinue={false}
              disableAnimation
              toolResults={toolResultsLookup.get(row.messageId)}
              inlineCompactSummaries={inlineCompactSummaryState.byAssistantId.get(row.messageId)}
              orchestrationRun={
                orchestrationState.byMessageId.get(row.messageId)?.primaryRun ?? null
              }
              hiddenToolUseIds={mergeHiddenToolUseIds(
                orchestrationState.byMessageId.get(row.messageId)?.hiddenToolUseIds,
                duplicatePlanReviewToolUseIds
              )}
              anchorMessageId={null}
              highlightMessageId={null}
              renderMode="transcript"
              requestRetryState={null}
              showChangeSummary={false}
            />
          )
        })}
    </div>
  )
}

function MessageListInner(props: MessageListProps): React.JSX.Element {
  const {
    sessionId,
    onRetry,
    onContinue,
    onEditUserMessage,
    onDeleteMessage,
    exportAll = false,
    fullWidth = false
  } = props
  const { t } = useTranslation('chat')
  const animationsEnabled = useSettingsStore((s) => s.animationsEnabled)
  const currentActiveSessionId = useChatStore((s) => s.activeSessionId)
  const targetSessionId = sessionId ?? currentActiveSessionId
  const sessionSelection = useChatStore(
    useShallow((s) => selectMessageListSession(s, targetSessionId))
  )
  const {
    messages,
    messagesLoaded: activeSessionLoaded,
    messageCount: activeSessionMessageCount,
    workingFolder: activeWorkingFolder,
    loadedRangeStart,
    projectId: activeProjectId
  } = sessionSelection
  const activeProjectName = useChatStore((s) => {
    if (!activeProjectId) return null
    return s.projects.find((project) => project.id === activeProjectId)?.name ?? null
  })
  const streamingMessageId = useChatStore((s) =>
    targetSessionId ? (s.streamingMessages[targetSessionId] ?? null) : null
  )
  const activeSessionId = targetSessionId
  const isMainChatSession =
    !sessionId && Boolean(activeSessionId) && activeSessionId === currentActiveSessionId
  const isDetachedSessionView = Boolean(sessionId && activeSessionId)
  const mode = useUIStore((s) => s.mode)
  const hasStreamingMessage = useChatStore((s) =>
    activeSessionId ? Boolean(s.streamingMessages[activeSessionId]) : false
  )
  const {
    activeSubAgents,
    completedSubAgents,
    subAgentHistory,
    hasActiveToolCallOutput,
    isSessionRunning: isAgentSessionRunning,
    hasOrchestrationData: hasAgentOrchestrationData
  } = useAgentStore((s) => selectSessionScopedAgentState(s, activeSessionId, { mode: 'coarse' }))
  const primarySessionStatus = useAgentStore((s) =>
    activeSessionId ? (s.runningSessions[activeSessionId] ?? null) : null
  )
  const {
    activeTeam,
    teamHistory,
    isTeamRunning,
    hasOrchestrationData: hasTeamOrchestrationData
  } = useTeamStore((s) => selectSessionScopedTeamState(s, activeSessionId))
  const isPrimarySessionRunning =
    primarySessionStatus === 'running' || primarySessionStatus === 'retrying'
  const isAgentExecutionActive = isPrimarySessionRunning || isTeamRunning || hasStreamingMessage
  const isSessionRunning = isAgentSessionRunning || isTeamRunning || hasStreamingMessage
  const hasSessionOrchestrationData = React.useMemo(
    () => hasAgentOrchestrationData || hasTeamOrchestrationData,
    [hasAgentOrchestrationData, hasTeamOrchestrationData]
  )
  const sessionRequestRetryState = useAgentStore((s) =>
    activeSessionId ? (s.sessionRequestRetryState[activeSessionId] ?? null) : null
  )
  const isSessionOutputting = hasStreamingMessage || hasActiveToolCallOutput
  const canSessionTriggerStreamingAutoScroll =
    (isMainChatSession || isDetachedSessionView) && isSessionOutputting

  const transcriptAnalysis = React.useMemo(
    () => buildTranscriptStaticAnalysis(messages),
    [messages]
  )
  const {
    messageLookup,
    toolResultsLookup,
    tailToolExecutionState,
    orchestrationBindingSignature: orchestrationMessageBindingSignature
  } = transcriptAnalysis
  const duplicatePlanReviewToolUseIds = React.useMemo(
    () => collectDuplicatePlanReviewToolUseIds(messages, toolResultsLookup),
    [messages, toolResultsLookup]
  )
  const [orchestrationMessageSnapshot, setOrchestrationMessageSnapshot] = React.useState<{
    messages: UnifiedMessage[]
    bindingSignature: string
  }>(() => ({
    messages,
    bindingSignature: orchestrationMessageBindingSignature
  }))
  const useCurrentMessagesForOrchestration =
    (!streamingMessageId && !hasActiveToolCallOutput) ||
    orchestrationMessageSnapshot.bindingSignature !== orchestrationMessageBindingSignature
  const orchestrationMessages = useCurrentMessagesForOrchestration
    ? messages
    : orchestrationMessageSnapshot.messages

  React.useEffect(() => {
    if (!useCurrentMessagesForOrchestration) return
    setOrchestrationMessageSnapshot((previous) => {
      if (
        previous.messages === messages &&
        previous.bindingSignature === orchestrationMessageBindingSignature
      ) {
        return previous
      }
      return {
        messages,
        bindingSignature: orchestrationMessageBindingSignature
      }
    })
  }, [messages, orchestrationMessageBindingSignature, useCurrentMessagesForOrchestration])

  const listRef = React.useRef<HTMLDivElement | null>(null)
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const pendingInitialScrollSessionIdRef = React.useRef<string | null>(null)
  const autoScrollModeRef = React.useRef<AutoScrollMode>('off')
  const scheduledScrollFrameRef = React.useRef<number | null>(null)
  const scheduledAssistantRailSyncRef = React.useRef<number | null>(null)
  const highlightedMessageTimerRef = React.useRef<number | null>(null)
  const lastScrollOffsetRef = React.useRef(0)
  const programmaticScrollUntilRef = React.useRef(0)
  const wasSessionOutputtingRef = React.useRef(isSessionOutputting)
  const measuredMessageHeightsRef = React.useRef(new Map<string, number>())
  const [isAtBottom, setIsAtBottom] = React.useState(true)
  const [activeAssistantRailMessageIds, setActiveAssistantRailMessageIds] = React.useState<
    Set<string>
  >(() => new Set())
  const [highlightedMessageId, setHighlightedMessageId] = React.useState<string | null>(null)
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = React.useState(false)
  // Remembers a loadedRangeStart at which an older-message load made no progress
  // (e.g. during a running/compacting session the tail-trim immediately re-evicts
  // the head we just loaded). Prevents the auto-loader and scroll handler from
  // re-firing forever and leaving the "loading earlier messages" indicator stuck.
  const stalledOlderLoadStartRef = React.useRef<number | null>(null)
  const [assistantRailMeasureVersion, setAssistantRailMeasureVersion] = React.useState(0)
  const [messageLocatorSnapshot, setMessageLocatorSnapshot] = React.useState<{
    sessionId: string | null
    rows: MessageLocatorIndexRow[]
  }>({ sessionId: null, rows: EMPTY_MESSAGE_LOCATOR_ROWS })
  const messageLocatorRows =
    messageLocatorSnapshot.sessionId === activeSessionId
      ? messageLocatorSnapshot.rows
      : EMPTY_MESSAGE_LOCATOR_ROWS

  const orchestrationState = React.useMemo(
    () =>
      hasSessionOrchestrationData
        ? buildOrchestrationRuns({
            sessionId: activeSessionId,
            messages: orchestrationMessages,
            activeSubAgents,
            completedSubAgents,
            subAgentHistory,
            activeTeam,
            teamHistory
          })
        : EMPTY_ORCHESTRATION_STATE,
    [
      activeSessionId,
      activeSubAgents,
      activeTeam,
      completedSubAgents,
      hasSessionOrchestrationData,
      orchestrationMessages,
      subAgentHistory,
      teamHistory
    ]
  )

  const continueAssistantMessageId = React.useMemo(() => {
    if (streamingMessageId || isSessionRunning) return null
    if (!hasCompleteTailToolExecutionResults(tailToolExecutionState)) return null
    return tailToolExecutionState?.assistantMessageId ?? null
  }, [isSessionRunning, streamingMessageId, tailToolExecutionState])
  const renderableMessages = React.useMemo(
    () =>
      buildChatRenderableMessageMetaFromAnalysis(
        transcriptAnalysis,
        streamingMessageId,
        continueAssistantMessageId
      ),
    [continueAssistantMessageId, streamingMessageId, transcriptAnalysis]
  )
  const inlineCompactSummaryState = React.useMemo(() => {
    const byAssistantId = new Map<string, UnifiedMessage[]>()
    const summaryIds = new Set<string>()
    const activeCompact = resolveActiveCompactArtifacts(messages)
    const activeSummaryId = activeCompact?.summaryId ?? null
    if (!activeSummaryId) return { byAssistantId, summaryIds }

    const summary = messages.find((message) => message.id === activeSummaryId)
    const anchor = summary?.meta?.compactSummary?.displayAnchor
    if (!summary || !anchor?.assistantMessageId) return { byAssistantId, summaryIds }

    const assistantExists = messages.some(
      (message) => message.id === anchor.assistantMessageId && message.role === 'assistant'
    )
    if (!assistantExists) return { byAssistantId, summaryIds }

    byAssistantId.set(anchor.assistantMessageId, [summary])
    summaryIds.add(summary.id)
    return { byAssistantId, summaryIds }
  }, [messages])
  const assistantChangeTargets = React.useMemo(
    () =>
      messages
        .filter((message) => message.role === 'assistant')
        .map((message) => ({
          messageId: message.id,
          toolUseIds: getMessageToolUseIds(message)
        })),
    [messages]
  )
  const sessionAssistantMessageIds = React.useMemo(
    () => assistantChangeTargets.map((target) => target.messageId),
    [assistantChangeTargets]
  )
  const sessionToolUseIds = React.useMemo(
    () => Array.from(new Set(assistantChangeTargets.flatMap((target) => target.toolUseIds))),
    [assistantChangeTargets]
  )

  const messageLocatorSources = React.useMemo<MessageLocatorSource[]>(() => {
    const sourcesById = new Map<string, MessageLocatorSource>()
    for (const row of messageLocatorRows) {
      const source = parseLocatorRowSource(row)
      sourcesById.set(source.id, source)
    }

    messages.forEach((message, messageIndex) => {
      const existing = sourcesById.get(message.id)
      sourcesById.set(message.id, {
        id: message.id,
        role: message.role,
        content: message.content,
        meta: message.meta,
        createdAt: message.createdAt,
        sortOrder: existing?.sortOrder ?? loadedRangeStart + messageIndex,
        source: message.source
      })
    })

    return [...sourcesById.values()].sort((first, second) => {
      if (first.sortOrder !== second.sortOrder) return first.sortOrder - second.sortOrder
      return first.createdAt - second.createdAt
    })
  }, [loadedRangeStart, messageLocatorRows, messages])

  const hiddenAssistantRailCompactSummaryIds = React.useMemo(() => {
    const sourceIds = new Set(messageLocatorSources.map((source) => source.id))
    const hiddenIds = new Set(inlineCompactSummaryState.summaryIds)

    for (const source of messageLocatorSources) {
      const anchorId = source.meta?.compactSummary?.displayAnchor?.assistantMessageId
      if (anchorId && sourceIds.has(anchorId)) {
        hiddenIds.add(source.id)
      }
    }

    return hiddenIds
  }, [inlineCompactSummaryState.summaryIds, messageLocatorSources])

  const assistantRailLayout = React.useMemo<AssistantRailLayout>(() => {
    void assistantRailMeasureVersion
    return buildAssistantRailLayout({
      sources: messageLocatorSources,
      streamingMessageId,
      measuredHeights: measuredMessageHeightsRef.current,
      hiddenCompactSummaryIds: hiddenAssistantRailCompactSummaryIds,
      t
    })
  }, [
    assistantRailMeasureVersion,
    hiddenAssistantRailCompactSummaryIds,
    messageLocatorSources,
    streamingMessageId,
    t
  ])

  const assistantRailItems = assistantRailLayout.items
  const assistantRailItemById = React.useMemo(
    () => new Map(assistantRailItems.map((item) => [item.id, item])),
    [assistantRailItems]
  )

  React.useEffect(() => {
    let cancelled = false

    if (!activeSessionId) {
      setMessageLocatorSnapshot({
        sessionId: null,
        rows: EMPTY_MESSAGE_LOCATOR_ROWS
      })
      return
    }

    const loadMessageLocatorRows = async (): Promise<void> => {
      try {
        const rows = await invokeMessagePackBinary<MessageLocatorIndexRow[] | null>(
          DB_MESSAGES_LIST_LOCATOR_MSGPACK_CHANNEL,
          activeSessionId
        )
        if (!cancelled) {
          setMessageLocatorSnapshot({
            sessionId: activeSessionId,
            rows: Array.isArray(rows) ? rows : EMPTY_MESSAGE_LOCATOR_ROWS
          })
        }
      } catch (err) {
        console.error('[MessageList] Failed to load message locator rows:', err)
        if (!cancelled) {
          setMessageLocatorSnapshot({
            sessionId: activeSessionId,
            rows: EMPTY_MESSAGE_LOCATOR_ROWS
          })
        }
      }
    }

    void loadMessageLocatorRows()

    return () => {
      cancelled = true
    }
  }, [activeSessionId, activeSessionMessageCount])

  const rows = React.useMemo<MessageListRow[]>(() => {
    return renderableMessages
      .filter((message) => !inlineCompactSummaryState.summaryIds.has(message.messageId))
      .map<MessageListRow>((message) => ({
        type: 'message',
        key: message.messageId,
        data: message
      }))
  }, [inlineCompactSummaryState.summaryIds, renderableMessages])
  const hasLoadOlderRow = loadedRangeStart > 0
  const virtualRowCount = rows.length + (hasLoadOlderRow ? 1 : 0)

  const canAutoScroll = React.useCallback(() => {
    const mode = autoScrollModeRef.current
    return (
      mode === 'user' || (mode === 'stream' && canSessionTriggerStreamingAutoScroll && isAtBottom)
    )
  }, [canSessionTriggerStreamingAutoScroll, isAtBottom])

  // ---------------------------------------------------------------------------
  // 【临时修复 / Temporary workaround · 2026-07-10】
  //
  // 背景：
  // MessageList 用 @tanstack/react-virtual 把「整条 assistant 消息」当成一行。
  // 用户在消息中部展开「工具调用」时，只是行内高度变大，但库默认会走
  // resizeItem → applyScrollAdjustment：只要该行 start 在视口上方，就
  // scrollTop += 整段高度差，导致点击位置被顶走。
  //
  // 官方原因：
  // TanStack Virtual 默认补偿策略面向「普通列表行」：视口上方行变高时补 scroll，
  // 避免历史列表量高后视口内容漂移。聊天场景（一行=整条消息、行内折叠展开）
  // 默认语义不合适——可见行内部变高时，用户期望视口钉住、内容向下长。
  //
  // 社区同类反馈（仍 open）：
  // https://github.com/TanStack/virtual/issues/1218
  // 「applyScrollAdjustment causes chat stream viewport to drift downward when
  //  a visible streaming item keeps growing」
  // 结论与本场景一致：可见内容自己长高时，不补偿更稳；补偿会把视口拖跑。
  //
  // 本钩子是官方预留的策略入口（非业务侧 scrollTop 补丁）：
  // shouldAdjustScrollPositionOnItemSizeChange
  //
  // 策略：
  // 1) 正在 stick-to-bottom 跟随 → 不让 virtualizer 抢滚动（贴底仍走下方逻辑）
  // 2) 自由浏览时，仅当「整行完全在视口上方」才补偿
  // 3) 行与视口相交（中部展开工具调用）→ 不补偿，列表位置保持不动
  //
  // 后续维护：
  // 若官方默认策略/聊天示例修好了 #1218（或提供 chat 专用 anchor 模式），
  // 评估后可删除本回调，恢复库默认行为。删除前请对照 issue 与手测：
  // 中部展开/收起工具调用、流式贴底、加载更早消息。
  // ---------------------------------------------------------------------------
  const shouldAdjustScrollPositionOnItemSizeChange = React.useCallback(
    (item: { end: number }, _delta: number, instance: { scrollOffset: number | null }): boolean => {
      if (canAutoScroll()) return false
      const scrollOffset = instance.scrollOffset ?? 0
      return item.end < scrollOffset
    },
    [canAutoScroll]
  )

  const rowVirtualizer = useVirtualizer({
    count: virtualRowCount,
    getScrollElement: () => listRef.current,
    estimateSize: () => VIRTUAL_ROW_ESTIMATED_HEIGHT,
    overscan: VIRTUAL_ROW_OVERSCAN,
    getItemKey: (index) => {
      if (hasLoadOlderRow && index === 0) return `load-older:${activeSessionId ?? 'none'}`
      const row = rows[index - (hasLoadOlderRow ? 1 : 0)]
      return row?.key ?? `row:${index}`
    }
  })
  // 当前 @tanstack/react-virtual@3.14.5 的 VirtualizerOptions 类型未暴露该钩子，
  // 但 virtual-core 实例属性存在且 resizeItem 会读它。必须挂到实例上，不能塞进 options
  //（options 路径 TS 报错且运行时也不会赋到 this.shouldAdjust...）。
  rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange =
    shouldAdjustScrollPositionOnItemSizeChange
  const pendingAskUserQuestion = React.useMemo(
    () => findPendingAskUserQuestion(rows, toolResultsLookup, messageLookup),
    [messageLookup, rows, toolResultsLookup]
  )
  const isAwaitingInitialMessages =
    Boolean(activeSessionId) &&
    messages.length === 0 &&
    (!activeSessionLoaded || activeSessionMessageCount > 0 || loadedRangeStart > 0)

  const lastMessageRowIndex = rows.length - 1

  const markProgrammaticScroll = React.useCallback(() => {
    programmaticScrollUntilRef.current = window.performance.now() + PROGRAMMATIC_SCROLL_GUARD_MS
  }, [])

  const scrollToBottomImmediate = React.useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      const ref = listRef.current
      if (!ref || rows.length === 0) return
      markProgrammaticScroll()
      ref.scrollTo({ top: ref.scrollHeight, behavior })
    },
    [markProgrammaticScroll, rows.length]
  )

  const syncBottomState = React.useCallback(() => {
    const ref = listRef.current
    if (!ref) return

    const distanceToBottom = getDistanceToBottom(ref)
    const threshold = isSessionOutputting
      ? STREAMING_AUTO_SCROLL_BOTTOM_THRESHOLD
      : AUTO_SCROLL_BOTTOM_THRESHOLD
    const previousOffset = lastScrollOffsetRef.current
    const currentOffset = ref.scrollTop
    const scrolledUp = currentOffset < previousOffset - BOTTOM_SCROLL_CORRECTION_EPSILON
    const isProgrammaticScroll = window.performance.now() < programmaticScrollUntilRef.current

    lastScrollOffsetRef.current = currentOffset

    // While streaming, keep the wider escape distance so minor jitter does not
    // detach the follow mode; when idle, any deliberate upward scroll releases it.
    const followReleaseThreshold = isSessionOutputting
      ? STREAMING_AUTO_SCROLL_STOP_THRESHOLD
      : threshold
    if (scrolledUp && distanceToBottom > followReleaseThreshold && !isProgrammaticScroll) {
      autoScrollModeRef.current = 'off'
      setIsAtBottom(false)
      return
    }

    const physicallyAtBottom = distanceToBottom <= threshold
    if (physicallyAtBottom && isSessionOutputting && autoScrollModeRef.current === 'off') {
      autoScrollModeRef.current = 'stream'
    }

    const nextAtBottom =
      physicallyAtBottom || (isSessionOutputting && autoScrollModeRef.current === 'stream')

    setIsAtBottom((prev) => (prev === nextAtBottom ? prev : nextAtBottom))
  }, [isSessionOutputting])

  const measureVisibleMessageHeights = React.useCallback(() => {
    const ref = listRef.current
    if (!ref) return false

    let changed = false
    for (const element of ref.querySelectorAll<HTMLElement>('[data-message-id]')) {
      const messageId = element.dataset.messageId
      if (!messageId) continue
      const height = element.offsetHeight
      if (height <= 0) continue
      const previous = measuredMessageHeightsRef.current.get(messageId)
      if (previous === undefined || Math.abs(previous - height) > 2) {
        measuredMessageHeightsRef.current.set(messageId, height)
        changed = true
      }
    }

    return changed
  }, [])

  const setActiveAssistantRailIds = React.useCallback((nextIds: Set<string>) => {
    setActiveAssistantRailMessageIds((previousIds) =>
      areStringSetsEqual(previousIds, nextIds) ? previousIds : nextIds
    )
  }, [])

  const syncActiveAssistantRail = React.useCallback(() => {
    const ref = listRef.current
    if (!ref || assistantRailItems.length === 0 || assistantRailLayout.rows.length === 0) {
      setActiveAssistantRailIds(new Set())
      return
    }

    const didMeasure = measureVisibleMessageHeights()
    if (didMeasure) {
      setAssistantRailMeasureVersion((version) => version + 1)
    }

    const containerRect = ref.getBoundingClientRect()
    const nextActiveIds = new Set<string>()

    for (const element of ref.querySelectorAll<HTMLElement>('[data-message-id]')) {
      const messageId = element.dataset.messageId
      if (!messageId) continue
      if (!assistantRailItemById.has(messageId)) continue
      const rect = element.getBoundingClientRect()
      if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom) continue
      nextActiveIds.add(messageId)
    }

    setActiveAssistantRailIds(nextActiveIds)
  }, [
    assistantRailItemById,
    assistantRailItems,
    assistantRailLayout,
    measureVisibleMessageHeights,
    setActiveAssistantRailIds
  ])

  const requestAssistantRailSync = React.useCallback(() => {
    if (scheduledAssistantRailSyncRef.current !== null) return
    scheduledAssistantRailSyncRef.current = window.requestAnimationFrame(() => {
      scheduledAssistantRailSyncRef.current = null
      syncActiveAssistantRail()
    })
  }, [syncActiveAssistantRail])

  const handleJumpToAssistantMessage = React.useCallback(
    async (item: AssistantReplyRailItem): Promise<void> => {
      const messageId = item.id
      autoScrollModeRef.current = 'off'
      setIsAtBottom(false)

      const setHighlightTimer = (): void => {
        setHighlightedMessageId(messageId)
        if (highlightedMessageTimerRef.current !== null) {
          window.clearTimeout(highlightedMessageTimerRef.current)
        }
        highlightedMessageTimerRef.current = window.setTimeout(() => {
          setHighlightedMessageId((prev) => (prev === messageId ? null : prev))
          highlightedMessageTimerRef.current = null
        }, USER_LOCATOR_HIGHLIGHT_MS)
      }

      const scrollToTarget = (behavior: ScrollBehavior = 'smooth'): boolean => {
        const ref = listRef.current
        if (!ref) return false

        const target = Array.from(ref.querySelectorAll<HTMLElement>('[data-message-id]')).find(
          (element) => element.dataset.messageId === messageId
        )
        if (!target) return false

        markProgrammaticScroll()
        setActiveAssistantRailIds(new Set([messageId]))
        setHighlightTimer()
        // offsetTop is relative to the absolutely-positioned virtual row wrapper and
        // ignores its translateY, so derive the real position from bounding rects.
        const targetTop =
          ref.scrollTop + (target.getBoundingClientRect().top - ref.getBoundingClientRect().top)
        ref.scrollTo({
          top: Math.max(0, targetTop - ASSISTANT_RAIL_SCROLL_OFFSET),
          behavior
        })
        requestAssistantRailSync()
        return true
      }

      if (scrollToTarget()) return
      if (!activeSessionId) return

      await useChatStore
        .getState()
        .loadMessageWindowAround(activeSessionId, { messageId, sortOrder: item.sortOrder }, 30)

      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => resolve())
        })
      })

      if (scrollToTarget()) return

      const chatState = useChatStore.getState()
      const targetIndex = chatState
        .getSessionMessages(activeSessionId)
        .findIndex((message) => message.id === messageId)
      if (targetIndex >= 0) {
        const targetSession = chatState.sessions.find((session) => session.id === activeSessionId)
        rowVirtualizer.scrollToIndex(
          targetIndex + ((targetSession?.loadedRangeStart ?? 0) > 0 ? 1 : 0),
          { align: 'center' }
        )
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve())
        })
        scrollToTarget('auto')
      }
    },
    [
      activeSessionId,
      markProgrammaticScroll,
      requestAssistantRailSync,
      rowVirtualizer,
      setActiveAssistantRailIds
    ]
  )

  const loadOlderMessages = React.useCallback(
    async (preserveResidentHistory = false): Promise<number> => {
      if (!activeSessionId || isLoadingOlderMessages || loadedRangeStart <= 0) return 0

      const ref = listRef.current
      const previousScrollHeight = ref?.scrollHeight ?? 0
      const previousScrollTop = ref?.scrollTop ?? 0

      const startBefore = loadedRangeStart
      autoScrollModeRef.current = 'off'
      setIsLoadingOlderMessages(true)
      try {
        const loaded = await useChatStore
          .getState()
          .loadOlderSessionMessages(activeSessionId, undefined, { preserveResidentHistory })
        // loadOlderSessionMessages reports the rows it read from the DB, but a
        // running session's tail-trim can splice those same rows straight back off
        // (getMessageWindowPreserveMode forces 'tail' while running). Treat "the
        // window didn't actually grow older" as a stall so callers stop retrying.
        const startAfter =
          useChatStore.getState().sessions.find((s) => s.id === activeSessionId)
            ?.loadedRangeStart ?? startBefore
        if (loaded <= 0 || startAfter >= startBefore) {
          stalledOlderLoadStartRef.current = startBefore
          return loaded > 0 ? loaded : 0
        }
        stalledOlderLoadStartRef.current = null

        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => resolve())
          })
        })

        const nextRef = listRef.current
        if (nextRef) {
          const scrollDelta = nextRef.scrollHeight - previousScrollHeight
          if (scrollDelta !== 0) {
            markProgrammaticScroll()
            nextRef.scrollTop = Math.max(0, previousScrollTop + scrollDelta)
          }
        }
        syncBottomState()
        requestAssistantRailSync()
        return loaded
      } finally {
        setIsLoadingOlderMessages(false)
      }
    },
    [
      activeSessionId,
      isLoadingOlderMessages,
      loadedRangeStart,
      markProgrammaticScroll,
      requestAssistantRailSync,
      syncBottomState
    ]
  )

  const requestScrollToBottom = React.useCallback(
    ({
      behavior = 'auto',
      force = false,
      maxFrames = 1
    }: {
      behavior?: ScrollBehavior
      force?: boolean
      maxFrames?: number
    } = {}) => {
      if (scheduledScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scheduledScrollFrameRef.current)
      }

      let framesLeft = Math.max(1, maxFrames)
      const run = (): void => {
        scheduledScrollFrameRef.current = null
        const ref = listRef.current
        if (!ref) return
        if (!force && !canAutoScroll()) return

        if (force || getDistanceToBottom(ref) > AUTO_SCROLL_MIN_DELTA) {
          scrollToBottomImmediate(behavior)
        }
        framesLeft -= 1
        if (framesLeft > 0) {
          scheduledScrollFrameRef.current = window.requestAnimationFrame(run)
          return
        }
        syncBottomState()
      }

      scheduledScrollFrameRef.current = window.requestAnimationFrame(run)
    },
    [canAutoScroll, scrollToBottomImmediate, syncBottomState]
  )

  React.useEffect(() => {
    if (!canSessionTriggerStreamingAutoScroll) return
    if (pendingAskUserQuestion) return

    const intervalId = window.setInterval(() => {
      if (!canAutoScroll()) return
      requestScrollToBottom({ maxFrames: FOLLOW_BOTTOM_SETTLE_FRAMES })
    }, STREAMING_AUTO_SCROLL_POLL_MS)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [
    canAutoScroll,
    canSessionTriggerStreamingAutoScroll,
    pendingAskUserQuestion,
    requestScrollToBottom
  ])

  const handleListScroll = React.useCallback(() => {
    syncBottomState()
    requestAssistantRailSync()
    const ref = listRef.current
    if (
      ref &&
      !isLoadingOlderMessages &&
      loadedRangeStart > 0 &&
      stalledOlderLoadStartRef.current !== loadedRangeStart &&
      ref.scrollTop <= OLDER_MESSAGE_LOAD_SCROLL_THRESHOLD
    ) {
      void loadOlderMessages()
    }
  }, [
    isLoadingOlderMessages,
    loadOlderMessages,
    loadedRangeStart,
    requestAssistantRailSync,
    syncBottomState
  ])

  React.useEffect(() => {
    if (!activeSessionId) return
    void useChatStore.getState().loadRecentSessionMessages(activeSessionId)
  }, [activeSessionId])

  React.useEffect(() => {
    if (!activeSessionId || !streamingMessageId) return

    const hasStreamingMessageInView = messages.some((message) => message.id === streamingMessageId)
    if (hasStreamingMessageInView) return

    void useChatStore.getState().loadRecentSessionMessages(activeSessionId, true)
  }, [activeSessionId, messages, streamingMessageId])

  React.useLayoutEffect(() => {
    pendingInitialScrollSessionIdRef.current = activeSessionId
    lastScrollOffsetRef.current = 0
    programmaticScrollUntilRef.current = 0
    measuredMessageHeightsRef.current.clear()
    stalledOlderLoadStartRef.current = null
    setAssistantRailMeasureVersion((version) => version + 1)
    setActiveAssistantRailIds(new Set())
  }, [activeSessionId, setActiveAssistantRailIds])

  React.useLayoutEffect(() => {
    if (!activeSessionId) return
    if (pendingInitialScrollSessionIdRef.current !== activeSessionId) return
    if (!(messages.length > 0 || streamingMessageId)) return

    // Enter a follow mode on open so the bottom anchor below keeps re-pinning
    // while virtualized rows are measured; released on the first upward scroll.
    autoScrollModeRef.current = isSessionOutputting ? 'stream' : 'user'
    requestScrollToBottom({ force: true, maxFrames: INITIAL_SCROLL_SETTLE_FRAMES })

    pendingInitialScrollSessionIdRef.current = null
  }, [
    activeSessionId,
    isSessionOutputting,
    messages.length,
    requestScrollToBottom,
    streamingMessageId
  ])

  React.useEffect(() => {
    const wasOutputting = wasSessionOutputtingRef.current
    if (!wasOutputting && isSessionOutputting && isAtBottom && !pendingAskUserQuestion) {
      autoScrollModeRef.current = 'stream'
    } else if (wasOutputting && !isSessionOutputting && autoScrollModeRef.current === 'stream') {
      autoScrollModeRef.current = 'off'
    }
    wasSessionOutputtingRef.current = isSessionOutputting
  }, [isAtBottom, isSessionOutputting, pendingAskUserQuestion])

  React.useEffect(() => {
    if (pendingAskUserQuestion) return
    if (!canAutoScroll()) return
    requestScrollToBottom({ maxFrames: FOLLOW_BOTTOM_SETTLE_FRAMES })
  }, [canAutoScroll, pendingAskUserQuestion, requestScrollToBottom, rows.length])

  // Bottom anchor: rows are virtualized with estimated heights, so a single
  // scroll-to-bottom lands short once the real (larger) row heights are
  // measured and the total size grows. Re-pin whenever the measured total size
  // changes while we are following the bottom, until measurement converges.
  const virtualListTotalSize = rowVirtualizer.getTotalSize()
  React.useEffect(() => {
    if (pendingAskUserQuestion) return
    if (!canAutoScroll() && !isAtBottom) return
    requestScrollToBottom({ force: true, maxFrames: FOLLOW_BOTTOM_SETTLE_FRAMES })
  }, [
    canAutoScroll,
    isAtBottom,
    pendingAskUserQuestion,
    requestScrollToBottom,
    virtualListTotalSize
  ])

  React.useEffect(() => {
    if (!activeSessionId || isAwaitingInitialMessages || isLoadingOlderMessages) return
    if (loadedRangeStart <= 0 || renderableMessages.length >= MIN_RENDERABLE_HISTORY_ROWS) return
    // A previous auto-load at this exact position already failed to grow the
    // renderable window (all-hidden older page, or a running session's tail-trim
    // undoing the load). Stop hammering — real progress moves loadedRangeStart,
    // which re-arms this guard.
    if (stalledOlderLoadStartRef.current === loadedRangeStart) return
    void loadOlderMessages()
  }, [
    activeSessionId,
    isAwaitingInitialMessages,
    isLoadingOlderMessages,
    loadOlderMessages,
    loadedRangeStart,
    renderableMessages.length
  ])

  React.useEffect(() => {
    requestAssistantRailSync()
  }, [requestAssistantRailSync])

  React.useEffect(() => {
    return () => {
      if (scheduledScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scheduledScrollFrameRef.current)
      }
      if (scheduledAssistantRailSyncRef.current !== null) {
        window.cancelAnimationFrame(scheduledAssistantRailSyncRef.current)
      }
      if (highlightedMessageTimerRef.current !== null) {
        window.clearTimeout(highlightedMessageTimerRef.current)
      }
    }
  }, [])

  const scrollToBottom = React.useCallback(() => {
    autoScrollModeRef.current = 'user'
    setIsAtBottom(true)
    requestScrollToBottom({ behavior: 'smooth', force: true })
  }, [requestScrollToBottom])

  const applySuggestedPrompt = React.useCallback((prompt: string) => {
    const textarea = document.querySelector('textarea')
    if (textarea instanceof window.HTMLTextAreaElement) {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      )?.set
      nativeInputValueSetter?.call(textarea, prompt)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea.focus()
      return
    }

    const editor = document.querySelector('[role="textbox"][contenteditable="true"]')
    if (editor instanceof HTMLDivElement) {
      editor.replaceChildren(document.createTextNode(prompt))
      editor.dispatchEvent(new Event('input', { bubbles: true }))
      editor.focus()
    }
  }, [])

  if (isAwaitingInitialMessages) {
    return (
      <div className="flex flex-1 flex-col gap-4 overflow-hidden px-4 pt-6">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className={`${getMessageColumnClass(fullWidth)} space-y-2 ${
              index % 2 === 0 ? 'self-start' : 'self-end'
            }`}
          >
            <div className="h-3 w-3/5 animate-pulse rounded-md bg-muted/50" />
            <div className="h-3 w-4/5 animate-pulse rounded-md bg-muted/40" />
            <div className="h-3 w-1/2 animate-pulse rounded-md bg-muted/30" />
          </div>
        ))}
      </div>
    )
  }

  if (messages.length === 0) {
    const hint = modeHints[mode]
    const projectScoped = Boolean(activeProjectId)
    const emptyTitle = projectScoped
      ? `What should we build in ${activeProjectName ?? 'this project'}?`
      : mode === 'chat'
        ? 'What should we talk through?'
        : t(hint.titleKey)
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <div
          className={`flex flex-col items-center gap-3 ${getMessageColumnCompactClass(fullWidth)}`}
        >
          <div>
            <p className="text-[18px] font-semibold tracking-tight text-foreground/92 sm:text-[19px]">
              {emptyTitle}
            </p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground/70 sm:text-[14px]">
              {projectScoped ? t('messageList.startCodingDesc') : t(hint.descKey)}
            </p>
          </div>
        </div>

        <div className="mt-6 flex max-w-[520px] flex-wrap justify-center gap-2">
          {(mode === 'chat'
            ? [
                t('messageList.explainAsync'),
                t('messageList.compareRest'),
                t('messageList.writeRegex')
              ]
            : activeWorkingFolder
              ? [
                  t('messageList.summarizeProject'),
                  t('messageList.findBugs'),
                  t('messageList.addErrorHandling')
                ]
              : [
                  t('messageList.reviewCodebase'),
                  t('messageList.addTests'),
                  t('messageList.refactorError')
                ]
          ).map((prompt) => (
            <button
              key={prompt}
              className="rounded-md border border-border/60 bg-background/50 px-3 py-1.5 text-[11px] text-muted-foreground/70 transition-colors hover:bg-muted/50 hover:text-foreground"
              onClick={() => applySuggestedPrompt(prompt)}
            >
              {prompt}
            </button>
          ))}
        </div>
      </div>
    )
  }

  if (exportAll) {
    return (
      <div ref={containerRef} className="relative flex-1" data-message-list>
        <div data-message-content>
          {renderableMessages.map((row) => {
            const message = messageLookup.get(row.messageId)
            if (!message) return null

            return (
              <MessageRow
                key={row.messageId}
                message={message}
                sessionId={targetSessionId}
                sessionAssistantMessageIds={sessionAssistantMessageIds}
                sessionToolUseIds={sessionToolUseIds}
                isStreaming={streamingMessageId === row.messageId}
                isLastUserMessage={row.isLastUserMessage}
                isLastAssistantMessage={row.isLastAssistantMessage}
                showContinue={row.showContinue}
                disableAnimation
                toolResults={toolResultsLookup.get(row.messageId)}
                inlineCompactSummaries={inlineCompactSummaryState.byAssistantId.get(row.messageId)}
                orchestrationRun={
                  orchestrationState.byMessageId.get(row.messageId)?.primaryRun ?? null
                }
                hiddenToolUseIds={mergeHiddenToolUseIds(
                  orchestrationState.byMessageId.get(row.messageId)?.hiddenToolUseIds,
                  duplicatePlanReviewToolUseIds
                )}
                anchorMessageId={null}
                highlightMessageId={null}
                requestRetryState={
                  row.isLastAssistantMessage ? (sessionRequestRetryState ?? null) : null
                }
                fullWidth={fullWidth}
                onRetry={onRetry}
                onContinue={onContinue}
                onEditUserMessage={onEditUserMessage}
                onDeleteMessage={onDeleteMessage}
              />
            )
          })}
        </div>
      </div>
    )
  }

  const messageListContent = (
    <div ref={containerRef} className="relative flex-1" data-message-list>
      <div
        ref={listRef}
        className="absolute inset-0 overflow-y-auto pl-7 md:pl-9"
        data-message-content
        style={{ overflowAnchor: 'none' }}
        onScroll={handleListScroll}
      >
        <div className="relative w-full" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const isLoadOlderRow = hasLoadOlderRow && virtualRow.index === 0
            const rowIndex = virtualRow.index - (hasLoadOlderRow ? 1 : 0)

            return (
              <div
                key={virtualRow.key}
                ref={rowVirtualizer.measureElement}
                data-index={virtualRow.index}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {isLoadOlderRow ? (
                  <div
                    className={`${getMessageColumnClass(fullWidth)} flex justify-center pb-3 pt-3`}
                  >
                    <button
                      type="button"
                      className="rounded-full border border-border/70 bg-background/92 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:text-foreground disabled:cursor-wait disabled:opacity-70"
                      onClick={() => void loadOlderMessages(true)}
                      disabled={isLoadingOlderMessages}
                    >
                      {isLoadingOlderMessages
                        ? t('messageList.loadingOlder')
                        : t('messageList.loadOlder', { count: loadedRangeStart })}
                    </button>
                  </div>
                ) : (
                  (() => {
                    const row = rows[rowIndex]
                    if (!row) return null

                    const liveCutoffIndex = Math.max(
                      0,
                      lastMessageRowIndex - TAIL_LIVE_MESSAGE_COUNT
                    )
                    const disableAnimation =
                      lastMessageRowIndex >= 0
                        ? rowIndex >=
                          Math.max(0, lastMessageRowIndex - (TAIL_STATIC_MESSAGE_COUNT - 1))
                        : false

                    const { messageId, isLastUserMessage, isLastAssistantMessage, showContinue } =
                      row.data
                    const message = messageLookup.get(messageId)
                    if (!message) return null

                    const isEmptyAssistantLoading =
                      isLastAssistantMessage &&
                      isAgentExecutionActive &&
                      hasEmptyAssistantContent(message)
                    const isStreaming = streamingMessageId === messageId || isEmptyAssistantLoading
                    const rowRenderMode =
                      !isStreaming && rowIndex < liveCutoffIndex ? 'static' : undefined

                    return (
                      <MessageRow
                        message={message}
                        sessionId={targetSessionId}
                        sessionAssistantMessageIds={sessionAssistantMessageIds}
                        sessionToolUseIds={sessionToolUseIds}
                        isStreaming={isStreaming}
                        isLastUserMessage={isLastUserMessage}
                        isLastAssistantMessage={isLastAssistantMessage}
                        showContinue={showContinue}
                        disableAnimation={disableAnimation}
                        toolResults={toolResultsLookup.get(messageId)}
                        inlineCompactSummaries={inlineCompactSummaryState.byAssistantId.get(
                          messageId
                        )}
                        orchestrationRun={
                          orchestrationState.byMessageId.get(messageId)?.primaryRun ?? null
                        }
                        hiddenToolUseIds={mergeHiddenToolUseIds(
                          orchestrationState.byMessageId.get(messageId)?.hiddenToolUseIds,
                          duplicatePlanReviewToolUseIds
                        )}
                        anchorMessageId={null}
                        highlightMessageId={highlightedMessageId}
                        renderMode={rowRenderMode}
                        requestRetryState={
                          isLastAssistantMessage ? (sessionRequestRetryState ?? null) : null
                        }
                        fullWidth={fullWidth}
                        onRetry={onRetry}
                        onContinue={onContinue}
                        onEditUserMessage={onEditUserMessage}
                        onDeleteMessage={onDeleteMessage}
                      />
                    )
                  })()
                )}
              </div>
            )
          })}
        </div>
      </div>

      <AssistantReplyRail
        items={assistantRailItems}
        activeMessageIds={activeAssistantRailMessageIds}
        onJump={handleJumpToAssistantMessage}
      />

      <AnimatePresence>
        {!isAtBottom && messages.length > 0 && (
          <motion.div
            key="scroll-to-bottom"
            className="absolute bottom-4 left-1/2 z-10"
            initial={animationsEnabled ? { opacity: 0, scale: 0.9, y: 4, x: '-50%' } : false}
            animate={{ opacity: 1, scale: 1, y: 0, x: '-50%' }}
            exit={animationsEnabled ? { opacity: 0, scale: 0.9, y: 4, x: '-50%' } : undefined}
            transition={animationsEnabled ? { duration: 0.15, ease: 'easeOut' } : { duration: 0 }}
          >
            <button
              onClick={scrollToBottom}
              className="flex items-center gap-1.5 rounded-full border bg-background/90 px-3 py-1.5 text-xs text-muted-foreground shadow-lg backdrop-blur-sm transition-all duration-200 hover:-translate-y-0.5 hover:text-foreground hover:shadow-xl"
            >
              <ArrowDown className="size-3" />
              {t('messageList.scrollToBottom')}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )

  return isStreamingPerfEnabled() ? (
    <React.Profiler
      id="MessageList"
      onRender={(_id, phase, actualDuration, baseDuration) => {
        recordStreamingReactCommit(actualDuration, { phase, baseDuration })
      }}
    >
      {messageListContent}
    </React.Profiler>
  ) : (
    messageListContent
  )
}

function areMessageListPropsEqual(prev: MessageListProps, next: MessageListProps): boolean {
  return (
    prev.sessionId === next.sessionId &&
    prev.onRetry === next.onRetry &&
    prev.onContinue === next.onContinue &&
    prev.onEditUserMessage === next.onEditUserMessage &&
    prev.onDeleteMessage === next.onDeleteMessage &&
    prev.exportAll === next.exportAll &&
    prev.fullWidth === next.fullWidth
  )
}

export const MessageList = React.memo(MessageListInner, areMessageListPropsEqual)
