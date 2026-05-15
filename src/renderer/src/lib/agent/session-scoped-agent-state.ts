import type { ToolCallState } from '@renderer/lib/agent/types'
import type { SubAgentState, BackgroundProcessState } from '@renderer/stores/agent-store'

const EMPTY_SUBAGENT_MAP: Record<string, SubAgentState> = {}
const EMPTY_SUBAGENT_HISTORY: SubAgentState[] = []
const EMPTY_TOOL_CALLS: ToolCallState[] = []

export interface SessionScopedAgentSelection {
  activeSubAgents: Record<string, SubAgentState>
  completedSubAgents: Record<string, SubAgentState>
  subAgentHistory: SubAgentState[]
  hasActiveToolCallOutput: boolean
  isSessionRunning: boolean
  hasOrchestrationData: boolean
  signature: string
}

export interface SessionScopedAgentSelectionOptions {
  mode?: 'live' | 'coarse'
}

interface SessionSubAgentLiveState {
  active: Record<string, SubAgentState>
  completed: Record<string, SubAgentState>
}

interface SessionToolCallCache {
  pending: ToolCallState[]
  executed: ToolCallState[]
}

export interface SessionScopedAgentStateSource {
  activeSubAgents: Record<string, SubAgentState>
  completedSubAgents: Record<string, SubAgentState>
  subAgentHistory: SubAgentState[]
  liveSessionId: string | null
  pendingToolCalls: ToolCallState[]
  executedToolCalls: ToolCallState[]
  sessionToolCallsCache: Record<string, SessionToolCallCache | undefined>
  sessionSubAgentLiveCache: Record<string, SessionSubAgentLiveState | undefined>
  sessionSubAgentSummaries: Record<string, SubAgentState[] | undefined>
  runningSessions: Record<string, 'running' | 'retrying' | 'completed'>
  runningSubAgentSessionIdsSig: string
  backgroundProcesses: Record<string, BackgroundProcessState>
}

const EMPTY_SESSION_AGENT_SELECTION: SessionScopedAgentSelection = {
  activeSubAgents: EMPTY_SUBAGENT_MAP,
  completedSubAgents: EMPTY_SUBAGENT_MAP,
  subAgentHistory: EMPTY_SUBAGENT_HISTORY,
  hasActiveToolCallOutput: false,
  isSessionRunning: false,
  hasOrchestrationData: false,
  signature: 'empty'
}

const sessionScopedAgentSelectionCache = new Map<string, SessionScopedAgentSelection>()

function hasSessionSignatureEntry(sig: string, value: string): boolean {
  if (!sig || !value) return false
  return sig.split('\u0000').includes(value)
}

function buildToolCallStatusSignature(toolCalls: ToolCallState[]): string {
  return toolCalls
    .map((toolCall) =>
      [toolCall.id, toolCall.name, toolCall.status, String(toolCall.completedAt ?? '')].join(':')
    )
    .join('|')
}

function buildTranscriptLiveSignature(agent: SubAgentState): string {
  const currentAssistant = agent.currentAssistantMessageId
    ? agent.transcript.find((message) => message.id === agent.currentAssistantMessageId)
    : null
  const lastMessage = agent.transcript[agent.transcript.length - 1]
  return [
    agent.currentAssistantMessageId ?? '',
    String(currentAssistant?._revision ?? ''),
    lastMessage?.id ?? '',
    String(lastMessage?._revision ?? '')
  ].join(':')
}

function buildSubAgentRenderSignature(
  agent: SubAgentState,
  mode: NonNullable<SessionScopedAgentSelectionOptions['mode']>
): string {
  const stableParts = [
    agent.toolUseId,
    agent.sessionId ?? '',
    agent.displayName ?? '',
    agent.name,
    agent.isRunning ? '1' : '0',
    agent.success === null ? '' : agent.success ? '1' : '0',
    agent.errorMessage ?? '',
    String(agent.iteration),
    String(agent.startedAt),
    String(agent.completedAt ?? ''),
    agent.description ?? '',
    agent.prompt ?? '',
    agent.report ?? '',
    String(agent.toolCalls.length),
    buildToolCallStatusSignature(agent.toolCalls)
  ]

  if (mode === 'live') {
    stableParts.push(
      agent.streamingText ?? '',
      String(agent.transcript.length),
      buildTranscriptLiveSignature(agent)
    )
  }

  return stableParts.join('::')
}

