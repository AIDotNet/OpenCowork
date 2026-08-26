import {
  TASK_TOOL_DEFINITIONS,
  type TaskToolDefinition
} from '../../../../shared/task-tool-definitions'
import { toolRegistry } from '../agent/tool-registry'
import { encodeStructuredToolResult } from './tool-result-format'
import type { ToolHandler } from './tool-types'

function encodeNativeOnlyTaskResult(toolName: string): string {
  return encodeStructuredToolResult({
    error: `${toolName} execution has migrated to .NET Native Worker.`
  })
}

function toTaskToolHandler(definition: TaskToolDefinition): ToolHandler {
  return {
    definition,
    execute: async () => encodeNativeOnlyTaskResult(definition.name),
    requiresApproval: () => false
  }
}

export function registerTaskTools(): void {
  for (const definition of TASK_TOOL_DEFINITIONS) {
    toolRegistry.register(toTaskToolHandler(definition))
  }
}
