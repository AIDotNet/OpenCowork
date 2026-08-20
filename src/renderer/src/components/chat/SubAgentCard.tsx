import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { Brain, CircleAlert, FileText, ScrollText, icons } from 'lucide-react'

import {
  decodeStructuredToolResult,
  formatToolErrorForDisplay
} from '@renderer/lib/tools/tool-result-format'
import { formatTokens, getBillableTotalTokens } from '@renderer/lib/format-tokens'
import { parseSubAgentMeta } from '@renderer/lib/agent/sub-agents/create-tool'
import { resolveSubAgentPresentation } from '@renderer/lib/agent/sub-agents/presentation'
import { subAgentRegistry } from '@renderer/lib/agent/sub-agents/registry'
import { useAgentStore } from '@renderer/stores/agent-store'
import type { ToolCallStatus } from '@renderer/lib/agent/types'
import { useUIStore } from '@renderer/stores/ui-store'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { cn } from '@renderer/lib/utils'
import type { ToolResultContent } from '@renderer/lib/api/types'
import {
  findSubAgentInSelection,
  selectSessionScopedAgentState
} from '@renderer/lib/agent/session-scoped-agent-state'

interface SubAgentCardProps {
  name: string
  toolUseId: string
  input: Record<string, unknown>
  output?: ToolResultContent
  error?: string
  isLive?: boolean
  liveStatus?: ToolCallStatus | 'completed'
  sessionId?: string | null
  isBackground?: boolean
}

function getSubAgentIcon(agentName: string): React.ReactNode {
  const def = subAgentRegistry.get(agentName)
  if (def?.icon && def.icon in icons) {
    const IconComp = icons[def.icon as keyof typeof icons]
    return <IconComp className="size-3.5" />
  }
  return <Brain className="size-3.5" />
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  return `${Math.floor(secs / 60)}m${Math.round(secs % 60)}s`
}

function extractToolResultText(content?: ToolResultContent): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content
    .filter(
      (block): block is Extract<ToolResultContent[number], { type: 'text' }> =>
        block.type === 'text'
    )
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function extractStructuredError(text: string): string {
  if (!text) return ''
  const parsed = decodeStructuredToolResult(text)
  if (!parsed || Array.isArray(parsed) || typeof parsed.error !== 'string') return ''
  return formatToolErrorForDisplay(parsed.error)
}

function SubAgentHoverContent({
  displayName,
  descriptionText,
  promptText,
  icon
}: {
  displayName: string
  descriptionText: string
  promptText: string
  icon: React.ReactNode
}): React.JSX.Element {
  return (
    <HoverCardContent
      side="top"
      align="start"
      className="w-[min(32rem,calc(100vw-3rem))] overflow-hidden border-border/70 bg-popover/98 p-0 text-popover-foreground shadow-xl backdrop-blur"
    >
      <div>
        <div className="flex items-center gap-2.5 border-b border-border/60 px-3 py-2.5">
          <div className="flex size-7 items-center justify-center rounded-full border border-border/70 text-foreground/75">
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-foreground/90">{displayName}</div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">SubAgent</div>
          </div>
        </div>

        {descriptionText ? (
          <section className="space-y-1.5 px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/75">
              <FileText className="size-3" />
              <span>Description</span>
            </div>
            <div className="whitespace-pre-wrap break-words text-[12px] leading-5 text-foreground/75">
              {descriptionText}
            </div>
          </section>
        ) : null}

        {promptText ? (
          <section className="space-y-1.5 border-t border-border/50 px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/75">
              <ScrollText className="size-3" />
              <span>Prompt</span>
            </div>
            <div className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-5 text-foreground/75">
              {promptText}
            </div>
          </section>
        ) : null}
      </div>
    </HoverCardContent>
  )
}

