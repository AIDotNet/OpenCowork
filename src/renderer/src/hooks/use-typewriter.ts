import { useRef, useState, useEffect } from 'react'

/**
 * Smoothly reveals text character-by-character during streaming,
 * creating a fluid typewriter animation effect.
 *
 * Uses requestAnimationFrame with adaptive easing: reveals 12% of the
 * remaining buffer per tick (min 3 chars) at ~30 fps. This produces a
 * natural ease-out feel — text flows quickly when the buffer is large
 * and slows gracefully as it catches up to the live content.
 *
 * @param fullText - The complete text content from the store
 * @param isStreaming - Whether the text is currently being streamed
 * @returns The portion of text that should be displayed
 */
export function useTypewriter(fullText: string, isStreaming: boolean): string {
  const [displayLen, setDisplayLen] = useState(fullText.length)
  const currentRef = useRef(fullText.length)
  const targetRef = useRef(fullText.length)
  const rafRef = useRef(0)
  const lastTickRef = useRef(0)

  // Keep target in sync with actual content length (updated every render)
  targetRef.current = fullText.length

  useEffect(() => {
    if (!isStreaming) {
      // Immediately reveal all text when streaming ends
      cancelAnimationFrame(rafRef.current)
      currentRef.current = fullText.length
      setDisplayLen(fullText.length)
      return
    }

    const tick = (now: number): void => {
      // Throttle to ~30 fps — markdown re-parsing is expensive
      if (now - lastTickRef.current >= 33) {
        lastTickRef.current = now
        const target = targetRef.current
        const cur = currentRef.current
        if (cur < target) {
          const gap = target - cur
          // Adaptive easing: 12 % of remaining gap, floor 3 chars.
          // At typical LLM speed (~150 chars/s) this gives a ~35-char
          // natural buffer — about half a line of visible delay.
          const step = Math.max(3, Math.ceil(gap * 0.12))
          currentRef.current = Math.min(cur + step, target)
          setDisplayLen(currentRef.current)
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
    // Only restart the rAF loop when streaming state toggles.
    // Target length is tracked via ref so no dependency needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming])

  if (!isStreaming) return fullText
  return fullText.slice(0, displayLen)
}
