import { toolRegistry } from '../agent/tool-registry'
import { IPC } from '../ipc/channels'
import { DEFAULT_COMMAND_TIMEOUT_MS, selectCommandExecutor } from './command-executor'
import { encodeBashToolResult } from './bash-output'
import type { ToolHandler } from './tool-types'
import { useAgentStore } from '@renderer/stores/agent-store'

let execCounter = 0
const LONG_RUNNING_COMMAND_PATTERNS: RegExp[] = [
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve)\b/i,
  /\b(next|vite|nuxt|astro)\s+dev\b/i,
  /\b(webpack-dev-server|webpack)\b.*\b(--watch|serve)\b/i,
  /\b(docker\s+compose|docker-compose)\s+up\b/i,
  /\b(kubectl\s+logs)\b.*\s-f\b/i,
  /\b(tail|less)\s+-f\b/i,
  /\b(nodemon|ts-node-dev)\b/i,
  /\b(uvicorn|gunicorn)\b.*\b(--reload|--workers|--bind|--host)\b/i,
  /\bpython\b.*\b-m\s+http\.server\b/i
]
const LIVE_PREVIEW_MAX_LINES = 80
const LIVE_PREVIEW_MAX_CHARS = 4000
const LIVE_ERROR_PREVIEW_MAX_LINES = 24
const ERROR_LIKE_RE =
  /\b(error|failed|exception|traceback|fatal|panic|cannot|unable|undefined reference|syntax error|test(?:s)? failed?)\b/i

type ShellStream = 'stdout' | 'stderr'

interface ShellOutputEvent {
  execId: string
  chunk: string
  stream?: ShellStream
}

interface ShellStartedEvent {
  execId: string
  processId?: string
  terminalId?: string
}

interface LiveShellPreview {
  stdout: string
  stderr: string
  errorLines: string[]
  stdoutChars: number
  stderrChars: number
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

function isLikelyLongRunningCommand(command: string): boolean {
  const normalized = command.trim()
  if (!normalized) return false
  return LONG_RUNNING_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized))
}

function keepLastLines(
  value: string,
  maxLines: number,
  maxChars: number
): {
  text: string
  truncated: boolean
} {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  const trimmedLines = lines.length > maxLines ? lines.slice(-maxLines) : lines
  const joined = trimmedLines.join('\n')
  if (joined.length <= maxChars) {
    return {
      text: joined,
      truncated: lines.length > maxLines
    }
  }
  return {
    text: joined.slice(-maxChars),
    truncated: true
  }
}

function collectErrorLines(existing: string[], chunk: string): string[] {
  const next = [...existing]
  for (const line of chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    const text = line.trim()
    if (!text || !ERROR_LIKE_RE.test(text)) continue
    if (next.includes(text)) continue
    next.push(text)
    if (next.length > LIVE_ERROR_PREVIEW_MAX_LINES) next.shift()
  }
  return next
}

function appendPreview(
  preview: LiveShellPreview,
  stream: ShellStream,
  chunk: string
): LiveShellPreview {
  const next = { ...preview }
  if (stream === 'stderr') {
    const result = keepLastLines(
      `${next.stderr}${chunk}`,
      LIVE_PREVIEW_MAX_LINES,
      LIVE_PREVIEW_MAX_CHARS
    )
    next.stderr = result.text
    next.stderrTruncated = next.stderrTruncated || result.truncated
    next.stderrChars += chunk.length
    next.errorLines = collectErrorLines(next.errorLines, chunk)
    return next
  }

  const result = keepLastLines(
    `${next.stdout}${chunk}`,
    LIVE_PREVIEW_MAX_LINES,
    LIVE_PREVIEW_MAX_CHARS
  )
  next.stdout = result.text
  next.stdoutTruncated = next.stdoutTruncated || result.truncated
  next.stdoutChars += chunk.length
  next.errorLines = collectErrorLines(next.errorLines, chunk)
  return next
}

