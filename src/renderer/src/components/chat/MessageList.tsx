import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { MessageItem } from './MessageItem'
import { MessageSquare, Briefcase, Code2, RefreshCw, ArrowDown, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'

import type { ContentBlock, ToolResultContent, UnifiedMessage } from '@renderer/lib/api/types'
import type { ToolCallState } from '@renderer/lib/agent/types'


const modeHints = {
  chat: {
    icon: <MessageSquare className="size-12 text-muted-foreground/20" />,
    titleKey: 'messageList.startConversation',
    descKey: 'messageList.startConversationDesc',
  },
  cowork: {
    icon: <Briefcase className="size-12 text-muted-foreground/20" />,
    titleKey: 'messageList.startCowork',
    descKey: 'messageList.startCoworkDesc',
  },
  code: {
    icon: <Code2 className="size-12 text-muted-foreground/20" />,
    titleKey: 'messageList.startCoding',
    descKey: 'messageList.startCodingDesc',
  },
}

interface MessageListProps {
  onRetry?: () => void
  onEditUserMessage?: (newContent: string) => void
}

interface RenderableMessage {
  message: UnifiedMessage
  isLastUserMessage: boolean
  toolResults?: Map<string, { content: ToolResultContent; isError?: boolean }>
}

interface RenderableMessageMeta {
  messageIndex: number
  isLastUserMessage: boolean
  toolResults?: Map<string, { content: ToolResultContent; isError?: boolean }>
}

interface RenderableMetaBuildResult {
  items: RenderableMessageMeta[]
  hasAssistantMessages: boolean
}

const EMPTY_MESSAGES: UnifiedMessage[] = []
const INITIAL_VISIBLE_MESSAGE_COUNT = 120
const LOAD_MORE_MESSAGE_STEP = 80

function isToolResultOnlyUserMessage(message: UnifiedMessage): boolean {
  return (
    message.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.every((block) => block.type === 'tool_result')
  )
}

function isRealUserMessage(message: UnifiedMessage): boolean {
  if (message.role !== 'user' || message.source) return false
  if (typeof message.content === 'string') return true
  return message.content.some((block) => block.type === 'text')
}

function collectToolResults(blocks: ContentBlock[], target: Map<string, { content: ToolResultContent; isError?: boolean }>): void {
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
  if (!streamingMessageId) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isRealUserMessage(messages[i])) {
        lastRealUserIndex = i
        break
      }
    }
  }

  const assistantToolResults = new Map<number, Map<string, { content: ToolResultContent; isError?: boolean }>>()
  let trailingToolResults: Map<string, { content: ToolResultContent; isError?: boolean }> | undefined

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (isToolResultOnlyUserMessage(message)) {
      if (!trailingToolResults) trailingToolResults = new Map()
      collectToolResults(message.content as ContentBlock[], trailingToolResults)
      continue
    }

    if (message.role === 'assistant' && Array.isArray(message.content) && trailingToolResults && trailingToolResults.size > 0) {
      assistantToolResults.set(i, trailingToolResults)
    }
    trailingToolResults = undefined
  }

  const result: RenderableMessageMeta[] = []
  let hasAssistantMessages = false
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (isToolResultOnlyUserMessage(message)) continue
    if (message.role === 'assistant') hasAssistantMessages = true

    result.push({
      messageIndex: i,
      isLastUserMessage: i === lastRealUserIndex,
      toolResults: assistantToolResults.get(i),
    })
  }
  return { items: result, hasAssistantMessages }
}

