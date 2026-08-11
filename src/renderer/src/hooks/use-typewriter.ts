import { useEffect, useMemo, useRef, useState } from 'react'
import type { LiveOutputAnimationStyle } from '@renderer/stores/settings-store'
import { recordStreamingRenderPoolFlush } from '@renderer/lib/streaming-perf'

interface StreamingRenderPoolState {
  text: string
  poolSize: number
  renderedLength: number
  targetLength: number
}

interface RenderPoolConfig {
  fixedCharsPerSecond: number
  frameIntervalMs: number
  smallPoolChars: number
  mediumPoolChars: number
  largePoolChars: number
  maxStepChars: number
}

const RENDER_POOL_CONFIG: Record<LiveOutputAnimationStyle, RenderPoolConfig> = {
  agile: {
    fixedCharsPerSecond: 220,
    frameIntervalMs: 32,
    smallPoolChars: 120,
    mediumPoolChars: 720,
    largePoolChars: 2400,
    maxStepChars: 3600
  },
  elegant: {
    fixedCharsPerSecond: 170,
    frameIntervalMs: 36,
    smallPoolChars: 96,
    mediumPoolChars: 560,
    largePoolChars: 1800,
    maxStepChars: 2800
  }
}

function getCatchupStep(poolSize: number, elapsedMs: number, config: RenderPoolConfig): number {
  const fixedStep = Math.max(1, Math.ceil((config.fixedCharsPerSecond * elapsedMs) / 1000))

  if (poolSize <= config.smallPoolChars) {
    return Math.min(poolSize, fixedStep)
  }

  const catchupRatio =
    poolSize <= config.mediumPoolChars ? 0.14 : poolSize <= config.largePoolChars ? 0.2 : 0.28
  const catchupStep = Math.ceil(poolSize * catchupRatio)
  return Math.min(poolSize, Math.max(fixedStep, catchupStep), config.maxStepChars)
}

/**
 * Keeps live text in a render pool instead of rendering every upstream delta directly.
 *
 * Small pools drain at a stable typewriter speed. Larger pools drain in bigger chunks so a bursty
 * model response can catch up without forcing React/Markstream to re-render on every token.
 */
export function useStreamingRenderPool(
  fullText: string,
  isStreaming: boolean,
  style: LiveOutputAnimationStyle = 'agile'
): StreamingRenderPoolState {
  const config = RENDER_POOL_CONFIG[style] ?? RENDER_POOL_CONFIG.agile
  const targetLengthRef = useRef(fullText.length)
  const renderedLengthRef = useRef(fullText.length)
  const committedLengthRef = useRef(fullText.length)
  const rafRef = useRef<number | null>(null)
  const lastFlushAtRef = useRef(0)
  const [renderedLength, setRenderedLength] = useState(fullText.length)

  useEffect(() => {
    targetLengthRef.current = fullText.length
  }, [fullText.length])

  useEffect(() => {
    if (!isStreaming) {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      renderedLengthRef.current = fullText.length
      return
    }

    if (renderedLengthRef.current > fullText.length) {
      renderedLengthRef.current = fullText.length
    }
  }, [fullText.length, isStreaming])

  useEffect(() => {
    if (!isStreaming) return
    if (rafRef.current !== null) return
    if (renderedLengthRef.current >= targetLengthRef.current) return

    lastFlushAtRef.current = 0

    const tick = (now: number): void => {
      const lastFlushAt = lastFlushAtRef.current
      const elapsedMs = lastFlushAt > 0 ? now - lastFlushAt : config.frameIntervalMs
      const targetLength = targetLengthRef.current
      const currentLength = renderedLengthRef.current
      const poolSize = Math.max(0, targetLength - currentLength)

      if (poolSize === 0) {
        // Do not keep a 60fps loop alive while an agent is waiting on tools or the network.
        // The next upstream delta re-runs this effect and starts a new drain cycle.
        rafRef.current = null
        return
      }

      if (elapsedMs >= config.frameIntervalMs) {
        lastFlushAtRef.current = now
        const measureStart = performance.now()
        const step = getCatchupStep(poolSize, elapsedMs, config)
        const nextLength = Math.min(targetLength, currentLength + step)

        renderedLengthRef.current = nextLength
        committedLengthRef.current = nextLength
        setRenderedLength(nextLength)
        recordStreamingRenderPoolFlush(performance.now() - measureStart, {
          poolSize,
          step,
          renderedLength: nextLength,
          targetLength
        })
      }

      rafRef.current = window.requestAnimationFrame(tick)
    }

    rafRef.current = window.requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [config, fullText.length, isStreaming])

  const safeRenderedLength = Math.min(renderedLength, fullText.length)
  const poolSize = Math.max(0, fullText.length - safeRenderedLength)
  const text = useMemo(() => {
    if (!isStreaming) return fullText
    return fullText.slice(0, safeRenderedLength)
  }, [fullText, isStreaming, safeRenderedLength])

  return {
    text,
    poolSize,
    renderedLength: safeRenderedLength,
    targetLength: fullText.length
  }
}

export function useTypewriter(fullText: string, isStreaming: boolean): string {
  return useStreamingRenderPool(fullText, isStreaming).text
}
