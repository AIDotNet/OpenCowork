import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { t } from '../i18n.js'
import { fitText, hasTerminalInputControl } from '../lib/text.js'
import { theme } from '../theme.js'
import type { ModelCatalog, ModelOption, ModelSelection } from '../types.js'

interface ModelPickerProps {
  catalog: ModelCatalog
  current: ModelSelection | null
  heading?: string
  maxVisible: number
  onCancel(): void
  onConfigureProvider?(): void
  onSelect(model: ModelSelection): void
  onUseCurrent?(): void
  summary?: string
  useCurrentLabel?: string
  width: number
}

type PickerRow = { kind: 'current'; label: string } | { kind: 'model'; option: ModelOption }

function matches(option: ModelOption, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return true
  return [
    option.modelName,
    option.modelId,
    option.providerName,
    option.providerType,
    option.providerBuiltinId ?? ''
  ].some((value) => value.toLocaleLowerCase().includes(normalized))
}

function toSelection(option: ModelOption): ModelSelection {
  return {
    providerId: option.providerId,
    providerName: option.providerName,
    modelId: option.modelId,
    modelName: option.modelName
  }
}

function authLabel(mode: ModelOption['authMode']): string {
  if (mode === 'oauth') return t('cli.model.oauth', 'OAuth')
  if (mode === 'channel') return t('cli.model.connectedChannel', 'Connected channel')
  return t('cli.model.apiKey', 'API key')
}

