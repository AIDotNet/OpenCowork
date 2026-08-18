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
      'In plan mode, prioritize read/search tools for investigation and write the plan into the current plan file returned by this tool. ' +
      'Write operations remain available when the planning work needs them.',
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
      'If you have not written the plan file yet, pass the complete plan markdown as `plan` and this tool will write it for you. ' +
      'After calling this tool, you MUST STOP and wait for the user to review the plan; do NOT continue with any further actions.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          description:
            'Optional. The complete plan in Markdown. Provide it when the plan file has not been written yet; it replaces the plan file content.'
        }
      }
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

export { ACP_MODE_ALLOWED_TOOLS } from '../../../../shared/session-mode-tools'

export function registerPlanTools(): void {
  toolRegistry.register(enterPlanModeHandler)
  toolRegistry.register(exitPlanModeHandler)
}
