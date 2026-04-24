import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  FileCode,
  Loader2,
  RotateCcw,
  X,
  XCircle
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Sheet, SheetContent } from '@renderer/components/ui/sheet'
import { MONO_FONT } from '@renderer/lib/constants'
import { cn } from '@renderer/lib/utils'
import type { AgentRunChangeSet } from '@renderer/stores/agent-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { CodeDiffViewer } from './CodeDiffViewer'
import {
  type LoadedChangeContent,
  type DiffSummaryStats,
  isLoadedChangeContent,
  loadAggregatedChangeContent,
  useAggregatedChangeSummaries
} from './change-summary-utils'
import {
  actionableSourceChanges,
  aggregateDisplayableRunFileChanges,
  buildDiffCopyText,
  canRenderInlineSnapshot,
  computeDiff,
  detectLang,
  fileName,
  foldContext,
  lineCount,
  matchesAggregatedChangeId,
  snapshotText,
  type AggregatedFileChange
} from './file-change-utils'

interface ChangeReviewSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  changeSet: AgentRunChangeSet
  initialChangeId?: string | null
}

function isErrorResult(value: unknown): value is { error: string } {
  return !!value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
}

function actionLabelKey(change: AggregatedFileChange): 'fileChange.new' | 'fileChange.edited' {
  return change.op === 'create' ? 'fileChange.new' : 'fileChange.edited'
}

function isActionableChange(change: AggregatedFileChange): boolean {
  return actionableSourceChanges(change).length > 0
}

function statusLabelKey(
  change: AggregatedFileChange
):
  | 'fileChange.status.accepted'
  | 'fileChange.status.reverted'
  | 'fileChange.status.conflict'
  | 'fileChange.status.pending' {
  if (change.status === 'accepted') return 'fileChange.status.accepted'
  if (change.status === 'reverted') return 'fileChange.status.reverted'
  if (change.status === 'conflicted') return 'fileChange.status.conflict'
  return 'fileChange.status.pending'
}

function statusTone(change: AggregatedFileChange): string {
  if (change.status === 'accepted') {
    return 'text-emerald-600 dark:text-emerald-300'
  }
  if (change.status === 'reverted') {
    return 'text-muted-foreground dark:text-zinc-300'
  }
  if (change.status === 'conflicted') {
    return 'text-amber-600 dark:text-amber-300'
  }
  return 'text-sky-600 dark:text-sky-300'
}

function actionTone(): string {
  return 'text-muted-foreground dark:text-zinc-400'
}

function transportTone(change: AggregatedFileChange): string {
  return change.transport === 'ssh'
    ? 'text-sky-600 dark:text-sky-300'
    : 'text-muted-foreground dark:text-zinc-400'
}

function ActionLabel({ change }: { change: AggregatedFileChange }): React.JSX.Element {
  const { t } = useTranslation('chat')
  return (
    <span className={cn('inline-flex items-center text-[10px] font-medium', actionTone())}>
      {t(actionLabelKey(change))}
    </span>
  )
}

function CopyIconButton({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation(['common'])
  const [copied, setCopied] = React.useState(false)

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="rounded-full text-muted-foreground hover:bg-muted hover:text-foreground dark:text-zinc-400 dark:hover:bg-white/[0.08] dark:hover:text-white"
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      }}
      title={t('action.copy', { ns: 'common' })}
      aria-label={t('action.copy', { ns: 'common' })}
    >
      {copied ? <Check className="size-3 text-emerald-300" /> : <Copy className="size-3" />}
    </Button>
  )
}

function CodeFrame({
  content,
  maxHeight = 520
}: {
  content: string
  maxHeight?: number
}): React.JSX.Element {
  const lines = React.useMemo(() => content.split('\n'), [content])

  return (
    <div
      className="overflow-auto rounded-[18px] border border-white/8 bg-[#111214] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
      style={{ maxHeight, fontFamily: MONO_FONT }}
    >
      {lines.map((line, index) => (
        <div
          key={`${index}-${line.length}`}
          className="grid grid-cols-[56px_minmax(0,1fr)] border-b border-white/[0.04] text-[11px] leading-5 last:border-b-0"
        >
          <span className="select-none border-r border-white/[0.05] px-2 py-1 text-right text-zinc-600">
            {index + 1}
          </span>
          <span className="min-w-0 whitespace-pre-wrap break-all px-3 py-1 text-zinc-100">
            {line || ' '}
          </span>
        </div>
      ))}
    </div>
  )
}

