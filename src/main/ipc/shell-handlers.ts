import { ipcMain, shell } from 'electron'
import { exec } from 'child_process'

export function registerShellHandlers(): void {
  ipcMain.handle(
    'shell:exec',
    async (_event, args: { command: string; timeout?: number; cwd?: string }) => {
      const timeout = Math.min(args.timeout ?? 120000, 600000)

      return new Promise((resolve) => {
        const child = exec(
          args.command,
          {
            cwd: args.cwd || process.cwd(),
            timeout,
            maxBuffer: 1024 * 1024 * 10, // 10MB
            encoding: 'utf8',
            env: {
              ...process.env,
              // Force Python to use UTF-8 for stdin/stdout/stderr
              PYTHONIOENCODING: 'utf-8',
              PYTHONUTF8: '1',
            },
          },
          (error, stdout, stderr) => {
            resolve({
              exitCode: error ? error.code ?? 1 : 0,
              stdout: stdout.slice(0, 50000), // Limit output size
              stderr: stderr.slice(0, 10000),
              error: error ? error.message : undefined,
            })
          }
        )

        // Safety: kill on timeout
        setTimeout(() => {
          if (child.exitCode === null) {
            child.kill('SIGTERM')
          }
        }, timeout + 1000)
      })
    }
  )

  ipcMain.handle('shell:openPath', async (_event, folderPath: string) => {
    return shell.openPath(folderPath)
  })

  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      return shell.openExternal(url)
    }
  })
}
