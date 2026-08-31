import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { t } from '../i18n.js'
import { fitText } from '../lib/text.js'
import {
  applyThinkingIntensity,
  formatEffortLevelLabel,
  resolveThinkingIntensity,
  thinkingIntensityOptions,
  thinkingIntensityPatch
} from '../lib/thinking-intensity.js'
import { theme } from '../theme.js'
import type { ModelConfiguration, ModelConfigurationPatch } from '../types.js'
import { Spinner } from './spinner.js'

interface ModelConfigPanelProps {
  configuration: ModelConfiguration
  maxVisible: number
  onApply(patch: ModelConfigurationPatch): void
  onCancel(): void
  saving: boolean
  width: number
}

type ModelConfigEntry = {
  key:
    | 'model'
    | 'protocol'
    | 'thinkingIntensity'
    | 'thinkingBudget'
    | 'fastModeEnabled'
    | 'builtinSearchEnabled'
    | 'enableLongContext'
    | 'websocketMode'
    | 'imageGenerationEnabled'
    | 'cacheTtl'
    | 'contextLength'
    | 'maxOutputTokens'
    | 'pricing'
  category: string
  choices?: string[]
  description: string
  kind: 'boolean' | 'enum' | 'info' | 'number'
  label: string
}

type ModelConfigDraft = ModelConfiguration

function formatTokens(value?: number): string {
  if (!value || value <= 0) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(Math.round(value))
}