function buildLivePreviewPayload(
  preview: LiveShellPreview,
  metadata?: { processId?: string; terminalId?: string }
): string {
  const stderr =
    preview.errorLines.length > 0
      ? `${preview.errorLines.join('\n')}${preview.stderr ? `\n\n[last stderr lines]\n${preview.stderr}` : ''}`
      : preview.stderr
  return encodeBashToolResult({
    stdout: preview.stdout,
    stderr,
    ...(metadata?.processId ? { processId: metadata.processId } : {}),
    ...(metadata?.terminalId ? { terminalId: metadata.terminalId } : {}),
    summary: {
      live: true,
      mode: 'tail',
      noisy: preview.stdoutTruncated || preview.stderrTruncated,
      totalChars: preview.stdoutChars + preview.stderrChars,
      errorLikeLines: preview.errorLines.length
    }
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
          description: 'Timeout in milliseconds (max 3600000, default 600000)'
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
  execute: async (input, ctx) => {
    const command = String(input.command ?? '')
    if (!command.trim()) {
      return encodeBashToolResult({ exitCode: 1, stderr: 'Missing command' })
    }

    const commandExecutor = selectCommandExecutor(ctx)
    if (commandExecutor?.transport === 'ssh') {
      return (
        await commandExecutor.executeForeground({
          command,
          timeout: typeof input.timeout === 'number' ? input.timeout : DEFAULT_COMMAND_TIMEOUT_MS
        })
      ).output
    }

    const explicitBackground =
      typeof input.run_in_background === 'boolean' ? input.run_in_background : undefined
    const isLongRunning = isLikelyLongRunningCommand(command)
    const forceForeground = Boolean(input.force_foreground)
    const autoBackground = isLongRunning && !forceForeground
    const runInBackground = forceForeground
      ? false
      : isLongRunning
        ? true
        : (explicitBackground ?? false)
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
                : undefined
        }
      })) as { id?: string; error?: string }

      if (!result?.id) {
        return encodeBashToolResult({
          exitCode: 1,
          stderr: result?.error ?? 'Failed to start background process'
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
              : undefined
      })

      return encodeBashToolResult({
        exitCode: 0,
        background: true,
        autoBackground,
        processId: result.id,
        command,
        sessionId: ctx.sessionId ?? null,
        stdout: autoBackground
          ? `Auto-background started for long-running command (id=${result.id}). Open Context panel to monitor, stop, or interact.`
          : `Background process started (id=${result.id}). Open Context panel to monitor, stop, or interact.`
      })
    }

    // Listen for streaming output chunks from main process
    let preview: LiveShellPreview = {
      stdout: '',
      stderr: '',
      errorLines: [],
      stdoutChars: 0,
      stderrChars: 0,
      stdoutTruncated: false,
      stderrTruncated: false
    }
    let outputTimer: ReturnType<typeof setTimeout> | null = null
    let lastOutputFlush = 0
    let foregroundResultMetadata: { processId?: string; terminalId?: string } | undefined
    const flushOutput = (): void => {
      outputTimer = null
      lastOutputFlush = Date.now()
      if (toolUseId) {
        useAgentStore.getState().updateToolCall(toolUseId, {
          output: buildLivePreviewPayload(preview, foregroundResultMetadata)
        })
      }
    }

    const cleanupStarted = ctx.ipc.on(IPC.SHELL_STARTED, (...args: unknown[]) => {
      const data = args[0] as ShellStartedEvent
      if (data.execId !== execId) return
      foregroundResultMetadata = {
        processId: data.processId ?? foregroundResultMetadata?.processId,
        terminalId: data.terminalId ?? foregroundResultMetadata?.terminalId
      }
      flushOutput()
    })

    const cleanup = ctx.ipc.on('shell:output', (...args: unknown[]) => {
      const data = args[0] as ShellOutputEvent
      if (data.execId !== execId) return
      preview = appendPreview(preview, data.stream === 'stderr' ? 'stderr' : 'stdout', data.chunk)
      const now = Date.now()
      if (now - lastOutputFlush >= 60) {
        if (outputTimer) {
          clearTimeout(outputTimer)
          outputTimer = null
        }
        flushOutput()
        return
      }
      if (!outputTimer) {
        outputTimer = setTimeout(() => {
          flushOutput()
        }, 60)
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
      const result = (await ctx.ipc.invoke(IPC.SHELL_EXEC, {
        command,
        timeout: input.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS,
        cwd: ctx.workingFolder,
        execId
      })) as { processId?: string; terminalId?: string }
      foregroundResultMetadata = {
        processId: result.processId,
        terminalId: result.terminalId
      }
      flushOutput()
      return encodeBashToolResult(result as Record<string, unknown>)
    } finally {
      ctx.signal.removeEventListener('abort', abortHandler)
      if (toolUseId) {
        useAgentStore.getState().clearForegroundShellExec(toolUseId)
      }
      if (outputTimer) {
        clearTimeout(outputTimer)
        outputTimer = null
      }
      flushOutput()
      cleanupStarted()
      cleanup()
    }
  },
  requiresApproval: (_input, ctx) => {
    // Plugin context: respect allowShell permission
    if (ctx.channelPermissions) return !ctx.channelPermissions.allowShell
    return true // Normal sessions: always require approval
  }
}

export function registerBashTools(): void {
  toolRegistry.register(bashHandler)
}
