export interface SlashCommand {
  name: string
  description: string
  completion?: string
  local?: boolean
}

// This is the stable UI-facing subset. Runtime and plugin commands are merged into this
// registry later, so the command menu does not need to know where a command came from.
export const slashCommands: SlashCommand[] = [
  { name: '/add-dir', description: 'Add a new working directory', completion: '/add-dir ' },
  { name: '/agents', description: 'Inspect configured Native Worker agents', local: true },
  { name: '/background', description: 'Send this session to the background' },
  { name: '/branch', description: 'Create a branch of the current conversation' },
  { name: '/btw', description: 'Ask a side question without interrupting the main task' },
  { name: '/clear', description: 'Start a new session with empty context', local: true },
  { name: '/codegraph', description: 'Show CodeGraph availability and index status', local: true },
  { name: '/compact', description: 'Compact the conversation to free context space' },
  { name: '/config', description: 'Open configuration' },
  { name: '/context', description: 'Visualize current context usage' },
  { name: '/cost', description: 'Show token usage and estimated cost' },
  { name: '/diff', description: 'Review changes made in this session' },
  { name: '/doctor', description: 'Diagnose installation and configuration' },
  { name: '/effort', description: 'Set reasoning effort for this session', local: true },
  { name: '/exit', description: 'Exit OpenCowork', local: true },
  { name: '/help', description: 'Show interactive shortcuts', local: true },
  { name: '/init', description: 'Create a starter AGENTS.md for this project' },
  { name: '/mcp', description: 'Manage MCP servers' },
  { name: '/memory', description: 'Edit project and user memory files' },
  { name: '/model', description: 'Switch the active model', local: true },
  { name: '/new', description: 'Start a new session with empty context', local: true },
  { name: '/permissions', description: 'View or update permission rules', local: true },
  { name: '/plan', description: 'Enter plan mode', local: true },
  { name: '/resume', description: 'Resume a previous conversation' },
  { name: '/rewind', description: 'Restore code or conversation to a checkpoint' },
  { name: '/status', description: 'Show session, model, and runtime status', local: true },
  { name: '/tasks', description: 'Show background tasks and agents', local: true },
  { name: '/theme', description: 'Change the terminal color theme', local: true },
  { name: '/tui', description: 'Show or switch the terminal renderer', local: true }
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
