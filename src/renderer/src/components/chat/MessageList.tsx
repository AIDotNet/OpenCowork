import * as React from 'react'
import { type VListHandle, VList } from 'virtua'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { MessageItem } from './MessageItem'
import { getTailToolExecutionState } from './transcript-utils'
import {
  MessageSquare,
  CircleHelp,
  Briefcase,
  Code2,
  ShieldCheck,
  ArrowDown,
  Loader2
} from 'lucide-react'

import type { ContentBlock, ToolResultContent, UnifiedMessage } from '@renderer/lib/api/types'
import {
  isEditableUserMessage,
  type EditableUserMessageDraft
} from '@renderer/lib/image-attachments'

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
  onRetry?: () => void
  onContinue?: () => void
  onEditUserMessage?: (messageId: string, draft: EditableUserMessageDraft) => void
  onDeleteMessage?: (messageId: string) => void
}

interface RenderableMessage {
  messageId: string
  isLastUserMessage: boolean
  isLastAssistantMessage: boolean
  showContinue: boolean
}

interface RenderableMessageMeta {
  messageId: string
  isLastUserMessage: boolean
  isLastAssistantMessage: boolean
}

interface RenderableMetaBuildResult {
  items: RenderableMessageMeta[]
}

type VirtualRow =
  | { type: 'load-more'; key: string }
  | { type: 'message'; key: string; data: RenderableMessage }

interface VirtualMessageRowProps {
  rowIndex: number
  messageId: string
  isLastUserMessage: boolean
  isLastAssistantMessage: boolean
  showContinue: boolean
  disableAnimation: boolean
  onRetry?: () => void
  onContinue?: () => void
  onEditUserMessage?: (messageId: string, draft: EditableUserMessageDraft) => void
  onDeleteMessage?: (messageId: string) => void
}

const messageLookupCache = new WeakMap<UnifiedMessage[], Map<string, UnifiedMessage>>()

function getMessageLookup(messages: UnifiedMessage[]): Map<string, UnifiedMessage> {
  const cached = messageLookupCache.get(messages)
  if (cached) return cached
  const next = new Map<string, UnifiedMessage>()
  for (const message of messages) {
    next.set(message.id, message)
  }
  messageLookupCache.set(messages, next)
  return next
}

function getToolResultsLookup(
  messages: UnifiedMessage[]
): Map<string, Map<string, { content: ToolResultContent; isError?: boolean }>> {
  const next = new Map<string, Map<string, { content: ToolResultContent; isError?: boolean }>>()
  let currentAssistantMessageId: string | null = null

  for (const message of messages) {
    if (message.role === 'assistant') {
      currentAssistantMessageId = message.id
      continue
    }

    if (isToolResultOnlyUserMessage(message) && currentAssistantMessageId) {
      let results = next.get(currentAssistantMessageId)
      if (!results) {
        results = new Map()
        next.set(currentAssistantMessageId, results)
      }
      collectToolResults(message.content as ContentBlock[], results)
      continue
    }

    currentAssistantMessageId = null
  }

  return next
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false
  }
  return true
}

const EMPTY_MESSAGES: UnifiedMessage[] = []
const LOAD_MORE_MESSAGE_STEP = 160
const AUTO_SCROLL_BOTTOM_THRESHOLD = 80
const STREAMING_AUTO_SCROLL_BOTTOM_THRESHOLD = 150
const LOAD_MORE_ROW_KEY = '__load_more__'
const TAIL_STATIC_MESSAGE_COUNT = 4
const INITIAL_SCROLL_SETTLE_FRAMES = 6
const USER_SEND_SCROLL_SETTLE_FRAMES = 4
const FOLLOW_BOTTOM_SETTLE_FRAMES = 1
const BOTTOM_SCROLL_CORRECTION_EPSILON = 2

function isToolResultOnlyUserMessage(message: UnifiedMessage): boolean {
  return (
    message.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.every((block) => block.type === 'tool_result')
  )
}

function isRealUserMessage(message: UnifiedMessage): boolean {
  return isEditableUserMessage(message)
}

function collectToolResults(
  blocks: ContentBlock[],
  target: Map<string, { content: ToolResultContent; isError?: boolean }>
): void {
  for (const block of blocks) {
    if (block.type === 'tool_result') {
      target.set(block.toolUseId, { content: block.content, isError: block.isError })
    }
  }
}

