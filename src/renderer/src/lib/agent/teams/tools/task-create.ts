import { nanoid } from 'nanoid'
import type { ToolHandler } from '../../../tools/tool-types'
import { teamEvents } from '../events'
import type { TeamTask } from '../types'

export const taskCreateTool: ToolHandler = {
  definition: {
    name: 'TaskCreate',
    description:
      'Create a task for the active team. Tasks can be assigned to teammates and tracked on the task board.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description: 'Short title for the task',
        },
        description: {
          type: 'string',
          description: 'Detailed description of what needs to be done',
        },
        depends_on: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of task IDs this task depends on',
        },
      },
      required: ['subject', 'description'],
    },
  },
  execute: async (input) => {
    const task: TeamTask = {
      id: nanoid(8),
      subject: String(input.subject),
      description: String(input.description),
      status: 'pending',
      owner: null,
      dependsOn: Array.isArray(input.depends_on) ? input.depends_on.map(String) : [],
    }

    teamEvents.emit({ type: 'team_task_add', task })

    return JSON.stringify({
      success: true,
      task_id: task.id,
      subject: task.subject,
    })
  },
  requiresApproval: () => false,
}
