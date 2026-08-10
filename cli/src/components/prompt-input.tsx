import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { findCommands } from '../commands.js'
import { MAX_PROMPT_IMAGES, readClipboardImage } from '../lib/clipboard-image.js'
import {
  fitText,
  graphemes,
  lineEnd,
  lineStart,
  nextWordEnd,
  previousWordStart
} from '../lib/text.js'
import { theme } from '../theme.js'
import type {
  PromptImageAttachment,
  RewindAction,
  RewindCheckpoint,
  RewindResult
} from '../types.js'
import { CommandMenu } from './command-menu.js'
import { Divider } from './divider.js'
import { RewindPanel } from './rewind-panel.js'
import { ShortcutPanel } from './shortcut-panel.js'

interface EditorSnapshot {
  cursor: number
  value: string
}

// Classic mode intentionally moves completed messages into Ink's <Static> tree. Some Ink
// versions remount the dynamic input subtree while committing static output, so multi-press
// deadlines must outlive a PromptInput component instance.
let lastCtrlCAt = 0
let lastEscapeAt = 0

function formatImageSize(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(size / 1024))} KB`
}

interface PromptInputProps {
  active: boolean
  images: PromptImageAttachment[]
  initialValue: string
  isRunning: boolean
  onAbort(): void
  onCycleMode(): void
  onExit(): void
  onListRewindCheckpoints(): Promise<RewindCheckpoint[]>
  onNotice(message: string): void
  onOpenAgents(): void
  onOpenModel(): void
  onRedraw(): void
  onImagesChange: React.Dispatch<React.SetStateAction<PromptImageAttachment[]>>
  onRewind(
    checkpointId: string,
    action: RewindAction,
    instructions: string | undefined,
    signal: AbortSignal
  ): Promise<RewindResult>
  onSubmit(value: string, images: PromptImageAttachment[]): void
  onToggleDetails(): void
  onToggleHelp(): void
  onToggleTasks(): void
  showHelp: boolean
  supportsVision: boolean
  width: number
}

export function PromptInput({
  active,
  images,
  initialValue,
  isRunning,
  onAbort,
  onCycleMode,
  onExit,
  onListRewindCheckpoints,
  onNotice,
  onOpenAgents,
  onOpenModel,
  onRedraw,
  onImagesChange,
  onRewind,
  onSubmit,
  onToggleDetails,
  onToggleHelp,
  onToggleTasks,
  showHelp,
  supportsVision,
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
  const [rewindOpen, setRewindOpen] = useState(false)
  const [readingClipboard, setReadingClipboard] = useState(false)
  const historyRef = useRef<string[]>([])
  const historyIndexRef = useRef<number | null>(null)
  const killRingRef = useRef<string[]>([])
  const stashRef = useRef<EditorSnapshot | null>(null)
  const undoRef = useRef<EditorSnapshot[]>([])
  const characters = useMemo(() => graphemes(value), [value])
  const menuOpen = value.startsWith('/') && !value.includes(' ') && !menuSuppressed
  const commands = useMemo(() => (menuOpen ? findCommands(value) : []), [menuOpen, value])

  useEffect(() => setSelectedIndex(0), [value])
  useEffect(() => {
    if (!active) setRewindOpen(false)
  }, [active])

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

  const openRewind = (): void => {
    lastEscapeAt = 0
    if (showHelp) onToggleHelp()
    onNotice('')
    setRewindOpen(true)
  }

  const submit = (submission: string): void => {
    const trimmed = submission.trim()
    if (!trimmed && images.length === 0) return
    if (images.length > 0 && trimmed.startsWith('/')) {
      onNotice('Remove attached images before running a CLI command')
      return
    }
    if (images.length > 0 && !supportsVision) {
      onNotice('Current model does not support image input · choose a vision model with Alt-P')
      return
    }
    if (trimmed && historyRef.current.at(-1) !== submission) historyRef.current.push(submission)
    historyIndexRef.current = null
    undoRef.current = []
    editorRef.current = { value: '', cursor: 0 }
    setValue('')
    setCursor(0)
    setMenuSuppressed(false)
    const submittedImages = images
    onImagesChange([])
    if (trimmed.toLowerCase() === '/rewind') {
      openRewind()
      return
    }
    onSubmit(trimmed || 'Analyze the attached image.', submittedImages)
  }

  const pasteClipboardImage = (): void => {
    if (readingClipboard) return
    if (!supportsVision) {
      onNotice('Current model does not support image input · choose a vision model with Alt-P')
      return
    }
    if (images.length >= MAX_PROMPT_IMAGES) {
      onNotice(`A prompt can include up to ${MAX_PROMPT_IMAGES} images`)
      return
    }
    setReadingClipboard(true)
    onNotice('Reading clipboard image…')
    void readClipboardImage()
      .then((result) => {
        if (result.status === 'image') {
          onImagesChange((current) =>
            current.length >= MAX_PROMPT_IMAGES ? current : [...current, result.image]
          )
          onNotice(`Attached ${result.image.name}`)
          return
        }
        if (result.status === 'empty') {
          onNotice('Clipboard does not contain a supported image')
          return
        }
        onNotice(result.message)
      })
      .finally(() => setReadingClipboard(false))
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
      const rawEscapeCount = input.split('\u001b').length - 1
      if ((key.ctrl && input === 'c') || rawCtrlCCount > 0) {
        if (isRunning) {
          lastCtrlCAt = 0
          onAbort()
          return
        }
        if (currentValue || images.length > 0) {
          lastCtrlCAt = 0
          if (currentValue) mutate('', 0)
          onImagesChange([])
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

      if (isRunning && key.escape) {
        onAbort()
        return
      }

      if ((key.ctrl && input.toLowerCase() === 'l') || input === '\u000c') {
        onRedraw()
        return
      }

      if (key.ctrl && input.toLowerCase() === 'o') {
        onToggleDetails()
        return
      }
      if (key.ctrl && input.toLowerCase() === 't') {
        onToggleTasks()
        return
      }

      // Keep the prompt focused so Ctrl-C can cancel the active Worker turn, but
      // do not let ordinary editing or submission race the in-flight run.
      if (isRunning) return
      if (!key.escape) lastEscapeAt = 0

      if ((key.ctrl && input.toLowerCase() === 'v') || input === '\u0016') {
        pasteClipboardImage()
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
            current <= 0 ? Math.max(0, commands.length - 1) : current - 1
          )
          return
        }
        if (key.downArrow) {
          setSelectedIndex((current) => (commands.length > 0 ? (current + 1) % commands.length : 0))
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
          lastEscapeAt = 0
          return
        }
        const now = Date.now()
        if (rawEscapeCount > 1 || now - lastEscapeAt < 3_000) {
          lastEscapeAt = 0
          if (currentValue || images.length > 0) {
            if (currentValue && historyRef.current.at(-1) !== currentValue) {
              historyRef.current.push(currentValue)
            }
            mutate('', 0)
            onImagesChange([])
            onNotice(currentValue ? 'Prompt cleared · ↑ to restore' : 'Image attachments cleared')
          } else {
            openRewind()
          }
        } else {
          lastEscapeAt = now
          onNotice(
            currentValue || images.length > 0
              ? 'Press Esc again to clear'
              : 'Press Esc again to rewind'
          )
        }
        return
      }

      if (input === '?' && currentValue.length === 0) {
        onToggleHelp()
        return
      }

      if (key.leftArrow) {
        if (currentCharacters.length === 0 && images.length === 0) {
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
        if (currentCursor > 0) {
          replaceRange(currentCursor - 1, currentCursor, '')
        } else if (currentCharacters.length === 0 && images.length > 0) {
          onImagesChange((current) => current.slice(0, -1))
          onNotice('Removed last image')
        }
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
    { isActive: active && !rewindOpen }
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
      {images.length > 0 || readingClipboard ? (
        <Box paddingX={2} width={width}>
          <Text color={theme.muted}>
            {fitText(
              readingClipboard
                ? `Images ${images.length} · Reading clipboard image…`
                : `Images ${images.length} · ${images
                    .map((image) => `${image.name} (${formatImageSize(image.size)})`)
                    .join(' · ')} · Backspace on empty removes last`,
              Math.max(1, width - 4)
            )}
          </Text>
        </Box>
      ) : null}
      <Divider width={width} />
      {rewindOpen ? (
        <RewindPanel
          loadCheckpoints={onListRewindCheckpoints}
          maxVisible={7}
          onCancel={() => setRewindOpen(false)}
          onComplete={(result) => {
            if (result.restoredPrompt !== undefined) {
              onImagesChange(result.restoredImages ?? [])
              const nextCursor = graphemes(result.restoredPrompt).length
              mutate(result.restoredPrompt, nextCursor)
            }
            setRewindOpen(false)
          }}
          onExecute={onRewind}
          width={width}
        />
      ) : menuOpen ? (
        <CommandMenu commands={commands} selectedIndex={selectedIndex} width={width} />
      ) : null}
      {showHelp && !rewindOpen ? <ShortcutPanel width={width} /> : null}
    </Box>
  )
}
