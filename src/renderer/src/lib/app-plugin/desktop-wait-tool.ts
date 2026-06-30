import type { ToolHandler } from '@renderer/lib/tools/tool-types'
import { DESKTOP_WAIT_TOOL_NAME } from './types'

function nativeOnlyDesktopResult(toolName: string): string {
  return JSON.stringify({
    error: `${toolName} execution has migrated to .NET Native Worker.`
  })
}

export const desktopWaitTool: ToolHandler = {
  definition: {
    name: DESKTOP_WAIT_TOOL_NAME,
    description: 'Pause desktop automation for a short period before continuing.',
    inputSchema: {
      type: 'object',
      properties: {
        delayMs: {
          type: 'number',
          description: 'Delay in milliseconds before continuing. Defaults to 2000.'
        }
      },
      additionalProperties: false
    }
  },
  execute: async () => nativeOnlyDesktopResult('DesktopWait'),
  requiresApproval: () => true
}
