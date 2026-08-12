import { useEffect, useState } from 'react'

export interface TerminalSize {
  columns: number
  revision: number
  rows: number
}

function readSize(revision = 0): TerminalSize {
  return {
    columns: Math.max(36, process.stdout.columns ?? 80),
    revision,
    // Keep the floor below any realistic terminal: reporting more rows than the terminal
    // actually has makes the fullscreen frame taller than the alt screen, so its top —
    // the transcript — scrolls off irrecoverably.
    rows: Math.max(8, process.stdout.rows ?? 24)
  }
}

export function useTerminalSize(): TerminalSize {
  const [size, setSize] = useState(readSize)

  useEffect(() => {
    let resizeTimer: NodeJS.Timeout | undefined
    const handleResize = (): void => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        setSize((current) => readSize(current.revision + 1))
      }, 40)
    }
    process.stdout.on('resize', handleResize)
    return () => {
      if (resizeTimer) clearTimeout(resizeTimer)
      process.stdout.off('resize', handleResize)
    }
  }, [])

  return size
}
