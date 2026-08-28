import { useUIStore } from '../../stores/ui-store'
import { useChatStore } from '../../stores/chat-store'
import { usePlanStore } from '../../stores/plan-store'
import { useGoalStore } from '../../stores/goal-store'
import { useSettingsStore } from '../../stores/settings-store'
import { useAppPluginStore } from '../../stores/app-plugin-store'
import { CODEGRAPH_SYSTEM_GUIDANCE } from '../tools/codegraph-tool'
import { ipcClient } from '../ipc/ipc-client'
import { estimateTokens } from '../format-tokens'
import type { AIModelConfig } from '../api/types'
import type { LayeredMemorySnapshot, SessionMemoryScope } from './memory-files'
import { buildGoalSessionStateLine } from './goal-context'

const FILE_CONTEXT_BUDGET_RATIO = 0.25
const FILE_CONTEXT_BUDGET_MAX_TOKENS = 24_000
const FILE_CONTEXT_FALLBACK_TOKENS = 12_000

/**
 * Build a runtime reminder passed to the Native Worker as request context.
 * Includes lightweight session state and selected file contents.
 *
 * The session task list is deliberately absent: the Worker owns the tasks table and builds that
 * reminder itself (`AgentRuntimeTaskExecutor.BuildTurnReminder`), so every client gets it rather
 * than only foreground desktop sessions in an agent mode.
 */
