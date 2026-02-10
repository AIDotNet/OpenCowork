import { nanoid } from 'nanoid'
import { runAgentLoop } from '../agent-loop'
import { toolRegistry } from '../tool-registry'
import type { AgentLoopConfig } from '../types'
import type { UnifiedMessage, ProviderConfig, TokenUsage } from '../../api/types'
import type { SubAgentRunConfig, SubAgentResult } from './types'
import { ipcClient } from '../../ipc/ipc-client'

/**
 * Run a SubAgent — executes an inner agent loop with a focused system prompt
 * and restricted tool set, then returns a consolidated result.
 *
 * SubAgents auto-approve read-only tools. Write tools bubble approval up
 * to the parent via onApprovalNeeded callback.
 */
export async function runSubAgent(config: SubAgentRunConfig): Promise<SubAgentResult> {
  const { definition, parentProvider, toolContext, input, toolUseId, onEvent, onApprovalNeeded } = config

  // Emit start event
  onEvent?.({ type: 'sub_agent_start', subAgentName: definition.name, toolUseId, input })

  // 1. Build inner tool definitions (subset of parent's tools + always include Skill)
  const allDefs = toolRegistry.getDefinitions()
  const allowedSet = new Set(definition.allowedTools)
  allowedSet.add('Skill') // All SubAgents get Skill access by default
  const innerTools = allDefs.filter((t) => allowedSet.has(t.name))

  // 2. Build provider config (optionally override model/temperature)
  const innerProvider: ProviderConfig = {
    ...parentProvider,
    systemPrompt: definition.systemPrompt,
    model: definition.model ?? parentProvider.model,
    temperature: definition.temperature ?? parentProvider.temperature,
  }

  // 3. Build initial user message from SubAgent input
  const userMessage = formatInputAsMessage(definition.name, input)

  // 4. Fetch available skills and append to system prompt
  let systemPrompt = definition.systemPrompt
  try {
    const skills = await ipcClient.invoke('skills:list') as { name: string; description: string }[]
    if (Array.isArray(skills) && skills.length > 0) {
      const skillLines = skills.map((s) => `- **${s.name}**: ${s.description}`).join('\n')
      systemPrompt += `\n\n<skills_priority_rule>\n**CRITICAL — READ THIS FIRST:**\nYou have access to the **Skill** tool. Before using ANY of your core tools, check the list below. If the user's task matches a Skill's description (e.g. web searching, web scraping, PDF analysis), you **MUST** call the Skill tool FIRST to load its expert instructions, then follow those instructions strictly.\n\nDo NOT attempt to solve tasks covered by a Skill using only your core tools. Skills contain curated scripts and workflows that produce far better results.\n\n**Retry on failure**: If a Skill's script fails (e.g. missing dependency, import error), fix the issue (install the dependency) and then **re-run the exact same script command**. NEVER replace a Skill's script with your own inline code (\`python -c "..."\`) or ad-hoc scripts.\n\nAvailable skills:\n${skillLines}\n</skills_priority_rule>`
    }
  } catch {
    // Skills unavailable — proceed without them
  }

  // 5. Build inner loop config
  const loopConfig: AgentLoopConfig = {
    maxIterations: definition.maxIterations,
    provider: innerProvider,
    tools: innerTools,
    systemPrompt,
    workingFolder: toolContext.workingFolder,
    signal: toolContext.signal,
  }

  // 6. Run inner agent loop
  let output = ''
  let toolCallCount = 0
  let iterations = 0
  const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }

  try {
    const loop = runAgentLoop(
      [userMessage],
      loopConfig,
      toolContext,
      async (tc) => {
        // Auto-approve read-only tools
        if (isReadOnly(tc.name)) return true
        // Bubble write tool approval up to parent
        if (onApprovalNeeded) return onApprovalNeeded(tc)
        return false
      }
    )

    for await (const event of loop) {
      if (toolContext.signal.aborted) break

      switch (event.type) {
        case 'text_delta':
          output += event.text
          onEvent?.({ type: 'sub_agent_text_delta', subAgentName: definition.name, toolUseId, text: event.text })
          break

        case 'iteration_start':
          iterations = event.iteration
          onEvent?.({ type: 'sub_agent_iteration', subAgentName: definition.name, toolUseId, iteration: event.iteration })
          break

        case 'message_end':
          if (event.usage) {
            totalUsage.inputTokens += event.usage.inputTokens
            totalUsage.outputTokens += event.usage.outputTokens
            if (event.usage.cacheCreationTokens) {
              totalUsage.cacheCreationTokens = (totalUsage.cacheCreationTokens ?? 0) + event.usage.cacheCreationTokens
            }
            if (event.usage.cacheReadTokens) {
              totalUsage.cacheReadTokens = (totalUsage.cacheReadTokens ?? 0) + event.usage.cacheReadTokens
            }
            if (event.usage.reasoningTokens) {
              totalUsage.reasoningTokens = (totalUsage.reasoningTokens ?? 0) + event.usage.reasoningTokens
            }
          }
          break

        case 'tool_call_start':
        case 'tool_call_result':
          if (event.type === 'tool_call_result') toolCallCount++
          onEvent?.({ type: 'sub_agent_tool_call', subAgentName: definition.name, toolUseId, toolCall: event.toolCall })
          break

        case 'error':
          const result: SubAgentResult = {
            success: false,
            output: '',
            toolCallCount,
            iterations,
            usage: totalUsage,
            error: event.error.message,
          }
          onEvent?.({ type: 'sub_agent_end', subAgentName: definition.name, toolUseId, result })
          return result
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const result: SubAgentResult = {
      success: false,
      output: '',
      toolCallCount,
      iterations,
      usage: totalUsage,
      error: errMsg,
    }
    onEvent?.({ type: 'sub_agent_end', subAgentName: definition.name, toolUseId, result })
    return result
  }

  // 7. Format output
  const finalOutput = definition.formatOutput
    ? definition.formatOutput({ success: true, output, toolCallCount, iterations, usage: totalUsage })
    : output

  const result: SubAgentResult = {
    success: true,
    output: finalOutput,
    toolCallCount,
    iterations,
    usage: totalUsage,
  }

  onEvent?.({ type: 'sub_agent_end', subAgentName: definition.name, toolUseId, result })
  return result
}

// --- Helpers ---

const READ_ONLY_SET = new Set(['Read', 'LS', 'Glob', 'Grep', 'TodoRead', 'Skill'])

function isReadOnly(toolName: string): boolean {
  return READ_ONLY_SET.has(toolName)
}

function formatInputAsMessage(_subAgentName: string, input: Record<string, unknown>): UnifiedMessage {
  // Build a natural language message from the SubAgent input
  const parts: string[] = []

  if (input.query) {
    parts.push(String(input.query))
  } else if (input.task) {
    parts.push(String(input.task))
  } else if (input.target) {
    parts.push(`Analyze: ${input.target}`)
    if (input.focus) parts.push(`Focus: ${input.focus}`)
  } else {
    // Fallback: stringify the input
    parts.push(JSON.stringify(input, null, 2))
  }

  if (input.scope) {
    parts.push(`\nScope: ${input.scope}`)
  }
  if (input.constraints) {
    parts.push(`\nConstraints: ${input.constraints}`)
  }

  return {
    id: nanoid(),
    role: 'user',
    content: parts.join('\n'),
    createdAt: Date.now(),
  }
}
