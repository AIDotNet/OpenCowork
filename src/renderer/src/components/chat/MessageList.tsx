import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { MessageSquare, CircleHelp, Briefcase, Code2, ShieldCheck, ArrowDown } from 'lucide-react'
import type { ContentBlock, ToolResultContent, UnifiedMessage } from '@renderer/lib/api/types'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useTeamStore } from '@renderer/stores/team-store'
import { MessageItem } from './MessageItem'
import {
  buildChatRenderableMessageMeta,
  getMessageLookup,
  getTailToolExecutionState,
  getToolResultsLookup,
  type ChatRenderableMessageMeta
} from './transcript-utils'
import { buildOrchestrationRuns } from '@renderer/lib/orchestration/build-runs'
import { type EditableUserMessageDraft } from '@renderer/lib/image-attachments'

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
  | { type: 'message'; key: string; data: RenderableMessage }

type AutoScrollMode = 'off' | 'user' | 'stream'

interface MessageRowProps {
  rowIndex: number
  message: UnifiedMessage
  isStreaming: boolean
  isLastUserMessage: boolean
  isLastAssistantMessage: boolean
  showContinue: boolean
  disableAnimation: boolean
  toolResults?: ToolResultsLookup
  orchestrationRun?: import('@renderer/lib/orchestration/types').OrchestrationRun | null
  hiddenToolUseIds?: Set<string>
  anchorMessageId?: string | null
  onRetry?: () => void
  onContinue?: () => void
  onEditUserMessage?: (messageId: string, draft: EditableUserMessageDraft) => void
  onDeleteMessage?: (messageId: string) => void
}

const EMPTY_MESSAGES: UnifiedMessage[] = []
const LOAD_MORE_MESSAGE_STEP = 40
const AUTO_LOAD_OLDER_TOP_THRESHOLD = 200
const AUTO_SCROLL_BOTTOM_THRESHOLD = 24
const STREAMING_AUTO_SCROLL_BOTTOM_THRESHOLD = 80
const STREAMING_AUTO_SCROLL_STOP_THRESHOLD = 240
const LOAD_MORE_ROW_KEY = '__load_more__'
const TAIL_STATIC_MESSAGE_COUNT = 4
const INITIAL_SCROLL_SETTLE_FRAMES = 2
const FOLLOW_BOTTOM_SETTLE_FRAMES = 3
const BOTTOM_SCROLL_CORRECTION_EPSILON = 2
const AUTO_SCROLL_MIN_DELTA = 24
const INITIAL_MESSAGE_ESTIMATED_HEIGHT = 120
const PROGRAMMATIC_SCROLL_GUARD_MS = 160
const STREAMING_AUTO_SCROLL_POLL_MS = 500
const EMPTY_ORCHESTRATION_STATE = { runs: [], byId: new Map(), byMessageId: new Map() }
const MESSAGE_COLUMN_CLASS = 'mx-auto w-full max-w-[820px] px-5'
const MESSAGE_COLUMN_COMPACT_CLASS = 'mx-auto w-full max-w-[720px] px-5'

function getDistanceToBottom(ref: HTMLDivElement): number {
  return Math.max(0, ref.scrollHeight - ref.scrollTop - ref.clientHeight)
}