function buildRenderableMessageMeta(
  messages: UnifiedMessage[],
  streamingMessageId: string | null
): RenderableMetaBuildResult {
  let lastRealUserIndex = -1
  let lastAssistantIndex = -1
  if (!streamingMessageId) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isRealUserMessage(messages[i])) {
        lastRealUserIndex = i
        break
      }
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (isToolResultOnlyUserMessage(message)) continue
    if (message.role === 'assistant') {
      lastAssistantIndex = i
    }
    break
  }

  const result: RenderableMessageMeta[] = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (isToolResultOnlyUserMessage(message)) continue

    result.push({
      messageId: message.id,
      isLastUserMessage: i === lastRealUserIndex,
      isLastAssistantMessage: i === lastAssistantIndex
    })
  }

  return { items: result }
}

function getMessageTailSignal(message: UnifiedMessage | undefined): string {
  if (!message) return ''
  if (typeof message.content === 'string') {
    return `s:${message.content.length}:${message.content.slice(-32)}`
  }

  return `a:${message.content.length}:${JSON.stringify(message.content[message.content.length - 1] ?? null)}`
}

function getDistanceToBottom(ref: VListHandle): number {
  return Math.max(0, ref.scrollSize - ref.scrollOffset - ref.viewportSize)
}

const VirtualMessageRow = React.memo(function VirtualMessageRow({
  rowIndex,
  messageId,
  isLastUserMessage,
  isLastAssistantMessage,
  showContinue,
  disableAnimation,
  onRetry,
  onContinue,
  onEditUserMessage,
  onDeleteMessage
}: VirtualMessageRowProps): React.JSX.Element | null {
  const { activeMessages, isStreaming } = useChatStore(
    useShallow((s) => {
      const activeSession = s.sessions.find((session) => session.id === s.activeSessionId)
      return {
        activeMessages: activeSession?.messages ?? EMPTY_MESSAGES,
        isStreaming: s.streamingMessageId === messageId
      }
    })
  )

  const message = React.useMemo(() => getMessageLookup(activeMessages).get(messageId) ?? null, [activeMessages, messageId])
  const toolResults = React.useMemo(
    () => getToolResultsLookup(activeMessages).get(messageId),
    [activeMessages, messageId]
  )

  if (!message) return null

  return (
    <div data-index={rowIndex} className="mx-auto max-w-3xl px-4 pb-6">
      <MessageItem
        message={message}
        messageId={messageId}
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
      />
    </div>
  )
})

