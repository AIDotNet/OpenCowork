import React, { useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import stringWidth from 'string-width'
import { t } from '../i18n.js'
import { fitText } from '../lib/text.js'
import { theme } from '../theme.js'
import type { ModelConfiguration } from '../types.js'
import { Spinner } from './spinner.js'

interface EffortPanelProps {
  configuration: ModelConfiguration
  onApply(effort: string | null): void
  onCancel(): void
  saving: boolean
  width: number
}

interface EffortOption {
  description: string
  label: string
  value: string | null
}

function effortDescription(level: string): string {
  if (level === 'none')
    return t('cli.effort.none', 'Disable provider reasoning effort for the next turns.')
  if (level === 'minimal')
    return t('cli.effort.minimal', 'Use the smallest available reasoning allocation.')
  if (level === 'low')
    return t('cli.effort.low', 'Prefer faster, lower-cost responses for straightforward work.')
  if (level === 'medium')
    return t('cli.effort.medium', 'Use moderate reasoning for routine multi-step work.')
  if (level === 'high')
    return t('cli.effort.high', 'Spend more reasoning on complex implementation and verification.')
  if (level === 'xhigh')
    return t('cli.effort.xhigh', 'Use extended reasoning for difficult or ambiguous work.')
  if (level === 'max')
    return t('cli.effort.max', 'Use the highest reasoning level for the current session only.')
  if (level === 'ultra') return t('cli.effort.ultra', 'Use this provider’s ultra reasoning level.')
  return t('cli.effort.other', 'Use the model-provided {{level}} reasoning level.', { level })
}

function sliderWidth(options: EffortOption[], selectedIndex: number): number {
  return options.reduce((total, option, index) => {
    const label = index === selectedIndex ? `● ${option.label}` : option.label
    return total + stringWidth(label) + (index === 0 ? 0 : 3)
  }, 0)
}

function visibleWindow(
  options: EffortOption[],
  selectedIndex: number,
  width: number
): { end: number; start: number } {
  let start = 0
  let end = options.length

  while (start < end - 1) {
    const visible = options.slice(start, end)
    const relativeSelected = selectedIndex - start
    const hiddenMarkers = (start > 0 ? 2 : 0) + (end < options.length ? 2 : 0)
    if (sliderWidth(visible, relativeSelected) + hiddenMarkers <= width) break

    const leftDistance = selectedIndex - start
    const rightDistance = end - 1 - selectedIndex
    if (rightDistance > leftDistance) end -= 1
    else if (start < selectedIndex) start += 1
    else end -= 1
  }

  return { end, start }
}

export function EffortPanel({
  configuration,
  onApply,
  onCancel,
  saving,
  width
}: EffortPanelProps): React.JSX.Element {
  const options = useMemo<EffortOption[]>(
    () => [
      {
        description: t('cli.effort.followDefault', 'Follow this model’s default ({{level}}).', {
          level: configuration.defaultReasoningEffort
        }),
        label: t('cli.common.auto', 'Auto'),
        value: null
      },
      ...configuration.reasoningEffortLevels.map((level) => ({
        description: effortDescription(level),
        label: level === 'xhigh' ? 'XHigh' : level[0]!.toLocaleUpperCase() + level.slice(1),
        value: level
      }))
    ],
    [configuration.defaultReasoningEffort, configuration.reasoningEffortLevels]
  )
  const currentDiffersFromDefault =
    configuration.reasoningEffort !== configuration.defaultReasoningEffort
  const initialIndex =
    configuration.reasoningEffortCustomized || currentDiffersFromDefault
      ? Math.max(
          1,
          options.findIndex((option) => option.value === configuration.reasoningEffort)
        )
      : 0
  const [selectedIndex, setSelectedIndex] = useState(initialIndex)
  const selected = options[selectedIndex] ?? options[0]!

  useInput((input, key) => {
    if (saving) return
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
      return
    }
    if (key.leftArrow || key.upArrow) {
      setSelectedIndex((index) => (index <= 0 ? options.length - 1 : index - 1))
      return
    }
    if (key.rightArrow || key.downArrow) {
      setSelectedIndex((index) => (index + 1) % options.length)
      return
    }
    if (key.return) onApply(selected.value)
  })

  const contentWidth = Math.max(16, width - 4)
  const window = visibleWindow(options, selectedIndex, contentWidth)
  const visible = options.slice(window.start, window.end)

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={2} width={width}>
      <Box>
        <Text bold>{t('cli.panels.effort', 'Reasoning effort')}</Text>
        {saving ? (
          <Box marginLeft={2}>
            <Spinner />
            <Text color={theme.muted}> {t('cli.common.saving', 'saving')}</Text>
          </Box>
        ) : null}
      </Box>
      <Text color={theme.muted}>
        {fitText(
          `${configuration.selection.providerName} / ${configuration.selection.modelName}`,
          contentWidth
        )}
      </Text>

      <Box marginTop={1} width={contentWidth}>
        {window.start > 0 ? <Text color={theme.dim}>… </Text> : null}
        {visible.map((option, index) => {
          const absoluteIndex = window.start + index
          const isSelected = absoluteIndex === selectedIndex
          return (
            <React.Fragment key={option.value ?? 'auto'}>
              {index > 0 ? <Text color={theme.dim}> ─ </Text> : null}
              <Text bold={isSelected} color={isSelected ? theme.primary : theme.muted}>
                {isSelected ? '● ' : ''}
                {option.label}
              </Text>
            </React.Fragment>
          )
        })}
        {window.end < options.length ? <Text color={theme.dim}> …</Text> : null}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.muted}>{fitText(selected.description, contentWidth)}</Text>
        <Text color={theme.dim}>
          {fitText(
            saving
              ? t('cli.effort.saving', 'Saving model effort to OpenCowork…')
              : t('cli.effort.footer', '←→ or ↑↓ adjust · Enter apply · Esc cancel'),
            contentWidth
          )}
        </Text>
      </Box>
    </Box>
  )
}