function formatPrice(value?: number): string {
  return typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(2)}/M` : '—'
}

function valueFor(entry: ModelConfigEntry, draft: ModelConfigDraft): string {
  switch (entry.key) {
    case 'model':
      return `${draft.selection.providerName} / ${draft.selection.modelName}`
    case 'protocol':
      return draft.providerType
    case 'thinkingIntensity': {
      const intensity = resolveThinkingIntensity(draft)
      if (intensity === 'off') return t('cli.common.off', 'Off')
      if (intensity === 'on') return t('cli.common.on', 'On')
      if (intensity === 'auto') {
        return `${t('cli.common.auto', 'Auto')} (${formatEffortLevelLabel(draft.defaultReasoningEffort)})`
      }
      return formatEffortLevelLabel(intensity)
    }
    case 'thinkingBudget':
      return `${Math.round(draft.thinkingBudget ?? 0).toLocaleString()} tokens`
    case 'fastModeEnabled':
      return draft.fastModeEnabled ? 'On' : 'Off'
    case 'builtinSearchEnabled':
      return draft.builtinSearchEnabled ? 'On' : 'Off'
    case 'enableLongContext':
      return draft.enableLongContext ? '1M' : '360K'
    case 'websocketMode':
      return draft.websocketMode === 'auto' ? 'Auto' : 'Off'
    case 'imageGenerationEnabled':
      return draft.imageGenerationEnabled ? 'On' : 'Off'
    case 'cacheTtl':
      return draft.cacheTtl
    case 'contextLength':
      return `${formatTokens(draft.contextLength)} context`
    case 'maxOutputTokens':
      return `${formatTokens(draft.maxOutputTokens)} output`
    case 'pricing':
      if (draft.offPeakInputPrice != null || draft.offPeakOutputPrice != null) {
        return `peak ${formatPrice(draft.inputPrice)}/${formatPrice(draft.outputPrice)} · off-peak ${formatPrice(draft.offPeakInputPrice)}/${formatPrice(draft.offPeakOutputPrice)}`
      }
      return `${formatPrice(draft.inputPrice)} input · ${formatPrice(draft.outputPrice)} output`
  }
}

function isEnabled(entry: ModelConfigEntry, draft: ModelConfigDraft): boolean {
  switch (entry.key) {
    case 'thinkingIntensity':
      return draft.thinkingEnabled
    case 'fastModeEnabled':
      return draft.fastModeEnabled
    case 'builtinSearchEnabled':
      return draft.builtinSearchEnabled
    case 'enableLongContext':
      return draft.enableLongContext
    case 'websocketMode':
      return draft.websocketMode === 'auto'
    case 'imageGenerationEnabled':
      return draft.imageGenerationEnabled
    default:
      return false
  }
}

export function ModelConfigPanel({
  configuration,
  maxVisible,
  onApply,
  onCancel,
  saving,
  width
}: ModelConfigPanelProps): React.JSX.Element {
  const [draft, setDraft] = useState<ModelConfigDraft>(configuration)
  const [selectedIndex, setSelectedIndex] = useState(0)

  useEffect(() => {
    setDraft(configuration)
    setSelectedIndex(0)
  }, [configuration])

  const entries = useMemo<ModelConfigEntry[]>(() => {
    const next: ModelConfigEntry[] = [
      {
        category: 'Model',
        description: 'Selected provider and model.',
        key: 'model',
        kind: 'info',
        label: 'Model'
      },
      {
        category: 'Model',
        description: 'Native Worker request protocol resolved for this model.',
        key: 'protocol',
        kind: 'info',
        label: 'Protocol'
      }
    ]
    if (configuration.supportsThinking) {
      const intensityOptions = thinkingIntensityOptions(configuration)
      next.push({
        category: 'Thinking',
        choices: intensityOptions.map((option) => option.value),
        description:
          'Thinking intensity for this model. Off disables reasoning; Auto follows the model default.',
        key: 'thinkingIntensity',
        kind: 'enum',
        label: 'Thinking'
      })
      if (configuration.thinkingBudget !== undefined) {
        next.push({
          category: 'Thinking',
          description: 'Anthropic budget_tokens used by extended thinking.',
          key: 'thinkingBudget',
          kind: 'number',
          label: 'Thinking budget'
        })
      }
    }
    if (configuration.supportsFastMode) {
      next.push({
        category: 'Runtime',
        description: 'Use the provider priority service tier when available.',
        key: 'fastModeEnabled',
        kind: 'boolean',
        label: 'Fast mode'
      })
    }
    if (configuration.supportsBuiltinSearch) {
      next.push({
        category: 'Tools',
        description: 'Allow the provider-native web search tool for this model.',
        key: 'builtinSearchEnabled',
        kind: 'boolean',
        label: 'Built-in search'
      })
    }
    if (configuration.supportsGptLongContext) {
      next.push({
        category: 'Limits',
        description:
          '1M-capable models default to the 360K window. Enable 1M to use the native long-context window.',
        key: 'enableLongContext',
        kind: 'boolean',
        label: '1M context'
      })
    }
    if (configuration.supportsResponsesWebsocket) {
      next.push({
        category: 'Transport',
        description: 'Allow Responses WebSocket transport with HTTP fallback.',
        key: 'websocketMode',
        kind: 'enum',
        choices: ['auto', 'disabled'],
        label: 'Responses WebSocket'
      })
    }
    if (configuration.supportsImageGeneration) {
      next.push({
        category: 'Tools',
        description: 'Expose the Responses image_generation tool for this model.',
        key: 'imageGenerationEnabled',
        kind: 'boolean',
        label: 'Image generation'
      })
    }
    if (configuration.supportsCacheTtl) {
      next.push({
        category: 'Cache',
        choices: ['5m', '1h'],
        description: 'Prompt cache lifetime for Anthropic requests.',
        key: 'cacheTtl',
        kind: 'enum',
        label: 'Cache TTL'
      })
    }
    next.push(
      {
        category: 'Limits',
        description: 'Configured context window for this model.',
        key: 'contextLength',
        kind: 'info',
        label: 'Context window'
      },
      {
        category: 'Limits',
        description: 'Configured maximum output tokens for this model.',
        key: 'maxOutputTokens',
        kind: 'info',
        label: 'Output limit'
      },
      {
        category: 'Pricing',
        description: 'Configured USD price per million input and output tokens.',
        key: 'pricing',
        kind: 'info',
        label: 'Token pricing'
      }
    )
    return next
  }, [configuration])

  const visibleCount = Math.max(5, maxVisible)
  const safeSelectedIndex = Math.max(0, Math.min(selectedIndex, entries.length - 1))
  const windowStart = Math.max(
    0,
    Math.min(safeSelectedIndex - Math.floor(visibleCount / 2), entries.length - visibleCount)
  )
  const visible = entries.slice(windowStart, windowStart + visibleCount)
  const selected = entries[safeSelectedIndex]
  const contentWidth = Math.max(24, width - 4)
  const categoryWidth = Math.max(7, Math.min(10, Math.floor(contentWidth * 0.15)))
  const labelWidth = Math.max(12, Math.min(22, Math.floor(contentWidth * 0.3)))
  const valueWidth = Math.max(8, contentWidth - categoryWidth - labelWidth - 7)
  const updateDraft = (key: ModelConfigEntry['key'], value: boolean | number | string): void => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  const adjust = (entry: ModelConfigEntry, direction: -1 | 1): void => {
    if (entry.kind === 'info') return
    if (entry.kind === 'boolean') {
      updateDraft(entry.key, !isEnabled(entry, draft))
      return
    }
    if (entry.kind === 'number' && entry.key === 'thinkingBudget') {
      const current = draft.thinkingBudget ?? configuration.thinkingBudgetMin ?? 1_024
      const min = configuration.thinkingBudgetMin ?? 1_024
      const max = configuration.thinkingBudgetMax ?? 64_000
      setDraft((currentDraft) => ({
        ...currentDraft,
        thinkingBudget: Math.min(max, Math.max(min, current + direction * 1_024)),
        thinkingEnabled: true,
        thinkingEnabledCustomized: true
      }))
      return
    }
    if (entry.key === 'thinkingIntensity') {
      const choices = thinkingIntensityOptions(draft)
      const current = resolveThinkingIntensity(draft)
      const currentIndex = choices.findIndex((choice) => choice.value === current)
      const nextIndex =
        currentIndex < 0 ? 0 : (currentIndex + direction + choices.length) % choices.length
      const nextValue = choices[nextIndex]?.value
      if (nextValue) setDraft((currentDraft) => applyThinkingIntensity(currentDraft, nextValue))
      return
    }
    const choices = entry.choices ?? []
    const current =
      entry.key === 'websocketMode'
        ? draft.websocketMode
        : entry.key === 'cacheTtl'
          ? draft.cacheTtl
          : String(valueFor(entry, draft))
    const normalizedCurrent = current.toLocaleLowerCase()
    const currentIndex = choices.findIndex(
      (choice) => choice.toLocaleLowerCase() === normalizedCurrent
    )
    const nextIndex =
      currentIndex < 0 ? 0 : (currentIndex + direction + choices.length) % choices.length
    const nextValue = choices[nextIndex]
    if (nextValue) {
      updateDraft(entry.key, nextValue === 'auto' ? 'auto' : nextValue)
    }
  }

  useInput((input, key) => {
    if (saving) return
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
      return
    }
    if (key.upArrow) {
      setSelectedIndex((index) => (index <= 0 ? Math.max(0, entries.length - 1) : index - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex((index) => (entries.length > 0 ? (index + 1) % entries.length : 0))
      return
    }
    if (key.leftArrow) {
      adjust(selected ?? entries[0]!, -1)
      return
    }
    if (key.rightArrow || input === ' ') {
      adjust(selected ?? entries[0]!, 1)
      return
    }
    if (key.return) {
      onApply(toPatch(draft))
      return
    }
  })

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={2} width={width}>
      <Box>
        <Text bold>{t('cli.panels.modelStep', 'Configure model · Step 2 of 2')}</Text>
        {saving ? (
          <Box marginLeft={2}>
            <Spinner />
            <Text color={theme.muted}> {t('cli.common.saving', 'saving')}</Text>
          </Box>
        ) : null}
      </Box>
      <Text color={theme.muted}>
        {configuration.selection.providerName} / {configuration.selection.modelName}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {visible.map((entry, index) => {
          const absoluteIndex = windowStart + index
          const isSelected = absoluteIndex === safeSelectedIndex
          const isDisabled = entry.key === 'thinkingBudget' && !draft.thinkingEnabled
          return (
            <Box key={entry.key}>
              <Text color={isSelected ? theme.primary : theme.dim}>{isSelected ? '❯' : ' '} </Text>
              <Text color={theme.dim}>{fitText(entry.category, categoryWidth)}</Text>
              <Text bold={isSelected} color={isDisabled ? theme.dim : undefined}>
                {'  '}
                {fitText(entry.label, labelWidth)}
              </Text>
              <Text color={isDisabled ? theme.dim : isSelected ? theme.primary : theme.muted}>
                {'  '}
                {fitText(valueFor(entry, draft), valueWidth)}
              </Text>
            </Box>
          )
        })}
        {Array.from({ length: Math.max(0, visibleCount - visible.length) }).map((_, index) => (
          <Text key={`model-config-spacer-${index}`}> </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.muted}>
          {fitText(
            selected?.key === 'thinkingIntensity'
              ? (thinkingIntensityOptions(draft).find(
                  (option) => option.value === resolveThinkingIntensity(draft)
                )?.description ?? selected.description)
              : (selected?.description ??
                  t('cli.modelConfig.choose', 'Choose a model configuration.')),
            contentWidth
          )}
        </Text>
        <Text color={theme.dim}>
          {fitText(
            saving
              ? t('cli.modelConfig.saving', 'Saving model settings to OpenCowork…')
              : `${entries.length > visible.length ? `${windowStart + 1}–${windowStart + visible.length} of ${entries.length} · ` : ''}${t('cli.modelConfig.footer', '↑↓ navigate · ←→ change · Space toggle · Enter apply · Esc back')}`,
            contentWidth
          )}
        </Text>
      </Box>
    </Box>
  )
}

function toPatch(draft: ModelConfigDraft): ModelConfigurationPatch {
  return {
    ...(draft.supportsBuiltinSearch ? { builtinSearchEnabled: draft.builtinSearchEnabled } : {}),
    ...(draft.supportsGptLongContext ? { enableLongContext: draft.enableLongContext } : {}),
    ...(draft.supportsCacheTtl ? { cacheTtl: draft.cacheTtl } : {}),
    ...(draft.supportsFastMode ? { fastModeEnabled: draft.fastModeEnabled } : {}),
    ...(draft.supportsImageGeneration
      ? { imageGenerationEnabled: draft.imageGenerationEnabled }
      : {}),
    ...(draft.supportsThinking
      ? {
          ...thinkingIntensityPatch(draft, resolveThinkingIntensity(draft)),
          ...(draft.thinkingBudget === undefined ? {} : { thinkingBudget: draft.thinkingBudget })
        }
      : {}),
    ...(draft.supportsResponsesWebsocket ? { websocketMode: draft.websocketMode } : {})
  }
}
