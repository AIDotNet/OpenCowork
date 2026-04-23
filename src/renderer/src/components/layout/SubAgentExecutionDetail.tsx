import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bot,
  CheckCircle2,
  Clock3,
  Loader2,
  MessageSquareText,
  ScrollText,
  TriangleAlert,
  Wrench,
  X,
  icons
} from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { TranscriptMessageList } from '@renderer/components/chat/TranscriptMessageList'
import { useAgentStore, type SubAgentState } from '@renderer/stores/agent-store'
import { useChatStore } from '@renderer/stores/chat-store'
import type { ContentBlock, ToolResultContent, UnifiedMessage } from '@renderer/lib/api/types'
import { cn } from '@renderer/lib/utils'
import { subAgentRegistry } from '@renderer/lib/agent/sub-agents/registry'
import { parseSubAgentMeta } from '@renderer/lib/agent/sub-agents/create-tool'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'

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

function getReportStatusLabel(
  status: SubAgentState['reportStatus'],
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  switch (status) {
    case 'submitted':
      return t('subAgentsPanel.reportStatusSubmitted', { defaultValue: '结果可用' })
    case 'retrying':
      return t('subAgentsPanel.reportStatusRetrying', { defaultValue: '补救中' })
    case 'fallback':
      return t('subAgentsPanel.reportStatusFallback', { defaultValue: '兜底生成' })
    case 'missing':
      return t('subAgentsPanel.reportStatusMissing', { defaultValue: '缺失' })
    case 'pending':
    default:
      return t('subAgentsPanel.reportStatusPending', { defaultValue: '待生成' })
  }
}

function getAgentIcon(agentName: string): React.ReactNode {
  const def = subAgentRegistry.get(agentName)
  if (def?.icon && def.icon in icons) {
    const IconComp = icons[def.icon as keyof typeof icons]
    return <IconComp className="size-4" />
  }
  return <Bot className="size-4" />
}

function findTargetAgent(
  toolUseId: string | null | undefined,
  activeSessionId: string | null,
  activeSubAgents: Record<string, SubAgentState>,
  completedSubAgents: Record<string, SubAgentState>,
  subAgentHistory: SubAgentState[]
): SubAgentState | null {
  if (!toolUseId) return null

  const direct =
    activeSubAgents[toolUseId] ??
    completedSubAgents[toolUseId] ??
    subAgentHistory.find((item) => item.toolUseId === toolUseId)
  if (!direct) return null

  if (!activeSessionId) return direct
  if (!direct.sessionId || direct.sessionId === activeSessionId) return direct

  return (
    subAgentHistory.find(
      (item) => item.toolUseId === toolUseId && item.sessionId === activeSessionId
    ) ?? direct
  )
}

function getLatestErroredTool(agent: SubAgentState): SubAgentState['toolCalls'][number] | null {
  for (let index = agent.toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = agent.toolCalls[index]
    if (toolCall.status === 'error') return toolCall
  }
  return null
}

function getFailurePrimaryText(agent: SubAgentState): string {
  if (agent.errorMessage?.trim()) return agent.errorMessage.trim()
  const failedTool = getLatestErroredTool(agent)
  if (failedTool?.error?.trim()) return failedTool.error.trim()
  return ''
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

function getFallbackReportFromToolOutput(content?: ToolResultContent): string {
  const rawOutput = extractToolResultText(content)
  if (!rawOutput.trim()) return ''

  const { text } = parseSubAgentMeta(rawOutput)
  const payloadText = text.trim() || rawOutput.trim()
  const decoded = decodeStructuredToolResult(payloadText)

  if (decoded && !Array.isArray(decoded)) {
    if (typeof decoded.result === 'string' && decoded.result.trim()) {
      return decoded.result.trim()
    }
    if (typeof decoded.error === 'string' && decoded.error.trim()) {
      return decoded.error.trim()
    }
  }

  return payloadText
}

function getFallbackReportFromMessages(
  toolUseId: string | null | undefined,
  messages: UnifiedMessage[]
): string {
  if (!toolUseId) return ''

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    if (!Array.isArray(message.content)) continue

    for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = message.content[blockIndex]
      if (block.type !== 'tool_result' || block.toolUseId !== toolUseId) continue

      const report = getFallbackReportFromToolOutput(block.content)
      if (report.trim()) return report.trim()
    }
  }

  return ''
}

function findToolUseInput(
  toolUseId: string | null | undefined,
  messages: UnifiedMessage[]
): Record<string, unknown> | null {
  if (!toolUseId) return null

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue

    const block = message.content.find(
      (item): item is Extract<ContentBlock, { type: 'tool_use' }> =>
        item.type === 'tool_use' && item.id === toolUseId
    )
    if (block) return block.input
  }

  return null
}

function getPromptText(input: Record<string, unknown> | null): string {
  if (!input) return ''
  return [input.prompt, input.query, input.task, input.target]
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .join('\n\n')
}

