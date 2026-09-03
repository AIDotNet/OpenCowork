import { BrowserWindow, type WebContents } from 'electron'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { statSync } from 'fs'
import { spawn, type IPty } from 'node-pty'
import { safeSendMessagePackToWindow } from '../window-ipc'
import { buildShellEnvironment, isExecutableFile } from './shell-environment'
import { registerMessagePackHandler } from './messagepack-handler'

interface CreateTerminalSessionArgs {
  cwd?: string
  shell?: string
  cols?: number
  rows?: number
  title?: string
  command?: string
  env?: Record<string, string>
}

interface CreateTerminalSessionResult {
  id?: string
  shell?: string
  cwd?: string
  cols?: number
  rows?: number
  createdAt?: number
  title?: string
  command?: string
  error?: string
}

interface TerminalOutputChunk {
  seq: number
  data: string
}

interface TerminalOutputEvent {
  id: string
  data: string
  seq: number
}

interface TerminalExitEvent {
  id: string
  exitCode: number
  signal?: number
}

interface TerminalSessionListEntry {
  id: string
  shell: string
  cwd: string
  cols: number
  rows: number
  createdAt: number
  title: string
  command?: string
  exitCode?: number
  exitSignal?: number
  buffer?: TerminalOutputChunk[]
}

interface TerminalShellLaunch {
  shell: string
  args: string[]
}

interface TerminalSession {
  id: string
  pty: IPty
  shell: string
  cwd: string
  cols: number
  rows: number
  createdAt: number
  title: string
  command?: string
  exitCode?: number
  exitSignal?: number
  exitedAt?: number
  buffer: TerminalOutputChunk[]
  bufferBytes: number
  nextSeq: number
  ownerWindowId: number | null
  signalFirstOutput: () => void
}

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const MIN_COLS = 20
const MIN_ROWS = 5
const MAX_OUTPUT_BUFFER_BYTES = 64 * 1024
const EXITED_SESSION_RETENTION_MS = 120_000
const INITIAL_OUTPUT_WAIT_MS = 120

const terminalSessions = new Map<string, TerminalSession>()
const terminalOutputListeners = new Set<(event: TerminalOutputEvent) => void>()
const terminalExitListeners = new Set<(event: TerminalExitEvent) => void>()

function resolveOwnerWindowId(sender?: WebContents | null): number | null {
  return sender ? (BrowserWindow.fromWebContents(sender)?.id ?? null) : null
}

function createWindowEvent(windowId: number | null, channel: string, payload: unknown): void {
  const win =
    (typeof windowId === 'number'
      ? BrowserWindow.getAllWindows().find((candidate) => candidate.id === windowId)
      : null) ?? BrowserWindow.getAllWindows()[0]
  if (!win) return
  safeSendMessagePackToWindow(win, channel, payload)
}

function emitTerminalOutput(event: TerminalOutputEvent): void {
  terminalOutputListeners.forEach((listener) => listener(event))
}

