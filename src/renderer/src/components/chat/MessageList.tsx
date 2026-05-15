import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useShallow } from 'zustand/react/shallow'
import {
  MessageSquare,
  CircleHelp,
  Briefcase,
  Code2,
  ShieldCheck,
  ArrowDown,
  MessagesSquare
} from 'lucide-react'
import type { ToolResultContent, UnifiedMessage } from '@renderer/lib/api/types'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useTeamStore, type ActiveTeam } from '@renderer/stores/team-store'
import { MessageItem } from './MessageItem'
import {
  buildChatRenderableMessageMetaFromAnalysis,
  buildTranscriptStaticAnalysis,
  type ChatRenderableMessageMeta
} from './transcript-utils'
import { buildOrchestrationRuns } from '@renderer/lib/orchestration/build-runs'
import { type EditableUserMessageDraft } from '@renderer/lib/image-attachments'
import type { RequestRetryState } from '@renderer/lib/agent/types'
import { isStreamingPerfEnabled, recordStreamingReactCommit } from '@renderer/lib/streaming-perf'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { selectSessionScopedAgentState } from '@renderer/lib/agent/session-scoped-agent-state'

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
}

type RenderableMessage = ChatRenderableMessageMeta

type ToolResultsLookup = Map<string, { content: ToolResultContent; isError?: boolean }>

type MessageListRow =
  | { type: 'pending-assistant'; key: string }
  | { type: 'message'; key: string; data: RenderableMessage }

type AutoScrollMode = 'off' | 'user' | 'stream'

