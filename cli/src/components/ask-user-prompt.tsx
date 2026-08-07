import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import {
  fitText,
  graphemes,
  hasTerminalInputControl,
  stripTerminalPreviewControls,
  wrapText
} from '../lib/text.js'
import { theme } from '../theme.js'
import type {
  AskUserAnswerPayload,
  AskUserAnnotation,
  AskUserQuestion,
  AskUserRequest
} from '../types.js'

interface AskUserPromptProps {
  request: AskUserRequest
  width: number
  onCancel(): void
  onNotice(message: string): void
  onSubmit(payload: AskUserAnswerPayload): void
}

type InputMode = 'options' | 'other' | 'notes' | 'submit'

function optionKey(label: string): string {
  return label.trim().toLocaleLowerCase()
}

function hasOther(question: AskUserQuestion): boolean {
  return question.options.some((option) => optionKey(option.label) === 'other')
}

function sanitizePreview(value: string | undefined): string {
  if (!value) return ''
  return stripTerminalPreviewControls(value).slice(0, 4_000)
}

function questionOptions(question: AskUserQuestion): AskUserQuestion['options'] {
  return hasOther(question) ? question.options : [...question.options, { label: 'Other' }]
}

function selectedLabels(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value
  return value ? [value] : []
}

function customOtherValue(question: AskUserQuestion, value: string | string[] | undefined): string {
  const knownLabels = new Set(questionOptions(question).map((option) => optionKey(option.label)))
  return (
    selectedLabels(value)
      .find((label) => !knownLabels.has(optionKey(label)))
      ?.trim() ?? ''
  )
}

function answerSummary(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(', ') : (value ?? '')
}

function hasAnswer(value: string | string[] | undefined): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value?.trim())
}

