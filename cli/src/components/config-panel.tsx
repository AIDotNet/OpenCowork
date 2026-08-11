import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { fitText, hasTerminalInputControl } from '../lib/text.js'
import { theme } from '../theme.js'
import type { ConfigCatalog, ConfigEntry, ConfigSettingValue } from '../types.js'
import { Spinner } from './spinner.js'

interface ConfigPanelProps {
  catalog: ConfigCatalog
  maxVisible: number
  onCancel(): void
  onChange(key: string, value: ConfigSettingValue): void
  onOpenCompressionModel(): void
  onOpenModel(): void
  onOpenProvider(): void
  savingKey?: string
  width: number
}

function matches(entry: ConfigEntry, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return true
  return [entry.label, entry.category, entry.description, String(entry.value)].some((value) =>
    value.toLocaleLowerCase().includes(normalized)
  )
}

function formatValue(entry: ConfigEntry): string {
  if (entry.kind === 'boolean') return entry.value === true ? 'on' : 'off'
  if (entry.kind === 'enum') {
    return (
      entry.choices?.find((choice) => choice.value === entry.value)?.label ?? String(entry.value)
    )
  }
  if (entry.kind === 'number') {
    const numeric = Number(entry.value)
    if (entry.format === 'percentage') return `${Math.round(numeric * 100)}%`
    if (entry.format === 'seconds') return numeric === 0 ? 'no timeout' : `${numeric}s`
    return String(Math.round(numeric))
  }
  return String(entry.value)
}

function nextValue(entry: ConfigEntry, direction: -1 | 1): ConfigSettingValue | null {
  if (entry.disabled) return null
  if (entry.kind === 'boolean') return entry.value !== true
  if (entry.kind === 'number') {
    const current = Number(entry.value)
    const step = entry.step ?? 1
    const min = entry.min ?? Number.NEGATIVE_INFINITY
    const max = entry.max ?? Number.POSITIVE_INFINITY
    return Number(Math.min(max, Math.max(min, current + step * direction)).toFixed(4))
  }
  if (entry.kind === 'enum' && entry.choices && entry.choices.length > 0) {
    const index = Math.max(
      0,
      entry.choices.findIndex((choice) => choice.value === entry.value)
    )
    const nextIndex = (index + direction + entry.choices.length) % entry.choices.length
    return entry.choices[nextIndex]?.value ?? null
  }
  return null
}

export function ConfigPanel({
  catalog,
  maxVisible,
  onCancel,
  onChange,
  onOpenCompressionModel,
  onOpenModel,
  onOpenProvider,
  savingKey,
  width
}: ConfigPanelProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const filtered = useMemo(
    () => catalog.entries.filter((entry) => matches(entry, query)),
    [catalog.entries, query]
  )
  const [selectedIndex, setSelectedIndex] = useState(0)

  useEffect(() => {
    setSelectedIndex((index) => Math.max(0, Math.min(index, filtered.length - 1)))
  }, [filtered.length])

  const activate = (entry: ConfigEntry | undefined, direction: -1 | 1 = 1): void => {
    if (!entry || savingKey || entry.disabled) return
    if (entry.kind === 'action') {
      if (entry.action === 'model') onOpenModel()
      if (entry.action === 'compressionModel') onOpenCompressionModel()
      if (entry.action === 'provider') onOpenProvider()
      return
    }
    const value = nextValue(entry, direction)
    if (value !== null) onChange(entry.key, value)
  }

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
      return
    }
    if (savingKey) return
    if (key.upArrow) {
      setSelectedIndex((index) => (index <= 0 ? Math.max(0, filtered.length - 1) : index - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex((index) => (filtered.length > 0 ? (index + 1) % filtered.length : 0))
      return
    }
    if (key.leftArrow) {
      activate(filtered[selectedIndex], -1)
      return
    }
    if (key.rightArrow || key.return || input === ' ') {
      activate(filtered[selectedIndex], 1)
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
    Math.min(selectedIndex - Math.floor(visibleCount / 2), filtered.length - visibleCount)
  )
  const visible = filtered.slice(windowStart, windowStart + visibleCount)
  const selected = filtered[selectedIndex]
  const queryText = query ? `${query}▏` : '▏'
  const contentWidth = Math.max(24, width - 4)
  const categoryWidth = Math.max(7, Math.min(10, Math.floor(contentWidth * 0.15)))
  const labelWidth = Math.max(14, Math.min(26, Math.floor(contentWidth * 0.31)))
  const valueWidth = Math.max(10, contentWidth - categoryWidth - labelWidth - 7)

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={2} width={width}>
      <Text bold>Configuration</Text>
      <Text color={theme.muted}>
        Shared with OpenCowork desktop · provider credentials stay in the private provider store
      </Text>
      <Box marginTop={1}>
        <Text color={theme.dim}>Search </Text>
        <Text color={query ? theme.text : theme.primary}>{queryText}</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {visible.length === 0 ? (
          <Text color={theme.muted}>
            No settings match “{fitText(query, Math.max(8, width - 22))}”.
          </Text>
        ) : (
          visible.map((entry, visibleIndex) => {
            const absoluteIndex = windowStart + visibleIndex
            const isSelected = absoluteIndex === selectedIndex
            const isSaving = savingKey === entry.key
            return (
              <Box key={entry.key}>
                <Text color={isSelected ? theme.primary : theme.dim}>
                  {isSelected ? '❯' : ' '}{' '}
                </Text>
                <Text color={theme.dim}>{fitText(entry.category, categoryWidth)}</Text>
                <Text bold={isSelected} color={entry.disabled ? theme.dim : undefined}>
                  {'  '}
                  {fitText(entry.label, labelWidth)}
                </Text>
                <Text color={entry.disabled ? theme.dim : theme.muted}>{'  '}</Text>
                {isSaving ? (
                  <Box>
                    <Spinner />
                    <Text color={theme.muted}> saving</Text>
                  </Box>
                ) : (
                  <Text
                    color={
                      entry.kind === 'boolean' && entry.value === true
                        ? theme.success
                        : entry.kind === 'action'
                          ? theme.accent
                          : theme.muted
                    }
                  >
                    {fitText(formatValue(entry), valueWidth)}
                  </Text>
                )}
              </Box>
            )
          })
        )}
        {Array.from({ length: Math.max(0, visibleCount - Math.max(1, visible.length)) }).map(
          (_, index) => (
            <Text key={`config-panel-spacer-${index}`}> </Text>
          )
        )}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={selected?.disabled ? theme.warning : theme.muted}>
          {fitText(
            selected?.disabled
              ? 'Enable CodeGraph before exposing its full tool surface.'
              : (selected?.description ?? 'No setting selected.'),
            contentWidth
          )}
        </Text>
        <Text color={theme.dim}>
          {fitText(
            `${filtered.length > visible.length ? `${windowStart + 1}–${windowStart + visible.length} of ${filtered.length} · ` : ''}Type to search · ↑↓ navigate · ←→ change · Enter select · Esc close`,
            contentWidth
          )}
        </Text>
      </Box>
    </Box>
  )
}
