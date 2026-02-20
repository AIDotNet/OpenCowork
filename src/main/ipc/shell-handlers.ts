import { ipcMain, shell, BrowserWindow } from 'electron'
import { spawn } from 'child_process'

function sanitizeOutput(raw: string, maxLen: number): string {
  const trimmed = raw.slice(0, maxLen)
  // Detect binary / non-text output by sampling the first 256 chars
  const sample = trimmed.slice(0, 256)
  let bad = 0
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i)
    // non-printable control chars (except tab, LF, CR) or replacement char U+FFFD
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0xfffd) bad++
  }
  if (sample.length > 0 && bad / sample.length > 0.1) {
    return `[Binary or non-text output, ${raw.length} bytes — content omitted]`
  }
  return trimmed
}

async function terminateChildProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return

  if (process.platform === 'win32') {
    const pid = child.pid
    if (pid) {
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(pid), '/f', '/t'], {
          shell: true,
          windowsHide: true,
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
      const cmd =
        process.platform === 'win32'
          ? `chcp 65001 >nul & ${args.command}`
          : args.command

      return new Promise((resolve) => {
        let stdout = ''
        let stderr = ''
        let killed = false
        let settled = false
        let forceResolveTimer: ReturnType<typeof setTimeout> | null = null

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
            PYTHONUNBUFFERED: '1',
          },
        })

        const finalize = (payload: { exitCode: number; stdout: string; stderr: string; error?: string }): void => {
          if (settled) return
          settled = true
          if (execId) runningShellProcesses.delete(execId)
          if (forceResolveTimer) {
            clearTimeout(forceResolveTimer)
            forceResolveTimer = null
          }
          child.stdout?.removeAllListeners('data')
          child.stderr?.removeAllListeners('data')
          child.removeAllListeners('error')
          child.removeAllListeners('close')
          resolve(payload)
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
              stdout: sanitizeOutput(stdout, 50000),
              stderr: sanitizeOutput(`${stderr}\n[Process termination timed out]`, 10000),
            })
          }, 2000)
        }

        if (execId) {
          runningShellProcesses.set(execId, { child, abort: requestAbort })
        }

        const sendChunk = (chunk: string): void => {
          if (!execId) return
          const win = BrowserWindow.getAllWindows()[0]
          if (win && !win.isDestroyed()) {
            win.webContents.send('shell:output', { execId, chunk })
          }
        }

        child.stdout?.on('data', (data: Buffer) => {
          const text = data.toString('utf8')
          stdout += text
          sendChunk(text)
        })

        child.stderr?.on('data', (data: Buffer) => {
          const text = data.toString('utf8')
          stderr += text
          sendChunk(text)
        })

        child.on('close', (code) => {
          finalize({
            exitCode: killed ? 1 : (code ?? 0),
            stdout: sanitizeOutput(stdout, 50000),
            stderr: sanitizeOutput(stderr, 10000),
          })
        })

        child.on('error', (err) => {
          finalize({
            exitCode: 1,
            stdout: sanitizeOutput(stdout, 50000),
            stderr: sanitizeOutput(stderr, 10000),
            error: err.message,
          })
        })

        // Safety: kill on timeout
        setTimeout(() => {
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
