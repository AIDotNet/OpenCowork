import { nanoid } from 'nanoid'
import type { ContentBlock, UnifiedMessage } from '../../api/types'

const SUB_AGENT_TERMINATION_PROTOCOL = `Session termination protocol:
- When you are done with the task, you MUST end the session by calling the \`SubmitReport\` tool exactly once.
- Calling \`SubmitReport\` terminates this sub-agent session immediately -- do NOT call any other tools afterwards.
- Do NOT stop by simply emitting an assistant message. Plain-text endings are treated as "session ran out" and trigger a fallback report synthesis you cannot control.
- Do NOT call \`SubmitReport\` with an empty \`report\` argument; empty submissions are rejected and you will be asked to retry.
- Write the report in the same language as the user's request.
- If evidence is incomplete, state the uncertainty inside the report, but still submit it.
- Even when nothing useful is found, submit a short report instead of leaving the session dangling.

Structure the \`report\` argument with these sections:
## Conclusion
## Key Findings
## Evidence
## Risks / Unknowns
## Next Steps`

function buildSubAgentSystemReminderBlock(): ContentBlock {
  return {
    type: 'text',
    text: `<system-remind>\n${SUB_AGENT_TERMINATION_PROTOCOL}\n</system-remind>`
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
