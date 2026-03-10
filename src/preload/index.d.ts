import { ElectronAPI } from '@electron-toolkit/preload'

interface OpenCoworkAPI {
  downloadImage: (args: {
    url: string
    defaultName?: string
  }) => Promise<{ success?: boolean; canceled?: boolean; filePath?: string; error?: string }>
  fetchImageBase64: (args: {
    url: string
  }) => Promise<{ data?: string; mimeType?: string; error?: string }>
  writeImageToClipboard: (args: { data: string }) => Promise<{ success?: boolean; error?: string }>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: OpenCoworkAPI
  }
}
