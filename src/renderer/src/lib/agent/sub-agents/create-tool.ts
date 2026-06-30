import type { ProviderConfig, TokenUsage } from '../../api/types'
import { encodeStructuredToolResult } from '../../tools/tool-result-format'
import type { ToolHandler } from '../../tools/tool-types'
import { subAgentRegistry } from './registry'
import type { SubAgentDefinition } from './types'
import { getEffectiveSubAgentDisallowedTools } from './resolve-tools'

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
export const CUSTOM_SUBAGENT_TYPE = 'custom'

export function clearLastTaskInvocation(_sessionId: string | undefined | null): void {
  // Native AgentRuntime owns Task de-duplication state.
}

export function removeTeamLimiter(_teamName: string): void {
  // Native AgentRuntime owns teammate scheduling state.
}

function nativeOnlyTaskResult(): string {
  return encodeStructuredToolResult({
    error: 'Task execution has migrated to the .NET Native Worker.'
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
- custom: General-purpose sub-agent with a built-in default system prompt and broad tool access except Task and AskUserQuestion. Use this when none of the specialized agents above are a clean fit. You only supply the task via "prompt" - do NOT try to pass a system prompt, tools list, or permissions; those are fixed by the runtime. (Tools: All tools except Task, AskUserQuestion)

When using the Task tool, you MUST specify a "subagent_type" parameter to select which agent type to use.

When NOT to use the Task tool:
- If you want to read a specific file path, use the Read or Glob tool instead, to find the match more quickly.
- If you are searching for a specific class definition like "class Foo", use the Glob tool instead.
- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead.
- For tasks that are not related to any of the agent descriptions above and cannot be expressed as a focused prompt, do the work yourself.

Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do.
- Launch multiple agents concurrently whenever possible, to maximize performance. To do that, send a single assistant message containing multiple Task tool_use blocks.
- When the sub-agent is done, it will return a single message back to you. The result is not visible to the user - you must send a concise text summary back to the user after the agent returns.
- Each sub-agent invocation is stateless: it does not see the current conversation history, so write self-contained prompts that include all context the sub-agent needs.
- Clearly tell the sub-agent whether you expect it to write code or just do research (search, file reads, web fetches), since it does not see the user's intent.
- The sub-agent's outputs should generally be trusted.
- If a sub-agent's description says it should be used proactively for its domain, prefer launching it without waiting for the user to ask.
- If the user explicitly asks for work to run "in parallel", you MUST send a single message with multiple Task tool_use blocks.
- Set "run_in_background": true to spawn a teammate that runs independently. Your turn ends after spawning - you will be notified automatically when the teammate finishes. Background mode requires an active team (TeamCreate).

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
user: "investigate why the main agent runtime hangs on startup"
<commentary>
Open-ended investigation across many files - exactly what Task is for.
</commentary>
assistant: (launches a Task with subagent_type="custom", description="investigate runtime startup hang", prompt="Investigate why the main-process agent runtime hangs on startup. Trace the initialization path, identify the blocking await, and report the root cause with file:line evidence.")
</example>`
}

export function createTaskTool(_providerGetter: () => ProviderConfig): ToolHandler {
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
                  'The type of specialized agent to use for this task. Use "custom" for a general-purpose sub-agent with broad tool access except Task and AskUserQuestion and a built-in default system prompt - you only supply the task via "prompt".'
              },
              model: {
                type: 'string',
                description:
                  'Deprecated and ignored. Synchronous sub-agents always use the configured fast model.'
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
                  'The task for the teammate to perform. Write a self-contained brief - the teammate does not see the current conversation history.'
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
                enum: ['in-process'],
                description:
                  'Optional backend override for the teammate runtime. Background teammates execute in the .NET Native Worker.'
              }
            },
            required: ['description', 'prompt', 'run_in_background', 'name'],
            additionalProperties: false
          }
        ]
      }
    },
    execute: async () => nativeOnlyTaskResult(),
    requiresApproval: () => false
  }
}
