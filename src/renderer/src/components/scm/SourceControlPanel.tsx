import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import {
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Undo2
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'
import { cn } from '@renderer/lib/utils'
import { useChatStore } from '@renderer/stores/chat-store'
import { useGitStore, type GitStatusFile } from '@renderer/stores/git-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import type { GitChangeSection } from '@renderer/stores/ui-store'
import {
  aggregateDisplayableRunFileChanges,
  latestDisplayableRunChangeSet,
  type AggregatedFileChange
} from '@renderer/components/chat/file-change-utils'
import { generateCommitMessageFromStagedDiff } from '@renderer/lib/git/generate-commit-message'
import { normalizeLanguageCode } from '@renderer/lib/i18n-language'
import { openAgentDiff, openGitDiff } from './scm-diff'

const EMPTY_MESSAGES: never[] = []

function fileBaseName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function fileDir(path: string): string {
  const parts = path.split(/[\\/]/)
  parts.pop()
  return parts.join('/')
}

function statusLetter(file: GitStatusFile, section: GitChangeSection): string {
  if (section === 'untracked') return 'U'
  if (section === 'conflicted') return 'C'
  const char = (section === 'staged' ? file.stagedStatus : file.unstagedStatus).trim()
  return char || 'M'
}

function statusColor(letter: string): string {
  switch (letter) {
    case 'A':
    case 'U':
      return 'text-emerald-500'
    case 'D':
      return 'text-red-500'
    case 'R':
      return 'text-sky-500'
    case 'C':
      return 'text-amber-500'
    default:
      return 'text-amber-500'
  }
}

interface RowAction {
  icon: React.JSX.Element
  title: string
  onClick: () => void
}

function ScmRow({
  name,
  dir,
  letter,
  letterColor,
  active,
  onOpen,
  actions
}: {
  name: string
  dir: string
  letter: string
  letterColor: string
  active: boolean
  onOpen: () => void
  actions: RowAction[]
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'group flex h-[26px] cursor-pointer items-center gap-1.5 rounded-sm px-2 text-[12px]',
        active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/60'
      )}
      onClick={onOpen}
      title={`${dir ? `${dir}/` : ''}${name}`}
    >
      <span className="min-w-0 flex-1 truncate">
        {name}
        {dir ? <span className="ml-1.5 text-[10px] text-muted-foreground">{dir}</span> : null}
      </span>
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {actions.map((action, index) => (
          <button
            key={index}
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:bg-background/70 hover:text-foreground"
            title={action.title}
            onClick={(event) => {
              event.stopPropagation()
              action.onClick()
            }}
          >
            {action.icon}
          </button>
        ))}
      </span>
      <span className={cn('w-3 shrink-0 text-center text-[11px] font-semibold', letterColor)}>
        {letter}
      </span>
    </div>
  )
}