function SubAgentCardInner({
  name,
  toolUseId,
  input,
  output,
  error,
  isLive = false,
  liveStatus,
  sessionId,
  isBackground = false
}: SubAgentCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')

  const displayName = String(input.subagent_type ?? name)
  const tracked = useAgentStore(
    useShallow((s) => {
      const scoped = sessionId
        ? findSubAgentInSelection(
            selectSessionScopedAgentState(s, sessionId, { mode: 'coarse' }),
            toolUseId
          )
        : null
      const item =
        scoped ??
        s.activeSubAgents[toolUseId] ??
        s.completedSubAgents[toolUseId] ??
        s.subAgentHistory.find((entry) => entry.toolUseId === toolUseId) ??
        null

      if (!item) return null

      return {
        isRunning: item.isRunning,
        isQueued: item.isQueued ?? false,
        reportStatus: item.reportStatus,
        success: item.success,
        endReason: item.endReason,
        errorMessage: item.errorMessage,
        iteration: item.iteration,
        toolCallCount: item.toolCalls.length,
        toolCalls: item.toolCalls,
        usage: item.usage ?? null,
        startedAt: item.startedAt,
        completedAt: item.completedAt
      }
    })
  )

  const outputStr = extractToolResultText(output)
  const parsed = React.useMemo(() => {
    if (!outputStr) return { meta: null, text: '' }
    return parseSubAgentMeta(outputStr)
  }, [outputStr])

  const histMeta = parsed.meta
  const histText = parsed.text || outputStr || ''
  const usage = tracked?.usage ?? histMeta?.usage ?? null
  const reportStatus = tracked?.reportStatus
  const endReason = tracked?.endReason
  const historicalErrorMessage = React.useMemo(
    () => extractStructuredError(outputStr) || extractStructuredError(histText),
    [histText, outputStr]
  )
  const historicalError = Boolean(historicalErrorMessage)
  const presentation = resolveSubAgentPresentation({
    tracked,
    hasToolResult: Boolean(outputStr),
    toolResultIsError: historicalError,
    isLive,
    liveToolStatus: liveStatus
  })
  const isQueued = presentation.isQueued
  const isRunning = presentation.isRunning
  const isError = presentation.isError || historicalError
  const errorText = isError
    ? formatToolErrorForDisplay(
        tracked?.errorMessage?.trim() ||
          error?.trim() ||
          historicalErrorMessage ||
          (liveStatus === 'error' ? histText.trim() : '') ||
          t('subAgent.failureUnknown', { defaultValue: 'SubAgent execution failed' })
      )
    : ''

  const [now, setNow] = React.useState(tracked?.startedAt ?? Date.now())
  React.useEffect(() => {
    if (!isRunning) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [isRunning, tracked?.startedAt])

  const elapsed = tracked
    ? (tracked.completedAt ?? (tracked.isRunning ? now : tracked.startedAt)) - tracked.startedAt
    : histMeta?.elapsed

  const descriptionText = input.description ? String(input.description) : ''
  const promptText = [input.prompt, input.query, input.task, input.target]
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .join('\n\n')

  const iterationCount = tracked?.iteration ?? histMeta?.iterations ?? 0
  const callCount = tracked?.toolCallCount ?? histMeta?.toolCalls.length ?? 0
  const totalTokens = usage ? formatTokens(getBillableTotalTokens(usage)) : null
  const statusText = isQueued
    ? t('subAgent.queued', { defaultValue: 'Queued' })
    : isRunning
      ? reportStatus === 'retrying'
        ? t('subAgent.synthesizing', { defaultValue: 'Synthesizing report…' })
        : t('subAgent.working')
      : isError
        ? endReason === 'max_iterations'
          ? t('subAgent.maxIterations', { defaultValue: 'iteration limit reached' })
          : endReason === 'aborted'
            ? t('subAgent.aborted', { defaultValue: 'aborted' })
            : t('subAgent.failed')
        : reportStatus === 'fallback'
          ? t('subAgent.doneSynthesized', { defaultValue: 'Done (synthesized)' })
          : t('subAgent.done')
  const previewText = descriptionText || promptText.replace(/\s+/g, ' ').trim() || statusText
  const icon = getSubAgentIcon(displayName)
  const metaText = [
    statusText,
    elapsed != null ? formatElapsed(elapsed) : '',
    iterationCount > 0 ? t('subAgent.iter', { count: iterationCount }) : '',
    callCount > 0 ? t('subAgent.calls', { count: callCount }) : '',
    totalTokens ? `${totalTokens} tok` : ''
  ]
    .filter(Boolean)
    .join(' · ')

  const handleOpenPanel = (): void => {
    useUIStore
      .getState()
      .openSubAgentExecutionDetail(toolUseId, histText || undefined, displayName, sessionId)
  }

  const card = (
    <button
      type="button"
      onClick={handleOpenPanel}
      title={`${t('subAgent.viewDetails')} · ${metaText}${errorText ? ` · ${errorText}` : ''}`}
      className={cn(
        'group my-1 flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-1.5 py-1.5 text-left text-[12px] transition-colors duration-200',
        'hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/45 dark:hover:bg-white/[0.035]',
        isError && 'bg-destructive/[0.025] hover:bg-destructive/[0.045]'
      )}
    >
      <span
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full border text-muted-foreground transition-colors',
          isQueued && 'border-amber-500/30 text-amber-600 dark:text-amber-300',
          isRunning && 'border-sky-500/25 text-sky-600 dark:text-sky-300',
          isError && 'border-destructive/25 text-destructive',
          !isQueued &&
            !isRunning &&
            !isError &&
            'border-lime-500/25 text-lime-600 dark:text-lime-400'
        )}
        aria-hidden="true"
      >
        {icon}
      </span>

      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="shrink-0 font-mono text-[12px] font-medium text-foreground/82">
          {displayName}
        </span>
        {isBackground ? (
          <span className="hidden shrink-0 rounded-full border border-cyan-500/20 bg-cyan-500/[0.07] px-1.5 py-0.5 text-[9px] font-medium leading-none text-cyan-700 sm:inline-flex dark:text-cyan-300">
            {t('subAgent.background', { defaultValue: 'Background' })}
          </span>
        ) : null}
        <span className="min-w-0 truncate text-[12px] text-muted-foreground/55">
          ({previewText})
        </span>
      </span>

      <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground/65">
        <span
          className={cn(
            'size-1.5 rounded-full',
            isQueued && 'bg-amber-500',
            isRunning && 'animate-pulse bg-sky-500 motion-reduce:animate-none',
            isError && 'bg-destructive',
            !isQueued && !isRunning && !isError && 'bg-emerald-500'
          )}
          aria-hidden="true"
        />
        <span className="max-w-28 truncate">{statusText}</span>
        {elapsed != null ? (
          <span className="tabular-nums text-muted-foreground/55">{formatElapsed(elapsed)}</span>
        ) : null}
      </span>

      {errorText ? (
        <span
          className="flex w-full min-w-0 items-start gap-1.5 pl-7 text-[11px] leading-4 text-destructive/85"
          title={errorText}
        >
          <CircleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          <span className="line-clamp-2 break-words">{errorText}</span>
        </span>
      ) : null}
    </button>
  )

  return descriptionText || promptText ? (
    <HoverCard>
      <HoverCardTrigger asChild>{card}</HoverCardTrigger>
      <SubAgentHoverContent
        displayName={displayName}
        descriptionText={descriptionText}
        promptText={promptText}
        icon={icon}
      />
    </HoverCard>
  ) : (
    card
  )
}

export const SubAgentCard = React.memo(SubAgentCardInner)
