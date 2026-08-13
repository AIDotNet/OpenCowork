import React, { useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import stringWidth from 'string-width'
import { t } from '../i18n.js'
import { fitText } from '../lib/text.js'
import {
  resolveThinkingIntensity,
  thinkingIntensityOptions,
  type ThinkingIntensityOption
} from '../lib/thinking-intensity.js'
import { theme } from '../theme.js'
import type { ModelConfiguration } from '../types.js'
import { Spinner } from './spinner.js'

interface EffortPanelProps {
  configuration: ModelConfiguration
  onApply(intensity: string): void
  onCancel(): void
  saving: boolean
  width: number
}

function sliderWidth(options: ThinkingIntensityOption[], selectedIndex: number): number {
  return options.reduce((total, option, index) => {
    const label = index === selectedIndex ? `● ${option.label}` : option.label
    return total + stringWidth(label) + (index === 0 ? 0 : 3)
  }, 0)
}

function visibleWindow(
  options: ThinkingIntensityOption[],
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
  const options = useMemo(() => thinkingIntensityOptions(configuration), [configuration])
  const initialIndex = Math.max(
    0,
    options.findIndex((option) => option.value === resolveThinkingIntensity(configuration))
  )
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
        <Text bold>{t('cli.panels.effort', 'Thinking intensity')}</Text>
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
            <React.Fragment key={option.value}>
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
              ? t('cli.effort.saving', 'Saving thinking intensity to OpenCowork…')
              : t('cli.effort.footer', '←→ or ↑↓ adjust · Enter apply · Esc cancel'),
            contentWidth
          )}
        </Text>
      </Box>
    </Box>
  )
}
