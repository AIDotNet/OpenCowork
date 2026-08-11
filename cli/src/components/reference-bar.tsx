import React from 'react'
import { Box, Text } from 'ink'
import stringWidth from 'string-width'
import { t } from '../i18n.js'
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
  const count = t('cli.prompt.references', 'References {{count}}', { count: references.length })
  const contentWidth = Math.max(1, width - 4)
  const detailsWidth = Math.max(1, contentWidth - stringWidth(count) - 3)
  const help = `${label} · ${t('cli.prompt.removeLastReference', 'Backspace on empty removes last')}`
  const details = fitText(stringWidth(help) <= detailsWidth ? help : label, detailsWidth)

  return (
    <Box paddingX={2} width={width}>
      <Text color={theme.primary}>{count}</Text>
      <Text color={theme.muted}> · {details}</Text>
    </Box>
  )
}
