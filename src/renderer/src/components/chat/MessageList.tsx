import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { MessageSquare, CircleHelp, Briefcase, Code2, ShieldCheck, ArrowDown } from 'lucide-react'
import type { ToolResultContent, UnifiedMessage } from '@renderer/lib/api/types'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useAgentStore, type SubAgentState } from '@renderer/stores/agent-store'
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
  | { type: 'load-more'; key: string }
  | { type: 'pending-assistant'; key: string }
  | { type: 'message'; key: string; data: RenderableMessage }

type AutoScrollMode = 'off' | 'user' | 'stream'

type ChatStoreSnapshot = ReturnType<typeof useChatStore.getState>
type AgentStoreSnapshot = ReturnType<typeof useAgentStore.getState>
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
  requestRetryState?: RequestRetryState | null
  renderMode?: 'default' | 'transcript' | 'static'
  onRetry?: () => void
  onContinue?: () => void
  onEditUserMessage?: (messageId: string, draft: EditableUserMessageDraft) => void
  onDeleteMessage?: (messageId: string) => void
}

const EMPTY_MESSAGES: UnifiedMessage[] = []
const EMPTY_SUBAGENT_MAP: Record<string, SubAgentState> = Object.freeze({}) as Record<
  string,
  SubAgentState
>
const EMPTY_SUBAGENT_HISTORY: SubAgentState[] = []
const EMPTY_TEAM_HISTORY: ActiveTeam[] = []
const LOAD_MORE_MESSAGE_STEP = 40
const AUTO_LOAD_OLDER_TOP_THRESHOLD = 200
const AUTO_SCROLL_BOTTOM_THRESHOLD = 24
const STREAMING_AUTO_SCROLL_BOTTOM_THRESHOLD = 80
const STREAMING_AUTO_SCROLL_STOP_THRESHOLD = 240
const LOAD_MORE_ROW_KEY = '__load_more__'
const TAIL_STATIC_MESSAGE_COUNT = 4
const TAIL_LIVE_MESSAGE_COUNT = 6
const INITIAL_SCROLL_SETTLE_FRAMES = 2
const FOLLOW_BOTTOM_SETTLE_FRAMES = 3
const BOTTOM_SCROLL_CORRECTION_EPSILON = 2
const AUTO_SCROLL_MIN_DELTA = 24
const INITIAL_MESSAGE_ESTIMATED_HEIGHT = 120
const PROGRAMMATIC_SCROLL_GUARD_MS = 160
const STREAMING_AUTO_SCROLL_POLL_MS = 500
const PENDING_ASSISTANT_ROW_KEY_PREFIX = '__pending_assistant__'
const EMPTY_ORCHESTRATION_STATE = { runs: [], byId: new Map(), byMessageId: new Map() }
const MESSAGE_COLUMN_CLASS = 'mx-auto w-full max-w-[820px] px-5'
const MESSAGE_COLUMN_COMPACT_CLASS = 'mx-auto w-full max-w-[720px] px-5'

interface MessageListSessionSelection {
  messages: UnifiedMessage[]
  messagesLoaded: boolean
  messageCount: number
  workingFolder?: string
  loadedRangeStart: number
  projectId?: string
}

interface SessionScopedAgentSelection {
  activeSubAgents: Record<string, SubAgentState>
  completedSubAgents: Record<string, SubAgentState>
  subAgentHistory: SubAgentState[]
  hasActiveToolCallOutput: boolean
  isSessionRunning: boolean
  hasOrchestrationData: boolean
  signature: string
}

