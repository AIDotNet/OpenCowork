import { BrowserWindow, ipcMain } from 'electron'
import {
  downloadCodeGraphGrammars,
  getCodeGraphAssetStatus,
  removeCodeGraphGrammars,
  type CodeGraphDownloadProgress
} from '../lib/codegraph-assets'
import { getNativeWorker } from '../lib/native-worker'

// Channel names mirror IPC.CODEGRAPH_* in src/renderer/src/lib/ipc/channels.ts.
const ASSET_STATUS = 'codegraph:asset-status'
const DOWNLOAD_ASSETS = 'codegraph:download-assets'
const REMOVE_ASSETS = 'codegraph:remove-assets'
const DOWNLOAD_PROGRESS = 'codegraph:download-progress'
// Live index/sync progress streamed from the CodeGraph worker (fan-out to all
// windows). The worker already emits codegraph/index-progress + index-complete
// with a stable indexId; we just relay them so the settings panel / graph page
// can render a real progress bar instead of an opaque busy state.
const INDEX_PROGRESS = 'codegraph:index-progress'

let downloadInFlight = false
let indexProgressForwardingRegistered = false

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(channel, payload)
  }
}

// Subscribe once to the worker's index progress/complete events and relay them to
// the renderer. onEvent registers on the manager's persistent emitter (survives
// worker respawns) and does not force a spawn, so this is safe at startup.
function registerIndexProgressForwarding(): void {
  if (indexProgressForwardingRegistered) return
  indexProgressForwardingRegistered = true
  const worker = getNativeWorker()
  worker.onEvent('codegraph/index-progress', (params) => {
    broadcast(INDEX_PROGRESS, params)
  })
  worker.onEvent('codegraph/index-complete', (params) => {
    broadcast(INDEX_PROGRESS, { ...(params as Record<string, unknown>), done: true })
  })
}

export function registerCodeGraphHandlers(): void {
  registerIndexProgressForwarding()
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
