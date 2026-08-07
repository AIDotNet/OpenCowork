import React from 'react'
import { Text } from 'ink'
import { theme } from '../theme.js'

export function Divider({ width }: { width: number }): React.JSX.Element {
  return <Text color={theme.border}>{'─'.repeat(Math.max(1, width))}</Text>
}
