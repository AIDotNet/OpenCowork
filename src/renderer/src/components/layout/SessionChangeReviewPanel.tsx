import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AnimatePresence, motion } from 'motion/react'
import { Check, ChevronDown, Copy, FileCode, Loader2, RefreshCw, RotateCcw, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { MONO_FONT } from '@renderer/lib/constants'
import { cn } from '@renderer/lib/utils'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import type { UnifiedMessage } from '@renderer/lib/api/types'
import { CodeDiffViewer } from '@renderer/components/chat/CodeDiffViewer'
import {
  type LoadedChangeContent,
  type DiffSummaryStats,
  isLoadedChangeContent,
  loadAggregatedChangeContent,
  useAggregatedChangeSummaries
} from '@renderer/components/chat/change-summary-utils'
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
  latestDisplayableRunChangeSet,
  matchesAggregatedChangeId,
  snapshotText,
  type AggregatedFileChange
} from '@renderer/components/chat/file-change-utils'

interface SessionChangeReviewPanelProps {
  initialChangeId?: string | null
  selectionRequestId?: number
}

const EMPTY_SESSION_MESSAGES: UnifiedMessage[] = []

function isErrorResult(value: unknown): value is { error: string } {
  return !!value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
}

function statusLabelKey(
  change: AggregatedFileChange
): 'fileChange.status.reverted' | 'fileChange.status.pending' {
  if (change.status === 'reverted') return 'fileChange.status.reverted'
  return 'fileChange.status.pending'
}

function statusTone(change: AggregatedFileChange): string {
  if (change.status === 'reverted') return 'text-muted-foreground dark:text-zinc-300'
  return 'text-sky-600 dark:text-sky-300'
}

function actionLabel(change: AggregatedFileChange): string {
  return change.op === 'create' ? 'fileChange.new' : 'fileChange.edited'
}

function CopyIconButton({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation('common')
  const [copied, setCopied] = React.useState(false)

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      }}
      title={t('action.copy')}
      aria-label={t('action.copy')}
    >
      {copied ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
    </Button>
  )
}

