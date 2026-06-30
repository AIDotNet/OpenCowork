import {
  decodeMessagePackPayload,
  encodeMessagePackPayload
} from '../../../../shared/messagepack/binary-ipc'

export async function invokeMessagePack<T = unknown>(
  channel: string,
  payload: unknown
): Promise<T> {
  const response = await window.electron.ipcRenderer.invoke(
    channel,
    encodeMessagePackPayload(payload)
  )
  return response as T
}

export async function invokeMessagePackBinary<T = unknown>(
  channel: string,
  payload: unknown
): Promise<T> {
  const response = await window.electron.ipcRenderer.invoke(
    channel,
    encodeMessagePackPayload(payload)
  )
  return decodeMessagePackPayload<T>(response as ArrayBuffer | ArrayBufferView)
}

export function decodeIpcMessagePack<T = unknown>(bytes: ArrayBuffer | ArrayBufferView): T {
  return decodeMessagePackPayload<T>(bytes)
}