interface SessionScopedTeamSelection {
  activeTeam: ActiveTeam | null
  teamHistory: ActiveTeam[]
  hasActiveTeam: boolean
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

const EMPTY_SESSION_AGENT_SELECTION: SessionScopedAgentSelection = {
  activeSubAgents: EMPTY_SUBAGENT_MAP,
  completedSubAgents: EMPTY_SUBAGENT_MAP,
  subAgentHistory: EMPTY_SUBAGENT_HISTORY,
  hasActiveToolCallOutput: false,
  isSessionRunning: false,
  hasOrchestrationData: false,
  signature: 'empty'
}

const EMPTY_SESSION_TEAM_SELECTION: SessionScopedTeamSelection = {
  activeTeam: null,
  teamHistory: EMPTY_TEAM_HISTORY,
  hasActiveTeam: false,
  hasOrchestrationData: false,
  signature: 'empty'
}

const sessionScopedAgentSelectionCache = new Map<string, SessionScopedAgentSelection>()
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

function hasSessionSignatureEntry(sig: string, value: string): boolean {
  if (!sig || !value) return false
  return sig.split('\u0000').includes(value)
}

function buildSubAgentRenderSignature(agent: SubAgentState): string {
  return [
    agent.toolUseId,
    agent.sessionId ?? '',
    agent.displayName ?? '',
    agent.name,
    agent.isRunning ? '1' : '0',
    agent.success === null ? '' : agent.success ? '1' : '0',
    agent.errorMessage ?? '',
    String(agent.iteration),
    String(agent.startedAt),
    String(agent.completedAt ?? ''),
    agent.description ?? '',
    agent.prompt ?? '',
    agent.report ?? '',
    agent.streamingText ?? '',
    String(agent.toolCalls.length),
    String(agent.transcript.length)
  ].join('::')
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

function selectSessionScopedAgentState(
  state: AgentStoreSnapshot,
  sessionId: string | null | undefined
): SessionScopedAgentSelection {
  if (!sessionId) return EMPTY_SESSION_AGENT_SELECTION

  let activeSubAgents = EMPTY_SUBAGENT_MAP
  let completedSubAgents = EMPTY_SUBAGENT_MAP
  let subAgentHistory = EMPTY_SUBAGENT_HISTORY
  const signatureParts: string[] = []

  for (const [key, subAgent] of Object.entries(state.activeSubAgents)) {
    if (subAgent.sessionId !== sessionId) continue
    if (activeSubAgents === EMPTY_SUBAGENT_MAP) activeSubAgents = {}
    activeSubAgents[key] = subAgent
    signatureParts.push(`a:${buildSubAgentRenderSignature(subAgent)}`)
  }

  for (const [key, subAgent] of Object.entries(state.completedSubAgents)) {
    if (subAgent.sessionId !== sessionId) continue
    if (completedSubAgents === EMPTY_SUBAGENT_MAP) completedSubAgents = {}
    completedSubAgents[key] = subAgent
    signatureParts.push(`c:${buildSubAgentRenderSignature(subAgent)}`)
  }

  for (const subAgent of state.subAgentHistory) {
    if (subAgent.sessionId !== sessionId) continue
    if (subAgentHistory === EMPTY_SUBAGENT_HISTORY) subAgentHistory = []
    subAgentHistory.push(subAgent)
    signatureParts.push(`h:${buildSubAgentRenderSignature(subAgent)}`)
  }

  let hasActiveToolCallOutput = false
  for (const toolCall of state.pendingToolCalls) {
    if (
      (!toolCall.sessionId || toolCall.sessionId === sessionId) &&
      (toolCall.status === 'running' || toolCall.status === 'streaming')
    ) {
      hasActiveToolCallOutput = true
      break
    }
  }
  if (!hasActiveToolCallOutput) {
    for (const toolCall of state.executedToolCalls) {
      if (
        (!toolCall.sessionId || toolCall.sessionId === sessionId) &&
        (toolCall.status === 'running' || toolCall.status === 'streaming')
      ) {
        hasActiveToolCallOutput = true
        break
      }
    }
  }

  const hasRunningBackgroundProcess = Object.values(state.backgroundProcesses).some(
    (process) => process.sessionId === sessionId && process.status === 'running'
  )

  const isSessionRunning =
    state.runningSessions[sessionId] === 'running' ||
    hasSessionSignatureEntry(state.runningSubAgentSessionIdsSig, sessionId) ||
    hasRunningBackgroundProcess

  signatureParts.unshift(
    `run:${isSessionRunning ? '1' : '0'}`,
    `tool:${hasActiveToolCallOutput ? '1' : '0'}`
  )

  const signature = signatureParts.join('\u0001')
  const cached = sessionScopedAgentSelectionCache.get(sessionId)
  if (cached?.signature === signature) return cached

  const nextSelection: SessionScopedAgentSelection = {
    activeSubAgents,
    completedSubAgents,
    subAgentHistory,
    hasActiveToolCallOutput,
    isSessionRunning,
    hasOrchestrationData:
      activeSubAgents !== EMPTY_SUBAGENT_MAP ||
      completedSubAgents !== EMPTY_SUBAGENT_MAP ||
      subAgentHistory !== EMPTY_SUBAGENT_HISTORY,
    signature
  }

  sessionScopedAgentSelectionCache.set(sessionId, nextSelection)
  return nextSelection
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
    hasActiveTeam: Boolean(activeTeam),
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
  requestRetryState,
  renderMode,
  onRetry,
  onContinue,
  onEditUserMessage,
  onDeleteMessage
}: MessageRowProps): React.JSX.Element {
  const isAnchor = anchorMessageId === message.id

  return (
    <div
      data-message-id={message.id}
      data-anchor={isAnchor ? 'true' : undefined}
      className={`${MESSAGE_COLUMN_CLASS} pb-7`}
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
  } = useAgentStore((s) => selectSessionScopedAgentState(s, activeSessionId))
  const {
    activeTeam,
    teamHistory,
    hasActiveTeam,
    hasOrchestrationData: hasTeamOrchestrationData
  } = useTeamStore((s) => selectSessionScopedTeamState(s, activeSessionId))
  const isSessionRunning = isAgentSessionRunning || hasActiveTeam || hasStreamingMessage
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
  const stableMessagesRef = React.useRef(messages)
  const stableMessagesBindingSignatureRef = React.useRef(orchestrationMessageBindingSignature)
  if (
    (!streamingMessageId && !hasActiveToolCallOutput) ||
    stableMessagesBindingSignatureRef.current !== orchestrationMessageBindingSignature
  ) {
    stableMessagesRef.current = messages
    stableMessagesBindingSignatureRef.current = orchestrationMessageBindingSignature
  }
  const orchestrationMessages = stableMessagesRef.current

  const listRef = React.useRef<HTMLDivElement | null>(null)
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const pendingInitialScrollSessionIdRef = React.useRef<string | null>(null)
  const autoScrollModeRef = React.useRef<AutoScrollMode>('off')
  const preserveScrollOnPrependRef = React.useRef<{
    offset: number
    size: number
    anchorMessageId: string | null
    anchorTop: number | null
  } | null>(null)
  const scheduledScrollFrameRef = React.useRef<number | null>(null)
  const isAutoLoadingOlderRef = React.useRef(false)
  const lastScrollOffsetRef = React.useRef(0)
  const programmaticScrollUntilRef = React.useRef(0)
  const wasSessionOutputtingRef = React.useRef(isSessionOutputting)
  const [isAtBottom, setIsAtBottom] = React.useState(true)

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
      createdAt: Date.now()
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

  const olderUnloadedMessageCount = Math.max(0, loadedRangeStart)
  const hasLoadMoreRow = olderUnloadedMessageCount > 0
  const rows = React.useMemo(() => {
    const nextRows: MessageListRow[] = renderableMessages.map((message) => ({
      type: 'message',
      key: message.messageId,
      data: message
    }))
    if (showPendingAssistantRow) {
      nextRows.push({ type: 'pending-assistant', key: pendingAssistantRowKey })
    }
    if (hasLoadMoreRow) nextRows.unshift({ type: 'load-more', key: LOAD_MORE_ROW_KEY })
    return nextRows
  }, [hasLoadMoreRow, pendingAssistantRowKey, renderableMessages, showPendingAssistantRow])

  const lastMessageRowIndex = rows.length - 1

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

    const intervalId = window.setInterval(() => {
      if (!canAutoScroll()) return
      requestScrollToBottom({ maxFrames: FOLLOW_BOTTOM_SETTLE_FRAMES })
    }, STREAMING_AUTO_SCROLL_POLL_MS)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [canAutoScroll, canSessionTriggerStreamingAutoScroll, requestScrollToBottom])

