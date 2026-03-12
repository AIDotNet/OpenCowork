import { IPC } from '@renderer/lib/ipc/channels'
import type { ToolHandler } from '@renderer/lib/tools/tool-types'
import { DESKTOP_CLICK_TOOL_NAME } from './types'

const allowedButtons = ['left', 'right', 'middle'] as const
const allowedActions = ['click', 'double_click', 'down', 'up'] as const

type MouseButton = (typeof allowedButtons)[number]
type MouseAction = (typeof allowedActions)[number]

interface DesktopClickResult {
  success?: boolean
  error?: string
  x?: number
  y?: number
  button?: MouseButton
  action?: MouseAction
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
  execute: async (input, ctx) => {
    const x = Number(input.x)
    const y = Number(input.y)
    const button = typeof input.button === 'string' ? input.button : 'left'
    const action = typeof input.action === 'string' ? input.action : 'click'

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return JSON.stringify({ error: 'DesktopClick requires numeric x and y coordinates.' })
    }

    if (!allowedButtons.includes(button as MouseButton)) {
      return JSON.stringify({ error: `Unsupported button: ${button}.` })
    }

    if (!allowedActions.includes(action as MouseAction)) {
      return JSON.stringify({ error: `Unsupported action: ${action}.` })
    }

    const result = (await ctx.ipc.invoke(IPC.DESKTOP_INPUT_CLICK, {
      x,
      y,
      button,
      action
    })) as DesktopClickResult

    if (!result?.success) {
      return JSON.stringify({ error: result?.error || 'Desktop click failed.' })
    }

    return JSON.stringify({
      success: true,
      x: result.x ?? x,
      y: result.y ?? y,
      button: result.button ?? button,
      action: result.action ?? action,
      message: `Desktop ${result.action ?? action} executed at (${result.x ?? x}, ${result.y ?? y}) with ${result.button ?? button} button.`
    })
  },
  requiresApproval: () => true
}
