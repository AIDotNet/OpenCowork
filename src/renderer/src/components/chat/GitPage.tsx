import * as React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  ChevronRight,
  CloudDownload,
  CloudUpload,
  EllipsisVertical,
  File,
  FilePlus,
  GitBranch,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Upload,
  Wand2
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Textarea } from '@renderer/components/ui/textarea'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@renderer/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@renderer/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { cn } from '@renderer/lib/utils'
import {
  useGitStore,
  type GitBranchItem,
  type GitCommitHistoryItem,
  type GitStatusFile
} from '@renderer/stores/git-store'
import { useGitPanelSplit } from '@renderer/hooks/use-git-panel-split'
import { generateCommitMessageFromStagedDiff } from '@renderer/lib/git/generate-commit-message'
import { useChatStore } from '@renderer/stores/chat-store'

type ScmFileSection = 'staged' | 'unstaged' | 'untracked' | 'conflicted'

interface ScmFileRow {
  path: string
  section: ScmFileSection
  file: GitStatusFile
}

function parseRemoteBranchName(shortName: string): { remote: string; branchName: string } | null {
  const i = shortName.indexOf('/')
  if (i <= 0) return null
  return { remote: shortName.slice(0, i), branchName: shortName.slice(i + 1) }
}

function scmFileKey(row: Pick<ScmFileRow, 'section' | 'path'>): string {
  return `${row.section}:${row.path}`
}

function statusLetters(file: GitStatusFile, section: ScmFileSection): string {
  if (section === 'untracked') return 'U'
  if (section === 'conflicted') return '!'
  if (section === 'staged') return file.stagedStatus.trim() || '·'
  return file.unstagedStatus.trim() || '·'
}

function parseDiffBlocks(diffText: string): Array<{
  header: string
  lines: Array<{
    type: 'add' | 'remove' | 'meta' | 'context'
    left: string
    right: string
    content: string
  }>
}> {
  const sections: Array<{
    header: string
    lines: Array<{
      type: 'add' | 'remove' | 'meta' | 'context'
      left: string
      right: string
      content: string
    }>
  }> = []
  const rawLines = diffText.split(/\r?\n/)
  let current = {
    header: 'diff',
    lines: [] as Array<{
      type: 'add' | 'remove' | 'meta' | 'context'
      left: string
      right: string
      content: string
    }>
  }
  let leftLine = 0
  let rightLine = 0

  const pushCurrent = (): void => {
    if (current.lines.length > 0) sections.push(current)
  }

  for (const line of rawLines) {
    if (line.startsWith('@@')) {
      pushCurrent()
      current = { header: line, lines: [] }
      const match = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/)
      leftLine = match ? Number(match[1]) : 0
      rightLine = match ? Number(match[2]) : 0
      current.lines.push({ type: 'meta', left: '', right: '', content: line })
      continue
    }

    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('Binary files')
    ) {
      current.lines.push({ type: 'meta', left: '', right: '', content: line })
      continue
    }

    if (line.startsWith('+')) {
      current.lines.push({ type: 'add', left: '', right: String(rightLine), content: line })
      rightLine += 1
      continue
    }

    if (line.startsWith('-')) {
      current.lines.push({ type: 'remove', left: String(leftLine), right: '', content: line })
      leftLine += 1
      continue
    }

    current.lines.push({
      type: 'context',
      left: String(leftLine),
      right: String(rightLine),
      content: line
    })
    leftLine += 1
    rightLine += 1
  }

  pushCurrent()
  return sections
}

function ScmSectionHeader({
  title,
  count,
  defaultOpen,
  children,
  actions
}: {
  title: string
  count: number
  defaultOpen?: boolean
  children: React.ReactNode
  actions?: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen !== false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b border-border/60">
      <div className="flex min-h-8 items-center gap-1 pr-1">
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-0.5 rounded-sm py-1 pl-1 text-left hover:bg-muted/50">
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {title}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">({count})</span>
        </CollapsibleTrigger>
        {actions ? <div className="flex shrink-0 items-center gap-0.5">{actions}</div> : null}
      </div>
      <CollapsibleContent className="pb-1">{children}</CollapsibleContent>
    </Collapsible>
  )
}

