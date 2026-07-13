import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, Bot, Loader2 } from 'lucide-react'
import { FadeIn, spring } from '@renderer/components/animate-ui/transitions'
import { useAgentStore, type SubAgentState } from '@renderer/stores/agent-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { cn } from '@renderer/lib/utils'
import { selectSessionScopedAgentState } from '@renderer/lib/agent/session-scoped-agent-state'
import { EMPTY_SESSION_MESSAGES, mergeSessionSubAgents } from './sub-agent-run-data'
import { SubAgentExecutionDetail } from './SubAgentExecutionDetail'
import { getAgentIcon, getAgentIconTone } from './sub-agent-visuals'

function isActiveAgent(agent: SubAgentState): boolean {
  return agent.isRunning || Boolean(agent.isQueued)
}

function getLatestErroredTool(agent: SubAgentState): SubAgentState['toolCalls'][number] | null {
  for (let index = agent.toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = agent.toolCalls[index]
    if (toolCall.status === 'error') return toolCall
  }
  return null
}

function getAgentSummary(agent: SubAgentState): string {
  const failedTool = getLatestErroredTool(agent)
  const source =
    agent.errorMessage?.trim() ||
    failedTool?.error?.trim() ||
    agent.report.trim() ||
    agent.streamingText.trim() ||
    agent.description.trim() ||
    agent.prompt.trim()

  return source.replace(/\s+/g, ' ').trim()
}

function formatElapsed(
  milliseconds: number,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  const seconds = Math.max(1, Math.floor(milliseconds / 1000))
  if (seconds < 60) {
    return t('subAgentsPanel.durationSeconds', { defaultValue: '{{count}}s', count: seconds })
  }

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return t('subAgentsPanel.durationMinutes', { defaultValue: '{{count}}m', count: minutes })
  }

  return t('subAgentsPanel.durationHours', {
    defaultValue: '{{count}}h',
    count: Math.floor(minutes / 60)
  })
}

function getStatusLabel(
  agent: SubAgentState,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if (agent.isQueued) return t('subAgentsPanel.queued', { defaultValue: 'Queued' })
  if (agent.isRunning) return t('subAgentsPanel.running', { defaultValue: 'Running' })
  if (agent.endReason === 'max_iterations') {
    return t('subAgentsPanel.maxIterations', { defaultValue: 'Iteration limit reached' })
  }
  if (agent.endReason === 'aborted') {
    return t('subAgentsPanel.aborted', { defaultValue: 'Aborted' })
  }
  if (agent.success === false || agent.errorMessage) {
    return t('detailPanel.error', { defaultValue: 'Failed' })
  }
  return t('subAgentsPanel.completed', { defaultValue: 'Completed' })
}

function SubAgentListItem({
  agent,
  now,
  onOpen
}: {
  agent: SubAgentState
  now: number
  onOpen: () => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const displayName = agent.displayName ?? agent.name
  const summary = getAgentSummary(agent)
  const isFailed = agent.success === false || Boolean(agent.errorMessage)
  const statusLabel = getStatusLabel(agent, t)

  return (
    <button
      type="button"
      data-subagent-card={agent.toolUseId}
      onClick={onOpen}
      className="group flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span
        className={cn(
          'mt-0.5 flex size-5 shrink-0 items-center justify-center',
          getAgentIconTone(displayName),
          isFailed && 'text-destructive'
        )}
      >
        {getAgentIcon(displayName)}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground/90">
            {displayName}
          </span>
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-muted-foreground/65',
              isFailed && 'text-destructive/80'
            )}
          >
            {agent.isRunning ? <Loader2 className="size-3 animate-spin" /> : null}
            {isActiveAgent(agent)
              ? statusLabel
              : formatElapsed((agent.completedAt ?? now) - agent.startedAt, t)}
          </span>
        </span>

        <span
          className={cn(
            'mt-0.5 block max-h-9 overflow-hidden break-words text-xs leading-[18px] text-muted-foreground/72',
            isFailed && 'text-destructive/70'
          )}
          style={{
            display: '-webkit-box',
            WebkitBoxOrient: 'vertical',
            WebkitLineClamp: 2
          }}
        >
          {summary || statusLabel}
        </span>
      </span>
    </button>
  )
}

