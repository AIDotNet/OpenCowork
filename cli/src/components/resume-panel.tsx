import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { t } from '../i18n.js'
import { fitText, hasTerminalInputControl } from '../lib/text.js'
import { theme } from '../theme.js'
import type { ResumeResult, ResumeSessionSummary } from '../types.js'

interface ResumePanelProps {
  loadSessions(signal: AbortSignal): Promise<ResumeSessionSummary[]>
  maxVisible: number
  onCancel(): void
  onComplete(result: ResumeResult): void
  onResume(sessionId: string, signal: AbortSignal): Promise<ResumeResult>
  width: number
}

function formatRelativeTime(updatedAt: number): string {
  const elapsed = Math.max(0, Date.now() - updatedAt)
  const seconds = Math.max(1, Math.round(elapsed / 1_000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(updatedAt)
  )
}

function sessionMatches(session: ResumeSessionSummary, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return true
  return [
    session.id,
    session.title,
    session.providerId ?? '',
    session.modelId ?? '',
    session.workingFolder
  ].some((value) => value.toLocaleLowerCase().includes(normalized))
}

function messageLabel(count: number): string {
  return `${count} message${count === 1 ? '' : 's'}`
}

export function ResumePanel({
  loadSessions,
  maxVisible,
  onCancel,
  onComplete,
  onResume,
  width
}: ResumePanelProps): React.JSX.Element {
  const [sessions, setSessions] = useState<ResumeSessionSummary[]>([])
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [reloadRevision, setReloadRevision] = useState(0)
  const abortControllerRef = useRef<AbortController>()
  const loadSessionsRef = useRef(loadSessions)
  loadSessionsRef.current = loadSessions
  const contentWidth = Math.max(24, width - 4)
  const matches = useMemo(
    () => sessions.filter((session) => sessionMatches(session, query)),
    [query, sessions]
  )
  const selectedSession = matches[selectedIndex]

  useEffect(() => {
    const controller = new AbortController()
    abortControllerRef.current = controller
    setLoading(true)
    setError(undefined)
    void loadSessionsRef
      .current(controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) return
        setSessions(loaded)
        setSelectedIndex(0)
      })
      .catch((loadError) => {
        if (controller.signal.aborted) return
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [reloadRevision])

  useEffect(() => {
    setSelectedIndex((index) => Math.max(0, Math.min(index, matches.length - 1)))
  }, [matches.length])

  const execute = (): void => {
    if (!selectedSession || busy || loading) return
    const controller = new AbortController()
    abortControllerRef.current = controller
    setBusy(true)
    setError(undefined)
    void onResume(selectedSession.id, controller.signal)
      .then(onComplete)
      .catch((resumeError) => {
        if (!controller.signal.aborted) {
          setError(resumeError instanceof Error ? resumeError.message : String(resumeError))
        }
      })
      .finally(() => {
        if (abortControllerRef.current === controller) abortControllerRef.current = undefined
        setBusy(false)
      })
  }

  useInput((input, key) => {
    if (busy) {
      if (key.escape || (key.ctrl && input === 'c')) abortControllerRef.current?.abort()
      return
    }
    if (key.escape || (key.ctrl && input === 'c')) {
      abortControllerRef.current?.abort()
      onCancel()
      return
    }
    if (loading) return
    if (error && input.toLocaleLowerCase() === 'r') {
      setReloadRevision((current) => current + 1)
      return
    }
    if (key.upArrow || (!query && input === 'k')) {
      setSelectedIndex((index) =>
        matches.length === 0 ? 0 : index <= 0 ? matches.length - 1 : index - 1
      )
      return
    }
    if (key.downArrow || (!query && input === 'j')) {
      setSelectedIndex((index) => (matches.length === 0 ? 0 : (index + 1) % matches.length))
      return
    }
    if (key.return) {
      execute()
      return
    }
    if (key.ctrl && input === 'u') {
      setQuery('')
      setSelectedIndex(0)
      return
    }
    if (key.backspace || key.delete) {
      setQuery((value) => Array.from(value).slice(0, -1).join(''))
      setSelectedIndex(0)
      setError(undefined)
      return
    }
    if (!key.ctrl && !key.meta && input && !hasTerminalInputControl(input)) {
      setQuery((value) => value + input)
      setSelectedIndex(0)
      setError(undefined)
    }
  })

  const visibleCount = Math.max(3, maxVisible)
  const windowStart = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(visibleCount / 2), matches.length - visibleCount)
  )
  const visibleSessions = matches.slice(windowStart, windowStart + visibleCount)
  const queryText = query ? `${query}▏` : '▏'

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} width={width}>
      <Text bold>{t('cli.panels.resume', 'Resume session')}</Text>
      <Text color={theme.muted}>
        {fitText(
          t('cli.resume.description', 'Restore a completed CLI conversation from this workspace'),
          contentWidth
        )}
      </Text>
      <Box marginTop={1}>
        <Text color={theme.dim}>{t('cli.common.search', 'Search')} </Text>
        <Text color={query ? theme.text : theme.primary}>{queryText}</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {loading ? (
          <Text color={theme.muted}>
            {t('cli.panels.loadingSessions', 'Loading resumable sessions…')}
          </Text>
        ) : null}
        {!loading && sessions.length === 0 ? (
          <Text color={theme.muted}>
            {t(
              'cli.resume.noSessions',
              'No completed OpenCowork CLI sessions are available for this workspace.'
            )}
          </Text>
        ) : null}
        {!loading && sessions.length > 0 && matches.length === 0 ? (
          <Text color={theme.muted}>
            {t('cli.resume.noMatches', 'No sessions match “{{query}}”.', {
              query: fitText(query, Math.max(8, contentWidth - 20))
            })}
          </Text>
        ) : null}
        {!loading
          ? visibleSessions.map((session, visibleIndex) => {
              const index = windowStart + visibleIndex
              const selected = index === selectedIndex
              const model = session.modelId
                ? session.providerId
                  ? `${session.providerId}/${session.modelId}`
                  : session.modelId
                : 'model unavailable'
              const metadata = `${formatRelativeTime(session.updatedAt)} · ${messageLabel(session.messageCount)} · ${model}`
              const sessionLabel =
                session.title === 'OpenCowork CLI'
                  ? `${session.title} · ${session.id.slice(-8)}`
                  : session.title
              return (
                <Box flexDirection="column" key={session.id}>
                  <Text bold={selected} color={selected ? theme.primary : undefined}>
                    {selected ? '❯' : ' '} {fitText(sessionLabel, Math.max(1, contentWidth - 2))}
                  </Text>
                  <Text color={theme.muted}>
                    {'    '}
                    {fitText(metadata, Math.max(1, contentWidth - 4))}
                  </Text>
                </Box>
              )
            })
          : null}
      </Box>

      <Box marginTop={1}>
        <Text color={error ? theme.error : theme.dim}>
          {error
            ? `${fitText(error, Math.max(8, contentWidth - 10))} · R retry`
            : busy
              ? t('cli.resume.resuming', 'Resuming session… · Esc interrupt')
              : `${matches.length > visibleSessions.length ? `${windowStart + 1}–${windowStart + visibleSessions.length} of ${matches.length} · ` : ''}${t('cli.resume.footer', 'Type to search · ↑↓ navigate · Enter resume · Esc cancel')}`}
        </Text>
      </Box>
    </Box>
  )
}