function EmptyState(): React.JSX.Element {
  const { t } = useTranslation('chat')
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <FileCode className="size-8 text-zinc-500" />
      <div>
        <p className="text-sm font-medium text-zinc-100">
          {t('fileChange.reviewEmpty', { defaultValue: 'No file changes to review' })}
        </p>
        <p className="mt-1 text-xs text-zinc-500">
          {t('fileChange.reviewEmptyHint', {
            defaultValue: 'Changed files and diffs will appear here for this run.'
          })}
        </p>
      </div>
    </div>
  )
}

function ChangeDetail({ change }: { change: AggregatedFileChange }): React.JSX.Element {
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
  const diffLines = React.useMemo(
    () => (change.op === 'modify' ? computeDiff(beforeText, afterText) : []),
    [afterText, beforeText, change.op]
  )
  const diffChunks = React.useMemo(() => foldContext(diffLines), [diffLines])
  const diffCopyText = React.useMemo(() => buildDiffCopyText(diffLines), [diffLines])

  if (isLoading && !loadedContent && shouldLoadFullContent) {
    return (
      <div className="flex h-[320px] items-center justify-center rounded-[20px] border border-white/8 bg-[#111214] text-sm text-zinc-400">
        <Loader2 className="mr-2 size-4 animate-spin text-emerald-400" />
        {t('thinking.thinkingEllipsis')}
      </div>
    )
  }

  if (loadError && !loadedContent && shouldLoadFullContent) {
    return (
      <div className="rounded-[20px] border border-red-500/20 bg-red-500/10 px-4 py-4 text-sm text-red-200">
        {loadError}
      </div>
    )
  }

  if (change.op === 'create') {
    const copyText = afterText || change.after.previewText || ''
    const displayText = afterText || change.after.previewText || ''

    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
          <span className="text-[11px] text-emerald-300">{detectLang(change.filePath)}</span>
          <span>{t('fileChange.lineCount', { count: lineCount(displayText) })}</span>
          {copyText ? <CopyIconButton text={copyText} /> : null}
        </div>
        <CodeFrame content={displayText || change.after.previewText || ''} />
      </div>
    )
  }

  return (
    <CodeDiffViewer
      chunks={diffChunks}
      defaultMode="inline"
      toolbarEnd={diffCopyText ? <CopyIconButton text={diffCopyText} /> : null}
    />
  )
}

