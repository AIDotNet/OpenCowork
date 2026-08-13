import stringWidth from 'string-width'
import { formatTokenCount } from './metrics.js'
import { fitText, wrapText } from './text.js'
import type { Message, SubAgentDisplay, SubAgentDisplayPatch, SubAgentPhase } from '../types.js'

export type ToolMessage = Extract<Message, { kind: 'tool' }>

export type SubAgentToolMessage = ToolMessage & { subAgent: SubAgentDisplay }

export type TranscriptBlock =
  | { kind: 'message'; message: Message }
  | { kind: 'subAgentGroup'; messages: SubAgentToolMessage[] }

const ACTIVITY_INDENT = '       '
const BRANCH_PREFIX = '  └─ '
const DROP_ORDER: Array<'tokens' | 'effort' | 'model' | 'tools' | 'elapsed'> = [
  'tokens',
  'effort',
  'model',
  'tools',
  'elapsed'
]

const PRIMARY_INPUT_KEYS = [
  'description',
  'command',
  'file_path',
  'notebook_path',
  'pattern',
  'path',
  'title',
  'subject',
  'query',
  'symbol',
  'taskId',
  'task_id'
] as const

export function isSubAgentToolMessage(message: Message): message is SubAgentToolMessage {
  return message.kind === 'tool' && message.subAgent !== undefined
}

export function isOpenSubAgentPhase(phase: SubAgentPhase): boolean {
  return phase === 'queued' || phase === 'starting' || phase === 'running'
}

export function mergeSubAgentDisplay(
  current: SubAgentDisplay | undefined,
  patch: SubAgentDisplayPatch
): SubAgentDisplay {
  return {
    name: patch.name ?? current?.name ?? 'sub-agent',
    description: patch.description ?? current?.description ?? '',
    model: patch.model ?? current?.model,
    effort: patch.effort ?? current?.effort,
    toolCount: patch.toolCount ?? current?.toolCount ?? 0,
    tokens: patch.tokens ?? current?.tokens,
    startedAt: patch.startedAt ?? current?.startedAt ?? Date.now(),
    completedAt: patch.completedAt ?? current?.completedAt,
    currentActivity:
      patch.currentActivity !== undefined ? patch.currentActivity : current?.currentActivity,
    phase: patch.phase ?? current?.phase ?? 'queued',
    report: patch.report ?? current?.report
  }
}

