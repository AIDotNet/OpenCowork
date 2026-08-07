import path from 'node:path'
import React from 'react'
import { Box, Text } from 'ink'
import stringWidth from 'string-width'
import { fitText } from '../lib/text.js'
import { theme } from '../theme.js'

interface WelcomeCardProps {
  cwd: string
  model: string
  version: string
  width: number
}

function BorderLine({ title, width }: { title: string; width: number }): React.JSX.Element {
  const prefix = `╭─── ${title} `
  const available = Math.max(0, width - stringWidth(prefix) - 1)

  return (
    <Text color={theme.border}>
      {prefix}
      {'─'.repeat(available)}╮
    </Text>
  )
}

function Cell({
  children,
  width,
  align = 'left'
}: {
  children?: React.ReactNode
  width: number
  align?: 'left' | 'center'
}): React.JSX.Element {
  return (
    <Box paddingX={1} width={width} justifyContent={align === 'center' ? 'center' : 'flex-start'}>
      {children}
    </Box>
  )
}

export function WelcomeCard({
  cwd,
  model,
  version,
  width
}: WelcomeCardProps): React.JSX.Element {
  const cardWidth = Math.max(36, width)
  const wide = cardWidth >= 72
  const leftWidth = wide ? Math.floor((cardWidth - 3) * 0.62) : cardWidth - 2
  const rightWidth = wide ? cardWidth - 3 - leftWidth : 0
  const shortCwd = fitText(cwd, Math.max(12, leftWidth - 4))
  const project = path.basename(cwd) || cwd

  const leftRows: React.ReactNode[] = [
    null,
    <Text bold key="welcome">Welcome back!</Text>,
    null,
    <Text bold color={theme.primary} key="logo-1">▐▛███▜▌</Text>,
    <Text bold color={theme.primary} key="logo-2">▝▜ Co ▛▘</Text>,
    <Text bold color={theme.primary} key="logo-3"> ▘▘ ▝▝ </Text>,
    null,
    <Text color={theme.muted} key="model">{fitText(`${model} · OpenCowork Agent`, leftWidth - 4)}</Text>,
    <Text color={theme.dim} key="cwd">{shortCwd}</Text>
  ]

  const rightRows: React.ReactNode[] = [
    <Text bold key="tips-title">Tips for getting started</Text>,
    <Text color={theme.muted} key="tip-init">Run <Text color={theme.accent}>/init</Text> to create an AGENTS.md</Text>,
    <Text color={theme.border} key="right-divider">{'─'.repeat(Math.max(1, rightWidth - 4))}</Text>,
    <Text bold key="recent-title">Recent activity</Text>,
    <Text color={theme.muted} key="recent-value">No recent sessions in {fitText(project, 12)}</Text>,
    null,
    <Text color={theme.dim} key="tip-command">Type / for commands</Text>,
    <Text color={theme.dim} key="tip-files">Type @ to mention files</Text>,
    null
  ]

  return (
    <Box flexDirection="column" width={cardWidth}>
      <BorderLine title={`OpenCowork v${version}`} width={cardWidth} />
      {leftRows.map((left, index) => (
        <Box key={index} width={cardWidth}>
          <Text color={theme.border}>│</Text>
          <Cell align="center" width={leftWidth}>{left}</Cell>
          {wide ? (
            <>
              <Text color={theme.border}>│</Text>
              <Cell width={rightWidth}>{rightRows[index]}</Cell>
            </>
          ) : null}
          <Text color={theme.border}>│</Text>
        </Box>
      ))}
      <Text color={theme.border}>╰{'─'.repeat(cardWidth - 2)}╯</Text>
    </Box>
  )
}
