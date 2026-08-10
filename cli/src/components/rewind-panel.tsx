import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { fitText } from '../lib/text.js'
import { theme } from '../theme.js'
import type { RewindAction, RewindCheckpoint, RewindResult } from '../types.js'

interface RewindPanelProps {
  loadCheckpoints(): Promise<RewindCheckpoint[]>
  maxVisible: number
  onCancel(): void
  onComplete(result: RewindResult): void
  onExecute(
    checkpointId: string,
    action: RewindAction,
    instructions: string | undefined,
    signal: AbortSignal
  ): Promise<RewindResult>
  width: number
}

interface RewindActionEntry {
  action: Extract<RewindAction, 'restore-code-and-conversation' | 'restore-conversation'> | 'cancel'
  compactLabel: string
  disabled?: boolean
  label: string
}

function normalizePrompt(prompt: string): string {
  return prompt.replace(/\s+/gu, ' ').trim() || '(empty prompt)'
}

function formatRelativeTime(createdAt: number): string {
  const elapsed = Math.max(0, Date.now() - createdAt)
  const seconds = Math.max(1, Math.round(elapsed / 1_000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function codeChangeLabel(checkpoint: RewindCheckpoint): string {
  if (checkpoint.changedFileCount === 0) return 'No code changes'
  return `${checkpoint.changedFileCount} file${checkpoint.changedFileCount === 1 ? '' : 's'} changed`
}

function actionEntries(checkpoint: RewindCheckpoint): RewindActionEntry[] {
  return [
    {
      action: 'restore-conversation',
      compactLabel: 'Conversation only',
      label: 'Restore conversation only'
    },
    {
      action: 'restore-code-and-conversation',
      compactLabel: 'Conversation + changes',
      disabled: !checkpoint.codeRestoreAvailable,
      label: 'Restore conversation and tracked changes'
    },
    { action: 'cancel', compactLabel: 'Cancel', label: 'Cancel' }
  ]
}

export function RewindPanel({
  loadCheckpoints,
  maxVisible,
  onCancel,
  onComplete,
  onExecute,
  width
}: RewindPanelProps): React.JSX.Element {
  const [checkpoints, setCheckpoints] = useState<RewindCheckpoint[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [stage, setStage] = useState<'list' | 'confirm'>('list')
  const [selectedActionIndex, setSelectedActionIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [reloadRevision, setReloadRevision] = useState(0)
  const abortControllerRef = useRef<AbortController>()
  const loadCheckpointsRef = useRef(loadCheckpoints)
  loadCheckpointsRef.current = loadCheckpoints
  const contentWidth = Math.max(24, width - 4)
  const totalEntries = checkpoints.length + 1
  const selectedCheckpoint = selectedIndex < checkpoints.length ? checkpoints[selectedIndex] : null
  const actions = useMemo(
    () => (selectedCheckpoint ? actionEntries(selectedCheckpoint) : []),
    [selectedCheckpoint]
  )
  const selectedAction = actions[selectedActionIndex]

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(undefined)
    void loadCheckpointsRef
      .current()
      .then((loaded) => {
        if (cancelled) return
        setCheckpoints(loaded)
        setSelectedIndex(loaded.length)
      })
      .catch((loadError) => {
        if (cancelled) return
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      abortControllerRef.current?.abort()
    }
  }, [reloadRevision])

  useEffect(() => {
    setSelectedActionIndex(0)
    setError(undefined)
  }, [selectedCheckpoint?.id])

  const execute = (entry: RewindActionEntry | undefined): void => {
    if (!entry || !selectedCheckpoint || busy) return
    if (entry.action === 'cancel') {
      onCancel()
      return
    }
    if (entry.disabled) {
      setError(
        'No reversible tracked changes are available here. Restore the conversation only or cancel.'
      )
      return
    }
    const controller = new AbortController()
    abortControllerRef.current = controller
    setBusy(true)
    setError(undefined)
    void onExecute(selectedCheckpoint.id, entry.action, undefined, controller.signal)
      .then(onComplete)
      .catch((executeError) => {
        if (!controller.signal.aborted) {
          setError(executeError instanceof Error ? executeError.message : String(executeError))
        }
      })
      .finally(() => {
        abortControllerRef.current = undefined
        setBusy(false)
      })
  }

  useInput((input, key) => {
    if (busy) {
      if (key.escape || (key.ctrl && input === 'c')) abortControllerRef.current?.abort()
      return
    }
    if (key.escape || (key.ctrl && input === 'c')) {
      if (stage === 'confirm') {
        setStage('list')
        setError(undefined)
      } else {
        onCancel()
      }
      return
    }
    if (loading) return
    if (error && stage === 'list' && input.toLowerCase() === 'r') {
      setReloadRevision((current) => current + 1)
      return
    }

    if (stage === 'list') {
      if (key.upArrow || input === 'k') {
        setSelectedIndex((current) => Math.max(0, current - 1))
        return
      }
      if (key.downArrow || input === 'j') {
        setSelectedIndex((current) => Math.min(totalEntries - 1, current + 1))
        return
      }
      if (key.return) {
        if (selectedCheckpoint) setStage('confirm')
        else onCancel()
      }
      return
    }

    if (/^[1-9]$/u.test(input)) {
      const numbered = actions[Number(input) - 1]
      if (numbered) execute(numbered)
      return
    }
    if (key.upArrow || input === 'k') {
      setError(undefined)
      setSelectedActionIndex((current) => Math.max(0, current - 1))
      return
    }
    if (key.downArrow || input === 'j') {
      setError(undefined)
      setSelectedActionIndex((current) => Math.min(actions.length - 1, current + 1))
      return
    }
    if (key.return) {
      execute(selectedAction)
    }
  })

  if (stage === 'confirm' && selectedCheckpoint) {
    const action = selectedAction?.action
    const conversationStatus =
      action === 'cancel'
        ? 'Rewind will close without changing the conversation.'
        : 'A new conversation branch will be created before this message.'
    const codeStatus =
      action === 'restore-code-and-conversation'
        ? selectedCheckpoint.codeRestoreAvailable
          ? `${codeChangeLabel(selectedCheckpoint)} will be restored. External side effects cannot be undone.`
          : 'No reversible tracked changes are available at this point.'
        : action === 'restore-conversation'
          ? 'Tracked files and external side effects will be unchanged.'
          : 'No changes will be made.'

    return (
      <Box flexDirection="column" paddingX={2} paddingY={1} width={width}>
        <Text bold>{fitText('Choose how to rewind to before this message:', contentWidth)}</Text>
        <Box marginTop={1}>
          <Text color={theme.dim}>│ </Text>
          <Text>{fitText(normalizePrompt(selectedCheckpoint.prompt), contentWidth - 2)}</Text>
        </Box>
        <Text color={theme.dim}>│ ({formatRelativeTime(selectedCheckpoint.createdAt)})</Text>
        <Box flexDirection="column" marginTop={1}>
          <Text>{fitText(conversationStatus, contentWidth)}</Text>
          <Text>{fitText(codeStatus, contentWidth)}</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {actions.map((entry, index) => {
            const isSelected = index === selectedActionIndex
            const compact = contentWidth < 64
            const label = `${index + 1}. ${compact ? entry.compactLabel : entry.label}${entry.disabled ? (compact ? ' N/A' : ' (unavailable)') : ''}`
            return (
              <Text
                key={entry.action}
                bold={isSelected}
                color={entry.disabled ? theme.dim : isSelected ? theme.primary : undefined}
              >
                {isSelected ? '❯' : ' '} {fitText(label, Math.max(1, contentWidth - 2))}
              </Text>
            )
          })}
        </Box>
        <Box marginTop={1}>
          <Text color={error ? theme.error : theme.dim}>
            {error
              ? fitText(error, contentWidth)
              : busy
                ? 'Working… · Esc interrupt'
                : '↑↓/jk navigate · Enter select · 1-3 quick select · Esc back'}
          </Text>
        </Box>
      </Box>
    )
  }

  const visibleCount = Math.max(2, maxVisible)
  const windowStart = Math.max(
    0,
    Math.min(selectedIndex - visibleCount + 1, totalEntries - visibleCount)
  )
  const visibleCheckpoints = checkpoints.slice(
    windowStart,
    Math.min(checkpoints.length, windowStart + visibleCount)
  )
  const currentVisible =
    checkpoints.length >= windowStart && checkpoints.length < windowStart + visibleCount

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} width={width}>
      <Text bold>Rewind</Text>
      <Text color={theme.muted}>
        {fitText('Select a previous conversation turn to restore', contentWidth)}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {loading ? <Text color={theme.muted}>Loading conversation checkpoints…</Text> : null}
        {!loading && checkpoints.length === 0 ? (
          <Text color={theme.muted}>No messages to rewind.</Text>
        ) : null}
        {!loading
          ? visibleCheckpoints.map((checkpoint, visibleIndex) => {
              const index = windowStart + visibleIndex
              const isSelected = index === selectedIndex
              const turnsBack = checkpoints.length - index
              const metadata = `${turnsBack} turn${turnsBack === 1 ? '' : 's'} back · ${formatRelativeTime(checkpoint.createdAt)} · ${codeChangeLabel(checkpoint)}`
              return (
                <Box flexDirection="column" key={checkpoint.id}>
                  <Text bold={isSelected} color={isSelected ? theme.primary : undefined}>
                    {isSelected ? '❯' : ' '}{' '}
                    {fitText(normalizePrompt(checkpoint.prompt), contentWidth - 2)}
                  </Text>
                  <Text color={checkpoint.codeRestoreAvailable ? theme.muted : theme.dim}>
                    {'    '}
                    {fitText(metadata, Math.max(1, contentWidth - 4))}
                  </Text>
                </Box>
              )
            })
          : null}
        {!loading && checkpoints.length > 0 && currentVisible ? (
          <Text
            bold={selectedIndex === checkpoints.length}
            color={selectedIndex === checkpoints.length ? theme.primary : undefined}
          >
            {selectedIndex === checkpoints.length ? '❯' : ' '} (current)
          </Text>
        ) : null}
      </Box>
      <Box marginTop={1}>
        <Text color={error ? theme.error : theme.dim}>
          {error
            ? `${fitText(error, Math.max(8, contentWidth - 10))} · R retry`
            : '↑↓/jk choose turn · Enter continue · Esc cancel'}
        </Text>
      </Box>
    </Box>
  )
}
