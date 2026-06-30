import type { ToolHandler } from '@renderer/lib/tools/tool-types'
import { DESKTOP_TYPE_TOOL_NAME } from './types'

function nativeOnlyDesktopResult(toolName: string): string {
  return JSON.stringify({
    error: `${toolName} execution has migrated to .NET Native Worker.`
  })
}

export const desktopTypeTool: ToolHandler = {
  definition: {
    name: DESKTOP_TYPE_TOOL_NAME,
    description:
      'Type text, press a special key, or send a keyboard shortcut on the desktop. Supported hotkey modifiers: Control, Meta, Alt, Shift.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Type a full text string into the active desktop target.'
        },
        key: {
          type: 'string',
          description: 'Press one special key such as Enter, Tab, Escape, Backspace, or Arrow keys.'
        },
        hotkey: {
          type: 'array',
          description: 'A key chord like ["Control", "L"] or ["Meta", "Shift", "S"].',
          items: {
            type: 'string'
          }
        }
      }
    }
  },
  execute: async () => nativeOnlyDesktopResult('DesktopType'),
  requiresApproval: () => true
}
