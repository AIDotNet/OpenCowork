import { useUIStore } from '../../stores/ui-store'
import { useChatStore } from '../../stores/chat-store'
import { useTaskStore } from '../../stores/task-store'
import { usePlanStore } from '../../stores/plan-store'
import { useSettingsStore } from '../../stores/settings-store'
import { ipcClient } from '../ipc/ipc-client'
import { estimateTokens } from '../format-tokens'
import type { AIModelConfig } from '../api/types'
import type { LayeredMemorySnapshot, SessionMemoryScope } from './memory-files'

const FILE_CONTEXT_BUDGET_RATIO = 0.25
const FILE_CONTEXT_BUDGET_MAX_TOKENS = 24_000
const FILE_CONTEXT_FALLBACK_TOKENS = 12_000

/**
 * Build a runtime reminder injected into the last user message.
 * Includes lightweight session state and selected file contents.
 */
export async function buildRuntimeReminder(options: {
  sessionId: string
  modelConfig?: AIModelConfig | null
}): Promise<string> {
  const { sessionId, modelConfig } = options

  const parts: string[] = []
  const sessionStateContext = buildSessionStateContext(sessionId)
  if (sessionStateContext) {
    parts.push(sessionStateContext)
  }

  const selectedFiles = useUIStore.getState().selectedFiles ?? []
  const session = useChatStore.getState().sessions.find((s) => s.id === sessionId)
  const workingFolder = session?.workingFolder
  const sshConnectionId = session?.sshConnectionId

  if (selectedFiles.length > 0) {
    const selectedFileContext = await buildSelectedFileContext(
      selectedFiles,
      workingFolder,
      sshConnectionId,
      modelConfig
    )
    if (selectedFileContext) {
      parts.push(selectedFileContext)
    }
  }

  if (parts.length === 0) {
    return ''
  }

  return `<system-reminder>\n${parts.join('\n')}\n</system-reminder>`
}

export function buildMemoryContext(
  snapshot: LayeredMemorySnapshot,
  sessionScope: SessionMemoryScope = 'main'
): string | null {
  const parts: string[] = []
  appendMemoryContext(parts, snapshot, sessionScope)
  return parts.length > 0 ? parts.join('\n') : null
}

function buildSessionStateContext(sessionId: string): string | null {
  const parts: string[] = ['Session State:']

  if (useSettingsStore.getState().webSearchEnabled) {
    parts.push(
      '- Web Search: enabled. Use the WebSearch tool for current external information when useful.'
    )
  }

  const tasks = useTaskStore.getState().getTasksBySession(sessionId)
  if (tasks.length > 0) {
    const pending = tasks.filter((task) => task.status === 'pending').length
    const inProgress = tasks.filter((task) => task.status === 'in_progress').length
    const completed = tasks.filter((task) => task.status === 'completed').length
    parts.push(
      `- Task List: ${tasks.length} tasks (${pending} pending, ${inProgress} in_progress, ${completed} completed)`
    )
    if (inProgress > 0 || pending > 0) {
      parts.push(
        '  Reminder: Continue with existing tasks and use TaskUpdate to keep status current.'
      )
    }
  }

  const plan = usePlanStore.getState().getPlanBySession(sessionId)
  if (plan) {
    parts.push(`- Plan: "${plan.title}" (status: ${plan.status})`)
    if (plan.status === 'approved' || plan.status === 'implementing') {
      parts.push('  Reminder: An approved plan exists. Follow the plan steps for implementation.')
    }
    if (plan.status === 'rejected') {
      parts.push('  Reminder: The plan was rejected. Revise it in Plan Mode based on feedback.')
    }
  }

  return parts.length > 1 ? parts.join('\n') : null
}

