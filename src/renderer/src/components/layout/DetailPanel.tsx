import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  X,
  FileText,
  FileCode,
  Users,
  Bot,
  Terminal,
  Clock,
  ChevronDown,
  ChevronRight,
  Wrench,
  History
} from 'lucide-react'
import { useUIStore } from '@renderer/stores/ui-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useTeamStore, type ActiveTeam } from '@renderer/stores/team-store'
import { useAgentStore, type SubAgentState } from '@renderer/stores/agent-store'
import { TeamPanel } from '@renderer/components/cowork/TeamPanel'
import { ToolCallCard } from '@renderer/components/chat/ToolCallCard'
import { BrowserToolCard } from '@renderer/components/chat/BrowserToolCard'
import { TranscriptMessageList } from '@renderer/components/chat/TranscriptMessageList'
import { Separator } from '@renderer/components/ui/separator'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { SubAgentExecutionDetail } from './SubAgentExecutionDetail'
import { ChangeReviewPanelContent } from '@renderer/components/chat/ChangeReviewSheet'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@renderer/components/ui/collapsible'
import { cn } from '@renderer/lib/utils'
import Markdown from 'react-markdown'
import { AnimatePresence, motion } from 'motion/react'
import { FadeIn } from '@renderer/components/animate-ui'
import {
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS
} from '@renderer/lib/preview/viewers/markdown-components'
import {
  findSubAgentInSelection,
  selectSessionScopedAgentState,
  type SessionScopedAgentSelection
} from '@renderer/lib/agent/session-scoped-agent-state'
import { isBrowserToolName } from '@renderer/lib/app-plugin/browser-tool-names'

const LocalTerminal = React.lazy(() =>
  import('@renderer/components/terminal/LocalTerminal').then((m) => ({ default: m.LocalTerminal }))
)

// ── Helpers ──────────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  return `${Math.floor(secs / 60)}m${Math.round(secs % 60)}s`
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString()
}

// ── Team History View ────────────────────────────────────────────