function getSessionLiveSubAgents(
  state: SessionScopedAgentStateSource,
  sessionId: string
): SessionSubAgentLiveState {
  const cached = state.sessionSubAgentLiveCache[sessionId]
  if (cached) return cached

  let active = EMPTY_SUBAGENT_MAP
  let completed = EMPTY_SUBAGENT_MAP

  for (const [key, subAgent] of Object.entries(state.activeSubAgents)) {
    if (subAgent.sessionId !== sessionId) continue
    if (active === EMPTY_SUBAGENT_MAP) active = {}
    active[key] = subAgent
  }

  for (const [key, subAgent] of Object.entries(state.completedSubAgents)) {
    if (subAgent.sessionId !== sessionId) continue
    if (completed === EMPTY_SUBAGENT_MAP) completed = {}
    completed[key] = subAgent
  }

  return { active, completed }
}

function getSessionToolCalls(
  state: SessionScopedAgentStateSource,
  sessionId: string
): SessionToolCallCache {
  if (state.liveSessionId === sessionId) {
    return {
      pending: state.pendingToolCalls,
      executed: state.executedToolCalls
    }
  }
  return (
    state.sessionToolCallsCache[sessionId] ?? {
      pending: EMPTY_TOOL_CALLS,
      executed: EMPTY_TOOL_CALLS
    }
  )
}

function hasRunningToolCall(toolCalls: ToolCallState[]): boolean {
  return toolCalls.some(
    (toolCall) => toolCall.status === 'running' || toolCall.status === 'streaming'
  )
}

export function selectSessionScopedAgentState(
  state: SessionScopedAgentStateSource,
  sessionId: string | null | undefined,
  options?: SessionScopedAgentSelectionOptions
): SessionScopedAgentSelection {
  if (!sessionId) return EMPTY_SESSION_AGENT_SELECTION

  const mode = options?.mode ?? 'live'
  const liveSubAgents = getSessionLiveSubAgents(state, sessionId)
  const activeSubAgents = liveSubAgents.active
  const completedSubAgents = liveSubAgents.completed
  const subAgentHistory = state.sessionSubAgentSummaries[sessionId] ?? EMPTY_SUBAGENT_HISTORY
  const signatureParts: string[] = []
  let hasActiveSubAgents = false
  let hasCompletedSubAgents = false

  for (const subAgent of Object.values(activeSubAgents)) {
    hasActiveSubAgents = true
    signatureParts.push(`a:${buildSubAgentRenderSignature(subAgent, mode)}`)
  }

  for (const subAgent of Object.values(completedSubAgents)) {
    hasCompletedSubAgents = true
    signatureParts.push(`c:${buildSubAgentRenderSignature(subAgent, mode)}`)
  }

  for (const subAgent of subAgentHistory) {
    signatureParts.push(`h:${buildSubAgentRenderSignature(subAgent, mode)}`)
  }

  const toolCalls = getSessionToolCalls(state, sessionId)
  const hasActiveToolCallOutput =
    hasRunningToolCall(toolCalls.pending) || hasRunningToolCall(toolCalls.executed)
  const hasRunningBackgroundProcess = Object.values(state.backgroundProcesses).some(
    (process) => process.sessionId === sessionId && process.status === 'running'
  )
  const isSessionRunning =
    state.runningSessions[sessionId] === 'running' ||
    state.runningSessions[sessionId] === 'retrying' ||
    hasSessionSignatureEntry(state.runningSubAgentSessionIdsSig, sessionId) ||
    hasRunningBackgroundProcess

  signatureParts.unshift(
    `run:${isSessionRunning ? '1' : '0'}`,
    `tool:${hasActiveToolCallOutput ? '1' : '0'}`
  )

  const signature = signatureParts.join('\u0001')
  const cacheKey = `${sessionId}\u0000${mode}`
  const cached = sessionScopedAgentSelectionCache.get(cacheKey)
  if (cached?.signature === signature) return cached

  const nextSelection: SessionScopedAgentSelection = {
    activeSubAgents,
    completedSubAgents,
    subAgentHistory,
    hasActiveToolCallOutput,
    isSessionRunning,
    hasOrchestrationData: hasActiveSubAgents || hasCompletedSubAgents || subAgentHistory.length > 0,
    signature
  }

  sessionScopedAgentSelectionCache.set(cacheKey, nextSelection)
  return nextSelection
}

export function findSubAgentInSelection(
  selection: SessionScopedAgentSelection,
  toolUseId: string | null | undefined
): SubAgentState | null {
  if (!toolUseId) return null
  return (
    selection.activeSubAgents[toolUseId] ??
    selection.completedSubAgents[toolUseId] ??
    selection.subAgentHistory.find((item) => item.toolUseId === toolUseId) ??
    null
  )
}
