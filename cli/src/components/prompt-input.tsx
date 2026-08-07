import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { findCommands } from '../commands.js'
import { graphemes, lineEnd, lineStart, nextWordEnd, previousWordStart } from '../lib/text.js'
import { theme } from '../theme.js'
import { CommandMenu } from './command-menu.js'
import { Divider } from './divider.js'
import { ShortcutPanel } from './shortcut-panel.js'

interface EditorSnapshot {
  cursor: number
  value: string
}

// Classic mode intentionally moves completed messages into Ink's <Static> tree. Some Ink
// versions remount the dynamic input subtree while committing static output, so the double-Ctrl-C
// deadline must outlive a PromptInput component instance.
let lastCtrlCAt = 0

interface PromptInputProps {
  active: boolean
  initialValue: string
  isRunning: boolean
  onAbort(): void
  onCycleMode(): void
  onExit(): void
  onNotice(message: string): void
  onOpenAgents(): void
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
  onOpenAgents,
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
  const editorRef = useRef<EditorSnapshot>({
    value: initialValue,
    cursor: graphemes(initialValue).length
  })
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [menuSuppressed, setMenuSuppressed] = useState(false)
  const historyRef = useRef<string[]>([])
  const historyIndexRef = useRef<number | null>(null)
  const killRingRef = useRef<string[]>([])
  const stashRef = useRef<EditorSnapshot | null>(null)
  const undoRef = useRef<EditorSnapshot[]>([])
  const lastEscapeRef = useRef(0)
  const characters = useMemo(() => graphemes(value), [value])
  const menuOpen = value.startsWith('/') && !value.includes(' ') && !menuSuppressed
  const commands = useMemo(() => (menuOpen ? findCommands(value) : []), [menuOpen, value])

  useEffect(() => setSelectedIndex(0), [value])

  const mutate = (nextValue: string, nextCursor: number): void => {
    undoRef.current.push(editorRef.current)
    if (undoRef.current.length > 100) undoRef.current.shift()
    editorRef.current = { value: nextValue, cursor: nextCursor }
    setValue(nextValue)
    setCursor(nextCursor)
    setMenuSuppressed(false)
    historyIndexRef.current = null
  }

  const replaceRange = (start: number, end: number, replacement: string): void => {
    const currentCharacters = graphemes(editorRef.current.value)
    const replacementCharacters = graphemes(replacement)
    const next = [
      ...currentCharacters.slice(0, start),
      ...replacementCharacters,
      ...currentCharacters.slice(end)
    ]
    mutate(next.join(''), start + replacementCharacters.length)
  }

  const moveCursor = (nextCursor: number): void => {
    editorRef.current = { ...editorRef.current, cursor: nextCursor }
    setCursor(nextCursor)
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
    editorRef.current = { value: '', cursor: 0 }
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
    editorRef.current = { value: historicalValue, cursor: graphemes(historicalValue).length }
    setValue(historicalValue)
    setCursor(graphemes(historicalValue).length)
    setMenuSuppressed(true)
  }

  useInput(
    (input, key) => {
      const currentEditor = editorRef.current
      const currentValue = currentEditor.value
      const currentCursor = currentEditor.cursor
      const currentCharacters = graphemes(currentValue)
      const rawCtrlCCount = input.split('\u0003').length - 1
      if ((key.ctrl && input === 'c') || rawCtrlCCount > 0) {
        if (isRunning) {
          lastCtrlCAt = 0
          onAbort()
          return
        }
        if (currentValue) {
          lastCtrlCAt = 0
          mutate('', 0)
          return
        }
        const now = Date.now()
        if (rawCtrlCCount > 1 || now - lastCtrlCAt < 3_000) {
          lastCtrlCAt = 0
          onExit()
        } else {
          lastCtrlCAt = now
          onNotice('Press Ctrl-C again to exit')
        }
        return
      }

      // Keep the prompt focused so Ctrl-C can cancel the active Worker turn, but
      // do not let ordinary editing or submission race the in-flight run.
      if (isRunning) return

      if (key.ctrl && input === 'o') {
        onToggleDetails()
        return
      }
      if (key.ctrl && input === 't') {
        onToggleTasks()
        return
      }
      if (key.ctrl && input === 's') {
        if (currentValue) {
          stashRef.current = currentEditor
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
        moveCursor(lineStart(currentCharacters, currentCursor))
        return
      }
      if (key.ctrl && input === 'e') {
        moveCursor(lineEnd(currentCharacters, currentCursor))
        return
      }
      if (key.ctrl && input === 'k') {
        const end = lineEnd(currentCharacters, currentCursor)
        rememberKill(currentCharacters.slice(currentCursor, end).join(''))
        replaceRange(currentCursor, end, '')
        return
      }
      if (key.ctrl && input === 'u') {
        const start = lineStart(currentCharacters, currentCursor)
        rememberKill(currentCharacters.slice(start, currentCursor).join(''))
        replaceRange(start, currentCursor, '')
        return
      }
      if (key.ctrl && input === 'w') {
        const start = previousWordStart(currentCharacters, currentCursor)
        rememberKill(currentCharacters.slice(start, currentCursor).join(''))
        replaceRange(start, currentCursor, '')
        return
      }
      if (key.ctrl && input === 'y') {
        replaceRange(currentCursor, currentCursor, killRingRef.current[0] ?? '')
        return
      }
      if (key.ctrl && input === '_') {
        const previous = undoRef.current.pop()
        if (previous) {
          editorRef.current = previous
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
          setSelectedIndex((current) =>
            current === 0 ? Math.min(7, commands.length - 1) : current - 1
          )
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
          if (currentValue) mutate('', 0)
          else onNotice('Rewind requires an active runtime checkpoint')
          lastEscapeRef.current = 0
        } else {
          lastEscapeRef.current = now
          if (isRunning) onAbort()
        }
        return
      }

      if (input === '?' && currentValue.length === 0) {
        onToggleHelp()
        return
      }

      if (key.leftArrow) {
        if (currentCharacters.length === 0) {
          onOpenAgents()
          return
        }
        moveCursor(Math.max(0, currentCursor - 1))
        return
      }
      if (key.rightArrow) {
        moveCursor(Math.min(currentCharacters.length, currentCursor + 1))
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
        moveCursor(previousWordStart(currentCharacters, currentCursor))
        return
      }
      if (key.meta && input.toLowerCase() === 'f') {
        moveCursor(nextWordEnd(currentCharacters, currentCursor))
        return
      }
      if (key.backspace || key.delete) {
        if (currentCursor > 0) replaceRange(currentCursor - 1, currentCursor, '')
        return
      }
      if (key.return) {
        if (key.shift || currentCharacters[currentCursor - 1] === '\\') {
          if (currentCharacters[currentCursor - 1] === '\\') {
            replaceRange(currentCursor - 1, currentCursor, '\n')
          } else {
            replaceRange(currentCursor, currentCursor, '\n')
          }
        } else {
          submit(currentValue)
        }
        return
      }

      if (input && !key.ctrl && !key.meta && !key.tab) {
        replaceRange(currentCursor, currentCursor, input)
      }
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
        <Text bold color={value.startsWith('!') ? theme.warning : theme.primary}>
          ❯{' '}
        </Text>
        <Text wrap="wrap">
          {beforeCursor}
          <Text bold color={theme.primary}>
            ▏
          </Text>
          {cursorCharacter === '\n' ? '' : cursorCharacter}
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
