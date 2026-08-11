import React from 'react'
import { Box, Text } from 'ink'
import { t } from '../i18n.js'
import { fitText, padText } from '../lib/text.js'
import { theme } from '../theme.js'
import type { FileReferenceCandidate } from '../types.js'

interface FileReferenceMenuProps {
  error?: string
  loading: boolean
  results: FileReferenceCandidate[]
  selectedIndex: number
  width: number
}

export function FileReferenceMenu({
  error,
  loading,
  results,
  selectedIndex,
  width
}: FileReferenceMenuProps): React.JSX.Element {
  const visibleCount = 8
  const safeSelectedIndex = Math.max(0, Math.min(selectedIndex, results.length - 1))
  const windowStart = Math.max(
    0,
    Math.min(safeSelectedIndex - Math.floor(visibleCount / 2), results.length - visibleCount)
  )
  const visible = results.slice(windowStart, windowStart + visibleCount)

  if (visible.length === 0) {
    return (
      <Box paddingLeft={2}>
        <Text color={error ? theme.error : theme.dim}>
          {error ??
            (loading
              ? t('cli.files.searching', 'Searching files…')
              : t('cli.files.noMatches', 'No matching files'))}
        </Text>
      </Box>
    )
  }

  const nameWidth = Math.min(28, Math.max(14, Math.floor(width * 0.32)))
  const aboveCount = windowStart
  const belowCount = results.length - windowStart - visible.length

  return (
    <Box flexDirection="column" width={width}>
      {visible.map((file, index) => {
        const absoluteIndex = windowStart + index
        const selected = absoluteIndex === safeSelectedIndex
        const line = `${padText(file.name, nameWidth)}${fitText(
          file.path,
          Math.max(8, width - nameWidth - 2)
        )}`

        return (
          <Box key={file.path} paddingLeft={selected ? 0 : 2}>
            {selected ? <Text color={theme.primary}>❯ </Text> : null}
            <Text
              backgroundColor={selected ? theme.selectedBackground : undefined}
              color={selected ? theme.selectedText : theme.text}
            >
              {line}
            </Text>
          </Box>
        )
      })}
      {loading ? (
        <Box paddingLeft={2}>
          <Text color={theme.dim}>{t('cli.common.refreshing', 'Refreshing…')}</Text>
        </Box>
      ) : aboveCount > 0 || belowCount > 0 ? (
        <Box paddingLeft={2}>
          <Text color={theme.dim}>
            {[
              aboveCount > 0 ? `↑ ${aboveCount} ${t('cli.common.above', 'above')}` : '',
              belowCount > 0 ? `↓ ${belowCount} ${t('cli.common.more', 'more')}` : ''
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}
