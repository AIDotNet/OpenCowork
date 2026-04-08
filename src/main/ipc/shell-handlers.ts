import { ipcMain, shell, BrowserWindow } from 'electron'
import { safeSendToWindow } from '../window-ipc'
import { spawn } from 'child_process'
import { StringDecoder } from 'string_decoder'

const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g')
const COMPACT_OUTPUT_CHAR_THRESHOLD = 6000
const COMPACT_OUTPUT_LINE_THRESHOLD = 160
const MAX_RETURNED_STDOUT_CHARS = 12000
const MAX_RETURNED_STDERR_CHARS = 8000
const MAX_LIVE_BUFFER_CHARS = 2_000_000
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
}

interface CompactStreamResult {
  text: string
  totalChars: number
  totalLines: number
  errorLikeLines: number
  warningLikeLines: number
  compacted: boolean
}

function stripAnsi(raw: string): string {
  return raw.replace(ANSI_ESCAPE_RE, '')
}

function sanitizeOutput(raw: string, maxLen: number): string {
  const normalized = stripAnsi(raw)
  const trimmed = normalized.slice(0, maxLen)
  // Detect binary / non-text output by sampling the first 256 chars
  const sample = trimmed.slice(0, 256)
  let bad = 0
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i)
    // non-printable control chars (except tab, LF, CR) or replacement char U+FFFD
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
}): {
  exitCode: number
  stdout: string
  stderr: string
  error?: string
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
    summary: {
      mode: stdout.compacted || stderr.compacted ? 'compact' : 'full',
      noisy: stdout.compacted || stderr.compacted,
      totalChars: stdout.totalChars + stderr.totalChars,
      totalLines: stdout.totalLines + stderr.totalLines,
      stdoutLines: stdout.totalLines,
      stderrLines: stderr.totalLines,
      errorLikeLines: stdout.errorLikeLines + stderr.errorLikeLines,
      warningLikeLines: stdout.warningLikeLines + stderr.warningLikeLines
    }
  }
}

async function terminateChildProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return

  if (process.platform === 'win32') {
    const pid = child.pid
    if (pid) {
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(pid), '/f', '/t'], {
          shell: true,
          windowsHide: true
        })
        killer.on('error', () => resolve())
        killer.on('close', () => resolve())
      })
      return
    }
  }

  try {
    child.kill('SIGTERM')
  } catch {
    return
  }

  await new Promise((resolve) => setTimeout(resolve, 300))
  if (child.exitCode === null) {
    try {
      child.kill('SIGKILL')
    } catch {
      // ignore
    }
  }
}

export function registerShellHandlers(): void {
  const runningShellProcesses = new Map<
    string,
    { child: ReturnType<typeof spawn>; abort: () => void }
  >()

  ipcMain.handle(
    'shell:exec',
    async (_event, args: { command: string; timeout?: number; cwd?: string; execId?: string }) => {
      const DEFAULT_TIMEOUT = 600_000
      const MAX_TIMEOUT = 3_600_000
      const timeout = Math.min(args.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT)
      const execId = args.execId

      // On Windows, default cmd.exe code page (e.g. CP936) != UTF-8.
      // Prepend chcp 65001 to switch console to UTF-8 before running the command.
      const cmd = process.platform === 'win32' ? `chcp 65001 >nul & ${args.command}` : args.command

      return new Promise((resolve) => {
        let stdout = ''
        let stderr = ''
        let killed = false
        let settled = false
        let timeoutTimer: ReturnType<typeof setTimeout> | null = null
        let forceResolveTimer: ReturnType<typeof setTimeout> | null = null
        let exitResolveTimer: ReturnType<typeof setTimeout> | null = null

        const child = spawn(cmd, {
          cwd: args.cwd || process.cwd(),
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            // Force Python to use UTF-8 for stdin/stdout/stderr
            PYTHONIOENCODING: 'utf-8',
            PYTHONUTF8: '1',
            // Disable Python output buffering so streaming output arrives in real-time
            PYTHONUNBUFFERED: '1'
          }
        })

        const finalize = (payload: {
          exitCode: number
          stdout: string
          stderr: string
          error?: string
        }): void => {
          if (settled) return
          settled = true
          if (execId) runningShellProcesses.delete(execId)
          if (timeoutTimer) {
            clearTimeout(timeoutTimer)
            timeoutTimer = null
          }
          if (forceResolveTimer) {
            clearTimeout(forceResolveTimer)
            forceResolveTimer = null
          }
          if (exitResolveTimer) {
            clearTimeout(exitResolveTimer)
            exitResolveTimer = null
          }
          child.stdout?.removeAllListeners('data')
          child.stderr?.removeAllListeners('data')
          child.removeAllListeners('error')
          child.removeAllListeners('exit')
          child.removeAllListeners('close')
          resolve(buildShellResult(payload))
        }

        const requestAbort = (): void => {
          if (child.exitCode !== null || settled) return
          killed = true
          void terminateChildProcess(child)
          if (forceResolveTimer) return
          forceResolveTimer = setTimeout(() => {
            if (child.exitCode !== null || settled) return
            finalize({
              exitCode: 1,
              stdout,
              stderr: `${stderr}\n[Process termination timed out]`
            })
          }, 2000)
        }

        if (execId) {
          runningShellProcesses.set(execId, { child, abort: requestAbort })
        }

        const sendChunk = (chunk: string, stream: ShellStream): void => {
          if (!execId) return
          const win = BrowserWindow.getAllWindows()[0]
          if (win) {
            safeSendToWindow(win, 'shell:output', { execId, chunk, stream })
          }
        }

        child.stdout?.on('data', (data: Buffer) => {
          const text = data.toString('utf8')
          stdout += text
          if (stdout.length > MAX_LIVE_BUFFER_CHARS) {
            stdout = stdout.slice(-MAX_LIVE_BUFFER_CHARS)
          }
          sendChunk(text, 'stdout')
        })

        child.stderr?.on('data', (data: Buffer) => {
          const text = data.toString('utf8')
          stderr += text
          if (stderr.length > MAX_LIVE_BUFFER_CHARS) {
            stderr = stderr.slice(-MAX_LIVE_BUFFER_CHARS)
          }
          sendChunk(text, 'stderr')
        })

        child.on('exit', (code) => {
          if (settled || exitResolveTimer) return
          exitResolveTimer = setTimeout(() => {
            finalize({
              exitCode: killed ? 1 : (code ?? 0),
              stdout,
              stderr
            })
          }, 120)
        })

        child.on('close', (code) => {
          finalize({
            exitCode: killed ? 1 : (code ?? 0),
            stdout,
            stderr
          })
        })

        child.on('error', (err) => {
          finalize({
            exitCode: 1,
            stdout,
            stderr,
            error: err.message
          })
        })

        // Safety: kill on timeout
        timeoutTimer = setTimeout(() => {
          requestAbort()
        }, timeout)
      })
    }
  )

  ipcMain.on('shell:abort', (_event, data: { execId?: string }) => {
    const execId = data?.execId
    if (!execId) return
    const running = runningShellProcesses.get(execId)
    if (!running) return
    running.abort()
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
