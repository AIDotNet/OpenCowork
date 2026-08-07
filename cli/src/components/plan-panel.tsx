import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { fitText, graphemes, hasTerminalInputControl, wrapText } from '../lib/text.js'
import { theme } from '../theme.js'
import type { PlanApprovalMode, PlanSnapshot } from '../types.js'

interface PlanPanelProps {
  plan: PlanSnapshot
  width: number
  maxVisibleLines: number
  isRunning: boolean
  onAbort(): void
  onApprove(mode: PlanApprovalMode): void
  onNotice(message: string): void
  onRevise(feedback: string): void
}

type PanelMode = 'review' | 'feedback'

function statusLabel(status: PlanSnapshot['status']): string {
  switch (status) {
    case 'awaiting_review':
      return 'Awaiting review'
    case 'implementing':
      return 'Implementing'
    case 'completed':
      return 'Completed'
    case 'rejected':
      return 'Revision requested'
    case 'approved':
      return 'Approved'
    default:
      return 'Drafting'
  }
}

function statusColor(status: PlanSnapshot['status']): string {
  if (status === 'awaiting_review') return theme.warning
  if (status === 'implementing' || status === 'approved') return theme.accent
  if (status === 'completed') return theme.success
  if (status === 'rejected') return theme.error
  return theme.primary
}

