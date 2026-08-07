import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { fitText } from '../lib/text.js'
import { theme } from '../theme.js'

const modelOptions = [
  { label: 'Auto', description: 'Recommended model for the current task' },
  { label: 'Sonnet', description: 'Fast and capable for everyday coding' },
  { label: 'Opus', description: 'Most capable for complex, long-running work' },
  { label: 'Haiku', description: 'Fastest for simple or mechanical tasks' }
]

interface ModelPickerProps {
  current: string
  onCancel(): void
  onSelect(model: string): void
  width: number
}

export function ModelPicker({
  current,
  onCancel,
  onSelect,
  width
}: ModelPickerProps): React.JSX.Element {
  const initialIndex = Math.max(0, modelOptions.findIndex(({ label }) => label === current))
  const [selectedIndex, setSelectedIndex] = useState(initialIndex)

  useInput((_input, key) => {
    if (key.escape) onCancel()
    if (key.upArrow) {
      setSelectedIndex((currentIndex) =>
        currentIndex === 0 ? modelOptions.length - 1 : currentIndex - 1
      )
    }
    if (key.downArrow) {
      setSelectedIndex((currentIndex) => (currentIndex + 1) % modelOptions.length)
    }
    if (key.return) onSelect(modelOptions[selectedIndex]?.label ?? 'Auto')
  })

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={2} width={width}>
      <Text bold>Select model</Text>
      <Text color={theme.muted}>Choose a model for this session.</Text>
      <Box flexDirection="column" marginTop={1}>
        {modelOptions.map((option, index) => {
          const selected = index === selectedIndex
          return (
            <Box key={option.label}>
              <Text color={selected ? theme.primary : theme.dim}>{selected ? '❯' : ' '} </Text>
              <Text bold={selected}>{option.label}</Text>
              <Text color={theme.muted}>
                {'  '}{fitText(option.description, Math.max(8, width - option.label.length - 8))}
              </Text>
            </Box>
          )
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>Enter to confirm · Esc to cancel</Text>
      </Box>
    </Box>
  )
}
