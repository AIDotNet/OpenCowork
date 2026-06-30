import { toolRegistry } from '../agent/tool-registry'
import { encodeToolError } from './tool-result-format'
import type { ToolHandler } from './tool-types'

function nativeOnlyPlanResult(toolName: string): string {
  return encodeToolError(
    `${toolName} executes in the .NET Native Worker and is unavailable through the renderer boundary.`
  )
}

export function createPlanModeInlineToolHandlers(): Record<string, ToolHandler> {
  return {}
}

const enterPlanModeHandler: ToolHandler = {
  definition: {
    name: 'EnterPlanMode',
    description:
      'Enter Plan Mode to explore the codebase and create a detailed implementation plan before writing code. ' +
      'In plan mode, use read/search tools for investigation and Write/Edit only for the current plan file returned by this tool. ' +
      'Do not make other file changes or run implementation commands.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description:
            'Brief reason in English for entering plan mode. This becomes the initial plan title if no plan exists (e.g. "add-user-authentication").'
        }
      }
    }
  },
  execute: async () => nativeOnlyPlanResult('EnterPlanMode'),
  requiresApproval: () => false
}

const exitPlanModeHandler: ToolHandler = {
  definition: {
    name: 'ExitPlanMode',
    description:
      'Exit Plan Mode after writing the plan file. This signals that the plan is finalized and ready for user review. ' +
      'After calling this tool, you MUST STOP and wait for the user to review the plan; do NOT continue with any further actions.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  execute: async () => nativeOnlyPlanResult('ExitPlanMode'),
  requiresApproval: () => false
}

export const PLAN_MODE_ALLOWED_TOOLS = new Set([
  'Read',
  'LS',
  'Glob',
  'Grep',
  'Write',
  'Edit',
  'EnterPlanMode',
  'ExitPlanMode',
  'AskUserQuestion',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  'Task',
  'Agent',
  'get_goal',
  'create_goal',
  'update_goal',
  'visualize_show_widget'
])

export const ACP_MODE_ALLOWED_TOOLS = new Set([
  'Read',
  'LS',
  'Glob',
  'Grep',
  'EnterPlanMode',
  'ExitPlanMode',
  'AskUserQuestion',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  'Task',
  'Agent',
  'get_goal',
  'create_goal',
  'update_goal',
  'visualize_show_widget'
])

export function registerPlanTools(): void {
  toolRegistry.register(enterPlanModeHandler)
  toolRegistry.register(exitPlanModeHandler)
}
