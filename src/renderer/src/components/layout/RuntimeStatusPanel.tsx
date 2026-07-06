import * as React from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import {
  Folder,
  GitBranch,
  GitCompare,
  Laptop,
  ListChecks,
  Loader2,
  Server,
  SquareTerminal,
  X
} from 'lucide-react'
import { TodoStatusList } from '@renderer/components/chat/TodoCard'
import { Button } from '@renderer/components/ui/button'
import { IPC } from '@renderer/lib/ipc/channels'
import { invokeMessagePackBinary } from '@renderer/lib/ipc/messagepack-ipc-client'
import { cn } from '@renderer/lib/utils'
import { useChatStore } from '@renderer/stores/chat-store'
import type { GitStatusDetailed } from '@renderer/stores/git-store'
import {
  getCachedInputDraft,
  getSessionInputDraftKey,
  subscribeInputDraftCache
} from '@renderer/lib/input-drafts'
import { useSshStore } from '@renderer/stores/ssh-store'
import { useTaskStore, type TaskItem } from '@renderer/stores/task-store'
import { useTeamStore } from '@renderer/stores/team-store'
import { useTerminalStore, type LocalTerminalSession } from '@renderer/stores/terminal-store'
import { useUIStore } from '@renderer/stores/ui-store'
import type { TeamTask } from '@renderer/lib/agent/teams/types'
import { toMessagePackChannel } from '../../../../shared/messagepack/binary-ipc'

const EMPTY_TASKS: TaskItem[] = []
const RUNTIME_GIT_SUMMARY_CACHE_MS = 5_000

interface RuntimeStatusPanelProps {
  sessionId?: string | null
  docked?: boolean
}

const DOCKED_PANEL_CARD_WIDTH = 320
// Track = card width + right margin, so the docked card matches the floating one.
const DOCKED_PANEL_TRACK_WIDTH = DOCKED_PANEL_CARD_WIDTH + 12

interface GitResultBase {
  success?: boolean
  error?: string
}

interface RuntimeGitSummary {
  loading: boolean
  branch: string | null
  upstream?: string
  ahead: number
  behind: number
  changedFileCount: number
  added: number | null
  deleted: number | null
  dirty: boolean
  truncatedLineSummary: boolean
  error: string | null
}

function teamTaskToItem(task: TeamTask): TaskItem {
  return {
    id: task.id,
    sessionId: '',
    subject: task.subject,
    description: task.description,
    activeForm: task.activeForm,
    status: task.status,
    owner: task.owner,
    blocks: [],
    blockedBy: task.dependsOn ?? [],
    metadata: undefined,
    createdAt: 0,
    updatedAt: 0
  }
}

function compactPath(path: string | null): string {
  if (!path) return ''
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return path
  return parts.slice(-2).join('/')
}

function uniqueChangedFileCount(status: GitStatusDetailed): number {
  const files = new Set<string>()
  for (const item of [
    ...status.staged,
    ...status.unstaged,
    ...status.untracked,
    ...status.conflicted
  ]) {
    files.add(item.path)
  }
  return files.size
}

function hasTrackedChanges(status: GitStatusDetailed): boolean {
  return status.staged.length > 0 || status.unstaged.length > 0 || status.conflicted.length > 0
}

function createEmptyRuntimeGitSummary(): RuntimeGitSummary {
  return {
    loading: false,
    branch: null,
    ahead: 0,
    behind: 0,
    changedFileCount: 0,
    added: null,
    deleted: null,
    dirty: false,
    truncatedLineSummary: false,
    error: null
  }
}

type GitLineSummaryResult = GitResultBase & {
  added?: number
  deleted?: number
  binary?: number
}

const runtimeGitSummaryCache = new Map<string, { expiresAt: number; summary: RuntimeGitSummary }>()
const runtimeGitSummaryRequests = new Map<string, Promise<RuntimeGitSummary>>()

function runtimeGitSummaryCacheKey(workingFolder: string, sshConnectionId: string | null): string {
  return `${sshConnectionId ?? 'local'}:${workingFolder}`
}

