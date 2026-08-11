import React from 'react'
import { Box, Text } from 'ink'
import { fitText } from '../lib/text.js'
import { theme } from '../theme.js'
import type { PromptReference } from '../types.js'

export function ReferenceBar({
  references,
  width
}: {
  references: PromptReference[]
  width: number
}): React.JSX.Element | null {
  if (references.length === 0) return null
  const label = references.map((reference) => `@${reference.path}`).join(' · ')

  return (
    <Box paddingX={2} width={width}>
      <Text color={theme.muted}>
        <Text color={theme.primary}>References {references.length}</Text>
        {' · '}
        {fitText(`${label} · Backspace on empty removes last`, Math.max(1, width - 18))}
      </Text>
    </Box>
  )
}
