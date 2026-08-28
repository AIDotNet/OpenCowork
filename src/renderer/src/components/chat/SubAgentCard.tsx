import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'

import {
  decodeStructuredToolResult,
  formatToolErrorForDisplay
} from '@renderer/lib/tools/tool-result-format'
import { formatTokens, getBillableTotalTokens } from '@renderer/lib/format-tokens'
import { countLabel, toolCallsLabel } from '@renderer/lib/chat/execution-labels'
import { parseSubAgentMeta } from '@renderer/lib/agent/sub-agents/create-tool'
import { resolveSubAgentPresentation } from '@renderer/lib/agent/sub-agents/presentation'
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
  promptText
}: {
  displayName: string
  descriptionText: string
  promptText: string
}): React.JSX.Element {
  return (
    <HoverCardContent
      side="top"
      align="start"
      className="w-[min(32rem,calc(100vw-3rem))] overflow-hidden border-border/70 bg-popover/98 p-0 text-popover-foreground shadow-xl backdrop-blur"
    >
      <div>
        <div className="border-b border-border/60 px-3 py-2.5">
          <div className="truncate text-[13px] font-medium text-foreground/90">{displayName}</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">SubAgent</div>
        </div>

        {descriptionText ? (
          <section className="space-y-1.5 px-3 py-2.5">
            <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/75">
              Description
            </div>
            <div className="whitespace-pre-wrap break-words text-[12px] leading-5 text-foreground/75">
              {descriptionText}
            </div>
          </section>
        ) : null}

        {promptText ? (
          <section className="space-y-1.5 border-t border-border/50 px-3 py-2.5">
            <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/75">
              Prompt
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
          'SubAgent execution failed'
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
  // The execution transcript reads in English in every locale — see `execution-labels`.
  const statusText = isQueued
    ? 'Queued'
    : isRunning
      ? reportStatus === 'retrying'
        ? 'Synthesizing report…'
        : 'Running'
      : isError
        ? endReason === 'max_iterations'
          ? 'Iteration limit reached'
          : endReason === 'aborted'
            ? 'Aborted'
            : 'Failed'
        : reportStatus === 'fallback'
          ? 'Done (synthesized)'
          : 'Done'
  const previewText = descriptionText || promptText.replace(/\s+/g, ' ').trim() || statusText
  const metaText = [
    statusText,
    elapsed != null ? formatElapsed(elapsed) : '',
    iterationCount > 0 ? countLabel(iterationCount, 'iteration') : '',
    callCount > 0 ? toolCallsLabel(callCount) : '',
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
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span
          className={cn(
            'shrink-0 text-[12.5px] font-medium',
            isRunning ? 'tool-name-live-pulse tool-name-live-pulse--running' : 'text-foreground/75'
          )}
        >
          {displayName}
        </span>
        {isBackground ? (
          <span className="hidden shrink-0 text-[11px] text-muted-foreground/45 sm:inline">
            Background
          </span>
        ) : null}
        <span className="min-w-0 truncate text-[12.5px] text-muted-foreground/60">
          {previewText}
        </span>
      </span>

      <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground/50">
        <span className={cn('max-w-28 truncate', isError && 'text-destructive/85')}>
          {statusText}
        </span>
        {elapsed != null ? (
          <span className="tabular-nums text-muted-foreground/40">{formatElapsed(elapsed)}</span>
        ) : null}
      </span>

      {errorText ? (
        <span
          className="w-full min-w-0 text-[11px] leading-4 text-destructive/85"
          title={errorText}
        >
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
      />
    </HoverCard>
  ) : (
    card
  )
}

export const SubAgentCard = React.memo(SubAgentCardInner)
