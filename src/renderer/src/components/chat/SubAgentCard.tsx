import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { Brain, FileText, ScrollText, icons } from 'lucide-react'

import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import { formatTokens, getBillableTotalTokens } from '@renderer/lib/format-tokens'
import { parseSubAgentMeta } from '@renderer/lib/agent/sub-agents/create-tool'
import { subAgentRegistry } from '@renderer/lib/agent/sub-agents/registry'
import { useAgentStore } from '@renderer/stores/agent-store'
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
  isLive?: boolean
  sessionId?: string | null
  isBackground?: boolean
}

function getSubAgentIcon(agentName: string): React.ReactNode {
  const def = subAgentRegistry.get(agentName)
  if (def?.icon && def.icon in icons) {
    const IconComp = icons[def.icon as keyof typeof icons]
    return <IconComp className="size-4" />
  }
  return <Brain className="size-4" />
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  return `${Math.floor(secs / 60)}m${Math.round(secs % 60)}s`
}

function formatOrderLabel(toolUseId: string): string {
  const digitSuffix = toolUseId.match(/\d+$/)?.[0]
  if (digitSuffix) return digitSuffix.slice(-2).padStart(2, '0')
  return toolUseId.slice(-2).toUpperCase().padStart(2, '0')
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

function DotMatrix({
  filled,
  tone
}: {
  filled: number
  tone: 'active' | 'complete' | 'failed' | 'idle' | 'queued'
}): React.JSX.Element {
  const total = 24
  const clampedFilled = Math.max(0, Math.min(total, filled))

  return (
    <div
      className="grid gap-[2px]"
      style={{ gridTemplateColumns: 'repeat(12, 3px)' }}
      aria-hidden="true"
    >
      {Array.from({ length: total }).map((_, index) => {
        const isFilled = index < clampedFilled
        return (
          <span
            key={index}
            className={cn(
              'block size-[3px] rounded-[1px] transition-colors',
              !isFilled && 'bg-white/[0.08]',
              isFilled &&
                tone === 'failed' &&
                'bg-destructive/80 shadow-[0_0_5px_rgba(248,113,113,0.35)]',
              isFilled &&
                tone === 'queued' &&
                'bg-amber-400/80 shadow-[0_0_5px_rgba(251,191,36,0.35)]',
              isFilled &&
                tone !== 'failed' &&
                tone !== 'queued' &&
                'bg-[#8cff72] shadow-[0_0_5px_rgba(140,255,114,0.45)]'
            )}
          />
        )
      })}
    </div>
  )
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
      className="w-[min(32rem,calc(100vw-3rem))] border-white/10 bg-[#141414]/98 p-0 text-white shadow-2xl backdrop-blur"
    >
      <div className="space-y-3 p-3">
        <div className="flex items-center gap-2 border-b border-white/10 pb-3">
          <div className="flex size-8 items-center justify-center rounded-full border border-white/10 bg-[#1b1b1b] text-white/82">
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-white/88">{displayName}</div>
            <div className="mt-0.5 text-[11px] text-white/45">subAgent</div>
          </div>
        </div>

        {descriptionText ? (
          <section className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-white/40">
              <FileText className="size-3" />
              <span>Description</span>
            </div>
            <div className="whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 text-[12px] leading-5 text-white/72">
              {descriptionText}
            </div>
          </section>
        ) : null}

        {promptText ? (
          <section className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-white/40">
              <ScrollText className="size-3" />
              <span>Prompt</span>
            </div>
            <div className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 text-[12px] leading-5 text-white/72">
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
  isLive = false,
  sessionId,
  isBackground = false
}: SubAgentCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  void isLive

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
  const isQueued = tracked?.isQueued ?? false
  const reportStatus = tracked?.reportStatus
  const endReason = tracked?.endReason
  const isRunning = (tracked?.isRunning ?? false) && !isQueued
  const isCompleted = !isRunning && !isQueued && (!!output || !!tracked)
  const historicalError = outputStr
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
  const isError = tracked?.success === false || !!tracked?.errorMessage || historicalError

  const [now, setNow] = React.useState(tracked?.startedAt ?? 0)
  React.useEffect(() => {
    if (!tracked?.isRunning) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [tracked?.isRunning, tracked?.startedAt])

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
  const orderLabel = formatOrderLabel(toolUseId)
  const icon = getSubAgentIcon(displayName)
  const meterFill = isQueued
    ? 4
    : isError
      ? 18
      : isRunning
        ? Math.max(8, Math.min(22, (callCount || iterationCount || 8) + 8))
        : isCompleted
          ? 24
          : 6
  const meterTone = isQueued
    ? 'queued'
    : isError
      ? 'failed'
      : isRunning
        ? 'active'
        : isCompleted
          ? 'complete'
          : 'idle'
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
      title={`${t('subAgent.viewDetails')} · ${metaText}`}
      className={cn(
        'group my-2 w-full rounded-[9px] px-3 py-2.5 text-left transition-colors',
        'hover:bg-[#242424] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-400/35',
        isRunning && 'bg-[#1f1f1f]',
        isError && 'bg-[#241919] hover:bg-[#2a1c1c]',
        !isRunning && !isError && 'bg-[#1f1f1f]'
      )}
    >
      <div className="grid grid-cols-[32px_minmax(0,1fr)_auto] gap-x-3 gap-y-1">
        <div
          className={cn(
            'row-span-2 flex size-7 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-[#141414] text-white/82',
            isRunning && 'border-emerald-400/35 bg-emerald-400/10',
            isError && 'border-destructive/35 bg-destructive/10 text-destructive'
          )}
        >
          {icon}
        </div>

        <div className="min-w-0 self-center">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-medium text-white/82">{displayName}</span>
            {isBackground ? (
              <span className="shrink-0 rounded border border-cyan-400/20 bg-cyan-400/8 px-1.5 py-0.5 text-[9px] font-medium leading-none text-cyan-300/75">
                {t('subAgent.background', { defaultValue: 'Background' })}
              </span>
            ) : null}
          </div>
        </div>

        <span className="self-center pl-3 text-[12px] font-semibold tabular-nums tracking-wide text-white/72">
          {orderLabel}
        </span>

        <div className="min-w-0 self-end">
          <div className="flex min-w-0 items-center gap-2">
            <span className="-mt-1 h-4 w-3 shrink-0 rounded-bl-[5px] border-b border-l border-white/[0.14]" />
            <p className="truncate text-[12px] leading-5 text-white/55">{previewText}</p>
          </div>
        </div>

        <div className="self-end pb-1 pl-3">
          <DotMatrix filled={meterFill} tone={meterTone} />
        </div>
      </div>
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
