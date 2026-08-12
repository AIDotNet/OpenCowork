import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { findCommands } from '../commands.js'
import { t } from '../i18n.js'
import { MAX_PROMPT_IMAGES, readClipboardImage } from '../lib/clipboard-image.js'
import {
  addPromptFileReference,
  createFileReferenceMarkdown,
  findFileReferenceMention,
  MAX_PROMPT_FILE_REFERENCES
} from '../lib/file-references.js'
import { matchesKey } from '../lib/keymap.js'
import {
  fitText,
  graphemes,
  lineEnd,
  lineStart,
  nextWordEnd,
  previousWordStart
} from '../lib/text.js'
import { containsMouseSequence } from '../terminal/mouse.js'
import { theme } from '../theme.js'
import type {
  FileReferenceCandidate,
  PromptImageAttachment,
  PromptReference,
  RewindAction,
  RewindCheckpoint,
  RewindResult
} from '../types.js'
import { CommandMenu } from './command-menu.js'
import { Divider } from './divider.js'
import { FileReferenceMenu } from './file-reference-menu.js'
import { ReferenceBar } from './reference-bar.js'
import { RewindPanel } from './rewind-panel.js'
import { ShortcutPanel } from './shortcut-panel.js'

interface EditorSnapshot {
  cursor: number
  references: PromptReference[]
  value: string
}

interface PromptHistoryEntry {
  references: PromptReference[]
  value: string
}

// Classic mode intentionally moves completed messages into Ink's <Static> tree. Some Ink
// versions remount the dynamic input subtree while committing static output, so multi-press
// deadlines must outlive a PromptInput component instance.
let lastCtrlCAt = 0
let lastEscapeAt = 0