export function toolPrimaryField(input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  for (const key of PRIMARY_INPUT_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

export function formatSubAgentActivity(toolName: string, detail?: string): string {
  const name = toolName.trim() || 'tool'
  const trimmed = detail?.replace(/\s+/gu, ' ').trim()
  return trimmed ? `Used ${name} (${trimmed})` : `Used ${name}`
}

export function formatElapsedDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

export function usageTokenTotal(usage: {
  inputTokens?: number | null
  outputTokens?: number | null
  reasoningTokens?: number | null
}): number {
  return Math.max(
    0,
    Math.round((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.reasoningTokens ?? 0))
  )
}

export function groupTranscriptMessages(messages: Message[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = []
  let index = 0
  while (index < messages.length) {
    const message = messages[index]
    if (!message) break
    if (isSubAgentToolMessage(message)) {
      const group: SubAgentToolMessage[] = [message]
      index += 1
      while (index < messages.length) {
        const next = messages[index]
        if (!next || !isSubAgentToolMessage(next)) break
        group.push(next)
        index += 1
      }
      blocks.push({ kind: 'subAgentGroup', messages: group })
      continue
    }
    blocks.push({ kind: 'message', message })
    index += 1
  }
  return blocks
}

export function subAgentGroupRange(
  messages: Message[],
  index: number
): { start: number; end: number } {
  if (index < 0 || index >= messages.length || !isSubAgentToolMessage(messages[index]!)) {
    return { start: index, end: index }
  }
  let start = index
  while (start > 0 && isSubAgentToolMessage(messages[start - 1]!)) start -= 1
  let end = index
  while (end + 1 < messages.length && isSubAgentToolMessage(messages[end + 1]!)) end += 1
  return { start, end }
}

export function subAgentGroupStartIndex(messages: Message[], index: number): number {
  return subAgentGroupRange(messages, index).start
}

export function summarizeSubAgentGroup(
  agents: SubAgentDisplay[],
  now: number
): {
  active: boolean
  done: number
  elapsedMs: number
  failed: number
  queued: number
  running: number
  startedAt: number
  total: number
} {
  const total = agents.length
  const done = agents.filter((agent) => agent.phase === 'completed').length
  const failed = agents.filter((agent) => agent.phase === 'error').length
  const running = agents.filter(
    (agent) => agent.phase === 'running' || agent.phase === 'starting'
  ).length
  const queued = agents.filter((agent) => agent.phase === 'queued').length
  const active = running + queued > 0
  const startedAt = agents.reduce(
    (earliest, agent) => Math.min(earliest, agent.startedAt),
    agents[0]?.startedAt ?? now
  )
  const endedAt = active
    ? now
    : agents.reduce(
        (latest, agent) => Math.max(latest, agent.completedAt ?? agent.startedAt),
        startedAt
      )
  return {
    active,
    done,
    elapsedMs: Math.max(0, endedAt - startedAt),
    failed,
    queued,
    running,
    startedAt,
    total
  }
}

export interface SubAgentRowLayout {
  branch: string
  description: string
  meta: string
  name: string
  status: string
}

interface MetaPiece {
  id: 'elapsed' | 'effort' | 'model' | 'tokens' | 'tools'
  text: string
}

export function layoutSubAgentRow(
  agent: SubAgentDisplay,
  width: number,
  statusLabel: string,
  now: number
): SubAgentRowLayout {
  const branch = BRANCH_PREFIX
  const name = agent.name.trim() || 'sub-agent'
  const status =
    agent.phase === 'completed' ? `  ✓ ${statusLabel}` : `  ${statusLabel}`
  const elapsed = formatElapsedDuration((agent.completedAt ?? now) - agent.startedAt)
  const pieces: MetaPiece[] = []
  if (agent.model) pieces.push({ id: 'model', text: agent.model })
  if (agent.effort) pieces.push({ id: 'effort', text: agent.effort })
  if (agent.toolCount > 0) pieces.push({ id: 'tools', text: `${agent.toolCount} tools` })
  pieces.push({ id: 'elapsed', text: elapsed })
  if (agent.tokens && agent.tokens > 0) {
    pieces.push({ id: 'tokens', text: `${formatTokenCount(agent.tokens)} tok` })
  }

  const prefixWidth = stringWidth(`${branch}${name}`)
  const statusWidth = stringWidth(status)
  let included = pieces
  while (included.length > 0) {
    const description = agent.description ? ` ${agent.description}` : ''
    const used =
      prefixWidth + stringWidth(description) + stringWidth(metaText(included)) + statusWidth
    if (used <= width) break
    const drop = DROP_ORDER.find((id) => included.some((piece) => piece.id === id))
    if (!drop) break
    included = included.filter((piece) => piece.id !== drop)
  }

  const remaining = Math.max(
    0,
    width - prefixWidth - stringWidth(metaText(included)) - statusWidth
  )
  const description = agent.description
    ? fitText(` ${agent.description}`, remaining, remaining >= 1 ? '…' : '')
    : ''

  return {
    branch,
    description,
    meta: metaText(included),
    name,
    status
  }
}

export function formatActivityLine(activity: string, width: number): string {
  return fitText(`${ACTIVITY_INDENT}${activity}`, Math.max(1, width))
}

export function estimateSubAgentGroupLines(
  messages: SubAgentToolMessage[],
  width: number,
  showDetails: boolean,
  expandedIds?: ReadonlySet<string>
): number {
  if (messages.length === 0) return 0
  let lines = 2
  for (const message of messages) {
    const agent = message.subAgent
    lines += 1
    if (isOpenSubAgentPhase(agent.phase) && agent.currentActivity) lines += 1
    const detailed = showDetails || (expandedIds?.has(message.id) ?? false)
    if (detailed && agent.report?.trim()) {
      lines += wrapText(agent.report.trim(), Math.max(1, width - ACTIVITY_INDENT.length)).length
    }
  }
  return lines
}

function metaText(pieces: MetaPiece[]): string {
  return pieces.length > 0 ? ` · ${pieces.map((piece) => piece.text).join(' · ')}` : ''
}
