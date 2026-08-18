export const ACP_MODE_ALLOWED_TOOLS = new Set([
  'Read',
  'LS',
  'Glob',
  'Grep',
  'Skill',
  'MemoryList',
  'MemoryRead',
  'MemorySearch',
  'codegraph_explore',
  'WebSearch',
  'WebFetch',
  'EnterPlanMode',
  'ExitPlanMode',
  'AskUserQuestion',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  'Task',
  'Agent',
  'TeamCreate',
  'SendMessage',
  'TeamStatus',
  'TeamDelete',
  'CronList',
  'Notify',
  'get_goal',
  'create_goal',
  'update_goal',
  'visualize_show_widget'
])

export function isAcpLeadToolName(name: string): boolean {
  return ACP_MODE_ALLOWED_TOOLS.has(name)
}

export function splitToolsForSubAgentCatalog<T extends { name: string }>(args: {
  mode?: string | null
  availableTools: readonly T[]
}): { parentTools: T[]; subAgentToolCatalog: T[] } {
  const available = [...args.availableTools]
  if (args.mode === 'acp') {
    return {
      parentTools: available.filter((tool) => isAcpLeadToolName(tool.name)),
      subAgentToolCatalog: available
    }
  }
  return {
    parentTools: available,
    subAgentToolCatalog: available
  }
}
