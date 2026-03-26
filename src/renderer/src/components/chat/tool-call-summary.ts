export function inputSummary(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash' && input.command) return String(input.command).slice(0, 80)
  if (['Read', 'Write', 'SavePlan', 'LS'].includes(name)) {
    const preview =
      name === 'SavePlan' && typeof input.content_preview === 'string'
        ? String(input.content_preview)
        : null
    if (preview) return preview.slice(0, 80)
    const p = String(input.file_path ?? input.path ?? '')
    return p.split(/[\\/]/).slice(-2).join('/')
  }
  if (name === 'Edit') {
    const p = String(input.file_path ?? input.path ?? '')
      .split(/[\\/]/)
      .slice(-2)
      .join('/')
    const expl = typeof input.explanation === 'string' ? ` - ${input.explanation.slice(0, 50)}` : ''
    return `${p}${expl}`
  }
  if (name === 'Delete') {
    const p = String(input.file_path ?? input.path ?? '')
    return `delete: ${p.split(/[\\/]/).slice(-2).join('/')}`
  }
  if (name === 'Glob' && input.pattern) return `pattern: ${input.pattern}`
  if (name === 'Grep' && input.pattern) return `grep: ${input.pattern}`
  if (name === 'TaskCreate' && input.subject) return String(input.subject).slice(0, 60)
  if (name === 'TaskUpdate' && input.taskId)
    return `#${input.taskId}${input.status ? ` -> ${input.status}` : ''}`
  if (name === 'TaskGet' && input.taskId) return `#${input.taskId}`
  if (name === 'TaskList') return 'list tasks'
  if (name === 'CronAdd') {
    const n = input.name ? String(input.name) : ''
    const sched = input.schedule as { kind?: string; expr?: string } | undefined
    const kindLabel = sched?.kind ?? ''
    const expr = sched?.expr ?? ''
    return n ? `${n} (${kindLabel}${expr ? ` ${expr}` : ''})` : kindLabel
  }
  if (name === 'CronUpdate' && input.jobId) return `update: ${String(input.jobId)}`
  if (name === 'CronRemove' && input.jobId) return `remove: ${String(input.jobId)}`
  if (name === 'CronList') return 'list cron jobs'
  if (name === 'AskUserQuestion') {
    const qs = input.questions as Array<{ question?: string }> | undefined
    if (qs && qs.length > 0) return String(qs[0].question ?? '').slice(0, 60)
    return 'asking user...'
  }
  if (name === 'Task')
    return `[${input.subagent_type ?? '?'}] ${String(input.description ?? '').slice(0, 50)}`
  const keys = Object.keys(input)
  if (keys.length === 0) return ''
  const first = input[keys[0]]
  const val = typeof first === 'string' ? first : JSON.stringify(first)
  return val.length > 60 ? `${val.slice(0, 60)}...` : val
}