export function MessageList({
  onRetry,
  onContinue,
  onEditUserMessage,
  onDeleteMessage
}: MessageListProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const {
    activeSessionId,
    streamingMessageId,
    activeSessionLoaded,
    activeSessionMessageCount,
    activeWorkingFolder,
    messages
  } = useChatStore(
    useShallow((s) => {
      const activeSession = s.sessions.find((session) => session.id === s.activeSessionId)
      return {
        activeSessionId: s.activeSessionId,
        streamingMessageId: s.streamingMessageId,
        activeSessionLoaded: activeSession?.messagesLoaded ?? true,
        activeSessionMessageCount: activeSession?.messageCount ?? 0,
        activeWorkingFolder: activeSession?.workingFolder,
        messages: activeSession?.messages ?? EMPTY_MESSAGES
      }
    })
  )
  const mode = useUIStore((s) => s.mode)
  const hasStreamingMessage = useChatStore((s) =>
    activeSessionId ? Boolean(s.streamingMessages[activeSessionId]) : false
  )
  const isSessionRunning =
    useAgentStore((s) => s.isSessionActive(activeSessionId)) || hasStreamingMessage
  const listRef = React.useRef<VListHandle | null>(null)
  const [isAtBottom, setIsAtBottom] = React.useState(true)
  const pendingInitialScrollSessionIdRef = React.useRef<string | null>(null)
  const shouldStickToBottomRef = React.useRef(true)
  const latestRealUserCreatedAtRef = React.useRef(0)
  const preserveScrollOnPrependRef = React.useRef<{ offset: number; size: number } | null>(null)
  const scheduledScrollFrameRef = React.useRef<number | null>(null)
  const messageCount = messages.length

  React.useEffect(() => {
    if (!activeSessionId) return
    void useChatStore.getState().loadRecentSessionMessages(activeSessionId)
  }, [activeSessionId])

  const renderableMeta = React.useMemo(
    () => buildRenderableMessageMeta(messages, streamingMessageId),
    [messages, streamingMessageId]
  )

  const continueAssistantMessageId = React.useMemo(() => {
    if (streamingMessageId || isSessionRunning) return null
    return getTailToolExecutionState(messages)?.assistantMessageId ?? null
  }, [isSessionRunning, messages, streamingMessageId])

  const renderableMessages = React.useMemo<RenderableMessage[]>(() => {
    return renderableMeta.items.map((item) => ({
      ...item,
      showContinue: item.messageId === continueAssistantMessageId
    }))
  }, [continueAssistantMessageId, renderableMeta.items])

  const olderUnloadedMessageCount = Math.max(0, activeSessionMessageCount - messages.length)
  const hasLoadMoreRow = olderUnloadedMessageCount > 0

  const virtualRows = React.useMemo<VirtualRow[]>(() => {
    const rows: VirtualRow[] = renderableMessages.map((message) => ({
      type: 'message',
      key: message.messageId,
      data: message
    }))
    if (hasLoadMoreRow) {
      rows.unshift({ type: 'load-more', key: LOAD_MORE_ROW_KEY })
    }
    return rows
  }, [hasLoadMoreRow, renderableMessages])
  const nextVirtualRowKeys = React.useMemo(() => virtualRows.map((row) => row.key), [virtualRows])
  const [stableVirtualRowKeys, setStableVirtualRowKeys] =
    React.useState<string[]>(nextVirtualRowKeys)
  React.useEffect(() => {
    setStableVirtualRowKeys((prev) =>
      areStringArraysEqual(prev, nextVirtualRowKeys) ? prev : nextVirtualRowKeys
    )
  }, [nextVirtualRowKeys])
  const virtualRowKeys = areStringArraysEqual(stableVirtualRowKeys, nextVirtualRowKeys)
    ? stableVirtualRowKeys
    : nextVirtualRowKeys
  const rowByKey = React.useMemo(() => {
    const map = new Map<string, VirtualRow>()
    for (const row of virtualRows) {
      map.set(row.key, row)
    }
    return map
  }, [virtualRows])

  const lastMessageRowIndex = React.useMemo(() => {
    return virtualRowKeys.length - 1
  }, [virtualRowKeys.length])

  const streamingMessageSignal = React.useMemo(() => {
    if (!streamingMessageId) return ''
    return getMessageTailSignal(getMessageLookup(messages).get(streamingMessageId))
  }, [messages, streamingMessageId])

  const latestRealUserCreatedAt = React.useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (isRealUserMessage(message)) {
        return message.createdAt
      }
    }
    return 0
  }, [messages])

  const scrollToBottomImmediate = React.useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      const ref = listRef.current
      const lastIndex = virtualRowKeys.length - 1
      if (!ref || lastIndex < 0) return
      ref.scrollToIndex(lastIndex, { align: 'end', smooth: behavior === 'smooth' })
    },
    [virtualRowKeys.length]
  )

  const syncBottomState = React.useCallback(() => {
    const ref = listRef.current
    if (!ref) return

    const threshold = streamingMessageId
      ? STREAMING_AUTO_SCROLL_BOTTOM_THRESHOLD
      : AUTO_SCROLL_BOTTOM_THRESHOLD
    const nextAtBottom = getDistanceToBottom(ref) <= threshold
    shouldStickToBottomRef.current = nextAtBottom
    setIsAtBottom((prev) => (prev === nextAtBottom ? prev : nextAtBottom))
  }, [streamingMessageId])

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
        scheduledScrollFrameRef.current = null
      }

      let framesLeft = Math.max(1, maxFrames)

      const run = (): void => {
        scheduledScrollFrameRef.current = null
        const ref = listRef.current
        if (!ref) return
        if (!force && !shouldStickToBottomRef.current) return

        if (force || getDistanceToBottom(ref) > BOTTOM_SCROLL_CORRECTION_EPSILON) {
          scrollToBottomImmediate(behavior)
        }
        framesLeft -= 1

        const nextRef = listRef.current
        const needsAnotherFrame =
          framesLeft > 0 &&
          !!nextRef &&
          getDistanceToBottom(nextRef) > BOTTOM_SCROLL_CORRECTION_EPSILON &&
          (force || shouldStickToBottomRef.current)

        if (needsAnotherFrame) {
          scheduledScrollFrameRef.current = window.requestAnimationFrame(run)
          return
        }

        syncBottomState()
      }

      scheduledScrollFrameRef.current = window.requestAnimationFrame(run)
    },
    [scrollToBottomImmediate, syncBottomState]
  )

  React.useEffect(() => {
    return () => {
      if (scheduledScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scheduledScrollFrameRef.current)
      }
    }
  }, [])

  React.useLayoutEffect(() => {
    setIsAtBottom(true)
    pendingInitialScrollSessionIdRef.current = activeSessionId ?? null
    shouldStickToBottomRef.current = true
    latestRealUserCreatedAtRef.current = 0
    preserveScrollOnPrependRef.current = null
  }, [activeSessionId])

  React.useLayoutEffect(() => {
    if (!activeSessionId) return
    if (pendingInitialScrollSessionIdRef.current !== activeSessionId) return

    requestScrollToBottom({ force: true, maxFrames: INITIAL_SCROLL_SETTLE_FRAMES })
    const timer = window.setTimeout(() => {
      requestScrollToBottom({ force: true, maxFrames: INITIAL_SCROLL_SETTLE_FRAMES })
    }, 180)

    if (messageCount > 0 || streamingMessageId) {
      pendingInitialScrollSessionIdRef.current = null
    }

    return () => window.clearTimeout(timer)
  }, [activeSessionId, messageCount, requestScrollToBottom, streamingMessageId])

  React.useLayoutEffect(() => {
    if (!activeSessionId || latestRealUserCreatedAt === 0) return

    const previousCreatedAt = latestRealUserCreatedAtRef.current
    latestRealUserCreatedAtRef.current = latestRealUserCreatedAt

    if (latestRealUserCreatedAt <= previousCreatedAt) return

    shouldStickToBottomRef.current = true
    setIsAtBottom(true)
    requestScrollToBottom({ force: true, maxFrames: USER_SEND_SCROLL_SETTLE_FRAMES })
  }, [activeSessionId, latestRealUserCreatedAt, requestScrollToBottom])

  React.useLayoutEffect(() => {
    const pending = preserveScrollOnPrependRef.current
    if (!pending) return

    const frame = window.requestAnimationFrame(() => {
      const ref = listRef.current
      if (!ref) return
      preserveScrollOnPrependRef.current = null
      const delta = ref.scrollSize - pending.size
      if (delta > 0) {
        ref.scrollTo(pending.offset + delta)
      }
      syncBottomState()
    })

    return () => window.cancelAnimationFrame(frame)
  }, [syncBottomState, virtualRowKeys.length])

  React.useEffect(() => {
    syncBottomState()
  }, [syncBottomState, virtualRowKeys.length])

  React.useEffect(() => {
    if (!shouldStickToBottomRef.current) return
    requestScrollToBottom({ maxFrames: FOLLOW_BOTTOM_SETTLE_FRAMES })
  }, [requestScrollToBottom, virtualRowKeys.length])

  React.useEffect(() => {
    if (!streamingMessageId || !shouldStickToBottomRef.current) return
    requestScrollToBottom({ maxFrames: FOLLOW_BOTTOM_SETTLE_FRAMES })
  }, [requestScrollToBottom, streamingMessageId, streamingMessageSignal])

  const scrollToBottom = React.useCallback(() => {
    shouldStickToBottomRef.current = true
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
      const selection = window.getSelection()
      if (!selection) return
      const range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
      selection.removeAllRanges()
      selection.addRange(range)
    }
  }, [])

  if (!activeSessionLoaded && activeSessionMessageCount > 0) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground/70">
        <Loader2 className="size-4 animate-spin" />
        <span>{t('common.loading', { ns: 'common', defaultValue: 'Loading...' })}</span>
      </div>
    )
  }

  if (messages.length === 0) {
    const hint = modeHints[mode]
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
        <div className="flex flex-col items-center gap-3">
          <div className="rounded-2xl bg-muted/40 p-4">{hint.icon}</div>
          <div>
            <p className="text-base font-semibold text-foreground/80">{t(hint.titleKey)}</p>
            <p className="mt-1.5 max-w-[320px] text-sm text-muted-foreground/60">
              {t(hint.descKey)}
            </p>
          </div>
        </div>
        {mode !== 'chat' && (
          <p className="text-[11px] text-muted-foreground/40">{t('messageList.tipDropFiles')}</p>
        )}
        <div className="flex max-w-[400px] flex-wrap justify-center gap-2">
          {(mode === 'chat'
            ? [
                t('messageList.explainAsync'),
                t('messageList.compareRest'),
                t('messageList.writeRegex')
              ]
            : mode === 'cowork'
              ? activeWorkingFolder
                ? [
                    t('messageList.summarizeProject'),
                    t('messageList.findBugs'),
                    t('messageList.addErrorHandling'),
                    t('messageList.useCommitCommand')
                  ]
                : [
                    t('messageList.reviewCodebase'),
                    t('messageList.addTests'),
                    t('messageList.refactorError')
                  ]
              : activeWorkingFolder
                ? [
                    t('messageList.addFeature'),
                    t('messageList.writeTestsExisting'),
                    t('messageList.optimizePerformance'),
                    t('messageList.useCommitCommand')
                  ]
                : [
                    t('messageList.buildCli'),
                    t('messageList.createRestApi'),
                    t('messageList.writeScript')
                  ]
          ).map((prompt) => (
            <button
              key={prompt}
              className="rounded-lg border bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground"
              onClick={() => {
                applySuggestedPrompt(prompt)
              }}
            >
              {prompt}
            </button>
          ))}
        </div>
        <div className="mt-1 rounded-xl border bg-muted/30 px-5 py-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[11px]">
            <div className="flex items-center gap-2">
              <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                Ctrl+N
              </kbd>
              <span className="text-muted-foreground/60">{t('messageList.newChat')}</span>
            </div>
            <div className="flex items-center gap-2">
              <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                Ctrl+K
              </kbd>
              <span className="text-muted-foreground/60">{t('messageList.commands')}</span>
            </div>
            <div className="flex items-center gap-2">
              <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                Ctrl+B
              </kbd>
              <span className="text-muted-foreground/60">{t('messageList.sidebarShortcut')}</span>
            </div>
            <div className="flex items-center gap-2">
              <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                Ctrl+/
              </kbd>
              <span className="text-muted-foreground/60">{t('messageList.shortcutsShortcut')}</span>
            </div>
            <div className="flex items-center gap-2">
              <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                Ctrl+,
              </kbd>
              <span className="text-muted-foreground/60">{t('messageList.settingsShortcut')}</span>
            </div>
            <div className="flex items-center gap-2">
              <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                Ctrl+D
              </kbd>
              <span className="text-muted-foreground/60">{t('messageList.duplicateShortcut')}</span>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex-1" data-message-list>
      <div className="absolute inset-0" data-message-content>
        <VList
          bufferSize={typeof window !== 'undefined' ? window.innerHeight : 0}
          data={virtualRowKeys}
          ref={listRef}
          style={{ height: '100%', overflowAnchor: 'none' }}
          onScroll={syncBottomState}
        >
          {(rowKey, rowIndex): React.JSX.Element => {
            const row = rowByKey.get(rowKey)
            if (!row) return <div key={rowKey} />
            if (row.type === 'load-more') {
              return (
                <div key={rowKey} data-index={rowIndex} className="mx-auto max-w-3xl px-4">
                  <div className="flex justify-center pb-6 pt-4">
                    <button
                      className="rounded-md border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                      onClick={() => {
                        const ref = listRef.current
                        preserveScrollOnPrependRef.current = ref
                          ? { offset: ref.scrollOffset, size: ref.scrollSize }
                          : null

                        if (!activeSessionId || olderUnloadedMessageCount === 0) {
                          preserveScrollOnPrependRef.current = null
                          return
                        }
                        void useChatStore
                          .getState()
                          .loadOlderSessionMessages(activeSessionId, LOAD_MORE_MESSAGE_STEP)
                          .then((loaded) => {
                            if (loaded > 0) return
                            preserveScrollOnPrependRef.current = null
                          })
                          .catch(() => {
                            preserveScrollOnPrependRef.current = null
                          })
                      }}
                    >
                      {t('messageList.loadMoreMessages', { defaultValue: '加载更早消息' })} (
                      {olderUnloadedMessageCount})
                    </button>
                  </div>
                </div>
              )
            }

            const { messageId, isLastUserMessage, isLastAssistantMessage, showContinue } = row.data
            const disableAnimation =
              lastMessageRowIndex >= 0
                ? rowIndex >= Math.max(0, lastMessageRowIndex - (TAIL_STATIC_MESSAGE_COUNT - 1))
                : false

            return (
              <VirtualMessageRow
                key={rowKey}
                rowIndex={rowIndex}
                messageId={messageId}
                isLastUserMessage={isLastUserMessage}
                isLastAssistantMessage={isLastAssistantMessage}
                showContinue={showContinue}
                disableAnimation={disableAnimation}
                onRetry={onRetry}
                onContinue={onContinue}
                onEditUserMessage={onEditUserMessage}
                onDeleteMessage={onDeleteMessage}
              />
            )
          }}
        </VList>
      </div>

      {!isAtBottom && messageCount > 0 && (
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
