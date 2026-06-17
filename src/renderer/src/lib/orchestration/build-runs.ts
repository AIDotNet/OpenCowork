import type { ContentBlock, UnifiedMessage } from '@renderer/lib/api/types'
import type { TeamTask } from '@renderer/lib/agent/teams/types'
import type { SubAgentState } from '@renderer/stores/agent-store'
import { buildHistorySnapshot } from './build-history-snapshot'
import {
  buildStages,
  computeMemberProgress,
  deriveRunStatus,
  getUsageTokens
} from './stage-resolver'
import type {
  BuildRunsInput,
  MemberTaskLookup,
  OrchestrationDerivedState,
  OrchestrationMember,
  OrchestrationRun,
  TeamCandidate
} from './types'

const TEAM_TOOL_NAMES = new Set([
  'TeamCreate',
  'TaskCreate',
  'TaskUpdate',
  'TeamDelete',
  'SendMessage'
])
const SUBAGENT_TOOL_NAME = 'Task'

type ByMessageEntry = { primaryRun: OrchestrationRun | null; hiddenToolUseIds: Set<string> }

interface StableEntryCache {
  entries: Map<string, ByMessageEntry>
  runSignatures: Map<string, string>
  hiddenSignatures: Map<string, string>
}

interface ToolUseMessageIndex {
  messageIdBySubAgentToolUseId: Map<string, string>
  teamCreateMessageIdByName: Map<string, string>
  hiddenToolUseIdsByMessage: Map<string, Set<string>>
}

const stableEntryCacheBySession = new Map<string, StableEntryCache>()

function getStableEntryCache(sessionId: string | null | undefined): StableEntryCache {
  const key = sessionId ?? '__none__'
  let cache = stableEntryCacheBySession.get(key)
  if (!cache) {
    cache = { entries: new Map(), runSignatures: new Map(), hiddenSignatures: new Map() }
    stableEntryCacheBySession.set(key, cache)
  }
  return cache
}

function getRunSignature(run: OrchestrationRun | null): string {
  if (!run) return ''
  const members = run.members
    .map(
      (m) =>
        `${m.id}:${m.status}:${m.iteration}:${m.progress}:${m.toolCallCount}:${m.completedAt ?? ''}:${m.latestAction}:${m.summary}`
    )
    .join('|')
  return `${run.id}:${run.status}:${run.stageIndex}:${run.stageCount}:${run.selectedMemberId ?? ''}:${run.completedAt ?? ''}:${run.summary}:${run.latestAction}::${members}`
}

function getHiddenSignature(ids: Set<string>): string {
  if (ids.size === 0) return ''
  const arr = Array.from(ids)
  arr.sort()
  return arr.join(',')
}

function stabilizeEntry(
  cache: StableEntryCache,
  messageId: string,
  nextEntry: ByMessageEntry
): ByMessageEntry {
  const runSig = getRunSignature(nextEntry.primaryRun)
  const hiddenSig = getHiddenSignature(nextEntry.hiddenToolUseIds)
  const prevEntry = cache.entries.get(messageId)
  const prevRunSig = cache.runSignatures.get(messageId)
  const prevHiddenSig = cache.hiddenSignatures.get(messageId)

  if (prevEntry && prevRunSig === runSig && prevHiddenSig === hiddenSig) {
    return prevEntry
  }

  const stabilized: ByMessageEntry = {
    primaryRun: prevEntry && prevRunSig === runSig ? prevEntry.primaryRun : nextEntry.primaryRun,
    hiddenToolUseIds:
      prevEntry && prevHiddenSig === hiddenSig
        ? prevEntry.hiddenToolUseIds
        : nextEntry.hiddenToolUseIds
  }
  cache.entries.set(messageId, stabilized)
  cache.runSignatures.set(messageId, runSig)
  cache.hiddenSignatures.set(messageId, hiddenSig)
  return stabilized
}

