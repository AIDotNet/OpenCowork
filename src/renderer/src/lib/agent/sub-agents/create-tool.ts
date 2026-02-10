import type { ToolHandler } from '../../tools/tool-types'
import type { SubAgentDefinition, SubAgentEvent } from './types'
import type { ToolCallState } from '../types'
import { runSubAgent } from './runner'
import { subAgentEvents } from './events'
import type { ProviderConfig } from '../../api/types'

/** Metadata embedded in SubAgent output for historical rendering */
export interface SubAgentMeta {
  iterations: number
  elapsed: number
  usage: { inputTokens: number; outputTokens: number }
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

/**
 * Creates a ToolHandler that wraps a SubAgent definition.
 * This allows the main agent to invoke SubAgents as regular tools.
 *
 * The providerGetter is called at execution time to get the current
 * provider config (API key, model, etc.) from the settings store.
 *
 * SubAgent events are emitted to the global subAgentEvents bus
 * so the UI layer can track inner progress.
 */
export function createSubAgentTool(
  def: SubAgentDefinition,
  providerGetter: () => ProviderConfig
): ToolHandler {
  return {
    definition: {
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
    },
    execute: async (input, ctx) => {
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
      })

      // Build metadata for historical rendering (truncate large outputs to prevent bloat)
      const MAX_OUTPUT = 4000
      const MAX_INPUT_VALUE = 2000
      const truncStr = (s: string | undefined, max: number): string | undefined => {
        if (!s || s.length <= max) return s
        return s.slice(0, max) + `\n... [truncated, ${s.length} chars total]`
      }
      const truncInput = (inp: Record<string, unknown>): Record<string, unknown> => {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(inp)) {
          out[k] = typeof v === 'string' && v.length > MAX_INPUT_VALUE
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
          output: truncStr(tc.output, MAX_OUTPUT),
          error: tc.error,
          startedAt: tc.startedAt,
          completedAt: tc.completedAt,
        })),
      }
      const metaStr = `${META_PREFIX}${JSON.stringify(meta)}${META_SUFFIX}`

      if (!result.success) {
        return metaStr + JSON.stringify({
          error: result.error ?? 'SubAgent failed',
          toolCalls: result.toolCallCount,
          iterations: result.iterations,
        })
      }

      return metaStr + result.output
    },
    requiresApproval: () => false,
  }
}
