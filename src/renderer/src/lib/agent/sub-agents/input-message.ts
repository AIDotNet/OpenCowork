import { nanoid } from 'nanoid'
import type { ContentBlock, UnifiedMessage } from '../../api/types'

const SUB_AGENT_FINAL_REPORT_REMINDER = `Your final assistant message is returned verbatim to the parent agent as the task report. End every run with a self-contained report, whether the task succeeded, partially succeeded, was blocked, or failed. Do not call tools after writing that final report.`

function buildSubAgentSystemReminderBlock(): ContentBlock {
  return {
    type: 'text',
    text: `<system-remind>\n${SUB_AGENT_FINAL_REPORT_REMINDER}\n</system-remind>`
  }
}

export function buildSubAgentPromptText(
  input: Record<string, unknown>,
  initialPrompt?: string
): string {
  const parts: string[] = []

  if (initialPrompt?.trim()) {
    parts.push(initialPrompt.trim())
  }

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

export function buildSubAgentPromptContent(
  input: Record<string, unknown>,
  initialPrompt?: string
): ContentBlock[] {
  return [
    {
      type: 'text',
      text: buildSubAgentPromptText(input, initialPrompt)
    },
    buildSubAgentSystemReminderBlock()
  ]
}

export function createSubAgentPromptMessage(
  input: Record<string, unknown>,
  createdAt = Date.now(),
  initialPrompt?: string
): UnifiedMessage {
  return {
    id: nanoid(),
    role: 'user',
    content: buildSubAgentPromptContent(input, initialPrompt),
    createdAt
  }
}
