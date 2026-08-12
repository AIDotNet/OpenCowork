import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * User-configurable keymap for the CLI's chord shortcuts. Users override individual
 * actions in ~/.open-cowork/cli-keymap.json, e.g.
 *
 *   { "toggleDetails": "ctrl+d", "openModel": "meta+m" }
 *
 * Chords are `modifier+…+key` strings; modifiers are ctrl/meta/alt/shift, keys are a
 * single character or a named key (tab, return, escape, up, down, left, right, pageup,
 * pagedown). Text-editing keys (cursor movement, kill ring, history) are intentionally
 * not remappable — they follow readline conventions.
 */

export type KeymapAction =
  | 'cycleMode'
  | 'openModel'
  | 'pasteImage'
  | 'redraw'
  | 'stashPrompt'
  | 'toggleDetails'
  | 'toggleTasks'
  | 'undo'

export interface KeyChord {
  ctrl: boolean
  meta: boolean
  shift: boolean
  /** Lowercase character, or a named key (tab/return/escape/…). */
  key: string
}

/** Subset of Ink's Key object that chord matching relies on. */
export interface ChordKeyState {
  ctrl: boolean
  meta: boolean
  shift: boolean
  tab: boolean
  return: boolean
  escape: boolean
  upArrow: boolean
  downArrow: boolean
  leftArrow: boolean
  rightArrow: boolean
  pageUp: boolean
  pageDown: boolean
}

const NAMED_KEYS = new Set([
  'tab',
  'return',
  'escape',
  'up',
  'down',
  'left',
  'right',
  'pageup',
  'pagedown'
])

const DEFAULT_KEYMAP: Record<KeymapAction, string> = {
  cycleMode: 'shift+tab',
  openModel: 'meta+p',
  pasteImage: 'ctrl+v',
  redraw: 'ctrl+l',
  stashPrompt: 'ctrl+s',
  toggleDetails: 'ctrl+o',
  toggleTasks: 'ctrl+t',
  undo: 'ctrl+_'
}

export function parseChord(spec: string): KeyChord | null {
  const parts = spec
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  const chord: KeyChord = { ctrl: false, meta: false, shift: false, key: '' }
  for (const part of parts) {
    if (part === 'ctrl' || part === 'control') chord.ctrl = true
    else if (part === 'meta' || part === 'alt' || part === 'option') chord.meta = true
    else if (part === 'shift') chord.shift = true
    else if (NAMED_KEYS.has(part) || [...part].length === 1) chord.key = part
    else return null
  }
  return chord.key ? chord : null
}

function loadKeymap(): Record<KeymapAction, KeyChord> {
  const resolved = {} as Record<KeymapAction, KeyChord>
  let overrides: Record<string, unknown> = {}
  try {
    const raw = readFileSync(join(homedir(), '.open-cowork', 'cli-keymap.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      overrides = parsed as Record<string, unknown>
    }
  } catch {
    // Missing or invalid keymap files silently fall back to the defaults.
  }

  for (const [action, defaultSpec] of Object.entries(DEFAULT_KEYMAP) as Array<
    [KeymapAction, string]
  >) {
    const override = overrides[action]
    const chord =
      (typeof override === 'string' ? parseChord(override) : null) ?? parseChord(defaultSpec)
    resolved[action] = chord as KeyChord
  }
  return resolved
}

let activeKeymap: Record<KeymapAction, KeyChord> | null = null

function keymap(): Record<KeymapAction, KeyChord> {
  if (!activeKeymap) activeKeymap = loadKeymap()
  return activeKeymap
}

/** Test hook: forces the next lookup to re-read the keymap file. */
export function resetKeymapCache(): void {
  activeKeymap = null
}

function namedKeyPressed(name: string, key: ChordKeyState): boolean {
  switch (name) {
    case 'tab':
      return key.tab
    case 'return':
      return key.return
    case 'escape':
      return key.escape
    case 'up':
      return key.upArrow
    case 'down':
      return key.downArrow
    case 'left':
      return key.leftArrow
    case 'right':
      return key.rightArrow
    case 'pageup':
      return key.pageUp
    case 'pagedown':
      return key.pageDown
    default:
      return false
  }
}

/** Matches one Ink useInput invocation against the (possibly user-overridden) chord. */
export function matchesKey(action: KeymapAction, input: string, key: ChordKeyState): boolean {
  const chord = keymap()[action]
  if (!chord) return false
  if (chord.ctrl !== key.ctrl || chord.meta !== key.meta) return false
  if (NAMED_KEYS.has(chord.key)) {
    if (chord.shift !== key.shift) return false
    return namedKeyPressed(chord.key, key)
  }
  // Character chords: shift is encoded in the character itself for symbols, so only
  // require the flag when explicitly requested.
  if (chord.shift && !key.shift) return false
  return input.toLowerCase() === chord.key
}
