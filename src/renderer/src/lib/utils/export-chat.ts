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
      const extras: string[] = []
      if (msg.usage.cacheReadTokens) extras.push(`${msg.usage.cacheReadTokens} cached`)
      if (msg.usage.reasoningTokens) extras.push(`${msg.usage.reasoningTokens} reasoning`)
      lines.push(`<sub>Tokens: ${msg.usage.inputTokens} in / ${msg.usage.outputTokens} out${extras.length > 0 ? ` / ${extras.join(' / ')}` : ''}</sub>`)
    }
    lines.push('')
  }

  // Total token usage summary
  const totals = session.messages.reduce(
    (acc, m) => {
      if (m.usage) {
        acc.input += m.usage.inputTokens; acc.output += m.usage.outputTokens
        if (m.usage.cacheReadTokens) acc.cacheRead += m.usage.cacheReadTokens
        if (m.usage.cacheCreationTokens) acc.cacheCreation += m.usage.cacheCreationTokens
        if (m.usage.reasoningTokens) acc.reasoning += m.usage.reasoningTokens
      }
      return acc
    },
    { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, reasoning: 0 }
  )
  if (totals.input + totals.output > 0) {
    lines.push('---')
    lines.push('')
    const totalExtras: string[] = []
    if (totals.cacheRead > 0) totalExtras.push(`${totals.cacheRead} cache read`)
    if (totals.cacheCreation > 0) totalExtras.push(`${totals.cacheCreation} cache write`)
    if (totals.reasoning > 0) totalExtras.push(`${totals.reasoning} reasoning`)
    lines.push(`**Total tokens**: ${totals.input + totals.output} (${totals.input} input + ${totals.output} output${totalExtras.length > 0 ? ` | ${totalExtras.join(', ')}` : ''})`)
    lines.push('')
  }

  return lines.join('\n')
}
