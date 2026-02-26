import { nanoid } from 'nanoid'
import { toolRegistry } from '../agent/tool-registry'
import { useTaskStore, type TaskItem } from '../../stores/task-store'
import { useTeamStore } from '../../stores/team-store'
import { teamEvents } from '../agent/teams/events'
import type { TeamTask } from '../agent/teams/types'
import type { ToolHandler } from './tool-types'

// ── Helpers: dual-mode (standalone vs. team) ──

function hasActiveTeam(): boolean {
  return !!useTeamStore.getState().activeTeam
}

function getTeamTasks(): TeamTask[] {
  return useTeamStore.getState().activeTeam?.tasks ?? []
}

function getStandaloneTasks(sessionId?: string): TaskItem[] {
  const store = useTaskStore.getState()
  return sessionId ? store.getTasksBySession(sessionId) : store.getTasks()
}

function getStandaloneTask(taskId: string, sessionId?: string): TaskItem | undefined {
  if (!sessionId) return useTaskStore.getState().getTask(taskId)
  return getStandaloneTasks(sessionId).find((t) => t.id === taskId)
}

// ── TaskCreate ──

const taskCreateHandler: ToolHandler = {
  definition: {
    name: 'TaskCreate',
    description:
      'Create a task for the current session. Use this to track progress on complex multi-step work. Tasks are displayed in the Steps panel.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description: 'A brief title for the task',
        },
        description: {
          type: 'string',
          description: 'A detailed description of what needs to be done',
        },
        activeForm: {
          type: 'string',
          description:
            'Present continuous form shown in spinner when in_progress (e.g., "Running tests")',
        },
        metadata: {
          type: 'object',
          description: 'Arbitrary metadata to attach to the task',
        },
      },
      required: ['subject', 'description'],
    },
  },
  execute: async (input, ctx) => {
    const subject = String(input.subject)
    const description = String(input.description)
    const activeForm = input.activeForm ? String(input.activeForm) : undefined
    const metadata = input.metadata as Record<string, unknown> | undefined
    const id = nanoid(8)

    if (hasActiveTeam()) {
      // Team mode: check for duplicate, then emit team event
      const existing = getTeamTasks().find((t) => t.subject === subject)
      if (existing) {
        return JSON.stringify({
          success: true,
          task_id: existing.id,
          subject: existing.subject,
          note: 'Task with this subject already exists, returning existing task.',
        })
      }
      const task: TeamTask = {
        id,
        subject,
        description,
        status: 'pending',
        owner: null,
        dependsOn: [],
        activeForm,
      }
      teamEvents.emit({ type: 'team_task_add', task })
      return JSON.stringify({ success: true, task_id: id, subject })
    }

    // Standalone mode: add to task-store
    if (!ctx.sessionId) {
      return JSON.stringify({ error: 'No active session context for TaskCreate.' })
    }

    const task: TaskItem = {
      id,
      sessionId: ctx.sessionId,
      subject,
      description,
      activeForm,
      status: 'pending',
      owner: null,
      blocks: [],
      blockedBy: [],
      metadata,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    useTaskStore.getState().addTask(task)
    return JSON.stringify({ success: true, task_id: id, subject })
  },
  requiresApproval: () => false,
}

// ── TaskGet ──

const taskGetHandler: ToolHandler = {
  definition: {
    name: 'TaskGet',
    description: 'Retrieve a task by its ID to see full details including description and dependencies.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The ID of the task to retrieve',
        },
      },
      required: ['taskId'],
    },
  },
  execute: async (input, ctx) => {
    const taskId = String(input.taskId)

    if (hasActiveTeam()) {
      const task = getTeamTasks().find((t) => t.id === taskId)
      if (!task) return JSON.stringify({ error: `Task "${taskId}" not found` })
      return JSON.stringify({
        id: task.id,
        subject: task.subject,
        description: task.description,
        status: task.status,
        owner: task.owner,
        activeForm: task.activeForm,
        dependsOn: task.dependsOn,
      })
    }

    const task = getStandaloneTask(taskId, ctx.sessionId)
    if (!task) return JSON.stringify({ error: `Task "${taskId}" not found` })

    return JSON.stringify({
      id: task.id,
      subject: task.subject,
      description: task.description,
      status: task.status,
      owner: task.owner,
      activeForm: task.activeForm,
      blocks: task.blocks,
      blockedBy: task.blockedBy,
      metadata: task.metadata,
    })
  },
  requiresApproval: () => false,
}

// ── TaskUpdate ──

