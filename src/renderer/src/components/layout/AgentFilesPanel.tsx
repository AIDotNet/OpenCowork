import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  File,
  FileCode,
  FilePlus2,
  FolderPlus,
  GitBranch,
  GitMerge,
  Loader2,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  Wand2,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { CodeDiffViewer } from '@renderer/components/chat/CodeDiffViewer'
import { FileTreePanel, type AgentFileTreeCommand } from '@renderer/components/cowork/FileTreePanel'
import {
  isLoadedChangeContent,
  loadAggregatedChangeContent,
  useAggregatedChangeSummaries
} from '@renderer/components/chat/change-summary-utils'
import {
  actionableSourceChanges,
  aggregateDisplayableRunFileChanges,
  computeDiff,
  fileName,
  foldContext,
  latestDisplayableRunChangeSet,
  snapshotText,
  type AggregatedFileChange,
  type DiffChunk
} from '@renderer/components/chat/file-change-utils'
import { cn } from '@renderer/lib/utils'
import { generateCommitMessageFromStagedDiff } from '@renderer/lib/git/generate-commit-message'
import type { UnifiedMessage } from '@renderer/lib/api/types'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useGitStore, type GitBranchItem, type GitStatusFile } from '@renderer/stores/git-store'
import { normalizeLanguageCode } from '@renderer/lib/i18n-language'
import {
  useUIStore,
  type AgentFilesChangeSource,
  type AgentFilesSurface,
  type AgentFilesTab
} from '@renderer/stores/ui-store'

export interface AgentFilesPanelProps {
  sessionId?: string | null
  surface: AgentFilesSurface
  initialTab?: AgentFilesTab
}

type GitSection = 'staged' | 'unstaged' | 'untracked' | 'conflicted'

interface GitChangeRow {
  source: 'git'
  key: string
  section: GitSection
  file: GitStatusFile
  filePath: string
  added: number
  deleted: number
}

interface AgentChangeRow {
  source: 'agent'
  key: string
  change: AggregatedFileChange
  filePath: string
  added: number
  deleted: number
}

type ChangeRow = GitChangeRow | AgentChangeRow

const EMPTY_SESSION_MESSAGES: UnifiedMessage[] = []
const EMPTY_DIFF_BY_KEY: Record<string, string> = {}
const MAX_PRELOAD_DIFFS = 160
const DIFF_PRELOAD_BATCH_SIZE = 8

function dirname(input: string): string {
  const normalized = input.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index > 0 ? normalized.slice(0, index) : ''
}

