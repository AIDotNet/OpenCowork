import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  downloadImage: (args: { url: string; defaultName?: string }) =>
    ipcRenderer.invoke('image:download', args),
  fetchImageBase64: (args: { url: string }) => ipcRenderer.invoke('image:fetch-base64', args),
  writeImageToClipboard: (args: { data: string }) =>
    ipcRenderer.invoke('clipboard:write-image', args)
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
