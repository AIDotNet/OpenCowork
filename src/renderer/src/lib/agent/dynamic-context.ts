import { useUIStore } from '../../stores/ui-store'
import { useChatStore } from '../../stores/chat-store'
import type { LayeredMemorySnapshot, SessionMemoryScope } from './memory-files'

/**
 * Build dynamic context for the first user message in a session.
 * Includes selected files and layered memory content (if any).
 *
 * @returns A <system-reminder> block, or empty string if no context
 */
export function buildDynamicContext(options: {
  sessionId: string
  memorySnapshot?: LayeredMemorySnapshot
  sessionScope?: SessionMemoryScope
}): string {
  const { sessionId, memorySnapshot, sessionScope = 'main' } = options

  const parts: string[] = []

  // ── Selected Files ──
  const selectedFiles = useUIStore.getState().selectedFiles ?? []
  const session = useChatStore.getState().sessions.find((s) => s.id === sessionId)
  const workingFolder = session?.workingFolder

  if (selectedFiles.length > 0) {
    const fileParts: string[] = []
    fileParts.push(
      `- Selected Files: ${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''}`
    )
    for (const filePath of selectedFiles) {
      let displayPath = filePath
      if (workingFolder && filePath.startsWith(workingFolder)) {
        displayPath = filePath.slice(workingFolder.length).replace(/^[\\/]/, '')
      }
      fileParts.push(`  - ${displayPath}`)
    }
    parts.push('Current Context:')
    parts.push(fileParts.join('\n'))
  }

  // ── Memory Context ──
  if (memorySnapshot) {
    appendMemoryContext(parts, memorySnapshot, sessionScope)
  }

  if (parts.length === 0) {
    return ''
  }

  return `<system-reminder>\n${parts.join('\n')}\n</system-reminder>`
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
