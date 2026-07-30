import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useShallow } from 'zustand/react/shallow'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
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
type MessageWindowPhase = 'loading' | 'positioning' | 'ready' | 'error'

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
  messageIds: string[]
  index: number
  preview: string
  detail: string | null
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
const TAIL_STATIC_MESSAGE_COUNT = 4
const TAIL_LIVE_MESSAGE_COUNT = 6
const FOLLOW_BOTTOM_SETTLE_FRAMES = 3
const BOTTOM_SCROLL_CORRECTION_EPSILON = 2
const AUTO_SCROLL_MIN_DELTA = 24
const PROGRAMMATIC_SCROLL_GUARD_MS = 160
const STREAMING_AUTO_SCROLL_POLL_MS = 500
const ASSISTANT_RAIL_PREVIEW_LIMIT = 120
const ASSISTANT_RAIL_HEIGHT_PX = 420
const ASSISTANT_RAIL_MARKER_HEIGHT_PX = 2
const ASSISTANT_RAIL_MARKER_WIDTH_PX = 6
const ASSISTANT_RAIL_MARKER_PITCH_PX = 9
const ASSISTANT_RAIL_CONTENT_PADDING_PX = 18
const ASSISTANT_RAIL_ACTIVE_INSET_PX = 24
const ASSISTANT_RAIL_FADE_SIZE_PX = 18
const ASSISTANT_RAIL_PREVIEW_INSET_PX = 44
const ASSISTANT_RAIL_HOVER_WIDTHS_PX = [26, 20, 14, 10, 6] as const
const OLDER_MESSAGE_LOAD_SCROLL_THRESHOLD = 72
const NEWER_MESSAGE_LOAD_SCROLL_THRESHOLD = 72
const MIN_RENDERABLE_HISTORY_ROWS = 3
const VIRTUAL_ROW_ESTIMATED_HEIGHT = 180
const VIRTUAL_ROW_OVERSCAN = 8
const INITIAL_TAIL_RENDER_COUNT = 32
const WINDOW_STABLE_FRAME_COUNT = 2
const INITIAL_TARGET_VIEWPORT_MULTIPLIER = 1.75
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
  messageLocatorVersion: number
  workingFolder?: string
  loadedRangeStart: number
  loadedRangeEnd: number
  hasOlder: boolean
  hasNewer: boolean
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
  messageLocatorVersion: 0,
  loadedRangeStart: 0,
  loadedRangeEnd: 0,
  hasOlder: false,
  hasNewer: false,
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
    messageLocatorVersion: state.messageLocatorVersions[sessionId] ?? 0,
    workingFolder: session.workingFolder,
    loadedRangeStart: session.loadedRangeStart ?? 0,
    loadedRangeEnd: session.loadedRangeEnd ?? 0,
    hasOlder: session.hasOlder ?? session.loadedRangeStart > 0,
    hasNewer: session.hasNewer ?? session.loadedRangeEnd < (session.messageCount ?? 0),
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

