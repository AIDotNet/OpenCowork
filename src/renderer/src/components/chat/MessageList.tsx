import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useShallow } from 'zustand/react/shallow'
import { useVirtualizer } from '@tanstack/react-virtual'
import { MessageSquare, CircleHelp, Briefcase, Code2, ShieldCheck, ArrowDown } from 'lucide-react'
import type { ContentBlock, ToolResultContent, UnifiedMessage } from '@renderer/lib/api/types'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useAgentStore } from '@renderer/stores/agent-store'
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
import { resolveActiveCompactArtifacts } from '@renderer/lib/agent/context-compression'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import { DB_MESSAGES_LIST_USER_MSGPACK_CHANNEL } from '../../../../shared/messagepack/binary-ipc'

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

interface UserMessageLocatorItem {
  id: string
  index: number
  preview: string
  time: string
  position: number
  sortOrder: number
}

interface UserMessageLocatorSource {
  id: string
  content: UnifiedMessage['content']
  meta?: UnifiedMessage['meta']
  createdAt: number
  sortOrder: number
  source?: UnifiedMessage['source']
}

interface UserMessageIndexRow {
  id: string
  session_id: string
  role: string
  content: string
  meta: string | null
  created_at: number
  sort_order: number
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
const STREAMING_AUTO_SCROLL_BOTTOM_THRESHOLD = AUTO_SCROLL_BOTTOM_THRESHOLD
const TAIL_STATIC_MESSAGE_COUNT = 4
const TAIL_LIVE_MESSAGE_COUNT = 6
const INITIAL_SCROLL_SETTLE_FRAMES = 2
const FOLLOW_BOTTOM_SETTLE_FRAMES = 3
const BOTTOM_SCROLL_CORRECTION_EPSILON = 2
const AUTO_SCROLL_MIN_DELTA = 24
const PROGRAMMATIC_SCROLL_GUARD_MS = 160
const STREAMING_AUTO_SCROLL_POLL_MS = 500
const USER_LOCATOR_PREVIEW_LIMIT = 88
const USER_LOCATOR_SCROLL_OFFSET = 28
const USER_LOCATOR_HIGHLIGHT_MS = 1400
const OLDER_MESSAGE_LOAD_SCROLL_THRESHOLD = 72
const MIN_RENDERABLE_HISTORY_ROWS = 3
const VIRTUAL_ROW_ESTIMATED_HEIGHT = 180
const VIRTUAL_ROW_OVERSCAN = 8
const EMPTY_ORCHESTRATION_STATE = { runs: [], byId: new Map(), byMessageId: new Map() }
const MESSAGE_COLUMN_CLASS = 'mx-auto w-full max-w-[820px] px-5'
const MESSAGE_COLUMN_COMPACT_CLASS = 'mx-auto w-full max-w-[720px] px-5'
const MESSAGE_COLUMN_FULL_WIDTH_CLASS = 'mx-auto w-full max-w-none px-5'
const EMPTY_USER_LOCATOR_ROWS: UserMessageIndexRow[] = []

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
void areStringSetsEqual

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

function truncateLocatorPreview(text: string): string {
  if (text.length <= USER_LOCATOR_PREVIEW_LIMIT) return text
  return `${text.slice(0, USER_LOCATOR_PREVIEW_LIMIT - 1).trimEnd()}...`
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

function countImageBlocks(content: UnifiedMessage['content']): number {
  if (typeof content === 'string') return 0
  return content.filter((block) => block.type === 'image' || block.type === 'image_error').length
}

function getCompactLocatorMarkerTop(index: number, total: number): string {
  const safeTotal = Math.max(1, total)
  if (safeTotal === 1) return '50%'

  const gapPx = Math.max(3.5, Math.min(9, 176 / (safeTotal - 1)))
  const offsetPx = (index - (safeTotal - 1) / 2) * gapPx

  return `calc(50% + ${Number(offsetPx.toFixed(2))}px)`
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

function buildUserLocatorItem(
  source: UserMessageLocatorSource,
  index: number,
  messageCount: number,
  t: TFunction
): UserMessageLocatorItem | null {
  if (source.source === 'team' || source.meta?.compactSummary) return null

  const textPreview = truncateLocatorPreview(
    normalizeLocatorPreview(getUserMessageText(source.content))
  )
  const imageCount = countImageBlocks(source.content)
  if (!textPreview && imageCount === 0) return null

  const fallbackPreview =
    imageCount > 0
      ? t('messageList.userLocator.imageMessage', {
          count: imageCount,
          defaultValue: imageCount === 1 ? 'Image message' : '{{count}} images'
        })
      : t('messageList.userLocator.emptyMessage', {
          defaultValue: 'Empty message'
        })

  return {
    id: source.id,
    index,
    preview: textPreview || fallbackPreview,
    time: formatLocatorTime(source.createdAt),
    position: messageCount > 1 ? source.sortOrder / (messageCount - 1) : 0,
    sortOrder: source.sortOrder
  }
}

function UserMessageLocator({
  items,
  activeMessageId,
  onJump
}: {
  items: UserMessageLocatorItem[]
  activeMessageId?: string | null
  onJump: (item: UserMessageLocatorItem) => void
}): React.JSX.Element | null {
  const { t } = useTranslation('chat')
  const [previewMessageId, setPreviewMessageId] = React.useState<string | null>(null)

  if (items.length < 2) return null

  const previewItem = previewMessageId
    ? (items.find((item) => item.id === previewMessageId) ?? null)
    : null
  const previewItemIndex = previewItem ? items.findIndex((item) => item.id === previewItem.id) : -1
  const previewCopy = previewItem ? splitLocatorPreview(previewItem.preview) : null
  const previewTop =
    previewItemIndex >= 0 ? getCompactLocatorMarkerTop(previewItemIndex, items.length) : '50%'

  return (
    <div className="pointer-events-none absolute right-2 top-1/2 z-20 hidden -translate-y-1/2 md:block">
      <div className="pointer-events-none relative h-[min(52vh,24rem)] w-[min(324px,calc(100vw-3rem))]">
        {previewItem && previewCopy ? (
          <>
            <div
              className="absolute right-12 w-[min(276px,calc(100vw-5rem))] -translate-y-1/2 animate-in fade-in-0 slide-in-from-right-1 duration-150"
              style={{ top: previewTop }}
            >
              <div className="overflow-hidden rounded-xl border border-border/70 bg-popover/95 px-3 py-2.5 text-popover-foreground shadow-xl backdrop-blur-xl">
                <div className="line-clamp-1 text-[12px] font-semibold leading-5">
                  {previewCopy.title}
                </div>
                {previewCopy.detail ? (
                  <div className="mt-0.5 line-clamp-2 text-[11px] leading-[18px] text-muted-foreground">
                    {previewCopy.detail}
                  </div>
                ) : null}
              </div>
            </div>
          </>
        ) : null}

        <div className="pointer-events-none absolute right-0 top-0 h-full w-11">
          {items.map((item, itemIndex) => {
            const active = activeMessageId === item.id
            const previewing = previewMessageId === item.id
            return (
              <button
                key={item.id}
                type="button"
                aria-label={t('messageList.userLocator.jumpLabel', {
                  index: item.index,
                  preview: item.preview,
                  defaultValue: 'Jump to user message {{index}}: {{preview}}'
                })}
                title={item.preview}
                className="pointer-events-auto group/marker absolute right-0 flex h-6 w-11 -translate-y-1/2 items-center justify-end rounded-sm outline-none"
                style={{ top: getCompactLocatorMarkerTop(itemIndex, items.length) }}
                onPointerEnter={() => setPreviewMessageId(item.id)}
                onPointerLeave={() => setPreviewMessageId(null)}
                onFocus={() => setPreviewMessageId(item.id)}
                onBlur={() => setPreviewMessageId(null)}
                onClick={() => onJump(item)}
              >
                <span
                  className={cn(
                    'block h-px rounded-full bg-muted-foreground/35 transition-all duration-150 group-hover/marker:bg-foreground/80 group-focus-visible/marker:bg-foreground/90',
                    active ? 'w-4 bg-muted-foreground/70' : 'w-2.5',
                    previewing && 'h-0.5 w-8 bg-foreground/95'
                  )}
                />
              </button>
            )
          })}
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
  const highlightedMessageTimerRef = React.useRef<number | null>(null)
  const lastScrollOffsetRef = React.useRef(0)
  const programmaticScrollUntilRef = React.useRef(0)
  const wasSessionOutputtingRef = React.useRef(isSessionOutputting)
  const [isAtBottom, setIsAtBottom] = React.useState(true)
  const [activeUserLocatorMessageId, setActiveUserLocatorMessageId] = React.useState<string | null>(
    null
  )
  const [highlightedMessageId, setHighlightedMessageId] = React.useState<string | null>(null)
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = React.useState(false)
  const [userLocatorSnapshot, setUserLocatorSnapshot] = React.useState<{
    sessionId: string | null
    rows: UserMessageIndexRow[]
  }>({ sessionId: null, rows: EMPTY_USER_LOCATOR_ROWS })
  const userLocatorRows =
    userLocatorSnapshot.sessionId === activeSessionId
      ? userLocatorSnapshot.rows
      : EMPTY_USER_LOCATOR_ROWS

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

  // Parsing the DB rows is keyed on the rows alone — re-running the
  // JSON.parse of every user row on each streaming messages-array flush is
  // needless churn; rows only change when the session (re)loads.
  const userLocatorRowSources = React.useMemo(() => {
    const sourcesById = new Map<string, UserMessageLocatorSource>()
    for (const row of userLocatorRows) {
      if (row.role !== 'user') continue
      sourcesById.set(row.id, {
        id: row.id,
        content: parseLocatorContent(row.content),
        meta: parseLocatorMeta(row.meta),
        createdAt: row.created_at,
        sortOrder: row.sort_order
      })
    }
    return sourcesById
  }, [userLocatorRows])

  const userLocatorItems = React.useMemo<UserMessageLocatorItem[]>(() => {
    const sourcesById = new Map(userLocatorRowSources)

    messages.forEach((message, messageIndex) => {
      if (message.role !== 'user') return
      const existing = sourcesById.get(message.id)
      sourcesById.set(message.id, {
        id: message.id,
        content: message.content,
        meta: message.meta,
        createdAt: message.createdAt,
        sortOrder: existing?.sortOrder ?? loadedRangeStart + messageIndex,
        source: message.source
      })
    })

    const items: UserMessageLocatorItem[] = []
    for (const source of [...sourcesById.values()].sort((a, b) => a.sortOrder - b.sortOrder)) {
      const item = buildUserLocatorItem(source, items.length + 1, activeSessionMessageCount, t)
      if (item) items.push(item)
    }
    return items
  }, [activeSessionMessageCount, loadedRangeStart, messages, t, userLocatorRowSources])

  React.useEffect(() => {
    let cancelled = false

    if (!activeSessionId) {
      setUserLocatorSnapshot({ sessionId: null, rows: EMPTY_USER_LOCATOR_ROWS })
      return
    }

    const loadUserLocatorRows = async (): Promise<void> => {
      try {
        const rows = await invokeMessagePackBinary<UserMessageIndexRow[] | null>(
          DB_MESSAGES_LIST_USER_MSGPACK_CHANNEL,
          activeSessionId
        )
        if (!cancelled) {
          setUserLocatorSnapshot({
            sessionId: activeSessionId,
            rows: Array.isArray(rows) ? rows : EMPTY_USER_LOCATOR_ROWS
          })
        }
      } catch (err) {
        console.error('[MessageList] Failed to load user message locator rows:', err)
        if (!cancelled) {
          setUserLocatorSnapshot({ sessionId: activeSessionId, rows: EMPTY_USER_LOCATOR_ROWS })
        }
      }
    }

    void loadUserLocatorRows()

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
  const pendingAskUserQuestion = React.useMemo(
    () => findPendingAskUserQuestion(rows, toolResultsLookup, messageLookup),
    [messageLookup, rows, toolResultsLookup]
  )
  const isAwaitingInitialMessages =
    Boolean(activeSessionId) &&
    messages.length === 0 &&
    (!activeSessionLoaded || activeSessionMessageCount > 0 || loadedRangeStart > 0)

  const lastMessageRowIndex = rows.length - 1
  const userLocatorItemById = React.useMemo(
    () => new Map(userLocatorItems.map((item) => [item.id, item])),
    [userLocatorItems]
  )

  const canAutoScroll = React.useCallback(() => {
    const mode = autoScrollModeRef.current
    return (
      mode === 'user' || (mode === 'stream' && canSessionTriggerStreamingAutoScroll && isAtBottom)
    )
  }, [canSessionTriggerStreamingAutoScroll, isAtBottom])

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

    if (scrolledUp && !isProgrammaticScroll) {
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

  const syncActiveUserLocator = React.useCallback(() => {
    const ref = listRef.current
    if (!ref || userLocatorItems.length === 0) {
      setActiveUserLocatorMessageId((prev) => (prev === null ? prev : null))
      return
    }

    const containerTop = ref.getBoundingClientRect().top
    let nearestVisibleId: string | null = null
    let nearestVisibleDistance = Number.POSITIVE_INFINITY

    for (const element of ref.querySelectorAll<HTMLElement>('[data-message-id]')) {
      const messageId = element.dataset.messageId
      if (!messageId || !userLocatorItemById.has(messageId)) continue

      const distance = Math.abs(element.getBoundingClientRect().top - containerTop)
      if (distance < nearestVisibleDistance) {
        nearestVisibleDistance = distance
        nearestVisibleId = messageId
      }
    }

    if (nearestVisibleId) {
      setActiveUserLocatorMessageId((prev) => (prev === nearestVisibleId ? prev : nearestVisibleId))
      return
    }

    const scrollableDistance = Math.max(1, ref.scrollHeight - ref.clientHeight)
    const scrollProgress = Math.min(1, Math.max(0, ref.scrollTop / scrollableDistance))
    let nextActiveId = userLocatorItems[0]?.id ?? null
    let nearestDistance = Number.POSITIVE_INFINITY

    for (const item of userLocatorItems) {
      const distance = Math.abs(item.position - scrollProgress)
      if (distance < nearestDistance) {
        nearestDistance = distance
        nextActiveId = item.id
      }
    }

    setActiveUserLocatorMessageId((prev) => (prev === nextActiveId ? prev : nextActiveId))
  }, [userLocatorItemById, userLocatorItems])

  const handleJumpToUserMessage = React.useCallback(
    async (item: UserMessageLocatorItem): Promise<void> => {
      const messageId = item.id
      const scrollToTarget = (): boolean => {
        const ref = listRef.current
        if (!ref) return false

        const target = Array.from(ref.querySelectorAll<HTMLElement>('[data-message-id]')).find(
          (element) => element.dataset.messageId === messageId
        )
        if (!target) return false

        autoScrollModeRef.current = 'off'
        markProgrammaticScroll()
        setActiveUserLocatorMessageId(messageId)
        setHighlightedMessageId(messageId)
        ref.scrollTo({
          top: Math.max(0, target.offsetTop - USER_LOCATOR_SCROLL_OFFSET),
          behavior: 'smooth'
        })

        if (highlightedMessageTimerRef.current !== null) {
          window.clearTimeout(highlightedMessageTimerRef.current)
        }
        highlightedMessageTimerRef.current = window.setTimeout(() => {
          setHighlightedMessageId((prev) => (prev === messageId ? null : prev))
          highlightedMessageTimerRef.current = null
        }, USER_LOCATOR_HIGHLIGHT_MS)

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
          {
            align: 'center'
          }
        )
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve())
        })
        scrollToTarget()
      }
    },
    [activeSessionId, markProgrammaticScroll, rowVirtualizer]
  )

  const loadOlderMessages = React.useCallback(async (): Promise<number> => {
    if (!activeSessionId || isLoadingOlderMessages || loadedRangeStart <= 0) return 0

    const ref = listRef.current
    const previousScrollHeight = ref?.scrollHeight ?? 0
    const previousScrollTop = ref?.scrollTop ?? 0

    autoScrollModeRef.current = 'off'
    setIsLoadingOlderMessages(true)
    try {
      const loaded = await useChatStore.getState().loadOlderSessionMessages(activeSessionId)
      if (loaded <= 0) return 0

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
      syncActiveUserLocator()
      return loaded
    } finally {
      setIsLoadingOlderMessages(false)
    }
  }, [
    activeSessionId,
    isLoadingOlderMessages,
    loadedRangeStart,
    markProgrammaticScroll,
    syncActiveUserLocator,
    syncBottomState
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
    syncActiveUserLocator()
    const ref = listRef.current
    if (
      ref &&
      !isLoadingOlderMessages &&
      loadedRangeStart > 0 &&
      ref.scrollTop <= OLDER_MESSAGE_LOAD_SCROLL_THRESHOLD
    ) {
      void loadOlderMessages()
    }
  }, [
    isLoadingOlderMessages,
    loadOlderMessages,
    loadedRangeStart,
    syncActiveUserLocator,
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
  }, [activeSessionId])

  React.useLayoutEffect(() => {
    if (!activeSessionId) return
    if (pendingInitialScrollSessionIdRef.current !== activeSessionId) return
    if (!(messages.length > 0 || streamingMessageId)) return

    if (isSessionOutputting) {
      autoScrollModeRef.current = 'stream'
      requestScrollToBottom({ force: true, maxFrames: INITIAL_SCROLL_SETTLE_FRAMES })
    } else {
      requestScrollToBottom({ force: true, maxFrames: INITIAL_SCROLL_SETTLE_FRAMES })
    }

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

  React.useEffect(() => {
    if (!activeSessionId || isAwaitingInitialMessages || isLoadingOlderMessages) return
    if (loadedRangeStart <= 0 || renderableMessages.length >= MIN_RENDERABLE_HISTORY_ROWS) return
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
    syncActiveUserLocator()
  }, [syncActiveUserLocator])

  React.useEffect(() => {
    return () => {
      if (scheduledScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scheduledScrollFrameRef.current)
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
        className="absolute inset-0 overflow-y-auto"
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
                      onClick={() => void loadOlderMessages()}
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

      <UserMessageLocator
        items={userLocatorItems}
        activeMessageId={activeUserLocatorMessageId}
        onJump={handleJumpToUserMessage}
      />

      {!isAtBottom && messages.length > 0 && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border bg-background/90 px-3 py-1.5 text-xs text-muted-foreground shadow-lg backdrop-blur-sm transition-all duration-200 hover:-translate-y-0.5 hover:text-foreground hover:shadow-xl"
        >
          <ArrowDown className="size-3" />
          {t('messageList.scrollToBottom')}
        </button>
      )}
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
