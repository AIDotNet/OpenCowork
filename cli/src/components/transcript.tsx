import React from 'react'
import { Box, Text } from 'ink'
import { t } from '../i18n.js'
import { formatTokenCount } from '../lib/metrics.js'
import { fitText, padText, stripTerminalPreviewControls } from '../lib/text.js'
import { theme } from '../theme.js'
import type { AssistantContentSegment, Message, ToolDiff, ToolDiffLine } from '../types.js'
import { ShimmerText } from './shimmer-text.js'
import { Spinner } from './spinner.js'

interface TranscriptProps {
  hideStreamingStatus?: boolean
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
  if (segment.completedAt === undefined) return t('cli.statuses.thinking', 'Thinking…')
  const seconds = Math.max(1, Math.round((segment.completedAt - segment.startedAt) / 1_000))
  return t('cli.transcript.thoughtFor', 'Thought for {{seconds}}s', { seconds })
}

function thinkingLabel(
  segment: Extract<AssistantContentSegment, { kind: 'thinking' }>,
  reasoningTokens: number | undefined,
  showDetails: boolean,
  width: number
): string {
  if (!segment.traceAvailable) {
    const tokens = reasoningTokens && reasoningTokens > 0 ? formatTokenCount(reasoningTokens) : null
    const full = `${t('cli.transcript.thought', 'Thought')}${tokens ? ` · ${tokens} ${t('cli.metrics.tokens', 'tokens')}` : ''} · ${t('cli.transcript.traceNotExposed', 'trace not exposed')}`
    const compact = `${t('cli.transcript.thought', 'Thought')}${tokens ? ` · ${tokens}` : ''} · ${t('cli.transcript.noTrace', 'no trace')}`
    return fitText(full.length <= width ? full : compact, width)
  }

  const completed = formatThinkingDuration(segment)
  if (segment.completedAt === undefined || showDetails) return fitText(completed, width)
  const full = `${completed} (${t('cli.transcript.expandDetails', 'ctrl+o to expand')})`
  const compact = `${completed.replace(' for ', ' ')} · ctrl+o`
  return fitText(full.length <= width ? full : compact, width)
}

function diffRow(line: ToolDiffLine, width: number): string {
  const prefix = line.kind === 'removed' ? '- ' : line.kind === 'added' ? '+ ' : '  '
  const safeText = stripTerminalPreviewControls(line.text).replace(/\t/gu, '  ')
  return padText(`${prefix}${fitText(safeText, Math.max(1, width - 2))}`, width)
}

function ToolDiffBlock({ diff, width }: { diff: ToolDiff; width: number }): React.JSX.Element {
  const rowWidth = Math.max(8, width - 2)
  return (
    <Box flexDirection="column" marginLeft={2} width={rowWidth}>
      {diff.lines.map((line, index) => {
        const row = diffRow(line, rowWidth)
        if (line.kind === 'removed') {
          return (
            <Text backgroundColor={theme.removedBackground} color={theme.removed} key={index}>
              {row}
            </Text>
          )
        }
        if (line.kind === 'added') {
          return (
            <Text backgroundColor={theme.addedBackground} color={theme.added} key={index}>
              {row}
            </Text>
          )
        }
        return (
          <Text color={line.kind === 'meta' ? theme.muted : theme.dim} key={index}>
            {row}
          </Text>
        )
      })}
    </Box>
  )
}

function TranscriptMessage({
  hideStreamingStatus,
  message,
  showDetails,
  width
}: {
  hideStreamingStatus: boolean
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
          <Text bold color={theme.text} wrap="wrap">
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
        {message.references && message.references.length > 0 ? (
          <Box marginLeft={2}>
            <Text color={theme.muted}>
              ↳{' '}
              {fitText(
                message.references.map((reference) => `@${reference.path}`).join(' · '),
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
        {segments.length === 0 && message.streaming && !hideStreamingStatus ? (
          <Box>
            <Text bold color={theme.primary}>
              ✻
            </Text>
            <Text> </Text>
            <ShimmerText text={t('cli.statuses.thinking', 'Thinking…')} />
          </Box>
        ) : null}
        {segments.map((segment, index) => {
          const active = message.streaming && index === segments.length - 1
          if (segment.kind === 'thinking') {
            if (active && hideStreamingStatus) {
              return showDetails && segment.traceAvailable && segment.text.trim() ? (
                <Box marginLeft={2} key={`${message.id}-thinking-${index}`}>
                  <Text color={theme.dim} italic wrap="wrap">
                    {segment.text.trim()}
                  </Text>
                </Box>
              ) : null
            }
            return (
              <Box flexDirection="column" key={`${message.id}-thinking-${index}`}>
                <Box>
                  {active ? (
                    <Text bold color={theme.primary}>
                      ✻
                    </Text>
                  ) : (
                    <Text bold color={theme.primary}>
                      ✻
                    </Text>
                  )}
                  <Text> </Text>
                  {active ? (
                    <ShimmerText
                      text={thinkingLabel(
                        segment,
                        message.reasoningTokens,
                        showDetails,
                        Math.max(8, width - 2)
                      )}
                    />
                  ) : (
                    <Text color={theme.muted} italic>
                      {thinkingLabel(
                        segment,
                        message.reasoningTokens,
                        showDetails,
                        Math.max(8, width - 2)
                      )}
                    </Text>
                  )}
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
              {active && !hideStreamingStatus ? (
                <Spinner />
              ) : (
                <Text bold color={theme.primary}>
                  ●
                </Text>
              )}
              <Text color={theme.text}> {segment.text}</Text>
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
          {message.diff ? (
            <>
              <Text bold color={theme.text}>
                {' '}
                {fitText(
                  t('cli.transcript.edited', 'Edited {{path}}', { path: message.diff.path }),
                  Math.max(
                    8,
                    width - 3 - `(+${message.diff.additions} -${message.diff.deletions})`.length
                  )
                )}{' '}
              </Text>
              <Text color={theme.muted}>(</Text>
              <Text color={theme.added}>+{message.diff.additions}</Text>
              <Text color={theme.removed}> -{message.diff.deletions}</Text>
              <Text color={theme.muted}>)</Text>
            </>
          ) : (
            <Text bold color={theme.text}>
              {' '}
              {fitText(message.title, Math.max(10, width - 4))}
            </Text>
          )}
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
        {message.diff ? <ToolDiffBlock diff={message.diff} width={width} /> : null}
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

export function Transcript({
  hideStreamingStatus = false,
  messages,
  showDetails,
  width
}: TranscriptProps): React.JSX.Element {
  return (
    <Box flexDirection="column" width={width}>
      {messages.map((message) => (
        <TranscriptMessage
          key={message.id}
          hideStreamingStatus={hideStreamingStatus}
          message={message}
          showDetails={showDetails}
          width={width}
        />
      ))}
    </Box>
  )
}