function emitTerminalExit(event: TerminalExitEvent): void {
  terminalExitListeners.forEach((listener) => listener(event))
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

function sanitizeEnvironmentOverrides(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  const env: Record<string, string> = {}
  for (const [key, rawValue] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    if (typeof rawValue !== 'string') continue
    env[key] = rawValue
  }

  return env
}

function isUsableDirectory(dirPath?: string): dirPath is string {
  if (!dirPath?.trim()) return false
  try {
    return statSync(dirPath).isDirectory()
  } catch {
    return false
  }
}

function resolveCwd(cwd?: string): string {
  if (isUsableDirectory(cwd)) return cwd
  const home = homedir()
  if (isUsableDirectory(home)) return home
  return process.cwd()
}

function isPowerShell(shell: string): boolean {
  const name = shell.split(/[\\/]/).pop()?.toLowerCase()
  return (
    name === 'powershell.exe' || name === 'powershell' || name === 'pwsh.exe' || name === 'pwsh'
  )
}

function getShellLaunchCandidates(
  preferredShell: string | undefined,
  env: Record<string, string>
): TerminalShellLaunch[] {
  const preferred = preferredShell?.trim()

  if (process.platform === 'win32') {
    const shells = [
      preferred,
      env.ComSpec || env.COMSPEC || 'cmd.exe',
      'powershell.exe',
      'pwsh.exe'
    ]
    return shells
      .filter(
        (candidate, index, list): candidate is string =>
          Boolean(candidate) && list.indexOf(candidate) === index
      )
      .map((shell) => ({ shell, args: [] }))
  }

  const shells = [preferred, env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(
    (candidate, index, list): candidate is string =>
      Boolean(candidate) && list.indexOf(candidate) === index
  )

  const launches = shells
    .filter((candidate) => isExecutableFile(candidate))
    .map((shell) => ({ shell, args: shell === '/bin/sh' ? [] : ['-i'] }))

  return launches.length > 0 ? launches : [{ shell: '/bin/sh', args: [] }]
}

function getLaunchArgs(launch: TerminalShellLaunch, command?: string): string[] {
  if (process.platform === 'win32') {
    if (!command) {
      return isPowerShell(launch.shell) ? ['-NoLogo'] : []
    }
    return isPowerShell(launch.shell)
      ? ['-NoLogo', '-NoProfile', '-Command', command]
      : ['/d', '/s', '/c', command]
  }
  return command ? ['-lc', command] : launch.args
}

function appendSessionOutput(session: TerminalSession, data: string): TerminalOutputChunk {
  session.nextSeq += 1
  const chunk: TerminalOutputChunk = { seq: session.nextSeq, data }
  session.buffer.push(chunk)
  session.bufferBytes += Buffer.byteLength(data, 'utf8')
  while (session.bufferBytes > MAX_OUTPUT_BUFFER_BYTES && session.buffer.length > 1) {
    const dropped = session.buffer.shift()
    if (!dropped) break
    session.bufferBytes -= Buffer.byteLength(dropped.data, 'utf8')
  }
  return chunk
}

function toSessionRecord(
  session: TerminalSession,
  includeBuffer: boolean
): TerminalSessionListEntry {
  return {
    id: session.id,
    shell: session.shell,
    cwd: session.cwd,
    cols: session.cols,
    rows: session.rows,
    createdAt: session.createdAt,
    title: session.title,
    ...(session.command ? { command: session.command } : {}),
    ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
    ...(session.exitSignal !== undefined ? { exitSignal: session.exitSignal } : {}),
    ...(includeBuffer ? { buffer: session.buffer.slice() } : {})
  }
}

function pruneExpiredExitedSessions(): void {
  const now = Date.now()
  for (const [id, session] of terminalSessions) {
    if (session.exitedAt !== undefined && now - session.exitedAt > EXITED_SESSION_RETENTION_MS) {
      terminalSessions.delete(id)
    }
  }
}

function waitForInitialOutput(session: TerminalSession, timeoutMs: number): Promise<void> {
  if (session.buffer.length > 0 || session.exitCode !== undefined) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      session.signalFirstOutput = () => {}
      resolve()
    }, timeoutMs)
    session.signalFirstOutput = () => {
      clearTimeout(timer)
      session.signalFirstOutput = () => {}
      resolve()
    }
  })
}

