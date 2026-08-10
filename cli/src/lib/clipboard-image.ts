import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { PromptImageAttachment, SupportedImageMediaType } from '../types.js'

export const MAX_IMAGE_SIZE = 20 * 1024 * 1024
export const MAX_PROMPT_IMAGES = 10

const MAX_PROCESS_OUTPUT = Math.ceil((MAX_IMAGE_SIZE * 4) / 3) + 1024 * 1024

export type ClipboardImageResult =
  | { status: 'image'; image: PromptImageAttachment }
  | { status: 'empty' }
  | { status: 'unsupported-platform'; message: string }
  | { status: 'error'; message: string }

interface ProcessResult {
  stdout: Buffer
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
    let outputSize = 0
    let settled = false

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      child.kill()
      reject(error)
    }

    child.stdout.on('data', (chunk: Buffer) => {
      outputSize += chunk.length
      if (outputSize > MAX_PROCESS_OUTPUT) {
        fail(new Error('Clipboard image exceeds the 20 MB limit.'))
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
      if (code !== 0) {
        reject(new Error(errorText || `${executable} exited with status ${code ?? 'unknown'}.`))
        return
      }
      resolve({ stdout: Buffer.concat(stdout), stderr: errorText })
    })
  })
}

function fromBytes(
  bytes: Buffer,
  mediaType: SupportedImageMediaType,
  name = 'clipboard'
): ClipboardImageResult {
  if (bytes.length === 0) return { status: 'empty' }
  if (bytes.length > MAX_IMAGE_SIZE) {
    return { status: 'error', message: 'Clipboard image exceeds the 20 MB limit.' }
  }
  const extension: Record<SupportedImageMediaType, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp'
  }
  return {
    status: 'image',
    image: {
      id: `image-${randomUUID()}`,
      name: `${name}.${extension[mediaType]}`,
      mediaType,
      data: bytes.toString('base64'),
      size: bytes.length
    }
  }
}

async function readMacClipboard(): Promise<ClipboardImageResult> {
  const script = [
    "ObjC.import('AppKit')",
    "ObjC.import('Foundation')",
    'const pasteboard = $.NSPasteboard.generalPasteboard',
    "let data = pasteboard.dataForType('public.png')",
    'if (data.isNil()) {',
    "  const tiff = pasteboard.dataForType('public.tiff')",
    '  if (!tiff.isNil()) {',
    '    const bitmap = $.NSBitmapImageRep.imageRepWithData(tiff)',
    '    if (!bitmap.isNil()) data = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $())',
    '  }',
    '}',
    'if (!data.isNil()) $.NSFileHandle.fileHandleWithStandardOutput.writeData(data)'
  ].join('\n')
  const { stdout } = await runProcess('osascript', ['-l', 'JavaScript', '-e', script])
  return fromBytes(stdout, 'image/png')
}

async function readWindowsClipboard(): Promise<ClipboardImageResult> {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$image = [System.Windows.Forms.Clipboard]::GetImage()',
    "if ($null -eq $image) { Write-Output 'EMPTY'; exit 0 }",
    '$stream = New-Object System.IO.MemoryStream',
    '$image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)',
    '[Convert]::ToBase64String($stream.ToArray())',
    '$stream.Dispose()',
    '$image.Dispose()'
  ].join('; ')
  const { stdout } = await runProcess('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Sta',
    '-Command',
    script
  ])
  const encoded = stdout.toString('utf8').trim()
  if (!encoded || encoded === 'EMPTY') return { status: 'empty' }
  return fromBytes(Buffer.from(encoded, 'base64'), 'image/png')
}

const linuxMediaTypes: SupportedImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
]

async function tryWaylandClipboard(): Promise<ClipboardImageResult | null> {
  try {
    const { stdout } = await runProcess('wl-paste', ['--list-types'])
    const targets = new Set(stdout.toString('utf8').split(/\r?\n/u))
    const mediaType = linuxMediaTypes.find((candidate) => targets.has(candidate))
    if (!mediaType) return { status: 'empty' }
    const image = await runProcess('wl-paste', ['--no-newline', '--type', mediaType])
    return fromBytes(image.stdout, mediaType)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || !process.env.WAYLAND_DISPLAY) return null
    throw error
  }
}

async function tryX11Clipboard(): Promise<ClipboardImageResult | null> {
  try {
    const { stdout } = await runProcess('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'])
    const targets = new Set(stdout.toString('utf8').split(/\r?\n/u))
    const mediaType = linuxMediaTypes.find((candidate) => targets.has(candidate))
    if (!mediaType) return { status: 'empty' }
    const image = await runProcess('xclip', ['-selection', 'clipboard', '-t', mediaType, '-o'])
    return fromBytes(image.stdout, mediaType)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw error
  }
}

async function readLinuxClipboard(): Promise<ClipboardImageResult> {
  const wayland = await tryWaylandClipboard()
  if (wayland) return wayland
  const x11 = await tryX11Clipboard()
  if (x11) return x11
  return {
    status: 'unsupported-platform',
    message: 'Image paste requires wl-paste or xclip on Linux.'
  }
}

export async function readClipboardImage(): Promise<ClipboardImageResult> {
  try {
    if (process.platform === 'darwin') return await readMacClipboard()
    if (process.platform === 'win32') return await readWindowsClipboard()
    if (process.platform === 'linux') return await readLinuxClipboard()
    return {
      status: 'unsupported-platform',
      message: `Image paste is not supported on ${process.platform}.`
    }
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}
