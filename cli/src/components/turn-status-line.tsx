import React, { useEffect, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import stringWidth from 'string-width'
import { formatTokenCount } from '../lib/metrics.js'
import { fitText } from '../lib/text.js'
import { theme } from '../theme.js'
import type { TurnStatusSnapshot } from '../types.js'
import { ShimmerText } from './shimmer-text.js'

const SPINNER_VERBS = [
  'Calculating',
  'Considering',
  'Crafting',
  'Processing',
  'Stewing',
  'Thinking',
  'Working'
] as const

const TOKEN_ANIMATION_INTERVAL_MS = 60
const ELAPSED_WIDTH_SAMPLE = '999m 59s'
const TOKEN_WIDTH_SAMPLE = '999.9M'

interface AnimatedTokenState {
  id: string
  input: number
  output: number
}

interface MetadataLayout {
  reservedWidth: number
  text: string
}

export function pickSpinnerVerb(): string {
  return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)] ?? 'Thinking'
}

function formatElapsed(startedAt: number, now: number): string {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1_000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

export function advanceAnimatedTokenCount(current: number, target: number): number {
  const safeCurrent = Math.max(0, Math.round(Number.isFinite(current) ? current : 0))
  const safeTarget = Math.max(0, Math.round(Number.isFinite(target) ? target : 0))
  if (safeCurrent === safeTarget) return safeCurrent

  const distance = Math.abs(safeTarget - safeCurrent)
  const rate = safeTarget > safeCurrent ? 0.18 : 0.35
  const step = Math.max(1, Math.ceil(distance * rate))
  return safeTarget > safeCurrent
    ? Math.min(safeTarget, safeCurrent + step)
    : Math.max(safeTarget, safeCurrent - step)
}

function useAnimatedTokens(status: TurnStatusSnapshot): number {
  const targetsRef = useRef({ input: status.requestTokens, output: 0 })
  targetsRef.current = {
    input: status.requestTokens,
    output: status.completedOutputTokens + Math.round(status.activeResponseCharacters / 4)
  }
  const [animated, setAnimated] = useState<AnimatedTokenState>({
    id: status.id,
    input: 0,
    output: 0
  })

  useEffect(() => {
    setAnimated((current) =>
      current.id === status.id ? current : { id: status.id, input: 0, output: 0 }
    )
    const timer = setInterval(() => {
      setAnimated((current) => {
        const active = current.id === status.id ? current : { id: status.id, input: 0, output: 0 }
        const input = advanceAnimatedTokenCount(active.input, targetsRef.current.input)
        const output = advanceAnimatedTokenCount(active.output, targetsRef.current.output)
        return input === active.input && output === active.output
          ? active
          : { id: status.id, input, output }
      })
    }, TOKEN_ANIMATION_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [status.id])

  if (animated.id !== status.id) return 0
  return status.phase === 'requesting' ? animated.input : animated.output
}

function selectMetadata(
  status: TurnStatusSnapshot,
  animatedTokens: number,
  effort: string,
  supportsEffort: boolean,
  label: string,
  width: number,
  now: number
): MetadataLayout {
  const elapsed = formatElapsed(status.startedAt, now)
  const direction = status.phase === 'requesting' ? '↑' : '↓'
  const transfer = `${direction} ${formatTokenCount(animatedTokens)} tokens`
  const reservedTransfer = `${direction} ${TOKEN_WIDTH_SAMPLE} tokens`
  const thinking =
    status.phase === 'thinking' && supportsEffort ? ` · thinking with ${effort} effort` : ''
  const candidates = [
    {
      reserved: `(${ELAPSED_WIDTH_SAMPLE} · ${reservedTransfer}${thinking})`,
      text: `(${elapsed} · ${transfer}${thinking})`
    },
    {
      reserved: `(${ELAPSED_WIDTH_SAMPLE} · ${reservedTransfer})`,
      text: `(${elapsed} · ${transfer})`
    },
    { reserved: `(${reservedTransfer})`, text: `(${transfer})` }
  ]
  const selected =
    candidates.find(
      (candidate) =>
        stringWidth(`${label} ${candidate.reserved}`) <= width &&
        stringWidth(candidate.text) <= stringWidth(candidate.reserved)
    ) ?? candidates[candidates.length - 1]!
  return {
    reservedWidth: Math.max(stringWidth(selected.reserved), stringWidth(selected.text)),
    text: selected.text
  }
}

export function TurnStatusLine({
  effort,
  status,
  supportsEffort,
  width
}: {
  effort: string
  status: TurnStatusSnapshot
  supportsEffort: boolean
  width: number
}): React.JSX.Element {
  const [now, setNow] = useState(Date.now())
  const animatedTokens = useAnimatedTokens(status)

  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [status.id])

  const label = `${status.verb}…`
  const contentWidth = Math.max(1, width - 2)
  const metadata = selectMetadata(
    status,
    animatedTokens,
    effort,
    supportsEffort,
    label,
    contentWidth,
    now
  )
  const labelWidth = Math.min(
    stringWidth(label),
    Math.max(1, contentWidth - metadata.reservedWidth - 1)
  )

  return (
    <Box marginTop={1} width={width}>
      <Box width={1}>
        <Text bold color={theme.primary}>
          ✻
        </Text>
      </Box>
      <Text> </Text>
      <Box width={labelWidth}>
        <ShimmerText text={fitText(label, labelWidth)} />
      </Box>
      <Text> </Text>
      <Box width={metadata.reservedWidth}>
        <Text color={theme.muted}>{metadata.text}</Text>
      </Box>
    </Box>
  )
}
