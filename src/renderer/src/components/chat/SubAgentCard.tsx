import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Brain,
  Loader2,
  Wrench,
  ChevronDown,
  ChevronRight,
  Zap,
  Clock,
  Copy,
  Check,
  Maximize2,
  icons
} from 'lucide-react'
import { Badge } from '@renderer/components/ui/badge'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@renderer/components/ui/collapsible'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { formatTokens } from '@renderer/lib/format-tokens'
import { cn } from '@renderer/lib/utils'
import { parseSubAgentMeta } from '@renderer/lib/agent/sub-agents/create-tool'
import { subAgentRegistry } from '@renderer/lib/agent/sub-agents/registry'
import { ToolCallCard } from './ToolCallCard'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MONO_FONT } from '@renderer/lib/constants'
import type { ToolResultContent } from '@renderer/lib/api/types'

// --- SubAgent icon resolver (dynamic from registry) ---
function getSubAgentIcon(agentName: string): React.ReactNode {
  const def = subAgentRegistry.get(agentName)
  if (def?.icon && def.icon in icons) {
    const IconComp = icons[def.icon as keyof typeof icons]
    return <IconComp className="size-4" />
  }
  return <Brain className="size-4" />
}

// --- Elapsed time formatter ---
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  return `${Math.floor(secs / 60)}m${Math.round(secs % 60)}s`
}

function CopyOutputBtn({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = React.useState(false)
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
      className="rounded p-0.5 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
      title="Copy output"
    >
      {copied ? <Check className="size-3 text-green-500" /> : <Copy className="size-3" />}
    </button>
  )
}

interface SubAgentCardProps {
  /** The tool name ("Task" for unified tool, or legacy SubAgent names) */
  name: string
  /** The tool_use block id, used to match live state for parallel same-name SubAgent calls */
  toolUseId: string
  /** Input passed by parent agent (includes subagent_type, description, prompt for unified Task) */
  input: Record<string, unknown>
  /** Final output (from completed tool_use result), undefined while running */
  output?: ToolResultContent
  /** Whether this is a historical/completed card (from message content) or live */
  isLive?: boolean
}

