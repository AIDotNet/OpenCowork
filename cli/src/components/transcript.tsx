import React from 'react'
import { Box, Text } from 'ink'
import { fitText } from '../lib/text.js'
import { theme } from '../theme.js'
import type { Message } from '../types.js'
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
      <Box marginTop={1}>
        <Text bold color={theme.primary}>
          ❯{' '}
        </Text>
        <Text bold wrap="wrap">
          {message.text}
        </Text>
      </Box>
    )
  }

  if (message.kind === 'assistant') {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          {message.streaming ? (
            <Spinner />
          ) : (
            <Text bold color={theme.primary}>
              ●
            </Text>
          )}
          <Text> {message.text || (message.streaming ? 'Thinking…' : '')}</Text>
        </Box>
        {showDetails && message.thinking ? (
          <Box marginLeft={2}>
            <Text color={theme.dim} wrap="wrap">
              Thinking: {message.thinking}
            </Text>
          </Box>
        ) : null}
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
