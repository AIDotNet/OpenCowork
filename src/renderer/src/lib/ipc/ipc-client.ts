import type { IPCClient } from '../tools/tool-types'

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

    return ipcRenderer.invoke(channel, ...args)
  }

  send(channel: string, ...args: unknown[]): void {
    const ipcRenderer = this.ipcRenderer
    if (!ipcRenderer) return

    ipcRenderer.send(channel, ...args)
  }

  on(channel: string, callback: (...args: unknown[]) => void): () => void {
    const ipcRenderer = this.ipcRenderer
    if (!ipcRenderer) return () => {}

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