function getToolUseBlocks(
  message: UnifiedMessage
): Array<Extract<ContentBlock, { type: 'tool_use' }>> {
  if (!Array.isArray(message.content)) return []
  return message.content.filter(
    (block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use'
  )
}

function buildToolUseMessageIndex(messages: UnifiedMessage[]): ToolUseMessageIndex {
  const messageIdBySubAgentToolUseId = new Map<string, string>()
  const teamCreateMessageIdByName = new Map<string, string>()
  const hiddenToolUseIdsByMessage = new Map<string, Set<string>>()

  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue

    for (const block of getToolUseBlocks(message)) {
      if (block.name === SUBAGENT_TOOL_NAME && !messageIdBySubAgentToolUseId.has(block.id)) {
        messageIdBySubAgentToolUseId.set(block.id, message.id)
      }

      if (block.name === 'TeamCreate') {
        const teamName = String(block.input.team_name ?? '')
        if (teamName && !teamCreateMessageIdByName.has(teamName)) {
          teamCreateMessageIdByName.set(teamName, message.id)
        }
      }

      if (TEAM_TOOL_NAMES.has(block.name) || block.name === SUBAGENT_TOOL_NAME) {
        let hidden = hiddenToolUseIdsByMessage.get(message.id)
        if (!hidden) {
          hidden = new Set()
          hiddenToolUseIdsByMessage.set(message.id, hidden)
        }
        hidden.add(block.id)
      }
    }
  }

  return {
    messageIdBySubAgentToolUseId,
    teamCreateMessageIdByName,
    hiddenToolUseIdsByMessage
  }
}

function getAllSubAgents(input: BuildRunsInput): SubAgentState[] {
  const merged = new Map<string, SubAgentState>()

  for (const item of input.subAgentHistory) {
    if (!input.sessionId || item.sessionId === input.sessionId) merged.set(item.toolUseId, item)
  }
  for (const item of Object.values(input.completedSubAgents)) {
    if (!input.sessionId || item.sessionId === input.sessionId) merged.set(item.toolUseId, item)
  }
  for (const item of Object.values(input.activeSubAgents)) {
    if (!input.sessionId || item.sessionId === input.sessionId) merged.set(item.toolUseId, item)
  }

  return [...merged.values()]
}

function getTeamCandidates(input: BuildRunsInput, toolIndex: ToolUseMessageIndex): TeamCandidate[] {
  const teams = [input.activeTeam, ...input.teamHistory].filter(
    (team): team is NonNullable<typeof team> =>
      !!team && (!input.sessionId || team.sessionId === input.sessionId)
  )

  return teams
    .map((team) => {
      return {
        team,
        runId: `team:${team.name}:${team.createdAt}`,
        sourceMessageId:
          toolIndex.teamCreateMessageIdByName.get(team.name) ??
          `team-snapshot:${team.name}:${team.createdAt}`
      }
    })
    .sort((left, right) => right.team.createdAt - left.team.createdAt)
}

function createTaskLookup(tasks: TeamTask[]): MemberTaskLookup {
  const byId = new Map<string, TeamTask>()
  const byOwner = new Map<string, TeamTask>()

  for (const task of tasks) {
    byId.set(task.id, task)
    if (task.owner && !byOwner.has(task.owner)) byOwner.set(task.owner, task)
  }

  return { byId, byOwner }
}

function getMemberSummary(summary: string, fallback: string): string {
  return summary.trim() || fallback.trim()
}

function getLatestAction(summary: string, taskLabel?: string | null): string {
  if (taskLabel?.trim()) return taskLabel.trim()
  return summary.trim()
}

function mapSubAgentToMember(agent: SubAgentState): OrchestrationMember {
  const summary = getMemberSummary(agent.report, agent.streamingText || agent.errorMessage || '')
  const status: OrchestrationMember['status'] =
    agent.success === false ? 'failed' : agent.isRunning ? 'working' : 'completed'

  return {
    id: agent.toolUseId,
    toolUseId: agent.toolUseId,
    name: agent.displayName ?? agent.name,
    role: 'worker',
    agentName: agent.name,
    status,
    isRunning: agent.isRunning,
    iteration: agent.iteration,
    startedAt: agent.startedAt,
    completedAt: agent.completedAt,
    currentTaskId: null,
    currentTaskLabel: agent.description || null,
    description: agent.description || undefined,
    prompt: agent.prompt || undefined,
    summary,
    latestAction: getLatestAction(summary, agent.description),
    progress: computeMemberProgress({
      isRunning: agent.isRunning,
      toolCallCount: agent.toolCalls.length,
      iteration: agent.iteration,
      summary,
      report: agent.report
    }),
    usageTokens: getUsageTokens(agent.usage),
    toolCallCount: agent.toolCalls.length,
    transcript: agent.transcript,
    toolCalls: agent.toolCalls,
    report: agent.report,
    errorMessage: agent.errorMessage
  }
}

