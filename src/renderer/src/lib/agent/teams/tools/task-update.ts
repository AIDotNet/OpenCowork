import type { ToolHandler } from '../../../tools/tool-types'
import { encodeStructuredToolResult, encodeToolError } from '../../../tools/tool-result-format'
import { teamEvents } from '../events'
import { updateTeamRuntimeManifest } from '../runtime-client'
import { useTeamStore } from '../../../../stores/team-store'
import type { TeamTaskStatus } from '../types'

const VALID_STATUSES: TeamTaskStatus[] = ['pending', 'in_progress', 'completed']

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

function resolveTaskTitle(input: Record<string, unknown>, fallbackTitle = ''): string {
  const title = normalizeTaskTitlePart(input.title ?? input.subject)
  const description = normalizeTaskTitlePart(input.description)

  if (title) return mergeTaskTitle(title, description)
  if (description) return description
  return normalizeTaskTitlePart(fallbackTitle)
}

function hasTaskTitlePatch(input: Record<string, unknown>): boolean {
  return input.title !== undefined || input.subject !== undefined || input.description !== undefined
}

export const taskUpdateTool: ToolHandler = {
  definition: {
    name: 'TaskUpdate',
    description:
      'Update a task title, status, or owner in the active team. Use this to claim a task, refine its wording, mark it in progress, or mark it completed.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'ID of the task to update'
        },
        title: {
          type: 'string',
          description:
            'New detailed title for the task. Include enough detail that no description is needed.'
        },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed'],
          description: 'New status for the task'
        },
        owner: {
          type: 'string',
          description: 'Name of the teammate claiming this task'
        },
        report: {
          type: 'string',
          description:
            'Final report to attach when completing a task. Include all findings, data collected, and results. This report is sent to the lead agent automatically.'
        }
      },
      required: ['task_id']
    }
  },
  execute: async (input) => {
    const taskId = String(input.task_id)
    const team = useTeamStore.getState().activeTeam
    if (!team) {
      return encodeToolError('No active team')
    }

    const task = team.tasks.find((t) => t.id === taskId)
    if (!task) {
      return encodeToolError(`Task "${taskId}" not found`)
    }

    const patch: Record<string, unknown> = {}
    if (input.status && VALID_STATUSES.includes(input.status as TeamTaskStatus)) {
      if (task.status === 'completed' && input.status !== 'completed') {
        return encodeStructuredToolResult({
          error: `Task "${taskId}" is already completed and cannot be reverted to "${input.status}".`
        })
      }
      patch.status = input.status
    }
    if (hasTaskTitlePatch(input)) {
      const nextTitle = resolveTaskTitle(input, task.subject)
      if (nextTitle && nextTitle !== task.subject) {
        patch.subject = nextTitle
      }
    }
    if (input.owner !== undefined) {
      patch.owner = String(input.owner)
    }
    if (input.report !== undefined && patch.status === 'completed') {
      patch.report = String(input.report)
    }

    await updateTeamRuntimeManifest({
      teamName: team.name,
      patch: {
        tasks: team.tasks.map((item) => (item.id === taskId ? { ...item, ...patch } : item))
      }
    })

    teamEvents.emit({ type: 'team_task_update', sessionId: team.sessionId, taskId, patch })

    return encodeStructuredToolResult({
      success: true,
      task_id: taskId,
      updated: patch
    })
  },
  requiresApproval: () => false
}
