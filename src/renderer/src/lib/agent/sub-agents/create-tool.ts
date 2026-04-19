import { nanoid } from 'nanoid'
import type { ToolHandler, ToolContext } from '../../tools/tool-types'
import type { SubAgentDefinition, SubAgentEvent } from './types'
import type { ToolCallState } from '../types'
import { runSubAgent } from './runner'
import { subAgentEvents } from './events'
import { subAgentRegistry } from './registry'
import { buildDefaultSubAgentSystemPrompt } from './default-system-prompt'
import type { ProviderConfig, TokenUsage, ToolResultContent } from '../../api/types'
import type { TeamRuntimeTaskStatus } from '../../../../../shared/team-runtime-types'
import { encodeStructuredToolResult, encodeToolError } from '../../tools/tool-result-format'
import { useAgentStore } from '../../../stores/agent-store'
import { useSettingsStore } from '../../../stores/settings-store'
import { ConcurrencyLimiter } from '../concurrency-limiter'
import { teamEvents } from '../teams/events'
import { useTeamStore } from '../../../stores/team-store'
import { runTeammate, findNextClaimableTask } from '../teams/teammate-runner'
import { spawnIsolatedTeamWorker } from '../teams/backend-client'
import { updateTeamRuntimeManifest, updateTeamRuntimeMember } from '../teams/runtime-client'
import type { TeamMember } from '../teams/types'
import { DEFAULT_SUB_AGENT_MAX_TURNS } from './limits'
import { getEffectiveSubAgentDisallowedTools } from './resolve-tools'

const subAgentLimiter = new ConcurrencyLimiter(2)

/**
 * Tracks the immediately-previous synchronous Task invocation per session so
 * we can block back-to-back identical sub-agent calls. Some parent models will
 * happily re-invoke the same sub-agent with the same prompt over and over
 * after it returns a report, wasting tokens and confusing the UI. Blocking
 * the second identical call and returning the previous report forces the
 * parent to move on.
 */
interface LastTaskInvocation {
  key: string
  output: string
  toolUseId: string
}
const lastTaskInvocationBySession = new Map<string, LastTaskInvocation>()

function normalizeTaskPrompt(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\s+/g, ' ')
}

function buildTaskDedupKey(input: Record<string, unknown>): string {
  const subType = String(input.subagent_type ?? '')
  const prompt =
    normalizeTaskPrompt(input.prompt) ||
    normalizeTaskPrompt(input.query) ||
    normalizeTaskPrompt(input.task) ||
    normalizeTaskPrompt(input.target)
  return `${subType}::${prompt}`
}

export function clearLastTaskInvocation(sessionId: string | undefined | null): void {
  if (!sessionId) return
  lastTaskInvocationBySession.delete(sessionId)
}

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

export const TASK_TOOL_NAME = 'Task'

interface TeamContext {
  limiter: ConcurrencyLimiter
  workingFolder?: string
  defaultBackend?: 'in-process' | 'isolated-renderer'
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

export function removeTeamLimiter(teamName: string): void {
  teamContexts.delete(teamName)
}

async function syncRuntimeTaskPatch(
  teamName: string,
  taskId: string,
  patch: Partial<{ status: TeamRuntimeTaskStatus; owner: string | null; report: string }>
): Promise<void> {
  const team = useTeamStore.getState().activeTeam
  if (!team || team.name !== teamName) return

  await updateTeamRuntimeManifest({
    teamName,
    patch: {
      tasks: team.tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task))
    }
  })
}

function getTeamTaskDetails(
  description: string | null | undefined,
  subject: string
): string | null {
  const trimmed = typeof description === 'string' ? description.trim() : ''
  if (!trimmed || trimmed === subject.trim()) return null
  return trimmed
}

function buildTeamTaskPrompt(task: { subject: string; description?: string | null }): string {
  const lines = ['Work on the following task:', `**Title:** ${task.subject}`]
  const details = getTeamTaskDetails(task.description, task.subject)
  if (details) {
    lines.push(`**Details:** ${details}`)
  }
  return lines.join('\n')
}

