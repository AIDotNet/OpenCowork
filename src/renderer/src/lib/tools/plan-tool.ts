import { toolRegistry } from '../agent/tool-registry'
import { joinFsPath } from '../agent/memory-files'
import { IPC } from '../ipc/channels'
import { usePlanStore } from '../../stores/plan-store'
import { useUIStore } from '../../stores/ui-store'
import { useChatStore } from '../../stores/chat-store'
import { useSettingsStore } from '../../stores/settings-store'
import { encodeStructuredToolResult, encodeToolError } from './tool-result-format'
import { resolveToolPath } from './fs-tool'
import type { ToolHandler, ToolContext } from './tool-types'

const PLAN_DIRECTORY_NAME = '.plan'

function getSessionId(ctx: ToolContext): string | null {
  return ctx.sessionId ?? useChatStore.getState().activeSessionId ?? null
}

function inferTitleFromContent(content: string): string {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return 'Plan'
  const first = lines[0]
    .replace(/^#+\s*/, '')
    .replace(/^plan:\s*/i, '')
    .trim()
  return first.slice(0, 80) || 'Plan'
}

function normalizeComparablePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
  return /^[a-zA-Z]:/.test(normalized) ? normalized.toLowerCase() : normalized
}

function isFsErrorResult(value: unknown): value is { error: string } {
  if (!value || typeof value !== 'object') return false
  const error = (value as { error?: unknown }).error
  return typeof error === 'string' && error.length > 0
}

async function ensurePlanFile(
  ctx: ToolContext,
  workingFolder: string,
  planFilePath: string
): Promise<void> {
  const ipc = ctx.ipc
  const sshConnectionId = ctx.sshConnectionId?.trim()
  const planDirectory = joinFsPath(workingFolder, PLAN_DIRECTORY_NAME)
  const mkdirResult = await ipc.invoke(
    sshConnectionId ? IPC.SSH_FS_MKDIR : IPC.FS_MKDIR,
    sshConnectionId
      ? { connectionId: sshConnectionId, path: planDirectory }
      : { path: planDirectory }
  )
  if (isFsErrorResult(mkdirResult)) {
    throw new Error(`Failed to create plan directory: ${mkdirResult.error}`)
  }

  const readResult = await ipc.invoke(
    sshConnectionId ? IPC.SSH_FS_READ_FILE : IPC.FS_READ_FILE,
    sshConnectionId ? { connectionId: sshConnectionId, path: planFilePath } : { path: planFilePath }
  )
  if (!isFsErrorResult(readResult)) return

  if (!/ENOENT|No such file/i.test(readResult.error)) {
    throw new Error(`Failed to access plan file: ${readResult.error}`)
  }

  const writeResult = await ipc.invoke(
    sshConnectionId ? IPC.SSH_FS_WRITE_FILE : IPC.FS_WRITE_FILE,
    sshConnectionId
      ? { connectionId: sshConnectionId, path: planFilePath, content: '' }
      : {
          path: planFilePath,
          content: ''
        }
  )
  if (isFsErrorResult(writeResult)) {
    throw new Error(`Failed to initialize plan file: ${writeResult.error}`)
  }
}

async function readPlanFile(ctx: ToolContext, planFilePath: string): Promise<string> {
  const sshConnectionId = ctx.sshConnectionId?.trim()
  const result = await ctx.ipc.invoke(
    sshConnectionId ? IPC.SSH_FS_READ_FILE : IPC.FS_READ_FILE,
    sshConnectionId ? { connectionId: sshConnectionId, path: planFilePath } : { path: planFilePath }
  )
  if (isFsErrorResult(result)) {
    throw new Error(result.error)
  }
  return String(result)
}

function getCurrentPlanFilePath(ctx: ToolContext): string | null {
  const sessionId = getSessionId(ctx)
  if (!sessionId) return null
  return usePlanStore.getState().getPlanBySession(sessionId)?.filePath ?? null
}

export function getPlanFilePath(workingFolder: string, planId: string): string {
  return joinFsPath(workingFolder, PLAN_DIRECTORY_NAME, `${planId}.md`)
}

