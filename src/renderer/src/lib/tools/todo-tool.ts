import { toolRegistry } from '../agent/tool-registry'
import { encodeStructuredToolResult } from './tool-result-format'
import type { ToolHandler } from './tool-types'

function encodeNativeOnlyTaskResult(toolName: string): string {
  return encodeStructuredToolResult({
    error: `${toolName} execution has migrated to .NET Native Worker.`
  })
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
        title: {
          type: 'string',
          description:
            'A detailed task title with enough context that no separate description is needed'
        },
        activeForm: {
          type: 'string',
          description:
            'Present continuous form shown in spinner when in_progress (e.g., "Running tests")'
        },
        metadata: {
          type: 'object',
          description: 'Arbitrary metadata to attach to the task'
        }
      },
      required: ['title']
    }
  },
  execute: async () => encodeNativeOnlyTaskResult('TaskCreate'),
  requiresApproval: () => false
}

// ── TaskGet ──

const taskGetHandler: ToolHandler = {
  definition: {
    name: 'TaskGet',
    description:
      'Retrieve a task by its ID to inspect its title, status, ownership, and dependencies.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The ID of the task to retrieve'
        }
      },
      required: ['taskId']
    }
  },
  execute: async () => encodeNativeOnlyTaskResult('TaskGet'),
  requiresApproval: () => false
}

// ── TaskUpdate ──

const taskUpdateHandler: ToolHandler = {
  definition: {
    name: 'TaskUpdate',
    description:
      'Update a task: change status, title, owner, or manage dependencies. Set status to "deleted" to permanently remove a task.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The ID of the task to update' },
        title: {
          type: 'string',
          description:
            'New detailed title for the task. Include enough detail that no description is needed.'
        },
        activeForm: {
          type: 'string',
          description:
            'Present continuous form shown in spinner when in_progress (e.g., "Running tests")'
        },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'deleted'],
          description: 'New status for the task'
        },
        addBlocks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task IDs that this task blocks'
        },
        addBlockedBy: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task IDs that block this task'
        },
        owner: { type: 'string', description: 'New owner for the task' },
        metadata: {
          type: 'object',
          description: 'Metadata keys to merge into the task. Set a key to null to delete it.'
        }
      },
      required: ['taskId']
    }
  },
  execute: async () => encodeNativeOnlyTaskResult('TaskUpdate'),
  requiresApproval: () => false
}

// ── TaskList ──

const taskListHandler: ToolHandler = {
  definition: {
    name: 'TaskList',
    description:
      'List all tasks in the current session with their detailed titles, status, owner, and dependencies.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  execute: async () => encodeNativeOnlyTaskResult('TaskList'),
  requiresApproval: () => false
}

// ── Registration ──

export function registerTaskTools(): void {
  toolRegistry.register(taskCreateHandler)
  toolRegistry.register(taskGetHandler)
  toolRegistry.register(taskUpdateHandler)
  toolRegistry.register(taskListHandler)
}