function scheduleNextTask(teamName: string): void {
  const team = useTeamStore.getState().activeTeam
  if (!team || team.name !== teamName) return

  const ctx = teamContexts.get(teamName)
  if (!ctx) return
  const limiter = ctx.limiter
  if (limiter.activeCount >= 2) return

  const nextTask = findNextClaimableTask()
  if (!nextTask) return

  const memberName = `worker-${nanoid(4)}`
  const member: TeamMember = {
    id: nanoid(),
    name: memberName,
    model: 'default',
    backendType: ctx.defaultBackend ?? 'in-process',
    role: 'worker',
    status: 'idle',
    currentTaskId: nextTask.id,
    iteration: 0,
    toolCalls: [],
    streamingText: '',
    startedAt: Date.now(),
    completedAt: null
  }

  teamEvents.emit({ type: 'team_member_add', sessionId: team.sessionId, member })
  teamEvents.emit({
    type: 'team_task_update',
    sessionId: team.sessionId,
    taskId: nextTask.id,
    patch: { status: 'in_progress', owner: memberName }
  })

  limiter
    .acquire()
    .then(() => {
      return runTeammate({
        memberId: member.id,
        memberName,
        prompt: buildTeamTaskPrompt(nextTask),
        taskId: nextTask.id,
        model: null,
        agentName: null,
        workingFolder: ctx.workingFolder
      }).finally(() => {
        limiter.release()
        scheduleNextTask(teamName)
      })
    })
    .catch((err) => {
      console.error(`[Scheduler] Failed to start auto-teammate "${memberName}":`, err)
    })
}

function formatAgentToolScope(agent: SubAgentDefinition): string {
  const tools = agent.tools ?? []
  if (tools.length === 0) return 'Read, Glob, Grep, LS, Skill'
  const denied = getEffectiveSubAgentDisallowedTools(agent.disallowedTools ?? [])
  if (tools.includes('*')) {
    return denied.length > 0 ? `All tools except ${denied.join(', ')}` : '*'
  }
  return tools.filter((tool) => !denied.includes(tool)).join(', ')
}

function buildTaskDescription(agents: SubAgentDefinition[]): string {
  const agentLines = agents
    .map((a) => `- ${a.name}: ${a.description} (Tools: ${formatAgentToolScope(a)})`)
    .join('\n')

  return `Launch a new agent to handle complex, multi-step tasks autonomously.

The Task tool launches specialized agents (sub-agents) that autonomously handle complex tasks. Each agent type has its own focused system prompt and tool allowlist.

Available agent types and the tools they have access to:
${agentLines}
- custom: General-purpose sub-agent with a built-in default system prompt and broad tool access except Task and AskUserQuestion. Use this when none of the specialized agents above are a clean fit. You only supply the task via "prompt" — do NOT try to pass a system prompt, tools list, or permissions; those are fixed by the runtime. (Tools: All tools except Task, AskUserQuestion)

When using the Task tool, you MUST specify a "subagent_type" parameter to select which agent type to use.

When NOT to use the Task tool:
- If you want to read a specific file path, use the Read or Glob tool instead, to find the match more quickly.
- If you are searching for a specific class definition like "class Foo", use the Glob tool instead.
- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead.
- For tasks that are not related to any of the agent descriptions above and cannot be expressed as a focused prompt, do the work yourself.

Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do.
- Launch multiple agents concurrently whenever possible, to maximize performance. To do that, send a single assistant message containing multiple Task tool_use blocks.
- When the sub-agent is done, it will return a single message back to you. The result is not visible to the user — you must send a concise text summary back to the user after the agent returns.
- Each sub-agent invocation is stateless: it does not see the current conversation history, so write self-contained prompts that include all context the sub-agent needs.
- Clearly tell the sub-agent whether you expect it to write code or just do research (search, file reads, web fetches), since it does not see the user's intent.
- The sub-agent's outputs should generally be trusted.
- If a sub-agent's description says it should be used proactively for its domain, prefer launching it without waiting for the user to ask.
- If the user explicitly asks for work to run "in parallel", you MUST send a single message with multiple Task tool_use blocks.
- Set "run_in_background": true to spawn a teammate that runs independently. Your turn ends after spawning — you will be notified automatically when the teammate finishes. Background mode requires an active team (TeamCreate).

Example usage:

<example>
user: "Please write a function that checks if a number is prime"
assistant: (writes the function using the Edit tool)
<commentary>
A significant code change was just made, so delegate verification to a focused sub-agent.
</commentary>
assistant: (launches a Task with subagent_type="custom", description="verify prime function", prompt="Verify that isPrime() in <file> is correct, run any available tests, and report pass/fail with evidence.")
</example>

<example>
user: "investigate why the sidecar deadlocks on startup"
<commentary>
Open-ended investigation across many files — exactly what Task is for.
</commentary>
assistant: (launches a Task with subagent_type="custom", description="investigate sidecar deadlock", prompt="Investigate why src/dotnet/OpenCowork.Agent deadlocks on startup. Trace the initialization path, identify the blocking await, and report the root cause with file:line evidence.")
</example>`
}

