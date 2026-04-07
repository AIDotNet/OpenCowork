import * as React from 'react'
import { CheckCircle2, Loader2, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'
import type { AgentRunChangeSet } from '@renderer/stores/agent-store'
import { useAgentStore } from '@renderer/stores/agent-store'

interface RunChangeReviewCardProps {
  runId: string
  changeSet: AgentRunChangeSet
}

function summarizeFiles(changeSet: AgentRunChangeSet): string[] {
  return [
    ...new Set(
      changeSet.changes.map((change) => change.filePath.split(/[\\/]/).slice(-2).join('/'))
    )
  ]
}

export function RunChangeReviewCard({
  runId,
  changeSet
}: RunChangeReviewCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const acceptRunChanges = useAgentStore((state) => state.acceptRunChanges)
  const rollbackRunChanges = useAgentStore((state) => state.rollbackRunChanges)
  const [isAccepting, setIsAccepting] = React.useState(false)
  const [isRollingBack, setIsRollingBack] = React.useState(false)
  const fileLabels = React.useMemo(() => summarizeFiles(changeSet), [changeSet])
  const pendingCount = React.useMemo(
    () =>
      changeSet.changes.filter(
        (change) => change.status === 'open' || change.status === 'conflicted'
      ).length,
    [changeSet]
  )
  const actionable = pendingCount > 0

  const handleAccept = async (): Promise<void> => {
    setIsAccepting(true)
    try {
      await acceptRunChanges(runId)
    } finally {
      setIsAccepting(false)
    }
  }

  const handleRollback = async (): Promise<void> => {
    setIsRollingBack(true)
    try {
      await rollbackRunChanges(runId)
    } finally {
      setIsRollingBack(false)
    }
  }

  const statusLabel =
    changeSet.status === 'accepted'
      ? t('fileChange.runStatus.accepted')
      : changeSet.status === 'reverted'
        ? t('fileChange.runStatus.reverted')
        : changeSet.status === 'conflicted'
          ? t('fileChange.runStatus.conflicted')
          : changeSet.status === 'partial'
            ? t('fileChange.runStatus.partial')
            : t('fileChange.runStatus.review')

  return (
    <div className="mt-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 text-xs font-medium text-foreground">
            <CheckCircle2 className="size-3.5 text-emerald-500" />
            <span>{statusLabel}</span>
            <span className="text-[10px] text-muted-foreground/60">
              {t('fileChange.runSummary', { files: fileLabels.length, pending: pendingCount })}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5 text-[10px] text-muted-foreground/70">
            {fileLabels.slice(0, 5).map((label) => (
              <span key={label} className="rounded bg-background/70 px-1.5 py-0.5 font-mono">
                {label}
              </span>
            ))}
            {fileLabels.length > 5 && (
              <span className="rounded bg-background/70 px-1.5 py-0.5">
                {t('fileChange.moreFiles', { count: fileLabels.length - 5 })}
              </span>
            )}
          </div>
          {pendingCount > 0 && (
            <p className="text-[10px] text-muted-foreground/60">{t('fileChange.bulkActionsHint')}</p>
          )}
          {changeSet.status === 'conflicted' && (
            <p className="text-[10px] text-amber-500/80">{t('fileChange.conflictedHint')}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={handleAccept}
            disabled={!actionable || isAccepting || isRollingBack}
          >
            {isAccepting ? <Loader2 className="size-3 animate-spin" /> : null}
            {t('action.allow', { ns: 'common' })}
          </Button>
          <Button
            type="button"
            size="xs"
            variant={changeSet.status === 'conflicted' ? 'outline' : 'destructive'}
            onClick={handleRollback}
            disabled={!actionable || isAccepting || isRollingBack}
            className={cn(
              changeSet.status === 'conflicted' &&
                'border-amber-500/30 text-amber-500 hover:bg-amber-500/10'
            )}
          >
            {isRollingBack ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RotateCcw className="size-3" />
            )}
            {t('action.undo', { ns: 'common' })}
          </Button>
        </div>
      </div>
    </div>
  )
}
