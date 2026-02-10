import * as React from 'react'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { MessageItem } from './MessageItem'
import { MessageSquare, Briefcase, Code2, RefreshCw, ArrowDown, ClipboardCopy, Check } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { sessionToMarkdown } from '@renderer/lib/utils/export-chat'

const modeHints = {
  chat: {
    icon: <MessageSquare className="size-12 text-muted-foreground/20" />,
    title: 'Start a conversation',
    description: 'Ask anything — no tools, just chat.',
  },
  cowork: {
    icon: <Briefcase className="size-12 text-muted-foreground/20" />,
    title: 'Start a Cowork session',
    description: 'Select a working folder, then ask the assistant to help with your project.',
  },
  code: {
    icon: <Code2 className="size-12 text-muted-foreground/20" />,
    title: 'Start coding',
    description: 'Describe what you want to build and the assistant will write the code.',
  },
}

interface MessageListProps {
  onRetry?: () => void
  onEditUserMessage?: (newContent: string) => void
}

export function MessageList({ onRetry, onEditUserMessage }: MessageListProps): React.JSX.Element {
  const sessions = useChatStore((s) => s.sessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const streamingMessageId = useChatStore((s) => s.streamingMessageId)
  const mode = useUIStore((s) => s.mode)
  const bottomRef = React.useRef<HTMLDivElement>(null)
  const [isAtBottom, setIsAtBottom] = React.useState(true)

  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const messages = activeSession?.messages ?? []
  const [copiedAll, setCopiedAll] = React.useState(false)

  // Derive a scroll trigger from streaming content length
  const streamingMsg = streamingMessageId ? messages.find((m) => m.id === streamingMessageId) : null
  const streamContentLen = streamingMsg
    ? typeof streamingMsg.content === 'string'
      ? streamingMsg.content.length
      : JSON.stringify(streamingMsg.content).length
    : 0

  // Track if user is at bottom via IntersectionObserver
  React.useEffect(() => {
    const el = bottomRef.current
    if (!el) return
    const observer = new IntersectionObserver(([entry]) => setIsAtBottom(entry.isIntersecting), { threshold: 0.1 })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Auto-scroll to bottom on new messages and during streaming (only if at bottom)
  React.useEffect(() => {
    if (isAtBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages.length, streamingMessageId, streamContentLen, isAtBottom])

  const scrollToBottom = React.useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  if (messages.length === 0) {
    const hint = modeHints[mode]
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center px-6">
        <div className="flex flex-col items-center gap-3">
          <div className="rounded-2xl bg-muted/40 p-4">
            {hint.icon}
          </div>
          <div>
            <p className="text-base font-semibold text-foreground/80">{hint.title}</p>
            <p className="mt-1.5 text-sm text-muted-foreground/60 max-w-[320px]">{hint.description}</p>
          </div>
        </div>
        {mode !== 'chat' && (
          <p className="text-[11px] text-muted-foreground/40">
            Tip: Drop files into the input to reference their paths
          </p>
        )}
        <div className="flex flex-wrap justify-center gap-2 max-w-[400px]">
          {(mode === 'chat' ? [
            'Explain how async/await works',
            'Compare REST vs GraphQL',
            'Write a regex for email validation',
          ] : mode === 'cowork' ? (activeSession?.workingFolder ? [
            'Summarize this project structure',
            'Find and fix potential bugs',
            'Add error handling to the main module',
          ] : [
            'Review this codebase and suggest improvements',
            'Add tests for the main module',
            'Refactor for better error handling',
          ]) : (activeSession?.workingFolder ? [
            'Add a new feature that...',
            'Write tests for the existing code',
            'Optimize the performance of...',
          ] : [
            'Build a CLI tool that...',
            'Create a REST API with...',
            'Write a script that...',
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
            <div className="flex items-center gap-2"><kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">Ctrl+N</kbd><span className="text-muted-foreground/60">New chat</span></div>
            <div className="flex items-center gap-2"><kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">Ctrl+K</kbd><span className="text-muted-foreground/60">Commands</span></div>
            <div className="flex items-center gap-2"><kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">Ctrl+B</kbd><span className="text-muted-foreground/60">Sidebar</span></div>
            <div className="flex items-center gap-2"><kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">Ctrl+/</kbd><span className="text-muted-foreground/60">Shortcuts</span></div>
            <div className="flex items-center gap-2"><kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">Ctrl+,</kbd><span className="text-muted-foreground/60">Settings</span></div>
            <div className="flex items-center gap-2"><kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">Ctrl+D</kbd><span className="text-muted-foreground/60">Duplicate</span></div>
          </div>
        </div>
      </div>
    )
  }

  const handleCopyAll = (): void => {
    if (!activeSession) return
    const md = sessionToMarkdown(activeSession)
    navigator.clipboard.writeText(md)
    setCopiedAll(true)
    setTimeout(() => setCopiedAll(false), 2000)
  }

  return (
    <div className="relative flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 p-4">
        {messages.length > 1 && !streamingMessageId && (
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1.5 text-[10px] text-muted-foreground"
              onClick={handleCopyAll}
            >
              {copiedAll ? <Check className="size-3" /> : <ClipboardCopy className="size-3" />}
              {copiedAll ? 'Copied!' : 'Copy All'}
            </Button>
          </div>
        )}
        {messages.map((msg, idx) => {
          const isLastUser = !streamingMessageId && msg.role === 'user' &&
            !messages.slice(idx + 1).some((m) => m.role === 'user')
          // Build tool results map for assistant messages (from next user message)
          let toolResults: Map<string, { content: string; isError?: boolean }> | undefined
          if (msg.role === 'assistant' && Array.isArray(msg.content)) {
            const nextMsg = messages[idx + 1]
            if (nextMsg && nextMsg.role === 'user' && Array.isArray(nextMsg.content)) {
              toolResults = new Map()
              for (const block of nextMsg.content) {
                if (block.type === 'tool_result') {
                  toolResults.set(block.toolUseId, { content: block.content, isError: block.isError })
                }
              }
            }
          }
          return (
            <MessageItem
              key={msg.id}
              message={msg}
              isStreaming={msg.id === streamingMessageId}
              isLastUserMessage={isLastUser}
              onEditUserMessage={onEditUserMessage}
              toolResults={toolResults}
            />
          )
        })}
        {!streamingMessageId && messages.length > 0 && messages[messages.length - 1].role === 'assistant' && onRetry && (
          <div className="flex justify-center">
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs text-muted-foreground" onClick={onRetry}>
              <RefreshCw className="size-3" />
              Retry
            </Button>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Scroll to bottom button */}
      {!isAtBottom && messages.length > 0 && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full border bg-background/90 backdrop-blur-sm px-3 py-1.5 text-xs text-muted-foreground shadow-lg hover:text-foreground hover:shadow-xl transition-all duration-200 hover:-translate-y-0.5"
        >
          <ArrowDown className="size-3" />
          Scroll to bottom
        </button>
      )}
    </div>
  )
}
