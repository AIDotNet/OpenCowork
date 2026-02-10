import type { ContentBlock } from '../api/types'
import type { Session } from '../../stores/chat-store'

function contentToMarkdown(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content

  return content
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text
        case 'tool_use': {
          const isSubAgent = ['CodeSearch', 'CodeReview', 'Planner'].includes(block.name)
          if (isSubAgent) {
            const query = String((block.input as Record<string, unknown>).query ?? (block.input as Record<string, unknown>).task ?? (block.input as Record<string, unknown>).target ?? '')
            return `**🧠 SubAgent: \`${block.name}\`** — ${query}`
          }
          return `**Tool Call: \`${block.name}\`**\n\`\`\`json\n${JSON.stringify(block.input, null, 2)}\n\`\`\``
        }
        case 'tool_result':
          return `**Tool Result** (${block.isError ? 'error' : 'success'}):\n\`\`\`\n${block.content}\n\`\`\``
        default:
          return ''
      }
    })
    .filter(Boolean)
    .join('\n\n')
}

export function sessionToMarkdown(session: Session): string {
  const lines: string[] = []
  lines.push(`# ${session.title}`)
  lines.push('')
  lines.push(`- **Mode**: ${session.mode}`)
  lines.push(`- **Messages**: ${session.messages.filter((m) => m.role !== 'system').length}`)
  lines.push(`- **Created**: ${new Date(session.createdAt).toLocaleString()}`)
  lines.push(`- **Updated**: ${new Date(session.updatedAt).toLocaleString()}`)
  if (session.workingFolder) {
    lines.push(`- **Working Folder**: \`${session.workingFolder}\``)
  }
  if (session.pinned) {
    lines.push(`- **Pinned**: Yes`)
  }
  lines.push('')
  lines.push('---')
  lines.push('')

  for (const msg of session.messages) {
    if (msg.role === 'system') continue
    const label = msg.role === 'user' ? '## User' : '## Assistant'
    const time = new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    lines.push(`${label} <sub>${time}</sub>`)
    lines.push('')
    lines.push(contentToMarkdown(msg.content))
    if (msg.usage) {
      lines.push('')
      lines.push(`<sub>Tokens: ${msg.usage.inputTokens} in / ${msg.usage.outputTokens} out</sub>`)
    }
    lines.push('')
  }

  // Total token usage summary
  const totals = session.messages.reduce(
    (acc, m) => {
      if (m.usage) { acc.input += m.usage.inputTokens; acc.output += m.usage.outputTokens }
      return acc
    },
    { input: 0, output: 0 }
  )
  if (totals.input + totals.output > 0) {
    lines.push('---')
    lines.push('')
    lines.push(`**Total tokens**: ${totals.input + totals.output} (${totals.input} input + ${totals.output} output)`)
    lines.push('')
  }

  return lines.join('\n')
}
