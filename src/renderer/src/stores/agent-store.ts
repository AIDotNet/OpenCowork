import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { ToolCallState } from '../lib/agent/types'
import type { SubAgentEvent } from '../lib/agent/sub-agents/types'
import type { ToolResultContent, UnifiedMessage, ContentBlock, TokenUsage } from '../lib/api/types'
import { ipcStorage } from '../lib/ipc/ipc-storage'
import { ipcClient } from '../lib/ipc/ipc-client'
import { IPC } from '../lib/ipc/channels'
import { useTeamStore } from './team-store'
import { sendApprovalResponse } from '../lib/agent/teams/inbox-poller'
import { sendPlanApprovalResponse } from '../lib/agent/teams/plan-approval-bridge'
import { summarizeToolInputForHistory } from '../lib/tools/tool-input-sanitizer'

// Approval resolvers live outside the store — they hold non-serializable
// callbacks and don't need to trigger React re-renders.
const approvalResolvers = new Map<string, (approved: boolean) => void>()
const approvalMetadata = new Map<
  string,
  { requestId: string; replyTo: string; source: 'teammate' | 'teammate-plan' }
>()

const MAX_TRACKED_TOOL_CALLS = 200
const MAX_TRACKED_SUBAGENT_TOOL_CALLS = 80
const MAX_COMPLETED_SUBAGENTS = 30
const MAX_SUBAGENT_HISTORY = 50
const MAX_STREAMING_TEXT_CHARS = 8_000
const MAX_TOOL_INPUT_PREVIEW_CHARS = 6_000
const MAX_TOOL_OUTPUT_TEXT_CHARS = 8_000
const MAX_TOOL_ERROR_CHARS = 2_000
const MAX_IMAGE_BASE64_CHARS = 4_096
const MAX_BACKGROUND_PROCESS_OUTPUT_CHARS = 12_000
const MAX_BACKGROUND_PROCESS_ENTRIES = 60
const MAX_RUN_CHANGESETS = 40
const BACKGROUND_PROCESS_OUTPUT_FLUSH_MS = 80
const MAX_SUBAGENT_TRANSCRIPT_MESSAGES = 120

