import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import stringWidth from 'string-width'
import { t } from '../i18n.js'
import { formatTokenCount, formatUsdCost } from '../lib/metrics.js'
import { fitText } from '../lib/text.js'
import { permissionModeLabels, theme } from '../theme.js'
import type { ContextSnapshot, PermissionMode, TurnStatusSnapshot, UsageSnapshot } from '../types.js'
import { Spinner } from './spinner.js'

interface StatusLineProps {
  activity?: string
  context: ContextSnapshot | null
  effort: string
  hideIdleHint?: boolean
  model: string
  mode: PermissionMode
  notice?: string
  supportsEffort: boolean
  supportsThinking: boolean
  thinkingEnabled: boolean
  turnStatus?: TurnStatusSnapshot | null
  usage: UsageSnapshot | null
  width: number
}

interface MetricLine {
  context: string
  remainder: string
}

function activeModeHint(mode: PermissionMode, width: number): string | null {
  const candidates: Partial<Record<PermissionMode, string[]>> = {
    acceptEdits: [
      t('cli.statusLine.acceptEditsWide', '⏵⏵ accept edits on (shift+tab to cycle) · ← for agents'),
      t('cli.statusLine.acceptEditsMedium', '⏵⏵ accept edits on · shift+tab to cycle'),
      t('cli.statusLine.acceptEditsShort', '⏵⏵ accept edits · shift+tab')
    ],
    plan: [
      t('cli.statusLine.planWide', '⏸ plan mode on (shift+tab to cycle) · ← for agents'),
      t('cli.statusLine.planMedium', '⏸ plan mode on · shift+tab to cycle'),
      t('cli.statusLine.planShort', '⏸ plan on · shift+tab')
    ],
    auto: [
      t('cli.statusLine.autoWide', '⏵⏵ auto mode on (shift+tab to cycle) · ← for agents'),
      t('cli.statusLine.autoMedium', '⏵⏵ auto mode on · shift+tab to cycle'),
      t('cli.statusLine.autoShort', '⏵⏵ auto on · shift+tab')
    ]
  }
  const options = candidates[mode]
  if (!options) return null
  return (
    options.find((candidate) => stringWidth(candidate) <= width) ?? fitText(options.at(-1)!, width)
  )
}

function activeModeColor(mode: PermissionMode): string {
  if (mode === 'plan') return theme.accent
  if (mode === 'auto') return theme.warning
  return theme.primary
}

function contextPercentage(context: ContextSnapshot | null): number | null {
  if (!context || context.contextLength <= 0) return null
  return Math.max(0, (context.estimatedTokens / context.contextLength) * 100)
}

function formatPercentage(value: number | null): string {
  if (value === null) return '—'
  if (value > 0 && value < 1) return '<1%'
  return `${Math.round(value)}%`
}

function cacheHitPercentage(usage: UsageSnapshot | null): number | null {
  if (!usage || usage.inputTokens <= 0) return null
  const ratio = usage.cacheReadTokens / usage.inputTokens
  return Math.round(Math.min(1, Math.max(0, ratio)) * 100)
}

interface AgentPerformance {
  tps: string
  ttft: string
}

function formatLatency(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))}ms`
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)}s`
}

function agentPerformance(status: TurnStatusSnapshot | null | undefined, now: number): AgentPerformance | null {
  if (!status?.firstResponseAt) return null
  const generatedTokens = status.completedOutputTokens + status.activeResponseCharacters / 4
  const secondsSinceFirstToken = Math.max(0.001, (now - status.firstResponseAt) / 1_000)
  const tps = generatedTokens / secondsSinceFirstToken
  return {
    tps: `${tps < 10 ? tps.toFixed(1) : Math.round(tps)}`,
    ttft: formatLatency(status.firstResponseAt - status.startedAt)
  }
}

function joinMetricLine(context: string, metrics: string[], separator: string): MetricLine {
  return {
    context,
    remainder: metrics.length > 0 ? `${separator}${metrics.join(separator)}` : ''
  }
}

