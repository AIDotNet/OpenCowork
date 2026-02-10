import { nanoid } from 'nanoid'
import type { ToolHandler } from '../../../tools/tool-types'
import { teamEvents } from '../events'
import { useTeamStore } from '../../../../stores/team-store'
import { runTeammate } from '../teammate-runner'
import type { TeamMember } from '../types'

export const spawnTeammateTool: ToolHandler = {
  definition: {
    name: 'SpawnTeammate',
    description:
      'Spawn a new teammate agent that runs its own independent agent loop. The teammate will work on assigned tasks in parallel.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Short name for this teammate (e.g. "qa-pages", "frontend-dev")',
        },
        prompt: {
          type: 'string',
          description: 'Focused instructions for this teammate describing what it should do',
        },
        task_id: {
          type: 'string',
          description: 'Optional task ID to assign to this teammate immediately',
        },
        model: {
          type: 'string',
          description: 'Optional model override (defaults to the current model)',
        },
      },
      required: ['name', 'prompt'],
    },
  },
  execute: async (input, ctx) => {
    const team = useTeamStore.getState().activeTeam
    if (!team) {
      return JSON.stringify({ error: 'No active team. Call TeamCreate first.' })
    }

    const memberName = String(input.name)
    const existing = team.members.find((m) => m.name === memberName)
    if (existing) {
      return JSON.stringify({ error: `Teammate "${memberName}" already exists in the team.` })
    }

    const member: TeamMember = {
      id: nanoid(),
      name: memberName,
      model: String(input.model ?? 'default'),
      status: 'idle',
      currentTaskId: input.task_id ? String(input.task_id) : null,
      iteration: 0,
      toolCalls: [],
      streamingText: '',
      startedAt: Date.now(),
      completedAt: null,
    }

    teamEvents.emit({ type: 'team_member_add', member })

    // If a task was assigned, mark it in_progress
    if (input.task_id) {
      teamEvents.emit({
        type: 'team_task_update',
        taskId: String(input.task_id),
        patch: { status: 'in_progress', owner: memberName },
      })
    }

    // Fire-and-forget: start the independent agent loop for this teammate.
    // The loop runs in the background and updates team-store via teamEvents.
    runTeammate({
      memberId: member.id,
      memberName,
      prompt: String(input.prompt),
      taskId: input.task_id ? String(input.task_id) : null,
      model: input.model ? String(input.model) : null,
      workingFolder: ctx.workingFolder,
    }).catch((err) => {
      console.error(`[SpawnTeammate] Failed to start teammate "${memberName}":`, err)
    })

    return JSON.stringify({
      success: true,
      member_id: member.id,
      name: memberName,
      task_id: input.task_id ?? null,
      message: `Teammate "${memberName}" spawned. It will begin working on its assigned task.`,
    })
  },
  requiresApproval: () => true,
}
