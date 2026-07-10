import * as React from 'react'
import { ChevronDown, ChevronUp, FileCode, Loader2, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { MONO_FONT } from '@renderer/lib/constants'
import { useAgentStore, type AgentRunChangeSet } from '@renderer/stores/agent-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useAggregatedChangeSummaries } from './change-summary-utils'
import {
  aggregateDisplayableRunFileChanges,
  latestDisplayableRunChangeSet,
  type AggregatedFileChange
} from './file-change-utils'

interface SessionChangeSummaryCardProps {
  sessionId?: string | null
  messageId?: string
  toolUseIds?: readonly string[]
}

const DEFAULT_EXPANDED_FILE_LIMIT = 4

function changeSetMatchesMessage(
  changeSet: AgentRunChangeSet,
  messageId: string | undefined,
  sessionId: string | null | undefined,
  toolUseIdSet: Set<string>
): boolean {
  if (messageId && (changeSet.runId === messageId || changeSet.assistantMessageId === messageId)) {
    return true
  }

  if (toolUseIdSet.size === 0) return false

  if (
    sessionId &&
    changeSet.sessionId &&
    changeSet.sessionId !== sessionId &&
    !changeSet.changes.some((change) => change.sessionId === sessionId)
  ) {
    return false
  }

  return changeSet.changes.some((change) => change.toolUseId && toolUseIdSet.has(change.toolUseId))
}

function useMessageChangeSets({
  messageId,
  sessionId,
  toolUseIds = []
}: SessionChangeSummaryCardProps): AgentRunChangeSet[] {
  const runChangesByRunId = useAgentStore((state) => state.runChangesByRunId)

  return React.useMemo(() => {
    const seen = new Set<string>()
    const toolUseIdSet = new Set(toolUseIds)

    return Object.values(runChangesByRunId)
      .filter((changeSet) => {
        if (seen.has(changeSet.runId)) return false
        seen.add(changeSet.runId)
        return changeSetMatchesMessage(changeSet, messageId, sessionId, toolUseIdSet)
      })
      .sort((left, right) => left.createdAt - right.createdAt)
  }, [messageId, runChangesByRunId, sessionId, toolUseIds])
}

export function SessionChangeSummaryCard({
  sessionId,
  messageId,
  toolUseIds = []
}: SessionChangeSummaryCardProps): React.JSX.Element | null {
  const { t } = useTranslation(['chat', 'common'])
  const undoFileChange = useAgentStore((state) => state.undoFileChange)
  const undoRunChanges = useAgentStore((state) => state.undoRunChanges)
  const openDetailPanel = useUIStore((state) => state.openDetailPanel)
  const changeSets = useMessageChangeSets({ sessionId, messageId, toolUseIds })
  const latestChangeSet = React.useMemo(
    () => latestDisplayableRunChangeSet(changeSets),
    [changeSets]
  )
  const [isUndoing, setIsUndoing] = React.useState(false)

  const aggregatedChanges = React.useMemo(
    () =>
      aggregateDisplayableRunFileChanges(latestChangeSet?.changes ?? []).sort(
        (left, right) => left.createdAt - right.createdAt
      ),
    [latestChangeSet]
  )
  const summariesByChangeId = useAggregatedChangeSummaries(aggregatedChanges)
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
  const undoableRunIds = React.useMemo(
    () =>
      Array.from(
        new Set(
          changeSets
            .filter(
              (changeSet) =>
                changeSet.runId === latestChangeSet?.runId &&
                changeSet.changes.some((change) => change.status === 'open')
            )
            .map((changeSet) => changeSet.runId)
        )
      ),
    [changeSets, latestChangeSet]
  )
  const canUndo = undoableRunIds.length > 0
  const canCollapseFileList = aggregatedChanges.length > DEFAULT_EXPANDED_FILE_LIMIT
  const [fileListState, setFileListState] = React.useState(() => ({
    changeCount: aggregatedChanges.length,
    collapsed: canCollapseFileList,
    touched: false
  }))
  const fileListCollapsed = canCollapseFileList && fileListState.collapsed

  React.useEffect(() => {
    setFileListState((current) => {
      if (current.touched && current.changeCount === aggregatedChanges.length) return current
      return {
        changeCount: aggregatedChanges.length,
        collapsed: aggregatedChanges.length > DEFAULT_EXPANDED_FILE_LIMIT,
        touched: false
      }
    })
  }, [aggregatedChanges.length])

  if (aggregatedChanges.length === 0) return null

  const handleOpenReview = (change: AggregatedFileChange = aggregatedChanges[0]): void => {
    openDetailPanel({
      type: 'change-review',
      runId: latestChangeSet?.runId ?? change.runId,
      initialChangeId: change.lastChangeId
    })
  }

  const handleUndoAll = async (): Promise<void> => {
    if (undoableRunIds.length === 0) return
    const confirmed = await confirm({
      title: t('fileChange.undoRunConfirmTitle'),
      description: t('fileChange.undoRunConfirmDesc', { count: undoableRunIds.length }),
      confirmLabel: t('fileChange.undoConfirmAction'),
      variant: 'destructive'
    })
    if (!confirmed) return
    setIsUndoing(true)
    try {
      for (const runId of undoableRunIds) {
        await undoRunChanges(runId)
      }
    } finally {
      setIsUndoing(false)
    }
  }

  const renderChangeRow = (change: AggregatedFileChange): React.JSX.Element => {
    const stats = summariesByChangeId[change.id] ?? { added: 0, deleted: 0 }
    const reverted = change.status === 'reverted'
    const lastSource = change.sourceChanges[change.sourceChanges.length - 1]
    const undoTargetRunId = lastSource?.runId ?? change.runId
    const undoTargetChangeId = lastSource?.id ?? change.lastChangeId
    const handleUndoFile = async (): Promise<void> => {
      const confirmed = await confirm({
        title: t('fileChange.undoFileConfirmTitle'),
        description: t('fileChange.undoFileConfirmDesc', { path: change.filePath }),
        confirmLabel: t('fileChange.undoConfirmAction'),
        variant: 'destructive'
      })
      if (!confirmed) return
      await undoFileChange(undoTargetRunId, undoTargetChangeId)
    }

    return (
      <div
        key={change.id}
        className="group flex min-h-9 w-full items-center gap-3 px-4 py-2 transition-colors hover:bg-muted/35"
        title={change.filePath}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          onClick={() => handleOpenReview(change)}
        >
          <span
            className="min-w-0 flex-1 truncate text-[13px] text-foreground/90"
            style={{ fontFamily: MONO_FONT }}
          >
            {change.filePath}
          </span>
          <span className="shrink-0 text-[12px] font-medium text-emerald-600 dark:text-emerald-300">
            +{stats.added}
          </span>
          <span className="shrink-0 text-[12px] font-medium text-red-600 dark:text-red-300">
            -{stats.deleted}
          </span>
        </button>
        {reverted ? (
          <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
            {t('fileChange.status.reverted')}
          </span>
        ) : (
          <button
            type="button"
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
            onClick={() => void handleUndoFile()}
            disabled={isUndoing}
            title={t('action.undo', { ns: 'common' })}
            aria-label={t('action.undo', { ns: 'common' })}
          >
            <RotateCcw className="size-3" />
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-border/70 bg-background/95 text-foreground shadow-sm">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <FileCode className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-foreground">
                {t('assistantMessage.editedFiles', { count: aggregatedChanges.length })}
              </h3>
              <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-300">
                +{summary.added}
              </span>
              <span className="text-sm font-semibold text-red-600 dark:text-red-300">
                -{summary.deleted}
              </span>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
            onClick={() => void handleUndoAll()}
            disabled={!canUndo || isUndoing}
            title={t('action.undo', { ns: 'common' })}
          >
            {isUndoing ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RotateCcw className="size-3" />
            )}
            {t('action.undo', { ns: 'common' })}
          </button>
          <button
            type="button"
            className="inline-flex h-7 items-center rounded-md border border-border/70 px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted/50"
            onClick={() => handleOpenReview()}
          >
            {t('fileChange.reviewButton', { defaultValue: 'Review' })}
          </button>
        </div>
      </div>

      {canCollapseFileList && (
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 border-t border-border/60 px-4 py-2 text-left text-[12px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
          onClick={() =>
            setFileListState({
              changeCount: aggregatedChanges.length,
              collapsed: !fileListCollapsed,
              touched: true
            })
          }
          aria-expanded={!fileListCollapsed}
        >
          <span>
            {fileListCollapsed
              ? t('fileChange.showFileList', { count: aggregatedChanges.length })
              : t('fileChange.hideFileList', { count: aggregatedChanges.length })}
          </span>
          {fileListCollapsed ? (
            <ChevronDown className="size-3.5 shrink-0" />
          ) : (
            <ChevronUp className="size-3.5 shrink-0" />
          )}
        </button>
      )}

      {!fileListCollapsed && (
        <div className="border-t border-border/60 py-1">
          {aggregatedChanges.map((change) => renderChangeRow(change))}
        </div>
      )}
    </div>
  )
}
