import type { ActiveTeam } from '../../../stores/team-store'

export interface TeamPromptSnapshot {
  teamName: string
  role: 'lead' | 'worker'
  permissionMode?: 'default' | 'plan'
  defaultBackend?: 'in-process' | 'isolated-renderer'
  activeMembers?: string[]
}

function getTaskDetails(description: string | null | undefined, subject: string): string | null {
  const trimmed = typeof description === 'string' ? description.trim() : ''
  if (!trimmed || trimmed === subject.trim()) return null
  return trimmed
}

export function buildLeadCoordinatorPrompt(team: ActiveTeam): string {
  const members = team.members.map((member) => member.name)
  const parts: string[] = [
    '## Agent Team Coordinator',
    `You are the lead coordinator of the active team "${team.name}".`,
    'Users only interact with you. Teammate outputs are internal signals, not user-facing replies.',
    'Delegate independent work with Task(run_in_background=true), SendMessage, and task tools. Avoid assigning two teammates to the same file or conflicting scope.',
    'Your teammate prompts must be self-contained. Never assume a worker can see your full conversation context.',
    'Synthesize all teammate results yourself before replying to the user.',
    'When teammates are still running, keep your response brief and wait for more reports instead of continuing to call tools.',
    'Use TeamStatus when you need a runtime snapshot. Clean up with TeamDelete once work is complete.'
  ]

  if (team.permissionMode === 'plan') {
    parts.push(
      'Team permission mode is currently PLAN. Background teammates may request plan approval before implementation. Review, approve, or redirect them explicitly.'
    )
  }

  if (team.defaultBackend) {
    parts.push(`Default team backend: ${team.defaultBackend}.`)
  }

  if (members.length > 0) {
    parts.push(`Current teammates: ${members.join(', ')}`)
  }

  return parts.join('\n')
}

export function buildTeammateAddendum(options: {
  memberName: string
  teamName: string
  language?: string
  task: { id: string; subject: string; description: string } | null
  prompt: string
  workingFolder?: string
  permissionMode?: 'default' | 'plan'
}): string {
  const { memberName, teamName, language, task, prompt, workingFolder, permissionMode } = options

  const parts: string[] = [
    `You are "${memberName}", a worker agent in the "${teamName}" team.`,
    'You are not the user-facing assistant. The user primarily interacts with the lead coordinator.',
    `You MUST respond in ${language === 'zh' ? 'Chinese (中文)' : 'English'} unless explicitly instructed otherwise.`,
    'Plain assistant text is not a reliable inter-agent communication channel. Use SendMessage or the team runtime protocol when coordination is required.',
    'Do not spawn another background teammate. If parallel help is needed, message the lead instead.',
    'Keep your work scoped to your assigned task and avoid unrelated files.'
  ]

  if (task) {
    parts.push('\n## Assigned Task', `**ID:** ${task.id}`, `**Title:** ${task.subject}`)
    const details = getTaskDetails(task.description, task.subject)
    if (details) {
      parts.push(`**Details:** ${details}`)
    }
  }

  parts.push('\n## Direct Instructions', prompt)

  if (workingFolder) {
    parts.push(
      '\n## Working Folder',
      `\`${workingFolder}\``,
      'Resolve relative paths against this folder.'
    )
  }

  parts.push(
    '\n## Team Protocol',
    '- Use TaskUpdate to claim or complete your assigned task accurately.',
    '- Use SendMessage for collaboration; assume the lead cannot see arbitrary assistant text unless you explicitly send it.',
    '- If you receive a shutdown request, finish the current safe boundary and stop promptly.',
    '- Your last assistant message should summarize what changed, what completed, and any follow-up the lead needs.'
  )

  if (permissionMode === 'plan') {
    parts.push(
      '\n## Plan Approval Mode',
      'This team is in PLAN mode. Before implementation, prepare a concise execution plan and request approval from the lead.',
      'Do not modify files or run implementation commands until the lead approves your plan.',
      'After approval, proceed with execution and keep the lead informed if the scope changes.'
    )
  }

  return parts.join('\n')
}
