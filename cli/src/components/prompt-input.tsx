import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { findCommands } from '../commands.js'
import {
  graphemes,
  lineEnd,
  lineStart,
  nextWordEnd,
  previousWordStart
} from '../lib/text.js'
import { theme } from '../theme.js'
import { CommandMenu } from './command-menu.js'
import { Divider } from './divider.js'
import { ShortcutPanel } from './shortcut-panel.js'

interface EditorSnapshot {
  cursor: number
  value: string
}

interface PromptInputProps {
  active: boolean
  initialValue: string
  isRunning: boolean
  onAbort(): void
  onCycleMode(): void
  onExit(): void
  onNotice(message: string): void
  onOpenModel(): void
  onSubmit(value: string): void
  onToggleDetails(): void
  onToggleHelp(): void
  onToggleTasks(): void
  showHelp: boolean
  width: number
}

export function PromptInput({
  active,
  initialValue,
  isRunning,
  onAbort,
  onCycleMode,
  onExit,
  onNotice,
  onOpenModel,
  onSubmit,
  onToggleDetails,
  onToggleHelp,
  onToggleTasks,
  showHelp,
  width
}: PromptInputProps): React.JSX.Element {
  const [value, setValue] = useState(initialValue)
  const [cursor, setCursor] = useState(graphemes(initialValue).length)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [menuSuppressed, setMenuSuppressed] = useState(false)
  const historyRef = useRef<string[]>([])
  const historyIndexRef = useRef<number | null>(null)
  const killRingRef = useRef<string[]>([])
  const stashRef = useRef<EditorSnapshot | null>(null)
  const undoRef = useRef<EditorSnapshot[]>([])
  const lastCtrlCRef = useRef(0)
  const lastEscapeRef = useRef(0)
  const characters = useMemo(() => graphemes(value), [value])
  const menuOpen = value.startsWith('/') && !value.includes(' ') && !menuSuppressed
  const commands = useMemo(() => (menuOpen ? findCommands(value) : []), [menuOpen, value])

  useEffect(() => setSelectedIndex(0), [value])

  const mutate = (nextValue: string, nextCursor: number): void => {
    undoRef.current.push({ value, cursor })
    if (undoRef.current.length > 100) undoRef.current.shift()
    setValue(nextValue)
    setCursor(nextCursor)
    setMenuSuppressed(false)
    historyIndexRef.current = null
  }

  const replaceRange = (start: number, end: number, replacement: string): void => {
    const replacementCharacters = graphemes(replacement)
    const next = [
      ...characters.slice(0, start),
      ...replacementCharacters,
      ...characters.slice(end)
    ]
    mutate(next.join(''), start + replacementCharacters.length)
  }

  const rememberKill = (text: string): void => {
    if (!text) return
    killRingRef.current.unshift(text)
    if (killRingRef.current.length > 20) killRingRef.current.pop()
  }

  const submit = (submission: string): void => {
    const trimmed = submission.trim()
    if (!trimmed) return
    if (historyRef.current.at(-1) !== submission) historyRef.current.push(submission)
    historyIndexRef.current = null
    undoRef.current = []
    setValue('')
    setCursor(0)
    setMenuSuppressed(false)
    onSubmit(submission)
  }

  const moveThroughHistory = (direction: -1 | 1): void => {
    if (historyRef.current.length === 0) return
    const current = historyIndexRef.current
    let next = current === null ? historyRef.current.length - 1 : current + direction
    next = Math.max(0, Math.min(historyRef.current.length - 1, next))
    historyIndexRef.current = next
    const historicalValue = historyRef.current[next] ?? ''
    setValue(historicalValue)
    setCursor(graphemes(historicalValue).length)
    setMenuSuppressed(true)
  }

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        if (isRunning) {
          onAbort()
          return
        }
        if (value) {
          mutate('', 0)
          return
        }
        const now = Date.now()
        if (now - lastCtrlCRef.current < 1_000) {
          onExit()
        } else {
          lastCtrlCRef.current = now
          onNotice('Press Ctrl-C again to exit')
        }
        return
      }

      if (key.ctrl && input === 'o') {
        onToggleDetails()
        return
      }
      if (key.ctrl && input === 't') {
        onToggleTasks()
        return
      }
      if (key.ctrl && input === 's') {
        if (value) {
          stashRef.current = { value, cursor }
          mutate('', 0)
          onNotice('Prompt stashed · Ctrl-S to restore')
        } else if (stashRef.current) {
          const stash = stashRef.current
          mutate(stash.value, stash.cursor)
          stashRef.current = null
        }
        return
      }
      if (key.ctrl && input === 'a') {
        setCursor(lineStart(characters, cursor))
        return
      }
      if (key.ctrl && input === 'e') {
        setCursor(lineEnd(characters, cursor))
        return
      }
      if (key.ctrl && input === 'k') {
        const end = lineEnd(characters, cursor)
        rememberKill(characters.slice(cursor, end).join(''))
        replaceRange(cursor, end, '')
        return
      }
      if (key.ctrl && input === 'u') {
        const start = lineStart(characters, cursor)
        rememberKill(characters.slice(start, cursor).join(''))
        replaceRange(start, cursor, '')
        return
      }
      if (key.ctrl && input === 'w') {
        const start = previousWordStart(characters, cursor)
        rememberKill(characters.slice(start, cursor).join(''))
        replaceRange(start, cursor, '')
        return
      }
      if (key.ctrl && input === 'y') {
        replaceRange(cursor, cursor, killRingRef.current[0] ?? '')
        return
      }
      if (key.ctrl && input === '_') {
        const previous = undoRef.current.pop()
        if (previous) {
          setValue(previous.value)
          setCursor(previous.cursor)
        }
        return
      }

      if (key.tab && key.shift) {
        onCycleMode()
        return
      }
      if (key.meta && input.toLowerCase() === 'p') {
        onOpenModel()
        return
      }

      if (menuOpen && commands.length > 0) {
        if (key.upArrow) {
          setSelectedIndex((current) => (current === 0 ? Math.min(7, commands.length - 1) : current - 1))
          return
        }
        if (key.downArrow) {
          setSelectedIndex((current) => (current + 1) % Math.min(8, commands.length))
          return
        }
        if (key.tab || key.return) {
          const selected = commands[selectedIndex]
          if (!selected) return
          const completion = selected.completion ?? selected.name
          if (selected.completion) {
            mutate(completion, graphemes(completion).length)
          } else if (key.return) {
            submit(selected.name)
          } else {
            mutate(completion, graphemes(completion).length)
          }
          return
        }
      }

      if (key.escape) {
        if (menuOpen) {
          setMenuSuppressed(true)
          return
        }
        const now = Date.now()
        if (now - lastEscapeRef.current < 800) {
          if (value) mutate('', 0)
          else onNotice('Rewind requires an active runtime checkpoint')
          lastEscapeRef.current = 0
        } else {
          lastEscapeRef.current = now
          if (isRunning) onAbort()
        }
        return
      }

      if (input === '?' && value.length === 0) {
        onToggleHelp()
        return
      }

      if (key.leftArrow) {
        setCursor((current) => Math.max(0, current - 1))
        return
      }
      if (key.rightArrow) {
        setCursor((current) => Math.min(characters.length, current + 1))
        return
      }
      if (key.upArrow) {
        moveThroughHistory(-1)
        return
      }
      if (key.downArrow) {
        moveThroughHistory(1)
        return
      }
      if (key.meta && input.toLowerCase() === 'b') {
        setCursor(previousWordStart(characters, cursor))
        return
      }
      if (key.meta && input.toLowerCase() === 'f') {
        setCursor(nextWordEnd(characters, cursor))
        return
      }
      if (key.backspace || key.delete) {
        if (cursor > 0) replaceRange(cursor - 1, cursor, '')
        return
      }
      if (key.return) {
        if (key.shift || characters[cursor - 1] === '\\') {
          if (characters[cursor - 1] === '\\') replaceRange(cursor - 1, cursor, '\n')
          else replaceRange(cursor, cursor, '\n')
        } else {
          submit(value)
        }
        return
      }

      if (input && !key.ctrl && !key.meta && !key.tab) replaceRange(cursor, cursor, input)
    },
    { isActive: active }
  )

  const beforeCursor = characters.slice(0, cursor).join('')
  const cursorCharacter = characters[cursor]
  const afterCursor = characters.slice(cursor + (cursorCharacter ? 1 : 0)).join('')

  return (
    <Box flexDirection="column" width={width}>
      <Divider width={width} />
      <Box minHeight={1}>
        <Text bold color={value.startsWith('!') ? theme.warning : theme.primary}>❯ </Text>
        <Text wrap="wrap">
          {beforeCursor}
          <Text inverse>{cursorCharacter === '\n' || !cursorCharacter ? ' ' : cursorCharacter}</Text>
          {cursorCharacter === '\n' ? '\n' : ''}
          {afterCursor}
        </Text>
      </Box>
      <Divider width={width} />
      {menuOpen ? (
        <CommandMenu commands={commands} selectedIndex={selectedIndex} width={width} />
      ) : null}
      {showHelp ? <ShortcutPanel width={width} /> : null}
    </Box>
  )
}
