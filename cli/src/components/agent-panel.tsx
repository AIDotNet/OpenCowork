import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { fitText, hasTerminalInputControl } from '../lib/text.js'
import { theme } from '../theme.js'
import type { AgentOption } from '../types.js'

interface AgentPanelProps {
  agents: AgentOption[]
  maxVisible: number
  onCancel(): void
  width: number
}

export function AgentPanel({
  agents,
  maxVisible,
  onCancel,
  width
}: AgentPanelProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const queryRef = useRef('')
  const queryTimerRef = useRef<NodeJS.Timeout | undefined>(undefined)
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return agents
    return agents.filter((agent) =>
      `${agent.name} ${agent.description} ${agent.model ?? ''}`
        .toLocaleLowerCase()
        .includes(normalized)
    )
  }, [agents, query])
  const [selectedIndex, setSelectedIndex] = useState(0)

  useEffect(() => {
    setSelectedIndex((index) => Math.max(0, Math.min(index, filtered.length - 1)))
  }, [filtered.length])

  useEffect(
    () => () => {
      if (queryTimerRef.current) clearTimeout(queryTimerRef.current)
    },
    []
  )

  const updateQuery = (next: string): void => {
    queryRef.current = next
    if (queryTimerRef.current) clearTimeout(queryTimerRef.current)
    queryTimerRef.current = setTimeout(() => setQuery(queryRef.current), 100)
  }

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c') || key.return) {
      onCancel()
      return
    }
    if (key.upArrow) {
      setSelectedIndex((index) => (index <= 0 ? Math.max(0, filtered.length - 1) : index - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex((index) => (filtered.length > 0 ? (index + 1) % filtered.length : 0))
      return
    }
    if (key.ctrl && input === 'u') {
      updateQuery('')
      setSelectedIndex(0)
      return
    }
    if (key.backspace || key.delete) {
      updateQuery(Array.from(queryRef.current).slice(0, -1).join(''))
      setSelectedIndex(0)
      return
    }
    if (!key.ctrl && !key.meta && input && !hasTerminalInputControl(input)) {
      updateQuery(queryRef.current + input)
      setSelectedIndex(0)
    }
  })

  const visibleCount = Math.max(2, maxVisible)
  const windowStart = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(visibleCount / 2), filtered.length - visibleCount)
  )
  const visible = filtered.slice(windowStart, windowStart + visibleCount)
  const queryText = query ? `${query}▏` : '▏'

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={2} width={width}>
      <Text bold>Agents</Text>
      <Text color={theme.muted}>
        {agents.length} Native Worker sub-agents · Task delegates work without a second runtime
      </Text>
      <Box marginTop={1}>
        <Text color={theme.dim}>Search </Text>
        <Text color={query ? theme.text : theme.primary}>{queryText}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {visible.length === 0 ? (
          <Text color={theme.muted}>
            No agents match “{fitText(query, Math.max(8, width - 20))}”.
          </Text>
        ) : (
          visible.map((agent, visibleIndex) => {
            const index = windowStart + visibleIndex
            const selected = index === selectedIndex
            const nameWidth = Math.max(12, Math.min(24, Math.floor(width * 0.28)))
            const metadata = agent.model ? ` · ${agent.model}` : ''
            return (
              <Box key={agent.name}>
                <Text color={selected ? theme.primary : theme.dim}>{selected ? '❯' : ' '} </Text>
                <Text bold={selected}>{fitText(agent.name, nameWidth)}</Text>
                <Text color={theme.muted}>
                  {'  '}
                  {fitText(`${agent.description}${metadata}`, Math.max(10, width - nameWidth - 7))}
                </Text>
              </Box>
            )
          })
        )}
        {Array.from({
          length: Math.max(0, visibleCount - Math.max(1, visible.length))
        }).map((_, index) => (
          <Text key={`agent-panel-spacer-${index}`}> </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>
          {fitText(
            'Type to search · ↑↓ inspect · Enter/Esc close · configure in ~/.open-cowork/agents',
            Math.max(12, width - 4)
          )}
        </Text>
      </Box>
    </Box>
  )
}