async function buildSelectedFileContext(
  selectedFiles: string[],
  workingFolder?: string,
  sshConnectionId?: string,
  modelConfig?: AIModelConfig | null
): Promise<string> {
  const budget = resolveFileContextBudget(modelConfig)
  let usedTokens = 0
  const fileSections: string[] = []
  const skipped: string[] = []

  for (const filePath of selectedFiles) {
    const displayPath =
      workingFolder && filePath.startsWith(workingFolder)
        ? filePath.slice(workingFolder.length).replace(/^[\\/]/, '')
        : filePath

    try {
      const content = await ipcClient.invoke(
        sshConnectionId ? 'ssh:fs:read-file' : 'fs:read-file',
        sshConnectionId ? { connectionId: sshConnectionId, path: filePath } : { path: filePath }
      )
      if (typeof content !== 'string') {
        skipped.push(`${displayPath} [unreadable]`)
        continue
      }

      const section = [`## ${displayPath}`, content].join('\n')
      const sectionTokens = estimateTokens(section)
      if (usedTokens + sectionTokens <= budget) {
        fileSections.push(section)
        usedTokens += sectionTokens
        continue
      }

      const remainingBudget = budget - usedTokens
      if (remainingBudget <= 0) {
        skipped.push(`${displayPath} [skipped: context budget exceeded]`)
        continue
      }

      const truncated = truncateToTokenBudget(content, remainingBudget)
      if (!truncated.trim()) {
        skipped.push(`${displayPath} [skipped: context budget exceeded]`)
        continue
      }

      fileSections.push(`## ${displayPath}\n${truncated}\n[Truncated due to context budget]`)
      usedTokens = budget
    } catch {
      skipped.push(`${displayPath} [read failed]`)
    }
  }

  if (fileSections.length === 0 && skipped.length === 0) {
    return ''
  }

  const lines = ['<selected_files>', `Selected Files: ${selectedFiles.length}`]
  if (fileSections.length > 0) {
    lines.push(...fileSections)
  }
  if (skipped.length > 0) {
    lines.push('## Skipped Files', ...skipped.map((item) => `- ${item}`))
  }
  lines.push('</selected_files>')
  return lines.join('\n')
}

function resolveFileContextBudget(modelConfig?: AIModelConfig | null): number {
  const contextLength = modelConfig?.contextLength
  if (typeof contextLength !== 'number' || contextLength <= 0) {
    return FILE_CONTEXT_FALLBACK_TOKENS
  }
  return Math.min(
    FILE_CONTEXT_BUDGET_MAX_TOKENS,
    Math.max(4_000, Math.floor(contextLength * FILE_CONTEXT_BUDGET_RATIO))
  )
}

function truncateToTokenBudget(content: string, tokenBudget: number): string {
  if (!content || tokenBudget <= 0) return ''
  const lines = content.split(/\r?\n/)
  const kept: string[] = []
  for (const line of lines) {
    const candidate = kept.length > 0 ? `${kept.join('\n')}\n${line}` : line
    if (estimateTokens(candidate) > tokenBudget) {
      break
    }
    kept.push(line)
  }
  return kept.join('\n')
}

