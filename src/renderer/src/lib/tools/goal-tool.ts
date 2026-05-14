import { toolRegistry } from '../agent/tool-registry'
import { useGoalStore, type SessionGoal } from '../../stores/goal-store'
import { encodeStructuredToolResult, encodeToolError } from './tool-result-format'
import type { ToolHandler } from './tool-types'

function getSessionId(sessionId?: string): string | null {
  return sessionId?.trim() || null
}

function goalToToolResponse(goal: SessionGoal | undefined | null): {
  goal: SessionGoal | null
  remaining_tokens: number | null
} {
  const remainingTokens =
    goal?.tokenBudget !== undefined && goal?.tokenBudget !== null
      ? Math.max(0, goal.tokenBudget - goal.tokensUsed)
      : null
  return {
    goal: goal ?? null,
    remaining_tokens: remainingTokens
  }
}

function completionBudgetReport(goal: SessionGoal): string | null {
  if (goal.status !== 'complete') return null
  const parts: string[] = []
  if (goal.tokenBudget !== undefined && goal.tokenBudget !== null) {
    parts.push(`tokens used: ${goal.tokensUsed} of ${goal.tokenBudget}`)
  }
  if (goal.timeUsedSeconds > 0) {
    parts.push(`time used: ${goal.timeUsedSeconds} seconds`)
  }
  if (parts.length === 0) return null
  return `Goal achieved. Report final budget usage to the user: ${parts.join('; ')}.`
}

const getGoalHandler: ToolHandler = {
  definition: {
    name: 'get_goal',
    description:
      'Get the current goal for this session, including status, budgets, token and elapsed-time usage, and remaining token budget.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  execute: async (_input, ctx) => {
    const sessionId = getSessionId(ctx.sessionId)
    if (!sessionId) return encodeToolError('No active session for get_goal.')

    const goal =
      useGoalStore.getState().getGoalBySession(sessionId) ??
      (await useGoalStore.getState().loadGoalForSession(sessionId, true))
    return encodeStructuredToolResult(goalToToolResponse(goal))
  },
  requiresApproval: () => false
}

const createGoalHandler: ToolHandler = {
  definition: {
    name: 'create_goal',
    description:
      'Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Set token_budget only when an explicit token budget is requested. Fails if a goal exists; use update_goal only for status.',
    inputSchema: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description:
            'Required. The concrete objective to start pursuing. This starts a new active goal only when no goal is currently defined; if a goal already exists, this tool fails.'
        },
        token_budget: {
          type: 'number',
          description: 'Optional positive token budget for the new active goal.'
        }
      },
      required: ['objective']
    }
  },
  execute: async (input, ctx) => {
    const sessionId = getSessionId(ctx.sessionId)
    if (!sessionId) return encodeToolError('No active session for create_goal.')

    const objective = typeof input.objective === 'string' ? input.objective.trim() : ''
    if (!objective) return encodeToolError('create_goal requires a non-empty objective.')
    const rawBudget = input.token_budget
    const tokenBudget =
      typeof rawBudget === 'number' && Number.isFinite(rawBudget) ? Math.floor(rawBudget) : null
    const result = await useGoalStore.getState().createGoal({
      sessionId,
      objective,
      tokenBudget
    })
    if (!result.success || !result.goal) {
      return encodeToolError(result.error ?? 'Unable to create goal.')
    }
    return encodeStructuredToolResult(goalToToolResponse(result.goal))
  },
  requiresApproval: () => false
}

const updateGoalHandler: ToolHandler = {
  definition: {
    name: 'update_goal',
    description:
      'Update the existing goal. Use this tool only to mark the goal achieved. Set status to complete only when the objective has actually been achieved and no required work remains. Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work. You cannot use this tool to pause, resume, or budget-limit a goal; those status changes are controlled by the user or system. The runtime may defer completion if the run still has unfinished tasks, failed or unfinished tool calls, queued user messages, or an active Plan Mode gate. When marking a budgeted goal achieved with status complete, report the final token usage from the tool result to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['complete'],
          description:
            'Required. Set to complete only when the objective is achieved and no required work remains.'
        }
      },
      required: ['status']
    }
  },
  execute: async (input, ctx) => {
    const sessionId = getSessionId(ctx.sessionId)
    if (!sessionId) return encodeToolError('No active session for update_goal.')
    if (input.status !== 'complete') {
      return encodeToolError(
        'update_goal can only mark the existing goal complete; pause, resume, and budget-limited status changes are controlled by the user or system.'
      )
    }

    const result = await useGoalStore.getState().updateGoal(sessionId, { status: 'complete' })
    if (!result.success || !result.goal) {
      return encodeToolError(result.error ?? 'Unable to update goal.')
    }

    return encodeStructuredToolResult({
      ...goalToToolResponse(result.goal),
      completion_budget_report: completionBudgetReport(result.goal)
    })
  },
  requiresApproval: () => false
}

export function registerGoalTools(): void {
  toolRegistry.register(getGoalHandler)
  toolRegistry.register(createGoalHandler)
  toolRegistry.register(updateGoalHandler)
}