function TeamHistoryItem({
  team,
  isExpanded,
  onToggle
}: {
  team: ActiveTeam
  isExpanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const completedTasks = team.tasks.filter((task) => task.status === 'completed').length
  return (
    <div className="rounded-lg border border-muted overflow-hidden">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/30 transition-colors"
      >
        <Users className="size-3.5 text-cyan-500 shrink-0" />
        <span className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 truncate flex-1">
          {team.name}
        </span>
        <span className="text-[9px] text-muted-foreground/50">
          {t('detailPanel.membersCount', { count: team.members.length })}
        </span>
        <span className="text-[9px] text-muted-foreground/50">
          {t('detailPanel.tasksCount', { completed: completedTasks, total: team.tasks.length })}
        </span>
        <span className="text-[9px] text-muted-foreground/40">{formatDate(team.createdAt)}</span>
        {isExpanded ? (
          <ChevronDown className="size-3 text-muted-foreground/40" />
        ) : (
          <ChevronRight className="size-3 text-muted-foreground/40" />
        )}
      </button>
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="border-t border-muted px-3 py-2 space-y-2 overflow-hidden"
          >
            <p className="text-[10px] text-muted-foreground/60">{team.description}</p>

            {/* Members summary */}
            {team.members.length > 0 && (
              <div>
                <span className="text-[9px] font-medium text-muted-foreground/50 uppercase tracking-wider">
                  {t('detailPanel.membersLabel')}
                </span>
                <div className="mt-1 space-y-1">
                  {team.members.map((m) => (
                    <div key={m.id} className="flex items-center gap-2 text-[10px]">
                      <span
                        className={cn(
                          'size-1.5 rounded-full shrink-0',
                          m.status === 'working'
                            ? 'bg-green-500 animate-pulse'
                            : m.status === 'stopped'
                              ? 'bg-muted-foreground/30'
                              : 'bg-cyan-400'
                        )}
                      />
                      <span className="font-medium text-cyan-600 dark:text-cyan-400">{m.name}</span>
                      <span className="text-muted-foreground/40">{m.toolCalls.length} calls</span>
                      <span className="text-muted-foreground/40">{m.iteration} iters</span>
                      {m.completedAt && m.startedAt && (
                        <span className="text-muted-foreground/30">
                          {formatElapsed(m.completedAt - m.startedAt)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Tasks summary */}
            {team.tasks.length > 0 && (
              <div>
                <span className="text-[9px] font-medium text-muted-foreground/50 uppercase tracking-wider">
                  {t('detailPanel.tasksLabel')}
                </span>
                <div className="mt-1 space-y-0.5">
                  {team.tasks.map((task) => (
                    <div key={task.id} className="flex items-center gap-1.5 text-[10px]">
                      <Badge
                        variant="secondary"
                        className={cn(
                          'text-[7px] h-3 px-1',
                          task.status === 'completed'
                            ? 'bg-green-500/15 text-green-500'
                            : task.status === 'in_progress'
                              ? 'bg-blue-500/15 text-blue-500'
                              : 'bg-muted text-muted-foreground/60'
                        )}
                      >
                        {task.status === 'completed'
                          ? t('status.done', { ns: 'common' })
                          : task.status === 'in_progress'
                            ? t('status.active', { ns: 'common' })
                            : t('status.pending', { ns: 'common' })}
                      </Badge>
                      <span className="truncate text-muted-foreground/70">{task.subject}</span>
                      {task.owner && (
                        <span className="text-cyan-500/50 shrink-0">{task.owner}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Messages count */}
            {team.messages.length > 0 && (
              <span className="text-[9px] text-muted-foreground/40">
                {t('detailPanel.messagesExchanged', { count: team.messages.length })}
              </span>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function TeamDetailView(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const teamHistory = useTeamStore((s) => s.teamHistory)
  const [expandedIdx, setExpandedIdx] = React.useState<number | null>(null)

  return (
    <div className="space-y-3">
      {/* Active team */}
      <TeamPanel />

      {/* History */}
      {teamHistory.length > 0 && (
        <>
          <Separator />
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <History className="size-3 text-muted-foreground/50" />
              <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider">
                {t('detailPanel.history')}
              </span>
              <Badge variant="secondary" className="text-[8px] h-3.5 px-1">
                {teamHistory.length}
              </Badge>
            </div>
            <div className="space-y-1.5">
              {teamHistory
                .slice()
                .reverse()
                .map((team, i) => (
                  <TeamHistoryItem
                    key={`${team.name}-${team.createdAt}`}
                    team={team}
                    isExpanded={expandedIdx === i}
                    onToggle={() => setExpandedIdx(expandedIdx === i ? null : i)}
                  />
                ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ── SubAgent Detail View ─────────────────────────────────────────

function getSubAgentStatus(agent: SubAgentState): 'running' | 'failed' | 'completed' {
  if (agent.isRunning) return 'running'
  if (agent.success === false) return 'failed'
  return 'completed'
}

function getSubAgentSummary(agent: SubAgentState, inlineText?: string): string {
  const source = agent.report.trim() || agent.streamingText.trim() || inlineText?.trim() || ''
  if (!source) return ''
  return source
    .replace(/[#>*`-]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function findSubAgentRecord(
  toolUseId: string | undefined,
  selection: SessionScopedAgentSelection
): SubAgentState | null {
  if (toolUseId) {
    return findSubAgentInSelection(selection, toolUseId)
  }

  const candidates = [
    ...Object.values(selection.activeSubAgents),
    ...Object.values(selection.completedSubAgents),
    ...selection.subAgentHistory
  ]

  if (!candidates.length) return null
  return candidates.sort((left, right) => {
    const leftTime = left.completedAt ?? left.startedAt
    const rightTime = right.completedAt ?? right.startedAt
    return rightTime - leftTime
  })[0]
}

export function SubAgentExecutionDetailContent({
  toolUseId,
  inlineText,
  embedded = false
}: {
  toolUseId?: string
  inlineText?: string
  embedded?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const sessionAgentSelection = useAgentStore((s) =>
    selectSessionScopedAgentState(s, activeSessionId)
  )
  const [toolsOpen, setToolsOpen] = React.useState(false)
  const [now, setNow] = React.useState(() => Date.now())

  const agent = React.useMemo(
    () => findSubAgentRecord(toolUseId, sessionAgentSelection),
    [toolUseId, sessionAgentSelection]
  )

  React.useEffect(() => {
    if (!agent?.isRunning) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [agent?.isRunning])

  if (!agent) {
    return (
      <div className="flex h-full flex-col items-center justify-center py-12 text-center">
        <Bot className="mb-3 size-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">{t('detailPanel.noSubAgentRecords')}</p>
        <p className="mt-1 text-xs text-muted-foreground/60">{t('detailPanel.subAgentActivity')}</p>
      </div>
    )
  }

  const status = getSubAgentStatus(agent)
  const statusLabel =
    agent.endReason === 'max_iterations'
      ? t('subAgentsPanel.maxIterations', { defaultValue: 'Iteration limit reached' })
      : agent.endReason === 'aborted'
        ? t('subAgentsPanel.aborted', { defaultValue: 'Aborted' })
        : status === 'running'
          ? t('subAgentsPanel.running', { defaultValue: 'Running' })
          : status === 'failed'
            ? t('status.failed', { ns: 'common', defaultValue: 'Failed' })
            : t('subAgentsPanel.completed', { defaultValue: 'Completed' })
  const elapsed = formatElapsed((agent.completedAt ?? now) - agent.startedAt)
  const summary = getSubAgentSummary(agent, inlineText)
  const taskSummary = [agent.description.trim(), agent.prompt.trim()].filter(Boolean).join('\n\n')

  return (
    <div className={cn('flex h-full min-h-0 flex-col', !embedded && 'bg-background')}>
      <div className="border-b border-border/60 px-5 py-4 sm:px-6">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground/55">
              {t('subAgentsPanel.execution', { defaultValue: 'Execution process' })}
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="min-w-0 truncate text-lg font-semibold text-foreground">
                {agent.displayName ?? agent.name}
              </h2>
              <Badge
                variant={
                  status === 'failed'
                    ? 'destructive'
                    : status === 'running'
                      ? 'default'
                      : 'secondary'
                }
                className={cn(
                  status === 'running' && 'bg-violet-500 text-white',
                  status === 'completed' &&
                    'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
                )}
              >
                {statusLabel}
              </Badge>
              <span className="flex items-center gap-1 text-xs text-muted-foreground/70">
                <Clock className="size-3.5" />
                {elapsed}
              </span>
            </div>
            {(agent.description || agent.prompt) && (
              <p className="mt-2 max-w-3xl whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground/80">
                {agent.description || agent.prompt}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground/70">
            <Badge variant="outline" className="border-border/60 bg-background/70">
              {t('detailPanel.iterations', { count: agent.iteration })}
            </Badge>
            <Badge variant="outline" className="border-border/60 bg-background/70">
              {t('detailPanel.toolCalls', { count: agent.toolCalls.length })}
            </Badge>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 px-5 py-5 sm:px-6 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1 space-y-5">
            <section className="rounded-2xl border border-border/60 bg-background/80 p-4 sm:p-5">
              <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground/60">
                <FileText className="size-3.5" />
                <span>{t('subAgentsPanel.report', { defaultValue: 'Final results' })}</span>
              </div>
              {agent.report.trim() ? (
                <div className="prose prose-sm max-w-none prose-headings:text-foreground prose-p:text-foreground/90 prose-li:text-foreground/90 prose-strong:text-foreground dark:prose-invert">
                  <Markdown
                    remarkPlugins={MARKDOWN_REMARK_PLUGINS}
                    rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
                  >
                    {agent.report}
                  </Markdown>
                </div>
              ) : summary ? (
                <div className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground/85">
                  {summary}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground/70">
                  {agent.reportStatus === 'retrying'
                    ? t('subAgentsPanel.reportStatusRetrying', { defaultValue: 'Recovering' })
                    : agent.reportStatus === 'missing'
                      ? t('subAgentsPanel.reportMissing', {
                          defaultValue: 'No final result captured.'
                        })
                      : t('subAgentsPanel.reportPending', {
                          defaultValue: 'Current SubAgent has not produced final results.'
                        })}
                </div>
              )}
            </section>

            {agent.success === false && agent.errorMessage ? (
              <section className="rounded-2xl border border-destructive/35 bg-destructive/5 p-4 sm:p-5">
                <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-destructive/80">
                  {t('status.failed', { ns: 'common', defaultValue: 'Failed' })}
                </div>
                <div className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground/85">
                  {agent.errorMessage}
                </div>
              </section>
            ) : null}

            <section className="rounded-2xl border border-border/60 bg-background/80 p-4 sm:p-5">
              <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground/60">
                <Bot className="size-3.5" />
                <span>{t('subAgentsPanel.execution', { defaultValue: 'Execution process' })}</span>
                {agent.isRunning ? (
                  <Clock className="size-3 animate-pulse text-violet-500" />
                ) : null}
              </div>
              <div className="min-w-0 prose prose-sm max-w-none prose-headings:text-foreground prose-p:text-foreground/90 prose-li:text-foreground/90 prose-strong:text-foreground dark:prose-invert">
                <TranscriptMessageList
                  messages={agent.transcript}
                  streamingMessageId={agent.currentAssistantMessageId}
                />
              </div>
            </section>

            <Collapsible open={toolsOpen} onOpenChange={setToolsOpen}>
              <section className="rounded-2xl border border-border/60 bg-background/80 p-4 sm:p-5">
                <CollapsibleTrigger asChild>
                  <button className="flex w-full items-center gap-2 text-left">
                    <Wrench className="size-3.5 text-muted-foreground/70" />
                    <span className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground/60">
                      {t('detailPanel.toolCallsLabel')}
                    </span>
                    <Badge variant="outline" className="border-border/60 bg-background/70 text-xs">
                      {agent.toolCalls.length}
                    </Badge>
                    <span className="flex-1" />
                    {toolsOpen ? (
                      <ChevronDown className="size-4 text-muted-foreground/60" />
                    ) : (
                      <ChevronRight className="size-4 text-muted-foreground/60" />
                    )}
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-4 space-y-2">
                    {agent.toolCalls.length > 0 ? (
                      agent.toolCalls.map((tc) =>
                        isBrowserToolName(tc.name) ? (
                          <BrowserToolCard
                            key={tc.id}
                            name={tc.name}
                            input={tc.input}
                            output={tc.output}
                            status={tc.status}
                            error={tc.error}
                          />
                        ) : (
                          <ToolCallCard
                            key={tc.id}
                            toolUseId={tc.id}
                            name={tc.name}
                            input={tc.input}
                            output={tc.output}
                            status={tc.status}
                            error={tc.error}
                            startedAt={tc.startedAt}
                            completedAt={tc.completedAt}
                          />
                        )
                      )
                    ) : (
                      <div className="text-sm text-muted-foreground/70">
                        {t('detailPanel.toolCalls', { count: 0 })}
                      </div>
                    )}
                  </div>
                </CollapsibleContent>
              </section>
            </Collapsible>
          </div>

          <aside className="w-full shrink-0 space-y-4 lg:sticky lg:top-0 lg:w-[320px]">
            <section className="rounded-2xl border border-border/60 bg-background/80 p-4">
              <div className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground/60">
                {t('detailPanel.details', { defaultValue: 'Details' })}
              </div>
              <div className="space-y-3 text-sm">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/55">
                    {t('subAgentsPanel.running', { defaultValue: 'Status' })}
                  </div>
                  <div className="mt-1 text-foreground/85">{statusLabel}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/55">
                    {t('detailPanel.iterations', { count: 0 }).split('：')[0]}
                  </div>
                  <div className="mt-1 text-foreground/85">{agent.iteration}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/55">
                    {t('detailPanel.toolCalls', { count: 0 }).split('：')[0]}
                  </div>
                  <div className="mt-1 text-foreground/85">{agent.toolCalls.length}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/55">
                    {t('layout.createdAt', { defaultValue: 'Start time' })}
                  </div>
                  <div className="mt-1 text-foreground/85">{formatDate(agent.startedAt)}</div>
                </div>
                {agent.completedAt ? (
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/55">
                      {t('layout.updatedAt', { defaultValue: 'End time' })}
                    </div>
                    <div className="mt-1 text-foreground/85">{formatDate(agent.completedAt)}</div>
                  </div>
                ) : null}
              </div>
            </section>

            {(agent.description || agent.prompt || taskSummary) && (
              <section className="rounded-2xl border border-border/60 bg-background/80 p-4">
                <div className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground/60">
                  {t('subAgentsPanel.taskInput', { defaultValue: 'Task input' })}
                </div>
                <div className="space-y-3 text-sm leading-6 text-foreground/85">
                  {agent.description ? (
                    <div>
                      <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground/55">
                        {t('subAgentsPanel.description', { defaultValue: 'Description' })}
                      </div>
                      <div className="whitespace-pre-wrap break-words">{agent.description}</div>
                    </div>
                  ) : null}
                  {agent.prompt ? (
                    <div>
                      <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground/55">
                        {t('subAgentsPanel.prompt', { defaultValue: 'Prompt' })}
                      </div>
                      <div className="whitespace-pre-wrap break-words">{agent.prompt}</div>
                    </div>
                  ) : null}
                </div>
              </section>
            )}
          </aside>
        </div>
      </div>
    </div>
  )
}

function SubAgentDetailView({
  toolUseId,
  inlineText
}: {
  toolUseId?: string
  inlineText?: string
}): React.JSX.Element {
  return <SubAgentExecutionDetail toolUseId={toolUseId} inlineText={inlineText} embedded />
}

function TerminalDetailView({ processId }: { processId: string }): React.JSX.Element {
  const { t } = useTranslation('layout')
  const process = useAgentStore((s) => s.backgroundProcesses[processId])
  const sendBackgroundProcessInput = useAgentStore((s) => s.sendBackgroundProcessInput)
  const stopBackgroundProcess = useAgentStore((s) => s.stopBackgroundProcess)

  if (!process) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Terminal className="mb-3 size-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">{t('detailPanel.terminalNotFound')}</p>
      </div>
    )
  }

  const isRunning = process.status === 'running'
  const statusText =
    process.status === 'running'
      ? t('detailPanel.running')
      : process.status === 'stopped'
        ? t('detailPanel.stopped')
        : process.status === 'error'
          ? t('detailPanel.error')
          : t('detailPanel.exited')

  return (
    <div className="space-y-3">
      <div className="space-y-1 rounded-lg border border-muted p-3">
        <div className="flex items-center gap-2">
          <Badge
            variant={isRunning ? 'default' : 'secondary'}
            className={cn('text-[10px]', isRunning && 'bg-emerald-500')}
          >
            {statusText}
          </Badge>
          <span className="text-[11px] text-muted-foreground">
            {t('detailPanel.processId')}: {process.id}
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          {t('detailPanel.command')}: <span className="font-mono">{process.command}</span>
        </div>
        {process.cwd && (
          <div className="text-xs text-muted-foreground">
            {t('detailPanel.workingDirectory')}: <span className="font-mono">{process.cwd}</span>
          </div>
        )}
      </div>

      {process.terminalId ? (
        <div className="h-[360px] overflow-hidden rounded-lg border bg-background">
          <React.Suspense fallback={null}>
            <LocalTerminal terminalId={process.terminalId} readOnly={!isRunning} />
          </React.Suspense>
        </div>
      ) : (
        <div className="h-[360px] overflow-auto rounded-lg border bg-zinc-950 px-3 py-2 text-[11px] font-mono text-zinc-200 whitespace-pre-wrap break-words">
          {process.output || '[no output yet]'}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={!isRunning}
          onClick={() => void sendBackgroundProcessInput(processId, '\u0003', false)}
        >
          {t('detailPanel.sendCtrlC')}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          className="h-7 text-xs"
          disabled={!isRunning}
          onClick={() => void stopBackgroundProcess(processId)}
        >
          {t('detailPanel.stopProcess')}
        </Button>
      </div>
    </div>
  )
}

// ── Main DetailPanel ─────────────────────────────────────────────

export function DetailPanel({ embedded = false }: { embedded?: boolean }): React.JSX.Element {
  const { t } = useTranslation(['layout', 'chat'])
  const content = useUIStore((s) => s.detailPanelContent)
  const closeDetailPanel = useUIStore((s) => s.closeDetailPanel)

  const title =
    content?.type === 'team'
      ? t('detailPanel.team')
      : content?.type === 'subagent'
        ? t('detailPanel.subAgent')
        : content?.type === 'terminal'
          ? t('detailPanel.terminal')
          : content?.type === 'change-review'
            ? t('fileChange.reviewPanelTitle', { ns: 'chat', defaultValue: 'Change review' })
            : content?.type === 'document'
              ? content.title
              : content?.type === 'report'
                ? content.title
                : t('detailPanel.details')

  const icon =
    content?.type === 'team' ? (
      <Users className="size-4 text-cyan-500" />
    ) : content?.type === 'subagent' ? (
      <Bot className="size-4 text-violet-500" />
    ) : content?.type === 'terminal' ? (
      <Terminal className="size-4 text-emerald-500" />
    ) : content?.type === 'change-review' ? (
      <FileCode className="size-4 text-sky-400" />
    ) : (
      <FileText className="size-4 text-muted-foreground" />
    )

  return (
    <aside
      className={cn(
        'flex shrink-0 flex-col bg-background/50 backdrop-blur-sm',
        embedded ? 'h-full w-full' : 'w-[480px] border-l'
      )}
    >
      {/* Header */}
      <div className="flex h-10 items-center gap-2 px-3">
        {icon}
        <span className="text-sm font-medium flex-1 truncate">{title}</span>
        <button
          onClick={closeDetailPanel}
          className="rounded-md p-1 text-muted-foreground/50 hover:text-foreground hover:bg-muted/50 transition-colors"
          title={t('detailPanel.closePanel')}
        >
          <X className="size-4" />
        </button>
      </div>
      <Separator />

      {/* Content */}
      <div
        className={cn(
          'min-h-0 flex-1 overflow-auto',
          content?.type === 'change-review' ? 'p-0' : 'p-3'
        )}
      >
        <AnimatePresence mode="wait">
          {content?.type === 'team' && (
            <FadeIn key="team" className="h-full">
              <TeamDetailView />
            </FadeIn>
          )}

          {content?.type === 'subagent' && (
            <FadeIn key="subagent" className="h-full">
              <SubAgentDetailView toolUseId={content.toolUseId} inlineText={content.text} />
            </FadeIn>
          )}

          {content?.type === 'terminal' && (
            <FadeIn key="terminal" className="h-full">
              <TerminalDetailView processId={content.processId} />
            </FadeIn>
          )}

          {content?.type === 'change-review' && (
            <FadeIn key="change-review" className="h-full">
              <ChangeReviewPanelContent
                runId={content.runId}
                initialChangeId={content.initialChangeId}
              />
            </FadeIn>
          )}

          {content?.type === 'document' && (
            <FadeIn key="document" className="h-full">
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <Markdown
                  remarkPlugins={MARKDOWN_REMARK_PLUGINS}
                  rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
                >
                  {content.content}
                </Markdown>
              </div>
            </FadeIn>
          )}

          {content?.type === 'report' && (
            <FadeIn key="report" className="h-full">
              <div className="space-y-3">
                <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-words">
                  {JSON.stringify(content.data, null, 2)}
                </pre>
              </div>
            </FadeIn>
          )}

          {!content && (
            <FadeIn
              key="empty"
              className="h-full flex flex-col items-center justify-center py-12 text-center"
            >
              <FileText className="mb-3 size-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">{t('detailPanel.noContent')}</p>
            </FadeIn>
          )}
        </AnimatePresence>
      </div>
    </aside>
  )
}
