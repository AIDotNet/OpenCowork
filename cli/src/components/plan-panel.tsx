import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { t } from '../i18n.js'
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
  onCycleMode(): void
  onNotice(message: string): void
  onRevise(feedback: string): void
}

type PanelMode = 'review' | 'feedback'

function statusLabel(status: PlanSnapshot['status']): string {
  switch (status) {
    case 'awaiting_review':
      return t('cli.plan.awaitingReview', 'Awaiting review')
    case 'implementing':
      return t('cli.plan.implementing', 'Implementing')
    case 'completed':
      return t('cli.plan.completed', 'Completed')
    case 'rejected':
      return t('cli.plan.revisionRequested', 'Revision requested')
    case 'approved':
      return t('cli.plan.approved', 'Approved')
    default:
      return t('cli.plan.drafting', 'Drafting')
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
  onCycleMode,
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
        label: t('cli.plan.autoAccept', 'Yes, auto-accept edits'),
        action: 'approve' as const,
        approval: 'acceptEdits' as const
      },
      {
        label: t('cli.plan.manualApprove', 'Yes, manually approve edits'),
        action: 'approve' as const,
        approval: 'manual' as const
      },
      { label: t('cli.plan.keepPlanning', 'No, keep planning'), action: 'revise' as const }
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
    if (key.tab && key.shift) {
      onCycleMode()
      return
    }
    if (key.ctrl && input === 'c') {
      onAbort()
      return
    }
    if (key.ctrl && input === 'g') {
      onNotice(
        plan.filePath
          ? t('cli.plan.file', 'Plan file: {{path}}', { path: plan.filePath })
          : t('cli.plan.storedInWorker', 'The plan is stored in the Worker session.')
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
          onNotice(t('cli.plan.addFeedback', 'Add feedback so the Worker can revise the plan'))
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
      onNotice(
        t(
          'cli.plan.reviewStaysOpen',
          'Plan review stays open until you approve or provide feedback'
        )
      )
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
        <Text bold color={statusColor(plan.status)}>
          {t('cli.plan.mode', 'PLAN MODE')}
        </Text>
        <Text color={statusColor(plan.status)}>● {statusLabel(plan.status)}</Text>
      </Box>
      <Text color={theme.muted}>
        {width >= 64
          ? t('cli.plan.planningFirst', 'Planning first · implementation waits for your approval')
          : t('cli.plan.approvalRequired', 'Planning · approval required')}
      </Text>
      <Box marginTop={1}>
        <Text bold color={theme.text}>
          {fitText(plan.title, Math.max(18, width - 32))}
        </Text>
      </Box>
      {plan.filePath ? (
        <Text color={theme.dim} wrap="truncate-end">
          {t('cli.plan.file', 'Plan file: {{path}}', { path: plan.filePath })}
        </Text>
      ) : null}

      {plan.status === 'drafting' || isRunning ? (
        <Box marginTop={1}>
          <Text color={theme.warning}>
            {t('cli.plan.researching', 'The Native Worker is researching and drafting this plan…')}
          </Text>
        </Box>
      ) : null}

      {plan.content ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={theme.accent}>
            {t('cli.panels.plan', 'Plan')}
          </Text>
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
          <Text color={theme.warning}>{t('cli.plan.whatChange', 'What should change?')}</Text>
          <Text color={theme.primary}>{feedback || ' '}▏</Text>
          <Text color={theme.dim}>
            {t('cli.plan.feedbackFooter', 'Enter to request a revision · Esc to go back')}
          </Text>
        </Box>
      ) : plan.status === 'awaiting_review' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.dim}>
            {t('cli.plan.chooseContinue', 'Choose how OpenCowork should continue')}
          </Text>
          {reviewOptions.map((option, index) => {
            const selected = selectedIndex === index
            return (
              <Box key={option.label}>
                <Text
                  backgroundColor={selected ? theme.selectedBackground : undefined}
                  bold={selected}
                  color={selected ? theme.selectedText : theme.muted}
                >
                  {selected ? '❯ ' : '  '}
                  {option.label}
                  {selected ? ' ' : ''}
                </Text>
              </Box>
            )
          })}
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={1}>
        {mode === 'feedback' ? null : (
          <Text color={theme.dim}>
            {plan.status === 'awaiting_review'
              ? width >= 48
                ? t(
                    'cli.plan.reviewFooterWide',
                    '↑↓ choose · Enter confirm · Ctrl-G show file · Ctrl-C interrupt'
                  )
                : t('cli.plan.reviewFooterShort', '↑↓ choose · Enter confirm')
              : width >= 48
                ? t('cli.plan.draftFooter', 'Ctrl-G show plan file · Ctrl-C interrupt')
                : t('cli.plan.interrupt', 'Ctrl-C interrupt')}
          </Text>
        )}
        <Text bold color={theme.accent}>
          {t('cli.plan.cycle', 'Shift+Tab cycle · exit Plan')}
        </Text>
      </Box>
    </Box>
  )
}
