import React from 'react'
import { Box, Text } from 'ink'
import { fitText } from '../lib/text.js'
import { permissionModeLabels, theme } from '../theme.js'
import type { PermissionMode } from '../types.js'

interface StatusLineProps {
  effort: string
  model: string
  mode: PermissionMode
  notice?: string
  width: number
}

export function StatusLine({
  effort,
  model,
  mode,
  notice,
  width
}: StatusLineProps): React.JSX.Element {
  const left = notice ?? (width >= 58 ? '? for shortcuts · ← for agents' : '? shortcuts')
  const contentWidth = Math.max(12, width - 4)
  const right = fitText(
    `${model} · ${permissionModeLabels[mode]} · ${effort}`,
    Math.max(12, Math.floor(contentWidth * 0.62))
  )
  const leftWidth = Math.max(6, contentWidth - right.length - 2)

  return (
    <Box justifyContent="space-between" paddingX={2} width={width}>
      <Text color={notice ? theme.warning : theme.dim}>{fitText(left, leftWidth)}</Text>
      <Text color={theme.muted}>
        <Text color={mode === 'plan' ? theme.accent : theme.primary}>●</Text> {right}
      </Text>
    </Box>
  )
}