function createGuardedPlanFileHandler(toolName: 'Write' | 'Edit'): ToolHandler | null {
  const baseHandler = toolRegistry.get(toolName)
  if (!baseHandler) return null

  return {
    definition: baseHandler.definition,
    execute: async (input, ctx) => {
      const currentPlanFilePath = getCurrentPlanFilePath(ctx)
      if (!currentPlanFilePath) {
        return encodeToolError('No active plan file for this session. Call EnterPlanMode first.')
      }

      const resolvedPath = resolveToolPath(input.file_path, ctx.workingFolder)
      if (normalizeComparablePath(resolvedPath) !== normalizeComparablePath(currentPlanFilePath)) {
        return encodeToolError(
          `In plan mode, ${toolName} is restricted to the current plan file: ${currentPlanFilePath}`
        )
      }

      return baseHandler.execute(input, ctx)
    },
    requiresApproval: () => false
  }
}

export function createPlanModeInlineToolHandlers(): Record<string, ToolHandler> {
  const handlers: Record<string, ToolHandler> = {}
  const guardedWriteHandler = createGuardedPlanFileHandler('Write')
  const guardedEditHandler = createGuardedPlanFileHandler('Edit')

  if (guardedWriteHandler) handlers.Write = guardedWriteHandler
  if (guardedEditHandler) handlers.Edit = guardedEditHandler

  return handlers
}

const enterPlanModeHandler: ToolHandler = {
  definition: {
    name: 'EnterPlanMode',
    description:
      'Enter Plan Mode to explore the codebase and create a detailed implementation plan before writing code. ' +
      'In plan mode, use read/search tools for investigation and Write/Edit only for the current plan file returned by this tool. ' +
      'Do not make other file changes or run implementation commands.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description:
            'Brief reason in English for entering plan mode. This becomes the initial plan title if no plan exists (e.g. "add-user-authentication").'
        }
      }
    }
  },
  execute: async (input, ctx) => {
    const uiStore = useUIStore.getState()
    const sessionId = getSessionId(ctx)
    const session = sessionId
      ? useChatStore.getState().sessions.find((item) => item.id === sessionId)
      : undefined
    if (!session) return encodeToolError('No active session.')

    const workingFolder = ctx.workingFolder?.trim() || session.workingFolder?.trim()
    if (!workingFolder) {
      return encodeToolError('Plan mode requires an active working folder.')
    }

    const planStore = usePlanStore.getState()
    const existingPlan = planStore.getPlanBySession(session.id)

    if (existingPlan && !existingPlan.filePath) {
      return encodeToolError(
        'Legacy plans without plan files are not supported. Create a new plan in a session with a working folder.'
      )
    }

    if (
      existingPlan?.filePath &&
      (existingPlan.status === 'drafting' || existingPlan.status === 'rejected')
    ) {
      try {
        await ensurePlanFile(ctx, workingFolder, existingPlan.filePath)
      } catch (error) {
        return encodeToolError(error instanceof Error ? error.message : String(error))
      }

      if (!uiStore.isPlanModeEnabled(session.id)) uiStore.enterPlanMode(session.id)
      if (useChatStore.getState().activeSessionId === session.id) {
        planStore.setActivePlan(existingPlan.id)
      }
      return encodeStructuredToolResult({
        status: 'resumed',
        plan_id: existingPlan.id,
        plan_file_path: existingPlan.filePath,
        message:
          'Resumed existing plan draft. Update the current plan file with Write/Edit, then call ExitPlanMode.'
      })
    }

    const reason = input.reason ? String(input.reason) : 'Implementation planning'
    const plan = planStore.createPlan(session.id, reason)
    const planFilePath = getPlanFilePath(workingFolder, plan.id)
    planStore.updatePlan(plan.id, { filePath: planFilePath })

    try {
      await ensurePlanFile(ctx, workingFolder, planFilePath)
    } catch (error) {
      planStore.deletePlan(plan.id)
      return encodeToolError(error instanceof Error ? error.message : String(error))
    }

    if (!uiStore.isPlanModeEnabled(session.id)) uiStore.enterPlanMode(session.id)
    const autoSwitchTarget = useSettingsStore.getState().clarifyPlanModeAutoSwitchTarget
    if (session.mode === 'clarify' && autoSwitchTarget !== 'off') {
      uiStore.setMode(autoSwitchTarget)
      useChatStore.getState().updateSessionMode(session.id, autoSwitchTarget)
    }
    if (useChatStore.getState().activeSessionId === session.id) {
      planStore.setActivePlan(plan.id)
    }

    return encodeStructuredToolResult({
      status: 'entered',
      plan_id: plan.id,
      plan_file_path: planFilePath,
      message:
        'Plan mode activated. Write the plan into the current plan file with Write/Edit, then call ExitPlanMode.'
    })
  },
  requiresApproval: () => false
}