function ChangeRow({
  change,
  summary,
  expanded,
  onToggle
}: {
  change: AggregatedFileChange
  summary: DiffSummaryStats
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { t } = useTranslation(['chat', 'common'])
  const acceptFileChange = useAgentStore((state) => state.acceptFileChange)
  const rollbackFileChange = useAgentStore((state) => state.rollbackFileChange)
  const [isAccepting, setIsAccepting] = React.useState(false)
  const [isRollingBack, setIsRollingBack] = React.useState(false)
  const actionableChanges = React.useMemo(() => actionableSourceChanges(change), [change])
  const actionable = isActionableChange(change)

  const handleAccept = async (): Promise<void> => {
    if (!actionable) return
    setIsAccepting(true)
    try {
      for (const entry of actionableChanges) {
        await acceptFileChange(entry.runId, entry.id)
      }
    } finally {
      setIsAccepting(false)
    }
  }

  const handleRollback = async (): Promise<void> => {
    if (!actionable) return
    setIsRollingBack(true)
    try {
      for (const entry of [...actionableChanges].reverse()) {
        await rollbackFileChange(entry.runId, entry.id)
      }
    } finally {
      setIsRollingBack(false)
    }
  }

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border transition-colors',
        expanded
          ? 'border-border bg-muted/40 dark:border-white/[0.12] dark:bg-white/[0.03]'
          : 'border-border bg-card hover:border-muted-foreground/30 dark:border-white/[0.06] dark:bg-[#0f1012] dark:hover:border-white/[0.1]'
      )}
    >
      <div className="flex items-start gap-1.5 px-2.5 py-2">
        <button
          type="button"
          className="min-w-0 flex flex-1 items-start gap-2.5 text-left"
          onClick={onToggle}
          title={change.filePath}
          aria-expanded={expanded}
        >
          <ChevronDown
            className={cn(
              'mt-0.5 size-3.5 shrink-0 transition-transform duration-200',
              expanded ? 'rotate-180 text-foreground dark:text-zinc-300' : 'text-muted-foreground'
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <ActionLabel change={change} />
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-sky-600 dark:text-sky-300">
                {fileName(change.filePath)}
              </span>
              <span className="shrink-0 text-[10px] font-medium text-emerald-600 dark:text-emerald-300">
                +{summary.added}
              </span>
              <span className="shrink-0 text-[10px] font-medium text-red-600 dark:text-red-300">
                -{summary.deleted}
              </span>
            </div>
            <div
              className="mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-muted-foreground"
              style={{ fontFamily: MONO_FONT }}
            >
              {change.filePath}
            </div>
          </div>
        </button>

        {actionable ? (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="rounded-full text-muted-foreground hover:bg-muted hover:text-foreground dark:text-zinc-500 dark:hover:bg-white/[0.03] dark:hover:text-white"
              onClick={() => void handleRollback()}
              disabled={isAccepting || isRollingBack}
              title={t('action.undo', { ns: 'common' })}
              aria-label={t('action.undo', { ns: 'common' })}
            >
              {isRollingBack ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <X className="size-3" />
              )}
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="rounded-full text-emerald-600 hover:bg-muted hover:text-emerald-700 dark:text-emerald-300 dark:hover:bg-white/[0.03] dark:hover:text-emerald-200"
              onClick={() => void handleAccept()}
              disabled={isAccepting || isRollingBack}
              title={t('action.allow', { ns: 'common' })}
              aria-label={t('action.allow', { ns: 'common' })}
            >
              {isAccepting ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Check className="size-3" />
              )}
            </Button>
          </div>
        ) : change.status === 'accepted' ? (
          <CheckCircle2 className="mt-1 size-4 shrink-0 text-emerald-400" />
        ) : change.status === 'reverted' ? (
          <RotateCcw className="mt-1 size-4 shrink-0 text-muted-foreground" />
        ) : (
          <XCircle className="mt-1 size-4 shrink-0 text-amber-400" />
        )}
      </div>

      {expanded ? (
        <div className="border-t border-border px-3 pb-3 pt-2.5 dark:border-white/[0.06]">
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
            <span className={cn(statusTone(change))}>{t(statusLabelKey(change))}</span>
            <span className={cn(transportTone(change))}>
              {t(`fileChange.transport.${change.transport}`)}
            </span>
          </div>
          <div
            className="mb-2 break-all text-[10px] text-muted-foreground"
            style={{ fontFamily: MONO_FONT }}
          >
            {change.filePath}
          </div>
          <ChangeDetail change={change} />
        </div>
      ) : null}
    </div>
  )
}

interface ChangeReviewPanelContentProps {
  runId: string
  initialChangeId?: string | null
  changeSetOverride?: AgentRunChangeSet | null
}

