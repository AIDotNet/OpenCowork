import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Clock, FileText, Loader2, MessageSquareText, PanelLeftClose } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Separator } from '@renderer/components/ui/separator'
import { TranscriptMessageList } from '@renderer/components/chat/TranscriptMessageList'
import { cn } from '@renderer/lib/utils'

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  return `${Math.floor(secs / 60)}m${Math.round(secs % 60)}s`
}

export function SubAgentsPanel(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const activeSubAgents = useAgentStore((s) => s.activeSubAgents)
  const completedSubAgents = useAgentStore((s) => s.completedSubAgents)
  const selectedToolUseId = useUIStore((s) => s.selectedSubAgentToolUseId)
  const setSelectedToolUseId = useUIStore((s) => s.setSelectedSubAgentToolUseId)
  const setRightPanelOpen = useUIStore((s) => s.setRightPanelOpen)

  const runningAgents = React.useMemo(
    () =>
      Object.values(activeSubAgents)
        .filter((agent) => agent.sessionId === activeSessionId)
        .sort((left, right) => right.startedAt - left.startedAt),
    [activeSessionId, activeSubAgents]
  )

  const completedAgents = React.useMemo(
    () =>
      Object.values(completedSubAgents)
        .filter((agent) => agent.sessionId === activeSessionId)
        .sort((left, right) => (right.completedAt ?? 0) - (left.completedAt ?? 0)),
    [activeSessionId, completedSubAgents]
  )

  const allAgents = React.useMemo(
    () => [...runningAgents, ...completedAgents],
    [runningAgents, completedAgents]
  )

  const selectedAgent = React.useMemo(() => {
    if (!selectedToolUseId) return allAgents[0] ?? null
    return allAgents.find((agent) => agent.toolUseId === selectedToolUseId) ?? allAgents[0] ?? null
  }, [allAgents, selectedToolUseId])

  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    if (!runningAgents.length && !selectedAgent?.isRunning) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [runningAgents.length, selectedAgent?.isRunning])

  React.useEffect(() => {
    if (selectedAgent?.toolUseId !== selectedToolUseId) {
      setSelectedToolUseId(selectedAgent?.toolUseId ?? null)
    }
  }, [selectedAgent?.toolUseId, selectedToolUseId, setSelectedToolUseId])

  if (!activeSessionId || allAgents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border/60 bg-background/40 text-xs text-muted-foreground">
        {t('detailPanel.noSubAgentRecords')}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 gap-4">
      <aside className="flex w-[220px] shrink-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-background/70">
        <div className="flex items-center justify-between border-b border-border/50 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Bot className="size-4 text-violet-500" />
            <span className="text-sm font-medium">{t('rightPanel.subagents')}</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setRightPanelOpen(false)}
            title={t('rightPanel.collapse')}
          >
            <PanelLeftClose className="size-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {runningAgents.length > 0 && (
            <div className="mb-3">
              <div className="mb-2 px-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                {t('subAgentsPanel.running', { defaultValue: '运行中' })}
              </div>
              <div className="space-y-1">
                {runningAgents.map((agent) => (
                  <SubAgentListItem
                    key={agent.toolUseId}
                    name={agent.displayName ?? agent.name}
                    description={agent.description}
                    isRunning
                    isSelected={selectedAgent?.toolUseId === agent.toolUseId}
                    elapsed={now - agent.startedAt}
                    onClick={() => setSelectedToolUseId(agent.toolUseId)}
                  />
                ))}
              </div>
            </div>
          )}

          {completedAgents.length > 0 && (
            <div>
              <div className="mb-2 px-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                {t('subAgentsPanel.completed', { defaultValue: '已完成' })}
              </div>
              <div className="space-y-1">
                {completedAgents.map((agent) => (
                  <SubAgentListItem
                    key={agent.toolUseId}
                    name={agent.displayName ?? agent.name}
                    description={agent.description}
                    isRunning={false}
                    isSelected={selectedAgent?.toolUseId === agent.toolUseId}
                    elapsed={
                      agent.completedAt && agent.startedAt
                        ? agent.completedAt - agent.startedAt
                        : null
                    }
                    onClick={() => setSelectedToolUseId(agent.toolUseId)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </aside>

      <section className="min-w-0 flex-1 overflow-hidden rounded-xl border border-border/60 bg-background/70">
        {selectedAgent ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="border-b border-border/50 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-violet-500">
                  {selectedAgent.displayName ?? selectedAgent.name}
                </span>
                <Badge
                  variant={selectedAgent.isRunning ? 'default' : 'secondary'}
                  className={cn(selectedAgent.isRunning && 'bg-violet-500')}
                >
                  {selectedAgent.isRunning
                    ? t('subAgentsPanel.running', { defaultValue: '运行中' })
                    : t('subAgentsPanel.completed', { defaultValue: '已完成' })}
                </Badge>
                <span className="flex items-center gap-1 text-xs text-muted-foreground/70">
                  <Clock className="size-3" />
                  {formatElapsed((selectedAgent.completedAt ?? now) - selectedAgent.startedAt)}
                </span>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="space-y-4">
                <section className="rounded-xl border border-border/60 bg-muted/20 p-4">
                  <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
                    <MessageSquareText className="size-3.5" />
                    <span>{t('subAgentsPanel.taskInput', { defaultValue: '任务输入' })}</span>
                  </div>
                  <div className="space-y-3 text-sm leading-relaxed">
                    <div>
                      <div className="mb-1 text-xs font-medium text-muted-foreground/70">
                        {t('subAgentsPanel.description', { defaultValue: 'Description' })}
                      </div>
                      <div className="whitespace-pre-wrap break-words text-foreground/90">
                        {selectedAgent.description || '—'}
                      </div>
                    </div>
                    <Separator />
                    <div>
                      <div className="mb-1 text-xs font-medium text-muted-foreground/70">
                        {t('subAgentsPanel.prompt', { defaultValue: 'Prompt' })}
                      </div>
                      <div className="whitespace-pre-wrap break-words text-foreground/90">
                        {selectedAgent.prompt || '—'}
                      </div>
                    </div>
                  </div>
                </section>

                <section className="rounded-xl border border-border/60 bg-background/50 p-4">
                  <div className="mb-4 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
                    <Bot className="size-3.5" />
                    <span>{t('subAgentsPanel.execution', { defaultValue: '执行过程' })}</span>
                    {selectedAgent.isRunning && (
                      <Loader2 className="size-3 animate-spin text-violet-500" />
                    )}
                  </div>
                  <TranscriptMessageList
                    messages={selectedAgent.transcript}
                    streamingMessageId={selectedAgent.currentAssistantMessageId}
                  />
                </section>

                <section className="rounded-xl border border-border/60 bg-muted/20 p-4">
                  <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
                    <FileText className="size-3.5" />
                    <span>{t('subAgentsPanel.report', { defaultValue: '总结报告' })}</span>
                  </div>
                  {selectedAgent.report.trim() ? (
                    <div className="prose prose-sm max-w-none dark:prose-invert">
                      <Markdown remarkPlugins={[remarkGfm]}>{selectedAgent.report}</Markdown>
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground/70">
                      {selectedAgent.reportStatus === 'retrying'
                        ? t('subAgentsPanel.reportStatusRetrying', { defaultValue: '补救中' })
                        : selectedAgent.reportStatus === 'missing'
                          ? t('subAgentsPanel.reportMissing', {
                              defaultValue: '未捕获到总结报告。'
                            })
                          : t('subAgentsPanel.reportPending', {
                              defaultValue: '当前 SubAgent 尚未生成总结报告。'
                            })}
                    </div>
                  )}
                </section>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  )
}

function SubAgentListItem({
  name,
  description,
  isRunning,
  isSelected,
  elapsed,
  onClick
}: {
  name: string
  description: string
  isRunning: boolean
  isSelected: boolean
  elapsed: number | null
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full rounded-lg border px-2.5 py-2 text-left transition-colors',
        isSelected
          ? 'border-violet-500/40 bg-violet-500/10'
          : 'border-transparent bg-background hover:border-border/70 hover:bg-muted/40'
      )}
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium text-foreground/90">{name}</span>
        <Badge
          variant={isRunning ? 'default' : 'secondary'}
          className={cn('ml-auto', isRunning && 'bg-violet-500')}
        >
          {isRunning ? 'RUN' : 'DONE'}
        </Badge>
      </div>
      <div className="mt-1 line-clamp-2 text-xs text-muted-foreground/70">{description || '—'}</div>
      {elapsed != null && (
        <div className="mt-1 text-[11px] text-muted-foreground/50">{formatElapsed(elapsed)}</div>
      )}
    </button>
  )
}