export function MessageList({ onRetry, onEditUserMessage }: MessageListProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const activeSession = useChatStore((s) => s.sessions.find((session) => session.id === s.activeSessionId))
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const streamingMessageId = useChatStore((s) => s.streamingMessageId)
  const mode = useUIStore((s) => s.mode)
  const scrollContainerRef = React.useRef<HTMLDivElement>(null)
  const bottomRef = React.useRef<HTMLDivElement>(null)
  const [isAtBottom, setIsAtBottom] = React.useState(true)
  const isStreamingRef = React.useRef(false)
  isStreamingRef.current = !!streamingMessageId

  const messages = activeSession?.messages ?? EMPTY_MESSAGES
  React.useEffect(() => {
    if (!activeSessionId) return
    void useChatStore.getState().loadSessionMessages(activeSessionId)
  }, [activeSessionId])

  const messageShapeHeadId = messages[0]?.id ?? null
  const messageShapeTailId = messages[messages.length - 1]?.id ?? null
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const renderableMeta = React.useMemo(
    () => buildRenderableMessageMeta(messages, streamingMessageId),
    // Structural deps only: avoid re-running expensive content scan for each streaming text delta.
    [activeSessionId, streamingMessageId, messages.length, messageShapeHeadId, messageShapeTailId]
  )
  const [visibleCount, setVisibleCount] = React.useState(INITIAL_VISIBLE_MESSAGE_COUNT)
  const visibleRenderableMeta = React.useMemo(() => {
    const startIndex = Math.max(0, renderableMeta.items.length - visibleCount)
    return renderableMeta.items.slice(startIndex)
  }, [renderableMeta.items, visibleCount])
  const visibleRenderableMessages = React.useMemo<RenderableMessage[]>(() => {
    const result: RenderableMessage[] = []
    for (const item of visibleRenderableMeta) {
      const message = messages[item.messageIndex]
      if (!message || isToolResultOnlyUserMessage(message)) continue
      result.push({
        message,
        isLastUserMessage: item.isLastUserMessage,
        toolResults: item.toolResults,
      })
    }
    return result
  }, [visibleRenderableMeta, messages])
  const hiddenMessageCount = Math.max(0, renderableMeta.items.length - visibleRenderableMeta.length)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const hasAssistantMessages = renderableMeta.hasAssistantMessages

  React.useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_MESSAGE_COUNT)
  }, [activeSessionId])

  // Use content reference as a lightweight streaming update signal (avoid JSON.stringify on large blocks)
  const streamingMsg = React.useMemo(
    () => (streamingMessageId ? messages.find((message) => message.id === streamingMessageId) ?? null : null),
    [messages, streamingMessageId]
  )
  const streamContentSignal = streamingMsg?.content

  // Track tool call state changes as additional scroll trigger
  // (tool cards render/expand during streaming → running → completed transitions)
  const executedToolCalls = useAgentStore((s) => s.executedToolCalls)
  const pendingToolCalls = useAgentStore((s) => s.pendingToolCalls)
  const liveToolCallMap = React.useMemo<Map<string, ToolCallState> | null>(() => {
    if (!streamingMessageId) return null
    const map = new Map<string, ToolCallState>()
    for (const toolCall of executedToolCalls) map.set(toolCall.id, toolCall)
    for (const toolCall of pendingToolCalls) map.set(toolCall.id, toolCall)
    return map
  }, [streamingMessageId, executedToolCalls, pendingToolCalls])
  const toolCallFingerprint = React.useMemo(() => {
    const parts: string[] = []
    for (const tc of executedToolCalls) parts.push(`${tc.id}:${tc.status}`)
    for (const tc of pendingToolCalls) parts.push(`${tc.id}:${tc.status}`)
    return parts.join(',')
  }, [executedToolCalls, pendingToolCalls])

  // Track if user is near the bottom via scroll position
  // Use larger threshold during streaming so rapid content growth doesn't break auto-scroll
  React.useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    const handleScroll = (): void => {
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
      const threshold = isStreamingRef.current ? 150 : 5
      const nextAtBottom = distanceFromBottom <= threshold
      setIsAtBottom((prev) => (prev === nextAtBottom ? prev : nextAtBottom))
    }

    handleScroll()
    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => container.removeEventListener('scroll', handleScroll)
  }, [activeSessionId])

  // Auto-scroll to bottom on new messages, streaming content, and tool call state changes
  React.useEffect(() => {
    if (!isAtBottom) return
    const container = scrollContainerRef.current
    if (!container) return

    if (isStreamingRef.current) {
      // Instant scroll during streaming — smooth animation can't keep up with rapid updates
      container.scrollTop = container.scrollHeight
    } else {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages.length, streamingMessageId, streamContentSignal, toolCallFingerprint, isAtBottom])

  // Follow DOM height changes during streaming (covers typewriter-driven growth
  // that happens between store updates and is not caught by streamContentLen).
  React.useEffect(() => {
    if (!streamingMessageId) return
    const container = scrollContainerRef.current
    if (!container) return

    let lastHeight = container.scrollHeight
    let lastTick = 0
    let rafId: number

    const follow = (now: number): void => {
      if (now - lastTick >= 33) {
        lastTick = now
        const h = container.scrollHeight
        if (h !== lastHeight) {
          lastHeight = h
          const dist = h - container.scrollTop - container.clientHeight
          if (dist <= 150) container.scrollTop = h
        }
      }
      rafId = requestAnimationFrame(follow)
    }

    rafId = requestAnimationFrame(follow)
    return () => cancelAnimationFrame(rafId)
  }, [streamingMessageId])

  const scrollToBottom = React.useCallback(() => {
    const container = scrollContainerRef.current
    if (container) container.scrollTop = container.scrollHeight
  }, [])

  if (activeSession && !activeSession.messagesLoaded && activeSession.messageCount > 0) {
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
      <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center px-6">
        <div className="flex flex-col items-center gap-3">
          <div className="rounded-2xl bg-muted/40 p-4">
            {hint.icon}
          </div>
          <div>
            <p className="text-base font-semibold text-foreground/80">{t(hint.titleKey)}</p>
            <p className="mt-1.5 text-sm text-muted-foreground/60 max-w-[320px]">{t(hint.descKey)}</p>
          </div>
        </div>
        {mode !== 'chat' && (
          <p className="text-[11px] text-muted-foreground/40">
            {t('messageList.tipDropFiles')}
          </p>
        )}
        <div className="flex flex-wrap justify-center gap-2 max-w-[400px]">
          {(mode === 'chat' ? [
            t('messageList.explainAsync'),
            t('messageList.compareRest'),
            t('messageList.writeRegex'),
          ] : mode === 'cowork' ? (activeSession?.workingFolder ? [
            t('messageList.summarizeProject'),
            t('messageList.findBugs'),
            t('messageList.addErrorHandling'),
          ] : [
            t('messageList.reviewCodebase'),
            t('messageList.addTests'),
            t('messageList.refactorError'),
          ]) : (activeSession?.workingFolder ? [
            t('messageList.addFeature'),
            t('messageList.writeTestsExisting'),
            t('messageList.optimizePerformance'),
          ] : [
            t('messageList.buildCli'),
            t('messageList.createRestApi'),
            t('messageList.writeScript'),
          ])).map((prompt) => (
            <button
              key={prompt}
              className="rounded-lg border bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground/60 hover:text-foreground hover:bg-muted/60 transition-colors"
              onClick={() => {
                const textarea = document.querySelector('textarea')
                if (textarea) {
                  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
                  nativeInputValueSetter?.call(textarea, prompt)
                  textarea.dispatchEvent(new Event('input', { bubbles: true }))
                  textarea.focus()
                }
              }}
            >
              {prompt}
            </button>
          ))}
        </div>
        <div className="mt-1 rounded-xl border bg-muted/30 px-5 py-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[11px]">
            <div className="flex items-center gap-2"><kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">Ctrl+N</kbd><span className="text-muted-foreground/60">{t('messageList.newChat')}</span></div>
            <div className="flex items-center gap-2"><kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">Ctrl+K</kbd><span className="text-muted-foreground/60">{t('messageList.commands')}</span></div>
            <div className="flex items-center gap-2"><kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">Ctrl+B</kbd><span className="text-muted-foreground/60">{t('messageList.sidebarShortcut')}</span></div>
            <div className="flex items-center gap-2"><kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">Ctrl+/</kbd><span className="text-muted-foreground/60">{t('messageList.shortcutsShortcut')}</span></div>
            <div className="flex items-center gap-2"><kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">Ctrl+,</kbd><span className="text-muted-foreground/60">{t('messageList.settingsShortcut')}</span></div>
            <div className="flex items-center gap-2"><kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">Ctrl+D</kbd><span className="text-muted-foreground/60">{t('messageList.duplicateShortcut')}</span></div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex-1">
      <div ref={scrollContainerRef} className="absolute inset-0 overflow-y-auto">
        <div ref={contentRef} data-message-content className="mx-auto max-w-3xl space-y-6 p-4 overflow-hidden">
          {hiddenMessageCount > 0 && (
            <div className="flex justify-center">
              <button
                className="rounded-md border px-3 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                onClick={() => setVisibleCount((prev) => prev + LOAD_MORE_MESSAGE_STEP)}
              >
                {t('messageList.loadMoreMessages', { defaultValue: '加载更早消息' })} ({hiddenMessageCount})
              </button>
            </div>
          )}
          {visibleRenderableMessages.map(({ message, isLastUserMessage, toolResults }) => {
            return (
              <MessageItem
                key={message.id}
                message={message}
                isStreaming={message.id === streamingMessageId}
                isLastUserMessage={isLastUserMessage}
                onEditUserMessage={onEditUserMessage}
                toolResults={toolResults}
                liveToolCallMap={message.id === streamingMessageId ? liveToolCallMap : null}
              />
            )
          })}
          {!streamingMessageId && messages.length > 0 && hasAssistantMessages && onRetry && (
            <div className="flex justify-center">
              <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs text-muted-foreground" onClick={onRetry}>
                <RefreshCw className="size-3" />
                {t('action.retry', { ns: 'common' })}
              </Button>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Scroll to bottom button */}
      {!isAtBottom && messages.length > 0 && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 flex items-center gap-1.5 rounded-full border bg-background/90 backdrop-blur-sm px-3 py-1.5 text-xs text-muted-foreground shadow-lg hover:text-foreground hover:shadow-xl transition-all duration-200 hover:-translate-y-0.5"
        >
          <ArrowDown className="size-3" />
          {t('messageList.scrollToBottom')}
        </button>
      )}
    </div>
  )
}
