import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { t } from '../i18n.js'
import { fitText } from '../lib/text.js'
import { theme } from '../theme.js'
import type { PermissionDecision, PermissionRequest } from '../types.js'

const options: Array<{ decision: PermissionDecision; key: string; defaultLabel: string }> = [
  { decision: 'allow_once', key: 'cli.permission.yes', defaultLabel: 'Yes' },
  {
    decision: 'allow_session',
    key: 'cli.permission.yesSession',
    defaultLabel: "Yes, and don't ask again this session"
  },
  {
    decision: 'deny',
    key: 'cli.permission.noChange',
    defaultLabel: 'No, and tell OpenCowork what to do differently'
  }
]

interface PermissionPromptProps {
  onDecision(decision: PermissionDecision): void
  request: PermissionRequest
  width: number
}

export function PermissionPrompt({
  onDecision,
  request,
  width
}: PermissionPromptProps): React.JSX.Element {
  const [selectedIndex, setSelectedIndex] = useState(0)

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onDecision('deny')
      return
    }
    if (input === '1' || input === '2' || input === '3') {
      onDecision(options[Number(input) - 1]?.decision ?? 'deny')
      return
    }
    if (key.upArrow || key.leftArrow) {
      setSelectedIndex((current) => (current === 0 ? options.length - 1 : current - 1))
    }
    if (key.downArrow || key.rightArrow) {
      setSelectedIndex((current) => (current + 1) % options.length)
    }
    if (key.return) onDecision(options[selectedIndex]?.decision ?? 'deny')
  })

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={2} width={width}>
      <Text bold color={theme.warning}>
        {t('cli.panels.permission', 'Permission required')}
      </Text>
      <Box marginTop={1}>
        <Text>
          {t('cli.permission.wantsToUse', 'OpenCowork wants to use')}{' '}
          <Text bold>{request.tool}</Text>:{t('cli.permission.colon', ':')}
        </Text>
      </Box>
      <Box marginLeft={2} marginTop={1}>
        <Text color={theme.text}>{fitText(request.title, Math.max(12, width - 6))}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text color={theme.muted} wrap="wrap">
          {request.detail}
        </Text>
      </Box>
      {request.risk ? (
        <Box marginLeft={2} marginTop={1}>
          <Text color={theme.warning}>⚠ {request.risk}</Text>
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, index) => {
          const selected = index === selectedIndex
          return (
            <Box key={option.decision}>
              <Text color={selected ? theme.primary : theme.dim}>{selected ? '❯' : ' '} </Text>
              <Text bold={selected}>
                {index + 1}. {t(option.key, option.defaultLabel)}
              </Text>
            </Box>
          )
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>
          {t('cli.permission.confirm', 'Enter to confirm · Esc to cancel')}
        </Text>
      </Box>
    </Box>
  )
}
