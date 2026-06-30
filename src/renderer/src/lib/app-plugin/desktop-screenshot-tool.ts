import type { ToolHandler } from '@renderer/lib/tools/tool-types'
import { DESKTOP_SCREENSHOT_TOOL_NAME } from './types'

function nativeOnlyDesktopResult(toolName: string): string {
  return JSON.stringify({
    error: `${toolName} execution has migrated to .NET Native Worker.`
  })
}

export const desktopScreenshotTool: ToolHandler = {
  definition: {
    name: DESKTOP_SCREENSHOT_TOOL_NAME,
    description:
      'Capture a full desktop screenshot and return it to the agent. Use this before mouse or keyboard actions when the current screen state matters.',
    inputSchema: {
      type: 'object',
      properties: {
        delayMs: {
          type: 'number',
          description: 'Optional delay in milliseconds before capturing the screenshot.'
        }
      },
      additionalProperties: false
    }
  },
  execute: async () => nativeOnlyDesktopResult('DesktopScreenshot'),
  requiresApproval: () => true
}
