import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useShallow } from 'zustand/react/shallow'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, Loader2 } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import type { ContentBlock, ToolResultContent, UnifiedMessage } from '@renderer/lib/api/types'
import {
  useChatStore,
  type SessionCompactSummary,
  type SessionMode
} from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useTeamStore, type ActiveTeam } from '@renderer/stores/team-store'
import { PreviewRail, type PreviewRailItem } from '@renderer/components/motion/preview-rail'
import { MessageItem } from './MessageItem'
import { LiveCompressionCard } from './CompressionStatusMessage'
import { SessionChangeSummaryCard } from './SessionChangeSummaryCard'
import {
  buildChatRenderableMessageMetaFromAnalysis,
  buildTranscriptStaticAnalysis,
  type ChatRenderableMessageMeta,
  type TailToolExecutionState
} from './transcript-utils'
import { buildOrchestrationRuns } from '@renderer/lib/orchestration/build-runs'
import { type EditableUserMessageDraft } from '@renderer/lib/image-attachments'
import type { RequestRetryState, ToolCallState } from '@renderer/lib/agent/types'
import { isStreamingPerfEnabled, recordStreamingReactCommit } from '@renderer/lib/streaming-perf'
import { invokeMessagePackBinary } from '@renderer/lib/ipc/messagepack-ipc-client'
import { selectSessionScopedAgentState } from '@renderer/lib/agent/session-scoped-agent-state'
import {
  getCompactSummaryDisplayText,
  resolveActiveCompactArtifacts
} from '@renderer/lib/agent/context-compression'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import { DB_MESSAGES_LIST_LOCATOR_MSGPACK_CHANNEL } from '../../../../shared/messagepack/binary-ipc'
import { isRunScopedAssistantMessageId } from '../../../../shared/runtime-projection/reducer'
import type { RunStatus } from '../../../../shared/runtime-contracts/generated/contracts'
import { applyRuntimeOverlayToMessages } from '@renderer/lib/chat/apply-runtime-overlay'
import { useSessionRuntimeProjection } from '@renderer/lib/chat/use-session-runtime-projection'
import { VIEWPORT } from './message-list-viewport'
import { useMessageListViewport, type ViewportVirtualizer } from './use-message-list-viewport'

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
  compactSummary?: SessionCompactSummary | null
  orchestrationRun?: import('@renderer/lib/orchestration/types').OrchestrationRun | null
  hiddenToolUseIds?: Set<string>
  anchorMessageId?: string | null
  highlightMessageId?: string | null
  requestRetryState?: RequestRetryState | null
  liveToolCallMap?: Map<string, ToolCallState> | null
  runStatus?: RunStatus | null
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
const TAIL_STATIC_MESSAGE_COUNT = 4
const TAIL_LIVE_MESSAGE_COUNT = 6
const ASSISTANT_RAIL_MEASURE_THROTTLE_MS = 250
const ASSISTANT_RAIL_ACTIVE_DEBOUNCE_MS = 100
const ASSISTANT_RAIL_PREVIEW_LIMIT = 120
const ASSISTANT_RAIL_MAX_HEIGHT_PX = 416
const VIRTUAL_ROW_OVERSCAN = 8
const EMPTY_ORCHESTRATION_STATE = { runs: [], byId: new Map(), byMessageId: new Map() }
const MESSAGE_COLUMN_CLASS = 'mx-auto w-full max-w-[820px] px-5'
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
  mode: SessionMode
  compactSummary: SessionCompactSummary | null
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
  workingFolder: undefined,
  mode: 'chat',
  compactSummary: null
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
    projectId: session.projectId,
    mode: session.mode,
    compactSummary: session.compactSummary ?? null
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
    prev.compactSummary === next.compactSummary &&
    prev.orchestrationRun === next.orchestrationRun &&
    prev.hiddenToolUseIds === next.hiddenToolUseIds &&
    prev.anchorMessageId === next.anchorMessageId &&
    prev.highlightMessageId === next.highlightMessageId &&
    prev.renderMode === next.renderMode &&
    prev.liveToolCallMap === next.liveToolCallMap &&
    prev.runStatus === next.runStatus &&
    prev.showChangeSummary === next.showChangeSummary &&
    areRequestRetryStatesEqual(prev.requestRetryState, next.requestRetryState) &&
    prev.onRetry === next.onRetry &&
    prev.onContinue === next.onContinue &&
    prev.onEditUserMessage === next.onEditUserMessage &&
    prev.onDeleteMessage === next.onDeleteMessage
  )
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

