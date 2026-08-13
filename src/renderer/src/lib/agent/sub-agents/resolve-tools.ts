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
    // Sub-agents are leaf workers. Native runtime expands ACP/plan-restricted
    // parent lists from `subAgentToolCatalog`; this helper only drops Task.
    tools: allTools.filter((tool) => tool.name !== 'Task'),
    invalidTools: []
  }
}