const exitPlanModeHandler: ToolHandler = {
  definition: {
    name: 'ExitPlanMode',
    description:
      'Exit Plan Mode after writing the plan file. This signals that the plan is finalized and ready for user review. ' +
      'After calling this tool, you MUST STOP and wait for the user to review the plan — do NOT continue with any further actions.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  execute: async (_input, ctx) => {
    const uiStore = useUIStore.getState()
    const sessionId = getSessionId(ctx)

    if (!sessionId) {
      return encodeToolError('No active session.')
    }

    const planStore = usePlanStore.getState()
    const existingPlan = planStore.getPlanBySession(sessionId)
    const isPlanModeEnabled = uiStore.isPlanModeEnabled(sessionId)

    if (!isPlanModeEnabled) {
      if (existingPlan?.status === 'awaiting_review' && existingPlan.filePath) {
        return encodeStructuredToolResult(
          {
            status: 'awaiting_review',
            awaiting_user_review: true,
            plan_id: existingPlan.id,
            plan_file_path: existingPlan.filePath,
            title: existingPlan.title,
            message: 'Plan is already finalized and awaiting user review.'
          },
          'json'
        )
      }

      return encodeStructuredToolResult({
        status: 'not_in_plan_mode',
        message: 'You are not currently in plan mode.'
      })
    }

    const plan = existingPlan
    if (!plan?.filePath) {
      return encodeToolError('No active plan file for this session.')
    }

    let content = ''
    try {
      content = await readPlanFile(ctx, plan.filePath)
    } catch (error) {
      return encodeToolError(
        `Failed to read the current plan file before exiting plan mode: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    if (!content.trim()) {
      return encodeToolError('Plan file is empty. Write the plan file before exiting plan mode.')
    }

    const title = inferTitleFromContent(content)
    planStore.updatePlan(plan.id, {
      title,
      status: 'awaiting_review',
      filePath: plan.filePath
    })

    uiStore.exitPlanMode(sessionId)

    return encodeStructuredToolResult(
      {
        status: 'awaiting_review',
        awaiting_user_review: true,
        plan_id: plan.id,
        plan_file_path: plan.filePath,
        title,
        content,
        message: 'Plan finalized and ready for user review. Wait for approval before implementing.'
      },
      'json'
    )
  },
  requiresApproval: () => false
}

export const PLAN_MODE_ALLOWED_TOOLS = new Set([
  'Read',
  'LS',
  'Glob',
  'Grep',
  'Write',
  'Edit',
  'EnterPlanMode',
  'ExitPlanMode',
  'AskUserQuestion',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  'Task',
  'get_goal',
  'create_goal',
  'update_goal',
  'visualize_show_widget'
])

export const ACP_MODE_ALLOWED_TOOLS = new Set([
  'Read',
  'LS',
  'Glob',
  'Grep',
  'EnterPlanMode',
  'ExitPlanMode',
  'AskUserQuestion',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  'Task',
  'get_goal',
  'create_goal',
  'update_goal',
  'visualize_show_widget'
])

export function registerPlanTools(): void {
  toolRegistry.register(enterPlanModeHandler)
  toolRegistry.register(exitPlanModeHandler)
}