function buildOrchestrationMessageBindingSignature(messages: UnifiedMessage[]): string {
  return messages
    .map((message) => {
      if (message.role !== 'assistant') {
        return `${message.id}:${message.role}`
      }

      if (!Array.isArray(message.content)) {
        return `${message.id}:${message.role}:string`
      }

      const toolUseSignature = (message.content as ContentBlock[])
        .filter(
          (block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use'
        )
        .map((block) => {
          const teamName =
            typeof block.input.team_name === 'string' ? block.input.team_name.trim() : ''
          const runsInBackground = block.input.run_in_background === true ? 'bg' : 'fg'
          return `${block.id}:${block.name}:${teamName}:${runsInBackground}`
        })
        .join(',')

      return `${message.id}:${message.role}:blocks:${message.content.length}:${toolUseSignature}`
    })
    .join('|')
}

const MessageRow = React.memo(function MessageRow({
  rowIndex,
  message,
  isStreaming,
  isLastUserMessage,
  isLastAssistantMessage,
  showContinue,
  disableAnimation,
  toolResults,
  orchestrationRun,
  hiddenToolUseIds,
  anchorMessageId,
  onRetry,
  onContinue,
  onEditUserMessage,
  onDeleteMessage
}: MessageRowProps): React.JSX.Element {
  return (
    <div
      data-index={rowIndex}
      data-message-id={message.id}
      data-anchor={anchorMessageId === message.id ? 'true' : undefined}
      className={`${MESSAGE_COLUMN_CLASS} pb-7`}
    >
      <MessageItem
        message={message}
        messageId={message.id}
        isStreaming={isStreaming}
        isLastUserMessage={isLastUserMessage}
        isLastAssistantMessage={isLastAssistantMessage}
        showContinue={showContinue}
        disableAnimation={disableAnimation}
        onRetryAssistantMessage={onRetry}
        onContinueAssistantMessage={onContinue}
        onEditUserMessage={onEditUserMessage}
        onDeleteMessage={onDeleteMessage}
        toolResults={toolResults}
        orchestrationRun={orchestrationRun}
        hiddenToolUseIds={hiddenToolUseIds}
      />
    </div>
  )
})

export function MessageList(props: MessageListProps): React.JSX.Element {
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
  const targetSession = useChatStore((s) => {
    if (!targetSessionId) return undefined
    const idx = s.sessionsById[targetSessionId]
    return idx === undefined ? undefined : s.sessions[idx]
  })
  const messages = targetSession?.messages ?? EMPTY_MESSAGES
  const activeSessionLoaded = targetSession?.messagesLoaded ?? true
  const activeSessionMessageCount = targetSession?.messageCount ?? 0
  const activeWorkingFolder = targetSession?.workingFolder
  const activeProjectName = useChatStore((s) => {
    const targetProjectId = targetSessionId
      ? (s.sessions[s.sessionsById[targetSessionId] ?? -1]?.projectId ?? null)
      : null
    if (!targetProjectId) return null
    return s.projects.find((project) => project.id === targetProjectId)?.name ?? null
  })
  const loadedRangeStart = targetSession?.loadedRangeStart ?? 0
  const streamingMessageId = useChatStore((s) =>
    targetSessionId ? (s.streamingMessages[targetSessionId] ?? null) : null
  )
  const activeSessionId = targetSessionId
  const isMainChatSession =
    !sessionId && Boolean(activeSessionId) && activeSessionId === currentActiveSessionId
  const mode = useUIStore((s) => s.mode)
  const hasStreamingMessage = useChatStore((s) =>
    activeSessionId ? Boolean(s.streamingMessages[activeSessionId]) : false
  )
  const { activeSubAgents, completedSubAgents, subAgentHistory } = useAgentStore(
    useShallow((s) => ({
      activeSubAgents: s.activeSubAgents,
      completedSubAgents: s.completedSubAgents,
      subAgentHistory: s.subAgentHistory
    }))
  )
  const { activeTeam, teamHistory } = useTeamStore(
    useShallow((s) => ({ activeTeam: s.activeTeam, teamHistory: s.teamHistory }))
  )
  const isSessionRunning =
    useAgentStore((s) => s.isSessionActive(activeSessionId)) || hasStreamingMessage
  const canSessionTriggerStreamingAutoScroll = isMainChatSession && isSessionRunning

  const orchestrationMessageBindingSignature = React.useMemo(
    () => buildOrchestrationMessageBindingSignature(messages),
    [messages]
  )
  const stableMessagesRef = React.useRef(messages)
  const stableMessagesBindingSignatureRef = React.useRef(orchestrationMessageBindingSignature)
  if (
    !streamingMessageId ||
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
  const wasSessionRunningRef = React.useRef(isSessionRunning)
  const [isAtBottom, setIsAtBottom] = React.useState(true)

  const messageLookup = React.useMemo(() => getMessageLookup(messages), [messages])
  const toolResultsLookup = React.useMemo(() => getToolResultsLookup(messages), [messages])
  const hasSessionOrchestrationData = React.useMemo(() => {
    if (
      activeTeam &&
      (!activeSessionId || !activeTeam.sessionId || activeTeam.sessionId === activeSessionId)
    ) {
      return true
    }

    if (teamHistory.some((team) => !activeSessionId || team.sessionId === activeSessionId)) {
      return true
    }

    if (
      Object.values(activeSubAgents).some(
        (item) => !activeSessionId || item.sessionId === activeSessionId
      )
    ) {
      return true
    }

    if (
      Object.values(completedSubAgents).some(
        (item) => !activeSessionId || item.sessionId === activeSessionId
      )
    ) {
      return true
    }

    return subAgentHistory.some((item) => !activeSessionId || item.sessionId === activeSessionId)
  }, [
    activeSessionId,
    activeSubAgents,
    activeTeam,
    completedSubAgents,
    subAgentHistory,
    teamHistory
  ])
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
    return getTailToolExecutionState(messages)?.assistantMessageId ?? null
  }, [isSessionRunning, messages, streamingMessageId])

  const renderableMessages = React.useMemo(
    () => buildChatRenderableMessageMeta(messages, streamingMessageId, continueAssistantMessageId),
    [messages, streamingMessageId, continueAssistantMessageId]
  )

  const olderUnloadedMessageCount = Math.max(0, loadedRangeStart)
  const hasLoadMoreRow = olderUnloadedMessageCount > 0
  const rows = React.useMemo(() => {
    const nextRows: MessageListRow[] = renderableMessages.map((message) => ({
      type: 'message',
      key: message.messageId,
      data: message
    }))
    if (hasLoadMoreRow) nextRows.unshift({ type: 'load-more', key: LOAD_MORE_ROW_KEY })
    return nextRows
  }, [hasLoadMoreRow, renderableMessages])

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
    const threshold = isSessionRunning
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
    } else if (nextAtBottom && isSessionRunning && autoScrollModeRef.current === 'off') {
      autoScrollModeRef.current = 'stream'
    }

    setIsAtBottom((prev) => (prev === nextAtBottom ? prev : nextAtBottom))
  }, [isSessionRunning])

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
    pendingInitialScrollSessionIdRef.current = activeSessionId
    preserveScrollOnPrependRef.current = null
    lastScrollOffsetRef.current = 0
    programmaticScrollUntilRef.current = 0
  }, [activeSessionId])

  React.useLayoutEffect(() => {
    if (!activeSessionId) return
    if (pendingInitialScrollSessionIdRef.current !== activeSessionId) return
    if (!(messages.length > 0 || streamingMessageId)) return

    if (isSessionRunning) {
      autoScrollModeRef.current = 'stream'
      requestScrollToBottom({ force: true, maxFrames: INITIAL_SCROLL_SETTLE_FRAMES })
    } else {
      requestScrollToBottom({ force: true, maxFrames: INITIAL_SCROLL_SETTLE_FRAMES })
    }

    pendingInitialScrollSessionIdRef.current = null
  }, [
    activeSessionId,
    isSessionRunning,
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
    const wasRunning = wasSessionRunningRef.current
    if (!wasRunning && isSessionRunning && isAtBottom) {
      autoScrollModeRef.current = 'stream'
    } else if (wasRunning && !isSessionRunning && autoScrollModeRef.current === 'stream') {
      autoScrollModeRef.current = 'off'
    }
    wasSessionRunningRef.current = isSessionRunning
  }, [isAtBottom, isSessionRunning])

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

  if (messages.length === 0) {
    const hint = modeHints[mode]
    const projectScoped = Boolean(targetSession?.projectId)
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
          {renderableMessages.map((row, rowIndex) => {
            const message = messageLookup.get(row.messageId)
            if (!message) return null

            return (
              <MessageRow
                key={row.messageId}
                rowIndex={rowIndex}
                message={message}
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
        {rows.map((row, rowIndex) => {
          if (row.type === 'load-more') {
            return (
              <div key={row.key} data-index={rowIndex} className={MESSAGE_COLUMN_CLASS}>
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

          const { messageId, isLastUserMessage, isLastAssistantMessage, showContinue } = row.data
          const message = messageLookup.get(messageId)
          if (!message) return null

          const disableAnimation =
            lastMessageRowIndex >= 0
              ? rowIndex >= Math.max(0, lastMessageRowIndex - (TAIL_STATIC_MESSAGE_COUNT - 1))
              : false

          return (
            <MessageRow
              key={row.key}
              rowIndex={rowIndex}
              message={message}
              isStreaming={streamingMessageId === messageId}
              isLastUserMessage={isLastUserMessage}
              isLastAssistantMessage={isLastAssistantMessage}
              showContinue={showContinue}
              disableAnimation={disableAnimation}
              toolResults={toolResultsLookup.get(messageId)}
              orchestrationRun={orchestrationState.byMessageId.get(messageId)?.primaryRun ?? null}
              hiddenToolUseIds={orchestrationState.byMessageId.get(messageId)?.hiddenToolUseIds}
              anchorMessageId={preserveScrollOnPrependRef.current?.anchorMessageId ?? null}
              onRetry={onRetry}
              onContinue={onContinue}
              onEditUserMessage={onEditUserMessage}
              onDeleteMessage={onDeleteMessage}
            />
          )
        })}
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
