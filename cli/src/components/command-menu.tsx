import React from 'react'
import { Box, Text } from 'ink'
import type { SlashCommand } from '../commands.js'
import { fitText, padText } from '../lib/text.js'
import { theme } from '../theme.js'

interface CommandMenuProps {
  commands: SlashCommand[]
  selectedIndex: number
  width: number
}

export function CommandMenu({
  commands,
  selectedIndex,
  width
}: CommandMenuProps): React.JSX.Element {
  const visibleCount = 8
  const safeSelectedIndex = Math.max(0, Math.min(selectedIndex, commands.length - 1))
  const windowStart = Math.max(
    0,
    Math.min(safeSelectedIndex - Math.floor(visibleCount / 2), commands.length - visibleCount)
  )
  const visible = commands.slice(windowStart, windowStart + visibleCount)
  const nameWidth = Math.min(30, Math.max(16, Math.floor(width * 0.34)))
  const aboveCount = windowStart
  const belowCount = commands.length - windowStart - visible.length
  const overflowStatus = [
    aboveCount > 0 ? `↑ ${aboveCount} above` : '',
    belowCount > 0 ? `↓ ${belowCount} more` : ''
  ].filter(Boolean)

  if (visible.length === 0) {
    return (
      <Box paddingLeft={2}>
        <Text color={theme.dim}>No matching commands</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={width}>
      {visible.map((command, index) => {
        const absoluteIndex = windowStart + index
        const selected = absoluteIndex === safeSelectedIndex
        const line = `${padText(command.name, nameWidth)}${fitText(
          command.description,
          Math.max(8, width - nameWidth - 2)
        )}`

        return (
          <Box key={command.name} paddingLeft={selected ? 0 : 2}>
            {selected ? <Text color={theme.primary}>❯ </Text> : null}
            <Text
              backgroundColor={selected ? theme.selectedBackground : undefined}
              color={selected ? theme.selectedText : theme.text}
            >
              {line}
            </Text>
          </Box>
        )
      })}
      {overflowStatus.length > 0 ? (
        <Box paddingLeft={2}>
          <Text color={theme.dim}>{overflowStatus.join(' · ')}</Text>
        </Box>
      ) : null}
    </Box>
  )
}
