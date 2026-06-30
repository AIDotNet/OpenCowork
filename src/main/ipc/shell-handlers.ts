import { ipcMain, shell, BrowserWindow, app } from 'electron'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { safeSendMessagePackToWindow } from '../window-ipc'
import { getNativeWorker } from '../lib/native-worker'
import { buildShellEnvironment } from './shell-environment'
import { decodeMessagePackPayload, toMessagePackChannel } from '../../shared/messagepack/binary-ipc'
import { registerMessagePackHandler } from './messagepack-handler'

const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g')
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
  outputFile?: string
  executionEngine?: 'main' | 'native_aot'
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
  executionEngine?: 'main' | 'native_aot'
  timedOut?: boolean
  aborted?: boolean
}

interface ShellStartedEvent {
  execId: string
  processId: string
  terminalId: string
}

interface NativeShellStartedEvent {
  execId?: string
  processId?: string
  terminalId?: string
}

interface NativeShellOutputEvent {
  execId?: string
  chunk?: string
  stream?: ShellStream
}

interface NativeShellExecResult {
  success: boolean
  exitCode: number
  stdout: string
  stderr: string
  error?: string | null
  processId?: string | null
  terminalId?: string | null
  timing: ShellExecutionTiming
}

interface NativeShellAbortResult {
  success: boolean
  aborted: boolean
  error?: string | null
}

type OpenWithAppId = 'vscode'

type ShellExecArgs = {
  command: string
  timeout?: number
  cwd?: string
  execId?: string
  shell?: string
}

interface OpenCommand {
  command: string
  args: string[]
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

  if (errorLines.length > 0 && (stream === 'stderr' || exitCode !== 0)) {
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
  outputFile?: string
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
  const outputFile =
    stdout.compacted || stderr.compacted
      ? writeShellOutputArchive(payload.stdout, payload.stderr)
      : undefined

  return {
    exitCode: payload.exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    ...(payload.error ? { error: payload.error } : {}),
    ...(payload.processId ? { processId: payload.processId } : {}),
    ...(payload.terminalId ? { terminalId: payload.terminalId } : {}),
    ...(outputFile ? { outputFile } : {}),
    summary: {
      mode: stdout.compacted || stderr.compacted ? 'compact' : 'full',
      noisy: stdout.compacted || stderr.compacted,
      totalChars: stdout.totalChars + stderr.totalChars,
      totalLines: stdout.totalLines + stderr.totalLines,
      stdoutLines: stdout.totalLines,
      stderrLines: stderr.totalLines,
      errorLikeLines: stdout.errorLikeLines + stderr.errorLikeLines,
      warningLikeLines: stdout.warningLikeLines + stderr.warningLikeLines,
      ...(outputFile ? { outputFile } : {}),
      ...(payload.timing
        ? {
            totalMs: payload.timing.totalMs,
            spawnMs: payload.timing.spawnMs,
            ...(payload.timing.firstChunkMs !== undefined
              ? { firstChunkMs: payload.timing.firstChunkMs }
              : {}),
            shell: payload.timing.shell,
            executionEngine: payload.timing.executionEngine ?? 'main',
            timedOut: payload.timing.timedOut === true,
            aborted: payload.timing.aborted === true
          }
        : {})
    }
  }
}

function writeShellOutputArchive(stdout: string, stderr: string): string | undefined {
  try {
    const outputDir = path.join(app.getPath('userData'), 'shell-output')
    fs.mkdirSync(outputDir, { recursive: true })
    const filePath = path.join(outputDir, `shell-output-${Date.now()}.txt`)
    const sections = [
      stdout ? `# stdout\n${stripAnsi(stdout)}` : '',
      stderr ? `# stderr\n${stripAnsi(stderr)}` : ''
    ].filter(Boolean)
    fs.writeFileSync(filePath, `${sections.join('\n\n')}\n`, 'utf-8')
    return filePath
  } catch {
    return undefined
  }
}

function runOpenCommand({ command, args }: OpenCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: false,
      stdio: 'ignore',
      windowsHide: true
    })

    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}

function getOpenWithCommands(appId: OpenWithAppId, targetPath: string): OpenCommand[] {
  if (appId !== 'vscode') return []

  if (process.platform === 'darwin') {
    return [
      { command: '/usr/bin/open', args: ['-a', 'Visual Studio Code', targetPath] },
      { command: 'code', args: [targetPath] }
    ]
  }

  if (process.platform === 'win32') {
    return [{ command: 'cmd.exe', args: ['/d', '/s', '/c', 'code', targetPath] }]
  }

  return [{ command: 'code', args: [targetPath] }]
}