function ScmFileRowView({
  row,
  selected,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
  disabled,
  labels
}: {
  row: ScmFileRow
  selected: boolean
  onSelect: () => void
  onStage: () => void
  onUnstage: () => void
  onDiscard: () => void
  disabled?: boolean
  labels: { stage: string; unstage: string; discard: string }
}): React.JSX.Element {
  const Icon = row.section === 'untracked' ? FilePlus : File
  return (
    <div
      className={cn(
        'group flex min-h-[26px] cursor-pointer items-center gap-0.5 rounded-sm pr-0.5 text-[13px] leading-tight',
        selected ? 'bg-muted' : 'hover:bg-muted/60'
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 pl-6 pr-1 text-left"
        onClick={onSelect}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{row.path}</span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
          {statusLetters(row.file, row.section)}
        </span>
      </button>
      <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {row.section === 'staged' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6"
                disabled={disabled}
                onClick={(event) => {
                  event.stopPropagation()
                  onUnstage()
                }}
              >
                <Minus className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">{labels.unstage}</TooltipContent>
          </Tooltip>
        ) : null}
        {row.section === 'unstaged' ||
        row.section === 'untracked' ||
        row.section === 'conflicted' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6"
                disabled={disabled || row.section === 'conflicted'}
                onClick={(event) => {
                  event.stopPropagation()
                  onStage()
                }}
              >
                <Plus className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">{labels.stage}</TooltipContent>
          </Tooltip>
        ) : null}
        {row.section !== 'conflicted' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 text-destructive hover:text-destructive"
                disabled={disabled}
                onClick={(event) => {
                  event.stopPropagation()
                  onDiscard()
                }}
              >
                <RotateCcw className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">{labels.discard}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </div>
  )
}

export function GitPage(): React.JSX.Element {
  const { t, i18n } = useTranslation('chat', { keyPrefix: 'git' })
  const activeProjectId = useChatStore((s) => s.activeProjectId)
  const projects = useChatStore((s) => s.projects)
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null
  const {
    repositories,
    selectedRepoPath,
    isScanning,
    scanError,
    repoDetailsByPath,
    scanRepositories,
    selectRepository,
    loadFileDiff,
    loadFileHistory,
    loadHistoryFileDiff,
    loadMoreHistory,
    pullRebase,
    syncRepository,
    pushRepository,
    fetchRepository,
    createBranch,
    checkoutBranch,
    mergeBranch,
    rebaseBranch,
    deleteLocalBranch,
    deleteRemoteBranch,
    renameBranch,
    stageFiles,
    unstageFiles,
    stageAll,
    unstageAll,
    discardFiles,
    commit,
    getStagedDiffBundle,
    startPolling,
    stopPolling,
    reset
  } = useGitStore()
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [newBranchName, setNewBranchName] = useState('')
  const [commitMessage, setCommitMessage] = useState('')
  const [committing, setCommitting] = useState(false)
  const [historyPick, setHistoryPick] = useState<{ path: string; hash: string } | null>(null)
  const [historyPatchLoading, setHistoryPatchLoading] = useState(false)
  const [aiCommitLoading, setAiCommitLoading] = useState(false)
  const [branchNameDialog, setBranchNameDialog] = useState<
    | { mode: 'createFrom'; startPoint: string }
    | { mode: 'rename'; oldName: string | null; displayName: string }
    | null
  >(null)
  const [branchNameInput, setBranchNameInput] = useState('')

  const {
    scmWidth,
    historyWidth,
    containerRef,
    onScmResizePointerDown,
    onHistoryResizePointerDown
  } = useGitPanelSplit()

  const selectedRepo = repositories.find((repo) => repo.fullPath === selectedRepoPath) ?? null
  const details = selectedRepoPath ? repoDetailsByPath[selectedRepoPath] : null
  const status = details?.status
  const busy = (details?.loading ?? false) || isScanning || committing

  const conflictRows = useMemo<ScmFileRow[]>(
    () =>
      (status?.conflicted ?? []).map((file) => ({
        path: file.path,
        section: 'conflicted' as const,
        file
      })),
    [status?.conflicted]
  )
  const stagedRows = useMemo<ScmFileRow[]>(
    () =>
      (status?.staged ?? []).map((file) => ({ path: file.path, section: 'staged' as const, file })),
    [status?.staged]
  )
  const unstagedRows = useMemo<ScmFileRow[]>(
    () => [
      ...(status?.unstaged ?? []).map((file) => ({
        path: file.path,
        section: 'unstaged' as const,
        file
      })),
      ...(status?.untracked ?? []).map((file) => ({
        path: file.path,
        section: 'untracked' as const,
        file
      }))
    ],
    [status?.unstaged, status?.untracked]
  )

  const allRows = useMemo(
    () => [...conflictRows, ...stagedRows, ...unstagedRows],
    [conflictRows, stagedRows, unstagedRows]
  )

  useEffect(() => {
    if (!activeProject?.workingFolder) {
      reset()
      return
    }
    void scanRepositories()
    startPolling()
    return () => stopPolling()
  }, [
    activeProject?.workingFolder,
    activeProject?.sshConnectionId,
    reset,
    scanRepositories,
    startPolling,
    stopPolling
  ])

  const activeKey = useMemo(() => {
    if (!selectedRepoPath) return null
    if (selectedKey && allRows.some((row) => scmFileKey(row) === selectedKey)) {
      return selectedKey
    }
    const first = allRows[0]
    return first ? scmFileKey(first) : null
  }, [allRows, selectedKey, selectedRepoPath])

  const selectedRow = useMemo(() => {
    if (!activeKey) return null
    return allRows.find((row) => scmFileKey(row) === activeKey) ?? null
  }, [allRows, activeKey])

  useEffect(() => {
    if (!selectedRepoPath || !selectedRow) return
    if (selectedRow.section === 'untracked') return
    void loadFileDiff(selectedRepoPath, selectedRow.path, selectedRow.section === 'staged')
    void loadFileHistory(selectedRepoPath, selectedRow.path)
  }, [loadFileDiff, loadFileHistory, selectedRepoPath, selectedRow])

  const fileHistory = useMemo(
    () => (selectedRow ? (details?.fileHistoryByPath[selectedRow.path] ?? []) : []),
    [details?.fileHistoryByPath, selectedRow]
  )

  const workingTreeDiff =
    selectedRow && details
      ? (details.diffByKey[
          `${selectedRow.section === 'staged' ? 'staged' : 'unstaged'}:${selectedRow.path}`
        ] ?? '')
      : ''

  const viewingHistoryDiff = Boolean(
    selectedRow &&
    selectedRow.section !== 'untracked' &&
    historyPick &&
    historyPick.path === selectedRow.path &&
    selectedRepoPath
  )

  const historyDiffCommitHash = viewingHistoryDiff && historyPick ? historyPick.hash : null

  const historyDiffCacheKey =
    viewingHistoryDiff && historyDiffCommitHash && selectedRow
      ? `${historyDiffCommitHash}:${selectedRow.path}`
      : null

  const cachedHistoryDiff =
    historyDiffCacheKey && details ? details.historyFileDiffByKey[historyDiffCacheKey] : undefined

  const selectedDiffText: string | null = viewingHistoryDiff
    ? cachedHistoryDiff !== undefined
      ? cachedHistoryDiff
      : null
    : workingTreeDiff

  const showHistoryDiffSpinner =
    viewingHistoryDiff && cachedHistoryDiff === undefined && historyPatchLoading

  const diffBlocks = useMemo(() => {
    if (selectedDiffText === null) return []
    return parseDiffBlocks(selectedDiffText)
  }, [selectedDiffText])

  const historyListForPanel = useMemo(
    () => (fileHistory.length > 0 ? fileHistory : (details?.history ?? [])),
    [fileHistory, details?.history]
  )

  const selectedHistoryEntry = useMemo(() => {
    if (!historyPick) return null
    return historyListForPanel.find((c) => c.hash === historyPick.hash) ?? null
  }, [historyPick, historyListForPanel])

  const upstreamHint = status?.upstream
    ? t('upstreamHint', { upstream: status.upstream, ahead: status.ahead, behind: status.behind })
    : null
  const selectedRepoLabel = selectedRepo
    ? selectedRepo.relativePath === '.'
      ? selectedRepo.name
      : selectedRepo.relativePath
    : null
  const totalChangeCount = conflictRows.length + stagedRows.length + unstagedRows.length

  const handlePullRebase = async (): Promise<void> => {
    if (!selectedRepoPath) return
    const result = await pullRebase(selectedRepoPath)
    if (!result.success) toast.error(result.error)
  }

  const handleSync = async (): Promise<void> => {
    if (!selectedRepoPath) return
    const result = await syncRepository(selectedRepoPath)
    if (!result.success) toast.error(result.error)
    else toast.success(t('syncDone'))
  }

  const handleFetch = async (): Promise<void> => {
    if (!selectedRepoPath) return
    const result = await fetchRepository(selectedRepoPath)
    if (!result.success) toast.error(result.error)
    else toast.success(t('fetchDone'))
  }

  const handlePush = async (): Promise<void> => {
    if (!selectedRepoPath) return
    const result = await pushRepository(selectedRepoPath)
    if (!result.success) toast.error(result.error)
    else toast.success(t('pushDone'))
  }

  const handleCreateBranch = async (repoPath: string): Promise<void> => {
    if (!newBranchName.trim()) return
    const result = await createBranch(repoPath, newBranchName.trim())
    if (!result.success) {
      toast.error(result.error)
      return
    }
    setNewBranchName('')
    toast.success(t('branchCreated'))
  }

  const visibleBranches = useMemo(
    () =>
      (details?.branches ?? []).filter(
        (b) => !(b.type === 'remote' && b.fullName.endsWith('/HEAD'))
      ),
    [details?.branches]
  )

  const runMergeInto = async (ref: string): Promise<void> => {
    if (!selectedRepoPath) return
    const result = await mergeBranch(selectedRepoPath, ref)
    if (!result.success) toast.error(result.error)
    else toast.success(t('branchMergeDone'))
  }

  const runRebaseOnto = async (ref: string): Promise<void> => {
    if (!selectedRepoPath) return
    const result = await rebaseBranch(selectedRepoPath, ref)
    if (!result.success) toast.error(result.error)
    else toast.success(t('branchRebaseDone'))
  }

  const runDeleteLocal = async (name: string, force: boolean): Promise<void> => {
    if (!selectedRepoPath) return
    const title = force
      ? t('branchDeleteLocalForceConfirm', { name })
      : t('branchDeleteLocalConfirm', { name })
    const ok = await confirm({
      title,
      variant: 'destructive',
      confirmLabel: t('branchDeleteConfirmAction')
    })
    if (!ok) return
    const result = await deleteLocalBranch(selectedRepoPath, name, force)
    if (!result.success) toast.error(result.error)
    else toast.success(force ? t('branchDeleteLocalForceDone') : t('branchDeleteLocalDone'))
  }

  const runDeleteRemote = async (branch: GitBranchItem): Promise<void> => {
    if (!selectedRepoPath) return
    const parsed = parseRemoteBranchName(branch.name)
    if (!parsed) {
      toast.error(t('branchDeleteRemoteInvalid'))
      return
    }
    const ok = await confirm({
      title: t('branchDeleteRemoteConfirm', { name: branch.name }),
      variant: 'destructive',
      confirmLabel: t('branchDeleteConfirmAction')
    })
    if (!ok) return
    const result = await deleteRemoteBranch(selectedRepoPath, parsed.remote, parsed.branchName)
    if (!result.success) toast.error(result.error)
    else toast.success(t('branchDeleteRemoteDone'))
  }

  const handleBranchDialogConfirm = async (): Promise<void> => {
    const name = branchNameInput.trim()
    if (!name || !selectedRepoPath || !branchNameDialog) return
    if (branchNameDialog.mode === 'createFrom') {
      const result = await createBranch(selectedRepoPath, name, branchNameDialog.startPoint)
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success(t('branchCreated'))
    } else {
      const result = await renameBranch(
        selectedRepoPath,
        name,
        branchNameDialog.oldName ?? undefined
      )
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success(t('branchRenameDone'))
    }
    setBranchNameDialog(null)
    setBranchNameInput('')
  }

  const handleCommit = async (): Promise<void> => {
    if (!selectedRepoPath || !commitMessage.trim()) return
    setCommitting(true)
    const result = await commit(selectedRepoPath, commitMessage.trim())
    setCommitting(false)
    if (!result.success) {
      toast.error(result.error)
      return
    }
    setCommitMessage('')
    toast.success(t('commitDone'))
  }

  const handleAiCommitMessage = useCallback(async (): Promise<void> => {
    if (!selectedRepoPath || stagedRows.length === 0) {
      toast.error(t('aiCommitNeedStaged'))
      return
    }
    setAiCommitLoading(true)
    const bundle = await getStagedDiffBundle(selectedRepoPath)
    if (!bundle.success) {
      setAiCommitLoading(false)
      toast.error(bundle.error)
      return
    }
    if (bundle.empty) {
      setAiCommitLoading(false)
      toast.error(t('aiCommitEmptyStaged'))
      return
    }
    const lang = i18n.language.startsWith('zh') ? 'zh' : 'en'
    const msg = await generateCommitMessageFromStagedDiff(
      bundle.stat,
      bundle.patch,
      lang,
      status?.branch,
      undefined
    )
    setAiCommitLoading(false)
    if (!msg) {
      toast.error(t('aiCommitFailed'))
      return
    }
    setCommitMessage(msg)
  }, [getStagedDiffBundle, i18n.language, selectedRepoPath, stagedRows.length, status?.branch, t])

  const handleHistoryCommitClick = async (commit: GitCommitHistoryItem): Promise<void> => {
    if (!selectedRepoPath || !selectedRow || selectedRow.section === 'untracked') return
    const cacheKey = `${commit.hash}:${selectedRow.path}`
    const cacheHit = details?.historyFileDiffByKey[cacheKey] !== undefined
    if (cacheHit) {
      setHistoryPick({ path: selectedRow.path, hash: commit.hash })
      return
    }
    setHistoryPatchLoading(true)
    setHistoryPick({ path: selectedRow.path, hash: commit.hash })
    const result = await loadHistoryFileDiff(selectedRepoPath, selectedRow.path, commit.hash)
    setHistoryPatchLoading(false)
    if (!result.success) setHistoryPick(null)
  }

  const confirmDiscard = async (row: ScmFileRow): Promise<void> => {
    const ok = await confirm({
      title: t('discardConfirmTitle'),
      description: t('discardConfirmDesc', { path: row.path }),
      confirmLabel: t('discardConfirmAction'),
      variant: 'destructive'
    })
    if (!ok) return
    if (!selectedRepoPath) return
    const scope =
      row.section === 'untracked' ? 'untracked' : row.section === 'staged' ? 'full' : 'worktree'
    const result = await discardFiles(selectedRepoPath, [row.path], scope)
    if (!result.success) toast.error(result.error)
  }

  if (!activeProject) {
    return (
      <div className="flex flex-1 items-center justify-center bg-background px-6">
        <div className="max-w-md text-center">
          <div className="text-[28px] font-semibold tracking-tight text-foreground">
            {t('noProject')}
          </div>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {t('pickRepo', {
              defaultValue: 'Select a project to inspect repositories and changes.'
            })}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background px-6 pb-6 pt-4">
      <div className="mx-auto w-full max-w-[1480px] pb-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
              {t('title')}
            </p>
            <h1 className="mt-1 truncate text-sm font-medium text-foreground/92">
              {activeProject.name}
            </h1>
            <p className="mt-1 max-w-[880px] truncate text-xs text-muted-foreground/72">
              {selectedRepoLabel ?? activeProject.workingFolder ?? t('pickRepo')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground/72">
            <span>{repositories.length} repos</span>
            <span>{totalChangeCount} changes</span>
            {conflictRows.length > 0 ? <span>{conflictRows.length} conflicts</span> : null}
          </div>
        </div>
      </div>
      <div
        ref={containerRef}
        className="mx-auto flex min-h-0 min-w-0 w-full max-w-[1480px] flex-1 overflow-hidden rounded-md border border-border/60 bg-background"
      >
        {/* SCM 侧栏 — 对齐 VS Code「源代码管理」结构 */}
        <aside
          style={{ width: scmWidth }}
          className="flex min-w-0 shrink-0 flex-col border-r border-border/60 bg-muted/10"
        >
          <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('title')}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  disabled={isScanning}
                  onClick={() => void scanRepositories()}
                >
                  <RefreshCw className={cn('size-3.5', isScanning && 'animate-spin')} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('refresh')}</TooltipContent>
            </Tooltip>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {repositories.length > 1 ? (
              <div className="border-b border-border px-2 py-2">
                <Select
                  value={selectedRepoPath ?? undefined}
                  onValueChange={(value) => {
                    setSelectedKey(null)
                    setHistoryPick(null)
                    selectRepository(value)
                  }}
                >
                  <SelectTrigger size="sm" className="h-8 w-full max-w-full text-left text-xs">
                    <SelectValue placeholder={t('pickRepo')} />
                  </SelectTrigger>
                  <SelectContent>
                    {repositories.map((repo) => (
                      <SelectItem key={repo.fullPath} value={repo.fullPath} className="text-xs">
                        <span className="truncate">
                          {repo.relativePath === '.' ? repo.name : repo.relativePath}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {!selectedRepo ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                {isScanning ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="size-3.5 animate-spin" />
                    {t('scanning')}
                  </span>
                ) : (
                  t('noRepo')
                )}
                {scanError ? <div className="mt-2 text-destructive">{scanError}</div> : null}
              </div>
            ) : (
              <>
                <div className="border-b border-border px-2 py-2">
                  <div className="flex items-center gap-1">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 max-w-[calc(100%-88px)] flex-1 justify-start gap-1 px-2 font-normal"
                          disabled={busy}
                        >
                          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate text-xs font-medium">
                            {status?.branch ?? selectedRepo.branch}
                          </span>
                          <ChevronDown className="ml-auto size-3.5 shrink-0 opacity-50" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="max-h-72 w-72 overflow-y-auto">
                        {visibleBranches.map((branch) => (
                          <ContextMenu key={branch.fullName}>
                            <ContextMenuTrigger asChild>
                              <DropdownMenuItem
                                className="text-xs"
                                disabled={busy}
                                onSelect={() =>
                                  void checkoutBranch(selectedRepo.fullPath, branch.name)
                                }
                              >
                                <span className="truncate">{branch.name}</span>
                                {branch.isCurrent ? (
                                  <span className="ml-auto text-[10px] text-muted-foreground">
                                    HEAD
                                  </span>
                                ) : null}
                              </DropdownMenuItem>
                            </ContextMenuTrigger>
                            <ContextMenuContent className="w-56">
                              {!branch.isCurrent ? (
                                <ContextMenuItem
                                  className="text-xs"
                                  onSelect={() =>
                                    void checkoutBranch(selectedRepo.fullPath, branch.name)
                                  }
                                >
                                  {t('branchCheckout')}
                                </ContextMenuItem>
                              ) : null}
                              {!branch.isCurrent ? (
                                <ContextMenuItem
                                  className="text-xs"
                                  onSelect={() => void runMergeInto(branch.name)}
                                >
                                  {t('branchMergeIntoCurrent')}
                                </ContextMenuItem>
                              ) : null}
                              {!branch.isCurrent ? (
                                <ContextMenuItem
                                  className="text-xs"
                                  onSelect={() => void runRebaseOnto(branch.name)}
                                >
                                  {t('branchRebaseOnto')}
                                </ContextMenuItem>
                              ) : null}
                              <ContextMenuSeparator />
                              <ContextMenuItem
                                className="text-xs"
                                onSelect={() => {
                                  setBranchNameDialog({
                                    mode: 'createFrom',
                                    startPoint: branch.name
                                  })
                                  setBranchNameInput('')
                                }}
                              >
                                {t('branchCreateFrom')}
                              </ContextMenuItem>
                              {branch.type === 'local' ? (
                                <ContextMenuItem
                                  className="text-xs"
                                  onSelect={() => {
                                    setBranchNameDialog({
                                      mode: 'rename',
                                      oldName: branch.isCurrent ? null : branch.name,
                                      displayName: branch.name
                                    })
                                    setBranchNameInput(branch.name)
                                  }}
                                >
                                  {t('branchRename')}
                                </ContextMenuItem>
                              ) : null}
                              {branch.type === 'local' && !branch.isCurrent ? (
                                <>
                                  <ContextMenuSeparator />
                                  <ContextMenuItem
                                    className="text-xs"
                                    onSelect={() => void runDeleteLocal(branch.name, false)}
                                  >
                                    {t('branchDeleteLocal')}
                                  </ContextMenuItem>
                                  <ContextMenuItem
                                    variant="destructive"
                                    className="text-xs"
                                    onSelect={() => void runDeleteLocal(branch.name, true)}
                                  >
                                    {t('branchDeleteLocalForce')}
                                  </ContextMenuItem>
                                </>
                              ) : null}
                              {branch.type === 'remote' &&
                              parseRemoteBranchName(branch.name)?.branchName !== 'HEAD' ? (
                                <>
                                  <ContextMenuSeparator />
                                  <ContextMenuItem
                                    variant="destructive"
                                    className="text-xs"
                                    onSelect={() => void runDeleteRemote(branch)}
                                  >
                                    {t('branchDeleteRemote')}
                                  </ContextMenuItem>
                                </>
                              ) : null}
                            </ContextMenuContent>
                          </ContextMenu>
                        ))}
                        <DropdownMenuSeparator />
                        <div className="flex gap-2 p-2">
                          <Input
                            value={newBranchName}
                            onChange={(event) => setNewBranchName(event.target.value)}
                            placeholder={t('newBranchPlaceholder')}
                            className="h-8 flex-1 text-xs"
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault()
                                void handleCreateBranch(selectedRepo.fullPath)
                              }
                            }}
                          />
                          <Button
                            size="sm"
                            className="h-8 shrink-0 px-2"
                            type="button"
                            onClick={() => void handleCreateBranch(selectedRepo.fullPath)}
                          >
                            <Plus className="size-3.5" />
                          </Button>
                        </div>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 shrink-0"
                          disabled={busy}
                          onClick={() => void handleFetch()}
                        >
                          <CloudDownload className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{t('fetch')}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 shrink-0"
                          disabled={busy}
                          onClick={() => void handlePullRebase()}
                        >
                          <RefreshCw className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{t('pullRebase')}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 shrink-0"
                          disabled={busy}
                          onClick={() => void handlePush()}
                        >
                          <CloudUpload className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{t('push')}</TooltipContent>
                    </Tooltip>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 shrink-0"
                          disabled={busy}
                        >
                          <EllipsisVertical className="size-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem className="text-xs" onSelect={() => void handleSync()}>
                          <Upload className="mr-2 size-3.5" />
                          {t('sync')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  {upstreamHint ? (
                    <div className="mt-1 truncate px-1 text-[11px] text-muted-foreground">
                      {upstreamHint}
                    </div>
                  ) : null}
                  {details?.error ? (
                    <div className="mt-2 rounded border border-destructive/30 bg-destructive/5 px-2 py-1 text-[11px] text-destructive">
                      {details.error}
                    </div>
                  ) : null}
                </div>

                {conflictRows.length > 0 ? (
                  <ScmSectionHeader title={t('sectionConflicts')} count={conflictRows.length}>
                    {conflictRows.map((row) => (
                      <ScmFileRowView
                        key={scmFileKey(row)}
                        row={row}
                        selected={activeKey === scmFileKey(row)}
                        onSelect={() => {
                          setHistoryPick(null)
                          setSelectedKey(scmFileKey(row))
                        }}
                        onStage={() => void stageFiles(selectedRepo.fullPath, [row.path])}
                        onUnstage={() => void unstageFiles(selectedRepo.fullPath, [row.path])}
                        onDiscard={() => void confirmDiscard(row)}
                        disabled={busy}
                        labels={{
                          stage: t('tooltipStage'),
                          unstage: t('tooltipUnstage'),
                          discard: t('tooltipDiscard')
                        }}
                      />
                    ))}
                  </ScmSectionHeader>
                ) : null}

                <ScmSectionHeader
                  title={t('sectionStaged')}
                  count={stagedRows.length}
                  actions={
                    stagedRows.length > 0 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5 text-[10px]"
                        disabled={busy}
                        onClick={() => void unstageAll(selectedRepo.fullPath)}
                      >
                        {t('unstageAll')}
                      </Button>
                    ) : null
                  }
                >
                  {stagedRows.length === 0 ? (
                    <div className="py-2 pl-6 text-[12px] text-muted-foreground">
                      {t('emptyStaged')}
                    </div>
                  ) : (
                    stagedRows.map((row) => (
                      <ScmFileRowView
                        key={scmFileKey(row)}
                        row={row}
                        selected={activeKey === scmFileKey(row)}
                        onSelect={() => {
                          setHistoryPick(null)
                          setSelectedKey(scmFileKey(row))
                        }}
                        onStage={() => void stageFiles(selectedRepo.fullPath, [row.path])}
                        onUnstage={() => void unstageFiles(selectedRepo.fullPath, [row.path])}
                        onDiscard={() => void confirmDiscard(row)}
                        disabled={busy}
                        labels={{
                          stage: t('tooltipStage'),
                          unstage: t('tooltipUnstage'),
                          discard: t('tooltipDiscard')
                        }}
                      />
                    ))
                  )}
                </ScmSectionHeader>

                <ScmSectionHeader
                  title={t('sectionChanges')}
                  count={unstagedRows.length}
                  actions={
                    unstagedRows.length > 0 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5 text-[10px]"
                        disabled={busy}
                        onClick={() => void stageAll(selectedRepo.fullPath)}
                      >
                        {t('stageAll')}
                      </Button>
                    ) : null
                  }
                >
                  {unstagedRows.length === 0 ? (
                    <div className="py-2 pl-6 text-[12px] text-muted-foreground">
                      {t('emptyChanges')}
                    </div>
                  ) : (
                    unstagedRows.map((row) => (
                      <ScmFileRowView
                        key={scmFileKey(row)}
                        row={row}
                        selected={activeKey === scmFileKey(row)}
                        onSelect={() => {
                          setHistoryPick(null)
                          setSelectedKey(scmFileKey(row))
                        }}
                        onStage={() => void stageFiles(selectedRepo.fullPath, [row.path])}
                        onUnstage={() => void unstageFiles(selectedRepo.fullPath, [row.path])}
                        onDiscard={() => void confirmDiscard(row)}
                        disabled={busy}
                        labels={{
                          stage: t('tooltipStage'),
                          unstage: t('tooltipUnstage'),
                          discard: t('tooltipDiscard')
                        }}
                      />
                    ))
                  )}
                </ScmSectionHeader>

                <div className="border-t border-border p-2">
                  <div className="relative">
                    <Textarea
                      value={commitMessage}
                      onChange={(event) => setCommitMessage(event.target.value)}
                      placeholder={t('commitPlaceholder')}
                      disabled={busy || aiCommitLoading}
                      className="min-h-[72px] resize-y rounded-sm border-border/80 bg-background pr-10 text-xs"
                      rows={3}
                    />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="absolute top-1 right-1 size-7"
                          disabled={busy || aiCommitLoading || stagedRows.length === 0}
                          onClick={() => void handleAiCommitMessage()}
                        >
                          {aiCommitLoading ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Wand2 className="size-3.5" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="left">{t('aiCommitTooltip')}</TooltipContent>
                    </Tooltip>
                  </div>
                  <Button
                    type="button"
                    className="mt-2 h-8 w-full text-xs"
                    disabled={
                      busy ||
                      committing ||
                      aiCommitLoading ||
                      stagedRows.length === 0 ||
                      !commitMessage.trim()
                    }
                    onClick={() => void handleCommit()}
                  >
                    {committing ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}
                    {t('commitButton')}
                  </Button>
                </div>
              </>
            )}
          </div>
        </aside>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('resizeScmPanel')}
          onPointerDown={onScmResizePointerDown}
          className="w-[5px] shrink-0 cursor-col-resize border-x border-transparent bg-border/50 hover:bg-primary/35"
        />

        {/* 差异与历史 — 主编辑区风格 */}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          {!selectedRepo || !selectedRow ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              {selectedRepo ? t('pickFile') : t('noRepo')}
            </div>
          ) : (
            <div className="flex min-h-0 min-w-0 flex-1 flex-row">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-border">
                <div className="flex h-9 min-h-9 shrink-0 items-center gap-2 border-b border-border px-2">
                  {viewingHistoryDiff ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0 px-2 text-[11px]"
                      onClick={() => setHistoryPick(null)}
                    >
                      {t('backToWorkingDiff')}
                    </Button>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {selectedRow.path}
                  </span>
                  {viewingHistoryDiff && selectedHistoryEntry ? (
                    <span
                      className="max-w-[min(280px,45%)] shrink-0 truncate text-[10px] text-muted-foreground"
                      title={selectedHistoryEntry.subject}
                    >
                      {selectedHistoryEntry.shortHash} · {selectedHistoryEntry.subject}
                    </span>
                  ) : (
                    <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
                      {selectedRow.section}
                    </span>
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {selectedRow.section === 'untracked' ? (
                    <div className="px-4 py-6 text-sm text-muted-foreground">
                      {t('untrackedNoDiff')}
                    </div>
                  ) : showHistoryDiffSpinner ? (
                    <div className="flex flex-1 items-center justify-center py-16 text-muted-foreground">
                      <Loader2 className="size-6 animate-spin" />
                    </div>
                  ) : diffBlocks.length === 0 ? (
                    <div className="px-4 py-6 text-sm text-muted-foreground">{t('noDiff')}</div>
                  ) : (
                    <div className="font-mono text-[12px] leading-[20px]">
                      {diffBlocks.map((block, blockIndex) => (
                        <div
                          key={`${block.header}-${blockIndex}`}
                          className="border-b border-border/50 last:border-0"
                        >
                          <div className="bg-muted/50 px-3 py-1 text-[11px] text-muted-foreground">
                            {block.header}
                          </div>
                          {block.lines.map((line, lineIndex) => (
                            <div
                              key={`${blockIndex}-${lineIndex}`}
                              className={cn(
                                'grid grid-cols-[48px_48px_minmax(0,1fr)] border-b border-border/40 last:border-0',
                                line.type === 'add' &&
                                  'bg-green-500/10 text-green-800 dark:text-green-300',
                                line.type === 'remove' &&
                                  'bg-red-500/10 text-red-800 dark:text-red-300',
                                line.type === 'meta' && 'bg-muted/40 text-muted-foreground'
                              )}
                            >
                              <div className="select-none border-r border-border/40 px-1.5 text-right text-[10px] text-muted-foreground">
                                {line.left}
                              </div>
                              <div className="select-none border-r border-border/40 px-1.5 text-right text-[10px] text-muted-foreground">
                                {line.right}
                              </div>
                              <pre className="overflow-x-auto px-2 py-0 whitespace-pre-wrap break-words">
                                {line.content || ' '}
                              </pre>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={t('resizeHistoryPanel')}
                onPointerDown={onHistoryResizePointerDown}
                className="w-[5px] shrink-0 cursor-col-resize border-x border-transparent bg-border/50 hover:bg-primary/35"
              />

              <div style={{ width: historyWidth }} className="flex min-h-0 shrink-0 flex-col">
                <div className="flex h-9 shrink-0 items-center border-b border-border px-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('fileHistory')}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  <div className="space-y-1">
                    {historyListForPanel.map((c) => {
                      const canOpenHistory =
                        selectedRow.section !== 'untracked' && Boolean(selectedRepoPath)
                      return (
                        <button
                          key={c.hash}
                          type="button"
                          disabled={!canOpenHistory || busy}
                          onClick={() => void handleHistoryCommitClick(c)}
                          className={cn(
                            'w-full rounded-sm border px-2 py-1.5 text-left text-xs transition-colors',
                            canOpenHistory && !busy
                              ? 'cursor-pointer border-border/60 bg-muted/10 hover:bg-muted/40'
                              : 'cursor-not-allowed border-border/40 opacity-60',
                            historyPick?.hash === c.hash &&
                              historyPick?.path === selectedRow.path &&
                              'border-primary/50 bg-primary/10 ring-1 ring-primary/20'
                          )}
                        >
                          <div className="line-clamp-2 font-medium leading-snug">{c.subject}</div>
                          <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                            {c.shortHash} · {c.author}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2 h-7 w-full text-[11px]"
                    disabled={busy}
                    onClick={() =>
                      selectedRow
                        ? void loadFileHistory(selectedRepo.fullPath, selectedRow.path, true)
                        : void loadMoreHistory(selectedRepo.fullPath)
                    }
                  >
                    {t('loadMoreHistory')}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>

      <Dialog
        open={branchNameDialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setBranchNameDialog(null)
            setBranchNameInput('')
          }
        }}
      >
        <DialogContent className="gap-3 sm:max-w-md" showCloseButton>
          <DialogHeader>
            <DialogTitle className="text-base">
              {branchNameDialog?.mode === 'createFrom'
                ? t('branchCreateFromTitle', { ref: branchNameDialog.startPoint })
                : branchNameDialog
                  ? t('branchRenameTitle', { name: branchNameDialog.displayName })
                  : ''}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {branchNameDialog?.mode === 'createFrom'
                ? t('branchCreateFromDesc')
                : t('branchRenameDesc')}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={branchNameInput}
            onChange={(e) => setBranchNameInput(e.target.value)}
            placeholder={t('newBranchPlaceholder')}
            className="h-9 text-sm"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void handleBranchDialogConfirm()
              }
            }}
          />
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setBranchNameDialog(null)
                setBranchNameInput('')
              }}
            >
              {t('branchDialogCancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!branchNameInput.trim() || busy}
              onClick={() => void handleBranchDialogConfirm()}
            >
              {t('branchDialogConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
