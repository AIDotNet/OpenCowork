import type { ToolHandler } from '@renderer/lib/tools/tool-types'
import { DESKTOP_CLICK_TOOL_NAME } from './types'

function nativeOnlyDesktopResult(toolName: string): string {
  return JSON.stringify({
    error: `${toolName} execution has migrated to .NET Native Worker.`
  })
}

export const desktopClickTool: ToolHandler = {
  definition: {
    name: DESKTOP_CLICK_TOOL_NAME,
    description:
      'Click a desktop coordinate. Supports left/right/middle button with click, double_click, down, or up actions. Always inspect the screen first when possible.',
    inputSchema: {
      type: 'object',
      properties: {
        x: {
          type: 'number',
          description: 'Absolute X coordinate on the virtual desktop.'
        },
        y: {
          type: 'number',
          description: 'Absolute Y coordinate on the virtual desktop.'
        },
        button: {
          type: 'string',
          description: 'Mouse button: left, right, or middle.'
        },
        action: {
          type: 'string',
          description: 'Mouse action: click, double_click, down, or up.'
        }
      },
      required: ['x', 'y'],
      additionalProperties: false
    }
  },
  execute: async () => nativeOnlyDesktopResult('DesktopClick'),
  requiresApproval: () => true
}
