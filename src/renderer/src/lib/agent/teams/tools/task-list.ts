import type { ToolHandler } from '../../../tools/tool-types'
import { encodeStructuredToolResult, encodeToolError } from '../../../tools/tool-result-format'
import { useTeamStore } from '../../../../stores/team-store'

export const taskListTool: ToolHandler = {
  definition: {
    name: 'TaskList',
    description:
      'List all tasks in the active team with their current status, owner, and dependencies.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'all'],
          description: 'Filter tasks by status. Defaults to "all".'
        }
      },
      required: []
    }
  },
  execute: async (input) => {
    const team = useTeamStore.getState().activeTeam
    if (!team) {
      return encodeToolError('No active team')
    }

    const filter = String(input.status ?? 'all')
    const tasks = filter === 'all' ? team.tasks : team.tasks.filter((t) => t.status === filter)

    return encodeStructuredToolResult({
      team_name: team.name,
      total: team.tasks.length,
      filtered: tasks.length,
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.subject,
        subject: t.subject,
        status: t.status,
        owner: t.owner,
        depends_on: t.dependsOn
      }))
    })
  },
  requiresApproval: () => false
}
