import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bot,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Clock3,
  ExternalLink,
  FileText,
  Loader2,
  PanelLeftClose,
  ScrollText,
  Sparkles,
  Wrench,
  icons
} from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { useAgentStore, type SubAgentState } from '@renderer/stores/agent-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { TASK_TOOL_NAME, parseSubAgentMeta } from '@renderer/lib/agent/sub-agents/create-tool'
import { subAgentRegistry } from '@renderer/lib/agent/sub-agents/registry'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import type { ToolCallState } from '@renderer/lib/agent/types'
import type { ToolResultContent, UnifiedMessage } from '@renderer/lib/api/types'
import { cn } from '@renderer/lib/utils'

const DAY_MS = 24 * 60 * 60 * 1000

type PanelFilter = 'all' | 'running' | 'completed' | 'today'

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  return `${Math.floor(secs / 60)}m${Math.round(secs % 60)}s`
}

function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString()
}

function getAgentSortTime(
  agent: Pick<SubAgentState, 'isRunning' | 'startedAt' | 'completedAt'>
): number {
  return agent.isRunning ? agent.startedAt : (agent.completedAt ?? agent.startedAt)
}

function getHistoryGroupLabel(
  ts: number,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  const now = new Date()
  const target = new Date(ts)
  const nowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const targetStart = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime()
  const diffDays = Math.floor((nowStart - targetStart) / DAY_MS)

  if (diffDays === 0) return t('subAgentsPanel.groupToday', { defaultValue: '今天' })
  if (diffDays === 1) return t('subAgentsPanel.groupYesterday', { defaultValue: '昨天' })
  return target.toLocaleDateString()
}

function isSameDay(ts: number): boolean {
  const now = new Date()
  const target = new Date(ts)
  return (
    now.getFullYear() === target.getFullYear() &&
    now.getMonth() === target.getMonth() &&
    now.getDate() === target.getDate()
  )
}

function getAgentIcon(agentName: string): React.ReactNode {
  const def = subAgentRegistry.get(agentName)
  if (def?.icon && def.icon in icons) {
    const IconComp = icons[def.icon as keyof typeof icons]
    return <IconComp className="size-4" />
  }
  return <Bot className="size-4" />
}

function getLatestErroredTool(agent: SubAgentState): SubAgentState['toolCalls'][number] | null {
  for (let index = agent.toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = agent.toolCalls[index]
    if (toolCall.status === 'error') return toolCall
  }
  return null
}

function getAgentFailureText(agent: SubAgentState): string {
  const toolCall = getLatestErroredTool(agent)
  if (agent.errorMessage?.trim()) return agent.errorMessage.trim()
  if (toolCall?.error?.trim()) return `${toolCall.name}: ${toolCall.error.trim()}`
  return ''
}

function getAgentSummary(agent: SubAgentState): string {
  const failureText = getAgentFailureText(agent)
  if ((agent.success === false || !!agent.errorMessage) && failureText) {
    return failureText
  }
  if (agent.report?.trim()) return agent.report.trim()
  if (agent.streamingText?.trim()) return agent.streamingText.trim()
  return ''
}

function getPreviewText(text: string, isRunning: boolean): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const limit = isRunning ? 260 : 320
  if (trimmed.length <= limit) return trimmed
  return isRunning ? `…${trimmed.slice(-limit)}` : `${trimmed.slice(0, limit)}…`
}

function getToolCallStatusLabel(status: ToolCallState['status']): string {
  switch (status) {
    case 'running':
    case 'streaming':
      return '运行中'
    case 'pending_approval':
      return '待确认'
    case 'completed':
      return '已完成'
    case 'error':
      return '失败'
    case 'canceled':
      return '已取消'
    default:
      return status
  }
}

function getToolCallStatusClass(status: ToolCallState['status']): string {
  switch (status) {
    case 'running':
    case 'streaming':
      return 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200'
    case 'pending_approval':
      return 'border-amber-400/20 bg-amber-400/10 text-amber-200'
    case 'error':
      return 'border-destructive/20 bg-destructive/10 text-destructive'
    case 'canceled':
      return 'border-white/10 bg-white/[0.05] text-white/45'
    case 'completed':
    default:
      return 'border-white/10 bg-white/[0.05] text-white/72'
  }
}

