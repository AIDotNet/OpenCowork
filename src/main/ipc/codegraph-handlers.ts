import { ipcMain } from 'electron'
import {
  downloadCodeGraphGrammars,
  getCodeGraphAssetStatus,
  removeCodeGraphGrammars,
  type CodeGraphDownloadProgress
} from '../lib/codegraph-assets'

// Channel names mirror IPC.CODEGRAPH_* in src/renderer/src/lib/ipc/channels.ts.
const ASSET_STATUS = 'codegraph:asset-status'
const DOWNLOAD_ASSETS = 'codegraph:download-assets'
const REMOVE_ASSETS = 'codegraph:remove-assets'
const DOWNLOAD_PROGRESS = 'codegraph:download-progress'

let downloadInFlight = false

export function registerCodeGraphHandlers(): void {
  ipcMain.handle(ASSET_STATUS, () => getCodeGraphAssetStatus())

  ipcMain.handle(REMOVE_ASSETS, async () => removeCodeGraphGrammars())

  ipcMain.handle(DOWNLOAD_ASSETS, async (event) => {
    if (downloadInFlight) {
      return { success: false, error: 'a download is already in progress' }
    }
    downloadInFlight = true
    try {
      const emit = (p: CodeGraphDownloadProgress): void => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(DOWNLOAD_PROGRESS, p)
        }
      }
      return await downloadCodeGraphGrammars(emit)
    } finally {
      downloadInFlight = false
    }
  })
}
