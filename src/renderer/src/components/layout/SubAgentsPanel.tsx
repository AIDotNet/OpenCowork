import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  Bot,
  Clock3,
  FileText,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen
} from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAgentStore, type SubAgentState } from '@renderer/stores/agent-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { TranscriptMessageList } from '@renderer/components/chat/TranscriptMessageList'
import { cn } from '@renderer/lib/utils'

const SUB_AGENT_COMPACT_WIDTH = 600
const SUB_AGENT_SIDEBAR_MIN = 240
const SUB_AGENT_SIDEBAR_BASIS = 280
const SUB_AGENT_SIDEBAR_MAX = 360
const SUB_AGENT_DETAIL_MIN = 380
const DAY_MS = 24 * 60 * 60 * 1000

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  return `${Math.floor(secs / 60)}m${Math.round(secs % 60)}s`
}

function getAgentSortTime(
  agent: Pick<SubAgentState, 'isRunning' | 'startedAt' | 'completedAt'>
): number {
  return agent.isRunning ? agent.startedAt : (agent.completedAt ?? agent.startedAt)
}

function getHistoryGroupLabel(ts: number): string {
  const now = new Date()
  const target = new Date(ts)
  const nowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const targetStart = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime()
  const diffDays = Math.floor((nowStart - targetStart) / DAY_MS)

  if (diffDays === 0) return '今天'
  if (diffDays === 1) return '昨天'
  return target.toLocaleDateString()
}

