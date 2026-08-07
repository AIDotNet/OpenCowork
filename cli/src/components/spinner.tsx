import React, { useEffect, useState } from 'react'
import { Text } from 'ink'
import { theme } from '../theme.js'

const frames = ['·', '✢', '✳', '✶', '✻', '✽']

export function Spinner(): React.JSX.Element {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setFrame((current) => (current + 1) % frames.length), 90)
    return () => clearInterval(timer)
  }, [])

  return (
    <Text bold color={theme.primary}>
      {frames[frame]}
    </Text>
  )
}