function appendMemoryContext(
  parts: string[],
  snapshot: LayeredMemorySnapshot,
  sessionScope: SessionMemoryScope
): void {
  const agentsMemory = snapshot.agents?.content?.trim()
  const globalSoul = snapshot.globalSoul?.content?.trim()
  const projectSoul = snapshot.projectSoul?.content?.trim()
  const globalUser = snapshot.globalUser?.content?.trim()
  const projectUser = snapshot.projectUser?.content?.trim()
  const globalMemory = snapshot.globalMemory?.content?.trim()
  const projectMemory = snapshot.projectMemory?.content?.trim()
  const globalMemoryPath = snapshot.globalMemory?.path?.trim()
  const globalDailyMemory = snapshot.globalDailyMemory ?? []
  const projectDailyMemory = snapshot.projectDailyMemory ?? []

  if (sessionScope === 'main') {
    parts.push(
      `\n<memory_loading_policy>`,
      `Session scope: MAIN. Load workspace protocol plus long-term persona, user profile, and curated memory layers.`,
      `Project-level files override global defaults when both exist. System prompt rules still take priority over all memory files.`,
      `SOUL.md defines your core identity, personality, tone, and behavioral constraints. You MUST embody and adhere to its directives throughout the entire conversation without exception, even when they are not explicitly repeated in follow-up messages.`,
      `</memory_loading_policy>`
    )
  } else {
    parts.push(
      `\n<memory_loading_policy>`,
      `Session scope: SHARED. Do not rely on SOUL.md, USER.md, MEMORY.md, or daily memory files in shared contexts.`,
      `Use only the system prompt, current shared-session context, and any explicitly provided runtime details.`,
      `</memory_loading_policy>`
    )
  }

  if (agentsMemory) {
    parts.push(
      `\n<project_memory>`,
      `The following is project AGENTS.md loaded from the workspace memory layer. Treat it as authoritative workspace protocol and project context.`,
      ``,
      agentsMemory,
      `</project_memory>`
    )
  }

  if (sessionScope === 'main' && globalSoul) {
    parts.push(
      `\n<global_soul priority="high">`,
      `The following is global SOUL.md from \`${snapshot.globalSoul?.path}\`.`,
      `This file defines your **core identity, personality, communication style, and behavioral rules**. You MUST internalize and follow every directive below for the ENTIRE conversation. Do NOT revert to generic assistant behavior. When in doubt, re-read and comply with this section.`,
      ``,
      globalSoul,
      ``,
      `[END OF SOUL — Remember: the above directives override default behavior and apply to every response you produce.]`,
      `</global_soul>`
    )
  }

  if (sessionScope === 'main' && projectSoul) {
    parts.push(
      `\n<project_soul priority="high">`,
      `The following is project SOUL.md from \`${snapshot.projectSoul?.path}\`. It refines or overrides the global soul for this workspace. Where it conflicts with global SOUL.md, this file wins.`,
      `You MUST follow these project-level identity and style directives throughout the conversation.`,
      ``,
      projectSoul,
      `</project_soul>`
    )
  }

  if (sessionScope === 'main' && globalUser) {
    parts.push(
      `\n<global_user>`,
      `The following is global USER.md from \`${snapshot.globalUser?.path}\`, describing the human you are helping across projects.`,
      ``,
      globalUser,
      `</global_user>`
    )
  }

  if (sessionScope === 'main' && projectUser) {
    parts.push(
      `\n<project_user>`,
      `The following is project USER.md from \`${snapshot.projectUser?.path}\`. It adds workspace-specific user preferences and goals.`,
      ``,
      projectUser,
      `</project_user>`
    )
  }

  if (sessionScope === 'main' && globalDailyMemory.length > 0) {
    parts.push(
      `\n<global_daily_memory>`,
      `Recent global daily memory files provide short-term continuity.`,
      ...globalDailyMemory.flatMap((entry) => [
        `\n## ${entry.date} — \`${entry.path}\``,
        entry.content ?? ''
      ]),
      `</global_daily_memory>`
    )
  }

  if (sessionScope === 'main' && projectDailyMemory.length > 0) {
    parts.push(
      `\n<project_daily_memory>`,
      `Recent project daily memory files provide short-term workspace continuity.`,
      ...projectDailyMemory.flatMap((entry) => [
        `\n## ${entry.date} — \`${entry.path}\``,
        entry.content ?? ''
      ]),
      `</project_daily_memory>`
    )
  }

  if (sessionScope === 'main' && globalMemory) {
    parts.push(
      `\n<global_memory>`,
      `The following is global MEMORY.md from \`${globalMemoryPath}\`, containing curated cross-session memory.`,
      ``,
      globalMemory,
      `</global_memory>`
    )
  }

  if (sessionScope === 'main' && projectMemory) {
    parts.push(
      `\n<project_long_term_memory>`,
      `The following is project MEMORY.md from \`${snapshot.projectMemory?.path}\`, containing workspace-specific long-term memory.`,
      ``,
      projectMemory,
      `</project_long_term_memory>`
    )
  }
}
