import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AnimatePresence, motion } from 'motion/react'
import {
  Check,
  ChevronDown,
  Copy,
  FileCode,
  GitBranch,
  GitCommit,
  Loader2,
  RefreshCw,
  RotateCcw,
  Wand2,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Textarea } from '@renderer/components/ui/textarea'
import { MONO_FONT } from '@renderer/lib/constants'
import { cn } from '@renderer/lib/utils'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useGitStore, type GitBranchItem } from '@renderer/stores/git-store'
import { generateCommitMessageFromStagedDiff } from '@renderer/lib/git/generate-commit-message'
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
// Stable fallback: an inline `?? []` in a zustand selector is a new array every
// snapshot and trips React's useSyncExternalStore ("Maximum update depth exceeded").
const EMPTY_GIT_BRANCHES: GitBranchItem[] = []

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
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center select-none">
      <div className="grid size-14 place-items-center rounded-2xl border border-border/50 bg-muted/20">
        <FileCode className="size-6 text-muted-foreground/40" />
      </div>
      <div>
        <p className="text-xs font-medium text-foreground">
          {t('rightPanel.reviewEmptyTitle', {
            defaultValue: 'No uncommitted changes on your local branch'
          })}
        </p>
        <p className="mt-1 max-w-[260px] text-[11px] leading-relaxed text-muted-foreground">
          {t('rightPanel.reviewEmptyDesc', {
            defaultValue:
              'File modifications and agent turn outputs will appear here automatically.'
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
      <div className="flex h-44 items-center justify-center rounded-lg border border-border/50 bg-muted/10 text-xs text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin text-emerald-400" />
        {t('thinking.thinkingEllipsis')}
      </div>
    )
  }

  if (loadError && !loadedContent && shouldLoadFullContent) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-3 text-xs text-destructive">
        {loadError}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
        <span className="font-medium text-emerald-500 dark:text-emerald-400">
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
    <div className="border-t border-border/40 px-3 pb-3 pt-2">
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
        'overflow-hidden border-b border-border/40 transition-colors last:border-b-0',
        expanded ? 'bg-muted/30' : 'hover:bg-muted/15'
      )}
    >
      <div className="flex items-start gap-1.5 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
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
              <span className="shrink-0 text-[10px] font-semibold text-emerald-500">
                +{summary.added}
              </span>
              <span className="shrink-0 text-[10px] font-semibold text-red-500">
                -{summary.deleted}
              </span>
            </div>
            <div
              className="mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-muted-foreground/80"
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
            className="rounded p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => void handleUndo()}
            disabled={isUndoing}
            title={t('action.undo', { ns: 'common' })}
            aria-label={t('action.undo', { ns: 'common' })}
          >
            {isUndoing ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />}
          </Button>
        ) : (
          <RotateCcw className="mt-1 size-3.5 shrink-0 text-muted-foreground/40" />
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
              transition={{ duration: 0.18 }}
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

  const activeProject = useChatStore((state) => {
    const session = state.sessions.find((s) => s.id === activeSessionId)
    const pid = session?.projectId ?? state.activeProjectId
    return pid ? state.projects.find((p) => p.id === pid) : null
  })
  const workingFolder = activeProject?.workingFolder ?? null

  const gitCurrentBranch = useGitStore((state) =>
    workingFolder ? (state.repoDetailsByPath[workingFolder]?.currentBranch ?? null) : null
  )
  const gitBranches = useGitStore((state) => {
    if (!workingFolder) return EMPTY_GIT_BRANCHES
    return state.repoDetailsByPath[workingFolder]?.branches ?? EMPTY_GIT_BRANCHES
  })
  const refreshRepository = useGitStore((state) => state.refreshRepository)
  const checkoutBranch = useGitStore((state) => state.checkoutBranch)
  const gitCommit = useGitStore((state) => state.commit)
  const getStagedDiffBundle = useGitStore((state) => state.getStagedDiffBundle)

  const runChangesByRunId = useAgentStore((state) => state.runChangesByRunId)
  const refreshSessionRunChanges = useAgentStore((state) => state.refreshSessionRunChanges)
  const undoRunChanges = useAgentStore((state) => state.undoRunChanges)

  const [selectedChangeId, setSelectedChangeId] = React.useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = React.useState(false)
  const [isUndoingAll, setIsUndoingAll] = React.useState(false)
  const [turnScope, setTurnScope] = React.useState<'latest' | 'uncommitted' | 'all'>('latest')
  const [commitDialogOpen, setCommitDialogOpen] = React.useState(false)
  const [commitMessage, setCommitMessage] = React.useState('')
  const [isGeneratingMessage, setIsGeneratingMessage] = React.useState(false)
  const [isCommitting, setIsCommitting] = React.useState(false)

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

  React.useEffect(() => {
    if (workingFolder) {
      void refreshRepository(workingFolder, { force: true })
    }
  }, [workingFolder, refreshRepository])

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

  const targetChanges = React.useMemo(() => {
    if (turnScope === 'latest') {
      return latestChangeSet?.changes ?? []
    }
    if (turnScope === 'uncommitted') {
      return (latestChangeSet?.changes ?? []).filter((c) => c.status === 'open')
    }
    return sessionChangeSets.flatMap((set) => set.changes)
  }, [latestChangeSet, sessionChangeSets, turnScope])

  const aggregatedChanges = React.useMemo(
    () =>
      aggregateDisplayableRunFileChanges(targetChanges).sort(
        (left, right) => left.createdAt - right.createdAt
      ),
    [targetChanges]
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
      if (workingFolder) {
        await refreshRepository(workingFolder, { force: true })
      }
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

  const handleGenerateCommitMessage = async (): Promise<void> => {
    if (!workingFolder) return
    setIsGeneratingMessage(true)
    try {
      const bundle = await getStagedDiffBundle(workingFolder)
      if (!bundle.success) {
        toast.error(bundle.error || 'Failed to get staged diff')
        return
      }
      if (bundle.empty) {
        toast.error('Nothing staged - cannot generate commit message')
        return
      }
      const generated = await generateCommitMessageFromStagedDiff(
        bundle.stat,
        bundle.patch,
        'en',
        gitCurrentBranch ?? undefined,
        undefined,
        workingFolder
      )
      if (generated) {
        setCommitMessage(generated)
      }
    } catch {
      toast.error('Failed to generate commit message')
    } finally {
      setIsGeneratingMessage(false)
    }
  }

  const handleCommitSubmit = async (): Promise<void> => {
    if (!workingFolder || !commitMessage.trim()) return
    setIsCommitting(true)
    try {
      const result = await gitCommit(workingFolder, commitMessage.trim())
      if (result.success) {
        toast.success('Changes committed successfully')
        setCommitDialogOpen(false)
        setCommitMessage('')
        await handleRefresh()
      } else {
        toast.error(result.error || 'Commit failed')
      }
    } finally {
      setIsCommitting(false)
    }
  }

  const handleCheckoutBranch = async (branchName: string): Promise<void> => {
    if (!workingFolder) return
    const result = await checkoutBranch(workingFolder, branchName)
    if (result.success) {
      toast.success(`Switched to branch ${branchName}`)
      await refreshRepository(workingFolder, { force: true })
    } else {
      toast.error(result.error || `Failed to switch to ${branchName}`)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Tier 2 Context Sub-Header */}
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-border/50 bg-background/80 px-2 text-xs backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-[11px] font-medium text-foreground hover:bg-muted/50"
              >
                <span>
                  {turnScope === 'latest'
                    ? `Last Agent Turn +${summary.added} -${summary.deleted}`
                    : turnScope === 'uncommitted'
                      ? 'Uncommitted Changes'
                      : 'Full Session Changes'}
                </span>
                <ChevronDown className="size-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56 text-xs">
              <DropdownMenuItem onSelect={() => setTurnScope('latest')}>
                Last Agent Turn (+{summary.added} -{summary.deleted})
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setTurnScope('uncommitted')}>
                Uncommitted Changes
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setTurnScope('all')}>
                Full Session Changes
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {workingFolder && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-1.5 text-[11px] font-mono text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                >
                  <GitBranch className="size-3 text-sky-400" />
                  <span className="max-w-28 truncate">{gitCurrentBranch || 'main'}</span>
                  <ChevronDown className="size-3 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48 text-xs font-mono">
                {gitBranches.map((b) => (
                  <DropdownMenuItem
                    key={b.name}
                    onSelect={() => handleCheckoutBranch(b.name)}
                    className="gap-2"
                  >
                    <GitBranch className="size-3 opacity-60" />
                    <span className={cn('truncate', b.isCurrent && 'font-bold text-sky-400')}>
                      {b.name}
                    </span>
                    {b.isCurrent && <Check className="ml-auto size-3" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {workingFolder && (
            <Button
              size="sm"
              variant="default"
              className="h-6 rounded px-2 text-[11px] font-medium shadow-none"
              onClick={() => {
                setCommitDialogOpen(true)
                if (!commitMessage) void handleGenerateCommitMessage()
              }}
            >
              Create Branch & Commit
            </Button>
          )}

          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => void handleRefresh()}
            disabled={isRefreshing || isUndoingAll}
            title={t('action.refresh', { ns: 'common', defaultValue: 'Refresh' })}
          >
            <RefreshCw className={cn('size-3', isRefreshing && 'animate-spin')} />
          </Button>

          {actionable && (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => void handleUndoAll()}
              disabled={isRefreshing || isUndoingAll}
              title={t('action.undo', { ns: 'common' })}
            >
              {isUndoingAll ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <RotateCcw className="size-3" />
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Main Diff Content */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isRefreshing && aggregatedChanges.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin text-emerald-400" />
            {t('thinking.thinkingEllipsis', { ns: 'chat' })}
          </div>
        ) : aggregatedChanges.length === 0 ? (
          <ReviewEmptyState />
        ) : (
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
        )}
      </div>

      {/* Commit & Branch Dialog */}
      <Dialog open={commitDialogOpen} onOpenChange={setCommitDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
              <GitCommit className="size-4 text-emerald-400" />
              Create Commit
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Commit staged or latest agent turn modifications to branch{' '}
              {gitCurrentBranch || 'main'}.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
                <span>Commit message</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 text-[10px] text-primary"
                  onClick={() => void handleGenerateCommitMessage()}
                  disabled={isGeneratingMessage}
                >
                  <Wand2 className={cn('size-3', isGeneratingMessage && 'animate-spin')} />
                  Generate with AI
                </Button>
              </div>
              <Textarea
                placeholder="feat: implement feature..."
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                rows={4}
                className="text-xs"
              />
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCommitDialogOpen(false)}
              disabled={isCommitting}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void handleCommitSubmit()}
              disabled={isCommitting || !commitMessage.trim()}
              className="gap-1.5"
            >
              {isCommitting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <GitCommit className="size-3.5" />
              )}
              Commit Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
