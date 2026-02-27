import { nanoid } from 'nanoid'
import { runAgentLoop } from '../agent-loop'
import { toolRegistry } from '../tool-registry'
import { teamEvents } from './events'
import { useTeamStore } from '../../../stores/team-store'
import { useSettingsStore } from '../../../stores/settings-store'
import { useProviderStore } from '../../../stores/provider-store'
import { ensureProviderAuthReady } from '../../auth/provider-auth'
import { useAgentStore } from '../../../stores/agent-store'
import { ipcClient } from '../../ipc/ipc-client'
import { MessageQueue } from '../types'
import type { AgentLoopConfig, ToolCallState } from '../types'
import type { UnifiedMessage, ProviderConfig, TokenUsage } from '../../api/types'
import type { TeamMessage, TeamTask } from './types'

// --- AbortController registry for individual teammates ---
const teammateAbortControllers = new Map<string, AbortController>()

// --- Graceful shutdown registry ---
// When a shutdown_request is received, the teammate finishes its current
// iteration and then stops — instead of hard aborting mid-tool-call.
const teammateShutdownRequested = new Set<string>()
// 0 => unlimited iterations (teammate stops only on completion/shutdown/error/abort)
const DEFAULT_TEAMMATE_MAX_ITERATIONS = 0

/**
 * Request graceful shutdown: teammate finishes current iteration then stops.
 */
export function requestTeammateShutdown(memberId: string): void {
  teammateShutdownRequested.add(memberId)
}

/**
 * Abort a running teammate by member ID (hard stop).
 * Returns true if the teammate was found and aborted.
 */
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

/** Abort all running teammates (e.g. on TeamDelete). */
export function abortAllTeammates(): void {
  for (const [id, ac] of teammateAbortControllers) {
    ac.abort()
    teammateAbortControllers.delete(id)
  }
  teammateShutdownRequested.clear()
}

/** Check if a teammate is still running. */
export function isTeammateRunning(memberId: string): boolean {
  return teammateAbortControllers.has(memberId)
}

interface RunTeammateOptions {
  memberId: string
  memberName: string
  prompt: string
  taskId: string | null
  model: string | null
  workingFolder?: string
}

/**
 * Start an independent agent loop for a teammate.
 * Runs in background (fire-and-forget). Updates team-store via teamEvents.
 *
 * Each teammate executes a single assigned task then stops.
 * The framework-level scheduler (in create-tool.ts) handles
 * auto-dispatching the next pending task to a new teammate
 * when a concurrency slot frees up.
 *
 * On completion (or error), the teammate automatically sends a summary
 * message to the lead so the lead's context includes the result without
 * needing to poll. The lead is auto-notified via SendMessage.
 */
