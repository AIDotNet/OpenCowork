import { ipcMain, BrowserWindow } from 'electron'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { accessSync, constants, statSync } from 'fs'
import { safeSendToWindow } from '../window-ipc'
import { spawn, type IPty } from 'node-pty'

interface TerminalSession {
  id: string
  pty: IPty
  windowId: number | null
  shell: string
  cwd: string
  cols: number
  rows: number
  createdAt: number
  title: string
  nextSeq: number
  outputBuffer: TerminalOutputChunk[]
  outputBufferBytes: number
}

interface ResolvedShellLaunch {
  shell: string
  args: string[]
}

interface TerminalOutputChunk {
  seq: number
  data: string
}

const terminalSessions = new Map<string, TerminalSession>()
const TERMINAL_OUTPUT_BUFFER_MAX_BYTES = 64 * 1024

function isExecutableFile(filePath?: string): filePath is string {
  if (!filePath?.trim()) return false
  try {
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function getShellLaunchCandidates(preferredShell?: string): ResolvedShellLaunch[] {
  if (process.platform === 'win32') {
    return [{ shell: preferredShell?.trim() || process.env.COMSPEC || 'cmd.exe', args: [] }]
  }

  const shells = [
    preferredShell?.trim(),
    process.env.SHELL,
    '/bin/zsh',
    '/bin/bash',
    '/bin/sh'
  ].filter(
    (candidate, index, list): candidate is string =>
      Boolean(candidate) && list.indexOf(candidate) === index
  )

  const launches = shells
    .filter((candidate) => isExecutableFile(candidate))
    .map((shell) => ({ shell, args: shell === '/bin/sh' ? [] : ['-i'] }))

  return launches.length > 0 ? launches : [{ shell: '/bin/sh', args: [] }]
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

function createWindowEvent(windowId: number | null, channel: string, payload: unknown): void {
  const win =
    (typeof windowId === 'number'
      ? BrowserWindow.getAllWindows().find((candidate) => candidate.id === windowId)
      : null) ?? BrowserWindow.getAllWindows()[0]
  if (!win) return
  safeSendToWindow(win, channel, payload)
}

function appendTerminalOutput(session: TerminalSession, data: string): TerminalOutputChunk {
  const chunk: TerminalOutputChunk = {
    seq: session.nextSeq + 1,
    data
  }

  session.nextSeq = chunk.seq
  session.outputBuffer.push(chunk)
  session.outputBufferBytes += Buffer.byteLength(data, 'utf8')

  while (
    session.outputBuffer.length > 1 &&
    session.outputBufferBytes > TERMINAL_OUTPUT_BUFFER_MAX_BYTES
  ) {
    const removed = session.outputBuffer.shift()
    if (!removed) break
    session.outputBufferBytes -= Buffer.byteLength(removed.data, 'utf8')
  }

  return chunk
}

export function registerTerminalHandlers(): void {
  ipcMain.handle(
    'terminal:create',
    async (
      event,
      args: { cwd?: string; shell?: string; cols?: number; rows?: number; title?: string }
    ) => {
      const launches = getShellLaunchCandidates(args.shell)
      const requestedCwd = args.cwd?.trim()
      const cwd = resolveCwd(requestedCwd)
      const cols = Math.max(20, Math.floor(args.cols ?? 80))
      const rows = Math.max(5, Math.floor(args.rows ?? 24))
      const id = `term-${randomUUID()}`

      let lastError = 'Unknown error'

      const ownerWindowId = BrowserWindow.fromWebContents(event.sender)?.id ?? null

      for (const launch of launches) {
        try {
          const pty = spawn(launch.shell, launch.args, {
            name: 'xterm-256color',
            cols,
            rows,
            cwd,
            env: {
              ...process.env,
              TERM: 'xterm-256color'
            }
          })

          const session: TerminalSession = {
            id,
            pty,
            windowId: ownerWindowId,
            shell: launch.shell,
            cwd,
            cols,
            rows,
            createdAt: Date.now(),
            title: args.title?.trim() || launch.shell.split(/[\\/]/).pop() || launch.shell,
            nextSeq: 0,
            outputBuffer: [],
            outputBufferBytes: 0
          }

          terminalSessions.set(id, session)

          pty.onData((data) => {
            const chunk = appendTerminalOutput(session, data)
            createWindowEvent(session.windowId, 'terminal:output', { id, data, seq: chunk.seq })
          })

          pty.onExit(({ exitCode, signal }) => {
            terminalSessions.delete(id)
            createWindowEvent(session.windowId, 'terminal:exit', { id, exitCode, signal })
          })

          return {
            id,
            shell: launch.shell,
            cwd,
            cols,
            rows,
            createdAt: session.createdAt,
            title: session.title
          }
        } catch (error) {
          lastError = `${launch.shell}${launch.args.length > 0 ? ` ${launch.args.join(' ')}` : ''}: ${error instanceof Error ? error.message : String(error)}`
        }
      }

      const cwdHint =
        requestedCwd && requestedCwd !== cwd
          ? ` Requested cwd: ${requestedCwd}. Fallback cwd: ${cwd}.`
          : ` Cwd: ${cwd}.`
      return {
        error: `Failed to start terminal shell.${cwdHint} Tried: ${launches.map((launch) => `${launch.shell}${launch.args.length > 0 ? ` ${launch.args.join(' ')}` : ''}`).join(', ')}. Last error: ${lastError}`
      }
    }
  )

  ipcMain.handle('terminal:input', async (_event, args: { id: string; data: string }) => {
    const session = terminalSessions.get(args.id)
    if (!session) return { error: 'Terminal not found' }
    try {
      session.pty.write(args.data)
      return { success: true }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(
    'terminal:resize',
    async (_event, args: { id: string; cols: number; rows: number }) => {
      const session = terminalSessions.get(args.id)
      if (!session) return { error: 'Terminal not found' }
      try {
        const cols = Math.max(20, Math.floor(args.cols))
        const rows = Math.max(5, Math.floor(args.rows))
        session.cols = cols
        session.rows = rows
        session.pty.resize(cols, rows)
        return { success: true }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle('terminal:kill', async (_event, args: { id: string }) => {
    const session = terminalSessions.get(args.id)
    if (!session) return { error: 'Terminal not found' }
    try {
      session.pty.kill()
      terminalSessions.delete(args.id)
      return { success: true }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('terminal:list', async () => {
    return Array.from(terminalSessions.values()).map((session) => ({
      id: session.id,
      shell: session.shell,
      cwd: session.cwd,
      cols: session.cols,
      rows: session.rows,
      createdAt: session.createdAt,
      title: session.title,
      buffer: session.outputBuffer
    }))
  })
}

export function killAllTerminalSessions(): void {
  terminalSessions.forEach((session) => {
    try {
      session.pty.kill()
    } catch {
      // ignore
    }
  })
  terminalSessions.clear()
}
