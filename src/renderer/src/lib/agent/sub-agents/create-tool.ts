import { nanoid } from 'nanoid'
import type { ToolHandler, ToolContext } from '../../tools/tool-types'
import type { SubAgentDefinition, SubAgentEvent } from './types'
import type { ToolCallState } from '../types'
import { runSubAgent } from './runner'
import { subAgentEvents } from './events'
import { subAgentRegistry } from './registry'
import type { ProviderConfig, TokenUsage, ToolResultContent } from '../../api/types'
import { useAgentStore } from '../../../stores/agent-store'
import { useSettingsStore } from '../../../stores/settings-store'
import { ConcurrencyLimiter } from '../concurrency-limiter'
import { teamEvents } from '../teams/events'
import { useTeamStore } from '../../../stores/team-store'
import { runTeammate, findNextClaimableTask } from '../teams/teammate-runner'
import type { TeamMember } from '../teams/types'

/** Global concurrency limiter: at most 2 SubAgents run simultaneously. */
const subAgentLimiter = new ConcurrencyLimiter(2)

/** Metadata embedded in SubAgent output for historical rendering */
export interface SubAgentMeta {
  iterations: number
  elapsed: number
  usage: TokenUsage
  toolCalls: Array<{
    id: string
    name: string
    input: Record<string, unknown>
    status: string
    output?: string
    error?: string
    startedAt?: number
    completedAt?: number
  }>
}

const META_PREFIX = '<!--subagent-meta:'
const META_SUFFIX = '-->\n'

/** Extract embedded metadata from SubAgent output string */
export function parseSubAgentMeta(output: string): { meta: SubAgentMeta | null; text: string } {
  if (!output.startsWith(META_PREFIX)) return { meta: null, text: output }
  const endIdx = output.indexOf(META_SUFFIX)
  if (endIdx < 0) return { meta: null, text: output }
  try {
    const json = output.slice(META_PREFIX.length, endIdx)
    const meta = JSON.parse(json) as SubAgentMeta
    const text = output.slice(endIdx + META_SUFFIX.length)
    return { meta, text }
  } catch {
    return { meta: null, text: output }
  }
}

/** The unified Task tool name */
export const TASK_TOOL_NAME = 'Task'

/**
 * Build the description for the unified Task tool by embedding
 * all registered SubAgent names and descriptions.
 */
/**
 * Per-team context: concurrency limiter + working folder.
 * Each team independently allows at most 2 teammates to run
 * their agent loops simultaneously.
 */
interface TeamContext {
  limiter: ConcurrencyLimiter
  workingFolder?: string
}

const teamContexts = new Map<string, TeamContext>()

function getTeamContext(teamName: string): TeamContext {
  let ctx = teamContexts.get(teamName)
  if (!ctx) {
    ctx = { limiter: new ConcurrencyLimiter(2) }
    teamContexts.set(teamName, ctx)
  }
  return ctx
}

/** Clean up context when a team is deleted. */
export function removeTeamLimiter(teamName: string): void {
  teamContexts.delete(teamName)
}

/**
 * Framework-level task scheduler: when a concurrency slot frees up,
 * automatically find the next pending task and spawn a new teammate.
 * This replaces the old auto-claim loop inside runTeammate().
 */
