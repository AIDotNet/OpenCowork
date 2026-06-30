import { BrowserWindow } from 'electron'
import { encodeMessagePackPayload, toMessagePackChannel } from '../shared/messagepack/binary-ipc'

function isDisposedFrameError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /render frame was disposed before webframemain could be accessed/i.test(error.message)
  )
}

export function safePostMessageToWindow(
  win: BrowserWindow,
  channel: string,
  bytes: Uint8Array | Buffer
): boolean {
  if (win.isDestroyed()) {
    return false
  }

  const contents = win.webContents
  if (!contents || contents.isDestroyed() || contents.isCrashed()) {
    return false
  }

  try {
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    contents.postMessage(channel, arrayBuffer)
    return true
  } catch (error) {
    if (!isDisposedFrameError(error)) {
      console.warn(`[Window IPC] Failed to post ${channel}:`, error)
    }
  }

  try {
    contents.send(channel, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    return true
  } catch (error) {
    if (!isDisposedFrameError(error)) {
      console.warn(`[Window IPC] Failed to send binary fallback ${channel}:`, error)
    }
    return false
  }
}

export function safeSendMessagePackToWindow(
  win: BrowserWindow,
  channel: string,
  payload: unknown
): boolean {
  return safePostMessageToWindow(
    win,
    toMessagePackChannel(channel),
    encodeMessagePackPayload(payload)
  )
}

export function safeSendMessagePackToAllWindows(channel: string, payload: unknown): void {
  const bytes = encodeMessagePackPayload(payload)
  const binaryChannel = toMessagePackChannel(channel)
  for (const win of BrowserWindow.getAllWindows()) {
    safePostMessageToWindow(win, binaryChannel, bytes)
  }
}
