import type { ToolDefinition } from '../../api/types'
import type { SubAgentDefinition } from './types'

export interface ResolvedSubAgentTools {
  tools: ToolDefinition[]
  invalidTools: string[]
}

export function resolveSubAgentTools(
  _definition: Pick<SubAgentDefinition, 'tools' | 'disallowedTools'>,
  allTools: ToolDefinition[]
): ResolvedSubAgentTools {
  return {
    // Sub-agents are leaf workers. Keep the parent's other tools, but never expose
    // the delegation tool that could recursively create another sub-agent.
    tools: allTools.filter((tool) => tool.name !== 'Task'),
    invalidTools: []
  }
}