export function PlanPanel({
  plan,
  width,
  maxVisibleLines,
  isRunning,
  onAbort,
  onApprove,
  onNotice,
  onRevise
}: PlanPanelProps): React.JSX.Element {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [offset, setOffset] = useState(0)
  const [mode, setMode] = useState<PanelMode>('review')
  const [feedback, setFeedback] = useState('')
  const [cursor, setCursor] = useState(0)

  const reviewOptions = useMemo(
    () => [
      {
        label: 'Yes, auto-accept edits',
        action: 'approve' as const,
        approval: 'acceptEdits' as const
      },
      {
        label: 'Yes, manually approve edits',
        action: 'approve' as const,
        approval: 'manual' as const
      },
      { label: 'No, keep planning', action: 'revise' as const }
    ],
    []
  )
  const contentLines = useMemo(
    () => wrapText(plan.content ?? '', Math.max(24, width - 10)),
    [plan.content, width]
  )
  const visibleLines = contentLines.slice(offset, offset + Math.max(4, maxVisibleLines))
  const canReview = plan.status === 'awaiting_review' && !isRunning

  useEffect(() => {
    setSelectedIndex(0)
    setOffset(0)
    setMode('review')
    setFeedback('')
    setCursor(0)
  }, [plan.id, plan.status])

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onAbort()
      return
    }
    if (key.ctrl && input === 'g') {
      onNotice(
        plan.filePath ? `Plan file: ${plan.filePath}` : 'The plan is stored in the Worker session.'
      )
      return
    }

    if (mode === 'feedback') {
      if (key.escape) {
        setMode('review')
        return
      }
      if (key.return) {
        const value = feedback.trim()
        if (!value) {
          onNotice('Add feedback so the Worker can revise the plan')
          return
        }
        onRevise(value)
        return
      }
      if (key.leftArrow) {
        setCursor((current) => Math.max(0, current - 1))
        return
      }
      if (key.rightArrow) {
        setCursor((current) => Math.min(graphemes(feedback).length, current + 1))
        return
      }
      if (key.backspace || key.delete) {
        const characters = graphemes(feedback)
        if (cursor === 0) return
        setFeedback([...characters.slice(0, cursor - 1), ...characters.slice(cursor)].join(''))
        setCursor(cursor - 1)
        return
      }
      if (!key.ctrl && !key.meta && input && !hasTerminalInputControl(input)) {
        const characters = graphemes(feedback)
        setFeedback([...characters.slice(0, cursor), input, ...characters.slice(cursor)].join(''))
        setCursor(cursor + graphemes(input).length)
      }
      return
    }

    if (key.pageUp) {
      setOffset((current) => Math.max(0, current - Math.max(3, maxVisibleLines - 2)))
      return
    }
    if (key.pageDown) {
      setOffset((current) =>
        Math.min(
          Math.max(0, contentLines.length - maxVisibleLines),
          current + Math.max(3, maxVisibleLines - 2)
        )
      )
      return
    }
    if (key.upArrow) {
      if (canReview) {
        setSelectedIndex((current) => (current <= 0 ? reviewOptions.length - 1 : current - 1))
      } else {
        setOffset((current) => Math.max(0, current - 1))
      }
      return
    }
    if (key.downArrow) {
      if (canReview) {
        setSelectedIndex((current) => (current + 1) % reviewOptions.length)
      } else {
        setOffset((current) =>
          Math.min(Math.max(0, contentLines.length - maxVisibleLines), current + 1)
        )
      }
      return
    }
    if (key.escape) {
      onNotice('Plan review stays open until you approve or provide feedback')
      return
    }
    if (key.return && canReview) {
      const option = reviewOptions[selectedIndex]
      if (!option) return
      if (option.action === 'revise') setMode('feedback')
      else onApprove(option.approval)
    }
  })

  return (
    <Box
      borderColor={statusColor(plan.status)}
      borderStyle="round"
      flexDirection="column"
      marginTop={1}
      paddingX={2}
      paddingY={1}
      width={width}
    >
      <Box justifyContent="space-between">
        <Text bold color={theme.primary}>
          Plan review
        </Text>
        <Text color={statusColor(plan.status)}>● {statusLabel(plan.status)}</Text>
      </Box>
      <Box marginTop={1}>
        <Text bold color={theme.text}>
          {fitText(plan.title, Math.max(18, width - 32))}
        </Text>
      </Box>
      {plan.filePath ? (
        <Text color={theme.dim} wrap="truncate-end">
          Plan file: {plan.filePath}
        </Text>
      ) : null}

      {plan.status === 'drafting' || isRunning ? (
        <Box marginTop={1}>
          <Text color={theme.warning}>
            The Native Worker is researching and drafting this plan…
          </Text>
        </Box>
      ) : null}

      {plan.content ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.dim}>Plan content</Text>
          <Box flexDirection="column" height={Math.max(4, maxVisibleLines)} overflow="hidden">
            {visibleLines.map((line, index) => (
              <Text key={`${offset + index}-${line}`} color={theme.text}>
                {line || ' '}
              </Text>
            ))}
          </Box>
          {contentLines.length > maxVisibleLines ? (
            <Text color={theme.dim}>
              {offset + 1}–{Math.min(contentLines.length, offset + maxVisibleLines)} of{' '}
              {contentLines.length} lines · PgUp/PgDn
            </Text>
          ) : null}
        </Box>
      ) : null}

      {mode === 'feedback' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.warning}>What should change?</Text>
          <Text color={theme.primary}>{feedback || ' '}▏</Text>
          <Text color={theme.dim}>Enter to request a revision · Esc to go back</Text>
        </Box>
      ) : plan.status === 'awaiting_review' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.dim}>Choose how OpenCowork should continue</Text>
          {reviewOptions.map((option, index) => {
            const selected = selectedIndex === index
            return (
              <Box key={option.label}>
                <Text color={selected ? theme.primary : theme.dim}>{selected ? '❯' : ' '} </Text>
                <Text bold={selected} color={selected ? theme.text : theme.muted}>
                  {option.label}
                </Text>
              </Box>
            )
          })}
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={theme.dim}>
          {mode === 'feedback'
            ? 'Text entry'
            : plan.status === 'awaiting_review'
              ? '↑↓ choose · Enter confirm · Ctrl-G show file · Ctrl-C interrupt'
              : 'Ctrl-G show plan file · Ctrl-C interrupt'}
        </Text>
      </Box>
    </Box>
  )
}
