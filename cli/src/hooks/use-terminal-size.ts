import { useEffect, useState } from 'react'

export interface TerminalSize {
  columns: number
  rows: number
}

function readSize(): TerminalSize {
  return {
    columns: Math.max(36, process.stdout.columns ?? 80),
    rows: Math.max(16, process.stdout.rows ?? 24)
  }
}

export function useTerminalSize(): TerminalSize {
  const [size, setSize] = useState(readSize)

  useEffect(() => {
    const handleResize = (): void => setSize(readSize())
    process.stdout.on('resize', handleResize)
    return () => {
      process.stdout.off('resize', handleResize)
    }
  }, [])

  return size
}