export function SubAgentsPanel(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const activeSubAgents = useAgentStore((s) => s.activeSubAgents)
  const completedSubAgents = useAgentStore((s) => s.completedSubAgents)
  const subAgentHistory = useAgentStore((s) => s.subAgentHistory)
  const selectedToolUseId = useUIStore((s) => s.selectedSubAgentToolUseId)
  const setSelectedToolUseId = useUIStore((s) => s.setSelectedSubAgentToolUseId)
  const setRightPanelOpen = useUIStore((s) => s.setRightPanelOpen)
  const panelRef = React.useRef<HTMLDivElement | null>(null)
  const [panelWidth, setPanelWidth] = React.useState(0)
  const [detailVisible, setDetailVisible] = React.useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false)
  const [now, setNow] = React.useState(() => Date.now())

  const allAgents = React.useMemo(() => {
    const merged = new Map<string, SubAgentState>()

    for (const agent of subAgentHistory) {
      if (agent.sessionId === activeSessionId) merged.set(agent.toolUseId, agent)
    }
    for (const agent of Object.values(completedSubAgents)) {
      if (agent.sessionId === activeSessionId) merged.set(agent.toolUseId, agent)
    }
    for (const agent of Object.values(activeSubAgents)) {
      if (agent.sessionId === activeSessionId) merged.set(agent.toolUseId, agent)
    }

    return [...merged.values()].sort(
      (left, right) => getAgentSortTime(right) - getAgentSortTime(left)
    )
  }, [activeSessionId, activeSubAgents, completedSubAgents, subAgentHistory])

  const runningAgents = React.useMemo(
    () => allAgents.filter((agent) => agent.isRunning),
    [allAgents]
  )

  const completedGroups = React.useMemo(() => {
    const groups = new Map<string, { label: string; items: SubAgentState[] }>()

    for (const agent of allAgents) {
      if (agent.isRunning) continue
      const groupTs = agent.completedAt ?? agent.startedAt
      const label = getHistoryGroupLabel(groupTs)
      const group = groups.get(label)
      if (group) {
        group.items.push(agent)
      } else {
        groups.set(label, { label, items: [agent] })
      }
    }

    return [...groups.values()]
  }, [allAgents])

  const selectedAgent = React.useMemo(() => {
    if (!selectedToolUseId) return allAgents[0] ?? null
    return allAgents.find((agent) => agent.toolUseId === selectedToolUseId) ?? allAgents[0] ?? null
  }, [allAgents, selectedToolUseId])

  const isCompact = panelWidth > 0 && panelWidth < SUB_AGENT_COMPACT_WIDTH

  React.useEffect(() => {
    const element = panelRef.current
    if (!element || typeof ResizeObserver === 'undefined') return

    const updateWidth = (): void => setPanelWidth(element.clientWidth)
    updateWidth()

    const observer = new ResizeObserver(() => {
      updateWidth()
    })

    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  React.useEffect(() => {
    if (!selectedAgent?.toolUseId) return
    const selectedStillExists = selectedToolUseId
      ? allAgents.some((agent) => agent.toolUseId === selectedToolUseId)
      : false
    if (!selectedToolUseId || !selectedStillExists) {
      setSelectedToolUseId(selectedAgent.toolUseId)
    }
  }, [allAgents, selectedAgent?.toolUseId, selectedToolUseId, setSelectedToolUseId])

  React.useEffect(() => {
    if (!isCompact) return
    setDetailVisible(Boolean(selectedAgent))
  }, [isCompact, selectedAgent])

  React.useEffect(() => {
    if (!runningAgents.length && !selectedAgent?.isRunning) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [runningAgents.length, selectedAgent?.isRunning])

  if (!activeSessionId || allAgents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border/60 bg-background/40 text-xs text-muted-foreground">
        {t('detailPanel.noSubAgentRecords')}
      </div>
    )
  }

  return (
    <div ref={panelRef} className="h-full min-h-0">
      <div className="flex h-full min-h-0 flex-col gap-3">
        {isCompact ? (
          detailVisible && selectedAgent ? (
            <SubAgentDetail
              agent={selectedAgent}
              now={now}
              compact
              onBack={() => setDetailVisible(false)}
              onClose={() => setRightPanelOpen(false)}
            />
          ) : (
            <SubAgentList
              title={t('rightPanel.subagents')}
              runningAgents={runningAgents}
              completedGroups={completedGroups}
              selectedToolUseId={selectedAgent?.toolUseId ?? null}
              now={now}
              compact
              onSelect={(toolUseId) => {
                setSelectedToolUseId(toolUseId)
                setDetailVisible(true)
              }}
              onCollapse={() => setRightPanelOpen(false)}
            />
          )
        ) : (
          <div className="flex h-full min-h-0 gap-3">
            {!sidebarCollapsed && (
              <aside
                className="flex min-w-[var(--subagent-sidebar-min)] max-w-[var(--subagent-sidebar-max)] basis-[var(--subagent-sidebar-basis)] flex-col overflow-hidden border-r border-border/60 bg-background/40"
                style={
                  {
                    '--subagent-sidebar-min': `${SUB_AGENT_SIDEBAR_MIN}px`,
                    '--subagent-sidebar-max': `${SUB_AGENT_SIDEBAR_MAX}px`,
                    '--subagent-sidebar-basis': `${SUB_AGENT_SIDEBAR_BASIS}px`
                  } as React.CSSProperties
                }
              >
                <SubAgentList
                  title={t('rightPanel.subagents')}
                  runningAgents={runningAgents}
                  completedGroups={completedGroups}
                  selectedToolUseId={selectedAgent?.toolUseId ?? null}
                  now={now}
                  compact={false}
                  onSelect={(toolUseId) => setSelectedToolUseId(toolUseId)}
                  onCollapse={() => setSidebarCollapsed(true)}
                />
              </aside>
            )}

            <section
              className="min-w-[var(--subagent-detail-min)] flex-1 overflow-hidden bg-background/30"
              style={
                { '--subagent-detail-min': `${SUB_AGENT_DETAIL_MIN}px` } as React.CSSProperties
              }
            >
              {selectedAgent ? (
                <SubAgentDetail
                  agent={selectedAgent}
                  now={now}
                  compact={false}
                  sidebarCollapsed={sidebarCollapsed}
                  onShowSidebar={() => setSidebarCollapsed(false)}
                  onClose={() => setRightPanelOpen(false)}
                />
              ) : null}
            </section>
          </div>
        )}
      </div>
    </div>
  )
}

function SubAgentList({
  title,
  runningAgents,
  completedGroups,
  selectedToolUseId,
  now,
  onSelect,
  onCollapse,
  compact
}: {
  title: string
  runningAgents: SubAgentState[]
  completedGroups: Array<{ label: string; items: SubAgentState[] }>
  selectedToolUseId: string | null
  now: number
  onSelect: (toolUseId: string) => void
  onCollapse: () => void
  compact: boolean
}): React.JSX.Element {
  const { t } = useTranslation('layout')

  return (
    <>
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Bot className="size-4 text-cyan-400" />
          <span className="truncate text-sm font-medium text-foreground/90">{title}</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-foreground"
          onClick={onCollapse}
          title={t('rightPanel.collapse')}
        >
          <PanelLeftClose className="size-4" />
        </Button>
      </div>

      <div className={cn('min-h-0 flex-1 overflow-y-auto p-2', compact && 'p-2.5')}>
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
                  isSelected={selectedToolUseId === agent.toolUseId}
                  elapsed={now - agent.startedAt}
                  onClick={() => onSelect(agent.toolUseId)}
                />
              ))}
            </div>
          </div>
        )}

        {completedGroups.map((group) => (
          <div key={group.label} className="mb-3 last:mb-0">
            <div className="mb-2 px-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
              {group.label}
            </div>
            <div className="space-y-1">
              {group.items.map((agent) => (
                <SubAgentListItem
                  key={agent.toolUseId}
                  name={agent.displayName ?? agent.name}
                  description={agent.description}
                  isRunning={false}
                  isSelected={selectedToolUseId === agent.toolUseId}
                  elapsed={agent.completedAt ? agent.completedAt - agent.startedAt : null}
                  onClick={() => onSelect(agent.toolUseId)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

function SubAgentDetail({
  agent,
  now,
  onBack,
  onClose,
  onShowSidebar,
  sidebarCollapsed = false,
  compact
}: {
  agent: SubAgentState
  now: number
  onBack?: () => void
  onClose: () => void
  onShowSidebar?: () => void
  sidebarCollapsed?: boolean
  compact: boolean
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const elapsed = formatElapsed((agent.completedAt ?? now) - agent.startedAt)

  return (
    <div className="flex h-full min-h-0 flex-col bg-background/20">
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          {onBack ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-2 px-2.5 text-cyan-200 hover:bg-cyan-500/10 hover:text-cyan-100"
              onClick={onBack}
            >
              <ArrowLeft className="size-4" />
              {t('rightPanel.back', { defaultValue: '返回列表' })}
            </Button>
          ) : null}
          {!compact && sidebarCollapsed && onShowSidebar ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-2 px-2.5 text-muted-foreground hover:bg-cyan-500/10 hover:text-cyan-100"
              onClick={onShowSidebar}
            >
              <PanelLeftOpen className="size-4" />
              {t('rightPanel.subagents')}
            </Button>
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="min-w-0 truncate text-sm font-semibold text-foreground/95">
                {agent.displayName ?? agent.name}
              </h2>
              <Badge
                variant="secondary"
                className={cn(
                  'border border-cyan-500/25 bg-cyan-500/10 text-cyan-100',
                  !agent.isRunning && 'border-border/60 bg-background/70 text-foreground/80'
                )}
              >
                {agent.isRunning
                  ? t('subAgentsPanel.running', { defaultValue: '运行中' })
                  : t('subAgentsPanel.completed', { defaultValue: '已完成' })}
              </Badge>
              <span className="flex items-center gap-1 text-xs text-muted-foreground/70">
                <Clock3 className="size-3.5 text-cyan-400" />
                {elapsed}
              </span>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:bg-cyan-500/10 hover:text-cyan-100"
            onClick={onClose}
            title={t('rightPanel.collapse')}
          >
            <PanelLeftClose className="size-4" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="space-y-4">
          <section className="border-b border-border/60 pb-4">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
              <Bot className="size-3.5 text-cyan-400" />
              <span>{t('subAgentsPanel.execution', { defaultValue: '执行过程' })}</span>
              {agent.isRunning ? <Loader2 className="size-3 animate-spin text-cyan-400" /> : null}
            </div>
            <div className="min-w-0 prose prose-sm max-w-none prose-headings:text-foreground prose-p:text-foreground/90 prose-li:text-foreground/90 prose-strong:text-foreground dark:prose-invert">
              <TranscriptMessageList
                messages={agent.transcript}
                streamingMessageId={agent.currentAssistantMessageId}
              />
            </div>
          </section>

          <section>
            <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
              <FileText className="size-3.5 text-cyan-400" />
              <span>{t('subAgentsPanel.report', { defaultValue: '总结报告' })}</span>
            </div>
            {agent.report.trim() ? (
              <div className="min-w-0 prose prose-sm max-w-none prose-headings:text-foreground prose-p:text-foreground/90 prose-li:text-foreground/90 prose-strong:text-foreground dark:prose-invert">
                <Markdown remarkPlugins={[remarkGfm]}>{agent.report}</Markdown>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground/70">
                {agent.reportStatus === 'retrying'
                  ? t('subAgentsPanel.reportStatusRetrying', { defaultValue: '补救中' })
                  : agent.reportStatus === 'missing'
                    ? t('subAgentsPanel.reportMissing', { defaultValue: '未捕获到总结报告。' })
                    : t('subAgentsPanel.reportPending', {
                        defaultValue: '当前 SubAgent 尚未生成总结报告。'
                      })}
              </div>
            )}
          </section>
        </div>
      </div>
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
        'group w-full rounded-lg border px-3 py-2.5 text-left transition-colors',
        isSelected
          ? 'border-cyan-500/35 bg-cyan-500/10 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.12)]'
          : 'border-transparent bg-background/30 hover:border-cyan-500/20 hover:bg-background/60'
      )}
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-sm font-medium leading-5 text-foreground/90">
          {name}
        </span>
        <Badge
          variant="secondary"
          className={cn(
            'border border-cyan-500/25 bg-cyan-500/10 text-[10px] tracking-wide text-cyan-100',
            !isRunning && 'border-border/60 bg-background/65 text-foreground/75'
          )}
        >
          {isRunning ? 'RUN' : 'DONE'}
        </Badge>
      </div>
      <div className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground/75">
        {description || '—'}
      </div>
      {elapsed != null ? (
        <div className="mt-1 text-[11px] text-muted-foreground/55">{formatElapsed(elapsed)}</div>
      ) : null}
    </button>
  )
}
