import { ipcMain, shell, BrowserWindow } from 'electron'
import { safeSendToWindow } from '../window-ipc'
import {
  createTerminalSession,
  getTerminalSessionSnapshot,
  killTerminalSession,
  onTerminalSessionExit,
  onTerminalSessionOutput
} from './terminal-handlers'

const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\[[0-9;?]*[ -/]*[@-~]`, 'g')
const COMPACT_OUTPUT_CHAR_THRESHOLD = 6000
const COMPACT_OUTPUT_LINE_THRESHOLD = 160
const MAX_RETURNED_STDOUT_CHARS = 12000
const MAX_RETURNED_STDERR_CHARS = 8000
const HEAD_LINE_COUNT = 8
const TAIL_LINE_COUNT = 60
const MAX_ERROR_LINE_COUNT = 30
const MAX_WARNING_LINE_COUNT = 20
const ERROR_LIKE_RE =
  /\b(error|failed|exception|traceback|fatal|panic|cannot|unable|undefined reference|syntax error|test(?:s)? failed?)\b/i
const WARNING_LIKE_RE = /\bwarn(?:ing)?\b/i

type ShellStream = 'stdout' | 'stderr'

interface ShellOutputSummary {
  mode: 'full' | 'compact'
  noisy: boolean
  totalChars: number
  totalLines: number
  stdoutLines: number
  stderrLines: number
  errorLikeLines: number
  warningLikeLines: number
  totalMs?: number
  spawnMs?: number
  firstChunkMs?: number
  shell?: string
  executionEngine?: 'main'
  timedOut?: boolean
  aborted?: boolean
}

interface CompactStreamResult {
  text: string
  totalChars: number
  totalLines: number
  errorLikeLines: number
  warningLikeLines: number
  compacted: boolean
}

interface ShellExecutionTiming {
  totalMs: number
  spawnMs: number
  firstChunkMs?: number
  shell: string
  timedOut?: boolean
  aborted?: boolean
}

function stripAnsi(raw: string): string {
  return raw.replace(ANSI_ESCAPE_RE, '')
}

function sanitizeOutput(raw: string, maxLen: number): string {
  const normalized = stripAnsi(raw)
  const trimmed = normalized.slice(0, maxLen)
  const sample = trimmed.slice(0, 256)
  let bad = 0
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i)
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0xfffd) bad++
  }
  if (sample.length > 0 && bad / sample.length > 0.1) {
    return `[Binary or non-text output, ${raw.length} bytes - content omitted]`
  }
  return trimmed
}

function splitLines(raw: string): string[] {
  const normalized = stripAnsi(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return normalized.split('\n')
}

function collectMatchingLines(lines: string[], pattern: RegExp, limit: number): string[] {
  const seen = new Set<string>()
  const matches: string[] = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line || !pattern.test(line)) continue
    const key = line.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    matches.unshift(line)
    if (matches.length >= limit) break
  }
  return matches
}

function compactStreamOutput(
  raw: string,
  stream: ShellStream,
  exitCode: number,
  maxLen: number
): CompactStreamResult {
  const sanitized = sanitizeOutput(raw, maxLen)
  const lines = splitLines(raw)
  const errorLines = collectMatchingLines(lines, ERROR_LIKE_RE, MAX_ERROR_LINE_COUNT)
  const warningLines = collectMatchingLines(lines, WARNING_LIKE_RE, MAX_WARNING_LINE_COUNT)
  const noisy =
    stripAnsi(raw).length > COMPACT_OUTPUT_CHAR_THRESHOLD ||
    lines.length > COMPACT_OUTPUT_LINE_THRESHOLD

  if (!noisy) {
    return {
      text: sanitized,
      totalChars: stripAnsi(raw).length,
      totalLines: lines.length,
      errorLikeLines: errorLines.length,
      warningLikeLines: warningLines.length,
      compacted: false
    }
  }

  const head = lines.slice(0, HEAD_LINE_COUNT)
  const tail = lines.slice(-TAIL_LINE_COUNT)
  const sections: string[] = []

  if (head.length > 0) {
    sections.push(head.join('\n'))
  }

  if (stream === 'stderr' && errorLines.length > 0) {
    sections.push(`[error-like lines]\n${errorLines.join('\n')}`)
  } else if (stream === 'stdout' && exitCode === 0 && warningLines.length > 0) {
    sections.push(`[warning-like lines]\n${warningLines.join('\n')}`)
  }

  const omittedLineCount = Math.max(lines.length - head.length - tail.length, 0)
  if (tail.length > 0) {
    const header =
      omittedLineCount > 0
        ? `[last ${tail.length} lines, omitted ${omittedLineCount} earlier lines]`
        : `[last ${tail.length} lines]`
    sections.push(`${header}\n${tail.join('\n')}`)
  }

  return {
    text: sanitizeOutput(sections.join('\n\n'), maxLen),
    totalChars: stripAnsi(raw).length,
    totalLines: lines.length,
    errorLikeLines: errorLines.length,
    warningLikeLines: warningLines.length,
    compacted: true
  }
}

function buildShellResult(payload: {
  exitCode: number
  stdout: string
  stderr: string
  error?: string
  processId?: string
  terminalId?: string
  timing?: ShellExecutionTiming
}): {
  exitCode: number
  stdout: string
  stderr: string
  error?: string
  processId?: string
  terminalId?: string
  summary: ShellOutputSummary
} {
  const stdout = compactStreamOutput(
    payload.stdout,
    'stdout',
    payload.exitCode,
    MAX_RETURNED_STDOUT_CHARS
  )
  const stderr = compactStreamOutput(
    payload.stderr,
    'stderr',
    payload.exitCode,
    MAX_RETURNED_STDERR_CHARS
  )

  return {
    exitCode: payload.exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    ...(payload.error ? { error: payload.error } : {}),
    ...(payload.processId ? { processId: payload.processId } : {}),
    ...(payload.terminalId ? { terminalId: payload.terminalId } : {}),
    summary: {
      mode: stdout.compacted || stderr.compacted ? 'compact' : 'full',
      noisy: stdout.compacted || stderr.compacted,
      totalChars: stdout.totalChars + stderr.totalChars,
      totalLines: stdout.totalLines + stderr.totalLines,
      stdoutLines: stdout.totalLines,
      stderrLines: stderr.totalLines,
      errorLikeLines: stdout.errorLikeLines + stderr.errorLikeLines,
      warningLikeLines: stdout.warningLikeLines + stderr.warningLikeLines,
      ...(payload.timing
        ? {
            totalMs: payload.timing.totalMs,
            spawnMs: payload.timing.spawnMs,
            ...(payload.timing.firstChunkMs !== undefined
              ? { firstChunkMs: payload.timing.firstChunkMs }
              : {}),
            shell: payload.timing.shell,
            executionEngine: 'main' as const,
            timedOut: payload.timing.timedOut === true,
            aborted: payload.timing.aborted === true
          }
        : {})
    }
  }
}

async function terminateShellTerminal(terminalId: string): Promise<void> {
  const result = killTerminalSession(terminalId)
  if (result.error) {
    throw new Error(result.error)
  }
}

export function registerShellHandlers(): void {
  const runningShellProcesses = new Map<
    string,
    { terminalId: string; abort: (reason?: 'user' | 'timeout') => void }
  >()

  ipcMain.handle(
    'shell:exec',
    async (event, args: { command: string; timeout?: number; cwd?: string; execId?: string }) => {
      const DEFAULT_TIMEOUT = 600_000
      const MAX_TIMEOUT = 3_600_000
      const timeout = Math.min(args.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT)
      const execId = args.execId
      const startedAt = Date.now()
      let resolved = false

      const created = await createTerminalSession(
        {
          cwd: args.cwd || process.cwd(),
          command: args.command,
          title: 'Shell',
          shell: process.platform === 'win32' ? 'powershell.exe' : undefined
        },
        event.sender
      )

      if (!created.id) {
        return buildShellResult({
          exitCode: 1,
          stdout: '',
          stderr: created.error ?? 'Failed to create terminal session',
          timing: {
            totalMs: Date.now() - startedAt,
            spawnMs: 0,
            shell: 'pty'
          }
        })
      }

      const terminalId = created.id
      const spawnCompletedAt = Date.now()

      return await new Promise((resolve) => {
        let settled = false
        let abortReason: 'user' | 'timeout' | null = null
        let firstChunkAt: number | null = null
        let timeoutTimer: ReturnType<typeof setTimeout> | null = null
        let exitCleanup: (() => void) | null = null

        const sendChunk = (chunk: string, stream: ShellStream): void => {
          if (!execId) return
          const win = BrowserWindow.getAllWindows()[0]
          if (win) {
            safeSendToWindow(win, 'shell:output', { execId, chunk, stream })
          }
        }

        const finalize = (): void => {
          if (settled || resolved) return
          settled = true
          resolved = true
          if (timeoutTimer) {
            clearTimeout(timeoutTimer)
            timeoutTimer = null
          }
          exitCleanup?.()
          exitCleanup = null
          if (execId) runningShellProcesses.delete(execId)

          const snapshot = getTerminalSessionSnapshot(terminalId)
          const fullOutput = snapshot?.outputBuffer.map((chunk) => chunk.data).join('') ?? ''
          const normalized = stripAnsi(fullOutput)
          const exitCode = snapshot?.exitCode ?? (abortReason === 'timeout' ? 124 : 130)
          const stderr =
            exitCode === 0
              ? ''
              : abortReason === 'timeout'
                ? '[Timed out]'
                : abortReason === 'user'
                  ? '[Aborted]'
                  : ''

          resolve(
            buildShellResult({
              exitCode,
              stdout: normalized,
              stderr,
              processId: terminalId,
              terminalId,
              timing: {
                totalMs: Date.now() - startedAt,
                spawnMs: spawnCompletedAt - startedAt,
                ...(firstChunkAt !== null ? { firstChunkMs: firstChunkAt - startedAt } : {}),
                shell: created.shell ?? 'pty',
                timedOut: abortReason === 'timeout',
                aborted: abortReason === 'user'
              }
            })
          )
        }

        const cleanupOutputListener = onTerminalSessionOutput((payload) => {
          if (payload.id !== terminalId || !payload.data) return
          if (firstChunkAt === null) firstChunkAt = Date.now()
          sendChunk(payload.data, 'stdout')
        })

        const cleanupExitListener = onTerminalSessionExit((payload) => {
          if (payload.id !== terminalId) return
          finalize()
        })

        exitCleanup = () => {
          cleanupOutputListener()
          cleanupExitListener()
        }

        const requestAbort = (reason: 'user' | 'timeout' = 'user'): void => {
          if (settled) return
          abortReason = reason
          void terminateShellTerminal(terminalId).finally(() => {
            setTimeout(finalize, 80)
          })
        }

        if (execId) {
          runningShellProcesses.set(execId, { terminalId, abort: requestAbort })
        }

        timeoutTimer = setTimeout(() => {
          requestAbort('timeout')
        }, timeout)
      })
    }
  )

  ipcMain.on('shell:abort', (_event, data: { execId?: string }) => {
    const execId = data?.execId
    if (!execId) return
    const running = runningShellProcesses.get(execId)
    if (!running) return
    running.abort('user')
  })

  ipcMain.handle('shell:openPath', async (_event, folderPath: string) => {
    return shell.openPath(folderPath)
  })

  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      return shell.openExternal(url)
    }
  })
}