function mapTeamMember(
  teamMember: NonNullable<TeamCandidate['team']>['members'][number],
  taskLookup: MemberTaskLookup
): OrchestrationMember {
  const currentTask =
    (teamMember.currentTaskId ? taskLookup.byId.get(teamMember.currentTaskId) : null) ??
    taskLookup.byOwner.get(teamMember.name) ??
    null
  const summary = getMemberSummary(teamMember.streamingText, currentTask?.report ?? '')

  return {
    id: teamMember.id,
    name: teamMember.name,
    role: teamMember.role,
    agentName: teamMember.agentName,
    model: teamMember.model,
    // The cluster view treats "awaiting approval" as an active/working member;
    // the precise live status is shown in the detailed TeamPanel.
    status: teamMember.status === 'awaiting_approval' ? 'working' : teamMember.status,
    isRunning: teamMember.status === 'working',
    iteration: teamMember.iteration,
    startedAt: teamMember.startedAt,
    completedAt: teamMember.completedAt,
    currentTaskId: currentTask?.id ?? teamMember.currentTaskId,
    currentTaskLabel: currentTask?.subject ?? null,
    description: currentTask?.description || undefined,
    summary,
    latestAction: getLatestAction(summary, currentTask?.subject),
    progress: computeMemberProgress({
      isRunning: teamMember.status === 'working',
      toolCallCount: teamMember.toolCalls.length,
      iteration: teamMember.iteration,
      summary,
      report: currentTask?.report
    }),
    usageTokens: getUsageTokens(teamMember.usage),
    toolCallCount: teamMember.toolCalls.length,
    transcript: [],
    toolCalls: teamMember.toolCalls,
    report: currentTask?.report,
    errorMessage: null
  }
}

function buildSubAgentRun(agents: SubAgentState[], sourceMessageId: string): OrchestrationRun {
  const members = agents.map((agent) => mapSubAgentToMember(agent))
  const status = deriveRunStatus(members)
  const primaryMember =
    members.find((member) => member.isRunning) ??
    members.find((member) => member.status === 'failed') ??
    members[0]
  const summary =
    members
      .map((member) => member.summary || member.latestAction)
      .filter(Boolean)
      .join('\n\n') ||
    primaryMember?.description ||
    primaryMember?.name ||
    ''
  const latestAction = primaryMember?.latestAction || summary
  const { stageIndex, stageCount, stages } = buildStages({
    members,
    hasTasks: agents.some((agent) => !!agent.description),
    hasMessages: agents.some((agent) => agent.transcript.length > 0)
  })
  const sourceToolUseIds = agents.map((agent) => agent.toolUseId)

  const run: OrchestrationRun = {
    id:
      agents.length === 1
        ? `single:${agents[0].toolUseId}`
        : `single-group:${sourceMessageId}:${sourceToolUseIds.join(',')}`,
    sessionId: agents[0]?.sessionId,
    sourceMessageId,
    kind: 'single-agent',
    title: primaryMember?.name ?? 'Agent',
    status,
    startedAt: Math.min(...agents.map((agent) => agent.startedAt)),
    completedAt:
      status === 'running'
        ? null
        : Math.max(...agents.map((agent) => agent.completedAt ?? agent.startedAt)),
    stageIndex,
    stageCount,
    stages,
    summary,
    latestAction,
    members,
    tasks: [],
    messages: [],
    selectedMemberId: primaryMember?.id ?? null,
    sourceToolUseIds,
    historySnapshot: { summary: '', latestAction: '', members: [] }
  }

  run.historySnapshot = buildHistorySnapshot(run)
  return run
}