interface InlineCompactSummaryState {
  byAssistantId: Map<string, UnifiedMessage[]>
  summaryIds: Set<string>
}

const EMPTY_INLINE_COMPACT_SUMMARY_STATE: InlineCompactSummaryState = {
  byAssistantId: new Map(),
  summaryIds: new Set()
}

/**
 * Where the compaction divider belongs in the transcript.
 *
 * The summary row is stored at the very end of the session so it always reads
 * as the newest turn, but compression runs mid-turn: the assistant message that
 * triggered it is spared by the cut and keeps streaming afterwards. Drawing the
 * row in its stored position therefore puts the divider *below* everything that
 * turn produced after the compression. Anchoring it to that assistant message
 * moves it back to where the cut actually falls — summarized history above,
 * still-live turn below — and the row itself is dropped from the list so it is
 * only drawn once.
 */
function useInlineCompactSummaryState(
  messages: readonly UnifiedMessage[],
  compactSummary: SessionCompactSummary | null | undefined,
  streamingMessageId: string | null = null
): InlineCompactSummaryState {
  const recordedSummaryId = compactSummary?.messageId ?? null
  // Sessions compacted before the cut was recorded only know their summary from
  // the legacy marker rows.
  const legacySummaryId = React.useMemo(
    () => (recordedSummaryId ? null : (resolveActiveCompactArtifacts(messages)?.summaryId ?? null)),
    [messages, recordedSummaryId]
  )
  const summaryId = recordedSummaryId ?? legacySummaryId
  const summary = React.useMemo(
    () => (summaryId ? (messages.find((message) => message.id === summaryId) ?? null) : null),
    [messages, summaryId]
  )
  const liveAnchorId = React.useMemo(() => {
    if (!summaryId || !streamingMessageId) return null
    const assistantIndex = messages.findIndex(
      (message) => message.id === streamingMessageId && message.role === 'assistant'
    )
    const summaryIndex = messages.findIndex((message) => message.id === summaryId)
    // A summary persisted after the assistant that is still streaming is the
    // current run's compaction artifact. This fallback heals a missed/stale cut
    // lookup without moving an older summary into an unrelated later turn.
    return assistantIndex >= 0 && summaryIndex > assistantIndex ? streamingMessageId : null
  }, [messages, streamingMessageId, summaryId])
  const recordedAnchorId =
    summary?.meta?.compactSummary?.displayAnchor?.assistantMessageId ??
    (recordedSummaryId ? (compactSummary?.anchorAssistantMessageId ?? null) : null) ??
    liveAnchorId
  const anchorId = React.useMemo(() => {
    if (!recordedAnchorId) return null
    // Cuts recorded before the host translated the Worker's run handle into a
    // transcript row name an assistant message that does not exist. The turn it
    // meant is the last assistant message before the summary row, since the
    // summary is written at the cut and that turn is what the cut spared.
    if (isRunScopedAssistantMessageId(recordedAnchorId)) {
      const summaryIndex = summaryId
        ? messages.findIndex((message) => message.id === summaryId)
        : -1
      if (summaryIndex < 0) return null
      for (let index = summaryIndex - 1; index >= 0; index -= 1) {
        if (messages[index].role === 'assistant') return messages[index].id
      }
      return null
    }
    return messages.some(
      (message) => message.id === recordedAnchorId && message.role === 'assistant'
    )
      ? recordedAnchorId
      : null
  }, [messages, recordedAnchorId, summaryId])

  return React.useMemo(() => {
    if (!summary || !recordedAnchorId) return EMPTY_INLINE_COMPACT_SUMMARY_STATE
    const summaryIds = new Set([summary.id])
    // A tail-persisted summary must never fall back to its storage position once
    // it has a real transcript anchor. If that assistant row is outside the
    // resident window, hide the divider until the row is loaded rather than let
    // newer streaming output appear above a false "compression happened here".
    if (!anchorId) {
      return {
        byAssistantId: new Map(),
        summaryIds
      }
    }
    return {
      byAssistantId: new Map([[anchorId, [summary]]]),
      summaryIds
    }
  }, [anchorId, recordedAnchorId, summary])
}