async function loadRuntimeGitSummary(
  workingFolder: string,
  sshConnectionId: string | null
): Promise<RuntimeGitSummary> {
  const statusResult = await invokeMessagePackBinary<
    GitResultBase & { status?: GitStatusDetailed }
  >(toMessagePackChannel(IPC.GIT_GET_STATUS_DETAILED), {
    cwd: workingFolder,
    sshConnectionId
  })

  if (!statusResult.success || !statusResult.status) {
    return {
      ...createEmptyRuntimeGitSummary(),
      error: statusResult.error ?? 'Git status unavailable'
    }
  }

  const status = statusResult.status
  const dirty =
    status.staged.length > 0 ||
    status.unstaged.length > 0 ||
    status.untracked.length > 0 ||
    status.conflicted.length > 0

  let added: number | null = null
  let deleted: number | null = null
  if (hasTrackedChanges(status)) {
    const lineSummary = await invokeMessagePackBinary<GitLineSummaryResult>(
      toMessagePackChannel(IPC.GIT_GET_LINE_SUMMARY),
      {
        cwd: workingFolder,
        sshConnectionId
      }
    )
    if (lineSummary.success) {
      added = lineSummary.added ?? 0
      deleted = lineSummary.deleted ?? 0
    }
  }

  return {
    loading: false,
    branch: status.branch,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    changedFileCount: uniqueChangedFileCount(status),
    added,
    deleted,
    dirty,
    truncatedLineSummary: false,
    error: null
  }
}

function useRuntimeGitSummary(
  workingFolder: string | null,
  sshConnectionId: string | null,
  enabled: boolean
): RuntimeGitSummary {
  const [summary, setSummary] = React.useState<RuntimeGitSummary>(createEmptyRuntimeGitSummary)

  React.useEffect(() => {
    if (!enabled || !workingFolder) {
      setSummary(createEmptyRuntimeGitSummary())
      return
    }

    let disposed = false
    const targetWorkingFolder = workingFolder
    const targetSshConnectionId = sshConnectionId
    const cacheKey = runtimeGitSummaryCacheKey(targetWorkingFolder, targetSshConnectionId)
    const cached = runtimeGitSummaryCache.get(cacheKey)
    const now = Date.now()
    if (cached && cached.expiresAt > now) {
      setSummary(cached.summary)
      return
    }

    setSummary((current) => ({
      ...current,
      loading: true,
      error: null
    }))

    async function loadGitSummary(): Promise<void> {
      let request = runtimeGitSummaryRequests.get(cacheKey)
      if (!request) {
        request = loadRuntimeGitSummary(targetWorkingFolder, targetSshConnectionId)
        runtimeGitSummaryRequests.set(cacheKey, request)
        void request.finally(() => {
          if (runtimeGitSummaryRequests.get(cacheKey) === request) {
            runtimeGitSummaryRequests.delete(cacheKey)
          }
        })
      }

      const nextSummary = await request
      runtimeGitSummaryCache.set(cacheKey, {
        expiresAt: Date.now() + RUNTIME_GIT_SUMMARY_CACHE_MS,
        summary: nextSummary
      })
      if (!disposed) setSummary(nextSummary)
    }

    void loadGitSummary()

    return () => {
      disposed = true
    }
  }, [enabled, sshConnectionId, workingFolder])

  return summary
}

function ContextRow({
  icon,
  label,
  value,
  title,
  valueClassName
}: {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
  title?: string
  valueClassName?: string
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs" title={title}>
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/75">
        {icon}
      </span>
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={cn('min-w-0 flex-1 truncate text-right text-foreground/85', valueClassName)}>
        {value}
      </span>
    </div>
  )
}

function terminalLabel(terminal: LocalTerminalSession): string {
  return terminal.command?.trim() || terminal.title || compactPath(terminal.shell) || terminal.id
}

function RunningTerminalRow({
  terminal,
  onClose,
  closeTitle
}: {
  terminal: LocalTerminalSession
  onClose: (id: string) => void
  closeTitle: string
}): React.JSX.Element {
  const label = terminalLabel(terminal)
  const meta = compactPath(terminal.cwd) || compactPath(terminal.shell) || terminal.id

  return (
    <div className="group flex min-w-0 items-center gap-2 rounded-md border border-border/60 bg-muted/15 px-2 py-1.5">
      <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-medium text-foreground/85" title={label}>
          {label}
        </div>
        <div
          className="truncate text-[10px] text-muted-foreground/65"
          title={terminal.cwd || terminal.shell}
        >
          {meta}
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-6 shrink-0 text-muted-foreground opacity-70 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
        title={closeTitle}
        aria-label={closeTitle}
        onClick={() => onClose(terminal.id)}
      >
        <X className="size-3" />
      </Button>
    </div>
  )
}

