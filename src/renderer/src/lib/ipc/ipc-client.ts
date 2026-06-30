import type { IPCClient } from '../tools/tool-types'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../../../shared/messagepack/binary-ipc'
import { invokeMessagePackBinary } from './messagepack-ipc-client'
import {
  shouldUseMessagePackEvent,
  shouldUseMessagePackInvoke,
  shouldUseMessagePackSend
} from './messagepack-channel-routing'

/**
 * IPC Client wrapper for renderer process.
 * Wraps Electron's ipcRenderer with typed interface.
 */
class ElectronIPCClient implements IPCClient {
  private get ipcRenderer(): typeof window.electron.ipcRenderer | null {
    return window.electron?.ipcRenderer ?? null
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const ipcRenderer = this.ipcRenderer
    if (!ipcRenderer) {
      throw new Error(`IPC channel "${channel}" is unavailable: Electron preload bridge is missing`)
    }

    if (shouldUseMessagePackInvoke(channel, args.length)) {
      return invokeMessagePackBinary(toMessagePackChannel(channel), args[0])
    }

    return ipcRenderer.invoke(channel, ...args)
  }

  send(channel: string, ...args: unknown[]): void {
    const ipcRenderer = this.ipcRenderer
    if (!ipcRenderer) return

    if (shouldUseMessagePackSend(channel)) {
      const payload = args.length <= 1 ? args[0] : args
      ipcRenderer.send(toMessagePackChannel(channel), encodeMessagePackPayload(payload))
      return
    }

    ipcRenderer.send(channel, ...args)
  }

  on(channel: string, callback: (...args: unknown[]) => void): () => void {
    const ipcRenderer = this.ipcRenderer
    if (!ipcRenderer) return () => {}

    if (shouldUseMessagePackEvent(channel)) {
      const handler = (_event: unknown, bytes: ArrayBuffer | ArrayBufferView): void => {
        callback(decodeMessagePackPayload(bytes))
      }
      const binaryChannel = toMessagePackChannel(channel)
      ipcRenderer.on(binaryChannel, handler)
      return () => {
        ipcRenderer.removeListener(binaryChannel, handler)
      }
    }

    const handler = (_event: unknown, ...args: unknown[]): void => {
      callback(...args)
    }
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  }
}

export const ipcClient: IPCClient = new ElectronIPCClient()