function SubAgentList({
  agents,
  now,
  onOpen
}: {
  agents: SubAgentState[]
  now: number
  onOpen: (agent: SubAgentState) => void
}): React.JSX.Element {
  const animationsEnabled = useSettingsStore((s) => s.animationsEnabled)

  if (!animationsEnabled) {
    return (
      <div className="space-y-0.5">
        {agents.map((agent) => (
          <SubAgentListItem
            key={agent.toolUseId}
            agent={agent}
            now={now}
            onOpen={() => onOpen(agent)}
          />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-0.5">
      <AnimatePresence initial={false}>
        {agents.map((agent) => (
          <motion.div
            key={agent.toolUseId}
            layout
            layoutId={`sub-agent-card-${agent.toolUseId}`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ ...spring.stiff, opacity: { duration: 0.15 } }}
          >
            <SubAgentListItem agent={agent} now={now} onOpen={() => onOpen(agent)} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

function SubAgentDetailHeader({
  agent,
  now,
  onBack
}: {
  agent: SubAgentState
  now: number
  onBack: () => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const displayName = agent.displayName ?? agent.name
  const statusLabel = getStatusLabel(agent, t)
  const isFailed = agent.success === false || Boolean(agent.errorMessage)

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3">
      <button
        type="button"
        onClick={onBack}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        title={t('subAgentsPanel.backToList', { defaultValue: 'Back to SubAgents' })}
        aria-label={t('subAgentsPanel.backToList', { defaultValue: 'Back to SubAgents' })}
      >
        <ArrowLeft className="size-4" />
      </button>
      <span
        className={cn(
          'flex size-5 shrink-0 items-center justify-center',
          getAgentIconTone(displayName),
          isFailed && 'text-destructive'
        )}
      >
        {getAgentIcon(displayName)}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground/90">
        {displayName}
      </span>
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground/65',
          isFailed && 'text-destructive/80'
        )}
      >
        {agent.isRunning ? <Loader2 className="size-3 animate-spin" /> : null}
        {isActiveAgent(agent)
          ? statusLabel
          : formatElapsed((agent.completedAt ?? now) - agent.startedAt, t)}
      </span>
    </div>
  )
}

export function SubAgentsPanel({
  sessionId
}: {
  sessionId?: string | null
} = {}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const chatActiveSessionId = useChatStore((state) => state.activeSessionId)
  const activeSessionId = sessionId ?? chatActiveSessionId
  const sessionMessages = useChatStore((state) =>
    activeSessionId ? state.getSessionMessages(activeSessionId) : EMPTY_SESSION_MESSAGES
  )
  const { activeSubAgents, completedSubAgents, subAgentHistory } = useAgentStore((state) =>
    selectSessionScopedAgentState(state, activeSessionId)
  )
  const selectedToolUseId = useUIStore((state) => state.selectedSubAgentToolUseId)
  const inlineText = useUIStore((state) => state.subAgentExecutionDetailInlineText)
  const openSubAgentsPanel = useUIStore((state) => state.openSubAgentsPanel)
  const openSubAgentExecutionDetail = useUIStore((state) => state.openSubAgentExecutionDetail)
  const [now, setNow] = React.useState(() => Date.now())

  const allAgents = React.useMemo(() => {
    const agents = mergeSessionSubAgents({
      sessionId: activeSessionId,
      messages: sessionMessages,
      activeSubAgents,
      completedSubAgents,
      subAgentHistory
    })

    return agents.sort((left, right) => {
      const activeDelta = Number(isActiveAgent(right)) - Number(isActiveAgent(left))
      if (activeDelta !== 0) return activeDelta
      const leftTime = left.completedAt ?? left.startedAt
      const rightTime = right.completedAt ?? right.startedAt
      return rightTime - leftTime
    })
  }, [activeSessionId, activeSubAgents, completedSubAgents, sessionMessages, subAgentHistory])

  const selectedAgent = React.useMemo(
    () => allAgents.find((agent) => agent.toolUseId === selectedToolUseId) ?? null,
    [allAgents, selectedToolUseId]
  )
  const activeAgents = React.useMemo(
    () => allAgents.filter((agent) => isActiveAgent(agent)),
    [allAgents]
  )
  const completedAgents = React.useMemo(
    () => allAgents.filter((agent) => !isActiveAgent(agent)),
    [allAgents]
  )

  React.useEffect(() => {
    if (!allAgents.some((agent) => isActiveAgent(agent))) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [allAgents])

  const openAgent = React.useCallback(
    (agent: SubAgentState) =>
      openSubAgentExecutionDetail(
        agent.toolUseId,
        null,
        agent.displayName ?? agent.name,
        activeSessionId
      ),
    [activeSessionId, openSubAgentExecutionDetail]
  )

  let contentKey: string
  let content: React.JSX.Element

  if (selectedAgent) {
    contentKey = `detail-${selectedAgent.toolUseId}`
    content = (
      <FadeIn
        key={contentKey}
        duration={0.15}
        className="flex h-full min-h-0 flex-col bg-background"
      >
        <SubAgentDetailHeader
          agent={selectedAgent}
          now={now}
          onBack={() => openSubAgentsPanel(null, activeSessionId)}
        />
        <div className="min-h-0 flex-1">
          <SubAgentExecutionDetail
            embedded
            toolUseId={selectedAgent.toolUseId}
            inlineText={inlineText ?? undefined}
            sessionId={activeSessionId}
          />
        </div>
      </FadeIn>
    )
  } else if (!activeSessionId || allAgents.length === 0) {
    contentKey = 'empty'
    content = (
      <FadeIn
        key={contentKey}
        duration={0.15}
        className="flex h-full flex-col items-center justify-center px-6 text-center"
      >
        <Bot className="mb-3 size-7 text-muted-foreground/35" />
        <p className="text-sm text-muted-foreground">
          {t('detailPanel.noSubAgentRecords', { defaultValue: 'No SubAgent records' })}
        </p>
        <p className="mt-1 text-xs text-muted-foreground/55">
          {t('detailPanel.subAgentActivity', {
            defaultValue: 'SubAgent activity will appear here'
          })}
        </p>
      </FadeIn>
    )
  } else {
    contentKey = 'list'
    content = (
      <FadeIn
        key={contentKey}
        duration={0.15}
        className="h-full min-h-0 overflow-y-auto bg-background px-2 py-4"
      >
        <section>
          <div className="mb-2 px-1 text-xs font-medium text-muted-foreground/65">
            {t('subAgentsPanel.started', { defaultValue: 'Started' })}
          </div>
          {activeAgents.length > 0 ? (
            <SubAgentList agents={activeAgents} now={now} onOpen={openAgent} />
          ) : (
            <p className="px-1 pb-1 text-xs leading-5 text-muted-foreground/55">
              {t('subAgentsPanel.noStarted', { defaultValue: 'No SubAgents have been started' })}
            </p>
          )}
        </section>

        {completedAgents.length > 0 ? (
          <section className="mt-6">
            <div className="mb-2 px-1 text-xs font-medium text-muted-foreground/65">
              {t('subAgentsPanel.completedGroup', { defaultValue: 'Completed' })} ·{' '}
              {completedAgents.length}
            </div>
            <SubAgentList agents={completedAgents} now={now} onOpen={openAgent} />
          </section>
        ) : null}
      </FadeIn>
    )
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      {content}
    </AnimatePresence>
  )
}
