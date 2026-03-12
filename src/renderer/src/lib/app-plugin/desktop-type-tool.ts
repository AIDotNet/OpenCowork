import { IPC } from '@renderer/lib/ipc/channels'
import type { ToolHandler } from '@renderer/lib/tools/tool-types'
import { DESKTOP_TYPE_TOOL_NAME } from './types'

const allowedModifiers = ['Control', 'Meta', 'Alt', 'Shift'] as const
const allowedNamedKeys = [
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown'
] as const

type AllowedModifier = (typeof allowedModifiers)[number]
type AllowedNamedKey = (typeof allowedNamedKeys)[number]

interface DesktopTypeResult {
  success?: boolean
  error?: string
  mode?: 'text' | 'key' | 'hotkey'
  textLength?: number
  key?: string
  hotkey?: string[]
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
  execute: async (input, ctx) => {
    const text = typeof input.text === 'string' ? input.text : null
    const key = typeof input.key === 'string' ? input.key : null
    const hotkey = Array.isArray(input.hotkey)
      ? input.hotkey.filter((item): item is string => typeof item === 'string')
      : null

    const providedCount = Number(Boolean(text)) + Number(Boolean(key)) + Number(Boolean(hotkey?.length))
    if (providedCount !== 1) {
      return JSON.stringify({
        error: 'DesktopType requires exactly one of: text, key, or hotkey.'
      })
    }

    if (key && !allowedNamedKeys.includes(key as AllowedNamedKey)) {
      return JSON.stringify({ error: `Unsupported key: ${key}.` })
    }

    if (hotkey) {
      if (hotkey.length < 2) {
        return JSON.stringify({ error: 'DesktopType hotkey must include at least one modifier and one key.' })
      }
      const modifiers = hotkey.slice(0, -1)
      const mainKey = hotkey.at(-1)
      if (!modifiers.every((item) => allowedModifiers.includes(item as AllowedModifier))) {
        return JSON.stringify({
          error: `DesktopType hotkey modifiers must be one of: ${allowedModifiers.join(', ')}.`
        })
      }
      if (!mainKey || mainKey.length === 0) {
        return JSON.stringify({ error: 'DesktopType hotkey requires a trailing key.' })
      }
    }

    const result = (await ctx.ipc.invoke(IPC.DESKTOP_INPUT_TYPE, {
      text,
      key,
      hotkey
    })) as DesktopTypeResult

    if (!result?.success) {
      return JSON.stringify({ error: result?.error || 'Desktop typing failed.' })
    }

    return JSON.stringify({
      success: true,
      mode: result.mode,
      textLength: result.textLength,
      key: result.key,
      hotkey: result.hotkey,
      message:
        result.mode === 'text'
          ? `Typed ${result.textLength ?? text?.length ?? 0} characters into the desktop target.`
          : result.mode === 'key'
            ? `Pressed key ${result.key ?? key}.`
            : `Pressed hotkey ${(result.hotkey ?? hotkey ?? []).join(' + ')}.`
    })
  },
  requiresApproval: () => true
}
