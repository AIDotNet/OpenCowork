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
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import { useUIStore } from '@renderer/stores/ui-store'
import { formatTokens, getBillableTotalTokens } from '@renderer/lib/format-tokens'
import { cn } from '@renderer/lib/utils'
import { parseSubAgentMeta } from '@renderer/lib/agent/sub-agents/create-tool'
import { subAgentRegistry } from '@renderer/lib/agent/sub-agents/registry'
import { ToolCallCard } from './ToolCallCard'
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

export const SubAgentCard = React.memo(SubAgentCardInner)

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

function SubAgentCardInner({
  name,
  toolUseId,
  input,
  output,
  isLive = false
}: SubAgentCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const [expanded, setExpanded] = React.useState(false)
  const [toolsExpanded, setToolsExpanded] = React.useState(true)

  // Resolve display name: for unified Task tool, use input.subagent_type; otherwise legacy name
  const displayName = String(input.subagent_type ?? name)

  // Live state from agent store — subscribe only to this card's toolUseId
  const live = useAgentStore((s) =>
    isLive ? (s.activeSubAgents[toolUseId] ?? s.completedSubAgents[toolUseId] ?? null) : null
  )

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
    ? (() => {
        const parsedOutput = decodeStructuredToolResult(outputStr)
        if (
          parsedOutput &&
          !Array.isArray(parsedOutput) &&
          typeof parsedOutput.error === 'string'
        ) {
          return true
        }
        const parsedHistText = decodeStructuredToolResult(histText)
        return !!(
          parsedHistText &&
          !Array.isArray(parsedHistText) &&
          typeof parsedHistText.error === 'string'
        )
      })()
    : false

  // Live elapsed time counter (auto-updates every second while running)
  const [now, setNow] = React.useState(live?.startedAt ?? 0)
  React.useEffect(() => {
    if (!live?.isRunning) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live?.isRunning, live?.startedAt])

  const elapsed = live ? (live.completedAt ?? now) - live.startedAt : (histMeta?.elapsed ?? null)

  // Icon — resolve by displayName (subagent_type for unified Task, or legacy name)
  const icon = getSubAgentIcon(displayName)

  // Query/task description from input (unified Task uses description + prompt)
  const queryParts = [
    input.description ? String(input.description) : '',
    input.prompt ? String(input.prompt) : '',
    input.query ? String(input.query) : '',
    input.task ? String(input.task) : '',
    input.target ? String(input.target) : ''
  ].filter(Boolean)
  const queryText = queryParts.join(' · ')

  const previewSource = live?.report || live?.streamingText || histText || ''
  const previewText = React.useMemo(() => {
    if (!previewSource) return ''
    const limit = 420
    if (previewSource.length <= limit) return previewSource
    if (isRunning) {
      return `…${previewSource.slice(-limit)}`
    }
    return `${previewSource.slice(0, limit)}…`
  }, [previewSource, isRunning])
  const hasPreview = previewText.trim().length > 0
  const handleToggleExpanded = (): void => setExpanded((prev) => !prev)
  const handleOpenPreview = (): void => {
    useUIStore.getState().openSubAgentsPanel(toolUseId)
  }

  const ChevronIcon = expanded ? ChevronDown : ChevronRight

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
        <button
          type="button"
          onClick={handleToggleExpanded}
          className="flex flex-1 items-center gap-2.5 text-left rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-500/40 transition-colors"
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
                {isRunning
                  ? t('subAgent.working')
                  : isError
                    ? t('subAgent.failed')
                    : t('subAgent.done')}
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
                  {t('subAgent.calls', {
                    count: live?.toolCalls.length ?? histMeta?.toolCalls.length ?? 0
                  })}
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
                  {formatTokens(getBillableTotalTokens(histMeta.usage))} tok
                </span>
              </>
            )}
          </div>
          <ChevronIcon className="size-3.5 text-muted-foreground/50 shrink-0" />
        </button>
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

      {expanded && (
        <>
          {/* Inner tool calls (live) */}
          {live && live.toolCalls.length > 0 && (
            <Collapsible open={toolsExpanded} onOpenChange={setToolsExpanded}>
              <div className="border-t border-violet-500/10 px-4 py-1.5">
                <CollapsibleTrigger asChild>
                  <button className="flex w-full items-center gap-1.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors">
                    <Wrench className="size-2.5" />
                    <span className="font-medium uppercase tracking-wider">
                      {t('subAgent.toolCalls', { ns: 'chat' })}
                    </span>
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
                    <span className="font-medium uppercase tracking-wider">
                      {t('subAgent.toolCalls', { ns: 'chat' })}
                    </span>
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

          {/* Lightweight preview instead of full markdown rendering */}
          {hasPreview && (
            <div className="border-t border-violet-500/10 px-4 py-2.5 space-y-1 bg-muted/10">
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/60">
                <Zap className="size-2.5" />
                <span className="font-medium uppercase tracking-wider">
                  {isRunning ? t('subAgent.thinking') : t('subAgent.result')}
                </span>
                <span className="text-muted-foreground/30">·</span>
                <span className="text-muted-foreground/50">{t('subAgent.viewDetails')}</span>
                <span className="flex-1" />
                <CopyOutputBtn text={previewSource} />
              </div>
              <p className="text-[12px] text-muted-foreground/80 whitespace-pre-wrap leading-relaxed line-clamp-5">
                {previewText}
              </p>
              <button
                onClick={handleOpenPreview}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-violet-600 dark:text-violet-400 hover:text-violet-500"
              >
                {t('subAgent.viewDetails')}
                <Maximize2 className="size-3" />
              </button>
            </div>
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
        </>
      )}
    </div>
  )
}