function truncateText(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n... [truncated, ${value.length} chars total]`
}

function sigHasEntry(sig: string, value: string): boolean {
  if (!sig || !value) return false
  return sig.split('\u0000').includes(value)
}

function trimSubAgentTranscript(sa: { transcript: UnifiedMessage[] }): void {
  if (sa.transcript.length <= MAX_SUBAGENT_TRANSCRIPT_MESSAGES) return
  const excess = sa.transcript.length - MAX_SUBAGENT_TRANSCRIPT_MESSAGES
  sa.transcript.splice(0, excess)
}

function normalizeToolInput(
  input: Record<string, unknown>,
  toolName?: string
): Record<string, unknown> {
  const summarized = toolName ? summarizeToolInputForHistory(toolName, input) : input
  try {
    const serialized = JSON.stringify(summarized)
    if (serialized.length <= MAX_TOOL_INPUT_PREVIEW_CHARS) return summarized
    return {
      _truncated: true,
      preview: truncateText(serialized, MAX_TOOL_INPUT_PREVIEW_CHARS)
    }
  } catch {
    return { _truncated: true, preview: '[unserializable input]' }
  }
}

function normalizeToolCallInput(
  toolName: string | undefined,
  input: Record<string, unknown>
): Record<string, unknown> {
  return normalizeToolInput(input, toolName)
}

function limitToolResultContent(
  output: ToolResultContent | undefined
): ToolResultContent | undefined {
  if (output === undefined) return undefined
  if (typeof output === 'string') {
    return truncateText(output, MAX_TOOL_OUTPUT_TEXT_CHARS)
  }

  const normalized: Array<
    | { type: 'text'; text: string }
    | {
        type: 'image'
        source: { type: 'base64' | 'url'; mediaType?: string; data?: string; url?: string }
      }
  > = []
  let totalChars = 0

  for (const block of output) {
    if (block.type === 'text') {
      const text = truncateText(block.text, MAX_TOOL_OUTPUT_TEXT_CHARS)
      totalChars += text.length
      normalized.push({ ...block, text })
      if (totalChars >= MAX_TOOL_OUTPUT_TEXT_CHARS) {
        normalized.push({
          type: 'text',
          text: `[tool output truncated after ${MAX_TOOL_OUTPUT_TEXT_CHARS} chars]`
        })
        break
      }
      continue
    }

    if (
      block.type === 'image' &&
      block.source.data &&
      block.source.data.length > MAX_IMAGE_BASE64_CHARS
    ) {
      normalized.push({
        type: 'text',
        text: `[image data omitted, ${block.source.data.length} base64 chars]`
      })
      continue
    }

    normalized.push(block)
  }

  return normalized
}

function normalizeToolCall(tc: ToolCallState): ToolCallState {
  return {
    ...tc,
    input: normalizeToolCallInput(tc.name, tc.input),
    output: limitToolResultContent(tc.output),
    error: tc.error ? truncateText(tc.error, MAX_TOOL_ERROR_CHARS) : tc.error
  }
}

function normalizeToolCallPatch(
  patch: Partial<ToolCallState>,
  toolName?: string
): Partial<ToolCallState> {
  return {
    ...patch,
    ...(patch.input ? { input: normalizeToolCallInput(patch.name ?? toolName, patch.input) } : {}),
    ...(patch.output !== undefined ? { output: limitToolResultContent(patch.output) } : {}),
    ...(patch.error ? { error: truncateText(patch.error, MAX_TOOL_ERROR_CHARS) } : {})
  }
}

function toolCallPatchHasChanges(existing: ToolCallState, patch: Partial<ToolCallState>): boolean {
  for (const [key, nextValue] of Object.entries(patch)) {
    const currentValue = (existing as unknown as Record<string, unknown>)[key]
    if (Object.is(currentValue, nextValue)) continue

    // For object-like fields (input/output), callers may pass new objects with the
    // same content frequently. Avoid forcing a rerender when nothing actually changed.
    if (typeof currentValue === 'object' && typeof nextValue === 'object') {
      try {
        const a = JSON.stringify(currentValue)
        const b = JSON.stringify(nextValue)
        if (a === b) continue
      } catch {
        // If either value can't be stringified, treat it as changed.
      }
    }

    return true
  }
  return false
}

function trimToolCallArray(toolCalls: ToolCallState[]): void {
  if (toolCalls.length <= MAX_TRACKED_TOOL_CALLS) return
  toolCalls.splice(0, toolCalls.length - MAX_TRACKED_TOOL_CALLS)
}

type SubAgentReportStatus = 'pending' | 'submitted' | 'retrying' | 'fallback' | 'missing'

interface SubAgentState {
  name: string
  displayName?: string
  toolUseId: string
  sessionId?: string
  description: string
  prompt: string
  isRunning: boolean
  success: boolean | null
  errorMessage: string | null
  iteration: number
  toolCalls: ToolCallState[]
  streamingText: string
  transcript: UnifiedMessage[]
  currentAssistantMessageId: string | null
  /** Final result text resolved from the sub-agent's actual output. */
  report: string
  reportStatus: SubAgentReportStatus
  usage?: TokenUsage
  startedAt: number
  completedAt: number | null
}

function sumOptionalUsageValue(current?: number, incoming?: number): number | undefined {
  const total = (current ?? 0) + (incoming ?? 0)
  return total || undefined
}

function mergeMessageUsage(
  current: UnifiedMessage['usage'],
  incoming: UnifiedMessage['usage']
): UnifiedMessage['usage'] {
  if (!incoming) return current
  if (!current) {
    return {
      ...incoming,
      requestTimings: incoming.requestTimings ? [...incoming.requestTimings] : undefined
    }
  }

  return {
    inputTokens: current.inputTokens + incoming.inputTokens,
    outputTokens: current.outputTokens + incoming.outputTokens,
    billableInputTokens: sumOptionalUsageValue(
      current.billableInputTokens,
      incoming.billableInputTokens
    ),
    cacheCreationTokens: sumOptionalUsageValue(
      current.cacheCreationTokens,
      incoming.cacheCreationTokens
    ),
    cacheCreation5mTokens: sumOptionalUsageValue(
      current.cacheCreation5mTokens,
      incoming.cacheCreation5mTokens
    ),
    cacheCreation1hTokens: sumOptionalUsageValue(
      current.cacheCreation1hTokens,
      incoming.cacheCreation1hTokens
    ),
    cacheReadTokens: sumOptionalUsageValue(current.cacheReadTokens, incoming.cacheReadTokens),
    reasoningTokens: sumOptionalUsageValue(current.reasoningTokens, incoming.reasoningTokens),
    contextTokens: incoming.contextTokens ?? current.contextTokens,
    totalDurationMs: sumOptionalUsageValue(current.totalDurationMs, incoming.totalDurationMs),
    requestTimings: [...(current.requestTimings ?? []), ...(incoming.requestTimings ?? [])]
  }
}

function finalizeAssistantMessage(
  sa: SubAgentState,
  usage?: UnifiedMessage['usage'],
  providerResponseId?: string,
  clearCurrentMessage = true
): void {
  if (!sa.currentAssistantMessageId) return
  const message = sa.transcript.find((item) => item.id === sa.currentAssistantMessageId)
  if (!message || message.role !== 'assistant') {
    sa.currentAssistantMessageId = null
    return
  }
  if (usage) {
    message.usage = mergeMessageUsage(message.usage, usage)
  }
  if (providerResponseId) {
    message.providerResponseId = providerResponseId
  }
  if (clearCurrentMessage) {
    sa.currentAssistantMessageId = null
  }
}

function trimCompletedSubAgentsMap(map: Record<string, SubAgentState>): void {
  const keys = Object.keys(map)
  if (keys.length <= MAX_COMPLETED_SUBAGENTS) return
  const removeCount = keys.length - MAX_COMPLETED_SUBAGENTS
  for (let i = 0; i < removeCount; i++) {
    delete map[keys[i]]
  }
}

function trimSubAgentHistory(history: SubAgentState[]): void {
  if (history.length <= MAX_SUBAGENT_HISTORY) return
  history.splice(0, history.length - MAX_SUBAGENT_HISTORY)
}

const MAX_HISTORY_TRANSCRIPT_MESSAGES = 20
const MAX_HISTORY_TOOL_CALLS = 30
const MAX_HISTORY_REPORT_CHARS = 4_000

function compactSubAgentForHistory(sa: SubAgentState): SubAgentState {
  return {
    ...sa,
    streamingText: '',
    report:
      sa.report.length > MAX_HISTORY_REPORT_CHARS
        ? `${sa.report.slice(0, MAX_HISTORY_REPORT_CHARS)}\n[truncated]`
        : sa.report,
    toolCalls:
      sa.toolCalls.length > MAX_HISTORY_TOOL_CALLS
        ? sa.toolCalls.slice(-MAX_HISTORY_TOOL_CALLS)
        : sa.toolCalls,
    transcript:
      sa.transcript.length > MAX_HISTORY_TRANSCRIPT_MESSAGES
        ? sa.transcript.slice(-MAX_HISTORY_TRANSCRIPT_MESSAGES)
        : sa.transcript
  }
}

function cloneSubAgentStateSnapshot(sa: SubAgentState): SubAgentState {
  const compacted = compactSubAgentForHistory(sa)
  try {
    return JSON.parse(JSON.stringify(compacted)) as SubAgentState
  } catch {
    return {
      ...compacted,
      toolCalls: compacted.toolCalls.map((toolCall) => ({ ...toolCall })),
      transcript: compacted.transcript.map((message) => ({
        ...message,
        content: Array.isArray(message.content)
          ? JSON.parse(JSON.stringify(message.content))
          : message.content
      }))
    }
  }
}

function upsertSubAgentHistory(history: SubAgentState[], sa: SubAgentState): void {
  const snapshot = cloneSubAgentStateSnapshot(sa)
  const existingIndex = history.findIndex((item) => item.toolUseId === snapshot.toolUseId)
  if (existingIndex !== -1) {
    const existing = history[existingIndex]
    if (
      existing.name === snapshot.name &&
      existing.displayName === snapshot.displayName &&
      existing.toolUseId === snapshot.toolUseId &&
      existing.sessionId === snapshot.sessionId &&
      existing.description === snapshot.description &&
      existing.prompt === snapshot.prompt &&
      existing.isRunning === snapshot.isRunning &&
      existing.success === snapshot.success &&
      existing.errorMessage === snapshot.errorMessage &&
      existing.iteration === snapshot.iteration &&
      existing.streamingText === snapshot.streamingText &&
      existing.currentAssistantMessageId === snapshot.currentAssistantMessageId &&
      existing.report === snapshot.report &&
      existing.reportStatus === snapshot.reportStatus &&
      existing.startedAt === snapshot.startedAt &&
      existing.completedAt === snapshot.completedAt &&
      JSON.stringify(existing.usage) === JSON.stringify(snapshot.usage) &&
      existing.transcript.length === snapshot.transcript.length &&
      existing.toolCalls.length === snapshot.toolCalls.length
    ) {
      return
    }
    history[existingIndex] = snapshot
  } else {
    history.push(snapshot)
  }
  trimSubAgentHistory(history)
}

function getCurrentAssistantBlocks(sa: SubAgentState): ContentBlock[] | null {
  if (!sa.currentAssistantMessageId) return null
  const assistant = sa.transcript.find((message) => message.id === sa.currentAssistantMessageId)
  if (!assistant) return null
  if (!Array.isArray(assistant.content)) {
    assistant.content = []
  }
  return assistant.content
}

function appendThinkingToSubAgent(sa: SubAgentState, thinking: string): void {
  const blocks = getCurrentAssistantBlocks(sa)
  if (!blocks) return
  const last = blocks[blocks.length - 1]
  if (last?.type === 'thinking') {
    last.thinking += thinking
    return
  }
  blocks.push({ type: 'thinking', thinking })
}

function appendThinkingEncryptedToSubAgent(
  sa: SubAgentState,
  encryptedContent: string,
  provider: 'anthropic' | 'openai-responses' | 'google'
): void {
  const blocks = getCurrentAssistantBlocks(sa)
  if (!blocks || !encryptedContent) return

  let target: Extract<ContentBlock, { type: 'thinking' }> | null = null
  let providerMatchedTarget: Extract<ContentBlock, { type: 'thinking' }> | null = null
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (block.type !== 'thinking') continue
    if (!block.encryptedContent) {
      target = block
      break
    }
    if (!providerMatchedTarget && block.encryptedContentProvider === provider) {
      providerMatchedTarget = block
    }
  }

  target = target ?? providerMatchedTarget
  if (target) {
    target.encryptedContent = encryptedContent
    target.encryptedContentProvider = provider
    return
  }

  blocks.push({
    type: 'thinking',
    thinking: '',
    encryptedContent,
    encryptedContentProvider: provider
  })
}

function appendTextToSubAgent(sa: SubAgentState, text: string): void {
  const blocks = getCurrentAssistantBlocks(sa)
  if (!blocks) return
  const last = blocks[blocks.length - 1]
  if (last?.type === 'text') {
    last.text += text
    return
  }
  blocks.push({ type: 'text', text })
}

function appendBlockToSubAgent(sa: SubAgentState, block: ContentBlock): void {
  const blocks = getCurrentAssistantBlocks(sa)
  if (!blocks) return
  blocks.push(block)
}

function upsertToolUseBlockInSubAgent(
  sa: SubAgentState,
  block: Extract<ContentBlock, { type: 'tool_use' }>
): void {
  const blocks = getCurrentAssistantBlocks(sa)
  if (!blocks) return
  const existing = blocks.findIndex((item) => item.type === 'tool_use' && item.id === block.id)
  if (existing !== -1) {
    blocks[existing] = block
    return
  }
  blocks.push(block)
}

function updateToolUseInputInSubAgent(
  sa: SubAgentState,
  toolCallId: string,
  partialInput: Record<string, unknown>
): void {
  const blocks = getCurrentAssistantBlocks(sa)
  if (!blocks) return
  const toolUseBlock = blocks.find(
    (item): item is Extract<ContentBlock, { type: 'tool_use' }> =>
      item.type === 'tool_use' && item.id === toolCallId
  )
  if (toolUseBlock) {
    toolUseBlock.input = partialInput
  }
}

function rebuildRunningSubAgentDerived(state: {
  activeSubAgents: Record<string, SubAgentState>
  sessionSubAgentSummaries: Record<string, SubAgentState[]>
  runningSubAgentNamesSig: string
  runningSubAgentSessionIdsSig: string
}): void {
  const runningNames: string[] = []
  const runningSessionIds = new Set<string>()

  for (const subAgent of Object.values(state.activeSubAgents)) {
    if (!subAgent.isRunning) continue
    runningNames.push(subAgent.name)
    if (subAgent.sessionId) runningSessionIds.add(subAgent.sessionId)
  }

  for (const [sessionId, summaries] of Object.entries(state.sessionSubAgentSummaries)) {
    if (summaries.some((subAgent) => subAgent.isRunning)) {
      runningSessionIds.add(sessionId)
    }
  }

  state.runningSubAgentNamesSig = runningNames.join('\u0000')
  state.runningSubAgentSessionIdsSig = Array.from(runningSessionIds).sort().join('\u0000')
}

function buildSubAgentSummary(agent: SubAgentState): SubAgentState {
  return cloneSubAgentStateSnapshot(agent)
}

interface SessionToolCallCache {
  pending: ToolCallState[]
  executed: ToolCallState[]
}

interface SessionSubAgentLiveState {
  active: Record<string, SubAgentState>
  completed: Record<string, SubAgentState>
}

function cloneToolCallArray(toolCalls: ToolCallState[]): ToolCallState[] {
  return toolCalls.map((toolCall) => ({ ...toolCall }))
}

function cloneSubAgentMap(source: Record<string, SubAgentState>): Record<string, SubAgentState> {
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [key, cloneSubAgentStateSnapshot(value)])
  )
}

export interface BackgroundProcessState {
  id: string
  command: string
  cwd?: string
  sessionId?: string
  toolUseId?: string
  description?: string
  source?: string
  status: 'running' | 'exited' | 'stopped' | 'error'
  output: string
  port?: number
  exitCode?: number | null
  createdAt: number
  updatedAt: number
}

interface ProcessListItem {
  id: string
  command: string
  cwd?: string
  port?: number
  createdAt?: number
  running?: boolean
  exitCode?: number | null
  metadata?: {
    source?: string
    sessionId?: string
    toolUseId?: string
    description?: string
  }
}

interface ProcessOutputEvent {
  id: string
  data?: string
  port?: number
  exited?: boolean
  exitCode?: number | null
  metadata?: {
    source?: string
    sessionId?: string
    toolUseId?: string
    description?: string
  }
}

interface BufferedProcessOutputEvent {
  id: string
  data: string
  port?: number
  exited?: boolean
  exitCode?: number | null
  metadata?: {
    source?: string
    sessionId?: string
    toolUseId?: string
    description?: string
  }
}

function appendBackgroundOutput(existing: string, chunk: string): string {
  const next = `${existing}${chunk}`
  if (next.length <= MAX_BACKGROUND_PROCESS_OUTPUT_CHARS) return next
  return truncateText(next, MAX_BACKGROUND_PROCESS_OUTPUT_CHARS)
}

function trimBackgroundProcessMap(map: Record<string, BackgroundProcessState>): void {
  const entries = Object.entries(map).sort((a, b) => a[1].updatedAt - b[1].updatedAt)
  if (entries.length <= MAX_BACKGROUND_PROCESS_ENTRIES) return
  const removeCount = entries.length - MAX_BACKGROUND_PROCESS_ENTRIES
  for (let i = 0; i < removeCount; i++) {
    delete map[entries[i][0]]
  }
}

function buildBackgroundProcessSummary(process: BackgroundProcessState): BackgroundProcessState {
  return {
    ...process,
    output: ''
  }
}

function applyProcessOutputEvent(
  existing: BackgroundProcessState | undefined,
  payload: BufferedProcessOutputEvent,
  now: number
): BackgroundProcessState {
  const next: BackgroundProcessState = existing
    ? { ...existing }
    : {
        id: payload.id,
        command: '',
        cwd: undefined,
        sessionId: payload.metadata?.sessionId,
        toolUseId: payload.metadata?.toolUseId,
        description: payload.metadata?.description,
        source: payload.metadata?.source,
        status: payload.exited ? 'exited' : 'running',
        output: '',
        port: payload.port,
        exitCode: payload.exitCode,
        createdAt: now,
        updatedAt: now
      }

  if (payload.data) {
    next.output = appendBackgroundOutput(next.output, payload.data)
  }
  if (payload.port) next.port = payload.port
  if (payload.metadata) {
    next.sessionId = payload.metadata.sessionId ?? next.sessionId
    next.toolUseId = payload.metadata.toolUseId ?? next.toolUseId
    next.description = payload.metadata.description ?? next.description
    next.source = payload.metadata.source ?? next.source
  }
  if (payload.exited) {
    next.status = next.status === 'stopped' ? 'stopped' : 'exited'
    next.exitCode = payload.exitCode
  }
  next.updatedAt = now

  return next
}

export type { SubAgentState }

export interface AgentFileSnapshot {
  exists: boolean
  text?: string
  previewText?: string
  tailPreviewText?: string
  textOmitted?: boolean
  hash: string | null
  size: number
  lineCount?: number
}

export interface AgentRunFileChange {
  id: string
  runId: string
  sessionId?: string
  toolUseId?: string
  toolName?: string
  filePath: string
  transport: 'local' | 'ssh'
  connectionId?: string
  op: 'create' | 'modify'
  status: 'open' | 'accepted' | 'reverted' | 'conflicted'
  before: AgentFileSnapshot
  after: AgentFileSnapshot
  createdAt: number
  acceptedAt?: number
  revertedAt?: number
  conflict?: string
}

export interface AgentRunChangeSet {
  runId: string
  sessionId?: string
  assistantMessageId: string
  status: 'open' | 'partial' | 'accepted' | 'reverting' | 'reverted' | 'conflicted'
  changes: AgentRunFileChange[]
  createdAt: number
  updatedAt: number
}

function isAgentChangeError(value: unknown): value is { error: string } {
  if (!value || typeof value !== 'object') return false
  return typeof (value as { error?: unknown }).error === 'string'
}

function trimRunChangesMap(map: Record<string, AgentRunChangeSet>): void {
  const entries = Object.entries(map).sort((a, b) => a[1].updatedAt - b[1].updatedAt)
  if (entries.length <= MAX_RUN_CHANGESETS) return
  const removeCount = entries.length - MAX_RUN_CHANGESETS
  for (let index = 0; index < removeCount; index += 1) {
    delete map[entries[index][0]]
  }
}

function ensureSessionToolCallCache(
  state: {
    sessionToolCallsCache: Record<string, SessionToolCallCache>
  },
  sessionId: string
): SessionToolCallCache {
  const existing = state.sessionToolCallsCache[sessionId]
  if (existing) return existing
  const created: SessionToolCallCache = { pending: [], executed: [] }
  state.sessionToolCallsCache[sessionId] = created
  return created
}

function resolveSessionToolCallTarget(
  state: {
    liveSessionId: string | null
    pendingToolCalls: ToolCallState[]
    executedToolCalls: ToolCallState[]
    sessionToolCallsCache: Record<string, SessionToolCallCache>
  },
  sessionId?: string | null
): SessionToolCallCache {
  if (!sessionId || sessionId === state.liveSessionId) {
    return {
      pending: state.pendingToolCalls,
      executed: state.executedToolCalls
    }
  }
  return ensureSessionToolCallCache(state, sessionId)
}

function applyToolCallToBuckets(
  pending: ToolCallState[],
  executed: ToolCallState[],
  tc: ToolCallState
): void {
  const normalizedTc = normalizeToolCall(tc)
  const execIdx = executed.findIndex((item) => item.id === normalizedTc.id)
  if (execIdx !== -1) {
    if (normalizedTc.status === 'pending_approval') {
      const [moved] = executed.splice(execIdx, 1)
      Object.assign(moved, normalizedTc)
      pending.push(moved)
    } else {
      Object.assign(executed[execIdx], normalizedTc)
    }
    trimToolCallArray(executed)
    trimToolCallArray(pending)
    return
  }

  const pendingIdx = pending.findIndex((item) => item.id === normalizedTc.id)
  if (pendingIdx !== -1) {
    if (normalizedTc.status !== 'pending_approval') {
      const [moved] = pending.splice(pendingIdx, 1)
      Object.assign(moved, normalizedTc)
      executed.push(moved)
    } else {
      Object.assign(pending[pendingIdx], normalizedTc)
    }
    trimToolCallArray(executed)
    trimToolCallArray(pending)
    return
  }

  if (normalizedTc.status === 'pending_approval') {
    pending.push(normalizedTc)
  } else {
    executed.push(normalizedTc)
  }
  trimToolCallArray(executed)
  trimToolCallArray(pending)
}

function applyToolCallPatchToBuckets(
  pending: ToolCallState[],
  executed: ToolCallState[],
  id: string,
  patch: Partial<ToolCallState>
): boolean {
  const pendingToolCall = pending.find((item) => item.id === id)
  const executedToolCall = executed.find((item) => item.id === id)
  const normalizedPatch = normalizeToolCallPatch(
    patch,
    pendingToolCall?.name ?? executedToolCall?.name
  )
  if (pendingToolCall) {
    if (!toolCallPatchHasChanges(pendingToolCall, normalizedPatch)) return false
    Object.assign(pendingToolCall, normalizedPatch)
    if (normalizedPatch.status && normalizedPatch.status !== 'pending_approval') {
      const index = pending.findIndex((item) => item.id === id)
      if (index !== -1) {
        const [moved] = pending.splice(index, 1)
        executed.push(moved)
      }
    }
    trimToolCallArray(executed)
    trimToolCallArray(pending)
    return true
  }

  if (executedToolCall) {
    if (!toolCallPatchHasChanges(executedToolCall, normalizedPatch)) return false
    Object.assign(executedToolCall, normalizedPatch)
    trimToolCallArray(executed)
    return true
  }

  return false
}

interface AgentStore {
  isRunning: boolean
  currentLoopId: string | null
  liveSessionId: string | null
  pendingToolCalls: ToolCallState[]
  executedToolCalls: ToolCallState[]
  runChangesByRunId: Record<string, AgentRunChangeSet>
  sessionSubAgentSummaries: Record<string, SubAgentState[]>
  sessionBackgroundProcessSummaries: Record<string, BackgroundProcessState[]>

  /** Per-session agent running state for sidebar indicators */
  runningSessions: Record<string, 'running' | 'completed'>

  /** Per-session tool-call cache — stores tool calls when switching away from a session */
  sessionToolCallsCache: Record<string, SessionToolCallCache>
  sessionSubAgentLiveCache: Record<string, SessionSubAgentLiveState>

  // SubAgent state keyed by toolUseId (supports multiple same-name SubAgent calls)
  activeSubAgents: Record<string, SubAgentState>
  /** Completed SubAgent results keyed by toolUseId — survives until clearToolCalls */
  completedSubAgents: Record<string, SubAgentState>
  /** Historical SubAgent records — persisted across agent runs */
  subAgentHistory: SubAgentState[]
  /** Derived signature of currently running SubAgent names */
  runningSubAgentNamesSig: string
  /** Derived signature of session IDs that currently have running SubAgents */
  runningSubAgentSessionIdsSig: string

  /** Tool names approved by user during this session — auto-approve on repeat */
  approvedToolNames: string[]
  addApprovedTool: (name: string) => void

  /** Background command sessions (spawned by Bash with run_in_background=true) */
  backgroundProcesses: Record<string, BackgroundProcessState>
  /** Foreground shell exec mapping (toolUseId -> execId), used for in-card stop actions */
  foregroundShellExecByToolUseId: Record<string, string>
  initBackgroundProcessTracking: () => Promise<void>
  registerForegroundShellExec: (toolUseId: string, execId: string) => void
  clearForegroundShellExec: (toolUseId: string) => void
  abortForegroundShellExec: (toolUseId: string) => Promise<void>
  registerBackgroundProcess: (process: {
    id: string
    command: string
    cwd?: string
    sessionId?: string
    toolUseId?: string
    description?: string
    source?: string
  }) => void
  stopBackgroundProcess: (id: string) => Promise<void>
  sendBackgroundProcessInput: (id: string, input: string, appendNewline?: boolean) => Promise<void>
  removeBackgroundProcess: (id: string) => void

  setRunning: (running: boolean) => void
  setCurrentLoopId: (id: string | null) => void
  /** Update per-session status. 'completed' auto-clears after ~3 s. null removes entry. */
  setSessionStatus: (sessionId: string, status: 'running' | 'completed' | null) => void
  isSessionActive: (sessionId: string | null | undefined) => boolean
  /** Switch active tool-call context: save current tool calls for prevSession, restore for nextSession */
  switchToolCallSession: (prevSessionId: string | null, nextSessionId: string | null) => void
  resetLiveSessionExecution: (sessionId: string) => void
  addToolCall: (tc: ToolCallState, sessionId?: string | null) => void
  updateToolCall: (id: string, patch: Partial<ToolCallState>, sessionId?: string | null) => void
  refreshRunChanges: (runId: string) => Promise<void>
  acceptRunChanges: (runId: string) => Promise<{ error?: string }>
  acceptFileChange: (runId: string, changeId: string) => Promise<{ error?: string }>
  rollbackRunChanges: (runId: string) => Promise<{ error?: string }>
  rollbackFileChange: (runId: string, changeId: string) => Promise<{ error?: string }>
  clearToolCalls: () => void
  abort: () => void

  // SubAgent events
  handleSubAgentEvent: (event: SubAgentEvent, sessionId?: string) => void

  /** Remove all subagent / tool-call data that belongs to the given session */
  clearSessionData: (sessionId: string) => void
  releaseDormantSessionData: (residentSessionIds: string[]) => void

  // Approval flow
  requestApproval: (toolCallId: string) => Promise<boolean>
  registerApprovalSource: (
    toolCallId: string,
    meta: { requestId: string; replyTo: string; source?: 'teammate' | 'teammate-plan' }
  ) => void
  resolveApproval: (toolCallId: string, approved: boolean) => void
  /** Resolve all pending approvals as denied and clear pendingToolCalls (e.g. on team delete) */
  clearPendingApprovals: () => void
}

let processTrackingInitialized = false

export const useAgentStore = create<AgentStore>()(
  persist(
    immer((set, get) => ({
      isRunning: false,
      currentLoopId: null,
      liveSessionId: null,
      pendingToolCalls: [],
      executedToolCalls: [],
      runChangesByRunId: {},
      runningSessions: {},
      sessionToolCallsCache: {},
      sessionSubAgentLiveCache: {},
      activeSubAgents: {},
      completedSubAgents: {},
      subAgentHistory: [],
      runningSubAgentNamesSig: '',
      runningSubAgentSessionIdsSig: '',
      approvedToolNames: [],
      sessionSubAgentSummaries: {},
      sessionBackgroundProcessSummaries: {},
      backgroundProcesses: {},
      foregroundShellExecByToolUseId: {},

      setRunning: (running) => set({ isRunning: running }),

      setCurrentLoopId: (id) => set({ currentLoopId: id }),

      setSessionStatus: (sessionId, status) => {
        set((state) => {
          if (status) {
            state.runningSessions[sessionId] = status
          } else {
            delete state.runningSessions[sessionId]
          }
        })
        // Auto-clear 'completed' after 3 seconds
        if (status === 'completed') {
          setTimeout(() => {
            set((state) => {
              if (state.runningSessions[sessionId] === 'completed') {
                delete state.runningSessions[sessionId]
              }
            })
          }, 3000)
        }
      },

      isSessionActive: (sessionId) => {
        if (!sessionId) return false
        const state = get()
        if (state.runningSessions[sessionId] === 'running') return true
        if (sigHasEntry(state.runningSubAgentSessionIdsSig, sessionId)) return true
        if (
          Object.values(state.backgroundProcesses).some(
            (process) => process.sessionId === sessionId && process.status === 'running'
          )
        ) {
          return true
        }
        if (useTeamStore.getState().activeTeam?.sessionId === sessionId) return true
        return false
      },

      switchToolCallSession: (prevSessionId, nextSessionId) => {
        set((state) => {
          if (prevSessionId) {
            state.sessionToolCallsCache[prevSessionId] = {
              pending: cloneToolCallArray(state.pendingToolCalls),
              executed: cloneToolCallArray(state.executedToolCalls)
            }
            state.sessionSubAgentLiveCache[prevSessionId] = {
              active: cloneSubAgentMap(state.activeSubAgents),
              completed: cloneSubAgentMap(state.completedSubAgents)
            }
          }

          const cached = nextSessionId ? state.sessionToolCallsCache[nextSessionId] : undefined
          const subAgentCache = nextSessionId
            ? state.sessionSubAgentLiveCache[nextSessionId]
            : undefined
          state.liveSessionId = nextSessionId
          state.pendingToolCalls = cloneToolCallArray(cached?.pending ?? [])
          state.executedToolCalls = cloneToolCallArray(cached?.executed ?? [])
          state.activeSubAgents = cloneSubAgentMap(subAgentCache?.active ?? {})
          state.completedSubAgents = cloneSubAgentMap(subAgentCache?.completed ?? {})
          rebuildRunningSubAgentDerived(state)

          const cacheKeys = Object.keys(state.sessionToolCallsCache)
          if (cacheKeys.length > 10) {
            const toRemove = cacheKeys.slice(0, cacheKeys.length - 10)
            for (const key of toRemove) {
              delete state.sessionToolCallsCache[key]
              delete state.sessionSubAgentLiveCache[key]
            }
          }
        })
      },

      resetLiveSessionExecution: (sessionId) => {
        set((state) => {
          delete state.sessionToolCallsCache[sessionId]
          delete state.sessionSubAgentLiveCache[sessionId]
          delete state.sessionSubAgentSummaries[sessionId]

          if (state.liveSessionId !== sessionId) return
          state.pendingToolCalls = []
          state.executedToolCalls = []
          state.activeSubAgents = {}
          state.completedSubAgents = {}
          rebuildRunningSubAgentDerived(state)
        })
      },

      addToolCall: (tc, sessionId) => {
        set((state) => {
          const targetSessionId = sessionId ?? tc.sessionId ?? state.liveSessionId
          const target = resolveSessionToolCallTarget(state, targetSessionId)
          applyToolCallToBuckets(target.pending, target.executed, {
            ...tc,
            ...(targetSessionId ? { sessionId: targetSessionId } : {})
          })
        })
      },

      updateToolCall: (id, patch, sessionId) => {
        set((state) => {
          const explicitSessionId = sessionId ?? patch.sessionId ?? null
          if (explicitSessionId) {
            const target = resolveSessionToolCallTarget(state, explicitSessionId)
            if (applyToolCallPatchToBuckets(target.pending, target.executed, id, patch)) return
          }

          if (
            applyToolCallPatchToBuckets(state.pendingToolCalls, state.executedToolCalls, id, patch)
          ) {
            return
          }

          for (const cache of Object.values(state.sessionToolCallsCache)) {
            if (applyToolCallPatchToBuckets(cache.pending, cache.executed, id, patch)) {
              return
            }
          }
        })
      },

      addApprovedTool: (name) => {
        set((state) => {
          if (!state.approvedToolNames.includes(name)) {
            state.approvedToolNames.push(name)
          }
        })
      },

      registerForegroundShellExec: (toolUseId, execId) => {
        set((state) => {
          state.foregroundShellExecByToolUseId[toolUseId] = execId
        })
      },

      clearForegroundShellExec: (toolUseId) => {
        set((state) => {
          delete state.foregroundShellExecByToolUseId[toolUseId]
        })
      },

      abortForegroundShellExec: async (toolUseId) => {
        const execId = useAgentStore.getState().foregroundShellExecByToolUseId[toolUseId]
        if (!execId) return
        ipcClient.send(IPC.SHELL_ABORT, { execId })
        set((state) => {
          delete state.foregroundShellExecByToolUseId[toolUseId]
        })
      },

      initBackgroundProcessTracking: async () => {
        if (processTrackingInitialized) return
        processTrackingInitialized = true

        try {
          const list = (await ipcClient.invoke(IPC.PROCESS_LIST)) as ProcessListItem[]
          set((state) => {
            for (const item of list) {
              const existing = state.backgroundProcesses[item.id]
              const nextProcess = {
                id: item.id,
                command: item.command ?? existing?.command ?? '',
                cwd: item.cwd ?? existing?.cwd,
                sessionId: item.metadata?.sessionId ?? existing?.sessionId,
                toolUseId: item.metadata?.toolUseId ?? existing?.toolUseId,
                description: item.metadata?.description ?? existing?.description,
                source: item.metadata?.source ?? existing?.source,
                status: item.running === false ? 'exited' : 'running',
                output: existing?.output ?? '',
                port: item.port ?? existing?.port,
                exitCode: item.exitCode ?? existing?.exitCode,
                createdAt: item.createdAt ?? existing?.createdAt ?? Date.now(),
                updatedAt: Date.now()
              } satisfies BackgroundProcessState
              state.backgroundProcesses[item.id] = nextProcess
              if (nextProcess.sessionId) {
                const previous =
                  state.sessionBackgroundProcessSummaries[nextProcess.sessionId] ?? []
                state.sessionBackgroundProcessSummaries[nextProcess.sessionId] = [
                  buildBackgroundProcessSummary(nextProcess),
                  ...previous.filter((process) => process.id !== nextProcess.id)
                ].slice(0, MAX_BACKGROUND_PROCESS_ENTRIES)
              }
            }
            trimBackgroundProcessMap(state.backgroundProcesses)
          })
        } catch (err) {
          console.error('[AgentStore] Failed to load process list:', err)
        }

        const bufferedProcessOutputs = new Map<string, BufferedProcessOutputEvent>()
        let bufferedProcessOutputTimer: ReturnType<typeof setTimeout> | null = null

        const flushBufferedProcessOutputs = (): void => {
          if (bufferedProcessOutputTimer) {
            clearTimeout(bufferedProcessOutputTimer)
            bufferedProcessOutputTimer = null
          }
          if (bufferedProcessOutputs.size === 0) return

          const pending = Array.from(bufferedProcessOutputs.values())
          bufferedProcessOutputs.clear()
          set((state) => {
            const now = Date.now()
            for (const payload of pending) {
              const nextProcess = applyProcessOutputEvent(
                state.backgroundProcesses[payload.id],
                payload,
                now
              )
              state.backgroundProcesses[payload.id] = nextProcess
              if (nextProcess.sessionId) {
                const previous =
                  state.sessionBackgroundProcessSummaries[nextProcess.sessionId] ?? []
                state.sessionBackgroundProcessSummaries[nextProcess.sessionId] = [
                  buildBackgroundProcessSummary(nextProcess),
                  ...previous.filter((process) => process.id !== nextProcess.id)
                ].slice(0, MAX_BACKGROUND_PROCESS_ENTRIES)
              }
            }
            trimBackgroundProcessMap(state.backgroundProcesses)
          })
        }

        const scheduleBufferedProcessOutputFlush = (): void => {
          if (bufferedProcessOutputTimer) return
          bufferedProcessOutputTimer = setTimeout(() => {
            flushBufferedProcessOutputs()
          }, BACKGROUND_PROCESS_OUTPUT_FLUSH_MS)
        }

        ipcClient.on(IPC.PROCESS_OUTPUT, (...args: unknown[]) => {
          const payload = args[0] as ProcessOutputEvent | undefined
          if (!payload?.id) return

          const existing = bufferedProcessOutputs.get(payload.id)
          bufferedProcessOutputs.set(payload.id, {
            id: payload.id,
            data: `${existing?.data ?? ''}${payload.data ?? ''}`,
            port: payload.port ?? existing?.port,
            exited: payload.exited ?? existing?.exited,
            exitCode: payload.exitCode ?? existing?.exitCode,
            metadata: payload.metadata
              ? { ...(existing?.metadata ?? {}), ...payload.metadata }
              : existing?.metadata
          })

          if (payload.exited) {
            flushBufferedProcessOutputs()
            return
          }

          scheduleBufferedProcessOutputFlush()
        })
      },

      registerBackgroundProcess: (process) => {
        set((state) => {
          const now = Date.now()
          const nextProcess = {
            id: process.id,
            command: process.command,
            cwd: process.cwd,
            sessionId: process.sessionId,
            toolUseId: process.toolUseId,
            description: process.description,
            source: process.source,
            status: 'running',
            output: state.backgroundProcesses[process.id]?.output ?? '',
            port: state.backgroundProcesses[process.id]?.port,
            exitCode: undefined,
            createdAt: state.backgroundProcesses[process.id]?.createdAt ?? now,
            updatedAt: now
          } satisfies BackgroundProcessState
          state.backgroundProcesses[process.id] = nextProcess
          if (nextProcess.sessionId) {
            const previous = state.sessionBackgroundProcessSummaries[nextProcess.sessionId] ?? []
            state.sessionBackgroundProcessSummaries[nextProcess.sessionId] = [
              buildBackgroundProcessSummary(nextProcess),
              ...previous.filter((item) => item.id !== nextProcess.id)
            ].slice(0, MAX_BACKGROUND_PROCESS_ENTRIES)
          }
          trimBackgroundProcessMap(state.backgroundProcesses)
        })
      },

      stopBackgroundProcess: async (id) => {
        set((state) => {
          const process = state.backgroundProcesses[id]
          if (!process) return
          process.updatedAt = Date.now()
          process.status = 'stopped'
          process.output = appendBackgroundOutput(process.output, '\n[Stopping process...]\n')
        })

        const result = (await ipcClient.invoke(IPC.PROCESS_KILL, { id })) as {
          success?: boolean
          error?: string
        }

        set((state) => {
          const process = state.backgroundProcesses[id]
          if (!process) return
          process.updatedAt = Date.now()
          if (result?.success) {
            process.output = appendBackgroundOutput(process.output, '[Stopped by user]\n')
            return
          }
          if (result?.error && result.error.includes('Process not found')) {
            process.output = appendBackgroundOutput(process.output, '[Process already exited]\n')
            return
          }
          process.status = 'error'
          process.output = appendBackgroundOutput(
            process.output,
            `[Stop failed: ${result?.error ?? 'Unknown error'}]\n`
          )
        })
      },

      sendBackgroundProcessInput: async (id, input, appendNewline = true) => {
        const result = (await ipcClient.invoke(IPC.PROCESS_WRITE, {
          id,
          input,
          appendNewline
        })) as { success?: boolean; error?: string }
        set((state) => {
          const process = state.backgroundProcesses[id]
          if (!process) return
          process.updatedAt = Date.now()
          if (result?.success) {
            const displayInput = input === '\u0003' ? '^C' : input
            process.output = appendBackgroundOutput(process.output, `\n$ ${displayInput}\n`)
            return
          }
          process.status = 'error'
          process.output = appendBackgroundOutput(
            process.output,
            `\n[Input failed: ${result?.error ?? 'Unknown error'}]\n`
          )
        })
      },

      removeBackgroundProcess: (id) => {
        set((state) => {
          delete state.backgroundProcesses[id]
        })
      },

      clearToolCalls: () => {
        set((state) => {
          state.liveSessionId = null
          state.pendingToolCalls = []
          state.executedToolCalls = []
          state.activeSubAgents = {}
          state.completedSubAgents = {}
          state.runningSubAgentNamesSig = ''
          state.runningSubAgentSessionIdsSig = ''
          state.approvedToolNames = []
          state.foregroundShellExecByToolUseId = {}
          state.sessionToolCallsCache = {}
          state.sessionSubAgentLiveCache = {}
          state.sessionSubAgentSummaries = {}
          state.sessionBackgroundProcessSummaries = {}
        })
      },

      refreshRunChanges: async (runId) => {
        if (!runId) return
        try {
          const result = await ipcClient.invoke(IPC.AGENT_CHANGES_LIST, { runId })
          if (isAgentChangeError(result)) return
          set((state) => {
            if (result && typeof result === 'object' && 'runId' in result) {
              state.runChangesByRunId[runId] = result as AgentRunChangeSet
              trimRunChangesMap(state.runChangesByRunId)
            } else {
              delete state.runChangesByRunId[runId]
            }
          })
        } catch {
          // ignore fetch failures for ephemeral change journal state
        }
      },

      acceptRunChanges: async (runId) => {
        if (!runId) return { error: 'runId is required' }
        try {
          const result = await ipcClient.invoke(IPC.AGENT_CHANGES_ACCEPT, { runId })
          if (isAgentChangeError(result)) return { error: result.error }
          const changeset =
            result && typeof result === 'object' && 'changeset' in result
              ? (result as { changeset?: AgentRunChangeSet }).changeset
              : undefined
          set((state) => {
            if (changeset) {
              state.runChangesByRunId[runId] = changeset
              trimRunChangesMap(state.runChangesByRunId)
            }
          })
          return {}
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) }
        }
      },

      acceptFileChange: async (runId, changeId) => {
        if (!runId || !changeId) return { error: 'runId and changeId are required' }
        try {
          const result = await ipcClient.invoke(IPC.AGENT_CHANGES_ACCEPT_FILE, { runId, changeId })
          if (isAgentChangeError(result)) return { error: result.error }
          const changeset =
            result && typeof result === 'object' && 'changeset' in result
              ? (result as { changeset?: AgentRunChangeSet }).changeset
              : undefined
          set((state) => {
            if (changeset) {
              state.runChangesByRunId[runId] = changeset
              trimRunChangesMap(state.runChangesByRunId)
            }
          })
          return {}
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) }
        }
      },

      rollbackRunChanges: async (runId) => {
        if (!runId) return { error: 'runId is required' }
        try {
          const result = await ipcClient.invoke(IPC.AGENT_CHANGES_ROLLBACK, { runId })
          if (isAgentChangeError(result)) return { error: result.error }
          const changeset =
            result && typeof result === 'object' && 'changeset' in result
              ? (result as { changeset?: AgentRunChangeSet }).changeset
              : undefined
          set((state) => {
            if (changeset) {
              state.runChangesByRunId[runId] = changeset
              trimRunChangesMap(state.runChangesByRunId)
            }
          })
          return {}
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) }
        }
      },

      rollbackFileChange: async (runId, changeId) => {
        if (!runId || !changeId) return { error: 'runId and changeId are required' }
        try {
          const result = await ipcClient.invoke(IPC.AGENT_CHANGES_ROLLBACK_FILE, {
            runId,
            changeId
          })
          if (isAgentChangeError(result)) return { error: result.error }
          const changeset =
            result && typeof result === 'object' && 'changeset' in result
              ? (result as { changeset?: AgentRunChangeSet }).changeset
              : undefined
          set((state) => {
            if (changeset) {
              state.runChangesByRunId[runId] = changeset
              trimRunChangesMap(state.runChangesByRunId)
            }
          })
          return {}
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) }
        }
      },

      handleSubAgentEvent: (event, sessionId) => {
        set((state) => {
          const id = event.toolUseId
          const existing = state.activeSubAgents[id] ?? state.completedSubAgents[id]
          switch (event.type) {
            case 'sub_agent_start': {
              if (existing?.isRunning) return
              state.activeSubAgents[id] = {
                name: event.subAgentName,
                displayName: String(event.input.subagent_type ?? event.subAgentName),
                toolUseId: id,
                sessionId,
                description: String(event.input.description ?? ''),
                prompt: String(
                  event.input.prompt ??
                    event.input.query ??
                    event.input.task ??
                    event.input.target ??
                    ''
                ),
                isRunning: true,
                success: null,
                errorMessage: null,
                iteration: 0,
                toolCalls: [],
                streamingText: '',
                transcript: [event.promptMessage],
                currentAssistantMessageId: null,
                report: '',
                reportStatus: 'pending',
                usage: undefined,
                startedAt: Date.now(),
                completedAt: null
              }
              if (sessionId) {
                const previous = state.sessionSubAgentSummaries[sessionId] ?? []
                state.sessionSubAgentSummaries[sessionId] = [
                  buildSubAgentSummary(state.activeSubAgents[id]),
                  ...previous.filter((item) => item.toolUseId !== id)
                ].slice(0, MAX_SUBAGENT_HISTORY)
              }
              rebuildRunningSubAgentDerived(state)
              break
            }
            case 'sub_agent_iteration': {
              const sa = state.activeSubAgents[id] ?? state.completedSubAgents[id]
              if (sa) {
                sa.iteration = event.iteration
                const currentAssistant = sa.currentAssistantMessageId
                  ? sa.transcript.find((item) => item.id === sa.currentAssistantMessageId)
                  : null
                if (!currentAssistant || currentAssistant.role !== 'assistant') {
                  sa.currentAssistantMessageId = event.assistantMessage.id
                  sa.transcript.push(event.assistantMessage)
                }
              }
              break
            }
            case 'sub_agent_thinking_delta': {
              const sa = state.activeSubAgents[id] ?? state.completedSubAgents[id]
              if (sa) appendThinkingToSubAgent(sa, event.thinking)
              break
            }
            case 'sub_agent_thinking_encrypted': {
              const sa = state.activeSubAgents[id] ?? state.completedSubAgents[id]
              if (sa) {
                appendThinkingEncryptedToSubAgent(
                  sa,
                  event.thinkingEncryptedContent,
                  event.thinkingEncryptedProvider
                )
              }
              break
            }
            case 'sub_agent_tool_use_streaming_start': {
              const sa = state.activeSubAgents[id] ?? state.completedSubAgents[id]
              if (sa) {
                upsertToolUseBlockInSubAgent(sa, {
                  type: 'tool_use',
                  id: event.toolCallId,
                  name: event.toolName,
                  input: {},
                  ...(event.toolCallExtraContent
                    ? { extraContent: event.toolCallExtraContent }
                    : {})
                })
              }
              break
            }
            case 'sub_agent_tool_use_args_delta': {
              const sa = state.activeSubAgents[id] ?? state.completedSubAgents[id]
              if (sa) updateToolUseInputInSubAgent(sa, event.toolCallId, event.partialInput)
              break
            }
            case 'sub_agent_tool_use_generated': {
              const sa = state.activeSubAgents[id] ?? state.completedSubAgents[id]
              if (sa) upsertToolUseBlockInSubAgent(sa, event.toolUseBlock)
              break
            }
            case 'sub_agent_image_generated': {
              const sa = state.activeSubAgents[id] ?? state.completedSubAgents[id]
              if (sa) appendBlockToSubAgent(sa, event.imageBlock)
              break
            }
            case 'sub_agent_image_error': {
              const sa = state.activeSubAgents[id] ?? state.completedSubAgents[id]
              if (sa) {
                appendBlockToSubAgent(sa, {
                  type: 'image_error',
                  code: event.imageError.code,
                  message: event.imageError.message
                })
              }
              break
            }
            case 'sub_agent_message_end': {
              const sa = state.activeSubAgents[id] ?? state.completedSubAgents[id]
              if (sa) {
                finalizeAssistantMessage(sa, event.usage, event.providerResponseId, false)
                if (event.usage) {
                  sa.usage = mergeMessageUsage(sa.usage, event.usage)
                }
              }
              break
            }
            case 'sub_agent_tool_result_message': {
              const sa = state.activeSubAgents[id] ?? state.completedSubAgents[id]
              if (sa) {
                sa.transcript.push(event.message)
                trimSubAgentTranscript(sa)
                upsertSubAgentHistory(state.subAgentHistory, sa)
              }
              break
            }
            case 'sub_agent_user_message': {
              const sa = state.activeSubAgents[id] ?? state.completedSubAgents[id]
              if (sa) {
                finalizeAssistantMessage(sa)
                sa.transcript.push(event.message)
                trimSubAgentTranscript(sa)
                upsertSubAgentHistory(state.subAgentHistory, sa)
              }
              break
            }
            case 'sub_agent_report_update': {
              const sa = state.activeSubAgents[id] ?? state.completedSubAgents[id]
              if (sa) {
                sa.report = event.report
                sa.reportStatus = event.status
                upsertSubAgentHistory(state.subAgentHistory, sa)
              }
              break
            }
            case 'sub_agent_tool_call': {
              const sa = state.activeSubAgents[id] ?? state.completedSubAgents[id]
              if (sa) {
                const normalizedToolCall = normalizeToolCall(event.toolCall)
                const existing = sa.toolCalls.find((t) => t.id === normalizedToolCall.id)
                if (existing) {
                  Object.assign(existing, normalizedToolCall)
                } else {
                  sa.toolCalls.push(normalizedToolCall)
                }
                if (sa.toolCalls.length > MAX_TRACKED_SUBAGENT_TOOL_CALLS) {
                  sa.toolCalls.splice(0, sa.toolCalls.length - MAX_TRACKED_SUBAGENT_TOOL_CALLS)
                }
              }
              break
            }
            case 'sub_agent_text_delta': {
              const sa = state.activeSubAgents[id] ?? state.completedSubAgents[id]
              if (sa) {
                sa.streamingText = truncateText(
                  sa.streamingText + event.text,
                  MAX_STREAMING_TEXT_CHARS
                )
                appendTextToSubAgent(sa, event.text)
              }
              break
            }
            case 'sub_agent_end': {
              const sa = state.activeSubAgents[id] ?? state.completedSubAgents[id]
              if (sa) {
                sa.isRunning = false
                sa.success = event.result.success
                sa.errorMessage = event.result.error ?? null
                sa.completedAt = Date.now()
                finalizeAssistantMessage(sa)
                if (!sa.report.trim() && event.result.output.trim()) {
                  sa.report = event.result.output
                }
                sa.usage = event.result.usage
                sa.reportStatus = sa.report.trim() ? 'submitted' : 'missing'
                state.completedSubAgents[id] = sa
                if (sa.sessionId) {
                  const previous = state.sessionSubAgentSummaries[sa.sessionId] ?? []
                  state.sessionSubAgentSummaries[sa.sessionId] = [
                    buildSubAgentSummary(sa),
                    ...previous.filter((item) => item.toolUseId !== id)
                  ].slice(0, MAX_SUBAGENT_HISTORY)
                }
                upsertSubAgentHistory(state.subAgentHistory, sa)
                trimCompletedSubAgentsMap(state.completedSubAgents)
                delete state.activeSubAgents[id]
                rebuildRunningSubAgentDerived(state)
              }
              break
            }
          }
        })
      },

      abort: () => {
        set({ isRunning: false, currentLoopId: null })
        for (const [, resolve] of approvalResolvers) {
          resolve(false)
        }
        approvalResolvers.clear()
      },

      requestApproval: (toolCallId) => {
        return new Promise<boolean>((resolve) => {
          approvalResolvers.set(toolCallId, resolve)
        })
      },

      registerApprovalSource: (toolCallId, meta) => {
        approvalMetadata.set(toolCallId, {
          requestId: meta.requestId,
          replyTo: meta.replyTo,
          source: meta.source ?? 'teammate'
        })
      },

      clearSessionData: (sessionId) => {
        const processIdsToKill: string[] = []
        set((state) => {
          // Remove active subagents belonging to the session
          for (const [key, sa] of Object.entries(state.activeSubAgents)) {
            if (sa.sessionId === sessionId) delete state.activeSubAgents[key]
          }
          rebuildRunningSubAgentDerived(state)
          // Remove completed subagents belonging to the session
          for (const [key, sa] of Object.entries(state.completedSubAgents)) {
            if (sa.sessionId === sessionId) delete state.completedSubAgents[key]
          }
          // Remove history entries belonging to the session
          state.subAgentHistory = state.subAgentHistory.filter((sa) => sa.sessionId !== sessionId)
          trimSubAgentHistory(state.subAgentHistory)
          delete state.sessionSubAgentSummaries[sessionId]

          // Remove cached tool calls for this session
          delete state.sessionToolCallsCache[sessionId]
          delete state.sessionSubAgentLiveCache[sessionId]

          if (state.liveSessionId === sessionId) {
            state.pendingToolCalls = []
            state.executedToolCalls = []
            state.activeSubAgents = {}
            state.completedSubAgents = {}
          }

          for (const [runId, changeSet] of Object.entries(state.runChangesByRunId)) {
            if (changeSet.sessionId === sessionId) {
              delete state.runChangesByRunId[runId]
            }
          }

          rebuildRunningSubAgentDerived(state)

          // Remove background processes bound to this session
          for (const [key, process] of Object.entries(state.backgroundProcesses)) {
            if (process.sessionId === sessionId) {
              processIdsToKill.push(key)
              delete state.backgroundProcesses[key]
            }
          }
          delete state.sessionBackgroundProcessSummaries[sessionId]
        })
        for (const id of processIdsToKill) {
          ipcClient.invoke(IPC.PROCESS_KILL, { id }).catch(() => {})
        }
      },

      releaseDormantSessionData: (residentSessionIds) => {
        const residentSet = new Set(residentSessionIds)
        set((state) => {
          const targetSessionIds = new Set<string>([
            ...Object.keys(state.sessionToolCallsCache),
            ...Object.keys(state.sessionSubAgentLiveCache),
            ...Object.keys(state.sessionSubAgentSummaries),
            ...Object.keys(state.sessionBackgroundProcessSummaries)
          ])

          for (const sessionId of targetSessionIds) {
            if (residentSet.has(sessionId)) continue

            delete state.sessionToolCallsCache[sessionId]
            delete state.sessionSubAgentLiveCache[sessionId]

            const subAgents = state.sessionSubAgentSummaries[sessionId]
            if (subAgents && subAgents.length > 0) {
              state.sessionSubAgentSummaries[sessionId] = subAgents.map(buildSubAgentSummary)
            }

            const processes = state.sessionBackgroundProcessSummaries[sessionId]
            if (processes && processes.length > 0) {
              state.sessionBackgroundProcessSummaries[sessionId] = processes.map(
                buildBackgroundProcessSummary
              )
            }
          }
        })
      },

      clearPendingApprovals: () => {
        // Resolve all pending approval promises as denied
        for (const [, resolve] of approvalResolvers) {
          resolve(false)
        }
        approvalResolvers.clear()
        approvalMetadata.clear()
        // Move all pending tool calls to executed
        set((state) => {
          for (const tc of state.pendingToolCalls) {
            tc.status = 'error'
            tc.error = 'Aborted (team deleted)'
            state.executedToolCalls.push(normalizeToolCall(tc))
          }
          state.pendingToolCalls = []
          trimToolCallArray(state.executedToolCalls)
        })
      },

      resolveApproval: (toolCallId, approved) => {
        const resolve = approvalResolvers.get(toolCallId)
        if (resolve) {
          resolve(approved)
          approvalResolvers.delete(toolCallId)
        }

        const meta = approvalMetadata.get(toolCallId)
        if (meta?.source === 'teammate') {
          void sendApprovalResponse({
            requestId: meta.requestId,
            approved,
            to: meta.replyTo,
            summary: approved ? 'Leader approved tool use' : 'Leader denied tool use'
          }).catch((error) => {
            console.error('[TeamRuntime] Failed to send approval response:', error)
          })
          approvalMetadata.delete(toolCallId)
        } else if (meta?.source === 'teammate-plan') {
          void sendPlanApprovalResponse({
            requestId: meta.requestId,
            approved,
            to: meta.replyTo,
            feedback: approved ? 'Leader approved plan' : 'Leader rejected plan'
          }).catch((error) => {
            console.error('[TeamRuntime] Failed to send plan approval response:', error)
          })
          approvalMetadata.delete(toolCallId)
        }

        // Move tool call from pending to executed so the dialog advances
        // to the next pending item. Without this, teammate tool calls
        // stay in pendingToolCalls and block subsequent approvals.
        set((state) => {
          const idx = state.pendingToolCalls.findIndex((t) => t.id === toolCallId)
          if (idx !== -1) {
            const [moved] = state.pendingToolCalls.splice(idx, 1)
            moved.status = approved ? 'running' : 'error'
            if (!approved) moved.error = 'User denied permission'
            state.executedToolCalls.push(normalizeToolCall(moved))
            trimToolCallArray(state.executedToolCalls)
          }
        })
      }
    })),
    {
      name: 'opencowork-agent',
      storage: createJSONStorage(() => ipcStorage),
      partialize: (state) => ({
        approvedToolNames: state.approvedToolNames,
        subAgentHistory: state.subAgentHistory
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return
        // Trim oversized persisted history from previous versions
        if (state.subAgentHistory.length > MAX_SUBAGENT_HISTORY) {
          state.subAgentHistory.splice(0, state.subAgentHistory.length - MAX_SUBAGENT_HISTORY)
        }
      }
    }
  )
)
