import type { ProviderConfig, TokenUsage } from '../../api/types'
import { encodeStructuredToolResult } from '../../tools/tool-result-format'
import type { ToolHandler } from '../../tools/tool-types'
import { subAgentRegistry } from './registry'
import type { SubAgentDefinition } from './types'

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

function buildTaskDescription(agents: SubAgentDefinition[]): string {
  const agentLines = agents
    .map((a) => `- ${a.name}: ${a.description} (Tools: same as parent agent)`)
    .join('\n')

  return `Launch a new agent to handle complex, multi-step tasks autonomously.

The Task tool launches specialized agents (sub-agents) that autonomously handle complex tasks. Each agent type has its own focused system prompt and inherits the complete tool set exposed to the parent agent for the current run.

Available agent types and the tools they have access to:
${agentLines}
- custom: General-purpose sub-agent with a built-in default system prompt and the same tools as the parent agent. Use this when none of the specialized agents above are a clean fit. You only supply the task via "prompt" - tool access is inherited automatically. (Tools: same as parent agent)

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
- Sub-agents inherit the parent's current tools, including Task when it is available, so they may delegate further when useful.
- Clearly tell the sub-agent whether you expect it to write code or just do research (search, file reads, web fetches), since it does not see the user's intent.
- The sub-agent's outputs should generally be trusted.
- If a sub-agent's description says it should be used proactively for its domain, prefer launching it without waiting for the user to ask.
- If the user explicitly asks for work to run "in parallel", you MUST send a single message with multiple Task tool_use blocks.
- Set "run_in_background": true to run the sub-agent independently in the background. Your current turn ends after spawning and resumes automatically when the sub-agent finishes. If a team is active (or "team_name" is provided), the sub-agent is also registered as a teammate; otherwise it runs as a standalone background sub-agent.

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
                  'The type of specialized agent to use for this task. Every sub-agent inherits the tools exposed to the parent agent for the current run. Use "custom" for a general-purpose sub-agent with a built-in default system prompt.'
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
                  'Set to true to run this agent independently in the background. The current main-agent turn ends after spawning and resumes automatically when this sub-agent finishes.'
              },
              name: {
                type: 'string',
                description:
                  'Optional display name for a standalone background sub-agent. Required and unique when spawning into a team.'
              },
              team_name: {
                type: 'string',
                description:
                  'Optional team name. When provided (or when a team is active), the background sub-agent is registered as a teammate.'
              },
              subagent_type: {
                type: 'string',
                enum: subTypeEnum,
                description:
                  'Optional specialized background agent type to use for this teammate. Every teammate inherits the tools exposed to the parent agent for the current run.'
              },
              model: {
                type: 'string',
                description:
                  'Optional model override for this agent. If not specified, the teammate runs on the configured fast model. Set a stronger model here only for hard tasks that need it.'
              },
              task_id: {
                type: 'string',
                description: 'Optional task ID to assign to the teammate immediately.'
              },
              backend_type: {
                type: 'string',
                enum: ['in-process'],
                description:
                  'Optional backend override. Background sub-agents execute in the .NET Native Worker.'
              }
            },
            required: ['description', 'prompt', 'run_in_background'],
            additionalProperties: false
          }
        ]
      }
    },
    execute: async () => nativeOnlyTaskResult(),
    requiresApproval: () => false
  }
}