function shouldShowAssistantRailMarker(
  source: MessageLocatorSource,
  hiddenCompactSummaryIds: Set<string>,
  compactSummaryId: string | null
): boolean {
  if (hiddenCompactSummaryIds.has(source.id)) return false
  if (source.id === compactSummaryId) return true
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
  hiddenCompactSummaryIds: Set<string>,
  compactSummaryId: string | null
): AssistantRailMarkerKind | null {
  if (!shouldShowAssistantRailMarker(source, hiddenCompactSummaryIds, compactSummaryId)) return null
  if (source.id === compactSummaryId || source.meta?.compactSummary) return 'summary'
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
  compactSummaryId: string | null
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
      args.hiddenCompactSummaryIds,
      args.compactSummaryId
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

function formatLocatorTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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

function getAssistantRailJumpLabelKey(kind: AssistantRailMarkerKind): string {
  if (kind === 'streaming') return 'messageList.assistantRail.streamingLabel'
  if (kind === 'summary') return 'messageList.assistantRail.summaryLabel'
  if (kind === 'user') return 'messageList.assistantRail.userLabel'
  return 'messageList.assistantRail.jumpLabel'
}

function AssistantReplyRail({
  items,
  activeMessageIds,
  onWheel,
  onItemSelect
}: {
  items: AssistantReplyRailItem[]
  activeMessageIds: Set<string>
  onWheel: (event: React.WheelEvent<HTMLDivElement>) => void
  onItemSelect: (itemId: string) => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const previewItems = React.useMemo<PreviewRailItem[]>(
    () =>
      items.map((item) => ({
        id: item.id,
        label: item.preview,
        description: item.detail,
        ariaLabel: t(getAssistantRailJumpLabelKey(item.kind), {
          index: item.index,
          preview: item.preview
        })
      })),
    [items, t]
  )
  const activeId = React.useMemo(() => {
    let lastMatch: string | undefined
    for (const item of items) {
      if (activeMessageIds.has(item.id)) lastMatch = item.id
    }
    return lastMatch ?? items[items.length - 1]?.id
  }, [activeMessageIds, items])
  const itemSize = Math.max(
    8,
    Math.min(12, Math.floor(ASSISTANT_RAIL_MAX_HEIGHT_PX / Math.max(items.length, 1)))
  )

  if (items.length === 0) return null

  return (
    <div
      className="pointer-events-none absolute inset-y-0 left-0 z-20 hidden md:block"
      onWheel={onWheel}
    >
      <PreviewRail
        items={previewItems}
        label={t('messageList.assistantRail.navigation', {
          defaultValue: 'Conversation navigation'
        })}
        activeId={activeId}
        highlightActive
        itemSize={itemSize}
        onItemSelect={(item) => onItemSelect(item.id)}
        className="h-full min-h-0 w-[min(18rem,calc(100%-1rem))]"
        railClassName="pointer-events-auto w-6 max-h-[min(70vh,26rem)] self-center overflow-y-auto overflow-x-visible"
        itemClassName="w-6"
        tickClassName="w-5"
        previewContainerClassName="left-7 right-2"
        previewClassName="w-[min(240px,calc(100vw-5rem))]"
        renderPreview={(item) => (
          <div className="overflow-hidden rounded-lg border border-border/70 bg-popover/95 px-2.5 py-2 text-popover-foreground shadow-lg backdrop-blur-xl">
            <div className="line-clamp-1 text-[11px] font-medium leading-4">{item.label}</div>
            {item.description ? (
              <div className="mt-0.5 line-clamp-2 text-[11px] leading-[18px] text-muted-foreground">
                {item.description}
              </div>
            ) : null}
          </div>
        )}
      />
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
  compactSummary,
  orchestrationRun,
  hiddenToolUseIds,
  anchorMessageId,
  highlightMessageId,
  requestRetryState,
  liveToolCallMap,
  runStatus,
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
        compactSummary={compactSummary}
        orchestrationRun={orchestrationRun}
        hiddenToolUseIds={hiddenToolUseIds}
        requestRetryState={requestRetryState}
        liveToolCallMap={liveToolCallMap}
        runStatus={runStatus}
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
  const compactSummary = useChatStore((s) => {
    const index = sessionId ? s.sessionsById[sessionId] : undefined
    return index === undefined ? null : (s.sessions[index]?.compactSummary ?? null)
  })
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
  const inlineCompactSummaryState = useInlineCompactSummaryState(messages, compactSummary)
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
              compactSummary={compactSummary}
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
              runStatus={null}
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
    messages: storeMessages,
    messagesLoaded: activeSessionLoaded,
    messageCount: activeSessionMessageCount,
    messageLocatorVersion,
    workingFolder: activeWorkingFolder,
    loadedRangeStart,
    hasOlder,
    hasNewer,
    mode: sessionMode,
    compactSummary
  } = sessionSelection
  const storeStreamingMessageId = useChatStore((s) =>
    targetSessionId ? (s.streamingMessages[targetSessionId] ?? null) : null
  )
  const activeSessionId = targetSessionId

  // Main owns the compaction cut, so the transcript reads it rather than
  // inferring the compaction point from the messages it happens to hold.
  React.useEffect(() => {
    if (!targetSessionId) return
    void useChatStore.getState().refreshSessionCompactSummary(targetSessionId)
  }, [targetSessionId])
  const overlayEnabled =
    sessionMode === 'chat' ||
    sessionMode === 'cowork' ||
    sessionMode === 'code' ||
    sessionMode === 'clarify' ||
    sessionMode === 'acp'
  const runtimeProjection = useSessionRuntimeProjection(activeSessionId, overlayEnabled)
  const overlayView = React.useMemo(
    () =>
      overlayEnabled
        ? applyRuntimeOverlayToMessages(
            storeMessages,
            runtimeProjection,
            storeStreamingMessageId,
            activeSessionId
          )
        : {
            messages: storeMessages,
            streamingMessageId: storeStreamingMessageId,
            targetMessageId: storeStreamingMessageId,
            liveToolCallMap: null,
            runStatus: null,
            isActive: false
          },
    [overlayEnabled, storeMessages, runtimeProjection, storeStreamingMessageId, activeSessionId]
  )
  const messages = overlayView.messages
  const streamingMessageId = overlayView.streamingMessageId
  const overlayLiveToolCallMap = overlayView.liveToolCallMap
  const overlayTargetMessageId = overlayView.targetMessageId
  const overlayRunStatus = overlayView.runStatus
  const isMainChatSession =
    !sessionId && Boolean(activeSessionId) && activeSessionId === currentActiveSessionId
  const isDetachedSessionView = Boolean(sessionId && activeSessionId)
  const mode = useUIStore((s) => s.mode)
  const hasStreamingMessage = Boolean(storeStreamingMessageId) || overlayView.isActive
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

  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const measuredMessageHeightsRef = React.useRef(new Map<string, number>())
  const virtualizerRef = React.useRef<ViewportVirtualizer | null>(null)
  const railSyncRef = React.useRef<() => void>(() => undefined)
  const [virtualListTotalSize, setVirtualListTotalSize] = React.useState(0)
  const [activeAssistantRailMessageIds, setActiveAssistantRailMessageIds] = React.useState<
    Set<string>
  >(() => new Set())
  const [loadingMessageContentId, setLoadingMessageContentId] = React.useState<string | null>(null)
  const hydratingMessageIdsRef = React.useRef(new Set<string>())
  const lastRailMeasureAtRef = React.useRef(0)
  const railActiveTimerRef = React.useRef<number | null>(null)
  const pendingRailActiveIdsRef = React.useRef<Set<string> | null>(null)
  const scheduledAssistantRailSyncRef = React.useRef<number | null>(null)
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
  const inlineCompactSummaryState = useInlineCompactSummaryState(
    messages,
    compactSummary,
    streamingMessageId
  )
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
      compactSummaryId: compactSummary?.messageId ?? null,
      t
    })
  }, [
    assistantRailMeasureVersion,
    compactSummary,
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
  const lastUserMessageId = transcriptAnalysis.lastRealUserMessageId
  const lastUserMessageIsQuoted =
    lastUserMessageId != null && messageLookup.get(lastUserMessageId)?.source === 'quoted'
  const pendingAskUserQuestion = React.useMemo(
    () => findPendingAskUserQuestion(rows, toolResultsLookup, messageLookup),
    [messageLookup, rows, toolResultsLookup]
  )
  const messageLookupHas = React.useCallback((id: string) => messageLookup.has(id), [messageLookup])

  const viewport = useMessageListViewport({
    sessionId: activeSessionId,
    messagesLength: messages.length,
    storeMessagesLength: storeMessages.length,
    sessionLoaded: activeSessionLoaded,
    sessionMessageCount: activeSessionMessageCount,
    loadedRangeStart,
    hasOlder,
    hasNewer,
    rows,
    lastUserMessageId,
    lastUserMessageIsQuoted,
    messageLookupHas,
    streamingMessageId,
    isSessionOutputting,
    canStreamFollow: canSessionTriggerStreamingAutoScroll,
    pendingAskUserQuestion: Boolean(pendingAskUserQuestion),
    measuredHeightsRef: measuredMessageHeightsRef,
    virtualizerRef,
    virtualListTotalSize,
    onScrollProjection: () => railSyncRef.current()
  })
  const {
    listRef,
    contentRef,
    topSentinelRef,
    phase: messageWindowPhase,
    isChasingTail,
    isAtBottom,
    turnSpacerHeight,
    hasLoadOlderRow,
    isAwaitingInitialMessages,
    isInitialLoading: isInitialMessageWindowLoading,
    isLoadingOlder: isLoadingOlderMessages,
    isLoadingNewer: isLoadingNewerMessages,
    shouldAdjustScrollOnItemSizeChange,
    handleListScroll,
    handleRailWheel: handleAssistantRailWheel,
    releaseFollow,
    loadOlderMessages,
    loadNewerMessages,
    scrollToBottom,
    retryInitialLoad
  } = viewport
  const virtualContentRef = contentRef
  const virtualRowCount = rows.length + (hasLoadOlderRow ? 1 : 0)

  const rowVirtualizer = useVirtualizer({
    count: virtualRowCount,
    getScrollElement: () => listRef.current,
    estimateSize: () => VIEWPORT.estimatedRowHeight,
    overscan: VIRTUAL_ROW_OVERSCAN,
    rangeExtractor: (range) => {
      if (
        messageWindowPhase === 'ready' ||
        viewport.pendingInitialSessionId.current !== activeSessionId ||
        range.count === 0
      ) {
        return defaultRangeExtractor(range)
      }

      const startIndex = Math.max(0, range.count - VIEWPORT.initialTailRenderCount)
      return Array.from({ length: range.count - startIndex }, (_, offset) => startIndex + offset)
    },
    getItemKey: (index) => {
      if (hasLoadOlderRow && index === 0) return `load-older:${activeSessionId ?? 'none'}`
      const row = rows[index - (hasLoadOlderRow ? 1 : 0)]
      return row?.key ?? `row:${index}`
    },
    paddingEnd: turnSpacerHeight,
    useAnimationFrameWithResizeObserver: true
  })
  virtualizerRef.current = rowVirtualizer as typeof virtualizerRef.current
  rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = shouldAdjustScrollOnItemSizeChange
  ;(rowVirtualizer.options as { anchorTo?: 'start' | 'end' }).anchorTo =
    messageWindowPhase === 'positioning' || isChasingTail ? 'end' : 'start'

  const measuredVirtualSize = rowVirtualizer.getTotalSize()
  React.useLayoutEffect(() => {
    setVirtualListTotalSize((prev) => (prev === measuredVirtualSize ? prev : measuredVirtualSize))
  }, [measuredVirtualSize])

  const lastMessageRowIndex = rows.length - 1

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
  }, [listRef])

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

    const now = window.performance.now()
    if (
      now - lastRailMeasureAtRef.current >= ASSISTANT_RAIL_MEASURE_THROTTLE_MS &&
      measureVisibleMessageHeights()
    ) {
      lastRailMeasureAtRef.current = now
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

    pendingRailActiveIdsRef.current = nextActiveIds
    if (railActiveTimerRef.current != null) return
    railActiveTimerRef.current = window.setTimeout(() => {
      railActiveTimerRef.current = null
      const pendingIds = pendingRailActiveIdsRef.current
      if (pendingIds) setActiveAssistantRailIds(pendingIds)
    }, ASSISTANT_RAIL_ACTIVE_DEBOUNCE_MS)
  }, [
    assistantRailItemIdByMessageId,
    assistantRailItems,
    assistantRailLayout,
    listRef,
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
  railSyncRef.current = requestAssistantRailSync

  const handleAssistantRailSelect = React.useCallback(
    (itemId: string) => {
      const item = assistantRailItems.find((entry) => entry.id === itemId)
      const list = listRef.current
      if (!list || !item) return
      releaseFollow()

      const messageId = item.messageIds[0]
      const element = messageId
        ? list.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
        : null
      if (element) {
        element.scrollIntoView({ block: 'start', behavior: 'smooth' })
        return
      }

      list.scrollTo({ top: Math.max(0, item.estimatedTop - 24), behavior: 'smooth' })
    },
    [assistantRailItems, listRef, releaseFollow]
  )

  React.useEffect(() => {
    requestAssistantRailSync()
  }, [requestAssistantRailSync])

  React.useEffect(() => {
    const viewportEl = listRef.current
    if (!viewportEl || !activeSessionId || messageWindowPhase !== 'ready') return
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
      { root: viewportEl, rootMargin: '360px 0px' }
    )
    const previewRows = viewportEl.querySelectorAll<HTMLElement>(
      '[data-message-content-state="preview"]'
    )
    previewRows.forEach((row) => observer.observe(row))
    return () => observer.disconnect()
  }, [activeSessionId, listRef, messageWindowPhase, messages])

  React.useEffect(() => {
    return () => {
      if (scheduledAssistantRailSyncRef.current !== null) {
        window.cancelAnimationFrame(scheduledAssistantRailSyncRef.current)
      }
      if (railActiveTimerRef.current != null) {
        window.clearTimeout(railActiveTimerRef.current)
      }
    }
  }, [])

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
            onClick={retryInitialLoad}
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
    const suggestedPrompts =
      mode === 'chat'
        ? [t('messageList.explainAsync'), t('messageList.compareRest'), t('messageList.writeRegex')]
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
        <div className="flex max-w-[520px] flex-wrap justify-center gap-2">
          {suggestedPrompts.map((prompt, index) => (
            <motion.button
              key={prompt}
              type="button"
              initial={animationsEnabled ? { opacity: 0, y: 6 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={
                animationsEnabled
                  ? { duration: 0.22, delay: index * 0.08, ease: 'easeOut' }
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
                compactSummary={compactSummary}
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
                runStatus={null}
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
        className="absolute inset-0 overflow-y-auto pl-8 md:pl-9"
        data-message-content
        style={{
          overflowAnchor: 'none',
          visibility: isInitialMessageWindowLoading ? 'hidden' : 'visible'
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
                      onClick={() => void loadOlderMessages('history')}
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
                    const rowLiveToolCallMap =
                      overlayLiveToolCallMap &&
                      (isStreaming || messageId === overlayTargetMessageId)
                        ? overlayLiveToolCallMap
                        : undefined
                    const rowRunStatus =
                      overlayRunStatus && (isStreaming || messageId === overlayTargetMessageId)
                        ? overlayRunStatus
                        : null

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
                          compactSummary={compactSummary}
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
                          liveToolCallMap={rowLiveToolCallMap}
                          runStatus={rowRunStatus}
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
        {activeSessionId ? (
          <LiveCompressionCard
            sessionId={activeSessionId}
            className={`${getMessageColumnClass(fullWidth)} pb-3`}
          />
        ) : null}
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

      {isInitialMessageWindowLoading ? (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center bg-background"
          role="status"
          aria-live="polite"
        >
          <Loader2
            className={`size-5 text-muted-foreground ${animationsEnabled ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          <span className="sr-only">
            {t('messageList.loading', { defaultValue: 'Loading conversation…' })}
          </span>
        </div>
      ) : null}

      <AssistantReplyRail
        key={activeSessionId ?? 'no-session'}
        items={assistantRailItems}
        activeMessageIds={activeAssistantRailMessageIds}
        onWheel={handleAssistantRailWheel}
        onItemSelect={handleAssistantRailSelect}
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