export function ModelPicker({
  catalog,
  current,
  heading = t('cli.panels.modelPicker', 'Select model'),
  maxVisible,
  onCancel,
  onConfigureProvider,
  onSelect,
  onUseCurrent,
  summary,
  useCurrentLabel = t('cli.model.useCurrent', 'Use current session model'),
  width
}: ModelPickerProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const options = useMemo<PickerRow[]>(() => {
    const rows: PickerRow[] = catalog.groups
      .flatMap((group) => group.models)
      .filter((option) => matches(option, query))
      .map((option) => ({ kind: 'model', option }))
    if (
      onUseCurrent &&
      (!query.trim() ||
        useCurrentLabel.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    ) {
      rows.unshift({ kind: 'current', label: useCurrentLabel })
    }
    return rows
  }, [catalog.groups, onUseCurrent, query, useCurrentLabel])
  const initialIndex = Math.max(
    0,
    options.findIndex(
      (row) =>
        (row.kind === 'current' && !current) ||
        (row.kind === 'model' &&
          row.option.providerId === current?.providerId &&
          row.option.modelId === current.modelId)
    )
  )
  const [selectedIndex, setSelectedIndex] = useState(initialIndex)

  useEffect(() => {
    setSelectedIndex((index) => Math.max(0, Math.min(index, options.length - 1)))
  }, [options.length])

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
      return
    }
    if (key.upArrow) {
      setSelectedIndex((index) => (index <= 0 ? Math.max(0, options.length - 1) : index - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex((index) => (options.length > 0 ? (index + 1) % options.length : 0))
      return
    }
    if (key.return) {
      if (catalog.totalModels === 0 && onConfigureProvider) {
        onConfigureProvider()
        return
      }
      const selected = options[selectedIndex]
      if (selected?.kind === 'current') onUseCurrent?.()
      if (selected?.kind === 'model') onSelect(toSelection(selected.option))
      return
    }
    if (key.ctrl && input === 'u') {
      setQuery('')
      setSelectedIndex(0)
      return
    }
    if (key.backspace || key.delete) {
      setQuery((value) => Array.from(value).slice(0, -1).join(''))
      setSelectedIndex(0)
      return
    }
    if (!key.ctrl && !key.meta && input && !hasTerminalInputControl(input)) {
      setQuery((value) => value + input)
      setSelectedIndex(0)
    }
  })

  const visibleCount = Math.max(4, maxVisible)
  const windowStart = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(visibleCount / 2), options.length - visibleCount)
  )
  const visibleOptions = options.slice(windowStart, windowStart + visibleCount)
  const queryText = query ? `${query}▏` : '▏'

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={2} width={width}>
      <Text bold>{heading}</Text>
      <Text color={theme.muted}>
        {summary ??
          (catalog.totalModels > 0
            ? t(
                'cli.model.enabledSummary',
                '{{models}} enabled models from {{providers}} connected providers',
                { models: catalog.totalModels, providers: catalog.groups.length }
              )
            : t(
                'cli.model.noConnectedProvider',
                'No connected provider has an enabled chat model.'
              ))}
      </Text>
      <Box marginTop={1}>
        <Text color={theme.dim}>{t('cli.common.search', 'Search')} </Text>
        <Text color={query ? theme.text : theme.primary}>{queryText}</Text>
      </Box>

      {catalog.totalModels === 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.warning}>
            {t('cli.common.noModels', 'No enabled provider has a chat model.')}
          </Text>
          <Text color={theme.muted}>
            {t(
              'cli.model.configureProviderHint',
              'Run /provider or press Enter to configure one in this terminal.'
            )}
          </Text>
        </Box>
      ) : options.length === 0 ? (
        <Box marginTop={1}>
          <Text color={theme.muted}>
            {t('cli.model.noMatches', 'No models match “{{query}}”.', {
              query: fitText(query, Math.max(8, width - 22))
            })}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {visibleOptions.map((row, visibleIndex) => {
            const absoluteIndex = windowStart + visibleIndex
            const selected = absoluteIndex === selectedIndex
            if (row.kind === 'current') {
              return (
                <Box key="model-picker-current" marginBottom={1}>
                  <Text color={selected ? theme.primary : theme.dim}>{selected ? '❯' : ' '} </Text>
                  <Text bold={selected} color={!current ? theme.primary : undefined}>
                    {fitText(row.label, Math.max(12, width - 20))}
                  </Text>
                  {!current ? (
                    <Text color={theme.success}> {t('cli.common.current', 'current')}</Text>
                  ) : null}
                </Box>
              )
            }

            const option = row.option
            const previousRow = options[absoluteIndex - 1]
            const previous = previousRow?.kind === 'model' ? previousRow.option : undefined
            const showProvider =
              visibleIndex === 0 || !previous || previous.providerId !== option.providerId
            const isCurrent =
              option.providerId === current?.providerId && option.modelId === current.modelId
            const rowWidth = Math.max(16, width - 4)
            const modelNameWidth = Math.max(10, Math.floor(rowWidth * 0.34))
            const descriptionWidth = Math.max(
              8,
              rowWidth - modelNameWidth - (isCurrent ? 8 : 0) - 4
            )
            return (
              <React.Fragment key={`${option.providerId}:${option.modelId}`}>
                {showProvider ? (
                  <Box marginTop={visibleIndex === 0 ? 0 : 1}>
                    <Text bold color={theme.dim}>
                      {option.providerName}
                    </Text>
                    <Text color={theme.muted}> · {authLabel(option.authMode)}</Text>
                  </Box>
                ) : null}
                <Box>
                  <Text color={selected ? theme.primary : theme.dim}>{selected ? '❯' : ' '} </Text>
                  <Text bold={selected} color={isCurrent ? theme.primary : undefined}>
                    {fitText(option.modelName, modelNameWidth)}
                  </Text>
                  <Text color={theme.muted}>
                    {'  '}
                    {fitText(option.description, descriptionWidth)}
                  </Text>
                  {isCurrent ? (
                    <Text color={theme.success}> {t('cli.common.current', 'current')}</Text>
                  ) : null}
                </Box>
              </React.Fragment>
            )
          })}
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={theme.dim}>
          {options.length > visibleOptions.length
            ? `${windowStart + 1}–${windowStart + visibleOptions.length} of ${options.length} · `
            : ''}
          {t('cli.model.footer', 'Type to search · ↑↓ navigate · Enter select · Esc cancel')}
        </Text>
      </Box>
    </Box>
  )
}
