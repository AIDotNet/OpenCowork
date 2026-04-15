import type { ToolResultContent } from '@renderer/lib/api/types'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'

export type SearchToolSummary = {
  kind: 'glob' | 'grep'
  matchCount: number
  fileCount: number
  truncated: boolean
  timedOut: boolean
  error?: string
}

function outputAsString(output: ToolResultContent | undefined): string | undefined {
  if (output === undefined) return undefined
  if (typeof output === 'string') return output
  const texts = output
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
  return texts.join('\n') || undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeGlobSummary(decoded: unknown): SearchToolSummary | null {
  if (Array.isArray(decoded)) {
    return {
      kind: 'glob',
      matchCount: decoded.length,
      fileCount: decoded.length,
      truncated: false,
      timedOut: false
    }
  }
  if (!isRecord(decoded)) return null
  const matches = Array.isArray(decoded.matches)
    ? decoded.matches
    : Array.isArray(decoded.results)
      ? decoded.results
      : []
  return {
    kind: 'glob',
    matchCount: matches.length,
    fileCount: matches.length,
    truncated: decoded.truncated === true,
    timedOut: decoded.timedOut === true,
    error: typeof decoded.error === 'string' ? decoded.error : undefined
  }
}

function normalizeGrepSummary(decoded: unknown): SearchToolSummary | null {
  if (Array.isArray(decoded)) {
    const fileCount = new Set(
      decoded
        .map((item) => (isRecord(item) ? (item.file ?? item.path) : null))
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
    ).size
    return {
      kind: 'grep',
      matchCount: decoded.length,
      fileCount,
      truncated: false,
      timedOut: false
    }
  }
  if (!isRecord(decoded)) return null
  const matches = Array.isArray(decoded.matches)
    ? decoded.matches
    : Array.isArray(decoded.results)
      ? decoded.results
      : []
  const fileCount = new Set(
    matches
      .map((item) => (isRecord(item) ? (item.file ?? item.path) : null))
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
  ).size
  return {
    kind: 'grep',
    matchCount: matches.length,
    fileCount,
    truncated: decoded.truncated === true,
    timedOut: decoded.timedOut === true,
    error: typeof decoded.error === 'string' ? decoded.error : undefined
  }
}

export function summarizeSearchToolOutput(
  name: string,
  output: ToolResultContent | undefined
): SearchToolSummary | null {
  const text = outputAsString(output)
  if (!text?.trim()) return null
  const decoded = decodeStructuredToolResult(text)
  if (!decoded) return null
  if (name === 'Glob') return normalizeGlobSummary(decoded)
  if (name === 'Grep') return normalizeGrepSummary(decoded)
  return null
}

function truncateSummary(value: string, max = 140): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value
}

function firstMeaningfulLine(text: string | undefined): string | null {
  if (!text) return null
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0)
  return line ? line.replace(/\s+/g, ' ') : null
}

function summarizeBashInput(input: Record<string, unknown>, outputText?: string): string {
  const command = typeof input.command === 'string' ? input.command.slice(0, 80) : ''
  if (!outputText?.trim()) return command

  const decoded = decodeStructuredToolResult(outputText)
  let preview: string | null = null

  if (isRecord(decoded)) {
    const stdout =
      typeof decoded.stdout === 'string'
        ? decoded.stdout
        : typeof decoded.output === 'string'
          ? decoded.output
          : undefined
    const stderr = typeof decoded.stderr === 'string' ? decoded.stderr : undefined
    const toolError = typeof decoded.error === 'string' ? decoded.error : undefined
    preview =
      firstMeaningfulLine(stdout) ?? firstMeaningfulLine(stderr) ?? firstMeaningfulLine(toolError)
  } else {
    preview = firstMeaningfulLine(outputText)
  }

  if (!preview) return command
  if (!command) return truncateSummary(preview)
  return truncateSummary(`${command} — ${preview}`)
}

function summarizeLsInput(input: Record<string, unknown>, outputText?: string): string {
  const pathSummary = String(input.path ?? '')
    .split(/[\\/]/)
    .filter(Boolean)
    .slice(-2)
    .join('/')

  if (!outputText?.trim()) return pathSummary

  const decoded = decodeStructuredToolResult(outputText)
  if (!Array.isArray(decoded)) return pathSummary

  const names = decoded
    .map((item) => {
      if (!isRecord(item) || typeof item.name !== 'string') return null
      const suffix = item.type === 'directory' ? '/' : ''
      return `${item.name}${suffix}`
    })
    .filter((item): item is string => !!item)

  if (names.length === 0) return pathSummary
  const preview = truncateSummary(names.slice(0, 4).join(', '), 100)
  return pathSummary ? truncateSummary(`${pathSummary} — ${preview}`) : preview
}

export function inputSummary(
  name: string,
  input: Record<string, unknown>,
  outputText?: string
): string {
  if (name === 'Bash') return summarizeBashInput(input, outputText)
  if (name === 'LS') return summarizeLsInput(input, outputText)
  if (['Read', 'Write', 'SavePlan'].includes(name)) {
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
  if (name === 'visualize_show_widget') {
    const title = typeof input.title === 'string' ? input.title : ''
    const widgetCode = typeof input.widget_code === 'string' ? input.widget_code.trim() : ''
    const kind = widgetCode.startsWith('<svg') ? 'SVG' : 'HTML'
    return title ? `${title} (${kind})` : kind
  }
  const keys = Object.keys(input)
  if (keys.length === 0) return ''
  const first = input[keys[0]]
  const val = typeof first === 'string' ? first : JSON.stringify(first)
  return val.length > 60 ? `${val.slice(0, 60)}...` : val
}