const taskUpdateHandler: ToolHandler = {
  definition: {
    name: 'TaskUpdate',
    description:
      'Update a task: change status, subject, description, owner, or manage dependencies. Set status to "deleted" to permanently remove a task.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The ID of the task to update' },
        subject: { type: 'string', description: 'New subject for the task' },
        description: { type: 'string', description: 'New description for the task' },
        activeForm: {
          type: 'string',
          description:
            'Present continuous form shown in spinner when in_progress (e.g., "Running tests")',
        },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'deleted'],
          description: 'New status for the task',
        },
        addBlocks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task IDs that this task blocks',
        },
        addBlockedBy: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task IDs that block this task',
        },
        owner: { type: 'string', description: 'New owner for the task' },
        metadata: {
          type: 'object',
          description: 'Metadata keys to merge into the task. Set a key to null to delete it.',
        },
      },
      required: ['taskId'],
    },
  },
  execute: async (input, ctx) => {
    const taskId = String(input.taskId)
    const newStatus = input.status ? String(input.status) : undefined

    // --- Team mode ---
    if (hasActiveTeam()) {
      const team = useTeamStore.getState().activeTeam!
      const task = team.tasks.find((t) => t.id === taskId)
      if (!task) return JSON.stringify({ error: `Task "${taskId}" not found` })

      if (newStatus === 'deleted') {
        // Team tasks don't support delete natively; mark completed with note
        teamEvents.emit({
          type: 'team_task_update',
          taskId,
          patch: { status: 'completed', report: '[deleted]' },
        })
        return JSON.stringify({ success: true, task_id: taskId, deleted: true })
      }

      const patch: Record<string, unknown> = {}
      if (newStatus && ['pending', 'in_progress', 'completed'].includes(newStatus)) {
        if (task.status === 'completed' && newStatus !== 'completed') {
          return JSON.stringify({
            error: `Task "${taskId}" is already completed and cannot be reverted.`,
          })
        }
        patch.status = newStatus
      }
      if (input.subject !== undefined) patch.subject = String(input.subject)
      if (input.description !== undefined) patch.description = String(input.description)
      if (input.activeForm !== undefined) patch.activeForm = String(input.activeForm)
      if (input.owner !== undefined) patch.owner = String(input.owner)
      if (input.report !== undefined && patch.status === 'completed') {
        patch.report = String(input.report)
      }

      teamEvents.emit({ type: 'team_task_update', taskId, patch })
      return JSON.stringify({ success: true, task_id: taskId, updated: patch })
    }

    // --- Standalone mode ---
    const store = useTaskStore.getState()
    const task = getStandaloneTask(taskId, ctx.sessionId)
    if (!task) return JSON.stringify({ error: `Task "${taskId}" not found` })

    if (newStatus === 'deleted') {
      store.deleteTask(taskId)
      return JSON.stringify({ success: true, task_id: taskId, deleted: true })
    }

    const patch: Partial<TaskItem> = {}
    if (newStatus && ['pending', 'in_progress', 'completed'].includes(newStatus)) {
      patch.status = newStatus as TaskItem['status']
    }
    if (input.subject !== undefined) patch.subject = String(input.subject)
    if (input.description !== undefined) patch.description = String(input.description)
    if (input.activeForm !== undefined) patch.activeForm = String(input.activeForm)
    if (input.owner !== undefined) patch.owner = String(input.owner)

    // Dependency management
    if (Array.isArray(input.addBlocks)) {
      const newBlocks = input.addBlocks.map(String)
      patch.blocks = [...new Set([...task.blocks, ...newBlocks])]
      // Also add this task to the blockedBy list of the target tasks
      for (const blockedId of newBlocks) {
        const blocked = getStandaloneTask(blockedId, ctx.sessionId)
        if (blocked) {
          store.updateTask(blockedId, {
            blockedBy: [...new Set([...blocked.blockedBy, taskId])],
          })
        }
      }
    }
    if (Array.isArray(input.addBlockedBy)) {
      const newBlockedBy = input.addBlockedBy.map(String)
      patch.blockedBy = [...new Set([...task.blockedBy, ...newBlockedBy])]
      // Also add this task to the blocks list of the dependency tasks
      for (const depId of newBlockedBy) {
        const dep = getStandaloneTask(depId, ctx.sessionId)
        if (dep) {
          store.updateTask(depId, {
            blocks: [...new Set([...dep.blocks, taskId])],
          })
        }
      }
    }

    // Metadata merge
    if (input.metadata && typeof input.metadata === 'object') {
      const merged = { ...(task.metadata ?? {}) }
      for (const [k, v] of Object.entries(input.metadata as Record<string, unknown>)) {
        if (v === null) delete merged[k]
        else merged[k] = v
      }
      patch.metadata = merged
    }

    store.updateTask(taskId, patch)
    return JSON.stringify({ success: true, task_id: taskId, updated: patch })
  },
  requiresApproval: () => false,
}

// ── TaskList ──

const taskListHandler: ToolHandler = {
  definition: {
    name: 'TaskList',
    description: 'List all tasks in the current session with their status, owner, and dependencies.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  execute: async (_input, ctx) => {
    if (hasActiveTeam()) {
      const team = useTeamStore.getState().activeTeam!
      const tasks = team.tasks
      return JSON.stringify({
        mode: 'team',
        team_name: team.name,
        total: tasks.length,
        tasks: tasks.map((t) => ({
          id: t.id,
          subject: t.subject,
          status: t.status,
          owner: t.owner,
          dependsOn: t.dependsOn,
        })),
      })
    }

    const tasks = getStandaloneTasks(ctx.sessionId)

    return JSON.stringify({
      mode: 'standalone',
      total: tasks.length,
      tasks: tasks.map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        owner: t.owner,
        blockedBy: t.blockedBy.filter(
          (bid) => getStandaloneTask(bid, ctx.sessionId)?.status !== 'completed'
        ),
      })),
    })
  },
  requiresApproval: () => false,
}

// ── Registration ──

export function registerTaskTools(): void {
  toolRegistry.register(taskCreateHandler)
  toolRegistry.register(taskGetHandler)
  toolRegistry.register(taskUpdateHandler)
  toolRegistry.register(taskListHandler)
}