// Bracketed paste (DECSET 2004) markers. Ink strips one leading ESC from the chunk it
// hands to useInput, so the ESC prefix is optional. A large paste spans several stdin
// chunks: only the first carries the start marker and only the last the end marker.
// eslint-disable-next-line no-control-regex -- ESC is the paste marker prefix
const PASTE_START = /(?:\u001B)?\[200~/u
// eslint-disable-next-line no-control-regex -- ESC is the paste marker prefix
const PASTE_END = /(?:\u001B)?\[201~/u

function sanitizePastedText(text: string): string {
  return (
    text
      .replace(/\r\n?/gu, '\n')
      // eslint-disable-next-line no-control-regex -- stripping escape sequences is the point
      .replace(/\u001B\[[0-9;?]*[A-Za-z~]/gu, '')
      // eslint-disable-next-line no-control-regex -- filtering raw control bytes is the point
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/gu, '')
  )
}

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
  onReferencesChange(references: PromptReference[]): void
  onRewind(
    checkpointId: string,
    action: RewindAction,
    instructions: string | undefined,
    signal: AbortSignal
  ): Promise<RewindResult>
  onSearchFiles(query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]>
  onSubmit(value: string, images: PromptImageAttachment[], references: PromptReference[]): void
  onToggleDetails(): void
  onToggleHelp(): void
  onToggleTasks(): void
  showHelp: boolean
  supportsVision: boolean
  references: PromptReference[]
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
  onReferencesChange,
  onRewind,
  onSearchFiles,
  onSubmit,
  onToggleDetails,
  onToggleHelp,
  onToggleTasks,
  showHelp,
  supportsVision,
  references: initialReferences,
  width
}: PromptInputProps): React.JSX.Element {
  const initialEditor: EditorSnapshot = {
    value: initialValue,
    cursor: graphemes(initialValue).length,
    references: initialReferences
  }
  const [editor, setEditor] = useState<EditorSnapshot>(initialEditor)
  const editorRef = useRef<EditorSnapshot>(initialEditor)
  const { value, cursor, references } = editor
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [menuSuppressed, setMenuSuppressed] = useState(false)
  const [rewindOpen, setRewindOpen] = useState(false)
  const [readingClipboard, setReadingClipboard] = useState(false)
  const [fileSearchResults, setFileSearchResults] = useState<FileReferenceCandidate[]>([])
  const [fileSearchLoading, setFileSearchLoading] = useState(false)
  const [fileSearchError, setFileSearchError] = useState<string>()
  const historyRef = useRef<PromptHistoryEntry[]>([])
  const historyIndexRef = useRef<number | null>(null)
  const killRingRef = useRef<string[]>([])
  const stashRef = useRef<EditorSnapshot | null>(null)
  const undoRef = useRef<EditorSnapshot[]>([])
  const pasteBufferRef = useRef<string | null>(null)
  const characters = useMemo(() => graphemes(value), [value])
  const menuOpen = value.startsWith('/') && !value.includes(' ') && !menuSuppressed
  const activeFileMention = useMemo(() => findFileReferenceMention(value, cursor), [cursor, value])
  const fileMenuOpen = Boolean(activeFileMention) && !menuSuppressed
  const commands = useMemo(() => (menuOpen ? findCommands(value) : []), [menuOpen, value])

  useEffect(() => setSelectedIndex(0), [value])
  useEffect(() => {
    if (!active) setRewindOpen(false)
  }, [active])

  useEffect(() => {
    if (!active || !fileMenuOpen || !activeFileMention) {
      setFileSearchResults([])
      setFileSearchLoading(false)
      setFileSearchError(undefined)
      return
    }

    const controller = new AbortController()
    const timer = setTimeout(() => {
      setFileSearchLoading(true)
      setFileSearchError(undefined)
      void onSearchFiles(activeFileMention.query, controller.signal)
        .then((results) => {
          if (controller.signal.aborted) return
          setFileSearchResults(results)
          setSelectedIndex(0)
        })
        .catch((error) => {
          if (controller.signal.aborted) return
          setFileSearchResults([])
          setFileSearchError(error instanceof Error ? error.message : String(error))
        })
        .finally(() => {
          if (!controller.signal.aborted) setFileSearchLoading(false)
        })
    }, 120)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [active, activeFileMention, fileMenuOpen, onSearchFiles])

  const mutate = (
    nextValue: string,
    nextCursor: number,
    nextReferences: PromptReference[] = editorRef.current.references
  ): void => {
    undoRef.current.push(editorRef.current)
    if (undoRef.current.length > 100) undoRef.current.shift()
    const previousReferences = editorRef.current.references
    const nextEditor = { value: nextValue, cursor: nextCursor, references: nextReferences }
    editorRef.current = nextEditor
    setEditor(nextEditor)
    if (nextReferences !== previousReferences) onReferencesChange(nextReferences)
    setMenuSuppressed(false)
    historyIndexRef.current = null
  }

  const replaceRange = (
    start: number,
    end: number,
    replacement: string,
    nextReferences: PromptReference[] = editorRef.current.references
  ): void => {
    const currentCharacters = graphemes(editorRef.current.value)
    const replacementCharacters = graphemes(replacement)
    const next = [
      ...currentCharacters.slice(0, start),
      ...replacementCharacters,
      ...currentCharacters.slice(end)
    ]
    mutate(next.join(''), start + replacementCharacters.length, nextReferences)
  }

  const moveCursor = (nextCursor: number): void => {
    const nextEditor = { ...editorRef.current, cursor: nextCursor }
    editorRef.current = nextEditor
    setEditor(nextEditor)
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
    if (!trimmed && images.length === 0 && references.length === 0) return
    if ((images.length > 0 || references.length > 0) && trimmed.startsWith('/')) {
      onNotice('Remove attached images and references before running a CLI command')
      return
    }
    if (images.length > 0 && !supportsVision) {
      onNotice('Current model does not support image input · choose a vision model with Alt-P')
      return
    }
    const previousHistory = historyRef.current.at(-1)
    const referenceSignature = references.map((reference) => reference.path).join('\n')
    const previousSignature = previousHistory?.references
      .map((reference) => reference.path)
      .join('\n')
    if (
      (trimmed || references.length > 0) &&
      (previousHistory?.value !== submission || previousSignature !== referenceSignature)
    ) {
      historyRef.current.push({ value: submission, references: [...references] })
    }
    historyIndexRef.current = null
    undoRef.current = []
    const nextEditor: EditorSnapshot = { value: '', cursor: 0, references: [] }
    editorRef.current = nextEditor
    setEditor(nextEditor)
    setMenuSuppressed(false)
    const submittedImages = images
    const submittedReferences = references
    onImagesChange([])
    onReferencesChange([])
    if (trimmed.toLowerCase() === '/rewind') {
      openRewind()
      return
    }
    onSubmit(
      trimmed ||
        (submittedImages.length > 0 && submittedReferences.length > 0
          ? 'Analyze the referenced files and attached images.'
          : submittedReferences.length > 0
            ? 'Analyze the referenced files.'
            : 'Analyze the attached image.'),
      submittedImages,
      submittedReferences
    )
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
    const historical = historyRef.current[next]
    if (!historical) return
    const nextEditor: EditorSnapshot = {
      value: historical.value,
      cursor: graphemes(historical.value).length,
      references: [...historical.references]
    }
    editorRef.current = nextEditor
    setEditor(nextEditor)
    onReferencesChange(nextEditor.references)
    setMenuSuppressed(true)
  }

  const insertFileReference = (candidate: FileReferenceCandidate): void => {
    const currentEditor = editorRef.current
    const mention = findFileReferenceMention(currentEditor.value, currentEditor.cursor)
    if (!mention) return
    const added = addPromptFileReference(currentEditor.references, candidate)
    if (!added.reference) {
      onNotice(`A prompt can include up to ${MAX_PROMPT_FILE_REFERENCES} file references`)
      return
    }

    const currentCharacters = graphemes(currentEditor.value)
    const nextCharacter = currentCharacters[mention.end]
    const suffix = nextCharacter === undefined || /\s/u.test(nextCharacter) ? '' : ' '
    const referenceText = createFileReferenceMarkdown(added.reference.path, added.reference.name)
    replaceRange(mention.start, mention.end, `${referenceText}${suffix}`, added.references)
    onNotice(`Referenced ${added.reference.path}`)
  }

  useInput(
    (input, key) => {
      const currentEditor = editorRef.current
      const currentValue = currentEditor.value
      const currentCursor = currentEditor.cursor
      const currentReferences = currentEditor.references
      const currentCharacters = graphemes(currentValue)

      // Bracketed paste frames take priority over every key binding: while a paste is
      // open, each chunk belongs to the paste until the end marker arrives, so control
      // characters inside pasted content can never trigger shortcuts.
      if (pasteBufferRef.current !== null) {
        const endMatch = PASTE_END.exec(input)
        if (!endMatch) {
          pasteBufferRef.current += input
          return
        }
        const pasted = sanitizePastedText(pasteBufferRef.current + input.slice(0, endMatch.index))
        pasteBufferRef.current = null
        if (!isRunning && pasted) replaceRange(currentCursor, currentCursor, pasted)
        return
      }
      const pasteStart = PASTE_START.exec(input)
      if (pasteStart) {
        const afterStart = input.slice(pasteStart.index + pasteStart[0].length)
        const pasteEnd = PASTE_END.exec(afterStart)
        if (!pasteEnd) {
          pasteBufferRef.current = afterStart
          return
        }
        const pasted = sanitizePastedText(afterStart.slice(0, pasteEnd.index))
        if (!isRunning && pasted) replaceRange(currentCursor, currentCursor, pasted)
        return
      }

      // SGR mouse reports are consumed by the app-level handler; never insert them as text.
      if (containsMouseSequence(input)) return

      const rawCtrlCCount = input.split('\u0003').length - 1
      const rawEscapeCount = input.split('\u001b').length - 1
      if ((key.ctrl && input === 'c') || rawCtrlCCount > 0) {
        if (isRunning) {
          lastCtrlCAt = 0
          onAbort()
          return
        }
        if (currentValue || images.length > 0 || currentReferences.length > 0) {
          lastCtrlCAt = 0
          if (currentValue || currentReferences.length > 0) mutate('', 0, [])
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

      if (matchesKey('redraw', input, key) || input === '\u000c') {
        onRedraw()
        return
      }

      if (matchesKey('toggleDetails', input, key)) {
        onToggleDetails()
        return
      }
      if (matchesKey('toggleTasks', input, key)) {
        onToggleTasks()
        return
      }

      // Keep the prompt focused so Ctrl-C can cancel the active Worker turn, but
      // do not let ordinary editing or submission race the in-flight run.
      if (isRunning) return
      if (!key.escape) lastEscapeAt = 0

      if (matchesKey('pasteImage', input, key) || input === '\u0016') {
        pasteClipboardImage()
        return
      }

      if (matchesKey('stashPrompt', input, key)) {
        if (currentValue || currentReferences.length > 0) {
          stashRef.current = currentEditor
          mutate('', 0, [])
          onNotice('Prompt stashed · Ctrl-S to restore')
        } else if (stashRef.current) {
          const stash = stashRef.current
          mutate(stash.value, stash.cursor, stash.references)
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
      if (matchesKey('undo', input, key)) {
        const previous = undoRef.current.pop()
        if (previous) {
          editorRef.current = previous
          setEditor(previous)
          onReferencesChange(previous.references)
        }
        return
      }

      if (matchesKey('cycleMode', input, key)) {
        onCycleMode()
        return
      }
      if (matchesKey('openModel', input, key)) {
        onOpenModel()
        return
      }

      if (fileMenuOpen) {
        if (key.upArrow) {
          setSelectedIndex((current) =>
            fileSearchResults.length === 0
              ? 0
              : (current - 1 + fileSearchResults.length) % fileSearchResults.length
          )
          return
        }
        if (key.downArrow) {
          setSelectedIndex((current) =>
            fileSearchResults.length === 0 ? 0 : (current + 1) % fileSearchResults.length
          )
          return
        }
        if ((key.tab || key.return) && fileSearchLoading) return
        if (key.tab || (key.return && fileSearchResults.length > 0)) {
          const selected = fileSearchResults[selectedIndex]
          if (selected) insertFileReference(selected)
          return
        }
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
        if (menuOpen || fileMenuOpen) {
          setMenuSuppressed(true)
          lastEscapeAt = 0
          return
        }
        const now = Date.now()
        if (rawEscapeCount > 1 || now - lastEscapeAt < 3_000) {
          lastEscapeAt = 0
          if (currentValue || images.length > 0 || currentReferences.length > 0) {
            const previousHistory = historyRef.current.at(-1)
            if (
              currentValue &&
              (previousHistory?.value !== currentValue ||
                previousHistory.references !== currentReferences)
            ) {
              historyRef.current.push({
                value: currentValue,
                references: [...currentReferences]
              })
            }
            mutate('', 0, [])
            onImagesChange([])
            onNotice(
              currentValue
                ? 'Prompt cleared · ↑ to restore'
                : currentReferences.length > 0
                  ? 'File references cleared'
                  : 'Image attachments cleared'
            )
          } else {
            openRewind()
          }
        } else {
          lastEscapeAt = now
          onNotice(
            currentValue || images.length > 0 || currentReferences.length > 0
              ? 'Press Esc again to clear'
              : 'Press Esc again to rewind'
          )
        }
        return
      }

      if (
        input === '?' &&
        currentValue.length === 0 &&
        images.length === 0 &&
        currentReferences.length === 0
      ) {
        onToggleHelp()
        return
      }

      if (key.leftArrow) {
        if (
          currentCharacters.length === 0 &&
          images.length === 0 &&
          currentReferences.length === 0
        ) {
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
        } else if (currentCharacters.length === 0 && currentReferences.length > 0) {
          mutate('', 0, currentReferences.slice(0, -1))
          onNotice(t('cli.prompt.removedFileReference', 'Removed last file reference'))
        } else if (currentCharacters.length === 0 && images.length > 0) {
          onImagesChange((current) => current.slice(0, -1))
          onNotice(t('cli.prompt.removedImage', 'Removed last image'))
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
      <Box flexWrap="wrap" minHeight={1}>
        <Text bold color={value.startsWith('!') ? theme.warning : theme.primary}>
          ❯{' '}
        </Text>
        <Text color={theme.text} wrap="wrap">
          {beforeCursor}
        </Text>
        <Text bold color={theme.primary}>
          ▏
        </Text>
        <Text color={theme.text} wrap="wrap">
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
                ? t('cli.prompt.readingClipboard', 'Images {{count}} · Reading clipboard image…', {
                    count: images.length
                  })
                : `${t('cli.prompt.images', 'Images {{count}}', { count: images.length })} · ${images
                    .map((image) => `${image.name} (${formatImageSize(image.size)})`)
                    .join(
                      ' · '
                    )} · ${t('cli.prompt.removeLastImage', 'Backspace on empty removes last')}`,
              Math.max(1, width - 4)
            )}
          </Text>
        </Box>
      ) : null}
      <ReferenceBar references={references} width={width} />
      <Divider width={width} />
      {rewindOpen ? (
        <RewindPanel
          loadCheckpoints={onListRewindCheckpoints}
          maxVisible={7}
          onCancel={() => setRewindOpen(false)}
          onComplete={(result) => {
            if (result.restoredPrompt !== undefined) {
              onImagesChange(result.restoredImages ?? [])
              const restoredReferences = result.restoredReferences ?? []
              const nextCursor = graphemes(result.restoredPrompt).length
              mutate(result.restoredPrompt, nextCursor, restoredReferences)
            }
            setRewindOpen(false)
          }}
          onExecute={onRewind}
          width={width}
        />
      ) : fileMenuOpen ? (
        <FileReferenceMenu
          error={fileSearchError}
          loading={fileSearchLoading}
          results={fileSearchResults}
          selectedIndex={selectedIndex}
          width={width}
        />
      ) : menuOpen ? (
        <CommandMenu commands={commands} selectedIndex={selectedIndex} width={width} />
      ) : null}
      {showHelp && !rewindOpen ? <ShortcutPanel width={width} /> : null}
    </Box>
  )
}
