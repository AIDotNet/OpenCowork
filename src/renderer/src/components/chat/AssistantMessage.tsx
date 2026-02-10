import { useState, useCallback, useMemo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { PrismAsyncLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown'
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml'
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust'
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go'
import { Avatar, AvatarFallback } from '@renderer/components/ui/avatar'
import { useTypewriter } from '@renderer/hooks/use-typewriter'
import { Bot, Copy, Check, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import type { ContentBlock, TokenUsage } from '@renderer/lib/api/types'
import { ToolCallCard } from './ToolCallCard'
import { FileChangeCard } from './FileChangeCard'
import { SubAgentCard } from './SubAgentCard'
import { TodoCard } from './TodoCard'
import { ThinkingBlock } from './ThinkingBlock'
import { TeamEventCard } from './TeamEventCard'
import { InlineTeammateCard } from './InlineTeammateCard'
import { subAgentRegistry } from '@renderer/lib/agent/sub-agents/registry'
import { TEAM_TOOL_NAMES } from '@renderer/lib/agent/teams/register'
import { useAgentStore } from '@renderer/stores/agent-store'
import { MONO_FONT } from '@renderer/lib/constants'

SyntaxHighlighter.registerLanguage('typescript', typescript)
SyntaxHighlighter.registerLanguage('ts', typescript)
SyntaxHighlighter.registerLanguage('javascript', javascript)
SyntaxHighlighter.registerLanguage('js', javascript)
SyntaxHighlighter.registerLanguage('python', python)
SyntaxHighlighter.registerLanguage('bash', bash)
SyntaxHighlighter.registerLanguage('sh', bash)
SyntaxHighlighter.registerLanguage('shell', bash)
SyntaxHighlighter.registerLanguage('json', json)
SyntaxHighlighter.registerLanguage('css', css)
SyntaxHighlighter.registerLanguage('jsx', jsx)
SyntaxHighlighter.registerLanguage('tsx', tsx)
SyntaxHighlighter.registerLanguage('markdown', markdown)
SyntaxHighlighter.registerLanguage('md', markdown)
SyntaxHighlighter.registerLanguage('yaml', yaml)
SyntaxHighlighter.registerLanguage('yml', yaml)
SyntaxHighlighter.registerLanguage('rust', rust)
SyntaxHighlighter.registerLanguage('go', go)

interface AssistantMessageProps {
  content: string | ContentBlock[]
  isStreaming?: boolean
  usage?: TokenUsage
  /** Map of toolUseId → output for completed tool results (from next user message) */
  toolResults?: Map<string, { content: string; isError?: boolean }>
}

function CopyButton({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [text])

  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted-foreground/10 transition-colors"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

function CodeBlock({ language, children }: { language?: string; children: string }): React.JSX.Element {
  const code = String(children).replace(/\n$/, '')
  return (
    <div className="group relative rounded-lg border border-border/60 overflow-hidden my-3 shadow-sm">
      <div className="flex items-center justify-between bg-muted/40 px-3 py-1.5 border-b border-border/60">
        <span className="text-[10px] font-mono text-muted-foreground/70 uppercase tracking-wider">{language || 'text'}</span>
        <CopyButton text={code} />
      </div>
      <SyntaxHighlighter
        language={language || 'text'}
        style={oneDark}
        customStyle={{
          margin: 0,
          padding: '14px',
          fontSize: '12px',
          lineHeight: '1.5',
          background: 'transparent',
          fontFamily: MONO_FONT
        }}
        codeTagProps={{
          style: {
            fontFamily: 'inherit',
            fontSize: 'inherit'
          }
        }}
        className="!bg-[hsl(var(--muted))] text-xs"
      >
        {code}
      </SyntaxHighlighter>
    </div>
  )
}

function MarkdownContent({ text }: { text: string }): React.JSX.Element {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <a
            href={href}
            onClick={(e) => { e.preventDefault(); if (href) window.electron.ipcRenderer.invoke('shell:openExternal', href) }}
            className="text-primary underline underline-offset-2 hover:text-primary/80 cursor-pointer"
            title={href}
          >
            {children}
          </a>
        ),
        pre: ({ children }) => <>{children}</>,
        code: ({ children, className, ...props }) => {
          const match = /language-(\w+)/.exec(className || '')
          const isInline = !match && !className
          if (isInline) {
            return (
              <code
                className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono"
                style={{ fontFamily: MONO_FONT }}
                {...props}
              >
                {children}
              </code>
            )
          }
          return <CodeBlock language={match?.[1]}>{String(children)}</CodeBlock>
        },
      }}
    >
      {text}
    </Markdown>
  )
}