function joinPath(root: string, child: string): string {
  if (!root) return child
  if (/^(?:[a-z]:)?[\\/]/i.test(child)) return child
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${separator}${child}`
}

function repoRelativePath(repoPath: string | null, filePath: string): string | null {
  if (!repoPath) return null
  const normalizedRepo = repoPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedFile = filePath.replace(/\\/g, '/')
  if (normalizedFile === normalizedRepo) return ''
  if (normalizedFile.startsWith(`${normalizedRepo}/`)) {
    return normalizedFile.slice(normalizedRepo.length + 1)
  }
  if (/^(?:[a-z]:)?\//i.test(normalizedFile)) return null
  return normalizedFile
}

function gitDiffKey(row: Pick<GitChangeRow, 'section' | 'filePath'>): string {
  return `${row.section === 'staged' ? 'staged' : 'unstaged'}:${row.filePath}`
}

function statusLetters(file: GitStatusFile, section: GitSection): string {
  if (section === 'untracked') return 'U'
  if (section === 'conflicted') return '!'
  if (section === 'staged') return file.stagedStatus.trim() || 'M'
  return file.unstagedStatus.trim() || 'M'
}

function gitStatusTone(section: GitSection): string {
  if (section === 'untracked') return 'text-agent-files-added'
  if (section === 'conflicted') return 'text-agent-files-conflict'
  return 'text-agent-files-modified'
}

function summarizeUnifiedDiff(diffText: string): { added: number; deleted: number } {
  let added = 0
  let deleted = 0
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added += 1
    if (line.startsWith('-')) deleted += 1
  }
  return { added, deleted }
}

function parseUnifiedDiff(diffText: string): DiffChunk[] {
  const lines: Array<{
    type: 'keep' | 'add' | 'del'
    text: string
    oldNum?: number
    newNum?: number
  }> = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false

  for (const rawLine of diffText.split(/\r?\n/)) {
    if (rawLine.startsWith('@@')) {
      const match = rawLine.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/)
      oldLine = match ? Number(match[1]) : 0
      newLine = match ? Number(match[2]) : 0
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (rawLine.startsWith('+++') || rawLine.startsWith('---')) continue

    if (rawLine.startsWith('+')) {
      lines.push({ type: 'add', text: rawLine.slice(1), newNum: newLine })
      newLine += 1
      continue
    }

    if (rawLine.startsWith('-')) {
      lines.push({ type: 'del', text: rawLine.slice(1), oldNum: oldLine })
      oldLine += 1
      continue
    }

    const text = rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine
    lines.push({ type: 'keep', text, oldNum: oldLine, newNum: newLine })
    oldLine += 1
    newLine += 1
  }

  if (lines.length === 0 && diffText.trim()) {
    return [{ type: 'lines', lines: [{ type: 'keep', text: diffText.trim() }] }]
  }
  return foldContext(lines)
}

function rowOpLabel(row: ChangeRow): string {
  if (row.source === 'git')
    return row.section === 'untracked' ? 'A' : statusLetters(row.file, row.section)
  if (row.change.op === 'create') return 'A'
  if (!row.change.after.exists) return 'D'
  return 'M'
}

function rowOpTone(row: ChangeRow): string {
  if (row.source === 'git') return gitStatusTone(row.section)
  if (row.change.op === 'create') return 'text-agent-files-added'
  if (!row.change.after.exists) return 'text-agent-files-deleted'
  return 'text-agent-files-modified'
}

function branchItemLabel(branch: GitBranchItem): string {
  return branch.isCurrent ? `${branch.name} (HEAD)` : branch.name
}

function AgentFilesEmptyState({
  title,
  description
}: {
  title: string
  description: string
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-xs text-agent-files-muted">
      <FileCode className="size-8 opacity-45" />
      <div className="text-sm font-medium text-agent-files-fg">{title}</div>
      <div className="max-w-64 leading-5">{description}</div>
    </div>
  )
}

function ChangeItemRow({
  row,
  selected,
  onSelect,
  onDiscard,
  onUndo,
  showActions = true
}: {
  row: ChangeRow
  selected: boolean
  onSelect: () => void
  onDiscard?: () => void
  onUndo?: () => void
  showActions?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const directory = dirname(row.filePath)
  const canShowAction = showActions && (row.source === 'agent' ? onUndo : onDiscard)
  return (
    <div
      className={cn(
        'agent-files-change-row group flex h-6 cursor-pointer items-center gap-1 px-2 text-[12px]',
        selected && 'agent-files-change-row--selected'
      )}
      title={row.filePath}
      onClick={onSelect}
    >
      <File className="size-3.5 shrink-0 text-agent-files-icon" />
      <span className="min-w-0 flex-1 truncate">{fileName(row.filePath)}</span>
      {directory ? (
        <span className="max-w-[72px] truncate text-[11px] text-agent-files-muted">
          {directory}
        </span>
      ) : null}
      <span className={cn('w-4 shrink-0 text-center font-mono text-[11px]', rowOpTone(row))}>
        {rowOpLabel(row)}
      </span>
      <span className="shrink-0 font-mono text-[11px] text-agent-files-added">+{row.added}</span>
      <span className="shrink-0 font-mono text-[11px] text-agent-files-deleted">
        -{row.deleted}
      </span>
      {canShowAction ? (
        <button
          type="button"
          className="agent-files-row-action ml-0.5 hidden size-5 items-center justify-center group-hover:inline-flex"
          onClick={(event) => {
            event.stopPropagation()
            row.source === 'agent' ? onUndo?.() : onDiscard?.()
          }}
          title={
            row.source === 'agent'
              ? t('agentFiles.undoAgentChange', { defaultValue: 'Undo agent change' })
              : t('agentFiles.discardFile', { defaultValue: 'Discard file changes' })
          }
        >
          {row.source === 'agent' ? (
            <RotateCcw className="size-3" />
          ) : (
            <Trash2 className="size-3" />
          )}
        </button>
      ) : null}
    </div>
  )
}

function ChangeDiffDialog({
  open,
  rows,
  selectedKey,
  repoPath,
  diffByKey,
  onOpenChange,
  onSelect,
  onLoadGitDiff
}: {
  open: boolean
  rows: ChangeRow[]
  selectedKey: string | null
  repoPath: string | null
  diffByKey: Record<string, string>
  onOpenChange: (open: boolean) => void
  onSelect: (key: string) => void
  onLoadGitDiff: (row: GitChangeRow) => Promise<string>
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const openFilePreview = useUIStore((state) => state.openFilePreview)
  const [fullscreen, setFullscreen] = React.useState(false)
  const [chunks, setChunks] = React.useState<DiffChunk[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const selectedIndex = Math.max(
    0,
    rows.findIndex((row) => row.key === selectedKey)
  )
  const selected = rows[selectedIndex] ?? rows[0] ?? null

  React.useEffect(() => {
    if (!open || !selected) {
      setChunks([])
      setError(null)
      setLoading(false)
      return
    }

    let cancelled = false
    const load = async (): Promise<void> => {
      setLoading(true)
      setError(null)
      try {
        if (selected.source === 'agent') {
          const loaded = await loadAggregatedChangeContent(selected.change)
          if (cancelled) return
          if (!isLoadedChangeContent(loaded)) {
            const beforeText =
              selected.change.op === 'modify' ? snapshotText(selected.change.before) : ''
            const afterText = snapshotText(selected.change.after)
            setChunks(foldContext(computeDiff(beforeText, afterText)))
            return
          }
          setChunks(foldContext(computeDiff(loaded.beforeText, loaded.afterText)))
          return
        }

        if (selected.section === 'untracked') {
          setChunks([
            {
              type: 'lines',
              lines: [
                {
                  type: 'keep',
                  text: t('agentFiles.untrackedNoDiff', {
                    defaultValue: 'Untracked files do not have a diff until they are staged.'
                  })
                }
              ]
            }
          ])
          return
        }

        const diffText = diffByKey[gitDiffKey(selected)] ?? (await onLoadGitDiff(selected))
        if (cancelled) return
        setChunks(parseUnifiedDiff(diffText))
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [diffByKey, onLoadGitDiff, open, selected, t])

  const go = (delta: number): void => {
    if (rows.length === 0) return
    const next = rows[(selectedIndex + delta + rows.length) % rows.length]
    if (next) onSelect(next.key)
  }

  const resolvedFilePath =
    selected?.source === 'git' && repoPath
      ? joinPath(repoPath, selected.filePath)
      : selected?.filePath

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'agent-files-diff-dialog grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0',
          fullscreen
            ? 'h-[92vh] w-[96vw] max-w-[96vw] sm:max-w-[96vw]'
            : 'h-[72vh] w-[92vw] max-w-[1100px] sm:max-w-[1100px]'
        )}
      >
        <div className="flex h-9 items-center gap-2 border-b border-agent-files-border bg-agent-files-panel px-2">
          <FileCode className="size-4 shrink-0 text-agent-files-icon" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-agent-files-fg">
            {selected?.filePath ?? t('agentFiles.diff', { defaultValue: 'Diff' })}
          </span>
          <span className="rounded bg-agent-files-hover px-1.5 py-0.5 text-[11px] text-agent-files-muted">
            {rows.length > 0 ? `${selectedIndex + 1} of ${rows.length}` : '0'}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            className="agent-files-icon-button"
            onClick={() => go(-1)}
          >
            <ChevronLeft className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="agent-files-icon-button"
            onClick={() => go(1)}
          >
            <ChevronRight className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="agent-files-icon-button"
            disabled={!resolvedFilePath}
            onClick={() => resolvedFilePath && openFilePreview(resolvedFilePath)}
            title={t('agentFiles.openFile', { defaultValue: 'Open file' })}
          >
            <ExternalLink className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="agent-files-icon-button"
            onClick={() => setFullscreen((value) => !value)}
          >
            {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="agent-files-icon-button"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-3.5" />
          </Button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)] bg-agent-files-panel">
          <div className="min-h-0 overflow-y-auto border-r border-agent-files-border py-1">
            <div className="px-3 py-1 text-[11px] font-semibold text-agent-files-muted">
              {t('agentFiles.changes', { defaultValue: 'Changes' })}
            </div>
            {rows.map((row) => (
              <ChangeItemRow
                key={row.key}
                row={row}
                selected={row.key === selected?.key}
                onSelect={() => onSelect(row.key)}
                showActions={false}
              />
            ))}
          </div>
          <div className="flex min-h-0 flex-col overflow-hidden p-3">
            {loading ? (
              <div className="flex h-full items-center justify-center text-sm text-agent-files-muted">
                <Loader2 className="mr-2 size-4 animate-spin" />
                {t('agentFiles.loadingDiff', { defaultValue: 'Loading diff...' })}
              </div>
            ) : error ? (
              <div className="rounded border border-destructive/40 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            ) : chunks.length === 0 ? (
              <AgentFilesEmptyState
                title={t('agentFiles.noDiff', { defaultValue: 'No diff available' })}
                description={t('agentFiles.noDiffDesc', {
                  defaultValue: 'This file has no renderable text diff.'
                })}
              />
            ) : (
              <CodeDiffViewer
                chunks={chunks}
                defaultMode="inline"
                showModeToggle
                toolbarEnd={null}
                fillHeight
              />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function AgentFilesPanel({
  sessionId = null,
  surface,
  initialTab = 'files'
}: AgentFilesPanelProps): React.JSX.Element {
  const { t, i18n } = useTranslation('layout')
  const activeTab = useUIStore((state) => state.agentFilesActiveTabBySurface[surface] ?? initialTab)
  const setActiveTab = useUIStore((state) => state.setAgentFilesActiveTab)
  const selectedChangeKey = useUIStore((state) => state.agentFilesSelectedChangeKey)
  const setSelectedChangeKey = useUIStore((state) => state.setAgentFilesSelectedChangeKey)
  const changeSource = useUIStore((state) => state.agentFilesChangeSource)
  const setChangeSource = useUIStore((state) => state.setAgentFilesChangeSource)
  const sessionView = useChatStore(
    useShallow((state) => {
      const resolvedSessionId = sessionId ?? state.activeSessionId
      const currentSession = resolvedSessionId
        ? state.sessions.find((item) => item.id === resolvedSessionId)
        : undefined
      const currentProject = currentSession?.projectId
        ? state.projects.find((item) => item.id === currentSession.projectId)
        : undefined

      return {
        sessionId: resolvedSessionId,
        projectId: currentSession?.projectId ?? currentProject?.id ?? null,
        workingFolder: currentSession?.workingFolder ?? currentProject?.workingFolder ?? null,
        sshConnectionId: currentSession?.sshConnectionId ?? currentProject?.sshConnectionId ?? null,
        messages: currentSession?.messages ?? EMPTY_SESSION_MESSAGES
      }
    })
  )
  const { runChangesByRunId, refreshSessionRunChanges, undoFileChange, undoRunChanges } =
    useAgentStore(
      useShallow((state) => ({
        runChangesByRunId: state.runChangesByRunId,
        refreshSessionRunChanges: state.refreshSessionRunChanges,
        undoFileChange: state.undoFileChange,
        undoRunChanges: state.undoRunChanges
      }))
    )
  const git = useGitStore(
    useShallow((state) => ({
      repositories: state.repositories,
      selectedRepoPath: state.selectedRepoPath,
      repoDetailsByPath: state.repoDetailsByPath,
      isScanning: state.isScanning,
      scanError: state.scanError,
      scanRepositories: state.scanRepositories,
      selectRepository: state.selectRepository,
      refreshRepository: state.refreshRepository,
      loadFileDiff: state.loadFileDiff,
      fetchRepository: state.fetchRepository,
      pullRebase: state.pullRebase,
      checkoutBranch: state.checkoutBranch,
      mergeBranch: state.mergeBranch,
      stageAll: state.stageAll,
      stageFiles: state.stageFiles,
      unstageAll: state.unstageAll,
      discardFiles: state.discardFiles,
      commit: state.commit,
      getStagedDiffBundle: state.getStagedDiffBundle
    }))
  )
  const [diffOpen, setDiffOpen] = React.useState(false)
  const [commitOpen, setCommitOpen] = React.useState(false)
  const [commitMessage, setCommitMessage] = React.useState('')
  const [aiCommitLoading, setAiCommitLoading] = React.useState(false)
  const [branchDialog, setBranchDialog] = React.useState<'checkout' | 'merge' | null>(null)
  const [branchValue, setBranchValue] = React.useState('')
  const [busyAction, setBusyAction] = React.useState<string | null>(null)
  const [fileSearchOpen, setFileSearchOpen] = React.useState(false)
  const [fileTreeCommand, setFileTreeCommand] = React.useState<AgentFileTreeCommand | null>(null)
  const requestedRefreshRef = React.useRef<string | null>(null)
  const preloadingDiffKeysRef = React.useRef(new Set<string>())
  const selectedRepoPath = git.selectedRepoPath
  const scanRepositories = git.scanRepositories
  const loadFileDiff = git.loadFileDiff
  const stageAll = git.stageAll
  const stageFiles = git.stageFiles
  const getStagedDiffBundle = git.getStagedDiffBundle

  React.useEffect(() => {
    if (!sessionView.sessionId) return
    if (requestedRefreshRef.current === sessionView.sessionId) return
    requestedRefreshRef.current = sessionView.sessionId
    void refreshSessionRunChanges(sessionView.sessionId)
  }, [refreshSessionRunChanges, sessionView.sessionId])

  React.useEffect(() => {
    if (!sessionView.workingFolder) return
    void scanRepositories()
  }, [scanRepositories, sessionView.projectId, sessionView.workingFolder])

  const assistantMessageIds = React.useMemo(() => {
    const ids = new Set<string>()
    for (const message of sessionView.messages) {
      if (message.role === 'assistant') ids.add(message.id)
    }
    return ids
  }, [sessionView.messages])

  const sessionChangeSets = React.useMemo(() => {
    const seen = new Set<string>()
    return Object.values(runChangesByRunId)
      .filter((changeSet) => {
        if (!sessionView.sessionId) return false
        if (changeSet.sessionId === sessionView.sessionId) return true
        if (changeSet.changes.some((change) => change.sessionId === sessionView.sessionId))
          return true
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
  }, [assistantMessageIds, runChangesByRunId, sessionView.sessionId])

  const latestChangeSet = React.useMemo(
    () => latestDisplayableRunChangeSet(sessionChangeSets),
    [sessionChangeSets]
  )
  const agentChanges = React.useMemo(
    () =>
      aggregateDisplayableRunFileChanges(latestChangeSet?.changes ?? []).sort(
        (left, right) => left.createdAt - right.createdAt
      ),
    [latestChangeSet]
  )
  const agentSummaries = useAggregatedChangeSummaries(agentChanges)

  const selectedRepo = React.useMemo(
    () => git.repositories.find((repo) => repo.fullPath === selectedRepoPath) ?? null,
    [git.repositories, selectedRepoPath]
  )
  const repoDetails = selectedRepoPath ? git.repoDetailsByPath[selectedRepoPath] : null
  const status = repoDetails?.status ?? null
  const diffByKey = repoDetails?.diffByKey ?? EMPTY_DIFF_BY_KEY

  const gitRowsBase = React.useMemo(() => {
    const rows: Array<Omit<GitChangeRow, 'added' | 'deleted'>> = []
    for (const file of status?.conflicted ?? []) {
      rows.push({
        source: 'git',
        key: `git:conflicted:${file.path}`,
        section: 'conflicted',
        file,
        filePath: file.path
      })
    }
    for (const file of status?.staged ?? []) {
      rows.push({
        source: 'git',
        key: `git:staged:${file.path}`,
        section: 'staged',
        file,
        filePath: file.path
      })
    }
    for (const file of status?.unstaged ?? []) {
      rows.push({
        source: 'git',
        key: `git:unstaged:${file.path}`,
        section: 'unstaged',
        file,
        filePath: file.path
      })
    }
    for (const file of status?.untracked ?? []) {
      rows.push({
        source: 'git',
        key: `git:untracked:${file.path}`,
        section: 'untracked',
        file,
        filePath: file.path
      })
    }
    return rows
  }, [status])

  React.useEffect(() => {
    if (!selectedRepoPath || gitRowsBase.length === 0) return
    const cachedDiffs =
      useGitStore.getState().repoDetailsByPath[selectedRepoPath]?.diffByKey ?? EMPTY_DIFF_BY_KEY
    const preloadingDiffKeys = preloadingDiffKeysRef.current
    const missing = gitRowsBase.filter((row) => {
      if (row.section === 'untracked') return false
      const key = gitDiffKey(row)
      return cachedDiffs[key] === undefined && !preloadingDiffKeys.has(`${selectedRepoPath}:${key}`)
    })
    if (missing.length === 0) return
    const rowsToLoad = missing.slice(0, MAX_PRELOAD_DIFFS)
    for (const row of rowsToLoad) {
      preloadingDiffKeys.add(`${selectedRepoPath}:${gitDiffKey(row)}`)
    }
    const preload = async (): Promise<void> => {
      for (let index = 0; index < rowsToLoad.length; index += DIFF_PRELOAD_BATCH_SIZE) {
        await Promise.all(
          rowsToLoad.slice(index, index + DIFF_PRELOAD_BATCH_SIZE).map(async (row) => {
            const key = `${selectedRepoPath}:${gitDiffKey(row)}`
            try {
              await loadFileDiff(selectedRepoPath, row.filePath, row.section === 'staged')
            } finally {
              preloadingDiffKeysRef.current.delete(key)
            }
          })
        )
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
      }
    }
    void preload()
  }, [gitRowsBase, loadFileDiff, selectedRepoPath])

  const gitRows: GitChangeRow[] = React.useMemo(
    () =>
      gitRowsBase.map((row) => {
        const stats =
          row.section === 'untracked'
            ? { added: 0, deleted: 0 }
            : summarizeUnifiedDiff(diffByKey[gitDiffKey(row)] ?? '')
        return { ...row, ...stats }
      }),
    [diffByKey, gitRowsBase]
  )

  const agentRows: AgentChangeRow[] = React.useMemo(
    () =>
      agentChanges.map((change) => {
        const summary = agentSummaries[change.id] ?? { added: 0, deleted: 0 }
        return {
          source: 'agent',
          key: `agent:${change.id}`,
          change,
          filePath: change.filePath,
          added: summary.added,
          deleted: summary.deleted
        }
      }),
    [agentChanges, agentSummaries]
  )

  const allRows = React.useMemo<ChangeRow[]>(() => [...agentRows, ...gitRows], [agentRows, gitRows])
  const visibleRows = React.useMemo(() => {
    if (changeSource === 'agent') return agentRows
    if (changeSource === 'git') return gitRows
    return allRows
  }, [agentRows, allRows, changeSource, gitRows])
  const selectedRow =
    visibleRows.find((row) => row.key === selectedChangeKey) ?? visibleRows[0] ?? null
  const visibleGitRows = React.useMemo(
    () => visibleRows.filter((row): row is GitChangeRow => row.source === 'git'),
    [visibleRows]
  )
  const visibleStagePaths = React.useMemo(
    () =>
      Array.from(
        new Set(
          visibleRows
            .map((row) =>
              row.source === 'git' ? row.filePath : repoRelativePath(selectedRepoPath, row.filePath)
            )
            .filter((path): path is string => Boolean(path))
        )
      ),
    [selectedRepoPath, visibleRows]
  )
  const totals = React.useMemo(
    () =>
      visibleRows.reduce(
        (acc, row) => {
          acc.added += row.added
          acc.deleted += row.deleted
          return acc
        },
        { added: 0, deleted: 0 }
      ),
    [visibleRows]
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

  const runGitAction = async (
    key: string,
    action: () => Promise<{ success: boolean; error?: string }>
  ): Promise<boolean> => {
    if (busyAction) return false
    setBusyAction(key)
    try {
      const result = await action()
      if (!result.success) {
        toast.error(result.error ?? t('agentFiles.actionFailed', { defaultValue: 'Action failed' }))
        return false
      }
      toast.success(t('agentFiles.actionComplete', { defaultValue: 'Action complete' }))
      return true
    } finally {
      setBusyAction(null)
    }
  }

  const loadGitDiff = React.useCallback(
    async (row: GitChangeRow): Promise<string> => {
      if (!selectedRepoPath) return ''
      await loadFileDiff(selectedRepoPath, row.filePath, row.section === 'staged')
      return (
        useGitStore.getState().repoDetailsByPath[selectedRepoPath]?.diffByKey[gitDiffKey(row)] ?? ''
      )
    },
    [loadFileDiff, selectedRepoPath]
  )

  const discardGitRows = async (rows: GitChangeRow[]): Promise<void> => {
    if (!git.selectedRepoPath || rows.length === 0) return
    const confirmed = await confirm({
      title: t('agentFiles.discardConfirmTitle', { defaultValue: 'Discard changes?' }),
      description: t('agentFiles.discardConfirmDesc', {
        count: rows.length,
        defaultValue: 'Discard {{count}} file change(s)? This cannot be undone.'
      }),
      confirmLabel: t('agentFiles.discard', { defaultValue: 'Discard' }),
      variant: 'destructive'
    })
    if (!confirmed) return

    const grouped: Record<'worktree' | 'full' | 'untracked', string[]> = {
      worktree: [],
      full: [],
      untracked: []
    }
    for (const row of rows) {
      if (row.section === 'untracked') grouped.untracked.push(row.filePath)
      else if (row.section === 'staged') grouped.full.push(row.filePath)
      else grouped.worktree.push(row.filePath)
    }

    await runGitAction('discard', async () => {
      for (const [scope, paths] of Object.entries(grouped) as Array<
        ['worktree' | 'full' | 'untracked', string[]]
      >) {
        if (paths.length === 0) continue
        const result = await git.discardFiles(git.selectedRepoPath!, paths, scope)
        if (!result.success) return result
      }
      return { success: true }
    })
  }

  const undoAgentRow = async (row: AgentChangeRow): Promise<void> => {
    const actionable = actionableSourceChanges(row.change)
    if (actionable.length === 0) return
    for (const entry of [...actionable].sort((a, b) => b.createdAt - a.createdAt)) {
      await undoFileChange(entry.runId, entry.id)
    }
  }

  const stageVisibleChangesForCommit = React.useCallback(async (): Promise<{
    success: boolean
    error?: string
  }> => {
    if (!selectedRepoPath) {
      return {
        success: false,
        error: t('agentFiles.noRepoSelected', { defaultValue: 'No repository selected' })
      }
    }
    if (visibleRows.length === 0) {
      return {
        success: false,
        error: t('agentFiles.noChangesToCommit', { defaultValue: 'No changes to commit' })
      }
    }
    return visibleStagePaths.length > 0
      ? stageFiles(selectedRepoPath, visibleStagePaths)
      : stageAll(selectedRepoPath)
  }, [selectedRepoPath, stageAll, stageFiles, t, visibleRows.length, visibleStagePaths])

  const handleCommit = async (): Promise<void> => {
    if (!selectedRepoPath || !commitMessage.trim()) return
    const committed = await runGitAction('commit', async () => {
      const stageResult = await stageVisibleChangesForCommit()
      if (!stageResult.success) return stageResult
      return git.commit(selectedRepoPath, commitMessage.trim())
    })
    if (!committed) return
    setCommitOpen(false)
    setCommitMessage('')
  }

  const handleGenerateCommitMessage = async (): Promise<void> => {
    if (!selectedRepoPath || busyAction !== null || aiCommitLoading) return
    setAiCommitLoading(true)
    try {
      const stageResult = await stageVisibleChangesForCommit()
      if (!stageResult.success) {
        toast.error(
          stageResult.error ?? t('agentFiles.actionFailed', { defaultValue: 'Action failed' })
        )
        return
      }

      const bundle = await getStagedDiffBundle(selectedRepoPath)
      if (!bundle.success) {
        toast.error(bundle.error)
        return
      }
      if (bundle.empty) {
        toast.error(
          t('agentFiles.aiCommitEmptyStaged', {
            defaultValue: 'Nothing staged — cannot generate a message'
          })
        )
        return
      }

      const message = await generateCommitMessageFromStagedDiff(
        bundle.stat,
        bundle.patch,
        normalizeLanguageCode(i18n.language),
        status?.branch,
        undefined
      )
      if (!message) {
        toast.error(
          t('agentFiles.aiCommitFailed', {
            defaultValue: 'Generation failed. Check API / model settings and try again'
          })
        )
        return
      }
      setCommitMessage(message)
      toast.success(t('agentFiles.aiCommitGenerated', { defaultValue: 'Commit message generated' }))
    } finally {
      setAiCommitLoading(false)
    }
  }

  const handleBranchAction = async (): Promise<void> => {
    if (!git.selectedRepoPath || !branchDialog || !branchValue) return
    const mode = branchDialog
    await runGitAction(mode, () =>
      mode === 'checkout'
        ? git.checkoutBranch(git.selectedRepoPath!, branchValue)
        : git.mergeBranch(git.selectedRepoPath!, branchValue)
    )
    setBranchDialog(null)
    setBranchValue('')
  }

  const openSelectedDiff = (row: ChangeRow): void => {
    setSelectedChangeKey(row.key)
    setDiffOpen(true)
  }

  const sendFileTreeCommand = (type: AgentFileTreeCommand['type']): void => {
    setFileTreeCommand({ id: Date.now(), type })
  }

  const branchOptions = React.useMemo(
    () =>
      (repoDetails?.branches ?? []).filter(
        (branch) => branchDialog !== 'merge' || !branch.isCurrent
      ),
    [branchDialog, repoDetails?.branches]
  )
  const canUseCommitComposer = Boolean(
    selectedRepoPath && visibleRows.length > 0 && busyAction === null && !aiCommitLoading
  )
  const canCommitInline = canUseCommitComposer && commitMessage.trim().length > 0

  return (
    <div className="agent-files-panel flex h-full min-h-0 flex-col">
      <div className="agent-files-titlebar flex h-[34px] shrink-0 items-center justify-between border-b border-agent-files-border bg-agent-files-panel pl-2 pr-1">
        <div className="flex h-full min-w-0 items-center">
          {(['changes', 'files'] as AgentFilesTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              className={cn('agent-files-tab', activeTab === tab && 'agent-files-tab--active')}
              onClick={() => setActiveTab(surface, tab)}
            >
              {tab === 'changes'
                ? t('agentFiles.changes', { defaultValue: 'Changes' })
                : t('agentFiles.files', { defaultValue: 'Files' })}
            </button>
          ))}
        </div>
        <div className="agent-files-titlebar-actions flex shrink-0 items-center gap-0.5">
          {activeTab === 'files' ? (
            <>
              <Button
                variant="ghost"
                size="icon-xs"
                className={cn(
                  'agent-files-icon-button',
                  fileSearchOpen && 'agent-files-icon-button--active'
                )}
                onClick={() => setFileSearchOpen((value) => !value)}
                title={t('agentFiles.searchFiles', { defaultValue: 'Search files' })}
              >
                <Search className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="agent-files-icon-button"
                onClick={() => sendFileTreeCommand('collapse-all')}
                title={t('agentFiles.collapseAll', { defaultValue: 'Collapse all' })}
              >
                <ChevronDown className="size-3.5" />
              </Button>
            </>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" className="agent-files-icon-button">
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {activeTab === 'files' ? (
                <>
                  <DropdownMenuItem onSelect={() => sendFileTreeCommand('new-file')}>
                    <FilePlus2 className="size-4" />
                    {t('agentFiles.newFile', { defaultValue: 'New File' })}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => sendFileTreeCommand('new-folder')}>
                    <FolderPlus className="size-4" />
                    {t('agentFiles.newFolder', { defaultValue: 'New Folder' })}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => sendFileTreeCommand('refresh')}>
                    <RefreshCw className="size-4" />
                    {t('agentFiles.refresh', { defaultValue: 'Refresh' })}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => sendFileTreeCommand('collapse-all')}>
                    <ChevronDown className="size-4" />
                    {t('agentFiles.collapseAll', { defaultValue: 'Collapse all' })}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={!git.selectedRepoPath || busyAction !== null}
                    onSelect={() =>
                      void runGitAction('pull', () => git.pullRebase(git.selectedRepoPath!))
                    }
                  >
                    <GitMerge className="size-4" />
                    {t('agentFiles.pullUpstream', { defaultValue: 'Pull upstream' })}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!git.selectedRepoPath || busyAction !== null}
                    onSelect={() =>
                      void runGitAction('fetch', () => git.fetchRepository(git.selectedRepoPath!))
                    }
                  >
                    <RefreshCw className="size-4" />
                    {t('agentFiles.fetch', { defaultValue: 'Fetch' })}
                  </DropdownMenuItem>
                </>
              ) : (
                <>
                  <DropdownMenuItem
                    onSelect={() => {
                      if (git.selectedRepoPath) void git.refreshRepository(git.selectedRepoPath)
                      if (sessionView.sessionId)
                        void refreshSessionRunChanges(sessionView.sessionId)
                    }}
                  >
                    <RefreshCw className="size-4" />
                    {t('agentFiles.refresh', { defaultValue: 'Refresh' })}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setCommitOpen(true)}>
                    <Check className="size-4" />
                    {t('agentFiles.commitChanges', { defaultValue: 'Commit Changes' })}
                  </DropdownMenuItem>
                </>
              )}
              {activeTab === 'files' && git.repositories.length > 0 ? (
                <>
                  <DropdownMenuSeparator />
                  {git.repositories.map((repo) => (
                    <DropdownMenuItem
                      key={repo.fullPath}
                      onSelect={() => git.selectRepository(repo.fullPath)}
                    >
                      <GitBranch className="size-4" />
                      <span className="truncate">
                        {repo.relativePath === '.' ? repo.name : repo.relativePath}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {activeTab === 'changes' ? (
        <>
          <div className="shrink-0 border-b border-agent-files-border bg-agent-files-panel px-2 pb-2 pt-1">
            <div className="relative">
              <Textarea
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault()
                    if (canCommitInline) void handleCommit()
                  }
                }}
                placeholder={t('agentFiles.commitPlaceholder', {
                  defaultValue: 'Commit message'
                })}
                disabled={busyAction !== null || aiCommitLoading}
                className="min-h-[54px] resize-none rounded-[2px] border-agent-files-border bg-agent-files-panel px-2 py-1.5 pr-9 text-xs shadow-none focus-visible:ring-1"
                rows={2}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="agent-files-icon-button absolute right-1 top-1 size-6"
                disabled={!canUseCommitComposer}
                onClick={() => void handleGenerateCommitMessage()}
                title={t('agentFiles.generateCommitMessage', {
                  defaultValue: 'Generate commit message'
                })}
              >
                {aiCommitLoading ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Wand2 className="size-3.5" />
                )}
              </Button>
            </div>
            <div className="mt-1 flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                className="agent-files-primary-button h-6 min-w-0 flex-1 px-2 text-xs"
                disabled={!canCommitInline}
                onClick={() => void handleCommit()}
              >
                {busyAction === 'commit' ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <GitMerge className="size-3.5" />
                )}
                {t('agentFiles.commitChanges', { defaultValue: 'Commit Changes' })}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="icon-sm"
                    className="agent-files-primary-button h-6 w-6"
                    disabled={!git.selectedRepoPath || busyAction !== null}
                  >
                    <ChevronDown className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem onSelect={() => setCommitOpen(true)}>
                    <Check className="size-4" />
                    {t('agentFiles.commitChanges', { defaultValue: 'Commit Changes' })}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      void runGitAction('stage', () => git.stageAll(git.selectedRepoPath!))
                    }
                  >
                    <FileCode className="size-4" />
                    {t('agentFiles.stageAll', { defaultValue: 'Stage All' })}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      void runGitAction('unstage', () => git.unstageAll(git.selectedRepoPath!))
                    }
                  >
                    <RotateCcw className="size-4" />
                    {t('agentFiles.unstageAll', { defaultValue: 'Unstage All' })}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setBranchDialog('merge')}>
                    <GitMerge className="size-4" />
                    {t('agentFiles.mergeBranch', { defaultValue: 'Merge Branch...' })}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setBranchDialog('checkout')}>
                    <GitBranch className="size-4" />
                    {t('agentFiles.checkoutBranch', { defaultValue: 'Checkout Branch...' })}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() =>
                      void discardGitRows(visibleGitRows.length > 0 ? visibleGitRows : gitRows)
                    }
                  >
                    <Trash2 className="size-4" />
                    {t('agentFiles.discardChanges', { defaultValue: 'Discard Changes' })}
                  </DropdownMenuItem>
                  {undoableRunIds.length > 0 ? (
                    <DropdownMenuItem
                      onSelect={() => {
                        for (const runId of undoableRunIds) void undoRunChanges(runId)
                      }}
                    >
                      <RotateCcw className="size-4" />
                      {t('agentFiles.undoAgentChanges', { defaultValue: 'Undo Agent Changes' })}
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => {
                      if (git.selectedRepoPath) void git.refreshRepository(git.selectedRepoPath)
                    }}
                  >
                    <RefreshCw className="size-4" />
                    {t('agentFiles.refresh', { defaultValue: 'Refresh' })}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="mt-2 flex h-[22px] items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="agent-files-branch-filter flex min-w-0 items-center gap-1">
                    <span className="truncate">
                      {changeSource === 'all'
                        ? t('agentFiles.branchChanges', { defaultValue: 'Branch Changes' })
                        : changeSource === 'agent'
                          ? t('agentFiles.agentChanges', { defaultValue: 'Agent Changes' })
                          : t('agentFiles.gitChanges', { defaultValue: 'Git Changes' })}
                    </span>
                    <ChevronDown className="size-3" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-44">
                  {(['all', 'agent', 'git'] as AgentFilesChangeSource[]).map((source) => (
                    <DropdownMenuItem key={source} onSelect={() => setChangeSource(source)}>
                      {source === 'all'
                        ? t('agentFiles.branchChanges', { defaultValue: 'Branch Changes' })
                        : source === 'agent'
                          ? t('agentFiles.agentChanges', { defaultValue: 'Agent Changes' })
                          : t('agentFiles.gitChanges', { defaultValue: 'Git Changes' })}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <span className="agent-files-count-badge ml-auto">{visibleRows.length}</span>
              <span className="font-mono text-[11px] leading-none text-agent-files-added">
                +{totals.added}
              </span>
              <span className="font-mono text-[11px] text-agent-files-deleted">
                -{totals.deleted}
              </span>
            </div>
            {selectedRepo ? (
              <div className="mt-1 truncate text-[11px] text-agent-files-muted">
                {status?.branch ?? selectedRepo.branch}
                {status?.upstream ? ` · ${status.upstream}` : ''}
              </div>
            ) : git.scanError ? (
              <div className="mt-1 truncate text-[11px] text-destructive">{git.scanError}</div>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto bg-agent-files-panel py-1">
            {git.isScanning && visibleRows.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-agent-files-muted">
                <Loader2 className="mr-2 size-4 animate-spin" />
                {t('agentFiles.scanning', { defaultValue: 'Scanning changes...' })}
              </div>
            ) : visibleRows.length === 0 ? (
              <AgentFilesEmptyState
                title={t('agentFiles.noChanges', { defaultValue: 'No changes' })}
                description={t('agentFiles.noChangesDesc', {
                  defaultValue: 'Agent edits and Git changes for this workspace will appear here.'
                })}
              />
            ) : (
              visibleRows.map((row) => (
                <ChangeItemRow
                  key={row.key}
                  row={row}
                  selected={row.key === selectedRow?.key}
                  onSelect={() => openSelectedDiff(row)}
                  onDiscard={() => row.source === 'git' && void discardGitRows([row])}
                  onUndo={() => row.source === 'agent' && void undoAgentRow(row)}
                />
              ))
            )}
          </div>
        </>
      ) : (
        <>
          <div className="min-h-0 flex-1 bg-agent-files-panel">
            {sessionView.workingFolder ? (
              <FileTreePanel
                sessionId={sessionView.sessionId}
                surface="agent"
                agentSearchOpen={fileSearchOpen}
                agentCommand={fileTreeCommand}
              />
            ) : (
              <AgentFilesEmptyState
                title={t('agentFiles.noFolder', { defaultValue: 'No working folder' })}
                description={t('agentFiles.noFolderDesc', {
                  defaultValue: 'Select a working folder to browse files.'
                })}
              />
            )}
          </div>
        </>
      )}

      <ChangeDiffDialog
        open={diffOpen}
        rows={visibleRows}
        selectedKey={selectedRow?.key ?? null}
        repoPath={git.selectedRepoPath}
        diffByKey={diffByKey}
        onOpenChange={setDiffOpen}
        onSelect={(key) => setSelectedChangeKey(key)}
        onLoadGitDiff={loadGitDiff}
      />

      <Dialog open={commitOpen} onOpenChange={setCommitOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('agentFiles.commitChanges', { defaultValue: 'Commit Changes' })}
            </DialogTitle>
            <DialogDescription>
              {t('agentFiles.commitDesc', {
                defaultValue:
                  'Stage the current changes and commit them to the selected repository.'
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <div className="relative">
              <Textarea
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                placeholder={t('agentFiles.commitPlaceholder', {
                  defaultValue: 'Commit message'
                })}
                disabled={busyAction !== null || aiCommitLoading}
                className="min-h-[112px] resize-y pr-11 font-mono text-xs"
                rows={5}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-1.5 top-1.5 size-8"
                disabled={
                  !selectedRepoPath ||
                  visibleRows.length === 0 ||
                  busyAction !== null ||
                  aiCommitLoading
                }
                onClick={() => void handleGenerateCommitMessage()}
                title={t('agentFiles.generateCommitMessage', {
                  defaultValue: 'Generate commit message'
                })}
              >
                {aiCommitLoading ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Wand2 className="size-3.5" />
                )}
              </Button>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-agent-files-muted">
              <span>
                {t('agentFiles.commitScope', {
                  count: visibleRows.length,
                  defaultValue: '{{count}} change(s) will be staged'
                })}
              </span>
              <span className="font-mono text-agent-files-added">+{totals.added}</span>
              <span className="font-mono text-agent-files-deleted">-{totals.deleted}</span>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busyAction !== null || aiCommitLoading}
              onClick={() => setCommitOpen(false)}
            >
              {t('agentFiles.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button
              variant="outline"
              disabled={
                !selectedRepoPath ||
                visibleRows.length === 0 ||
                busyAction !== null ||
                aiCommitLoading
              }
              onClick={() => void handleGenerateCommitMessage()}
            >
              {aiCommitLoading ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('agentFiles.generate', { defaultValue: 'Generate' })}
            </Button>
            <Button
              disabled={!commitMessage.trim() || busyAction !== null || aiCommitLoading}
              onClick={() => void handleCommit()}
            >
              {busyAction === 'commit' ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('agentFiles.commit', { defaultValue: 'Commit' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={branchDialog !== null} onOpenChange={(open) => !open && setBranchDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {branchDialog === 'merge'
                ? t('agentFiles.mergeBranch', { defaultValue: 'Merge Branch...' })
                : t('agentFiles.checkoutBranch', { defaultValue: 'Checkout Branch...' })}
            </DialogTitle>
            <DialogDescription>
              {t('agentFiles.branchActionDesc', {
                defaultValue: 'Choose a branch from the selected repository.'
              })}
            </DialogDescription>
          </DialogHeader>
          <Select value={branchValue} onValueChange={setBranchValue}>
            <SelectTrigger>
              <SelectValue
                placeholder={t('agentFiles.selectBranch', { defaultValue: 'Select branch' })}
              />
            </SelectTrigger>
            <SelectContent>
              {branchOptions.map((branch) => (
                <SelectItem key={branch.fullName} value={branch.name}>
                  {branchItemLabel(branch)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBranchDialog(null)}>
              {t('agentFiles.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button
              disabled={!branchValue || busyAction !== null}
              onClick={() => void handleBranchAction()}
            >
              {busyAction === branchDialog ? <Loader2 className="size-4 animate-spin" /> : null}
              {branchDialog === 'merge'
                ? t('agentFiles.merge', { defaultValue: 'Merge' })
                : t('agentFiles.checkout', { defaultValue: 'Checkout' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
