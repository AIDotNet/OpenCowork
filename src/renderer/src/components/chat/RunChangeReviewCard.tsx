import * as React from 'react'
import { ChevronDown, ChevronUp, ExternalLink, Loader2, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { MONO_FONT } from '@renderer/lib/constants'
import type { AgentRunChangeSet } from '@renderer/stores/agent-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { CodeDiffViewer } from './CodeDiffViewer'
import {
  type LoadedChangeContent,
  isLoadedChangeContent,
  loadAggregatedChangeContent,
  useAggregatedChangeSummaries
} from './change-summary-utils'
import {
  aggregateDisplayableRunFileChanges,
  canRenderInlineSnapshot,
  computeDiff,
  foldContext,
  lineCount,
  snapshotText,
  type AggregatedFileChange
} from './file-change-utils'

interface RunChangeReviewCardProps {
  runId: string
  changeSet: AgentRunChangeSet
}

function isErrorResult(value: unknown): value is { error: string } {
  return !!value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
}

function InlineChangePreview({ change }: { change: AggregatedFileChange }): React.JSX.Element {
  const { t } = useTranslation('chat')
  const [loadedContent, setLoadedContent] = React.useState<LoadedChangeContent | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)

  const shouldLoadFullContent =
    change.op === 'create'
      ? !canRenderInlineSnapshot(change.after)
      : !canRenderInlineSnapshot(change.before) || !canRenderInlineSnapshot(change.after)

  React.useEffect(() => {
    if (!shouldLoadFullContent) {
      setLoadedContent(null)
      setLoadError(null)
      setIsLoading(false)
      return
    }

    let cancelled = false
    const load = async (): Promise<void> => {
      setIsLoading(true)
      setLoadError(null)
      try {
        const result = await loadAggregatedChangeContent(change)

        if (cancelled) return

        if (isLoadedChangeContent(result)) {
          setLoadedContent({
            beforeText: result.beforeText,
            afterText: result.afterText
          })
          return
        }

        if (isErrorResult(result)) {
          setLoadError(result.error)
          return
        }

        setLoadError(
          t('fileChange.loadDiffFailed', { defaultValue: 'Failed to load the full diff' })
        )
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error))
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [change, shouldLoadFullContent, t])

  const beforeText =
    loadedContent?.beforeText ?? (change.op === 'modify' ? snapshotText(change.before) : '')
  const afterText = loadedContent?.afterText ?? snapshotText(change.after)
  const diffLines = computeDiff(beforeText, afterText)
  const diffChunks = foldContext(diffLines)

  if (isLoading && !loadedContent && shouldLoadFullContent) {
    return (
      <div className="flex items-center gap-2 px-4 py-5 text-[11px] text-zinc-500">
        <Loader2 className="size-3.5 animate-spin text-emerald-400" />
        {t('thinking.thinkingEllipsis')}
      </div>
    )
  }

  if (loadError && !loadedContent && shouldLoadFullContent) {
    return <div className="px-4 py-5 text-[11px] text-red-300/90">{loadError}</div>
  }

  if (change.op === 'create') {
    return (
      <div className="border-t border-white/[0.06] bg-[#111214] px-3 py-3">
        <div className="flex items-center gap-3 px-4 py-2 text-[10px] text-zinc-500">
          <span>{t('fileChange.lineCount', { count: lineCount(afterText) })}</span>
        </div>
        <CodeDiffViewer chunks={diffChunks} mode="inline" showModeToggle={false} />
      </div>
    )
  }

  return (
    <div className="border-t border-white/[0.06] bg-[#111214] px-3 py-3">
      <CodeDiffViewer chunks={diffChunks} mode="inline" showModeToggle={false} />
    </div>
  )
}

export function RunChangeReviewCard({
  runId,
  changeSet
}: RunChangeReviewCardProps): React.JSX.Element | null {
  const { t } = useTranslation(['chat', 'common'])
  const rollbackRunChanges = useAgentStore((state) => state.rollbackRunChanges)
  const openDetailPanel = useUIStore((state) => state.openDetailPanel)
  const [expandedChangeId, setExpandedChangeId] = React.useState<string | null>(null)
  const [isRollingBack, setIsRollingBack] = React.useState(false)
  const aggregatedChanges = React.useMemo(
    () => aggregateDisplayableRunFileChanges(changeSet.changes),
    [changeSet.changes]
  )
  const summariesByChangeId = useAggregatedChangeSummaries(aggregatedChanges)

  React.useEffect(() => {
    setExpandedChangeId((current) =>
      current && aggregatedChanges.some((change) => change.id === current) ? current : null
    )
  }, [aggregatedChanges])

  const summary = React.useMemo(
    () =>
      aggregatedChanges.reduce(
        (acc, change) => {
          const stats = summariesByChangeId[change.id]
          if (!stats) return acc
          acc.added += stats.added
          acc.deleted += stats.deleted
          return acc
        },
        { added: 0, deleted: 0 }
      ),
    [aggregatedChanges, summariesByChangeId]
  )

  const pendingCount = React.useMemo(
    () =>
      aggregatedChanges.filter(
        (change) => change.status === 'open' || change.status === 'conflicted'
      ).length,
    [aggregatedChanges]
  )
  const actionable = pendingCount > 0

  if (aggregatedChanges.length === 0) {
    return null
  }

  const handleRollback = async (): Promise<void> => {
    setIsRollingBack(true)
    try {
      await rollbackRunChanges(runId)
    } finally {
      setIsRollingBack(false)
    }
  }

  const handleOpenReviewForChange = (changeId: string): void => {
    openDetailPanel({
      type: 'change-review',
      runId,
      initialChangeId: changeId
    })
  }

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-white/[0.06] bg-[#242628] text-zinc-100 shadow-[0_10px_24px_rgba(0,0,0,0.2)]">
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <h3 className="text-[11px] font-medium text-zinc-50">
            {t('fileChange.filesChanged', { count: aggregatedChanges.length })}
          </h3>
          <span className="text-[12px] font-medium text-emerald-300">+{summary.added}</span>
          <span className="text-[12px] font-medium text-red-300">-{summary.deleted}</span>
        </div>

        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-white/[0.05] hover:text-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => void handleRollback()}
          disabled={!actionable || isRollingBack}
        >
          {isRollingBack ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RotateCcw className="size-3.5" />
          )}
          {t('action.undo', { ns: 'common' })}
        </button>
      </div>

      <div className="border-t border-white/[0.06]">
        {aggregatedChanges.map((change) => {
          const stats = summariesByChangeId[change.id] ?? { added: 0, deleted: 0 }
          const expanded = expandedChangeId === change.id

          return (
            <div key={change.id} className="border-b border-white/[0.06] last:border-b-0">
              <div className="flex items-stretch">
                <button
                  type="button"
                  onClick={() =>
                    setExpandedChangeId((current) => (current === change.id ? null : change.id))
                  }
                  className="group flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-white/[0.025]"
                  title={change.filePath}
                >
                  <span
                    className="min-w-0 flex-1 truncate text-[11px] text-zinc-100 transition-colors group-hover:text-white"
                    style={{ fontFamily: MONO_FONT }}
                  >
                    {change.filePath}
                  </span>
                  <div className="flex shrink-0 items-center gap-1.5 text-[10px] font-medium">
                    <span className="text-emerald-300">+{stats.added}</span>
                    <span className="text-red-300">-{stats.deleted}</span>
                  </div>
                </button>

                <div className="flex shrink-0 items-center gap-0.5 px-2">
                  {expanded ? (
                    <button
                      type="button"
                      className="rounded p-1 text-zinc-500 transition-colors hover:bg-white/[0.05] hover:text-zinc-200"
                      onClick={() => handleOpenReviewForChange(change.lastChangeId)}
                      title={t('fileChange.openReview', { defaultValue: 'Open review' })}
                      aria-label={t('fileChange.openReview', { defaultValue: 'Open review' })}
                    >
                      <ExternalLink className="size-3" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="rounded p-1 text-zinc-500 transition-colors hover:bg-white/[0.05] hover:text-zinc-200"
                    onClick={() =>
                      setExpandedChangeId((current) => (current === change.id ? null : change.id))
                    }
                    aria-label={expanded ? 'Collapse change' : 'Expand change'}
                  >
                    {expanded ? (
                      <ChevronUp className="size-3" />
                    ) : (
                      <ChevronDown className="size-3" />
                    )}
                  </button>
                </div>
              </div>

              {expanded ? <InlineChangePreview change={change} /> : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
