import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text } from 'ink'
import { graphemes } from '../lib/text.js'
import { theme } from '../theme.js'

// Keep decorative animation below the rate where terminal repaint becomes distracting.
const FRAME_INTERVAL_MS = 180
const EDGE_PADDING = 3

/** Terminal counterpart of the desktop live-output shimmer: color moves, text does not. */
export function ShimmerText({ text }: { text: string }): React.JSX.Element {
  const characters = useMemo(() => graphemes(text), [text])
  const [frame, setFrame] = useState(0)
  const cycleLength = Math.max(1, characters.length + EDGE_PADDING * 2)

  useEffect(() => {
    setFrame(0)
    const timer = setInterval(
      () => setFrame((current) => (current + 1) % cycleLength),
      FRAME_INTERVAL_MS
    )
    return () => clearInterval(timer)
  }, [cycleLength, text])

  const peak = frame - EDGE_PADDING
  return (
    <Box>
      {characters.map((character, index) => {
        const distance = Math.abs(index - peak)
        const color = distance === 0 ? theme.text : distance === 1 ? theme.primary : theme.muted
        return (
          <Text color={color} italic key={`${index}-${character}`}>
            {character}
          </Text>
        )
      })}
    </Box>
  )
}