function buildTeamRun(candidate: TeamCandidate): OrchestrationRun {
  const taskLookup = createTaskLookup(candidate.team.tasks)
  const members = candidate.team.members.map((member) => mapTeamMember(member, taskLookup))
  const status = deriveRunStatus(members)
  const summary =
    candidate.team.tasks.find((task) => task.report?.trim())?.report?.trim() ||
    candidate.team.messages[candidate.team.messages.length - 1]?.summary ||
    candidate.team.description ||
    candidate.team.name
  const latestAction =
    candidate.team.messages[candidate.team.messages.length - 1]?.summary ||
    members.find((member) => member.isRunning)?.latestAction ||
    summary
  const { stageIndex, stageCount, stages } = buildStages({
    members,
    hasTasks: candidate.team.tasks.length > 0,
    hasMessages: candidate.team.messages.length > 0
  })

  const run: OrchestrationRun = {
    id: candidate.runId,
    sessionId: candidate.team.sessionId,
    sourceMessageId: candidate.sourceMessageId,
    kind: 'team',
    title: candidate.team.name,
    status,
    startedAt: candidate.team.createdAt,
    completedAt:
      status === 'running'
        ? null
        : Math.max(
            candidate.team.createdAt,
            ...candidate.team.members.map((member) => member.completedAt ?? member.startedAt)
          ),
    stageIndex,
    stageCount,
    stages,
    summary,
    latestAction,
    members,
    tasks: candidate.team.tasks,
    messages: candidate.team.messages,
    selectedMemberId: members[0]?.id ?? null,
    sourceToolUseIds: members.map((member) => member.toolUseId).filter(Boolean) as string[],
    historySnapshot: { summary: '', latestAction: '', members: [] },
    team: candidate.team
  }

  run.historySnapshot = buildHistorySnapshot(run)
  return run
}

function getSourceMessageIdForAgent(agent: SubAgentState, toolIndex: ToolUseMessageIndex): string {
  return (
    toolIndex.messageIdBySubAgentToolUseId.get(agent.toolUseId) ??
    `single-snapshot:${agent.toolUseId}`
  )
}

export function buildOrchestrationRuns(input: BuildRunsInput): OrchestrationDerivedState {
  const runs: OrchestrationRun[] = []
  const byId = new Map<string, OrchestrationRun>()
  const rawByMessageId = new Map<string, ByMessageEntry>()
  const toolIndex = buildToolUseMessageIndex(input.messages)

  const teamCandidates = getTeamCandidates(input, toolIndex)
  for (const candidate of teamCandidates) {
    const run = buildTeamRun(candidate)
    runs.push(run)
    byId.set(run.id, run)
    rawByMessageId.set(run.sourceMessageId, {
      primaryRun: run,
      hiddenToolUseIds: new Set(run.sourceToolUseIds)
    })
  }

  const usedToolUseIds = new Set<string>()
  for (const candidate of teamCandidates) {
    for (const member of candidate.team.members) {
      usedToolUseIds.add(member.id)
    }
  }

  const subAgentsByMessage = new Map<string, SubAgentState[]>()
  for (const agent of getAllSubAgents(input)) {
    if (usedToolUseIds.has(agent.toolUseId)) continue
    const sourceMessageId = getSourceMessageIdForAgent(agent, toolIndex)
    const agents = subAgentsByMessage.get(sourceMessageId)
    if (agents) {
      agents.push(agent)
    } else {
      subAgentsByMessage.set(sourceMessageId, [agent])
    }
  }

  for (const [sourceMessageId, agents] of subAgentsByMessage) {
    agents.sort((left, right) => left.startedAt - right.startedAt)
    const run = buildSubAgentRun(agents, sourceMessageId)
    runs.push(run)
    byId.set(run.id, run)
    const existing = rawByMessageId.get(run.sourceMessageId)
    rawByMessageId.set(run.sourceMessageId, {
      primaryRun: run,
      hiddenToolUseIds: new Set([...(existing?.hiddenToolUseIds ?? []), ...run.sourceToolUseIds])
    })
  }

  for (const [messageId, indexedHiddenToolUseIds] of toolIndex.hiddenToolUseIdsByMessage) {
    const binding = rawByMessageId.get(messageId)
    const hiddenToolUseIds = new Set([
      ...(binding?.hiddenToolUseIds ?? []),
      ...indexedHiddenToolUseIds
    ])
    if (binding || hiddenToolUseIds.size > 0) {
      rawByMessageId.set(messageId, {
        primaryRun: binding?.primaryRun ?? null,
        hiddenToolUseIds
      })
    }
  }

  runs.sort((left, right) => right.startedAt - left.startedAt)

  // Stabilize entry references across calls so that MessageRow memo can short-circuit via ===.
  const cache = getStableEntryCache(input.sessionId)
  const byMessageId = new Map<string, ByMessageEntry>()
  for (const [messageId, entry] of rawByMessageId) {
    byMessageId.set(messageId, stabilizeEntry(cache, messageId, entry))
  }
  // Evict cache entries no longer present to avoid unbounded growth.
  for (const key of cache.entries.keys()) {
    if (!byMessageId.has(key)) {
      cache.entries.delete(key)
      cache.runSignatures.delete(key)
      cache.hiddenSignatures.delete(key)
    }
  }

  return { runs, byId, byMessageId }
}
