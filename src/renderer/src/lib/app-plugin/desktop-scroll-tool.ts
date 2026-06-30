import type { ToolHandler } from '@renderer/lib/tools/tool-types'
import { DESKTOP_SCROLL_TOOL_NAME } from './types'

function nativeOnlyDesktopResult(toolName: string): string {
  return JSON.stringify({
    error: `${toolName} execution has migrated to .NET Native Worker.`
  })
}

export const desktopScrollTool: ToolHandler = {
  definition: {
    name: DESKTOP_SCROLL_TOOL_NAME,
    description:
      'Scroll on the desktop. Optionally move the pointer to x/y first, then apply scrollX/scrollY deltas.',
    inputSchema: {
      type: 'object',
      properties: {
        x: {
          type: 'number',
          description: 'Optional X coordinate to move the pointer to before scrolling.'
        },
        y: {
          type: 'number',
          description: 'Optional Y coordinate to move the pointer to before scrolling.'
        },
        scrollX: {
          type: 'number',
          description: 'Horizontal scroll delta. Defaults to 0.'
        },
        scrollY: {
          type: 'number',
          description: 'Vertical scroll delta. Positive/negative direction depends on the OS.'
        }
      },
      additionalProperties: false
    }
  },
  execute: async () => nativeOnlyDesktopResult('DesktopScroll'),
  requiresApproval: () => true
}
