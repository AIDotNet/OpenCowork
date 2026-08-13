import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { theme } from '../theme.js'

// Every frame must occupy exactly one terminal cell. The previous star sequence mixed
// one- and two-cell glyphs, which made adjacent labels such as Thinking and Working jump.
const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function Spinner(): React.JSX.Element {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setFrame((current) => (current + 1) % frames.length), 160)
    return () => clearInterval(timer)
  }, [])

  return (
    <Box width={1}>
      <Text bold color={theme.primary}>
        {frames[frame]}
      </Text>
    </Box>
  )
}
