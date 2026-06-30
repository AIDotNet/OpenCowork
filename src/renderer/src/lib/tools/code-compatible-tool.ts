import { toolRegistry } from '../agent/tool-registry'
import { encodeStructuredToolResult } from './tool-result-format'
import type { ToolHandler } from './tool-types'

function encodeNativeOnlyCodeCompatibleResult(
  toolName: string
): ReturnType<typeof encodeStructuredToolResult> {
  return encodeStructuredToolResult({
    error: `${toolName} execution has migrated to .NET Native Worker.`
  })
}

const powerShellHandler: ToolHandler = {
  definition: {
    name: 'PowerShell',
    description: 'Execute a command through Windows PowerShell.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds' }
      },
      required: ['command']
    }
  },
  execute: async () => encodeNativeOnlyCodeCompatibleResult('PowerShell'),
  requiresApproval: () => true
}

const monitorHandler: ToolHandler = {
  definition: {
    name: 'Monitor',
    description:
      'Run a background command and monitor its output through OpenCowork background tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to run in the background' },
        description: { type: 'string', description: 'Short monitor description' }
      },
      required: ['command']
    }
  },
  execute: async () => encodeNativeOnlyCodeCompatibleResult('Monitor'),
  requiresApproval: () => true
}

export function registerCodeCompatibleTools(): void {
  if (window.electron.process.platform === 'win32') {
    toolRegistry.register(powerShellHandler)
  }
  toolRegistry.register(monitorHandler)
}