export async function createTerminalSession(
  args: CreateTerminalSessionArgs,
  sender?: WebContents | null
): Promise<CreateTerminalSessionResult> {
  pruneExpiredExitedSessions()
  const ownerWindowId = resolveOwnerWindowId(sender)
  const env = {
    ...serializeShellEnvironment(),
    ...sanitizeEnvironmentOverrides(args.env)
  }
  const requestedCwd = args.cwd?.trim()
  const cwd = resolveCwd(requestedCwd)
  const cols = Math.max(MIN_COLS, Math.floor(args.cols ?? DEFAULT_COLS))
  const rows = Math.max(MIN_ROWS, Math.floor(args.rows ?? DEFAULT_ROWS))
  const command = args.command?.trim() || undefined
  let lastError = 'Unknown error'

  for (const launch of getShellLaunchCandidates(args.shell, env)) {
    try {
      const pty = spawn(launch.shell, getLaunchArgs(launch, command), {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: {
          ...env,
          TERM: env.TERM?.trim() || 'xterm-256color'
        }
      })

      const id = `term-${randomUUID()}`
      const session: TerminalSession = {
        id,
        pty,
        shell: launch.shell,
        cwd,
        cols,
        rows,
        createdAt: Date.now(),
        title: args.title?.trim() || launch.shell.split(/[\\/]/).pop() || launch.shell,
        ...(command ? { command } : {}),
        buffer: [],
        bufferBytes: 0,
        nextSeq: 0,
        ownerWindowId,
        signalFirstOutput: () => {}
      }
      terminalSessions.set(id, session)

      pty.onData((data) => {
        const chunk = appendSessionOutput(session, data)
        session.signalFirstOutput()
        const event: TerminalOutputEvent = { id, data, seq: chunk.seq }
        createWindowEvent(session.ownerWindowId, 'terminal:output', event)
        emitTerminalOutput(event)
      })

      pty.onExit(({ exitCode, signal }) => {
        session.exitCode = exitCode
        session.exitSignal = signal
        session.exitedAt = Date.now()
        session.signalFirstOutput()
        const event: TerminalExitEvent = {
          id,
          exitCode,
          ...(signal !== undefined ? { signal } : {})
        }
        createWindowEvent(session.ownerWindowId, 'terminal:exit', event)
        emitTerminalExit(event)
      })

      await waitForInitialOutput(session, INITIAL_OUTPUT_WAIT_MS)

      createWindowEvent(ownerWindowId, 'terminal:created', toSessionRecord(session, false))

      return {
        id,
        shell: session.shell,
        cwd,
        cols,
        rows,
        createdAt: session.createdAt,
        title: session.title,
        ...(command ? { command } : {})
      }
    } catch (error) {
      lastError = `${launch.shell}: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  const cwdHint =
    requestedCwd && requestedCwd !== cwd
      ? ` Requested cwd: ${requestedCwd}. Fallback cwd: ${cwd}.`
      : ` Cwd: ${cwd}.`
  return { error: `Failed to start terminal shell.${cwdHint} Last error: ${lastError}` }
}

export function listTerminalSessionSnapshots(): TerminalSessionListEntry[] {
  pruneExpiredExitedSessions()
  return Array.from(terminalSessions.values())
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((session) => toSessionRecord(session, true))
}

export async function resizeTerminalSession(
  id: string,
  cols: number,
  rows: number
): Promise<{ success?: true; error?: string }> {
  pruneExpiredExitedSessions()
  const session = terminalSessions.get(id)
  if (!session) return { error: 'Terminal not found' }
  if (session.exitCode !== undefined) return { success: true }
  try {
    const nextCols = Math.max(MIN_COLS, Math.floor(cols))
    const nextRows = Math.max(MIN_ROWS, Math.floor(rows))
    session.pty.resize(nextCols, nextRows)
    session.cols = nextCols
    session.rows = nextRows
    return { success: true }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export function onTerminalSessionOutput(
  listener: (event: TerminalOutputEvent) => void
): () => void {
  terminalOutputListeners.add(listener)
  return () => terminalOutputListeners.delete(listener)
}

export function onTerminalSessionExit(listener: (event: TerminalExitEvent) => void): () => void {
  terminalExitListeners.add(listener)
  return () => terminalExitListeners.delete(listener)
}

export function registerTerminalHandlers(): void {
  registerMessagePackHandler<CreateTerminalSessionArgs>('terminal:create', async (args, event) => {
    return await createTerminalSession(args, event.sender)
  })

  registerMessagePackHandler<{ id: string; data: string }>('terminal:input', async (args) => {
    return await writeTerminalSession(args.id, args.data)
  })

  registerMessagePackHandler<{ id: string; cols: number; rows: number }>(
    'terminal:resize',
    async (args) => resizeTerminalSession(args.id, args.cols, args.rows)
  )

  registerMessagePackHandler<{ id: string }>('terminal:kill', async (args) => {
    return await killTerminalSession(args.id)
  })

  registerMessagePackHandler<{ id: string }>('terminal:get', async (args) => {
    const session = await getTerminalSessionSnapshot(args.id)
    return session ? { success: true, session } : { success: false, error: 'Terminal not found' }
  })

  registerMessagePackHandler<undefined>('terminal:list', async () => {
    pruneExpiredExitedSessions()
    return Array.from(terminalSessions.values())
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((session) => toSessionRecord(session, true))
  })
}

export async function getTerminalSessionSnapshot(
  id: string
): Promise<TerminalSessionListEntry | undefined> {
  pruneExpiredExitedSessions()
  const session = terminalSessions.get(id)
  return session ? toSessionRecord(session, true) : undefined
}

export async function writeTerminalSession(
  id: string,
  data: string
): Promise<{ success?: true; error?: string }> {
  pruneExpiredExitedSessions()
  const session = terminalSessions.get(id)
  if (!session) return { error: 'Terminal not found' }
  if (session.exitCode !== undefined) return { error: 'Terminal already exited' }
  try {
    session.pty.write(data)
    return { success: true }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export async function killTerminalSession(id: string): Promise<{ success?: true; error?: string }> {
  pruneExpiredExitedSessions()
  const session = terminalSessions.get(id)
  if (!session) return { error: 'Terminal not found' }
  if (session.exitCode !== undefined) return { success: true }
  try {
    session.pty.kill()
    return { success: true }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export function killAllTerminalSessions(): void {
  terminalSessions.forEach((session) => {
    if (session.exitCode !== undefined) return
    try {
      session.pty.kill()
    } catch {
      // ignore
    }
  })
  terminalSessions.clear()
}
