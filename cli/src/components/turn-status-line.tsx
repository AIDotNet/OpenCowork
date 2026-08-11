import React, { useEffect, useState } from 'react'
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

function displayedTokens(status: TurnStatusSnapshot): number {
  if (status.phase === 'requesting') return status.requestTokens
  return status.completedOutputTokens + Math.round(status.activeResponseCharacters / 4)
}

function selectMetadata(
  status: TurnStatusSnapshot,
  effort: string,
  supportsEffort: boolean,
  label: string,
  width: number,
  now: number
): string {
  const elapsed = formatElapsed(status.startedAt, now)
  const direction = status.phase === 'requesting' ? '↑' : '↓'
  const transfer = `${direction} ${formatTokenCount(displayedTokens(status))} tokens`
  const thinking =
    status.phase === 'thinking' && supportsEffort ? ` · thinking with ${effort} effort` : ''
  const candidates = [
    `(${elapsed} · ${transfer}${thinking})`,
    `(${elapsed} · ${transfer})`,
    `(${transfer})`
  ]
  return (
    candidates.find((candidate) => stringWidth(`${label} ${candidate}`) <= width) ??
    candidates[candidates.length - 1]!
  )
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

  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [status.id])

  const label = `${status.verb}…`
  const contentWidth = Math.max(1, width - 2)
  const metadata = selectMetadata(status, effort, supportsEffort, label, contentWidth, now)
  const labelWidth = Math.max(1, contentWidth - stringWidth(metadata) - 1)

  return (
    <Box marginTop={1} width={width}>
      <Text bold color={theme.primary}>
        ✻
      </Text>
      <Text> </Text>
      <ShimmerText text={fitText(label, labelWidth)} />
      <Text color={theme.muted}> {metadata}</Text>
    </Box>
  )
}
