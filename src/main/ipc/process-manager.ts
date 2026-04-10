import { ipcMain, BrowserWindow } from 'electron'
import { safeSendToWindow } from '../window-ipc'
import { spawn, type ChildProcess } from 'child_process'

const PROCESS_OUTPUT_ENCODING = 'utf-8'

function createOutputDecoder(): TextDecoder {
  return new TextDecoder(PROCESS_OUTPUT_ENCODING)
}

function decodeOutputChunk(decoder: TextDecoder, data: Buffer): string {
  return decoder.decode(data, { stream: true })
}

interface ProcessMetadata {
  source?: string
  sessionId?: string
  toolUseId?: string
  description?: string
}

interface ManagedProcess {
  id: string
  process: ChildProcess
  cwd: string
  command: string
  createdAt: number
  metadata?: ProcessMetadata
  port?: number
  exitCode?: number | null
  stopping?: boolean
  output: string[]
}

const processes = new Map<string, ManagedProcess>()
let nextId = 1

function detectPort(line: string): number | undefined {
  const m = line.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{4,5})/)
  return m ? parseInt(m[1], 10) : undefined
}

export function registerProcessManagerHandlers(): void {
  ipcMain.handle(
    'process:spawn',
    async (_event, args: { command: string; cwd?: string; metadata?: ProcessMetadata }) => {
      const id = `proc-${nextId++}`
      const child = spawn(args.command, {
        cwd: args.cwd || process.cwd(),
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(process.platform === 'win32' ? {} : { detached: true })
      })

      const stdoutDecoder = createOutputDecoder()
      const stderrDecoder = createOutputDecoder()

      const managed: ManagedProcess = {
        id,
        process: child,
        cwd: args.cwd || process.cwd(),
        command: args.command,
        createdAt: Date.now(),
        metadata: args.metadata,
        output: []
      }
      processes.set(id, managed)

      const handleData = (stream: 'stdout' | 'stderr', data: Buffer): void => {
        const decoder = stream === 'stdout' ? stdoutDecoder : stderrDecoder
        const chunk = decodeOutputChunk(decoder, data)
        managed.output.push(chunk)
        if (managed.output.length > 500) managed.output.shift()

        if (!managed.port) {
          const port = detectPort(chunk)
          if (port) managed.port = port
        }

        const win = BrowserWindow.getAllWindows()[0]
        if (win) {
          safeSendToWindow(win, 'process:output', {
            id,
            data: chunk,
            port: managed.port,
            metadata: managed.metadata
          })
        }
      }

      child.stdout?.on('data', (data: Buffer) => handleData('stdout', data))
      child.stderr?.on('data', (data: Buffer) => handleData('stderr', data))

      child.on('exit', (code) => {
        managed.exitCode = code
        managed.output.push(stdoutDecoder.decode(), stderrDecoder.decode())
        const win = BrowserWindow.getAllWindows()[0]
        if (win) {
          safeSendToWindow(win, 'process:output', {
            id,
            data: managed.stopping
              ? '\n[Process stopped by user]\n'
              : `\n[Process exited with code ${code}]\n`,
            exited: true,
            exitCode: code,
            metadata: managed.metadata
          })
        }
        processes.delete(id)
      })

      child.on('error', (err) => {
        managed.output.push(stdoutDecoder.decode(), stderrDecoder.decode())
        const win = BrowserWindow.getAllWindows()[0]
        if (win) {
          safeSendToWindow(win, 'process:output', {
            id,
            data: `\n[Process error: ${err.message}]\n`,
            exited: true,
            exitCode: 1,
            metadata: managed.metadata
          })
        }
        processes.delete(id)
      })

      return { id }
    }
  )

  ipcMain.handle('process:kill', async (_event, args: { id: string }) => {
    const managed = processes.get(args.id)
    if (!managed) return { error: 'Process not found' }
    try {
      if (process.platform === 'win32') {
        const pid = managed.process.pid
        if (!pid) return { error: 'Process pid not available' }
        managed.stopping = true
        const taskKillResult = await new Promise<{ ok: boolean; err?: string }>((resolve) => {
          const killer = spawn('taskkill', ['/pid', String(pid), '/f', '/t'], {
            shell: true,
            windowsHide: true
          })
          let stderr = ''
          const stderrDecoder = createOutputDecoder()
          killer.stderr?.on('data', (data: Buffer) => {
            stderr += decodeOutputChunk(stderrDecoder, data)
          })
          killer.on('error', (err) => resolve({ ok: false, err: err.message }))
          killer.on('close', (code) => {
            stderr += stderrDecoder.decode()
            if (code === 0) resolve({ ok: true })
            else resolve({ ok: false, err: stderr.trim() || `taskkill exited with code ${code}` })
          })
        })
        if (!taskKillResult.ok) {
          managed.stopping = false
          return { error: taskKillResult.err ?? 'Failed to stop process' }
        }
      } else {
        managed.stopping = true
        managed.process.kill('SIGTERM')
      }
      return { success: true }
    } catch (err) {
      managed.stopping = false
      return { error: String(err) }
    }
  })

  ipcMain.handle(
    'process:write',
    async (_event, args: { id: string; input: string; appendNewline?: boolean }) => {
      const managed = processes.get(args.id)
      if (!managed) return { error: 'Process not found' }
      if (managed.process.exitCode !== null) return { error: 'Process already exited' }
      if (!managed.process.stdin || managed.process.stdin.destroyed) {
        return { error: 'Process stdin not available' }
      }
      try {
        const payload = args.appendNewline === false ? args.input : `${args.input}\n`
        managed.process.stdin.write(payload)
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle('process:status', async (_event, args: { id: string }) => {
    const managed = processes.get(args.id)
    if (!managed) return { running: false }
    return {
      running: managed.process.exitCode === null,
      port: managed.port,
      metadata: managed.metadata,
      createdAt: managed.createdAt,
      exitCode: managed.exitCode
    }
  })

  ipcMain.handle('process:list', async () => {
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
        metadata: m.metadata,
        running: m.process.exitCode === null,
        exitCode: m.exitCode
      })
    })
    return list
  })
}

export function killAllManagedProcesses(): void {
  processes.forEach((managed) => {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(managed.process.pid), '/f', '/t'], { shell: true })
      } else {
        managed.process.kill('SIGTERM')
      }
    } catch {
      // ignore
    }
  })
  processes.clear()
}