function selectMetricLine(
  context: ContextSnapshot | null,
  turnStatus: TurnStatusSnapshot | null | undefined,
  usage: UsageSnapshot | null,
  width: number,
  now: number
): MetricLine {
  const contextPercent = formatPercentage(contextPercentage(context))
  const contextRatio = context
    ? context.contextLength > 0
      ? `${formatTokenCount(context.estimatedTokens)} / ${formatTokenCount(context.contextLength)} · ${contextPercent}`
      : formatTokenCount(context.estimatedTokens)
    : '—'
  const compactContextRatio = context
    ? context.contextLength > 0
      ? `${formatTokenCount(context.estimatedTokens)}/${formatTokenCount(context.contextLength)} · ${contextPercent}`
      : formatTokenCount(context.estimatedTokens)
    : '—'
  const contextSummary = context
    ? context.contextLength <= 0
      ? formatTokenCount(context.estimatedTokens)
      : contextPercent
    : '—'
  const cachePercent = cacheHitPercentage(usage)
  const cache = cachePercent === null ? '—' : `${cachePercent}%`
  const cost = usage?.estimatedCostUsd == null ? '—' : formatUsdCost(usage.estimatedCostUsd)
  const input = usage ? formatTokenCount(usage.inputTokens) : '—'
  const output = usage ? formatTokenCount(usage.outputTokens) : '—'
  const thinking = usage?.reasoningTokens ? formatTokenCount(usage.reasoningTokens) : null
  const performance = agentPerformance(turnStatus, now)
  const wideTokens = [`${input} in`, `${output} out`, ...(thinking ? [`${thinking} think`] : [])]
  const compactTokens = [`In ${input}`, `Out ${output}`, ...(thinking ? [`Think ${thinking}`] : [])]
  const tinyTokens = [`I${input}`, `O${output}`, ...(thinking ? [`T${thinking}`] : [])]
  const widePerformance = performance
    ? `Agent ${performance.tps} TPS · TTFT ${performance.ttft}`
    : null
  const compactPerformance = performance ? `${performance.tps} TPS · ${performance.ttft} TTFT` : null
  const tinyPerformance = performance ? `${performance.tps}TPS · ${performance.ttft}` : null
  const candidates = [
    joinMetricLine(
      `Context ${contextRatio}`,
      [
        `Tokens ${wideTokens.join(' · ')}`,
        ...(widePerformance ? [widePerformance] : []),
        `Cache ${cache}`,
        `Cost ${cost}`
      ],
      '   '
    ),
    joinMetricLine(
      `Ctx ${compactContextRatio}`,
      [
        compactTokens.join(' · '),
        ...(compactPerformance ? [compactPerformance] : []),
        `Hit ${cache} · ${cost}`
      ],
      ' │ '
    ),
    joinMetricLine(
      `Ctx ${contextSummary}`,
      [...compactTokens, ...(compactPerformance ? [compactPerformance] : []), cost],
      ' · '
    ),
    joinMetricLine(
      `Ctx ${contextSummary}`,
      [...compactTokens, ...(tinyPerformance ? [tinyPerformance] : [])],
      ' · '
    ),
    joinMetricLine(`C${contextSummary}`, [...tinyTokens, ...(tinyPerformance ? [tinyPerformance] : [])], ' '),
    joinMetricLine(`C${contextSummary}`, tinyTokens, ' ')
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
  hideIdleHint = false,
  model,
  mode,
  notice,
  supportsEffort,
  supportsThinking,
  thinkingEnabled,
  turnStatus,
  usage,
  width
}: StatusLineProps): React.JSX.Element {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!turnStatus?.firstResponseAt) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [turnStatus?.firstResponseAt, turnStatus?.id])

  const contentWidth = Math.max(12, width - 4)
  const modeHint = !notice && !activity && !hideIdleHint ? activeModeHint(mode, contentWidth) : null
  const left =
    notice ??
    activity ??
    (hideIdleHint
      ? ''
      : width >= 58
        ? t('cli.statusLine.hints', '? for shortcuts · ← for agents')
        : t('cli.statusLine.shortHints', '? shortcuts'))
  const thinkingStatus = supportsThinking
    ? `${t('cli.statusLine.think', 'think')} ${thinkingEnabled ? t('cli.statusLine.on', 'on') : t('cli.statusLine.off', 'off')}`
    : null
  const statusParts = [permissionModeLabels[mode], thinkingStatus, supportsEffort ? effort : null]
    .filter(Boolean)
    .join(' · ')
  const right = fitText(`${model} · ${statusParts}`, Math.max(12, Math.floor(contentWidth * 0.62)))
  const leftWidth = Math.max(6, contentWidth - stringWidth(right) - 3)
  const metrics = selectMetricLine(context, turnStatus, usage, contentWidth, now)
  const metricText = metrics.context + metrics.remainder
  const metricsFit = stringWidth(metricText) <= contentWidth
  const contextWarning = Boolean(
    context &&
    ((context.triggerTokens > 0 && context.estimatedTokens >= context.triggerTokens) ||
      (context.contextLength > 0 && context.estimatedTokens >= context.contextLength))
  )

  return (
    <Box flexDirection="column" width={width}>
      {modeHint ? (
        <Box paddingX={2} width={width}>
          <Text bold color={activeModeColor(mode)}>
            {modeHint}
          </Text>
        </Box>
      ) : (
        <Box justifyContent="space-between" paddingX={2} width={width}>
          {activity && !notice ? (
            <Box width={leftWidth}>
              <Spinner />
              <Text
                color={
                  activity.startsWith(
                    t('cli.statuses.compressing', 'Compressing context…').split(' ')[0]!
                  ) || activity.startsWith(t('cli.runtime.retry', 'Retry'))
                    ? theme.warning
                    : theme.muted
                }
              >
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
      )}
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
