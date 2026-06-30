import { toolRegistry } from '../agent/tool-registry'
import { encodeStructuredToolResult } from './tool-result-format'
import type { ToolHandler } from './tool-types'

function encodeNativeOnlyGoalResult(toolName: string): string {
  return encodeStructuredToolResult({
    error: `${toolName} execution has migrated to .NET Native Worker.`
  })
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
  execute: async () => encodeNativeOnlyGoalResult('get_goal'),
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
  execute: async () => encodeNativeOnlyGoalResult('create_goal'),
  requiresApproval: () => false
}

const updateGoalHandler: ToolHandler = {
  definition: {
    name: 'update_goal',
    description:
      'Update the existing goal. Use this tool only to mark the goal achieved or genuinely blocked. Set status to complete only when the objective is achieved and no required work remains. Set status to blocked only after the same blocking condition has recurred for at least three consecutive goal turns and the agent cannot make meaningful progress without user input or an external-state change. Do not use blocked merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification. You cannot use this tool to pause, resume, or limit a goal; those status changes are controlled by the user or system. The runtime may defer completion if the run still has unfinished tasks, failed or unfinished tool calls, queued user messages, or an active Plan Mode gate. When marking a budgeted goal achieved with status complete, report the final token usage from the tool result to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['complete', 'blocked'],
          description:
            'Required. Set to complete only when the objective is achieved and no required work remains. Set to blocked only after the same blocking condition has recurred for at least three consecutive goal turns.'
        }
      },
      required: ['status']
    }
  },
  execute: async () => encodeNativeOnlyGoalResult('update_goal'),
  requiresApproval: () => false
}

export function registerGoalTools(): void {
  toolRegistry.register(getGoalHandler)
  toolRegistry.register(createGoalHandler)
  toolRegistry.register(updateGoalHandler)
}
