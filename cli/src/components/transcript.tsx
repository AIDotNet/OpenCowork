import React from 'react'
import { Box, Text } from 'ink'
import { formatTokenCount } from '../lib/metrics.js'
import { fitText } from '../lib/text.js'
import { theme } from '../theme.js'
import type { AssistantContentSegment, Message } from '../types.js'
import { Spinner } from './spinner.js'

interface TranscriptProps {
  messages: Message[]
  showDetails: boolean
  width: number
}

function toneColor(tone: Extract<Message, { kind: 'system' }>['tone']): string {
  if (tone === 'warning') return theme.warning
  if (tone === 'error') return theme.error
  if (tone === 'success') return theme.success
  return theme.muted
}

function formatThinkingDuration(
  segment: Extract<AssistantContentSegment, { kind: 'thinking' }>
): string {
  if (segment.completedAt === undefined) return 'Thinking…'
  const seconds = Math.max(1, Math.round((segment.completedAt - segment.startedAt) / 1_000))
  return `Thought for ${seconds}s`
}

function thinkingLabel(
  segment: Extract<AssistantContentSegment, { kind: 'thinking' }>,
  reasoningTokens: number | undefined,
  showDetails: boolean,
  width: number
): string {
  if (!segment.traceAvailable) {
    const tokens = reasoningTokens && reasoningTokens > 0 ? formatTokenCount(reasoningTokens) : null
    const full = `Thought${tokens ? ` · ${tokens} tokens` : ''} · trace not exposed`
    const compact = `Thought${tokens ? ` · ${tokens}` : ''} · no trace`
    return fitText(full.length <= width ? full : compact, width)
  }

  const completed = formatThinkingDuration(segment)
  if (segment.completedAt === undefined || showDetails) return fitText(completed, width)
  const full = `${completed} (ctrl+o to expand)`
  const compact = `${completed.replace(' for ', ' ')} · ctrl+o`
  return fitText(full.length <= width ? full : compact, width)
}

function TranscriptMessage({
  message,
  showDetails,
  width
}: {
  message: Message
  showDetails: boolean
  width: number
}): React.JSX.Element {
  if (message.kind === 'user') {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text bold color={theme.primary}>
            ❯{' '}
          </Text>
          <Text bold wrap="wrap">
            {message.text}
          </Text>
        </Box>
        {message.images && message.images.length > 0 ? (
          <Box marginLeft={2}>
            <Text color={theme.muted}>
              ▣{' '}
              {fitText(
                message.images
                  .map((image) => `${image.name} (${formatImageSize(image.size)})`)
                  .join(' · '),
                Math.max(8, width - 4)
              )}
            </Text>
          </Box>
        ) : null}
      </Box>
    )
  }

  if (message.kind === 'assistant') {
    const segments: AssistantContentSegment[] =
      message.segments && message.segments.length > 0
        ? message.segments
        : message.text
          ? [{ kind: 'text', text: message.text }]
          : []

    return (
      <Box flexDirection="column" marginTop={1}>
        {segments.length === 0 && message.streaming ? (
          <Box>
            <Spinner />
            <Text color={theme.muted} italic>
              {' '}
              Thinking…
            </Text>
          </Box>
        ) : null}
        {segments.map((segment, index) => {
          const active = message.streaming && index === segments.length - 1
          if (segment.kind === 'thinking') {
            return (
              <Box flexDirection="column" key={`${message.id}-thinking-${index}`}>
                <Box>
                  {active ? (
                    <Spinner />
                  ) : (
                    <Text bold color={theme.primary}>
                      ✻
                    </Text>
                  )}
                  <Text color={theme.muted} italic>
                    {' '}
                    {thinkingLabel(
                      segment,
                      message.reasoningTokens,
                      showDetails,
                      Math.max(8, width - 2)
                    )}
                  </Text>
                </Box>
                {showDetails && segment.traceAvailable && segment.text.trim() ? (
                  <Box marginLeft={2}>
                    <Text color={theme.dim} italic wrap="wrap">
                      {segment.text.trim()}
                    </Text>
                  </Box>
                ) : null}
              </Box>
            )
          }

          return (
            <Box key={`${message.id}-text-${index}`}>
              {active ? (
                <Spinner />
              ) : (
                <Text bold color={theme.primary}>
                  ●
                </Text>
              )}
              <Text> {segment.text}</Text>
            </Box>
          )
        })}
        {showDetails && (message.model || message.timestamp) ? (
          <Box marginLeft={2}>
            <Text color={theme.dim}>
              {[message.model, message.timestamp].filter(Boolean).join(' · ')}
            </Text>
          </Box>
        ) : null}
      </Box>
    )
  }

  if (message.kind === 'tool') {
    const statusColor =
      message.status === 'error'
        ? theme.error
        : message.status === 'success'
          ? theme.success
          : theme.primary

    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          {message.status === 'running' ? (
            <Spinner />
          ) : (
            <Text bold color={statusColor}>
              {message.status === 'error' ? '●' : '●'}
            </Text>
          )}
          <Text bold> {fitText(message.title, Math.max(10, width - 4))}</Text>
        </Box>
        {message.summary ? (
          <Box marginLeft={2}>
            <Text color={message.status === 'error' ? theme.error : theme.muted}>
              ⎿ {fitText(message.summary, Math.max(8, width - 6))}
            </Text>
          </Box>
        ) : null}
        {showDetails && message.detail ? (
          <Box marginLeft={5}>
            <Text color={theme.dim} wrap="wrap">
              {message.detail}
            </Text>
          </Box>
        ) : null}
      </Box>
    )
  }

  return (
    <Box marginTop={1} marginLeft={2}>
      <Text color={toneColor(message.tone)}>⎿ {message.text}</Text>
    </Box>
  )
}

function formatImageSize(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(size / 1024))} KB`
}

export function Transcript({ messages, showDetails, width }: TranscriptProps): React.JSX.Element {
  return (
    <Box flexDirection="column" width={width}>
      {messages.map((message) => (
        <TranscriptMessage
          key={message.id}
          message={message}
          showDetails={showDetails}
          width={width}
        />
      ))}
    </Box>
  )
}
