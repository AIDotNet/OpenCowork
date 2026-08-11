export interface SlashCommand {
  name: string
  description: string
  completion?: string
  local?: boolean
}

// Only commands with a complete CLI host implementation belong in this registry. Planned
// session-host commands live in ARCHITECTURE.md until their Worker contracts exist, preventing
// the command menu from advertising actions that would fall through to a warning or hidden prompt.
export const slashCommands: SlashCommand[] = [
  { name: '/agents', description: 'Inspect configured Native Worker agents', local: true },
  { name: '/clear', description: 'Clear canonical context in this session', local: true },
  { name: '/codegraph', description: 'Show CodeGraph availability and index status', local: true },
  {
    name: '/compact',
    description: 'Compact canonical context in the Native Worker',
    completion: '/compact ',
    local: true
  },
  { name: '/config', description: 'Open shared OpenCowork configuration', local: true },
  {
    name: '/context',
    description: 'Show canonical context usage and compact trigger',
    local: true
  },
  { name: '/cost', description: 'Show token usage and estimated model cost', local: true },
  { name: '/doctor', description: 'Diagnose Native Worker and configuration', local: true },
  {
    name: '/effort',
    description: 'Choose reasoning effort supported by the active model',
    local: true
  },
  { name: '/exit', description: 'Exit OpenCowork', local: true },
  { name: '/help', description: 'Show interactive shortcuts', local: true },
  { name: '/model', description: 'Switch the active model', local: true },
  { name: '/new', description: 'Start a new Native Worker session', local: true },
  {
    name: '/permissions',
    description: 'View or set the session permission mode',
    completion: '/permissions ',
    local: true
  },
  { name: '/plan', description: 'Enter, leave, or toggle plan mode', local: true },
  { name: '/provider', description: 'Quickly configure an AI provider', local: true },
  {
    name: '/rewind',
    description: 'Restore a previous conversation turn and optional tracked changes',
    local: true
  },
  { name: '/resume', description: 'Resume a completed CLI session', local: true },
  { name: '/status', description: 'Show session, model, and runtime status', local: true },
  { name: '/tasks', description: 'Toggle the current session task list', local: true },
  {
    name: '/tui',
    description: 'Show renderer status or restart syntax',
    completion: '/tui ',
    local: true
  }
]

export function findCommands(input: string): SlashCommand[] {
  const query = input.slice(1).trim().toLowerCase()

  if (!query) return slashCommands

  return slashCommands
    .map((command) => {
      const name = command.name.slice(1).toLowerCase()
      const prefix = name.startsWith(query) ? 0 : 1
      const index = name.indexOf(query)
      return { command, score: index === -1 ? Number.POSITIVE_INFINITY : prefix * 100 + index }
    })
    .filter(({ score }) => Number.isFinite(score))
    .sort((a, b) => a.score - b.score || a.command.name.localeCompare(b.command.name))
    .map(({ command }) => command)
}