  const loadOlderMessages = React.useCallback(async (): Promise<void> => {
    if (!activeSessionId || olderUnloadedMessageCount === 0 || isAutoLoadingOlderRef.current) return
    const ref = listRef.current
    const anchorElement =
      containerRef.current?.querySelector<HTMLElement>('[data-message-id]') ?? null
    preserveScrollOnPrependRef.current = ref
      ? {
          offset: ref.scrollTop,
          size: ref.scrollHeight,
          anchorMessageId: anchorElement?.dataset.messageId ?? null,
          anchorTop: anchorElement?.getBoundingClientRect().top ?? null
        }
      : null
    isAutoLoadingOlderRef.current = true
    try {
      await useChatStore
        .getState()
        .loadOlderSessionMessages(activeSessionId, LOAD_MORE_MESSAGE_STEP)
    } finally {
      isAutoLoadingOlderRef.current = false
    }
  }, [activeSessionId, olderUnloadedMessageCount])

  const handleListScroll = React.useCallback(() => {
    syncBottomState()
    const ref = listRef.current
    if (!ref) return
    if (olderUnloadedMessageCount === 0 || isAutoLoadingOlderRef.current) return
    if (ref.scrollTop > AUTO_LOAD_OLDER_TOP_THRESHOLD) return
    void loadOlderMessages()
  }, [loadOlderMessages, olderUnloadedMessageCount, syncBottomState])

