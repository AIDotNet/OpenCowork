import { BrowserWindow, type WebContents } from 'electron'
import { safeSendMessagePackToWindow } from '../window-ipc'
import { registerMessagePackHandler } from './messagepack-handler'
import {
  createTerminalSession,
  getTerminalSessionSnapshot,
  killTerminalSession,
  onTerminalSessionExit,
  onTerminalSessionOutput,
  writeTerminalSession
} from './terminal-handlers'

interface ProcessMetadata {
  source?: string
  sessionId?: string
  toolUseId?: string
  description?: string
  terminalId?: string
}

interface ManagedProcess {
  id: string
  terminalId: string
  windowId: number | null
  cwd: string
  command: string
  shell?: string
  createdAt: number
  metadata?: ProcessMetadata
  port?: number
  exitCode?: number | null
  stopping?: boolean
  exited?: boolean
  output: string[]
  cleanup?: () => void
}

const processes = new Map<string, ManagedProcess>()
let nextId = 1

function detectPort(line: string): number | undefined {
  const m = line.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{4,5})/)
  return m ? parseInt(m[1], 10) : undefined
}

function resolveOwnerWindowId(sender?: WebContents | null): number | null {
  return sender ? (BrowserWindow.fromWebContents(sender)?.id ?? null) : null
}

function getManagedWindow(managed: ManagedProcess): BrowserWindow | null {
  return (
    (typeof managed.windowId === 'number'
      ? BrowserWindow.getAllWindows().find((candidate) => candidate.id === managed.windowId)
      : null) ??
    BrowserWindow.getAllWindows()[0] ??
    null
  )
}

function getManagedMetadata(managed: ManagedProcess): ProcessMetadata {
  return {
    ...(managed.metadata ?? {}),
    terminalId: managed.terminalId
  }
}

function sendProcessOutput(
  managed: ManagedProcess,
  payload: {
    data?: string
    exited?: boolean
    exitCode?: number | null
  }
): void {
  const win = getManagedWindow(managed)
  if (!win) return
  const eventPayload = {
    id: managed.id,
    data: payload.data,
    port: managed.port,
    exited: payload.exited,
    exitCode: payload.exitCode,
    metadata: getManagedMetadata(managed)
  }
  safeSendMessagePackToWindow(win, 'process:output', eventPayload)
}

function appendManagedOutput(managed: ManagedProcess, chunk: string): void {
  if (!chunk) return
  managed.output.push(chunk)
  if (managed.output.length > 500) managed.output.shift()

  if (!managed.port) {
    const port = detectPort(chunk)
    if (port) managed.port = port
  }
}

function finalizeManagedProcess(
  managed: ManagedProcess,
  exitCode: number | null,
  message?: string
): void {
  if (managed.exited) return
  managed.exited = true
  managed.exitCode = exitCode
  managed.cleanup?.()
  managed.cleanup = undefined

  if (message) appendManagedOutput(managed, message)
  sendProcessOutput(managed, {
    data: message,
    exited: true,
    exitCode
  })
  processes.delete(managed.id)
}

export function registerProcessManagerHandlers(): void {
  registerMessagePackHandler<{
    command: string
    cwd?: string
    shell?: string
    metadata?: ProcessMetadata
  }>('process:spawn', async (args, event) => {
    const id = `proc-${nextId++}`
    const configuredShell = args.shell?.trim() || undefined
    const cwd = args.cwd || process.cwd()
    const created = await createTerminalSession(
      {
        cwd,
        command: args.command,
        shell: configuredShell,
        title: args.metadata?.description?.trim() || 'Background Shell'
      },
      event.sender
    )

    if (!created.id) {
      return { error: created.error ?? 'Failed to create terminal session' }
    }

    const managed: ManagedProcess = {
      id,
      terminalId: created.id,
      windowId: resolveOwnerWindowId(event.sender),
      cwd: created.cwd ?? cwd,
      command: args.command,
      shell: configuredShell,
      createdAt: Date.now(),
      metadata: {
        ...(args.metadata ?? {}),
        terminalId: created.id
      },
      output: []
    }
    processes.set(id, managed)

    const cleanupOutput = onTerminalSessionOutput((payload) => {
      if (payload.id !== managed.terminalId || !payload.data) return
      appendManagedOutput(managed, payload.data)
      sendProcessOutput(managed, { data: payload.data })
    })

    const cleanupExit = onTerminalSessionExit((payload) => {
      if (payload.id !== managed.terminalId) return
      finalizeManagedProcess(
        managed,
        payload.exitCode,
        managed.stopping
          ? '\n[Process stopped by user]\n'
          : `\n[Process exited with code ${payload.exitCode}]\n`
      )
    })

    managed.cleanup = () => {
      cleanupOutput()
      cleanupExit()
    }

    const snapshot = await getTerminalSessionSnapshot(managed.terminalId)
    const replay = snapshot?.buffer?.map((chunk) => chunk.data).join('') ?? ''
    if (replay) {
      appendManagedOutput(managed, replay)
      sendProcessOutput(managed, { data: replay })
    }
    if (snapshot?.exitCode !== undefined) {
      finalizeManagedProcess(
        managed,
        snapshot.exitCode,
        `\n[Process exited with code ${snapshot.exitCode}]\n`
      )
    }

    return { id, terminalId: managed.terminalId }
  })

  registerMessagePackHandler<{ id: string }>('process:kill', async (args) => {
    const managed = processes.get(args.id)
    if (!managed) return { error: 'Process not found' }
    try {
      managed.stopping = true
      const result = await killTerminalSession(managed.terminalId)
      if (result.error) {
        managed.stopping = false
        return { error: result.error }
      }
      return { success: true }
    } catch (err) {
      managed.stopping = false
      return { error: String(err) }
    }
  })

  registerMessagePackHandler<{ id: string; input: string; appendNewline?: boolean }>(
    'process:write',
    async (args) => {
      const managed = processes.get(args.id)
      if (!managed) return { error: 'Process not found' }
      if (managed.exited || managed.exitCode !== undefined) {
        return { error: 'Process already exited' }
      }
      const session = await getTerminalSessionSnapshot(managed.terminalId)
      if (!session || session.exitCode !== undefined) return { error: 'Process already exited' }
      try {
        const payload = args.appendNewline === false ? args.input : `${args.input}\r`
        return await writeTerminalSession(managed.terminalId, payload)
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  registerMessagePackHandler<{ id: string }>('process:status', async (args) => {
    const managed = processes.get(args.id)
    if (!managed) return { running: false }
    return {
      running: !managed.exited,
      port: managed.port,
      metadata: getManagedMetadata(managed),
      createdAt: managed.createdAt,
      exitCode: managed.exitCode
    }
  })

  registerMessagePackHandler<undefined>('process:list', async () => {
    const list: {
      id: string
      command: string
      cwd: string
      port?: number
      createdAt: number
      metadata?: ProcessMetadata
      running: boolean
      exitCode?: number | null
    }[] = []
    processes.forEach((m) => {
      list.push({
        id: m.id,
        command: m.command,
        cwd: m.cwd,
        port: m.port,
        createdAt: m.createdAt,
        metadata: getManagedMetadata(m),
        running: !m.exited,
        exitCode: m.exitCode
      })
    })
    return list
  })
}

export function killAllManagedProcesses(): void {
  processes.forEach((managed) => {
    try {
      void killTerminalSession(managed.terminalId)
      managed.cleanup?.()
    } catch {
      // ignore
    }
  })
  processes.clear()
}
