import { nanoid } from 'nanoid'
import { runAgentLoop } from '../agent-loop'
import { toolRegistry } from '../tool-registry'
import { teamEvents } from './events'
import { useTeamStore } from '../../../stores/team-store'
import { useSettingsStore } from '../../../stores/settings-store'
import { ipcClient } from '../../ipc/ipc-client'
import type { AgentLoopConfig, ToolCallState } from '../types'
import type { UnifiedMessage, ProviderConfig } from '../../api/types'

// --- AbortController registry for individual teammates ---
const teammateAbortControllers = new Map<string, AbortController>()

/**
 * Abort a running teammate by member ID.
 * Returns true if the teammate was found and aborted.
 */
export function abortTeammate(memberId: string): boolean {
  const ac = teammateAbortControllers.get(memberId)
  if (ac) {
    ac.abort()
    teammateAbortControllers.delete(memberId)
    return true
  }
  return false
}

/** Abort all running teammates (e.g. on TeamDelete). */
export function abortAllTeammates(): void {
  for (const [id, ac] of teammateAbortControllers) {
    ac.abort()
    teammateAbortControllers.delete(id)
  }
}

/** Check if a teammate is still running. */
export function isTeammateRunning(memberId: string): boolean {
  return teammateAbortControllers.has(memberId)
}

interface RunTeammateOptions {
  memberId: string
  memberName: string
  prompt: string
  taskId: string | null
  model: string | null
  workingFolder?: string
}

/**
 * Start an independent agent loop for a teammate.
 * Runs in background (fire-and-forget). Updates team-store via teamEvents.
 * The returned promise resolves when the loop finishes.
 */
export async function runTeammate(options: RunTeammateOptions): Promise<void> {
  const { memberId, memberName, prompt, taskId, model, workingFolder } = options

  // 1. Build provider config from current settings
  const settings = useSettingsStore.getState()
  const providerConfig: ProviderConfig = {
    type: settings.provider,
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl || undefined,
    model: model && model !== 'default' ? model : settings.model,
    maxTokens: settings.maxTokens,
    temperature: settings.temperature,
  }

  // 2. Build system prompt for the teammate
  const team = useTeamStore.getState().activeTeam
  const taskInfo = taskId && team
    ? team.tasks.find((t) => t.id === taskId)
    : null

  const systemPrompt = buildTeammateSystemPrompt({
    memberName,
    teamName: team?.name ?? 'team',
    prompt,
    task: taskInfo ? { id: taskInfo.id, subject: taskInfo.subject, description: taskInfo.description } : null,
    workingFolder,
  })

  providerConfig.systemPrompt = systemPrompt

  // 3. Build agent loop config
  const abortController = new AbortController()
  teammateAbortControllers.set(memberId, abortController)

  // Exclude team management tools from teammate (only lead should manage team)
  const LEAD_ONLY_TOOLS = new Set(['TeamCreate', 'TeamDelete', 'SpawnTeammate'])
  const toolDefs = toolRegistry.getDefinitions().filter((t) => !LEAD_ONLY_TOOLS.has(t.name))

  const loopConfig: AgentLoopConfig = {
    maxIterations: 15,
    provider: providerConfig,
    tools: toolDefs,
    systemPrompt,
    workingFolder,
    signal: abortController.signal,
  }

  // 4. Build initial user message
  const userMsg: UnifiedMessage = {
    id: nanoid(),
    role: 'user',
    content: prompt,
    createdAt: Date.now(),
  }

  // Mark member as working
  teamEvents.emit({
    type: 'team_member_update',
    memberId,
    patch: { status: 'working', iteration: 0 },
  })

  // 5. Run the loop
  const collectedToolCalls: ToolCallState[] = []
  let iteration = 0

  try {
    const loop = runAgentLoop(
      [userMsg],
      loopConfig,
      { workingFolder, signal: abortController.signal, ipc: ipcClient },
      async (tc) => {
        // Auto-approve read-only tools for teammates
        if (READ_ONLY_TOOLS.has(tc.name)) return true
        // For write tools, check global autoApprove setting
        const autoApprove = useSettingsStore.getState().autoApprove
        if (autoApprove) return true
        // Otherwise deny — teammates don't have interactive approval UI yet
        // TODO: Could route to a teammate-specific approval queue
        return false
      }
    )

    for await (const event of loop) {
      if (abortController.signal.aborted) break

      switch (event.type) {
        case 'iteration_start':
          iteration = event.iteration
          teamEvents.emit({
            type: 'team_member_update',
            memberId,
            patch: { iteration, status: 'working' },
          })
          break

        case 'text_delta':
          // Accumulate streaming text in member state
          {
            const current = useTeamStore.getState().activeTeam?.members.find((m) => m.id === memberId)
            teamEvents.emit({
              type: 'team_member_update',
              memberId,
              patch: { streamingText: (current?.streamingText ?? '') + event.text },
            })
          }
          break

        case 'tool_call_start':
        case 'tool_call_result':
          {
            const idx = collectedToolCalls.findIndex((t) => t.id === event.toolCall.id)
            if (idx >= 0) {
              collectedToolCalls[idx] = event.toolCall
            } else {
              collectedToolCalls.push(event.toolCall)
            }
            teamEvents.emit({
              type: 'team_member_update',
              memberId,
              patch: { toolCalls: [...collectedToolCalls] },
            })
          }
          break

        case 'loop_end':
          // Mark task as completed if assigned and loop ended normally
          if (event.reason === 'completed' && taskId) {
            teamEvents.emit({
              type: 'team_task_update',
              taskId,
              patch: { status: 'completed' },
            })
          }
          break
      }
    }

    // Success
    teamEvents.emit({
      type: 'team_member_update',
      memberId,
      patch: { status: 'stopped', completedAt: Date.now() },
    })
  } catch (err) {
    if (!abortController.signal.aborted) {
      console.error(`[Teammate ${memberName}] Error:`, err)
    }
    teamEvents.emit({
      type: 'team_member_update',
      memberId,
      patch: { status: 'stopped', completedAt: Date.now() },
    })
  } finally {
    teammateAbortControllers.delete(memberId)
  }
}

// --- Helpers ---

const READ_ONLY_TOOLS = new Set(['Read', 'LS', 'Glob', 'Grep', 'TodoRead', 'TaskList'])

function buildTeammateSystemPrompt(options: {
  memberName: string
  teamName: string
  prompt: string
  task: { id: string; subject: string; description: string } | null
  workingFolder?: string
}): string {
  const { memberName, teamName, prompt, task, workingFolder } = options

  const parts: string[] = []

  parts.push(
    `You are "${memberName}", a teammate agent in the "${teamName}" team.`,
    `You are part of a multi-agent team working in parallel on a shared codebase.`,
    `You should focus exclusively on your assigned work and avoid modifying files outside your scope.`
  )

  if (task) {
    parts.push(
      `\n## Your Task`,
      `**ID:** ${task.id}`,
      `**Subject:** ${task.subject}`,
      `**Description:** ${task.description}`
    )
  }

  parts.push(`\n## Instructions\n${prompt}`)

  if (workingFolder) {
    parts.push(`\n## Working Folder\n\`${workingFolder}\``)
    parts.push(`All relative paths should be resolved against this folder.`)
  }

  parts.push(
    `\n## Coordination Rules`,
    `- Only modify files related to your assigned task.`,
    `- Use TaskUpdate to mark your task as completed when done.`,
    `- Use TeamSendMessage to communicate with the lead or other teammates if needed.`,
    `- Be concise and efficient — you have limited iterations.`
  )

  return parts.join('\n')
}
