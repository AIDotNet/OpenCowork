import { nanoid } from 'nanoid'
import { toolRegistry } from '../tool-registry'
import { teamEvents } from './events'
import { useTeamStore } from '../../../stores/team-store'
import { useSettingsStore } from '../../../stores/settings-store'
import { useProviderStore } from '../../../stores/provider-store'
import { ensureProviderAuthReady } from '../../auth/provider-auth'
import { useAgentStore } from '../../../stores/agent-store'
import { ipcClient } from '../../ipc/ipc-client'
import { MessageQueue } from '../types'
import type { AgentLoopConfig } from '../types'
import type { UnifiedMessage, ProviderConfig, TokenUsage } from '../../api/types'
import type { TeamRuntimeTaskStatus } from '../../../../../shared/team-runtime-types'
import type { TeamMessage, TeamTask } from './types'
import { buildRuntimeCompression } from '../context-compression-runtime'
import { subAgentRegistry } from '../sub-agents/registry'
import { resolveSubAgentTools } from '../sub-agents/resolve-tools'
import { requestFallbackReport, runSharedAgentRuntime } from '../shared-runtime'
import {
  appendTeamRuntimeMessage,
  updateTeamRuntimeManifest,
  updateTeamRuntimeMember
} from './runtime-client'
import { requestTeammatePermission, stopWorkerPermissionPoller } from './permission-bridge'
import { requestPlanApproval, stopWorkerPlanApprovalPoller } from './plan-approval-bridge'
import { buildTeammateAddendum } from './prompts'
import { startWorkerInboxPoller, stopWorkerInboxPoller } from './worker-inbox'
import { DEFAULT_SUB_AGENT_MAX_TURNS, resolveSubAgentMaxTurns } from '../sub-agents/limits'

const teammateAbortControllers = new Map<string, AbortController>()
const teammateShutdownRequested = new Set<string>()
const DEFAULT_TEAMMATE_MAX_ITERATIONS = DEFAULT_SUB_AGENT_MAX_TURNS
const MAX_REPORT_LENGTH = 4000
const READ_ONLY_TOOLS = new Set(['Read', 'LS', 'Glob', 'Grep', 'TaskList', 'TaskGet', 'TeamStatus'])

function getTaskDetails(description: string | null | undefined, subject: string): string | null {
  const trimmed = typeof description === 'string' ? description.trim() : ''
  if (!trimmed || trimmed === subject.trim()) return null
  return trimmed
}

function buildTeamTaskPrompt(task: Pick<TeamTask, 'subject' | 'description'>): string {
  const lines = ['Work on the following task:', `**Title:** ${task.subject}`]
  const details = getTaskDetails(task.description, task.subject)
  if (details) {
    lines.push(`**Details:** ${details}`)
  }
  return lines.join('\n')
}

async function syncRuntimeMemberState(
  memberId: string,
  patch: Parameters<typeof updateTeamRuntimeMember>[0]['patch']
): Promise<void> {
  const team = useTeamStore.getState().activeTeam
  if (!team?.name) return

  try {
    await updateTeamRuntimeMember({
      teamName: team.name,
      memberId,
      patch
    })
  } catch (error) {
    console.error('[TeamRuntime] Failed to sync teammate runtime member state:', error)
  }
}

async function syncRuntimeTaskState(
  taskId: string,
  patch: Partial<{ status: TeamRuntimeTaskStatus; owner: string | null; report: string }>
): Promise<void> {
  const team = useTeamStore.getState().activeTeam
  if (!team?.name) return

  try {
    await updateTeamRuntimeManifest({
      teamName: team.name,
      patch: {
        tasks: team.tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task))
      }
    })
  } catch (error) {
    console.error('[TeamRuntime] Failed to sync teammate runtime task state:', error)
  }
}

export function requestTeammateShutdown(memberId: string): void {
  teammateShutdownRequested.add(memberId)
}

export function abortTeammate(memberId: string): boolean {
  const ac = teammateAbortControllers.get(memberId)
  if (ac) {
    ac.abort()
    teammateAbortControllers.delete(memberId)
    teammateShutdownRequested.delete(memberId)
    return true
  }
  return false
}

export function abortAllTeammates(): void {
  for (const [id, ac] of teammateAbortControllers) {
    ac.abort()
    teammateAbortControllers.delete(id)
  }
  teammateShutdownRequested.clear()
}

export function isTeammateRunning(memberId: string): boolean {
  return teammateAbortControllers.has(memberId)
}

