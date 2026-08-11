import { t } from './i18n.js'

export interface SlashCommand {
  name: string
  description: string
  completion?: string
  local?: boolean
}

interface SlashCommandDefinition extends Omit<SlashCommand, 'description'> {
  descriptionKey: string
  defaultDescription: string
}

// Only commands with a complete CLI host implementation belong in this registry. Planned
// session-host commands live in ARCHITECTURE.md until their Worker contracts exist, preventing
// the command menu from advertising actions that would fall through to a warning or hidden prompt.
const slashCommandDefinitions: SlashCommandDefinition[] = [
  {
    name: '/agents',
    descriptionKey: 'cli.commandsMenu.agents',
    defaultDescription: 'Inspect configured Native Worker agents',
    local: true
  },
  {
    name: '/clear',
    descriptionKey: 'cli.commandsMenu.clear',
    defaultDescription: 'Clear canonical context in this session',
    local: true
  },
  {
    name: '/codegraph',
    descriptionKey: 'cli.commandsMenu.codegraph',
    defaultDescription: 'Show CodeGraph availability and index status',
    local: true
  },
  {
    name: '/compact',
    descriptionKey: 'cli.commandsMenu.compact',
    defaultDescription: 'Compact canonical context in the Native Worker',
    completion: '/compact ',
    local: true
  },
  {
    name: '/config',
    descriptionKey: 'cli.commandsMenu.config',
    defaultDescription: 'Open shared OpenCowork configuration',
    local: true
  },
  {
    name: '/context',
    descriptionKey: 'cli.commandsMenu.context',
    defaultDescription: 'Show canonical context usage and compact trigger',
    local: true
  },
  {
    name: '/cost',
    descriptionKey: 'cli.commandsMenu.cost',
    defaultDescription: 'Show token usage and estimated model cost',
    local: true
  },
  {
    name: '/doctor',
    descriptionKey: 'cli.commandsMenu.doctor',
    defaultDescription: 'Diagnose Native Worker and configuration',
    local: true
  },
  {
    name: '/effort',
    descriptionKey: 'cli.commandsMenu.effort',
    defaultDescription: 'Choose reasoning effort supported by the active model',
    local: true
  },
  {
    name: '/exit',
    descriptionKey: 'cli.commandsMenu.exit',
    defaultDescription: 'Exit OpenCowork',
    local: true
  },
  {
    name: '/help',
    descriptionKey: 'cli.commandsMenu.help',
    defaultDescription: 'Show interactive shortcuts',
    local: true
  },
  {
    name: '/model',
    descriptionKey: 'cli.commandsMenu.model',
    defaultDescription: 'Switch the active model',
    local: true
  },
  {
    name: '/new',
    descriptionKey: 'cli.commandsMenu.new',
    defaultDescription: 'Start a new Native Worker session',
    local: true
  },
  {
    name: '/permissions',
    descriptionKey: 'cli.commandsMenu.permissions',
    defaultDescription: 'View or set the session permission mode',
    completion: '/permissions ',
    local: true
  },
  {
    name: '/plan',
    descriptionKey: 'cli.commandsMenu.plan',
    defaultDescription: 'Enter, leave, or toggle plan mode',
    local: true
  },
  {
    name: '/provider',
    descriptionKey: 'cli.commandsMenu.provider',
    defaultDescription: 'Quickly configure an AI provider',
    local: true
  },
  {
    name: '/rewind',
    descriptionKey: 'cli.commandsMenu.rewind',
    defaultDescription: 'Restore a previous conversation turn and optional tracked changes',
    local: true
  },
  {
    name: '/resume',
    descriptionKey: 'cli.commandsMenu.resume',
    defaultDescription: 'Resume a completed CLI session',
    local: true
  },
  {
    name: '/status',
    descriptionKey: 'cli.commandsMenu.status',
    defaultDescription: 'Show session, model, and runtime status',
    local: true
  },
  {
    name: '/tasks',
    descriptionKey: 'cli.commandsMenu.tasks',
    defaultDescription: 'Toggle the current session task list',
    local: true
  },
  {
    name: '/tui',
    descriptionKey: 'cli.commandsMenu.tui',
    defaultDescription: 'Show renderer status or restart syntax',
    completion: '/tui ',
    local: true
  }
]

/** English-compatible export retained for integrations that inspect the command registry. */
export const slashCommands: SlashCommand[] = slashCommandDefinitions.map((command) => ({
  name: command.name,
  description: command.defaultDescription,
  completion: command.completion,
  local: command.local
}))

function localizedSlashCommands(): SlashCommand[] {
  return slashCommandDefinitions.map(({ descriptionKey, defaultDescription, ...command }) => ({
    ...command,
    description: t(descriptionKey, defaultDescription)
  }))
}

export function findCommands(input: string): SlashCommand[] {
  const commands = localizedSlashCommands()
  const query = input.slice(1).trim().toLowerCase()

  if (!query) return commands

  return commands
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