async function executeBackgroundTeammate(
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResultContent> {
  if (ctx.callerAgent === 'teammate') {
    return encodeToolError(
      'Background teammate spawning is not allowed from a teammate. Send a message to the lead instead.'
    )
  }

  const team = useTeamStore.getState().activeTeam
  if (!team) {
    return encodeToolError('No active team. Call TeamCreate first.')
  }

  const requestedTeamName = input.team_name ? String(input.team_name) : null
  if (requestedTeamName && requestedTeamName !== team.name) {
    return encodeToolError(
      `Active team is "${team.name}", but received team_name="${requestedTeamName}".`
    )
  }

  const memberName = String(input.name ?? '')
  if (!memberName) {
    return encodeToolError('"name" is required when run_in_background=true')
  }

  const existing = team.members.find((m) => m.name === memberName)
  if (existing) {
    return encodeToolError(`Teammate "${memberName}" already exists in the team.`)
  }

  const subType = input.subagent_type ? String(input.subagent_type) : null
  const agentDefinition = subType ? subAgentRegistry.get(subType) : null
  if (subType && !agentDefinition) {
    return encodeToolError(`Unknown subagent_type "${subType}".`)
  }

  const teamName = team.name
  const teamCtx = getTeamContext(teamName)
  teamCtx.workingFolder = ctx.workingFolder
  teamCtx.defaultBackend = team.defaultBackend
  const limiter = teamCtx.limiter
  const backendType =
    input.backend_type === 'isolated-renderer' || input.backend_type === 'in-process'
      ? (input.backend_type as 'in-process' | 'isolated-renderer')
      : (team.defaultBackend ?? 'in-process')
  const willQueue = limiter.activeCount >= 2

  const assignedTaskId = input.task_id ? String(input.task_id) : null
  if (assignedTaskId) {
    const task = team.tasks.find((t) => t.id === assignedTaskId)
    if (task?.status === 'completed') {
      return encodeToolError(
        `Task "${assignedTaskId}" is already completed and cannot be re-assigned.`
      )
    }
  }

  const member: TeamMember = {
    id: nanoid(),
    name: memberName,
    model: String(input.model ?? 'default'),
    backendType,
    role: 'worker',
    ...(agentDefinition ? { agentName: agentDefinition.name } : {}),
    status: willQueue ? 'waiting' : 'idle',
    currentTaskId: assignedTaskId,
    iteration: 0,
    toolCalls: [],
    streamingText: '',
    startedAt: Date.now(),
    completedAt: null
  }

  teamEvents.emit({ type: 'team_member_add', sessionId: team.sessionId, member })
  void updateTeamRuntimeMember({
    teamName,
    memberId: member.id,
    patch: {
      agentId: member.id,
      name: member.name,
      role: 'worker',
      backendType,
      model: member.model,
      agentType: agentDefinition?.name,
      status: willQueue ? 'waiting' : 'idle',
      currentTaskId: assignedTaskId
    }
  }).catch((error) => {
    console.error('[TeamRuntime] Failed to sync teammate member record:', error)
  })

  if (assignedTaskId) {
    teamEvents.emit({
      type: 'team_task_update',
      sessionId: team.sessionId,
      taskId: assignedTaskId,
      patch: { status: 'in_progress', owner: memberName }
    })
    void syncRuntimeTaskPatch(teamName, assignedTaskId, {
      status: 'in_progress',
      owner: memberName
    }).catch((error) => {
      console.error('[TeamRuntime] Failed to sync assigned task state:', error)
    })
  }

  limiter
    .acquire()
    .then(() => {
      const markWorking = async (): Promise<void> => {
        teamEvents.emit({
          type: 'team_member_update',
          sessionId: team.sessionId,
          memberId: member.id,
          patch: { status: 'working' }
        })
        await updateTeamRuntimeMember({
          teamName,
          memberId: member.id,
          patch: { status: 'working' }
        })
      }

      const runPromise =
        backendType === 'isolated-renderer'
          ? spawnIsolatedTeamWorker({
              teamName,
              memberId: member.id,
              memberName,
              prompt: String(input.prompt ?? ''),
              taskId: assignedTaskId,
              model: input.model ? String(input.model) : null,
              agentName: agentDefinition?.name ?? null,
              workingFolder: ctx.workingFolder
            }).then(markWorking)
          : markWorking().then(() =>
              runTeammate({
                memberId: member.id,
                memberName,
                prompt: String(input.prompt ?? ''),
                taskId: assignedTaskId,
                model: input.model ? String(input.model) : null,
                agentName: agentDefinition?.name ?? null,
                workingFolder: ctx.workingFolder
              })
            )

      return runPromise.finally(() => {
        limiter.release()
        scheduleNextTask(teamName)
      })
    })
    .catch((err) => {
      console.error(`[Task/background] Failed to start teammate "${memberName}":`, err)
    })

  return encodeStructuredToolResult({
    success: true,
    member_id: member.id,
    name: memberName,
    team_name: teamName,
    backend_type: backendType,
    message: `Teammate "${memberName}" spawned and running in background via ${backendType}.`,
    instruction:
      'IMPORTANT: End your turn NOW. Do not call any more tools. Output a brief status summary and stop. You will be notified automatically when this teammate finishes.'
  })
}

export const CUSTOM_SUBAGENT_TYPE = 'custom'

export function createTaskTool(providerGetter: () => ProviderConfig): ToolHandler {
  const agents = subAgentRegistry.getAll()
  const subTypeEnum = [...agents.map((a) => a.name), CUSTOM_SUBAGENT_TYPE]

  return {
    definition: {
      name: TASK_TOOL_NAME,
      description: buildTaskDescription(agents),
      inputSchema: {
        type: 'object',
        oneOf: [
          {
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
              subagent_type: {
                type: 'string',
                enum: subTypeEnum,
                description:
                  'The type of specialized agent to use for this task. Use "custom" for a general-purpose sub-agent with broad tool access except Task and AskUserQuestion and a built-in default system prompt — you only supply the task via "prompt".'
              },
              model: {
                type: 'string',
                description:
                  'Optional model override for this agent. If not specified, inherits from the parent. Prefer a faster/cheaper model for quick, straightforward tasks to minimize cost and latency.'
              }
            },
            required: ['description', 'prompt', 'subagent_type'],
            additionalProperties: false
          },
          {
            type: 'object',
            properties: {
              description: {
                type: 'string',
                description: 'A short (3-5 word) description of the task'
              },
              prompt: {
                type: 'string',
                description:
                  'The task for the teammate to perform. Write a self-contained brief — the teammate does not see the current conversation history.'
              },
              run_in_background: {
                type: 'boolean',
                const: true,
                description:
                  'Set to true to run this agent in the background as a teammate that runs independently. Your turn ends after spawning; you will be notified when the teammate finishes. Requires an active team (TeamCreate).'
              },
              name: {
                type: 'string',
                description:
                  'Name for the spawned teammate agent (required in background mode). Must be unique within the active team.'
              },
              team_name: {
                type: 'string',
                description:
                  'Optional team name for spawning. Uses the current active team if omitted.'
              },
              subagent_type: {
                type: 'string',
                enum: subTypeEnum,
                description:
                  'Optional specialized background agent type to use for this teammate. Use "custom" for a general-purpose teammate with broad tool access except Task and AskUserQuestion.'
              },
              model: {
                type: 'string',
                description:
                  'Optional model override for this agent. If not specified, inherits from the parent. Prefer a faster/cheaper model for quick, straightforward tasks.'
              },
              task_id: {
                type: 'string',
                description: 'Optional task ID to assign to the teammate immediately.'
              },
              backend_type: {
                type: 'string',
                enum: ['in-process', 'isolated-renderer'],
                description:
                  'Optional backend override for the teammate runtime: "in-process" shares the current renderer, "isolated-renderer" spawns a dedicated worker.'
              }
            },
            required: ['description', 'prompt', 'run_in_background', 'name'],
            additionalProperties: false
          }
        ]
      }
    },
    execute: async (input, ctx) => {
      if (input.run_in_background) {
        return executeBackgroundTeammate(input, ctx)
      }

      const subType = String(input.subagent_type ?? '')
      if (!subType) {
        return encodeToolError(
          `"subagent_type" is required for synchronous Task. Available: ${subTypeEnum.join(', ')}`
        )
      }

      const isCustom = subType === CUSTOM_SUBAGENT_TYPE
      let def: SubAgentDefinition | undefined
      if (isCustom) {
        def = {
          name: CUSTOM_SUBAGENT_TYPE,
          description:
            typeof input.description === 'string' ? input.description : 'Custom sub-agent',
          systemPrompt: buildDefaultSubAgentSystemPrompt({
            workingFolder: ctx.workingFolder,
            language: useSettingsStore.getState().language
          }),
          tools: ['*'],
          disallowedTools: ['Task', 'AskUserQuestion'],
          maxTurns: DEFAULT_SUB_AGENT_MAX_TURNS,
          ...(typeof input.model === 'string' && input.model ? { model: input.model } : {}),
          inputSchema: { type: 'object', properties: {} }
        }
      } else {
        def = subAgentRegistry.get(subType)
        if (!def) {
          return encodeToolError(
            `Unknown subagent_type "${subType}". Available: ${subTypeEnum.join(', ')}`
          )
        }
      }

      // Guard against back-to-back identical Task calls: if the parent just
      // invoked this exact sub-agent with the same prompt, short-circuit and
      // replay the previous report with an instruction to move on. This
      // prevents runaway loops where a parent model keeps re-dispatching the
      // same sub-agent after each successful return.
      const dedupKey = buildTaskDedupKey(input)
      const sessionId = ctx.sessionId ?? ''
      const lastInvocation = sessionId ? lastTaskInvocationBySession.get(sessionId) : undefined
      if (
        sessionId &&
        lastInvocation &&
        lastInvocation.key === dedupKey &&
        lastInvocation.toolUseId !== (ctx.currentToolUseId ?? '')
      ) {
        return encodeStructuredToolResult({
          error:
            `Duplicate Task call blocked: the previous Task invocation to "${subType}" used an identical prompt ` +
            'and already returned a report. Do NOT re-launch the same sub-agent with the same prompt. ' +
            'Use the previous report below to continue your work, or call Task with a different sub-agent ' +
            'or a materially different prompt if you need new information.',
          previous_report: lastInvocation.output
        })
      }

      await subAgentLimiter.acquire(ctx.signal)

      try {
        const onEvent = (event: SubAgentEvent): void => {
          subAgentEvents.emit(event)
        }

        const result = await runSubAgent({
          definition: def,
          parentProvider: providerGetter(),
          toolContext: ctx,
          input,
          toolUseId: ctx.currentToolUseId ?? '',
          onEvent,
          onApprovalNeeded: async (tc: ToolCallState) => {
            // Custom sub-agents are defined by the parent agent and run with all
            // permissions by default — auto-approve every tool call they make.
            if (isCustom) return true
            const autoApprove = useSettingsStore.getState().autoApprove
            if (autoApprove) return true
            const approved = useAgentStore.getState().approvedToolNames
            if (approved.includes(tc.name)) return true
            useAgentStore.getState().addToolCall(tc)
            const result = await useAgentStore.getState().requestApproval(tc.id)
            if (result) useAgentStore.getState().addApprovedTool(tc.name)
            return result
          }
        })

        if (!result.success) {
          return encodeStructuredToolResult({
            error: result.error ?? 'SubAgent failed',
            result: result.output || undefined
          })
        }

        // Remember this invocation so a literal back-to-back repeat gets
        // blocked by the guard at the top of execute(). We only track
        // successful runs — failed runs are legitimate retry candidates.
        if (sessionId) {
          lastTaskInvocationBySession.set(sessionId, {
            key: dedupKey,
            output: result.output,
            toolUseId: ctx.currentToolUseId ?? ''
          })
        }

        return result.output
      } finally {
        subAgentLimiter.release()
      }
    },
    requiresApproval: (input) => !!input.run_in_background
  }
}