function StreamingMarkdownContent({ text, isStreaming }: { text: string; isStreaming: boolean }): React.JSX.Element {
  const displayed = useTypewriter(text, isStreaming)
  return <MarkdownContent text={displayed} />
}

export function AssistantMessage({ content, isStreaming, usage, toolResults }: AssistantMessageProps): React.JSX.Element {
  const [toolsCollapsed, setToolsCollapsed] = useState(false)

  // Subscribe to live tool call state for real-time status during streaming
  const pendingToolCalls = useAgentStore((s) => s.pendingToolCalls)
  const executedToolCalls = useAgentStore((s) => s.executedToolCalls)
  const liveToolCallMap = useMemo(() => {
    if (!isStreaming) return null
    const map = new Map<string, (typeof executedToolCalls)[0]>()
    for (const tc of executedToolCalls) map.set(tc.id, tc)
    for (const tc of pendingToolCalls) map.set(tc.id, tc)
    return map
  }, [isStreaming, pendingToolCalls, executedToolCalls])

  const renderContent = (): React.JSX.Element => {
    // Show thinking indicator when streaming just started
    if (isStreaming && typeof content === 'string' && content.length === 0) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="flex gap-1">
            <span className="size-1.5 rounded-full bg-foreground/30 animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="size-1.5 rounded-full bg-foreground/30 animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="size-1.5 rounded-full bg-foreground/30 animate-bounce" style={{ animationDelay: '300ms' }} />
          </span>
          <span className="text-xs text-muted-foreground/60">Thinking...</span>
        </div>
      )
    }

    if (typeof content === 'string') {
      return (
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <StreamingMarkdownContent text={content} isStreaming={!!isStreaming} />
          {isStreaming && <span className="inline-block w-1.5 h-4 bg-foreground/70 animate-pulse ml-0.5" />}
        </div>
      )
    }

    const toolCount = content.filter((b) => b.type === 'tool_use').length
    const lastTextIdx = isStreaming
      ? content.reduce((acc: number, b, idx) => (b.type === 'text' ? idx : acc), -1)
      : -1

    return (
      <div className="space-y-2">
        {toolCount >= 2 && (
          <button
            onClick={() => setToolsCollapsed((v) => !v)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted-foreground/10 transition-colors"
          >
            {toolsCollapsed ? <ChevronsUpDown className="size-3" /> : <ChevronsDownUp className="size-3" />}
            {toolsCollapsed ? `Show ${toolCount} tool calls` : `Collapse ${toolCount} tool calls`}
          </button>
        )}
        {content.map((block, i) => {
          switch (block.type) {
            case 'thinking':
              return (
                <ThinkingBlock
                  key={i}
                  thinking={block.thinking}
                  isStreaming={isStreaming}
                  startedAt={block.startedAt}
                  completedAt={block.completedAt}
                />
              )
            case 'text':
              return (
                <div key={i} className="prose prose-sm dark:prose-invert max-w-none">
                  <StreamingMarkdownContent text={block.text} isStreaming={i === lastTextIdx} />
                </div>
              )
            case 'tool_use':
              if (toolsCollapsed) return null
              // Render TodoWrite as inline task card
              if (block.name === 'TodoWrite') {
                return (
                  <TodoCard
                    key={block.id}
                    input={block.input}
                    isLive={!!isStreaming}
                  />
                )
              }
              // Render SpawnTeammate as a full inline card with live state
              if (block.name === 'SpawnTeammate') {
                const result = toolResults?.get(block.id)
                return (
                  <InlineTeammateCard
                    key={block.id}
                    input={block.input}
                    output={result?.content}
                  />
                )
              }
              // Render other Team tools as compact event cards
              if (TEAM_TOOL_NAMES.has(block.name)) {
                const result = toolResults?.get(block.id)
                return (
                  <TeamEventCard
                    key={block.id}
                    name={block.name}
                    input={block.input}
                    output={result?.content}
                  />
                )
              }
              // Render SubAgent tools as workspace cards
              if (subAgentRegistry.has(block.name)) {
                const result = toolResults?.get(block.id)
                return (
                  <SubAgentCard
                    key={block.id}
                    name={block.name}
                    toolUseId={block.id}
                    input={block.input}
                    output={result?.content}
                    isLive={!!isStreaming}
                  />
                )
              }
              // Render file mutation tools (Write/Edit/MultiEdit/Delete) as file change cards
              if (['Write', 'Edit', 'MultiEdit', 'Delete'].includes(block.name)) {
                const result = toolResults?.get(block.id)
                const liveTc = liveToolCallMap?.get(block.id)
                return (
                  <FileChangeCard
                    key={block.id}
                    name={block.name}
                    input={block.input}
                    output={liveTc?.output ?? result?.content}
                    status={liveTc?.status ?? (result?.isError ? 'error' : 'completed')}
                    error={liveTc?.error}
                    startedAt={liveTc?.startedAt}
                    completedAt={liveTc?.completedAt}
                  />
                )
              }
              {
                // During streaming: use live state from agent-store for real-time status
                // Historical: use toolResults from next user message
                const result = toolResults?.get(block.id)
                const liveTc = liveToolCallMap?.get(block.id)
                return (
                  <ToolCallCard
                    key={block.id}
                    name={block.name}
                    input={block.input}
                    output={liveTc?.output ?? result?.content}
                    status={liveTc?.status ?? (result?.isError ? 'error' : 'completed')}
                    error={liveTc?.error}
                    startedAt={liveTc?.startedAt}
                    completedAt={liveTc?.completedAt}
                  />
                )
              }
            default:
              return null
          }
        })}
        {isStreaming && <span className="inline-block w-1.5 h-4 bg-foreground/70 animate-pulse" />}
      </div>
    )
  }

  const plainText = typeof content === 'string'
    ? content
    : content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')

  return (
    <div className="group/msg flex gap-3">
      <Avatar className="size-7 shrink-0 ring-1 ring-border/50">
        <AvatarFallback className="bg-gradient-to-br from-secondary to-muted text-secondary-foreground text-xs">
          <Bot className="size-3.5" />
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex items-center gap-2 mb-1">
          <p className="text-sm font-medium">Assistant</p>
          {!isStreaming && plainText && (
            <span className="opacity-0 group-hover/msg:opacity-100 transition-opacity">
              <CopyButton text={plainText} />
            </span>
          )}
        </div>
        {renderContent()}
        {!isStreaming && plainText && (
          <p className="mt-1 text-[10px] text-muted-foreground/40">
            {plainText.split(/\s+/).filter(Boolean).length} words
            {usage && ` · ${usage.inputTokens + usage.outputTokens} tokens (${usage.inputTokens} in / ${usage.outputTokens} out${usage.cacheReadTokens ? ` / ${usage.cacheReadTokens} cached` : ''}${usage.reasoningTokens ? ` / ${usage.reasoningTokens} reasoning` : ''})`}
          </p>
        )}
      </div>
    </div>
  )
}