function extractToolResultText(content?: ToolResultContent): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content
    .filter(
      (block): block is Extract<ToolResultContent[number], { type: 'text' }> =>
        block.type === 'text'
    )
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function normalizeToolCallStatus(status: string): ToolCallState['status'] {
  const allowed: ToolCallState['status'][] = [
    'streaming',
    'pending_approval',
    'running',
    'completed',
    'error',
    'canceled'
  ]
  return allowed.includes(status as ToolCallState['status'])
    ? (status as ToolCallState['status'])
    : 'completed'
}

function parseSubAgentToolResult(
  content?: ToolResultContent,
  isError = false
): {
  report: string
  error: string | null
  meta: ReturnType<typeof parseSubAgentMeta>['meta']
} {
  const rawOutput = extractToolResultText(content)
  if (!rawOutput.trim())
    return { report: '', error: isError ? 'Tool call failed' : null, meta: null }

  const { meta, text } = parseSubAgentMeta(rawOutput)
  const payloadText = text.trim() || rawOutput.trim()
  const decoded = decodeStructuredToolResult(payloadText)
  const structured = decoded && !Array.isArray(decoded) ? decoded : null
  const structuredError =
    structured && typeof structured.error === 'string' ? structured.error.trim() : ''
  const structuredResult =
    structured && typeof structured.result === 'string' ? structured.result.trim() : ''
  const error = structuredError || (isError ? payloadText : '')
  const report = structuredResult || (!error ? (structured ? '' : payloadText) : '')

  return { report, error: error || null, meta }
}

function getPromptText(input: Record<string, unknown>): string {
  return [input.prompt, input.query, input.task, input.target]
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .join('\n\n')
}

function buildMessageSubAgents(
  messages: UnifiedMessage[],
  sessionId: string | null
): SubAgentState[] {
  if (!sessionId) return []

  const toolResults = new Map<
    string,
    { content: ToolResultContent; isError: boolean; createdAt: number }
  >()

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue
      toolResults.set(block.toolUseId, {
        content: block.content,
        isError: !!block.isError,
        createdAt: message.createdAt
      })
    }
  }

  const agents: SubAgentState[] = []
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue

    for (const block of message.content) {
      if (block.type !== 'tool_use' || block.name !== TASK_TOOL_NAME) continue
      if (block.input.run_in_background === true) continue

      const result = toolResults.get(block.id)
      const parsedResult = result
        ? parseSubAgentToolResult(result.content, result.isError)
        : { report: '', error: null, meta: null }
      const displayName = String(block.input.subagent_type ?? block.input.name ?? block.name)
      const completedAt = result?.createdAt ?? null

      agents.push({
        name: displayName,
        displayName,
        toolUseId: block.id,
        sessionId,
        description: block.input.description ? String(block.input.description) : '',
        prompt: getPromptText(block.input),
        isRunning: !result,
        success: result ? !parsedResult.error : null,
        errorMessage: parsedResult.error,
        iteration: parsedResult.meta?.iterations ?? 0,
        toolCalls:
          parsedResult.meta?.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.input,
            status: normalizeToolCallStatus(toolCall.status),
            output: toolCall.output,
            error: toolCall.error,
            requiresApproval: false,
            startedAt: toolCall.startedAt,
            completedAt: toolCall.completedAt
          })) ?? [],
        streamingText: '',
        transcript: [],
        currentAssistantMessageId: null,
        report: parsedResult.report,
        reportStatus: result ? (parsedResult.report.trim() ? 'submitted' : 'missing') : 'pending',
        usage: parsedResult.meta?.usage,
        startedAt: message.createdAt,
        completedAt
      })
    }
  }

  return agents
}

function matchesFilter(agent: SubAgentState, filter: PanelFilter): boolean {
  switch (filter) {
    case 'running':
      return agent.isRunning
    case 'completed':
      return !agent.isRunning
    case 'today':
      return isSameDay(agent.completedAt ?? agent.startedAt)
    case 'all':
    default:
      return true
  }
}