export async function buildRuntimeReminder(options: {
  sessionId: string
  modelConfig?: AIModelConfig | null
  /** The outgoing user prompt text — feeds the CodeGraph front-load hook. */
  userPrompt?: string
}): Promise<string> {
  const { sessionId, modelConfig, userPrompt } = options

  const parts: string[] = []
  const sessionStateContext = buildSessionStateContext(sessionId)
  if (sessionStateContext) {
    parts.push(sessionStateContext)
  }

  const selectedFiles = useUIStore.getState().selectedFiles ?? []
  const session = useChatStore.getState().sessions.find((s) => s.id === sessionId)
  const workingFolder = session?.workingFolder
  const sshConnectionId = session?.sshConnectionId

  // CodeGraph enabled + a local working folder -> steer the agent toward
  // codegraph_explore for code-navigation questions (the SERVER_INSTRUCTIONS playbook).
  if (
    workingFolder &&
    !sshConnectionId &&
    useAppPluginStore.getState().isCodeGraphToolAvailable()
  ) {
    parts.push(CODEGRAPH_SYSTEM_GUIDANCE)

    // Front-load hook (M7-W3 decision A, ≙ upstream `codegraph prompt-hook`): for a
    // structural/flow/impact prompt against an indexed project, inject graph-derived
    // context up front so the agent's reflex grep/read has nothing left to find.
    // Additive only — bounded timeout, any failure or non-fire injects nothing.
    if (userPrompt) {
      try {
        const { agentBridge } = await import('../ipc/agent-bridge')
        const hook = (await agentBridge.request(
          'codegraph/prompt-context',
          { prompt: userPrompt, workingFolder },
          15_000
        )) as { fired?: boolean; text?: string } | null
        if (hook?.fired && typeof hook.text === 'string' && hook.text.trim()) {
          parts.push(hook.text)
        }
      } catch {
        // the hook must never break the user's prompt
      }
    }
  }

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

// The newest user message's plain text (string content, or joined text parts) —
// what the CodeGraph front-load hook gates on. Undefined when the last user turn
// has no extractable text (pure image turns etc.).
export function extractLatestUserPromptText(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; content?: unknown } | null
    if (message?.role !== 'user') continue
    if (typeof message.content === 'string') {
      return message.content.trim() ? message.content : undefined
    }
    if (Array.isArray(message.content)) {
      const texts = message.content
        .map((part) =>
          part && typeof part === 'object' && (part as { type?: string }).type === 'text'
            ? (part as { text?: unknown }).text
            : undefined
        )
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      if (texts.length > 0) return texts.join('\n')
    }
    return undefined
  }
  return undefined
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

  const goal = useGoalStore.getState().getGoalBySession(sessionId)
  if (goal) {
    parts.push(buildGoalSessionStateLine(goal))
    if (goal.status === 'active') {
      parts.push('  Reminder: Keep working toward the active goal unless the user redirects you.')
    }
    if (goal.status === 'paused') {
      parts.push('  Reminder: The goal is paused. Do not auto-continue it until resumed.')
    }
    if (goal.status === 'blocked') {
      parts.push('  Reminder: The goal is blocked. Do not claim it is unblocked without new input.')
    }
    if (goal.status === 'usage_limited') {
      parts.push('  Reminder: The goal is usage-limited. Wait for resume before continuing.')
    }
    if (goal.status === 'budget_limited') {
      parts.push('  Reminder: The goal is budget-limited. Wrap up instead of starting new work.')
    }
  }

  const plan = usePlanStore.getState().getPlanBySession(sessionId)
  if (plan) {
    parts.push(`- Plan: "${plan.title}" (status: ${plan.status})`)
    if (plan.status === 'awaiting_review') {
      parts.push(
        '  Reminder: The plan is awaiting user review. Do not implement until it is approved.'
      )
    }
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
  const globalMemorySummary = snapshot.globalMemorySummary?.content?.trim()
  const projectMemorySummary = snapshot.projectMemorySummary?.content?.trim()
  const globalMemoryPath = snapshot.globalMemory?.path?.trim()
  const globalMemorySummaryPath = snapshot.globalMemorySummary?.path?.trim()
  const projectMemorySummaryPath = snapshot.projectMemorySummary?.path?.trim()
  const globalDailyMemory = snapshot.globalDailyMemory ?? []
  const projectDailyMemory = snapshot.projectDailyMemory ?? []
  const settings = useSettingsStore.getState()
  const memoryUseMemories = settings.memoryUseMemories
  const memorySummaryBudget = Math.max(1000, settings.memorySummaryBudgetTokens)
  const effectiveGlobalMemory = globalMemorySummary
    ? {
        content: globalMemorySummary,
        path: globalMemorySummaryPath,
        summarizedFromPath: globalMemoryPath
      }
    : globalMemory && estimateTokens(globalMemory) <= memorySummaryBudget
      ? {
          content: globalMemory,
          path: globalMemoryPath
        }
      : {
          content: undefined,
          path: undefined
        }
  const effectiveProjectMemory = projectMemorySummary
    ? {
        content: projectMemorySummary,
        path: projectMemorySummaryPath,
        summarizedFromPath: snapshot.projectMemory?.path
      }
    : projectMemory && estimateTokens(projectMemory) <= memorySummaryBudget
      ? {
          content: projectMemory,
          path: snapshot.projectMemory?.path
        }
      : {
          content: undefined,
          path: undefined
        }

  if (sessionScope === 'main' && memoryUseMemories) {
    parts.push(
      `\n<memory_read_path_policy>`,
      `OpenCowork memory is scoped. Global memory applies across projects; project memory applies only to the current workspace and takes priority when it conflicts with global memory.`,
      `Only summaries or small memory files are injected by default. Use MemoryList, MemoryRead, and MemorySearch when you need detailed memory provenance.`,
      `When relying on memory details from those tools, keep the scope and memoryRootId from the tool result with the cited fact so global memory and project memory are not confused.`,
      `</memory_read_path_policy>`
    )
  }

  const canInjectDurableMemory = sessionScope === 'main' && memoryUseMemories

  if (sessionScope === 'main') {
    parts.push(
      `\n<memory_loading_policy>`,
      `Session scope: MAIN. Load workspace protocol plus long-term persona, user profile, and curated memory layers.`,
      `Project-level files override global defaults when both exist. System prompt rules still take priority over all memory files.`,
      `SOUL.md defines your core identity, personality, tone, and behavioral constraints. You MUST embody and adhere to its directives throughout the entire conversation without exception, even when they are not explicitly repeated in follow-up messages.`,
      `</memory_loading_policy>`
    )
  } else if (sessionScope === 'channel') {
    parts.push(
      `\n<memory_loading_policy>`,
      `Session scope: CHANNEL. Load workspace protocol plus long-term persona/style from SOUL.md for channel replies.`,
      `Do not rely on USER.md, MEMORY.md, or daily memory files in channel contexts unless explicitly provided in the conversation.`,
      `Project-level SOUL.md refines or overrides the global soul for this workspace. System prompt rules still take priority over all memory files.`,
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

  if (sessionScope !== 'shared' && globalSoul) {
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

  if (sessionScope !== 'shared' && projectSoul) {
    parts.push(
      `\n<project_soul priority="high">`,
      `The following is project SOUL.md from \`${snapshot.projectSoul?.path}\`. It refines or overrides the global soul for this workspace. Where it conflicts with global SOUL.md, this file wins.`,
      `You MUST follow these project-level identity and style directives throughout the conversation.`,
      ``,
      projectSoul,
      `</project_soul>`
    )
  }

  if (canInjectDurableMemory && globalUser) {
    parts.push(
      `\n<global_user>`,
      `The following is global USER.md from \`${snapshot.globalUser?.path}\`, describing the human you are helping across projects.`,
      ``,
      globalUser,
      `</global_user>`
    )
  }

  if (canInjectDurableMemory && projectUser) {
    parts.push(
      `\n<project_user>`,
      `The following is project USER.md from \`${snapshot.projectUser?.path}\`. It adds workspace-specific user preferences and goals.`,
      ``,
      projectUser,
      `</project_user>`
    )
  }

  if (canInjectDurableMemory && globalDailyMemory.length > 0) {
    parts.push(
      `\n<global_daily_memory>`,
      `Recent global daily memory files provide short-term continuity.`,
      ...globalDailyMemory.flatMap((entry) => [
        `\n## ${entry.date} - \`${entry.path}\``,
        entry.content ?? ''
      ]),
      `</global_daily_memory>`
    )
  }

  if (canInjectDurableMemory && projectDailyMemory.length > 0) {
    parts.push(
      `\n<project_daily_memory>`,
      `Recent project daily memory files provide short-term workspace continuity.`,
      ...projectDailyMemory.flatMap((entry) => [
        `\n## ${entry.date} - \`${entry.path}\``,
        entry.content ?? ''
      ]),
      `</project_daily_memory>`
    )
  }

  if (canInjectDurableMemory && effectiveGlobalMemory.content) {
    parts.push(
      `\n<global_memory>`,
      effectiveGlobalMemory.summarizedFromPath
        ? `The following is memory_summary.md from \`${effectiveGlobalMemory.path}\`, summarizing oversized global MEMORY.md from \`${effectiveGlobalMemory.summarizedFromPath}\`.`
        : `The following is global MEMORY.md from \`${effectiveGlobalMemory.path}\`, containing curated cross-session memory.`,
      ``,
      effectiveGlobalMemory.content,
      `</global_memory>`
    )
  }

  if (canInjectDurableMemory && effectiveProjectMemory.content) {
    parts.push(
      `\n<project_long_term_memory>`,
      effectiveProjectMemory.summarizedFromPath
        ? `The following is memory_summary.md from \`${effectiveProjectMemory.path}\`, summarizing oversized project MEMORY.md from \`${effectiveProjectMemory.summarizedFromPath}\`.`
        : `The following is project MEMORY.md from \`${effectiveProjectMemory.path}\`, containing workspace-specific long-term memory.`,
      ``,
      effectiveProjectMemory.content,
      `</project_long_term_memory>`
    )
  }
}