function scheduleNextTask(teamName: string): void {
  const team = useTeamStore.getState().activeTeam
  if (!team || team.name !== teamName) return

  const ctx = teamContexts.get(teamName)
  if (!ctx) return
  const limiter = ctx.limiter

  // Only proceed if a slot is immediately available
  if (limiter.activeCount >= 2) return

  const nextTask = findNextClaimableTask()
  if (!nextTask) return

  const memberName = `worker-${nanoid(4)}`
  const member: TeamMember = {
    id: nanoid(),
    name: memberName,
    model: 'default',
    status: 'idle',
    currentTaskId: nextTask.id,
    iteration: 0,
    toolCalls: [],
    streamingText: '',
    startedAt: Date.now(),
    completedAt: null
  }

  // Claim task synchronously before async acquire to prevent races
  teamEvents.emit({ type: 'team_member_add', member })
  teamEvents.emit({
    type: 'team_task_update',
    taskId: nextTask.id,
    patch: { status: 'in_progress', owner: memberName }
  })

  limiter
    .acquire()
    .then(() => {
      return runTeammate({
        memberId: member.id,
        memberName,
        prompt: `Work on the following task:\n**Subject:** ${nextTask.subject}\n**Description:** ${nextTask.description}`,
        taskId: nextTask.id,
        model: null,
        workingFolder: ctx.workingFolder
      }).finally(() => {
        limiter.release()
        // Recursively schedule next pending task
        scheduleNextTask(teamName)
      })
    })
    .catch((err) => {
      console.error(`[Scheduler] Failed to start auto-teammate "${memberName}":`, err)
    })
}

function buildTaskDescription(agents: SubAgentDefinition[]): string {
  const agentLines = agents
    .map((a) => `- ${a.name}: ${a.description}`)
    .join('\n')

  return `Launch a new agent to handle complex, multi-step tasks autonomously.

The Task tool launches specialized agents that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

Available agent types (use the corresponding name as "subagent_type"):
${agentLines}

When to use the Task tool:
- Use the Task tool with specialized sub-agents when the task at hand matches the sub-agent's description. Select the most appropriate subagent_type based on the descriptions above.
- For broader codebase exploration and deep research, prefer the Task tool over doing many sequential Glob/Grep/Read calls yourself.
- When working with a Team, use Task with run_in_background=true to spawn teammate agents.

When NOT to use the Task tool:
- If you want to read a specific file path, use the Read or Glob tool instead.
- If you are searching for a specific class definition like "class Foo", use the Glob tool instead.
- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead.

Usage notes:
1. Launch multiple tasks concurrently whenever possible.
2. When the sub-agent is done, it will return a single message back to you. The result is not visible to the user — send a text summary.
3. Each sub-agent invocation is stateless.
4. The sub-agent's outputs should generally be trusted.
5. Clearly tell the sub-agent whether you expect it to write code or just do research.
6. Set run_in_background=true to spawn a teammate agent that runs independently. When done, the teammate sends its results to you via SendMessage. Your turn ends after spawning — you will be notified when teammates finish.`
}

/**
 * Execute a background teammate: spawn an independent agent loop
 * that runs in parallel. Returns immediately with spawn confirmation.
 */