export function ChangeReviewPanelContent({
  runId,
  initialChangeId = null,
  changeSetOverride = null
}: ChangeReviewPanelContentProps): React.JSX.Element {
  const { t } = useTranslation(['chat', 'common'])
  const storedChangeSet = useAgentStore((state) => state.runChangesByRunId[runId] ?? null)
  const refreshRunChanges = useAgentStore((state) => state.refreshRunChanges)
  const acceptRunChanges = useAgentStore((state) => state.acceptRunChanges)
  const rollbackRunChanges = useAgentStore((state) => state.rollbackRunChanges)
  const [selectedChangeId, setSelectedChangeId] = React.useState<string | null>(null)
  const [isAcceptingAll, setIsAcceptingAll] = React.useState(false)
  const [isRollingBackAll, setIsRollingBackAll] = React.useState(false)
  const [isRefreshing, setIsRefreshing] = React.useState(false)
  const requestedRunIdRef = React.useRef<string | null>(null)
  const changeSet = changeSetOverride ?? storedChangeSet
  const aggregatedChanges = React.useMemo(
    () => aggregateDisplayableRunFileChanges(changeSet?.changes ?? []),
    [changeSet?.changes]
  )
  const summariesByChangeId = useAggregatedChangeSummaries(aggregatedChanges)

  React.useEffect(() => {
    if (changeSetOverride || changeSet || requestedRunIdRef.current === runId) return

    let cancelled = false
    requestedRunIdRef.current = runId
    setIsRefreshing(true)

    void refreshRunChanges(runId).finally(() => {
      if (!cancelled) {
        setIsRefreshing(false)
      }
    })

    return () => {
      cancelled = true
    }
  }, [changeSet, changeSetOverride, refreshRunChanges, runId])

  React.useEffect(() => {
    if (!changeSet) {
      setSelectedChangeId(null)
      return
    }

    setSelectedChangeId((current) => {
      const preferredId = current ?? initialChangeId
      if (!preferredId) return null
      const matched = aggregatedChanges.find((change) =>
        matchesAggregatedChangeId(change, preferredId)
      )
      return matched?.id ?? null
    })
  }, [aggregatedChanges, changeSet, initialChangeId])

  const summary = React.useMemo(
    () =>
      aggregatedChanges.reduce(
        (acc, change) => {
          const next = summariesByChangeId[change.id]
          if (!next) return acc
          acc.added += next.added
          acc.deleted += next.deleted
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

  const handleAcceptAll = async (): Promise<void> => {
    setIsAcceptingAll(true)
    try {
      await acceptRunChanges(runId)
    } finally {
      setIsAcceptingAll(false)
    }
  }

  const handleRollbackAll = async (): Promise<void> => {
    setIsRollingBackAll(true)
    try {
      await rollbackRunChanges(runId)
    } finally {
      setIsRollingBackAll(false)
    }
  }

  if (isRefreshing && !changeSet) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-400">
        <Loader2 className="mr-2 size-4 animate-spin text-emerald-400" />
        {t('thinking.thinkingEllipsis')}
      </div>
    )
  }

  if (!changeSet || aggregatedChanges.length === 0) {
    return <EmptyState />
  }

  return (
    <div className="flex h-full min-h-0 flex-col text-foreground dark:text-zinc-100">
      <div className="px-4 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-muted-foreground dark:text-zinc-400">
                {t('fileChange.filesChanged', { count: aggregatedChanges.length })}
              </span>
              <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-300">
                +{summary.added}
              </span>
              <span className="text-xs font-semibold text-red-600 dark:text-red-300">
                -{summary.deleted}
              </span>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {t('fileChange.reviewPanelDescription', {
                defaultValue:
                  'Review the changed files from this run, expand an item to inspect details, and confirm or undo each change.'
              })}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="text-foreground hover:bg-muted dark:text-zinc-200 dark:hover:bg-white/[0.04]"
              onClick={() => void handleAcceptAll()}
              disabled={!actionable || isAcceptingAll || isRollingBackAll}
            >
              {isAcceptingAll ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Check className="size-3" />
              )}
              {t('action.allow', { ns: 'common' })}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="text-foreground hover:bg-muted dark:text-zinc-200 dark:hover:bg-white/[0.04]"
              onClick={() => void handleRollbackAll()}
              disabled={!actionable || isAcceptingAll || isRollingBackAll}
            >
              {isRollingBackAll ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <RotateCcw className="size-3" />
              )}
              {t('action.undo', { ns: 'common' })}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="px-4 py-2">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            {t('fileChange.reviewFileList', { defaultValue: 'Files' })}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <div className="space-y-1.5">
            {aggregatedChanges.map((change) => (
              <ChangeRow
                key={change.id}
                change={change}
                summary={summariesByChangeId[change.id] ?? { added: 0, deleted: 0 }}
                expanded={change.id === selectedChangeId}
                onToggle={() =>
                  setSelectedChangeId((current) => (current === change.id ? null : change.id))
                }
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export function ChangeReviewSheet({
  open,
  onOpenChange,
  changeSet,
  initialChangeId = null
}: ChangeReviewSheetProps): React.JSX.Element {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[min(820px,calc(100vw-24px))] max-w-none gap-0 border-l border-white/10 bg-[#0d0e10]/98 p-0 text-zinc-100 shadow-[-24px_0_60px_rgba(0,0,0,0.45)] backdrop-blur-2xl sm:max-w-[820px]"
      >
        <ChangeReviewPanelContent
          runId={changeSet.runId}
          initialChangeId={initialChangeId}
          changeSetOverride={changeSet}
        />
      </SheetContent>
    </Sheet>
  )
}