  React.useEffect(() => {
    if (!activeSessionId) return
    const viewportHeight = containerRef.current?.clientHeight ?? window.innerHeight ?? 0
    const estimatedLimit = Math.max(
      5,
      Math.ceil(viewportHeight / INITIAL_MESSAGE_ESTIMATED_HEIGHT) + 2
    )
    void useChatStore.getState().loadRecentSessionMessages(activeSessionId, false, estimatedLimit)
  }, [activeSessionId])

  React.useEffect(() => {
    if (!activeSessionId || !streamingMessageId) return

    const hasStreamingMessageInView = messages.some((message) => message.id === streamingMessageId)
    if (hasStreamingMessageInView) return

    const viewportHeight = containerRef.current?.clientHeight ?? window.innerHeight ?? 0
    const estimatedLimit = Math.max(
      5,
      Math.ceil(viewportHeight / INITIAL_MESSAGE_ESTIMATED_HEIGHT) + 2
    )

    void useChatStore.getState().loadRecentSessionMessages(activeSessionId, true, estimatedLimit)
  }, [activeSessionId, messages, streamingMessageId])

  React.useLayoutEffect(() => {
    pendingInitialScrollSessionIdRef.current = activeSessionId
    preserveScrollOnPrependRef.current = null
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

  React.useLayoutEffect(() => {
    const pending = preserveScrollOnPrependRef.current
    if (!pending) return

    const ref = listRef.current
    if (!ref) return

    let restored = false
    if (pending.anchorMessageId && pending.anchorTop !== null) {
      const anchorElement = containerRef.current?.querySelector<HTMLElement>(
        `[data-message-id="${pending.anchorMessageId}"]`
      )
      if (anchorElement) {
        const nextTop = anchorElement.getBoundingClientRect().top
        const delta = nextTop - pending.anchorTop
        if (Math.abs(delta) > BOTTOM_SCROLL_CORRECTION_EPSILON) {
          markProgrammaticScroll()
          ref.scrollTo({ top: ref.scrollTop + delta })
        }
        restored = true
      }
    }

    if (!restored) {
      const delta = ref.scrollHeight - pending.size
      if (delta > 0) {
        markProgrammaticScroll()
        ref.scrollTo({ top: pending.offset + delta })
      }
    }

    preserveScrollOnPrependRef.current = null
    syncBottomState()
  }, [markProgrammaticScroll, rows.length, syncBottomState])

  React.useEffect(() => {
    const wasOutputting = wasSessionOutputtingRef.current
    if (!wasOutputting && isSessionOutputting && isAtBottom) {
      autoScrollModeRef.current = 'stream'
    } else if (wasOutputting && !isSessionOutputting && autoScrollModeRef.current === 'stream') {
      autoScrollModeRef.current = 'off'
    }
    wasSessionOutputtingRef.current = isSessionOutputting
  }, [isAtBottom, isSessionOutputting])

  React.useEffect(() => {
    if (!canAutoScroll()) return
    requestScrollToBottom({ maxFrames: FOLLOW_BOTTOM_SETTLE_FRAMES })
  }, [canAutoScroll, requestScrollToBottom, rows.length])

  React.useEffect(() => {
    return () => {
      if (scheduledScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scheduledScrollFrameRef.current)
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

  return (
    <div ref={containerRef} className="relative flex-1" data-message-list>
      <div
        ref={listRef}
        className="absolute inset-0 overflow-y-auto"
        data-message-content
        style={{ overflowAnchor: 'none' }}
        onScroll={handleListScroll}
      >
        {(() => {
          const anchorMessageId = preserveScrollOnPrependRef.current?.anchorMessageId ?? null
          const liveCutoffIndex = Math.max(0, lastMessageRowIndex - TAIL_LIVE_MESSAGE_COUNT)

          return rows.map((row, rowIndex) => {
            if (row.type === 'load-more') {
              return (
                <div key={row.key} className={MESSAGE_COLUMN_CLASS}>
                  <div className="flex justify-center pb-6 pt-4">
                    <button
                      className="rounded-md border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                      onClick={() => void loadOlderMessages()}
                    >
                      {t('messageList.loadMoreMessages', { defaultValue: '加载更早消息' })} (
                      {olderUnloadedMessageCount})
                    </button>
                  </div>
                </div>
              )
            }

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
                  anchorMessageId={anchorMessageId}
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
                anchorMessageId={anchorMessageId}
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
