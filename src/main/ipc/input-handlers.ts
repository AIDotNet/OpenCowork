import { ipcMain, screen } from 'electron'
import * as robot from '@jitsi/robotjs'

const DESKTOP_INPUT_CLICK = 'desktop:input:click'
const DESKTOP_INPUT_TYPE = 'desktop:input:type'

// Maps our key names (from the tool schema) to robotjs key names
const KEY_MAP: Record<string, string> = {
  Enter: 'enter',
  Tab: 'tab',
  Escape: 'escape',
  Backspace: 'backspace',
  Delete: 'delete',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  Space: 'space',
  Control: 'control',
  Shift: 'shift',
  Alt: 'alt',
  Meta: 'command'
}

function resolveRobotKey(name: string): string | null {
  if (KEY_MAP[name]) return KEY_MAP[name]
  if (/^[a-zA-Z0-9]$/.test(name)) return name.toLowerCase()
  const fMatch = name.match(/^F([1-9]|1[0-2])$/)
  if (fMatch) return `f${fMatch[1]}`
  return null
}

interface ClickArgs {
  x: number
  y: number
  button?: 'left' | 'right' | 'middle'
  action?: 'click' | 'double_click' | 'down' | 'up'
}

interface TypeArgs {
  text?: string | null
  key?: string | null
  hotkey?: string[] | null
}

function isPointInsideDesktop(x: number, y: number): boolean {
  const bounds = screen.getAllDisplays().reduce(
    (acc, display) => ({
      minX: Math.min(acc.minX, display.bounds.x),
      minY: Math.min(acc.minY, display.bounds.y),
      maxX: Math.max(acc.maxX, display.bounds.x + display.bounds.width),
      maxY: Math.max(acc.maxY, display.bounds.y + display.bounds.height)
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  )
  return x >= bounds.minX && x < bounds.maxX && y >= bounds.minY && y < bounds.maxY
}

export function registerInputHandlers(): void {
  ipcMain.handle(DESKTOP_INPUT_CLICK, (_event, args: ClickArgs) => {
    try {
      const x = Number(args.x)
      const y = Number(args.y)
      const button = args.button ?? 'left'
      const action = args.action ?? 'click'

      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { success: false, error: 'Invalid click coordinates.' }
      }

      if (!isPointInsideDesktop(x, y)) {
        return {
          success: false,
          error: `Coordinate (${x}, ${y}) is outside the desktop bounds.`
        }
      }

      robot.setMouseDelay(0)
      robot.moveMouse(Math.round(x), Math.round(y))

      if (action === 'double_click') {
        robot.mouseClick(button, true)
      } else if (action === 'down') {
        robot.mouseToggle('down', button)
      } else if (action === 'up') {
        robot.mouseToggle('up', button)
      } else {
        robot.mouseClick(button)
      }

      return { success: true, x, y, button, action }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle(DESKTOP_INPUT_TYPE, (_event, args: TypeArgs) => {
    try {
      if (typeof args.text === 'string') {
        robot.setKeyboardDelay(0)
        robot.typeString(args.text)
        return { success: true, mode: 'text', textLength: args.text.length }
      }

      if (typeof args.key === 'string') {
        const resolved = resolveRobotKey(args.key)
        if (!resolved) {
          return { success: false, error: `Unsupported key: ${args.key}.` }
        }
        robot.keyTap(resolved)
        return { success: true, mode: 'key', key: args.key }
      }

      if (Array.isArray(args.hotkey) && args.hotkey.length > 1) {
        const resolvedKeys = args.hotkey.map(resolveRobotKey)
        const unsupported = args.hotkey.filter((_, i) => resolvedKeys[i] === null)
        if (unsupported.length > 0) {
          return {
            success: false,
            error: `Hotkey contains unsupported key name(s): ${unsupported.join(', ')}.`
          }
        }
        const keys = resolvedKeys as string[]
        const modifiers = keys.slice(0, -1)
        const mainKey = keys[keys.length - 1]
        robot.keyTap(mainKey, modifiers.length === 1 ? modifiers[0] : modifiers)
        return { success: true, mode: 'hotkey', hotkey: args.hotkey }
      }

      return { success: false, error: 'Desktop input requires text, key, or hotkey.' }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })
}