interface RunTeammateOptions {
  memberId: string
  memberName: string
  prompt: string
  taskId: string | null
  model: string | null
  agentName: string | null
  workingFolder?: string
}

interface SingleTaskResult {
  iterations: number
  toolCalls: number
  lastStreamingText: string
  fullOutput: string
  taskCompleted: boolean
  reason: 'completed' | 'max_iterations' | 'aborted' | 'shutdown' | 'error'
  usage: TokenUsage
}

export async function runTeammate(options: RunTeammateOptions): Promise<void> {
  const { memberId, memberName, model, agentName, workingFolder } = options
  let { prompt, taskId } = options

  const team = useTeamStore.getState().activeTeam
  const sessionId = team?.sessionId
  const abortController = new AbortController()
  teammateAbortControllers.set(memberId, abortController)

  const leadOnlyTools = new Set(['TeamCreate', 'TeamDelete', 'TaskCreate'])
  const baseToolDefs = toolRegistry.getDefinitions().filter((tool) => !leadOnlyTools.has(tool.name))
  const agentDefinition = agentName ? subAgentRegistry.get(agentName) : undefined
  const toolDefs = agentDefinition
    ? resolveSubAgentTools(agentDefinition, baseToolDefs).tools
    : baseToolDefs

  const messageQueue = new MessageQueue()

  const unsubMessages = teamEvents.on((event) => {
    if (event.type !== 'team_message') return
    const msg = event.message
    const isForMe = msg.to === memberName || msg.to === 'all'
    if (!isForMe || msg.from === memberName) return

    if (msg.type === 'shutdown_request') {
      teammateShutdownRequested.add(memberId)
      return
    }

    if (msg.type !== 'permission_response' && msg.type !== 'plan_approval_response') {
      messageQueue.push({
        id: nanoid(),
        role: 'user',
        content: `[Team message from ${msg.from}]: ${msg.content}`,
        createdAt: msg.timestamp
      })
    }
  })

  startWorkerInboxPoller({
    memberId,
    memberName,
    onMessage: (content, createdAt) => {
      messageQueue.push({
        id: nanoid(),
        role: 'user',
        content,
        createdAt
      })
    }
  })

  let totalIterations = 0
  let totalToolCalls = 0
  let tasksCompleted = 0
  let lastStreamingText = ''
  let fullOutput = ''
  let endReason: 'completed' | 'aborted' | 'error' | 'shutdown' = 'completed'

  try {
    if (!taskId) {
      const initialTask = findNextClaimableTask()
      if (initialTask) {
        taskId = initialTask.id
        prompt = buildTeamTaskPrompt(initialTask)
        teamEvents.emit({
          type: 'team_task_update',
          sessionId,
          taskId: initialTask.id,
          patch: { status: 'in_progress', owner: memberName }
        })
        teamEvents.emit({
          type: 'team_member_update',
          sessionId,
          memberId,
          patch: { currentTaskId: initialTask.id }
        })
        await syncRuntimeTaskState(initialTask.id, {
          status: 'in_progress',
          owner: memberName
        })
        await syncRuntimeMemberState(memberId, {
          currentTaskId: initialTask.id,
          status: 'working'
        })
      }
    }

    const result = await runSingleTaskLoop({
      memberId,
      memberName,
      prompt,
      taskId,
      model,
      agentName,
      workingFolder,
      abortController,
      toolDefs,
      messageQueue
    })

    totalIterations = result.iterations
    totalToolCalls = result.toolCalls
    lastStreamingText = result.lastStreamingText
    fullOutput = result.fullOutput
    if (result.taskCompleted) tasksCompleted += 1
    if (result.reason === 'aborted') endReason = 'aborted'
    else if (result.reason === 'shutdown') endReason = 'shutdown'
    else if (result.reason === 'error') endReason = 'error'

    const completedAt = Date.now()
    teamEvents.emit({
      type: 'team_member_update',
      sessionId,
      memberId,
      patch: { status: 'stopped', completedAt }
    })
    await syncRuntimeMemberState(memberId, {
      status: 'stopped',
      completedAt,
      isActive: false,
      currentTaskId: null
    })
  } catch (error) {
    endReason = abortController.signal.aborted ? 'aborted' : 'error'
    if (!abortController.signal.aborted) {
      console.error(`[Teammate ${memberName}] Error:`, error)
    }
    const completedAt = Date.now()
    teamEvents.emit({
      type: 'team_member_update',
      sessionId,
      memberId,
      patch: { status: 'stopped', completedAt }
    })
    await syncRuntimeMemberState(memberId, {
      status: 'stopped',
      completedAt,
      isActive: false,
      currentTaskId: null
    })
  } finally {
    teammateAbortControllers.delete(memberId)
    teammateShutdownRequested.delete(memberId)
    unsubMessages()
    stopWorkerPermissionPoller(memberName)
    stopWorkerPlanApprovalPoller(memberName)
    stopWorkerInboxPoller(memberId)

    if (endReason !== 'aborted') {
      emitCompletionMessage(memberName, endReason, {
        totalIterations,
        totalToolCalls,
        tasksCompleted,
        lastStreamingText,
        fullOutput,
        taskId
      })
    }
  }
}

