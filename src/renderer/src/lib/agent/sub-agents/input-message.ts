import { nanoid } from 'nanoid'
import type { UnifiedMessage } from '../../api/types'

export function buildSubAgentPromptText(input: Record<string, unknown>): string {
  const parts: string[] = []

  if (input.prompt) {
    parts.push(String(input.prompt))
  } else if (input.query) {
    parts.push(String(input.query))
  } else if (input.task) {
    parts.push(String(input.task))
  } else if (input.target) {
    parts.push(`Analyze: ${input.target}`)
    if (input.focus) parts.push(`Focus: ${input.focus}`)
  } else {
    parts.push(JSON.stringify(input, null, 2))
  }

  if (input.scope) {
    parts.push(`\nScope: ${input.scope}`)
  }
  if (input.constraints) {
    parts.push(`\nConstraints: ${input.constraints}`)
  }

  return parts.join('\n')
}

export function createSubAgentPromptMessage(
  input: Record<string, unknown>,
  createdAt = Date.now()
): UnifiedMessage {
  return {
    id: nanoid(),
    role: 'user',
    content: buildSubAgentPromptText(input),
    createdAt
  }
}
