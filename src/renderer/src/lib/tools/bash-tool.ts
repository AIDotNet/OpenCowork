import { toolRegistry } from '../agent/tool-registry'
import { IPC } from '../ipc/channels'
import type { ToolHandler } from './tool-types'
import { useAgentStore } from '@renderer/stores/agent-store'

let execCounter = 0
const DEFAULT_BASH_TIMEOUT_MS = 600_000
const LONG_RUNNING_COMMAND_PATTERNS: RegExp[] = [
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve)\b/i,
  /\b(next|vite|nuxt|astro)\s+dev\b/i,
  /\b(webpack-dev-server|webpack)\b.*\b(--watch|serve)\b/i,
  /\b(docker\s+compose|docker-compose)\s+up\b/i,
  /\b(kubectl\s+logs)\b.*\s-f\b/i,
  /\b(tail|less)\s+-f\b/i,
  /\b(nodemon|ts-node-dev)\b/i,
  /\b(uvicorn|gunicorn)\b.*\b(--reload|--workers|--bind|--host)\b/i,
  /\bpython\b.*\b-m\s+http\.server\b/i,
]

function isLikelyLongRunningCommand(command: string): boolean {
  const normalized = command.trim()
  if (!normalized) return false
  return LONG_RUNNING_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized))
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
          description: 'Timeout in milliseconds (max 3600000, default 600000)',
        },
        run_in_background: {
          type: 'boolean',
          description:
            'Run command in background without blocking; if omitted, long-running commands are auto-detected',
        },
        force_foreground: {
          type: 'boolean',
          description:
            'Force foreground execution for long-running commands (default false; use only when necessary)',
        },
        description: { type: 'string', description: '5-10 word description of the command' },
      },
      required: ['command'],
    },
  },
  execute: async (input, ctx) => {
    const command = String(input.command ?? '')

    // SSH routing: execute command on remote server via ssh:exec
    if (ctx.sshConnectionId) {
      const result = (await ctx.ipc.invoke(IPC.SSH_EXEC, {
        connectionId: ctx.sshConnectionId,
        command: ctx.workingFolder ? `cd ${ctx.workingFolder} && ${command}` : command,
        timeout: input.timeout ?? DEFAULT_BASH_TIMEOUT_MS,
      })) as { exitCode?: number; stdout?: string; stderr?: string; error?: string }

      if (result.error) {
        return JSON.stringify({ exitCode: 1, stderr: result.error })
      }
      return JSON.stringify(result)
    }

    const explicitBackground =
      typeof input.run_in_background === 'boolean' ? input.run_in_background : undefined
    const isLongRunning = isLikelyLongRunningCommand(command)
    const forceForeground = Boolean(input.force_foreground)
    const autoBackground = isLongRunning && !forceForeground
    const runInBackground =
      forceForeground ? false : isLongRunning ? true : (explicitBackground ?? false)
    const execId = `exec-${Date.now()}-${++execCounter}`
    const toolUseId = ctx.currentToolUseId

    if (runInBackground) {
      const result = (await ctx.ipc.invoke(IPC.PROCESS_SPAWN, {
        command,
        cwd: ctx.workingFolder,
        metadata: {
          source: 'bash-tool',
          sessionId: ctx.sessionId,
          toolUseId,
          description:
            typeof input.description === 'string'
              ? input.description
              : autoBackground
                ? 'Auto-detected long-running command'
                : undefined,
        },
      })) as { id?: string; error?: string }

      if (!result?.id) {
        return JSON.stringify({
          exitCode: 1,
          stderr: result?.error ?? 'Failed to start background process',
        })
      }

      useAgentStore.getState().registerBackgroundProcess({
        id: result.id,
        command,
        cwd: ctx.workingFolder,
        sessionId: ctx.sessionId,
        toolUseId,
        source: 'bash-tool',
        description:
          typeof input.description === 'string'
            ? input.description
            : autoBackground
              ? 'Auto-detected long-running command'
              : undefined,
      })

      return JSON.stringify({
        exitCode: 0,
        background: true,
        autoBackground,
        processId: result.id,
        command,
        sessionId: ctx.sessionId ?? null,
        stdout: autoBackground
          ? `Auto-background started for long-running command (id=${result.id}). Open Context panel to monitor, stop, or interact.`
          : `Background process started (id=${result.id}). Open Context panel to monitor, stop, or interact.`,
      })
    }

    // Listen for streaming output chunks from main process
    let accumulated = ''
    const cleanup = ctx.ipc.on('shell:output', (...args: unknown[]) => {
      const data = args[0] as { execId: string; chunk: string }
      if (data.execId !== execId) return
      accumulated += data.chunk
      if (toolUseId) {
        useAgentStore.getState().updateToolCall(toolUseId, {
          output: accumulated,
        })
      }
    })

    const abortHandler = (): void => {
      ctx.ipc.send(IPC.SHELL_ABORT, { execId })
    }
    ctx.signal.addEventListener('abort', abortHandler, { once: true })
    if (toolUseId) {
      useAgentStore.getState().registerForegroundShellExec(toolUseId, execId)
    }

    try {
      const result = await ctx.ipc.invoke(IPC.SHELL_EXEC, {
        command,
        timeout: input.timeout ?? DEFAULT_BASH_TIMEOUT_MS,
        cwd: ctx.workingFolder,
        execId,
      })
      return JSON.stringify(result)
    } finally {
      ctx.signal.removeEventListener('abort', abortHandler)
      if (toolUseId) {
        useAgentStore.getState().clearForegroundShellExec(toolUseId)
      }
      cleanup()
    }
  },
  requiresApproval: (_input, ctx) => {
    // Plugin context: respect allowShell permission
    if (ctx.pluginPermissions) return !ctx.pluginPermissions.allowShell
    return true // Normal sessions: always require approval
  },
}

export function registerBashTools(): void {
  toolRegistry.register(bashHandler)
}
