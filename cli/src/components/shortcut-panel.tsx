import React from 'react'
import { Box, Text } from 'ink'
import { fitText, padText } from '../lib/text.js'
import { theme } from '../theme.js'

const groups = [
  [
    ['!', 'shell mode'],
    ['/', 'commands'],
    ['@', 'file paths'],
    ['/btw', 'side question']
  ],
  [
    ['double esc', 'clear / rewind'],
    ['shift + tab', 'permission mode'],
    ['ctrl + o', 'verbose output'],
    ['ctrl + t', 'toggle tasks']
  ],
  [
    ['alt + p', 'switch model'],
    ['ctrl + s', 'stash prompt'],
    ['ctrl + z', 'suspend'],
    ['/keybindings', 'customize']
  ]
]

function ShortcutGroup({ group, width }: { group: string[][]; width: number }): React.JSX.Element {
  const keyWidth = Math.min(12, Math.max(7, Math.floor(width * 0.38)))
  const descriptionWidth = Math.max(4, width - keyWidth - 1)

  return (
    <Box flexDirection="column" width={width}>
      {group.map(([key, description]) => (
        <Text key={key} color={theme.muted}>
          <Text color={theme.text}>{padText(key ?? '', keyWidth)}</Text>{' '}
          {fitText(description ?? '', descriptionWidth)}
        </Text>
      ))}
    </Box>
  )
}

export function ShortcutPanel({ width }: { width: number }): React.JSX.Element {
  const columnCount = width >= 76 ? 3 : width >= 50 ? 2 : 1
  const gap = 2
  const columnWidth = Math.floor((width - 4 - gap * (columnCount - 1)) / columnCount)

  return (
    <Box gap={gap} paddingX={2} paddingY={1} width={width}>
      {groups.slice(0, columnCount).map((group, index) => (
        <ShortcutGroup group={group} key={index} width={columnWidth} />
      ))}
    </Box>
  )
}
