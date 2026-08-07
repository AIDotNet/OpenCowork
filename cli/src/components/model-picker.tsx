import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { fitText, hasTerminalInputControl } from '../lib/text.js'
import { theme } from '../theme.js'
import type { ModelCatalog, ModelOption, ModelSelection } from '../types.js'

interface ModelPickerProps {
  catalog: ModelCatalog
  current: ModelSelection | null
  maxVisible: number
  onCancel(): void
  onSelect(model: ModelSelection): void
  width: number
}

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
  if (mode === 'oauth') return 'OAuth'
  if (mode === 'channel') return 'Connected channel'
  return 'API key'
}

export function ModelPicker({
  catalog,
  current,
  maxVisible,
  onCancel,
  onSelect,
  width
}: ModelPickerProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const options = useMemo(
    () =>
      catalog.groups.flatMap((group) => group.models).filter((option) => matches(option, query)),
    [catalog.groups, query]
  )
  const initialIndex = Math.max(
    0,
    options.findIndex(
      (option) => option.providerId === current?.providerId && option.modelId === current.modelId
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
      const selected = options[selectedIndex]
      if (selected) onSelect(toSelection(selected))
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
      <Text bold>Select model</Text>
      <Text color={theme.muted}>
        {catalog.totalModels > 0
          ? `${catalog.totalModels} enabled models from ${catalog.groups.length} connected providers`
          : 'No connected provider has an enabled chat model.'}
      </Text>
      <Box marginTop={1}>
        <Text color={theme.dim}>Search </Text>
        <Text color={query ? theme.text : theme.primary}>{queryText}</Text>
      </Box>

      {catalog.totalModels === 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.warning}>Configure a provider in OpenCowork Settings → Models.</Text>
          <Text color={theme.muted}>
            The CLI reads the same provider store and never copies credentials.
          </Text>
        </Box>
      ) : options.length === 0 ? (
        <Box marginTop={1}>
          <Text color={theme.muted}>
            No models match “{fitText(query, Math.max(8, width - 22))}”.
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {visibleOptions.map((option, visibleIndex) => {
            const absoluteIndex = windowStart + visibleIndex
            const selected = absoluteIndex === selectedIndex
            const previous = options[absoluteIndex - 1]
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
                  {isCurrent ? <Text color={theme.success}> current</Text> : null}
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
          Type to search · ↑↓ navigate · Enter select · Esc cancel
        </Text>
      </Box>
    </Box>
  )
}