export function AskUserPrompt({
  request,
  width,
  onCancel,
  onNotice,
  onSubmit
}: AskUserPromptProps): React.JSX.Element {
  const [questionIndex, setQuestionIndex] = useState(0)
  const [mode, setMode] = useState<InputMode>('options')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({})
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [editor, setEditor] = useState('')
  const [editorCursor, setEditorCursor] = useState(0)
  const [editorTarget, setEditorTarget] = useState<number | null>(null)

  const question = request.questions[questionIndex]
  const options = useMemo(() => (question ? questionOptions(question) : []), [question])
  const selected = question ? (selections[String(questionIndex)] ?? []) : []
  const currentOption = options[selectedIndex]
  const preview = sanitizePreview(currentOption?.preview)
  const allAnswered = request.questions.every((_, index) => hasAnswer(answers[String(index)]))
  const inputWidth = Math.max(18, width - 8)

  useEffect(() => {
    setQuestionIndex(0)
    setMode('options')
    setSelectedIndex(0)
    setAnswers({})
    setSelections({})
    setNotes({})
    setEditor('')
    setEditorCursor(0)
    setEditorTarget(null)
  }, [request.id])

  useEffect(() => {
    if (!question) return
    const currentAnswer = answers[String(questionIndex)]
    const labels = selectedLabels(currentAnswer)
    const selectedOption = options.findIndex((option) => labels.includes(option.label))
    setSelectedIndex((index) =>
      Math.min(
        Math.max(0, selectedOption >= 0 ? selectedOption : index),
        Math.max(0, options.length - 1)
      )
    )
  }, [answers, options, question, questionIndex])

  const moveQuestion = (next: number): void => {
    const bounded = Math.max(0, Math.min(request.questions.length - 1, next))
    setQuestionIndex(bounded)
    setSelectedIndex(0)
    setMode('options')
  }

  const finishQuestion = (index: number): void => {
    if (index >= request.questions.length - 1) {
      setMode('submit')
    } else {
      moveQuestion(index + 1)
    }
  }

  const setQuestionAnswer = (index: number, value: string | string[]): void => {
    setAnswers((current) => ({ ...current, [String(index)]: value }))
  }

  const chooseSingle = (index: number, label: string): void => {
    setQuestionAnswer(index, label)
    setSelections((current) => ({ ...current, [String(index)]: [label] }))
    finishQuestion(index)
  }

  const toggleMulti = (index: number, label: string): void => {
    const key = String(index)
    const previous = selections[key] ?? []
    const next = previous.includes(label)
      ? previous.filter((value) => value !== label)
      : [...previous, label]
    setSelections((current) => ({ ...current, [key]: next }))
    setQuestionAnswer(index, next)
  }

  const beginEditor = (editorMode: 'other' | 'notes'): void => {
    setEditorTarget(questionIndex)
    const existing =
      editorMode === 'notes'
        ? (notes[String(questionIndex)] ?? '')
        : customOtherValue(question, answers[String(questionIndex)])
    setEditor(existing)
    setEditorCursor(graphemes(existing).length)
    setMode(editorMode)
  }

  const finishEditor = (): void => {
    const target = editorTarget
    if (target === null) return
    const value = editor.trim()
    if (mode === 'notes') {
      setNotes((current) => ({ ...current, [String(target)]: value }))
      setMode('options')
      setEditorTarget(null)
      return
    }
    if (!value) {
      onNotice('Other needs a short answer')
      return
    }
    const targetQuestion = request.questions[target]
    const previous = selections[String(target)] ?? []
    const existingOther = targetQuestion
      ? customOtherValue(targetQuestion, answers[String(target)])
      : ''
    const next = targetQuestion?.multiSelect
      ? [...previous.filter((item) => item !== existingOther), value]
      : [value]
    setSelections((current) => ({ ...current, [String(target)]: next }))
    setQuestionAnswer(target, targetQuestion?.multiSelect ? next : value)
    setMode('options')
    setEditorTarget(null)
    if (targetQuestion?.multiSelect) {
      setSelectedIndex(0)
    } else {
      finishQuestion(target)
    }
  }

  const submit = (): void => {
    if (!allAnswered) {
      onNotice('Answer every question before submitting')
      setMode('options')
      const firstMissing = request.questions.findIndex((_, index) => !answers[String(index)])
      if (firstMissing >= 0) moveQuestion(firstMissing)
      return
    }
    const annotations: Record<string, AskUserAnnotation> = {}
    for (const [key, value] of Object.entries(notes)) {
      if (value.trim()) annotations[key] = { notes: value.trim() }
    }
    for (const [key, labels] of Object.entries(selections)) {
      const option = request.questions[Number(key)]?.options.find(
        (item) => item.preview && labels.includes(item.label)
      )
      const preview = sanitizePreview(option?.preview)
      if (preview) annotations[key] = { ...annotations[key], preview }
    }
    onSubmit({
      answers,
      ...(Object.keys(annotations).length > 0 ? { annotations } : {})
    })
  }

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onCancel()
      return
    }

    if (mode === 'other' || mode === 'notes') {
      if (key.escape) {
        setMode('options')
        setEditorTarget(null)
        return
      }
      if (key.return) {
        finishEditor()
        return
      }
      if (key.leftArrow) {
        setEditorCursor((cursor) => Math.max(0, cursor - 1))
        return
      }
      if (key.rightArrow) {
        setEditorCursor((cursor) => Math.min(graphemes(editor).length, cursor + 1))
        return
      }
      if (key.backspace || key.delete) {
        const characters = graphemes(editor)
        if (editorCursor <= 0) return
        const next = [
          ...characters.slice(0, editorCursor - 1),
          ...characters.slice(editorCursor)
        ].join('')
        setEditor(next)
        setEditorCursor(editorCursor - 1)
        return
      }
      if (!key.ctrl && !key.meta && input && !hasTerminalInputControl(input)) {
        const characters = graphemes(editor)
        const next = [
          ...characters.slice(0, editorCursor),
          input,
          ...characters.slice(editorCursor)
        ].join('')
        setEditor(next)
        setEditorCursor(editorCursor + graphemes(input).length)
      }
      return
    }

    if (mode === 'submit') {
      if (key.escape) {
        setMode('options')
        return
      }
      if (key.return) submit()
      if (key.backspace || key.leftArrow) {
        moveQuestion(request.questions.length - 1)
      }
      return
    }

    if (!question) return
    if (key.leftArrow) {
      moveQuestion(questionIndex - 1)
      return
    }
    if (key.rightArrow) {
      if (!hasAnswer(answers[String(questionIndex)])) {
        onNotice('Answer this question before moving on')
      } else {
        moveQuestion(questionIndex + 1)
      }
      return
    }
    if (key.upArrow) {
      setSelectedIndex((index) => (index <= 0 ? options.length - 1 : index - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex((index) => (index + 1) % options.length)
      return
    }
    if (input.toLocaleLowerCase() === 'n') {
      beginEditor('notes')
      return
    }
    if (input === ' ' && question.multiSelect) {
      const option = currentOption
      if (option?.label === 'Other') beginEditor('other')
      else if (option) toggleMulti(questionIndex, option.label)
      return
    }
    if (key.return) {
      const option = currentOption
      if (!option) return
      if (option.label === 'Other') {
        beginEditor('other')
      } else if (question.multiSelect) {
        if (selected.length === 0) onNotice('Select at least one option with Space')
        else finishQuestion(questionIndex)
      } else {
        chooseSingle(questionIndex, option.label)
      }
    }
  })

  if (!question) return <Text color={theme.error}>Unable to render the user questions.</Text>

  const displayedPreview = preview || (mode === 'other' ? editor : '')
  const contentHeight = Math.max(6, Math.min(14, Math.floor((process.stdout.rows || 24) * 0.42)))
  const previewLines = displayedPreview ? wrapText(displayedPreview, Math.max(12, width - 18)) : []

  return (
    <Box
      borderColor={theme.accent}
      borderStyle="round"
      flexDirection="column"
      marginTop={1}
      paddingX={2}
      paddingY={1}
      width={width}
    >
      <Box justifyContent="space-between">
        <Text bold color={theme.primary}>
          OpenCowork needs your input
        </Text>
        <Text color={theme.dim}>
          Question {questionIndex + 1} of {request.questions.length}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.accent}>‹ </Text>
        <Text bold color={theme.text}>
          {fitText(question.header, 12)}
        </Text>
        <Text color={theme.accent}> ›</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.text} wrap="wrap">
          {question.question}
        </Text>
      </Box>

      {mode === 'other' || mode === 'notes' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.muted}>
            {mode === 'notes' ? 'Add a note (optional)' : 'Your answer'}
          </Text>
          <Text color={theme.primary}>{editor || ' '}▏</Text>
          <Text color={theme.dim}>Enter to save · Esc to return</Text>
        </Box>
      ) : mode === 'submit' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={theme.success}>
            Ready to submit
          </Text>
          {request.questions.map((item, index) => (
            <Box key={`${item.header}-${index}`} marginTop={index === 0 ? 1 : 0}>
              <Text color={theme.dim}>{item.header}: </Text>
              <Text color={theme.text}>
                {fitText(answerSummary(answers[String(index)]), inputWidth)}
              </Text>
            </Box>
          ))}
          <Text color={theme.dim}>Enter to submit · ← to review the last answer</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {options.map((option, index) => {
            const isSelected = index === selectedIndex
            const isChecked = selected.includes(option.label)
            return (
              <Box key={`${option.label}-${index}`} flexDirection="column">
                <Box>
                  <Text color={isSelected ? theme.primary : theme.dim}>
                    {isSelected ? '❯' : ' '}{' '}
                  </Text>
                  <Text color={question.multiSelect && isChecked ? theme.success : undefined}>
                    {question.multiSelect ? (isChecked ? '[x] ' : '[ ] ') : ''}
                  </Text>
                  <Text bold={isSelected} color={isSelected ? theme.text : theme.muted}>
                    {option.label}
                  </Text>
                </Box>
                {isSelected && option.description ? (
                  <Box marginLeft={4}>
                    <Text color={theme.dim} wrap="wrap">
                      {option.description}
                    </Text>
                  </Box>
                ) : null}
              </Box>
            )
          })}
          {displayedPreview ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.accent}>Preview</Text>
              {previewLines.slice(0, contentHeight).map((line, index) => (
                <Text key={`${line}-${index}`} color={theme.code}>
                  {line || ' '}
                </Text>
              ))}
              {previewLines.length > contentHeight ? <Text color={theme.dim}>… more</Text> : null}
            </Box>
          ) : null}
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={theme.dim}>
          {mode === 'other' || mode === 'notes'
            ? 'Text entry'
            : mode === 'submit'
              ? 'Enter submit · ← review'
              : question.multiSelect
                ? '↑↓ move · Space select · Enter confirm · N note · ←→ questions · Ctrl-C cancel'
                : '↑↓ move · Enter select · N note · ←→ questions · Ctrl-C cancel'}
        </Text>
      </Box>
    </Box>
  )
}
