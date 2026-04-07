import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { Brain, Clock, Loader2, Maximize2, icons } from 'lucide-react'
import { Badge } from '@renderer/components/ui/badge'
import { useAgentStore } from '@renderer/stores/agent-store'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import { useUIStore } from '@renderer/stores/ui-store'
import { formatTokens, getBillableTotalTokens } from '@renderer/lib/format-tokens'
import { cn } from '@renderer/lib/utils'
import { parseSubAgentMeta } from '@renderer/lib/agent/sub-agents/create-tool'
import { subAgentRegistry } from '@renderer/lib/agent/sub-agents/registry'
import type { ToolResultContent } from '@renderer/lib/api/types'

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

export const SubAgentCard = React.memo(SubAgentCardInner)

interface SubAgentCardProps {
  name: string
  toolUseId: string
  input: Record<string, unknown>
  output?: ToolResultContent
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
  void isLive

  const displayName = String(input.subagent_type ?? name)
  const tracked = useAgentStore(
    useShallow((s) => {
      const item =
        s.activeSubAgents[toolUseId] ??
        s.completedSubAgents[toolUseId] ??
        s.subAgentHistory.find((entry) => entry.toolUseId === toolUseId) ??
        null

      if (!item) return null

      return {
        isRunning: item.isRunning,
        success: item.success,
        errorMessage: item.errorMessage,
        iteration: item.iteration,
        toolCallCount: item.toolCalls.length,
        usage: item.usage ?? null,
        startedAt: item.startedAt,
        completedAt: item.completedAt
      }
    })
  )

  const outputStr = typeof output === 'string' ? output : undefined
  const parsed = React.useMemo(() => {
    if (!outputStr) return { meta: null, text: '' }
    return parseSubAgentMeta(outputStr)
  }, [outputStr])
  const histMeta = parsed.meta
  const histText = parsed.text || outputStr || ''

  const usage = tracked?.usage ?? histMeta?.usage ?? null
  const isRunning = tracked?.isRunning ?? false
  const isCompleted = !isRunning && (!!output || !!tracked)
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
    ? (tracked.completedAt ?? now) - tracked.startedAt
    : (histMeta?.elapsed ?? null)
  const icon = getSubAgentIcon(displayName)

  const descriptionText = input.description ? String(input.description) : ''
  const promptText = [
    input.prompt ? String(input.prompt) : '',
    input.query ? String(input.query) : '',
    input.task ? String(input.task) : '',
    input.target ? String(input.target) : ''
  ]
    .filter(Boolean)
    .join(' · ')

  const handleOpenPanel = (): void => {
    useUIStore.getState().openSubAgentExecutionDetail(toolUseId, histText || undefined)
  }

  return (
    <div
      className={cn(
        'my-2 overflow-hidden rounded-xl border bg-background/60 p-3 transition-colors',
        isRunning && 'border-violet-500/25 bg-violet-500/[0.03]',
        isCompleted && !isError && 'border-border/60',
        isError && 'border-destructive/30 bg-destructive/5',
        !isRunning && !isCompleted && 'border-border/60'
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'mt-0.5 flex size-8 items-center justify-center rounded-xl border border-border/60 bg-muted/25',
            isRunning ? 'text-violet-500' : 'text-foreground/80'
          )}
        >
          {icon}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-sm font-semibold text-foreground/92">
              {displayName}
            </span>
            <Badge
              variant={isRunning ? 'default' : isError ? 'destructive' : 'secondary'}
              className={cn(
                'h-4.5 rounded-full px-1.5 text-[9px] font-medium',
                isRunning && 'bg-violet-500 animate-pulse'
              )}
            >
              {isRunning
                ? t('subAgent.working')
                : isError
                  ? t('subAgent.failed')
                  : t('subAgent.done')}
            </Badge>
          </div>

          {descriptionText ? (
            <p className="mt-1 line-clamp-1 whitespace-pre-wrap break-words text-[11px] text-muted-foreground/60">
              {descriptionText}
            </p>
          ) : null}

          {promptText ? (
            <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-[11px] leading-4.5 text-muted-foreground/75">
              {promptText}
            </p>
          ) : null}
        </div>

        <button
          onClick={handleOpenPanel}
          className="rounded-full border border-border/60 p-1.5 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          title={t('subAgent.viewDetails')}
        >
          <Maximize2 className="size-3.5" />
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground/60">
        {tracked || histMeta ? (
          <>
            <span className="rounded-full border border-border/60 bg-background/70 px-2.5 py-1">
              {t('subAgent.iter', { count: tracked?.iteration ?? histMeta?.iterations ?? 0 })}
            </span>
            <span className="rounded-full border border-border/60 bg-background/70 px-2.5 py-1">
              {t('subAgent.calls', {
                count: tracked?.toolCallCount ?? histMeta?.toolCalls.length ?? 0
              })}
            </span>
          </>
        ) : null}
        {elapsed != null ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/70 px-2.5 py-1 tabular-nums">
            <Clock className="size-3" />
            {formatElapsed(elapsed)}
          </span>
        ) : null}
        {usage ? (
          <span className="rounded-full border border-border/60 bg-background/70 px-2.5 py-1 tabular-nums">
            {formatTokens(getBillableTotalTokens(usage))} tok
          </span>
        ) : null}
      </div>

      <div className="mt-2 rounded-xl border border-border/60 bg-muted/20 px-2.5 py-2">
        <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/55">
          {isRunning ? <Loader2 className="size-3 animate-spin" /> : <Brain className="size-3" />}
          <span>{t('subAgent.statusLabel')}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/70 px-2.5 py-1 text-[10px] font-medium text-foreground/80">
            {isRunning ? t('subAgent.working') : isError ? t('subAgent.failed') : t('subAgent.done')}
          </span>
          <span className="text-[11px] text-muted-foreground/70">
            {isRunning ? t('subAgent.openInRunsRunning') : t('subAgent.openInRunsDone')}
          </span>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          onClick={handleOpenPanel}
          className="text-xs font-medium text-violet-600 transition-colors hover:text-violet-500 dark:text-violet-400"
        >
          {t('subAgent.viewDetails')}
        </button>
      </div>
    </div>
  )
}