export function SubAgentsPanel(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const sessionMessages = useChatStore((s) =>
    activeSessionId ? s.getSessionMessages(activeSessionId) : []
  )
  const activeSubAgents = useAgentStore((s) => s.activeSubAgents)
  const completedSubAgents = useAgentStore((s) => s.completedSubAgents)
  const subAgentHistory = useAgentStore((s) => s.subAgentHistory)
  const selectedToolUseId = useUIStore((s) => s.selectedSubAgentToolUseId)
  const setSelectedToolUseId = useUIStore((s) => s.setSelectedSubAgentToolUseId)
  const setRightPanelOpen = useUIStore((s) => s.setRightPanelOpen)
  const openSubAgentExecutionDetail = useUIStore((s) => s.openSubAgentExecutionDetail)
  const [now, setNow] = React.useState(() => Date.now())
  const [filter, setFilter] = React.useState<PanelFilter>('all')
  const [expandedIds, setExpandedIds] = React.useState<Record<string, boolean>>({})

  const allAgents = React.useMemo(() => {
    const merged = new Map<string, SubAgentState>()

    for (const agent of buildMessageSubAgents(sessionMessages, activeSessionId)) {
      merged.set(agent.toolUseId, agent)
    }

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
  }, [activeSessionId, activeSubAgents, completedSubAgents, sessionMessages, subAgentHistory])

  const runningAgents = React.useMemo(
    () => allAgents.filter((agent) => agent.isRunning && matchesFilter(agent, filter)),
    [allAgents, filter]
  )

  const completedGroups = React.useMemo(() => {
    const groups = new Map<string, { label: string; items: SubAgentState[] }>()

    for (const agent of allAgents) {
      if (agent.isRunning || !matchesFilter(agent, filter)) continue
      const groupTs = agent.completedAt ?? agent.startedAt
      const label = getHistoryGroupLabel(groupTs, t)
      const group = groups.get(label)
      if (group) {
        group.items.push(agent)
      } else {
        groups.set(label, { label, items: [agent] })
      }
    }

    return [...groups.values()]
  }, [allAgents, filter, t])

  React.useEffect(() => {
    const hasRunning = allAgents.some((agent) => agent.isRunning)
    if (!hasRunning) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [allAgents])

  React.useEffect(() => {
    if (!selectedToolUseId) return
    if (!allAgents.some((agent) => agent.toolUseId === selectedToolUseId)) return

    setExpandedIds((prev) =>
      prev[selectedToolUseId] ? prev : { ...prev, [selectedToolUseId]: true }
    )

    const timer = window.setTimeout(() => {
      const node = document.querySelector<HTMLElement>(
        `[data-subagent-card="${selectedToolUseId}"]`
      )
      node?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 60)

    return () => window.clearTimeout(timer)
  }, [selectedToolUseId, allAgents])

  const visibleCount =
    runningAgents.length + completedGroups.reduce((sum, group) => sum + group.items.length, 0)

  if (!activeSessionId || allAgents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-border/60 bg-background/40 text-xs text-muted-foreground">
        {t('detailPanel.noSubAgentRecords')}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-background/30">
      <div className="border-b border-border/60 px-3 py-2.5">
        <div className="flex items-center gap-3">
          <div className="flex size-8 items-center justify-center rounded-xl border border-border/60 bg-muted/25 text-foreground/80">
            <Bot className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold text-foreground/92">
                {t('subAgentsPanel.title', { defaultValue: '任务执行' })}
              </h2>
              <Badge variant="secondary" className="h-5 rounded-full px-2 text-[10px]">
                {visibleCount}
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground/65">
              {t('subAgentsPanel.subtitle', {
                defaultValue: '运行中置顶，历史按日期分组，结果优先展示'
              })}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-full text-muted-foreground hover:text-foreground"
            onClick={() => setRightPanelOpen(false)}
            title={t('rightPanel.collapse')}
          >
            <PanelLeftClose className="size-4" />
          </Button>
        </div>

        <div className="mt-2 flex flex-wrap gap-1.5">
          {(
            [
              ['all', t('subAgentsPanel.filterAll', { defaultValue: '全部' })],
              ['running', t('subAgentsPanel.filterRunning', { defaultValue: '运行中' })],
              ['completed', t('subAgentsPanel.filterCompleted', { defaultValue: '已完成' })],
              ['today', t('subAgentsPanel.filterToday', { defaultValue: '今天' })]
            ] as Array<[PanelFilter, string]>
          ).map(([value, label]) => {
            const active = filter === value
            return (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors',
                  active
                    ? 'border-foreground/15 bg-foreground/8 text-foreground'
                    : 'border-border/60 bg-background/55 text-muted-foreground hover:text-foreground'
                )}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2.5">
        {runningAgents.length > 0 ? (
          <section className="mb-4">
            <div className="mb-2 flex items-center gap-2 px-1 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground/60">
              <Loader2 className="size-3 animate-spin" />
              <span>{t('subAgentsPanel.running', { defaultValue: '运行中' })}</span>
            </div>
            <div className="space-y-3">
              {runningAgents.map((agent) => (
                <SubAgentRunCard
                  key={agent.toolUseId}
                  agent={agent}
                  now={now}
                  expanded={!!expandedIds[agent.toolUseId]}
                  highlighted={selectedToolUseId === agent.toolUseId}
                  onToggle={() => {
                    setSelectedToolUseId(agent.toolUseId)
                    setExpandedIds((prev) => ({
                      ...prev,
                      [agent.toolUseId]: !prev[agent.toolUseId]
                    }))
                  }}
                  onOpenDetail={() => {
                    setSelectedToolUseId(agent.toolUseId)
                    openSubAgentExecutionDetail(agent.toolUseId)
                  }}
                />
              ))}
            </div>
          </section>
        ) : null}

        {completedGroups.map((group) => (
          <section key={group.label} className="mb-4 last:mb-0">
            <div className="mb-2 flex items-center gap-2 px-1 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground/60">
              <CalendarDays className="size-3" />
              <span>{group.label}</span>
            </div>
            <div className="space-y-3">
              {group.items.map((agent) => (
                <SubAgentRunCard
                  key={agent.toolUseId}
                  agent={agent}
                  now={now}
                  expanded={!!expandedIds[agent.toolUseId]}
                  highlighted={selectedToolUseId === agent.toolUseId}
                  onToggle={() => {
                    setSelectedToolUseId(agent.toolUseId)
                    setExpandedIds((prev) => ({
                      ...prev,
                      [agent.toolUseId]: !prev[agent.toolUseId]
                    }))
                  }}
                  onOpenDetail={() => {
                    setSelectedToolUseId(agent.toolUseId)
                    openSubAgentExecutionDetail(agent.toolUseId)
                  }}
                />
              ))}
            </div>
          </section>
        ))}

        {visibleCount === 0 ? (
          <div className="flex min-h-[240px] items-center justify-center rounded-2xl border border-dashed border-border/60 bg-background/40 text-sm text-muted-foreground">
            {t('subAgentsPanel.emptyFiltered', {
              defaultValue: '当前筛选条件下暂无执行记录'
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function SubAgentRunHoverContent({
  agent,
  displayName,
  icon,
  isFailed
}: {
  agent: SubAgentState
  displayName: string
  icon: React.ReactNode
  isFailed: boolean
}): React.JSX.Element {
  const summary = getAgentSummary(agent)
  const visibleToolCalls = agent.toolCalls.slice(-8)

  return (
    <HoverCardContent
      side="left"
      align="start"
      className="w-[min(32rem,calc(100vw-3rem))] border-white/10 bg-[#141414]/98 p-0 text-white shadow-2xl backdrop-blur"
    >
      <div className="space-y-3 p-3">
        <div className="flex items-center gap-2 border-b border-white/10 pb-3">
          <div className="flex size-8 items-center justify-center rounded-full border border-white/10 bg-[#1b1b1b] text-white/82">
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-white/88">{displayName}</div>
            <div className="mt-0.5 text-[11px] text-white/45">
              {agent.isRunning ? '运行中' : isFailed ? '失败' : '已完成'}
            </div>
          </div>
          <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-white/60">
            {agent.toolCalls.length} tools
          </span>
        </div>

        {agent.description ? (
          <section className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-white/40">
              <FileText className="size-3" />
              <span>描述</span>
            </div>
            <div className="whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 text-[12px] leading-5 text-white/72">
              {agent.description}
            </div>
          </section>
        ) : null}

        {agent.prompt ? (
          <section className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-white/40">
              <ScrollText className="size-3" />
              <span>Prompt</span>
            </div>
            <div className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 text-[12px] leading-5 text-white/72">
              {agent.prompt}
            </div>
          </section>
        ) : null}

        {summary ? (
          <section className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-white/40">
              <Sparkles className="size-3" />
              <span>{agent.isRunning ? '最近进度' : '结果摘要'}</span>
            </div>
            <div className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 text-[12px] leading-5 text-white/72">
              {summary}
            </div>
          </section>
        ) : null}

        <section className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-white/40">
            <Wrench className="size-3" />
            <span>执行列表</span>
            <span className="text-white/28">{agent.toolCalls.length}</span>
          </div>
          {visibleToolCalls.length > 0 ? (
            <div className="max-h-44 overflow-y-auto rounded-lg border border-white/10 bg-white/[0.03]">
              {visibleToolCalls.map((toolCall) => (
                <div
                  key={toolCall.id}
                  className="flex items-center gap-2 border-b border-white/6 px-2.5 py-2 last:border-b-0"
                >
                  <span className="size-1.5 shrink-0 rounded-full bg-white/30" />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-white/74">
                    {toolCall.name}
                  </span>
                  <span
                    className={cn(
                      'rounded-full border px-1.5 py-0.5 text-[10px]',
                      getToolCallStatusClass(toolCall.status)
                    )}
                  >
                    {getToolCallStatusLabel(toolCall.status)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-white/10 bg-white/[0.02] px-2.5 py-2 text-[12px] text-white/45">
              暂无工具调用记录
            </div>
          )}
        </section>
      </div>
    </HoverCardContent>
  )
}

function SubAgentRunCard({
  agent,
  now,
  expanded,
  highlighted,
  onToggle,
  onOpenDetail
}: {
  agent: SubAgentState
  now: number
  expanded: boolean
  highlighted: boolean
  onToggle: () => void
  onOpenDetail: () => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const displayName = agent.displayName ?? agent.name
  const summary = getAgentSummary(agent)
  const previewText = getPreviewText(summary, agent.isRunning)
  const icon = getAgentIcon(displayName)
  const elapsed = formatElapsed((agent.completedAt ?? now) - agent.startedAt)
  const isFailed = agent.success === false || !!agent.errorMessage

  const header = (
    <button type="button" onClick={onToggle} className="w-full px-3 py-3 text-left">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 items-center justify-center rounded-xl border border-border/60 bg-muted/25 text-foreground/80">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-sm font-semibold text-foreground/92">
              {displayName}
            </span>
            <Badge
              variant={isFailed ? 'destructive' : 'secondary'}
              className={cn(
                'h-4.5 rounded-full border border-border/60 bg-background/70 px-1.5 text-[9px] font-medium text-foreground/70',
                agent.isRunning && 'border-cyan-500/30 bg-cyan-500/10 text-cyan-100',
                isFailed && 'border-destructive/40 bg-destructive/10 text-destructive'
              )}
            >
              {agent.isRunning
                ? t('subAgentsPanel.running', { defaultValue: '运行中' })
                : isFailed
                  ? t('detailPanel.error', { defaultValue: '失败' })
                  : t('subAgentsPanel.completed', { defaultValue: '已完成' })}
            </Badge>
          </div>

          {agent.description ? (
            <p className="mt-1 line-clamp-1 whitespace-pre-wrap break-words text-xs text-muted-foreground/70">
              {agent.description}
            </p>
          ) : null}

          {previewText ? (
            <div className="mt-2 rounded-xl border border-border/60 bg-muted/20 px-2.5 py-2">
              <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/55">
                <Sparkles className="size-3" />
                <span>
                  {agent.isRunning
                    ? t('subAgentsPanel.recentProgress', { defaultValue: '最近进度' })
                    : t('subAgentsPanel.summary', { defaultValue: '结果摘要' })}
                </span>
              </div>
              <p className="line-clamp-4 whitespace-pre-wrap break-words text-[12px] leading-5 text-foreground/88">
                {previewText}
              </p>
            </div>
          ) : (
            <div className="mt-3 rounded-2xl border border-dashed border-border/60 bg-muted/15 px-3 py-3 text-sm text-muted-foreground/65">
              {agent.isRunning
                ? t('subAgentsPanel.summaryStreaming', {
                    defaultValue: '正在生成进度摘要…'
                  })
                : t('subAgentsPanel.summaryEmpty', { defaultValue: '暂无可展示摘要' })}
            </div>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground/65">
            <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/70 px-2.5 py-1">
              <Clock3 className="size-3" />
              {elapsed}
            </span>
            <span className="rounded-full border border-border/60 bg-background/70 px-2.5 py-1">
              {t('detailPanel.iterations', {
                count: agent.iteration,
                defaultValue: `迭代：${agent.iteration}`
              })}
            </span>
            <span className="rounded-full border border-border/60 bg-background/70 px-2.5 py-1">
              {t('detailPanel.toolCalls', {
                count: agent.toolCalls.length,
                defaultValue: `工具调用：${agent.toolCalls.length}`
              })}
            </span>
            <span className="rounded-full border border-border/60 bg-background/70 px-2.5 py-1">
              {formatDateTime(agent.completedAt ?? agent.startedAt)}
            </span>
          </div>
        </div>
        <div className="mt-1 text-muted-foreground/50">
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </div>
      </div>
    </button>
  )

  return (
    <div
      data-subagent-card={agent.toolUseId}
      className={cn(
        'overflow-hidden rounded-xl border bg-background/70 transition-colors',
        highlighted
          ? 'border-foreground/15 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]'
          : 'border-border/60 hover:border-border'
      )}
    >
      {agent.description || agent.prompt || agent.toolCalls.length > 0 ? (
        <HoverCard>
          <HoverCardTrigger asChild>{header}</HoverCardTrigger>
          <SubAgentRunHoverContent
            agent={agent}
            displayName={displayName}
            icon={icon}
            isFailed={isFailed}
          />
        </HoverCard>
      ) : (
        header
      )}

      {expanded ? (
        <div className="border-t border-border/60 px-3 py-3">
          <div className="grid gap-4">
            <div className="min-w-0 space-y-4">
              <section>
                <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/55">
                  {t('subAgentsPanel.reportBody', { defaultValue: '结果正文' })}
                </div>
                {summary ? (
                  <div className="prose prose-sm max-w-none prose-headings:text-foreground prose-p:text-foreground/90 prose-li:text-foreground/90 prose-strong:text-foreground dark:prose-invert">
                    <Markdown remarkPlugins={[remarkGfm]}>{summary}</Markdown>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground/70">
                    {agent.reportStatus === 'retrying'
                      ? t('subAgentsPanel.reportStatusRetrying', { defaultValue: '补救中' })
                      : agent.reportStatus === 'missing'
                        ? t('subAgentsPanel.reportMissing', { defaultValue: '未捕获到最终结果。' })
                        : t('subAgentsPanel.reportPending', {
                            defaultValue: '当前执行尚未产出最终结果。'
                          })}
                  </div>
                )}
              </section>

              {agent.toolCalls.length > 0 ? (
                <section>
                  <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/55">
                    {t('subAgentsPanel.execution', { defaultValue: '执行过程' })}
                  </div>
                  <div className="space-y-2">
                    {agent.toolCalls.slice(-8).map((toolCall) => (
                      <div
                        key={toolCall.id}
                        className="rounded-xl border border-border/60 bg-background/60 px-3 py-2.5"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/88">
                            {toolCall.name}
                          </span>
                          <span
                            className={cn(
                              'rounded-full border px-1.5 py-0.5 text-[10px]',
                              getToolCallStatusClass(toolCall.status)
                            )}
                          >
                            {getToolCallStatusLabel(toolCall.status)}
                          </span>
                        </div>
                        {toolCall.error ? (
                          <p className="mt-1 whitespace-pre-wrap break-words text-xs text-destructive">
                            {toolCall.error}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>

            <aside className="space-y-3 rounded-xl border border-border/60 bg-muted/15 p-3">
              <section>
                <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/55">
                  {t('subAgentsPanel.description', { defaultValue: '描述' })}
                </div>
                <div className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground/88">
                  {agent.description || '—'}
                </div>
              </section>
              <Button className="w-full gap-2" onClick={onOpenDetail}>
                {t('subAgentsPanel.openFullDetail', { defaultValue: '打开完整详情' })}
                <ExternalLink className="size-4" />
              </Button>
            </aside>
          </div>
        </div>
      ) : null}
    </div>
  )
}
