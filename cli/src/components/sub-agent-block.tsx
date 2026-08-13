import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import stringWidth from 'string-width'
import { t } from '../i18n.js'
import {
  formatActivityLine,
  formatElapsedDuration,
  isOpenSubAgentPhase,
  layoutSubAgentRow,
  summarizeSubAgentGroup,
  type SubAgentToolMessage
} from '../lib/sub-agent-display.js'
import { fitText } from '../lib/text.js'
import { theme } from '../theme.js'
import type { SubAgentDisplay, SubAgentPhase } from '../types.js'

function statusLabel(phase: SubAgentPhase): string {
  if (phase === 'completed') return t('cli.transcript.completed', 'Completed')
  if (phase === 'error') return t('cli.transcript.failed', 'Failed')
  if (phase === 'queued') return t('cli.transcript.queued', 'Queued')
  if (phase === 'starting') return t('cli.transcript.starting', 'Starting')
  return t('cli.transcript.running', 'Running')
}

function statusColor(phase: SubAgentPhase): string {
  if (phase === 'completed') return theme.success
  if (phase === 'error') return theme.error
  if (phase === 'queued' || phase === 'starting') return theme.warning
  return theme.accent
}

function headerColor(agents: SubAgentDisplay[]): string {
  if (agents.some((agent) => isOpenSubAgentPhase(agent.phase))) return theme.accent
  if (agents.some((agent) => agent.phase === 'error')) return theme.error
  return theme.success
}

function headerLabel(agents: SubAgentDisplay[], now: number): { elapsed: string; text: string } {
  const summary = summarizeSubAgentGroup(agents, now)
  const elapsed = formatElapsedDuration(summary.elapsedMs)
  if (summary.active) {
    const text =
      summary.total === 1
        ? t(
            'cli.transcript.runningAgent',
            'Running 1 agent ({{done}} done, {{running}} running)',
            { done: summary.done, running: summary.running }
          )
        : t(
            'cli.transcript.runningAgents',
            'Running {{count}} agents ({{done}} done, {{running}} running)',
            { count: summary.total, done: summary.done, running: summary.running }
          )
    return { elapsed, text }
  }
  const text =
    summary.total === 1
      ? t('cli.transcript.ranAgent', 'Ran 1 agent')
      : t('cli.transcript.ranAgents', 'Ran {{count}} agents', { count: summary.total })
  return { elapsed, text }
}

function SubAgentRow({
  agent,
  now,
  width
}: {
  agent: SubAgentDisplay
  now: number
  width: number
}): React.JSX.Element {
  const layout = layoutSubAgentRow(agent, width, statusLabel(agent.phase), now)
  return (
    <Box>
      <Text color={theme.dim}>{layout.branch}</Text>
      <Text color={theme.accent}>{layout.name}</Text>
      {layout.description ? <Text color={theme.muted}>{layout.description}</Text> : null}
      {layout.meta ? <Text color={theme.dim}>{layout.meta}</Text> : null}
      <Text color={statusColor(agent.phase)}>{layout.status}</Text>
    </Box>
  )
}

export function SubAgentBlock({
  expandedIds,
  messages,
  showDetails,
  width
}: {
  expandedIds?: ReadonlySet<string>
  messages: SubAgentToolMessage[]
  showDetails: boolean
  width: number
}): React.JSX.Element | null {
  const agents = messages.map((message) => message.subAgent)
  const live = agents.some((agent) => isOpenSubAgentPhase(agent.phase))
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [live])

  if (messages.length === 0) return null

  const header = headerLabel(agents, now)
  const color = headerColor(agents)
  const elapsedText = ` · ${header.elapsed}`
  const titleWidth = Math.max(8, width - 2 - stringWidth(elapsedText))

  return (
    <Box flexDirection="column" marginTop={1} width={width}>
      <Box>
        <Text bold color={color}>
          ●
        </Text>
        <Text color={color}> {fitText(header.text, titleWidth)}</Text>
        <Text color={theme.dim}>{elapsedText}</Text>
      </Box>
      {messages.map((message) => {
        const agent = message.subAgent
        const detailed = showDetails || (expandedIds?.has(message.id) ?? false)
        const report = agent.report?.trim()
        return (
          <Box flexDirection="column" key={message.id}>
            <SubAgentRow agent={agent} now={now} width={width} />
            {isOpenSubAgentPhase(agent.phase) && agent.currentActivity ? (
              <Text color={theme.dim}>{formatActivityLine(agent.currentActivity, width)}</Text>
            ) : null}
            {detailed && report ? (
              <Box marginLeft={7} width={Math.max(8, width - 7)}>
                <Text color={theme.dim} wrap="wrap">
                  {report}
                </Text>
              </Box>
            ) : null}
          </Box>
        )
      })}
    </Box>
  )
}
