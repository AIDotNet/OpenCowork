import { useMemo } from 'react'
import { Bot, MessagesSquare, ScrollText, Users } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore } from '@renderer/stores/chat-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useTeamStore } from '@renderer/stores/team-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { buildOrchestrationRuns } from '@renderer/lib/orchestration/build-runs'
import { OrchestrationStagePills } from '@renderer/components/chat/OrchestrationStagePills'
import { TranscriptMessageList } from '@renderer/components/chat/TranscriptMessageList'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { cn } from '@renderer/lib/utils'

export function OrchestrationConsole(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const messages = useChatStore((s) =>
    activeSessionId ? s.getSessionMessages(activeSessionId) : []
  )
  const { activeSubAgents, completedSubAgents, subAgentHistory } = useAgentStore(
    useShallow((s) => ({
      activeSubAgents: s.activeSubAgents,
      completedSubAgents: s.completedSubAgents,
      subAgentHistory: s.subAgentHistory
    }))
  )
  const { activeTeam, teamHistory } = useTeamStore(
    useShallow((s) => ({ activeTeam: s.activeTeam, teamHistory: s.teamHistory }))
  )
  const {
    selectedOrchestrationRunId,
    selectedOrchestrationMemberId,
    orchestrationConsoleView,
    setSelectedOrchestrationMemberId,
    setOrchestrationConsoleView
  } = useUIStore(
    useShallow((s) => ({
      selectedOrchestrationRunId: s.selectedOrchestrationRunId,
      selectedOrchestrationMemberId: s.selectedOrchestrationMemberId,
      orchestrationConsoleView: s.orchestrationConsoleView,
      setSelectedOrchestrationMemberId: s.setSelectedOrchestrationMemberId,
      setOrchestrationConsoleView: s.setOrchestrationConsoleView
    }))
  )

  const orchestrationState = useMemo(
    () =>
      buildOrchestrationRuns({
        sessionId: activeSessionId,
        messages,
        activeSubAgents,
        completedSubAgents,
        subAgentHistory,
        activeTeam,
        teamHistory
      }),
    [
      activeSessionId,
      messages,
      activeSubAgents,
      completedSubAgents,
      subAgentHistory,
      activeTeam,
      teamHistory
    ]
  )

  const run =
    (selectedOrchestrationRunId ? orchestrationState.byId.get(selectedOrchestrationRunId) : null) ??
    orchestrationState.runs[0] ??
    null
  const selectedMember =
    run?.members.find((member) => member.id === selectedOrchestrationMemberId) ??
    run?.members[0] ??
    null

  if (!run) {
    return (
      <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-border/60 bg-background/40 text-sm text-muted-foreground">
        {t('rightPanel.orchestrationEmpty', { defaultValue: '暂无协作编排记录' })}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border/60 bg-background/40">
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex size-10 items-center justify-center rounded-xl border border-border/60 bg-muted/25 text-foreground/85">
            {run.kind === 'team' ? <Users className="size-4.5" /> : <Bot className="size-4.5" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-base font-semibold text-foreground/92">{run.title}</h2>
              <span className="rounded-full border border-border/60 bg-background/70 px-2 py-0.5 text-[10px] text-muted-foreground/70">
                {t('rightPanel.orchestrationProgress', {
                  defaultValue: '当前进度 {{current}}/{{total}}',
                  current: run.stageIndex + 1,
                  total: run.stageCount
                })}
              </span>
            </div>
            <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-sm text-muted-foreground/75">
              {run.summary || run.latestAction}
            </p>
          </div>
        </div>
        <div className="mt-3">
          <OrchestrationStagePills stages={run.stages} />
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {(['overview', 'member', 'tasks'] as const).map((view) => (
            <button
              key={view}
              type="button"
              onClick={() => setOrchestrationConsoleView(view)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors',
                orchestrationConsoleView === view
                  ? 'border-foreground/15 bg-foreground/8 text-foreground'
                  : 'border-border/60 bg-background/70 text-muted-foreground/70'
              )}
            >
              {view === 'overview'
                ? t('rightPanel.orchestrationViewOverview', { defaultValue: '总览' })
                : view === 'member'
                  ? t('rightPanel.orchestrationViewMember', { defaultValue: '成员轨迹' })
                  : t('rightPanel.orchestrationViewTasks', { defaultValue: '任务' })}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="grid h-full min-h-0 grid-rows-[1fr_auto]">
          <div className="min-h-0 overflow-y-auto px-4 py-4">
            {orchestrationConsoleView === 'tasks' ? (
              <div className="space-y-3">
                {run.tasks.length > 0 ? (
                  run.tasks.map((task) => (
                    <div
                      key={task.id}
                      className="rounded-xl border border-border/60 bg-background/70 p-3"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground/90">
                          {task.subject}
                        </span>
                        <span className="rounded-full border border-border/60 bg-background/70 px-1.5 py-0.5 text-[9px] text-muted-foreground/70">
                          {task.status}
                        </span>
                      </div>
                      {task.description ? (
                        <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground/75">
                          {task.description}
                        </p>
                      ) : null}
                      {task.report ? (
                        <div className="prose prose-sm mt-3 max-w-none dark:prose-invert">
                          <Markdown remarkPlugins={[remarkGfm]}>{task.report}</Markdown>
                        </div>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <div className="rounded-xl border border-dashed border-border/60 bg-background/60 p-4 text-sm text-muted-foreground">
                    {t('rightPanel.orchestrationTasksEmpty', {
                      defaultValue: '当前 run 没有独立任务列表'
                    })}
                  </div>
                )}
              </div>
            ) : orchestrationConsoleView === 'overview' ? (
              <div className="space-y-3">
                {run.messages.length > 0 && (
                  <section className="rounded-xl border border-border/60 bg-background/70 p-3">
                    <div className="mb-3 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/65">
                      <MessagesSquare className="size-3.5" />
                      <span>
                        {t('rightPanel.orchestrationTeamMessages', { defaultValue: '团队消息' })}
                      </span>
                    </div>
                    <div className="space-y-2">
                      {run.messages.slice(-8).map((message) => (
                        <div
                          key={message.id}
                          className="rounded-lg border border-border/60 bg-background/70 px-3 py-2"
                        >
                          <div className="text-[10px] text-muted-foreground/65">
                            {message.from} → {message.to}
                          </div>
                          <div className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground/88">
                            {message.summary || message.content}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
                <section className="rounded-xl border border-border/60 bg-background/70 p-3">
                  <div className="mb-3 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/65">
                    <Users className="size-3.5" />
                    <span>
                      {t('rightPanel.orchestrationMemberSummary', { defaultValue: '成员摘要' })}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {run.members.map((member, index) => (
                      <button
                        key={member.id}
                        type="button"
                        onClick={() => {
                          setSelectedOrchestrationMemberId(member.id)
                          setOrchestrationConsoleView('member')
                        }}
                        className="flex w-full items-center gap-3 rounded-xl border border-border/60 bg-background/70 px-3 py-2 text-left transition-colors hover:bg-muted/30"
                      >
                        <div className="flex size-8 items-center justify-center rounded-full border border-border/60 bg-muted/30 text-[11px] font-semibold text-foreground/85">
                          {String(index + 1).padStart(2, '0')}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-foreground/9">
                            {member.name}
                          </div>
                          <div className="truncate text-[11px] text-muted-foreground/70">
                            {member.latestAction || member.summary}
                          </div>
                        </div>
                        <div className="text-[10px] text-muted-foreground/65">
                          {t('rightPanel.orchestrationToolCallCount', {
                            defaultValue: '{{count}} calls',
                            count: member.toolCallCount
                          })}
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              </div>
            ) : selectedMember ? (
              <div className="space-y-4">
                <section className="rounded-xl border border-border/60 bg-background/70 p-3">
                  <div className="flex items-center gap-2">
                    <div className="text-sm font-semibold text-foreground/92">
                      {selectedMember.name}
                    </div>
                    <span className="rounded-full border border-border/60 bg-background/70 px-1.5 py-0.5 text-[9px] text-muted-foreground/70">
                      {selectedMember.status}
                    </span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground/75">
                    {selectedMember.summary ||
                      selectedMember.latestAction ||
                      t('rightPanel.orchestrationNoSummary', { defaultValue: '暂无摘要' })}
                  </p>
                </section>

                {selectedMember.transcript.length > 0 && (
                  <section className="rounded-xl border border-border/60 bg-background/70 p-3">
                    <div className="mb-3 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/65">
                      <MessagesSquare className="size-3.5" />
                      <span>
                        {t('rightPanel.orchestrationTranscript', { defaultValue: '轨迹' })}
                      </span>
                    </div>
                    <TranscriptMessageList messages={selectedMember.transcript} />
                  </section>
                )}
              </div>
            ) : null}
          </div>

          <div className="border-t border-border/60 px-4 py-3">
            <div className="flex gap-2 overflow-x-auto pb-1">
              {run.members.map((member, index) => {
                const hoverPromptText = (member.prompt || member.description || '').trim()
                const hoverSummaryText = (member.summary || member.latestAction || '').trim()
                const hasHoverContent = !!hoverPromptText || !!hoverSummaryText
                const memberButton = (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedOrchestrationMemberId(member.id)
                      setOrchestrationConsoleView('member')
                    }}
                    className={cn(
                      'min-w-[112px] rounded-2xl border px-3 py-2 text-left transition-colors',
                      selectedMember?.id === member.id
                        ? 'border-foreground/20 bg-foreground/8'
                        : 'border-border/60 bg-background/70 hover:bg-muted/30'
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-foreground/90">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span className="text-[10px] text-muted-foreground/65">{member.status}</span>
                    </div>
                    <div className="mt-2 truncate text-sm text-foreground/88">{member.name}</div>
                  </button>
                )
                if (!hasHoverContent) {
                  return <div key={member.id}>{memberButton}</div>
                }
                return (
                  <HoverCard key={member.id} openDelay={120} closeDelay={80}>
                    <HoverCardTrigger asChild>{memberButton}</HoverCardTrigger>
                    <HoverCardContent
                      side="top"
                      align="start"
                      className="w-[min(28rem,calc(100vw-3rem))] border-border/60 bg-background/98 p-0 text-foreground shadow-2xl backdrop-blur"
                    >
                      <div className="space-y-3 p-3">
                        <div className="flex items-center gap-2 border-b border-border/60 pb-2.5">
                          <div className="flex size-7 items-center justify-center rounded-full border border-border/60 bg-muted/30 text-foreground/85">
                            <Bot className="size-3.5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-foreground/92">
                              {member.name}
                            </div>
                            <div className="mt-0.5 text-[10px] text-muted-foreground/65">
                              {member.status}
                            </div>
                          </div>
                        </div>
                        {hoverPromptText ? (
                          <section className="space-y-1.5">
                            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground/60">
                              <ScrollText className="size-3" />
                              <span>
                                {t('subAgentsPanel.promptLabel', { defaultValue: 'Prompt' })}
                              </span>
                            </div>
                            <div className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-muted/15 px-2.5 py-2 text-[12px] leading-5 text-foreground/85">
                              {hoverPromptText}
                            </div>
                          </section>
                        ) : null}
                        {hoverSummaryText && hoverSummaryText !== hoverPromptText ? (
                          <section className="space-y-1.5">
                            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground/60">
                              <MessagesSquare className="size-3" />
                              <span>
                                {t('subAgentsPanel.reportStatusSubmitted', {
                                  defaultValue: '结果'
                                })}
                              </span>
                            </div>
                            <div className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-background/60 px-2.5 py-2 text-[12px] leading-5 text-foreground/80">
                              {hoverSummaryText}
                            </div>
                          </section>
                        ) : null}
                      </div>
                    </HoverCardContent>
                  </HoverCard>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