function ScmGroup({
  title,
  count,
  collapsed,
  onToggle,
  actions,
  children
}: {
  title: string
  count: number
  collapsed: boolean
  onToggle: () => void
  actions?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element | null {
  if (count === 0) return null
  return (
    <div className="flex flex-col">
      <div className="group flex h-7 items-center gap-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 hover:text-foreground"
          onClick={onToggle}
        >
          {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          <span className="truncate">{title}</span>
        </button>
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {actions}
        </span>
        <span className="ml-1 shrink-0 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
          {count}
        </span>
      </div>
      {!collapsed && <div className="flex flex-col px-1 pb-1">{children}</div>}
    </div>
  )
}

export function SourceControlPanel({
  sessionId
}: {
  sessionId?: string | null
}): React.JSX.Element {
  const { t, i18n } = useTranslation(['layout', 'chat', 'common'])

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
        messages: currentSession?.messages ?? EMPTY_MESSAGES
      }
    })
  )

  const git = useGitStore(
    useShallow((state) => ({
      repositories: state.repositories,
      selectedRepoPath: state.selectedRepoPath,
      repoDetailsByPath: state.repoDetailsByPath,
      scanRepositories: state.scanRepositories,
      refreshRepository: state.refreshRepository,
      stageFiles: state.stageFiles,
      unstageFiles: state.unstageFiles,
      stageAll: state.stageAll,
      unstageAll: state.unstageAll,
      discardFiles: state.discardFiles,
      commit: state.commit,
      syncRepository: state.syncRepository,
      getStagedDiffBundle: state.getStagedDiffBundle
    }))
  )

  const { runChangesByRunId, refreshSessionRunChanges, undoFileChange } = useAgentStore(
    useShallow((state) => ({
      runChangesByRunId: state.runChangesByRunId,
      refreshSessionRunChanges: state.refreshSessionRunChanges,
      undoFileChange: state.undoFileChange
    }))
  )

  const [commitMessage, setCommitMessage] = React.useState('')
  const [committing, setCommitting] = React.useState(false)
  const [aiLoading, setAiLoading] = React.useState(false)
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({})
  const [busy, setBusy] = React.useState(false)
  const requestedAgentRef = React.useRef<string | null>(null)

  const { scanRepositories } = git
  React.useEffect(() => {
    if (!sessionView.workingFolder) return
    void scanRepositories()
  }, [scanRepositories, sessionView.projectId, sessionView.workingFolder])

  React.useEffect(() => {
    if (!sessionView.sessionId) return
    if (requestedAgentRef.current === sessionView.sessionId) return
    requestedAgentRef.current = sessionView.sessionId
    void refreshSessionRunChanges(sessionView.sessionId)
  }, [refreshSessionRunChanges, sessionView.sessionId])

  const repoPath = git.selectedRepoPath
  const repoDetails = repoPath ? git.repoDetailsByPath[repoPath] : null
  const status = repoDetails?.status ?? null

  const assistantMessageIds = React.useMemo(() => {
    const ids = new Set<string>()
    for (const message of sessionView.messages) {
      if (message.role === 'assistant') ids.add(message.id)
    }
    return ids
  }, [sessionView.messages])

  const agentChanges = React.useMemo<AggregatedFileChange[]>(() => {
    const seen = new Set<string>()
    const sets = Object.values(runChangesByRunId)
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
    const latest = latestDisplayableRunChangeSet(sets)
    return aggregateDisplayableRunFileChanges(latest?.changes ?? []).sort(
      (left, right) => left.createdAt - right.createdAt
    )
  }, [assistantMessageIds, runChangesByRunId, sessionView.sessionId])

  const toggleGroup = (key: string): void =>
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))

  const runAction = async (
    fn: () => Promise<{ success: boolean; error?: string }>
  ): Promise<boolean> => {
    if (!repoPath) return false
    setBusy(true)
    try {
      const result = await fn()
      if (!result.success) {
        toast.error(result.error ?? t('common:somethingWrong', { defaultValue: 'Action failed' }))
      }
      return result.success
    } finally {
      setBusy(false)
    }
  }

  const handleCommit = async (): Promise<void> => {
    if (!repoPath || !commitMessage.trim() || committing) return
    setCommitting(true)
    try {
      const result = await git.commit(repoPath, commitMessage.trim())
      if (!result.success) {
        toast.error(result.error ?? t('common:somethingWrong', { defaultValue: 'Commit failed' }))
        return
      }
      setCommitMessage('')
      toast.success(t('layout:committed', { defaultValue: 'Committed' }))
    } finally {
      setCommitting(false)
    }
  }

  const handleGenerate = async (): Promise<void> => {
    if (!repoPath || aiLoading) return
    setAiLoading(true)
    try {
      const bundle = await git.getStagedDiffBundle(repoPath)
      if (!bundle.success) {
        toast.error(bundle.error)
        return
      }
      if (bundle.empty) {
        toast.error(
          t('layout:scmNothingStaged', { defaultValue: 'Nothing staged — stage changes first' })
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
        toast.error(t('layout:scmGenerateFailed', { defaultValue: 'Generation failed' }))
        return
      }
      setCommitMessage(message)
    } finally {
      setAiLoading(false)
    }
  }

  const renderGitRows = (files: GitStatusFile[], section: GitChangeSection): React.ReactNode =>
    files.map((file) => {
      const letter = statusLetter(file, section)
      const stageAction: RowAction =
        section === 'staged'
          ? {
              icon: <Minus className="size-3.5" />,
              title: t('layout:scmUnstage', { defaultValue: 'Unstage' }),
              onClick: () => void runAction(() => git.unstageFiles(repoPath!, [file.path]))
            }
          : {
              icon: <Plus className="size-3.5" />,
              title: t('layout:scmStage', { defaultValue: 'Stage' }),
              onClick: () => void runAction(() => git.stageFiles(repoPath!, [file.path]))
            }
      const discardAction: RowAction = {
        icon: <RotateCcw className="size-3.5" />,
        title: t('layout:scmDiscard', { defaultValue: 'Discard' }),
        onClick: () =>
          void runAction(() =>
            git.discardFiles(
              repoPath!,
              [file.path],
              section === 'untracked' ? 'untracked' : section === 'staged' ? 'full' : 'worktree'
            )
          )
      }
      return (
        <ScmRow
          key={`${section}:${file.path}`}
          name={fileBaseName(file.path)}
          dir={fileDir(file.path)}
          letter={letter}
          letterColor={statusColor(letter)}
          active={false}
          onOpen={() =>
            void openGitDiff({
              repoPath: repoPath!,
              file,
              section,
              sshConnectionId: sessionView.sshConnectionId,
              sessionId: sessionView.sessionId
            })
          }
          actions={[stageAction, discardAction]}
        />
      )
    })

  if (!sessionView.workingFolder) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {t('layout:scmNoFolder', { defaultValue: 'Open a working folder to use source control.' })}
      </div>
    )
  }

  const staged = status?.staged ?? []
  const unstaged = status?.unstaged ?? []
  const untracked = status?.untracked ?? []
  const conflicted = status?.conflicted ?? []
  const changesCount = unstaged.length + untracked.length
  const nothing =
    staged.length + changesCount + conflicted.length === 0 && agentChanges.length === 0

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/50 px-3">
        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
          {status?.branch ?? t('layout:scmTitle', { defaultValue: 'Source Control' })}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          disabled={!repoPath}
          onClick={() => repoPath && void git.refreshRepository(repoPath)}
          title={t('common:action.refresh', { defaultValue: 'Refresh' })}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>

      <div className="flex flex-col gap-1.5 border-b border-border/50 p-2">
        <div className="relative">
          <Textarea
            value={commitMessage}
            onChange={(event) => setCommitMessage(event.target.value)}
            placeholder={t('layout:scmCommitPlaceholder', { defaultValue: 'Message' })}
            className="min-h-[54px] resize-none pr-8 text-[12px]"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                void handleCommit()
              }
            }}
          />
          <button
            type="button"
            className="absolute right-1.5 top-1.5 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            title={t('layout:scmGenerate', { defaultValue: 'Generate commit message' })}
            disabled={aiLoading || busy}
            onClick={() => void handleGenerate()}
          >
            <Sparkles className={cn('size-3.5', aiLoading && 'animate-pulse text-amber-500')} />
          </button>
        </div>
        <Button
          size="sm"
          className="h-7 w-full gap-1.5 text-[12px]"
          disabled={!repoPath || !commitMessage.trim() || committing || staged.length === 0}
          onClick={() => void handleCommit()}
        >
          <Check className="size-3.5" />
          {t('layout:scmCommit', { defaultValue: 'Commit' })}
          {staged.length > 0 ? ` (${staged.length})` : ''}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {nothing ? (
          <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
            {t('layout:scmClean', { defaultValue: 'No changes' })}
          </div>
        ) : null}

        <ScmGroup
          title={t('layout:scmMerge', { defaultValue: 'Merge Changes' })}
          count={conflicted.length}
          collapsed={Boolean(collapsed.conflicted)}
          onToggle={() => toggleGroup('conflicted')}
        >
          {renderGitRows(conflicted, 'conflicted')}
        </ScmGroup>

        <ScmGroup
          title={t('layout:scmStaged', { defaultValue: 'Staged Changes' })}
          count={staged.length}
          collapsed={Boolean(collapsed.staged)}
          onToggle={() => toggleGroup('staged')}
          actions={
            <button
              type="button"
              className="rounded p-0.5 hover:bg-background/70 hover:text-foreground"
              title={t('layout:scmUnstageAll', { defaultValue: 'Unstage all' })}
              onClick={() => repoPath && void runAction(() => git.unstageAll(repoPath))}
            >
              <Minus className="size-3.5" />
            </button>
          }
        >
          {renderGitRows(staged, 'staged')}
        </ScmGroup>

        <ScmGroup
          title={t('layout:scmChanges', { defaultValue: 'Changes' })}
          count={changesCount}
          collapsed={Boolean(collapsed.changes)}
          onToggle={() => toggleGroup('changes')}
          actions={
            <button
              type="button"
              className="rounded p-0.5 hover:bg-background/70 hover:text-foreground"
              title={t('layout:scmStageAll', { defaultValue: 'Stage all' })}
              onClick={() => repoPath && void runAction(() => git.stageAll(repoPath))}
            >
              <Plus className="size-3.5" />
            </button>
          }
        >
          {renderGitRows(unstaged, 'unstaged')}
          {renderGitRows(untracked, 'untracked')}
        </ScmGroup>

        <ScmGroup
          title={t('layout:scmAgentChanges', { defaultValue: 'Agent Changes' })}
          count={agentChanges.length}
          collapsed={Boolean(collapsed.agent)}
          onToggle={() => toggleGroup('agent')}
        >
          {agentChanges.map((change) => (
            <ScmRow
              key={change.id}
              name={fileBaseName(change.filePath)}
              dir={fileDir(change.filePath)}
              letter={change.op === 'create' ? 'A' : 'M'}
              letterColor={statusColor(change.op === 'create' ? 'A' : 'M')}
              active={false}
              onOpen={() => void openAgentDiff(change, sessionView.sessionId)}
              actions={[
                {
                  icon: <Undo2 className="size-3.5" />,
                  title: t('layout:scmUndo', { defaultValue: 'Undo' }),
                  onClick: () => void undoFileChange(change.runId, change.id)
                }
              ]}
            />
          ))}
        </ScmGroup>
      </div>
    </div>
  )
}