async function runSingleTaskLoop(opts: {
  memberId: string
  memberName: string
  prompt: string
  taskId: string | null
  model: string | null
  agentName: string | null
  workingFolder?: string
  abortController: AbortController
  toolDefs: ReturnType<typeof toolRegistry.getDefinitions>
  messageQueue?: MessageQueue
}): Promise<SingleTaskResult> {
  const {
    memberId,
    memberName,
    prompt,
    taskId,
    model,
    agentName,
    workingFolder,
    abortController,
    toolDefs,
    messageQueue
  } = opts

  const settings = useSettingsStore.getState()
  const providerState = useProviderStore.getState()
  const activeProviderId = providerState.activeProviderId
  if (activeProviderId) {
    const ready = await ensureProviderAuthReady(activeProviderId)
    if (!ready) throw new Error('Provider authentication required. Please sign in.')
  }

  const activeConfig = providerState.getActiveProviderConfig()
  const effectiveModel =
    model && model !== 'default' ? model : (activeConfig?.model ?? settings.model)
  const effectiveMaxTokens = useProviderStore
    .getState()
    .getEffectiveMaxTokens(settings.maxTokens, effectiveModel)
  const providerConfig: ProviderConfig = activeConfig
    ? {
        ...activeConfig,
        model: effectiveModel,
        maxTokens: effectiveMaxTokens,
        temperature: settings.temperature
      }
    : {
        type: settings.provider,
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl || undefined,
        model: effectiveModel,
        maxTokens: effectiveMaxTokens,
        temperature: settings.temperature
      }

  if (toolDefs.length === 0) {
    throw new Error(
      agentName
        ? `No tools available for teammate agent "${agentName}".`
        : 'No tools available for teammate.'
    )
  }

  const team = useTeamStore.getState().activeTeam
  const sessionId = team?.sessionId
  const taskInfo = taskId && team ? team.tasks.find((task) => task.id === taskId) : null
  const agentDefinition = agentName ? subAgentRegistry.get(agentName) : undefined
  const effectivePrompt = agentDefinition?.initialPrompt
    ? `${agentDefinition.initialPrompt}\n\n${prompt}`
    : prompt

  const coordinationPrompt = buildTeammateAddendum({
    memberName,
    teamName: team?.name ?? 'team',
    prompt: effectivePrompt,
    task: taskInfo
      ? { id: taskInfo.id, subject: taskInfo.subject, description: taskInfo.description }
      : null,
    workingFolder,
    language: settings.language,
    permissionMode: team?.permissionMode
  })
  const systemPrompt = agentDefinition
    ? `${agentDefinition.systemPrompt}\n\n${coordinationPrompt}`
    : coordinationPrompt
  providerConfig.systemPrompt = systemPrompt

  const compression = buildRuntimeCompression(providerConfig, abortController.signal)
  const loopConfig: AgentLoopConfig = {
    maxIterations: resolveSubAgentMaxTurns(
      agentDefinition?.maxTurns ?? DEFAULT_TEAMMATE_MAX_ITERATIONS
    ),
    provider: providerConfig,
    tools: toolDefs,
    systemPrompt,
    workingFolder,
    signal: abortController.signal,
    messageQueue,
    ...(compression ? { contextCompression: compression } : {})
  }

  const initialMessages: UnifiedMessage[] = []

  if (team?.permissionMode === 'plan') {
    const planPrompt = buildPlanRequestText(taskInfo ?? null, effectivePrompt)
    const planRuntime = await runSharedAgentRuntime({
      initialMessages: [
        {
          id: nanoid(),
          role: 'user',
          content: planPrompt,
          createdAt: Date.now()
        }
      ],
      loopConfig: {
        ...loopConfig,
        maxIterations: 1
      },
      toolContext: {
        workingFolder,
        signal: abortController.signal,
        ipc: ipcClient,
        callerAgent: 'teammate'
      },
      isReadOnlyTool: () => true
    })

    const planText = planRuntime.finalOutput.trim()
    const approval = await requestPlanApproval({
      memberName,
      plan: planText,
      taskId
    })

    if (!approval.approved) {
      const rejectedOutput = approval.feedback
        ? `${planText}\n\nLead feedback: ${approval.feedback}`
        : planText
      return {
        iterations: planRuntime.iterations,
        toolCalls: planRuntime.toolCallCount,
        lastStreamingText: rejectedOutput,
        fullOutput: rejectedOutput,
        taskCompleted: false,
        reason: 'shutdown',
        usage: planRuntime.usage
      }
    }

    initialMessages.push({
      id: nanoid(),
      role: 'user',
      content: `Lead approved your plan. Proceed with execution. ${approval.feedback ?? ''}`.trim(),
      createdAt: Date.now()
    })
  }

  initialMessages.push({
    id: nanoid(),
    role: 'user',
    content: effectivePrompt,
    createdAt: Date.now()
  })

  teamEvents.emit({
    type: 'team_member_update',
    sessionId,
    memberId,
    patch: { status: 'working', iteration: 0, streamingText: '' }
  })

  let streamingText = ''
  let taskCompleted = false
  const streamThrottleMs = 200
  let streamDirty = false
  let streamTimer: ReturnType<typeof setTimeout> | null = null

  const flushStreamingText = (): void => {
    if (streamTimer) {
      clearTimeout(streamTimer)
      streamTimer = null
    }
    if (!streamDirty) return
    streamDirty = false
    teamEvents.emit({
      type: 'team_member_update',
      sessionId,
      memberId,
      patch: { streamingText }
    })
  }

  const runtime = await runSharedAgentRuntime({
    initialMessages,
    loopConfig,
    toolContext: {
      workingFolder,
      signal: abortController.signal,
      ipc: ipcClient,
      callerAgent: 'teammate'
    },
    isReadOnlyTool: (toolName) => READ_ONLY_TOOLS.has(toolName),
    onApprovalNeeded: async (toolCall) => {
      const autoApprove = useSettingsStore.getState().autoApprove
      if (autoApprove) return true
      const approved = useAgentStore.getState().approvedToolNames
      if (approved.includes(toolCall.name)) return true
      const result = await requestTeammatePermission({
        memberName,
        toolCall: {
          ...toolCall,
          status: 'pending_approval',
          requiresApproval: true
        }
      })
      if (result) useAgentStore.getState().addApprovedTool(toolCall.name)
      return result
    },
    hooks: {
      beforeHandleEvent: ({ event }) => {
        if (event.type !== 'iteration_start') return
        if (teammateShutdownRequested.has(memberId)) {
          return { stop: true, reason: 'shutdown' }
        }
        return undefined
      },
      afterHandleEvent: async ({ event, state }) => {
        switch (event.type) {
          case 'iteration_start':
            streamingText = ''
            flushStreamingText()
            teamEvents.emit({
              type: 'team_member_update',
              sessionId,
              memberId,
              patch: { iteration: state.iteration, status: 'working', streamingText: '' }
            })
            await syncRuntimeMemberState(memberId, {
              status: 'working',
              currentTaskId: taskId
            })
            break

          case 'text_delta':
            streamingText += event.text
            streamDirty = true
            if (!streamTimer) {
              streamTimer = setTimeout(flushStreamingText, streamThrottleMs)
            }
            break

          case 'tool_call_start':
          case 'tool_call_result':
            flushStreamingText()
            teamEvents.emit({
              type: 'team_member_update',
              sessionId,
              memberId,
              patch: { toolCalls: [...state.toolCalls] }
            })
            break

          case 'message_end':
            teamEvents.emit({
              type: 'team_member_update',
              sessionId,
              memberId,
              patch: { usage: { ...state.usage } }
            })
            break

          case 'loop_end':
            flushStreamingText()
            if ((event.reason === 'completed' || event.reason === 'max_iterations') && taskId) {
              taskCompleted = true
              teamEvents.emit({
                type: 'team_task_update',
                sessionId,
                taskId,
                patch: { status: 'completed' }
              })
              await syncRuntimeTaskState(taskId, { status: 'completed' })
              await syncRuntimeMemberState(memberId, { currentTaskId: null })
            }
            break
        }
      }
    }
  })

  if (streamTimer) {
    clearTimeout(streamTimer)
    streamTimer = null
  }
  flushStreamingText()

  // If the teammate loop ended without any final assistant text, replay the
  // transcript with a synthetic "generate a detailed report" user message.
  // Without this the lead agent loses all visibility into what the teammate did.
  let resolvedOutput = runtime.finalOutput
  if (
    !resolvedOutput.trim() &&
    runtime.finalMessages.length > 0 &&
    !abortController.signal.aborted
  ) {
    const fallback = await requestFallbackReport({
      capturedMessages: runtime.finalMessages,
      loopConfig,
      toolContext: {
        workingFolder,
        signal: abortController.signal,
        ipc: ipcClient,
        callerAgent: 'teammate'
      }
    })
    if (fallback) {
      resolvedOutput = fallback
    }
  }

  if (taskId && resolvedOutput) {
    const currentTask = useTeamStore.getState().activeTeam?.tasks.find((task) => task.id === taskId)
    if (!currentTask?.report?.trim()) {
      teamEvents.emit({
        type: 'team_task_update',
        sessionId,
        taskId,
        patch: { report: resolvedOutput }
      })
      await syncRuntimeTaskState(taskId, { report: resolvedOutput })
    }
  }

  return {
    iterations: runtime.iterations,
    toolCalls: runtime.toolCallCount,
    lastStreamingText: streamingText,
    fullOutput: resolvedOutput,
    taskCompleted,
    reason: runtime.reason,
    usage: runtime.usage
  }
}

