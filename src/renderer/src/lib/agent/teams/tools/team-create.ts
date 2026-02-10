import type { ToolHandler } from '../../../tools/tool-types'
import { teamEvents } from '../events'

export const teamCreateTool: ToolHandler = {
  definition: {
    name: 'TeamCreate',
    description:
      'Create a new agent team for parallel collaboration. Use this when a task benefits from multiple agents working simultaneously on different aspects.',
    inputSchema: {
      type: 'object',
      properties: {
        team_name: {
          type: 'string',
          description: 'Short, descriptive name for the team (e.g. "pr-review", "bug-fix-squad")',
        },
        description: {
          type: 'string',
          description: 'What this team is working on',
        },
      },
      required: ['team_name', 'description'],
    },
  },
  execute: async (input) => {
    const teamName = String(input.team_name)
    const description = String(input.description)

    teamEvents.emit({ type: 'team_start', teamName, description })

    return JSON.stringify({
      success: true,
      team_name: teamName,
      message: `Team "${teamName}" created. Now create tasks with TaskCreate and spawn teammates with SpawnTeammate.`,
    })
  },
  requiresApproval: () => false,
}
