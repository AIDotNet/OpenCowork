import type { ToolHandler } from '../../../tools/tool-types'
import { teamEvents } from '../events'
import { useTeamStore } from '../../../../stores/team-store'
import type { TeamTaskStatus } from '../types'

const VALID_STATUSES: TeamTaskStatus[] = ['pending', 'in_progress', 'completed']

export const taskUpdateTool: ToolHandler = {
  definition: {
    name: 'TaskUpdate',
    description:
      'Update a task status or owner in the active team. Use this to claim a task, mark it in progress, or mark it completed.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'ID of the task to update',
        },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed'],
          description: 'New status for the task',
        },
        owner: {
          type: 'string',
          description: 'Name of the teammate claiming this task',
        },
      },
      required: ['task_id'],
    },
  },
  execute: async (input) => {
    const taskId = String(input.task_id)
    const team = useTeamStore.getState().activeTeam
    if (!team) {
      return JSON.stringify({ error: 'No active team' })
    }

    const task = team.tasks.find((t) => t.id === taskId)
    if (!task) {
      return JSON.stringify({ error: `Task "${taskId}" not found` })
    }

    const patch: Record<string, unknown> = {}
    if (input.status && VALID_STATUSES.includes(input.status as TeamTaskStatus)) {
      patch.status = input.status
    }
    if (input.owner !== undefined) {
      patch.owner = String(input.owner)
    }

    teamEvents.emit({ type: 'team_task_update', taskId, patch })

    return JSON.stringify({
      success: true,
      task_id: taskId,
      updated: patch,
    })
  },
  requiresApproval: () => false,
}
