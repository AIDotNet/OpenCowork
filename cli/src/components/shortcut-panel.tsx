import React from 'react'
import { Box, Text } from 'ink'
import { t } from '../i18n.js'
import { fitText, padText } from '../lib/text.js'
import { theme } from '../theme.js'

const groups = [
  [
    ['/', 'cli.shortcuts.commands', 'commands'],
    ['@', 'cli.shortcuts.files', 'reference workspace files'],
    ['/provider', 'cli.shortcuts.provider', 'configure provider'],
    ['/config', 'cli.shortcuts.config', 'shared settings'],
    ['/compact', 'cli.shortcuts.compact', 'compress context'],
    ['/context', 'cli.shortcuts.context', 'context usage']
  ],
  [
    ['esc esc', 'cli.shortcuts.rewind', 'rewind conversation turns'],
    ['shift + tab', 'cli.shortcuts.modes', 'cycle modes · enter / leave Plan'],
    ['ctrl + o', 'cli.shortcuts.details', 'expand thinking / tools'],
    ['ctrl + t', 'cli.shortcuts.tasks', 'toggle tasks']
  ],
  [
    ['alt + p', 'cli.shortcuts.model', 'switch model'],
    ['ctrl + v', 'cli.shortcuts.image', 'paste clipboard image'],
    ['ctrl + s', 'cli.shortcuts.stash', 'stash prompt'],
    ['ctrl + c', 'cli.shortcuts.cancel', 'cancel / exit'],
    ['empty ←', 'cli.shortcuts.agents', 'inspect agents']
  ]
]

function ShortcutGroup({ group, width }: { group: string[][]; width: number }): React.JSX.Element {
  const keyWidth = Math.min(12, Math.max(7, Math.floor(width * 0.38)))
  const descriptionWidth = Math.max(4, width - keyWidth - 1)

  return (
    <Box flexDirection="column" width={width}>
      {group.map(([key, descriptionKey, defaultDescription]) => (
        <Text key={key} color={theme.muted}>
          <Text color={theme.text}>{padText(key ?? '', keyWidth)}</Text>{' '}
          {fitText(t(descriptionKey ?? '', defaultDescription ?? ''), descriptionWidth)}
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
