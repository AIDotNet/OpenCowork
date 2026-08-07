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
  const visible = commands.slice(0, 8)
  const nameWidth = Math.min(30, Math.max(16, Math.floor(width * 0.34)))

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
        const selected = index === selectedIndex
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
      {commands.length > visible.length ? (
        <Box paddingLeft={2}>
          <Text color={theme.dim}>↓ {commands.length - visible.length} more</Text>
        </Box>
      ) : null}
    </Box>
  )
}
