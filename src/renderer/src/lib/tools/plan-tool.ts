import { toolRegistry } from '../agent/tool-registry'
import { usePlanStore } from '../../stores/plan-store'
import { useUIStore } from '../../stores/ui-store'
import { useChatStore } from '../../stores/chat-store'
import type { ToolHandler, ToolContext } from './tool-types'

// ── Helpers ──

function getSessionId(ctx: ToolContext): string | null {
  return ctx.sessionId ?? useChatStore.getState().activeSessionId ?? null
}

function inferTitleFromContent(content: string): string {
  const lines = content.split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) return 'Plan'
  const first = lines[0].replace(/^#+\s*/, '').replace(/^plan:\s*/i, '').trim()
  return first.slice(0, 80) || 'Plan'
}

function normalizeSummary(input: unknown): string[] | undefined {
  if (!input) return undefined
  if (Array.isArray(input)) {
    const items = input.map((item) => String(item).trim()).filter(Boolean)
    return items.length > 0 ? items : undefined
  }
  if (typeof input === 'string') {
    const lines = input
      .split('\n')
      .map((line) => line.replace(/^[-*]\s+/, '').trim())
      .filter(Boolean)
    return lines.length > 0 ? lines : undefined
  }
  return undefined
}

// ── EnterPlanMode ──

const enterPlanModeHandler: ToolHandler = {
  definition: {
    name: 'EnterPlanMode',
    description:
      'Enter Plan Mode to explore the codebase and create a detailed implementation plan before writing any code. ' +
      'Use this proactively when starting non-trivial tasks that require architectural decisions, multi-file changes, ' +
      'or when multiple valid approaches exist. In plan mode, only read/search and plan tools are allowed — ' +
      'no Edit/Shell commands.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Brief reason in English for entering plan mode. This becomes the plan title if no plan exists (e.g. "add-user-authentication").',
        },
      },
    },
  },
  execute: async (input) => {
    const uiStore = useUIStore.getState()
    const session = useChatStore.getState().getActiveSession()
    if (!session) return JSON.stringify({ error: 'No active session.' })

    // Check if session already has a plan
    const existingPlan = usePlanStore.getState().getPlanBySession(session.id)
    if (existingPlan && (existingPlan.status === 'drafting' || existingPlan.status === 'rejected')) {
      if (!uiStore.planMode) uiStore.enterPlanMode()
      usePlanStore.getState().setActivePlan(existingPlan.id)
      return JSON.stringify({
        status: 'resumed',
        plan_id: existingPlan.id,
        message: 'Resumed existing plan draft. Draft the plan in chat, then call SavePlan.',
      })
    }

    // Create new plan record
    const reason = input.reason ? String(input.reason) : 'Implementation planning'
    const plan = usePlanStore.getState().createPlan(session.id, reason)

    if (!uiStore.planMode) uiStore.enterPlanMode()
    uiStore.setRightPanelTab('plan')
    uiStore.setRightPanelOpen(true)

    return JSON.stringify({
      status: 'entered',
      plan_id: plan.id,
      message: 'Plan mode activated. Draft the plan in chat, then call SavePlan. Call ExitPlanMode when complete.',
    })
  },
  requiresApproval: () => false,
}

// ── ExitPlanMode ──

const exitPlanModeHandler: ToolHandler = {
  definition: {
    name: 'ExitPlanMode',
    description:
      'Exit Plan Mode after completing the plan. This signals that the plan is finalized and ready for user review. ' +
      'The user can then click "Implement" in the Plan panel or reply to start implementation. ' +
      'IMPORTANT: Ensure you have called SavePlan before calling this tool. ' +
      'After calling this tool, you MUST STOP and wait for the user to review the plan — do NOT continue with any further actions.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  execute: async () => {
    const uiStore = useUIStore.getState()

    if (!uiStore.planMode) {
      return JSON.stringify({ status: 'not_in_plan_mode', message: 'You are not currently in plan mode.' })
    }

    // Exit plan mode UI
    uiStore.exitPlanMode()

    return JSON.stringify({
      status: 'exited',
      message: 'Plan mode exited. STOP HERE — wait for the user to review and approve the plan in the panel.',
    })
  },
  requiresApproval: () => false,
}

// ── SavePlan ──

const savePlanHandler: ToolHandler = {
  definition: {
    name: 'SavePlan',
    description:
      'Save the current plan content and summary for the Plan panel. ' +
      'Use this after writing the plan in chat. Provide a concise summary (3-6 bullets).',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Optional plan title. If omitted, the title is inferred from the plan content.',
        },
        content: {
          type: 'string',
          description: 'Full plan content as written in the chat response.',
        },
        summary: {
          anyOf: [
            { type: 'array', items: { type: 'string' } },
            { type: 'string' },
          ],
          description: 'Concise summary bullets (3-6). Array of strings or a newline-delimited string.',
        },
      },
      required: ['content'],
    },
  },
  execute: async (input, ctx) => {
    const sessionId = getSessionId(ctx)
    if (!sessionId) {
      return JSON.stringify({ error: 'No active session.' })
    }

    const content = input.content ? String(input.content) : ''
    if (!content.trim()) {
      return JSON.stringify({ error: 'Plan content is empty.' })
    }

    const summary = normalizeSummary(input.summary)
    const specJson = summary ? JSON.stringify({ summary, version: 1 }) : undefined
    const title = input.title ? String(input.title) : inferTitleFromContent(content)

    const planStore = usePlanStore.getState()
    let plan = planStore.getPlanBySession(sessionId)
    if (!plan) {
      plan = planStore.createPlan(sessionId, title, { content, specJson, status: 'drafting' })
    } else {
      planStore.updatePlan(plan.id, { title, content, specJson, status: 'drafting' })
    }
    planStore.setActivePlan(plan.id)

    return JSON.stringify({
      status: 'saved',
      plan_id: plan.id,
      title,
      summary_count: summary?.length ?? 0,
    })
  },
  requiresApproval: () => false,
}

// ── Registration ──

export function registerPlanTools(): void {
  toolRegistry.register(enterPlanModeHandler)
  toolRegistry.register(savePlanHandler)
  toolRegistry.register(exitPlanModeHandler)
}

// ── Plan Mode Tool Filter ──

/** Tool names allowed in plan mode (read-only + planning tools) */
export const PLAN_MODE_ALLOWED_TOOLS = new Set([
  // Read-only filesystem
  'Read',
  'LS',
  'Glob',
  'Grep',
  // Planning tools
  'EnterPlanMode',
  'SavePlan',
  'ExitPlanMode',
  'AskUserQuestion',
  // Task tracking
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  // SubAgent (read-only explorers)
  'Task',
  // Preview (read-only)
  'Preview',
])