async function executeBackgroundTeammate(
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResultContent> {
  const team = useTeamStore.getState().activeTeam
  if (!team) {
    return JSON.stringify({ error: 'No active team. Call TeamCreate first.' })
  }

  const memberName = String(input.name ?? '')
  if (!memberName) {
    return JSON.stringify({ error: '"name" is required when run_in_background=true' })
  }

  const existing = team.members.find((m) => m.name === memberName)
  if (existing) {
    return JSON.stringify({ error: `Teammate "${memberName}" already exists in the team.` })
  }

  const teamName = team.name
  const teamCtx = getTeamContext(teamName)
  teamCtx.workingFolder = ctx.workingFolder
  const limiter = teamCtx.limiter
  const willQueue = limiter.activeCount >= 2

  const assignedTaskId = input.task_id ? String(input.task_id) : null

  // Guard: don't re-assign completed tasks
  if (assignedTaskId) {
    const task = team.tasks.find((t) => t.id === assignedTaskId)
    if (task?.status === 'completed') {
      return JSON.stringify({
        error: `Task "${assignedTaskId}" is already completed and cannot be re-assigned.`
      })
    }
  }

  const member: TeamMember = {
    id: nanoid(),
    name: memberName,
    model: String(input.model ?? 'default'),
    status: willQueue ? 'waiting' : 'idle',
    currentTaskId: assignedTaskId,
    iteration: 0,
    toolCalls: [],
    streamingText: '',
    startedAt: Date.now(),
    completedAt: null
  }

  teamEvents.emit({ type: 'team_member_add', member })

  // If a task was assigned, mark it in_progress immediately
  if (assignedTaskId) {
    teamEvents.emit({
      type: 'team_task_update',
      taskId: assignedTaskId,
      patch: { status: 'in_progress', owner: memberName }
    })
  }

  // Fire-and-forget: start the independent agent loop for this teammate.
  // Concurrency-gated: at most 2 teammates per team run simultaneously.
  // After completion, the framework scheduler auto-starts next pending task.
  limiter
    .acquire()
    .then(() => {
      return runTeammate({
        memberId: member.id,
        memberName,
        prompt: String(input.prompt),
        taskId: assignedTaskId,
        model: input.model ? String(input.model) : null,
        workingFolder: ctx.workingFolder
      }).finally(() => {
        limiter.release()
        // Framework scheduler: auto-dispatch next pending task
        scheduleNextTask(teamName)
      })
    })
    .catch((err) => {
      console.error(`[Task/background] Failed to start teammate "${memberName}":`, err)
      // NOTE: Don't release here — if acquire() rejected, no slot was acquired.
      // If runTeammate() failed after acquire(), .finally() already released.
    })

  return JSON.stringify({
    success: true,
    member_id: member.id,
    name: memberName,
    team_name: teamName,
    message: `Teammate "${memberName}" spawned and running in background.`,
    instruction:
      'IMPORTANT: End your turn NOW. Do not call any more tools. Output a brief status summary and stop. You will be notified automatically when this teammate finishes.'
  })
}

/**
 * Creates a single unified "Task" ToolHandler that dispatches to
 * the appropriate SubAgent based on the "subagent_type" parameter.
 *
 * When run_in_background=true, spawns a teammate agent instead.
 *
 * The providerGetter is called at execution time to get the current
 * provider config (API key, model, etc.) from the settings store.
 *
 * SubAgent events are emitted to the global subAgentEvents bus
 * so the UI layer can track inner progress.
 */
export function createTaskTool(providerGetter: () => ProviderConfig): ToolHandler {
  const agents = subAgentRegistry.getAll()
  const subTypeEnum = agents.map((a) => a.name)

  return {
    definition: {
      name: TASK_TOOL_NAME,
      description: buildTaskDescription(agents),
      inputSchema: {
        type: 'object',
        oneOf: [
          {
            // Synchronous sub-agent mode
            type: 'object',
            properties: {
              subagent_type: {
                type: 'string',
                enum: subTypeEnum,
                description: 'The type of specialized agent to use for this task'
              },
              description: {
                type: 'string',
                description: 'A short (3-5 word) description of the task'
              },
              prompt: {
                type: 'string',
                description: 'The task for the agent to perform'
              },
              model: {
                type: 'string',
                description: 'Optional model override for this agent.'
              }
            },
            required: ['subagent_type', 'description', 'prompt'],
            additionalProperties: false
          },
          {
            // Background teammate mode
            type: 'object',
            properties: {
              description: {
                type: 'string',
                description: 'A short (3-5 word) description of the task'
              },
              prompt: {
                type: 'string',
                description: 'The task for the agent to perform'
              },
              run_in_background: {
                type: 'boolean',
                const: true,
                description:
                  'Set to true to run this agent in the background as a teammate. Requires an active team (TeamCreate).'
              },
              name: {
                type: 'string',
                description: 'Name for the spawned teammate agent (required in background mode)'
              },
              team_name: {
                type: 'string',
                description: 'Team name for spawning. Uses current team context if omitted.'
              },
              model: {
                type: 'string',
                description: 'Optional model override for this agent.'
              },
              task_id: {
                type: 'string',
                description: 'Optional task ID to assign to the teammate immediately'
              }
            },
            required: ['description', 'prompt', 'run_in_background', 'name'],
            additionalProperties: false
          }
        ]
      }
    },
    execute: async (input, ctx) => {
      // --- Background teammate mode ---
      if (input.run_in_background) {
        return executeBackgroundTeammate(input, ctx)
      }

      // --- Synchronous sub-agent mode ---
      const subType = String(input.subagent_type ?? '')
      if (!subType) {
        return JSON.stringify({
          error: `"subagent_type" is required for synchronous Task. Available: ${subTypeEnum.join(', ')}`
        })
      }
      const def = subAgentRegistry.get(subType)
      if (!def) {
        return JSON.stringify({
          error: `Unknown subagent_type "${subType}". Available: ${subTypeEnum.join(', ')}`
        })
      }

      // Acquire concurrency slot (blocks if 2 SubAgents are already running)
      await subAgentLimiter.acquire(ctx.signal)

      try {
        // Collect inner tool calls for metadata embedding
        const collectedToolCalls = new Map<string, ToolCallState>()
        let startedAt = Date.now()

        const onEvent = (event: SubAgentEvent): void => {
          subAgentEvents.emit(event)
          if (event.type === 'sub_agent_start') {
            startedAt = Date.now()
          }
          if (event.type === 'sub_agent_tool_call') {
            collectedToolCalls.set(event.toolCall.id, event.toolCall)
          }
        }

        const result = await runSubAgent({
          definition: def,
          parentProvider: providerGetter(),
          toolContext: ctx,
          input,
          toolUseId: ctx.currentToolUseId ?? '',
          onEvent,
          onApprovalNeeded: async (tc: ToolCallState) => {
            const autoApprove = useSettingsStore.getState().autoApprove
            if (autoApprove) return true
            const approved = useAgentStore.getState().approvedToolNames
            if (approved.includes(tc.name)) return true
            // Show in PermissionDialog
            useAgentStore.getState().addToolCall(tc)
            const result = await useAgentStore.getState().requestApproval(tc.id)
            if (result) useAgentStore.getState().addApprovedTool(tc.name)
            return result
          }
        })

        // Build metadata for historical rendering (truncate large outputs to prevent bloat)
        const MAX_OUTPUT = 6000
        const MAX_INPUT_VALUE = 2000
        const truncStr = (s: string | undefined, max: number): string | undefined => {
          if (!s || s.length <= max) return s
          return s.slice(0, max) + `\n... [truncated, ${s.length} chars total]`
        }
        const truncInput = (inp: Record<string, unknown>): Record<string, unknown> => {
          const out: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(inp)) {
            out[k] =
              typeof v === 'string' && v.length > MAX_INPUT_VALUE
                ? v.slice(0, MAX_INPUT_VALUE) + `... [${v.length} chars]`
                : v
          }
          return out
        }
        const meta: SubAgentMeta = {
          iterations: result.iterations,
          elapsed: Date.now() - startedAt,
          usage: result.usage,
          toolCalls: Array.from(collectedToolCalls.values()).map((tc) => ({
            id: tc.id,
            name: tc.name,
            input: truncInput(tc.input),
            status: tc.status,
            output: truncStr(
              typeof tc.output === 'string'
                ? tc.output
                : tc.output
                  ? JSON.stringify(tc.output)
                  : undefined,
              MAX_OUTPUT
            ),
            error: tc.error,
            startedAt: tc.startedAt,
            completedAt: tc.completedAt
          }))
        }
        const metaStr = `${META_PREFIX}${JSON.stringify(meta)}${META_SUFFIX}`

        if (!result.success) {
          return (
            metaStr +
            JSON.stringify({
              error: result.error ?? 'SubAgent failed',
              toolCalls: result.toolCallCount,
              iterations: result.iterations
            })
          )
        }

        return metaStr + result.output
      } finally {
        subAgentLimiter.release()
      }
    },
    requiresApproval: (input) => !!input.run_in_background
  }
}