function ReviewEmptyState(): React.JSX.Element {
  const { t } = useTranslation('layout')
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="grid size-16 place-items-center rounded-2xl border border-border/60 bg-muted/20">
        <FileCode className="size-7 text-muted-foreground/50" />
      </div>
      <div>
        <p className="text-sm font-medium text-foreground">
          {t('rightPanel.reviewEmptyTitle', { defaultValue: 'No file changes yet' })}
        </p>
        <p className="mt-1 max-w-[280px] text-xs leading-5 text-muted-foreground">
          {t('rightPanel.reviewEmptyDesc', {
            defaultValue:
              'Latest diffs are unavailable. File changes for this session will appear here.'
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
          setLoadedContent(result)
          return
        }

        setLoadError(
          isErrorResult(result)
            ? result.error
            : t('fileChange.loadDiffFailed', { defaultValue: 'Failed to load the full diff' })
        )
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error))
        }
      } finally {
        if (!cancelled) setIsLoading(false)
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
  const diffLines = React.useMemo(() => computeDiff(beforeText, afterText), [afterText, beforeText])
  const diffChunks = React.useMemo(() => foldContext(diffLines), [diffLines])
  const diffCopyText = React.useMemo(() => buildDiffCopyText(diffLines), [diffLines])

  if (isLoading && !loadedContent && shouldLoadFullContent) {
    return (
      <div className="flex h-48 items-center justify-center rounded-lg border border-border/60 bg-muted/15 text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin text-emerald-400" />
        {t('thinking.thinkingEllipsis')}
      </div>
    )
  }

  if (loadError && !loadedContent && shouldLoadFullContent) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-4 text-sm text-destructive">
        {loadError}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="text-emerald-600 dark:text-emerald-300">
          {detectLang(change.filePath)}
        </span>
        <span>{t('fileChange.lineCount', { count: lineCount(afterText) })}</span>
        {diffCopyText ? <CopyIconButton text={diffCopyText} /> : null}
      </div>
      <CodeDiffViewer chunks={diffChunks} defaultMode="inline" showModeToggle toolbarEnd={null} />
    </div>
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
  const animationsEnabled = useSettingsStore((s) => s.animationsEnabled)
  const undoFileChange = useAgentStore((state) => state.undoFileChange)
  const [isUndoing, setIsUndoing] = React.useState(false)
  const actionableChanges = React.useMemo(() => actionableSourceChanges(change), [change])
  const actionable = actionableChanges.length > 0

  const handleUndo = async (): Promise<void> => {
    if (!actionable) return
    setIsUndoing(true)
    try {
      for (const entry of [...actionableChanges].sort((a, b) => b.createdAt - a.createdAt)) {
        await undoFileChange(entry.runId, entry.id)
      }
    } finally {
      setIsUndoing(false)
    }
  }

  const renderExpanded = (): React.JSX.Element => (
    <div className="border-t border-border/50 px-4 pb-4 pt-3">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
        <span className={cn(statusTone(change))}>{t(statusLabelKey(change))}</span>
        <span className="text-muted-foreground">
          {t(`fileChange.transport.${change.transport}`)}
        </span>
      </div>
      <ChangeDetail change={change} />
    </div>
  )

  return (
    <motion.div
      layout={animationsEnabled ? 'position' : false}
      initial={animationsEnabled ? { opacity: 0, y: -4 } : false}
      animate={animationsEnabled ? { opacity: 1, y: 0 } : undefined}
      exit={animationsEnabled ? { opacity: 0 } : undefined}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className={cn(
        'overflow-hidden border-b border-border/50 transition-colors last:border-b-0',
        expanded ? 'bg-muted/30' : 'hover:bg-muted/20'
      )}
    >
      <div className="flex items-start gap-1.5 px-3 py-2.5">
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
              expanded ? 'rotate-180 text-foreground' : 'text-muted-foreground'
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <span className="text-[10px] font-medium text-muted-foreground">
                {t(actionLabel(change))}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
                {fileName(change.filePath)}
              </span>
              <span className="shrink-0 text-[10px] font-semibold text-emerald-600 dark:text-emerald-300">
                +{summary.added}
              </span>
              <span className="shrink-0 text-[10px] font-semibold text-red-600 dark:text-red-300">
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
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => void handleUndo()}
            disabled={isUndoing}
            title={t('action.undo', { ns: 'common' })}
            aria-label={t('action.undo', { ns: 'common' })}
          >
            {isUndoing ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />}
          </Button>
        ) : (
          <RotateCcw className="mt-1 size-4 shrink-0 text-muted-foreground" />
        )}
      </div>

      {animationsEnabled ? (
        <AnimatePresence initial={false}>
          {expanded ? (
            <motion.div
              key="diff"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              {renderExpanded()}
            </motion.div>
          ) : null}
        </AnimatePresence>
      ) : expanded ? (
        renderExpanded()
      ) : null}
    </motion.div>
  )
}

