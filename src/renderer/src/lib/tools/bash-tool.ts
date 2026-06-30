import { toolRegistry } from '../agent/tool-registry'
import { encodeBashToolResult } from './bash-output'
import type { ToolHandler } from './tool-types'

const DEFAULT_COMMAND_TIMEOUT_MS = 600_000

function nativeOnlyBashResult(): string {
  return encodeBashToolResult({
    exitCode: 1,
    stderr: 'Bash execution has migrated to .NET Native Worker.'
  })
}

const bashHandler: ToolHandler = {
  definition: {
    name: 'Bash',
    description: 'Execute a shell command',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        timeout: {
          type: 'number',
          description: `Timeout in milliseconds (max 3600000, default ${DEFAULT_COMMAND_TIMEOUT_MS})`
        },
        run_in_background: {
          type: 'boolean',
          description:
            'Run command in background without blocking; if omitted, long-running commands are auto-detected'
        },
        force_foreground: {
          type: 'boolean',
          description:
            'Force foreground execution for long-running commands (default false; use only when necessary)'
        },
        description: { type: 'string', description: '5-10 word description of the command' }
      },
      required: ['command']
    }
  },
  execute: async () => nativeOnlyBashResult(),
  requiresApproval: (_input, ctx) => {
    if (ctx.channelPermissions) return !ctx.channelPermissions.allowShell
    return true
  }
}

export function registerBashTools(): void {
  toolRegistry.register(bashHandler)
}
