import { ipcMain, BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'child_process'

interface ManagedProcess {
  id: string
  process: ChildProcess
  cwd: string
  command: string
  port?: number
  output: string[]
}

const processes = new Map<string, ManagedProcess>()
let nextId = 1

function detectPort(line: string): number | undefined {
  const m = line.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{4,5})/)
  return m ? parseInt(m[1], 10) : undefined
}

export function registerProcessManagerHandlers(): void {
  ipcMain.handle('process:spawn', async (_event, args: { command: string; cwd: string }) => {
    const id = `proc-${nextId++}`
    const isWin = process.platform === 'win32'
    const child = spawn(args.command, {
      cwd: args.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(isWin ? {} : { detached: true }),
    })

    const managed: ManagedProcess = {
      id,
      process: child,
      cwd: args.cwd,
      command: args.command,
      output: [],
    }
    processes.set(id, managed)

    const handleData = (data: Buffer): void => {
      const line = data.toString()
      managed.output.push(line)
      if (managed.output.length > 500) managed.output.shift()

      if (!managed.port) {
        const port = detectPort(line)
        if (port) managed.port = port
      }

      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isDestroyed()) {
        win.webContents.send('process:output', { id, data: line, port: managed.port })
      }
    }

    child.stdout?.on('data', handleData)
    child.stderr?.on('data', handleData)

    child.on('exit', (code) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isDestroyed()) {
        win.webContents.send('process:output', { id, data: `\n[Process exited with code ${code}]\n`, exited: true })
      }
      processes.delete(id)
    })

    return { id }
  })

  ipcMain.handle('process:kill', async (_event, args: { id: string }) => {
    const managed = processes.get(args.id)
    if (!managed) return { error: 'Process not found' }
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(managed.process.pid), '/f', '/t'], { shell: true })
      } else {
        managed.process.kill('SIGTERM')
      }
      processes.delete(args.id)
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle('process:status', async (_event, args: { id: string }) => {
    const managed = processes.get(args.id)
    if (!managed) return { running: false }
    return { running: !managed.process.killed, port: managed.port }
  })

  ipcMain.handle('process:list', async () => {
    const list: { id: string; command: string; cwd: string; port?: number }[] = []
    processes.forEach((m) => {
      list.push({ id: m.id, command: m.command, cwd: m.cwd, port: m.port })
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