export function SubAgentCard({
  name,
  toolUseId,
  input,
  output,
  isLive = false
}: SubAgentCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const [toolsExpanded, setToolsExpanded] = React.useState(true)
  const [outputExpanded, setOutputExpanded] = React.useState(false)

  // Resolve display name: for unified Task tool, use input.subagent_type; otherwise legacy name
  const displayName = String(input.subagent_type ?? name)

  // Live state from agent store — match by toolUseId for precise identification
  const activeSubAgents = useAgentStore((s) => s.activeSubAgents)
  const completedSubAgents = useAgentStore((s) => s.completedSubAgents)
  const live = isLive ? (activeSubAgents[toolUseId] ?? completedSubAgents[toolUseId] ?? null) : null

  // Extract string from ToolResultContent for backward-compat
  const outputStr = typeof output === 'string' ? output : undefined

  // Parse embedded metadata from historical output
  const parsed = React.useMemo(() => {
    if (!outputStr) return { meta: null, text: '' }
    return parseSubAgentMeta(outputStr)
  }, [outputStr])
  const histMeta = parsed.meta
  const histText = parsed.text || outputStr || ''

  // Determine status
  const isRunning = live?.isRunning ?? false
  const isCompleted = !isRunning && (!!output || (live && !live.isRunning))
  const isError = outputStr
    ? histText.startsWith('{"error"') || outputStr.startsWith('{"error"')
    : false

  // Auto-expand output when SubAgent completes
  const prevRunningRef = React.useRef(isRunning)
  React.useEffect(() => {
    if (prevRunningRef.current && !isRunning && (output || live?.streamingText)) {
      setOutputExpanded(true)
      setToolsExpanded(false)
    }
    prevRunningRef.current = isRunning
  }, [isRunning, output, live?.streamingText])

  // Live elapsed time counter (auto-updates every second while running)
  const [now, setNow] = React.useState(Date.now())
  React.useEffect(() => {
    if (!live?.isRunning) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live?.isRunning])

  const elapsed = live ? (live.completedAt ?? now) - live.startedAt : (histMeta?.elapsed ?? null)

  // Icon — resolve by displayName (subagent_type for unified Task, or legacy name)
  const icon = getSubAgentIcon(displayName)

  // Query/task description from input (unified Task uses description/prompt)
  const queryText = String(input.description ?? input.query ?? input.task ?? input.target ?? '')

  const handleOpenPreview = (): void => {
    useUIStore.getState().openDetailPanel({ type: 'subagent', toolUseId })
  }

  return (
    <div
      className={cn(
        'my-5 rounded-xl border-2 overflow-hidden transition-all duration-300',
        isRunning && 'border-violet-500/40 shadow-lg shadow-violet-500/5',
        isCompleted && !isError && 'border-violet-500/20',
        isError && 'border-destructive/30',
        !isRunning && !isCompleted && 'border-muted'
      )}
    >
      {/* Header */}
      <div
        className={cn(
          'flex items-center gap-2.5 px-4 py-2.5',
          isRunning && 'bg-violet-500/5',
          isCompleted && !isError && 'bg-violet-500/[0.02]',
          isError && 'bg-destructive/5'
        )}
      >
        <div
          className={cn(
            'flex items-center justify-center rounded-lg p-1.5',
            isRunning ? 'bg-violet-500/15 text-violet-500' : 'bg-muted text-muted-foreground'
          )}
        >
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold text-violet-600 dark:text-violet-400">
              {displayName}
            </span>
            <Badge
              variant={isRunning ? 'default' : isError ? 'destructive' : 'secondary'}
              className={cn('text-[9px] px-1.5 h-4', isRunning && 'bg-violet-500 animate-pulse')}
            >
              {isRunning ? t('subAgent.working') : isError ? t('subAgent.failed') : t('subAgent.done')}
            </Badge>
          </div>
          {queryText && (
            <p className="text-xs text-muted-foreground/70 truncate mt-0.5">{queryText}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 text-[10px] text-muted-foreground/50">
          {(live || histMeta) && (
            <>
              <span className="tabular-nums">
                {t('subAgent.iter', { count: live?.iteration ?? histMeta?.iterations ?? 0 })}
              </span>
              <span>·</span>
              <span className="tabular-nums">
                {t('subAgent.calls', { count: live?.toolCalls.length ?? histMeta?.toolCalls.length ?? 0 })}
              </span>
            </>
          )}
          {(live || histMeta) && elapsed != null && <span>·</span>}
          {elapsed != null && (
            <span className="tabular-nums flex items-center gap-0.5">
              <Clock className="size-2.5" />
              {formatElapsed(elapsed)}
            </span>
          )}
          {histMeta && (
            <>
              <span>·</span>
              <span className="tabular-nums">
                {formatTokens(histMeta.usage.inputTokens + histMeta.usage.outputTokens)} tok
              </span>
            </>
          )}
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation()
            handleOpenPreview()
          }}
          className="rounded-md p-1 text-muted-foreground/30 hover:text-violet-500 hover:bg-violet-500/10 transition-colors shrink-0"
          title={t('subAgent.viewDetails')}
        >
          <Maximize2 className="size-3.5" />
        </button>
      </div>

      {/* Inner tool calls (live) */}
      {live && live.toolCalls.length > 0 && (
        <Collapsible open={toolsExpanded} onOpenChange={setToolsExpanded}>
          <div className="border-t border-violet-500/10 px-4 py-1.5">
            <CollapsibleTrigger asChild>
              <button className="flex w-full items-center gap-1.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors">
                <Wrench className="size-2.5" />
                <span className="font-medium uppercase tracking-wider">{t('subAgent.toolCalls', { ns: 'chat' })}</span>
                <Badge variant="secondary" className="text-[9px] h-3.5 px-1 ml-0.5">
                  {live.toolCalls.length}
                </Badge>
                <span className="flex-1" />
                {toolsExpanded ? (
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronRight className="size-3" />
                )}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-1 space-y-1">
                {live.toolCalls.map((tc) => (
                  <ToolCallCard
                    key={tc.id}
                    toolUseId={tc.id}
                    name={tc.name}
                    input={tc.input}
                    output={tc.output}
                    status={tc.status}
                    error={tc.error}
                    startedAt={tc.startedAt}
                    completedAt={tc.completedAt}
                  />
                ))}
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>
      )}

      {/* Historical tool calls (from embedded metadata) — rendered as ToolCallCards */}
      {!live && histMeta && histMeta.toolCalls.length > 0 && (
        <Collapsible open={toolsExpanded} onOpenChange={setToolsExpanded}>
          <div className="border-t border-violet-500/10 px-4 py-1.5">
            <CollapsibleTrigger asChild>
              <button className="flex w-full items-center gap-1.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors">
                <Wrench className="size-2.5" />
                <span className="font-medium uppercase tracking-wider">{t('subAgent.toolCalls', { ns: 'chat' })}</span>
                <Badge variant="secondary" className="text-[9px] h-3.5 px-1 ml-0.5">
                  {histMeta.toolCalls.length}
                </Badge>
                <span className="flex-1" />
                {toolsExpanded ? (
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronRight className="size-3" />
                )}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-1 space-y-1">
                {histMeta.toolCalls.map((tc) => (
                  <ToolCallCard
                    key={tc.id}
                    toolUseId={tc.id}
                    name={tc.name}
                    input={tc.input}
                    output={tc.output}
                    status={tc.status === 'error' ? 'error' : 'completed'}
                    error={tc.error}
                    startedAt={tc.startedAt}
                    completedAt={tc.completedAt}
                  />
                ))}
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>
      )}

      {/* Thinking indicator (running but no text yet) */}
      {live?.isRunning && !live.streamingText && live.toolCalls.length === 0 && (
        <div className="border-t border-violet-500/10 px-4 py-2 flex items-center gap-2">
          <span className="flex gap-1">
            <span
              className="size-1.5 rounded-full bg-violet-400/50 animate-bounce"
              style={{ animationDelay: '0ms' }}
            />
            <span
              className="size-1.5 rounded-full bg-violet-400/50 animate-bounce"
              style={{ animationDelay: '150ms' }}
            />
            <span
              className="size-1.5 rounded-full bg-violet-400/50 animate-bounce"
              style={{ animationDelay: '300ms' }}
            />
          </span>
          <span className="text-[11px] text-violet-400/60">{t('subAgent.thinking')}</span>
        </div>
      )}

      {/* Streaming text output (live) */}
      {live && live.streamingText && (
        <div className="border-t border-violet-500/10 px-4 py-2.5 max-h-64 overflow-y-auto">
          <div className="prose prose-xs dark:prose-invert max-w-none text-[12px] leading-relaxed">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                code: ({ className, children, ...props }) => (
                  <code
                    className={cn(className, 'font-mono')}
                    style={{ fontFamily: MONO_FONT }}
                    {...props}
                  >
                    {children}
                  </code>
                )
              }}
            >
              {live.streamingText}
            </ReactMarkdown>
          </div>
          {live.isRunning && (
            <span className="inline-block w-1 h-3 bg-violet-500/60 animate-pulse ml-0.5" />
          )}
        </div>
      )}

      {/* Completed output (from tool result in message history) */}
      {!live && outputStr && histText && (
        <Collapsible open={outputExpanded} onOpenChange={setOutputExpanded}>
          <div className="border-t border-violet-500/10">
            <CollapsibleTrigger asChild>
              <button className="flex w-full items-center gap-1.5 px-4 py-1.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors">
                <Zap className="size-2.5" />
                <span className="font-medium">{t('subAgent.result')}</span>
                <span className="text-muted-foreground/30 ml-1">
                  {histText.length > 500
                    ? t('subAgent.kChars', { count: Math.round(histText.length / 1000) })
                    : t('subAgent.nChars', { count: histText.length })}
                </span>
                <span className="flex-1" />
                <CopyOutputBtn text={histText} />
                {outputExpanded ? (
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronRight className="size-3" />
                )}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="px-4 pb-3 max-h-80 overflow-y-auto">
                <div className="prose prose-xs dark:prose-invert max-w-none text-[12px] leading-relaxed">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      code: ({ className, children, ...props }) => (
                        <code
                          className={cn(className, 'font-mono')}
                          style={{ fontFamily: MONO_FONT }}
                          {...props}
                        >
                          {children}
                        </code>
                      )
                    }}
                  >
                    {histText}
                  </ReactMarkdown>
                </div>
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>
      )}

      {/* Footer — only when live and running */}
      {live?.isRunning && (
        <div className="border-t border-violet-500/10 px-4 py-1.5 flex items-center gap-2">
          <Loader2 className="size-3 animate-spin text-violet-400" />
          <span className="text-[10px] text-violet-400/70 font-medium">
            {t('subAgent.exploring', { name: displayName })}
          </span>
        </div>
      )}
    </div>
  )
}