async function openWithWhitelistedApp(appId: OpenWithAppId, targetPath: string): Promise<void> {
  const commands = getOpenWithCommands(appId, targetPath)
  if (commands.length === 0) throw new Error(`Unsupported application: ${appId}`)

  let lastError: unknown
  for (const command of commands) {
    try {
      await runOpenCommand(command)
      return
    } catch (err) {
      lastError = err
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Failed to open ${targetPath}`)
}

function serializeShellEnvironment(): Record<string, string> {
  const env = buildShellEnvironment()
  const serialized: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      serialized[key] = value
    }
  }
  return serialized
}

function isNativeShellStartedEvent(value: unknown): value is NativeShellStartedEvent {
  return typeof value === 'object' && value !== null
}

function isNativeShellOutputEvent(value: unknown): value is NativeShellOutputEvent {
  return typeof value === 'object' && value !== null
}

export function registerShellHandlers(): void {
  const runningShellProcesses = new Map<
    string,
    { terminalId: string; abort: (reason?: 'user' | 'timeout') => void }
  >()

  registerMessagePackHandler<ShellExecArgs>('shell:exec', async (args, event) => {
    const DEFAULT_TIMEOUT = 600_000
    const MAX_TIMEOUT = 3_600_000
    const timeout = Math.min(args.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT)
    const execId = args.execId?.trim()
    const startedAt = Date.now()
    const ownerWindow =
      BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getAllWindows()[0] ?? null
    const nativeWorker = getNativeWorker()

    const cleanupStarted = nativeWorker.onEvent('shell/started', (params) => {
      if (!execId || !ownerWindow || !isNativeShellStartedEvent(params)) return
      if (params.execId !== execId) return
      const payload: ShellStartedEvent = {
        execId,
        processId: String(params.processId ?? params.terminalId ?? execId),
        terminalId: String(params.terminalId ?? params.processId ?? execId)
      }
      runningShellProcesses.set(execId, {
        terminalId: payload.terminalId,
        abort: (reason: 'user' | 'timeout' = 'user') => {
          void nativeWorker
            .request<NativeShellAbortResult>('shell/abort', { execId, reason }, 10_000)
            .catch((error) => console.warn('[Shell] Native abort failed:', error))
        }
      })
      safeSendMessagePackToWindow(ownerWindow, 'shell:started', payload)
    })

    const cleanupOutput = nativeWorker.onEvent('shell/output', (params) => {
      if (!execId || !ownerWindow || !isNativeShellOutputEvent(params)) return
      if (params.execId !== execId || typeof params.chunk !== 'string') return
      const payload = {
        execId,
        chunk: params.chunk,
        stream: params.stream === 'stderr' ? 'stderr' : 'stdout'
      }
      safeSendMessagePackToWindow(ownerWindow, 'shell:output', payload)
    })

    if (execId) {
      runningShellProcesses.set(execId, {
        terminalId: `native-shell-${execId}`,
        abort: (reason: 'user' | 'timeout' = 'user') => {
          void nativeWorker
            .request<NativeShellAbortResult>('shell/abort', { execId, reason }, 10_000)
            .catch((error) => console.warn('[Shell] Native abort failed:', error))
        }
      })
    }

    try {
      const result = await nativeWorker.request<NativeShellExecResult>(
        'shell/exec',
        {
          command: args.command,
          timeout,
          cwd: args.cwd || process.cwd(),
          ...(execId ? { execId } : {}),
          ...(args.shell ? { shell: args.shell } : {}),
          env: serializeShellEnvironment()
        },
        timeout + 30_000
      )

      return buildShellResult({
        exitCode: result.exitCode,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        ...(result.error ? { error: result.error } : {}),
        ...(result.processId ? { processId: result.processId } : {}),
        ...(result.terminalId ? { terminalId: result.terminalId } : {}),
        timing: {
          totalMs: result.timing?.totalMs ?? Date.now() - startedAt,
          spawnMs: result.timing?.spawnMs ?? 0,
          ...(result.timing?.firstChunkMs !== undefined && result.timing?.firstChunkMs !== null
            ? { firstChunkMs: result.timing.firstChunkMs }
            : {}),
          shell: result.timing?.shell ?? 'native',
          executionEngine: 'native_aot',
          timedOut: result.timing?.timedOut === true,
          aborted: result.timing?.aborted === true
        }
      })
    } catch (err) {
      return buildShellResult({
        exitCode: 1,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        error: err instanceof Error ? err.message : String(err),
        timing: {
          totalMs: Date.now() - startedAt,
          spawnMs: 0,
          shell: 'native',
          executionEngine: 'native_aot'
        }
      })
    } finally {
      cleanupStarted()
      cleanupOutput()
      if (execId) runningShellProcesses.delete(execId)
    }
  })

  const abortShellProcess = (data: { execId?: string }): void => {
    const execId = data?.execId
    if (!execId) return
    const running = runningShellProcesses.get(execId)
    if (!running) return
    running.abort('user')
  }

  ipcMain.on(toMessagePackChannel('shell:abort'), (_event, bytes: Uint8Array) => {
    abortShellProcess(decodeMessagePackPayload<{ execId?: string }>(bytes))
  })

  registerMessagePackHandler<string>('shell:openPath', async (folderPath) => {
    return shell.openPath(folderPath)
  })

  registerMessagePackHandler<string>('shell:showItemInFolder', async (targetPath) => {
    try {
      const resolvedPath = path.resolve(targetPath)
      if (!fs.existsSync(resolvedPath)) {
        return { error: `Path does not exist: ${resolvedPath}` }
      }

      shell.showItemInFolder(resolvedPath)
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  registerMessagePackHandler<string>('shell:trashPath', async (targetPath) => {
    try {
      const resolvedPath = path.resolve(targetPath)
      if (!fs.existsSync(resolvedPath)) {
        return { error: `Path does not exist: ${resolvedPath}` }
      }

      await shell.trashItem(resolvedPath)
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  registerMessagePackHandler<{ path: string; appId: OpenWithAppId }>(
    'shell:openWithApp',
    async (args) => {
      try {
        const resolvedPath = path.resolve(args.path)
        if (!fs.existsSync(resolvedPath)) {
          return { error: `Path does not exist: ${resolvedPath}` }
        }

        await openWithWhitelistedApp(args.appId, resolvedPath)
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  registerMessagePackHandler<string>('shell:openExternal', async (url) => {
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      return shell.openExternal(url)
    }
  })
}