export async function runTeammate(options: RunTeammateOptions): Promise<void> {
  const { memberId, memberName, model, workingFolder } = options
  let { prompt, taskId } = options

  const abortController = new AbortController()
  teammateAbortControllers.set(memberId, abortController)

  // Exclude team management tools from teammate (only lead should manage team).
  // TaskCreate is excluded because teammates should not create new tasks.
  // Note: Task tool is kept but run_in_background is guarded inside executeBackgroundTeammate
  // (requires active team context; teammate spawning teammate is blocked below via approval).
  const LEAD_ONLY_TOOLS = new Set(['TeamCreate', 'TeamDelete', 'TaskCreate'])
  const toolDefs = toolRegistry.getDefinitions().filter((t) => !LEAD_ONLY_TOOLS.has(t.name))

  // Message queue: receives messages from lead/other teammates and injects
  // them into the agent loop at iteration boundaries (between turns).
  const messageQueue = new MessageQueue()

  // Listen for team messages targeting this teammate
  const unsubMessages = teamEvents.on((event) => {
    if (event.type !== 'team_message') return
    const msg = event.message
    const isForMe = msg.to === memberName || msg.to === 'all'
    if (!isForMe) return
    // Don't inject our own messages
    if (msg.from === memberName) return

    if (msg.type === 'shutdown_request') {
      teammateShutdownRequested.add(memberId)
    } else {
      // Inject as a user message so the LLM sees it on the next turn
      messageQueue.push({
        id: nanoid(),
        role: 'user',
        content: `[Team message from ${msg.from}]: ${msg.content}`,
        createdAt: msg.timestamp
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
    // If no task was assigned, try to auto-claim one before starting
    if (!taskId) {
      const initialTask = findNextClaimableTask()
      if (initialTask) {
        taskId = initialTask.id
        prompt = `Work on the following task:\n**Subject:** ${initialTask.subject}\n**Description:** ${initialTask.description}\n\nAdditional context from lead:\n${prompt}`
        teamEvents.emit({
          type: 'team_task_update',
          taskId: initialTask.id,
          patch: { status: 'in_progress', owner: memberName }
        })
        teamEvents.emit({
          type: 'team_member_update',
          memberId,
          patch: { currentTaskId: initialTask.id }
        })
      }
    }

    // Execute the single assigned task (no auto-claim loop;
    // the framework scheduler handles dispatching next tasks).
    const result = await runSingleTaskLoop({
      memberId,
      memberName,
      prompt,
      taskId,
      model,
      workingFolder,
      abortController,
      toolDefs,
      messageQueue
    })

    totalIterations = result.iterations
    totalToolCalls = result.toolCalls
    lastStreamingText = result.lastStreamingText
    fullOutput = result.fullOutput
    if (result.taskCompleted) tasksCompleted++
    if (result.reason === 'aborted') endReason = 'aborted'
    else if (result.reason === 'shutdown') endReason = 'shutdown'
    else if (result.reason === 'error') endReason = 'error'

    // Mark member as stopped
    teamEvents.emit({
      type: 'team_member_update',
      memberId,
      patch: { status: 'stopped', completedAt: Date.now() }
    })
  } catch (err) {
    endReason = 'error'
    if (!abortController.signal.aborted) {
      console.error(`[Teammate ${memberName}] Error:`, err)
    }
    teamEvents.emit({
      type: 'team_member_update',
      memberId,
      patch: { status: 'stopped', completedAt: Date.now() }
    })
  } finally {
    teammateAbortControllers.delete(memberId)
    teammateShutdownRequested.delete(memberId)
    unsubMessages()

    // --- P0: Auto-notify lead with completion summary ---
    // IMPORTANT: Do NOT emit for aborted teammates. When the user clicks Stop,
    // abortAllTeammates() fires. If we still emit here, the completion message
    // triggers drainLeadMessages → new main agent turn → potential re-spawn → dead loop.
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

// ── Single task execution ──────────────────────────────────────────

interface SingleTaskResult {
  iterations: number
  toolCalls: number
  lastStreamingText: string
  fullOutput: string
  taskCompleted: boolean
  reason: 'completed' | 'max_iterations' | 'aborted' | 'shutdown' | 'error'
  usage: TokenUsage
}

async function runSingleTaskLoop(opts: {
  memberId: string
  memberName: string
  prompt: string
  taskId: string | null
  model: string | null
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
    workingFolder,
    abortController,
    toolDefs,
    messageQueue
  } = opts

  // Build provider config from provider-store with fallback to settings-store
  const settings = useSettingsStore.getState()
  const providerState = useProviderStore.getState()
  const activeProviderId = providerState.activeProviderId
  if (activeProviderId) {
    const ready = await ensureProviderAuthReady(activeProviderId)
    if (!ready) {
      throw new Error('Provider authentication required. Please sign in.')
    }
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

  const team = useTeamStore.getState().activeTeam
  const taskInfo = taskId && team ? team.tasks.find((t) => t.id === taskId) : null

  const systemPrompt = buildTeammateSystemPrompt({
    memberName,
    teamName: team?.name ?? 'team',
    prompt,
    task: taskInfo
      ? { id: taskInfo.id, subject: taskInfo.subject, description: taskInfo.description }
      : null,
    workingFolder,
    language: settings.language
  })
  providerConfig.systemPrompt = systemPrompt

  const loopConfig: AgentLoopConfig = {
    maxIterations: DEFAULT_TEAMMATE_MAX_ITERATIONS,
    provider: providerConfig,
    tools: toolDefs,
    systemPrompt,
    workingFolder,
    signal: abortController.signal,
    messageQueue
  }

  const userMsg: UnifiedMessage = {
    id: nanoid(),
    role: 'user',
    content: prompt,
    createdAt: Date.now()
  }

  // Mark member as working
  teamEvents.emit({
    type: 'team_member_update',
    memberId,
    patch: { status: 'working', iteration: 0 }
  })

  const collectedToolCalls: ToolCallState[] = []
  let iteration = 0
  let streamingText = ''
  let fullOutput = ''
  let reason: SingleTaskResult['reason'] = 'completed'
  let taskCompleted = false
  let taskAlreadyDone = false

  // Accumulate token usage across all iterations
  const accumulatedUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }

  // Throttle streamingText updates to reduce store churn / re-renders.
  // Accumulate deltas and flush at most every 200 ms.
  const STREAM_THROTTLE_MS = 200
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
      memberId,
      patch: { streamingText }
    })
  }

  try {
    const loop = runAgentLoop(
      [userMsg],
      loopConfig,
      { workingFolder, signal: abortController.signal, ipc: ipcClient },
      async (tc) => {
        if (READ_ONLY_TOOLS.has(tc.name)) return true
        const autoApprove = useSettingsStore.getState().autoApprove
        if (autoApprove) return true
        // Per-session tool approval memory
        const approved = useAgentStore.getState().approvedToolNames
        if (approved.includes(tc.name)) return true
        // Bubble up to UI PermissionDialog
        const result = await useAgentStore.getState().requestApproval(tc.id)
        if (result) useAgentStore.getState().addApprovedTool(tc.name)
        return result
      }
    )

    for await (const event of loop) {
      if (abortController.signal.aborted) {
        reason = 'aborted'
        break
      }

      switch (event.type) {
        case 'iteration_start':
          // Check graceful shutdown between iterations
          if (teammateShutdownRequested.has(memberId)) {
            reason = 'shutdown'
            break
          }
          // Check if current task was already completed by the LLM (via TaskUpdate)
          // in a previous iteration. If so, stop the loop early — no need to
          // keep running more iterations on a finished task.
          if (taskId) {
            const currentTeam = useTeamStore.getState().activeTeam
            const currentTask = currentTeam?.tasks.find((t) => t.id === taskId)
            if (currentTask?.status === 'completed') {
              taskCompleted = true
              taskAlreadyDone = true
              break
            }
          }
          iteration = event.iteration
          streamingText = ''
          flushStreamingText()
          teamEvents.emit({
            type: 'team_member_update',
            memberId,
            patch: { iteration, status: 'working', streamingText: '' }
          })
          break

        case 'text_delta':
          streamingText += event.text
          fullOutput += event.text
          streamDirty = true
          if (!streamTimer) {
            streamTimer = setTimeout(flushStreamingText, STREAM_THROTTLE_MS)
          }
          break

        case 'tool_call_approval_needed': {
          // Add to agent store's pending list so PermissionDialog renders
          const willAutoApprove =
            useSettingsStore.getState().autoApprove ||
            useAgentStore.getState().approvedToolNames.includes(event.toolCall.name)
          if (!willAutoApprove) {
            useAgentStore.getState().addToolCall(event.toolCall)
          }
          break
        }

        case 'tool_call_start':
        case 'tool_call_result':
          {
            // Flush any buffered streaming text before reporting tool activity
            flushStreamingText()
            const idx = collectedToolCalls.findIndex((t) => t.id === event.toolCall.id)
            if (idx >= 0) {
              collectedToolCalls[idx] = event.toolCall
            } else {
              collectedToolCalls.push(event.toolCall)
            }
            teamEvents.emit({
              type: 'team_member_update',
              memberId,
              patch: { toolCalls: [...collectedToolCalls] }
            })
          }
          break

        case 'message_end':
          if (event.usage) {
            mergeTeammateUsage(accumulatedUsage, event.usage)
            teamEvents.emit({
              type: 'team_member_update',
              memberId,
              patch: { usage: { ...accumulatedUsage } }
            })
          }
          break

        case 'loop_end':
          flushStreamingText()
          reason = event.reason as SingleTaskResult['reason']
          if ((event.reason === 'completed' || event.reason === 'max_iterations') && taskId) {
            teamEvents.emit({
              type: 'team_task_update',
              taskId,
              patch: { status: 'completed' }
            })
            taskCompleted = true
          }
          break
      }

      // Break outer for-await if we should stop early
      // (shutdown requested, or task already completed via TaskUpdate)
      if (reason === 'shutdown' || taskAlreadyDone) break
    }
  } catch {
    reason = 'error'
  } finally {
    // Clean up streaming throttle timer
    if (streamTimer) {
      clearTimeout(streamTimer)
      streamTimer = null
    }
    flushStreamingText()
  }

  return {
    iterations: iteration,
    toolCalls: collectedToolCalls.length,
    lastStreamingText: streamingText,
    fullOutput,
    taskCompleted,
    reason,
    usage: accumulatedUsage
  }
}

// ── Auto-claim: find next unassigned, unblocked pending task ──────

export function findNextClaimableTask(): TeamTask | null {
  const team = useTeamStore.getState().activeTeam
  if (!team) return null

  // Get completed task IDs for dependency checking
  const completedTaskIds = new Set(
    team.tasks.filter((t) => t.status === 'completed').map((t) => t.id)
  )

  for (const task of team.tasks) {
    if (task.status !== 'pending') continue
    if (task.owner) continue // already assigned

    // Check dependencies are all completed
    const allDepsCompleted = task.dependsOn.every((depId) => completedTaskIds.has(depId))
    if (!allDepsCompleted) continue

    return task
  }

  return null
}

// ── Auto-notify: send completion summary to lead ─────────────────

const MAX_REPORT_LENGTH = 4000

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
  if (!team) return // team already deleted

  const header = [
    `**${memberName}** finished (${endReason}).`,
    `Iterations: ${stats.totalIterations}, Tool calls: ${stats.totalToolCalls}, Tasks completed: ${stats.tasksCompleted}.`
  ].join(' ')

  // Priority: task.report (explicit tool submission) > fullOutput > lastStreamingText
  const task = stats.taskId ? team.tasks.find((t) => t.id === stats.taskId) : null
  const reportText = task?.report || stats.fullOutput || stats.lastStreamingText
  let report = ''
  if (reportText) {
    if (reportText.length <= MAX_REPORT_LENGTH) {
      report = `\n\n## Report\n${reportText}`
    } else {
      report = `\n\n## Report\n${reportText.slice(-MAX_REPORT_LENGTH)}\n\n*(report truncated, showing last ${MAX_REPORT_LENGTH} chars of ${reportText.length} total)*`
    }
  }

  const content = header + report

  const msg: TeamMessage = {
    id: nanoid(8),
    from: memberName,
    to: 'lead',
    type: 'message',
    content,
    summary: `${memberName} finished (${endReason}): ${stats.tasksCompleted} tasks, ${stats.totalToolCalls} tool calls`,
    timestamp: Date.now()
  }

  teamEvents.emit({ type: 'team_message', message: msg })
}

// --- Helpers ---

const READ_ONLY_TOOLS = new Set([
  'Read',
  'LS',
  'Glob',
  'Grep',
  'TaskList',
  'TaskGet',
  'TeamStatus'
])

function buildTeammateSystemPrompt(options: {
  memberName: string
  teamName: string
  prompt: string
  task: { id: string; subject: string; description: string } | null
  workingFolder?: string
  language?: string
}): string {
  const { memberName, teamName, prompt, task, workingFolder, language } = options

  const parts: string[] = []

  parts.push(
    `You are "${memberName}", a teammate agent in the "${teamName}" team.`,
    `You are part of a multi-agent team working in parallel on a shared codebase.`,
    `You should focus exclusively on your assigned work and avoid modifying files outside your scope.`,
    `**You MUST respond in ${language === 'zh' ? 'Chinese (中文)' : 'English'} unless explicitly instructed otherwise.**`
  )

  if (task) {
    parts.push(
      `\n## Your Task`,
      `**ID:** ${task.id}`,
      `**Subject:** ${task.subject}`,
      `**Description:** ${task.description}`
    )
  }

  parts.push(`\n## Instructions\n${prompt}`)

  if (workingFolder) {
    parts.push(`\n## Working Folder\n\`${workingFolder}\``)
    parts.push(`All relative paths should be resolved against this folder.`)
  }

  parts.push(
    `\n## Coordination Rules`,
    `- Only modify files related to your assigned task.`,
    `- When your task is done, call TaskUpdate with status="completed" and report="..." to submit your final report.`,
    `- Use SendMessage to communicate with the lead or other teammates if needed.`,
    `- After completing your task, you will stop. The framework will automatically assign remaining pending tasks to new teammates.`,
    `- If you receive a shutdown request, finish your current work promptly and stop.`,
    `- Be concise and efficient — you have limited iterations.`,
    `\n## Reporting`,
    `IMPORTANT: When completing your task, you MUST submit your report via the TaskUpdate tool:`,
    `\`TaskUpdate(task_id="...", status="completed", report="your detailed report here")\``,
    `The report field should contain all findings, data collected, actions taken, and conclusions. Do NOT write reports to files. The report is automatically forwarded to the lead agent.`,
    `Include in your report:`,
    `- What was done (actions taken, files read/modified)`,
    `- Key findings or data collected`,
    `- Any issues encountered or decisions made`,
    `- Conclusions or recommendations`
  )

  return parts.join('\n')
}

/**
 * Merge incoming TokenUsage into an accumulator (mutates target).
 * Sums inputTokens, outputTokens, and optional cache/reasoning fields.
 */
function mergeTeammateUsage(target: TokenUsage, incoming: TokenUsage): void {
  target.inputTokens += incoming.inputTokens
  target.outputTokens += incoming.outputTokens
  if (incoming.cacheCreationTokens) {
    target.cacheCreationTokens = (target.cacheCreationTokens ?? 0) + incoming.cacheCreationTokens
  }
  if (incoming.cacheReadTokens) {
    target.cacheReadTokens = (target.cacheReadTokens ?? 0) + incoming.cacheReadTokens
  }
  if (incoming.reasoningTokens) {
    target.reasoningTokens = (target.reasoningTokens ?? 0) + incoming.reasoningTokens
  }
}
