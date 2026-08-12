import { spawn } from 'node:child_process'

export type ClipboardTextResult =
  | { status: 'text'; text: string }
  | { status: 'empty' }
  | { status: 'unsupported-platform'; message: string }
  | { status: 'error'; message: string }

interface ProcessResult {
  stdout: string
  stderr: string
}

function runProcess(executable: string, args: string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      child.kill()
      reject(error)
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (Buffer.concat([...stdout, chunk]).length > 256 * 1024) {
        fail(new Error('Clipboard text exceeds the 256 KB limit.'))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.reduce((total, item) => total + item.length, 0) < 64 * 1024) {
        stderr.push(chunk)
      }
    })
    child.once('error', fail)
    child.once('close', (code) => {
      if (settled) return
      settled = true
      const errorText = Buffer.concat(stderr).toString('utf8').trim()
      // pbpaste / wl-paste exit 0 with empty stdout when the clipboard has no text.
      if (code !== 0 && code !== null) {
        reject(new Error(errorText || `${executable} exited with status ${code}.`))
        return
      }
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: errorText
      })
    })
  })
}

function normalizeClipboardText(raw: string): string {
  // API keys are single-line secrets; trim edges but keep interior whitespace rare as-is.
  return raw.replace(/^\uFEFF/, '').replace(/\r\n?/gu, '\n').trim()
}

async function readMacClipboardText(): Promise<ClipboardTextResult> {
  const { stdout } = await runProcess('pbpaste', [])
  const text = normalizeClipboardText(stdout)
  return text ? { status: 'text', text } : { status: 'empty' }
}

async function readWindowsClipboardText(): Promise<ClipboardTextResult> {
  const script =
    'Add-Type -AssemblyName System.Windows.Forms; ' +
    '$text = [System.Windows.Forms.Clipboard]::GetText(); ' +
    'if ([string]::IsNullOrEmpty($text)) { Write-Output \'EMPTY\'; exit 0 }; ' +
    '[Console]::Out.Write($text)'
  const { stdout } = await runProcess('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Sta',
    '-Command',
    script
  ])
  if (!stdout || stdout === 'EMPTY') return { status: 'empty' }
  const text = normalizeClipboardText(stdout)
  return text ? { status: 'text', text } : { status: 'empty' }
}

async function tryWaylandClipboardText(): Promise<ClipboardTextResult | null> {
  try {
    const { stdout } = await runProcess('wl-paste', ['--no-newline'])
    const text = normalizeClipboardText(stdout)
    return text ? { status: 'text', text } : { status: 'empty' }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || !process.env.WAYLAND_DISPLAY) return null
    throw error
  }
}

async function tryX11ClipboardText(): Promise<ClipboardTextResult | null> {
  try {
    const { stdout } = await runProcess('xclip', ['-selection', 'clipboard', '-o'])
    const text = normalizeClipboardText(stdout)
    return text ? { status: 'text', text } : { status: 'empty' }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw error
  }
}

async function readLinuxClipboardText(): Promise<ClipboardTextResult> {
  const wayland = await tryWaylandClipboardText()
  if (wayland) return wayland
  const x11 = await tryX11ClipboardText()
  if (x11) return x11
  return {
    status: 'unsupported-platform',
    message: 'Clipboard paste requires wl-paste or xclip on Linux.'
  }
}

export async function readClipboardText(): Promise<ClipboardTextResult> {
  try {
    if (process.platform === 'darwin') return await readMacClipboardText()
    if (process.platform === 'win32') return await readWindowsClipboardText()
    if (process.platform === 'linux') return await readLinuxClipboardText()
    return {
      status: 'unsupported-platform',
      message: `Clipboard paste is not supported on ${process.platform}.`
    }
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}