export function findNextClaimableTask(): TeamTask | null {
  const team = useTeamStore.getState().activeTeam
  if (!team) return null

  const completedTaskIds = new Set(
    team.tasks.filter((task) => task.status === 'completed').map((task) => task.id)
  )

  for (const task of team.tasks) {
    if (task.status !== 'pending') continue
    if (task.owner) continue
    const allDepsCompleted = task.dependsOn.every((depId) => completedTaskIds.has(depId))
    if (!allDepsCompleted) continue
    return task
  }

  return null
}

function emitCompletionMessage(
  memberName: string,
  endReason: string,
  stats: {
    totalIterations: number
    totalToolCalls: number
    tasksCompleted: number
    lastStreamingText: string
    fullOutput: string
    taskId: string | null
  }
): void {
  const team = useTeamStore.getState().activeTeam
  if (!team) return

  const header = [
    `**${memberName}** finished (${endReason}).`,
    `Iterations: ${stats.totalIterations}, Tool calls: ${stats.totalToolCalls}, Tasks completed: ${stats.tasksCompleted}.`
  ].join(' ')

  const task = stats.taskId ? team.tasks.find((item) => item.id === stats.taskId) : null
  const reportText = task?.report || stats.fullOutput || stats.lastStreamingText
  let report = ''
  if (reportText) {
    if (reportText.length <= MAX_REPORT_LENGTH) {
      report = `\n\n## Report\n\n${reportText}`
    } else {
      report = `\n\n## Report\n\n${reportText.slice(-MAX_REPORT_LENGTH)}\n\n*(report truncated, showing last ${MAX_REPORT_LENGTH} chars of ${reportText.length} total)*`
    }
  }

  const content = header + report
  const message: TeamMessage = {
    id: nanoid(8),
    from: memberName,
    to: 'lead',
    type: 'message',
    content,
    summary: `${memberName} finished (${endReason}): ${stats.tasksCompleted} tasks, ${stats.totalToolCalls} tool calls`,
    timestamp: Date.now()
  }

  void appendTeamRuntimeMessage({
    teamName: team.name,
    message
  }).catch((error) => {
    console.error('[TeamRuntime] Failed to append completion message:', error)
  })

  teamEvents.emit({ type: 'team_message', sessionId: team.sessionId, message })
}

function buildPlanRequestText(task: TeamTask | null, prompt: string): string {
  const title = task?.subject ?? 'Assigned Task'
  const details = task ? getTaskDetails(task.description, title) : null
  return [
    'Create a short execution plan for the task below.',
    `Task Title: ${title}`,
    details || prompt ? `Task Details: ${details ?? prompt}` : null,
    '',
    'Requirements:',
    '- Keep it concise and implementation-focused.',
    '- Mention key files or subsystems you expect to touch.',
    '- Mention verification approach.',
    '- End with a single sentence stating you are waiting for lead approval.'
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n')
}