export function SubAgentExecutionDetail({
  toolUseId,
  inlineText,
  embedded = false,
  onClose
}: {
  toolUseId?: string | null
  inlineText?: string
  embedded?: boolean
  onClose?: () => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const sessionMessages = useChatStore((s) =>
    activeSessionId ? s.getSessionMessages(activeSessionId) : []
  )
  const activeSubAgents = useAgentStore((s) => s.activeSubAgents)
  const completedSubAgents = useAgentStore((s) => s.completedSubAgents)
  const subAgentHistory = useAgentStore((s) => s.subAgentHistory)
  const executedToolCalls = useAgentStore((s) => s.executedToolCalls)

  const agent = React.useMemo(
    () =>
      findTargetAgent(
        toolUseId,
        activeSessionId,
        activeSubAgents,
        completedSubAgents,
        subAgentHistory
      ),
    [toolUseId, activeSessionId, activeSubAgents, completedSubAgents, subAgentHistory]
  )

  const fallbackReportText = React.useMemo(() => {
    const fromMessages = getFallbackReportFromMessages(toolUseId, sessionMessages)
    if (fromMessages) return fromMessages

    return toolUseId
      ? getFallbackReportFromToolOutput(
          executedToolCalls.find((item) => item.id === toolUseId)?.output
        )
      : ''
  }, [toolUseId, sessionMessages, executedToolCalls])

  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    if (!agent?.isRunning) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [agent?.isRunning, agent?.startedAt])

  const fallbackDetailText = (fallbackReportText.trim() || inlineText?.trim() || '').trim()
  const fallbackInput = React.useMemo(
    () => findToolUseInput(toolUseId, sessionMessages),
    [toolUseId, sessionMessages]
  )
  const fallbackDisplayName = fallbackInput
    ? String(fallbackInput.subagent_type ?? fallbackInput.name ?? 'SubAgent')
    : 'SubAgent'
  const fallbackDescription = fallbackInput?.description ? String(fallbackInput.description) : ''
  const fallbackPrompt = getPromptText(fallbackInput)

  if (!agent) {
    if (fallbackDetailText) {
      return (
        <div
          className={cn(
            'flex h-full min-h-0 flex-col',
            embedded ? 'bg-transparent' : 'bg-background'
          )}
        >
          <div className="border-b border-border/60 px-4 py-3">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex size-8 items-center justify-center rounded-xl border border-border/60 bg-muted/25 text-foreground/80">
                {getAgentIcon(fallbackDisplayName)}
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="min-w-0 truncate text-base font-semibold text-foreground/95">
                  {fallbackDisplayName}
                </h2>
                {fallbackDescription ? (
                  <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-[12px] text-muted-foreground/80">
                    {fallbackDescription}
                  </p>
                ) : null}
              </div>
              {onClose ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  onClick={onClose}
                >
                  <X className="size-4" />
                </Button>
              ) : null}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-3">
              {(fallbackDescription || fallbackPrompt) && (
                <section className="rounded-xl border border-border/60 bg-background/70 p-3.5">
                  <div className="mb-3 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/65">
                    <Bot className="size-3.5" />
                    <span>{t('subAgentsPanel.executionInfo', { defaultValue: '执行信息' })}</span>
                  </div>
                  <div className="space-y-3">
                    {fallbackDescription ? (
                      <div>
                        <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground/55">
                          {t('subAgentsPanel.description', { defaultValue: '描述' })}
                        </div>
                        <div className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground/88">
                          {fallbackDescription}
                        </div>
                      </div>
                    ) : null}
                    {fallbackPrompt ? (
                      <div>
                        <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground/55">
                          {t('subAgentsPanel.promptLabel', { defaultValue: 'Prompt' })}
                        </div>
                        <div className="rounded-lg border border-border/60 bg-muted/15 px-3 py-2.5 font-mono text-[12px] leading-5 text-foreground/88 whitespace-pre-wrap break-words">
                          {fallbackPrompt}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </section>
              )}

              <section className="rounded-xl border border-border/60 bg-background/70 p-3.5">
                <div className="mb-3 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/65">
                  <MessageSquareText className="size-3.5" />
                  <span>{t('subAgentsPanel.report', { defaultValue: '最终结果' })}</span>
                </div>
                <div className="prose prose-sm max-w-none prose-headings:text-foreground prose-p:text-foreground/90 prose-li:text-foreground/90 prose-strong:text-foreground dark:prose-invert">
                  <Markdown remarkPlugins={[remarkGfm]}>{fallbackDetailText}</Markdown>
                </div>
              </section>
            </div>
          </div>
        </div>
      )
    }

    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center rounded-2xl border border-dashed border-border/60 bg-background/40 px-6 text-center">
        <Bot className="mb-3 size-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">
          {t('detailPanel.noSubAgentRecords', { defaultValue: '暂无子代理记录' })}
        </p>
      </div>
    )
  }

  const displayName = agent.displayName ?? agent.name
  const elapsed = formatElapsed((agent.completedAt ?? now) - agent.startedAt)
  const failedTool = getLatestErroredTool(agent)
  const failureText = getFailurePrimaryText(agent)
  const failedToolText = failedTool?.error?.trim()
    ? `${failedTool.name}: ${failedTool.error.trim()}`
    : ''
  const summaryText =
    agent.report.trim() ||
    agent.streamingText.trim() ||
    fallbackReportText.trim() ||
    inlineText?.trim() ||
    failureText ||
    ''
  const icon = getAgentIcon(displayName)
  const isFailed = agent.success === false || !!agent.errorMessage

  return (
    <div
      className={cn('flex h-full min-h-0 flex-col', embedded ? 'bg-transparent' : 'bg-background')}
    >
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex size-8 items-center justify-center rounded-xl border border-border/60 bg-muted/25 text-foreground/80">
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 truncate text-base font-semibold text-foreground/95">
                {displayName}
              </h2>
              <Badge
                variant={isFailed ? 'destructive' : 'secondary'}
                className={cn(
                  'h-5 rounded-full border border-border/60 bg-background/70 px-2 text-[10px] font-medium text-foreground/75',
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
              <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-[12px] text-muted-foreground/80">
                {agent.description}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground/70">
              <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/70 px-2.5 py-1">
                <Clock3 className="size-3.5" />
                {elapsed}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/70 px-2.5 py-1">
                <CheckCircle2 className="size-3.5" />
                {t('detailPanel.iterations', {
                  count: agent.iteration,
                  defaultValue: `迭代：${agent.iteration}`
                })}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/70 px-2.5 py-1">
                <Wrench className="size-3.5" />
                {t('detailPanel.toolCalls', {
                  count: agent.toolCalls.length,
                  defaultValue: `工具调用：${agent.toolCalls.length}`
                })}
              </span>
            </div>
          </div>
          {onClose ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-8 rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              onClick={onClose}
            >
              <X className="size-4" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-3">
          <section className="rounded-xl border border-border/60 bg-background/70 p-3.5">
            <div className="mb-3 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/65">
              <Bot className="size-3.5" />
              <span>{t('subAgentsPanel.executionInfo', { defaultValue: '执行信息' })}</span>
            </div>
            <div className="space-y-3">
              <div>
                <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground/55">
                  {t('subAgentsPanel.description', { defaultValue: '描述' })}
                </div>
                <div className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground/88">
                  {agent.description || '—'}
                </div>
              </div>
              <div>
                <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground/55">
                  {t('subAgentsPanel.promptLabel', { defaultValue: 'Prompt' })}
                </div>
                <div className="rounded-lg border border-border/60 bg-muted/15 px-3 py-2.5 font-mono text-[12px] leading-5 text-foreground/88 whitespace-pre-wrap break-words">
                  {agent.prompt || '—'}
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <div>
                  <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground/55">
                    {t('subAgentsPanel.startedAt', { defaultValue: '开始' })}
                  </div>
                  <div className="text-sm text-foreground/88">
                    {formatDateTime(agent.startedAt)}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground/55">
                    {t('subAgentsPanel.finishedAt', { defaultValue: '结束' })}
                  </div>
                  <div className="text-sm text-foreground/88">
                    {formatDateTime(agent.completedAt)}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground/55">
                    {t('subAgentsPanel.statusLabel', { defaultValue: '状态' })}
                  </div>
                  <div className="text-sm text-foreground/88">
                    {getReportStatusLabel(agent.reportStatus, t)}
                  </div>
                </div>
              </div>
            </div>
          </section>

          {isFailed && failureText ? (
            <section className="rounded-xl border border-destructive/35 bg-destructive/5 p-3.5">
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-destructive/80">
                <TriangleAlert className="size-3.5" />
                <span>{t('detailPanel.error', { defaultValue: '失败原因' })}</span>
              </div>
              <div className="space-y-2 text-sm leading-6 text-foreground/90">
                <div className="whitespace-pre-wrap break-words">{failureText}</div>
                {failedToolText && failedToolText !== failureText ? (
                  <div className="rounded-lg border border-destructive/20 bg-background/50 px-3 py-2 text-xs text-muted-foreground/90">
                    {failedToolText}
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          <section className="rounded-xl border border-border/60 bg-background/70 p-3.5">
            <div className="mb-3 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/65">
              <ScrollText className="size-3.5" />
              <span>{t('subAgentsPanel.execution', { defaultValue: '执行过程' })}</span>
              {agent.isRunning ? <Loader2 className="size-3 animate-spin" /> : null}
            </div>
            <div className="min-w-0">
              <TranscriptMessageList
                messages={agent.transcript}
                streamingMessageId={agent.currentAssistantMessageId}
              />
            </div>
          </section>

          <section className="rounded-xl border border-border/60 bg-background/70 p-3.5">
            <div className="mb-3 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/65">
              <MessageSquareText className="size-3.5" />
              <span>{t('subAgentsPanel.report', { defaultValue: '最终结果' })}</span>
            </div>
            {summaryText ? (
              <div className="prose prose-sm max-w-none prose-headings:text-foreground prose-p:text-foreground/90 prose-li:text-foreground/90 prose-strong:text-foreground dark:prose-invert">
                <Markdown remarkPlugins={[remarkGfm]}>{summaryText}</Markdown>
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
        </div>
      </div>
    </div>
  )
}