interface AskUserQuestionPresence {
  assistantMessageId: string
  toolUseId: string
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
  isStreaming: boolean
  isLastUserMessage: boolean
  isLastAssistantMessage: boolean
  showContinue: boolean
  disableAnimation: boolean
  toolResults?: ToolResultsLookup
  orchestrationRun?: import('@renderer/lib/orchestration/types').OrchestrationRun | null
  hiddenToolUseIds?: Set<string>
  anchorMessageId?: string | null
  highlightMessageId?: string | null
  requestRetryState?: RequestRetryState | null
  renderMode?: 'default' | 'transcript' | 'static'
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
const PENDING_ASSISTANT_ROW_KEY_PREFIX = '__pending_assistant__'
const USER_LOCATOR_PREVIEW_LIMIT = 88
const USER_LOCATOR_SCROLL_OFFSET = 28
const USER_LOCATOR_HIGHLIGHT_MS = 1400
const EMPTY_ORCHESTRATION_STATE = { runs: [], byId: new Map(), byMessageId: new Map() }
const MESSAGE_COLUMN_CLASS = 'mx-auto w-full max-w-[820px] px-5'
const MESSAGE_COLUMN_COMPACT_CLASS = 'mx-auto w-full max-w-[720px] px-5'
const EMPTY_USER_LOCATOR_ROWS: UserMessageIndexRow[] = []

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
    prev.isStreaming === next.isStreaming &&
    prev.isLastUserMessage === next.isLastUserMessage &&
    prev.isLastAssistantMessage === next.isLastAssistantMessage &&
    prev.showContinue === next.showContinue &&
    prev.disableAnimation === next.disableAnimation &&
    (prev.toolResults === next.toolResults ||
      areToolResultsEqual(prev.toolResults, next.toolResults)) &&
    prev.orchestrationRun === next.orchestrationRun &&
    prev.hiddenToolUseIds === next.hiddenToolUseIds &&
    prev.anchorMessageId === next.anchorMessageId &&
    prev.highlightMessageId === next.highlightMessageId &&
    prev.renderMode === next.renderMode &&
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

function getLocatorMarkerTop(position: number): string {
  const clampedPosition = Math.min(1, Math.max(0, position))
  return `${6 + clampedPosition * 88}%`
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

  if (items.length < 2) return null

  return (
    <div className="absolute right-1 top-1/2 z-20 hidden -translate-y-1/2 md:block">
      <div className="group/user-locator relative flex h-[min(52vh,24rem)] items-center justify-end pl-7">
        <div className="relative h-full w-1.5 rounded-full bg-muted-foreground/10 transition-all duration-200 group-hover/user-locator:w-2 group-hover/user-locator:bg-background/80 group-hover/user-locator:ring-1 group-hover/user-locator:ring-border/60">
          {items.map((item) => {
            const active = activeMessageId === item.id
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
                className={`absolute right-0 h-1.5 -translate-y-1/2 rounded-full transition-all duration-200 ${
                  active
                    ? 'w-3 bg-primary ring-1 ring-primary/25'
                    : 'w-1.5 bg-muted-foreground/35 hover:w-3 hover:bg-primary/80'
                }`}
                style={{ top: getLocatorMarkerTop(item.position) }}
                onClick={() => onJump(item)}
              />
            )
          })}
        </div>

        <div className="pointer-events-none absolute right-3.5 top-1/2 w-[min(230px,calc(100vw-5rem))] -translate-y-1/2 translate-x-1.5 opacity-0 transition-all duration-200 group-hover/user-locator:pointer-events-auto group-hover/user-locator:translate-x-0 group-hover/user-locator:opacity-100">
          <div className="overflow-hidden rounded-md border border-border/70 bg-popover/95 text-popover-foreground shadow-lg backdrop-blur-xl">
            <div className="flex items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5">
              <MessagesSquare className="size-3 text-primary" />
              <span className="min-w-0 flex-1 truncate text-xs font-medium">
                {t('messageList.userLocator.title', {
                  defaultValue: 'User messages'
                })}
              </span>
              <span className="text-[10px] tabular-nums text-muted-foreground/70">
                {items.length}
              </span>
            </div>
            <div className="max-h-[min(44vh,18rem)] overflow-y-auto p-1">
              {items.map((item) => {
                const active = activeMessageId === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`flex w-full items-start gap-1.5 rounded-md px-1.5 py-[5px] text-left transition-colors ${
                      active
                        ? 'bg-primary/10 text-foreground'
                        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                    }`}
                    onClick={() => onJump(item)}
                  >
                    <span
                      className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm text-[9px] tabular-nums ${
                        active
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {item.index}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] leading-4">{item.preview}</span>
                      <span className="block text-[9px] leading-3 text-muted-foreground/65">
                        {item.time}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

const MessageRow = React.memo(function MessageRow({
  message,
  sessionId,
  isStreaming,
  isLastUserMessage,
  isLastAssistantMessage,
  showContinue,
  disableAnimation,
  toolResults,
  orchestrationRun,
  hiddenToolUseIds,
  anchorMessageId,
  highlightMessageId,
  requestRetryState,
  renderMode,
  onRetry,
  onContinue,
  onEditUserMessage,
  onDeleteMessage
}: MessageRowProps): React.JSX.Element {
  const isAnchor = anchorMessageId === message.id
  const isHighlighted = highlightMessageId === message.id

  return (
    <div
      data-message-id={message.id}
      data-anchor={isAnchor ? 'true' : undefined}
      className={`${MESSAGE_COLUMN_CLASS} pb-7 transition-colors duration-500 ${
        isHighlighted ? 'rounded-md bg-primary/5 ring-1 ring-primary/20' : ''
      }`}
    >
      <MessageItem
        message={message}
        messageId={message.id}
        sessionId={sessionId}
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
        orchestrationRun={orchestrationRun}
        hiddenToolUseIds={hiddenToolUseIds}
        requestRetryState={requestRetryState}
      />
    </div>
  )
}, areMessageRowPropsEqual)

function MessageListInner(props: MessageListProps): React.JSX.Element {
  const {
    sessionId,
    onRetry,
    onContinue,
    onEditUserMessage,
    onDeleteMessage,
    exportAll = false
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
  const {
    activeTeam,
    teamHistory,
    isTeamRunning,
    hasOrchestrationData: hasTeamOrchestrationData
  } = useTeamStore((s) => selectSessionScopedTeamState(s, activeSessionId))
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
    return tailToolExecutionState?.assistantMessageId ?? null
  }, [isSessionRunning, streamingMessageId, tailToolExecutionState])
  const showPendingAssistantRow = isSessionRunning && !streamingMessageId
  const pendingAssistantRowKey = React.useMemo(
    () =>
      `${PENDING_ASSISTANT_ROW_KEY_PREFIX}:${activeSessionId ?? currentActiveSessionId ?? 'active'}`,
    [activeSessionId, currentActiveSessionId]
  )
  const pendingAssistantMessage = React.useMemo<UnifiedMessage>(
    () => ({
      id: pendingAssistantRowKey,
      role: 'assistant',
      content: '',
      createdAt: 0
    }),
    [pendingAssistantRowKey]
  )

  const renderableMessages = React.useMemo(
    () =>
      buildChatRenderableMessageMetaFromAnalysis(
        transcriptAnalysis,
        streamingMessageId,
        continueAssistantMessageId
      ),
    [continueAssistantMessageId, streamingMessageId, transcriptAnalysis]
  )

  const userLocatorItems = React.useMemo<UserMessageLocatorItem[]>(() => {
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

    return [...sourcesById.values()]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .reduce<UserMessageLocatorItem[]>((items, source) => {
        const item = buildUserLocatorItem(source, items.length + 1, activeSessionMessageCount, t)
        return item ? [...items, item] : items
      }, [])
  }, [activeSessionMessageCount, loadedRangeStart, messages, t, userLocatorRows])

  React.useEffect(() => {
    let cancelled = false

    if (!activeSessionId) {
      setUserLocatorSnapshot({ sessionId: null, rows: EMPTY_USER_LOCATOR_ROWS })
      return
    }

    const loadUserLocatorRows = async (): Promise<void> => {
      try {
        const rows = (await ipcClient.invoke('db:messages:list-user', activeSessionId)) as
          | UserMessageIndexRow[]
          | null
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

  const rows = React.useMemo(() => {
    const nextRows: MessageListRow[] = renderableMessages.map((message) => ({
      type: 'message',
      key: message.messageId,
      data: message
    }))
    if (showPendingAssistantRow) {
      nextRows.push({ type: 'pending-assistant', key: pendingAssistantRowKey })
    }
    return nextRows
  }, [pendingAssistantRowKey, renderableMessages, showPendingAssistantRow])
  const pendingAskUserQuestion = React.useMemo(
    () => findPendingAskUserQuestion(rows, toolResultsLookup, messageLookup),
    [messageLookup, rows, toolResultsLookup]
  )

  const lastMessageRowIndex = rows.length - 1
  const userLocatorItemById = React.useMemo(
    () => new Map(userLocatorItems.map((item) => [item.id, item])),
    [userLocatorItems]
  )

  const canAutoScroll = React.useCallback(() => {
    const mode = autoScrollModeRef.current
    return mode === 'user' || (mode === 'stream' && canSessionTriggerStreamingAutoScroll)
  }, [canSessionTriggerStreamingAutoScroll])

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
    const nextAtBottom = distanceToBottom <= threshold
    const previousOffset = lastScrollOffsetRef.current
    const currentOffset = ref.scrollTop
    const scrolledUp = currentOffset < previousOffset - BOTTOM_SCROLL_CORRECTION_EPSILON
    const isProgrammaticScroll = window.performance.now() < programmaticScrollUntilRef.current

    lastScrollOffsetRef.current = currentOffset

    if (
      scrolledUp &&
      distanceToBottom > STREAMING_AUTO_SCROLL_STOP_THRESHOLD &&
      !isProgrammaticScroll
    ) {
      autoScrollModeRef.current = 'off'
    } else if (nextAtBottom && isSessionOutputting && autoScrollModeRef.current === 'off') {
      autoScrollModeRef.current = 'stream'
    }

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

      await useChatStore.getState().loadSessionMessages(activeSessionId)

      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => resolve())
        })
      })

      scrollToTarget()
    },
    [activeSessionId, markProgrammaticScroll]
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
    syncActiveUserLocator()
  }, [syncActiveUserLocator, syncBottomState])

  React.useEffect(() => {
    if (!activeSessionId) return
    void useChatStore.getState().loadSessionMessages(activeSessionId)
  }, [activeSessionId])

  React.useEffect(() => {
    if (!activeSessionId || !streamingMessageId) return

    const hasStreamingMessageInView = messages.some((message) => message.id === streamingMessageId)
    if (hasStreamingMessageInView) return

    void useChatStore.getState().loadSessionMessages(activeSessionId, true)
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

  const isAwaitingInitialMessages =
    Boolean(activeSessionId) &&
    messages.length === 0 &&
    (!activeSessionLoaded || activeSessionMessageCount > 0 || loadedRangeStart > 0)

  if (isAwaitingInitialMessages) {
    return (
      <div className="flex flex-1 flex-col gap-4 overflow-hidden px-4 pt-6">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className={`${MESSAGE_COLUMN_CLASS} space-y-2 ${
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

  if (messages.length === 0 && !showPendingAssistantRow) {
    const hint = modeHints[mode]
    const projectScoped = Boolean(activeProjectId)
    const emptyTitle = projectScoped
      ? `What should we build in ${activeProjectName ?? 'this project'}?`
      : mode === 'chat'
        ? 'What should we talk through?'
        : t(hint.titleKey)
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <div className={`flex flex-col items-center gap-3 ${MESSAGE_COLUMN_COMPACT_CLASS}`}>
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
                isStreaming={streamingMessageId === row.messageId}
                isLastUserMessage={row.isLastUserMessage}
                isLastAssistantMessage={row.isLastAssistantMessage}
                showContinue={row.showContinue}
                disableAnimation
                toolResults={toolResultsLookup.get(row.messageId)}
                orchestrationRun={
                  orchestrationState.byMessageId.get(row.messageId)?.primaryRun ?? null
                }
                hiddenToolUseIds={
                  orchestrationState.byMessageId.get(row.messageId)?.hiddenToolUseIds
                }
                anchorMessageId={null}
                highlightMessageId={null}
                requestRetryState={
                  row.isLastAssistantMessage ? (sessionRequestRetryState ?? null) : null
                }
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
        {(() => {
          const liveCutoffIndex = Math.max(0, lastMessageRowIndex - TAIL_LIVE_MESSAGE_COUNT)

          return rows.map((row, rowIndex) => {
            const disableAnimation =
              lastMessageRowIndex >= 0
                ? rowIndex >= Math.max(0, lastMessageRowIndex - (TAIL_STATIC_MESSAGE_COUNT - 1))
                : false

            if (row.type === 'pending-assistant') {
              return (
                <MessageRow
                  key={row.key}
                  message={pendingAssistantMessage}
                  sessionId={targetSessionId}
                  isStreaming
                  isLastUserMessage={false}
                  isLastAssistantMessage
                  showContinue={false}
                  disableAnimation={disableAnimation}
                  toolResults={undefined}
                  orchestrationRun={null}
                  hiddenToolUseIds={undefined}
                  anchorMessageId={null}
                  highlightMessageId={highlightedMessageId}
                  requestRetryState={sessionRequestRetryState ?? null}
                  onRetry={onRetry}
                  onContinue={onContinue}
                  onEditUserMessage={onEditUserMessage}
                  onDeleteMessage={onDeleteMessage}
                />
              )
            }

            const { messageId, isLastUserMessage, isLastAssistantMessage, showContinue } = row.data
            const message = messageLookup.get(messageId)
            if (!message) return null

            const isStreaming = streamingMessageId === messageId
            const rowRenderMode = !isStreaming && rowIndex < liveCutoffIndex ? 'static' : undefined

            return (
              <MessageRow
                key={row.key}
                message={message}
                sessionId={targetSessionId}
                isStreaming={isStreaming}
                isLastUserMessage={isLastUserMessage}
                isLastAssistantMessage={isLastAssistantMessage}
                showContinue={showContinue}
                disableAnimation={disableAnimation}
                toolResults={toolResultsLookup.get(messageId)}
                orchestrationRun={orchestrationState.byMessageId.get(messageId)?.primaryRun ?? null}
                hiddenToolUseIds={orchestrationState.byMessageId.get(messageId)?.hiddenToolUseIds}
                anchorMessageId={null}
                highlightMessageId={highlightedMessageId}
                renderMode={rowRenderMode}
                requestRetryState={
                  isLastAssistantMessage ? (sessionRequestRetryState ?? null) : null
                }
                onRetry={onRetry}
                onContinue={onContinue}
                onEditUserMessage={onEditUserMessage}
                onDeleteMessage={onDeleteMessage}
              />
            )
          })
        })()}
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
    prev.exportAll === next.exportAll
  )
}

export const MessageList = React.memo(MessageListInner, areMessageListPropsEqual)
