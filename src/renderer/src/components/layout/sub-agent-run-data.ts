import type { ToolCallState } from '@renderer/lib/agent/types'
import { TASK_TOOL_NAME, parseSubAgentMeta } from '@renderer/lib/agent/sub-agents/create-tool'
import type { ToolResultContent, UnifiedMessage } from '@renderer/lib/api/types'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import type { SubAgentState } from '@renderer/stores/agent-store'

const DAY_MS = 24 * 60 * 60 * 1000

export const EMPTY_SESSION_MESSAGES: UnifiedMessage[] = []

export type SubAgentPanelFilter = 'all' | 'running' | 'completed' | 'today'

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  return `${Math.floor(secs / 60)}m${Math.round(secs % 60)}s`
}

export function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString()
}

export function getAgentSortTime(
  agent: Pick<SubAgentState, 'isRunning' | 'startedAt' | 'completedAt'>
): number {
  return agent.isRunning ? agent.startedAt : (agent.completedAt ?? agent.startedAt)
}

export function getHistoryGroupLabel(
  ts: number,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  const now = new Date()
  const target = new Date(ts)
  const nowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const targetStart = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime()
  const diffDays = Math.floor((nowStart - targetStart) / DAY_MS)

  if (diffDays === 0) return t('subAgentsPanel.groupToday', { defaultValue: 'Today' })
  if (diffDays === 1) return t('subAgentsPanel.groupYesterday', { defaultValue: 'Yesterday' })
  return target.toLocaleDateString()
}

export function isSameDay(ts: number): boolean {
  const now = new Date()
  const target = new Date(ts)
  return (
    now.getFullYear() === target.getFullYear() &&
    now.getMonth() === target.getMonth() &&
    now.getDate() === target.getDate()
  )
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

export function getAgentSummary(agent: SubAgentState): string {
  const failureText = getAgentFailureText(agent)
  if ((agent.success === false || !!agent.errorMessage) && failureText) {
    return failureText
  }
  if (agent.report?.trim()) return agent.report.trim()
  if (agent.streamingText?.trim()) return agent.streamingText.trim()
  return ''
}

export function getPreviewText(text: string, isRunning: boolean): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const limit = isRunning ? 260 : 320
  if (trimmed.length <= limit) return trimmed
  return isRunning ? `...${trimmed.slice(-limit)}` : `${trimmed.slice(0, limit)}...`
}

export function getToolCallStatusLabel(status: ToolCallState['status']): string {
  switch (status) {
    case 'running':
    case 'streaming':
      return 'Running'
    case 'pending_approval':
      return 'Pending approval'
    case 'completed':
      return 'Completed'
    case 'error':
      return 'Failed'
    case 'canceled':
      return 'Cancelled'
    default:
      return status
  }
}

export function getToolCallStatusClass(status: ToolCallState['status']): string {
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

export function matchesAgentFilter(agent: SubAgentState, filter: SubAgentPanelFilter): boolean {
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

export function mergeSessionSubAgents({
  sessionId,
  messages,
  activeSubAgents,
  completedSubAgents,
  subAgentHistory
}: {
  sessionId: string | null
  messages: UnifiedMessage[]
  activeSubAgents: Record<string, SubAgentState>
  completedSubAgents: Record<string, SubAgentState>
  subAgentHistory: SubAgentState[]
}): SubAgentState[] {
  const merged = new Map<string, SubAgentState>()

  for (const agent of buildMessageSubAgents(messages, sessionId)) {
    merged.set(agent.toolUseId, agent)
  }
  for (const agent of subAgentHistory) {
    if (agent.sessionId === sessionId) merged.set(agent.toolUseId, agent)
  }
  for (const agent of Object.values(completedSubAgents)) {
    if (agent.sessionId === sessionId) merged.set(agent.toolUseId, agent)
  }
  for (const agent of Object.values(activeSubAgents)) {
    if (agent.sessionId === sessionId) merged.set(agent.toolUseId, agent)
  }

  return [...merged.values()].sort(
    (left, right) => getAgentSortTime(right) - getAgentSortTime(left)
  )
}