export function RuntimeStatusPanel({
  sessionId = null,
  docked = false
}: RuntimeStatusPanelProps): React.JSX.Element {
  const { t } = useTranslation('layout')
  const resolvedSessionId = useChatStore((state) => sessionId ?? state.activeSessionId)
  const context = useChatStore(
    useShallow((state) => {
      const activeSession = resolvedSessionId
        ? state.sessions.find((item) => item.id === resolvedSessionId)
        : null
      const project = activeSession?.projectId
        ? (state.projects.find((item) => item.id === activeSession.projectId) ?? null)
        : state.activeProjectId
          ? (state.projects.find((item) => item.id === state.activeProjectId) ?? null)
          : null
      const workingFolder = activeSession?.workingFolder ?? project?.workingFolder ?? null
      const sshConnectionId = activeSession?.sshConnectionId ?? project?.sshConnectionId ?? null

      return {
        sessionTitle: activeSession?.title ?? null,
        projectName: project?.name ?? null,
        workingFolder,
        sshConnectionId
      }
    })
  )
  const rightPanelOpen = useUIStore((state) => state.rightPanelOpen)
  const runtimeStatusPanelOpen = useUIStore((state) => state.runtimeStatusPanelOpen)
  const visible = Boolean(resolvedSessionId && runtimeStatusPanelOpen && !rightPanelOpen)
  const [sourceFiles, setSourceFiles] = React.useState(() =>
    resolvedSessionId
      ? (getCachedInputDraft(getSessionInputDraftKey(resolvedSessionId))?.selectedFiles ?? [])
      : []
  )
  React.useEffect(() => {
    const syncSourceFiles = (): void => {
      if (!resolvedSessionId) {
        setSourceFiles([])
        return
      }
      setSourceFiles(
        getCachedInputDraft(getSessionInputDraftKey(resolvedSessionId))?.selectedFiles ?? []
      )
    }

    syncSourceFiles()
    return subscribeInputDraftCache(syncSourceFiles)
  }, [resolvedSessionId])
  const sessionTasks = useTaskStore(
    useShallow((state) => {
      if (!resolvedSessionId) return EMPTY_TASKS
      if (state.currentSessionId === resolvedSessionId) return state.tasks
      return state.tasksBySession[resolvedSessionId] ?? EMPTY_TASKS
    })
  )
  const activeTeam = useTeamStore((state) => state.activeTeam)
  const sshConnectionName = useSshStore((state) =>
    context.sshConnectionId
      ? (state.connections.find((item) => item.id === context.sshConnectionId)?.name ?? null)
      : null
  )
  const gitSummary = useRuntimeGitSummary(context.workingFolder, context.sshConnectionId, visible)
  const initTerminals = useTerminalStore((state) => state.init)
  const refreshTerminalSessions = useTerminalStore((state) => state.refreshSessions)
  const closeTerminalSession = useTerminalStore((state) => state.closeSession)
  const runningTerminals = useTerminalStore(
    useShallow((state) =>
      Object.values(state.sessions)
        .filter((terminal) => terminal.status === 'running')
        .sort((a, b) => b.createdAt - a.createdAt)
    )
  )

  const teamTasks = React.useMemo(
    () => (activeTeam?.tasks ?? []).map(teamTaskToItem),
    [activeTeam?.tasks]
  )
  const tasks = sessionTasks.length > 0 ? sessionTasks : teamTasks
  React.useEffect(() => {
    initTerminals()
  }, [initTerminals])

  React.useEffect(() => {
    if (!visible) return
    void refreshTerminalSessions()
  }, [refreshTerminalSessions, visible])

  const targetLabel = context.sshConnectionId
    ? sshConnectionName
      ? t('runtimeStatus.sshNamed', { name: sshConnectionName })
      : t('runtimeStatus.ssh')
    : t('runtimeStatus.local')
  const branchLabel = gitSummary.branch
    ? [
        gitSummary.branch,
        gitSummary.ahead > 0 ? `↑${gitSummary.ahead}` : null,
        gitSummary.behind > 0 ? `↓${gitSummary.behind}` : null
      ]
        .filter(Boolean)
        .join(' ')
    : gitSummary.loading
      ? t('runtimeStatus.gitLoading')
      : gitSummary.error
        ? t('runtimeStatus.gitUnavailable')
        : t('runtimeStatus.unknownBranch')
  const changeLabel = gitSummary.loading ? (
    t('runtimeStatus.gitLoading')
  ) : gitSummary.error ? (
    t('runtimeStatus.gitUnavailable')
  ) : gitSummary.dirty ? (
    gitSummary.added !== null && gitSummary.deleted !== null ? (
      <span className="space-x-1 tabular-nums">
        <span className="text-emerald-500">+{gitSummary.added}</span>
        <span className="text-red-500">-{gitSummary.deleted}</span>
        {gitSummary.truncatedLineSummary ? (
          <span className="text-muted-foreground/55">...</span>
        ) : null}
      </span>
    ) : (
      t('runtimeStatus.changedFiles', { count: gitSummary.changedFileCount })
    )
  ) : (
    t('runtimeStatus.clean')
  )
  const syncLabel = gitSummary.loading
    ? t('runtimeStatus.gitLoading')
    : gitSummary.error
      ? t('runtimeStatus.gitUnavailable')
      : gitSummary.dirty
        ? t('runtimeStatus.commitPending')
        : gitSummary.ahead > 0
          ? t('runtimeStatus.pushPending')
          : gitSummary.behind > 0
            ? t('runtimeStatus.pullPending')
            : t('runtimeStatus.synced')
  const sourceLabel =
    sourceFiles.length === 0
      ? t('runtimeStatus.noSources')
      : sourceFiles.length <= 2
        ? sourceFiles.map((file) => file.name).join(', ')
        : t('runtimeStatus.sourcesSummary', {
            first: sourceFiles[0]?.name ?? '',
            second: sourceFiles[1]?.name ?? '',
            count: sourceFiles.length - 2
          })
  const sourceTitle = sourceFiles.map((file) => file.sendPath).join('\n')

  const panelBody = (
    <div className="space-y-3">
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            {t('runtimeStatus.contextTitle')}
          </h3>
          {gitSummary.loading ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground/60" />
          ) : null}
        </div>
        <div className="space-y-1.5">
          <ContextRow
            icon={<GitCompare className="size-3.5" />}
            label={t('runtimeStatus.changes')}
            value={changeLabel}
          />
          <ContextRow
            icon={
              context.sshConnectionId ? (
                <Server className="size-3.5" />
              ) : (
                <Laptop className="size-3.5" />
              )
            }
            label={t('runtimeStatus.target')}
            value={targetLabel}
          />
          <ContextRow
            icon={<Folder className="size-3.5" />}
            label={t('runtimeStatus.workingFolder')}
            value={
              context.workingFolder
                ? compactPath(context.workingFolder)
                : t('runtimeStatus.noWorkingFolder')
            }
            title={context.workingFolder ?? undefined}
          />
          <ContextRow
            icon={<GitBranch className="size-3.5" />}
            label={t('runtimeStatus.branch')}
            value={branchLabel}
          />
          <ContextRow
            icon={<GitCompare className="size-3.5" />}
            label={t('runtimeStatus.commitOrPush')}
            value={syncLabel}
          />
          <ContextRow
            icon={<Folder className="size-3.5" />}
            label={t('runtimeStatus.sources')}
            value={sourceLabel}
            title={sourceTitle || undefined}
            valueClassName={sourceFiles.length === 0 ? 'text-muted-foreground/70' : undefined}
          />
        </div>
      </section>

      <div className="h-px bg-border/70" />

      <section className="space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <ListChecks className="size-3.5" />
          <span>{t('runtimeStatus.progressTitle')}</span>
        </div>
        {tasks.length > 0 ? (
          <TodoStatusList tasks={tasks} embedded />
        ) : (
          <div className="rounded-md border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground/65">
            {t('runtimeStatus.noTasks')}
          </div>
        )}
      </section>

      {runningTerminals.length > 0 ? (
        <>
          <div className="h-px bg-border/70" />
          <section className="space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <SquareTerminal className="size-3.5" />
              <span>{t('runtimeStatus.runningTerminals')}</span>
              <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-300">
                {runningTerminals.length}
              </span>
            </div>
            <div className="space-y-1.5">
              {runningTerminals.map((terminal) => (
                <RunningTerminalRow
                  key={terminal.id}
                  terminal={terminal}
                  closeTitle={t('runtimeStatus.closeTerminal')}
                  onClose={(id) => void closeTerminalSession(id)}
                />
              ))}
            </div>
          </section>
        </>
      ) : null}
    </div>
  )

  if (docked) {
    return (
      <AnimatePresence initial={false}>
        {visible ? (
          <motion.aside
            key="runtime-status-panel-docked"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: DOCKED_PANEL_TRACK_WIDTH, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="relative z-30 min-h-0 shrink-0 self-stretch overflow-hidden"
          >
            <div
              className="flex h-full flex-col items-end py-3 pr-3"
              style={{ width: DOCKED_PANEL_TRACK_WIDTH }}
            >
              <div className="min-h-0 w-full overflow-y-auto rounded-lg border border-border/70 bg-background/95 p-3 shadow-[-8px_10px_34px_rgba(0,0,0,0.22)] backdrop-blur-xl">
                {panelBody}
              </div>
            </div>
          </motion.aside>
        ) : null}
      </AnimatePresence>
    )
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      <AnimatePresence initial={false}>
        {visible ? (
          <motion.aside
            key="runtime-status-panel"
            initial={{ opacity: 0, y: -8, scale: 0.98, filter: 'blur(4px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -8, scale: 0.98, filter: 'blur(4px)' }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-auto absolute right-3 top-12 max-h-[min(420px,calc(100%-4rem))] w-[min(320px,calc(100%-1.5rem))] overflow-y-auto rounded-lg border border-border/70 bg-background/95 p-3 shadow-[-8px_10px_34px_rgba(0,0,0,0.22)] backdrop-blur-xl"
            style={{ transformOrigin: 'top right' }}
          >
            {panelBody}
          </motion.aside>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