function buildAssistantRailTurnPreview(rows: AssistantRailLayoutRow[], t: TFunction): string {
  const visiblePreviews = rows
    .map((row) => {
      if (row.markerKind === 'summary') {
        return getCompactSummaryDisplayText({
          id: row.id,
          role: row.role,
          content: row.content,
          createdAt: row.createdAt,
          meta: row.meta
        })
      }
      if (row.markerKind === 'user') return getUserMessageText(row.content)
      return getAssistantVisibleText(row.content)
    })
    .map(normalizeLocatorPreview)
    .filter(Boolean)

  if (visiblePreviews.length > 0) {
    return truncateAssistantRailPreview(visiblePreviews.join(' · '))
  }

  return truncateAssistantRailPreview(
    rows.map((row) => buildAssistantRailPreview(row, row.markerKind!, t)).join(' · ')
  )
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

  interface PendingTurn {
    anchor: AssistantRailLayoutRow
    rows: AssistantRailLayoutRow[]
    markerRows: AssistantRailLayoutRow[]
    hasAssistant: boolean
  }

  let pendingTurn: PendingTurn | null = null

  const pushTurn = (): void => {
    if (!pendingTurn || pendingTurn.markerRows.length === 0) return

    const firstRow = pendingTurn.rows[0]
    const lastRow = pendingTurn.rows[pendingTurn.rows.length - 1]
    const userRows = pendingTurn.markerRows.filter((row) => row.markerKind === 'user')
    const assistantRows = pendingTurn.markerRows.filter(
      (row) => row.markerKind === 'assistant' || row.markerKind === 'streaming'
    )
    const previewRows = userRows.length > 0 ? userRows : pendingTurn.markerRows
    const preview = buildAssistantRailTurnPreview(previewRows, args.t)
    const detail =
      userRows.length > 0 && assistantRows.length > 0
        ? buildAssistantRailTurnPreview(assistantRows, args.t)
        : null
    const kind = pendingTurn.markerRows.some((row) => row.markerKind === 'streaming')
      ? 'streaming'
      : pendingTurn.anchor.markerKind!
    const turnHeight = lastRow.estimatedTop + lastRow.estimatedHeight - firstRow.estimatedTop

    items.push({
      id: pendingTurn.anchor.id,
      messageIds: pendingTurn.rows.map((row) => row.id),
      index: items.length + 1,
      preview,
      detail,
      time: formatLocatorTime(pendingTurn.anchor.createdAt),
      position: (firstRow.estimatedTop + turnHeight / 2) / totalEstimatedHeight,
      sortOrder: pendingTurn.anchor.sortOrder,
      createdAt: pendingTurn.anchor.createdAt,
      estimatedTop: firstRow.estimatedTop,
      estimatedHeight: turnHeight,
      kind
    })
    pendingTurn = null
  }

  // A rail marker represents a conversational turn, not one database row. Consecutive
  // questions share the next answer, while retries and tool-driven assistant messages stay
  // with the question until another user message starts the following turn.
  for (const row of rows) {
    if (row.markerKind === 'summary') {
      pushTurn()
      pendingTurn = {
        anchor: row,
        rows: [row],
        markerRows: [row],
        hasAssistant: false
      }
      pushTurn()
      continue
    }

    if (row.markerKind === 'user') {
      if (pendingTurn?.hasAssistant) pushTurn()
      if (!pendingTurn) {
        pendingTurn = {
          anchor: row,
          rows: [],
          markerRows: [],
          hasAssistant: false
        }
      }
      pendingTurn.rows.push(row)
      pendingTurn.markerRows.push(row)
      continue
    }

    if (row.markerKind === 'assistant' || row.markerKind === 'streaming') {
      if (!pendingTurn) {
        pendingTurn = {
          anchor: row,
          rows: [],
          markerRows: [],
          hasAssistant: false
        }
      }
      pendingTurn.rows.push(row)
      pendingTurn.markerRows.push(row)
      pendingTurn.hasAssistant = true
      continue
    }

    if (pendingTurn) pendingTurn.rows.push(row)
  }

  pushTurn()

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

function getAssistantRailMarkerSpanPx(total: number): number {
  if (total <= 0) return 0
  return (total - 1) * ASSISTANT_RAIL_MARKER_PITCH_PX + ASSISTANT_RAIL_MARKER_HEIGHT_PX
}

function getAssistantRailContentHeightPx(total: number): number {
  const naturalHeight = getAssistantRailMarkerSpanPx(total) + ASSISTANT_RAIL_CONTENT_PADDING_PX * 2
  return Math.max(ASSISTANT_RAIL_HEIGHT_PX, naturalHeight)
}

function getAssistantRailMarkerCenterPx(index: number, total: number): number {
  const contentHeight = getAssistantRailContentHeightPx(total)
  const markerSpan = getAssistantRailMarkerSpanPx(total)
  const firstMarkerCenter = (contentHeight - markerSpan) / 2 + ASSISTANT_RAIL_MARKER_HEIGHT_PX / 2
  return firstMarkerCenter + index * ASSISTANT_RAIL_MARKER_PITCH_PX
}

function getAssistantRailMaskImage(
  canScrollUp: boolean,
  canScrollDown: boolean
): string | undefined {
  if (canScrollUp && canScrollDown) {
    return `linear-gradient(to bottom, transparent 0, black ${ASSISTANT_RAIL_FADE_SIZE_PX}px, black calc(100% - ${ASSISTANT_RAIL_FADE_SIZE_PX}px), transparent 100%)`
  }
  if (canScrollUp) {
    return `linear-gradient(to bottom, transparent 0, black ${ASSISTANT_RAIL_FADE_SIZE_PX}px, black 100%)`
  }
  if (canScrollDown) {
    return `linear-gradient(to bottom, black 0, black calc(100% - ${ASSISTANT_RAIL_FADE_SIZE_PX}px), transparent 100%)`
  }
  return undefined
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
  onWheel
}: {
  items: AssistantReplyRailItem[]
  activeMessageIds: Set<string>
  onWheel: (event: React.WheelEvent<HTMLDivElement>) => void
}): React.JSX.Element | null {
  const animationsEnabled = useSettingsStore((state) => state.animationsEnabled)
  const [previewMessageId, setPreviewMessageId] = React.useState<string | null>(null)
  const [pointerPosition, setPointerPosition] = React.useState<{ y: number } | null>(null)
  const [railScrollTop, setRailScrollTop] = React.useState(0)
  const railViewportRef = React.useRef<HTMLDivElement | null>(null)
  const hasPositionedRailRef = React.useRef(false)
  const pointerFrameRef = React.useRef<number | null>(null)
  const railScrollFrameRef = React.useRef<number | null>(null)
  const pendingPointerPositionRef = React.useRef<typeof pointerPosition>(null)
  const pendingRailScrollTopRef = React.useRef(0)
  const railContentHeight = getAssistantRailContentHeightPx(items.length)
  const maxRailScrollTop = Math.max(0, railContentHeight - ASSISTANT_RAIL_HEIGHT_PX)
  const dense = maxRailScrollTop > 0
  const itemById = React.useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const itemIndexById = React.useMemo(
    () => new Map(items.map((item, itemIndex) => [item.id, itemIndex])),
    [items]
  )

  const getNearestItem = React.useCallback(
    (clientY: number, target: HTMLDivElement): AssistantReplyRailItem | null => {
      if (items.length === 0) return null
      const rect = target.getBoundingClientRect()
      if (rect.height <= 0) return null
      const pointerContentY = clientY - rect.top + target.scrollTop
      const firstMarkerCenter = getAssistantRailMarkerCenterPx(0, items.length)
      const nearestIndex = Math.max(
        0,
        Math.min(
          items.length - 1,
          Math.round((pointerContentY - firstMarkerCenter) / ASSISTANT_RAIL_MARKER_PITCH_PX)
        )
      )
      return items[nearestIndex] ?? null
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

  const scheduleRailScrollTop = React.useCallback((scrollTop: number) => {
    pendingRailScrollTopRef.current = scrollTop
    if (railScrollFrameRef.current !== null) return

    railScrollFrameRef.current = window.requestAnimationFrame(() => {
      railScrollFrameRef.current = null
      setRailScrollTop(pendingRailScrollTopRef.current)
    })
  }, [])

  const scrollMarkerIntoView = React.useCallback(
    (itemIndex: number, behaviorOverride?: ScrollBehavior) => {
      const viewport = railViewportRef.current
      if (!viewport || maxRailScrollTop <= 0) return

      const markerCenter = getAssistantRailMarkerCenterPx(itemIndex, items.length)
      const visibleStart = viewport.scrollTop + ASSISTANT_RAIL_ACTIVE_INSET_PX
      const visibleEnd = viewport.scrollTop + viewport.clientHeight - ASSISTANT_RAIL_ACTIVE_INSET_PX
      let nextScrollTop = viewport.scrollTop

      if (markerCenter < visibleStart) {
        nextScrollTop = markerCenter - ASSISTANT_RAIL_ACTIVE_INSET_PX
      } else if (markerCenter > visibleEnd) {
        nextScrollTop = markerCenter - viewport.clientHeight + ASSISTANT_RAIL_ACTIVE_INSET_PX
      } else {
        return
      }

      nextScrollTop = Math.max(0, Math.min(maxRailScrollTop, nextScrollTop))
      if (Math.abs(nextScrollTop - viewport.scrollTop) < 0.5) return

      const behavior = behaviorOverride ?? (animationsEnabled ? 'smooth' : 'auto')
      if (behavior === 'auto') {
        viewport.scrollTop = nextScrollTop
        scheduleRailScrollTop(nextScrollTop)
        return
      }
      viewport.scrollTo({ top: nextScrollTop, behavior })
    },
    [animationsEnabled, items.length, maxRailScrollTop, scheduleRailScrollTop]
  )

  React.useLayoutEffect(() => {
    const viewport = railViewportRef.current
    if (!viewport) return

    const nextScrollTop = Math.max(0, Math.min(maxRailScrollTop, viewport.scrollTop))
    if (Math.abs(nextScrollTop - viewport.scrollTop) >= 0.5) {
      viewport.scrollTop = nextScrollTop
    }
    setRailScrollTop(nextScrollTop)
  }, [maxRailScrollTop])

  React.useLayoutEffect(() => {
    if (activeMessageIds.size === 0 || maxRailScrollTop <= 0) return

    const viewport = railViewportRef.current
    if (!viewport) return
    const activeIndexes = Array.from(activeMessageIds)
      .map((messageId) => itemIndexById.get(messageId))
      .filter((itemIndex): itemIndex is number => itemIndex !== undefined)
      .sort((first, second) => first - second)
    if (activeIndexes.length === 0) return

    const visibleStart = viewport.scrollTop + ASSISTANT_RAIL_ACTIVE_INSET_PX
    const visibleEnd = viewport.scrollTop + viewport.clientHeight - ASSISTANT_RAIL_ACTIVE_INSET_PX
    const activeCenters = activeIndexes.map((itemIndex) =>
      getAssistantRailMarkerCenterPx(itemIndex, items.length)
    )
    const streamingActiveIndex = activeIndexes.find(
      (itemIndex) => items[itemIndex]?.kind === 'streaming'
    )

    if (streamingActiveIndex !== undefined) {
      const streamingCenter = getAssistantRailMarkerCenterPx(streamingActiveIndex, items.length)
      if (streamingCenter < visibleStart || streamingCenter > visibleEnd) {
        scrollMarkerIntoView(
          streamingActiveIndex,
          hasPositionedRailRef.current ? undefined : 'auto'
        )
      }
      hasPositionedRailRef.current = true
      return
    }

    if (activeCenters.some((center) => center >= visibleStart && center <= visibleEnd)) {
      hasPositionedRailRef.current = true
      return
    }

    const targetIndex =
      activeCenters[activeCenters.length - 1] < visibleStart
        ? activeIndexes[activeIndexes.length - 1]
        : activeIndexes[0]
    scrollMarkerIntoView(targetIndex, hasPositionedRailRef.current ? undefined : 'auto')
    hasPositionedRailRef.current = true
  }, [activeMessageIds, itemIndexById, items, maxRailScrollTop, scrollMarkerIntoView])

  React.useEffect(() => {
    return () => {
      if (pointerFrameRef.current !== null) {
        window.cancelAnimationFrame(pointerFrameRef.current)
      }
      if (railScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(railScrollFrameRef.current)
      }
    }
  }, [])

  React.useEffect(() => {
    if (!dense || !pointerPosition) return
    const viewport = railViewportRef.current
    if (!viewport) return

    const rect = viewport.getBoundingClientRect()
    const item = getNearestItem(rect.top + pointerPosition.y, viewport)
    setPreviewMessageId((previousId) => (previousId === item?.id ? previousId : (item?.id ?? null)))
  }, [dense, getNearestItem, pointerPosition, railScrollTop])

  if (items.length < 2) return null

  const previewItem = previewMessageId ? (itemById.get(previewMessageId) ?? null) : null
  const previewItemIndex = previewItem ? (itemIndexById.get(previewItem.id) ?? -1) : -1
  const previewCopy = previewItem
    ? previewItem.detail
      ? { title: previewItem.preview, detail: previewItem.detail }
      : splitLocatorPreview(previewItem.preview)
    : null
  const rawPreviewTop =
    previewItemIndex >= 0
      ? getAssistantRailMarkerCenterPx(previewItemIndex, items.length) - railScrollTop
      : ASSISTANT_RAIL_HEIGHT_PX / 2
  const previewTop = Math.max(
    ASSISTANT_RAIL_PREVIEW_INSET_PX,
    Math.min(ASSISTANT_RAIL_HEIGHT_PX - ASSISTANT_RAIL_PREVIEW_INSET_PX, rawPreviewTop)
  )
  const canScrollUp = railScrollTop > 0.5
  const canScrollDown = railScrollTop < maxRailScrollTop - 0.5
  const maskImage = getAssistantRailMaskImage(canScrollUp, canScrollDown)

  const getMarkerWaveScale = (itemIndex: number): number => {
    if (!pointerPosition) return 1
    const markerY = getAssistantRailMarkerCenterPx(itemIndex, items.length) - railScrollTop
    const distance = Math.abs(markerY - pointerPosition.y)
    const distanceInMarkers = distance / ASSISTANT_RAIL_MARKER_PITCH_PX
    const lastWidthIndex = ASSISTANT_RAIL_HOVER_WIDTHS_PX.length - 1
    if (distanceInMarkers >= lastWidthIndex) return 1

    const widthIndex = Math.floor(distanceInMarkers)
    const progress = distanceInMarkers - widthIndex
    const startWidth = ASSISTANT_RAIL_HOVER_WIDTHS_PX[widthIndex]
    const endWidth = ASSISTANT_RAIL_HOVER_WIDTHS_PX[widthIndex + 1]
    const width = startWidth + (endWidth - startWidth) * progress
    return width / ASSISTANT_RAIL_MARKER_WIDTH_PX
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
          'block h-0.5 origin-left rounded-full transition-[color,background-color,opacity,transform] duration-100 ease-out will-change-transform',
          'bg-muted-foreground/45',
          active ? 'bg-foreground/85 opacity-100' : 'opacity-65',
          previewing && 'bg-foreground/95 opacity-100',
          item.kind === 'streaming' && active && animationsEnabled && 'animate-pulse'
        )}
        style={{
          width: ASSISTANT_RAIL_MARKER_WIDTH_PX,
          transform: `scaleX(${getMarkerWaveScale(itemIndex)})`
        }}
      />
    )
  }

  return (
    <div
      className="pointer-events-none absolute left-2 top-1/2 z-20 hidden -translate-y-1/2 md:block"
      style={{ height: ASSISTANT_RAIL_HEIGHT_PX }}
    >
      <div
        className="pointer-events-none relative w-[min(320px,calc(100vw-3rem))]"
        style={{ height: ASSISTANT_RAIL_HEIGHT_PX }}
      >
        <AnimatePresence mode="popLayout">
          {previewItem && previewCopy ? (
            <motion.div
              key={previewItem.id}
              className="absolute left-9 w-[min(276px,calc(100vw-5rem))] -translate-y-1/2"
              style={{ top: previewTop }}
              initial={animationsEnabled ? { opacity: 0, x: -4 } : false}
              animate={{ opacity: 1, x: 0 }}
              exit={animationsEnabled ? { opacity: 0, x: -4 } : undefined}
              transition={
                animationsEnabled ? { duration: 0.12, ease: 'easeOut' } : { duration: 0 }
              }
            >
              <div className="overflow-hidden rounded-xl border border-border/70 bg-popover/95 px-3 py-2.5 text-popover-foreground shadow-xl backdrop-blur-xl">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/70',
                      previewItem.kind === 'streaming' && animationsEnabled && 'animate-pulse bg-primary'
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
            </motion.div>
          ) : null}
        </AnimatePresence>

        <div
          ref={railViewportRef}
          className="pointer-events-auto absolute left-0 top-0 w-8 overflow-y-hidden"
          style={{
            height: ASSISTANT_RAIL_HEIGHT_PX,
            maskImage,
            WebkitMaskImage: maskImage
          }}
          onScroll={(event) => scheduleRailScrollTop(event.currentTarget.scrollTop)}
          onWheel={onWheel}
          onPointerMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            schedulePointerPosition({
              y: Math.max(0, Math.min(rect.height, event.clientY - rect.top))
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
        >
          <div className="relative w-8" style={{ height: railContentHeight }}>
            {items.map((item, itemIndex) => {
              const previewing = previewMessageId === item.id
              const markerTop = getAssistantRailMarkerCenterPx(itemIndex, items.length)
              return dense ? (
                <span
                  key={item.id}
                  className="absolute left-0 flex w-8 -translate-y-1/2 items-center justify-start"
                  style={{
                    top: markerTop,
                    height: ASSISTANT_RAIL_MARKER_PITCH_PX
                  }}
                >
                  {renderMarker(item, itemIndex, previewing)}
                </span>
              ) : (
                <span
                  key={item.id}
                  title={item.preview}
                  className="pointer-events-auto absolute left-0 flex w-8 -translate-y-1/2 items-center justify-start"
                  style={{
                    top: markerTop,
                    // Hit areas tile at the fixed marker pitch without overlapping.
                    height: ASSISTANT_RAIL_MARKER_PITCH_PX
                  }}
                  onPointerEnter={() => setPreviewMessageId(item.id)}
                  onPointerLeave={() => setPreviewMessageId(null)}
                >
                  {renderMarker(item, itemIndex, previewing)}
                </span>
              )
            })}
          </div>
        </div>
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
      data-message-content-state={message.contentState ?? 'full'}
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
        <div className="animate-in fade-in-0 slide-in-from-bottom-1 duration-300">
          <SessionChangeSummaryCard
            sessionId={sessionId}
            messageId={message.id}
            toolUseIds={messageToolUseIds}
          />
        </div>
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
    messageLocatorVersion,
    workingFolder: activeWorkingFolder,
    loadedRangeStart,
    hasOlder,
    hasNewer,
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
  const virtualContentRef = React.useRef<HTMLDivElement | null>(null)
  const topSentinelRef = React.useRef<HTMLDivElement | null>(null)
  const renderedSessionIdRef = React.useRef<string | null>(activeSessionId)
  const pendingInitialScrollSessionIdRef = React.useRef<string | null>(activeSessionId)
  if (renderedSessionIdRef.current !== activeSessionId) {
    renderedSessionIdRef.current = activeSessionId
    pendingInitialScrollSessionIdRef.current = activeSessionId
  }
  const autoScrollModeRef = React.useRef<AutoScrollMode>('off')
  const initialPositionStableFramesRef = React.useRef(0)
  const initialPositionLastHeightRef = React.useRef<number | null>(null)
  const initialPositionFrameCountRef = React.useRef(0)
  const initialPositionStartedAtRef = React.useRef<number | null>(null)
  const scheduledScrollFrameRef = React.useRef<number | null>(null)
  const scheduledAssistantRailSyncRef = React.useRef<number | null>(null)
  const lastScrollOffsetRef = React.useRef(0)
  const programmaticScrollUntilRef = React.useRef(0)
  const wasSessionOutputtingRef = React.useRef(isSessionOutputting)
  const measuredMessageHeightsRef = React.useRef(new Map<string, number>())
  const [isAtBottom, setIsAtBottom] = React.useState(true)
  const [activeAssistantRailMessageIds, setActiveAssistantRailMessageIds] = React.useState<
    Set<string>
  >(() => new Set())
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = React.useState(false)
  const [isLoadingNewerMessages, setIsLoadingNewerMessages] = React.useState(false)
  const [loadingMessageContentId, setLoadingMessageContentId] = React.useState<string | null>(null)
  const hydratingMessageIdsRef = React.useRef(new Set<string>())
  const [messageWindowPhase, setMessageWindowPhase] = React.useState<MessageWindowPhase>(
    activeSessionId ? 'loading' : 'ready'
  )
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
    const residentMessagesById = new Map(messages.map((message) => [message.id, message]))
    return messageLocatorRows.map((row) => {
      const source = parseLocatorRowSource(row)
      const residentMessage = residentMessagesById.get(source.id)
      if (!residentMessage) return source
      return {
        ...source,
        role: residentMessage.role,
        content: residentMessage.content,
        meta: residentMessage.meta,
        source: residentMessage.source
      }
    })
  }, [messageLocatorRows, messages])

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
  const assistantRailItemIdByMessageId = React.useMemo(() => {
    const itemIdByMessageId = new Map<string, string>()
    for (const item of assistantRailItems) {
      for (const messageId of item.messageIds) itemIdByMessageId.set(messageId, item.id)
    }
    return itemIdByMessageId
  }, [assistantRailItems])

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
  }, [activeSessionId, messageLocatorVersion])

  const rows = React.useMemo<MessageListRow[]>(() => {
    return renderableMessages
      .filter((message) => !inlineCompactSummaryState.summaryIds.has(message.messageId))
      .map<MessageListRow>((message) => ({
        type: 'message',
        key: message.messageId,
        data: message
      }))
  }, [inlineCompactSummaryState.summaryIds, renderableMessages])
  const hasLoadOlderRow = messageWindowPhase === 'ready' && hasOlder && loadedRangeStart > 0
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
    rangeExtractor: (range) => {
      if (
        messageWindowPhase === 'ready' ||
        pendingInitialScrollSessionIdRef.current !== activeSessionId ||
        range.count === 0
      ) {
        return defaultRangeExtractor(range)
      }

      const startIndex = Math.max(0, range.count - INITIAL_TAIL_RENDER_COUNT)
      return Array.from({ length: range.count - startIndex }, (_, offset) => startIndex + offset)
    },
    getItemKey: (index) => {
      if (hasLoadOlderRow && index === 0) return `load-older:${activeSessionId ?? 'none'}`
      const row = rows[index - (hasLoadOlderRow ? 1 : 0)]
      return row?.key ?? `row:${index}`
    }
    // Keep an estimated size for virtualization only. Initial positioning is
    // performed after real rows have been measured below.
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
    (messageWindowPhase === 'loading' ||
      !activeSessionLoaded ||
      activeSessionMessageCount > 0 ||
      loadedRangeStart > 0)

  const lastMessageRowIndex = rows.length - 1

  const markProgrammaticScroll = React.useCallback(() => {
    programmaticScrollUntilRef.current = window.performance.now() + PROGRAMMATIC_SCROLL_GUARD_MS
  }, [])

  const scrollToBottomImmediate = React.useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      const ref = listRef.current
      if (!ref || rows.length === 0) return
      markProgrammaticScroll()
      const bottomOffset = Math.max(0, ref.scrollHeight - ref.clientHeight)
      if (behavior === 'auto') {
        ref.scrollTop = bottomOffset
        return
      }
      ref.scrollTo({ top: bottomOffset, behavior })
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
    const scrolledDown = currentOffset > previousOffset
    const isProgrammaticScroll = window.performance.now() < programmaticScrollUntilRef.current

    lastScrollOffsetRef.current = currentOffset

    if (scrolledUp) {
      autoScrollModeRef.current = 'off'
      setIsAtBottom(false)
      return
    }

    const physicallyAtBottom = distanceToBottom <= threshold
    const reachedBottom = distanceToBottom <= BOTTOM_SCROLL_CORRECTION_EPSILON
    // Programmatic scroll adjustments may move downward too. Resume following only when a
    // non-programmatic scroll reaches the real bottom, not merely its tolerance zone.
    if (
      reachedBottom &&
      autoScrollModeRef.current === 'off' &&
      scrolledDown &&
      !isProgrammaticScroll
    ) {
      autoScrollModeRef.current = isSessionOutputting ? 'stream' : 'user'
    }

    const nextAtBottom =
      autoScrollModeRef.current !== 'off' &&
      (physicallyAtBottom || (isSessionOutputting && autoScrollModeRef.current === 'stream'))

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
      const itemId = assistantRailItemIdByMessageId.get(messageId)
      if (!itemId) continue
      const rect = element.getBoundingClientRect()
      if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom) continue
      nextActiveIds.add(itemId)
    }

    setActiveAssistantRailIds(nextActiveIds)
  }, [
    assistantRailItemIdByMessageId,
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

  const loadOlderMessages = React.useCallback(async (): Promise<number> => {
    if (
      !activeSessionId ||
      messageWindowPhase !== 'ready' ||
      isLoadingOlderMessages ||
      !hasOlder ||
      loadedRangeStart <= 0
    ) {
      return 0
    }

    const ref = listRef.current
    const previousScrollHeight = ref?.scrollHeight ?? 0
    const previousScrollTop = ref?.scrollTop ?? 0
    const wasFollowingBottom =
      autoScrollModeRef.current !== 'off' &&
      Boolean(ref && getDistanceToBottom(ref) <= AUTO_SCROLL_BOTTOM_THRESHOLD)
    let anchorMessageId: string | null = null
    let anchorOffset = 0
    if (ref) {
      const refRect = ref.getBoundingClientRect()
      const visible = Array.from(ref.querySelectorAll<HTMLElement>('[data-message-id]')).find(
        (element) => {
          const rect = element.getBoundingClientRect()
          return rect.bottom > refRect.top && rect.top < refRect.bottom
        }
      )
      if (visible?.dataset.messageId) {
        anchorMessageId = visible.dataset.messageId
        anchorOffset = visible.getBoundingClientRect().top - refRect.top
      }
    }

    const startBefore = loadedRangeStart
    const loadStartedAt = window.performance.now()
    autoScrollModeRef.current = 'off'
    setIsLoadingOlderMessages(true)
    try {
      const loaded = await useChatStore.getState().loadOlderSessionMessages(activeSessionId)
      // loadOlderSessionMessages reports the rows it read from the DB, but a
      // running session's tail-trim can splice those same rows straight back off
      // (getMessageWindowPreserveMode forces 'tail' while running). Treat "the
      // window didn't actually grow older" as a stall so callers stop retrying.
      const startAfter =
        useChatStore.getState().sessions.find((s) => s.id === activeSessionId)?.loadedRangeStart ??
        startBefore
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
        let restored = false
        if (anchorMessageId) {
          const anchorElement = Array.from(
            nextRef.querySelectorAll<HTMLElement>('[data-message-id]')
          ).find((element) => element.dataset.messageId === anchorMessageId)
          if (anchorElement) {
            const nextOffset =
              anchorElement.getBoundingClientRect().top - nextRef.getBoundingClientRect().top
            const delta = nextOffset - anchorOffset
            if (Math.abs(delta) > BOTTOM_SCROLL_CORRECTION_EPSILON) {
              markProgrammaticScroll()
              nextRef.scrollTop = Math.max(0, nextRef.scrollTop + delta)
            }
            restored = true
          }
        }
        const scrollDelta = nextRef.scrollHeight - previousScrollHeight
        if (!restored && scrollDelta !== 0) {
          markProgrammaticScroll()
          nextRef.scrollTop = Math.max(0, previousScrollTop + scrollDelta)
        }
        if (wasFollowingBottom) {
          autoScrollModeRef.current = 'user'
          setIsAtBottom(true)
          markProgrammaticScroll()
          nextRef.scrollTop = Math.max(0, nextRef.scrollHeight - nextRef.clientHeight)
        }
      }
      syncBottomState()
      requestAssistantRailSync()
      if (import.meta.env.DEV) {
        console.debug('[MessageList] older load settled', {
          sessionId: activeSessionId,
          elapsedMs: Math.max(0, window.performance.now() - loadStartedAt),
          loaded,
          loadedRangeStart: startAfter
        })
      }
      return loaded
    } finally {
      setIsLoadingOlderMessages(false)
    }
  }, [
    activeSessionId,
    hasOlder,
    isLoadingOlderMessages,
    loadedRangeStart,
    markProgrammaticScroll,
    messageWindowPhase,
    requestAssistantRailSync,
    syncBottomState
  ])

  const loadNewerMessages = React.useCallback(async (): Promise<number> => {
    if (!activeSessionId || messageWindowPhase !== 'ready' || isLoadingNewerMessages || !hasNewer) {
      return 0
    }
    const viewport = listRef.current
    const wasFollowingBottom = Boolean(
      viewport &&
      autoScrollModeRef.current !== 'off' &&
      getDistanceToBottom(viewport) <= NEWER_MESSAGE_LOAD_SCROLL_THRESHOLD
    )
    setIsLoadingNewerMessages(true)
    const loadStartedAt = window.performance.now()
    try {
      const loaded = await useChatStore.getState().loadNewerSessionMessages(activeSessionId)
      if (loaded > 0) {
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()))
        })
        if (wasFollowingBottom && listRef.current) {
          markProgrammaticScroll()
          listRef.current.scrollTop = Math.max(
            0,
            listRef.current.scrollHeight - listRef.current.clientHeight
          )
        }
        requestAssistantRailSync()
      }
      if (import.meta.env.DEV) {
        console.debug('[MessageList] newer load settled', {
          sessionId: activeSessionId,
          elapsedMs: Math.max(0, window.performance.now() - loadStartedAt),
          loaded
        })
      }
      return loaded
    } finally {
      setIsLoadingNewerMessages(false)
    }
  }, [
    activeSessionId,
    hasNewer,
    isLoadingNewerMessages,
    markProgrammaticScroll,
    messageWindowPhase,
    requestAssistantRailSync
  ])

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
        requestAssistantRailSync()
      }

      scheduledScrollFrameRef.current = window.requestAnimationFrame(run)
    },
    [canAutoScroll, requestAssistantRailSync, scrollToBottomImmediate, syncBottomState]
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
      messageWindowPhase === 'ready' &&
      hasNewer &&
      !isLoadingNewerMessages &&
      getDistanceToBottom(ref) <= NEWER_MESSAGE_LOAD_SCROLL_THRESHOLD
    ) {
      void loadNewerMessages()
    }
    if (
      ref &&
      messageWindowPhase === 'ready' &&
      !isLoadingOlderMessages &&
      hasOlder &&
      loadedRangeStart > 0 &&
      stalledOlderLoadStartRef.current !== loadedRangeStart &&
      ref.scrollTop <= OLDER_MESSAGE_LOAD_SCROLL_THRESHOLD
    ) {
      void loadOlderMessages()
    }
  }, [
    isLoadingOlderMessages,
    isLoadingNewerMessages,
    loadNewerMessages,
    loadOlderMessages,
    hasNewer,
    hasOlder,
    loadedRangeStart,
    messageWindowPhase,
    requestAssistantRailSync,
    syncBottomState
  ])

  const handleAssistantRailWheel = React.useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const ref = listRef.current
    if (!ref || event.deltaY === 0) return

    const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? ref.clientHeight : 1
    ref.scrollTop += event.deltaY * multiplier
  }, [])

  React.useEffect(() => {
    if (!activeSessionId) return
    let cancelled = false
    setMessageWindowPhase('loading')
    void useChatStore
      .getState()
      .ensureSessionWindow(activeSessionId)
      .then((loaded) => {
        if (cancelled) return
        const current = useChatStore
          .getState()
          .sessions.find((session) => session.id === activeSessionId)
        if (!loaded && current && current.messageCount > 0) {
          setMessageWindowPhase('error')
          return
        }
        setMessageWindowPhase(current?.messages.length ? 'positioning' : 'ready')
      })
      .catch((error) => {
        console.error('[MessageList] Failed to initialize message window:', error)
        if (!cancelled) setMessageWindowPhase('error')
      })
    return () => {
      cancelled = true
    }
  }, [activeSessionId])

  React.useEffect(() => {
    if (!activeSessionId || !streamingMessageId) return

    const hasStreamingMessageInView = messages.some((message) => message.id === streamingMessageId)
    if (hasStreamingMessageInView) return

    // A user browsing older history must not be pulled back to the tail just
    // because a stream started elsewhere in the session. The newer sentinel
    // and the explicit bottom control will bring that tail into memory later.
    if (autoScrollModeRef.current === 'off') return

    void useChatStore.getState().ensureSessionWindow(activeSessionId, true)
  }, [activeSessionId, messages, streamingMessageId])

  React.useLayoutEffect(() => {
    pendingInitialScrollSessionIdRef.current = activeSessionId
    setMessageWindowPhase(activeSessionId ? 'loading' : 'ready')
    initialPositionStableFramesRef.current = 0
    initialPositionLastHeightRef.current = null
    initialPositionFrameCountRef.current = 0
    initialPositionStartedAtRef.current = activeSessionId ? window.performance.now() : null
    lastScrollOffsetRef.current = 0
    programmaticScrollUntilRef.current = 0
    measuredMessageHeightsRef.current.clear()
    stalledOlderLoadStartRef.current = null
    setAssistantRailMeasureVersion((version) => version + 1)
    setActiveAssistantRailIds(new Set())
  }, [activeSessionId, setActiveAssistantRailIds])

  React.useLayoutEffect(() => {
    if (!activeSessionId) return
    if (messageWindowPhase !== 'positioning') return
    if (pendingInitialScrollSessionIdRef.current !== activeSessionId) return
    if (!(messages.length > 0 || streamingMessageId)) return

    // Enter a follow mode on open so the bottom anchor below keeps re-pinning
    // while virtualized rows are measured; released on the first upward scroll.
    autoScrollModeRef.current = isSessionOutputting ? 'stream' : 'user'

    // Position the tail while the list is still hidden. The stability observer
    // below promotes the window to ready only after real row heights settle.
    scrollToBottomImmediate()
  }, [
    activeSessionId,
    isSessionOutputting,
    messageWindowPhase,
    messages.length,
    scrollToBottomImmediate,
    streamingMessageId
  ])

  React.useEffect(() => {
    const wasOutputting = wasSessionOutputtingRef.current
    if (
      !wasOutputting &&
      isSessionOutputting &&
      isAtBottom &&
      autoScrollModeRef.current !== 'off' &&
      !pendingAskUserQuestion
    ) {
      autoScrollModeRef.current = 'stream'
    } else if (wasOutputting && !isSessionOutputting && autoScrollModeRef.current === 'stream') {
      autoScrollModeRef.current = 'user'
    }
    wasSessionOutputtingRef.current = isSessionOutputting
  }, [isAtBottom, isSessionOutputting, pendingAskUserQuestion])

  React.useLayoutEffect(() => {
    if (pendingAskUserQuestion) return
    if (!canAutoScroll()) return
    scrollToBottomImmediate()
  }, [canAutoScroll, pendingAskUserQuestion, rows.length, scrollToBottomImmediate])

  // Bottom anchor: rows are virtualized with estimated heights, so a single
  // scroll-to-bottom lands short once the real (larger) row heights are
  // measured and the total size grows. Re-pin whenever the measured total size
  // changes while we are following the bottom, until measurement converges.
  const virtualListTotalSize = rowVirtualizer.getTotalSize()
  React.useLayoutEffect(() => {
    if (pendingAskUserQuestion) return
    if (!canAutoScroll()) return
    scrollToBottomImmediate()
  }, [
    canAutoScroll,
    isAtBottom,
    pendingAskUserQuestion,
    scrollToBottomImmediate,
    virtualListTotalSize
  ])

  React.useEffect(() => {
    const viewport = listRef.current
    const content = virtualContentRef.current
    if (!activeSessionId || !viewport || !content) return

    let cancelled = false
    let frame: number | null = null
    const settleInitialPosition = (): void => {
      if (cancelled) return
      if (messageWindowPhase === 'positioning') {
        initialPositionFrameCountRef.current += 1
        const measuredHeight = content.scrollHeight
        if (initialPositionLastHeightRef.current === measuredHeight) {
          initialPositionStableFramesRef.current += 1
        } else {
          initialPositionLastHeightRef.current = measuredHeight
          initialPositionStableFramesRef.current = 0
        }
        scrollToBottomImmediate()
        const settledAtBottom = getDistanceToBottom(viewport) <= BOTTOM_SCROLL_CORRECTION_EPSILON
        if (
          (initialPositionStableFramesRef.current >= WINDOW_STABLE_FRAME_COUNT &&
            settledAtBottom) ||
          initialPositionFrameCountRef.current >= 120
        ) {
          pendingInitialScrollSessionIdRef.current = null
          setMessageWindowPhase('ready')
          const startedAt = initialPositionStartedAtRef.current
          if (startedAt !== null) {
            if (import.meta.env.DEV) {
              console.debug('[MessageList] stable bottom position', {
                sessionId: activeSessionId,
                elapsedMs: Math.max(0, window.performance.now() - startedAt),
                frameCount: initialPositionFrameCountRef.current,
                residentRows: messages.length
              })
            }
            initialPositionStartedAtRef.current = null
          }
          syncBottomState()
        }
      } else if (canAutoScroll()) {
        scrollToBottomImmediate()
      }
      if (messageWindowPhase === 'positioning') {
        frame = window.requestAnimationFrame(settleInitialPosition)
      }
    }

    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            // Composer hydration and async message rendering can change the viewport
            // or content after the initial virtual-list measurements have settled.
            // Keep following only until the user deliberately scrolls upward.
            if (messageWindowPhase === 'positioning') {
              initialPositionStableFramesRef.current = 0
            } else if (canAutoScroll()) {
              scrollToBottomImmediate()
            }
            requestAssistantRailSync()
          })

    observer?.observe(viewport)
    observer?.observe(content)
    frame = window.requestAnimationFrame(settleInitialPosition)

    return () => {
      cancelled = true
      observer?.disconnect()
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [
    activeSessionId,
    canAutoScroll,
    messages.length,
    messageWindowPhase,
    requestAssistantRailSync,
    scrollToBottomImmediate,
    syncBottomState
  ])

  React.useEffect(() => {
    const viewport = listRef.current
    if (!viewport || !activeSessionId || messageWindowPhase !== 'ready') return
    if (typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const messageId = (entry.target as HTMLElement).dataset.messageId
          if (!messageId || hydratingMessageIdsRef.current.has(messageId)) continue
          hydratingMessageIdsRef.current.add(messageId)
          void useChatStore
            .getState()
            .loadMessageContent(activeSessionId, messageId)
            .finally(() => hydratingMessageIdsRef.current.delete(messageId))
        }
      },
      { root: viewport, rootMargin: '360px 0px' }
    )
    const previewRows = viewport.querySelectorAll<HTMLElement>(
      '[data-message-content-state="preview"]'
    )
    previewRows.forEach((row) => observer.observe(row))
    return () => observer.disconnect()
  }, [activeSessionId, messageWindowPhase, messages])

  React.useEffect(() => {
    const viewport = listRef.current
    const sentinel = topSentinelRef.current
    if (
      !viewport ||
      !sentinel ||
      !activeSessionId ||
      messageWindowPhase !== 'ready' ||
      !hasOlder ||
      loadedRangeStart <= 0 ||
      typeof IntersectionObserver === 'undefined'
    ) {
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        if (isLoadingOlderMessages) return
        if (stalledOlderLoadStartRef.current === loadedRangeStart) return
        void loadOlderMessages()
      },
      { root: viewport, rootMargin: '160px 0px 0px 0px', threshold: 0 }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [
    activeSessionId,
    hasOlder,
    isLoadingOlderMessages,
    loadOlderMessages,
    loadedRangeStart,
    messageWindowPhase
  ])

  React.useEffect(() => {
    if (
      !activeSessionId ||
      messageWindowPhase !== 'ready' ||
      isAwaitingInitialMessages ||
      isLoadingOlderMessages
    )
      return
    const viewport = listRef.current
    const needsMinimumRows = renderableMessages.length < MIN_RENDERABLE_HISTORY_ROWS
    const needsViewportFill = Boolean(
      viewport && virtualListTotalSize < viewport.clientHeight * INITIAL_TARGET_VIEWPORT_MULTIPLIER
    )
    if (loadedRangeStart <= 0 || (!needsMinimumRows && !needsViewportFill)) return
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
    messageWindowPhase,
    loadOlderMessages,
    loadedRangeStart,
    renderableMessages.length,
    virtualListTotalSize
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
    }
  }, [])

  const scrollToBottom = React.useCallback(() => {
    autoScrollModeRef.current = 'user'
    setIsAtBottom(true)
    if (hasNewer) {
      void loadNewerMessages().finally(() => {
        requestScrollToBottom({ behavior: 'smooth', force: true, maxFrames: 3 })
      })
      return
    }
    requestScrollToBottom({ behavior: 'smooth', force: true })
  }, [hasNewer, loadNewerMessages, requestScrollToBottom])

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
    if (messageWindowPhase === 'error') {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          <span>{t('messageList.loadFailed', { defaultValue: 'Unable to load messages' })}</span>
          <button
            type="button"
            className="rounded-full border border-border/70 px-3 py-1 text-xs hover:text-foreground"
            onClick={() => {
              if (!activeSessionId) return
              setMessageWindowPhase('loading')
              void useChatStore
                .getState()
                .ensureSessionWindow(activeSessionId, true)
                .then((loaded) => {
                  const current = useChatStore
                    .getState()
                    .sessions.find((session) => session.id === activeSessionId)
                  setMessageWindowPhase(
                    loaded ? (current?.messages.length ? 'positioning' : 'ready') : 'error'
                  )
                })
                .catch(() => setMessageWindowPhase('error'))
            }}
          >
            {t('common.retry', { defaultValue: 'Retry' })}
          </button>
        </div>
      )
    }
    return (
      <div className="flex flex-1 flex-col gap-4 overflow-hidden px-4 pt-6">
        {[0, 1, 2].map((index) => (
          <motion.div
            key={index}
            initial={animationsEnabled ? { opacity: 0, y: 6 } : false}
            animate={{ opacity: 1, y: 0 }}
            transition={
              animationsEnabled
                ? { duration: 0.2, delay: index * 0.05, ease: 'easeOut' }
                : { duration: 0 }
            }
            className={`${getMessageColumnClass(fullWidth)} space-y-2 ${
              index % 2 === 0 ? 'self-start' : 'self-end'
            }`}
          >
            <div className="h-3 w-3/5 animate-pulse rounded-md bg-muted/50" />
            <div className="h-3 w-4/5 animate-pulse rounded-md bg-muted/40" />
            <div className="h-3 w-1/2 animate-pulse rounded-md bg-muted/30" />
          </motion.div>
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
    const suggestedPrompts =
      mode === 'chat'
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

    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <motion.div
          initial={animationsEnabled ? { opacity: 0, y: 8 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={animationsEnabled ? { duration: 0.25, ease: 'easeOut' } : { duration: 0 }}
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
        </motion.div>

        <div className="mt-6 flex max-w-[520px] flex-wrap justify-center gap-2">
          {suggestedPrompts.map((prompt, index) => (
            <motion.button
              key={prompt}
              type="button"
              initial={animationsEnabled ? { opacity: 0, y: 6 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={
                animationsEnabled
                  ? { duration: 0.2, delay: 0.08 + index * 0.04, ease: 'easeOut' }
                  : { duration: 0 }
              }
              whileHover={animationsEnabled ? { y: -1 } : undefined}
              whileTap={animationsEnabled ? { scale: 0.98 } : undefined}
              className="rounded-md border border-border/60 bg-background/50 px-3 py-1.5 text-[11px] text-muted-foreground/70 transition-colors hover:bg-muted/50 hover:text-foreground"
              onClick={() => applySuggestedPrompt(prompt)}
            >
              {prompt}
            </motion.button>
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
        style={{
          overflowAnchor: 'none',
          visibility: messageWindowPhase === 'positioning' ? 'hidden' : 'visible'
        }}
        onScroll={handleListScroll}
      >
        <div
          ref={virtualContentRef}
          className="relative w-full"
          style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
        >
          <div
            ref={topSentinelRef}
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 h-px w-px"
            data-message-window-top-sentinel
          />
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
                    <motion.button
                      type="button"
                      initial={animationsEnabled ? { opacity: 0, y: -4 } : false}
                      animate={{ opacity: 1, y: 0 }}
                      transition={
                        animationsEnabled ? { duration: 0.16, ease: 'easeOut' } : { duration: 0 }
                      }
                      whileHover={animationsEnabled ? { y: -1 } : undefined}
                      whileTap={animationsEnabled ? { scale: 0.98 } : undefined}
                      className="rounded-full border border-border/70 bg-background/92 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:text-foreground disabled:cursor-wait disabled:opacity-70"
                      onClick={() => void loadOlderMessages()}
                      disabled={isLoadingOlderMessages}
                    >
                      {isLoadingOlderMessages
                        ? t('messageList.loadingOlder')
                        : t('messageList.loadOlder', { count: loadedRangeStart })}
                    </motion.button>
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
                    const isPreviewMessage = message.contentState === 'preview'

                    return (
                      <>
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
                          highlightMessageId={null}
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
                        {isPreviewMessage ? (
                          <div className={`${getMessageColumnClass(fullWidth)} pb-2`}>
                            <button
                              type="button"
                              className="rounded-full border border-border/60 bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground disabled:cursor-wait disabled:opacity-60"
                              disabled={loadingMessageContentId === messageId}
                              onClick={() => {
                                setLoadingMessageContentId(messageId)
                                void useChatStore
                                  .getState()
                                  .loadMessageContent(activeSessionId ?? '', messageId)
                                  .finally(() => setLoadingMessageContentId(null))
                              }}
                            >
                              {loadingMessageContentId === messageId
                                ? t('messageList.loadingMessageContent', {
                                    defaultValue: 'Loading full message…'
                                  })
                                : t('messageList.loadFullMessageContent', {
                                    defaultValue: 'Load full message'
                                  })}
                            </button>
                          </div>
                        ) : null}
                      </>
                    )
                  })()
                )}
              </div>
            )
          })}
        </div>
        {messageWindowPhase === 'ready' && hasNewer ? (
          <div className="pointer-events-none absolute bottom-1 left-0 right-0 flex justify-center">
            <button
              type="button"
              className="pointer-events-auto rounded-full border border-border/60 bg-background/90 px-3 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur-sm hover:text-foreground disabled:opacity-60"
              disabled={isLoadingNewerMessages}
              onClick={() => void loadNewerMessages()}
            >
              {isLoadingNewerMessages
                ? t('messageList.loadingNewer', { defaultValue: 'Loading newer messages…' })
                : t('messageList.loadNewer', { defaultValue: 'Load newer messages' })}
            </button>
          </div>
        ) : null}
      </div>

      <AssistantReplyRail
        key={activeSessionId ?? 'no-session'}
        items={assistantRailItems}
        activeMessageIds={activeAssistantRailMessageIds}
        onWheel={handleAssistantRailWheel}
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
