import { nanoid } from 'nanoid'
import type { ToolHandler } from '../../../tools/tool-types'
import { encodeStructuredToolResult } from '../../../tools/tool-result-format'
import { teamEvents } from '../events'
import { updateTeamRuntimeManifest } from '../runtime-client'
import { useTeamStore } from '../../../../stores/team-store'
import type { TeamTask } from '../types'

function normalizeTaskTitlePart(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function mergeTaskTitle(title: string, description: string): string {
  if (!title) return description
  if (!description) return title
  if (title === description) return title
  if (title.includes(description)) return title
  if (description.includes(title)) return description
  return /[：:;；,.，。!?！？]$/.test(title)
    ? `${title} ${description}`
    : `${title}：${description}`
}

function resolveTaskTitle(input: Record<string, unknown>): string {
  const title = normalizeTaskTitlePart(input.title ?? input.subject)
  const description = normalizeTaskTitlePart(input.description)

  if (title) return mergeTaskTitle(title, description)
  return description
}

export const taskCreateTool: ToolHandler = {
  definition: {
    name: 'TaskCreate',
    description:
      'Create a task for the active team. Tasks can be assigned to teammates and tracked on the task board.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description:
            'A detailed task title with enough context that no separate description is needed'
        },
        depends_on: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of task IDs this task depends on'
        }
      },
      required: ['title']
    }
  },
  execute: async (input) => {
    const team = useTeamStore.getState().activeTeam
    if (!team) {
      return encodeStructuredToolResult({ success: false, error: 'No active team' })
    }

    const subject = resolveTaskTitle(input)
    if (!subject) {
      return encodeStructuredToolResult({
        success: false,
        error: 'TaskCreate requires a non-empty title.'
      })
    }
    const existing = team.tasks.find((t) => t.subject === subject)
    if (existing) {
      return encodeStructuredToolResult({
        success: true,
        task_id: existing.id,
        title: existing.subject,
        subject: existing.subject,
        note: 'Task with this title already exists, returning existing task.'
      })
    }

    const task: TeamTask = {
      id: nanoid(8),
      subject,
      description: '',
      status: 'pending',
      owner: null,
      dependsOn: Array.isArray(input.depends_on) ? input.depends_on.map(String) : []
    }

    await updateTeamRuntimeManifest({
      teamName: team.name,
      patch: {
        tasks: [...team.tasks, task]
      }
    })

    teamEvents.emit({ type: 'team_task_add', sessionId: team.sessionId, task })

    return encodeStructuredToolResult({
      success: true,
      task_id: task.id,
      title: task.subject,
      subject: task.subject
    })
  },
  requiresApproval: () => false
}