export function SessionChangeReviewPanel({
  initialChangeId = null,
  selectionRequestId
}: SessionChangeReviewPanelProps): React.JSX.Element {
  const { t } = useTranslation(['layout', 'chat', 'common'])
  const activeScopedSessionId = useUIStore((state) => state.activeScopedSessionId)
  const chatActiveSessionId = useChatStore((state) => state.activeSessionId)
  const activeSessionId = activeScopedSessionId ?? chatActiveSessionId
  const sessionMessages = useChatStore((state) => {
    if (!activeSessionId) return EMPTY_SESSION_MESSAGES
    return (
      state.sessions.find((session) => session.id === activeSessionId)?.messages ??
      EMPTY_SESSION_MESSAGES
    )
  })
  const runChangesByRunId = useAgentStore((state) => state.runChangesByRunId)
  const refreshSessionRunChanges = useAgentStore((state) => state.refreshSessionRunChanges)
  const undoRunChanges = useAgentStore((state) => state.undoRunChanges)
  const [selectedChangeId, setSelectedChangeId] = React.useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = React.useState(false)
  const [isUndoingAll, setIsUndoingAll] = React.useState(false)
  const requestedRefreshKeyRef = React.useRef<string | null>(null)
  const lastInitialChangeIdRef = React.useRef<string | null>(null)
  const lastSelectionRequestIdRef = React.useRef<number | undefined>(undefined)

  const assistantMessageIds = React.useMemo(() => {
    const ids = new Set<string>()
    for (const message of sessionMessages) {
      if (message.role === 'assistant') ids.add(message.id)
    }
    return ids
  }, [sessionMessages])

  React.useEffect(() => {
    if (!activeSessionId) return
    if (requestedRefreshKeyRef.current === activeSessionId) return
    requestedRefreshKeyRef.current = activeSessionId
    setIsRefreshing(true)
    void refreshSessionRunChanges(activeSessionId).finally(() => setIsRefreshing(false))
  }, [activeSessionId, refreshSessionRunChanges])

  const sessionChangeSets = React.useMemo(() => {
    const seen = new Set<string>()
    return Object.values(runChangesByRunId)
      .filter((changeSet) => {
        if (!activeSessionId) return false
        if (changeSet.sessionId === activeSessionId) return true
        if (changeSet.changes.some((change) => change.sessionId === activeSessionId)) return true
        return (
          assistantMessageIds.has(changeSet.assistantMessageId) ||
          assistantMessageIds.has(changeSet.runId)
        )
      })
      .filter((changeSet) => {
        if (seen.has(changeSet.runId)) return false
        seen.add(changeSet.runId)
        return true
      })
      .sort((left, right) => left.createdAt - right.createdAt)
  }, [activeSessionId, assistantMessageIds, runChangesByRunId])

  const latestChangeSet = React.useMemo(
    () => latestDisplayableRunChangeSet(sessionChangeSets),
    [sessionChangeSets]
  )
  const aggregatedChanges = React.useMemo(
    () =>
      aggregateDisplayableRunFileChanges(latestChangeSet?.changes ?? []).sort(
        (left, right) => left.createdAt - right.createdAt
      ),
    [latestChangeSet]
  )
  const summariesByChangeId = useAggregatedChangeSummaries(aggregatedChanges)

  React.useEffect(() => {
    const nextInitialChangeId = initialChangeId ?? null
    const selectionRequested =
      selectionRequestId !== undefined && lastSelectionRequestIdRef.current !== selectionRequestId
    setSelectedChangeId((current) => {
      const preferredId =
        nextInitialChangeId &&
        (selectionRequested || lastInitialChangeIdRef.current !== nextInitialChangeId || !current)
          ? nextInitialChangeId
          : current
      if (!preferredId) return null
      const matched = aggregatedChanges.find((change) =>
        matchesAggregatedChangeId(change, preferredId)
      )
      return matched?.id ?? null
    })
    lastInitialChangeIdRef.current = nextInitialChangeId
    lastSelectionRequestIdRef.current = selectionRequestId
  }, [aggregatedChanges, initialChangeId, selectionRequestId])

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

  const undoableRunIds = React.useMemo(
    () =>
      Array.from(
        new Set(
          sessionChangeSets
            .filter(
              (changeSet) =>
                changeSet.runId === latestChangeSet?.runId &&
                changeSet.changes.some((change) => change.status === 'open')
            )
            .map((changeSet) => changeSet.runId)
        )
      ),
    [latestChangeSet, sessionChangeSets]
  )
  const actionable = undoableRunIds.length > 0

  const handleRefresh = async (): Promise<void> => {
    if (!activeSessionId) return
    setIsRefreshing(true)
    try {
      await refreshSessionRunChanges(activeSessionId)
    } finally {
      setIsRefreshing(false)
    }
  }

  const handleUndoAll = async (): Promise<void> => {
    if (undoableRunIds.length === 0) return
    setIsUndoingAll(true)
    try {
      for (const runId of undoableRunIds) {
        await undoRunChanges(runId)
      }
    } finally {
      setIsUndoingAll(false)
    }
  }

  if (isRefreshing && aggregatedChanges.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin text-emerald-400" />
        {t('thinking.thinkingEllipsis', { ns: 'chat' })}
      </div>
    )
  }

  if (aggregatedChanges.length === 0) {
    return <ReviewEmptyState />
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border/50 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-muted-foreground">
                {t('fileChange.filesChanged', {
                  ns: 'chat',
                  count: aggregatedChanges.length
                })}
              </span>
              <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-300">
                +{summary.added}
              </span>
              <span className="text-xs font-semibold text-red-600 dark:text-red-300">
                -{summary.deleted}
              </span>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t('rightPanel.reviewSessionDesc', {
                defaultValue:
                  'Review the latest file changes captured in the current session. Expand a file to inspect the diff.'
              })}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => void handleRefresh()}
              disabled={isRefreshing || isUndoingAll}
              title={t('action.refresh', { ns: 'common', defaultValue: 'Refresh' })}
            >
              <RefreshCw className={cn('size-3.5', isRefreshing && 'animate-spin')} />
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => void handleUndoAll()}
              disabled={!actionable || isRefreshing || isUndoingAll}
            >
              {isUndoingAll ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <RotateCcw className="size-3" />
              )}
              {t('action.undo', { ns: 'common' })}
            </Button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <AnimatePresence initial={false}>
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
        </AnimatePresence>
      </div>
    </div>
  )
}
