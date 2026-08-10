import React from 'react'
import { Box, Text } from 'ink'
import stringWidth from 'string-width'
import { formatTokenCount, formatUsdCost } from '../lib/metrics.js'
import { fitText } from '../lib/text.js'
import { permissionModeLabels, theme } from '../theme.js'
import type { ContextSnapshot, PermissionMode, UsageSnapshot } from '../types.js'
import { Spinner } from './spinner.js'

interface StatusLineProps {
  activity?: string
  context: ContextSnapshot | null
  effort: string
  model: string
  mode: PermissionMode
  notice?: string
  usage: UsageSnapshot | null
  width: number
}

interface MetricLine {
  context: string
  remainder: string
}

function contextPercentage(context: ContextSnapshot | null): number | null {
  if (!context || context.contextLength <= 0) return null
  return Math.max(0, Math.round((context.estimatedTokens / context.contextLength) * 100))
}

function cacheHitPercentage(usage: UsageSnapshot | null): number | null {
  if (!usage || usage.inputTokens <= 0) return null
  const ratio = usage.cacheReadTokens / usage.inputTokens
  return Math.round(Math.min(1, Math.max(0, ratio)) * 100)
}

function joinMetricLine(context: string, metrics: string[], separator: string): MetricLine {
  return {
    context,
    remainder: metrics.length > 0 ? `${separator}${metrics.join(separator)}` : ''
  }
}

function selectMetricLine(
  context: ContextSnapshot | null,
  usage: UsageSnapshot | null,
  width: number
): MetricLine {
  const contextPercent = contextPercentage(context)
  const contextRatio = context
    ? context.contextLength > 0
      ? `${formatTokenCount(context.estimatedTokens)} / ${formatTokenCount(context.contextLength)} · ${contextPercent}%`
      : formatTokenCount(context.estimatedTokens)
    : '—'
  const compactContextRatio = context
    ? context.contextLength > 0
      ? `${formatTokenCount(context.estimatedTokens)}/${formatTokenCount(context.contextLength)} · ${contextPercent}%`
      : formatTokenCount(context.estimatedTokens)
    : '—'
  const contextSummary = context
    ? contextPercent === null
      ? formatTokenCount(context.estimatedTokens)
      : `${contextPercent}%`
    : '—'
  const cachePercent = cacheHitPercentage(usage)
  const cache = cachePercent === null ? '—' : `${cachePercent}%`
  const cost = usage?.estimatedCostUsd == null ? '—' : formatUsdCost(usage.estimatedCostUsd)
  const candidates = [
    joinMetricLine(`Context ${contextRatio}`, [`Cache ${cache}`, `Cost ${cost}`], '  '),
    joinMetricLine(`Ctx ${compactContextRatio}`, [`Cache ${cache}`, `Cost ${cost}`], ' · '),
    joinMetricLine(
      `Ctx ${contextSummary}`,
      [`Cache ${cache}`, cost === '—' ? 'Cost —' : cost],
      ' · '
    ),
    joinMetricLine(`Ctx ${contextSummary}`, [`Hit ${cache}`, cost], ' · ')
  ]

  return (
    candidates.find((candidate) => stringWidth(candidate.context + candidate.remainder) <= width) ??
    candidates[candidates.length - 1]!
  )
}

export function StatusLine({
  activity,
  context,
  effort,
  model,
  mode,
  notice,
  usage,
  width
}: StatusLineProps): React.JSX.Element {
  const left =
    notice ?? activity ?? (width >= 58 ? '? for shortcuts · ← for agents' : '? shortcuts')
  const contentWidth = Math.max(12, width - 4)
  const right = fitText(
    `${model} · ${permissionModeLabels[mode]} · ${effort}`,
    Math.max(12, Math.floor(contentWidth * 0.62))
  )
  const leftWidth = Math.max(6, contentWidth - stringWidth(right) - 3)
  const metrics = selectMetricLine(context, usage, contentWidth)
  const metricText = metrics.context + metrics.remainder
  const metricsFit = stringWidth(metricText) <= contentWidth
  const contextWarning = Boolean(
    context &&
    ((context.triggerTokens > 0 && context.estimatedTokens >= context.triggerTokens) ||
      (context.contextLength > 0 && context.estimatedTokens >= context.contextLength))
  )

  return (
    <Box flexDirection="column" width={width}>
      <Box justifyContent="space-between" paddingX={2} width={width}>
        {activity && !notice ? (
          <Box width={leftWidth}>
            <Spinner />
            <Text color={activity.startsWith('Compressing') ? theme.warning : theme.muted}>
              {' '}
              {fitText(left, Math.max(1, leftWidth - 2))}
            </Text>
          </Box>
        ) : (
          <Text color={notice ? theme.warning : theme.dim}>{fitText(left, leftWidth)}</Text>
        )}
        <Text color={theme.muted}>
          <Text color={mode === 'plan' ? theme.accent : theme.primary}>●</Text> {right}
        </Text>
      </Box>
      <Box paddingX={2} width={width}>
        {metricsFit ? (
          <Text color={theme.dim}>
            <Text color={contextWarning ? theme.warning : theme.muted}>{metrics.context}</Text>
            {metrics.remainder}
          </Text>
        ) : (
          <Text color={contextWarning ? theme.warning : theme.dim}>
            {fitText(metricText, contentWidth)}
          </Text>
        )}
      </Box>
    </Box>
  )
}
